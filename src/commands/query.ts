// src/commands/query.ts —— E-T8/T9：`query --sql`（spec §五）与 `query --table`（spec §六）。
//
// 形态沿 store.ts / db.ts：parseFlags（值位守卫）→ usageFail/fail 双通道 →
// 查询层统一错误出口 thrownToQueryExit。
//
// 三条硬约束：
//   · 执行只走 `query/sandbox.ts` 的三层只读沙箱（spec §5.1）——本文件不直接触碰
//     DuckDB 驱动（驱动包名字面量禁止出现在 src/commands/，layering 红线）；
//   · 默认脱敏，原始值必须显式 `--no-mask`（spec §七）。脱敏的唯一出口是
//     `query/mask.ts`，本文件不自己改值；
//   · 0 行 ≠ 没有数据（spec §十）：SQL 含时间列、或 --table 给了时间过滤而结果 0 行
//     → 必须附可操作警告。
//
// `--table` 的 SQL 构造在 `query/table-query.ts`（纯函数，单测不加载 CLI/引擎）：
// 表名/列名只来自 `TABLES` 闭集并加双引号，外部取值只进 `?` 参数位。
import { resolveStoreConfig } from '../store/config.js'
import { openSandbox } from '../query/sandbox.js'
import type { SandboxSession } from '../query/sandbox.js'
import { suggestNames, thrownToQueryExit } from '../query/errors.js'
import { maskQueryRows } from '../query/mask.js'
import { parseTimeArg, shanghaiIso, msToShanghaiIso } from '../core/time.js'
import { TABLES, tableByName } from '../store/schema.js'
import type { TableDef, TimeColumnKind } from '../store/schema.js'
import {
  buildCoverageQuery, buildMinQuery, buildTableQuery, effectiveBound, validateGroupBy,
} from '../query/table-query.js'
import type { BuiltTableQuery } from '../query/table-query.js'
import { statGuard } from './db.js'
import { ok, fail, usageFail, sanitizeControlChars, describeArgs } from '../output.js'

const USAGE = `用法：qiyu query <查询方式> [参数]

查询方式（二选一）：
  query --sql <SQL>        任意只读 SQL（三层只读沙箱 + 默认脱敏 + 行数上限 + 超时）
  query --table <表>       受约束查询通道（TABLES 闭集校验 + 时间过滤 + 分组计数 + 默认脱敏）

参数：
  --since <时间>           起始时间（仅 --table）：Nd / yesterday / YYYY-MM-DD / ISO 8601，按 Asia/Shanghai 解析
  --until <时间>           结束时间（仅 --table）：同上；日期型时间列含 --until 所在自然日全天
  --group-by <列>          按列分组计数（仅 --table，可重复给多列；不接受敏感列）
  --limit <n>              最多返回行数，1–10000 的整数（默认 1000）
  --timeout <秒>           超时秒数，非负数，0 = 无超时（默认 30）
  --no-mask                关闭默认脱敏，输出原始 PII（不要写入日志或对外报表）
  --db <path> / --profile <name> / --backend <name>
                           存储定位（与 store / sync 命令同族）

只接受单条 SELECT / DESCRIBE / SHOW / EXPLAIN；写操作、多语句、文件与网络访问一律被沙箱拦截。
`

const KNOWN = new Set(['--help', '-h', '--pretty'])

/** 值位参数（缺值或值以 `--` 开头 → 报缺值，防止把下一个 flag 当取值）。 */
const VALUE_FLAGS = new Set([
  '--sql', '--table', '--since', '--until', '--group-by',
  '--limit', '--timeout', '--db', '--profile', '--backend',
])

/**
 * 全部已知 flag token（含布尔 flag 与 help/pretty）。
 * 值位守卫用它区分两件事：「取值恰好是下一个 flag」（真缺值）与
 * 「取值只是以 `--` 开头」（SQL 的行注释，合法输入）。
 */
const FLAG_TOKENS = new Set([...VALUE_FLAGS, '--no-mask', '--help', '-h', '--pretty'])

/**
 * 超时上界 = Node 定时器的最大延迟（2^31−1 ms）。超过它 setTimeout 会**溢出成 1ms**
 * 立即触发 —— 用户本想「几乎不限时」却得到「立刻超时」，是静默的语义反转，必须拒绝。
 */
