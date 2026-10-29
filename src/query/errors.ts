// src/query/errors.ts
// DuckDB 原生错误 → 中文 QueryFailure（spec §十一 分派表）—— 查询层唯一的错误翻译出口。
//
// 分工（plan Task 3/5 裁决）：
//   · `query/sandbox.ts` 只抛**已分类**的错误（带 kind，部分带 code/hint/retryable）；
//   · 本文件负责把**执行期原生错误**（无 kind 的英文原文）细化成中文 + 表/列候选；
//   · 命令层统一走 `thrownToQueryExit`，不自己拼 fail/usageFail。
//
// 三条硬规则：
//   1. **已带 kind 的错误原样透传** —— 不重新分类。sandbox 的 usage/sandbox_blocked/
//      query_timeout/store_locked 都是有意分好的，这里再猜一次只会把语义改坏。
//      唯一例外（裁决 R9）：sandbox 把原生错误挂在 `cause` 上时，kind/code 仍以 sandbox
//      为准，但「表/列不存在」的中文消息与候选从 cause 原文补算（见 classifyDuckDbError ①）。
//   2. **不裸透英文**：所有 message 以中文开头，原生原文放在括号/冒号后（spec §十一）。
//   3. **候选不硬凑**：DuckDB 自己的 `Did you mean "x"` 可能是系统表噪音（探针 15：
//      未知表时给出 `pg_constraint`）；以 `TABLES` 计算出的候选为先，原生候选只补位。
//
// ⚠️ 分层约束（spec §5.1）：不 import `sync/`、`commands/`。`output.ts` 是 CLI 输出层
// （信封与退出码），不是命令层，可以 import。
import { fail, sanitizeMessage, stripSqlEcho, storeInitCommand, syncRunCommand } from '../output.js'
import type { TableDef } from '../store/schema.js'

export interface QueryFailure {
  code: string
  kind: string
  retryable: boolean
  message: string
  hint?: string
}

/** 候选上限（spec §十一 / brief）：超过即截断并加「等」。 */
const CANDIDATE_LIMIT = 5
/** 编辑距离上限：只接受「打错一两个字符」的输入，再远就不是同一个名字了。 */
const MAX_DISTANCE = 2

/** 已分类错误的可选字段（sandbox.ts 的 SandboxError 形态）。 */
interface ClassifiedError {
  message: string
  kind: string
  code?: string
  hint?: string
  retryable?: boolean
  /** 原生错误原文（sandbox 在 prepare 期包装时挂上，裁决 R9）。 */
  cause?: unknown
}

function asClassified(e: unknown): ClassifiedError | null {
  if (typeof e !== 'object' || e === null) return null
  const o = e as Record<string, unknown>
  if (typeof o.kind !== 'string' || o.kind === '') return null
  return {
    message: typeof o.message === 'string' ? o.message : String(e),
    kind: o.kind,
    code: typeof o.code === 'string' ? o.code : undefined,
    hint: typeof o.hint === 'string' ? o.hint : undefined,
    retryable: typeof o.retryable === 'boolean' ? o.retryable : undefined,
    cause: o.cause,
  }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

/** Levenshtein 编辑距离（两行滚动数组；名字都很短，无需优化）。 */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const cur = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[b.length]
}

/**
 * 从候选名字里挑出与输入相关的（spec §十一「无候选时从 TABLES 计算」）。
 *
 * 排序规则：前缀匹配优先（`sess` → `sessions`），其次编辑距离 ≤ 2（`sessons` → `sessions`）。
 * 大小写不敏感比较（DuckDB 标识符大小写不敏感，探针 15），返回**定义时的大小写**。
 * 完全不相干的输入返回空数组 —— 不硬凑候选比给一堆噪音更有用。
 */
