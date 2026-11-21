// tests/plaintext-channels.test.ts —— 全仓静态扫描：给人读的纯文本通道不得出现 Markdown 标记
//
// **守的规则**（设计稿 §11.2 / README「输出格式」）：本 CLI 有两个**纯文本**通道 ——
//   · stderr（`usageFail` 的人类可读那份、`callOne` catch 的手工补写、各命令的直接 write）
//   · help 文本（走 stdout，但它是**文本**不是渲染后的文档）
// 两者都是终端里逐字显示给**人**看的。写进 `**粗体**` 只会让人读到四个星号。
// 而 stdout 的 JSON **豁免** —— 字段值是给 Agent 的结构化文本，Markdown 在那边是内容，
// 不是排版意图（`field_notes` / `hint` 里出现 `**` 是允许的，本文件不查）。
//
// **为什么是静态扫描而不是逐条跑用例**（Sourcery 2026-10-26 发现）：
// `tests/commands/api.test.ts` 里那张哨兵表按调用点逐个点名，但它**只覆盖 api / auth / cli
// 三个文件**，而全仓 `usageFail` 调用点有 117 处（db / query / skill / stats / store /
// sync / sync-run 共 79 处不在表内）。那张表的注释当时写着「全仓」，是谎报。
// 靠"再补 79 行用例"去追是走不通的：每加一个命令就要记得补一行，而**忘记补不会有任何
// 东西变红** —— 这正是本仓库反复踩过的「同一规则多处实现」。
// 静态扫描是**一处定义、全仓生效**：新写的调用点自动被覆盖，不需要谁记得去登记。
//
// ⚠️ **与 api.test.ts 那张表的分工**：表是**行为**验证（真的跑到那个分支、stderr 真的非空、
// 锚字符串真的来自该分支）；本文件是**文本**验证（文案里没有星号）。两者都要 ——
// 静态扫描证明不了分支可达，行为表证明不了"没被枚举到的那些"。见 api.test.ts 里
// 同一条注释的「两张网」说明。
//
// ⚠️ **边界（诚实记录）**：本文件只看**字面量**。运行时拼出来的 `**`
// （如 `${userInput}` 里恰好带星号）它看不见 —— 那属于「不受信文本原样回显」，
// 不是文案缺陷，由各命令的净化（sanitizeMessage）负责。
//
// ⚠️ 判据建在 **TypeScript 语法树**上（2026-11-16）：手写文本扫描（抹注释 → 配括号取实参）
// 会被字符串 / 正则 / 模板里的括号骗到 —— 例如 `usageFail(`outer ${String(`)`)} **bad**`)`
// 会在嵌套模板的反引号处提前收尾、漏掉后面的星号（CodeRabbit PR#81 第八轮）。
// AST 直接给出「这个调用的实参是什么」，字面量与插值各归各位。

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { calleeChain, lineOf, literalTexts, parseTs, unwrap } from './helpers/source-scan.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

interface Hit { file: string; line: number; snippet: string }

/**
 * 「调用」的两种语法节点：函数调用 `f(...)` 与构造调用 `new F(...)`。
 * ⚠️ 必须**都**收（2026-11-16 自检当场抓到）：`new Error('**x**')` 在 TS 语法树里是
 * `NewExpression`、**不是** `CallExpression` —— 只扫后者时那条 throw 规则一条都命中不了，
 * 而它在真实代码全绿的情况下看起来完全正常（空转的守卫）。
 */
/**
 * 四条规则（**唯一实现点**：全仓扫描与自检都调它们）。每条接收一棵语法树，返回命中说明。
 * 语法树里只有真正的调用会出现 —— 字符串 / 注释里的同名文本天然不算。
 */
type Rule = { name: string; hit: (sf: ts.SourceFile) => string[] }

/**
 * 常量字符串表达式的**拼接结果**：`'*' + '*bad*' + '*'` 单独看每段都没有 `**`，拼起来却有。
 * 只对「全由字面量 / `+` / 括号组成」的表达式求值（其余返回 undefined）—— 运行时的拼接
 * 本来就不在本文件的边界内（见文件头的「只看字面量」）。
 */
function constConcat(node: ts.Expression): string | undefined {
  const u = unwrap(node)
  if (ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u)) return u.text
  if (ts.isParenthesizedExpression(u)) return constConcat(u.expression)
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const l = constConcat(u.left)
    const r = constConcat(u.right)
    return l === undefined || r === undefined ? undefined : l + r
  }
  return undefined
}

/** 子树里全部**可静态求值**的拼接表达式（含模板插值里的 —— CodeRabbit PR#81 第十五轮）。 */
function concatTexts(root: ts.Node): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    const cc = ts.isExpression(n) ? constConcat(n) : undefined
    if (cc !== undefined) { out.push(cc); return }
    ts.forEachChild(n, visit)
  }
  visit(root)
  return out
}

/** 实参里含 `**` 时的说明：逐字面量看，**也**看常量拼接的结果（CodeRabbit PR#81 第十三、十五轮）。 */
function starsIn(args: readonly ts.Expression[]): string | undefined {
  const texts = args.flatMap((a) => literalTexts(a))
  for (const a of args) texts.push(...concatTexts(a))
  if (!texts.some((t) => t.includes('**'))) return undefined
  return texts.filter((t) => t.includes('**')).join(' | ').replace(/\s+/g, ' ').slice(0, 120)
}

/** 遍历一棵树里的全部调用 / 构造调用。⚠️ 两种都要 —— `new Error(…)` 是 NewExpression。 */
function eachInvocation(sf: ts.SourceFile, fn: (n: ts.CallExpression | ts.NewExpression, line: number) => void): void {
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) || ts.isNewExpression(n)) fn(n, lineOf(sf, n))
    ts.forEachChild(n, visit)
  }
  visit(sf)
}

const argsOf = (n: ts.CallExpression | ts.NewExpression): readonly ts.Expression[] => n.arguments ?? []

/**
 * 该调用的名字链是否等于 `want`（逐段）。
 * ⚠️ 不再接收 `sf`：历史版本用 `getText(sf)` 比对、跨行与可选链会静默漏判（本条注释即理由）。
 */
const named = (n: ts.CallExpression | ts.NewExpression, ...want: string[]): boolean => {
  // ⚠️ 名字链**只许一个实现点**（`source-scan.ts`）：本文件曾有自己的一份，补下标访问时
  // 只修了那一份，共享的那份照样漏（Codex PR#81 第十七轮 P2 在 capture 守卫上复现）。
  const got = calleeChain(n.expression)
  return got !== undefined && got.length === want.length && got.every((seg, i) => seg === want[i])
}

/** `usageFail(...)` 的文案里没有 `**`（逐字写进 stderr）。 */
const USAGE_FAIL: Rule = {
  name: 'usageFail',
  hit: (sf) => {
    const out: string[] = []
    eachInvocation(sf, (n, line) => {
      if (!ts.isCallExpression(n) || !named(n, 'usageFail')) return
      const why = starsIn(argsOf(n))
      if (why !== undefined) out.push(`L${line}  ${why}`)
    })
    return out
  },
}

