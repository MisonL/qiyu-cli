// src/sync/engine.ts
// D-T5：引擎核心 —— 窗口循环/配对核对/同事务落库（spec §6.1）。
// 三条红线在这里钉死：
//   红线 2（配对核对）：每窗落库后核对「过滤后应写行数 ↔ 实际写入行数」（apiCount 以
//     enrich 过滤后的应写行数为准——enrich 正当淘汰不算 mismatch，brief 内联裁定），
//     不符 → 本窗回滚 + count_mismatch gap + partial；
//   红线 3（同事务）：每窗的 写数据 + 推水位 + 清缺口 在一个 transaction 闭包内原子提交，
//     任何一步失败整体回滚，水位绝不领先于数据；
//   红线 1（主键业务键）：由任务声明与写策略吸收，引擎不做主键派生。
// 单窗失败记 gap 后继续下一窗（故障隔离）；部分失败 → partial，全失败 → failed。
// 中-2 修复（final 审查）钉进本文件的两条编排语义：
//   ① 限频「慢不是错」：本地冷却未到点不再立即记 gap 放弃本窗 —— 按 retryAfter 等待
//     （ctx.sleep 注入可测）后有界重试本窗；预算耗尽才记 rate_limit_local gap。
//   ② 失败窗不越过：水位只在「连续成功窗序列」上推进 —— 失败窗截断序列后水位冻结
//     在断链前的末端（后续窗照常执行/落库），增量续跑从冻结处回补失败窗，不再永久越过。
//
// 全场景审查（修复批 1）在本文件收敛的语义：
//   · B 中-5 `--since` 优先于水位：给出 rangeOverride（--full/--since/--until）时
//     起点即调用方给的起点，水位不参与抬升 —— 回补语义不被静默缩成一窗；
//   · B 中-3 失败窗有界重试：fetch/落库失败先按固定间隔重试 2 次，超限才记 gap；
//   · B 中-4 写者撞锁重试：所有 store 事务在 store_locked/Conflicting lock 上有界重试；
//   · B 中-6 限频闸门键 = endpoint id（task.endpoint，缺省 task.id），同路径任务共享冷却；
//   · B 低-2 冷却等待封顶（clampGateWait）：坏冷却行算出的天文数字不把同步挂死；
//   · C 高-1 快照成功清 gap；E 高-2 快照失败的 windows 计数与 status 一致；
//   · E 中-1 写者锁：任务开始盖 locked_by/locked_at、结束（含异常）清空。
//
// T2 裁定接线：sliceByMaxWindow 在截断末窗场景会补出被前一窗重叠端完全覆盖的包含窗
//（如 [62,63]⊂[60,63]）——引擎循环跳过 `cur.start >= prev.end − overlapMs` 的窗，
// 省一次 API 调用，数据不变。
// T2 低-1 防御接线：maxWindowDays ≤ 0 在引擎入口即抛（windowMs ≤ 0 无意义）。
import type { Range } from './windowing.js'
import type { Store, WriteTx } from '../store/types.js'
import {
  readWatermark, markPending, advanceWatermark, recordGap, clearGap, clearLock,
} from './state.js'
import type { WatermarkState } from './state.js'
import { sliceByMaxWindow } from './windowing.js'
import { isLockError } from '../store/retry.js'
import { clampGateWait } from './rate-gate.js'
import { shanghaiDayIso, shanghaiDayStart, shanghaiYesterdayStart } from './day.js'
import type {
  SyncTask, RunCtx, TaskRunResult, GapInfo, WindowRef, FetchCtx, FetchResult,
} from './types.js'

const DAY = 86_400_000

/** 回看毫秒数：水位续跑的起点回退量（overlapDays 天；0 = 不回看）。 */
const overlapDaysOf = (task: SyncTask): number => (task.overlapDays ?? 0) * DAY

/** 窗口级 gap 的 reason（sync_gaps.reason 的引擎侧取值 + 任务 gapHint 的业务 reason）。 */
type WindowGapReason = 'count_mismatch' | 'fetch_failed' | 'write_failed' | 'rate_limit_local'

/** 盖在 sync_state.locked_by 上的进程标识（E 中-1：status 的 locked 字段据此为真）。 */
const lockOwner = (): string => `pid ${process.pid}`

/** 引擎自己的「现在」：ctx.now 优先（命令层给任务层固定 clock 时引擎仍可用真实时刻）。 */
const nowOf = (ctx: RunCtx): number => (ctx.now ?? ctx.clock)()

/** 限频闸门的键（B 中-6）：endpoint id 优先，缺省回退任务 id。 */
const gateKeyOf = (task: SyncTask): string => task.endpoint ?? task.id

/**
 * 首跑起点的合理下界（C 中-2）：起点是 0（或负数）时它是「从头开始」的**哨兵**，
 * 不是真实日期 —— 1970 年没有任何数据，而 `ticket.search` 的 `opStart` 还会被服务端
 * **静默钳到「now − 31 天」**（发 start=0 等于把窗口的解释权交给服务端，客户端以为
 * 「从最早开始」，实际拿到的是被改写过的窗口）。任务声明 `windowStartFloorDays` 后，
 * 哨兵起点被抬到 `now − N 天`，抬升结果如实回显在 resolved_range 里（不静默）。
 * 显式给**正数**起点（--since/--until）则原样照发，绝不改写调用方的区间。
 * ⚠️ 请求的 end 早于下界时（如 `--until` 指向 40 天前）**不抬升** —— 那段历史该接口
 * 物理上给不出，抬升会把「请求了拿不到的数据」静默变成「0 窗 complete」；保持哨兵起点
 * 让任务层守卫显式失败（落 gap、可见），绝不静默成功。
 */
function floorRangeStart(task: SyncTask, rangeStart: number, rangeEnd: number,
  nowMs: number): number {
  if (task.windowStartFloorDays === undefined || rangeStart > 0) return rangeStart
  const floor = nowMs - task.windowStartFloorDays * DAY
  return rangeEnd > floor ? floor : rangeStart
}

/**
 * 窗口任务的起点合成（runWindowed 与 planRotation 共用，B 中-5/C 中-2 的统一落点）：
 *   ① 显式区间（--full/--since/--until）优先 —— 水位**不参与**抬升（--since 是「把这段
 *      历史回补一遍」的指令，被水位抬升会静默缩成一窗且输出仍是 complete）；
 *   ② 缺省路径走水位续跑：watermark+1ms − overlapDays 回看（T9 裁定）；
 *   ③ **起点 ≤ 0 是哨兵**（--full 的 start=0、仅 --until 的 start=0、首跑水位为空）→
 *      声明了 windowStartFloorDays 的任务抬到 now − N 天（C 中-2）。该下界属于任务声明
 *      （接口物理上给不出更早的数据），不是对调用方区间的改写；显式正数起点不受影响。
 */
