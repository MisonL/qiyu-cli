/**
 * 同步引擎窗口切分纯函数（spec §6.1）。
 * Range 为半开区间 [start, end)，毫秒时间戳。
 */

export type Range = { start: number; end: number }

/**
 * 把范围按 maxWindowDays 切成若干窗。
 * - 步长 = maxWindowDays − overlapDays，窗宽 = maxWindowDays；
 * - 末窗收边：end 不超过 range.end；
 * - 终止条件：当前窗的重叠端（end − overlap）已覆盖到 range.end，即相邻窗口
 *   在整个 range 上都确立了重叠保证；若末窗被截断导致重叠端差一截，则从
 *   end − overlap 再补一窗，直至无前进空间（防死循环）。
 */
export function sliceByMaxWindow(range: Range, maxWindowDays: number, overlapDays: number): Range[] {
  const windowMs = maxWindowDays * 86_400_000
  const overlapMs = overlapDays * 86_400_000
  if (overlapMs >= windowMs) {
    throw new RangeError(`overlapDays 必须小于 maxWindowDays：${overlapDays} >= ${maxWindowDays}`)
  }
  const windows: Range[] = []
  let start = range.start
  while (start < range.end) {
    const end = Math.min(start + windowMs, range.end)
    windows.push({ start, end })
    // 重叠端已覆盖到 range.end → 收尾；否则从重叠端起下一窗
    if (end - overlapMs >= range.end) break
    const nextStart = end - overlapMs
    // 无前进空间（末窗截断后反复补窗会原地打转）→ 终止
    if (nextStart <= start) break
    start = nextStart
  }
  return windows
}

