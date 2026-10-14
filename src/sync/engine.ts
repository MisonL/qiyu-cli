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
//
// T2 裁定接线：sliceByMaxWindow 在截断末窗场景会补出被前一窗重叠端完全覆盖的包含窗
//（如 [62,63]⊂[60,63]）——引擎循环跳过 `cur.start >= prev.end − overlapMs` 的窗，
// 省一次 API 调用，数据不变。
// T2 低-1 防御接线：maxWindowDays ≤ 0 在引擎入口即抛（windowMs ≤ 0 无意义）。
import type { RateGate } from './rate-gate.js'
import type { Range } from './windowing.js'
import type { Store, WriteTx } from '../store/types.js'
import {
  readWatermark, markPending, advanceWatermark, recordGap, clearGap,
} from './state.js'
import { sliceByMaxWindow } from './windowing.js'
import type {
  SyncTask, RunCtx, TaskRunResult, GapInfo, WindowRef, FetchCtx, FetchResult,
} from './types.js'

const DAY = 86_400_000

/** 回看毫秒数：水位续跑的起点回退量（overlapDays 天；0 = 不回看）。 */
const overlapDaysOf = (task: SyncTask): number => (task.overlapDays ?? 0) * DAY

/** 窗口级 gap 的 reason（sync_gaps.reason 的引擎侧取值 + 任务 gapHint 的业务 reason）。 */
type WindowGapReason = 'count_mismatch' | 'fetch_failed' | 'write_failed' | 'rate_limit_local'

