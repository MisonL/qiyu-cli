// src/query/sandbox.ts
// E 组的三层只读沙箱（spec §5.1–§5.4）—— `query --sql` 的唯一执行入口。
//
// ⚠️ 三层缺一不可（spec §5.4 全部实测）：
//   layer1 语句白名单：extractStatements 条数闸门 + prepare().statementType ∈ {SELECT, EXPLAIN}
//     + type=4 追加「无 ANALYZE 记号」闸门（EXPLAIN ANALYZE 会真正执行内层语句，探针 16）
//   layer2 文件/网络封锁：enable_external_access=false + lock_configuration=true
//   layer3 只读打开：DuckDBInstance.create(path, { access_mode: 'READ_ONLY' })
// 每层单独都有实测穿透：仅 layer3 时 read_csv / COPY TO 仍成功（tests/query/sandbox.test.ts
// 「三层对照」用例钉死）；仅 layer2 时 INSERT/CREATE/DROP 不碰文件系统、照写不误；
// 纯 EXPLAIN 的内层写/文件访问仍会尝试执行（分别由 layer3/layer2 兜底）。三者叠加才是完整防线。
// ⚠️ EXPLAIN ANALYZE 是特例：内层 CALL/PRAGMA 改的是**实例级配置**（如 enable_profiling），
// 不碰文件、不是库写 —— layer2/3 都拦不住，且会把 profile 树打到 stdout 破坏「stdout 只出
// JSON」的契约。所以必须在 layer1 直接拒绝（见 hasAnalyzeToken）。
//
// ⚠️ 分层约束（spec §5.1）：本文件不 import `sync/`、`commands/`、`store/duckdb.ts` 的
// Store 实现。依赖缺失的识别函数 `isModuleNotFound` 定义在 `store/retry.ts`（架构审查
// M-4 后下沉，让 query/ 的依赖面与 spec 白名单逐字一致），两条路径的 hint 逐字一致由它保证。
//
// ⚠️ 依赖加载：`@duckdb/node-api` 只经 dynamic import（与 store/duckdb.ts 同款惰性边界）。
import { isLockError, retryWithBackoff, isModuleNotFound } from '../store/retry.js'
import type { ErrorKind } from '../core/errors.js'
import type { StoreConfig } from '../store/types.js'

export interface SandboxResult {
  columns: string[]
  rows: Record<string, unknown>[]
  truncated: boolean
}

export interface SandboxRunOptions {
  params?: unknown[]
  limit?: number
  timeoutMs?: number
}

export interface SandboxSession {
  run(sql: string, opts?: SandboxRunOptions): Promise<SandboxResult>
  close(): Promise<void>
}