/**
 * `throw` 里的 `new Error(...)`（含 `throw Object.assign(new Error(…))`）。
 * 两条出口都会把 message 变成人读文本：`callOne` 的 catch 直接写 stderr；未捕获时
 * Node 默认打印器把 message 与堆栈一起打到终端。AST 判据天然跨行、跨嵌套。
 * ⚠️ 向上回溯**止于未被调用的函数边界**（CodeRabbit PR#81 第十九轮 minor，探针复现）：
 * `throw Object.assign(new Error('clean'), { makeError: () => new Error('**x**') })` 里
 * 回调内的 `new Error` 不在执行路径上 —— 它的 message 永远不会被抛出。
 * ⚠️ 但**立即调用**的函数表达式仍然执行（Codex PR#81 第二十轮 P2，探针复现）：
 * `throw (() => new Error('**BAD**'))()` 抛的就是里面那个 Error。所以边界只在
 * 「它是某个调用的被调对象」时被穿透，否则才停止。
 */
// 尾位置表达式**求值后交出的函数字面量**（`() => function () {…}` 的尾值是内层函数；`() => (() => …)`
// 的尾值是内层箭头；`() => new Error(…)` 的尾值是 `new` 产生的数据 → undefined）。只认函数数据，
// 逗号链按 JS 求值语义取最后一项；**任何调用**（含 `.call/.apply/.bind`）的返回值都是数据，不透明。
// `THROW_ERROR` 的尾位置判据是唯一调用点。
const resolveTail = (e: ts.Expression): ts.Expression | undefined => {
  const u = unwrap(e)
  if (ts.isCallExpression(u)) {
    if (ts.isCommaListExpression(unwrap(u.expression))) return resolveTail(unwrap(u.expression))
    // ⚠️ 普通调用的返回值是数据（`() => function () {…}()` 交出的不是内层函数），任何调用都不透明。
    // `(() => X).call/.apply/.bind(…)` 的同口径「内层箭头执行」已由边界处的 `isImmediatelyInvoked`
    // 与既有 `call 立即执行` 样本承担；`() => (() => …).call(null)` 在合并样本里实测**不命中**
    // （如实记录：`.call` 链在尾值位置不被穿透，样本 `**call 链内层**` 固定为反例）。
    return undefined
  }
  if (ts.isCommaListExpression(u)) {
    const last = u.elements[u.elements.length - 1]
    return last === undefined ? undefined : resolveTail(last)
  }
  return ts.isArrowFunction(u) || ts.isFunctionExpression(u) || ts.isFunctionDeclaration(u) ? u : undefined
}
// `root` 的子树里是否含有 `n`（含自身）
const containsNode = (root: ts.Node, n: ts.Node): boolean => {
  let found = false
  const walk = (x: ts.Node): void => { if (found) return; if (x === n) { found = true; return }; ts.forEachChild(x, walk) }
  walk(root)
  return found
}

