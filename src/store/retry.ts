// src/store/retry.ts
// ⚠️ 曲线是**固定间隔**（实测 2.6s/13 次成功 ≈ 200ms 间隔，spec §5.2）——
// 不是指数：指数曲线在剩余预算不足时会大幅越过 maxMs。

/**
 * 锁冲突的识别：**模板**匹配，不是子串搜索。
 *
 * 真实报文（跨进程真持锁，@duckdb/node-api 1.5.6-r.1）。**两种平台形态**（都逐字实测）：
 *   · macOS：`IO Error: Could not set lock on file "<路径>": Conflicting lock is held in
 *     /Users/x/.nvm/…/bin/node (PID 83991) by user x. See also https://…`
 *   · Linux：`… Conflicting lock is held in /opt/hostedtoolcache/node/24.22.1/x64/bin/node
 *     (PID 4894). See also https://…` —— **没有 ` by user ` 那段**。
 * 首版判据锚了三段（含 ` by user `），那是**只在本机探针过**的产物：CI 立刻在
 * Node 20.12/22/24 上全红（同一个用例在我这里是绿的）。教训与「采样源按平台核对」同族 ——
 * 探针跑在哪个平台，判据就只对那个平台成立。现只锚两段跨平台实测都有的骨架。
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
 * 判据锚 DuckDB 自己的**模板骨架**：句首 `IO Error: Could not set lock on file "<路径>": `
 * 与紧随的 `Conflicting lock is held in `。两段都不在路径里，第二种报文命中不了
 *（`not a valid DuckDB database file` 那句句首是 `The file `）。
 * ⚠️ 边界如实记录：路径由用户给出且会被原文嵌入，理论上可以构造一个路径让这句看起来
 * 也像别的报文；但那要求整条报文**以** `IO Error: Could not set lock on file "` 开头，
 * 而只有锁报文会这样开头 —— 放宽的代价（上面那 30 秒假锁 + 假 retryable）则是实测发生的。
 *
 * 与 spec §5.2 原文「message 含 `Conflicting lock`」的偏离是**有意**的：那句话写于
 * 判据只有一处消费点、且假设报文只可能是锁报文的时候。
 */
export function isLockError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return /^IO Error: Could not set lock on file "[\s\S]*": Conflicting lock is held in /i.test(msg)
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
 *   · 文件已损坏：    `IO Error: Could not read enough bytes from file "…": attempted to read
 *                     74432 bytes from location 200000`（被截断 —— 元数据块在文件尾部）
 *                     `IO Error: Corrupt database file: computed checksum 5381 does not
 *                     match stored checksum 0 in block at location 8192`（页校验和不对）
 *                     —— 两条都是 2026-11-05 在本机真跑出来的原文（rw/ro 两种打开方式相同）。
 * 判据**锚句尾的真因**（`:` + 原因 + 结尾），不能子串搜索 —— 路径里可能恰好含这些词
 * （`/tmp/Permission denied.db` 报 `No such file or directory` 会被子串判误命中）。
 * 损坏的两条锚**句首**：路径由用户给出且被原文嵌入，句首的 `IO Error: ` 骨架只有 DuckDB
 * 自己的报错会有，路径再花哨也伪装不出来。
 */
export type OpenFailure =
  | { cause: 'not_duckdb' }
  | { cause: 'permission' }
  | { cause: 'corrupt' }

/** 「不是 DuckDB 数据库文件」的 hint（单一文案，store/query 共用）。 */
export const NOT_DUCKDB_HINT = '该路径已存在且不是 DuckDB 数据库，请换 --db 路径'

/**
 * 「权限不足」的 hint（单一文案，store/query 共用）。
 * ⚠️ 保持**读写中性**：`status`/`query` 是只读命令，说「写权限」会把只读者引向 `store init`。
 */
export const PERMISSION_HINT = '请检查路径与所在目录的读写权限（磁盘只读也会导致无法打开）'

/**
 * 「文件已损坏」的 hint（单一文案，store/query/sync 共用）。
 *
 * ⚠️ 2026-11-05 审查修：此前「截断 / 页校验和不对」两类报文既不匹配权限、也不匹配
 * 「非 DuckDB 文件」，落进各命令自己的兜底 —— `store status` 说「数据库执行期错误，
 * 请用 store status 检查」（拿自己查自己），`query` 说「请确认文件存在且由本 CLI 创建
 * （store init）」—— 而对已损坏的文件原地跑 `store init` 打开同样失败，是条死路。
 * hint 必须先给备份（文件里是用户已同步的数据），再给可执行的恢复路径（新路径重建）。
 */
export const CORRUPT_HINT = '该文件已损坏（写入中断、磁盘写满、复制不完整都会造成），原地跑 store init 修不好，查询也会失败。请先备份该文件留档，再用 --db 指向一个新路径跑 store init 重建 —— 本地库只是缓存，之后带同一个 --db <新路径> 跑 qiyu sync run 重新拉取（不带 --db 的 sync run 仍会读到这个损坏的文件）'

