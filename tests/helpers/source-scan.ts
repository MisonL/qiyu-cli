// tests/helpers/source-scan.ts
//
// 静态扫描的**共用**工具。判据一律建在 TypeScript 编译器给出的**语法树**上。
//
// ⚠️ 为什么用 AST 而不是手写词法器（2026-11-16 的收敛结论，PR#81 第七~九轮 20+ 条审查
// 全部打在同一个东西上）：前几版是手写扫描 —— 跳字符串 / 模板 / 正则 / 注释、按字符配对
// 括号。每一轮修完，下一轮又从邻角冒出一个新形态：
//   `const x = ')'` 里的括号、正则 `/)/`、`` `${`a)`}` `` 的嵌套反引号、插值里的注释
//   `/* } */`、`'a' + 'b'` 串起来的调用名、带返回类型的箭头 `async (): X =>` …
// 这些都是「把文本当代码看」的固有误差，手工近似永远差一格。TypeScript 本来就在
// devDependencies 里，解析耗时毫秒级，而且它对「这是不是一次调用」「这个字面量的内容
// 是什么」「这个参数是不是箭头函数」给的是**精确**答案 —— 不需要近似。
//
// 判据的边界因此变成**语言层面的、可陈述的**：例如「hook 调用的实参子树里有没有对
// 调度原语的 CallExpression」——字符串里的同名文本自然不算，插值里的真调用自然算。
// 剩下的边界只有一条：**反射**（`globalThis['set' + 'Timeout'](...)`）与跨模块转调，
// 静态看不懂 —— 如实写在各自的判据注释里。

import ts from 'typescript'

/** 解析一段源码。⚠️ 语法错误**直接抛**（而不是返回一棵残缺的树静默漏扫）。 */
export function parseTs(text: string, label = 'scan.ts'): ts.SourceFile {
  const sf = ts.createSourceFile(label, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  // `parseDiagnostics` 是 SourceFile 的**内部**字段（@types 没导出），运行时可读 —— 按 unknown 取。
  const diags = (sf as unknown as { parseDiagnostics?: readonly ts.Diagnostic[] }).parseDiagnostics ?? []
  const d = diags[0]
  if (d !== undefined) {
    const at = sf.getLineAndCharacterOfPosition(d.start ?? 0)
    throw new Error(`${label}:${at.line + 1}:${at.character + 1} 解析失败 —— `
      + `静态扫描要求被扫文件语法正确：${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`)
  }
  return sf
}

/** 1 起始的行号。 */
export function lineOf(sf: ts.SourceFile, node: ts.Node): number {
  return sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
}

/**
 * 深度优先收集节点子树里全部调用表达式（含链式写法的每一层，以及带类型实参 /
 * 非空断言包装的 `f<T>(…)` / `f<T>!(…)`）。
 * ⚠️ 注册点**两种怎么找到**：
 *   ① 它自己是个 CallExpression（`it.concurrent(…)`、`it(名, 选, 体)`）；
 *   ② 它是**被调用的对象**（标签模板 `it.concurrent.each\`\`(名, 选, 体)` 的内层 —— 外层是
 *      CallExpression，被调的 expression 是 TaggedTemplateExpression，见 `callChain`）。
 *      这种内层节点自己不是外层调用，所以由调用方用 `isInvoked(node)` 决定要不要算（本仓库
 *      没有这种写法，判据按「每个调用节点独立判」写 —— 遇到时 `callChain` 已能穿透标签模板）。
 */
export function collectCalls(root: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) out.push(n)
    ts.forEachChild(n, walk)
  }
  walk(root)
  return out
}

/**
 * 该节点是不是**某个调用 / 标签模板的被调对象**（链式登记的内层）。
 * ⚠️ 包装不改变「被调用」这一事实：`(f)(…)`、`f as T` 的调用 `(f as T)(…)`、
 * `f!()`、`<T>f()`、`f satisfies T` 的调用 —— 它们编译后都是 `f(…)`。
 * 只比一层父节点会把这些全判成"没被调用"（Codex PR#81 第二十轮 P2，同族缺陷）。
 */
export function isInvoked(node: ts.Node): boolean {
  let e: ts.Node = node
  for (;;) {
    const p: ts.Node | undefined = e.parent
    if (p === undefined) return false
    if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isTypeAssertionExpression(p)
      || ts.isNonNullExpression(p) || ts.isSatisfiesExpression(p)) {
      if (p.expression !== e) return false
      e = p
      continue
    }
    if (ts.isCallExpression(p)) return p.expression === e
    if (ts.isTaggedTemplateExpression(p)) return p.tag === e
    return false
  }
}