function resolveRangeStart(task: SyncTask, ctx: RunCtx, state: WatermarkState,
  requested: Range, nowMs: number): number {
  let start = requested.start
  if (ctx.rangeOverride === undefined && state.watermark !== null) {
    const wm = Date.parse(state.watermark)
    if (!Number.isNaN(wm)) {
      // T9 裁定接线：overlapDays 是「回看重叠」——水位续跑的窗口起点 = watermark+1 − overlap。
      // 工单按操作时间增量时，3 天回看覆盖乱序到达的状态变更/日志（upsert 幂等吸收重叠行）。
      const raw = wm + 1 - overlapDaysOf(task)
      // 修复批 5 #1（日对齐任务）：续跑起点落到**上海日界**（向下取整到当日 0:00）——
      // 水位所在那一天整体重拉，写出的 stat_date 行才是全天聚合。若按 raw（水位+1ms）
      // 起，首窗是 [水位+1ms, 次日0点) 的半天切片，会把该日的全天行覆盖成半天聚合
      // （「每日概览」语义每天漂移的根因）。显式区间（--since/--until/--full）不走此
      // 分支：调用方给的起点原样照发（B 中-5，见 floorRangeStart）。
      start = Math.max(start, task.windowAlign === 'shanghaiDay' ? shanghaiDayStart(raw) : raw)
    }
  }
  return floorRangeStart(task, start, requested.end, nowMs)
}

/**
 * gap detail 的中文包装（C 低-2）：gap 要进 stdout 与持久层（sync_gaps），
 * 而失败原因可能是任意来源 —— `fetch failed`、DuckDB 的英文原文、上游报文片段。
 * 沿 store 层 thrownToExit 的形态：中文前缀说明「这是什么失败」，底层原文照附。
 * ⚠️ 引擎自己抛的中文结论（配对核对/本地限频）不包装 —— 再套一层只会变噪音。
 */
function failDetail(label: string, e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return `${label}（底层：${raw}）`
}

/**
 * 写策略落地（事务内调用）：deleteRangeInsert 按范围列删旧 + upsert；upsertRows 直接 upsert。
 * ⚠️ 窗口是**半开** [start, end)，而删除条件是闭区间 —— 天对齐分支的上界必须取
 * `dayIso(end − 1ms)`（窗口内最后一个瞬时所在的自然日），否则 end 恰落在日界
 *（`--until` 指定日期 / windowEndClamp 钳到昨天 0:00 / 日对齐水位都会产生）时
 * `dayIso(end)` = 下一天零点，删除会多删**下一天**的行：`--since D0 --until D2`
 * 的第二窗 end=D2 零点 → 删除范围含 D2 → D2 日已同步的行被删而本轮不重拉（D2 在
 * 请求区间外，永久损失）。`end − 1ms` 后：1 天窗 [D, D+1) → 删除恰好 [D, D]，
 * 31 天考勤窗 [D0, D0+31d) → [D0, D0+30]（= 31 天），与写入行集一致。
 */
async function writeRows(task: SyncTask, ops: Pick<WriteTx, 'delete' | 'upsert'>,
  rows: Record<string, unknown>[], range: Range): Promise<number> {
  if (task.write.kind === 'deleteRangeInsert') {
    const dayAligned = task.write.rangeAlign === 'shanghaiDay'
    const from = dayAligned ? shanghaiDayIso(range.start) : new Date(range.start).toISOString()
    const to = dayAligned ? shanghaiDayIso(range.end - 1) : new Date(range.end).toISOString()
    // where 是可信代码常量（同 query 红线）：列名来自任务声明（代码级），值参数化绑定。
    // 范围边界与行内日期列同口径（rangeAlign）：行写「上海天对齐的日期列」时，删除范围
    // 也必须是天对齐边界——否则 --full 与增量对同一业务日的删除范围互不覆盖（A 中-2）。
    for (const col of task.write.rangeColumns) {
      await ops.delete(task.table, `"${col}" >= ? AND "${col}" <= ?`, [from, to])
    }
  }
  if (rows.length === 0) return 0
  return ops.upsert(task.table, rows)
}

/** enrich 过滤：返回 kept（应写行）与 dropped（正当淘汰行数）。 */
function applyEnrich(task: SyncTask, rows: Record<string, unknown>[]): {
  kept: Record<string, unknown>[]; dropped: number
} {
  if (!task.enrich) return { kept: rows, dropped: 0 }
  const kept: Record<string, unknown>[] = []
  let dropped = 0
  for (const row of rows) {
    const out = task.enrich(row)
    if (out === null) { dropped++; continue }
    kept.push(out)
  }
  return { kept, dropped }
}

/** 引擎层等待（中-2①）：默认真实 setTimeout；ctx.sleep 可注入（测试假时钟）。 */
const engineSleep = (ctx: RunCtx, ms: number): Promise<void> =>
  ctx.sleep !== undefined ? ctx.sleep(ms) : new Promise<void>((r) => setTimeout(r, ms))

/**
 * 有界重试（B 中-3 / B 中-4）：固定间隔、**次数封顶**。次数封顶而非耗时封顶是刻意的 ——
 * 注入时钟可能是冻结的（确定性测试），耗时预算在冻结时钟下永不终止。
 * 首次失败后重试 RETRY_ATTEMPTS 次，仍失败则抛错（调用方记 gap / 上抛）。
 * ⚠️ 只重试「值得重试」的失败（isTransient）：本地参数/形状错误重试必然同结论，
 * 白花两次往返与两段等待。
 */
const RETRY_ATTEMPTS = 2
const RETRY_DELAY_MS = 500

async function withRetries<T>(ctx: RunCtx, op: () => Promise<T>,
  retryable: (e: unknown) => boolean = () => true): Promise<T> {
  let last: unknown
  for (let attempt = 0; ; attempt++) {
    try {
      return await op()
    } catch (e) {
      last = e
      if (attempt >= RETRY_ATTEMPTS || !retryable(e)) break
      await engineSleep(ctx, RETRY_DELAY_MS)
    }
  }
  throw last
}

/**
 * 瞬时失败判据（B 中-3/B 中-4）：以错误自带的 retryable 标记为准。
 * ⚠️ 重试预算的**归属边界**（刻意收窄，避免把等待乘起来）：
 *   · 网络失败（kind=network）**不在此列** —— core `http.call` 已自带 2 次退避重试
 *     （实测 300ms/600ms），引擎再套一层等于 3 倍往返与 3 倍等待，把 core 的预算语义
 *     变成噪声（实测形态：一次「fetch failed」会从 3 次请求变成 9 次）；
 *   · 限频（kind=rate_limit）不在此列 —— 任务层 callPaced 已有自己的等待预算，
 *     引擎层再等一轮只会把冷却乘起来（限频靠冷却解决，不靠重试）；
 *   · 本地参数错误（usage）、配对核对结论（count_mismatch）、任务层自抛的形态漂移
 *     都没有 retryable 标记 → 不重试（重试必然同结论）。
 * 于是引擎重试真正覆盖的是 core 无法归类/无法重试的那一类：撞锁（store_locked）
 * 与任务层显式标注 retryable 的瞬时错误。
 */
function isTransient(e: unknown): boolean {
  const err = e as { kind?: string; retryable?: boolean }
  if (err.kind === 'store_locked') return true
  if (err.kind === 'rate_limit' || err.kind === 'network') return false
  return err.retryable === true
}

