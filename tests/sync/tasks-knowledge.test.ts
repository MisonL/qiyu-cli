// tests/sync/tasks-knowledge.test.ts
// D-T11：知识库 3 快照任务（knowledge.items / knowledge.points / knowledge.categories）。
// 实测事实（设计稿 §10.5 / spec §5.4）：
//   ① robot.data.knowledge 与 robot.data.kpoint 都是**游标分页**（mid+size≤1000、
//      mid 严格大于上一页末行 id、isEnd=1 终止）；信封形状 C（message 是 JSON 字符串，
//      归一化在 core/envelope 层完成，任务代码不二次猜测）；
//   ② **robot.data.knowledge 的 robotId 被静默忽略**（实测 A/B：传与不传 total 相同）——
//      含 robotId 的参数必须 usage 拒绝、绝不透传（静默丢弃比报错更危险：看起来像成功）；
//   ③ knowledge_items 是全部机器人的**并集**，knowledge_categories **按 robotId 隔离**——
//      两个接口语义不同，categories 驱动序来自 knowledge_items 落库后的 DISTINCT robot_id；
//   ④ getCategoryTree 空树（知识库为空的机器人）返回 {code:200,message:"success"} 且**无
//      data 键**——是合法状态（not_found），不是错误；
//   ⑤ 计数红线：**测试断言不变量，不硬编码行数**（12778 等实测计数绝不入测试）。
// 真库夹具照 tests/store/duckdb.test.ts；http mock 照 tests/core/http.test.ts。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { runTask } from '../../src/sync/engine.js'
import { RateGate } from '../../src/sync/rate-gate.js'
import { KNOWLEDGE_TASKS, taskById as knowledgeById } from '../../src/sync/tasks/knowledge.js'
import { __resetBuckets } from '../../src/core/http.js'
import { __setSleep } from '../../src/sync/tasks/knowledge.js'
import { tableByName } from '../../src/store/schema.js'
import type { RunCtx, SyncTask, WindowRef } from '../../src/sync/types.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

vi.setConfig({ testTimeout: 15_000 })

let dir = ''
let cfg: StoreConfig
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-knowledge-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30000, batchSize: 1000 }
  // 令牌桶是模块级状态（robot.data.knowledge 冷却 180 秒）——不清空会跨用例污染；
  // 任务内多次调用（翻页/逐机器人）的冷却等待注入零耗时，测试可确定性断言
  __resetBuckets()
  // 注入的 sleep 代表「等满了 retryAfter」——令牌桶按真实时钟计窗，
  // 测试用清桶模拟时间推进（与真实等待后放行等价）
  __setSleep(async () => { __resetBuckets() })
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

/** 形状 C 夹具：message 是 JSON 字符串（robot.data.knowledge / kpoint 实测信封）。 */
function okC(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify({
    code: 200, message: JSON.stringify(payload),
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
}
/** 形状 A 夹具（ai.knowledge.getCategoryTree）。 */
function okA(data: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ code: 200, message: 'OK', data }),
    { status: 200, headers: { 'content-type': 'application/json' } }))
}

/** 取 mock 收到的第 i 个请求体（JSON 字符串 → 对象）。 */
function bodyOf(fetchMock: { mock: { calls: unknown[][] } }, i: number): Record<string, unknown> {
  const opt = fetchMock.mock.calls[i]![1] as { body?: string }
  return JSON.parse(opt.body ?? '{}') as Record<string, unknown>
}

