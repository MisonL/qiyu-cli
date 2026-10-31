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
// DuckDB 冷启动在慢机上实测可达 10s+（首条用例尤其明显），15s 会偶发假失败；
// 与 tests/store/duckdb.test.ts 同款放宽到 30s。真正的挂起由单条用例自己的超时兜底。
vi.setConfig({ testTimeout: 30_000 })

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
  vi.stubEnv('USERPROFILE', dir)
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
 * 外部证据：库文件此刻能被**另一个进程**以 READ_WRITE 打开。
 *
 * ⚠️ 必须用子进程（测试审查 F1）：DuckDB 的文件锁是**进程级**的 —— 同一进程里只读
 * 实例/连接仍然开着时，`DuckDBInstance.create(path, {READ_WRITE})` 照样成功。早先的
 * 同进程版本是空证：把 `finally { await session.close() }` 整段删掉，query.test 仍然全绿。
 * 子进程持有锁时，本进程的 RW 打开才会报 `Conflicting lock is held`。
 */
async function expectLockReleased(): Promise<void> {
  const { execFileSync } = await import('node:child_process')
  execFileSync(process.execPath, [
    '--input-type=module',
    '-e',
    `import { DuckDBInstance } from '@duckdb/node-api';
     const i = await DuckDBInstance.create(${JSON.stringify(dbPath())}, { access_mode: 'READ_WRITE' });
     i.closeSync();`,
  ], { cwd: process.cwd(), stdio: 'pipe', timeout: 30_000 })
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
    // 2026-10-27 起多一个 field_notes（9 个键的逐条释义，见 query-notes.ts）
    expect(Object.keys(m).sort()).toEqual([
      'data_coverage', 'field_notes', 'limit_applied', 'mask_warnings', 'masked',
      'masked_columns', 'resolved_range', 'rows', 'truncated', 'warnings',
    ])
  })

  it('--limit 2 截断；--limit 3 不截断；--limit 0 / 10001 / 1.5 / abc / -1 → usage 退出码 2', async () => {
    await seed()

    expect(await q('--sql', 'SELECT session_id FROM sessions ORDER BY session_id', '--limit', '2')).toBe(0)
    expect(rowsOf()).toHaveLength(2)
    expect(meta().rows).toBe(2)
    expect(meta().truncated).toBe(true)
    expect(meta().limit_applied).toBe(2)
    // 截断不得静默：warning 要同时说清「不是全量」与「别拿这批结果判缺口」，并给替代路径
    const w = meta().warnings as string[]
    expect(w).toHaveLength(1)
    expect(w[0]).toMatch(/不是全部/)
    expect(w[0]).toMatch(/db describe/)
    // ⚠️ 替代路径必须在该通道真的可行：--since/--until/--group-by 与 --sql 同用会被拒
    expect(w[0]).toMatch(/在 SQL 里加 WHERE/)
    expect(w[0]).not.toMatch(/--since/)

    expect(await q('--sql', 'SELECT session_id FROM sessions ORDER BY session_id', '--limit', '3')).toBe(0)
    expect(rowsOf()).toHaveLength(3)
    expect(meta().truncated).toBe(false)     // 恰好 limit 行 ≠ 截断
    expect((meta().warnings as string[])).toEqual([])   // 未截断 → 无该警告

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

  it('重名输出列（自连接 / 重复列）的第二列也必须脱敏，不得以 :N 键原样漏出（安全 Critical）', async () => {
    await seed()
    // 驱动把重复列名去重成 `userPhone:1`，而列名 API 返回未去重的序列。若命令层
    // 用未去重的列名，脱敏只遍历 userPhone 两次、`:1` 键从未被访问 —— 实测
    // `SELECT userPhone, userPhone FROM sessions` 会输出第二个原始号码。
    expect(await q('--sql',
      'SELECT userPhone, userPhone FROM sessions ORDER BY session_id LIMIT 1')).toBe(0)
    const cols = data().columns as string[]
    expect(cols).toEqual(['userPhone', 'userPhone:1'])
    const row = rowsOf()[0]
    expect(row.userPhone).toBe('138****1111')
    expect(row['userPhone:1']).toBe('138****1111')   // 关键断言：第二列也被改写
    expect(JSON.stringify(row)).not.toContain('13800001111')
    expect(meta().masked_columns).toEqual(['userPhone', 'userPhone:1'])
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

    // ⚠️ 大小写不敏感（契约审查 C-02）：`SELECT * FROM sessions WHERE STARTTIME > …`
    // 是合法 SQL，敏感匹配会让这条警告静默失效。
    expect(await q('--sql', 'SELECT session_id FROM sessions WHERE UPPER(STARTTIME) > \'9\'')).toBe(0)
    expect((meta().warnings as string[]).some((x) => /这不代表没有数据/.test(x))).toBe(true)
  })

  it('iso-day 列 + 日期形态字面量 → meta.warnings 警告少一天（场景 F3）', async () => {
    await seed()
    // CLI 自己把 stat_date 说成 +08:00 形态（db tables / db describe），Agent 照抄会写
    // 出下面这句——列是 VARCHAR、按字典序比较，整整少一天，退出码 0 且原本无任何提示。
    expect(await q('--sql',
      "SELECT COUNT(*) AS n FROM daily_overview WHERE stat_date >= '2026-10-13T00:00:00+08:00'")).toBe(0)
    const w = meta().warnings as string[]
    expect(w.some((x) => /UTC `…Z` 形态|少算或漏掉当天/.test(x))).toBe(true)

    // 纯日期字面量同样触发
    expect(await q('--sql',
      "SELECT COUNT(*) AS n FROM daily_overview WHERE stat_date >= '2026-10-13'")).toBe(0)
    expect((meta().warnings as string[]).some((x) => /少算或漏掉当天/.test(x))).toBe(true)

    // ⚠️ 空格分隔形态同样触发（场景审查 4）：`'2026-10-13 00:00:00'` 与 `T` 形态等价，
    // 旧正则只认 `T` → 这种写法静默少算一天、零 warning。
    expect(await q('--sql',
      "SELECT COUNT(*) AS n FROM daily_overview WHERE stat_date >= '2026-10-13 00:00:00'")).toBe(0)
    expect((meta().warnings as string[]).some((x) => /少算或漏掉当天/.test(x))).toBe(true)

    // 反证 1：UTC `…Z` 形态（正确写法）不警告
    expect(await q('--sql',
      "SELECT COUNT(*) AS n FROM daily_overview WHERE stat_date >= '2026-10-12T16:00:00.000Z'")).toBe(0)
    expect((meta().warnings as string[]).some((x) => /少算或漏掉当天/.test(x))).toBe(false)

    // 反证 2：无关表的日期字面量（没有 iso-day 列名）不警告
    expect(await q('--sql',
      "SELECT COUNT(*) AS n FROM sessions WHERE session_id >= '2026-10-13'")).toBe(0)
    expect((meta().warnings as string[]).some((x) => /少算或漏掉当天/.test(x))).toBe(false)
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
    // 审查 I-4：hint 不得点名 `--timeout` —— db/query/stats 三命令共用本出口，
    // 只有 query 认该 flag，建议它等于给 `db tables` 的用户一条走不通的路。
    expect(String(e.hint)).toMatch(/缩小|收窄/)
    expect(String(e.hint)).not.toMatch(/--timeout/)

    // 超时中断后会话必须已关闭、锁不滞留（M11）——否则后续写进程永远打不开这个库
    await expectLockReleased()

    // 审查 I-6：极小正数（0.0001 秒 → 0.1ms → 四舍五入为 0ms）必须**仍然超时**，
    // 而不是被当成 `--timeout 0`（= 不限时，与用户意图相反）。此前该钳制分支无观测。
    expect(await q('--sql', 'SELECT COUNT(*) FROM range(100000000000)', '--timeout', '0.0001')).toBe(1)
    expect(errorOf().kind).toBe('query_timeout')
    await expectLockReleased()

    // 0 = 无超时（spec §5.3）：用一条**确定性 >1s** 的查询证明 0 不是「0ms 立即超时」，
    // 也不是「回落到某个小值」。实测 range(2e9) 的 SUM 约 3s（探针实测）。
    // ⚠️ 它证明不了「0 优于默认 30s」—— 那需要 >30s 的查询，测试里不做。
    expect(await q('--sql', 'SELECT SUM(range) AS s FROM range(2000000000)', '--timeout', '0')).toBe(0)
    expect(rowsOf()).toHaveLength(1)
    // SUM(BIGINT) 是 HUGEINT，经 getRowObjectsJson 是**字符串**（spec §5.3）：原样断言，不转 Number
    expect(String(rowsOf()[0].s)).toBe('1999999999000000000')
    // ⚠️ 本用例含一条确定性 >1s 的查询 + 两次子进程锁验证，15s 全局超时在慢 CI 上不够。
  }, 40_000)

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

    // G1 起 --pretty 已实现：合法调用 + 缩进输出（原「显式拒绝」断言翻转）。
    // ⚠️ 仍需真实库才能跑 SELECT —— 但「未知参数」这条错误排在开库之前，
    // 所以先钉次序红线（--sql 缺值优先），再在带库用例里钉缩进行为。
    out = ''; err = ''
    expect(await queryCommand(['--sql', '--pretty'])).toBe(2)
    expect(err).toMatch(/--sql 缺少取值/)

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

  it('库缺少 schema_version（空库 / 他人库）→ store_not_initialized，空库指 store init、他人库换 --db（架构审查 F1）', async () => {
    // 合法 DuckDB 但没跑过本 CLI 的迁移：`SELECT 1` 在沙箱里能跑，但 masked 的语义
    // 建立在本 CLI 的 PII 列集上 —— 必须拒绝。但「缺表」有两大类成因：
    //   · 空库（零表）→ store init 可补建；
    //   · 他人库（有表无 schema_version）→ store init 会再次失败，需换 --db 路径。
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
    expect(String(e.message)).toMatch(/缺表/)
    expect(String(e.hint)).not.toMatch(/store init/)
    expect(String(e.hint)).toMatch(/换 --db 路径/)
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
    // 2026-10-31：成因分流统一到 `store/retry.ts` 的 `classifyOpenFailure` 后，
    // 「不是 DuckDB 文件」的 hint 与 `store status` 同口径 —— 不再说「请确认…由本 CLI
    // 创建（store init）」，那会把 Agent 引向一个对非 DuckDB 文件必然再失败的命令。
    expect(String(e.hint)).toMatch(/不是 DuckDB 数据库，请换 --db 路径/)
    expect(String(e.hint), '不得再引导向 store init（对非 DuckDB 文件是死路）').not.toContain('store init')
  })

  it('权限不足 → 与 store 同口径的「读写权限」hint（同一成因不在两个命令族给两种说法）', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return  // root 下 chmod 不拦读取
    const { chmodSync } = await import('node:fs')
    const p = join(dir, 'noread.db')
    writeFileSync(p, 'x'.repeat(4096))
    chmodSync(p, 0o000)
    try {
      out = ''; err = ''
      expect(await queryCommand(['--sql', 'SELECT 1', '--db', p])).toBe(1)
      const e = errorOf()
      expect(e.kind).toBe('store_not_initialized')
      expect(String(e.hint)).toMatch(/读写权限/)
      expect(String(e.hint), '权限问题不得说成「文件不存在/不是本 CLI 创建」').not.toContain('store init')
    } finally { chmodSync(p, 0o600) }
  })
})

