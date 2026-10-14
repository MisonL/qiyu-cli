// src/sync/state.ts
// D-T3：水位与缺口的状态层 —— 红线 3 的落点。
// 写函数只接受 WriteTx（由引擎放进同一 transaction 闭包，同事务原子提交）；
// 读函数只接受 Store。SQL 全部为代码内常量（同 query 红线）——
// 本文件的常量 SELECT 调用点共 3 处，不在 duckdb.ts 的 9 处基线计数内。
import type { Store, WriteTx } from '../store/types.js'

export type RangeStatus = 'pending' | 'complete' | null

export interface WatermarkState {
  watermark: string | null
  rangeStatus: RangeStatus
  lastSyncedAt: string | null
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
  const r = await store.query('SELECT watermark, range_status, last_synced_at FROM sync_state WHERE dataset = ?', [dataset])
  const row = r.rows[0]
  if (!row) return { watermark: null, rangeStatus: null, lastSyncedAt: null }
  return {
    watermark: (row.watermark as string | null) ?? null,
    rangeStatus: (row.range_status as RangeStatus) ?? null,
    lastSyncedAt: (row.last_synced_at as string | null) ?? null,
  }
}

/** sync_state 行的完整列集（Store.upsert 契约：每行必须完整列集）。 */
function stateRow(dataset: string, watermark: string | null, rangeStatus: RangeStatus,
  lastError: string | null, lockedBy: string | null, lockedAt: string | null, lastSyncedAt: string | null) {
  return { dataset, watermark, range_status: rangeStatus, last_error: lastError, locked_by: lockedBy, locked_at: lockedAt, last_synced_at: lastSyncedAt }
}

/** 标记该 dataset 待同步（新一轮窗口开始）。 */
export async function markPending(tx: WriteTx, dataset: string): Promise<void> {
  await tx.upsert('sync_state', [stateRow(dataset, null, 'pending', null, null, null, null)])
}

/**
 * 推进水位：写 watermark、range_status=complete 与同步时间。
 * range（引擎侧窗口，string 键）由引擎在调用前自行 stringify 落水位值本身；
 * 状态层只负责水位与 syncedAt 的持久化形态。
 */
export async function advanceWatermark(tx: WriteTx, dataset: string, watermark: string,
  range: { start: string | number; end: string | number }, syncedAt: string): Promise<void> {
  void range
  await tx.upsert('sync_state', [stateRow(dataset, watermark, 'complete', null, null, null, syncedAt)])
}

/** 记录/覆盖一条缺口（同 dataset+range_start 靠主键幂等覆盖）。 */
export async function recordGap(tx: WriteTx, dataset: string, rangeStart: string,
  rangeEnd: string, reason: string, detail: string): Promise<void> {
  const recordedAt = new Date().toISOString()
  await tx.upsert('sync_gaps', [{ dataset, range_start: rangeStart, range_end: rangeEnd, reason, recorded_at: recordedAt, detail }])
}

/** 清除指定起点的缺口。 */
export async function clearGap(tx: WriteTx, dataset: string, rangeStart: string): Promise<void> {
  await tx.delete('sync_gaps', 'dataset = ? AND range_start = ?', [dataset, rangeStart])
}

/** 列出缺口；传 dataset 则只列该 dataset，按 dataset+range_start 排序。 */
export async function listGaps(store: Store, dataset?: string): Promise<GapRow[]> {
  // 常量 SQL 调用点 2-3/3
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
