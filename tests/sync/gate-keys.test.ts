// tests/sync/gate-keys.test.ts —— 限频闸门的键必须覆盖任务**实际调用**的每个 endpoint
// （2026-11-02 实测缺陷）。
//
// 背景：闸门的两端用不同的键源 —— `callPaced(endpointId, …)` 命中远端限频时
// penalize 写的是**当下这个** endpoint 的冷却行，而引擎取数前只 acquire
// `task.endpoint`。于是一个任务调多个 endpoint 时，被限流的那个端点写了冷却行，
// 引擎却去查另一把键 —— 冷却**永远不会被读到**。实测（修复前）：
//   · `ticket.logs`：ticket.log 限流 → 冷却行 `__ratelimit__:ticket.log` 落库，
//     `acquire('ticket.search')` 放行，紧接着又发了 4 次 ticket.log；
//   · `dim.ticket_template_fields`：`ticket.template.list` 同理。
// 当时只有 2 个任务受影响，但判据是「一个任务调几个 endpoint」——不随现在的任务数收缩。
//
// 判据选**真实调用**而不是扫源码：`callPaced(endpointOf(taskId))`、helper 内部调用、
// 循环变量这些形态正则都会漏（本仓库就有前两种）。做法：记录型 fetch 采集每个任务
// fetch 真实打到的 endpoint id 集合，与声明的 `gateEndpoints` 双向比对；
// 再配两个行为用例钉住「被限流端点的冷却行真的拦得住下一轮」。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { runTask } from '../../src/sync/engine.js'
import { RateGate, readCooldown } from '../../src/sync/rate-gate.js'
import { SYNC_TASKS } from '../../src/sync/registry.js'
import { DIM_TASKS } from '../../src/sync/tasks/dim.js'
import { SESSIONS_TASKS } from '../../src/sync/tasks/sessions.js'
import { TICKET_TASKS } from '../../src/sync/tasks/tickets.js'
import { KNOWLEDGE_TASKS } from '../../src/sync/tasks/knowledge.js'
import { REPORT_TASKS } from '../../src/sync/tasks/reports.js'
import { __setSleep } from '../../src/sync/tasks/pace.js'
import { __resetBuckets } from '../../src/core/http.js'
import { byId } from '../../src/core/registry/index.js'
import type { RunCtx } from '../../src/sync/types.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

vi.setConfig({ testTimeout: 30_000 })

const DAY = 86_400_000
const NOW = 1_700_000_000_000

let dir = ''
let cfg: StoreConfig
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-gatekeys-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30_000, batchSize: 1000 }
  __resetBuckets()
  // callPaced / 引擎的等待在真同步里可达 180 秒：注零等待，否则用例挂死。
  __setSleep(async () => {})
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(cfg, 'rw')
  await s.init()
  return s
}

/** URL → 注册表 endpoint id（spec.path 全仓唯一）。 */
function endpointOfUrl(url: string): string {
  const path = /https:\/\/qiyukf\.com(\/[^?]*)/.exec(String(url))?.[1] ?? String(url)
  const hit = [...new Set(SYNC_TASKS.flatMap((t) => t.gateEndpoints ?? [t.endpoint ?? t.id]))]
    .map((id) => byId(id))
    .find((s) => s.path === path)
  return hit?.id ?? path
}

/** 采集「跑一次任务的 fetch 真实打到的 endpoint id 集合」。 */
async function calledEndpoints(t: Parameters<typeof runTask>[0], store: Store): Promise<string[]> {
  const seen: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    seen.push(endpointOfUrl(url))
    return new Response(JSON.stringify({ code: 200, message: '[]' }),
      { status: 200, headers: { 'content-type': 'application/json' } })
  }))
  try {
    await runTask(t, {
      store, credentials: { appKey: 'k', appSecret: 's' }, gate: new RateGate(store, () => NOW),
      clock: () => NOW,
      // windowed 任务的窗口守卫要 start>0；snapshot 忽略。
      ...(t.kind === 'windowed' ? { rangeOverride: { start: NOW - DAY, end: NOW } } : {}),
    } as RunCtx)
  } finally { vi.unstubAllGlobals() }
  return [...new Set(seen)]
}

