// tests/query/metric-catalog.test.ts —— E-T10：指标目录与后缀派生（spec §9.2）。
//
// 目录是「有出处的声明」的唯一落点：每条必须带 source（design-doc = 设计稿实测明说，
// name-suffix = 按字段名后缀推断，是命名推断不是实测）；higher_is_better 没有上游
// 来源，一律 null（不猜）。
import { describe, it, expect } from 'vitest'
import { METRIC_CATALOG, REPORT_TABLES, declareMetric } from '../../src/query/metric-catalog.js'
import { tableByName } from '../../src/store/schema.js'

const SOURCES = new Set(['design-doc', 'name-suffix'])
const UNITS = new Set(['ratio', 'count', 'ms', 'unknown'])

describe('metric-catalog', () => {
  it('catalog 每条声明都带 source（design-doc / name-suffix），higher_is_better 恒 null', () => {
    const tables = Object.entries(METRIC_CATALOG)
    expect(tables.length).toBeGreaterThan(0)
    for (const [table, decls] of tables) {
      for (const [field, d] of Object.entries(decls)) {
        const at = `${table}.${field}`
        expect(SOURCES.has(d.source), at).toBe(true)
        expect(d.higher_is_better, at).toBeNull()
        expect(UNITS.has(d.unit), at).toBe(true)
      }
    }
  })

  it('初始声明宁缺毋滥：assignedRatio 有设计稿出处（含 -1=无数据），sessions 按命名推断', () => {
    // ⚠️ 出处是设计稿 §6.2（表设计）：实测 0.987 与 -1 哨兵的 A/B 证据都在该节，
    // §6.3 是「类型与序列化」。声明里的 note 是给 Agent 的出处，必须指对节。
    expect(METRIC_CATALOG.daily_overview.assignedRatio).toEqual({
      unit: 'ratio', higher_is_better: null, source: 'design-doc',
      note: '设计稿 §6.2 实测 0.987；-1 = 无数据',
    })
    expect(METRIC_CATALOG.daily_overview.sessions).toEqual({
      unit: 'count', higher_is_better: null, source: 'name-suffix',
    })
  })

  it('报表域表恰 9 张（spec §9.1），且都在 TABLES 里、都有 payload 列', () => {
    expect(REPORT_TABLES).toEqual([
      'daily_overview', 'staff_workload', 'staff_quality', 'staff_satisfaction',
      'staff_attendance', 'order_performance', 'staff_salary_detail',
      'robot_summary', 'transfer_human',
    ])
    // 闭集里的每个名字都必须真实存在于 schema 且带 payload（观测 SQL 的前提）
    for (const name of REPORT_TABLES) {
      const t = tableByName(name)
      expect(t, name).toBeDefined()
      expect(t!.columns.map((c) => c.name), name).toContain('payload')
    }
  })

  it('后缀派生：Ratio/Radio→ratio、Count/sessions→count、Duration/Time→ms、其余 unknown', () => {
    const cases: Array<[string, string]> = [
      ['sessionInviteRatio', 'ratio'],
      ['callOutDiffCalleeAnswerRatio', 'ratio'],
      ['repliedRadio', 'ratio'],
      ['replyCount', 'count'],
      ['sessions', 'count'],
      ['avgRobotHostingDuration', 'ms'],
      ['averageWaitingTime', 'ms'],
      ['carrier', 'unknown'],
      ['nameSpell', 'unknown'],
    ]
    for (const [field, unit] of cases) {
      const d = declareMetric('daily_overview', field)
      expect(d.unit, field).toBe(unit)
      // 派生条目恒为命名推断，且不猜方向
      expect(d.source, field).toBe('name-suffix')
      expect(d.higher_is_better, field).toBeNull()
    }
  })

  it('目录声明优先于后缀派生（source 保留 design-doc）', () => {
    const d = declareMetric('daily_overview', 'assignedRatio')
    expect(d.source).toBe('design-doc')
    // 目录里没有的表/字段一律走派生，不编造出处
    expect(declareMetric('robot_summary', 'transferCount')).toEqual({
      unit: 'count', higher_is_better: null, source: 'name-suffix',
    })
  })
})
