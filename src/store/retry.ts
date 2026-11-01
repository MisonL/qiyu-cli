// src/store/retry.ts
// ⚠️ 曲线是**固定间隔**（实测 2.6s/13 次成功 ≈ 200ms 间隔，spec §5.2）——
// 不是指数：指数曲线在剩余预算不足时会大幅越过 maxMs。

/**
 * 锁冲突的识别：**模板**匹配，不是子串搜索。
 *
 * 真实报文（探针逐字，@duckdb/node-api 1.5.6-r.1、跨进程真持锁）：
 *   `IO Error: Could not set lock on file "<路径>": Conflicting lock is held in
 *    /usr/bin/node (PID 83991) by user mison. See also https://duckdb.org/docs/stable/connect/concurrency`
 *
 * ⚠️⚠️ **不能**只搜 `Conflicting lock` 子串（2026-11-01 实测，形态「报文里嵌了用户给的
 * 路径」）：DuckDB 的**其它**报文同样把库路径原文嵌进去 ——
 * `IO Error: The file "/tmp/Conflicting lock/q.db" exists, but it is not a valid
 *  DuckDB database file!`（路径里恰好含这两个词）。子串判于是把**非 DuckDB 文件**
 * 判成撞锁：`db tables` / `store status` 会**白白退避 30 秒**再报「数据库被写进程占用」，
 * `retryable: true` 还把 Agent 引向「稍后重试」—— 而真相是那个路径根本不是数据库文件，
 * 重试一万次也一样。实测：`db tables --db '/tmp/qreview/Conflicting lock/q.db'` 耗时
 * 30.1s、`kind: store_locked`；同一份内容放在不含该词的路径上 0.4s 就给出正确的
 * `store_not_initialized`。
 *
 * 判据因此锚住 DuckDB 自己的**模板骨架**：句首 `IO Error: Could not set lock on file `、
 * 冒号后 `Conflicting lock is held in `、以及所有者片段 ` by user `。三处都不在路径里
 * 就没有第二种报文能命中（`not a valid DuckDB database file` 那句句首是 `The file `）。
 * ⚠️ 边界如实记录：路径由用户给出且会被原文嵌入，理论上可以构造一个同时凑齐这三段的
 * 路径；代价是那个路径**必须**长得就像 DuckDB 的锁报文 —— 比「恰好含两个词」苛刻得多，
 * 而放宽的代价（上面那 30 秒假锁 + 假 retryable）是实测发生的。
 *
 * 与 spec §5.2 原文「message 含 `Conflicting lock`」的偏离是**有意**的：那句话写于
 * 判据只有一处消费点、且假设报文只可能是锁报文的时候。
 */
export function isLockError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /^IO Error: Could not set lock on file "[\s\S]*": Conflicting lock is held in [\s\S]* by user /i.test(msg)
}

/**
 * 识别「模块找不到」并取出缺失的 specifier（spec §5.1 的二分规则）。
 *
 * ⚠️ **两种错误码都要认**（2026-10-31 实测修）：此前只认 `ERR_MODULE_NOT_FOUND`，
 * 而那只可能在 **ESM 解析**阶段出现 —— 能命中它的 specifier 恒是 `@duckdb/node-api`
 * 本身（整个包不装时）。**平台 binding 缺失**是另一条路径：`@duckdb/node-bindings`
 * 用的是 **CJS `require`**（`duckdb.js` 里 `require('@duckdb/node-bindings-<平台>/duckdb.node')`），
 * 抛出的 `e.code` 是 **`MODULE_NOT_FOUND`**（无 `ERR_` 前缀）。实测（删掉平台包后真跑）：
 *   · `code = "MODULE_NOT_FOUND"`
 *   · `msg  = "Cannot find module '@duckdb/node-bindings-darwin-x64/duckdb.node'"`
 * 只认 ESM 码时这条一路返回 null → `depError` 的二分退化成单一分支，**「当前平台无预编译包」
 * 那句 hint 在生产上从未被执行过**，Agent 拿到的是「未安装 DuckDB 依赖，请 npm install
 * @duckdb/node-api」—— 而 `@duckdb/node-api` **本来就装着**（缺的是它的平台子包），
 * 照 hint 重装修不好。这正是该分支存在的唯一理由（optionalDependency 在不支持的平台漏装）。
 *
 * 报文两种形态都覆盖：ESM 是 `Cannot find package '…'`、CJS 是 `Cannot find module '…'`
 * （注意 binding 那条的 specifier 带 `/duckdb.node` 后缀，`startsWith('@duckdb/node-bindings')`
 * 仍然成立）。
 */