/** 剥掉括号 / 类型断言 / 非空断言等**不改变运行语义**的包装。 */
export function unwrap(node: ts.Expression): ts.Expression {
  let n = node
  while (
    ts.isParenthesizedExpression(n) || ts.isAsExpression(n)
    || ts.isTypeAssertionExpression(n) || ts.isNonNullExpression(n) || ts.isSatisfiesExpression(n)
  ) n = n.expression
  return n
}

/** 字面量下标访问的键（`obj['f']` / ``obj[`f`]`` 与 `obj.f` 同义）；非静态键返回 undefined。 */
export function staticKey(node: ts.Expression): string | undefined {
  const k = unwrap(node)
  if (ts.isStringLiteral(k) || ts.isNoSubstitutionTemplateLiteral(k)) return k.text
  return undefined
}

/**
 * 被调表达式的**静态**名字链：标识符 / 属性访问（`globalThis.setTimeout` → 两段）。
 * 基座是调用（`it.skipIf(false).concurrent`）时**只取穿透之上的名字链**由 `callChain` 负责 ——
 * 本函数遇到它返回 undefined（不谎报一半的链）。
 * ⚠️ 字面量下标访问与点号同义（`process.stderr['write']`、`it['concurrent']`）—— 不认它就把
 * 「合法写法」错判成「认不出来」，守卫静默漏掉那次调用（Codex PR#81 第十七轮 P2，探针复现）。
 */
export function calleeChain(node: ts.Expression): string[] | undefined {
  const u = unwrap(node)
  if (ts.isIdentifier(u)) return [u.text]
  if (ts.isPropertyAccessExpression(u)) {
    const base = calleeChain(u.expression)
    return base === undefined ? undefined : [...base, u.name.text]
  }
  if (ts.isElementAccessExpression(u)) {
    const k = staticKey(u.argumentExpression)
    if (k === undefined) return undefined
    const base = calleeChain(u.expression)
    return base === undefined ? undefined : [...base, k]
  }
  // 逗号表达式 `(0, setTimeout)(…)`：值就是**最右**那个操作数（TS 下行到 ES5 时模块引用
  // 就是这种形态，`(0, obj.method)(…)` 保住 this 语义但被调函数不变）—— Codex PR#81
  // 第十八轮 P2，探针证实 hook 里的 `(0, setTimeout)(fn, 1)` 照常调度、判据却返回 undefined。
  if (ts.isBinaryExpression(u) && u.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return calleeChain(u.right)
  }
  return undefined
}

/**
 * 调用表达式的「名字链」：属性访问保留名字、调用 / 标签模板穿透基座。
 * - 链式登记：`it.each(表)('名', 选项, 体)` 的外层调用 → `['it','each']`；
 * - 条件基座：`it.skipIf(false).concurrent(…)` → `['it','skipIf','concurrent']`；
 * - 叠加修饰：`it.skipIf(false).concurrent.each([1])('case', …)` → `['it','skipIf','concurrent','each']`
 *   （递归穿透；只穿一层会在叠加修饰时判成 undefined）。
 * `viaCall` 表示链里跨过了至少一层调用（对判据无影响，仅供报错文案区分）。
 */
export function callChain(call: ts.CallExpression): { chain: string[]; viaCall: boolean } | undefined {
  // 递归解析：属性访问**保留名字**、调用 / 标签模板**穿透基座**，于是
  // `it.skipIf(false).concurrent.each([1])('case', …)` 与 `it.each(表)('名', …)` 都能得到
  // 完整的名字链（CodeRabbit PR#81 第十三轮：只穿一层调用会在叠加修饰时判成 undefined）。
  let viaCall = false
  const resolve = (node: ts.Expression): string[] | undefined => {
    const e = unwrap(node)
    if (ts.isIdentifier(e)) return [e.text]
    if (ts.isPropertyAccessExpression(e)) {
      const base = resolve(e.expression)
      return base === undefined ? undefined : [...base, e.name.text]
    }
    // 字面量下标访问与点号同义（见 `calleeChain` 的同款注释，Codex PR#81 第十七轮 P2）
    if (ts.isElementAccessExpression(e)) {
      const k = staticKey(e.argumentExpression)
      if (k === undefined) return undefined
      const base = resolve(e.expression)
      return base === undefined ? undefined : [...base, k]
    }
    // 逗号表达式取最右操作数（见 `calleeChain` 的同款注释，Codex PR#81 第十八轮 P2）
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) {
      return resolve(e.right)
    }
    // `new Promise(…).then(…)`：构造调用与普通调用一样穿透基座（Codex PR#81 第二十一轮 P2，
    // 探针复现：不穿透时 `new Promise().then(…)` 的名字链是 undefined，hook 判据漏掉它）
    if (ts.isNewExpression(e)) {
      viaCall = true
      return resolve(e.expression)
    }
    if (ts.isCallExpression(e) || ts.isTaggedTemplateExpression(e)) {
      viaCall = true
      return ts.isCallExpression(e) ? resolve(e.expression) : resolve(e.tag)
    }
    return undefined
  }
  const chain = resolve(call.expression)
  return chain === undefined ? undefined : { chain, viaCall }
}

