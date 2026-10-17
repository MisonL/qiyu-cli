// src/core/time.ts
// Asia/Shanghai 自然日对齐与时间参数解析（**唯一定义点**）。
// G2/§6.2 联动：`--since/--until` 的日期按上海零点解析、报表日期列按上海天对齐、
// attendance/performance 的 endTime 上限是「昨天 00:00」——三处必须同源，否则
// 「同一业务日」在不同层得到不同的毫秒值（A 中-2 的键分裂根因）。
// E 起 `query/` 与 `sync/` 共用本模块（query 不得 import sync，故下沉 core）。
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

const SHANGHAI_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
})

/** 毫秒 → 上海时区的 ISO 回显（resolved_range/watermark 的输出形态，spec §九.3）。 */
export function shanghaiIso(ms: number): string {
  const shifted = new Date(ms + SHANGHAI_OFFSET_MS)
  // 整秒时省略毫秒段（spec 示例形态 "2026-09-14T00:00:00+08:00"）；带毫秒保留
  const iso = shifted.toISOString()
  const msPart = shifted.getUTCMilliseconds()
  return (msPart === 0 ? iso.replace('.000Z', 'Z') : iso).replace('Z', '+08:00')
}

/**
 * 时间值 → 上海 ISO（**全命令层统一的时间回显口径**，E 中-2/C-11）。
 * 入参可能是引擎产出的 epoch 毫秒（number 或数字字符串），也可能是 ISO 8601
 * 字符串（`iso-day`/`iso-instant` 列的 MIN/MAX 形态）——两者都统一为 +08:00 ISO；
 * 无法解析为时间的字符串原样回显（非时间值不吞掉）。
 * gap 的 range 此前直接输出毫秒字符串，与 resolved_range 的 +08:00 ISO 形态不一致，
 * Agent 得按字段各写一套解析——本函数是两侧的同一落点。
 */
export function msToShanghaiIso(v: string | number): string {
  const numeric = typeof v === 'number' ? v : Number(v)
  const n = Number.isFinite(numeric) ? numeric : Date.parse(String(v))
  return Number.isFinite(n) && String(v).trim() !== '' ? shanghaiIso(n) : String(v)
}

/** 上海自然日 00:00 → epoch 毫秒（YYYY-MM-DD）。 */
function shanghaiMidnightUtc(y: number, m: number, d: number): number {
  return Date.UTC(y, m - 1, d) - SHANGHAI_OFFSET_MS
}

/** 上海时区的「今天」日期键（YYYY-MM-DD）。 */
function shanghaiToday(clock: () => number): string {
  return SHANGHAI_DAY.format(new Date(clock()))
}

/**
 * 时间参数解析（spec §九.3：相对时间与日期按 Asia/Shanghai 解析，回显 resolved_range）：
 *   · Nd（如 30d）→ 相对时长：end=clock 当前、start=end−N 天（纯时长与时区无关，
 *     按上海自然日切分由引擎窗口逻辑吸收）；
 *   · yesterday → 上海昨天的 00:00（单日窗）；
 *   · YYYY-MM-DD → 上海当天 00:00；
 *   · 其余（完整 ISO 8601）→ Date.parse，NaN 视为用法错误。
 */
export function parseTimeArg(arg: string, clock: () => number,
  label: string): { start: number; end: number } | number | null {
  void label
  const dur = /^(\d+)d$/.exec(arg)
  if (dur) {
    const end = clock()
    return { start: end - Number(dur[1]) * DAY_MS, end }
  }
  if (arg === 'yesterday') {
    // 上海昨天 00:00 ~ 今天 00:00 的单日窗
    const today = shanghaiToday(clock)
    const [ty, tm, td] = today.split('-').map(Number) as [number, number, number]
    const todayStart = shanghaiMidnightUtc(ty, tm, td)
    return { start: todayStart - DAY_MS, end: todayStart }
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(arg)
  if (date) return shanghaiMidnightUtc(Number(date[1]), Number(date[2]), Number(date[3]))
  const full = Date.parse(arg)
  if (!Number.isNaN(full)) return full
  return null   // 解析失败 → 调用方 usage
}
