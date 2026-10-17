import { describe, it, expect } from 'vitest'
import { shanghaiDayStart, parseTimeArg, msToShanghaiIso } from '../../src/core/time.js'

const T = Date.UTC(2026, 8, 15, 4, 0, 0)   // 上海 2026-09-15 12:00
describe('core/time —— 上海时间（E 与 D 同源）', () => {
  it('shanghaiDayStart 按上海零点对齐', () => {
    expect(new Date(shanghaiDayStart(T)).toISOString()).toBe('2026-09-14T16:00:00.000Z')
  })
  it('parseTimeArg：Nd / yesterday / YYYY-MM-DD / ISO / 非法', () => {
    expect(parseTimeArg('30d', () => T, '--since')).toEqual({ start: T - 30 * 86_400_000, end: T })
    // yesterday 是唯一走 Intl 日期键 + 字符串拆分的分支：上海 9/15 12:00 → 上海 9/14 零点窗
    expect(parseTimeArg('yesterday', () => T, '--since')).toEqual({
      start: Date.UTC(2026, 8, 13, 16), end: Date.UTC(2026, 8, 14, 16),
    })
    expect(typeof parseTimeArg('2026-09-15', () => T, '--since')).toBe('number')
    expect(parseTimeArg('2026-09-15T00:00:00+08:00', () => T, '--since')).toBe(Date.UTC(2026, 8, 14, 16))
    expect(parseTimeArg('不是时间', () => T, '--since')).toBeNull()
  })
  it('msToShanghaiIso 输出 +08:00', () => {
    expect(msToShanghaiIso(T)).toBe('2026-09-15T12:00:00+08:00')
    expect(msToShanghaiIso('2026-09-14T16:00:00.000Z')).toBe('2026-09-15T00:00:00+08:00')
  })
})
