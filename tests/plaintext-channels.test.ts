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

import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

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
function blankComments(text: string): string {
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
function argRange(text: string, from: number): [number, number] {
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

/**
 * 从 `from` 起吃掉「字符串字面量（用 `+` 连接）」这一串，返回其原文拼接。
 * 用于精确取常量初始化表达式，而不误伤后面的代码。
 */
function literalChain(text: string, from: number): string {
  let i = from
  let out = ''
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) i++
    const q = text[i]
    if (q !== "'" && q !== '"' && q !== '`') break
    const start = i
    i++
    while (i < text.length && text[i] !== q) {
      if (text[i] === '\\') i++
      i++
    }
    i++
    out += text.slice(start, i)
    while (i < text.length && /\s/.test(text[i]!)) i++
    if (text[i] === '+') { i++; continue }
    break
  }
  return out
}

interface Hit { file: string; line: number; snippet: string }

/** 扫全仓：`pattern` 匹配到的调用，其参数区间里出现 `**` 的记一条。 */
function scanCallArgs(pattern: RegExp): Hit[] {
  const hits: Hit[] = []
  for (const f of walk(SRC)) {
    const raw = readFileSync(f, 'utf8')
    const text = blankComments(raw)
    for (const m of text.matchAll(pattern)) {
      const [s, e] = argRange(text, m.index! + m[0].length)
      const arg = text.slice(s, e)
      if (!arg.includes('**')) continue
      hits.push({
        file: relative(ROOT, f),
        line: text.slice(0, m.index!).split('\n').length,
        snippet: arg.replace(/\s+/g, ' ').trim().slice(0, 120),
      })
    }
  }
  return hits
}

const fmt = (h: Hit): string => `${h.file}:${h.line}  ${h.snippet}`

describe('纯文本通道（stderr 与 help）不得出现 Markdown 标记 —— 全仓静态扫描', () => {
  it('`usageFail(...)` 的参数里没有 `**`', () => {
    // `usageFail` 把 message **逐字**写进 stderr（`process.stderr.write(safe)`），
    // 终端里四个星号就是四个星号。
    const hits = scanCallArgs(/\busageFail\s*\(/g)
    expect(hits.map(fmt), `这些 usageFail 的文案里含 Markdown 标记（会原样进终端）：\n${hits.map(fmt).join('\n')}`)
      .toEqual([])
  })

  it('`throw new Error(...)` / `throw Object.assign(new Error(...))` 的参数里没有 `**`', () => {
    // 两条出口都会把 message 变成人读文本：
    //   ① `callOne` 的 catch → `process.stderr.write(message)`（usage 分支）；
    //   ② 未捕获时 Node 默认打印器把 message 与**堆栈**一起打到终端（注册表加载期）。
    // 实测来源：`assertGetHasNoBody` 的文案曾含 `**目前没有 GET 的 query 参数通道**`，
    // 全仓没有任何测试能发现它 —— 本文件就是那次实测补上的。
    const hits = scanCallArgs(/\bthrow\b[^;\n]{0,60}?new\s+Error\s*\(/g)
    expect(hits.map(fmt), `这些 throw 的文案里含 Markdown 标记：\n${hits.map(fmt).join('\n')}`)
      .toEqual([])
  })

  it('`process.stderr.write(...)` 的直接实参里没有 `**`', () => {
    // 绕过 `usageFail` 的手写出口（`callOne` catch、`query/errors.ts`、`config.ts` 的
    // 权限警告…）—— 它们同样是纯文本通道。
    const hits = scanCallArgs(/process\.stderr\.write\s*\(/g)
    expect(hits.map(fmt), `这些直接写 stderr 的文案里含 Markdown 标记：\n${hits.map(fmt).join('\n')}`)
      .toEqual([])
  })

  it('`USAGE` / `*_USAGE` 常量里没有 `**`（help 走 stdout，但它是纯文本）', () => {
    // help 文本经 `process.stdout.write(USAGE)` 原样输出。它不是 JSON，因此不适用
    // 「字段值是给 Agent 的结构化文本」这条豁免 —— 人读到的就是星号。
    // 实测来源：`sync --help` 的「安装前置：**至少成功同步过一次**」曾原样打到终端。
    const hits: Hit[] = []
    for (const f of walk(SRC)) {
      const raw = readFileSync(f, 'utf8')
      const text = blankComments(raw)
      for (const m of text.matchAll(/(?:const|let)\s+\w*USAGE\w*\s*=\s*/g)) {
        // 常量体 = 初始化表达式里的**字符串字面量序列**（`'a' + 'b'` 或单个模板串）。
        // ⚠️ 不能"取到下一个顶格 const" —— 那样会把常量**之后**的函数体一起吃进来
        // （`SCHEMA_USAGE` 后面紧跟的 `schema()` 里就有含 `**` 的 field_notes，
        // 实测会误报）。只认字面量与 `+`，遇到别的 token 就停。
        const body = literalChain(text, m.index! + m[0].length)
        if (!body.includes('**')) continue
        hits.push({
          file: relative(ROOT, f),
          line: text.slice(0, m.index!).split('\n').length,
          snippet: body.replace(/\s+/g, ' ').trim().slice(0, 120),
        })
      }
    }
    expect(hits.map(fmt), `这些 help 文本里含 Markdown 标记：\n${hits.map(fmt).join('\n')}`)
      .toEqual([])
  })

  it('扫描器自身有牙：给一个合成的违规文案，四条规则各自都能抓到', () => {
    // ⚠️ 没有这一条，上面四条可能是「扫了个空」——`walk` 路径写错、`blankComments`
    // 把整个文件抹成空白，都会让它们恒绿。这里直接喂合成源码，证明扫描器认得出违规。
    const fake = [
      "usageFail('错误：**不要这样**')",
      "throw new Error('崩溃：**别**')",
      "process.stderr.write('警告：**注意**')",
      'const X_USAGE = `用法：**粗体**`',
    ].join('\n')
    const blanked = blankComments(fake)
    expect(blanked.includes('**')).toBe(true)
    for (const re of [/\busageFail\s*\(/g, /\bthrow\b[^;\n]{0,60}?new\s+Error\s*\(/g,
      /process\.stderr\.write\s*\(/g]) {
      const m = re.exec(blanked)!
      expect(m, `合成样例未被 ${re} 命中`).not.toBeNull()
      const [s, e] = argRange(blanked, m.index + m[0].length)
      expect(blanked.slice(s, e)).toContain('**')
    }
    // 注释里的 `**` 必须**不**被算作违规（本仓库注释大量使用 Markdown 强调）
    expect(blankComments("// **这是注释**\nconst a = 1").includes('**')).toBe(false)
  })
})
