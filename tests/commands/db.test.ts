// tests/commands/db.test.ts —— E-T6：`db tables` 命令面（spec §8.1）。
// 夹具沿 tests/commands/store.test.ts / sync.test.ts：mkdtemp + stubEnv('HOME') +
// 真 DuckDB 临时库 + spy stdout/stderr 双通道。
// ⚠️ fixtures 全合成：13800001111 是明显的测试号码，不使用任何真实企业数据。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbCommand } from '../../src/commands/db.js'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { TABLES, MIGRATIONS } from '../../src/store/schema.js'
import type { Store } from '../../src/store/types.js'

// DuckDB 冷启动偶发 >5s（与 tests/commands/sync.test.ts 同款放宽）。
vi.setConfig({ testTimeout: 15_000 })

let dir = ''
let out = ''
let err = ''
const dbPath = (): string => join(dir, 'q.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-db-'))
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
  it('db tables 输出 25 表 + 行数 + 粒度 + PII 列 + notice', async () => {
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

  it('time_range 按 timeColumn 计算；sessions 的 epoch-ms 转上海 ISO；无时间列 → null', async () => {
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

  it('声明与实况不一致（删一张表 / 多一张表）→ meta.warnings 点名，rows 不编造', async () => {
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

  it('未知参数 / --pretty / 值位缺失 → usage 退出码 2；--help → 0', async () => {
    expect(await dbCommand(['tables', '--db', dbPath(), '--bogus'])).toBe(2)
    expect(errorOf().kind).toBe('usage')
    expect(err.length).toBeGreaterThan(0)          // usageFail 双通道：stderr 文本
    expect(() => JSON.parse(out)).not.toThrow()    // stdout JSON

    out = ''; err = ''
    expect(await dbCommand(['tables', '--db', dbPath(), '--pretty'])).toBe(2)
    expect(err).toMatch(/--pretty/)

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

    // 无子命令 / --help / tables --help / describe --help → USAGE 走 stdout、退出码 0
    for (const argv of [[], ['--help'], ['tables', '--help'], ['describe', '--help']]) {
      out = ''; err = ''
      expect(await dbCommand(argv), argv.join(' ')).toBe(0)
      expect(out).toMatch(/db tables/)
      expect(err).toBe('')
    }
  })

  it('库不存在 → store_not_initialized + hint 指 store init', async () => {
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
    const alien = join(dir, 'alien.db')
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
  it('db describe sessions：7 键逐列 + sensitive/observed_enum/时间列/row_count/PII 列', async () => {
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

  it('无时间列 → time_column/time_range 均 null；meta 恒有 notice 与 warnings', async () => {
    await seed()
    expect(await dbCommand(['describe', 'schema_version', '--db', dbPath()])).toBe(0)

    const d = data() as DescribeOut
    expect(d.time_column).toBeNull()
    expect(d.time_range).toBeNull()          // 无 timeColumn → 不编造范围
    expect(d.row_count).toBe(MIGRATIONS.length)
    expect(d.pii_columns).toEqual([])

    const m = meta()
    expect(Object.keys(m).sort()).toEqual(['notice', 'warnings'])
    expect(m.notice).toBe('本数据库包含客户 PII；不要将其写入日志或对外报表')
    expect(m.warnings).toEqual([])
  })

  it('未知表 → usage 2 + 候选（sessons → sessions）；缺表名 / 多余位置参数 → usage 2', async () => {
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

    // 未知 flag 不得被当成表名；--pretty 沿全族显式拒绝
    out = ''; err = ''
    expect(await dbCommand(['describe', 'sessions', '--bogus', '--db', dbPath()])).toBe(2)
    expect(err).toMatch(/未知参数：--bogus/)
    out = ''; err = ''
    expect(await dbCommand(['describe', 'sessions', '--pretty', '--db', dbPath()])).toBe(2)
    expect(err).toMatch(/--pretty/)
  })

  it('实际列集与 TABLES 不一致 → meta.warnings 点名多列/少列；列清单仍以声明为权威', async () => {
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

  it('R5：声明有但库中无 → 仍输出声明元数据（row_count/time_range null）+ warning，退出码 0', async () => {
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
    // 声明元数据照常：Agent 需要知道该表「应该」有什么列，才能判断是没同步还是没建库
    expect(d.columns).toHaveLength(sessionsDef().columns.length)
    expect(d.pii_columns).toEqual(SESSIONS_PII)
    expect(d.time_column).toEqual({ name: 'startTime', kind: 'epoch-ms' })

    const warnings = meta().warnings as string[]
    // 表都不在，列集核对无从谈起 —— 只留一条「表不存在」警告，不制造「少列」噪音
    expect(warnings).toHaveLength(1)
    const text = warnings.join('\n')
    expect(text).toMatch(/sessions/)
    expect(text).toMatch(/不存在/)
    expect(text).toMatch(/声明元数据/)
    expect(meta().notice).toBe('本数据库包含客户 PII；不要将其写入日志或对外报表')
  })
})