describe('query --table · 成功路径（spec §六/§十）', () => {
  it('精确脱敏：sensitive 列全脱敏、session_type 原样；meta 十键（形状钉死）', async () => {
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
    // 2026-10-27 起多一个 field_notes（9 个键的逐条释义，见 query-notes.ts）
    expect(Object.keys(m).sort()).toEqual([
      'data_coverage', 'field_notes', 'limit_applied', 'mask_warnings', 'masked',
      'masked_columns', 'resolved_range', 'rows', 'truncated', 'warnings',
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

  it('iso-day 单日区间：--since 与 --until 落在同一天 → 合法，只返回那一天（不是用法错误）', async () => {
    await seed()
    expect(await qAt('--table', 'daily_overview',
      '--since', '2026-10-14T08:00:00+08:00', '--until', '2026-10-14T20:00:00+08:00')).toBe(0)

    expect(rowsOf()).toHaveLength(1)
    expect(rowsOf()[0].stat_date).toBe('2026-10-13T16:00:00.000Z')   // 上海 10/14 零点
    expect(meta().resolved_range).toEqual([
      '2026-10-14T00:00:00+08:00', '2026-10-14T00:00:00+08:00'])
  })

  // ⚠️ `parseTimeArg` 的区间形态（yesterday / Nd）是**半开** `[start, end)`，
  // 而查询谓词是闭区间 `<=`。直接把 `.end` 当上界会多算一天：iso-day 取整后上界落在
  // 「今天 0 点」，正好等于今天那行的 stat_date —— 用户说「只要昨天」却拿到昨天+今天，
  // 退出码 0、无 warning（审查 Important #1）。真实库实测复现过。
  it('--until 取区间形态（yesterday）不得多算一天：闭区间上界按 end−1ms 取整', async () => {
    await seed()
    // 补一行「今天」（上海 10/15）的数据；夹具原有的行在上海 10/14
    await seedMore('daily_overview', [
      { stat_date: '2026-10-14T16:00:00.000Z', payload: '{"a":9}', synchronized_at: null },
    ])
    expect(await qAt('--table', 'daily_overview', '--until', 'yesterday')).toBe(0)

    // 只要昨天（10/14）：今天（10/15）那行不得出现
    expect(rowsOf()).toHaveLength(1)
    expect(rowsOf()[0].stat_date).toBe('2026-10-13T16:00:00.000Z')
    expect(meta().resolved_range).toEqual([
      '2026-10-14T00:00:00+08:00', '2026-10-14T00:00:00+08:00'])
  })

  it('0 行 + 无时间过滤（表空）→ warning 说明表空（spec §十「空表」触发条件）', async () => {
    await seed()   // robot_summary 无数据
    expect(await qAt('--table', 'robot_summary')).toBe(0)

    expect(rowsOf()).toHaveLength(0)
    const warnings = meta().warnings as string[]
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/该表无数据/)
    expect(warnings[0]).toMatch(/sync run/)
  })

  it('空表 + 缺列漂移 → 两条警告并存，缺列不吞「表无数据」（CodeRabbit inline minor）', async () => {
    await seed()   // robot_summary 无数据
    const s: Store = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try { await s.query('ALTER TABLE "robot_summary" DROP COLUMN "payload"') } finally { await s.close() }

    expect(await qAt('--table', 'robot_summary')).toBe(0)
    const warnings = meta().warnings as string[]
    // 缺列说的是 schema、空表说的是数据，两件独立事实都要说。
    // 旧守卫 `warnings.length === 0` 让前者压掉后者：Agent 会把 0 行误读成缺列的副作用。
    expect(warnings.some((x) => /库中缺列 payload/.test(x))).toBe(true)
    expect(warnings.some((x) => /该表无数据/.test(x))).toBe(true)
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
    // 与 --sql 通道分开的截断警告：--table 通道的替代路径是时间/分组过滤
    const tw = (meta().warnings as string[]).find((x) => /不是全部/.test(x)) ?? ''
    expect(tw).toMatch(/--since\/--until\/--group-by/)
    expect(tw).not.toMatch(/在 SQL 里加 WHERE/)   // 这条通道没有 SQL 可改
  })

  it('截断警告不得建议该表装不下的过滤条件：无时间列的表不提 --since/--until', async () => {
    // PR 前契约审查 Important：25 张表里有 10 张没有 timeColumn，对它们建议 --since/--until
    // 等于给一条同一命令会以退出码 2 拒绝的路（实测 `--table tickets --since 1d` → usage）。
    // tickets 无 timeColumn，插 3 行造出截断。
    await seed()
    await seedMore('tickets', [
      { ticket_id: 't1', payload: '{}', crmUserName: null, crmUserPhone: null, crmUserEmail: null, userMobile: null, synchronized_at: null },
      { ticket_id: 't2', payload: '{}', crmUserName: null, crmUserPhone: null, crmUserEmail: null, userMobile: null, synchronized_at: null },
      { ticket_id: 't3', payload: '{}', crmUserName: null, crmUserPhone: null, crmUserEmail: null, userMobile: null, synchronized_at: null },
    ])
    expect(await qAt('--table', 'tickets', '--limit', '2')).toBe(0)
    expect(meta().truncated).toBe(true)

    const tw = (meta().warnings as string[]).find((x) => /不是全部/.test(x)) ?? ''
    expect(tw).toMatch(/--group-by/)            // 任何表都支持
    expect(tw).not.toMatch(/加过滤条件/)          // 不得把 --since/--until 当可行路径推荐
    expect(tw).toMatch(/不接受 --since\/--until/)  // 而是主动说明该表装不下它们
    // 反证：有 timeColumn 的表仍照旧给出时间过滤建议（两种文案确实分叉，不是一刀切删掉）
    expect(await qAt('--table', 'sessions', '--limit', '2')).toBe(0)
    const sw = (meta().warnings as string[]).find((x) => /不是全部/.test(x)) ?? ''
    expect(sw).toMatch(/--since\/--until\/--group-by/)
  })

  it('库漂移（声明列被删）→ hint 指向 db describe，不说「检查 SQL 语法」（PR 前契约审查 Minor）', async () => {
    await seed()
    // 模拟漂移：把 sessions 的时间列删掉——`--table` 的 SQL 由代码按 TABLES 生成，
    // 于是 binder 报「列 startTime 不存在」，但用户没写过 SQL，改 SQL 不是有效动作。
    const s: Store = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try { await s.query('ALTER TABLE "sessions" DROP COLUMN "startTime"') } finally { await s.close() }

    expect(await qAt('--table', 'sessions')).toBe(2)
    const e = errorOf()
    expect(e.kind).toBe('usage')
    expect(String(e.hint)).toContain('qiyu db describe sessions')
    expect(String(e.hint)).toMatch(/不是你的查询写错了/)
    expect(String(e.hint)).not.toMatch(/检查表名、列名与 SQL 语法/)
    // ⚠️ 只对 --table 通道生效：--sql 通道用户确实写了 SQL，原样分派（候选清单）
    expect(await q('--sql', 'SELECT "startTime" FROM sessions')).toBe(2)
    expect(String(errorOf().hint)).not.toMatch(/不是你的查询写错了/)
  })

  it('iso-day 窗口内部空洞 → warning 点名「应有 N 个自然日，实际 M 个」（场景 F4）', async () => {
    await seed()
    // 库里 daily_overview 有 10/13（seed）+ 10/11、10/12；NOW = 上海 10/15 12:00。
    await seedMore('daily_overview', [
      { stat_date: '2026-10-10T16:00:00.000Z', payload: '{"a":1}', synchronized_at: null },
      { stat_date: '2026-10-11T16:00:00.000Z', payload: '{"a":1}', synchronized_at: null },
    ])
    // 只给 --since 10/11 → 上界缺省 = now → 取整到 10/15 0 点；但**今天（10/15）要排除**
    // （日报任务的日对齐切片跳过当天残段窗，今天那行次日才有，CodeRabbit 终审 minor）。
    // 应覆盖 10/11..10/14 四天，实际有 10/11、10/12、10/13 三天 → 缺 10/14。
    expect(await qAt('--table', 'daily_overview', '--since', '2026-10-11')).toBe(0)
    const w = meta().warnings as string[]
    expect(w.some((x) => /应有 4 个自然日（不含今天：当天数据次日才同步），实际只有 3 个/.test(x))).toBe(true)

    // 反证 0：**当天缺口本身不算缺口**——补上缺的上海 10/13（UTC 10/12T16:00Z）后
    // （今天 10/15 仍没有行）不再警告
    await seedMore('daily_overview', [
      { stat_date: '2026-10-12T16:00:00.000Z', payload: '{"a":1}', synchronized_at: null },
    ])
    expect(await qAt('--table', 'daily_overview', '--since', '2026-10-11')).toBe(0)
    expect((meta().warnings as string[]).some((x) => /自然日/.test(x))).toBe(false)

    // 反证 1：显式 --until 覆盖今天时按用户说的算（今天没有行 = 真缺口）
    expect(await qAt('--table', 'daily_overview',
      '--since', '2026-10-11', '--until', '2026-10-16')).toBe(0)
    expect((meta().warnings as string[]).some((x) => /应有 6 个自然日，实际只有 4 个/.test(x))).toBe(true)

    // 反证 2：非 iso-day 表（sessions，epoch-ms）不算自然日、不触发
    expect(await qAt('--table', 'sessions', '--since', '2026-10-01')).toBe(0)
    expect((meta().warnings as string[]).some((x) => /自然日/.test(x))).toBe(false)
  })

  it('今天有行时不得掩盖昨天的真缺口（正确性审查 F6）', async () => {
    await seed()
    // NOW = 上海 10/15 12:00。铺 10/11..10/14 只缺 10/12，再加**今天 10/15** 一行。
    // `--since 10/11` 应覆盖 10/11..10/14（不含今天），实际 3 天 → 必须警告。
    // 旧实现的 coveredDays 含今天那行 = 4，恰好补满缺口 → 零警告（实测）。
    await seedMore('daily_overview', [
      { stat_date: '2026-10-10T16:00:00.000Z', payload: '{"a":1}', synchronized_at: null },   // 10/11
      { stat_date: '2026-10-12T16:00:00.000Z', payload: '{"a":1}', synchronized_at: null },   // 10/13
      { stat_date: '2026-10-13T16:00:00.000Z', payload: '{"a":1}', synchronized_at: null },   // 10/14
      { stat_date: '2026-10-14T16:00:00.000Z', payload: '{"a":1}', synchronized_at: null },   // 10/15（今天）
    ])
    // seed 自带 10/14 那行会与上面 10/14 冲突？—— overviewRow 主键是 stat_date，
    // seed 的是 2026-10-13T16:00:00.000Z，上面重复了同一值，upsert 幂等。
    expect(await qAt('--table', 'daily_overview', '--since', '2026-10-11')).toBe(0)
    const w = meta().warnings as string[]
    expect(w.some((x) => /应有 4 个自然日.*实际只有 3 个/.test(x))).toBe(true)
  })

  it('库漂移（声明有而实际无的列）→ 警告点名缺列，不静默少列（场景审查 9）', async () => {
    await seed()
    const s: Store = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.query('ALTER TABLE "sessions" ADD COLUMN "extra_col" VARCHAR')
      await s.query('ALTER TABLE "sessions" DROP COLUMN "userAddress"')
    } finally { await s.close() }

    expect(await qAt('--table', 'sessions')).toBe(0)
    const w = meta().warnings as string[]
    expect(w.some((x) => /库中缺列 userAddress/.test(x))).toBe(true)
    expect(w.some((x) => /db describe sessions/.test(x))).toBe(true)
    // 反向：多出来的列由脱敏层的 drift 警告覆盖（两条警告互不替代）
    expect((meta().mask_warnings as string[]).some((x) => /extra_col/.test(x))).toBe(true)
  })

  it('库漂移（声明表整个被删）→ store_not_initialized 退出码 1，不再伪装成拼写错误（场景 F1）', async () => {
    await seed()
    // 声明有、库里无：TABLES 认得 staff_quality，information_schema 没有。
    // 旧行为：走到 SQL 执行 → Catalog Error → 「表 staff_quality 不存在 + 候选：staff」
    // + 退出码 2 —— 把库损坏说成拼写错误，且把 Agent 推向另一张表。
    const s: Store = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try { await s.query('DROP TABLE "staff_quality"') } finally { await s.close() }

    expect(await qAt('--table', 'staff_quality')).toBe(1)
    const e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(String(e.message)).toContain('数据库中缺表：staff_quality')
    expect(String(e.message)).toMatch(/CLI 的表定义中存在/)
    expect(String(e.hint)).toMatch(/qiyu store init/)
    expect(String(e.hint)).toMatch(/qiyu db tables/)
    expect(String(e.hint)).not.toMatch(/候选：/)
    // 不再出现误导性的「不存在 + 候选」形态
    expect(String(e.message)).not.toMatch(/不存在.*候选/)

    // --sql 通道同一张表：用户自己写的 SQL，仍走 Catalog Error 翻译（不抢分派）
    expect(await q('--sql', 'SELECT COUNT(*) FROM staff_quality')).toBe(2)
    expect(errorOf().kind).toBe('usage')
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

  it('空串/脏值不进 data_coverage 与缺省下界（CodeRabbit 终审 minor）', async () => {
    await seed()
    const s: Store = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      // 空串在字典序上小于一切 ISO：`MIN` 会返回它 → 命令层判「该列无可用值」而丢掉
      // 缺省下界，尽管表里有合法行（这正是只有 --until 的路径）。
      await s.query("INSERT INTO \"daily_overview\" VALUES ('', '{}', NULL)")
      // 'not-a-date' 在字典序上大于 '2…'：`MAX` 会返回它 → data_coverage.max 输出非时间。
      await s.query("INSERT INTO \"daily_overview\" VALUES ('not-a-date', '{}', NULL)")
    } finally { await s.close() }

    expect(await qAt('--table', 'daily_overview', '--until', '2026-10-20')).toBe(0)
    // 缺省下界仍解析出合法值（空串被形态谓词排除）
    expect(meta().resolved_range).toEqual([
      '2026-10-14T00:00:00+08:00', '2026-10-20T00:00:00+08:00',
    ])
    // 覆盖范围只由合法行决定（'not-a-date' 被排除）
    expect(meta().data_coverage).toEqual({
      min: '2026-10-14T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00',
    })
    // 两条脏行不产生「无法解析缺省下界」的误判
    expect((meta().warnings as string[]).some((w) => /无可用值/.test(w))).toBe(false)
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
    // 闭集校验错误恒为 code:usage（spec §十一：--table 的用法错误不是 SQL 执行错误，
    // 与 --sql 通道的 query_error 分属两个出口；审查 I-2 改 spec 对齐实现）
    expect(errorOf().code).toBe('usage')
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
      expect(err, col).toContain('分组结果无法区分')
      expect(err, col).toContain('--sql')
    }

    expect(await qAt('--table', 'sessions',
      '--group-by', 'session_type', '--group-by', 'session_type')).toBe(2)
    expect(err).toMatch(/重复/)
  })

  it('iso-day 无毫秒形态（…T16:00:00Z）仍能被区间命中（正确性审查 F1）', async () => {
    await seed()
    // seed 已有 10/14 的 `….000Z`；再补同一自然日的无毫秒写法。字典序上
    // `…16:00:00Z` > `…16:00:00.000Z`，字符串 `<=` 比较会把无毫秒那行漏掉。
    await seedMore('daily_overview', [overviewRow('2026-10-13T16:00:00Z')])
    expect(await qAt('--table', 'daily_overview',
      '--since', '2026-10-14', '--until', '2026-10-14')).toBe(0)
    expect(rowsOf().map((r) => r.stat_date).sort())
      .toEqual(['2026-10-13T16:00:00.000Z', '2026-10-13T16:00:00Z'])
    expect(meta().warnings).toEqual([])   // 有数据 → 不得出现「0 行」警告
  })

  it('iso-instant 混合偏移（+08:00 与 Z）按时刻过滤、排序与取极值（正确性审查 F2）', async () => {
    await seed()
    // 09:00+08:00 = 01:00Z（更早）；05:00Z = 05:00Z（更晚）。字典序与时间序相反。
    await seedMore('staff_attendance', [
      attendanceRow('2026-09-20T09:00:00+08:00'),
      attendanceRow('2026-09-20T05:00:00Z'),
    ])
    // 区间 [00:00Z, 02:00Z] 只含 01:00Z 那行
    expect(await qAt('--table', 'staff_attendance',
      '--since', '2026-09-20T00:00:00Z', '--until', '2026-09-20T02:00:00Z')).toBe(0)
    expect(rowsOf().map((r) => r.hour_ts)).toEqual(['2026-09-20T09:00:00+08:00'])

    // 排序与覆盖统计同样按时刻：最新的（05:00Z）在前，min/max 不能取反
    expect(await qAt('--table', 'staff_attendance')).toBe(0)
    expect(rowsOf().map((r) => r.hour_ts))
      .toEqual(['2026-09-20T05:00:00Z', '2026-09-20T09:00:00+08:00'])
    const cov = meta().data_coverage as { min: string; max: string }
    expect(cov.min).toBe('2026-09-20T09:00:00+08:00')
    expect(cov.max).toBe('2026-09-20T13:00:00+08:00')   // 05:00Z = 13:00+08:00
  })

  it('取值位为空串时消息必须可见（edge F7）：空表名/空 group-by/空 --since/--limit', async () => {
    await seed()
    // 旧实现渲染成「未知表：」「未知列：」「无法解析：。」—— 冒号后空白，
    // Agent 无从知道该改哪个参数（describeArgs 的约定没覆盖取值位）。
    expect(await qAt('--table', '')).toBe(2)
    expect(err).toContain("未知表：''")

    expect(await qAt('--table', 'sessions', '--group-by', '')).toBe(2)
    expect(err).toMatch(/未知列：''/)

    expect(await qAt('--table', 'sessions', '--since', '')).toBe(2)
    expect(err).toMatch(/--since 无法解析：''/)

    expect(await qAt('--table', 'sessions', '--limit', '')).toBe(2)
    expect(err).toMatch(/收到：''/)
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
