// src/skill/check.ts —— `skill check` 的校验逻辑：把 skill 正文里的引用与 CLI 的真实契约
// （命令树 / 表名 / 错误 kind / 位置参数取值域）比对，产出三档判定（设计稿 D3）：
//
//   · violations：引用不存在的命令 / flag / kind / 位置参数取值；flag 写错了位置；正文
//     出现表名；出现完整 SQL 序列；推荐了被显式拒绝的 flag（`--pretty`）。
//   · warnings：无法静态判定的引用（含管道 / 选择 / 复合命令符号等），不阻塞，但要指认位置。
//   · 两者皆空：通过。
//
// 分工边界：`refs.ts` 只负责**提取**（哪些文本算引用、切成哪些 token），本文件只负责
// **判定**。表名扫描复用 `collectSegments` 而不是重写一遍围栏解析 —— 两处扫描面一旦各写
// 一遍必然漂移。
//
// 契约事实由调用方通过 `CheckContext` 注入（`COMMAND_TREE` / `TABLES` / `ERROR_KINDS` /
// 四个取值域闭集），本文件不 import `cli.ts`（会拉进整个 CLI 入口图，层级倒置），也不
// import `SYNC_TASKS` / `allEndpoints` / `REPORT_TABLES`（那会把 registry 的 `specs.json`
// 拉进 skill 层并改变它的依赖面），只从 commands 层取 `findSpec` / `CommandSpec` 与
// `Domain` 类型。分层方向：`skill/` 可以 import `commands/`、`store/`、`core/`，反向禁止。
//
// ⚠️ 校验器**不理解否定语境**：`` `tags` `` 出现在「不是 tags 表」这种句子里同样命中
// `table_name`。skill 正文任何位置都不能写表名，包括用来举例说明「不要写表名」的地方。

import { readFileSync, readdirSync, lstatSync, statSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { findSpec, type CommandSpec, type Domain } from '../commands/spec-types.js'
import { collectSegments, extractRefs, isPlaceholderToken, type CommandRef } from './refs.js'

/**
 * 违规规则名：命令契约（unknown_command / unknown_flag / rejected_flag）、flag 的位置
 * （flag_before_subcommand / flag_before_positional / flag_missing_value）、位置参数取值域
 * （unknown_positional）与内容红线（table_name / sql_sequence / unknown_kind）。
 */
export type ViolationRule =
  | 'unknown_command'
  | 'unknown_flag'
  | 'unknown_positional'
  | 'rejected_flag'
  | 'flag_before_subcommand'
  | 'flag_before_positional'
  | 'flag_missing_value'
  | 'table_name'
  | 'sql_sequence'
  | 'unknown_kind'

export interface Violation {
  /** 1 起算的行号；`checkSkillDir` 还会在 detail 里带上文件名。 */
  line: number
  rule: ViolationRule
  detail: string
}

export interface CheckResult {
  violations: Violation[]
  warnings: { line: number; detail: string }[]
}

export interface CheckContext {
  tree: CommandSpec[]
  tableNames: string[]
  errorKinds: readonly string[]
  /**
   * `Domain` → 该域的合法取值闭集。由调用方注入（`commands/skill.ts` 的 `CHECK_CONTEXT`
   * 从 `TABLES` / `REPORT_TABLES` / `SYNC_TASKS` / `allEndpoints()` 组装）—— `skill/`
   * 因此不需要 import 那几个 registry 模块，`specs.json` 也不会被拉进本层。
   *
   * `Record<Domain, …>` 是刻意的：`Domain` 加一个成员而不在这里补一份闭集，编译期就红。
   */
  domains: Record<Domain, readonly string[]>
}

/**
 * 「第一个位置参数必须紧跟命令词」的判据：**只**读 spec 的第一个槽位（`PositionalSpec.first`）。
 *
 * 真实 CLI 里 `api call` 把 `argv[0]` 直接当接口 id（`callOne` 的 `const [id] = argv`），
 * flag 写在它前面会得到「接口 id 必须是第一个参数」并退出 2。其余命令（`api schema` /
 * `sync run` / `db describe` / `stats fields`）的解析器先剥 flag，flag 与位置参数可以交错，
 * **不能**一并套用这条规则 —— 否则 `qiyu sync run --full dim.staff` 这种合法写法会被误报。
 *
 * ⚠️ 这里**不再**维护命令路径清单（G1 的 `FIRST_POSITIONAL_STRICT` 已删）：那份清单是
 * `CommandSpec` 之外的第二事实源，新增同类命令时只改解析器、漏改清单就会静默失效。
 * 现在唯一的声明处是各命令模块的 spec（`api.ts` 的 `API_SPECS`），由
 * `tests/commands/command-tree.test.ts` 的「解析器行为 vs spec 标记」反向对齐用例守着。
 */
function hasFirstPositionalRule(spec: CommandSpec): boolean {
  return spec.positionals[0]?.first === true
}

/** 转义正则元字符：表名来自 `CheckContext` 注入，按字面匹配而不是正则模式。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 一条 flag 在 `tokens` 里的位置（`refs.ts` 提取，check 层消费）。 */
interface FlagSlot {
  name: string
  tokenIndex: number
}

/** 去掉所有 flag token（取值留在原地）——用于「flag 落在子命令位」时认出用户想写的命令。 */
function dropFlags(tokens: string[], flagAt: Map<number, FlagSlot>): string[] {
  return tokens.filter((_, i) => !flagAt.has(i))
}

/**
 * 去掉所有 flag token **连同它们的取值**（假定每个 flag 都吃一个值）——同上。
 *
 * `qiyu db --profile prod tables` 里 `prod` 是 `--profile` 的取值，剥掉它之后剩下的
 * `['db','tables']` 才能匹配到 `db tables` 这条 spec。
 */
function dropFlagsAndValues(tokens: string[], flagAt: Map<number, FlagSlot>): string[] {
  const out: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    if (flagAt.has(i)) {
      const next = tokens[i + 1]
      if (next !== undefined && !flagAt.has(i + 1)) i++   // 连取值一起吃掉
      continue
    }
    out.push(tokens[i]!)
  }
  return out
}

