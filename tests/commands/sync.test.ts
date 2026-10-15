// tests/commands/sync.test.ts —— D-T12：sync tasks 子命令形态（骨架沿 store.ts）。
// D-T13 追加：sync run 子命令 —— 区间参数/输出契约/进度/退出码/store 未初始化。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncCommand } from '../../src/commands/sync.js'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { __resetBuckets } from '../../src/core/http.js'
import { __setSleep as setReportSleep } from '../../src/sync/tasks/reports.js'
import { __setSleep as setKnowledgeSleep } from '../../src/sync/tasks/knowledge.js'
import type { Store } from '../../src/store/types.js'

// L1 对冲：真库冷启动偶发 >5s（同 tests/store/duckdb.test.ts / tasks-dim.test.ts）。
vi.setConfig({ testTimeout: 15_000 })

let out = ''
let err = ''
let dir = ''
beforeEach(() => {
  out = ''; err = ''
  dir = mkdtempSync(join(tmpdir(), 'qiyu-syncrun-'))
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
  vi.stubEnv('HOME', dir)   // 隔离真实 ~（store 配置与默认库路径都走 HOME）
  vi.stubEnv('QIYU_APP_KEY', 'test-key')
  vi.stubEnv('QIYU_APP_SECRET', 'test-secret')
  // 注入的 sleep 代表「等满了 retryAfter」——令牌桶按真实时钟计窗，
  // 测试用清桶模拟时间推进（与真实等待后放行等价，T7/T11 夹具同款）
  __resetBuckets()
  setReportSleep(async () => { __resetBuckets() })
  setKnowledgeSleep(async () => { __resetBuckets() })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })
const data = (): Record<string, unknown> => JSON.parse(out).data
const dbPath = (): string => join(dir, 'q.db')

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  await s.init()
  return s
}

describe('sync tasks', () => {
  it('输出 21 个任务与 2 个 unsupported 条目', async () => {
    expect(await syncCommand(['tasks'])).toBe(0)
    const d = data()
    const tasks = d.tasks as Array<Record<string, unknown>>
    const unsupported = d.unsupported as Array<Record<string, unknown>>
    expect(tasks.length).toBe(21)
    expect(unsupported).toEqual([
      { id: 'realtime.session', unsupported: 'realtime' },
      { id: 'realtime.ipcc', unsupported: 'realtime' },
    ])
    // 任务条目带 id 与 table（Agent 可直接对回表名）
    const overview = tasks.find((t) => t.id === 'reports.overview')
    expect(overview).toBeDefined()
    expect(overview!.table).toBe('daily_overview')
  })

  it('任务条目不泄漏函数字段（fetch/write/enrich 不进 JSON）', async () => {
    expect(await syncCommand(['tasks'])).toBe(0)
    const tasks = data().tasks as Array<Record<string, unknown>>
    for (const t of tasks) {
      expect(t.fetch).toBeUndefined()
      expect(t.write).toBeUndefined()
      expect(t.enrich).toBeUndefined()
    }
  })
})

describe('sync 用法', () => {
  it('--help 输出用法、退出码 0', async () => {
    expect(await syncCommand(['--help'])).toBe(0)
    expect(out).toMatch(/用法：qiyu sync/)
    expect(out).toMatch(/sync tasks/)
  })

  it('未知子命令 usageFail、退出码 2', async () => {
    expect(await syncCommand(['nope'])).toBe(2)
    expect(JSON.parse(out).error.kind).toBe('usage')
    expect(JSON.parse(out).error.message).toMatch(/未知子命令/)
  })

  it('无子命令输出用法、退出码 0（store.ts 同族惯例：无参数是请求帮助不是错误）', async () => {
    expect(await syncCommand([])).toBe(0)
    expect(out).toMatch(/用法：qiyu sync/)
  })
})

// —— D-T13：sync run ——（mock 网络层 fetch，真库落库；契约沿 spec §七）

/** 形状 A 成功信封（dim/reports 族实测形态）。 */
function okA(data_: unknown) {
  return Promise.resolve(new Response(JSON.stringify({ code: 200, message: 'OK', data: data_ }),
    { status: 200, headers: { 'content-type': 'application/json' } }))
}
/** 形状 C 成功信封（知识库族实测形态：message 是 JSON 字符串）。 */
function okC(payload: unknown) {
  return Promise.resolve(new Response(JSON.stringify({
    code: 200, message: JSON.stringify(payload),
  }), { status: 200, headers: { 'content-type': 'application/json' } }))
}

