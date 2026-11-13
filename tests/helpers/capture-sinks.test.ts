// tests/helpers/capture-sinks.test.ts
//
// 守卫 capture.ts 的「旧夹具迁移形态」（`captureSinks` + 包装过的 `it`）。
// 事故形态与 capture.test.ts 相同，但这里走的是**现有 27 个文件**那种写法：
// 模块级 `let out`、`beforeEach` 刷 sink，用例体不包 `run()`。
import { describe, expect, beforeEach, vi } from 'vitest'
import { it, captureSinks, startCapture } from './capture.js'

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

// ⚠️ 直接登记别名的**隔离**（CodeRabbit 2026-11-14 major）：`it.fails(名, 体)` /
// `it.concurrent(名, 体)` 这类调用把用例**立刻**登记掉、返回值是 undefined，
// 所以「拿返回值再包执行体」永远包不到 —— 执行体跑在无世代上下文里，
// 它发出的延迟写入会被下一条用例接住。下面每组都是「留尾巴 + 下一条验证没收到」。
// （`it.only` 同属这一类，但它在共享文件里会让其余用例全被跳过，不适合做守卫。）
let tail: Promise<void> = Promise.resolve()
const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('直接登记别名（fails / concurrent）', () => {
  it.fails('H：it.fails 的体留下 60ms 尾巴', async () => {
    process.stdout.write('H')
    tail = new Promise<void>((resolve) => { setTimeout(() => { process.stdout.write('H-TAIL'); resolve() }, 60) })
    await tick(1)
    throw new Error('it.fails 要求执行体抛出')
  })

  it('I：H 的尾巴不得进本条的 out', async () => {
    await tail
    await tick(20)
    expect(out, 'it.fails 的执行体没套世代：尾巴漏进了本条').toBe('')
  })

  it.concurrent('J：it.concurrent 的体留下 60ms 尾巴', async () => {
    process.stdout.write('J')
    tail = new Promise<void>((resolve) => { setTimeout(() => { process.stdout.write('J-TAIL'); resolve() }, 60) })
    await tick(1)
  })

  it('K：J 的尾巴不得进本条的 out', async () => {
    await tail
    await tick(20)
    expect(out, 'it.concurrent 的执行体没套世代：尾巴漏进了本条').toBe('')
  })
})

// ⚠️ options-first 重载 `it(名, 选项, 体)`（CodeRabbit 2026-11-14 major）：
// 只认「第二实参是执行体」时，选项对象被当成执行体原样返回，真正的体没套世代。
describe('options-first 重载', () => {
  it('L：`it(名, 选项, 体)` 的体留下 60ms 尾巴', { timeout: 5_000 }, async () => {
    process.stdout.write('L')
    tail = new Promise<void>((resolve) => { setTimeout(() => { process.stdout.write('L-TAIL'); resolve() }, 60) })
    await tick(1)
  })

  it('M：L 的尾巴不得进本条的 out', async () => {
    await tail
    await tick(20)
    expect(out, 'options-first 重载的执行体没套世代：尾巴漏进了本条').toBe('')
  })

  // `it(名, undefined, 体)` 也是 options-first 重载（CodeRabbit 2026-11-14 major）。
  it('L2：`it(名, undefined, 体)` 的体留下 60ms 尾巴', undefined, async () => {
    process.stdout.write('L2')
    tail = new Promise<void>((resolve) => { setTimeout(() => { process.stdout.write('L2-TAIL'); resolve() }, 60) })
    await tick(1)
  })

  it('M2：L2 的尾巴不得进本条的 out', async () => {
    await tail
    await tick(20)
    expect(out, 'options 为 undefined 时执行体没套世代：尾巴漏进了本条').toBe('')
  })
})

// ⚠️ 陈旧世代的写入不得污染**句柄形态**的回退缓冲（CodeRabbit 2026-11-14 minor）：
// A 留下尾巴（捕获助手形态，没有 `alsBuf` 上下文），B 同时开了句柄 —— 尾巴被世代判据
// 拒绝之后，不能顺手追加进 B 的 `fallback`，否则 B 的 `cap.out` / `cap.writes` 被污染。
describe('陈旧写入不进句柄的回退缓冲', () => {
  let stale: Promise<void> = Promise.resolve()
  it('O：留一条 60ms 才落地的尾巴（本形态）', async () => {
    stale = new Promise<void>((resolve) => { setTimeout(() => { process.stdout.write('STALE'); resolve() }, 60) })
    await tick(1)
  })

  it('P：句柄形态下的 out / writes 不受陈旧写入影响', async () => {
    const cap = startCapture()
    await cap.run(async () => {
      process.stdout.write('P')
      await stale
      await tick(20)
      expect(cap.out, '陈旧写入被塞进了句柄的回退缓冲').toBe('P')
      expect(cap.writes).toBe(1)
    })
  })
})

// ⚠️ 预热（`tests/setup-warm.ts`）与 `vi.mock` 的共存（CodeRabbit 2026-11-14 major 的
// 实测裁决）：setupFiles 会**先于测试文件**加载 `store/duckdb`，CR 担心这会让测试文件里的
// `vi.mock` 失效 —— 实测不会（vitest 按测试文件建独立模块图，mock 注册后该文件内的 import
// 走替身）。这里把实测跑成守卫：本文件 `vi.mock` 掉 duckdb。
// ⚠️ 它**测不出**「预热是否还在」——把 `setupFiles` 摘掉后本条仍绿（已反向自检）。
// 它测的是「即便 setup 先加载过该模块，文件级 mock 依然成立」这一半结论。
describe('setup 预加载不破坏 vi.mock', () => {
  vi.mock('../../src/store/duckdb.js', () => ({ createDuckDbStore: () => 'MOCKED' }))
  it('N：文件内 vi.mock 的模块走替身（尽管 setup-warm 已真实加载过它）', async () => {
    const m = await import('../../src/store/duckdb.js')
    expect(m.createDuckDbStore({} as never, 'rw' as never)).toBe('MOCKED')
  })
})
