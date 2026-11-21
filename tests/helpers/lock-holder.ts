// tests/helpers/lock-holder.ts —— 跨进程 DuckDB 锁夹具的**唯一实现点**（2026-11-19 抽取）。
//
// 背景：撞锁只在跨进程成立（同进程多实例直线放行），所以每条撞锁用例都要 spawn 子进程。
// 这段夹具此前被**复制了四份**（tests/store/duckdb.test.ts ×3、tests/commands/store.test.ts ×1），
// 四份里都带着同一个 load-fragile 缺陷：等待「持有者就绪」的硬上限写成 5 s，校验进程 10 s。
//
// ⚠️ 为什么 5 s 是错的（有实测出处）：子进程是**新进程**，不吃 `tests/setup-warm.ts` 的
// 进程内预热，必须自己加载原生绑定。本仓库记录的高负载首开是 10–34 s，极端记录 89.5 s
// （HANDOFF / 记忆 local-load-slow-duckdb-startup）。负载一高，持有者其实**正在正常启动**，
// 用例却报「锁持有者未能启动」并 SIGKILL —— 把「机器忙」误报成「夹具坏了」，且不可重试
// （重试也是同一个 5 s）。四份复制意味着四份同样的假红。
//
// ⚠️ 预算模型：**一个截止时刻（deadline）贯穿整条用例**，每次等待只花剩余预算。
// 不设「持有者 60 s / 校验 60 s / 循环 5 轮」三个独立常量 —— 那些数字互相兜不住，
// 最坏路径会先撞 vitest 的用例超时，把「环境过慢」报成「锁竞态超预期」。现在：
//   · 用例自己定 `deadline = Date.now() + LOCK_BUDGET_MS`，传给我们；
//   · 任何一次等待超预算就抛错，错误消息点明「预算耗尽」并带上子进程原始输出；
//   · 所以一条用例的墙钟上界 ≈ LOCK_BUDGET_MS + 一轮的少量开销，用例超时应设在它之上。
// 慢与竞态是两件事：竞态重试是毫秒级的，慢是环境问题 —— 预算耗尽时**不许**接着重试。
//
// ⚠️ 就绪信号也加固了：持有者先建实例、连上、跑一条语句再打印 `locked`。语句执行成功
// 即证明写事务已取得，文件锁此刻必然在盘上。探针对照（2026-11-19，本机，20 轮）：跑语句
// 后立刻用独立子进程重新打开，**20/20 CONFLICT**；旧形态（建完实例就打标记）同一探针
// 12/12 也 CONFLICT —— 说明旧信号**通常**没问题，但「通常」正是间歇红的定义，跑一条 DDL
// 把「锁已落盘」变成可观测事实，代价可以忽略。`lockVerdict` 仍保留为第二道校验：它来自
// **另一个**进程视角，能挡住本进程实例缓存造成的误判。
//
// ⚠️ 子进程一律用**脚本文件**而非 `-e`：`-e` 里的动态 import 依赖 shell 引号，历史上
// 出现过被截断后静默不启动、只红成「未能启动」的形态。
//
// ⚠️ 生命周期约束（一切失败收尾的单一实现点）：
//   · spawn 被 OS 拒绝时 Node 只发 `error`（实测 Node 24：`error` → `close(-2)`，**没有**
//     `exit`），所以 `error` 必须有监听者，且必须原样交回调用方 —— 它是夹具/环境问题，
//     不是锁竞态，不能落成未捕获异常，也不能换个错误顶替。
//   · 预算耗尽时先 `kill('SIGKILL')`，再等**真实 `close`**（`exit` 只表示进程结束，
//     stdio/文件句柄可能仍未放开）；调用方在 close 之前不得开始下一轮或删临时目录。
//   · 等待 close 有界：先花剩余业务预算，再给 `CLOSE_GRACE_MS` 宽限；等不到就以
//     `cause` 带上原始错误响亮失败 —— 既不无限挂住，也不把「清理未确认」说成正常结论。
//   · `kill` 本身可能抛/触发 `error`（EPERM 等）：那也是原始失败，不得被吞成 TIMEOUT。
import { spawn, type ChildProcess } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isLockError } from '../../src/store/retry.js'

/** `@duckdb/node-api` 的 ESM 入口（子进程按绝对 URL import，不依赖 cwd）。 */
export const PKG_URL = new URL('../../node_modules/@duckdb/node-api/lib/index.js', import.meta.url)

/**
 * 一条跨进程锁用例的**总预算**。取 300 s：实测极端首开 89.5 s，持有者 + 校验至少要
 * 两次；再留出让「一次竞态换轮」发生的余量。用例的 `{ timeout }` 必须设在它之上
 * （建议 + 60 s），否则会先被 vitest kill，丢掉我们精心写好的归因。
 */
