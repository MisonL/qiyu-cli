// tests/commands/query.test.ts —— E-T8：`query --sql` 命令面（spec §五/§七/§十/§十一）。
// 夹具沿 tests/commands/db.test.ts：mkdtemp + stubEnv('HOME') + 真 DuckDB 临时库 +
// spy stdout/stderr 双通道。
// ⚠️ fixtures 全合成：13800001111 是明显的测试号码，不使用任何真实企业数据。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { queryCommand } from '../../src/commands/query.js'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { NO_MASK_WARNING } from '../../src/query/mask.js'
import type { Store } from '../../src/store/types.js'

// DuckDB 冷启动偶发 >5s（与 tests/commands/db.test.ts 同款放宽）；
// 超时用例要等 conn.interrupt 生效（实测约 300ms），一并放宽。
vi.setConfig({ testTimeout: 15_000 })

let dir = ''
let out = ''
let err = ''
const dbPath = (): string => join(dir, 'q.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-query-'))
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
  vi.stubEnv('HOME', dir)   // 隔离真实 ~（配置文件与默认库路径都走 HOME）
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const data = (): Record<string, unknown> => JSON.parse(out).data
const meta = (): Record<string, unknown> => JSON.parse(out).meta
const errorOf = (): Record<string, unknown> => JSON.parse(out).error
const rowsOf = (): Array<Record<string, unknown>> => data().rows as Array<Record<string, unknown>>

/** 跑一次 query 子命令；`--db` 固定指向临时库。返回退出码。 */
async function q(...args: string[]): Promise<number> {
  out = ''; err = ''
  return queryCommand([...args, '--db', dbPath()])
}

/** 会话行（payload 为合成 JSON，userPhone 是明显的测试号码）。 */
const sessionRow = (id: string): Record<string, unknown> => ({
  session_id: id, payload: JSON.stringify({ id }), staffId: '1000001',
  startTime: '1791907200000', endTime: null, session_type: 'human', categoryDetail: null,
  userPhone: '13800001111', userName: '测试用户', userEmail: null, userAddress: null,
  fromIp: null, userIpCity: null, userCrmInfo: null,
  synchronized_at: '2026-10-15T00:00:00.000Z',
})

/** rw 建库（跑完全部迁移 → 25 张表）+ 合成数据；调用方无需再关闭。 */
async function seed(): Promise<void> {
  const s: Store = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  try {
    await s.init()
    await s.upsert('sessions', [sessionRow('s1'), sessionRow('s2'), sessionRow('s3')])
    await s.upsert('daily_overview', [
      { stat_date: '2026-10-13T16:00:00.000Z', payload: '{"a":1}', synchronized_at: null },
    ])
  } finally {
    await s.close()
  }
}

