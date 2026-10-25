// src/core/ratelimit.ts

export interface RateLimit {
  limit: number
  windowSeconds: number
  /**
   * 这一行的依据来自哪里。设计稿 §7.4 明确要求**每一行都必须标注来源** ——
   * 表里混着"文档说 5 分钟"和"实测 30 秒"两类，不标注就无法判断可信度。
   */
  source: 'doc' | 'observed'
  /**
   * 限频的作用域。设计稿 §9.1 的示例信封里声明了该字段（G1 交付）。
   *
   * ⚠️ **目前只有 `'endpoint'` 一种取值，且全部 27 行都是它** —— 实测 183 次探测
   * 确认限频按**路径**独立（同一路径 30 秒内连续调用必 14009，跨路径连续调用
   * 全部成功），从未观测到跨接口共享配额（`'global'`）。保留这个联合类型是为了
   * 让「将来出现第二种取值」有一个显式落点，而不是让消费方猜。
   * → **若未来真的实测到 global 限频，必须同时更新本注释、`RATE_LIMITS` 行、
   *   `ratelimit.test.ts` 的逐行断言与 `api schema` 的 `field_notes.rate_limit`。**
   */
  scope: 'endpoint' | 'global'
}

/**
 * 逐接口限频表。**不要外推** —— 实测分布极不统一：
 * ⚠️ 冷却取值**不是**设计稿早前说的"30s/60s/10s/5min 四种"——那张表的 5 分钟
 * 已被实测推翻为 20 秒。本表实际用到 **6 档：1 / 10 / 20 / 30 / 60 / 180 秒**
 * （180 秒是 `robot.data.knowledge`，注释里写作"长达数分钟"）。
 * 错误码也**不止三种**：本表覆盖 14009 / 12001 / 8011，另有 `icoutcall.history.*`
 * 走 **14402**、知识库取数走 **14500**（"太频繁"这一语义横跨多个码，见 errors.ts 的
 * 按文本分派）。还有些接口**完全没有限频**（本表里为 null）。
 * → 任何"统一冷却时间""只认 14009"的假定都是错的。
 * 未登记的接口返回 null（不限频）。
 */
export const RATE_LIMITS: Record<string, RateLimit | null> = {
  // 10 个报表接口：约 30 秒冷却，按路径各自独立
  'statistic.overview':            { limit: 1, windowSeconds: 30, source: 'observed', scope: 'endpoint' },
  'statistic.staffworklod':        { limit: 1, windowSeconds: 30, source: 'observed', scope: 'endpoint' },
  'statistic.staffquality':        { limit: 1, windowSeconds: 30, source: 'observed', scope: 'endpoint' },
  'statistic.staffAttendance':     { limit: 1, windowSeconds: 30, source: 'observed', scope: 'endpoint' },
  'statistic.satisfaction.report': { limit: 1, windowSeconds: 30, source: 'observed', scope: 'endpoint' },
  'statistic.performance':         { limit: 1, windowSeconds: 30, source: 'observed', scope: 'endpoint' },
  'statistic.salaryDetail':        { limit: 1, windowSeconds: 30, source: 'observed', scope: 'endpoint' },
  'robot.statistic.summary':       { limit: 1, windowSeconds: 30, source: 'observed', scope: 'endpoint' },
  'ai.statistic.transferHuman':    { limit: 1, windowSeconds: 30, source: 'observed', scope: 'endpoint' },
  'data.overview.session':         { limit: 1, windowSeconds: 30, source: 'observed', scope: 'endpoint' },

  // 呼叫坐席/团队历史：实测约 20 秒冷却，超限返回 14402（设计稿 §4.3）
  'icoutcall.history.seat':        { limit: 1, windowSeconds: 20, source: 'observed', scope: 'endpoint' },
  'icoutcall.history.team':        { limit: 1, windowSeconds: 20, source: 'observed', scope: 'endpoint' },

  // 报表域：ipcc 是 10 次/60 秒滚动窗口（与其余报表的 30 秒不同）
  'data.overview.ipcc':            { limit: 10, windowSeconds: 60, source: 'observed', scope: 'endpoint' },

  // 知识库取数接口实测也是 14009，且冷却长达数分钟（不是 30 秒）
  'robot.data.knowledge':          { limit: 1, windowSeconds: 180, source: 'observed', scope: 'endpoint' },

  // 会话导出：创建每 10 秒 6 次；检查无限频
  'export.session':       { limit: 6, windowSeconds: 10, source: 'observed', scope: 'endpoint' },
  'export.session.check': null,

  // 咨询分类：实测 60 秒
  'online.session.category.list': { limit: 1, windowSeconds: 60, source: 'observed', scope: 'endpoint' },

  // 知识库：大部分 1/s，详情与规则回答 10/s
  'ai.knowledge.getCategoryTree':  { limit: 1, windowSeconds: 1, source: 'observed', scope: 'endpoint' },
  'ai.knowledge.search':           { limit: 1, windowSeconds: 1, source: 'observed', scope: 'endpoint' },
  'ai.knowledge.getDetail':        { limit: 10, windowSeconds: 1, source: 'doc', scope: 'endpoint' },

  // 知识库写接口：限流取自官方字段表（设计稿 §5.4.1），非实测 —— 这 5 个接口
  // 从未被调用过。⚠️ 三个 1/s 的接口（addKnowledge / editKnowledge / deleteKnowledges）
  // 会让批量编辑被限流。
  //
  // ⚠️ **本计划的 `call()` 不会"串行化"批量编辑 —— 不要以为登记了限频就安全了。**
  // 令牌桶是**进程内**的 `Map`（见 http.ts 的 `buckets`），没有持久化；而 `api call`
  // 是**一次性进程**（一次调用后退出）。所以跨 `qiyu api call` 的调用之间**没有任何
  // 共享状态**：每次都是全新的空桶，限频表对它们完全不起作用。
  // 实测：进程内连续调 4 次 1/s 的接口 → 第 1 次发出、后 3 次立刻抛 `rate_limit`
  // （等 1s）—— 它**不会替你等**，只是把"要等"这件事报给调用方。
  // → 限频表真正约束的是**将来那个批量命令**（单进程内循环调用，如计划 2 的知识库
  //   批量编辑）；对当前的单次 `api call`，它只在"同一个进程内被调用多次"时才生效。
  // 单次 `api call` 撞 14500 时，`call()` 给出的保守 `retryAfter` 才是 Agent 的唯一依据。
  'ai.knowledge.addKnowledge':             { limit: 1, windowSeconds: 1, source: 'doc', scope: 'endpoint' },
  'ai.knowledge.editKnowledge':            { limit: 1, windowSeconds: 1, source: 'doc', scope: 'endpoint' },
  'ai.knowledge.deleteKnowledges':         { limit: 1, windowSeconds: 1, source: 'doc', scope: 'endpoint' },
  'ai.knowledge.editChannelAnswer':        { limit: 10, windowSeconds: 1, source: 'doc', scope: 'endpoint' },
  'ai.knowledge.editKnowledgeNoSimilars':  { limit: 10, windowSeconds: 1, source: 'doc', scope: 'endpoint' },

  'robot.data.getQuestionsByCategoryName':       { limit: 1, windowSeconds: 1, source: 'observed', scope: 'endpoint' },
  'robot.data.queryStandardByEffectiveQuestion': { limit: 1, windowSeconds: 1, source: 'observed', scope: 'endpoint' },
  'robot.data.queryStandardQuestionList':        { limit: 1, windowSeconds: 1, source: 'observed', scope: 'endpoint' },

  // 如实测：没有任何限频（设计稿 §7.4 明确列出这 5 个）
  // ⚠️ 显式写 null 而不是省略 —— 省略会退化成"未登记"的默认值，而这两者
  // 在审计上不同：null 表示"实测过，确实没有"，省略表示"没测过"。
  'chat.queue.group.query':            null,
  'evaluation.setting.get':            null,
  'event.queryQueueStatus':            null,
  'smstask.status':                    null,
  'online.session.customfield.template': null,
}