export function suggestNames(input: string, names: readonly string[], max = CANDIDATE_LIMIT): string[] {
  const needle = input.toLowerCase()
  if (needle === '' || max <= 0) return []
  const scored: Array<{ name: string; rank: number; distance: number }> = []
  const seen = new Set<string>()
  for (const name of names) {
    const lower = name.toLowerCase()
    if (seen.has(lower)) continue // 名字池里重复（列名跨表重名）
    seen.add(lower)
    const distance = levenshtein(needle, lower)
    // 仅大小写不同的精确同名（edge F6）：`SESSIONS` → `sessions`。此前 `lower === needle`
    // 直接 continue 把「只差大小写」的正确答案排除了，Agent 反而拿不到候选；而 DuckDB
    // 标识符大小写不敏感（同一写法在 --sql 通道能跑通），必须把该名字本身作为候选。
    if (lower === needle) {
      if (name !== input) scored.push({ name, rank: -1, distance: 0 })
      continue
    }
    const isPrefix = lower.startsWith(needle) || needle.startsWith(lower)
    if (isPrefix) scored.push({ name, rank: 0, distance })
    else if (distance <= MAX_DISTANCE) scored.push({ name, rank: 1, distance })
  }
  // 同 rank 内距离近者优先；再按名字排序保证输出稳定（不依赖 TABLES 的定义顺序）。
  scored.sort((x, y) => x.rank - y.rank || x.distance - y.distance || x.name.localeCompare(y.name))
  return scored.slice(0, max).map((s) => s.name)
}

/**
 * 原生候选：`Did you mean "x"?`、`Candidate bindings: "a", "b"` 或
 * `Candidate tables: "t"`（探针 15 + 审查实测）。
 * ⚠️ 容忍双冒号变体 `Candidate bindings: : "payload"`（DuckDB 1.5.6-r.1 实测）。
 */
function nativeCandidates(msg: string): string[] {
  const didYouMean = /Did you mean "([^"]+)"/.exec(msg)
  if (didYouMean) return [didYouMean[1]]
  const bindings = /Candidate (?:bindings|tables):\s*:?\s*((?:"[^"]+"(?:,\s*)?)+)/.exec(msg)
  if (bindings) return [...bindings[1].matchAll(/"([^"]+)"/g)].map((m) => m[1])
  return []
}

/**
 * 候选合并：`suggestNames` 的结果在前（来自 TABLES，是用户真正可能想要的），
 * 原生候选只补位 —— 原生候选可能是系统表（`pg_constraint`），不能无条件排第一。
 *
 * ⚠️ 原生候选必须**再过一次相关性闸门**（正确性 P2）：DuckDB 的 binder 会给出与自己
 * 无关的候选（实测删掉 `robot_summary` 后 → `候选：staff_group_members`），照单全收会
 * 把 Agent 推向另一张表、且与 `TABLES` 无关。`suggestNames` 用的同一阈值（前缀或距离 ≤2）
 * 在这里同样适用 —— 不硬凑（spec §十一）。过滤后为空则退回「用 db tables 查看」。
 */
function mergeCandidates(primary: string[], native: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const n of [...primary, ...native]) {
    // 大小写不敏感去重：DuckDB 标识符大小写不敏感，`Sessions` 与 `sessions` 是同一个名字。
    const key = n.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(n)
  }
  return out
}

/** 「候选：a、b、c」（超过上限截断并加「等」，spec §十一）。 */
function candidateHint(candidates: string[]): string {
  const shown = candidates.slice(0, CANDIDATE_LIMIT)
  const suffix = candidates.length > CANDIDATE_LIMIT ? '等' : ''
  return `候选：${shown.join('、')}${suffix}`
}