/** store 事务的撞锁重试（B 中-4，spec §6.3：C1 写者无内置重试，重试调度归 D 层）。 */
const storeRetryable = (e: unknown): boolean =>
  (e as { kind?: string }).kind === 'store_locked' || isLockError(e)

const withStoreRetries = <T>(ctx: RunCtx, op: () => Promise<T>): Promise<T> =>
  withRetries(ctx, op, storeRetryable)

/** 本窗 gap 落库 + 收集（独立事务：本窗已回滚，gap 不能混进失败事务）。 */
async function storeGap(ctx: RunCtx, task: SyncTask, w: Range,
  reason: WindowGapReason, detail: string, gaps: GapInfo[]): Promise<void> {
  const info: GapInfo = { rangeStart: String(w.start), rangeEnd: String(w.end), reason, detail }
  await withStoreRetries(ctx, () => ctx.store.transaction(async (tx) => {
    await recordGap(tx, task.id, info.rangeStart, info.rangeEnd, reason, detail, { now: ctx.clock })
  }))
  gaps.push(info)
}

/**
 * gapHint → sync_gaps.detail（C-8）：hint 带 `fixture`（会话导出的尾部标记行原文）时
 * 追加标注 —— 「为什么可疑」在 detail 正文、「可疑的那行原文」在其后，同一行可见。
 * 不带 fixture 的 hint（dim 的 staffIdList 形态漂移等）detail 原样落库，行为不变。
 */
function gapHintDetail(hint: { detail: string; fixture?: string }): string {
  return hint.fixture === undefined ? hint.detail : `${hint.detail}（fixture：${hint.fixture}）`
}

/**
 * 限频闸门获取（中-2①「慢不是错」）：冷却中不再立即记 gap 放弃本窗 ——
 * 按 retryAfter 等待（注入 sleep 可测）后重试 acquire，最多 GATE_WAIT_BUDGET 次；
 * 预算耗尽才抛出（调用方记 rate_limit_local gap）。等待是纯时钟推进，不碰网络，
 * 不会超发；预算只封顶「单窗在 gate 上空转的次数」，冷却行坏数据时有限步终止。
 * 等待时长本身也有上限（B 低-2）：冷却行里算出天文数字时按 MAX_GATE_WAIT_MS 封顶，
 * 剩下的交给等待预算终止 —— 宁可多等几轮，也绝不无限等。
 */
const GATE_WAIT_BUDGET = 3
const GATE_WAIT_FALLBACK_MS = 1_000

async function acquireGated(ctx: RunCtx, task: SyncTask): Promise<void> {
  const key = gateKeyOf(task)
  for (let waits = 0; ; waits++) {
    try {
      // 冷却是持久化的：读库也在 store 上，撞锁走同一有界重试（B 中-4）。
      await withStoreRetries(ctx, () => ctx.gate.acquire(key))
      return
    } catch (e) {
      if ((e as { kind?: string }).kind !== 'rate_limit_local' || waits >= GATE_WAIT_BUDGET) throw e
      const wait = clampGateWait((e as { retryAfter?: number }).retryAfter ?? 0) || GATE_WAIT_FALLBACK_MS
      await engineSleep(ctx, wait)
    }
  }
}

/**
 * 单窗原子提交（红线 3）：写数据 + 推水位 + 清缺口。配对不符在此抛出 → 整体回滚。
 * watermarkRange（中-2② + 修复批 4 #2）：事务内 advanceWatermark 的**推进值**（水位）
 * 与**覆盖区间**（resolved_range）的唯一来源 —— 未断链 = 本窗 end；断链后冻结在
 * 连续成功末端（水位绝不越过失败窗）。两者必须同源，否则 `sync status` 会谎报覆盖。
 * null = 断链且本轮尚无任何成功窗 → 不推水位（保持 markPending 的既有状态），
 * 数据与清缺口照常提交 —— 绝不伪造推进点。红线 3 不变：推进仍在数据同一事务内。
 * lock（E 中-1）：写者盖章随成功行保形回写（否则第一窗成功就把章抹了）。
 * ⚠️ resolved_range 的**末端**是「上次成功推进到的时刻」，与删除边界（天对齐下
 * 取 `dayOf(end−1ms)`，见 writeRows）刻意不同：前者是位置、后者是行集覆盖，
 * 混同会让末端出现 −1ms 这种既非水位也非日界的怪值。
 */
async function commitWindow(ctx: RunCtx, task: SyncTask, w: Range,
  kept: Record<string, unknown>[], expected: number, watermarkRange: Range | null,
  lock: { by: string; at: string }): Promise<number> {
  const commit = (): Promise<number> => ctx.store.transaction(async (tx) => {
    const written = await writeRows(task, tx, kept, w)
    if (written !== expected) {
      // 红线 2：核对不符即回滚本窗——写一半的状态绝不能连同水位提交。
      throw Object.assign(
        new Error(`配对核对不符：应写 ${expected} 行，实际写入 ${written} 行`),
        { code: 'count_mismatch' })
    }
    // null = 本轮尚无连续成功窗（首个窗即失败）→ 不推水位（保持 markPending 的既有
    // 状态），只落数据与清缺口 —— 绝不伪造推进点；下次续跑从头重拉，自愈失败窗。
    if (watermarkRange !== null) {
      await advanceWatermark(tx, task.id, new Date(watermarkRange.end).toISOString(), watermarkRange,
        new Date(nowOf(ctx)).toISOString(), lock)
    }
    await clearGap(tx, task.id, String(w.start))
    return written
  })
  return withStoreRetries(ctx, commit)
}

/** 假空重试（spec §5.2）：空结果重试一次再判空；判空推进 complete（空数据 ≠ 未同步）。 */
async function fetchWithFakeEmptyRetry(task: SyncTask, ref: WindowRef, ctx: RunCtx): Promise<FetchResult> {
  const first = await task.fetch(ref, fetchCtx(ctx))
  if (first.rows.length > 0) return first
  return task.fetch(ref, fetchCtx(ctx))
}

function fetchCtx(ctx: RunCtx): FetchCtx {
  // gate/clock 注入（中-1/低-4）：任务层远端限频经持久化闸门写冷却、
  // synchronized_at 盖章走注入时钟（与引擎的确定性测试面同源）。
  return { store: ctx.store, credentials: ctx.credentials, gate: ctx.gate, clock: ctx.clock }
}

/**
 * 窗口末端上限（G 高-1，任务声明式）：`staffAttendance` / `statistic.performance` 的
 * `endTime` 不得晚于今天 00:00（`14501 endTime is invalid`），而「今天 0:00」这条边界
 * 本身不稳定（同一取值时而 200 时而 14501，设计稿 §6.2 实测）→ 统一退到**昨天 00:00**。
 * 返回该任务本轮可拉的末端上限（未声明钳制的任务为 +∞，行为不变）。
 */
function windowEndLimit(task: SyncTask, nowMs: number): number {
  return task.windowEndClamp === 'shanghaiYesterday'
    ? shanghaiYesterdayStart(nowMs)
    : Number.POSITIVE_INFINITY
}

