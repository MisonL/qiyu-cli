// tests/sync/tasks-tickets.test.ts
// D-T9：工单任务（tickets/ticket_logs 两任务）—— op 窗口守卫（Review Focus 1 钉死）。
// 实测事实（设计稿 §10.1 / registry ticket.search note）：
//   ① opStart 被服务端静默钳到 now-31d —— op 窗口必须按 ≤31 天切片（90 天上限在诱导切 89 天窗）；
//   ② opEnd 缺省/为 0/只传一个/顺序颠倒 → 服务端不报错而返回全量 —— 必须在客户端守卫；
//   ③ limit=500 精确兑现、offset 可翻到 total；search 只识别 8 个参数；
//   ④ 工单水位必须用操作时间（opStart/opEnd），按创建时间增量永远拿不到状态变更；
//   ⑤ 水位续跑带 3 天回看重叠（覆盖乱序到达的日志/状态变更）。
// 真库夹具照 tests/store/duckdb.test.ts；http mock 照 tests/core/http.test.ts。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { runTask } from '../../src/sync/engine.js'
import { RateGate } from '../../src/sync/rate-gate.js'
import { TICKET_TASKS, taskById as ticketById, ticketBody } from '../../src/sync/tasks/tickets.js'
import { advanceWatermark, listGaps, readWatermark } from '../../src/sync/state.js'
import { __resetBuckets } from '../../src/core/http.js'
import { tableByName } from '../../src/store/schema.js'
import type { RunCtx, SyncTask, WindowRef } from '../../src/sync/types.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

vi.setConfig({ testTimeout: 15_000 })

const DAY = 86_400_000
/** 固定时钟（2023-11-14T22:13:20Z）：窗口一律相对 NOW 表达 ——
 * 修复批 1 起 tickets 声明了 windowStartFloorDays=31（C 中-2），
 * 相对 1970 的小毫秒窗口会被下界/守卫正确拒绝，测试必须用真实量级的时间戳。 */
const NOW = 1_700_000_000_000

let dir = ''
let cfg: StoreConfig
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-tickets-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30000, batchSize: 1000 }
  __resetBuckets()
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
    clock: () => NOW,
    // 缺省走「有真实起点的 1 天窗」（op 守卫要求 start>0）。
    rangeOverride: over.rangeOverride ?? { start: NOW - DAY, end: NOW },
    ...over,
  }
}

/** 无 rangeOverride 的上下文（水位续跑 / 首跑下界路径）。 */
function ctxNoOverride(store: Store, over: Partial<RunCtx> = {}): RunCtx {
  const c = ctx(store, over)
  delete c.rangeOverride
  return c
}

describe('schema v6 迁移 —— tickets / ticket_logs 两张表', () => {
  it('迁移后 tables() 含两张工单表；主键 ticket_id / (ticket_id, log_id)（重插幂等钉死）', async () => {
    const s = await fresh()
    const tables = await s.tables()
    expect(tables, '缺表 tickets').toContain('tickets')
    expect(tables, '缺表 ticket_logs').toContain('ticket_logs')
    const stamp = '2026-10-14T00:00:00.000Z'
    const ticketRow = () => ({ ticket_id: '900001', payload: null, crmUserName: null,
      crmUserPhone: null, crmUserEmail: null, userMobile: null, synchronized_at: stamp })
    await s.upsert('tickets', [ticketRow()])
    await s.upsert('tickets', [ticketRow()])
    expect(await s.count('tickets')).toBe(1)   // 同键重插不炸、不翻倍 —— 主键幂等
    await s.upsert('ticket_logs', [{ ticket_id: '900001', log_id: '1', payload: null, synchronized_at: stamp }])
    await s.upsert('ticket_logs', [{ ticket_id: '900001', log_id: '1', payload: null, synchronized_at: stamp }])
    expect(await s.count('ticket_logs')).toBe(1)
    await s.close()
  })

  it('工单域 PII 列（crmUserName/crmUserPhone/crmUserEmail）标注 sensitive: true（设计稿 §6.5）', () => {
    const t = tableByName('tickets')!
    for (const name of ['crmUserName', 'crmUserPhone', 'crmUserEmail']) {
      expect(t.columns.find((c) => c.name === name)?.sensitive, `${name}`).toBe(true)
    }
  })

  it('ticket_logs.payload 标注 sensitive: true（修复批 3：日志行是 PII 完整副本 —— ccList/toMailList/operatorId/正文）', () => {
    const t = tableByName('ticket_logs')!
    const payload = t.columns.find((c) => c.name === 'payload')!
    expect(payload.sensitive).toBe(true)
    // 键列不误标（sensitive 标记是 PII 载体标记，不是「整表敏感」）
    expect(t.columns.find((c) => c.name === 'ticket_id')?.sensitive).toBe(false)
    expect(t.columns.find((c) => c.name === 'log_id')?.sensitive).toBe(false)
  })
})