/**
 * 节点子树里全部字符串 / 模板字面量的**文本内容**（模板的 `${…}` 是代码，不算文本；
 * 其中的字面量照常收集）。`onNode` 给需要「定位到具体字面量」的调用方（方法调用名 ——
 * 只认字面量后面紧跟 `(` 的那种）。
 */
export function literalTexts(
  node: ts.Node, onNode?: (lit: ts.StringLiteralLike, parent: ts.Node) => void,
): string[] {
  const out: string[] = []
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      out.push(n.text)
      onNode?.(n, n.parent)
      return
    }
    if (ts.isTemplateExpression(n)) {
      out.push(n.head.text)
      for (const s of n.templateSpans) out.push(s.literal.text)
      ts.forEachChild(n, visit)
      return
    }
    ts.forEachChild(n, visit)
  }
  visit(node)
  return out
}

/**
 * 该调用是不是「基名 + 若干修饰名」形态，且基名在 `base` 里（如注册函数 it/test/describe/suite）。
 * 链式登记（`it.each(…)('名', …)`）会返回**两个**调用：内层（表格）与外层（登记），
 * 两层链的基名都是 `it`。
 */
export function isRegistration(call: ts.CallExpression, base: readonly string[]): boolean {
  const c = callChain(call)
  return c !== undefined && base.includes(c.chain[0]!)
}

/**
 * 对象字面量里**顶层**属性名与值的映射（键支持标识符、字符串、数字、计算字面量）。
 * 只读顶层 —— 与 Vitest 的选项契约一致（`concurrent` 是选项对象的属性）。
 * ⚠️ 字符串键（`{ 'concurrent': true }`）同样是合法选项（Codex PR#81 第九轮）：
 * AST 里它与标识符键的区别只是 `ts.isStringLiteral`，这里一并收下。
 * ⚠️ **按 JS 的对象形状语义合并，后写覆盖前写**（Vitest 用 `{ ...suiteOpts, ...options }`
 * 合并选项，见 `@vitest/runner` 的 `options = { ...currentSuite.options, ...options }`）：
 *   · 静态对象展开（`{ ...{ concurrent: true } }`）：递归展开（Codex PR#81 第十八轮 P2）；
 *   · **未知展开**（`{ concurrent: true, ...opts }`，`opts` 是变量）：它可能覆盖**任何**键 ——
 *     不能因为"求不出值"就把前面的值留着（那会把串行的合法用例判成并发，Codex PR#81
 *     第二十轮 P2 探针复现的**误报**）。此时映射进入"不确定"状态：清空已知键，
 *     之后的显式赋值再重新确定（`{ concurrent: true, ...opts, concurrent: true }` 仍是并发）。
 *   · **访问器**（`get concurrent()` / `set concurrent()`）同样覆盖之前的同名值。
 * 不确定状态用 `undefined` 值表示（调用方 `props.get(k)` 得到 undefined 即"无法判定"）。
 * ⚠️ 不确定性**必须向上传播**（CodeRabbit PR#81 第二十一轮 minor）：`{ concurrent: true,
 * ...{ ...opts } }` 里内层展开的未知键同样可能覆盖外层的 `concurrent` —— 只清空内层自己的
 * 映射、外层原样保留旧值，就把"不确定"又算成了"确定"。
 */
export function objectProps(obj: ts.ObjectLiteralExpression): Map<string, ts.Expression | undefined> {
  return objectPropsInner(obj).props
}

/**
 * 与 `objectProps` 相同，另给出「结果集里有没有**未知来源**的键」（未知展开 / 动态计算键）。
 * ⚠️ 为什么必须单独给出（CodeRabbit PR#81 第二十三轮 minor）：未知展开之后映射被清空，
 * `{ ...opts }` 与 `{}` 在 `props` 上**完全无法区分** —— 调用方只看 `props.get(k) === undefined`
 * 会把「可能开了并发但看不出来」当成「确定没开」。判据要能看见这一点，才能决定是放过还是报。
 */
export function objectPropsWithUnknown(obj: ts.ObjectLiteralExpression): {
  props: Map<string, ts.Expression | undefined>
  mayHaveUnknown: boolean
  /**
   * 顶层**访问器**（getter / setter）声明的静态键。`props` 里这些键的值是 `undefined`
   * （运行时才知道），与「来自未知展开」无法区分 —— 调用方需要分开报时看这里。
   */
  accessorKeys: Set<string>
} {
  return objectPropsInner(obj)
}

