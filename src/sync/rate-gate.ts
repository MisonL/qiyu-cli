// D-T4：持久化限频闸门 —— 命中限频把「下次可调用时间」写进库，
// 跨进程快速失败（spec §6.2）。进程内令牌桶仍是 core/ratelimit.ts 的 TokenBucket；
// 本闸门是其持久化的兜底层：宁可多拦（本地冷却），绝不超发。
// 写函数只接受 WriteTx（引擎放进同一 transaction 闭包）；读函数只接受 Store。
// SQL 全部为代码内常量（同 query 红线）——本文件常量 SELECT 调用点共 1 处，
// 不在 duckdb.ts 的 9 处基线计数内。
import { RATE_LIMITS } from '../core/ratelimit.js'
import type { Store, WriteTx } from '../store/types.js'

/** 冷却行在 sync_state 里的 dataset 前缀（T3 裁定：主键 dataset 单列，靠前缀区分类别）。 */
const RATELIMIT_PREFIX = '__ratelimit__:'

/**
 * 单次冷却等待的上限（毫秒，B 低-2）：冷却行是持久化数据，坏数据（时钟错乱/手改库）
 * 可能算出天文数字的 retryAfter —— 等待必须封顶，剩下的靠「有界重试预算」终止，
 * 绝不因为一行坏数据把同步挂死（宁可多等几轮，也不无限等）。
 */
export const MAX_GATE_WAIT_MS = 300_000

/** 冷却等待的封顶（供引擎与任务层共用，避免两处各写一个上限）。 */
export function clampGateWait(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.min(ms, MAX_GATE_WAIT_MS) : 0
}

/** 读某 endpoint 的冷却截止（毫秒时间戳）；无记录返回 0（随时可调用）。 */
export async function readCooldown(store: Store, endpointId: string): Promise<number> {
  // 常量 SQL 调用点 1/1
  const r = await store.query('SELECT next_allowed_at FROM sync_state WHERE dataset = ?',
    [RATELIMIT_PREFIX + endpointId])
  const raw = r.rows[0]?.next_allowed_at
  if (typeof raw !== 'string' || raw === '') return 0
  const ms = Date.parse(raw)
  return Number.isNaN(ms) ? 0 : ms
}

/** 写/覆盖某 endpoint 的冷却截止（毫秒时间戳）。 */
export async function writeCooldown(tx: WriteTx, endpointId: string, untilMs: number,
  opts: { now?: () => number } = {}): Promise<void> {
  const untilIso = new Date(untilMs).toISOString()
  // last_rate_limited_at 同样取注入时钟（默认 Date.now）—— 纯 clock 注入下可确定性断言。
  const limitedAtIso = new Date(opts.now?.() ?? Date.now()).toISOString()
  // upsert 契约：每行必须完整列集（sync_state 共 9 列）。
  await tx.upsert('sync_state', [{
    dataset: RATELIMIT_PREFIX + endpointId,
    watermark: untilIso,
    range_status: null,
    last_error: null,
    locked_by: null,
    locked_at: null,
    last_synced_at: null,
    next_allowed_at: untilIso,
    last_rate_limited_at: limitedAtIso,
  }])
}

/** 本地限频错误形态：引擎层据此决定等待/退避，命令层转 human 提示。 */
export interface RateLimitLocalError extends Error {
  kind: 'rate_limit_local'
  /** 距下次可调用的毫秒数。 */
  retryAfter: number
}

/**
 * 持久化限频闸门。
 * - `acquire`：读库冷却截止，未到点抛 rate_limit_local（retryAfter 精确到毫秒）；
 *   到点或无限频接口放行。
 * - `penalize`：命中远端限频后写冷却。**显式登记为无限频**（RATE_LIMITS 里有键
 *   且值为 null）的 endpoint 不写不拦 —— 与审计语义一致（null = 实测没有）；
 *   未登记的 endpoint 照写不误 —— 闸门宁可多拦，远端真实返回 429/限频就是证据。
 *
 * ⚠️ **键统一为 endpoint id**（B 中-6）：`penalize` 与 `acquire` 必须传同一把键 ——
 * 远端限频的证据是「这个路径被限了」（限频按路径独立，设计稿 §7.4 实测），
 * 而 acquire 也按路径查冷却。此前两处传的是 task id（`reports.overview`），
 * 而 `RATE_LIMITS` 的键是 endpoint id（`statistic.overview`）——null 豁免恒不触发，
 * 且同路径多任务（`tickets.search` 与 `ticket.logs` 同走 `ticket.search`）各自持一份
 * 冷却，同一路径上交替调用照样超发。键不一致时闸门拦不住它本该拦的调用。
 */
export class RateGate {
  constructor(
    private readonly store: Store,
    private readonly clock: () => number = () => Date.now(),
  ) {}

  /** 到点放行；未到点抛 { kind: 'rate_limit_local', retryAfter } 形态错误。 */
  async acquire(endpointId: string): Promise<void> {
    const until = await readCooldown(this.store, endpointId)
    const now = this.clock()
    if (until > now) {
      const e = new Error(`本地限频冷却中：${endpointId} 于 ${new Date(until).toISOString()} 前不可调用`) as RateLimitLocalError
      e.kind = 'rate_limit_local'
      e.retryAfter = until - now
      throw e
    }
  }

  /** 命中远端限频后写冷却：now + seconds 秒内不再调用该 endpoint。 */
  async penalize(endpointId: string, seconds: number): Promise<void> {
    // 必须用 hasOwn —— 与 limitFor 同理，防原型链键。显式 null 才免罚；
    // 未登记（hasOwn false）视为未知接口，远端说限频就限频。
    // ⚠️ 实参必须是 endpoint id（见类注释）：传 task id 会让这条豁免恒不触发。
    if (Object.hasOwn(RATE_LIMITS, endpointId) && RATE_LIMITS[endpointId] === null) return
    const now = this.clock()
    await this.store.transaction((tx) => writeCooldown(tx, endpointId, now + seconds * 1000, { now: this.clock }))
  }
}
