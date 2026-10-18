// tests/commands/stats.test.ts —— E-T10：`stats fields <table>`（spec §九）。
// 夹具沿 tests/commands/db.test.ts：mkdtemp + stubEnv('HOME') + 真 DuckDB 临时库 +
// spy stdout/stderr 双通道。
// ⚠️ fixtures 全合成：payload 只含聚合用字段（数值/全 -1/JSON null/非数值/缺键/空对象/
// NULL），不含任何 PII；本命令也不输出逐行数据。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { statsCommand } from '../../src/commands/stats.js'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import type { Store } from '../../src/store/types.js'

// DuckDB 冷启动偶发 >5s（与 db.test.ts / sync.test.ts 同款放宽）。
vi.setConfig({ testTimeout: 15_000 })

let dir = ''
let out = ''
let err = ''
const dbPath = (): string => join(dir, 'q.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-stats-'))
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
  vi.stubEnv('HOME', dir)   // 隔离真实 ~（配置文件与默认库路径都走 HOME）
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const data = (): Record<string, unknown> => JSON.parse(out).data
const meta = (): Record<string, unknown> => JSON.parse(out).meta
const errorOf = (): Record<string, unknown> => JSON.parse(out).error

type Observed = {
  field: string; rows_present: number; minus_one: number; nulls: number
  min: number | null; max: number | null
}
type Declared = {
  unit: string; higher_is_better: boolean | null; source: string; note: string | null
}

/** rw 建库（跑完全部迁移 → 25 张表），调用方负责 close。 */
async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  await s.init()
  return s
}

/**
 * daily_overview 合成 payload（探针 17 的形状全覆蓋）：
 * 数值 / 全 -1 / JSON null / 非数值 / 缺键 / 空对象 / NULL payload。
 */
const OVERVIEW_ROWS: Array<[string, string | null]> = [
  ['2026-10-01T16:00:00.000Z', JSON.stringify({
    assignedRatio: 0.912, sessions: 100, sessionInviteRatio: -1, carrier: null, nameSpell: 'abc' })],
  ['2026-10-02T16:00:00.000Z', JSON.stringify({
    assignedRatio: 0.987, sessions: 200, sessionInviteRatio: -1, carrier: null, nameSpell: 'def' })],
  // 该窗口无数据：比率 -1、会话 0（-1 是哨兵，不是数值）
  ['2026-10-03T16:00:00.000Z', JSON.stringify({
    assignedRatio: -1, sessions: 0, sessionInviteRatio: -1, carrier: null })],
  // 缺键（carrier/nameSpell 不出现）+ sessions 是哨兵
  ['2026-10-04T16:00:00.000Z', JSON.stringify({ assignedRatio: 0.95, sessions: -1 })],
  ['2026-10-05T16:00:00.000Z', JSON.stringify({})],   // 空对象：不贡献任何字段行
  ['2026-10-06T16:00:00.000Z', null],                 // SQL NULL payload：同上
]

async function seed(): Promise<void> {
  const s = await fresh()
  try {
    await s.upsert('daily_overview', OVERVIEW_ROWS.map(([stat_date, payload]) =>
      ({ stat_date, payload, synchronized_at: null })))
  } finally {
    await s.close()
  }
}

