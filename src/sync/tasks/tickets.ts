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
import { call } from '../../core/http.js'
import { byId } from '../../core/registry/index.js'
import type { SyncTask, FetchResult, FetchCtx, WindowRef } from '../types.js'

/** 窗口起止的 ISO（与引擎水位/删除范围的值同形——T5 验收项）。 */
const isoOf = (ms: number): string => new Date(ms).toISOString()

let sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** 仅测试用：替换等待实现（多窗连跑撞本地令牌桶时按 retryAfter 等待，默认真实 30s，不可测）。 */
export function __setSleep(fn: (ms: number) => Promise<void>): void { sleep = fn }

/**
 * op 参数守卫（Review Focus 1 钉死）：构造请求体之前校验窗口两端齐全且有序。
 * opEnd 缺省/为 0 → 服务端把它当「没传」处理、静默返回全量（code:200，
 * 实测 {opStart: now-1d, opEnd: now} → total 100 vs {opStart: now-1d, opEnd: 0} → total 2885）；
 * opStart > opEnd（顺序颠倒）同样静默失效。三者都必须在**客户端**拦下 —— 请求发出去
 * 信封层判不出异常， Agent 会拿着全量数据误以为窗口过滤生效了。
 */
function assertOpWindow(w: WindowRef): void {
  // opEnd 取 0 或缺省的形态：窗口起点非负恒成立，故 opEnd<=0 只可能是「未有效赋值」
  if (!Number.isFinite(w.end) || w.end <= 0 || !Number.isFinite(w.start) || w.start < 0) {
    throw usageError(`工单 op 窗口无效：opEnd 缺省或为 0 时服务端会静默返回全量（窗口 start=${w.start}, end=${w.end}）`)
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
 * 带冷却重试的调用：任务内多次调用（翻页/逐工单）会撞进程内令牌桶
 *（工单域实测无服务端限频，本地未登记 → 桶不拦；但保守起见仍按 retryAfter 等待重试，
 * 宁可慢不超发）。测试经 __setSleep 注入零等待。
 */
async function callPaced(endpointId: string, body: unknown, ctx: FetchCtx,
  attempt = 0): Promise<{ payload: unknown }> {
  try {
    return await call(byId(endpointId), body, { credentials: ctx.credentials })
  } catch (e) {
    const rl = e as { code?: string; retryAfter?: { seconds?: number } }
    if (rl.code === 'local_rate_limit' && attempt < 3) {
      await sleep(((rl.retryAfter?.seconds ?? 30) + 1) * 1000)
      return callPaced(endpointId, body, ctx, attempt + 1)
    }
    throw e
  }
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

/** 行投影：ticket_id 主键列（响应键 id）；payload 收敛 + PII 敏感列提升。 */
function ticketRow(src: Record<string, unknown>, nowIso: string): Record<string, unknown> | null {
  const id = src.id
  if (id === null || id === undefined) return null   // 键缺失行：丢弃且不计入 fetched（与 apiCount 口径一致）
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

/** tickets.search 任务 fetch：op 守卫 → limit=500 分页（total 收敛）→ 投影落库（upsertRows）。 */
async function fetchTickets(w: WindowRef, ctx: FetchCtx): Promise<FetchResult> {
  assertOpWindow(w)
  const nowIso = new Date().toISOString()
  const out: Record<string, unknown>[] = []
  let offset = 0
  for (;;) {
    const res = await callPaced('ticket.search', ticketBody('tickets.search', w, offset), ctx)
    const { total, tickets } = searchPayload(res.payload, 'ticket.search')
    for (const r of tickets) {
      const row = ticketRow(r, nowIso)
      if (row) out.push(row)
    }
    // total 与已取行数收敛即停（total 缺省视为单页；offset 可一直翻到 total，无固定之墙）
    if (out.length >= total || tickets.length === 0) break
    offset += tickets.length
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
  const nowIso = new Date().toISOString()
  // —— touched 工单：与 tickets.search 同窗同分页 ——
  const touched: string[] = []
  let offset = 0
  for (;;) {
    const res = await callPaced('ticket.search', ticketBody('tickets.search', w, offset), ctx)
    const { total, tickets } = searchPayload(res.payload, 'ticket.search')
    for (const r of tickets) {
      if (r.id !== null && r.id !== undefined) touched.push(String(r.id))
    }
    if (touched.length >= total || tickets.length === 0) break
    offset += tickets.length
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
      if (logId === null || logId === undefined) continue   // 键缺失行：丢弃且不计入 fetched
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
    write: { kind: 'upsertRows' },
    fetch: fetchTickets,
  },
  {
    id: 'ticket.logs', table: 'ticket_logs', kind: 'windowed',
    maxWindowDays: 31, overlapDays: 3,
    // 水位沿用 tickets 的 op 窗口推进（spec §5.5：没有 logs 表就回答不了处理量/时长）
    watermark: { field: 'op_end', initial: null },
    primaryKey: ['ticket_id', 'log_id'],
    write: { kind: 'upsertRows' },
    fetch: fetchTicketLogs,
  },
]

/** 按 id 取工单任务（T12 汇总与测试的取用形态）。 */
export function taskById(id: string): SyncTask | undefined {
  return TICKET_TASKS.find((t) => t.id === id)
}