export const LOCK_BUDGET_MS = 300_000

/**
 * SIGKILL 之后等 `close` 的宽限。SIGKILL 不可被捕获，正常进程在毫秒级结束；等不到
 * 只可能是 stdio 仍被后代继承或句柄被别处接管 —— 那种情况必须响亮失败而不是无限挂住。
 */
export const CLOSE_GRACE_MS = 5_000

let seq = 0
function runScript(script: string, scriptDir: string, name: string, deadline: number): ChildProcess {
  assertBudget(deadline, `${name}：脚本写入`)
  const path = join(scriptDir, `${name}-${++seq}.mjs`)
  writeFileSync(path, script)
  // ⚠️ **写完脚本、spawn 之前再复核一次截止**（CR 第六十五轮 major）：`writeFileSync` 在高
  // 负载磁盘上可能吃掉整个预算，若只在入口查一次，子进程会在截止之后才起来、可能先动到库
  // 文件，超时清理时它已在跑。入口检查保留（迟到的请求不写脚本），这里是第二道。
  assertBudget(deadline, `${name}：准备起子进程`)
  return spawn(process.execPath, [path], { stdio: ['ignore', 'pipe', 'pipe'] })
}

/**
 * 一个脚本子进程的生命周期：收集输出、接住 `error` / `kill` 的原生错误、提供有界的
 * 「等 close」与「请求终止并等 close」。
 *
 * ⚠️ `error` 监听**直到 close 都不摘**：spawn 被 OS 拒绝时它是唯一的失败信号，
 * `kill` 失败时它也可能迟到 —— 摘早了就是未捕获异常，直接带走测试进程。
 */
class ScriptRun {
  readonly child: ChildProcess
  /** stdout + stderr 合并（`holder` 只需要原始输出）。 */
  out = ''
  /** 仅 stdout / 仅 stderr（`verdict`、`seed` 需要分开解析）。 */
  stdout = ''
  stderr = ''
  /** 第一个原生错误（spawn 或 kill），原样保存、只认第一个。 */
  nativeError: Error | undefined
  /** spawn 是否根本没起来（`pid === undefined`）—— 还没启动的进程不该收到 SIGKILL。 */
  neverSpawned = false
  /** 已收到某个原生错误（结束原因不再是「预算耗尽」）。 */
  get failedNative(): boolean { return this.nativeError !== undefined }
  closed = false
  exit: { code: number | null; signal: NodeJS.Signals | null } | null = null
  /** 观察到 `close` 的时刻：调用方拿它跟 deadline 比「是否按时结束」（见 `waitClosed` 注释）。 */
  closedAt: number | undefined
  private killed = false
  private killAccepted = false
  markKill(result: boolean): void { this.killed = true; this.killAccepted = result }
  get killInfo(): { requested: boolean; accepted: boolean } {
    return { requested: this.killed, accepted: this.killAccepted }
  }
  private closeWaiters: Array<() => void> = []
  private errorWaiters: Array<() => void> = []
  private spawnSentinel: ReturnType<typeof setTimeout> | undefined

  constructor(child: ChildProcess) {
    this.child = child
    this.neverSpawned = child.pid === undefined
    child.on('error', this.onError)
    child.on('exit', this.onExit)
    child.on('close', this.onClose)
    child.stdout?.on('data', this.onData)
    child.stderr?.on('data', this.onErrData)
    if (this.neverSpawned) {
      // pid 已确定是 undefined：spawn 已失败（或失败在即）。100ms 短哨兵只为等到零延迟的
      // `error`；到点仍没有就自己记一条，避免未启动进程白等业务预算。
      this.spawnSentinel = setTimeout(() => {
        this.spawnSentinel = undefined
        if (this.nativeError === undefined) {
          this.nativeError = new Error('spawn 未启动（pid 未返回）且 100ms 内未收到 error 事件')
        }
        for (const w of this.errorWaiters.splice(0)) w()
      }, 100)
    }
  }

