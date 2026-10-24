// src/commands/skill-specs.ts —— skill 三条叶子命令的 `CommandSpec`（G3 审查 C1）。
//
// 为什么单独一个文件、而不是从 `commands/skill.ts` 导出：`skill.ts` import `tree.ts`
// （取 `COMMAND_TREE` 组装校验上下文），`tree.ts` 若反过来 import `skill.ts` 就是循环
// import。本文件是**叶子模块**：只 import `spec-types.ts`，skill.ts 与 tree.ts 各自从
// 这里取同一份事实，不经过对方。
//
// 为什么 flag 集不能在这里手写第二份：`skill.ts` 原本就有一套本地解析器（`parseFlags`
// 手写 value/repeat/bool 三类名单）。spec 与解析器各写一份，必然出现「spec 认了、解析器
// 不认」或反过来（`sync uninstall` 的 `--db` 就是前车之鉴）。所以三类名单定义在
// **本文件**，`skill.ts` 的解析器从 `skillFlagSpecs(path)` 派生——唯一事实源是 `SKILL_SPECS`，
// `tests/commands/command-tree.test.ts` 的行为式探针再钉住「spec 里的每个 flag 都被真实
// 解析器接受、且每个业务 flag 都被 spec 收录」。
//
// ⚠️ `positionals: []`：三个子命令都不接受位置参数（`skill.ts` 的 `prelude` 对任何
// 位置参数退 2「skill <sub> 不接受位置参数」）。`--link` 的取值是 agent 名而不是位置参数，
// 是 `kind: 'repeatable'` 的 flag 取值，不需要域；`--dir` 是路径，域模型表达不了自由路径，
// 校验方对 `value`/`repeatable` 的**取值**不做域比对（只比对位置参数），见 `skill/check.ts`。

import { GLOBAL_FLAGS, REJECTED_FLAGS, type CommandSpec, type FlagSpec } from './spec-types.js'

/** skill 的三条叶子命令路径（分派表与 spec 共用，避免两处各写一份字符串）。 */
export type SkillLeafPath = 'install' | 'check' | 'where'

const FLAGS: Record<SkillLeafPath, FlagSpec[]> = {
  // `--link` 可重复（点名多个 agent）；`--no-link` 与它互斥，由命令层裁决（usageFail）。
  install: [
    ...GLOBAL_FLAGS,
    { name: '--dir', kind: 'value' },
    { name: '--link', kind: 'repeatable' },
    { name: '--no-link', kind: 'bool' },
    { name: '--force', kind: 'bool' },
    { name: '--dry-run', kind: 'bool' },
  ],
  // `--installed` 与 `--compare` 互斥；`--dir` 只配合两者之一使用（命令层裁决）。
  check: [
    ...GLOBAL_FLAGS,
    { name: '--installed', kind: 'bool' },
    { name: '--compare', kind: 'bool' },
    { name: '--dir', kind: 'value' },
  ],
  where: [
    ...GLOBAL_FLAGS,
    { name: '--dir', kind: 'value' },
  ],
}

export const SKILL_SPECS: CommandSpec[] = (['install', 'check', 'where'] as const).map((sub) => ({
  path: ['skill', sub],
  flags: FLAGS[sub],
  positionals: [],
  rejected: REJECTED_FLAGS,
}))

/**
 * 按子命令取三类 flag 名单，供 `skill.ts` 的解析器派生（`value`/`repeatable`/`bool`）。
 *
 * 分派层（`skill --help` / `skill --pretty`）只需要 `GLOBAL_FLAGS` 里的帮助开关，
 * 那部分仍按 `GLOBAL_FLAG_NAMES` 派生，不经过这里。
 */
export function skillFlagSpecs(sub: SkillLeafPath): { value: string[]; repeat: string[]; bool: string[] } {
  const flags = FLAGS[sub]
  return {
    value: flags.filter((f) => f.kind === 'value').map((f) => f.name),
    repeat: flags.filter((f) => f.kind === 'repeatable').map((f) => f.name),
    // `--pretty` 同时出现在 `GLOBAL_FLAGS`（因而是 bool）与 `REJECTED_FLAGS` 里：
    // 解析器仍把它当已知 token 收下（它的裁决是「已知但未实现」，不是「未知参数」），
    // 与 spec 的建模一致（spec 里也是先 rejected 后 flags）。
    bool: flags.filter((f) => f.kind === 'bool').map((f) => f.name),
  }
}
