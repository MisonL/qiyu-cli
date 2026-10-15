// src/sync/tasks/reports.ts
// D-T7：9 报表任务声明（spec §5.2）+ 按天轮转标记。
// 全部 kind=windowed、deleteRangeInsert(stat_date)、reportDayRotation=true。
// 日期一律由调用方按窗口填写（响应内 date 逐接口语义不同——统一不信）；
// 窗口上限按实测逐接口注册（§7.4.1：严格形式 span ≤ N 天对两族判定式都安全）。
// 业务字段收敛进 payload JSON 字符串列（表设计见 schema.ts 报表批次注释）。
import { call } from '../../core/http.js'
import { byId } from '../../core/registry/index.js'
import { callPaced, nowIsoOf } from './pace.js'
import type { Store } from '../../store/types.js'
import type { SyncTask, FetchResult, FetchCtx, WindowRef } from '../types.js'

/** 窗口起止的 ISO（与引擎 deleteRangeInsert 的范围值同形——T5 验收项）。 */
const isoOf = (ms: number): string => new Date(ms).toISOString()

/** 测试注入点收敛至共享 pace.ts（中-1）：reports/knowledge/tickets 共用同一 sleep。 */
export { __setSleep } from './pace.js'

/** 通用窗口请求体：startTime/endTime 恒为毫秒（传秒会静默降级）。 */
function timeBody(w: WindowRef): Record<string, unknown> {
  return { startTime: w.start, endTime: w.end }
}

/**
 * 各报表的请求体构造（导出供测试对拍——http mock 只见 URL，body 事实在签名里）。
 * 特殊规则：考勤恒含 startTime（防天粒度静默降级）；robot_summary/transfer_human
 * 忽略的参数（robotId/type）绝不透传。
 */
export function reportBody(taskId: string, w: WindowRef): Record<string, unknown> {
  switch (taskId) {
    case 'reports.staff_attendance':
      // 显式传 startTime（哪怕请求体其余为空）——省略它服务端不报错但静默切换天粒度
      return { ...timeBody(w), pageSize: 1000 }
    case 'reports.staff_workload':
    case 'reports.staff_quality':
    case 'reports.staff_satisfaction':
    case 'reports.overview':
      return { ...timeBody(w), pageSize: 1000 }
    case 'reports.order_performance':
      // 空结果集 page>1 会 14500（§5.2）——分页循环只在首页拉满且 total 更大时才进下一页
      return { ...timeBody(w), pageSize: 1000 }
    case 'reports.staff_salary_detail':
      // 单 staffId 由 fetch 按 staff 表逐客服注入（见 salaryDetail 任务）；此处仅时间
      return { startTime: w.start, endTime: w.end }
    case 'reports.robot_summary':
    case 'reports.transfer_human':
      // 只传时间对：robotId/type 被服务端忽略，透传只会误导调用方（契约诚实性）
      return timeBody(w)
    default:
      throw new Error(`未知报表任务：${taskId}`)
  }
}

/**
 * 载荷 → 行数组（逐接口信封实测：C 族载荷是 message 解析物；robot_summary/
 * transfer_human 是形状 A、载荷在 data）。识别已知包装键（result/orders），
 * 其余对象形态视为「一行全局汇总」（overview 69 字段/summary 27 字段/transfer 恒 1 行）。
 */
function payloadRows(taskId: string, payload: unknown): { rows: Record<string, unknown>[]; sum: Record<string, unknown> | null } {
  if (payload === null || payload === undefined) return { rows: [], sum: null }
  if (Array.isArray(payload)) return { rows: payload as Record<string, unknown>[], sum: null }
  const o = payload as Record<string, unknown>
  // statistic.performance 的全 null 形态（orders:null/sum:null/total:null，code:200）
  // 是筛选失败（staffIdList 含租户不存在的 id），不是空窗口——fetch 层抛带 kind 的
  // 形态错误，引擎记 sync_gaps（reason=filter_matched_no_staff，T5 裁定透传）。
  if (o.orders === null) {
    const e = new Error('statistic.performance 返回 orders:null——筛选条件未匹配到任何客服（非空窗口）') as Error & { kind?: string }
    e.kind = 'filter_matched_no_staff'
    throw e
  }
  // staffquality 的 sum 与分页无关、覆盖全集 → 与分页行一起返回，由 fetch 编为全局行
  if (Array.isArray(o.result)) return { rows: o.result as Record<string, unknown>[], sum: (o.sum as Record<string, unknown>) ?? null }
  if (Array.isArray(o.orders)) return { rows: o.orders as Record<string, unknown>[], sum: (o.sum as Record<string, unknown>) ?? null }
  return { rows: [o], sum: null }
}

