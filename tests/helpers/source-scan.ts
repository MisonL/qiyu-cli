// tests/helpers/source-scan.ts
//
// 源码扫描的**共用**小工具（原本各测试文件各写一份，2026-11-15 收敛到一处）：
// `blankComments`（抹注释）、`blankLiterals`（抹字符串/模板/正则内容）、`argRange` /
// `scanBalanced`（配对）、`splitTopLevel`（切实参）、`propertyRanges`（对象属性位）。
//
// ⚠️ 为什么要共用（而不是各文件抄一份）：判据一旦有第二份实现，两处就会对「什么算注释」
// 「什么算参数」给出不同答案 —— 同一个文件在两个守卫里结论不同时，没人能说清哪个对。
// 现有调用点：`tests/plaintext-channels.test.ts`（全仓 Markdown 标记扫描）、
// `tests/helpers/capture.test.ts`（capture 的两条结构性边界）。
//
// ⚠️ 同一判据只能有**一个实现点**（2026-11-16，Codex PR#81 第七/八轮）：`scanBalanced`
// 曾经在 `capture.test.ts` 里另有一份（不跳字符串的 `skipBalanced`），Codex 的两个探针
// 都打在那份复制品上。现在配对、实参切分（`splitTopLevel`）、属性位识别
// （`propertyRanges`）、字面量抹除（`blankLiterals`）都只在这里实现。

/**
 * 把注释抹成等长空白（保留行号与偏移）。
 *
 * ⚠️ 不能只用正则：本仓库的注释里大量出现 `usageFail(...)`、`'**'` 这类**被讨论的**
 * 文本，纯正则会把它当代码。但也不能粗暴 `//.*$` —— `'https://…'` 里的 `//` 在字符串内。
 * 这里用一个**只认引号与注释**的小状态机：它不处理正则字面量（`/'([^']+)'/` 里的引号
 * 会被误判成字符串起止），这是已知边界 —— 在 `usageFail`/`throw` 的参数位置上出现
 * 正则字面量的可能性极低，且误判的方向是**漏报**而非误报（宁可漏一条扫描，不制造
 * 假红把真问题淹掉）。真正的兜底是 api.test.ts 的行为表。
 */
