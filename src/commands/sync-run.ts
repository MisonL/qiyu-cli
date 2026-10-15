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
//   ④ --pretty 统一裁决：沿 api.ts 族——承诺过、未实现的 flag 一律 usageFail 显式拒绝，
//      不进任何子命令的合法集（T12 遗留 minor 的统一：tasks/run 同答）。
//   ⑤ 退出码：任一任务 complete/partial（部分成功）→ 0；全部 failed → 1；用法 → 2。
//   ⑥ 中断裁决：不装 signal handler —— 事务边界是安全点，进程被 kill 时 DuckDB 回滚、
//      水位不推，下次 run 从水位续跑（红线 3 钉死用例覆盖）。
import { openStore } from '../store/index.js'
import { resolveStoreConfig } from '../store/config.js'
import { resolveCredentials } from '../core/credentials.js'
import { RateGate } from '../sync/rate-gate.js'
import { runTask, runRotated } from '../sync/engine.js'
import { SYNC_TASKS, taskById } from '../sync/registry.js'
import type { SyncTask, RunCtx, TaskRunResult } from '../sync/types.js'
import { readWatermark } from '../sync/state.js'
import { ok, fail, usageFail } from '../output.js'
import { thrownToExit } from './store.js'
import type { Store } from '../store/types.js'

const DAY = 86_400_000

/** 上海固定偏移毫秒（Asia/Shanghai 无夏令时，恒 +08:00 —— 用固定偏移做自然日换算）。 */
const SHANGHAI_OFFSET_MS = 8 * 3_600_000

const SHANGHAI_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** 毫秒 → 上海时区的 ISO 回显（resolved_range/watermark 的输出形态，spec §九.3）。 */
function shanghaiIso(ms: number): string {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS)
  // 整秒时省略毫秒段（spec 示例形态 "2026-09-14T00:00:00+08:00"）；带毫秒保留
  const iso = shifted.toISOString()
  const msPart = shifted.getUTCMilliseconds()
  return (msPart === 0 ? iso.replace('.000Z', 'Z') : iso).replace('Z', '+08:00')
}

/** 引擎产出的毫秒区间 → 上海 ISO 区间数组。 */
function rangeOut(r: { start: number; end: number }): [string, string] {
  return [shanghaiIso(r.start), shanghaiIso(r.end)]
}

/** 上海自然日 00:00 → epoch 毫秒（YYYY-MM-DD）。 */
function shanghaiMidnightUtc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) - SHANGHAI_OFFSET_MS
}

/** 上海时区的「今天」日期键（YYYY-MM-DD）。 */
function shanghaiToday(clock: () => number): string {
  return SHANGHAI_DAY.format(new Date(clock()))
}

/**
 * 时间参数解析（spec §九.3：相对时间与日期按 Asia/Shanghai 解析，回显 resolved_range）：
 *   · Nd（如 30d）→ 相对时长：end=clock 当前、start=end−N 天（纯时长与时区无关，
 *     按上海自然日切分由引擎窗口逻辑吸收）；
 *   · yesterday → 上海昨天的 00:00（单日窗）；
 *   · YYYY-MM-DD → 上海当天 00:00；
 *   · 其余（完整 ISO 8601）→ Date.parse，NaN 视为用法错误。
 */
export function parseTimeArg(arg: string, clock: () => number,
  label: string): { start: number; end: number } | number | null {
  void label
  const dur = /^(\d+)d$/.exec(arg)
  if (dur) {
    const end = clock()
    return { start: end - Number(dur[1]) * DAY, end }
  }
  if (arg === 'yesterday') {
    // 上海昨天 00:00 ~ 今天 00:00 的单日窗
    const today = shanghaiToday(clock)
    const [ty, tm, td] = today.split('-').map(Number) as [number, number, number]
    const todayStart = shanghaiMidnightUtc(ty, tm, td)
    return { start: todayStart - DAY, end: todayStart }
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(arg)
  if (date) return shanghaiMidnightUtc(Number(date[1]), Number(date[2]), Number(date[3]))
  const full = Date.parse(arg)
  if (!Number.isNaN(full)) return full
  return null   // 解析失败 → 调用方 usage
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

/** fetchZip 生产接线（T10 报告的接线义务）：全局 fetch 拉 ZIP 二进制字节。 */
async function downloadZip(url: string): Promise<Uint8Array> {
  const res = await fetch(url)
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
      // 注入路径：行拍平消费任务层的共享实现（flattenCategoryTree），不复制投影。
      const { call } = await import('../core/http.js')
      const { byId } = await import('../core/registry/index.js')
      const { flattenCategoryTree } = await import('../sync/tasks/knowledge.js')
      const nowIso = new Date(clock()).toISOString()
      const rows: Record<string, unknown>[] = []
      for (const rid of robotIds) {
        const res = await call(byId('ai.knowledge.getCategoryTree'), { robotId: rid },
          { credentials: c.credentials })
        flattenCategoryTree(String(rid), res.payload, rows, nowIso)
      }
      return { rows, apiCount: rows.length }
    },
  }
}

