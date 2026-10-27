// tests/sync-enums.test.ts
//
// 「sync 输出里的枚举值必须有图例」的可执行判据（2026-10-27）。
//
// `gaps[].reason`（8 值）与 `drift[].kind`（4 值）都是 Agent 要按值分支的机器值，
// 但此前全仓没有一处给出值表：README 只列字段名，skill 只让 Agent「看缺口」，
// 任务层还有 4 个业务 reason 连类型都没进（`gapHint.reason: string` + `as` 强转）。
// 本文件把**源码枚举**与 **README 图例**双向锁住：
//   · 源码加了值但 README 没写 → 红（图例必须同步）；
//   · README 写了源码里不存在的值 → 红（图例不能虚报）。
// 与 `tests/plaintext-channels.test.ts` 同一思路：能静态判定的规则不靠人肉枚举。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ENGINE_GAP_REASONS } from '../src/sync/engine.js'
import { TASK_GAP_REASONS } from '../src/sync/types.js'
import { DRIFT_KINDS } from '../src/commands/sync.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const GAP_REASONS: string[] = [...ENGINE_GAP_REASONS, ...TASK_GAP_REASONS]

/** README 的 gaps 图例段：从图例标题到 drift 图例标题之间。 */
function gapLegendSection(): string {
  const s = read('README.md')
  const start = s.indexOf('**`gaps[].reason` 的全部取值**')
  const end = s.indexOf('**`drift[].kind` 的全部取值**')
  expect(start, 'README 缺 gaps 图例段').toBeGreaterThan(-1)
  expect(end, 'README 缺 drift 图例段（gaps 段的右边界）').toBeGreaterThan(start)
  return s.slice(start, end)
}

/** README 的 drift 图例段：标题起的一个自然段。 */
function driftLegendSection(): string {
  const s = read('README.md')
  const start = s.indexOf('**`drift[].kind` 的全部取值**')
  expect(start, 'README 缺 drift 图例段').toBeGreaterThan(-1)
  const end = s.indexOf('\n\n', start)
  return s.slice(start, end === -1 ? undefined : end)
}

describe('sync 枚举 ↔ README 图例（双向）', () => {
  it('源码枚举非空且无重复（防止判据在空集合上恒真）', () => {
    expect(GAP_REASONS.length).toBeGreaterThan(0)
    expect(new Set(GAP_REASONS).size).toBe(GAP_REASONS.length)
    expect(DRIFT_KINDS.length).toBeGreaterThan(0)
    expect(new Set(DRIFT_KINDS).size).toBe(DRIFT_KINDS.length)
  })

  it.each(GAP_REASONS)('gap reason「%s」在 README 图例里有释义', (reason) => {
    // 图例表每行形如 `| \`reason\` | 含义 | 动作 |` —— 必须在**图例段内**出现，
    // 全文匹配会让「reason 恰好出现在别处」蒙混过关。
    expect(gapLegendSection()).toContain(`\`${reason}\``)
  })

  it('图例里没有源码不存在的 gap reason（删值必须同步删图例）', () => {
    const rows = [...gapLegendSection().matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1])
    expect(rows.sort()).toEqual([...GAP_REASONS].sort())
  })

  it.each(DRIFT_KINDS)('drift kind「%s」在 README 图例里有释义', (kind) => {
    expect(driftLegendSection()).toContain(`\`${kind}\``)
  })

  it('drift 图例段里没有源码不存在的 kind', () => {
    const mentioned = [...driftLegendSection().matchAll(/`([a-z_]+)`/g)].map((m) => m[1])
    // 段内的反引号值只应是 kind 名（该段是纯枚举释义，没有其它代码标识符）
    for (const k of mentioned) expect(DRIFT_KINDS as readonly string[], k).toContain(k)
  })

  it('skill 协议给出缺口的分支动作（Agent 的主入口，不能只有字段名）', () => {
    const p = read('src/skill/qiyu/protocols.md')
    expect(p, '协议必须点名字段').toContain('`gaps[].reason`')
    expect(p, '最需要等待动作的 reason 必须点名').toContain('rate_limit_local')
    expect(p, '「提示 ≠ 失败」的语义必须写明').toMatch(/成功窗上的提示/)
  })

  it('skill 协议不得把 sync verify 说成两类任务都与远端核对（CodeRabbit 2026-10-27）', () => {
    // windowed 任务不做上游全量重拉，verify 只看本地行数与 sync_state —— 协议若笼统写
    // 「核对本地与远端的一致性」，Agent 会用「drift 为空」错误排除「本地数据未反映远端
    // 变化」这一 0 行成因。与 README「expected_from_api 只对快照任务有意义」同一事实。
    const p = read('src/skill/qiyu/protocols.md')
    expect(p).toContain('只有快照任务')
    expect(p).toMatch(/drift 为空不代表与远端一致/)
  })
})