  private onData = (d: unknown): void => { this.out += String(d); this.stdout += String(d) }
  private onErrData = (d: unknown): void => { this.out += String(d); this.stderr += String(d) }
  private onError = (e: Error): void => {
    this.nativeError ??= e
    for (const w of this.errorWaiters.splice(0)) w()
  }
  private onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.exit ??= { code, signal }
  }
  private onClose = (code: number | null, signal: NodeJS.Signals | null): void => {
    this.exit ??= { code, signal }
    this.closed = true
    // ⚠️ 「最终 close 了」与「按时 close 了」是两件事（CR 第五十五轮 major）：高负载下截止
    // 定时器可能迟到，close 事件先被处理 —— 只看布尔会把过期后的清理结果当成按时完成。
    this.closedAt = Date.now()
    for (const w of this.closeWaiters.splice(0)) w()
    if (this.errorWaiters.length > 0 && this.nativeError !== undefined) {
      for (const w of this.errorWaiters.splice(0)) w()
    }
  }

  /** 未启动进程的终态：返回 `true` 表示 `nativeError` 已有值（真实 error 或 100ms 哨兵合成）。 */
  async waitSpawnError(): Promise<boolean> {
    if (this.nativeError === undefined && !this.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          const i = this.errorWaiters.indexOf(waiter)
          if (i >= 0) this.errorWaiters.splice(i, 1)
          resolve()
        }, 100)
        const waiter = (): void => { clearTimeout(timer); resolve() }
        this.errorWaiters.push(waiter)
      })
    }
    // ⚠️ **error 不等于 stdio 已关**（CR 第六十二轮 major）：Node 在 spawn 失败后仍会发
    // `close`（实测 error → close(-2)）；pid 缺失只说明没有可发信号的进程，不代表文件句柄
    // 已经放开。等有界的 close，拿不到就如实返回 false —— 调用方按「清理未确认」处理，
    // 不在这之前删目录 / 换轮。
    if (this.closed) return true
    return this.waitOne(CLOSE_GRACE_MS)
  }

  /**
   * 等 `close`，最多 `budgetMs + CLOSE_GRACE_MS`：先给剩余业务预算（正常进程自己会退出），
   * 到点请求 SIGKILL，再给一段宽限。返回 `true` 只表示**真的收到了 close**；
   * ⚠️ 是否**按时**结束要看 `closedAt`（CR 第五十五轮 major）：迟到到达的 close 同样返回
   * `true`，但 `closedAt > deadline` —— 调用方据此把「过期清理」与「按时完成」分开。
   * 超时返回 `false`，由调用方带着 `finalFailure()` 响亮失败。
   * ⚠️ 未启动的进程（`pid === undefined`）不会再有 close：它的结束信号是 `error`。
   */
  async waitClosed(budgetMs: number, opts: { killOnBudget?: boolean } = {}): Promise<boolean> {
    if (this.neverSpawned) return this.waitSpawnError()
    if (await this.waitOne(budgetMs)) return true
    if (!(opts.killOnBudget ?? true)) return false
    this.requestKill()
    return this.waitOne(CLOSE_GRACE_MS)
  }

  /** 就绪前失败：立刻请求终止（若已启动），再等真实 close / 原生 error。 */
  async settleFailure(): Promise<boolean> {
    if (this.closed) return true
    if (this.neverSpawned) return this.waitSpawnError()
    this.requestKill()
    return this.waitOne(CLOSE_GRACE_MS)
  }

  /** 等 `close`，最多 `budgetMs`；到点返回 `false`（不在内部请求终止）。 */
  private waitOne(ms: number): Promise<boolean> {
    if (this.closed) return Promise.resolve(true)
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      const waiter = (): void => {
        if (timer !== undefined) clearTimeout(timer)
        resolve(this.closed)
      }
      this.closeWaiters.push(waiter)
      timer = setTimeout(() => {
        const i = this.closeWaiters.indexOf(waiter)
        if (i >= 0) this.closeWaiters.splice(i, 1)
        resolve(this.closed)
      }, Math.max(ms, 0))
    })
  }

  /**
   * 请求 SIGKILL。⚠️ `kill` 会同步抛（EPERM 等）或触发 `error` 事件 —— 两种形态都是
   * 原始失败，必须留在 `nativeError` 里，不能被后面的「结论」吞掉。
   * 返回 kill 是否被受理；未启动的进程不发信号（没有可杀的 PID）。
   */
  requestKill(): boolean {
    if (this.closed || this.neverSpawned) return false
    if (this.killed) return this.killAccepted
    let result = false
    try {
      result = this.child.kill('SIGKILL')
    } catch (e) {
      this.nativeError ??= e instanceof Error ? e : new Error(String(e))
      result = false
    }
    // kill 期间同步触发过 error（EPERM 等）：信号没有生效。
    this.markKill(result && this.nativeError === undefined)
    return this.killAccepted
  }

  /**
   * 失败收尾的统一描述：第一个原生错误优先原样返回（spawn/kill 的原始 cause 不丢），
   * 否则带上「close 未确认 + kill 是否受理 + 原始输出」的合成错误。
   */
  finalFailure(summary: string): Error {
    const detail = describeTerm(this)
    // 已确认 close（含未启动的进程收到 error 后的 close）→ 原始 error 就是全部事实，
    // 原样交回，调用方拿到的仍是原始对象。
    // ⚠️ **未启动不等于 stdio 已关**（CR 第六十二轮 major）：close 未确认时不能把原始错误
    // 当成「清理已完成」的结论文案 —— 合成错误把 close 未确认说清楚，原始错误挂在 cause 上。
    if (this.nativeError !== undefined && this.closed) {
      return this.nativeError
    }
    if (this.nativeError !== undefined) {
      return new Error(`${this.nativeError.message} —— ${detail}`, { cause: this.nativeError })
    }
    return new Error(`${summary} —— ${detail}`)
  }

  /** 释放监听；已建立的监听在 dispose 之后不再影响断言。迟到的 `error` 仍需有人兜，
   *  否则会在调用方已拿到结果之后冒成未捕获异常、带走测试进程。 */
  dispose(): void {
    if (this.spawnSentinel !== undefined) { clearTimeout(this.spawnSentinel); this.spawnSentinel = undefined }
    this.child.off('exit', this.onExit)
    this.child.stdout?.off('data', this.onData)
    this.child.stderr?.off('data', this.onErrData)
    this.child.off('close', this.onClose)
    this.child.off('error', this.onError)
    this.closeWaiters.splice(0)
    this.errorWaiters.splice(0)
    this.child.on('error', noopError)
  }
}
function noopError(): void { /* 迟到的原生错误不再有归因价值；兜住不让它冒成未捕获异常。 */ }