export function blankComments(text: string): string {
  const out = text.split('')
  let i = 0
  let quote: string | null = null
  while (i < text.length) {
    const c = text[i]!
    const n = text[i + 1]
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; i++; continue }
    if (c === '/' && n === '/') {
      while (i < text.length && text[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (c === '/' && n === '*') {
      const end = text.indexOf('*/', i + 2)
      const stop = end === -1 ? text.length : end + 2
      for (let k = i; k < stop; k++) if (out[k] !== '\n') out[k] = ' '
      i = stop
      continue
    }
    i++
  }
  return out.join('')
}

/** 三种开 / 闭括号（切分与配对共用）。 */
export const OPENERS = '([{'
export const CLOSERS = ')]}'

/**
 * 把字符串 / 模板 / 正则 / 注释的**内容**抹成等长空白（保留偏移与行号）。
 * 用途：在「这段文本里有没有某个属性」这类判据里用 —— 只抹注释不够，
 * `{ label: 'concurrent: true' }` 的**值**是数据，读到它就等于误报。
 * 边界（如实记录）：模板里的 `${…}` 也被整体抹掉（不展开插值）—— 对属性扫描足够。
 */
export function blankLiterals(text: string): string {
  const out = text.split('')
  const blank = (a: number, b: number): void => {
    for (let k = a; k < b; k++) if (out[k] !== '\n') out[k] = ' '
  }
  let i = 0
  while (i < text.length) {
    const c = text[i]!
    if (c === '/' && text[i + 1] === '/') { const s0 = i; while (i < text.length && text[i] !== '\n') i++; blank(s0, i); continue }
    if (c === '/' && text[i + 1] === '*') { const s0 = i; const e = text.indexOf('*/', i + 2); i = e === -1 ? text.length : e + 2; blank(s0, i); continue }
    if (c === '/' && regexAllowedAfter(text, i)) { const s0 = i; i = skipRegex(text, i); blank(s0, i); continue }
    if (c === "'" || c === '"' || c === '`') { const s0 = i; i = skipQuote(text, i); blank(s0 + 1, i - 1); continue }
    i++
  }
  return out.join('')
}

/**
 * 按**顶层**（深度 0）逗号切分 `[start, end)`：返回若干 `[s, e]` 段（各自去掉外层空白）。
 * 字符串 / 模板 / 正则 / 注释里的逗号不切分；`start === end` 表示空段。
 * ⚠️ 括号种类不符时不配平（`([)]` 视为坏输入）—— 凑配对会让区间在错误位置切开。
 */
export function splitTopLevel(
  text: string, start: number, end: number,
): Array<[number, number]> {
  const segs: Array<[number, number]> = []
  const stack: string[] = []
  const trim = (a: number, b: number): [number, number] => {
    while (a < b && /\s/.test(text[a]!)) a++
    while (b > a && /\s/.test(text[b - 1]!)) b--
    return [a, b]
  }
  let segStart = start
  for (let k = start; k < end; k++) {
    const ch = text[k]!
    if (ch === '/' && text[k + 1] === '/') { while (k < end && text[k] !== '\n') k++; continue }
    if (ch === '/' && text[k + 1] === '*') { const t = text.indexOf('*/', k + 2); k = t === -1 ? end : t + 1; continue }
    if (ch === '/' && regexAllowedAfter(text, k)) { k = skipRegex(text, k) - 1; continue }
    if (ch === "'" || ch === '"' || ch === '`') { k = skipQuote(text, k) - 1; continue }
    if (OPENERS.includes(ch)) { stack.push(ch); continue }
    if (CLOSERS.includes(ch)) { stack.pop(); continue }
    if (ch === ',' && stack.length === 0) { segs.push([segStart, k]); segStart = k + 1 }
  }
  segs.push([segStart, end])
  return segs.map(([a, b]) => trim(a, b))
}

/**
 * 一个对象字面量（`{` 之后、配对 `}` 之前）里**可能被当成属性读到**的区间：
 * 顶层属性位 + `:` 之后的值（对象字面量逐层展开；`=>` 之后是**块**才展开）。
 * 箭头**表达式**体（`() => ({ … })`）是回调体、不展开 —— 里面的 `concurrent: true`
 * 是用户数据而不是开关（与「执行体出现在 `) => (` 之后不算」同一判据）。
 * ⚠️ 不能用正则切 `=>` / `:`（字符串里的 `"=>"`、键名后的函数返回类型注解 `): X` 都会切错）：
 * 按词法单元扫，只在深度 0 认 `=>` 与紧跟标识符尾的 `:`。
 * 已知边界：属性值是三元 / 调用参数里的对象字面量时不展开（本仓库无此写法）。
 */
export function propertyRanges(
  text: string, start: number, end: number,
): Array<[number, number]> {
  const out: Array<[number, number]> = [[start, end]]
  const stack: string[] = []
  let arrowAfter = -1
  let colonAfter = -1
  for (let k = start; k < end; k++) {
    const ch = text[k]!
    if (ch === '/' && text[k + 1] === '/') { while (k < end && text[k] !== '\n') k++; continue }
    if (ch === '/' && text[k + 1] === '*') { const t = text.indexOf('*/', k + 2); k = t === -1 ? end : t + 1; continue }
    if (ch === '/' && regexAllowedAfter(text, k)) { k = skipRegex(text, k) - 1; continue }
    if (ch === "'" || ch === '"' || ch === '`') { k = skipQuote(text, k) - 1; continue }
    if (OPENERS.includes(ch)) { stack.push(ch); continue }
    if (CLOSERS.includes(ch)) { stack.pop(); continue }
    if (stack.length > 0) continue
    if (ch === '=' && text[k + 1] === '>' && arrowAfter === -1) { arrowAfter = k + 2; k++; continue }
    if (ch === ':' && colonAfter === -1 && text[k + 1] !== ':' && /[\w$\]'"]\s*$/.test(text.slice(start, k))) {
      colonAfter = k + 1
    }
  }
  for (const from of [colonAfter, arrowAfter]) {
    if (from === -1) continue
    let k = from
    while (k < end && /\s/.test(text[k]!)) k++
    if (text[k] === '{') {
      const close = scanBalanced(text, k)[1]
      if (close > k + 1) out.push(...propertyRanges(text, k + 1, Math.min(close - 1, end)))
      return out   // 值只有这一块
    }
  }
  return out
}

/**
 * 从 `(` 之后（`from` 指向 `(` 的下一个字符）做括号配对，返回参数区间 `[start, end)`。
 *
 * ⚠️ 配对的语义是「**实参区间**」还是「**执行体**」由调用点的参数位置决定，本函数不管；
 * 用它的调用点必须自己判断别的实参算不算数（`capture.test.ts` 的 `concurrent: true` 只认
 * 选项实参，见那里的 `concurrentOptionHits`）。
 *
 * ⚠️ 跳过的词法单元必须**全部**跳过：字符串 / 模板字符串 / 正则 / 注释。只跳字符串时，
 * `const re = /)/; foo()` 里的那个 `)` 会被当成实参终点 —— 区间被截短，后面的实参整个
 * 落在区间外（漏报）；「配平到错的位置」还会让 `scanBalanced` 这类调用点把后面的代码
 * 当成区间成员（Codex PR#81 第七轮：字符串里的 `)`/`(` 就能让 hook 判据整条失效）。
 * 注释本可由 `blankComments` 先抹掉，但本函数不该依赖调用方先抹 —— 直接跳过更稳。
 */
export function argRange(text: string, from: number): [number, number] {
  // `scanBalanced` 的 `after` 指配对 `)` **之后**；实参区间要**排除**那个 `)` 本身
  // （与历史语义一致：`slice(s, e)` 取到的最后一个字符是最后一个实参）。
  const [close] = scanBalanced(text, from - 1)
  return [from, close]
}

/**
 * 从 `open`（指向 `(`）起做括号配对，返回 `[close, after]`：
 * - `close`：配对的 `)` 的下标（没配上则为 `text.length`）
 * - `after`：配对符号**之后**的下标（区间右开边界）
 * 词法单元（字符串 / 模板 / 正则 / 注释）里的括号**不参与**配对。
 */
export function scanBalanced(text: string, open: number): [number, number] {
  let depth = 0
  let i = open
  while (i < text.length) {
    const c = text[i]!
    const next = text[i + 1]
    if (c === '\\') { i += 2; continue }
    if (c === '/' && next === '/') {                       // 行注释
      while (i < text.length && text[i] !== '\n') i++
      continue
    }
    if (c === '/' && next === '*') {                       // 块注释
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 2
      continue
    }
    if (c === '/' && regexAllowedAfter(text, i)) {         // 正则字面量
      i = skipRegex(text, i)
      continue
    }
    if (c === "'" || c === '"' || c === '`') {             // 字符串 / 模板（${…} 不展开，见注释）
      i = skipQuote(text, i)
      continue
    }
    if (c === '(') depth++
    else if (c === ')') {
      depth--
      if (depth === 0) return [i, i + 1]
    }
    i++
  }
  return [text.length, text.length]
}

/** 跳过以 `q` 开头的字符串 / 模板，返回结束引号的下标。未闭合则返回 `text.length`。 */
export function skipQuote(text: string, q: number): number {
  const quote = text[q]!
  let i = q + 1
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue }
    if (text[i] === quote) return i + 1
    i++
  }
  return text.length
}

