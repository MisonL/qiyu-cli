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
import { suggestNames, thrownToQueryExit, driftFailureFor, emitQueryFailure, missingTableCauses } from '../query/errors.js'
import {
  maskQueryRows, withoutLiterals, withoutComments, queryCallArgs, readSqlString, sqlFunctionCalls, skipSqlTrivia,
} from '../query/mask.js'
import { parseTimeArg, shanghaiIso, msToShanghaiIso, shanghaiYesterdayStart } from '../core/time.js'
import { TABLES, tableByName } from '../store/schema.js'
import type { TableDef, TimeColumnKind } from '../store/schema.js'
import {
  buildCoverageQuery, buildDirtyTimeQuery, buildMinQuery, buildTableQuery, effectiveBound, validateGroupBy,
} from '../query/table-query.js'
import type { BuiltTableQuery } from '../query/table-query.js'
import { openGuardedSession } from './db.js'
import { queryFieldNotes } from './query-notes.js'
import { DB_PATH_HELP } from './store-flags.js'
import {
  ok, fail, usageFail, sanitizeControlChars, describeArgs, setPretty, syncRunCommand,
  dbTablesCommand, dbDescribeCommand, syncStatusCommand, queryTableCommand, querySqlCommand,
  SQL_ARG_REPLACE_NOTE,
  storeLocationFromFlags, storeLocationOf,
} from '../output.js'
import type { StoreLocation } from '../output.js'
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES, helpArgsError, REJECTED_FLAGS, STORE_FLAGS, valueFlagNames } from './spec-types.js'
import type { CommandSpec, FlagSpec } from './spec-types.js'

/**
 * `query` 的业务 flag。`--group-by` 标 `repeatable`：可重复给（每次吃一个值）。
 * 存储定位三件套直接用 `STORE_FLAGS`（与 `parseStoreFlags` 同一份事实源）。
 */
const QUERY_FLAGS: FlagSpec[] = [
  // ⚠️ `dashValue`：`--sql` 的取值可以以 `--` 开头（SQL 的行注释 `-- …`）。
  // 它同时驱动本文件的值位守卫与帮助模式检查（`spec-types.ts` 的 `helpArgsError`）——
  // 一个字段两个消费者，不各写一份判据。
  { name: '--sql', kind: 'value', dashValue: true },
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
${DB_PATH_HELP}

只接受单条只读查询（DuckDB 判为「只读」的语句都放行：SELECT、DESCRIBE、SHOW、EXPLAIN、
PRAGMA 查询形态、VALUES、TABLE <表>、FROM <表> 等）；写操作、SET/CALL 之类的实例配置、多语句、
文件与网络访问一律被沙箱拦截。实测放行/拦截清单见 README「只读沙箱」。
`

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

/** 取值允许以 `--` 开头的值位 flag（`FlagSpec.dashValue`，唯一事实源）。 */
const DASH_VALUE_FLAGS = new Set(QUERY_FLAGS.filter((f) => f.dashValue === true).map((f) => f.name))

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

/**
 * 0 行警告的后半句（两个通道同源）；前半句各自说明触发条件与实际区间。
 * 带本次存储定位：`sync status` 不带 `--db` 会去看默认库的覆盖范围（#45 边界 ②）。
 */
function zeroRowHint(loc?: StoreLocation): string {
  return '这不代表没有数据：同步可能未覆盖该区间——用 `' + syncStatusCommand(loc)
    + '` 查看覆盖范围，或放宽过滤条件'
}

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
 * 判据 = SQL 文本同时含 iso-day 列名与「会被字典序比较错的一天」形态的**单引号字面量**
 *（`dayLiteralHint`，下方）。方向安全（多警告）：误报只多一条附带修复方法的 warning。
 */
