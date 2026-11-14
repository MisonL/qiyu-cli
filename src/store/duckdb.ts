// src/store/duckdb.ts
// ⚠️ 并发契约（G 组 G-7）：本实现持**单连接**，无内部串行化队列 —— 调用方必须
// 串行 await 所有 Store 方法（C1 的 store init/status 天然满足；D 的同步引擎
// 复用时同一 Store 实例上的 upsert/transaction 不得并发调用，否则 BEGIN/COMMIT
// 交错）。并发读写不同实例（rw 写者 + 多个 ro 读者）是受支持的用法（spec §5.2）。
// ⚠️ 重试归属（O 组 O-2/G-6）：写者路径**无内置重试**——D 的重试调度须在 D 层做。
// ⚠️ SQL 红线基线（O 组 O-3）：C1 交付时本文件 + commands/store.ts 的 SQL 字面
// 调用点共 8 处，全部为代码内常量（红线：外部派生字符串不得进 query()）；
// D/E 扩展时须保持并**更新此计数**。D-T1 追加 delete 原语后为 9 处
//（duckdb.ts 7：INSERT×2 / DELETE×1 / SELECT×4；commands/store.ts 2：SELECT×2）。
// D-T3 追加：src/sync/state.ts 常量 SELECT 3 处（水位/缺口读取），不在上述 9 处内。
// D-T11 追加：src/sync/tasks/knowledge.ts 常量 SELECT 1 处
//（knowledge.categories 的驱动序 SELECT DISTINCT robot_id），不在上述 9 处内。
import { MIGRATIONS, TABLES, tableByName, type TableDef } from './schema.js'
import { retryWithBackoff, isLockError, isModuleNotFound } from './retry.js'
import type { QueryResult, Store, StoreConfig, StoreMode, WriteTx } from './types.js'

// `isModuleNotFound` 的定义已下沉到 retry.ts（架构审查 M-4）：spec §5.1 白名单允许
// query/ import `store/retry` 但不允许 `store/duckdb`。这里保留 re-export，既有
// 导入点（tests/store/errors.test.ts）不破。
export { isModuleNotFound }

/** 可注入的导入边界 —— 单测 mock 它模拟依赖缺失（spec §5.1）。 */
export type DuckDbImporter = () => Promise<unknown>
const defaultImporter: DuckDbImporter = () => import('@duckdb/node-api')