export interface SandboxDeps {
  importer?: () => Promise<unknown>
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultImporter: () => Promise<unknown> = () => import('@duckdb/node-api')

// —— 加固序列（⚠️ 顺序敏感，spec §5.2 探针 3/6/10）——
// TimeZone / memory_limit 必须在 lock_configuration 之前设：lock 之后连
// `SET TimeZone='UTC'` 都报 `configuration has been locked`。
// memory_limit='1GB' 是硬编码常量（YAGNI，不设配置项）：128MB 下大排序实测 OOM，
// 1GB 足以覆盖本库任何表，同时防跑飞。
const HARDENING_SQL = [
  "SET TimeZone='Asia/Shanghai'",
  "SET memory_limit='1GB'",
  'SET enable_external_access=false',
  'SET lock_configuration=true',
] as const

// 加固自检（spec §5.2 第 7 步）：防 DuckDB 未来改名导致 layer2 静默失效。
// 含 memory_limit —— 只读 ea/lc 时「删除 memory_limit 加固行」不会有任何测试/自检
// 变红（审查 I-5）；它同样是 spec §5.2 声明的加固项，必须自证生效。
const SELF_CHECK_SQL =
  "SELECT current_setting('enable_external_access') AS ea, " +
  "current_setting('lock_configuration') AS lc, " +
  "current_setting('memory_limit') AS ml"

/**
 * DuckDB 的 memory_limit 回显 → 字节数（实测格式 `953.6 MiB` / `51.1 GiB` / `1.0 GiB`）。
 * **无法解析 → 返回 0**，调用方必须把 0 当成失败（fail-closed）——否则未来 DuckDB 改
 * 回显格式时自检会静默放行一个没加固的会话（复审发现的 fail-open）。
 * 支持 B/KiB/MiB/GiB/TiB（spaced 或紧贴写法都认）。
 */
export function memoryLimitBytes(display: unknown): number {
  if (typeof display !== 'string') return 0
  const m = /^([\d.]+)\s*(B|KiB|MiB|GiB|TiB)$/.exec(display.trim())
  if (m === null) return 0
  const unit = { B: 1, KiB: 1024, MiB: 1024 ** 2, GiB: 1024 ** 3, TiB: 1024 ** 4 } as const
  const n = Number(m[1]) * unit[m[2] as keyof typeof unit]
  return Number.isFinite(n) ? n : 0
}

// statementType 数值 → 类型名（spec §5.3 映射表；实测值见任务 brief）。
// ⚠️ 补全 3/5/9/15（edge F6）：此前 DELETE/UPDATE/DROP/ALTER 被拒时报「类型 5」这类裸数字，
// Agent 既查不到含义也无法据此改查询；spec §十一要求点明类型名。
const TYPE_NAMES: Record<number, string> = {
  2: 'INSERT', 3: 'UPDATE', 5: 'DELETE', 7: 'CREATE', 9: 'ALTER', 11: 'COPY',
  15: 'DROP', 16: 'EXPORT', 17: 'PRAGMA', 19: 'CALL', 20: 'SET', 21: 'INSTALL',
  25: 'ATTACH',
}

// —— DuckDB 原语的最小结构化类型（本文件不静态 import @duckdb/node-api）——
interface DuckDbReader {
  getRowObjectsJson: () => Record<string, unknown>[]
  columnNames: () => string[]
}

interface DuckDbPreparedStatement {
  statementType: number
  parameterCount: number
  bind: (params: unknown[]) => void
  runAndReadUntil: (targetRowCount: number) => Promise<DuckDbReader>
  destroySync?: () => void
}

interface DuckDbExtractedStatements {
  count: number
  prepare: (index: number) => Promise<DuckDbPreparedStatement>
}

interface DuckDbConnection {
  run: (sql: string) => Promise<unknown>
  runAndReadAll: (sql: string) => Promise<DuckDbReader>
  extractStatements: (sql: string) => Promise<DuckDbExtractedStatements>
  interrupt: () => void
  closeSync?: () => void
}

interface DuckDbInstance {
  connect: () => Promise<DuckDbConnection>
  closeSync?: () => void
}

interface DuckDbModule {
  DuckDBInstance: { create: (path: string, opts?: unknown) => Promise<DuckDbInstance> }
  StatementType?: Record<string, number>
}

type SandboxError = Error & {
  kind: ErrorKind
  code?: string
  hint?: string
  retryable?: boolean
}

/** 所有抛出的错误都带 `kind`（+ 可选 `code`/`hint`/`retryable`），供命令层 thrownToExit 同族映射。 */
function sandboxError(
  kind: ErrorKind,
  message: string,
  extra: { code?: string; hint?: string; retryable?: boolean; cause?: unknown } = {},
): SandboxError {
  const e = new Error(message) as SandboxError
  e.kind = kind
  if (extra.code !== undefined) e.code = extra.code
  if (extra.hint !== undefined) e.hint = extra.hint
  if (extra.retryable !== undefined) e.retryable = extra.retryable
  // 原生错误原文（裁决 R9）：Task 5 的 classifyDuckDbError 从这里补算表/列候选。
  if (extra.cause !== undefined) e.cause = extra.cause
  return e
}

/** 依赖缺失 → store_not_initialized（与 store/duckdb.ts 的 depError 同口径、同 hint）。 */
function depError(e: unknown): SandboxError {
  const mn = isModuleNotFound(e)
  return sandboxError(
    'store_not_initialized',
    `无法加载 DuckDB 依赖：${e instanceof Error ? e.message : String(e)}`,
    {
      hint: mn && mn.missing.startsWith('@duckdb/node-bindings')
        ? '当前平台无 DuckDB 预编译包（无 node-gyp 回退）。请在受支持的平台上安装 @duckdb/node-api@1.5.6-r.1'
        : '未安装 DuckDB 依赖。请在 qiyu-cli 的安装环境中运行：npm install @duckdb/node-api@1.5.6-r.1',
    },
  )
}

/** ro 撞写锁退避超限 → store_locked（消息/hint 与 store/duckdb.ts 同款，spec §5.2）。 */
function lockedError(cfg: StoreConfig): SandboxError {
  return sandboxError(
    'store_locked',
    `数据库被写进程占用（等待 ${cfg.readOnlyRetryMs}ms 后超时）：${cfg.path}`,
    {
      retryable: true,
      hint: '请稍后重试；等待上限可经配置文件 readOnlyRetryMs（默认 30000 毫秒）调整，或用 --db 指向其他数据库文件',
    },
  )
}

function typeName(t: number): string {
  return TYPE_NAMES[t] ?? `类型 ${t}`
}

/**
 * 剥掉 SQL 里的注释与字符串/标识符字面量，只留下「可能承载关键字」的骨架。
 *
 * 为什么要剥（而不是直接对原文查 ANALYZE）：
 *   `EXPLAIN SELECT 'ANALYZE' AS s` / `EXPLAIN SELECT 1 AS "ANALYZE"` / 注释里的
 *   ANALYZE 都是合法且无害的 —— 直接查会把它们误拒。
 * `keepDoubleQuoted`：保留双引号标识符原文。EXPLAIN 的选项名可以被双引号包裹
 *   （实测 `EXPLAIN ("ANALYZE")` 同样执行内层），选项列表必须按原文检查；
 *   其余位置则把 `"…"` 当作普通字面量剥掉（列名/别名里的 ANALYZE 不误伤）。
 * 剥不干净的怪输入（未闭合引号/注释、dollar 引号不配对）→ malformed，
 * 由调用方拒绝（fail closed）。
 *
 * ⚠️ 两条实测词法事实（复审复现，别改回简化版）：
 *   1. **行注释的终止符是 `\n` 或 `\r`**：DuckDB 认 `\r`（`EXPLAIN --x\rANALYZE CALL …`
 *      实测 type=4 且执行内层）。只找 `\n` 会让 `\r` 之后的整段被当成注释丢掉 → 漏判 ANALYZE。
 *   2. **块注释可嵌套**：实测在块注释里再开一层块注释是合法 SQL（DuckDB 按深度闭合，
 *      不是「遇到第一个结束标记就收」）；若内层结束后紧跟一个引号，按「第一个结束标记」
 *      剥会把剩余部分误当字符串字面量 → 漏判 ANALYZE（复审给出的绕过句正是这种形态）。
 *      必须按深度扫描（开标记 +1、结束标记 −1，深度归零才结束）。
 */
function stripSqlNoise(sql: string, keepDoubleQuoted: boolean): { skeleton: string; malformed: boolean } {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    const next = i + 1 < n ? sql[i + 1] : ''
    // 行注释：-- 到 \n 或 \r（实测 DuckDB 两者都终止；\r\n 由先到的 \r 覆盖）
    if (ch === '-' && next === '-') {
      let j = i + 2
      while (j < n && sql[j] !== '\n' && sql[j] !== '\r') j += 1
      if (j >= n) break // 注释到输入末尾：后面确实没有内容
      out += '\n'
      i = j + 1
      continue
    }
    // 块注释：/* … */，**按嵌套深度**扫描（实测 DuckDB 支持嵌套；未闭合 → malformed）
    if (ch === '/' && next === '*') {
      let depth = 1
      let j = i + 2
      while (j < n && depth > 0) {
        if (sql[j] === '/' && j + 1 < n && sql[j + 1] === '*') { depth += 1; j += 2; continue }
        if (sql[j] === '*' && j + 1 < n && sql[j + 1] === '/') { depth -= 1; j += 2; continue }
        j += 1
      }
      if (depth > 0) return { skeleton: out, malformed: true }
      out += ' '
      i = j
      continue
    }
    // 单引号字符串：'' 为转义
    if (ch === "'") {
      i += 1
      let closed = false
      while (i < n) {
        if (sql[i] === "'") {
          if (i + 1 < n && sql[i + 1] === "'") { i += 2; continue }
          i += 1
          closed = true
          break
        }
        i += 1
      }
      if (!closed) return { skeleton: out, malformed: true }
      out += " '' "
      continue
    }
    // 双引号标识符："" 为转义
    if (ch === '"') {
      const start = i
      i += 1
      let closed = false
      while (i < n) {
        if (sql[i] === '"') {
          if (i + 1 < n && sql[i + 1] === '"') { i += 2; continue }
          i += 1
          closed = true
          break
        }
        i += 1
      }
      if (!closed) return { skeleton: out, malformed: true }
      out += keepDoubleQuoted ? ` ${sql.slice(start, i)} ` : " '' "
      continue
    }
    // dollar 引号：$tag$ … $tag$（tag 可为空；标签内只允许标识符字符）
    if (ch === '$') {
      const m = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(sql.slice(i))
      if (m) {
        const tag = m[0]
        const end = sql.indexOf(tag, i + tag.length)
        if (end === -1) return { skeleton: out, malformed: true }
        out += " '' "
        i = end + tag.length
        continue
      }
    }
    out += ch
    i += 1
  }
  return { skeleton: out, malformed: false }
}

