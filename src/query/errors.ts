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
import { fail } from '../output.js'
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
    if (lower === needle || seen.has(lower)) continue // 与输入同名 / 名字池里重复（列名跨表重名）
    seen.add(lower)
    const distance = levenshtein(needle, lower)
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
// ④ `Referenced column "paylod" (was) not found …`（无 FROM 时多一个 `was`）
const TABLE_NAME_RE = /Catalog Error: Table with name ([^\s]+) does not exist/
const TABLE_REF_RE = /Binder Error: Referenced table "([^"]+)" not found/
const COLUMN_NAMED_RE = /Binder Error: Table "[^"]+" does not have a column named "([^"]+)"/
const COLUMN_NAME_RE = /Referenced column "([^"]+)" (?:was )?not found/

/** 表不存在的中文消息 + 候选 hint（原生分支与 cause 补算分支共用，裁决 R9）。 */
function tableNotFound(name: string, msg: string, tables: readonly TableDef[]): { message: string; hint: string } {
  const candidates = mergeCandidates(
    // 多要一个：只有知道「还有第 6 个」才能决定 hint 末尾加不加「等」。
    suggestNames(name, tables.map((t) => t.name), CANDIDATE_LIMIT + 1),
    nativeCandidates(msg),
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
    nativeCandidates(msg),
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
export function thrownToQueryExit(e: unknown, tables: readonly TableDef[]): number {
  const f = classifyDuckDbError(e, tables)
  if (f.kind === 'usage') {
    process.stderr.write(f.message.endsWith('\n') ? f.message : f.message + '\n')
  }
  return fail({
    code: f.code, kind: f.kind, retryable: f.retryable,
    message: f.message.replace(/\n+$/, ''),
    ...(f.hint !== undefined ? { hint: f.hint } : {}),
  })
}
