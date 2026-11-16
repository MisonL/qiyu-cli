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
import ts from 'typescript'
import { calleeChain, callChain, collectCalls, lineOf, objectProps, parseTs, unwrap } from './source-scan.js'

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
 * 注册函数基名。`suite` 是 `describe` 的别名（CodeRabbit PR#81 第七轮）；
 * `itBound` 是 `db.test.ts` 里「注册用例并把库路径绑进异步上下文」的包装（Codex PR#81
 * 第十轮）—— 它把选项原样转给捕获助手的 `it`，所以选项位上的并发开关同样生效。
 */
const REGISTRARS = new Set(['it', 'test', 'describe', 'suite', 'itBound'])
/** 套件级 `sequential: false` 同样让用例并行（Vitest 2.1.9，Codex PR#81 第十轮）。 */
const SUITES = new Set(['describe', 'suite'])
/** 调度原语名（定时器 / 微任务）。 */
const HOOK_FORBIDDEN = new Set(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask'])
/** 调度原语的宿主：`globalThis.setTimeout(…)` / `global.setTimeout(…)` 同样是调度。 */
const GLOBAL_HOSTS = new Set(['globalThis', 'global', 'window', 'self'])
/** hook 名。大小写不敏感（`beforeEach` / `beforeeach` 都按同一规则，Codex PR#81 第十轮）。 */
const HOOK_HOOKS = new Set(['beforeeach', 'aftereach', 'beforeall', 'afterall'])

/** 迁移形态（用了 `captureSinks(`）的语法树判据。字符串 / 注释里的提及不算。 */
function isMigratedFile(sf: ts.SourceFile): boolean {
  return collectCalls(sf).some((c) => callChain(c)?.chain[0] === 'captureSinks')
}

/**
 * 并发判据（**唯一实现点**：仓库扫描与自检都调它）：返回违规说明 + 行号。
 *
 * ① `.concurrent` 修饰链：`it.concurrent(…)` / `describe.shuffle.concurrent(…)` /
 *    `suite.concurrent(…)` —— 名字链里任一段是 `concurrent`。
 * ② 选项对象 `{ concurrent: true }`：注册调用的**对象字面量实参**（含链式登记
 *    `it.each(表)('名', {…}, 体)` 的外层调用）里有该键且值为 `true`；字符串键
 *    （`'concurrent'`）与计算键（`['concurrent']`）同属。
 * 表格式实参与执行体里的同名属性是数据，不判（Vitest 不读它们；AST 天然区分）。
 */
function concurrentViolations(sf: ts.SourceFile): Array<{ line: number; why: string }> {
  const out: Array<{ line: number; why: string }> = []
  const isTrue = (v: ts.Expression | undefined): boolean =>
    v !== undefined && unwrap(v).kind === ts.SyntaxKind.TrueKeyword
  const isFalse = (v: ts.Expression | undefined): boolean =>
    v !== undefined && unwrap(v).kind === ts.SyntaxKind.FalseKeyword
  const seen = new Set<number>()
  for (const call of collectCalls(sf)) {
    const c = callChain(call)
    if (c === undefined) continue
    const base = c.chain[0]!
    // 链式登记的两层调用（表格层 / 登记层）落在同一行，同一处违规只报一次
    if (seen.has(lineOf(sf, call))) continue
    if (REGISTRARS.has(base)) {
      const isAlias = c.chain.includes('concurrent')
        || c.chain.some((seg) => seg.toLowerCase() === 'concurrent')
      if (isAlias) {
        out.push({ line: lineOf(sf, call), why: `.concurrent 修饰链：${c.chain.join('.')}` })
        seen.add(lineOf(sf, call))
        continue
      }
      for (const a of call.arguments) {
        const u = unwrap(a)
        if (!ts.isObjectLiteralExpression(u)) continue
        const props = objectProps(u)
        if (isTrue(props.get('concurrent'))) {
          out.push({ line: lineOf(sf, call), why: '选项对象 concurrent: true' })
          seen.add(lineOf(sf, call))
        }
        // `describe`/`suite` 上的 `sequential: false` 与 `concurrent: true` 等价
        if (SUITES.has(base) && isFalse(props.get('sequential'))) {
          out.push({ line: lineOf(sf, call), why: '套件选项 sequential: false' })
          seen.add(lineOf(sf, call))
        }
      }
    }
  }
  return out
}

/**
 * hook 里排调度的判据（**唯一实现点**）：hook 调用的实参子树里任何**对调度原语名**的
 * 调用都算。字符串 / 正则 / 注释里的同名文本在 AST 里不是调用，天然不算；模板插值
 * （`${f(setTimeout(…))}`）与嵌套模板里的真调用算。
 * 边界（如实记录）：反射（`globalThis['set' + 'Timeout'](…)`）与 hook 转调的 helper
 * 内部排调度，静态看不出来 —— 后者要靠 reviewer 看 helper 的语义。
 */
function hookSchedulingViolations(sf: ts.SourceFile): Array<{ line: number; why: string }> {
  const out: Array<{ line: number; why: string }> = []
  const isHookName = (chain: string[] | undefined): boolean =>
    chain !== undefined && chain.length === 1 && HOOK_HOOKS.has(chain[0]!.toLowerCase())
  for (const call of collectCalls(sf)) {
    if (!isHookName(callChain(call)?.chain)) continue
    for (const inner of collectCalls(call)) {
      const innerName = calleeChain(inner.expression)
      if (innerName === undefined) continue
      // `setTimeout(…)` 与 `globalThis.setTimeout(…)` 都是调度；反射（`globalThis['set'+'Timeout']`）
      // 与转调 helper 内部排调度仍看不出来（见上方边界注释）。
      const bare = innerName.length === 2 && GLOBAL_HOSTS.has(innerName[0]!)
        ? [innerName[1]!]
        : innerName
      if (bare.length !== 1 || !HOOK_FORBIDDEN.has(bare[0]!)) continue
      out.push({ line: lineOf(sf, inner), why: `hook 体里出现「${innerName.join('.')}(」` })
    }
  }
  return out
}

/**
 * 静态守卫：迁移形态（`captureSinks`）的两个**结构性**边界不得被"顺手"踩到。
 *
 * 两条都是 Sourcery 在 PR#72 提的，机制上无法在助手里兜住（见下面各自的说明），
 * 所以改成**禁止那种写法落地** —— 与本仓库既有的静态漂移守卫同一手法。
 *
 * ⚠️ 判据建在 **TypeScript 语法树**上（2026-11-16，PR#81 第九轮后的收敛决定）：
 * 前七轮用「抹注释 → 抹字面量 → 按字符配括号」的手写扫描，每轮修完下一轮又从邻角
 * 冒出新的文本形态（字符串里的 `)`、正则、嵌套模板、插值里的注释、`async (): X =>`
 * 执行体……）。AST 对这些给的是精确答案，判据也变成可陈述的语言层属性。
 * 剩余边界只有反射（`globalThis['set' + 'Timeout']`）与跨模块转调 —— 写在 `HOOK_FORBIDDEN`
 * 的注释里。
 */
describe('静态守卫：captureSinks 的两条边界不得被踩（Sourcery PR#72）', () => {
  const SRC_TESTS = fileURLToPath(new URL('../', import.meta.url))

  /** 递归取测试文件（跳过 fixtures）。 */
  function testFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'fixtures') testFiles(p, out); continue }
      if (e.name.endsWith('.test.ts')) out.push(p)
    }
    return out
  }

  /**
   * 每个测试文件解析一次（两条守卫与白名单检查共用）。
   * ⚠️ `readdirSync` 与 `readFileSync` 之间有竞态（CodeRabbit PR#81 第十四轮）：仓库里确有
   * 测试在 `tests/` 下**临时**写 `.test.ts` 再删掉（`setup-warm.test.ts` 的子 vitest 用例，
   * 名字带 `process.pid`），并行跑时它可能在两次调用之间消失 —— 读到 `ENOENT` 不是"守卫
   * 发现了问题"，直接跳过这个文件（文件都已经没了，不存在要守的东西）。
   */
  const parsed = new Map<string, ts.SourceFile>()
  function parsedOf(f: string): ts.SourceFile | undefined {
    const hit = parsed.get(f)
    if (hit !== undefined) return hit
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    }
    const sf = parseTs(text, relative(SRC_TESTS, f))
    parsed.set(f, sf)
    return sf
  }

  /** 迁移形态文件的相对路径清单（白名单键的归一化与 Windows 分隔符一致）。 */
  function migratedFiles(): Array<{ rel: string; sf: ts.SourceFile }> {
    const out: Array<{ rel: string; sf: ts.SourceFile }> = []
    for (const f of testFiles(SRC_TESTS)) {
      const sf = parsedOf(f)
      if (sf === undefined) continue
      if (!isMigratedFile(sf)) continue
      out.push({ rel: relative(SRC_TESTS, f).split(sep).join('/'), sf })
    }
    return out
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
      //
      // 判据（AST，覆盖全部已知形态）：
      //   ① `.concurrent` 修饰链：`it.concurrent(…)` / `describe.shuffle.concurrent(…)` /
      //      `suite.concurrent(…)` —— 名字链里任一段是 `concurrent`；
      //   ② 选项对象 `{ concurrent: true }`：注册调用的**对象字面量实参**（含链式登记
      //      `it.each(表)('名', {…}, 体)` 的外层调用）里有该键且值为 `true`；
      //   ③ 字符串键 / 计算键（`{ 'concurrent': true }`）同属 ②。
      // 表格式实参（`it.each([[…]])`）与执行体里的同名属性是数据，不判（Vitest 不读它们）。
      const hits: string[] = []
      for (const { rel, sf } of migratedFiles()) {
        if (CONCURRENT_EXEMPT[rel] !== undefined) continue
        for (const v of concurrentViolations(sf)) hits.push(`${rel}:${v.line}（${v.why}）`)
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
        const sfExempt = parsedOf(p)
        expect(sfExempt, `CONCURRENT_EXEMPT 里的 ${rel} 读不到`).toBeDefined()
        const still = concurrentViolations(sfExempt!).some((v) => v.why.startsWith('.concurrent'))
        expect(still, `${rel} 已不再用 .concurrent，请从 CONCURRENT_EXEMPT 删除`).toBe(true)
      }
    })

  it('用了 captureSinks 的文件，四类 hook 体里不得出现调度原语（含 beforeAll / 嵌套 afterAll）',
    () => {
      // 规则：hook 体里**一律**不得出现调度原语（定时器 / 微任务）—— 它们不在用例的异步
      // 世代里（`alsGen` 上下文只在用例体），排的延迟写入落地时按「无上下文 = 当前世代」
      // 被接收，落进此时在跑的用例。需要延迟就写成模块级 helper，在 hook 里 `await helper()`。
      //
      // ⚠️ 为什么"一律禁"而不是"放过已 await 的"（PR#81 五轮审查的收敛结论）：要静态判断
      // 「这次调度会不会被 vitest 等到」，得同时看懂 await 的对象、promise 由谁敲定、
      // 有无提前 resolve、`.then` 链是否被交出去……CR 与 Codex 五轮里报出 15 种形态，
      // 每轮修完下一轮又从邻角冒出来 —— **静态近似堵不完**。规则化后判据可判定、零误报。
      //
      // 判据（AST）：hook 调用的实参子树里，任何**对调度原语名**的 CallExpression 都算。
      // 字符串里的同名文本（`const s = 'setTimeout('`）不算 —— 那是字面量；
      // 插值 / 注释里的真调用算（`${f(setTimeout(…))}` 确实排了一次调度）。
      // 边界（如实记录）：反射（`globalThis['set' + 'Timeout'](…)`）与 hook 转调的 helper
      // 内部排调度，静态看不出来 —— 后者要靠 reviewer 看 helper 的语义。
      const hits: string[] = []
      for (const { rel, sf } of migratedFiles()) {
        for (const v of hookSchedulingViolations(sf)) hits.push(`${rel}:${v.line} ${v.why}`)
      }
      expect(hits, '这些 hook 里直接排了调度（定时器 / 微任务）—— 它们不在用例的异步世代里，'
        + '延迟写入会落进之后正在跑的用例。把延迟逻辑写成模块级 helper，在 hook 里 `await helper()`').toEqual([])
    })

  it('判据本身不许退化：两条规则的双向自检（含各轮审查报出的全部形态）', () => {
    // ⚠️ 样本一律**拼**出来：本文件也在扫描范围内，字面量会让守卫扫到自己。
    const bt = (...parts: string[]): string => parts.join('')
    const ST = bt('set', 'Timeout')
    const H = bt('before', 'Each')

    // ⚠️ 下面两个辅助**直接调生产判据**（`hookSchedulingViolations` / `concurrentViolations`）
    // —— 不能在本测试里再抄一份。第一版就是抄的：把生产判据改坏（例如 hook 不再下潜实参）
    // 时自检仍然全绿，因为它测的是自己那份副本（2026-11-16 变异实测抓到的）。
    const hookHits = (src: string): string[] =>
      hookSchedulingViolations(parseTs(src)).map((v) => v.why.replace(/^hook 体里出现「/, '').replace(/」$/, ''))
    const concHits = (src: string): string[] => {
      const out: string[] = []
      for (const v of concurrentViolations(parseTs(src))) {
        out.push(v.why.startsWith('.concurrent') ? `alias:${v.why.replace('.concurrent 修饰链：', '')}` : 'opt')
      }
      return out
    }

    // —— hook 规则：四类 hook × 四种调度原语都必须命中 ——
    for (const hook of ['before', 'after']) {
      for (const kind of ['Each', 'All']) {
        expect(hookHits(`${bt(hook, kind)}(() => { ${ST}(w, 80) })`), `${hook}${kind}`)
          .toEqual([`${ST}(`])
      }
    }
    expect(hookHits(`${H}(() => setInterval(w, 80))`)).toEqual(['setInterval('])
    expect(hookHits(`${H}(() => queueMicrotask(w))`)).toEqual(['queueMicrotask('])
    expect(hookHits(`${H}(() => setImmediate(w))`)).toEqual(['setImmediate('])
    // 正控：helper 调用 / 字符串里的同名文本 / 别处的同名调用都不算（逐条对应审查报出的形态）
    expect(hookHits(`${H}(async () => { await delay(80) })`), 'await helper 应放过').toEqual([])
    expect(hookHits(`${H}(() => { const sample = "${ST}(" })`), '字符串里的调用名是数据').toEqual([])
    expect(hookHits(`${H}(() => { const re = /${ST}\\(/ })`), '正则里的调用名是数据').toEqual([])
    // 非空断言包装（Codex PR#81 第十二轮）：`setTimeout!(…)` 编译后照常调度
    expect(hookHits(`${H}(() => { ${ST}! (w, 80) })`)).toEqual([`${ST}(`])
    // 全局对象上的调度同样是调度（Codex PR#81 第十轮）
    expect(hookHits(`${H}(() => { globalThis.${ST}(w, 80) })`)).toEqual([`globalThis.${ST}(`])
    expect(hookHits(`${H}(() => { global.${ST}(w, 80) })`)).toEqual([`global.${ST}(`])
    // 字面量下标访问与点号同义（Codex PR#81 第十七轮 P2，探针复现漏检）：`globalThis['setTimeout'](…)`
    // 是**合法写法**、不是反射边界（反射是 `globalThis['set' + 'Timeout']`）。不认下标时
    // `calleeChain` 返回 undefined，这条 hook 直接放行 —— 等于把守卫绕过去。
    expect(hookHits(`${H}(() => { globalThis[${JSON.stringify(ST)}](w, 80) })`), '下标访问的全局调度')
      .toEqual([`globalThis.${ST}(`])
    expect(hookHits(`${H}(() => { window[${JSON.stringify(ST)}](w, 80) })`), 'window 下标访问').toEqual([`window.${ST}(`])
    // 逗号表达式取最右操作数（Codex PR#81 第十八轮 P2）：`(0, setTimeout)(…)` 就是 setTimeout，
    // 下行到 ES5 的模块引用也都是这个形态 —— 不穿透时 `calleeChain` 返回 undefined、守卫放行。
    expect(hookHits(`${H}(() => { (0, ${ST})(w, 1) })`), '逗号表达式里的调度').toEqual([`${ST}(`])
    // 反例：动态键仍是已声明的反射边界（`['set' + 'Timeout']` 求不出静态名）
    expect(hookHits(`${H}(() => { globalThis[${JSON.stringify('set')} + ${JSON.stringify('Timeout')}](w, 1) })`),
      '反射拼接不在静态判据内（已声明的边界）').toEqual([])
    expect(hookHits(`${H}(() => { /* ${ST}(1) */ })`), '注释里的调用名是数据').toEqual([])
    expect(hookHits(`${bt('function', ' f() { ', ST, '(w, 1) } ', H, '(() => { f() })')}`),
      'hook 之外的同名调用不归本 hook').toEqual([])
    // 真调度在字符串拼接 / 插值 / 嵌套模板里同样算（不是字面量，是代码）
    expect(hookHits(`${H}(() => { const t = \`\${${ST}(w, 1)}\` })`), '模板插值里的调用是真调度').toEqual([`${ST}(`])
    const btick = String.fromCharCode(96)
    expect(hookHits(`${H}(() => { const t = \`\${${btick}b\${${'set'}${'Interval'}(w, 1)}\`}\` })`),
      '嵌套模板插值里的调用是真调度').toEqual(['setInterval('])

    // —— 并发规则：别名 / 选项对象 / 字符串键 / 链式登记 ——
    expect(concHits(`${bt('it.', 'concurrent("x", () => {})')}`)).toEqual(['alias:it.concurrent'])
    expect(concHits(`${bt('describe.', 'shuffle.concurrent("g", () => {})')}`)).toEqual(['alias:describe.shuffle.concurrent'])
    expect(concHits(`${bt('suite.', 'concurrent("s", () => {})')}`), 'suite 是 describe 的别名').toEqual(['alias:suite.concurrent'])
    // 基座是调用、尾巴是修饰名（Codex PR#81 第十二轮）：`it.skipIf(false).concurrent(…)`
    expect(concHits(`${bt('it.skipIf(false).', 'concurrent("q", () => {})')}`), '条件基座 + concurrent')
      .toEqual(['alias:it.skipIf.concurrent'])
    // 字面量下标访问与点号同义（Codex PR#81 第十七轮 P2，探针复现漏检）：不认下标时
    // `callChain` 返回 undefined，`.concurrent` 与选项位同时漏判 —— 守卫被"合法写法"绕过。
    expect(concHits(`${bt('it[', JSON.stringify('concurrent'), ']("x", () => {})')}`), '下标访问的并发修饰')
      .toEqual(['alias:it.concurrent'])
    expect(concHits(`${bt('it[', JSON.stringify('skipIf'), '](false).concurrent(' , '"q2", () => {})')}`),
      '下标基座 + 点号修饰').toEqual(['alias:it.skipIf.concurrent'])
    // 叠加修饰（CodeRabbit PR#81 第十三轮）：条件基座 + concurrent + each。
    // ⚠️ 必须**两层以上**穿透才咬人：`it.skipIf(false).concurrent(…)` 只穿一层也成立，
    // 用单层样本时「只穿一层」的变异会存活（变异实测）。
    expect(concHits(`${bt('it.skipIf(false).concurrent.each([1])', '("case", () => {})')}`), '叠加修饰')
      .toEqual(['alias:it.skipIf.concurrent.each'])
    expect(concHits(`${bt('it.runIf(a).concurrent.skip.each([1, 2])', '("case2", () => {})')}`), '三层叠加')
      .toEqual(['alias:it.runIf.concurrent.skip.each'])
    // ⚠️ 真正依赖**递归穿透**的是「链上没有 concurrent、并发只写在选项位」的外层调用：
    // 内层调用（表格层）自己不含 concurrent，不会被单独判中；只穿一层时外层链为 undefined。
    expect(concHits(`${bt('it.skipIf(false).each([1])', '("case3", { con', 'current: true }, () => {})')}`),
      '条件基座 + each + 选项位并发').toEqual(['opt'])
    expect(concHits(`${bt("it('A', { con", 'current: true }, () => {})')}`)).toEqual(['opt'])
    expect(concHits(`${bt("it('B', { con", 'current: false }, () => {})')}`)).toEqual([])
    expect(concHits(`${bt("it('C', { 'con", "current': true }, () => {})")}`), '字符串键同属选项（Codex 第九轮）').toEqual(['opt'])
    // 计算键被括号 / 断言包装（Codex PR#81 第十二轮）：仍是静态字面量键
    expect(concHits(`${bt("it('C3', { [('con", "current')]: true }, () => {})")}`), '计算键 + 括号').toEqual(['opt'])
    expect(concHits(`${bt("it('C4', { ['con", "current' as const]: true }, () => {})")}`), '计算键 + 断言').toEqual(['opt'])
    expect(concHits(`${bt("describe('G3', { [('se", "quential')]: false }, () => {})")}`), '套件计算键 + 括号').toEqual(['opt'])
    // 括号 / 断言包装不改变语义（Codex PR#81 第十轮）
    expect(concHits(`${bt("it('C2', { con", 'current: (true) }, () => {})')}`), '括号包装').toEqual(['opt'])
    // `sequential: false` 在套件上等价并发；`it` 上的同名键不算（不是套件选项）
    expect(concHits(`${bt("describe('G', { se", 'quential: false }, () => {})')}`), '套件 sequential:false').toEqual(['opt'])
    expect(concHits(`${bt("it('G2', { se", 'quential: false }, () => {})')}`)).toEqual([])
    // itBound 是 db.test.ts 的包装登记函数（Codex PR#81 第十轮）
    expect(concHits(`${bt("itBound('H', { con", 'current: true }, () => {})')}`), 'itBound 的选项原样转给 it').toEqual(['opt'])
    expect(concHits(`${bt("it('D', { [", "'concurrent']: true }, () => {})")}`), '计算键同属选项').toEqual(['opt'])
    expect(concHits(`${bt("it.each([1, 2])('x', { con", 'current: true }, () => {})')}`), '链式登记的选项在外层调用上').toEqual(['opt'])
    // 反例：执行体里的属性 / 表格里的属性 / 无关对象都不是选项
    // 标签模板形态的 each（Codex PR#81 第十轮）：it.each<反引号>a|b<反引号>(名, 选项, 体)
    // 标签模板形态的 each（Codex PR#81 第十轮）：标签模板 + 选项对象
    const tagSrc = bt('it.each', String.fromCharCode(96), 'a|b', String.fromCharCode(96), "('x', { con", 'current: true }, () => {})')
    expect(concHits(tagSrc), '标签模板的 each 登记').toEqual(['opt'])
    // 静态对象展开按属性顺序合并（Codex PR#81 第十八轮 P2，探针证实 Vitest 按合并后的值判并发）
    expect(concHits(`${bt("it('S1', { ...{ con", 'current: true } }, () => {})')}`), '静态展开的选项').toEqual(['opt'])
    expect(concHits(`${bt("describe('S2', { ...{ se", 'quential: false } }, () => {})')}`), '静态展开的套件选项').toEqual(['opt'])
    // 后写覆盖前写：`{ ...{ concurrent: true }, concurrent: false }` 实际是串行
    expect(concHits(`${bt("it('S3', { ...{ con", 'current: true }, con', 'current: false }, () => {})')}`),
      '展开后再写 false → 不是并发').toEqual([])
    // 反例：展开源是变量（静态求不出）—— 已声明的边界
    expect(concHits(`${bt("const o = { con", 'current: true }\nit(\'S4\', { ...o }, () => {})')}`),
      '变量展开看不出静态值').toEqual([])
    expect(concHits(`${bt("it('E', () => { const p = { con", 'current: true } })')}`), '执行体里的是数据').toEqual([])
    expect(concHits(`${bt("it('F', async (): Promise<void> => { const p = { con", 'current: true } })')}`),
      '带返回类型的 async 执行体（Codex 第九轮）').toEqual([])
    expect(concHits(`${bt("it('G', function () { const p = { con", 'current: true } })')}`),
      'function 执行体（Codex 第九轮）').toEqual([])
    expect(concHits(`${bt("it.each([{ con", "current: true }])('x', () => {})")}`), '表格里的是数据').toEqual([])
    expect(concHits(`${bt("const payload = { con", "current: true }\nit('x', () => {})")}`), '无关对象').toEqual([])
    expect(concHits(`const s = ${JSON.stringify(bt('it.', 'concurrent'))}\nit('y', () => {})`), '字符串里的别名是数据').toEqual([])
    // 迁移形态判据（AST）：`captureSinks(` 调用才算，字符串 / 注释里提到它不算
    const isMigrated = (src: string): boolean => isMigratedFile(parseTs(src))
    expect(isMigrated(bt('capture', 'Sinks((a) => {}, (b) => {})'))).toBe(true)
    expect(isMigrated('const cap = startCapture()')).toBe(false)
    expect(isMigrated(`// ${bt('capture', 'Sinks(')} 只是注释\nconst a = 1`)).toBe(false)
    expect(isMigrated(`const s = ${JSON.stringify(bt('capture', 'Sinks('))}`)).toBe(false)
    expect(parseTs).toBeTypeOf('function')
  })
})