/** 任务条目 → 输出形态（spec §七字段名）。 */
function taskOut(r: TaskRunResult, watermark: string | null, lastSyncedAt: string | null) {
  return {
    task: r.taskId,
    status: r.status,
    windows: r.windows,
    rows: r.rows,
    resolved_range: rangeOut(r.resolvedRange),
    watermark,
    last_synced_at: lastSyncedAt,
    gaps: r.gaps.map((g) => ({
      range: [g.rangeStart, g.rangeEnd], reason: g.reason, detail: g.detail,
    })),
  }
}

/** sync run 侧的 store_not_initialized 出口：hint 指 `qiyu store init`（spec §三/§九）。 */
function storeInitFail(e: unknown): number {
  const err = e as { kind?: string; message?: string; retryable?: boolean }
  const msg = err.message ?? String(e)
  if (err.kind === 'store_not_initialized' || /not a valid DuckDB database/i.test(msg)) {
    return fail({
      code: 'store_not_initialized', kind: 'store_not_initialized',
      retryable: false,
      message: msg,
      hint: '数据库尚未初始化。请先运行：qiyu store init',
    })
  }
  return thrownToExit(e)
}

/** sync run 的完整编排（从 flags/env 到退出码）。返回值即命令退出码。 */
export async function runSyncRun(argv: string[]): Promise<number> {
  const clock = (): number => Date.now()
  // —— flag 解析（store.ts 同族：值位守卫，--开头算缺值）——
  const KNOWN = new Set(['--full', '--quiet', '--pretty', '--help', '-h'])
  const flags: Record<string, string> = {}
  const taskIds: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--since' || a === '--until' || a === '--db' || a === '--profile' || a === '--backend') {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) {
        return usageFail(`${a} 缺少取值`)
      }
      flags[a] = v
      i++
    } else if (KNOWN.has(a)) {
      if (a === '--pretty') return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
      if (a === '--help' || a === '-h') {
        process.stdout.write(SYNC_RUN_USAGE)
        return 0
      }
      flags[a] = a
    } else if (a.startsWith('-')) {
      return usageFail(`未知参数：${a}。可用：--full --since --until --quiet --db --profile --backend`)
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
  let creds
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

  // —— store 打开（rw 单写者）——
  let resolved
  try {
    resolved = resolveStoreConfig({
      flags: { db: flags['--db'], profile: flags['--profile'], backend: flags['--backend'] },
      env: { QIYU_DB_PATH: process.env.QIYU_DB_PATH, QIYU_STORE_BACKEND: process.env.QIYU_STORE_BACKEND, QIYU_PROFILE: process.env.QIYU_PROFILE },
    })
  } catch (e) { return usageFail((e as Error).message) }
  let store: Store
  try {
    store = await openStore(resolved.config, 'rw')
    await store.init()
  } catch (e) { return storeInitFail(e) }

  try {
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
    const robotIds = Array.isArray(rawIds)
      ? rawIds.map((x) => Number(x)).filter((x) => Number.isInteger(x) && x > 0)
      : []
    if (rawIds !== undefined && !Array.isArray(rawIds)) {
      return usageFail('配置文件 store.options.knowledgeRobotIds 必须是数字数组')
    }

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
      tasksOut.push(taskOut(r, st.watermark, st.lastSyncedAt))
    }
    // 全失败判定（T13 fix 中-1）：引擎对 windowed 全窗失败权威产出 partial（'failed'
    // 只留给快照 gate 拦截路径）——「全失败」必须补判窗口级：succeeded=0 且 failed>0
    // 的任务与 status='failed' 并列计入退出码 1。
    const allFailed = results.every((r) =>
      r.status === 'failed' || (r.windows.succeeded === 0 && r.windows.failed > 0))
    const code = ok({ tasks: tasksOut, truncated: false })
    // stderr 汇总（spec §二：核对不符等在 run 结束的 stderr 汇总中列出）
    if (flags['--quiet'] === undefined) {
      for (const r of results) {
        if (r.gaps.length > 0) {
          process.stderr.write(`[${r.taskId}] ${r.gaps.length} 个缺口：` +
            r.gaps.map((g) => g.reason).join('、') + '\n')
        }
      }
    }
    return allFailed ? 1 : code
  } catch (e) {
    return thrownToExit(e)
  } finally {
    await store.close()
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

进度走 stderr；stdout 是 {tasks:[…], truncated:false}。
部分成功退出码 0；全部失败 1；用法错误 2。中断在事务边界安全（kill 后续跑）。
`
