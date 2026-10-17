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

    // describe 是已声明子命令、尚未实现（Task 7 填）：usage 2，不是「未知子命令」
    out = ''; err = ''
    expect(await dbCommand(['describe'])).toBe(2)
    expect(err).toMatch(/尚未实现/)

    // 无子命令 / --help / tables --help → USAGE 走 stdout、退出码 0
    for (const argv of [[], ['--help'], ['tables', '--help']]) {
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
