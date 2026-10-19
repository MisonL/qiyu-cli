// tests/query/table-query.test.ts —— Task 9：`query --table` 的纯函数层（spec §四/§六）。
//
// 只测 SQL 构造与区间归一：不发查询、不碰 DuckDB（那个在 tests/commands/query.test.ts）。
// 夹具全部来自 `TABLES`（代码内常量）——本文件不产生任何数据。
import { describe, it, expect } from 'vitest'
import {
  buildCoverageQuery, buildMinQuery, buildTableQuery, effectiveBound,
} from '../../src/query/table-query.js'
import { tableByName } from '../../src/store/schema.js'
import type { TableDef } from '../../src/store/schema.js'

/** 缺省上界用的「当前时刻」：上海 2026-10-15 12:00（固定值，测试不读系统时钟）。 */
const NOW = Date.parse('2026-10-15T04:00:00Z')

const t = (name: string): TableDef => {
  const def = tableByName(name)
  if (def === undefined) throw new Error(`测试引用了 TABLES 里不存在的表：${name}`)
  return def
}

describe('buildTableQuery · 时间列三形态（契约 A）', () => {
  it('iso-day：--since 9/15 12:00 向下取整到上海日零点；--until 9/20 取所在日零点（含当天）', () => {
    const plan = buildTableQuery({
      table: t('daily_overview'),
      since: Date.parse('2026-09-15T12:00:00+08:00'),
      until: Date.parse('2026-09-20T00:00:00+08:00'),
      now: NOW,
    })
    expect(plan.params).toEqual([
      '2026-09-14T16:00:00.000Z',   // 上海 9/15 00:00
      '2026-09-19T16:00:00.000Z',   // 上海 9/20 00:00 —— stat_date 存日零点，故含 9/20 全天
    ])
    // ⚠️ 按**时刻**比较（正确性审查 F1）：iso-day 列里 `…T16:00:00Z`（无毫秒）在字典序上
    // 大于同刻的 `…T16:00:00.000Z`，字符串比较会把当天漏掉。
    expect(plan.sql).toContain('TRY_CAST("stat_date" AS TIMESTAMPTZ) >= TRY_CAST(? AS TIMESTAMPTZ)')
    expect(plan.sql).toContain('TRY_CAST("stat_date" AS TIMESTAMPTZ) <= TRY_CAST(? AS TIMESTAMPTZ)')
    // resolved_range 回显**实际生效**的区间（契约 C）：两端都是日零点
    expect(plan.resolvedRange).toEqual([
      Date.parse('2026-09-15T00:00:00+08:00'),
      Date.parse('2026-09-20T00:00:00+08:00'),
    ])
  })

  it('iso-instant：两端都用 toISOString，按解析后的时刻比较（正确性审查 F2）', () => {
    const plan = buildTableQuery({
      table: t('staff_attendance'),
      since: Date.parse('2026-09-15T01:00:00Z'),
      until: Date.parse('2026-09-15T05:30:00Z'),
      now: NOW,
    })
    expect(plan.params).toEqual(['2026-09-15T01:00:00.000Z', '2026-09-15T05:30:00.000Z'])
    // 混合偏移写法（+08:00 / Z）的字典序与时间序相反 —— 必须 cast 成 TIMESTAMPTZ 比较。
    expect(plan.sql).toContain('TRY_CAST("hour_ts" AS TIMESTAMPTZ) >= TRY_CAST(? AS TIMESTAMPTZ)')
    expect(plan.sql).toContain('TRY_CAST("hour_ts" AS TIMESTAMPTZ) <= TRY_CAST(? AS TIMESTAMPTZ)')
    expect(plan.resolvedRange).toEqual([
      Date.parse('2026-09-15T01:00:00Z'), Date.parse('2026-09-15T05:30:00Z'),
    ])
  })

  it('epoch-ms：谓词用 TRY_CAST(... AS BIGINT)，参数是 number（非数字行被排除）', () => {
    const since = Date.parse('2026-10-01T00:00:00Z')
    const until = Date.parse('2026-10-10T00:00:00Z')
    const plan = buildTableQuery({ table: t('sessions'), since, until, now: NOW })

    expect(plan.sql).toContain('TRY_CAST("startTime" AS BIGINT) >= ?')
    expect(plan.sql).toContain('TRY_CAST("startTime" AS BIGINT) <= ?')
    expect(plan.params).toEqual([since, until])
    // 数值参数不能 String()：字符串会走 VARCHAR 比较，毫秒数按字典序排会错
    expect(plan.params.every((p) => typeof p === 'number')).toBe(true)
  })
})

