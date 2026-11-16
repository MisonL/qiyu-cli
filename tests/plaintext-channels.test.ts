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
const THROW_ERROR: Rule = {
  name: 'throw new Error',
  hit: (sf) => {
    const out: string[] = []
    const isFnBoundary = (n: ts.Node): boolean =>
      ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)
      || ts.isMethodDeclaration(n) || ts.isGetAccessorDeclaration(n) || ts.isSetAccessorDeclaration(n)
      || ts.isConstructorDeclaration(n)
    /**
     * 这个函数节点是否**立即执行**（`(() => …)()` / `(function () {…})()`）。
     * ⚠️ 括号也是包装：`(() => …)()` 里箭头的父节点是 `ParenthesizedExpression`，
     * 只比一层父节点会把 IIFE 误判成"没被调用"（探针实测：父=ArrowFunction 的父是括号）。
     */
    // ⚠️ 包装不止括号：`(() => …) as F)()`、`(() => …)!()`、`satisfies` 都编译成调用
    // （Codex PR#81 第二十轮 P2 追加探针：`as` / `!` / `satisfies` 三种形态原判据全漏），
    // 所以复用共享的 `unwrap`（括号 / `as` / 非空断言 / `satisfies`）。
    const isImmediatelyInvoked = (n: ts.Node): boolean => {
      let e: ts.Expression = n as ts.Expression
      for (;;) {
        const p = e.parent
        if (p !== undefined && ts.isParenthesizedExpression(p) && p.expression === e) { e = p; continue }
        // 尖括号类型断言 `<F>(() => …)` 与 `as` 同义（Codex 第二十轮追加探针），一并穿透
        if (p !== undefined && (ts.isAsExpression(p) || ts.isNonNullExpression(p)
          || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)) && p.expression === e) {
          e = p as ts.Expression
          continue
        }
        // 立即执行不止 `f(…)`：`.call(…)` / `.apply(…)` / 标签模板同样会执行到函数体
        // （Codex PR#81 第二十一轮 P2，探针：`(() => new Error('**BAD**')).call(null)` 真的抛）。
        // ⚠️ 形态是 `Call(PropertyAccess(Arrow, 'call'), …)`：箭头先经**属性访问**再到调用 ——
        // 只判 `CallExpression` 会漏（实测：样本没命中才发现的）。
        if (p !== undefined && ts.isPropertyAccessExpression(p) && p.expression === e
          && (p.name.text === 'call' || p.name.text === 'apply')
          && p.parent !== undefined && ts.isCallExpression(p.parent) && p.parent.expression === p) return true
        if (p !== undefined && ts.isCallExpression(p)) {
          if (p.expression === e) return true
        }
        if (p !== undefined && ts.isTaggedTemplateExpression(p) && p.tag === e) return true
        // ⚠️ 其它任何父节点都说明这个函数**没有被调用** —— 必须显式 `return false`。
        // 漏掉它会 `for (;;)` 空转（2026-11-17 实测：本文件用例卡死 10 分钟以上，
        // 探针单跑该判据才定位到）。
        return false
      }
    }
    /**
     * getter 所属的对象字面量：`throw ({ get value() { return new Error(…) } }).value` ——
     * **读取属性**就执行了 getter（Codex PR#81 第二十二轮 P2，Node 实测确实抛出该 message）。
     * 同理 `new (class { … })()` 的构造方法在 `new` 时就跑了。
     */
    const isExecutedAccessor = (fn: ts.Node): boolean => {
      // getter / 方法：所属对象字面量出现在 `new` / 属性读取（被访问）的表达式中
      let e: ts.Node = fn
      while (e.parent !== undefined && !ts.isObjectLiteralExpression(e.parent)) e = e.parent
      if (e.parent === undefined) return false
      const obj = e.parent
      let o: ts.Node = obj
      while (o.parent !== undefined && ts.isParenthesizedExpression(o.parent)) o = o.parent
      const p = o.parent
      if (p === undefined) return false
      if (ts.isPropertyAccessExpression(p) && p.expression === o) return true
      if (ts.isElementAccessExpression(p) && p.expression === o) return true
      if (ts.isNewExpression(p) && p.expression === o) return true
      return false
    }
    eachInvocation(sf, (n, line) => {
      if (!ts.isNewExpression(n) || !named(n, 'Error')) return
      let up: ts.Node = n
      let blocked = false
      while (up.parent !== undefined && !ts.isThrowStatement(up.parent)) {
        const p = up.parent
        const isBoundary = isFnBoundary(p) || ts.isMethodDeclaration(p) || ts.isGetAccessorDeclaration(p)
        if (isBoundary && !isImmediatelyInvoked(p) && !isExecutedAccessor(p)) { blocked = true; break }
        up = p
      }
      if (blocked || up.parent === undefined || !ts.isThrowStatement(up.parent)) return
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
      // 立即调用的 IIFE **会**执行，里面的 Error 就是被抛出的那个（Codex 第二十轮 P2）
      "throw (() => new Error('**立即执行**'))()",
      "throw ((() => new Error('**断言包装**')) as () => Error)()",
      "throw ((() => new Error('**非空断言**'))!)()",
      "throw (<() => Error>(() => new Error('**尖括号断言**')))()",
      "throw (() => new Error('**call 立即执行**')).call(null)",
      "throw ({ get value() { return new Error('**getter**') } }).value",
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
    expect(THROW_ERROR.hit(sf), 'throw 规则：单行 + 跨行 + IIFE 四种包装各一条；非 throw 的 new Error 与'
      + '未调用的回调里的 new Error 不算').toHaveLength(8)
    expect(STDERR_WRITE.hit(sf),
      'stderr 规则：字符串 + 模板 + 常量拼接 + 跨行 + 可选链 + 下标访问各一条').toHaveLength(6)
    expect(USAGE_CONST.hit(sf), 'USAGE 常量规则：名字带 USAGE 的顶层 const，含拼接那条').toHaveLength(2)
    // 注释里的 `**` 不是字面量；模板里的字面段是（这条钉住 literalTexts 的两半）
    const cmt = parseTs('// **这是注释**\nconst a = `x **y** ${z}`')
    expect(literalTexts(cmt).filter((t) => t.includes('**'))).toEqual(['x **y** '])
  })
})
