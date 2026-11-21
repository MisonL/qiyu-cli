// 只有锁报文算 CONFLICT；失败收尾保留原始错误，并在交回前确认 close 或明确报告未确认。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { accessSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { lockVerdict, spawnLockHolder, seedEmptyDb, LOCK_BUDGET_MS, CLOSE_GRACE_MS, PKG_URL } from './lock-holder.js'

// 只把 `spawn` 换成可预置替身的薄壳，其余 child_process 能力保持真实。
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: vi.fn(actual.spawn) }
})
const realSpawn = (await vi.importActual<typeof import('node:child_process')>('node:child_process')).spawn
const spawnMock = vi.mocked(spawn)

type RealChild = { child: ChildProcess; closed: boolean; close: Promise<void> }
let dir = ''
let realChildren: RealChild[] = []
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-lockfix-'))
  realChildren = []
  spawnMock.mockReset().mockImplementation((...args: Parameters<typeof realSpawn>) => {
    const child = realSpawn(...args)
    const run: RealChild = { child, closed: false, close: Promise.resolve() }
    run.close = new Promise<void>((resolve) => {
      child.once('close', () => { run.closed = true; resolve() })
    })
    realChildren.push(run)
    return child
  })
})
/**
 * 逐个收尾、**全部试过**再抛第一个错误（CR 第五十二轮 major #12）：`await closeRealChild` 抛错
 * （5000ms 内未确认 close）时，裸循环会中断、后面那些子进程漏掉，可能拖住进程退出。
 */
async function closeAll<T>(runs: readonly T[], closeOne: (r: T) => Promise<void>): Promise<unknown[]> {
  const errs: unknown[] = []
  for (const run of runs) {
    try { await closeOne(run) } catch (e) { errs.push(e) }
  }
  return errs
}
/**
 * afterEach 的收尾决定（CR 第五十四轮 major #13）：只有**全部子进程 close 都已确认**才删夹具
 * 目录 —— close 未确认说明那个进程可能仍占着库文件，删掉目录就把排查证据一起丢了。
 */
function finishFixtureCleanup(fixtureDir: string,
  errors: readonly unknown[]): { removeDir: boolean; failure?: Error } {
  if (errors.length === 0) return { removeDir: true }
  return {
    removeDir: false,
    failure: new Error(`子进程收尾未确认 close（可能仍活着），保留夹具目录 ${fixtureDir}：${String(errors[0])}`,
      { cause: errors[0] }),
  }
}
afterEach(async () => {
  if (vi.isFakeTimers()) vi.clearAllTimers()
  vi.useRealTimers()
  const cleanupErrors = await closeAll(realChildren, closeRealChild)
  const plan = finishFixtureCleanup(dir, cleanupErrors)
  if (plan.removeDir) rmSync(dir, { recursive: true, force: true })
  if (plan.failure !== undefined) throw plan.failure
})

async function closeRealChild(run: RealChild): Promise<void> {
  if (run.closed) return
  let timer: ReturnType<typeof setTimeout> | undefined
  run.child.on('error', () => {})
  try {
    const closed = Promise.race([
      run.close,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('测试 cleanup 在 5000ms 内未确认 close')), 5_000)
      }),
    ])
    run.child.kill('SIGKILL')
    await closed
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

type Fixture = 'holder' | 'seed' | 'verdict'
const fixtures: Fixture[] = ['holder', 'seed', 'verdict']
const BUDGET = 100
function invoke(fixture: Fixture, deadline: number): Promise<unknown> {
  const dbPath = join(dir, 'q.db')
  if (fixture === 'holder') return spawnLockHolder({ dbPath, scriptDir: dir, deadline })
  if (fixture === 'seed') return seedEmptyDb(dbPath, dir, deadline)
  return lockVerdict(dbPath, dir, deadline)
}
function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(), stderr: new PassThrough(), pid: 1234,
    exitCode: null, signalCode: null, killed: false, kill: vi.fn(() => true),
  }) as unknown as ChildProcess
}

// 先接住结果再驱动事件；断言 settled 后才 await，失败实现也不会让测试无界等待。
function observe<T>(promise: Promise<T>) {
  let settled = false
  const result = promise.then(
    (value) => { settled = true; return { value } },
    (error: unknown) => { settled = true; return { error } },
  )
  return { result, isSettled: () => settled }
}
/** 夹具可保留一个「迟到的 error」兜底监听；只要求它不再持有 exit/close/data 或计时器。 */
function expectClean(child: ChildProcess) {
  expect(vi.getTimerCount(), '夹具不得遗留定时器').toBe(0)
  expect(child.listenerCount('exit'), '夹具不得遗留 exit 监听').toBe(0)
  expect(child.listenerCount('close'), '夹具不得遗留 close 监听').toBe(0)
  expect(child.stdout?.listenerCount('data')).toBe(0)
  expect(child.stderr?.listenerCount('data')).toBe(0)
}
function swallowOn(child: ChildProcess): void {
  child.on('error', () => {})
}