/** 递归返回「映射 + 是否可能含未知键（未知展开）+ 访问器键」，让不确定性传播到外层。 */
function objectPropsInner(obj: ts.ObjectLiteralExpression): {
  props: Map<string, ts.Expression | undefined>
  mayHaveUnknown: boolean
  accessorKeys: Set<string>
} {
  const out = new Map<string, ts.Expression | undefined>()
  const accessorKeys = new Set<string>()
  let mayHaveUnknown = false
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p)) {
      const k = staticPropKey(p.name, true)
      // 普通属性**后写覆盖**同名访问器：`{ ...{ get concurrent() { return true } }, concurrent: false }`
      // 实测按串行登记（Codex PR#81 第二十五轮 P2）—— 不清掉访问器标记，调用方会把合法串行
      // 报成「值运行时才知道」。
      if (k !== undefined) { out.set(k, p.initializer); accessorKeys.delete(k) }
      else {
        // 动态键：键名求不出，可能覆盖**任何**已知键 —— 旧值必须作废
        // （CodeRabbit PR#81 第二十二轮 minor：只置标记而保留旧值，`{ concurrent: true,
        // [key]: false }` 仍返回 true，而 key 可能就是 'concurrent'）。
        out.clear()
        accessorKeys.clear()
        mayHaveUnknown = true
      }
    } else if (ts.isShorthandPropertyAssignment(p)) {
      out.set(p.name.text, p.name)
      accessorKeys.delete(p.name.text)
    } else if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
      // 访问器的值只有在求值时才知道 —— 它能覆盖**它自己那个键**。
      // ⚠️ 计算键也要认静态字面量（`get ['concurrent']()`）：传 false 会把字面量键当成
      // 未知键、进而清空外层全部已知值（Codex PR#81 第二十一轮 P2 的**误报**与漏检各一例）。
      const k = staticPropKey(p.name, true)
      if (k !== undefined) { out.set(k, undefined); accessorKeys.add(k) }
      else { out.clear(); accessorKeys.clear(); mayHaveUnknown = true }
    } else if (ts.isMethodDeclaration(p)) {
      // ⚠️ **对象方法**同样是选项键，值是函数 —— 真值（Codex PR#81 第二十八轮 P2：`{ [key]() {} }`
      // 的 `key` 就是 'concurrent' 时 Vitest 照常登记并发）。键可静态确定时按「值是求不出的表达式」
      // 记（函数对象不是布尔）；键求不出时按动态键处理（作废全部已知值）。
      const k = staticPropKey(p.name, true)
      if (k !== undefined) { out.set(k, undefined); accessorKeys.add(k) }
      else { out.clear(); accessorKeys.clear(); mayHaveUnknown = true }
    } else if (ts.isSpreadAssignment(p)) {
      const src = unwrap(p.expression)
      if (ts.isObjectLiteralExpression(src)) {
        const inner = objectPropsInner(src)
        // 内层若含未知展开，它可能覆盖**外层**已有的键 —— 先清空再合并内层已知值。
        if (inner.mayHaveUnknown) { out.clear(); accessorKeys.clear() }
        // 后写的展开同样**覆盖**同名访问器：`{ ...{ get concurrent() {…} }, ...{ concurrent: false } }`
        // 内层是普通属性，外壳的访问器标记必须清掉（CodeRabbit PR#81 第二十六轮 minor）——
        // 否则调用方仍按「值运行时才知道」报未知，合法的串行样本被当成并发。
        for (const [k, v] of inner.props) { out.set(k, v); accessorKeys.delete(k) }
        // 内层访问器覆写同名键：键同样记进本层的访问器集合 —— 只把值置 undefined 的话，
        // 外层无法与「未知展开留下的空值」区分（Codex PR#81 第二十五轮 P2 的成因之一）。
        for (const k of inner.accessorKeys) { out.set(k, undefined); accessorKeys.add(k) }
        if (inner.mayHaveUnknown) mayHaveUnknown = true
      } else {
        // 未知展开：可能覆盖任何键 —— 已知值全部作废，之后显式赋值再重新确定。
        out.clear()
        accessorKeys.clear()
        mayHaveUnknown = true
      }
    }
  }
  return { props: out, mayHaveUnknown, accessorKeys }
}

/** 属性名 → 静态字符串键；动态键（变量 / 调用）返回 undefined。 */
function staticPropKey(name: ts.PropertyName, allowComputed: boolean): string | undefined {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  if (allowComputed && ts.isComputedPropertyName(name)) {
    // 键表达式可能是括号 / 断言包装后的字面量（`{ [('concurrent')]: true }`，Codex PR#81 第十二轮）
    const e = unwrap(name.expression)
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) {
      return e.text
    }
  }
  return undefined
}
