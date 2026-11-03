// tests/sync/delete-boundary-contract.test.ts —— 写策略声明契约的双向自检
//
// 契约（`src/sync/write-contract.ts`，注册表加载期执行）：
//   · 按日粒度范围列删 ⇒ 任务必须声明 windowAlign='shanghaiDay'（否则相邻窗会抹掉边界日）；
//   · 按逐行瞬时列删 ⇒ 该列必须是表的列，且是声明为 timeColumn 的 iso-instant（删除值
//     与 `new Date(ms).toISOString()` 同形的前提）。
// 真实事故文本必红（缺 windowAlign 的考勤形态）、合法声明放过 —— 与
// `tests/store-hint-selection.test.ts` 同款双向自检。
import { describe, it, expect } from 'vitest'
import { writeContractViolations } from '../../src/sync/write-contract.js'
import { SYNC_TASKS } from '../../src/sync/registry.js'
import type { SyncTask } from '../../src/sync/types.js'

describe('写策略声明契约（双向自检）', () => {
  it('真实注册表全部通过（registry.ts 加载即校验，本用例钉住校验确实接在注册表上）', () => {
    for (const t of SYNC_TASKS) {
      expect(writeContractViolations(t), `${t.id} 不应违反写策略契约`).toEqual([])
    }
  })

  it('按日删（rangeColumns + rangeAlign）但缺 windowAlign → 报错（真实事故形态）', () => {
    // 事故形态：staff_attendance 曾按 stat_date 自然日删、却按 31 天任意起点切窗，
    // 边界日被相邻窗整片删掉（16/24 小时、仍 status=complete）。
    const t: SyncTask = {
      id: 'reports.staff_attendance', table: 'staff_attendance',
      write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'], rangeAlign: 'shanghaiDay' },
    } as SyncTask
    const v = writeContractViolations(t)
    expect(v.length).toBe(1)
    expect(v[0]).toMatch(/rangeAlign='shanghaiDay'.*未声明 windowAlign='shanghaiDay/)
  })

  it('按日删 + windowAlign 正确 → 通过', () => {
    const t: SyncTask = {
      id: 'reports.staff_workload', table: 'staff_workload', windowAlign: 'shanghaiDay',
      write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'], rangeAlign: 'shanghaiDay' },
    } as SyncTask
    expect(writeContractViolations(t)).toEqual([])
  })

  it('instantColumn 指向不存在的表 → 报错', () => {
    const t: SyncTask = {
      id: 'test', table: 'nonexistent_table',
      write: { kind: 'deleteRangeInsert', instantColumn: 'hour_ts' },
    } as SyncTask
    const v = writeContractViolations(t)
    expect(v.length).toBe(1)
    expect(v[0]).toMatch(/表 'nonexistent_table' 不在 TABLES 里/)
  })

  it('instantColumn 指向表里不存在的列 → 报错', () => {
    const t: SyncTask = {
      id: 'test', table: 'staff_attendance',
      write: { kind: 'deleteRangeInsert', instantColumn: 'nonexistent_col' },
    } as SyncTask
    const v = writeContractViolations(t)
    expect(v.length).toBe(1)
    expect(v[0]).toMatch(/不是表 'staff_attendance' 的列/)
  })

  it('instantColumn 是日粒度列（stat_date）而非 timeColumn → 报错', () => {
    // stat_date 是 iso-day（上海自然日），比较口径与 toISOString() 的瞬时值不同源。
    const t: SyncTask = {
      id: 'test', table: 'staff_attendance',
      write: { kind: 'deleteRangeInsert', instantColumn: 'stat_date' },
    } as SyncTask
    const v = writeContractViolations(t)
    expect(v.length).toBe(1)
    expect(v[0]).toMatch(/timeColumn 且 kind='iso-instant'/)
  })

  it('instantColumn 指向正确的 timeColumn（hour_ts）→ 通过', () => {
    const t: SyncTask = {
      id: 'reports.staff_attendance', table: 'staff_attendance',
      write: { kind: 'deleteRangeInsert', instantColumn: 'hour_ts' },
    } as SyncTask
    expect(writeContractViolations(t)).toEqual([])
  })

  it('upsertRows 不适用契约 → 不产生任何违规', () => {
    const t: SyncTask = { id: 'test', table: 'tags', write: { kind: 'upsertRows' } } as SyncTask
    expect(writeContractViolations(t)).toEqual([])
  })
})
