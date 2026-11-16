// tests/commands/db.test.ts —— E-T6：`db tables` 命令面（spec §8.1）。
// 夹具沿 tests/commands/store.test.ts / sync.test.ts：mkdtemp + stubEnv('HOME') +
// 真 DuckDB 临时库 + spy stdout/stderr 双通道。
// ⚠️ fixtures 全合成：13800001111 是明显的测试号码，不使用任何真实企业数据。
import { describe, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { it, captureSinks } from '../helpers/capture.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbCommand } from '../../src/commands/db.js'
import { missingTableCauses } from '../../src/query/errors.js'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { shellArg } from '../../src/core/shell.js'
import { TABLES, MIGRATIONS } from '../../src/store/schema.js'
import type { Store } from '../../src/store/types.js'

// DuckDB 冷启动偶发 >5s（与 tests/commands/sync.test.ts 同款放宽）。
// `hookTimeout` 单独放宽：首个 `beforeAll` 要付 DuckDB 原生的**进程内冷启动**
// （本机负载高时实测 10–34s），vitest 默认 10s 会先把它判超时。
vi.setConfig({ testTimeout: 15_000, hookTimeout: 60_000 })

// ⚠️ **每条用例一个库文件，从"热模板"复制**（2026-11-15，历史审查 PR#72 收口）。
// 演进史：① `beforeEach` 里 `mkdtemp` 新目录各建库 → 每条都付「打开 + 25 表迁移」
// （本机负载 88 实测 ~500–800ms/条）；② 全文件单库 + 每条 `DROP 全部表 + 重新迁移`
// （~140ms/条），代价是**已知边界**：用例超时后它仍在跑的异步操作会与下一条的
// `resetDb()` 交错（vitest 不取消已超时用例的执行），破坏可能落到**下一条**头上；
// ③ 现在：`beforeAll` 建一次模板库（冷启动 + 迁移只付一次），`beforeEach` 把模板
// **复制**成本条的 `q-<n>.duckdb`（复制 ~ms 级，不跑迁移、不重开冷启动）。
// 于是"上一条的尾巴写坏了下一条的夹具"这条路**不存在**了：尾巴写的是它自己那个文件。
let dir = ''
let out = ''
let err = ''
/** 「夹具隔离」用例留下的延迟操作 —— `afterAll` 清理前把它抽干（见那里的注释）。 */
let pendingTail: Promise<void> | undefined
/** 模板库：`beforeAll` 建好（跑完全部迁移）后只读，`beforeEach` 从它复制。 */
const templatePath = (): string => join(dir, 'template.duckdb')
let testSeq = 0
/**
 * 用例 → 它自己那条库文件的路径。
 *
 * ⚠️ 必须绑在**用例的异步上下文**里，不能"每次调用读全局当前序号"（CodeRabbit + Codex
 * PR#81 major，Codex 真库探针复现）：上一条用例超时后 vitest **不会取消**它的执行，
 * 它恢复后若再调一次 `dbPath()`，读到的是**下一条**的序号 —— 于是它打开的 `q-2.duckdb`
 * 正是下一条的夹具，文件级隔离当场失效（探针：旧续执行删掉了下一条的 tickets）。
 * 绑进 ALS 后，恢复的旧用例读到的仍是**它自己**那条路径。
 * `currentDb` 只给 hook（不在用例上下文里）用。
 */
const alsDb = new AsyncLocalStorage<string>()
let currentDb = ''
const dbPath = (): string => alsDb.getStore() ?? currentDb

/**
 * 注册用例并把**本条路径**绑进它的异步上下文（见 `alsDb` 的注释）。
 * ⚠️ 用它替代裸 `it`：`it(name, body)` 的 body 在 `alsDb.run(currentDb, …)` 里执行，
 * 后续 `await` 链（含定时器回调）都带着同一条路径。
 */
const itBound: typeof it = ((name: unknown, ...rest: unknown[]) => {
  // ⚠️ 包**第一个函数实参**，不能假定"执行体在最后一位"（CodeRabbit PR#81）：
  // vitest 还有 `it(名, 执行体, 超时)` 重载，那时最后一位是数字，按 last 取会拿不到执行体、
  // 于是它**不套 ALS 绑定** —— 超时用例恢复后又读到下一条的库路径。
  const at = rest.findIndex((x) => typeof x === 'function')
  if (at >= 0) {
    const fn = rest[at] as (...a: unknown[]) => unknown
    rest[at] = (...a: unknown[]) => alsDb.run(currentDb, () => fn(...a))
  }
  return (it as unknown as (...x: unknown[]) => unknown)(name, ...rest)
}) as typeof it

/**
 * 把本条的库恢复成「刚 store init 完」：从模板复制覆盖。
 *
 * ⚠️ 保留这个函数名是因为它被 26 处调用（每条用例开头「重置夹具」的语义没变），
 * 但实现从「DROP 全部表 + 重新迁移」换成了**整文件复制** —— 幂等、便宜，
 * 且不会与任何仍在跑的旧操作共享同一个文件。
 */
async function resetDb(): Promise<void> {
  copyFileSync(templatePath(), dbPath())
}


beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-db-'))
  // 冷启动与迁移只付一次：建**模板库**（25 张表全建好），之后每条用例复制它。
  const s = await createDuckDbStore(
    { backend: 'duckdb', path: templatePath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  try { await s.init() } finally { await s.close() }
})
beforeEach(() => {
  testSeq += 1
  currentDb = join(dir, `q-${testSeq}.duckdb`)
  // 每条用例拿到**自己的库文件**：上一条用例超时后仍在跑的异步写，写的是它自己那个
  // 文件，碰不到本条的夹具（PR#72 的原始顾虑就此消失，不再是"已知边界"）。
  copyFileSync(templatePath(), currentDb)
  out = ''; err = ''
  captureSinks((s) => { out += s }, (s) => { err += s })
  vi.stubEnv('HOME', dir)   // 隔离真实 ~（配置文件与默认库路径都走 HOME）
  vi.stubEnv('USERPROFILE', dir)
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
})
afterAll(async () => {
  // ⚠️ 清理**不得让本文件失败**，但也不能静默（历史审查 PR#73）：Windows 上 DuckDB 的
  // `closeSync()` 未及时释放句柄时，`rmSync` 会 EBUSY/EPERM —— 那是临时目录残留，
  // 不是测试结论，所以降级成 stderr 提示。实测已确认 `beforeAll` 抛错时 `afterAll`
  // **仍会执行**（临时用例：beforeAll 抛错 → 打印 `afterAll 执行了`），所以"setup 失败
  // 就没人清理"的说法不成立；剩下的只是句柄时序。
  // ⚠️ 清理前先把「夹具隔离」留下的那条尾巴**抽干**（CodeRabbit PR#81）：用 `-t` 只跑
  // 前一条时，尾巴在 `afterAll` 删目录之后才开库 → 目录已不在，它的 rejection 也无人接，
  // 变成 unhandled rejection。抽干后顺序确定：尾巴先跑完，再删目录。
  await (pendingTail ?? Promise.resolve()).catch(() => { /* 尾巴失败是它自己的事，不掩盖清理 */ })
  try { rmSync(dir, { recursive: true, force: true }) } catch (e) {
    process.stderr.write(`[db.test] 临时目录清理失败（可安全忽略，路径：${dir}）：`
      + `${e instanceof Error ? e.message : String(e)}\n`)
  }
})

const data = (): Record<string, unknown> => JSON.parse(out).data
const meta = (): Record<string, unknown> => JSON.parse(out).meta
const errorOf = (): Record<string, unknown> => JSON.parse(out).error
type TableOut = {
  name: string; rows: number; grain: string
  time_range: { min: string; max: string } | null
  pii_columns: string[]
}

/** rw 建库（跑完全部迁移 → 25 张表），调用方负责 close。 */
async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  await s.init()
  return s
}

