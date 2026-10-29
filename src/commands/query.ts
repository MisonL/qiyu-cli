// src/commands/query.ts —— E-T8/T9：`query --sql`（spec §五）与 `query --table`（spec §六）。
//
// 形态沿 store.ts / db.ts：parseStoreFlags（值位守卫）→ usageFail/fail 双通道 →
// 查询层统一错误出口 thrownToQueryExit。
//
// ⚠️ 本文件另有一份自己的 `parseFlags`（下方的 `FLAG_TOKENS` 值位守卫：`--sql` 允许取值
// 以 `--` 开头的行注释），**不与 store-flags.ts 的 parseStoreFlags 合并** —— 语义有意不同。
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
import type { SandboxSession } from '../query/sandbox.js'
import { suggestNames, thrownToQueryExit, driftFailureFor, emitQueryFailure, MISSING_TABLE_CAUSES } from '../query/errors.js'
import { maskQueryRows } from '../query/mask.js'
import { parseTimeArg, shanghaiIso, msToShanghaiIso, shanghaiYesterdayStart } from '../core/time.js'
import { TABLES, tableByName } from '../store/schema.js'
import type { TableDef, TimeColumnKind } from '../store/schema.js'
import {
  buildCoverageQuery, buildMinQuery, buildTableQuery, effectiveBound, validateGroupBy,
} from '../query/table-query.js'
import type { BuiltTableQuery } from '../query/table-query.js'
import { openGuardedSession } from './db.js'
import { queryFieldNotes } from './query-notes.js'
import { ok, fail, usageFail, sanitizeControlChars, describeArgs, setPretty } from '../output.js'
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES, REJECTED_FLAGS, STORE_FLAGS, valueFlagNames } from './spec-types.js'
import type { CommandSpec, FlagSpec } from './spec-types.js'

/**
 * `query` 的业务 flag。`--group-by` 标 `repeatable`：可重复给（每次吃一个值）。
 * 存储定位三件套直接用 `STORE_FLAGS`（与 `parseStoreFlags` 同一份事实源）。
 */
const QUERY_FLAGS: FlagSpec[] = [
  { name: '--sql', kind: 'value' },
  { name: '--table', kind: 'value' },
  { name: '--since', kind: 'value' },
  { name: '--until', kind: 'value' },
  { name: '--group-by', kind: 'repeatable' },
  { name: '--limit', kind: 'value' },
  { name: '--timeout', kind: 'value' },
  { name: '--no-mask', kind: 'bool' },
  ...STORE_FLAGS,
]

/**
 * 命令契约（F 组 D4）：`skill check` 据此判断 skill 正文里的 `qiyu query …` 是否真的存在。
 * `flags` 是**完整接受集**（含全局 flag），`--pretty` 同时在 `rejected` 里。
 * `query` 没有位置参数：表名走 `--table <表>` 的**值位**，不是位置参数。
 */
export const QUERY_SPECS: CommandSpec[] = [
  {
    path: ['query'],
    flags: [...GLOBAL_FLAGS, ...QUERY_FLAGS],
    positionals: [],
    rejected: REJECTED_FLAGS,
  },
]

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

const KNOWN = new Set(GLOBAL_FLAG_NAMES)

/**
 * 值位参数（缺值或值以 `--` 开头 → 报缺值，防止把下一个 flag 当取值）。
 * 从 `QUERY_FLAGS` 派生而不是手写：`--db/--profile/--backend` 与 spec 的 `STORE_FLAGS`
 * 同源，`--group-by` 以 `repeatable` 形态自动落入值位。
 */
const VALUE_FLAGS = new Set(valueFlagNames(QUERY_FLAGS))

/**
 * 全部已知 flag token（含布尔 flag 与 help/pretty）。
 * 值位守卫用它区分两件事：「取值恰好是下一个 flag」（真缺值）与
 * 「取值只是以 `--` 开头」（SQL 的行注释，合法输入）。
 */
const FLAG_TOKENS = new Set([...VALUE_FLAGS, ...QUERY_FLAGS.map((f) => f.name), ...GLOBAL_FLAG_NAMES])

/**
 * 超时上界 = Node 定时器的最大延迟（2^31−1 ms）。超过它 setTimeout 会**溢出成 1ms**
 * 立即触发 —— 用户本想「几乎不限时」却得到「立刻超时」，是静默的语义反转，必须拒绝。
 */
