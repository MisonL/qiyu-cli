// tests/query-field-notes.test.ts —— `query` 的 9 个 meta 键必须有释义，且释义不得与事实相反
// （2026-10-27）。
//
// 背景：`query` 是 skill 协议指定的主查询入口，而它的 meta 此前**一条释义都没有**
// （README 有散文，但 Agent 读的是 stdout）。逐格真库实测发现三处字面陷阱：
//   · `masked: true` ≠ 「有值被改写」—— 脱敏开着而 `masked_columns: []` 是常态；
//   · `mask_warnings: []` ≠ 「脱敏完整」—— `--no-mask` 时恒为空，风险警告在 `warnings` 里；
//   · `data_coverage` 只有首尾两点，看不见内部缺口 —— 且只有 iso-day 表有 warnings 兜底，
//     iso-instant / epoch-ms 表没有任何提示（实测 epoch-ms 空 6 天仍报满区间、warnings: []）。
//
// 本文件把**图例**、**真实输出键集**与**四种/三种 null 成因**都钉在真跑出来的结果上。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { queryCommand } from '../src/commands/query.js'
import { createDuckDbStore } from '../src/store/duckdb.js'
import { NO_MASK_WARNING } from '../src/query/mask.js'
import {
  queryFieldNotes,
} from '../src/commands/query-notes.js'
import type { Store } from '../src/store/types.js'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
const DAY = 86_400_000

vi.setConfig({ testTimeout: 30_000 })

let dir = ''
let out = ''
let err = ''
const dbPath = (): string => join(dir, 'q.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-qnotes-'))
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
  vi.stubEnv('HOME', dir) // 隔离真实 ~
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const parsed = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const meta = (): Record<string, unknown> => parsed().meta as Record<string, unknown>
const notes = (): Record<string, string> => meta().field_notes as Record<string, string>

async function q(...args: string[]): Promise<number> {
  out = ''; err = ''
  return queryCommand([...args, '--db', dbPath()])
}

/** 2026 年 10 月的第 day 天 → 存入 iso-day 列的 UTC 瞬时形态（上海日零点 = 前一日 16:00Z）。 */
const dayIso = (day: number): string => new Date(Date.UTC(2026, 9, day) - 8 * 3600_000).toISOString()

/**
 * 合成库：
 *  · daily_overview（iso-day）：10-01 / 10-02 / 10-07 —— 中间 10-03..06 是空洞
 *  · sessions（epoch-ms）：09-01 与 09-07 —— 中间 6 天空洞
 *  · tags（无时间列）：1 行
 *  · staff_workload（iso-day）：**空表**（「只给 --until 而时间列无可用值」用）
 */
async function seed(): Promise<void> {
  const s: Store = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  try {
    await s.init()
    await s.upsert('daily_overview', [
      { stat_date: dayIso(1), payload: '{}', synchronized_at: null },   // 10-01
      { stat_date: dayIso(2), payload: '{}', synchronized_at: null },   // 10-02
      { stat_date: dayIso(7), payload: '{}', synchronized_at: null },   // 10-07
    ])
    const base = Date.UTC(2026, 8, 1)
    await s.upsert('sessions', [
      { session_id: 's1', payload: '{}', staffId: '1000001', startTime: String(base),
        endTime: null, session_type: 'human', categoryDetail: null, userPhone: '13800001111',
        userName: '测试用户', userEmail: null, userAddress: null, fromIp: null, userIpCity: null,
        userCrmInfo: null, synchronized_at: null },
      { session_id: 's2', payload: '{}', staffId: '1000001', startTime: String(base + 6 * DAY),
        endTime: null, session_type: 'human', categoryDetail: null, userPhone: '13800001111',
        userName: '测试用户', userEmail: null, userAddress: null, fromIp: null, userIpCity: null,
        userCrmInfo: null, synchronized_at: null },
    ])
    await s.upsert('tags', [{ id: 't1', name: 'A', color: '#111111' }])
  } finally {
    await s.close()
  }
}