// —— 表/列不存在的四种原生形态（探针 15 + 审查实测，1.5.6-r.1）——
// ① `Catalog Error: Table with name sessons does not exist!`
// ② `Binder Error: Referenced table "sessons" not found!`（限定名 `sessons.paylod`）
// ③ `Binder Error: Table "sessions" does not have a column named "paylod"`
// ④ `Binder Error: Referenced column "paylod" was not found because the FROM clause is missing`
// 四条都锚定错误类别前缀（`Binder Error:` / `Catalog Error:`）——不能省（审查 Minor 20）：
// DuckDB 的错误消息会**回显 SQL 原文**（`LINE 1: …`），Parser Error 的报错里若恰好含
// `Referenced column "x" not found` 字样，无锚的正则会把「语法错」误判成「列不存在」。
// 实测：`SELECT 1 WHERE x = Referenced column "zzz" not found` → 原文是 Parser Error。
const TABLE_NAME_RE = /Catalog Error: Table with name ([^\s]+) does not exist/
const TABLE_REF_RE = /Binder Error: Referenced table "([^"]+)" not found/
const COLUMN_NAMED_RE = /Binder Error: Table "[^"]+" does not have a column named "([^"]+)"/
const COLUMN_NAME_RE = /Binder Error: Referenced column "([^"]+)" (?:was )?not found/

/**
 * 「声明有而库中无」的成因与对策（**唯一实现**：db tables 的 warning、db describe 的
 * warning、query --table 与 stats fields 的 hint 四个出口共用——同一事实四处拷贝必然漂移，
 * 而 `db describe` 曾经独立写成「未同步或未建库」，两个成因都到不了该分支）。
 *
 * ⚠️ 成因口径经实测收窄（2026-10-29），「未同步」「未建库」两条都到不了这里：
 * · 「未同步」不产生缺表：`store init` 的迁移一次建全部声明表，从未同步的库 25 张声明表
 *   全在（row_count=0，无缺表警告）；`sync run` 自身也先调 `store.init()`（sync-run.ts）。
 * · 「未建库」到不了这个分支：`openGuardedSession` 先要求 `schema_version` 存在——库文件
 *   不存在或零表时早已是 `store_not_initialized`（实测）。
 * 能到达的只有两种：① 旧版 CLI 建的库，部分迁移没跑完（store init 会重放
 * `version > MAX(version)` 的迁移，可补建）；② 迁移已完成后表被删/损坏（store init
 * 返回 ok 但**不会**重建该表——迁移已跳过；重新同步只会 Catalog Error
 * `Table with name … does not exist`，实测）。
 * 故文案不得承诺「store init 一定能修」，也不得把 Agent 指向「先同步一次」。
 * ⚠️ 「重建库」是**破坏性**动作（CodeRabbit 2026-10-29 major）：库中可能有 `db tables`
 * 警告过的「未声明表」，也可能有超出 API 回补窗口的本地历史——删除库文件后，重建 +
 * 重新同步都拿不回来。文案必须要求先备份再删除。
 * ⚠️ 命令必须**指向本次的库**（2026-10-30 真库实测）：这些 hint 出现在
 * `--db <自定义路径>` 的输出里，裸 `qiyu store init` 会建**默认库**、原命令仍缺表。
 * 渲染走 `storeInitCommand(path)` / `syncRunCommand(path)`（output.ts 的唯一实现）。
 */
export function missingTableCauses(path: string, profileFlag?: string): string {
  return '若为建库未完成（迁移未跑完），运行 ' + storeInitCommand(path) + ' 可补建缺失的迁移；'
    + '若迁移已完成而表被删或损坏，store init 不会重建该表，重新同步也只会写入失败（缺表）'
    + '——需重建库：先备份库文件，再删除并重新 ' + storeInitCommand(path) + '、'
    + syncRunCommand(path, profileFlag)
    + '（未声明表与超出 API 回补窗口的本地历史无法靠重建恢复，删除前先确认）'
}

