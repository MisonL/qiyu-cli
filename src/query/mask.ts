// src/query/mask.ts
// E 的默认脱敏纯函数（spec §七）—— `query --table` 与 `query --sql` 共用的唯一脱敏出口。
//
// 纯函数边界：不读文件、不碰 DuckDB、不 console、不改写入参（行对象一律浅拷贝后再改写）。
// 脱敏判定只认 `TableDef.columns[].sensitive` 标记（元数据驱动），不按列名模式泛化 ——
// 标记漏了 = 整列不脱敏，所以这里不做「看起来像 PII 就脱」的猜测。
//
// 两条通道（spec §7.2）：
//   --table：精确。输出列名来自 TABLES，与 sensitive 标记一一对应，无别名 → 列名级即可。
//   --sql：列名级（主防线）+ 值级兜底（别名绕过）+ 缺口警告（SQL 引用了敏感列但输出列名不匹配）。
//
// ⚠️ `payload` 在 `--sql` 通道**不做列名级**（spec §7.2 / plan 决策）：报表表的 payload 是
// 聚合数字 JSON，列名级会把它们整列误杀；会话/工单的 payload 含 PII 则靠值级 JSON 检测兜底
// （实测手机号 99% 行存在，足以命中）。这是显式取舍：`--table` 通道对 payload 仍整值替换。
import type { TableDef } from '../store/schema.js'
import { dbDescribeCommand, queryTableCommand } from '../output.js'
import type { StoreLocation } from '../output.js'

export type MaskRule = 'phone' | 'email' | 'ip' | 'full'

export interface MaskOutcome {
  rows: Record<string, unknown>[]
  /**
   * 本次**实际脱敏**的列名（spec line 217：至少有一行的值在脱敏前后不同），按输出列序。
   * 全 null / 全空串 / 行内缺键 / 非字符串值（maskValue 一律原样返回）的列不出现
   * —— Agent 据此判断输出是否被改写，所以「命中敏感列但一个值都没改」必须不算。
   *
   * ⚠️ 判定用 `!==` 而非 `Object.is`：理论上 NaN 会让「改前 === 改后」成立而被误算成
   * 未脱敏（NaN !== NaN）。但 DuckDB 的 JSON 输出不表示 NaN（数值要么是可序列化数字、
   * 要么是 null），该分支不可达 —— 记在这里是为了别把它当成「漏考虑」，不是待办。
   */
  maskedColumns: string[]
  warnings: string[]
}

export interface MaskInput {
  rows: Record<string, unknown>[]
  /** 输出列名（= DuckDB getRowObjectsJson 的列名，即表定义里的大小写，探针 12）。 */
  columns: string[]
  mode:
    | { kind: 'table'; table: TableDef }
    | { kind: 'sql'; sql: string; tables: TableDef[] }
  /** 关闭全部脱敏（--no-mask）：原样返回 + PII 警告。 */
  noMask?: boolean
  /**
   * 本次存储定位：警告里的诊断命令（`db describe` / `query --table`）必须指回它，
   * 否则照 hint 执行会读默认库（#45 边界 ②）。缺省不带任何 flag（库层单测的用法）。
   */
  loc?: StoreLocation
}

/** spec §7.1：无格式敏感值的整值替换标记。导出供命令层/测试复用，避免文案漂移。 */
export const FULL = '<已脱敏>'

/** spec §7.1 的三个可识别形态。均无 g 标志 —— test 不携带 lastIndex 状态。 */
const PHONE_RE = /^1\d{10}$/
const EMAIL_RE = /^[^@\s]+@[^@\s]+$/
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

/** --no-mask 的 PII 风险警告（spec §7.2）。导出供命令层/测试复用。 */
export const NO_MASK_WARNING = '输出包含未脱敏的客户 PII；不要写入日志或对外报表'
/** 缺口警告上限（spec §7.2：去重、上限 5 条）。 */
const WARNING_LIMIT = 5

// 列名 → 规则（brief 给定，与 spec §7.1 的可识别形态对应）。用显式集合而不是
// `endsWith('Email')` 之类的模式：敏感列清单是实测出来的有限集，模式匹配会随上游
// 命名漂移误伤（例如 staff.email 不是敏感列，但名字里也有 email）。
const PHONE_COLUMNS = new Set(['userPhone', 'crmUserPhone', 'userMobile'])
const EMAIL_COLUMNS = new Set(['userEmail', 'crmUserEmail'])

export function ruleForColumn(name: string): MaskRule {
  if (PHONE_COLUMNS.has(name)) return 'phone'
  if (EMAIL_COLUMNS.has(name)) return 'email'
  if (name === 'fromIp') return 'ip'
  return 'full'
}

/**
 * 按规则转换单个值（spec §7.1）。
 * - `null`/`undefined`/空串原样返回：空值不是 PII，也避免把 null 变成字符串。
 * - 非字符串原样返回：schema 的 PII 列全是 VARCHAR，数字/布尔不可能是合法输入。
 * - 形态与规则不匹配（如带区号的座机走 phone 规则）：**退化为整值 `<已脱敏>`**，不按位截取。
 *   取舍理由：模式不匹配时无法可靠定位「该保留哪几段」，按位截取反而可能暴露更多；
 *   整值替换是 spec §7.1「其余 → 整值替换」的自然延伸（tests/query/mask.test.ts 钉死）。
 */
export function maskValue(v: unknown, rule: MaskRule): unknown {
  if (typeof v !== 'string' || v === '') return v
  switch (rule) {
    case 'phone':
      return PHONE_RE.test(v) ? `${v.slice(0, 3)}****${v.slice(7)}` : FULL
    case 'email': {
      if (!EMAIL_RE.test(v)) return FULL
      const at = v.indexOf('@')
      return `${v[0]}***@${v.slice(at + 1)}`
    }
    case 'ip': {
      if (!IPV4_RE.test(v)) return FULL
      return `${v.split('.').slice(0, 3).join('.')}.*`
    }
    case 'full':
      return FULL
  }
}

/** 值级检测：字符串是否直接呈现为某种 PII 形态。 */
function piiRuleOf(s: string): MaskRule | null {
  if (PHONE_RE.test(s)) return 'phone'
  if (EMAIL_RE.test(s)) return 'email'
  if (IPV4_RE.test(s)) return 'ip'
  return null
}

/**
 * 递归遍历 JSON 解析结果的所有字符串叶子（对象与数组），任一命中 PII 形态即真。
 * 叶子先 trim 再判：与 maskCellByValue 的直接值路径一致，`" 13800138000 "` 也算命中。
 */
function hasPiiLeaf(value: unknown): boolean {
  if (typeof value === 'string') return piiRuleOf(value.trim()) !== null
  if (Array.isArray(value)) return value.some(hasPiiLeaf)
  if (value !== null && typeof value === 'object') return Object.values(value).some(hasPiiLeaf)
  return false
}

/**
 * `--sql` 值级兜底（spec §7.2 第 2 层）—— 只对未被列名级命中的列调用。
 * - trim 后以 `{`/`[` 开头且 JSON.parse 成功 → 遍历全部字符串叶子，任一命中即整值 `<已脱敏>`；
 *   无命中 → 原值不变（报表 payload 的数字 JSON 因此不会被误杀）。
 * - trim 后以 `{`/`[` 开头但 JSON.parse 失败 → 直接 `<已脱敏>`：畸形 JSON 按普通字符串走
 *   邮箱规则只会改写匹配到的那一段，其余字段（含潜在 PII）原样留在输出里；整值替换才不漏。
 * - 否则按普通字符串匹配手机号/邮箱/IPv4 → 按 §7.1 对应规则转换。
 * ⚠️ JSON 分支必须在直接匹配之前：spec 的邮箱正则 `^[^@\s]+@[^@\s]+$` 会整串命中
 * 无空白、恰含一个 `@` 的 JSON（如 `{"email":"a@x.com"}`），先走直接匹配会把整段 JSON
 * 按邮箱规则改成 `{***@x.com"}` —— 既不是整值替换，还会把其余字段原样留在输出里。
 * 返回原值表示「未改写」，调用方据此决定是否计入 maskedColumns。
 */
function maskCellByValue(v: unknown): unknown {
  // ⚠️ 非字符串的 JSON 形态（DuckDB 的 STRUCT/LIST/MAP → JS 对象/数组）必须**整值替换**
  // （security S1，Critical）：`SELECT t FROM sessions t` / `SELECT [t]` / `SELECT {'a':t}`
  // 的值就是整行，里面是全量 PII；而它既不是字符串（旧的 JSON 字符串分支够不着），
  // 也没有列名可归属（列名级够不着）。这类形态只可能来自整行序列化 / struct_pack /
  // list 聚合，没有「聚合数字」这种合法误杀场景（报表 payload 是 VARCHAR 字符串，走下面
  // 的字符串分支）。漏 PII 的代价远高于误杀一个 struct，故一律整值替换。
  if (Array.isArray(v)) return FULL
  if (v !== null && typeof v === 'object') return FULL
  if (typeof v !== 'string' || v === '') return v
  const t = v.trim()
  if (t.startsWith('{') || t.startsWith('[')) {
    try {
      return hasPiiLeaf(JSON.parse(t)) ? FULL : v
    } catch {
      return FULL // 畸形 JSON：无法逐字段判定，整值替换是唯一不漏的选择
    }
  }
  const direct = piiRuleOf(t)
  return direct !== null ? maskValue(t, direct) : v
}

/** `--sql` 列名级集合：全部敏感列名并集，去掉 payload（见文件头取舍）。 */
function sqlSensitiveNames(tables: TableDef[]): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const t of tables) {
    for (const c of t.columns) {
      if (!c.sensitive || c.name === 'payload' || seen.has(c.name)) continue
      seen.add(c.name)
      names.push(c.name)
    }
  }
  return names
}

/**
 * 只在**顶层**（括号外、字面量/注释已被抹成空格）执行正则，返回的 `index` 是**绝对**下标。
 *
 * 用于定位子句起点与 `DISTINCT` 关键字：子查询里的同名子句不算本层的。
 */
function execTopLevel(scan: string, re: RegExp): RegExpExecArray | null {
  let depth = 0
  let inDouble = false
  for (let i = 0; i < scan.length; i++) {
    const ch = scan[i]!
    if (inDouble) { if (ch === '"') { if (scan[i + 1] === '"') i++; else inDouble = false } continue }
    if (ch === '"') { inDouble = true; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue }
    if (depth !== 0 || !/[A-Za-z]/.test(ch)) continue
    if (i > 0 && /[A-Za-z0-9_$]/.test(scan[i - 1]!)) continue
    // ⚠️ 必须要求 `m.index === 0`：起点正则有的带 `^` 有的不带（`GROUP BY` 那条没有）。
    // 不校验就会把「切片里任意位置」的匹配错误地改写成「起始于 i」—— 于是第一个字母
    // 位置就「命中」，切片从错误处开始（实测：所有普通 GROUP BY 查询都不再告警）。
    // 校验通过后再把下标改写成**绝对**下标 i（调用方按 `m.index + m[0].length` 定位）。
    const m = new RegExp(re.source, re.flags.replace(/[gy]/g, '')).exec(scan.slice(i))
    if (m !== null && m.index === 0) { m.index = i; return m }
  }
  return null
}

/**
 * 顶层子句切片：从 `startRe` 匹配处之后切到下一个**顶层**子句关键字（或在结尾）。
 *
 * ⚠️ 为什么需要（Codex 2026-11-05 P2）：分组失真的判据必须看**分组键**本身，
 * 而不是「SQL 里出现过敏感列」—— `SELECT session_type, COUNT(*) … WHERE userPhone = '…'
 * GROUP BY session_type` 里敏感列只用于过滤，脱敏不会改变分组键或计数；按整条 SQL 判
 * 会把这类查询谎报成「分组失真」，警告还建议 `--no-mask`，等于诱导用户白关脱敏。
 *
 * 扫描规则（启发式，边界如实记录）：
 *   · 单/双引号内的内容跳过（`` 'FROM' `` 这种字面量不算子句边界）；
 *   · 括号内不算边界（`GROUP BY (CASE …)` 里的关键字不截断）；
 *   · 只认裸词边界（前面不是标识符字符）。SQL 注释里的关键字仍可能被误认 ——
 *     `--sql` 是单条语句、注释罕见，且误判方向只影响要不要发提示。
 */
