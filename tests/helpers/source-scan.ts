// tests/helpers/source-scan.ts
//
// 源码扫描的**共用**小工具（原本各测试文件各写一份，2026-11-15 收敛到一处）：
// `blankComments`（把注释抹成等长空白）+ `argRange`（从 `(` 之后做括号配对取参数区间）。
//
// ⚠️ 为什么要共用（而不是各文件抄一份）：判据一旦有第二份实现，两处就会对「什么算注释」
// 「什么算参数」给出不同答案 —— 同一个文件在两个守卫里结论不同时，没人能说清哪个对。
// 现有调用点：`tests/plaintext-channels.test.ts`（全仓 Markdown 标记扫描）、
// `tests/helpers/capture.test.ts`（capture 的两条结构性边界）。

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

/** 从 `m`（指向 `(` 之后）开始做括号配对，返回参数区间 `[start, end)`。 */
export function argRange(text: string, from: number): [number, number] {
  let depth = 1
  let i = from
  let quote: string | null = null
  while (i < text.length && depth > 0) {
    const c = text[i]!
    if (quote) {
      if (c === '\\') { i += 2; continue }
      if (c === quote) quote = null
      i++
      continue
    }
    if (c === "'" || c === '"' || c === '`') { quote = c; i++; continue }
    if (c === '(') depth++
    else if (c === ')') depth--
    i++
  }
  return [from, i - 1]
}