/** 会话行（payload 为合成 JSON，userPhone 是明显的测试号码）。 */
const sessionRow = (id: string, startTime: string | null): Record<string, unknown> => ({
  session_id: id, payload: JSON.stringify({ id }), staffId: '1000001',
  startTime, endTime: null, session_type: 'human', categoryDetail: null,
  userPhone: '13800001111', userName: '测试用户', userEmail: null, userAddress: null,
  fromIp: null, userIpCity: null, userCrmInfo: null,
  synchronized_at: '2026-10-15T00:00:00.000Z',
})

/** 合成数据：三种时间列 kind 各一张表 + 乱序插入（MIN/MAX 必须真的取极值）。 */
async function seed(): Promise<void> {
  const s = await fresh()
  try {
    // sessions：epoch-ms（startTime）
    await s.upsert('sessions', [sessionRow('s2', '1791907200000'), sessionRow('s1', '1786723200000')])
    // daily_overview：iso-day（stat_date）
    await s.upsert('daily_overview', [
      { stat_date: '2026-10-13T16:00:00.000Z', payload: '{"a":2}', synchronized_at: null },
      { stat_date: '2026-09-14T16:00:00.000Z', payload: '{"a":1}', synchronized_at: null },
    ])
    // staff_attendance：iso-instant（hour_ts）
    await s.upsert('staff_attendance', [
      { staff_id: '1000001', hour_ts: '2026-09-16T01:00:00.000Z',
        stat_date: '2026-09-15T16:00:00.000Z', payload: '{}', synchronized_at: null },
      { staff_id: '1000001', hour_ts: '2026-09-15T01:00:00.000Z',
        stat_date: '2026-09-14T16:00:00.000Z', payload: '{}', synchronized_at: null },
    ])
  } finally {
    await s.close()
  }
}

