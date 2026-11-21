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
  /**
   * 事务收尾等待在途语句的上限（默认 5s）与中断后的宽限（默认 5s）。仅测试注入 ——
   * 让「超时 → 中断 → 交回 / 仍不交回」两条路径能在毫秒级跑完，而不是真等 10 秒。
   */
  drainCapMs?: number
  drainInterruptGraceMs?: number
  /**
   * `ROLLBACK` 自身允许挂住的时长（默认 5s）。⚠️ 与上面两个预算**分开**：它们只覆盖
   * 「等本事务的在途语句交回」，不覆盖收尾自己那条 ROLLBACK（CR 第四十一轮 major）——
   * 驱动卡在 ROLLBACK 上时，sync run / store init 会永久挂住，连「回滚未能确认」都说不出口。
   */
  rollbackCapMs?: number
  /**
   * 事务结束后按令牌键控的状态快照（**仅测试缝**）：`brokenTx` / `beganTx` / `txInFlight` /
   * `txWrites` / `drainWaiters` 都是普通 Map/Set，键是令牌对象 —— 失败路径上漏删一项，
   * 那个令牌与它携带的错误原因就被永久强引用（长跑进程里按失败次数无界增长）。
   * 这条缝让「事务结束后一律为 0」可以被断言（Codex PR#81 第四十三轮 P2）。
   */
  txStateProbe?: (snapshot: Record<'brokenTx' | 'beganTx' | 'txInFlight' | 'txWrites' | 'drainWaiters', number>) => void
}

/**
 * `e instanceof Error` 的安全形态（CR 第五十六轮 major）：**已撤销的 Proxy** 上 `instanceof`
 * 会抛 TypeError（HasInstance 走 [[GetPrototypeOf]]）—— 错误路径上的类型判据不得自己成为新的
 * 主失败。撤销后的 Proxy 一律当「非 Error」，原值仍挂在 `cause`。
 */
function isErrorValue(e: unknown): e is Error {
  try { return e instanceof Error } catch { return false }
}
/** 依赖缺失 → store_not_initialized（按缺失 specifier 前缀二分 hint，spec §5.1）。 */
function depError(e: unknown): Error {
  const mn = isModuleNotFound(e)
  const err = new Error(`无法加载 DuckDB 依赖：${isErrorValue(e) ? e.message : safeValueText(e, 400)}`)
  ;(err as { kind?: string }).kind = 'store_not_initialized'
  ;(err as { hint?: string }).hint = mn && mn.missing.startsWith('@duckdb/node-bindings')
    ? '当前平台无 DuckDB 预编译包（无 node-gyp 回退）。请在受支持的平台上安装 @duckdb/node-api@1.5.6-r.1'
    : '未安装 DuckDB 依赖。请在 qiyu-cli 的安装环境中运行：npm install @duckdb/node-api@1.5.6-r.1'
  return err
}

/** 把任意拒绝值转成**截断的**文本；转换本身抛（无原型对象等）时交回占位说明。
 *  错误路径上的所有「值转文本」都走它 —— 补话/诊断不得自己成为新的主失败。 */
function safeValueText(v: unknown, max: number): string {
  try {
    return String(v).slice(0, max)
  } catch {
    return `（无法转成文本的拒绝值，typeof=${typeof v}）`
  }
}
/**
 * 安全读取拒绝值上的 `kind`（CR 第六十六轮 major 的反向判据）：拒绝值可能是 `null` /
 * 无原型对象 / 访问器抛异常的对象 —— 判据自己抛错就会把原始失败换掉。读不出来一律 undefined。
 */
function safeKindOf(v: unknown): string | undefined {
  if (v === null || (typeof v !== 'object' && typeof v !== 'function')) return undefined
  try {
    const k = (v as { kind?: unknown }).kind
    return typeof k === 'string' ? k : undefined
  } catch {
    return undefined
  }
}
/**
 * 拒绝值 → 截断文本，**先安全地取 message**：`message` 是抛异常的访问器时，`String(e)` 之前
 * 的求值不能发生在 try 外面（CR 第五十五轮 major：求值一抛，状态标记就落不下去）。
 */
function safeMessageText(v: unknown, max: number): string {
  try {
    return String(isErrorValue(v) ? v.message : v).slice(0, max)
  } catch {
    return `（无法转成文本的拒绝值，typeof=${typeof v}）`
  }
}
/**
 * 派发前被**本地关闭判据**拒绝的 usage 错误（身份集合）。COMMIT 的归因据此区分「根本没下发」
 * 与「驱动拒绝」—— 不读拒绝值的 `kind`（访问器可抛，驱动对象也可能伪造该字段，CR 第五十五轮 major）。
 */
const closedBeforeDispatch = new WeakSet<object>()
/** usage 错误（退出码 2）：带 kind 供命令层经 thrownToExit 归 usageFail 双通道。 */
function usage(msg: string): Error {
  const e = new Error(msg)
  ;(e as { kind?: string }).kind = 'usage'
  return e
}

/**
 * 事务令牌：每次事务一个对象，`transaction()` 与自动事务（upsert 自开的）都一样。
 * 调用方属于哪条事务**只看异步上下文里的令牌是否相等** —— 自动事务与显式事务的区分
 * 不需要令牌“类型”来标，用 `instanceof` 标类型的写法曾让「另一条链的 transaction()」
 * 漏判成 `usage`（见 `transaction()` 的注释，CodeRabbit PR#81 第十七轮）。
 * ⚠️ 令牌是对象而不是 symbol，并自带 `ended`（CR 第三十八轮 major）：事务结束只是把标志
 * 置位，**令牌本身随异步上下文存活多久都有效** —— 用「全局已结束令牌集合」的话，FIFO 淘汰
 * 之后极老上下文里的语句又能通过检查（用例：连开 70 条事务后，第 1 条事务残留的定时器
 * 仍必须被拒）。
 */
type TxToken = { ended: boolean }

/**
 * 事务归属的异步上下文。⚠️ 必须**每个 Store 实例一份**（在 `createDuckDbStore` 内建），
 * 否则同一进程里两个实例的事务令牌会互相干扰。
 */
type TxAls = AsyncLocalStorage<TxToken>

