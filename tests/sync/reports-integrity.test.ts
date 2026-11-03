// tests/sync/reports-integrity.test.ts —— 报表任务的两条数据完整性缺陷（2026-11-03 实测修）
//
// 均来自独立审查 agent（报表与窗口数学），逐条自写探针复现后修：
//   ① staff_attendance 的 31 天窗：窗口起点不在日界时，删除范围 `[dayOf(start), dayOf(end−1ms)]`
//      会把**相邻窗写好的边界日整片删掉**，只重写 start 之后的小时 —— 边界日前半段被删且
//      永不重写（修复前实测 fetched=written=960、complete、零 gap，边界日只有 16/24 小时）。
//      → 最终修（CodeRabbit #59 收敛）：`write.instantColumn='hour_ts'`，按 `[w.start, w.end)`
//      精确删。中间版本「只删完整自然日」修好了丢数据，却留下**陈旧行**（半个边界日里
//      被上游撤掉的小时永不删）——第三个用例钉住该边。按 stat_date 的自然日删只留给
//      「窗起止都落日界」的任务（其余报表按天切片），前提由 write-contract.ts 加载期校验。
//   ② staff_quality 不分页：`fetchSimple` 单次调用不读 total，上游 1500 行只取 1000 仍 complete。
//      → 改走 `fetchPagedStaff(..., withSum)`（sum 全局行照旧落 staff_id='sum'）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { runTask } from '../../src/sync/engine.js'
import { RateGate } from '../../src/sync/rate-gate.js'
import { taskById as reportById } from '../../src/sync/tasks/reports.js'
import { __setSleep } from '../../src/sync/tasks/pace.js'
import { shanghaiDayStart, shanghaiDayIso } from '../../src/sync/day.js'
import { __resetBuckets } from '../../src/core/http.js'
import type { RunCtx } from '../../src/sync/types.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

vi.setConfig({ testTimeout: 30_000 })

const HOUR = 3_600_000
const DAY = 86_400_000
/** 固定时钟（2023-11-14T22:13:20Z）——窗口一律用真实量级；range 取过去，避开 windowEndClamp。 */
const NOW = 1_700_000_000_000

