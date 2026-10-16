// tests/sync/engine.test.ts
// D-T5：引擎核心 —— 窗口循环/配对核对/同事务落库（三条红线钉死）。
// fetch/write 全 mock（write 走真库 upsert/delete），不碰网络。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { runTask } from '../../src/sync/engine.js'
import { listGaps, readWatermark } from '../../src/sync/state.js'
import { RateGate } from '../../src/sync/rate-gate.js'
import { shanghaiDayStart, shanghaiDayIso } from '../../src/sync/day.js'
import type { SyncTask, RunCtx } from '../../src/sync/types.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

// L1 对冲：真库冷启动偶发慢（同 tests/store/duckdb.test.ts）。
vi.setConfig({ testTimeout: 15_000 })

const DAY = 86_400_000

let dir = ''
let cfg: StoreConfig
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-engine-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30000, batchSize: 1000 }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 真库夹具：rw 模式打开并 init（迁移跑满）。 */
async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(cfg, 'rw')
  await s.init()
  return s
}

/** 造 store 后的运行上下文（gate 假时钟恒 0；默认小范围避免全历史 600+ 窗）。 */
function ctx(store: Store, over: Partial<RunCtx> = {}): RunCtx {
  return {
    store,
    credentials: { appKey: 'test-key', appSecret: 'test-secret' },
    gate: new RateGate(store, () => 0),
    clock: () => 1_700_000_000_000,
    rangeOverride: over.rangeOverride ?? { start: 0, end: DAY },
    ...over,
  }
}

/** 窗口型假任务：fetch 默认返回预置 rows。 */
function fakeTask(over: Partial<SyncTask> = {}): SyncTask {
  const rows: Record<string, unknown>[] = []
  return {
    id: 'reports.overview', table: 'tags', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0, primaryKey: ['id'],
    watermark: { field: 'stat_date', initial: null },
    fetch: async () => ({ rows, apiCount: rows.length }),
    write: { kind: 'upsertRows' },
    ...over,
  }
}

describe('红线 3：水位与数据同事务', () => {
  it('落库失败 → gap 记录、水位不推进（同事务回滚钉死）', async () => {
    const store = await fresh()
    // tags 表主键 id、列集 id/name/color：行缺列 → upsert 抛 usage → 事务回滚。
    const bad = fakeTask({ table: 'tags', fetch: async () => ({ rows: [{ id: 'x' }], apiCount: 1 }) })
    const r = await runTask(bad, ctx(store))
    expect(r.status).toBe('partial')
    expect((await listGaps(store, bad.id)).length).toBe(1)
    expect((await readWatermark(store, bad.id)).watermark).toBeNull()
    await store.close()
  })

  it('窗口成功 → 水位推进到窗口终点、gap 清除、行落库', async () => {
    const store = await fresh()
    const t = fakeTask({
      fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
    })
    const r = await runTask(t, ctx(store))
    expect(r.status).toBe('complete')
    expect(await store.count('tags')).toBe(1)
    expect((await readWatermark(store, t.id)).watermark).not.toBeNull()
    await store.close()
  })
})

describe('红线 2：配对核对', () => {
  it('fetched ≠ written（enrich 淘汰行）→ count_mismatch gap + partial', async () => {
    const store = await fresh()
    const t = fakeTask({
      enrich: (row) => (row.id === 'skip' ? null : row),
      fetch: async () => ({
        rows: [{ id: 'a', name: 'A', color: '#111111' }, { id: 'skip', name: 'S', color: '#222222' }],
        apiCount: 2,
      }),
    })
    const r = await runTask(t, ctx(store))
    expect(r.rows).toEqual({ fetched: 2, written: 1 })
    expect(r.gaps.some((g) => g.reason === 'count_mismatch')).toBe(true)
    expect(r.status).toBe('partial')
    // gap 落库（sync_gaps 可查）
    expect((await listGaps(store, t.id)).some((g) => g.reason === 'count_mismatch')).toBe(true)
    await store.close()
  })

  it('fetched == written → 无 count_mismatch、complete', async () => {
    const store = await fresh()
    const t = fakeTask({
      fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
    })
    const r = await runTask(t, ctx(store))
    expect(r.status).toBe('complete')
    expect(r.gaps).toEqual([])
    await store.close()
  })
})