describe('buildTableQuery · 缺省端与 resolved_range（契约 B/C）', () => {
  it('只给 --since → 上界 = now，两端都回显', () => {
    const since = Date.parse('2026-10-01T00:00:00Z')
    const plan = buildTableQuery({ table: t('sessions'), since, now: NOW })
    expect(plan.params).toEqual([since, NOW])
    expect(plan.resolvedRange).toEqual([since, NOW])
  })

  it('只给 --until（表 MIN 已由命令层查到）→ 下界用它，resolved_range[0] 也是它', () => {
    const min = Date.parse('2026-10-01T00:00:00Z')
    const until = Date.parse('2026-10-10T00:00:00Z')
    const plan = buildTableQuery({ table: t('sessions'), until, tableMin: min, now: NOW })
    expect(plan.params).toEqual([min, until])
    expect(plan.resolvedRange).toEqual([min, until])
    expect(plan.warnings).toEqual([])
  })

  it('只给 --until + 表 MIN 为 null（空表）→ 不加下界谓词，resolved_range 为 null + warning', () => {
    // iso-day：上界取 until 所在上海日的日零点
    const until = Date.parse('2026-10-10T00:00:00+08:00')
    const plan = buildTableQuery({ table: t('robot_summary'), until, tableMin: null, now: NOW })
    expect(plan.sql).not.toContain('TRY_CAST("stat_date" AS TIMESTAMPTZ) >=')
    expect(plan.sql).toContain('TRY_CAST("stat_date" AS TIMESTAMPTZ) <= TRY_CAST(? AS TIMESTAMPTZ)')
    expect(plan.params).toEqual(['2026-10-09T16:00:00.000Z'])
    expect(plan.resolvedRange).toBeNull()
    expect(plan.warnings).toHaveLength(1)
    expect(plan.warnings[0]).toMatch(/无法解析缺省下界/)
    // ⚠️ 不得断言「表为空」（审查 Minor 3）：MIN 为 NULL 也可能是时间列全为 NULL/非数字
    //（epoch-ms 列的脏值被 TRY_CAST 折成 NULL），那时表并不空。两种成因都要覆盖到文案里。
    expect(plan.warnings[0]).toMatch(/表为空|NULL\/非数字/)
    expect(plan.warnings[0]).toMatch(/NULL\/非数字/)
  })

  it('两端都缺省 → 不加时间谓词，resolved_range 为 null', () => {
    const plan = buildTableQuery({ table: t('sessions'), now: NOW })
    expect(plan.sql).not.toContain('WHERE')
    expect(plan.params).toEqual([])
    expect(plan.resolvedRange).toBeNull()
  })

  it('区间倒置（下界晚于上界）→ 抛 usage', () => {
    expect(() => buildTableQuery({
      table: t('sessions'),
      since: Date.parse('2026-10-20T00:00:00Z'),
      until: Date.parse('2026-10-01T00:00:00Z'),
      now: NOW,
    })).toThrow(/区间无效/)
  })

  // ⚠️ 同一天是**合法的单日区间**，不是用法错误（审查 Important #2）：
  // iso-day 列存的就是日零点，`>= X AND <= X` 正好选中那一天。
  // 早先按 `lo >= hi` 拒绝，会让「就看 9/15 这一天」「看今天」两种最自然的问法都变成 exit 2，
  // 而 `--since 9/14`（不给 until）却能返回 9/14 + 9/15 两行 —— 同一个意图两种结局。
  it('iso-day 两端落在同一天 → 合法单日区间（两个参数都是该日零点）', () => {
    const plan = buildTableQuery({
      table: t('daily_overview'),
      since: Date.parse('2026-09-15T12:00:00+08:00'),
      until: Date.parse('2026-09-15T13:00:00+08:00'),
      now: NOW,
    })
    const dayIso = '2026-09-14T16:00:00.000Z'   // 上海 9/15 零点
    expect(plan.params).toEqual([dayIso, dayIso])
    expect(plan.sql).toContain('TRY_CAST("stat_date" AS TIMESTAMPTZ) >= TRY_CAST(? AS TIMESTAMPTZ)')
    expect(plan.sql).toContain('TRY_CAST("stat_date" AS TIMESTAMPTZ) <= TRY_CAST(? AS TIMESTAMPTZ)')
    expect(plan.resolvedRange).toEqual([
      Date.parse('2026-09-15T00:00:00+08:00'), Date.parse('2026-09-15T00:00:00+08:00')])
  })

  it('iso-instant / epoch-ms 的单点区间同样放行（0 行是事实，不是用法错误）', () => {
    const at = Date.parse('2026-09-15T02:00:00Z')
    const plan = buildTableQuery({ table: t('staff_attendance'), since: at, until: at, now: NOW })
    expect(plan.params).toEqual(['2026-09-15T02:00:00.000Z', '2026-09-15T02:00:00.000Z'])
  })

  it('只给 --until 且表下界晚于 until → 不是用法错误，但 warning 点名「必然 0 行」', () => {
    const min = Date.parse('2026-10-01T00:00:00Z')
    const until = Date.parse('2026-01-01T00:00:00Z')
    const plan = buildTableQuery({ table: t('sessions'), until, tableMin: min, now: NOW })
    expect(plan.params).toEqual([min, until])
    // 如实回显倒置区间（不粉饰成 null，否则 Agent 不知道发生了什么）
    expect(plan.resolvedRange).toEqual([min, until])
    // ⚠️ 但必须说明成因：resolved_range 是个倒置二元组，不解释的话 Agent 得自己推断
    expect(plan.warnings.some((w) => /必然 0 行/.test(w))).toBe(true)
  })

  // 反证：下界来自 MIN 且**有效**（早于 until）时不得出现这条 warning
  // —— 否则「只给 --until」这条路径会永远带一条与事实不符的警告。
  it('只给 --until 且表下界早于 until → 无「必然 0 行」警告', () => {
    const plan = buildTableQuery({
      table: t('sessions'), until: Date.parse('2026-10-05T00:00:00Z'),
      tableMin: Date.parse('2026-10-01T00:00:00Z'), now: NOW,
    })
    expect(plan.warnings).toEqual([])
  })

  it('effectiveBound：iso-day 取上海日零点，其余原值', () => {
    expect(effectiveBound('iso-day', Date.parse('2026-09-15T12:00:00+08:00')))
      .toBe(Date.parse('2026-09-15T00:00:00+08:00'))
    const instant = Date.parse('2026-09-15T12:00:00+08:00')
    expect(effectiveBound('iso-instant', instant)).toBe(instant)
    expect(effectiveBound('epoch-ms', instant)).toBe(instant)
  })
})

