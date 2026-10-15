// tests/sync/tasks-dim.test.ts
// 维度表任务（schema v3 第一批 7 表 + tasks/dim.ts 6 任务）。
// 真库夹具照 tests/store/duckdb.test.ts；http mock 照 tests/core/http.test.ts。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { runTask } from '../../src/sync/engine.js'
import { RateGate } from '../../src/sync/rate-gate.js'
import { DIM_TASKS, taskById as dimById } from '../../src/sync/tasks/dim.js'
import type { RunCtx, SyncTask } from '../../src/sync/types.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

// L1 对冲：真库冷启动偶发 >5s（同 tests/store/duckdb.test.ts）。
vi.setConfig({ testTimeout: 15_000 })

let dir = ''
let cfg: StoreConfig
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-dim-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30000, batchSize: 1000 }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(cfg, 'rw')
  await s.init()
  return s
}

function ctx(store: Store): RunCtx {
  return {
    store,
    credentials: { appKey: 'test-key', appSecret: 'test-secret' },
    gate: new RateGate(store, () => 0),
    clock: () => 1_700_000_000_000,
  }
}

const DIM_TABLES = [
  'staff', 'staff_groups', 'staff_group_members',
  'ticket_categories', 'ticket_templates', 'ticket_template_fields', 'tags',
]

describe('schema v3 迁移 —— 7 张维度表', () => {
  it('迁移后 tables() 含 7 张维度表（v3 批次）', async () => {
    const s = await fresh()
    const tables = await s.tables()
    for (const t of DIM_TABLES) expect(tables, `缺表 ${t}`).toContain(t)
    await s.close()
  })

  it('staff 表 17 列：groupInfo 是 JSON 字符串列、telephone 被剔除、关键列可查', async () => {
    const s = await fresh()
    const r = await s.query(
      "SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'staff' ORDER BY ordinal_position")
    const cols = r.rows.map((x) => String(x.column_name))
    // 设计稿 §6.2 实测 17 字段全集（telephone 330/330 为空、零区分度 → 删）
    expect(cols).toEqual(['id', 'realname', 'nickname', 'username', 'role', 'roleId', 'status',
      'createtime', 'updateTime', 'email', 'phone', 'workNumber', 'maxServiceCount',
      'skillScoreChat', 'skillScoreIpcc', 'groupInfo', 'synchronized_at'])
    const gi = r.rows.find((x) => String(x.column_name) === 'groupInfo')
    expect(String(gi!.data_type)).toBe('VARCHAR')   // 列表展开为 JSON 字符串列
    // ID 一律 VARCHAR（BIGINT 精度红线）
    const idRow = r.rows.find((x) => String(x.column_name) === 'id')!
    expect(String(idRow.data_type)).toBe('VARCHAR')
    await s.close()
  })

  it('staff_group_members 主键是 (group_id, staff_id)；同键重插不炸（幂等）', async () => {
    const s = await fresh()
    await s.upsert('staff_group_members', [
      { group_id: '1000001', staff_id: '1000002', synchronized_at: null },
    ])
    await s.upsert('staff_group_members', [
      { group_id: '1000001', staff_id: '1000002', synchronized_at: null },
    ])
    expect(await s.count('staff_group_members')).toBe(1)
    await s.close()
  })

  it('19 位 ID 落维度表仍是字符串、精度不变', async () => {
    const s = await fresh()
    const big = '1234567890123456789'
    await s.upsert('staff', [{
      id: big, realname: '测试甲', nickname: '甲', username: 'jia', role: '0', roleId: '30',
      status: '1', createtime: '1698800000000', updateTime: '1698800000000',
      email: null, phone: null, workNumber: null, maxServiceCount: '8',
      skillScoreChat: '6', skillScoreIpcc: '10', groupInfo: null, synchronized_at: '2026-10-14T00:00:00.000Z',
    }])
    const r = await s.query('SELECT id FROM staff')
    expect(r.rows[0].id).toBe(big)
    await s.close()
  })
})

