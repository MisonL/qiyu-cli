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

  it('非法日历日期拒绝而非静默进位（正确性 P1 / edge F4）', () => {
    // Date.UTC 会把越界月/日进位：2026-02-30 → 03-02、2026-13-45 → 2027-02-14；
    // 0–99 年被映射到 1900+。旧实现带着进位后的区间一路走到底、退出码 0 无警告。
    for (const bad of ['2026-02-30', '2026-09-31', '2026-13-45', '2026-00-01', '0000-01-01', '2026-04-31']) {
      expect(parseTimeArg(bad, () => T, '--since'), bad).toBeNull()
    }
    // 合法边界不误拒：闰年 2/29、月首月末
    expect(typeof parseTimeArg('2024-02-29', () => T, '--since')).toBe('number')
    expect(typeof parseTimeArg('2026-12-31', () => T, '--since')).toBe('number')
    expect(typeof parseTimeArg('2026-01-01', () => T, '--since')).toBe('number')
  })

  it('无时区后缀的 ISO 按 +08:00 解释，不随进程时区漂移（edge F5）', () => {
    // 与带偏移量的显式形态必须同值：不再依赖 Date.parse 的「本机时区」语义。
    // （CI 机器常为 TZ=UTC：旧实现在那里会把 12:00 读成 UTC 12:00，偏 8 小时。）
    expect(parseTimeArg('2026-09-15T12:00:00', () => T, '--since')).toBe(Date.UTC(2026, 8, 15, 4))
    expect(parseTimeArg('2026-09-15T12:00:00+08:00', () => T, '--since')).toBe(Date.UTC(2026, 8, 15, 4))
    // 秒可省略（HH:MM 形态）；带 Z 的仍按 UTC
    expect(parseTimeArg('2026-09-15T12:00', () => T, '--since')).toBe(Date.UTC(2026, 8, 15, 4))
    expect(parseTimeArg('2026-09-15T12:00:00Z', () => T, '--since')).toBe(Date.UTC(2026, 8, 15, 12))
  })

  it('非 ISO 形态一律拒绝，不落到 Date.parse 的遗留解析器（CodeRabbit 终审 minor）', () => {
    // V8 的 Date.parse 接受 `2026/09/15`、`Sep 15 2026` 这类非 ISO 写法，并按**进程时区**
    // 解释 —— 与 F5 同一个缺陷的另一扇门（TZ=UTC 的 CI 上偏 8 小时），而且退出码 0
    // 无警告。契约只承诺 ISO 8601，其余必须 usage 拒绝。
    for (const bad of [
      '2026/09/15', '2026/09/15 12:00', 'Sep 15 2026', '15 Sep 2026',
      '2026-09-15T12', '2026-9-15', 'September 15, 2026', '20260915',
    ]) {
      expect(parseTimeArg(bad, () => T, '--since'), bad).toBeNull()
    }
    // 契约内的形态仍然全部接受
    for (const ok of [
      '2026-09-15', '2026-09-15T12:00', '2026-09-15T12:00:00',
      '2026-09-15T12:00:00Z', '2026-09-15T12:00:00+08:00', '2026-09-15T12:00:00+0800',
      '2026-09-15 12:00:00Z',
    ]) {
      expect(typeof parseTimeArg(ok, () => T, '--since'), ok).toBe('number')
    }
  })

  it('msToShanghaiIso 输出 +08:00', () => {
    expect(msToShanghaiIso(T)).toBe('2026-09-15T12:00:00+08:00')
    expect(msToShanghaiIso('2026-09-14T16:00:00.000Z')).toBe('2026-09-15T00:00:00+08:00')
  })

  it('日期分支按上海零点解析，且断言具体值而非仅类型（测试审查 F8）', () => {
    expect(parseTimeArg('2026-09-15', () => T, '--since')).toBe(Date.UTC(2026, 8, 14, 16))
    expect(parseTimeArg('2024-02-29', () => T, '--since')).toBe(Date.UTC(2024, 1, 28, 16))
  })

  it('带时刻的 ISO 也回验日历日，不静默进位（正确性审查 F7）', () => {
    // Date.parse 会把 2/30 进位成 3/2、4/31 进位成 5/1 —— 与纯日期分支同一类缺陷。
    for (const bad of [
      '2026-02-30T00:00:00', '2026-04-31T00:00:00',
      '2026-02-30T00:00:00Z', '2026-02-30T00:00:00+08:00',
    ]) {
      expect(parseTimeArg(bad, () => T, '--since'), bad).toBeNull()
    }
  })

  it('超出 Date 表示范围的值不抛 RangeError，原样回显（正确性审查 F4）', () => {
    // 库里一条微秒级脏值（1792467000000000000）曾让 db tables 整条命令 internal 失败。
    expect(msToShanghaiIso('1792467000000000000')).toBe('1792467000000000000')
    expect(msToShanghaiIso(8.7e15)).toBe('8700000000000000')
    // 超大相对时长同样回 usage，而不是崩到 internal
    expect(parseTimeArg('999999999d', () => T, '--since')).toBeNull()
  })
})