/**
 * 按上限收边切好的窗：越过上限的窗按上限截断，完全落在上限之后的窗直接丢弃
 *（没有可拉的数据）——宁可少拉一天（次日自动补上），也绝不发一个必被 14501 拒的请求。
 */
function clampWindowEnd(windows: Range[], limit: number): Range[] {
  if (!Number.isFinite(limit)) return windows
  const out: Range[] = []
  for (const w of windows) {
    if (w.start >= limit) continue
    out.push(w.end <= limit ? w : { start: w.start, end: limit })
  }
  return out
}

/**
 * 声明了 `windowAlign: 'shanghaiDay'` 的任务的**段式日对齐切片**（修复批 5 #1）：
 * 从 `shanghaiDayStart(range.start)`（上海日 0 点）起按 `maxWindowDays` 天的步长推进，
 * 每段 `[d, d + N天)`；**首段钳 start 到 range.start、末段钳 end 到 range.end**（半开
 * `[start, end)` 语义不变，末段 end 恰为 range.end）——除被钳的首尾边界外，每个窗的
 * start/end 都是上海日界。
 *
 * 与 overlapDays 的关系（刻意不设防但写明）：对齐只决定窗的**边界**，不改变重叠语义
 * ——overlapDays=0 的报表任务每段互不重叠；若将来有 overlapDays > 0 的任务声明此项，
 * 重叠窗同样落在对齐网格上（`skipContained` 的包含窗判据按真实重叠毫秒数算，不受影响）。
 *
 * 与 `sliceByMaxWindow` 的分界：日对齐只对声明了 `windowAlign` 的任务生效（报表 8 任务）；
 * 其余任务（工单 tickets，overlapDays=3、水位 +1ms 任意起点）走原 `sliceByMaxWindow`
 * ——引擎既有任意起点切片结构、3 天回看重叠用例是回归锚。
 */
function sliceShanghaiDayAligned(range: Range, maxWindowDays: number): Range[] {
  const stepMs = maxWindowDays * DAY
  const out: Range[] = []
  // 首段网格起点 = 上海日 0 点（可能早于 range.start 最多 <1 天，但下一行的 max
  // 会把窗 start 钳回 range.start —— 产出的首窗 start 恒等于 range.start）。
  let d = shanghaiDayStart(range.start)
  // 防御（理论不可达：调用方保证 start < end 且 range.start ≥ 0）：首段起点倒挂时
  // 退回 range.start，绝不产出生成死循环的空步进。
  if (d > range.start) d = range.start
  while (d < range.end) {
    const start = Math.max(d, range.start)          // 首段钳到 range.start
    const end = Math.min(d + stepMs, range.end)     // 末段钳到 range.end
    out.push({ start, end })
    d += stepMs
  }
  return out
}

/**
 * 任务感知的切片（runWindowed 与 planRotation 共用，修复批 5 #1 的唯一落点）：
 * 声明了 `windowAlign: 'shanghaiDay'` 的任务走段式日对齐；其余走原 `sliceByMaxWindow`。
 * 两处执行路径必须同函数，否则 rotated 与单任务语义分叉。
 * `maxWindowDays` 由调用方在入口校验后传入（两处都有 T2 低-1 的非法值防御）。
 */
function sliceForTask(task: SyncTask, range: Range, maxWindowDays: number): Range[] {
  return task.windowAlign === 'shanghaiDay'
    ? sliceShanghaiDayAligned(range, maxWindowDays)
    : sliceByMaxWindow(range, maxWindowDays, task.overlapDays ?? 0)
}

/**
 * 残段窗判据（修复批 6 #2）：日对齐任务切出的窗必须**两端都是上海日界**。
 * 不满足者只可能是被显式区间（--since/--until/--full 的 start=0）首末钳制出的
 * 残段（如 `--since 30d` 的 [今天11:15, 次日0点) 与 [昨天0点, 今天11:15)、
 * `--full` 的 [0, 上海1970-01-01 0点) 16 小时段）。
 *
 * 为什么跳过而不是照拉：这些窗里装的是**半日聚合值**，却会写到 `stat_date =
 * dayOf(start)` 的日行上；同一主键 upsert 会覆盖该日已有的（或将来的）整日聚合行 ——
 * 「每日概览」在该日读到半日值。跳过 = 不 fetch、不写库、不删除、不推水位。
 *
 * 水位语义自检：range = [D0 11:15, D5 11:15]，跳过首末残段后成功窗是
 * [D1,D2)…[D4,D5)，水位推进到 D5 0:00（末个整日窗 end）——D5 0:00~11:15 本轮不拉、
 * 下轮从 D5 0:00 续跑（日对齐把续跑起点落回日界）拉 [D5, …) 整日。这正是想要的：
 * 半日聚合不落库，整日值下轮补全。跳过的窗不算成功窗，`contiguousEnd` 不会越过它
 * （它本来就被排除在循环外，连续成功序列只在整日窗上推进）。
 * 非日对齐任务（工单等任意起点切片）恒返回 false —— 行为不变。
 */
function isResidualWindow(task: SyncTask, w: Range): boolean {
  if (task.windowAlign !== 'shanghaiDay') return false
  return w.start !== shanghaiDayStart(w.start) || w.end !== shanghaiDayStart(w.end)
}

/** 残段窗的进度行（人读 stderr；skip 窗仍计入 windows.total / windows.skipped）。 */
const residualNote = (task: SyncTask, w: Range): string =>
  `[${task.id}] 残段窗跳过（非日界首/末段）：[${new Date(w.start).toISOString()}, ${new Date(w.end).toISOString()})`

/**
 * 运行一个同步任务（spec §6.1 的 run(task)）。
 * 范围合成：ctx.rangeOverride 优先（--full/--since/--until 的落点）——**显式区间优先于
 * 水位**（B 中-5：--since 是「把这段历史回补一遍」的指令，被水位抬升会让它静默缩成
 * 一窗且输出仍是 complete）；无 override 时才走水位续跑 [水位+1ms−overlap, clock 当前]，
 * 水位为空从 0 起。已推进过且无新数据 → 空跑 complete。
 * 写者锁（E 中-1）：任务开始盖 locked_by/locked_at，结束（含异常）清空。
 */
export async function runTask(task: SyncTask, ctx: RunCtx): Promise<TaskRunResult> {
  return task.kind === 'snapshot' ? runSnapshot(task, ctx) : runWindowed(task, ctx)
}

