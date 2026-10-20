// src/skill/refs.ts —— 从 skill 正文里提取「可被机器校验的引用」：命令路径 / flag、错误
// `kind`、SQL 序列，以及明知无法静态判定的命令（含选择或省略符号）。
//
// 本文件是纯函数、零业务依赖（除标准库外无 import，实际上连 node:* 都不用）。它只负责
// **提取**，不判断引用是否合法 —— 命令是否在 `COMMAND_TREE` 里、kind 是否在 `ERROR_KINDS`
// 里，是 `skill check`（Task 6）的事。保持这条边界，提取器才能被单独测试，也不会把
// commands 层拉进 skill 层。
//
// 扫描面（collectSegments / collectFenceBlocks 决定「哪些文本算代码」，scan* 决定算什么引用）：
//   · 行内代码：散文里的 `` `qiyu sync status` ``，单反引号包裹，一行可多片段，各自计数。
//   · 围栏代码块：``` 围栏内的行。围栏行**既**按裸文本扫、**也**解析行内反引号 ——
//     `` `qiyu db tables` `` 和裸 `qiyu db tables` 都是真实引用，漏检（Task 6 看不见）
//     比误报危险；为不双计，裸文本先剥掉行内片段再入列，并按「行 + 内容」去重。
//     shell 命令替换（`` echo `date` ``）的内层片段是 `date`，三条扫描都不命中，无噪声。
//   · 围栏行尾的 `#` 注释剥掉：`qiyu sync status  # 不要用 --pretty` 的注释是否定语境，
//     不是命令的一部分，`--pretty` 进 flags 会让 Task 6 误报 rejected_flag。
//   · 正文散文不算引用：裸散文的 `qiyu …` 不提取 —— 「正文提到命令」与「正文承诺命令
//     存在」的分界。
//
// 围栏配对按**长度**（闭合 ≥ 开启，CommonMark）：五反引号外层里的三反引号行是内容不是
// 闭合，嵌套围栏不翻转；围栏容忍 ≤3 空格缩进（列表项里的代码块），缩进的闭合围栏也能
// 正常闭合。围栏未闭合时余下全部按围栏内容扫：宁可多扫几行，也不要因为文档末尾漏写
// ```` ``` ```` 就把后面的示例命令整段漏掉。
//
// 命令切词（scanCommand）的裁定语义：
//   · 路径 token 在第一个 `<...>` 占位符处封口；占位符是 flag 的取值或位置参数模板，
//     不是子命令（`qiyu query <表>` 不该产出路径 `['query','<表>']`）。
//   · flag 跨占位符继续收（`--since <时间>` 的 `--since` 仍可静态校验），但**在管道 /
//     省略号处止步** —— 管道右侧是另一条命令，`| head -20` 的 `-20` 不属于 qiyu，
//     收进来 Task 6 会误报 unknown_flag。占位符之后的管道不判 unverifiable（路径已封口，
//     规则 3 的不可判定判定仍只看占位符之前）。
//   · flag 的紧邻字面值不当路径 token（`--table sessions` 的 `sessions` 是取值）；
//     `--table=<表>` 按 `=` 切出 flag 名 —— Task 6 比对的是 flag 名。
//   · 只有 flag 没路径的 `qiyu --help` 不记成命令引用（见 scanCommand 内注释）。

/** 一条命令引用：`path` 不含程序名（`['sync', 'status']`），`flags` 保持出现顺序。 */
export interface CommandRef {
  path: string[]
  flags: string[]
  line: number
}

export interface Refs {
  commands: CommandRef[]
  kinds: { name: string; line: number }[]
  sqlSequences: { text: string; line: number }[]
  unverifiable: { text: string; line: number; reason: string }[]
}

/**
 * 围栏开启：≤3 空格缩进（CommonMark 上限，列表项里的代码块通常缩进）+ ≥3 个反引号，
 * 捕获反引号串用于长度配对；info string（```bash）不算闭合。
 */