/**
 * 校验一条命令引用：命中 spec、比对 flag 接受集、判 flag 的位置、重建位置参数并校验取值域。
 *
 * 判定顺序（同一行内多条违规的产出顺序）：
 *   1. 命令路径：`findSpec` 最长前缀匹配，未命中 → `unknown_command`；
 *   2. flag 接受集：**先查 `spec.rejected`**，再查 `spec.flags` 的完整接受集。顺序是硬要求 ——
 *      `--pretty` 同时在 `GLOBAL_FLAGS`（因而在每条 spec 的 `flags` 里）与 `REJECTED_FLAGS`
 *      里，反过来先查 `flags` 会把它判成合法，`rejected_flag` 永远报不出来；
 *   3. flag 的位置：落在命令路径之内 → `flag_before_subcommand`；落在「第一个位置参数」槽位
 *      → `flag_before_positional`；值位 flag 缺取值 → `flag_missing_value`；
 *   4. 位置参数取值域：命令词之后的字面 token 逐个按 `spec.positionals[i].domain` 查注入的
 *      闭集；不在闭集 → `unknown_positional`，位置参数个数超过 spec 声明同样违规。
 */
function checkCommand(cmd: CommandRef, ctx: CheckContext, violations: Violation[]): void {
  const flagAt = new Map<number, FlagSlot>()
  for (const flag of cmd.flags) flagAt.set(flag.tokenIndex, flag)

  // 命令路径 = 第一个占位符之前的 token（占位符是取值模板，不是子命令）。
  const cut = cmd.tokens.findIndex(isPlaceholderToken)
  const head = cut === -1 ? cmd.tokens : cmd.tokens.slice(0, cut)

  // ⚠️ `findSpec` 必须拿到**原始 argv**（flag 也在里面）：`spec-types.ts` 的守卫「路径位
  // 出现以 `-` 开头的 token 即不命中」正是为 `qiyu db --profile prod tables` 这类准备的
  // ——真实分派取 argv[0] 当子命令，flag 落在那里必报「未知子命令」退出 2。旧版 refs 先把
  // flag 剥掉，那条守卫在生产路径上永不触发（审查 A3）。
  let spec = findSpec(ctx.tree, head)
  if (!spec) {
    // flag 落在子命令位时原始 argv 必然不命中（真实分派把 argv[0]/argv[1] 当子命令）。
    // 这里重试两次，只为**认出**用户想写的是哪条命令，好报更准确的 flag 位置违规：
    //   ① 只剥 flag token（取值留在原地）→ `qiyu db --profile tables` 这类；
    //   ② 连取值一起剥（假定每个 flag 都吃一个值）→ `qiyu db --profile prod tables` 这类。
    for (const candidate of [dropFlags(head, flagAt), dropFlagsAndValues(head, flagAt)]) {
      const hit = findSpec(ctx.tree, candidate)
      if (hit && (!spec || hit.path.length > spec.path.length)) spec = hit
    }
  }

  if (!spec) {
    violations.push({
      line: cmd.line,
      rule: 'unknown_command',
      detail: `未知命令：qiyu ${head.join(' ')}（命令树里没有这条路径）`,
    })
    return
  }

  const accepted = new Map(spec.flags.map((f) => [f.name, f]))

  // 2：flag 接受集。
  for (const flag of cmd.flags) {
    if (spec.rejected.includes(flag.name)) {
      // ⚠️ 必须先于 accepted 判断：--pretty 同时属于两者（见函数注释）。
      violations.push({
        line: cmd.line,
        rule: 'rejected_flag',
        detail: `qiyu ${spec.path.join(' ')} 的 ${flag.name} 已知但未实现，别用`,
      })
    } else if (!accepted.has(flag.name)) {
      violations.push({
        line: cmd.line,
        rule: 'unknown_flag',
        detail: `qiyu ${spec.path.join(' ')} 不接受此 flag：${flag.name}`,
      })
    }
  }

  // 3a：flag 落在命令路径之内（`qiyu db --profile prod tables`）——真实分派把 argv[0]/
  // argv[1] 当子命令，flag 落在那里必报「未知子命令」退出 2。
  //
  // ⚠️ 命中这一条时**不再重建位置参数**：命令词与 flag 取值在 token 流里的相对位置已经
  // 不可信（`--profile prod tables` 里 `prod` 到底是取值还是子命令，取决于真实解析器的
  // 顺序），在这种状态下再报「取值不在域闭集里」是**凭空的第二处指控**。一条命令一处
  // 定位清楚的违规，比叠两条可能不实的更有用。
  const inPath = cmd.flags.filter((f) => f.tokenIndex < spec.path.length)
  if (inPath.length > 0) {
    violations.push({
      line: cmd.line,
      rule: 'flag_before_subcommand',
      detail: `qiyu ${spec.path.join(' ')}：flag 必须写在子命令之后，`
        + `${inPath.map((f) => f.name).join('、')} 出现在子命令位`
        + '（真实 CLI 报「未知子命令」，退出码 2）',
    })
    return
  }

  // 3b：少数命令把 argv[0] 直接当第一个位置参数（`api call` 的接口 id）——flag 落在那个
  // 槽位上同样退出 2（`qiyu api call --yes ticket.search`）。判据来自 spec 的槽位标记
  // （`PositionalSpec.first`），本文件不再维护命令清单。
  if (hasFirstPositionalRule(spec)) {
    const atSlot = cmd.flags.find((f) => f.tokenIndex === spec.path.length)
    if (atSlot) {
      violations.push({
        line: cmd.line,
        rule: 'flag_before_positional',
        detail: `qiyu ${spec.path.join(' ')}：第一个位置参数必须紧跟命令词，`
          + `${atSlot.name} 写在了它前面（真实 CLI 退出码 2）`,
      })
    }
  }

  // 4：重建位置参数。按 `spec.flags` 的 `kind` 决定 flag 吃不吃下一个 token：
  //   · `bool` → **不吃**（`--full` 之后的任务 id 是位置参数，不是 flag 取值 —— 审查 A1：
  //     旧版一律吞掉，位置参数域校验整段失效，`qiyu sync run --full no_such_task` 假绿）；
  //   · `value` / `repeatable` → 吃下一个 token（字面值或 `<占位符>` 模板）；
  //   · 未知名 / 被拒名 → 不吃（它本身已会报 unknown_flag / rejected_flag，把后一个 token
  //     还回位置参数更安全）。
  const values: string[] = []
  for (let i = 0; i < cmd.tokens.length; i++) {
    const flag = flagAt.get(i)
    if (flag !== undefined) {
      const slot = accepted.get(flag.name)
      if (slot === undefined || spec.rejected.includes(flag.name) || slot.kind === 'bool') continue
      // `--flag=<值>`：取值已经内联在同一个 token 里，不吃下一个。
      if (cmd.tokens[i]!.includes('=')) continue
      const next = cmd.tokens[i + 1]
      if (next === undefined || flagAt.has(i + 1)) {
        violations.push({
          line: cmd.line,
          rule: 'flag_missing_value',
          detail: `qiyu ${spec.path.join(' ')} 的 ${flag.name} 缺少取值（真实 CLI 退出码 2）`,
        })
        continue
      }
      i++   // 取值被吃掉：它不是位置参数
      continue
    }
    if (i < spec.path.length) continue                          // 命令词
    if (isPlaceholderToken(cmd.tokens[i]!)) continue             // 占位符是模板，不是字面值
    values.push(cmd.tokens[i]!)
  }

  // 位置参数取值域。槽位数用尽时按**最后一个**槽位处理：repeatable（`sync run [任务...]`）
  // 就把余下取值继续按它的域比；不 repeatable（`db describe <表>` 只收一个）才判「超量」。
  // ⚠️ 对合法的变长调用（`qiyu sync run a b`，两个都是真实任务 id）判超量是误报——
  // 把正确内容判成错误比漏报更糟（终审 fix 自查）。
  for (let i = 0; i < values.length; i++) {
    const value = values[i]!
    const slot = spec.positionals[i]
      ?? (spec.positionals.length > 0 && spec.positionals[spec.positionals.length - 1]!.repeatable
        ? spec.positionals[spec.positionals.length - 1]!
        : undefined)
    if (slot === undefined) {
      violations.push({
        line: cmd.line,
        rule: 'unknown_positional',
        detail: `qiyu ${spec.path.join(' ')} 只接受 ${spec.positionals.length} 个位置参数，`
          + `多出的不接受：${value}`,
      })
      continue
    }
    if (!ctx.domains[slot.domain].includes(value)) {
      violations.push({
        line: cmd.line,
        rule: 'unknown_positional',
        detail: `qiyu ${spec.path.join(' ')} 的位置参数 ${slot.name} 不接受此值：${value}`
          + `（不在 ${slot.domain} 闭集里）`,
      })
    }
  }
}

