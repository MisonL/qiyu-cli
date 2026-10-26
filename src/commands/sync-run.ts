// src/commands/sync-run.ts —— D-T13：sync run 的编排层。
// 职责（spec §三/§七 + 多任务审查的派发义务）：
//   ① fetchZip 生产接线：sessions 任务的下载通道在本层注入 —— 全局 fetch 拉 ZIP 二进制
//      （下载链接是带签名的临时 URL，服务端已授权，不附加 query；凭证缺失在编排入口
//      已显式失败，管线不会进入）。
//   ② 任务排序：显式拓扑序 + 分组交错 —— 按 orderTasks 的 rank 分层执行（层间升序、
//     层内 rotated 批（runRotated）先行 + plain 逐个）：dim(0) → reports/tickets/
//     sessions(1) → knowledge（items/points(2) 先于 categories(3)，驱动序来自 items
//     落库；显式排序不靠报错兜底）。dim 先于报表是硬约束：staff_salary_detail 按
//     staff 表逐客服驱动，缺 dim 首跑必败。
//   ③ robotId 注入：StoreConfig.options.knowledgeRobotIds（number[]）在配置层透传、
//      本层传给 categories 任务消费（发现盲区的手工兜底路径）。
//   ④ --pretty（G1 已实现）：输出缩进开关，写在子命令之后；解析循环收下它
//      （见 RUN_BOOL_FLAGS 分支的 `|| a === '--pretty'`），开启动作在命令层。
//   ⑤ 退出码：任一任务 complete/partial（部分成功）→ 0；全部 failed → 1；用法 → 2。
//   ⑥ 中断裁决：不装 signal handler —— 事务边界是安全点，进程被 kill 时 DuckDB 回滚、
//      水位不推，下次 run 从水位续跑（红线 3 钉死用例覆盖）。
import { openStore } from '../store/index.js'
import { resolveStoreConfig, currentStoreEnv } from '../store/config.js'
import { fileProfile } from '../core/config.js'
import { resolveCredentialsUsingFile, currentCredentialEnv } from './credentials-source.js'
import { RateGate } from '../sync/rate-gate.js'
import { runTask, runRotated } from '../sync/engine.js'
import { SYNC_TASKS, taskById } from '../sync/registry.js'
import type { SyncTask, RunCtx, TaskRunResult } from '../sync/types.js'
import { readWatermark } from '../sync/state.js'
// callPaced 静态导入（范围外发现③）：wireCategories 的注入路径也必须过任务层的限频闸门 ——
// 该接口（ai.knowledge.getCategoryTree）限频 1 次/秒，裸 call 不落冷却行。
import { callPaced } from '../sync/tasks/pace.js'
import { DAY_MS, parseTimeArg, msToShanghaiIso, shanghaiIso } from '../core/time.js'
import { ok, fail, usageFail, failFromTagged, describeArgs, setPretty } from '../output.js'
import { thrownToExit } from './store.js'
import type { Store } from '../store/types.js'
import { GLOBAL_FLAGS, STORE_FLAGS, renderFlagNames, valueFlagNames } from './spec-types.js'
import type { FlagSpec } from './spec-types.js'

/**
 * `sync run` 的业务 flag。事实源是这份常量：解析器的值位判定与「可用：…」错误文案
 * 都从它派生，`sync.ts` 的 `SYNC_SPECS` 也引用它（不另写一份）。
 *
 * ⚠️ `--since/--until` 是值位；`--full/--quiet` 是布尔。`--db/--profile/--backend`
 * 走 `STORE_FLAGS`（与 `parseStoreFlags` 同一份）——`sync run` 自己解析这三个 flag
 * （不走 `parseStoreFlags`：它要连同 `--since/--until` 一起按值位处理）。
 *
 * ⚠️ **数组顺序就是「可用：…」文案的顺序**（历史文案是 `--full --since --until --quiet
 * --db --profile --backend`，逐字被既有输出依赖）：不要按「先布尔后值位」重排。
 */