/** 表不存在的中文消息 + 候选 hint（原生分支与 cause 补算分支共用，裁决 R9）。 */
function tableNotFound(name: string, msg: string, tables: readonly TableDef[]): { message: string; hint: string } {
  const candidates = mergeCandidates(
    // 多要一个：只有知道「还有第 6 个」才能决定 hint 末尾加不加「等」。
    suggestNames(name, tables.map((t) => t.name), CANDIDATE_LIMIT + 1),
    // 原生候选（正确性 P2）同样过相关性闸门：DuckDB 的 `Candidate bindings/tables`
    // 可能给出与本输入毫无关系的名字（实测 `robot_summary` → `staff_group_members`），
    // 直接当「候选」展示会把 Agent 推向另一张表。只保留通过 `suggestNames` 阈值的那部分。
    suggestNames(name, nativeCandidates(msg), CANDIDATE_LIMIT + 1),
  )
  return {
    message: `表 ${name} 不存在`,
    hint: candidates.length > 0 ? candidateHint(candidates) : '用 `qiyu db tables` 查看可用表',
  }
}

/** 列不存在的中文消息 + 候选 hint（候选池 = 全部表的全部列名：SQL 不告诉我们 FROM 哪张表）。 */
function columnNotFound(name: string, msg: string, tables: readonly TableDef[]): { message: string; hint: string } {
  const allColumns = [...new Set(tables.flatMap((t) => t.columns.map((c) => c.name)))]
  const candidates = mergeCandidates(
    suggestNames(name, allColumns, CANDIDATE_LIMIT + 1),
    // 同 tableNotFound：原生候选须过相关性闸门（正确性 P2）。
    suggestNames(name, nativeCandidates(msg), CANDIDATE_LIMIT + 1),
  )
  return {
    message: `列 ${name} 不存在`,
    hint: candidates.length > 0
      ? candidateHint(candidates)
      : '用 `qiyu db describe <表>` 查看列清单',
  }
}

/**
 * 原文 → 表/列不存在的 { message, hint }（四种形态统一入口）。
 * 不是表/列不存在时返回 null —— 调用方自行决定后续分派。
 */
function missingNameFailure(
  msg: string,
  tables: readonly TableDef[],
): { message: string; hint: string } | null {
  const byTableName = TABLE_NAME_RE.exec(msg) ?? TABLE_REF_RE.exec(msg)
  if (byTableName) return tableNotFound(byTableName[1], msg, tables)
  const byColumn = COLUMN_NAMED_RE.exec(msg) ?? COLUMN_NAME_RE.exec(msg)
  if (byColumn) return columnNotFound(byColumn[1], msg, tables)
  return null
}

/**
 * 原生错误 → QueryFailure（spec §十一 分派表）。
 *
 * 分派顺序有意义：先透传已分类错误，再按原文形态分流。
 * ⚠️ layer2 的判定与 sandbox 对齐（`sandbox.ts` 的收窄裁决）：只认「配置禁用了文件系统」
 * 的措辞，**不认裸 `Permission Error`** —— 读库文件本身的 OS 权限错误也带这个前缀，
 * 误报成「已被只读沙箱拦截」会把环境问题（退出码 1）说成用法问题（退出码 2）。
 * `retryable` 一律 false：这些都是确定性错误，重试同一个查询只会得到同样的结果。
 */