describe('闸门键 ⊇ fetch 真实调用的 endpoint 集合（全任务，真实调用采集）', () => {
  it('每个任务：fetch 打到的每个 endpoint id 都在声明里（少一个就是冷却读不到的形状）', async () => {
    const store = await fresh()
    try {
      for (const t of SYNC_TASKS) {
        const called = await calledEndpoints(t, store)
        const declared = new Set(t.gateEndpoints ?? [t.endpoint ?? t.id])
        // knowledge.categories 依赖 knowledge_items 有行 —— 空驱动是显式失败（任务自己的守卫），
        // 不属闸门键问题；这类「前置数据」失败时 called 为空，断言自然空真。
        const missed = called.filter((id) => !declared.has(id))
        expect(missed, `${t.id} 的 fetch 实际调用了未声明进闸门的 endpoint：${missed.join('、')}`)
          .toEqual([])
      }
    } finally { await store.close() }
  })

  it('行为：ticket.log 被限流 → 冷却行拦住 ticket.logs 的下一轮（修复前照旧发请求）', async () => {
    const store = await fresh()
    const t = TICKET_TASKS.find((x) => x.id === 'ticket.logs')!
    try {
      const ctx = (g: RateGate): RunCtx => ({
        store, credentials: { appKey: 'k', appSecret: 's' }, gate: g, clock: () => NOW,
        rangeOverride: { start: NOW - DAY, end: NOW },
        // 冷却 60 秒 × 预算 3 次 —— 不注入零等待就是 180 秒真实挂起。
        sleep: async () => {},
      })
      // 第一轮：search 正常返回一张工单，log 回限流 → callPaced penalize('ticket.log')
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        if (String(url).includes('/ticket/log')) {
          return new Response(JSON.stringify({ code: 14009, message: '限流' }),
            { status: 200, headers: { 'content-type': 'application/json' } })
        }
        return new Response(JSON.stringify({
          code: 200, message: JSON.stringify({ total: 1, tickets: [{ id: 900001 }] }),
        }), { status: 200, headers: { 'content-type': 'application/json' } })
      }))
      await runTask(t, ctx(new RateGate(store, () => NOW)))
      vi.unstubAllGlobals()
      expect(await readCooldown(store, 'ticket.log'), '第一轮必须写出 ticket.log 的冷却行')
        .toBeGreaterThan(NOW)

      // 第二轮：冷却未到点 → 引擎必须在 acquire 处拦住，网络上一发都不许有
      const second: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string) => { second.push(String(url)); throw new Error('不该发请求') }))
      const r = await runTask(t, ctx(new RateGate(store, () => NOW)))
      vi.unstubAllGlobals()
      expect(r.gaps.map((g) => g.reason), '被拦时必须记 rate_limit_local gap').toEqual(['rate_limit_local'])
      expect(second, '限流端点（ticket.log）的冷却没被读到 —— 下一轮照旧超发').toEqual([])
    } finally { vi.unstubAllGlobals(); await store.close() }
  })

  it('行为：ticket.template.list 被限流 → 冷却行拦住 dim.ticket_template_fields 的下一轮', async () => {
    const store = await fresh()
    const t = DIM_TASKS.find((x) => x.id === 'dim.ticket_template_fields')!
    try {
      // 冷却行直接写（penalize 的接线已在 tests/sync/tasks-pace.test.ts 钉住），
      // 这里只问「引擎会不会读这把键」。
      await new RateGate(store, () => NOW).penalize('ticket.template.list', 60)
      const second: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string) => { second.push(String(url)); throw new Error('不该发请求') }))
      const r = await runTask(t, {
        store, credentials: { appKey: 'k', appSecret: 's' }, gate: new RateGate(store, () => NOW),
        clock: () => NOW, sleep: async () => {},
      } as RunCtx)
      vi.unstubAllGlobals()
      expect(r.gaps.map((g) => g.reason)).toEqual(['rate_limit_local'])
      expect(second, 'template.list 的冷却没被读到 —— 下一轮照旧超发').toEqual([])
    } finally { vi.unstubAllGlobals(); await store.close() }
  })

  it('反向：与本任务无关的冷却不得拦住它（守卫不能一刀切拦死）', async () => {
    const store = await fresh()
    const t = TICKET_TASKS.find((x) => x.id === 'tickets.search')!
    try {
      await new RateGate(store, () => NOW).penalize('statistic.overview', 60)   // 无关冷却
      const calls: string[] = []
      vi.stubGlobal('fetch', vi.fn(async (url: string) => {
        calls.push(String(url))
        return new Response(JSON.stringify({ code: 200, message: JSON.stringify({ total: 0, tickets: [] }) }),
          { status: 200, headers: { 'content-type': 'application/json' } })
      }))
      await runTask(t, {
        store, credentials: { appKey: 'k', appSecret: 's' }, gate: new RateGate(store, () => NOW),
        clock: () => NOW, rangeOverride: { start: NOW - DAY, end: NOW },
      } as RunCtx)
      vi.unstubAllGlobals()
      expect(calls.length, '无关冷却不该拦住本任务').toBeGreaterThan(0)
    } finally { vi.unstubAllGlobals(); await store.close() }
  })
})

describe('闸门键声明自身的完整性', () => {
  it('主 endpoint 必在声明里、无重复；五组任务数合计 = SYNC_TASKS', () => {
    expect([...DIM_TASKS, ...REPORT_TASKS, ...TICKET_TASKS, ...SESSIONS_TASKS, ...KNOWLEDGE_TASKS])
      .toEqual(SYNC_TASKS)
    for (const t of SYNC_TASKS) {
      const declared = t.gateEndpoints ?? [t.endpoint ?? t.id]
      expect(declared, `${t.id} 的闸门键必须包含主 endpoint`).toContain(t.endpoint ?? t.id)
      expect(new Set(declared).size, `${t.id} 的闸门键有重复`).toBe(declared.length)
    }
  })
})
