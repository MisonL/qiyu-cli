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

  it('sync_state 十一列（D-T3 last_synced_at、D-T4 限频两列、G2 resolved_range 两列）', () => {
    const t = tableByName('sync_state')!
    expect(t.columns.map((c) => c.name)).toEqual(
      ['dataset', 'watermark', 'range_status', 'last_error', 'locked_by', 'locked_at', 'last_synced_at',
        'next_allowed_at', 'last_rate_limited_at', 'resolved_range_start', 'resolved_range_end'])
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

  it('payload 列在 PII 表上标 sensitive（D 高-1/F 中-2 + 修复批 3：它是 PII 的完整副本，漏标 = 整列绕过脱敏）', () => {
    // ticket_logs 在修复批 3 加入：`ticket.log` 行携带 ccList/toMailList（邮箱清单）、
    // operatorId 与日志正文（设计稿 §10.3/§10.4 实测字段）——与 tickets/sessions 的 payload 同类。
    for (const name of ['sessions', 'tickets', 'ticket_logs']) {
      const c = tableByName(name)!.columns.find((x) => x.name === 'payload')!
      expect(c.sensitive, `${name}.payload`).toBe(true)
    }
    // 无 PII 的表不误标（知识库域与会话/工单 PII 清单零交集）
    expect(tableByName('knowledge_items')!.columns.find((c) => c.name === 'payload')!.sensitive)
      .toBe(false)
    expect(tableByName('daily_overview')!.columns.find((c) => c.name === 'payload')!.sensitive)
      .toBe(false)
  })

  it('schema_version.version 是 INTEGER（迁移序号，非 ID 列）', () => {
    // 逐键断言而非整体 toEqual：E 给 ColumnDef 追加了可选元数据键（unit/note/observed_enum），
    // 整体相等会把「新增可选元数据」误判成列定义变更；语义（名/型/非空/非敏感）逐项保留。
    // ⚠️ `grain` 是 **TableDef** 的键（不是 ColumnDef）—— 底下这条只有列定义，不含 grain。
    const c = tableByName('schema_version')!.columns[0]
    expect(c.name).toBe('version')
    expect(c.type).toBe('INTEGER')
    expect(c.nullable).toBe(false)
    expect(c.sensitive).toBe(false)
  })
})

// —— E 前置：元数据扩展（设计稿 §四）—— 以下断言只读 TS 侧元数据，不碰 DDL/迁移。
describe('TABLES —— E 元数据扩展', () => {
  it('每张表都有 grain 声明（E 的 db tables 出口）', () => {
    for (const t of TABLES) expect(t.grain, t.name).toBeTruthy()
  })
  it('timeColumn 只出现在有业务时间列的表上，且 kind 合法', () => {
    const withTime = TABLES.filter((t) => t.timeColumn).map((t) => t.name).sort()
    expect(withTime).toEqual(['daily_overview', 'order_performance', 'robot_summary', 'sessions',
      'staff_attendance', 'staff_quality', 'staff_salary_detail', 'staff_satisfaction',
      'staff_workload', 'transfer_human'])
    for (const t of TABLES) {
      if (t.timeColumn) expect(['iso-day', 'iso-instant', 'epoch-ms']).toContain(t.timeColumn.kind)
    }
    expect(tableByName('sessions')!.timeColumn).toEqual({ name: 'startTime', kind: 'epoch-ms' })
    expect(tableByName('staff_attendance')!.timeColumn).toEqual({ name: 'hour_ts', kind: 'iso-instant' })
    expect(tableByName('daily_overview')!.timeColumn).toEqual({ name: 'stat_date', kind: 'iso-day' })
  })
  // ⚠️ 不变量：timeColumn.name 必须是本表 columns 里的一列。
  // `db describe` / `db tables` 缺时间列时靠「少列」warning 点名（db.ts 的注释依赖这一点）；
  // 若声明的时间列根本不在 columns 里，列集核对不会报少列 —— 命令会**静默**把
  // time_range 置 null 而没有任何提示，Agent 会以为「这张表没有时间数据」。
  it('timeColumn.name 必须出现在本表 columns 中（否则缺列降级会静默）', () => {
    for (const t of TABLES) {
      if (t.timeColumn === undefined) continue
      expect(t.columns.map((c) => c.name), `${t.name}.timeColumn.name=${t.timeColumn.name}`)
        .toContain(t.timeColumn.name)
    }
  })
  it('observed_enum 只出现在有实测出处的列上（不是按名称泛化）', () => {
    expect(tableByName('sessions')!.columns.find((c) => c.name === 'session_type')!.observed_enum)
      .toEqual(['robot', 'internal', 'human'])
    expect(tableByName('sync_state')!.columns.find((c) => c.name === 'range_status')!.observed_enum)
      .toEqual(['pending', 'complete'])
    expect(tableByName('knowledge_items')!.columns.find((c) => c.name === 'type')!.observed_enum)
      .toEqual([1, 10])
    // staff.role / staff.status（设计稿 §6.2 实测 330 行）：列是 VARCHAR，故枚举按字符串给。
    // ⚠️ 除这两处外，无出处的列必须不带 observed_enum（不是按名称泛化）。
    expect(tableByName('staff')!.columns.find((c) => c.name === 'role')!.observed_enum)
      .toEqual(['0', '1', '2', '-2'])
    expect(tableByName('staff')!.columns.find((c) => c.name === 'status')!.observed_enum)
      .toEqual(['1', '2', '3'])
    expect(tableByName('staff')!.columns.find((c) => c.name === 'roleId')!.observed_enum)
      .toBeUndefined()
    expect(tableByName('sessions')!.columns.find((c) => c.name === 'userPhone')!.observed_enum)
      .toBeUndefined()
  })
  it('扩展字段不进 DDL（ddlFor 只读 name/type/nullable）', () => {
    const sql = ddlFor(tableByName('sessions')!)
    expect(sql).not.toMatch(/grain|observed_enum|note|unit|timeColumn/)
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

  it('v9 迁移给 sync_state 补 resolved_range 两列（函数式 ALTER、幂等形态）', async () => {
    const ran: string[] = []
    const m9 = MIGRATIONS.find((m) => m.version === 9)!
    await m9.up(async (sql) => { ran.push(sql) })
    expect(ran.length).toBe(2)
    expect(ran[0]).toMatch(/ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "resolved_range_start" VARCHAR/)
    expect(ran[1]).toMatch(/ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "resolved_range_end" VARCHAR/)
  })
})
