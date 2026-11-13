// tests/helpers/capture.ts
//
// 测试的 stdout/stderr 捕获助手。两种用法：
//
// ① **迁移形态**（现役，27 个文件用的就是它）：
//    import { it, captureSinks } from './helpers/capture.js'
//    let out = ''; let err = ''
//    beforeEach(() => { out = ''; err = ''; captureSinks((s) => { out += s }, (s) => { err += s }) })
//    用例体、`out` 读法一律**不变**。隔离机制见下。
//
// ② **句柄形态**（新写测试可用）：`const cap = startCapture(); cap.run(fn)`，
//    读 `cap.out`。与 ① 共用同一套 spy。
//
// ⚠️ 为什么需要世代（2026-11-13 审计）：`beforeEach` 里 `out = ''` 重置挡住了
// 「上一条的输出漏进下一条」的**状态**，挡不住**写入方**：上一条超时/失败时，
// 它已发出、尚未 resolve 的异步调用（DuckDB 查询、`fetch`、定时器回调）会在
// 下一条开始之后才回来写 stdout —— 实测形态 `out="FRESHTAIL"`、`writes=2`。
//
// ⚠️ 归属按**写入时刻的异步上下文**判（CodeRabbit 2026-11-13 major）：延迟回调
// 在运行时才查 `process.stdout.write`，那时挂着的是下一条用例装的 spy。所以 spy
// 只有一套，写入者带着 `it` 包装版建立的世代号；**旧世代的写入一律丢弃**。
// 用例体的世代由包装版 `it` 在执行时建立（见 `it` 的注释），不需要改动用例体。
//
// ⚠️ 写入回调：替身必须把 `write(chunk, cb)` / `write(chunk, enc, cb)` 的完成回调
// 调掉（CodeRabbit 终审 major）——否则等待写入完成的用例只能超时。
// ⚠️ 不要在断言里读 `vi.isMockFunction(process.stdout.write)` 判本助手的状态：
// 实测它会把 spy 状态搅乱（探针自己被探针喂假信号）。判状态用 `captureInstalled()`。
import { AsyncLocalStorage } from 'node:async_hooks'
import { vi, afterAll, it as baseIt } from 'vitest'

// ⚠️ 文件结束时恢复（Codex 2026-11-13 P2）：vitest 2.1.9 默认 `restoreMocks:false`，
// 不恢复的话同 worker 的下一个测试文件会把写入记进本文件最后装的 spy。
// `afterAll` 必须在**收集阶段**注册，所以放在模块顶层。
afterAll(() => {
  vi.restoreAllMocks()
  activeSpy = undefined
})

interface Sink { out: (s: string) => void; err: (s: string) => void }
interface Buf { out: string; err: string; writes: number }

// —— 世代机制（① 迁移形态）——
const alsGen = new AsyncLocalStorage<number>()
let currentGeneration = 0
let sinks: Sink = { out: () => {}, err: () => {} }

// —— 句柄机制（② 句柄形态）——
const alsBuf = new AsyncLocalStorage<Buf>()
let generation = 0
let fallback: Buf | undefined
let activeSpy: unknown

/** 把用例执行体放进**执行时**那一代的异步上下文（见 `it` 注释），实参原样转发
 *  （`it.each` 的表格行要从这里走进执行体）。 */
function wrapFn(fn: unknown): unknown {
  if (typeof fn !== 'function') return fn
  const f = fn as (...a: unknown[]) => unknown
  return (...a: unknown[]) => alsGen.run(currentGeneration, () => f(...a))
}

/** vitest 用例登记函数的两种别名形态（实测 2.1.9，见下方 `wrapIt` 的注释）。 */
type Registrar = (name: unknown, ...rest: unknown[]) => unknown
/** 别名表：用 `unknown` 索引，取值前由 `typeof === 'function'` 收窄。 */
type Aliases = Record<string, unknown>

/** 直接登记：`it.skip(名[, 选项], 体)` / `only` / `fails` / `concurrent` / `todo`。
 *  实测这类调用**立刻**把用例登记掉，返回值是 `undefined`（不是登记函数）。 */
