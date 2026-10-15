// src/sync/tasks/tickets.ts
// D-T9：工单任务（spec §5.2 末行/§5.5）—— tickets.search（工单明细）+ ticket.logs（逐单日志）。
// 两任务共用 op 窗口语义（Review Focus 1 的实测事实，设计稿 §10.1）：
//   ① **op 窗口必须按 ≤31 天切片**：opStart 被服务端静默钳到「当前时刻前约 31 天」，
//      而 90 天硬上限在诱导切 89 天窗 —— 每片会静默少取约 58 天且永不报错（maxWindowDays=31）；
//   ② **op 参数必须成对且 opEnd 为有效时间戳**：opEnd 缺省/为 0/只传一个/顺序颠倒时
//      服务端不报错而返回全量（信封层判不出异常）—— fetch 在构造 body 前守卫，客户端抛
//      usage（绝不发请求）；
//   ③ **水位必须用操作时间**（opStart/opEnd=「窗口内是否有日志」），按创建时间（start/end）
//      增量永远拿不到状态变更；水位续跑带 **3 天回看重叠**（overlapDays=3，覆盖乱序到达的
//      日志/状态变更）；
//   ④ search 只识别 8 个参数（start/end/opStart/opEnd/status/templateId/limit/offset）——
//      其余参数（staffId/groupId/typeId/filterId/ids/keyword/orderBy/sort）被静默忽略，
//      透传只会误导调用方（契约诚实性），body 只含 op 对 + limit=500 + offset；
//   ⑤ limit=500 精确兑现、offset 可一直翻到 total（无 9245 之墙，实测推翻）。
// 工单行线上 27 键且漂移频繁 → 业务字段收敛进 payload JSON 字符串列（schema.ts 工单批次注释）。
// ticket.log 无分页（limit/pageNo/pageSize 全被忽略），按窗口内 touched 工单逐张全量拉。
import { callPaced, nowIsoOf } from './pace.js'
import type { SyncTask, FetchResult, FetchCtx, WindowRef } from '../types.js'

/** 窗口起止的 ISO（与引擎水位/删除范围的值同形——T5 验收项）。 */
const isoOf = (ms: number): string => new Date(ms).toISOString()

/** 限频节流与测试 sleep 注入收敛至共享 pace.ts（中-1）。 */
export { __setSleep } from './pace.js'

/**
 * op 参数守卫（Review Focus 1 钉死）：构造请求体之前校验窗口两端齐全且有序。
 * opEnd 缺省/为 0 → 服务端把它当「没传」处理、静默返回全量（code:200，
 * 实测 {opStart: now-1d, opEnd: now} → total 100 vs {opStart: now-1d, opEnd: 0} → total 2885）；
 * opStart > opEnd（顺序颠倒）同样静默失效。三者都必须在**客户端**拦下 —— 请求发出去
 * 信封层判不出异常， Agent 会拿着全量数据误以为窗口过滤生效了。
 * ⚠️ C 中-2：`opStart <= 0` 也必须拒绝 —— 0/负数不是真实时间戳（1970 是哨兵不是日期），
 * 且 opStart 早于「now − 31 天」会被服务端**静默钳制**（窗口解释权交给服务端）。
 * 首跑/--full 的起点由引擎的 `windowStartFloorDays` 抬到 now − 31 天（见任务声明），
 * 走到这里时必然是正数；走到这里仍是 0 的，只可能是显式给了 0 起点 —— 显式失败。
 */
function assertOpWindow(w: WindowRef): void {
  // opEnd 取 0 或缺省的形态：窗口起点非负恒成立，故 opEnd<=0 只可能是「未有效赋值」
  if (!Number.isFinite(w.end) || w.end <= 0 || !Number.isFinite(w.start) || w.start <= 0) {
    throw usageError(`工单 op 窗口无效：opEnd 缺省/为 0 时服务端会静默返回全量，` +
      `opStart<=0（1970 哨兵）会被静默钳制（窗口 start=${w.start}, end=${w.end}）`)
  }
  if (w.start > w.end) {
    throw usageError(`工单 op 窗口顺序颠倒（opStart > opEnd 会静默失效）：start=${w.start} > end=${w.end}`)
  }
}

/** usage 错误（退出码 2）：本地参数问题，重试无用。 */
function usageError(msg: string): Error {
  const e = new Error(msg)
  ;(e as { kind?: string }).kind = 'usage'
  ;(e as { hint?: string }).hint = '这是同步任务的本地窗口参数问题（op 参数对必须齐全有序），修正后重跑'
  return e
}