describe('db tables', () => {
  itBound('db tables 输出 25 表 + 行数 + 粒度 + PII 列 + notice', async () => {
    await resetDb()
    await seed()
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)

    const tables = data().tables as TableOut[]
    expect(tables).toHaveLength(25)
    expect(tables.map((t) => t.name)).toEqual(TABLES.map((t) => t.name))
    for (const t of tables) {
      // rows 必须是真实数字（BIGINT 经 JSON 层是字符串，命令层必须 Number() 收敛）
      expect(typeof t.rows, t.name).toBe('number')
      expect(t.grain, t.name).toBeTruthy()
      // 表条目恰好五个键（契约形态，多/少键都是 Agent 契约变更）
      expect(Object.keys(t).sort(), t.name)
        .toEqual(['grain', 'name', 'pii_columns', 'rows', 'time_range'])
      expect(Array.isArray(t.pii_columns), t.name).toBe(true)
    }

    const sessions = tables.find((t) => t.name === 'sessions')!
    expect(sessions.rows).toBe(2)
    expect(sessions.grain).toBe('每个会话一行（含机器人/人工/内部会话）')
    expect(sessions.pii_columns).toEqual(
      ['payload', 'userPhone', 'userName', 'userEmail', 'userAddress', 'fromIp', 'userIpCity', 'userCrmInfo'])

    // 无时间列、无 PII 列的表：time_range null、pii_columns []
    const sv = tables.find((t) => t.name === 'schema_version')!
    expect(sv.rows).toBe(MIGRATIONS.length)   // 每个迁移版本一行（不硬编码 9，下个迁移不会误红）
    expect(sv.grain).toBe('迁移版本记录（每版本一行）')
    expect(sv.time_range).toBeNull()
    expect(sv.pii_columns).toEqual([])

    const m = meta()
    expect(m.notice).toBe('本数据库包含客户 PII；不要将其写入日志或对外报表')
    expect(m.warnings).toEqual([])
  })

  itBound('time_range 按 timeColumn 计算；sessions 的 epoch-ms 转上海 ISO；无时间列 → null', async () => {
    await resetDb()
    await seed()
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)
    const byName = new Map((data().tables as TableOut[]).map((t) => [t.name, t]))

    // epoch-ms：数字字符串 → +08:00 ISO（R1）
    expect(byName.get('sessions')!.time_range).toEqual(
      { min: '2026-08-15T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00' })
    // iso-day：上海日零点的 ISO 字符串 → +08:00 ISO
    expect(byName.get('daily_overview')!.time_range).toEqual(
      { min: '2026-09-15T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00' })
    // iso-instant：ISO 字符串 → +08:00 ISO
    expect(byName.get('staff_attendance')!.time_range).toEqual(
      { min: '2026-09-15T09:00:00+08:00', max: '2026-09-16T09:00:00+08:00' })
    // 空表（有 timeColumn 但无行）→ null，不编造范围
    expect(byName.get('robot_summary')!.time_range).toBeNull()
    // 无 timeColumn → null
    expect(byName.get('schema_version')!.time_range).toBeNull()
    expect(byName.get('staff')!.time_range).toBeNull()
  })

  itBound('声明与实况不一致（删一张表 / 多一张表）→ meta.warnings 点名，rows 不编造', async () => {
    await resetDb()
    const s = await fresh()
    try {
      await s.query('DROP TABLE "sessions"')
      await s.query('CREATE TABLE "rogue_table" (a INTEGER)')
    } finally {
      await s.close()
    }
    // 行为式证据（复审 Minor #2）：迁移已到最新版后 store.init() 只重放
    // `version > MAX(version)` 的迁移 → 被删的 sessions **不会**被重建。
    // 这是「store init 不一定能修」的硬证据，不是文案自证。
    const s2 = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s2.init()
      const remaining = (await s2.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"))
        .rows.map((r) => String(r.table_name))
      expect(remaining).not.toContain('sessions')
      expect(remaining).toContain('rogue_table')
    } finally {
      await s2.close()
    }
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)

    const names = (data().tables as TableOut[]).map((t) => t.name)
    // R4：声明有而库中无 → 不进 data.tables（rows 恒为真实数字）；库中有而声明无 → 同样只进 warnings
    expect(names).toHaveLength(24)
    expect(names).not.toContain('sessions')
    expect(names).not.toContain('rogue_table')

    const warnings = meta().warnings as string[]
    const text = warnings.join('\n')
    expect(text).toMatch(/声明有而库中无/)
    expect(text).toMatch(/sessions/)
    expect(text).toMatch(/库中有而声明无/)
    expect(text).toMatch(/rogue_table/)
    // Important #1：不得承诺 store init 一定能修 —— 迁移已完成时被删的表 init 不会重建
    expect(text).toMatch(/不会重建/)
    // 旧的不实承诺不得被保留（复审 Minor #2：否定式断言）
    expect(text).not.toMatch(/可运行 qiyu store init 补齐建表/)
    expect(text).not.toMatch(/需重建库或重新同步/)   // 重新同步单独无法重建被删表
  })

  itBound('声明的表被换成同名 view → db tables 不执行它、照常成功并点名（与 store status 同口径）', async () => {
    // 2026-11-14（PR #74 合并后自查）：`information_schema` 把 view 也算作表，`db tables`
    // 对声明名做 `SELECT COUNT(*) FROM "<name>"` 时会把 view 本体当查询执行 —— view 的底表
    // 被删/不可读时整条命令报 `query_error` 退出 2，而 `store status` 早已改成「只数基表、
    // 同名 view 进 warnings」。同一份库里两条命令两种结论，正是 README 承诺「两边数量一致」的反面。
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.query('CREATE TABLE "aux_tbl" (id VARCHAR)')
      await s.query('DROP TABLE "tags"')
      await s.query('CREATE VIEW "tags" AS SELECT * FROM "aux_tbl"')
      // 底表删掉 → view 一执行就 Catalog Error（「有没有求值」的判据本身）
      await s.query('DROP TABLE "aux_tbl"')
    } finally {
      await s.close()
    }

    const code = await dbCommand(['tables', '--db', dbPath()])
    expect(code, `view 本体不得被执行；输出：${out.slice(0, 300)}`).toBe(0)
    const names = (data().tables as TableOut[]).map((t) => t.name)
    expect(names, '不是基表的同名对象不得进 tables（否则「数量一致」成了假话）').not.toContain('tags')
    const text = (meta().warnings as string[]).join('\n')
    expect(text, '必须点名这个对象是 view、未被计数').toMatch(/不是基表/)
    expect(text).toContain('tags')
  })

  itBound('同名 view 只差大小写（"TAGS"）也必须被认出、不得被执行（Codex PR#76）', async () => {
    // DuckDB 标识符大小写不敏感：`"TAGS"` 会被 `"tags"` 解析到，元数据里的名字保留 `TAGS`。
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.query('CREATE TABLE "aux_tbl" (id VARCHAR)')
      await s.query('DROP TABLE "tags"')
      await s.query('CREATE VIEW "TAGS" AS SELECT * FROM "aux_tbl"')
      await s.query('DROP TABLE "aux_tbl"')
    } finally {
      await s.close()
    }

    const code = await dbCommand(['tables', '--db', dbPath()])
    expect(code, `view 本体不得被执行；输出：${out.slice(0, 300)}`).toBe(0)
    expect((data().tables as TableOut[]).map((t) => t.name)).not.toContain('tags')
    expect((meta().warnings as string[]).join('\n')).toContain('TAGS')
  })

  itBound('非基表的列不得冒充基表的列集：与声明不同的 view 列只算它自己的（2026-11-15）', async () => {
    // 2026-11-15：`columnsOf` 按名字取全库列集，同名 view 的列会被当成「该表实际的列」——
    // 列名一致时让「缺列」warning 静默；不一致时则凭空造出「多列/少列」漂移，两边都是
    // 对一个**根本没被计数**的对象做列核对。列核对的来源只能是基表。
    // ⚠️ 变异边界（实测）：只把 `baseColumnsOf` 换回 `columnsOf.get(t.name)` 时本条**仍绿**
    // —— 上面的 `actualSet.has(actualName)` 已经先把非基表排除了。要红必须同时取消基表
    // 归位（`actualName`），也就是回到修前那种「按名字取列集」的整体形态。
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.query('DROP TABLE "tickets"')
      await s.query(`CREATE VIEW "tickets" AS SELECT 'x' AS rogue_col`)
    } finally {
      await s.close()
    }

    const code = await dbCommand(['tables', '--db', dbPath()])
    expect(code, `view 本体不得被执行；输出：${out.slice(0, 300)}`).toBe(0)
    expect((data().tables as TableOut[]).map((t) => t.name)).not.toContain('tickets')
    const text = (meta().warnings as string[]).join('\n')
    expect(text, '必须点名它不是基表').toMatch(/不是基表/)
    expect(text, 'view 的列不得被当成 tickets 的列去造漂移').not.toMatch(/表 tickets 实际/)
  })

  itBound('声明的时间列被删 → db tables 仍成功，该表 time_range 为 null + warning（不硬失败）', async () => {
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.query('ALTER TABLE "sessions" DROP COLUMN "startTime"')
    } finally {
      await s.close()
    }
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)

    const sessions = (data().tables as TableOut[]).find((t) => t.name === 'sessions')!
    expect(sessions.time_range).toBeNull()
    expect(sessions.rows).toBe(2)                 // 行数照常（不受缺时间列影响）
    // 反证：缺列降级必须只影响那一个表 —— 「把所有有 timeColumn 的表都置 null」也能让上一行绿
    const overview = (data().tables as TableOut[]).find((t) => t.name === 'daily_overview')!
    expect(overview.time_range).toEqual(
      { min: '2026-09-15T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00' })

    const text = (meta().warnings as string[]).join('\n')
    expect(text).toMatch(/缺少时间列/)
    expect(text).toMatch(/startTime/)
  })

  itBound('时间列的脏值不进 time_range，且逐表给 warning（正确性 P1）', async () => {
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      // 字典序上 `n` > `2`，脏值会赢下 MAX —— 旧实现把 time_range.max 变成 'not-a-date'。
      await s.query("INSERT INTO \"daily_overview\" VALUES ('not-a-date', '{}', NULL)")
    } finally {
      await s.close()
    }
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)

    const overview = (data().tables as TableOut[]).find((t) => t.name === 'daily_overview')!
    expect(overview.rows).toBe(3)                  // 脏行照样计数（它是真实存在的行）
    expect(overview.time_range).toEqual(           // 极值仍是合法 ISO
      { min: '2026-09-15T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00' })

    const text = (meta().warnings as string[]).join('\n')
    expect(text).toMatch(/时间列 stat_date 有 1 个值不符合约定形态/)
    expect(text).not.toMatch(/not-a-date/)

    // 反证：干净库（无脏值）不得出现该警告 —— 否则这条警告会被 Agent 学会忽略
    const clean = mkdtempSync(join(tmpdir(), 'qiyu-db-clean-'))
    try {
      const dir2 = { path: join(clean, 'q.db') }
      const s2 = await createDuckDbStore(
        { backend: 'duckdb', path: dir2.path, readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
      try {
        await s2.init()
        await s2.upsert('daily_overview', [
          { stat_date: '2026-10-13T16:00:00.000Z', payload: '{"a":1}', synchronized_at: null }])
      } finally { await s2.close() }
      out = ''; err = ''
      expect(await dbCommand(['tables', '--db', dir2.path])).toBe(0)
      expect((meta().warnings as string[]).join('\n')).not.toMatch(/不符合约定形态/)
    } finally { rmSync(clean, { recursive: true, force: true }) }
  })

  itBound('形态判据两端锚定：尾部垃圾与纯日期也算脏值，不进 time_range（CodeRabbit 终审 minor）', async () => {
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      // '2026-10-12garbage' 在字典序上 `g` > `T`，只锚开头的旧判据会放它进 MAX；
      // 纯日期 '2026-10-13' 会被 msToShanghaiIso 按 UTC 解析、输出偏 8 小时。
      await s.query("INSERT INTO \"daily_overview\" VALUES ('2026-10-12garbage', '{}', NULL)")
      await s.query("INSERT INTO \"daily_overview\" VALUES ('2026-10-13', '{}', NULL)")
    } finally {
      await s.close()
    }
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)

    const overview = (data().tables as TableOut[]).find((t) => t.name === 'daily_overview')!
    expect(overview.time_range).toEqual(
      { min: '2026-09-15T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00' })
    expect((meta().warnings as string[]).join('\n'))
      .toMatch(/时间列 stat_date 有 2 个值不符合约定形态/)
  })

  itBound('epoch-ms 列的非数字值是脏值，必须计数并警告（CodeRabbit 复审：SQL 三值逻辑回归）', async () => {
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      // ⚠️ 非数字值让 TRY_CAST 为 NULL，`NOT (NULL AND NULL)` 仍是 NULL，
      // WHERE 会把该行静默丢掉 → 脏值计数为 0、警告不出现、time_range 却仍正常。
      // 必须 COALESCE(…, false)。同时验证 -1 哨兵（数值但不在合理区间）也算脏。
      await s.query("INSERT INTO \"sessions\" (\"session_id\", \"startTime\") VALUES ('bad', 'not-a-number')")
      await s.query("INSERT INTO \"sessions\" (\"session_id\", \"startTime\") VALUES ('sentinel', '-1')")
    } finally {
      await s.close()
    }
    expect(await dbCommand(['describe', 'sessions', '--db', dbPath()])).toBe(0)
    expect((meta().warnings as string[]).join('\n'))
      .toMatch(/时间列 startTime 有 2 个值不符合约定形态/)
  })

  itBound('db describe 的时间范围同样排除脏值并逐列警告（正确性 P1）', async () => {
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.query("INSERT INTO \"staff_attendance\" VALUES ('1000002', 'not-a-date', '2026-09-15T16:00:00.000Z', '{}', NULL)")
    } finally {
      await s.close()
    }
    expect(await dbCommand(['describe', 'staff_attendance', '--db', dbPath()])).toBe(0)

    const d = data()
    expect(d.row_count).toBe(3)
    expect(d.time_range).toEqual(
      { min: '2026-09-15T09:00:00+08:00', max: '2026-09-16T09:00:00+08:00' })
    expect((meta().warnings as string[]).join('\n')).toMatch(/时间列 hour_ts 有 1 个值不符合约定形态/)
  })

  itBound('db tables 也核对列集：多列/少列进 warnings（审查 I-3，README 承诺不静默）', async () => {
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.query('ALTER TABLE "sessions" ADD COLUMN "rogue_col" VARCHAR')
      await s.query('ALTER TABLE "staff" DROP COLUMN "email"')
    } finally {
      await s.close()
    }
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)

    const text = (meta().warnings as string[]).join('\n')
    // 多列与少列各自点名，措辞与 db describe 同源（同一个事实，两处说法一致）
    expect(text).toMatch(/表 sessions 实际多列 rogue_col/)
    expect(text).toMatch(/表 staff 实际少列 email/)
    // 反证：健康表不得被误报（否则「全部表都警告一遍」也能让上面两行绿）
    expect(text).not.toMatch(/表 daily_overview 实际/)
    // 列清单仍以声明为权威：多出来的列不进 pii_columns、也不进任何 data 字段
    const sessions = (data().tables as TableOut[]).find((t) => t.name === 'sessions')!
    expect(sessions.pii_columns).not.toContain('rogue_col')
  })

  itBound('未知参数 / --pretty / 值位缺失 → usage 退出码 2；--help → 0', async () => {
    expect(await dbCommand(['tables', '--db', dbPath(), '--bogus'])).toBe(2)
    expect(errorOf().kind).toBe('usage')
    expect(err.length).toBeGreaterThan(0)          // usageFail 双通道：stderr 文本
    expect(() => JSON.parse(out)).not.toThrow()    // stdout JSON

    // G1 起 --pretty 是合法输出开关：成功 + 缩进（原「显式拒绝」断言翻转）。
    // 本用例此前到不了库（--bogus/--pretty 都在开库前被拦），现在要真的建库。
    await fresh().then((s) => s.close())
    out = ''; err = ''
    expect(await dbCommand(['tables', '--db', dbPath(), '--pretty'])).toBe(0)
    expect(err).toBe('')
    expect(out.startsWith('{\n  "ok": true,'), 'db tables --pretty 必须缩进').toBe(true)

    out = ''; err = ''
    expect(await dbCommand(['tables', '--db'])).toBe(2)   // 值位守卫
    expect(err).toMatch(/--db 缺少取值/)

    // --help 不吞额外参数：未知参数优先于 help
    out = ''; err = ''
    expect(await dbCommand(['tables', '--help', '--bogus'])).toBe(2)
    expect(err).toMatch(/未知参数/)

    out = ''; err = ''
    expect(await dbCommand(['bogus'])).toBe(2)
    expect(err).toMatch(/未知子命令/)

    // 无子命令 = 用法错误（退 2 + JSON）；--help / tables --help / describe --help
    // 才是裸文本帮助、退出码 0（2026-11-07 审查：此前无子命令也走裸文本退 0，
    // 与顶层/api/auth/query/skill 相反）
    out = ''; err = ''
    expect(await dbCommand([])).toBe(2)
    expect(JSON.parse(out).error).toMatchObject({ code: 'usage' })
    for (const argv of [['--help'], ['tables', '--help'], ['describe', '--help']]) {
      out = ''; err = ''
      expect(await dbCommand(argv), argv.join(' ')).toBe(0)
      expect(out).toMatch(/db tables/)
      expect(err).toBe('')
    }
  })

  itBound('库不存在 → store_not_initialized + hint 指 store init', async () => {
    expect(await dbCommand(['tables', '--db', join(dir, 'missing.db')])).toBe(1)
    let e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/store init/)

    // 空库（合法 DuckDB、零表）→ 同样指 store init
    const mod = (await import('@duckdb/node-api')) as unknown as {
      DuckDBInstance: {
        create: (p: string, o?: unknown) => Promise<{
          connect: () => Promise<{ run: (sql: string) => Promise<unknown>; closeSync: () => void }>
          closeSync: () => void
        }>
      }
    }
    const empty = join(dir, 'empty.db')
    ;(await mod.DuckDBInstance.create(empty)).closeSync()
    out = ''
    expect(await dbCommand(['tables', '--db', empty])).toBe(1)
    e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/store init/)

    // 他人库（有表、无 schema_version）→ hint 指换 --db 路径
    const alien = join(dir, 'alien-tables.db')
    const inst = await mod.DuckDBInstance.create(alien)
    const conn = await inst.connect()
    await conn.run('CREATE TABLE alien (a INTEGER)')
    conn.closeSync()   // ⚠️ connection 与 instance 都要关，否则锁随进程存活
    inst.closeSync()
    out = ''
    expect(await dbCommand(['tables', '--db', alien])).toBe(1)
    e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/换 --db 路径/)
  })
})