const DIRECT_ALIASES = ['skip', 'only', 'fails', 'concurrent', 'todo'] as const
/** 柯里化修饰：`it.each(表格)` / `it.skipIf(条件)` / `it.runIf(条件)`，返回登记函数。 */
const FACTORY_ALIASES = ['each', 'skipIf', 'runIf'] as const

/**
 * 找出执行体在实参里的位置。
 * ⚠️ vitest 2.1.9 有两种重载：`it(名, 体)` 与 `it(名, 选项, 体)`（CodeRabbit 2026-11-14
 * major）。只看第二实参会把「选项对象」当成执行体 —— 原样返回、执行体**没套上世代**，
 * 而它发出的延迟写入会被下一条用例接收（正是本助手要挡的形态）。
 * 表格行可以是函数（`it.each([[fn]])`），所以只在「注册实参」这一侧调用本函数。
 */
function wrapBody(a: unknown[]): unknown[] {
  const i = typeof a[1] === 'function' ? 1
    : typeof a[2] === 'function' && typeof a[1] === 'object' && a[1] !== null ? 2
      : -1
  if (i < 0) return a
  const out = a.slice()
  out[i] = wrapFn(a[i])
  return out
}

/**
 * 造一个「每条用例的执行体都被世代包装」的登记函数。
 *
 * ⚠️ 必须把 `each` / `skip` / `skipIf` / `runIf` / `only` / `todo` / `concurrent` /
 * `fails` 全部挂上（2026-11-14 实测漏挂的后果）：它们都是**登记函数的属性**，裸箭头函数上
 * `.each` 是 undefined —— `config-insecure.test.ts` 在收集阶段就
 * `TypeError: it.each is not a function`，整个文件一条都没跑；`auth.test.ts` 用
 * `it.skipIf`，漏挂会让本该跳过的用例变成 `TypeError`。
 *
 * ⚠️ 两类别名必须**分开处理**（CodeRabbit 2026-11-14 major，探针实测确认）：直接登记类
 * 把用例登记掉就返回，拿它的返回值去包执行体永远包不到 —— `it.fails(名, 体)` 的体不套世代，
 * 它发出的延迟写入会被下一条用例接住。只有柯里化类返回登记函数，才需要「拿到返回值再包」。
 * 按**键名**分组而不是猜「首参是不是字符串」：那是等价变异（实测两个方向都杀不掉），
 * 也挡不住真实差别（两类的差别在返回值，不在首参类型）。
 *
 * ⚠️ 不支持的形态：**别名链**（`it.skip.each(表格)` / `it.concurrent.each(…)`）。
 * 别名函数上没有挂下一层别名，故 `it.skip.each` 会在收集阶段 `TypeError: … is not a
 * function` —— 是**响亮失败**，不是静默丢失隔离。本仓库没有这种写法；真要用就改成
 * `it.skip(名, 体)` 或 `it.each(表格)`。
 */
function wrapIt(register: Registrar): typeof baseIt {
  const reg = ((...a: unknown[]) => (register as (...x: unknown[]) => unknown)(...wrapBody(a))) as unknown as typeof baseIt
  const out = reg as unknown as Record<string, unknown>
  const aliases = register as unknown as Aliases
  for (const key of DIRECT_ALIASES) {
    const v = aliases[key] as Registrar | undefined
    if (typeof v !== 'function') continue
    // 执行体先套世代，再交给真实的直接登记函数。
    // ⚠️ `this` 必须是真实的 `it`（vitest 在内部读 `this.withContext`，实测未绑定即 TypeError）。
    Object.defineProperty(out, key, { configurable: true, value: (...a: unknown[]) => { (v as (...x: unknown[]) => unknown).call(register, ...wrapBody(a)); return reg } })
  }
  for (const key of FACTORY_ALIASES) {
    const v = aliases[key] as ((...a: unknown[]) => unknown) | undefined
    if (typeof v !== 'function') continue
    // 先交表格/条件给 vitest 换回登记函数，再用它登记被包装的执行体。
    Object.defineProperty(out, key, {
      configurable: true,
      value: (...a: unknown[]) => {
        const r = (v as (...x: unknown[]) => unknown).call(register, ...a) as Registrar
        return (...b: unknown[]) => { (r as (...x: unknown[]) => unknown)(...wrapBody(b)); return reg }
      },
    })
  }
  return reg
}

