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

  // 2026-11-14（历史审查 PR#4 复核）：截止时间此前只在 `tryOpen()` **抛错后**才比 ——
  // 打开调用一直不返回（网络盘 / 卡住的锁等待）时，等待没有上界，`store status` 永远挂着。
  // 现在每次尝试自带上限；超时按「可重试」处理，总预算仍由 maxMs 兜住。
  it('单次打开卡住（永不 resolve）→ 按 attemptMs 超时并重试，总耗时不超过 maxMs', async () => {
    let t = 0
    const started = Date.now()
    const p = retryWithBackoff({
      tryOpen: () => new Promise<never>(() => {}),
      isRetryable: isLockError, maxMs: 120, intervalMs: 20, attemptMs: 30,
      sleep: async (ms) => { t += ms }, now: () => t,
    })
    await expect(p).rejects.toThrow(/打开超时|store_locked|占用/)
    expect(t, '总预算仍由 maxMs 兜住').toBeLessThanOrEqual(120)
    // ⚠️ 真实墙钟也要有上界（CodeRabbit PR#74：只断言假时钟不算数 —— 假时钟不计量
    // 「等 attempt 超时」消耗的真实时间，5000ms 的宽限足以放过一次预算超支）。
    const elapsed = Date.now() - started
    expect(elapsed, '真实耗时必须落在总预算附近（attemptMs=30、maxMs=120）').toBeLessThan(1_000)
  })

  // 被放弃的那次尝试若**稍后**成功，必须交出结果让人关掉 —— 否则连接/实例泄漏
  // （ro 退避路径会累积锁持有者，正是 R9 修过的那类）。
  // CodeRabbit PR#74：attemptMs 必须被**剩余总预算**夹住 —— 否则 30s 预算里前一次尝试
  // 花掉 29s 后，下一次仍能再跑满 30s，实际等待接近两倍。这里让 attemptMs 远大于 maxMs，
  // 真实计时必须落在 maxMs 附近。
  it('单次尝试上限随剩余预算收缩（attemptMs=5000、maxMs=60 → 墙钟 ≈ 60ms）', async () => {
    const started = Date.now()
    let message = ''
    await expect(retryWithBackoff({
      tryOpen: () => new Promise<never>(() => {}),
      isRetryable: isLockError, maxMs: 60, intervalMs: 10, attemptMs: 5_000,
    }).catch((e: Error) => { message = e.message; throw e })).rejects.toThrow()
    const elapsed = Date.now() - started
    expect(elapsed, '不能按 attemptMs 等满 5 秒').toBeLessThan(1_000)
    // 报文要说**实际生效**的那一档（被预算夹成 ≤60ms），不能照抄配置里的 5000 ——
    // 「日志说等了 5 秒、实际只等了 60 毫秒」是把诊断引向错误的方向。
    expect(message).toContain('打开超时')
    expect(message, `报文不得照抄被夹小的 attemptMs：${message}`).not.toContain('5000ms')
  })

  it('超时后被放弃的尝试最终成功 → 交回给 onAbandoned 清理', async () => {
    // 每次尝试一个新 promise（同一个 promise 被 4 次尝试共用时，`then` 会各注册一次）
    let resolveLate: (v: string) => void = () => {}
    const late = { current: new Promise<string>((r) => { resolveLate = r }) }
    const nextAttempt = () => { const p = late.current; late.current = new Promise(() => {}); return p }
    const abandoned: string[] = []
    // ⚠️ 假时钟必须**随 sleep 前进**：`now: () => 0` 时 `now()-start+interval > maxMs` 永远不成立，
    // 重试会一直循环（本用例首版就是这么超时的）。
    let t = 0
    await expect(retryWithBackoff({
      tryOpen: nextAttempt,
      isRetryable: isLockError, maxMs: 60, intervalMs: 20, attemptMs: 20,
      sleep: async (ms) => { t += ms }, now: () => t,
      onAbandoned: (v) => abandoned.push(v),
    })).rejects.toThrow()
    resolveLate('late-conn')
    await Promise.resolve(); await Promise.resolve()
    expect(abandoned, '晚到的成功必须被清理，不能静默泄漏').toEqual(['late-conn'])
  })

  it('tryOpen 复用同一个 promise 时，被返回的那次结果绝不能交回清理（会关掉正在用的连接）', async () => {
    // CodeRabbit PR#74 第三轮：第一次尝试超时后，若 `tryOpen` 复用**同一个** promise，
    // 第二次尝试会把它当作结果返回 —— 清理若在超时那一刻就注册，会抢先把返回的连接关掉。
    let resolveShared: (v: string) => void = () => {}
    const shared = new Promise<string>((r) => { resolveShared = r })
    const abandoned: string[] = []
    let attempts = 0
    // 第二次尝试的计时器**恰好落在** promise 落定前后 —— 用真实计时器，不注入 sleep/now
    const p = retryWithBackoff({
      tryOpen: () => { attempts++; return shared },
      isRetryable: isLockError, maxMs: 200, intervalMs: 5, attemptMs: 30,
      onAbandoned: (v) => abandoned.push(v),
    })
    await new Promise((r) => setTimeout(r, 50))   // 第一次已超时，第二次尝试在途
    resolveShared('the-conn')
    await expect(p).resolves.toBe('the-conn')
    await new Promise((r) => setImmediate(r))
    expect(attempts, '前提：至少发生两次尝试').toBeGreaterThanOrEqual(2)
    expect(abandoned, '返回给调用方的连接不得被清理').toEqual([])
  })

  it('tryOpen 复用同一个 promise、整轮仍以超时告终 → 只清理一次', async () => {
    const abandoned: string[] = []
    let attempts = 0
    let resolveShared: (v: string) => void = () => {}
    const shared = new Promise<string>((r) => { resolveShared = r })
    let t = 0
    await expect(retryWithBackoff({
      tryOpen: () => { attempts++; return shared },
      isRetryable: isLockError, maxMs: 100, intervalMs: 20, attemptMs: 20,
      sleep: async (ms) => { t += ms }, now: () => t,
      onAbandoned: (v) => abandoned.push(v),
    })).rejects.toMatchObject({ timedOut: true })
    resolveShared('late-conn')
    await new Promise((r) => setImmediate(r))
    expect(attempts, '前提：同一个 promise 被多次尝试').toBeGreaterThanOrEqual(2)
    expect(abandoned, '同一个连接只能被关一次').toEqual(['late-conn'])
  })

  it('onAbandoned 自己抛错或返回 rejected promise → 静默吞掉，不变 unhandled rejection', async () => {
    // CodeRabbit PR#74 第二轮：`attempt.then(cb, noop)` 的第二个参数只接住 **attempt 的**拒绝，
    // 接不住 cb 的。Node >=15 的默认行为是 unhandled rejection 直接杀进程。
    const rejections: unknown[] = []
    const onRejection = (r: unknown): void => { rejections.push(r) }
    process.on('unhandledRejection', onRejection)
    try {
      for (const onAbandoned of [
        () => { throw new Error('sync cleanup failure') },
        async () => { throw new Error('async cleanup failure') },
      ]) {
        let resolveLate: (v: string) => void = () => {}
        const late = { current: new Promise<string>((r) => { resolveLate = r }) }
        const nextAttempt = () => { const p = late.current; late.current = new Promise(() => {}); return p }
        let t = 0
        await expect(retryWithBackoff({
          tryOpen: nextAttempt,
          isRetryable: isLockError, maxMs: 60, intervalMs: 20, attemptMs: 20,
          sleep: async (ms) => { t += ms }, now: () => t,
          onAbandoned,
        })).rejects.toThrow()
        resolveLate('late-conn')
        // 让 `then` 与 `catch` 两条微任务链都跑完，再让事件循环转一圈收 unhandledRejection
        for (let i = 0; i < 5; i++) await Promise.resolve()
        await new Promise((r) => setImmediate(r))
      }
    } finally {
      process.off('unhandledRejection', onRejection)
    }
    expect(rejections, '清理回调的失败不得升级为 unhandled rejection').toEqual([])
  })

  it('超时计时器不得 unref（unref 后「唯一活跃 handle 就是它自己」会让进程静默退出）', async () => {
    // CodeRabbit PR#74 第二轮 major（实测成立）。⚠️ 为什么不是「起子进程看它退不退出」：
    // `unref` 是写死进库里的，测试进程只有 `tryOpen: () => new Promise(() => {})` 的两种
    // 情形 —— 留着 unref 时子进程 0.1s 就 **exit 0、零输出**；去掉后它会按超时**挂着**，
    // 测试分不清「计时器没触发」和「触发后进程就是不退」。所以把计时器创建包一层，
    // 直接断言「没有对超时计时器调用 unref」。
    // ⚠️ 只接管 `setTimeout`、不接管 `unref` 本身：`sleep` 自己也可能用 unref 计时器，
    // 全局改 `unref` 会连带判错。
    const offenders: Error[] = []
    const original = globalThis.setTimeout
    const patched = ((fn: (...a: never[]) => void, ms?: number, ...rest: never[]) => {
      const handle = original(fn, ms, ...rest)
      const stamp = new Error('创建于')
      handle.unref = function (this: typeof handle) {
        offenders.push(stamp)
        return handle
      }
      return handle
    }) as unknown as typeof setTimeout
    globalThis.setTimeout = patched
    try {
      // 真实计时器（不注入 sleep/now）：走的就是 withAttemptTimeout 的 setTimeout
      await expect(retryWithBackoff({
        tryOpen: () => new Promise(() => {}), isRetryable: () => true, maxMs: 40, attemptMs: 40,
      })).rejects.toMatchObject({ timedOut: true })
    } finally {
      globalThis.setTimeout = original
    }
    expect(offenders, '超时计时器在 finally 里就 clearTimeout 了，unref 省不下任何东西；'
      + '而在尝试不持有活跃 handle 时，unref 会让 Node 直接退出、超时永远不报').toEqual([])
  })
})