// ⚠️ 大小写不敏感，理由同上（`STAT_DATE >= '2026-10-13'` 同样会少一天）。
const ISO_DAY_COL_RE = /\b(stat_date|work_date)\b/i
/**
 * 单引号字面量的内容里是否有「按字典序比较会少一天」的形态。
 *
 * 列内只存两种合法形态：上海日零点写成 `YYYY-MM-DDT16:00:00.000Z`（UTC 数值），
 * 或整值为 NULL。按字典序比较时，下列字面量都会把前端那一天排除或错位：
 *   · `YYYY-MM-DD` / `YYYY-MM-DD 00:00:00` / `…T00:00:00`（任何不带时区或 +08:00 的写法）
 *   · `YYYY-MM-DD…Z`（**这是 UTC 时刻，不是上海日**：`'…T00:00:00Z'` 只有上海 08:00 起才算数）
 *   · `YYYY-MM-DD…+08:00` 以外的偏移（如 `+0800`、`…-05:00`）
 * 唯一的合法写法（UTC 16:00Z 且带小数秒，如 `'2026-10-12T16:00:00.000Z'`）放行。
 *
 * 2026-11-09 实测漏报（旧 `DAY_LITERAL_RE` 只认 `YYYY-MM-DD[ 或 T]00:00:00[.0…][+08:00]`）：
 * `'2026-11-08T00:00:00Z'`、`'2026-11-09 00:00:00.000Z'`、`'2026-11-08T00:00:00.000Z'`
 * 三种都静默少算一天、零 warning —— 其中 `…Z` 形态正是 CLI 自己 `--sql` 示例里教的写法。
 */
// ⚠️ 秒可缺省（CodeRabbit 2026-11-10）：`'2026-10-13 00:00'` / `'…T00:00Z'` 同样按字典序
// 少算一天，要求秒会把它们漏掉（缺秒时 frac/tz 恒为 null → 下面按「不是列内形态」返回 true）。
const DAY_VALUE_RE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?)?$/
function isMiscomparedDayLiteral(v: string): boolean {
  const m = DAY_VALUE_RE.exec(v.trim())
  if (m === null) return false
  if (m[2] === undefined) return true                             // 纯日期
  // ⚠️ 命中了时刻但没给小数秒/时区时，分组是 `null`（不是 `undefined`）—— 两种都按「不是列内形态」
  // 处理；只判 `undefined` 会让这种字面量一路走到最后返回 false（2026-11-10 回归发现）。
  const frac = m[5] ?? null
  const tz = m[6] ?? null
  if (frac === null || tz === null) return true                    // 没有小数秒或没有时区：不可能是列内形态
  // 只有恰好 `.000` 才是列内形态（Codex 2026-11-10 P2）：`.123` 这类字面量在字典序上会
  // 排在 `…16:00:00.000Z` 之后、把当天行排除在外，旧判据（≥3 位即放行）会静默漏报。
  if (frac !== '000') return true                                  // 列内形态恒为三位 `.000`（`.123` 在字典序上把当天行排除）
  if (m[2] !== '16' || m[3] !== '00' || m[4] !== '00') return true  // 不是 16:00:00 的 UTC 形态
  return tz !== 'Z'                                                // `+08:00`/`+0800` 等一律错位
}

/**
 * `--sql` 通道的日期字面量警告判据（单一实现点）。
 *
 * 词法复用 `mask.ts` 的同一个状态机（`withoutComments` / `withoutLiterals`，逐位对齐）：
 * 列名在「抹掉注释与字面量」的文本上找（注释里的 `-- WHERE stat_date …` 不是真条件；
 * `"stat_date"` 双引号标识符原样保留、仍算列名）；字面量在「只抹注释」的文本上按
 * 单引号状态逐个读出（`'it''s'` 是转义、不是两个字面量）。
 */