describe('buildTableQuery · --group-by（契约 E/F）', () => {
  it('生成 列… + COUNT(*) AS count，GROUP BY 全列，ORDER BY count DESC + 分组列（确定性 tiebreaker）', () => {
    const plan = buildTableQuery({ table: t('sessions'), groupBy: ['session_type'], now: NOW })
    expect(plan.sql).toBe(
      'SELECT "session_type", COUNT(*) AS count FROM "sessions"' +
      ' GROUP BY "session_type" ORDER BY count DESC, "session_type"')
  })

  it('多列分组：列序即参数序，ORDER BY 依次兜底', () => {
    const plan = buildTableQuery({
      table: t('sessions'), groupBy: ['session_type', 'staffId'], now: NOW,
    })
    expect(plan.sql).toBe(
      'SELECT "session_type", "staffId", COUNT(*) AS count FROM "sessions"' +
      ' GROUP BY "session_type", "staffId" ORDER BY count DESC, "session_type", "staffId"')
  })

  it('分组与时间谓词共存：WHERE 在 GROUP BY 之前', () => {
    const since = Date.parse('2026-10-01T00:00:00Z')
    const plan = buildTableQuery({
      table: t('sessions'), since, now: NOW, groupBy: ['session_type'],
    })
    expect(plan.sql).toBe(
      'SELECT "session_type", COUNT(*) AS count FROM "sessions"' +
      ' WHERE TRY_CAST("startTime" AS BIGINT) > 100000000000' +
      ' AND TRY_CAST("startTime" AS BIGINT) <= 8640000000000000' +
      ' AND TRY_CAST("startTime" AS BIGINT) >= ? AND TRY_CAST("startTime" AS BIGINT) <= ?' +
      ' GROUP BY "session_type" ORDER BY count DESC, "session_type"')
    expect(plan.params).toEqual([since, NOW])
  })

  it('未知列 → 抛 usage 并给该表列候选（suggestNames）', () => {
    expect(() => buildTableQuery({ table: t('sessions'), groupBy: ['session_typ'], now: NOW }))
      .toThrow(/未知列.*session_typ/)
    // 候选来自本表列集，不是别的表
    expect(() => buildTableQuery({ table: t('sessions'), groupBy: ['session_typ'], now: NOW }))
      .toThrow(/session_type/)
  })

  it('敏感列（userPhone / payload）→ 抛 usage，文案说明分组不可区分', () => {
    for (const col of ['userPhone', 'payload']) {
      expect(() => buildTableQuery({ table: t('sessions'), groupBy: [col], now: NOW }), col)
        .toThrow(new RegExp(`不接受敏感列 ${col}`))
      // 计数本身是准的（每组一个 count），失真的是「分组代表哪些原值」。
      expect(() => buildTableQuery({ table: t('sessions'), groupBy: [col], now: NOW }), col)
        .toThrow(/分组结果无法区分/)
      // 可执行的替代路径必须给对：--sql 单独用仍会被列名级脱敏，必须配 --no-mask。
      expect(() => buildTableQuery({ table: t('sessions'), groupBy: [col], now: NOW }), col)
        .toThrow(/--no-mask/)
    }
  })

  it('重复同一列 → 抛 usage（不静默去重）', () => {
    expect(() => buildTableQuery({
      table: t('sessions'), groupBy: ['session_type', 'session_type'], now: NOW,
    })).toThrow(/重复/)
  })
})