export async function createDuckDbStore(cfg: StoreConfig, mode: StoreMode, deps: DuckDbDeps = {}): Promise<Store> {
  let mod: {
    DuckDBInstance: { create: (p: string, o?: unknown) => Promise<unknown> }
    /** 语句类型的枚举（`TRANSACTION = 10`，实测）；注入的假模块可能不带它。 */
    StatementType?: Record<string, unknown>
  }
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
  // `extractStatements` 在**原型**上（不在自有属性里）：测试里包一层的导入缝若要让它可见，
  // 必须显式转发（`...(conn as object)` 展开拿不到原型方法，见 `parseStatementCount` 的报错）。
  const c = conn as {
    run: (sql: string, params?: unknown[]) => Promise<unknown>
    runAndReadAll: (sql: string, params?: unknown[]) => Promise<{
      getRowObjectsJson: () => Record<string, unknown>[]
      columnNames: () => string[]
    }>
    extractStatements?: (sql: string) => Promise<{
      count: number
      prepare: (i: number) => Promise<{ statementType: number; destroySync?: () => void }>
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
   * 事务「代号」：只用于**防御性**断言（CR 第二十八轮引入，第三十八轮后按设计不可达）。
   * ⚠️ 当前设计的不变量（CR 第三十八轮收口）：**BEGIN 只在连接上没有任何在途语句时发出**
   * （`admitBegin` 检查 `foreignInFlight`），事务期间任何外部语句在下发前就被 `assertTxOwnership`
   * 拒绝 —— 因此「外部语句在事务执行期落进来」在支持路径上不可能发生。代号检查保留为
   * 内部不变量的兜底：若未来某条路径绕开了准入，它会以 `internal` 响亮失败而不是静默丢写。
   */
  let txEpoch = 0
  const alsTx: Pick<TxAls, 'run' | 'getStore' | 'disable'> = deps.makeAls?.() ?? new AsyncLocalStorage<TxToken>()

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
  /**
   * 进行中的**多语句写操作**：事务外的 `delete`（count → DELETE → count）与事务外的 `upsert`
   * 自动事务。⚠️ 为什么 BEGIN 必须等它们（CR 第三十七轮 major）：单连接上的语句会按**实际执行**
   * 顺序进入当时开着的事务。写操作的两步之间若插进一条 BEGIN，DELETE 的实际执行可能早于 BEGIN
   * （autocommit 已提交）而结果晚于 BEGIN 才交回 —— 调用方拿到「跨代」的失败，行却真的删了；
   * 重试还会报「删了 0 行」。所以 BEGIN 前要求写操作全部落定（本操作自己除外）。
   * 代价如实记录：写操作与事务并发发起会被拒（internal）—— Store 本契约就是同一实例串行 await。
   */
  const writeOpsInFlight = new Set<symbol>()
  const enterWriteOp = (): symbol => {
    const t = Symbol('write-op')
    writeOpsInFlight.add(t)
    return t
  }
  const leaveWriteOp = (t: symbol): void => { writeOpsInFlight.delete(t) }
  const admitBegin = (self?: symbol): void => {
    // ⚠️ **任何在途语句都会让 BEGIN 不安全**（CR 第三十八轮 major）：驱动里已接收、尚未执行的
    // 原始 SQL（`query`）无法静态判定是读还是写；它可能在 BEGIN 之后才执行（落进新事务）或在
    // ROLLBACK / COMMIT 之后才执行（在 autocommit 里落库）。能确定的是：**只要它还没交回结果，
    // 开启事务就不安全**。所以 BEGIN 要求连接上没有任何在途语句（本操作自身的语句除外，
    // 自动事务登记写操作时它的语句还没有下发）。
    if (foreignInFlight > 0) {
      const err = new Error(`另一条异步链上的 ${foreignInFlight} 条语句还没有交回结果（可能仍在驱动里）：`
        + '此时开启事务会与它交错 —— 它若在 BEGIN 之后执行会落进本事务，在回滚/提交之后执行则会在 '
        + 'autocommit 里落库，而调用方拿到的是失败')
      ;(err as { kind?: string }).kind = 'internal'
      ;(err as { hint?: string }).hint = '让同一个 Store 实例上的操作串行 await：不要用 Promise.all 并行调用 upsert/delete/transaction/query/count'
      throw err
    }
    for (const op of writeOpsInFlight) {
      if (op === self) continue
      const err = new Error('另一条异步链上的写操作还没有完成（它的语句可能仍在驱动里）：'
        + '此时开启事务会与它交错 —— 它拿到的「删改了几行」将不可信')
      ;(err as { kind?: string }).kind = 'internal'
      ;(err as { hint?: string }).hint = '让同一个 Store 实例上的操作串行 await：不要用 Promise.all 并行调用 upsert/delete/transaction/query/count'
      throw err
    }
  }
  /**
   * 受影响的事务（令牌）与成因：外部语句**执行期报错**（跨代）或**交回时报错且期间跨代**。
   * 与在途计数互补（CR 第三十四轮 major）：计数在结果交回时归零，若错误交回早于所有者提交，
   * 提交那一刻计数已为 0 —— 只靠计数会放行（用例「外部语句的错误先交回、所有者随后才提交」钉住）。
   */
  const brokenTx = new Map<TxToken, string>()
  /**
   * **所有者自己**下发、还没交回结果的语句（按令牌计数）。外部语句有 `foreignInFlight`，
   * 但所有者那条不计数（它归自己看得到）—— 若调用方**没有 await** 事务回调里的写就返回，
   * 提交时这条语句仍在驱动里，可能落进随后开启的事务并被别人提交（CR 第三十六轮 major）。
   */
  const txInFlight = new Map<TxToken, number>()
  /**
   * 本令牌下**还没完成**的写操作（多批次 upsert / 多语句 delete）。⚠️ 为什么不能只数语句
   * （CR 第三十九轮 major #2）：多批次写两条语句之间 `txInFlight` 会瞬间归零 —— 回调没 await 它
   * 时，`commitOrRefuse` 可能恰好在「上一批已交回、下一批还没下发」的窗口里看到零并 COMMIT，
   * 事务报成功、第二批随后被拒（只有部分行落库）。写操作在整个生命周期内登记。
   */
  const txWrites = new Map<TxToken, number>()
  const trackWrite = (token: TxToken): (() => void) => {
    txWrites.set(token, (txWrites.get(token) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const rest = (txWrites.get(token) ?? 1) - 1
      if (rest <= 0) txWrites.delete(token)
      else txWrites.set(token, rest)
    }
  }
  /** 等在途的本事务语句落定（计数归零）时唤醒 `drainOwned`。 */
  const drainWaiters = new Map<TxToken, Array<() => void>>()
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
  /** 事务内语句的在途登记（与 `trackForeign` 同款「只减一次」语义）。 */
  const trackOwn = (token: TxToken): (() => void) => {
    txInFlight.set(token, (txInFlight.get(token) ?? 0) + 1)
    let done = false
    return () => {
      if (done) return
      done = true
      const rest = (txInFlight.get(token) ?? 1) - 1
      if (rest <= 0) {
        txInFlight.delete(token)
        const waiters = drainWaiters.get(token)
        if (waiters !== undefined) {
          drainWaiters.delete(token)
          for (const w of waiters) w()
        }
      } else {
        txInFlight.set(token, rest)
      }
    }
  }
  /**
   * 事务收尾前把**本事务自己**已下发的语句等回来（CR 第三十七轮 major #1）。
   * ⚠️ 顺序不能反过来：先发 ROLLBACK 的话，驱动里那条还没执行完的语句会在事务结束后（autocommit）
   * 执行 —— 本该被回滚的写入真的落库，而调用方看到的是「已整体回滚」。
   * 返回 false = 超时仍无法确认（调用方必须退役连接，且**不得**再发 ROLLBACK，见 `closeTx`）。
   * 上限 5s：正常语句是毫秒级；真的有语句卡死时不值得把调用方一直挂住。
   *
   * ⚠️ **超时先 `interrupt()` 再放弃**（CR 第三十九轮 major #3，直连驱动实测 2026-11-19）：
   * 5s 内没交回通常是语句**真的还在原生执行**（实测 `INSERT … range(30000000000)` 超过 5s）。
   * 此时直接放弃、靠用户 close 重建是**不安全的**：`closeSync()` 不取消原生任务 —— 实测关连接
   * 与关实例各 0ms 返回，但进程**再也不会自行退出**（CPU 0%、内存不涨，不是繁忙而是原生线程
   * 被自身的查询卡住），只能被 kill。`interrupt()` 后语句以 `INTERRUPT Error: Interrupted!`
   * 交回、回滚照常确认、未提交写入不落库、同一路径重建成功、进程正常退出（同一探针实测）。
   * 所以：到点先 `interrupt()`，再给有界窗口（`DRAIN_INTERRUPT_GRACE_MS`）等它交回；
   * 等不到时清单里**一句都不剩**才返回 false —— 调用方照旧退役连接。
   */
  const DRAIN_CAP_MS = deps.drainCapMs ?? 5_000
  const DRAIN_INTERRUPT_GRACE_MS = deps.drainInterruptGraceMs ?? 5_000
  /**
   * 事务收尾的**独立**等待预算（默认 5s）：drain 的两个截止时刻只覆盖「等在途语句交回」，
   * 不覆盖 ROLLBACK 自身 —— 驱动卡在那条 ROLLBACK 上时，sync run / store init 会永久挂住，
   * 连「回滚未能确认」都说不出口（CR 第四十一轮 major）。
   */
  const ROLLBACK_CAP_MS = deps.rollbackCapMs ?? 5_000
  /** 等待计数归零；超过 deadline 返回 false。 */
  const waitDrained = async (token: TxToken, deadline: number): Promise<boolean> => {
    while ((txInFlight.get(token) ?? 0) > 0) {
      // ⚠️ **用单调时钟**（CR 第五十四轮 major）：`Date.now()` 会被系统时钟调整（NTP 步进）
      // 往回/往前跳，让 5s 的收尾预算提前或延后；`performance.now()` 单调，只随真实流逝走。
      const left = deadline - performance.now()
      if (left <= 0) return false
      await new Promise<void>((resolve) => {
        const waiters = drainWaiters.get(token) ?? []
        waiters.push(resolve)
        drainWaiters.set(token, waiters)
        // 兜底唤醒：计数异常时也不能无限等（上面的 while 会再判一次）。超时前把自己从名单里
        // 摘掉 —— 退役连接上的名单不该攒着已经没人等的闭包。
        setTimeout(() => {
          const list = drainWaiters.get(token)
          if (list !== undefined) {
            const i = list.indexOf(resolve)
            if (i >= 0) list.splice(i, 1)
            if (list.length === 0) drainWaiters.delete(token)
          }
          resolve()
        }, Math.min(left, 250))
      })
    }
    return true
  }
  const drainOwned = async (token: TxToken): Promise<boolean> => {
    if (await waitDrained(token, performance.now() + DRAIN_CAP_MS)) return true
    // 语句在原生执行里卡着：中断是唯一不靠 kill 的出路（见上方实测）。
    // ⚠️ 这里只可能中断到**本事务的**语句：事务开着期间，别的异步链的语句在
    // `assertTxOwnership` 就被拒、根本进不了驱动（`foreignInFlight` 必为 0）。
    try { (c as { interrupt?: () => void }).interrupt?.() } catch { /* 中断失败照旧走退役路径 */ }
    if (await waitDrained(token, performance.now() + DRAIN_INTERRUPT_GRACE_MS)) return true
    // ⚠️ **放弃前再中断一次**（CR 第四十三轮 major 的追问）：驱动在准备/初始化阶段会清掉
    // 中断标志，一次 interrupt 可能落在「这条语句还没进入原生执行」的时刻 —— 之后它照样
    // 开始跑，而我们这一侧已经给不出结论。此时已经退役令牌，剩余在途全是**本事务的**语句，
    // 补一发中断没有归属风险，且子进程实测（2026-11-20）：interrupt 让卡住的语句以
    // `INTERRUPT Error` 交回后，进程不再被原生线程占住、可正常退出（仅 close 则 15s 不退）。
    // 不在这里再等：调用方已按「回滚未能确认」退役，结论不再依赖它是否真的停下。
    try { (c as { interrupt?: () => void }).interrupt?.() } catch { /* 同上 */ }
    return false
  }
  /**
   * 事务结束（提交 / 回滚 / 拒绝）时把令牌的 `ended` 置位。令牌是对象、由异步上下文持有，
   * 因此**判定永远有效**、不依赖全局集合的保留策略（CR 第三十八轮 major：全局集合 FIFO 淘汰
   * 之后，极老上下文里的语句又能通过检查）。
   */
  const retire = (token: TxToken): void => { token.ended = true }
  const newTxToken = (): TxToken => ({ ended: false })
  const txEndedError = (): Error => {
    const err = new Error('该语句所属的事务已经结束（提交 / 回滚 / 拒绝）：它的结果与副作用都不可信，已拒绝。'
      + '不要在事务回调里下发不 await 的语句，也不要把事务里的 Promise 存到事务外再 await')
    ;(err as { kind?: string }).kind = 'internal'
    ;(err as { hint?: string }).hint = 'await 事务回调里的每一次调用，并让同一个 Store 实例上的操作串行执行'
    return err
  }
  /** BEGIN 已**成功返回**的令牌：据此区分「ROLLBACK 失败时有事务可能仍开着」与「BEGIN 本来就没成」。 */
  const beganTx = new Set<TxToken>()
  /**
   * 连接退役（CR 第三十七轮 major #4）：ROLLBACK 无法确认时，DuckDB 的事务状态未知 ——
   * 继续下发语句有可能落进一条还开着的事务。此时**不发 ROLLBACK**（在途语句可能随后在
   * autocommit 里执行）、拒绝一切后续语句；事务由 `close()` 关闭连接时隐式结束。
   */
  let poisoned: { reason: string; hint?: string } | undefined
  // 事务失效性探针超时、中断后仍未交回 —— closeTx 据此跳过 ROLLBACK（Codex 第十二轮 P2）。
  let nativeProbeStuck = false
  // ⚠️ **「超时那一刻在途」≠「收尾时仍占用连接」**（CR 第六十六轮 major）：探针可能在我们
  // 放弃等待之后、回调返回之前自己交回 —— 只看 stuck 会为了一个已经结束的探针跳过 ROLLBACK
  // 并错误退役。记账以**收尾时刻**为准：原始 promise 一落定就把这里翻成 true。
  let nativeProbeSettled = true
  /**
   * `hint` 只在成因的恢复动作与通用说法**不同**时才给（CR 第四十一轮 major）：COMMIT
   * 结果未知时写入可能已落库，「关掉重建后直接重试」就是重复写，通用的
   * 「未提交的写入不会落库」在这里是假话 —— 恢复动作用该成因自己的。
   */
  const poison = (reason: string, hint?: string): void => {
    if (poisoned === undefined) poisoned = { reason, hint }
  }
  const poisonedError = (p: { reason: string; hint?: string }): Error => {
    const reason = p.reason
    const err = new Error(`Store 已退役：${reason} —— 单连接的事务状态无法确认，`
      + '任何后续语句都可能落进一条未结束的事务。请关闭该 Store 实例并重新创建后再试'
      + '（本实例上的写入结果不可信）')
    ;(err as { kind?: string }).kind = 'internal'
    // 稳定判据（供编排层判断「该实例上任何语句都会被拒」）：文案随成因变化，code 不变。
    ;(err as { code?: string }).code = 'store_retired'
    // ⚠️ 默认 hint **不得声称「未提交的写入不会落库」**（Codex PR#81 第四十五轮 P2）：这条
    // 默认文案服务于「回滚未能确认」的成因，而那个状态的准确含义就是「落没落库无法确认」——
    // 照默认文案直接重放可能重复写。恢复动作统一为「关闭 → 重建 → 核对 → 再决定」。
    ;(err as { hint?: string }).hint = p.hint
      ?? 'close 该 Store 并重建实例，先核对数据（本事务的写入是否落库）再决定是否重放；'
        + '若进程随后仍不退出，说明那条语句卡在不可中断的原生点上，只能结束进程'
    return err
  }
  /**
   * `commitOrRefuse` 抛出的拒绝错误（回滚已由它负责）。
   * ⚠️ 用**身份集合**而不是往错误对象上挂字段（CR 第三十七轮 major #2）：回调可以拒绝
   * `undefined` / `null`（读属性直接 TypeError，原错误被吞掉），别人也能在自己的错误对象上
   * 伪造同名标记让回滚被跳过。集合只收我们亲手抛出的那个对象。
   */
  const refusals = new WeakMap<object, TxToken>()
  // ⚠️ 按**令牌**归属（CR 第三十八轮 major）：A 的拒绝对象被调用方接住、在 B 的回调里原样
  // 抛出时，只按身份匹配会让 B 跳过回滚 —— 而回滚已由 A 负责，B 的事务还开着。
  /**
   * 令牌生命周期的**唯一收口点**：事务结束（提交 / 拒绝 / 回调抛错 / 收尾失败）时把该令牌
   * 从全部按令牌键控的集合里删掉。⚠️ 曾只在 `commitOrRefuse` 的成功/拒绝路径里删 —— 回调抛错
   * 走 `rollbackInTx` 时 `brokenTx` / `beganTx` / 计数全都不删，令牌与错误原因被永久强引用
   * （Codex PR#81 第四十三轮 P2；`txStateProbe` 的用例钉住「结束后一律为 0」）。
   */
  const releaseTokenState = (token: TxToken): void => {
    brokenTx.delete(token)
    beganTx.delete(token)
    txInFlight.delete(token)
    txWrites.delete(token)
    drainWaiters.delete(token)
    deps.txStateProbe?.({
      brokenTx: brokenTx.size, beganTx: beganTx.size, txInFlight: txInFlight.size,
      txWrites: txWrites.size, drainWaiters: drainWaiters.size,
    })
  }
  const isRefusal = (e: unknown, token: TxToken): boolean =>
    ((typeof e === 'object' && e !== null) || typeof e === 'function') && refusals.get(e as object) === token
  /**
   * 提交，或者**拒绝冒充成功**：还有**别的异步链**的语句在途时（`foreignInFlight`），它的结果
   * （可能正是让本事务 aborted 的那次拒绝）还没交回，此刻 COMMIT 无法证明自己不是「先成功、
   * 后丢写」—— 改成 ROLLBACK 并抛 `internal`，点明成因与「已整体回滚」。
   * ⚠️ 为什么不按「错误已交回」打记号：那样必须等驱动把拒绝交回，而所有者提交恰恰可能发生在
   * 交回之前（CR/Codex 第三十三轮 major 的实测形态）。在途计数在**下发时**就登记，提交时同步可读。
   * 代价如实记录：并发的普通读（`count` 等）也会让同一时刻提交的事务被拒 —— 保守侧，且与
   * Store「同一实例操作串行 await」的契约一致。
   */
  const commitOrRefuse = async (token: TxToken): Promise<void> => {
    const marked = brokenTx.get(token)
    brokenTx.delete(token) // 令牌唯一，读过即清，不会串到别的事务
    const ownPending = txInFlight.get(token) ?? 0
    const ownWrites = txWrites.get(token) ?? 0
    if (marked === undefined && foreignInFlight === 0 && ownPending === 0 && ownWrites === 0) {
      txInFlight.delete(token)
      // ⚠️ **先退役令牌、再发 COMMIT**（CR 第三十八轮 major #9）：COMMIT 在驱动里执行期间，
      // 残留上下文里恢复的语句若仍被放行，会排在 COMMIT 之后在 autocommit 里执行，而本事务
      // 报的是提交成功。事务控制语句自身走 `txControl` 豁免。
      retire(token)
      try {
        await execSql('COMMIT', [], { txControl: true })
      } catch (e) {
        // 连接已关闭（execSql 派发前的本地守卫）→ COMMIT 根本没下发，不存在「结果未知」；
        // 原错误照常交回。⚠️ 判据用**身份集合**而不是读 `.kind`（CR 第五十五轮 major）：
        // 拒绝值的 `kind` 可能是抛异常的访问器（读一下就换成 TypeError），也可能是驱动对象
        // 伪造的同名字段（会把「可能已落库」的提交当成没下发）。
        if (e !== null && typeof e === 'object' && closedBeforeDispatch.has(e)) throw e
        // ⚠️ **COMMIT 结果未知**（CR 第三十九轮 major #5）：COMMIT 已下发、结果没能确认 ——
        // 写入可能已经落库，也可能没有。不能只说「失败」：按失败重试可能重复写。
        // ⚠️ **本实例当场永久退役**（CR 第四十一轮 major）：不能把「还能不能用」寄望于随后
        // 那次 ROLLBACK 恰好失败 —— 若它成功（例如 COMMIT 根本没执行、事务还开着），归属
        // 被清掉后连接会继续可用，而错误里刚说过「请用新的 Store 实例核对」。
        poison('事务提交结果未知：COMMIT 已下发但结果未能确认（写入可能已落库）',
          '关闭并重建 Store 实例，**先核对数据是否已落库**再决定是否重放 —— '
          + 'COMMIT 已下发，不要按失败直接重试（可能重复写）')
        const err = new Error('事务提交结果未知：COMMIT 已下发但未能确认结果 —— 本事务的写入**可能已经落库**，也可能没有。'
          + '不要按失败直接重试（可能重复写）；请用新的 Store 实例核对后再决定', { cause: e })
        ;(err as { kind?: string }).kind = 'internal'
        // ⚠️ 稳定标记（Codex PR#81 第四十五轮 P2）：这条错误本身就让实例永久退役，而编排层
        // （`storeGapOrPrimary` / `releaseLock`）按 `store_retired` 识别「该实例已不可用」——
        // 少了它，主失败在 gap 落库/清锁路径上会被次生错误换掉。
        ;(err as { code?: string }).code = 'store_retired'
        ;(err as { hint?: string }).hint = '关闭并重建 Store 实例，核对数据后决定是否重放'
        // 这条错误已按成因给过恢复动作：外层 catch 的回滚收尾不得再补通用文案（两套指令打架）。
        selfDiagnosed.add(err)
        throw err
      }
      beganTx.delete(token)
      return
    }
    const why = marked
      ?? (ownWrites > 0
        ? `事务回调返回时仍有 ${ownWrites} 个本事务的写操作没有完成（是不是没有 await 它们？）`
        : ownPending > 0
          ? `事务回调返回时仍有 ${ownPending} 条本事务的语句没有交回结果（是不是没有 await 它们？）`
          : `事务提交时仍有 ${foreignInFlight} 条其他异步链下发的语句没有交回结果，它执行期报错会把本事务标成 aborted`)
    // ⚠️ 顺序：先退役令牌（停掉后续下发），再等在途语句交回，最后才 ROLLBACK（`closeTx`）。
    const closed = await closeTx(token)
    const rolledBack = closed === 'confirmed'
    txInFlight.delete(token)
    txWrites.delete(token)
    const err = new Error(`事务未提交：${why} —— 该事务可能已被 DuckDB 标成 aborted，`
      + 'COMMIT 可能返回成功却丢弃全部写入，'
      + (rolledBack
        ? '因此已整体回滚'
        : '**回滚也未能确认**（连接可能已关闭、或还有语句未交回）：该连接已退役，'
          + '不要把该事务的任何写入当成已保存'))
    ;(err as { kind?: string }).kind = 'internal'
    // ⚠️ 恢复动作按**收尾状态**给（CR 第四十三轮 major）：这条拒绝不经过外层 catch 的
    // `annotateUnconfirmedRollback`（身份集合让它跳过回滚），所以「回滚也未能确认、连接已退役」
    // 的恢复动作必须在这里自己给 —— 否则 hint 只说「让操作串行」，而实例已经退役、照做也没用。
    ;(err as { hint?: string }).hint = rolledBack
      ? '让同一个 Store 实例上的操作串行执行，并 await 事务回调里的每一次写：不要用 Promise.all 并行调用 upsert/delete/transaction/query/count'
      : '让同一个 Store 实例上的操作串行执行，并 await 事务回调里的每一次写：不要用 Promise.all 并行调用 upsert/delete/transaction/query/count'
        + '；本次回滚也未能确认、该连接已退役 —— 请关闭并重建 Store 实例，先核对数据（本事务的写入是否落库）再决定是否重放'
    // ⚠️ 稳定标记（CR 第四十七轮 major）：这条拒绝不经过顶层 catch 的标注，编排层按 code 判
    // 「实例已退役」—— 已确认回滚时实例仍可用，不带标记。
    if (!rolledBack) (err as { code?: string }).code = 'store_retired'
    // 回滚**已由这里负责**（唯一处理点，CR 第三十六轮 major）：外层 catch 见到这个拒绝就不再
    // 回滚第二次 —— 两次回滚里只要一次成功、另一次失败，上一行对「回滚是否确认」的说法就不可信。
    refusals.set(err, token)
    throw err
  }
  /**
   * 语句执行期报错后，问连接「事务是否已被标成 aborted」（直连驱动实测见 catch 里的注释）。
   * 直接走原生连接、不经 `execSql`：不登记在途、不做归属判定，也绝不递归。
   */
  const txInvalidated = async (): Promise<boolean> => {
    // ⚠️ **必须有界**（CR 第六十四轮 major）：这条探针直接走原生连接，若原生线程被上一条
    // 失败语句占住，`SELECT 1` 永不交回 —— 而它是在 `execSql` 的 catch 里 await 的，拒绝也
    // 就永远到不了调用方，回滚收尾（连同 ROLLBACK 自己的有界预算）根本没机会开始。
    // 超时与探针报错同一保守侧：无法证明事务未失效 → 按「已失效」处理（只影响是否拒绝提交，
    // 不换掉交回的错误）。超时后补发 interrupt，别把原生线程留在里面。
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('事务失效性探针超时')), 50)
    })
    let raw: Promise<unknown> | undefined
    try {
      // 同一次派发前的复核（关闭 / 退役后这条探针不回交任何有意义的答案，直接按保守侧处理）。
      if (closed || poisoned !== undefined) return true
      raw = c.runAndReadAll('SELECT 1', []) as unknown as Promise<unknown>
      nativeProbeSettled = false
      raw.then(() => { nativeProbeSettled = true }, () => { nativeProbeSettled = true })
      void raw.catch(() => { /* 归因价值由探针结果承担，避免迟到拒绝冒成 unhandled */ })
      await Promise.race([raw, timeout])
      nativeProbeStuck = false
      return false
    } catch {
      try { (c as { interrupt?: () => void }).interrupt?.() } catch { /* 中断失败照旧按已失效处理 */ }
      // ⚠️ **超时后还要知道探针有没有真的交回**（Codex 第十二轮 P2）：`Promise.race` 只结束
      // 等待、不取消底层查询。若它仍在占用单连接，随后 closeTx 发出的 ROLLBACK 只会排在它
      // 后面超时 —— 被误判成「回滚未确认」并退役实例，而归因是错的（ROLLBACK 根本没轮到）。
      // 有界等它交回；仍未交回 → 记账，让 closeTx 跳过 ROLLBACK、按「收尾无法确认」处理。
      const settled = raw === undefined ? true : await Promise.race([
        raw.then(() => true, () => true),
        new Promise<boolean>((resolve) => { setTimeout(() => resolve(false), 100) }),
      ])
      nativeProbeStuck = !settled
      return true
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }
  /**
   * 事务关键字的**文本初筛**：只决定「要不要交给 DuckDB 解析」，本身不是判据。
   *
   * 事务控制语句不可能不写出这些词，所以初筛没有假阴性；假阳性（字符串字面量里的
   * `'END'`、`CASE … END` 的 END）只会多花一次解析（实测 0.05–0.5 ms）。
   * ⚠️ 真正判据在 `rejectRawTxControl`：DuckDB 把 `END` / `ABORT` / `START TRANSACTION`
   * 都解析成 TRANSACTION，注释前缀与多语句同样绕过文本前缀匹配 —— 这些形态只有解析能判
   * （直连驱动探针 2026-11-19：`SELECT 1; END` 的 statementType 序列是 [1, 10]）。
   */
  const TX_KEYWORD = /(?:^|[^A-Za-z0-9_])(?:BEGIN|COMMIT|ROLLBACK|END|ABORT|START|TRANSACTION)(?:[^A-Za-z0-9_]|$)/i
  /**
   * 多语句的**文本初筛**（与 `TX_KEYWORD` 同一角色：只决定「要不要解析」，判据是解析结果
   * 的语句数）。没有假阴性：多语句必然在末尾之前出现 `;`。假阳性（字符串 / 注释里的 `;`、
   * 块末尾的分号）只多花一次解析 —— 单条带尾分号实测 `count === 1`，照常放行。
   */
  const mightBeMulti = (sql: string): boolean => sql.replace(/[\s;]+$/, '').includes(';')
  /**
   * 把 SQL 里**不执行**的文本剥掉（字符串字面量 / 引号标识符 / 行注释 / 块注释 / dollar 引用），
   * 只给「原文里有没有事务关键字」这类**初判**用（CR 第六十二轮 / Codex PR#81 第五十二轮 P2）。
   * ⚠️ 它不是 SQL 解析器，边界如实记录：块注释按「到第一个星号加斜杠为止」处理
   * （剥离只会更保守地停下，不会把关键字漏进结果）；`E'…'` 之类前缀照常按普通字面量剥。
   */
  const stripSqlLiterals = (sql: string): string => {
    let out = ''
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i]
      if (ch === '-' && sql[i + 1] === '-') {
        while (i < sql.length && sql[i] !== '\n') i++
        out += '\n'
        continue
      }
      if (ch === '/' && sql[i + 1] === '*') {
        i += 2
        while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++
        i++
        out += ' '
        continue
      }
      if (ch === "'" || ch === '"') {
        const q = ch
        i++
        while (i < sql.length) {
          if (sql[i] === q) {
            if (sql[i + 1] === q) { i += 2; continue }
            break
          }
          i++
        }
        out += ' '
        continue
      }
      if (ch === '$') {
        const m = /^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$/.exec(sql.slice(i))
        if (m !== null) {
          const end = sql.indexOf(m[0], i + m[0].length)
          if (end !== -1) { i = end + m[0].length - 1; out += ' '; continue }
        }
      }
      out += ch
    }
    return out
  }
  /**
   * 去掉 `CASE … END` 结构（EXPLAIN 的事务控制初判用，Codex 第十三轮 P2）：
   * `EXPLAIN ANALYZE SELECT CASE WHEN … THEN … END` 是合法只读诊断，而 `END` 恰好也是
   * `TX_KEYWORD` 的一员 —— 旧判据把它误判成事务控制并拒绝。字面量 / 注释先由
   * `stripSqlLiterals` 剥掉，再按「最近的 CASE…END 配对」删除（可嵌套，有界迭代到不动点）。
   * 边界：未加引号的标识符 `case` 会被一并剥掉 —— 那只可能让初判**放行**，而真正的事务控制
   * 语句类型仍由 `prepare` 的 statementType 兜底（`EXPLAIN ANALYZE COMMIT` 照常拒）。
   */
  const stripCaseEnds = (s: string): string => {
    let t = s
    // 从**最内层**开始剥：非贪婪 `CASE…END` 会先配上最近的 END，嵌套 CASE 的内层先消失，
    // 外层的 END 才轮得到；从外往里剥「第一个 CASE + 第一个 END」会把内层 END 当外层配对，
    // 留下一个孤立的 END（实测 `CASE WHEN … THEN CASE WHEN … END ELSE … END` 仍被误判）。
    for (let i = 0; i < 64; i++) {
      const n = t.replace(/\bCASE\b((?:(?!\bCASE\b)[\s\S])*?)\bEND\b/i, ' ')
      if (n === t) return t
      t = n
    }
    return t
  }
  /** 原始事务控制的拒绝错误（`execSql` 与 `rejectRawTxControl` 共用一份文案）。 */
  const rawTxError = (): Error => {
    const err = new Error('事务控制语句不得经 `query` / 原始 SQL 下发 —— 它绕过事务归属与收尾判据'
      + '（回调里发 COMMIT 会让「回调随后抛错」无法回滚）')
    ;(err as { kind?: string }).kind = 'usage'
    ;(err as { hint?: string }).hint = '把写入放进 store.transaction() 的回调里，由 Store 负责 BEGIN / COMMIT / ROLLBACK'
    return err
  }
  /**
   * 原始事务控制的**唯一判据**（CR 第四十一轮 major）：交给 DuckDB 解析，逐条语句看类型。
   *
   * ⚠️ 为什么必须解析：旧判据是文本前缀 `^\s*(?:BEGIN|COMMIT|ROLLBACK)`，而 `END` /
   * `ABORT` / `START TRANSACTION` 同样是事务控制（DuckDB 1.5.6 实测 statementType=10），
   * 注释前缀 `/*c*\/ COMMIT` 与多语句 `SELECT 1; COMMIT` 也能绕过前缀 —— 最后一种实测
   * 会**真的执行 COMMIT**，即回调里的写入被提前提交、随后抛错也回滚不了。
   * 解析失败（空 SQL / 语法错 / 目标表不存在）**不在这里归因**：照常派发，让驱动交出与
   * 既往一致的原文（`extractStatements` 的 Catalog/Binder 错误与 `runAndReadAll` 同源，
   * 但 kind 映射、abort 探针等逻辑都在派发路径上）。事务控制语句一定能被解析，所以
   * 「解析失败 → 放行」不会漏掉任何真实的事务控制形态。
   */
  const rejectRawTxControl = async (sql: string): Promise<void> => {
    if (typeof c.extractStatements !== 'function') {
      // 真实连接的方法在**原型**上（`...(conn as object)` 展开拿不到它），手写假对象可能
      // 只包了 runAndReadAll。这里必须响亮失败而不是放行：跳过判据等于把这道守卫关掉，
      // 而这些假对象恰恰是在测 `execSql` 路径的。
      const err = new Error('连接缺少 extractStatements —— 无法判定原始 SQL 是否含事务控制语句')
      ;(err as { kind?: string }).kind = 'internal'
      ;(err as { hint?: string }).hint = 'Store 连接必须提供 extractStatements（@duckdb/node-api 的 DuckDBConnection 原生具备）；手写的测试假连接需显式转发该方法'
      throw err
    }
    // 解析层的失败（空 SQL / 语法错 / 目标表不存在）不在这里归因：交给派发路径给出与
    // 既往一致的原文与 kind（`extractStatements` 对同类错误与 `runAndReadAll` 同源，但
    // abort 探针、错误映射等逻辑都在派发路径上）。事务控制语句一定能被解析，所以
    // 「解析失败 → 放行」不会漏掉任何真实的事务控制形态。
    let parseFailure: unknown
    const ex = await c.extractStatements(sql).catch((e: unknown) => { parseFailure = e; return undefined })
    if (ex === undefined) {
      // ⚠️ **解析失败不得放行**（CR 第五十九轮 major，真驱动探针 2026-11-20）：驱动在派发时
      // 会**再次解析**并依次执行各语句 —— 实测「首次 extractStatements 异步拒绝、随后放行」
      // 时，`CREATE TABLE probeA(…); CREATE TABLE probeB(…)` 两条都真的执行了。拿不到语句数
      // 就无法证明只有一条，只能拒绝；原生解析错误挂在 `cause`（措辞用 safeValueText，
      // 访问器/无原型对象不得把诊断换掉）。
      const err = new Error(`无法解析 SQL 的语句数（${safeValueText(parseFailure, 160)}）——`
        + '为安全起见拒绝派发：多语句会被驱动逐条执行，事务控制或写入可能夹在其中')
      ;(err as { kind?: string }).kind = 'internal'
      ;(err as { hint?: string }).hint = '把多条语句拆成多次 query 调用；写入请放进 store.transaction() 的回调里'
      ;(err as { cause?: unknown }).cause = parseFailure
      throw err
    }
    // ⚠️ 多语句**先拒**（CR 第四十一轮 major）：`SELECT 1; COMMIT` 实测就是把两条语句
    // 依次执行。检查顺序刻意在 prepare 之前 —— prepare 会因缺表/绑定失败提前 return，
    // 若把多语句判定放在其后，「第一条绑不上、第二条是 COMMIT」的形态会漏过这道守卫
    // （虽然运行期第一条也会抛、第二条未必执行，但「未必」不是判据）。
    if (ex.count > 1) {
      const err = new Error(`一次只接受一条语句（检测到 ${ex.count} 条）—— 多语句会被逐条执行，`
        + '事务控制或写入可能夹在其中，绕过归属与收尾判据')
      ;(err as { kind?: string }).kind = 'usage'
      ;(err as { hint?: string }).hint = '把多条语句拆成多次 query 调用；写入请放进 store.transaction() 的回调里'
      throw err
    }
    // ⚠️ **解析结果在途期间连接可能已被关闭 / 退役**（CR 第四十二轮 major，真驱动探针
    // 2026-11-20 复现）：`close()` 之后交回的解析句柄照旧能用，旧实现无条件 `prepare(0)`，
    // 在**已关闭的连接**上又做了一次原生操作。这里不再碰原生上下文，归因交给 `execSql`
    // 派发前的同源重判（与 `close()` 之后任何语句一样报「数据库连接已关闭」）。
    if (closed) throw usage('数据库连接已关闭')
    if (poisoned !== undefined) throw poisonedError(poisoned)
    const ST = mod.StatementType ?? {}
    const TRANSACTION = typeof ST.TRANSACTION === 'number' ? ST.TRANSACTION : 10
    // ⚠️ **可执行包装器**（CR 第四十四轮 major，真驱动探针 2026-11-20）：`EXPLAIN ANALYZE COMMIT`
    // 的外层语句类型是 `EXPLAIN`(4)，DuckDB 照常执行里层计划 —— 探针实测「事务里写入 →
    // `EXPLAIN ANALYZE COMMIT` → ROLLBACK 报 `no transaction is active`、写入已在库里」。
    // 所以外层类型是 EXPLAIN 且（剥掉字面量/注释后）含事务关键字时拒。
    // ⚠️ **只匹配 SQL 代码部分**（CR 第六十二轮 / Codex PR#81 第五十二轮 P2）：`EXPLAIN ANALYZE
    // SELECT 'COMMIT'` 与注释里的 COMMIT 都是**不执行**的文本 —— 旧判据匹配整条原文，把合法
    // 只读诊断误拒。字面量 / 引号标识符 / 行注释 / 块注释 / dollar 引用全部剥掉再匹配：事务
    // 控制不可能藏在字面量里执行，剥离不会放宽判据。
    // （`EXPLAIN (ANALYZE)` / `EXPLAIN (ANALYZE true)` 同一探针同样执行里层。）
    const EXPLAIN = typeof ST.EXPLAIN === 'number' ? ST.EXPLAIN : 4
    let p: { statementType: number; destroySync?: () => void }
    try {
      p = await ex.prepare(0)
    } catch (prepareFailure) {
      // ⚠️ **类型无法判定时不得放行**（CR 第六十轮 major）：旧实现 `return` 装作分类成功，
      // 驱动在派发里**再次解析并执行** —— 此时语句类型（TRANSACTION / EXPLAIN / 普通）
      // 完全未知，无法证明它不含事务控制。代价如实记录：带事务关键字/多语句嫌疑、又恰好
      // 绑不上表的 SQL（如 `SELECT … FROM missing -- END`）会从「表不存在」变成这条内部错误，
      // 原生错误挂在 `cause` 上；不触发解析的普通 SQL 不受影响。
      const err = new Error(`无法判定语句类型（${safeValueText(prepareFailure, 160)}）——`
        + '为安全起见拒绝派发：拿不到语句类型就无法证明它不含事务控制语句')
      ;(err as { kind?: string }).kind = 'internal'
      ;(err as { hint?: string }).hint = '把多条语句拆成多次 query 调用；写入请放进 store.transaction() 的回调里'
      ;(err as { cause?: unknown }).cause = prepareFailure
      throw err
    }
    try {
      if (p.statementType === TRANSACTION) throw rawTxError()
      if (p.statementType === EXPLAIN && TX_KEYWORD.test(stripCaseEnds(stripSqlLiterals(sql)))) throw rawTxError()
    } finally {
      // 预编译语句持有原生句柄：不释放会在长会话里累积（同 sandbox 的做法）。
      p.destroySync?.()
    }
  }
  /**
   * 已结束事务的残留上下文不得再**开启**新事务（CR 第三十八轮 major #2）：`upsert` 的自动事务
   * 与 `transaction()` 会在 `alsTx.run` 里把旧令牌替换成新令牌，替换之后 execSql 的退役检查
   * 读到的就是新令牌了 —— 必须在**换令牌之前**就拒。
   */
  const rejectEndedContext = (): void => {
    const ctx = alsTx.getStore()
    if (ctx !== undefined && ctx.ended) throw txEndedError()
  }
  const execSql = async (sql: string, params: unknown[] = [], opts?: { txControl?: boolean }): Promise<unknown> => {
    const txControl = opts?.txControl === true
    if (closed) {
      // 身份登记：COMMIT 的 catch 靠它识别「本地没下发」（不读拒绝值的 kind）。
      const e = usage('数据库连接已关闭')
      closedBeforeDispatch.add(e)
      throw e
    }
    // 连接已退役：事务状态无法确认，一条语句都不许再发（CR 第三十七轮 major #4）。
    if (poisoned !== undefined) throw poisonedError(poisoned)
    // ⚠️ **原始事务控制一律拒绝**（CR 第三十九轮 major #4，第四十一轮改为按**解析出的语句
    // 类型**判）：托管回调里 `s.query('COMMIT')` 会通过归属检查、把回调里的写入提前提交 ——
    // 随后回调抛错也无法回滚（「报失败、数据却落库」）。事务控制只能由 Store 自己
    // （`txControl` 豁免）经 `transaction()` / 自动事务发出。
    // 文本初筛只决定是否解析（`'END'` 字符串、`CASE … END` 会多花一次毫秒级解析），
    // 判据本身在 `rejectRawTxControl`，它在下方的代号窗口里执行（见那里的注释）。
    // ⚠️ **已结束事务的残留上下文**里不得再下发语句（CR 第三十七轮 major #3）：令牌过期只可能来自
    // 「回调里没 await 的语句」或「事务里的 Promise 存到事务外再 await」—— 它的副作用与结果
    // 都不可信。事务控制语句（ROLLBACK）走 `txControl` 豁免：收尾时必须能发出去。
    const ctxToken = alsTx.getStore()
    if (!txControl && ctxToken !== undefined && ctxToken.ended) throw txEndedError()
    // ⚠️ **语句等待期间有人开了事务**同样不安全（CodeRabbit PR#81 第二十八轮 major，实测复现：
    // 外部 `SELECT` 与另一条链的事务交错，那条 SELECT 执行期报错 → 事务 COMMIT 返回成功而写入
    // 被丢弃，`count` 从 1 变成 0）。归属检查只覆盖「下发前」；驱动内部 `runUntilLast` /
    // `prepared.run()` 之间的 await 是第二个窗口，用事务代号把它封住。
    // ⚠️ 解析判据的 await 也是同一个窗口（CR 第四十一轮）：所以在它之前取代号，解析之后再判。
    const epochBefore = txEpoch
    // ⚠️ **多语句必须独立于关键字初筛判**（CR 第四十五轮 major，真驱动探针 2026-11-20）：
    // `INSERT INTO scratch VALUES (1); SELECT * FROM missing_table` 里没有事务关键字，旧实现
    // 直接派发 —— 驱动先执行 INSERT、再准备第二条时报错，**行已经写进去了**。所以只要解析
    // 可用就解析一次、按语句数判；`TX_KEYWORD` 仍决定要不要额外做事务控制判定。
    const needsParse = !txControl && (TX_KEYWORD.test(sql) || mightBeMulti(sql))
    if (needsParse) {
      // 解析同样占用连接（extract/prepare 走原生上下文）：按在途登记，BEGIN 准入才看得见它。
      // ⚠️ **归属先于登记**（CR 第四十二轮 major，实测复现）：判据必须是「当前链就是这条事务的
      // 所有者」，而不是实例级的「有活动事务」—— 事务开着时另一条链发来的解析若记在所有者账上，
      // 所有者回调此刻返回，`commitOrRefuse` 会看到 ownPending>0、拒绝提交并把连接退役。
      // `assertTxOwnership()` 在这里同步判（同 `foreignInFlight` 的输入），外部链在解析前就被拒。
      assertTxOwnership()
      const untrackParse = inTx && txToken !== undefined ? trackOwn(txToken) : trackForeign()
      try {
        await rejectRawTxControl(sql)
      } catch (e) {
        // ⚠️ **解析 / 预编译也会绑定并求值**（CR 第六十六轮 major，DuckDB 在 prepare 期做
        // constant folding 与 table-function 参数求值）：`SELECT * FROM range(CAST('x' AS
        // BIGINT)) -- END` 会因注释进入分类，Conversion Error 在**派发之前**就把事务标成
        // aborted —— 旧实现直接把它当普通拒绝交回，回调吞掉后 `commitOrRefuse` 只看到在途
        // 归零，COMMIT 被 DuckDB 静默改成 ROLLBACK，写入丢失。
        // 拒绝照旧是**原始解析错误**（不换掉）；只在事务所有者的计数登记内问一次连接，
        // 探针说已失效才打 brokenTx 记号。local usage（事务控制语句）与派发前被拒的形态
        // 没动过连接状态，不问。
        if (!txControl && !closed && poisoned === undefined
          && inTx && txToken !== undefined && ctxToken === txToken
          && safeKindOf(e) !== 'usage' && await txInvalidated()) {
          brokenTx.set(txToken, '事务内的 SQL 在解析/预编译期就让 DuckDB 把整条事务标成 aborted'
            + `（驱动原文：${safeMessageText(e, 160)}）`)
        }
        throw e
      } finally {
        untrackParse()
      }
      // 解析等待期间连接可能被关闭 / 退役，事务也可能被别人开启或结束 —— 逐项重判后才派发。
      if (closed) throw usage('数据库连接已关闭')
      if (poisoned !== undefined) throw poisonedError(poisoned)
      if (!txControl && ctxToken !== undefined && ctxToken.ended) throw txEndedError()
      if (txEpoch !== epochBefore) {
        assertTxOwnership()
        throw epochChangedError()
      }
    }
    // ⚠️ **一切语句派发都过归属闸门**（CodeRabbit PR#81 第十六轮 major，实测复现）：单连接
    // 上的语句会加入当前活动事务 —— 包括读语句。别人的事务开着时，另一条链发出的 SELECT
    // 也落在那条事务里；它一旦执行期报错（实测：目标表是 CAST 失败的 view），DuckDB 就把
    // 那条事务标成 aborted：所有者的 COMMIT 返回成功、写入却被静默丢弃。
    // 只守方法入口不够：入口与该语句之间隔着 await（`del` 的 count），窗口仍在。
    assertTxOwnership()
    // 统一走 runAndReadAll：其结果带 getRowObjectsJson/columnNames（run() 的结果没有）
    // 在**别的异步链**的上下文里下发、且此刻不在本事务里 → 登记为在途（见 `foreignInFlight`）。
    // ⚠️ 判据是「**此刻有本实例的活动事务、且当前链就是它的所有者**」，不是「ALS 里有没有令牌」
    // （CR 第三十五轮 major）：已完成事务 A 里排下的定时器 / 续体仍带着 A 的令牌（AsyncLocalStorage
    // 按异步资源传播），它在 `inTx === false` 时下发的语句同样可能落进随后开启的事务 B —— 旧判据
    // 把「有令牌」当成「在本事务里」，这条语句不登记、B 提交时计数为 0，缺口因此打开。
    // 归属由上一行的 `assertTxOwnership()` 担保（无 await 间隔）：能走到这里且 `inTx` 为真，
    // 当前链就一定是 `txToken` 的所有者。
    const untrack = inTx && txToken !== undefined ? trackOwn(txToken) : trackForeign()
    let result: unknown
    try {
      result = await c.runAndReadAll(sql, params)
    } catch (e) {
      // ⚠️ **失败路径同样要检查代号**（CodeRabbit PR#81 第二十八轮 major）：驱动报错时
      // `runAndReadAll` 抛出，若只成功路径检查，最危险的情形（外部语句执行期报错 → 把别人的
      // 事务标成 aborted → COMMIT 返回成功而写入被丢弃，实测 count 1→0）恰好漏网。
      // 此时原错误被替换成归因正确的 internal，`cause` 保留驱动原文。
      // ⚠️ **本事务自己的语句执行期报错**：只有它**真的把事务标成 aborted** 时才打记号
      // （CR 第三十七轮 major #5 + 第三十八轮 major #6）。直连驱动实测（2026-11-18）：
      // Catalog Error / Binder Error **不**废事务（后续 INSERT 正常、COMMIT 后写入落库），
      // Conversion Error 等执行期错误才废（后续语句报 `Current transaction is aborted`，
      // COMMIT 返回成功却丢写）。所以判据不是「任何错误都拒提交」——那会把可恢复错误吞成
      // 必然失败 —— 而是**问连接**：发一条 `SELECT 1`，报错即已失效。
      // ⚠️ **探针只在「活跃事务的所有者自己下发的数据语句」执行期报错后才发**
      // （CR 第四十一轮 major）：`txInvalidated` 直接走原生连接、绕过授位与退役判据 ——
      // 事务控制语句（COMMIT/ROLLBACK）自身的失败另有处理（结果未知 / 退役），此刻在
      // 未知的事务状态上再多下发一条语句毫无意义；采集、解析期的失败发生在派发之前，
      // 连接状态没有被这条语句动过，也不需要问。
      // 连接已关 / 已退役时同样不问：两条检查与 `execSql` 派发前的同源，不能因为进入了
      // catch 分支就绕过它们（那条语句可能恰恰是「连接在等待期间被关掉」才失败的）。
      if (!txControl && !closed && poisoned === undefined
        && inTx && txToken !== undefined && ctxToken === txToken && await txInvalidated()) {
        brokenTx.set(txToken, `本事务内的一条语句执行期报错，DuckDB 已把整条事务标成 aborted`
          + `（驱动原文：${safeMessageText(e, 160)}）`)
      }
      if (txEpoch !== epochBefore && txToken !== undefined) {
        brokenTx.set(txToken, '外部语句执行期报错，且期间另一条链开启了事务'
          + `（驱动原文：${safeMessageText(e, 160)}）`)
      }
      if (txEpoch !== epochBefore) {
        throw epochChangedError(e)
      }
      throw e
    } finally {
      // 结果（成功或拒绝）都已交回 —— 这条外部语句不再「在途」。
      untrack()
    }
    // ⚠️ 事务已结束后才交回的结果同样不可信（CR 第三十七轮 major #3）：语句可能已在回滚/提交
    // 之后才执行（回滚后的那次执行落在 autocommit 里），调用方据此继续下一步就是错的。
    if (!txControl && ctxToken !== undefined && ctxToken.ended) throw txEndedError()
    // 下发期间事务代号变了 → 这条语句可能落进了别人的事务（或它自己在事务里开过又提交过）
    if (txEpoch !== epochBefore) {
      // ⚠️ **执行成功**同样要给当前事务打记号（CR 第三十六轮 major）：外部的 DELETE 在别的事务
      // 里**成功**执行时，行已经真的删了；调用方拿到的是拒绝 —— 若那条事务照常 COMMIT，
      // 「报了失败、数据却落库」同时成立。记号让那条事务拒绝提交并回滚，两边结论一致。
      if (txToken !== undefined) {
        brokenTx.set(txToken, `另一条异步链下发的语句在跨代期间**执行成功**，它可能已并入本事务：${sql.slice(0, 80)}`)
      }
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
    rejectEndedContext()
    // ⚠️ 归属检查必须**先于第一条语句**（CodeRabbit PR#81 第十轮 major，实测复现）：
    // 若只在 `count` 之后判，这条 count 自己就会在别人的事务里执行 —— 而**任何**执行期
    // 错误（实测：目标表被换成 CAST 失败的 view 时的 Conversion Error）都会把那条事务
    // 标成 aborted：对方的 COMMIT 返回成功，写入却被静默丢弃（实测行数归零、无报错）。
    // 所以外部写在这里就被拒，一条语句都不发。
    assertTxOwnership()
    // ⚠️ 事务外的 `del` 是**多语句写操作**：整个序列（count → DELETE → count）登记在册，
    // 期间不许开事务（`admitBegin`）—— 否则 DELETE 的实际执行可能早于 BEGIN 提交、结果晚于
    // BEGIN 交回，删改行数以「跨代失败」报出去，行却已经删了（CR 第三十七轮 major #6）。
    const op = inTx ? undefined : enterWriteOp()
    const own = inTx && txToken !== undefined ? trackWrite(txToken) : undefined
    try {
      const before = await store.count(tname)
      // 派发点再判一次（CodeRabbit PR#81 major）：`count` 是 await，期间别的调用方可能开事务，
      // 随后这条 DELETE 就被并进去。
      assertTxOwnership()
      await store.execSql(`DELETE FROM "${t.name}" WHERE ${where}`, params)
      const after = await store.count(tname)
      return Math.max(0, before - after)
    } finally {
      if (own !== undefined) own()
      if (op !== undefined) leaveWriteOp(op)
    }
  }

  /**
   * 事务收尾的**三态**（CR 第四十二轮 major）：`confirmed` = ROLLBACK 已确认，写入已撤；
   * `unconfirmed` = 回滚可能没执行、事务也许还开着（连接已退役）；`none` = 本来就没什么可确认
   * （BEGIN 未成功 / 连接已关 —— 后者实测未提交写入随连接丢弃）。
   * ⚠️ 旧实现只有布尔，「未能确认」与「已确认」在两个事务处理器的 rethrow 上完全同形，
   * `store init` 的用户因此分不出「迁移写入已撤」与「写入状态不可信」。
   */
  type TxClose = 'confirmed' | 'unconfirmed' | 'none'
  /**
   * 把「回滚未能确认」补进**交回给调用方的诊断**（两个事务处理器的唯一落点）。
   * 否则调用方的诊断与已确认回滚一字不差（CR 第四十二轮 major）。
   * ⚠️ **不再就地改写调用方的错误对象**（CR 第六十轮 major）：回滚状态是**这次事务尝试**的属性，
   * 不是错误对象的属性 —— 同一个 Error 可能被回调跨 Store / 跨事务复用，在 A（回滚未确认、实例
   * 退役）上补的 `code: 'store_retired'` 与「本实例已退役」文案会跟着对象出现在 B（回滚已确认、
   * 实例仍可用）的诊断里，全是假话。现在**一律包一层**：原错误挂 `cause`（身份契约由 cause 承接），
   * 状态字段只写在我们自己新建的普通 Error 上 —— 也顺带绕开了冻结 / getter+空 setter / revoked
   * Proxy 这些「写外部对象会炸或静默丢」的陷阱（round 46–59 的加固因此变成结构性保证）。
   */
  /** 自带成因级恢复动作的错误（COMMIT 结果未知，本地新建）—— 不再追加通用回滚文案，免得两套指令打架。 */
  const selfDiagnosed = new WeakSet<object>()
  const annotateUnconfirmedRollback = <E>(e: E, state: TxClose): E => {
    if (state !== 'unconfirmed') return e
    // COMMIT 结果未知的错误是本地新建的对象，不存在跨实例复用；它已按成因给过恢复动作。
    if (isErrorValue(e) && selfDiagnosed.has(e)) return e
    const note = ' ——（事务收尾）回滚未能确认：ROLLBACK 可能根本没有执行，该事务也许仍然开着；'
      + '该连接已退役，本实例上的写入结果不可信'
    const hint = '关闭并重建 Store 实例，先核对数据（本事务的写入是否落库）'
      + '再决定是否重放；本实例上的后续语句都会被拒'
    // 原 message / kind / hint 的读取都可能抛（访问器 / revoked Proxy）：一律读不到就退化。
    const isErr = isErrorValue(e)
    const readable = ((): string => {
      try {
        if (isErr) return String((e as { message?: unknown }).message)
        // 非 Error 的拒绝值（字符串 / 对象）也要带上状态（CR 第四十八轮 major）：调用方拿到的
        // 不能与「已确认回滚」一字不差；原值挂在 cause 上。
        return `事务失败（回调拒绝了一个非 Error 值：${safeValueText(e, 120)}）`
      } catch { return '(无法读取的错误消息)' }
    })()
    const prevKind = isErr
      ? ((): string | undefined => {
          // ⚠️ 非字符串按缺失处理（CR 第六十一轮 major）：Symbol 等值落进模板拼接会抛
          // TypeError，整段标注会被换成 TypeError；直接落进 kind 分流又会污染命令出口。
          try {
            const v = (e as { kind?: unknown }).kind
            return typeof v === 'string' ? v : undefined
          } catch { return undefined }
        })()
      : undefined
    const prevHint = isErr
      ? ((): string | undefined => {
          try {
            const v = (e as { hint?: unknown }).hint
            return typeof v === 'string' ? v : undefined
          } catch { return undefined }
        })()
      : undefined
    const wrapped = new Error(`${readable}${note}`, { cause: e })
    // 无 kind 的错误必须补 `internal`（CR 第四十八轮 major）：`store init` 的迁移抛 plain Error 时，
    // `thrownToExit` 走「无 kind」分支、把这条 hint 换成通用的「执行期错误」。
    ;(wrapped as { kind?: string }).kind = prevKind ?? 'internal'
    ;(wrapped as { retryable?: boolean }).retryable = false
    ;(wrapped as { code?: string }).code = 'store_retired'
    // 原 hint 与「先核对」冲突时**核对必须在前**（CR 第五十七轮 major）：两条一起交给 Agent 时，
    // 先出现的「稍后重试」会被照做，而写入状态此时不可信 —— 原建议标注为「核对之后才可执行」。
    ;(wrapped as { hint?: string }).hint = prevHint === undefined
      ? hint
      : `${hint}；原错误的建议（核对之后才可执行）：${prevHint}`
    return wrapped as unknown as E
  }
  /**
   * 在令牌上下文里收尾：退役令牌 → 等在途语句落定 → ROLLBACK。返回收尾状态（三态，见
   * `TxClose`）：`confirmed` 才会被 `commitOrRefuse` 说成「已整体回滚」；`unconfirmed` 由两个
   * 事务处理器补进交回的错误（CR 第四十二轮 major：否则调用方拿到的诊断与已确认回滚一字不差）。
   * ⚠️ **关闭后不得进入上下文**（CodeRabbit PR#81 第十九轮 minor）：`close()` 已把 ALS
   * `disable()` 掉，而 `alsTx.run()` 会把它**重新启用**、失败路径又不再 disable ——
   * 「事务进行中被 close」每次都在攒一个启用态上下文。`execSql` 在这种情况下本来也必然抛
   * 「连接已关闭」，回滚必然失败，所以直接跳过。
   */
  const rollbackInTx = async (token: TxToken): Promise<TxClose> => {
    retire(token)
    // 连接已关：未提交的写入随连接丢弃（真驱动探针 2026-11-20：关连接后重开，未提交行数 0），
    // 事务状态不是「未知」，不需要向调用方补「回滚未确认」。
    if (closed) return 'none'
    return alsTx.run(token, () => closeTx(token))
  }
  /**
   * `rollbackInTx` / `commitOrRefuse` 共用的事务收尾（只在令牌上下文里调用）。
   * 返回收尾状态；无法确认时**退役连接**并**不发 ROLLBACK**（CR 第三十七轮 major #1/#4）：
   * 先 ROLLBACK 的话，驱动里还没执行完的语句会在事务结束后于 autocommit 里执行。
   */
  /**
   * 连接上**此刻有没有活动事务**（BEGIN 收尾归因用，Codex PR#81 第五十四轮 P2）。
   * 真驱动探针（2026-11-20）：autocommit 下每条语句各开一个隐式事务、`txid_current()`
   * 逐次**递增**；显式事务内连续查询返回**同一值**。所以「两次查询同值 = 有活动事务」。
   * 任何失败 / 超时 → `undefined`（调用方按「无法确认」处理，保守侧不变）。
   * ⚠️ 只在 ROLLBACK 已被拒、需要判断「事务到底开没开」时调用 —— 正常路径一次都不发。
   */
  const probeActiveTransaction = async (): Promise<boolean | undefined> => {
    // ⚠️ **退役连接上一条语句都不许发**（CR 第六十三轮 major）：`closeTx` 在这里绕过了
    // execSql 的退役守卫，若连接已退役（poison），探针就是「退役后仍做原生操作」。
    // 退役状态下的答案已由 poison 决定，保守侧 = 按「未能确认」处理。
    if (poisoned !== undefined) return undefined
    const one = async (): Promise<string> => {
      // ⚠️ **每次原生调用前复核连接状态**（CR 第六十五轮 major）：close() 可能落在两次探针
      // 之间（第一次 txid_current 在途时关连接），随后第二次仍在已关闭的连接上发语句；
      // 反过来 close 也可能落在 ROLLBACK 在途期间，让第一次探针在关闭之后才发。关闭 / 退役
      // 时静态求值不可信 → 抛给下面的保守侧（返回 undefined）。
      if (closed) throw new Error('连接已关闭，事务状态探针不派发')
      if (poisoned !== undefined) throw new Error('Store 已退役，事务状态探针不派发')
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('事务状态探针超时')), 50)
      })
      try {
        const raw = c.runAndReadAll('SELECT txid_current() AS t') as unknown as Promise<{
          getRowObjectsJson?: () => Array<Record<string, unknown>>
        }>
        // 超时后探针仍可能迟到拒绝（中断 / 连接收尾）—— 先挂一个空的 catch，避免它冒成
        // 未处理的 rejection 带走进程。
        void raw.catch(() => { /* 归因价值已由探针的 undefined 承担 */ })
        const r = await Promise.race([raw, timeout])
        return String(r.getRowObjectsJson?.()[0]?.t)
      } finally {
        if (timer !== undefined) clearTimeout(timer)
      }
    }
    try {
      const a = await one()
      const b = await one()
      return a === b
    } catch {
      // ⚠️ 超时 / 失败时把执行中的原生查询中断掉（CR 第六十三轮 major）：close 不会取消
      // 原生任务，挂住的 SELECT 会把进程留在后台。目的只是解卡，不改变归因。
      try { (c as { interrupt?: () => void }).interrupt?.() } catch { /* 中断失败照旧走保守侧 */ }
      return undefined
    }
  }
  const closeTx = async (token: TxToken): Promise<TxClose> => {
    retire(token)
    if (closed) return 'none'
    if (!(await drainOwned(token))) {
      // 中断之后仍不交回：语句卡在不可中断的原生点上。此时连 close 都不能让进程退出
      //（实测：连接/实例都秒关，但原生线程仍被自身查询占住），所以退役文案要与这一事实一致。
      poison('事务内仍有语句没有交回结果（中断后仍未返回），无法确认它们不会在回滚之后落库')
      return 'unconfirmed'
    }
    // ⚠️ **探针可能仍占着连接**（Codex 第十二轮 P2）：事务失效性探针超时后已无法确认它是否
    // 停止；此时发 ROLLBACK 只会排在它后面、超时后被误判成「回滚未确认」，而真实成因是连接
    // 仍被探针占用。直接按「收尾无法确认」退役，把成因写进文案，不发 ROLLBACK。
    // ⚠️ 判据是「**收尾此刻**探针仍没交回」（CR 第六十六轮 major）：超时那一刻在途、但随后
    // 自己交回的探针已经不占连接，为它跳过 ROLLBACK 会把可正常收尾的事务错误退役。
    if (nativeProbeStuck && !nativeProbeSettled) {
      poison('事务状态探针中断后仍未交回：连接可能仍被它占用，ROLLBACK 无法安全发出')
      beganTx.delete(token)
      return 'unconfirmed'
    }
    // 事务控制语句豁免「令牌已退役」检查，否则收尾自己的 ROLLBACK 也会被挡。
    // ⚠️ **ROLLBACK 自身必须有界，且超时后必须 interrupt**（CR 第四十一轮 major 定有界、
    // 第四十二轮补中断）。子进程实测（DuckDB 1.5.6-r.1，2026-11-20）：巨型语句占住原生线程、
    // ROLLBACK 排在它后面时，到点只 close 掉连接与实例，**进程 15s 内不退出**（只能 SIGKILL，
    // closeSync 不取消原生任务）；同一探针先 `interrupt()`，卡住的语句以 `INTERRUPT Error`
    // 交回、排队的 ROLLBACK 随即执行成功、1.9s 内正常退出。所以：到点先 interrupt，
    // 再给 `DRAIN_INTERRUPT_GRACE_MS` 等 ROLLBACK 落定；等不到才按「未能确认」退役。
    let failed: unknown
    // ⚠️ **不能用「failed !== undefined」判是否被拒**（CR 第五十二轮 major）：拒绝值恰好是
    // `undefined` 时会把「ROLLBACK 被拒」当成「成功」，于是回滚未确认的事务被说成「已整体回滚」。
    let rejected = false
    const settled = execSql('ROLLBACK', [], { txControl: true })
      .then(() => { /* 成功 */ }, (e: unknown) => { failed = e; rejected = true })
    /** 等到 `settled` 或超时；返回是否已落定。 */
    const awaitSettled = async (ms: number): Promise<boolean> => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const done = await Promise.race([
        settled.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms) }),
      ])
      if (timer !== undefined) clearTimeout(timer)
      return done
    }
    try {
      if (!(await awaitSettled(ROLLBACK_CAP_MS))) {
        try { (c as { interrupt?: () => void }).interrupt?.() } catch { /* 中断失败照旧走退役路径 */ }
        if (!(await awaitSettled(DRAIN_INTERRUPT_GRACE_MS))) {
          // ⚠️ **放弃前再补一发中断**（CR 第六十轮 major）：驱动把 ROLLBACK 拆成「准备」与
          // 「执行」两段，第一次 interrupt 若落在准备阶段之前，会被随后的准备清掉 —— 之后它
          // 照样进入原生执行，而我们这边已经放弃并退役（连 close 都解不了卡）。此时已经不再
          // 等它交回（结论已经是「未能确认」），补发的目的只是别把原生线程留在里面。
          try { (c as { interrupt?: () => void }).interrupt?.() } catch { /* 同上 */ }
          // 中断之后仍不交回：卡在不可中断的原生点上（连 close 都不能让进程退出）。
          poison(`ROLLBACK 在 ${ROLLBACK_CAP_MS}ms 内未返回，中断后 ${DRAIN_INTERRUPT_GRACE_MS}ms 内仍未交回：事务也许仍然开着`)
          beganTx.delete(token)
          return 'unconfirmed'
        }
      }
      if (rejected) throw failed
      beganTx.delete(token)
      return 'confirmed'
    } catch (e) {
      // BEGIN 都没成功 → 本来就没有事务可回滚（可以是 BEGIN 被快照拒这类响亮失败），不是「状态未知」。
      // 挂住的那次 ROLLBACK 若**迟到成功**，事务其实已经收尾 —— 但本实例状态已经不可信
      //（退役由 poison 负责、连接即将关闭），不因迟到结果恢复可用性，保持「未能确认」。
      // ⚠️ **「登记过」不等于「事务真的开过」**（Codex PR#81 第五十四轮 P2）：`beganTx` 在发出
      // BEGIN 之前登记（为了兜住「原生已成功、结果交回才拒」），若驱动的拒绝发生在原生执行
      // **之前**，事务根本没开过 —— 直接按「回滚未确认」毒化会把原错误换成退役文案，后续所有
      // 操作都被拒。这里问一次连接（两次 `txid_current()` 同值才是有活动事务）：
      // 确认没有 → 按「无可回滚」交回原错误；探针失败 / 有事务 → 保守毒化（与旧行为一致）。
      let unconfirmed = beganTx.has(token)
      if (unconfirmed) {
        const active = await probeActiveTransaction()
        if (active === false) {
          unconfirmed = false
        } else {
          poison('ROLLBACK 未能确认：它可能根本没有执行，事务也许仍然开着')
        }
      }
      beganTx.delete(token)
      return unconfirmed ? 'unconfirmed' : 'none'
    }
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
        // ⚠️ 迁移走**托管事务**（CR 第三十八轮 major #1）：裸 `execSql('BEGIN')` 不登记归属 ——
        // 迁移暂停时另一条链的 `transaction()` 会再发一条 BEGIN（DuckDB 拒绝它并把迁移的事务
        // 标成 aborted），随后它的失败处理回滚掉迁移事务，`init` 恢复后就在事务外执行语句。
        // 托管事务把准入、归属登记、回滚与退役全部收敛到同一处。
        // 迁移失败 → 事务回滚且**不推进**版本 → 下次 init 重放该迁移（验收 19/20）。
        await store.transaction(async () => {
          await m.up((sql) => store.execSql(sql).then(() => undefined))
          await store.execSql('INSERT INTO schema_version (version) VALUES (?)', [m.version])
        })
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
      // ⚠️ 退役连接不接受新工作（CR 第六十三轮 major）：自动事务的 BEGIN 同样不发。
      if (poisoned !== undefined) throw poisonedError(poisoned)
      rejectEndedContext()
      // ⚠️ `inTx` 的语义是「本实例上有事务开着」，不等于「调用者在那个事务里」——
      // 归属必须由 `assertTxOwnership` 判（历史审查 PR#4 复核）。
      // 入口这一处只做**快速失败**（省掉开自己那条事务的功夫）；真正的判定在
      // `doUpsert` 贴着 INSERT 的那次 —— 见那里的注释。
      if (inTx) {
        assertTxOwnership()
        if (txToken === undefined) return doUpsert(t, rows)
        const done = trackWrite(txToken)
        try { return await doUpsert(t, rows) } finally { done() }
      }
      // ⚠️ 自动事务也**登记归属**（CodeRabbit PR#81 第八轮 major）：只打 BEGIN 不置 `inTx`
      // 时，另有调用方在此期间 `transaction()`，它的 BEGIN 会撞上「事务已开」而失败 ——
      // 那条失败路径若再 ROLLBACK，就会把**这里的**活动事务回滚掉，之后的批次落在事务外、
      // 最终 COMMIT 失败留下部分写入。登记后用单一令牌管住：同一实例上事实并存两种事务
      // 从根上不存在（并发的第二次写会在 `assertTxOwnership` 被拒，且它自己的 BEGIN 不会
      // 发出、也就没有任何人会回滚别人的事务）。
      // 登记与整个（同步段 + 后续批次）放在同一个异步上下文里：`doUpsert` 内部贴着 INSERT
      // 的 `assertTxOwnership` 要有令牌才认得出「这是自己那条自动事务」。
      const token = newTxToken()
      // 自动事务也是「写操作」：BEGIN 之前登记，且要求**别的**写操作都已落定（CR 第三十七轮
      // major #6）。⚠️ 准入必须排在 `txEpoch += 1` / `inTx = true` **之前** —— 否则被拒的
      // 自动事务也会推进代号，把正在执行的外部写误判成「跨代」。
      const op = enterWriteOp()
      let n: number
      let beginAttempted = false
      try {
        admitBegin(op)
        inTx = true
        txToken = token
        txEpoch += 1
        // ⚠️ BEGIN / 数据语句 / COMMIT 全在**带令牌的上下文**里（闸门下移到 `execSql` 之后，
        // 事务控制语句也要过它，见那里的注释）；`doUpsert` 内部贴着 INSERT 的归属检查同样
        // 靠这个上下文认出「这是自己那条自动事务」。
        n = await alsTx.run(token, async () => {
          beginAttempted = true
          beganTx.add(token) // 理由同 `transaction()`：驱动可能在原生 BEGIN 成功后拒绝交回结果
          await execSql('BEGIN', [], { txControl: true })
          const written = await doUpsert(t, rows)
          await commitOrRefuse(token)
          return written
        })
      } catch (e) {
        // ⚠️ 准入失败（还没碰过 BEGIN）不得回滚（CR 第三十九轮 major #1）：那条 ROLLBACK 会发到
        // 一条**别人的**事务上（手开事务）并拖慢拒绝。只有 BEGIN 已尝试过才进入回滚处理 ——
        // 「原生 BEGIN 成功了但结果交回被拒」的情形由 `beginAttempted` + `beganTx` 一起兜住。
        if (!isRefusal(e, token) && beginAttempted) {
          // 回滚未能确认时必须带回状态（CR 第四十二轮 major）：rethrow 原错误，但让它自己说出
          // 「写入状态不可信」。已确认回滚 / 无可回滚的路径一字不改。
          throw annotateUnconfirmedRollback(e, await rollbackInTx(token))
        }
        throw e
      } finally {
        inTx = false
        txToken = undefined
        leaveWriteOp(op)
        releaseTokenState(token)
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
      // ⚠️ **退役连接不接受新事务**（CR 第六十三轮 major）：连 BEGIN 都不发 —— 否则失败
      // 路径的回滚收尾会把原错误换成「回滚未确认」，并在退役连接上再做原生探测。
      if (poisoned !== undefined) throw poisonedError(poisoned)
      rejectEndedContext()
      // ⚠️ 用异步上下文区分两种「事务已开」（CodeRabbit PR#81 第十七轮 minor，实测复现）：
      //   · 调用方**就在所有者上下文里**（`fn` 里的 `tx.transaction`，令牌一致）→ 真嵌套，usage；
      //   · 调用方是**另一条异步链**（令牌不一致）→ 并发竞争，internal。
      // 原先只对「自动事务被撞」分开报，显式事务被撞时一律落到
      // `usage('不得嵌套事务')` —— 实测竞争方拿到退出码 2 的「参数写错」信号，且没有串行化提示。
      // 令牌现在一律是对象：区分依据是**异步上下文里的令牌是否相等**，不是令牌类型。
      const owns = inTx && alsTx.getStore() === txToken
      if (inTx && !owns) {
        throw Object.assign(new Error('本实例上有一条事务尚未提交，此时另一条异步链不能开始新事务 —— '
          + '请让同一 Store 实例上的操作串行 await'), {
          kind: 'internal',
          hint: '让同一个 Store 实例上的操作串行执行：不要用 Promise.all 并行调用 upsert/delete/transaction/query/count',
        })
      }
      if (owns) throw usage('不得嵌套事务')
      // ⚠️ **BEGIN 的准入**（CR 第三十七轮 major #6）：写操作（`delete` / 自动事务）还在进行时
      // 不许开事务 —— 单连接上的语句按实际执行顺序进入事务，写操作的 DELETE/INSERT 可能已经
      // 提交而其结果还没交回；此时开事务会让它报「跨代失败」、行却真的改过了。
      admitBegin()
      // ⚠️ 归属登记必须**先于** `BEGIN` 的 await（CodeRabbit PR#81 第七轮 major）：原先
      // `inTx` 在 BEGIN 落定之后才置位，BEGIN 这条 await 期间它的外部写会被放行，随后的
      // 语句排进本事务、回滚时静默消失（实测：BEGIN 挂住时外部 delete 返回成功、行没了）。
      const token = newTxToken()
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
          // 先登记「可能已开启」（CR 第三十八轮 major #7）：驱动可能在原生 BEGIN **成功之后**
          // 才拒绝结果交回，此时 `beganTx` 若为空，后续 ROLLBACK 失败就不会触发退役 ——
          // 事务可能真的开着。登记后由成功的 COMMIT / ROLLBACK 负责清除。
          beganTx.add(token)
          await execSql('BEGIN', [], { txControl: true })
          // ⚠️ 真实投影而非 cast：WriteTx 类型上不含 query/init/close（spec §4.2.6 防线分层），
          // 运行时对象也不得携带 —— 直接传 store 的话 `Object.keys(tx)` 可枚举出 query。
          // ⚠️ `WriteTx` 是**回调作用域**的（CR 第三十八轮 major #4；契约写进 types.ts）：
          // `const tx = await transaction(async (t) => t)` 把投影带出回调后，直接调用会变成
          // 一个 Store 别名（在 autocommit 里写），调用方却以为它还在事务里。每个方法入口
          // 都核对「当前异步上下文仍是本事务」。
          // ⚠️ **关闭必须先于归属**（Codex PR#81 第四十三轮 P2，探针 2026-11-20）：`close()`
          // 会 `alsTx.disable()`，`getStore()` 随即变成 undefined —— 只看令牌会把「连接已关」
          // 误诊成「事务已结束」（internal），而 Store 自己的方法是 `usage`「数据库连接已关闭」。
          // 同一个坏状态两种分类 = Agent 拿到两种退出码（1 vs 2）。
          const assertProjection = (): void => {
            if (closed) throw usage('数据库连接已关闭')
            if (!inTx || alsTx.getStore() !== token) throw txEndedError()
          }
          // 方法一律 `async`：守卫的拒绝必须以 **rejected promise** 呈现（与类型契约一致），
          // 同步 throw 会让调用方在 `await` 之前就炸。
          const tx: WriteTx = {
            tables: async () => { assertProjection(); return store.tables() },
            count: async (t: string) => { assertProjection(); return store.count(t) },
            upsert: async (t: string, rows: Record<string, unknown>[]) => { assertProjection(); return store.upsert(t, rows) },
            delete: async (t: string, w: string, p?: unknown[]) => { assertProjection(); return store.delete(t, w, p) },
            transaction: async <U>(f: (tx2: WriteTx) => Promise<U>) => { assertProjection(); return store.transaction(f) },
          }
          const r = await fn(tx)
          await commitOrRefuse(token)
          return r
        })
      } catch (e) {
        // ROLLBACK 也走 `execSql`：在令牌上下文里发，闸门才认得它属于本事务（若 BEGIN 都没
        // 成功，`safeRollback` 吞掉「没有事务」的次生错误）。⚠️ `commitOrRefuse` 抛出的拒绝
        // 已在身份集合里：回滚已由它负责，这里不再回滚第二次（CR 第三十六轮 major）。
        if (!isRefusal(e, token)) throw annotateUnconfirmedRollback(e, await rollbackInTx(token))
        throw e
      } finally {
        inTx = false
        txToken = undefined
        releaseTokenState(token)
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