function sliceClause(
  sql: string,
  startRe: RegExp,
  stopSource = 'ORDER\\s+BY|LIMIT|HAVING|QUALIFY|WINDOW|UNION|EXCEPT|INTERSECT|FROM',
): string {
  // 定位作用在「抹掉字面量/注释但等长」的文本上，切片仍取原文（偏移逐位对齐）。
  const scan = withoutLiterals(sql)
  // ⚠️ 起点必须找**顶层**的那个（括号外）：`SELECT userPhone … FROM (SELECT … GROUP BY
  // session_type) t GROUP BY userPhone` 里第一个 `GROUP BY` 在子查询里，取它就会漏掉
  // 外层真正决定分组的那一个（Codex 2026-11-05 第四轮 P2 实测：漏报分组失真）。
  const m = execTopLevel(scan, startRe)
  if (m === null) return ''
  const from = m.index + m[0].length
  let depth = 0
  let inSingle = false
  let inDouble = false
  for (let i = from; i < sql.length; i++) {
    const ch = sql[i]!
    if (inSingle) {
      if (ch === "'") { if (sql[i + 1] === "'") i++; else inSingle = false }
      continue
    }
    if (inDouble) {
      if (ch === '"') { if (sql[i + 1] === '"') i++; else inDouble = false }
      continue
    }
    if (ch === "'") { inSingle = true; continue }
    if (ch === '"') { inDouble = true; continue }
    if (ch === '(') { depth++; continue }
    // ⚠️ 深度 0 遇到 `)` = 切片起点在子查询里、子查询到此结束 —— 必须就此收尾：
    // `SELECT * FROM (… GROUP BY session_type) t WHERE userPhone = '1'` 里，越过这个
    // 右括号会把外层 WHERE 并进分组子句，userPhone 就被误认成分组键并谎报分组失真
    //（CodeRabbit PR #68 第二轮指出）。
    if (ch === ')') { if (depth === 0) return sql.slice(from, i); depth--; continue }
    if (depth !== 0 || !/[A-Za-z]/.test(ch)) continue
    if (i > from && /[A-Za-z0-9_$]/.test(sql[i - 1]!)) continue
    if (new RegExp('^(?:' + stopSource + ')\\b', 'i').test(scan.slice(i))) return sql.slice(from, i)
  }
  return sql.slice(from)
}

/** SQL 关键字：解析 `SELECT userPhone FROM t` 时别把 `FROM` 当成别名。 */
const SQL_KEYWORDS = new Set([
  'as', 'from', 'where', 'group', 'order', 'by', 'limit', 'having', 'on', 'join', 'left',
  'right', 'inner', 'outer', 'full', 'cross', 'using', 'union', 'except', 'intersect',
  'qualify', 'window', 'select', 'distinct', 'and', 'or', 'not', 'is', 'null', 'case',
  'when', 'then', 'else', 'end', 'asc', 'desc', 'nulls', 'first', 'last', 'like', 'ilike',
  'in', 'between', 'over', 'partition', 'filter', 'cast', 'collate',
])

/** 聚合函数（判断「这个 SELECT 项是聚合值还是分组键」用，DuckDB 常用集）。 */
const AGGREGATE_FUNCS = new Set([
  'count', 'sum', 'avg', 'mean', 'min', 'max', 'median', 'product', 'list', 'array_agg',
  'string_agg', 'group_concat', 'first', 'last', 'any_value', 'any', 'every', 'bool_and',
  'bool_or', 'bit_and', 'bit_or', 'bit_xor', 'approx_count_distinct', 'approx_quantile',
  'quantile', 'quantile_cont', 'quantile_disc', 'mode', 'histogram', 'stddev', 'stddev_pop',
  'stddev_samp', 'variance', 'var_pop', 'var_samp', 'corr', 'covar_pop', 'covar_samp',
  'skewness', 'kurtosis', 'entropy', 'arg_min', 'arg_max', 'min_by', 'max_by',
  'regr_avgx', 'regr_avgy', 'regr_count', 'regr_intercept', 'regr_r2', 'regr_slope',
  'regr_sxx', 'regr_sxy', 'regr_syy',
])

/**
 * SELECT 项是否以**聚合函数**开头（`max(userPhone) AS userPhone` 是聚合值，不是分组键）。
 * 只看开头：`userPhone || '-x'` 这类表达式是投影出来的分组键（会被打码），不能当成聚合。
 */
const AGGREGATE_CALL = new RegExp(
  `\\b(?:${[...AGGREGATE_FUNCS].join('|')})\\s*\\(`, 'i')

/**
 * SELECT 项是不是**聚合表达式**（`max(userPhone)`、`coalesce(max(userPhone), NULL)` 都算）。
 *
 * ⚠️ 必须搜**整个表达式**，不能只看开头（Codex 2026-11-05 第三轮 P2 实测）：
 * `SELECT coalesce(max(userPhone), NULL) AS userPhone … GROUP BY ALL` 实测返回一行 ——
 * 它明明是聚合值，开头是 coalesce，只看函数名会被当成非聚合项 → 误报分组失真并建议 --no-mask。
 * 覆盖整个表达式是安全的方向：含聚合函数的项不可能同时是分组键（DuckDB 会拒绝）。
 */
function isAggregateItem(item: string): boolean {
  // ⚠️ 双引号标识符（输出别名）里的文本也要剥掉（Codex 2026-11-08 第六轮 P2）：
  // `SELECT userPhone AS "Bob's COUNT(*)'s label", COUNT(*) AS n … GROUP BY userPhone`
  // 是 DuckDB 实测合法查询，别名文本里的 `COUNT(*` 会让投影项被误判成聚合、把真实
  // 手机号投影排除出 `projected` → 分组失真警告静默丢失。别名永远是标识符，不可能
  // 是聚合函数调用本身，剥掉方向安全。
  return AGGREGATE_CALL.test(bareKeywords(item))
}

/**
 * 抹掉单引号字符串字面量与 SQL 注释（判据只看标识符，不看字面量/注释里的文本）。
 *
 * ⚠️ Codex 2026-11-05 第二轮 P3 实测：`SELECT COUNT(*) … GROUP BY 'userPhone'` 是
 * **按常量分组**（实测一行 `n=2`），但字面量里恰好写着列名时，按原文本搜索会谎报分组失真。
 * 双引号是**标识符**（`"userPhone"` 就是那一列），不抹。
 */
/**
 * 把用户/元数据给出的标识符转义成可安全拼进 `RegExp` 的字面量。
 *
 * ⚠️ 别名由用户提供（`SELECT userPhone AS "p("`），DuckDB 实测接受带正则元字符的别名；
 * 不转义时 `new RegExp('\\bp(\\b')` 直接抛 `SyntaxError` —— 查询本身**已经成功**，
 * 却因为脱敏阶段崩掉而让整条命令报 internal、一行数据都拿不回来
 *（CodeRabbit PR #68 第六轮 minor，实测 `"p("`/`"[x"` 两种形态都抛）。
 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 剥掉**所有**引号内容（单引号串、美元引号串、双引号标识符）与注释，只留裸 token。
 * 与 `withoutLiterals` 的区别：双引号标识符也抹掉（那个函数保留它是为了列名匹配）。
 * 用于「这个词是不是 SQL 关键字」的判断 —— `SELECT "SUMMARIZE" AS x`、注释里的
 * `query('SUMMARIZE …')`、字符串字面量里的同名词都不是关键字（Codex 2026-11-08 第三轮 P2）。
 * ⚠️ 抹除保持等长（空格），返回文本的下标与原文逐位对齐。
 */
function bareKeywords(text: string): string {
  const lit = withoutLiterals(text)
  let out = ''
  for (let i = 0; i < lit.length; i++) {
    if (lit[i] !== '"') { out += lit[i]; continue }
    const start = i
    for (i++; i < lit.length; i++) {
      if (lit[i] === '"') { if (lit[i + 1] !== '"') break; i++ }
    }
    out += ' '.repeat(Math.min(i, lit.length - 1) - start + 1)
  }
  return out
}

/**
 * `SUMMARIZE` 是**语句头关键字**（`SUMMARIZE sessions` / `SELECT * FROM (SUMMARIZE …)`），
 * 不是任意位置出现的裸词 —— `SELECT 0 AS SUMMARIZE, 'userName' AS column_name, 3 AS min`
 * 是合法别名（DuckDB 实测），按裸词判会把这条元数据查询误判成统计输出、把数字 3 改成
 * `<已脱敏>`（Codex 2026-11-08 第五轮 P2）。判据作用在 bareKeywords（字面量/注释/双引号
 * 标识符全剥）上，要求是文首，或深度 1 的 `FROM (`/`JOIN (`。旧判据的 `;` 后语句头不认：
 * 多语句被沙箱语句数闸门拒绝（src/query/sandbox.ts 语句数闸门），带 `;` 的 SQL 到不了脱敏。
 *
 * 返回两个信号（调用方据此**声明缺口**，见 maskQueryRows）：
 *   · recognized：可识别的语句头 —— 行级脱敏按 `column_name` 行值生效；
 *   · unrecognizedParen：过标识符边界、前面（跳空白）紧邻 `(`，但不在可识别的层级
 *     （如 `FROM (SELECT * FROM (SUMMARIZE …))`、逗号连接的 `, (SUMMARIZE …)`、CTE 内的
 *     子查询）。这类位置**合法**且输出仍是 SUMMARIZE 形状（真机实测 min/max 明文），
 *     本判据不脱敏 —— 必须由调用方发缺口警告，绝不静默（CodeRabbit 2026-11-08 第七轮
 *     major；`WITH t AS (SUMMARIZE …)` 已被真机否决为 Parser Error —— A CTE needs a SELECT）。
 *     ⚠️ `AS SUMMARIZE` 别名前面不是 `(`，不会进这一档（方向安全，误报会改写元数据数字）。
 */
