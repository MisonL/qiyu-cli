// src/skill/refs.ts —— 从 skill 正文里提取「可被机器校验的引用」：命令路径 / flag、错误
// `kind`、SQL 序列，以及明知无法静态判定的命令（含选择或省略符号）。
//
// 本文件是纯函数、零业务依赖（除标准库外无 import，实际上连 node:* 都不用）。它只负责
// **提取**，不判断引用是否合法 —— 命令是否在 `COMMAND_TREE` 里、kind 是否在 `ERROR_KINDS`
// 里，是 `skill check`（Task 6）的事。保持这条边界，提取器才能被单独测试，也不会把
// commands 层拉进 skill 层。
//
// 扫描面（collectSurfaces 决定「哪些文本算代码」，scan* 决定算什么引用）：
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
//   · 切词**认识引号**（`splitWords`）：`'…'` / `"…"` 整体算一个词（去引号），其余按非空白
//     切。`--schedule "0 3 * * *"` 是「flag + 一个取值」而不是五个词；未闭合的引号退化为
//     `\S+`，不丢整段（全审查 A2）。
//   · refs 层**不做「哪个 token 是 flag 取值」的判断**：它不认识命令树（零业务依赖），
//     旧版在这里按「flag 之后紧跟的词就是取值」一刀吞，把 bool flag（`--full`）之后的
//     位置参数也吞掉，`skill check` 的位置参数域校验因此整段失效（全审查 A1），也把
//     flag 的位置抹平（`db --profile prod tables` 被判通过，全审查 A3）。现在 `tokens`
//     原样保留**全部** token（命令词 / 位置参数 / flag / flag 取值 / 占位符），由 check
//     层按 `spec.flags` 的 `kind` 重建位置参数。
//   · 路径 token 在第一个 `<...>` 占位符处封口：占位符是取值或位置参数模板，不是子命令
//     （`qiyu query <表>` 不该把 `<表>` 当成子命令）。封口只影响「命令路径」的判定，
//     占位符本身留在 `tokens` 里（否则 `--table <表>` 会被误判成「--table 缺少取值」）。
//   · flag 跨占位符继续收（`--since <时间>` 的 `--since` 仍可静态校验），但**在管道 /
//     选择 / 省略符号处止步** —— 管道右侧是另一条命令，`| head -20` 的 `-20` 不属于 qiyu。
//     占位符之后的这些符号不判 unverifiable（路径已封口，后面本来就不校验）。
//   · `--table=<表>` 按 `=` 切出 flag 名 —— check 层比对的是 flag 名，取值已内联。
//   · 只有 flag / 占位符、没有命令词的 `qiyu --help` 不记成命令引用（见 scanCommand 内注释）。
//
// ⚠️ 本文件**不认识命令树**（零业务依赖、零 import）：命令路径的切分、flag 的取值归属、
// 位置参数的重建都在 check 层做（那里有 `CommandSpec`）。提取器一旦内置 flag 表，就会与
// `commands/spec-types.ts` 漂成第二事实源 —— 那样 bool flag 与值位 flag 的区别就得写两遍。

/**
 * 一条命令引用。
 *
 * `tokens` 是**全部** token，按原文顺序、引号已去：命令词、位置参数、flag、flag 的取值、
 * `<...>` 占位符模板都在里面。refs 层不认识命令树（零业务依赖），因此**不判断**哪个 token
 * 是 flag 的取值、哪个是位置参数 —— 那是 check 层拿到 `spec.flags` 之后的事（按 `kind`
 * 重建：bool 不吞、value/repeatable 吞、未知名不吞）。
 *
 * `flags` 记下每个 flag 的**名字**（`--table=<表>` 归一为 `--table`）与它在 `tokens` 里的
 * **下标**。下标是「flag 写在哪儿」的唯一证据：check 层据此判 `flag_before_subcommand`
 * （flag 落在子命令位）与「接口 id 必须是第一个参数」这类位置违规（全审查 A3）。
 */
