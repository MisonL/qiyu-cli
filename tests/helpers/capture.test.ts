// tests/helpers/capture.test.ts
//
// 守卫 `tests/helpers/capture.ts` 本身。⚠️ 每条用例都**自包含**——不依赖"上一条先跑过"，
// 这样 `vitest -t '某条'` 单独选一条也能跑（CodeRabbit 2026-11-13 minor）。
//
// 两个事故形态：
// ① 上一条用例发出、尚未 resolve 的异步调用在它结束后才执行，写入落进**下一条**
//    的缓冲（实测 `out="FRESHTAIL"`、`writes=2`）。关键在于延迟回调**在运行时才查**
//    `process.stdout.write`（CodeRabbit major），只保存旧引用测不出来。
// ② 用户的 `afterEach(restoreAllMocks)` 摘掉 spy 后，助手若不重装，写入直接绕过缓冲。
import { describe, it, expect, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCapture, captureInstalled } from './capture.js'
import { argRange, blankComments } from './source-scan.js'

// ⚠️ 文件结束时 `process.stdout.write` 必须已恢复（Codex 2026-11-13 P2：vitest 2.1.9
// 默认 `restoreMocks:false`，不恢复的话同 worker 的**下一个测试文件**会把写入记进
// 本文件最后一个捕获）。恢复由 `capture.ts` 顶层注册的 `afterAll` 负责。
//
// ⚠️ 不能用 `afterAll` 里的断言来钉它：实测 vitest 2.1.9 只打印这类断言错误、
// **退出码仍是 0（用例算通过）**，等于假守卫。改为在**最后一条用例**里测：
// 调一次 `vi.restoreAllMocks()`（模拟文件结束），再断言助手的判据认为「已恢复」——
// 删掉 capture.ts 的 afterAll 不影响这条，所以它测的是**判据本身**是否正确；
// 真正的跨文件行为见 capture.ts 注释里的实测。

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('tests/helpers/capture.ts', () => {
  it('本条写入原样入账（正向，最小形态）', async () => {
    const cap = startCapture()
    await cap.run(async () => {
      process.stdout.write('{"a":1}')
      expect(cap.out).toBe('{"a":1}')
      expect(cap.writes).toBe(1)
    })
  })

  it('另一条用例的尾巴记回它自己，不进本条（事故形态 ①）', async () => {
    // 用例 A：发一条 60ms 后才落地、且**运行时才查 write** 的尾巴。
    const a = startCapture()
    let tail: Promise<void> = Promise.resolve()
    await a.run(async () => {
      tail = new Promise<void>((resolve) => {
        setTimeout(() => { process.stdout.write('TAIL'); resolve() }, 60)
      })
      await tick(1) // A 结束时尾巴尚未落地
    })
    // 用例 B：等尾巴落地，看它记到谁头上。
    const b = startCapture()
    await b.run(async () => {
      process.stdout.write('FRESH')
      await tail
      await tick(20)
      expect(b.out, '本条缓冲里绝不能出现 A 的尾巴').toBe('FRESH')
      expect(b.writes).toBe(1)
      expect(a.out, 'A 的尾巴必须落回 A 自己的捕获').toBe('TAIL')
    })
  })

  it('中间隔着别的用例也不串（尾巴按发起者归账，不按「上一条」）', async () => {
    const a = startCapture()
    let tail: Promise<void> = Promise.resolve()
    await a.run(async () => {
      tail = new Promise<void>((resolve) => { setTimeout(() => { process.stdout.write('T2'); resolve() }, 60) })
      await tick(1)
    })
    const middle = startCapture()
    await middle.run(async () => {
      process.stdout.write('M')
      await tick(120) // 尾巴在中间用例期间落地
      expect(middle.out, '中间用例不得收到别的用例的尾巴').toBe('M')
    })
    expect(a.out).toBe('T2')
  })

  it('用户调过 restoreAllMocks 之后仍能捕获（事故形态 ②）', () => {
    startCapture()
    vi.restoreAllMocks()
    const cap = startCapture()
    cap.run(() => process.stdout.write('X'))
    expect(cap.out, '恢复后若不重装 spy，写入会绕过缓冲').toBe('X')
  })

  it('恢复之后 `captureInstalled()` 必须为 false（判据本身）', () => {
    startCapture()
    expect(captureInstalled()).toBe(true)
    vi.restoreAllMocks()
    expect(captureInstalled(), '恢复后必须认为已卸载').toBe(false)
  })

  it('回调式写入必须被回调掉（Node stream 契约；否则等待它的用例只能超时）', async () => {
    const cap = startCapture()
    await cap.run(async () => {
      await new Promise<void>((resolve) => { process.stdout.write('X', () => resolve()) })
      // Node 运行时支持三参数形态，但 @types/node 的 stdout 重载没列出它 ——
      // 按 unknown 调用以覆盖这条运行路径。
      await new Promise<void>((resolve) => { (process.stdout.write as unknown as (c: string, e: string, cb: () => void) => boolean)('Y', 'utf8', resolve) })
      await new Promise<void>((resolve) => { process.stderr.write('E', () => resolve()) })
      expect(cap.out).toBe('XY')
      expect(cap.err).toBe('E')
    })
  })

  it('本条自己的 stderr 照常入账', async () => {
    const cap = startCapture()
    await cap.run(async () => {
      process.stderr.write('NEW-ERR')
      expect(cap.err).toBe('NEW-ERR')
    })
  })

  // ⚠️ **跨文件**这条没有守卫 —— 不是没查，是查了、**结构上不可达**（CodeRabbit 2026-11-14
  // major 要求核查）。实测证据（2026-11-14）：
  //   ① 每个测试文件一个独立环境：文件 A 写在 `globalThis` 上的东西，文件 B 里读不到；
  //      同一个 helper 模块在两个文件里各加载一次（函数对象身份不同）。
  //   ② 执行顺序可以强制（临时 config + 升序 sequencer 已验证 A → B），但即便顺序对了，
  //      B 也拿不到 A 留下的那个 Promise —— 因为 `globalThis` 不共享。
  //   ③ 文件 A 结束时它的定时器随环境销毁，不会在 B 里触发。
  // 所以「上一条用例的尾巴漏进下一个文件」在这个配置下没有到达路径，写一条跨文件守卫只能是
  // 假绿（我写过一个，先是通过，后来把「B 必须拿到 A 的尾巴」这一条钉上后立刻红 —— 那正是
  // ②的证据）。真正的跨用例隔离见上面几条守卫（同文件内、尾巴真的落地）。
  // 若将来有人改 vitest 配置成单环境（`isolate: false`），这条边界要重新评估。
})