function summarizeTokenPositions(sql: string): { recognized: boolean; unrecognizedParen: boolean } {
  const bare = bareKeywords(sql)
  const re = /SUMMARIZE/gi
  let recognized = false
  let unrecognizedParen = false
  let m: RegExpExecArray | null
  while ((m = re.exec(bare)) !== null) {
    // ⚠️ `\b` 不够：`SUMMARIZE$q$` 是合法标识符（`$` 不是词字符，`\b` 会误判成
    // 完整关键字，DuckDB 实测 `SELECT (SUMMARIZE$q$) AS marker, …` 返回普通行）——
    // 前后都必须按 DuckDB 的标识符字符判据检查（Codex 2026-11-08 第六轮 P2）。
    if (isIdentCharAt(bare, m.index)) continue
    if (isIdentAt(bare, m.index + m[0].length)) continue
    const before = bare.slice(0, m.index)
    // 顶层语句头：前面只有空白。
    if (/^\s*$/.test(before)) { recognized = true; continue }
    // 顶层 `FROM (SUMMARIZE …)` / `JOIN (SUMMARIZE …)`（深度 1，且 `(` 顶层直接跟在
    // FROM/JOIN 后）。深度用括号计数 —— bareKeywords 已把字面量/注释/双引号标识符抹空，
    // 剩下的括号都是真括号。更深层的不认：认了会把元数据查询的数字误改
    //（Codex 2026-11-08 第六轮 P2），但必须落在 unrecognizedParen 里由调用方声明缺口。
    const depth = (before.match(/\(/g)?.length ?? 0) - (before.match(/\)/g)?.length ?? 0)
    if (depth === 1 && /(?:\bFROM|\bJOIN)\s*\(\s*$/i.test(before)) { recognized = true; continue }
    if (/\(\s*$/.test(before)) unrecognizedParen = true
  }
  return { recognized, unrecognizedParen }
}

/**
 * `query('…')` 内层 SQL 里出现 SUMMARIZE 关键字（`SELECT * FROM query('SUMMARIZE sessions')`）。
 * ⚠️ 必须先在**裸 token** 上定位 `query(`（注释/字符串/双引号标识符里的同串不算调用），
 * 再回到原 SQL 读那个字符串实参 —— 直接在原文上正则会把注释里写的伪装调用
 * 也当成真调用（Codex 2026-11-08 第三轮 P2 实测）。
 *
 * ⚠️ 第十二轮起 query() 的来源**不再进入行级脱敏**：内层 SQL 的输出来源十余轮复审都被
 * 构造出合法反例（`SELECT 常量 FROM (SUMMARIZE …)` 等），无法静态证明。因此这里只服务
 * 一个目的 —— **发现缺口**（返回 `hit` 即调用方发「无法确认来源」警告），`atTopOutput`
 * 只用于在缺口文案里说清是哪种情形：
 *   · `atTopOutput`：该调用位于最终输出路径（裸文本深度 0 且紧邻 `FROM`/`JOIN`）；
 *   · 非输出路径：`WHERE EXISTS (… FROM query(…))`、IN 子查询、逗号并列、多层子查询。
 * 两种情形都**不改写任何值** —— 实测
 * `SELECT 'userName' AS column_name, 3 AS min WHERE EXISTS (SELECT 1 FROM query('SUMMARIZE sessions'))`
 * 合法且输出 min 是常量 3，按全 SQL 判据脱敏会把业务常量改成 `<已脱敏>`（Codex 第七轮 P2）。
 */
function queryCallSummarize(sql: string): { hit: boolean; atTopOutput: boolean; gap: boolean } {
  const bare = bareKeywords(sql)
  const re = /\bquery\s*\(/gi
  let hit = false
  let atTopOutput = false
  let gap = false
  let m: RegExpExecArray | null
  while ((m = re.exec(bare)) !== null) {
    let i = m.index + m[0].length
    // ⚠️ `(` 与字符串实参之间可以夹空白**与注释**（DuckDB 实测接受
    // `query(/* gap */ 'SUMMARIZE sessions')`），只跳空白会漏检 → PII 统计值原样输出
    //（Codex 2026-11-08 第四轮 P1）。注释按词法跳过，不当作实参。
    for (;;) {
      while (i < sql.length && /\s/.test(sql[i]!)) i++
      if (sql[i] === '/' && sql[i + 1] === '*') {
        // 嵌套块注释按深度跳过（DuckDB 实测 `/* outer /* inner */ … */` 合法）
        i = skipBlockComment(sql, i)
        continue
      }
      if (sql[i] === '-' && sql[i + 1] === '-') {
        while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++
        continue
      }
      break
    }
    // 字符串前缀：DuckDB 接受 `E'…'`（转义字符串）—— 实测 `query(E'SUMMARIZE sessions')` 有效。
    // ⚠️ E 串的**引号边界**也按 E 语义：`\'` 是转义引号（不结束字符串），`''` 同样；
    // 普通串里反斜杠没有特殊含义（实测 `'a\x41b'` 保留字面量 `\x41`）（Codex 第七轮 P2）。
    const isEscape = (sql[i] === 'E' || sql[i] === 'e') && sql[i + 1] === "'"
    if (isEscape) i++
    // ⚠️ 美元引号实参同样合法（真机实测 `query($$SUMMARIZE sessions$$)` /
    // `query($q$SUMMARIZE sessions$q$)` 都输出统计值，CodeRabbit 2026-11-09 第十四轮 minor）：
    // 旧扫描只认单引号，这类实参直接 `continue` → hit/gap 双假 → 一条 SUMMARIZE 缺口都不发。
    // 与 withoutLiterals 共用同一个扫描点 dollarQuoteEnd；内容没有转义，原样就是内层 SQL。
    const dq = sql[i] === '$' && !isIdentCharAt(sql, i) ? dollarQuoteEnd(sql, i) : null
    let inner: string
    if (dq !== null) {
      inner = sql.slice(dq.openEnd, dq.closeStart)
      i = dq.closeStart + (dq.openEnd - i) - 1
    } else {
      if (sql[i] !== "'") continue
      const start = i
      for (i++; i < sql.length; i++) {
        if (isEscape && sql[i] === '\\') { i++; continue }
        if (sql[i] === "'") { if (sql[i + 1] !== "'") break; i++ }
      }
      // ⚠️ 实参是**内层 SQL 源码**，必须按 DuckDB 的字符串语义解码后再跑同一套词法判据：
      // E 串先解转义（`\x2f\x2a` → `/*` —— 不解码会把注释里的 SUMMARIZE 当成真关键字，
      // 实测该查询输出常量 min=3 却被脱敏，Codex 第七轮 P2），再统一把 `''` → `'`。
      // 内层里的 SUMMARIZE 也可能只是注释/字符串/别名：实测 `query('SELECT ''x'' … /* SUMMARIZE */')`
      // 在 DuckDB 里返回普通行，按裸词判会把列值误改（Codex 2026-11-08 第五轮 P2）。
      inner = decodeStringLiteral(sql.slice(start + 1, i), isEscape)
    }
    // ⚠️ 递归必须传播**输出来源**而不是只看「内层含 SUMMARIZE」（Codex 第八轮 P2，真机实测）：
    // 内层 SQL `SELECT 'userName' AS column_name, 3 AS min WHERE EXISTS (SELECT 1 FROM
    // query('SUMMARIZE sessions'))` 的输出是常量 3 —— 内层命中来自 WHERE 里的非输出路径，
    // 按 `.hit` 提升会让外层的 query() 被当成统计来源、常量被改成 `<已脱敏>`。
    // 只有内层**自身的输出**是 SUMMARIZE（内层语句头 / 内层 query() 在其顶层 FROM）才提升。
    const innerTokens = summarizeTokenPositions(inner)
    const sub = queryCallSummarize(inner)
    // ⚠️ innerTokens.recognized 对 `SELECT expr FROM (SUMMARIZE …)` 成立（SUMMARIZE 在
    // 深度 1 的 FROM 内），但 SELECT 自身输出的是**表达式求值结果**、不是 SUMMARIZE 统计值。
    // 例如 `SELECT * FROM query('SELECT ''userName'' AS column_name, 3 AS min FROM
    // (SUMMARIZE (SELECT 1 AS userName))')` 输出 min=3（常量）—— 按统计值脱敏会篡改它
    //（Codex 2026-11-09 第十一轮 P2）。验证：内层 SQL 要么自身就是 SUMMARIZE（语句头），
    // 要么是纯透传 —— 复用唯一判据 passthroughReason（`SELECT *` 单一 SUMMARIZE 来源）。
    const innerIsPure = passthroughReason(inner) === null
    if ((innerTokens.recognized && innerIsPure) || sub.atTopOutput) {
      hit = true
      const before = bare.slice(0, m.index)
      const depth = (before.match(/\(/g)?.length ?? 0) - (before.match(/\)/g)?.length ?? 0)
      if (depth === 0 && /(?:\bFROM|\bJOIN)\s*$/i.test(before)) atTopOutput = true
    } else if ((innerTokens.recognized && !innerIsPure) || innerTokens.unrecognizedParen
      || sub.gap || (sub.hit && !sub.atTopOutput)) {
      // 内层有 SUMMARIZE 痕迹但输出无法确认（深层子查询 / 内层 query() 不在输出路径）——
      // 向上传播「无法确认」，由调用方声明缺口，绝不冒认脱敏。
      gap = true
    }
  }
  return { hit, atTopOutput, gap }
}

/**
 * 把一个字符串字面量的**原始内容**（不含两端引号）解码为它表示的字符序列，即内层 SQL 源码。
 * 真机实测（2026-11-08）DuckDB 的字符串词法：
 *   · `''`（两个引号）**在两种串里都表示一个引号字符** —— 折叠必须与转义解码在**同一次扫描**
 *     里各做一次：若先解 E 转义再全局折叠 `''`，`\x27\x27`（两个引号字符）会被二次折成一个，
 *     内层 SQL 的引号边界失衡 → 把字符串里的 SUMMARIZE 误认成语句（Codex 第八轮 P2）。
 *   · 普通串（无 E 前缀）**不做**转义解码（实测 `'a\x41b'` 保留字面量 `\x41`）。
 *   · E 串转义：`\xHH`（**仅小写 x**，1-2 位十六进制；实测大写 `\X41` → `X41`，走未知转义；
 *     Codex 第八轮 P2）、`\NNN`（1-3 位八进制）、`\n \r \t \b \f`、其余未知转义丢弃反斜杠
 *     保留字符（实测 `\v` → `v`、`\q` → `q`、非法十六进制 `\xzz` → `xzz`）；
 *     `\u`/`\U`/`\0` 在 DuckDB 是 Parser Error，这类 SQL 根本执行不了。
 */
function decodeStringLiteral(raw: string, isEscape: boolean): string {
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]!
    if (ch === "'" && raw[i + 1] === "'") { out += "'"; i++; continue }
    if (!isEscape || ch !== '\\') { out += ch; continue }
    const next = raw[i + 1]
    if (next === undefined) { out += ch; continue }
    if (next === 'x') {
      const hex = /^[0-9A-Fa-f]{1,2}/.exec(raw.slice(i + 2))
      if (hex !== null) { out += String.fromCharCode(parseInt(hex[0], 16)); i += 1 + hex[0].length; continue }
      out += 'x'; i++; continue
    }
    if (next >= '0' && next <= '7') {
      const oct = /^[0-7]{1,3}/.exec(raw.slice(i + 1))!
      out += String.fromCharCode(parseInt(oct[0], 8)); i += oct[0].length; continue
    }
    if (next === 'n') { out += '\n'; i++; continue }
    if (next === 'r') { out += '\r'; i++; continue }
    if (next === 't') { out += '\t'; i++; continue }
    if (next === 'b') { out += '\b'; i++; continue }
    if (next === 'f') { out += '\f'; i++; continue }
    // `\\`、`\'`、`\"`、`\?` 及未知转义（含大写 `\X`）：输出字符本身（丢弃反斜杠）
    out += next; i++
  }
  return out
}

/**
 * 取 `i` 之前的**完整码点**（UTF-16 代理对被 `text[i-1]` 截成孤立低代理项时补齐高代理项）。
 * 美元引号边界判据必须按码点判：补充平面字母（实测 DuckDB 接受 `𝒜$q$`，U+1D49C）由两个
 * UTF-16 单元组成，只看 `text[i-1]` 会拿到孤立低代理项、`\p{L}` 判不出（Codex 2026-11-08
 * 第五轮 P2）。
 */
function prevCodePoint(text: string, i: number): string {
  if (i >= 2) {
    const hi = text.charCodeAt(i - 2)
    const lo = text.charCodeAt(i - 1)
    if (hi >= 0xd800 && hi <= 0xdbff && lo >= 0xdc00 && lo <= 0xdfff) return text.slice(i - 2, i)
  }
  return i > 0 ? text[i - 1]! : ''
}

/** ASCII 空白集合 —— DuckDB 的词法空白只有这几个。⚠️ 不能用 `\s`：JS 的 `\s` 把
 *  U+2028/U+2029 等也算空白，而 DuckDB 实测把它们当**标识符字符**（`1 AS x\u2028$q$`
 *  合法，两个 `$q$` 都被当成标识符的一部分，Codex 2026-11-08 第六轮 P2）。 */
const ASCII_WS = new Set([' ', '\t', '\n', '\r', '\f', '\v'])

/** 单个码点是否 DuckDB 标识符字符（ASCII：字母/数字/`_`/`$`；非 ASCII：一律算，除 ASCII 空白）。 */
function isIdentCp(cp: string): boolean {
  if (cp === '') return false
  if (/^[A-Za-z0-9_$]$/.test(cp)) return true
  const code = cp.codePointAt(0)
  if (code === undefined || code < 0x80) return false
  return !ASCII_WS.has(cp)
}

/**
 * DuckDB 的标识符字符判据（美元引号边界用）：ASCII 字母/数字/`_`/`$`，以及**任何非 ASCII、
 * 非空白**字符 —— DuckDB（utf8proc 词法）把 Unicode 字母/数字/组合符/连接符乃至货币符号
 * 都接受为标识符字符（实测 `¢$q$` U+00A2 合法），补充平面字母按代理对处理（实测 `𝒜$q$`）。
 * ASCII 标点（`=`、`(`、`,`、空白等）不是标识符字符 —— 美元引号合法地跟在它们之后。
 * 方向：把模棱两可的非 ASCII 字符按**标识符**处理（不认成引号开头）—— 误判成字面量会
 * 抹掉后续内容并让分组/缺口分析静默失效，误判成标识符只是少抹一段（该段是非法 SQL）。
 */
export function isIdentCharAt(text: string, i: number): boolean {
  return isIdentCp(prevCodePoint(text, i))
}

/** `text[i]` 处的码点是否标识符字符（next 方向；`codePointAt` 天然按码点处理代理对）。 */
function isIdentAt(text: string, i: number): boolean {
  if (i >= text.length) return false
  return isIdentCp(String.fromCodePoint(text.codePointAt(i)!))
}

/** 嵌套块注释：`/*` 开头可再嵌 `/*`（DuckDB 实测合法），按深度数到配对的 `*`+`/` 才算结束。返回注释结束后的下标。 */
function skipBlockComment(text: string, start: number): number {
  let i = start + 2
  let depth = 1
  while (i < text.length && depth > 0) {
    if (text[i] === '/' && text[i + 1] === '*') { depth++; i += 2; continue }
    if (text[i] === '*' && text[i + 1] === '/') { depth--; i += 2; continue }
    i++
  }
  return Math.min(i, text.length)
}

/**
 * 美元引号字符串（`$$…$$` / `$tag$…$tag$`）的唯一扫描点：`text[start] === '$'`，返回终止定界符
 * 之后的**开区间**下标（内容为 `text[start + 定界符长度, 结束)`），不成对时返回 -1。
 *
 * ⚠️ 两处共用（`withoutLiterals` 抹字面量、`queryCallSummarize` 读 query() 实参）：同一套解码
 * 规则复制到两处会让同一条 SQL 在两个判据里得到不同结论。调用方负责「标识符边界」判断
 * （紧跟在标识符字符后的 `$` 属于标识符，不是引号开头）。
 */
function dollarQuoteEnd(text: string, start: number): { openEnd: number; closeStart: number } | null {
  const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(start))
  if (m === null) return null
  const closeStart = text.indexOf(m[0], start + m[0].length)
  if (closeStart === -1) return null
  return { openEnd: start + m[0].length, closeStart }
}

