// tests/helpers/capture.ts
//
// 把 `process.stdout` / `process.stderr` 的写入装进**发起它的那条用例**的缓冲。
//
// ⚠️ 为什么需要（2026-11-13 审计）：27 个测试文件用模块级 `let out`（25 处 `let out = ''`、
// 1 处 `let out: string`、1 处与其他变量同一行声明）+ `beforeEach` 重置 +
// `vi.spyOn(process.stdout, 'write')` 的模式。重置挡住了
// 「上一条的输出漏进下一条」的**状态**，挡不住**写入方**：上一条超时/失败时，
// 它已发出、尚未 resolve 的异步调用（DuckDB 查询、`fetch`、定时器回调）会在
// 下一条开始之后才回来写 stdout —— 实测形态 `out="FRESHTAIL"`、`writes=2`。
//
// ⚠️ 归属按**异步上下文**判，不按「当前挂着的 spy」判（CodeRabbit 2026-11-13 major）：
// 延迟回调**在运行时才查** `process.stdout.write`，那时挂着的是**下一条**用例的 spy，
// 于是尾巴就算到下一条头上（实测 `writes=2`）。所以 spy 只装一次，写入按
// `AsyncLocalStorage` 里记录的**发起者**归账，与之后装了几层 spy 无关。
//
// ⚠️ 用例必须包在 `cap.run(fn)` 里：
//   it('…', () => cap.run(async () => { … }))       // cap = startCapture()
// 不包裹时没有异步归属，写入退回「当前活动捕获」，晚到的尾巴就会落到下一条上 ——
// 那种情况下这层隔离等于不存在（`capture.test.ts` 的变异用例钉着这一点）。
//
// ⚠️ 不要在断言路径里读 `vi.isMockFunction(process.stdout.write)`：2026-11-13 实测，
// 它在同一个文件里会把 spy 状态搅乱（探针自己被探针喂假信号）。要判就保存引用、
// 数调用次数。
import { AsyncLocalStorage } from 'node:async_hooks'
import { vi, afterAll } from 'vitest'

export interface Capture {
  readonly generation: number
  /** 这条捕获收到的写入次数。 */
  readonly writes: number
  readonly out: string
  readonly err: string
  /** 在这条捕获的异步上下文里跑 `fn`（整条用例）。返回 `fn` 的返回值（Promise 原样透传）。 */
  run<T>(fn: () => T): T
}

interface Buf { out: string; err: string; writes: number }

// ⚠️ 文件结束时恢复：同 file 的最后一条用例之后，spy 会留在 `process.stdout` 上，
// 而 vitest 2.1.9 默认 `restoreMocks:false` —— 后续测试文件的写入会被记进最后一个
// 捕获缓冲（Codex 2026-11-13 P2 实测）。`afterAll` 必须在**收集阶段**注册，
// 所以放在模块顶层而不是 `install()` 里。
afterAll(() => {
  vi.restoreAllMocks()
  activeSpy = undefined
})

let generation = 0
let fallback: Buf | undefined
let activeSpy: unknown
const als = new AsyncLocalStorage<Buf>()

/**
 * 确保 spy 已装上（所有捕获共用），按异步上下文把写入分给发起它的那条捕获。
 *
 * ⚠️ 判据是"现在挂在 `process.stdout.write` 上的是不是本助手装的那个"，不是一个
 * `installed` 布尔量：用户自己的 `afterEach(() => vi.restoreAllMocks())` 会把 spy
 * 摘掉，"装过"标志却仍是 true，下一条用例就会跳过安装、写入绕过缓冲
 * （CodeRabbit 2026-11-13 major；实测 `startCapture(); restoreAllMocks();
 * startCapture()` 后 `cap.out === ''`）。
 */
function install(): void {
  if (process.stdout.write === activeSpy) return
  // ⚠️ `write()` 的第三个参数可能是回调（`write(chunk, cb)` 或 `write(chunk, enc, cb)`，
  // Node 的 stream 契约是处理完 chunk 后调用它）。替身**必须**把它调掉（CodeRabbit
  // 2026-11-13 major）：否则 `cap.run(() => new Promise(r => process.stdout.write('X', r)))`
  // 永不 settle、那条用例只能超时失败。本仓库当前**没有**任何代码用回调式写入（已 grep），
  // 但助手是公共夹具，照着 Node 的契约实现比赌没人用更省事。
  const done = (args: unknown[]): boolean => {
    const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined
    if (cb) cb()
    return true
  }
  activeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
    const b = als.getStore() ?? fallback
    if (b) { b.writes += 1; b.out += String(args[0]) }
    return done(args)
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((...args: unknown[]) => {
    const b = als.getStore() ?? fallback
    if (b) { b.err += String(args[0]) }
    return done(args)
  })
}

/**
 * 开一条新捕获。句柄的 `out` / `err` / `writes` 是 getter，传进 `expect()` 后仍读最新值。
 *
 * ⚠️ 不挂 `onTestFinished` 恢复 spy：实测在 ALS 归属下恢复是**冗余**的 ——
 * 尾巴落回发起它的捕获（`capture.test.ts` 实测 `aWrites=1`、下一条 `writes=1`），
 * 中间隔几条用例也不串。多挂一个恢复只多一条会失效的机制。
 */
export function startCapture(): Capture {
  generation += 1
  const g = generation
  const buf: Buf = { out: '', err: '', writes: 0 }
  install()
  fallback = buf // 未包 run() 时的归属（退化路径，不是隔离）
  return Object.freeze({
    generation: g,
    get writes(): number { return buf.writes },
    get out(): string { return buf.out },
    get err(): string { return buf.err },
    run<T>(fn: () => T): T { return als.run(buf, fn) },
  })
}

/** 输出捕获当前是否仍挂着（`process.stdout.write` 还是本助手装的 spy）。 */
export function captureInstalled(): boolean {
  return activeSpy !== undefined && process.stdout.write === activeSpy
}