export interface CommandRef {
  tokens: string[]
  flags: { name: string; tokenIndex: number }[]
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

/** 规则里钉死的话术，`skill check` 把它原样放进 warnings。 */
const REASON_CHOICE = '含选择/省略符号'

/** 错误分类的窄形态：`kind: rate_limit`。宽形态（如 `kind: foo/bar`）不提取，见规则 4。 */
const KIND_RE = /^kind:\s*([a-z_]+)$/

/** SQL 判定：同时出现大写的 `SELECT` 与 `FROM`，且各自是独立词。大小写敏感。 */
const SELECT_RE = /\bSELECT\b/
const FROM_RE = /\bFROM\b/

/** 围栏行注释：`#` 在行首或前面是空白才算注释，`a#b` / URL 锚点不受影响。 */
const COMMENT_RE = /(^|\s)#.*$/

/**
 * 切词用的引号模式：单引号串 / 双引号串 / 非空白串，三选一，逐个匹配（全审查 A2）。
 * 未闭合的引号匹配不上前两个分支，自然退化为 `\S+` —— 不丢整段。
 */
const QUOTED_TOKEN_RE = /'([^']*)'|"([^"]*)"|(\S+)/g

/** 占位符（整词 `<...>`）判定：check 层重建位置参数时用它跳过模板。 */
export function isPlaceholderToken(word: string): boolean {
  return PLACEHOLDER_RE.test(word)
}

/**
 * `--flag=<占位符>`：flag 名 + 内联取值模板（`--table=<表>`）。整体按 flag 处理 ——
 * 它的 `<`/`>` 是模板括号而不是重定向：A4 扩了 `>`/`<` 之后，若不先接住这种形态，
 * 一条合法的等号写法会被误降级成「无法静态判定」。
 */
const INLINE_PLACEHOLDER_FLAG_RE = /^-+[\w-]+=<[^>]*>$/

/** 一个词：去引号后的内容 + 原文形态。 */
interface Word {
  /** 去引号后的内容（取值本身）。 */
  text: string
  /** 原文形态（保留引号）—— 判断「符号是不是在引号里」要用它。 */
  raw: string
}

/**
 * 切词：引号内的整段算**一个词**（去引号），其余按非空白切（全审查 A2）。
 *
 * 为什么切词要认引号：`--schedule "0 3 * * *"` 的取值本身就是空格分隔的 5 段 CRON，
 * `--body '{"opStart": 1}'` 的取值是带空格的 JSON —— 按裸空白切会把一个合法取值拆成多个
 * 位置参数，把**正确内容判成违规**（check 自己的原则：误报比漏报更糟）。
 *
 * 原文形态（`raw`）是 A4 的前提：shell 语义下 `"a > b"` 里的 `>` 是**数据**（比较运算符），
 * 只有**引号外**的 `>` 才是重定向。少了这个区分，`--sql 'SELECT a > b'` 会被误判成
 * 「无法静态判定」。
 */
function tokenize(text: string): Word[] {
  const words: Word[] = []
  for (const m of text.matchAll(QUOTED_TOKEN_RE)) {
    if (m[1] !== undefined) words.push({ text: m[1], raw: m[0] })
    else if (m[2] !== undefined) words.push({ text: m[2], raw: m[0] })
    else words.push({ text: m[3]!, raw: m[0] })
  }
  return words
}

/**
 * 切词的公开形态：只给词本身（去引号后的文本）。
 */
export function splitWords(text: string): string[] {
  return tokenize(text).map((w) => w.text)
}

/**
 * 剥围栏行的 `#` 注释，但**引号内的 `#` 保留**（全审查 A2）。
 *
 * `qiyu api call ticket.search --body '{"keyword":"a # b"}'` 的 `#` 在单引号里，是 JSON
 * 取值的一部分；旧版直接拿 `COMMENT_RE`（行首或空白后的 `#` 到行尾）剥，会把取值从 `#`
 * 处截断，留下半截 JSON 与两条假位置参数。
 *
 * 做法：先把每个引号段（含未闭合到行尾的那种）临时替换成不含空白、不含 `#` 的编号占位串，
 * 按原口径剥注释，再换回原文。引号段整体可能含空白，编号占位串对切词等价（切词本来就
 * 把引号段当一个词）。
 */
