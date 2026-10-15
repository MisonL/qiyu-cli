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
import { call } from '../../core/http.js'
import { byId } from '../../core/registry/index.js'
import type { FetchCtx } from '../types.js'

let sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** 仅测试用：替换等待实现（真实同步的等待可达 180 秒，不可测；测试注入零等待）。 */
export function __setSleep(fn: (ms: number) => Promise<void>): void { sleep = fn }

/** 初次 + 3 次等待重试。 */
const MAX_PACE_ATTEMPTS = 3

/**
 * 任务层 synchronized_at 盖章的统一时钟（低-4：此前是裸 `new Date()`，与 ctx.clock
 * 注入面不一致 —— 确定性测试无法断言戳值）。缺省（无 ctx.clock 的直调路径）真实时间。
 */
export function nowIsoOf(ctx: FetchCtx): string {
  return new Date(ctx.clock?.() ?? Date.now()).toISOString()
}

/**
 * 带冷却重试的调用（endpointId 取注册表 id；taskId 是同步任务 id —— 持久化闸门的
 * 键与引擎的 gate.acquire(task.id) 同源，写冷却才能真正拦住下一次 acquire）。
 */
export async function callPaced(endpointId: string, body: unknown, ctx: FetchCtx,
  taskId: string, attempt = 0): Promise<{ payload: unknown }> {
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
    // 退化为纯等待，语义仍是「宁可慢」）。
    if (isRemote && ctx.gate) await ctx.gate.penalize(taskId, seconds)
    await sleep((seconds + 1) * 1000)
    return callPaced(endpointId, body, ctx, taskId, attempt + 1)
  }
}
