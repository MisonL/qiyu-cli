import { describe, it, expect } from 'vitest'
import { sliceByMaxWindow, mergeRanges } from '../../src/sync/windowing.js'

const DAY = 86_400_000

describe('窗口切分（spec §6.1）', () => {
  it('31 天范围按 maxWindowDays=31 切出 1 窗', () => {
    const r = sliceByMaxWindow({ start: 0, end: 31 * DAY }, 31, 0)
    expect(r).toEqual([{ start: 0, end: 31 * DAY }])
  })
  it('63 天按 31 天切 3 窗，含重叠 1 天则 4 窗且相邻重叠', () => {
    const r = sliceByMaxWindow({ start: 0, end: 63 * DAY }, 31, 1)
    expect(r.length).toBe(4)
    expect(r[1].start).toBe(r[0].end - 1 * DAY)
    expect(r.every(w => w.end - w.start <= 31 * DAY)).toBe(true)
  })
  it('90 天诱惑场景：op 窗口按 31 切（不是 89）', () => {
    const r = sliceByMaxWindow({ start: 0, end: 90 * DAY }, 31, 0)
    expect(r.length).toBe(3)
  })
  it('mergeRanges 合并相邻与重叠、保留缝隙', () => {
    expect(mergeRanges([{ start: 0, end: 5 }, { start: 5, end: 9 }, { start: 20, end: 25 }]))
      .toEqual([{ start: 0, end: 9 }, { start: 20, end: 25 }])
  })
})
