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
//   · `GLOBAL_FLAGS` 同理：各命令的解析器 `KNOWN` 只认 `--help/-h/--pretty`，业务 flag
//     全在各自的常量里。所以校验时要 `[...spec.flags, ...GLOBAL_FLAGS]` **合并后**再比，
//     只看 `spec.flags` 会把 `db tables --db` 误判非法。
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
  /** 完整接受集，不含 `GLOBAL_FLAGS`——校验方负责合并。 */
  flags: FlagSpec[]
  positionals: { name: string; domain: Domain }[]
  /** 已知但显式拒绝的 flag（当前只有 `--pretty`）。 */
  rejected: string[]
}

/** 所有命令都接受的全局 flag（解析器里的 `KNOWN`）。 */
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
 * 做法：从 argv 里摘出**不以 `-` 开头的** token 组成序列，取它的逐个前缀去 tree 里找，
 * 记下 `path.length` 最长的命中。不剪位置参数是安全的——位置参数恰好等于某个命令名
 * （如 `db describe sessions`），`sessions` 本身不在 tree 里，最长命中仍是 `['db','describe']`。
 *
 * 命中之后的位置参数**没有语义**（域校验是 `skill check` 自己的事），所以这里不再把
 * 命中之后的部分剪掉。别试图「命令后遇 flag 即停」来替省略号收窄范围：
 * `['sync','run','--full','dim.staff']` 靠省略号能命中，改成遇 flag 即停就会返回
 * `['sync']`——把一条合法命令判成不接受 `--full`，正是 spec D4 要防的那类误判。
 */
export function findSpec(tree: CommandSpec[], argv: string[]): CommandSpec | undefined {
  const tokens = argv.filter((a) => !a.startsWith('-'))
  let best: CommandSpec | undefined
  for (const spec of tree) {
    if (spec.path.length > tokens.length) continue
    if (spec.path.every((seg, i) => tokens[i] === seg) && (!best || spec.path.length > best.path.length)) {
      best = spec
    }
  }
  return best
}
