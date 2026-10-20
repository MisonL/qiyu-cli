// src/commands/tree.ts —— 全 CLI 的 `CommandSpec` 汇总（F 组 D4）。
//
// 为什么单独一个文件、而不是放在 `cli.ts`（计划原文的位置）：`COMMAND_TREE` 的消费者是
// `src/skill/check.ts`，而 `skill/` 是与 `commands/` 平级的**叶子层**。让叶子层 import
// `cli.ts` 会把它反向拉进整个 CLI 入口（含 `run()`、USAGE 与 7 个命令模块的全部依赖），
// 层级倒置；本文件只 import 各命令模块并汇总，`cli.ts` 需要时从它取。
//
// 排序不是契约（`path` 自描述），消费者自行按需索引。但**不得**在这里合并/改写任何
// spec：它是各模块声明的并集，唯一性由 `tests/commands/command-tree.test.ts` 钉住
// （16 条叶命令 + tree 不变量）。
import { AUTH_SPECS } from './auth.js'
import { API_SPECS } from './api.js'
import { STORE_SPECS } from './store.js'
import { SYNC_SPECS } from './sync.js'
import { DB_SPECS } from './db.js'
import { QUERY_SPECS } from './query.js'
import { STATS_SPECS } from './stats.js'
import type { CommandSpec } from './spec-types.js'

export const COMMAND_TREE: CommandSpec[] = [
  ...AUTH_SPECS, ...API_SPECS, ...STORE_SPECS, ...SYNC_SPECS, ...DB_SPECS, ...QUERY_SPECS, ...STATS_SPECS,
]
