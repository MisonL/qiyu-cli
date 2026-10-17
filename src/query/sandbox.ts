// src/query/sandbox.ts
// E 组的三层只读沙箱（spec §5.1–§5.4）—— `query --sql` 的唯一执行入口。
//
// ⚠️ 三层缺一不可（spec §5.4 全部实测）：
//   layer1 语句白名单：extractStatements 条数闸门 + prepare().statementType ∈ {SELECT, EXPLAIN}
//   layer2 文件/网络封锁：enable_external_access=false + lock_configuration=true
//   layer3 只读打开：DuckDBInstance.create(path, { access_mode: 'READ_ONLY' })
// 每层单独都有实测穿透：仅 layer3 时 read_csv / COPY TO 仍成功（tests/query/sandbox.test.ts
// 「三层对照」用例钉死）；仅 layer2 时 INSERT/CREATE/DROP 不碰文件系统、照写不误；
// 仅 layer1 时 EXPLAIN ANALYZE（报告为 4）会真正执行内层语句。三者叠加才是完整防线。
//
// ⚠️ 分层约束（spec §5.1）：本文件不 import `sync/`、`commands/`、`store/duckdb.ts` 的
// Store 实现。唯一从 duckdb.ts 借的是纯函数 `isModuleNotFound`（无状态、不触碰 Store），
// 复用它是为了两条依赖缺失路径的 hint 逐字一致。
//
// ⚠️ 依赖加载：`@duckdb/node-api` 只经 dynamic import（与 store/duckdb.ts 同款惰性边界）。
import { isLockError, retryWithBackoff } from '../store/retry.js'
import { isModuleNotFound } from '../store/duckdb.js'
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
const SELF_CHECK_SQL =
  "SELECT current_setting('enable_external_access') AS ea, " +
  "current_setting('lock_configuration') AS lc"

// statementType 数值 → 类型名（spec §5.3 映射表；实测值见任务 brief）。
const TYPE_NAMES: Record<number, string> = {
  2: 'INSERT', 7: 'CREATE', 11: 'COPY', 16: 'EXPORT', 17: 'PRAGMA',
  19: 'CALL', 20: 'SET', 21: 'INSTALL', 25: 'ATTACH',
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
  extra: { code?: string; hint?: string; retryable?: boolean } = {},
): SandboxError {
  const e = new Error(message) as SandboxError
  e.kind = kind
  if (extra.code !== undefined) e.code = extra.code
  if (extra.hint !== undefined) e.hint = extra.hint
  if (extra.retryable !== undefined) e.retryable = extra.retryable
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
 * prepare 期原生错误 → 粗分类（spec §十一；细化由 Task 5 的 classifyDuckDbError 负责）。
 * layer2 的拦截就发生在 prepare 期（`Permission Error: … file system operations are
 * disabled by configuration`），所以这里必须把「文件/网络访问」与普通 SQL 错误分开。
 */
function mapPrepareError(e: unknown): SandboxError {
  const msg = e instanceof Error ? e.message : String(e)
  if (/Permission Error|file system operations are disabled|Cannot access file/i.test(msg)) {
    return sandboxError('usage', '该语句尝试访问文件或网络，已被只读沙箱拦截', {
      code: 'sandbox_blocked',
      hint: '沙箱只允许读取数据库内的数据：read_csv / read_text / glob / COPY TO / ATTACH / EXPORT / INSTALL 均不可用',
    })
  }
  return sandboxError('usage', `SQL 无法执行：${msg}`, {
    code: 'query_error',
    hint: '请检查表名、列名与 SQL 语法',
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
    if (row.ea !== false || row.lc !== true) {
      throw sandboxError(
        'internal',
        `只读沙箱自检失败：enable_external_access=${String(row.ea)}，lock_configuration=${String(row.lc)}`,
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
      // 都报告为 1（只读形态，放行）；EXPLAIN ANALYZE 报告为 4 且会真正执行内层语句 ——
      // 允许它，靠 layer2/3 兜底（这正是「三层缺一不可」的实证场景）。
      const ST = mod.StatementType ?? {}
      const SELECT = ST.SELECT ?? 1   // 实测值：SELECT=1
      const EXPLAIN = ST.EXPLAIN ?? 4 // 实测值：EXPLAIN=4
      if (p.statementType !== SELECT && p.statementType !== EXPLAIN) {
        throw sandboxError('usage', `只读沙箱不接受 ${typeName(p.statementType)} 语句`, {
          code: 'sandbox_blocked',
          hint: '只允许 SELECT / DESCRIBE / SHOW / EXPLAIN 等只读查询',
        })
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
          throw sandboxError('query_timeout', `查询超过 ${timeoutMs}ms 未完成，已中断`, {
            code: 'query_timeout',
            hint: '请缩小时间范围、加过滤条件，或调大 --timeout',
          })
        }
        throw sandboxError('internal', `查询执行失败：${msg}`, {
          code: 'internal',
          hint: '请检查查询条件；若反复出现请报告此问题',
        })
      } finally {
        if (timer !== null) clearTimeout(timer)
      }

      const all = reader.getRowObjectsJson()
      const truncated = all.length > limit
      const rows = truncated ? all.slice(0, limit) : all
      // 空结果集也要给真实列名（不能留空数组）—— columnNames() 在空集上仍返回真实列名。
      const columns = rows.length > 0 ? Object.keys(rows[0]) : reader.columnNames()
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