export function isModuleNotFound(e: unknown): { missing: string } | null {
  const err = e as { code?: string; message?: string }
  if (err?.code !== 'ERR_MODULE_NOT_FOUND' && err?.code !== 'MODULE_NOT_FOUND') return null
  const m = /Cannot find (?:package|module) '([^']+)'/.exec(err.message ?? '')
  return { missing: m?.[1] ?? '' }
}

/**
 * 「打开库文件失败」的成因分类（2026-10-31 单一实现点）。
 *
 * 三处会打开库文件、并按「打开失败」做成因分流：`commands/store.ts` 的 `thrownToExit`、
 * `query/sandbox.ts` 的 `openSandbox`、`commands/sync-run.ts` 的 `storeInitFail`。
 * 分到 `store/retry.ts`（query 白名单里
 * `store/retry.ts` 是纯函数、可 import），让同一份「打开失败」的解码规则只存在一处
 * —— 此前三处各写各的判据，同一输入在不同命令族上给出矛盾的 hint：
 * `chmod 000` 的文件，`store status` 说「请检查读写权限」、`query` 却说
 * 「请确认数据库文件存在且由本 CLI 创建（store init …）」。
 *
 * ⚠️ **报文形态（探针 + 二进制模板确认）**：到达这里的都是 **DuckDB 原生错误**，
 * 不是 Node `fs` 的 errno（`e.code` 为 `undefined`、strerror 在句尾）：
 *   · 非 DuckDB 文件：`IO Error: The file "…" exists, but it is not a valid DuckDB database file!`
 *   · 权限不足：      `IO Error: Cannot open file "…": Permission denied`
 *                     （`Operation not permitted` = EPERM / `Read-only file system` = EROFS）
 * 判据**锚句尾的真因**（`:` + 原因 + 结尾），不能子串搜索 —— 路径里可能恰好含这些词
 * （`/tmp/Permission denied.db` 报 `No such file or directory` 会被子串判误命中）。
 */
export type OpenFailure =
  | { cause: 'not_duckdb' }
  | { cause: 'permission' }

/** 「不是 DuckDB 数据库文件」的 hint（单一文案，store/query 共用）。 */
export const NOT_DUCKDB_HINT = '该路径已存在且不是 DuckDB 数据库，请换 --db 路径'

/**
 * 「权限不足」的 hint（单一文案，store/query 共用）。
 * ⚠️ 保持**读写中性**：`status`/`query` 是只读命令，说「写权限」会把只读者引向 `store init`。
 */
export const PERMISSION_HINT = '请检查路径与所在目录的读写权限（磁盘只读也会导致无法打开）'

export function classifyOpenFailure(e: unknown): OpenFailure | null {
  const msg = e instanceof Error ? e.message : String(e)
  if (/is not a valid DuckDB database file!?$/.test(msg)) return { cause: 'not_duckdb' }
  if (/:\s*(Permission denied|Operation not permitted|Read-only file system)\s*$/.test(msg)) {
    return { cause: 'permission' }
  }
  return null
}

export interface RetryOpts<T> {
  tryOpen: () => Promise<T>
  isRetryable: (e: unknown) => boolean
  maxMs: number
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 有界重试：可重试错误按固定间隔重试至 maxMs，超限抛最后一个错误。 */
export async function retryWithBackoff<T>(opts: RetryOpts<T>): Promise<T> {
  const intervalMs = opts.intervalMs ?? 200
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? (() => Date.now())
  const start = now()
  for (;;) {
    try {
      return await opts.tryOpen()
    } catch (e) {
      if (!opts.isRetryable(e)) throw e
      if (now() - start + intervalMs > opts.maxMs) throw e
      await sleep(intervalMs)
    }
  }
}