describe('假空重试（spec 5.2）', () => {
  it('首次空、重试出全量 → 数据落库、fetch 调用 2 次', async () => {
    const store = await fresh()
    let calls = 0
    const t = fakeTask({
      fetch: async () => {
        calls++
        return calls === 1
          ? { rows: [], apiCount: 0 }
          : { rows: [{ id: 'd1', name: 'D', color: '#333333' }], apiCount: 1 }
      },
    })
    const r = await runTask(t, ctx(store))
    expect(calls).toBe(2)
    expect(r.rows.written).toBe(1)
    expect(r.status).toBe('complete')
    await store.close()
  })

  it('两次都空 → 判空推进（空数据 ≠ 未同步），仅 2 次调用', async () => {
    const store = await fresh()
    let calls = 0
    const t = fakeTask({ fetch: async () => { calls++; return { rows: [], apiCount: 0 } } })
    const r = await runTask(t, ctx(store))
    expect(calls).toBe(2)
    expect(r.status).toBe('complete')
    expect((await readWatermark(store, t.id)).rangeStatus).toBe('complete')
    await store.close()
  })
})

describe('断点续跑（水位语义）', () => {
  /** 无 rangeOverride 的 ctx（水位续跑路径；B 中-5 后显式区间不再被水位抬升）。 */
  // clock 收窄到 14d：缺省路径的 end = clock 当前 —— 用真实纪元会切出 2800+ 窗。
  function ctxNoOverride(store: Store, over: Partial<RunCtx> = {}): RunCtx {
    const c = ctx(store, { clock: () => 14 * DAY, ...over })
    delete c.rangeOverride
    return c
  }

  it('已 complete 的任务重跑：从水位续跑，已覆盖窗口不重拉', async () => {
    const store = await fresh()
    const fetched: number[] = []
    const t = fakeTask({
      maxWindowDays: 7,
      fetch: async (w) => {
        fetched.push(w.start)
        return { rows: [{ id: `w${w.start}`, name: 'A', color: '#444444' }], apiCount: 1 }
      },
    })
    // 第一次：缺省路径（水位为空 → 从 0 起到 clock 当前）→ 2 窗全拉
    const r1 = await runTask(t, ctxNoOverride(store))
    expect(r1.windows.total).toBe(2)
    expect(fetched.length).toBe(2)
    // 第二次：水位已到 clock 当前（窗 2 末）→ 空跑 complete，未新增 fetch
    const r2 = await runTask(t, ctxNoOverride(store))
    expect(fetched.length).toBe(2) // 未新增 fetch
    expect(r2.windows.total).toBe(0)
    expect(r2.status).toBe('complete')
    await store.close()
  })

  it('续跑范围从水位起（watermark+1 → range.start）', async () => {
    const store = await fresh()
    // 预置水位在 5d（前一轮推进过）；clock 冻结在 14d → 续跑区间 [5d+1, 14d]
    await store.transaction(async (tx) => {
      const { advanceWatermark } = await import('../../src/sync/state.js')
      await advanceWatermark(tx, 'reports.overview', new Date(5 * DAY).toISOString(),
        { start: 0, end: 5 * DAY }, new Date().toISOString())
    })
    const fetched: number[] = []
    const t = fakeTask({
      maxWindowDays: 7,
      fetch: async (w) => {
        fetched.push(w.start)
        return { rows: [{ id: `w${w.start}`, name: 'A', color: '#555555' }], apiCount: 1 }
      },
    })
    const r = await runTask(t, ctxNoOverride(store))
    // 窗口从水位 +1ms 起（watermark+1 续跑语义），不重拉 [0,5d]
    expect(fetched[0]).toBe(5 * DAY + 1)
    expect(r.resolvedRange.start).toBe(5 * DAY + 1)
    await store.close()
  })

  it('B 中-5：显式 rangeOverride 优先于水位 —— --since 的回补区间不被水位抬升缩成一窗', async () => {
    const store = await fresh()
    await store.transaction(async (tx) => {
      const { advanceWatermark } = await import('../../src/sync/state.js')
      await advanceWatermark(tx, 'reports.overview', new Date(5 * DAY).toISOString(),
        { start: 0, end: 5 * DAY }, new Date().toISOString())
    })
    const fetchedStarts: number[] = []
    const t = fakeTask({
      maxWindowDays: 7,
      fetch: async (w) => {
        if (!fetchedStarts.includes(w.start)) fetchedStarts.push(w.start)
        return { rows: [{ id: `w${w.start}`, name: 'A', color: '#555555' }], apiCount: 1 }
      },
    })
    // --since 语义：把 [0, 14d) 回补一遍 —— 即使水位已到 5d 也从 0 重拉（回补不被静默缩窄）
    const r = await runTask(t, { ...ctx(store), rangeOverride: { start: 0, end: 14 * DAY } })
    expect(r.windows.total).toBe(2)
    expect(fetchedStarts).toEqual([0, 7 * DAY])
    await store.close()
  })
})