/**
 * 抹掉单引号/美元引号字面量与 SQL 注释（判据只看标识符，不看字面量/注释里的文本）。
 * 导出给 `commands/query.ts` 的日期字面量警告用（列名判据）。
 */
export function withoutLiterals(text: string): string {
  return blankSql(text, true)
}

/**
 * 只抹注释（双引号标识符与字面量原样保留，下标逐位对齐）。
 * `commands/query.ts` 的日期字面量警告在它上面定位孤立 `'` 再取字面量内容。
 */
export function withoutComments(text: string): string {
  return blankSql(text, false)
}

/**
 * 抹掉单引号/美元引号字面量与注释的唯一词法状态机。`blankLiterals=false` 时
 * **原样保留**字面量（含美元引号内容）——供需要在字面量内部读值的判据用。
 */
function blankSql(text: string, blankLiterals: boolean): string {
  let out = ''
  // ⚠️ 被抹掉的字符一律换成等长空格：下标与原文**逐位对齐**，`sliceClause` 才能在抹过的
  // 文本上定位 `GROUP BY`/`DISTINCT` 而不会命中字符串字面量里的同一串词（Codex 2026-11-05
  // 第三轮 P2：`SELECT userPhone, 'GROUP BY userPhone' AS label …` 曾被误判成分组查询）。
  const blank = (n: number): string => ' '.repeat(n)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "'") {
      // E 串（`E'…'`）：`\'` 是转义引号、不结束字符串（DuckDB 实测
      // `E'it\'s FROM (SUMMARIZE sessions)'` 合法）—— 不按此跳过会把字符串后半段当成
      // 裸 SQL，从中误判出 SUMMARIZE 关键字（Codex 2026-11-08 第九轮 P2）。
      const isEscape = i >= 1 && (text[i - 1] === 'E' || text[i - 1] === 'e')
        && !isIdentCharAt(text, i - 1)
      const start = i
      for (i++; i < text.length; i++) {
        if (isEscape && text[i] === '\\') { i++; continue }
        if (text[i] === "'") { if (text[i + 1] !== "'") break; i++ }
      }
      out += blankLiterals ? blank(i - start + 1) : text.slice(start, Math.min(i, text.length - 1) + 1)
      continue
    }
    // 双引号是**标识符**（`SELECT "userPhone"` 是真实列引用，抹掉会漏判）→ 原样保留，
    // 但必须整段跳过：标识符里可以带 `'`（DuckDB 实测接受 `"it's"`），只抹单引号会让
    // 那个 `'` 被当成字符串起点、把后面的 GROUP BY 一起抹掉 → 分组失真警告静默丢失
    //（2026-11-07 审查）。
    if (ch === '"') {
      const start = i
      for (i++; i < text.length; i++) {
        if (text[i] === '"') { if (text[i + 1] !== '"') break; i++ }
      }
      out += text.slice(start, Math.min(i, text.length - 1) + 1)
      continue
    }
    // 美元引号字符串（`$$…$$` / `$tag$…$tag$`，DuckDB 实测支持）是**字面量** → 抹掉。
    // `$` 在标识符里也合法，形似引号却找不到配对结束符时按普通字符放行。
    // ⚠️ 必须先判**标识符边界**（Codex 2026-11-08 P2 实测）：PostgreSQL/DuckDB 规定
    // 美元引号必须与前一个关键字/标识符用空白分隔 —— 紧跟在标识符字符后的 `$` 属于该
    // 标识符。`SELECT userPhone, 1 AS marker$q$, COUNT(*) AS n FROM … GROUP BY …,
    // marker$q$` 是合法 SQL，不做边界判据会把两个别名里的 `$q$` 当成一对引号，把中间的
    // `GROUP BY` 整段抹掉 → 分组失真警告静默丢失（实测判据双边：去掉 alias 的对照组
    // 警告在场）。字母/数字/下划线/`$` 与本文件其它词边界正则的字符类一致。
    if (ch === '$') {
      // 标识符字符按 DuckDB 的实际规则判定（见 isIdentCharAt）：中文、补充平面字母、
      // 货币符号等都是合法标识符字符（Codex 第三/五轮 P2 实测），紧跟在它们之后的 `$`
      // 属于标识符，不是美元引号开头。
      if (isIdentCharAt(text, i)) { out += ch; continue }
      const dq = dollarQuoteEnd(text, i)
      if (dq !== null) {
        const delim = dq.openEnd - i
        const end = dq.closeStart + delim   // 整个 `$tag$…$tag$` 之后的第一个字符
        out += blankLiterals ? blank(end - i) : text.slice(i, end)
        i = end - 1
        continue
      }
      out += ch
      continue
    }
    if (ch === '-' && text[i + 1] === '-') {
      // 行注释抹到行尾（**不含**换行符）：`\n` 与 `\r` 都算行尾 —— DuckDB 实测
      // `--c\rGROUP BY …` 会按 `\r` 之后的内容分组，只认 `\n` 会把 GROUP BY 一起抹掉。
      while (i < text.length && text[i] !== '\n' && text[i] !== '\r') { out += ' '; i++ }
      if (i < text.length) out += text[i]
      else i--
      continue
    }
    if (ch === '/' && text[i + 1] === '*') {
      // ⚠️ 必须按**嵌套深度**跳过（Codex 2026-11-08 第六轮 P2）：`/* outer /* inner */ … */`
      // 是 DuckDB 实测合法语法，停在第一个 `*/` 会把仍在注释里的内容当成 SQL 记号。
      const end = skipBlockComment(text, i)
      out += blank(end - i)
      i = end - 1
      continue
    }
    out += ch
  }
  return out
}

/** 顶层逗号切分（括号与引号内不算），用于 SELECT 列表与 GROUP BY 的项。 */
function splitTopLevel(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let inSingle = false
  let inDouble = false
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (inSingle) {
      if (ch === "'") { if (text[i + 1] === "'") i++; else inSingle = false }
      continue
    }
    if (inDouble) {
      if (ch === '"') { if (text[i + 1] === '"') i++; else inDouble = false }
      continue
    }
    if (ch === "'") { inSingle = true; continue }
    if (ch === '"') { inDouble = true; continue }
    if (ch === '(') { depth++; continue }
    if (ch === ')') { depth = Math.max(0, depth - 1); continue }
    if (ch === ',' && depth === 0) { out.push(text.slice(start, i)); start = i + 1 }
  }
  out.push(text.slice(start))
  return out
}

/**
 * SELECT 列表里「引用了敏感列的输出项」的别名（用于 `GROUP BY <别名>` 这种写法）。
 *
 * ⚠️ 按**选择项**（顶层逗号切分）而不是整串正则来解析（Codex 2026-11-05 第四轮 P2）：
 * 整串正则只认「列名紧跟别名」，`SELECT lower(userPhone) AS p … GROUP BY p` 这种
 * **表达式别名**会漏报 —— 实测 DuckDB 按 `lower(userPhone)` 分成两组，脱敏后照样塌成一行。
 * 逐项解析也让「别名必须属于该项的结尾」这件事由切分本身保证，不需要再拿子句关键字
 * 做前瞻（`userPhone = 'x'` 这类项不以标识符结尾，自然不产生别名）。
 *
 * 判据：
 *   ① 项形如 `<表达式> [AS] <标识符>`，`<表达式>` 里**引用**敏感列（词边界；字面量已抹掉）；
 *   ② 别名可以是双引号标识符（`AS "p"`，DuckDB 里 `GROUP BY p` 能引用它），去引号后比较；
 *   ③ 聚合项不算（`max(userPhone) AS worst` 是聚合值，DuckDB 也不接受按它分组）。
 */
