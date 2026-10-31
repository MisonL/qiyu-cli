import { describe, it, expect, vi } from 'vitest'
import { retryWithBackoff, isLockError, classifyOpenFailure } from '../../src/store/retry.js'

const lockErr = () => new Error('IO Error: Could not set lock on file "x": Conflicting lock is held')

describe('classifyOpenFailure —— 打开失败的成因分类（2026-10-31 单一实现点）', () => {
  // 判据是 `store/retry.ts` 的 `classifyOpenFailure` 的唯一实现，store/query/sync 三处共用。
  // 报文是**真实形态**（探针逐字抄来，@duckdb/node-api 1.5.6-r.1）—— 不是 Node fs 的
  // `EACCES: …` 前缀，而是 DuckDB 原生的 `IO Error: …`、strerror 在句尾、`e.code` undefined。
  it('非 DuckDB 文件 → not_duckdb', () => {
    const e = new Error('IO Error: The file "/tmp/junk.db" exists, but it is not a valid DuckDB database file!')
    expect(classifyOpenFailure(e)).toEqual({ cause: 'not_duckdb' })
  })
  it('近似命中：路径含该措辞、真因是权限 → permission（不是 not_duckdb）', () => {
    // 判据锚句尾真因，不是子串搜索 —— 两条都锚尾才不会互相抢
    const e = new Error('IO Error: Cannot open file "/tmp/not a valid DuckDB database file.txt": Permission denied')
    expect(classifyOpenFailure(e)).toEqual({ cause: 'permission' })
  })
  it('三种权限 strerror → permission（锚句尾，路径含词不误命中）', () => {
    for (const reason of ['Permission denied', 'Operation not permitted', 'Read-only file system']) {
      expect(classifyOpenFailure(new Error(`IO Error: Cannot open file "/tmp/x/q.db": ${reason}`)))
        .toEqual({ cause: 'permission' })
    }
    // 近似命中：路径里含该词、真因是别的 → 不是 permission
    expect(classifyOpenFailure(new Error('IO Error: Cannot open file "/tmp/Permission denied.db": No such file or directory')))
      .toBeNull()
  })
  it('其他（库不存在 / 执行期错误）→ null（不归类）', () => {
    expect(classifyOpenFailure(new Error('IO Error: Cannot open database "/x/q.db" in read-only mode: database does not exist'))).toBeNull()
    expect(classifyOpenFailure(new Error('Constraint Error: NOT NULL constraint failed'))).toBeNull()
    expect(classifyOpenFailure(new Error('x'))).toBeNull()
  })
})

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
