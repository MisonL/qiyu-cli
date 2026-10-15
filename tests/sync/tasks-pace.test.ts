// tests/sync/tasks-pace.test.ts —— D 最终修复波 中-1 + 修复批 1（B 中-6 / B 低-2）：
// 任务层共享 callPaced 的限频接线与闸门键口径。
//   ① 远端限频 → ctx.gate.penalize(**endpoint id**, retryAfter.seconds) 被调 + 等待后重试成功；
//   ② gate 不在 ctx → 退化为纯等待（不抛、不 penalize）；
//   ③ 本地限频（local_rate_limit）→ 不 penalize（纯进程内冷却不落库）、等待后重试成功；
//   ④ B 中-6：penalize 与 acquire 必须是**同一把键**（endpoint id）——传 task id 会让
//      RATE_LIMITS 的 null 豁免恒不触发、同路径任务各持一份冷却；
//   ⑤ B 低-2：等待时长封顶（坏冷却行算出的天文数字不把同步挂死），下界兜底（绝不零等待空转）。
// http.call 经 vi.mock 注入错误形态（真实 http 的限频 retryAfter 来自限频表，秒数不可控；
// mock 直接给 retryAfter 5s —— 与派发钉死用例一致），__setSleep 注入零等待记录等待时长。
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { callPaced, __setSleep } from '../../src/sync/tasks/pace.js'
import { MAX_GATE_WAIT_MS } from '../../src/sync/rate-gate.js'
import { call } from '../../src/core/http.js'
import type { CallResult } from '../../src/core/http.js'
import type { FetchCtx } from '../../src/sync/types.js'
import type { RateGate } from '../../src/sync/rate-gate.js'

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

/** 最小 ctx（callPaced 只消费 credentials 与可选 gate）。 */
function paceCtx(gate?: RateGate): FetchCtx {
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

describe('任务层 callPaced —— 远端限频 penalize 接线（中-1 / B 中-6）', () => {
  it('远端限频（retryAfter 5s）→ gate.penalize(endpointId, 5) 被调 + 等待后重试成功', async () => {
    callMock.mockRejectedValueOnce(remoteLimitError(5))
      .mockResolvedValueOnce({ ok: true, payload: { sessions: 1 } } as CallResult)
    const res = await callPaced('statistic.overview', {}, paceCtx(
      { penalize } as unknown as RateGate))
    expect(res.payload).toEqual({ sessions: 1 })
    expect(penalize).toHaveBeenCalledTimes(1)
    // B 中-6 钉死：键是 **endpoint id**（注册表 id / RATE_LIMITS 的键），不是任务 id。
    expect(penalize).toHaveBeenCalledWith('statistic.overview', 5)
    // 冷却等待：retryAfter 5s + 1s 余量（真实同步的睡眠在测试注入中记录、零耗时）
    expect(waits).toEqual([6_000])
    expect(callMock).toHaveBeenCalledTimes(2)
  })

  it('持续远端限频 → 有界重试（3 次等待）后抛出，penalize 逐次写冷却（同一把键）', async () => {
    callMock.mockRejectedValue(remoteLimitError(5))
    await expect(callPaced('statistic.overview', {}, paceCtx(
      { penalize } as unknown as RateGate))).rejects.toThrow('限流')
    expect(callMock).toHaveBeenCalledTimes(4)   // 初次 + 3 次等待重试
    expect(penalize).toHaveBeenCalledTimes(3)
    expect(penalize.mock.calls.every((c) => c[0] === 'statistic.overview')).toBe(true)
    expect(waits).toEqual([6_000, 6_000, 6_000])
  })

  it('gate 不在 ctx（verify 直调路径）→ 退化为纯等待、重试成功、不抛', async () => {
    callMock.mockRejectedValueOnce(remoteLimitError(5))
      .mockResolvedValueOnce({ ok: true, payload: null } as CallResult)
    const res = await callPaced('statistic.overview', {}, paceCtx())
    expect(res.payload).toBeNull()
    expect(waits).toEqual([6_000])
  })

  it('本地限频（local_rate_limit）→ 不 penalize（纯进程内冷却不落库）+ 等待重试成功', async () => {
    callMock.mockRejectedValueOnce(localLimitError(30))
      .mockResolvedValueOnce({ ok: true, payload: { sessions: 2 } } as CallResult)
    const res = await callPaced('statistic.overview', {}, paceCtx(
      { penalize } as unknown as RateGate))
    expect(res.payload).toEqual({ sessions: 2 })
    expect(penalize).not.toHaveBeenCalled()
    expect(waits).toEqual([31_000])
  })

  it('B 低-2：retryAfter 天文数字 → 单次等待封顶（不把同步挂死）', async () => {
    callMock.mockRejectedValueOnce(remoteLimitError(86_400 * 365))   // 一年
      .mockResolvedValueOnce({ ok: true, payload: { ok: 1 } } as CallResult)
    await callPaced('statistic.overview', {}, paceCtx({ penalize } as unknown as RateGate))
    expect(waits).toEqual([MAX_GATE_WAIT_MS])
  })

  it('B 低-2：retryAfter 缺失 → 兜底 30 秒；为 0 → 退化为最小等待（绝不零等待空转）', async () => {
    callMock.mockRejectedValueOnce(Object.assign(new Error('限流（无 retryAfter）'), {
      code: '14009', kind: 'rate_limit', retryable: true,
    }))
      .mockResolvedValueOnce({ ok: true, payload: { ok: 1 } } as CallResult)
    await callPaced('statistic.overview', {}, paceCtx({ penalize } as unknown as RateGate))
    expect(waits).toEqual([31_000])      // 兜底 30s + 1s 余量
    waits = []
    callMock.mockReset()
    callMock.mockRejectedValueOnce(remoteLimitError(0))
      .mockResolvedValueOnce({ ok: true, payload: { ok: 1 } } as CallResult)
    await callPaced('statistic.overview', {}, paceCtx({ penalize } as unknown as RateGate))
    expect(waits).toEqual([1_000])       // 0 秒不是「立刻重试」而是最小等待
  })
})