describe('query --sql · 成功路径（spec §十）', () => {
  it('返回 columns/rows 与完整 meta：rows/truncated/limit_applied/masked/masked_columns/mask_warnings/warnings', async () => {
    await seed()
    expect(await q('--sql', 'SELECT session_id, startTime FROM sessions ORDER BY session_id')).toBe(0)

    expect(JSON.parse(out).ok).toBe(true)
    // 列名来自 DuckDB（表定义大小写），空结果集也必须有真实列名（另一条用例钉死）
    expect(data().columns).toEqual(['session_id', 'startTime'])
    expect(rowsOf()).toHaveLength(3)
    expect(rowsOf().map((r) => r.session_id)).toEqual(['s1', 's2', 's3'])
    expect(err).toBe('')   // 成功路径 stderr 必须干净

    const m = meta()
    expect(m.rows).toBe(3)
    expect(m.truncated).toBe(false)
    expect(m.limit_applied).toBe(1000)      // 默认上限
    expect(m.masked).toBe(true)             // 默认脱敏
    expect(m.masked_columns).toEqual([])    // 本查询无敏感列
    expect(m.mask_warnings).toEqual([])
    expect(m.warnings).toEqual([])
    // --sql 通道无法通用判定区间与覆盖（spec §十）：恒为 null，不猜
    expect(m.resolved_range).toBeNull()
    expect(m.data_coverage).toBeNull()
  })

  it('--limit 2 截断；--limit 3 不截断；--limit 0 / 10001 / 非整数 → usage 退出码 2', async () => {
    await seed()

    expect(await q('--sql', 'SELECT session_id FROM sessions ORDER BY session_id', '--limit', '2')).toBe(0)
    expect(rowsOf()).toHaveLength(2)
    expect(meta().rows).toBe(2)
    expect(meta().truncated).toBe(true)
    expect(meta().limit_applied).toBe(2)

    expect(await q('--sql', 'SELECT session_id FROM sessions ORDER BY session_id', '--limit', '3')).toBe(0)
    expect(rowsOf()).toHaveLength(3)
    expect(meta().truncated).toBe(false)     // 恰好 limit 行 ≠ 截断

    for (const bad of ['0', '10001', '1.5', 'abc']) {
      expect(await q('--sql', 'SELECT 1', '--limit', bad), bad).toBe(2)
      expect(errorOf().kind, bad).toBe('usage')
      expect(err, bad).toMatch(/--limit/)
    }
  })

  it('默认脱敏：userPhone → 138****1111、userName → <已脱敏>；--no-mask 原值 + PII 警告', async () => {
    await seed()

    expect(await q('--sql', 'SELECT userPhone, userName FROM sessions ORDER BY session_id')).toBe(0)
    expect(rowsOf()[0].userPhone).toBe('138****1111')
    expect(rowsOf()[0].userName).toBe('<已脱敏>')
    expect(meta().masked).toBe(true)
    expect(meta().masked_columns).toEqual(['userPhone', 'userName'])
    // 原始手机号不得以任何形式出现在 stdout
    expect(out).not.toContain('13800001111')

    expect(await q('--sql', 'SELECT userPhone, userName FROM sessions ORDER BY session_id', '--no-mask')).toBe(0)
    expect(rowsOf()[0].userPhone).toBe('13800001111')
    expect(rowsOf()[0].userName).toBe('测试用户')
    expect(meta().masked).toBe(false)
    expect(meta().masked_columns).toEqual([])
    // spec §7.2：--no-mask 的 PII 风险警告进 meta.warnings（不是 mask_warnings —— 没脱敏就无缺口可言）
    expect(meta().warnings).toContain(NO_MASK_WARNING)
    expect(meta().mask_warnings).toEqual([])
  })

  it('别名绕过列名匹配 → 值级兜底脱敏 + meta.mask_warnings 声明缺口（spec §7.2）', async () => {
    await seed()
    expect(await q('--sql', 'SELECT userPhone AS p FROM sessions ORDER BY session_id')).toBe(0)

    // 值级兜底命中手机号形态（别名绕过了列名级）
    expect(rowsOf()[0].p).toBe('138****1111')
    expect(meta().masked_columns).toEqual(['p'])
    // 静态缺口警告：SQL 引用了 userPhone，但输出列名不匹配
    const gaps = meta().mask_warnings as string[]
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toContain('userPhone')
    expect(gaps[0]).toContain('脱敏可能不完整')
  })

  it('0 行 + SQL 含时间列 → meta.warnings 一条可操作文案；空结果集仍有真实列名', async () => {
    await seed()
    expect(await q('--sql', 'SELECT stat_date FROM daily_overview WHERE 1=0')).toBe(0)

    expect(data().columns).toEqual(['stat_date'])   // 空结果集也必须有真实列名
    expect(rowsOf()).toHaveLength(0)
    expect(meta().rows).toBe(0)
    expect(meta().truncated).toBe(false)

    const warnings = meta().warnings as string[]
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('这不代表没有数据')
    expect(warnings[0]).toContain('qiyu sync status')
  })
})

