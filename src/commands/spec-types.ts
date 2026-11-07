// src/commands/spec-types.ts —— F 组「技能契约校验」的类型底座：`CommandSpec` 是命令
// 接受哪些 flag / 位置参数的**唯一事实源**，由 `skill check` 用它比对 skill 正文里的
// `qiyu …` 引用（spec design D4）。
//
// 为什么不继续从 usage 散文里正则解析：散文已经与实现漂移了至少三处（顶层 USAGE 漏写
// `db`/`sync status` 的 store 三件套；`api schema` 曾写着 `[--pretty]` 却拒绝它——
// 该 flag 已于 2026-10-24 实现，此处保留这段漂移史作为该建模决定的例证）。
// 再扫一遍散文只会把「必然失败的命令」判成合法。
//
// 三条建模约束（不满足就退化成第二事实源）：
//   · `CommandSpec.flags` 必须是该命令的**完整接受集**，不是「额外的」flag。只记差异的话，
//     skill 里写 `` `qiyu api list --no-validate` ``（真实用法错误）会被判通过。
//   · 「完整」**包含全局 flag**：各命令组装 spec 时写成 `[...GLOBAL_FLAGS, ...业务 flag]`。
//     校验方只查这一份，不再另行合并（两处各合一次是漂移的来源）。若一个 flag 同时
//     出现在 `rejected` 与 `flags` 里，必须**先查 `rejected`**，否则会把它判合法——
//     `--pretty` 曾是这种情形（现已实现，不再属于 `rejected`；次序规则保留）。
//   · `--pretty` 曾建模成 `rejected`（承诺过、未实现）：每个模块都用 `usageFail` 拒绝它，
//     spec §11.2 E 也明令不要用。**2026-10-24（G1）起它已实现**（缩进 JSON），
//     `REJECTED_FLAGS` 清空为空数组 —— **机制保留**（`rejected` 字段与 `skill check`
//     的 `rejected_flag` 规则都在，将来若再出现"已知但显式拒绝"的 flag 直接登记），
//     只是当前没有任何 flag 属于这一类。
//
// 本文件保持「几乎零依赖」（只含类型、常量与几个纯函数）：`core/`、`query/`、`sync/`
// 分层红线之外，它是 commands 层里最底层的一块，被各命令模块与 `tree.ts` 的
// `COMMAND_TREE` 共同消费。
// ⚠️ 唯一的外部依赖是 `output.ts` 的 `describeArgs`（2026-11-06 Codex 审查引入）：
// 错误文案里的参数渲染必须只有一份实现（空串/纯空白要写成 `''`/`' '`），
// 在 spec-types 里再写一遍就是第二事实源。无循环 —— `output.ts` 只 import
// `core/sanitize.js`，不 import 本文件（`tests/store/layering.test.ts` 的分层规则也放行）。

import { describeArgs } from '../output.js'

/**
 * 位置参数的取值域——`skill check` 据此比对正文里出现的表名 / 报表表 / 任务 id / 接口 id。
 *
 * ⚠️ `endpoint-ids` 与 `callable-endpoint-ids` 是**两个**域，不是一个域的两种写法（G3 审查 C2）：
 *   · `endpoint-ids` —— 注册表全集，`api schema <id>` 用它。查形状对 `callable: false` 的
 *     接口同样合法（实测 `api schema crm.modifyOrder` 退出码 0），用 callable 子集会让
 *     正文里合法的 schema 查询被判 `unknown_positional`（假阳性）。
 *   · `callable-endpoint-ids` —— 只含 `callable: true`，`api call <id>` 用它。调不可调用的
 *     接口运行时必然 exit 2（实测 `api call crm.modifyOrder` → 「接口不可主动调用」），
 *     用全集会让这条**必然失败**的调用被判合法（假阴性，正是 check 要防的）。
 */
export type Domain = 'tables' | 'report-tables' | 'task-ids' | 'endpoint-ids' | 'callable-endpoint-ids'

export interface FlagSpec {
  name: string
  /** repeatable：可重复给（如 `query --group-by`），校验时只关心是否被接受。 */
  kind: 'value' | 'bool' | 'repeatable'
  /**
   * 取值**允许以 `--` 开头**（目前只有 `query --sql`：SQL 的行注释以 `-- ` 开始）。
   *
   * 值位守卫用它区分「取值恰好是下一个 flag（真缺值）」与「取值只是以 `--` 开头」——
   * 帮助模式的检查（`helpArgsError`）与 `query` 自己的解析器都读这一个字段，不各写一份。
   */
  dashValue?: boolean
}

