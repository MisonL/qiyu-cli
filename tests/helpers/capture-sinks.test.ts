// tests/helpers/capture-sinks.test.ts
//
// 守卫 capture.ts 的「旧夹具迁移形态」（`captureSinks` + 包装过的 `it`）。
// 事故形态与 capture.test.ts 相同，但这里走的是**现有 27 个文件**那种写法：
// 模块级 `let out`、`beforeEach` 刷 sink，用例体不包 `run()`。
import { describe, expect, beforeEach } from 'vitest'
import { it, captureSinks } from './capture.js'

let out = ''
let leakTail: Promise<void> = Promise.resolve()

beforeEach(() => {
  out = ''
  captureSinks((s) => { out += s }, () => {})
})

describe('captureSinks + 包装 it', () => {
  it('A：留一条 60ms 后才落地的尾巴', async () => {
    process.stdout.write('A')
    expect(out).toBe('A')
    leakTail = new Promise<void>((resolve) => {
      setTimeout(() => { process.stdout.write('TAIL'); resolve() }, 60)
    })
    await new Promise((r) => setTimeout(r, 1))
  })

  it('B：A 的尾巴不得进本条的 out', async () => {
    process.stdout.write('B')
    await leakTail
    await new Promise((r) => setTimeout(r, 20))
    expect(out, '上一条超时用例的尾巴会写进本条 out —— 正是本形态要挡的污染').toBe('B')
  })

  // ⚠️ 别名形态必须**真跑一次**（2026-11-14 事故：包装后的 `it` 丢了 `.each`/`.skipIf`，
  // 两个真实文件在**收集阶段**就 TypeError，整文件一条没跑，而全量「只」报两个失败文件，
  // 看着像小问题）。下面三条钉住：别名存在、能生成用例、生成出来的用例仍被世代隔离。
  it.each([['x'], ['y']])('C：it.each 的表格行必须原样传入（%s）', (row: string) => {
    expect(['x', 'y']).toContain(row)
  })

  it.skipIf(false)('D：it.skipIf 的登记函数保住了（条件为假时照常执行）', () => {
    expect(true).toBe(true)
  })

  // ⚠️ E / E' 两个方向都要（2026-11-14 实测补）：只测「恒真/恒假」测不出别名有没有被
  // 当成**直接登记**形态处理 —— 那样 `skipIf(true)` 的 true 会被当成用例名、条件被丢掉，
  // 用例照常执行，看着仍是「绿」。所以必须让条件真的决定成败：
  //   runIf(false) 必须被跳过 → 否则「条件被忽略」会被记成失败；
  //   skipIf(true) 必须被跳过 → 否则同上。
  // 两者都 skipped，才说明条件参数真的到了 vitest 手里。
  it.runIf(false)('E：it.runIf(false) 必须被跳过（条件不能被当成用例名丢掉）', () => {
    throw new Error('条件被忽略：本用例不该执行')
  })
  it.skipIf(true)("E'：it.skipIf(true) 必须被跳过（同上）", () => {
    throw new Error('条件被忽略：本用例不该执行')
  })
})

describe('captureSinks + 包装 it', () => {
  it.todo('F：it.todo 只是占位')
  it.fails('G：it.fails 要能登记（执行体故意失败）', () => {
    expect(1).toBe(2)
  })
})