export function classifyDuckDbError(e: unknown, tables: readonly TableDef[]): QueryFailure {
  // ① 已分类错误原样透传（sandbox 的分工：它分类，这里不重新分类）。
  // ⚠️ 唯一例外（裁决 R9）：sandbox 在 prepare 期把原生 Catalog/Binder 错误包成
  // `usage`/`query_error` 并把原文挂在 `cause` 上 —— kind/code 仍以 sandbox 为准，
  // 但「表/列不存在」的中文消息与候选要从 cause 原文补算，否则候选永远算不出来
  //（Task 8 验收「未知表 → 候选」）。cause 无关时一律不动，message 保持 sandbox 原文。
  const classified = asClassified(e)
  if (classified) {
    const f: QueryFailure = {
      code: classified.code ?? classified.kind,
      kind: classified.kind,
      retryable: classified.retryable ?? false,
      message: classified.message,
    }
    if (classified.hint !== undefined) f.hint = classified.hint
    if (classified.cause !== undefined && classified.cause !== null) {
      const causeMsg = errorText(classified.cause)
      // 表/列不存在只对 usage 补算（sandbox 的 prepare 期包装；Minor #6 守卫）。
      if (classified.kind === 'usage') {
        const refined = missingNameFailure(causeMsg, tables)
        if (refined) {
          f.message = refined.message
          f.hint = refined.hint
        }
      }
      // R11：sandbox 的执行期 catch 把 OOM 包成 internal 且（修复后）挂 cause ——
      // message 保持 sandbox 原文，只补可操作 hint。
      if (classified.kind === 'internal' && /Out of Memory Error/i.test(causeMsg)) {
        f.hint = '缩小时间范围或加过滤条件'
      }
    }
    return f
  }

  const msg = errorText(e)

  // ② layer2 拦截（文件/网络）：spec §十一 行 4。
  // ⚠️ 与 sandbox.ts 的收窄裁决对齐：裸 `Permission Error` 不算（可能是库文件的 OS
  // 权限问题），只认「文件系统操作被配置禁用」的两种措辞。
  if (/file system operations are disabled|Cannot access file/i.test(msg)) {
    return {
      kind: 'usage', code: 'sandbox_blocked', retryable: false,
      message: '该语句尝试访问文件或网络，已被只读沙箱拦截',
    }
  }

  // ③ 表/列不存在：spec §十一 行 5（四种原生形态统一走 missingNameFailure）。
  const missing = missingNameFailure(msg, tables)
  if (missing) {
    return { kind: 'usage', code: 'query_error', retryable: false, ...missing }
  }

  // ④ SQL 语法错：spec §十一 行 6 —— 中文包装 + 底层原文（原文自带位置信息，保留全部行）。
  if (/Parser Error/i.test(msg)) {
    return {
      kind: 'usage', code: 'query_error', retryable: false,
      message: `SQL 语法错误：${msg}`,
    }
  }

  // ⑤ 未绑参：spec §十一 行 6（「SQL 语法错 / 未绑参」同归 usage/query_error）。
  if (/Expected \d+ parameters/i.test(msg)) {
    return {
      kind: 'usage', code: 'query_error', retryable: false,
      message: `SQL 参数个数不匹配：${msg}`,
      hint: '请把过滤条件写成字面量；参数化查询仅供 CLI 内部代码使用',
    }
  }

  // ⑥ 其余 Binder / Catalog 错误（函数不存在、类型不匹配等）：同样是 SQL 写错了。
  // ⚠️ 不锚定行首：sandbox 实测会包一层前缀（`Failed to extract statements: Binder Error: …`）。
  if (/(Binder|Catalog) Error/i.test(msg)) {
    return {
      kind: 'usage', code: 'query_error', retryable: false,
      message: `SQL 无法执行：${msg}`,
      hint: '请检查表名、列名与 SQL 语法',
    }
  }

  // ⑦ 内存不足：环境问题，不是 SQL 写错 —— internal + 可操作 hint。
  if (/Out of Memory Error/i.test(msg)) {
    return {
      kind: 'internal', code: 'internal', retryable: false,
      message: `查询内存不足（${msg}）`,
      hint: '缩小时间范围或加过滤条件',
    }
  }

  // ⑧ 其余执行期错误 → internal，中文包装 + 底层原文（不裸透，spec §十一 末行）。
  return {
    kind: 'internal', code: 'internal', retryable: false,
    message: `查询执行失败（底层：${msg}）`,
    hint: '请检查查询条件；若反复出现请报告此问题',
  }
}

