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
//   ⑥ 尾部标记行（fixture）是**导出自己的窗口声明**（C-8）：完整导出恰好带一行，
//      与请求窗口核对 —— 不覆盖请求 = 形态漂移（失败 + 水位冻结）；缺失 = 记 gap；
//      宽于请求 = 记 gap（见 fetchSessions 与 assertFixtureGranularity）。
// 列投影按 TABLES sessions 列集（payload 收敛 + 键列/时间列/PII 敏感列提升）。
import { runExportPipeline, parseExportFixture } from './pipeline.js'
import { nowIsoOf } from './pace.js'
import type { SyncTask, FetchResult, FetchCtx } from '../types.js'

const isoOf = (ms: number): string => new Date(ms).toISOString()

const strOrNull = (v: unknown): string | null =>
  v === null || v === undefined ? null : typeof v === 'string' ? v : JSON.stringify(v)

/** 空串主键/键列拒绝（C 低-7）：`''` 是合法的 VARCHAR 值，会写出一行能被反复覆盖的同键行。 */
const isEmptyKey = (v: unknown): boolean => v === null || v === undefined || v === ''

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
 * ⚠️ C 中-6：`staffId === 0` **不得**静默落成 'human' —— 0 不是任何已知的判别分支
 *（实测样本只有 < -1 / == -1 / > 0 三类，0 从未出现），静默归到 human 会伪造出一个
 * 「人工接待」的事实。按「未知形态」显式落 null，让该行在按 session_type 过滤时可见地缺失。
 */
export function deriveSessionType(staffId: unknown): string | null {
  if (isEmptyKey(staffId)) return null
  const n = Number(staffId)
  if (!Number.isFinite(n)) return null
  if (n < -1) return 'robot'
  if (n === -1) return 'internal'
  if (n === 0) return null   // 未知形态：不猜（C 中-6）
  return 'human'
}

/** 按列集投影：行补 session_id/session_type/categoryDetail/PII 列；缺 id 行丢弃（不计入 fetched）。
 * ⚠️ 本函数是纯投影（红线 1：同输入同输出）—— synchronized_at 从输入行透传
 *（fetch 在进 enrich 前统一盖章，enrich 直测两调用相等）；输入无戳则为 null（列可空）。 */
function sessionRow(src: Record<string, unknown>): Record<string, unknown> | null {
  const id = src.id ?? src.session_id
  // 键缺失/空串行：丢弃且不计入 fetched（与 apiCount 口径一致；C 低-7）
  if (isEmptyKey(id)) return null
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
  const { sessions, fixture } = await runExportPipeline(w, {
    credentials: ctx.credentials,
    fetchZip: sctx.fetchZip,
    pollIntervalMs: sctx.pollIntervalMs,
    maxPolls: sctx.maxPolls,
    // B 高-1：gate/clock 传进流水线 —— create/check 的远端限频要落持久化冷却行。
    gate: ctx.gate,
    clock: ctx.clock,
  })
  // synchronized_at 在 fetch 侧按窗统一盖章（单值、确定性于本窗）——enrich 是纯投影
  //（红线 1：同输入行永远同输出），只透传该戳；原始行直出（session.id 键、未投影）。
  const stamped = sessions.map((r) => ({ ...r, synchronized_at: nowIso }))
  const base: FetchResult = { rows: stamped, apiCount: sessions.length }

  // —— C-8：尾部标记行（fixture）= 导出自己的窗口声明，与请求窗口核对 ——
  // 实测形态（private/raw/session.txt，4687 行样本）：**完整导出必然带这一行**，恰好一行、
  // 紧随全部 JSON 行之后，声明一个 24h 窗口。因此「带了它」是正常形态，不是异常；
  // 真正可疑的是它的**内容**（声明的窗口与请求不符）与它的**缺失**（流没有声明覆盖到哪）。
  // ⚠️ fixture 非空 ⇒ 必然可解析（parseJsonl 与这里共用 parseExportFixture 判形态，
  // 不会各写一套正则）——所以没有「fixture 解析不出」的分支，那是不可达代码。
  const declared = fixture === undefined ? null : parseExportFixture(fixture)
  if (declared !== null && (declared.start > w.start || declared.end < w.end)) {
    // 声明的窗口不覆盖本窗请求 → 本窗数据可疑（服务端实测会按（企业,窗口）复用已计算的
    // 导出结果，同参数重复创建返回不同 key 相同数据）→ 宁可失败：fetch 抛错由引擎包装成
    // 中文 gap（failDetail）+ 水位冻结（contiguousBroken），绝不把来路不明的行写进库。
    throw new Error(`会话导出格式漂移（${fixture}）：导出声明的窗口 ` +
      `[${isoOf(declared.start)}, ${isoOf(declared.end)}] 未覆盖请求窗口 ` +
      `[${isoOf(w.start)}, ${isoOf(w.end)}] —— 本窗数据可疑，拒绝落库`)
  }
  if (fixture === undefined) {
    // 完整导出应带尾部标记（见上）；缺失 = 导出流没有声明它覆盖到哪 —— 空窗可能是真空、
    // 也可能是流被截断在行边界（逐行 JSON 解析对截断在行中间的情况已显式失败）。
    // 不判失败（历史样本可能无），但绝不静默：记一条 gap，让两类空窗可区分。
    return {
      ...base,
      gapHint: {
        reason: 'export_fixture_unreported',
        detail: `导出流未上报尾部标记行（完整导出末尾应有一行 startTime=…,endTime=… 声明导出窗口）：` +
          `本窗 ${sessions.length} 行数据的窗口覆盖无从核对 —— 空窗可能确实是空，也可能是导出流被截断在行边界。` +
          `请求窗口 [${isoOf(w.start)}, ${isoOf(w.end)}]`,
      },
    }
  }
  if (declared !== null && (declared.start < w.start || declared.end > w.end)) {
    // 覆盖成立但宽于请求：多出来的行由 session_id 幂等 upsert 吸收（与 overlapDays 同机制），
    // 数据不受损 —— 但「服务端改了窗口」这件事必须可见，记 gap 并带上标记行原文。
    return {
      ...base,
      gapHint: {
        reason: 'export_window_mismatch',
        detail: `导出声明的窗口 [${isoOf(declared.start)}, ${isoOf(declared.end)}] 宽于请求窗口 ` +
          `[${isoOf(w.start)}, ${isoOf(w.end)}]（重叠行由 session_id 幂等吸收）`,
        fixture,
      },
    }
  }
  return base
}