describe('窗口切分与包含窗跳过', () => {
  it('63 天/31 天窗/1 天重叠 → 引擎跳过被前一窗完全覆盖的补窗（[62,63]⊂[60,63]）', async () => {
    const store = await fresh()
    const fetched: { start: number; end: number }[] = []
    const t = fakeTask({
      maxWindowDays: 31, overlapDays: 1,
      fetch: async (w) => {
        // 只在每窗首次调用时记录（假空重试会二次调用同一窗）
        if (!fetched.some((x) => x.start === w.start)) fetched.push({ start: w.start, end: w.end })
        return { rows: [], apiCount: 0 }
      },
    })
    const r = await runTask(t, { ...ctx(store), rangeOverride: { start: 0, end: 63 * DAY } })
    // sliceByMaxWindow 产出 4 窗（[0,31],[30,61],[60,63],[62,63]）；引擎跳过第 4 窗
    expect(fetched).toEqual([
      { start: 0, end: 31 * DAY },
      { start: 30 * DAY, end: 61 * DAY },
      { start: 60 * DAY, end: 63 * DAY },
    ])
    expect(r.windows.total).toBe(3)
    await store.close()
  })

  it('windowMs <= 0（maxWindowDays 非法）→ throw（T2 低-1 防御接线）', async () => {
    const store = await fresh()
    const t = fakeTask({ maxWindowDays: 0 })
    await expect(runTask(t, { ...ctx(store), rangeOverride: { start: 0, end: DAY } }))
      .rejects.toThrow()
    await store.close()
  })
})

describe('单窗失败隔离', () => {
  it('某窗 fetch 抛错 → 该窗记 gap、其余窗口继续（partial）', async () => {
    const store = await fresh()
    const t = fakeTask({
      maxWindowDays: 7,
      fetch: async (w) => {
        if (w.start === 0) throw new Error('上游 500')
        return { rows: [{ id: `w${w.start}`, name: 'A', color: '#666666' }], apiCount: 1 }
      },
    })
    const r = await runTask(t, { ...ctx(store), rangeOverride: { start: 0, end: 14 * DAY } })
    expect(r.windows).toEqual({ total: 2, succeeded: 1, failed: 1 })
    expect(r.status).toBe('partial')
    expect(r.gaps.length).toBe(1)
    expect((await listGaps(store, t.id)).length).toBe(1)
    await store.close()
  })
})