const TIMEOUT_MAX_MS = 2_147_483_647

/**
 * 0 行警告的触发正则（spec §十）：SQL 文本命中任一业务时间列名即认为这是一次
 * 时间过滤查询 —— 0 行更可能是同步未覆盖该区间，而不是「那段时间真没有数据」。
 */
const ZERO_ROW_TIME_RE = /\b(stat_date|work_date|hour_ts|startTime|endTime)\b/

/** 0 行警告的后半句（两个通道同源）；前半句各自说明触发条件与实际区间。 */
const ZERO_ROW_HINT =
  '这不代表没有数据：同步可能未覆盖该区间——用 `qiyu sync status` 查看覆盖范围，或放宽过滤条件'

/**
 * 截断警告（两个通道**文案必须分开**）。
 *
 * ⚠️ 措辞必须同时点破两件事（设计稿 §9.2「0 行是比报错危险得多的失败模式」的同源推理）：
 * ① 返回的行数不是全部；② **被切掉的那部分里可能正好有缺失数据的窗口**——Agent 看到
 * `truncated:true` 时注意力天然落在「已返回的这些行」上，于是「同步缺口」这类只有看过
 * 全量才能发现的问题被静默跳过。所以警告里要给出替代路径，而不只是说「结果被截断了」。
 *
 * ⚠️ 替代路径**必须在该通道真的可行**（复审 Minor-2）：`--since/--until/--group-by` 与
 * `--sql` 同用会被拒（`--sql` 只接受 SQL 文本），建议 Agent 加它们等于给一条走不通的路。
 * `--sql` 通道只能让它改 SQL 里的 WHERE。
 */
function truncationWarning(returned: number, limit: number, channel: 'sql' | 'table'): string {
  const head = `结果被 --limit ${limit} 截断，本次只返回 ${returned} 行（不是全部）；`
    + '聚合与「是否存在数据缺口」的判断都不应基于这批不完整的结果——'
  return head + (channel === 'table'
    ? '请用 `qiyu db describe <表>` 看总行数与时间范围，或加过滤条件（--since/--until/--group-by）收窄'
    : '请在 SQL 里加 WHERE 条件收窄，或用 `qiyu db describe <表>` 看总行数与时间范围')
}

interface QueryFlags {
  sql?: string
  table?: string
  since?: string
  until?: string
  groupBy: string[]
  limit?: string
  timeout?: string
  noMask: boolean
  db?: string
  profile?: string
  backend?: string
}

function parseFlags(argv: string[]): QueryFlags & { rest: string[] } {
  const out: QueryFlags & { rest: string[] } = { noMask: false, groupBy: [], rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1]
      // 值位守卫（沿 store.ts / db.ts）：值位缺失，或取值**恰好是已知 flag** → 报缺值，
      // 否则 `query --sql --limit 2` 会把 --limit 当成 SQL 文本。
      // ⚠️ `--sql` 只拒绝「恰好是已知 flag」的值：SQL 以 `--` 开头是合法行注释
      // （`--sql '-- 注释\nSELECT 1'` 必须能跑）。路径/名字/数字/时间的合法取值不会以 `--`
      // 开头，所以其余值位参数仍按前缀拒绝。
      if (v === undefined || (a === '--sql' ? FLAG_TOKENS.has(v) : v.startsWith('--'))) {
        throw new Error(`${a} 缺少取值`)
      }
      if (a === '--sql') out.sql = v
      else if (a === '--table') out.table = v
      else if (a === '--since') out.since = v
      else if (a === '--until') out.until = v
      else if (a === '--group-by') out.groupBy.push(v)   // 可重复（spec §六）
      else if (a === '--limit') out.limit = v
      else if (a === '--timeout') out.timeout = v
      else if (a === '--db') out.db = v
      else if (a === '--profile') out.profile = v
      else out.backend = v
      i++
    } else if (a === '--no-mask') {
      out.noMask = true
    } else out.rest.push(a)
  }
  return out
}

