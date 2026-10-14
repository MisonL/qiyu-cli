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
    if (Object.hasOwn(RATE_LIMITS, endpointId) && RATE_LIMITS[endpointId] === null) return
    const now = this.clock()
    await this.store.transaction((tx) => writeCooldown(tx, endpointId, now + seconds * 1000, { now: this.clock }))
  }
}
