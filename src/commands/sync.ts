// src/commands/sync.ts —— D-T12：sync 命令骨架；D-T13：run 子命令挂载；
// D-T14：status / verify / install / uninstall 四子命令。
// 骨架沿 store.ts：parseStoreFlags → usageFail/fail 双通道 → thrownToExit 扩展。
// --pretty（G1 已实现）：输出缩进开关，写在子命令之后。留在这里的只是历史裁决说明——
// 当年「承诺过、未实现」时的统一拒绝已退役；现在的规则与 api 族一致：未知/位置参数 →
// help → --pretty，各层同答。
//
// T14 语义（spec §7.6 / 简化裁定）：
//   · status / verify 以 ro 打开库（spec §6.3：单写者模型下读者走 C1 退避）；
//   · verify 对 snapshot 任务做三方核对（本地表行数 / 上游任务 fetch 的 apiCount /
//     sync_state 状态），对 windowed 任务不做上游全量重拉（成本高），只核对
//     local_rows 与 sync_state 成功状态的一致性——expected_from_api 为 null，
//     drift 非空时 detail 说明核对方式；
//   · install/uninstall 的平台条目生成与命令执行在 src/schedule/install.ts，
//     平台检测与外部命令均为注入点（__setPlatform/__setRun）；
//   · install 前置探测（E 高-1）：**必须存在真实成功证据** —— sync_state 有
//     `range_status='complete'` 或 `last_synced_at` 非空的行。引擎在窗口执行前就
//     markPending 落行，所以「有行」不等于「跑通过」：全败的 run 同样留下 pending 行，
//     按「有行」放行会把调度器装在一个从未成功同步的库上（探测名不副实）。
//   · store_not_initialized 的 hint 按**成因**分流（spec §九 + 架构审查 F1）：`sync run`
//     首跑虽会自动建库，但「初始化存储」的最小命令是 store init —— 只对「不存在 / 空库」
//     成立；「路径不是 DuckDB 文件」「他人库（有表无 schema_version）」「依赖未安装」跑
//     store init 会再次失败，必须指换 --db 路径 / 装依赖，否则 Agent 进
//     store init → sync 死循环（同步侧的 storeInitFail 保留底层 hint 是同一裁定）。
// 输出键一律下划线命名（spec §七：range_status / gaps_count / local_rows /
// expected_from_api / state_windows_consistent）——本仓 Agent 契约的统一形态。
import { homedir } from 'node:os'
import { statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { SYNC_TASKS, taskById, UNSUPPORTED_DATASETS } from '../sync/registry.js'
import { listGaps, listWatermarks } from '../sync/state.js'
import type { SyncTask } from '../sync/types.js'
import { resolveStoreConfig, currentStoreEnv } from '../store/config.js'
import { openStore } from '../store/index.js'
import { tableByName } from '../store/schema.js'
import { resolveCredentialsUsingFile, currentCredentialEnv } from './credentials-source.js'
import { ok, fail, usageFail, failFromTagged, setPretty } from '../output.js'
import { runSyncRun, SYNC_RUN_USAGE, msToShanghaiIso, RUN_FLAGS } from './sync-run.js'
import { thrownToExit } from './store.js'
import {
  currentPlatform, runScheduleCommand, planInstall, planUninstall,
} from '../schedule/install.js'
import type { Platform } from '../schedule/install.js'
import type { Store } from '../store/types.js'
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES, prettyAfterSubcommand, REJECTED_FLAGS, STORE_FLAGS, valueFlagNames } from './spec-types.js'
import type { CommandSpec, FlagSpec } from './spec-types.js'
import { STORE_VALUE_FLAG_NAMES } from './store-flags.js'

/** `sync install` 的业务 flag。 */
const INSTALL_FLAGS: FlagSpec[] = [
  { name: '--schedule', kind: 'value' },
  { name: '--yes', kind: 'bool' },
  ...STORE_FLAGS,
]
/** `sync uninstall` 的业务 flag：**只有** `--yes`（见下方 spec 的说明）。 */
const UNINSTALL_FLAGS: FlagSpec[] = [{ name: '--yes', kind: 'bool' }]

/** `sync tasks` 的 flag：没有业务 flag，`flags` 就是全局那一份。 */
const TASKS_FLAGS: FlagSpec[] = [...GLOBAL_FLAGS]