function rowsOfPayload(taskId: string, res: { payload: unknown }): Record<string, unknown>[] {
  return payloadRows(taskId, res.payload).rows
}

/** per-staff 行投影：staff_id 键缺失 → null（丢弃——脏单行不致断流的取舍，见 task-7-report）。 */
function staffRow(w: WindowRef, r: Record<string, unknown>, nowIso: string): Record<string, unknown> | null {
  const sid = r.staffId ?? r.staffid ?? r.staff_id
  if (sid === null || sid === undefined) return null
  return { ...baseRow(w, r, nowIso), staff_id: String(sid) }
}

/** 分页 + per-staff 投影（staffworklod / staff_satisfaction）。 */
async function fetchPagedStaff(taskId: string, w: WindowRef, ctx: FetchCtx): Promise<FetchResult> {
  const nowIso = nowIsoOf(ctx)
  const { rows } = await pagedRaw(taskId, w, ctx)
  const mapped = rows
    .map((r) => staffRow(w, r, nowIso))
    .filter((r): r is Record<string, unknown> => r !== null)
  return { rows: mapped, apiCount: mapped.length }
}

/** stat_date + payload 的通用行投影（键列由各任务补齐）。 */
function baseRow(w: WindowRef, src: Record<string, unknown>, nowIso: string): Record<string, unknown> {
  return { stat_date: isoOf(w.start), payload: JSON.stringify(src), synchronized_at: nowIso }
}

/**
 * 分页拉取原始行（result/orders 包装族：staffworklod/satisfaction/staffAttendance/
 * performance）。page 从 1 起、pageSize=1000，total 收敛翻页（total 缺省视为单页）。
 */
async function pagedRaw(taskId: string, w: WindowRef, ctx: FetchCtx): Promise<{
  rows: Record<string, unknown>[]; sum: Record<string, unknown> | null
}> {
  const out: Record<string, unknown>[] = []
  let sum: Record<string, unknown> | null = null
  let page = 1
  for (;;) {
    const body = { ...reportBody(taskId, w), page }
    const res = await callPaced(endpointOf(taskId), body, ctx, taskId)
    const { rows, sum: s } = payloadRows(taskId, res.payload)
    if (s) sum = s
    out.push(...rows)
    // total 与已取行数收敛即停（total 缺省视为单页）
    const total = (res.payload as { total?: unknown } | null)?.total
    if (typeof total !== 'number' || out.length >= total || rows.length === 0) break
    page++
  }
  return { rows: out, sum }
}

/** 任务 id → 注册表 endpoint id。 */
function endpointOf(taskId: string): string {
  switch (taskId) {
    case 'reports.overview': return 'statistic.overview'
    case 'reports.staff_workload': return 'statistic.staffworklod'
    case 'reports.staff_quality': return 'statistic.staffquality'
    case 'reports.staff_satisfaction': return 'statistic.satisfaction.report'
    case 'reports.staff_attendance': return 'statistic.staffAttendance'
    case 'reports.order_performance': return 'statistic.performance'
    case 'reports.staff_salary_detail': return 'statistic.salaryDetail'
    case 'reports.robot_summary': return 'robot.statistic.summary'
    case 'reports.transfer_human': return 'ai.statistic.transferHuman'
    default: throw new Error(`未知报表任务：${taskId}`)
  }
}