/**
 * 终止结果的**唯一措辞点**：`kill` 是否被受理、`close` 是否到达是两件事，错误里必须分开，
 * 否则「信号没送出去」会被说成「进程不肯退出」，归因就错了。
 */
function describeTerm(run: ScriptRun): string {
  const kill = run.killInfo
  const out = run.out.slice(0, 400) || '(空)'
  const stderr = run.stderr.slice(0, 400) || '(空)'
  // ⚠️ **pid 放在唯一措辞点**（CR 第五十四轮 major #9）：终止失败时调用方拿不到句柄，可能仍
  // 活着的进程只能靠文案里的 pid 处理 —— 每条失败描述都带它，避免某个调用点漏写。
  const pid = run.child.pid
  const pidNote = pid === undefined ? '' : `（子进程 pid ${pid}）`
  const tail = `stdout：${out}；stderr：${stderr}`
  if (run.closed) {
    return kill.requested
      ? `已请求 SIGKILL 并确认 close（kill 返回 ${kill.accepted}）${pidNote}；${tail}`
      : `子进程自身已 close（未请求 SIGKILL）${pidNote}；${tail}`
  }
  if (!kill.requested) return `${CLOSE_GRACE_MS}ms 内未等到 close，且从未请求 SIGKILL${pidNote}；${tail}`
  return `请求 SIGKILL 后 ${CLOSE_GRACE_MS}ms 内未等到 close（kill 返回 ${kill.accepted}）${pidNote}；${tail}`
}

/**
 * 就绪信号的判据：stdout 里出现**完整的一行** `marker`。
 *
 * ⚠️ 只看 stdout、且必须整行（CR 第四十二轮 major）：此前搜的是 stdout+stderr 合并串的
 * **子串**，一条启动失败把 `locked` 带进 stderr（例如打不开 `/tmp/locked/q.db`）就会被
 * 当成就绪 —— 用例随后拿一个从未拿到锁的 holder 当「锁已持有」，把夹具失败说成锁生效。
 * 分块到达由调用方轮询累积的 stdout 自然兜住（`loc` + `ked\n` 两段仍拼得出整行）。
 */
function stdoutHasMarkerLine(stdout: string, marker: string): boolean {
  const lines = stdout.split('\n')
  // ⚠️ **最后一段没有换行收尾 —— 它可能只是半行**（CR 第六十三轮 major）：stdout 先到
  // `locked`、随后到 `-failed\n` 时，把半行当整行就会把启动失败当成「锁已持有」。
  lines.pop()
  return lines.some((l) => l.trim() === marker)
}

