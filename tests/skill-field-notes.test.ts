// tests/skill-field-notes.test.ts
//
// `skill where` / `skill install` 输出里的状态枚举必须有释义（2026-10-27）。
//
// 这些值是 Agent 按值分支的机器值，此前 README 只给了链接四态的**名字**，
// `entity.state` 的 `not_a_directory`、install 的 `action`/`status`/`links[].action`
// 连名字都没出现。`foreign` 尤其危险：它意味着「路径上是别人的东西」，
// 被猜成「坏了该修」就会误删用户的文件。
//
// 释义有两处载体，都要与源码枚举一致：
//   · 输出的 `meta.field_notes`（**Agent 真正读得到的地方** —— 安装后的 skill 目录只有
//     六篇正文，没有 README；只写 README 等于 Agent 拿不到）；
//   · README 的人读版图例（人类与读文档的 Agent）。
// 三方核对：枚举 ⊆ field_notes、枚举 ⊆ README、README 图例不出现源码产不出的值。
// 反向不查 field_notes：它是代码里渲染出来的（`renderStateNotes`），
// 键集合由 `satisfies Record<枚举, string>` 在编译期钉死，不会出现幽灵键。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { LINK_STATES } from '../src/skill/paths.js'
import { INSTALL_STATUSES } from '../src/skill/install.js'
import {
  ENTITY_STATES, LINK_REPORT_STATES, LINK_PLAN_ACTIONS, INSTALL_ACTIONS, SKILL_STATE_NOTES,
  whereFieldNotes, installFieldNotes,
} from '../src/commands/skill.js'

const readme = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')

/** README 的 skill 状态图例段。 */
function legendSection(): string {
  const start = readme.indexOf('**`skill` 输出的状态取值**')
  expect(start, 'README 缺 skill 状态图例段').toBeGreaterThan(-1)
  const end = readme.indexOf('\n\n', readme.indexOf('links[].action', start))
  return readme.slice(start, end === -1 ? undefined : end)
}

// ⚠️ 图例文本必须取**生产渲染路径**（`whereFieldNotes()` / `installFieldNotes()`），
// 不能在测试里自己再写一份 render —— 自写的那份与生产分叉时，生产漏掉一个值测试照样绿
// （实测过：在 renderStateNotes 里 filter 掉 foreign，自写 render 的版本 44 条全绿）。
const WHERE_NOTES = whereFieldNotes()
const DRY_NOTES = installFieldNotes('dry-run')
const REAL_NOTES = installFieldNotes('real')

/** 枚举 ↔ 对应图例文本的对照表（field_notes 的键名与生产输出一致）。 */
const TABLES: Array<[string, readonly string[], string]> = [
  ['entity.state', ENTITY_STATES, WHERE_NOTES['entity.state']],
  ['links[].state（where）', LINK_REPORT_STATES, WHERE_NOTES['links[].state']],
  ['links[].state（install）', LINK_REPORT_STATES, DRY_NOTES['links[].state']],
  ['install 的 action', INSTALL_ACTIONS, DRY_NOTES.action],
  ['install 的 planned_status', INSTALL_STATUSES, DRY_NOTES.planned_status],
  ['install 的 status', INSTALL_STATUSES, REAL_NOTES.status],
  ['links[].action', LINK_PLAN_ACTIONS, DRY_NOTES['links[].action']],
]