const TIMEOUT_MAX_MS = 2_147_483_647

/**
 * 0 行警告的触发正则（spec §十）：SQL 文本命中任一业务时间列名即认为这是一次
 * 时间过滤查询 —— 0 行更可能是同步未覆盖该区间，而不是「那段时间真没有数据」。
 */
// ⚠️ 大小写不敏感（契约审查 C-02）：DuckDB 标识符不分大小写，`WHERE STARTTIME …`
// 是合法 SQL；敏感匹配会让 0 行警告静默失效（正是「0 行 ≠ 没有数据」要防的场景）。
const ZERO_ROW_TIME_RE = /\b(stat_date|work_date|hour_ts|startTime|endTime)\b/i

/** 0 行警告的后半句（两个通道同源）；前半句各自说明触发条件与实际区间。 */
const ZERO_ROW_HINT =
  '这不代表没有数据：同步可能未覆盖该区间——用 `qiyu sync status` 查看覆盖范围，或放宽过滤条件'

/**
 * iso-day 字面量比较警告（端到端场景 F3，`--sql` 通道）。
 *
 * `stat_date`/`work_date` 这类 iso-day 列**列内实为 UTC `…Z` 形态**（`2026-10-12T16:00:00.000Z`
 * = 上海 10/13 00:00），而 CLI 的元数据出口（`db tables.time_range`、`db describe.unit`、
 * `resolved_range`）一律呈现 +08:00 形态 —— Agent 会照着自己读到的形态写
 * `WHERE stat_date >= '2026-10-13T00:00:00+08:00'`，而列是 VARCHAR、按**字典序**比较：
 * `'2026-10-12T16:00:00.000Z' >= '2026-10-13T00:00:00+08:00'` 为 false，整整少一天，
 * 退出码 0、四道自证机制一道都不响。
 *
 * 判据 = SQL 文本同时含 iso-day 列名与「日期形态字面量」（纯 `YYYY-MM-DD` 或缺时刻的
 * `…T00:00:00+08:00`）——即 CLI 自己教出去、却在 `--sql` 里比较错的那种写法。
 * 方向安全（多警告）：误报只多一句话；UTC `…Z` 形态与 `--table` 通道不受影响。
 */
// ⚠️ 大小写不敏感，理由同上（`STAT_DATE >= '2026-10-13'` 同样会少一天）。
const ISO_DAY_COL_RE = /\b(stat_date|work_date)\b/i
// ⚠️ 必须同时接受 `T` 与**空格**分隔（场景审查 4）：SQL 里 `'2026-10-12 00:00:00'` 是
// 与 `'…T00:00:00'` 等价的合法写法，旧正则只认 `T` → 空格形态静默少算一天、零 warning。
const DAY_LITERAL_RE = /'\d{4}-\d{2}-\d{2}([T ]00:00:00(\.0+)?(\+08:00)?)?'/
const ISO_DAY_LITERAL_HINT =
  '该列列内是 UTC `…Z` 形态的字符串（上海日零点 = 前一日 16:00Z），按字典序比较，' +
  '日期字面量会**少算或漏掉当天**。要在 --sql 里过滤请写 UTC 形态（如 \'2026-10-12T16:00:00.000Z\'），' +
  '或改用 `qiyu query --table <表> --since/--until`（该通道已处理取整语义）'

/**
 * 截断警告（两个通道**文案必须分开**）。
 *
 * ⚠️ 措辞必须同时点破两件事（设计稿 §9.2「0 行是比报错危险得多的失败模式」的同源推理）：
 * ① 返回的行数不是全部；② **被切掉的那部分里可能正好有缺失数据的窗口**——Agent 看到
 * `truncated:true` 时注意力天然落在「已返回的这些行」上，于是「同步缺口」这类只有看过
 * 全量才能发现的问题被静默跳过。所以警告里要给出替代路径，而不只是说「结果被截断了」。
 *
 * ⚠️ 替代路径**必须在该通道、该表上真的可行**（复审 Minor-2 → PR 前审查 Important）：
 *   · `--sql` 通道：`--since/--until/--group-by` 与 `--sql` 同用会被拒，只能让它改 SQL 的 WHERE；
 *   · `--table` 通道：`--since/--until` 对**无时间列的表**会被拒（25 张表里有 10 张没有
 *     `timeColumn`）——对这些表只能建议 `--group-by`（任何表都支持）与 `db describe`。
 */