export const RUN_FLAGS: FlagSpec[] = [
  { name: '--full', kind: 'bool' },
  { name: '--since', kind: 'value' },
  { name: '--until', kind: 'value' },
  { name: '--quiet', kind: 'bool' },
  ...STORE_FLAGS,
]

/** 值位 flag 名（`--since/--until/--db/--profile/--backend`）。 */
const RUN_VALUE_FLAGS = valueFlagNames(RUN_FLAGS)
/** 布尔 flag 名（`--full/--quiet`）。 */
const RUN_BOOL_FLAGS = RUN_FLAGS.filter((f) => f.kind === 'bool').map((f) => f.name)
/**
 * 「可用：……」清单。⚠️ **分隔符是空格**（不是「、」）——这行文案逐字被既有输出依赖，
 * 不得改分隔符。
 */
const RUN_AVAILABLE = renderFlagNames(RUN_FLAGS, { separator: ' ' })

// E 起时间助手下沉 core/time（query/ 不得 import sync/，两域同源）；本层保留
// re-export —— 既有导入点（commands/sync.ts 等）与测试不破。
export { parseTimeArg, msToShanghaiIso }

/** 引擎产出的毫秒区间 → 上海 ISO 区间数组。 */
function rangeOut(r: { start: number; end: number }): [string, string] {
  return [shanghaiIso(r.start), shanghaiIso(r.end)]
}

/**
 * 任务分层 rank（orderTasks 与执行分层共用的唯一来源，审查裁定：不靠报错兜底）。
 * 键序：dim(0) → windowed 报表/工单/会话(1) → knowledge.items/points(2) →
 * knowledge.categories(3，驱动序来自 items 落库)。
 */
function taskRank(t: SyncTask): number {
  if (t.id.startsWith('dim.')) return 0
  if (t.id === 'knowledge.categories') return 3
  if (t.id.startsWith('knowledge.')) return 2
  return 1
}

/**
 * 显式任务排序：按 taskRank 分层（键序见上）。
 * 调用方传入的任务 id 顺序仅决定同层内次序（sort 稳定）；缺省（全量跑）按注册表声明序。
 */
export function orderTasks(tasks: SyncTask[]): SyncTask[] {
  return [...tasks].sort((a, b) => taskRank(a) - taskRank(b))
}

/**
 * fetchZip 生产接线（T10 报告的接线义务）：全局 fetch 拉 ZIP 二进制字节。
 * 修复批 4 #9：**必须有超时** —— 签名 URL 挂起时 `sync run` 会永久挂住、写锁不释放
 *（abort 后引擎记 fetch_failed gap、水位冻结，锁由 finally 清掉）。
 * `AbortSignal.timeout` 是 Node ≥17.3 的内置能力（engines 已声明 ≥20.12）。
 */
const DOWNLOAD_TIMEOUT_MS = 120_000

async function downloadZip(url: string): Promise<Uint8Array> {
  let res: Response
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) })
  } catch (e) {
    // AbortError/TimeoutError → 中文可读消息（由引擎的 failDetail 包装后进 gap detail）
    if ((e as { name?: string }).name === 'TimeoutError' || (e as { name?: string }).name === 'AbortError') {
      throw new Error(`导出包下载超时（${DOWNLOAD_TIMEOUT_MS / 1000} 秒未完成）：` +
        '下载链接可能已失效或网络不可达，重跑本任务即可（导出结果在服务端可复用）')
    }
    throw e
  }
  if (!res.ok) {
    throw new Error(`导出包下载失败：HTTP ${res.status}（链接可能已失效——重新同步即可）`)
  }
  const buf = await res.arrayBuffer()
  return new Uint8Array(buf)
}

/** 给 sessions 任务包装 fetch：把 fetchZip/pollIntervalMs/maxPolls 注进 FetchCtx（T10 的注入面）。 */
function wireSessions(task: SyncTask, opts: { maxPolls?: number }): SyncTask {
  if (task.id !== 'sessions.export') return task
  const orig = task.fetch
  return {
    ...task,
    fetch: async (w, c) => orig(w, {
      ...c,
      fetchZip: downloadZip,
      ...(opts.maxPolls !== undefined ? { maxPolls: opts.maxPolls } : {}),
    } as typeof c),
  }
}