/** `--limit`：1–10000 的整数（spec §5.3；越界/非整数一律 usage，不做静默钳制）。 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 1000
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(n) || n < 1 || n > 10000) {
    throw new Error(`--limit 必须是 1–10000 的整数，收到：${raw}`)
  }
  return n
}

/**
 * `--timeout`：非负秒数，0 = 无超时（spec §5.3）。
 * ⚠️ 极小正数（如 0.0001）四舍五入后是 0ms —— 若原样传给沙箱就变成「无超时」，
 * 与用户意图相反；钳到 1ms，保证「给了正数就真的有超时」。
 * ⚠️ 上界见 `TIMEOUT_MAX_MS`：超过 Node 定时器上限会溢出成立即超时，必须拒绝。
 */
function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return 30_000
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0) {
    throw new Error(`--timeout 必须是非负数（秒，0 = 无超时），收到：${raw}`)
  }
  const ms = Math.round(n * 1000)
  if (ms > TIMEOUT_MAX_MS) {
    throw new Error(
      `--timeout 过大（上限 ${TIMEOUT_MAX_MS / 1000} 秒），收到：${raw}；` +
      '再大会溢出 Node 定时器、变成立即超时。若想不限时请用 --timeout 0')
  }
  return n > 0 && ms === 0 ? 1 : ms
}

/**
 * 时间参数归一（形态沿 `src/commands/sync-run.ts`）：`Nd`/`yesterday` 返回完整区间
 * （`--since` 取 .start、`--until` 取 .end）；`YYYY-MM-DD`/ISO 返回时刻。
 * 无法解析 → 抛错（命令层转 usage），不静默当成「无过滤」。
 *
 * ⚠️ `--until` 取区间形态时**必须减 1ms**，与 sync-run.ts 的 `.end` 不同：
 * `parseTimeArg` 返回的是**半开窗口** `[start, end)`（`yesterday` = `[昨天0点, 今天0点)`）。
 * sync-run 拿 `.end` 当窗口右端（半开，正确）；而查询的谓词是**闭区间** `<=`，
 * 直接把 `.end` 当上界会多含一天：iso-day 列取整后上界落在「今天 0 点」，正好等于
 * 今天那行的 stat_date —— 用户说「只要昨天」却拿到昨天 + 今天，退出码 0、无 warning。
 * 减 1ms 后 iso-day 取整得昨天 0 点（正确）、iso-instant/epoch-ms 得 `…23:59:59.999`
 * （正确）。**这不是笔误，改回 `.end` 会把静默多算一天重新引入。**
 */
function resolveTimeFlag(
  raw: string | undefined, label: '--since' | '--until', clock: () => number,
): number | undefined {
  if (raw === undefined) return undefined
  const v = parseTimeArg(raw, clock, label)
  if (v === null) {
    throw new Error(`${label} 无法解析：${raw}。支持 Nd / yesterday / YYYY-MM-DD / ISO 8601（按 Asia/Shanghai）`)
  }
  if (typeof v !== 'object') return v
  return label === '--since' ? v.start : v.end - 1
}

/**
 * 查表 MIN 的返回值 → epoch 毫秒（契约 B）。
 * epoch-ms 列经 MIN(TRY_CAST) 出来是 BIGINT（JSON 安全值是字符串）；iso 列是 ISO 字符串。
 * 无值/不可解析 → null（不编造一个边界）。
 */
function toEpochMs(v: unknown, kind: TimeColumnKind): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = kind === 'epoch-ms' ? Number(v) : Date.parse(String(v))
  return Number.isFinite(n) ? n : null
}

/** 0 行警告（spec §十）：说明**实际生效**的区间，没有完整区间时如实说明。 */
function zeroRowWarning(
  range: [number, number] | null, tc: TableDef['timeColumn'], until?: number,
): string {
  if (range !== null) {
    return `查询在区间 [${shanghaiIso(range[0])}, ${shanghaiIso(range[1])}] 返回 0 行。${ZERO_ROW_HINT}`
  }
  if (tc !== undefined && until !== undefined) {
    return `查询在上限 ${shanghaiIso(effectiveBound(tc.kind, until))}（下界未能解析）返回 0 行。${ZERO_ROW_HINT}`
  }
  return `查询在给定时间条件下返回 0 行。${ZERO_ROW_HINT}`
}

interface TableRunInput {
  table: TableDef
  since?: number
  until?: number
  groupBy: string[]
  limit: number
  timeoutMs: number
  noMask: boolean
  now: number
}

