import { describe, it, expect, vi } from 'vitest'
import { retryWithBackoff, isLockError, classifyOpenFailure } from '../../src/store/retry.js'

// ⚠️ 夹具用**探针逐字**的真报文形态（跨进程真持锁实测）：判据已从「子串搜 Conflicting lock」
// 收紧为模板锚定（2026-11-01，见 store/retry.ts 的 isLockError 注释）—— 那条子串判会把
// 「路径里恰好含这两个词的非 DuckDB 文件」判成撞锁。
const LOCK_MSG = (path = '/tmp/x/q.db') =>
  `IO Error: Could not set lock on file "${path}": Conflicting lock is held in `
  + '/Users/x/.nvm/versions/node/v24/bin/node (PID 83991) by user x. '
  + 'See also https://duckdb.org/docs/stable/connect/concurrency'

// ⚠️ **Linux 形态没有 ` by user ` 那段**（CI 实测，见 store/retry.ts 的 isLockError 注释）：
// 首版判据锚了三段骨架，本机（macOS）绿、CI 三个 Node 版本全红 —— 「探针跑在哪个平台，
// 判据就只对那个平台成立」。这条夹具把两个平台形态一起钉住。
const LOCK_MSG_LINUX = (path = '/tmp/x/q.db') =>
  `IO Error: Could not set lock on file "${path}": Conflicting lock is held in `
  + '/opt/hostedtoolcache/node/24.22.1/x64/bin/node (PID 4894). '
  + 'See also https://duckdb.org/docs/stable/connect/concurrency'
const lockErr = () => new Error(LOCK_MSG())

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
  it('文件已损坏 → corrupt（两条都是 2026-11-05 探针逐字原文；rw/ro 打开相同）', () => {
    // 截断：元数据块在文件尾部，读到一半就 EOF（探针：536KB 的库截到 200KB）
    expect(classifyOpenFailure(new Error(
      'IO Error: Could not read enough bytes from file "/private/tmp/corruptprobe/trunc.db": '
      + 'attempted to read 74432 bytes from location 200000')))
      .toEqual({ cause: 'corrupt' })
    // 页校验和不对（探针：把第 8192 字节起的 4KB 清零）
    expect(classifyOpenFailure(new Error(
      'IO Error: Corrupt database file: computed checksum 5381 does not match stored '
      + 'checksum 0 in block at location 8192')))
      .toEqual({ cause: 'corrupt' })
  })
  it('损坏判据的条件：**句首**锚定 + 与其它成因互斥（路径里含这些词不算）', () => {
    // 路径里恰好抄了损坏报文的原句 —— 真因是「文件不存在」 → 不归类，更不能归 corrupt
    expect(classifyOpenFailure(new Error(
      'IO Error: Cannot open file "/tmp/Corrupt database file:/x.db": No such file or directory')))
      .toBeNull()
    expect(classifyOpenFailure(new Error(
      'IO Error: Cannot open file "/tmp/Could not read enough bytes from file /q.db": Permission denied')))
      .toEqual({ cause: 'permission' })
    // 同一个词出现在报文中段（执行期错误拼接了别的库消息）→ 仍须句首锚定，不归类
    expect(classifyOpenFailure(new Error(
      'Invalid Input Error: COPY failed: IO Error: Corrupt database file: computed checksum 1')))
      .toBeNull()
    // 反向：句首形态必须真命中（上面两条反例若写成永不命中，这里补最小正例）
    expect(classifyOpenFailure(new Error('IO Error: Corrupt database file: x')))
      .toEqual({ cause: 'corrupt' })
  })
})

describe('isLockError —— 锁错误识别', () => {
  it('真锁报文（macOS 形态，含 ` by user `）→ true', () => {
    expect(isLockError(lockErr())).toBe(true)
  })
  it('真锁报文（Linux 形态，**无** ` by user `）→ true（判据不得只对 macOS 成立）', () => {
    expect(isLockError(new Error(LOCK_MSG_LINUX()))).toBe(true)
  })
  it('其他错误 → false（不无谓退避）', () => {
    expect(isLockError(new Error('ENOENT: no such file'))).toBe(false)
    expect(isLockError(new Error('EACCES: permission denied'))).toBe(false)
  })
  it('⚠️ 路径里含 `Conflicting lock` 的**非 DuckDB 文件** → false（子串判会把用户路径当锁）', () => {
    // 实测事故（2026-11-01）：`db tables --db '/tmp/Conflicting lock/q.db'`（内容是垃圾）
    // 被子串判认成撞锁 → 白白退避 30 秒 → 报「数据库被写进程占用」+ retryable: true，
    // 而真相是那个路径根本不是数据库文件（重试一万次也一样）。
    expect(isLockError(new Error(
      'IO Error: The file "/private/tmp/qreview/Conflicting lock/q.db" exists, '
      + 'but it is not a valid DuckDB database file!'))).toBe(false)
    // 同类：权限错也把路径原文嵌进报文
    expect(isLockError(new Error(
      'IO Error: Cannot open file "/tmp/Conflicting lock.db": Permission denied'))).toBe(false)
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