export function limitFor(endpointId: string): RateLimit | null {
  // 必须用 hasOwn —— 否则 'constructor' / 'toString' 会命中原型链上的函数，
  // 返回一个没有 limit 字段的东西，后续取属性得到 undefined 而不是 null。
  return Object.hasOwn(RATE_LIMITS, endpointId) ? RATE_LIMITS[endpointId]! : null
}

/**
 * **三态**查询（`api schema` 的消费方）：未登记 → `undefined`；
 * 登记且实测无限制（显式 null）→ `null`；有限频 → `RateLimit`。
 *
 * ⚠️ 不要用它替换 `limitFor`：`call()` 的语义是"未登记与显式 null 都视为不限频"，
 * 两者合并成 `null` 才是它要的。三态只用于**如实告诉 Agent 这个值是怎么来的** ——
 * 「没测过」与「测过、确实没有」在审计上是两件事，不能压成一个。
 */
export function registeredRateLimit(endpointId: string): RateLimit | null | undefined {
  return Object.hasOwn(RATE_LIMITS, endpointId) ? RATE_LIMITS[endpointId]! : undefined
}

/**
 * 滑动窗口令牌桶。limit 或 windowSeconds 为 null/0 时永不拒绝。
 *
 * ⚠️ 构造参数是**秒**，与 `RateLimit.windowSeconds` 同单位 —— 内部换算成毫秒。
 * 调用方若要传毫秒，必须显式乘 1000，不要依赖构造器猜。
 * now 由调用方注入，便于测试。
 */
export class TokenBucket {
  private stamps: number[] = []
  private readonly windowMs: number | null

  constructor(
    private readonly limit: number | null,
    windowSeconds: number | null,
    private readonly clock: () => number = () => Date.now(),
  ) {
    this.windowMs = windowSeconds === null ? null : windowSeconds * 1000
  }

  private enabled(): boolean {
    return !!this.limit && !!this.windowMs && this.limit > 0 && this.windowMs > 0
  }

  tryAcquire(now: number = this.clock()): boolean {
    if (!this.enabled()) return true
    this.stamps = this.stamps.filter((t) => now - t < this.windowMs!)
    if (this.stamps.length >= this.limit!) return false
    this.stamps.push(now)
    return true
  }

  /** 还需要等待多少毫秒才能再次获得配额；可以立刻调用时返回 0。 */
  nextAvailableAt(now: number = this.clock()): number {
    if (!this.enabled()) return 0
    const live = this.stamps.filter((t) => now - t < this.windowMs!)
    if (live.length < this.limit!) return 0
    const oldest = Math.min(...live)
    return oldest + this.windowMs! - now
  }
}
