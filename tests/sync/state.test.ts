import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import {
  readWatermark,
  advanceWatermark,
  markPending,
  recordGap,
  clearGap,
  clearLock,
  listGaps,
} from '../../src/sync/state.js'
import type { WatermarkState } from '../../src/sync/state.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

// L1 对冲：真库冷启动偶发 >5s，统一放宽到 15s。
vi.setConfig({ testTimeout: 15_000 })

let dir = ''
let cfg: StoreConfig
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-sync-state-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30000, batchSize: 1000 }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(cfg, 'rw')
  await s.init()
  return s
}

describe('sync/state —— 水位与缺口', () => {
  it('水位推进与读取往返；pending → complete 状态机', async () => {
    const store = await fresh()
    await store.transaction(async (tx) => {
      await markPending(tx, 'reports.overview')
      await advanceWatermark(tx, 'reports.overview', '2026-10-13', { start: 0, end: 1 }, '2026-10-14T10:00:00+08:00')
    })
    const s = await readWatermark(store, 'reports.overview')
    expect(s.watermark).toBe('2026-10-13')
    expect(s.rangeStatus).toBe('complete')
    expect(s.lastSyncedAt).toBe('2026-10-14T10:00:00+08:00')
    await store.close()
  })

  it('markPending 后未推进时读到 pending 与空水位', async () => {
    const store = await fresh()
    const existing = await readWatermark(store, 'd')
    await store.transaction(async (tx) => { await markPending(tx, 'd', existing) })
    const s = await readWatermark(store, 'd')
    expect(s.watermark).toBeNull()
    expect(s.rangeStatus).toBe('pending')
    expect(s.lastSyncedAt).toBeNull()
    await store.close()
  })

  it('markPending 保留已有水位（中断重跑不退回全量——中-1 钉死）', async () => {
    const store = await fresh()
    // 预置水位：complete @ 2026-10-01
    await store.transaction(async (tx) => {
      await advanceWatermark(tx, 'reports.overview', '2026-10-01', { start: 0, end: 1 }, '2026-10-01T00:00:00Z')
    })
    // 新一轮窗口开始：置 pending —— 水位必须保留，绝不能清成 null（否则重跑从 0 全量拉）
    const existing = await readWatermark(store, 'reports.overview')
    await store.transaction(async (tx) => { await markPending(tx, 'reports.overview', existing) })
    const s = await readWatermark(store, 'reports.overview')
    expect(s.watermark).toBe('2026-10-01')
    expect(s.rangeStatus).toBe('pending')
    expect(s.lastSyncedAt).toBe('2026-10-01T00:00:00Z')
    await store.close()
  })

  it('recordGap 的 recorded_at 取注入时钟（低-4 确定性钉死）', async () => {
    const store = await fresh()
    const fixed = new Date('2026-10-14T08:00:00Z').toISOString()
    await store.transaction(async (tx) => {
      await recordGap(tx, 't', 'a', 'b', 'count_mismatch', 'd', { now: () => Date.parse(fixed) })
    })
    const gaps = await listGaps(store, 't')
    expect(gaps[0].recordedAt).toBe(fixed)
    await store.close()
  })

  it('不存在的 dataset 返回全空状态', async () => {
    const store = await fresh()
    const s = await readWatermark(store, 'nope')
    expect(s).toEqual({ watermark: null, rangeStatus: null, lastSyncedAt: null,
      resolvedRangeStart: null, resolvedRangeEnd: null })
    await store.close()
  })

  it('advanceWatermark 落 G2 区间（resolved_range_start/end）；markPending/clearLock 保形回写', async () => {
    const store = await fresh()
    await store.transaction(async (tx) => {
      await advanceWatermark(tx, 'reports.overview', '2026-10-13',
        { start: 1_700_000_000_000, end: 1_700_086_400_000 }, '2026-10-14T10:00:00+08:00')
    })
    let s = await readWatermark(store, 'reports.overview')
    expect(s.resolvedRangeStart).toBe('1700000000000')
    expect(s.resolvedRangeEnd).toBe('1700086400000')
    // 新一轮 pending：区间必须原样保留（sync_state 单行全列 upsert，少写一列即清空）
    await store.transaction(async (tx) => { await markPending(tx, 'reports.overview', s) })
    s = await readWatermark(store, 'reports.overview')
    expect(s.rangeStatus).toBe('pending')
    expect(s.resolvedRangeStart).toBe('1700000000000')
    // 清写者锁同样不得抹掉区间
    await store.transaction(async (tx) => { await clearLock(tx, 'reports.overview', s) })
    s = await readWatermark(store, 'reports.overview')
    expect(s.resolvedRangeEnd).toBe('1700086400000')
    await store.close()
  })

  it('gap 记录/清除往返（同 range_start 幂等覆盖）', async () => {
    const store = await fresh()
    await store.transaction(async (tx) => {
      await recordGap(tx, 't', 'a', 'b', 'count_mismatch', 'fetched 3 written 2')
      await recordGap(tx, 't', 'a', 'b2', 'window_too_large', 'x')
    })
    expect((await listGaps(store, 't')).length).toBe(1) // 同主键覆盖
    await store.transaction(async (tx) => { await clearGap(tx, 't', 'a') })
    expect((await listGaps(store, 't')).length).toBe(0)
    await store.close()
  })

  it('listGaps 不带 dataset 时返回全部，按 dataset+range_start 排序', async () => {
    const store = await fresh()
    await store.transaction(async (tx) => {
      await recordGap(tx, 'b', '2', '3', 'r1', 'd1')
      await recordGap(tx, 'a', '9', '10', 'r2', 'd2')
      await recordGap(tx, 'a', '1', '2', 'r3', 'd3')
    })
    const all = await listGaps(store)
    expect(all.map((g) => `${g.dataset}/${g.rangeStart}`)).toEqual(['a/1', 'a/9', 'b/2'])
    const onlyA = await listGaps(store, 'a')
    expect(onlyA.map((g) => g.rangeStart)).toEqual(['1', '9'])
    await store.close()
  })
})