describe('schema v8 迁移 —— 知识库 3 张表', () => {
  it('迁移后 tables() 含三张知识库表；主键 items/points=id、categories=(robot_id, category_id)', async () => {
    const s = await fresh()
    const tables = await s.tables()
    expect(tables, '缺表 knowledge_items').toContain('knowledge_items')
    expect(tables, '缺表 knowledge_points').toContain('knowledge_points')
    expect(tables, '缺表 knowledge_categories').toContain('knowledge_categories')
    // 主键幂等（红线 1：全业务键）——同键重插不翻倍
    const stamp = '2026-10-15T00:00:00.000Z'
    const itemRow = () => ({ id: '20000101', robot_id: '1000001', robot_name: '机器人A',
      type: 1, group_id: '300001', ref_id: '20000101', point_id: null,
      payload: null, synchronized_at: stamp })
    await s.upsert('knowledge_items', [itemRow()])
    await s.upsert('knowledge_items', [itemRow()])
    expect(await s.count('knowledge_items')).toBe(1)
    await s.upsert('knowledge_points', [{ id: '400001', payload: null, synchronized_at: stamp }])
    await s.upsert('knowledge_points', [{ id: '400001', payload: null, synchronized_at: stamp }])
    expect(await s.count('knowledge_points')).toBe(1)
    const catRow = () => ({ robot_id: '1000001', category_id: '500001', name: '类目A',
      parent_id: null, level: 1, payload: null, synchronized_at: stamp })
    await s.upsert('knowledge_categories', [catRow()])
    await s.upsert('knowledge_categories', [catRow()])
    expect(await s.count('knowledge_categories')).toBe(1)
    await s.close()
  })

  it('knowledge_items 列集：键列 id/robot_id/group_id NOT NULL（information_schema 反射）', async () => {
    const s = await fresh()
    const r = await s.query(
      "SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name = 'knowledge_items' ORDER BY ordinal_position")
    const rows = (r.rows as Array<{ column_name: string; is_nullable: string }>)
    for (const name of ['id', 'robot_id', 'group_id']) {
      const c = rows.find((x) => x.column_name === name)
      expect(c, `缺列 ${name}`).toBeDefined()
      expect(c!.is_nullable, `${name} 应 NOT NULL`).toBe('NO')
    }
    await s.close()
  })

  it('TABLES 定义：items/points 主键各为 id；categories 主键为 (robot_id, category_id)', () => {
    expect(tableByName('knowledge_items')!.primaryKey).toEqual(['id'])
    expect(tableByName('knowledge_points')!.primaryKey).toEqual(['id'])
    expect(tableByName('knowledge_categories')!.primaryKey).toEqual(['robot_id', 'category_id'])
  })
})

describe('KNOWLEDGE_TASKS 任务声明', () => {
  it('共 3 任务、kind=snapshot、write 幂等 upsert（引擎快照路径全删重插）', () => {
    expect(KNOWLEDGE_TASKS.map((t) => t.id).sort())
      .toEqual(['knowledge.categories', 'knowledge.items', 'knowledge.points'].sort())
    const items = knowledgeById('knowledge.items')!
    expect(items.kind).toBe('snapshot')
    expect(items.table).toBe('knowledge_items')
    expect(items.primaryKey).toEqual(['id'])
    expect(items.write).toEqual({ kind: 'upsertRows' })
    const points = knowledgeById('knowledge.points')!
    expect(points.kind).toBe('snapshot')
    expect(points.table).toBe('knowledge_points')
    const cats = knowledgeById('knowledge.categories')!
    expect(cats.kind).toBe('snapshot')
    expect(cats.table).toBe('knowledge_categories')
    expect(cats.primaryKey).toEqual(['robot_id', 'category_id'])
  })
})