function dayLiteralHint(sql: string, loc?: StoreLocation): string | null {
  // `query('<内层 SQL>')` 包装（沙箱放行的形态）里真正执行的是**实参内的 SQL**：
  // `withoutLiterals` 会把整个实参抹掉，只看外层就会漏掉内层里的错位日字面量
  //（Codex 2026-11-10 第二轮 P2，实测 `SELECT * FROM query($$…stat_date >= '2026-10-13'$$)`
  // 少算一天却零警告）。递归检查每个实参的内层 SQL（内层还能再套 query()）。
  let unexpandable = false
  for (const inner of queryCallArgs(withoutComments(sql), () => { unexpandable = true })) {
    const innerHint = dayLiteralHint(inner, loc)
    if (innerHint !== null) return innerHint
  }
  // 注释先抹成空白（逐位对齐）：注释里写的 `-- WHERE stat_date >= '…'` 不是真条件。
  const code = withoutComments(sql)
  // ⚠️ 不要只判 `withoutLiterals(code)`：列名可能藏在**有执行语义的字符串**里 ——
  // `COLUMNS('stat_date')` / `COLUMNS('stat.*')` 是列选择器（实测
  // `WHERE COLUMNS('stat_date') >= '2026-10-13'` 两天夹具只计一天，Codex 2026-11-10 第六轮 P2），
  // 而 `withoutLiterals` 会把整个串抹掉。也不能放宽到 `code` 原样：普通字面量里的
  // `'stat_date'` 不是列引用，那会让无关日期字面量也报上。
  if (unexpandable) return unexpandableQueryHint(loc)
  if (!ISO_DAY_COL_RE.test(withoutLiterals(code)) && !hasDayColumnSelector(code)) return null
  // 在「只抹注释」的文本上找孤立的**开引号**。`withoutComments` 原样保留双引号标识符与
  // 美元引号体，所以这两段必须整体跳过（CodeRabbit 2026-11-10）：`SELECT "it's" …` 里的
  // `'` 会被当成开引号、把后面的真实字面量吞进一个假字面量，警告静默丢失。
  for (let i = 0; i < code.length; i++) {
    if (code[i] === '"') {
      // 双引号标识符：`""` 是转义引号（与单引号串同款）
      for (i++; i < code.length; i++) {
        if (code[i] === '"') { if (code[i + 1] !== '"') break; i++ }
      }
      continue
    }
    // 字面量（单引号 / E 串 / 美元引号）：体**本身**就可以是日期字面量（`$$2026-10-13$$`
    // 实测与 `'2026-10-13'` 等价，CodeRabbit 2026-11-10 第五轮）；解码与读取走 `mask.ts`
    // 的同一实现（`readSqlString`）。标识符边界由它的美元引号判据负责。
    const lit = readSqlString(code, i)
    if (lit !== null) {
      if (isMiscomparedDayLiteral(lit.value)) return isoDayLiteralHint(loc)
      i = lit.end - 1
      continue
    }
  }
  return null
}

/**
 * SQL 里是否有**列选择器**里的字面量指向时间列：`COLUMNS('stat_date')` / `COLUMNS('stat.*')` /
 * `"COLUMNS"('…')`。
 *
 * `COLUMNS(<正则字符串>)` 的串是**执行语义**（选择哪些列），不是普通字面量 —— 实测
 * `WHERE COLUMNS('stat_date') >= '2026-10-13'` 两天夹具只计一天。判据限定在 COLUMNS 的
 * 实参里：任意位置的普通字符串不当列名。参数按 DuckDB 的正则语义解释；非法正则由
 * DuckDB 自己报错，这里不据此报警。
 */
function hasDayColumnSelector(code: string): boolean {
  for (const { open } of sqlFunctionCalls(code, 'columns')) {
    const lit = readSqlString(code, skipSqlTrivia(code, open))
    if (lit === null) continue
    if (ISO_DAY_COL_RE.test(lit.value)) return true
    try {
      const rx = new RegExp(lit.value, 'i')
      if (rx.test('stat_date') || rx.test('work_date')) return true
    } catch { /* 非法正则：DuckDB 会自己报错，这里不据此报警 */ }
  }
  return false
}

