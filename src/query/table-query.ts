// src/query/table-query.ts —— `query --table` 的 SQL 构造（纯函数，spec §四/§六）。
//
// 纯函数边界：不碰 DuckDB、不读文件、不写 stdout/stderr、不读系统时钟（`now` 由调用方注入）。
// 命令层负责：表名闭集查找、时间参数解析（parseTimeArg）、查表 MIN、执行与脱敏。
//
// 三条硬约束：
//   1. **注入面为零**：表名/列名只来自 `TABLES`（`TableDef`），拼进 SQL 前已过闭集校验并加双引号；
//      外部取值（时间）只进 `?` 参数位，数值参数保持 number（`String()` 会退化成 VARCHAR 比较，
//      epoch-ms 按字典序排会错）。
//   2. **时间列三形态**（spec §四）：iso-day 两端都向下取整到上海日零点——直接用
//      `ms.toISOString()` 会让「9/15 12:00 的 --since」把 stat_date=9/15 零点的行排除在外；
//      iso-instant 直接字符串比较；epoch-ms 用 `TRY_CAST(... AS BIGINT)`，非数字行按 NULL 被排除。
//   3. **确定性排序**（契约 E）：group-by 用 `count DESC` + 分组列；否则时间列 DESC（无时间列
//      则只有主键）+ 主键 ASC 作 tiebreaker。没有 tiebreaker 时同值行的顺序由引擎决定，
//      同一查询两次可能不同 —— Agent 与测试都无法接受。
//
// ⚠️ `resolved_range` 回显的是**实际生效**的区间（不是用户原始输入）：iso-day 两端都是
// 上海日零点。这是刻意的 —— Agent 要据此知道过滤实际覆盖了哪个自然日（`--since 9/15 12:00`
// 实际从 9/15 00:00 起算；`--until 9/20` 实际覆盖到 9/20 全天）。契约 C。
import { shanghaiDayIso, shanghaiDayStart, shanghaiIso, MAX_SHANGHAI_SAFE_MS } from '../core/time.js'
import { suggestNames } from './errors.js'
import { describeArgs } from '../output.js'
import type { TableDef, TimeColumnKind } from '../store/schema.js'

/** 时间列定义（`TableDef.timeColumn` 的非空形态）。 */
type TimeColumn = NonNullable<TableDef['timeColumn']>

/**
 * `--table` 的用法类错误（未知表/列、敏感列、区间无效）。
 * 纯函数只负责抛，命令层统一转 `usageFail`（退出码 2）—— 与 `parseStoreFlags` 的异常形态同款。
 */
export class TableQueryUsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TableQueryUsageError'
  }
}

export interface TableQueryInput {
  table: TableDef
  /** `--since` 归一后的下界（epoch 毫秒）；undefined = 不加下界谓词。 */
  since?: number
  /** `--until` 归一后的上界（epoch 毫秒）；undefined 且给了 since → 上界取 now（契约 B）。 */
  until?: number
  /**
   * `--since` 缺省但有 `--until` 时，命令层已查到的该表下界（epoch 毫秒，契约 B）。
   * `null` = 表的时间列无值（空表）→ 不加下界谓词、resolved_range 为 null、附 warning。
   * 其余情况（含 since 已给）不使用本字段。
   */
  tableMin?: number | null
  /** `--group-by` 的列（已通过 `validateGroupBy`；这里会再校验一次以防误用）。 */
  groupBy?: readonly string[]
  /** 当前时刻（epoch 毫秒）：`--since` 缺省上界与相对时间（Nd/yesterday）都取它。 */
  now: number
}

export interface BuiltTableQuery {
  sql: string
  params: unknown[]
  /**
   * 实际生效的过滤区间（epoch 毫秒，已按 kind 取整：iso-day 为上海日零点）。
   * null = 没有完整区间可回显（两端都缺省；或只给 --until 且表下界无值）。
   */
  resolvedRange: [number, number] | null
  /** 纯函数层能判定的警告（目前只有「空表导致缺省下界无法解析」）。 */
  warnings: string[]
}

/** 标识符加双引号。调用方保证 name 来自 `TABLES`（闭集）。 */
function quote(name: string): string {
  return `"${name}"`
}

