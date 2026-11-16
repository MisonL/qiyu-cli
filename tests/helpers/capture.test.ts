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
import { callChain, collectCalls, lineOf, objectPropsWithUnknown, parseTs, staticKey, unwrap } from './source-scan.js'

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
/**
 * 调度原语名（定时器 / 微任务）—— 只放**裸调用**（`f(…)` 或宿主.原语）能命中的名字。
 * ⚠️ `nextTick` 与 `Promise.resolve().then` 的 `.then` 同属微任务（Node 实测顺序：
 * sync → nextTick → Promise.then → queueMicrotask），延迟写入同样落在下一条用例里
 * （Codex PR#81 第二十轮 P2，`FRESHTAIL` 探针复现）。
 * ⚠️ `.then/.catch/.finally` **不在这里**：它们只在**方法链末段**才成立，由判定处单列
 * （放进来只是死条目 —— 裸调用 `then(…)` 不是真实写法，CodeRabbit PR#81 第二十二轮 minor）。
 */
const HOOK_FORBIDDEN = new Set(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'nextTick'])
/** 调度原语的宿主：`globalThis.setTimeout(…)` / `global.setTimeout(…)` 同样是调度。 */
const GLOBAL_HOSTS = new Set(['globalThis', 'global', 'window', 'self'])
/** hook 名。大小写不敏感（`beforeEach` / `beforeeach` 都按同一规则，Codex PR#81 第十轮）。 */
const HOOK_HOOKS = new Set(['beforeeach', 'aftereach', 'beforeall', 'afterall'])

/** 迁移形态（用了 `captureSinks(`）的语法树判据。字符串 / 注释里的提及不算。 */
function isMigratedFile(sf: ts.SourceFile): boolean {
  return collectCalls(sf).some((c) => callChain(c)?.chain[0] === 'captureSinks')
}

/**
 * 本文件里 `名` 绑到的**函数字面量 / 函数声明**（具名执行体：`function body() {}`、
 * `const body = () => {}`、`const body = function () {}`）。找不到或另有赋值 → undefined。
 * ⚠️ 为什么要它（Codex PR#81 第二十五轮 P2，探针复现）：`it('x', body)` 里 `body` 是**执行体**，
 * 旧判据把它当「解析不出的选项对象」报违规 —— 合法用例过不了门禁（误报）。
 */
function functionBinding(sf: ts.SourceFile, name: string): boolean {
  // 先剥别名（`const wrap = opts` 让「opts 被写过」同样作废初始值），再查写入
  if (isMutated(sf, name)) return false
  let found = false
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name?.text === name) found = true
    if (!ts.isVariableStatement(st)) continue
    for (const d of st.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name || d.initializer === undefined) continue
      const init = unwrap(d.initializer)
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) found = true
      else return false
    }
  }
  return found
}

/**
 * 名字 `name` 在文件里**有没有被写过**（任何一处写入都让静态求值不可信）。
 * 判据按「写入的**目标**」写，不按写法：`x = …`、`x.p = …`、`x['p'] = …`、`x.p++`、
 * `Object.assign(x, …)` / `Reflect.set(x, …)` / `Object.defineProperty(x, …)` 的目标里出现
 * `name` 都算（Codex PR#81 第二十五轮 P2，探针复现：`Object.assign(opts, …)` 与
 * `opts['concurrent'] = …` 旧判据都不认，守卫把已被改成并发的选项当成串行放行）。
 */
function isMutated(sf: ts.SourceFile, name: string): boolean {
  // ⚠️ **别名也算目标**：`const t2 = opts; Object.assign(t2, {…})` 改的仍是 opts
  // （Codex PR#81 第二十五轮 P2 的同族形态，探针复现过旧判据放行）。先收集以 name 初始化的
  // 顶层别名（可传递），再按「目标里出现 name 或任一别名」判。
  const aliases = new Set<string>([name])
  for (let changed = true; changed;) {
    changed = false
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || d.initializer === undefined) continue
        const init = unwrap(d.initializer)
        if (ts.isIdentifier(init) && aliases.has(init.text) && !aliases.has(d.name.text)) {
          aliases.add(d.name.text)
          changed = true
        }
      }
    }
  }
  /** 表达式是不是「围绕 name 或其别名之一的引用」：`x` / `x.p` / `x['p']` / `(x as T)`。 */
  const refersToAlias = (e: ts.Expression): boolean => {
    const u = unwrap(e)
    if (ts.isIdentifier(u)) return aliases.has(u.text)
    if (ts.isPropertyAccessExpression(u)) return refersToAlias(u.expression)
    if (ts.isElementAccessExpression(u)) return refersToAlias(u.expression)
    return false
  }
  let hit = false
  const visit = (n: ts.Node): void => {
    if (hit) return
    if (ts.isBinaryExpression(n) && ASSIGN_OPS.has(n.operatorToken.kind as ts.SyntaxKind) && refersToAlias(n.left)) hit = true
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined
      && aliases.has(n.name.text) && refersToAlias(n.initializer)) hit = true
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
      && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      && refersToAlias(n.operand)) hit = true
    if (ts.isDeleteExpression(n) && refersToAlias(n.expression)) hit = true
    if (ts.isCallExpression(n)) {
      // 写入函数的目标：`Object.assign(x, …)` 的目标是**第一个**实参；`Reflect.set(x, k, v)` 同理
      const callee = unwrap(n.expression)
      const chain = ts.isPropertyAccessExpression(callee) ? [callee.expression, callee.name.text] as const : undefined
      const host = chain === undefined ? undefined : unwrap(chain[0])
      if (host !== undefined && ts.isIdentifier(host)) {
        const key = chain![1]
        if (host.text === 'Object' && (key === 'assign' || key === 'defineProperty' || key === 'defineProperties')) {
          const target = n.arguments[0]
          if (target !== undefined && refersToAlias(target)) hit = true
        }
        if (host.text === 'Reflect' && key === 'set') {
          const target = n.arguments[0]
          if (target !== undefined && refersToAlias(target)) hit = true
        }
      }
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hit
}