/** 等到子进程在 stdout 打出 `marker` 整行，或它结束 / spawn 失败 / 预算耗尽。 */
async function waitForMarker(
  child: ChildProcess, marker: string, deadline: number, what: string,
): Promise<void> {
  const run = new ScriptRun(child)
  const budget = deadline - Date.now()
  // ⚠️ **就绪必须发生在 deadline 之内**（CR 第五十四轮 major #7）：截止定时器到点后仍去读
  // 「此刻是否就绪」时，高负载下定时器本身会迟到，一条**截止之后**才到的 marker 就被当成就绪。
  // 记录 marker 首次被观察到的时刻（data 事件即时更新），判定以它为准。
  let markerSeenAt: number | undefined
  const onMarkerData = (): void => {
    if (markerSeenAt === undefined && stdoutHasMarkerLine(run.stdout, marker)) markerSeenAt = Date.now()
  }
  child.stdout?.on('data', onMarkerData)
  const ok = await new Promise<boolean>((resolve) => {
    let done = false
    const finish = (v: boolean): void => {
      if (done) return
      done = true
      clearInterval(iv); clearTimeout(to)
      child.off('close', onClose); child.off('error', onError)
      child.stdout?.off('data', onMarkerData)
      resolve(v)
    }
    // ⚠️ **进程已结束就不再是「就绪」**（CR 第四十四轮 major）：只按「输出里有 marker」判时，
    // 一个打印了 `locked` 随后立刻退出的子进程会让我们返回一个**死 holder**，调用方以为锁还
    // 持着。判据：marker 必须在**进程仍存活**时出现；已经 `exit`/`close`/原生失败的，一律未就绪。
    const readyNow = (): boolean => run.exit === null && !run.closed && !run.failedNative
      && markerSeenAt !== undefined && markerSeenAt <= deadline
    // 轮询兜住「分块到达的 marker」与「error 已到但 close 未到」两种形态。
    const iv = setInterval(() => {
      if (readyNow()) finish(true)
      else if (run.closed || run.failedNative) finish(false)
    }, 50)
    const onClose = (): void => finish(false)
    const onError = (): void => { /* 记录在 run 里，由轮询收尾 */ }
    const to = setTimeout(() => finish(readyNow()), Math.max(budget, 0))
    child.on('close', onClose)
    child.on('error', onError)
  })
  if (ok) {
    run.dispose()
    return
  }
  // 未启动的进程不会再有 close：它的终态是 `error`（给 100ms 短哨兵，不占业务预算）。
  // 已启动的进程在预算耗尽时**立刻**请求 SIGKILL，再等真实 close（宽限有界）。
  const closed = await run.settleFailure()
  if (!closed) {
    // ⚠️ **close 未确认时 pid 必须一起说**（CR 第五十二轮 major #13）：这条路径同样不返回
    // child，调用方只能靠文案里的 pid 去处理那个可能仍活着的进程。
    const failure = run.finalFailure(`${what}在剩余预算 ${Math.max(budget, 0)}ms 内未就绪`)
    run.dispose()
    throw failure
  }
  const why = run.failedNative
    ? '启动失败'
    : budget <= 0 ? `预算已耗尽（deadline 已过 ${-budget}ms）` : `在剩余预算 ${budget}ms 内未就绪`
  // ⚠️ close 未确认时子进程**可能仍在运行**（SIGKILL 已发但 stdio 还被后代继承着）。
  // 调用方必须让用例红、**不得**换轮重试或复用这个库路径 —— 目录随用例一起删掉是安全的
  // （POSIX 上删掉仍被占用的文件不影响那个进程），但「以为进程没了」再复用路径就不是。
  // 这句必须出现在失败文案里，否则读日志的人只会看到「未就绪」。
  // ⚠️ **调用方拿不到句柄就失去了手动清理的途径**（CR 第四十六轮 major 的追问）：这里抛错时
  // `spawnLockHolder` 不会返回 child，调用方只能靠这条文案里的 pid 去处理。所以 pid 与
  // 「close 未确认」必须一起说 —— 只报「未就绪」等于把活着的进程藏起来。
  const failure = run.finalFailure(`${what}${why}`)
  run.dispose()
  throw failure
}

/**
 * 预算已过期就**不写脚本、不 spawn**（CR 第六十二轮 major）：三个入口都会先起子进程，
 * 负数预算下子进程照样先 create/modify 数据库，到点才被 kill —— 失败文案还会伪装成
 * 「未就绪」。统一在入口判一次，响亮报「预算已耗尽」。
 */