/**
 * 时间列的比较表达式。
 *
 * ⚠️ **一律按解析后的时刻比较，不按原始字符串**（正确性审查 F1/F2/F3，2026-10-20 实测）：
 *   · iso-day 无毫秒形态 `'…T16:00:00Z'` 在字典序上**大于** `'…T16:00:00.000Z'`，
 *     `<= 上界` 会把它漏掉 → `db describe` 说有数据、`query` 说 0 行；
 *   · iso-instant 的 `+08:00` 写法与 `Z` 写法字典序与时间序相反 → 错排/错纳/错漏；
 *   · epoch-ms 必须先 TRY_CAST，字符串比较毫秒数会按字典序得出错误结果。
 * `TRY_CAST(... AS TIMESTAMPTZ)` 对非时间值返回 NULL（被谓词排除），与形态谓词同向。
 */
function timeExprOf(tc: TimeColumn): string {
  return tc.kind === 'epoch-ms'
    ? `TRY_CAST(${quote(tc.name)} AS BIGINT)`
    : `TRY_CAST(${quote(tc.name)} AS TIMESTAMPTZ)`
}

/**
 * 极值聚合：**按时刻排序、返回原始字符串**（与 `commands/db.ts` 的 `timeRangeOf` 同口径）。
 *
 * 不能直接 `MIN(col)` —— 那按字典序选，遇到混合偏移/无毫秒形态会取错（见 `timeExprOf`）。
 * 也不能直接 `MIN(TRY_CAST(... AS TIMESTAMPTZ))` —— 那会把返回值变成 TIMESTAMPTZ 文本
 * （`2026-10-14 00:00:00+08`），改变 `data_coverage` 的输出形态。
 * `arg_min(col, 时刻键)` 两者兼得：按时刻排序、返回列内原值。
 * 键为 NULL 的行（非时间值）不参与，与形态谓词同向。
 */
function aggExprOf(tc: TimeColumn): { mn: string; mx: string } {
  if (tc.kind === 'epoch-ms') {
    return {
      mn: `MIN(TRY_CAST(${quote(tc.name)} AS BIGINT))`,
      mx: `MAX(TRY_CAST(${quote(tc.name)} AS BIGINT))`,
    }
  }
  const col = quote(tc.name)
  const key = `TRY_CAST(${col} AS TIMESTAMPTZ)`
  return { mn: `arg_min(${col}, ${key})`, mx: `arg_max(${col}, ${key})` }
}

/**
 * 时间列的**可用值谓词**（脏值不进 MIN/MAX、不进覆盖统计、不进主查询的时间过滤）。
 *
 * 判据 = 「形态正则命中」**且**「能解析成时刻/整数」：
 *   · iso-day / iso-instant：`regexp_matches(...)` + `TRY_CAST(... AS TIMESTAMPTZ) IS NOT NULL`
 *     —— 实测 `'2026-10-14T02:00Z'`（无秒）通过正则但 `TRY_CAST` 为 NULL，只按正则判会
 *     让它在 `arg_min` 里被静默踢出 time_range（正确性审查 F3）；
 *   · epoch-ms：`TRY_CAST(... AS BIGINT)` 落在合理区间 `(1e11, 8.64e15]`
 *     —— `-1` 是七鱼「无值」哨兵、秒级/微秒级是单位误写，都不该被当成 1970/万年后的时刻
 *     （正确性审查 F5）。写路径对秒级时间戳已有同口径丢弃（`reports.ts` 的 `n <= 1e11`）。
 *
 * ⚠️ 口径必须与 `commands/db.ts` 的 `shapeSqlOf` **逐字一致**（同一条 README 承诺：
 * 「脏值不进 time_range」）。两处分叉的话，同一条脏库会在 `db tables` 被排除、
 * 在 `query --table` 被当成覆盖范围 —— 同一状态两种说法。
 * ⚠️ 主查询的时间谓词也需要它（正确性审查 F8）：否则 `'2026-10-15garbage'` 会出现在
 * rows / group-by 计数里，而 `data_coverage` 把它排除，同一响应内自相矛盾。
 */
function shapeClause(tc: TimeColumn): string[] {
  if (tc.kind === 'epoch-ms') {
    const n = `TRY_CAST(${quote(tc.name)} AS BIGINT)`
    // ⚠️ gap 2：上界与 `msToShanghaiIso` 的守卫同源（`MAX_SHANGHAI_SAFE_MS`）。
    // 旧值 `8640000000000000` 把「回显时抛 RangeError」的值放进候选集。
    return [`${n} > 100000000000`, `${n} <= ${MAX_SHANGHAI_SAFE_MS}`]
  }
  const shape = tc.kind === 'iso-day'
    ? '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$'
    : '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
  // ⚠️ `regexp_matches`，不要用 `~`（实测 DuckDB 1.5.6-r.1 的 `~` 不是正则匹配）。
  // 秒必须存在（`:[0-9]{2}` 不再是可选项）：`T02:00Z` 能过宽松正则却 cast 不了。
  return [
    `regexp_matches(${quote(tc.name)}, '${shape}')`,
    `TRY_CAST(${quote(tc.name)} AS TIMESTAMPTZ) IS NOT NULL`,
  ]
}