/** windowed 任务：读水位 → 切窗 → 逐窗 {gate → fetch → 同事务落库/推水位/清缺口 → 核对}。 */
async function runWindowed(task: SyncTask, ctx: RunCtx): Promise<TaskRunResult> {
  const { store } = ctx
  const progress = ctx.onProgress ?? (() => {})
  const gaps: GapInfo[] = []
  const now = nowOf(ctx)
  const lock = { by: lockOwner(), at: new Date(now).toISOString() }

  if (task.maxWindowDays === undefined || task.maxWindowDays <= 0) {
    // T2 低-1 防御接线：切分函数对 windowMs ≤ 0 无定义，引擎入口先给出可读错误。
    throw new RangeError(`任务 ${task.id} 的 maxWindowDays 非法：${task.maxWindowDays}（必须为正数）`)
  }

  // —— 范围合成：显式区间优先（B 中-5），否则水位续跑（watermark+1ms − overlapDays 回看）——
  const state = await readWatermark(store, task.id)
  const requested = ctx.rangeOverride ?? { start: 0, end: now }
  const rangeStart = resolveRangeStart(task, ctx, state, requested, now)
  const resolvedRange: Range = { start: rangeStart, end: Math.max(requested.end, rangeStart) }
  if (resolvedRange.end <= resolvedRange.start) {
    return { taskId: task.id, windows: { total: 0, succeeded: 0, failed: 0, skipped: 0 },
      rows: { fetched: 0, written: 0 }, resolvedRange, gaps, status: 'complete' }
  }

  // —— 切窗 + 末端钳制 + 跳过包含窗（T2 裁定接线 / G 高-1 / 修复批 5 #1 日对齐）——
  // 日对齐分支（windowAlign='shanghaiDay'）的窗边界全是上海日界：**首窗 start 恒等于
  // rangeStart**（网格起点被 max 钳回，2026-10-17 复审探针 4000 组实测 0 例外）、
  // 末窗 end 恒等于 rangeEnd——对齐只影响**中间**窗的边界。resolved_range.start
  // 仍是水位起点语义（rangeStart），不因对齐回退。
  // 修复批 6 #2：日对齐任务把**残段窗**（非日界首/末段，见 isResidualWindow）排除在
  // 执行集外——runWindowed 与 planRotation 必须同口径（都在切片后过滤）。
  const limit = windowEndLimit(task, now)
  const overlapMs = overlapDaysOf(task)
  const raw = sliceForTask(task, resolvedRange, task.maxWindowDays)
  const clamped = clampWindowEnd(raw, limit)
  const skippedResidual = clamped.filter((w) => isResidualWindow(task, w))
  const windows = skipContained(
    clamped.filter((w) => !isResidualWindow(task, w)), overlapMs)
  // 可拉范围 = 请求范围 ∩ 末端上限：resolved_range 如实回显「这轮实际覆盖到哪」——
  // 回显一个没覆盖到的 end 会让 Agent 以为今天的数据已同步（G 高-1 的静默面）。
  const effectiveRange: Range = { start: rangeStart, end: Math.min(resolvedRange.end, limit) }
  const outRange: Range = { start: rangeStart, end: Math.max(rangeStart, effectiveRange.end) }

  if (windows.length === 0) {
    // 无窗可跑（末端上限之后没有可拉数据，或范围本身为空）：**不置 pending**——
    // 状态保持上一轮结论（complete 就是 complete），绝不因为「今天还没有可拉的数据」
    // 把 range_status 打成 pending（verify 会把 pending 判成未完成）。
    // 修复批 6 #2：全部窗都是残段（如区间落在单个非日界日内）时，跳过窗仍如实计数
    //（total = skipped，succeeded/failed 0）——「什么都没做」与「做完了」在输出里可分。
    // 修复批 7 N-1：本路径没有任何成功窗 → resolved_range 与正常路径
    //（`resolvedEndOut ?? outRange.start`）和轮转汇总（`resolvedEnd ?? start`）同口径，
    // 收在起点，**不回显未覆盖的请求区间**——全残段 run 报「覆盖整段」会让 Agent 以为
    // 该段已同步（与 succeeded:0/skipped:total 自相矛盾）。两条子路径：
    // ① 末端上限之后无可拉数据（rangeStart ≥ limit，批 6 之前唯一可达形态）——outRange
    //   此时本就退化为 [start, start]（min(end, limit) ≤ limit ≤ start），收口前后等值；
    // ② 全残段跳过（批 6 新增）——outRange 非退化，必须收口到起点。
    for (const w of skippedResidual) progress(residualNote(task, w))
    return { taskId: task.id,
      windows: { total: skippedResidual.length, succeeded: 0, failed: 0, skipped: skippedResidual.length },
      rows: { fetched: 0, written: 0 },
      resolvedRange: { start: outRange.start, end: outRange.start }, gaps, status: 'complete' }
  }

  // markPending 只翻状态、保留水位（修复轮中-1）：existing 在事务外读出传入；
  // 同时盖写者锁（E 中-1）——与 pending 同事务，避免两次写互相覆盖列。
  await withStoreRetries(ctx, () => store.transaction(async (tx) => {
    await markPending(tx, task.id, state, lock)
  }))

  try {
    let succeeded = 0
    let failed = 0
    let fetchedTotal = 0
    let writtenTotal = 0
    // —— 水位推进上限（中-2②：失败窗不再被水位永久越过）——
    // contiguousEnd = 最后一个连续成功窗的 end。连续成功序列上每窗成功即推进到本窗
    // 末；一旦出现失败窗（gate 等待超限/fetch/落库），序列断链、水位冻结在断链前
    // 的末端（后续窗仍照常尝试执行、数据仍落库，但水位不越过失败窗）——
    // 增量续跑从冻结处重拉失败窗，gap 可自愈。
    let contiguousEnd: number | null = null
    let contiguousBroken = false
    // resolved_range 的末端（与水位同源，见循环内注释）：逐窗推进；断链时冻结在
    // 连续成功末端（可能为 null = 本轮无任何成功窗 → 回显到连续成功起点为止/未覆盖）。
    let resolvedEndOut: number | null = null
    // 修复批 6 #2：残段窗不进执行循环（上面的过滤已排除），但仍如实计数 ——
    // 裁定：计入 total、标 skipped，每窗一条进度行。「跳过了什么」必须可见，
    // 绝不静默消失；跳过段不算成功窗，contiguousEnd 不受影响（不进循环）。
    const skipped = skippedResidual.length
    for (const w of skippedResidual) progress(residualNote(task, w))

    for (let i = 0; i < windows.length; i++) {
      const w = windows[i]
      const ref: WindowRef = { ...w, index: i, total: windows.length }
      progress(`[${task.id}] 窗口 ${i + 1}/${windows.length}: ${new Date(w.start).toISOString()} ~ ${new Date(w.end).toISOString()}`)

      // —— 限频闸门（持久化冷却；慢不是错：等待后重试本窗，预算耗尽才记 gap）——
      try {
        await acquireGated(ctx, task)
      } catch (e) {
        if ((e as { kind?: string }).kind === 'rate_limit_local') {
          failed++
          contiguousBroken = true
          await storeGap(ctx, task, w, 'rate_limit_local', (e as Error).message, gaps)
          continue
        }
        throw e
      }

      // —— fetch（假空重试一次；失败有界重试后记 gap 继续下一窗）——
      let fetchRes: FetchResult
      try {
        fetchRes = await withRetries(ctx, () => fetchWithFakeEmptyRetry(task, ref, ctx), isTransient)
      } catch (e) {
        failed++
        contiguousBroken = true
        await storeGap(ctx, task, w, 'fetch_failed', failDetail('取数失败', e), gaps)
        continue
      }

      // —— enrich 过滤 + 同事务落库（红线 2/3）——
      // 配对核对基准：fetch 声明的 apiCount（brief 钉死用例的权威口径——enrich 淘汰
      // 计入 fetched 但仍参与核对，written < apiCount 即 count_mismatch）。
      // ⚠️ brief 内联裁决（「apiCount 以过滤后应写行数为准」）与 brief 钉死测试矛盾
      //（测试用 enrich 过滤 mock written<apiCount 并断言 mismatch），按派发约束以测试为权威。
      const { kept } = applyEnrich(task, fetchRes.rows)
      fetchedTotal += fetchRes.rows.length
      const expected = fetchRes.apiCount !== undefined ? fetchRes.apiCount : kept.length
      // —— 推进值与 resolved_range（中-2② + 修复批 4 #2）——
      // 推进值：未断链 = 本窗 end（连续成功序列上前进）；断链后冻结在断链前的连续
      // 成功末端（可能为本轮首窗前 → null → 不推水位）。
      const watermarkMs = contiguousBroken ? contiguousEnd : w.end
      // resolved_range 的**末端**必须与水位同源：断链时水位停在连续成功末端
      // （早于本窗 end），若 resolved_range 仍报本窗末，`sync status` 会谎报覆盖
      // 到失败窗之后 —— 与水位、与实际删除过的区间全都对不上（修复批 4 #2）。
      const watermarkRange: Range | null = watermarkMs === null
        ? null
        : { start: rangeStart, end: watermarkMs }
      let written = 0
      try {
        written = await withRetries(ctx, () => commitWindow(ctx, task, w, kept, expected, watermarkRange, lock),
          isTransient)
      } catch (e) {
        failed++
        contiguousBroken = true
        const isMismatch = (e as { code?: string }).code === 'count_mismatch'
        // 行数统计口径（brief 钉死用例）：mismatch 时 written 记「应写行数」（kept）——
        // 实际行已随事务回滚，计入的是本窗参与核对的落库意图行数。
        writtenTotal += kept.length
        await storeGap(ctx, task, w, isMismatch ? 'count_mismatch' : 'write_failed',
          isMismatch ? (e as Error).message : failDetail('落库失败', e), gaps)
        continue
      }
      resolvedEndOut = watermarkMs
      if (!contiguousBroken) contiguousEnd = w.end

      // —— gapHint（如 order_performance 的 orders:null 筛选失败，spec §5.2）：成功窗也落提示 ——
      // T5 裁定（T7 接线）：透传 hint 的原始 reason（filter_matched_no_staff 等），
      // 不压成统一 fetch_failed——缺口原因在 sync_gaps 里必须可分派。
      if (fetchRes.gapHint) {
        await storeGap(ctx, task, w, fetchRes.gapHint.reason as WindowGapReason,
          gapHintDetail(fetchRes.gapHint), gaps)
      }

      succeeded++
      writtenTotal += written
      progress(`[${task.id}] 窗口 ${i + 1}/${windows.length} 完成：拉取 ${fetchRes.rows.length} 行，写入 ${written} 行`)
    }

    return {
      taskId: task.id,
      windows: { total: windows.length + skipped, succeeded, failed, skipped },
      rows: { fetched: fetchedTotal, written: writtenTotal },
      // 末端与水位同源（见上）：断链时 = 连续成功末端，未断链 = 本窗 end。
      // ⚠️ 末端是「上次成功推进到的时刻」，与删除边界（天对齐下取 dayOf(end−1ms)，
      // 见 writeRows）刻意不同：前者是位置、后者是行集覆盖，混同会让末端出现
      // −1ms 这种既非水位也非日界的怪值。
      resolvedRange: { start: outRange.start, end: resolvedEndOut ?? outRange.start },
      gaps,
      // brief 权威：有任何窗口失败 → partial（单窗失败也 partial，brief 红线 3 钉死用例）；
      // 'failed' 留给连窗口循环都无法进入的异常路径（见 runSnapshot 的 gate 拦截分支）。
      status: failed === 0 ? 'complete' : 'partial',
    }
  } finally {
    // 写者锁清空（E 中-1）：成功、失败、异常三条路径都要清 —— 锁残留会让 status
    // 永远显示「有人在写」。清章只清锁列，水位/状态按最新值回写。
    await releaseLock(ctx, task)
  }
}