describe('stats fields', () => {
  it('daily_overview：observed 的 rows_present/minus_one/nulls/min/max 与合成 payload 一致', async () => {
    await seed()
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(0)

    const observed = data().observed as Observed[]
    // 逐字段断言全量：键集合与顺序由 SQL 的 ORDER BY k 决定
    expect(observed).toEqual([
      { field: 'assignedRatio', rows_present: 4, minus_one: 1, nulls: 0, min: 0.912, max: 0.987 },
      { field: 'carrier', rows_present: 3, minus_one: 0, nulls: 3, min: null, max: null },
      { field: 'nameSpell', rows_present: 2, minus_one: 0, nulls: 0, min: null, max: null },
      { field: 'sessionInviteRatio', rows_present: 3, minus_one: 3, nulls: 0, min: null, max: null },
      { field: 'sessions', rows_present: 4, minus_one: 1, nulls: 0, min: 0, max: 200 },
    ])
    // COUNT/SUM 经 getRowObjectsJson() 是字符串 → 命令层必须 Number() 收敛
    for (const o of observed) {
      expect(typeof o.rows_present, o.field).toBe('number')
      expect(typeof o.minus_one, o.field).toBe('number')
      expect(typeof o.nulls, o.field).toBe('number')
    }
    // 空对象 / NULL payload 不贡献字段行（rows_present 合计 = 16，而不是 6 行 × 字段数）
    expect(observed.reduce((n, o) => n + o.rows_present, 0)).toBe(16)

    expect(data().table).toBe('daily_overview')
    expect(meta().warnings).toEqual([])
  })

  it('全 -1 字段 → minus_one=rows_present，min/max=null', async () => {
    await seed()
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(0)

    const all = data().observed as Observed[]
    const invite = all.find((o) => o.field === 'sessionInviteRatio')!
    expect(invite.rows_present).toBe(3)
    expect(invite.minus_one).toBe(invite.rows_present)
    expect(invite.min).toBeNull()
    expect(invite.max).toBeNull()

    // 反例：assignedRatio 有一条 -1，min/max 只在非 -1 值上取（-1 绝不能当成最小值）
    const assigned = all.find((o) => o.field === 'assignedRatio')!
    expect(assigned.minus_one).toBe(1)
    expect(assigned.min).toBe(0.912)
  })

  it('unknown_fields 列出目录未声明且后缀判不出的字段；declared 覆盖目录 + 观测字段', async () => {
    await seed()
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(0)

    expect(data().unknown_fields).toEqual(['carrier', 'nameSpell'])

    const declared = data().declared as Record<string, Declared>
    expect(declared.assignedRatio).toEqual({
      unit: 'ratio', higher_is_better: null, source: 'design-doc',
      note: '设计稿 §6.2 实测 0.987；-1 = 无数据',
    })
    // 目录声明（sessions）与后缀派生（sessionInviteRatio）同时在场
    expect(declared.sessions).toEqual(
      { unit: 'count', higher_is_better: null, source: 'name-suffix', note: null })
    expect(declared.sessionInviteRatio).toEqual(
      { unit: 'ratio', higher_is_better: null, source: 'name-suffix', note: null })
    // 判不出单位的字段也在 declared 里，如实标 unknown
    expect(declared.carrier).toEqual(
      { unit: 'unknown', higher_is_better: null, source: 'name-suffix', note: null })
    // 每个 observed 字段都必须在 declared 里有一条
    for (const o of data().observed as Observed[]) expect(declared[o.field], o.field).toBeDefined()
  })

  it('payload 键名不受信：名为 __proto__ 的键不得从 declared 里静默消失', async () => {
    const s = await fresh()
    try {
      // JSON 里 "__proto__" 是普通键；命令层若用 `obj[k] = v` 累积声明，
      // 这个键会改原型而不是建自有键（实测会从输出里消失）。
      await s.upsert('daily_overview', [{
        stat_date: '2026-10-01T16:00:00.000Z',
        payload: '{"__proto__":5,"constructor":7,"normalCount":1}', synchronized_at: null,
      }])
    } finally {
      await s.close()
    }
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(0)

    const declared = data().declared as Record<string, Declared>
    const observed = data().observed as Observed[]
    expect(observed.map((o) => o.field)).toEqual(['__proto__', 'constructor', 'normalCount'])
    for (const o of observed) expect(Object.hasOwn(declared, o.field), o.field).toBe(true)
    expect(declared['__proto__'].unit).toBe('unknown')
    // 用下标而非 .constructor —— TS 会把 `.constructor` 解析成 Object.prototype 的构造器
    expect(declared['constructor'].unit).toBe('unknown')
    expect(declared.normalCount.unit).toBe('count')
  })

  it('字段数超过沙箱行数上限（1000）→ 截断进 warning，不静默', async () => {
    const s = await fresh()
    try {
      // 1005 个字段（远超报表 payload 的实际规模）：观测 SQL 一行 = 一个字段，
      // 沙箱默认上限 1000 → 必然截断；截断必须如实告知，不能当作完整字段集。
      const payload: Record<string, number> = {}
      for (let i = 0; i < 1005; i++) payload[`f${String(i).padStart(4, '0')}`] = i
      await s.upsert('daily_overview', [{
        stat_date: '2026-10-01T16:00:00.000Z', payload: JSON.stringify(payload), synchronized_at: null,
      }])
    } finally {
      await s.close()
    }
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(0)

    expect((data().observed as Observed[]).length).toBe(1000)
    const text = (meta().warnings as string[]).join('\n')
    expect(text).toMatch(/1000/)      // N 取自实际返回行数
    expect(text).toMatch(/不完整/)
    // 文案只说观测侧（declared 还含目录声明，可能多于 N）
    expect(text).toMatch(/observed\/unknown_fields/)
    expect(text).not.toMatch(/declared/)
  })

  it('数组 / 标量 payload 的 json_keys 为空 → 该行不贡献字段（不报错、不编造下标键）', async () => {
    const s = await fresh()
    try {
      // 探针实测：json_keys('[10,20]') 返回 []（不是 "0"/"1" 下标键）——
      // 数组与标量 payload 等价于「无可观测字段」，不应让整条命令失败。
      await s.upsert('daily_overview', [
        { stat_date: '2026-10-01T16:00:00.000Z', payload: '[10,20]', synchronized_at: null },
        { stat_date: '2026-10-02T16:00:00.000Z', payload: '"abc"', synchronized_at: null },
        { stat_date: '2026-10-03T16:00:00.000Z', payload: '{"sessions":7}', synchronized_at: null },
      ])
    } finally {
      await s.close()
    }
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(0)

    // 只有对象 payload 那行贡献字段；数组/标量行不产生 "0"/"1" 之类的键
    expect(data().observed).toEqual([
      { field: 'sessions', rows_present: 1, minus_one: 0, nulls: 0, min: 7, max: 7 },
    ])
    expect(meta().warnings).toEqual([])   // 有可观测字段 → 不是空结果
  })

  it('含空格的键名：JSON 路径 $."a b" 可取（不误判为 unknown 之外的失败）', async () => {
    const s = await fresh()
    try {
      await s.upsert('daily_overview', [{
        stat_date: '2026-10-01T16:00:00.000Z',
        payload: '{"a b":5,"reply Ratio":0.25}', synchronized_at: null,
      }])
    } finally {
      await s.close()
    }
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(0)

    const observed = data().observed as Observed[]
    // 空格键名与普通键名同等对待：ORDER BY field 下按字典序
    expect(observed).toEqual([
      { field: 'a b', rows_present: 1, minus_one: 0, nulls: 0, min: 5, max: 5 },
      { field: 'reply Ratio', rows_present: 1, minus_one: 0, nulls: 0, min: 0.25, max: 0.25 },
    ])
    const declared = data().declared as Record<string, Declared>
    expect(declared['a b'].unit).toBe('unknown')
    expect(data().unknown_fields).toEqual(['a b'])
  })

  // 键名是**不受信输入**（payload 原样落库）。JSON 路径必须按路径语法转义，
  // 否则两种失败形态（2026-10-18 实测）：
  //   · `a"b` / 尾随 `\` → `JSON path error`，一个畸形键名让整条命令失败；
  //   · `a\\b`（连续反斜杠）→ 路径静默返回 NULL，非空值被计成 nulls（静默错数）。
  it('键名含双引号 / 反斜杠：路径转义后仍能取值，不得整命令失败或静默计入 nulls', async () => {
    const s = await fresh()
    try {
      // 键：a"b（含双引号）、a\\b（JSON 转义后是单个反斜杠）、ab\（尾随反斜杠）、plain
      await s.upsert('daily_overview', [{
        stat_date: '2026-10-01T16:00:00.000Z',
        payload: '{"a\\"b":42,"a\\\\b":43,"ab\\\\":44,"plain":45}', synchronized_at: null,
      }])
    } finally {
      await s.close()
    }
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(0)

    const observed = data().observed as Observed[]
    const byField = new Map(observed.map((o) => [o.field, o]))
    // 四个键都必须取到值：nulls=0 是关键断言 —— 转义写错时这里会变成 nulls=1 + min/max=null
    for (const [field, v] of [['a"b', 42], ['a\\b', 43], ['ab\\', 44], ['plain', 45]] as const) {
      const o = byField.get(field)
      expect(o, `缺字段 ${field}`).toBeDefined()
      expect(o).toEqual({ field, rows_present: 1, minus_one: 0, nulls: 0, min: v, max: v })
    }
  })

  it('空表 → observed=[]、unknown_fields=[] + warning；目录声明仍如实给出', async () => {
    const s = await fresh()   // 只建库，不灌任何报表数据
    await s.close()

    // 目录里有声明的表：声明不依赖数据，空表也给出（sessions 无 note → 显式 null）
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(0)
    expect(data().observed).toEqual([])
    expect(data().declared).toEqual({
      assignedRatio: {
        unit: 'ratio', higher_is_better: null, source: 'design-doc',
        note: '设计稿 §6.2 实测 0.987；-1 = 无数据',
      },
      sessions: { unit: 'count', higher_is_better: null, source: 'name-suffix', note: null },
    })
    expect(data().unknown_fields).toEqual([])
    let warnings = meta().warnings as string[]
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/该表无数据/)
    expect(warnings[0]).toMatch(/qiyu sync run/)

    // 目录里没有声明的表：declared 为空对象，不是 null
    out = ''
    expect(await statsCommand(['fields', 'robot_summary', '--db', dbPath()])).toBe(0)
    expect(data().observed).toEqual([])
    expect(data().declared).toEqual({})
    expect(data().unknown_fields).toEqual([])
    warnings = meta().warnings as string[]
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/该表无数据/)
  })

  it('有行但 payload 无可观测字段 → 不谎称「无数据」，warning 点名 payload', async () => {
    const s = await fresh()
    try {
      await s.upsert('staff_quality', [
        { stat_date: '2026-10-01T16:00:00.000Z', staff_id: '1000001', payload: '{}', synchronized_at: null },
      ])
    } finally {
      await s.close()
    }
    expect(await statsCommand(['fields', 'staff_quality', '--db', dbPath()])).toBe(0)

    expect(data().observed).toEqual([])
    const warnings = meta().warnings as string[]
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/1 行/)
    expect(warnings[0]).toMatch(/payload/)
  })

  it('非报表表（sessions）→ usage 退出码 2 + 可用表清单', async () => {
    expect(await statsCommand(['fields', 'sessions'])).toBe(2)
    const e = errorOf()
    expect(e.kind).toBe('usage')
    const text = `${String(e.message)}\n${String(e.hint ?? '')}`
    expect(text).toMatch(/sessions/)
    for (const t of ['daily_overview', 'staff_workload', 'staff_quality', 'staff_satisfaction',
      'staff_attendance', 'order_performance', 'staff_salary_detail', 'robot_summary', 'transfer_human']) {
      expect(text, t).toContain(t)
    }
    expect(err.length).toBeGreaterThan(0)   // usageFail 双通道

    // 完全未知的表名同样 usage + 清单
    out = ''; err = ''
    expect(await statsCommand(['fields', 'sessons'])).toBe(2)
    expect(errorOf().kind).toBe('usage')
  })

  it('sentinel 恒在，meaning 说明 -1 是「无数据」', async () => {
    await seed()
    for (const argv of [['fields', 'daily_overview', '--db', dbPath()],
      ['fields', 'robot_summary', '--db', dbPath()]]) {
      out = ''
      expect(await statsCommand(argv), argv.join(' ')).toBe(0)
      expect(data().sentinel).toEqual({
        value: -1,
        meaning: '该窗口或筛选条件没有匹配到数据（设计稿 §6.2 实测：报表面族统一哨兵，厂商未文档化）',
      })
      expect(meta().warnings).toBeDefined()
    }
  })

  it('--pretty / 未知参数 / 值位缺失 / 缺表名 → usage；--help → 0', async () => {
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath(), '--pretty'])).toBe(2)
    expect(err).toMatch(/--pretty/)

    out = ''; err = ''
    expect(await statsCommand(['fields', 'daily_overview', '--bogus'])).toBe(2)
    expect(errorOf().kind).toBe('usage')

    out = ''; err = ''
    expect(await statsCommand(['fields', 'daily_overview', '--db'])).toBe(2)   // 值位守卫
    expect(err).toMatch(/--db 缺少取值/)

    out = ''; err = ''
    expect(await statsCommand(['fields'])).toBe(2)
    expect(err).toMatch(/缺少表名/)

    out = ''; err = ''
    expect(await statsCommand(['bogus'])).toBe(2)
    expect(err).toMatch(/未知子命令/)

    // 无子命令 / --help / fields --help → USAGE 走 stdout、退出码 0
    for (const argv of [[], ['--help'], ['fields', '--help']]) {
      out = ''; err = ''
      expect(await statsCommand(argv), argv.join(' ')).toBe(0)
      expect(out).toMatch(/stats fields/)
      expect(err).toBe('')
    }
  })

  it('库不存在 / 未初始化（空 DuckDB 文件）→ store_not_initialized，hint 指 store init', async () => {
    expect(await statsCommand(['fields', 'daily_overview', '--db', join(dir, 'missing.db')])).toBe(1)
    expect(errorOf().kind).toBe('store_not_initialized')
    expect(String(errorOf().hint)).toMatch(/store init/)

    // 合法 DuckDB、零表（不是本 CLI 创建的库）→ 同样 store_not_initialized（spec §十一「缺表」）
    const mod = (await import('@duckdb/node-api')) as unknown as {
      DuckDBInstance: { create: (p: string, o?: unknown) => Promise<{ closeSync: () => void }> }
    }
    const empty = join(dir, 'empty.db')
    ;(await mod.DuckDBInstance.create(empty)).closeSync()
    out = ''
    expect(await statsCommand(['fields', 'daily_overview', '--db', empty])).toBe(1)
    expect(errorOf().kind).toBe('store_not_initialized')
    expect(String(errorOf().hint)).toMatch(/store init/)
  })

  it('迁移已完成而表被删 → hint 不承诺 store init 能重建（与 db.ts 同口径）', async () => {
    // base commit ee6f73d 的结论：init 只重放 version > MAX(version) 的迁移，
    // 已迁移库上 DROP 掉的表不会被重建 —— hint 若只说「先运行 store init」，
    // Agent 会跑到 ok 再撞同一错误。必须按成因拆开，并给出真正的修复路径。
    const s = await fresh()
    try {
      await s.query('DROP TABLE "daily_overview"')
    } finally {
      await s.close()
    }

    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(1)
    const e = errorOf()
    expect(e.kind).toBe('store_not_initialized')
    expect(String(e.code)).toBe('store_not_initialized')
    const hint = String(e.hint)
    expect(hint).toMatch(/store init/)     // 保留指针（迁移未跑完时它确实能补建）
    expect(hint).toMatch(/不会重建/)        // 但不得暗示它对已迁移库也有效
    expect(hint).toMatch(/重建库/)          // 真正的修复路径
  })
})
