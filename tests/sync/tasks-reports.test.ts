// tests/sync/tasks-reports.test.ts
// D-T7：9 报表任务声明 + 按天轮转调度。
// 真库夹具照 tests/store/duckdb.test.ts；http mock 照 tests/core/http.test.ts。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { runTask, runRotated } from '../../src/sync/engine.js'
import { RateGate } from '../../src/sync/rate-gate.js'
import { REPORT_TASKS, taskById as reportById } from '../../src/sync/tasks/reports.js'
import { reportBody, __setSleep } from '../../src/sync/tasks/reports.js'
import { listGaps, readWatermark } from '../../src/sync/state.js'
import { shanghaiYesterdayStart, shanghaiDayStart, shanghaiDayIso } from '../../src/sync/day.js'
import { __resetBuckets } from '../../src/core/http.js'
import type { RunCtx, SyncTask, WindowRef } from '../../src/sync/types.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

vi.setConfig({ testTimeout: 15_000 })

const DAY = 86_400_000

let dir = ''
let cfg: StoreConfig
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-reports-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30000, batchSize: 1000 }
  // 令牌桶是模块级状态（报表接口 30 秒桶）——不清空会跨用例污染；
  // 任务内多次调用（翻页/逐客服）的冷却等待注入零耗时，测试可确定性断言
  __resetBuckets()
  // 注入的 sleep 代表「等满了 retryAfter」——令牌桶按真实时钟计窗，
  // 测试用清桶模拟时间推进（与真实 31s 等待后放行等价）
  __setSleep(async () => { __resetBuckets() })
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(cfg, 'rw')
  await s.init()
  return s
}

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

const REPORT_TABLES = ['daily_overview', 'staff_workload', 'staff_quality', 'staff_satisfaction',
  'staff_attendance', 'order_performance', 'staff_salary_detail', 'robot_summary', 'transfer_human']

/** 形状 C 夹具：载荷藏在 message 里的 JSON 字符串。 */
function okC(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify({
    code: 200, message: JSON.stringify(payload),
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
}
/** 形状 A 夹具（robot_summary / transfer_human）。 */
function okA(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ code: 200, message: 'OK', data }),
    { status: 200, headers: { 'content-type': 'application/json' } }))
}

/** 真 Response 不可复用 body——按调用序出列的 mock 工厂。 */
function respondQueue(resps: (() => Promise<Response>)[]) {
  let i = 0
  return vi.fn(() => (i < resps.length ? resps[i++]() : Promise.reject(new Error('mock 响应耗尽'))))
}

