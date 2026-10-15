// src/commands/sync.ts —— D-T12：sync 命令骨架；D-T13：run 子命令挂载；
// D-T14：status / verify / install / uninstall 四子命令。
// 骨架沿 store.ts：parseFlags → usageFail/fail 双通道 → thrownToExit 扩展。
// --pretty 统一裁决（T12 遗留 minor，T13 落地）：沿 api.ts 族——承诺过、未实现的
// flag 一律 usageFail 显式拒绝（退出码 2），顶层/子命令级/run/tasks 同答，无豁免集。
//
// T14 语义（spec §7.6 / 简化裁定）：
//   · status / verify 以 ro 打开库（spec §6.3：单写者模型下读者走 C1 退避）；
//   · verify 对 snapshot 任务做三方核对（本地表行数 / 上游任务 fetch 的 apiCount /
//     sync_state 状态），对 windowed 任务不做上游全量重拉（成本高），只核对
//     local_rows 与 sync_state 成功状态的一致性——expected_from_api 为 null，
//     drift 非空时 detail 说明核对方式；
//   · install/uninstall 的平台条目生成与命令执行在 src/schedule/install.ts，
//     平台检测与外部命令均为注入点（__setPlatform/__setRun）；
//   · install 前置探测：库已初始化（schema_version 存在）且跑通过一次 sync run
//     （sync_state 有非冷却行）——hint 一律指 `qiyu sync run`（spec §9.5：D 交付后
//     store_not_initialized 的 hint 改指 sync run，sync run 首跑会自动建库）。
// 输出键一律下划线命名（spec §七：range_status / gaps_count / local_rows /
// expected_from_api / state_windows_consistent）——本仓 Agent 契约的统一形态。
import { homedir } from 'node:os'
import { statSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { dirname } from 'node:path'
import { SYNC_TASKS, taskById, UNSUPPORTED_DATASETS } from '../sync/registry.js'
import { listGaps, listWatermarks } from '../sync/state.js'
import type { SyncTask } from '../sync/types.js'
import { resolveStoreConfig } from '../store/config.js'
import { openStore } from '../store/index.js'
import { resolveCredentials } from '../core/credentials.js'
import { ok, fail, usageFail } from '../output.js'
import { runSyncRun, SYNC_RUN_USAGE } from './sync-run.js'
import { thrownToExit } from './store.js'
import {
  currentPlatform, runScheduleCommand, planInstall, planUninstall,
} from '../schedule/install.js'
import type { Platform } from '../schedule/install.js'
import type { Store } from '../store/types.js'

const USAGE = `用法：qiyu sync <子命令> [参数]

子命令：
  sync tasks               列出全部同步任务与不支持的实时快照数据集
  sync run [任务...]        同步数据进本地库（--full / --since / --until / --quiet）
  sync status [任务...]     水位、区间状态、缺口与锁（只读；缺省全部任务）
  sync verify [任务...]     核对本地与远端一致性（快照三方核对；drift 非空退出码 1）
  sync install --schedule CRON [--yes]
                           生成并安装系统调度条目（默认 dry-run，--yes 才写入）
  sync uninstall [--yes]   移除系统调度条目（默认 dry-run，--yes 才删除）

CRON 为 5 段（分 时 日 月 周），支持 * / 数字 / a-b / a-b/k / */k / 逗号列表。
存储定位：--db / --profile / --backend（store 命令同族）。
install 的平台形态：darwin=launchd plist、linux=systemd unit+timer（crontab 兜底）、
win32=schtasks。安装前置：库已初始化且跑通过一次 sync run。
`

const KNOWN = new Set(['--help', '-h', '--pretty'])

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
      throw new Error('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
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
    env: {
      QIYU_DB_PATH: process.env.QIYU_DB_PATH,
      QIYU_STORE_BACKEND: process.env.QIYU_STORE_BACKEND,
      QIYU_PROFILE: process.env.QIYU_PROFILE,
    },
  })
  return { path: resolved.config.path, backend: resolved.config.backend, config: resolved.config }
}

/** 只读命令的库前置检查（statSync 分流沿 store status；hint 按 spec §9.5 指 sync run）。 */
function statGuard(path: string): number | null {
  let st: ReturnType<typeof statSync>
  try { st = statSync(path) } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库文件不存在：${path}`,
        hint: '数据库尚未初始化。请先运行一次同步（首次运行会自动建库）：qiyu sync run',
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
      return { code: fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库结构不完整（缺表）：${config.path}`,
        hint: '目标数据库不是本 CLI 创建的，请换 --db 路径，或先运行 qiyu sync run',
      }) }
    }
    return { store }
  } catch (e) {
    try { await store.close() } catch { /* 清理错误不掩盖原异常 */ }
    return { code: thrownToExit(e) }
  }
}

// —— sync status ——