/**
 * 命令契约（F 组 D4）：`skill check` 据此判断 skill 正文里的 `qiyu sync …` 是否真的存在。
 * `flags` 是**完整接受集**（含全局 flag），`--pretty` 同时在 `rejected` 里。
 *
 * ⚠️ `sync run` 的 spec 在这里而不在 `sync-run.ts`：spec 描述的是**命令路径**，而路径的
 * 分派在 `syncCommand`；`runSyncRun` 只拿到剥掉 `run` 之后的参数。解析器的 flag 常量由
 * `sync-run.ts` 导出（`RUN_FLAGS`）、这里引用，所以 spec 与解析器仍同源。
 *
 * ⚠️ **`sync uninstall` 不列 `STORE_FLAGS`（与 brief 表格的一处刻意偏离）。**
 * brief 写「照实写上，因为 CLI 接受它们」，但实测并非如此：`syncUninstall` 的解析是
 * `parseSubFlags(argv, [], ['--yes'])`，`--db` 会落进「未知参数：--db」退出码 2
 * （`node dist/cli.js sync uninstall --db /tmp/x` 实测）。`sync.ts` 里的存储定位数组
 * 只被 `storeArgsFor` 用于 **install** 的调度命令透传，uninstall 的 `planUninstall`
 * 不接存储参数。把不接受的 flag 写进接受集，正是 `skill check` 要防的假阴性
 * （skill 里写 `qiyu sync uninstall --db …` 会被判合法、实际必失败）——
 * 所以这里以解析器为准。若将来让 uninstall 也透传存储定位，把 `...STORE_FLAGS` 加回来即可。
 */
export const SYNC_SPECS: CommandSpec[] = [
  { path: ['sync', 'tasks'], flags: TASKS_FLAGS, positionals: [], rejected: REJECTED_FLAGS },
  {
    path: ['sync', 'run'],
    flags: [...GLOBAL_FLAGS, ...RUN_FLAGS],
    positionals: [{ name: '任务', domain: 'task-ids', repeatable: true }],
    rejected: REJECTED_FLAGS,
  },
  {
    path: ['sync', 'status'],
    flags: [...GLOBAL_FLAGS, ...STORE_FLAGS],
    positionals: [{ name: '任务', domain: 'task-ids', repeatable: true }],
    rejected: REJECTED_FLAGS,
  },
  {
    path: ['sync', 'verify'],
    flags: [...GLOBAL_FLAGS, ...STORE_FLAGS],
    positionals: [{ name: '任务', domain: 'task-ids', repeatable: true }],
    rejected: REJECTED_FLAGS,
  },
  {
    path: ['sync', 'install'],
    flags: [...GLOBAL_FLAGS, ...INSTALL_FLAGS],
    positionals: [],
    rejected: REJECTED_FLAGS,
  },
  {
    path: ['sync', 'uninstall'],
    flags: [...GLOBAL_FLAGS, ...UNINSTALL_FLAGS],
    positionals: [],
    rejected: REJECTED_FLAGS,
  },
]

/**
 * 解析器用的 flag 名，全部从上面的常量派生，不另写一份。
 * ⚠️ `sync run` 的解析器在 `sync-run.ts`（它自己从 `RUN_FLAGS` 派生 `RUN_VALUE_FLAGS` /
 * `RUN_BOOL_FLAGS`），这里的 `SYNC_SPECS` 只引用同一个 `RUN_FLAGS` —— 两侧同源。
 */
const STORE_VALUE_FLAGS: string[] = [...STORE_VALUE_FLAG_NAMES]
const INSTALL_VALUE_FLAGS = valueFlagNames(INSTALL_FLAGS)
const INSTALL_BOOL_FLAGS = INSTALL_FLAGS.filter((f) => f.kind === 'bool').map((f) => f.name)
const TASKS_VALUE_FLAGS = valueFlagNames(TASKS_FLAGS)
const UNINSTALL_BOOL_FLAGS = UNINSTALL_FLAGS.map((f) => f.name)

const USAGE = `用法：qiyu sync <子命令> [参数]

子命令：
  sync tasks               列出全部同步任务与不支持的实时快照数据集
                           （每条含 sensitive_columns：该表标注 sensitive 的 PII 列清单）
  sync run [任务...]        同步数据进本地库（--full / --since / --until / --quiet）
  sync status [任务...]     水位、区间状态（resolved_range）、缺口（gaps）、锁（只读；缺省全部任务）
  sync verify [任务...]     核对本地与远端一致性（快照三方核对；drift 非空退出码 1）
                           快照任务给 expected_from_api（上游行数）；windowed 任务不做上游
                           全量重拉、该字段恒为 null，只以本地行数与 sync_state 成功状态核对
  sync install --schedule CRON [--yes]
                           生成并安装系统调度条目（默认 dry-run，--yes 才写入）
  sync uninstall [--yes]   移除系统调度条目（默认 dry-run，--yes 才删除）

CRON 为 5 段（分 时 日 月 周），支持 * / 数字 / a-b / a-b/k / */k / 逗号列表。
存储定位：--db / --profile / --backend（store 命令同族）。
install 的平台形态：darwin=launchd plist、linux=systemd unit+timer（crontab 兜底）、
win32=schtasks。安装前置：库已初始化且至少成功同步过一次（sync_state 有
range_status=complete 或 last_synced_at 非空的行；全败的 run 只留 pending，不算跑通）。
`