describe('锁夹具的子进程生命周期', () => {
  it('finishFixtureCleanup：close 未确认时保留目录并交回带路径的失败', () => {
    const kept = finishFixtureCleanup('/tmp/fixture-x', [new Error('5000ms 内未确认 close')])
    expect(kept.removeDir, 'close 未确认不得删目录（可能仍被占用）').toBe(false)
    expect(String(kept.failure), '失败文案要带目录路径供排查').toContain('/tmp/fixture-x')
    expect(finishFixtureCleanup('/tmp/fixture-y', []), '全部确认 close 才删').toEqual({ removeDir: true })
  })

  it('closeAll：一个子进程收尾抛错不得中断其余子进程的收尾', async () => {
    const seen: string[] = []
    const errs = await closeAll(['a', 'b', 'c'] as const, async (r) => {
      seen.push(r)
      if (r === 'a') throw new Error('a 收尾失败')
      return
    })
    expect(seen, '每个子进程都要尝试').toEqual(['a', 'b', 'c'])
    expect(errs, '错误交回调用方，不在这里吞').toHaveLength(1)
  })

  let child: ChildProcess
  beforeEach(() => {
    vi.useFakeTimers({ now: 0 })
    child = fakeChild()
    spawnMock.mockReturnValueOnce(child)
  })

  it.each(fixtures)('%s：预算已耗尽 → 不 spawn、不写脚本，响亮报「预算已耗尽」（CR 第六十二轮 major）', async (fixture) => {
    // 事故：deadline 已过去时三个入口仍会写脚本并起子进程（负数预算），子进程先去
    // create/modify 数据库，到点才被 kill —— 失败文案还会伪装成「未就绪」。入口先判预算。
    const running = observe(invoke(fixture, -1))   // 假时钟 now=0，deadline=-1 已过期
    await vi.advanceTimersByTimeAsync(0)
    expect(spawnMock, '预算耗尽不得再起子进程').not.toHaveBeenCalled()
    expect(running.isSettled(), '预算耗尽必须立即交回，不留无界等待').toBe(true)
    const result = await running.result
    expect('error' in result ? String(result.error) : '', '必须点名预算已耗尽').toMatch(/预算已耗尽|预算过期|deadline/)
  })

  it.each(fixtures)('%s：未启动进程的 spawn error 不裸抛，原错误原样交回', async (fixture) => {
    Object.assign(child, { pid: undefined })
    swallowOn(child)
    const running = observe(invoke(fixture, 1_000_000))
    const original = Object.assign(new Error('spawn … EACCES'), { code: 'EACCES', syscall: 'spawn …' })
    expect(() => child.emit('error', original), '没有 error 监听者 = 未捕获异常带走进程').not.toThrow()
    await vi.advanceTimersByTimeAsync(100)
    // ⚠️ error 不等于 stdio 已关（CR 第六十二轮 major）：Node 在 spawn 失败后仍会发 close。
    expect(running.isSettled(), 'close 未确认前不得交回（调用方可能已开始删目录）').toBe(false)
    child.emit('close', -2, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    const result = await running.result
    expect('error' in result ? result.error : undefined, 'close 已确认 → 保留原始 spawn 错').toBe(original)
    expect(child.kill, '没有 PID 不该发信号').not.toHaveBeenCalled()
    expectClean(child)
  })

  it.each(fixtures)('%s：未启动进程收不到 error，100ms 哨兵明确失败', async (fixture) => {
    Object.assign(child, { pid: undefined })
    swallowOn(child)
    const running = observe(invoke(fixture, 1_000_000))
    await vi.advanceTimersByTimeAsync(99)
    expect(running.isSettled(), '哨兵未到前不得交回').toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    for (let i = 0; i < 10 && !running.isSettled(); i++) await Promise.resolve()
    // ⚠️ 哨兵只负责把「没等到 error」记成原生错误；close 未确认仍守有界宽限（CR 第六十二轮 major）。
    expect(running.isSettled(), '哨兵到点、close 未到 → 继续等有界宽限').toBe(false)
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
    expect(running.isSettled(), '宽限到点必须交回，不留无界等待').toBe(true)
    const result = await running.result
    const error = 'error' in result ? result.error : undefined
    expect(error).toBeInstanceOf(Error)
    expect(String(error), '必须点名「没等到 error 事件」，不能静默').toMatch(/未收到 error 事件/)
    expect(String(error), '同时说清 close 未确认').toMatch(/close/)
    expectClean(child)
  })

  it('holder：超时请求 SIGKILL 后，exit 不能代替 close', async () => {
    const running = observe(invoke('holder', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET)
    expect(child.kill).toHaveBeenCalledTimes(1)
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(running.isSettled(), 'close 前调用者不得开始重试或删目录').toBe(false)
    child.emit('exit', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled(), 'exit 不表示 stdio 已关闭').toBe(false)
    child.emit('close', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    expect('error' in await running.result ? 'error' : 'ok', 'close 已确认时按超时报错').toBe('error')
    expectClean(child)
  })

  it('seed：超时请求 SIGKILL 后，exit 不能代替 close', async () => {
    const running = observe(invoke('seed', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET)
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('exit', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled(), 'exit 不表示 stdio 已关闭').toBe(false)
    child.emit('close', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    expect('error' in await running.result).toBe(true)
    expectClean(child)
  })

  it('verdict：超时请求 SIGKILL 后，exit 不能代替 close，close 后才报 TIMEOUT', async () => {
    const running = observe(invoke('verdict', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET)
    expect(child.kill).toHaveBeenCalledTimes(1)
    child.emit('exit', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled(), 'exit 不表示 stdio 已关闭').toBe(false)
    child.emit('close', null, 'SIGKILL')
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    expect(await running.result).toEqual({ value: 'TIMEOUT' })
    expectClean(child)
  })

  it('seed：预算耗尽后才 close（即便 exit 0）不算成功 —— 那次 close 是清理的结果，不是按时完成', async () => {
    // CR 第五十轮 major：`waitClosed` 在预算到点后请求 kill、再等宽限；若 kill 未被受理
    // （返回 false）而进程随后自己以 0 退出，旧实现返回成功 —— 但「按时建好库」这件事
    // 已经无法成立，调用方拿到的成功是**预算过期后的清理结果**，不是种子完成。
    vi.mocked(child.kill).mockReturnValue(false)
    const running = observe(invoke('seed', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET)
    expect(running.isSettled(), '预算刚到时还没 close，不能提前交结论').toBe(false)
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    const result = await running.result
    expect('error' in result, 'exit 0 不得把过期的种子变成成功').toBe(true)
    if ('error' in result) {
      expect((result.error as Error).message, '必须点名预算').toMatch(/预算/)
      expect((result.error as Error).message, '必须说清 exit 0 不足以证明按时完成').toMatch(/exit|退出/)
    }
    expectClean(child)
  })

  it.each(fixtures)('%s：kill 返回 false 但随后 close，仍以真实 close 为准', async (fixture) => {
    vi.mocked(child.kill).mockReturnValue(false)
    const running = observe(invoke(fixture, BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET)
    expect(running.isSettled()).toBe(false)
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    const result = await running.result
    if (fixture === 'verdict') expect(result).toEqual({ value: 'TIMEOUT' })
    expectClean(child)
  })

  it.each(fixtures)('%s：已启动进程就绪前 exit、close 未到 → 失败收尾仍等真实 close', async (fixture) => {
    // ⚠️ 变异杀手（第四个 agent 的 M5 未覆盖项）：把 `settleFailure()` 用 `exit !== null`
    // 提前短路，全量测试曾仍绿 —— 因为就绪前失败的既有用例用的假子进程都没有 pid（走
    // `waitSpawnError`），触达不到这条短路。这里是**已启动**（pid 有值）的进程：exit 已到、
    // close 未到，失败收尾必须先等真实 close，否则调用方会在 stdio 仍开着时删目录/换轮。
    const running = observe(invoke(fixture, BUDGET))
    await vi.advanceTimersByTimeAsync(10)
    child.emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled(), 'exit 不是终态').toBe(false)
    await vi.advanceTimersByTimeAsync(BUDGET)  // 预算耗尽 → 进入失败收尾
    expect(running.isSettled(), 'close 未到前失败收尾不得交回').toBe(false)
    child.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    // verdict 的「预算耗尽 + close 已确认」结论是 TIMEOUT（既有语义），其余两条是错误。
    if (fixture === 'verdict') expect(await running.result).toEqual({ value: 'TIMEOUT' })
    else expect('error' in await running.result ? 'error' : 'ok', '失败收尾照旧交回错误').toBe('error')
    expectClean(child)
  })

  it('holder：kill 受理但 5000ms 内没有 close → 响亮失败并点名 close 缺失', async () => {
    const running = observe(invoke('holder', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET + 4_999)
    expect(running.isSettled(), '宽限未到不得提前判死').toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(running.isSettled(), '不许为等 close 引入无上界等待').toBe(true)
    const error = (await running.result) as { error?: Error }
    expect(error.error).toBeInstanceOf(Error)
    expect(String(error.error)).toMatch(/close/)
    expect(String(error.error)).toContain('kill 返回 true')
    // ⚠️ **close 未确认时调用方拿不到句柄**：pid 必须在文案里（CR 第五十二轮 major #13）——
    // 只报「未就绪 / close 缺失」等于把可能仍活着的进程藏起来。
    expect(String(error.error), 'close 未确认必须点名 pid').toMatch(/pid 1234/)
    expectClean(child)
  })

  it('seed：kill 受理但 5000ms 内没有 close → 响亮失败并点名 close 缺失', async () => {
    const running = observe(invoke('seed', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET + 5_000)
    expect(running.isSettled()).toBe(true)
    const error = (await running.result) as { error?: Error }
    expect(String(error.error)).toMatch(/close/)
    expect(String(error.error)).toContain('kill 返回 true')
    expectClean(child)
  })

  it('verdict：kill 受理但 5000ms 内没有 close → 不报 TIMEOUT，响亮失败', async () => {
    const running = observe(invoke('verdict', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET + 5_000)
    expect(running.isSettled()).toBe(true)
    const error = (await running.result) as { error?: Error }
    expect(error.error, 'close 未确认时 verdict 不得报 TIMEOUT').toBeInstanceOf(Error)
    expect(String(error.error)).toMatch(/close/)
    expect(String(error.error)).toContain('kill 返回 true')
    // 调用方拿不到句柄 → 可能仍活着的进程只能靠文案里的 pid 处理（CR 第五十四轮 major #9）
    expect(String(error.error), 'close 未确认必须点名 pid').toMatch(/pid 1234/)
    expectClean(child)
  })

  it('verdict：kill 抛 EPERM 且没有 close → 必须说「无法确认已放开库文件」，EPERM 挂在 cause（CR 第四十七轮 major）', async () => {
    // 旧实现先抛原生错误：调用方只看到 EPERM，不知道子进程可能还开着库文件 ——
    // 换轮 / 删目录都可能与活着的进程撞上。
    const original = Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' })
    vi.mocked(child.kill).mockImplementation(() => { throw original })
    swallowOn(child)
    const running = observe(invoke('verdict', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET + 5_000)
    expect(running.isSettled(), '宽限耗尽必须交回结论').toBe(true)
    const err = (await running.result as { error?: Error & { cause?: unknown } }).error
    expect(err, '必须是「close 未确认」的合成错误，不是裸 EPERM').toBeInstanceOf(Error)
    expect(err!.message).toMatch(/无法确认|close/)
    expect(err!.cause, '原生错误保留在 cause 上').toBeInstanceOf(Error)
    expect((err!.cause as Error).message).toMatch(/EPERM/)
    expectClean(child)
  })

  it('holder：kill 未被受理且没有 close → 错误里 kill 与 close 分开说', async () => {
    vi.mocked(child.kill).mockReturnValue(false)
    const running = observe(invoke('holder', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET + 5_000)
    expect(running.isSettled()).toBe(true)
    const error = (await running.result) as { error?: Error }
    expect(String(error.error), 'kill 没送出去必须如实说').toContain('kill 返回 false')
    expect(String(error.error)).toMatch(/close/)
    expectClean(child)
  })

  it('verdict：kill 未被受理且没有 close → 错误里 kill 与 close 分开说', async () => {
    vi.mocked(child.kill).mockReturnValue(false)
    const running = observe(invoke('verdict', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET + 5_000)
    expect(running.isSettled()).toBe(true)
    const error = (await running.result) as { error?: Error }
    expect(String(error.error)).toContain('kill 返回 false')
    expect(String(error.error)).toMatch(/close/)
    expectClean(child)
  })

  it('seed：kill 未被受理且没有 close → 错误里 kill 与 close 分开说', async () => {
    vi.mocked(child.kill).mockReturnValue(false)
    const running = observe(invoke('seed', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET + 5_000)
    expect(running.isSettled()).toBe(true)
    const error = (await running.result) as { error?: Error }
    expect(String(error.error)).toContain('kill 返回 false')
    expect(String(error.error)).toMatch(/close/)
    expectClean(child)
  })

  it.each(fixtures)('%s：spawn error 已到但 close 未到 → 有界等待后报「清理未确认」，原始错误挂 cause（CR 第六十二轮 major）', async (fixture) => {
    Object.assign(child, { pid: undefined })
    swallowOn(child)
    const running = observe(invoke(fixture, 1_000_000))
    const original = Object.assign(new Error('spawn … ENOENT'), { code: 'ENOENT' })
    child.emit('error', original)
    await vi.advanceTimersByTimeAsync(100)
    expect(running.isSettled(), 'close 未到不得交回原始错误').toBe(false)
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
    expect(running.isSettled(), '宽限到点必须交回').toBe(true)
    const result = await running.result
    const error = 'error' in result ? result.error : undefined
    // 未确认清理：不能把原始错误当「已收尾」交回（调用方会据此删目录），但原错误不丢。
    expect(error, 'close 未确认 → 交回合成错误，不冒充原始错误').not.toBe(original)
    // cause 链上必须找得到原始错误（各入口包层数不同：verdict 有一层夹具失败包层）。
    const causeChainHas = (e: unknown, target: unknown): boolean => {
      let x: unknown = e
      for (let i = 0; i < 4 && x !== undefined && x !== null; i++) {
        if (x === target) return true
        x = (x as { cause?: unknown }).cause
      }
      return false
    }
    expect(causeChainHas((error as { cause?: unknown }).cause, original), '原始错误在 cause 链上').toBe(true)
    expect(String(error), '必须说清 close 未确认').toMatch(/close/)
    expect(child.kill, '没有 PID 不该发信号').not.toHaveBeenCalled()
    expectClean(child)
  })

  for (const fixture of fixtures) {
    for (const source of ['throw', 'event'] as const) {
      it(`${fixture}：kill 的 ${source} 原始错误不得被吞为 TIMEOUT`, async () => {
        const original = Object.assign(new Error('kill EPERM'), { code: 'EPERM', syscall: 'kill' })
        vi.mocked(child.kill).mockImplementation(() => {
          if (source === 'throw') throw original
          child.emit('error', original)
          return false
        })
        swallowOn(child)
        const running = observe(invoke(fixture, BUDGET))
        await vi.advanceTimersByTimeAsync(BUDGET)
        expect(running.isSettled()).toBe(false)
        child.emit('close', null, 'SIGKILL')
        await vi.advanceTimersByTimeAsync(0)
        expect(running.isSettled()).toBe(true)
        const result = await running.result
        expect('error' in result ? result.error : undefined).toBe(original)
        expectClean(child)
      })
    }
  }

  it.each(['holder', 'seed'] as const)('%s：就绪前 exit 也等 close，并保留最后的 stderr', async (fixture) => {
    const running = observe(invoke(fixture, 1_000_000))
    child.emit('exit', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled(), 'exit 不是 close').toBe(false)
    child.stderr?.emit('data', '绑定加载失败')
    child.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    const result = await running.result
    expect(String('error' in result ? result.error : '')).toContain('绑定加载失败')
    expect(child.kill).not.toHaveBeenCalled()
    expectClean(child)
  })

  it('收尾后迟到的 error 不得冒成未捕获异常', async () => {
    Object.assign(child, { pid: undefined })
    const running = observe(invoke('verdict', 1_000_000))
    child.emit('error', Object.assign(new Error('spawn … EACCES'), { code: 'EACCES' }))
    await vi.advanceTimersByTimeAsync(100)
    await vi.advanceTimersByTimeAsync(CLOSE_GRACE_MS)
    await running.result
    // 夹具必须把「调用方已拿到结果之后到达的原生错误」兜住，而不是让它抛穿测试进程。
    expect(() => child.emit('error', new Error('late error after settle'))).not.toThrow()
    expectClean(child)
  })

  it('holder：deadline 已过时 marker 立即可见也不算就绪（CR 第五十四轮 major #7）', async () => {
    // 事故形态：截止定时器到点仍去读「此刻是否就绪」—— 在高负载下定时器本身会迟到，一条
    // **截止之后**才到达的 marker 因此被当成就绪。判据：就绪必须被观察到**在 deadline 之内**。
    // ⚠️ 预算在入口内（spawn 前）判（CR 第六十二轮 major）—— 这里让子进程**在预算内启动**，
    // 再推进时间越过 deadline，迟到的 marker 仍然不算就绪。
    const running = observe(invoke('holder', BUDGET))
    await vi.advanceTimersByTimeAsync(BUDGET + 1)
    child.stdout?.emit('data', 'locked\n')
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled(), '失败收尾要等真实 close').toBe(false)
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    expect('error' in await running.result, '过期后的就绪不算就绪').toBe(true)
    expectClean(child)
  })

  it('seed：close 在 deadline 之后才被看到（过期定时器还没跑）也不算按时完成（CR 第五十五轮 major）', async () => {
    // 事故形态：截止定时器在高负载下迟到；close 事件先被处理，`waitOne` 以「已 close」直接
    // 返回 true —— 从未请求过终止，种子以 exit 0 被当成「按时建好」。判据必须比较**看到 close
    // 的时刻**与 deadline，而不是只问「最终是否 close」。
    vi.mocked(child.kill).mockReturnValue(false)
    const running = observe(invoke('seed', BUDGET))
    vi.setSystemTime(BUDGET + 1)      // 时钟越过 deadline，但定时器回调尚未运行
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled(), '迟到 close 也必须交回结论').toBe(true)
    const result = await running.result
    expect('error' in result, 'exit 0 + 迟到 close 不得算按时完成').toBe(true)
    if ('error' in result) {
      expect((result.error as Error).message, '点名「预算之外才 close」').toMatch(/预算/)
    }
    expectClean(child)
  })

  it('verdict：close 迟到于 deadline → 按 TIMEOUT，不报 OPENED（CR 第五十五轮 major）', async () => {
    const running = observe(invoke('verdict', BUDGET))
    child.stdout?.emit('data', JSON.stringify({ v: 'OPENED' }) + '\n')
    vi.setSystemTime(BUDGET + 1)
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    expect(await running.result, '过期后才 close 的结论不是按时完成').toEqual({ value: 'TIMEOUT' })
    expectClean(child)
  })

  it('holder：分块到达的 marker 就绪后交回仍存活的 child', async () => {
    const running = observe(invoke('holder', 1_000_000))
    child.stdout?.emit('data', 'loc')
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(false)
    child.stdout?.emit('data', 'ked\n')
    await vi.advanceTimersByTimeAsync(50)
    expect(running.isSettled()).toBe(true)
    expect(await running.result).toEqual({ value: child })
    expect(child.kill).not.toHaveBeenCalled()
    expectClean(child)
  })

  it('holder：没有换行收尾的 "locked" 不算就绪（半行可能接着变成 locked-failed）（CR 第六十三轮 major）', async () => {
    // 事故：`split('\n')` 的最后一段是没有换行收尾的半行。stdout 先发 `locked`、稍后发
    // `-failed\n` 时，第一块就被 `trim() === marker` 当成完整一行 —— 用例拿一个启动失败、
    // 从未拿到锁的 holder 当「锁已持有」。判据：只认换行收尾的整行。
    const running = observe(invoke('holder', BUDGET))
    child.stdout?.emit('data', 'locked')
    await vi.advanceTimersByTimeAsync(60)
    expect(running.isSettled(), '未换行收尾的半行不得当成就绪').toBe(false)
    child.stdout?.emit('data', '\n')
    await vi.advanceTimersByTimeAsync(60)
    expect(running.isSettled(), '换行补上后才是完整一行').toBe(true)
    expect(await running.result).toEqual({ value: child })
    expectClean(child)
  })

  it('holder：stderr 上出现含 "locked" 的报错路径 → **不得**当成就绪（只认 stdout 的完整一行）（CR 第四十二轮 major）', async () => {
    // 事故：就绪探测搜的是 stdout+stderr 合并串。一条启动失败（例如打不开
    // `/tmp/locked/q.db`）把 `locked` 带进 stderr，探测立刻返回一个**从未拿到锁**的
    // holder —— 撞锁用例随后拿它当「锁已持有」，把夹具失败当成锁生效放行。
    const running = observe(invoke('holder', BUDGET))
    child.stderr?.emit('data', 'Error: 无法打开 /tmp/locked/q.db\n')
    await vi.advanceTimersByTimeAsync(50)
    expect(running.isSettled(), 'stderr 里的路径不是就绪信号').toBe(false)
    child.stdout?.emit('data', 'locked\n')
    await vi.advanceTimersByTimeAsync(50)
    expect(running.isSettled(), 'stdout 的完整一行才是就绪信号').toBe(true)
    expect(await running.result).toEqual({ value: child })
    expectClean(child)
  })

  it('holder：先打印 locked、随后立刻退出 → **不得**当成就绪（返回的是个死进程）（CR 第四十四轮 major）', async () => {
    // 事故：`onClose` 与轮询都以「stdout 里有 marker」为准，不看进程是否已结束 —— 一个
    // 打印了 `locked` 然后退出（例如语句成功、随后 setInterval 没挂住 / 句柄被关）的子进程
    // 会让 spawnLockHolder 返回**已经死掉**的 holder，调用方以为锁还持着，继续校验与断言。
    const running = observe(invoke('holder', BUDGET))
    child.stdout?.emit('data', 'locked\n')
    child.emit('exit', 0, null)
    // ⚠️ 只 emit `exit`、**不** emit `close`：轮询自己必须拒绝，不能指望 close 回调兜底
    // （否则判据仍然只有「输出里有 marker」，进程一死就返回死 holder）。
    await vi.advanceTimersByTimeAsync(60)
    expect(running.isSettled(), '不能把已退出的进程当作就绪返回').toBe(false)
    // 失败收尾照旧等真实 close：业务预算（100ms）耗尽后进 settleFailure，再给 CLOSE_GRACE_MS 宽限。
    await vi.advanceTimersByTimeAsync(6_000)
    const result = await running.result
    expect('error' in result ? 'error' : 'ok', '进程已退出就不存在「持有锁」这回事').toBe('error')
    expect(String((result as { error?: Error }).error), '失败原因必须点名「就绪 / close 未确认」')
      .toMatch(/未就绪|close/)
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expectClean(child)
  })

  it('seed：exit 0 之后等到 close 才成功', async () => {
    const running = observe(invoke('seed', 1_000_000))
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(false)
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    expect(await running.result).toEqual({ value: undefined })
    expectClean(child)
  })

  it.each([
    { label: 'OPENED', output: { v: 'OPENED' }, want: 'OPENED' },
    {
      label: 'macOS 锁报文',
      output: { v: 'ERROR', msg: 'IO Error: Could not set lock on file "/tmp/x/q.db": Conflicting lock is held in /Users/x/.nvm/versions/node/v24/bin/node (PID 83991) by user x. See also https://duckdb.org/docs/stable/connect/concurrency' },
      want: 'CONFLICT',
    },
    {
      label: 'Linux fixture 形态（既有测试字符串，不是 Linux 实跑）',
      output: { v: 'ERROR', msg: 'IO Error: Could not set lock on file "/tmp/x/q.db": Conflicting lock is held in /opt/hostedtoolcache/node/24.22.1/x64/bin/node (PID 4894). See also https://duckdb.org/docs/stable/connect/concurrency' },
      want: 'CONFLICT',
    },
  ])('verdict：$label 只在 close 后交回 $want', async ({ output, want }) => {
    const running = observe(invoke('verdict', 1_000_000))
    child.stdout?.emit('data', `非 JSON 日志\n${JSON.stringify(output)}\n`)
    child.emit('exit', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(false)
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    expect(await running.result).toEqual({ value: want })
    expectClean(child)
  })

  it('verdict：非锁 ERROR 明确失败，不返回 CONFLICT/OPENED/TIMEOUT', async () => {
    const running = observe(invoke('verdict', 1_000_000))
    const msg = 'IO Error: Cannot open file "/tmp/missing/q.db": No such file or directory'
    child.stdout?.emit('data', `${JSON.stringify({ v: 'ERROR', msg })}\n`)
    child.emit('close', 0, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    const result = await running.result
    expect(String('error' in result ? result.error : '')).toContain(msg)
    expect(String('error' in result ? result.error : '')).toMatch(/夹具或环境问题/)
    expectClean(child)
  })

  it.each([
    { label: '信号终止（OOM / 外部 kill 形态）', exit: null as null | number, signal: 'SIGKILL' as NodeJS.Signals, want: /未正常结束.*signal=SIGKILL/ },
    { label: '非零退出', exit: 1 as null | number, signal: null as null | NodeJS.Signals, want: /未正常结束.*exit=1/ },
  ])('verdict：$label 时写了结论也不得接受那条 JSON', async ({ exit, signal, want }) => {
    // CR 第六十五轮 major：close 只证明 stdio 关了，不证明校验器跑完。结论行先落 stdout、
    // 进程随后被信号杀死时，接受 OPENED/CONFLICT 会让用例基于一个失败的校验器通过。
    const running = observe(invoke('verdict', 1_000_000))
    child.stdout?.emit('data', `${JSON.stringify({ v: 'OPENED' })}\n`)
    child.emit('close', exit, signal)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    const result = await running.result
    expect(String('error' in result ? result.error : '')).toMatch(want)
    expectClean(child)
  })

  it('verdict：没有 JSON 结论时点名 stdout/stderr，不吞成竞态', async () => {
    const running = observe(invoke('verdict', 1_000_000))
    child.stdout?.emit('data', '不是 JSON')
    child.stderr?.emit('data', '脚本加载失败')
    child.emit('close', 1, null)
    await vi.advanceTimersByTimeAsync(0)
    expect(running.isSettled()).toBe(true)
    const result = await running.result
    // 无结论优先于 exit 闸门：退出状态也要点名（非零退出本身解释不了「为什么没结论」）。
    expect(String('error' in result ? result.error : '')).toMatch(/未交回结论.*exit=1.*不是 JSON.*脚本加载失败/)
    expectClean(child)
  })
})

describe('真实子进程端到端', () => {
  // OS 拒 spawn 的真实形态（不 mock spawn 本身）：execPath 指向不存在的可执行文件，
  // Node 发 `error`（ENOENT）而非 exit/close。夹具必须原样交回这条错误、不裸抛。
  it.each(fixtures)('%s：真实 ENOENT 原样交回，且测试进程不被未捕获 error 带走', async (fixture) => {
    const descriptor = Object.getOwnPropertyDescriptor(process, 'execPath')!
    Object.defineProperty(process, 'execPath', { value: join(dir, 'no-such-node'), configurable: true })
    try {
      const err = await invoke(fixture, Date.now() + 10_000).then(() => null, (e: unknown) => e)
      expect(err, 'OS 拒绝 spawn 不得被吞成锁竞态/普通超时').toBeInstanceOf(Error)
      expect((err as NodeJS.ErrnoException).code, '必须原样交回 ENOENT，不得换二手归因').toBe('ENOENT')
      // 本机实测 ENOENT 形态为 `error` → `close(-2)`；紧接之后 close 必然到（不是无限等）。
      for (const run of realChildren) await closeRealChild(run)
      expect(realChildren.every((run) => run.closed), '失败的子进程不得留在未 close 状态').toBe(true)
    } finally {
      Object.defineProperty(process, 'execPath', descriptor)
    }
  })

  it('父目录不存在 → 保留 DuckDB 原始非锁报文', { timeout: LOCK_BUDGET_MS + 60_000 }, async () => {
    accessSync(PKG_URL)
    const p = join(dir, 'missing', 'q.db')
    const err = await lockVerdict(p, dir, Date.now() + LOCK_BUDGET_MS).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/Cannot open file|No such file/)
    expect((err as Error).message).toMatch(/夹具或环境问题/)
    expect(realChildren.every((run) => run.closed)).toBe(true)
  })

  it.each(['READ_WRITE', 'READ_ONLY'] as const)('$0：seed/marker → CONFLICT → 真 close → OPENED', { timeout: LOCK_BUDGET_MS + 60_000 }, async (accessMode) => {
    accessSync(PKG_URL)
    const deadline = Date.now() + LOCK_BUDGET_MS
    const dbPath = join(dir, 'q.db')
    if (accessMode === 'READ_ONLY') {
      await seedEmptyDb(dbPath, dir, deadline)
      expect(realChildren.at(-1)?.closed, 'seed 必须已 close 才交回').toBe(true)
    } else {
      expect(await lockVerdict(dbPath, dir, deadline)).toBe('OPENED')
      expect(realChildren.at(-1)?.closed).toBe(true)
    }
    const holder = await spawnLockHolder({ dbPath, scriptDir: dir, deadline, accessMode })
    const holderRun = realChildren.find((run) => run.child === holder)!
    expect(holderRun.closed, 'marker 就绪时应仍持有跨进程锁').toBe(false)
    expect(await lockVerdict(dbPath, dir, deadline)).toBe('CONFLICT')
    expect(realChildren.at(-1)?.closed, 'verdict 必须已 close 才交回').toBe(true)
    await closeRealChild(holderRun)
    expect(holderRun.closed).toBe(true)
    expect(await lockVerdict(dbPath, dir, deadline)).toBe('OPENED')
    expect(realChildren.every((run) => run.closed)).toBe(true)
  })
})
