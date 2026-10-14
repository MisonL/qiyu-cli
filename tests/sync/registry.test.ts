// tests/sync/registry.test.ts —— D-T12：任务注册表静态断言（红线 1 的静态形态）。
import { describe, it, expect } from 'vitest'
import { SYNC_TASKS, taskById, UNSUPPORTED_DATASETS } from '../../src/sync/registry.js'
import { TABLES, tableByName } from '../../src/store/schema.js'

describe('任务注册表', () => {
  it('SYNC_TASKS 共 21 条（dim 6 + reports 9 + tickets 2 + sessions 1 + knowledge 3）', () => {
    expect(SYNC_TASKS.length).toBe(21)
  })

  it('id 唯一且 taskById 双向一致', () => {
    const ids = SYNC_TASKS.map((t) => t.id)
    expect(new Set(ids).size).toBe(21)
    for (const t of SYNC_TASKS) expect(taskById(t.id)).toBe(t)
    expect(taskById('no.such')).toBeUndefined()
  })

  it('table 都在 TABLES 中', () => {
    const names = new Set(TABLES.map((t) => t.name))
    for (const t of SYNC_TASKS) expect(names.has(t.table), t.id).toBe(true)
  })

  it('红线 1 静态断言：primaryKey 与声明表的表级主键一致（业务键）', () => {
    for (const t of SYNC_TASKS) {
      const def = tableByName(t.table)
      expect(def, t.id).toBeDefined()
      expect([...t.primaryKey].sort(), t.id).toEqual([...def!.primaryKey].sort())
    }
  })

  it('kind 与声明一致：windowed 任务必须有 maxWindowDays', () => {
    for (const t of SYNC_TASKS) {
      if (t.kind === 'windowed') expect(t.maxWindowDays, t.id).toBeDefined()
    }
  })

  it('实时快照 unsupported 条目：两个接口 id、reason 均为 realtime', () => {
    expect(UNSUPPORTED_DATASETS).toEqual([
      { id: 'realtime.session', reason: 'realtime' },
      { id: 'realtime.ipcc', reason: 'realtime' },
    ])
  })
})
