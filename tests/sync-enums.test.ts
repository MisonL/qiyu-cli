// tests/sync-enums.test.ts
//
// 「sync 输出里的枚举值必须有图例」的可执行判据（2026-10-27）。
//
// `gaps[].reason` 与 `drift[].kind` 都是 Agent 要按值分支的机器值。**这里不写死个数**：
// 2026-11-02 加了一个任务层 reason 后，「8 值」「四个业务提示」这类计数断言全部失真——
// 值域以 `ENGINE_GAP_REASONS` / `TASK_GAP_REASONS` / `DRIFT_KINDS` 为准。
// 此前全仓没有一处给出值表：README 只列字段名，skill 只让 Agent「看缺口」，
// 任务层的业务 reason 连类型都没进（`gapHint.reason: string` + `as` 强转）。
// 本文件把**源码枚举**与 **README 图例**双向锁住：
//   · 源码加了值但 README 没写 → 红（图例必须同步）；
//   · README 写了源码里不存在的值 → 红（图例不能虚报）。
// 与 `tests/plaintext-channels.test.ts` 同一思路：能静态判定的规则不靠人肉枚举。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
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

  // 2026-11-01 审查：「提示类四值」此前在 run 图例里写「后四个 reason」——位置指代
  // 依赖 README 图例表的**排列顺序**，而顺序没有任何守卫（上面的双向核对用 sort()，
  // 重排表格照样绿）；Agent 读 run 输出时手里也未必有那张表，「后四个」无法解析。
  // 现在逐名渲染，这条钉住「四个名字都在」且「位置指代不复活」。
  it('run 图例的 gaps 单元格逐名点名每个业务提示 reason（不用位置指代「后四个」）', async () => {
    const { runFieldNotes } = await import('../src/commands/sync-notes.js')
    const cell = runFieldNotes()['tasks[].gaps']!
    for (const r of TASK_GAP_REASONS) {
      expect(cell, `run 图例必须逐名点名 ${r}（Agent 手里没有 README 表）`).toContain(r)
    }
    expect(cell, '位置指代「后四个」依赖没有守卫的表格顺序，不得复活').not.toMatch(/后四个|前四个/)
    // 变异自检：合成一个位置指代形态，上面的正则必须命中（防正则退化恒绿）
    expect('gaps 非空不等于同步失败：后四个 reason 是成功窗上的业务提示').toMatch(/后四个|前四个/)
  })

  // 2026-11-02 审查：`dim.ts` 写入了 `staff_id_list_malformed`，而 `TASK_GAP_REASONS` 当时只声明
  // 四个 —— 运行时产出了枚举外的值，Agent 拿去查 README 图例查不到任何释义。
  // 为什么类型没抓住：`...(gapHint ? { gapHint } : {})` 里 `gapHint` 是局部推断的对象
  // （`reason: string`），扩展表达式让整个返回值的 contextual type 消失，tsc 不再校验该字面量
  // 与 `TaskGapReason` 的关系（实测：把该 reason 改成 `12345`，`npm run typecheck` 仍 0 error；
  // 同一文件里改成 `rows: 123` 立刻报错）。所以枚举完整性只能靠静态扫描源码字面量来钉。
  it('任务层源码里的每个 gapHint.reason 字面量都在枚举里', () => {
    const dir = fileURLToPath(new URL('../src/sync/tasks/', import.meta.url))
    const hits: Array<{ file: string; reason: string }> = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue
      const src = readFileSync(`${dir}${f}`, 'utf8')
      for (const m of src.matchAll(/reason:\s*'([a-z_]+)'/g)) hits.push({ file: f, reason: m[1] })
    }
    // 判据不能在空集合上恒真：dim / knowledge / reports / sessions 各至少一处
    expect(hits.length, '没扫到任何 reason 字面量 —— 扫描判据退化了').toBeGreaterThanOrEqual(4)
    const known = new Set(GAP_REASONS)
    for (const h of hits) {
      expect(known.has(h.reason), `${h.file} 产出了枚举外的 reason「${h.reason}」：`
        + '先加进 TASK_GAP_REASONS 并补 README 图例与 skill 文案').toBe(true)
    }
    // 变异自检：枚举外的形态必须被判据拒掉（防退化恒绿）
    expect(known.has('zzz_not_a_reason')).toBe(false)
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
