// tests/core/ratelimit.test.ts
import { describe, it, expect } from 'vitest'
import { TokenBucket, RATE_LIMITS, limitFor, registeredRateLimit } from '../../src/core/ratelimit.js'

describe('令牌桶', () => {
  it('配额内放行，超出则拒绝', () => {
    const b = new TokenBucket(2, 60, () => 0)
    expect(b.tryAcquire(0)).toBe(true)
    expect(b.tryAcquire(0)).toBe(true)
    expect(b.tryAcquire(0)).toBe(false)
  })

  it('窗口滑动后重新放行', () => {
    const b = new TokenBucket(1, 30, () => 0)
    expect(b.tryAcquire(0)).toBe(true)
    expect(b.tryAcquire(0)).toBe(false)
    expect(b.tryAcquire(30_000)).toBe(true)
  })

  it('构造参数的单位是秒 —— 30 表示 30 秒，不是 30 毫秒', () => {
    // 这条用例是单位契约的守门人：若构造器把 30 当成毫秒，
    // 窗口在 now=10000 时早已滑过，nextAvailableAt 会返回 0 而不是 20000。
    const b = new TokenBucket(1, 30, () => 0)
    b.tryAcquire(0)
    expect(b.nextAvailableAt(10_000)).toBe(20_000)
  })

  it('省略 now 时回落到构造器注入的 clock —— 该默认分支不是死代码', () => {
    // ⚠️ 此前**没有任何用例**走这个分支：所有测试调用 `tryAcquire(0)` /
    // `nextAvailableAt(n)` 都**显式传 now**，生产侧 `call()` 两次调用也都传了
    // `now()`。于是构造器第三参 `clock` 的默认值（`now = this.clock()`）在整个
    // 计划里**从未被执行过一次** —— 一个"声明了但没人读"的注入点。
    // 这条用例显式**省略 now**，让 `this.clock()` 真正跑起来，把该契约钉住。
    // 用一个可预测的假时钟（而非 Date.now()），断言的是"省略 now 时确实读了 clock"，
    // 而不是某个真实时间值。
    let t = 1_000_000
    const b = new TokenBucket(1, 60, () => t)
    expect(b.tryAcquire()).toBe(true)      // 省略 now → 读 clock() = 1_000_000
    expect(b.tryAcquire()).toBe(false)     // 同一窗口内第二次 → 拒
    // 窗口是 60 秒；把假时钟推进 60_000ms，再省略 now 调用，应重新放行 ——
    // 若 `now` 默认值退化成 0 或不读 clock，这里会失败。
    t += 60_000
    expect(b.tryAcquire()).toBe(true)
    // 刚放行后 stamps 里只剩本次（limit=1，旧的已滑出窗口），
    // 故 nextAvailableAt 省略 now 时应给出完整窗口的等待（而非 0）。
    expect(b.nextAvailableAt()).toBe(60_000)
  })

  it('从未被限频的接口不排队', () => {
    const b = new TokenBucket(null, null, () => 0)
    for (let i = 0; i < 100; i++) expect(b.tryAcquire(0)).toBe(true)
  })

  it('limit 或 windowSeconds 为 0 时也永不拒绝 —— 与 null 同等对待', () => {
    // ⚠️ 类的文档写着「limit 或 windowSeconds 为 null/**0** 时永不拒绝」，但此前只测了
    // null,null。下面这组用例补上了 0 的情形。
    //
    // ⚠️ **精确记录这条测试到底钉住了什么**（操作符变异扫描逐位置复核，全量测试）——
    // `enabled()` 是 `return !!this.limit && !!this.windowMs && this.limit > 0 && this.windowMs > 0`，
    // 有 3 个 `&&`。逐位置翻转的结果：
    //   · 第 1 个（`!!this.limit || …`）→ **存活**（等价变异体）
    //   · 第 2 个（`!!this.windowMs || …`）→ **存活**（等价变异体）
    //   · 第 3 个（`… || this.windowMs > 0`）→ **被本测试杀掉**
    // 前两个是等价变异体：`!!this.limit` / `!!this.windowMs` 已把 0 与 null 短路掉，
    // 后续的 `> 0` 只在 `limit < 0` 这种**不可达输入**上才改变结果（`RateLimit.limit`
    // 是实测的正值，负数不会出现在限频表里），因此任何测试都杀不掉它们 ——
    // 这**不是**覆盖缺口，不要为它写测试。
    // 同理 `this.limit > 0` 改成 `>= 0` 也存活：`!!this.limit` 已经把 `limit === 0`
    // 判为禁用，`>= 0` 那一侧永远走不到。
    // → 所以下面这组用例**真正**守的是第 3 个 `&&`：**`limit` 为 0** 时不得被判为"启用"。
    // ⚠️ 是 `limit` 为 0，不是 `windowMs` 为 0 —— 逐例推演：杀第 3 个变异体的
    // **唯一**用例是 `[0, 60]`（limit=0）；`[1, 0]`（windowMs=0）杀不掉它
    // （变异体在该例上与原型同为 `false`，`windowMs=0` 由第 2 个 `&&` 兜住，
    // 而第 2 个是等价变异体）。下面那句症状 `stamps.length >= 0` 也只在 limit=0
    // 时才出现 —— 若按旧注释去删 `[0, 60]`，变异会存活而无人察觉。
    // 0 是**真实会出现的值**：限频表是 `Record<string, RateLimit | null>`，
    // 生成脚本补 154 条时把某个 `limit` 填成 0 是很自然的错误；若 `enabled()` 判 0 为"启用"，
    // 该接口会被限频，而 `stamps.length >= 0` 恒真 → **每一次调用都被拒**，
    // 且 `nextAvailableAt` 返回的等待时间毫无意义。Agent 会看到一个永远调不通的接口。
    for (const [lim, win] of [[0, 60], [1, 0], [0, 0]] as const) {
      const b = new TokenBucket(lim, win, () => 0)
      for (let i = 0; i < 5; i++) {
        expect(b.tryAcquire(0), `limit=${lim} windowSeconds=${win} 不该拒绝`).toBe(true)
      }
    }
  })
})