/**
 * 生效边界（`resolved_range` 的回显值）：iso-day 取上海日零点，其余原值（契约 A/C）。
 * 导出供命令层在「0 行警告」里说明实际生效的上界。
 */
export function effectiveBound(kind: TimeColumnKind, ms: number): number {
  return kind === 'iso-day' ? shanghaiDayStart(ms) : ms
}

/** 时间谓词的参数占位符：ISO 列必须显式 cast，否则 VARCHAR 与 TIMESTAMPTZ 的比较会退化。 */
function boundPlaceholder(kind: TimeColumnKind): string {
  return kind === 'epoch-ms' ? '?' : 'TRY_CAST(? AS TIMESTAMPTZ)'
}

/** 时间谓词的参数值（契约 A）：iso-day → 上海日零点 ISO；iso-instant → ISO；epoch-ms → number。 */
function boundParam(kind: TimeColumnKind, ms: number): unknown {
  switch (kind) {
    case 'iso-day': return shanghaiDayIso(ms)
    case 'iso-instant': return new Date(ms).toISOString()
    case 'epoch-ms': return ms
  }
}

/**
 * `--group-by` 的闭集校验（契约 F）：返回校验通过的列（保持用户给定顺序）。
 * 不支持的行/列一律抛 `TableQueryUsageError`：
 *   · 未知列 → 候选来自**本表**列集（suggestNames）；
 *   · 敏感列 → 拒绝（脱敏会把不同取值归并成同一个分组键，分组与计数都会失真）；
 *   · 重复列 → 拒绝（不静默去重，否则 Agent 会以为按两列分组）。
 */
export function validateGroupBy(table: TableDef, groupBy: readonly string[]): string[] {
  const names = table.columns.map((c) => c.name)
  const sensitive = new Set(table.columns.filter((c) => c.sensitive === true).map((c) => c.name))
  const seen = new Set<string>()
  for (const name of groupBy) {
    if (!names.includes(name)) {
      const candidates = suggestNames(name, names)
      const hint = candidates.length > 0
        ? `候选：${candidates.join('、')}`
        : `该表列：${names.join('、')}`
      throw new TableQueryUsageError(
        `--group-by 未知列：${describeArgs([name])}（表 ${table.name} 无此列）；${hint}`)
    }
    if (sensitive.has(name)) {
      throw new TableQueryUsageError(
        `--group-by 不接受敏感列 ${name}：脱敏会把不同取值归并成同一个分组键，`
        + '分组结果无法区分（计数本身准确，但每个分组代表哪些原值不可知）。'
        + '确需按原值分组请改用 `qiyu query --sql --no-mask`（显式承担 PII 风险）')
    }
    if (seen.has(name)) {
      throw new TableQueryUsageError(`--group-by 列重复：${name}（同一列只能给一次，不做静默去重）`)
    }
    seen.add(name)
  }
  return [...groupBy]
}

interface TimeFilter {
  clauses: string[]
  params: unknown[]
  resolvedRange: [number, number] | null
  warnings: string[]
}

/**
 * 时间谓词（契约 A/B）+ resolved_range（契约 C）。`buildTableQuery` 与 `buildCoverageQuery`
 * 共用这一处，保证「主查询的过滤范围」与「覆盖统计的过滤范围」永远是同一个谓词。
 */