describe('图例本身：键集、形态与「不撒谎」的措辞', () => {
  it('图例覆盖全部 9 个键，且没有幽灵键（两个通道键集相同）', async () => {
    await seed()
    await q('--table', 'daily_overview')
    // ⚠️ 必须显式断言 field_notes 存在：把它从键集里过滤掉再比较，等于没断言它被挂上
    //（本文件初版就犯了这个错，删掉 --table 的 field_notes 时 17 条全绿）。
    expect(meta().field_notes, '--table 通道必须带 field_notes').toBeDefined()
    const tableKeys = Object.keys(meta()).sort()
    await q('--sql', 'SELECT * FROM daily_overview')
    expect(meta().field_notes, '--sql 通道必须带 field_notes').toBeDefined()
    const sqlKeys = Object.keys(meta()).sort()
    expect(sqlKeys, '两个通道的 meta 键集必须相同（图例只有一份）').toEqual(tableKeys)
    expect(['field_notes', ...Object.keys(queryFieldNotes())].sort(),
      '图例键集必须与真实 meta 键集一致（多一个 = 幽灵键，少一个 = 没释义）').toEqual(tableKeys)
  })

  it('field_notes 不带 Markdown 加粗、正文不含分隔符 `；`', () => {
    // 与 stats / skill / sync 同款约定：stdout JSON 给 Agent，`**` 是噪声；
    // `；` 是 renderNotes 的拼接符，正文里再出现会让反向解析多出幽灵取值（PR #26 踩过两次）。
    for (const [k, v] of Object.entries(queryFieldNotes())) {
      expect(v, `${k} 含 **`).not.toContain('**')
      expect(v, `${k} 含分隔符 ；`).not.toContain('；')
    }
  })

  it('三处字面陷阱的措辞都在（masked / mask_warnings / data_coverage）', () => {
    const n = queryFieldNotes()
    expect(n.masked, 'masked 必须说明「true 不代表有值被改写」').toContain('不代表「有值被改写」')
    expect(n.mask_warnings, 'mask_warnings 必须说明 --no-mask 时恒为空').toContain('--no-mask 时恒为空数组')
    expect(n.mask_warnings, '空 ≠ 脱敏完整').toContain('空不等于脱敏完整')
    expect(n.data_coverage, 'data_coverage 必须说明看不见内部缺口').toContain('看不见内部缺口')
    expect(n.data_coverage, '必须点名只有 iso-day 有兜底').toContain('iso-day 表另有 warnings 兜底')
    expect(n.data_coverage, '必须点名其余类型没有兜底').toContain('没有任何兜底')
    expect(n.resolved_range, 'resolved_range 是过滤边界不是数据范围').toContain('过滤边界')
  })

  it('README 与 skill 正文同步（人读版与 stdout 图例不得互相矛盾）', () => {
    const md = read('README.md')
    expect(md, 'README 必须点明 data_coverage 看不见内部缺口').toContain('看不见内部缺口')
    expect(md, 'README 必须点明 mask_warnings 在 --no-mask 时恒为空').toContain('恒为空')
    const p = read('src/skill/qiyu/protocols.md')
    expect(p, 'skill 不得再把 data_coverage 说成「实际覆盖范围」而不加限定')
      .not.toContain('本地数据的实际覆盖范围')
    expect(p, 'skill 必须点明 MIN/MAX 看不见内部缺口').toContain('看不见内部缺口')
  })
})

describe('resolved_range 的四种 null 成因（逐成因真库实测）', () => {
  it('图例必须把四种成因都写出来（少一种 = Agent 会把 null 误判成「没有过滤」）', () => {
    const n = queryFieldNotes().resolved_range
    expect(n).toContain('--sql 通道不判定区间')
    expect(n).toContain('没给 --since/--until')
    expect(n).toContain('表没有时间列')
    expect(n).toContain('只给 --until 而该表时间列无可用值')
    expect(n, '必须写明「四种」而不是笼统说 null').toContain('四种成因')
  })

  it('① --sql 通道：恒 null（同时 data_coverage 也恒 null）', async () => {
    await seed()
    await q('--sql', 'SELECT * FROM daily_overview')
    expect(meta().resolved_range).toBeNull()
    expect(meta().data_coverage, '--sql 通道两个字段都恒 null').toBeNull()
    expect(notes().resolved_range).toContain('--sql 通道不判定区间')
  })

  it('② 没给 --since/--until：null，但 data_coverage 仍是全表首尾', async () => {
    await seed()
    await q('--table', 'daily_overview')
    expect(meta().resolved_range).toBeNull()
    expect(meta().data_coverage).toEqual({
      min: '2026-10-01T00:00:00+08:00', max: '2026-10-07T00:00:00+08:00',
    })
  })

  it('③ 表没有时间列：null（且 --since 是用法错误）', async () => {
    await seed()
    expect(await q('--table', 'tags')).toBe(0)
    expect(meta().resolved_range).toBeNull()
    expect(meta().data_coverage).toBeNull()
    expect(await q('--table', 'tags', '--since', '2026-10-01'), '无时间列的表不接受 --since').toBe(2)
  })

  it('④ 只给 --until 且时间列无可用值：null，且 warnings 说明成因', async () => {
    await seed()
    expect(await q('--table', 'staff_workload', '--until', '2026-10-07')).toBe(0)
    expect(meta().resolved_range, '下界解析不出 → 区间不可回显').toBeNull()
    const w = meta().warnings as string[]
    expect(w.some((x) => x.includes('无法解析缺省下界')), '必须说明下界没解析出来').toBe(true)
  })
})