function stripComment(line: string): string {
  const quoted: string[] = []
  const masked = line.replace(/'(?:[^']*)'|"(?:[^"]*)"|'(?:[^']*)$|"(?:[^"]*)$/g, (seg) => {
    quoted.push(seg)
    return `\u0000${quoted.length - 1}\u0000`
  })
  const stripped = masked.replace(COMMENT_RE, '$1')
  return stripped.replace(/\u0000(\d+)\u0000/g, (_, i: string) => quoted[Number(i)]!)
}

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
      // 围栏内容行：先剥注释（引号内的 `#` 保留），再按源文本顺序拆成「行内片段 + 夹在
      // 中间的裸文本」两个面。交错产出（而不是先收行内再收裸文本）是为了让 commands
      // 顺序与原文一致。
      const noComment = stripComment(raw)
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
 * 无法静态判定的信号。占位符之前出现 → 整条记 unverifiable（不阻塞）；占位符之后出现 →
 * 到此为止（右侧是另一条命令或重定向目标，它的 flag / 位置参数不属于本命令）。
 *
 * ⚠️ 复合 / 重定向符号与 `|` **同等对待**（全审查 A4）：旧版只认 `|`，于是
 * `qiyu store init && qiyu sync run` 里的 `&&` / `qiyu` / `sync` / `run` 被当成位置参数
 * 报四条违规，而 `qiyu store init | tee log` 正确降级为 warning —— 同一族 shell 组合语法
 * 两极分化，文档作者被迫拆行。
 *
 * ⚠️ 占位符判定在前：整个词是 `<...>` 的（`<SQL>`、`<表>`）先被 PLACEHOLDER_RE 接走，
 * 单个 `<` 才落到这里。所以 `qiyu query --sql <SQL> > out.json` 的 `>` 出现在占位符之后，
 * 走「止步」分支而不是 unverifiable。
 *
 * 两个正则分开是刻意的（判据不同，理由见 hasShellOperator）：
 *   · `SHELL_OPERATOR_RE` —— shell **结构**符号，只认**引号外**的；
 *   · `ELLIPSIS_RE` —— **内容级**省略信号，整词都认（与引号无关）。
 */
const SHELL_OPERATOR_RE = /[|]|&&|;|>|</
const ELLIPSIS_RE = /…|\.\.\./

/**
 * 一个词里是否含 shell 结构符号（引号外）或省略号。
 *
 * 两条判据的差别是有意的：
 *   · 结构符号（`|`/`&&`/`;`/`>`/`<`）看**引号外** —— 引号里的是数据；
 *   · 省略号（`…`/`...`）**整词**都看 —— 它不表示 shell 结构，只表示「这里有省略，
 *     静态判不了」（`qiyu query --sql "SELECT * FROM x WHERE …"`）。
 */