let dir = ''
let cfg: StoreConfig
// ⚠️ core 的本地令牌桶读的是 `Date.now()`（不是注入的 ctx.clock）—— 连续多窗会把同一个
// endpoint 打成本地限频。让 Date.now 与 ctx.clock 共用同一个会前进的变量，并让注入的
// sleep 推进它，callPaced 的「等待后重试」才真的过时间（否则 no-op sleep = 立即重试 = 失败）。
let nowMs = NOW
beforeEach(() => {
  nowMs = NOW
  vi.spyOn(Date, 'now').mockImplementation(() => nowMs)
  dir = mkdtempSync(join(tmpdir(), 'qiyu-reports-integrity-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30_000, batchSize: 1000 }
  __resetBuckets()
  // callPaced 用自己的模块级 sleep（不是 ctx.sleep）—— 让它推进同一个时钟，
  // 「等待后重试」才真的过时间、令牌桶才会重新蓄满。
  __setSleep(async (ms) => { nowMs += ms })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(cfg, 'rw')
  await s.init()
  return s
}

function ctx(store: Store, over: Partial<RunCtx> = {}): RunCtx {
  return {
    store, credentials: { appKey: 'k', appSecret: 's' },
    gate: new RateGate(store, () => nowMs), clock: () => nowMs,
    sleep: async (ms) => { nowMs += ms },
    ...over,
  }
}

const okC = (payload: unknown): Promise<Response> => Promise.resolve(new Response(
  JSON.stringify({ code: 200, message: JSON.stringify(payload) }),
  { status: 200, headers: { 'content-type': 'application/json' } }))

describe('① staff_attendance：窗边界日的整点行不得被相邻窗删掉', () => {
  it('40 天、非日界起点 → 每个自然日都必须有完整 24 小时', async () => {
    const store = await fresh()
    // 起点取「日界 + 11 小时」：窗口按 31 天切，第二窗的 start 落在第一个边界日之内。
    // 取 45 天前起（40 天窗）→ 整个区间落在 windowEndClamp（昨天 0:00）之内，钳制不参与，
    // 否则末日会被合法地钳掉、与要测的删除边界混在一起。
    const rangeStart = shanghaiDayStart(NOW - 45 * DAY) + 11 * HOUR
    const rangeEnd = rangeStart + 40 * DAY
    // 每次请求按 body 的 [startTime, endTime) 逐小时造行（staffId 恒 1）——上游就是这样给数据的。
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { startTime: number; endTime: number; page?: number }
      const rows: unknown[] = []
      for (let t = Math.ceil(body.startTime / HOUR) * HOUR; t < body.endTime; t += HOUR) {
        rows.push({ staffId: 1, date: t, loginDuration: 1000 })
      }
      return okC({ result: rows, sum: null, total: rows.length })
    }))
    try {
      const r = await runTask(reportById('reports.staff_attendance')!, ctx(store, {
        rangeOverride: { start: rangeStart, end: rangeEnd },
      }))
      expect(r.status, JSON.stringify(r.gaps)).toBe('complete')
      // 断言**完整落在区间内**的自然日必须是 24 小时：修复前**窗边界日**（区间内部、被
      // 两个窗各覆盖一半的那个自然日）只有 16 小时，而整轮 status=complete、零 gap。
      // 首/末两日按构造就是部分日（区间起点/终点在日中），不算。
      const firstFull = shanghaiDayStart(rangeStart) + DAY
      const fullDays: string[] = []
      for (let d = firstFull; d + DAY <= rangeEnd; d += DAY) fullDays.push(shanghaiDayIso(d))
      expect(fullDays.length, '区间内部应当有 ≥39 个完整自然日').toBeGreaterThanOrEqual(39)
      const perDay = await store.query(
        'SELECT stat_date, COUNT(*) AS n FROM staff_attendance GROUP BY stat_date')
      const counts = new Map(perDay.rows.map((x) => [String(x.stat_date), Number(x.n)]))
      const bad = fullDays.filter((d) => counts.get(d) !== 24)
      expect(bad.map((d) => [d, counts.get(d)]), '这些完整自然日的小时行数不是 24').toEqual([])
      await store.close()
    } finally { vi.unstubAllGlobals() }
  })

  it('反向：日对齐窗（整日）删除范围不变 —— 整日内被撤掉的行仍会被删', async () => {
    const store = await fresh()
    const day0 = shanghaiDayStart(NOW - 10 * DAY)
    // 第一次：该日 24 小时全在
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? '{}')) as { startTime: number; endTime: number }
      const rows: unknown[] = []
      for (let t = Math.ceil(b.startTime / HOUR) * HOUR; t < b.endTime; t += HOUR) {
        rows.push({ staffId: 1, date: t })
      }
      return okC({ result: rows, sum: null, total: rows.length })
    }))
    try {
      await runTask(reportById('reports.staff_attendance')!, ctx(store, {
        rangeOverride: { start: day0, end: day0 + DAY },
      }))
      expect(Number((await store.query('SELECT COUNT(*) AS n FROM staff_attendance')).rows[0].n)).toBe(24)
      // 第二次：上游只报 12 小时（当天整日窗 → 删除范围仍是整日 → 撤掉的行必须消失）
      vi.stubGlobal('fetch', vi.fn(async (_u: string, init?: RequestInit) => {
        const b = JSON.parse(String(init?.body ?? '{}')) as { startTime: number; endTime: number }
        const rows: unknown[] = []
        for (let t = Math.ceil(b.startTime / HOUR) * HOUR; t < b.startTime + 12 * HOUR; t += HOUR) {
          rows.push({ staffId: 1, date: t })
        }
        return okC({ result: rows, sum: null, total: rows.length })
      }))
      await runTask(reportById('reports.staff_attendance')!, ctx(store, {
        rangeOverride: { start: day0, end: day0 + DAY },
      }))
      expect(Number((await store.query('SELECT COUNT(*) AS n FROM staff_attendance')).rows[0].n),
        '整日窗必须仍按整日删（陈旧行不得留下）').toBe(12)
      await store.close()
    } finally { vi.unstubAllGlobals() }
  })

  it('上游撤掉「半个边界日」里的某小时 → 重跑必须删掉该行（陈旧行不得留下）', async () => {
    // CodeRabbit #59 的边：窗起点不在日界的表（staff_attendance），若只删「完整落在窗内的
    // 自然日」，半个边界日里被上游撤掉的小时行会**永不删除**（upsert 删不掉不存在的行），
    // 整轮仍 complete。修法 = 按逐行 hour_ts ∈ [w.start, w.end) 精确删，本用例钉住。
    const store = await fresh()
    const rangeStart = shanghaiDayStart(NOW - 45 * DAY) + 11 * HOUR
    const rangeEnd = rangeStart + 40 * DAY
    const w2Start = rangeStart + 31 * DAY
    // 边界日 = 第二窗起始所在的上海自然日；H 取该日 14:00（第二窗的领地，> w2Start）
    const boundaryDay = shanghaiDayStart(w2Start)
    const H = boundaryDay + 14 * HOUR
    const mock = (withdrawH: boolean) => vi.fn(async (_u: string, init?: RequestInit) => {
      const b = JSON.parse(String(init?.body ?? '{}')) as { startTime: number; endTime: number }
      const rows: unknown[] = []
      for (let t = Math.ceil(b.startTime / HOUR) * HOUR; t < b.endTime; t += HOUR) {
        if (withdrawH && t === H) continue
        rows.push({ staffId: 1, date: t })
      }
      return okC({ result: rows, sum: null, total: rows.length })
    })
    try {
      vi.stubGlobal('fetch', mock(false))
      const r1 = await runTask(reportById('reports.staff_attendance')!, ctx(store, {
        rangeOverride: { start: rangeStart, end: rangeEnd },
      }))
      expect(r1.status, JSON.stringify(r1.gaps)).toBe('complete')
      expect(Number((await store.query(
        'SELECT COUNT(*) AS n FROM staff_attendance WHERE hour_ts = ?', [new Date(H).toISOString()],
      )).rows[0].n), '前置：H 行已落库').toBe(1)
      // 上游撤回 H → 重跑整段区间：只有第二窗覆盖 H
      vi.stubGlobal('fetch', mock(true))
      const r2 = await runTask(reportById('reports.staff_attendance')!, ctx(store, {
        rangeOverride: { start: rangeStart, end: rangeEnd },
      }))
      expect(r2.status, JSON.stringify(r2.gaps)).toBe('complete')
      expect(Number((await store.query(
        'SELECT COUNT(*) AS n FROM staff_attendance WHERE hour_ts = ?', [new Date(H).toISOString()],
      )).rows[0].n), '被撤回的小时行必须消失（修复前：陈旧行永留）').toBe(0)
      const day = await store.query(
        'SELECT COUNT(*) AS n FROM staff_attendance WHERE stat_date = ?',
        [shanghaiDayIso(boundaryDay)])
      expect(Number(day.rows[0].n), '边界日其余 23 小时一行不少').toBe(23)
      await store.close()
    } finally { vi.unstubAllGlobals() }
  })
})