/**
 * 校验一份 skill 文档正文。
 *
 * 判定顺序（violations 最终按行稳定排序，便于按出现位置阅读）：
 *   1. 命令路径：`findSpec` 最长前缀匹配，未命中 → `unknown_command`；
 *   2. flag：**先查 `spec.rejected`**，再查 `spec.flags` 的完整接受集。顺序是硬要求 ——
 *      `--pretty` 同时在 `GLOBAL_FLAGS`（因而在每条 spec 的 `flags` 里）与 `REJECTED_FLAGS`
 *      里，反过来先查 `flags` 会把它判成合法，`rejected_flag` 永远报不出来；
 *   3. flag 的位置与缺值（见 checkCommand 的注释）；
 *   4. 位置参数取值域：命令词之后的字面 token 逐个按 `spec.positionals[i].domain` 查注入的
 *      闭集；不在闭集 → `unknown_positional`，位置参数个数超过 spec 声明同样违规；
 *   5. 表名：只在 `collectSegments` 的代码面片段里扫（与 refs 扫描面一致），词边界、
 *      大小写敏感；
 *   6. SQL 序列：`extractRefs` 已按行 / 围栏块识别；
 *   7. `kind: x`：对 `ERROR_KINDS` 比对；
 *   8. 无法静态判定的命令（含选择 / 省略 / 复合命令符号）进 warnings，不进 violations。
 */
