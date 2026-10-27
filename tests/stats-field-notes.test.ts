// tests/stats-field-notes.test.ts —— `stats fields` 的 `declared` 值域必须有出处（2026-10-27）。
//
// 背景：`stats fields` 是**唯一**一个「整条命令的存在意义就是把数字讲给 Agent 听」的读命令
// ——设计稿 §9.2 的原话是「单位不确定 → 查 `stats fields` 的 `unit`；**绝不要猜百分比还是
// 绝对值**」。可它此前是全仓唯一**没有任何 `meta.field_notes`** 的读命令（api/auth/skill
// 都有），`declared.unit` 的四个取值在 README 与 skill 正文里**一个释义都没有**。
// 于是 Agent 被告知「别猜单位」，拿到 `unit: "ratio"` 之后还是得猜 0–1 还是 0–100。
//
// 第二处：`declared.higher_is_better` **恒为 null**（`src/` 里零个非 null 生产者），
// 而设计稿 §8 把「higher_is_better」当作本命令的卖点之一列出来 —— 一个永远拿不到值的
// 字段（第 2 种形态：声明了但没人读）。它不能删（设计稿 §9.2 定义了四个键恒在），
// 就必须在输出里说清「恒为 null 且为什么」，否则 Agent 会一直等它变成 true/false。
//
// 断言取**生产渲染路径**（`statsFieldNotes()`），不写测试内的副本 —— 上一轮
// `tests/skill-field-notes.test.ts` 的教训：自写副本让生产漏渲染整个值都全绿。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { statsFieldNotes, UNIT_NOTES, SOURCE_NOTES } from '../src/commands/stats.js'
import { METRIC_UNITS, METRIC_SOURCES, METRIC_CATALOG, declareMetric } from '../src/query/metric-catalog.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NOTES = statsFieldNotes()

/** README 的 `declared` 图例段（从「`declared` 的取值」到下一个 `##`）。 */
function readmeLegend(): string {
  const md = readFileSync(join(ROOT, 'README.md'), 'utf8')
  const start = md.indexOf('**`declared` 的取值**')
  expect(start, 'README 找不到 `declared` 图例段').toBeGreaterThanOrEqual(0)
  const end = md.indexOf('\n## ', start)
  return md.slice(start, end === -1 ? undefined : end)
}

/** 把 `a = 释义；b = 释义` 拆回取值集合（与生产渲染同一个分隔约定）。 */
function renderedKeys(cell: string): string[] {
  return cell.split('；').map((seg) => seg.split(' = ')[0]!.trim())
}