/**
 * 给 knowledge.categories 包装 fetch：注入手工 robotId（StoreConfig.options.
 * knowledgeRobotIds）——发现盲区的兜底（知识库为空的机器人不在 items 驱动序里）。
 * 注入语义：items 驱动失败（表空）时改用注入 id 逐机器人拉取；items 非空时注入
 * id 不生效（避免伪造驱动行污染 items 表）。
 */
function wireCategories(task: SyncTask, robotIds: number[], clock: () => number): SyncTask {
  if (task.id !== 'knowledge.categories' || robotIds.length === 0) return task
  const orig = task.fetch
  return {
    ...task,
    fetch: async (w, c) => {
      try {
        return await orig(w, c)
      } catch (e) {
        if (!/knowledge_items 表为空/.test((e as Error).message)) throw e
      }
      // 注入路径：行拍平消费任务层的共享实现（flattenCategoryTree），不复制投影；
      // 取数走任务层的 callPaced —— `ai.knowledge.getCategoryTree` 限频 1 次/秒，
      // 裸 call 会让远端 14009 不落冷却行、本地令牌桶的拒绝直接冒泡成 fetch_failed gap
      // （B 高-1 的同一口径：所有任务层取数都必须经 callPaced）。
      const { flattenCategoryTree } = await import('../sync/tasks/knowledge.js')
      const nowIso = new Date(clock()).toISOString()
      const rows: Record<string, unknown>[] = []
      for (const rid of robotIds) {
        const res = await callPaced('ai.knowledge.getCategoryTree', { robotId: rid }, c)
        flattenCategoryTree(String(rid), res.payload, rows, nowIso)
      }
      return { rows, apiCount: rows.length }
    },
  }
}

/**
 * 从配置文件读 `profiles.<name>.robots` 的 robotId 列表（G1 兜底来源）。
 *
 * ⚠️ 只取**键**（robotId），显示名是给人看的、注入面用不着。
 * ⚠️ 任何读取失败一律返回 `[]`：本函数是**兜底**，不是主路径 —— 上面
 * `resolveStoreConfig` 已经对同一份文件做过权限裁决与结构校验（含凭证且过宽
 * 会在此前抛出），这里再抛一次只会把同一个问题报两遍，而且会掩盖真正的失败原因。
 */
function robotsFromConfig(configPath: string, profileFlag: string | undefined): number[] {
  try {
    const r = fileProfile(configPath, profileFlag ?? process.env.QIYU_PROFILE)
    return Object.keys(r.profile?.robots ?? {})
      .map((k) => Number(k))
      .filter((n) => Number.isInteger(n) && n > 0)
  } catch {
    return []
  }
}

/** 任务条目 → 输出形态（spec §七字段名）。 */
function taskOut(r: TaskRunResult, watermark: string | null, lastSyncedAt: string | null,
  notes: string[] = []) {
  return {
    task: r.taskId,
    status: r.status,
    windows: r.windows,
    rows: r.rows,
    resolved_range: rangeOut(r.resolvedRange),
    watermark,
    last_synced_at: lastSyncedAt,
    // gap 区间与 resolved_range 同走上海 ISO（E 中-2/C-11：时间形态在命令层统一，
    // 不动引擎——引擎产出的毫秒字符串在格式化层转换）。
    gaps: r.gaps.map((g) => ({
      range: [msToShanghaiIso(g.rangeStart), msToShanghaiIso(g.rangeEnd)],
      reason: g.reason, detail: g.detail,
    })),
    // 命令层的按任务说明（恒在，可为空数组）：当前唯一生产者是「请求区间早于接口下界」
    //（见 runSyncRun 的 floorNote）——把「区间不可得」与「同步故障」在输出里分开。
    notes,
  }
}

