// src/sync/tasks/reports.ts
// D-T7：9 报表任务声明（spec §5.2）+ 按天轮转标记。
// 全部 kind=windowed、deleteRangeInsert(stat_date)、reportDayRotation=true。
// 日期一律由调用方按窗口填写（响应内 date 逐接口语义不同——统一不信）；
// 窗口上限按实测逐接口注册（§7.4.1：严格形式 span ≤ N 天对两族判定式都安全）。
// 业务字段收敛进 payload JSON 字符串列（表设计见 schema.ts 报表批次注释）。
//
// 全场景审查（修复批 1）在本文件收敛的语义：
//   · B 高-1：**所有**调用走 callPaced（含 penalize 接线）——裸 call 会让本地令牌桶的
//     拒绝直接冒泡成 fetch_failed gap，且远端限频的证据（冷却行）无人写；空窗假空重试
//     必然二次调用同路径，是最容易撞上的一条路径；
//   · A 中-2：日期列（stat_date/work_date）按 **Asia/Shanghai 天对齐**，与
//     deleteRangeInsert 的删除边界同口径（rangeAlign='shanghaiDay'）——否则 --full
//     与增量对同一业务日落在互不覆盖的删除范围里，同日写出两行；
//   · G 中-2：transferHuman 的窗口上限 365 → 360（实测恰好 365 天被拒、364 天也会
//     报 Internal error，设计稿 §13 建议 ≤360）；
//   · G 高-1：attendance/performance 声明 windowEndClamp（endTime 不得晚于昨天 0:00）；
//   · C 中-5：载荷为 null 不再当合法空窗（形状漂移必须显式失败）；
//   · C 中-3：分页短读终检（total 与累计行数核对）+ 页数上限（对齐 knowledge 口径）；
//   · C 中-4：staff_attendance 的脏时间戳逐行丢弃，不再抛 RangeError 断整窗；
//   · C 低-7：空串主键行拒绝。
import { callPaced, nowIsoOf } from './pace.js'
import { shanghaiDayIso } from '../day.js'
import type { Store } from '../../store/types.js'
import type { SyncTask, FetchResult, FetchCtx, WindowRef } from '../types.js'

/** 测试注入点收敛至共享 pace.ts（中-1）：reports/knowledge/tickets 共用同一 sleep。 */
export { __setSleep } from './pace.js'

/** 分页页数上限（C 中-3，与 knowledge.pagedCursor 同口径）：声明 total 已知时
 * ceil(total/pageSize)+5 余量，未知时保守 1000 页——「total 恒大于已取行数」的
 * 响应形态漂移在有限次调用后显式失败，绝不无限翻页。 */
const MAX_PAGES_FALLBACK = 1000
const PAGE_SIZE = 1000

/** 通用窗口请求体：startTime/endTime 恒为毫秒（传秒会静默降级）。 */
function timeBody(w: WindowRef): Record<string, unknown> {
  return { startTime: w.start, endTime: w.end }
}

/**
 * 各报表的请求体构造（导出供测试对拍——http mock 只见 URL，body 事实在签名里）。
 * 特殊规则：考勤恒含 startTime（防天粒度静默降级）；robot_summary/transfer_human
 * 忽略的参数（robotId/type）绝不透传。
 * ⚠️ `stat_date` 的写法不在这里 —— 行内日期列按上海天对齐（见 dayIso），
 * 请求体的时间参数仍是窗口毫秒（服务端按毫秒窗口过滤，天对齐只影响落库键）。
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
  // C 中-5：载荷为 null/undefined 是**形状漂移**（信封层丢 data 键、或上游改了形态），
  // 绝不能当合法空窗 —— 静默按空处理会把整段数据吞成 complete。与同文件 orders:null
  // 的显式 kind 口径一致（那里是业务语义的显式失败，这里是形态语义的显式失败）。
  if (payload === null || payload === undefined) {
    throw new Error(`接口 ${endpointOf(taskId)} 未返回载荷（null/undefined）——响应形态漂移，拒绝按空窗处理`)
  }
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

/** 空串主键拒绝（C 低-7）：`''` 会写进 VARCHAR 主键列，且空串行还能反复覆盖同键。 */
const isEmptyKey = (v: unknown): boolean => v === null || v === undefined || v === ''

