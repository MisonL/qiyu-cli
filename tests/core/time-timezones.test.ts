// tests/core/time-timezones.test.ts —— §12 第三条：三时区跑组
//
// **守的是什么**：本 CLI 的全部时间语义是 Asia/Shanghai（spec §三）。`parseTimeArg` 的
// 纯日期/无偏移 ISO 分支若偷用**进程本机时区**，同一输入在 CI（多为 TZ=UTC）与本机
// （Asia/Shanghai）上会差 8 小时，而且退出码 0、没有任何警告 —— 这类缺陷在单时区
// 测试里**永远看不见**（edge F5 就是这么活过一个版本的）。
//
// 本文件把同一组用例在三个时区下各跑一遍，断言结论逐字一致。
//
// ⚠️ **先证明时区切换真的生效**：`process.env.TZ` 只在 Node 重新读取时才影响 `Date`
// ——若某运行时/平台忽略这次赋值，三个时区会得到同一份「本机答案」，下面的相等断言
// 就退化成恒真（"三个都一样"其实只是"根本没切"）。所以每个时区在跑用例**之前**
// 先探测本机小时数，对不上就当场响亮失败，而不是安静地考一张必然满分的卷子。
//
// ⚠️ **再证明用例挑得对**：另有一条断言要求这组用例对时区**敏感**（三个时区下本机
// 日历日不全相同）。否则即使切换生效，用例也可能恰好落在三个时区同一天的区间里，
// 一致断言同样没牙。两条自检一起，才让「结论一致」这句话有意义。

import { describe, it, expect } from 'vitest'
import {
  shanghaiIso, shanghaiDayStart, shanghaiDayIso, shanghaiYesterdayStart,
  parseTimeArg, msToShanghaiIso, MAX_DATE_MS,
} from '../../src/core/time.js'

const ZONES = ['Asia/Shanghai', 'UTC', 'America/New_York'] as const
type Zone = (typeof ZONES)[number]

/**
 * 探测时刻：UTC 2026-09-15 12:00。
 * 三时区下的本机小时数互不相同（20 / 12 / 8），任何一个「没切成功」都会立刻露馅。
 * 9 月选的是纽约的夏令时（EDT, UTC−4）——顺带覆盖一条非整点偏移。
 */
const PROBE_MS = Date.UTC(2026, 8, 15, 12)
const EXPECTED_LOCAL_HOUR: Record<Zone, number> = {
  'Asia/Shanghai': 20,   // UTC+8
  UTC: 12,               // UTC+0
  'America/New_York': 8, // UTC−4（EDT）
}