/**
 * fixture 检测面的粒度断言（C-8 收尾批，模块级调用 = import 侧效应）：
 * 尾部标记行的形态、以及「声明窗口 ↔ 请求窗口」核对的可信度，都建立在**同一份实测**上
 *（private/raw/session.txt：4687 行 + 恰好一行尾标记，声明 24h 窗口；窗口上限 143.5h 通过 /
 * 144.0h 报 14004）。`maxWindowDays ≥ 7` 意味着导出语义已越过那份实测（服务端要么接受更宽
 * 的窗口、要么把一次导出拆成多块 —— 后者会让「一行尾标记」的粒度假设失效：多块 = 多个标记，
 * 而本检测只带出一行）。此时必须在**重新实测**尾标记与窗口声明后修订核对逻辑，而不是
 * 沿用旧假设继续放行 —— 所以这里直接失败，把「假设已过期」摆在载入期。
 */
export function assertFixtureGranularity(task: SyncTask): void {
  const days = task.maxWindowDays
  if (days !== undefined && days <= 6) return
  throw new Error(`sessions.export 的 fixture 检测面已失效：maxWindowDays=${String(days)}（要求 ≤6）—— ` +
    '尾标记形态与窗口核对建立在「窗口 ≤6 天」的实测样本上（143.5h 通过 / 144.0h 报 14004；' +
    '样本 4687 行 + 恰好一行尾标记，声明 24h 窗口）。窗口上限放宽到 ≥7 天说明导出语义已变，' +
    '必须在重新实测尾标记粒度与窗口声明后修订核对逻辑')
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
    // 闸门键 = 主驱动路径（create 是限频的那一个：10 秒 6 次）；check 显式登记为无限频。
    endpoint: 'export.session',
    write: { kind: 'upsertRows' },
    fetch: fetchSessions,
    enrich: enrichSession,
  },
]

// 模块级断言（import 侧效应）：声明的窗口上限与 fixture 检测面共用同一份实测 ——
// 上限被改到 ≥7 天时**载入本模块即失败**，不靠注释、不靠自觉（见 assertFixtureGranularity）。
for (const t of SESSIONS_TASKS) assertFixtureGranularity(t)

/** 按 id 取会话任务（T12 汇总与测试的取用形态）。 */
export function taskById(id: string): SyncTask | undefined {
  return SESSIONS_TASKS.find((t) => t.id === id)
}
