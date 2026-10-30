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
  const structuralMasked = new Set<string>()
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
        if (out[name] !== before && (Array.isArray(before) || (before !== null && typeof before === 'object'))) {
          structuralMasked.add(name)
        }
      }
      if (out[name] !== before) changed.add(name)
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

  // 分组 / 去重会把不同原值压成同一个脱敏值（场景审查 7.3，2026-10-20 实测）：
  // `SELECT userPhone, COUNT(*) … GROUP BY userPhone` 对 3 个不同手机号输出 3 行同一个
  // `138****1111`、每行 count=1 —— Agent 会读成「只有 1 个手机号」或「数据坏了」，而
  // 输出里没有任何提示。`--table --group-by` 直接拒绝敏感列正是为了这个，`--sql` 只能声明。
  const grouped = /\bGROUP\s+BY\b|\bDISTINCT\b/i.test(mode.sql)
  if (grouped && matchedSensitive.size > 0) {
    warnings.push(
      `SQL 对脱敏列做了 GROUP BY / DISTINCT（${[...matchedSensitive].join('、')}）：`
      + '不同原值会映射成同一个脱敏值，分组结果与计数可能失真。'
      + '需要准确分组请用 `--no-mask`（并自行承担 PII 风险），或改用不敏感列分组')
  }

  // 值级兜底命中了**非敏感列**（场景审查 7.2）：11 位、以 1 开头的订单号/聚合值会被
  // 当成手机号打码，而 `--table` 通道对同一列返回原值。规则本身不能放宽（放宽就漏 PII），
  // 但必须告诉 Agent「这一列不是声明上的 PII，是形态命中，值可能被误改」。
  //
  // ⚠️ 只在 SQL **完全没有引用任何敏感列**时提示：`SELECT userPhone AS p` 的 p 也是
  // 「非敏感列名」，但它显然来自敏感列，上面已有缺口警告，再报一条就是噪音。
  // payload 同理（它有自己的缺口警告，且刻意不在 sensitiveNames 里）。
  const referencesSensitive = sensitiveNames.some((n) => new RegExp(`\\b${n}\\b`, 'i').test(mode.sql))
  const falsePositive = referencesSensitive
    ? []
    : [...changed].filter((n) =>
      n !== 'payload' && !structuralMasked.has(n) && !sensitiveNames.includes(baseName(n)))
  if (falsePositive.length > 0) {
    warnings.push(
      `列 ${falsePositive.join('、')} 不在敏感列清单里，是按**值形态**（手机号/邮箱/IPv4）`
      + '命中的脱敏：若它其实是订单号、聚合值等业务数字，输出值已被改写。'
      + '这类列可用 `' + queryTableCommand('<表>', loc) + '` 取得原始值（该通道按列声明脱敏）')
  }

  const maskedColumns = columns.filter((n) => changed.has(n))
  return { rows: outRows, maskedColumns, warnings }
}
