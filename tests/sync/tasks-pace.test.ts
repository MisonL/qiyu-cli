// tests/sync/tasks-pace.test.ts —— D 最终修复波 中-1：任务层共享 callPaced 的远端限频接线。
// 之前 callPaced 只捕 local_rate_limit，远端限频（kind=rate_limit）从 http.call 抛出后
// 无人调 gate.penalize —— 持久化冷却行（验收 9）是死代码。本文件钉死：
//   ① 远端限频 → ctx.gate.penalize(taskId, retryAfter.seconds) 被调 + 等待后重试成功；
//   ② gate 不在 ctx → 退化为纯等待（不抛、不 penalize）；
//   ③ 本地限频（local_rate_limit）→ 不 penalize（纯进程内冷却不落库）、等待后重试成功。
// http.call 经 vi.mock 注入错误形态（真实 http 的限频 retryAfter 来自限频表，秒数不可控；
// mock 直接给 retryAfter 5s —— 与派发钉死用例一致），__setSleep 注入零等待记录等待时长。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { callPaced, __setSleep } from '../../src/sync/tasks/pace.js'
import { call } from '../../src/core/http.js'
import type { CallResult } from '../../src/core/http.js'
import type { FetchCtx, RunCtx } from '../../src/sync/types.js'

vi.mock('../../src/core/http.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/http.js')>()
  return { ...actual, call: vi.fn() }
})

const callMock = vi.mocked(call)

/** 远端限频错误形态（http.call 抛出的 kind=rate_limit；retryAfter 5s 为派发钉死值）。 */
function remoteLimitError(seconds: number): Error {
  return Object.assign(new Error(`接口 statistic.overview 触发限流（14009）`), {
    code: '14009', kind: 'rate_limit', retryable: true,
    retryAfter: { seconds, source: 'observed' },
  })
}

/** 本地限频错误形态（core 令牌桶抛出的 code=local_rate_limit）。 */
function localLimitError(seconds: number): Error {
  return Object.assign(new Error('接口触发本地限频'), {
    code: 'local_rate_limit', kind: 'rate_limit', retryable: true,
    retryAfter: { seconds, source: 'local' },
  })
}

/** 最小 FetchCtx（callPaced 只消费 credentials 与可选 gate）。 */
function paceCtx(gate?: RunCtx['gate']): FetchCtx {
  return {
    credentials: { appKey: 'test-key', appSecret: 'test-secret' },
    ...(gate !== undefined ? { gate } : {}),
  } as FetchCtx
}

let waits: number[] = []
let penalize: ReturnType<typeof vi.fn>

beforeEach(() => {
  waits = []
  penalize = vi.fn(async () => {})
  callMock.mockReset()
  __setSleep(async (ms) => { waits.push(ms) })
})

describe('任务层 callPaced —— 远端限频 penalize 接线（中-1）', () => {
  it('远端限频（retryAfter 5s）→ gate.penalize(taskId, 5) 被调 + 等待后重试成功', async () => {
    callMock.mockRejectedValueOnce(remoteLimitError(5))
      .mockResolvedValueOnce({ ok: true, payload: { sessions: 1 } } as CallResult)
    const res = await callPaced('statistic.overview', {}, paceCtx(
      { penalize } as unknown as RunCtx['gate']), 'reports.overview')
    expect(res.payload).toEqual({ sessions: 1 })
    expect(penalize).toHaveBeenCalledTimes(1)
    expect(penalize).toHaveBeenCalledWith('reports.overview', 5)
    // 冷却等待：retryAfter 5s + 1s 余量（真实同步的睡眠在测试注入中记录、零耗时）
    expect(waits).toEqual([6_000])
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it('持续远端限频 → 有界重试（3 次等待）后抛出，penalize 同步逐次写冷却', async () => {
    callMock.mockRejectedValue(remoteLimitError(5))
    await expect(callPaced('statistic.overview', {}, paceCtx(
      { penalize } as unknown as RunCtx['gate']), 'reports.overview')).rejects.toThrow('限流')
    expect(callMock).toHaveBeenCalledTimes(4)   // 初次 + 3 次等待重试
    expect(penalize).toHaveBeenCalledTimes(3)
    expect(waits).toEqual([6_000, 6_000, 6_000])
  })

  it('gate 不在 ctx（verify 直调路径）→ 退化为纯等待、重试成功、不抛', async () => {
    callMock.mockRejectedValueOnce(remoteLimitError(5))
      .mockResolvedValueOnce({ ok: true, payload: null } as CallResult)
    const res = await callPaced('statistic.overview', {}, paceCtx(), 'reports.overview')
    expect(res.payload).toBeNull()
    expect(waits).toEqual([6_000])
  })

  it('本地限频（local_rate_limit）→ 不 penalize（纯进程内冷却不落库）+ 等待重试成功', async () => {
    callMock.mockRejectedValueOnce(localLimitError(30))
      .mockResolvedValueOnce({ ok: true, payload: { sessions: 2 } } as CallResult)
    const res = await callPaced('statistic.overview', {}, paceCtx(
      { penalize } as unknown as RunCtx['gate']), 'reports.overview')
    expect(res.payload).toEqual({ sessions: 2 })
    expect(penalize).not.toHaveBeenCalled()
    expect(waits).toEqual([31_000])
  })
})
