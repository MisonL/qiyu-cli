// tests/store/schema.test.ts
import { describe, it, expect } from 'vitest'
import { TABLES, MIGRATIONS, LATEST_VERSION, ddlFor, tableByName } from '../../src/store/schema.js'

describe('TABLES —— 表定义', () => {
  it('恰好二十五张表：v1 四张 + v3 批次六张维度表 + v5 批次九张报表表 + v6 批次两张工单表 + v7 sessions + v8 批次三张知识库表', () => {
    expect(TABLES.map((t) => t.name).sort()).toEqual([
      'daily_overview', 'knowledge_categories', 'knowledge_items', 'knowledge_points',
      'order_performance', 'robot_summary',
      'schema_version', 'sessions', 'staff', 'staff_attendance', 'staff_group_members',
      'staff_groups', 'staff_quality', 'staff_salary_detail', 'staff_satisfaction',
      'staff_workload', 'sync_gaps', 'sync_state', 'tags',
      'ticket_categories', 'ticket_logs', 'ticket_template_fields', 'ticket_templates',
      'tickets', 'transfer_human'])
  })

  it('tags 列恰为 id/name/color，全 NOT NULL，id 为 VARCHAR 主键', () => {
    const t = tableByName('tags')!
    expect(t.columns.map((c) => c.name)).toEqual(['id', 'name', 'color'])
    expect(t.columns.every((c) => c.nullable === false)).toBe(true)
    expect(t.columns.find((c) => c.name === 'id')!.type).toBe('VARCHAR')
    expect(t.primaryKey).toEqual(['id'])
  })

  it('sync_state 九列（D-T3 加 last_synced_at，D-T4 加 next_allowed_at/last_rate_limited_at）', () => {
    const t = tableByName('sync_state')!
    expect(t.columns.map((c) => c.name)).toEqual(
      ['dataset', 'watermark', 'range_status', 'last_error', 'locked_by', 'locked_at', 'last_synced_at',
        'next_allowed_at', 'last_rate_limited_at'])
    expect(t.primaryKey).toEqual(['dataset'])
  })

  it('sync_gaps 主键为 (dataset, range_start)', () => {
    expect(tableByName('sync_gaps')!.primaryKey).toEqual(['dataset', 'range_start'])
  })

  it('全部 ID 列为 VARCHAR（无 BIGINT）', () => {
    for (const t of TABLES) {
      for (const c of t.columns) {
        expect(['VARCHAR', 'INTEGER']).toContain(c.type)
        if (c.name === 'id' || c.name.endsWith('_id') || c.name === 'dataset') {
          expect(c.type, `${t.name}.${c.name}`).toBe('VARCHAR')
        }
      }
    }
  })

  it('每列都有 sensitive 键且为 boolean（C1 全 false；true 分支待 E/D）', () => {
    for (const t of TABLES) {
      for (const c of t.columns) {
        expect(typeof (c.sensitive ?? false), `${t.name}.${c.name}`).toBe('boolean')
      }
    }
  })

  it('schema_version.version 是 INTEGER（迁移序号，非 ID 列）', () => {
    expect(tableByName('schema_version')!.columns[0]).toEqual({ name: 'version', type: 'INTEGER', nullable: false, sensitive: false })
  })
})

describe('ddlFor —— 生成建表语句', () => {
  it('含主键与 NOT NULL', () => {
    const sql = ddlFor(tableByName('tags')!)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "tags"/)
    expect(sql).toMatch(/"id" VARCHAR NOT NULL/)
    expect(sql).toMatch(/PRIMARY KEY \("id"\)/)
  })

  it('复合主键正确渲染', () => {
    expect(ddlFor(tableByName('sync_gaps')!)).toMatch(/PRIMARY KEY \("dataset", "range_start"\)/)
  })
})

describe('MIGRATIONS —— 迁移', () => {
  it('版本号从 1 起严格递增、LATEST_VERSION 为最大值', () => {
    const vs = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b)
    expect(vs[0]).toBe(1)
    // v3 空档预留给数据表 DDL（T6），跳号是有意的 —— 故只断言严格递增而非连续。
    for (let i = 1; i < vs.length; i++) expect(vs[i]).toBeGreaterThan(vs[i - 1])
    expect(LATEST_VERSION).toBe(vs[vs.length - 1])
  })

  it('v1 迁移只建 v1 四张（v3 批次维度表不进 v1）', async () => {
    const ran: string[] = []
    const m1 = MIGRATIONS.find((m) => m.version === 1)!
    await m1.up(async (sql) => { ran.push(sql) })
    expect(ran.length).toBe(4)
    for (const name of ['schema_version', 'sync_state', 'sync_gaps', 'tags']) {
      expect(ran.some((s) => s.includes(`"${name}"`)), `v1 缺 ${name}`).toBe(true)
    }
    expect(ran.some((s) => s.includes('"staff"'))).toBe(false)
  })

  it('v3 迁移建出六张维度表（tags 已在 v1、不在 v3）', async () => {
    const ran: string[] = []
    const m3 = MIGRATIONS.find((m) => m.version === 3)!
    await m3.up(async (sql) => { ran.push(sql) })
    expect(ran.length).toBe(6)
    for (const name of ['staff', 'staff_groups', 'staff_group_members',
      'ticket_categories', 'ticket_templates', 'ticket_template_fields']) {
      expect(ran.some((s) => s.includes(`"${name}"`)), `v3 缺 ${name}`).toBe(true)
    }
  })
})