/**
 * type=4 的内层闸门：语句骨架里出现 ANALYZE 记号即视为「EXPLAIN ANALYZE 家族」。
 *
 * 实测（@duckdb/node-api 1.5.6-r.1，spec §5.3 探针 16）：
 *   · `EXPLAIN ANALYZE CALL enable_profiling()` → 报告 type=4，且**真正执行**内层 CALL，
 *     把实例配置 enable_profiling 改成 query_tree —— 之后每条查询的 profile 树都打到
 *     stdout，直接破坏「stdout 只出 JSON」的契约；
 *   · `EXPLAIN (ANALYZE)`、`EXPLAIN (ANALYZE false)`、`EXPLAIN (ANALYZE, FORMAT JSON)`、
 *     `EXPLAIN ("ANALYZE")`、`EXPLAIN ANALYSE`（同义拼写）同样执行内层；选项值不影响；
 *   · 纯 `EXPLAIN CALL …` 不执行内层（配置不变）。
 * 所以按记号一刀切拒绝；双引号标识符只在 EXPLAIN 选项列表位置按原文检查
 *（`EXPLAIN SELECT 1 AS "ANALYZE"` 这类列名/别名不误伤）。DuckDB 还接受英式拼写
 * ANALYSE，一并覆盖。极端误拒（列名恰叫 analyze 且被 EXPLAIN）是 fail closed，
 * hint 里说明去掉 ANALYZE 即可。
 */