/** 普通报表 fetch（result/全局行形态）：stat_date=窗口起点 ISO；staffId 键取不到时用 'sum' 哨兵。 */
function fetchSimple(taskId: string, perStaff: boolean): SyncTask['fetch'] {
  return async (w, ctx) => {
    const nowIso = nowIsoOf(ctx)
    const res = await call(byId(endpointOf(taskId)), reportBody(taskId, w),
      { credentials: ctx.credentials })
    const { rows, sum } = payloadRows(taskId, res.payload)
    const mapped: Record<string, unknown>[] = []
    for (const r of rows) {
      // perStaff 表（staff_workload/quality/satisfaction）键是 (stat_date, staff_id)；
      // 全局汇总表（overview/robot_summary/transfer_human）键只有 stat_date——
      // 响应没有 staffId，行形状按目标表列集投影。
      const base = baseRow(w, r, nowIso)
      if (perStaff) {
        const sid = r.staffId ?? r.staffid ?? r.staff_id
        if (sid === null || sid === undefined) continue   // 键缺失行：计入 fetched 不写库
        mapped.push({ ...base, staff_id: String(sid) })
      } else {
        mapped.push(base)
      }
    }
    // staffquality 全局 sum 行（覆盖全集、与分页无关）：sum 本就没有 staff_id，
    // 落 perStaff 表时用上游无语义的哨兵 'sum'（约定位置，见 task-7-report）。
    if (sum && perStaff) mapped.push({ ...baseRow(w, sum, nowIso), staff_id: 'sum' })
    return { rows: mapped, apiCount: mapped.length }
  }
}

/** staff 表客服 id 列表（salaryDetail 的驱动序：每客服一次调用）。 */
async function staffIds(store: Store): Promise<string[]> {
  const r = await store.query('SELECT id FROM staff ORDER BY id')
  return r.rows.map((x) => String(x.id))
}