/**
 * 命令层统一出口：分类后写信封并返回退出码。
 *
 * usage 错误必须**双通道**：stderr 给人读的纯文本 + stdout 的 `{ok:false,error}` JSON
 * （与 `output.usageFail` 同一契约）。但 `usageFail` 把 code 固定成 `'usage'`，会丢掉
 * spec §十一 分派表的 code 列（`query_error` / `sandbox_blocked`）——而命令层测试
 * （plan Task 8「多语句 / COPY / ATTACH → sandbox_blocked」）正是按 code 断言的。
 * ⚠️ **这是有意偏离 `usageFail`，不是遗漏**（controller 裁决 R9 concern #2 确认保留）：
 * 故这里复刻 usageFail 的 stderr 写法，stdout 交给 `fail()` 保留真实 code；`fail()`
 * 对 kind='usage' 同样返回退出码 2。其余 kind 直接 `fail({...})`（退出码 1；
 * `query_timeout` 不设特殊分支）。若将来 `output.usageFail` 支持自定义 code，可改回复用它。
 */
export function thrownToQueryExit(
  e: unknown, tables: readonly TableDef[], noMask = false,
): number {
  return emitQueryFailure(classifyDuckDbError(e, tables), noMask)
}

/**
 * 已分类失败的唯一出口（`thrownToQueryExit` 与 `--table` 漂移识别共用）。
 * usage 双通道：stderr 纯文本 + stdout JSON（见上一段的说明）。
 *
 * `noMask` 只影响**转换错误回显里的值**（见下）；默认（false）脱敏。
 */
