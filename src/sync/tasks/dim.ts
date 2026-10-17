// src/sync/tasks/dim.ts
// D-T6：维度表快照任务（6 任务；tags 已在 v1 建表且其同步语义与维度表同构，
// 归属 T12 汇总时一并声明）。全部 kind=snapshot：接口全量无分页（设计稿 §6.2
// 实测），幂等来自「全删重插」。fetch 内部经 http.call + 信封归一化——sync 不绕过信封层。
// 落库行按 TABLES 列集显式投影（缺列补 null）——响应多出的键不进库，缺的键不炸 upsert。
//
// 全场景审查（修复批 1）在本文件收敛的语义：
//   · B 高-1：**全部**取数走 callPaced（此前 fetchAll/两个内联 fetch 都是裸 call）——
//     裸 call 让本地令牌桶的拒绝冒泡成 fetch_failed gap，且远端限频的冷却行无人写；
//     声明 endpoint 后闸门键与注册表路径同源（B 中-6）。
//   · C 中-14：staffIdList 非数组不再静默 `continue` —— 显式跳过并记 gapHint（见下）。
//   · C 低-7：空串主键行拒绝（`''` 会写进 VARCHAR 主键列并反复覆盖同键）。
import { callPaced, nowIsoOf } from './pace.js'
import type { SyncTask, FetchResult, FetchCtx, WindowRef } from '../types.js'

/** 信封归一化结果 → 行数组；payload 不是数组视为响应形态漂移，显式失败。 */
function rowsOf(res: { payload: unknown }, endpointId: string): Record<string, unknown>[] {
  if (!Array.isArray(res.payload)) {
    throw new Error(`接口 ${endpointId} 返回的载荷不是数组（响应形态漂移？），拒绝落库`)
  }
  return res.payload as Record<string, unknown>[]
}

/** 空串主键拒绝（C 低-7）：`''` 会写进 VARCHAR 主键列，且空串行还能反复覆盖同键。 */
const isEmptyKey = (v: unknown): boolean => v === null || v === undefined || v === ''

/**
 * 按列集投影：只保留 cols 里的键（缺列补 null），值统一字符串化——
 * 上游 ID/整型在响应里是 number，表列是 VARCHAR（BIGINT 精度红线）。
 * `keyCols`（C 低-7）：落库主键列 —— 值为空串的行**显式失败**，绝不因 `''` 写出一行
 * 能被反复覆盖的同键行（空串是合法的 VARCHAR 值，upsert 主键语义会把它们当成同一个键）。
 * 只有 cols 里出现的键列才在这里判定（如 template_id 由行外补齐，由调用方自行守卫）。
 */
function project(rows: Record<string, unknown>[], cols: string[],
  nowIso: string, perRow?: (r: Record<string, unknown>) => Record<string, unknown> | null,
  keyCols: string[] = [],
): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const raw of rows) {
    const mid = perRow ? perRow(raw) : raw
    if (mid === null) continue
    const row: Record<string, unknown> = {}
    for (const c of cols) {
      const v = mid[c]
      if (isEmptyKey(v) && keyCols.includes(c)) {
        throw new Error(`响应出现空的主键列 ${c}（值为 ${JSON.stringify(v)}）——` +
          '空串/缺键会写出一行能被反复覆盖的同键行，拒绝落库')
      }
      row[c] = v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v)
    }
    row.synchronized_at = nowIso
    out.push(row)
  }
  return out
}

/** 维度快照任务的通用 fetch：callPaced 调接口 → 行数组 → 投影直写（写侧引擎全删重插）。
 * ⚠️ 走 callPaced（B 高-1）：本地令牌桶拒绝被吸收为等待重试，远端限频写持久化冷却行。 */