const KNOWN = new Set(GLOBAL_FLAG_NAMES)

// —— 通用 flag 解析（store.ts 同族：值位守卫，--开头算缺值）——

interface ParsedFlags {
  values: Record<string, string>
  flags: Set<string>
  rest: string[]
}

function parseSubFlags(argv: string[], valueFlags: string[], boolFlags: string[] = []): ParsedFlags {
  const out: ParsedFlags = { values: {}, flags: new Set(), rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (valueFlags.includes(a)) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 缺少取值`)
      out.values[a] = v
      i++
    } else if (a === '--pretty') {
      // G1：已实现的输出开关 —— 收下（不带值）；开启动作在命令层（原拒绝点 setPretty(true)）。
      // 值位守卫仍优先：`--since --pretty` 报「--since 缺少取值」。
      out.flags.add('--pretty')
    } else if (a === '--help' || a === '-h') {
      out.flags.add('--help')
    } else if (boolFlags.includes(a)) {
      out.flags.add(a)
    } else if (a.startsWith('-')) {
      throw new Error(`未知参数：${a}`)
    } else {
      out.rest.push(a)
    }
  }
  return out
}

/** 子命令的 --help 分流：--help 在则打 USAGE；带非 KNOWN 额外参数 → usage。 */
function subHelp(argv: string[]): number | null {
  if (!argv.includes('--help') && !argv.includes('-h')) return null
  const extra = argv.filter((a) => !KNOWN.has(a))
  if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
  process.stdout.write(USAGE)
  return 0
}

/** 任务 id 校验（usage：未知 id 是参数错误）。 */
function selectTasks(ids: string[]): SyncTask[] | number {
  const unknown = ids.filter((id) => taskById(id) === undefined)
  if (unknown.length > 0) {
    return usageFail(
      `未知任务：${unknown.join('、')}\n可用任务：${SYNC_TASKS.map((t) => t.id).join('、')}`)
  }
  return ids.length > 0 ? ids.map((id) => taskById(id)!) : SYNC_TASKS
}

interface StoreFlags { db?: string; profile?: string; backend?: string }

function resolveConfig(flags: StoreFlags): { path: string; backend: string; config: Parameters<typeof openStore>[0] } {
  const resolved = resolveStoreConfig({
    flags,
    env: currentStoreEnv(),
  })
  return { path: resolved.config.path, backend: resolved.config.backend, config: resolved.config }
}

/** 只读命令的库前置检查（statSync 分流沿 store status；hint 统一指 store init，spec §九）。 */
function statGuard(path: string): number | null {
  let st: ReturnType<typeof statSync>
  try { st = statSync(path) } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库文件不存在：${path}`,
        hint: '数据库尚未初始化。请先运行：qiyu store init',
      })
    }
    return fail({
      code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `无法访问 ${path}：${e instanceof Error ? e.message : String(e)}`,
      hint: '请检查路径权限（只读命令不需要写权限）',
    })
  }
  if (!st.isFile()) {
    return fail({
      code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `不是普通文件：${path}`,
      hint: '--db 指向的不是普通文件，请给出 .duckdb 数据库文件路径',
    })
  }
  return null
}