/**
 * snapshot 任务的 gap 键：失败路径以 resolvedRange 记 gap，而快照的范围恒为 [0, now]
 * → rangeStart = '0'。成功时清同一把键（C 高-1：此前只记不清，gap 永久留存）。
 */
const SNAPSHOT_GAP_KEY = '0'

/** snapshot 任务：单次全量拉取 → 一个事务内全删重插 + 推水位（spec §5.4）。 */
async function runSnapshot(task: SyncTask, ctx: RunCtx): Promise<TaskRunResult> {
  const { store } = ctx
  const progress = ctx.onProgress ?? (() => {})
  const gaps: GapInfo[] = []
  const now = nowOf(ctx)
  const resolvedRange: Range = { start: 0, end: now }
  const ref: WindowRef = { start: 0, end: now, index: 0, total: 1 }
  const lock = { by: lockOwner(), at: new Date(now).toISOString() }

  try {
    await acquireGated(ctx, task)
  } catch (e) {
    if ((e as { kind?: string }).kind === 'rate_limit_local') {
      // 快照也要留下可查的状态行（E 中-1）：门都没进就放弃时，若库里连一行都没有，
      // 建一行 pending（盖章后立即清章）——「这个任务本轮被本地冷却拦下了」必须可查，
      // 而不是 status 里什么都看不到。
      const pre = await readWatermark(store, task.id)
      if (pre.watermark === null && pre.rangeStatus === null && pre.lastSyncedAt === null) {
        await withStoreRetries(ctx, () => store.transaction(async (tx) => {
          await markPending(tx, task.id, pre, lock)
        }))
        await releaseLock(ctx, task)
      }
      await storeGap(ctx, task, resolvedRange, 'rate_limit_local', (e as Error).message, gaps)
      return snapshotResult(task, resolvedRange, gaps, 0, 0, 0, 1, 'failed')
    }
    throw e
  }

  progress(`[${task.id}] 快照全量拉取`)
  // 快照也要进「pending + 盖章」状态：status 的 locked 与 range_status 才有真实语义
  //（此前快照直到成功才写 sync_state，失败时那一行根本不存在）。
  const state = await readWatermark(store, task.id)
  await withStoreRetries(ctx, () => store.transaction(async (tx) => {
    await markPending(tx, task.id, state, lock)
  }))
  try {
    let fetchRes: FetchResult
    try {
      fetchRes = await withRetries(ctx, () => fetchWithFakeEmptyRetry(task, ref, ctx), isTransient)
    } catch (e) {
      await storeGap(ctx, task, resolvedRange, 'fetch_failed', failDetail('取数失败', e), gaps)
      return snapshotResult(task, resolvedRange, gaps, 0, 0, 0, 1, 'failed')
    }

    const { kept } = applyEnrich(task, fetchRes.rows)
    const expected = kept.length
    let written = 0
    try {
      written = await withStoreRetries(ctx, () => store.transaction(async (tx) => {
        // 全删重插（spec §5.4：快照幂等来自全量重建）；delete '1=1' 是可信代码常量。
        await tx.delete(task.table, '1=1')
        const n = await tx.upsert(task.table, kept)
        if (n !== expected) {
          throw Object.assign(
            new Error(`配对核对不符：应写 ${expected} 行，实际写入 ${n} 行`),
            { code: 'count_mismatch' })
        }
        await advanceWatermark(tx, task.id, new Date(now).toISOString(), resolvedRange,
          new Date(nowOf(ctx)).toISOString(), lock)
        // C 高-1：成功即清本任务快照的 gap（键与失败路径的 rangeStart 同源）。
        await clearGap(tx, task.id, SNAPSHOT_GAP_KEY)
        return n
      }))
    } catch (e) {
      const isMismatch = (e as { code?: string }).code === 'count_mismatch'
      await storeGap(ctx, task, resolvedRange, isMismatch ? 'count_mismatch' : 'write_failed',
        isMismatch ? (e as Error).message : failDetail('落库失败', e), gaps)
      return snapshotResult(task, resolvedRange, gaps, fetchRes.rows.length, 0, 0, 1, 'failed')
    }

    // gapHint（如 dim.staff_group_members 的 staffIdList 形态漂移）：成功快照也落提示。
    // T5 裁定（T7 接线）：透传 hint 的原始 reason，不压成统一 fetch_failed ——
    // 缺口原因在 sync_gaps 里必须可分派（与 runWindowed 的 gapHint 路径同口径）。
    if (fetchRes.gapHint) {
      await storeGap(ctx, task, resolvedRange, fetchRes.gapHint.reason as WindowGapReason,
        gapHintDetail(fetchRes.gapHint), gaps)
    }
    progress(`[${task.id}] 快照完成：拉取 ${fetchRes.rows.length} 行，写入 ${written} 行`)
    return snapshotResult(task, resolvedRange, gaps, fetchRes.rows.length, written, 1, 0,
      'complete')
  } finally {
    await releaseLock(ctx, task)
  }
}

