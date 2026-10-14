import { describe, it, expect, vi } from 'vitest'
import { retryWithBackoff, isLockError } from '../../src/store/retry.js'

const lockErr = () => new Error('IO Error: Could not set lock on file "x": Conflicting lock is held')

describe('isLockError —— 锁错误识别', () => {
  it('message 含 Conflicting lock → true', () => {
    expect(isLockError(lockErr())).toBe(true)
  })
  it('其他错误 → false（不无谓退避）', () => {
    expect(isLockError(new Error('ENOENT: no such file'))).toBe(false)
    expect(isLockError(new Error('EACCES: permission denied'))).toBe(false)
  })
})

describe('retryWithBackoff —— 有界重试', () => {
  it('恒失败 → 总耗时不超 maxMs，抛 store_locked', async () => {
    let t = 0
    const sleep = async (ms: number) => { t += ms }
    const p = retryWithBackoff({
      tryOpen: async () => { throw lockErr() },
      isRetryable: isLockError, maxMs: 1000, intervalMs: 200,
      sleep, now: () => t,
    })
    await expect(p).rejects.toThrow(/Conflicting lock|store_locked|锁/)
    expect(t).toBeLessThanOrEqual(1000)
    expect(t).toBeGreaterThan(0)
  })

  it('第 3 次成功 → 重试 2 次后返回结果', async () => {
    let n = 0, t = 0
    const res = await retryWithBackoff({
      tryOpen: async () => { n++; if (n < 3) throw lockErr(); return 'ok' },
      isRetryable: isLockError, maxMs: 10000, intervalMs: 200,
      sleep: async (ms) => { t += ms }, now: () => t,
    })
    expect(res).toBe('ok')
    expect(n).toBe(3)
    expect(t).toBe(400)   // 固定间隔 200ms × 2 次
  })

  it('非锁错误立即抛、不 sleep（验收 34）', async () => {
    const sleep = vi.fn(async () => {})
    await expect(retryWithBackoff({
      tryOpen: async () => { throw new Error('ENOENT') },
      isRetryable: isLockError, maxMs: 10000, intervalMs: 200, sleep, now: () => 0,
    })).rejects.toThrow('ENOENT')
    expect(sleep).not.toHaveBeenCalled()
  })

  it('首次成功不 sleep', async () => {
    const sleep = vi.fn(async () => {})
    const r = await retryWithBackoff({ tryOpen: async () => 42, isRetryable: isLockError, maxMs: 1000, sleep, now: () => 0 })
    expect(r).toBe(42)
    expect(sleep).not.toHaveBeenCalled()
  })
})