const FENCE_OPEN_RE = /^ {0,3}(`{3,})/

/** 围栏闭合：只有反引号（CommonMark 不许闭合行带 info string），长度 ≥ 开启长度才闭合。 */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,})\s*$/

/** 行内代码片段：单反引号包裹、片段内不允许换行（换行就不是「行内」了）。 */
const INLINE_CODE_RE = /`([^`\n]+)`/g

/** 命令形态：片段以程序名开头，后接至少一个空白。 */
const COMMAND_RE = /^qiyu\s+(.*)$/

/** 占位符：整个词就是 `<...>`。只认这种完整形态，`--table=<表>` 靠等号切分归一。 */
const PLACEHOLDER_RE = /^<[^>]*>$/

/**
 * 无法静态判定的符号：管道（`|`）、省略号（`…` 或 `...`）。
 *
 * 占位符之前出现 → 整条记 unverifiable；占位符之后出现 → 到此为止，后面是另一条命令。
 */
const UNVERIFIABLE_RE = /[|…]|\.\.\./

/** 规则里钉死的话术，`skill check` 把它原样放进 warnings。 */
const REASON_CHOICE = '含选择/省略符号'

/** 错误分类的窄形态：`kind: rate_limit`。宽形态（如 `kind: foo/bar`）不提取，见规则 4。 */
const KIND_RE = /^kind:\s*([a-z_]+)$/

/** SQL 判定：同时出现大写的 `SELECT` 与 `FROM`，且各自是独立词。大小写敏感。 */
const SELECT_RE = /\bSELECT\b/
const FROM_RE = /\bFROM\b/

/** 围栏行注释：`#` 在行首或前面是空白才算注释，`a#b` / URL 锚点不受影响。 */
const COMMENT_RE = /(^|\s)#.*$/

interface Segment {
  text: string
  /** 1 起算的行号，按 `\n` 切分计数（规则 6）。 */
  line: number
}

/** 一个围栏块的 SQL 扫描单位：跨行的 `SELECT … FROM` 只在块级能看见（逐行各缺一词）。 */
interface FenceBlock {
  text: string
  /** 块内第一处 `SELECT` 所在行（报告定位用）。 */
  selectLine: number
  firstLine: number
  lastLine: number
}

/**
 * 把正文切成待扫描的片段，并按围栏块归组。
 *
 * 围栏行产出的片段 = 行内代码片段 + 夹在片段之间的裸文本（交错产出保持源顺序，同一
 * 内容不会被两个面各记一次）；两者都按「行 + 内容」去重。散文行只取行内代码。
 */
function collectSurfaces(text: string): { segments: Segment[]; blocks: FenceBlock[] } {
  const segments: Segment[] = []
  const seen = new Set<string>()
  const push = (text: string, line: number): void => {
    const trimmed = text.trim()
    if (trimmed === '') return
    const key = `${line}\u0000${trimmed}`
    if (seen.has(key)) return
    seen.add(key)
    segments.push({ text: trimmed, line })
  }

  const blocks: FenceBlock[] = []
  let inFence = false
  let openLen = 0
  let blockLines: { text: string; line: number }[] = []

  const closeBlock = (): void => {
    const lines = blockLines
    blockLines = []
    if (lines.length === 0) return
    // 反引号一并剥掉：围栏里 `` `SELECT * FROM x` `` 的反引号是排版不是 SQL 的一部分。
    // 空行不参与拼接，但保留自己的行号 —— 报告定位用 `SELECT` 真正所在的那一行。
    const stripped = lines
      .map((l) => ({ text: l.text.replace(/`/g, '').trim(), line: l.line }))
      .filter((l) => l.text !== '')
    if (stripped.length === 0) return
    const joined = stripped.map((l) => l.text).join('\n')
    if (!(SELECT_RE.test(joined) && FROM_RE.test(joined))) return
    const hit = stripped.find((l) => SELECT_RE.test(l.text))
    blocks.push({
      text: joined,
      selectLine: hit ? hit.line : stripped[0]!.line,
      firstLine: lines[0]!.line,
      lastLine: lines[lines.length - 1]!.line,
    })
  }

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    // 行号按 `\n` 计；CRLF 文档里行尾的 `\r` 属于行分隔符而不是内容，去掉它，
    // 否则 `qiyu sync status\r` 的最后一个词会带上 `\r`，flag/路径切分会失真。
    const raw = lines[i]!.replace(/\r$/, '')
    const line = i + 1

    if (!inFence) {
      const open = FENCE_OPEN_RE.exec(raw)
      if (open) {
        inFence = true
        openLen = open[1]!.length
        continue
      }
    } else {
      const close = FENCE_CLOSE_RE.exec(raw)
      if (close && close[1]!.length >= openLen) {
        inFence = false
        closeBlock()
        continue
      }
    }

    if (inFence) {
      // 围栏内容行：先剥注释，再按源文本顺序拆成「行内片段 + 夹在中间的裸文本」两个面。
      // 交错产出（而不是先收行内再收裸文本）是为了让 commands 顺序与原文一致。
      const noComment = raw.replace(COMMENT_RE, '$1')
      let cursor = 0
      for (const m of noComment.matchAll(INLINE_CODE_RE)) {
        push(noComment.slice(cursor, m.index), line)
        push(m[1]!, line)
        cursor = m.index + m[0].length
      }
      push(noComment.slice(cursor), line)
      blockLines.push({ text: noComment, line })
      continue
    }

    // 行内代码：一行里可以出现多个片段，各自计数（同内容同行只记一次）。
    for (const m of raw.matchAll(INLINE_CODE_RE)) push(m[1]!, line)
  }
  if (inFence) closeBlock()

  return { segments, blocks }
}

/**
 * 导出给 `skill check` 的表名扫描：与 `extractRefs` **完全相同**的扫描面（行内代码片段
 * 与围栏内容行，含缩进容忍 / 长度配对 / 围栏内反引号）。brief 规则 1「只在行内代码与
 * 围栏块里扫」若由 Task 6 重写一遍围栏解析，必然与这里的逻辑漂移 —— 复用是唯一不漂的写法。
 * 占位符 / 管道等命令语义不在这里做，本函数只回答「哪些文本算代码面」。
 */
export function collectSegments(text: string): { text: string; line: number }[] {
  return collectSurfaces(text).segments
}

/** `--table=<表>` → `--table`：Task 6 比对的是 flag 名，等号右侧取值不参与比对。 */
function normalizeFlag(word: string): string {
  const eq = word.indexOf('=')
  return eq === -1 ? word : word.slice(0, eq)
}

/**
 * 扫描一个片段里的命令引用。
 *
 * 两条边界，都以「占位符之前」为界：
 *   · 路径 token 只收到第一个 `<...>` 为止。占位符之后是调用方要填的值或模板里的可选
 *     部分，再往里收会把值当子命令（`qiyu query <表>` 不该产出路径 `['query','<表>']`）。
 *   · 选择/省略符号（`|`、`…`、`...`）只在占位符之前判定为 unverifiable；占位符之后
 *     遇到即止步（管道右侧是另一条命令），不再往 flags 里收。
 *
 * flag 例外地跨占位符收集：`--since <时间>` 里 `<时间>` 是 `--since` 的取值，后面的
 * `--since` 仍是可静态校验的 flag。brief 测试 2 钉死了这一点
 * （`` `qiyu query --table <表> --since <时间>` `` → flags 含 `--table` 与 `--since`）。
 * 它与规则 2 「之前的部分即命令路径 + flag」的字面说法有出入，取舍理由见报告。
 */
function scanCommand(content: string, line: number, refs: Refs): void {
  const m = COMMAND_RE.exec(content)
  if (!m) return

  const words = m[1]!.split(/\s+/).filter((w) => w !== '')
  const path: string[] = []
  const flags: string[] = []
  let pathClosed = false
  let expectFlagValue = false

  for (const word of words) {
    if (PLACEHOLDER_RE.test(word)) {
      // 占位符是前一个 flag 的取值或独立位置参数：路径在此封口，占位符本身不入列。
      pathClosed = true
      expectFlagValue = false
      continue
    }
    if (UNVERIFIABLE_RE.test(word)) {
      if (!pathClosed) {
        // 选择/省略符号：整条无法判定，记入 unverifiable 而不是猜一个路径。
        refs.unverifiable.push({ text: content, line, reason: REASON_CHOICE })
        return
      }
      // 占位符之后：管道右侧是另一条命令，它的 flag 不属于本命令，到此为止。
      break
    }
    if (word.startsWith('-')) {
      flags.push(normalizeFlag(word))
      expectFlagValue = true
      continue
    }
    if (expectFlagValue && path.length > 0) {
      // flag 的紧邻字面值是它的取值，不当路径 token。要求 path 已有 token 是防止
      // 「全局 flag 在最前」的写法（`qiyu --pretty api list`）把子命令吞成取值。
      expectFlagValue = false
      continue
    }
    expectFlagValue = false
    if (!pathClosed) path.push(word)
  }

  // 没有路径 token 的 `qiyu --help` 之类不记成命令引用：`Refs.commands` 的语义是
  // 「正文声称存在这条命令路径」，只有 flag 的调用不构成这种声称（而且 `--help` 是全局
  // flag，各命令都接受，记下来反而会让 check 用空路径去匹配、误报未知命令）。
  if (path.length === 0) return

  refs.commands.push({ path, flags, line })
}

function scanKind(content: string, line: number, refs: Refs): void {
  const m = KIND_RE.exec(content)
  if (m) refs.kinds.push({ name: m[1]!, line })
}

function scanSql(content: string, line: number, refs: Refs): void {
  // 只有 SELECT 没有 FROM（如 `SELECT 1`）不算：单值表达式不是「对某张表取数」，
  // 也就没有可校验的序列。两个词都必须是独立词，避免 `SELECTED` / `FROMAGE` 误命中。
  if (SELECT_RE.test(content) && FROM_RE.test(content)) {
    refs.sqlSequences.push({ text: content, line })
  }
}

/**
 * 从 skill 正文里提取全部引用。返回顺序即出现顺序（按行、行内按片段出现位置）；
 * 同一行同一内容只记一次（围栏面的裸文本与行内片段不双计），不同行不合并、不去重 ——
 * 校验方需要逐处报行号。
 */
export function extractRefs(text: string): Refs {
  const refs: Refs = { commands: [], kinds: [], sqlSequences: [], unverifiable: [] }
  const { segments, blocks } = collectSurfaces(text)

  for (const segment of segments) {
    scanCommand(segment.text, segment.line, refs)
    scanKind(segment.text, segment.line, refs)
    scanSql(segment.text, segment.line, refs)
  }

  // 围栏块级 SQL 兜底：`SELECT id` 与 `FROM sessions` 分两行时逐行各缺一词，只有整块
  // 能看见。块内已按行/片段记过 SQL 的不再按块重记，避免同一序列双报。
  for (const block of blocks) {
    const hit = refs.sqlSequences.some((s) => s.line >= block.firstLine && s.line <= block.lastLine)
    if (!hit) refs.sqlSequences.push({ text: block.text, line: block.selectLine })
  }

  return refs
}
