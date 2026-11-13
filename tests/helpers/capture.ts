// tests/helpers/capture.ts
//
// 把 `process.stdout` / `process.stderr` 的写入装进**只属于当前用例**的缓冲，
// 并在用例结束时把 spy 恢复掉，使「晚到的异步尾巴」写不进下一条用例的缓冲。
//
// ⚠️ 为什么需要（2026-11-13 审计）：26 个测试文件用模块级 `let out = ''` +
// `beforeEach` 重置 + `vi.spyOn(process.stdout, 'write')` 的模式。重置挡住了
// 「上一条的输出漏进下一条」的**状态**，挡不住**写入方**：上一条超时/失败时，
// 它已发出、尚未 resolve 的异步调用（DuckDB 查询、`fetch`、定时器回调）会在
// 下一条开始之后才回来写 stdout —— 实测形态 `out="FRESHTAIL"`、`writes=2`。
//
// ⚠️ 必须在**用例体内**调用 `startCapture()`（`it('…', () => { const cap = startCapture(); … })`），
// **不能**放在 `beforeEach` 里（2026-11-13 实测）：vitest 2.1.9 的 `onTestFinished()`
// 用的是创建那一刻的 `getCurrentTest()`；在 `beforeEach` 里那是**上一条**用例（第一条时
// 根本没有），于是本用例的 spy 永远没有恢复钩子 —— 实测下一条用例开始前 `isMock= true`、
// 尾巴 `TAIL` 写进它的缓冲。同理，`beforeEach` 里建 spy 也会在前一条**未恢复**的 spy
// 之上再叠一层、谁都摘不掉。
//
// ⚠️ 驱动写入时用**保存下来的引用**（`const snap = process.stdout.write`），不要
// 在断言路径里反复读 `process.stdout.write` 的状态：实测 `vi.isMockFunction` 在这个
// 文件里会把 spy 状态搅乱（探针自己被探针喂假信号）。
//
// 超时本身仍由 vitest 的 `testTimeout` 负责；这里只管「超时之后别再污染」。
import { vi, onTestFinished } from 'vitest'

export interface Capture {
  readonly generation: number
  /** 这个世代收到的写入次数。 */
  readonly writes: number
  readonly out: string
  readonly err: string
}

let generation = 0

/**
 * 开一个新世代并返回只读句柄。`cap.out` / `cap.err` 是 getter —— 传进 `expect()`
 * 包装后仍读最新值。
 *
 * 自动挂 `onTestFinished(() => vi.restoreAllMocks())`，本用例结束（通过/失败/超时）
 * 后 spy 被恢复。与用户自己的 `afterEach(restoreAllMocks)` 并存无副作用。
 */
export function startCapture(): Capture {
  generation += 1
  const g = generation
  const s: { out: string; err: string; writes: number } = { out: '', err: '', writes: 0 }
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => { s.writes += 1; s.out += String(chunk); return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => { s.err += String(chunk); return true })
  onTestFinished(() => { vi.restoreAllMocks() })
  return Object.freeze({
    generation: g,
    get writes(): number { return s.writes },
    get out(): string { return s.out },
    get err(): string { return s.err },
  })
}