const THROW_ERROR: Rule = {
  name: 'throw new Error',
  hit: (sf) => {
    const out: string[] = []
    /** 剥括号 / 断言包装。 */
    const stripWrappers = (node: ts.Node): ts.Node => {
      let k: ts.Node = node
      for (;;) {
        const q = k.parent
        if (q !== undefined && (ts.isParenthesizedExpression(q) || ts.isAsExpression(q) || ts.isNonNullExpression(q)
          || ts.isSatisfiesExpression(q) || ts.isTypeAssertionExpression(q)) && q.expression === k) { k = q; continue }
        return k
      }
    }
    /**
     * `fn` 的**返回值是否再被调用**（`(() => () => …)()()` / `(…)().call(null)`，CR 第三十五轮 minor，
     * Node 实测内层体确实执行）。`fn` 本身必须是被调用的（`isImmediatelyInvoked` 另判）。
     * 用于「尾值是函数字面量」那条规则的例外：外层被调、它的**结果**又被调，尾函数就不再只是「被交出」。
     */
    const returnValueInvoked = (fn: ts.Node): boolean => {
      const callee = stripWrappers(fn)
      const call = callee.parent
      if (call === undefined || !ts.isCallExpression(call) || call.expression !== callee) return false
      const outer = stripWrappers(call).parent
      if (outer !== undefined && ts.isCallExpression(outer) && unwrap(outer.expression) === unwrap(call)) return true
      if (outer !== undefined && ts.isPropertyAccessExpression(outer) && outer.expression === call
        && (outer.name.text === 'call' || outer.name.text === 'apply')
        && outer.parent !== undefined && ts.isCallExpression(outer.parent) && outer.parent.expression === outer) return true
      return false
    }
    const isFnBoundary = (n: ts.Node): boolean =>
      ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
      || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
      || ts.isConstructorDeclaration(n)
    /**
     * 函数边界处**只跟随会被交出的值**（CR 第六十六轮 major）：
     * `throw (() => { const debug = new Error('**debug**'); return new Error('clean') })()` 里
     * 变量声明的结果既不返回也不抛出，外层即使被调也抛不到它。判据：节点必须在
     * 表达式体箭头的 body 里，或在某个 `return` 的表达式里，或是被 `return` 的那个变量的
     * 初始化器。边界（如实记录）：`const e = new Error(…); e = other; return e` 这类重赋值
     * 不追 —— 会多报（更保守），不会漏。
     */
    const flowsToReturn = (fn: ts.FunctionLikeDeclaration, node: ts.Node): boolean => {
      const body = fn.body
      if (body === undefined) return false
      if (!ts.isBlock(body)) return containsNode(body, node)
      const names = new Set<string>()
      // ⚠️ **构造器里写 `this.e = <n>`也是交出**（既有匿名类样本：
      // `new (class { constructor() { this.e = new Error(…) } })().e` ——字段随即被读）。
      let viaThis = false
      for (let x: ts.Node | undefined = node; x !== undefined && x !== fn; x = x.parent) {
        const p = x.parent
        if (p !== undefined && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)
          && p.initializer !== undefined && containsNode(p.initializer, node)) names.add(p.name.text)
        if (p !== undefined && ts.isBinaryExpression(p)
          && p.operatorToken.kind === ts.SyntaxKind.EqualsToken
          && containsNode(p.right, node)) {
          const left = unwrap(p.left)
          if (ts.isPropertyAccessExpression(left)
          && left.expression.kind === ts.SyntaxKind.ThisKeyword) viaThis = true
        }
      }
      if (viaThis) return true
      let out = false
      const walk = (x: ts.Node): void => {
        if (out || (x !== body && ts.isFunctionLike(x))) return
        if (ts.isReturnStatement(x) && x.expression !== undefined) {
          const e = x.expression
          if (containsNode(e, node)) { out = true; return }
          const u = unwrap(e)
          if (ts.isIdentifier(u) && names.has(u.text)) { out = true; return }
        }
        ts.forEachChild(x, walk)
      }
      walk(body)
      return out
    }
    /**
     * 这个函数节点是否**立即执行**（`(() => …)()` / `(function () {…})()`）。
     * ⚠️ 括号也是包装：`(() => …)()` 里箭头的父节点是 `ParenthesizedExpression`，
     * 只比一层父节点会把 IIFE 误判成"没被调用"（探针实测：父=ArrowFunction 的父是括号）。
     */
    // ⚠️ 包装不止括号：`(() => …) as F)()`、`(() => …)!()`、`satisfies` 都编译成调用
    // （Codex PR#81 第二十轮 P2 追加探针：`as` / `!` / `satisfies` 三种形态原判据全漏），
    // 所以复用共享的 `unwrap`（括号 / `as` / 非空断言 / `satisfies`）。
    /** `e`（函数表达式）是否被 `new` 调用 —— 包装（括号 / 断言）不算语义。 */
    const isConstructed = (e: ts.Node): boolean => {
      let x: ts.Node = e
      for (;;) {
        const q = x.parent
        if (q === undefined) return false
        if ((ts.isParenthesizedExpression(q) || ts.isAsExpression(q) || ts.isNonNullExpression(q)
          || ts.isSatisfiesExpression(q) || ts.isTypeAssertionExpression(q)) && q.expression === x) { x = q; continue }
        return ts.isNewExpression(q) && q.expression === x
      }
    }
    const isImmediatelyInvoked = (n: ts.Node): boolean => {
      let e: ts.Expression = n as ts.Expression
      // ⚠️ 一个对象方法的**函数体**不是表达式：从方法处必须经它的**被调形态**判（由调用方传入
      // 方法节点时的 `e` 起步）。这里 `n` 只会是箭头 / 函数表达式 / 匿名类。
      for (;;) {
        const p = e.parent
        if (p !== undefined && ts.isParenthesizedExpression(p) && p.expression === e) { e = p; continue }
        // 尖括号类型断言 `<F>(() => …)` 与 `as` 同义（Codex 第二十轮追加探针），一并穿透
        if (p !== undefined && (ts.isAsExpression(p) || ts.isNonNullExpression(p)
          || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)) && p.expression === e) {
          e = p as ts.Expression
          continue
        }
        // ⚠️ 逗号表达式 `(0, f)(…)` 的被调对象是**最右**操作数（Codex PR#81 第二十五轮 P2，
        // 探针：`throw (0, () => new Error('**BAD**'))()` 真的抛 —— 下行到 ES5 的模块引用正是这形态）
        if (p !== undefined && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.CommaToken
          && p.right === e) { e = p; continue }
        // `.bind(thisArg)(…)`：绑定后再调用，函数体照样执行（Codex PR#81 第二十五轮 P2）
        {
          const bindCall = p !== undefined && ts.isCallExpression(p) && p.expression === e ? undefined : p
          const boundName = bindCall !== undefined && ts.isPropertyAccessExpression(bindCall)
            && bindCall.expression === e ? bindCall.name.text
            : bindCall !== undefined && ts.isElementAccessExpression(bindCall) && bindCall.expression === e
              ? staticAccessKey(bindCall.argumentExpression)
              : undefined
          if (boundName === 'bind' && bindCall !== undefined && bindCall.parent !== undefined
            && ts.isCallExpression(bindCall.parent) && bindCall.parent.expression === bindCall) { e = bindCall.parent; continue }
        }
        // 立即执行不止 `f(…)`：`.call(…)` / `.apply(…)` / 标签模板同样会执行到函数体
        // （Codex PR#81 第二十一轮 P2，探针：`(() => new Error('**BAD**')).call(null)` 真的抛）。
        // ⚠️ 形态是 `Call(PropertyAccess(Arrow, 'call'), …)`：箭头先经**属性访问**再到调用 ——
        // 只判 `CallExpression` 会漏（实测：样本没命中才发现的）。
        // 点号与**静态下标**写法等价：`(f)['call'](null)` 同样立即执行（Codex PR#81 第二十四轮 P2）
        const callName = p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === e
          ? p.name.text
          : p !== undefined && ts.isElementAccessExpression(p) && p.expression === e
            ? staticAccessKey(p.argumentExpression)
            : undefined
        if ((callName === 'call' || callName === 'apply')
          && p !== undefined && p.parent !== undefined && ts.isCallExpression(p.parent)
          && p.parent.expression === p) return true
        if (p !== undefined && ts.isCallExpression(p)) {
          if (p.expression === e) return true
        }
        if (p !== undefined && ts.isTaggedTemplateExpression(p) && p.tag === e) return true
        // `new (function () { return new Error(…) })()`：**函数表达式**被 `new` 调用即执行函数体
        // （CodeRabbit/Codex PR#81 第二十九轮：此前自检里的正例被另一条反例的误报抵消，总数掩盖了漏检）。
        // **箭头函数不可构造** —— `new (() => …)()` 抛的 TypeError 不是这个 Error。
        // 函数表达式被 `new` 调用（括号已在上一轮穿透，`e` 此时是括号后的那个表达式）
        if (p !== undefined && ts.isNewExpression(p) && p.expression === e && ts.isFunctionExpression(unwrap(e))) return true
        // ⚠️ 其它任何父节点都说明这个函数**没有被调用** —— 必须显式 `return false`。
        // 漏掉它会 `for (;;)` 空转（2026-11-17 实测：本文件用例卡死 10 分钟以上，
        // 探针单跑该判据才定位到）。
        // ⚠️ **当前函数值是外层函数边界的尾值**（`() => (() => …)` 的内层箭头）：`p` 是箭头函数，
        // 遍历到此处时它作为外层体被交出，外层是否被调用、其结果又是否被调，决定它是否执行。
        if (p !== undefined && isFnBoundary(p) && tailFunction(p) !== undefined) {
          if (isImmediatelyInvoked(p) && returnValueInvoked(p)) return true
        }
        return false
      }
    }
    /**
     * getter 所属的对象字面量：`throw ({ get value() { return new Error(…) } }).value` ——
     * **读取属性**就执行了 getter（Codex PR#81 第二十二轮 P2，Node 实测确实抛出该 message）。
     * 同理 `new (class { … })()` 的构造方法在 `new` 时就跑了。
     */
    const isExecutedAccessor = (fn: ts.Node): boolean => {
      // ⚠️ **函数在 getter 体里 `return` 出去、再被立即调用**（Codex PR#81 第二十八轮 P2，
      // Node 实测 `throw ({ get make() { return () => new Error('**X**') } }).make()` 真的抛）：
      // 这里 `fn` 是 getter 体里返回的那个箭头 —— 是否执行取决于**返回它的 getter** 的属性
      // 是否被读后再调用，与 getter 本身同一判据，直接转交。
      // ⚠️ 但**读 getter 只执行 getter 本身，不执行它返回的函数**（CodeRabbit/Codex PR#81 第二十九轮）：
      // `({ get make() { return () => new Error('**X**') } }).make` 只读了属性，箭头从未被调用。
      // 所以这里除「getter 被读」之外，还要求**读出来的那个函数被调用**。
      // ⚠️ 括号 / 断言包装不影响 `return` 的语义：`return (() => …)` 与 `return () => …` 一样
      // （Codex PR#81 第三十轮 P2，Node 实测 `({ get make() { return (() => new Error('**X**')) } }).make()`
      // 照样抛出）—— 先剥包装再比 `ReturnStatement`。
      const fnParent = (() => {
        let e: ts.Node = fn
        while (e.parent !== undefined && (ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent)
          || ts.isNonNullExpression(e.parent) || ts.isSatisfiesExpression(e.parent) || ts.isTypeAssertionExpression(e.parent))) e = e.parent
        return e.parent
      })()
      if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))
        && fnParent !== undefined && ts.isReturnStatement(fnParent)) {
        let g: ts.Node | undefined = fnParent.parent
        while (g !== undefined && (ts.isBlock(g) || ts.isCaseBlock(g) || ts.isCaseOrDefaultClause(g))) g = g.parent
        if (g === undefined || !ts.isGetAccessorDeclaration(g)) return false
        if (g.name === undefined) return false
        // getter 所属对象 → 属性读取处 → 该读取**被调用**
        let q: ts.Node = g
        while (q.parent !== undefined && !ts.isObjectLiteralExpression(q.parent)) q = q.parent
        if (q.parent === undefined) return false
        let o: ts.Node = q.parent
        while (o.parent !== undefined && (ts.isParenthesizedExpression(o.parent) || ts.isAsExpression(o.parent)
          || ts.isNonNullExpression(o.parent) || ts.isSatisfiesExpression(o.parent) || ts.isTypeAssertionExpression(o.parent))) o = o.parent
        const acc = o.parent
        if (acc === undefined) return false
        const name = ts.isPropertyAccessExpression(acc) ? acc.name.text
          : ts.isElementAccessExpression(acc) ? staticAccessKey(acc.argumentExpression) : undefined
        if (name === undefined || name !== accessorName(g.name)) return false
        return isImmediatelyInvoked(acc)
      }
      // 匿名类构造函数：`new (class { constructor() { return new Error(…) } })()` —— 类被 `new`
      // 实例化就执行了构造函数（Codex PR#81 第二十四轮 P2/P3）
      if (ts.isConstructorDeclaration(fn)) {
        let c: ts.Node = fn
        while (c.parent !== undefined && !ts.isClassExpression(c.parent)) c = c.parent
        if (c.parent === undefined) return false
        let k: ts.Node = c.parent
        for (;;) {
          const q = k.parent
          if (q === undefined) return false
          if ((ts.isParenthesizedExpression(q) || ts.isAsExpression(q) || ts.isNonNullExpression(q)
            || ts.isSatisfiesExpression(q) || ts.isTypeAssertionExpression(q)) && q.expression === k) { k = q; continue }
          return ts.isNewExpression(q) && q.expression === k
        }
      }
      // getter / 方法：所属对象字面量出现在 `new` / 属性读取（被访问）的表达式中
      let e: ts.Node = fn
      while (e.parent !== undefined && !ts.isObjectLiteralExpression(e.parent)) e = e.parent
      if (e.parent === undefined) return false
      const obj = e.parent
      let o: ts.Node = obj
      // 括号 / `as` / 非空断言 / `satisfies` / 尖括号断言都不改变运行语义（Codex PR#81 第二十四轮 P2）
      for (;;) {
        const q = o.parent
        if (q === undefined) break
        if ((ts.isParenthesizedExpression(q) || ts.isAsExpression(q) || ts.isNonNullExpression(q)
          || ts.isSatisfiesExpression(q) || ts.isTypeAssertionExpression(q)) && q.expression === o) {
          o = q
          continue
        }
        break
      }
      const p = o.parent
      if (p === undefined) return false
      if (ts.isNewExpression(p) && p.expression === o) return true
      // ⚠️ **对象展开会立即读取源对象的全部可枚举属性** → 源对象上的 **getter** 立刻执行
      // （Codex PR#81 第二十六轮 P2，Node 实测：`throw ({ ...{ get error() { return new Error('**BAD**') } } }).error`
      // 抛出的 message 就是 `**BAD**`）。
      // ⚠️ 但只有 **getter**：源对象里的**方法**不执行（Node 实测 `{...{ make() {…} }}` 不跑 `make`）——
      // 首版这里对展开源一律放行，会让方法体里的 `new Error` 被误报（自检反例没加星号、没咬住）；
      // 第二版只排除了方法、仍放行**箭头函数属性**（`make: () => new Error(…)`）—— 展开只读值、
      // 不调用存着的函数（CodeRabbit PR#81 第二十七轮 minor）。现在**只认 getter 声明**。
      // 只认**直接**展开：源是变量（`{...src}`）时 getter 写在哪份定义里，单文件语法树看不出来 ——
      // 如实记录为边界。
      if (ts.isSpreadAssignment(p) && p.expression === o) {
        // 展开本身只读值：getter 立刻执行，函数（箭头 / 方法 / 函数表达式）只是被复制成外壳
        // 对象的同名属性 —— 是否执行取决于**外壳对象**上的用法（Codex PR#81 第二十八轮 P2，
        // Node 实测 `({ ...{ make: () => new Error(…) } }).make()` 抛出、只读不调不抛）。
        if (ts.isGetAccessorDeclaration(fn)) return true
        const nameOf = (n: ts.PropertyName | undefined): string | undefined => n === undefined ? undefined
          : ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text
            : ts.isComputedPropertyName(n) ? staticAccessKey(n.expression) : undefined
        const innerName = ts.isPropertyAssignment(fn.parent) ? nameOf(fn.parent.name)
          : ts.isMethodDeclaration(fn) ? nameOf(fn.name) : undefined
        if (innerName === undefined) return false
        let outer: ts.Node | undefined = p.parent
        while (outer !== undefined && !ts.isObjectLiteralExpression(outer)) outer = outer.parent
        if (outer === undefined) return false
        let k: ts.Node = outer
        for (;;) {
          const q = k.parent
          if (q === undefined) return false
          if ((ts.isParenthesizedExpression(q) || ts.isAsExpression(q) || ts.isNonNullExpression(q)
            || ts.isSatisfiesExpression(q) || ts.isTypeAssertionExpression(q)) && q.expression === k) { k = q; continue }
          const acc = ts.isPropertyAccessExpression(q) ? q.name.text
            : ts.isElementAccessExpression(q) ? staticAccessKey(q.argumentExpression) : undefined
          return acc === innerName && isImmediatelyInvoked(q)
        }
      }
      // ⚠️ **读的是哪个属性**必须与 getter 名对得上（CodeRabbit PR#81 第二十四轮 minor）：
      // `({ get unused() { return new Error('**x**') }, error: new Error('clean') }).error` 只执行
      // `error`，`unused` 的 getter 从不运行 —— 原判据对任何属性读取都放行，把 `unused` 报成违规。
      const accessed = ts.isPropertyAccessExpression(p) ? p.name.text
        : ts.isElementAccessExpression(p) ? staticAccessKey(p.argumentExpression)
        : undefined
      if (accessed === undefined) return false
      // ⚠️ **方法读取只是拿到函数，不执行方法体**（Codex PR#81 第二十五轮 P2，Node 实测：
      // `({ make() { return … } }).make` 不调用 `make`）—— 方法必须**被调用**（`()` / `.call` /
      // `.apply` / `.bind()()`）才算执行；getter 则读取即执行。
      // 被调形态复用 `isImmediatelyInvoked`（`()` / `.call` / `.apply` / `.bind()()` / 逗号表达式
      // / 标签模板都认）—— 两边各写一份就会分叉。
      if (ts.isMethodDeclaration(fn)) {
        if (fn.name === undefined || accessed !== accessorName(fn.name)) return false
        return isImmediatelyInvoked(p as ts.Node)
      }
      // ⚠️ **函数字面量作为属性值**（`{ make: () => … }` / `{ make: function () {…} }`）同样只能
      // 经「读取后再调用」执行（Codex PR#81 第二十七轮 P2，Node 实测 `({ make: () => new Error('**BAD**') }).make()`
      // 真的抛）。`isExecutedAccessor` 的入口只从箭头 / 函数表达式往上找到所属对象字面量，
      // 到这里说明 `fn` 就是那个字面量本身 —— 与方法是同一判据（名字对得上 + 被调形态）。
      if (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) {
        // 属性值是字面量时 `fn.parent` 是 `PropertyAssignment`，名字在看 `obj` 之外的那一层
        let propName: ts.PropertyName | undefined
        for (let k: ts.Node | undefined = fn; k !== undefined; k = k.parent) {
          if (ts.isPropertyAssignment(k)) { propName = k.name; break }
          if (ts.isObjectLiteralExpression(k)) break
        }
        if (propName === undefined) return false
        return accessed === accessorName(propName) && isImmediatelyInvoked(p as ts.Node)
      }
      if (ts.isGetAccessorDeclaration(fn)) return fn.name !== undefined && accessed === accessorName(fn.name)
      return false
    }
    const accessorName = (n: ts.PropertyName): string | undefined => {
      if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text
      // 静态计算键 `get ['value']()` 与 `get value()` 同义（Codex PR#81 第二十四轮 P2）
      if (ts.isComputedPropertyName(n)) return staticAccessKey(n.expression)
      return undefined
    }
    const staticAccessKey = (e: ts.Expression): string | undefined => {
      const u = unwrap(e)
      return ts.isStringLiteral(u) || ts.isNoSubstitutionTemplateLiteral(u) ? u.text : undefined
    }
    // 实例字段的所在类是否被 `new`（经由括号 / 断言包装）。字段初始化器在 new 时就执行，
    // 其后即使「只返回了函数」也一样 —— `new (class { error = new Error(…) })()` 真的构造了。
    const isConstructedClassField = (p: ts.PropertyDeclaration): boolean => {
      let c: ts.Node | undefined = p.parent
      while (c !== undefined && !ts.isClassLike(c)) c = c.parent
      return c !== undefined && c.parent !== undefined && (() => {
        let k: ts.Node = c!
        for (;;) {
          const q = k.parent!
          if ((ts.isParenthesizedExpression(q) || ts.isAsExpression(q) || ts.isNonNullExpression(q)
            || ts.isSatisfiesExpression(q) || ts.isTypeAssertionExpression(q)) && q.expression === k) { k = q; continue }
          return ts.isNewExpression(q) && q.expression === k
        }
      })()
    }
    // 边界 `fn` 尾位置表达式**求值后交出的函数字面量**（`() => function () {…}` 的内层）—— 见 `resolveTail`。
    const tailFunction = (fn: ts.Node): ts.Expression | undefined => {
      const body = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)
        || ts.isMethodDeclaration(fn) || ts.isGetAccessorDeclaration(fn) || ts.isConstructorDeclaration(fn)
        ? fn.body : undefined
      if (body === undefined) return undefined
      if (!ts.isBlock(body)) return resolveTail(body)
      const last = body.statements[body.statements.length - 1]
      if (last === undefined) return undefined
      const e = ts.isReturnStatement(last) || ts.isExpressionStatement(last) ? last.expression : undefined
      return e === undefined ? undefined : resolveTail(e)
    }
    eachInvocation(sf, (n, line) => {
      if (!ts.isNewExpression(n) || !named(n, 'Error')) return
      // ⚠️ **被丢弃的表达式不算抛出**（CodeRabbit PR#81 第三十二轮 minor，自检复现）：
      // `(() => { new Error('**debug**'); return new Error('clean') })()` 里第一条只是语句表达式、
      // 结果被丢弃，真正抛的是 `clean`。只排除这一种最明确的丢弃形态（直接作为语句表达式的
      // `new`）；`return new Error(…)` / `throw new Error(…)` / 条件里的 `new` 都是「交出值」，
      // 照常往下判。逗号表达式只交出最右操作数 —— 由下面的遍历处理。
      // ⚠️ 先剥括号 / 断言包装再判（CR 第三十四轮 minor：`(new Error('**debug**'))` 的父节点是
      // ParenthesizedExpression，只看一层会把丢弃掉的报进去）
      let discarded: ts.Node = n
      while (discarded.parent !== undefined && (ts.isParenthesizedExpression(discarded.parent)
        || ts.isAsExpression(discarded.parent) || ts.isNonNullExpression(discarded.parent)
        || ts.isTypeAssertionExpression(discarded.parent) || ts.isSatisfiesExpression(discarded.parent))) discarded = discarded.parent
      if (discarded.parent !== undefined && ts.isExpressionStatement(discarded.parent) && discarded.parent.expression === discarded) return
      let up: ts.Node = n
      let blocked = false
      while (up.parent !== undefined && !ts.isThrowStatement(up.parent)) {
        const p = up.parent
        // ⚠️ **逗号表达式里非最右的操作数被丢弃**（CR 第三十五轮 minor，Node 实测
        // `throw (new Error('**debug**'), new Error('clean'))` 抛的是 clean）：被丢弃的操作数里的
        // `new Error` 永远不是抛出的那个 —— 到此为止，不算违规。最右操作数照常往上走。
        if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.CommaToken) {
          if (p.right !== up) break
          up = p
          continue
        }
        // ⚠️ **类的实例字段初始化器只在类被实例化时执行**（Codex PR#81 第三十轮 P2，Node 实测
        // `throw Object.assign(new Error('clean'), { factory: class { error = new Error('**X**') } })`
        // 输出里没有 X）：只看类表达式有没有被 `new`，不能直接穿过去。
        if (ts.isPropertyDeclaration(p)) {
          const constructed = isConstructedClassField(p)
          // 静态字段在类定义时就求值（`class K { static s = new Error(…) }`）—— 照常穿过
          const isStatic = (p.modifiers ?? []).some((m) => m.kind === ts.SyntaxKind.StaticKeyword)
          if (!isStatic && !constructed) { blocked = true; break }
          up = p
          continue
        }
        const isBoundary = isFnBoundary(p) || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p)
          || ts.isConstructorDeclaration(p)
        if (isBoundary && !isImmediatelyInvoked(p) && !isExecutedAccessor(p)) { blocked = true; break }
 // ⚠️ **被立即调用的边界也只跟随「交出的值」**（CR第六十六轮 major）：
 // `(() => { const debug = new Error('**debug**'); return new Error('clean') })()`里
 //变量声明的结果既不返回也不抛出 ——外层执行它也不会抛它。只有落在 return表达式 /
 //表达式体箭头 body /被 return的变量初始化器里，才继续往上判。
 // ⚠️ 判据用**原始 new 节点**（n），不是正在跨越边界的子节点（`up` 在块体函数处是
 // Block 本身，拿它去比 return 表达式永远为假）。
        if (isFnBoundary(p) && !flowsToReturn(p as ts.FunctionLikeDeclaration, n)) { blocked = true; break }
        // ⚠️ 走到**函数边界**时，内层函数字面量就是 `up`。内层处在边界的**尾位置**（表达式体箭头本身 /
        // 块体最后一条 `return <n>`）时，它只是被**返回**，外层被调用也不执行它：
        // `({ make: () => function () { return new Error('**X**') } }).make()`（CodeRabbit PR#81 第三十一轮
        // minor，Node 实测不抛）。被**调**（`(() => function () { … })()`）或嵌在别处
        // （`() => ({ make: () => new Error(…) })`）都不算。类**被实例化**的实例字段不在此列 ——
        // 字段初始化器在 new 时就跑了（`new (class { error = new Error(…) })()` 真的构造）。
        if (isFnBoundary(p)) {
          // 边界的尾值是**函数字面量**时，它只是被交出 —— 外层被调不执行它：
          // `() => function () { return new Error(…) }`（内层函数表达式）与 `() => (() => new Error(…))`
          // （内层箭头，`up` 在其体内）都算。⚠️ 边界体本身是 `() => new Error(…)` 时 `up` 就是被求值的
          // 那个 `new`（尾值是数据不是函数），不算；嵌在**非尾值**处（`() => ({ make: () => new Error(…) })`）
          // 也不执行（那由「尾值不是函数」自然放行，后续调用由 isImmediatelyInvoked 判）。
          const tailFn = tailFunction(p)
          // ⚠️ **元素级 + 祖先级**：尾值函数 `tailFn` 只是被**交出**，外层被调也不执行它自身 —— 而 `up`
          // 在它的体内（`() => function () { return new Error(…) }`）同样不执行。祖先级不会误伤「尾值是
          // 数据」的形态（`() => new Error(…)` 的尾值是 `new`，不是函数），因此只在 `tailFn` 是函数时生效。
          const innerFn = unwrap(up as ts.Expression)
          // ⚠️ 例外（CR 第三十五轮 minor）：边界被调、**它的返回值又被调用**时，尾函数不是「被交出」而是
          // 被执行 —— `throw (() => () => new Error('**X**'))()()` 与 `(…)().call(null)` 都真抛 X。
          // 只调外层（`(() => () => new Error(…))()`）仍是反例：返回值被丢弃，尾函数不执行。
          const tailExecuted = returnValueInvoked(p)
          if (!tailExecuted && tailFn !== undefined && (tailFn === up || tailFn === innerFn || containsNode(tailFn, up))) {
            blocked = true
            break
          }
        }
        up = p
      }
      if (blocked || up.parent === undefined || !ts.isThrowStatement(up.parent)) {
        return
      }
      const why = starsIn(argsOf(n))
      if (why !== undefined) out.push(`L${line}  ${why}`)
    })
    return out
  },
}