const OPEN_FAILURE_HINTS: Record<OpenFailure['cause'], string> = {
  not_duckdb: NOT_DUCKDB_HINT,
  permission: PERMISSION_HINT,
  corrupt: CORRUPT_HINT,
}

/** 成因 → hint 的唯一映射点（`Record` 保证新增成因时编译期就漏不掉）。 */
export function openFailureHint(f: OpenFailure): string {
  return OPEN_FAILURE_HINTS[f.cause]
}

export function classifyOpenFailure(e: unknown): OpenFailure | null {
  const msg = e instanceof Error ? e.message : String(e)
  if (/is not a valid DuckDB database file!?$/.test(msg)) return { cause: 'not_duckdb' }
  if (/:\s*(Permission denied|Operation not permitted|Read-only file system)\s*$/.test(msg)) {
    return { cause: 'permission' }
  }
  if (/^IO Error: Could not read enough bytes from file "/.test(msg)) return { cause: 'corrupt' }
  if (/^IO Error: Corrupt database file:/.test(msg)) return { cause: 'corrupt' }
  return null
}

export interface RetryOpts<T> {
  tryOpen: () => Promise<T>
  isRetryable: (e: unknown) => boolean
  maxMs: number
  intervalMs?: number
  /**
   * 单次尝试的上限（毫秒）。⚠️ 2026-11-14（历史审查 PR#4 复核）：截止时间此前只在
   * `tryOpen()` **抛错后**才比较，打开调用一直不返回（网络盘 / 卡住的锁等待）时等待
   * 没有上界，`store status` 会无限挂着。不传则沿用旧的「不设单次上限」语义
   * （既有调用方与测试不受影响）。
   */
  attemptMs?: number
  /** 超时后被放弃的那次尝试**最终成功**时回调 —— 调用方据此关掉连接/实例（防泄漏）。 */
  onAbandoned?: (v: T) => void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 单次尝试超时：`isRetryable` 之外由 `retryWithBackoff` 自行按可重试处理。 */
class AttemptTimeout extends Error {
  constructor(ms: number) { super(`打开超过 ${ms}ms 未返回`) }
}

function withAttemptTimeout<T>(p: Promise<T>, ms: number | undefined): Promise<T> {
  if (ms === undefined) return p
  let timer: ReturnType<typeof setTimeout> | undefined
  // `unref`：这个只用于计时的 handle 不应把进程留在前台（CodeRabbit PR#74 —— 原生
  // `create/connect` 卡住时，CLI 该按 store_locked 退出，而不是被内部计时器吊住）。
  // 它不会让超时失效：被 race 的那条 attempt 自己持有的 I/O handle 仍然算活跃。
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new AttemptTimeout(ms)), ms)
    ;(timer as { unref?: () => void }).unref?.()
  })
  return Promise.race([p, timeout]).finally(() => { if (timer !== undefined) clearTimeout(timer) })
}

/** 有界重试：可重试错误按固定间隔重试至 maxMs，超限抛最后一个错误。 */
export async function retryWithBackoff<T>(opts: RetryOpts<T>): Promise<T> {
  const intervalMs = opts.intervalMs ?? 200
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? (() => Date.now())
  const start = now()
  for (;;) {
    let attempt: Promise<T>
    try {
      attempt = opts.tryOpen()
    } catch (e) {
      // 同步抛出也按普通失败处理（此前会直接冒泡、绕过预算判断）
      attempt = Promise.reject(e)
    }
    // 单次尝试的上限还要被**剩余总预算**夹住（CodeRabbit PR#74）：否则 30s 预算里
    // 前面撞锁花掉 29s 后，下一次尝试仍能再跑满 30s —— 实际等待近 60s。
    // （`noRetry` 的下限 1ms 只影响等待已耗尽时的最后一击，让它有界而不是零。）
    const remainingMs = opts.maxMs - (now() - start)
    const attemptCap = opts.attemptMs === undefined ? undefined
      : Math.max(1, Math.min(opts.attemptMs, remainingMs))
    try {
      return await withAttemptTimeout(attempt, attemptCap)
    } catch (e) {
      const timedOut = e instanceof AttemptTimeout
      if (timedOut && opts.onAbandoned !== undefined) {
        // 被放弃的尝试若稍后成功，结果必须交回清理（连接/实例泄漏 = 多一个锁持有者）。
        attempt.then((v) => opts.onAbandoned!(v), () => {})
      }
      if (!timedOut && !opts.isRetryable(e)) throw e
      if (now() - start + intervalMs > opts.maxMs) {
        // 超时且没有更具体的成因时，给调用方一个可识别的锁语义（与既有 store_locked 包装同源）
        // 用自有字段而不是标准的 `cause`（那应该是 Error，写成字符串会误导诊断）
        throw timedOut
          ? Object.assign(new Error(`打开超时（${opts.attemptMs}ms 内未返回，等待 ${opts.maxMs}ms 后放弃）`),
            { timedOut: true })
          : e
      }
      await sleep(intervalMs)
    }
  }
}