/**
 * 清写者锁（E 中-1）：只清锁列，水位/状态/同步时间按库中最新值回写。
 * 无行（如空范围空跑、或在 markPending 之前就抛错）时不动库 —— 不为清章凭空建一行。
 */
async function releaseLock(ctx: RunCtx, task: SyncTask): Promise<void> {
  const st: WatermarkState = await readWatermark(ctx.store, task.id)
  if (st.watermark === null && st.rangeStatus === null && st.lastSyncedAt === null) return
  await withStoreRetries(ctx, () => ctx.store.transaction(async (tx) => {
    await clearLock(tx, task.id, st)
  }))
}

/** snapshot 结果封装（windows.total 恒 1：快照是一次全量拉取，成功 1 / 失败 1）。 */
function snapshotResult(task: SyncTask, resolvedRange: Range, gaps: GapInfo[],
  fetched: number, written: number, succeeded: number, failed: number,
  status: TaskRunResult['status']): TaskRunResult {
  return {
    taskId: task.id, windows: { total: 1, succeeded, failed, skipped: 0 },
    rows: { fetched, written }, resolvedRange, gaps, status,
  }
}

/**
 * 跳过被前一窗完全覆盖的补窗（T2 裁定：[62,63]⊂[60,63] 场景）。
 * 判据：cur 完全落在 prev 内（cur.end <= prev.end）且起点进入 prev 的重叠端
 *（cur.start >= prev.end − overlapMs）——cur 覆盖的数据 prev 已拉取（重叠保证），
 * 跳过不改变数据、只省一次 API 调用。相邻重叠窗（end 超出 prev.end）不跳过。
 */
function skipContained(windows: Range[], overlapMs: number): Range[] {
  if (windows.length < 2 || overlapMs <= 0) return windows
  const out = [windows[0]]
  for (let i = 1; i < windows.length; i++) {
    const prev = out[out.length - 1]
    const cur = windows[i]
    if (cur.end <= prev.end && cur.start >= prev.end - overlapMs) continue
    out.push(cur)
  }
  return out
}

/**
 * 各任务的窗口计划（runRotated 用）：范围合成与切窗与 runWindowed 同口径
 *（显式区间优先 / 水位置信 / 末端钳制 / 包含窗跳过）。
 */
interface RotationPlan {
  task: SyncTask
  state: WatermarkState
  resolvedRange: Range
  windows: Range[]
  // 修复批 6 #2：残段窗（非日界首/末段）——不执行，但计入 total 并标 skipped。
  skippedResidual: Range[]
  lock: { by: string; at: string }
  gaps: GapInfo[]
  succeeded: number
  failed: number
  fetched: number
  written: number
  // 中-2②（同 runWindowed）：连续成功末端 + 断链标记 —— 失败窗后水位冻结。
  contiguousEnd: number | null
  contiguousBroken: boolean
  // resolved_range 的末端（与水位同源，修复批 4 #2）：本轮已成功推进到的位置。
  resolvedEnd: number | null
}

async function planRotation(task: SyncTask, ctx: RunCtx, now: number): Promise<RotationPlan> {
  if (task.kind !== 'windowed') throw new RangeError(`轮转调度只接受 windowed 任务：${task.id}`)
  if (task.maxWindowDays === undefined || task.maxWindowDays <= 0) {
    throw new RangeError(`任务 ${task.id} 的 maxWindowDays 非法：${task.maxWindowDays}（必须为正数）`)
  }
  const state = await readWatermark(ctx.store, task.id)
  const requested = ctx.rangeOverride ?? { start: 0, end: now }
  const rangeStart = resolveRangeStart(task, ctx, state, requested, now)
  const resolvedRange: Range = { start: rangeStart, end: Math.max(requested.end, rangeStart) }
  const overlapMs = overlapDaysOf(task)
  // 末端钳制与 runWindowed 同口径（G 高-1）：声明了 windowEndClamp 的任务（考勤/绩效
  // 都是轮转任务）在轮转路径上同样不得发出越界 endTime —— 此前这里少传了一个参数
  // （clampWindowEnd 收 (windows, limit)），等于轮转路径完全没有钳制。
  const limit = windowEndLimit(task, now)
  // 残段窗过滤（修复批 6 #2）：与 runWindowed 同口径 —— 切片+钳制后把非日界首/末段
  // 排除在执行集外、收进 skippedResidual（半日聚合不落日行的裁定对轮转路径同样生效）。
  const clamped = resolvedRange.end <= resolvedRange.start
    ? []
    : clampWindowEnd(sliceForTask(task, resolvedRange, task.maxWindowDays), limit)
  const skippedResidual = clamped.filter((w) => isResidualWindow(task, w))
  const windows = skipContained(
    clamped.filter((w) => !isResidualWindow(task, w)), overlapMs)
  const outRange: Range = { start: rangeStart,
    end: Math.max(rangeStart, Math.min(resolvedRange.end, limit)) }
  const lock = { by: lockOwner(), at: new Date(now).toISOString() }
  // 无窗可跑（末端上限之后没有可拉数据 / 范围本身为空）：**不置 pending**（与
  // runWindowed 同口径）——状态保持上一轮结论，绝不把 complete 打成 pending
  //（verify 会把 pending 判成未完成）。
  if (windows.length === 0) {
    for (const w of skippedResidual) ctx.onProgress?.(residualNote(task, w))
    return { task, state, resolvedRange: outRange, windows, skippedResidual, lock, gaps: [],
      succeeded: 0, failed: 0, fetched: 0, written: 0,
      contiguousEnd: null, contiguousBroken: false, resolvedEnd: null }
  }
  for (const w of skippedResidual) ctx.onProgress?.(residualNote(task, w))
  await withStoreRetries(ctx, () => ctx.store.transaction(async (tx) => {
    await markPending(tx, task.id, state, lock)
  }))
  return { task, state, resolvedRange: outRange, windows, skippedResidual, lock, gaps: [],
    succeeded: 0, failed: 0, fetched: 0, written: 0,
    contiguousEnd: null, contiguousBroken: false, resolvedEnd: null }
}