function assertBudget(deadline: number, what: string): void {
  if (Date.now() >= deadline) {
    throw new Error(`${what}：预算已耗尽（deadline 已过 ${Date.now() - deadline}ms），不再起子进程`)
  }
}
/** 起一个跨进程持锁者（RW 独占锁 / RO 共享锁），就绪后才返回。 */
export async function spawnLockHolder(
  o: { dbPath: string; scriptDir: string; name?: string; accessMode?: 'READ_ONLY' | 'READ_WRITE'; deadline: number },
): Promise<LockHolder> {
  assertBudget(o.deadline, '锁持有者')
  const script = o.accessMode === 'READ_ONLY'
    ? `const { DuckDBInstance } = await import(${JSON.stringify(PKG_URL.href)})
const inst = await DuckDBInstance.create(${JSON.stringify(o.dbPath)}, { access_mode: 'READ_ONLY' })
const c = await inst.connect()
await c.run('SELECT 1')
console.log('locked')
setInterval(() => {}, 1 << 30)`
    // ⚠️ 先跑一条 DDL 再报到：语句成功 = 写事务已取得，文件锁已在盘上。
    : `const { DuckDBInstance } = await import(${JSON.stringify(PKG_URL.href)})
const inst = await DuckDBInstance.create(${JSON.stringify(o.dbPath)})
const c = await inst.connect()
await c.run('CREATE TABLE IF NOT EXISTS lock_probe (x INTEGER)')
console.log('locked')
setInterval(() => {}, 1 << 30)`
  const child = runScript(script, o.scriptDir, o.name ?? 'holder', o.deadline)
  // ⚠️ **close / error在 spawn侧登记**（CR第六十七轮 major）：测试可能在等校验进程时
  //持有者已经自己结束 —— close事件不会重放，terminateHolder只看调用时刻的监听会白等
  //满宽限再失败。error也在这里兜住（信号送不出去 / spawn失败），terminateHolder用它的
  //原文作归因；同一监听同时避免未处理的 error冒成未捕获异常。
  const holder = child as LockHolder
  // ⚠️这两个监听是**状态标记**，不是等待原语：没有定时器、不持有引用（随 child一起回收），
  //且必须活到用例收尾才能回答「它是不是已经 close过」——`expectClean`的「零 close监听」
  //只对会挂住/泄漏的监听有意义，故用标记把它们与真正的等待监听区分开（见测试侧的过滤）。
  const onCloseMark = Object.assign((): void => { holder.lockClosed = true }, { __lockHolderTrack: true })
  const onErrorMark = Object.assign((e: Error): void => { holder.lockError ??= e }, { __lockHolderTrack: true })
  holder.on('close', onCloseMark)
  holder.on('error', onErrorMark)
  await waitForMarker(child, 'locked', o.deadline, '锁持有者')
  return child
}

/**
 * 从**另一个进程**校验锁是否真的挡住打开（绕开本进程的实例缓存）。
 * `CONFLICT` = 被锁挡住（锁生效），`OPENED` = 能打开（锁未落盘/竞态窗口），`TIMEOUT` = 预算内无结论。
 *
 * ⚠️ **只有真正的锁报文才算 CONFLICT**：子进程把结果与**原始报文**一起交回，父进程用
 * `isLockError`（`src/store/retry.ts` 的唯一实现点，锚 DuckDB 的模板骨架）判定；
 * 非锁错误、spawn 失败都直接抛出并带上原始信息，不伪装成 OPENED/TIMEOUT —— 否则撞锁用例
 * 会把「夹具坏了」当成「锁生效了」放行，或把环境问题说成平台竞态。
 */
export async function lockVerdict(
  dbPath: string, scriptDir: string, deadline: number,
): Promise<'CONFLICT' | 'OPENED' | 'TIMEOUT'> {
  assertBudget(deadline, '锁校验')
  // 子进程跑不了 TS 判据（Node 20.12 无 type stripping），所以只交回事实、由父进程判。
  const chk = runScript(`const { DuckDBInstance } = await import(${JSON.stringify(PKG_URL.href)})
try {
  const inst = await DuckDBInstance.create(${JSON.stringify(dbPath)})
  inst.closeSync()
  console.log(JSON.stringify({ v: 'OPENED' }))
} catch (e) {
  console.log(JSON.stringify({ v: 'ERROR', msg: e instanceof Error ? e.message : String(e) }))
}`, scriptDir, 'verdict', deadline)
  const run = new ScriptRun(chk)
  const closed = await run.waitClosed(deadline - Date.now())
  // ⚠️ 迟到 close（截止定时器没来得及跑、close 先交付）同样不是「按时给出结论」（CR 第五十五轮 major）。
  const closedLate = run.closedAt !== undefined && run.closedAt > deadline
  const timedOut = run.killInfo.requested && run.closed
  run.dispose()
  if (!closed) {
    // ⚠️ **close 未确认优先于原生错误**（CR 第四十七轮 major）：`kill()` 抛 EPERM 时
    // `nativeError` 有值，但子进程可能**还开着库文件** —— 先原样抛原生错误会把这件事藏起来。
    // 已启动的进程在这里一律交回「无法确认已放开库文件」，原生错误挂在 `cause` 上。
    const failure = run.finalFailure('锁校验进程在预算内未给出结论')
    // ⚠️ **未启动也不等于 stdio 已关**（CR 第六十二轮 major）：close 未确认时不能把原始
    // spawn 错误当成「已收尾」交回 —— 合成文案说清 close 未确认，原始错误经 cause 保留。
    throw new Error(`锁校验进程在预算内未给出结论 —— 无法确认它已放开库文件，不报 TIMEOUT。${failure.message}`, { cause: failure })
  }
  // close 已确认（或 spawn 没起来）：原生错误就是全部事实，原样抛出。
  if (run.nativeError !== undefined) throw run.nativeError
  if (timedOut || closedLate) return 'TIMEOUT'
  const co = run.stdout
  const errOut = run.stderr
  // 解析子进程交回的那一行 JSON（stdout 可能混入其它输出，取最后一个可解析的）。
  const parsed = co.split('\n').reverse()
    .map((l) => { try { return JSON.parse(l) as { v?: string; msg?: string } } catch { return null } })
    .find((x) => x !== null && typeof x.v === 'string')
  const how = run.exit === null
    ? '未观察到 exit'
    : run.exit.signal != null ? `signal=${run.exit.signal}` : `exit=${run.exit.code}`
  // ⚠️ **没有结论优先**（既有用例实测）：非零退出 + 无 JSON 时，最有用的是点名 stdout/stderr
  // 与退出状态；先跑下面的 exit 闸门只会把「为什么没结论」换成一句泛泛的「未正常结束」。
  if (parsed === undefined || parsed === null) {
    throw new Error(`锁校验进程未交回结论（${how}；退出后 stdout：${co.slice(0, 300) || '(空)'}；stderr：${errOut.slice(0, 300) || '(空)'}）`)
  }
  // ⚠️ **校验器必须正常退出才接受它的结论**（CR 第六十五轮 major）：`close` 只证明 stdio
  // 关掉了，不证明它跑完。写了结论后因信号（OOM / 外部 kill）而死时，那条 JSON 只是残留输出 ——
  // 接受 CONFLICT 会让用例基于一个失败的校验器通过。超时路径已在上面提前返回（那是清理，
  // 不是结论）；到这里仍非 exit 0 / 带信号 → 结论不可信，响亮失败。
  if (run.exit === null || run.exit.code !== 0 || run.exit.signal !== null) {
    throw new Error(`锁校验进程未正常结束（${how}）—— 它的输出不能当成 CONFLICT / OPENED 结论`)
  }
  if (parsed.v === 'OPENED') return 'OPENED'
  const msg = parsed.msg ?? ''
  // ⚠️ 必须包成 Error 再交给 `isLockError`：它按 `e instanceof Error` 取 message，
  // 传裸对象会 String() 成 `[object Object]`、永远判不出锁报文（实测踩过）。
  if (isLockError(new Error(msg))) return 'CONFLICT'
  // ⚠️ 夹具失败与「锁未生效」是两件事：这里必须响亮失败，不能返回 OPENED 让用例换轮重试、
  //    最后报「锁落盘竞态超预期」—— 那会把「夹具坏了 / 库路径不可建」说成平台竞态。
  throw new Error(`锁校验进程打开失败，且报错不是锁报文 —— 夹具或环境问题，不是锁竞态：${msg.slice(0, 400)}`)
}