describe('deleteRangeInsert 写策略', () => {
  it('按范围删旧插新：同范围旧行被清除（陈旧行不残留）', async () => {
    const store = await fresh()
    // tags 表无范围语义，deleteRangeInsert 的测试用 id 作范围列：预置同范围旧行
    const t = fakeTask({
      write: { kind: 'deleteRangeInsert', rangeColumns: ['id'] },
      fetch: async () => ({ rows: [{ id: '9', name: '新', color: '#777777' }], apiCount: 1 }),
    })
    // 预置旧行（同范围键 9 与将被保留的 8）
    await store.upsert('tags', [
      { id: '9', name: '旧', color: '#888888' },
      { id: '8', name: '旁', color: '#999999' },
    ])
    const r = await runTask(t, ctx(store))
    expect(r.rows.written).toBe(1)
    const rows = await store.query('SELECT id, name FROM tags ORDER BY id')
    expect(rows.rows).toEqual([
      { id: '8', name: '旁' },
      { id: '9', name: '新' },
    ])
    await store.close()
  })

  it('修复批 4 #11：天对齐删除上界 = dayOf(end−1ms)（半开窗口不多删下一天）', async () => {
    const store = await fresh()
    // 窗口 [D, D+DAY) 恰在日界上（--until 指定日期 / windowEndClamp 都会产生）。
    // 删除上界若取 dayOf(end) = D+1 → 会把 D+1 日的行一起删掉（而本窗不重拉 D+1）。
    const d0 = shanghaiDayStart(1_700_000_000_000)
    // 用真实报表表（daily_overview 有 stat_date 列），形态与报表任务一致
    const t = fakeTask({
      table: 'daily_overview',
      primaryKey: ['stat_date'],
      write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'], rangeAlign: 'shanghaiDay' },
      fetch: async () => ({
        rows: [{ stat_date: shanghaiDayIso(d0), payload: '{"v":1}', synchronized_at: null }],
        apiCount: 1,
      }),
    })
    // 预置：本日（D，应被删后重写）、次日（D+1，本窗范围外，必须保留）
    await store.upsert('daily_overview', [
      { stat_date: shanghaiDayIso(d0), payload: '{"v":0}', synchronized_at: null },
      { stat_date: shanghaiDayIso(d0 + DAY), payload: '{"next":1}', synchronized_at: null },
    ])
    const r = await runTask(t, { ...ctx(store), rangeOverride: { start: d0, end: d0 + DAY } })
    expect(r.rows.written).toBe(1)
    const rows = await store.query('SELECT stat_date, payload FROM daily_overview ORDER BY stat_date')
    // D 日旧行被删（重写为新行）、D+1 日行仍在 —— 半开窗口 [D, D+1) 的删除边界
    expect(rows.rows).toEqual([
      { stat_date: shanghaiDayIso(d0), payload: '{"v":1}' },
      { stat_date: shanghaiDayIso(d0 + DAY), payload: '{"next":1}' },
    ])
    await store.close()
  })

  it('修复批 4 #11：resolved_range 末端 = 水位（不是删除上界；两者刻意不同）', async () => {
    const store = await fresh()
    const d0 = shanghaiDayStart(1_700_000_000_000)
    const t = fakeTask({
      table: 'daily_overview',
      primaryKey: ['stat_date'],
      write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'], rangeAlign: 'shanghaiDay' },
      fetch: async () => ({
        rows: [{ stat_date: shanghaiDayIso(d0), payload: '{"v":1}', synchronized_at: null }],
        apiCount: 1,
      }),
    })
    const r = await runTask(t, { ...ctx(store), rangeOverride: { start: d0, end: d0 + DAY } })
    // 末端是「上次成功推进到的时刻」= 本窗 end（水位），而不是删除边界 dayOf(end−1)
    expect(r.resolvedRange.end).toBe(d0 + DAY)
    const st = await readWatermark(store, t.id)
    expect(st.watermark).toBe(new Date(d0 + DAY).toISOString())
    expect(st.resolvedRangeEnd).toBe(String(d0 + DAY))
    await store.close()
  })
})

