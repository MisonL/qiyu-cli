// src/sync/tasks/sessions.ts
// D-T10：会话导出任务声明（spec §5.3）—— 唯一走四步流水线的 windowed 任务。
// 实测事实（设计稿 §7.5）：
//   ① 窗口 ≤6 天（143.5h 通过 / 144.0h 报 14004）→ maxWindowDays=6；
//   ② 相邻窗口必须重叠 1 天（跨窗口长会话会漏，实测 5 会话/16 消息）→ overlapDays=1，
//      重叠行由按 session.id 的 upsert 幂等吸收（**去重按 session.id，绝不能按导出任务 key**）；
//   ③ **导出按 endTime 过滤**（判定式 window.start <= endTime <= window.end）→ 水位字段 endTime；
//   ④ enrich 派生 session_type：staffId **数字判别**（< -1 → robot / == -1 → internal /
//      > 0 → human；不用 sType），staffId 落库是 VARCHAR、比较时转 number（BIGINT 精度红线）；
//   ⑤ categoryDetail 归一化：导出是 " / "（带空格），/one 是 "/"（无空格）——落库前归一，
//      为 E 的 JOIN 铺路；哨兵值「未分类」「无效会话」是中文单段值，归一化不触及。
// 列投影按 TABLES sessions 列集（payload 收敛 + 键列/时间列/PII 敏感列提升）。
import { runExportPipeline } from './pipeline.js'
import { nowIsoOf } from './pace.js'
import type { SyncTask, FetchResult, FetchCtx } from '../types.js'

const isoOf = (ms: number): string => new Date(ms).toISOString()

const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v)

/** categoryDetail 归一化："a / b / c / d" → "a/b/c/d"（导出 " / " 带空格 → /one 无空格）。 */
export function normalizeCategoryDetail(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const s = String(v)
  return s.split(' / ').join('/')
}

/**
 * session_type 判别（设计稿 §7.5：staffId 是唯一精确字段）：
 * staffId 数字 < -1 → robot；== -1 → internal；> 0 → human。
 * staffId 落库为 VARCHAR —— 判别必须基于数字比较（字符串比较会判错负数）。
 */
export function deriveSessionType(staffId: unknown): string | null {
  if (staffId === null || staffId === undefined || staffId === '') return null
  const n = Number(staffId)
  if (!Number.isFinite(n)) return null
  if (n < -1) return 'robot'
  if (n === -1) return 'internal'
  return 'human'
}

/** 按列集投影：行补 session_id/session_type/categoryDetail/PII 列；缺 id 行丢弃（不计入 fetched）。
 * ⚠️ 本函数是纯投影（红线 1：同输入同输出）—— synchronized_at 从输入行透传
 *（fetch 在进 enrich 前统一盖章，enrich 直测两调用相等）；输入无戳则为 null（列可空）。 */
function sessionRow(src: Record<string, unknown>): Record<string, unknown> | null {
  const id = src.id ?? src.session_id
  if (id === null || id === undefined) return null   // 键缺失行：丢弃且不计入 fetched（与 apiCount 口径一致）
  return {
    session_id: String(id),
    payload: JSON.stringify(src),
    staffId: strOrNull(src.staffId),
    startTime: strOrNull(src.startTime),
    endTime: strOrNull(src.endTime),
    session_type: deriveSessionType(src.staffId),
    categoryDetail: normalizeCategoryDetail(src.categoryDetail),
    userPhone: strOrNull(src.userPhone),
    userName: strOrNull(src.userName),
    userEmail: strOrNull(src.userEmail),
    userAddress: strOrNull(src.userAddress),
    fromIp: strOrNull(src.fromIp),
    userIpCity: strOrNull(src.userIpCity),
    userCrmInfo: strOrNull(src.userCrmInfo),
    synchronized_at: (src.synchronized_at as string | null | undefined) ?? null,
  }
}

/**
 * 流水线扩展上下文：sessions 任务的 fetch 在 FetchCtx 之上追加油水线注入面
 *（fetchZip/poll 节奏，T13 生产接线与测试注入的同一落点）。
 */
export interface SessionFetchCtx extends FetchCtx {
  fetchZip?: (url: string) => Promise<Uint8Array>
  pollIntervalMs?: number
  maxPolls?: number
}

async function fetchSessions(w: { start: number; end: number }, ctx: FetchCtx): Promise<FetchResult> {
  const sctx = ctx as SessionFetchCtx
  if (!sctx.fetchZip) {
    throw new Error('sessions.export 需要 fetchZip 注入（下载走 ZIP 二进制通道，与 JSON 信封层不同构）——生产接线归 sync run 编排层')
  }
  const nowIso = nowIsoOf(ctx)
  const { sessions } = await runExportPipeline(w, {
    credentials: ctx.credentials,
    fetchZip: sctx.fetchZip,
    pollIntervalMs: sctx.pollIntervalMs,
    maxPolls: sctx.maxPolls,
  })
  // synchronized_at 在 fetch 侧按窗统一盖章（单值、确定性于本窗）——enrich 是纯投影
  //（红线 1：同输入行永远同输出），只透传该戳；原始行直出（session.id 键、未投影）。
  const stamped = sessions.map((r) => ({ ...r, synchronized_at: nowIso }))
  return { rows: stamped, apiCount: sessions.length }
}

/**
 * enrich：投影 + 确定性派生（红线 1 推论：同输入行永远同输出）。
 * 派生 session_type（staffId 数字判别）+ categoryDetail 归一化；缺 id 行返回 null
 *（丢弃且不计入 fetched——与 apiCount 口径一致）。synchronized_at 从输入行透传
 *（fetch 已统一盖章），无戳直测时为 null —— 本函数不含任何时钟读取。
 */
function enrichSession(src: Record<string, unknown>): Record<string, unknown> | null {
  return sessionRow(src)
}

export const SESSIONS_TASKS: SyncTask[] = [
  {
    id: 'sessions.export', table: 'sessions', kind: 'windowed',
    maxWindowDays: 6, overlapDays: 1,
    // 水位 endTime：导出按 endTime 过滤（按 startTime 会漏——实测 14/17 行越界）
    watermark: { field: 'endTime', initial: null },
    primaryKey: ['session_id'],
    write: { kind: 'upsertRows' },
    fetch: fetchSessions,
    enrich: enrichSession,
  },
]

/** 按 id 取会话任务（T12 汇总与测试的取用形态）。 */
export function taskById(id: string): SyncTask | undefined {
  return SESSIONS_TASKS.find((t) => t.id === id)
}