/**
 * `query()` 的实参不是单个静态字符串（拼接 / 函数调用）：内层 SQL 随时可以拼出
 * `stat_date >= '2026-10-13'` 这类错位日字面量，而静态判据看不见 —— 声明检查边界
 * （Codex 2026-11-10 第六轮 P2 实测 `query('SELECT ' || '1')` 被冒认成内层 `SELECT `）。
 */
function unexpandableQueryHint(loc?: StoreLocation): string {
  return 'SQL 的 `query()` 实参不是单个静态字符串（拼接 / 函数调用等）：内层 SQL 无法静态展开，'
    + '其中是否含「少算一天」的日期过滤**无法检查**——请确认内层用的是 UTC 形态'
    + '（如 \'2026-10-12T16:00:00.000Z\'），或改用 `' + queryTableCommand('<表>', loc) + '`'
}

function isoDayLiteralHint(loc?: StoreLocation): string {
  return '该列列内是 UTC `…Z` 形态的字符串（上海日零点 = 前一日 16:00Z），按字典序比较，' +
    '这个日期字面量会**少算或漏掉一天**（`…Z` 是 UTC 时刻，不是上海日）。要在 --sql 里过滤请写 UTC 形态' +
    '（如 \'2026-10-12T16:00:00.000Z\'），或改用 `' + queryTableCommand('<表>', loc) + ' --since/--until`（该通道已处理取整语义）'
}

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
  loc?: StoreLocation,
): string {
  const head = `结果被 --limit ${limit} 截断，本次只返回 ${returned} 行（不是全部）；`
    + '聚合与「是否存在数据缺口」的判断都不应基于这批不完整的结果——'
  const describe = dbDescribeCommand('<表>', loc)
  if (channel === 'sql') {
    return head + '请在 SQL 里加 WHERE 条件收窄，或用 `' + describe + '` 看总行数与时间范围'
  }
  return head + (hasTimeColumn
    ? '请用 `' + describe + '` 看总行数与时间范围，或加过滤条件（--since/--until/--group-by）收窄'
    : '请用 `' + describe + '` 看总行数，或用 `--group-by <列>` 聚合成计数收窄'
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
  // 值位 flag 重复出现必须报错（Codex 2026-11-10 P2）：此前只有 `parseStoreFlags` 拒绝，
  // 而本解析器同样直接赋值 —— `query --db a --db b` 静默作用在后一个库上。
  // `--group-by` 例外：它本来就允许重复（spec §六）。
  const seen = new Set<string>()
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1]
      // 值位守卫（沿 store.ts / db.ts）：值位缺失，或取值**恰好是已知 flag** → 报缺值，
      // 否则 `query --sql --limit 2` 会把 --limit 当成 SQL 文本。
      // ⚠️ `--sql` 只拒绝「恰好是已知 flag」的值：SQL 以 `--` 开头是合法行注释
      // （`--sql '-- 注释\nSELECT 1'` 必须能跑）。路径/名字/数字/时间的合法取值不会以 `--`
      // 开头，所以其余值位参数仍按前缀拒绝。两条分支由 `FlagSpec.dashValue` 选择
      //（与帮助模式的 `helpArgsError` 同源，2026-11-06 Codex 审查）。
      if (v === undefined || (DASH_VALUE_FLAGS.has(a) ? FLAG_TOKENS.has(v) : v.startsWith('--'))) {
        throw new Error(`${a} 缺少取值`)
      }
      if (a !== '--group-by') {
        if (seen.has(a)) throw new Error(`${a} 重复出现：只能给一次（不做静默覆盖）`)
        seen.add(a)
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
  loc?: StoreLocation,
): string {
  const tail = zeroRowHint(loc)
  if (range !== null) {
    return `查询在区间 [${shanghaiIso(range[0])}, ${shanghaiIso(range[1])}] 返回 0 行。${tail}`
  }
  if (tc !== undefined && until !== undefined) {
    return `查询在上限 ${shanghaiIso(effectiveBound(tc.kind, until))}（下界未能解析）返回 0 行。${tail}`
  }
  return `查询在给定时间条件下返回 0 行。${tail}`
}

interface TableRunInput {
  table: TableDef
  /** 本次解析出的库路径与档名（空表 warning 的 sync run 建议必须指回它们，见 output.ts）。 */
  dbPath: string
  profileFlag?: string
  since?: number
  until?: number
  groupBy: string[]
  limit: number
  timeoutMs: number
  noMask: boolean
  now: number
}

/**
 * 诊断性计数（best-effort）：**失败返回 null，绝不把已成功的查询拖红**。
 *
 * ⚠️ 2026-11-05 审查（Codex PR #68 第三轮 P2）：脏时间值计数是全表扫描，若它撞上
 * `--timeout`，同步等待会把「主查询与覆盖统计都成功」的整条命令变成失败 —— 数据拿不到，
 * 而这条计数只是为了补一条警告。诊断失败降级为警告，退出码与 rows 不受影响。
 * 导出供单测直接验证成败两条分支（真实超时难以稳定构造）。
 */
export async function runDiagnosticCount(
  session: Pick<SandboxSession, 'run'>, sql: string, params: unknown[], timeoutMs: number,
): Promise<number | null> {
  try {
    const r = await session.run(sql, { params, timeoutMs })
    return Number(r.rows[0]?.n ?? 0)
  } catch {
    return null
  }
}

/**
 * `--table` 的执行路径（spec §六）：解析缺省下界 → 主查询 → 覆盖统计 → 脱敏 → 信封。
 * 所有 SQL 由 `query/table-query.ts` 的纯函数构造（表/列已过闭集）。
 */
async function runTableQuery(session: SandboxSession, input: TableRunInput): Promise<number> {
  const { table } = input
  const tc = table.timeColumn
  const warnings: string[] = []
  // 本次存储定位：所有诊断 hint（db describe / query --table / sync status）都要指回它，
  // 否则照 hint 执行会读默认库（#45 边界 ②）。
  const loc: StoreLocation = input.profileFlag === undefined
    ? { db: input.dbPath }
    : { db: input.dbPath, profile: input.profileFlag }

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

  // 脏时间值不得静默丢掉（2026-11-05 审查修）：时间过滤的 WHERE 里同时挂着形态谓词
  //（正确性 F8），脏值行不会出现在 rows、也不进 data_coverage —— 此前没有任何 warning，
  // 而 `db tables` / `db describe` 对同一张表会报「时间列有 N 个值不符合约定形态」。
  // 没有时间过滤时不报（脏值行照常返回，没有被丢弃）。
  if (tc !== undefined) {
    const dirtyQuery = buildDirtyTimeQuery({
      table, since: input.since, until: input.until, tableMin, now: input.now,
    })
    if (dirtyQuery !== null) {
      // ⚠️ 这是**诊断性**计数（全表扫描），不得成为本次查询成功的前置条件（Codex 2026-11-05
      // 第三轮 P2）：主查询与覆盖统计都已成功返回，若这次计数撞上 --timeout，整条命令会失败、
      // 已算出的数据也拿不到。失败/超时只降级为一条警告，不改变退出码。
      const n = await runDiagnosticCount(session, dirtyQuery.sql, dirtyQuery.params, input.timeoutMs)
      if (n === null) {
        warnings.push(`表 ${table.name} 的时间列 ${tc.name} 的脏值统计未能完成（诊断查询超时或被中断），`
          + '本次时间过滤可能排除了不符合约定形态的值 —— 需要确认时请单独查询该列')
      } else if (n > 0) {
        warnings.push(`表 ${table.name} 的时间列 ${tc.name} 有 ${n} 个值不符合约定形态`
          + '（可能来自旧版 CLI、外部工具或库损坏），本次时间过滤已把它们排除在 rows 与 '
          + 'data_coverage 之外；用 `' + querySqlCommand(loc) + '` 单独查看它们以确认成因（'
          + SQL_ARG_REPLACE_NOTE + '）')
      }
    }
  }

  // 脱敏唯一出口（spec §7.2）；--table 通道按列精确命中（mode.kind='table'）。
  const masked = maskQueryRows({
    rows: result.rows, columns: result.columns,
    mode: { kind: 'table', table }, noMask: input.noMask, loc,
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
      + '可能来自旧版 CLI 或库损坏；`' + dbDescribeCommand(table.name, loc) + '` 可核对声明与实况的差异')
  }
  // ⚠️ `COUNT(*)` 经 getRowObjectsJson 是**字符串**（BIGINT）—— 输出必须是 number，
  // 否则 Agent 拿 `"count": "3"` 做算术会静默出错（与 db describe 的 Number() 同款）。
  const rows = input.groupBy.length > 0
    ? masked.rows.map((r) => ({ ...r, count: Number(r.count) }))
    : masked.rows

  // 0 行 ≠ 没有数据（spec §十 / 红线 3）：给了时间过滤而 0 行时附可操作提示。
  if (result.rows.length === 0 && (input.since !== undefined || input.until !== undefined)) {
    // 区间倒置（只给 --until 且早于表 MIN）的成因已由 buildTimeFilter 的警告说清，
    // 且它是**必然** 0 行 —— 再叠一条「同步可能未覆盖该区间」是假归因
    //（同步正常覆盖了这段，只是上限压根没到开始）（2026-11-09 审计）。
    const inverted = plan.resolvedRange !== null && plan.resolvedRange[0] > plan.resolvedRange[1]
    if (!inverted) warnings.push(zeroRowWarning(plan.resolvedRange, tc, input.until, loc))
  } else if (result.rows.length === 0) {
    // 没给时间过滤也 0 行：spec §十 把「空表」列为 warnings 的触发条件。
    // 这里必须能区分「表空」与「查询没命中」—— `--table` 通道没有 WHERE 子句（除了时间过滤），
    // 所以 0 行且无时间过滤**只可能**是表里没有行。文案与 `stats fields` 的空表警告同源。
    // ⚠️ 不看 warnings 是否已有其他条目（CodeRabbit inline minor）：走到这里的其他警告
    // 只有「库中缺列」漂移（plan.warnings 只在给了时间过滤时非空，那走上一分支）——
    // 缺列说的是 schema、空表说的是数据，两件独立事实都该说；压掉后者 Agent 会把
    // 「0 行」误读成缺列的副作用。
    warnings.push('该表无数据；先运行 `' + syncRunCommand(input.dbPath, input.profileFlag) + '`')
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
    // ⚠️ 夹紧后的上界可能**早于下界**（2026-11-09 实测）：窗口只有今天一格时
    //（`--since <今天>`，iso-day 下 lo = hi = 今天零点），今天被排除 → hi = 昨天零点 < lo。
    // 此时窗口内一个应覆盖的日子都没有：跳过覆盖重算、不报缺口。此前照样拿夹紧后的上界
    // 跑 `buildCoverageQuery` → 抛「区间无效」用法错误，而本段在 usageFail 的 try 之外，
    // 异常冒到顶层被归成 `internal` +「若反复出现请报告此问题」——正常问法被说成内部故障。
    let daysInWindow = coveredDays
    if (hi < plan.resolvedRange[0]) {
      daysInWindow = 0
    } else if (hi < plan.resolvedRange[1]) {
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
        + '（窗口内部存在缺口）；用 `' + syncStatusCommand(loc) + '` 查看缺口详情，或放宽过滤条件')
    }
  }

  // 截断不得静默（同上）：`--limit` 生效时 Agent 读到的不是全量。
  // 无时间列的表不能建议 --since/--until（那是条走不通的路），故传入 tc 是否存在。
  if (result.truncated) {
    warnings.push(truncationWarning(rows.length, input.limit, 'table', tc !== undefined, loc))
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
    // ⚠️ 判据与其他命令族同源（spec 的完整接受集），不是只看全局 flag：`query --table
    // sessions --help` 是合法的帮助请求，此前被判「--help 不接受额外参数：--table sessions」
    // 退 2。`--sql` 的取值可能以 `--` 开头，但那不影响「未知 flag 判定」—— 取值一律跳过。
    const problem = helpArgsError(argv, QUERY_SPECS.flatMap((sp) => sp.flags), '。--help 不接受额外参数')
    // ⚠️ 渲染走 `describeArgs`（空串/纯空白要显示成 `''`/`' '`），不是 `join(' ')`。
    if (problem !== undefined) return usageFail(problem)
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
        candidates.length > 0
          ? `候选：${candidates.join('、')}`
          : '用 `' + dbTablesCommand(storeLocationFromFlags(flags)) + '` 查看可用表')
    }
    try {
      validateGroupBy(tableDef, flags.groupBy, storeLocationFromFlags(flags))
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
  // ⚠️ 不传探测超时 hint：本命令**有** --since/--until/--limit/--timeout，探测也用
  // `DEFAULT_TIMEOUT_HINT`（「缩小时间范围或加过滤条件」）才对。传元数据口径会让
  // 探测超时时建议用户改用 `qiyu query --sql` —— 正是他正在跑的命令
  //（CodeRabbit 2026-11-05 第六轮 minor）。
  const opened = await openGuardedSession({
    db: flags.db, profile: flags.profile, backend: flags.backend,
  })
  if ('exit' in opened) return opened.exit
  const session = opened.session
  // 已解析的存储定位：--sql 通道与错误出口的诊断 hint 都指回它（#45 边界 ②）。
  const openedLoc = storeLocationOf(opened.dbPath, opened.profileFlag)

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
          hint: missingTableCauses(opened.dbPath, opened.profileFlag) + '。用 `'
            + dbTablesCommand(openedLoc) + '` 查看库中实际有数据的表',
        })
      }
    }

    if (tableDef !== undefined) {
      return await runTableQuery(session, {
        table: tableDef, dbPath: opened.dbPath, profileFlag: opened.profileFlag,
        since: sinceMs, until: untilMs, groupBy: flags.groupBy,
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
      loc: openedLoc,
    })

    // 0 行 ≠ 没有数据（spec §十 / 红线 3）：时间过滤查询 0 行时附可操作提示。
    const warnings: string[] = []
    if (result.rows.length === 0 && ZERO_ROW_TIME_RE.test(sqlText)) {
      warnings.push(`查询返回 0 行，且 SQL 引用了业务时间列。${zeroRowHint(openedLoc)}`)
    }
  // ⚠️ 不要在这里重复判 `ISO_DAY_COL_RE.test(sqlText)`（CR/Codex 2026-11-10 第六轮）：
    // 列名可能只在 `COLUMNS('stat.*')` 的选择器串里，外层 gate 会让内层 hint 永远看不到它。
    // 列名判定只在 `dayLiteralHint` 里做（含选择器形态）。
    const dayHint = dayLiteralHint(sqlText, openedLoc)
    if (dayHint !== null) warnings.push(dayHint)
    // 截断不得静默：Agent 会把「只看到前 N 行」当成事实（spec §十）。
    if (result.truncated) {
      warnings.push(truncationWarning(masked.rows.length, limit, 'sql', true, openedLoc))
    }

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
      const drift = driftFailureFor(tableDef, e, openedLoc)
      if (drift !== null) return emitQueryFailure(drift, flags.noMask)
    }
    return thrownToQueryExit(e, TABLES, flags.noMask, openedLoc)
  } finally {
    await session.close()
  }
}