/**
 * 静态守卫：迁移形态（`captureSinks`）的两个**结构性**边界不得被"顺手"踩到。
 *
 * 两条都是 Sourcery 在 PR#72 提的，机制上无法在助手里兜住（见下面各自的说明），
 * 所以改成**禁止那种写法落地** —— 与本仓库既有的静态漂移守卫同一手法。
 */
describe('静态守卫：captureSinks 的两条边界不得被踩（Sourcery PR#72）', () => {
  const SRC_TESTS = fileURLToPath(new URL('../', import.meta.url))

  /** 递归取测试文件（跳过 fixtures / helpers 自身）。 */
  function testFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'fixtures') testFiles(p, out); continue }
      if (e.name.endsWith('.test.ts')) out.push(p)
    }
    return out
  }

  /**
   * hook 体里禁止出现的**调度原语**（2026-11-16 定稿，规则取代启发式判据）。
   *
   * ⚠️ 为什么不下"是否被 await 了"：`beforeEach`/`afterEach`/`beforeAll`/`afterAll` 不在用例
   * 的异步世代里（`alsGen.run` 只包用例体），它们排的延迟写入落地时按「无上下文 = 当前世代」
   * 被接收 —— 落进此时在跑的用例。要静态判断"这次调度会不会被 vitest 等到"，得同时看懂：
   * await 的对象是不是那个 promise、promise 是否由这次调度敲定、有没有提前 resolve、
   * `.then` 链是否被交出去、跨行续写、无括号单参箭头……CR 与 Codex 在 PR#81 五轮里各自
   * 报出了这些形态里的 15 种，每一轮修完下一轮又从邻角冒出来。**静态近似堵不完**。
   *
   * 所以改成可判定的规则：hook 体里**一律**不出现这些原语。需要延迟 / 异步的时候写成
   * 模块级 helper（当动词用），在 hook 里 `await helper()` —— helper 内部怎么写这里不判，
   * 但「hook 直接排调度」这个高危形态从根上不存在了。
   * 判据边界（如实记录）：只见**直接**写在 hook 体里的字面调用；hook 调用一个内部排定时器的
   * 辅助函数看不出来（那条路径要靠 reviewer 看 helper 的语义）。
   */
  const HOOK_FORBIDDEN = /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(/g

  /** 四类 hook：前两类之上都在用例世代之外；嵌套的 `afterAll` 只结束那一层 suite。 */
  const HOOK_CALL = /\b(?:beforeEach|afterEach|beforeAll|afterAll)\s*\(/g

  /** 从 `open`（指向 `(` 或 `{`）起配对，返回配对符号**之后**的下标；未配对返回 -1。 */
  function skipBalanced(text: string, open: number): number {
    const o = text[open]
    const c = o === '(' ? ')' : '}'
    let depth = 0
    for (let k = open; k < text.length; k++) {
      if (text[k] === o) depth++
      else if (text[k] === c) { depth--; if (depth === 0) return k + 1 }
    }
    return -1
  }

  /** 一个 hook 体里出现的全部禁区命中（供扫描与自检共用）。 */
  function hookViolations(hookBody: string): string[] {
    return [...hookBody.matchAll(HOOK_FORBIDDEN)].map((m) => m[0].trim())
  }

  /**
   * 该文件是否用「模块级 sink」形态（迁移形态；`captureSinks` 是它的唯一入口）。
   * ⚠️ 用 `RegExp` 构造而不是正则字面量：本文件也在扫描范围内，字面量会让守卫扫到
   * 自己这行判据（自证）。
   */
  const MIGRATED_ENTRY = new RegExp('\\bcaptureSinks\\s*\\(')
  const usesMigratedForm = (src: string): boolean => MIGRATED_ENTRY.test(src)

  /** 选项对象形态的并发开关（`it(名, { concurrent: true }, fn)`）。 */
  const CONCURRENT_OPT = /\bconcurrent\s*:\s*true\b/g

  /**
   * `.concurrent` 的**豁免清单**：只允许"专门证明并发行为"的文件，且必须自带理由。
   * 空清单才是常态 —— 任何新增条目都要能回答"为什么这里的并发是安全的"。
   */
  const CONCURRENT_EXEMPT: Record<string, string> = {
    'helpers/capture-sinks.test.ts':
      '它用**不与其他用例重叠**的 concurrent 体（J）来证明「concurrent 体的尾巴不会漏进下一条」，'
      + 'K 会 `await` J 的尾巴后再断言 —— 语义上就是本守卫要保护的那条不变量，禁掉它等于删掉证据',
  }

  it('用了 captureSinks 的文件不得用 it.concurrent / test.concurrent（并发下无法归属写入）',
    () => {
      // 为什么不能靠机制兜：迁移形态的 sink 写的是**模块级变量**，两条并发用例本就在往同一个
      // 变量里写，任何归属都分不开（capture.ts 的 `writerIsCurrent` 注释）；改成"按用例身份
      // 取自己的 sink"更糟 —— A 的尾巴会追加进 B 正在写的那个 `out`（实测过，守卫 B/I/K/M 红）。
      // 要并发隔离只能用**句柄形态**（`startCapture()` + `cap.run()`），但那条路径也要求
      // 每次写入都落在 `cap.run` 里，未包住的写入按模块级 `fallback` 归属 —— 并发下同样串。
      // 结论：本助手服务的文件一律不用 `.concurrent`（白名单见 `CONCURRENT_EXEMPT`）。
      const hits: string[] = []
      for (const f of testFiles(SRC_TESTS)) {
        // ⚠️ 必须归一化分隔符（CodeRabbit + Codex PR#81）：Windows 上 `relative()` 返回
        // `helpers\capture-sinks.test.ts`，白名单键写的是 `helpers/capture-sinks.test.ts`，
        // 查表必然落空 → 白名单文件自己被判成违规、守卫在 Windows 上恒红（实测：
        // `path.win32.relative` 下命中 3 处）。
        const rel = relative(SRC_TESTS, f).split(sep).join('/')
        if (CONCURRENT_EXEMPT[rel] !== undefined) continue
        const text = blankComments(readFileSync(f, 'utf8'))
        // ⚠️ 判「是不是迁移形态」必须用**抹掉注释后**的文本：本文件的注释里就写着
        // `captureSinks(`（解释这条判据的边界），拿原文判会让守卫扫到自己。
        if (!usesMigratedForm(text)) continue
        // `.concurrent` 的任何注册形态：`it.concurrent(` / `it.concurrent.each(` /
        // `describe.concurrent(`（describe 级并发同样让用例并行）
        for (const m of text.matchAll(/\b(?:it|test|describe)\.concurrent\b/g)) {
          hits.push(`${rel}:${text.slice(0, m.index!).split('\n').length}`)
        }
        // ⚠️ 选项对象形态（Codex PR#81 第三轮 P2）：`it('A', { concurrent: true }, fn)` 与
        // `describe('g', { concurrent: true }, fn)` 同样让用例并行 —— 只认 `.concurrent`
        // 会静默放行（Codex 探针：两条用例都读到 `AB`）。
        for (const m of text.matchAll(CONCURRENT_OPT)) {
          hits.push(`${rel}:${text.slice(0, m.index!).split('\n').length}（选项对象 concurrent: true）`)
        }
      }
      expect(hits, '这些文件同时用了 captureSinks 与 .concurrent —— 并发下写入无法归属，'
        + '要么改用句柄形态并把写入全部放进 cap.run()，要么去掉 .concurrent').toEqual([])
      // ⚠️ 白名单不得变成"永久豁免"：条目必须仍是真的豁免对象（文件存在且确实用了
      // `.concurrent`），否则删掉那条并发用例后豁免会一直留着，将来同名文件重新引入
      // 并发时就静默放行了。
      for (const rel of Object.keys(CONCURRENT_EXEMPT)) {
        expect(rel, 'CONCURRENT_EXEMPT 的键必须是 / 分隔（与上面的归一化一致）').not.toContain('\\')
        const p = join(SRC_TESTS, rel)
        expect(existsSync(p), `CONCURRENT_EXEMPT 里的 ${rel} 不存在（清单过期）`).toBe(true)
        expect(blankComments(readFileSync(p, 'utf8')), `${rel} 已不再用 .concurrent，请从 CONCURRENT_EXEMPT 删除`)
          .toMatch(/\b(?:it|test|describe)\.concurrent\b/)
      }
    })

  it('用了 captureSinks 的文件，四类 hook 体里不得出现调度原语（含 beforeAll / 嵌套 afterAll）',
    () => {
      // 规则与理由见 `HOOK_FORBIDDEN` 的注释；边界：只见直接写在 hook 体里的字面调用。
      const hits: string[] = []
      for (const f of testFiles(SRC_TESTS)) {
        const rel = relative(SRC_TESTS, f).split(sep).join('/')
        const text = blankComments(readFileSync(f, 'utf8'))
        if (!usesMigratedForm(text)) continue
        for (const m of text.matchAll(HOOK_CALL)) {
          const close = skipBalanced(text, m.index! + m[0].length - 1)
          if (close === -1) continue
          const body = text.slice(m.index! + m[0].length, close - 1)
          const line = text.slice(0, m.index!).split('\n').length
          for (const v of hookViolations(body)) hits.push(`${rel}:${line} hook 体里出现「${v}」`)
        }
      }
      expect(hits, '这些 hook 里直接排了调度（定时器 / 微任务）—— 它们不在用例的异步世代里，'
        + '延迟写入会落进之后正在跑的用例。把延迟逻辑写成模块级 helper，在 hook 里 `await helper()`').toEqual([])
    })

  it('判据本身不许退化：规则命中四类 hook、放过 await helper；并发与迁移形态判据双向', () => {
    // ⚠️ 样本一律用 `join` 拼出来，**不在源码里写字面量**：本文件也在扫描范围内，
    // 字面量会让守卫扫到自己（自证）。
    const bt = (...parts: string[]): string => parts.join('')
    const conc = /\b(?:it|test|describe)\.concurrent\b/g

    // 四类 hook 都必须被认出
    for (const hook of ['before', 'after']) {
      for (const kind of ['Each', 'All']) {
        const src = bt(hook, kind, '(() => { set', 'Timeout(w, 80) })')
        const m = [...src.matchAll(HOOK_CALL)]
        expect(m, `${hook}${kind} 必须被 HOOK_CALL 命中`).toHaveLength(1)
        const body = src.slice(m[0].index! + m[0][0].length, skipBalanced(src, m[0].index! + m[0][0].length - 1) - 1)
        expect(hookViolations(body), `${hook}${kind} 里的 setTimeout 必须被报`).toEqual(['setTimeout('])
      }
    }
    // 规则的正控：`await helper()` 不碰调度原语 → 放过
    expect(hookViolations(bt('(async () => { await del', 'ay(80) })'))).toEqual([])
    // `setInterval` / `queueMicrotask` / `setImmediate` 同样在禁区内
    expect(hookViolations(bt('(() => set', 'Interval(w, 80))'))).toEqual(['setInterval('])
    expect(hookViolations(bt('(() => queue', 'Microtask(w))'))).toEqual(['queueMicrotask('])
    expect(hookViolations(bt('(() => set', 'Immediate(w))'))).toEqual(['setImmediate('])
    // 配对：跳过 executor 的嵌套括号后再配对（hook 体到正确的 `)` 为止）
    const nested = bt('(() => { await new Promise((r) => set', 'Timeout(r, 80)) })')
    expect(skipBalanced(nested, nested.indexOf('(') ), '嵌套括号必须配平到 hook 的 `)`').toBe(nested.length)

    // —— 并发那条判据：命中 / 不命中 ——
    expect([...bt('it.', 'concurrent("x", () => {})').matchAll(conc)]).toHaveLength(1)
    expect([...bt('describe.', 'concurrent("y", () => {})').matchAll(conc)]).toHaveLength(1)
    expect([...bt("it('A', { con", 'current: true }, () => {})').matchAll(CONCURRENT_OPT)]).toHaveLength(1)
    expect([...bt("it('B', { con", 'current: false }, () => {})').matchAll(CONCURRENT_OPT)]).toHaveLength(0)
    expect(/\bcaptureSinks\s*\(/.test(bt('capture', 'Sinks((a) => {}, (b) => {})'))).toBe(true)
    expect(/\bcaptureSinks\s*\(/.test('const cap = startCapture()')).toBe(false)
  })
})