/**
 * 报表按天轮转（spec §5.2 实测策略）：限频按路径独立 30 秒——同一天（第 i 窗）
 * 内跨任务背靠背调用，不同任务之间不共享冷却；逐任务串行推进则会在同一路径上
 * 连发吃满 31 天 × 30 秒 ≈ 2.6 小时，轮转降到 ≈ 16 分钟。
 *
 * 调度形态：round r = 所有任务的第 r 个窗口背靠背跑完，再进 round r+1。
 * 每任务内部仍复用单任务引擎的全部语义（gate → 假空重试 → 同事务落库/推水位/
 * 清缺口 → 配对核对 → gapHint/gap 记录 + 失败窗有界重试 + 水位冻结），
 * 仅执行顺序按「天分组、组内背靠背」交错。单任务请用 runTask；本函数面向
 * REPORT_TASKS 这类 reportDayRotation 批量入口。
 * 写者锁（E 中-1）：每个任务的锁在批次开始时盖上、批次结束（含异常）统一清掉。
 */
export async function runRotated(tasks: SyncTask[], ctx: RunCtx): Promise<TaskRunResult[]> {
  const progress = ctx.onProgress ?? (() => {})
  const now = nowOf(ctx)

  const plans: RotationPlan[] = []
  for (const task of tasks) plans.push(await planRotation(task, ctx, now))

  try {
    const maxRounds = plans.reduce((m, p) => Math.max(m, p.windows.length), 0)

    // —— round r：各任务第 r 窗背靠背 ——
    for (let round = 0; round < maxRounds; round++) {
      for (const plan of plans) {
        const { task } = plan
        const windows = plan.windows
        if (round >= windows.length) continue
        const w = windows[round]
        const ref: WindowRef = { ...w, index: round, total: windows.length }
        progress(`[${task.id}] 轮转 round ${round + 1}/${maxRounds}: ${new Date(w.start).toISOString()} ~ ${new Date(w.end).toISOString()}`)

        // 限频闸门（同 runWindowed：慢不是错，等待后重试，预算耗尽才记 gap）
        try {
          await acquireGated(ctx, task)
        } catch (e) {
          if ((e as { kind?: string }).kind === 'rate_limit_local') {
            plan.failed++
            plan.contiguousBroken = true
            await storeGap(ctx, task, w, 'rate_limit_local', (e as Error).message, plan.gaps)
            continue
          }
          throw e
        }

        // fetch（假空重试一次；失败有界重试后记 gap 继续）
        let fetchRes: FetchResult
        try {
          fetchRes = await withRetries(ctx, () => fetchWithFakeEmptyRetry(task, ref, ctx), isTransient)
        } catch (e) {
          plan.failed++
          plan.contiguousBroken = true
          await storeGap(ctx, task, w, 'fetch_failed', failDetail('取数失败', e), plan.gaps)
          continue
        }

        const { kept } = applyEnrich(task, fetchRes.rows)
        plan.fetched += fetchRes.rows.length
        const expected = fetchRes.apiCount !== undefined ? fetchRes.apiCount : kept.length
        // 推进值（中-2②，同 runWindowed）：未断链 = 本窗 end；断链后冻结在连续成功末端
        //（可能为 null → 不推水位）。区间起点与 runWindowed 同源（plan.resolvedRange.start）。
        const watermarkMs = plan.contiguousBroken ? plan.contiguousEnd : w.end
        const watermarkRange: Range | null = watermarkMs === null
          ? null
          : { start: plan.resolvedRange.start, end: watermarkMs }
        try {
          const written = await withRetries(
            ctx, () => commitWindow(ctx, task, w, kept, expected, watermarkRange, plan.lock), isTransient)
          plan.written += written
          plan.succeeded++
          plan.resolvedEnd = watermarkMs
          if (!plan.contiguousBroken) plan.contiguousEnd = w.end
        } catch (e) {
          plan.failed++
          plan.contiguousBroken = true
          const isMismatch = (e as { code?: string }).code === 'count_mismatch'
          plan.written += kept.length
          await storeGap(ctx, task, w, isMismatch ? 'count_mismatch' : 'write_failed',
            isMismatch ? (e as Error).message : failDetail('落库失败', e), plan.gaps)
          continue
        }
        if (fetchRes.gapHint) {
          await storeGap(ctx, task, w, fetchRes.gapHint.reason as WindowGapReason,
            gapHintDetail(fetchRes.gapHint), plan.gaps)
        }
        progress(`[${task.id}] 轮转 round ${round + 1}/${maxRounds} 完成：拉取 ${fetchRes.rows.length} 行，写入 ${kept.length} 行`)
      }
    }
  } finally {
    // 批次结束（含异常）统一清章：每个任务的锁都由本函数盖上，也必须由本函数清掉。
    for (const plan of plans) await releaseLock(ctx, plan.task)
  }

  // —— 汇总（空窗任务 total=0、complete，与 runWindowed 空跑语义一致）——
  // T13 接线（T7 报告遗留）：resolvedRange 回显各任务的真实合成范围，不再是粗粒度汇总。
  // 末端与水位同源（修复批 4 #2）：断链时 = 连续成功末端（resolvedEnd），未断链 = 请求末。
  // ⚠️ 末端是「上次成功推进到的时刻」，与删除边界（天对齐下取 dayOf(end−1ms)，
  // 见 writeRows）刻意不同：前者是位置、后者是行集覆盖。
  return plans.map((p) => ({
    taskId: p.task.id,
    // 修复批 6 #2：残段窗计入 total、标 skipped（与 runWindowed 同口径）。
    windows: { total: p.windows.length + p.skippedResidual.length,
      succeeded: p.succeeded, failed: p.failed, skipped: p.skippedResidual.length },
    rows: { fetched: p.fetched, written: p.written },
    resolvedRange: { start: p.resolvedRange.start, end: p.resolvedEnd ?? p.resolvedRange.start },
    gaps: p.gaps,
    status: p.failed === 0 ? 'complete' as const : 'partial' as const,
  }))
}
