// tests/sync/engine.test.ts
// D-T5：引擎核心 —— 窗口循环/配对核对/同事务落库（三条红线钉死）。
// fetch/write 全 mock（write 走真库 upsert/delete），不碰网络。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { runTask } from '../../src/sync/engine.js'
import { listGaps, listWatermarks, readWatermark } from '../../src/sync/state.js'
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

describe('落库时同名对象不是基表（view 等）', () => {
  // 2026-11-15（PR #78 收尾自查）：`sync run` 写同名 view 时，DuckDB 的原文只有
  // `Catalog Error: tags is not an table`，gap detail 曾只包成「落库失败（底层：…）」——
  // 不点名「不是基表」，也没有与 `sync verify` 的 `not_base_table` / `query --table` /
  // `stats fields` 同款的恢复动作。Agent 据此只会反复重跑 sync run。
  it('write_failed 的 detail 点名「不是基表」并给出重建恢复动作', async () => {
    const store = await fresh()
    // 把声明表 tags 换成同名的空 view（底表已删，view 本体仍可被解析）
    // —— upsert 走到 `INSERT INTO tags` 时 DuckDB 报 `is not an table`。
    await store.query('DROP TABLE "tags"')
    await store.query('CREATE VIEW "tags" AS SELECT CAST(1 AS VARCHAR) AS id, CAST(2 AS VARCHAR) AS name, CAST(3 AS VARCHAR) AS color WHERE 1 = 0')
    const task = fakeTask({
      table: 'tags',
      fetch: async () => ({ rows: [{ id: 'x', name: 'n', color: 'c' }], apiCount: 1 }),
    })
    const r = await runTask(task, ctx(store))
    expect(r.status).toBe('partial')
    const gaps = await listGaps(store, task.id)
    expect(gaps.length).toBe(1)
    expect(gaps[0].reason).toBe('write_failed')
    const detail = String(gaps[0].detail)
    expect(detail, '要点名「不是基表」而不是只透 DuckDB 原文').toMatch(/不是基表/)
    expect(detail, '不得把 view 定义里的对象名当成故障点').not.toMatch(/is not an table/)
    expect(detail, '恢复动作：备份 + 新路径 store init + sync run').toMatch(/store init/)
    expect(detail).toMatch(/sync run/)
    expect(detail).toMatch(/备份/)
    await store.close()
  })

  it('带 storeLocation 时恢复动作复现本次 --db（裸命令会去操作默认库）', async () => {
    const store = await fresh()
    await store.query('DROP TABLE "tags"')
    await store.query('CREATE VIEW "tags" AS SELECT CAST(1 AS VARCHAR) AS id, CAST(2 AS VARCHAR) AS name, CAST(3 AS VARCHAR) AS color WHERE 1 = 0')
    const task = fakeTask({
      table: 'tags',
      fetch: async () => ({ rows: [{ id: 'x', name: 'n', color: 'c' }], apiCount: 1 }),
    })
    await runTask(task, ctx(store, { storeLocation: { db: cfg.path, profileFlag: 'alpha' } }))
    const detail = String((await listGaps(store, task.id))[0].detail)
    // --db 按契约是 `<新路径>` 占位符（旧库要留着备份，不能指回它）；本次的档名必须复现
    //（同一份 config 下不同档的 options/robots 不同，裸 sync run 会拉错数据集）
    expect(detail, 'store init 必须带本次的档名').toContain("store init --db '<新路径>' --profile alpha")
    expect(detail, 'sync run 必须带本次的档名').toContain("sync run --db '<新路径>' --profile alpha")
    expect(detail, '不得指回出问题的库').not.toContain(`--db ${cfg.path}`)
    expect(detail, '占位符必须附带替换契约').toContain('<新路径>')
    await store.close()
  })
})