describe('TICKET_TASKS 任务声明', () => {
  it('共 2 任务：tickets 用 ticket.search、ticket_logs 逐工单拉日志（水位沿用 op 窗口）', () => {
    expect(TICKET_TASKS.map((t) => t.id).sort()).toEqual(['ticket.logs', 'tickets.search'].sort())
    const tickets = ticketById('tickets.search')!
    expect(tickets.kind).toBe('windowed')
    expect(tickets.table).toBe('tickets')
    expect(tickets.maxWindowDays).toBe(31)   // ≤31 天切片（90 天上限在诱导切 89 天窗，registry note）
    expect(tickets.overlapDays).toBe(3)      // 3 天回看重叠（乱序状态变更）
    expect(tickets.write).toEqual({ kind: 'upsertRows' })   // 工单按主键幂等 upsert（spec §4.2）
    expect(tickets.primaryKey).toEqual(['ticket_id'])
    const logs = ticketById('ticket.logs')!
    expect(logs.kind).toBe('windowed')
    expect(logs.table).toBe('ticket_logs')
    expect(logs.maxWindowDays).toBe(31)
    expect(logs.overlapDays).toBe(3)
    expect(logs.primaryKey).toEqual(['ticket_id', 'log_id'])
  })
})

describe('op 参数守卫（Review Focus 1 钉死：客户端 usage，零请求）', () => {
  it('opEnd 缺失 / 为 0 / opStart>opEnd → fetch 在构造 body 前抛 usage，绝不发请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const t = ticketById('tickets.search')!
      const cred = ctx(store).credentials
      // 三种静默全量形态：opEnd 缺失、opEnd=0、opStart>opEnd（顺序颠倒）。
      // 守卫在 fetch 内部构造 body 之前 —— 引擎与 T13 编排层同样被拦。
      for (const [label, ref] of [
        ['opEnd 缺失', { start: NOW - DAY, index: 0, total: 1 } as unknown as WindowRef],
        ['opEnd=0', { start: NOW - DAY, end: 0, index: 0, total: 1 } as WindowRef],
        ['顺序颠倒', { start: NOW, end: NOW - DAY, index: 0, total: 1 } as WindowRef],
        // C 中-2：opStart=0（1970 哨兵）同样必须拦下 —— 服务端会静默钳到 now−31d
        ['opStart<=0', { start: 0, end: NOW, index: 0, total: 1 } as WindowRef],
      ] as Array<[string, WindowRef]>) {
        await expect(t.fetch(ref, { store, credentials: cred }), label)
          .rejects.toMatchObject({ kind: 'usage' })
      }
      expect(fetchMock.mock.calls.length, '零请求 —— 静默全量必须在客户端拦死').toBe(0)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ticketBody —— 请求体事实在签名里（http mock 只见 URL）', () => {
  it('合法窗口 → body 恰为 opStart/opEnd（毫秒）+ limit=500 + offset；无其余参数（search 只识别 8 个）', () => {
    const w: WindowRef = { start: DAY, end: 2 * DAY, index: 0, total: 1 }
    const body = ticketBody('tickets.search', w, 0) as Record<string, unknown>
    expect(body).toEqual({ opStart: DAY, opEnd: 2 * DAY, limit: 500, offset: 0 })
  })

  it('翻页 offset 按 total 收敛推进（limit=500 精确兑现）', () => {
    const w: WindowRef = { start: 0, end: DAY, index: 0, total: 1 }
    expect((ticketBody('tickets.search', w, 1000) as Record<string, unknown>).offset).toBe(1000)
  })
})

describe('op 窗口切片与 3 天回看（runTask 全链路，http mock）', () => {
  /** 形状 C 夹具：message 是 JSON 字符串（ticket.search 实测信封）。 */
  function okC(payload: unknown) {
    return Promise.resolve(new Response(JSON.stringify({
      code: 200, message: JSON.stringify(payload),
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
  }

  it('90 天诱导场景：按 ≤31 天切片 + 3 天重叠 → 4 窗（90/31 直接切会被静默钳制少取 ~58 天）', async () => {
    // sliceByMaxWindow(90d, 31, 3) = [0,31],[28,59],[56,87],[84,90] —— 4 窗、无包含窗
    const fetchMock = vi.fn(() => okC({ total: 0, tickets: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(ticketById('tickets.search')!, ctx(store, {
        rangeOverride: { start: NOW - 90 * DAY, end: NOW },
      }))
      expect(r.windows.total).toBe(4)
      expect(r.status).toBe('complete')
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('回看重叠 3 天：预置水位后续跑，首个窗口起点 = watermark − 3 天', async () => {
    const store = await fresh()
    // 预置水位在 NOW − 10 天（上一轮已同步到那里）
    await store.transaction(async (tx) => {
      await advanceWatermark(tx, 'tickets.search', new Date(NOW - 10 * DAY).toISOString(),
        { start: 0, end: NOW - 10 * DAY }, new Date().toISOString())
    })
    const starts: number[] = []
    vi.stubGlobal('fetch', vi.fn(() => okC({ total: 0, tickets: [] })))
    try {
      const t: SyncTask = { ...ticketById('tickets.search')! }
      const orig = t.fetch
      t.fetch = async (w, c) => { starts.push(w.start); return orig(w, c) }
      // 无显式区间 → 水位续跑路径（B 中-5：显式区间优先于水位，这里刻意不给区间）
      await runTask(t, ctxNoOverride(store))
      // 水位 NOW−10d，3 天回看 → 首窗起点 = (水位+1ms) − 3 天 = NOW − 13d + 1ms
      expect(starts[0]).toBe(NOW - 13 * DAY + 1)
      expect((await readWatermark(store, 'tickets.search')).watermark)
        .toBe(new Date(NOW).toISOString())
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('C 中-2：首跑（水位为空、无显式区间）起点抬到 now − 31 天，不再发 opStart=0', async () => {
    const store = await fresh()
    const bodies: Array<Record<string, unknown>> = []
    vi.stubGlobal('fetch', vi.fn((_url: unknown, init: unknown) => {
      bodies.push(JSON.parse(String((init as { body?: string }).body ?? '{}')) as Record<string, unknown>)
      return okC({ total: 0, tickets: [] })
    }))
    try {
      const r = await runTask(ticketById('tickets.search')!, ctxNoOverride(store))
      expect(r.status).toBe('complete')
      // 抬升后的起点如实回显（31 天前），绝不是 1970
      expect(r.resolvedRange.start).toBe(NOW - 31 * DAY)
      // 每个窗口的 opStart 都是正数（守卫不会被触发）
      expect(bodies.length).toBeGreaterThan(0)
      for (const b of bodies) expect(Number(b.opStart)).toBeGreaterThan(0)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('C 中-2：请求的 end 早于下界（--until 指向更早）→ 不抬升、显式失败落 gap（不静默 0 窗 complete）', async () => {
    const store = await fresh()
    vi.stubGlobal('fetch', vi.fn(() => okC({ total: 0, tickets: [] })))
    try {
      // end 落在下界之前 40 天 → 抬升会把「拿不到的历史」变成「0 窗 complete」；
      // 正确行为是保持哨兵起点 → 守卫显式失败 → gap 可见。
      const r = await runTask(ticketById('tickets.search')!, ctx(store, {
        rangeOverride: { start: 0, end: NOW - 40 * DAY },
      }))
      expect(r.status).toBe('partial')
      expect(r.resolvedRange.start).toBe(0)
      expect(r.gaps.length).toBeGreaterThan(0)
      expect(r.gaps[0].reason).toBe('fetch_failed')
      expect(r.gaps[0].detail).toMatch(/op 窗口无效/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('tickets.search：分页 total 收敛拉满（2 行 → offset 翻页取第 3 行）+ ticket_id 主键落库', async () => {
    // 首页 2 行（total=3）→ offset=500 取第 3 行（limit=500）
    const row = (id: number) => ({ id, title: `工单${id}`, status: 20 })
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => okC({ total: 3, tickets: [row(900001), row(900002)] }))
      .mockImplementationOnce(() => okC({ total: 3, tickets: [row(900003)] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(ticketById('tickets.search')!, ctx(store, {
        rangeOverride: { start: NOW - DAY, end: NOW },
      }))
      expect(r.status).toBe('complete')
      expect(r.rows.written).toBe(3)
      expect(fetchMock.mock.calls.length).toBe(2)
      const rows = await store.query('SELECT ticket_id FROM tickets ORDER BY ticket_id')
      expect(rows.rows.map((x) => x.ticket_id)).toEqual(['900001', '900002', '900003'])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ticket.logs：按窗口内 touched 工单逐张拉日志（响应 data 数组），行补 ticket_id/log_id（缺 id 行丢弃）', async () => {
    // 第一调：search 返回 2 张工单；后续各调：log 返回该单的日志（id 即日志 id）
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => okC({ total: 2, tickets: [{ id: 900001 }, { id: 900002 }] }))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'OK',
        data: [{ id: 11, action: '更新工单', actionType: 100, operator: '测试甲', operatorId: 1000002, time: 1 }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'OK',
        data: [{ action: '无 id 的脏行' }],   // 缺 id → 丢弃且不计入 fetched（口径与 apiCount 一致）
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(ticketById('ticket.logs')!, ctx(store, {
        rangeOverride: { start: NOW - DAY, end: NOW },
      }))
      expect(r.status).toBe('complete')
      expect(r.rows).toEqual({ fetched: 1, written: 1 })
      const rows = await store.query('SELECT ticket_id, log_id FROM ticket_logs')
      expect(rows.rows).toEqual([{ ticket_id: '900001', log_id: '11' }])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ticket.logs 形态漂移：log 载荷非数组且无 data → 显式失败（不静默 complete，fix 中-1 钉死）', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => okC({ total: 1, tickets: [{ id: 900001 }] }))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'OK', data: null,   // data 键存在但不是数组 → 第三形态
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(ticketById('ticket.logs')!, ctx(store, {
        rangeOverride: { start: NOW - DAY, end: NOW },
      }))
      expect(r.status, '形态漂移必须可见：引擎记 gap 后 partial，绝不静默 complete').toBe('partial')
      const gaps = await listGaps(store, 'ticket.logs')
      expect(gaps.length).toBe(1)
      expect(gaps[0].reason).toBe('fetch_failed')
      expect(gaps[0].detail).toMatch(/data 数组|null/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('C 中-3：分页短读（声明 total=5 只拿到 1 行 → 空页）→ 显式失败落 gap，不当合法空窗', async () => {
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => okC({ total: 5, tickets: [{ id: 900001 }] }))
      .mockImplementationOnce(() => okC({ total: 5, tickets: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(ticketById('tickets.search')!, ctx(store, {
        rangeOverride: { start: NOW - DAY, end: NOW },
      }))
      expect(r.status).toBe('partial')
      expect(r.rows.written).toBe(0)          // 本窗回滚，绝不半写
      const gaps = await listGaps(store, 'tickets.search')
      expect(gaps.length).toBe(1)
      expect(gaps[0].detail).toMatch(/短读/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('C 中-13：total 恒大于已取行数（每页只回 1 行）→ 翻页上限终止，不无限翻页', async () => {
    // 声明 total=3000（上限 = ceil(3000/500)+5 = 11 页），每页只回 1 行且永不收敛 ——
    // 没有上限就是无限翻页（服务端 limit=500 精确兑现，这里模拟形态漂移）。
    const fetchMock = vi.fn(() => okC({ total: 3000, tickets: [{ id: 900000 }] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(ticketById('tickets.search')!, ctx(store, {
        rangeOverride: { start: NOW - DAY, end: NOW },
      }))
      expect(r.status).toBe('partial')
      // 有界：初次 + 10 次（上限 11 页）——绝不无限翻页
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(11)
      const gaps = await listGaps(store, 'tickets.search')
      expect(gaps[0].detail).toMatch(/翻页超限/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('C 低-7：空串/缺 id 的工单行丢弃（空串会写成能被反复覆盖的同键行）', async () => {
    const fetchMock = vi.fn(() => okC({
      total: 3, tickets: [{ id: '' }, { id: null }, { id: 900001 }],
    }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(ticketById('tickets.search')!, ctx(store, {
        rangeOverride: { start: NOW - DAY, end: NOW },
      }))
      expect(r.status).toBe('complete')
      expect(r.rows.written).toBe(1)
      const rows = await store.query('SELECT ticket_id FROM tickets')
      expect(rows.rows).toEqual([{ ticket_id: '900001' }])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