async function syncStatus(argv: string[]): Promise<number> {
  const help = subHelp(argv)
  if (help !== null) return help
  let parsed: ParsedFlags
  try {
    parsed = parseSubFlags(argv, ['--db', '--profile', '--backend'])
  } catch (e) { return usageFail((e as Error).message) }
  const tasks = selectTasks(parsed.rest)
  if (typeof tasks === 'number') return tasks

  let resolved
  try {
    resolved = resolveConfig({ db: parsed.values['--db'], profile: parsed.values['--profile'], backend: parsed.values['--backend'] })
  } catch (e) { return usageFail((e as Error).message) }
  const guarded = statGuard(resolved.path)
  if (guarded !== null) return guarded
  const opened = await openRo(resolved.config)
  if (opened.code !== undefined || !opened.store) return opened.code ?? 1
  const store = opened.store

  try {
    const states = await listWatermarks(store)
    const gaps = await listGaps(store)
    const gapCounts = new Map<string, number>()
    for (const g of gaps) gapCounts.set(g.dataset, (gapCounts.get(g.dataset) ?? 0) + 1)
    const tasksOut = tasks.map((t) => {
      const st = states.get(t.id)
      return {
        task: t.id,
        watermark: st?.watermark ?? null,
        range_status: st?.rangeStatus ?? null,
        last_synced_at: st?.lastSyncedAt ?? null,
        gaps_count: gapCounts.get(t.id) ?? 0,
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
    parsed = parseSubFlags(argv, ['--db', '--profile', '--backend'])
  } catch (e) { return usageFail((e as Error).message) }
  const tasks = selectTasks(parsed.rest)
  if (typeof tasks === 'number') return tasks

  // 凭证惰性解析：快照任务需要上游 fetch；纯 windowed 选中时不碰凭证
  //（归因准确：本地核对不该因缺环境变量失败）。
  const needsUpstream = tasks.some((t) => t.kind === 'snapshot')
  let creds: { appKey: string; appSecret: string } | undefined
  if (needsUpstream) {
    try {
      creds = resolveCredentials({}, {
        appKey: process.env.QIYU_APP_KEY, appSecret: process.env.QIYU_APP_SECRET,
      })
    } catch (e) {
      return fail({
        code: 'auth_missing', kind: 'auth_missing', retryable: false,
        message: e instanceof Error ? e.message : String(e),
        hint: '设置 QIYU_APP_KEY / QIYU_APP_SECRET 环境变量',
      })
    }
  }

  let resolved
  try {
    resolved = resolveConfig({ db: parsed.values['--db'], profile: parsed.values['--profile'], backend: parsed.values['--backend'] })
  } catch (e) { return usageFail((e as Error).message) }
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

/** install 前置探测：库已初始化（statGuard + schema_version）且跑通过一次 sync run。 */
async function probeSynced(config: Parameters<typeof openStore>[0], path: string): Promise<number | null> {
  const guarded = statGuard(path)
  if (guarded !== null) return guarded
  const opened = await openRo(config)
  if (opened.code !== undefined || !opened.store) return opened.code ?? 1
  const store = opened.store
  try {
    const states = await listWatermarks(store)
    const hasHistory = [...states.keys()].some((k) => !k.startsWith(RATELIMIT_PREFIX))
    if (!hasHistory) {
      return fail({
        code: 'sync_not_run', kind: 'sync_not_run', retryable: false,
        message: '尚未运行过同步（sync_state 无任何数据集记录）',
        hint: '安装调度前请先跑通一次：qiyu sync run',
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
    parsed = parseSubFlags(argv, ['--schedule', '--db', '--profile', '--backend'], ['--yes'])
  } catch (e) { return usageFail((e as Error).message) }
  if (parsed.rest.length > 0) return usageFail(`未知参数：${parsed.rest.join(' ')}`)
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
  try {
    const r = resolveConfig({ db: parsed.values['--db'], profile: parsed.values['--profile'], backend: parsed.values['--backend'] })
    config = r.config; path = r.path
  } catch (e) { return usageFail((e as Error).message) }
  const probe = await probeSynced(config, path)
  if (probe !== null) return probe

  // 计划生成（cron 解析 / 平台映射失败 → usage）
  let plan
  try {
    const entry = process.argv[1]
    plan = planInstall(platform, schedule, {
      home: homedir(),
      exec: entry ? [process.execPath, entry] : ['qiyu'],
    })
  } catch (e) { return usageFail((e as Error).message) }

  if (!yes) {
    return ok({
      platform, schedule, dry_run: true,
      entries: plan.entries,
      commands: plan.commands.map((c) => ({ command: commandText(c), executed: false, ok: null, error: null })),
      notes: [...plan.notes, '这是 dry-run：未写入任何文件、未执行任何命令。加 --yes 实际安装。'],
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
    installed, commands: cmdResults, notes: plan.notes,
  })
  return cmdResults.some((c) => !c.ok) ? 1 : code
}

async function syncUninstall(argv: string[]): Promise<number> {
  const help = subHelp(argv)
  if (help !== null) return help
  let parsed: ParsedFlags
  try {
    parsed = parseSubFlags(argv, [], ['--yes'])
  } catch (e) { return usageFail((e as Error).message) }
  if (parsed.rest.length > 0) return usageFail(`未知参数：${parsed.rest.join(' ')}`)
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
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h') {
    const extra = rest.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
    process.stdout.write(USAGE)
    return 0
  }
  if (sub === '--pretty') {
    return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
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
  if (rest.includes('--pretty')) return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')

  try {
    const parsed = parseSubFlags(rest, [])
    if (parsed.rest.length > 0) return usageFail(`未知参数：${parsed.rest.join(' ')}`)
  } catch (e) { return usageFail((e as Error).message) }

  // tasks：只暴露声明元数据，函数字段（fetch/write/enrich）不进 JSON。
  const tasks = SYNC_TASKS.map((t) => ({
    id: t.id,
    table: t.table,
    kind: t.kind,
    watermark: { field: t.watermark.field, initial: t.watermark.initial },
    maxWindowDays: t.maxWindowDays ?? null,
    overlapDays: t.overlapDays ?? null,
    primaryKey: t.primaryKey,
  }))
  const unsupported = UNSUPPORTED_DATASETS.map((u) => ({ id: u.id, unsupported: u.reason }))
  return ok({ tasks, unsupported })
}

export { SYNC_RUN_USAGE }
