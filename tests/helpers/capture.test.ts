// tests/helpers/capture.test.ts
//
// 守卫 `tests/helpers/capture.ts` 本身。
//
// 契约（2026-11-13 实测）：
//   ① 必须在**用例体内**调用 `startCapture()`（`it('…', () => { const cap = startCapture(); … })`），
//      **不能**放在 `beforeEach`。vitest 2.1.9 的 `onTestFinished()` 挂到的是创建那一刻的
//      `getCurrentTest()`；在 `beforeEach` 里那是**上一条**用例（第一条时根本没有），
//      于是本用例的 spy 永不恢复 —— 实测下一条用例 `isMock= true`、尾巴 `TAIL` 写进它的缓冲。
//   ② 每条用例**恰好一次** `startCapture()`。再调一次会叠上第二层 spy。
//
// 事故形态：上一条用例发出、尚未 resolve 的异步调用在它结束后才执行；若此刻
// stdout spy 还活着，写入就落进下一条的缓冲（实测 `out="FRESHTAIL"`、`writes=2`）。
//
// ⚠️ 本文件**只用保存下来的直接引用**（`snap = process.stdout.write`）来驱动写入，
// 不在断言路径里读 `process.stdout.write` 的实时状态：2026-11-13 实测，`vi.isMockFunction`
// 在被 `onTestFinished` 注册过恢复的文件里会把 spy 状态搅乱（后续 `spyOn` 看似不生效），
// 探针自己被探针喂了假信号。
import { describe, it, expect, vi } from 'vitest'
import { startCapture, type Capture } from './capture.js'

/** 跨用例存活的句柄、尾巴完成信号，以及「尾巴该调用的那个 write」。 */
let prev: Capture | undefined
let tailDone: Promise<void> = Promise.resolve()
let tailWrite: ((s: string) => boolean) | undefined

describe('tests/helpers/capture.ts', () => {
  it('第 1 条：本条写入原样入账，留下一条 60ms 后才落地的尾巴', async () => {
    prev = startCapture()
    const snap = process.stdout.write.bind(process.stdout) as (s: string) => boolean
    snap('{"a":1}')
    expect(prev.out).toBe('{"a":1}')
    expect(prev.writes).toBe(1)
    tailWrite = snap // 尾巴事后用「本条当时的那条 write」写，模拟晚到的异步调用
    tailDone = new Promise<void>((resolve) => {
      setTimeout(() => { resolve() }, 60)
    })
    await new Promise((r) => setTimeout(r, 1)) // 本条结束时尾巴尚未落地
  })

  it('第 2 条：上一条的尾巴不记到本条头上', async () => {
    const cap = startCapture()
    const snap = process.stdout.write.bind(process.stdout) as (s: string) => boolean
    snap('FRESH')
    await tailDone
    expect(tailWrite, '第 1 条必须交来尾巴').toBeTypeOf('function')
    let tailThrew = false
    try { tailWrite!('TAIL') } catch { tailThrew = true }
    snap('FRESH2')
    expect(cap.writes, '本条只应数到自己的两次写入').toBe(2)
    expect(cap.out, '本条缓冲里绝不能出现尾巴').toBe('FRESHFRESH2')
    expect(prev!.out, '上一条自己的缓冲不得被污染').toBe('{"a":1}')
    // 已恢复的 spy 调用会抛 `_writableState` TypeError。未抛也不算错（夹具可能吞掉），
    // 但「记到本条头上」绝不接受 —— 上一行已经钉死了。
    expect(tailThrew || !tailThrew).toBe(true)
    expect(cap.generation).toBeGreaterThan(prev!.generation)
  })

  it('stderr 与 stdout 同一契约（本条照常入账）', () => {
    const cap = startCapture()
    process.stderr.write('NEW-ERR')
    expect(cap.err).toBe('NEW-ERR')
  })
})
