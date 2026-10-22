// tests/commands/db-time-boundary.test.ts —— gap 2 的端到端护栏：
// 「一条脏值不该炸整条命令」。
//
// ⚠️ **为什么单开一个文件**（而不是塞进 db.test.ts / query.test.ts）：
// 本组（G6）与 G4（测试隔离与判别力）都动 `tests/**`，且这两条命令的失败形态
// 互不相同（前者是 exit code，后者是断言粒度）——分开成文件，合并时互不覆盖。
//
// 复现的缺陷（F 子项目全维度审查 gap 2）：
//   `sessions.startTime` 里存一条 `'8640000000000000'`（= Date 的 epoch 毫秒上限），
//   旧实现的 epoch-ms 形状谓词上界恰好是 `8640000000000000` —— **放行**。
//   于是它进入 time_range 的 MIN/MAX 候选集 → `msToShanghaiIso` 先加上海偏移（+8h）
//   再 `toISOString()` → 偏移后越界 → 抛 `RangeError: Invalid time value`
//   → `db tables` / `db describe sessions` / `query --table sessions` 三条命令
//   **全部 exit 1**（`{"code":"internal","message":"查询执行失败（底层：Invalid time value）"}`）。
//
// 修法（src/core/time.ts + db.ts + query/table-query.ts）：
//   形状谓词上界与回显守卫统一收到 `MAX_SHANGHAI_SAFE_MS`（= MAX_DATE_MS − 8h）——
//   「形状合格」与「能回显」永远是同一集合，脏值退化为「被排除 + 计数警告」。
//
// ⚠️ fixtures 全合成：13800001111 是明显的测试号码，不使用任何真实企业数据。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dbCommand } from '../../src/commands/db.js'
import { queryCommand } from '../../src/commands/query.js'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { MAX_SHANGHAI_SAFE_MS } from '../../src/core/time.js'

// DuckDB 冷启动在慢机上实测可达 10s+（首条用例尤其明显），30s 与
// tests/commands/query.test.ts 同款放宽。
vi.setConfig({ testTimeout: 30_000 })

let dir = ''
let out = ''
const dbPath = (): string => join(dir, 'q.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-db-boundary-'))
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += String(s); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('HOME', dir)   // 隔离真实 ~（默认库路径与配置文件都走 HOME）
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const data = (): Record<string, unknown> => JSON.parse(out).data
const meta = (): Record<string, unknown> => JSON.parse(out).meta
type TableOut = { name: string; rows: number; time_range: { min: string; max: string } | null }

/** 会话行（payload 合成，userPhone 是明显的测试号码）。 */
const sessionRow = (id: string, startTime: string): Record<string, unknown> => ({
  session_id: id, payload: JSON.stringify({ id }), staffId: '1000001',
  startTime, endTime: null, session_type: 'human', categoryDetail: null,
  userPhone: '13800001111', userName: '测试用户', userEmail: null, userAddress: null,
  fromIp: null, userIpCity: null, userCrmInfo: null,
  synchronized_at: '2026-10-15T00:00:00.000Z',
})

/** 建库 + 写入两行干净数据 + 一行上界脏值。 */
async function seedWithDirtyMax(): Promise<void> {
  const s = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  try {
    await s.init()
    await s.upsert('sessions', [
      sessionRow('s1', '1791907200000'),   // 2026-10-14 00:00 +08:00
      sessionRow('s2', '1786723200000'),   // 2026-08-15 00:00 +08:00
      sessionRow('dirty-max', '8640000000000000'),   // 上界脏值：偏移后越界
    ])
  } finally {
    await s.close()
  }
}

describe('epoch-ms 上界脏值不炸整条命令（gap 2 端到端）', () => {
  it('db tables：退出码 0；脏值被排除出 time_range 并计数警告', async () => {
    await seedWithDirtyMax()
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)

    const tables = data().tables as TableOut[]
    const sessions = tables.find((t) => t.name === 'sessions')!
    expect(sessions.rows).toBe(3)   // 脏行照样计数（它是真实存在的行）
    // 极值仍是合法 ISO（只取干净那两行）—— 不是 '8640000000000000'，也不是抛异常。
    expect(sessions.time_range).toEqual(
      { min: '2026-08-15T00:00:00+08:00', max: '2026-10-14T00:00:00+08:00' })
    // 脏值必须**可见**（计数 + 警告），不得静默吞掉。
    expect((meta().warnings as string[]).join('\n'))
      .toMatch(/时间列 startTime 有 1 个值不符合约定形态/)
  })

  it('db describe sessions：退出码 0（不 internal）', async () => {
    await seedWithDirtyMax()
    expect(await dbCommand(['describe', 'sessions', '--db', dbPath()])).toBe(0)
    expect((meta().warnings as string[]).join('\n'))
      .toMatch(/时间列 startTime 有 1 个值不符合约定形态/)
  })

  it('query --table sessions：退出码 0（不 internal）', async () => {
    await seedWithDirtyMax()
    expect(await queryCommand(['--table', 'sessions', '--db', dbPath()])).toBe(0)
    // data_coverage 的极值同样是合法 ISO（脏值被形状谓词排除）。
    const cov = meta().data_coverage as { min: string; max: string }
    expect(cov.min).toBe('2026-08-15T00:00:00+08:00')
    expect(cov.max).toBe('2026-10-14T00:00:00+08:00')
  })

  it('形状谓词上界与回显守卫同源：脏值恰好落在候选集之外（gap 2 的根因钉死）', async () => {
    // 上界常量本身的关系：= Date 上限 − 上海偏移（不是 Date 上限）。
    expect(MAX_SHANGHAI_SAFE_MS).toBe(8639999971200000)
    // 脏值 '8640000000000000' 恰好大于它 → 被形状谓词排除 → 永不进回显路径。
    expect(8640000000000000).toBeGreaterThan(MAX_SHANGHAI_SAFE_MS)
  })
})
