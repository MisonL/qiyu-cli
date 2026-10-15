// src/sync/state.ts
// D-T3：水位与缺口的状态层 —— 红线 3 的落点。
// 写函数只接受 WriteTx（由引擎放进同一 transaction 闭包，同事务原子提交）；
// 读函数只接受 Store。SQL 全部为代码内常量（同 query 红线）——
// 本文件的常量 SELECT 调用点共 4 处，不在 duckdb.ts 的 9 处基线计数内。
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
  // D-T4 起 sync_state 共 9 列：next_allowed_at / last_rate_limited_at 属限频闸门
  //（src/sync/rate-gate.ts）专用，水位行恒为 null。
  return { dataset, watermark, range_status: rangeStatus, last_error: lastError, locked_by: lockedBy, locked_at: lockedAt, last_synced_at: lastSyncedAt, next_allowed_at: null, last_rate_limited_at: null }
}

/**
 * 标记该 dataset 待同步（新一轮窗口开始）。
 * ⚠️ 只翻状态、不动水位：`existing` 由调用方先经 readWatermark 读出传入
 *（WriteTx 无 query——防线分层，读改写的「读」在事务外完成），markPending
 * 保留其 watermark —— 清成 null 会让中断后重跑从 0 全量拉（API 成本巨大）。
 * existing 缺省/null 或全空（无既有行）时水位为 null（首跑）。
 */
export async function markPending(tx: WriteTx, dataset: string,
  existing?: WatermarkState | null): Promise<void> {
  const hasRow = existing !== null && existing !== undefined
    && !(existing.watermark === null && existing.rangeStatus === null && existing.lastSyncedAt === null)
  if (!hasRow) {
    await tx.upsert('sync_state', [stateRow(dataset, null, 'pending', null, null, null, null)])
    return
  }
  await tx.upsert('sync_state', [stateRow(dataset, existing.watermark, 'pending', null, null, null, existing.lastSyncedAt)])
}

/**
 * 推进水位：写 watermark、range_status=complete 与同步时间。
 * @param range 预留参数，当前不落库；水位值由调用方 stringify 后经 watermark 传入。
 */
export async function advanceWatermark(tx: WriteTx, dataset: string, watermark: string,
  range: { start: string | number; end: string | number }, syncedAt: string): Promise<void> {
  void range
  await tx.upsert('sync_state', [stateRow(dataset, watermark, 'complete', null, null, null, syncedAt)])
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
export interface StateRow extends WatermarkState {
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
    'SELECT dataset, watermark, range_status, last_synced_at, locked_by, locked_at FROM sync_state')
  const out = new Map<string, StateRow>()
  for (const row of r.rows) {
    out.set(row.dataset as string, {
      dataset: row.dataset as string,
      watermark: (row.watermark as string | null) ?? null,
      rangeStatus: (row.range_status as RangeStatus) ?? null,
      lastSyncedAt: (row.last_synced_at as string | null) ?? null,
      lockedBy: (row.locked_by as string | null) ?? null,
      lockedAt: (row.locked_at as string | null) ?? null,
    })
  }
  return out
}