function buildTimeFilter(input: TableQueryInput): TimeFilter {
  const { table, since, until } = input
  const tc = table.timeColumn
  const empty: TimeFilter = { clauses: [], params: [], resolvedRange: null, warnings: [] }
  if (tc === undefined) {
    if (since !== undefined || until !== undefined) {
      throw new TableQueryUsageError(`表 ${table.name} 没有时间列，不支持 --since/--until`)
    }
    return empty
  }
  if (since === undefined && until === undefined) return empty

  const warnings: string[] = []
  let lower = since
  if (lower === undefined) {
    // 只给了 --until：下界取该表时间列 MIN（命令层已查，契约 B）。
    const mn = input.tableMin
    if (mn === undefined || mn === null) {
      // ⚠️ 措辞不得断言「表为空」（审查 Minor 3）：`MIN(TRY_CAST(...))` 为 NULL 有两种成因
      // ——表真的没有行，或该列全为 NULL/非数字（epoch-ms 列里脏值会被 TRY_CAST 折成 NULL）。
      // 说成「表为空」在第二种情形下是假话，Agent 会据此判断「同步没跑」。
      warnings.push(
        `表 ${table.name} 的时间列 ${tc.name} 无可用值（表为空，或该列全为 NULL/非数字），`
        + '无法解析缺省下界；本次查询仅限制上界')
    } else lower = mn
  }
  // --until 缺省但有 --since → 上界 = 当前时刻（契约 B）。
  const upper = until ?? (since !== undefined ? input.now : undefined)

  const clauses: string[] = []
  const params: unknown[] = []
  let resolvedRange: [number, number] | null = null
  if (lower !== undefined && upper !== undefined) {
    const lo = effectiveBound(tc.kind, lower)
    const hi = effectiveBound(tc.kind, upper)
    // 只有 `lo > hi` 才是用法错误（真·倒置区间）。
    // ⚠️ `lo === hi` **必须放行**：iso-day 列存的就是日零点，`>= X AND <= X` 是合法的
    // 单日查询（「就看 9/15 这一天」「看今天」都落在这里）。早先写成 `>=` 会把这两种
    // 最自然的问法判成「区间无效」，而 `--since 9/14`（不给 until）却能返回 9/14 + 9/15
    // 两行——同一个意图两种结局，Agent 只能改用 --sql。
    // iso-instant/epoch-ms 的单点区间同样放行：结果为 0 行 + 既有 0 行警告，比用法错误更符合事实。
    // ⚠️ 只校验用户给出的 since：`--since` 缺省时下界来自表 MIN，「表里最早的数据晚于
    // --until」是数据事实（0 行 + 0 行警告），不是用法错误 —— 不能把它变成退出码 2。
    if (since !== undefined && lo > hi) {
      throw new TableQueryUsageError(
        `区间无效：生效下界 ${shanghaiIso(lo)} 晚于生效上界 ${shanghaiIso(hi)}` +
        (tc.kind === 'iso-day' ? '（日期型时间列两端都取上海日零点）' : '') +
        '；请调整 --since / --until')
    }
    resolvedRange = [lo, hi]
    // 下界来自表 MIN 时可能出现 lo > hi（「表里最早的数据晚于 --until」）：这不是用法
    // 错误（用户只给了一个端点），但 resolved_range 会回显一个倒置二元组 —— 不说明成因的话
    // Agent 得自己推断为什么 0 行。spec §十「0 行 ≠ 没有数据」的同类：把成因写在明处。
    if (since === undefined && lo > hi) {
      warnings.push(
        `缺省下界（该表最早数据 ${shanghaiIso(lo)}）晚于上界 ${shanghaiIso(hi)}，本次查询必然 0 行；`
        + '请放宽 --until 或改用 --sql')
    }
  }

  const expr = timeExprOf(tc)
  // 形态+可解析谓词与时间谓词同一 WHERE（正确性审查 F8）：否则脏值会出现在 rows 里，
  // 而 data_coverage 把它们排除 —— 同一响应的两个字段互相矛盾。
  if (lower !== undefined || upper !== undefined) clauses.push(...shapeClause(tc))
  if (lower !== undefined) {
    clauses.push(`${expr} >= ${boundPlaceholder(tc.kind)}`)
    params.push(boundParam(tc.kind, lower))
  }
  if (upper !== undefined) {
    clauses.push(`${expr} <= ${boundPlaceholder(tc.kind)}`)
    params.push(boundParam(tc.kind, upper))
  }
  return { clauses, params, resolvedRange, warnings }
}

/**
 * 构造 `query --table` 的 SQL（契约 A–F）。
 *
 *   SELECT * FROM "t" [WHERE …] [ORDER BY 时间列 DESC, 主键 ASC | 主键 ASC]
 *   SELECT "g1", "g2", COUNT(*) AS count FROM "t" [WHERE …]
 *     GROUP BY "g1", "g2" ORDER BY count DESC, "g1", "g2"
 *
 * 时间列本身就是主键（daily_overview.stat_date）时 tiebreaker 不再重复同一列。
 */