/** RO 持有者要求文件已存在：由**子进程**建一个合法空库（父进程建会命中实例缓存）。 */
export async function seedEmptyDb(dbPath: string, scriptDir: string, deadline: number): Promise<void> {
  assertBudget(deadline, '种子进程')
  const ch = runScript(`const { DuckDBInstance } = await import(${JSON.stringify(PKG_URL.href)})
const inst = await DuckDBInstance.create(${JSON.stringify(dbPath)})
inst.closeSync()`, scriptDir, 'seed', deadline)
  const run = new ScriptRun(ch)
  const closedInBudget = await run.waitClosed(deadline - Date.now())
  // ⚠️ **close 迟到于 deadline 也不算按时完成**（CR 第五十五轮 major）：截止定时器可能迟到，
  // close 事件先被交付 —— 此时从未请求过终止，但「按时建好空库」已经不成立。
  const closedLate = run.closedAt !== undefined && run.closedAt > deadline
  if (!closedInBudget || closedLate) {
    const failure = run.finalFailure('种子进程在预算内未退出')
    run.dispose()
    if (run.nativeError !== undefined) throw failure
    const how = closedLate
      ? `它在预算之外才 close（观察到于 deadline 后 ${run.closedAt! - deadline}ms），不能证明空库按时建好`
      : '无法确认它已放开库文件'
    throw new Error(`种子进程在预算内未退出 —— ${how}。${failure.message}`, { cause: failure })
  }
  // ⚠️ **预算过期后的 close 不是完成**（CR 第五十轮 major）：`waitClosed` 到点会请求 SIGKILL，
  // 宽限里进程照样 close；若 `kill()` 未被受理（返回 false）而种子自己以 0 退出，旧实现直接
  // 返回成功 —— 但「按时建好空库」已经无法成立，那是清理的结果。判据放在 exit 码之前：
  // 只要本夹具**请求过终止**，就说明它没在预算内退出，exit 是什么都不足以证明按时完成。
  // （真按时退出（exit 0 且 close 早于预算）不会请求终止，见 `waitClosed`。）
  // ⚠️ 原生错误（kill 的 EPERM 等）是**原始失败**，优先原样交回 —— 不能让合成报文顶掉它
  // （既有用例断言身份：`toBe(原生错误)`）。
  // ⚠️ dispose **必须先于任何 throw**（既有用例的 `expectClean` 断言监听器全清）。
  run.dispose()
  if (run.nativeError !== undefined) throw run.nativeError
  if (run.killInfo.requested) {
    const how = run.exit?.signal != null ? `signal=${run.exit.signal}` : `exit=${run.exit?.code ?? 'unknown'}`
    throw new Error(`种子进程未在预算内退出（预算到期时已请求终止）—— 随后的 ${how} 只是清理结果，`
      + '不能证明空库已按时建好；RO 夹具依赖该库，换更大的 deadline 或排查环境负载')
  }
  if (run.exit?.code !== 0) {
    const how = run.exit?.signal !== null && run.exit?.signal !== undefined
      ? `signal=${run.exit.signal}`
      : `exit=${run.exit?.code ?? 'unknown'}`
    throw new Error(`种子失败：${run.stderr.slice(0, 300)}（${how}）`)
  }
}
/**
 *结束跨进程持锁者并**确认它已 close**（CR第六十六轮 major）：`kill()`只发信号 —— stdio
 *与库文件句柄可能仍未放开，调用方在 close之前删夹具目录 /复用同一路径，会把「清理未确认」
 *说成正常收尾（Windows上还会直接删不掉）。有界等待；等不到就响亮失败。
 * ⚠️只用于**当前仍在运行的**持锁者（每轮换路径的旧持有者由轮次循环自行 kill）。
 */
