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
import { vi } from 'vitest'

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

let generation = 0
let installed = false
let fallback: Buf | undefined
const als = new AsyncLocalStorage<Buf>()

/** 只装一次 spy（之后的所有捕获共用），按异步上下文把写入分给发起它的那条捕获。 */
function install(): void {
  if (installed) return
  installed = true
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    const b = als.getStore() ?? fallback
    if (b) { b.writes += 1; b.out += String(chunk) }
    return true
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    const b = als.getStore() ?? fallback
    if (b) { b.err += String(chunk) }
    return true
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
