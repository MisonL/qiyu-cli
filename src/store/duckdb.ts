// src/store/duckdb.ts
// ⚠️ 并发契约（G 组 G-7）：本实现持**单连接**，无内部串行化队列 —— 调用方必须
// 串行 await 所有 Store 方法（C1 的 store init/status 天然满足；D 的同步引擎
// 复用时同一 Store 实例上的 upsert/transaction 不得并发调用，否则 BEGIN/COMMIT
// 交错）。并发读写不同实例（rw 写者 + 多个 ro 读者）是受支持的用法（spec §5.2）。
// ⚠️ 重试归属（O 组 O-2/G-6）：写者路径**无内置重试**——D 的重试调度须在 D 层做。
// ⚠️ SQL 红线基线（O 组 O-3）：C1 交付时本文件 + commands/store.ts 的 SQL 字面
// 调用点共 8 处，全部为代码内常量（红线：外部派生字符串不得进 query()）；
// D/E 扩展时须保持并**更新此计数**。
import { MIGRATIONS, tableByName, type TableDef } from './schema.js'
import { retryWithBackoff, isLockError } from './retry.js'
import type { QueryResult, Store, StoreConfig, StoreMode, WriteTx } from './types.js'

/** 可注入的导入边界 —— 单测 mock 它模拟依赖缺失（spec §5.1）。 */
export type DuckDbImporter = () => Promise<unknown>
const defaultImporter: DuckDbImporter = () => import('@duckdb/node-api')

export interface DuckDbDeps {
  importer?: DuckDbImporter
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/** 识别 ERR_MODULE_NOT_FOUND 并取出缺失的 specifier（spec §5.1 的二分规则）。 */
export function isModuleNotFound(e: unknown): { missing: string } | null {
  const err = e as { code?: string; message?: string }
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') return null
  const m = /Cannot find (?:package|module) '([^']+)'/.exec(err.message ?? '')
  return { missing: m?.[1] ?? '' }
}

/** 依赖缺失 → store_not_initialized（按缺失 specifier 前缀二分 hint，spec §5.1）。 */
function depError(e: unknown): Error {
  const mn = isModuleNotFound(e)
  const err = new Error(`无法加载 DuckDB 依赖：${e instanceof Error ? e.message : String(e)}`)
  ;(err as { kind?: string }).kind = 'store_not_initialized'
  ;(err as { hint?: string }).hint = mn && mn.missing.startsWith('@duckdb/node-bindings')
    ? '当前平台无 DuckDB 预编译包（无 node-gyp 回退）。请在受支持的平台上安装 @duckdb/node-api@1.5.6-r.1'
    : '未安装 DuckDB 依赖。请在 qiyu-cli 的安装环境中运行：npm install @duckdb/node-api@1.5.6-r.1'
  return err
}

/** usage 错误（退出码 2）：带 kind 供命令层经 mapThrownToExit 归 usage。 */
function usage(msg: string): Error {
  const e = new Error(msg)
  ;(e as { kind?: string }).kind = 'usage'
  return e
}