function aliasesOf(selectList: string, name: string): string[] {
  const out: string[] = []
  const nameRe = new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(name)}(?![A-Za-z0-9_$])`, 'i')
  const aliasRe = /^([\s\S]*\S)\s+(?:AS\s+)?([A-Za-z_][A-Za-z0-9_]*|"[^"]+")\s*$/i
  for (const item of splitTopLevel(withoutLiterals(selectList))) {
    if (isAggregateItem(item)) continue
    const m = aliasRe.exec(item)
    const expr = m?.[1]
    const raw = m?.[2]
    if (expr === undefined || raw === undefined) continue
    if (!nameRe.test(expr)) continue
    const alias = raw.startsWith('"') ? raw.slice(1, -1) : raw
    if (!SQL_KEYWORDS.has(alias.toLowerCase()) && !out.includes(alias)) out.push(alias)
  }
  return out
}

type SummarizeProjection = {
  /** 是否**可证明**是 SUMMARIZE 输出的透传 —— 行级脱敏只在这个白名单里启用。 */
  enabled: boolean
  /** 无法证明来源的具体成因（缺口警告用）。 */
  reason: string
}

/**
 * 分析顶层投影能否**静态证明**是 SUMMARIZE 原始统计输出的透传。
 *
 * ⚠️ 历史（2026-11-08 ~ 11-09 十余轮双路复审的共同结论）：行级脱敏只能靠「输出列名 + 行值」
 * 猜来源，任何 SQL 重写都可能猜错并把**普通值**改成 `<已脱敏>`（数据损坏比漏脱敏更糟）。
 * 每轮复审都能构造出新的合法 SQL 让更精细的猜测失效：`3 AS min`、`3 min` 省略 AS、
 * `'not PII' AS min`、`min: 3` 前置别名、UNION 追加普通行、重排自连接 `:N` 错配、
 * `SELECT *` + CROSS JOIN、`query('SELECT 常量 FROM (SUMMARIZE …)')`、`v.min` 来自 VALUES、
 * `SELECT *, 3 AS min`、三源串联 JOIN、`AS "ON"` 别名、FROM-first 查询、来源列别名列表、
 * `lower(column_name)` 跨表大小写误配 —— 全部真机实测。
 *
 * 因此收窄到**只有两类**可证明形态，其余一律 enabled=false，由调用方声明缺口：
 *   ① 顶层语句本身是 SUMMARIZE（`SUMMARIZE <表>` / `SUMMARIZE SELECT …`）—— 无外层投影；
 *   ② 顶层 `SELECT *`，且 FROM 子句去掉括号内容后**恰好一个**来源 `(SUMMARIZE …) <别名>`：
 *      没有 JOIN / 逗号并列 / ON / 列别名列表 / 集合操作 / FROM-first；
 *      别名只允许裸标识符或双引号标识符（`AS "ON"` 这类词形也不再歧义，因为不做关键字切分）。
 * 连 `query('…')` 包装也不再启用行级脱敏：内层 SQL 的可分析性是另一套递归词法，
 * 每轮都被找出反例；这类查询输出**原值 + 缺口警告**，用户可改用 `query --table`
 *（内层也复用本判据 passthroughReason，但只用来区分「纯透传 / 不可证明」两档缺口文案）。
 * 残余边界：②里的 `SUMMARIZE` 子查询自身若带 `(SELECT … AS min …)` 入参（如
 * `SUMMARIZE SELECT 3 AS min FROM …`），输出仍是统计结果，不受影响 —— 入参不改变
 * 输出列语义。
 */
/** 不可证明时的统一成因（外层缺口文案与内层缺口判定共用同一句）。 */
const UNPROVABLE = '投影或 FROM 来源无法静态证明是单一 SUMMARIZE 输出'

/**
 * 一段 SQL 能**静态证明**输出是 SUMMARIZE 统计结果的唯一判据（外层投影与 query() 内层共用
 * —— 判据只许一个实现点，否则内外层迟早漂移）。可证明时返回 null，否则返回成因文本。
 * 形态见下方 analyzeSummarizeProjection 的文档。
 */
function passthroughReason(sql: string): string | null {
  const bare = withoutLiterals(sql)
  // ① 语句头就是 SUMMARIZE —— 输出即统计结果。
  if (/^\s*SUMMARIZE\b/i.test(bare)) return null
  // 集合操作：非 SUMMARIZE 分支会被混进来 → 不认。
  if (execTopLevel(bare, /\b(?:UNION|INTERSECT|EXCEPT)\b/i) !== null) {
    return '含 UNION/INTERSECT/EXCEPT（后续分支不是 SUMMARIZE 输出）'
  }
  // ② 必须是 `SELECT *`（或 `SELECT <限定>.*`），且只允许这一个投影项。
  // FROM-first 查询（`FROM (SUMMARIZE …) t`）：选择列表隐式、来源组合不可见 → 不认。
  const selectM = /^\s*(?:SELECT|FROM)\b/i.exec(bare)
  if (selectM === null || /^\s*FROM\b/i.test(selectM[0])) return UNPROVABLE
  const selectClause = sliceClause(bare, /^\s*SELECT\s+(?:ALL\s+)?/i, 'FROM\\b')
  const items = splitTopLevel(selectClause).map((t) => t.trim()).filter((t) => t !== '')
  if (items.length !== 1 || !/^(?:(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)\s*\.\s*)?\*$/.test(items[0]!)) {
    // 显式列举 / `*, expr` 混合 / 表达式。
    return UNPROVABLE
  }
  const fromClause = sliceClause(bare, /\bFROM\b/i,
    'WHERE\\b|GROUP\\s+BY|ORDER\\s+BY|LIMIT|HAVING|QUALIFY|WINDOW|UNION|EXCEPT|INTERSECT').trim()
  // 单一来源：`(SUMMARIZE …)` 后只跟裸别名或双引号别名；ON/USING/JOIN/逗号/列别名列表都不允许。
  // ⚠️ 用**平衡括号扫描**取出来源块（不按关键字切分 —— `AS "ON"`、`(SELECT … JOIN …)`
  // 等内容全在括号里，与关键字无关），再看剩余文本是否只是别名。
  if (!fromClause.startsWith('(')) return UNPROVABLE
  let depth = 0
  let close = -1
  for (let i = 0; i < fromClause.length; i++) {
    const ch = fromClause[i]!
    if (ch === '(') depth++
    else if (ch === ')') { depth--; if (depth === 0) { close = i; break } }
  }
  if (close === -1) return UNPROVABLE
  if (!/^\s*SUMMARIZE\b/i.test(fromClause.slice(1, close))) return UNPROVABLE
  const rest = fromClause.slice(close + 1).trim()
  // 允许：空 / 裸别名 / `AS 别名`；别名本身是裸标识符或双引号标识符；不得有 `(列列表)`
  if (rest !== '' && !/^(?:AS\s+)?(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)$/i.test(rest)) return UNPROVABLE
  return null
}

function analyzeSummarizeProjection(mode: MaskInput['mode'], shapeColumns: boolean): SummarizeProjection {
  if (mode.kind !== 'sql' || !shapeColumns) return { enabled: false, reason: '' }
  const reason = passthroughReason(mode.sql)
  return reason === null ? { enabled: true, reason: '' } : { enabled: false, reason }
}

/**
 * 对一次查询的输出行脱敏（spec §7.2）。纯函数：输入行不被就地改写；
 * `noMask` 时直接返回入参数组（不拷贝，因为一个字节都不会改）。
 */
export function maskQueryRows(input: MaskInput): MaskOutcome {
  const { rows, columns, mode, noMask, loc } = input

  // --no-mask：脱敏整体关闭，缺口警告随之失去意义（没有「脱敏不完整」，只有「没脱敏」）。
  // ⚠️ 但**形态类**警告与脱敏开关无关，必须保留（契约审查 C-06）：
  // `--table --no-mask` 时 `TABLES` 之外的列仍未被脱敏、仍应点名——README 明说
  // 「表定义之外的列不做脱敏但会警告」，这条是数据完整性提示，不是「脱敏不完整」提示。
  if (noMask) {
    if (mode.kind === 'table') {
      const declared = new Set(mode.table.columns.map((c) => c.name))
      const undeclared = columns.filter((n) => n !== 'count' && !declared.has(n))
      return {
        rows,
        maskedColumns: [],
        warnings: [
          NO_MASK_WARNING,
          ...(undeclared.length > 0
            ? [`输出含表定义之外的列 ${undeclared.join('、')}（可能来自旧版 CLI 或库损坏）：`
              + '这些列不在 `TABLES` 元数据中，本次也未做脱敏（--no-mask）']
            : []),
        ],
      }
    }
    return { rows, maskedColumns: [], warnings: [NO_MASK_WARNING] }
  }

  if (mode.kind === 'table') {
    // --table 通道：精确。只认 TableDef 的 sensitive 标记；不在 TableDef.columns 的
    // 额外输出列（正常不会出现）不脱敏，但**不得静默**（审查 Minor 1）——`SELECT *` 会把
    // 库里多出来的列（旧版 CLI 残留、外部工具写入）原样带出，其中可能有 PII 列，
    // 而 `db describe` 对同一漂移会警告（README「声明与实况的差异不得静默」）。
    // 只看 TableDef 认不出该列是不是 PII，所以只能给警告、不能脱敏——如实说。
    // `count` 是 --group-by 的聚合别名（不在 TableDef.columns），不算漂移列。
    const declared = new Set(mode.table.columns.map((c) => c.name))
    const undeclared = columns.filter((n) => n !== 'count' && !declared.has(n))
    const driftWarnings = undeclared.length > 0
      ? [`输出含表定义之外的列 ${undeclared.join('、')}（可能来自旧版 CLI 或库损坏）：`
        + '这些列不在 `TABLES` 元数据中，未做脱敏。要核对请用 `'
        + dbDescribeCommand(mode.table.name, loc) + '`']
      : []
    const sensitive = new Set(
      mode.table.columns.filter((c) => c.sensitive).map((c) => c.name))
    const hit = columns.filter((name) => sensitive.has(name))
    // maskedColumns 只收「至少有一行的值在脱敏前后不同」的列（spec line 217：
    // 实际脱敏，Agent 据此判断输出是否被改写）。全 null / 全空串 / 行内缺键的列不算
    //（空串走 maskValue 的「原样返回」分支，不是被改写成 `<已脱敏>`）。
    const changed = new Set<string>()
    const outRows = rows.map((row) => {
      const out = { ...row }
      for (const name of hit) {
        // 行里缺这个键就不凭空造一个（输出列与行键正常一致，防御性跳过）
        if (!(name in out)) continue
        const before = out[name]
        // ⚠️ 非字符串值整值替换（安全审查 Minor，2026-10-20）：与 --sql 通道的 S1 规则一致。
        // 类型漂移（外部工具把 userPhone 改成 BIGINT/JSON）时 maskValue 对非字符串原样返回，
        // 数字形态的手机号会整值漏出且 masked_columns 为空。
        out[name] = before !== null && before !== undefined && typeof before !== 'string'
          ? FULL
          : maskValue(before, ruleForColumn(name))
        if (out[name] !== before) changed.add(name)
      }
      return out
    })
    return { rows: outRows, maskedColumns: hit.filter((n) => changed.has(n)), warnings: driftWarnings }
  }

  // --sql 通道：列名级（主防线）+ 值级兜底（别名绕过）。
  // 精确大小写匹配：输出列名 = 表定义大小写（探针 12），故 `staff.username`（全小写）
  // 不会命中 `sessions.userName`（驼峰）——这是「精确」而非「忽略大小写」的理由。
  const sensitiveNames = sqlSensitiveNames(mode.tables)
  // ⚠️ DuckDB 把重名输出列去重成 `userName:1`、`userName:2`（security S2，Critical：
  // 自连接 `SELECT a.userName, b.userName FROM sessions a JOIN sessions b …` 即可触发）。
  // 精确匹配会放过改名后的第 2 列 → 原始 PII 静默漏出（列名级与值级两条防线都够不着，
  // 因为姓名/地址无法值级检测）。故匹配用「去掉 `:数字` 后缀的基名」。
  const baseName = (n: string): string => n.replace(/:\d+$/, '')
  // ⚠️ 大小写敏感（与下方 SQL 文本匹配的规则**不同**，两边各有理由）：
  // 输出列名 = 表定义大小写（DuckDB 保留声明大小写，实测探针 12），所以列名级用精确比较
  // 就是对的；反而是 SQL 文本的匹配必须宽松（用户写 `username` 也与 `userName` 同列）。
  // 若把这里也放宽，`staff.username`（非敏感列）的输出列会被当成 sensitive 整列改写。
  const nameHit = new Set(
    columns.filter((name) => sensitiveNames.includes(baseName(name))))
  // 供缺口警告用：哪些敏感列名**真的**匹配到了输出列（含 `:N` 改名后的）。
  const matchedSensitive = new Set(
    columns.map(baseName).filter((n) => sensitiveNames.includes(n)))
  // 实际改写追踪（两条分支共用）：maskedColumns 只收「至少有一行的值在脱敏前后不同」的列。
  const changed = new Set<string>()
  // 整行/STRUCT/LIST 命中的列：那是「整值替换」而不是「按值形态误判业务数字」，
  // 不进下面的误伤提示（场景审查 7.2 只针对字符串形态命中）。
  /**
   * 值级兜底真正改写过的列（形态命中或 JSON 整段）——「值形态误伤」告警的唯一依据。
   * ⚠️ 只有**字符串**被改写才记账：对象/数组（STRUCT/LIST 整行）走 S1 整值替换，
   * 那是安全动作而非「值形态误判业务数字」，不该触发误伤警告（Codex 2026-11-08 P2）。
   */
  const valueFormMasked = new Set<string>()
  /** SUMMARIZE 行规则改写过统计单元格的列（有意的按列脱敏，不单独构成误伤告警）。 */
  const summarizeMasked = new Set<string>()
  // ⚠️ SUMMARIZE 形态（**严重**，2026-11-07 审查实测）：`SUMMARIZE sessions` 的输出列是
  // 通用的 `column_name / min / max / q25 / …`，真正的列名在**行值**里 —— 三条列名级启发式
  // （输出列名、SQL 文本、payload）全部落空，`userName` / `userAddress` 的 min/max **原值
  // 静默输出**，且 `mask_warnings` 为空（实测：`min:"张三丰"`、`max:"李四光"`）。
  // 这是「声明敏感但可从一条只读语句拿到明文」的完整绕过，必须在行级补一道判据。
  //   · 形状判据：**SQL 词法上的 SUMMARIZE 关键字**（不是字符串/注释里的同名词）+ 输出含
  //     `column_name` 且含 `min`/`max`。⚠️ 只看列名不够（Codex 2026-11-08 P2 实测）：
  //     `SELECT column_name, MIN(ordinal_position) AS min FROM information_schema.columns
  //     GROUP BY column_name` 输出同样的 `column_name/min`，min 是列位置数字而非客户数据，
  //     只按列名判会把 `min: 3` 误改成 `<已脱敏>`。
  //     ⚠️ 关键字判据必须作用在**剥除字面量与注释后**的文本上（Codex 2026-11-08 第二轮 P2
  //     实测）：`SELECT 'SUMMARIZE' AS marker, column_name, MIN(ordinal_position) AS min …`
  //     的字符串字面量里出现同名词，按原始 SQL 判会把这条合法元数据查询误判成 SUMMARIZE。
  //     `withoutLiterals` 把单引号串/美元引号串/注释抹成空格、双引号标识符原样保留 —— 正好
  //     是「词法上下文」判据。
  //   · 嵌套形态 `query('SUMMARIZE …')` 的关键字在**字符串里**（query() 的实参），
  //     withoutLiterals 会把它抹掉 —— 单独判：裸 SQL 里出现 `query('…SUMMARIZE…')` 即视为
  //     内层 SQL 为 SUMMARIZE（内层执行本来就是 nestedSql 警告声明的「无法分析」缺口方向，
  //     这里是对已知形态的补强）。残余边界：`query('SUMM' || 'ARIZE …')` 动态拼串取不到。
  //   · 命中判据：该行 `column_name` 的**基名**精确匹配敏感列清单（与列名级同一口径）；
  //   · 动作：命中行的统计列按该列规则脱敏。
  const summarizeTokens = mode.kind === 'sql'
    ? summarizeTokenPositions(mode.sql)
    : { recognized: false, unrecognizedParen: false }
  const queryCall = mode.kind === 'sql'
    ? queryCallSummarize(mode.sql)
    : { hit: false, atTopOutput: false, gap: false }
  const summarizeSql = mode.kind === 'sql'
    && (summarizeTokens.recognized || queryCall.atTopOutput)
  // 第十二轮起 query() 来源不再进入行级脱敏入口（无法静态证明输出是统计值），
  // 其信号只用于发缺口警告：
  //   · hit：内层**纯透传**（语句头/`SELECT *` 单一来源）—— 输出可能原样含统计值；
  //   · gap：内层含 SUMMARIZE 但投影是重投影 / 位置不可识别 —— 输出是否含统计值未知；
  //   · hit 且非输出路径（WHERE EXISTS / IN / 逗号并列）—— 输出不是统计值，只声明缺口。
  const summarizeUnconfirmed = summarizeTokens.unrecognizedParen
    || queryCall.hit
    || queryCall.gap
  const summarizeShapeColumns = columns.includes('column_name')
    && (columns.includes('min') || columns.includes('max'))
  const summarizeShape = summarizeSql && summarizeShapeColumns
  // avg/std 只对数值列出现：`SUMMARIZE SELECT userPhone::DOUBLE AS userPhone` 的均值/标准差
  // 同样是 PII 派生值，一并整值替换。count 是行数、approx_unique 是去重计数，单看它们
  // 恢复不出任何一个原值，不在此列。
  const SUMMARIZE_STATS = ['min', 'max', 'avg', 'std', 'q25', 'q50', 'q75'] as const
  const summarizeProj = analyzeSummarizeProjection(mode, summarizeSql && summarizeShapeColumns)
  const outRows = rows.map((row) => {
    const out = { ...row }
    for (const name of columns) {
      if (!(name in out)) continue
      const before = out[name]
      if (nameHit.has(name)) {
        // ⚠️ 列名命中不等于值可安全转换（CodeRabbit 终审 major）：`SELECT t AS userName
        // FROM sessions t` 把整行 STRUCT 别名成敏感列名 → 走 nameHit 分支 → `maskValue`
        // 对非字符串原样返回 → 全量 PII 漏出，且 matchedSensitive 含该名使缺口警告也不触发。
        // 与 maskCellByValue 的 S1 规则同一处理：**任何非字符串值整值替换**。
        // ⚠️ 覆盖面必须是「所有非字符串」而不只是对象/数组（CodeRabbit 复审）：
        // `SELECT userPhone::DOUBLE AS userPhone FROM sessions` 返回数字 13800138000，
        // maskValue 同样原样返回 —— 数字形态的手机号一样是 PII。schema 里 PII 列都是
        // VARCHAR，故真实列不会走到这里；能走到的是**用户显式 cast 成非字符串**，
        // 那种情形宁可整值替换（误杀无害，漏出有害）。
        out[name] = before !== null && before !== undefined && typeof before !== 'string'
          ? FULL
          : maskValue(before, ruleForColumn(baseName(name)))
      } else {
        out[name] = maskCellByValue(before)
        if (out[name] !== before && typeof before === 'string') {
          // 字符串被值级兜底改写（手机号/邮箱/IPv4 形态或 JSON 整段）：这是「值形态误伤」
          // 告警的依据，按列记账。与 `changed` 的区别：`changed` 还包含有意脱敏
          // （列名级 / SUMMARIZE 行规则 / 对象整值替换），那些不该触发误伤告警。
          valueFormMasked.add(name)
        }
      }
      if (out[name] !== before) changed.add(name)
    }
    // ⚠️ 行级脱敏**只在可静态证明**是 SUMMARIZE 原始统计输出时启用（第十二轮收窄，判据见
    // analyzeSummarizeProjection）：其余形态（表达式重投影、显式列举、集合操作、多来源、
    // query() 包装等）按列名+行值猜来源会把**普通值**改成 `<已脱敏>` —— 数据损坏比漏脱敏
    // 更糟，统一降级为缺口警告。
    // ⚠️ 后缀（`:N`）不处理：可证明形态里 SUMMARIZE 输出列名唯一，不会出现 `:N`；
    // 一旦出现说明输出被其他来源污染（与白名单结论矛盾）—— 而已证明形态下不会发生。
    if (summarizeShape && summarizeProj.enabled) for (const nameCol of columns) {
      if (nameCol !== 'column_name') continue
      if (typeof out[nameCol] !== 'string') continue
      // 行值匹配**大小写敏感**（第十二轮收窄）：可证明形态里 column_name 是原样输出，
      // 无需大小写折叠；否则非敏感的 `staff.username` 会误匹配 sessions.userName
      //（Codex 第九/十二轮 P2）。
      const rawCol = baseName(out[nameCol] as string)
      const col = sensitiveNames.includes(rawCol) ? rawCol : undefined
      if (col !== undefined) {
        for (const key of SUMMARIZE_STATS) {
          if (!(key in row)) continue
          const before = row[key]
          if (before === null || before === undefined) continue
          // ⚠️ 值级兜底的**整值替换必须保留**（Codex 2026-11-08 P1 实测）：`out[stat]` 若已被
          // `maskCellByValue` 判成 FULL（JSON 含 PII 叶子 / 畸形 JSON / STRUCT），这里再用列规则
          // 重算会把 `<已脱敏>` 降级 —— 紧凑 JSON（`{"userEmail":"a@x.com","secret":"z"}` 无空白、
          // 恰含一个 `@`）会整串命中邮箱正则，变成 `{***@x.com","secret":"z"}`，`@` 之后的内容
          // 重新可见。规则：已是 FULL → 保持；否则按该列规则脱敏（非字符串与列名级同一条 S1 规则）。
          // 强度关系：能过 EMAIL/PHONE/IPV4 正则的值，值级判出的规则就是列规则本身，两者逐字相等；
          // 值级是 FULL 而列规则给出弱形态的唯一路径就是上面这种 JSON 整串误配 —— 故 FULL 优先。
          out[key] = out[key] === FULL || typeof before !== 'string'
            ? FULL
            : maskValue(before, ruleForColumn(col))
          if (out[key] !== before) {
            changed.add(key)
            summarizeMasked.add(key)
            // ⚠️ 不写 `structuralMasked`（Codex 2026-11-08 P2 实测）：它是一个**列级**集合，
            // 任一敏感行把它塞进去，后面「值形态误伤」的判据就会跳过该列的全部单元格 ——
            // 混合结果里非敏感行（如 session_id 的 min 恰好是手机号形态）被值级兜底改写时
            // 的告警会一起消失。这里是**有意**脱敏，按 SUMMARIZE 来源单独记账。
          }
        }
      }
    }
    return out
  })

  // 缺口警告：SQL 文本按词边界命中敏感列名（除 payload），但该名不在输出列名中。
  // 典型：SELECT userPhone AS p、concat(userName,'x') AS n（spec §7.2「缺口声明」）。
  // ⚠️ 这是警告不是防护：姓名/地址无法值级检测，别名场景仍会漏。
  // ⚠️ 大小写敏感是刻意的：加 `i` 会让 `SELECT username FROM staff` 误报 `userName`
  //（staff.username 不是敏感列），要消除需真正解析 SQL 标识符，超出本纯函数的职责。
  const warnings: string[] = []

  // payload 缺口（审查 I-1）：payload 刻意不做列名级（文件头取舍），只靠值级 JSON 检测。
  // 但值级只认手机号/邮箱/IPv4 —— 会话/工单 payload 里的姓名、地址（无格式）会**整段原样**
  // 输出，且 `masked_columns` 非空（手机号命中）→ Agent 看到 `masked: true` 会误以为
  // payload 已脱敏。README/CHANGELOG 承诺「两条通道都默认脱敏」，不点破就是承诺了不存在的保护。
  //
  // ⚠️ 只在 SQL 点名了「payload 标 sensitive 的表」时警告（与既有缺口警告同一启发式：
  // 看 SQL 文本，不看语义）。报表表的 payload 是聚合数字 JSON，标了 sensitive 的只有
  // sessions / tickets / ticket_logs —— 对 `SELECT payload FROM daily_overview` 警告
  // 是噪音，会让 Agent 学会忽略 mask_warnings。
  // ⚠️ 不对 payload 脱敏本身（报表 payload 是聚合数字，整值替换会误杀）——只声明缺口。
  // （noMask 已在函数入口提前返回；payload 不在 sensitiveNames，故无需再查 nameHit。）
  //
  // ⚠️ 只看「输出列名里有 payload」会漏掉别名与函数包装（复审 I-1 残留）：
  // `SELECT payload AS p FROM sessions`、`json_extract(payload,'$.userName') AS n`
  // 的输出列名都不叫 payload，PII 照样整段漏出。所以判据是「输出列名含 payload
  // **或** SQL 文本出现 payload 标识符（词边界）」。报表表不在此列（payload 未标
  // sensitive），故 `SELECT payload FROM daily_overview` 不会吃警告。
  // ⚠️ 还有第三类形态（复审定点验证记录）：整行序列化 `SELECT row_to_json(t) FROM sessions t`
  // ——SQL 里既无 payload 记号、输出列名也是函数表达式，但**值**就是整行 JSON。
  // 判据补「脱敏**前**的原始行里存在 JSON 对象/数组字面量值」（脱敏会把命中的整段换成
  // 标记、不再可解析，故必须看入参 rows）。聚合数字列（COUNT 等）不会命中。
  // ⚠️ 这是启发式（与既有缺口警告同源）：字符串字面量里出现 payload 也会误报——方向安全
  //（多警告），且真正解析 SQL 标识符超出本纯函数的职责。
  const payloadPiiTables = mode.tables
    .filter((t) => t.columns.some((c) => c.name === 'payload' && c.sensitive))
    .map((t) => t.name)
    .filter((name) => new RegExp(`\\b${name}\\b`, 'i').test(mode.sql))
  const hasJsonBlob = rows.some((row) => columns.some((name) => {
    const v = row[name]
    // security S1：STRUCT/LIST 是 JS 对象/数组，不是字符串 —— 也必须算「整行 JSON」，
    // 否则 `SELECT t FROM sessions t` 脱敏后仍按「值已改写」放行、不再发缺口警告。
    if (Array.isArray(v)) return true
    if (v !== null && typeof v === 'object') return true
    if (typeof v !== 'string') return false
    const t = v.trim()
    if (!t.startsWith('{') && !t.startsWith('[')) return false
    try {
      const parsed: unknown = JSON.parse(t)
      return typeof parsed === 'object' && parsed !== null
    } catch { return false }
  }))
  // ⚠️ 这一段（payload 引用）作用在**原始** SQL 上：`row_to_json(t)->>'payload'`、
  // `json_extract(payload, '$.x')` 这类构造里字典键/列名只以字面量出现。
  const payloadReferenced = columns.includes('payload') || /\bpayload\b/i.test(mode.sql)
  // ⚠️ 第四类绕过（安全审查 Major，2026-10-20 实测）：`query()` 表函数把内层 SQL 当作
  // **字符串**执行，外层文本与输出列名都看不到内层标识符——
  //   `SELECT * FROM query('SELECT userName AS n, userAddress AS a FROM sessions')`
  // 实测输出列 `n`/`a`，SQL 文本不含 userName/userAddress/payload → 三条启发式全落空，
  // 姓名/地址静默原样输出且 `mask_warnings: []`。这类「SQL 嵌套执行」的构造无法可靠
  // 分析，只能声明缺口（不拒绝：query() 本身在沙箱内、仍是只读 SELECT）。
  // 判据取 `query(` / `query_table(` 词边界；`COLUMNS(...) AS` 也降级为同一警告。
  const nestedSql = /\bquery_table\s*\(|\bquery\s*\(/i.test(mode.sql)
    || /\bCOLUMNS\s*\(/i.test(mode.sql)
  if (nestedSql) {
    warnings.push(
      'SQL 使用了 query()/query_table()/COLUMNS() 这类**在其内部再执行 SQL 或批量重命名**的构造：'
      + '内层引用的敏感列无法被列名级识别，姓名/地址等无格式 PII 可能未经脱敏。'
      + '需要可靠脱敏请把内层查询单独执行，或改用 `' + queryTableCommand('<表>', loc) + '`')
  }
  if ((payloadReferenced || hasJsonBlob) && payloadPiiTables.length > 0) {
    warnings.push(
      `引用了 payload 或整行 JSON（含 PII 的表 ${payloadPiiTables.join('、')}）：`
      + '本通道只对 payload 做值级检测（手机号/邮箱/IPv4），其中的姓名/地址等无格式 PII 可能未脱敏'
      + '（别名、JSON 提取、整行序列化都绕得过列名级）。要整值替换请用 `'
      + queryTableCommand('<表>', loc) + '`')
  }

  // 分组 / 去重会把不同原值压成同一个脱敏值（场景审查 7.3，2026-10-20 实测）：
  // `SELECT userPhone, COUNT(*) … GROUP BY userPhone` 对 3 个不同手机号输出 3 行同一个
  // `138****1111`、每行 count=1 —— Agent 会读成「只有 1 个手机号」或「数据坏了」，而
  // 输出里没有任何提示。`--table --group-by` 直接拒绝敏感列正是为了这个，`--sql` 只能声明。
  //
  // ⚠️ 触发条件不能只看 `matchedSensitive`（= 输出列名命中）：`SELECT userPhone AS p,
  // COUNT(*) … GROUP BY p` 的输出列叫 `p`，脱敏走的仍是列名级（列名 `p` 不敏感 →
  // 实际走值级，手机号照常被打码），但 `p` 不在 matchedSensitive 里，于是**分组失真
  // 一条警告都没有**（2026-11-05 审查实测）。
  //
  // ⚠️ 但也不能按「SQL 里出现过敏感列」判（Codex 2026-11-05 P2 实测）：
  // `SELECT session_type, COUNT(*) … WHERE userPhone = '…' GROUP BY session_type` 里
  // 敏感列只用于**过滤**，脱敏不会改变分组键或计数 —— 按整条 SQL 判会谎报「分组失真」，
  // 而这条警告建议 `--no-mask`，等于诱导用户白关脱敏。判据只看**分组键本身**：
  //   ① `GROUP BY` 的项里按词边界出现敏感列名（`GROUP BY userPhone`）；
  //   ② `GROUP BY <别名>`，而该别名是 SELECT 列表里某个敏感列的别名（`userPhone AS p`）；
  //   ③ `GROUP BY <序号>`（`GROUP BY 1`）指向的 SELECT 项引用了敏感列；
  //   ④ `SELECT DISTINCT` 的选择列表（`DISTINCT ON (…)` 只取括号内的列）里出现敏感列。
  // ⚠️ `matchedSensitive`（输出列名命中）本身**不再**算作分组证据：`SELECT max(userPhone)
  // AS userPhone … GROUP BY session_type` 的分组键不含敏感列，输出列名却命中 —— 那是聚合
  // 而非分组，打码不会改变计数。分组列是否敏感由上面的分组键判据决定。
  // 都是词边界 + 大小写不敏感（DuckDB 标识符不分大小写）。
  //
  // ⚠️ 再加一个条件「**可见**」（Codex 2026-11-05 第二轮 P2 实测）：脱敏只会把**输出里**
  // 被投影的分组值压平，计数不变。`SELECT COUNT(*) FROM sessions GROUP BY userPhone`
  // 只输出计数，分组键根本没投影 —— 两张不同手机号各计 1 条，脱敏前后输出完全一样，
  // 报「分组失真」并建议 --no-mask 是纯粹的误报（实测该 SQL 返回 `n=1, n=1`）。
  // 所以分组键命中后还要看它有没有作为**非聚合**选择项被投影出来
  // （`SELECT userPhone, COUNT(*) … GROUP BY userPhone`、`SELECT userPhone AS p … GROUP BY p`
  // 都是可见的；`SELECT max(userPhone) AS userPhone … GROUP BY ALL` 里那一项是聚合值，不可见）。
  //
  // ⚠️ 字面量与注释先抹掉（Codex 第二轮 P3 实测）：`GROUP BY 'userPhone'` 是按**常量**分组
  //（实测一行 `n=2`），字面量里写着列名不该算命中。双引号是标识符，不抹。
  //
  // ⚠️ 引用判定作用在**原始** SQL 上（含字面量）：`struct_extract(t, 'userName')`、
  // `row_to_json(t)->>'userName'` 里列名**只**以字符串字面量出现，而姓名/地址没有值级
  // 检测 —— 抹掉字面量会让这类查询静默零警告（CodeRabbit PR #68 第三轮 major 实测）。
  // 方向按 spec §十五.4：缺口警告宁多勿少（`WHERE session_type = 'userPhone'` 会多报一条，
  // 这是可接受的代价）。
  const referencedSensitive = sensitiveNames
    .filter((n) => new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(n)}(?![A-Za-z0-9_$])`, 'i').test(mode.sql))
  const referencesSensitive = referencedSensitive.length > 0
  // SUMMARIZE 的残余缺口（2026-11-07 审查）：行级判据只认 `column_name` **恰好**是敏感列名；
  // `SUMMARIZE SELECT userName AS n …` 的 column_name 是 `n`，脱敏不命中。与 query()/
  // COLUMNS() 同属「无法可靠分析」，按既有口径**声明缺口而不拒绝**（只读、不越权）。
  // ⚠️ 触发条件用 `summarizeMasked`（SUMMARIZE 行级判据**真命中过**）而非 `changed.size > 0`
  //（Codex 2026-11-08 P2 实测）：changed 含值级兜底的改写 —— `SUMMARIZE sessions` 里只有
  // 非敏感列 min 恰为手机号形态时，本警告会凭空声称「已按 column_name 精确匹配脱敏」，而
  // 实际一条 SUMMARIZE 规则都没跑。范围收敛到「本判据确实改写过单元格」。
  if (summarizeMasked.size > 0) {
    warnings.push(
      'SUMMARIZE 的统计值（min/max/分位数）可能来自敏感列：本次已按输出里的 column_name '
      + '精确匹配脱敏；**别名/表达式列**（如 `SUMMARIZE SELECT userName AS n …`）不在其列。'
      + '要可靠覆盖请用 `' + queryTableCommand('<表>', loc) + '` 取指定列')
  }
  // ⚠️ SQL 含 SUMMARIZE 但**输出列名被改写**（`SELECT column_name AS c, min AS m, max AS x
  // FROM (SUMMARIZE sessions)`，CodeRabbit 2026-11-08 第六轮实测）：形状判据不匹配 → 行级
  // 脱敏不触发，而 SQL 文本又不含敏感列名、其余缺口警告也不发 —— PII 统计值原样输出且
  // mask_warnings 为空。按本文件对 query()/COLUMNS() 的同一策略：**声明缺口，绝不静默**。
  // ⚠️ 位置无法确认的嵌套形态同样要覆盖（CodeRabbit 2026-11-09 第十三轮 major，真机实测
  // 两种写法都输出明文 c/m/x 且 warnings=[]）：
  //   · `SELECT * FROM (SELECT column_name AS c, min AS m, max AS x FROM (SUMMARIZE sessions))`
  //   · `WITH t AS (SELECT column_name AS c, min AS m FROM (SUMMARIZE sessions)) SELECT * FROM t`
  // 但**不能**只按 `unrecognizedParen` 放宽：可证明透传的 SQL 里若别处还有无法识别位置的
  // SUMMARIZE（如 `SELECT * FROM (SUMMARIZE sessions), (SUMMARIZE staff) t`，真机实测合法、
  // 输出 12 + 12 列），`unrecognizedParen` 也会置真，而输出是标准统计形状 —— 那类只走
  // 「无法确认是否构成最终输出」泛化档，不该被说成「列名已被改写」。
  // 判据：位置无法确认（非 summarizeSql）**且**输出不是可静态证明的透传 —— 后者在进入本档时
  // 形状必然不匹配（可证明形态恒为 column_name/min/max），只作显式兜底、如实记录未单独承重。
  if (!summarizeShape && (summarizeSql || (summarizeUnconfirmed && !summarizeProj.enabled))) {
    warnings.push(
      'SQL 含 SUMMARIZE，但输出列名已被改写（缺 column_name / min / max 形状）：'
      + '行级脱敏无法按行值识别敏感列，统计值（min/max/分位数）可能**未脱敏**。'
      + '要可靠覆盖请用 `' + queryTableCommand('<表>', loc) + '` 取指定列')
  }
  // ⚠️ 投影无法**静态证明**是 SUMMARIZE 原始统计输出 → 只声明缺口、不改写任何值。
  // 第十二轮收窄后只剩两类可证明形态（见 analyzeSummarizeProjection），其余全部走这里：
  // 表达式重投影（`3 AS min`、`COUNT(*) AS min`、省略 AS、字符串常量）、显式列举、
  // 集合操作（UNION 追加普通行）、`*` + 多来源、FROM-first、来源列别名列表、`query()` 包装等。
  // 具体成因由 `reason` 给出（单一出处，判据与文案同源）。
  if (summarizeShape && !summarizeProj.enabled) {
    const reason = summarizeProj.reason
    warnings.push(
      'SQL 的 SUMMARIZE 输出投影**无法确认来源**：' + reason + '。'
      + '本次只声明缺口、未按 SUMMARIZE 改写任何值 —— 统计值可能**未脱敏**，'
      + '这些行也可能根本不是统计结果。'
      + '要可靠覆盖请用 `' + queryTableCommand('<表>', loc) + '` 取指定列，'
      + '或改用 `SELECT * FROM (SUMMARIZE <表>)` 原样透传')
  }
  // ⚠️ SQL 里的 SUMMARIZE 位置**无法确认是最终输出**但输出是 SUMMARIZE 形状
  //（CodeRabbit 2026-11-08 第七轮 major + Codex 第七轮 P2，均真机实测）：
  //   · `SELECT * FROM (SELECT * FROM (SUMMARIZE sessions))` 合法，输出 column_name/min/max，
  //     userName 的 min/max 是明文 —— 行级判据不生效、其余警告也不发；
  //   · `SELECT 'userName' AS column_name, 3 AS min WHERE EXISTS (SELECT 1 FROM query('SUMMARIZE sessions'))`
  //     也合法，但输出 min 是**常量 3** —— 按全 SQL 判据脱敏会把业务常量篡改成 `<已脱敏>`；
  //   · `SELECT * FROM query('SELECT column_name, min FROM (SUMMARIZE sessions)')` 内层是重投影，
  //     输出仍可能是统计值 —— 第十二轮收窄时曾被这一档漏掉，现由 queryCall.gap 兜住，
  //     并有**单独一档文案**（下一条），因为它的成因与修复建议都与位置类不同。
  // 两向都不安全：漏脱敏与误改。与上一档同一策略：**只声明缺口，不冒认脱敏**。
  if (!summarizeSql && summarizeUnconfirmed && !queryCall.gap && summarizeShapeColumns) {
    warnings.push(
      'SQL 里的 SUMMARIZE **无法确认是否构成最终输出**（如多层子查询 '
      + '`FROM (SELECT * FROM (SUMMARIZE …))`、逗号连接、CTE 内的子查询，'
      + '或 query() 只出现在 WHERE/EXISTS/IN 子查询里）：'
      + '输出可能仍是 SUMMARIZE 形状，但无法确认统计值是否未脱敏 —— '
      + '行级脱敏未生效，统计值（min/max/分位数）可能**未脱敏**；若这些行不是 SUMMARIZE 结果则保持原值。'
      + '要可靠覆盖请用 `' + queryTableCommand('<表>', loc) + '` 取指定列，'
      + '或把 SUMMARIZE 提到顶层（`SUMMARIZE <表>`）')
  }
  if (!summarizeSql && queryCall.gap && summarizeShapeColumns) {
    warnings.push(
      'SQL 在 `query()` 内层使用了 SUMMARIZE，但内层投影**不是原样透传**'
      + '（显式列举 / 表达式重投影 / 位置不可识别）：'
      + '统计值（min/max/分位数）可能**未脱敏**；若内层输出被改写成常量则保持原值。'
      + '要可靠覆盖请用 `' + queryTableCommand('<表>', loc) + '` 取指定列，'
      + '或改用 `SELECT * FROM (SUMMARIZE <表>)` 原样透传')
  }
  // 边界用「前后不是标识符字符」而不是 `\\b`：别名可以带标点（`"p("`），
  // 而 `\\b` 只在词字符与非词字符之间成立 —— `\\bp(\\b` 即使不抛也永远匹配不上
  // `GROUP BY "p("` 里的 `p(`。转义 + lookaround 两个方向都对（CodeRabbit 第六轮 minor）。
  const wordHit = (text: string, names: readonly string[]): boolean => {
    const plain = withoutLiterals(text)
    return names.some((n) => new RegExp(
      `(?<![A-Za-z0-9_$])${escapeRe(n)}(?![A-Za-z0-9_$])`, 'i').test(plain))
  }
  const groupedSensitive = new Set<string>()
  // ⚠️ `DISTINCT` 后面是 `\s*` 不是 `\s+`（CodeRabbit PR #68 第十四轮 minor）：
  // DuckDB 接受 `SELECT DISTINCT(userPhone) FROM sessions`（实测去重生效，3 行 → 2 行），
  // 要求空白会把 `DISTINCT(userPhone)` 整个当成一个选择项留在列表里。
  // 如实记录：这一处**不单独承重** —— 把下面 distinct 检测正则修好后，前缀剥不剥都
  // 会报警（`projectedPlain` 里照样含列名），变异实测用例仍绿。保留是因为它让选择项的
  // 文本语义正确，但不算进变异数。
  const selectList = withoutLiterals(sliceClause(
    mode.sql, /^\s*SELECT\s+(?:ALL\s+|DISTINCT\b\s*(?:ON\s*\([^)]*\)\s*)?)?/i, 'FROM\\b'))
  const selectItems = splitTopLevel(selectList)
  const projected = selectItems.filter((it) => it.trim() !== '' && !isAggregateItem(it))
  const projectedPlain = projected.join(',')
  // ⚠️ 选择列表解析不了（`WITH … SELECT`、前导注释、`SELECT *` / `t.*`）时无法判断「哪一列被
  // 投影出来」—— 退回输出列名命中（matchedSensitive），保住旧行为里的警告
  //（`SELECT DISTINCT * FROM sessions` 实测会输出全部敏感列；CodeRabbit PR #68 第三轮 minor）。
  // 解析得出来时不退回：`SELECT max(userPhone) AS userPhone … GROUP BY ALL` 的列名命中
  // 是聚合值，不该当成可见分组键（Codex 第二轮 P2）。
  const selectUnparsed = selectList.trim() === ''
    || selectItems.some((it) => /\*\s*$/.test(it.trim()))
  /** 分组键是否**被投影出来**（可见）：按列名、其别名或裸表达式出现于非聚合选择项。 */
  const visible = (n: string): boolean =>
    wordHit(projectedPlain, [n]) || aliasesOf(selectList, n).some((a) => wordHit(projectedPlain, [a]))
    || (selectUnparsed && matchedSensitive.has(n))
  const groupByClause = sliceClause(mode.sql, /\bGROUP\s+BY\b/i)
  if (groupByClause !== '') {
    let keys = splitTopLevel(groupByClause)
    // 字面量先抹掉（`GROUP BY 'x'` 是按常量分组，不是列 —— Codex 第二轮 P3 实测），
    // 抹完的键只含标识符，再参与列名匹配。
    const plainKeys = keys.map((k) => withoutLiterals(k))
    // `GROUP BY ALL`（DuckDB）= 按**全部非聚合选择项**分组 —— 选择项里出现敏感列就是分组键
    //（聚合项如 `max(userPhone) AS userPhone` 不是分组键，见上面的聚合判定）。
    const groupByAll = plainKeys.length === 1 && /^\s*ALL\s*$/i.test(plainKeys[0]!)
    for (const n of sensitiveNames) {
      if (!visible(n)) continue
      // `GROUP BY ALL` + `SELECT *`：选择项是星号，projectedPlain 里没有列名 —— 退回输出列名命中
      //（`SELECT * … GROUP BY ALL` 实测输出全部敏感列并按它们分组，Codex 第三轮 P2）。
      const viaKey = plainKeys.some((k) => wordHit(k, [n]))
        || (groupByAll && (wordHit(projectedPlain, [n]) || (selectUnparsed && matchedSensitive.has(n))))
      const viaAlias = aliasesOf(selectList, n).some((a) => plainKeys.some((k) => wordHit(k, [a])))
      const viaOrdinal = plainKeys.some((k) => {
        const t = k.trim()
        if (!/^\d+$/.test(t)) return false
        const target = selectItems[Number(t) - 1]
        return target !== undefined && !isAggregateItem(target) && wordHit(target, [n])
      })
      if (viaKey || viaAlias || viaOrdinal) groupedSensitive.add(n)
    }
  }
  // 判据作用在抹掉字面量/注释但等长的文本上：`SELECT userPhone, 'SELECT DISTINCT' AS label` 不是
  // DISTINCT 查询（Codex 第三轮 P2）。切片偏移与原 SQL 逐位对齐。
  const sqlBlank = withoutLiterals(mode.sql)
  // 只在顶层找 DISTINCT：`… WHERE x IN (SELECT DISTINCT x …)` 的去重发生在子查询、且去重的是
  // 该子查询的原值行，脱敏不过多合并行；误把它当外层 DISTINCT 会对外层投影列误报（第四轮）。
  // `DISTINCT\b\s*`：`DISTINCT(userPhone)` 这种无空格写法同样算一次去重
  const distinct = execTopLevel(sqlBlank, /\bSELECT\s+(?:ALL\s+)?DISTINCT\b\s*(ON\s*\()?/i)
  if (distinct !== null) {
    // `DISTINCT ON (a, b) …` 的分组键是括号里的列；普通 `DISTINCT` 是整张选择列表
    //（DISTINCT 的选择项本身就是可见分组键；聚合项不会出现在 DISTINCT 列表里，但仍排除）。
    // 括号配对走抹过字面量的 `sqlBlank`：字面量里的 `(`/`)` 不参与配对（等长，偏移对齐）。
    const list = distinct[1] === undefined
      ? projectedPlain
      : (() => {
          const open = distinct.index + distinct[0].length
          let depth = 1
          for (let i = open; i < sqlBlank.length; i++) {
            if (sqlBlank[i] === '(') depth++
            else if (sqlBlank[i] === ')') { depth--; if (depth === 0) return sqlBlank.slice(open, i) }
          }
          return sqlBlank.slice(open)
        })()
    for (const n of sensitiveNames) {
      if (!visible(n)) continue
      // 选择列表是 `*` / 解析不了时，`DISTINCT` 去重的就是**整行输出**（含全部敏感列）——
      // 按 matchedSensitive 报，方向宁多勿少（CodeRabbit PR #68 第三轮 minor）。
      if (selectUnparsed && matchedSensitive.has(n)) { groupedSensitive.add(n); continue }
      if (wordHit(list, [n]) || aliasesOf(selectList, n).some((a) => wordHit(list, [a]))) {
        groupedSensitive.add(n)
      }
    }
  }
  if (groupedSensitive.size > 0) {
    warnings.push(
      `SQL 对脱敏列做了 GROUP BY / DISTINCT（${[...groupedSensitive].join('、')}）：`
      + '不同原值会映射成同一个脱敏值，分组结果与计数可能失真。'
      + '需要准确分组请用 `--no-mask`（并自行承担 PII 风险），或改用不敏感列分组')
  }

  // 先收集**全部**该报的列，再按上限逐条发：最后一条替成「另有 N 个未列出」的清单。
  // ⚠️ 只在循环里 `break` 会让被截掉的列**静默消失**（2026-11-09 审计实测：7 个未匹配
  // 敏感列只出 5 条，没有「等/其余」字样，Agent 读到的 5 条看起来就是全部缺口）。
  const unmatched: string[] = []
  for (const name of sensitiveNames) {
    if (matchedSensitive.has(name)) continue
    // `\b` 两侧都要求非标识符字符：userPhoneBook 这类更长标识符不会误报 userPhone。
    //
    // ⚠️ **必须大小写不敏感**（CodeRabbit 终审 major，spec §十五.4「误报方向必须是
    // 多警告而非少警告」）：DuckDB 标识符不分大小写 —— 实测 `SELECT username FROM
    // sessions` 输出列名是 `userName`（值已列名级脱敏），但 `SELECT username AS n` 输出
    // 列名是 `n`，列名级够不着、值级无法检测姓名 → 大小写敏感时**零警告静默漏出**。
    // 代价是 `SELECT username FROM staff`（staff.username 不是敏感列）会多一条误报 ——
    // spec 明确要求这个方向。
    if (!new RegExp(`\\b${name}\\b`, 'i').test(mode.sql)) continue
    unmatched.push(name)
  }
  const warnOne = (name: string): string =>
    `SQL 引用了敏感列 ${name}，但输出列名不匹配；脱敏可能不完整，`
    + '建议用 `' + queryTableCommand('<表>', loc) + '` 或保持列名原样'
  const slots = Math.max(0, WARNING_LIMIT - warnings.length)
  const perColumnSlots = unmatched.length > slots ? Math.max(0, slots - 1) : unmatched.length
  for (const name of unmatched.slice(0, perColumnSlots)) warnings.push(warnOne(name))
  if (unmatched.length > perColumnSlots) {
    // 剩余列并成一条：既不超上限的「逐列」口径，又点名全部被截断的列。
    const rest = unmatched.slice(perColumnSlots)
    warnings.push(`另有 ${rest.length} 个敏感列的缺口警告未列出（受 ${WARNING_LIMIT} 条上限）：`
      + `${rest.join('、')}；这些列的脱敏同样可能不完整`)
  }

  // 值级兜底命中了**非敏感列**（场景审查 7.2）：11 位、以 1 开头的订单号/聚合值会被
  // 当成手机号打码，而 `--table` 通道对同一列返回原值。规则本身不能放宽（放宽就漏 PII），
  // 但必须告诉 Agent「这一列不是声明上的 PII，是形态命中，值可能被误改」。
  //
  // ⚠️ 只在 SQL **完全没有引用任何敏感列**时提示：`SELECT userPhone AS p` 的 p 也是
  // 「非敏感列名」，但它显然来自敏感列，上面已有缺口警告，再报一条就是噪音。
  // payload 同理（它有自己的缺口警告，且刻意不在 sensitiveNames 里）。
  const falsePositive = referencesSensitive
    ? []
    : [...valueFormMasked].filter((n) =>
      n !== 'payload' && !sensitiveNames.includes(baseName(n)))
  if (falsePositive.length > 0) {
    warnings.push(
      `列 ${falsePositive.join('、')} 不在敏感列清单里，是按**值形态**（手机号/邮箱/IPv4）`
      + '命中的脱敏：若它其实是订单号、聚合值等业务数字，输出值已被改写。'
      + '这类列可用 `' + queryTableCommand('<表>', loc) + '` 取得原始值（该通道按列声明脱敏）')
  }

  const maskedColumns = columns.filter((n) => changed.has(n))
  return { rows: outRows, maskedColumns, warnings }
}
