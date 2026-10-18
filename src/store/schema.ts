// src/store/schema.ts
export type TimeColumnKind = 'iso-day' | 'iso-instant' | 'epoch-ms'

export interface ColumnDef {
  name: string
  type: 'VARCHAR' | 'INTEGER'
  nullable: boolean
  /**
   * PII 列标记（spec §6.2/§6.5）：`db describe`（E）与 `sync tasks`（D 命令层）的
   * 读取出口——E 按列脱敏时**只认这个标记**，所以漏标 = 整列不脱敏。
   */
  sensitive?: boolean
  /**
   * 实测观测到的取值集合。命名刻意不叫 enum：观测集不完整（设计稿 §10.5），
   * 不得据此做校验——它只是给 Agent 的提示，不是约束。
   */
  observed_enum?: Array<string | number>
  /** 列级单位/编码（E 的 db describe 出口）；缺省 = 未知。 */
  unit?: string
  /** 一句话语义。 */
  note?: string
}

export interface TableDef {
  name: string
  columns: ColumnDef[]
  primaryKey: string[]
  /** 粒度描述（E 的 db tables 出口）。 */
  grain: string
  /** 业务时间列（E 的 --since/--until 与时间范围出口）；缺省 = 不支持时间过滤。 */
  timeColumn?: { name: string; kind: TimeColumnKind }
}

/**
 * 时间列编码文案（设计稿 §四）：kind 决定存储形态，也决定 E 的比较方式——
 * iso-day 必须先把 --since 向下取整到上海自然日，直接比较会漏掉当天全天的行。
 */
const UNIT_ISO_DAY = '上海自然日 00:00 的 ISO 8601'
const UNIT_ISO_INSTANT = 'ISO 8601 UTC'
const UNIT_EPOCH_MS = 'epoch 毫秒数字字符串'
/** 业务字段整体收敛列（报表/工单/会话/知识库同一取舍）：值为整行 JSON 字符串。 */
const UNIT_JSON = 'JSON 字符串'

const col = (name: string, type: 'VARCHAR' | 'INTEGER', nullable = true,
  sensitive = false): ColumnDef =>
  ({ name, type, nullable, sensitive })

/** 带附加元数据的列：col 的语义不变，只补 E 的 db describe 出口字段。 */
const colMeta = (name: string, type: 'VARCHAR' | 'INTEGER', meta: Pick<ColumnDef, 'unit' | 'note' | 'observed_enum'>,
  nullable = true, sensitive = false): ColumnDef =>
  ({ ...col(name, type, nullable, sensitive), ...meta })