describe('限频闸门接线（中-2：慢不是错 + 失败窗不越过水位）', () => {
  it('①gate 冷却 → 按 retryAfter 等待后重试本窗：无 gap、窗口 complete（慢不是错）', async () => {
    const store = await fresh()
    let now = 0
    const gate = new RateGate(store, () => now)
    await gate.penalize('reports.overview', 60)   // 冷却至 now + 60s
    let fetched = 0
    const waits: number[] = []
    const t = fakeTask({ fetch: async () => {
      fetched++
      return { rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }
    } })
    const r = await runTask(t, ctx(store, {
      gate, clock: () => now,
      // 注入 sleep = 推进注入时钟（gate 读同一时钟）：等待一次后冷却到期 → 重试成功
      sleep: async (ms) => { waits.push(ms); now += ms },
    }))
    expect(waits).toEqual([60_000])     // 精确等待 retryAfter 一次
    expect(fetched).toBe(1)             // 等待后真的拉取了
    expect(r.status).toBe('complete')
    expect(r.gaps).toEqual([])
    expect(r.windows).toEqual({ total: 1, succeeded: 1, failed: 0 })
    await store.close()
  })

  it('冷却持续未到点（等待不推进时钟）→ 有界 3 次等待重试后记 gap、不 fetch', async () => {
    const store = await fresh()
    const gate = new RateGate(store, () => 0)   // 时钟冻结 → 冷却永不到期
    await gate.penalize('reports.overview', 60)
    let fetched = 0
    const waits: number[] = []
    const t = fakeTask({ fetch: async () => { fetched++; return { rows: [], apiCount: 0 } } })
    const r = await runTask(t, ctx(store, {
      gate, sleep: async (ms) => { waits.push(ms) },
    }))
    expect(waits).toEqual([60_000, 60_000, 60_000])   // 有界：恰好 3 次等待重试
    expect(fetched).toBe(0)                           // 不碰网络
    expect(r.status).toBe('partial')
    expect(r.gaps.map((g) => g.reason)).toEqual(['rate_limit_local'])
    await store.close()
  })

  it('②窗 2 失败 → 水位停在窗 1 末（不是窗 3 末）；后续成功窗不越过失败窗，续跑回补', async () => {
    const store = await fresh()
    const fetchedStarts: number[] = []
    const t = fakeTask({
      maxWindowDays: 7,
      fetch: async (w) => {
        if (!fetchedStarts.includes(w.start)) fetchedStarts.push(w.start)
        if (w.start === 7 * DAY) throw new Error('窗 2 上游 500')
        return { rows: [{ id: `w${w.start}`, name: 'A', color: '#666666' }], apiCount: 1 }
      },
    })
    const r = await runTask(t, { ...ctx(store), rangeOverride: { start: 0, end: 21 * DAY } })
    expect(r.windows).toEqual({ total: 3, succeeded: 2, failed: 1 })
    expect(r.status).toBe('partial')
    // 水位 = 最后一个连续成功窗的 end（窗 1），窗 3 成功也不越过失败窗推到窗 3 末
    expect((await readWatermark(store, t.id)).watermark)
      .toBe(new Date(7 * DAY).toISOString())
    // 窗 3 的数据仍然落库（失败窗隔离不丢后续窗数据）
    expect(await store.count('tags')).toBe(2)
    // 增量续跑从水位 +1 起 → 失败窗（[7d,14d]）被回补，gap 不再被永久越过
    const c2 = ctx(store, { rangeOverride: { start: 0, end: 21 * DAY }, clock: () => 21 * DAY })
    delete c2.rangeOverride
    const r2 = await runTask(t, c2)
    expect(fetchedStarts).toContain(7 * DAY + 1)
    expect(r2.status).toBe('complete')
    await store.close()
  })

  it('修复批 4 #2：断链后 resolved_range 末端 == 水位（不越过失败窗）', async () => {
    const store = await fresh()
    const t = fakeTask({
      maxWindowDays: 7,
      fetch: async (w) => {
        if (w.start === 7 * DAY) throw new Error('窗 2 上游 500')
        return { rows: [{ id: `w${w.start}`, name: 'A', color: '#666666' }], apiCount: 1 }
      },
    })
    const r = await runTask(t, { ...ctx(store), rangeOverride: { start: 0, end: 21 * DAY } })
    expect(r.status).toBe('partial')
    expect(r.windows).toEqual({ total: 3, succeeded: 2, failed: 1 })
    // resolved_range 末端 = 连续成功末端（窗 1 末），与水位一致 —— 不谎报覆盖到本窗末
    expect(r.resolvedRange.end).toBe(7 * DAY)
    expect((await readWatermark(store, t.id)).watermark).toBe(new Date(r.resolvedRange.end).toISOString())
    // 未断链路径（全窗成功）→ 末端 = 请求末（不回归）
    const ok = fakeTask({
      maxWindowDays: 7,
      fetch: async (w) => ({ rows: [{ id: `w${w.start}`, name: 'A', color: '#666666' }], apiCount: 1 }),
    })
    const r2 = await runTask(ok, { ...ctx(store), rangeOverride: { start: 0, end: 21 * DAY } })
    expect(r2.status).toBe('complete')
    expect(r2.resolvedRange.end).toBe(21 * DAY)
    await store.close()
  })
})

