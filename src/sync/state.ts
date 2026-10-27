// src/sync/state.ts
// D-T3：水位与缺口的状态层 —— 红线 3 的落点。
// 写函数只接受 WriteTx（由引擎放进同一 transaction 闭包，同事务原子提交）；
// 读函数只接受 Store。SQL 全部为代码内常量（同 query 红线）——
// 本文件的常量 SELECT 调用点共 4 处，不在 duckdb.ts 的 9 处基线计数内。
import type { Store, WriteTx } from '../store/types.js'

/**
 * `sync_state.range_status` 的取值（闭集；`null` = 从未运行过）。
 *
 * ⚠️ 运行时数组 + `typeof ARR[number]` 而不是裸联合类型：这是**输出数据里的机器值**
 * （`sync status` 的 `range_status`），Agent 要按它分支。值域必须能在运行时导出，
 * `meta.field_notes` 的图例与测试才能双向核对「枚举 ⊆ 图例、图例 ⊆ 枚举」。
 *
 * ⚠️⚠️ **`complete` 的真实语义不是「全窗口成功」**（设计稿 §6.1 的原话），而是
 * 「水位推进过」——引擎在**每个成功窗**的同一事务里调 `advanceWatermark`，它无条件写
 * `complete`。2026-10-27 实测（3 窗、中窗失败）：run 报 `status: partial`、
 * `windows: {succeeded: 2, failed: 1}`，而 `range_status` 仍是 `complete`。
 * 所以 `complete` **不能**用来判定「这段数据完整」；缺口要看 `gaps` / `sync_gaps`。
 *
 * 反过来 `pending` 也**不代表「一行都没写」**：首窗失败时 `contiguousEnd` 为 null，
 * 后续成功窗的 `commitWindow` 拿到的 `watermarkRange` 是 null → 不调 `advanceWatermark`，
 * 数据照常落库而状态停在 `markPending` 写的 `pending`。2026-10-27 实测：3 窗中首窗失败、
 * 后两窗成功 → `range_status: pending`、`watermark: null`，但表里**有 2 行数据**。
 * 所以 `pending` 只说明「水位没动过」，不说明「库里没数据」。
 */
export const RANGE_STATUSES = ['pending', 'complete'] as const
export type RangeStatusValue = typeof RANGE_STATUSES[number]
export type RangeStatus = RangeStatusValue | null

export interface WatermarkState extends ResolvedRangeState {
  watermark: string | null
  rangeStatus: RangeStatus
  lastSyncedAt: string | null
}

/**
 * G2 落点（spec §八.2）：sync_state 里「上次成功推进覆盖的区间」（epoch 毫秒字符串）。
 * ⚠️ 与水位同命：markPending / clearLock 必须把已有值**原样回写**（sync_state 是单行
 * 全列 upsert，少写一列就等于把那一列清成 null）—— 否则每一轮新 run 的 markPending
 * 或收尾的 clearLock 都会把上次覆盖区间抹掉，G2 字段永远读不到东西。
 */
export interface ResolvedRangeState {
  resolvedRangeStart: string | null
  resolvedRangeEnd: string | null
}

export interface GapRow {
  dataset: string
  rangeStart: string
  rangeEnd: string | null
  reason: string
  recordedAt: string
  detail: string | null
}

/** 读某 dataset 的水位状态行；不存在时全空。 */
export async function readWatermark(store: Store, dataset: string): Promise<WatermarkState> {
  // 常量 SQL 调用点 1/3
  const r = await store.query(
    'SELECT watermark, range_status, last_synced_at, resolved_range_start, resolved_range_end FROM sync_state WHERE dataset = ?',
    [dataset])
  const row = r.rows[0]
  if (!row) {
    return { watermark: null, rangeStatus: null, lastSyncedAt: null, resolvedRangeStart: null, resolvedRangeEnd: null }
  }
  return {
    watermark: (row.watermark as string | null) ?? null,
    rangeStatus: (row.range_status as RangeStatus) ?? null,
    lastSyncedAt: (row.last_synced_at as string | null) ?? null,
    resolvedRangeStart: (row.resolved_range_start as string | null) ?? null,
    resolvedRangeEnd: (row.resolved_range_end as string | null) ?? null,
  }
}