describe('buildTableQuery · 确定性排序（契约 E）', () => {
  it('有 timeColumn：时间列 DESC + 主键 ASC tiebreaker（epoch-ms 的排序表达式也 TRY_CAST）', () => {
    const plan = buildTableQuery({ table: t('sessions'), now: NOW })
    expect(plan.sql).toContain('ORDER BY TRY_CAST("startTime" AS BIGINT) DESC, "session_id" ASC')
  })

  it('无 timeColumn：主键 ASC', () => {
    const plan = buildTableQuery({ table: t('staff'), now: NOW })
    expect(plan.sql).toBe('SELECT * FROM "staff" ORDER BY "id" ASC')
  })

  it('时间列本身就是主键时只保留一次（daily_overview: stat_date）', () => {
    const plan = buildTableQuery({ table: t('daily_overview'), now: NOW })
    // 排序也按时刻（正确性审查 F1）：无毫秒形态 `…Z` 与 `….000Z` 的字典序与时间序相反。
    expect(plan.sql).toBe(
      'SELECT * FROM "daily_overview" ORDER BY TRY_CAST("stat_date" AS TIMESTAMPTZ) DESC')
  })

  it('复合主键：时间列不重复出现在 tiebreaker 里', () => {
    const plan = buildTableQuery({ table: t('staff_attendance'), now: NOW })
    expect(plan.sql).toBe(
      'SELECT * FROM "staff_attendance" ORDER BY TRY_CAST("hour_ts" AS TIMESTAMPTZ) DESC, "staff_id" ASC')
  })
})

