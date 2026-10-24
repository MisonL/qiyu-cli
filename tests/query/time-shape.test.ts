// tests/query/time-shape.test.ts —— 时间形态谓词唯一事实源（CodeRabbit nitpick 收口）。
//
// `db tables`/`db describe` 的 time_range 与 `query --table` 的主查询/覆盖查询共用
// `timeShapeClauses`。此前两份逐字副本靠注释与字符串相等测试防守，gap 2 缺陷正来自
// 这两份副本；现在口径由构造保证，本文件只钉**共享实现本身**的输出形态 ——
// 两个消费方各自的端到端断言在 table-query.test.ts / db.test.ts（逐字 SQL 已在那里）。
import { describe, it, expect } from 'vitest'
import { timeShapeClauses } from '../../src/query/time-shape.js'
import { MAX_SHANGHAI_SAFE_MS } from '../../src/core/time.js'

describe('timeShapeClauses · 三形态判据', () => {
  it('iso-day：形态正则（秒必须存在）+ TRY_CAST 可解析，两条件 AND', () => {
    expect(timeShapeClauses('iso-day', '"stat_date"')).toEqual([
      `regexp_matches("stat_date", '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$')`,
      'TRY_CAST("stat_date" AS TIMESTAMPTZ) IS NOT NULL',
    ])
  })

  it('iso-instant：容忍时区偏移写法（Z 或 ±HH:MM）；`~` 运算符不得出现（实测不是正则匹配）', () => {
    const clauses = timeShapeClauses('iso-instant', '"startTime"')
    expect(clauses[0]).toMatch(/Z\|\[\+-\]/)
    expect(clauses.join(' ')).not.toContain('~')
  })

  it('epoch-ms：数值区间判据，上界 = MAX_SHANGHAI_SAFE_MS（形状合格 ⊆ 能回显，gap 2）', () => {
    expect(timeShapeClauses('epoch-ms', '"startTime"')).toEqual([
      'TRY_CAST("startTime" AS BIGINT) > 100000000000',
      `TRY_CAST("startTime" AS BIGINT) <= ${MAX_SHANGHAI_SAFE_MS}`,
    ])
  })
})