describe('query --sql · 参数与错误分派（spec §十一）', () => {
  it('--sql 与 --table 互斥；都缺 → usage；--table 单独给 → 尚未实现（Task 9 替换）', async () => {
    await seed()

    expect(await q('--sql', 'SELECT 1', '--table', 'sessions')).toBe(2)
    expect(errorOf().kind).toBe('usage')
    expect(err).toMatch(/互斥/)

    expect(await q()).toBe(2)
    expect(errorOf().kind).toBe('usage')
    expect(err).toMatch(/--sql/)

    expect(await q('--table', 'sessions')).toBe(2)
    expect(errorOf().kind).toBe('usage')
    expect(err).toMatch(/尚未实现/)
  })

  it('未知表 → usage + query_error + 候选 sessions（不裸透 DuckDB 英文原文）', async () => {
    await seed()
    expect(await q('--sql', 'SELECT * FROM sessons')).toBe(2)

    const e = errorOf()
    expect(e.kind).toBe('usage')
    expect(e.code).toBe('query_error')
    expect(String(e.hint)).toContain('sessions')
    expect(String(e.message)).not.toMatch(/Catalog Error/)   // 中文包装，原文只在 cause 里
  })

  it('多语句 / COPY / ATTACH → sandbox_blocked 退出码 2，且不留副作用', async () => {
    await seed()

    // 多语句：DuckDB 实测会逐条执行 —— 被拦后表必须还在
    expect(await q('--sql', 'SELECT 1; DROP TABLE sessions')).toBe(2)
    expect(errorOf().code).toBe('sandbox_blocked')
    expect(await q('--sql', 'SELECT COUNT(*) AS n FROM sessions')).toBe(0)
    expect(Number(rowsOf()[0].n)).toBe(3)

    const target = join(dir, 'out.csv')
    expect(await q('--sql', `COPY sessions TO '${target}'`)).toBe(2)
    expect(errorOf().code).toBe('sandbox_blocked')
    expect(existsSync(target)).toBe(false)   // 副作用不存在才是这行的意义

    expect(await q('--sql', "ATTACH ':memory:' AS x")).toBe(2)
    expect(errorOf().code).toBe('sandbox_blocked')

    // 空 SQL / 纯注释 / 裸分号 → usage + query_error（spec §十一 行 1）
    // ⚠️ 以 `--` 开头的文本走值位守卫（「--sql 缺少取值」），到不了沙箱 —— 见下方用例。
    for (const empty of ['', '   ', ';', '/* 只有注释 */']) {
      expect(await q('--sql', empty), JSON.stringify(empty)).toBe(2)
      expect(errorOf().kind).toBe('usage')
      expect(errorOf().code).toBe('query_error')
    }
  })

  it('超时：--timeout 0.05 + 超大聚合 → query_timeout 退出码 1', async () => {
    await seed()
    // range(1e11) 的 COUNT 远长于 50ms（tests/query/sandbox.test.ts 同款实测用例）
    expect(await q('--sql', 'SELECT COUNT(*) FROM range(100000000000)', '--timeout', '0.05')).toBe(1)

    const e = errorOf()
    expect(e.kind).toBe('query_timeout')
    expect(e.code).toBe('query_timeout')
    expect(String(e.hint)).toMatch(/--timeout|缩小/)

    // 0 = 无超时（spec §5.3）：同一条大查询加 --timeout 0 不会因超时失败
    // （用轻量查询验证语义，避免真的跑大查询拖慢测试）
    expect(await q('--sql', 'SELECT 1 AS x', '--timeout', '0')).toBe(0)
    expect(rowsOf()).toEqual([{ x: 1 }])
  })

  it('命令形态：--help 不吞额外参数 / --pretty 显式拒绝 / 未知参数 / 值位守卫', async () => {
    // --help → stdout 用法、退出码 0，两条通道都在
    out = ''; err = ''
    expect(await queryCommand(['--help'])).toBe(0)
    expect(out).toMatch(/query --sql/)
    expect(out).toMatch(/query --table/)
    expect(err).toBe('')

    // --help 不吞额外参数
    out = ''; err = ''
    expect(await queryCommand(['--help', '--bogus'])).toBe(2)
    expect(err).toMatch(/--help 不接受额外参数/)

    // --pretty 显式拒绝（归 G1）
    out = ''; err = ''
    expect(await queryCommand(['--sql', 'SELECT 1', '--pretty'])).toBe(2)
    expect(err).toMatch(/--pretty/)

    // 未知参数
    expect(await q('--sql', 'SELECT 1', '--bogus')).toBe(2)
    expect(err).toMatch(/未知参数/)

    // 值位守卫：--sql 缺值、--timeout 非数字 / 负数
    expect(await q('--sql')).toBe(2)
    expect(err).toMatch(/--sql 缺少取值/)
    expect(await q('--sql', 'SELECT 1', '--timeout', 'abc')).toBe(2)
    expect(err).toMatch(/--timeout/)
    expect(await q('--sql', 'SELECT 1', '--timeout', '-1')).toBe(2)
    expect(err).toMatch(/--timeout/)
  })

  it('库不存在 → store_not_initialized 退出码 1 + hint 指 store init', async () => {
    out = ''; err = ''
    expect(await queryCommand(['--sql', 'SELECT 1', '--db', join(dir, 'missing.db')])).toBe(1)
    const e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(String(e.hint)).toMatch(/store init/)
  })

  it('文件存在但不是 DuckDB → openSandbox 抛错经 thrownToQueryExit：退出码 1、store_not_initialized', async () => {
    const alien = join(dir, 'not-a-db.bin')
    writeFileSync(alien, '这不是数据库')
    out = ''; err = ''
    expect(await queryCommand(['--sql', 'SELECT 1', '--db', alien])).toBe(1)
    const e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(String(e.hint)).toMatch(/store init|--db/)
  })
})
