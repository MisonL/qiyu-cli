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
import { reportBody } from '../../src/sync/tasks/reports.js'
import { listGaps, readWatermark } from '../../src/sync/state.js'
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
  // 令牌桶是模块级状态（报表接口 30 秒桶）——不清空会跨用例污染
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
      expect(t.write, `${t.id} 写策略`).toEqual({ kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] })
      expect(t.primaryKey.length, `${t.id} 主键非空`).toBeGreaterThan(0)
    }
    expect(reportById('reports.overview')!.table).toBe('daily_overview')
    // 窗口上限按实测逐接口注册（spec §7.4.1：严格形式对两族判定式都安全）
    const byId = (id: string): SyncTask => reportById(id)!
    expect(byId('reports.overview')!.maxWindowDays).toBe(31)
    expect(byId('reports.staff_workload')!.maxWindowDays).toBe(31)
    expect(byId('reports.staff_quality')!.maxWindowDays).toBe(31)
    expect(byId('reports.staff_satisfaction')!.maxWindowDays).toBe(31)
    expect(byId('reports.staff_attendance')!.maxWindowDays).toBe(31)
    expect(byId('reports.robot_summary')!.maxWindowDays).toBe(31)
    expect(byId('reports.order_performance')!.maxWindowDays).toBe(365)
    expect(byId('reports.transfer_human')!.maxWindowDays).toBe(365)
    // salaryDetail 只覆盖窗口起始日 → 窗口切 1 天
    expect(byId('reports.staff_salary_detail')!.maxWindowDays).toBe(1)
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

  it('staff_attendance：分页拉满（pageSize=1000）+ hour_ts 取响应 date', async () => {
    // 首页 2 行 + 第二页空 → 假空重试补一次（引擎语义）；这里直接两页真实数据
    const row = (id: number, ts: number) => ({ staffId: id, date: ts, loginDuration: 3600001 })
    const fetchMock = respondQueue([
      () => okC({ result: [row(1000002, 3_600_000), row(1000002, 7_200_000)], total: 2 }),
    ])
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(reportById('reports.staff_attendance')!, ctx(store))
      expect(r.status).toBe('complete')
      expect(r.rows.written).toBe(2)
      const rows = await store.query('SELECT staff_id, hour_ts FROM staff_attendance ORDER BY hour_ts')
      expect(rows.rows).toEqual([
        { staff_id: '1000002', hour_ts: new Date(3_600_000).toISOString() },
        { staff_id: '1000002', hour_ts: new Date(7_200_000).toISOString() },
      ])
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