async function fetchAll(endpointId: string, body: unknown, cols: string[],
  ctx: FetchCtx, nowIso: string,
  perRow?: (row: Record<string, unknown>) => Record<string, unknown> | null,
  keyCols: string[] = [],
): Promise<FetchResult> {
  const res = await callPaced(endpointId, body, ctx)
  const rows = project(rowsOf(res, endpointId), cols, nowIso, perRow, keyCols)
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
    endpoint: 'staff.list.new',
    write: { kind: 'upsertRows' },
    // role 文档标必填但实测 status/role 都省略时返回全部 330 行（§6.2）——不传，取全量。
    // groupInfo 列表 → JSON 字符串列（project 统一 JSON.stringify，非字符串值均适用）。
    fetch: (w, ctx) =>
      fetchAll('staff.list.new', {}, STAFF_COLS, ctx, nowIsoOf(ctx), undefined, ['id']),
  },
  {
    id: 'dim.staff_groups', table: 'staff_groups', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['id'],
    endpoint: 'staff.group.list.new',
    write: { kind: 'upsertRows' },
    // staff:true 取 staffIdList（成员关系单独落 staff_group_members，本表不存）。
    fetch: (w, ctx) =>
      fetchAll('staff.group.list.new', { staff: true }, STAFF_GROUP_COLS, ctx, nowIsoOf(ctx),
        undefined, ['id']),
  },
  {
    id: 'dim.staff_group_members', table: 'staff_group_members', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['group_id', 'staff_id'],
    endpoint: 'staff.group.list.new',
    write: { kind: 'upsertRows' },
    // 权威来源是 staff.group.list?staff=true 的 staffIdList（含组管理员）；
    // 不用 staff.group.members 接口（实测 9/33 组缺人）。
    // C 中-14：staffIdList 不是数组时**不再静默 continue**（那一组的成员会无声消失，
    // 而快照是全量重建——消失的成员没有任何痕迹）。改为：跳过该组 + 记 gapHint
    //（引擎落 sync_gaps，reason 自陈），组 id 缺失/空串则显式失败（主键无法归属）。
    fetch: async (w, ctx) => {
      void w
      const nowIso = nowIsoOf(ctx)
      const res = await callPaced('staff.group.list.new', { staff: true }, ctx)
      const groups = rowsOf(res, 'staff.group.list.new')
      const out: Record<string, unknown>[] = []
      const malformed: string[] = []
      let skippedMembers = 0
      for (const g of groups) {
        if (isEmptyKey(g.id)) {
          throw new Error('接口 staff.group.list.new 返回了缺 id 的组——' +
            'staff_group_members 主键 (group_id, staff_id) 无法归属，拒绝落库')
        }
        const gid = String(g.id)
        const list = g.staffIdList
        if (!Array.isArray(list)) {
          // 显式跳过并记缺口：`staff:true` 下实测每组都有该键（§6.2）→ 非数组即形态漂移。
          malformed.push(gid)
          continue
        }
        for (const sid of list) {
          if (isEmptyKey(sid)) { skippedMembers++; continue }   // 空成员 id：无主键可写
          out.push({ group_id: gid, staff_id: String(sid), synchronized_at: nowIso })
        }
      }
      const gapHint = (malformed.length > 0 || skippedMembers > 0)
        ? {
          reason: 'staff_id_list_malformed',
          detail: `staffIdList 形态不符：${malformed.length} 个组（${malformed.slice(0, 5).join(',')}）` +
            `的 staffIdList 不是数组、${skippedMembers} 个成员 id 为空——这些成员未落库，` +
            '请核对上游响应形态',
        }
        : undefined
      return { rows: out, apiCount: out.length, ...(gapHint ? { gapHint } : {}) }
    },
  },
  {
    id: 'dim.ticket_categories', table: 'ticket_categories', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['id'],
    endpoint: 'category.list',
    write: { kind: 'upsertRows' },
    // 文档标 type 必填（2=工单分类）；响应列名是 parentId，落库保持原名。
    fetch: (w, ctx) =>
      fetchAll('category.list', { type: 2 }, CATEGORY_COLS, ctx, nowIsoOf(ctx), undefined, ['id']),
  },
  {
    id: 'dim.ticket_templates', table: 'ticket_templates', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['id'],
    endpoint: 'ticket.template.list',
    write: { kind: 'upsertRows' },
    // 文档标 status 必填（-1=全部状态）；响应 status 全为 1、不携带信息 → 不建列。
    fetch: (w, ctx) =>
      fetchAll('ticket.template.list', { status: -1 }, TEMPLATE_COLS, ctx, nowIsoOf(ctx),
        undefined, ['id']),
  },
  {
    id: 'dim.ticket_template_fields', table: 'ticket_template_fields', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['template_id', 'fieldId'],
    endpoint: 'ticket.template.fields',
    write: { kind: 'upsertRows' },
    // 每模板一次调用（接口按 templateId 取字段）；行补 template_id 列（主键 template_id+fieldId，fieldId 是响应键）。
    // 闸门键取 ticket.template.fields（该任务的主要调用路径）；templates 列表的
    // ticket.template.list 也走 callPaced，同路径任务共享冷却（B 中-6 的路径口径）。
    fetch: async (w, ctx) => {
      void w
      const nowIso = nowIsoOf(ctx)
      const tres = await callPaced('ticket.template.list', { status: -1 }, ctx)
      const templates = rowsOf(tres, 'ticket.template.list')
      const out: Record<string, unknown>[] = []
      for (const t of templates) {
        if (isEmptyKey(t.id)) {
          throw new Error('接口 ticket.template.list 返回了缺 id 的模板——' +
            'ticket_template_fields 的 template_id 无法归属，拒绝落库')
        }
        const fres = await callPaced('ticket.template.fields', { templateId: t.id }, ctx)
        // 主键列 fieldId 的空值在 project 内显式失败（C 低-7）
        const rows = project(rowsOf(fres, 'ticket.template.fields'), FIELD_COLS, nowIso,
          undefined, ['fieldId'])
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