export function checkSkillDoc(text: string, ctx: CheckContext): CheckResult {
  const violations: Violation[] = []
  const warnings: { line: number; detail: string }[] = []
  const refs = extractRefs(text)

  // 1 + 2 + 3 + 4：命令路径、flag 接受集与位置、位置参数取值域。
  for (const cmd of refs.commands) checkCommand(cmd, ctx, violations)

  // 5：表名。代码面片段由 refs.ts 统一收集（行内代码 + 围栏内容行），这里只做词边界匹配。
  //
  // 词边界（审查 52）：`(?<![\w-])` 挡住 `my_sessions` / `all_tags` 这类以表名结尾的标识符，
  // `(?![\w-])` 挡住 `staffing`。另加两条**点号**边界：
  //   · 左 `(?<!\w\.)`：点号后紧跟词字符时不匹配（`dim.staff`、`staff.list.new` 里的
  //     `staff` 是标识符的一部分，不是表名）；
  //   · 右 `(?!\.\w)`：同理，`staff.list.new` 整体命中不到表名 `staff`。
  // ⚠️ 右边界刻意**不**排除句末的 `staff.`（`staff.` 后面没有词字符）——那确实是在提表名，
  // 仍要命中。
  // 大小写敏感（不加 `i`），避免把 `Staff` 之类的英文单词误判成表名。
  // 表名先过 escapeRegExp：当前 TABLES 全是 `[a-z_]+` 所以不转义也安全，但 `tableNames`
  // 是调用方注入的，契约上不能假定它永远只含标识符字符。
  const matchers = ctx.tableNames.map((name) => ({
    name,
    re: new RegExp(`(?<![\\w-])(?<!\\w\\.)${escapeRegExp(name)}(?![\\w-])(?!\\.\\w)`),
  }))
  for (const segment of collectSegments(text)) {
    for (const { name, re } of matchers) {
      if (re.test(segment.text)) {
        violations.push({
          line: segment.line,
          rule: 'table_name',
          detail: `出现表名 ${name}：数据侧事实不得硬编码，改用 qiyu db tables 在运行时获取`,
        })
      }
    }
  }

  // 6：SQL 关键字序列（`extractRefs` 已处理 SELECT/FROM 独立词、跨行块级判定）。
  // detail 里把换行压成空格，避免多行块级序列把报告撑散。
  for (const sql of refs.sqlSequences) {
    violations.push({
      line: sql.line,
      rule: 'sql_sequence',
      detail: `出现完整 SQL 关键字序列：${sql.text.replace(/\s+/g, ' ')}`,
    })
  }

  // 7：错误 kind。
  for (const kind of refs.kinds) {
    if (!ctx.errorKinds.includes(kind.name)) {
      violations.push({
        line: kind.line,
        rule: 'unknown_kind',
        detail: `未知错误 kind：${kind.name}（ERROR_KINDS 里没有这个成员）`,
      })
    }
  }

  // 8：无法静态判定 → warning（设计稿 D3：退出码 0，不阻塞）。
  for (const item of refs.unverifiable) {
    warnings.push({ line: item.line, detail: `无法静态判定（${item.reason}）：${item.text}` })
  }

  // 各规则按出现顺序产出，合并后按行稳定排序（V8 的 sort 是稳定排序），
  // 同一行的多条保持「命令 → flag → 位置参数 → 表名 → SQL → kind」的规则顺序。
  violations.sort((a, b) => a.line - b.line)
  return { violations, warnings }
}