describe('skill 状态枚举 ↔ field_notes ↔ README（三方）', () => {
  it('五组枚举都非空且无重复（判据不在空集合上恒真）', () => {
    for (const [name, values] of TABLES) {
      expect(values.length, name).toBeGreaterThan(0)
      expect(new Set(values).size, name).toBe(values.length)
    }
  })

  it.each(TABLES.flatMap(([name, values, notes]) =>
    values.map((v) => [`${name} 的「${v}」`, v, notes] as const)))
  ('%s 在 field_notes 图例里有释义', (_label, value, notes) => {
    expect(notes).toContain(`${value} = `)
  })

  it.each(TABLES.flatMap(([name, values]) =>
    values.map((v) => [`${name} 的「${v}」`, v] as const)))
  ('%s 在 README 图例里有释义', (_label, value) => {
    expect(legendSection()).toContain(`\`${value}\``)
  })

  it('field_notes 不带 Markdown 加粗（stdout JSON 给 Agent，`**` 是噪声；与 api list 同款）', () => {
    for (const [, , notes] of TABLES) expect(notes).not.toContain('**')
    for (const v of Object.values(WHERE_NOTES)) expect(v).not.toContain('**')
    for (const v of Object.values(DRY_NOTES)) expect(v).not.toContain('**')
    for (const v of Object.values(REAL_NOTES)) expect(v).not.toContain('**')
  })

  it('图例只解释该输出里真实存在的字段（dry-run 无 status、真实安装无 action）', () => {
    // 反向形态：解释一个不存在的键，等于让 Agent 去找一个永远读不到的字段。
    // 真实安装的 `links[]` 条目只有 `state` 与可选 `error`（`InstallResult['links']` 的类型
    // 如此），所以 `links[].action` 的释义也不该出现在它的 field_notes 里。
    expect(Object.keys(DRY_NOTES)).not.toContain('status')
    expect(Object.keys(REAL_NOTES)).not.toContain('action')
    expect(Object.keys(REAL_NOTES)).not.toContain('planned_status')
    expect(Object.keys(REAL_NOTES)).not.toContain('links[].action')
    expect(Object.keys(DRY_NOTES)).toContain('links[].action')
  })

  it('「零写入」的措辞限定在实体正文（链接在 skipped 时仍会建立）', () => {
    // 实测：删掉链接后重装 → status=skipped 且 links[].state 回到 ok。
    // 不限定范围的「零写入」会让 Agent 以为链接也没动，从而不去看 links[]。
    const notes = [DRY_NOTES.action, DRY_NOTES.planned_status, REAL_NOTES.status,
      WHERE_NOTES['entity.source']].join('\n')
    expect(notes).toMatch(/零写入[^；\n]*实体/)
    expect(notes).toMatch(/链接仍会照常/)
  })

  it('missing 的图例点明 install 只在该 Agent 的 skills 目录已存在时建链（CodeRabbit 2026-10-27）', () => {
    // 实测：~/.claude/skills 不存在时 install 的 links 是空数组（不是 missing 条目），
    // 且 meta.warnings 说明「未发现任何 Agent skills 目录」。只说「install 会创建」
    // 会让 Agent 以为装完就修好了那个 missing。
    const notes = WHERE_NOTES['links[].state']
    expect(notes).toMatch(/missing = [^；]*目录已存在时创建链接/)
    expect(notes).toMatch(/missing = [^；]*从不创建目录/)
    expect(legendSection()).toMatch(/`missing`[^\n]*目录已存在时/)
    expect(legendSection()).toMatch(/`missing`[^\n]*从不创建/)
  })

  it('links[].state 的图例点明 foreign 不是「坏了」、unknown 不是「不存在」', () => {
    const sec = legendSection()
    expect(sec).toMatch(/`foreign`[^\n]*别人的东西/)
    expect(sec).toMatch(/`foreign`[^\n]*不要删/)
    expect(sec).toMatch(/`unknown`[^\n]*不是「不存在」/)
    expect(sec).toMatch(/`not_a_directory`[^\n]*(不是目录)/)
    // field_notes 侧同样要求：Agent 读的是它
    const notes = WHERE_NOTES['links[].state']
    expect(notes).toMatch(/foreign = [^；]*别人的东西/)
    expect(notes).toMatch(/foreign = [^；]*不要删/)
  })

  it('README 图例不引用源码不存在的 state/action/status 值（含「两边同时删」的方向）', () => {
    // 图例段里所有反引号包裹的**裸小写标识符**（不含 `data.xxx` 这类路径、不含 flag）
    // 都必须是某组枚举的成员 —— 幽灵值与「删了枚举忘了删图例」都会红。
    const known = new Set<string>(TABLES.flatMap(([, v]) => v))
    // 图例里合法出现、但不是枚举值的词（字段名与 JSON 字面量）。新增时想清楚：
    // 这里每加一个词，反向判据就少一分把关。
    const NON_VALUE_TOKENS = new Set([
      'skill',    // 命令名，出现在「skill 输出的状态取值」这类标题式短语里
      'error',    // 字段名：unknown 状态带 `error` 说明
      'exists',   // 字段名：`exists` 为 null 表示无法判定
      'null',     // JSON 字面量
      'state',    // 字段名：真实安装的 links[] 只有 state 与可选 error
      'links',    // 字段名：目录不存在时 install 的 links 里没有该 Agent 的条目
    ])
    const tokens = [...legendSection().matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
    expect(tokens.length, '图例段应至少含若干枚举值（否则判据空转）').toBeGreaterThan(10)
    const ghosts = tokens.filter((t) => !known.has(t) && !NON_VALUE_TOKENS.has(t))
    expect(ghosts, `README 图例里有源码产不出的值：${ghosts.join('、')}`).toEqual([])
  })
})