function truncationWarning(
  returned: number, limit: number, channel: 'sql' | 'table', hasTimeColumn = true,
): string {
  const head = `结果被 --limit ${limit} 截断，本次只返回 ${returned} 行（不是全部）；`
    + '聚合与「是否存在数据缺口」的判断都不应基于这批不完整的结果——'
  if (channel === 'sql') {
    return head + '请在 SQL 里加 WHERE 条件收窄，或用 `qiyu db describe <表>` 看总行数与时间范围'
  }
  return head + (hasTimeColumn
    ? '请用 `qiyu db describe <表>` 看总行数与时间范围，或加过滤条件（--since/--until/--group-by）收窄'
    : '请用 `qiyu db describe <表>` 看总行数，或用 `--group-by <列>` 聚合成计数收窄'
      + '（该表没有时间列，不接受 --since/--until）')
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
    } else if (a === '--pretty') {
      // G1：已知输出开关（不带值）。不收下会落进 rest 被报成「未知参数：--pretty」。
      // 值位守卫仍优先：`--sql --pretty` 报「--sql 缺少取值」（--pretty ∈ FLAG_TOKENS）。
      continue
    } else out.rest.push(a)
  }
  return out
}

/** `--limit`：1–10000 的整数（spec §5.3；越界/非整数一律 usage，不做静默钳制）。 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 1000
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(n) || n < 1 || n > 10000) {
    throw new Error(`--limit 必须是 1–10000 的整数，收到：${describeArgs([raw])}`)
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
    throw new Error(`--timeout 必须是非负数（秒，0 = 无超时），收到：${describeArgs([raw])}`)
  }
  const ms = Math.round(n * 1000)
  if (ms > TIMEOUT_MAX_MS) {
    throw new Error(
      `--timeout 过大（上限 ${TIMEOUT_MAX_MS / 1000} 秒），收到：${describeArgs([raw])}；` +
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
    throw new Error(`${label} 无法解析：${describeArgs([raw])}。支持 Nd / yesterday / YYYY-MM-DD / ISO 8601（按 Asia/Shanghai）`)
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
  // 区间内实际覆盖的自然日数（仅 iso-day 表有值）——用于发现窗口内部的空洞（场景 F4）。
  let coveredDays: number | null = null
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
    if (row.days !== null && row.days !== undefined) coveredDays = Number(row.days)
  }

  // 脱敏唯一出口（spec §7.2）；--table 通道按列精确命中（mode.kind='table'）。
  const masked = maskQueryRows({
    rows: result.rows, columns: result.columns,
    mode: { kind: 'table', table }, noMask: input.noMask,
  })

  // 库漂移「声明有而实际无」（场景审查 9）：`SELECT *` 只返回库里真实存在的列，
  // 被删掉的列（旧版 CLI/外部工具改过库）会**静默消失**，而 `db tables`/`db describe`
  // 对同一状态会警告。这里补一条，与 `--table` 通道的「表定义之外的列」警告对称。
  // group-by 只返回分组列，缺列是预期行为，不检查。
  const missingCols = input.groupBy.length > 0
    ? []
    : table.columns.map((c) => c.name).filter((n) => !result.columns.includes(n))
  if (missingCols.length > 0) {
    warnings.push(`库中缺列 ${missingCols.join('、')}（表 ${table.name} 的定义里有、实际没有）：`
      + '可能来自旧版 CLI 或库损坏；`qiyu db describe ' + table.name + '` 可核对声明与实况的差异')
  }
  // ⚠️ `COUNT(*)` 经 getRowObjectsJson 是**字符串**（BIGINT）—— 输出必须是 number，
  // 否则 Agent 拿 `"count": "3"` 做算术会静默出错（与 db describe 的 Number() 同款）。
  const rows = input.groupBy.length > 0
    ? masked.rows.map((r) => ({ ...r, count: Number(r.count) }))
    : masked.rows

  // 0 行 ≠ 没有数据（spec §十 / 红线 3）：给了时间过滤而 0 行时附可操作提示。
  if (result.rows.length === 0 && (input.since !== undefined || input.until !== undefined)) {
    warnings.push(zeroRowWarning(plan.resolvedRange, tc, input.until))
  } else if (result.rows.length === 0) {
    // 没给时间过滤也 0 行：spec §十 把「空表」列为 warnings 的触发条件。
    // 这里必须能区分「表空」与「查询没命中」—— `--table` 通道没有 WHERE 子句（除了时间过滤），
    // 所以 0 行且无时间过滤**只可能**是表里没有行。文案与 `stats fields` 的空表警告同源。
    // ⚠️ 不看 warnings 是否已有其他条目（CodeRabbit inline minor）：走到这里的其他警告
    // 只有「库中缺列」漂移（plan.warnings 只在给了时间过滤时非空，那走上一分支）——
    // 缺列说的是 schema、空表说的是数据，两件独立事实都该说；压掉后者 Agent 会把
    // 「0 行」误读成缺列的副作用。
    warnings.push('该表无数据；先运行 `qiyu sync run`')
  }

  // 窗口内部空洞（端到端场景 F4）：iso-day 表 + 完整区间时，比较「区间应覆盖的自然日数」
  // 与「实际有行的自然日数」。MIN/MAX 的 data_coverage 结构上看不见内部缺口 ——
  // 7 天窗口缺一天时 rows 可能恰好是 7，Agent 会把 7 天汇总当成「上周」。
  // 只在有行时提示：0 行已有更准确的成因警告（同步未覆盖 / 区间为空）。
  //
  // ⚠️ 上界缺省（只给 --since）时**必须排除今天**（CodeRabbit 终审 minor）：日报任务的
  // 日对齐切片会跳过当天那个不满一天的残段窗（`isResidualWindow`），所以今天那行要
  // 次日 run 才出现。而缺省上界 = now 再向下取整到今天 0 点，不排除的话
  // `--since 7d` 恒得到「应有 8 天、实际 7 天」——一条几乎每次都误报的警告，
  // 只会教会 Agent 忽略 warnings。显式给了 --until 就按用户说的算，不做这种调整。
  if (coveredDays !== null && plan.resolvedRange !== null && result.rows.length > 0) {
    const hi = input.until === undefined
      ? Math.min(plan.resolvedRange[1], shanghaiYesterdayStart(input.now))
      : plan.resolvedRange[1]
    // ⚠️ 缺口计数必须与 `expectedDays` 用**同一个上界**（正确性审查 F6）：
    // `coveredDays` 来自实际查询区间，缺省上界含今天；而 expectedDays 已排除今天。
    // 今天只要有一行，就会把昨天的真缺口补满 → 零警告（实测：10/13–10/18 + 今天、
    // 缺 10/19，`--since 7d` 输出 warnings: []）。这里按夹紧后的 hi 再算一次。
    let daysInWindow = coveredDays
    if (hi < plan.resolvedRange[1]) {
      const clamped = buildCoverageQuery({ ...input, until: hi })
      const row = (await session.run(clamped.sql, {
        params: clamped.params, timeoutMs: input.timeoutMs,
      })).rows[0] ?? {}
      daysInWindow = row.days === null || row.days === undefined ? coveredDays : Number(row.days)
    }
    const expectedDays = Math.max(0, Math.round((hi - plan.resolvedRange[0]) / 86_400_000) + 1)
    if (daysInWindow < expectedDays) {
      const scope = input.until === undefined ? '（不含今天：当天数据次日才同步）' : ''
      warnings.push(`区间内应有 ${expectedDays} 个自然日${scope}，实际只有 ${daysInWindow} 个有数据`
        + '（窗口内部存在缺口）；用 `qiyu sync status` 查看缺口详情，或放宽过滤条件')
    }
  }

  // 截断不得静默（同上）：`--limit` 生效时 Agent 读到的不是全量。
  // 无时间列的表不能建议 --since/--until（那是条走不通的路），故传入 tc 是否存在。
  if (result.truncated) {
    warnings.push(truncationWarning(rows.length, input.limit, 'table', tc !== undefined))
  }

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
      // 图例：9 个键逐条释义（两个通道共用一份，分叉写必然漂移）。
      field_notes: queryFieldNotes(),
    },
  )
}

export interface QueryDeps {
  /** 时钟注入点（缺省 Date.now）：--since/--until 的相对时间与缺省上界都取它。 */
  now?: () => number
}