// —— E-T7：`db describe <表>`（spec §8.2）——
type ColumnOut = {
  name: string; type: string; nullable: boolean; sensitive: boolean
  unit: string | null; observed_enum: Array<string | number> | null; note: string | null
}
type DescribeOut = {
  table: string; grain: string; primary_key: string[]
  time_column: { name: string; kind: string } | null
  row_count: number | null
  time_range: { min: string; max: string } | null
  columns: ColumnOut[]
  pii_columns: string[]
}

const SESSIONS_PII = ['payload', 'userPhone', 'userName', 'userEmail',
  'userAddress', 'fromIp', 'userIpCity', 'userCrmInfo']
const sessionsDef = (): (typeof TABLES)[number] => TABLES.find((t) => t.name === 'sessions')!

describe('db describe', () => {
  itBound('同名 view（底表已删）→ 不执行它、退出 0、只出声明元数据并点名（与 db tables 同口径）', async () => {
    // 2026-11-15：此前 describe 只看表名在不在，`COUNT(*)` 执行 view → Catalog Error →
    // 退出 2，报文还把 view 定义里的底表名说成「表不存在」。
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.query('CREATE TABLE "aux_tbl" (id VARCHAR)')
      await s.query('DROP TABLE "daily_overview"')
      await s.query('CREATE VIEW "daily_overview" AS SELECT * FROM "aux_tbl"')
      await s.query('DROP TABLE "aux_tbl"')
    } finally {
      await s.close()
    }

    out = ''
    const code = await dbCommand(['describe', 'daily_overview', '--db', dbPath()])
    expect(code, `view 本体不得被执行；输出：${out.slice(0, 300)}`).toBe(0)
    const d = data() as DescribeOut
    expect(d.row_count).toBeNull()
    expect(d.time_range).toBeNull()
    const text = (meta().warnings as string[]).join('\n')
    expect(text, '必须点名它不是基表').toMatch(/不是基表/)
    expect(text, '不得再说成「在库中不存在」').not.toMatch(/在库中不存在/)
    expect(JSON.parse(out).error, '不得回显 view 定义里的底表名').toBeUndefined()
  })

  itBound('db describe sessions：7 键逐列 + sensitive/observed_enum/时间列/row_count/PII 列', async () => {
    await resetDb()
    await seed()
    expect(await dbCommand(['describe', 'sessions', '--db', dbPath()])).toBe(0)

    const d = data() as DescribeOut
    // data 恰好八个键（多/少键都是 Agent 契约变更）
    expect(Object.keys(d).sort()).toEqual(
      ['columns', 'grain', 'pii_columns', 'primary_key', 'row_count', 'table', 'time_column', 'time_range'])
    expect(d.table).toBe('sessions')
    expect(d.grain).toBe('每个会话一行（含机器人/人工/内部会话）')
    expect(d.primary_key).toEqual(['session_id'])
    expect(d.time_column).toEqual({ name: 'startTime', kind: 'epoch-ms' })
    // row_count 是 BIGINT → 命令层必须 Number() 收敛成数字
    expect(typeof d.row_count).toBe('number')
    expect(d.row_count).toBe(2)
    expect(d.time_range).toEqual({ min: '2026-08-15T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00' })

    // 列清单与顺序以 TABLES 为权威
    expect(d.columns.map((c) => c.name)).toEqual(sessionsDef().columns.map((c) => c.name))
    for (const c of d.columns) {
      // 每列恰好七个键；缺省字段显式 null（sensitive 缺省 false）
      expect(Object.keys(c).sort(), c.name)
        .toEqual(['name', 'note', 'nullable', 'observed_enum', 'sensitive', 'type', 'unit'])
      expect(typeof c.nullable, c.name).toBe('boolean')
      expect(typeof c.sensitive, c.name).toBe('boolean')
    }
    const byName = new Map(d.columns.map((c) => [c.name, c]))
    // 观测枚举只出现在有实测出处的列（spec §8.2：命名刻意不叫 enum）
    expect(byName.get('session_type')).toMatchObject({
      type: 'VARCHAR', nullable: true, sensitive: false, unit: null,
      observed_enum: ['robot', 'internal', 'human'],
    })
    expect(byName.get('session_type')!.note).toBeTruthy()
    // 无附加元数据的 PII 列：unit/observed_enum/note 显式 null，不是缺键
    expect(byName.get('userPhone')).toEqual({
      name: 'userPhone', type: 'VARCHAR', nullable: true, sensitive: true,
      unit: null, observed_enum: null, note: null,
    })
    // 时间列的 unit 与 timeColumn 呼应
    expect(byName.get('startTime')!.unit).toBe('epoch 毫秒数字字符串')

    expect(d.pii_columns).toEqual(SESSIONS_PII)
    expect(meta().notice).toBe('本数据库包含客户 PII；不要将其写入日志或对外报表')
    expect(meta().warnings).toEqual([])
  })

  itBound('无时间列 → time_column/time_range 均 null；meta 恒有 notice / warnings / field_notes', async () => {
    await resetDb()
    await seed()
    expect(await dbCommand(['describe', 'schema_version', '--db', dbPath()])).toBe(0)

    const d = data() as DescribeOut
    expect(d.time_column).toBeNull()
    expect(d.time_range).toBeNull()          // 无 timeColumn → 不编造范围
    expect(d.row_count).toBe(MIGRATIONS.length)
    expect(d.pii_columns).toEqual([])

    const m = meta()
    // 2026-10-28 起多一个 field_notes（逐键释义，见 db-notes.ts）
    expect(Object.keys(m).sort()).toEqual(['field_notes', 'notice', 'warnings'])
    expect(m.notice).toBe('本数据库包含客户 PII；不要将其写入日志或对外报表')
    expect(m.warnings).toEqual([])
  })

  itBound('未知表 → usage 2 + 候选（sessons → sessions）；缺表名 / 多余位置参数 → usage 2', async () => {
    await resetDb()
    await seed()
    // 拼错一个字符 → 候选来自 TABLES（不裸透 DuckDB 英文）。
    // ⚠️ 不给 --db：闭集校验先于任何 I/O（走到开库会得到 store_not_initialized 退出码 1）
    expect(await dbCommand(['describe', 'sessons'])).toBe(2)
    let e = errorOf()
    expect(e.kind).toBe('usage')
    expect(e.message).toMatch(/sessons/)
    expect(e.hint).toMatch(/sessions/)
    expect(err).toMatch(/sessons/)             // usageFail 双通道：stderr 有 message（hint 只在 JSON）

    // 完全不相干 → 不硬凑候选，指向表清单
    out = ''; err = ''
    expect(await dbCommand(['describe', 'zzzzzz', '--db', dbPath()])).toBe(2)
    e = errorOf()
    expect(e.hint).toMatch(/qiyu db tables/)

    // 缺表名
    out = ''; err = ''
    expect(await dbCommand(['describe', '--db', dbPath()])).toBe(2)
    expect(err).toMatch(/缺少表名/)

    // 多余位置参数
    out = ''; err = ''
    expect(await dbCommand(['describe', 'sessions', 'extra', '--db', dbPath()])).toBe(2)
    expect(err).toMatch(/未知参数/)

    // ⚠️ 空串参数必须**可见**（2026-11-01 审查）：`db`/`stats` 的「未知参数」此前走裸
    // `join(' ')`，空串渲染成隐形，Agent 拿到一句「未知参数：」冒号后什么都没有 ——
    // 而 `query`/`api` 早走 `describeArgs`（`未知参数：''`）。同一错误两个命令族两种说法。
    out = ''; err = ''
    expect(await dbCommand(['describe', 'sessions', '', '--db', dbPath()])).toBe(2)
    expect(err, '空串必须渲染成 \'\'，不能隐形').toMatch(/未知参数：''/)
    out = ''; err = ''
    expect(await dbCommand(['tables', 'foo', '', '--db', dbPath()])).toBe(2)
    expect(err, '多个未知参数里空串同样要可见').toMatch(/未知参数：foo、''/)

    // 未知 flag 不得被当成表名；--pretty 沿全族显式拒绝
    out = ''; err = ''
    expect(await dbCommand(['describe', 'sessions', '--bogus', '--db', dbPath()])).toBe(2)
    expect(err).toMatch(/未知参数：--bogus/)
    out = ''; err = ''
    // G1 起 describe --pretty 同样合法成功且缩进
    expect(await dbCommand(['describe', 'sessions', '--pretty', '--db', dbPath()])).toBe(0)
    expect(out.startsWith('{\n  "ok": true,'), 'db describe --pretty 必须缩进').toBe(true)
  })

  itBound('实际列集与 TABLES 不一致 → meta.warnings 点名多列/少列；列清单仍以声明为权威', async () => {
    await resetDb()
    const s = await fresh()
    try {
      await s.query('ALTER TABLE "sessions" DROP COLUMN "userCrmInfo"')
      await s.query('ALTER TABLE "sessions" ADD COLUMN "rogue_col" VARCHAR')
    } finally {
      await s.close()
    }
    expect(await dbCommand(['describe', 'sessions', '--db', dbPath()])).toBe(0)

    const text = (meta().warnings as string[]).join('\n')
    expect(text).toMatch(/少列/)
    expect(text).toMatch(/userCrmInfo/)
    expect(text).toMatch(/多列/)
    expect(text).toMatch(/rogue_col/)
    expect(text).toMatch(/旧版 CLI 或库损坏/)
    // 列清单来自 TABLES：库中少了列也不缩减输出
    expect((data() as DescribeOut).columns.map((c) => c.name)).toContain('userCrmInfo')
  })

  itBound('R5：声明有但库中无 → 仍输出声明元数据（row_count/time_range null）+ warning，退出码 0', async () => {
    await resetDb()
    const s = await fresh()
    try {
      await s.query('DROP TABLE "sessions"')
    } finally {
      await s.close()
    }
    expect(await dbCommand(['describe', 'sessions', '--db', dbPath()])).toBe(0)

    const d = data() as DescribeOut
    expect(d.row_count).toBeNull()
    expect(d.time_range).toBeNull()
    // 声明元数据照常：Agent 需要知道该表「应该」有什么列，才能核对列漂移
    expect(d.columns).toHaveLength(sessionsDef().columns.length)
    expect(d.pii_columns).toEqual(SESSIONS_PII)
    expect(d.time_column).toEqual({ name: 'startTime', kind: 'epoch-ms' })

    const warnings = meta().warnings as string[]
    // 表都不在，列集核对无从谈起 —— 只留一条「表不存在」警告，不制造「少列」噪音
    expect(warnings).toHaveLength(1)
    const text = warnings.join('\n')
    expect(text).toMatch(/sessions/)
    expect(text).toMatch(/在库中不存在/)
    expect(text).toMatch(/声明元数据/)
    // ⚠️ 2026-10-29 实测修正：旧文案「未同步或未建库」两个成因都到不了该分支
    // （store init 建全部声明表 → 未同步的库 25 张全在；缺库/空库在 openGuardedSession
    // 里已是 store_not_initialized）。与 db tables/query/stats 共用 MISSING_TABLE_CAUSES。
    expect(text).not.toMatch(/未同步/)
    expect(text).toContain(missingTableCauses(dbPath()))
    // 关键对策必须在场：被删的表 store init 不会重建，Agent 不能靠「再同步一次」修
    expect(text).toContain('store init 不会重建该表')
    expect(text).toContain('需重建库')
    // 恢复命令必须指向本次的库（否则照 hint 跑会建默认库，见 output.ts）
    expect(text).toContain('--db ' + shellArg(dbPath()))
    expect(meta().notice).toBe('本数据库包含客户 PII；不要将其写入日志或对外报表')
  })

  itBound('声明的时间列被删 → 退出码 0、time_range null、row_count 照常、warnings 点名该列', async () => {
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.query('ALTER TABLE "sessions" DROP COLUMN "startTime"')
    } finally {
      await s.close()
    }
    // 时间列是「列集不一致」的子集：不得让 MIN("startTime") 的 Binder Error 把整命令打成 2
    expect(await dbCommand(['describe', 'sessions', '--db', dbPath()])).toBe(0)

    const d = data() as DescribeOut
    expect(d.time_range).toBeNull()
    expect(typeof d.row_count).toBe('number')
    expect(d.row_count).toBe(2)
    // 声明元数据照常（含被删的时间列本身）
    expect(d.time_column).toEqual({ name: 'startTime', kind: 'epoch-ms' })
    expect(d.columns.map((c) => c.name)).toContain('startTime')
    // 反证：其余列没被连坐清空（否则「降级」实际是「整表列集丢失」也会让上面几行绿）
    const names = d.columns.map((c) => c.name)
    expect(names).toContain('session_id')
    expect(names).toContain('userPhone')

    const text = (meta().warnings as string[]).join('\n')
    expect(text).toMatch(/少列/)
    expect(text).toMatch(/startTime/)
  })

  itBound('time_range 覆盖 iso-day 与 iso-instant 两种 kind', async () => {
    await resetDb()
    await seed()
    // iso-day（daily_overview.stat_date）
    expect(await dbCommand(['describe', 'daily_overview', '--db', dbPath()])).toBe(0)
    let d = data() as DescribeOut
    expect(d.time_column).toEqual({ name: 'stat_date', kind: 'iso-day' })
    expect(d.time_range).toEqual(
      { min: '2026-09-15T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00' })

    // iso-instant（staff_attendance.hour_ts）
    out = ''
    expect(await dbCommand(['describe', 'staff_attendance', '--db', dbPath()])).toBe(0)
    d = data() as DescribeOut
    expect(d.time_column).toEqual({ name: 'hour_ts', kind: 'iso-instant' })
    expect(d.time_range).toEqual(
      { min: '2026-09-15T09:00:00+08:00', max: '2026-09-16T09:00:00+08:00' })
  })

  itBound('iso-instant 按解析时刻取极值，不按字典序（CodeRabbit 终审 minor）', async () => {
    await resetDb()
    await seed()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      // 混排偏移形态：'09:00:00+08:00' 是 01:00Z（更早），'05:00:00Z' 是 05:00Z（更晚）。
      // 字典序上 '…T09…' > '…T05…'，所以按原始字符串取 MAX 会报出更早的那一刻。
      await s.upsert('staff_attendance', [
        { staff_id: '1000002', hour_ts: '2026-09-20T09:00:00+08:00',
          stat_date: '2026-09-19T16:00:00.000Z', payload: '{}', synchronized_at: null },
        { staff_id: '1000003', hour_ts: '2026-09-20T05:00:00Z',
          stat_date: '2026-09-19T16:00:00.000Z', payload: '{}', synchronized_at: null },
      ])
    } finally {
      await s.close()
    }
    expect(await dbCommand(['describe', 'staff_attendance', '--db', dbPath()])).toBe(0)
    const d = data() as DescribeOut
    const range = d.time_range!
    // max 取 05:00Z（= 13:00+08:00，更晚的那个时刻），而不是字典序更大的
    // 09:00:00+08:00（= 01:00Z，更早）—— 旧实现按原始字符串取 MAX 会报错这一端。
    expect(range.max).toBe('2026-09-20T13:00:00+08:00')
    // min 仍是 seed 里最早那行（09-15 09:00+08:00），说明新形态没有误改下限
    expect(range.min).toBe('2026-09-15T09:00:00+08:00')
    // 两种形态都合法，不算脏值
    expect((meta().warnings as string[]).join('\n')).not.toMatch(/不符合约定形态/)
  })

  itBound('库不存在 / 空库 / 他人库 → store_not_initialized，hint 指 store init 或换 --db', async () => {
    expect(await dbCommand(['describe', 'sessions', '--db', join(dir, 'missing.db')])).toBe(1)
    let e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/store init/)

    const mod = (await import('@duckdb/node-api')) as unknown as {
      DuckDBInstance: {
        create: (p: string, o?: unknown) => Promise<{
          connect: () => Promise<{ run: (sql: string) => Promise<unknown>; closeSync: () => void }>
          closeSync: () => void
        }>
      }
    }
    // 空库（合法 DuckDB、零表）
    const empty = join(dir, 'empty.db')
    ;(await mod.DuckDBInstance.create(empty)).closeSync()
    out = ''
    expect(await dbCommand(['describe', 'sessions', '--db', empty])).toBe(1)
    e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/store init/)

    // 他人库（有表、无 schema_version）
    const alien = join(dir, 'alien-describe.db')
    const inst = await mod.DuckDBInstance.create(alien)
    const conn = await inst.connect()
    await conn.run('CREATE TABLE alien (a INTEGER)')
    conn.closeSync()   // ⚠️ connection 与 instance 都要关，否则锁随进程存活
    inst.closeSync()
    out = ''
    expect(await dbCommand(['describe', 'sessions', '--db', alien])).toBe(1)
    e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/换 --db 路径/)
  })

  itBound('--help 不接受额外参数（describe --help --bogus → usage 2）', async () => {
    expect(await dbCommand(['describe', '--help', '--bogus'])).toBe(2)
    expect(err).toMatch(/未知参数/)
    expect(errorOf().kind).toBe('usage')
  })
})