export function buildTableQuery(input: TableQueryInput): BuiltTableQuery {
  const { table } = input
  const groupBy = validateGroupBy(table, input.groupBy ?? [])
  const filter = buildTimeFilter(input)
  const where = filter.clauses.length > 0 ? ` WHERE ${filter.clauses.join(' AND ')}` : ''

  const tc = table.timeColumn
  let select: string
  let tail: string
  if (groupBy.length > 0) {
    const cols = groupBy.map(quote).join(', ')
    select = `${cols}, COUNT(*) AS count`
    // 确定性（契约 E）：count 相同的分组按分组列全序，否则顺序由引擎决定。
    tail = ` GROUP BY ${cols} ORDER BY count DESC, ${cols}`
  } else {
    select = '*'
    const orderBy: string[] = []
    if (tc !== undefined) orderBy.push(`${timeExprOf(tc)} DESC`)
    // tiebreaker：主键 ASC（时间列已在前面排过的不再重复）。
    const pk = table.primaryKey
      .filter((k) => tc === undefined || k !== tc.name)
      .map((k) => `${quote(k)} ASC`)
    if (pk.length > 0) orderBy.push(pk.join(', '))
    tail = orderBy.length > 0 ? ` ORDER BY ${orderBy.join(', ')}` : ''
  }

  const sql = `SELECT ${select} FROM ${quote(table.name)}${where}${tail}`
  return { sql, params: filter.params, resolvedRange: filter.resolvedRange, warnings: filter.warnings }
}

/**
 * `data_coverage` 的查询（契约 D）：与主查询**同一个谓词**（不是全表 MIN/MAX），
 * 独立执行因而不受 `--limit` 截断影响。值原样返回，格式化由命令层统一走 `msToShanghaiIso`。
 *
 * 第二个输出列 `days` 是**区间内的不同自然日数**（端到端场景 F4）：MIN/MAX 结构上
 * 表达不了内部空洞 —— 7 天窗口里缺一天时 rows 可能恰好是 7、看什么都没问题。
 * iso-day 列的行粒度就是一天，直接 `COUNT(DISTINCT)` 即自然日数；iso-instant/epoch-ms
 * 的表不是日粒度（hour_ts 是小时），拿它比日历日没有意义，故为 NULL 由调用方跳过。
 */
export function buildCoverageQuery(input: TableQueryInput): { sql: string; params: unknown[] } {
  const { table } = input
  const tc = table.timeColumn
  if (tc === undefined) {
    throw new TableQueryUsageError(`表 ${table.name} 没有时间列，无法计算 data_coverage`)
  }
  const filter = buildTimeFilter(input)
  // 形态谓词与时间谓词同一 WHERE：buildTimeFilter 在有任一端时已并入 shapeClause；
  // 两端都缺省时（全表覆盖统计）才需要在这里单独补上，避免重复拼接。
  const clauses = filter.clauses.length > 0 ? [...filter.clauses] : [...shapeClause(tc)]
  const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : ''
  const agg = aggExprOf(tc)
  // ⚠️ 自然日数必须按**自然日**去重，不能 COUNT(DISTINCT 原字符串)（正确性审查 F6）：
  // 同一上海日可能有两种写法（`…16:00:00.000Z` 与 `…16:00:00Z`），按字符串数会把
  // 一天算成两天，恰好补齐内部缺口、让真缺口零警告。
  const days = tc.kind === 'iso-day'
    ? `, COUNT(DISTINCT timezone('Asia/Shanghai', ${timeExprOf(tc)})::DATE) AS days`
    : ', NULL AS days'
  return {
    sql: `SELECT ${agg.mn} AS mn, ${agg.mx} AS mx${days} FROM ${quote(table.name)}${where}`,
    params: filter.params,
  }
}

/** 表时间列的下界查询（只给 `--until` 时解析缺省下界，契约 B）。只带形态谓词。 */
export function buildMinQuery(table: TableDef): { sql: string } {
  const tc = table.timeColumn
  if (tc === undefined) {
    throw new TableQueryUsageError(`表 ${table.name} 没有时间列，无法查询下界`)
  }
  // ⚠️ 必须过滤形态（CodeRabbit 终审 minor）：空串在字典序上小于一切 ISO，
  // `MIN` 会返回它 → 命令层判成「该列无可用值」而丢掉缺省下界，尽管表里有合法行。
  // ⚠️ 极值必须按**时刻**取（正确性审查 F2）：`MIN(原始字符串)` 在混合偏移写法下会
  // 选到字典序最小、而不是时刻最早的那一行。`aggExprOf` 用 arg_min 返回原始串。
  const shape = shapeClause(tc)
  const where = shape.length > 0 ? ` WHERE ${shape.join(' AND ')}` : ''
  return { sql: `SELECT ${aggExprOf(tc).mn} AS mn FROM ${quote(table.name)}${where}` }
}