describe('失败窗有界重试（B 中-3）', () => {
  it('fetch 失败 → 固定间隔重试 2 次后成功：无 gap、窗口 complete', async () => {
    const store = await fresh()
    const waits: number[] = []
    let calls = 0
    const t = fakeTask({
      fetch: async () => {
        calls++
        // retryable=true 是「值得重试的瞬时失败」的显式标记（isTransient 判据）；
        // 无标记的普通错误（参数/形态漂移）不重试 —— 见下一用例。
        if (calls <= 2) throw Object.assign(new Error('上游抖动'), { retryable: true })
        return { rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }
      },
    })
    const r = await runTask(t, ctx(store, { sleep: async (ms) => { waits.push(ms) } }))
    expect(r.status).toBe('complete')
    expect(r.gaps).toEqual([])
    expect(calls).toBe(3)               // 初次 + 2 次重试
    expect(waits).toEqual([500, 500])   // 固定间隔（注入 clock 冻结也不死循环）
    await store.close()
  })

  it('重试预算耗尽 → 记 gap（fetch_failed）、partial；kind=network 不重复烧预算（core 已自带重试）', async () => {
    const store = await fresh()
    const waits: number[] = []
    let calls = 0
    const t = fakeTask({
      fetch: async () => {
        calls++
        throw Object.assign(new Error('fetch failed'), { kind: 'network' })
      },
    })
    const r = await runTask(t, ctx(store, { sleep: async (ms) => { waits.push(ms) } }))
    expect(r.status).toBe('partial')
    expect(r.gaps.map((g) => g.reason)).toEqual(['fetch_failed'])
    expect(calls).toBe(1)     // 网络类不进引擎重试预算（http.call 已退避重试 2 次）
    expect(waits).toEqual([])
    await store.close()
  })

  it('限频（kind=rate_limit）也不进引擎重试预算（callPaced 自己的等待预算管冷却）', async () => {
    const store = await fresh()
    let calls = 0
    const t = fakeTask({
      fetch: async () => {
        calls++
        throw Object.assign(new Error('限流'), { kind: 'rate_limit', code: '14009' })
      },
    })
    const r = await runTask(t, ctx(store, { sleep: async () => {} }))
    expect(r.status).toBe('partial')
    expect(calls).toBe(1)
    expect(r.gaps.map((g) => g.reason)).toEqual(['fetch_failed'])
    await store.close()
  })
})

describe('store_locked 撞锁重试（B 中-4，spec §6.3）', () => {
  it('markPending 撞锁 → 有界重试后成功：本轮照常完成', async () => {
    const store = await fresh()
    const waits: number[] = []
    let txCalls = 0
    const realTx = store.transaction.bind(store) as unknown as
      (fn: (tx: Parameters<typeof store.transaction>[0]) => Promise<unknown>) => Promise<unknown>
    // 前 2 次 BEGIN 即抛 store_locked（另一写者持锁），第 3 次放行
    const patched = store as unknown as { transaction: unknown }
    patched.transaction = (fn: (tx: Parameters<typeof store.transaction>[0]) => Promise<unknown>): Promise<unknown> => {
      txCalls++
      if (txCalls <= 2) {
        throw Object.assign(new Error('database is locked'), { kind: 'store_locked' })
      }
      return realTx(fn)
    }
    try {
      const t = fakeTask({ fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }) })
      const r = await runTask(t, ctx(store, { sleep: async (ms) => { waits.push(ms) } }))
      expect(r.status).toBe('complete')
      expect(waits.length).toBe(2)   // 两次撞锁各等 500ms 后重试
      await store.close()
    } finally {
      patched.transaction = realTx
    }
  })

  it('预算耗尽仍撞锁 → 上抛（调用方按异常处理，绝不静默丢任务）', async () => {
    const store = await fresh()
    const realTx = store.transaction.bind(store)
    const patched = store as unknown as { transaction: unknown }
    patched.transaction = async () => {
      throw Object.assign(new Error('database is locked'), { kind: 'store_locked' })
    }
    try {
      const t = fakeTask({ fetch: async () => ({ rows: [], apiCount: 0 }) })
      await expect(runTask(t, ctx(store, { sleep: async () => {} }))).rejects.toMatchObject({ kind: 'store_locked' })
      await store.close()
    } finally {
      patched.transaction = realTx
    }
  })
})