/**
 * 一个位置参数槽位。
 *
 * `repeatable` 表示「可给任意多个」（如 `sync run [任务...]`）：校验方在槽位数用尽后把
 * 余下的字面取值继续按**最后一个**槽位的域比，而不是判「超量」。
 *
 * ⚠️ 没有 `repeatable` 时，「个数超过 spec 声明」会被判成违规——对 `sync run a b` 这种
 * **合法调用**是误报（把正确内容判成错误），比漏报更糟。
 */
export interface PositionalSpec {
  name: string
  domain: Domain
  repeatable?: boolean
  /**
   * 位置纪律：这个槽位**必须紧跟在命令词之后**，flag 写在它前面时真实 CLI 退 2。
   *
   * 语义来自解析器形态，不是偏好：`api call` 的 `callOne` 是 `const [id] = argv` ——
   * 它把 `argv[0]` 直接当接口 id，`qiyu api call --yes ticket.search` 报
   * 「接口 id 必须是第一个参数」并退出 2。其余带位置参数的命令（`api schema` /
   * `sync run|status|verify` / `db describe` / `stats fields`）都是**先剥 flag 再取位置**
   * （`parseStoreFlags` / `parseSubFlags` / 显式 `filter`），flag 与位置参数可交错 ——
   * 给它们标 `first` 会让 `skill check` 把 `qiyu sync run --full dim.staff` 这种合法写法
   * 误报成 `flag_before_positional`。
   *
   * ⚠️ 只在 `positionals[0]` 上有意义：`first` 描述的是「第一个位置参数槽位」，第二个
   * 槽位没有「紧跟命令词」这回事。校验方只读 `spec.positionals[0]?.first`。
   *
   * ⚠️ 这是**唯一**表达该约束的地方：`skill/check.ts` 不再维护命令路径清单（那是
   * `CommandSpec` 之前的第二事实源）。`tests/commands/command-tree.test.ts` 有一条
   * 反向对齐用例：用行为探针算出「解析器真把 argv[0] 当位置参数」的命令集合，断言它
   * 与「标了 `first` 的 spec」完全一致 —— 漏标会被抓，误标同样会被抓。
   */
  first?: boolean
}

export interface CommandSpec {
  /** 命令路径，不含程序名：`['db', 'describe']`。 */
  path: string[]
  /** 完整接受集，**含 `GLOBAL_FLAGS`**——各命令组装时写成 `[...GLOBAL_FLAGS, ...业务 flag]`。 */
  flags: FlagSpec[]
  /** 位置参数槽位，语义见 `PositionalSpec`（含 `repeatable` / `first` 两条纪律）。 */
  positionals: PositionalSpec[]
  /** 已知但显式拒绝的 flag（当前为空：`--pretty` 已于 2026-10-24 实现）。 */
  rejected: string[]
}

/**
 * 所有命令都接受的全局 flag（解析器里的 `KNOWN`）。
 *
 * ⚠️ `--pretty` 曾同时出现在 `REJECTED_FLAGS` 里，校验方必须先查 `rejected` 再查
 * `flags`。**2026-10-24（G1）起它已实现**，`REJECTED_FLAGS` 为空 —— 顺序规则保留
 * （机制仍在），将来再有"已知但显式拒绝"的 flag 时仍然先查 `rejected`。
 */
export const GLOBAL_FLAGS: FlagSpec[] = [
  { name: '--help', kind: 'bool' },
  { name: '-h', kind: 'bool' },
  { name: '--pretty', kind: 'bool' },
]

/**
 * `GLOBAL_FLAGS` 的名字集合，供各解析器的 `KNOWN` 使用。
 *
 * 派生而不是手写：解析器的「已知 token 集」与 spec 的「完整接受集」必须同源，
 * 否则加一个全局 flag 时两处会各自漂移（`--pretty` 就是这样同时存在于两者里的）。
 */
export const GLOBAL_FLAG_NAMES: readonly string[] = GLOBAL_FLAGS.map((f) => f.name)