export const REPORT_TASKS: SyncTask[] = [
  {
    id: 'reports.overview', table: 'daily_overview', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date'], reportDayRotation: true,
    write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] },
    fetch: fetchSimple('reports.overview', false),
  },
  {
    id: 'reports.staff_workload', table: 'staff_workload', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date', 'staff_id'], reportDayRotation: true,
    write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] },
    // 响应 date 恒 0 → stat_date 只能用窗口起点（调用方填写）
    fetch: (w, ctx) => fetchPagedStaff('reports.staff_workload', w, ctx),
  },
  {
    id: 'reports.staff_quality', table: 'staff_quality', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date', 'staff_id'], reportDayRotation: true,
    write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] },
    fetch: fetchSimple('reports.staff_quality', true),
  },
  {
    id: 'reports.staff_satisfaction', table: 'staff_satisfaction', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date', 'staff_id'], reportDayRotation: true,
    write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] },
    fetch: (w, ctx) => fetchPagedStaff('reports.staff_satisfaction', w, ctx),
  },
  {
    id: 'reports.staff_attendance', table: 'staff_attendance', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    // hour_ts 是响应内唯一可信日期字段（小时对齐时间戳）
    primaryKey: ['staff_id', 'hour_ts'], reportDayRotation: true,
    write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] },
    // ⚠️ 请求体恒含 startTime（reportBody 已保证）——省略会静默降级为天粒度、少抓 ~10 倍。
    // 分页 total 收敛拉满（单页 pageSize=1000，31d 实测 17765 行 → 两页），再抽 hour_ts。
    fetch: async (w, ctx) => {
      const nowIso = nowIsoOf(ctx)
      const { rows } = await pagedRaw('reports.staff_attendance', w, ctx)
      const mapped: Record<string, unknown>[] = []
      for (const r of rows) {
        const sid = r.staffId ?? r.staffid
        const ts = r.date   // 该小时按小时对齐的时间戳
        if (sid === null || sid === undefined || ts === null || ts === undefined) continue
        mapped.push({ ...baseRow(w, r, nowIso), staff_id: String(sid), hour_ts: isoOf(Number(ts)) })
      }
      return { rows: mapped, apiCount: mapped.length }
    },
  },
  {
    id: 'reports.order_performance', table: 'order_performance', kind: 'windowed',
    maxWindowDays: 365, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['order_id'], reportDayRotation: true,
    write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] },
    // orders:null = 筛选失败、不是空窗口（staffIdList 含租户不存在的 id 时 code:200
    // 全 null）→ 显式 gapHint，引擎落 sync_gaps（T5 裁定：透传原始 reason）。
    // 行映射补主键列 order_id（响应键 orderId）；缺 order_id 的订单行丢弃——
    // 计入 fetched 不写库（脏单行不致断流，与 per-staff 表同一取舍）；
    // sum 全局行按 controller 裁定落同表哨兵 order_id='sum'（与 staff_quality 一致）。
    fetch: async (w, ctx) => {
      try {
        const nowIso = nowIsoOf(ctx)
        const { rows, sum } = await pagedRaw('reports.order_performance', w, ctx)
        const mapped: Record<string, unknown>[] = []
        for (const r of rows) {
          const oid = r.orderId ?? r.order_id
          if (oid === null || oid === undefined) continue
          mapped.push({ ...baseRow(w, r, nowIso), order_id: String(oid) })
        }
        if (sum) mapped.push({ ...baseRow(w, sum, nowIso), order_id: 'sum' })
        return { rows: mapped, apiCount: mapped.length }
      } catch (e) {
        if ((e as { kind?: string }).kind === 'filter_matched_no_staff') {
          return { rows: [], apiCount: 0,
            gapHint: { reason: 'filter_matched_no_staff', detail: (e as Error).message } }
        }
        throw e
      }
    },
  },
  {
    id: 'reports.staff_salary_detail', table: 'staff_salary_detail', kind: 'windowed',
    // 只覆盖窗口起始日 → 窗口切 1 天（每窗 = 一天的「客服 × 起始日」驱动）
    maxWindowDays: 1, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['staff_id', 'work_date'], reportDayRotation: true,
    write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] },
    // ⚠️ 必须传单个 staffId（省略 14004、传数组不识别）→ 按 staff 表逐客服驱动；
    // staff 表为空是任务序错误（先跑 dim.staff），显式失败而非静默空跑。
    fetch: async (w, ctx) => {
      void w
      const ids = await staffIds(ctx.store)
      if (ids.length === 0) {
        throw new Error('staff 表为空：staff_salary_detail 按客服驱动，请先同步 dim.staff 任务')
      }
      const nowIso = nowIsoOf(ctx)
      const out: Record<string, unknown>[] = []
      for (const sid of ids) {
        const body = { ...reportBody('reports.staff_salary_detail', w), staffId: Number(sid) }
        const res = await callPaced(endpointOf('reports.staff_salary_detail'), body, ctx,
          'reports.staff_salary_detail')
        const { rows, sum } = payloadRows('reports.staff_salary_detail', res.payload)
        for (const r of rows) {
          out.push({ ...baseRow(w, r, nowIso), staff_id: sid, work_date: isoOf(w.start) })
        }
        if (sum) out.push({ ...baseRow(w, sum, nowIso), staff_id: sid, work_date: isoOf(w.start) })
      }
      return { rows: out, apiCount: out.length }
    },
  },
  {
    id: 'reports.robot_summary', table: 'robot_summary', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date'], reportDayRotation: true,
    write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] },
    // 形状 A；robotId 被服务端忽略 → body 不含（reportBody 保证）
    fetch: fetchSimple('reports.robot_summary', false),
  },
  {
    id: 'reports.transfer_human', table: 'transfer_human', kind: 'windowed',
    maxWindowDays: 365, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date'], reportDayRotation: true,
    write: { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'] },
    // 形状 A；type/robotId 被服务端忽略 → body 不含（reportBody 保证）
    fetch: fetchSimple('reports.transfer_human', false),
  },
]

/** 按 id 取报表任务（T12 汇总与测试的取用形态）。 */
export function taskById(id: string): SyncTask | undefined {
  return REPORT_TASKS.find((t) => t.id === id)
}
