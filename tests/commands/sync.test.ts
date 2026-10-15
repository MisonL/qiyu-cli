// tests/commands/sync.test.ts —— D-T12：sync tasks 子命令形态（骨架沿 store.ts）。
// D-T13 追加：sync run 子命令 —— 区间参数/输出契约/进度/退出码/store 未初始化。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { syncCommand } from '../../src/commands/sync.js'
import { orderTasks } from '../../src/commands/sync-run.js'
import { taskById, SYNC_TASKS } from '../../src/sync/registry.js'
import { __setPlatform, __setRun, __resetScheduleDeps } from '../../src/schedule/install.js'
import { advanceWatermark, markPending, recordGap } from '../../src/sync/state.js'
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
  // T14：调度命令的平台与外部命令注入——默认 darwin + 不触真系统的假 runner
  __setPlatform(() => 'darwin')
  __setRun(runMock)
  runMock.mockClear()
})
afterEach(() => { __resetScheduleDeps(); vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })
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
    // D 低-1：role 按实测统一为整型（staff.list 实测 role 是 0/1/-2 的 int，不是 'admin'/'staff'）
    const fetchMock = vi.fn().mockImplementation(() => okA([
      { id: 1000001, realname: '测试甲', nickname: '甲', username: 'test-a', role: 1,
        roleId: 1, status: 1, createtime: 1690000000000, updateTime: 1690000000000,
        email: null, phone: null, workNumber: 'W001', maxServiceCount: 6,
        skillScoreChat: 0, skillScoreIpcc: 0, groupInfo: [{ groupId: 1, groupName: 'G' }] },
      { id: 1000002, realname: '测试乙', nickname: '乙', username: 'test-b', role: 0,
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

  it('windowed 任务全窗失败 → 退出码 1（partial 不掩盖全失败，T13 fix 中-1）', async () => {
    // tickets.search 1 窗（--since 1d）全窗失败：引擎权威产出 partial（windows
    // succeeded=0/failed=1），但「全部任务都没有任何成功窗口」必须退 1。
    const fetchMock = vi.fn().mockImplementation(() => { throw new Error('fetch failed') })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'tickets.search', '--db', dbPath(),
        '--since', '1d', '--quiet'])
      expect(code).toBe(1)
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t.status).toBe('partial')     // 引擎层语义不变
      expect(t.windows).toEqual({ total: 1, succeeded: 0, failed: 1 })
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
      expect((t.gaps as unknown[]).length).toBe(1)
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
    // ⚠️ 用 tickets.search（工单域无限频）：报表的假空重试会撞 30s 本地桶把窗口
    // 打成失败（中-1 后退 1）——区间解析语义与任务无关。
    const CLOCK = Date.UTC(2026, 9, 14, 18, 0, 0)
    vi.useFakeTimers({ now: CLOCK })
    try {
      const fetchMock = vi.fn().mockImplementation(() => okC({ total: 0, tickets: [] }))
      vi.stubGlobal('fetch', fetchMock)
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'tickets.search', '--db', dbPath(),
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
      const fetchMock = vi.fn().mockImplementation(() => okC({ total: 0, tickets: [] }))
      vi.stubGlobal('fetch', fetchMock)
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', 'tickets.search', '--db', dbPath(),
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

  it('--full 全区间重刷（C 中-2：哨兵起点 0 抬到接口下界 now−31 天；窗口数按 31 天上限切分）', { timeout: 120000 }, async () => {
    // 下界抬升后的窗口数 = 31 天/31 天上限 = 1~2 窗；mock 全空 → 假空重试后 complete。
    // ⚠️ 用 tickets.search（工单域实测无限频）：报表接口有 30s 本地令牌桶，会被限频打断。
    // ⚠️ 修复批 1（C 中-2）的最小跨所有权改动：--full 的 start=0 是哨兵（1970 无数据，
    // opStart 还会被服务端静默钳到 now−31d），tickets.search 声明 windowStartFloorDays=31
    // 后起点抬到 now−31d，抬升如实回显在 resolved_range —— 断言从「1970 起点 + 200+ 窗」
    // 改为「下界起点 + ≤2 窗」。src/commands/ 本身零改动（抬升发生在引擎层，任务声明式）。
    const fetchMock = vi.fn().mockImplementation(() => okC({ total: 0, tickets: [] }))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      const before = Date.now()
      const code = await syncCommand(['run', 'tickets.search', '--db', dbPath(),
        '--full', '--quiet'])
      expect(code).toBe(0)
      const after = Date.now()
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      const rr = t.resolved_range as [string, string]
      // 起点 = now − 31 天（± 运行时刻的秒级偏移），绝不是 1970
      const startMs = Date.parse(rr[0])
      expect(startMs).toBeGreaterThan(before - 31 * 86_400_000 - 5000)
      expect(startMs).toBeLessThan(after - 31 * 86_400_000 + 5000)
      expect(t.status).toBe('complete')
      expect((t.windows as { total: number }).total).toBeLessThanOrEqual(2)
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
  it('orderTasks 分层 rank：dim(0) < 报表/工单/会话(1) < knowledge.items/points(2) < categories(3)', () => {
    // 直接单测（final 审查高-1：此前 orderTasks 无直接测试）。
    // 故意乱序传入，断言输出严格按 rank 分层、同层内保持输入相对次序（稳定排序）。
    const t = (id: string) => taskById(id)!
    const ordered = orderTasks([
      t('knowledge.categories'), t('reports.overview'), t('knowledge.items'),
      t('tickets.search'), t('dim.staff'), t('sessions.export'),
      t('knowledge.points'), t('dim.ticket_templates'),
    ])
    expect(ordered.map((x) => x.id)).toEqual([
      'dim.staff', 'dim.ticket_templates',          // rank 0（输入序保持）
      'reports.overview', 'tickets.search', 'sessions.export',   // rank 1
      'knowledge.items', 'knowledge.points',        // rank 2
      'knowledge.categories',                       // rank 3
    ])
  })

  it('缺省全量：执行序 dim 在报表之前（staff_salary_detail 按 staff 表驱动，分层交错修复高-1）', { timeout: 120000 }, async () => {
    // 用 stderr 进度行捕获真实执行序：runSyncRun 的 onProgress 写 stderr（beforeEach
    // 已 mock 进 err），逐行抽 "[taskId] " 得到任务首次执行的顺序。--since 1d 控制窗数。
    // stat 域全抛错让报表任务失败（不影响排序断言），其余任务 mock 正常。
    const fetchMock = vi.fn().mockImplementation((url: unknown) => {
      const u = String(url)
      if (u.includes('/openapi/statistic/')) throw new Error('fetch failed')   // 报表 9 任务
      if (u.includes('robot/data/knowledge')) return okC({ total: 0, data: [], isEnd: 1 })
      if (u.includes('robot/data/kpoint')) return okC({ total: 0, data: [], isEnd: 1 })
      if (u.includes('getCategoryTree')) return okA([])   // 空树
      return okA([{ id: 1000001, name: '测试' }])          // 维表/组（形状 A）
    })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      const code = await syncCommand(['run', '--db', dbPath(), '--since', '1d'])
      expect(code).toBe(0)   // dim/knowledge 成功 → 部分成功退 0
      const seen: string[] = []
      for (const m of err.matchAll(/\[([a-z_.]+)\] /g)) {
        const id = m[1]!
        if (!seen.includes(id)) seen.push(id)
      }
      // 分层交错铁律（高-1）：全部 dim 先于任何报表；knowledge.items 先于 categories。
      const dimIdx = seen.findIndex((x) => x.startsWith('dim.'))
      const reportIdx = seen.findIndex((x) => x.startsWith('reports.'))
      expect(dimIdx).toBeGreaterThanOrEqual(0)
      expect(reportIdx).toBeGreaterThan(dimIdx)
      // 钉死用例锚点：staff_salary_detail（staff 表驱动的报表）在 dim.staff 之后执行
      expect(seen.indexOf('reports.staff_salary_detail'))
        .toBeGreaterThan(seen.indexOf('dim.staff'))
      expect(seen.indexOf('knowledge.items'))
        .toBeLessThan(seen.indexOf('knowledge.categories'))
      // 修复前形态（rotated 全批先跑）会让 dim 排在 reports 之后——用相对序反向断言：
      expect(seen.indexOf('reports.overview')).toBeGreaterThan(dimIdx)
    } finally {
      vi.unstubAllGlobals()
    }
  })

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
      // 单任务全窗失败（partial + succeeded=0）→ 退 1（T13 fix 中-1 的补判口径）
      expect(code).toBe(1)
      expect(fetchMock.mock.calls.length).toBe(3)   // create + check + zip 下载
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t.status).toBe('partial')
      expect(t.windows).toEqual({ total: 1, succeeded: 0, failed: 1 })
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

// —— D-T14：sync status / verify / install / uninstall ——

/** install/uninstall 测试共用的注入 runner 句柄（beforeEach 里 __setRun 装入的就是它）。 */
const runMock = vi.fn()

describe('sync status', () => {
  it('输出每任务 {task,watermark,range_status,last_synced_at,gaps_count,locked}（真库预置 sync_state/gaps）', async () => {
    const s = await fresh()
    await s.transaction(async (tx) => {
      await advanceWatermark(tx, 'dim.staff', '2026-10-14T00:00:00.000Z', { start: 0, end: 1 }, '2026-10-14T10:00:00.000Z')
      await markPending(tx, 'reports.overview')
      await recordGap(tx, 'reports.overview', '100', '200', 'fetch_failed', '网络抖动', { now: () => 0 })
    })
    await s.close()
    expect(await syncCommand(['status', '--db', dbPath()])).toBe(0)
    const tasks = data().tasks as Array<Record<string, unknown>>
    expect(tasks.length).toBe(21)   // 缺省全部任务
    const staff = tasks.find((t) => t.task === 'dim.staff')!
    expect(staff.watermark).toBe('2026-10-14T00:00:00.000Z')
    expect(staff.range_status).toBe('complete')
    expect(staff.last_synced_at).toBe('2026-10-14T10:00:00.000Z')
    expect(staff.gaps_count).toBe(0)
    expect(staff.locked).toBe(false)
    const overview = tasks.find((t) => t.task === 'reports.overview')!
    expect(overview.range_status).toBe('pending')
    expect(overview.gaps_count).toBe(1)
    expect(overview.watermark).toBeNull()
    // 限频冷却行（__ratelimit__: 前缀）不是任务，不出现
    expect(tasks.some((t) => String(t.task).startsWith('__ratelimit__'))).toBe(false)
  })

  it('指定任务子集只列该任务；未知任务 → 2', async () => {
    const s = await fresh()
    await s.transaction(async (tx) => {
      await advanceWatermark(tx, 'dim.staff', 'w1', { start: 0, end: 1 }, 't1')
    })
    await s.close()
    expect(await syncCommand(['status', 'dim.staff', '--db', dbPath()])).toBe(0)
    const tasks = data().tasks as Array<Record<string, unknown>>
    expect(tasks.length).toBe(1)
    expect(tasks[0]!.task).toBe('dim.staff')

    out = ''
    expect(await syncCommand(['status', 'nope.nope', '--db', dbPath()])).toBe(2)
    expect(JSON.parse(out).error.kind).toBe('usage')
    expect(JSON.parse(out).error.message).toMatch(/nope\.nope/)
  })

  it('locked 来自 sync_state.locked_by（引擎盖章为真）', async () => {
    const s = await fresh()
    await s.upsert('sync_state', [{ dataset: 'dim.staff', watermark: 'w', range_status: 'complete',
      last_error: null, locked_by: 'pid 42', locked_at: '2026-10-15T00:00:00.000Z',
      last_synced_at: 't', next_allowed_at: null, last_rate_limited_at: null }])
    await s.close()
    expect(await syncCommand(['status', 'dim.staff', '--db', dbPath()])).toBe(0)
    const t = (data().tasks as Array<Record<string, unknown>>)[0]!
    expect(t.locked).toBe(true)
  })

  it('库文件不存在 → 1 + store_not_initialized + hint 指向 sync run（D 交付后 status 的 hint，spec §9.5）', async () => {
    expect(await syncCommand(['status', '--db', join(dir, 'missing.db')])).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/sync run/)
  })
})

describe('sync verify', () => {
  // D 低-1：role 按实测统一为整型（staff.list 实测 role 是 0/1/-2 的 int）
  const staffRows = () => [
    { id: 1000001, realname: '甲', nickname: '甲', username: 'a', role: 1, roleId: 1,
      status: 1, createtime: 1690000000000, updateTime: 1690000000000, email: null, phone: null,
      workNumber: 'W1', maxServiceCount: 6, skillScoreChat: 0, skillScoreIpcc: 0, groupInfo: [] },
    { id: 1000002, realname: '乙', nickname: '乙', username: 'b', role: 0, roleId: 2,
      status: 1, createtime: 1690000000000, updateTime: 1690000000000, email: null, phone: null,
      workNumber: 'W2', maxServiceCount: 6, skillScoreChat: 0, skillScoreIpcc: 0, groupInfo: [] },
  ]

  it('快照任务三方一致 → drift=[] 退出码 0，local_rows=expected_from_api、state 一致', async () => {
    const fetchMock = vi.fn().mockImplementation(() => okA(staffRows()))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      expect(await syncCommand(['run', 'dim.staff', '--db', dbPath(), '--full', '--quiet'])).toBe(0)
      out = ''
      const code = await syncCommand(['verify', 'dim.staff', '--db', dbPath()])
      expect(code).toBe(0)
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t.task).toBe('dim.staff')
      expect(t.local_rows).toBe(2)
      expect(t.expected_from_api).toBe(2)
      expect(t.state_windows_consistent).toBe(true)
      expect(t.drift).toEqual([])
      // 快照核对的取数就是任务 fetch（同端点，无其他请求）
      expect(fetchMock.mock.calls.every((c) => String(c[0]).includes('staff/list/new'))).toBe(true)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('快照任务本地与上游不符 → drift 非空（count_mismatch）退出码 1', async () => {
    const staff3 = { id: 1000003, realname: '丙', nickname: '丙', username: 'c', role: 0, roleId: 2,
      status: 1, createtime: 1690000000000, updateTime: 1690000000000, email: null, phone: null,
      workNumber: 'W3', maxServiceCount: 6, skillScoreChat: 0, skillScoreIpcc: 0, groupInfo: [] }
    // 先 2 行（run 落库本地 2 行），之后 3 行（verify 上游变 3 → count_mismatch）
    const fetchMock = vi.fn().mockImplementationOnce(() => okA(staffRows()))
      .mockImplementation(() => okA([...staffRows(), staff3]))
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      // 本地 2 行
      expect(await syncCommand(['run', 'dim.staff', '--db', dbPath(), '--full', '--quiet'])).toBe(0)
      // 上游变 3 行 → count_mismatch
      out = ''
      const code = await syncCommand(['verify', 'dim.staff', '--db', dbPath()])
      expect(code).toBe(1)
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t.local_rows).toBe(2)
      expect(t.expected_from_api).toBe(3)
      expect(t.state_windows_consistent).toBe(true)
      const drift = t.drift as Array<Record<string, unknown>>
      expect(drift.length).toBe(1)
      expect(drift[0]!.kind).toBe('count_mismatch')
      expect(String(drift[0]!.detail)).toMatch(/2/)
      expect(String(drift[0]!.detail)).toMatch(/3/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('上游请求失败 → drift fetch_failed 退出码 1（无法核对 ≠ 一致）', async () => {
    // 先正常 2 行（run 落库），之后 verify 上游抛错
    const fetchMock = vi.fn().mockImplementationOnce(() => okA(staffRows()))
      .mockImplementation(() => { throw new Error('fetch failed') })
    vi.stubGlobal('fetch', fetchMock)
    try {
      await fresh().then((s) => s.close())
      expect(await syncCommand(['run', 'dim.staff', '--db', dbPath(), '--full', '--quiet'])).toBe(0)
      out = ''
      expect(await syncCommand(['verify', 'dim.staff', '--db', dbPath()])).toBe(1)
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t.expected_from_api).toBeNull()
      const drift = t.drift as Array<Record<string, unknown>>
      expect(drift.map((d) => d.kind)).toContain('fetch_failed')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('windowed：complete → expected_from_api=null + drift=[]；pending → drift 非空且 detail 说明核对方式', async () => {
    const s = await fresh()
    await s.transaction(async (tx) => {
      await advanceWatermark(tx, 'tickets.search', '2026-10-14T00:00:00.000Z', { start: 0, end: 1 }, '2026-10-14T10:00:00.000Z')
    })
    await s.close()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      // windowed 不做上游重拉：零网络
      const code = await syncCommand(['verify', 'tickets.search', '--db', dbPath()])
      expect(code).toBe(0)
      expect(fetchMock.mock.calls.length).toBe(0)
      const t = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t.expected_from_api).toBeNull()
      expect(t.state_windows_consistent).toBe(true)
      expect(t.drift).toEqual([])

      // pending（最后一次运行中断）→ drift 非空，detail 说明 windowed 的核对方式
      const s2 = await fresh()
      await s2.transaction(async (tx) => { await markPending(tx, 'tickets.search') })
      await s2.close()
      out = ''
      expect(await syncCommand(['verify', 'tickets.search', '--db', dbPath()])).toBe(1)
      const t2 = (data().tasks as Array<Record<string, unknown>>)[0]!
      expect(t2.state_windows_consistent).toBe(false)
      const drift = t2.drift as Array<Record<string, unknown>>
      expect(drift.length).toBeGreaterThan(0)
      expect(JSON.stringify(drift)).toMatch(/sync run/)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('快照任务选中但缺凭证 → 1 + auth_missing；纯 windowed 不需要凭证', async () => {
    vi.stubEnv('QIYU_APP_KEY', '')
    vi.stubEnv('QIYU_APP_SECRET', '')
    await fresh().then((s) => s.close())
    expect(await syncCommand(['verify', 'dim.staff', '--db', dbPath()])).toBe(1)
    expect(JSON.parse(out).error.kind).toBe('auth_missing')
    // windowed-only：零网络也不碰凭证（sync_state 空 → drift 退 1，但不是 auth_missing）
    out = ''
    expect(await syncCommand(['verify', 'tickets.search', '--db', dbPath()])).toBe(1)
    expect(JSON.parse(out).ok).toBe(true)
  })

  it('未知任务 → 2', async () => {
    expect(await syncCommand(['verify', 'nope.nope', '--db', dbPath()])).toBe(2)
    expect(JSON.parse(out).error.kind).toBe('usage')
  })
})

describe('sync install', () => {
  /** 预置「已同步过」的库：sync_state 有真实数据集行（install 的前置探测）。 */
  async function seedSynced(): Promise<void> {
    const s = await fresh()
    await s.transaction(async (tx) => {
      await advanceWatermark(tx, 'dim.staff', '2026-10-14T00:00:00.000Z', { start: 0, end: 1 }, '2026-10-14T10:00:00.000Z')
    })
    await s.close()
  }

  it('dry-run：stdout JSON 内含 plist 文本、零文件写入、退出码 0', async () => {
    await seedSynced()
    const code = await syncCommand(['install', '--schedule', '*/30 * * * *', '--db', dbPath()])
    expect(code).toBe(0)
    const d = data()
    expect(d.platform).toBe('darwin')
    expect(d.schedule).toBe('*/30 * * * *')
    expect(d.dry_run).toBe(true)
    const entries = d.entries as Array<{ path: string; content: string }>
    expect(entries[0]!.path).toBe(join(dir, 'Library', 'LaunchAgents', 'com.qiyu-cli.sync.plist'))
    expect(entries[0]!.content).toMatch(/<key>Label<\/key><string>com\.qiyu-cli\.sync<\/string>/)
    expect(entries[0]!.content).toMatch(/<key>Minute<\/key><array><integer>0<\/integer><integer>30<\/integer><\/array>/)
    expect(entries[0]!.content).toMatch(/<string>sync<\/string><string>run<\/string>/)
    // 零文件写入
    expect(existsSync(entries[0]!.path)).toBe(false)
    // 未执行外部命令
    expect(runMock).not.toHaveBeenCalled()
  })

  it('--yes：写 plist 到 HOME、执行 launchctl load（注入 runner），写入内容与 dry-run 一致', async () => {
    await seedSynced()
    expect(await syncCommand(['install', '--schedule', '0 2 * * *', '--db', dbPath()])).toBe(0)
    const dryContent = (data().entries as Array<{ content: string }>)[0]!.content
    out = ''
    const code = await syncCommand(['install', '--schedule', '0 2 * * *', '--db', dbPath(), '--yes'])
    expect(code).toBe(0)
    const d = data()
    expect(d.dry_run).toBe(false)
    const installed = d.installed as string[]
    expect(installed).toEqual([join(dir, 'Library', 'LaunchAgents', 'com.qiyu-cli.sync.plist')])
    expect(readFileSync(installed[0]!, 'utf8')).toBe(dryContent)
    expect(runMock).toHaveBeenCalledWith(['launchctl', 'load', installed[0]!])
  })

  it('缺 --schedule → 2；非法 cron → 2', async () => {
    await seedSynced()
    expect(await syncCommand(['install', '--db', dbPath()])).toBe(2)
    expect(JSON.parse(out).error.message).toMatch(/--schedule/)
    out = ''
    expect(await syncCommand(['install', '--schedule', '不是 cron', '--db', dbPath()])).toBe(2)
    expect(JSON.parse(out).error.kind).toBe('usage')
  })

  it('库未初始化 → 1 + hint 先跑一次 sync run；已初始化但从未同步 → 1 + sync_not_run + hint', async () => {
    expect(await syncCommand(['install', '--schedule', '*/30 * * * *', '--db', join(dir, 'none.db')])).toBe(1)
    let e = JSON.parse(out).error
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/sync run/)

    await fresh().then((s) => s.close())   // 已建库、零同步记录
    out = ''
    expect(await syncCommand(['install', '--schedule', '*/30 * * * *', '--db', dbPath()])).toBe(1)
    e = JSON.parse(out).error
    expect(e.kind).toBe('sync_not_run')
    expect(e.hint).toMatch(/sync run/)
  })

  it('平台注入 linux → 写 service+timer 两个文件', async () => {
    __setPlatform(() => 'linux')
    await seedSynced()
    const code = await syncCommand(['install', '--schedule', '*/30 * * * *', '--db', dbPath(), '--yes'])
    expect(code).toBe(0)
    const installed = data().installed as string[]
    expect([...installed].sort()).toEqual([
      join(dir, '.config', 'systemd', 'user', 'qiyu-sync.service'),
      join(dir, '.config', 'systemd', 'user', 'qiyu-sync.timer'),
    ])
    expect(readFileSync(installed[0]!, 'utf8')).toMatch(/\[Unit\]/)
    expect(runMock).toHaveBeenCalledWith(['systemctl', '--user', 'daemon-reload'])
  })

  it('外部命令失败 → 退出码 1 且命令结果如实透出', async () => {
    await seedSynced()
    __setRun(vi.fn(() => { throw new Error('launchctl: load failed') }))
    const code = await syncCommand(['install', '--schedule', '*/30 * * * *', '--db', dbPath(), '--yes'])
    expect(code).toBe(1)
    const cmds = data().commands as Array<{ ok: boolean; error: string }>
    expect(cmds[0]!.ok).toBe(false)
    expect(cmds[0]!.error).toMatch(/launchctl/)
    // 文件已写入（写入与加载是两步，加载失败不回滚文件）
    expect(existsSync(join(dir, 'Library', 'LaunchAgents', 'com.qiyu-cli.sync.plist'))).toBe(true)
  })
})

describe('sync uninstall', () => {
  const plistPath = (): string => join(dir, 'Library', 'LaunchAgents', 'com.qiyu-cli.sync.plist')

  it('dry-run：列出将删除路径与存在性、文件仍在、零执行', async () => {
    mkdirSync(dirname(plistPath()), { recursive: true })
    writeFileSync(plistPath(), '<plist/>')
    const code = await syncCommand(['uninstall'])
    expect(code).toBe(0)
    const d = data()
    expect(d.dry_run).toBe(true)
    const remove = d.remove as Array<{ path: string; exists: boolean }>
    expect(remove[0]!.path).toBe(plistPath())
    expect(remove[0]!.exists).toBe(true)
    expect(existsSync(plistPath())).toBe(true)
    expect(runMock).not.toHaveBeenCalled()
  })

  it('--yes：先执行 launchctl unload、删除文件', async () => {
    mkdirSync(dirname(plistPath()), { recursive: true })
    writeFileSync(plistPath(), '<plist/>')
    const code = await syncCommand(['uninstall', '--yes'])
    expect(code).toBe(0)
    const removed = data().removed as string[]
    expect(removed).toEqual([plistPath()])
    expect(existsSync(plistPath())).toBe(false)
    expect(runMock).toHaveBeenCalledWith(['launchctl', 'unload', plistPath()])
  })

  it('未安装 → removed 空、退出码 0、不执行外部命令', async () => {
    expect(await syncCommand(['uninstall', '--yes'])).toBe(0)
    expect((data().removed as string[])).toEqual([])
    expect(runMock).not.toHaveBeenCalled()
  })
})
