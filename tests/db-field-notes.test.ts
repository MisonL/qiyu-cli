// tests/db-field-notes.test.ts —— `db describe` / `db tables` 的 meta 图例（2026-10-28）。
//
// 背景：这两个命令把**声明**与**实况**混在同一层输出里，而字段名只说了「是什么」、
// 没说「是哪一种」。真库实测的三处字面陷阱：
//   · `columns` / `pii_columns` / `time_column` 全部来自 CLI 的表定义（声明），
//     表被删、列被删、多出列时**照旧原样输出**，只有 warnings 说实况；
//   · `time_range` 为 null 有四种互不相同的成因，只看 null 分不出该修什么；
//   · `db tables` 的 `tables` 数组**不含**声明有而库中无的表。
//
// 本文件把图例、真实输出键集与上述每条事实都钉在真跑出来的结果上。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbCommand } from '../src/commands/db.js'
import { createDuckDbStore } from '../src/store/duckdb.js'
import {
  describeFieldNotes, tablesFieldNotes, TIME_COLUMN_KINDS, TIME_COLUMN_KIND_NOTES,
} from '../src/commands/db-notes.js'
import type { Store } from '../src/store/types.js'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

vi.setConfig({ testTimeout: 30_000 })

let dir = ''
let out = ''
let err = ''
const dbPath = (): string => join(dir, 'q.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-dbnotes-'))
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
const data = (): Record<string, unknown> => parsed().data as Record<string, unknown>
const meta = (): Record<string, unknown> => parsed().meta as Record<string, unknown>
const notes = (): Record<string, string> => meta().field_notes as Record<string, string>
const warnings = (): string[] => (meta().warnings as string[]).filter((w) => !w.includes('skill'))

async function db(...args: string[]): Promise<number> {
  out = ''; err = ''
  return dbCommand([...args, '--db', dbPath()])
}

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  await s.init()
  return s
}

/** 上海日 → iso-day 列的 UTC 瞬时形态。 */
const dayIso = (day: number): string => new Date(Date.UTC(2026, 9, day) - 8 * 3600_000).toISOString()

const sessionRow = (id: string, startTime: string | null): Record<string, unknown> => ({
  session_id: id, payload: JSON.stringify({ id }), staffId: '1000001',
  startTime, endTime: null, session_type: 'human', categoryDetail: null,
  userPhone: '13800001111', userName: '测试用户', userEmail: null, userAddress: null,
  fromIp: null, userIpCity: null, userCrmInfo: null,
  synchronized_at: '2026-10-15T00:00:00.000Z',
})