/**
 * 递归收集目录下的 `.md` 文件（审查 13）。
 *
 * 为什么要递归：`installSkill` 的 `copyTree` 把 `src/skill/qiyu/` **整棵树**复制到实体
 * 目录（设计稿 D5.1 预期过「拆分 references/」的形态），而 `checkSkillDir` 此前只读顶层
 * `*.md` —— 正文一旦拆出子目录，里面的 `.md` 会被安装却**永远不被校验**，是安装与校验
 * 的不对称。
 *
 * 四条约束：
 *   · 隐藏项（`.` 开头）跳过；
 *   · 符号链接只在**指向目录内部**时收（避免读目录外的内容）；目录环另由递归栈上的
 *     realpath 集合挡住（终审 F2：只比 root 挡不住 `loop -> .` 这类指向祖先的链接，
 *     此前靠路径长度撞 ENAMETOOLONG 才停，同一违规会被报几十次）；
 *   · 目录不存在 / 不可读时**抛错**（由调用方守卫），不静默当成「没有文件」；
 *   · 返回的相对路径用**逻辑路径**（相对被检查的目录），不是 realpath —— 展示给用户看
 *     的是「正文里叫什么」，不是「磁盘上实际落在哪儿」。
 */
function collectMarkdownFiles(
  dir: string,
  root: string,
  prefix: string,
  out: { abs: string; rel: string }[],
  stack: Set<string> = new Set(),
): void {
  // 递归栈去重：进入一个**真实目录**前记录，返回时移除。环（`loop -> .` 或
  // `a/link -> a`）会在第二次进入同一真实目录时被挡下；而同一目录的不同**逻辑**
  // 路径（两条并列链接）仍会各自展开——栈是路径级的，不是全局 visited。
  let realDir: string
  try {
    realDir = realpathSync(dir)
  } catch {
    realDir = dir   // realpath 失败：退回字面路径（目录本身仍可能可读）
  }
  if (stack.has(realDir)) return
  stack.add(realDir)
  try {
    collectMarkdownFilesInner(dir, root, prefix, out, stack)
  } finally {
    stack.delete(realDir)
  }
}

