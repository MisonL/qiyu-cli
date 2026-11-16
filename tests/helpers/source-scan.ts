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

/** 深度优先收集节点子树里全部调用表达式（含链式写法的每一层）。 */
export function collectCalls(root: ts.Node): ts.CallExpression[] {
  const out: ts.CallExpression[] = []
  const walk = (n: ts.Node): void => {
    if (ts.isCallExpression(n)) out.push(n)
    ts.forEachChild(n, walk)
  }
  walk(root)
  return out
}

/** 标识符 / 属性访问链 → 段名数组（`it.concurrent` → `['it','concurrent']`）；其余返回 undefined。 */
export function calleeChain(node: ts.Expression): string[] | undefined {
  if (ts.isIdentifier(node)) return [node.text]
  if (ts.isParenthesizedExpression(node)) return calleeChain(node.expression)
  if (ts.isPropertyAccessExpression(node)) {
    const base = calleeChain(node.expression)
    return base === undefined ? undefined : [...base, node.name.text]
  }
  return undefined
}

/**
 * 调用表达式的「名字链」：链式登记 `it.each(表)(名, 选项, 体)` 的**外层**调用，其
 * expression 本身也是 CallExpression —— 这时取最内层被调用者的名字链。
 * `viaCall` 表示中间跨过了一层「先调用再调用」。
 */
export function callChain(call: ts.CallExpression): { chain: string[]; viaCall: boolean } | undefined {
  let e: ts.Expression = call.expression
  let viaCall = false
  while (ts.isCallExpression(e)) { viaCall = true; e = e.expression }
  const chain = calleeChain(e)
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
 */
export function objectProps(obj: ts.ObjectLiteralExpression): Map<string, ts.Expression> {
  const out = new Map<string, ts.Expression>()
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p)) {
      const n = p.name
      if (ts.isIdentifier(n)) out.set(n.text, p.initializer)
      else if (ts.isStringLiteral(n) || ts.isNumericLiteral(n)) out.set(n.text, p.initializer)
      else if (ts.isComputedPropertyName(n)) {
        const e = n.expression
        if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e) || ts.isNumericLiteral(e)) {
          out.set(e.text, p.initializer)
        }
      }
    } else if (ts.isShorthandPropertyAssignment(p)) {
      out.set(p.name.text, p.name)
    }
  }
  return out
}
