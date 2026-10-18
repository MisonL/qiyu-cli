// tests/commands/query.test.ts —— E-T8/T9：`query --sql` 与 `query --table` 命令面
// （spec §五/§六/§七/§十/§十一）。
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

/** 固定时钟：上海 2026-10-15 12:00（--since Nd 的 end 与缺省上界都取它，测试不读系统时钟）。 */
const NOW = Date.parse('2026-10-15T04:00:00Z')

/** 同 q()，但注入固定时钟（--table 的时间缺省端依赖它，不注入就会 flaky）。 */
async function qAt(...args: string[]): Promise<number> {
  out = ''; err = ''
  return queryCommand([...args, '--db', dbPath()], { now: () => NOW })
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

/** 在已 seed 的库上追加合成行（upsert 要求每行提供该表完整列集）。 */
async function seedMore(table: string, rows: Record<string, unknown>[]): Promise<void> {
  const s: Store = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  try {
    await s.upsert(table, rows)
  } finally {
    await s.close()
  }
}

/** 考勤行（iso-instant 时间列 hour_ts）：值全为合成。 */
const attendanceRow = (hourTs: string): Record<string, unknown> => ({
  staff_id: '1000001', hour_ts: hourTs, stat_date: '2026-09-14T16:00:00.000Z',
  payload: '{"a":1}', synchronized_at: '2026-10-15T00:00:00.000Z',
})

/** 日报行（iso-day 时间列 stat_date）：stat_date 是上海日零点的 ISO。 */
const overviewRow = (statDate: string): Record<string, unknown> =>
  ({ stat_date: statDate, payload: '{"a":1}', synchronized_at: null })

/**
 * 外部证据：库文件此刻能以 READ_WRITE 打开 —— 说明命令结束后没有只读会话把锁滞留在进程里。
 * 沿 tests/query/sandbox.test.ts「close() 真正释放文件锁」的形态（只关 instance 不关 conn
 * 时锁会随进程存活）；若上一轮会话没关，这里会因冲突锁直接抛错。
 */
async function expectLockReleased(): Promise<void> {
  const { DuckDBInstance } = await import('@duckdb/node-api')
  const inst = await DuckDBInstance.create(dbPath(), { access_mode: 'READ_WRITE' })
  inst.closeSync()
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
    // meta 形状钉死：多一个键 / 少一个键都是契约变更，必须显式改这里
    expect(Object.keys(m).sort()).toEqual([
      'data_coverage', 'limit_applied', 'mask_warnings', 'masked', 'masked_columns',
      'resolved_range', 'rows', 'truncated', 'warnings',
    ])
  })

  it('--limit 2 截断；--limit 3 不截断；--limit 0 / 10001 / 1.5 / abc / -1 → usage 退出码 2', async () => {
    await seed()

    expect(await q('--sql', 'SELECT session_id FROM sessions ORDER BY session_id', '--limit', '2')).toBe(0)
    expect(rowsOf()).toHaveLength(2)
    expect(meta().rows).toBe(2)
    expect(meta().truncated).toBe(true)
    expect(meta().limit_applied).toBe(2)

    expect(await q('--sql', 'SELECT session_id FROM sessions ORDER BY session_id', '--limit', '3')).toBe(0)
    expect(rowsOf()).toHaveLength(3)
    expect(meta().truncated).toBe(false)     // 恰好 limit 行 ≠ 截断

    // -1 是 spec §5.3 明列的「负数」分支：取值不以 -- 开头，能到数值校验，必须被拒
    for (const bad of ['0', '10001', '1.5', 'abc', '-1']) {
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
  it('--sql 与 --table 互斥；都缺 → usage', async () => {
    await seed()

    expect(await q('--sql', 'SELECT 1', '--table', 'sessions')).toBe(2)
    expect(errorOf().kind).toBe('usage')
    expect(err).toMatch(/互斥/)

    expect(await q()).toBe(2)
    expect(errorOf().kind).toBe('usage')
    expect(err).toMatch(/--sql/)
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
    // ⚠️ 以 `--` 开头的文本不再一律当缺值：`-- 注释\nSELECT 1` 是合法 SQL（见「值位守卫」用例）；
    // 只有取值**恰好是已知 flag**（如 `--sql --limit`）才报「缺少取值」。
    for (const empty of ['', '   ', ';', '/* 只有注释 */']) {
      expect(await q('--sql', empty), JSON.stringify(empty)).toBe(2)
      expect(errorOf().kind).toBe('usage')
      expect(errorOf().code).toBe('query_error')
    }

    // 超时/被拦之后只读会话必须已关闭、文件锁不滞留（M11）：
    // 用「同一文件能否以 READ_WRITE 打开」作外部证据，比断言 closeSync 被调用更接近事实。
    await expectLockReleased()
  })

  it('超时：--timeout 0.05 + 超大聚合 → query_timeout 退出码 1；--timeout 0 = 真的不限时', async () => {
    await seed()
    // range(1e11) 的 COUNT 远长于 50ms（tests/query/sandbox.test.ts 同款实测用例）
    expect(await q('--sql', 'SELECT COUNT(*) FROM range(100000000000)', '--timeout', '0.05')).toBe(1)

    const e = errorOf()
    expect(e.kind).toBe('query_timeout')
    expect(e.code).toBe('query_timeout')
    expect(String(e.hint)).toMatch(/--timeout|缩小/)

    // 超时中断后会话必须已关闭、锁不滞留（M11）——否则后续写进程永远打不开这个库
    await expectLockReleased()

    // 0 = 无超时（spec §5.3）：用一条**确定性 >1s** 的查询证明 0 不是「0ms 立即超时」，
    // 也不是「回落到某个小值」。实测 range(2e9) 的 SUM 约 3s（探针实测）。
    // ⚠️ 它证明不了「0 优于默认 30s」—— 那需要 >30s 的查询，测试里不做。
    expect(await q('--sql', 'SELECT SUM(range) AS s FROM range(2000000000)', '--timeout', '0')).toBe(0)
    expect(rowsOf()).toHaveLength(1)
    // SUM(BIGINT) 是 HUGEINT，经 getRowObjectsJson 是**字符串**（spec §5.3）：原样断言，不转 Number
    expect(String(rowsOf()[0].s)).toBe('1999999999000000000')
  })

  it('命令形态：--help 不吞额外参数 / --pretty 显式拒绝 / 未知参数 / 值位守卫', async () => {
    // --help → stdout 用法、退出码 0，两条通道都在
    out = ''; err = ''
    expect(await queryCommand(['--help'])).toBe(0)
    expect(out).toMatch(/query --sql/)
    expect(out).toMatch(/query --table/)
    // Task 9：--table 已实现，USAGE 不得再承诺「尚未实现」；时间/分组参数要在用法里
    expect(out).not.toMatch(/尚未实现/)
    expect(out).toMatch(/--since/)
    expect(out).toMatch(/--until/)
    expect(out).toMatch(/--group-by/)
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

    // 空串参数不得渲染成「未知参数：」冒号后空白（describeArgs）
    expect(await q('--sql', 'SELECT 1', '')).toBe(2)
    expect(err).toMatch(/未知参数：''/)

    // 值位守卫：--sql 缺值、--timeout 非数字 / 负数 / 溢出
    expect(await q('--sql')).toBe(2)
    expect(err).toMatch(/--sql 缺少取值/)
    expect(await q('--sql', 'SELECT 1', '--timeout', 'abc')).toBe(2)
    expect(err).toMatch(/--timeout/)
    expect(await q('--sql', 'SELECT 1', '--timeout', '-1')).toBe(2)
    expect(err).toMatch(/--timeout/)
    // 上界：超过 Node 定时器上限（2^31−1 ms）会溢出成立即超时，必须拒绝而不是静默反转语义
    expect(await q('--sql', 'SELECT 1', '--timeout', '2147484')).toBe(2)
    expect(err).toMatch(/--timeout/)
  })

  it('值位守卫按「是否已知 flag」判定：--sql 接受以 -- 开头的合法 SQL 注释，仍拒绝把 flag 当值', async () => {
    await seed()

    // SQL 以 -- 开头是合法行注释：值给了，就不是「缺少取值」
    expect(await q('--sql', '-- 注释\nSELECT 1 AS x')).toBe(0)
    expect(rowsOf()).toEqual([{ x: 1 }])

    // 取值恰好是已知 flag → 真缺值（否则 `--sql --limit 2` 会把 --limit 当 SQL 文本）
    expect(await q('--sql', '--limit', '2')).toBe(2)
    expect(err).toMatch(/--sql 缺少取值/)
    expect(await q('--sql', '--no-mask')).toBe(2)
    expect(err).toMatch(/--sql 缺少取值/)

    // 其余值位参数仍按前缀拒绝（路径/名字/数字的合法取值不会以 -- 开头）
    expect(await q('--sql', 'SELECT 1', '--db', '--profile')).toBe(2)
    expect(err).toMatch(/--db 缺少取值/)
  })

  it('库缺少 schema_version（空库 / 他人库）→ store_not_initialized 退出码 1 + hint 指 store init', async () => {
    // 合法 DuckDB 但没跑过本 CLI 的迁移：`SELECT 1` 在沙箱里能跑，但 masked 的语义
    // 建立在本 CLI 的 PII 列集上 —— 必须拒绝，把 Agent 引向 store init 而不是改 SQL。
    const mod = (await import('@duckdb/node-api')) as unknown as {
      DuckDBInstance: {
        create: (p: string, o?: unknown) => Promise<{
          connect: () => Promise<{ run: (sql: string) => Promise<unknown>; closeSync: () => void }>
          closeSync: () => void
        }>
      }
    }

    // ① 空库（零表）
    const empty = join(dir, 'empty.db')
    ;(await mod.DuckDBInstance.create(empty)).closeSync()
    out = ''; err = ''
    expect(await queryCommand(['--sql', 'SELECT 1', '--db', empty])).toBe(1)
    let e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(String(e.message)).toMatch(/缺表/)
    expect(String(e.hint)).toMatch(/store init/)

    // ② 他人库：有一张无关表、没有 schema_version —— 即使查询本身能跑也必须拒绝
    const alien = join(dir, 'alien.db')
    const inst = await mod.DuckDBInstance.create(alien)
    const conn = await inst.connect()
    await conn.run('CREATE TABLE alien (a INTEGER)')
    conn.closeSync()   // ⚠️ connection 与 instance 都要关，否则锁随进程存活
    inst.closeSync()
    out = ''; err = ''
    expect(await queryCommand(['--sql', 'SELECT * FROM alien', '--db', alien])).toBe(1)
    e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(String(e.hint)).toMatch(/store init/)
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

describe('query --table · 成功路径（spec §六/§十）', () => {
  it('精确脱敏：sensitive 列全脱敏、session_type 原样；meta 仍是九键（形状钉死）', async () => {
    await seed()
    expect(await qAt('--table', 'sessions')).toBe(0)
    expect(err).toBe('')

    expect(rowsOf()).toHaveLength(3)
    const row = rowsOf()[0]
    expect(row.userPhone).toBe('138****1111')   // §7.1 手机号规则：前 3 后 4
    expect(row.userName).toBe('<已脱敏>')        // 姓名无格式 → 整值替换
    expect(row.payload).toBe('<已脱敏>')         // payload 是 PII 完整副本 → 整值替换
    expect(row.session_type).toBe('human')      // 非敏感列不得误伤
    expect(row.userEmail).toBeNull()            // null 不变成字符串
    expect(out).not.toContain('13800001111')

    const m = meta()
    expect(m.rows).toBe(3)
    expect(m.truncated).toBe(false)
    expect(m.limit_applied).toBe(1000)
    expect(m.masked).toBe(true)
    // 实际被改写的列，按输出列序
    expect(m.masked_columns).toEqual(['payload', 'userPhone', 'userName'])
    expect(m.mask_warnings).toEqual([])
    expect(m.warnings).toEqual([])
    // 没给 --since/--until → 不回显区间；有 timeColumn → 覆盖恒计算
    expect(m.resolved_range).toBeNull()
    expect(m.data_coverage).toEqual({
      min: '2026-10-14T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00',
    })
    expect(Object.keys(m).sort()).toEqual([
      'data_coverage', 'limit_applied', 'mask_warnings', 'masked', 'masked_columns',
      'resolved_range', 'rows', 'truncated', 'warnings',
    ])
  })

  it('--no-mask：输出原值 + meta.warnings 带 PII 警告，masked_columns 为空', async () => {
    await seed()
    expect(await qAt('--table', 'sessions', '--no-mask')).toBe(0)

    expect(rowsOf()[0].userPhone).toBe('13800001111')
    expect(rowsOf()[0].userName).toBe('测试用户')
    expect(meta().masked).toBe(false)
    expect(meta().masked_columns).toEqual([])
    expect(meta().warnings).toContain(NO_MASK_WARNING)
    expect(meta().mask_warnings).toEqual([])
  })

  it('iso-day：--since 9/15 12:00 向下取整后仍包含 stat_date=9/15 零点的行（spec §四 的核心语义）', async () => {
    await seed()
    // 夹具行的 stat_date = 2026-10-13T16:00:00.000Z = 上海 10/14 00:00
    expect(await qAt('--table', 'daily_overview', '--since', '2026-10-14T12:00:00+08:00')).toBe(0)

    expect(rowsOf()).toHaveLength(1)
    expect(rowsOf()[0].stat_date).toBe('2026-10-13T16:00:00.000Z')
    // resolved_range 回显**实际生效**的区间：两端都是上海日零点（含 --until 所在日全天）
    expect(meta().resolved_range).toEqual([
      '2026-10-14T00:00:00+08:00', '2026-10-15T00:00:00+08:00',
    ])
    expect(meta().data_coverage).toEqual({
      min: '2026-10-14T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00',
    })
  })

  it('iso-instant：staff_attendance 按 hour_ts 字符串比较（不取整）', async () => {
    await seed()
    await seedMore('staff_attendance', [
      attendanceRow('2026-09-15T02:00:00.000Z'),
      attendanceRow('2026-09-15T05:00:00.000Z'),
    ])
    expect(await qAt('--table', 'staff_attendance',
      '--since', '2026-09-15T01:00:00Z', '--until', '2026-09-15T03:00:00Z')).toBe(0)

    expect(rowsOf().map((r) => r.hour_ts)).toEqual(['2026-09-15T02:00:00.000Z'])
    expect(meta().resolved_range).toEqual([
      '2026-09-15T09:00:00+08:00', '2026-09-15T11:00:00+08:00',
    ])
  })

  it('epoch-ms：TRY_CAST 排除非数字 startTime；data_coverage 只覆盖过滤范围', async () => {
    await seed()
    await seedMore('sessions', [
      { ...sessionRow('s4'), startTime: String(Date.parse('2026-09-01T00:00:00Z')) },
      { ...sessionRow('s5'), startTime: 'not-a-number' },   // 非数字行不参与时间比较
    ])
    expect(await qAt('--table', 'sessions',
      '--since', '2026-08-31', '--until', '2026-09-03')).toBe(0)

    expect(rowsOf().map((r) => r.session_id)).toEqual(['s4'])
    // 全表覆盖会是 [9/1 08:00, 10/14 00:00]；过滤后只剩 s4 一段
    expect(meta().data_coverage).toEqual({
      min: '2026-09-01T08:00:00+08:00', max: '2026-09-01T08:00:00+08:00',
    })
  })

  it('--group-by：count 是 number（BIGINT 字符串必须 Number 收敛）+ 分组确定性排序', async () => {
    await seed()
    expect(await qAt('--table', 'sessions', '--since', '30d', '--group-by', 'session_type')).toBe(0)

    expect(rowsOf()).toEqual([{ session_type: 'human', count: 3 }])
    expect(typeof rowsOf()[0].count).toBe('number')
    expect(meta().masked_columns).toEqual([])   // 分组列已排除敏感列
    expect(meta().resolved_range).toEqual([
      '2026-09-15T12:00:00+08:00', '2026-10-15T12:00:00+08:00',
    ])
  })

  it('确定性排序：同一 startTime 的行按主键 ASC，跑两次顺序一致', async () => {
    await seed()
    expect(await qAt('--table', 'sessions')).toBe(0)
    const first = rowsOf().map((r) => r.session_id)
    expect(first).toEqual(['s1', 's2', 's3'])

    expect(await qAt('--table', 'sessions')).toBe(0)
    expect(rowsOf().map((r) => r.session_id)).toEqual(first)
  })

  it('截断：--limit 2 → truncated true；data_coverage 仍覆盖全表（独立查询，不受 limit 影响）', async () => {
    await seed()
    expect(await qAt('--table', 'sessions', '--limit', '2')).toBe(0)

    expect(rowsOf()).toHaveLength(2)
    expect(meta().rows).toBe(2)
    expect(meta().truncated).toBe(true)
    expect(meta().data_coverage).toEqual({
      min: '2026-10-14T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00',
    })
  })

  it('只有 --until → 下界取该表 MIN；空表 → resolved_range null + 两条 warning', async () => {
    await seed()
    await seedMore('sessions', [
      { ...sessionRow('s4'), startTime: String(Date.parse('2026-10-01T00:00:00Z')) },
    ])
    expect(await qAt('--table', 'sessions', '--until', '2026-10-05')).toBe(0)

    expect(rowsOf().map((r) => r.session_id)).toEqual(['s4'])
    expect(meta().resolved_range).toEqual([
      '2026-10-01T08:00:00+08:00', '2026-10-05T00:00:00+08:00',
    ])

    // 空表（无任何行）→ 无法解析缺省下界
    expect(await qAt('--table', 'robot_summary', '--until', '2026-10-05')).toBe(0)
    expect(rowsOf()).toHaveLength(0)
    expect(meta().resolved_range).toBeNull()
    expect(meta().data_coverage).toBeNull()
    const warnings = meta().warnings as string[]
    expect(warnings.some((w) => /无法解析缺省下界/.test(w))).toBe(true)
    expect(warnings.some((w) => /0 行/.test(w))).toBe(true)
  })

  it('0 行 + 时间过滤 → warning 说明实际区间（与 --sql 通道同源文案）', async () => {
    await seed()
    expect(await qAt('--table', 'daily_overview',
      '--since', '2026-10-01', '--until', '2026-10-05')).toBe(0)

    const warnings = meta().warnings as string[]
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('2026-10-01T00:00:00+08:00')
    expect(warnings[0]).toContain('2026-10-05T00:00:00+08:00')
    expect(warnings[0]).toContain('这不代表没有数据')
    expect(warnings[0]).toContain('qiyu sync status')
  })
})

describe('query --table · 参数与错误分派（spec §六/§十一）', () => {
  it('未知表 → usage + 候选 sessions', async () => {
    await seed()
    expect(await qAt('--table', 'sessons')).toBe(2)

    expect(errorOf().kind).toBe('usage')
    expect(err).toMatch(/未知表：sessons/)
    expect(String(errorOf().hint)).toContain('sessions')
  })

  it('无 timeColumn 的表给 --since/--until → usage + 有 timeColumn 的表清单', async () => {
    await seed()
    expect(await qAt('--table', 'staff', '--since', '2026-09-01')).toBe(2)

    expect(errorOf().kind).toBe('usage')
    expect(err).toMatch(/没有时间列/)
    // hint 列出**有**时间列的表，而不是全表清单
    const hint = String(errorOf().hint)
    expect(hint).toContain('daily_overview')
    expect(hint).toContain('sessions')
    expect(hint).not.toMatch(/支持时间过滤的表：.*staff[^_]/)
  })

  it('--group-by 未知列 / 敏感列 / 重复列 → usage', async () => {
    await seed()

    expect(await qAt('--table', 'sessions', '--group-by', 'session_typ')).toBe(2)
    expect(errorOf().kind).toBe('usage')
    expect(err).toMatch(/未知列.*session_typ/)
    expect(err).toContain('session_type')   // 该表列候选

    for (const col of ['userPhone', 'payload']) {
      expect(await qAt('--table', 'sessions', '--group-by', col), col).toBe(2)
      expect(err, col).toContain(`不接受敏感列 ${col}`)
      expect(err, col).toContain('失真')
      expect(err, col).toContain('--sql')
    }

    expect(await qAt('--table', 'sessions',
      '--group-by', 'session_type', '--group-by', 'session_type')).toBe(2)
    expect(err).toMatch(/重复/)
  })

  it('区间无效（start >= end）→ usage', async () => {
    await seed()
    expect(await qAt('--table', 'sessions',
      '--since', '2026-10-20', '--until', '2026-10-01')).toBe(2)

    expect(errorOf().kind).toBe('usage')
    expect(err).toMatch(/区间无效/)
  })

  it('--sql 与 --since/--until/--group-by 同用 → usage（只适用于 --table）', async () => {
    await seed()

    for (const extra of [['--since', '30d'], ['--until', '2026-10-01'], ['--group-by', 'x']]) {
      expect(await qAt('--sql', 'SELECT 1', ...extra), extra.join(' ')).toBe(2)
      expect(errorOf().kind).toBe('usage')
      expect(err).toMatch(/只适用于 --table/)
    }
  })

  it('--since/--until 无法解析 → usage', async () => {
    await seed()
    expect(await qAt('--table', 'sessions', '--since', '不是时间')).toBe(2)
    expect(err).toMatch(/--since 无法解析/)
    expect(await qAt('--table', 'sessions', '--until', '不是时间')).toBe(2)
    expect(err).toMatch(/--until 无法解析/)
  })
})