function collectMarkdownFilesInner(
  dir: string,
  root: string,
  prefix: string,
  out: { abs: string; rel: string }[],
  stack: Set<string>,
): void {
  const names = readdirSync(dir)   // 目录不存在 → ENOENT（与旧实现同一条错误面）
  for (const name of [...names].sort()) {
    if (name.startsWith('.')) continue
    const full = join(dir, name)
    const rel = prefix === '' ? name : `${prefix}/${name}`
    let isDir = false
    let isFile = false
    let st: ReturnType<typeof lstatSync>
    try {
      st = lstatSync(full)
    } catch {
      continue   // 读不到就跳过（不是本组要处理的错误面）
    }
    if (st.isSymbolicLink()) {
      let real: string
      try {
        real = realpathSync(full)
      } catch {
        continue   // 断链：跳过
      }
      if (real !== root && !real.startsWith(root + sep)) continue   // 指向目录外：跳过
      try {
        const target = statSync(full)
        isDir = target.isDirectory()
        isFile = target.isFile()
      } catch {
        continue
      }
    } else {
      isDir = st.isDirectory()
      isFile = st.isFile()
    }
    if (isDir) {
      collectMarkdownFiles(full, root, rel, out, stack)
      continue
    }
    if (isFile && name.endsWith('.md')) out.push({ abs: full, rel })
  }
}

/**
 * 校验一个 skill 文档目录：递归读 `dir` 下的所有 `.md`，逐个 `checkSkillDoc` 并汇总。
 *
 * 汇总时把「文件:行」前缀写进 detail（如 `SKILL.md:3 …`；子目录里的写成
 * `references/foo.md:3 …`）—— `Violation` 没有文件名字段，多文件汇总时只靠行号无法
 * 定位；`line` 仍保留原行号供程序化消费。
 *
 * ⚠️ 抛错边界（本函数不吞错，由调用方守卫，`qiyu skill check` 要接）：
 *   · `dir` 不存在 → `readdirSync` 抛 `ENOENT`；
 *   · `dir` 下有**名为 `*.md` 的子目录** → 递归进去（不再像旧实现那样把目录当文件读、
 *     抛 `EISDIR`）；
 *   · 某个文件读不出来（权限等）→ `readFileSync` 的原始错误。
 */
export function checkSkillDir(dir: string, ctx: CheckContext): CheckResult {
  const violations: Violation[] = []
  const warnings: { line: number; detail: string }[] = []
  // realpath 后的根：符号链接的「是否指向目录内」要按**真实落点**比，否则
  // `~/.claude/skills` 这种「目录本身是符号链接」的布局会被误判成「指向目录外」。
  // realpath 失败（目录不存在）不在这里抛 —— 错误面由下面的 readdirSync 统一给
  // （与旧实现同一条：ENOENT 来自 readdirSync，不是 realpathSync）。
  let root = resolve(dir)
  try {
    root = realpathSync(root)
  } catch {
    // 目录不存在：交给 readdirSync 抛 ENOENT（错误文案与旧实现一致）。
  }
  const files: { abs: string; rel: string }[] = []
  collectMarkdownFiles(dir, root, '', files)

  for (const file of files) {
    const result = checkSkillDoc(readFileSync(file.abs, 'utf8'), ctx)
    for (const v of result.violations) {
      violations.push({ ...v, detail: `${file.rel}:${v.line} ${v.detail}` })
    }
    for (const w of result.warnings) {
      warnings.push({ ...w, detail: `${file.rel}:${w.line} ${w.detail}` })
    }
  }

  return { violations, warnings }
}