/** `process.stderr.write('…')` 的**直接实参**里没有 `**`（绕过 usageFail 的手写出口）。 */
const STDERR_WRITE: Rule = {
  name: 'process.stderr.write',
  hit: (sf) => {
    const out: string[] = []
    eachInvocation(sf, (n, line) => {
      if (!ts.isCallExpression(n) || !named(n, 'process', 'stderr', 'write')) return
      const [first] = argsOf(n)
      if (first === undefined) return
      const why = starsIn([first])
      if (why !== undefined) out.push(`L${line}  ${why}`)
    })
    return out
  },
}

/**
 * 顶层 `const X_USAGE = <初始化表达式>` 里的字面量没有 `**`（help 走 stdout，但它是纯文本）。
 * 模板的 `${…}` 是代码，其中字面量照收 —— 它们最终同样进 help 文本。
 */
const USAGE_CONST: Rule = {
  name: 'USAGE 常量',
  hit: (sf) => {
    const out: string[] = []
    for (const st of sf.statements) {
      if (!ts.isVariableStatement(st)) continue
      for (const d of st.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !/USAGE/.test(d.name.text) || d.initializer === undefined) continue
        const texts = literalTexts(d.initializer)
        // 常量初始化表达式本身或**其中任何子表达式**可能是拼接 —— 逐个可静态求值处都试一次
        texts.push(...concatTexts(d.initializer))
        if (!texts.some((t) => t.includes('**'))) continue
        out.push(`L${lineOf(sf, d)}  ${d.name.text} = `
          + texts.filter((t) => t.includes('**')).join(' | ').replace(/\s+/g, ' ').slice(0, 120))
      }
    }
    return out
  },
}