describe('buildCoverageQuery / buildMinQuery（契约 B/D）', () => {
  it('覆盖查询沿用同一谓词与同一组参数（限行与截断无关）', () => {
    const since = Date.parse('2026-10-01T00:00:00Z')
    const until = Date.parse('2026-10-10T00:00:00Z')
    const plan = buildTableQuery({ table: t('sessions'), since, until, now: NOW })
    const cov = buildCoverageQuery({ table: t('sessions'), since, until, now: NOW })

    expect(cov.sql).toBe(
      'SELECT MIN(TRY_CAST("startTime" AS BIGINT)) AS mn, ' +
      'MAX(TRY_CAST("startTime" AS BIGINT)) AS mx, NULL AS days FROM "sessions"' +
      ' WHERE TRY_CAST("startTime" AS BIGINT) > 100000000000' +
      ' AND TRY_CAST("startTime" AS BIGINT) <= 8640000000000000' +
      ' AND TRY_CAST("startTime" AS BIGINT) >= ? AND TRY_CAST("startTime" AS BIGINT) <= ?')
    expect(cov.params).toEqual(plan.params)
  })

  it('无谓词时覆盖 = 全表极值；ISO 列带形态谓词（脏值不进覆盖）', () => {
    const cov = buildCoverageQuery({ table: t('daily_overview'), now: NOW })
    // 形态谓词与 commands/db.ts 的 shapeSqlOf 逐字一致；极值按时刻取（正确性审查 F1/F3/F6）。
    expect(cov.sql).toBe(
      'SELECT arg_min("stat_date", TRY_CAST("stat_date" AS TIMESTAMPTZ)) AS mn, ' +
      'arg_max("stat_date", TRY_CAST("stat_date" AS TIMESTAMPTZ)) AS mx, ' +
      `COUNT(DISTINCT timezone('Asia/Shanghai', TRY_CAST("stat_date" AS TIMESTAMPTZ))::DATE) AS days ` +
      'FROM "daily_overview"' +
      ` WHERE regexp_matches("stat_date", '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$')` +
      ' AND TRY_CAST("stat_date" AS TIMESTAMPTZ) IS NOT NULL')
    expect(cov.params).toEqual([])
    // epoch-ms 列的判据是数值区间（正确性审查 F5）：-1 哨兵/秒级/微秒级误写不算时间。
    const epoch = buildCoverageQuery({ table: t('sessions'), now: NOW })
    expect(epoch.sql).not.toMatch(/regexp_matches/)
    expect(epoch.sql).toContain('TRY_CAST("startTime" AS BIGINT) > 100000000000')
  })

  it('MIN 查询（只给 --until 时解析缺省下界）：epoch-ms 加 TRY_CAST；ISO 列带形态谓词', () => {
    expect(buildMinQuery(t('sessions')).sql)
      .toBe('SELECT MIN(TRY_CAST("startTime" AS BIGINT)) AS mn FROM "sessions"'
        + ' WHERE TRY_CAST("startTime" AS BIGINT) > 100000000000'
        + ' AND TRY_CAST("startTime" AS BIGINT) <= 8640000000000000')
    // 空串在字典序上小于一切 ISO —— 不带形态谓词时 MIN 会返回它，
    // 命令层据此判「该列无可用值」而丢掉缺省下界（CodeRabbit 终审 minor）。
    // 极值按时刻取（正确性审查 F2）。
    expect(buildMinQuery(t('daily_overview')).sql)
      .toMatch(/^SELECT arg_min\("stat_date", TRY_CAST\("stat_date" AS TIMESTAMPTZ\)\) AS mn FROM "daily_overview" WHERE regexp_matches\("stat_date", '\^\[0-9\]\{4\}/)
  })

  it('无 timeColumn 的表不能构造时间查询（纯函数层直接拒绝，不生成半截 SQL）', () => {
    expect(() => buildTableQuery({ table: t('staff'), since: NOW, now: NOW }))
      .toThrow(/没有时间列/)
    expect(() => buildCoverageQuery({ table: t('staff'), now: NOW }))
      .toThrow(/没有时间列/)
    expect(() => buildMinQuery(t('staff'))).toThrow(/没有时间列/)
  })
})