export async function createDuckDbStore(cfg: StoreConfig, mode: StoreMode, deps: DuckDbDeps = {}): Promise<Store> {
  let mod: { DuckDBInstance: { create: (p: string, o?: unknown) => Promise<unknown> } }
  try {
    mod = (await (deps.importer ?? defaultImporter)()) as typeof mod
  } catch (e) {
    throw depError(e)
  }

  const open = async (): Promise<{ conn: unknown; inst: unknown }> => {
    // ⚠️ 只读模式必须真的以 READ_ONLY 打开 —— 这是 ro→ro 并发可用的前提（spec §5.2）。
    // ✅ 第四轮实测（1.5.6-r.1 安装包）：配置项名就是 `access_mode: 'READ_ONLY'`，
    // 且 ro 打开后 INSERT 被 DuckDB 拒绝（read-only mode）——形态确认无误。
    const inst = mode === 'ro'
      ? await mod.DuckDBInstance.create(cfg.path, { access_mode: 'READ_ONLY' })
      : await mod.DuckDBInstance.create(cfg.path)
    try {
      const conn = await (inst as { connect: () => Promise<unknown> }).connect()
      return { conn, inst }
    } catch (e) {
      // ⚠️ R 组 R9：create 成功但 connect 失败 → instance 泄漏（锁可能随进程滞留），
      // ro 退避路径会累积 —— 失败路径自清理。
      try { (inst as { closeSync?: () => void }).closeSync?.() } catch { /* 清理错误不掩盖原异常 */ }
      throw e
    }
  }

  let conn: unknown
  let inst: unknown
  if (mode === 'ro') {
    // 读者：锁冲突时退避重试（spec §5.2）；**超限后必须包装 store_locked**（v3.1 修——
    // v1 计划直接重抛原始错误，经 thrownToExit 会变成退出码 2 的 usage，违反验收 35）。
    try {
      const r = await retryWithBackoff({
        tryOpen: open, isRetryable: isLockError, maxMs: cfg.readOnlyRetryMs,
        sleep: deps.sleep, now: deps.now,
      })
      conn = r.conn; inst = r.inst
    } catch (e) {
      if (isLockError(e)) {
        const err = new Error(`数据库被写进程占用（等待 ${cfg.readOnlyRetryMs}ms 后超时）：${cfg.path}`)
        ;(err as { kind?: string }).kind = 'store_locked'
        ;(err as { retryable?: boolean }).retryable = true
        ;(err as { hint?: string }).hint = '请稍后重试；等待上限可经配置文件 readOnlyRetryMs（默认 30000 毫秒）调整，或用 --db 指向其他数据库文件'
        throw err
      }
      throw e
    }
  } else {
    // 写者不重试（spec §5.2）：撞锁立即抛。
    try {
      const r = await open()
      conn = r.conn; inst = r.inst
    } catch (e) {
      if (isLockError(e)) {
        const err = new Error(`数据库被写进程占用：${cfg.path}`)
        ;(err as { kind?: string }).kind = 'store_locked'
        ;(err as { retryable?: boolean }).retryable = true
        ;(err as { hint?: string }).hint = '另一个进程持有数据库写锁。请等该进程退出后重试'
        throw err
      }
      throw e
    }
  }

  // ⚠️ 真实 API（第四轮实测）：runAndReadAll(sql, params) 返回带 getRowObjectsJson()
  // 与 columnNames() 的读取器；run() 返回的 Result 没有取行方法。
  const c = conn as {
    run: (sql: string, params?: unknown[]) => Promise<unknown>
    runAndReadAll: (sql: string, params?: unknown[]) => Promise<{
      getRowObjectsJson: () => Record<string, unknown>[]
      columnNames: () => string[]
    }>
  }
  let closed = false
  let inTx = false

  // ⚠️ 所有语句执行收敛到这一个方法 —— 测试 spy 的落点（spec §5.3）。
  // ⚠️ **挂载与调用契约（v3.1 定死，消除二选一）**：
  // ① store 的方法体**双轨调用**：数据语句（SELECT/INSERT 等）必须经 `store.execSql(...)`
  //    （属性查找发生在调用时，vi.spyOn 替换后即命中 spy）；事务控制语句
  //    BEGIN/COMMIT/ROLLBACK 闭包直调 execSql（否则 spy 数到事务壳、断言
  //    「1000 行 1 条语句」必红——T5 实测裁定）——闭包直调数据语句会绕过 spy，
  //    「1000 行批量 1 条语句」断言形同虚设（v1 计划实测缺陷，D/E/F 三组独立发现）；
  // ② `Object.defineProperty` 必须 `writable: true, configurable: true` —— 默认
  //    configurable:false 会让 vi.spyOn 重定义属性时直接抛 TypeError；
  // ③ 挂为**不可枚举**（不污染 JSON 输出与接口形状）。
  const execSql = async (sql: string, params: unknown[] = []): Promise<unknown> => {
    if (closed) throw usage('数据库连接已关闭')
    // 统一走 runAndReadAll：其结果带 getRowObjectsJson/columnNames（run() 的结果没有）
    return c.runAndReadAll(sql, params)
  }

  const assertTable = (name: string): TableDef => {
    const t = tableByName(name)
    if (!t) throw usage(`未知表：${name}`)
    return t
  }

  const assertRows = (t: TableDef, rows: Record<string, unknown>[]): void => {
    if (rows.length === 0) return
    const cols = t.columns.map((x) => x.name)
    for (let i = 0; i < rows.length; i++) {
      const keys = Object.keys(rows[i])
      for (const k of keys) if (!cols.includes(k)) throw usage(`未知列：${k}（表 ${t.name}）`)
      for (const cd of t.columns) {
        if (!(cd.name in rows[i])) throw usage(`表 ${t.name} 缺少列：${cd.name}`)
        if (rows[i][cd.name] === null && !cd.nullable) throw usage(`列 ${cd.name} 不允许 null（表 ${t.name}）`)
      }
    }
  }

  const doUpsert = async (t: TableDef, rows: Record<string, unknown>[]): Promise<number> => {
    if (rows.length === 0) return 0
    const cols = t.columns.map((x) => x.name)
    const quoted = cols.map((x) => `"${x}"`).join(', ')
    const nonKey = cols.filter((x) => !t.primaryKey.includes(x))
    const setClause = nonKey.map((x) => `"${x}" = excluded."${x}"`).join(', ')
    const pk = t.primaryKey.map((x) => `"${x}"`).join(', ')
    let written = 0
    // ⚠️ 切批规则（Q 组 Q-高-1 修订：从「batchSize 超限才切」改为「单语句参数恒 ≤65000」
    // —— batchSize 配大不会提速反而 O(N²) 劣化（实测 1M 参数单语句 43s），硬顶必须无条件生效）。
    // 65000 是保守值：实测该版本上限 ≥70000，勿据此放大（Q 组 Q-低-1）。
    const maxRowsPerStmt = Math.max(1, Math.floor(65000 / cols.length))
    for (let i = 0; i < rows.length; i += maxRowsPerStmt) {
      const batch = rows.slice(i, i + maxRowsPerStmt)
      const placeholders = batch.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')
      const params = batch.flatMap((r) => cols.map((k) => r[k] ?? null))
      await store.execSql(
        `INSERT INTO "${t.name}" (${quoted}) VALUES ${placeholders} ON CONFLICT (${pk}) DO UPDATE SET ${setClause}`,
        params)
      written += batch.length
    }
    return written
  }

  // ⚠️ 回滚保护（G 组 G-3）：若回滚本身失败（如连接已被并发 close），次生错误
  // 不得掩盖原始失败原因 —— 吞掉回滚错误，保留 catch 里的原错误继续抛。
  // （ROLLBACK 与 BEGIN/COMMIT 同为事务控制语句，闭包直调——见 upsert 处注释。）
  const safeRollback = async (): Promise<void> => {
    try { await execSql('ROLLBACK') } catch { /* 保留原错误 */ }
  }

  // ⚠️ store 自引用：方法体经 store.execSql 调用（见下方契约）。断言目标**必须含
  // execSql**（第四轮 H 组实测：`as unknown as Store` 下方法体内所有 store.execSql
  // 报 TS2339——纯编译期属性缺失，非 TDZ）；方法参数显式标注（自引用打断上下文
  // 推导，不标会隐式 any）。
  const store = {
    async init() {
      if (mode === 'ro') throw usage('只读模式下不能初始化（需 rw 模式）')
      // 他人库防线（spec §6.1）：已有表但无 schema_version → 拒绝。
      const existing = await store.execSql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`)
      const names = (existing as { getRowObjectsJson: () => Record<string, unknown>[] }).getRowObjectsJson()
        .map((r) => String(r.table_name))
      if (names.length > 0 && !names.includes('schema_version')) {
        // ⚠️ 他人库 → store_not_initialized、退出码 1（spec §8.2 成因 6）——不是 usage。
        const err = new Error(`目标数据库不是本 CLI 创建的（含表 ${names.join(', ')}）：${cfg.path}`)
        ;(err as { kind?: string }).kind = 'store_not_initialized'
        ;(err as { hint?: string }).hint = '目标数据库不是本 CLI 创建的，请换 --db 路径'
        throw err
      }
      const cur = names.includes('schema_version')
        ? await store.execSql('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version')
        : null
      const v = cur === null ? 0 : Number((cur as { getRowObjectsJson: () => Record<string, unknown>[] }).getRowObjectsJson()[0].v)
      for (const m of MIGRATIONS.filter((x) => x.version > v).sort((a, b) => a.version - b.version)) {
        await execSql('BEGIN')
        try {
          await m.up((sql) => store.execSql(sql).then(() => undefined))
          await store.execSql('INSERT INTO schema_version (version) VALUES (?)', [m.version])
          await execSql('COMMIT')
        } catch (e) {
          // 迁移失败：回滚且**不推进**版本 —— 下次 init 重放该迁移（验收 19/20）。
          await safeRollback()
          throw e
        }
      }
    },
    async tables(): Promise<string[]> {
      const r = await store.execSql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`)
      return (r as { getRowObjectsJson: () => Record<string, unknown>[] }).getRowObjectsJson()
        .map((x) => String(x.table_name)).sort()
    },
    async count(table: string): Promise<number> {
      assertTable(table)
      const r = await store.execSql(`SELECT COUNT(*) AS n FROM "${table}"`)
      const v = (r as { getRowObjectsJson: () => Record<string, unknown>[] }).getRowObjectsJson()[0].n
      return Number(v)   // ⚠️ BIGINT → string，必须收敛（spec §5.4，已实测确认）
    },
    async upsert(table: string, rows: Record<string, unknown>[]): Promise<number> {
      const t = assertTable(table)
      assertRows(t, rows)
      if (inTx) return doUpsert(t, rows)
      // ⚠️ BEGIN/COMMIT 闭包直调 execSql：测试 spy 只断言**数据语句**条数（语句数 == 批次
      // 数），事务控制语句不走 store.execSql 属性查找（与测试为权威的裁定一致）。
      await execSql('BEGIN')
      try {
        const n = await doUpsert(t, rows)
        await execSql('COMMIT')
        return n
      } catch (e) {
        await safeRollback()
        throw e
      }
    },
    async transaction<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T> {
      if (inTx) throw usage('不得嵌套事务')
      await execSql('BEGIN')
      inTx = true
      try {
        // ⚠️ 真实投影而非 cast：WriteTx 类型上不含 query/init/close（spec §4.2.6 防线分层），
        // 运行时对象也不得携带 —— 直接传 store 的话 `Object.keys(tx)` 可枚举出 query。
        const tx: WriteTx = {
          tables: () => store.tables(),
          count: (t: string) => store.count(t),
          upsert: (t: string, rows: Record<string, unknown>[]) => store.upsert(t, rows),
          transaction: <U>(f: (tx2: WriteTx) => Promise<U>) => store.transaction(f),
        }
        const r = await fn(tx)
        await execSql('COMMIT')
        return r
      } catch (e) {
        await safeRollback()
        throw e
      } finally {
        inTx = false
      }
    },
    async query(sql: string, params?: unknown[]): Promise<QueryResult> {
      const r = await store.execSql(sql, params ?? [])
      const rows = (r as { getRowObjectsJson: () => Record<string, unknown>[] }).getRowObjectsJson()
      // 空结果集也要给真实列名（不能留空数组）——columnNames() 是读取器上的方法，
      // 空集也返回真实列名（第四轮实测确认）。
      const cols = rows.length > 0
        ? Object.keys(rows[0])
        : (r as { columnNames: () => string[] }).columnNames()
      return { columns: cols, rows } as QueryResult
    },
    async close(): Promise<void> {
      if (closed) return
      closed = true
      // ⚠️ 真实 API 是 **closeSync()**（同步方法）——`close?.()` 会静默跳过、连接泄漏
      //（第四轮实测：instance 原型只有 connect/closeSync）。包 try 防次生错误掩盖原结果。
      // ⚠️ N1 实测：**connection 与 instance 都要 closeSync** —— 只关 instance 不关 conn，
      // 锁随进程存活、永不超时释放；先关 conn 再关 inst。
      try { (conn as { closeSync?: () => void }).closeSync?.() } catch { /* 清理期错误不掩盖 */ }
      try { (inst as { closeSync?: () => void }).closeSync?.() } catch { /* 清理期错误不掩盖 */ }
    },
  } as unknown as Store & { execSql: typeof execSql }
  // ⚠️ 挂载契约见上方 execSql 注释：不可枚举 + writable + configurable（缺 configurable
  // 会让 vi.spyOn 重定义时抛 TypeError）；数据语句一律 store.execSql(...)（属性调用时
  // 查找），事务控制语句闭包直调（双轨，见上方契约①）。
  Object.defineProperty(store, 'execSql', { value: execSql, enumerable: false, writable: true, configurable: true })
  return store
}