/**
 * sync run 侧的存储失败出口。
 *
 * ⚠️ **保留底层错误的 hint**（架构审查 F1）：`store_not_initialized` 有四种成因，只有
 * 「库不存在」能靠 `qiyu store init` 解决；「路径不是 DuckDB 文件」「他人库」「依赖未安装」
 * 跑 store init 会**再次失败**（`duckdb.ts:216-222` 会拒绝他人库，`depError` 的 hint 指向
 * npm install）。早先无条件改成「请先运行 store init」，把 Agent 送进
 * `sync run → store init → sync run` 死循环，且与 `store status`/`db tables` 对同一失败
 * 给出的 hint 互相矛盾。现在只在**没有**底层 hint 时补缺省建议。
 */
function storeInitFail(e: unknown): number {
  const err = e as { kind?: string; message?: string; retryable?: boolean; hint?: string }
  const msg = err.message ?? String(e)
  if (err.kind === 'store_not_initialized' || /not a valid DuckDB database/i.test(msg)) {
    // 成因优先于缺省建议：底层 hint（依赖缺失 / 他人库 / 权限）原样保留；
    // 「路径存在但不是 DuckDB 文件」由 DuckDB 原文判定（store.ts 同款文案）。
    const hint = err.hint
      ?? (/not a valid DuckDB database/i.test(msg)
        ? '该路径已存在且不是 DuckDB 数据库，请换 --db 路径'
        : '数据库尚未初始化。请先运行：qiyu store init')
    return fail({
      code: 'store_not_initialized', kind: 'store_not_initialized',
      retryable: false,
      message: msg,
      hint,
    })
  }
  return thrownToExit(e)
}