function hasAnalyzeToken(sql: string): boolean {
  // ① 普通骨架：字符串/标识符/注释全部剥掉后查裸记号。
  const bare = stripSqlNoise(sql, false)
  if (bare.malformed) return true // 解析不了的怪输入：宁可拒绝
  if (/\bANALY[ZS]E\b/i.test(bare.skeleton)) return true

  // ② EXPLAIN 选项列表：双引号保留原文，`("ANALYZE")` 也会执行内层。
  const quoted = stripSqlNoise(sql, true)
  if (quoted.malformed) return true
  const opts = /^\s*EXPLAIN\s*\(([^)]*)\)/i.exec(quoted.skeleton)
  return opts !== null && /\bANALY[ZS]E\b/i.test(opts[1])
}

/**
 * prepare 期原生错误 → 粗分类（spec §十一；细化由 Task 5 的 classifyDuckDbError 负责）。
 * layer2 的拦截就发生在 prepare 期（`Permission Error: … file system operations are
 * disabled by configuration`），所以这里必须把「文件/网络访问」与普通 SQL 错误分开。
 * ⚠️ 只认 layer2 的两个特征串，不能把泛化的 `Permission Error` 也算进来 ——
 * 读库文件本身的 OS 权限错误也带这个前缀，误报成「沙箱拦截」会误导用户。
 */
function mapPrepareError(e: unknown): SandboxError {
  const msg = e instanceof Error ? e.message : String(e)
  if (/file system operations are disabled|Cannot access file/i.test(msg)) {
    return sandboxError('usage', '该语句尝试访问文件或网络，已被只读沙箱拦截', {
      code: 'sandbox_blocked',
      hint: '沙箱只允许读取数据库内的数据：read_csv / read_text / glob / COPY TO / ATTACH / EXPORT / INSTALL 均不可用',
    })
  }
  // 裁决 R9：把原生错误挂在 cause 上，Task 5 从原文补算表/列候选（message 格式保持不变）。
  return sandboxError('usage', `SQL 无法执行：${msg}`, {
    code: 'query_error',
    hint: '请检查表名、列名与 SQL 语法',
    cause: e,
  })
}

