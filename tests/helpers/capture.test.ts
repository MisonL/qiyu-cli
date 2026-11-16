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
import { argRange, blankComments, blankLiterals, isExecutor, propertyRanges, scanBalanced, splitTopLevel } from './source-scan.js'

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
  // ⚠️ 构造而不是字面量：本文件也在扫描范围内（字面量会自证，见 `MIGRATED_ENTRY`）。
  const HOOK_FORBIDDEN = new RegExp('\\b(?:set' + 'Timeout|set' + 'Interval|set' + 'Immediate|queue'
    + 'Microtask)\\s*\\(' , 'g')

  /** 四类 hook：前两类之上都在用例世代之外；嵌套的 `afterAll` 只结束那一层 suite。 */
  const HOOK_CALL = /\b(?:beforeEach|afterEach|beforeAll|afterAll)\s*\(/g

  /**
   * 一个 hook 体里出现的全部禁区命中（供扫描与自检共用）。
   * ⚠️ 先 `blankLiterals`（CodeRabbit PR#81 第七轮）：`const sample = 'set' + 'Timeout('` 这类
   * **惰性字符串**不是调用；不抹字符串就会把合法夹具判成违规。模板里的 `${…}` 也被抹掉 ——
   * 那是已知边界（如实记录：模板表达式中真排调度的写法看不出来，本仓库无此写法）。
   */
  function hookViolations(hookBody: string): string[] {
    return [...blankLiterals(hookBody).matchAll(HOOK_FORBIDDEN)].map((m) => m[0].trim())
  }

  /**
   * 该文件是否用「模块级 sink」形态（迁移形态；`captureSinks` 是它的唯一入口）。
   * ⚠️ 用 `RegExp` 构造而不是正则字面量：本文件也在扫描范围内，字面量会让守卫扫到
   * 自己这行判据（自证）。
   */
  const MIGRATED_ENTRY = new RegExp('\\bcaptureSinks\\s*\\(')
  const usesMigratedForm = (src: string): boolean => MIGRATED_ENTRY.test(src)

  /**
   * `.concurrent` 别名形态。⚠️ 点两侧允许空白（CodeRabbit PR#81 第五轮）：`it .concurrent(…)`
   * 与跨行写法都是合法 JS，写死 `\.concurrent` 会静默放行。⚠️ `suite` 也是登记名
   * （vitest 2 里 `suite.concurrent` 即 `describe.concurrent`，CodeRabbit PR#81 第七轮）。
   */
  const CONCURRENT_ALIAS = /\b(?:it|test|describe|suite)\b(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\.\s*concurrent\b/g

  /**
   * 选项对象形态的并发开关（`it(名, { concurrent: true }, fn)`）。
   * ⚠️ 不能全文搜 `concurrent: true` —— 无关的 `const payload = { concurrent: true }`
   * 也会命中、把串行测试判违规（CodeRabbit PR#81 第六轮）；只查注册调用的实参区间还不够
   * （执行体也算实参，Codex 第七轮）—— 认法见 `concurrentOptionHits`。
   */
  const CONCURRENT_OPT = /\bconcurrent\s*:\s*true\b/g
  const REGISTER_CALL = /\b(?:it|test|describe|suite)\b(?:\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/g

  /**
   * 该文件里通过选项对象开启并发的注册点行号。
   *
   * ⚠️ 只认**选项实参**，不能拿整个实参区间去搜 `concurrent: true`（Codex PR#81 第七轮 P2）：
   * `it('safe', () => { const payload = { concurrent: true } })` 是串行用例，执行体里出现
   * 这个属性是合法夹具 —— 那会让**整个仓库**的守卫在一个普通测试上变红（误报）。
   *
   * 认法是「实参形态」，不读实参内容：
   * - `{` → 选项对象（`it(名, { … })` / `it(名, { concurrent: true }, 体)` / `it.todo(名, {…})`）。
   *   在 `propertyRanges`（顶层属性位 + `:` 之后的对象值、`=>` 之后的块）里找开关 —— 嵌套
   *   `retry: { concurrent: true }` 必须命中；回调体（`() => ({ … })` 表达式）与执行体里的
   *   同名属性必须放过（Codex 第七轮；第八轮又指出正则切 `:`/`=>` 不够，已换词法扫描）。
   * - `(` 且后面紧跟 `=>`（`() => …` / `(o) => …` / `(o = {…}) => …`）→ 本实参就是执行体，
   *   段内什么都不算（执行体里的同名属性是用户数据）；括号包裹的对象字面量（`({ … })`）
   *   仍算选项。
   * - 其余（标识符 / 字符串 / 数字 / undefined）→ 不可能是执行体，整段都算。
   * 边界（如实记录）：属性值是三元 / 调用参数里的对象字面量不展开（本仓库无此写法）；
   * 以对象字面量结尾的两参调用（`it(名, {…})`）按 todo 形态计为并发 —— 那是误报方向的唯一
   * 来源，且只发生在真写了这种调用时。
   */
  function concurrentOptionHits(rawText: string): string[] {
    const out: string[] = []
    const blanked = blankLiterals(rawText)
    const hitLines = new Set<number>()
    for (const m of rawText.matchAll(REGISTER_CALL)) {
      const line = rawText.slice(0, m.index!).split('\n').length
      // ⚠️ 链式登记（CodeRabbit PR#81 第七轮）：`it.each([1,2])('case %s', { concurrent: true },
      // 体)` 的选项在**返回的登记调用**上，只切第一对实参（表格）会漏。沿链逐个处理：
      // 本对实参结束后（跳过空白/换行）紧跟 `(` 就继续，直到不再是调用。
      let open = blanked.indexOf('(', m.index! + m[0].length - 1)
      while (open !== -1) {
        const close = scanBalanced(blanked, open)[1]
        if (close === 0) break
        for (const [s0, e0] of splitTopLevel(blanked, open + 1, close - 1)) {
          const sel = blanked.slice(s0, e0)
          const first = sel.slice(0, 1)
          let ranges: Array<[number, number]>
          if (first === '{') ranges = propertyRanges(blanked, s0 + 1, e0 - 1)
          // 本实参就是执行体（`() => {…}` / `async (o) => {…}`）：段内**什么都不算** ——
          // 执行体里的 `concurrent: true` 是用户数据，不是开关
          else if (isExecutor(sel)) ranges = []
          // 数组实参只可能是 `it.each` / `it.for` 的**表格**（数据），不是选项对象
          else if (first === '[') ranges = []
          else ranges = [[s0, e0]]
          // ⚠️ 判据必须在**抹掉字符串内容**后做（Codex PR#81 第八轮）：`{ label: 'concurrent: true' }`
          // 的值是数据而不是开关，在原始文本上匹配会误报。抹除保持等长偏移，区间照旧可用。
          const flagged = ranges.some(([rs, re]) => CONCURRENT_OPT.test(blanked.slice(rs, re)))
          CONCURRENT_OPT.lastIndex = 0    // 全局正则必须手动复位，否则同文件下一处漏判
          if (flagged) { hitLines.add(line); break }
        }
        let n = close
        while (n < blanked.length && /\s/.test(blanked[n]!)) n++
        open = blanked[n] === '(' ? n : -1
      }
    }
    return [...hitLines].map((n) => String(n))
  }

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
        for (const m of text.matchAll(CONCURRENT_ALIAS)) {
          hits.push(`${rel}:${text.slice(0, m.index!).split('\n').length}`)
        }
        // ⚠️ 选项对象形态（Codex PR#81 第三轮 P2）：`it('A', { concurrent: true }, fn)` 与
        // `describe('g', { concurrent: true }, fn)` 同样让用例并行 —— 只认 `.concurrent`
        // 会静默放行（Codex 探针：两条用例都读到 `AB`）。
        for (const line of concurrentOptionHits(text)) {
          hits.push(`${rel}:${line}（选项对象 concurrent: true）`)
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
          .toMatch(CONCURRENT_ALIAS)
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
          const close = scanBalanced(text, m.index! + m[0].length - 1)[1]
          if (close === 0) continue
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

    // 四类 hook 都必须被认出
    for (const hook of ['before', 'after']) {
      for (const kind of ['Each', 'All']) {
        const src = bt(hook, kind, '(() => { set', 'Timeout(w, 80) })')
        const m = [...src.matchAll(HOOK_CALL)]
        expect(m, `${hook}${kind} 必须被 HOOK_CALL 命中`).toHaveLength(1)
        const body = src.slice(m[0].index! + m[0][0].length, scanBalanced(src, m[0].index! + m[0][0].length - 1)[1] - 1)
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
    expect(scanBalanced(nested, nested.indexOf('('))[1], '嵌套括号必须配平到 hook 的 `)`').toBe(nested.length)
    // 字符串 / 模板 / 正则 / 注释里的括号不是配对符号（Codex PR#81 第七轮）。
    // ⚠️ 每个样本都把禁区**放在伪括号之后**：只跳字符串、不跳正则的实现能在 `')'` 样本
    // 上通过，必须在正则 / 模板 / 注释样本上红。
    const guardOf = (src: string): string[] => {
      const m = src.match(new RegExp('beforeEach\\s*\\('))!
      const from = m.index! + m[0].length - 1
      const body = src.slice(from + 1, scanBalanced(src, from)[1] - 1)
      return hookViolations(body)
    }
    // 字符串 / 模板里的 `)` 不是配对符号，后面的真调用必须照常被报；字符串里的 `(` 同理。
    // ⚠️ 样本里的调用名也要 `bt` 拼接（否则「抹字面量」那一层会把它们当惰性文本一起抹掉，
    // 样本自己就失效了 —— 本文件在扫描范围内）。
    for (const q of ['`', "'", '"']) {
      const closet = q === '`' ? '`' : q
      expect(guardOf(`${bt('beforeEach(() => { const x = ', q, ')', closet, '; ', 'set', 'Timeout(w, 80) })')}`),
        `字符串 ${q}…${q} 里的 ) 被当成了终点`).toEqual(['setTimeout('])
    }
    // ⚠️ 正则里的 `)` 必须**不带反斜杠**：`\)` 会被 `scanBalanced` 顶部的转义分支跳过，
    // 那样「不跳正则」的实现也能通过（变异实测：带 `\\)` 时变异存活）。
    expect(guardOf(bt('beforeEach(() => { const re = /)/; ', 'queue', 'Microtask(w) })')),
      '正则里的 ) 被当成了终点').toEqual(['queueMicrotask('])
    expect(guardOf(bt('beforeEach(() => { const t = `a ${f(1)} b`; ', 'set', 'Immediate(w) })')),
      '模板里的括号被当成了配对符号').toEqual(['setImmediate('])
    expect(guardOf(bt('beforeEach(() => { /* ) */ ', 'set', 'Interval(w, 80) })')),
      '块注释里的 ) 被当成了终点').toEqual(['setInterval('])
    // 惰性字符串不是调用（CodeRabbit PR#81 第七轮）：`const sample = 'setTimeout('` 什么都没排
    expect(guardOf(bt('beforeEach(() => { const sample = \'set', "Timeout(\' })")), '字符串里的调用名被当成了真调用')
      .toEqual([])
    expect(guardOf(bt('beforeEach(() => { const s2 = "queue', 'Microtask(" })')), '双引号同理').toEqual([])
    // 模板里的 `${…}` 是代码不是字面量（CodeRabbit PR#81 第七轮）：`${f(setTimeout(…))}` 真排了调度
    expect(guardOf(bt('beforeEach(() => { const t = `${f(', 'set', 'Timeout(w, 1))}` })')),
      '模板表达式里的调用被当成字面量抹掉了').toEqual(['setTimeout('])
    expect(guardOf(bt('beforeEach(() => { const t = `x${`y${', 'set', 'Interval(w, 1)}`}` })')),
      '嵌套模板的表达式同样要保留').toEqual(['setInterval('])
    expect(guardOf(bt('beforeEach(() => { const t = `set', 'Timeout(w, 1)` })')),
      '纯字面段仍要抹掉（模板里的调用名只是文本）').toEqual([])
    // 字符串里的 `(` 同样不得让配对跑偏（旧实现在这里截断/吞掉整条 hook）
    // ⚠️ 样本里的调用名也要 `bt` 拼接（否则「抹字面量」那一层会把它们当字符串内容抹掉）
    expect(guardOf("beforeEach(() => { const x = '" + "(" + "'; " + "set" + "Timeout(w, 80) })")).toEqual(["set" + "Timeout("])
    expect(scanBalanced(bt("f(')"), 1)[1], '未配平必须落在文本末尾而不是 -1/抛错').toBe(bt("f(')").length)

    // —— 并发那条判据：命中 / 不命中 ——
    expect([...bt('it.', 'concurrent("x", () => {})').matchAll(CONCURRENT_ALIAS)]).toHaveLength(1)
    expect([...bt('describe.', 'concurrent("y", () => {})').matchAll(CONCURRENT_ALIAS)]).toHaveLength(1)
    // 点两侧带空白 / 跨行（CodeRabbit PR#81 第五轮）：必须用 CONCURRENT_ALIAS 判，不能写死
    // 链式修饰符（`describe.shuffle.concurrent` / `it.sequential.concurrent`）—— 同样并发
    expect([...bt('describe.', 'shuffle.concurrent("g", () => {})').matchAll(CONCURRENT_ALIAS)]).toHaveLength(1)
    expect([...bt('it ', '. concurrent("z", () => {})').matchAll(CONCURRENT_ALIAS)]).toHaveLength(1)
    // `suite` 同样是登记名（CodeRabbit PR#81 第七轮：vitest 2 里 suite.concurrent 即 describe.concurrent）
    expect([...bt('suite.', 'concurrent("s", () => {})').matchAll(CONCURRENT_ALIAS)]).toHaveLength(1)
    expect([...bt('it', '\n  .concurrent("w", () => {})').matchAll(CONCURRENT_ALIAS)]).toHaveLength(1)
    expect([...bt("it('A', { con", 'current: true }, () => {})').matchAll(CONCURRENT_ALIAS)]).toHaveLength(0)
    expect(concurrentOptionHits(bt("it('A', { con", 'current: true }, () => {})'))).toHaveLength(1)
    expect(concurrentOptionHits(bt("it('B', { con", 'current: false }, () => {})'))).toHaveLength(0)
    // 无关对象属性不得误报（CodeRabbit PR#81 第六轮）——
    // ⚠️ 样本里必须**同时存在**一个注册调用，否则"退回全文搜索"的实现也能通过（变异实测：
    // 只放 `const payload = {...}` 时变异 2 存活）。
    // ⚠️ 无关对象必须出现在**注册调用的参数位置之外**：`it('A', {…}, () => {})` 里的对象
    // 是合法选项位，不能拿它当「无关」。这里先放一行无关代码、再放一个真正的串行用例。
    expect(concurrentOptionHits(bt("const payload = { con", "current: true }\nit('x', () => { const y = 1 })")))
      .toHaveLength(0)
    expect(concurrentOptionHits(bt('const payload = { con', 'current: true }'))).toHaveLength(0)
    // 执行体里的同名属性不得误报（Codex PR#81 第七轮）：执行体也是实参，但用例是串行的
    expect(concurrentOptionHits(bt("it('safe', () => { const p = { con", 'current: true } })')))
      .toHaveLength(0)
    expect(concurrentOptionHits(bt("it('safe', { time", "out: 5 }, () => { const p = { con", 'current: true } })')))
      .toHaveLength(0)
    // 执行体写成「返回对象字面量」同样不误报
    expect(concurrentOptionHits(bt("it('r', { time", "out: 5 }, () => ({ con", 'current: true }))')))
      .toHaveLength(0)
    // async 执行体：`it('safe', async () => …)`（CodeRabbit PR#81 第七轮，原先漏判成选项位）
    expect(concurrentOptionHits(bt("it('safe', async () => { const p = { con", 'current: true } })')))
      .toHaveLength(0)
    expect(concurrentOptionHits(bt("it('safe', async (x) => { const p = { con", 'current: true } })')))
      .toHaveLength(0)
    // 链式登记：`it.each(表)('名', { concurrent: true }, 体)` 的选项在返回的登记调用上
    expect(concurrentOptionHits(bt("it.each([1, 2])('case %s', { con", 'current: true }, async () => {})')))
      .toHaveLength(1)
    // 表格里的同名属性是数据：`[` 实参只可能是 each/for 的表格，不是选项对象
    expect(concurrentOptionHits(bt("it.each([{ con", "current: true }])(", "'x', () => {})")))
      .toHaveLength(0)
    // 选项位的正向：选项对象里嵌套 retry、`it.todo(名, 选项)` 形态都必须命中
    expect(concurrentOptionHits(bt("it('A', { retry: { con", 'current: true } }, () => {})'))).toHaveLength(1)
    // 嵌套在属性值里（不在选项顶层）也必须命中；与执行体的区别就是「在不在选项对象里」
    expect(concurrentOptionHits(bt("it('A', { onTestFailed: () => {}, o", "pts: { con", 'current: true } }, () => {})')))
      .toHaveLength(1)
    expect(concurrentOptionHits(bt('it.todo(', '\'A\', { con', 'current: true })'))).toHaveLength(1)
    // 值里出现开关字符串是数据、不是开关（Codex PR#81 第八轮）
    expect(concurrentOptionHits(bt('it(\'A\', { label: \'con', "current: true' }, () => {})"))).toHaveLength(0)
    expect(concurrentOptionHits(bt('it(\'A\', { label: \'x\', con', 'current: true }, () => {})'))).toHaveLength(1)
    // 首个实参是括号包裹的对象字面量：那是执行体，不是选项
    expect(concurrentOptionHits(bt("it('A', () => { const o = { con", 'current: true } })'))).toHaveLength(0)
    // 同一文件多处注册点都要被认出（全局正则 lastIndex 复位）
    // 同一文件多处注册点都要被认出（全局正则 lastIndex 复位）；行号必须不同
    expect(concurrentOptionHits(bt("it('A', { con", "current: true }, () => {})",
      "\nit('B', { con", "current: true }, () => {})"))).toEqual(['1', '2'])
    expect(/\bcaptureSinks\s*\(/.test(bt('capture', 'Sinks((a) => {}, (b) => {})'))).toBe(true)
    expect(/\bcaptureSinks\s*\(/.test('const cap = startCapture()')).toBe(false)
  })
})