describe('snapshot 任务', () => {
  it('快照型：全删重插在一个事务内，重跑幂等', async () => {
    const store = await fresh()
    await store.upsert('tags', [
      { id: '1', name: '旧1', color: '#AAAAAA' },
      { id: '2', name: '旧2', color: '#BBBBBB' },
    ])
    const t = fakeTask({
      kind: 'snapshot',
      fetch: async () => ({ rows: [{ id: '1', name: '新1', color: '#CCCCCC' }], apiCount: 1 }),
    })
    const r1 = await runTask(t, ctx(store))
    expect(r1.status).toBe('complete')
    expect(await store.count('tags')).toBe(1) // 旧行全删、新行插入
    const r2 = await runTask(t, ctx(store))
    expect(await store.count('tags')).toBe(1) // 重跑幂等
    expect(r2.rows).toEqual({ fetched: 1, written: 1 })
    await store.close()
  })
})

describe('快照 gap 清除与计数（C 高-1 / E 高-2）', () => {
  it('C 高-1：快照失败记 gap（rangeStart=0）→ 下一轮成功 → gap 被清除', async () => {
    const store = await fresh()
    let calls = 0
    const t = fakeTask({
      kind: 'snapshot',
      fetch: async () => {
        calls++
        if (calls === 1) throw new Error('第一次全量失败')
        return { rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }
      },
    })
    const r1 = await runTask(t, ctx(store))
    expect(r1.status).toBe('failed')
    expect(r1.windows).toEqual({ total: 1, succeeded: 0, failed: 1 })   // E 高-2：与 status 一致
    expect((await listGaps(store, t.id)).length).toBe(1)
    // 下一轮成功：快照 gap（键 '0'）在同一事务里被清掉
    const r2 = await runTask(t, ctx(store))
    expect(r2.status).toBe('complete')
    expect(await listGaps(store, t.id)).toEqual([])
    await store.close()
  })

  it('E 中-1：任务运行期 sync_state 盖 locked_by/locked_at，结束（含异常）清空', async () => {
    const store = await fresh()
    const locksMidRun: Array<Record<string, unknown> | undefined> = []
    const t = fakeTask({
      fetch: async () => {
        // fetch 执行中：pending 行已写、写者锁已盖
        const r = await store.query('SELECT locked_by, locked_at FROM sync_state WHERE dataset = ?', ['reports.overview'])
        locksMidRun.push(r.rows[0])
        return { rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }
      },
    })
    await runTask(t, ctx(store))
    expect(locksMidRun[0]).toBeDefined()
    expect(String(locksMidRun[0]!.locked_by)).toMatch(/^pid \d+$/)
    expect(locksMidRun[0]!.locked_at).toBeTruthy()
    // 运行结束：锁列清空、水位保留
    const after = await store.query('SELECT locked_by, locked_at, watermark, range_status FROM sync_state WHERE dataset = ?', ['reports.overview'])
    expect(after.rows[0].locked_by).toBeNull()
    expect(after.rows[0].locked_at).toBeNull()
    expect(after.rows[0].watermark).not.toBeNull()
    await store.close()
  })

  it('E 中-1：fetch 抛异常路径同样清锁（finally）', async () => {
    const store = await fresh()
    const t = fakeTask({ fetch: async () => { throw Object.assign(new Error('x'), { retryable: true }) } })
    await runTask(t, ctx(store))
    const after = await store.query('SELECT locked_by, locked_at FROM sync_state WHERE dataset = ?', ['reports.overview'])
    expect(after.rows[0].locked_by).toBeNull()
    expect(after.rows[0].locked_at).toBeNull()
    await store.close()
  })

  it('C 低-2：fetch 失败的 gap detail 是中文包装（底层原文保留）', async () => {
    const store = await fresh()
    const t = fakeTask({ fetch: async () => { throw new Error('upstream boom') } })
    const r = await runTask(t, ctx(store))
    expect(r.gaps[0].detail).toBe('取数失败（底层：upstream boom）')
    const stored = await listGaps(store, t.id)
    expect(stored[0].detail).toBe('取数失败（底层：upstream boom）')
    await store.close()
  })
})

describe('进度回调', () => {
  it('onProgress 收到窗口进度行（含任务 id 与窗口序号）', async () => {
    const store = await fresh()
    const lines: string[] = []
    const t = fakeTask({
      fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#DDDDDD' }], apiCount: 1 }),
    })
    await runTask(t, ctx(store, { onProgress: (line) => lines.push(line) }))
    expect(lines.some((l) => l.includes('reports.overview'))).toBe(true)
    await store.close()
  })
})
