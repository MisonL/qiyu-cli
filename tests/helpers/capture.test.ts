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

  /** 调度形态（不论是否 await）：定时器 / 微任务 / 浮空 promise。 */
  const SCHEDULING = /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(|\.then\s*\(|\bvoid\s+[a-zA-Z_$]/g

  /**
   * hook 体里**真正危险**的调度：判据是「**谁在等这次调度的完成**」，不是「语句里有没有 await」。
   *
   * ⚠️ 为什么不能只看语句里有没有 `await`（CodeRabbit PR#81 第三轮，两条实测）：
   *   · 假阴性 —— `await Promise.resolve().then(() => setTimeout(w, 80))`：`await` 等的是**回调
   *     的返回值**（一个 Timeout 句柄），定时器照样之后才落地 → 尾巴照样漏。
   *   · 假阳性 —— `await new Promise((r) => { setTimeout(r, 80) })`：这是**正确**写法，
   *     但回扫语句会被执行体的 `{` 挡住、读不到 `await`。
   * 于是判据改成"就近问等待关系"：
   *   ① 定时器/微任务（`setTimeout`/`setInterval`/`setImmediate`/`queueMicrotask`）返回的是
   *      **句柄**，只有把它包进 `new Promise((r) => …)` 且**那个 promise** 被 await/return 给
   *      vitest 时，hook 才真的等到它完成；
   *   ② `.then(...)` 本身产出 promise，所以只要**这个 `.then` 调用链**被 await/return 即可；
   *      它回调里再排的定时器会被 ① 单独判（不在等待链上 → 报）；
   *   ③ `void …` 永远是脱手。
   * 边界如实记录（静态判据不跟数据流）：`const p = new Promise(…); await p` 这种"先存再 await"
   * 会被判成危险（误报方向，可接受）；hook 调用的辅助函数内部排定时器完全看不出来（漏报方向）。
   */

  /**
   * `at` 处落在的最内层 `callee(...)` 实参内部的起始下标；不在任何一次调用里返回 -1。
   *
   * ⚠️ `callee` 给 `new Promise`（不带括号），这里自己找它的 `(` —— 因为 TS 的构造函数可以带
   * 类型实参：`new Promise<void>((r) => setTimeout(r, 40))`（Codex PR#81 第三轮 P2 实测：
   * 按字面量 `'new Promise('` 找会漏掉这种写法，把**正确**的等待判成脱手调度）。
   */
  function enclosingCall(text: string, at: number, callee: string): number {
    let found = -1
    let from = 0
    for (;;) {
      const i = text.indexOf(callee, from)
      if (i === -1 || i > at) return found
      // 跳过可选的 `<…>` 类型实参，定位实参列表的 `(`
      let j = i + callee.length
      while (text[j] === ' ' || text[j] === '\t') j++
      if (text[j] === '<') {
        let d = 0
        for (; j < text.length; j++) {
          if (text[j] === '<') d++
          else if (text[j] === '>') { d--; if (d === 0) { j++; break } }
        }
        while (text[j] === ' ' || text[j] === '\t') j++
      }
      if (text[j] !== '(') { from = i + callee.length; continue }
      let depth = 0
      for (let k = j; k < at; k++) {
        const c = text[k]
        if (c === '(') depth++
        else if (c === ')') depth--
      }
      if (depth > 0) found = i
      from = i + callee.length
    }
  }

  /**
   * `idx` 处的表达式是否被 `await` / `return` / 表达式体箭头**交给** vitest 等待。
   *
   * 判据：① 表达式体箭头（匹配点之前没有 `{`）→ 整个表达式就是 hook 的返回值；
   * ② 否则看该表达式所在的**语句**（回扫到最近的 `;` / `{` / `}` / 行首）里有没有
   * `await` / `return`。回扫到 `{` 就停是正确的 —— 需要跨层判断的场景（块体执行器的
   * `new Promise`）走的是"检查那个 `new Promise(` 所在的语句"，而不是定时器自己的语句。
   */
  function isAwaitedOrReturned(body: string, idx: number): boolean {
    if (!body.slice(0, idx).includes('{')) return true
    // ⚠️ 换行不一定是语句边界（CodeRabbit PR#81 第四轮）：`await p\n  .then(w)` 是同一个
    // 表达式，按 `\n` 截断会读不到 `await`、把**正确**写法判成脱手。只在下一行以续行符
    // 开头（`.`/`)`/`,`/`+`/`?`/`:`）时跳过该换行；其余换行仍视为语句边界（本仓库大量
    // 依赖 ASI 的写法，跨过去会把上一条语句的 `await` 误算进来）。
    let start = idx
    while (start > 0) {
      const ch = body[start - 1]!
      if (';{}'.includes(ch)) break
      if (ch === '\n') {
        let n = start
        while (n < body.length && (body[n] === ' ' || body[n] === '\t')) n++
        if (!'.,+?:)'.includes(body[n] ?? '')) break
      }
      start--
    }
    const seg = body.slice(start, idx)
    return /\bawait\b/.test(seg) || /\breturn\b/.test(seg)
  }

  /**
   * 该定时器是否**真的承载了**那个 `new Promise` 的完成信号（Codex PR#81 第四轮 P2）。
   *
   * ⚠️ 只看「位于已 await 的 `new Promise` 内」不够：`await new Promise((resolve) => {
   * resolve(); setTimeout(() => process.stdout.write('tail'), 80) })` 里外层 promise 早已
   * resolve，定时器是**之后独立排定**的 —— 它照样跨用例落地（Codex 探针复现，上一版判据放过）。
   * 判据：取 executor 的第一个形参名，要求它**出现在这个定时器调用的实参里**
   * （`setTimeout(r, 80)` / `setTimeout(() => { …; r() }, 80)`）。没出现 → 完成信号与定时器
   * 无关 → 报。
   * 边界：形参用解构（`({resolve}) => …`）或 rename 后传入都不认（误报方向，宁可多报）。
   */
  function executorGatesTimer(body: string, promiseIdx: number, timerIdx: number): boolean {
    // `new Promise` 后面的第一个 `(` 是**构造调用的实参括号**，再下一个 `(` 才是
    // executor 的形参表（`new Promise((r) => …)`）—— 首版只取第一个，读到的是 `(r) => …`
    // 开头那个 `(`，`^\s*(\w+)` 永远匹配不上，判据恒为假（探针当场抓到：7 种合法写法全被报）。
    const outerParen = body.indexOf('(', body.indexOf('new Promise', promiseIdx))
    if (outerParen === -1) return false
    const parenAt = body.indexOf('(', outerParen + 1)
    if (parenAt === -1) return false
    // executor 的形参表：`(r) =>` / `(r, reject) =>`
    let depth = 0
    let close = -1
    for (let k = parenAt; k < body.length; k++) {
      if (body[k] === '(') depth++
      else if (body[k] === ')') { depth--; if (depth === 0) { close = k; break } }
    }
    if (close === -1) return false
    const firstParam = /^\s*([A-Za-z_$][\w$]*)/.exec(body.slice(parenAt + 1, close))?.[1]
    if (firstParam === undefined) return false
    // 这个定时器调用的实参区间
    const callParen = body.indexOf('(', timerIdx)
    if (callParen === -1) return false
    let d2 = 0
    let end2 = -1
    for (let k = callParen; k < body.length; k++) {
      if (body[k] === '(') d2++
      else if (body[k] === ')') { d2--; if (d2 === 0) { end2 = k; break } }
    }
    if (end2 === -1) return false
    const args = body.slice(callParen + 1, end2)
    const gate = new RegExp(`\\b${firstParam}\\b`)
    if (!gate.test(args)) return false
    // ⚠️ 「形参出现在实参里」还不够（CodeRabbit PR#81 第四轮）：
    // `new Promise((r) => { r(); setTimeout(() => { write(); r() }, 80) })` 的第一句就把
    // promise 敲定了，定时器里的 `r()` 再也影响不到等待 —— 尾巴照样跨用例。
    // 判据：定时器**之前**的 executor 正文里若已调用过形参，就说明完成信号先落地了 → 报。
    const arrow = body.indexOf('=>', close)
    if (arrow !== -1) {
      const before = body.slice(arrow + 2, timerIdx)
      if (new RegExp(`\\b${firstParam}\\s*\\(`).test(before)) return false
    }
    return true
  }

  function hazardHits(body: string): Array<{ token: string; awaited: boolean }> {
    const out: Array<{ token: string; awaited: boolean }> = []
    for (const m of body.matchAll(SCHEDULING)) {
      const at = m.index!
      const isThen = m[0].startsWith('.then')
      const isVoid = m[0].startsWith('void')
      // ⚠️ `setInterval` 永不算已交付（CodeRabbit PR#81 第四轮）：第一个 tick 就 resolve，
      // 但 interval **继续**按周期写 —— 后续用例照样被污染。除非能证明被 clear 掉
      //（静态看不出来），一律报。
      const isInterval = m[0].startsWith('setInterval')
      let awaited = false
      if (!isVoid && !isInterval) {
        if (isThen) {
          // ② `.then` 产出 promise：等它被交出去即可
          awaited = isAwaitedOrReturned(body, at)
        } else {
          // ① 定时器是句柄：必须包进 `new Promise(...)`、**那个 promise** 被交出去，
          //    且定时器真的承载了它的完成信号（见 executorGatesTimer）
          const p = enclosingCall(body, at, 'new Promise')
          awaited = p >= 0 && isAwaitedOrReturned(body, p) && executorGatesTimer(body, p, at)
        }
      }
      out.push({ token: m[0].trim(), awaited })
    }
    return out.filter((h) => !h.awaited)
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

  it('用了 captureSinks 的文件，hook 体（含 beforeAll）不得**留下**未 await 的延迟工作',
    () => {
      // 事故形态（Sourcery PR#72）：`beforeEach`/`afterEach` 里排一个 80ms 后落地的写入，
      // 它落地时下一条用例的 `captureSinks` 已经装好 —— `writerIsCurrent()` 把"没有世代
      // 上下文"当成当前世代，于是尾巴进了**下一条**的 `out`。
      // 为什么机制兜不住：世代号由 `it` 包装版在**用例体执行时**建立，hook 不在它的
      // `alsGen.run` 里（要给 hook 也套世代得改 29 个文件的 hook 导入，收益与风险不成比例）。
      // 所以这里禁掉"hook 里排延迟工作"这个形态本身：hook 里要么同步写完，要么 await 到底
      //（`await` 的写入在 hook 结束前就落地，不会漏）。
      // 判据边界（如实记录）：只认**直接**写在 hook 体里的这几种调度形态；若 hook 调了一个
      // 内部排定时器的辅助函数，静态扫描看不出来 —— 那种情况由 `writerIsCurrent` 的注释
      // 说明的边界承载，本守卫不假装覆盖它。
      const hits: string[] = []
      for (const f of testFiles(SRC_TESTS)) {
        const rel = relative(SRC_TESTS, f).split(sep).join('/')
        const text = blankComments(readFileSync(f, 'utf8'))
        if (!usesMigratedForm(text)) continue
        // ⚠️ 四类 hook 全部纳入（Codex 第四轮 + CodeRabbit 第四轮）：`beforeAll` 在用例
        // 世代之外；**嵌套的 `afterAll` 只结束那一层 suite** —— vitest 2.1.9 里 suite A 的
        // `afterAll` 可以跑在同级 suite B 之前，它排的延迟写入照样会落进 B。
        for (const m of text.matchAll(/\b(?:beforeEach|afterEach|beforeAll|afterAll)\s*\(/g)) {
          const [s, e] = argRange(text, m.index! + m[0].length)
          const body = text.slice(s, e)
          const line = text.slice(0, m.index!).split('\n').length
          for (const h of hazardHits(body)) {
            hits.push(`${rel}:${line} hook 体里出现「${h.token}」${h.awaited ? '（已 await）' : ''}`)
          }
        }
      }
      expect(hits, '这些 hook 里排了未 await 的延迟工作 —— 它落地的写入会漏进下一条用例的缓冲。'
        + '把工作 await 完（hook 支持 async），或改用句柄形态并让写入全在 cap.run() 内').toEqual([])
    })

  it('判据本身不许退化：调度形态逐条定档（双向，含 CR/Codex 各轮报过的假阳性与假阴性）', () => {
    // ⚠️ 样本一律用 `join` 拼出来，**不在源码里写字面量**：本文件也在扫描范围内，
    // 一条字面量 `beforeEach(() => { setTimeout…` 会让守卫扫到自己的反例（自证）。
    const bt = (...parts: string[]): string => parts.join('')
    const hit = (body: string): string[] => hazardHits(body).map((h) => h.token)
    const conc = /\b(?:it|test|describe)\.concurrent\b/g

    // —— 必须报（脱手调度 / 只等句柄）——
    expect(hit(bt('(() => { set', 'Timeout(w, 80) })')), '块体里脱手排定时器').toEqual(['setTimeout('])
    // Codex PR#81 第二轮：`setTimeout` 返回句柄，不是 Promise
    expect(hit(bt('(() => set', 'Timeout(w, 80))')), '表达式体箭头返回句柄').toEqual(['setTimeout('])
    expect(hit(bt('(() => { return set', 'Timeout(w, 80) })')), 'return 句柄也不等于等它完成')
      .toEqual(['setTimeout('])
    expect(hit(bt('(() => { new Promise((r) => set', 'Timeout(r, 80)) })')), 'promise 没被交出去')
      .toEqual(['setTimeout('])
    // CodeRabbit PR#81 第三轮（假阴性）：`await` 等的是 then 回调的返回值，定时器之后才落地
    expect(hit(bt('(async () => { await Promise.resolve().', 'then(() => set',
      'Timeout(w, 80)) })')), 'await 里嵌 .then 排的定时器仍会漏').toEqual(['setTimeout('])
    expect(hit(bt('(() => { return Promise.resolve().', 'then(() => set',
      'Timeout(w, 80)) })')), 'return 的 .then 里排定时器仍会漏').toEqual(['setTimeout('])
    // `await` 的 executor 里再排 `.then`（那条 then 不在等待链上）
    expect(hit(bt('(async () => { await new Promise((r) => { Promise.resolve().',
      'then(() => set', 'Timeout(r, 80)) }) })')),
      'await 的 executor 内部 .then 仍会漏').toEqual(['.then('])
    expect(hit(bt('(() => { void seed() })')), 'void 掉未等待的调用').toEqual(['void s'])

    // —— 必须放过（真的等到了）——
    // CodeRabbit PR#81 第三轮（假阳性）：块体执行器的 `new Promise` 是正确写法
    expect(hit(bt('(async () => { await new Promise((r) => { set', 'Timeout(r, 80) }) })')),
      'await new Promise 的块体执行器不得误伤').toEqual([])
    expect(hit(bt('(async () => { await new Promise((r) => set', 'Timeout(r, 80)) })')),
      'await new Promise 的表达式执行器').toEqual([])
    expect(hit(bt('(async () => { await (new Promise((r) => set', 'Timeout(r, 80)))) })')),
      'await 外面多一层括号').toEqual([])
    expect(hit(bt('(() => new Promise((r) => set', 'Timeout(r, 80)))')),
      '把 promise 表达式体返回给 vitest').toEqual([])
    expect(hit(bt('(() => Promise.resolve().', 'then(w))')), '表达式体返回 .then 链').toEqual([])
    expect(hit(bt('(async () => { await p.', 'then(w) })')), 'await 一条 .then 链').toEqual([])
    expect(hit(bt('(async () => { await seed() })')), 'await 别的东西（无调度）').toEqual([])

    // CodeRabbit PR#81 第四轮四条：
    // ① `setInterval` 第一个 tick 就 resolve，但 interval 继续写 —— 永不算已交付
    expect(hit(bt('(async () => { await new Promise((r) => set', 'Interval(() => { process.stdout.write("T"); r() }, 80)) })')),
      'setInterval 的后续 tick 会继续污染').toEqual(['setInterval('])
    // ② 跨行续写不得被换行截断（`await p\n  .then(w)`）
    expect(hit(bt('(async () => { await p', '\n  .', 'then(w) })')), '跨行 await 的 .then 链').toEqual([])
    // ③ 提前 resolve：定时器里再调 r() 也影响不到等待
    expect(hit(bt('(async () => { await new Promise((r) => { r(); set',
      'Timeout(() => { process.stdout.write("T"); r() }, 80) }) })')),
      'promise 在定时器之前就敲定了').toEqual(['setTimeout('])
    // Codex PR#81 第四轮：外层 promise 已 resolve、定时器在其后独立排定 → 照样漏
    expect(hit(bt('(async () => { await new Promise((resolve) => { resolve(); set',
      'Timeout(() => process.stdout.write("T"), 80) }) })')),
      'resolve() 之后才排的定时器不由该 promise 承载').toEqual(['setTimeout('])
    // 反控：定时器**就是**完成信号的载体（直接作为 resolve 实参 / 在回调里调 r()）
    expect(hit(bt('(async () => { await new Promise((resolve) => set',
      'Timeout(resolve, 80)) })')), '定时器作为 resolve 实参').toEqual([])
    expect(hit(bt('(async () => { await new Promise((r) => set',
      'Timeout(() => { process.stdout.write("T"); r() }, 80)) })')), '回调里调 r()').toEqual([])
    // 定时器永不 resolve（promise 永远挂着）——同样不算"等到它完成"
    expect(hit(bt('(async () => { await new Promise((r) => { set',
      'Timeout(() => process.stdout.write("T"), 80) }) })')), 'executor 从不 resolve').toEqual(['setTimeout('])
    // Codex PR#81 第三轮：带类型实参的 `new Promise<void>(…)` 是正确写法，不得误伤
    expect(hit(bt('(async () => { await new Promise<void>((r) => set', 'Timeout(r, 40)) })')),
      'new Promise<void> 也算包装').toEqual([])
    expect(hit(bt('(() => new Promise<void>((r) => set', 'Timeout(r, 40)))')),
      '返回 new Promise<void>').toEqual([])

    // —— 并发那条判据：命中 / 不命中 ——
    expect([...bt('it.', 'concurrent("x", () => {})').matchAll(conc)]).toHaveLength(1)
    expect([...bt('describe.', 'concurrent("y", () => {})').matchAll(conc)]).toHaveLength(1)
    // 选项对象形态（Codex PR#81 第三轮）：命中 `concurrent: true`，不误伤 `concurrent: false`
    expect([...bt("it('A', { con", 'current: true }, () => {})').matchAll(CONCURRENT_OPT)]).toHaveLength(1)
    expect([...bt("it('B', { con", 'current: false }, () => {})').matchAll(CONCURRENT_OPT)]).toHaveLength(0)
    expect(/\bcaptureSinks\s*\(/.test(bt('capture', 'Sinks((a) => {}, (b) => {})'))).toBe(true)
    expect(/\bcaptureSinks\s*\(/.test('const cap = startCapture()')).toBe(false)
  });
})
