// tests/store/object-kinds.test.ts —— 表名匹配规则的两处实现（store/object-kinds 与
// schema.tableByName）必须同规则（Codex PR#76：后者是本模块内的就地实现）。
import { describe, it, expect } from 'vitest'
import { sameObjectName } from '../../src/store/object-kinds.js'
import { TABLES, tableByName } from '../../src/store/schema.js'

describe('表名匹配规则（DuckDB 标识符：只折叠 ASCII A–Z）', () => {
  it('声明名的大小写变体都解析到同一张表', () => {
    for (const t of TABLES) {
      expect(tableByName(t.name.toUpperCase())?.name, t.name).toBe(t.name)
    }
  })

  it('Unicode 折叠不算同名（ticKets 不是 tickets）—— 两处实现一致', () => {
    expect(sameObjectName('ticKets', 'tickets')).toBe(false)
    expect(tableByName('TICKETS')).toBeUndefined()
  })

  it('未声明的名字仍返回 undefined（不误伤）', () => {
    expect(tableByName('nope')).toBeUndefined()
  })
})
