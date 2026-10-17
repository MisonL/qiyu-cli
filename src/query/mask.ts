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

export type MaskRule = 'phone' | 'email' | 'ip' | 'full'

export interface MaskOutcome {
  rows: Record<string, unknown>[]
  /**
   * 本次**实际脱敏**的列名（spec line 217：至少有一行的值在脱敏前后不同），按输出列序。
   * 全 null / 行内缺键 / 非字符串值（原样返回）的列不出现 —— Agent 据此判断输出是否被改写。
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
  const { rows, columns, mode, noMask } = input

  // --no-mask：脱敏整体关闭，缺口警告也随之失去意义（没有「脱敏不完整」，只有「没脱敏」），
  // 只保留一条 PII 风险警告（spec §7.2）。
  if (noMask) return { rows, maskedColumns: [], warnings: [NO_MASK_WARNING] }

  if (mode.kind === 'table') {
    // --table 通道：精确。只认 TableDef 的 sensitive 标记；不在 TableDef.columns 的
    // 额外输出列（正常不会出现）不脱敏也不报错（spec §7.2 第一条）。
    const sensitive = new Set(
      mode.table.columns.filter((c) => c.sensitive).map((c) => c.name))
    const hit = columns.filter((name) => sensitive.has(name))
    // maskedColumns 只收「至少有一行的值在脱敏前后不同」的列（spec line 217：
    // 实际脱敏，Agent 据此判断输出是否被改写）。全 null / 行内缺键的列不算。
    const changed = new Set<string>()
    const outRows = rows.map((row) => {
      const out = { ...row }
      for (const name of hit) {
        // 行里缺这个键就不凭空造一个（输出列与行键正常一致，防御性跳过）
        if (!(name in out)) continue
        const before = out[name]
        out[name] = maskValue(before, ruleForColumn(name))
        if (out[name] !== before) changed.add(name)
      }
      return out
    })
    return { rows: outRows, maskedColumns: hit.filter((n) => changed.has(n)), warnings: [] }
  }

  // --sql 通道：列名级（主防线）+ 值级兜底（别名绕过）。
  // 精确大小写匹配：输出列名 = 表定义大小写（探针 12），故 `staff.username`（全小写）
  // 不会命中 `sessions.userName`（驼峰）——这是「精确」而非「忽略大小写」的理由。
  const sensitiveNames = sqlSensitiveNames(mode.tables)
  const nameHit = new Set(columns.filter((name) => sensitiveNames.includes(name)))
  // 实际改写追踪（两条分支共用）：maskedColumns 只收「至少有一行的值在脱敏前后不同」的列。
  const changed = new Set<string>()

  const outRows = rows.map((row) => {
    const out = { ...row }
    for (const name of columns) {
      if (!(name in out)) continue
      const before = out[name]
      if (nameHit.has(name)) {
        out[name] = maskValue(before, ruleForColumn(name))
      } else {
        out[name] = maskCellByValue(before)
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
  for (const name of sensitiveNames) {
    if (warnings.length >= WARNING_LIMIT) break
    if (nameHit.has(name)) continue
    // `\b` 两侧都要求非标识符字符：userPhoneBook 这类更长标识符不会误报 userPhone。
    if (!new RegExp(`\\b${name}\\b`).test(mode.sql)) continue
    warnings.push(
      `SQL 引用了敏感列 ${name}，但输出列名不匹配；脱敏可能不完整，` +
      '建议用 `qiyu query --table` 或保持列名原样')
  }

  const maskedColumns = columns.filter((n) => changed.has(n))
  return { rows: outRows, maskedColumns, warnings }
}
