// src/sync/tasks/pace.ts
// 任务层共享的「带冷却重试的调用」+ synchronized_at 盖章时钟（final 审查中-1/低-4）。
// 此前 reports / knowledge / tickets 三处各自内联同一份 callPaced（同一实现的三个副本，
// 改动必然漂移）——收敛到本文件，三个任务文件改为复用（__setSleep 经各自模块再导出，
// 既有测试注入点不变）。
//
// 两类限频都在此吸收（「慢不是错」：宁可慢，不超发）：
//   · local_rate_limit —— core 进程内令牌桶（core/http.ts）抛出的本地冷却，
//     按 retryAfter 等待后重试（不写持久化冷却行：那是纯进程内状态）；
//   · 远端限频（kind=rate_limit，14009/14500/12001/14402/8011 等）—— 先经持久化
//     闸门 penalize 写冷却（跨进程生效，下次 acquire 会被拦住），再等待重试。
// 有界重试（MAX_PACE_ATTEMPTS）：冷却行坏数据/服务端持续限频时有限次后显式抛出，
// 由引擎记 gap，绝不死循环。
//
// 全场景审查（修复批 1）修正的两点：
//   · B 高-1：**所有**任务层的调用都必须走这里 —— 裸 `call` 让本地令牌桶的拒绝
//     直接冒泡成 fetch_failed gap（而它其实只该等一等），远端限频的证据（冷却行）
//     也没人写。reports 的 fetchSimple、dim 的全部取数、pipeline 的 create/check
//     已接入。
//   · B 中-6：penalize 的键是 **endpoint id**（不是 task id）—— 闸门按路径拦、
//     限频表按路径登记，同路径多任务（tickets.search / ticket.logs）必须共享冷却。
//   · B 低-2：等待时长封顶（clampGateWait）—— 冷却行坏数据算出的天文数字不把同步挂死。
import { call } from '../../core/http.js'
import type { CallResult } from '../../core/http.js'
import { byId } from '../../core/registry/index.js'
import { clampGateWait } from '../rate-gate.js'
import type { RateGate } from '../rate-gate.js'
import type { Credentials } from '../../core/credentials.js'

let sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** 仅测试用：替换等待实现（真实同步的等待可达 180 秒，不可测；测试注入零等待）。 */
export function __setSleep(fn: (ms: number) => Promise<void>): void { sleep = fn }

/** 初次 + 3 次等待重试。 */
const MAX_PACE_ATTEMPTS = 3

/**
 * callPaced 需要的最小上下文：credentials 恒需；gate/clock 可缺（verify 等直调路径与
 * 会话导出流水线只有部分注入面）。FetchCtx 结构上满足本类型。
 */
export interface PaceCtx {
  credentials: Credentials
  gate?: RateGate
  clock?: () => number
}

/**
 * 任务层 synchronized_at 盖章的统一时钟（低-4：此前是裸 `new Date()`，与 ctx.clock
 * 注入面不一致 —— 确定性测试无法断言戳值）。缺省（无 ctx.clock 的直调路径）真实时间。
 */
export function nowIsoOf(ctx: PaceCtx): string {
  return new Date(ctx.clock?.() ?? Date.now()).toISOString()
}

/**
 * 带冷却重试的调用。
 * ⚠️ `endpointId` 是注册表 id，**也是持久化闸门的键**（B 中-6）：penalize 与引擎的
 * `gate.acquire(task.endpoint)` 必须落在同一把键上，冷却才拦得住下一次调用。
 */
export async function callPaced(endpointId: string, body: unknown, ctx: PaceCtx,
  attempt = 0): Promise<CallResult> {
  try {
    return await call(byId(endpointId), body, { credentials: ctx.credentials })
  } catch (e) {
    const err = e as { code?: string; kind?: string; retryAfter?: { seconds?: number } }
    // ⚠️ 本地限频也是 kind=rate_limit（http.ts 在同一处抛出，只有 code 区分）——
    // 必须按 code 分辨，否则会为纯进程内冷却写持久化冷却行（跨进程拦住不该拦的调用）。
    const isLocal = err.code === 'local_rate_limit'
    const isRemote = err.kind === 'rate_limit' && !isLocal
    if ((!isLocal && !isRemote) || attempt >= MAX_PACE_ATTEMPTS) throw e
    const seconds = err.retryAfter?.seconds ?? 30
    // 远端限频是证据：写进持久化闸门（闸门不在 ctx —— verify 等直调 fetch 的路径 ——
    // 退化为纯等待，语义仍是「宁可慢」）。键是 endpoint id，同路径任务共享这一行。
    if (isRemote && ctx.gate) await ctx.gate.penalize(endpointId, seconds)
    // 等待封顶（B 低-2）：限频表最大 180 秒，但坏数据/兜底值不该把单次等待拉成天文数字。
    await sleep(clampGateWait((seconds + 1) * 1000) || GATE_WAIT_MIN_MS)
    return callPaced(endpointId, body, ctx, attempt + 1)
  }
}

/** 等待下界：retryAfter 异常（0/NaN）时退化为最小等待，绝不零等待空转。 */
const GATE_WAIT_MIN_MS = 1_000
