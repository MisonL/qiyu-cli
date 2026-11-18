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
import { AsyncLocalStorage } from 'node:async_hooks'
import { MIGRATIONS, TABLES, tableByName, type TableDef } from './schema.js'
import { objectKinds, isBaseTable, sameObjectName } from './object-kinds.js'
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
  /**
   * 事务归属上下文的构造缝（默认 `new AsyncLocalStorage()`）。
   * ⚠️ 存在的唯一理由是**让「关闭后不得再启用 ALS」可断言**（Codex PR#81 第十八轮 P2）：
   * 启用状态在 Node 上不可读，测试只能观察 `run()` 有没有被调用 —— 那正是重新启用的唯一途径。
   */
  makeAls?: () => Pick<TxAls, 'run' | 'getStore' | 'disable'>
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

/**
 * 事务令牌：每次事务一个 `symbol`，`transaction()` 与自动事务（upsert 自开的）都一样。
 * 调用方属于哪条事务**只看异步上下文里的令牌是否相等** —— 自动事务与显式事务的区分
 * 不需要令牌“类型”来标，用 `instanceof` 标类型的写法曾让「另一条链的 transaction()」
 * 漏判成 `usage`（见 `transaction()` 的注释，CodeRabbit PR#81 第十七轮）。
 */
type TxToken = symbol

/**
 * 事务归属的异步上下文。⚠️ 必须**每个 Store 实例一份**（在 `createDuckDbStore` 内建），
 * 否则同一进程里两个实例的事务令牌会互相干扰。
 */