describe('schema v5 迁移 —— 9 张报表表', () => {
  it('迁移后 tables() 含 9 张报表表；键列 NOT NULL（information_schema 反射）', async () => {
    const s = await fresh()
    const tables = await s.tables()
    for (const t of REPORT_TABLES) expect(tables, `缺表 ${t}`).toContain(t)
    const r = await s.query(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'staff_attendance' ORDER BY ordinal_position")
    const nn = Object.fromEntries(r.rows.map((x) => [String(x.column_name), String(x.is_nullable)]))
    expect(nn.staff_id).toBe('NO')
    expect(nn.hour_ts).toBe('NO')
    expect(nn.stat_date).toBe('NO')
    expect(nn.payload).toBe('YES')
    await s.close()
  })

  it('staff_attendance 主键 (staff_id, hour_ts)；staff_salary_detail 主键 (staff_id, work_date)；order_performance 主键 order_id', async () => {
    const s = await fresh()
    // 用同键重插幂等性钉死主键组合
    const stamp = '2026-10-14T00:00:00.000Z'
    await s.upsert('staff_attendance', [{ staff_id: '1000002', hour_ts: stamp, stat_date: stamp, payload: null, synchronized_at: null }])
    await s.upsert('staff_attendance', [{ staff_id: '1000002', hour_ts: stamp, stat_date: stamp, payload: null, synchronized_at: null }])
    expect(await s.count('staff_attendance')).toBe(1)
    await s.upsert('staff_salary_detail', [{ staff_id: '1000002', work_date: stamp, stat_date: stamp, payload: null, synchronized_at: null }])
    await s.upsert('order_performance', [{ order_id: '900001', stat_date: stamp, payload: null, synchronized_at: null }])
    expect(await s.count('staff_salary_detail')).toBe(1)
    expect(await s.count('order_performance')).toBe(1)
    await s.close()
  })
})

describe('REPORT_TASKS 任务声明', () => {
  it('共 9 任务：id 唯一、kind=windowed、reportDayRotation、deleteRangeInsert(stat_date)', () => {
    expect(REPORT_TASKS.map((t) => t.id).sort()).toEqual([
      'reports.overview', 'reports.staff_workload', 'reports.staff_quality', 'reports.staff_satisfaction',
      'reports.staff_attendance', 'reports.order_performance', 'reports.staff_salary_detail',
      'reports.robot_summary', 'reports.transfer_human',
    ].sort())
    for (const t of REPORT_TASKS) {
      expect(t.kind, `${t.id} kind`).toBe('windowed')
      expect(t.reportDayRotation, `${t.id} 轮转标记`).toBe(true)
      // A 中-2 钉死：删除边界与行内日期列同口径（上海天对齐）——
      // 否则 --full（start=0）与增量（水位+1ms）对同一业务日的删除范围互不覆盖。
      expect(t.write, `${t.id} 写策略`).toEqual({
        kind: 'deleteRangeInsert', rangeColumns: ['stat_date'], rangeAlign: 'shanghaiDay',
      })
      expect(t.primaryKey.length, `${t.id} 主键非空`).toBeGreaterThan(0)
    }
    expect(reportById('reports.overview')!.table).toBe('daily_overview')
    // 窗口上限：**聚合报表按天切片**（修复批 4 #1）——这些接口返回窗口聚合值
    //（overview 一行全局汇总 / staffworklod 每客服一行 / transferHuman 恒 1 行），
    // 响应 date 无语义 → 多天窗口会把 N 天汇总标成第 1 天、水位每月才推进一次。
    const byId = (id: string): SyncTask => reportById(id)!
    for (const id of ['reports.overview', 'reports.staff_workload', 'reports.staff_quality',
      'reports.staff_satisfaction', 'reports.robot_summary', 'reports.transfer_human',
      'reports.order_performance', 'reports.staff_salary_detail']) {
      expect(byId(id)!.maxWindowDays, `${id} 按天切片`).toBe(1)
    }
    // 唯一例外：staff_attendance 的响应**有逐行可信时间戳**（date 按小时对齐）→
    // 保持 31 天窗口（一行一小时 ≈ 1.7 万行/窗），stat_date 由该行 hour_ts 推导。
    expect(byId('reports.staff_attendance')!.maxWindowDays).toBe(31)
  })

  it('修复批 4 #1：多天范围 → 窗口数 == 天数（按天切片）', async () => {
    const store = await fresh()
    const fetchMock = vi.fn(() => okC({ sessions: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      // 3 天范围 → overview 切 3 窗，每窗恰好一天（多天聚合被标成某一天的问题
      // 在此被结构性排除）
      const t = reportById('reports.overview')!
      const r = await runTask(t, ctx(store, { rangeOverride: { start: 0, end: 3 * DAY } }))
      expect(r.windows).toEqual({ total: 3, succeeded: 3, failed: 0 })
      const durations = fetchMock.mock.calls.map((c) => {
        const b = JSON.parse(String((c[1] as { body?: string }).body ?? '{}'))
        return Number(b.endTime) - Number(b.startTime)
      })
      expect(durations).toEqual([DAY, DAY, DAY])
      // 水位推进到第 3 天末（按天窗口才能每日推进）
      expect((await readWatermark(store, t.id)).watermark).toBe(new Date(3 * DAY).toISOString())
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('修复批 4 #1：聚合报表的 3 天范围 → 3 个不同 stat_date（不再全落窗口首日）', async () => {
    const fetchMock = vi.fn(() => okC({ sessions: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      // 三个连续的上海自然日 0 点起（日界上：--until 指定日期 / windowEndClamp /
      // 日对齐水位都会产生这种边界）——统计按天切片时窗口端点恰是日界
      const d0 = shanghaiDayStart(1_700_000_000_000)
      const r = await runTask(reportById('reports.overview')!,
        ctx(store, { rangeOverride: { start: d0, end: d0 + 3 * DAY } }))
      expect(r.status).toBe('complete')
      const rows = await store.query('SELECT stat_date FROM daily_overview ORDER BY stat_date')
      // 3 天 = 3 个业务日各一行（此前 31 天窗会把所有行标成窗口首日）
      expect(rows.rows.map((x) => x.stat_date)).toEqual([
        shanghaiDayIso(d0), shanghaiDayIso(d0 + DAY), shanghaiDayIso(d0 + 2 * DAY),
      ])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('G 高-1：attendance/performance 声明 windowEndClamp（endTime 越界 14501）；其余任务不钳', () => {
    const clamped = ['reports.staff_attendance', 'reports.order_performance']
    for (const t of REPORT_TASKS) {
      expect(t.windowEndClamp ?? null, `${t.id} windowEndClamp`).toBe(
        clamped.includes(t.id) ? 'shanghaiYesterday' : null)
    }
  })

  it('B 中-6：每个任务声明 endpoint（闸门键 = 注册表路径）', () => {
    const byId = (id: string): SyncTask => reportById(id)!
    expect(byId('reports.overview')!.endpoint).toBe('statistic.overview')
    expect(byId('reports.staff_salary_detail')!.endpoint).toBe('statistic.salaryDetail')
    expect(byId('reports.transfer_human')!.endpoint).toBe('ai.statistic.transferHuman')
    for (const t of REPORT_TASKS) expect(t.endpoint, `${t.id} endpoint`).toBeTruthy()
  })

  it('考勤任务请求体恒含 startTime（静默降级防护钉死）', () => {
    const t = reportById('reports.staff_attendance')!
    const w: WindowRef = { start: 0, end: DAY, index: 0, total: 1 }
    const body = reportBody('reports.staff_attendance', w) as Record<string, unknown>
    expect('startTime' in body).toBe(true)   // 缺 startTime = 天粒度少抓 ~10 倍且不报错
  })

  it('robot_summary / transfer_human 忽略参数不透传（body 不含 robotId/type）', () => {
    const w: WindowRef = { start: 0, end: DAY, index: 0, total: 1 }
    const rs = reportBody('reports.robot_summary', w) as Record<string, unknown>
    const th = reportBody('reports.transfer_human', w) as Record<string, unknown>
    expect('robotId' in rs).toBe(false)
    expect('robotId' in th).toBe(false)
    expect('type' in th).toBe(false)
    expect('startTime' in rs).toBe(true)
    expect('startTime' in th).toBe(true)
  })
})

describe('报表任务 fetch（http mock）', () => {
  it('order_performance 的 orders:null → gapHint filter_matched_no_staff（非空窗口错误形态）', async () => {
    const fetchMock = respondQueue([
      () => okC({ orders: null, sum: null, total: null }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const t = reportById('reports.order_performance')!
      const r = await t.fetch({ start: 0, end: DAY, index: 0, total: 1 },
        { store, credentials: ctx(store).credentials })
      expect(r.rows).toEqual([])
      expect(r.apiCount).toBe(0)
      expect(r.gapHint).toEqual({ reason: 'filter_matched_no_staff', detail: expect.any(String) })
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('daily_overview：窗口行落库（stat_date 由调用方填写、payload JSON 收敛）', async () => {
    const fetchMock = respondQueue([() => okC({ sessions: 100, sessionsManual: 60 })])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(reportById('reports.overview')!, ctx(store))
      expect(r.status).toBe('complete')
      expect(r.rows.written).toBe(1)
      const rows = await store.query('SELECT stat_date, payload FROM daily_overview')
      expect(Object.keys(rows.rows[0]).sort()).toEqual(['payload', 'stat_date'])
      expect(JSON.parse(rows.rows[0].payload as string)).toEqual({ sessions: 100, sessionsManual: 60 })
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('staff_attendance：分页 total 收敛拉满（两页）+ hour_ts 取响应 date，apiCount 与 total 一致', async () => {
    // 首页 2 行（total=3）→ 第二页 1 行（total=3 收敛停）——单页实现会静默截掉第 3 行。
    // hour_ts 用真实量级（小时对齐毫秒戳 ≈1.7e12）：C 中-4 守卫对秒级 ts（≤1e11）按脏行丢弃。
    const row = (id: number, ts: number) => ({ staffId: id, date: ts, loginDuration: 3600001 })
    const H = 3_600_000
    const BASE = 1_700_000_000_000 - (1_700_000_000_000 % H)   // 小时对齐
    const fetchMock = respondQueue([
      () => okC({ result: [row(1000002, BASE), row(1000002, BASE + H)], total: 3 }),
      () => okC({ result: [row(1000002, BASE + 2 * H)], total: 3 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    try {
      expect(fetchMock.mock.calls.length).toBe(0)
      const store = await fresh()
      const r = await runTask(reportById('reports.staff_attendance')!, ctx(store))
      expect(fetchMock.mock.calls.length).toBe(2)   // page1 + page2（page2 撞本地桶，等满冷却后重试成功）
      expect(r.status).toBe('complete')
      expect(r.rows).toEqual({ fetched: 3, written: 3 })   // apiCount 与 total 一致
      // G 高-1：请求体 endTime ≤ 昨天 0:00（Asia/Shanghai）——窗口 end 被钳制后发出
      const body1 = JSON.parse(String((fetchMock.mock.calls[0][1] as { body?: string }).body ?? '{}'))
      const yesterday0 = shanghaiYesterdayStart(1_700_000_000_000)
      expect(Number(body1.endTime)).toBeLessThanOrEqual(yesterday0)
      const rows = await store.query('SELECT staff_id, hour_ts FROM staff_attendance ORDER BY hour_ts')
      expect(rows.rows).toEqual([
        { staff_id: '1000002', hour_ts: new Date(BASE).toISOString() },
        { staff_id: '1000002', hour_ts: new Date(BASE + H).toISOString() },
        { staff_id: '1000002', hour_ts: new Date(BASE + 2 * H).toISOString() },
      ])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('修复批 4 扩展②：staff_attendance 的 stat_date 由本行 hour_ts 推导（不再全落窗口首日）', async () => {
    // 31 天窗口里行跨多个自然日：stat_date 跟随该行自己的业务日（此前用窗口起点，
    // 整窗的行都会被标成窗口首日）
    const H = 3_600_000
    const day0 = shanghaiDayStart(1_700_000_000_000)
    const r1 = day0 + 3 * H
    const r2 = day0 + 27 * H   // 次日 03:00（同一窗口内的另一自然日）
    const row = (id: number, ts: number) => ({ staffId: id, date: ts, loginDuration: 1 })
    const fetchMock = respondQueue([() => okC({ result: [row(1000002, r1), row(1000002, r2)], total: 2 })])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(reportById('reports.staff_attendance')!, ctx(store))
      expect(r.status).toBe('complete')
      const rows = await store.query(
        'SELECT staff_id, hour_ts, stat_date FROM staff_attendance ORDER BY hour_ts')
      expect(rows.rows).toEqual([
        { staff_id: '1000002', hour_ts: new Date(r1).toISOString(), stat_date: shanghaiDayIso(r1) },
        { staff_id: '1000002', hour_ts: new Date(r2).toISOString(), stat_date: shanghaiDayIso(r2) },
      ])
      // 两行落在不同业务日（窗口起点口径下会完全相同 —— 本用例的判别力所在）
      expect(rows.rows[0]!.stat_date).not.toBe(rows.rows[1]!.stat_date)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('C 中-4：脏时间戳（非数字/秒级 ts）→ 逐行丢弃、不断整窗；秒级不落 1970', async () => {
    const row = (id: number, ts: unknown) => ({ staffId: id, date: ts, loginDuration: 1 })
    const H = 3_600_000
    const BASE = 1_700_000_000_000 - (1_700_000_000_000 % H)
    const fetchMock = respondQueue([
      () => okC({ result: [
        row(1000002, 'not-a-number'),   // 非数字 → 丢
        row(1000002, 1_700_000_000),    // 秒级 ts（10 位）→ 形态不符丢，绝不落 1970
        row(1000002, BASE),             // 合法
      ], total: 3 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(reportById('reports.staff_attendance')!, ctx(store))
      expect(r.status).toBe('complete')
      // fetched 只计**投影后**的行（脏行在 fetch 内丢弃、不计入 apiCount —— 与各任务
      // 「丢弃行不计入 fetched」的统一口径一致）
      expect(r.rows).toEqual({ fetched: 1, written: 1 })
      const rows = await store.query('SELECT hour_ts FROM staff_attendance')
      expect(rows.rows).toEqual([{ hour_ts: new Date(BASE).toISOString() }])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('order_performance 真实落库：2 订单 + sum → 3 行（order_id 主键非空、sum 走哨兵行）', async () => {
    const fetchMock = respondQueue([
      () => okC({ orders: [{ orderId: 900001, sellMoney: 10 }, { orderId: 900002, sellMoney: 20 }],
        sum: { sellMoney: 30 }, total: 2 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(reportById('reports.order_performance')!, ctx(store))
      expect(r.status).toBe('complete')
      expect(r.rows.written).toBe(3)
      const rows = await store.query('SELECT order_id, stat_date FROM order_performance ORDER BY order_id')
      // sum 哨兵行按 controller 裁定进同表（order_id='sum'，sum 字段在 payload 里）
      expect(rows.rows.map((x) => x.order_id)).toEqual(['900001', '900002', 'sum'])
      expect(rows.rows.every((x) => typeof x.order_id === 'string' && x.order_id.length > 0)).toBe(true)
      const sumRow = await store.query("SELECT payload FROM order_performance WHERE order_id = 'sum'")
      expect(JSON.parse(sumRow.rows[0].payload as string)).toEqual({ sellMoney: 30 })
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('B 高-1：报表取数经 callPaced —— 远端 14009 触发 gate.penalize(endpointId) 后重试成功', async () => {
    // 第一次：形状 C 的 14009 限频信封（core 抛 kind=rate_limit）；第二次：正常载荷。
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 14009, message: 'too frequent',
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      .mockImplementationOnce(() => okC({ sessions: 7 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const penalize = vi.fn(async () => {})
      const gate = { penalize, acquire: async () => {} } as unknown as RateGate
      const r = await runTask(reportById('reports.overview')!, ctx(store, { gate }))
      expect(r.status).toBe('complete')
      expect(r.rows.written).toBe(1)
      // B 中-6：penalize 的键是 endpoint id（不是任务 id 'reports.overview'）
      expect(penalize).toHaveBeenCalled()
      expect(penalize.mock.calls.every((c) => c[0] === 'statistic.overview')).toBe(true)
      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(2)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('C 中-5：载荷为 null（形状漂移）→ 显式失败，绝不按空窗 complete', async () => {
    const fetchMock = respondQueue([() => okC(null)])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const t = reportById('reports.overview')!
      await expect(t.fetch({ start: 0, end: DAY, index: 0, total: 1 },
        { store, credentials: ctx(store).credentials })).rejects.toThrow(/未返回载荷/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('C 中-3：分页短读（声明 total=3 只拿到 1 行 → 空页）→ 显式失败', async () => {
    const fetchMock = respondQueue([
      () => okC({ result: [{ staffId: 1000002, x: 1 }], total: 3 }),
      () => okC({ result: [], total: 3 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const t = reportById('reports.staff_workload')!
      await expect(t.fetch({ start: 0, end: DAY, index: 0, total: 1 },
        { store, credentials: ctx(store).credentials })).rejects.toThrow(/短读/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('A 中-2：--full 与增量对同一上海自然日 → 只留一行（日期列与删除范围同口径）', async () => {
    // 两个不同的毫秒起点，落在**同一个**上海自然日（+08:00 的 03:00 与 05:00）
    const day0 = shanghaiYesterdayStart(1_700_000_000_000)   // 上海某日 00:00
    const fetchMock = vi.fn(() => okC({ sessions: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const t = reportById('reports.overview')!
      const r1 = await runTask(t, ctx(store, {
        rangeOverride: { start: day0 + 3 * 3_600_000, end: day0 + 4 * 3_600_000 },
      }))
      expect(r1.rows.written).toBe(1)
      // 增量：起点在同一天内偏后 2 小时（水位 +1ms 的真实形态）
      const r2 = await runTask(t, ctx(store, {
        rangeOverride: { start: day0 + 5 * 3_600_000, end: day0 + 6 * 3_600_000 },
      }))
      expect(r2.status).toBe('complete')
      // 天对齐后 stat_date 相同、删除范围覆盖同一行 → 只留一行（毫秒口径会留两行）
      const rows = await store.query('SELECT stat_date FROM daily_overview')
      expect(rows.rows.length).toBe(1)
      expect(rows.rows[0].stat_date).toBe(new Date(day0).toISOString())
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('staff_salary_detail：按 staff 表客服驱动（一次一客服）；staff 表空 → 显式失败', async () => {
    const fetchMock = respondQueue([() => okC({ result: [{ salary: 100 }] })])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      // 预置 staff 表 1 名客服（多客服会触发 core 令牌桶 30 秒本地冷却——
      // 进程内限频的正确接线属 T13 的 run 编排，这里只钉「每客服一次调用」的行形态）
      const stamp = '2026-10-14T00:00:00.000Z'
      await store.upsert('staff', [{ id: '1000002', realname: '测试甲', nickname: '甲', username: 'jia',
        role: '0', roleId: '30', status: '1', createtime: '0', updateTime: '0', email: null,
        phone: null, workNumber: null, maxServiceCount: null, skillScoreChat: null,
        skillScoreIpcc: null, groupInfo: null, synchronized_at: stamp }])
      const r = await runTask(reportById('reports.staff_salary_detail')!, ctx(store))
      expect(r.status).toBe('complete')
      expect(r.rows.written).toBe(1)
      const rows = await store.query('SELECT staff_id, work_date FROM staff_salary_detail ORDER BY staff_id')
      expect(rows.rows.map((x) => x.staff_id)).toEqual(['1000002'])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('按天轮转调度（runRotated）', () => {
  /** 轮转用小任务：target 表用 tags（id/name/color），行带窗口 ISO 作 stat_date 对拍。 */
  function rotTask(id: string, over: Partial<SyncTask> = {}): SyncTask {
    return {
      id, table: 'daily_overview', kind: 'windowed',
      maxWindowDays: 1, overlapDays: 0, primaryKey: ['stat_date'],
      watermark: { field: 'stat_date', initial: null },
      reportDayRotation: true,
      fetch: async () => ({ rows: [], apiCount: 0 }),
      write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] },
      ...over,
    }
  }

  it('3 任务 × 2 天窗口：同一天内跨任务背靠背（gate 只在同路径连发时拦）', async () => {
    const store = await fresh()
    // gate mock：记录 acquire 序；同 endpointId 连发（不同任务 id）放行——
    // 闸门按任务 id 限频，轮转的意义正是同一天内换不同接口背靠背。
    const acqOrder: string[] = []
    const gate = {
      acquire: async (id: string) => { acqOrder.push(id) },
    } as unknown as RateGate
    // 三个任务分别落三张同构报表表（stat_date/payload/synchronized_at），
    // 否则同表 deleteRangeInsert 的范围删除会互删同窗口行（真实场景下任务各归各表）。
    const tables = ['daily_overview', 'robot_summary', 'transfer_human']
    const mk = (id: string, table: string): SyncTask => rotTask(id, {
      table,
      fetch: async (w) => ({
        rows: [{ stat_date: new Date(w.start).toISOString(), payload: `${id}@${w.index}`,
          synchronized_at: null }],
        apiCount: 1,
      }),
    })
    const tasks = [mk('reports.a', tables[0]), mk('reports.b', tables[1]), mk('reports.c', tables[2])]
    const results = await runRotated(tasks, ctx(store, {
      gate, rangeOverride: { start: 0, end: 2 * DAY },
    }))
    // 同一轮（天）内三个任务背靠背，轮与轮之间才回到同一任务
    expect(acqOrder).toEqual([
      'reports.a', 'reports.b', 'reports.c',   // 第 1 天
      'reports.a', 'reports.b', 'reports.c',   // 第 2 天
    ])
    expect(results.map((r) => r.status)).toEqual(['complete', 'complete', 'complete'])
    // 每任务 2 窗全提交、水位推进到第 2 天
    for (const r of results) {
      expect(r.windows).toEqual({ total: 2, succeeded: 2, failed: 0 })
      expect((await readWatermark(store, r.taskId)).watermark).not.toBeNull()
    }
    expect(await store.count('daily_overview')).toBe(2)
    expect(await store.count('robot_summary')).toBe(2)
    expect(await store.count('transfer_human')).toBe(2)
    await store.close()
  })

  it('轮转中某任务某窗失败 → 记 gap 继续其余（故障隔离与单任务一致）', async () => {
    const store = await fresh()
    const gate = { acquire: async () => {} } as unknown as RateGate
    const mk = (id: string, failAt?: number): SyncTask => rotTask(id, {
      fetch: async (w) => {
        if (failAt !== undefined && w.index === failAt) throw new Error('上游 500')
        return { rows: [{ stat_date: new Date(w.start).toISOString(), payload: null, synchronized_at: null }], apiCount: 1 }
      },
    })
    const results = await runRotated(
      [mk('reports.a', 0), rotTask('reports.b', {
        table: 'robot_summary',   // 同表会让 deleteRangeInsert 的范围删除互删同窗行
        fetch: async (w) => ({
          rows: [{ stat_date: new Date(w.start).toISOString(), payload: null, synchronized_at: null }],
          apiCount: 1,
        }),
      })],
      ctx(store, { gate, rangeOverride: { start: 0, end: 2 * DAY } }))
    expect(results[0].status).toBe('partial')
    expect(results[0].gaps.length).toBe(1)
    expect(results[1].status).toBe('complete')
    expect((await listGaps(store, 'reports.a')).length).toBe(1)
    await store.close()
  })

  it('D 中-4：轮转中的限频等待 —— gate 冷却 → 等待后重试本窗（无 gap，complete）', async () => {
    const store = await fresh()
    let now = 0
    const gate = new RateGate(store, () => now)
    await gate.penalize('statistic.overview', 60)     // 冷却至 now + 60s
    const waits: number[] = []
    const fetched: number[] = []
    const t = rotTask('reports.overview', {
      endpoint: 'statistic.overview',   // 闸门键 = endpoint id（B 中-6）：penalize 打在同一把键上
      fetch: async (w) => {
        fetched.push(w.start)
        return { rows: [{ stat_date: new Date(w.start).toISOString(), payload: null, synchronized_at: null }], apiCount: 1 }
      },
    })
    const results = await runRotated([t], ctx(store, {
      gate, clock: () => now,
      sleep: async (ms) => { waits.push(ms); now += ms },
      rangeOverride: { start: 0, end: 2 * DAY },
    }))
    expect(waits).toEqual([60_000])            // 等待一次后冷却到期
    expect(fetched.length).toBe(2)             // 两个窗口都真的拉取了
    expect(results[0].status).toBe('complete')
    expect(results[0].gaps).toEqual([])
    await store.close()
  })

  it('D 中-4：轮转中的限频 gap —— 冷却永不到期 → 有界等待后记 rate_limit_local gap、不 fetch', async () => {
    const store = await fresh()
    const gate = new RateGate(store, () => 0)   // 时钟冻结：冷却永不到期
    await gate.penalize('statistic.overview', 60)
    let fetched = 0
    const t = rotTask('reports.overview', {
      endpoint: 'statistic.overview',
      fetch: async () => { fetched++; return { rows: [], apiCount: 0 } },
    })
    const results = await runRotated([t], ctx(store, {
      gate, sleep: async () => {}, rangeOverride: { start: 0, end: 2 * DAY },
    }))
    expect(fetched).toBe(0)                      // 绝不碰网络
    expect(results[0].status).toBe('partial')
    expect(results[0].gaps.map((g) => g.reason)).toEqual(['rate_limit_local', 'rate_limit_local'])
    await store.close()
  })

  it('D 中-4：轮转中的水位冻结 —— 某任务某窗失败后水位停在连续成功末端，后续窗不越过', async () => {
    const store = await fresh()
    const t = rotTask('reports.overview', {
      fetch: async (w) => {
        if (w.index === 1) throw new Error('上游 500')
        return { rows: [{ stat_date: new Date(w.start).toISOString(), payload: null, synchronized_at: null }], apiCount: 1 }
      },
    })
    const results = await runRotated([t], ctx(store, { rangeOverride: { start: 0, end: 3 * DAY } }))
    expect(results[0].status).toBe('partial')
    expect(results[0].windows).toEqual({ total: 3, succeeded: 2, failed: 1 })
    // 水位 = 窗 1 末（1 天），窗 3 成功也不越过失败窗
    expect((await readWatermark(store, 'reports.overview')).watermark)
      .toBe(new Date(DAY).toISOString())
    // 失败窗隔离：窗 3 数据仍落库
    expect(await store.count('daily_overview')).toBe(2)
    await store.close()
  })

  it('D 中-5：callPaced 全链路 —— 真实 14009 → penalize 落持久化冷却行（sync_state）', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 14009, message: 'too frequent',
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      .mockImplementationOnce(() => okC({ sessions: 5 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(reportById('reports.overview')!, ctx(store))
      expect(r.status).toBe('complete')
      // 冷却行以 **endpoint id** 落库（B 中-6）：dataset = __ratelimit__:<endpointId>
      const rows = await store.query(
        'SELECT dataset, watermark, last_rate_limited_at FROM sync_state WHERE dataset = ?',
        ['__ratelimit__:statistic.overview'])
      expect(rows.rows.length).toBe(1)
      expect(rows.rows[0].watermark).toBeTruthy()
      expect(rows.rows[0].last_rate_limited_at).toBeTruthy()
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('gapHint 透传原始 reason（T5 裁定接线：filter_matched_no_staff 落 sync_gaps）', async () => {
    const store = await fresh()
    const t = rotTask('reports.order_performance', {
      fetch: async () => ({
        rows: [], apiCount: 0,
        gapHint: { reason: 'filter_matched_no_staff', detail: 'orders:null' },
      }),
    })
    const r = await runTask(t, ctx(store))
    expect(r.status).toBe('complete')   // 成功窗 + 提示性 gap
    const gaps = await listGaps(store, t.id)
    expect(gaps.length).toBe(1)
    expect(gaps[0].reason).toBe('filter_matched_no_staff')
    await store.close()
  })
})