/**
 * `/` 在此处是正则开头吗？按**前一个非空白字符**判：表达式位置的 `/` 才是正则。
 * 关键词（`return` / `typeof` / `case` 等）之后也算表达式位置。
 * 边界（如实记录）：`a / b` 这类除法前一个字符是标识符/`)`/`]` → 当除号，正确；
 * 但 `if (x) /re/.test(s)`（`if (…)` 之后的语句位置）会被当除号 —— 误判方向是
 * 「不跳正则」，退回旧行为（可能把正则里的 `)` 当配对符号），不会制造假红。
 */
export function regexAllowedAfter(text: string, at: number): boolean {
  let k = at - 1
  while (k >= 0 && /\s/.test(text[k]!)) k--
  if (k < 0) return true
  if (/[)\]}]/.test(text[k]!)) return false
  const word = /(\w+)$/.exec(text.slice(Math.max(0, k - 16), k + 1))
  if (word) return /^(?:return|typeof|instanceof|case|in|of|new|delete|void|throw|do|else)$/.test(word[1]!)
  return true   // 运算符 / 标点之后 → 表达式位置
}

/** 跳过从 `r` 开始的正则字面量，返回结束 `/flags` 之后的下标。 */
export function skipRegex(text: string, r: number): number {
  let i = r + 1
  let inClass = false
  while (i < text.length) {
    const c = text[i]!
    if (c === '\\') { i += 2; continue }
    if (c === '\n') return i          // 单行正则不跨行：判错了就到此为止
    if (c === '[') inClass = true
    else if (c === ']') inClass = false
    else if (c === '/' && !inClass) { i++; while (i < text.length && /[a-z]/i.test(text[i]!)) i++; return i }
    i++
  }
  return text.length
}