/**
 * tickets.search 的请求体构造（导出供测试对拍——http mock 只见 URL，body 事实在签名里）。
 * search 只识别 8 个参数：body 恰为 opStart/opEnd（毫秒时间戳，守卫已保证有效）
 * + limit=500（实测精确兑现）+ offset（翻页位）。
 */
export function ticketBody(taskId: string, w: WindowRef, offset: number): Record<string, unknown> {
  switch (taskId) {
    case 'tickets.search':
      return { opStart: w.start, opEnd: w.end, limit: 500, offset }
    default:
      throw new Error(`未知工单任务：${taskId}`)
  }
}

/** 形状 C 载荷 → {total, tickets}；载荷缺 tickets 数组视为响应形态漂移，显式失败。 */
function searchPayload(payload: unknown, endpointId: string): { total: number; tickets: Record<string, unknown>[] } {
  const o = (payload ?? {}) as Record<string, unknown>
  if (!Array.isArray(o.tickets)) {
    throw new Error(`接口 ${endpointId} 返回的载荷没有 tickets 数组（响应形态漂移？），拒绝落库`)
  }
  // total 缺省视为单页（与 reports.pagedRaw 同口径）
  return { total: typeof o.total === 'number' ? o.total : o.tickets.length,
    tickets: o.tickets as Record<string, unknown>[] }
}

/** 每页上限（实测 limit=500 精确兑现）。 */
const PAGE_SIZE = 500
/** 页数上限兜底（C 中-3/中-13，与 reports/knowledge 同口径）。 */
const MAX_PAGES_FALLBACK = 1000

/** 空串主键拒绝（C 低-7）：`''` 会写进 VARCHAR 主键列，且空串行还能反复覆盖同键。 */
const isEmptyKey = (v: unknown): boolean => v === null || v === undefined || v === ''

/**
 * 窗口内工单原始行的分页拉取（tickets.search / ticket.logs 的 touched 集合同源）：
 * limit=500 精确兑现、offset 按**返回行数**推进（不按投影后行数 —— 丢脏行不会让游标原地打转）、
 * total 收敛即停。
 * 终检（C 中-3）：循环退出必须满足「已取原始行数 >= 声明 total」——上游声明 total=100 却
 * 提前返回 0 行的短读是最危险的静默失败方向（会被当合法空窗），此处显式失败。
 * 页数上限（C 中-13）：`total 恒大于已取行数`的响应形态漂移在有限次调用后终止，绝不无限翻页。
 */
async function searchAllPages(w: WindowRef, ctx: FetchCtx): Promise<Record<string, unknown>[]> {
  const raw: Record<string, unknown>[] = []
  let declared: number | null = null
  let offset = 0
  for (let page = 1; ; page++) {
    const maxPages = declared !== null ? Math.ceil(declared / PAGE_SIZE) + 5 : MAX_PAGES_FALLBACK
    if (page > maxPages) {
      throw new Error(`接口 ticket.search 翻页超限（${page - 1} 页 > 上限 ${maxPages}，声明 ` +
        `total=${String(declared)}，已取 ${raw.length} 行）：total 与已取行数不收敛，拒绝落库`)
    }
    const res = await callPaced('ticket.search', ticketBody('tickets.search', w, offset), ctx)
    const { total, tickets } = searchPayload(res.payload, 'ticket.search')
    if (declared === null) declared = total
    else if (total !== declared) {
      throw new Error(`接口 ticket.search 各页声明 total 漂移（${declared} → ${total}）：` +
        '遍历期间上游数据变更，拒绝落库（重跑即可）')
    }
    raw.push(...tickets)
    if (raw.length >= declared || tickets.length === 0) break
    offset += tickets.length
  }
  if (raw.length < (declared ?? 0)) {
    throw new Error(`接口 ticket.search 分页短读：声明 total=${String(declared)}，实取 ${raw.length} 行` +
      '（响应形态漂移/遍历期间上游变更），拒绝落库——重跑即可')
  }
  return raw
}

/** 行投影：ticket_id 主键列（响应键 id）；payload 收敛 + PII 敏感列提升。 */
function ticketRow(src: Record<string, unknown>, nowIso: string): Record<string, unknown> | null {
  const id = src.id
  // 键缺失/空串行：丢弃且不计入 fetched（与 apiCount 口径一致；C 低-7 空串会被当成同键反复覆盖）
  if (isEmptyKey(id)) return null
  return {
    ticket_id: String(id),
    payload: JSON.stringify(src),
    crmUserName: strOrNull(src.crmUserName),
    crmUserPhone: strOrNull(src.crmUserPhone),
    crmUserEmail: strOrNull(src.crmUserEmail),
    userMobile: strOrNull(src.userMobile),
    synchronized_at: nowIso,
  }
}