/**
 * `--table` 的执行路径（spec §六）：解析缺省下界 → 主查询 → 覆盖统计 → 脱敏 → 信封。
 * 所有 SQL 由 `query/table-query.ts` 的纯函数构造（表/列已过闭集）。
 */
async function runTableQuery(session: SandboxSession, input: TableRunInput): Promise<number> {
  const { table } = input
  const tc = table.timeColumn
  const warnings: string[] = []

  // 只给 --until：先查该表时间列下界（契约 B）。空表 → 不解析，交给纯函数出 warning。
  // 超时预算与主查询同一口径（--timeout 0 = 不限时）。
  let tableMin: number | null | undefined
  if (tc !== undefined && input.since === undefined && input.until !== undefined) {
    const minRow = (await session.run(buildMinQuery(table).sql, { timeoutMs: input.timeoutMs }))
      .rows[0] ?? {}
    tableMin = toEpochMs(minRow.mn, tc.kind)
  }

  let plan: BuiltTableQuery
  try {
    plan = buildTableQuery({
      table, since: input.since, until: input.until, tableMin,
      groupBy: input.groupBy, now: input.now,
    })
  } catch (e) {
    return usageFail(sanitizeControlChars((e as Error).message))
  }
  warnings.push(...plan.warnings)

  const result = await session.run(plan.sql, {
    params: plan.params, limit: input.limit, timeoutMs: input.timeoutMs,
  })

  // data_coverage（契约 D）：表有 timeColumn 时**恒计算**，独立查询、不受 limit 截断影响；
  // 过滤范围与主查询同一谓词（不是全表 MIN/MAX）。
  let dataCoverage: { min: string; max: string } | null = null
  if (tc !== undefined) {
    const cov = buildCoverageQuery({
      table, since: input.since, until: input.until, tableMin, now: input.now,
    })
    const row = (await session.run(cov.sql, { params: cov.params, timeoutMs: input.timeoutMs }))
      .rows[0] ?? {}
    if (row.mn !== null && row.mn !== undefined && row.mx !== null && row.mx !== undefined) {
      dataCoverage = {
        min: msToShanghaiIso(row.mn as string | number),
        max: msToShanghaiIso(row.mx as string | number),
      }
    }
  }

  // 脱敏唯一出口（spec §7.2）；--table 通道按列精确命中（mode.kind='table'）。
  const masked = maskQueryRows({
    rows: result.rows, columns: result.columns,
    mode: { kind: 'table', table }, noMask: input.noMask,
  })
  // ⚠️ `COUNT(*)` 经 getRowObjectsJson 是**字符串**（BIGINT）—— 输出必须是 number，
  // 否则 Agent 拿 `"count": "3"` 做算术会静默出错（与 db describe 的 Number() 同款）。
  const rows = input.groupBy.length > 0
    ? masked.rows.map((r) => ({ ...r, count: Number(r.count) }))
    : masked.rows

  // 0 行 ≠ 没有数据（spec §十 / 红线 3）：给了时间过滤而 0 行时附可操作提示。
  if (result.rows.length === 0 && (input.since !== undefined || input.until !== undefined)) {
    warnings.push(zeroRowWarning(plan.resolvedRange, tc, input.until))
  } else if (result.rows.length === 0 && warnings.length === 0) {
    // 没给时间过滤也 0 行：spec §十 把「空表」列为 warnings 的触发条件。
    // 这里必须能区分「表空」与「查询没命中」—— `--table` 通道没有 WHERE 子句（除了时间过滤），
    // 所以 0 行且无时间过滤**只可能**是表里没有行。文案与 `stats fields` 的空表警告同源。
    warnings.push('该表无数据；先运行 `qiyu sync run`')
  }

  // 截断不得静默（同上）：`--limit` 生效时 Agent 读到的不是全量。
  if (result.truncated) warnings.push(truncationWarning(rows.length, input.limit, 'table'))

  // --no-mask 的风险警告属于「脱敏整体关闭」，进 meta.warnings；mask_warnings 只装
  // 静态缺口警告（没脱敏就没有「脱敏不完整」可言）。spec §7.2。
  const maskWarnings = input.noMask ? [] : masked.warnings
  if (input.noMask) warnings.push(...masked.warnings)

  return ok(
    { columns: result.columns, rows },
    {
      rows: rows.length,
      truncated: result.truncated,
      limit_applied: input.limit,
      masked: !input.noMask,
      masked_columns: masked.maskedColumns,
      mask_warnings: maskWarnings,
      warnings,
      // 回显实际生效区间（不是用户原始输入）：iso-day 两端都是上海日零点（契约 C）。
      resolved_range: plan.resolvedRange === null
        ? null
        : [shanghaiIso(plan.resolvedRange[0]), shanghaiIso(plan.resolvedRange[1])],
      data_coverage: dataCoverage,
    },
  )
}