/** per-staff 行投影：staff_id 键缺失 → null（丢弃——脏单行不致断流的取舍，见 task-7-report）。 */
function staffRow(w: WindowRef, r: Record<string, unknown>, nowIso: string): Record<string, unknown> | null {
  const sid = r.staffId ?? r.staffid ?? r.staff_id
  if (isEmptyKey(sid)) return null
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

/**
 * stat_date + payload 的通用行投影（键列由各任务补齐）。
 * ⚠️ 日期列按**上海自然日零点**写（A 中-2）：窗口起点是毫秒级（水位+1ms、--since 的
 * 任意时刻），直接写 `isoOf(w.start)` 会让同一业务日在 --full 与增量下得到两个不同的
 * 键值，两行并存。天对齐后同一业务日恒为同一个键，upsert/删除范围都能覆盖它。
 */
function baseRow(w: WindowRef, src: Record<string, unknown>, nowIso: string): Record<string, unknown> {
  return { stat_date: shanghaiDayIso(w.start), payload: JSON.stringify(src), synchronized_at: nowIso }
}

/**
 * 分页拉取原始行（result/orders 包装族：staffworklod/satisfaction/staffAttendance/
 * performance）。page 从 1 起、pageSize=1000，total 收敛翻页（total 缺省视为单页）。
 * 终检（C 中-3）：循环结束必须满足「已取行数 >= 声明 total」——上游声明 100 却返回 0 行
 * 的短读是最危险的静默失败方向（会被当合法空窗，配对核对也看不出），此处显式失败。
 * 页数上限同 knowledge.pagedCursor：非空页但 total 恒大于累计、或 total 缺失但页页拉满
 * 的漂移，在有限次调用后终止。
 */
async function pagedRaw(taskId: string, w: WindowRef, ctx: FetchCtx): Promise<{
  rows: Record<string, unknown>[]; sum: Record<string, unknown> | null
}> {
  const out: Record<string, unknown>[] = []
  let sum: Record<string, unknown> | null = null
  let declared: number | null = null
  let page = 1
  for (;;) {
    const maxPages = declared !== null ? Math.ceil(declared / PAGE_SIZE) + 5 : MAX_PAGES_FALLBACK
    if (page > maxPages) {
      throw new Error(`接口 ${endpointOf(taskId)} 翻页超限（${page - 1} 页 > 上限 ${maxPages}，` +
        `声明 total=${String(declared)}，已取 ${out.length} 行）：total 与已取行数不收敛，拒绝落库`)
    }
    const body = { ...reportBody(taskId, w), page }
    // B 中-6：callPaced 的键就是注册表 endpoint id（闸门按路径拦、冷却按路径共享）。
    const res = await callPaced(endpointOf(taskId), body, ctx)
    const { rows, sum: s } = payloadRows(taskId, res.payload)
    if (s) sum = s
    out.push(...rows)
    const total = (res.payload as { total?: unknown } | null)?.total
    if (typeof total !== 'number') {
      // total 缺省视为单页：拉满一页仍不声明 total 时不再翻（口径与 tickets.search 一致）
      declared = null
      break
    }
    if (declared === null) declared = total
    else if (total !== declared) {
      throw new Error(`接口 ${endpointOf(taskId)} 各页声明 total 漂移（${declared} → ${total}）：` +
        '遍历期间上游数据变更，拒绝落库（重跑即可）')
    }
    // total 与已取行数收敛即停；短读（rows.length === 0 但 total 未达）留给终检判定
    if (out.length >= total || rows.length === 0) break
    page++
  }
  if (declared !== null && out.length < declared) {
    throw new Error(`接口 ${endpointOf(taskId)} 分页短读：声明 total=${declared}，实取 ${out.length} 行` +
      '（响应形态漂移/遍历期间上游变更），拒绝落库——重跑即可')
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

/** 普通报表 fetch（result/全局行形态）：stat_date=窗口起点按上海天对齐；staffId 键取不到时用 'sum' 哨兵。 */
function fetchSimple(taskId: string, perStaff: boolean): SyncTask['fetch'] {
  return async (w, ctx) => {
    const nowIso = nowIsoOf(ctx)
    // B 高-1：走 callPaced（本地令牌桶拒绝被吸收为等待重试；远端限频写持久化冷却行）。
    // 裸 call 会让两种限频都直接冒泡成 fetch_failed gap，而空窗假空重试必然二次调用
    // 同一路径——这是最容易撞上本地限频的一条路径。
    const res = await callPaced(endpointOf(taskId), reportBody(taskId, w), ctx)
    const { rows, sum } = payloadRows(taskId, res.payload)
    const mapped: Record<string, unknown>[] = []
    for (const r of rows) {
      // perStaff 表（staff_workload/quality/satisfaction）键是 (stat_date, staff_id)；
      // 全局汇总表（overview/robot_summary/transfer_human）键只有 stat_date——
      // 响应没有 staffId，行形状按目标表列集投影。
      const base = baseRow(w, r, nowIso)
      if (perStaff) {
        const sid = r.staffId ?? r.staffid ?? r.staff_id
        if (isEmptyKey(sid)) continue   // 键缺失/空串行：计入 fetched 不写库
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
  return r.rows
    .map((x) => (isEmptyKey(x.id) ? '' : String(x.id)))
    .filter((id) => id !== '')
}

/** 报表任务的通用写策略（A 中-2：删除边界与行内日期列同口径 = 上海天对齐）。 */
const RANGE_INSERT: SyncTask['write'] = { kind: 'deleteRangeInsert', rangeColumns: ['stat_date'], rangeAlign: 'shanghaiDay' }

export const REPORT_TASKS: SyncTask[] = [
  {
    id: 'reports.overview', table: 'daily_overview', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date'], reportDayRotation: true,
    endpoint: 'statistic.overview',
    write: RANGE_INSERT,
    fetch: fetchSimple('reports.overview', false),
  },
  {
    id: 'reports.staff_workload', table: 'staff_workload', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date', 'staff_id'], reportDayRotation: true,
    endpoint: 'statistic.staffworklod',
    write: RANGE_INSERT,
    // 响应 date 恒 0 → stat_date 只能用窗口起点（调用方填写）
    fetch: (w, ctx) => fetchPagedStaff('reports.staff_workload', w, ctx),
  },
  {
    id: 'reports.staff_quality', table: 'staff_quality', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date', 'staff_id'], reportDayRotation: true,
    endpoint: 'statistic.staffquality',
    write: RANGE_INSERT,
    fetch: fetchSimple('reports.staff_quality', true),
  },
  {
    id: 'reports.staff_satisfaction', table: 'staff_satisfaction', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date', 'staff_id'], reportDayRotation: true,
    endpoint: 'statistic.satisfaction.report',
    write: RANGE_INSERT,
    fetch: (w, ctx) => fetchPagedStaff('reports.staff_satisfaction', w, ctx),
  },
  {
    id: 'reports.staff_attendance', table: 'staff_attendance', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    // hour_ts 是响应内唯一可信日期字段（小时对齐时间戳）
    primaryKey: ['staff_id', 'hour_ts'], reportDayRotation: true,
    endpoint: 'statistic.staffAttendance',
    // G 高-1：endTime 不得晚于今天 0:00（14501 endTime is invalid），
    // 且今天 0:00 这条边界不稳定 → 引擎把窗口 end 钳到昨天 0:00（留整日余量）。
    windowEndClamp: 'shanghaiYesterday',
    write: RANGE_INSERT,
    // ⚠️ 请求体恒含 startTime（reportBody 已保证）——省略会静默降级为天粒度、少抓 ~10 倍。
    // 分页 total 收敛拉满（单页 pageSize=1000，31d 实测 17765 行 → 两页），再抽 hour_ts。
    fetch: async (w, ctx) => {
      const nowIso = nowIsoOf(ctx)
      const { rows } = await pagedRaw('reports.staff_attendance', w, ctx)
      const mapped: Record<string, unknown>[] = []
      for (const r of rows) {
        const sid = r.staffId ?? r.staffid
        const ts = r.date   // 该小时按小时对齐的时间戳
        // C 中-4：脏时间戳逐行丢弃（与其他任务的脏单行口径一致），绝不因一行
        // 非数字/空串的 ts 抛 RangeError 断掉整窗。秒级 ts（10 位）静默落 1970 ——
        // 形态不符即丢弃（小时对齐的毫秒戳约 1.7e12，秒级差 1000 倍，判据取 > 1e11）。
        const n = Number(ts)
        if (isEmptyKey(sid) || !Number.isFinite(n) || n <= 1e11) continue
        mapped.push({ ...baseRow(w, r, nowIso), staff_id: String(sid), hour_ts: new Date(n).toISOString() })
      }
      return { rows: mapped, apiCount: mapped.length }
    },
  },
  {
    id: 'reports.order_performance', table: 'order_performance', kind: 'windowed',
    // 365 天是实测上限（floor(span/86400000) > 365 才拒）——order_performance 用满
    maxWindowDays: 365, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['order_id'], reportDayRotation: true,
    endpoint: 'statistic.performance',
    // G 高-1：与 staff_attendance 同族的 endTime 对齐检查（14501 endTime is invalid）
    windowEndClamp: 'shanghaiYesterday',
    write: RANGE_INSERT,
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
          if (isEmptyKey(oid)) continue
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
    endpoint: 'statistic.salaryDetail',
    // G 高-1：salaryDetail 跟随 startTime 的窗口起始日 —— 只覆盖起始日，不存在
    // 「endTime 越界」的报错形态，故不声明 windowEndClamp（只有 attendance/performance 需要）。
    write: RANGE_INSERT,
    // ⚠️ 必须传单个 staffId（省略 14004、传数组不识别）→ 按 staff 表逐客服驱动；
    // staff 表为空是任务序错误（先跑 dim.staff），显式失败而非静默空跑。
    fetch: async (w, ctx) => {
      void w
      const ids = await staffIds(ctx.store)
      if (ids.length === 0) {
        throw new Error('staff 表为空：staff_salary_detail 按客服驱动，请先同步 dim.staff 任务')
      }
      const nowIso = nowIsoOf(ctx)
      const day = shanghaiDayIso(w.start)
      const out: Record<string, unknown>[] = []
      for (const sid of ids) {
        const body = { ...reportBody('reports.staff_salary_detail', w), staffId: Number(sid) }
        const res = await callPaced(endpointOf('reports.staff_salary_detail'), body, ctx)
        const { rows, sum } = payloadRows('reports.staff_salary_detail', res.payload)
        for (const r of rows) {
          out.push({ ...baseRow(w, r, nowIso), staff_id: sid, work_date: day })
        }
        if (sum) out.push({ ...baseRow(w, sum, nowIso), staff_id: sid, work_date: day })
      }
      return { rows: out, apiCount: out.length }
    },
  },
  {
    id: 'reports.robot_summary', table: 'robot_summary', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date'], reportDayRotation: true,
    endpoint: 'robot.statistic.summary',
    write: RANGE_INSERT,
    // 形状 A；robotId 被服务端忽略 → body 不含（reportBody 保证）
    fetch: fetchSimple('reports.robot_summary', false),
  },
  {
    id: 'reports.transfer_human', table: 'transfer_human', kind: 'windowed',
    // G 中-2：实测**恰好 365 天**被拒（14500 起止时间不能超过365天），且 364 天也会
    // 报 Internal error（边界不稳定）→ 按设计稿 §13 的建议压到 360 天留余量。
    maxWindowDays: 360, overlapDays: 0,
    watermark: { field: 'stat_date', initial: null },
    primaryKey: ['stat_date'], reportDayRotation: true,
    endpoint: 'ai.statistic.transferHuman',
    write: RANGE_INSERT,
    // 形状 A；type/robotId 被服务端忽略 → body 不含（reportBody 保证）
    fetch: fetchSimple('reports.transfer_human', false),
  },
]

/** 按 id 取报表任务（T12 汇总与测试的取用形态）。 */
export function taskById(id: string): SyncTask | undefined {
  return REPORT_TASKS.find((t) => t.id === id)
}