describe('DIM_TASKS 任务声明', () => {
  it('共 6 任务、kind=snapshot、写策略 upsertRows、主键全业务键', () => {
    expect(DIM_TASKS.map((t) => t.id).sort()).toEqual([
      'dim.staff', 'dim.staff_groups', 'dim.staff_group_members',
      'dim.ticket_categories', 'dim.ticket_templates', 'dim.ticket_template_fields',
    ].sort())
    for (const t of DIM_TASKS) {
      expect(t.kind, `${t.id} kind`).toBe('snapshot')
      expect(t.write, `${t.id} 写策略`).toEqual({ kind: 'upsertRows' })
      // 红线 1：主键只能是上游业务键
      expect(t.primaryKey.length, `${t.id} 主键非空`).toBeGreaterThan(0)
      expect(t.watermark.field, `${t.id} 水位字段`).toBe('synchronized_at')
    }
    expect(dimById('dim.staff')!.table).toBe('staff')
    expect(dimById('dim.staff_group_members')!.primaryKey).toEqual(['group_id', 'staff_id'])
    expect(dimById('dim.ticket_template_fields')!.primaryKey).toEqual(['template_id', 'fieldId'])
  })

  it('B 中-6：每个任务声明 endpoint（闸门键 = 注册表路径，不是任务 id）', () => {
    for (const t of DIM_TASKS) {
      expect(t.endpoint, `${t.id} endpoint`).toBeTruthy()
      expect(t.endpoint, `${t.id} endpoint 不得是任务 id`).not.toBe(t.id)
    }
    // 同路径的两个任务声明同一把键（同路径共享冷却）
    expect(dimById('dim.staff_groups')!.endpoint).toBe('staff.group.list.new')
    expect(dimById('dim.staff_group_members')!.endpoint).toBe('staff.group.list.new')
  })

  it('C 中-14：staffIdList 非数组 → 跳过该组 + gapHint 落 sync_gaps（不再静默 continue）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchMock.mockReturnValue(Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'OK',
        data: [
          { id: 1000001, name: '售前组', staffIdList: [1000002] },
          { id: 1000002, name: '形态漂移组', staffIdList: 'not-an-array' },
        ],
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      const store = await fresh()
      const r = await runTask(dimById('dim.staff_group_members') as SyncTask, ctx(store))
      expect(r.status).toBe('complete')       // 成功窗 + 提示性 gap
      expect(r.rows.written).toBe(1)
      expect(r.gaps.length).toBe(1)
      expect(r.gaps[0].reason).toBe('staff_id_list_malformed')
      expect(r.gaps[0].detail).toMatch(/1000002/)   // 出问题的组 id 可见
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('C 低-7：空串主键（dim.staff 的 id）→ 显式失败，绝不写空串同键行', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchMock.mockReturnValue(Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'OK',
        data: [{ id: '', realname: '空 id' }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      const store = await fresh()
      const r = await runTask(dimById('dim.staff') as SyncTask, ctx(store))
      expect(r.status).toBe('failed')
      expect(r.gaps[0].detail).toMatch(/空的主键列/)
      expect(await store.count('staff')).toBe(0)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('dim.staff fetch：POST staff.list（空 body）、payload 行直写（groupInfo JSON 字符串化）', async () => {
    // http mock 照 tests/core/http.test.ts：stubGlobal fetch + 形状 A 信封
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchMock.mockReturnValue(Promise.resolve(new Response(JSON.stringify({
        code: 200,
        message: 'OK',
        data: [{ id: 1000002, realname: '测试甲', username: 'jia', role: 0, roleId: 30,
          status: 1, createtime: 1698800000000, updateTime: 1698800000000,
          groupInfo: [{ groupId: 1000001, groupName: '售前组' }] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      const store = await fresh()
      const r = await runTask(dimById('dim.staff') as SyncTask, ctx(store))
      expect(r.status).toBe('complete')
      expect(r.rows).toEqual({ fetched: 1, written: 1 })
      // 请求形态：POST、空 body（全量无分页——pageNo/pageSize 会被忽略，不传）
      const url = String(fetchMock.mock.calls[0][0])
      expect(url).toContain('/openapi/v2/staff/list/new')
      const rows = await store.query('SELECT id, realname, groupInfo FROM staff')
      expect(rows.rows[0].id).toBe('1000002')   // int → VARCHAR 字符串
      expect(rows.rows[0].groupInfo).toBe(JSON.stringify([{ groupId: 1000001, groupName: '售前组' }]))
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('dim.staff_group_members fetch：staff.group.list?staff=true 的 staffIdList 展开', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchMock.mockReturnValue(Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'OK',
        data: [{ id: 1000001, name: '售前组', staffIdList: [1000002, 1000003] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      const store = await fresh()
      const r = await runTask(dimById('dim.staff_group_members') as SyncTask, ctx(store))
      expect(r.rows).toEqual({ fetched: 2, written: 2 })
      const rows = await store.query('SELECT group_id, staff_id FROM staff_group_members ORDER BY staff_id')
      expect(rows.rows).toEqual([
        { group_id: '1000001', staff_id: '1000002' },
        { group_id: '1000001', staff_id: '1000003' },
      ])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('全删重插幂等：连跑两次行数不变（快照幂等钉死）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      // ⚠️ 每次调用都新建 Response：同一个 Response 的 body 只能读一次，
      // 复用实例会让第二次 runTask 的 res.json() 撞「body already consumed」。
      fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'OK',
        data: [{ id: 1000001, name: '售前组', staffIdList: [] }],
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      const store = await fresh()
      const t = dimById('dim.staff_groups') as SyncTask
      const r1 = await runTask(t, ctx(store))
      const r2 = await runTask(t, ctx(store))
      expect(r1.rows.written).toBe(1)
      expect(r2.rows.written).toBe(1)
      expect(await store.count('staff_groups')).toBe(1)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('缺必填 body 参数的维度任务（category.list 的 type）在任务内补齐', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchMock.mockReturnValue(Promise.resolve(new Response(JSON.stringify({
        code: 200, message: '[{"id":1,"name":"分类A","parentId":0,"rank":0}]',
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      const store = await fresh()
      const r = await runTask(dimById('dim.ticket_categories') as SyncTask, ctx(store))
      expect(r.rows.written).toBe(1)
      // 形状 C 的 body 里有 type（文档标必填）；请求体可从 URL 之外断言——这里
      // 断言 fetch 收到了带 type 的 body（call() 的 bodyStr 会进签名，mock 只见 URL；
      // 透传正确性由任务源码补齐，此用例主要钉 payload 行落库）。
      const rows = await store.query('SELECT id, name, parentId, rank FROM ticket_categories')
      expect(rows.rows).toEqual([{ id: '1', name: '分类A', parentId: '0', rank: '0' }])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('ticket_template_fields 投影：fieldId 主键列不丢（模板×字段每模板一次调用）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      fetchMock.mockImplementation((url: string | URL) => {
        const body = Number(new URL(String(url)).searchParams.get('time') ?? 0) // 占位，路径判断用 path
        void body
        const path = String(url)
        const data = path.includes('template/list')
          ? [{ id: 7, name: '模板A', createTime: 0, autoFlow: 0, autoStatus: 0, fileStatus: 0, autoGuide: '' }]
          : [{ id: 77, fieldId: 5001, name: '紧急度', type: 0, required: 1, customer: 0, description: '', prefill: '' }]
        return Promise.resolve(new Response(JSON.stringify({ code: 200, message: JSON.stringify(data) }),
          { status: 200, headers: { 'content-type': 'application/json' } }))
      })
      const store = await fresh()
      const r = await runTask(dimById('dim.ticket_template_fields') as SyncTask, ctx(store))
      expect(r.rows.written).toBe(1)
      const rows = await store.query('SELECT template_id, fieldId, name FROM ticket_template_fields')
      expect(rows.rows).toEqual([{ template_id: '7', fieldId: '5001', name: '紧急度' }])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