/**
 * 本文件里 `名` 绑到的**求值后不变**的常量初始化表达式（布尔字面量 / 字面量对象）；
 * 找不到、绑到别的东西或**写过**它 → undefined。
 * ⚠️ 判据是"被写过就作废"，与写法无关 —— 见 `isMutated`。
 */
function staticBindingInitializer(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined
  let shadowed = false
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) {
        if (d.name.text !== name || d.initializer === undefined) continue
        found = unwrap(d.initializer)
      } else {
        // 解构里出现同名绑定 → 值不受我们控制
        const names = d.name as ts.BindingName
        const hit = (b: ts.BindingName): boolean => ts.isIdentifier(b) ? b.text === name
          : b.elements.some((e) => !ts.isOmittedExpression(e) && hit(e.name))
        if (hit(names)) shadowed = true
      }
    }
  }
  if (found === undefined || shadowed) return undefined
  return isMutated(sf, name) ? undefined : found
}

/**
 * 选项的开关值求值（**唯一实现点**）：`true` / `false` 字面量，或本文件里**求值后不变**的常量
 * （`const enabled = true`；被写过就不算）；求不出 → undefined。
 *
 * ⚠️ **为什么只留这一个纯取值函数、把比较留给调用点**（2026-11-17 实测，定位花了很久）：
 * 早先有调用方把「取值 + 三态」包成本函数内的局部闭包（`const flag = v => …`，返回 `'on' | 'no'`
 * 字符串或内联三元），结果同一个值在 `if` 里被静默判错 —— `const seq = seqB === false ? …` 之后
 * `seq === 'on'` 恒为假、整条分支永不进入，而单独调用同一个闭包却返回正确值。改成本函数的
 * 布尔返回值后调用点一次就对。**改这里时：保持返回布尔或 undefined，不要在中间引入字符串
 * 三态/局部闭包**，并跑 `套件计算键 + 括号` / `布尔常量为真 → 并发` 两条自检。
 */
function boolLiteralValue(sf: ts.SourceFile, e: ts.Expression): boolean | undefined {
  const u = unwrap(e)
  if (ts.isIdentifier(u)) {
    const init = staticBindingInitializer(sf, u.text)
    return init === undefined ? undefined : boolLiteralValue(sf, init)
  }
  if (u.kind === ts.SyntaxKind.TrueKeyword) return true
  if (u.kind === ts.SyntaxKind.FalseKeyword) return false
  return undefined
}

/**
 * 本文件顶层 `const 名 = <对象字面量>` 的初始化表达式；找不到、或该名字**另有赋值**时返回 undefined。
 * 只认顶层 const（选项对象按书写惯例出现在模块顶层）；解构 / 二次赋值 / 外部导入一律视为解析不出。
 */
function constObjectInitializer(sf: ts.SourceFile, name: string): ts.ObjectLiteralExpression | undefined {
  const init = staticBindingInitializer(sf, name)
  return init !== undefined && ts.isObjectLiteralExpression(init) ? init : undefined
}

/** 赋值运算符：`=` 与全部复合赋值（`||=` / `&&=` / `??=` 等）都是写入。 */
const ASSIGN_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

/**
 * `concurrentViolations` 里「看不清就不放行」的四类文案的共同片段（自检把它们归为 unknown）。
 * 判据新增一种"看不见"的成因时要同步加在这里 —— 否则自检会把它错归成 `opt`（判成并发）。
 */
const COULD_NOT_SEE = ['无法静态解析', '无法静态求值', '来自访问器', '未知来源的键'] as const

/**
 * 仓扫用的**粗筛**：本文件里有没有出现 `.concurrent` 修饰链或选项对象的 `concurrent` 键。
 * 它只在"没有"时下结论（"这个文件不可能开并发"）；有则交给 `concurrentViolations` 细判。
 * ⚠️ 为什么需要它（Codex PR#81 第二十五轮 P2）：细判会把**求不出的选项位**一律报出来
 * （`itBound 里的 it(name, ...rest)`、`it('…', async () => {}, 40_000)` 的超时数字），这是
 * 合理的"看不见就不放行"；但用作**仓扫**时会把合法文件报成红。仓扫问的是"这个文件的注册
 * 调用会不会登记并发"，`concurrent` 三个字在整份语法树里一次都没出现时，答案确定是"不会"。
 */