describe('夹具隔离（历史审查 PR#72 收口）', () => {
  let prevDbPath = ''
  /** 上一条用例那条"尾巴"的完成信号 —— 必须**等它真的落定**，不能靠猜时长。 */
  let tailDone: Promise<void> = Promise.resolve()
  /** 上一条用例的延迟回调里**再次**调 `dbPath()` 得到的值（验证路径绑在异步上下文里）。 */
  let pathSeenByTail = ''

  itBound('【前一条】把本条库改坏，并留一条 80ms 后才执行的"尾巴"', async () => {
    prevDbPath = dbPath()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try { await s.query('DROP TABLE "sessions"') } finally { await s.close() }
    // 模拟"用例超时后仍在跑的异步操作"：它落到的是**本条自己的**库文件。
    // ⚠️ 不能只 `void` 掉（CodeRabbit PR#81 major）：本机慢一点时 150ms 不够等它开库 +
    // DROP 完成，断言会跑在删除之前 → 偶发假绿；而它的 rejection 也没人接。
    // 现在留下 completion promise，由下一条 `await`。
    pendingTail = tailDone = new Promise<void>((resolve, reject) => {
      setTimeout(() => {
        // ⚠️ 这里再调一次 `dbPath()`：它模拟"超时用例恢复后重新取路径"。绑在异步上下文里
        // 时它仍返回**本条**路径；若改成读全局序号，这里会拿到下一条的路径（变异可红）。
        pathSeenByTail = dbPath()
        void (async () => {
          try {
            const t = await createDuckDbStore(
              { backend: 'duckdb', path: prevDbPath, readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
            try { await t.query('DROP TABLE "tickets"') } finally { await t.close() }
            resolve()
          } catch (e) { reject(e) }
        })()
      }, 80)
    })
  })

  itBound('【本条】库仍是完整的 25 张表 —— 上一条的破坏与尾巴都碰不到它', async () => {
    // ⚠️ 前置状态缺了就**显式失败**（Codex PR#81 第四轮 P2）：这条用例靠上一条设
    // `prevDbPath` / `tailDone` / `pathSeenByTail`。用 `-t` 只筛这一条时它们都是初始值，
    // 断言会全部空转却显示 passed（实测 `1 passed, 26 skipped` 什么都没验证）。
    expect(prevDbPath, '此用例必须与【前一条】一起跑（`-t 夹具隔离` 或整文件）；'
      + '单独筛它时前置状态不存在，会假绿').not.toBe('')
    // 等上一条那条尾巴**真的完成**（它在别处写，写坏了也不影响这里）
    const early = await dbCommand(['tables', '--db', dbPath()])
    expect(early, '尾巴落地前本条就该是好的').toBe(0)
    out = ''      // captureSinks 是**追加**语义：同一条用例里跑第二条命令前必须清缓冲
    await tailDone
    // ⚠️ 判定顺序：先看**数据**再看路径 —— 若只断言"路径不同"，把夹具改回单库时
    // 第一条就红，看不出"尾巴真的写坏了本条"这个更有说服力的形态（变异验证过）。
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)
    expect((data().tables as TableOut[]).map((t) => t.name), '上一条删掉的表不得消失').toHaveLength(25)
    expect(dbPath(), '每条用例必须拿到自己的库文件').not.toBe(prevDbPath)
    expect(pathSeenByTail, '上一条的延迟续执行必须仍读到它自己那条路径（不得读到本条的）')
      .toBe(prevDbPath)
    // 反过来确认"上一条真的把破坏留下了"—— 否则本条通过也可能只是因为它没动手
    const broken = await createDuckDbStore(
      { backend: 'duckdb', path: prevDbPath, readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      const names = (await broken.query(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='main'"))
        .rows.map((r) => String(r.table_name))
      expect(names, '上一条的库里确实少了 sessions/tickets（证明破坏真的发生了）')
        .not.toContain('sessions')
      expect(names).not.toContain('tickets')
    } finally { await broken.close() }
  })
})