export function emitQueryFailure(f: QueryFailure, noMask = false): number {
  // security S3/S4：DuckDB 原文与调用方输入都可能带终端控制字符，且 Parser/Binder 错误
  // 会回显整行 SQL（其中可能含调用方写进 SQL 的 PII）。在**唯一出口**统一净化 + 裁掉
  // SQL 回显 —— 逐调用点补会漏（security 实测同文件内两种行为并存）。
  //
  // ⚠️ 转换错误还会回显**表里的真实值**（CodeRabbit 终审 major）：实测
  // `SELECT CAST(userPhone AS INT) FROM sessions` →
  // `Conversion Error: Could not convert string '13800138000' to INT32 …`
  // —— 那是查询结果行之外的一条独立泄漏通道（脱敏只作用于 rows，错误消息不经过它）。
  //
  // ⚠️ **不止单引号一种句式**（安全审查 Major，2026-10-20 用随包 `libduckdb.dylib` 的
  // 格式串 + 实跑核对）：同一个值会以不同包装回显，只挡一种就漏其余——
  //   · `Could not convert string '…' to INT32`        （单引号，INT/BIGINT）
  //   · `Could not convert string "…" to DECIMAL(5,2)` （双引号，实测）
  //   · `Could not parse string "…" according to format specifier "%Y"`（strptime，实测）
  //   · `Casting value "…" to type … failed: value is out of range!`
  //   · `Malformed JSON … Input: "<payload 原文片段>"`（payload 是 PII 完整副本，实测）
  //   · `Failed to cast value: …` / `Failed to cast value to decimal: …`
  // 只替换**值**的位置，保留错误类别与列名等可读信息（usage 错误里的引号标识符不受影响）。
  // ⚠️ **值内部可能含未转义的引号**（CodeRabbit 复审 Major，2026-10-20 实测）：
  // payload 是 JSON，DuckDB 回显时**不转义**内层引号——
  //   `Could not convert string "{"userName":"张三","x":1}" to DECIMAL(5,2)`
  // 若按「引号到下一个引号」匹配，只会吃掉 `"{"`，剩余 `userName":"张三"...` 原样留在
  // 消息里（strptime 更会在下一行再回显一遍原值）。故必须**锚定固定后缀**、贪婪匹配：
  //   · `… string <quote>…<quote> to …` / `… according to …`
  //   · `Casting value "…" to type …`
  const redactValueEcho = (s: string): string => s
    .replace(/(Could not (?:convert|parse) string )(['"])[\s\S]*\2(?=\s+(?:to|according)\b)/gi,
      "$1'<已脱敏>'")
    .replace(/(Casting value )"[\s\S]*"(?=\s+to type\b)/gi, "$1'<已脱敏>'")
    // `Input: "…"` 之后整段都是原始输入（可能跨行）—— 到消息结尾全裁掉。
    .replace(/(Malformed JSON[\s\S]*?\bInput: )"[\s\S]*$/i, "$1'<已脱敏>'")
    .replace(/(Failed to cast value(?: to (?:decimal|numerical))?: )[\s\S]*$/i, "$1'<已脱敏>'")
    // strptime 的第二处回显：`… according to format specifier "%Y"\n<原值>\n<缩进>^`
    // —— 头部已脱敏，但下一行会把原值再打印一遍（实测，payload 场景同样中招）。
    // ⚠️ 插入符可能带**前导空白**（DuckDB 按出错列位置缩进），lookahead 必须容忍。
    .replace(/(according to format specifier "[^"]*"\n)[\s\S]*?\n(?=[ \t]*\^)/i, '$1<已脱敏>\n')
  const clean = (s: string): string => {
    const withoutSql = stripSqlEcho(s)
    return sanitizeMessage(noMask ? withoutSql : redactValueEcho(withoutSql))
  }
  const message = clean(f.message)
  const hint = f.hint === undefined ? undefined : clean(f.hint)
  if (f.kind === 'usage') {
    process.stderr.write(message.endsWith('\n') ? message : message + '\n')
  }
  return fail({
    code: f.code, kind: f.kind, retryable: f.retryable,
    message: message.replace(/\n+$/, ''),
    ...(hint !== undefined ? { hint } : {}),
  })
}

/**
 * `--table` 通道的**库漂移**识别（PR 前契约审查 Minor）。
 *
 * 该通道的 SQL 由代码按 `TABLES` 生成，用户没写列名/表名 —— 撞上库漂移（列被删、表被删）
 * 时，`classifyDuckDbError` 的「SQL 无法执行，请检查表名、列名与 SQL 语法」与候选清单
 * 会把 Agent 指向**它无法修改的东西**（它没写 SQL），而唯一有效动作是核对漂移
 *（`db describe` 对同一状态会给出「实际多列/少列」的警告）。
 *
 * 判据收紧到「缺失名确实属于该表的声明」才认作漂移 —— 否则可能把真实的代码 bug
 *（生成的 SQL 里写错了列名）掩盖成环境问题。不属于时返回 null，交回原生分派。
 */
export function driftFailureFor(table: TableDef, e: unknown): QueryFailure | null {
  const msg = errorText(e)
  const byTable = TABLE_NAME_RE.exec(msg) ?? TABLE_REF_RE.exec(msg)
  if (byTable !== null && byTable[1] === table.name) {
    return {
      code: 'query_error', kind: 'usage', retryable: false,
      message: `表 ${table.name} 在库中不存在——与 TABLES 声明漂移（表被删或建库不完整）`,
      hint: `这不是你的查询写错了：本命令的 SQL 由 CLI 生成。用 \`qiyu db describe ${table.name}\` 核对，`
        + '并考虑重新同步或重建库（`qiyu store init` 只补未执行的迁移，不重建已删的表）',
    }
  }
  const byColumn = COLUMN_NAMED_RE.exec(msg) ?? COLUMN_NAME_RE.exec(msg)
  if (byColumn !== null && table.columns.some((c) => c.name === byColumn[1])) {
    return {
      code: 'query_error', kind: 'usage', retryable: false,
      message: `列 ${byColumn[1]} 在库中不存在（表 ${table.name}）——库与 TABLES 声明漂移`,
      hint: `这不是你的查询写错了：本命令的 SQL 由 CLI 生成，列名来自 TABLES 声明。`
        + `用 \`qiyu db describe ${table.name}\` 查看实际列集与漂移警告`,
    }
  }
  return null
}
