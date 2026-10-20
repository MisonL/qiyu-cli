// src/skill/refs.ts —— 从 skill 正文里提取「可被机器校验的引用」：命令路径 / flag、错误
// `kind`、SQL 序列，以及明知无法静态判定的命令（含选择或省略符号）。
//
// 本文件是纯函数、零业务依赖（除标准库外无 import）。它只负责**提取**，不判断引用是否
// 合法 —— 命令是否在 `COMMAND_TREE` 里、kind 是否在 `ERROR_KINDS` 里，是 `skill check`
// （Task 6）的事。保持这条边界，提取器才能被单独测试，也不会把 commands 层拉进 skill 层。
//
// 两个提取面（有意分开，不是同一条规则的两个分支）：
//   · 行内代码：散文里的 `` `qiyu sync status` ``，单反引号包裹，一条散文里可以有多个片段，
//     各自计数（见测试「多个反引号片段各自计数」）。
//   · 围栏代码块：``` 包围的整行**裸文本**（如 `qiyu db tables`），通常没有反引号包裹。
//     围栏内的每一行各自是一个片段；围栏行本身（``` 与 info string）不是内容。
// 分开的理由：围栏里写的是可直接粘贴执行的脚本，行内代码写的是正文里的零散提及。把围栏
// 内容再套一层反引号解析，会把 shell 的命令替换（`` echo `date` ``）当成行内代码；反过来
// 只在行内代码里找，会漏掉 skill 文档里最常见的「示例命令块」形态（测试第 4 条）。
//
// 正文散文不算引用：`可以直接运行 qiyu sync status 命令` 里没有代码片段，提取结果为空
// （测试第 5 条）。这条是「正文提到命令」与「正文承诺命令存在」的分界 —— 前者不该被校验。

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

/** 围栏开/闭行：``` 起始即可（含 ```` ```ts ```` 这类 info string）。 */
const FENCE_RE = /^```/

/** 行内代码片段：单反引号包裹、片段内不允许换行（换行就不是「行内」了）。 */
const INLINE_CODE_RE = /`([^`\n]+)`/g

/** 命令形态：片段以程序名开头，后接至少一个空白。 */
const COMMAND_RE = /^qiyu\s+(.*)$/

/** 占位符：整个词就是 `<...>`。只认这种完整形态，`--table=<表>` 不算占位符。 */
const PLACEHOLDER_RE = /^<[^>]*>$/

/**
 * 无法静态判定的符号：管道（`|`）、省略号（`…` 或 `...`）。
 *
 * 判定范围只到第一个占位符为止 —— 占位符之后的部分本来就不参与校验，那里的管道不影响
 * 前面的命令路径能否被判定（规则 3）。
 */
const UNVERIFIABLE_RE = /[|…]|\.\.\./

/** 规则里钉死的话术，`skill check` 把它原样放进 warnings。 */
const REASON_CHOICE = '含选择/省略符号'

/** 错误分类的窄形态：`kind: rate_limit`。宽形态（如 `kind: foo/bar`）不提取，见规则 4。 */
const KIND_RE = /^kind:\s*([a-z_]+)$/

/** SQL 判定：同时出现大写的 `SELECT` 与 `FROM`，且各自是独立词。大小写敏感。 */
const SELECT_RE = /\bSELECT\b/
const FROM_RE = /\bFROM\b/

interface Segment {
  text: string
  /** 1 起算的行号，按 `\n` 切分计数（规则 6）。 */
  line: number
}

/**
 * 把正文切成待扫描的片段。两个提取面的边界都在这里确定，后面的扫描函数对片段一视同仁。
 *
 * 围栏未闭合时，余下所有行都按围栏内容处理：宁可多扫几行，也不要因为文档末尾漏写
 * ```` ``` ```` 就把后面的示例命令整段漏掉。
 */
function collectSegments(text: string): Segment[] {
  const segments: Segment[] = []
  let inFence = false

  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    // 行号按 `\n` 计；CRLF 文档里行尾的 `\r` 属于行分隔符而不是内容，去掉它，
    // 否则 `qiyu sync status\r` 的最后一个词会带上 `\r`，flag/路径切分会失真。
    const raw = lines[i]!.replace(/\r$/, '')
    const line = i + 1

    if (FENCE_RE.test(raw)) {
      // 围栏行本身（开或闭）永远不是内容：``` 和 info string 都不该被当成引用。
      inFence = !inFence
      continue
    }

    if (inFence) {
      // 围栏内：整行裸文本即一个片段，不再解析反引号（见文件头「两个提取面」）。
      segments.push({ text: raw, line })
      continue
    }

    // 行内代码：一行里可以出现多个片段，各自计数。
    for (const m of raw.matchAll(INLINE_CODE_RE)) {
      segments.push({ text: m[1]!, line })
    }
  }

  return segments
}

/**
 * 扫描一个片段里的命令引用。
 *
 * 两条边界，都以「占位符之前」为界：
 *   · 路径 token 只收到第一个 `<...>` 为止。占位符之后是调用方要填的值或模板里的可选
 *     部分，再往里收会把值当子命令（`qiyu query <表>` 不该产出路径 `['query','<表>']`）。
 *   · 选择/省略符号（`|`、`…`、`...`）只在占位符之前判定：那之后的内容本就不参与命令
 *     结构的判定（规则 3）。
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
  const head: string[] = []
  for (const word of words) {
    if (PLACEHOLDER_RE.test(word)) break
    head.push(word)
  }

  // 选择/省略符号：整条无法判定，记入 unverifiable 而不是猜一个路径。
  if (UNVERIFIABLE_RE.test(head.join(' '))) {
    refs.unverifiable.push({ text: content, line, reason: REASON_CHOICE })
    return
  }

  const path: string[] = []
  const flags: string[] = []
  for (const word of head) {
    if (word.startsWith('-')) flags.push(word)
    else path.push(word)
  }

  // 占位符之后的 flag 仍算这条命令的 flag（见函数头注释），但不再进路径。
  const afterPlaceholder = head.length !== words.length
  if (afterPlaceholder) {
    for (const word of words.slice(head.length + 1)) {
      if (word.startsWith('-')) flags.push(word)
    }
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
 * 从 skill 正文里提取全部引用。返回顺序即出现顺序（按行、行内按片段出现位置），
 * 同一引用重复出现不会被去重 —— 校验方需要逐处报行号。
 */
export function extractRefs(text: string): Refs {
  const refs: Refs = { commands: [], kinds: [], sqlSequences: [], unverifiable: [] }

  for (const segment of collectSegments(text)) {
    // 片段两端空白是排版，不是内容：围栏块里的缩进、行内代码两侧的空格都不该影响
    // 「片段是否以 qiyu 开头」这个判断。首尾空白之外的散文仍然不匹配 `^qiyu`。
    const content = segment.text.trim()
    if (content === '') continue

    scanCommand(content, segment.line, refs)
    scanKind(content, segment.line, refs)
    scanSql(content, segment.line, refs)
  }

  return refs
}