/** sync run 的完整编排（从 flags/env 到退出码）。返回值即命令退出码。 */
export async function runSyncRun(argv: string[]): Promise<number> {
  setPretty(false) // G1：每条命令入口重置输出格式 —— 同一进程内多次 run（测试）不残留上一条命令的开关。
  const clock = (): number => Date.now()
  // —— flag 解析（store.ts 同族：值位守卫，--开头算缺值）——
  // 已知 token 集（help 分流的豁免名单）= 全局 flag + 本命令的**布尔** flag。
  // ⚠️ 不含值位：`sync run --help --since 7d` 必须报「--help 不接受额外参数」并把
  // `--since` 点出来（既有测试钉着这条次序）；值位只在下面的解析循环里消费。
  const KNOWN = new Set([...GLOBAL_FLAGS.map((f) => f.name), ...RUN_BOOL_FLAGS])

  // ⚠️ `--help` 必须先分流、且不吞额外参数（架构审查 F2）：全仓不变量是「help 永远成功、
  // 但不能把写错的参数静默吃掉」。早先这一分支写在解析循环里，于是
  // `sync run --help --bogus` 退出码 0（--bogus 被吞）、`--pretty --help` 却退出码 2
  // （先撞上 --pretty 检查）—— 同一组 token 因书写顺序得到两种结果。
  if (argv.includes('--help') || argv.includes('-h')) {
    const extra = argv.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) {
      // ⚠️ 不要写「未知参数」：`--since`/`--db` 是**已知**参数，只是不能与 --help 同用。
      // 与 query.ts 的 help 分流同款措辞（CodeRabbit 复审 minor）。
      return usageFail(`--help 不接受额外参数：${describeArgs(extra)}`)
    }
    process.stdout.write(SYNC_RUN_USAGE)
    return 0
  }
  // G1：--pretty 已实现。与 help 的次序保持原样（help 分流在前）；解析循环里
  // `--pretty` 落进未知参数分支会报错，所以在 KNOWN 里收下并在原拒绝点开启。
  if (argv.includes('--pretty')) setPretty(true)

  const flags: Record<string, string> = {}
  const taskIds: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (RUN_VALUE_FLAGS.includes(a)) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) {
        return usageFail(`${a} 缺少取值`)
      }
      flags[a] = v
      i++
    } else if (RUN_BOOL_FLAGS.includes(a) || a === '--pretty') {
      // G1：--pretty 是已实现的输出开关（布尔）。收下避免报「未知参数」。
      flags[a] = a
    } else if (a.startsWith('-')) {
      return usageFail(`未知参数：${describeArgs([a])}。可用：${RUN_AVAILABLE}`)
    } else {
      taskIds.push(a)
    }
  }
  if (flags['--full'] && (flags['--since'] || flags['--until'])) {
    return usageFail('--full 与 --since/--until 互斥：全量重刷不叠加区间参数')
  }

  // —— 任务 id 校验（usage：未知 id 是参数错误）——
  const unknown = taskIds.filter((id) => taskById(id) === undefined)
  if (unknown.length > 0) {
    return usageFail(
      `未知任务：${unknown.join('、')}\n可用任务：${SYNC_TASKS.map((t) => t.id).join('、')}`)
  }

  // —— 凭证前置（api.ts 同族：缺凭证是环境问题 → auth_missing 退出码 1）——
  const credOutcome = resolveCredentialsUsingFile(currentCredentialEnv())
  if (!credOutcome.ok) return fail(credOutcome.error)
  const creds = credOutcome.creds

  // —— store 打开（rw 单写者）——
  // ⚠️ close 覆盖 openStore 之后的**所有**路径（B 低-1，沿 store.ts 的 C1 形态）：
  // 迁移失败 / 他人库 / 后续任何异常，连接与 DuckDB instance 都必须在 finally 释放 ——
  // 此前 close 只挂在第二个 try 的 finally 上，第一个 try（open+init）失败即泄漏。
  let resolved
  try {
    resolved = resolveStoreConfig({
      flags: { db: flags['--db'], profile: flags['--profile'], backend: flags['--backend'] },
      env: currentStoreEnv(),
    })
    // ⚠️ failFromTagged（不是 usageFail）：配置层会抛带 `kind: config_insecure` 的错误
    // （含凭证且权限过宽 —— 退出码 1、只能由人 chmod）。包成 usageFail 会把它降级成
    // 「改参数重来」退出码 2 并丢掉 hint，与 auth/api 那条路径的说法相反。
  } catch (e) { return failFromTagged(e) }
  let store: Store | undefined
  try {
    try {
      store = await openStore(resolved.config, 'rw')
      await store.init()
    } catch (e) { return storeInitFail(e) }

    // —— 区间合成（时钟注入点：parseTimeArg 接受 clock；Nd/yesterday 已带区间，
    //     YYYY-MM-DD/ISO 只给起点 → end=clock 当前或配对的另一端）——
    let rangeOverride: { start: number; end: number } | undefined
    if (flags['--full']) {
      rangeOverride = { start: 0, end: clock() }
    } else if (flags['--since'] || flags['--until']) {
      const untilMs = flags['--until']
        ? parseTimeArg(flags['--until'], clock, '--until')
        : null
      if (flags['--until'] && untilMs === null) {
        return usageFail(`--until 无法解析：${flags['--until']}。支持 Nd / yesterday / YYYY-MM-DD / ISO 8601`)
      }
      const sinceMs = flags['--since']
        ? parseTimeArg(flags['--since'], clock, '--since')
        : null
      if (flags['--since'] && sinceMs === null) {
        return usageFail(`--since 无法解析：${flags['--since']}。支持 Nd / yesterday / YYYY-MM-DD / ISO 8601`)
      }
      // 归一：Nd/yesterday 返回完整区间（起点优先）；日期/ISO 返回时刻。
      // 单 --until（分段回补）：start=0、end=until 时刻；单 --since：start=since 时刻、
      // end=now；成对：[since 时刻, until 时刻]；--since 带 Nd 区间时用其 start。
      const start = sinceMs === null ? 0
        : typeof sinceMs === 'object' ? sinceMs.start : sinceMs
      const end = untilMs === null ? clock()
        : typeof untilMs === 'object' ? untilMs.end : untilMs
      if (start >= end) {
        return usageFail(`区间无效：start >= end（${new Date(start).toISOString()} >= ${new Date(end).toISOString()}）`)
      }
      rangeOverride = { start, end }
    }

    // —— 任务选取与排序 ——
    const selected = orderTasks(taskIds.length > 0
      ? taskIds.map((id) => taskById(id)!)
      : SYNC_TASKS)

    // —— robotId 注入面（配置层透传，本层消费）——
    const opts = resolved.config.options as Record<string, unknown> | undefined
    const rawIds = opts?.knowledgeRobotIds
    // 修复批 4 #10：**整数组校验** —— 任一元素不是正整数即 usageFail（退出码 2）。
    // 此前 `map(Number).filter(...)` 会把 `["abc", -1]` 静默丢成空数组：用户 typo
    // 了 robotId 却毫无反馈（注入面静默失效）。非数组的错误分支保留。
    if (rawIds !== undefined && !Array.isArray(rawIds)) {
      return usageFail('配置文件 profiles.<name>.store.options.knowledgeRobotIds 必须是数字数组')
    }
    if (Array.isArray(rawIds)) {
      const bad = rawIds.find((x) => !Number.isInteger(x) || (x as number) <= 0)
      if (bad !== undefined) {
        return usageFail(
          `配置文件 profiles.<name>.store.options.knowledgeRobotIds 必须是正整数数组（非法元素：${String(bad)}）`)
      }
    }
    const robotIds = rawIds !== undefined
      ? (rawIds as number[]).map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
      // ⚠️ G1 起配置里的 `profiles.<name>.robots`（`auth whoami` 输出的那份映射）
      // 是兜底来源 —— 否则它是个「声明了但没人读」的死字段。优先级：
      // store.options.knowledgeRobotIds > robots 键（向后兼容：已配 options 的
      // 行为逐字不变）。权限裁决复用上方 resolveStoreConfig 的结果（同一次
      // 调用已经查过），这里只读不再裁决。
      : robotsFromConfig(resolved.configPath, flags['--profile'])

    const ctxBase = {
      store,
      credentials: creds,
      gate: new RateGate(store, clock),
      clock,
    }
    const onProgress = flags['--quiet'] === undefined
      ? (line: string): void => { process.stderr.write(line + '\n') }
      : undefined

    // —— 分层交错执行（高-1 修复）：selected 已按 taskRank 有序，这里按 rank 分段 ——
    // 每段内：reportDayRotation 批走 runRotated（同一天背靠背、避开同路径 30s 冷却），
    // 其余逐个 runTask。段间严格串行 ⇒ rank=0 的 dim 先落库，rank=1 的报表才驱动
    // staff 表（staff_salary_detail 缺 dim 首跑必败），knowledge 的 items/points(2)
    // 先于 categories(3)。两组不再整体前后排列（那会把 dim 排到报表之后）。
    const results: TaskRunResult[] = []
    // 按任务的「请求区间早于接口下界」说明（B 中-5 命令层补口）：
    // 声明了 windowStartFloorDays 的任务（接口物理上只提供最近 N 天，如 `ticket.search`
    // 的 `opStart` 被服务端静默钳到 now−31 天），当**整个请求区间**早于该下界时，这段历史
    // 上游给不出数据 —— 结果形态可能是任务层守卫显式失败（落 gap、partial），也可能是
    // 服务端静默改写窗口（客户端以为同步了 [a,b]，实际拿到的是别的窗口）。两种都不该让
    // Agent 误读成「同步故障」或「这段已同步」→ 本层在此补 notes 把话说在明处。
    // 判据只取「end 早于下界」（请求区间整体不可得）；与下界部分重叠（start 在下界之前、
    // end 在下界之后）的显式正数起点是引擎「原样照发」的既定语义（批 1 裁定），不在本层改写。
    const floorNotes = new Map<string, string[]>()
    if (rangeOverride !== undefined) {
      for (const t of selected) {
        if (t.windowStartFloorDays === undefined) continue
        const floor = clock() - t.windowStartFloorDays * DAY_MS
        if (rangeOverride.end <= floor) {
          floorNotes.set(t.id, [
            `请求区间结束于 ${shanghaiIso(rangeOverride.end)}，早于该接口可得数据的最早边界 ` +
            `${shanghaiIso(floor)}（now − ${t.windowStartFloorDays} 天）：这段区间上游物理上给不出数据 ——` +
            `结果要么是任务层守卫显式失败（落 gap、partial），要么是服务端把窗口静默改写；` +
            `两者都不代表「请求的区间已同步」，请勿据此判断数据完整。`,
          ])
        }
      }
    }
    const ranks = [...new Set(selected.map((t) => taskRank(t)))].sort((a, b) => a - b)
    for (const rank of ranks) {
      const layer = selected.filter((t) => taskRank(t) === rank)
      const rotated = layer.filter((t) => t.reportDayRotation)
      const plain = layer.filter((t) => !t.reportDayRotation)
        .map((t) => wireCategories(wireSessions(t, {}), robotIds, clock))
      if (rotated.length > 0) {
        results.push(...await runRotated(rotated, {
          ...ctxBase, rangeOverride, onProgress,
        }))
      }
      for (const t of plain) {
        results.push(await runTask(t, { ...ctxBase, rangeOverride, onProgress }))
      }
    }

    // —— 输出（spec §七）——
    const tasksOut = []
    for (const r of results) {
      const st = await readWatermark(store, r.taskId)
      tasksOut.push(taskOut(r, st.watermark, st.lastSyncedAt, floorNotes.get(r.taskId) ?? []))
    }
    // 全失败判定（T13 fix 中-1）：引擎对 windowed 全窗失败权威产出 partial（'failed'
    // 只留给快照 gate 拦截路径）——「全失败」必须补判窗口级：succeeded=0 且 failed>0
    // 的任务与 status='failed' 并列计入退出码 1。
    const allFailed = results.every((r) =>
      r.status === 'failed' || (r.windows.succeeded === 0 && r.windows.failed > 0))
    const code = ok({ tasks: tasksOut, truncated: false })
    // stderr 汇总（spec §二：核对不符等在 run 结束的 stderr 汇总中列出；下界裁剪的
    // notes 同样进 stderr——--quiet 时只看 stdout 的 tasks[].notes）。
    if (flags['--quiet'] === undefined) {
      for (const r of results) {
        if (r.gaps.length > 0) {
          process.stderr.write(`[${r.taskId}] ${r.gaps.length} 个缺口：` +
            r.gaps.map((g) => g.reason).join('、') + '\n')
        }
        for (const n of floorNotes.get(r.taskId) ?? []) {
          process.stderr.write(`[${r.taskId}] 提示：${n}\n`)
        }
      }
    }
    return allFailed ? 1 : code
  } catch (e) {
    return thrownToExit(e)
  } finally {
    // openStore 之前的失败（resolveStoreConfig/凭证/flag）已在更早的 return 处理，
    // 不会进这里；走到本 finally 时 store 可能仍为 undefined（openStore 自身抛错）。
    if (store !== undefined) await store.close()
  }
}

export const SYNC_RUN_USAGE = `用法：qiyu sync run [任务...] [参数]

  qiyu sync run                 增量同步全部任务（缺省 = 注册表全部）
  qiyu sync run <任务...>       只跑指定任务
  --full                        全区间重刷（与 --since/--until 互斥）
  --since T --until T           指定区间；T 支持 Nd / yesterday / YYYY-MM-DD / ISO 8601
                                （相对时间与日期按 Asia/Shanghai 解析）
  --quiet                       关闭 stderr 进度
  --db / --profile / --backend  存储定位（store 命令同族）

进度与提示走 stderr；stdout 是 {tasks:[…], truncated:false}，每任务含 resolved_range
（+08:00 ISO）、gaps（同 ISO 形态）与 notes（请求区间早于接口可得下界等说明，空数组为常态）。
部分成功退出码 0；全部失败 1；用法错误 2。中断在事务边界安全（kill 后续跑）。
`