describe('图例本身：键集、形态与枚举双向', () => {
  it('describe 的图例键集 == 真实 meta 键集（含 field_notes 必须存在）', async () => {
    const s = await fresh(); await s.close()
    expect(await db('describe', 'daily_overview')).toBe(0)
    expect(meta().field_notes, 'describe 必须带 field_notes').toBeDefined()
    expect(Object.keys(notes()).sort(), '发出的图例键集必须与 describeFieldNotes() 一致')
      .toEqual(Object.keys(describeFieldNotes()).sort())
    // 双向：图例 ⊆ 真实字段（下面这轮）且 真实字段 ⊆ 图例 ∪ 自明键（再下面那轮）。
    // ⚠️ 只做单向会漏「新增了字段却没有释义」——那正是本 PR 要防的缺陷。
    const dataKeys = Object.keys(data())
    for (const k of Object.keys(describeFieldNotes())) {
      expect(dataKeys, `describe 图例键 ${k} 的第一段不在 data 里`).toContain(k.split(/[.[]/)[0])
    }
    const selfEvident = ['table'] // 表名即含义，不另写图例（grain / primary_key 已补释义）
    for (const k of dataKeys) {
      if (selfEvident.includes(k)) continue
      expect(Object.keys(describeFieldNotes()), `data 字段 ${k} 没有释义`).toContain(k)
    }
    // 嵌套层同样要覆盖：`columns[]` 条目的每个字段都得有 `columns[].x` 释义。
    // ⚠️ 只查顶层会漏 —— 删掉 `columns[].note` 的释义时本文件曾全绿。
    const col = (data().columns as Array<Record<string, unknown>>)[0]!
    for (const k of Object.keys(col)) {
      if (k === 'name') continue
      expect(Object.keys(describeFieldNotes()), `columns 条目字段 ${k} 没有释义`)
        .toContain(`columns[].${k}`)
    }
  })

  it('tables 的图例键集 == 真实 meta 键集（含 field_notes 必须存在）', async () => {
    const s = await fresh(); await s.close()
    expect(await db('tables')).toBe(0)
    expect(meta().field_notes, 'tables 必须带 field_notes').toBeDefined()
    expect(Object.keys(notes()).sort()).toEqual(Object.keys(tablesFieldNotes()).sort())
    const item = (data().tables as Array<Record<string, unknown>>)[0]!
    for (const k of Object.keys(tablesFieldNotes())) {
      // ⚠️ 只跳过顶层 `tables` 这一个键。初版写成 `k.split(/[.[]/)[0] === 'tables'`，
      // 而**每个** `tables[].x` 的第一段都是 `tables` —— 于是全部被跳过，等于没断言
      //（CodeRabbit 抓到）。`tables[].rows`.split(/[.[]/) 是 ['tables','','rows']。
      if (k === 'tables') continue
      const sub = k.slice('tables[].'.length)
      expect(Object.keys(item), `tables 图例键 ${k} 不在条目里`).toContain(sub)
    }
    // 反向：条目里的每个字段都要么有释义、要么自明
    for (const k of Object.keys(item)) {
      if (k === 'name') continue
      expect(Object.keys(tablesFieldNotes()), `tables 条目字段 ${k} 没有释义`)
        .toContain(`tables[].${k}`)
    }
  })

  it('time_column.kind 枚举 ⊆ 图例、图例 ⊆ 枚举（双向）', () => {
    expect([...TIME_COLUMN_KINDS].sort()).toEqual(['epoch-ms', 'iso-day', 'iso-instant'])
    expect(Object.keys(TIME_COLUMN_KIND_NOTES).sort()).toEqual([...TIME_COLUMN_KINDS].sort())
    const cell = describeFieldNotes().time_column!
    for (const v of TIME_COLUMN_KINDS) expect(cell, `图例缺 ${v}`).toContain(`${v} = `)
    // 单元格必须是**纯枚举**（`a = 释义；b = 释义`）—— 混入前缀说明会让反向解析
    // 少一个取值（本文件初版就踩过：前缀句与 iso-day 粘成一段）。
    const keys = cell.split('；').map((seg) => seg.split(' = ')[0]!.trim())
    expect(keys.sort()).toEqual([...TIME_COLUMN_KINDS].sort())
  })

  it('field_notes 不带 `**`、正文不含分隔符 `；`（枚举单元格除外）', () => {
    for (const [name, fn] of [['describe', describeFieldNotes], ['tables', tablesFieldNotes]] as const) {
      for (const [k, v] of Object.entries(fn())) {
        expect(v, `${name}.${k} 含 **`).not.toContain('**')
        if (k !== 'time_column') expect(v, `${name}.${k} 含分隔符 ；`).not.toContain('；')
      }
    }
    for (const [k, v] of Object.entries(TIME_COLUMN_KIND_NOTES)) {
      expect(v, `TIME_COLUMN_KIND_NOTES.${k} 含 **`).not.toContain('**')
      expect(v, `TIME_COLUMN_KIND_NOTES.${k} 含分隔符 ；`).not.toContain('；')
    }
  })

  it('三处关键措辞都在（声明三件套 / null 的唯一成因 / 两处成因计数）', () => {
    const d = describeFieldNotes()
    expect(d.columns, 'columns 必须点明三件套都是声明').toContain('三者都是声明')
    expect(d.row_count, 'row_count 的 null 必须说成唯一成因').toContain('唯一的 null 成因')
    expect(d.time_range, 'time_range 必须写明四种成因').toContain('四种成因')
    expect(tablesFieldNotes().tables, 'db tables 必须点明缺失表不在这里').toContain('不在这里')
    expect(tablesFieldNotes()['tables[].time_range'], 'tables 侧是三种成因').toContain('三种成因')
  })

  it('脱敏承诺必须限定到 --table 通道（--sql 不走列白名单）', () => {
    // CodeRabbit（2026-10-28）：原措辞「查询这些列默认脱敏」会被 Agent 读成
    // 「--sql 的输出也是脱敏的」——而 --sql 只做列名级 + 值级兜底。
    const d = describeFieldNotes()
    expect(d['columns[].sensitive'], 'sensitive 的承诺必须限定').toContain('query --sql 不走列白名单')
    expect(d.pii_columns, 'pii_columns 的承诺必须限定').toContain('query --sql 不走列白名单')
    expect(tablesFieldNotes()['tables[].pii_columns'], 'tables 侧同样要限定')
      .toContain('query --sql 不走列白名单')
    // CodeRabbit 第二轮：--no-mask 连 --table 通道的脱敏也会关掉，三处都要写明。
    expect(d['columns[].sensitive'], '必须点明 --no-mask 能关闭脱敏').toContain('--no-mask 可关闭')
    expect(d.pii_columns, '必须点明 --no-mask 能关闭脱敏').toContain('--no-mask 可关闭')
    expect(tablesFieldNotes()['tables[].pii_columns'], '必须点明 --no-mask 能关闭脱敏')
      .toContain('--no-mask 可关闭')
  })

  it('grain / primary_key 也是声明，必须有释义', () => {
    const d = describeFieldNotes()
    expect(d.grain, 'grain 必须点明是声明').toContain('声明')
    expect(d.primary_key, 'primary_key 必须点明是声明').toContain('声明')
  })

  it('README 点明「声明 ≠ 实况」这条核心事实', () => {
    const md = read('README.md')
    expect(md, 'README 必须点明 columns 等是声明').toContain('声明')
    expect(md, 'README 必须点明 db tables 不含缺失表').toMatch(/不在这里|不出现在 `tables` 中/)
    const sk = read('src/skill/qiyu/SKILL.md')
    expect(sk, 'SKILL.md 必须区分声明与实测').toContain('要分清**声明**与**实测**')
    expect(sk, 'SKILL.md 必须点名 row_count / time_range 是实测').toContain('则是**实测**')
    expect(sk, 'SKILL.md 必须点明清单只含真实存在的表').toContain('只含')
  })
})

describe('声明 vs 实况（真库实测，图例的字面结论靠它成立）', () => {
  it('正常表：columns 是声明、row_count 与 time_range 是实况', async () => {
    const s = await fresh()
    await s.upsert('daily_overview', [
      { stat_date: dayIso(1), payload: '{}', synchronized_at: null },
      { stat_date: dayIso(7), payload: '{}', synchronized_at: null },
    ])
    await s.close()
    expect(await db('describe', 'daily_overview')).toBe(0)
    expect(data().row_count).toBe(2)
    expect(data().time_range).toEqual({
      min: '2026-10-01T00:00:00+08:00', max: '2026-10-07T00:00:00+08:00',
    })
    expect((data().columns as unknown[]).length).toBe(3) // 声明列数
  })

  it('表不在库中：row_count 为 null，而 columns / time_column 仍输出声明值', async () => {
    const s = await fresh()
    await s.query('DROP TABLE "robot_summary"')
    await s.close()
    expect(await db('describe', 'robot_summary')).toBe(0)
    expect(data().row_count, 'row_count 的 null 只有这一个成因').toBeNull()
    expect(data().time_range).toBeNull()
    // 关键：时间列是**声明**，表都没了照样输出
    expect(data().time_column, 'time_column 是声明，表不在库中照样输出').toEqual({
      name: 'stat_date', kind: 'iso-day',
    })
    expect((data().columns as unknown[]).length, '列清单同样是声明').toBe(3)
    expect(warnings().join('\n')).toContain('在库中不存在')
  })

  it('时间列被删：time_range 为 null，而 time_column 仍输出声明值', async () => {
    const s = await fresh()
    await s.upsert('sessions', [sessionRow('s1', '1791907200000')])
    await s.query('ALTER TABLE "sessions" DROP COLUMN "startTime"')
    await s.close()
    expect(await db('describe', 'sessions')).toBe(0)
    expect(data().row_count).toBe(1)
    expect(data().time_range, '时间列没了 → 无从统计').toBeNull()
    expect(data().time_column).toEqual({ name: 'startTime', kind: 'epoch-ms' })
    expect(warnings().join('\n'), 'warnings 必须点名少列').toContain('少列 startTime')
  })

  it('库中多出列：warnings 点名，而 columns 仍是声明（不含多出的列）', async () => {
    const s = await fresh()
    await s.query('ALTER TABLE "daily_overview" ADD COLUMN "rogue" VARCHAR')
    await s.close()
    expect(await db('describe', 'daily_overview')).toBe(0)
    const names = (data().columns as Array<{ name: string }>).map((c) => c.name)
    expect(names, '声明里没有 rogue').not.toContain('rogue')
    expect(warnings().join('\n'), '但 warnings 必须点名').toContain('多列 rogue')
  })

  it('空表：time_range 为 null 且**没有任何警告**（与「时间列被删」区分开）', async () => {
    const s = await fresh(); await s.close()
    expect(await db('describe', 'robot_summary')).toBe(0)
    expect(data().row_count).toBe(0)
    expect(data().time_range).toBeNull()
    expect(data().time_column).not.toBeNull()
    expect(warnings(), '空表不该有漂移警告').toEqual([])
  })

  it('时间值全是脏值：time_range 为 null，且 warning 报数量', async () => {
    const s = await fresh()
    await s.upsert('daily_overview', [
      { stat_date: 'not-a-date', payload: '{}', synchronized_at: null },
    ])
    await s.close()
    expect(await db('describe', 'daily_overview')).toBe(0)
    expect(data().row_count, '行是在的').toBe(1)
    expect(data().time_range, '但没有一行能过形态谓词').toBeNull()
    expect(warnings().join('\n')).toContain('不符合约定形态')
  })

  it('无时间列的表：time_column 为 null（与「表不在库中」区分开）', async () => {
    const s = await fresh(); await s.close()
    expect(await db('describe', 'tags')).toBe(0)
    expect(data().time_column).toBeNull()
    expect(data().row_count, '表在库里').toBe(0)
  })
})

describe('db tables：清单只含真实存在的表', () => {
  it('声明有而库中无的表不进 tables，只在 warnings 里点名', async () => {
    const s = await fresh()
    await s.query('DROP TABLE "robot_summary"')
    await s.close()
    expect(await db('tables')).toBe(0)
    const names = (data().tables as Array<{ name: string }>).map((t) => t.name)
    expect(names, '缺失表不在清单里').not.toContain('robot_summary')
    expect(names.length, '其余 24 张都在').toBe(24)
    expect(warnings().join('\n'), '但必须点名').toContain('robot_summary')
    expect(notes().tables, '图例必须说明这一点').toContain('不在这里')
  })

  it('rows 是真实行数；空表的 time_range 为 null', async () => {
    const s = await fresh()
    await s.upsert('daily_overview', [
      { stat_date: dayIso(1), payload: '{}', synchronized_at: null },
      { stat_date: dayIso(2), payload: '{}', synchronized_at: null },
    ])
    await s.close()
    expect(await db('tables')).toBe(0)
    const byName = new Map((data().tables as Array<Record<string, unknown>>).map((t) => [t.name, t]))
    expect(byName.get('daily_overview')!.rows).toBe(2)
    expect(byName.get('robot_summary')!.rows).toBe(0)
    expect(byName.get('robot_summary')!.time_range, '空表 → null，不是编造的范围').toBeNull()
    expect(byName.get('tags')!.time_range, '无时间列 → null').toBeNull()
  })
})