function mayRegisterConcurrent(sf: ts.SourceFile): boolean {
  let hit = false
  const visit = (n: ts.Node): void => {
    if (hit) return
    if (ts.isCallExpression(n)) {
      const c = callChain(n)
      if (c !== undefined && c.chain.some((seg) => seg === 'concurrent')) { hit = true; return }
    }
    if (ts.isPropertyAssignment(n) && ts.isComputedPropertyName(n.name) && staticKey(n.name.expression) === 'concurrent') { hit = true; return }
    // 标识符 / 字符串形态（`it['concurrent']`、`{ 'concurrent': … }`、`const opts = {…}` 的变量名）
    if (ts.isIdentifier(n) && n.text === 'concurrent') { hit = true; return }
    if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === 'concurrent') { hit = true; return }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hit
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
  const seen = new Set<number>()
  const isFn = (e: ts.Expression): boolean => {
    const u = unwrap(e)
    return ts.isArrowFunction(u) || ts.isFunctionExpression(u)
      || (ts.isIdentifier(u) && functionBinding(sf, u.text))
  }
  /** 选项对象的形状，或"求不出"的成因（报违规时的文案要用）。 */
  type Resolved =
    | { kind: 'obj'; node: ts.ObjectLiteralExpression }
    | { kind: 'ident'; node: ts.Identifier }
    | { kind: 'dynamic'; text: string }
  const resolveOptions = (a: ts.Expression): Resolved => {
    const u = unwrap(a)
    if (ts.isObjectLiteralExpression(u)) return { kind: 'obj', node: u }
    if (ts.isIdentifier(u)) {
      // ⚠️ 选项位可以是**标识符**（`const options = { concurrent: true }; it('x', options, fn)`）：
      // Vitest 2.1.9 照常按它登记并发（CodeRabbit PR#81 第二十四轮 minor，探针确认）。
      // 先在本文件里静态解析 `const 名 = <对象字面量>`；解析不出（外部导入 / 被写过）就
      // **不许放行** —— 与未知展开同一个判据。
      const init = constObjectInitializer(sf, u.text)
      return init === undefined ? { kind: 'ident', node: u } : { kind: 'obj', node: init }
    }
    // 调用返回值 / 条件表达式 / 变量引用 … 静态求不出 —— 同样**不许放行**
    // （Codex PR#81 第二十五轮 P2，探针复现：`it('x', getOptions(), fn)` 与三元表达式旧判据直接跳过）。
    return { kind: 'dynamic', text: a.getText(sf) }
  }
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
      // ⚠️ 只有**选项位**才判：`it.skipIf(x)` / `it.each(cases)` 的实参是条件与表格，
      // 不是选项（2026-11-17 实测：不加这一层，auth.test 的 `posixOnly`、config-insecure 的
      // `cases` 全被误报）。选项位**两种重载**都合法（`@vitest/runner` 的 `parseArguments`）：
      // `it(名, 选项, 体)` 与 `it(名, 体, 选项)` —— 按「谁是函数」区分，而不是固定第 2 个
      // （Codex PR#81 第二十四轮 P2：只认第 2 个时 `it('x', () => {}, { concurrent: true })`
      // 漏判，`it('x', body)` 的具名执行体又被误报为未知选项）。
      // ⚠️ 标识符**不是**自证：`optI1` 既可能是 `const optI1 = {…}`（选项）也可能是具名执行体
      // （`it('x', body)`）。判据：能解析成本文件顶层对象字面量 / 函数字面量的 → 按各自语义；
      // 否则按位置 —— `parseArguments` 只在**第 2 个**实参是函数时把第 3 个当选项，否则第 2 个
      // 就是选项。
      // ⚠️ **登记调用本身也可以经 `.call` / `.apply`**（Codex PR#81 第二十五轮 P2，探针复现：
      // `it.call(null, 名, 选项, 体)` / `it.apply(null, [名, 选项, 体])` 是有效登记，Vitest 照常
      // 按选项登记并发）：先把实参还原成登记形态再定位选项与执行体。
      let args: readonly ts.Expression[] = call.arguments
      const lastSeg = c.chain[c.chain.length - 1]
      if (c.chain.length > 1 && (lastSeg === 'call' || lastSeg === 'apply')) {
        // ⚠️ `Function.prototype.apply(thisArg, argsArray)` 的**第一个实参是 thisArg** —— 之前这里
        // 把 `call.arguments[0]`（thisArg，实测是 `null`）当成实参数组，`it.apply(null, [...])`
        // 直接被判成「实参数组无法静态解析」（Codex PR#81 第二十五轮 P2 的修复本身没生效，
        // 直到有自检样本才暴露）。数组是**第二个**实参。
        const arg0 = call.arguments[0]
        const target = lastSeg === 'apply' ? (call.arguments[1] === undefined ? undefined : unwrap(call.arguments[1])) : undefined
        if (lastSeg === 'call') args = call.arguments.slice(1)
        else if (target !== undefined && ts.isArrayLiteralExpression(target)) {
          // ⚠️ 数组里有展开 / 洞（`[...rest]`、`[名, , {}]`）时位置不可静态确定 —— 按"看不清的选项"报
          if (target.elements.some((e) => ts.isSpreadElement(e) || ts.isOmittedExpression(e))) {
            out.push({ line: lineOf(sf, call), why: `.apply 的实参数组含展开 / 空位，无法确定选项位置` })
            seen.add(lineOf(sf, call))
            continue
          }
          args = target.elements as readonly ts.Expression[]
        } else {
          out.push({ line: lineOf(sf, call), why: `.apply 的实参数组是表达式 ${arg0 === undefined ? '（缺省）' : call.getText(sf)}，无法静态解析` })
          seen.add(lineOf(sf, call))
          continue
        }
      }
      const rest = args.slice(1)
      const optionArgs = rest.length > 0 && isFn(rest[0]!) ? rest.slice(1) : rest.slice(0, 1)
      for (const a of optionArgs) {
        const r = resolveOptions(a)
        if (r.kind !== 'obj') {
          out.push({
            line: lineOf(sf, call),
            why: r.kind === 'ident'
              ? `选项对象是标识符 ${r.node.text}，无法静态解析`
              : `选项位是表达式 ${r.text}，无法静态求值`,
          })
          seen.add(lineOf(sf, call))
          continue
        }
        const u = r.node
        const { props, mayHaveUnknown, accessorKeys } = objectPropsWithUnknown(u)
        // ⚠️ 选项值同样要静态求：`{ concurrent: enabled }`（`const enabled = true`）与
        // `{ concurrent: 1 > 0 }` 在 Vitest 里都是真值 → 并发（Codex PR#81 第二十五轮 P2，
        // 探针复现：旧判据只认字面量 `true`，标识符/表达式被当成"没开"）。
        // 三态：`'on'` 为真、`'no'` 为假、`'unknown'` 静态求不出（**不许放行**）。
        // ⚠️ 不用布尔 + undefined 两态：那会把「求不出」和「为假」混成一个判据 ——
        // `{ concurrent: cond }` 会被当成串行放行。
        // ⚠️ **三态求值保持内联**：2026-11-17 实测，把它封装成本函数内的箭头函数再调用时，
        // 调用方拿到的是错值（`'no'` 一路），`if (seq === 'on')` 两者都不成立 —— 分支静默
        // 失效；同一个箭头函数单独调用却返回正确值（差异只在调用点形状，根因未查明）。
        // 内联后分支恢复。换实现时请保持内联，并跑 `套件计算键 + 括号` 那条自检。
        // 三态求值：`true` 为真、`false` 为假、`undefined` 求不出（**不许放行**）。
        // ⚠️ 必须把「求不出」和「为假」分开 —— 两态会把 `{ concurrent: cond }` 当串行放行。
        const concVal = props.get('concurrent')
        if (props.get('concurrent') !== undefined && boolLiteralValue(sf, props.get('concurrent')!) === true) {
          out.push({ line: lineOf(sf, call), why: '选项对象 concurrent 为真' })
          seen.add(lineOf(sf, call))
          continue
        }
        if (props.get('concurrent') !== undefined && boolLiteralValue(sf, props.get('concurrent')!) === undefined) {
          out.push({ line: lineOf(sf, call), why: `选项对象的 concurrent 值 ${concVal!.getText(sf)} 无法静态求值` })
          seen.add(lineOf(sf, call))
          continue
        }
        // `describe`/`suite` 上的 `sequential: false` 与 `concurrent: true` 等价
        const seqVal = SUITES.has(base) ? props.get('sequential') : undefined
        // 访问器声明的键：值是读的时候才求得的，`props.get` 是 undefined —— 不能当成「没写」
        const seqGet = accessorKeys.has('sequential')
        if (!seqGet && seqVal !== undefined && boolLiteralValue(sf, seqVal) === false) {
          out.push({ line: lineOf(sf, call), why: '套件选项 sequential 为假' })
          seen.add(lineOf(sf, call))
          continue
        }
        if (SUITES.has(base) && (seqGet || (seqVal !== undefined && boolLiteralValue(sf, seqVal) === undefined))) {
          out.push({ line: lineOf(sf, call), why: `套件选项的 sequential 值 ${seqVal === undefined ? '访问器' : seqVal.getText(sf)} 无法静态求值` })
          seen.add(lineOf(sf, call))
          continue
        }
        // ⚠️ 未知来源的键（`{ ...opts }` / `{ [key]: … }`）让「没声明并发」变得**看不出来** ——
        // 只看 `props.get` 会把「可能开了并发」当成「确定没开」（CodeRabbit PR#81 第二十三轮）。
        // 判据是静态守卫：**看不见就不许放行**，除非同一个对象里显式声明了串行（`concurrent: false`）。
        // getter 的 `concurrent` 值是**读的时候才知道**（`{ get concurrent() { return true } }`）——
        // Vitest 会读它并登记并发，`props.get` 拿到 `undefined` —— 上面的三态求值拿到 `undefined`
        // 会把它当 `'off'`，所以这里单独拦（Codex PR#81 第二十四轮 P2）。
        if (accessorKeys.has('concurrent')) {
          out.push({ line: lineOf(sf, call), why: '选项对象的 concurrent 来自访问器，值在运行时才知道' })
          seen.add(lineOf(sf, call))
          continue
        }
        const concW = props.get('concurrent')
        const explicitOff = concW !== undefined && boolLiteralValue(sf, concW) === false
        const suiteExplicitSeq = seqVal !== undefined && boolLiteralValue(sf, seqVal) === false
        if (mayHaveUnknown && !explicitOff && !suiteExplicitSeq) {
          out.push({ line: lineOf(sf, call), why: '选项对象含未知来源的键（展开 / 动态键），无法确认未开启并发' })
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
  // hook 登记本身也可以是 `beforeEach.call(null, …)` / `.apply(…)`（Codex PR#81 第二十四轮 P2）：
  // 剥掉末段 `call`/`apply` 后再认 hook 名，否则整棵回调都不被扫描。
  const isHookName = (chain: string[] | undefined): boolean => {
    if (chain === undefined) return false
    const c = chain.length > 1 && (chain[chain.length - 1] === 'call' || chain[chain.length - 1] === 'apply')
      ? chain.slice(0, -1)
      : chain
    return c.length === 1 && HOOK_HOOKS.has(c[0]!.toLowerCase())
  }
  /**
   * 这个调用**本身**是否被 directly `await`（含 `return await`、`x = await …`、括号 / 断言包装）。
   * ⚠️ **不穿透外层调用**：`await ignore(x.then(w))` 只等 `ignore` 返回的那个值 —— 它若把实参
   * 原样返回才顺便等到 `w`，否则 `w` 照样落在 hook 之后（Codex PR#81 第二十五轮 P2，探针
   * 复现：旧判据跨过调用实参去找 `await`，把这种写法放行了）。
   */
  const isAwaited = (n: ts.Node): boolean => {
    let e: ts.Node = n
    while (e.parent !== undefined) {
      const p = e.parent
      if (ts.isAwaitExpression(p)) return true
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)
        || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)) { e = p; continue }
      return false
    }
    return false
  }
  for (const call of collectCalls(sf)) {
    if (!isHookName(callChain(call)?.chain)) continue
    for (const inner of collectCalls(call)) {
      // ⚠️ 用 `callChain` 而不是 `calleeChain`：`Promise.resolve().then(…)` 的被调对象基座是
      // **调用**，`calleeChain` 对它返回 undefined（Codex PR#81 第二十轮 P2，探针复现）。
      const innerName = callChain(inner)?.chain
      if (innerName === undefined) {
        // 基座求不出名字（`(pending ?? Promise.resolve()).finally(w)` 的 `??` 表达式）时，
        // 名字链整条丢失 —— 但**末段的回调方法**静态可见（Codex PR#81 第二十四轮 P2）。
        const segOf = (c: ts.Expression): string | undefined => {
          const u = unwrap(c)
          return ts.isPropertyAccessExpression(u) ? u.name.text
            : ts.isElementAccessExpression(u) ? staticKey(u.argumentExpression)
              : undefined
        }
        let callee = unwrap(inner.expression)
        let lastSeg = segOf(callee)
        // ⚠️ 未知基座分支同样要先剥 `call`/`apply`（Codex PR#81 第二十五轮 P2，探针复现：
        // `(pending ?? Promise.resolve()).then.call(pending, w)` 的末段是 `call`，不剥就看不见
        // 它调的是 `then` —— 而这段尾巴照样在 hook 之后执行 `w`）。
        if (lastSeg === 'call' || lastSeg === 'apply') {
          callee = unwrap((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)
          lastSeg = segOf(callee)
        }
        // ⚠️ **被 await 的不算**：`await (pendingTail ?? …).catch(…)` 的尾巴当场收口，
        // 不会落进下一条用例（实测：db.test.ts 的 afterAll 清理正是这种写法，误报过）。
        if (lastSeg !== undefined && ['then', 'catch', 'finally'].includes(lastSeg) && !isAwaited(inner)) {
          out.push({ line: lineOf(sf, inner), why: `hook 体里出现「?.${lastSeg}(」` })
        }
        continue
      }
      // ⚠️ `.call(…)` / `.apply(…)` 只是调用方式，被调函数不变（Codex PR#81 第二十二轮 P2：
      // `setTimeout.call(null, cb, 1)`、`globalThis.setTimeout.apply(null, […])` 的链末段多出
      // `call`/`apply`，探针确认 hook 尾巴照样串到下一条用例）。先把末段剥掉再匹配原语。
      const last = innerName[innerName.length - 1]
      if (innerName.length > 1 && (last === 'call' || last === 'apply')) innerName.pop()
      // `setTimeout(…)` 与 `globalThis.setTimeout(…)` 都是调度；反射（`globalThis['set'+'Timeout']`）
      // 与转调 helper 内部排调度仍看不出来（见上方边界注释）。
      const bare = innerName.length === 2 && GLOBAL_HOSTS.has(innerName[0]!)
        ? [innerName[1]!]
        : innerName
      const forbidden = bare.length === 1 && HOOK_FORBIDDEN.has(bare[0]!)
        // `process.nextTick(…)`：宿主是 `process`，原语是 `nextTick`
        || (bare.length === 2 && bare[0] === 'process' && bare[1] === 'nextTick')
        // `.then/.catch/.finally(…)`：**不限于**基座是 `Promise`（CodeRabbit PR#81 第二十二轮 minor）：
        // `slowOp().then(w)`、`somePromise.finally(w)` 同样排微任务；只认 `Promise` 基座时它们
        // 全漏。代价是 `await x.then(…)` 也会被报 —— 那同样是"在 hook 里留下 Promise 回调"，
        // 判据按「末段是这三个名字」写，宁可多报也不漏（判据的边界写在 `HOOK_FORBIDDEN` 注释里）。
        || (bare.length >= 2 && ['then', 'catch', 'finally'].includes(bare[bare.length - 1]!))
      if (!forbidden) continue
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
        if (!mayRegisterConcurrent(sf)) continue
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
        if (v.why.startsWith('.concurrent')) out.push(`alias:${v.why.replace('.concurrent 修饰链：', '')}`)
        // 「求不出」一律归 unknown —— 判据按**为什么看不见**分了几种文案（无法静态解析 /
        // 无法静态求值 / 来自访问器 / 未知来源的键），自检只关心「不许放行」
        else if (COULD_NOT_SEE.some((s) => v.why.includes(s))) out.push('unknown')
        else out.push('opt')
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
    // 微任务的另两种写法（Codex PR#81 第二十轮 P2，探针复现 FRESHTAIL 串扰）
    expect(hookHits(`${H}(() => process.nextTick(() => { w() }))`), 'nextTick 是微任务').toEqual(['process.nextTick('])
    expect(hookHits(`${H}(() => { Promise.resolve().then(() => { w() }) })`), 'Promise.then 是微任务')
      .toEqual(['Promise.resolve.then('])
    expect(hookHits(`${H}(() => { Promise.resolve().finally(() => { w() }) })`), 'finally 同样是微任务')
      .toEqual(['Promise.resolve.finally('])
    expect(hookHits(`${H}(() => { Promise.reject(e).catch(() => { w() }) })`), 'catch 同样是微任务')
      .toEqual(['Promise.reject.catch('])
    expect(hookHits(`${H}(() => { new Promise((r) => r()).then(() => { w() }) })`), 'new Promise().then')
      .toEqual(['Promise.then('])
    // 不限于 `Promise` 基座（CodeRabbit PR#81 第二十二轮 minor）：任何链末段的 then/catch/finally
    expect(hookHits(`${H}(() => { slowOp().then(w) })`), '任意 Promise 链的 then').toEqual(['slowOp.then('])
    expect(hookHits(`${H}(() => { somePromise.finally(w) })`), '任意链的 finally').toEqual(['somePromise.finally('])
    expect(hookHits(`${H}(() => { x.catch(w) })`), '任意链的 catch').toEqual(['x.catch('])
    // 反例：名字里只是恰好含 then 前缀的不是
    expect(hookHits(`${H}(() => { thenable(w) })`), 'thenable 不是 .then').toEqual([])
    // hook 登记本身经 `.call`（Codex PR#81 第二十四轮 P2）
    expect(hookHits(`${H}.call(null, () => { ${ST}(w, 50) })`), 'hook 经 .call 登记').toEqual([`${ST}(`])
    // 基座求不出名字时仍按末段回调方法判（`(pending ?? Promise.resolve()).finally(w)`）
    expect(hookHits(`${H}(() => { (pending ?? Promise.resolve()).finally(w) })`), '?? 基座的 finally')
      .toEqual(['?.finally('])
    // `.call` / `.apply` 只是调用方式，被调函数不变（Codex PR#81 第二十二轮 P2）
    // 报的是**剥掉 call/apply 之后**的名字（被调函数才是判据的主体）
    expect(hookHits(`${H}(() => { ${ST}.call(null, cb, 1) })`), 'setTimeout.call').toEqual([`${ST}(`])
    expect(hookHits(`${H}(() => { globalThis.${ST}.apply(null, [cb, 1]) })`), 'globalThis.setTimeout.apply')
      .toEqual([`globalThis.${ST}(`])
    // `await` 只算**直接**等待：`await ignore(x.then(w))` 等的是 ignore 的返回值，不是 w
    // （Codex PR#81 第二十五轮 P2，探针复现：旧判据跨过调用实参去找 await，把这种写法放行了）
    expect(hookHits(`${H}(async () => { await ignore((pending ?? Promise.resolve()).then(w)) })`),
      '跨一层调用的实参不算被等待').toEqual(['?.then('])
    // 未知基座分支同样先剥 call/apply（Codex PR#81 第二十五轮 P2）：末段是 `call` 时也要认出 `then`
    expect(hookHits(`${H}(() => { (pending ?? Promise.resolve()).then.call(pending, w) })`),
      '未知基座 + .call').toEqual(['?.then('])
    expect(hookHits(`${H}(() => { (pending ?? Promise.resolve())['catch'].apply(pending, [w]) })`),
      '未知基座 + 下标 + .apply').toEqual(['?.catch('])
    // 反例：普通 Promise 用法与无关的 .then 不是 hook 体里的延迟写入
    expect(hookHits(`${H}(async () => { await Promise.resolve() })`), 'await 不排异步尾巴').toEqual([])
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
    // 展开源是变量（静态求不出）：**看不见就不许放行**（CodeRabbit PR#81 第二十三轮 minor）
    expect(concHits(`${bt("const o = { con", 'current: true }\nit(\'S4\', { ...o }, () => {})')}`),
      '变量展开无法确认未开并发 → 报违规').toEqual(['unknown'])
    // ⚠️ 未知展开**可能覆盖任何键** —— 它之前的已知值全部作废（Codex PR#81 第二十轮 P2 的**误报**：
    // `{ concurrent: true, ...opts }` 在 opts 含 `concurrent: false` 时实际串行，判成并发是错的）
    expect(concHits(`${bt("it('S5', { con", 'current: true, ...opts }, () => {})')}`),
      '未知展开之后的旧值不可信 → 报 unknown 而不是判成并发').toEqual(['unknown'])
    // 但同一个对象里**显式**声明串行（展开之后）就确定不并发
    expect(concHits(`${bt("it('S5b', { ...opts, con", 'current: false }, () => {})')}`),
      '显式 concurrent:false 收口').toEqual([])
    // 但未知展开**之后**的显式赋值重新确定值
    expect(concHits(`${bt("it('S6', { con", 'current: true, ...opts, con', 'current: true }, () => {})')}`),
      '未知展开之后的显式并发仍然可判').toEqual(['opt'])
    // 嵌套展开里的未知键同样可能覆盖**外层**的旧值（CodeRabbit PR#81 第二十一轮 minor）
    expect(concHits(`${bt("it('S8', { con", 'current: true, ...{ ...opts } }, () => {})')}`),
      '嵌套展开的未知键向外传播').toEqual(['unknown'])
    // 访问器的**静态计算键**同样只覆盖它自己那个键（Codex PR#81 第二十一轮 P2 的两侧）
    expect(concHits(`${bt("it('S9', { ...{ con", "current: true }, get ['con", "current']() { return false } }, () => {})")}`),
      // 展开给了 `concurrent: true`，但后面的 getter **后写覆盖**它、值运行时才知 → 未知
      '计算键访问器覆盖展开里的并发 → 未知').toEqual(['unknown'])
    expect(concHits(`${bt("it('S10', { con", "current: true, ...{ get ['timeout']() { return 1000 } } }, () => {})")}`),
      '别的键的访问器不得清掉并发').toEqual(['opt'])
    // 选项位是标识符（CodeRabbit PR#81 第二十四轮 minor）：能解析的按值判，解析不出的不许放行
    expect(concHits(`const optI1 = ${JSON.stringify({ concurrent: true })}\nit('I1', optI1, () => {})`),
      '顶层 const 的选项对象按值判').toEqual(['opt'])
    expect(concHits(`const optI2 = ${JSON.stringify({ concurrent: false })}\nit('I2', optI2, () => {})`),
      '顶层 const 的选项对象显式串行').toEqual([])
    expect(concHits(`const optI3 = { con${'current: true }'}\nit('I3', optI3, () => {})`),
      '顶层 const 的选项对象里写并发').toEqual(['opt'])
    expect(concHits(`import { optI4 } from './x'\nit('I4', optI4, () => {})`),
      '外部导入的选项对象无法解析').toEqual(['unknown'])
    expect(concHits(`it.skipIf(posixOnly)('I5', async () => {})`), 'skipIf 的条件不是选项').toEqual([])
    expect(concHits(`it.each(cases)('I6', async () => {})`), 'each 的表格不是选项').toEqual([])
    // 两种重载（Codex PR#81 第二十四轮 P2）
    expect(concHits(`it('O1', () => {}, ${JSON.stringify({ concurrent: true })})`), '执行体在前、选项在后').toEqual(['opt'])
    // 同一片段里声明 + 使用（解析只在本文件内，跨样本不共享）
    expect(concHits(`const optO2 = ${JSON.stringify({ concurrent: false })}\nit('O2', () => {}, optO2)`),
      '执行体在前、串行选项在后').toEqual([])
    // 写入使 const 初始值失效（同一文件里 optI2 未被写入 → 上一条仍按初始化值判）。
    // ⚠️ 判据按「写入的**目标**」写、不按写法（Codex PR#81 第二十五轮 P2 探针复现：
    // `Object.assign(opts, …)` 与 `opts['concurrent'] = …` 旧判据都不认，守卫把已被改成并发的
    // 选项当成串行**放行** —— 每一行都必须各自咬住一种写法，见同轮变异验证）。
    const W = JSON.stringify({ concurrent: false })
    expect(concHits(`const optW = ${W}\noptW.concurrent = true\nit('O3', optW, () => {})`),
      '属性写入后初始值不可信').toEqual(['unknown'])
    expect(concHits(`const optW2 = ${W}\noptW2['concurrent'] = true\nit('O3b', optW2, () => {})`),
      '下标写入与点号同义').toEqual(['unknown'])
    expect(concHits(`const optW3 = ${W}\nObject.assign(optW3, { concurrent: true })\nit('O3c', optW3, () => {})`),
      'Object.assign 的目标是第一个实参').toEqual(['unknown'])
    expect(concHits(`const optW4 = ${W}\nReflect.set(optW4, 'concurrent', true)\nit('O3d', optW4, () => {})`),
      'Reflect.set 的目标是第一个实参').toEqual(['unknown'])
    expect(concHits(`const optW5 = ${W}\nconst alias5 = optW5\nObject.assign(alias5, { concurrent: true })\nit('O3e', optW5, () => {})`),
      '别名写入打的是同一个对象').toEqual(['unknown'])
    expect(concHits(`const optW6 = ${W}\noptW6.concurrent ||= true\nit('O3f', optW6, () => {})`),
      '复合赋值也是写入').toEqual(['unknown'])
    // 反例：写入的是**别的**对象 / 只是读，初始值仍可信
    expect(concHits(`const optW7 = ${W}\nconst other7 = { concurrent: false }\nObject.assign(other7, { concurrent: true })\nit('O3g', optW7, () => {})`),
      '别的对象被写不影响本对象').toEqual([])
    expect(concHits(`const optW8 = ${W}\nconsole.log(optW8.concurrent)\nit('O3h', optW8, () => {})`),
      '只读不写').toEqual([])
    // 选项值同样要静态求值（Codex PR#81 第二十五轮 P2）：标识符常量按值判，别的表达式不许放行
    expect(concHits(`const enabled = true\nit('V1', { concurrent: enabled }, () => {})`),
      '布尔常量为真 → 并发').toEqual(['opt'])
    expect(concHits(`const disabled = false\nit('V2', { concurrent: disabled }, () => {})`),
      '布尔常量为假 → 串行').toEqual([])
    expect(concHits(`let mutable = true\nmutable = false\nit('V3', { concurrent: mutable }, () => {})`),
      '被写过的常量不可信').toEqual(['unknown'])
    expect(concHits(`it('V4', { concurrent: 1 > 0 }, () => {})`), '非字面量表达式无法静态求值').toEqual(['unknown'])
    // describe/suite 的 sequential 与 concurrent 同理
    expect(concHits(`const seqOff = false\ndescribe('V5', { sequential: seqOff }, () => {})`),
      'sequential 取常量假 → 等价并发').toEqual(['opt'])
    expect(concHits(`describe('V6', { get sequential() { return false } }, () => {})`),
      'sequential 来自访问器 → 值运行时才知道').toEqual(['unknown'])
    // 选项位不是对象字面量 / 常量：调用返回值、条件表达式都不许放行（Codex PR#81 第二十五轮 P2）
    expect(concHits(`const getOptions = () => ({ concurrent: true })\nit('V7', getOptions(), () => {})`),
      '调用返回值无法静态求值').toEqual(['unknown'])
    expect(concHits(`it('V8', condition ? { concurrent: true } : { concurrent: false }, () => {})`),
      '条件表达式两个分支都要看').toEqual(['unknown'])
    // 登记调用经 .call / .apply（Codex PR#81 第二十五轮 P2）：实参要按登记形态还原
    expect(concHits(`it.call(null, 'C1', { concurrent: true }, () => {})`), '.call 的登记实参').toEqual(['opt'])
    expect(concHits(`it.apply(null, ['C2', { concurrent: true }, () => {}])`), '.apply 的实参数组').toEqual(['opt'])
    expect(concHits(`it.call(null, 'C3', () => {})`), '.call 的合法串行登记').toEqual([])
    // 具名执行体：`function body() {}` / `const body = () => {}` 是执行体，不是选项（误报回归）
    expect(concHits(`function bodyFn() {}\nit('N1', bodyFn)`), '函数声明作执行体').toEqual([])
    expect(concHits(`const bodyAr = () => {}\nit('N2', bodyAr)`), '箭头常量作执行体').toEqual([])
    // 执行体在前时第 3 个才是选项：`bodyAr2` 在那里是**选项位**、求不出的标识符 → 不许放行
    expect(concHits(`const bodyAr2 = () => {}\nit('N3', () => {}, bodyAr2)`), '求不出的选项位').toEqual(['unknown'])
    expect(concHits(`const bodyAr3 = () => {}\nconst opt3 = { concurrent: false }\nit('N4', bodyAr3, opt3)`),
      '具名执行体 + 常量选项').toEqual([])
    // getter 的 concurrent：值在运行时才知道
    expect(concHits(`it('O4', { get con${'current() { return true }'}, })`), 'getter 并发值未知').toEqual(['unknown'])
    // 未知**计算键访问器**同样可能覆盖任何键
    expect(concHits(`${bt("it('S13', { con", 'current: true, get [key]() { return false } }, () => {})')}`),
      '未知计算键访问器使旧值不可信').toEqual(['unknown'])
    // 未知**计算键**同样可能覆盖任何键（CodeRabbit PR#81 第二十二轮 minor）
    expect(concHits(`${bt("it('S11', { con", 'current: true, [key]: false }, () => {})')}`),
      '未知计算键使旧值不可信').toEqual(['unknown'])
    // 但未知计算键**之后**的显式赋值重新确定值
    expect(concHits(`${bt("it('S12', { [key]: false, con", 'current: true }, () => {})')}`),
      '未知计算键之后的显式并发仍可判').toEqual(['opt'])
    // 访问器覆盖同名值：`{ concurrent: true, get concurrent() { return false } }` 实际串行
    expect(concHits(`${bt("it('S7', { con", 'current: true, get con', 'current() { return false } }, () => {})')}`),
      '同名访问器覆盖显式并发 → 值未知').toEqual(['unknown'])
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
