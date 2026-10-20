// src/skill/check.ts —— `skill check` 的校验逻辑：把 skill 正文里的引用与 CLI 的真实契约
// （命令树 / 表名 / 错误 kind）比对，产出三档判定（设计稿 D3）：
//
//   · violations：引用不存在的命令 / flag / kind；正文出现表名；出现完整 SQL 序列；
//     推荐了被显式拒绝的 flag（`--pretty`）。
//   · warnings：无法静态判定的引用（含管道 / 省略号等），不阻塞，但要指认位置。
//   · 两者皆空：通过。
//
// 分工边界：`refs.ts` 只负责**提取**（哪些文本算引用），本文件只负责**判定**。表名扫描
// 复用 `collectSegments` 而不是重写一遍围栏解析 —— 两处扫描面一旦各写一遍必然漂移。
//
// 契约事实由调用方通过 `CheckContext` 注入（`COMMAND_TREE` / `TABLES` / `ERROR_KINDS`），
// 本文件不 import `cli.ts`（会拉进整个 CLI 入口图，层级倒置），只从 commands 层取
// `findSpec` / `CommandSpec`。分层方向：`skill/` 可以 import `commands/`、`store/`、
// `core/`，反向禁止。
//
// ⚠️ 校验器**不理解否定语境**：`` `tags` `` 出现在「不是 tags 表」这种句子里同样命中
// `table_name`。skill 正文任何位置都不能写表名，包括用来举例说明「不要写表名」的地方。

import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { findSpec, type CommandSpec } from '../commands/spec-types.js'
import { collectSegments, extractRefs } from './refs.js'

/** 违规规则名。前三个是命令契约，后三个是内容红线（设计稿 §11.1）。 */
export type ViolationRule =
  | 'unknown_command'
  | 'unknown_flag'
  | 'rejected_flag'
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
}

/** 转义正则元字符：表名来自 `CheckContext` 注入，按字面匹配而不是正则模式。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 校验一份 skill 文档正文。
 *
 * 判定顺序（violations 最终按行稳定排序，便于按出现位置阅读）：
 *   1. 命令路径：`findSpec` 最长前缀匹配，未命中 → `unknown_command`；
 *   2. flag：**先查 `spec.rejected`**，再查 `spec.flags` 的完整接受集。顺序是硬要求 ——
 *      `--pretty` 同时在 `GLOBAL_FLAGS`（因而在每条 spec 的 `flags` 里）与 `REJECTED_FLAGS`
 *      里，反过来先查 `flags` 会把它判成合法，`rejected_flag` 永远报不出来；
 *   3. 表名：只在 `collectSegments` 的代码面片段里扫（与 refs 扫描面一致），词边界、
 *      大小写敏感；
 *   4. SQL 序列：`extractRefs` 已按行 / 围栏块识别；
 *   5. `kind: x`：对 `ERROR_KINDS` 比对；
 *   6. 无法静态判定的命令（含选择 / 省略符号）进 warnings，不进 violations。
 */
