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
  return AGGREGATE_CALL.test(withoutLiterals(item))
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
 * 标识符全剥）上，要求前面是文首、`(` 或 `;`。
 */
function isSummarizeStatement(sql: string): boolean {
  return /(?:^|[(;])\s*SUMMARIZE\b/i.test(bareKeywords(sql))
}

/**
 * `query('…')` 内层 SQL 里出现 SUMMARIZE 关键字（`SELECT * FROM query('SUMMARIZE sessions')`）。
 * ⚠️ 必须先在**裸 token** 上定位 `query(`（注释/字符串/双引号标识符里的同串不算调用），
 * 再回到原 SQL 读那个字符串实参 —— 直接在原文上正则会把注释里写的伪装调用
 * 也当成真调用（Codex 2026-11-08 第三轮 P2 实测）。
 */
function queryCallSummarize(sql: string): boolean {
  const bare = bareKeywords(sql)
  const re = /\bquery\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(bare)) !== null) {
    let i = m.index + m[0].length
    // ⚠️ `(` 与字符串实参之间可以夹空白**与注释**（DuckDB 实测接受
    // `query(/* gap */ 'SUMMARIZE sessions')`），只跳空白会漏检 → PII 统计值原样输出
    //（Codex 2026-11-08 第四轮 P1）。注释按词法跳过，不当作实参。
    for (;;) {
      while (i < sql.length && /\s/.test(sql[i]!)) i++
      if (sql[i] === '/' && sql[i + 1] === '*') {
        const close = sql.indexOf('*/', i + 2)
        i = close === -1 ? sql.length : close + 2
        continue
      }
      if (sql[i] === '-' && sql[i + 1] === '-') {
        while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++
        continue
      }
      break
    }
    // 字符串前缀：DuckDB 接受 `E'…'`（转义字符串）—— 实测 `query(E'SUMMARIZE sessions')` 有效。
    if ((sql[i] === 'E' || sql[i] === 'e') && sql[i + 1] === "'") i++
    if (sql[i] !== "'") continue
    const start = i
    for (i++; i < sql.length; i++) {
      if (sql[i] === "'") { if (sql[i + 1] !== "'") break; i++ }
    }
    // ⚠️ 实参是**内层 SQL 源码**，必须解码（'' → '）后再跑同一套词法判据 —— 内层里的
    // SUMMARIZE 也可能只是注释/字符串/别名：实测 `query('SELECT ''x'' … /* SUMMARIZE */')`
    // 在 DuckDB 里返回普通行，按裸词判会把列值误改（Codex 2026-11-08 第五轮 P2）。
    const inner = sql.slice(start + 1, i).replace(/''/g, "'")
    if (isSummarizeStatement(inner) || queryCallSummarize(inner)) return true
  }
  return false
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

/**
 * DuckDB 的标识符字符判据（美元引号边界用）：ASCII 字母/数字/`_`/`$`，以及**任何非 ASCII、
 * 非空白**字符 —— DuckDB（utf8proc 词法）把 Unicode 字母/数字/组合符/连接符乃至货币符号
 * 都接受为标识符字符（实测 `¢$q$` U+00A2 合法），补充平面字母按代理对处理（实测 `𝒜$q$`）。
 * ASCII 标点（`=`、`(`、`,`、空白等）不是标识符字符 —— 美元引号合法地跟在它们之后。
 * 方向：把模棱两可的非 ASCII 字符按**标识符**处理（不认成引号开头）—— 误判成字面量会
 * 抹掉后续内容并让分组/缺口分析静默失效，误判成标识符只是少抹一段（该段是非法 SQL）。
 */
function isIdentCharAt(text: string, i: number): boolean {
  const cp = prevCodePoint(text, i)
  if (cp === '') return false
  if (/^[A-Za-z0-9_$]$/.test(cp)) return true
  const code = cp.codePointAt(0)
  if (code === undefined || code < 0x80) return false
  return !/\s/u.test(cp)
}

function withoutLiterals(text: string): string {
  let out = ''
  // ⚠️ 被抹掉的字符一律换成等长空格：下标与原文**逐位对齐**，`sliceClause` 才能在抹过的
  // 文本上定位 `GROUP BY`/`DISTINCT` 而不会命中字符串字面量里的同一串词（Codex 2026-11-05
  // 第三轮 P2：`SELECT userPhone, 'GROUP BY userPhone' AS label …` 曾被误判成分组查询）。
  const blank = (n: number): string => ' '.repeat(n)
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (ch === "'") {
      const start = i
      for (i++; i < text.length; i++) {
        if (text[i] === "'") { if (text[i + 1] !== "'") break; i++ }
      }
      out += blank(i - start + 1)
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
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))
      if (m !== null) {
        const end = text.indexOf(m[0], i + m[0].length)
        if (end !== -1) {
          out += blank(end + m[0].length - i)
          i = end + m[0].length - 1
          continue
        }
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
      const start = i
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
      i++   // 越过 `/`
      out += blank(Math.min(i, text.length - 1) - start + 1)
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
  const summarizeShape = mode.kind === 'sql'
    && (isSummarizeStatement(mode.sql) || queryCallSummarize(mode.sql))
    && columns.includes('column_name')
    && (columns.includes('min') || columns.includes('max'))
  // avg/std 只对数值列出现：`SUMMARIZE SELECT userPhone::DOUBLE AS userPhone` 的均值/标准差
  // 同样是 PII 派生值，一并整值替换。count 是行数、approx_unique 是去重计数，单看它们
  // 恢复不出任何一个原值，不在此列。
  const SUMMARIZE_STATS = ['min', 'max', 'avg', 'std', 'q25', 'q50', 'q75'] as const
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
    if (summarizeShape && typeof out.column_name === 'string') {
      const col = baseName(out.column_name)
      if (sensitiveNames.includes(col)) {
        for (const stat of SUMMARIZE_STATS) {
          if (!(stat in row)) continue
          const before = row[stat]
          if (before === null || before === undefined) continue
          // ⚠️ 值级兜底的**整值替换必须保留**（Codex 2026-11-08 P1 实测）：`out[stat]` 若已被
          // `maskCellByValue` 判成 FULL（JSON 含 PII 叶子 / 畸形 JSON / STRUCT），这里再用列规则
          // 重算会把 `<已脱敏>` 降级 —— 紧凑 JSON（`{"userEmail":"a@x.com","secret":"z"}` 无空白、
          // 恰含一个 `@`）会整串命中邮箱正则，变成 `{***@x.com","secret":"z"}`，`@` 之后的内容
          // 重新可见。规则：已是 FULL → 保持；否则按该列规则脱敏（非字符串与列名级同一条 S1 规则）。
          // 强度关系：能过 EMAIL/PHONE/IPV4 正则的值，值级判出的规则就是列规则本身，两者逐字相等；
          // 值级是 FULL 而列规则给出弱形态的唯一路径就是上面这种 JSON 整串误配 —— 故 FULL 优先。
          out[stat] = out[stat] === FULL || typeof before !== 'string'
            ? FULL
            : maskValue(before, ruleForColumn(col))
          if (out[stat] !== before) {
            changed.add(stat)
            summarizeMasked.add(stat)
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

  for (const name of sensitiveNames) {
    if (warnings.length >= WARNING_LIMIT) break
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
    warnings.push(
      `SQL 引用了敏感列 ${name}，但输出列名不匹配；脱敏可能不完整，` +
      '建议用 `' + queryTableCommand('<表>', loc) + '` 或保持列名原样')
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