describe('data_coverage 的三种 null 成因', () => {
  it('图例必须把三种成因都写出来', () => {
    const n = queryFieldNotes().data_coverage
    expect(n).toContain('--sql 通道')
    expect(n).toContain('表没有时间列')
    expect(n).toContain('过滤范围内 0 行')
    expect(n, '必须写明「三种」').toContain('三种成因')
  })

  it('③ 过滤范围内 0 行：null（区间仍回显 —— 两个字段的 null 不同源）', async () => {
    await seed()
    await q('--table', 'daily_overview', '--since', '2026-11-01', '--until', '2026-11-02')
    expect(meta().data_coverage, '区间内没有行 → 没有 MIN/MAX 可报').toBeNull()
    expect(meta().resolved_range, '但过滤边界是已知的').toEqual([
      '2026-11-01T00:00:00+08:00', '2026-11-02T00:00:00+08:00',
    ])
  })
})

describe('三处字面陷阱的真库实证', () => {
  it('masked:true 与 masked_columns:[] 并存是常态（脱敏开着 ≠ 有值被改写）', async () => {
    await seed()
    await q('--table', 'daily_overview')
    expect(meta().masked).toBe(true)
    expect(meta().masked_columns, '非敏感列不产生改写').toEqual([])
    // 反证：查了敏感列才会有改写记录
    await q('--table', 'sessions')
    expect(meta().masked_columns).toContain('userPhone')
  })

  it('--no-mask 时 mask_warnings 恒为空，风险警告在 warnings 里（空 ≠ 脱敏完整）', async () => {
    await seed()
    await q('--table', 'sessions', '--no-mask')
    expect(meta().masked).toBe(false)
    expect(meta().mask_warnings, '没脱敏就没有「脱敏不完整」可言，但也不等于完整').toEqual([])
    expect((meta().warnings as string[])).toContain(NO_MASK_WARNING)
  })

  it('data_coverage 看不见内部缺口：iso-day 表有 warnings 兜底', async () => {
    await seed()
    await q('--table', 'daily_overview', '--since', '2026-10-01', '--until', '2026-10-07')
    expect(meta().data_coverage, '首尾有数据 → 报满区间，中间 4 天缺失看不见').toEqual({
      min: '2026-10-01T00:00:00+08:00', max: '2026-10-07T00:00:00+08:00',
    })
    const w = meta().warnings as string[]
    expect(w.some((x) => x.includes('实际只有 3 个有数据')), 'iso-day 有缺口警告兜底').toBe(true)
  })

  it('epoch-ms 表同样看不见内部缺口，且**没有任何警告**（图例的「没有兜底」由此成立）', async () => {
    await seed()
    await q('--table', 'sessions')
    expect(meta().data_coverage, '首尾有数据 → 报满区间').toEqual({
      min: '2026-09-01T08:00:00+08:00', max: '2026-09-07T08:00:00+08:00',
    })
    expect(meta().warnings, 'epoch-ms 没有任何兜底 —— 这正是图例要警告的').toEqual([])
    // ⚠️ 上面那条**没有过滤**，`resolvedRange` 为 null，缺口警告块根本进不去 ——
    // 只测它的话，把 `NULL AS days` 改成常量 days 的变异仍然全绿（初版就漏了）。
    // 必须再跑一条**带过滤**的：此时警告块可达，而 epoch-ms 依然不产生缺口警告。
    await q('--table', 'sessions', '--since', '2026-09-01', '--until', '2026-09-08')
    expect(meta().resolved_range, '这条必须真的进了警告块').not.toBeNull()
    expect(meta().warnings, '带过滤时 epoch-ms 同样没有内部缺口警告').toEqual([])
  })
})

describe('limit 相关：上限不是行数，覆盖率不受截断影响', () => {
  it('未给 --limit 时 limit_applied 是默认 1000，且 truncated 为 false', async () => {
    await seed()
    await q('--table', 'daily_overview')
    expect(meta().limit_applied).toBe(1000)
    expect(meta().truncated).toBe(false)
    expect(meta().rows).toBe(3)
  })

  it('--limit 1：truncated 为 true 且 rows=1，但 data_coverage 仍按全区间计算', async () => {
    await seed()
    await q('--table', 'daily_overview', '--since', '2026-10-01', '--until', '2026-10-07', '--limit', '1')
    expect(meta().truncated).toBe(true)
    expect(meta().limit_applied).toBe(1)
    expect(meta().rows).toBe(1)
    expect(meta().data_coverage, '覆盖率是独立查询，不受截断影响').toEqual({
      min: '2026-10-01T00:00:00+08:00', max: '2026-10-07T00:00:00+08:00',
    })
  })
})
