// src/sync/tasks/dim.ts
// D-T6：维度表快照任务（6 任务；tags 已在 v1 建表且其同步语义与维度表同构，
// 归属 T12 汇总时一并声明）。全部 kind=snapshot：接口全量无分页（设计稿 §6.2
// 实测），幂等来自「全删重插」。fetch 内部经 http.call + 信封归一化——sync 不绕过信封层。
// 落库行按 TABLES 列集显式投影（缺列补 null）——响应多出的键不进库，缺的键不炸 upsert。
import { call } from '../../core/http.js'
import { byId } from '../../core/registry/index.js'
import { nowIsoOf } from './pace.js'
import type { SyncTask, FetchResult, FetchCtx, WindowRef } from '../types.js'

/** 信封归一化结果 → 行数组；payload 不是数组视为响应形态漂移，显式失败。 */
function rowsOf(res: { payload: unknown }, endpointId: string): Record<string, unknown>[] {
  if (!Array.isArray(res.payload)) {
    throw new Error(`接口 ${endpointId} 返回的载荷不是数组（响应形态漂移？），拒绝落库`)
  }
  return res.payload as Record<string, unknown>[]
}

/**
 * 按列集投影：只保留 cols 里的键（缺列补 null），值统一字符串化——
 * 上游 ID/整型在响应里是 number，表列是 VARCHAR（BIGINT 精度红线）。
 */
function project(rows: Record<string, unknown>[], cols: string[],
  nowIso: string, perRow?: (r: Record<string, unknown>) => Record<string, unknown> | null,
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const raw of rows) {
    const mid = perRow ? perRow(raw) : raw
    if (mid === null) continue
    const row: Record<string, unknown> = {}
    for (const c of cols) {
      const v = mid[c]
      row[c] = v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v)
    }
    row.synchronized_at = nowIso
    out.push(row)
  }
  return out
}

/** 维度快照任务的通用 fetch：调接口 → 行数组 → 投影直写（写侧引擎全删重插）。 */
async function fetchAll(endpointId: string, body: unknown, cols: string[],
  ctx: FetchCtx, nowIso: string,
  perRow?: (row: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<FetchResult> {
  const res = await call(byId(endpointId), body, { credentials: ctx.credentials })
  const rows = project(rowsOf(res, endpointId), cols, nowIso, perRow)
  return { rows, apiCount: rows.length }
}

// 列集常量（与 schema.ts TABLES 对齐；漂移由 schema drift 对拍测试拦）
const STAFF_COLS = ['id', 'realname', 'nickname', 'username', 'role', 'roleId', 'status',
  'createtime', 'updateTime', 'email', 'phone', 'workNumber', 'maxServiceCount',
  'skillScoreChat', 'skillScoreIpcc', 'groupInfo']
const STAFF_GROUP_COLS = ['id', 'name']
const CATEGORY_COLS = ['id', 'name', 'parentId', 'rank']
const TEMPLATE_COLS = ['id', 'name', 'createTime', 'autoFlow', 'autoStatus', 'fileStatus', 'autoGuide']
const FIELD_COLS = ['fieldId', 'id', 'name', 'type', 'required', 'customer', 'description', 'prefill']

export const DIM_TASKS: SyncTask[] = [
  {
    id: 'dim.staff', table: 'staff', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['id'],
    write: { kind: 'upsertRows' },
    // role 文档标必填但实测 status/role 都省略时返回全部 330 行（§6.2）——不传，取全量。
    // groupInfo 列表 → JSON 字符串列（project 统一 JSON.stringify，非字符串值均适用）。
    fetch: (w, ctx) =>
      fetchAll('staff.list.new', {}, STAFF_COLS, ctx, nowIsoOf(ctx)),
  },
  {
    id: 'dim.staff_groups', table: 'staff_groups', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['id'],
    write: { kind: 'upsertRows' },
    // staff:true 取 staffIdList（成员关系单独落 staff_group_members，本表不存）。
    fetch: (w, ctx) =>
      fetchAll('staff.group.list.new', { staff: true }, STAFF_GROUP_COLS, ctx, nowIsoOf(ctx)),
  },
  {
    id: 'dim.staff_group_members', table: 'staff_group_members', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['group_id', 'staff_id'],
    write: { kind: 'upsertRows' },
    // 权威来源是 staff.group.list?staff=true 的 staffIdList（含组管理员）；
    // 不用 staff.group.members 接口（实测 9/33 组缺人）。
    fetch: async (w, ctx) => {
      void w
      const nowIso = nowIsoOf(ctx)
      const res = await call(byId('staff.group.list.new'), { staff: true },
        { credentials: ctx.credentials })
      const groups = rowsOf(res, 'staff.group.list.new')
      const out: Record<string, unknown>[] = []
      for (const g of groups) {
        const list = g.staffIdList
        if (!Array.isArray(list)) continue
        for (const sid of list) {
          out.push({ group_id: String(g.id), staff_id: String(sid), synchronized_at: nowIso })
        }
      }
      return { rows: out, apiCount: out.length }
    },
  },
  {
    id: 'dim.ticket_categories', table: 'ticket_categories', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['id'],
    write: { kind: 'upsertRows' },
    // 文档标 type 必填（2=工单分类）；响应列名是 parentId，落库保持原名。
    fetch: (w, ctx) =>
      fetchAll('category.list', { type: 2 }, CATEGORY_COLS, ctx, nowIsoOf(ctx)),
  },
  {
    id: 'dim.ticket_templates', table: 'ticket_templates', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['id'],
    write: { kind: 'upsertRows' },
    // 文档标 status 必填（-1=全部状态）；响应 status 全为 1、不携带信息 → 不建列。
    fetch: (w, ctx) =>
      fetchAll('ticket.template.list', { status: -1 }, TEMPLATE_COLS, ctx, nowIsoOf(ctx)),
  },
  {
    id: 'dim.ticket_template_fields', table: 'ticket_template_fields', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['template_id', 'fieldId'],
    write: { kind: 'upsertRows' },
    // 每模板一次调用（接口按 templateId 取字段）；行补 template_id 列（主键 template_id+fieldId，fieldId 是响应键）。
    fetch: async (w, ctx) => {
      void w
      const nowIso = nowIsoOf(ctx)
      const tres = await call(byId('ticket.template.list'), { status: -1 },
        { credentials: ctx.credentials })
      const templates = rowsOf(tres, 'ticket.template.list')
      const out: Record<string, unknown>[] = []
      for (const t of templates) {
        const fres = await call(byId('ticket.template.fields'), { templateId: t.id },
          { credentials: ctx.credentials })
        const rows = project(rowsOf(fres, 'ticket.template.fields'), FIELD_COLS, nowIso)
        for (const row of rows) out.push({ ...row, template_id: String(t.id) })
      }
      return { rows: out, apiCount: out.length }
    },
  },
]

/** 按 id 取维度任务（T12 汇总与测试的取用形态）。 */
export function taskById(id: string): SyncTask | undefined {
  return DIM_TASKS.find((t) => t.id === id)
}
