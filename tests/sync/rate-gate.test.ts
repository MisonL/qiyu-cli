import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { RateGate, readCooldown, writeCooldown } from '../../src/sync/rate-gate.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

// L1 对冲：真库冷启动偶发慢，放宽超时（同 tests/store/duckdb.test.ts）。
vi.setConfig({ testTimeout: 15_000 })

let dir = ''
let cfg: StoreConfig
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-gate-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30000, batchSize: 1000 }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

/** 真库夹具：rw 模式打开并 init（迁移跑满）。 */
async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(cfg, 'rw')
  await s.init()
  return s
}

/** 按固定路径打开独立实例（跨实例持久化用例）。 */
async function open(path: string): Promise<Store> {
  const s = await createDuckDbStore({ ...cfg, path }, 'rw')
  await s.init()
  return s
}

describe('RateGate —— 冷却读写', () => {
  it('readCooldown 无记录返回 0', async () => {
    const s = await fresh()
    expect(await readCooldown(s, 'statistic.overview')).toBe(0)
    await s.close()
  })

  it('writeCooldown 后 readCooldown 往返毫秒时间戳', async () => {
    const s = await fresh()
    await s.transaction((tx) => writeCooldown(tx, 'statistic.overview', 1_234_567))
    expect(await readCooldown(s, 'statistic.overview')).toBe(1_234_567)
    await s.close()
  })

  it('writeCooldown 覆盖旧值（同 dataset 主键幂等）', async () => {
    const s = await fresh()
    await s.transaction((tx) => writeCooldown(tx, 'statistic.overview', 100))
    await s.transaction((tx) => writeCooldown(tx, 'statistic.overview', 200))
    expect(await readCooldown(s, 'statistic.overview')).toBe(200)
    await s.close()
  })
})

describe('RateGate —— acquire / penalize', () => {
  it('冷却期内 acquire 抛 rate_limit_local 且 retryAfter 准确；到期放行', async () => {
    let now = 1_000_000
    const clock = () => now
    const store = await fresh()
    const gate = new RateGate(store, clock)
    await gate.penalize('statistic.overview', 30)
    let err: unknown
    try { await gate.acquire('statistic.overview') } catch (e) { err = e }
    expect((err as { kind: string }).kind).toBe('rate_limit_local')
    expect((err as { retryAfter: number }).retryAfter).toBe(30_000)
    now += 29_000
    await expect(gate.acquire('statistic.overview')).rejects.toMatchObject({ kind: 'rate_limit_local' })
    now += 2_000
    await expect(gate.acquire('statistic.overview')).resolves.toBeUndefined()
    await store.close()
  })

  it('冷却状态跨 store 实例可见（持久化钉死）', async () => {
    const path = join(dir, 'persist.db')
    const a = await open(path)
    const gateA = new RateGate(a, () => 0)
    await gateA.penalize('tag.all', 60)
    await a.close()
    const b = await open(path)
    const gateB = new RateGate(b, () => 1_000)
    await expect(gateB.acquire('tag.all')).rejects.toMatchObject({ kind: 'rate_limit_local' })
    await b.close()
  })

  it('无限频接口（limitFor → null）acquire 永远放行', async () => {
    const store = await fresh()
    const gate = new RateGate(store, () => 0)
    // 'chat.queue.group.query' 在 RATE_LIMITS 显式登记为 null（实测无限频）。
    await gate.penalize('chat.queue.group.query', 60)
    await expect(gate.acquire('chat.queue.group.query')).resolves.toBeUndefined()
    await store.close()
  })

  it('penalize 后冷却行写入 sync_state（dataset=__ratelimit__:endpointId）', async () => {
    const store = await fresh()
    const gate = new RateGate(store, () => 5_000)
    await gate.penalize('tag.all', 10)
    const r = await store.query('SELECT watermark FROM sync_state WHERE dataset = ?', ['__ratelimit__:tag.all'])
    expect(r.rows[0].watermark).toBe(new Date(15_000).toISOString())
    // last_rate_limited_at 也取注入时钟（fix 轻-2）：可确定性断言。
    const r2 = await store.query('SELECT last_rate_limited_at FROM sync_state WHERE dataset = ?', ['__ratelimit__:tag.all'])
    expect(r2.rows[0].last_rate_limited_at).toBe(new Date(5_000).toISOString())
    await store.close()
  })
})