describe('限频表', () => {
  it('报表接口按路径独立限频 30 秒', () => {
    expect(limitFor('statistic.overview')).toMatchObject({ limit: 1, windowSeconds: 30 })
  })

  it('会话导出创建是每 10 秒 6 次', () => {
    expect(limitFor('export.session')).toMatchObject({ limit: 6, windowSeconds: 10 })
  })

  it('咨询分类接口是 60 秒', () => {
    expect(limitFor('online.session.category.list')).toMatchObject({ windowSeconds: 60 })
  })

  it('知识库详情是每秒 10 次 —— 且来源是**文档**不是实测', () => {
    const lim = limitFor('ai.knowledge.getDetail')
    expect(lim).toMatchObject({ limit: 10, windowSeconds: 1 })
    // ⚠️ `source` 也必须断言。此前这条只断言 limit/windowSeconds，而下面那条
    // 「每一行都标注了来源」只检查 `source ∈ ['doc','observed']` —— `observed`
    // 本身是合法值，所以把本行的 `source` 改成任意另一个合法值测试照样全绿。
    // 而它此前**确实标错了**：`'observed'`。
    //
    // 错在哪：设计稿两处都指向"文档值"——
    //   §7.4 限频表   → 来源列写「文档」
    //   §9.0.1 实测表 → **「未观测到**」，突发 8 次全部 200
    // 即该接口**根本没观测到限频**，10/s 是文档值且事后被认定「正确」。
    // 标 `observed` 等于把"文档值恰好未被推翻"误读成"实测得到"。
    // ⚠️ 对比：同族的 `getCategoryTree` / `search` 标 `observed` 是**对的** ——
    // 那两个实测真的撞了 `14500`（§9.0.1 有记录），所以不是"整族都要改"。
    expect(lim?.source, 'getDetail 未观测到限频，来源必须是文档').toBe('doc')
  })

  it('ipcc 报表是 10 次/60 秒，与其余报表的 30 秒不同', () => {
    expect(limitFor('data.overview.ipcc')).toMatchObject({ limit: 10, windowSeconds: 60 })
  })

  it('知识库取数接口的冷却长达数分钟，不是 30 秒', () => {
    // 若沿用报表的 30 秒，Agent 会在冷却期内反复重试、持续吃 14009
    // ⚠️ 这里此前写 `toBeGreaterThan(60)` —— 只排除了 30/60 两档，**不钉具体值**。
    // 变异测试确认：把表里的 180 改成 90、120、甚至 61，全量测试仍全绿。
    // 而这一档的取值直接决定 Agent 要等多久，且它是本表**唯一的**"数分钟级"档 ——
    // 必须钉死，并同时钉 source（§9.0.1 是实测记录，不是文档值）。
    // 取 180 而非实测下界 160 是本计划的**保守上取**（§7.4 背景里已注明），
    // 因此这里钉 180 而不是 160 —— 两者之差是刻意的余量，不是笔误。
    expect(limitFor('robot.data.knowledge')).toMatchObject({
      limit: 1, windowSeconds: 180, source: 'observed',
    })
  })

  it('呼叫历史是实测的 20 秒，而不是文档写的 5 分钟', () => {
    // ⚠️ 文档写"间隔 ≥5 分钟"，实测是约 20 秒冷却（超限返回 14402，设计稿 §4.3）。
    // 按文档填 300 秒会让 CLI 白白等待 15 倍的时间 —— 而 source 会从
    // 'observed' 退回 'doc'，那条断言又抓不到具体数值，所以这里必须钉住数字。
    for (const id of ['icoutcall.history.seat', 'icoutcall.history.team']) {
      expect(limitFor(id), id).toMatchObject({ limit: 1, windowSeconds: 20, source: 'observed' })
    }
  })

  it('知识库 5 个写接口的限频已登记 —— 三个 1/s、两个 10/s', () => {
    // 设计稿 §5.4.1：这 5 个接口从未被调用过，限流值取自官方字段表。
    // ⚠️ 三个 1/s 的接口（addKnowledge / editKnowledge / deleteKnowledges）
    // 会让批量编辑被限流；但**本计划的令牌桶不会替调用方串行化**（见下方说明）。
    for (const id of ['ai.knowledge.addKnowledge', 'ai.knowledge.editKnowledge',
                      'ai.knowledge.deleteKnowledges']) {
      expect(limitFor(id), id).toMatchObject({ limit: 1, windowSeconds: 1, source: 'doc' })
    }
    for (const id of ['ai.knowledge.editChannelAnswer', 'ai.knowledge.editKnowledgeNoSimilars']) {
      expect(limitFor(id), id).toMatchObject({ limit: 10, windowSeconds: 1, source: 'doc' })
    }
  })

  it('每一行都标注了来源 —— 混着文档与实测，不标注就无法判断可信度', () => {
    for (const [id, r] of Object.entries(RATE_LIMITS)) {
      if (r === null) continue
      expect(['doc', 'observed'], `${id} 缺少 source`).toContain(r.source)
    }
  })

  it('每一行都标注了 scope —— 27 行全部是 endpoint，没有一行漏标', () => {
    // ⚠️ 设计稿 §9.1 的限流示例信封里声明了 `scope`，此前零生产者（G1 补）。
    // 逐行断言而**不是**只断言"值 ∈ 联合类型"：后者对一个错填成
    // 'endpoint' 之外任何合法值的行仍然绿，而本表的实测结论只有一个 ——
    // 183 次探测确认限频按路径独立，从未观测到跨接口共享配额。
    // → 若未来真的实测到 global，这里必须显式改成受影响的那些行，不能放宽成"两种都行"。
    const limited = Object.entries(RATE_LIMITS).filter(([, r]) => r !== null)
    expect(limited.length, '限频行数变了就要连带复核本断言').toBe(27)
    for (const [id, r] of limited) {
      expect(r!.scope, `${id} 的 scope`).toBe('endpoint')
    }
    // 显式 null 的 6 行没有对象可挂 scope —— 它们靠"值是 null"表达无限频，
    // 与"未登记"由 `registeredRateLimit` 区分（见下一条）。
    expect(Object.values(RATE_LIMITS).filter((r) => r === null).length).toBe(6)
  })

  it('registeredRateLimit 是三态，limitFor 是两态 —— 两者不能互相替代', () => {
    // ⚠️ 三态的意义：`call()` 要的是"未登记与显式 null 都不限频"（两态即可），
    // 而 `api schema` 必须**如实区分**"没测过"与"测过、确实没有" —— 把前者
    // 报成 null 等于谎称实测无限频，Agent 会据此去掉退避。
    expect(registeredRateLimit('event.queryQueueStatus'), '显式 null = 实测无限频').toBeNull()
    expect(registeredRateLimit('statistic.overview')).toMatchObject({ limit: 1, windowSeconds: 30 })
    expect(registeredRateLimit('某个没登记过的接口'), '未登记 = undefined，不是 null').toBeUndefined()
    // 两态视图把两者压成 null（`call()` 依赖这个语义）
    expect(limitFor('event.queryQueueStatus')).toBeNull()
    expect(limitFor('某个没登记过的接口')).toBeNull()
    // 原型链守卫对三态视图同样生效
    expect(registeredRateLimit('constructor')).toBeUndefined()
  })

  it('未登记的接口默认不限频，而不是默认限频', () => {
    // 默认限频会让 Agent 白白等待；默认不限频最多撞一次 14009，代价小得多
    expect(limitFor('某个没登记过的接口')).toBeNull()
  })

  it('原型链上的键不会误命中限频表', () => {
    // RATE_LIMITS 是对象字面量，`constructor`/`toString` 会命中原型方法
    expect(limitFor('constructor')).toBeNull()
    expect(limitFor('toString')).toBeNull()
  })
})