function hasShellOperator(word: Word): boolean {
  if (ELLIPSIS_RE.test(word.text)) return true
  return SHELL_OPERATOR_RE.test(word.raw.replace(/'[^']*'|"[^"]*"/g, ''))
}

/**
 * 导出给 `skill check` 的表名扫描：扫描面与 `extractRefs` 完全一致（行内代码 + 围栏内容行，
 * 含缩进容忍 / 长度配对 / 围栏内反引号）。brief 规则 1「只在行内代码与围栏块里扫」若由
 * Task 6 重写一遍围栏解析，必然与这里的逻辑漂移 —— 复用是唯一不漂的写法。
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
 * refs 层**只提取、不判断**（本文件的分层约定）：它不认识命令树，所以
 *   · 不判断「哪个 token 是 flag 的取值」—— 旧版在这里一刀切吞掉 flag 紧邻的词，
 *     bool flag（`--full`）之后的位置参数也被吞掉，`skill check` 的位置参数域校验
 *     因此整段失效（审查 A1），flag 的位置也被抹平（审查 A3）。现在 `tokens` 原样保留
 *     全部 token，由 check 层按 `spec.flags` 的 `kind` 重建位置参数。
 *   · 不判断「哪些 token 是命令路径」—— 同样交给 check 层（它有命令树）。
 *
 * 这里仍然要裁定的三件事：
 *   · **切词**：认引号（`splitWords`），`--schedule "0 3 * * *"` 是一个取值不是五个词
 *     （审查 A2）。围栏行的 `#` 注释也认引号（`stripComment`）。
 *   · **占位符**：整词 `<...>` 是模板不是字面值。它**留在 `tokens` 里**（否则
 *     `--table <表>` 会被误判成「`--table` 缺少取值」），但命令路径到此为止 ——
 *     `qiyu query <表>` 的 `<表>` 不是子命令。
 *   · **无法静态判定的符号**：`|`、`…`、`...`、`&&`、`;`、`>`、`<`（审查 A4）。占位符
 *     之前遇到 → 整条记 unverifiable（warning，不阻塞）；占位符之后遇到 → 到此为止
 *     （管道 / 重定向右侧是另一条命令或别的目标，不属于本命令）。
 */
function scanCommand(content: string, line: number, refs: Refs): void {
  const m = COMMAND_RE.exec(content)
  if (!m) return

  const words = tokenize(m[1]!)
  const tokens: string[] = []
  const flags: { name: string; tokenIndex: number }[] = []
  let closed = false

  for (const word of words) {
    const text = word.text
    if (isPlaceholderToken(text)) {
      // 占位符是前一个 flag 的取值或独立位置参数：命令结构在此封口。它仍进 tokens ——
      // check 层要靠它判断「flag 的取值是模板而不是缺值」。
      closed = true
      tokens.push(text)
      continue
    }
    // 引号里的符号是**数据**（`--sql 'SELECT a > b'` 的 `>` 是比较运算符），只有引号外的
    // 才算 shell 语法（A4）。`hasShellOperator` 按**原文**里的真闭合引号段排除，因此
    // `{"k":"a>b"}` 这种引号夹在词中间的形态也判得对。
    if (hasShellOperator(word) && !INLINE_PLACEHOLDER_FLAG_RE.test(text)) {
      if (!closed) {
        // 选择 / 省略 / 复合 / 重定向符号：整条无法判定，记入 unverifiable 而不是猜结构。
        refs.unverifiable.push({ text: content, line, reason: REASON_CHOICE })
        return
      }
      // 占位符之后：右侧是另一条命令或重定向目标，它的 flag / 位置参数不属于本命令。
      break
    }
    if (text.startsWith('-')) {
      flags.push({ name: normalizeFlag(text), tokenIndex: tokens.length })
    }
    tokens.push(text)
  }

  // 只有 flag / 占位符、没有命令词的 `qiyu --help` 之类不记成命令引用：`Refs.commands`
  // 的语义是「正文声称存在这条命令路径」，只有 flag 的调用不构成这种声称（而且
  // `--help` 是全局 flag，各命令都接受，记下来反而会让 check 用空路径去匹配、误报
  // 未知命令）。
  const flagIndexes = new Set(flags.map((f) => f.tokenIndex))
  const hasCommandWord = tokens.some((t, i) => !flagIndexes.has(i) && !isPlaceholderToken(t))
  if (!hasCommandWord) return

  refs.commands.push({ tokens, flags, line })
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
 * 围栏块级 SQL 兜底在最后统一收集，返回前按行稳定排序归位；
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

  // 块级兜底统一 append 在最后，与逐行条目混排时行号会乱序；稳定排序归位，兑现
  // 「返回顺序即出现顺序」的承诺（同行的多条保持插入顺序）。
  refs.sqlSequences.sort((a, b) => a.line - b.line)

  return refs
}