export interface DuckDbDeps {
  importer?: DuckDbImporter
  sleep?: (ms: number) => Promise<void>
  now?: () => number
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

/** usage 错误（退出码 2）：带 kind 供命令层经 thrownToExit 归 usageFail 双通道。 */
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
    let conn: unknown
    try {
      conn = await (inst as { connect: () => Promise<unknown> }).connect()
      // ⚠️ 会话级封锁外部访问（2026-11-14，历史审查 PR#4 复核）：此前只有查询沙箱
      // （`src/query/sandbox.ts` 的 `HARDENING_SQL`）设过 `enable_external_access=false`，
      // store 连接什么都没设 —— 而实测 DuckDB 默认值是 **true**。于是 `store status/init`
      // 打开一个来源不明的 `.duckdb` 时，库里声明的 `tags` 等 view 会作为 COUNT(*) 的
      // 本体以用户权限执行（实测：含 `secret` 表的库里造 `tags` view，status 退出 0 并
      // 计数成功）。只设值、**不** lock_configuration —— 那是查询沙箱的加固项；
      // store 的写路径不需要改这个配置，锁住只会让将来正当的会话设置无从下手。
      await (conn as { runAndReadAll: (q: string) => Promise<unknown> })
        .runAndReadAll('SET enable_external_access=false')
      return { conn, inst }
    } catch (e) {
      // ⚠️ R 组 R9：create 成功但 connect 失败 → instance 泄漏（锁可能随进程滞留），
      // ro 退避路径会累积 —— 失败路径自清理。
      // ⚠️ **连接也要关**（Codex PR#74 第三轮 P2）：加固 `SET` 是在 connect **成功之后**才跑的，
      // 它失败时只关 instance 会漏掉已建立的连接 —— DuckDB 的锁要两者都关才释放，ro 退避路径
      // 每失败一次就多一个未关连接，后续打开更容易撞锁。先关连接，再关实例。
      try { (conn as { closeSync?: () => void } | undefined)?.closeSync?.() } catch { /* 同上 */ }
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
        // 单次尝试也必须有界（2026-11-14，历史审查 PR#4 复核）：`DuckDBInstance.create` /
        // `connect` 在网络盘或卡住的锁等待上可以永不返回，而截止时间原先只在**抛错后**才比 ——
        // 只读命令会无限挂着。超时被放弃的尝试若后来成功，经 `onAbandoned` 关掉（否则多一个
        // 锁持有者）。
        attemptMs: cfg.readOnlyRetryMs,
        onAbandoned: (r) => {
          try { (r.conn as { closeSync?: () => void }).closeSync?.() } catch { /* 清理失败不掩盖原错误 */ }
          try { (r.inst as { closeSync?: () => void }).closeSync?.() } catch { /* 同上 */ }
        },
        sleep: deps.sleep, now: deps.now,
      })
      conn = r.conn; inst = r.inst
    } catch (e) {
      // 打开超时（`timedOut` 标记）与撞锁是同一类后果 —— 等不到库；归 store_locked。
      if (isLockError(e) || (e as { timedOut?: boolean }).timedOut === true) {
        const err = new Error(`数据库被写进程占用（等待 ${cfg.readOnlyRetryMs}ms 后超时）：${cfg.path}`)
        ;(err as { kind?: string }).kind = 'store_locked'
        ;(err as { retryable?: boolean }).retryable = true
        ;(err as { hint?: string }).hint = '请稍后重试；等待上限可经配置文件 profiles.<name>.store.readOnlyRetryMs（默认 30000 毫秒）调整，或用 --db 指向其他数据库文件'
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
        // ⚠️ 写者撞锁时**持有者不一定是写进程**（2026-11-05 审查实测）：DuckDB 是
        // 「写者独占 / 读者共享」——一个以 READ_ONLY 打开的进程同样会挡住写者。
        // 旧文案「数据库被写进程占用 / 另一个进程持有写锁」把只读持有者说成了写者，
        // Agent 会按错误的原因去等一个并不存在的同步任务。持有者身份不在这条错误里
        // 猜测，只如实说「被其他进程占用」并给出可执行的排查动作。
        const err = new Error(`数据库被其他进程占用：${cfg.path}`)
        ;(err as { kind?: string }).kind = 'store_locked'
        ;(err as { retryable?: boolean }).retryable = true
        ;(err as { hint?: string }).hint = '另一个进程正持有该数据库的锁（持有者不一定是写进程：只读会话同样会挡住写者）。请等它退出后重试；可用 lsof 该库文件查看持库进程'
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
    // ⚠️ 只有主键列的表要写 `DO NOTHING`（2026-11-14，历史审查 PR#4 复核）：`schema_version`
    // 的唯一列 `version` 就是主键，`nonKey` 为空时拼出的 `DO UPDATE SET ` 语法错误
    // （实测 `Parser Error: syntax error at end of input`），而 `assertTable` 放行该表
    // —— upsert 契约对这张表不成立。语义上「只有主键」的行没有可更新的列，冲突即已存在。
    const conflictAction = nonKey.length > 0
      ? `DO UPDATE SET ${nonKey.map((x) => `"${x}" = excluded."${x}"`).join(', ')}`
      : 'DO NOTHING'
    const pk = t.primaryKey.map((x) => `"${x}"`).join(', ')
    // ⚠️ 同批重复主键必须先收敛（2026-11-04 修）：DuckDB 的多行 `INSERT ... ON CONFLICT
    // DO UPDATE` 在同一语句里遇到重复键时**保留第一条**（实测：两条 id=1 的行写入后是
    // 第一条的值），而分批写入（batchSize=1）时后一条会覆盖前一条 —— 同一批数据的结果
    // 取决于 batchSize 配置。这里统一成「后出现的行获胜」（与逐条写入的直觉一致），
    // 且只发一条 INSERT，结果与 batchSize 无关。
    // ⚠️ 键必须按**列的存储类型**归一化，不能按 JS 的 typeof（CodeRabbit PR #65）：
    // VARCHAR 主键列里 number 1 与 string '1' 存进去是同一个值；若按 typeof 区分，
    // 它们在同一批里不会合并（DuckDB 保留第一条），而 batchSize=1 时后者获胜 ——
    // 又变回 batchSize 相关。数值列（今天只有 schema_version.version 是 INTEGER）
    // 用 BigInt 归一化整数串：既不让 '01' 与 1 分成两键，也不因 Number 丢精度把
    // 两个不同的大整数误合成一个。非整数形态（病态输入）退回 Number。
    const pkTypes = t.primaryKey.map((c) => t.columns.find((x) => x.name === c)!.type)
    const isNumeric = (ty: string) => /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|REAL|DOUBLE|DECIMAL)/i.test(ty)
    const normKey = (v: unknown, ty: string): string => {
      const raw = typeof v === 'bigint' ? v.toString() : String(v)
      if (!isNumeric(ty)) return raw
      const t = raw.trim()
      if (/^[+-]?\d+$/.test(t)) {
        try { return BigInt(t).toString() } catch { /* 超出 BigInt 范围，退回 Number */ }
      }
      return String(Number(t))
    }
    const seen = new Map<string, number>()
    const uniq: Record<string, unknown>[] = []
    for (const r of rows) {
      // ⚠️ 用 JSON.stringify 序列化元组，不用分隔符 join（CodeRabbit PR #65）：
      // 多列 VARCHAR 主键时 delimiter 区分不了复合列自身的值（如 `as:b,c` 与
      // `a,bs:c` 撞 key）。`JSON.stringify` 的换码天然无歧义。
      const k = JSON.stringify(t.primaryKey.map((c, idx) => normKey(r[c], pkTypes[idx]!)))
      const at = seen.get(k)
      if (at === undefined) { seen.set(k, uniq.length); uniq.push(r) } else uniq[at] = r
    }
    let written = 0
    // ⚠️ 切批规则（M2 修，与 spec §5.3 对齐）：**batchSize 是首选切批尺寸**，
    // 65000 参数硬顶无条件兜底 —— 实际行数 = min(batchSize, floor(65000/cols))。
    // （Q 组 Q-高-1 的实测仍成立：1M 参数单语句 43s，硬顶必须恒生效、batchSize
    // 配大也不能越过；但 batchSize 原义是「多值 INSERT 每批行数」（types.ts/§5.3），
    // 小于硬顶时必须生效，此前实现把它完全忽略是契约偏离。）
    // 65000 是保守值：实测该版本上限 ≥70000，勿据此放大（Q 组 Q-低-1）。
    const hardCap = Math.max(1, Math.floor(65000 / cols.length))
    const rowsPerStmt = Math.max(1, Math.min(cfg.batchSize, hardCap))
    // `DO NOTHING` 时不能按 `batch.length` 记账（Codex PR#74 第二轮 P2）：冲突行一行都没写，
    // 契约（types.ts `Store.upsert`「返回实际写入行数」）要求如实计数。这张表所有列都是主键，
    // 唯一会改变行数的就是「新键插入」—— 用前后计数，与 `del` 的算法同源。
    // `DO UPDATE` 之路不计数：新键插入、旧键更新，两者都算一次写入。
    const countDelta = nonKey.length === 0
    const beforeCount = countDelta ? await store.count(t.name) : 0
    for (let i = 0; i < uniq.length; i += rowsPerStmt) {
      const batch = uniq.slice(i, i + rowsPerStmt)
      const placeholders = batch.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')
      const params = batch.flatMap((r) => cols.map((k) => r[k] ?? null))
      await store.execSql(
        `INSERT INTO "${t.name}" (${quoted}) VALUES ${placeholders} ON CONFLICT (${pk}) ${conflictAction}`,
        params)
      written += batch.length
    }
    if (countDelta) return Math.max(0, (await store.count(t.name)) - beforeCount)
    return written
  }

  const del = async (tname: string, where: string, params: unknown[] = []): Promise<number> => {
    const t = assertTable(tname)
    const before = await store.count(tname)
    await store.execSql(`DELETE FROM "${t.name}" WHERE ${where}`, params)
    const after = await store.count(tname)
    return Math.max(0, before - after)
  }

  // ⚠️ 回滚保护（G 组 G-3）：若回滚本身失败（如连接已被并发 close），次生错误
  // 不得掩盖原始失败原因 —— 吞掉回滚错误，保留 catch 里的原错误继续抛。
  // （ROLLBACK 与 BEGIN/COMMIT 同为事务控制语句，闭包直调——见 upsert 处注释。）
  const safeRollback = async (): Promise<void> => {
    try { await execSql('ROLLBACK') } catch { /* 保留原错误 */ }
  }

  /**
   * 他人库指纹（`init` 专用）：命中返回成因文案，否则 null。
   *
   * ⚠️ **只认「我们绝不可能产出」的形态**（2026-11-14，历史审查 PR#4 复核实测）：
   * ① `schema_version` 没有 `version` 列 —— 我们的迁移第一版就建了它；
   * ② 有表但 `schema_version` **一行都没有** —— 我们的每次迁移都插一行，留下的库至少有一条；
   * ③ 记录的最大版本**超过本 CLI 已知的最新迁移** —— 我们从未写过这个号。
   * ⚠️ **不要**改回「声明表出现声明外的列就拒绝」（首版这么写，全量回归当场抓到）：
   * 多列/少列是**既有契约里的 schema 漂移**（`db tables` 只警告不失败、README 明写），
   * 一条手工 `ALTER TABLE … ADD COLUMN` 会被误判成他人库，`store init` 直接不可用。
   * 代价如实记录：一条**版本号恰好落在我们范围内**的外来库仍可能被当成「旧版 CLI 建的库」，
   * 那时 init 不建表、只按 `storeTablesWarnings` 点名缺表 —— 不会往里写业务数据。
   */
  const detectForeignStore = async (): Promise<string | null> => {
    const r = await store.execSql(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'main'")
    const cols = new Map<string, string[]>()
    for (const row of (r as { getRowObjectsJson: () => Record<string, unknown>[] }).getRowObjectsJson()) {
      const t = String(row.table_name)
      const list = cols.get(t) ?? []
      list.push(String(row.column_name).toLowerCase())
      cols.set(t, list)
    }
    const svCols = cols.get('schema_version') ?? []
    if (!svCols.includes('version')) {
      return `目标数据库不是本 CLI 创建的（schema_version 缺少 version 列，`
        + `实际列：${svCols.join('、') || '无'}）：${cfg.path}`
    }
    const svRes = await store.execSql('SELECT COUNT(*) AS n, COALESCE(MAX(version), 0) AS v FROM schema_version')
    const rows = (svRes as { getRowObjectsJson: () => Record<string, unknown>[] }).getRowObjectsJson()
    const n = Number(rows[0]?.n ?? 0)
    const v = Number(rows[0]?.v ?? 0)
    const latest = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0)
    if (n === 0) {
      return `目标数据库不是本 CLI 创建的（库中有表，但 schema_version 没有任何记录）：${cfg.path}`
    }
    if (v > latest) {
      return `目标数据库不是本 CLI 创建的（schema_version 记录版本 ${v}，`
        + `高于本 CLI 已知的最新迁移 ${latest}）：${cfg.path}`
    }
    return null
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
      // ⚠️ 「有 schema_version」不是身份证明（2026-11-14，历史审查 PR#4 复核）：实测造一个
      // `{secret 表, schema_version(version INTEGER) 空表}` 的外来库，init 直接报 ok 并往里
      // 建表。指纹判据见 `detectForeignStore` 的注释（三条「我们不可能产出」的形态）。
      if (names.includes('schema_version')) {
        const foreign = await detectForeignStore()
        if (foreign !== null) {
          const err = new Error(foreign)
          ;(err as { kind?: string }).kind = 'store_not_initialized'
          ;(err as { hint?: string }).hint = '目标数据库不是本 CLI 创建的，请换 --db 路径'
          throw err
        }
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
    delete: del,
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
          delete: (t: string, w: string, p?: unknown[]) => store.delete(t, w, p),
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