describe('sync run —— 单任务输出契约（spec §七）', () => {
  it('mock 维表任务：逐字段断言输出形态 {tasks:[{task,status,windows,rows,resolved_range,watermark,gaps}], truncated:false}', async () => {
    // staff.list.new 返回 2 行（fetchAll 直接吃 data 数组）
    const fetchMock = vi.fn().mockImplementation(() => okA([
      { id: 1000001, realname: '测试甲', nickname: '甲', username: 'test-a', role: 'admin',
        roleId: 1, status: 1, createtime: 1690000000000, updateTime: 1690000000000,
        email: null, phone: null, workNumber: 'W001', maxServiceCount: 6,
        skillScoreChat: 0, skillScoreIpcc: 0, groupInfo: [{ groupId: 1, groupName: 'G' }] },
      { id: 1000002, realname: '测试乙', nickname: '乙', username: 'test-b', role: 'staff',
        roleId: 2, status: 1, createtime: 1690000000000, updateTime: 1690000000000,
        email: null, phone: null, workNumber: 'W002', maxServiceCount: 6,
        skillScoreChat: 0, skillScoreIpcc: 0, groupInfo: [] },
    ]))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())   // 先初始化库
      const code = await syncCommand(['run', 'dim.staff', '--db', dbPath(),
        '--full', '--quiet'])
      expect(code).toBe(0)
      const d = data()
      expect(d.truncated).toBe(false)
      const tasks = d.tasks as Array<Record<string, unknown>>
      expect(tasks.length).toBe(1)
      const t = tasks[0]!
      expect(t.task).toBe('dim.staff')
      expect(t.status).toBe('complete')
      expect(t.windows).toEqual({ total: 1, succeeded: 1, failed: 0 })
      expect(t.rows).toEqual({ fetched: 2, written: 2 })
      expect(t.gaps).toEqual([])
      // resolved_range 是 ISO 数组（快照任务 full 跑 = [epoch? --full 起点, now]）
      const rr = t.resolved_range as [string, string]
      expect(rr[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      expect(rr[1]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      // watermark 回显（快照任务推进到 end）
      expect(t.watermark).toMatch(/^\d{4}-\d{2}-\d{2}T/)
      // --quiet：进度不写 stderr
      expect(err).not.toMatch(/dim\.staff/)
      // 真实落库
      const s = await fresh()
      expect(await s.count('staff')).toBe(2)
      await s.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('进度走 stderr（无 --quiet）、任务名与行数可见', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okA([{ id: 1000001, name: '组A' }]))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'dim.staff_groups', '--db', dbPath(),
        '--full'])
      expect(code).toBe(0)
      expect(err).toMatch(/dim\.staff_groups/)
      expect(err.length).toBeGreaterThan(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('部分成功 → 退出码 0（partial 是成功完成的 run；gap 带范围与 reason）', async () => {
    // tickets.search（windowed、非轮转）：31 天上限 × 2 窗；第 1 窗 fetch 抛错（网络）
    // → 该窗 gap；第 2 窗正常返回空页。⚠️ http.call 对 fetch 抛错退避重试 2 次
    //（3 次尝试），故前 3 次 mock 调用都要抛才能让第 1 窗真正失败。
    let call = 0
    const fetchMock = vi.fn().mockImplementation(() => {
      call++
      if (call <= 3) throw new Error('fetch failed')
      return okC({ total: 0, tickets: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      // 两窗范围：--since 40d（op 窗 ≤31 天上限 → 2 窗）
      const code = await syncCommand(['run', 'tickets.search', '--db', dbPath(),
        '--since', '40d'])
      expect(code).toBe(0)
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t.status).toBe('partial')
      expect(t.windows).toEqual({ total: 2, succeeded: 1, failed: 1 })
      const gaps = t.gaps as Array<Record<string, unknown>>
      expect(gaps.length).toBe(1)
      expect(gaps[0]!.reason).toBe('fetch_failed')
      expect(gaps[0]!.range).toBeDefined()
      expect(gaps[0]!.detail).toBeDefined()
      // gap 同时落 sync_gaps（状态可见性）
      const s = await fresh()
      expect(await s.count('sync_gaps')).toBe(1)
      await s.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('全失败 → 退出码 1（snapshot 快照任务 fetch 抛错）', async () => {
    const fetchMock = vi.fn().mockImplementation(() => { throw new Error('fetch failed') })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'dim.staff', '--db', dbPath(), '--full'])
      expect(code).toBe(1)
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t.status).toBe('failed')
      expect(t.gaps.length).toBe(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('多任务缺省 = 全部 21 任务照跑；某任务失败不影响其余（故障隔离、退出码 0）', { timeout: 120000 }, async () => {
    // dim 族 2 个形状 A 快照接口正常返回；statistic.overview 的接口全抛错；知识库正常返回。
    // fetch 按路径分派：报表路径 → 抛错；knowledge/kpoint → 成功；getCategoryTree → 空树；
    // 其余（含 dim A 端点）→ 成功信封。--since 40d 控制窗数（windowed 2 窗）。
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      const u = String(url)
      if (u.includes('/openapi/statistic/')) throw new Error('fetch failed')
      if (u.includes('robot/data/knowledge')) {
        return okC({ total: 0, data: [], isEnd: 1 })
      }
      if (u.includes('robot/data/kpoint')) {
        return okC({ total: 0, data: [], isEnd: 1 })
      }
      if (u.includes('getCategoryTree')) return okA([])   // 空树
      return okA([{ id: 1000001, name: '测试' }])          // 维表/组（形状 A）
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', '--db', dbPath(), '--since', '40d', '--quiet'])
      expect(code).toBe(0)   // 有任务成功 → 部分成功也是 0
      const tasks = data().tasks as Array<Record<string, unknown>>
      expect(tasks.length).toBe(21)
      const failed = tasks.filter((t) => t.status !== 'complete')
      // partial 也是「非 complete」的合法形态（windowed 任务部分窗成功）
      for (const t of failed) expect(['failed', 'partial']).toContain(t.status)
      const okTasks = tasks.filter((t) => t.status === 'complete')
      expect(okTasks.length).toBeGreaterThan(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('sync run —— 区间参数（--full/--since/--until）', () => {
  it('--since 30d 相对时间按 Asia/Shanghai 解析并回显 resolved_range（固定时钟）', async () => {
    // 固定时钟：2026-10-15T02:00:00+08:00 = 2026-10-14T18:00:00Z
    const CLOCK = Date.UTC(2026, 9, 14, 18, 0, 0)
    vi.useFakeTimers({ now: CLOCK })
    try {
      const fetchMock = vi.fn().mockImplementation(() => okC({ total: 0, result: [] }))
      vi.stubGlobal('fetch', fetchMock)
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'reports.overview', '--db', dbPath(),
        '--since', '30d', '--quiet'])
      expect(code).toBe(0)
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      const rr = t.resolved_range as [string, string]
      // 30d 从固定时钟回退 30 天：end=2026-10-15T02:00+08:00、start=2026-09-15T02:00+08:00
      expect(rr[1]).toBe('2026-10-15T02:00:00+08:00')
      expect(rr[0]).toBe('2026-09-15T02:00:00+08:00')
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('--until 可单独使用（分段回补）；--since ISO 日期按上海 00:00 解析', async () => {
    const CLOCK = Date.UTC(2026, 9, 14, 18, 0, 0)
    vi.useFakeTimers({ now: CLOCK })
    try {
      const fetchMock = vi.fn().mockImplementation(() => okC({ total: 0, result: [] }))
      vi.stubGlobal('fetch', fetchMock)
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'reports.overview', '--db', dbPath(),
        '--since', '2026-09-01', '--until', '2026-09-20', '--quiet'])
      expect(code).toBe(0)
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      const rr = t.resolved_range as [string, string]
      expect(rr[0]).toBe('2026-09-01T00:00:00+08:00')
      expect(rr[1]).toBe('2026-09-20T00:00:00+08:00')
    } finally {
      vi.unstubAllGlobals()
      vi.useRealTimers()
    }
  })

  it('--full 全区间重刷（起点归零；窗口数按 31 天上限切分）', { timeout: 120000 }, async () => {
    // 全历史 → ~668 个 31 天窗；mock 全空 → 假空重试后 complete。
    // ⚠️ 用 tickets.search（工单域实测无限频）：报表接口有 30s 本地令牌桶，
    // 668 窗逐窗推进会被限频打断（partial）——那属限频编排语义，不归本用例。
    const fetchMock = vi.fn().mockImplementation(() => okC({ total: 0, tickets: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'tickets.search', '--db', dbPath(),
        '--full', '--quiet'])
      expect(code).toBe(0)
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      const rr = t.resolved_range as [string, string]
      expect(rr[0]).toBe('1970-01-01T08:00:00+08:00')
      expect(t.status).toBe('complete')
      expect(t.windows.total).toBeGreaterThan(200)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('--since 缺值 → usageFail 退出码 2', async () => {
    expect(await syncCommand(['run', 'dim.staff', '--db', dbPath(), '--since'])).toBe(2)
    expect(JSON.parse(out).error.kind).toBe('usage')
    expect(JSON.parse(out).error.message).toMatch(/--since/)
  })

  it('--since 与 --full 同传 → usage（互斥）', async () => {
    expect(await syncCommand(['run', 'dim.staff', '--db', dbPath(),
      '--full', '--since', '30d'])).toBe(2)
    expect(JSON.parse(out).error.kind).toBe('usage')
  })

  it('未知任务 id → usage、可用任务名在消息里', async () => {
    expect(await syncCommand(['run', 'nope.nope', '--db', dbPath()])).toBe(2)
    expect(JSON.parse(out).error.message).toMatch(/nope\.nope/)
    expect(JSON.parse(out).error.message).toMatch(/dim\.staff/)
  })
})

describe('sync run —— store 与凭证前置检查', () => {
  it('store 不可用（路径是普通文件）→ 1 + store_not_initialized + hint 指 qiyu store init', async () => {
    // DuckDB 对不存在的路径会直接建库（init 幂等），sync run 不会报「未初始化」；
    // 「无法打开」的真实形态是路径存在但不是 DuckDB 文件（store.test.ts 同款注入）。
    const p = join(dir, 'notdb.bin')
    writeFileSync(p, 'THIS IS NOT A DUCKDB FILE'.repeat(100))
    const code = await syncCommand(['run', 'dim.staff', '--db', p])
    expect(code).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/store init/)
  })

  it('缺凭证 → 1 + auth_missing（环境问题不是用法错误，api.ts 同族）', async () => {
    vi.stubEnv('QIYU_APP_KEY', '')
    vi.stubEnv('QIYU_APP_SECRET', '')
    await fresh().then((s) => s.close())
    const code = await syncCommand(['run', 'dim.staff', '--db', dbPath()])
    expect(code).toBe(1)
    expect(JSON.parse(out).error.kind).toBe('auth_missing')
  })

  it('--pretty → usageFail 2（统一为子命令后可用：run 也显式拒绝，不静默忽略）', async () => {
    expect(await syncCommand(['tasks', '--pretty'])).toBe(2)
    expect(JSON.parse(out).error.message).toMatch(/--pretty/)
  })
})

describe('sync run —— 生产接线（fetchZip / 任务排序 / robotId 注入）', () => {
  it('sessions.export 端到端：fetchZip 生产接线生效（mock create/check/zip 下载三段）', async () => {
    // 下载 URL mock：fetchZip 用全局 fetch 拉 zip —— 返回一个未加密、未压缩容量的假 zip 不可行，
    // 生产 fetchZip 只负责下载字节；解压密码错误在 unzip 阶段显式失败 —— 这里断言
    // 「fetchZip 请求真的发出」（T10 的显式失败 hint 不再出现，接线已生效）。
    const fetchMock = vi.fn()
      // create
      .mockImplementationOnce(() => Promise.resolve(new Response(
        JSON.stringify({ code: 200, message: 'task-key-1' }),
        { status: 200, headers: { 'content-type': 'application/json' } })))
      // check → 下载链接
      .mockImplementationOnce(() => Promise.resolve(new Response(
        JSON.stringify({ code: 200, message: 'https://qiyukf.com/export/x.zip' }),
        { status: 200, headers: { 'content-type': 'application/json' } })))
      // zip 下载（生产接线：普通 GET；返回非法 zip → unzip 显式失败 → 任务 failed，
      // 但 fetchZip 已被真实调用 —— 接线断言的落点）
      .mockImplementationOnce(() => Promise.resolve(new Response('NOT-A-ZIP',
        { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      // --since 1d → 1 窗（sessions maxWindowDays=6、overlap 1：1 天 span 不产生补窗）：
      // create + check + zip 三次调用
      const code = await syncCommand(['run', 'sessions.export', '--db', dbPath(),
        '--since', '1d', '--quiet'])
      expect(code).toBe(0)
      // ⚠️ windowed 任务全窗失败引擎也报 partial（T5 brief 权威：'failed' 只留给快照
      // gate 拦截路径）；「全失败退 1」按快照任务语义判定（本文件全失败用例）。
      expect(fetchMock.mock.calls.length).toBe(3)   // create + check + zip 下载
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t.status).toBe('partial')
      expect((t.gaps as Array<{ detail: string }>)[0]!.detail).toMatch(/zip/i)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('知识库任务排序：items 先于 categories（items 为空时 categories 不会先跑报任务序错误）', async () => {
    const order: string[] = []
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      const u = String(url)
      if (u.includes('robot/data/knowledge')) {
        order.push('items')
        return okC({ total: 1, data: [
          { id: 1, robotId: 1000001, robotName: 'A', type: 1, groupId: 'g1',
            refId: 11, pointId: null },
        ], isEnd: 1 })
      }
      if (u.includes('robot/data/kpoint')) {
        order.push('points')
        return okC({ total: 1, data: [{ id: 7 }], isEnd: 1 })
      }
      if (u.includes('getCategoryTree')) {
        order.push(`cats:${JSON.parse(String((fetchMock.mock.calls.at(-1)?.[1] as { body: string }).body)).robotId}`)
        return okA([{ id: 500001, name: '根', children: null }])
      }
      throw new Error('unexpected ' + u)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'knowledge.items', 'knowledge.points',
        'knowledge.categories', '--db', dbPath(), '--quiet'])
      expect(code).toBe(0)
      // 显式排序：items/points 在 categories 之前（categories 驱动序来自 items 落库）
      expect(order.indexOf('items')).toBeLessThan(order.findIndex((x) => x.startsWith('cats:')))
      // categories 的 robotId 来自 items 落库的 DISTINCT robot_id
      expect(order.some((x) => x === 'cats:1000001')).toBe(true)
      const s = await fresh()
      expect(await s.count('knowledge_categories')).toBe(1)
      await s.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('knowledge.categories 单独跑（items 为空）→ 失败但信息透出（显式失败非静默空跑）', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'knowledge.categories', '--db', dbPath(),
        '--quiet'])
      expect(code).toBe(1)
      expect(fetchMock.mock.calls.length).toBe(0)   // 零请求：任务序错误在 fetch 层拦下
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t.status).toBe('failed')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('配置面 robotId 注入：options.knowledgeRobotIds 透传给 categories（发现盲区兜底）', async () => {
    // 注入 robotId 后 categories 不再依赖 items 的 DISTINCT —— 配置文件给 1000009
    //（不在 items 落库集内），断言 getCategoryTree 收到注入的 robotId。
    const cfgDir = join(dir, '.config', 'qiyu')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({
      profiles: { default: { store: {
        path: dbPath(),
        options: { knowledgeRobotIds: [1000009] },
      } } },
    }))
    const bodies: unknown[] = []
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      const u = String(url)
      if (u.includes('getCategoryTree')) {
        bodies.push(JSON.parse((fetchMock.mock.calls.at(-1)?.[1] as { body: string }).body))
        return okA([{ id: 500009, name: '注入树', children: null }])
      }
      throw new Error('unexpected ' + u)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'knowledge.categories', '--db', dbPath(),
        '--quiet'])
      expect(code).toBe(0)
      expect(bodies[0]).toMatchObject({ robotId: 1000009 })
      const s = await fresh()
      expect(await s.count('knowledge_categories')).toBe(1)
      await s.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('不注入且 items 有数据 → categories 按 DISTINCT robot_id 驱动（默认路径不回归）', async () => {
    const bodies: unknown[] = []
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      const u = String(url)
      if (u.includes('getCategoryTree')) {
        bodies.push(JSON.parse((fetchMock.mock.calls.at(-1)?.[1] as { body: string }).body))
        return okA([])   // 空树：0 行合法
      }
      throw new Error('unexpected ' + u)
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      const s = await fresh()
      // 预置 items 落库行（categories 的驱动序来源）
      await s.upsert('knowledge_items', [{ id: '1', robot_id: '1000001', robot_name: null,
        type: 1, group_id: 'g1', ref_id: '1', point_id: null, payload: null,
        synchronized_at: '2026-10-15T00:00:00.000Z' }])
      await s.close()
      const code = await syncCommand(['run', 'knowledge.categories', '--db', dbPath(),
        '--quiet'])
      expect(code).toBe(0)
      expect(bodies[0]).toMatchObject({ robotId: 1000001 })
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