export async function queryCommand(argv: string[], deps: QueryDeps = {}): Promise<number> {
  setPretty(false) // G1：每条命令入口重置输出格式 —— 同一进程内多次 run（测试）不残留上一条命令的开关。
  // 次序沿 store.ts / db.ts：--help 分流 → --pretty 开启缩进（G1） → parseStoreFlags → 未知参数。
  // ⚠️ 本文件实际调用的是**自有的** `parseFlags`（语义故意不同：`--sql` 允许取值以 `--`
  // 开头，见文件头）；这一步在整条次序里的位置与 store.ts 的 parseStoreFlags 相同。
  if (argv.includes('--help') || argv.includes('-h')) {
    // --help 不吞额外参数；--pretty 豁免（同族惯例）。
    // 措辞不用「未知参数」：`--sql` 是已知参数、只是不能与 --help 同时出现（同一条闸门）。
    const extra = argv.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`--help 不接受额外参数：${extra.join(' ')}`)
    process.stdout.write(USAGE)
    return 0
  }
  // G1：--pretty 已实现 —— 命令行合法即开启缩进输出（原拒绝点，次序不变）。
  if (argv.includes('--pretty')) setPretty(true)

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
      return usageFail(`未知表：${describeArgs([name])}`,
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

  // 配置解析 → 库前置检查 → 打开沙箱 → schema_version 探测：E 族三个命令共用同一条
  // 路径（db.ts 的 openGuardedSession）。合并的理由见那里的注释：探测口径与文案
  // 一旦三处各写一份，Agent 会在不同命令上得到互相矛盾的解释（架构审查 Important #2）。
  const opened = await openGuardedSession({
    db: flags.db, profile: flags.profile, backend: flags.backend,
  })
  if ('exit' in opened) return opened.exit
  const session = opened.session

  try {
    // 库结构校验（缺 schema_version → store_not_initialized）在 openGuardedSession 里
    // 已做（E 族共用，口径见 db.ts 的注释）——这里不重复探测。
    //
    // ⚠️ 本命令特有的第二条：**目标表**在库中是否存在（端到端场景 F1）。
    // `TABLES` 声明了它、`information_schema` 里没有 = 建库不完整或表被删，是环境问题
    // 而非拼写错误。此前它会一路走到 SQL 执行、由 Catalog Error 翻译成「表 X 不存在 +
    // 候选：<前缀相似的另一张表>」并返回退出码 2 —— Agent 会把库损坏读成自己写错，
    // 并照候选去查一张口径完全不同的表。口径与 `stats fields` 一致（同一条 message 形态），
    // hint 补上「声明有而库中无」的两种成因（不得承诺 store init 一定能修）。
    if (tableDef !== undefined) {
      const exists = await session.run(
        "SELECT 1 FROM information_schema.tables WHERE table_schema='main' AND table_name='" +
        tableDef.name + "'")
      if (exists.rows.length === 0) {
        return fail({
          code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
          message: `数据库中缺表：${tableDef.name}（本表在 CLI 的表定义中存在，库里没有）`,
          hint: MISSING_TABLE_CAUSES + '。用 `qiyu db tables` 查看库中实际有数据的表',
        })
      }
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
    // iso-day 列 + 日期形态字面量 → 按字符串比较会少一天（场景 F3）。与 0 行无关：
    // 非 0 行也可能已经悄悄少了一整天，这正是它危险的地方。
    if (ISO_DAY_COL_RE.test(sqlText) && DAY_LITERAL_RE.test(sqlText)) {
      warnings.push(ISO_DAY_LITERAL_HINT)
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
        // 与 --table 通道同一份图例（键集相同，见 query-notes.ts）。
        field_notes: queryFieldNotes(),
      },
    )
  } catch (e) {
    // --table 通道的 SQL 是代码生成的：撞上库漂移时把原因说对（PR 前契约审查 Minor），
    // 否则 Agent 会按「请检查 SQL 语法」去改它没写过的东西。
    // `flags.noMask` 一路传到出口：转换错误会回显表里的真实值（CodeRabbit 终审 major），
    // 只有显式 --no-mask 才允许原样输出。
    if (tableDef !== undefined) {
      const drift = driftFailureFor(tableDef, e)
      if (drift !== null) return emitQueryFailure(drift, flags.noMask)
    }
    return thrownToQueryExit(e, TABLES, flags.noMask)
  } finally {
    await session.close()
  }
}