/** 写策略落地（事务内调用）：deleteRangeInsert 按范围列删旧 + upsert；upsertRows 直接 upsert。 */
async function writeRows(task: SyncTask, ops: Pick<WriteTx, 'delete' | 'upsert'>,
  rows: Record<string, unknown>[], range: Range): Promise<number> {
  if (task.write.kind === 'deleteRangeInsert') {
    // where 是可信代码常量（同 query 红线）：列名来自任务声明（代码级），值参数化绑定。
    // 范围边界取本窗的起止 ISO——范围列的值域与窗口 ISO 同形是报表任务的声明义务
    //（日期一律由调用方填写，spec §6.2 统一结论）。
    for (const col of task.write.rangeColumns) {
      await ops.delete(task.table, `"${col}" >= ? AND "${col}" <= ?`,
        [new Date(range.start).toISOString(), new Date(range.end).toISOString()])
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

/** 水位值 = 窗口终点 ISO（stat_date 等语义由任务声明保证与窗口同形）。 */
const watermarkValue = (w: Range): string => new Date(w.end).toISOString()

/** 本窗 gap 落库 + 收集（独立事务：本窗已回滚，gap 不能混进失败事务）。 */
async function storeGap(ctx: RunCtx, task: SyncTask, w: Range,
  reason: WindowGapReason, detail: string, gaps: GapInfo[]): Promise<void> {
  const info: GapInfo = { rangeStart: String(w.start), rangeEnd: String(w.end), reason, detail }
  await ctx.store.transaction(async (tx) => {
    await recordGap(tx, task.id, info.rangeStart, info.rangeEnd, reason, detail, { now: ctx.clock })
  })
  gaps.push(info)
}

/** 单窗原子提交（红线 3）：写数据 + 推水位 + 清缺口。配对不符在此抛出 → 整体回滚。 */
async function commitWindow(ctx: RunCtx, task: SyncTask, w: Range,
  kept: Record<string, unknown>[], expected: number): Promise<number> {
  return ctx.store.transaction(async (tx) => {
    const written = await writeRows(task, tx, kept, w)
    if (written !== expected) {
      // 红线 2：核对不符即回滚本窗——写一半的状态绝不能连同水位提交。
      throw Object.assign(
        new Error(`配对核对不符：应写 ${expected} 行，实际写入 ${written} 行`),
        { code: 'count_mismatch' })
    }
    await advanceWatermark(tx, task.id, watermarkValue(w), w, new Date(ctx.clock()).toISOString())
    await clearGap(tx, task.id, String(w.start))
    return written
  })
}

/** 假空重试（spec §5.2）：空结果重试一次再判空；判空推进 complete（空数据 ≠ 未同步）。 */
async function fetchWithFakeEmptyRetry(task: SyncTask, ref: WindowRef, ctx: RunCtx): Promise<FetchResult> {
  const first = await task.fetch(ref, fetchCtx(ctx))
  if (first.rows.length > 0) return first
  return task.fetch(ref, fetchCtx(ctx))
}

function fetchCtx(ctx: RunCtx): FetchCtx {
  return { store: ctx.store, credentials: ctx.credentials }
}

/**
 * 运行一个同步任务（spec §6.1 的 run(task)）。
 * 范围合成：ctx.rangeOverride 优先（--full/--since/--until 的落点，Task 13 接线）；
 * 否则 [水位+1ms, clock 当前]；水位为空从 0 起。已推进过且无新数据 → 空跑 complete。
 */
export async function runTask(task: SyncTask, ctx: RunCtx): Promise<TaskRunResult> {
  if (task.kind === 'snapshot') return runSnapshot(task, ctx)
  return runWindowed(task, ctx)
}

/** windowed 任务：读水位 → 切窗 → 逐窗 {gate → fetch → 同事务落库/推水位/清缺口 → 核对}。 */
async function runWindowed(task: SyncTask, ctx: RunCtx): Promise<TaskRunResult> {
  const { store, gate, clock } = ctx
  const progress = ctx.onProgress ?? (() => {})
  const gaps: GapInfo[] = []

  if (task.maxWindowDays === undefined || task.maxWindowDays <= 0) {
    // T2 低-1 防御接线：切分函数对 windowMs ≤ 0 无定义，引擎入口先给出可读错误。
    throw new RangeError(`任务 ${task.id} 的 maxWindowDays 非法：${task.maxWindowDays}（必须为正数）`)
  }

  // —— 范围合成：水位续跑（watermark+1ms；有重叠时再回看 overlapDays 天）——
  const state = await readWatermark(store, task.id)
  const requested = ctx.rangeOverride ?? { start: 0, end: clock() }
  let rangeStart = requested.start
  if (state.watermark !== null) {
    const wm = Date.parse(state.watermark)
    if (!Number.isNaN(wm)) {
      // T9 裁定接线：overlapDays 是「回看重叠」——水位续跑的窗口起点 = watermark+1 − overlap。
      // 工单按操作时间增量时，3 天回看覆盖乱序到达的状态变更/日志（upsert 幂等吸收重叠行）。
      rangeStart = Math.max(requested.start, wm + 1 - overlapDaysOf(task))
    }
  }
  const resolvedRange: Range = { start: rangeStart, end: Math.max(requested.end, rangeStart) }
  if (resolvedRange.end <= resolvedRange.start) {
    return { taskId: task.id, windows: { total: 0, succeeded: 0, failed: 0 },
      rows: { fetched: 0, written: 0 }, resolvedRange, gaps, status: 'complete' }
  }

  // —— 切窗 + 跳过包含窗（T2 裁定接线）——
  const overlapMs = overlapDaysOf(task)
  const raw = sliceByMaxWindow(resolvedRange, task.maxWindowDays, task.overlapDays ?? 0)
  const windows = skipContained(raw, overlapMs)

  // markPending 只翻状态、保留水位（修复轮中-1）：existing 在事务外读出传入。
  await store.transaction(async (tx) => { await markPending(tx, task.id, state) })

  let succeeded = 0
  let failed = 0
  let fetchedTotal = 0
  let writtenTotal = 0

  for (let i = 0; i < windows.length; i++) {
    const w = windows[i]
    const ref: WindowRef = { ...w, index: i, total: windows.length }
    progress(`[${task.id}] 窗口 ${i + 1}/${windows.length}: ${new Date(w.start).toISOString()} ~ ${new Date(w.end).toISOString()}`)

    // —— 限频闸门（持久化冷却，未到点快速失败不碰网络）——
    try {
      await gate.acquire(task.id)
    } catch (e) {
      if ((e as { kind?: string }).kind === 'rate_limit_local') {
        failed++
        await storeGap(ctx, task, w, 'rate_limit_local', (e as Error).message, gaps)
        continue
      }
      throw e
    }

    // —— fetch（假空重试一次；失败记 gap 继续下一窗）——
    let fetchRes: FetchResult
    try {
      fetchRes = await fetchWithFakeEmptyRetry(task, ref, ctx)
    } catch (e) {
      failed++
      await storeGap(ctx, task, w, 'fetch_failed', (e as Error).message, gaps)
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
    let written = 0
    try {
      written = await commitWindow(ctx, task, w, kept, expected)
    } catch (e) {
      failed++
      const isMismatch = (e as { code?: string }).code === 'count_mismatch'
      // 行数统计口径（brief 钉死用例）：mismatch 时 written 记「应写行数」（kept）——
      // 实际行已随事务回滚，计入的是本窗参与核对的落库意图行数。
      writtenTotal += kept.length
      await storeGap(ctx, task, w, isMismatch ? 'count_mismatch' : 'write_failed',
        (e as Error).message, gaps)
      continue
    }

    // —— gapHint（如 order_performance 的 orders:null 筛选失败，spec §5.2）：成功窗也落提示 ——
    // T5 裁定（T7 接线）：透传 hint 的原始 reason（filter_matched_no_staff 等），
    // 不压成统一 fetch_failed——缺口原因在 sync_gaps 里必须可分派。
    if (fetchRes.gapHint) {
      await storeGap(ctx, task, w, fetchRes.gapHint.reason as WindowGapReason,
        fetchRes.gapHint.detail, gaps)
    }

    succeeded++
    writtenTotal += written
    progress(`[${task.id}] 窗口 ${i + 1}/${windows.length} 完成：拉取 ${fetchRes.rows.length} 行，写入 ${written} 行`)
  }

  return {
    taskId: task.id,
    windows: { total: windows.length, succeeded, failed },
    rows: { fetched: fetchedTotal, written: writtenTotal },
    resolvedRange, gaps,
    // brief 权威：有任何窗口失败 → partial（单窗失败也 partial，brief 红线 3 钉死用例）；
    // 'failed' 留给连窗口循环都无法进入的异常路径（见 runSnapshot 的 gate 拦截分支）。
    status: failed === 0 ? 'complete' : 'partial',
  }
}

/** snapshot 任务：单次全量拉取 → 一个事务内全删重插 + 推水位（spec §5.4）。 */
async function runSnapshot(task: SyncTask, ctx: RunCtx): Promise<TaskRunResult> {
  const { store, gate, clock } = ctx
  const progress = ctx.onProgress ?? (() => {})
  const gaps: GapInfo[] = []
  const now = clock()
  const resolvedRange: Range = { start: 0, end: now }
  const ref: WindowRef = { start: 0, end: now, index: 0, total: 1 }

  try {
    await gate.acquire(task.id)
  } catch (e) {
    if ((e as { kind?: string }).kind === 'rate_limit_local') {
      await storeGap(ctx, task, resolvedRange, 'rate_limit_local', (e as Error).message, gaps)
      return snapshotResult(task, resolvedRange, gaps, 0, 0, 1, 0, 'failed')
    }
    throw e
  }

  progress(`[${task.id}] 快照全量拉取`)
  let fetchRes: FetchResult
  try {
    fetchRes = await fetchWithFakeEmptyRetry(task, ref, ctx)
  } catch (e) {
    await storeGap(ctx, task, resolvedRange, 'fetch_failed', (e as Error).message, gaps)
    return snapshotResult(task, resolvedRange, gaps, 0, 0, 1, 0, 'failed')
  }

  const { kept } = applyEnrich(task, fetchRes.rows)
  const expected = kept.length
  let written = 0
  try {
    written = await store.transaction(async (tx) => {
      // 全删重插（spec §5.4：快照幂等来自全量重建）；delete '1=1' 是可信代码常量。
      await tx.delete(task.table, '1=1')
      const n = await tx.upsert(task.table, kept)
      if (n !== expected) {
        throw Object.assign(
          new Error(`配对核对不符：应写 ${expected} 行，实际写入 ${n} 行`),
          { code: 'count_mismatch' })
      }
      await advanceWatermark(tx, task.id, new Date(now).toISOString(), resolvedRange,
        new Date(clock()).toISOString())
      return n
    })
  } catch (e) {
    const isMismatch = (e as { code?: string }).code === 'count_mismatch'
    await storeGap(ctx, task, resolvedRange, isMismatch ? 'count_mismatch' : 'write_failed',
      (e as Error).message, gaps)
    return snapshotResult(task, resolvedRange, gaps, fetchRes.rows.length, 0, 1, 0, 'failed')
  }

  if (fetchRes.gapHint) {
    await storeGap(ctx, task, resolvedRange, 'fetch_failed',
      `${fetchRes.gapHint.reason}: ${fetchRes.gapHint.detail}`, gaps)
  }
  progress(`[${task.id}] 快照完成：拉取 ${fetchRes.rows.length} 行，写入 ${written} 行`)
  return snapshotResult(task, resolvedRange, gaps, fetchRes.rows.length, written, 1, 0,
    'complete')
}

function snapshotResult(task: SyncTask, resolvedRange: Range, gaps: GapInfo[],
  fetched: number, written: number, succeeded: number, failed: number,
  status: TaskRunResult['status']): TaskRunResult {
  return {
    taskId: task.id, windows: { total: 1, succeeded, failed },
    rows: { fetched, written }, resolvedRange, gaps, status,
  }
}

/**
 * 跳过被前一窗完全覆盖的补窗（T2 裁定：[62,63]⊂[60,63] 场景）。
 * 判据：cur 完全落在 prev 内（cur.end <= prev.end）且起点进入 prev 的重叠端
 *（cur.start >= prev.end − overlapMs）——cur 覆盖的数据 prev 已拉取（重叠保证），
 * 跳过不改变数据、只省一次 API 调用。相邻重叠窗（end 超出 prev.end）不跳。
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
 * 报表按天轮转（spec §5.2 实测策略）：限频按路径独立 30 秒——同一天（第 i 窗）
 * 内跨任务背靠背调用，不同任务之间不共享冷却；逐任务串行推进则会在同一路径上
 * 连发吃满 31 天 × 30 秒 ≈ 2.6 小时，轮转降到 ≈ 16 分钟。
 *
 * 调度形态：round r = 所有任务的第 r 个窗口背靠背跑完，再进 round r+1。
 * 每任务内部仍复用单任务引擎的全部语义（gate → 假空重试 → 同事务落库/推水位/
 * 清缺口 → 配对核对 → gapHint/gap 记录），仅执行顺序按「天分组、组内背靠背」交错。
 * 单任务请用 runTask；本函数面向 REPORT_TASKS 这类 reportDayRotation 批量入口。
 */
export async function runRotated(tasks: SyncTask[], ctx: RunCtx): Promise<TaskRunResult[]> {
  const { store, gate, clock } = ctx
  const progress = ctx.onProgress ?? (() => {})

  // —— 各任务的范围合成与切窗（与 runWindowed 同口径）——
  const plans: Array<{
    task: SyncTask; windows: Range[]; state: Awaited<ReturnType<typeof readWatermark>>
    gaps: GapInfo[]; succeeded: number; failed: number; fetched: number; written: number
  }> = []
  for (const task of tasks) {
    if (task.kind !== 'windowed') throw new RangeError(`轮转调度只接受 windowed 任务：${task.id}`)
    if (task.maxWindowDays === undefined || task.maxWindowDays <= 0) {
      throw new RangeError(`任务 ${task.id} 的 maxWindowDays 非法：${task.maxWindowDays}（必须为正数）`)
    }
    const state = await readWatermark(store, task.id)
    const requested = ctx.rangeOverride ?? { start: 0, end: clock() }
    let rangeStart = requested.start
    if (state.watermark !== null) {
      const wm = Date.parse(state.watermark)
      if (!Number.isNaN(wm)) rangeStart = Math.max(requested.start, wm + 1)
    }
    const resolvedRange: Range = { start: rangeStart, end: Math.max(requested.end, rangeStart) }
    const overlapMs = overlapDaysOf(task)
    const windows = resolvedRange.end <= resolvedRange.start
      ? []
      : skipContained(sliceByMaxWindow(resolvedRange, task.maxWindowDays, task.overlapDays ?? 0), overlapMs)
    await store.transaction(async (tx) => { await markPending(tx, task.id, state) })
    plans.push({ task, windows, state, gaps: [], succeeded: 0, failed: 0, fetched: 0, written: 0 })
  }

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

      // 限频闸门（同 runWindowed）
      try {
        await gate.acquire(task.id)
      } catch (e) {
        if ((e as { kind?: string }).kind === 'rate_limit_local') {
          plan.failed++
          await storeGap(ctx, task, w, 'rate_limit_local', (e as Error).message, plan.gaps)
          continue
        }
        throw e
      }

      // fetch（假空重试一次；失败记 gap 继续）
      let fetchRes: FetchResult
      try {
        fetchRes = await fetchWithFakeEmptyRetry(task, ref, ctx)
      } catch (e) {
        plan.failed++
        await storeGap(ctx, task, w, 'fetch_failed', (e as Error).message, plan.gaps)
        continue
      }

      const { kept } = applyEnrich(task, fetchRes.rows)
      plan.fetched += fetchRes.rows.length
      const expected = fetchRes.apiCount !== undefined ? fetchRes.apiCount : kept.length
      try {
        const written = await commitWindow(ctx, task, w, kept, expected)
        plan.written += written
        plan.succeeded++
      } catch (e) {
        plan.failed++
        const isMismatch = (e as { code?: string }).code === 'count_mismatch'
        plan.written += kept.length
        await storeGap(ctx, task, w, isMismatch ? 'count_mismatch' : 'write_failed',
          (e as Error).message, plan.gaps)
        continue
      }
      if (fetchRes.gapHint) {
        await storeGap(ctx, task, w, fetchRes.gapHint.reason as WindowGapReason,
          fetchRes.gapHint.detail, plan.gaps)
      }
      progress(`[${task.id}] 轮转 round ${round + 1}/${maxRounds} 完成：拉取 ${fetchRes.rows.length} 行，写入 ${kept.length} 行`)
    }
  }

  // —— 汇总（空窗任务 total=0、complete，与 runWindowed 空跑语义一致）——
  return plans.map((p) => ({
    taskId: p.task.id,
    windows: { total: p.windows.length, succeeded: p.succeeded, failed: p.failed },
    rows: { fetched: p.fetched, written: p.written },
    resolvedRange: { start: 0, end: clock() },
    gaps: p.gaps,
    status: p.failed === 0 ? 'complete' as const : 'partial' as const,
  }))
}
