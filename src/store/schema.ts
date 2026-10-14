// src/store/schema.ts
export interface ColumnDef {
  name: string
  type: 'VARCHAR' | 'INTEGER'
  nullable: boolean
  /** ⚠️ E 交付前无运行时读取者 —— 是给 E 的 `db describe` 的预置位（spec §6.2）。 */
  sensitive?: boolean
}
export interface TableDef { name: string; columns: ColumnDef[]; primaryKey: string[] }

const col = (name: string, type: 'VARCHAR' | 'INTEGER', nullable = true,
  sensitive = false): ColumnDef =>
  ({ name, type, nullable, sensitive })

export const TABLES: TableDef[] = [
  { name: 'schema_version', columns: [col('version', 'INTEGER', false)], primaryKey: ['version'] },
  {
    name: 'sync_state',
    columns: [col('dataset', 'VARCHAR', false), col('watermark', 'VARCHAR'), col('range_status', 'VARCHAR'),
      col('last_error', 'VARCHAR'), col('locked_by', 'VARCHAR'), col('locked_at', 'VARCHAR'),
      // D-T3：水位状态的同步时间（readWatermark 的 lastSyncedAt 往返落点）。
      col('last_synced_at', 'VARCHAR'),
      // D-T4：持久化限频闸门 —— 冷却行（dataset=__ratelimit__:<endpointId>）的
      // 下次可调用时间（watermark 列存同一 ISO 截止时间，两列冗余以备演进）与
      // 最近一次被限频时间。
      col('next_allowed_at', 'VARCHAR'), col('last_rate_limited_at', 'VARCHAR')],
    primaryKey: ['dataset'],
  },
  {
    name: 'sync_gaps',
    columns: [col('dataset', 'VARCHAR', false), col('range_start', 'VARCHAR', false), col('range_end', 'VARCHAR'),
      col('reason', 'VARCHAR'), col('recorded_at', 'VARCHAR'),
      // D-T3：缺口诊断详情（recordGap 的 detail 落点）。
      col('detail', 'VARCHAR')],
    primaryKey: ['dataset', 'range_start'],
  },
  {
    name: 'tags',
    columns: [col('id', 'VARCHAR', false), col('name', 'VARCHAR', false), col('color', 'VARCHAR', false)],
    primaryKey: ['id'],
  },
  // —— D：维度表批次（迁移 v3 建，列集按设计稿 §6.2 实测字段全集）——
  // 列型只有 VARCHAR/INTEGER；ID 一律 VARCHAR（BIGINT 精度红线）；无 PII 列。
  {
    // staff.list：实测 17 字段全集。telephone 330/330 为空、零区分度 → 删（§6.2）。
    // groupInfo 是列表 [{groupId,groupName}]，落库为 JSON 字符串列。
    // synchronized_at 由同步任务填写（快照时间），不在上游业务键内。
    name: 'staff',
    columns: [col('id', 'VARCHAR', false), col('realname', 'VARCHAR'), col('nickname', 'VARCHAR'),
      col('username', 'VARCHAR'), col('role', 'VARCHAR'), col('roleId', 'VARCHAR'),
      col('status', 'VARCHAR'), col('createtime', 'VARCHAR'), col('updateTime', 'VARCHAR'),
      col('email', 'VARCHAR'), col('phone', 'VARCHAR'), col('workNumber', 'VARCHAR'),
      col('maxServiceCount', 'VARCHAR'), col('skillScoreChat', 'VARCHAR'),
      col('skillScoreIpcc', 'VARCHAR'), col('groupInfo', 'VARCHAR'),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['id'],
  },
  {
    // staff.group.list：实测恰 3 键——字段是 id（响应中无 groupId 键）。
    // staffIdList 仅在 staff:true 时非空，成员关系单独落 staff_group_members，此表不存。
    name: 'staff_groups',
    columns: [col('id', 'VARCHAR', false), col('name', 'VARCHAR'),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['id'],
  },
  {
    // 权威来源是 staff.group.list?staff=true 的 staffIdList（含组管理员）——
    // 不用 staff.group.members 接口（实测 9/33 组缺人）（§6.2）。
    name: 'staff_group_members',
    columns: [col('group_id', 'VARCHAR', false), col('staff_id', 'VARCHAR', false),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['group_id', 'staff_id'],
  },
  {
    // category.list：扁平返回，树由调用方构建（存储保持扁平）；rank 是稠密全局序号。
    name: 'ticket_categories',
    columns: [col('id', 'VARCHAR', false), col('name', 'VARCHAR'), col('parentId', 'VARCHAR'),
      col('rank', 'VARCHAR'), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['id'],
  },
  {
    // ticket.template.list：status 全为 1、不携带信息 → 不建列。
    name: 'ticket_templates',
    columns: [col('id', 'VARCHAR', false), col('name', 'VARCHAR'), col('createTime', 'VARCHAR'),
      col('autoFlow', 'VARCHAR'), col('autoStatus', 'VARCHAR'), col('fileStatus', 'VARCHAR'),
      col('autoGuide', 'VARCHAR'), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['id'],
  },
  {
    // ticket.template.fields：required 是三种状态（int ∈{0,1,2}），不是布尔；
    // description/prefill 都是 JSON/字符串列；status 全为 0、不建列。
    name: 'ticket_template_fields',
    columns: [col('template_id', 'VARCHAR', false), col('fieldId', 'VARCHAR', false),
      col('id', 'VARCHAR'), col('name', 'VARCHAR'), col('type', 'VARCHAR'),
      col('required', 'VARCHAR'), col('customer', 'VARCHAR'), col('description', 'VARCHAR'),
      col('prefill', 'VARCHAR'), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['template_id', 'fieldId'],
  },
  // —— D：报表表批次（迁移 v5 建；spec §5.2 十一列的 9 张历史报表——
  // realtime_session/realtime_ipcc 是实时快照，不建同步任务、不建表）——
  // 业务字段收敛进 payload JSON 字符串列（响应字段集漂移频繁：overview 69 字段、
  // performance 的 Radio 拼写等——按 payload 建 schema 的列名对拍无稳定基准，
  // 固定键列 + payload 收敛是红线 1 兼容的最小稳定面）；stat_date 恒由调用方
  // 按窗口填写（「日期一律由调用方填写」统一结论）。
  {
    name: 'daily_overview',
    columns: [col('stat_date', 'VARCHAR', false), col('payload', 'VARCHAR'),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date'],
  },
  {
    name: 'staff_workload',
    columns: [col('stat_date', 'VARCHAR', false), col('staff_id', 'VARCHAR', false),
      col('payload', 'VARCHAR'), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date', 'staff_id'],
  },
  {
    name: 'staff_quality',
    columns: [col('stat_date', 'VARCHAR', false), col('staff_id', 'VARCHAR', false),
      col('payload', 'VARCHAR'), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date', 'staff_id'],
  },
  {
    name: 'staff_satisfaction',
    columns: [col('stat_date', 'VARCHAR', false), col('staff_id', 'VARCHAR', false),
      col('payload', 'VARCHAR'), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date', 'staff_id'],
  },
  {
    // 粒度是客服 × 小时（必须传 startTime，否则静默降级为天粒度少抓 ~10 倍）；
    // hour_ts 是响应内唯一可信的日期字段（该小时按小时对齐的时间戳）。
    name: 'staff_attendance',
    columns: [col('staff_id', 'VARCHAR', false), col('hour_ts', 'VARCHAR', false),
      col('stat_date', 'VARCHAR', false), col('payload', 'VARCHAR'),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['staff_id', 'hour_ts'],
  },
  {
    name: 'order_performance',
    columns: [col('order_id', 'VARCHAR', false), col('stat_date', 'VARCHAR', false),
      col('payload', 'VARCHAR'), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['order_id'],
  },
  {
    // 1 次调用 = 1 个客服，且只覆盖窗口起始的那一天 → work_date = 窗口起始日。
    name: 'staff_salary_detail',
    columns: [col('staff_id', 'VARCHAR', false), col('work_date', 'VARCHAR', false),
      col('stat_date', 'VARCHAR', false), col('payload', 'VARCHAR'),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['staff_id', 'work_date'],
  },
  {
    name: 'robot_summary',
    columns: [col('stat_date', 'VARCHAR', false), col('payload', 'VARCHAR'),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date'],
  },
  {
    name: 'transfer_human',
    columns: [col('stat_date', 'VARCHAR', false), col('payload', 'VARCHAR'),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date'],
  },
  // —— D：工单表批次（迁移 v6 建；spec §5.2 末行/§5.5）——
  // 工单行线上有 27 个键、文档只有 16 个（设计稿 §6.2：connectionId/crm*/holder* 等未文档化
  // 字段 + 漂移频繁）→ 业务字段整体收敛进 payload JSON 字符串列（与报表批次同一取舍）：
  // 键列保证 JOIN 与红线 1，payload 保真全部业务字段。主键全业务键（红线 1）：
  // tickets=ticket_id、ticket_logs=(ticket_id, log_id)。
  // ⚠️ PII 列（工单域的真正载体与文档列出项，设计稿 §6.5：会话导出与工单域字段名互不相交）
  // 标 sensitive: true —— crmUserPhone/crmUserName 非空率 78–81%/100%，userMobile/userName/
  // userEmail 存在于 100% 但非空率 0%（保护不得只挂真载体，也要按实测清单兜住全列）。
  {
    name: 'tickets',
    columns: [col('ticket_id', 'VARCHAR', false), col('payload', 'VARCHAR'),
      col('crmUserName', 'VARCHAR', true, true), col('crmUserPhone', 'VARCHAR', true, true),
      col('crmUserEmail', 'VARCHAR', true, true), col('userMobile', 'VARCHAR', true, true),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['ticket_id'],
  },
  {
    name: 'ticket_logs',
    columns: [col('ticket_id', 'VARCHAR', false), col('log_id', 'VARCHAR', false),
      col('payload', 'VARCHAR'), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['ticket_id', 'log_id'],
  },
]

export function tableByName(name: string): TableDef | undefined {
  return TABLES.find((t) => t.name === name)
}

/** v1 基线批次（C1 交付的四张）；v3/v5 起的数据表批次不进 v1 建表循环。 */
export const V1_TABLES = ['schema_version', 'sync_state', 'sync_gaps', 'tags']

/** ⚠️ 只产 v1 基线建表语句 —— 对已存在的库加不了列。任何 TABLES 变更必须新增迁移条目（spec §6.2）。 */
export function ddlFor(t: TableDef): string {
  const cols = t.columns.map((c) => `"${c.name}" ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(', ')
  const pk = t.primaryKey.map((k) => `"${k}"`).join(', ')
  return `CREATE TABLE IF NOT EXISTS "${t.name}" (${cols}, PRIMARY KEY (${pk}))`
}

/** 迁移条目：函数式（可 ALTER TABLE）。一版本一行；当前版 = MAX(version)（spec §6.2）。 */
export interface Migration { version: number; up: (exec: (sql: string) => Promise<void>) => Promise<void> }

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: async (exec) => {
      for (const t of TABLES.filter((x) => V1_TABLES.includes(x.name))) await exec(ddlFor(t))
    },
  },
  // D-T3 迁移：为已有 C1 库补 sync_state.last_synced_at 与 sync_gaps.detail 两列。
  // ⚠️ 新库 v1 建表时 TABLES 已含这两列，故用 IF NOT EXISTS 保证幂等（v1+ v2 连放不炸）。
  {
    version: 2,
    up: async (exec) => {
      await exec('ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "last_synced_at" VARCHAR')
      await exec('ALTER TABLE "sync_gaps" ADD COLUMN IF NOT EXISTS "detail" VARCHAR')
    },
  },
  // D-T4 迁移：限频闸门的冷却列。
  {
    version: 4,
    up: async (exec) => {
      await exec('ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "next_allowed_at" VARCHAR')
      await exec('ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "last_rate_limited_at" VARCHAR')
    },
  },
  // D-T6 迁移：维度表 7 张（staff/staff_groups/staff_group_members/ticket_categories/
  // ticket_templates/ticket_template_fields 建新表；tags 已在 v1）。新表 DDL 天然幂等
  //（CREATE TABLE IF NOT EXISTS），与 v1 连放不炸。
  {
    version: 3,
    up: async (exec) => {
      for (const name of ['staff', 'staff_groups', 'staff_group_members',
        'ticket_categories', 'ticket_templates', 'ticket_template_fields']) {
        await exec(ddlFor(tableByName(name)!))
      }
    },
  },
  // D-T7 迁移：9 张报表表（键列 + stat_date 范围列 + payload 收敛列）。
  {
    version: 5,
    up: async (exec) => {
      for (const name of ['daily_overview', 'staff_workload', 'staff_quality',
        'staff_satisfaction', 'staff_attendance', 'order_performance',
        'staff_salary_detail', 'robot_summary', 'transfer_human']) {
        await exec(ddlFor(tableByName(name)!))
      }
    },
  },
  // D-T9 迁移：工单表 2 张（tickets/ticket_logs，键列 + payload 收敛 + PII 敏感列）。
  {
    version: 6,
    up: async (exec) => {
      for (const name of ['tickets', 'ticket_logs']) {
        await exec(ddlFor(tableByName(name)!))
      }
    },
  },
]

// ⚠️ 预留给 E（`db describe <table>` 的列定义展示）消费；C1 无调用方，保留导出（L2）。
export const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0)