describe('robotId 透传拒绝（items/kpoint 的 robotId 被静默忽略，usage 拦截、零请求）', () => {
  it('ref 参数携带 robotId → fetch 在构造 body 前抛 usage，绝不发请求（items + points）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const cred = ctx(store).credentials
      for (const id of ['knowledge.items', 'knowledge.points']) {
        const t = knowledgeById(id)!
        const ref = { start: 0, end: 1, index: 0, total: 1, robotId: 1000002 } as unknown as WindowRef
        await expect(t.fetch(ref, { store, credentials: cred }), id)
          .rejects.toMatchObject({ kind: 'usage' })
      }
      expect(fetchMock.mock.calls.length, '零请求 —— 静默忽略的参数必须在客户端拦死').toBe(0)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('游标分页（mid 严格大于 + isEnd=1 终止，size≤1000）', () => {
  it('knowledge.items：mock 三页（第三页 isEnd=1）→ rows 合并、mid 链严格递增（上一页末行 id）', async () => {
    // 行数是夹具变量（不变量断言），不是硬编码实测计数
    const p1 = [{ id: 11, groupId: 'g1', robotId: 1000001, robotName: 'A', type: 1, refId: 11, pointId: null },
      { id: 12, groupId: 'g2', robotId: 1000001, robotName: 'A', type: 10, refId: 11, pointId: null }]
    const p2 = [{ id: 20, groupId: 'g3', robotId: 1000002, robotName: 'B', type: 1, refId: 20, pointId: 400001 },
      { id: 25, groupId: 'g4', robotId: 1000002, robotName: 'B', type: 1, refId: 25, pointId: null }]
    const p3 = [{ id: 31, groupId: 'g5', robotId: 1000003, robotName: 'C', type: 1, refId: 31, pointId: null }]
    const totalRows = p1.length + p2.length + p3.length
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => okC({ total: totalRows, data: p1, isEnd: 0 }))
      .mockImplementationOnce(() => okC({ total: totalRows, data: p2, isEnd: 0 }))
      .mockImplementationOnce(() => okC({ total: totalRows, data: p3, isEnd: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const t = knowledgeById('knowledge.items')!
      const res = await t.fetch({ start: 0, end: 1, index: 0, total: 1 }, ctx(store))
      // 不变量：合并行数 == mock 提供的行数（不硬编码 12778 等实测数字）
      expect(res.rows.length).toBe(totalRows)
      // mid 链：0 → 上一页末行 id → 上一页末行 id（严格递增）；size ≤ 1000；body 不含 robotId
      const mids = [0, 1, 2].map((i) => bodyOf(fetchMock, i).mid) as number[]
      expect(mids).toEqual([0, 12, 25])
      for (let i = 1; i < mids.length; i++) expect(mids[i]!).toBeGreaterThan(mids[i - 1]!)
      for (let i = 0; i < 3; i++) {
        expect(bodyOf(fetchMock, i).size).toBe(1000)
        expect('robotId' in bodyOf(fetchMock, i)).toBe(false)
      }
      // 落库行形状：id/robot_id/group_id 提升列 + payload 收敛（VARCHAR 红线：ID 字符串化）
      expect(res.rows[0]).toMatchObject({ id: '11', robot_id: '1000001', group_id: 'g1', ref_id: '11' })
      expect(typeof (res.rows[0] as Record<string, unknown>).payload).toBe('string')
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('knowledge.points：单页 isEnd=1 一次拉完；行只投影 id（kpoint 无 robotId 键）', async () => {
    const kp = [{ id: 400001, title: '知识点甲', content: '内容', enabled: 1,
      categoryInfo: { id: 9, name: '类目' }, updateTime: 1700000000 }]
    const fetchMock = vi.fn().mockImplementationOnce(() => okC({ total: kp.length, data: kp, isEnd: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const res = await knowledgeById('knowledge.points')!
        .fetch({ start: 0, end: 1, index: 0, total: 1 }, ctx(store))
      expect(res.rows.length).toBe(kp.length)   // 不变量：等于 mock 行数
      expect(res.rows[0]).toMatchObject({ id: '400001' })
      expect(await store.count('knowledge_points')).toBe(0)   // 直调 fetch 不落库
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('形态漂移显式失败：单页 0 行但 isEnd=0 → 终止循环（不翻页死循环），显式报 total 不符', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okC({ total: 5, data: [], isEnd: 0 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      await expect(knowledgeById('knowledge.items')!
        .fetch({ start: 0, end: 1, index: 0, total: 1 }, ctx(store)))
        .rejects.toThrow(/total/)
      expect(fetchMock.mock.calls.length, '空页终止：不再翻页').toBeLessThan(5)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('形态漂移显式失败：累计行数与声明 total 不符 → 显式报错（不静默 complete）', async () => {
    const fetchMock = vi.fn().mockImplementationOnce(() => okC({ total: 99, data: [{ id: 1, groupId: 'g1' }], isEnd: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      await expect(knowledgeById('knowledge.items')!
        .fetch({ start: 0, end: 1, index: 0, total: 1 }, ctx(store)))
        .rejects.toThrow(/total/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('knowledge.categories —— 按 robotId 隔离（驱动序来自 knowledge_items）', () => {
  it('knowledge_items 为空 → 显式失败（任务序错误，先跑 knowledge.items）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      await expect(knowledgeById('knowledge.categories')!
        .fetch({ start: 0, end: 1, index: 0, total: 1 }, ctx(store)))
        .rejects.toThrow(/knowledge\.items/)
      expect(fetchMock.mock.calls.length).toBe(0)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('嵌套树拍平：children=null 叶子不炸、level 自根=1 递增、行补 robot_id/parent_id；body 含 robotId', async () => {
    const store = await fresh()
    // 预置 items 的 robot_id（categories 的驱动序）
    const stamp = '2026-10-15T00:00:00.000Z'
    await store.upsert('knowledge_items', [{ id: '1', robot_id: '1000001', robot_name: null,
      type: 1, group_id: 'g1', ref_id: '1', point_id: null, payload: null, synchronized_at: stamp }])
    const tree = [{ id: 500001, name: '根类目', children: [
      { id: 500002, name: '子类目', children: null },   // 叶子 children 为 null（实测形态）
    ] }]
    const fetchMock = vi.fn().mockImplementationOnce(() => okA(tree))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const res = await knowledgeById('knowledge.categories')!
        .fetch({ start: 0, end: 1, index: 0, total: 1 }, ctx(store))
      expect(res.rows.length).toBe(2)
      expect(res.rows[0]).toMatchObject({ robot_id: '1000001', category_id: '500001',
        name: '根类目', parent_id: null, level: 1 })
      expect(res.rows[1]).toMatchObject({ robot_id: '1000001', category_id: '500002',
        name: '子类目', parent_id: '500001', level: 2 })
      expect(bodyOf(fetchMock, 0).robotId).toBe(1000001)   // categories 的 robotId 是生效参数
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('空树机器人（not_found，无 data 键）→ 该机器人 0 行、不报错（实测 1000005 形态）', async () => {
    const store = await fresh()
    const stamp = '2026-10-15T00:00:00.000Z'
    await store.upsert('knowledge_items', [{ id: '1', robot_id: '1000005', robot_name: null,
      type: 1, group_id: 'g1', ref_id: '1', point_id: null, payload: null, synchronized_at: stamp }])
    // 形状 A not_found：{code:200, message:'success'}，data 键整个缺失
    const fetchMock = vi.fn().mockImplementationOnce(() => Promise.resolve(new Response(
      JSON.stringify({ code: 200, message: 'success' }),
      { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const res = await knowledgeById('knowledge.categories')!
        .fetch({ start: 0, end: 1, index: 0, total: 1 }, ctx(store))
      expect(res.rows.length).toBe(0)
      expect(await store.count('knowledge_categories')).toBe(0)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('全删重插幂等（runTask 快照全链路，真库）', () => {
  it('连跑两次：行数不变、无重复；rows.written 等于 mock 提供的行数（不硬编码实测计数）', async () => {
    const page = [{ id: 11, groupId: 'g1', robotId: 1000001, robotName: 'A', type: 1, refId: 11, pointId: null },
      { id: 12, groupId: 'g2', robotId: 1000001, robotName: 'A', type: 10, refId: 11, pointId: null }]
    const fetchMock = vi.fn().mockImplementation(() => okC({ total: page.length, data: page, isEnd: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r1 = await runTask(knowledgeById('knowledge.items')!, ctx(store))
      expect(r1.status).toBe('complete')
      expect(r1.rows.written).toBe(page.length)   // 不变量
      expect(await store.count('knowledge_items')).toBe(page.length)
      const r2 = await runTask(knowledgeById('knowledge.items')!, ctx(store))
      expect(r2.status).toBe('complete')
      expect(await store.count('knowledge_items')).toBe(page.length)   // 幂等：不翻倍
      const ids = await store.query('SELECT id FROM knowledge_items ORDER BY id')
      expect(new Set(ids.rows.map((x) => x.id)).size).toBe(page.length)   // 无重复
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('翻页上限保护：非空页但 isEnd 恒 0 → 有限次调用后显式抛错（绝不挂起/死循环）', async () => {
    // 恒返回同一页（total=2 → 上限 ceil(2/1000)+5 = 6 页）：非空页、isEnd 恒 0
    const same = { id: 11, groupId: 'g1', robotId: 1000001, robotName: 'A', type: 1, refId: 11, pointId: null }
    const fetchMock = vi.fn().mockImplementation(() => okC({ total: 2, data: [same], isEnd: 0 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      await expect(knowledgeById('knowledge.items')!
        .fetch({ start: 0, end: 1, index: 0, total: 1 }, ctx(store)))
        .rejects.toThrow(/翻页超限/)
      // 上限 = ceil(2/1000)+5 = 6：第 7 次尝试前抛出（不是挂起，也不是无限调用）
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(7)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('翻页上限保护（total 未知）：载荷无 total 键 → 保守 1000 页上限内显式抛错', async () => {
    const same = { id: 11, groupId: 'g1', robotId: 1000001, robotName: 'A', type: 1, refId: 11, pointId: null }
    const fetchMock = vi.fn().mockImplementation(() => okC({ data: [same], isEnd: 0 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      await expect(knowledgeById('knowledge.items')!
        .fetch({ start: 0, end: 1, index: 0, total: 1 }, ctx(store)))
        .rejects.toThrow(/翻页超限/)
      expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(1001)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('type 列数字直通：落库后为 number 1（不因 JSON.stringify 变 "1" 依赖隐式转型）', async () => {
    const page = [{ id: 11, groupId: 'g1', robotId: 1000001, robotName: 'A', type: 1, refId: 11, pointId: null }]
    const fetchMock = vi.fn().mockImplementation(() => okC({ total: 1, data: page, isEnd: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(knowledgeById('knowledge.items')!, ctx(store))
      expect(r.status).toBe('complete')
      const rows = await store.query('SELECT type FROM knowledge_items WHERE id = \'11\'')
      expect(rows.rows[0]!.type).toBe(1)          // number，不是字符串 "1"
      expect(typeof rows.rows[0]!.type).toBe('number')
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('缺 id 的脏行：丢弃且不计入 fetched（与 apiCount 口径一致）', async () => {
    const page = [{ id: 21, groupId: 'g1', robotId: 1000001, robotName: 'A', type: 1, refId: 21, pointId: null },
      { groupId: 'g2', robotId: 1000001, robotName: 'A', type: 1, refId: 0, pointId: null }]   // 缺 id → 丢弃
    const fetchMock = vi.fn().mockImplementation(() => okC({ total: 2, data: page, isEnd: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(knowledgeById('knowledge.items')!, ctx(store))
      expect(r.rows).toEqual({ fetched: 1, written: 1 })
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('修复批 4 #3：缺键行在快照下消失 → gapHint 落 sync_gaps（detail 含行数）', async () => {
    // 快照全删重插：被丢弃的行从表里消失且无任何痕迹（apiCount 只计投影后行数，
    // 配对核对恒等）——必须显式记 gap，让「丢行」可查。
    const page = [{ id: 21, groupId: 'g1', robotId: 1000001, robotName: 'A', type: 1, refId: 21, pointId: null },
      { groupId: 'g2', robotId: 1000001, robotName: 'A', type: 1, refId: 0, pointId: null }]   // 缺 id → 丢弃
    const fetchMock = vi.fn().mockImplementation(() => okC({ total: 2, data: page, isEnd: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(knowledgeById('knowledge.items')!, ctx(store))
      expect(r.status).toBe('complete')   // gapHint 不把窗口打成失败（提示 ≠ 失败）
      expect(r.gaps.length).toBe(1)
      expect(r.gaps[0]!.reason).toBe('knowledge_row_malformed')
      expect(r.gaps[0]!.detail).toMatch(/1 行缺键列被丢弃/)
      // gap 落库（sync_gaps 可查）
      const gaps = await store.query('SELECT dataset, reason, detail FROM sync_gaps')
      expect(gaps.rows.length).toBe(1)
      expect(String(gaps.rows[0]!.detail)).toMatch(/1 行缺键列被丢弃/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('修复批 4 #3：无缺键行 → 无 gap（不误报）', async () => {
    const page = [{ id: 21, groupId: 'g1', robotId: 1000001, robotName: 'A', type: 1, refId: 21, pointId: null }]
    const fetchMock = vi.fn().mockImplementation(() => okC({ total: 1, data: page, isEnd: 1 }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runTask(knowledgeById('knowledge.items')!, ctx(store))
      expect(r.status).toBe('complete')
      expect(r.gaps).toEqual([])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('categories 全链路：items 驱动 + 树拍平落库；重跑幂等（全删重插）', async () => {
    const store = await fresh()
    const stamp = '2026-10-15T00:00:00.000Z'
    await store.upsert('knowledge_items', [{ id: '1', robot_id: '1000001', robot_name: null,
      type: 1, group_id: 'g1', ref_id: '1', point_id: null, payload: null, synchronized_at: stamp }])
    const tree = [{ id: 500001, name: '根', children: [{ id: 500002, name: '子', children: null }] }]
    const fetchMock = vi.fn().mockImplementation(() => okA(tree))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const r1 = await runTask(knowledgeById('knowledge.categories')!, ctx(store))
      expect(r1.status).toBe('complete')
      expect(await store.count('knowledge_categories')).toBe(2)
      await runTask(knowledgeById('knowledge.categories')!, ctx(store))
      expect(await store.count('knowledge_categories')).toBe(2)   // 幂等
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('taskById —— 按 id 取知识库任务', () => {
  it('存在与不存在两条路径', () => {
    expect(knowledgeById('knowledge.items')?.id).toBe('knowledge.items')
    expect(knowledgeById('nope')).toBeUndefined()
  })
})