/**
 * 以三层防护打开只读沙箱会话。`query/` 只暴露 `run` / `close` —— 不存在
 * 「可信 SQL 绕过白名单」的旁路（spec §5.2：旁路 API 本身就是攻击面）。
 */
export async function openSandbox(cfg: StoreConfig, deps: SandboxDeps = {}): Promise<SandboxSession> {
  let mod: DuckDbModule
  try {
    mod = (await (deps.importer ?? defaultImporter)()) as unknown as DuckDbModule
  } catch (e) {
    throw depError(e)
  }

  // layer3：真的以 READ_ONLY 打开（ro→ro 并发可用的前提）。
  const open = async (): Promise<{ inst: DuckDbInstance; conn: DuckDbConnection }> => {
    const inst = await mod.DuckDBInstance.create(cfg.path, { access_mode: 'READ_ONLY' })
    try {
      return { inst, conn: await inst.connect() }
    } catch (e) {
      // create 成功但 connect 失败 → instance 泄漏（锁可能随进程滞留），失败路径自清理。
      try { inst.closeSync?.() } catch { /* 清理错误不掩盖原异常 */ }
      throw e
    }
  }

  let inst: DuckDbInstance
  let conn: DuckDbConnection
  try {
    const r = await retryWithBackoff({
      tryOpen: open,
      isRetryable: isLockError,
      maxMs: cfg.readOnlyRetryMs,
      sleep: deps.sleep,
      now: deps.now,
    })
    inst = r.inst
    conn = r.conn
  } catch (e) {
    if (isLockError(e)) throw lockedError(cfg)
    // 其余打开失败（库不存在 / 非 DuckDB 文件 / 权限）→ store_not_initialized（spec §十一：
    // 库不存在 → 退出码 1、hint 指 `qiyu store init`）。底层原文保留在 message 里。
    throw sandboxError(
      'store_not_initialized',
      `无法打开数据库：${e instanceof Error ? e.message : String(e)}`,
      { hint: '请确认数据库文件存在且由本 CLI 创建（qiyu store init），或用 --db 指向其他数据库文件' },
    )
  }

  // ⚠️ 关闭顺序与 store/duckdb.ts:305 同：先 conn 再 inst —— 只关 instance 不关 conn，
  // 锁会随进程存活、永不释放。两个 closeSync 都包 try，清理期错误不掩盖原结果。
  const closeRaw = (): void => {
    try { conn.closeSync?.() } catch { /* 清理期错误不掩盖 */ }
    try { inst.closeSync?.() } catch { /* 清理期错误不掩盖 */ }
  }

  // layer2：加固 + 自检。任一步失败都先关连接再抛 —— 不留半加固的会话。
  try {
    for (const sql of HARDENING_SQL) await conn.run(sql)
    const r = await conn.runAndReadAll(SELF_CHECK_SQL)
    const row = r.getRowObjectsJson()[0] ?? {}
    // memory_limit 的回显是格式化字符串（实测 `SET memory_limit='1GB'` → "953.6 MiB"，
    // 未加固时是机器内存的 80%，本机 51.1 GiB），无法回读原值 —— 按**上限**断言：
    // 加固的意义是「封顶」（1GB → 953.6 MiB），上限取 1 GiB 既容得下加固值、
    // 又挡得住未加固的默认值（内存 ≥1.25 GiB 的机器默认值即 >1 GiB；更小的机器上
    // 默认值本就接近加固值，漏判无害）。解析失败返回 0 必须算失败（fail-closed，
    // 复审 I-5 残留）：否则 DuckDB 改回显格式时静默放行一个没封顶的会话。
    const mlBytes = memoryLimitBytes(row.ml)
    if (row.ea !== false || row.lc !== true || mlBytes === 0 || mlBytes > 1024 ** 3) {
      throw sandboxError(
        'internal',
        `只读沙箱自检失败：enable_external_access=${String(row.ea)}，`
          + `lock_configuration=${String(row.lc)}，memory_limit=${String(row.ml)}`,
        { hint: '当前 DuckDB 版本的配置项可能已改名；请报告此问题，不要在此状态下查询' },
      )
    }
  } catch (e) {
    closeRaw()
    if (e instanceof Error && (e as SandboxError).kind !== undefined) throw e
    throw sandboxError(
      'internal',
      `只读沙箱加固失败：${e instanceof Error ? e.message : String(e)}`,
      { hint: '数据库配置无法锁定；请报告此问题，不要在此状态下查询' },
    )
  }

  let closed = false

  const run = async (sql: string, opts: SandboxRunOptions = {}): Promise<SandboxResult> => {
    if (closed) throw sandboxError('usage', '数据库连接已关闭', { code: 'query_error' })
    const params = opts.params ?? []
    const limit = opts.limit ?? 1000
    const timeoutMs = opts.timeoutMs ?? 30000
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
      throw sandboxError(
        'usage',
        `limit 必须是 1–10000 的整数（收到 ${String(opts.limit)}）`,
        { code: 'query_error' },
      )
    }
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      throw sandboxError(
        'usage',
        `timeoutMs 必须是非负数（0 = 无超时，收到 ${String(opts.timeoutMs)}）`,
        { code: 'query_error' },
      )
    }

    // layer1-①：语句数闸门。多语句实测每条都会执行（spec §5.4 第 9 行），
    // `count === 1` 是必需闸门；'SELECT 1;;' / 尾注释 / 尾分号仍是 count=1，放行。
    let ex: DuckDbExtractedStatements
    try {
      ex = await conn.extractStatements(sql)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      // ⚠️ 实测：空串 / 纯空白 / 纯注释 / ';' 抛 "Error in native callback"；
      // **但语法错误也在这一步抛**（`SELEC 1` → "Failed to extract statements: Parser
      // Error: syntax error …"）。不能一律报「SQL 为空」—— 那样用户打错一个关键字会得到
      // 一条与事实不符的错误（spec §十一：语法错 → usage/query_error + 底层原文）。
      if (/Error in native callback/i.test(msg)) {
        throw sandboxError('usage', 'SQL 为空或无有效语句', {
          code: 'query_error',
          hint: '请提供一条 SELECT / DESCRIBE / SHOW / EXPLAIN 查询',
        })
      }
      throw mapPrepareError(e)
    }
    if (ex.count === 0) {
      throw sandboxError('usage', 'SQL 为空或无有效语句', {
        code: 'query_error',
        hint: '请提供一条 SELECT / DESCRIBE / SHOW / EXPLAIN 查询',
      })
    }
    if (ex.count > 1) {
      throw sandboxError('usage', `一次只接受一条语句（检测到 ${ex.count} 条）`, {
        code: 'sandbox_blocked',
        hint: '多语句会被逐条执行；请拆成多次查询',
      })
    }

    // layer1-②：prepare（layer2 的文件/网络拦截也在这里先报）。
    // ⚠️ 成功的 prepared statement 持有原生句柄 —— 每次 run 结束都 destroySync，
    // 否则长会话反复查询会累积原生内存（prepare 失败不产出对象，无需释放）。
    let p: DuckDbPreparedStatement
    try {
      p = await ex.prepare(0)
    } catch (e) {
      throw mapPrepareError(e)
    }
    try {
      // layer1-③：参数占位符。未绑参的 `?` 在执行期才报错，提前拦下更清楚。
      if (p.parameterCount !== params.length) {
        throw sandboxError(
          'usage',
          `SQL 含 ${p.parameterCount} 个参数占位符，实际提供 ${params.length} 个参数（--sql 不接受参数占位符）`,
          { code: 'query_error', hint: '请把过滤条件写成字面量；参数化查询仅供 CLI 内部代码使用' },
        )
      }

      // layer1-④：类型白名单。DESCRIBE / SHOW / PRAGMA table_info / PRAGMA database_list
      // 都报告为 1（只读形态，放行）。`typeof` 守卫：注入的假模块若把 StatementType 的值
      // 给成字符串，不能让它静默地把所有语句都挡掉。
      const ST = mod.StatementType ?? {}
      const SELECT = typeof ST.SELECT === 'number' ? ST.SELECT : 1   // 实测值：SELECT=1
      const EXPLAIN = typeof ST.EXPLAIN === 'number' ? ST.EXPLAIN : 4 // 实测值：EXPLAIN=4
      if (p.statementType !== SELECT && p.statementType !== EXPLAIN) {
        throw sandboxError('usage', `只读沙箱不接受 ${typeName(p.statementType)} 语句`, {
          code: 'sandbox_blocked',
          hint: '只允许 SELECT / DESCRIBE / SHOW / EXPLAIN 等只读查询',
        })
      }

      // layer1-⑤：EXPLAIN ANALYZE 内层执行闸门（spec §5.3 探针 16）。ANALYZE 会让 DuckDB
      // **真正执行**内层语句；内层 CALL/PRAGMA 改的是实例级配置（不碰文件、不是库写），
      // layer2/3 都拦不住。纯 EXPLAIN（无 ANALYZE）不执行内层，放行。
      // 只对 type=4 扫描：普通 SELECT 里叫 analyze 的列别名是合法的。
      if (p.statementType === EXPLAIN && hasAnalyzeToken(sql)) {
        throw sandboxError(
          'usage',
          'EXPLAIN ANALYZE 会真正执行内层语句，沙箱不接受；去掉 ANALYZE 即可查看执行计划',
          {
            code: 'sandbox_blocked',
            hint: '请改用不带 ANALYZE 的纯 EXPLAIN 查看执行计划',
          },
        )
      }

      // 执行：runAndReadUntil 按 chunk 倍数读、**不精确限行**（请求 10 行实测返回 2048 行），
      // 所以多读一行、用「返回行数 > limit」判定截断，而不是 SQL LIMIT 包装
      //（包装要剥尾分号/尾注释，`SELECT 1; -- x` 会炸）。
      if (params.length > 0) p.bind(params)
      let timer: ReturnType<typeof setTimeout> | null = null
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          try { conn.interrupt() } catch { /* 中断失败不掩盖查询本身的结果 */ }
        }, timeoutMs)
      }
      let reader: DuckDbReader
      try {
        reader = await p.runAndReadUntil(limit + 1)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        if (/INTERRUPT/i.test(msg)) {
          // 实测：interrupt 约 300ms 生效，中断后连接仍可用（探针 6/9）。
          // ⚠️ hint 不得点名 `--timeout`（审查 I-4）：只有 `query` 接受该 flag，
          // `db tables` / `db describe` / `stats fields` 共用本出口，建议一个它们
          // 不认的参数等于给一条走不通的路（`未知参数：--timeout`，退出码 2）。
          throw sandboxError('query_timeout', `查询超过 ${timeoutMs}ms 未完成，已中断`, {
            code: 'query_timeout',
            hint: '请缩小时间范围或加过滤条件，把查询收窄到能在超时内完成',
          })
        }
        // 裁决 R11：执行期原生错误也挂 cause —— errors.ts 从原文补 OOM 的可操作 hint
        //（不挂的话「Out of Memory Error → 缩小时间范围」在生产路径永远不触发）。
        throw sandboxError('internal', `查询执行失败：${msg}`, {
          code: 'internal',
          hint: '请检查查询条件；若反复出现请报告此问题',
          cause: e,
        })
      } finally {
        if (timer !== null) clearTimeout(timer)
      }

      const all = reader.getRowObjectsJson()
      const truncated = all.length > limit
      const rows = truncated ? all.slice(0, limit) : all
      // ⚠️ 列名一律取 `columnNames()`，**不要**用 `Object.keys(rows[0])`（edge F3）：
      // 驱动的 `getRowObjectsJson()` 以属性赋值构行，名为 `__proto__` 的列会变成**原型
      // 赋值而不是自有键** —— 实测 `SELECT session_id, "__proto__", normal_extra FROM …`
      // 时 `Object.keys` 少了它，显式请求的列连同值凭空消失、退出码 0、零警告。
      // 取真实列名后逐行核对自有键：缺键说明该列的值经此驱动 API 无法表示，**必须
      // fail-closed**（静默丢一列比报错更糟：Agent 会把「没有这一列」当成事实）。
      const columns = reader.columnNames()
      for (const row of rows) {
        for (const name of columns) {
          if (Object.hasOwn(row, name)) continue
          throw sandboxError('internal', `查询结果含无法安全表示的列名 ${name}`
            + '（驱动把该名字映射成了对象原型属性，取不到值）', {
            code: 'internal',
            hint: `请给该列起别名后重试，例如 SELECT "${name}" AS proto_col …`,
          })
        }
      }
      return { columns, rows, truncated }
    } finally {
      try { p.destroySync?.() } catch { /* 释放期错误不掩盖查询结果/原异常 */ }
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    closeRaw()
  }

  return { run, close }
}
