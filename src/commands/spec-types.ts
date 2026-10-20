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
// 本文件必须保持零依赖（只含类型与常量）：`core/`、`query/`、`sync/` 分层红线之外，
// 它是 commands 层里最底层的一块，被 7 个命令模块与 `cli.ts` 的 `COMMAND_TREE` 共同消费。

/** 位置参数的取值域——`skill check` 据此比对正文里出现的表名 / 报表表 / 任务 id / 接口 id。 */
export type Domain = 'tables' | 'report-tables' | 'task-ids' | 'endpoint-ids'

export interface FlagSpec {
  name: string
  /** repeatable：可重复给（如 `query --group-by`），校验时只关心是否被接受。 */
  kind: 'value' | 'bool' | 'repeatable'
}

export interface CommandSpec {
  /** 命令路径，不含程序名：`['db', 'describe']`。 */
  path: string[]
  /** 完整接受集，**含 `GLOBAL_FLAGS`**——各命令组装时写成 `[...GLOBAL_FLAGS, ...业务 flag]`。 */
  flags: FlagSpec[]
  positionals: { name: string; domain: Domain }[]
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