/** sync_state 行的完整列集（Store.upsert 契约：每行必须完整列集）。 */
function stateRow(dataset: string, watermark: string | null, rangeStatus: RangeStatus,
  lastError: string | null, lockedBy: string | null, lockedAt: string | null, lastSyncedAt: string | null,
  rangeStart: string | null = null, rangeEnd: string | null = null) {
  // D-T4 起 sync_state 共 9 列（+G2 两列 = 11 列）：next_allowed_at / last_rate_limited_at
  // 属限频闸门（src/sync/rate-gate.ts）专用，水位行恒为 null；
  // resolved_range_start/end 只在 advanceWatermark 有值（G2 义务，spec §八.2）。
  return { dataset, watermark, range_status: rangeStatus, last_error: lastError, locked_by: lockedBy, locked_at: lockedAt, last_synced_at: lastSyncedAt, next_allowed_at: null, last_rate_limited_at: null, resolved_range_start: rangeStart, resolved_range_end: rangeEnd }
}

/**
 * 标记该 dataset 待同步（新一轮窗口开始）。
 * ⚠️ 只翻状态、不动水位：`existing` 由调用方先经 readWatermark 读出传入
 *（WriteTx 无 query——防线分层，读改写的「读」在事务外完成），markPending
 * 保留其 watermark —— 清成 null 会让中断后重跑从 0 全量拉（API 成本巨大）。
 * existing 缺省/null 或全空（无既有行）时水位为 null（首跑）。
 *
 * `lock`（E 中-1 引擎侧）：本轮写者盖章 —— 与 markPending 同一行同一事务写入，
 * 两者都写 sync_state 同一主键，分开写会互相清掉对方的列（先写锁再置 pending 会
 * 清锁，先置 pending 再写锁会把 pending 覆回旧状态）。
 */
export async function markPending(tx: WriteTx, dataset: string,
  existing?: WatermarkState | null, lock?: { by: string; at: string }): Promise<void> {
  const lockedBy = lock?.by ?? null
  const lockedAt = lock?.at ?? null
  const hasRow = existing !== null && existing !== undefined
    && !(existing.watermark === null && existing.rangeStatus === null && existing.lastSyncedAt === null)
  if (!hasRow) {
    await tx.upsert('sync_state', [stateRow(dataset, null, 'pending', null, lockedBy, lockedAt, null)])
    return
  }
  await tx.upsert('sync_state', [stateRow(dataset, existing.watermark, 'pending', null,
    lockedBy, lockedAt, existing.lastSyncedAt,
    existing.resolvedRangeStart ?? null, existing.resolvedRangeEnd ?? null)])
}

/**
 * 推进水位：写 watermark、range_status=complete、同步时间**与覆盖区间**（G2 义务）。
 * @param range 本次成功推进覆盖的区间（引擎传入本窗 `w` 或快照的 resolvedRange）——
 * 落 sync_state.resolved_range_start/end（epoch 毫秒字符串，`sync status` 的
 * resolved_range 输出即由此格式化而来，spec §八.2/§十一.17）。
 * 水位值由调用方 stringify 后经 watermark 传入。
 * lock（E 中-1）：本轮写者盖章原样保留 —— 水位行与锁列同在 sync_state 同一主键行上，
 * 引擎在 markPending 盖的章不能在推进水位时被抹掉（引擎把同一个 lock 对象传两处）。
 */
export async function advanceWatermark(tx: WriteTx, dataset: string, watermark: string,
  range: { start: string | number; end: string | number }, syncedAt: string,
  lock?: { by: string; at: string }): Promise<void> {
  await tx.upsert('sync_state', [stateRow(dataset, watermark, 'complete', null,
    lock?.by ?? null, lock?.at ?? null, syncedAt,
    String(range.start), String(range.end))])
}