describe('快照型任务的 write_failed 同口径', () => {
  it('快照写同名 view → detail 同样点名「不是基表」并给出重建动作（第二处出口）', async () => {
    const store = await fresh()
    await store.query('DROP TABLE "tags"')
    await store.query('CREATE VIEW "tags" AS SELECT CAST(1 AS VARCHAR) AS id, CAST(2 AS VARCHAR) AS name, CAST(3 AS VARCHAR) AS color WHERE 1 = 0')
    const task = fakeTask({
      kind: 'snapshot',
      fetch: async () => ({ rows: [{ id: 'x', name: 'n', color: 'c' }], apiCount: 1 }),
    })
    const r = await runTask(task, ctx(store, { storeLocation: { db: cfg.path } }))
    expect(r.status).toBe('failed')
    const detail = String((await listGaps(store, task.id))[0].detail)
    expect(detail, '快照路径丢了成因点名').toMatch(/不是基表/)
    expect(detail).not.toMatch(/is not an table/)
    expect(detail).toMatch(/store init/)
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

  // 自查（2026-11-04）：`sync tasks` 的 maxWindowDays 图例一度写成「撞上游 14501 时
  // 也按它判断是不是切宽了」—— 引擎里没有这段逻辑，14501 走的是与普通取数失败同一条
  // `fetch_failed` gap 路径（`withRetries` 后仍抛 → catch → failed++）。图例已改为
  // 如实描述；本用例钉住这个行为，图例将来若再声称「自动重切」就会与它矛盾。
  it('上游 14501（窗口过宽）不会自动重切：记 fetch_failed gap、该窗失败，其余窗照跑', async () => {
    const store = await fresh()
    let calls = 0
    const err = Object.assign(new Error('14501 endTime is invalid'), {
      code: 'window_too_large', kind: 'window_too_large', retryable: false,
    })
    const t = fakeTask({
      maxWindowDays: 1, // 2 天区间 → 2 个 1 天窗
      fetch: async () => {
        calls++
        if (calls === 1) throw err
        return { rows: [{ id: 'ok', name: 'O', color: '#444444' }], apiCount: 1 }
      },
    })
    // 两个窗：首窗 14501、次窗成功。
    const r = await runTask(t, ctx(store, { rangeOverride: { start: 0, end: 2 * DAY } }))
    expect(r.windows.total).toBe(2)
    expect(r.windows.failed).toBe(1)
    expect(r.windows.succeeded).toBe(1)
    expect(r.gaps.filter((g) => g.reason === 'fetch_failed').length).toBe(1)
    // fetch_failed 窗没有「应写行数」→ 不计入 written（图例里这句话的出处）。
    expect(r.rows, 'fetch_failed 失败窗不得把行计入 written').toEqual({ fetched: 1, written: 1 })
    // 关键是这一条：没有任何「重切/降宽」的行为痕迹——fetch 恰好多调一次而已。
    expect(r.status).toBe('partial')
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
    // sliceByMaxWindow 产出 4 窗（[0,31],[30,61],[60,63],[62,63]）；引擎合并第 4 窗
    expect(fetched).toEqual([
      { start: 0, end: 31 * DAY },
      { start: 30 * DAY, end: 61 * DAY },
      { start: 60 * DAY, end: 63 * DAY },
    ])
    // 2026-11-09 审计：被重叠区合并的窗此前从所有计数里消失（total=3 看起来就是切出的
    // 全部 4 窗里的 3 —— 少的那一个无从得知）。现在单独披露为 contained（不计入 total）；
    // 且只有**覆盖窗成功**才算 contained（Codex 2026-11-10 第三轮 P2）——这里三窗全成功。
    expect(r.windows.total).toBe(3)
    expect(r.windows.contained).toBe(1)
    expect(r.windows.skipped).toBe(0)   // 合并不是跳过：数据已被前一窗覆盖
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
    expect(r.windows).toEqual({ total: 2, succeeded: 1, failed: 1, skipped: 0 })
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
    expect(r.windows).toEqual({ total: 1, succeeded: 1, failed: 0, skipped: 0 })
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
    expect(r.windows).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0 })
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
    expect(r.windows).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0 })
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

  it('fetch 抛出的拒绝值连文本都转不出 → 仍按 fetch_failed 记 gap，转换异常不得顶掉本次运行', async () => {
    // 同类缺陷的引擎侧（CR 第五十四轮 store 修的同一个形态）：`e instanceof Error ? e.message
    // : String(e)` 在 `Object.create(null)` 上会抛 TypeError —— 错误路径的转换自己成了新的
    // 主失败，本次运行连 partial 都报不出来。引擎的五处转文本必须与 store 同口径。
    const store = await fresh()
    try {
      const t = fakeTask({ fetch: async () => { throw Object.create(null) } })
      const r = await runTask(t, ctx(store, { sleep: async () => {} }))
      expect(r.status).toBe('partial')
      expect(r.gaps.map((g) => g.reason)).toEqual(['fetch_failed'])
      expect(r.gaps[0]!.detail, '失败说明要有占位文本，而不是抛出去').toMatch(/无法转成文本/)
    } finally {
      await store.close()
    }
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

  it('apiCount 是配对核对基准（与 windowed / verify 同一口径）：声明多于实际 → count_mismatch', async () => {
    // ⚠️ 此前快照只用 kept.length，apiCount 被静默忽略 —— 三条路径对同一字段三种读法，
    // 上游声明 5 行而解析出 2 行时，只有快照不会报不符（其余两条都会）。
    const store = await fresh()
    const t = fakeTask({
      kind: 'snapshot',
      fetch: async () => ({
        rows: [{ id: '1', name: 'A', color: '#111111' }, { id: '2', name: 'B', color: '#222222' }],
        apiCount: 5,
      }),
    })
    const r = await runTask(t, ctx(store))
    expect(r.status).toBe('failed')
    expect(r.rows).toEqual({ fetched: 2, written: 0 })
    const gaps = await listGaps(store, t.id)
    expect(gaps.map((g) => g.reason)).toEqual(['count_mismatch'])
    // 失败窗整体回滚：表里不留任何行
    expect(await store.count('tags')).toBe(0)
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
    expect(r1.windows).toEqual({ total: 1, succeeded: 0, failed: 1, skipped: 0 })   // E 高-2：与 status 一致
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

describe('整体早于接口下界的区间（CI 实测修正）', () => {
  it('rangeEnd ≤ floor → 单窗直送守卫：不从 1970 切出数百窗', async () => {
    const store = await fresh()
    const now = 1_700_000_000_000
    const calls: number[] = []
    const t = fakeTask({
      // 模拟 tickets.search 的声明面（windowStartFloorDays=31）与 op 守卫
      //（assertOpWindow：start ≤ 0 抛 usage —— 单窗直送守卫时正是它显式失败）
      windowStartFloorDays: 31,
      fetch: async (w) => {
        calls.push(w.start)
        if (w.start <= 0) {
          throw Object.assign(new Error('工单 op 窗口无效'), { kind: 'usage' })
        }
        return { rows: [], apiCount: 0 }
      },
    })
    // end 落在下界（now − 31 天）之前 40 天 → 整段不可得
    const r = await runTask(t, ctx(store, {
      rangeOverride: { start: 0, end: now - 40 * DAY },
      clock: () => now,
    }))
    // 单窗：不是 702 窗（1970 → end 按 31 天切片的旧行为）
    expect(r.windows.total).toBe(1)
    expect(r.windows.failed).toBe(1)
    expect(calls.length).toBe(1)
    await store.close()
  })

  it('rangeEnd > floor（部分可得）→ 仍按切片执行（不误收成单窗）', async () => {
    const store = await fresh()
    const now = 1_700_000_000_000
    const t = fakeTask({
      windowStartFloorDays: 31,
      fetch: async () => ({ rows: [], apiCount: 0 }),
    })
    const r = await runTask(t, ctx(store, {
      rangeOverride: { start: 0, end: now - 10 * DAY },
      clock: () => now,
    }))
    // 起点抬到下界（now−31d），窗口数 = ceil(21 天 / 31 天) = 1
    expect(r.windows.total).toBe(1)
    expect(r.status).toBe('complete')
    await store.close()
  })
})

/**
 * COMMIT 结果未知（CR 第四十一轮 major 的追问）：落库事务的提交结果无法确认时，Store 会
 * **当场退役**；随后的 gap 落库与清锁都会撞上退役。若让这些次生失败照常上抛，用户看到的
 * 是「Store 已退役：…请关闭该实例并重新创建」—— 把主失败里的恢复指令（写入可能已落库、
 * 不要按失败直接重试、核对后再决定是否重放）整段换掉，恰好诱导重复写。
 *
 * ⚠️ 用**真驱动**注入（不是手写假 store）：退役是 `duckdb.ts` 的行为，只有真 Store 才会
 * 在 COMMIT 交回被拒时打上 `store_retired`；手写假 store 会把这道判据测成永远不触发。
 */
describe('COMMIT 结果未知 → 引擎交回主失败（不换成退役文案）', () => {
  /** 关掉第 N 次 COMMIT 的结果交回（提交在驱动里已执行；N 从 init 之后的第一次提交数起）。 */
  async function storeWithCommitFailureAt(n: number,
    failWrite?: (sql: string) => boolean): Promise<{ store: Store; commits: () => number; commitLog: Array<{ lastMutating: string }> }> {
    const real = await import('@duckdb/node-api')
    let seen = 0
    // ⚠️ init 的迁移自己就会提交很多次（每个迁移一个事务）—— 计数必须在 init **之后**开，
    // 否则注入打中的是迁移的 COMMIT，Store 在 init 里就退役了。
    let injectAt = 0
 // ⚠️记录每次注入 COMMIT之前最后一条写语句（CR第六十七轮 major：只按序号断言时，
 //数据窗的提交结果未知会满足同一组断言 ——必须能证明第3次提交来自清锁事务）。
 let lastMutating = ''
 const commitLog: Array<{ lastMutating: string }> = []
 // ⚠️写失败注入在 init之后才武装：迁移里也可能出现写语句，武装过早会在建库阶段就炸。
 let armed = false
    const importer = async (): Promise<unknown> => ({
      ...real,
      DuckDBInstance: {
        create: async (...a: unknown[]) => {
          const inst = await (real.DuckDBInstance.create as (...x: unknown[]) => Promise<unknown>)(...a)
          const ii = inst as { connect: () => Promise<unknown>; closeSync?: () => void }
          return {
            ...(inst as object),
            closeSync: () => ii.closeSync?.(),
            connect: async () => {
              const c = await ii.connect()
              const cc = c as {
                runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>
                extractStatements: (x: string) => unknown
                closeSync?: () => void
              }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                // 原型方法不在自有属性里，Store 的事务控制判据要用它 —— 显式转发。
                extractStatements: (sql: string) => cc.extractStatements(sql),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  // 普通写入失败注入（与 COMMIT 回执注入可叠加：#2 的「窗口写失败 + 缺口提交未知」）
                  if (armed && failWrite !== undefined && sql !== 'COMMIT' && failWrite(sql)) {
                    throw new Error('注入：窗口写入失败')
                  }
                  //记录本次提交之前的最后一条写语句（INSERT/UPDATE/DELETE），用于证明注入打中的是哪个事务。
                  if (sql !== 'COMMIT' && /^(INSERT|UPDATE|DELETE)/i.test(sql.trim())) lastMutating = sql
                  const out = await cc.runAndReadAll(sql, params)
                  if (sql === 'COMMIT' && injectAt !== 0 && seen + 1 === injectAt) commitLog.push({ lastMutating })
                  if (sql === 'COMMIT' && injectAt !== 0 && ++seen === injectAt) {
                    throw new Error('注入：COMMIT 已执行、结果交回失败')
                  }
                  return out
                },
              }
            },
          }
        },
      },
    })
    const store = await createDuckDbStore(cfg, 'rw', { importer })
    await store.init()
 armed = true
    seen = 0
    injectAt = n
    return { store, commits: () => seen, commitLog }
  }

  it('windowed：交回原始失败（带「核对后再重放」），不是退役文案', async () => {
    // kind 断言见用例中部：命令出口靠它透传 hint
    // markPending 的提交是第 1 次；数据窗的提交是第 2 次。
    const { store } = await storeWithCommitFailureAt(2)
    try {
      const t = fakeTask({
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
      })
      const e = await runTask(t, ctx(store)).then(() => null,
        (x: unknown) => x as Error & { hint?: string; kind?: string })
      expect(e, '提交结果未知必须上抛（不能当成 partial 成功）').not.toBeNull()
      expect(e!.message, '必须是主失败，不是退役文案').toMatch(/提交结果未知/)
      expect(e!.message).not.toMatch(/Store 已退役/)
      expect(e!.hint, '恢复动作：核对后再决定是否重放').toMatch(/核对/)
      expect(e!.hint).toMatch(/重放/)
      // ⚠️ **kind 必须在场**（CR 第五十轮 major #3 的收口）：命令出口 `thrownToExit` 只在
      // `err.kind` 存在时透传 `err.hint`，否则换成通用「执行期错误」文案 —— hint 在 engine 层
      // 保住了、到了命令边界照样可能被换掉。命令出口是同一个函数（`sync-run.ts` 与 `store.ts`
      // 共用 `thrownToExit`），这里钉住进入出口的形状，两个命令族同时被守住。
      expect(e!.kind, '无 kind 的错误在命令出口会被换成通用 hint —— 必须带 kind 出门').toBe('internal')
      // ⚠️ 回滚收尾的补注**不得**嫁接到这条诊断上（CR 第四十二轮 major 的追问，真驱动探针
      // 2026-11-20 实测过嫁接形态）：COMMIT 已下发、写入可能已落库，此时再说「回滚可能根本没
      // 执行、写入结果不可信」只是把恢复动作稀释成两套互相打架的指令。核对→再决定重放才是
      // 这条成因的指引，且它必须原样到达 Agent。
      expect(e!.message, '不得追加通用回滚补注').not.toMatch(/回滚未能确认/)
      expect(e!.hint, '不得追加通用回滚补注').not.toMatch(/写入结果不可信/)
      // ⚠️ **注入的确实是「数据窗」那次提交**（CR 第四十六轮 major 的追问）：重开库核对 ——
      // 若第 2 次 COMMIT 其实是 markPending 那次，数据行不会在库里，这条用例就在拿错误的
      // 提交位置冒充事故形态。
    } finally {
      await store.close()
    }
    const reopened = await createDuckDbStore(cfg, 'rw')
    expect(await reopened.count('tags'), '数据窗的提交在驱动里已执行 → 行应已落库').toBe(1)
    await reopened.close()
  })

  it.each([
    { label: 'null', make: (): unknown => null },
    {
      label: 'kind 访问器抛异常的对象',
      make: (): unknown => Object.defineProperty({}, 'kind', {
        get() { throw new Error('注入：拒绝值的 kind 访问器') },
      }),
    },
  ])('拒绝值是 $label 时退役/限频判据不得抛 TypeError 顶掉原失败（Codex 第十二轮 P2）', { timeout: 90_000 }, async ({ make }) => {
    // 事故形态：`Store.query` 以 `null` 拒绝时，`acquireGated` / `runSnapshot` 的限频判据
    // `(e as { kind }).kind` 直接 TypeError（实测 `Cannot read properties of null (reading 'kind')`）
    // —— 错误路径上的判据成了新的主失败，原始拒绝值与恢复指令一起丢光。判据必须安全读取：
    // null / 非对象 / 访问器抛异常 → 一律「不匹配」，拒绝值原样交回。
    // ⚠️ 只需 Store 边界桩：这条路径上被真实执行的判据是 `withStoreRetries` → `acquireGated`
    // → `runSnapshot` 的限频分派（`acquire` 读到拒绝就到此为止）；真库只会把冷启动负载
    // 噪声（实测 90 s 超时）带进来，判据并没有被多覆盖一行。
    const thrown = make()
    const fake = { query: async () => { throw thrown } } as unknown as Store
    const out = await runTask(fakeTask({ kind: 'snapshot' }), ctx(fake))
      .then(() => ({ resolved: true as const }), (x: unknown) => ({ rejected: true as const, value: x }))
    expect(out, '必须交回拒绝结果').toHaveProperty('rejected')
    expect((out as { value: unknown }).value, '原拒绝值必须原样交回（同一引用），不得换成 TypeError').toBe(thrown)
  })

  it('退役/提交未知对两层重试判据都是终态：窗口事务只尝试一次（不重试、不被 store_retired 顶替）（CR 第四十二轮 major）', async () => {
    // CR 的追问：`commitWindow` 走 `withStoreRetries`，rotated 路径又在外面套 `isTransient` ——
    // 任一判据若把「退役」当可重试，第二次尝试会立刻撞上 `store_retired`，主失败里的恢复
    // 指令被换成退役文案，诱导重复写。判据：真实退役错误对两层都是终态 ⇒ 事务只尝试一次。
    // 计数用**真 store 的委托包装**（不是手写假 store）：退役行为仍由 duckdb.ts 产出。
    const { store } = await storeWithCommitFailureAt(2)
    try {
      // ⚠️ 判据取 `ctx.sleep`：`withRetries` 的**每次重试**都先等 `RETRY_DELAY_MS` 再跑第二次，
      // 而退役之后的「gap 落库」事务是在 BEGIN 处被拒的收尾动作（不经过重试等待）。
      // 数 transaction 调用会把它算进来，数回调执行次数又会在「第二次被 BEGIN 拒掉」时漏判。
      let retryWaits = 0
      const t = fakeTask({
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
      })
      const e = await runTask(t, ctx(store, {
        sleep: async () => { retryWaits++ },
      })).then(() => null, (x: unknown) => x as Error)
      expect(e, '必须上抛').not.toBeNull()
      expect(e!.message, '主失败必须保留，不得被第二次尝试换掉').toMatch(/提交结果未知/)
      expect(retryWaits, '退役错误对两层重试判据都必须是终态 —— 一次重试等待都不许有').toBe(0)
    } finally {
      await store.close()
    }
  })

  it('退役后写者锁不挡下一次 run：重新打开同一库、同一任务照常跑完并清锁（CR 第四十三轮 major 的追问）', async () => {
    // CR 的追问：数据 COMMIT 成功但结果丢失时，`markPending` 盖下的写者锁留在库里；
    // 操作员照 hint 重建实例、核对数据之后，这把锁会不会挡住下一次 run？
    // 判据（真库实测）：锁只是 `sync_state` 上的两列，**没有任何读取点会据此拒绝** ——
    // 新实例上的 run 照常进行并在结束时清章。若哪天加了「锁在就不跑」，这里会红。
    const { store } = await storeWithCommitFailureAt(2)
    try {
      const t = fakeTask({
        id: 'lock.probe', table: 'tags',
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
      })
      const first = await runTask(t, ctx(store)).then(() => null, (x: unknown) => x as Error)
      expect(first, '前提：第一次 run 因提交结果未知而失败').not.toBeNull()
      expect(first!.message).toMatch(/提交结果未知/)
      // 新实例（模拟操作员的恢复动作）。退役实例拒绝一切语句，必须先关掉再开。
      await store.close()
      const s2 = await createDuckDbStore(cfg, 'rw')
      try {
        await s2.init()
        // readWatermark 只投影水位列 —— 锁列要走 listWatermarks（status/verify 的同款视图）。
        const before = (await listWatermarks(s2)).get('lock.probe')
        // ⚠️ **先断言记录在场**（Codex 第七轮 P2）：`before.get(…)?.lockedBy` 在记录缺失时是
        // undefined，而 `not.toBeNull()` 对 undefined 照样通过 —— 前提句会退化成永远成立的空话。
        expect(before, '前提：水位记录必须存在（否则「锁留在库里」无从谈起）').toBeDefined()
        expect(typeof before!.lockedBy, '前提：退役时锁确实留在库里').toBe('string')
        const second = await runTask(t, ctx(s2))
        expect(second.status, '锁不得挡住下一次 run').toBe('complete')
        expect((await listWatermarks(s2)).get('lock.probe')?.lockedBy, '成功收尾必须清锁').toBeNull()
      } finally {
        await s2.close()
      }
    } finally {
      await store.close()
    }
  })

  it('rotated：同样交回主失败（第三入口，与 put 同一条 storeGapOrPrimary 路径）', async () => {
    const { runRotated } = await import('../../src/sync/engine.js')
    const { store } = await storeWithCommitFailureAt(2)
    try {
      const t = fakeTask({
        reportDayRotation: true, maxWindowDays: 1,
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
      })
      const e = await runRotated([t], ctx(store)).then(() => null, (x: unknown) => x as Error & { hint?: string })
      expect(e, '轮转路径的提交结果未知同样上抛').not.toBeNull()
      expect(e!.message, '必须是主失败，不是退役文案').toMatch(/提交结果未知/)
      expect(e!.message).not.toMatch(/Store 已退役/)
      expect(e!.hint).toMatch(/核对/)
    } finally {
      await store.close()
    }
  })

  it('windowed：数据窗已提交、清锁事务丢掉 COMMIT 回执 → 不得报 complete（CR 第五十一轮 major #5）', async () => {
    // 成功路径的提交次数：#1 markPending、#2 数据窗、#3 清锁（releaseLock 的 clearLock 事务）。
    // 清锁事务丢掉回执 = 它自己的 COMMIT 结果未知、当场退役 —— 这不是任何主失败的次生结果，
    // 旧实现按「次生」吞掉并返回 complete：实例已退役、写者锁可能没清，却被报成全部成功。
    const { store, commitLog } = await storeWithCommitFailureAt(3)
    try {
      const t = fakeTask({
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
      })
      const e = await runTask(t, ctx(store)).then(() => null, (x: unknown) => x as Error & { hint?: string })
      expect(e, '清锁事务的提交结果未知必须上抛，不能当 complete').not.toBeNull()
      expect(e!.message).toMatch(/提交结果未知/)
      expect(e!.hint, '恢复动作：先核对再决定是否重放').toMatch(/核对/)
    expect(commitLog[0], '注入必须打中第3次提交（清锁事务）').toBeDefined()
    expect(commitLog[0]!.lastMutating, '清锁事务最后写的是 sync_state ——不是数据窗的 tags')
     .toMatch(/sync_state/)
    expect(commitLog[0]!.lastMutating, '排除把数据窗提交误当成清锁提交').not.toMatch(/tags/)
    } finally {
      await store.close()
    }
  })

  it('gap 事务在 INSERT 阶段失败且 ROLLBACK 未确认 → 摘要不得说「COMMIT 已下发」（Codex 第五轮 P1）', async () => {
    // 隔离探针：SQL 序列只有 BEGIN → INSERT sync_gaps → ROLLBACK，根本没有 COMMIT；若摘要仍写
    // 「COMMIT 已下发」就会把恢复动作指到不存在的提交上。摘要必须用 gap 错误自己的成因。
    const real = await import('@duckdb/node-api')
    // ⚠️ 窗口事务的回滚必须**成功**（否则 primary 自己就带退役标记、走不到 gap 分支）：
    // 只有第二次 ROLLBACK（补记缺口那次）被拒。
    let rollbacks = 0
    // 注入只在本用例的 runTask 阶段生效：init 的迁移里也有 `INSERT INTO "sync_gaps_v10"`
    let armed = false
    const importer = async (): Promise<unknown> => ({
      ...real,
      DuckDBInstance: {
        create: async (...a: unknown[]) => {
          const inst = await (real.DuckDBInstance.create as (...x: unknown[]) => Promise<unknown>)(...a)
          const ii = inst as { connect: () => Promise<unknown>; closeSync?: () => void }
          return {
            ...(inst as object),
            closeSync: () => ii.closeSync?.(),
            connect: async () => {
              const c = await ii.connect()
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; extractStatements: (x: string) => unknown; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                extractStatements: (sql: string) => cc.extractStatements(sql),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (!armed) return cc.runAndReadAll(sql, params)
                  if (sql === 'ROLLBACK' && ++rollbacks >= 2) throw new Error('注入：ROLLBACK 被拒')
                  if (/INSERT INTO\s+"?(tags|sync_gaps)"?\s*\(/.test(sql)) throw new Error('注入：写入失败')
                  return cc.runAndReadAll(sql, params)
                },
              }
            },
          }
        },
      },
    })
    const store = await createDuckDbStore(cfg, 'rw', { importer })
    await store.init()
    armed = true
    try {
      const t = fakeTask({
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
      })
      const e = await runTask(t, ctx(store)).then(() => null,
        (x: unknown) => x as Error & { hint?: string })
      expect(e, '必须以错误收尾').not.toBeNull()
      expect(e!.message, '真实成因是回滚未确认').toMatch(/回滚未能确认/)
      expect(e!.message, '不得声称 COMMIT 已下发').not.toMatch(/COMMIT 已下发/)
      expect(e!.hint).toMatch(/核对/)
    } finally {
      await store.close()
    }
  })

  it('撞锁失败 + 回滚未确认 → 两层重试都不得再碰已退役的实例（Codex 第七轮 P2）', async () => {
    // 事故形态（Codex 真驱动注入实测）：事务里抛 `kind:'store_locked'`、ROLLBACK 又未确认 ——
    // 补注保留原 kind 并打上 `code=store_retired`。两层重试只按 kind 判「撞锁可重试」，
    // 于是又对**已退役的同一实例**发起第二次尝试：主失败被「Store 已退役」换掉，恢复指令丢失。
    const real = await import('@duckdb/node-api')
    let armed = false
    let insertCalls = 0
    let rollbackCalls = 0
    const importer = async (): Promise<unknown> => ({
      ...real,
      DuckDBInstance: {
        create: async (...a: unknown[]) => {
          const inst = await (real.DuckDBInstance.create as (...x: unknown[]) => Promise<unknown>)(...a)
          const ii = inst as { connect: () => Promise<unknown>; closeSync?: () => void }
          return {
            ...(inst as object),
            closeSync: () => ii.closeSync?.(),
            connect: async () => {
              const c = await ii.connect()
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; extractStatements: (x: string) => unknown; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                extractStatements: (sql: string) => cc.extractStatements(sql),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (!armed) return cc.runAndReadAll(sql, params)
                  if (/^INSERT INTO\s+"?tags"?/.test(sql)) {
                    insertCalls++
                    throw Object.assign(new Error('注入：写入撞锁'), { kind: 'store_locked', retryable: true })
                  }
                  if (sql === 'ROLLBACK') {
                    rollbackCalls++
                    throw new Error('注入：ROLLBACK 被拒')
                  }
                  return cc.runAndReadAll(sql, params)
                },
              }
            },
          }
        },
      },
    })
    const store = await createDuckDbStore(cfg, 'rw', { importer })
    await store.init()
    armed = true
    try {
      let retryWaits = 0
      const t = fakeTask({
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
      })
      const e = await runTask(t, ctx(store, { sleep: async () => { retryWaits++ } }))
        .then(() => null, (x: unknown) => x as Error & { kind?: string; code?: string; hint?: string; retryable?: boolean })
      expect(e, '必须以错误收尾').not.toBeNull()
      expect(e!.message, '原始撞锁失败必须保留（不得被退役文案换掉）').toMatch(/注入：写入撞锁/)
      expect(e!.message, '回滚未确认的事实也要在').toMatch(/回滚未能确认/)
      expect(e!.code, '实例已退役').toBe('store_retired')
      // ⚠️ 原错误带 `retryable:true`（撞锁可重试）；实例已退役后**必须改判为 false**（CR 第六十一轮
      // 追问）：命令出口按 kind 分流时，可重试标记还在就是「把已退役的实例当普通撞锁」再试一次。
      expect(e!.retryable, '退役后不得再说可重试').toBe(false)
      expect(retryWaits, '退役错误对两层重试都是终态 —— 一次重试等待都不许有').toBe(0)
      expect(insertCalls, '退役后不得再次碰同一实例').toBe(1)
      expect(rollbackCalls).toBeGreaterThanOrEqual(1)
    } finally {
      await store.close()
    }
  })

  it('rotated：撞锁失败 + 回滚未确认 → 外层 isTransient 不得重试已退役的实例（CR 第六十轮 major）', async () => {
    // 判据同 runTask 那条，但入口是 `runRotated`：它的 `commitWindow` 外面套的是**外层**
    // `withRetries(…, isTransient)`。若 `isTransient` 只看 kind=store_locked，会再对已退役的
    // 同一实例发起第二次尝试，主失败被「Store 已退役」换掉。两个入口各有一条回归，判据改名
    // 或只改一处时两边都能红。
    const real = await import('@duckdb/node-api')
    let armed = false
    let insertCalls = 0
    const importer = async (): Promise<unknown> => ({
      ...real,
      DuckDBInstance: {
        create: async (...a: unknown[]) => {
          const inst = await (real.DuckDBInstance.create as (...x: unknown[]) => Promise<unknown>)(...a)
          const ii = inst as { connect: () => Promise<unknown>; closeSync?: () => void }
          return {
            ...(inst as object),
            closeSync: () => ii.closeSync?.(),
            connect: async () => {
              const c = await ii.connect()
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; extractStatements: (x: string) => unknown; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                extractStatements: (sql: string) => cc.extractStatements(sql),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (!armed) return cc.runAndReadAll(sql, params)
                  if (/^INSERT INTO\s+"?tags"?/.test(sql)) {
                    insertCalls++
                    throw Object.assign(new Error('注入：写入撞锁'), { kind: 'store_locked', retryable: true })
                  }
                  if (sql === 'ROLLBACK') throw new Error('注入：ROLLBACK 被拒')
                  return cc.runAndReadAll(sql, params)
                },
              }
            },
          }
        },
      },
    })
    const store = await createDuckDbStore(cfg, 'rw', { importer })
    await store.init()
    armed = true
    try {
      const { runRotated } = await import('../../src/sync/engine.js')
      let retryWaits = 0
      const t = fakeTask({
        reportDayRotation: true, maxWindowDays: 1,
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
      })
      const e = await runRotated([t], ctx(store, { sleep: async () => { retryWaits++ } }))
        .then(() => null, (x: unknown) => x as Error & { code?: string; retryable?: boolean })
      expect(e, '必须以错误收尾').not.toBeNull()
      expect(e!.message, '原始撞锁失败必须保留（不得被退役文案换掉）').toMatch(/注入：写入撞锁/)
      expect(e!.message, '回滚未确认的事实也要在').toMatch(/回滚未能确认/)
      expect(e!.code, '实例已退役').toBe('store_retired')
      expect(e!.retryable, '退役后不得再说可重试').toBe(false)
      expect(retryWaits, '旋转入口的退役错误同样是终态 —— 一次重试等待都不许有').toBe(0)
      expect(insertCalls, '退役后不得再次碰同一实例').toBe(1)
    } finally {
      await store.close()
    }
  })

  it('取数失败 + 补记缺口的提交结果丢失 → 取数原始失败不得被退役文案顶掉（CR 第六十三轮 major）', async () => {
    // 事故：fetch 失败 → `storeGap` 补记缺口；缺口事务的 COMMIT 结果丢失让实例**首次**退役。
    // 旧实现状态的处理只覆盖「落库/清锁」两条路径，三条 fetch 处理器的 storeGap 是裸调用 ——
    // 次生的退役错误把「取数失败」连同它的恢复指令换掉。
    // 提交次数：markPending #1；缺口事务的 COMMIT 是 #2。
    const { store } = await storeWithCommitFailureAt(2)
    try {
      const t = fakeTask({ fetch: async () => { throw new Error('注入：取数失败') } })
      const e = await runTask(t, ctx(store, { sleep: async () => {} })).then(() => null,
        (x: unknown) => x as Error & { code?: string })
      expect(e, '必须以错误收尾').not.toBeNull()
      expect(e!.message, '取数原始失败必须保留').toMatch(/注入：取数失败/)
      expect(e!.message, '缺口事务退役的事实也要在').toMatch(/补记缺口时实例退役|退役/)
      expect(e!.code, '编排层要能识别退役').toBe('store_retired')
    } finally {
      await store.close()
    }
  })

  it('配对核对不符 + 回滚未确认 → 主失败原文保留在包层、恢复动作不被命令出口换掉（CR 第六十一轮追问）', async () => {
    // `commitWindow` 的 count_mismatch 是**无 kind** 的普通 Error。回滚未确认时补注会包一层；
    // 若包层漏了 `kind`，命令出口 `thrownToExit` 会走「无 kind」分支、把 hint 换成通用
    // 「执行期错误」文案 —— 「先核对再重放」整段丢失。判据：交回错误同时保留 mismatch 原文、
    // 回滚未确认事实、kind=internal 与核对 hint，且窗口放弃（不重试）。
    const real = await import('@duckdb/node-api')
    let armed = false
    let insertCalls = 0
    const importer = async (): Promise<unknown> => ({
      ...real,
      DuckDBInstance: {
        create: async (...a: unknown[]) => {
          const inst = await (real.DuckDBInstance.create as (...x: unknown[]) => Promise<unknown>)(...a)
          const ii = inst as { connect: () => Promise<unknown>; closeSync?: () => void }
          return {
            ...(inst as object),
            closeSync: () => ii.closeSync?.(),
            connect: async () => {
              const c = await ii.connect()
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; extractStatements: (x: string) => unknown; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                extractStatements: (sql: string) => cc.extractStatements(sql),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (!armed) return cc.runAndReadAll(sql, params)
                  if (sql === 'ROLLBACK') throw new Error('注入：ROLLBACK 被拒')
                  if (/^INSERT INTO\s+"?tags"?/.test(sql)) { insertCalls++; return cc.runAndReadAll(sql, params) }
                  return cc.runAndReadAll(sql, params)
                },
              }
            },
          }
        },
      },
    })
    const store = await createDuckDbStore(cfg, 'rw', { importer })
    await store.init()
    armed = true
    try {
      // apiCount=2、实际 1 行 → 写入数 1 ≠ 预期 2 → 事务里抛 count_mismatch。
      const t = fakeTask({
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 2 }),
      })
      const e = await runTask(t, ctx(store, { sleep: async () => {} })).then(() => null,
        (x: unknown) => x as Error & { kind?: string; hint?: string; code?: string })
      expect(e, '必须以错误收尾').not.toBeNull()
      expect(e!.message, '配对核对原文必须保留').toMatch(/配对核对不符/)
      expect(e!.message, '回滚未确认的事实也要在').toMatch(/回滚未能确认/)
      expect(e!.kind, '无 kind 的主失败必须由包层补 internal（否则 hint 被命令出口换掉）').toBe('internal')
      expect(e!.code, '实例已退役').toBe('store_retired')
      expect(e!.hint, '恢复动作必须含核对').toMatch(/核对/)
      expect(e!.hint, '恢复动作必须含重放').toMatch(/重放/)
      expect(insertCalls, '退役后不得再碰同一实例').toBe(1)
    } finally {
      await store.close()
    }
  })

  it('windowed：窗口写普通失败 + 补记缺口的事务丢掉 COMMIT 回执 → 退役事实不得被吞（CR 第五十一轮 major #2）', async () => {
    // 场景：窗口写入抛普通错误（回滚已确认、实例还活着），随后补记缺口的事务丢了 COMMIT 回执
    //（**首次**让实例退役）。旧实现 `storeGapOrPrimary` 见 store_retired 就无条件交回 primary，
    // 把「缺口记录可能没落库、实例已退役、后续窗口写不进」整段丢掉。
    // 提交次数：markPending #1；窗口事务在 INSERT 处抛错、回滚不发 COMMIT；缺口事务的 COMMIT 是 #2。
    const { store } = await storeWithCommitFailureAt(2,
      (sql) => /INSERT INTO\s+"?tags"?/.test(sql))
    try {
      const t = fakeTask({
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
      })
      const e = await runTask(t, ctx(store)).then(() => null,
        (x: unknown) => x as Error & { hint?: string; kind?: string; code?: string })
      expect(e, '必须以错误收尾').not.toBeNull()
      expect(e!.message, '原始窗口失败必须保留').toMatch(/注入：窗口写入失败/)
      expect(e!.message, '补记缺口的提交未知 / 退役事实不得被吞').toMatch(/缺口|退役/)
      expect(e!.code, '实例已退役：编排层据此识别').toBe('store_retired')
      // kind 也必须在场：命令出口 `thrownToExit` 只在 `err.kind` 存在时透传 hint（CR 第五十二轮 #15）
      expect(e!.kind, '命令出口靠 kind 透传 hint').toBe('internal')
      expect(e!.hint, '恢复动作仍要给出').toMatch(/核对/)
    } finally {
      await store.close()
    }
  })

  it('snapshot：同样交回主失败（gap / 清锁撞退役不得把它换掉）', async () => {
    const { store } = await storeWithCommitFailureAt(2)
    try {
      const t = fakeTask({
        kind: 'snapshot', table: 'tags',
        fetch: async () => ({ rows: [{ id: '1', name: 'A', color: '#111111' }], apiCount: 1 }),
      })
      const e = await runTask(t, ctx(store)).then(() => null, (x: unknown) => x as Error & { hint?: string })
      expect(e, '快照写库的提交结果未知同样上抛').not.toBeNull()
      expect(e!.message).toMatch(/提交结果未知/)
      expect(e!.message).not.toMatch(/Store 已退役/)
      expect(e!.hint).toMatch(/核对/)
    } finally {
      await store.close()
    }
  })
})