/** spawnLockHolder返回的句柄：close / error在 spawn侧就登记，terminateHolder才看得见迟到事件。 */
export interface LockHolder extends ChildProcess {
 /**已观察到 close（进程与 stdio都已放开）。 */
 lockClosed?: boolean
 /**原生 error事件（信号送不出去等）——终止失败时作为 cause/文案来源。 */
 lockError?: Error
}

/**
 *结束跨进程持锁者并**确认它已 close**（CR第六十六/六十七轮）：`kill()`只发信号 —— stdio
 *与库文件句柄可能仍未放开，调用方在 close之前删夹具目录 /复用同一路径，会把「清理未确认」
 *说成正常收尾（Windows上还会直接删不掉）。有界等待；等不到就响亮失败。
 * ⚠️判据分三段，各自有出处（CR第六十七轮 major）：
 * ·已经 close（spawn侧登记的 `lockClosed`）→直接返回，不再为一个不会重放的事件空等宽限；
 * · `kill()`抛错或子进程报原生 `error` → **仍然等 close**（信号没送达不等于进程没结束），
 * close到达时把原始错误照样交回（清理已确认也不吞失败）；
 * ·等不到 close →文案点名「宽限内未 close」，原生错误（如有）挂在 `cause`与正文里。
 * ⚠️只用于**当前仍在运行的**持锁者（每轮换路径的旧持有者由轮次循环自行 terminate）。
 */
export async function terminateHolder(child: LockHolder | ChildProcess | undefined,
 graceMs: number = CLOSE_GRACE_MS): Promise<void> {
 if (child === undefined) return
 const h = child as LockHolder
 // ⚠️ spawn之后、调用方收尾之前进程可能已经自己结束（测试在等校验进程时）——事件不会重放，
 //不看登记就会白等满宽限再失败（CR第六十七轮 major）。
 if (h.lockClosed === true) return
 //原生 error事件可能在我们等待期间才到（信号没送达）——先挂监听，既不漏归因也不让它冒成未捕获异常。
 let nativeError: Error | undefined = h.lockError
 const onError = (e: Error): void => { nativeError ??= e }
 h.on('error', onError)
 let timer: ReturnType<typeof setTimeout> | undefined
 const closed = new Promise<boolean>((resolve) => {
 const done = (): void => {
 if (timer !== undefined) clearTimeout(timer)
 resolve(true)
 }
 h.once('close', done)
 timer = setTimeout(() => { h.off('close', done); resolve(false) }, graceMs)
 })
 //监听先挂、再发信号：kill与 close之间没有窗口。
 let killError: Error | undefined
 try {
 h.kill('SIGKILL')
 } catch (e) {
 killError = e as Error
 }
 const arrived = await closed
 h.off('error', onError)
 const native = killError ?? nativeError ?? h.lockError
 if (arrived) {
 h.lockClosed = true
 if (killError !== undefined) {
 //清理已确认，但「信号没送出去」仍不得吞成成功（CR第六十七轮 major）。
 throw new Error(`终止持锁者失败（信号未能送达）：${killError.message}`, { cause: killError })
 }
 return
 }
 const base = '持锁者未在宽限内 close ——它可能仍占着库文件，不得删除夹具目录或复用同一路径'
 if (native !== undefined) throw new Error(`${base}（终止动作的原始错误：${native.message}）`, { cause: native })
 throw new Error(base)
}