const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v)

/** tickets.search 任务 fetch：op 守卫 → limit=500 分页（total 收敛 + 短读终检）→ 投影落库。 */
async function fetchTickets(w: WindowRef, ctx: FetchCtx): Promise<FetchResult> {
  assertOpWindow(w)
  const nowIso = nowIsoOf(ctx)
  const out: Record<string, unknown>[] = []
  for (const r of await searchAllPages(w, ctx)) {
    const row = ticketRow(r, nowIso)
    if (row) out.push(row)
  }
  return { rows: out, apiCount: out.length }
}

/**
 * ticket.logs 任务 fetch：先用同窗口的 search 找出 touched 工单（窗口内有操作 = op 语义），
 * 再逐张 log(ticketId) 全量拉日志（无分页，limit/pageNo/pageSize 全被忽略）。
 * 响应实测时间降序、id 非升序 —— 行落库经 (ticket_id, log_id) upsert 幂等吸收，顺序无关。
 */
async function fetchTicketLogs(w: WindowRef, ctx: FetchCtx): Promise<FetchResult> {
  assertOpWindow(w)
  const nowIso = nowIsoOf(ctx)
  // —— touched 工单：与 tickets.search 同窗同分页（同一份实现，短读/翻页上限语义一致）——
  const touched: string[] = []
  for (const r of await searchAllPages(w, ctx)) {
    if (!isEmptyKey(r.id)) touched.push(String(r.id))
  }
  // —— 逐单拉日志 ——
  const out: Record<string, unknown>[] = []
  for (const tid of touched) {
    const res = await callPaced('ticket.log', { ticketId: Number(tid) }, ctx)
    // ticket.log 信封未实测（registry envelope=null）→ 宽松模式载荷；data 数组形态按实测 §10.3。
    // 其余形态视为响应形态漂移，显式失败（与 reports.ts 的 searchPayload 同口径）——
    // 静默按空处理会把整单日志吞成 complete。
    let rows: Record<string, unknown>[]
    if (Array.isArray(res.payload)) {
      rows = res.payload as Record<string, unknown>[]
    } else if (Array.isArray((res.payload as Record<string, unknown> | null)?.data)) {
      rows = (res.payload as Record<string, unknown>).data as Record<string, unknown>[]
    } else {
      const shape = res.payload === null || res.payload === undefined
        ? 'null'
        : Array.isArray(res.payload) ? 'array' : typeof res.payload
      throw new Error(`接口 ticket.log 返回的载荷既不是数组也没有 data 数组（实测形态为顶层 data，得到 ${shape}），拒绝落库`)
    }
    for (const r of rows) {
      const logId = r.id
      if (isEmptyKey(logId)) continue   // 键缺失/空串行：丢弃且不计入 fetched（C 低-7）
      out.push({ ticket_id: tid, log_id: String(logId), payload: JSON.stringify(r), synchronized_at: nowIso })
    }
  }
  return { rows: out, apiCount: out.length }
}

export const TICKET_TASKS: SyncTask[] = [
  {
    id: 'tickets.search', table: 'tickets', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 3,
    watermark: { field: 'op_end', initial: null },
    primaryKey: ['ticket_id'],
    endpoint: 'ticket.search',
    // C 中-2：首跑/--full 的起点是 0（哨兵）→ 引擎抬到 now − 31 天
    //（服务端对更早的 opStart 静默钳制，发 1970 只是把窗口解释权交给服务端）。
    windowStartFloorDays: 31,
    write: { kind: 'upsertRows' },
    fetch: fetchTickets,
  },
  {
    id: 'ticket.logs', table: 'ticket_logs', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 3,
    // 水位沿用 tickets 的 op 窗口推进（spec §5.5：没有 logs 表就回答不了处理量/时长）
    watermark: { field: 'op_end', initial: null },
    primaryKey: ['ticket_id', 'log_id'],
    // 同路径任务共享冷却（B 中-6）：touched 集合与逐单日志都经 ticket.search / ticket.log，
    // 闸门键取主要驱动路径 ticket.search（与 tickets.search 任务同键，交替调用照样被拦）。
    endpoint: 'ticket.search',
    windowStartFloorDays: 31,
    write: { kind: 'upsertRows' },
    fetch: fetchTicketLogs,
  },
]

/** 按 id 取工单任务（T12 汇总与测试的取用形态）。 */
export function taskById(id: string): SyncTask | undefined {
  return TICKET_TASKS.find((t) => t.id === id)
}