/** 在指定时区下执行 fn；fn 执行前先确认切换生效，结束后无条件恢复原值。 */
function inZone<R>(tz: Zone, fn: () => R): R {
  const prev = process.env.TZ
  process.env.TZ = tz
  try {
    expect(process.env.TZ).toBe(tz)
    const hour = new Date(PROBE_MS).getHours()
    expect(
      hour,
      `进程时区切换未生效：TZ=${tz} 时 ${new Date(PROBE_MS).toISOString()} 的本机小时仍是 ` +
        `${hour}（期望 ${EXPECTED_LOCAL_HOUR[tz]}）。此时本文件的一致性断言会退化成恒真，` +
        '请改用一个能真正生效的时区注入方式（例如按 TZ 分进程跑）。',
    ).toBe(EXPECTED_LOCAL_HOUR[tz])
    return fn()
  } finally {
    // `prev === undefined` 时不能赋 undefined —— 那会写出字符串 "undefined"，
    // 让后续用例活在一个不存在的时区里（Node 会静默回退到 UTC）。
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
}

const T1 = Date.UTC(2026, 8, 15, 4)        // 上海 09-15 12:00（纽约 09-15 00:00）
const T2 = Date.UTC(2026, 8, 15, 20)       // 上海 09-16 04:00（纽约 09-15 16:00）—— 跨日
const T3 = Date.UTC(2026, 0, 1, 0, 30)     // 上海 2026-01-01 08:30（纽约 2025-12-31 19:30）—— 跨年
const DAY_MS = 86_400_000

/**
 * 用例表：`expected` 全部写成显式字面量（不是"跟另一个时区的结果比"），
 * 这样既钉住「三时区一致」，也钉住「一致的那个值本身是对的」。
 */
const CASES: ReadonlyArray<{ label: string; run: () => unknown; expected: unknown }> = [
  // ——— yesterday：按**上海**日历日回退，不是按本机 ———
  // T2 是关键格子：上海已是 09-16，纽约还是 09-15。用本机日期的实现会在纽约返回
  // [09-14T04:00Z, 09-15T04:00Z)，与本表的期望差出一整天。
  { label: 'yesterday @ 上海 09-15', run: () => parseTimeArg('yesterday', () => T1, '--since'),
    expected: { start: Date.UTC(2026, 8, 13, 16), end: Date.UTC(2026, 8, 14, 16) } },
  { label: 'yesterday @ 上海 09-16（纽约仍是 09-15）', run: () => parseTimeArg('yesterday', () => T2, '--since'),
    expected: { start: Date.UTC(2026, 8, 14, 16), end: Date.UTC(2026, 8, 15, 16) } },
  { label: 'yesterday @ 上海 2026-01-01（纽约还在 2025-12-31）', run: () => parseTimeArg('yesterday', () => T3, '--since'),
    expected: { start: Date.UTC(2025, 11, 30, 16), end: Date.UTC(2025, 11, 31, 16) } },

  // ——— 纯日期：上海零点，与进程时区无关 ———
  { label: '日期 2026-09-15', run: () => parseTimeArg('2026-09-15', () => T1, '--since'),
    expected: Date.UTC(2026, 8, 14, 16) },
  // 3/8 与 11/1 是纽约夏令时的起止日：本机那天不是 23 小时就是 25 小时，
  // 用本机零点做算术的实现会在这里偏一小时（上海无夏令时，恒 24 小时）。
  { label: '日期 2026-03-08（纽约 DST 开始日）', run: () => parseTimeArg('2026-03-08', () => T1, '--since'),
    expected: Date.UTC(2026, 2, 7, 16) },
  { label: '日期 2026-11-01（纽约 DST 结束日）', run: () => parseTimeArg('2026-11-01', () => T1, '--since'),
    expected: Date.UTC(2026, 9, 31, 16) },
  // 纽约夏令时切换当天 02:30 是个**不存在的本地时刻**；本用例按 +08:00 解释，
  // 因此不该受这种本机怪相影响。
  { label: '日期 2026-03-08（同上，作为 --until）', run: () => parseTimeArg('2026-03-08', () => T1, '--until'),
    expected: Date.UTC(2026, 2, 7, 16) },

  // ——— 带时刻的 ISO ———
  { label: '无偏移 ISO 按 +08:00', run: () => parseTimeArg('2026-09-15T12:00:00', () => T1, '--since'),
    expected: Date.UTC(2026, 8, 15, 4) },
  { label: 'Z 后缀按 UTC', run: () => parseTimeArg('2026-09-15T12:00:00Z', () => T1, '--since'),
    expected: Date.UTC(2026, 8, 15, 12) },
  { label: '显式 −05:00 偏移', run: () => parseTimeArg('2026-09-15T12:00:00-05:00', () => T1, '--since'),
    expected: Date.UTC(2026, 8, 15, 17) },
  { label: '空格分隔 + Z', run: () => parseTimeArg('2026-09-15 12:00:00Z', () => T1, '--since'),
    expected: Date.UTC(2026, 8, 15, 12) },

  // ——— 相对时长：纯时长，与时区无关 ———
  { label: '30d', run: () => parseTimeArg('30d', () => T1, '--since'),
    expected: { start: T1 - 30 * DAY_MS, end: T1 } },

  // ——— 拒绝路径不能因为时区不同而变成接受 ———
  { label: '非法日历日 2026-02-30', run: () => parseTimeArg('2026-02-30', () => T1, '--since'), expected: null },
  { label: '非 ISO 2026/09/15', run: () => parseTimeArg('2026/09/15', () => T1, '--since'), expected: null },

  // ——— 回显与日对齐 ———
  { label: 'shanghaiIso(T1)', run: () => shanghaiIso(T1), expected: '2026-09-15T12:00:00+08:00' },
  { label: 'shanghaiDayStart(T2)', run: () => shanghaiDayStart(T2), expected: Date.UTC(2026, 8, 15, 16) },
  { label: 'shanghaiDayIso(T2)', run: () => shanghaiDayIso(T2), expected: '2026-09-15T16:00:00.000Z' },
  { label: 'shanghaiYesterdayStart(T2)', run: () => shanghaiYesterdayStart(T2), expected: Date.UTC(2026, 8, 14, 16) },
  { label: 'msToShanghaiIso(epoch 字符串)', run: () => msToShanghaiIso(String(T1)), expected: '2026-09-15T12:00:00+08:00' },
  { label: 'msToShanghaiIso(带 Z 的 ISO)', run: () => msToShanghaiIso('2026-09-15T12:00:00Z'), expected: '2026-09-15T20:00:00+08:00' },
  { label: '越界值原样回显（不抛）', run: () => shanghaiIso(MAX_DATE_MS), expected: String(MAX_DATE_MS) },
]

describe('§12 第三条：同一组时间用例在三时区下结论一致', () => {
  it('探测：进程时区切换在本运行时确实生效（三个时区给出三个不同本机小时）', () => {
    const hours = ZONES.map((tz) => inZone(tz, () => new Date(PROBE_MS).getHours()))
    expect(hours).toEqual(['Asia/Shanghai', 'UTC', 'America/New_York'].map((tz) => EXPECTED_LOCAL_HOUR[tz as Zone]))
    // 探测值互不相同 —— 否则「切换未生效」这种失败会被下面的一致性断言悄悄吞掉。
    expect(new Set(hours).size, `三时区本机小时全为 ${hours[0]}，探测时刻挑得不对`).toBe(ZONES.length)
  })

  it.each(ZONES)('%s 下逐条命中期望值', (tz) => {
    const values = inZone(tz, () => CASES.map((c) => c.run()))
    CASES.forEach((c, i) => expect(values[i], `${tz} · ${c.label}`).toEqual(c.expected))
  })

  it('三个时区的结果逐字一致', () => {
    const runs = ZONES.map((tz) => inZone(tz, () => CASES.map((c) => c.run())))
    expect(runs[1]).toEqual(runs[0]) // UTC
    expect(runs[2]).toEqual(runs[0]) // America/New_York
  })

  it('这组用例对进程时区敏感（否则上一条只是「没切也在比」）', () => {
    // T2 在三个时区下的**本机**日历日不全相同（上海 09-16；UTC / 纽约 09-15）。
    // 若实现偷用本机日期，`yesterday` 至少会在一个时区里算错一天 —— 这正是本文件的用例
    // 想抓住的形态。三时区同一天则说明用例挑错了，一致性断言将失去判别力。
    const localDays = ZONES.map((tz) => inZone(tz, () => {
      const d = new Date(T2)
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }))
    expect(new Set(localDays).size, `三时区本机日期全为 ${localDays[0]}，用例组挑得不对`).toBeGreaterThan(1)
    // 且「上海日期」与至少一个其他时区的本机日期不同 —— 与 CASES 里 T2 那条互为印证。
    expect(localDays[0]).toBe('2026-09-16')
  })

  it('结束时不留残余时区（后续测试文件不该继承本文件的 TZ）', () => {
    const prev = process.env.TZ
    const seen = inZone('UTC', () => process.env.TZ)
    expect(seen).toBe('UTC')
    expect(process.env.TZ).toBe(prev)
  })
})