/**
 * 渲染「可用：…」错误文案里的 flag 清单。
 *
 * 为什么放在这里：文案里那份清单过去是手写的，与解析器接受的 flag 是**两份**事实源
 * （`sync run` 的 `可用：--full --since …` 与它的解析条件各写一遍）。现在两边都从
 * 同一个模块级 `FlagSpec[]` 派生，加 flag 时不会出现「解析器认了、文案没提」。
 *
 * `separator` 由调用方给：`api` 族用「、」，`sync run` 的历史文案用空格——**最终字符串
 * 必须与改造前逐字一致**，多个测试钉着它们（如 `api.test.ts` 的 `可用：--body`）。
 *
 * ⚠️ 目前只有 `api list` 与 `sync run` 用它；`api call` / `api schema` 的文案带取值
 * 占位符或点名的是 `rejected` flag，**保持字面量**（见 `api.ts` 的说明）。
 */
export function renderFlagNames(
  flags: readonly FlagSpec[],
  opts: { separator?: string } = {},
): string {
  return flags.map((f) => f.name).join(opts.separator ?? '、')
}

/** 显式拒绝的 flag。**当前为空**（`--pretty` 已于 2026-10-24 实现），机制保留：
 *  「已知但显式拒绝」是独立的错误类别（区别于「未知参数」），将来有新成员时直接登记这里，
 *  `skill check` 的 `rejected_flag` 规则会自动生效。 */
export const REJECTED_FLAGS: string[] = []

/**
 * `--pretty` 被写在**子命令之前**时的统一话术（G1）。
 *
 * 为什么不是「未知子命令」：`--pretty` 是真实存在、已实现的**输出格式开关**，
 * 把它说成"未知子命令"是一句事实错误。它也确实不能改整个命令组 —— 输出开关
 * 必须挂在**具体的那条叶命令**上（`store init --pretty`），因为要格式化的是
 * 那条命令的 JSON。所以回答"怎么写才有效"，而不是"你写错了"。
 *
 * 分派层的 8 个伪命令分支（cli/api/auth/store/sync/db/stats/skill）共用这一句，
 * 同一形状的输入在各层得到同一答案。
 */
export function prettyAfterSubcommand(group: string): string {
  return `--pretty 是输出格式开关，必须写在具体子命令之后（如 \`qiyu ${group} … --pretty\`）。` +
    '写在这里没有可修饰的命令'
}

/**
 * 存储定位三件套（store 命令同族）。值位语义唯一事实源在 `store-flags.ts`：
 * `STORE_VALUE_FLAG_NAMES` 从这里派生，解析器与 spec 消费同一份，避免两边各写一遍
 * `'--db' || '--profile' || '--backend'` 而漂移。
 */
export const STORE_FLAGS: FlagSpec[] = [
  { name: '--db', kind: 'value' },
  { name: '--profile', kind: 'value' },
  { name: '--backend', kind: 'value' },
]

/**
 * 从一份 flag 清单里取出**吃值的** flag 名（`kind: 'value'` 或 `'repeatable'`）。
 *
 * `query` 的解析器用它派生 `VALUE_FLAGS`：可重复的 `--group-by` 与普通值位一样吃一个
 * 值，只是可重复，所以两者同属「值位」。解析器不再自己手写一份值位名单。
 */
export function valueFlagNames(flags: readonly FlagSpec[]): string[] {
  return flags.filter((f) => f.kind === 'value' || f.kind === 'repeatable').map((f) => f.name)
}

/**
 * `--help` 模式下的参数检查（唯一实现点，2026-11-06 审查）：只把**不在完整接受集里的
 * flag** 与**缺值的值位 flag** 当错误；位置参数与被正确消费的取值在帮助模式下忽略
 *（`tickets`、`0 3 * * *` 都是取值/位置参数，不是要检查的对象）。
 *
 * 帮助请求不该因为**合法参数**而失败：`qiyu db describe tickets --help` 是 Agent 想
 * 看帮助的常规写法，而此前各命令的 help 分支拿 `KNOWN = GLOBAL_FLAG_NAMES` 过滤 argv，
 * 于是 `tickets` / `--db` / `--schedule 0 3 * * *` 全被判成「未知参数」并退出 2；
 * 同一命令行在 `api list` / `sync run` / `skill *` 上却退出 0（它们的 KNOWN 来自 spec）。
 * 更重的是：`skill check` 按 `CommandSpec.flags` 判这些命令**合法**，检查器与运行时的
 * 「合法调用集」因此互斥。
 *
 * ⚠️ **取值是否成立由该 flag 自己的规则决定**（Codex PR #69 两轮实测）：
 *   · 默认：下一 token 以 `--` 开头 = 缺值（沿 `parseStoreFlags` 的判据）。无条件吞掉
 *     下一个 token 会让 `db tables --db --bogus --help` 打印帮助并静默吞掉 `--bogus`，
 *     而正常解析对同一输入判「`--db` 缺少取值」（退出码 2）—— 帮助模式不能更宽松；
 *   · `FlagSpec.dashValue: true`（如 `query --sql` 的 SQL 行注释）：取值可以以 `--` 开头，
 *     只有**恰好是已知 flag token** 才算缺值 —— 与 `query` 的 `FLAG_TOKENS` 判据同源，
 *     否则 `query --sql "-- 注释\nSELECT 1" --help` 会把合法 SQL 判成「未知 flag」；
 *   · 值位在末尾（没有下一 token）= 缺值，帮助模式同样要报 —— 正常解析也会报。
 */
