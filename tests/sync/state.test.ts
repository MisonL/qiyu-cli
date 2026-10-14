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
  listGaps,
} from '../../src/sync/state.js'
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
    await store.transaction(async (tx) => { await markPending(tx, 'd') })
    const s = await readWatermark(store, 'd')
    expect(s.watermark).toBeNull()
    expect(s.rangeStatus).toBe('pending')
    expect(s.lastSyncedAt).toBeNull()
    await store.close()
  })

  it('不存在的 dataset 返回全空状态', async () => {
    const store = await fresh()
    const s = await readWatermark(store, 'nope')
    expect(s).toEqual({ watermark: null, rangeStatus: null, lastSyncedAt: null })
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
