// src/commands/spec-types.ts —— F 组「技能契约校验」的类型底座：`CommandSpec` 是命令
// 接受哪些 flag / 位置参数的**唯一事实源**，由 `skill check` 用它比对 skill 正文里的
// `qiyu …` 引用（spec design D4）。
//
// 为什么不继续从 usage 散文里正则解析：散文已经与实现漂移了至少三处（顶层 USAGE 漏写
// `db`/`sync status` 的 store 三件套；`api schema` 写着 `[--pretty]` 却显式拒绝它）。
// 再扫一遍散文只会把「必然失败的命令」判成合法。
//
// 三条建模约束（不满足就退化成第二事实源）：
//   · `CommandSpec.flags` 必须是该命令的**完整接受集**，不是「额外的」flag。只记差异的话，
//     skill 里写 `` `qiyu api list --no-validate` ``（真实用法错误）会被判通过。
//   · 「完整」**包含全局 flag**：各命令组装 spec 时写成 `[...GLOBAL_FLAGS, ...业务 flag]`。
//     校验方只查这一份，不再另行合并（两处各合一次是漂移的来源）。但必须**先查
//     `rejected` 再查 `flags`**——`--pretty` 同时在两者里，顺序反了会把它判合法。
//   · `--pretty` 建模成 `rejected` 而不是合法 flag：每个模块都走 `usageFail` 拒绝它，
//     spec §11.2 E 也明令不要用。命中 `rejected` 要单独给「已知但未实现」话术，区别于
//     「该命令不接受此 flag」。
//
// 本文件必须保持零依赖（只含类型、常量与几个纯函数）：`core/`、`query/`、`sync/`
// 分层红线之外，它是 commands 层里最底层的一块，被各命令模块与 `tree.ts` 的
// `COMMAND_TREE` 共同消费。

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
  /** 已知但显式拒绝的 flag（当前只有 `--pretty`）。 */
  rejected: string[]
}

/**
 * 所有命令都接受的全局 flag（解析器里的 `KNOWN`）。
 *
 * ⚠️ `--pretty` 同时出现在 `REJECTED_FLAGS` 里：校验方必须**先查 `rejected` 再查
 * `flags`**，否则它会因为「在完整接受集里」被判合法——而每个模块实际都用 `usageFail`
 * 拒绝它，skill 里照写必然失败。
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

/** 显式拒绝的 flag。从 GLOBAL_FLAGS 里手写一份，而不是 filter 派生——`kind` 是 bool，
 *  「是否被拒绝」不是能从 kind 推出来的属性，硬推会把 `--help` 也卷进来。 */
export const REJECTED_FLAGS: string[] = ['--pretty']

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