export interface QueryDeps {
  /** 时钟注入点（缺省 Date.now）：--since/--until 的相对时间与缺省上界都取它。 */
  now?: () => number
}

export async function queryCommand(argv: string[], deps: QueryDeps = {}): Promise<number> {
  // 次序沿 store.ts / db.ts：--help 分流 → --pretty 显式拒绝 → parseFlags → 未知参数。
  if (argv.includes('--help') || argv.includes('-h')) {
    // --help 不吞额外参数；--pretty 豁免（同族惯例）。
    // 措辞不用「未知参数」：`--sql` 是已知参数、只是不能与 --help 同时出现（同一条闸门）。
    const extra = argv.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`--help 不接受额外参数：${extra.join(' ')}`)
    process.stdout.write(USAGE)
    return 0
  }
  if (argv.includes('--pretty')) return usageFail('--pretty 尚未实现 —— 目前只输出紧凑 JSON')

  let flags: ReturnType<typeof parseFlags>
  try { flags = parseFlags(argv) } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }
  // describeArgs：空串/纯空白参数渲染成 `''`/`' '`，不让消息变成「未知参数：」冒号后空白。
  if (flags.rest.length > 0) return usageFail(`未知参数：${describeArgs(flags.rest)}`)

  // —— 查询方式：互斥且至少给一个（spec §六）——
  const { sql, table } = flags
  if (sql !== undefined && table !== undefined) {
    return usageFail('--sql 与 --table 互斥，只能给一个')
  }
  // 时间/分组参数只属于 --table：与 --sql 同用时不能静默忽略（用户会以为过滤生效了）。
  if (sql !== undefined
    && (flags.since !== undefined || flags.until !== undefined || flags.groupBy.length > 0)) {
    return usageFail(
      '--since / --until / --group-by 只适用于 --table，不能与 --sql 同用；' +
      '--sql 请把时间条件直接写进 SQL')
  }
  if (sql === undefined && table === undefined) {
    return usageFail('缺少查询方式：请给 --sql <SQL> 或 --table <表>')
  }

  // 时钟只取一次：同一条命令里 Nd 的 end、缺省上界、区间校验必须站在同一时刻。
  const nowMs = (deps.now ?? (() => Date.now()))()

  // —— --table：闭集校验先于一切 I/O（拼错表/列名不必先打开库，db.ts 同款次序）——
  let tableDef: TableDef | undefined
  let sinceMs: number | undefined
  let untilMs: number | undefined
  if (table !== undefined) {
    const name = sanitizeControlChars(table)
    tableDef = tableByName(name)
    if (tableDef === undefined) {
      const candidates = suggestNames(name, TABLES.map((t) => t.name))
      return usageFail(`未知表：${name}`,
        candidates.length > 0 ? `候选：${candidates.join('、')}` : '用 `qiyu db tables` 查看可用表')
    }
    try {
      validateGroupBy(tableDef, flags.groupBy)
      sinceMs = resolveTimeFlag(flags.since, '--since', () => nowMs)
      untilMs = resolveTimeFlag(flags.until, '--until', () => nowMs)
    } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }
    if (tableDef.timeColumn === undefined && (sinceMs !== undefined || untilMs !== undefined)) {
      const usable = TABLES.filter((t) => t.timeColumn !== undefined).map((t) => t.name)
      return usageFail(
        `表 ${tableDef.name} 没有时间列，不支持 --since/--until`,
        `支持时间过滤的表：${usable.join('、')}`)
    }
  }

  let limit: number
  let timeoutMs: number
  try {
    limit = parseLimit(flags.limit)
    timeoutMs = parseTimeoutMs(flags.timeout)
  } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }

  let config
  try {
    config = resolveStoreConfig({
      flags: { db: flags.db, profile: flags.profile, backend: flags.backend },
      env: {
        QIYU_DB_PATH: process.env.QIYU_DB_PATH,
        QIYU_STORE_BACKEND: process.env.QIYU_STORE_BACKEND,
        QIYU_PROFILE: process.env.QIYU_PROFILE,
      },
    }).config
  } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }

  // 库前置检查（ENOENT / 非普通文件 / 权限三分 → 退出码 1，hint 指 store init）。
  const guarded = statGuard(config.path)
  if (guarded !== null) return guarded

  let session: SandboxSession
  try {
    session = await openSandbox(config)
  } catch (e) { return thrownToQueryExit(e, TABLES) }

  try {
    // 库结构校验（spec §十一「库不存在/缺表 → store_not_initialized、退出码 1」）。
    // ⚠️ 必须有：合法 DuckDB 但**没有 schema_version** 的库（空库 / 别的工具建的库 /
    // 迁移没跑完）在沙箱里照样能执行 SQL，于是 `SELECT 1` 会「成功」—— 而 `masked:true`
    // 的语义建立在本 CLI 的 PII 列集上，对不认识的 schema 这个声明没有依据；
    // `SELECT * FROM sessions` 更会得到「表不存在，候选：sessions」，把 Agent 引去改 SQL，
    // 而正确处置是 `qiyu store init`。探测口径与 commands/db.ts 同款（限定 main schema，
    // 避免同名表在别的 schema 里被误认）。
    const sv = await session.run(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='main' AND table_name='schema_version'")
    if (sv.rows.length === 0) {
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库结构不完整（缺表）：${config.path}`,
        hint: '目标数据库不是本 CLI 创建的，请换 --db 路径，或先运行：qiyu store init',
      })
    }

    if (tableDef !== undefined) {
      return await runTableQuery(session, {
        table: tableDef, since: sinceMs, until: untilMs, groupBy: flags.groupBy,
        limit, timeoutMs, noMask: flags.noMask, now: nowMs,
      })
    }

    // —— --sql 通道（上方「至少给一个」闸门 + 已返回的 --table 分支保证 sql 存在）——
    const sqlText = sql as string
    const result = await session.run(sqlText, { limit, timeoutMs })
    // 脱敏唯一出口（spec §7.2）：列名级 + 值级兜底 + 缺口警告都在 mask.ts 内。
    const masked = maskQueryRows({
      rows: result.rows, columns: result.columns,
      mode: { kind: 'sql', sql: sqlText, tables: TABLES }, noMask: flags.noMask,
    })

    // 0 行 ≠ 没有数据（spec §十 / 红线 3）：时间过滤查询 0 行时附可操作提示。
    const warnings: string[] = []
    if (result.rows.length === 0 && ZERO_ROW_TIME_RE.test(sqlText)) {
      warnings.push(`查询返回 0 行，且 SQL 引用了业务时间列。${ZERO_ROW_HINT}`)
    }
    // 截断不得静默：Agent 会把「只看到前 N 行」当成事实（spec §十）。
    if (result.truncated) warnings.push(truncationWarning(masked.rows.length, limit, 'sql'))

    // --no-mask 的风险警告属于「脱敏整体关闭」，进 meta.warnings；mask_warnings 只装
    // 静态缺口警告（没脱敏就没有「脱敏不完整」可言）。spec §7.2。
    const maskWarnings = flags.noMask ? [] : masked.warnings
    if (flags.noMask) warnings.push(...masked.warnings)

    return ok(
      { columns: result.columns, rows: masked.rows },
      {
        rows: masked.rows.length,
        truncated: result.truncated,
        limit_applied: limit,
        masked: !flags.noMask,
        masked_columns: masked.maskedColumns,
        mask_warnings: maskWarnings,
        warnings,
        // --sql 通道无法通用判定请求区间与数据覆盖（spec §十）：恒 null，不猜。
        resolved_range: null,
        data_coverage: null,
      },
    )
  } catch (e) {
    return thrownToQueryExit(e, TABLES)
  } finally {
    await session.close()
  }
}