export const TABLES: TableDef[] = [
  {
    name: 'schema_version',
    columns: [col('version', 'INTEGER', false)], primaryKey: ['version'],
    grain: '迁移版本记录（每版本一行）',
  },
  {
    name: 'sync_state',
    columns: [col('dataset', 'VARCHAR', false), col('watermark', 'VARCHAR'),
      colMeta('range_status', 'VARCHAR', { observed_enum: ['pending', 'complete'] }),
      col('last_error', 'VARCHAR'), col('locked_by', 'VARCHAR'), col('locked_at', 'VARCHAR'),
      // D-T3：水位状态的同步时间（readWatermark 的 lastSyncedAt 往返落点）。
      col('last_synced_at', 'VARCHAR'),
      // D-T4：持久化限频闸门 —— 冷却行（dataset=__ratelimit__:<endpointId>）的
      // 下次可调用时间（watermark 列存同一 ISO 截止时间，两列冗余以备演进）与
      // 最近一次被限频时间。
      col('next_allowed_at', 'VARCHAR'), col('last_rate_limited_at', 'VARCHAR'),
      // G2 义务（spec §八.2/§十一.17）：上次成功推进覆盖的区间（ISO 字符串）——
      // `sync status` 的 resolved_range 输出来源，Agent 可据此判断数据新鲜度。
      col('resolved_range_start', 'VARCHAR'), col('resolved_range_end', 'VARCHAR')],
    primaryKey: ['dataset'],
    grain: '每个同步任务一行（水位/状态/冷却/覆盖区间）',
  },
  {
    name: 'sync_gaps',
    columns: [col('dataset', 'VARCHAR', false), col('range_start', 'VARCHAR', false), col('range_end', 'VARCHAR'),
      col('reason', 'VARCHAR'), col('recorded_at', 'VARCHAR'),
      // D-T3：缺口诊断详情（recordGap 的 detail 落点）。
      col('detail', 'VARCHAR')],
    primaryKey: ['dataset', 'range_start'],
    grain: '每个缺口区间一行',
  },
  {
    name: 'tags',
    columns: [col('id', 'VARCHAR', false), col('name', 'VARCHAR', false), col('color', 'VARCHAR', false)],
    primaryKey: ['id'],
    grain: '每个标签一行',
  },
  // —— D：维度表批次（迁移 v3 建，列集按设计稿 §6.2 实测字段全集）——
  // 列型只有 VARCHAR/INTEGER；ID 一律 VARCHAR（BIGINT 精度红线）；无 PII 列。
  {
    // staff.list：实测 17 字段全集。telephone 330/330 为空、零区分度 → 删（§6.2）。
    // groupInfo 是列表 [{groupId,groupName}]，落库为 JSON 字符串列。
    // synchronized_at 由同步任务填写（快照时间），不在上游业务键内。
    name: 'staff',
    columns: [col('id', 'VARCHAR', false), col('realname', 'VARCHAR'), col('nickname', 'VARCHAR'),
      col('username', 'VARCHAR'),
      // role/status 的观测值集（设计稿 §6.2 实测 330 行）：列是 VARCHAR，故枚举按字符串给。
      // ⚠️ 观测集不完整（role 的 -1 从未观测到，但作为筛选项被接受并返回 0 行）——仅供提示。
      colMeta('role', 'VARCHAR', { observed_enum: ['0', '1', '2', '-2'] }),
      col('roleId', 'VARCHAR'),
      colMeta('status', 'VARCHAR', { observed_enum: ['1', '2', '3'] }),
      col('createtime', 'VARCHAR'), col('updateTime', 'VARCHAR'),
      col('email', 'VARCHAR'), col('phone', 'VARCHAR'), col('workNumber', 'VARCHAR'),
      col('maxServiceCount', 'VARCHAR'), col('skillScoreChat', 'VARCHAR'),
      col('skillScoreIpcc', 'VARCHAR'), col('groupInfo', 'VARCHAR'),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['id'],
    grain: '每个客服一行',
  },
  {
    // staff.group.list：实测恰 3 键——字段是 id（响应中无 groupId 键）。
    // staffIdList 仅在 staff:true 时非空，成员关系单独落 staff_group_members，此表不存。
    name: 'staff_groups',
    columns: [col('id', 'VARCHAR', false), col('name', 'VARCHAR'),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['id'],
    grain: '每个客服组一行',
  },
  {
    // 权威来源是 staff.group.list?staff=true 的 staffIdList（含组管理员）——
    // 不用 staff.group.members 接口（实测 9/33 组缺人）（§6.2）。
    name: 'staff_group_members',
    columns: [col('group_id', 'VARCHAR', false), col('staff_id', 'VARCHAR', false),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['group_id', 'staff_id'],
    grain: '每个「组 × 客服」关系一行',
  },
  {
    // category.list：扁平返回，树由调用方构建（存储保持扁平）；rank 是稠密全局序号。
    name: 'ticket_categories',
    columns: [col('id', 'VARCHAR', false), col('name', 'VARCHAR'), col('parentId', 'VARCHAR'),
      col('rank', 'VARCHAR'), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['id'],
    grain: '每个工单分类一行（扁平，树由 parentId 构建）',
  },
  {
    // ticket.template.list：status 全为 1、不携带信息 → 不建列。
    name: 'ticket_templates',
    columns: [col('id', 'VARCHAR', false), col('name', 'VARCHAR'), col('createTime', 'VARCHAR'),
      col('autoFlow', 'VARCHAR'), col('autoStatus', 'VARCHAR'), col('fileStatus', 'VARCHAR'),
      col('autoGuide', 'VARCHAR'), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['id'],
    grain: '每个工单模板一行',
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
    grain: '每个「模板 × 字段」一行',
  },
  // —— D：报表表批次（迁移 v5 建；spec §5.2 十一列的 9 张历史报表——
  // realtime_session/realtime_ipcc 是实时快照，不建同步任务、不建表）——
  // 业务字段收敛进 payload JSON 字符串列（响应字段集漂移频繁：overview 69 字段、
  // performance 的 Radio 拼写等——按 payload 建 schema 的列名对拍无稳定基准，
  // 固定键列 + payload 收敛是红线 1 兼容的最小稳定面）；stat_date 恒由调用方
  // 按窗口填写（「日期一律由调用方填写」统一结论）。
  {
    name: 'daily_overview',
    columns: [colMeta('stat_date', 'VARCHAR', { unit: UNIT_ISO_DAY }, false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date'],
    grain: '每个上海自然日一行（全局汇总）',
    timeColumn: { name: 'stat_date', kind: 'iso-day' },
  },
  {
    name: 'staff_workload',
    columns: [colMeta('stat_date', 'VARCHAR', { unit: UNIT_ISO_DAY }, false),
      col('staff_id', 'VARCHAR', false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date', 'staff_id'],
    grain: '每个「客服 × 上海自然日」一行',
    timeColumn: { name: 'stat_date', kind: 'iso-day' },
  },
  {
    name: 'staff_quality',
    columns: [colMeta('stat_date', 'VARCHAR', { unit: UNIT_ISO_DAY }, false),
      col('staff_id', 'VARCHAR', false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date', 'staff_id'],
    grain: '每个「客服 × 上海自然日」一行（含 staff_id=sum 的全局汇总行）',
    timeColumn: { name: 'stat_date', kind: 'iso-day' },
  },
  {
    name: 'staff_satisfaction',
    columns: [colMeta('stat_date', 'VARCHAR', { unit: UNIT_ISO_DAY }, false),
      col('staff_id', 'VARCHAR', false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date', 'staff_id'],
    grain: '每个「客服 × 上海自然日」一行',
    timeColumn: { name: 'stat_date', kind: 'iso-day' },
  },
  {
    // 粒度是客服 × 小时（必须传 startTime，否则静默降级为天粒度少抓 ~10 倍）；
    // hour_ts 是响应内唯一可信的日期字段（该小时按小时对齐的时间戳）。
    name: 'staff_attendance',
    columns: [col('staff_id', 'VARCHAR', false),
      colMeta('hour_ts', 'VARCHAR', { unit: UNIT_ISO_INSTANT }, false),
      // 辅助列：由本行 hour_ts 推导的上海自然日（不是窗口起点），故同为 iso-day 编码。
      colMeta('stat_date', 'VARCHAR', { unit: UNIT_ISO_DAY }, false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['staff_id', 'hour_ts'],
    grain: '每个「客服 × 小时」一行',
    // 时间列取 hour_ts 而非 stat_date：小时粒度是这张表的本体，stat_date 只是派生辅助列。
    timeColumn: { name: 'hour_ts', kind: 'iso-instant' },
  },
  {
    name: 'order_performance',
    columns: [col('order_id', 'VARCHAR', false),
      colMeta('stat_date', 'VARCHAR', { unit: UNIT_ISO_DAY }, false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['order_id'],
    grain: '每个订单一行（含 order_id=sum 的全局汇总行）',
    timeColumn: { name: 'stat_date', kind: 'iso-day' },
  },
  {
    // 1 次调用 = 1 个客服，且只覆盖窗口起始的那一天 → work_date = 窗口起始日。
    name: 'staff_salary_detail',
    columns: [col('staff_id', 'VARCHAR', false),
      colMeta('work_date', 'VARCHAR', { unit: UNIT_ISO_DAY }, false),
      colMeta('stat_date', 'VARCHAR', { unit: UNIT_ISO_DAY }, false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['staff_id', 'work_date'],
    grain: '每个「客服 × 工作日期」一行',
    // work_date 与 stat_date 同为 iso-day；本期取 stat_date（与其余报表表统一，设计稿 §四）。
    timeColumn: { name: 'stat_date', kind: 'iso-day' },
  },
  {
    name: 'robot_summary',
    columns: [colMeta('stat_date', 'VARCHAR', { unit: UNIT_ISO_DAY }, false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date'],
    grain: '每个上海自然日一行（机器人汇总）',
    timeColumn: { name: 'stat_date', kind: 'iso-day' },
  },
  {
    name: 'transfer_human',
    columns: [colMeta('stat_date', 'VARCHAR', { unit: UNIT_ISO_DAY }, false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['stat_date'],
    grain: '每个上海自然日一行（转人工汇总）',
    timeColumn: { name: 'stat_date', kind: 'iso-day' },
  },
  // —— D：工单表批次（迁移 v6 建；spec §5.2 末行/§5.5）——
  // 工单行线上有 27 个键、文档只有 16 个（设计稿 §6.2：connectionId/crm*/holder* 等未文档化
  // 字段 + 漂移频繁）→ 业务字段整体收敛进 payload JSON 字符串列（与报表批次同一取舍）：
  // 键列保证 JOIN 与红线 1，payload 保真全部业务字段。主键全业务键（红线 1）：
  // tickets=ticket_id、ticket_logs=(ticket_id, log_id)。
  // ⚠️ PII 列（工单域的真正载体与文档列出项，设计稿 §6.5：会话导出与工单域字段名互不相交）
  // 标 sensitive: true —— crmUserPhone/crmUserName 非空率 78–81%/100%，userMobile/userName/
  // userEmail 存在于 100% 但非空率 0%（保护不得只挂真载体，也要按实测清单兜住全列）。
  // ⚠️ `payload` 列**也是** PII 载体：它是整行业务的 JSON 完整副本（含 crmUserPhone 等）——
  // 不标 sensitive 会让「按列脱敏」的 E 从这一列把全部 PII 原样读出（整列绕过）。
  {
    name: 'tickets',
    columns: [col('ticket_id', 'VARCHAR', false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }, true, true),
      col('crmUserName', 'VARCHAR', true, true), col('crmUserPhone', 'VARCHAR', true, true),
      col('crmUserEmail', 'VARCHAR', true, true), col('userMobile', 'VARCHAR', true, true),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['ticket_id'],
    grain: '每个工单一行',
  },
  {
    name: 'ticket_logs',
    // ⚠️ payload 同样是 PII 的完整副本，标 sensitive: true（修复批 3）——`ticket.log` 行携带
    // `ccList`/`toMailList`（邮箱清单）、`operatorId` 与日志正文（设计稿 §10.3 实测字段表：
    // 「六个字段未文档化…attachments/nodeName/preHolder/targetStaff/ccList/toMailList 稀疏存在」），
    // 与 tickets/sessions 的 payload 同类：不标等于让 E 的按列脱敏从这一列整列绕过。
    // **判定依据是设计稿的实测字段（§10.3/§10.4），不是本行的重测** —— 标注意义与
    // tickets/sessions 一致（PII 完整副本），故按同规处理；若将来复测发现该行不含 PII，
    // 撤标需连同本节注释一起改（不留「标了但没依据」的状态）。
    columns: [col('ticket_id', 'VARCHAR', false), col('log_id', 'VARCHAR', false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }, true, true),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['ticket_id', 'log_id'],
    grain: '每条工单日志一行',
  },
  // —— D：会话表批次（迁移 v7 建；设计稿 §7.5 实测字段全集）——
  // session.txt 实测 90 个顶层键（71 恒存在 + 19 条件出现，private/raw 验证样本已做键普查、
  // 不入仓库）——与报表批次同一取舍：业务字段整体收敛进 payload JSON 字符串列，固定键列 +
  // 派生列保证 JOIN 与分析。主键 session_id（上游业务键，红线 1）；
  // session_type 是本地确定性派生列（enrich 按 staffId 数字判别），不进主键（红线 1 推论）。
  // ⚠️ PII 列 sensitive: true 按设计稿 §6.5 实测清单（不是按名称模式泛化）：
  // userPhone 4640/4687、userName 4687/4687、userCrmInfo 4520/4687（JSON 字符串 blob，
  // 整体视为敏感）、fromIp/userIpCity 4642/4687、userAddress/userEmail 稀疏。
  // ⚠️ `payload` 列同样是 PII 的**完整副本**（session.txt 全 90 键逐字 JSON）——
  // 不标 sensitive 等于把上面七个单列的保护整个绕开（E 按列脱敏只认标记）。
  // categoryDetail 归一化（" / " → "/"）由 enrich 在落库前完成（列存归一化后的值）。
  {
    name: 'sessions',
    columns: [col('session_id', 'VARCHAR', false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }, true, true),
      col('staffId', 'VARCHAR'),
      // startTime/endTime 经 strOrNull 落库：上游数字被 JSON.stringify 成毫秒数字串。
      colMeta('startTime', 'VARCHAR', { unit: UNIT_EPOCH_MS }),
      colMeta('endTime', 'VARCHAR', { unit: UNIT_EPOCH_MS }),
      colMeta('session_type', 'VARCHAR', {
        observed_enum: ['robot', 'internal', 'human'],
        note: '派生列：按 staffId 数字判别（< -1 robot / == -1 internal / > 0 human；0 不猜，落 null）',
      }),
      col('categoryDetail', 'VARCHAR'),
      col('userPhone', 'VARCHAR', true, true), col('userName', 'VARCHAR', true, true),
      col('userEmail', 'VARCHAR', true, true), col('userAddress', 'VARCHAR', true, true),
      col('fromIp', 'VARCHAR', true, true), col('userIpCity', 'VARCHAR', true, true),
      col('userCrmInfo', 'VARCHAR', true, true),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['session_id'],
    grain: '每个会话一行（含机器人/人工/内部会话）',
    // 查询语义 = 会话开始时间；与同步水位的 endTime 不同（水位用 endTime 是因为导出按 endTime 过滤）。
    timeColumn: { name: 'startTime', kind: 'epoch-ms' },
  },
  // —— D：知识库表批次（迁移 v8 建；设计稿 §10.5 实测字段普查，spec §5.4）——
  // knowledge_items 是**全部机器人的并集**（robot.data.knowledge 企业级全量），
  // knowledge_categories **按 robotId 隔离**（ai.knowledge.getCategoryTree）——
  // 两个接口语义不同，主键形态随之分叉：items/points=各自 id（groupId 全局唯一但
  // 主键保持上游业务键 id，红线 1）；categories 必须 (robot_id, category_id)
  //（类目 id 空间按机器人划分，单列主键会让跨机器人同名类目互相覆盖，§10.5.9）。
  // 与报表/工单批次同一取舍：业务字段整体收敛进 payload JSON 字符串列（items 实测 22 键、
  // 文档只列 16 键——未文档化的 groupId/robotId/robotName 是承重字段，以键列提升保护），
  // 键列保证 JOIN 与红线 1。无 PII 列（知识库域字段与会话/工单 PII 清单零交集）。
  {
    name: 'knowledge_items',
    columns: [col('id', 'VARCHAR', false), col('robot_id', 'VARCHAR', false),
      col('robot_name', 'VARCHAR'),
      // 设计稿 §10.5 实测：1 = 知识点（标准问）、10 = 相似问（answer 恒空）。
      colMeta('type', 'INTEGER', { observed_enum: [1, 10] }),
      col('group_id', 'VARCHAR', false),
      col('ref_id', 'VARCHAR', false), col('point_id', 'VARCHAR'),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }), col('synchronized_at', 'VARCHAR')],
    primaryKey: ['id'],
    grain: '每个知识库条目一行（含相似问）',
  },
  {
    // kpoint 实测 309/309 全字段存在且**无 robotId 键**（无法从 kpoint 反查机器人归属，
    // 只能经 knowledge_items.point_id 反向推断，§10.5.7）——不建 robot_id 列。
    name: 'knowledge_points',
    columns: [col('id', 'VARCHAR', false),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['id'],
    grain: '每个知识点一行',
  },
  {
    name: 'knowledge_categories',
    columns: [col('robot_id', 'VARCHAR', false), col('category_id', 'VARCHAR', false),
      col('name', 'VARCHAR'), col('parent_id', 'VARCHAR'), col('level', 'INTEGER'),
      colMeta('payload', 'VARCHAR', { unit: UNIT_JSON }),
      col('synchronized_at', 'VARCHAR')],
    primaryKey: ['robot_id', 'category_id'],
    grain: '每个「机器人 × 分类」一行',
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
  // D-T10 迁移：sessions 表（键列 + payload 收敛 + session_type 派生列 + PII 敏感列）。
  {
    version: 7,
    up: async (exec) => {
      await exec(ddlFor(tableByName('sessions')!))
    },
  },
  // D-T11 迁移：知识库 3 表（knowledge_items/knowledge_points/knowledge_categories）。
  {
    version: 8,
    up: async (exec) => {
      for (const name of ['knowledge_items', 'knowledge_points', 'knowledge_categories']) {
        await exec(ddlFor(tableByName(name)!))
      }
    },
  },
  // 修复批 2 迁移（G2 义务，spec §八.2/§十一.17）：sync_state 补
  // resolved_range_start/resolved_range_end 两列（上次成功推进覆盖的区间）。
  // 函数式 ALTER + IF NOT EXISTS（与 v2/v4 同款幂等：新库 v1 建表时 TABLES 已含这两列，
  // v1 + v9 连放不炸）。编号说明：v2/v3-v8 的实际占用见 spec §八 —— 本批顺延到 v9。
  {
    version: 9,
    up: async (exec) => {
      await exec('ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "resolved_range_start" VARCHAR')
      await exec('ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "resolved_range_end" VARCHAR')
    },
  },
]

// ⚠️ E 交付后仍无命令层调用方（`db describe` 展示的是 `TABLES` 的列定义，不是迁移版本号）；
// 现由 `tests/store/schema.test.ts` 与迁移一致性断言消费。保留导出（L2）。
export const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0)