describe('② staff_quality：必须分页拉满，短读不得静默 complete', () => {
  const staffRow = (i: number): Record<string, unknown> => ({ staffId: 1000000 + i, score: i })
  function pagedMock(total: number) {
    return vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? '{}')) as { page?: number }
      const page = body.page ?? 1
      const size = 1000
      const from = (page - 1) * size
      const n = Math.max(0, Math.min(size, total - from))
      const rows = Array.from({ length: n }, (_, k) => staffRow(from + k))
      return okC({ result: rows, sum: { evaluations: 123 }, total })
    })
  }

  // ⚠️ 范围必须**日界对齐**：staff_quality 声明 windowAlign='shanghaiDay'，非日界的首/末段
  // 是残段窗（跳过不 fetch）—— 用非对齐范围会得到 0 窗 complete，测不出分页。
  const DAY0 = shanghaiDayStart(NOW - 3 * DAY)
  const DAY_RANGE = { start: DAY0, end: DAY0 + DAY }

  it('上游 total=1500 → 两个页面都拉到、落库 1500 客服行 + 1 条 sum 全局行', async () => {
    const store = await fresh()
    const mock = pagedMock(1500)
    vi.stubGlobal('fetch', mock)
    try {
      const r = await runTask(reportById('reports.staff_quality')!, ctx(store, {
        rangeOverride: DAY_RANGE,
      }))
      expect(r.status, JSON.stringify(r.gaps)).toBe('complete')
      // 页数：修复前只发 1 次（不分页）
      expect(mock.mock.calls.length, 'staff_quality 只发了一次请求 —— 分页没生效').toBe(2)
      const n = Number((await store.query('SELECT COUNT(*) AS n FROM staff_quality')).rows[0].n)
      expect(n, '1500 行客服 + 1 行 sum 哨兵').toBe(1501)
      const sum = await store.query("SELECT stat_date, staff_id FROM staff_quality WHERE staff_id = 'sum'")
      expect(sum.rows.length, 'sum 全局行必须落库（与分页并行）').toBe(1)
      await store.close()
    } finally { vi.unstubAllGlobals() }
  })

  it('短读（声明 total=1500 但第二页为空）→ 显式失败，不静默 complete', async () => {
    const store = await fresh()
    let call = 0
    vi.stubGlobal('fetch', vi.fn(async () => {
      call++
      return okC(call === 1
        ? { result: Array.from({ length: 1000 }, (_, k) => staffRow(k)), sum: null, total: 1500 }
        : { result: [], sum: null, total: 1500 })
    }))
    try {
      const r = await runTask(reportById('reports.staff_quality')!, ctx(store, {
        rangeOverride: DAY_RANGE,
      }))
      expect(r.status, '短读必须落 gap、不得 complete').toBe('partial')
      expect(r.gaps.length).toBeGreaterThan(0)
      await store.close()
    } finally { vi.unstubAllGlobals() }
  })
})