/** 打开 ro 库；结构不完整（缺 schema_version）视为「不是本 CLI 创建的库」。 */
async function openRo(config: Parameters<typeof openStore>[0]): Promise<{ store?: Store; code?: number }> {
  let store: Store
  try {
    store = await openStore(config, 'ro')
  } catch (e) { return { code: thrownToExit(e) } }
  try {
    const names = await store.tables()
    if (!names.includes('schema_version')) {
      await store.close()
      // 成因分形（store.ts 同款）：有表无 schema_version 是他人库——store init 会再次
      // 拒绝（duckdb.ts init 的他人库防线），引导过去就是 store init → sync status 死循环；
      // 空库（无任何表）才是「init 可补」的成因。
      return { code: fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库结构不完整（缺表）：${config.path}`,
        hint: names.length > 0
          ? '目标数据库不是本 CLI 创建的，请换 --db 路径'
          : '空库（无任何表）。请先运行：qiyu store init',
      }) }
    }
    return { store }
  } catch (e) {
    try { await store.close() } catch { /* 清理错误不掩盖原异常 */ }
    return { code: thrownToExit(e) }
  }
}

// —— sync status ——

/**
 * sync_state 的 resolved_range 列（epoch 毫秒字符串）→ [ISO, ISO] 输出（G2）。
 * 两端都有值才输出；任一端缺失（v9 前的旧记录 / 从未成功推进）为 null ——
 * 与 run 的 resolved_range 同形态（上海 +08:00 ISO）。
 */
function resolvedRangeOut(st: { resolvedRangeStart?: string | null; resolvedRangeEnd?: string | null } | undefined): [string, string] | null {
  const s = st?.resolvedRangeStart
  const e = st?.resolvedRangeEnd
  if (s === null || s === undefined || e === null || e === undefined) return null
  return [msToShanghaiIso(s), msToShanghaiIso(e)]
}

async function syncStatus(argv: string[]): Promise<number> {
  const help = subHelp(argv)
  if (help !== null) return help
  let parsed: ParsedFlags
  try {
    parsed = parseSubFlags(argv, STORE_VALUE_FLAGS)
  } catch (e) { return usageFail((e as Error).message) }
  // G1：--pretty 已实现（原拒绝点在 parseSubFlags 的 throw）。次序：未知参数（parse 的
  // throw）→ help（subHelp）→ 这里开 pretty → selectTasks 的未知任务名仍报 usage（缩进）。
  if (parsed.flags.has('--pretty')) setPretty(true)
  const tasks = selectTasks(parsed.rest)
  if (typeof tasks === 'number') return tasks

  let resolved
  try {
    resolved = resolveConfig({ db: parsed.values['--db'], profile: parsed.values['--profile'], backend: parsed.values['--backend'] })
    // ⚠️ failFromTagged（不是 usageFail）：配置层会抛带 `kind: config_insecure` 的错误
    // （含凭证且权限过宽 —— 退出码 1、只能由人 chmod）。包成 usageFail 会把它降级成
    // 「改参数重来」退出码 2 并丢掉 hint，与 auth/api 那条路径的说法相反。
  } catch (e) { return failFromTagged(e) }
  const guarded = statGuard(resolved.path)
  if (guarded !== null) return guarded
  const opened = await openRo(resolved.config)
  if (opened.code !== undefined || !opened.store) return opened.code ?? 1
  const store = opened.store

  try {
    const states = await listWatermarks(store)
    const gaps = await listGaps(store)
    const gapsByTask = new Map<string, Array<{ range: [string, string | null]; reason: string; detail: string | null; recorded_at: string }>>()
    for (const g of gaps) {
      const list = gapsByTask.get(g.dataset) ?? []
      // 缺口区间原样回显（sync_gaps 存的是引擎写入的毫秒字符串；这里不二次格式化，
      // 与 run 输出的 ISO 形态差异见 spec §七——status 是状态面、run 是结果面）。
      list.push({
        range: [g.rangeStart, g.rangeEnd],
        reason: g.reason, detail: g.detail, recorded_at: g.recordedAt,
      })
      gapsByTask.set(g.dataset, list)
    }
    const tasksOut = tasks.map((t) => {
      const st = states.get(t.id)
      const taskGaps = gapsByTask.get(t.id) ?? []
      return {
        task: t.id,
        watermark: st?.watermark ?? null,
        range_status: st?.rangeStatus ?? null,
        last_synced_at: st?.lastSyncedAt ?? null,
        // G2 义务（spec §八.2/§十一.17）：上次成功推进覆盖的区间，形态与 sync run 的
        // resolved_range 一致（[ISO, ISO]；列空 = 尚无成功推进或 v9 前的旧记录）。
        resolved_range: resolvedRangeOut(st),
        // 历史缺口的读取通道（spec §三「水位、区间状态、缺口、锁」）：逐条输出，
        // gaps_count 保留为计数快照（既有消费者不破坏）。
        gaps: taskGaps,
        gaps_count: taskGaps.length,
        // 锁列（sync_state.locked_by）——引擎盖章后为真；活跃写锁由本命令自身的
        // ro 打开失败（store_locked）表达（DuckDB 单写者模型）。
        locked: (st?.lockedBy ?? null) !== null,
      }
    })
    return ok({ tasks: tasksOut })
  } catch (e) {
    return thrownToExit(e)
  } finally {
    await store.close()
  }
}

// —— sync verify ——

interface DriftEntry { kind: string; detail: string }

async function syncVerify(argv: string[]): Promise<number> {
  const help = subHelp(argv)
  if (help !== null) return help
  let parsed: ParsedFlags
  try {
    parsed = parseSubFlags(argv, STORE_VALUE_FLAGS)
  } catch (e) { return usageFail((e as Error).message) }
  // G1：同 syncStatus —— 原拒绝点之后开 pretty。
  if (parsed.flags.has('--pretty')) setPretty(true)
  const tasks = selectTasks(parsed.rest)
  if (typeof tasks === 'number') return tasks

  // 凭证惰性解析：快照任务需要上游 fetch；纯 windowed 选中时不碰凭证
  //（归因准确：本地核对不该因缺环境变量失败）。
  const needsUpstream = tasks.some((t) => t.kind === 'snapshot')
  let creds: { appKey: string; appSecret: string } | undefined
  if (needsUpstream) {
    const credOutcome = resolveCredentialsUsingFile(currentCredentialEnv())
    if (!credOutcome.ok) return fail(credOutcome.error)
    creds = credOutcome.creds
  }

  let resolved
  try {
    resolved = resolveConfig({ db: parsed.values['--db'], profile: parsed.values['--profile'], backend: parsed.values['--backend'] })
    // ⚠️ failFromTagged（不是 usageFail）：配置层会抛带 `kind: config_insecure` 的错误
    // （含凭证且权限过宽 —— 退出码 1、只能由人 chmod）。包成 usageFail 会把它降级成
    // 「改参数重来」退出码 2 并丢掉 hint，与 auth/api 那条路径的说法相反。
  } catch (e) { return failFromTagged(e) }
  const guarded = statGuard(resolved.path)
  if (guarded !== null) return guarded
  const opened = await openRo(resolved.config)
  if (opened.code !== undefined || !opened.store) return opened.code ?? 1
  const store = opened.store

  try {
    const states = await listWatermarks(store)
    const tasksOut: Array<Record<string, unknown>> = []
    for (const t of tasks) {
      const localRows = await store.count(t.table)
      const st = states.get(t.id)
      const stateConsistent = st !== undefined && st.rangeStatus === 'complete' && st.watermark !== null
      const drift: DriftEntry[] = []
      if (st === undefined) {
        drift.push({
          kind: 'not_synced',
          detail: 'sync_state 无该任务记录（从未同步）。请先运行：qiyu sync run',
        })
      } else if (!stateConsistent) {
        drift.push({
          kind: 'state_pending',
          detail: `sync_state.range_status=${st.rangeStatus ?? 'null'}（最后一次运行未完成或中断）。`
            + (t.kind === 'windowed'
              ? 'windowed 任务不做上游全量重拉（成本高）：核对方式为本地行数与 sync_state 成功状态一致性——重跑 qiyu sync run 补全后再 verify。'
              : '快照任务将以上游取数核对本地行数。'),
        })
      }
      let expectedFromApi: number | null = null
      if (t.kind === 'snapshot') {
        // 上游取数 = 任务 fetch（配对口径沿引擎：apiCount 为准，缺省取行数）。
        try {
          const res = await t.fetch({ start: 0, end: Date.now(), index: 0, total: 1 },
            { store, credentials: creds! })
          expectedFromApi = res.apiCount ?? res.rows.length
          if (localRows !== expectedFromApi) {
            drift.push({
              kind: 'count_mismatch',
              detail: `本地 ${t.table} 表 ${localRows} 行 ≠ 上游 ${expectedFromApi} 行（配对口径：apiCount）`,
            })
          }
        } catch (e) {
          expectedFromApi = null
          drift.push({
            kind: 'fetch_failed',
            detail: `上游取数失败（无法核对 ≠ 一致）：${e instanceof Error ? e.message : String(e)}`,
          })
        }
      }
      tasksOut.push({
        task: t.id,
        local_rows: localRows,
        expected_from_api: expectedFromApi,
        state_windows_consistent: stateConsistent,
        drift,
      })
    }
    const code = ok({ tasks: tasksOut })
    const hasDrift = tasksOut.some((t) => (t.drift as DriftEntry[]).length > 0)
    return hasDrift ? 1 : code
  } catch (e) {
    return thrownToExit(e)
  } finally {
    await store.close()
  }
}

// —— sync install / uninstall ——

const RATELIMIT_PREFIX = '__ratelimit__:'

/**
 * install 要透传进调度命令的存储定位参数（修复批 4 #4）。
 * 名单取自 `STORE_VALUE_FLAGS`（spec 的 `STORE_FLAGS` 派生）——不再本地手写一份。
 */
const INSTALL_STORE_PASSTHROUGH: readonly string[] = STORE_VALUE_FLAGS

/**
 * 调度条目的存储定位参数（修复批 4 #4 + 批 6 #1）。
 * 两条来源、一个顺序（flag 在前、env 固化在后；同一 flag 不重复）：
 *   ① 用户**显式给出**的 flag（`--db/--profile/--backend`）原样透传 —— 批 4 的既定路径；
 *   ② **env 派生**的存储定位：用户没给对应 flag、但 `QIYU_DB_PATH` / `QIYU_PROFILE` /
 *      `QIYU_STORE_BACKEND` 有值 —— 把**解析结果**（绝对路径 / profile 名 / backend 名）
 *      固化为稳定参数。原因：launchd/schtasks/cron 的调度上下文**不继承**你的 shell
 *      环境变量，前置探测用 env 指到的库、调度任务却跑默认库 —— 探测通过而同步打偏。
 *      这里只固化「env 派生」：配置文件 store.path（HOME 下，调度任务自己读得到）与
 *      内置默认值**不固化**（批 4 裁定：默认值固化会引入漂移）。
 * 实现约束：**不读配置文件内容来生成参数**（配置路径不固化，调度任务自己会读它）；
 * env 已给但解析失败/为空时由 resolveConfig 在更早处抛 usage，不会走到这里。
 * 同一 flag 只在 flag 缺席时才补 env 派生值 —— 显式 flag 永远优先（与 resolveStoreConfig
 * 的 flags > env 优先级一致），不会出现两个 --db。
 */
function storeArgsFor(parsed: ParsedFlags, resolved: { path: string; backend: string }): string[] {
  const args: string[] = []
  const push = (flag: string, value: string): void => { args.push(flag, value) }
  // ① 显式 flag 原样透传（批 4 #4）
  for (const f of INSTALL_STORE_PASSTHROUGH) {
    const v = parsed.values[f]
    if (v !== undefined) push(f, v)
  }
  // ② env 派生 → 固化解析结果（仅当对应 flag 未给）
  if (parsed.values['--db'] === undefined && process.env.QIYU_DB_PATH !== undefined) {
    // 固化的是 resolveStoreConfig 解析后的**绝对路径**（env 的相对路径/`~` 已展开）——
    // 调度任务的 cwd 与 HOME 都可能不同，相对路径会指向别处。
    push('--db', resolved.path)
  }
  if (parsed.values['--profile'] === undefined && process.env.QIYU_PROFILE !== undefined) {
    push('--profile', process.env.QIYU_PROFILE)
  }
  if (parsed.values['--backend'] === undefined && process.env.QIYU_STORE_BACKEND !== undefined) {
    // backend 当前唯一合法值 duckdb（resolveStoreConfig 已校验），固化解析结果而非原始 env 值。
    push('--backend', resolved.backend)
  }
  return args
}

/**
 * install 前置探测（E 高-1）：库已初始化（statGuard + schema_version）**且存在真实成功证据**。
 * ⚠️ 判据是 `range_status='complete'` 或 `last_synced_at` 非空 —— 不是「sync_state 里有行」：
 * 引擎在**任何窗口执行之前**就 markPending 落行（runWindowed/planRotation/runSnapshot），
 * 所以一个全败的 run 同样留下 pending 行。按「有行」放行等于把调度器装在一个从未成功
 * 同步过的库上，探测名不副实（且 hint 会劝用户「先跑通一次」却已经被放行）。
 * 冷却行（`__ratelimit__:` 前缀）本就不是任务行，按前缀排除。
 */
async function probeSynced(config: Parameters<typeof openStore>[0], path: string): Promise<number | null> {
  const guarded = statGuard(path)
  if (guarded !== null) return guarded
  const opened = await openRo(config)
  if (opened.code !== undefined || !opened.store) return opened.code ?? 1
  const store = opened.store
  try {
    const states = await listWatermarks(store)
    const hasSuccess = [...states.values()].some((s) =>
      !s.dataset.startsWith(RATELIMIT_PREFIX)
      && (s.rangeStatus === 'complete' || s.lastSyncedAt !== null))
    if (!hasSuccess) {
      return fail({
        code: 'sync_not_run', kind: 'sync_not_run', retryable: false,
        message: '尚未成功同步过任何任务（sync_state 无 range_status=complete 且无 last_synced_at 的记录）',
        hint: '安装调度前请先跑通一次同步：qiyu sync run',
      })
    }
    return null
  } finally {
    await store.close()
  }
}

/** 命令行形态（输出用）：argv 以空格连接（含空格的部分已按 shellQuote 引住）。 */
const commandText = (argv: string[]): string => argv.join(' ')

async function syncInstall(argv: string[]): Promise<number> {
  const help = subHelp(argv)
  if (help !== null) return help
  let parsed: ParsedFlags
  try {
    parsed = parseSubFlags(argv, INSTALL_VALUE_FLAGS, INSTALL_BOOL_FLAGS)
  } catch (e) { return usageFail((e as Error).message) }
  if (parsed.rest.length > 0) return usageFail(`未知参数：${parsed.rest.join(' ')}`)
  // G1：--pretty 已实现（原拒绝点在 parseSubFlags 的 throw）。
  if (parsed.flags.has('--pretty')) setPretty(true)
  const schedule = parsed.values['--schedule']
  if (schedule === undefined) {
    return usageFail('缺少 --schedule CRON（5 段：分 时 日 月 周）', '例如：qiyu sync install --schedule "*/30 * * * *"')
  }
  const yes = parsed.flags.has('--yes')

  let platform: Platform
  try {
    platform = currentPlatform()
  } catch (e) { return usageFail((e as Error).message) }

  // 前置探测（dry-run 与 --yes 都查：dry-run 应当预测成功）
  let config: Parameters<typeof openStore>[0]
  let path: string
  let backend: string
  try {
    const r = resolveConfig({ db: parsed.values['--db'], profile: parsed.values['--profile'], backend: parsed.values['--backend'] })
    config = r.config; path = r.path; backend = r.backend
    // ⚠️ 同 syncStatus：带 kind 的错误（config_insecure）必须如实透出。
  } catch (e) { return failFromTagged(e) }
  const probe = await probeSynced(config, path)
  if (probe !== null) return probe

  // 计划生成（cron 解析 / 平台映射失败 → usage）
  let plan
  try {
    const entry = process.argv[1]
    plan = planInstall(platform, schedule, {
      home: homedir(),
      exec: entry ? [process.execPath, entry] : ['qiyu'],
      // 修复批 4 #4 + 批 6 #1：调度命令与前置探测必须是**同一个库** —— 显式 flag 原样
      // 透传（批 4）；env 派生的存储定位把解析结果固化为稳定参数（批 6，launchd/schtasks
      // 不继承 shell 环境变量，env 派生不固化会让调度任务跑默认库）。配置文件 store.path
      // 与内置默认值仍不固化（调度任务读得到 HOME 下的配置文件；默认值固化会引入漂移）。
      storeArgs: storeArgsFor(parsed, { path, backend }),
    })
  } catch (e) { return usageFail((e as Error).message) }

  // 部署事实（批 6 #1 连带，写进 dry-run 与 --yes 两路输出）：调度条目不继承 shell 环境。
  const envNote = '调度条目不继承你的 shell 环境：若凭证走 QIYU_APP_KEY / QIYU_APP_SECRET，'
    + '请确认其对该调度上下文可用（launchd 的用户域不含 shell rc 变量）——本条目不写入任何凭证。'

  if (!yes) {
    return ok({
      platform, schedule, dry_run: true,
      entries: plan.entries,
      commands: plan.commands.map((c) => ({ command: commandText(c), executed: false, ok: null, error: null })),
      notes: [...plan.notes, envNote, '这是 dry-run：未写入任何文件、未执行任何命令。加 --yes 实际安装。'],
    })
  }

  // --yes：写文件 + 执行命令（逐条记结果，失败不中断、退出码如实报 1）
  const installed: string[] = []
  for (const e of plan.entries) {
    mkdirSync(dirname(e.path), { recursive: true })
    writeFileSync(e.path, e.content)
    installed.push(e.path)
  }
  const cmdResults: Array<{ command: string; executed: boolean; ok: boolean; error: string | null }> = []
  for (const c of plan.commands) {
    try {
      runScheduleCommand(c)
      cmdResults.push({ command: commandText(c), executed: true, ok: true, error: null })
    } catch (e) {
      cmdResults.push({ command: commandText(c), executed: true, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }
  const code = ok({
    platform, schedule, dry_run: false,
    installed, commands: cmdResults, notes: [...plan.notes, envNote],
  })
  return cmdResults.some((c) => !c.ok) ? 1 : code
}

async function syncUninstall(argv: string[]): Promise<number> {
  const help = subHelp(argv)
  if (help !== null) return help
  let parsed: ParsedFlags
  try {
    parsed = parseSubFlags(argv, [], UNINSTALL_BOOL_FLAGS)
  } catch (e) { return usageFail((e as Error).message) }
  if (parsed.rest.length > 0) return usageFail(`未知参数：${parsed.rest.join(' ')}`)
  // G1：--pretty 已实现（原拒绝点在 parseSubFlags 的 throw）。
  if (parsed.flags.has('--pretty')) setPretty(true)
  const yes = parsed.flags.has('--yes')

  let platform: Platform
  try {
    platform = currentPlatform()
  } catch (e) { return usageFail((e as Error).message) }

  const plan = planUninstall(platform, { home: homedir() })

  if (!yes) {
    return ok({
      platform, dry_run: true,
      remove: plan.remove,
      commands: plan.commands.map((c) => ({ command: commandText(c), executed: false, ok: null, error: null })),
      notes: [...plan.notes, '这是 dry-run：未删除任何文件、未执行任何命令。加 --yes 实际卸载。'],
    })
  }

  const anyInstalled = plan.remove.some((r) => r.exists)
  const cmdResults: Array<{ command: string; executed: boolean; ok: boolean; error: string | null }> = []
  if (anyInstalled) {
    // 卸载次序：先停调度器（unload/disable），再删文件
    for (const c of plan.commands) {
      try {
        runScheduleCommand(c)
        cmdResults.push({ command: commandText(c), executed: true, ok: true, error: null })
      } catch (e) {
        cmdResults.push({ command: commandText(c), executed: true, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
  }
  const removed: string[] = []
  const absent: string[] = []
  for (const r of plan.remove) {
    rmSync(r.path, { force: true })
    if (r.exists) removed.push(r.path)
    else absent.push(r.path)
  }
  const code = ok({
    platform, dry_run: false, removed,
    absent: absent.length > 0 ? absent : undefined,
    commands: cmdResults, notes: anyInstalled ? plan.notes : ['未安装（无条目文件）：未执行任何命令。'],
  })
  return cmdResults.some((c) => !c.ok) ? 1 : code
}

export async function syncCommand(argv: string[]): Promise<number> {
  setPretty(false) // G1：每条命令入口重置输出格式 —— 同一进程内多次 run（测试）不残留上一条命令的开关。
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h') {
    const extra = rest.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
    process.stdout.write(USAGE)
    return 0
  }
  // G1：--pretty 是输出开关，必须写在具体子命令之后（`sync status --pretty`）。
  if (sub === '--pretty') {
    const unknown = rest.filter((a) => a.startsWith('-') && !KNOWN.has(a))
    const positional = rest.filter((a) => !a.startsWith('-'))
    if (unknown.length + positional.length > 0) {
      return usageFail(`未知参数：${[...unknown, ...positional].join(' ')}。--pretty 不接受额外参数`)
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(USAGE)
      return 0
    }
    return usageFail(prettyAfterSubcommand('sync'))
  }
  if (sub !== 'tasks' && sub !== 'run' && sub !== 'status' && sub !== 'verify'
    && sub !== 'install' && sub !== 'uninstall') {
    return usageFail(`未知子命令：${sub}\n可用子命令：tasks、run、status、verify、install、uninstall`)
  }
  if (sub === 'run') return runSyncRun(rest)
  if (sub === 'status') return syncStatus(rest)
  if (sub === 'verify') return syncVerify(rest)
  if (sub === 'install') return syncInstall(rest)
  if (sub === 'uninstall') return syncUninstall(rest)
  // —— tasks ——
  if (rest.includes('--help') || rest.includes('-h')) {
    const rawRest = rest.filter((a) => !KNOWN.has(a))
    if (rawRest.length > 0) return usageFail(`未知参数：${rawRest.join(' ')}`)
    process.stdout.write(USAGE)
    return 0
  }
  // G1：--pretty 已实现 —— 原拒绝点开启缩进输出。
  if (rest.includes('--pretty')) setPretty(true)

  try {
    const parsed = parseSubFlags(rest, TASKS_VALUE_FLAGS)
    if (parsed.rest.length > 0) return usageFail(`未知参数：${parsed.rest.join(' ')}`)
  } catch (e) { return usageFail((e as Error).message) }

  // tasks：只暴露声明元数据，函数字段（fetch/write/enrich）不进 JSON。
  // sensitive_columns（D 高-1/F 中-2）：按 tableByName 取该表的 PII 列清单 —— 这是
  // `sensitive: true` 标记的**运行时出口**（E 的 `db describe` 之外，Agent 现在就能
  // 从 sync tasks 知道哪些列不该 SELECT *）。闭集来自 schema.ts 的列声明，不按名称泛化。
  const tasks = SYNC_TASKS.map((t) => ({
    id: t.id,
    table: t.table,
    kind: t.kind,
    watermark: { field: t.watermark.field, initial: t.watermark.initial },
    maxWindowDays: t.maxWindowDays ?? null,
    overlapDays: t.overlapDays ?? null,
    primaryKey: t.primaryKey,
    sensitive_columns: (tableByName(t.table)?.columns ?? [])
      .filter((c) => c.sensitive === true).map((c) => c.name),
  }))
  const unsupported = UNSUPPORTED_DATASETS.map((u) => ({ id: u.id, unsupported: u.reason }))
  return ok({ tasks, unsupported })
}

export { SYNC_RUN_USAGE }