export function helpArgsError(
  argv: readonly string[],
  flags: readonly FlagSpec[],
  unknownSuffix = '',
): string | undefined {
  const known = new Set(flags.map((f) => f.name))
  const values = new Set(valueFlagNames(flags))
  const dashOk = new Set(flags.filter((f) => f.dashValue === true).map((f) => f.name))
  const unknown: string[] = []
  const missingValue: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h') continue
    if (!a.startsWith('-')) continue
    if (!known.has(a)) { unknown.push(a); continue }
    if (!values.has(a)) continue
    const v = argv[i + 1]
    if (v === undefined) { missingValue.push(a); continue }
    const flagLike = dashOk.has(a) ? known.has(v) : v.startsWith('--')
    if (flagLike) { missingValue.push(a); continue }
    i++   // 消费它的取值（取值本身不是参数）
  }
  if (missingValue.length > 0) return `${missingValue.join('、')} 缺少取值`
  if (unknown.length > 0) return `未知参数：${describeArgs(unknown)}${unknownSuffix}`
  return undefined
}

/**
 * 按最长前缀匹配命令路径：`['sync','run']` 优先于 `['sync']`。
 *
 * 用**原始 argv** 逐位比较，不预先滤掉 flag：真实分派取 argv[0] 当子命令
 * （`db.ts` / `sync.ts` 的 `const [sub, ...rest] = argv`），`qiyu db --profile tables`
 * 会报「未知子命令：--profile」并退出 2。若先滤掉 flag 再匹配，这里会误命中
 * `['db','tables']`——把一条运行时必然失败的命令判成合法，正是 skill check 要防的假阴性。
 *
 * 两条约束：
 *   · 路径位（i < path.length）出现以 `-` 开头的 token 即不命中；
 *   · 分组命令（tree 里还有更深的 spec）的子命令位不能是 flag：`sync --db x run` 里
 *     `--db` 落在 `sync` 的子命令位，真实分派同样报未知子命令。
 * 路径之后的位置参数不参与比较（`db describe sessions` 的 `sessions`），所以位置参数
 * 恰好等于某个命令名时也不会把路径凑长——tree 里没有那条 spec 就不命中。
 *
 * ⚠️ **tree 不变量：不得存在既是叶命令、又是更深 spec 前缀的 path。**
 * 分组判定 `isGroup` 只看「tree 里有没有更深的 spec」，分不清「更深 spec 挂在哪个
 * 父层」：若 tree 里同时有 `['sync']` 与 `['sync','run']`，`['sync']` 会被当作分组，
 * 于是 `sync --db x run` 虽然真实分派取 argv[0]=`sync`、把 `run` 当位置参数跑，
 * 却被判成不命中——合法 flag 被误拒（Task 1 复审 N-2）。真实分派（`const [sub, ...rest]
 * = argv`）本就只有「叶命令 / 分组」两种形状，所以这条不变量不损失表达力。
 * `tests/commands/command-tree.test.ts` 有断言钉住它；`spec-types.test.ts` 的 fixture
 * 含 `['sync']` 只是为了单独测试 `isGroup` 分支的行为，不是合法的生产 tree。
 */
export function findSpec(tree: CommandSpec[], argv: string[]): CommandSpec | undefined {
  let best: CommandSpec | undefined
  for (const spec of tree) {
    if (spec.path.length > argv.length) continue
    let matched = true
    for (let i = 0; i < spec.path.length; i++) {
      const token = argv[i]!
      if (token.startsWith('-') || token !== spec.path[i]) { matched = false; break }
    }
    if (!matched) continue
    const isGroup = tree.some(
      (other) => other.path.length > spec.path.length && spec.path.every((seg, i) => other.path[i] === seg),
    )
    if (isGroup && argv[spec.path.length]?.startsWith('-')) continue
    if (!best || spec.path.length > best.path.length) best = spec
  }
  return best
}