export function checkSkillDoc(text: string, ctx: CheckContext): CheckResult {
  const violations: Violation[] = []
  const warnings: { line: number; detail: string }[] = []
  const refs = extractRefs(text)

  // 1 + 2：命令路径与 flag。`extractRefs` 给出的 path 已剔除 flag 与取值，
  // 可直接喂给 `findSpec`（它按原始 argv 风格 token 逐位比较）。
  for (const cmd of refs.commands) {
    const spec = findSpec(ctx.tree, cmd.path)
    if (!spec) {
      violations.push({
        line: cmd.line,
        rule: 'unknown_command',
        detail: `未知命令：qiyu ${cmd.path.join(' ')}（命令树里没有这条路径）`,
      })
      continue
    }
    const accepted = new Set(spec.flags.map((f) => f.name))
    for (const flag of cmd.flags) {
      if (spec.rejected.includes(flag)) {
        // ⚠️ 必须先于 accepted 判断：--pretty 同时属于两者（见函数注释）。
        violations.push({
          line: cmd.line,
          rule: 'rejected_flag',
          detail: `qiyu ${spec.path.join(' ')} 的 ${flag} 已知但未实现，别用`,
        })
      } else if (!accepted.has(flag)) {
        violations.push({
          line: cmd.line,
          rule: 'unknown_flag',
          detail: `qiyu ${spec.path.join(' ')} 不接受此 flag：${flag}`,
        })
      }
    }
  }

  // 3：表名。代码面片段由 refs.ts 统一收集（行内代码 + 围栏内容行），这里只做词边界匹配。
  // `(?<![\w-])` / `(?![\w-])`：`tag` 不命中 `tags`、`staff` 不命中 `staff_groups`；
  // 大小写敏感（不加 `i`），避免把 `Staff` 之类的英文单词误判成表名。
  // 表名先过 escapeRegExp：当前 TABLES 全是 `[a-z_]+` 所以不转义也安全，但 `tableNames`
  // 是调用方注入的，契约上不能假定它永远只含标识符字符。
  const matchers = ctx.tableNames.map((name) => ({
    name,
    re: new RegExp(`(?<![\\w-])${escapeRegExp(name)}(?![\\w-])`),
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

  // 4：SQL 关键字序列（`extractRefs` 已处理 SELECT/FROM 独立词、跨行块级判定）。
  // detail 里把换行压成空格，避免多行块级序列把报告撑散。
  for (const sql of refs.sqlSequences) {
    violations.push({
      line: sql.line,
      rule: 'sql_sequence',
      detail: `出现完整 SQL 关键字序列：${sql.text.replace(/\s+/g, ' ')}`,
    })
  }

  // 5：错误 kind。
  for (const kind of refs.kinds) {
    if (!ctx.errorKinds.includes(kind.name)) {
      violations.push({
        line: kind.line,
        rule: 'unknown_kind',
        detail: `未知错误 kind：${kind.name}（ERROR_KINDS 里没有这个成员）`,
      })
    }
  }

  // 6：无法静态判定 → warning（设计稿 D3：退出码 0，不阻塞）。
  for (const item of refs.unverifiable) {
    warnings.push({ line: item.line, detail: `无法静态判定（${item.reason}）：${item.text}` })
  }

  // 五类规则各自按出现顺序产出，合并后按行稳定排序（V8 的 sort 是稳定排序），
  // 同一行的多条保持「命令 → 表名 → SQL → kind」的规则顺序。
  violations.sort((a, b) => a.line - b.line)
  return { violations, warnings }
}

/**
 * 校验一个 skill 文档目录：读 `dir` 下所有 `.md`（按文件名排序，不递归），逐个
 * `checkSkillDoc` 并汇总。
 *
 * 汇总时把「文件:行」前缀写进 detail（如 `SKILL.md:3 …`）—— `Violation` 没有文件名字段，
 * 多文件汇总时只靠行号无法定位；`line` 仍保留原行号供程序化消费。
 *
 * ⚠️ 抛错边界（本函数不吞错，由调用方守卫，`qiyu skill check` 要接）：
 *   · `dir` 不存在 → `readdirSync` 抛 `ENOENT`；
 *   · `dir` 下有名为 `*.md` 的子目录 → `readFileSync` 读目录抛 `EISDIR`；
 *   · 某个文件读不出来（权限等）→ `readFileSync` 的原始错误。
 */
export function checkSkillDir(dir: string, ctx: CheckContext): CheckResult {
  const violations: Violation[] = []
  const warnings: { line: number; detail: string }[] = []
  const files = readdirSync(dir).filter((f) => f.endsWith('.md')).sort()

  for (const file of files) {
    const result = checkSkillDoc(readFileSync(join(dir, file), 'utf8'), ctx)
    for (const v of result.violations) {
      violations.push({ ...v, detail: `${file}:${v.line} ${v.detail}` })
    }
    for (const w of result.warnings) {
      warnings.push({ ...w, detail: `${file}:${w.line} ${w.detail}` })
    }
  }

  return { violations, warnings }
}
