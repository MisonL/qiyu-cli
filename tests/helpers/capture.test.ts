// tests/helpers/capture.test.ts
//
// 守卫 `tests/helpers/capture.ts` 本身。事故形态（2026-11-13 实测）：
// 上一条用例发出、尚未 resolve 的异步调用在它结束后才执行，写入就落进**下一条**
// 用例的缓冲（实测 `out="FRESHTAIL"`、`writes=2`）。
//
// ⚠️ 关键形态（CodeRabbit 2026-11-13 major）：延迟回调**在运行时才查**
// `process.stdout.write` —— 只保存旧引用是测不出来的，因为那时查到的是下一条用例
// 挂上的 spy。所以尾巴刻意在回调里现场查属性。
import { describe, it, expect } from 'vitest'
import { startCapture, type Capture } from './capture.js'

/** 跨用例存活：第 1 条的句柄与尾巴完成信号。 */
let first: Capture | undefined
let tailDone: Promise<void> = Promise.resolve()

describe('tests/helpers/capture.ts', () => {
  it('第 1 条：本条写入原样入账，留一条 60ms 后才落地、且现场查 write 的尾巴', async () => {
    const cap = startCapture()
    await cap.run(async () => {
      process.stdout.write('{"a":1}')
      expect(cap.out).toBe('{"a":1}')
      expect(cap.writes).toBe(1)
      tailDone = new Promise<void>((resolve) => {
        setTimeout(() => {
          // 与真实事故一致：运行时才查属性，不提前保存引用。
          process.stdout.write('TAIL')
          resolve()
        }, 60)
      })
      await new Promise((r) => setTimeout(r, 1)) // 本条结束时尾巴尚未落地
    })
    first = cap
  })

  it('第 2 条：上一条的尾巴记回它自己的捕获，不进本条', async () => {
    const cap = startCapture()
    await cap.run(async () => {
      process.stdout.write('FRESH')
      await tailDone
      await new Promise((r) => setTimeout(r, 20))
      process.stdout.write('FRESH2')
      expect(cap.writes, '本条只应数到自己的两次写入').toBe(2)
      expect(cap.out, '本条缓冲里绝不能出现尾巴').toBe('FRESHFRESH2')
      expect(first, '第 1 条必须交来句柄').toBeTypeOf('object')
      // 正向：尾巴没有被丢掉，而是记回发起它的捕获（证明归属真的按异步上下文走，
      // 而不是「碰巧谁都没收」）。
      expect(first!.out, '尾巴必须落回它自己那条捕获').toBe('{"a":1}TAIL')
      expect(cap.generation).toBeGreaterThan(first!.generation)
    })
  })

  it('中间隔着别的用例也不串（尾巴按发起者归账，不按「上一条」）', async () => {
    const a = startCapture()
    let tail2: Promise<void> = Promise.resolve()
    await a.run(async () => {
      tail2 = new Promise<void>((resolve) => { setTimeout(() => { process.stdout.write('T2'); resolve() }, 60) })
      await new Promise((r) => setTimeout(r, 1))
    })
    const middle = startCapture()
    await middle.run(async () => {
      process.stdout.write('M')
      await new Promise((r) => setTimeout(r, 100)) // 尾巴在中间用例期间落地
      expect(middle.out, '中间用例不得收到别的用例的尾巴').toBe('M')
    })
    expect(a.out).toBe('T2')
  })

  it('本条自己的 stderr 照常入账', async () => {
    const cap = startCapture()
    await cap.run(async () => {
      process.stderr.write('NEW-ERR')
      expect(cap.err).toBe('NEW-ERR')
    })
  })
})