describe('③ windowEndClamp 之外的窗必须计数可见（不得静默消失）', () => {
  it('只请求「今天」的 attendance → 计数与进度行都在场，而不是 total:0 complete', async () => {
    const store = await fresh()
    const lines: string[] = []
    // 「今天」（上海）整段都晚于末端上限（昨天 0:00）→ 全部窗被整窗丢弃。
    const r = await runTask(reportById('reports.staff_attendance')!, ctx(store, {
      rangeOverride: { start: shanghaiDayStart(NOW), end: NOW },
      onProgress: (m: string) => lines.push(m),
    }))
    expect(r.status).toBe('complete')
    expect(r.windows.total, '被上限整窗丢弃的窗必须计数（此前 total:0 静默）')
      .toBeGreaterThanOrEqual(1)
    expect(r.windows.skipped).toBe(r.windows.total)
    expect(r.rows).toEqual({ fetched: 0, written: 0 })
    expect(lines.join('\n'), '进度行必须点名「晚于末端上限」与窗区间')
      .toMatch(/整窗跳过（晚于末端上限/)
    await store.close()
  })
})

describe('④ order_performance：sum 哨兵行按天唯一（回补不得覆盖另一天的汇总）', () => {
  const okOrders = (money: number) => okC({
    orders: [{ orderId: 900001, sellMoney: money }], sum: { sellMoney: money }, total: 1,
  })

  it('先 day1 再回补 day0：两条 sum 行并存，各自的 payload 不被改写', async () => {
    const store = await fresh()
    const day0 = shanghaiDayStart(NOW - 5 * DAY)
    const day1 = day0 + DAY
    try {
      vi.stubGlobal('fetch', vi.fn(async () => okOrders(10)))
      await runTask(reportById('reports.order_performance')!, ctx(store, {
        rangeOverride: { start: day1, end: day1 + DAY },
      }))
      vi.stubGlobal('fetch', vi.fn(async () => okOrders(0)))
      await runTask(reportById('reports.order_performance')!, ctx(store, {
        rangeOverride: { start: day0, end: day0 + DAY },
      }))
      const sums = await store.query(
        "SELECT order_id, stat_date, payload FROM order_performance WHERE order_id LIKE 'sum%' ORDER BY stat_date")
      // 修复前：裸 'sum' 只有一行、被 day0 覆盖，day1 的汇总整体消失。
      expect(sums.rows.map((x) => x.stat_date)).toEqual([shanghaiDayIso(day0), shanghaiDayIso(day1)])
      expect(sums.rows.map((x) => JSON.parse(String(x.payload)).sellMoney)).toEqual([0, 10])
      await store.close()
    } finally { vi.unstubAllGlobals() }
  })
})
