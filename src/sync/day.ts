// src/sync/day.ts
// Asia/Shanghai 自然日对齐（天数换算的唯一定义点）。
// G2/§6.2 联动：`--since/--until` 的日期按上海零点解析、报表日期列按上海天对齐、
// attendance/performance 的 endTime 上限是「昨天 00:00」——三处必须同源，否则
// 「同一业务日」在不同层得到不同的毫秒值（A 中-2 的键分裂根因）。
// Asia/Shanghai 无夏令时（恒 +08:00），固定偏移即可精确换算，无 Intl 依赖。
/** 上海固定偏移（毫秒）。 */
export const SHANGHAI_OFFSET_MS = 8 * 3_600_000
/** 一天的毫秒数。 */
export const DAY_MS = 86_400_000

/** 毫秒 → 所属上海自然日 00:00 的 epoch 毫秒。 */
export function shanghaiDayStart(ms: number): number {
  return Math.floor((ms + SHANGHAI_OFFSET_MS) / DAY_MS) * DAY_MS - SHANGHAI_OFFSET_MS
}

/**
 * 毫秒 → 上海「昨天 00:00」的 epoch 毫秒。
 * attendance/performance 的 `endTime` 不得晚于今天 00:00（`14501 endTime is invalid`），
 * 且实测「今天 0:00」这条边界不稳定（同一取值时而 200 时而 14501，设计稿 §6.2）——
 * 统一退到昨天 0:00 留整日余量：当天数据不做（次日自动补上），绝不贴着边界。
 */
export function shanghaiYesterdayStart(nowMs: number): number {
  return shanghaiDayStart(nowMs) - DAY_MS
}

/** 天对齐值 → ISO 字符串（与 deleteRangeInsert 的范围值同形——报表日期列的唯一形态）。 */
export function shanghaiDayIso(ms: number): string {
  return new Date(shanghaiDayStart(ms)).toISOString()
}