type TxAls = AsyncLocalStorage<TxToken>

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
  /**
   * 当前事务的**所有者令牌**（历史审查 PR#4 复核）。
   *
   * ⚠️ 事故事实：`inTx` 是**整个 Store 实例共享的布尔**，所以「事务外另一条异步链」调用
   * `upsert`/`delete` 时会被当成「事务内」，直接被写进别人那条未提交的事务 —— 对方回滚，
   * 这一行就**静默消失**，而 `upsert` 还返回了成功行数（实测：outside 分支 resolves，
   * 回滚后 `count === 0`）。报错是可修的，"成功却丢数据"不可发现。
   * 归属判据用 `AsyncLocalStorage`：只有从 `transaction()` 回调**内部**发起的写才算事务内。
   * 单连接、`await` 串行的既有用法（store init/status、sync 引擎）行为完全不变。
   */
  let txToken: TxToken | undefined
  /**
   * 事务「代号」：每次有事务**开启**（显式 `transaction()` 或自动事务的 BEGIN）就 +1。
   * ⚠️ 用途（CodeRabbit PR#81 第二十八轮 major，实测复现）：`execSql` 的归属检查在**语句下发
   * 之前**，而驱动内部的 `runUntilLast` / `prepared.run()` 之间隔着 await —— 这段时间里另一条链
   * 若开了事务，本语句就落在它的事务里；它一旦执行期报错（实测：`SELECT` 一个 CAST 失败的
   * view），那条事务就被 DuckDB 标成 aborted。因此下发前后各取一次代号，**跨代即拒绝**：读路径
   * 同样拒绝（它会把别人的事务标成 aborted，代价是一样的）。
   * ⚠️ 拒绝只对发起方可见；所有者侧靠 `foreignInFlight` + `commitOrRefuse` 保证**不冒充
   * 成功**（CodeRabbit/Codex PR#81 第三十二、三十三轮 major：驱动在执行完与结果返回之间还有
   * 异步点，COMMIT 可以先落定、外部错误后到 —— 用例 `回调直接返回` 与 `外部语句在所有者提交
   * 之后才报错` 用「执行后闸门」复现过）。
   */
  let txEpoch = 0
  const alsTx: Pick<TxAls, 'run' | 'getStore' | 'disable'> = deps.makeAls?.() ?? new AsyncLocalStorage<symbol>()

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
  /** 语句下发期间事务代号变化 → `internal`，`cause` 可带驱动原文（与 `assertTxOwnership` 同一分类）。 */
  const epochChangedError = (cause?: unknown): Error => {
    const err = new Error(
      '语句等待期间另一条异步链开启了事务 —— 本条语句可能落进那条事务，'
      + '它一旦执行期报错就会把对方的事务标成 aborted（对方随后 COMMIT / 写入会响亮失败、'
      + '事务内写入不落库；对方若因此拿到成功，请报告）',
      cause === undefined ? {} : { cause },
    )
    ;(err as { kind?: string }).kind = 'internal'
    ;(err as { hint?: string }).hint = '让同一个 Store 实例上的操作串行执行：不要用 Promise.all 并行调用 upsert/delete/transaction/query/count'
    return err
  }

  /**
   * 在**别的异步链**里下发、还没有交回结果的语句（数量）。
   * ⚠️ 为什么需要它（CodeRabbit/Codex PR#81 第三十二、三十三轮 major，隔离内存 DuckDB 探针复现）：
   * 外部语句在事务内执行期报错后，DuckDB 把事务标成 aborted —— 此后 `COMMIT` 返回成功却丢弃
   * 全部写入（2026-11-18 直连驱动实测：`bad-err → commit-ok → COUNT 0`）。外部语句的错误只
   * reject 给发起它的那条链，所有者看不到；驱动在「执行完、结果交回」之间还有异步点，按
   * 「错误已交回」打记号会漏掉「提交早于交回」的时序。
   * 所以：任一**不是当前事务上下文**下发的语句仍在途时，所有者不提交、直接拿**拒绝**
   * （而不是等「在途语句全清」，那会把普通并发读拖成死等）。
   */
  let foreignInFlight = 0
  /** 在途的外部语句登记：返回「这一次」的解除函数（只减一次）。 */
  const trackForeign = (): (() => void) => {
    foreignInFlight += 1
    let done = false
    return () => {
      if (done) return
      done = true
      foreignInFlight -= 1
    }
  }
  /**
   * 提交，或者**拒绝冒充成功**：还有**别的异步链**的语句在途时（`foreignInFlight`），它的结果
   * （可能正是让本事务 aborted 的那次拒绝）还没交回，此刻 COMMIT 无法证明自己不是「先成功、
   * 后丢写」—— 改成 ROLLBACK 并抛 `internal`，点明成因与「已整体回滚」。
   * ⚠️ 为什么不按「错误已交回」打记号：那样必须等驱动把拒绝交回，而所有者提交恰恰可能发生在
   * 交回之前（CR/Codex 第三十三轮 major 的实测形态）。在途计数在**下发时**就登记，提交时同步可读。
   * 代价如实记录：并发的普通读（`count` 等）也会让同一时刻提交的事务被拒 —— 保守侧，且与
   * Store「同一实例操作串行 await」的契约一致。
   */
  const commitOrRefuse = async (): Promise<void> => {
    if (foreignInFlight === 0) {
      await execSql('COMMIT')
      return
    }
    const why = `事务提交时仍有 ${foreignInFlight} 条其他异步链下发的语句没有交回结果，它执行期报错会把本事务标成 aborted`
    await safeRollback()
    const err = new Error(`事务未提交：${why} —— 该事务可能已被 DuckDB 标成 aborted，`
      + 'COMMIT 可能返回成功却丢弃全部写入，因此已整体回滚')
    ;(err as { kind?: string }).kind = 'internal'
    ;(err as { hint?: string }).hint = '让同一个 Store 实例上的操作串行执行：不要用 Promise.all 并行调用 upsert/delete/transaction/query/count'
    throw err
  }
  const execSql = async (sql: string, params: unknown[] = []): Promise<unknown> => {
    if (closed) throw usage('数据库连接已关闭')
    // ⚠️ **语句等待期间有人开了事务**同样不安全（CodeRabbit PR#81 第二十八轮 major，实测复现：
    // 外部 `SELECT` 与另一条链的事务交错，那条 SELECT 执行期报错 → 事务 COMMIT 返回成功而写入
    // 被丢弃，`count` 从 1 变成 0）。归属检查只覆盖「下发前」；驱动内部 `runUntilLast` /
    // `prepared.run()` 之间的 await 是第二个窗口，用事务代号把它封住。
    const epochBefore = txEpoch
    // ⚠️ **一切语句派发都过归属闸门**（CodeRabbit PR#81 第十六轮 major，实测复现）：单连接
    // 上的语句会加入当前活动事务 —— 包括读语句。别人的事务开着时，另一条链发出的 SELECT
    // 也落在那条事务里；它一旦执行期报错（实测：目标表是 CAST 失败的 view），DuckDB 就把
    // 那条事务标成 aborted：所有者的 COMMIT 返回成功、写入却被静默丢弃。
    // 只守方法入口不够：入口与该语句之间隔着 await（`del` 的 count），窗口仍在。
    assertTxOwnership()
    // 统一走 runAndReadAll：其结果带 getRowObjectsJson/columnNames（run() 的结果没有）
    // 在**别的异步链**的上下文里下发、且此刻不在本事务里 → 登记为在途（见 `foreignInFlight`）。
    const untrack = alsTx.getStore() === undefined ? trackForeign() : () => { /* 事务内语句：所有者自己发、自己会看到 */ }
    let result: unknown
    try {
      result = await c.runAndReadAll(sql, params)
    } catch (e) {
      // ⚠️ **失败路径同样要检查代号**（CodeRabbit PR#81 第二十八轮 major）：驱动报错时
      // `runAndReadAll` 抛出，若只成功路径检查，最危险的情形（外部语句执行期报错 → 把别人的
      // 事务标成 aborted → COMMIT 返回成功而写入被丢弃，实测 count 1→0）恰好漏网。
      // 此时原错误被替换成归因正确的 internal，`cause` 保留驱动原文。
      if (txEpoch !== epochBefore) {
        throw epochChangedError(e)
      }
      throw e
    } finally {
      // 结果（成功或拒绝）都已交回 —— 这条外部语句不再「在途」。
      untrack()
    }
    // 下发期间事务代号变了 → 这条语句可能落进了别人的事务（或它自己在事务里开过又提交过）
    if (txEpoch !== epochBefore) {
      assertTxOwnership()
      throw epochChangedError()
    }
    return result
  }

  const assertTable = (name: string): TableDef => {
    const t = tableByName(name)
    if (!t) throw usage(`未知表：${name}`)
    return t
  }

  /**
   * 事务归属守卫：有事务开着、但**当前异步链不是它的所有者** → 拒绝。
   *
   * ⚠️ 判据覆盖**所有语句**而不只是写：单连接上的读（`query`/`count`/`tables`）同样落进
   * 当前活动事务，它一旦执行期报错就会把那条事务标成 aborted（见 `execSql` 的注释）。
   * 所以文案必须对读也成立 —— 只说"写操作"会把只读调用方引到错误的成因上
   * （CodeRabbit PR#81 第十七轮 minor，实测：`count`/`query` 报出的是"写操作"）。
   * 为什么是 `internal` 而不是 `usage`：这不是调用方参数写错，是本进程内两条异步链
   * 同时用一个 Store 实例 —— 唯一正确的修法是调用方串行化（Store 契约见文件头）。
   */
  const assertTxOwnership = (): void => {
    if (!inTx) return
    if (alsTx.getStore() === txToken) return
    const err = new Error(
      '同一个 Store 实例上有事务未提交时，另一条异步链又发起了语句 —— 已拒绝。'
      + '写会被并入那条事务并随它一起回滚（表现为"写入成功但数据消失"）；'
      + '读同样落在那条事务里，一旦执行期报错就会把它标成 aborted，'
      + '所有者随后的 COMMIT 返回成功而写入被丢弃。'
      + 'Store 的并发契约是"同一实例上的操作必须串行 await"（见 src/store/duckdb.ts 文件头）',
    )
    ;(err as { kind?: string }).kind = 'internal'
    ;(err as { hint?: string }).hint = '让同一个 Store 实例上的操作串行执行：不要用 Promise.all 并行调用 upsert/delete/transaction/query/count'
    throw err
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
    // ⚠️ 同 `del`：前导 count 与 INSERT 前面各判一次归属。`doUpsert` 只在事务内路径被调用
    // （外部 upsert 已在入口被拒），但事务可能在这条计数期间被别的链抢走 —— 派发点那次
    // 才是真正的闸门；计数前这次防的是「计数语句本身落进别人的事务并把它污掉」。
    assertTxOwnership()
    const beforeCount = countDelta ? await store.count(t.name) : 0
    for (let i = 0; i < uniq.length; i += rowsPerStmt) {
      const batch = uniq.slice(i, i + rowsPerStmt)
      const placeholders = batch.map(() => `(${cols.map(() => '?').join(', ')})`).join(', ')
      const params = batch.flatMap((r) => cols.map((k) => r[k] ?? null))
      // ⚠️ 归属检查必须**贴着语句派发**，不能只在 `upsert` 入口判一次（CodeRabbit PR#81）：
      // 入口到这条 INSERT 之间隔着 `beforeCount` 等 await，别的调用方可能正好在这段窗口里
      // 开事务 —— 那时这次 INSERT 会被并入它、随它回滚，又变回"成功却丢数据"。
      assertTxOwnership()
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
    // ⚠️ **关闭必须先于归属**（Codex PR#81 第二十五轮 P3）：事务回调里 `close()` 之后再删，
    // 先判归属会把"连接已关"误诊成"并发竞争"（见 `upsert` 处的同款注释）。
    if (closed) throw usage('数据库连接已关闭')
    // ⚠️ 归属检查必须**先于第一条语句**（CodeRabbit PR#81 第十轮 major，实测复现）：
    // 若只在 `count` 之后判，这条 count 自己就会在别人的事务里执行 —— 而**任何**执行期
    // 错误（实测：目标表被换成 CAST 失败的 view 时的 Conversion Error）都会把那条事务
    // 标成 aborted：对方的 COMMIT 返回成功，写入却被静默丢弃（实测行数归零、无报错）。
    // 所以外部写在这里就被拒，一条语句都不发。
    assertTxOwnership()
    const before = await store.count(tname)
    // 派发点再判一次（CodeRabbit PR#81 major）：`count` 是 await，期间别的调用方可能开事务，
    // 随后这条 DELETE 就被并进去。
    assertTxOwnership()
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
   * 在令牌上下文里 ROLLBACK。⚠️ **关闭后不得进入上下文**（CodeRabbit PR#81 第十九轮 minor）：
   * `close()` 已把 ALS `disable()` 掉，而 `alsTx.run()` 会把它**重新启用**、失败路径又不再
   * disable —— 「事务进行中被 close」每次都在攒一个启用态上下文。`execSql` 在这种情况下
   * 本来也必然抛「连接已关闭」，回滚必然失败，所以直接跳过。
   */
  const rollbackInTx = async (token: TxToken): Promise<void> => {
    if (closed) return
    await alsTx.run(token, () => safeRollback())
  }

  /**
   * 他人库指纹（`init` 专用）：命中返回成因文案，否则 null。
   *
   * ⚠️ **只认「我们绝不可能产出」的形态**（2026-11-14，历史审查 PR#4 复核实测）：
   * ① `schema_version` 没有 `version` 列 —— 我们的迁移第一版就建了它；
   * ② 有表但 `schema_version` **一行都没有** —— 我们的每次迁移都插一行，留下的库至少有一条；
   * ③ 记录的最大版本**超过本 CLI 已知的最新迁移** —— 我们从未写过这个号；
   * ④ `schema_version` **不是一个基表**（view 等）—— 我们只会建表，且求值外来 view 有副作用。
   * ⚠️ **不要**改回「声明表出现声明外的列就拒绝」（首版这么写，全量回归当场抓到）：
   * 多列/少列是**既有契约里的 schema 漂移**（`db tables` 只警告不失败、README 明写），
   * 一条手工 `ALTER TABLE … ADD COLUMN` 会被误判成他人库，`store init` 直接不可用。
   * 代价如实记录：一条**版本号恰好落在我们范围内**的外来库仍可能被当成「旧版 CLI 建的库」，
   * 那时 init 不建表、只按 `storeTablesWarnings` 点名缺表 —— 不会往里写业务数据。
   */
  const detectForeignStore = async (): Promise<string | null> => {
    // ⚠️ 先看**对象类型**再谈内容（CodeRabbit PR#74 第五轮）：`information_schema.tables` 把
    // view 也算作表，下面那条 `MAX(version)` 会把 view 本体当查询执行 —— 一条
    // `CREATE VIEW schema_version AS SELECT CAST('x' AS INTEGER)` 就能让 init 报
    // Conversion Error（internal），既绕开「他人库」归类，也违背「是 view 就不求值」的说法。
    // 本 CLI 从不把 schema_version 建成 view，所以「不是基表」本身就是他人库指纹。
    // ⚠️ 同上按大小写不敏感取（`"SCHEMA_VERSION"` view 同样会被下面那条按小写名的查询执行）。
    const kindRes = await store.execSql(
      "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main'")
    const svKind = objectKinds((kindRes as { getRowObjectsJson: () => Record<string, unknown>[] })
      .getRowObjectsJson()).find((o) => sameObjectName(o.name, 'schema_version'))
    if (svKind !== undefined && !isBaseTable(svKind)) {
      return `目标数据库不是本 CLI 创建的（schema_version 不是基表，实际是 ${svKind.type || '未知对象'}）：${cfg.path}`
    }
    const r = await store.execSql(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = 'main'")
    const cols = new Map<string, string[]>()
    for (const row of (r as { getRowObjectsJson: () => Record<string, unknown>[] }).getRowObjectsJson()) {
      // ⚠️ 表名键按大小写不敏感取的规则（Codex PR#76 第三轮）：库里的 `"SCHEMA_VERSION"`
      // 表也要取到它自己的列，否则被误判成「缺少 version 列」。列名折叠同一规则。
      const t = String(row.table_name).replace(/[A-Z]/g, (c) => c.toLowerCase())
      const list = cols.get(t) ?? []
      list.push(String(row.column_name))
      cols.set(t, list)
    }
    const svCols = cols.get('schema_version') ?? []
    if (!svCols.some((c) => sameObjectName(c, 'version'))) {
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
      const existing = await store.execSql(`SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main'`)
      const kinds = objectKinds((existing as { getRowObjectsJson: () => Record<string, unknown>[] })
        .getRowObjectsJson())
      const names = kinds.map((k) => k.name)
      // ⚠️ 存在性与类型都按大小写不敏感判（Codex PR#76）：DuckDB 标识符大小写不敏感，
      // 一条 `"SCHEMA_VERSION"` view 会被下面的 `MAX(version)` 按小写名执行。
      const svKind = kinds.find((k) => sameObjectName(k.name, 'schema_version'))
      if (names.length > 0 && svKind === undefined) {
        // ⚠️ 他人库 → store_not_initialized、退出码 1（spec §8.2 成因 6）——不是 usage。
        const err = new Error(`目标数据库不是本 CLI 创建的（含表 ${names.join(', ')}）：${cfg.path}`)
        ;(err as { kind?: string }).kind = 'store_not_initialized'
        ;(err as { hint?: string }).hint = '目标数据库不是本 CLI 创建的，请换 --db 路径'
        throw err
      }
      // ⚠️ 「有 schema_version」不是身份证明（2026-11-14，历史审查 PR#4 复核）：实测造一个
      // `{secret 表, schema_version(version INTEGER) 空表}` 的外来库，init 直接报 ok 并往里
      // 建表。指纹判据见 `detectForeignStore` 的注释（三条「我们不可能产出」的形态）。
      if (svKind !== undefined) {
        const foreign = await detectForeignStore()
        if (foreign !== null) {
          const err = new Error(foreign)
          ;(err as { kind?: string }).kind = 'store_not_initialized'
          ;(err as { hint?: string }).hint = '目标数据库不是本 CLI 创建的，请换 --db 路径'
          throw err
        }
      }
      const cur = svKind !== undefined
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
      // ⚠️ 返回**声明的名字**（Codex PR#76 第四轮实测）：DuckDB 标识符大小写不敏感，
      // `"SCHEMA_VERSION"` 与 `schema_version` 是同一个对象；调用方（store status/init、
      // sync）拿这些名字去 `assertTable`（按声明名查）并比对声明集 —— 原样返回大写名会让
      // `store status` 在 `count('SCHEMA_VERSION')` 上抛 usage（实测退出码 2），
      // 并把它同时报成「声明有而库中无」与「库中有而声明无」。未声明的对象原样返回。
      const r = await store.execSql(`SELECT table_name FROM information_schema.tables WHERE table_schema = 'main'`)
      return (r as { getRowObjectsJson: () => Record<string, unknown>[] }).getRowObjectsJson()
        .map((x) => tableByName(String(x.table_name))?.name ?? String(x.table_name)).sort()
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
      // ⚠️ **关闭必须先于归属**：事务回调里 `close()` 之后再写，`inTx` 尚未复位 —— 先判归属
      // 会把它误诊成"并发竞争"（internal + 串行化提示），而真实原因是连接已经关了，正确
      // 分类是 `usage`（Codex PR#81 第二十五轮 P3，实测：`count` 走 `execSql` 报 usage，
      // `upsert`/`delete` 报 internal —— 同一个 Store 上两种说法）。
      if (closed) throw usage('数据库连接已关闭')
      // ⚠️ `inTx` 的语义是「本实例上有事务开着」，不等于「调用者在那个事务里」——
      // 归属必须由 `assertTxOwnership` 判（历史审查 PR#4 复核）。
      // 入口这一处只做**快速失败**（省掉开自己那条事务的功夫）；真正的判定在
      // `doUpsert` 贴着 INSERT 的那次 —— 见那里的注释。
      if (inTx) {
        assertTxOwnership()
        return doUpsert(t, rows)
      }
      // ⚠️ 自动事务也**登记归属**（CodeRabbit PR#81 第八轮 major）：只打 BEGIN 不置 `inTx`
      // 时，另有调用方在此期间 `transaction()`，它的 BEGIN 会撞上「事务已开」而失败 ——
      // 那条失败路径若再 ROLLBACK，就会把**这里的**活动事务回滚掉，之后的批次落在事务外、
      // 最终 COMMIT 失败留下部分写入。登记后用单一令牌管住：同一实例上事实并存两种事务
      // 从根上不存在（并发的第二次写会在 `assertTxOwnership` 被拒，且它自己的 BEGIN 不会
      // 发出、也就没有任何人会回滚别人的事务）。
      // 登记与整个（同步段 + 后续批次）放在同一个异步上下文里：`doUpsert` 内部贴着 INSERT
      // 的 `assertTxOwnership` 要有令牌才认得出「这是自己那条自动事务」。
      const token = Symbol('store-auto-tx')
      inTx = true
      txToken = token
      txEpoch += 1
      let n: number
      try {
        // ⚠️ BEGIN / 数据语句 / COMMIT 全在**带令牌的上下文**里（闸门下移到 `execSql` 之后，
        // 事务控制语句也要过它，见那里的注释）；`doUpsert` 内部贴着 INSERT 的归属检查同样
        // 靠这个上下文认出「这是自己那条自动事务」。
        n = await alsTx.run(token, async () => {
          await execSql('BEGIN')
          const written = await doUpsert(t, rows)
          await commitOrRefuse()
          return written
        })
      } catch (e) {
        await rollbackInTx(token)
        throw e
      } finally {
        inTx = false
        txToken = undefined
      }
      return n
    },
    delete: del,
    async transaction<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T> {
      // ⚠️ `closed` 必须先于**任何** ALS 使用（Codex PR#81 第十八轮 P2，实测确认）：
      // `alsTx.run()` 会把 `close()` 里 disable 过的实例**重新启用**（Node 的全局 storageList
      // 强引用它），而这条失败路径不会再 disable —— 迟到的 `transaction()` 每次都在攒一个
      // 启用态上下文。`upsert()` 本来就是这么防的，这里对齐。
      if (closed) throw usage('数据库连接已关闭')
      // ⚠️ 用异步上下文区分两种「事务已开」（CodeRabbit PR#81 第十七轮 minor，实测复现）：
      //   · 调用方**就在所有者上下文里**（`fn` 里的 `tx.transaction`，令牌一致）→ 真嵌套，usage；
      //   · 调用方是**另一条异步链**（令牌不一致）→ 并发竞争，internal。
      // 原先只对「自动事务被撞」分开报，显式事务被撞时一律落到
      // `usage('不得嵌套事务')` —— 实测竞争方拿到退出码 2 的「参数写错」信号，且没有串行化提示。
      // 令牌现在一律是 `symbol`：区分依据是**异步上下文里的令牌是否相等**，不是令牌类型。
      const owns = inTx && alsTx.getStore() === txToken
      if (inTx && !owns) {
        throw Object.assign(new Error('本实例上有一条事务尚未提交，此时另一条异步链不能开始新事务 —— '
          + '请让同一 Store 实例上的操作串行 await'), {
          kind: 'internal',
          hint: '让同一个 Store 实例上的操作串行执行：不要用 Promise.all 并行调用 upsert/delete/transaction/query/count',
        })
      }
      if (owns) throw usage('不得嵌套事务')
      // ⚠️ 归属登记必须**先于** `BEGIN` 的 await（CodeRabbit PR#81 第七轮 major）：原先
      // `inTx` 在 BEGIN 落定之后才置位，BEGIN 这条 await 期间它的外部写会被放行，随后的
      // 语句排进本事务、回滚时静默消失（实测：BEGIN 挂住时外部 delete 返回成功、行没了）。
      const token = Symbol('store-tx')
      inTx = true
      txToken = token
      txEpoch += 1
      try {
        // ⚠️ BEGIN **失败也要发 ROLLBACK**（2026-11-16 实测裁定，拒绝 CodeRabbit 第八轮的建议）：
        // 手开事务存在时嵌套 BEGIN 会被 DuckDB 拒绝，**而它同时已把那条事务标记为 aborted**
        // —— 数据在任何后续动作之前就已经废了。此时两种收尾的差别只在「失败是否可见」：
        //   · 发 ROLLBACK：连接恢复干净，之后调用方的 COMMIT 报 `no transaction is active`
        //     （**响亮**地告诉它事务没了）—— 实测正是如此；
        //   · 不发 ROLLBACK：调用方的 COMMIT 返回成功，但 DuckDB 静默丢弃该事务的全部写入
        //     （实测：行数归零、无任何报错）—— 这才是"部分写入 + 静默丢数据"。
        // 所以这里保留 ROLLBACK；`safeRollback` 吞掉「根本没有事务」的次生错误。
        // aborted 的事务同样可被 ROLLBACK 收尾（DuckDB），外部语句污掉它的情形效果一致。
        // 真正要堵的是「BEGIN 根本不该发出」：自动事务已登记归属（见 `upsert`）、显式事务
        // 在 BEGIN 前登记 —— 支持路径上不会再出现第二条 BEGIN（用例见 duckdb.test 的两条）。
        // ⚠️ BEGIN / 回调 / COMMIT 全部在**带令牌的上下文**里：闸门在 `execSql`（事务控制
        // 语句也要过它），回调里的 `tx.upsert`/`tx.delete` 也靠这个上下文认得出
        // "这是事务内的写"（CodeRabbit PR#81 第十六轮）。
        return await alsTx.run(token, async () => {
          await execSql('BEGIN')
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
          await commitOrRefuse()
          return r
        })
      } catch (e) {
        // ROLLBACK 也走 `execSql`：在令牌上下文里发，闸门才认得它属于本事务（若 BEGIN 都没
        // 成功，`safeRollback` 吞掉「没有事务」的次生错误）。
        await rollbackInTx(token)
        throw e
      } finally {
        inTx = false
        txToken = undefined
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
      // ⚠️ 事务归属的 ALS 必须显式 `disable()`（Codex PR#81 P2，实测确认）：执行过
      // `run()` 的实例会被 Node 的全局 `storageList` **强引用**，只关 DuckDB 不关它，
      // 反复「建 Store → 跑事务 → 关」的进程/测试会把实例一直攒着（本地 async_hooks
      // 后端实测：关掉 40 个 Store 后仍有 40 个 ALS 处于启用态），并拖慢之后每个异步资源
      // 的传播。`disable()` 幂等，包 try 防老运行时不支持。
      try { alsTx.disable() } catch { /* 不支持 disable 的运行时：忽略 */ }
    },
  } as unknown as Store & { execSql: typeof execSql }
  // ⚠️ 挂载契约见上方 execSql 注释：不可枚举 + writable + configurable（缺 configurable
  // 会让 vi.spyOn 重定义时抛 TypeError）；数据语句一律 store.execSql(...)（属性调用时
  // 查找），事务控制语句闭包直调（双轨，见上方契约①）。
  Object.defineProperty(store, 'execSql', { value: execSql, enumerable: false, writable: true, configurable: true })
  return store
}