describe('stats fields 的 declared 值域 ↔ field_notes ↔ README（三方双向）', () => {
  it('值域本身非空且无重复（判据不在空集合上恒真）', () => {
    for (const [name, arr] of [['METRIC_UNITS', METRIC_UNITS], ['METRIC_SOURCES', METRIC_SOURCES]] as const) {
      expect(arr.length, name).toBeGreaterThan(0)
      expect(new Set(arr).size, name).toBe(arr.length)
    }
  })

  it('每条声明都有 unit/source 的释义（satisfies 的运行时侧）', () => {
    // 类型层由 `satisfies Record<MetricUnit, string>` 挡住漏写；这里钉住值域数组与
    // 释义表不脱节 —— 有人把值加进 METRIC_UNITS 却忘了 NOTE 时，编译会红；反过来
    // 把 NOTE 的键删掉、数组没动，只有这条会红。
    expect(Object.keys(UNIT_NOTES).sort()).toEqual([...METRIC_UNITS].sort())
    expect(Object.keys(SOURCE_NOTES).sort()).toEqual([...METRIC_SOURCES].sort())
  })

  it.each(METRIC_UNITS)('unit「%s」在图例里有释义（枚举 ⊆ 图例）', (v) => {
    expect(NOTES['declared.<字段>.unit']).toContain(`${v} = `)
  })

  it.each(METRIC_SOURCES)('source「%s」在图例里有释义（枚举 ⊆ 图例）', (v) => {
    expect(NOTES['declared.<字段>.source']).toContain(`${v} = `)
  })

  it('图例里没有枚举之外的值（图例 ⊆ 枚举）', () => {
    // 反向：加值不写文档会红（上面两条），删值忘删文档同样要红（这条）。
    expect(renderedKeys(NOTES['declared.<字段>.unit']!).sort()).toEqual([...METRIC_UNITS].sort())
    expect(renderedKeys(NOTES['declared.<字段>.source']!).sort()).toEqual([...METRIC_SOURCES].sort())
  })

  it('README 的图例段也覆盖全部取值（人读版与输出同一组值）', () => {
    const legend = readmeLegend()
    for (const v of METRIC_UNITS) expect(legend, `README 缺 unit ${v}`).toContain(`\`${v}\``)
    for (const v of METRIC_SOURCES) expect(legend, `README 缺 source ${v}`).toContain(`\`${v}\``)
    expect(legend).toContain('higher_is_better')
    expect(legend).toContain('恒为 `null`')
  })

  it('unit 的每个取值都说明了「Agent 拿到它该怎么做」，不只是同义反复', () => {
    // 「ratio = 比率」等于没解释 —— 危险恰恰是量纲（0–1 还是 0–100）。逐值点名动作。
    expect(UNIT_NOTES.ratio).toContain('0–1')
    expect(UNIT_NOTES.ratio).toContain('不是 0–100 的百分数')
    expect(UNIT_NOTES.ratio, '必须点明哪些是实测、哪些是推断').toContain('命名推断')
    expect(UNIT_NOTES.unknown).toContain('不是「没有单位」')
    expect(UNIT_NOTES.unknown).toContain('unknown_fields')
    expect(UNIT_NOTES.ms).toContain('毫秒')
    expect(SOURCE_NOTES['name-suffix']).toContain('不是实测')
  })

  it('higher_is_better 在输出里被明确写成「恒为 null」，且源码里确实没有非 null 生产者', () => {
    // 图例说「恒为 null」是一句**可证伪的承诺**：这条把它与代码事实绑在一起。
    // 若未来真有了实测依据、某条声明填了 true/false，这条会红 —— 那时必须同步改图例，
    // 而不是让「恒为 null」留在输出里骗 Agent。
    expect(NOTES['declared.<字段>.higher_is_better']).toContain('恒为 null')
    expect(NOTES['declared.<字段>.higher_is_better']).toContain('false')
    for (const [table, decls] of Object.entries(METRIC_CATALOG)) {
      for (const [field, d] of Object.entries(decls)) {
        expect(d.higher_is_better, `${table}.${field}`).toBeNull()
      }
    }
    // 后缀派生路径同样恒 null（覆盖到目录未收录的字段）
    for (const f of ['anyRatio', 'anyCount', 'anyDuration', 'carrier']) {
      expect(declareMetric('daily_overview', f).higher_is_better, f).toBeNull()
    }
  })

  it('图例键的路径形态与实际输出一致：declared 是对象、observed 是数组（CodeRabbit）', () => {
    // 反向形态的一种：路径写错 = 指一个 Agent 永远读不到的字段。最初我把 declared 的
    // 四个键写成 `declared[].unit`，而 `declared` 是 `Object.fromEntries(...)` 出来的
    // **按字段名分组的对象** —— `declared[]` 这个路径根本不存在。
    const declaredKeys = Object.keys(NOTES).filter((k) => k.startsWith('declared'))
    expect(declaredKeys.length).toBe(4)
    for (const k of declaredKeys) expect(k, k).toMatch(/^declared\.<字段>\.[a-z_]+$/)
    const observedKeys = Object.keys(NOTES).filter((k) => k.startsWith('observed'))
    expect(observedKeys.length).toBeGreaterThan(0)
    for (const k of observedKeys) expect(k, k).toMatch(/^observed\[\]\.[a-z_]+$/)
  })

  it('field_notes 不带 Markdown 加粗（stdout JSON 给 Agent，`**` 是噪声）', () => {
    for (const [k, v] of Object.entries(NOTES)) expect(v, k).not.toContain('**')
  })

  it('只解释该输出里真实存在的字段（反向：解释一个不存在的键 = 让 Agent 去找读不到的字段）', () => {
    // declared/observed 的键集是**类型**定的（DeclOut / Observed 各四个与六个键），
    // 这里把它们抄成字面量：改类型删键时这条会红，逼着图例一起改。
    const DECLARED_KEYS = ['unit', 'higher_is_better', 'source', 'note']
    // `field` 不在表里：它就是这个对象自己的键名，无需释义
    const OBSERVED_KEYS = ['rows_present', 'minus_one', 'nulls', 'min', 'max']
    const TOP_KEYS = ['unknown_fields']
    for (const k of Object.keys(NOTES)) {
      if (k.startsWith('declared.')) {
        // ⚠️ `declared` 是**按字段名分组的对象**（`Object.fromEntries`），不是数组 ——
        // 路径必须写 `declared.<字段>.unit`。写成 `declared[].unit` 就是**指一个不存在的
        // 路径**（CodeRabbit 2026-10-27 抓到，我最初正是这么写的）：Agent 照着找会一无所获。
        const rest = k.slice('declared.<字段>.'.length)
        expect(k, `图例键 ${k} 的路径形态不对：declared 是对象不是数组`).toMatch(/^declared\.<字段>\./)
        expect(DECLARED_KEYS, `图例键 ${k} 不在 DeclOut 里`).toContain(rest)
      } else if (k.startsWith('observed[]')) {
        expect(OBSERVED_KEYS, `图例键 ${k} 不在 Observed 里`).toContain(k.slice('observed[].'.length))
      } else {
        expect(TOP_KEYS, `图例键 ${k} 不在 stats fields 的输出里`).toContain(k)
      }
    }
    // 每个 observed 键都必须有释义（这些数值的坑最多：min/max 排除 -1、全哨兵为 null）
    for (const k of OBSERVED_KEYS) expect(Object.keys(NOTES)).toContain(`observed[].${k}`)
  })
})
