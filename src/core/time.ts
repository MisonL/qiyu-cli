// src/core/time.ts
// Asia/Shanghai 自然日对齐与时间参数解析（**唯一定义点**）。
// G2/§6.2 联动：`--since/--until` 的日期按上海零点解析、报表日期列按上海天对齐、
// attendance/performance 的 endTime 上限是「昨天 00:00」——三处必须同源，否则
// 「同一业务日」在不同层得到不同的毫秒值（A 中-2 的键分裂根因）。
// E 起 `query/` 与 `sync/` 共用本模块（query 不得 import sync，故下沉 core）。
// Asia/Shanghai 无夏令时（恒 +08:00）：自然日对齐用固定偏移、不依赖 Intl；
// `shanghaiToday` 例外用 Intl 取上海日期键。
/** 上海固定偏移（毫秒）。 */
export const SHANGHAI_OFFSET_MS = 8 * 3_600_000
/** 一天的毫秒数。 */
export const DAY_MS = 86_400_000
/**
 * ECMAScript Date 可表示的最大绝对毫秒（±8.64e15，约 ±27.5 万年）。
 * 超出后 `toISOString()` 抛 `RangeError: Invalid time value` —— 一条微秒级脏值
 * （`1792467000000000000`）就能让 `db tables` 整条命令 internal 失败（正确性审查 F4）。
 */
export const MAX_DATE_MS = 8.64e15

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
  // ⚠️ 越界值原样回显（正确性审查 F4）：`toISOString()` 对 |ms| > 8.64e15 抛 RangeError，
  // 而调用点可能拿到库里的脏值（微秒误写）或用户给的超大 `--since 999999999d`。
  // 抛异常会让整条命令 internal 失败；回显原始数字至少保住「可解释」。
  if (!Number.isFinite(ms) || Math.abs(ms) > MAX_DATE_MS) return String(ms)
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
 * ⚠️ ISO 分支只接受带时区的 ISO 8601 字符串；日期-only（`YYYY-MM-DD`）会被
 * `Date.parse` 按 UTC 解析、再偏 8 小时——调用方不得喂日期-only 值。
 * gap 的 range 此前直接输出毫秒字符串，与 resolved_range 的 +08:00 ISO 形态不一致，
 * Agent 得按字段各写一套解析——本函数是两侧的同一落点。
 */
export function msToShanghaiIso(v: string | number): string {
  const numeric = typeof v === 'number' ? v : Number(v)
  const n = Number.isFinite(numeric) ? numeric : Date.parse(String(v))
  // 越界值不抛 RangeError（正确性审查 F4）：库里一条微秒级脏值不应炸掉整条 db tables。
  if (!Number.isFinite(n) || Math.abs(n) > MAX_DATE_MS) return String(v)
  return String(v).trim() !== '' ? shanghaiIso(n) : String(v)
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
    // ⚠️ 带相对时长的 `--since` 也要挡住溢出（正确性审查 F4）：
    // `999999999d` 的 `end − N×DAY_MS` 远出 Date 范围，后续 `shanghaiIso` 会抛 RangeError。
    // 与 ISO 分支同一上界，回到「未知 ≠ 猜」（usage）而不是崩到 internal。
    const start = end - Number(dur[1]) * DAY_MS
    if (!Number.isFinite(start) || Math.abs(start) > MAX_DATE_MS) return null
    return { start, end }
  }
  if (arg === 'yesterday') {
    // 上海昨天 00:00 ~ 今天 00:00 的单日窗
    const today = shanghaiToday(clock)
    const [ty, tm, td] = today.split('-').map(Number) as [number, number, number]
    const todayStart = shanghaiMidnightUtc(ty, tm, td)
    return { start: todayStart - DAY_MS, end: todayStart }
  }
  const date = /^(\d{4})-(\d{2})-(\d{2})$/.exec(arg)
  if (date) {
    const y = Number(date[1])
    const m = Number(date[2])
    const d = Number(date[3])
    // ⚠️ 回验（正确性 P1 / edge F4）：`Date.UTC` 会把越界的月/日**静默进位**
    // （2026-02-30 → 2026-03-02、2026-13-45 → 2027-02-14），也会把 0–99 年映射到
    // 1900+（0000-01-01 → 1900-01-01）。旧实现直接返回进位结果、退出码 0 且无警告：
    // Agent 拿到一条与输入对不上的区间，甚至把「输入了不存在的日期」误读成「同步缺口」。
    // 回验不一致即视为无法解析（红线 3「未知 ≠ 猜」），由调用方走 usage。
    const ms = shanghaiMidnightUtc(y, m, d)
    const back = new Date(ms + SHANGHAI_OFFSET_MS)
    if (back.getUTCFullYear() !== y || back.getUTCMonth() + 1 !== m || back.getUTCDate() !== d) {
      return null
    }
    return ms
  }
  // ⚠️ 无时区后缀的 ISO 必须显式按 Asia/Shanghai 解释（edge F5）：`Date.parse` 对
  // 无偏移量的 ISO 使用**进程时区**，在 CI（常为 UTC）上同一输入会偏 8 小时，
  // 而本 CLI 的全部时间语义是 Asia/Shanghai（spec §三），且偏了没有任何警告。
  //
  // ⚠️ 且只接受**两种 ISO 形态**（CodeRabbit 终审 minor）：`Date.parse` 的遗留解析器
  // 还接受 `2026/09/15`、`Sep 15 2026` 这类非 ISO 写法，并按进程时区解释 ——
  // 同一个 F5 缺陷的另一扇门。契约（README / --help）只承诺 ISO 8601，故其余一律拒绝。
  const tzless = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(arg)
  const zoned = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/i.test(arg)
  if (!tzless && !zoned) return null
  // ⚠️ 带时刻的 ISO 同样要回验日历日（正确性审查 F7）：`Date.parse('2026-02-30T00:00:00')`
  // 静默进位成 3/2，退出码 0 —— 与纯日期分支已修的那类缺陷是同一扇门的另一半。
  // 回验的是**日期字段**（年/月/日）；时刻字段（24:00、60 秒）由下面的 Number 范围校验兜。
  const ymd = /^(\d{4})-(\d{2})-(\d{2})/.exec(arg)
  if (ymd) {
    const y = Number(ymd[1]); const m = Number(ymd[2]); const d = Number(ymd[3])
    const probe = new Date(Date.UTC(y, m - 1, d))
    if (probe.getUTCFullYear() !== y || probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== d) {
      return null
    }
  }
  const full = Date.parse(tzless ? `${arg.replace(' ', 'T')}+08:00` : arg.replace(' ', 'T'))
  if (Number.isNaN(full) || Math.abs(full) > MAX_DATE_MS) return null
  return full   // 解析失败 → 调用方 usage
}