/**
 * 清空该 dataset 的写者锁（E 中-1 引擎侧）。`existing` 由调用方在事务外读出：
 * **锁列之外的列按 existing 回写** —— 清章绝不顺带丢掉水位或区间状态
 *（sync_state 是单行全列 upsert，少写一列就等于把那一列清成 null）。
 * G2：resolved_range_start/end 同属「锁列之外的列」，必须一并保形回写。
 */
export async function clearLock(tx: WriteTx, dataset: string,
  existing: WatermarkState | null): Promise<void> {
  await tx.upsert('sync_state', [stateRow(dataset,
    existing?.watermark ?? null, existing?.rangeStatus ?? null, null,
    null, null, existing?.lastSyncedAt ?? null,
    existing?.resolvedRangeStart ?? null, existing?.resolvedRangeEnd ?? null)])
}

/** 记录/覆盖一条缺口（同 dataset+range_start 靠主键幂等覆盖）。 */
export async function recordGap(tx: WriteTx, dataset: string, rangeStart: string,
  rangeEnd: string, reason: string, detail: string,
  opts: { now?: () => number } = {}): Promise<void> {
  // 时钟注入（T5 修复轮 低-4）：引擎传 ctx.clock，测试可确定性断言；缺省真实时间。
  const recordedAt = new Date(opts.now?.() ?? Date.now()).toISOString()
  await tx.upsert('sync_gaps', [{ dataset, range_start: rangeStart, range_end: rangeEnd, reason, recorded_at: recordedAt, detail }])
}

/** 清除指定起点的缺口。 */
export async function clearGap(tx: WriteTx, dataset: string, rangeStart: string): Promise<void> {
  await tx.delete('sync_gaps', 'dataset = ? AND range_start = ?', [dataset, rangeStart])
}

/** 列出缺口；传 dataset 则只列该 dataset，按 dataset+range_start 排序。 */
export async function listGaps(store: Store, dataset?: string): Promise<GapRow[]> {
  // 常量 SQL 调用点 2-3/4
  const sql = dataset === undefined
    ? 'SELECT dataset, range_start, range_end, reason, recorded_at, detail FROM sync_gaps ORDER BY dataset, range_start'
    : 'SELECT dataset, range_start, range_end, reason, recorded_at, detail FROM sync_gaps WHERE dataset = ? ORDER BY dataset, range_start'
  const r = await store.query(sql, dataset === undefined ? [] : [dataset])
  return r.rows.map((row) => ({
    dataset: row.dataset as string,
    rangeStart: row.range_start as string,
    rangeEnd: (row.range_end as string | null) ?? null,
    reason: row.reason as string,
    recordedAt: row.recorded_at as string,
    detail: (row.detail as string | null) ?? null,
  }))
}

/** sync_state 全量行（含锁列）：sync status / verify / install 前置探测的批量读视图。 */
export interface StateRow extends WatermarkState, ResolvedRangeState {
  dataset: string
  lockedBy: string | null
  lockedAt: string | null
}

/**
 * 读全部 sync_state 行，按 dataset 键控（含 `__ratelimit__:` 冷却行——调用方按前缀
 * 自行排除）。status/verify/install 一次查询取代 N 次 readWatermark（21 任务）。
 */
export async function listWatermarks(store: Store): Promise<Map<string, StateRow>> {
  // 常量 SQL 调用点 4/4
  const r = await store.query(
    'SELECT dataset, watermark, range_status, last_synced_at, locked_by, locked_at, resolved_range_start, resolved_range_end FROM sync_state')
  const out = new Map<string, StateRow>()
  for (const row of r.rows) {
    out.set(row.dataset as string, {
      dataset: row.dataset as string,
      watermark: (row.watermark as string | null) ?? null,
      rangeStatus: (row.range_status as RangeStatus) ?? null,
      lastSyncedAt: (row.last_synced_at as string | null) ?? null,
      lockedBy: (row.locked_by as string | null) ?? null,
      lockedAt: (row.locked_at as string | null) ?? null,
      resolvedRangeStart: (row.resolved_range_start as string | null) ?? null,
      resolvedRangeEnd: (row.resolved_range_end as string | null) ?? null,
    })
  }
  return out
}