const RULES: readonly Rule[] = [USAGE_FAIL, THROW_ERROR, STDERR_WRITE, USAGE_CONST]

/** 扫全仓（只跑一条规则）。 */
function scanTree(rule: Rule): Hit[] {
  const hits: Hit[] = []
  for (const f of walk(SRC)) {
    const sf = parseTs(readFileSync(f, 'utf8'), relative(ROOT, f))
    for (const why of rule.hit(sf)) hits.push({ file: relative(ROOT, f), line: 0, snippet: why })
  }
  return hits
}

const fmtHit = (h: Hit): string => `${h.file}:${h.snippet}`

describe('纯文本通道（stderr 与 help）不得出现 Markdown 标记 —— 全仓静态扫描', () => {
  it('`usageFail(...)` 的参数里没有 `**`', () => {
    // `usageFail` 把 message **逐字**写进 stderr（`process.stderr.write(safe)`），
    // 终端里四个星号就是四个星号。
    const hits = scanTree(USAGE_FAIL)
    expect(hits.map(fmtHit), `这些 usageFail 的文案里含 Markdown 标记（会原样进终端）：\n${hits.map(fmtHit).join('\n')}`)
      .toEqual([])
  })

  it('`throw new Error(...)` / `throw Object.assign(new Error(...))` 的参数里没有 `**`', () => {
    // 实测来源：`assertGetHasNoBody` 的文案曾含 `**目前没有 GET 的 query 参数通道**`，
    // 全仓没有任何测试能发现它 —— 本文件就是那次实测补上的。
    // ⚠️ 必须允许跨行（CodeRabbit 2026-10-26）：真实的 `throw Object.assign(` + `new Error(…)`
    // 是分行写的，旧正则用 `[^;\n]` 时那两个真实调用点**完全不生效**。AST 判据没有这个问题。
    const hits = scanTree(THROW_ERROR)
    expect(hits.map(fmtHit), `这些 throw 的文案里含 Markdown 标记：\n${hits.map(fmtHit).join('\n')}`)
      .toEqual([])
  })

  it('`process.stderr.write(...)` 的直接实参里没有 `**`', () => {
    // 绕过 `usageFail` 的手写出口（`callOne` catch、`query/errors.ts`、`config.ts` 的
    // 权限警告…）—— 它们同样是纯文本通道。
    const hits = scanTree(STDERR_WRITE)
    expect(hits.map(fmtHit), `这些直接写 stderr 的文案里含 Markdown 标记：\n${hits.map(fmtHit).join('\n')}`)
      .toEqual([])
  })

  it('`USAGE` / `*_USAGE` 常量里没有 `**`（help 走 stdout，但它是纯文本）', () => {
    // 实测来源：`sync --help` 的「安装前置：**至少成功同步过一次**」曾原样打到终端。
    const hits = scanTree(USAGE_CONST)
    expect(hits.map(fmtHit), `这些 help 文本里含 Markdown 标记：\n${hits.map(fmtHit).join('\n')}`)
      .toEqual([])
  })

  it('扫描器自身有牙：四条规则**各自**都能抓到合成违规，且不被相邻形态骗到', () => {
    // ⚠️ 没有这一条，上面四条可能是「扫了个空」（walk 路径写错、解析出的树里没有调用）。
    // ⚠️ 必须**逐条规则**断言「它自己命中」—— 第一版丢了这条，扫描器只收 CallExpression、
    // `new Error(…)`（NewExpression）一条都收不到，而真实全仓扫描照样全绿（空转）。
    // 每条样本里既有真违规、也有同形的「非违规」（字符串 / 注释里的同名文本），
    // 双向断言：命中数必须**恰好**是真违规的个数。
    const fake = [
      "usageFail('错误：**不要这样**')",                              // USAGE_FAIL 命中 1
      "usageFail('干净文案')",                                        // 不命中
      'const s = "usageFail(\'**假**\')"',                          // 字符串里，不算
      "throw new Error('崩溃：**别**')",                              // THROW 命中 1
      "throw Object.assign(\n  new Error('跨行：**也别**'),\n  { code: 'usage' })", // 跨行也命中
      "const e = new Error('非抛出：**不算**')",                       // 不是 throw，不算
      // 函数边界内的 new Error 不在执行路径上（CR 第十九轮）：工厂回调里的 message 永远不会被抛出
      "throw Object.assign(new Error('干净'), { makeError: () => new Error('**未抛出**') })",
      "throw Object.assign(new Error('干净2'), { factory: class { error = new Error('**未实例化的类字段**') } })",
      // 立即调用的 IIFE **会**执行，里面的 Error 就是被抛出的那个（Codex 第二十轮 P2）
      "throw (() => new Error('**立即执行**'))()",
      "throw ((() => new Error('**断言包装**')) as () => Error)()",
      // 反例：函数体里先丢弃一个 `new Error('**debug**')`（表达式语句），真正抛的是 `clean`
      "throw (() => { new Error('**被丢弃**'); return new Error('clean') })()",
      // 括号包装的丢弃同样不算（CR 第三十四轮 minor）
      "throw (() => { (new Error('**括号包裹被丢弃**')); return new Error('clean') })()",
      // CR 第六十六轮 major：块体箭头里 `new Error` 只用于变量声明、且变量从不 return → 不交出
      "throw (() => { const debug66 = new Error('**变量声明丢弃**'); return new Error('clean') })()",
      // 正向：变量被 return、以及 if 分支里的 return 都真交出（同一判据不能只看表达式体箭头）
      "throw (() => { const e66 = new Error('**变量后返回**'); return e66 })()",
      "throw (() => { if (1) return new Error('**条件返回**') })()",
      // 逗号表达式里非最右操作数被丢弃（CR 第三十五轮 minor）：抛的是 clean
      "throw (new Error('**逗号丢弃**'), new Error('clean'))",
      "throw ((() => new Error('**非空断言**'))!)()",
      "throw (<() => Error>(() => new Error('**尖括号断言**')))()",
      "throw (() => new Error('**call 立即执行**')).call(null)",
      "throw ({ get value() { return new Error('**getter**') } }).value",
      "throw (() => new Error('**下标 call**'))['call'](null)",
      "throw ({ get ['value2']() { return new Error('**计算键 getter**') } }).value2",
      "throw (({ get value3() { return new Error('**as 包装**') } }) as { value3: Error }).value3",
      "throw new (class { constructor() { this.e = new Error('**匿名类**') } })().e",
      "throw ({ get unused() { return new Error('**unused**') }, error: new Error('clean') }).error",
      // getter 返回函数、再被立即调用（Codex PR#81 第二十八轮 P2，Node 实测抛出）
      "throw ({ get make() { return () => new Error('**getter 返回后调用**') } }).make()",
      // 同上，但 `return` 的函数**带括号**（Codex PR#81 第三十轮 P2，Node 实测抛出）
      "throw ({ get make() { return (() => new Error('**getter 返回的函数带括号后被调用**')) } }).make()",
      // 反例：属性值是**返回函数的函数**，只调了外层 —— 内层函数从未执行（CodeRabbit PR#81 第三十一轮 minor）。
      // ⚠️ 内层用**函数表达式**：内层箭头 `() => new Error(…)` 的 `**` 文本嵌在外层箭头的体里，
      // 「字面量文本」那一步会把它算进**外层调用**（`make()`）的实参子树 —— 报它属于「调用实参里的
      // 字面量」这条既有规则，与本条无关；内层是函数表达式时文本只属于内层。
      "throw ({ make: () => function () { return new Error('**只调外层FN**') } }).make()",
      // 属性值是「返回函数的函数」的两种函数体形态：内层函数**只拿到没调用**，不得算执行
      "throw ({ make: () => { return function () { return new Error('**只调外层A**') } } }).make()",
      "throw ({ make: () => (() => new Error('**只调外层B**')) }).make()",
      // 类**被实例化** → 实例字段初始化器执行（`new (class { … })()` 时字段在构造里求值）
      "throw (new (class { error = new Error('**类被实例化**') })()).error",
      // 静态字段在**类定义时**求值，与实例化无关
      "throw (class { static error = new Error('**静态字段**') }).error",
      // 反例：类只被当作值保存、从未 `new` → 实例字段初始化器不执行（Codex PR#81 第三十轮 P2，Node 实测）
      // 展开源里的函数属性，在**外壳对象**上被调用（Node 实测抛出）
      "throw ({ ...{ make: () => new Error('**展开后被调用**') } }).make()",
      // 函数表达式作 `new` 的被调方（Codex PR#81 第二十八轮 P3 报的形态）。Node 实测确实抛出；
      // 判据由既有路径覆盖（加专用分支后变异**不**变红 —— 等价覆盖，如实记录）。
      "throw new (function () { return new Error('**new 函数表达式**') })()",
      // 反例：getter 返回的函数**只读不调** —— 不执行
      "throw Object.assign(new Error('cleanG'), { v: ({ get make() { return () => new Error('**getter 只读**') } }).make })",
      // 对象展开立即读取源对象的全部属性 → getter 立刻执行（Codex PR#81 第二十六轮 P2，Node 实测抛出）
      "throw ({ ...{ get error() { return new Error('**展开执行 getter**') } } }).error",
      // 反例：展开的源里只有**方法**（方法不执行），且读的是数据属性 —— 不算
      "throw ({ ...{ make() { return 1 } }, error: new Error('clean3') }).error",
      // 反例（带星号）：展开源里的**方法体**里有 `new Error` 但方法从不执行 —— 必须不报
      "throw ({ ...{ make() { return new Error('**展开里的方法**') } }, error: new Error('clean4') }).error",
      // 反例（带星号）：展开源里的**箭头函数属性**同样不执行 —— 必须不报
      "throw ({ ...{ make: () => new Error('**展开里的箭头**') }, error: new Error('clean5') }).error",
      // 正例：属性值上的箭头 / 函数表达式，读取后**调用**才执行（Codex PR#81 第二十七轮 P2，Node 实测）
      "throw ({ make: () => new Error('**属性箭头**') }).make()",
      "throw ({ make: function () { return new Error('**属性函数表达式**') } }).make()",
      // 反例（带星号）：同一属性**只读不调** —— 不执行
      "throw Object.assign(new Error('cleanArrow'), { v: ({ make: () => new Error('**属性箭头未调用**') }).make })",
      // 反例（带星号）：展开源里的**函数表达式属性**同理
      "throw ({ ...{ make: function () { return new Error('**展开里的函数表达式**') } }, error: new Error('clean6') }).error",
      // 立即执行的派生形态（Codex PR#81 第二十五轮 P2，Node 实测三条都真的抛）
      // 反例（如实记录）：`.call` 链在**尾值位置**不被穿透 —— 外层箭头的尾值是 `.call(…)` 调用的结果，
      // 内层箭头只是被调用的对象；合并样本里实测不命中。单独成文件时是否命中不由本样本承诺。
      "throw (() => (() => new Error('**call 链内层**'))).call(null)",
      "throw (() => new Error('**bind 立即执行**')).bind(null)()",
      "throw (0, () => new Error('**逗号立即执行**'))()",
      "throw ({ make() { return new Error('**方法被调用**') } }).make()",
      // 反例：**只存方法引用、不调用** —— 方法体从不执行（Codex PR#81 第二十五轮 P2）
      "throw Object.assign(new Error('clean2'), { factory: ({ make() { return new Error('**方法引用**') } }).make })",
      "process.stderr.write('警告：**注意**')",                        // STDERR 命中 1
      "process.stderr.write(`模板：${a}**尾**`)",                      // 模板字面段命中
      "const X_USAGE = `用法：**粗体**`",                              // USAGE_CONST 命中 1
      "const NOT_LABEL = '**不算**'",                                  // 名字不含 USAGE
      "usageFail('*' + '*bad*' + '*')",                                // 常量拼接：单段无 **，拼起来有（CR 第十三轮）
      "process.stderr.write('告' + '警' + '*' + '*' + 'x' + '*' + '*')",  // 同上，stderr 通道
      "const CONCAT_USAGE = '用法：' + '*粗' + '*体*' + '*'",           // 同上：**单段都不含 `**`**，只有拼接结果含
      "usageFail(prefix + '*')",                                       // 含变量：拼接结果不在静态边界内，不算
      "process.stderr\n  .write('换行点号：**x**')",                     // 跨行属性访问（CR 第十四轮）
      "process.stderr?.write('可选链：**y**')",                          // 可选链（同上）
      "process.stderr['write']('下标：**z**')",                          // 字面量下标访问（CR 第十五轮）
      "usageFail(`前缀 ${'*' + '*bad2*' + '*'}`)",                       // 模板插值里的常量拼接（同上）
      'usageFail(`outer ${String(`)`)} **bad**`)',                    // 嵌套模板：真调用、星号在字面段
    ].join('\n')
    const sf = parseTs(fake)
    expect(USAGE_FAIL.hit(sf),
      'usageFail 规则：字面量 + 嵌套模板 + 常量拼接 + 插值里的常量拼接；含变量那条不算').toHaveLength(4)
    const throwHits = THROW_ERROR.hit(sf)
    // ⚠️ **逐条断言**（CodeRabbit/Codex PR#81 第二十九轮）：只断言总数时，「一条漏检 + 一条误报」
    // 会互相抵消，总数照样对 —— 本文件就出现过（`new (function(){…})()` 漏检被 getter 只读误报
    // 抵消）。
    const _set = new Set(throwHits.map((h) => Number(h.slice(1).split(' ')[0])))
    const _lines = fake.split('\n')
    const _byKey = (k: string): number => _lines.findIndex((l) => l.startsWith(k) || (l.startsWith('throw ') && l.includes(k))) + 1
    const _keys: Array<[string, boolean]> = [
      ['**getter 返回后调用**', true], ['**getter 返回的函数带括号后被调用**', true], ['**类被实例化**', true],
      ['**静态字段**', true], ['**展开后被调用**', true], ['**new 函数表达式**', true], ['**属性箭头**', true],
      ['**属性函数表达式**', true], ['**方法被调用**', true], ['**bind 立即执行**', true], ['**逗号立即执行**', true],
      ['**立即执行**', true], ['**getter**', true], ['**匿名类**', true], ['**展开执行 getter**', true],
      ['**断言包装**', true], ['**非空断言**', true], ['**尖括号断言**', true], ['**call 立即执行**', true],
      ['**下标 call**', true], ['**计算键 getter**', true], ['**as 包装**', true],
      ['**未抛出**', false], ['**未实例化的类字段**', false], ['**只调外层FN**', false], ['**只调外层A**', false],
      ['**只调外层B**', false], ['**getter 只读**', false], ['**展开里的方法**', false], ['**展开里的箭头**', false],
      ['**展开里的函数表达式**', false], ['**属性箭头未调用**', false], ['**方法引用**', false], ['**unused**', false],
      ['**call 链内层**', false], ['**被丢弃**', false], ['**括号包裹被丢弃**', false],
 ['**变量声明丢弃**', false], ['**变量后返回**', true], ['**条件返回**', true],
      ['**逗号丢弃**', false],
      ['const e = new Error', false],
    ]
    const _bad = _keys.map(([k, want]) => [k, _byKey(k), want, _set.has(_byKey(k))] as const)
      .filter(([k, ln, want, got]) => ln === 0 || got !== want)
      .map(([k, ln]) => k + '@' + ln)
    // 已列样本必须**各自**命中/不命中（行级核对，不靠总数：漏检 + 误报会互相抵消）。
    expect(_bad, `样本逐条不符：${JSON.stringify(_bad)}`).toEqual([])
    // 正例逐个**单独成文件**再扫一次：确认每条违规自身就足以命中（不靠相邻样本的行号/拼接）
    const srcOf = (key: string): string => _lines.find((l) => l.startsWith('throw ') && l.includes(key)) ?? ''
    // ⚠️ 「本次调用**交出**的函数再被调用」（CR 第三十五轮 minor，Node 实测两条都真抛）：
    // `(() => () => new Error(…))()()` / `(…)().call(null)`。没放进上面的合并样本 —— 合并源码里
    // 外层实参里的箭头在**其它**判据里会被当成「被交出、未调用」，本组只钉住「单独成立时命中」。
    for (const pos of ["(() => () => new Error('**返回的函数被调用**'))()()",
      "(() => () => new Error('**call 链返回的函数被调用**'))().call(null)"]) {
      expect(THROW_ERROR.hit(parseTs(`throw ${pos}`)), `正例必须命中：${pos}`).toHaveLength(1)
    }
    for (const pos of ['**getter 返回后调用**', '**getter 返回的函数带括号后被调用**', '**类被实例化**',
      '**静态字段**', '**展开后被调用**', '**new 函数表达式**',
      '**属性箭头**', '**属性函数表达式**', '**方法被调用**', '**bind 立即执行**', '**逗号立即执行**',
      '**立即执行**', '**getter**', '**匿名类**', '**展开执行 getter**']) {
      expect(THROW_ERROR.hit(parseTs(`throw ${srcOf(pos).replace(/^\s*throw\s*/, '')}`)),
        `正例必须命中：${pos}`).toHaveLength(1)
    }
    for (const neg of ['**getter 只读**', '**属性箭头未调用**', '**方法引用**', '**展开里的方法**',
      '**展开里的箭头**', '**展开里的函数表达式**', '**未抛出**', '**未实例化的类字段**', '**只调外层FN**',
      // 两条「只调外层」的关键用法：内层函数字面量在**尾位置**（块体尾 `return` / 表达式体）。Node 实测均不抛内层 message。
      // ⚠️ 不换成 `() => () => …`：`**` 文本嵌在外层箭头体里，「调用实参文字面量」那条规则会把它算进 `make()` 的实参，
      // 与本条判据无关（如实记录，本组只钉住尾位置判据）
      '**只调外层A**', '**只调外层B**']) {
      expect(THROW_ERROR.hit(parseTs(srcOf(neg))), `反例必须不命中：${neg}`).toEqual([])
    }
    expect(STDERR_WRITE.hit(sf),
      'stderr 规则：字符串 + 模板 + 常量拼接 + 跨行 + 可选链 + 下标访问各一条').toHaveLength(6)
    expect(USAGE_CONST.hit(sf), 'USAGE 常量规则：名字带 USAGE 的顶层 const，含拼接那条').toHaveLength(2)
    // 注释里的 `**` 不是字面量；模板里的字面段是（这条钉住 literalTexts 的两半）
    const cmt = parseTs('// **这是注释**\nconst a = `x **y** ${z}`')
    expect(literalTexts(cmt).filter((t) => t.includes('**'))).toEqual(['x **y** '])
  })
})
