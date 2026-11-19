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

let seq = 0
function runScript(script: string, scriptDir: string, name: string): ChildProcess {
  const path = join(scriptDir, `${name}-${++seq}.mjs`)
  writeFileSync(path, script)
  return spawn(process.execPath, [path], { stdio: ['ignore', 'pipe', 'pipe'] })
}

/** 等到子进程打印 `marker`，或它在就绪前退出 / 预算耗尽 —— 后两种带着原始输出报错。 */
async function waitForMarker(
  child: ChildProcess, marker: string, deadline: number, what: string,
): Promise<void> {
  let out = ''
  child.stdout?.on('data', (d) => { out += String(d) })
  child.stderr?.on('data', (d) => { out += String(d) })
  const budget = deadline - Date.now()
  const ok = await new Promise<boolean>((resolve) => {
    let done = false
    const finish = (v: boolean) => {
      if (done) return
      done = true
      clearInterval(iv); clearTimeout(to); child.off('exit', onExit)
      resolve(v)
    }
    const iv = setInterval(() => { if (out.includes(marker)) finish(true) }, 50)
    // 子进程若先退出（绑定缺失、脚本语法错），立刻判失败 —— 不让用例白等满预算。
    const onExit = () => finish(out.includes(marker))
    const to = setTimeout(() => finish(out.includes(marker)), Math.max(budget, 0))
    child.on('exit', onExit)
  })
  if (!ok) {
    child.kill('SIGKILL')
    const why = budget <= 0
      ? `预算已耗尽（deadline 已过 ${-budget}ms）`
      : `在剩余预算 ${budget}ms 内未就绪`
    throw new Error(`${what}${why} —— 子进程输出：${out.slice(0, 400) || '(空)'}`)
  }
}

/** 起一个跨进程持锁者（RW 独占锁 / RO 共享锁），就绪后才返回。 */
export async function spawnLockHolder(
  o: { dbPath: string; scriptDir: string; name?: string; accessMode?: 'READ_ONLY' | 'READ_WRITE'; deadline: number },
): Promise<ChildProcess> {
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
  const child = runScript(script, o.scriptDir, o.name ?? 'holder')
  await waitForMarker(child, 'locked', o.deadline, '锁持有者')
  return child
}

/**
 * 从**另一个进程**校验锁是否真的挡住打开（绕开本进程的实例缓存）。
 * `CONFLICT` = 被锁挡住（锁生效），`OPENED` = 能打开（锁未落盘/竞态窗口），`TIMEOUT` = 预算内无结论。
 *
 * ⚠️ **只有真正的锁报文才算 CONFLICT**（CodeRabbit 2026-11-19 major）：此前脚本是
 * `main().catch(() => console.log('CONFLICT'))` —— 父目录不存在、`closeSync` 抛错等
 * **夹具自身的失败**同样打 CONFLICT，于是撞锁用例会把「夹具坏了」当成「锁生效了」放行。
 * 现在子进程把结果与**原始报文**一起交回，父进程用 `isLockError`（`src/store/retry.ts`
 * 的唯一实现点，锚 DuckDB 的模板骨架）判定；非锁错误直接抛「校验进程失败」并带上报文。
 */
export async function lockVerdict(
  dbPath: string, scriptDir: string, deadline: number,
): Promise<'CONFLICT' | 'OPENED' | 'TIMEOUT'> {
  // 子进程跑不了 TS 判据（Node 20.12 无 type stripping），所以只交回事实、由父进程判。
  const chk = runScript(`const { DuckDBInstance } = await import(${JSON.stringify(PKG_URL.href)})
try {
  const inst = await DuckDBInstance.create(${JSON.stringify(dbPath)})
  inst.closeSync()
  console.log(JSON.stringify({ v: 'OPENED' }))
} catch (e) {
  console.log(JSON.stringify({ v: 'ERROR', msg: e instanceof Error ? e.message : String(e) }))
}`, scriptDir, 'verdict')
  let co = ''
  chk.stdout?.on('data', (d) => { co += String(d) })
  let errOut = ''
  chk.stderr?.on('data', (d) => { errOut += String(d) })
  const timedOut = await new Promise<boolean>((resolve) => {
    let done = false
    const finish = (v: boolean) => { if (done) return; done = true; clearTimeout(to); resolve(v) }
    chk.on('close', () => finish(false))
    chk.on('error', () => finish(false))
    const to = setTimeout(() => { chk.kill('SIGKILL'); finish(true) }, Math.max(deadline - Date.now(), 0))
  })
  if (timedOut) return 'TIMEOUT'
  // 解析子进程交回的那一行 JSON（stdout 可能混入其它输出，取最后一个可解析的）。
  const parsed = co.split('\n').reverse()
    .map((l) => { try { return JSON.parse(l) as { v?: string; msg?: string } } catch { return null } })
    .find((x) => x !== null && typeof x.v === 'string')
  if (parsed === undefined || parsed === null) {
    throw new Error(`锁校验进程未交回结论（退出后 stdout：${co.slice(0, 300) || '(空)'}；stderr：${errOut.slice(0, 300) || '(空)'}）`)
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
  const ch = runScript(`const { DuckDBInstance } = await import(${JSON.stringify(PKG_URL.href)})
const inst = await DuckDBInstance.create(${JSON.stringify(dbPath)})
inst.closeSync()`, scriptDir, 'seed')
  let e = ''
  ch.stderr?.on('data', (d) => { e += String(d) })
  await new Promise<void>((resolve, reject) => {
    const to = setTimeout(() => {
      ch.kill('SIGKILL')
      reject(new Error(`种子进程在预算内未退出（deadline 已过）—— stderr：${e.slice(0, 300) || '(空)'}`))
    }, Math.max(deadline - Date.now(), 0))
    ch.on('close', (code) => {
      clearTimeout(to)
      code === 0 ? resolve() : reject(new Error(`种子失败：${e.slice(0, 300)}`))
    })
  })
}