/**
 * 文件级 `it`（① 用法）：执行时把用例体放进**本代**的异步上下文。
 *
 * ⚠️ `currentGeneration` 必须在**执行时**读（箭头函数体内），不能在包装时读 ——
 * 包装发生在收集阶段，那时 `beforeEach` 还没把世代推进。
 * 超时/选项等其余实参原样透传，执行体的位置由 `wrapBody` 判定。
 */

export const it: typeof baseIt = wrapIt(baseIt as unknown as Registrar)

/**
 * 替换旧的「两行 vi.spyOn」（① 用法，在 `beforeEach` 里调用）：推进世代并记录本代的
 * 接收函数。写入按**写入者的世代**过滤 —— 上一条用例的尾巴（旧世代）被丢弃。
 */
export function captureSinks(onOut: (s: string) => void, onErr: (s: string) => void): void {
  currentGeneration += 1
  sinks = { out: onOut, err: onErr }
  installShared()
}

/**
 * 开一条新捕获（② 用法）。句柄的 `out` / `err` / `writes` 是 getter，传进 `expect()`
 * 后仍读最新值；`cap.run(fn)` 把 `fn` 的异步链放进这条捕获的上下文。
 */
export function startCapture(): Capture {
  generation += 1
  const g = generation
  const buf: Buf = { out: '', err: '', writes: 0 }
  installShared()
  fallback = buf // 未包 run() 时的归属（退化路径，不是隔离）
  return Object.freeze({
    generation: g,
    get writes(): number { return buf.writes },
    get out(): string { return buf.out },
    get err(): string { return buf.err },
    run<T>(fn: () => T): T { return alsBuf.run(buf, fn) },
  })
}

export interface Capture {
  readonly generation: number
  readonly writes: number
  readonly out: string
  readonly err: string
  /** 在这条捕获的异步上下文里跑 `fn`（整条用例）。返回 `fn` 的返回值（Promise 原样透传）。 */
  run<T>(fn: () => T): T
}

/** 只装一次 spy（后续世代共用它），写时按世代/上下文分账。 */
function installShared(): void {
  // ⚠️ **不能**用「挂着的 spy 是不是本助手的」做判据跳过重装（2026-11-13 实测）：
  // 文件里若有别的用例自己 `vi.spyOn(process.stdout,'write')`，那条用例的
  // `afterEach(restoreAllMocks)` 会把属性还原成**上一层 spy**（不是原生函数），
  // 而那一层恰好就是本助手早先装的 spy —— 身份判据误判成「还装着」，跳过重装，
  // 新用例的写入进了**旧闭包里的 sinks**（`out` 永远是空串）。
  // 每条用例重装一次的代价，与原先每个 beforeEach 装两行 spy 完全同量级。
  activeSpy = vi.spyOn(process.stdout, 'write').mockImplementation((...args: unknown[]) => {
    if (writerIsCurrent()) sinks.out(String(args[0]))
    const b = alsBuf.getStore() ?? fallback
    if (b) { b.writes += 1; b.out += String(args[0]) }
    return callDone(args)
  })
  vi.spyOn(process.stderr, 'write').mockImplementation((...args: unknown[]) => {
    if (writerIsCurrent()) sinks.err(String(args[0]))
    const b = alsBuf.getStore() ?? fallback
    if (b) { b.err += String(args[0]) }
    return callDone(args)
  })
}

/** 写入者属于当前世代（或没有世代上下文，如 hook / 模块级代码）才接收。 */
function writerIsCurrent(): boolean {
  const g = alsGen.getStore()
  return g === undefined || g === currentGeneration
}

/** 调用 Node `write(chunk, cb)` / `write(chunk, enc, cb)` 的完成回调。 */
function callDone(args: unknown[]): boolean {
  const cb = args.find((a) => typeof a === 'function') as (() => void) | undefined
  if (cb) cb()
  return true
}

/** 输出捕获当前是否仍挂着（`process.stdout.write` 还是本助手装的 spy）。
 *  ⚠️ 不要用 `vi.isMockFunction` 判 —— 实测会把状态搅乱。 */
export function captureInstalled(): boolean {
  return activeSpy !== undefined && process.stdout.write === activeSpy
}
