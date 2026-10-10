import { describe, it, expect } from 'vitest'
import { allEndpoints, byId, assertCallable, assertConfirmed, loadSpecs } from '../../src/core/registry/index.js'
// 令牌桶按 path 缓存而限频行按 id 查，两者靠"同路径限频一致"这条不变量兜住，
// 所以这条断言放在注册表测试里。
import { limitFor, RATE_LIMITS } from '../../src/core/ratelimit.js'

describe('注册表', () => {
  it('每条记录都有唯一 id', () => {
    const ids = allEndpoints().map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('被动推送事件不可调用', () => {
    const push = allEndpoints().find((e) => e.path === '/' && !e.callable)
    expect(push).toBeDefined()
    expect(() => assertCallable(push!)).toThrow(/不可主动调用/)
  })

  it('路径损坏的接口被拦下时，提示说"没有路径"而不是"方向不对"', () => {
    // ⚠️ 这条补的是 `assertCallable` 里一个**零覆盖**的分支（2026-10-05 补）。
    // 报错文案按 `spec.path` 分岔：有路径就报方向，没路径就报"文档未提供可用路径"。
    // 上一条用的是 `receive.message` —— 它的 path 是入站占位符 `"/"`（truthy），
    // 走的是"方向"分支；注册表里唯一 `callable: false && path: null` 的是
    // `wecom.robot.switch`，它才走"没有路径"分支。不补这条，把该分支改坏
    // （例如恒走方向分支，对 path 为 null 的记录输出 `（方向：outbound）`
    // 这种无意义的提示）全量测试仍绿。
    const broken = byId('wecom.robot.switch')
    expect(broken.path, '前提：这条记录确实没有路径').toBeNull()
    expect(() => assertCallable(broken)).toThrow(/不可主动调用/)
    expect(() => assertCallable(broken)).toThrow(/文档未提供可用路径/)
    // 反向：不能误报成方向问题 —— path 为 null 时"方向"是答非所问。
    expect(() => assertCallable(broken)).not.toThrow(/方向/)
  })

  it('危险接口在未确认时被拦下，错误上挂 needsConfirmation 与 target', () => {
    const danger = byId('message.send')!
    expect(danger.dangerous).toBe(true)
    // ⚠️ 断言错误上**真的挂了的键**，不只是"抛了"。
    // 此前测试名写「并给出确认参数」，但实现（见下一条测试）已明确**不挂**
    // `confirmArg` —— 名字在承诺一个不存在的能力。改名为断言真实存在的两个键。
    let err: (Error & { needsConfirmation?: boolean; target?: string }) | null = null
    try { assertConfirmed(danger, false) } catch (e) { err = e as Error }
    expect(err, '未确认时必须抛错').not.toBeNull()
    expect(err!.needsConfirmation, 'api.ts 用它分流到 needs_confirmation').toBe(true)
    expect(err!.target, 'api.ts 读它（err.target ?? id）填出参的 target').toBe('message.send')
    expect(() => assertConfirmed(danger, true)).not.toThrow()
  })

  it('门禁异常只挂 needsConfirmation 与 target 两个键 —— 不挂没人读的 confirmArg', () => {
    // ⚠️ 这条守的是「声明了但没人读的键」这类契约不诚实。`assertConfirmed` 曾额外挂
    // `confirmArg: '--yes'`，但全仓没有任何读取点 —— 出参的 `confirm_arg` 是 `fail()`
    // 自己硬编码的。留着它有两个代价：① 多一个真相来源，改确认参数时要改两处，
    // 死的那处会静默变错；② 后来者会以为"改这里就能改确认参数"，改完发现无效。
    // 用 toEqual 而非 toMatchObject —— 后者会让多出来的键悄悄溜过（这正是本计划
    // 反复强调的断言纪律）。
    const err = (() => {
      try { assertConfirmed(byId('message.send')!, false); return null }
      catch (e) { return e as Record<string, unknown> }
    })()
    expect(err).not.toBeNull()
    // 只允许这两个自有键（外加 Error 自身的 message）
    expect(Object.keys(err!).filter((k) => k !== 'message').sort())
      .toEqual(['needsConfirmation', 'target'])
    expect(err!.needsConfirmation).toBe(true)
    expect(err!.target).toBe('message.send')
  })

  it('非危险接口无需确认', () => {
    expect(() => assertConfirmed(byId('ticket.search')!, false)).not.toThrow()
  })

  it('assertCallable 拦下"可调用但没有路径"的记录（第二道防线）', () => {
    // ⚠️ loadSpecs 已经拦过一次，所以真实注册表里到不了这里。
    // 但 assertCallable 是调用路径上的**最后一道** —— 若将来有人绕过 loadSpecs
    // 直接构造 EndpointSpec（比如从别处读注册表），这一道必须还在。
    // 不直测它，删掉这个分支测试照样全绿（变异测试确认过）。
    const bad = { id: 'x', title: 't', method: 'POST', path: null,
                  direction: 'outbound', callable: true, dangerous: false,
                  auth: 'checksum', verified: false, envelope: null } as const
    expect(() => assertCallable(bad as never)).toThrow(/path/)
  })

  // 设计稿 §5.2 的两个元数据陷阱
  it('写接口被标为 dangerous —— 不能从 outbound 方向推断出安全', () => {
    // settings.wxTemplates 是配置微信模板绑定的写操作。它的路径与读接口
    // 毫无形态差别，只看 method/path/direction 三个字段推不出危险性。
    expect(byId('settings.wxTemplates')!.dangerous).toBe(true)
  })

  it('未知 id 明确报错，而不是静默返回 undefined 让调用方崩在别处', () => {
    expect(() => byId('不存在的接口')).toThrow(/未知接口/)
    // ⚠️ 纯空白 id 必须渲染成可见形式（2026-10-08 修）：`api call " "` 此前报
    // 「未知接口： 。…」—— 冒号后不可见，Agent 看不出自己传的是空白。
    // 本文件在任务 6、output.ts 的 describeArgs 在任务 9（无法 import），
    // byId 里是**手写副本** —— 这条钉住它（变异确认：退回裸插值即红）。
    expect(() => byId(' ')).toThrow(/未知接口：' '/)
  })

  it('工单检索的窗口上限是 31 天，不是文档写的 90 天', () => {
    // opStart 被服务端静默钳到 now-31d：按 90 天切片每片少取约 58 天且不报错
    expect(byId('ticket.search').maxWindowDays).toBe(31)
    // ⚠️ 该接口其实有**三个**限制（31 天钳制 / 90 天跨度硬限 / opEnd=0 时返回全量），
    // note 必须把三条都写出来。只写一条的话，后来者看到 31 会以为"那 90 天是安全的上限"，
    // 于是按 90 天切片 —— 正是这条 note 要阻止的事。断言 note 提到全部三条。
    const note = byId('ticket.search').note ?? ''
    expect(note, 'note 必须提到 opEnd=0 的静默行为').toMatch(/opEnd/)
    expect(note, 'note 必须提到 90 天跨度硬限').toMatch(/90/)
  })

  it('未实测过信封的接口，envelope 为 null 而不是猜一个', () => {
    expect(byId('message.send').envelope).toBeNull()
    expect(byId('settings.wxTemplates').envelope).toBeNull()
  })

  it('robot.transfer.config 的 note 说明了它是空壳 —— verified 不等于"有数据"', () => {
    // 该接口实测返回空壳 {code:200}，调用它拿不到任何数据。
    // 没有这条 note，Agent 会以为 verified:true 意味着"这是个可用的只读接口"，
    // 调用后困惑于空响应。note 必须同时说清 verified 的含义。
    // ⚠️ 注释里**不能**写「本计划唯二 …」—— 那是按 11 条骨架算的数，154 条时
    // 就不再成立；而这条注释的读者是执行者（他手上有骨架），note 的读者是 Agent
    // （他没有）。两者要分开。（2026-10-06 修）
    const note = byId('robot.transfer.config').note ?? ''
    expect(note, 'note 必须提到它是空壳').toMatch(/空壳|没有字段/)
    expect(note, 'note 必须澄清 verified 的含义').toMatch(/verified/)
  })

  it('receive.message 的 note 里的「唯一」是真的唯一 —— 那是它唯一的论据', () => {
    // ⚠️ 这条守的是一个**会随注册表增长而失效**的说法（2026-10-06 补）。
    // note 里写「本记录是全表**唯一** `verified: true` 与 `envelope: null` 并存的
    // 一条」，而这条 note 的全部作用就是解释"为什么这个 verified 不是那个意思"——
    // **唯一性就是它的论据**。而此前**零断言**：生成脚本补齐到 154 条时，若另一条
    // 记录也成了 `verified && envelope: null`，note 仍会信誓旦旦地说"唯一"，
    // 而那句话此时是**错的**（且错得没边 —— 154 条里"唯一"是极强的主张）。
    // 这与「标题里的数字必须与断言一致」同源，只是这次唯一性藏在 note 里。
    const both = allEndpoints().filter((e) => e.verified && e.envelope === null).map((e) => e.id)
    expect(both, 'note 声称 receive.message 是唯一的 verified && envelope:null')
      .toEqual(['receive.message'])
    // 反向：verified:true 的三条都得进注册表（否则"唯一"是因为别的都丢了，
    // 而那本身是更严重的缺陷）—— 钉住这个集合，"唯一"才有意义。
    expect(allEndpoints().filter((e) => e.verified).map((e) => e.id).sort())
      .toEqual([
        'ai.knowledge.getCategoryTree', 'ai.knowledge.getDetail', 'ai.knowledge.search',
        'ai.statistic.transferHuman', 'category.list', 'data.overview.ipcc',
        'data.overview.session', 'evaluation.setting.get', 'export.session',
        'export.session.check', 'export.session.one', 'export.session.one.message',
        'icoutcall.history.seat', 'icoutcall.history.team', 'kefu.v2.query',
        'online.session.category.list', 'online.session.customfield.template',
        'receive.message', 'robot.data.getQuestionsByCategoryName', 'robot.data.knowledge',
        'robot.data.kpoint', 'robot.data.queryStandardByEffectiveQuestion',
        'robot.data.queryStandardQuestionList', 'robot.evaluation.setting',
        'robot.session.msgAssociate', 'robot.statistic.summary', 'robot.transfer.config',
        'session.user.profile', 'smstask.status', 'staff.group.list.new',
        'staff.group.members.new', 'staff.list.new', 'statistic.overview',
        'statistic.performance', 'statistic.salaryDetail', 'statistic.satisfaction.report',
        'statistic.staffAttendance', 'statistic.staffquality', 'statistic.staffworklod',
        'tag.all', 'ticket.filter.count', 'ticket.filter.list', 'ticket.search',
        'ticket.template.fields', 'ticket.template.list',
      ])
  })

  it('receive.message 的 note 不许把「已实测」扩大化 —— 真正测过的只有「不可主动调用」', () => {
    // ⚠️ 此前的 note 写「verified 指的是'方向与鉴权方式已实测'」（2026-10-04 引入），
    // 那是一句**没有出处**的话：`/` 的 POST 302 实测只证明"它不可调用"，
    // 而 `auth: eventType` 是注册表类型里的**分类值** —— 入站推送的鉴权方式
    // 从未实测（实测它必须真实接收一次推送，而 CLI 不接收推送）。
    // 后果不是措辞问题：Agent 读到"鉴权已实测"，会以为 `auth` 有实测背书 —— 而它没有；
    // 且这条事实**只有 note 这一个载体**（loadSpecs 不校验 note 内容）。
    const note = byId('receive.message').note ?? ''
    expect(note, 'verified 实测到的属性必须点名：不可主动调用').toMatch(/不可主动调用[^。]*已实测/)
    expect(note, '必须显式否认鉴权已实测 —— auth: eventType 只是分类值')
      .toMatch(/鉴权方式从未实测/)
  })

  it('dangerous 的七个 id 逐个钉住 —— 门禁挂在这个字段上', () => {
    // ⚠️ 这条此前写作「每条记录都显式给出 dangerous」，遍历 `allEndpoints()`
    // 断言 `typeof e.dangerous === 'boolean'` —— 那是**恒真**的：`loadSpecs`
    // 缺该键即抛（`typeof o.dangerous !== 'boolean'`），所以能进注册表的记录
    // 必然是布尔。它测的是"返回值长什么样"，不是"门禁挂对了字段"。
    // 而这条断言真正要守的是**数据**：哪些接口被标成危险 —— 少标一个，
    // 就是一次不可逆的写操作被门禁放行，而门禁静默 fail-open 正是设计稿
    // 点名的形态。逐个列出来，改动才会被看见（数量对但成员换了，同样能抓到）。
    // ⚠️ 必须用 `toEqual` 排序后比较而不是 `toBe(7)` —— 只钉数量的话，
    // 把 `settings.wxTemplates` 换成另一个接口，断言照样通过。
    const dangerous = allEndpoints().filter((e) => e.dangerous).map((e) => e.id).sort()
    expect(dangerous, 'dangerous 的 id 集合变了 —— 少标一个 = 一次不可逆写被放行').toEqual([
      'ai.knowledge.addKnowledge',
      'ai.knowledge.deleteKnowledges',
      'ai.knowledge.editChannelAnswer',
      'ai.knowledge.editKnowledge',
      'ai.knowledge.editKnowledgeNoSimilars',
      'crm.syncCrmInfo',
      'event.applyStaff',
      'event.evaluate',
      'event.quitQueue',
      'event.updateUInfo',
      'export.session',
      'icoutcall.job.create',
      'icoutcall.job.importcustomer',
      'icoutcall.job.pause',
      'icoutcall.job.readdcustomer',
      'icoutcall.job.start',
      'icoutcall.job.terminate',
      'ipcc.calltask.add.auto',
      'ipcc.calltask.add.byCustom',
      'ipcc.calltask.add.byRelation',
      'ipcc.calltask.add.toGroup',
      'ipcc.calltask.add.toStaff',
      'ipcc.calltaskdetail.add',
      'ipcc.calltaskdetail.delete',
      'ipcc.calltaskdetail.update',
      'ipcc.login',
      'kefu.add',
      'kefu.delete',
      'kefu.update',
      'kefuGroup.add',
      'kefuGroup.delete',
      'kefuGroup.update',
      'kefuGroup.updateKefus',
      'merchant.account.login',
      'merchant.changePassword',
      'merchant.create',
      'merchant.disable',
      'merchant.enable',
      'merchant.update',
      'message.send',
      'message.send.image',
      'message.send.voice',
      'message.sendFile',
      'message.uploadFile',
      'online.session.customfield.update',
      'order.upload',
      'push.msg.image',
      'push.msg.richText',
      'push.msg.text',
      'robot.evaluation.comment',
      'robot.session.assist',
      'robot.session.close',
      'robot.session.create',
      'robot.session.evaluation',
      'robot.session.msgEvaluation',
      'robot.session.transfer',
      'robot.session.uploadFile',
      'settings.wxTemplates',
      'smstask.create',
      'staff.login',
      'tag.batchUpdate',
      'tag.update',
      'ticket.apply',
      'ticket.batch.modify',
      'ticket.create',
      'ticket.finish',
      'ticket.followers.update',
      'ticket.modify',
      'ticket.reminder',
      'ticket.reopen',
      'ticket.reply',
      'ticket.transfer',
      'track.event.set',
    ])
  })

  it('同一路径上的所有 id 限频必须一致', () => {
    // ⚠️ 令牌桶按 **path** 缓存，而限频行按 **id** 查，那一行只在建桶时读一次。
    // 若同一路径的两个 id 限频不同（或一个有一个没有），桶的档位就取决于
    // 谁先被调用 —— 顺序敏感，且可能放行数倍流量。
    // 设计稿 §5.1 实测线上有 6 组 24 个重复路径，这不是假想情形。
    //
    // ⚠️ 注意这条断言在当前 11 条骨架下**恒真** —— 注册表里没有重复路径。
    // 它的价值要等 `specs.json` 补齐到 154 条才兑现。不要因为"它现在总是过"
    // 就删掉它：那正是它要守的形态在数据到位后才会出现的缘故。
    const byPath = new Map<string, string[]>()
    for (const e of allEndpoints()) {
      if (!e.path) continue
      byPath.set(e.path, [...(byPath.get(e.path) ?? []), e.id])
    }
    for (const [path, ids] of byPath) {
      if (ids.length < 2) continue
      const rows = ids.map((id) => JSON.stringify(limitFor(id) ?? null))
      expect(new Set(rows).size, `路径 ${path} 上的 id 限频不一致：${ids.join(', ')}`).toBe(1)
    }
  })

  it('限频表键覆盖注册表（当前 33/33，已完整对齐）', () => {
    const ids = new Set(allEndpoints().map((e) => e.id))
    const orphans = Object.keys(RATE_LIMITS).filter((id) => !ids.has(id))
    expect(orphans, 'RATE_LIMITS 中的每个键都必须在注册表中存在').toEqual([])
    expect(Object.keys(RATE_LIMITS).length, '限频表键总数必须为 33').toBe(33)
  })

  it('限频表非空档位（当前 27/33；其余 6 个键显式不限频）', () => {
    const inRegistry = allEndpoints().filter((e) => limitFor(e.id) !== null).length
    const nullTiers = ['export.session.check', 'chat.queue.group.query', 'evaluation.setting.get',
      'event.queryQueueStatus', 'smstask.status', 'online.session.customfield.template']
    expect(inRegistry, '非空限频档位数量必须为 27（其余 6 个键是显式 null）').toBe(27)
    expect(nullTiers.filter((id) => RATE_LIMITS[id] !== null),
      '这 6 个键必须是限频表中的显式 null').toEqual([])
    expect(Object.keys(RATE_LIMITS).length, '限频表分母必须为 33').toBe(33)
  })

  it('知识库写接口既在注册表里、也有限频行 —— 两者缺一都会静默降级', () => {
    // 正向断言：这 5 个接口是本计划特意补进来的，它们的两个登记项必须同时存在。
    // 只登记注册表 → 限频层不生效，批量编辑会撞服务端限流；
    // 只登记限频表 → 逃生舱够不到它们，注册了也白注册。
    const WRITES = ['ai.knowledge.addKnowledge', 'ai.knowledge.editKnowledge',
                    'ai.knowledge.deleteKnowledges', 'ai.knowledge.editChannelAnswer',
                    'ai.knowledge.editKnowledgeNoSimilars']
    for (const id of WRITES) {
      const spec = byId(id)
      expect(spec.callable, `${id} 应可由逃生舱触达`).toBe(true)
      expect(spec.dangerous, `${id} 是写接口，必须由 --yes 把关`).toBe(true)
      expect(spec.verified, `${id} 从未被调用过，不能标成已实测`).toBe(false)
      expect(limitFor(id), `${id} 缺限频行`).not.toBeNull()
    }
  })

  it('5 个知识库写接口的 note 都点名 robotId 必填 —— 逃生舱透传 body，note 是唯一渠道', () => {
    // 设计稿 §5.4.1 的共享契约：这 5 个接口的 `robotId` **每一个都必填**，
    // 而读接口 `robot.data.knowledge` 会**静默忽略**它（§10.5.2，实测：传与不传
    // 返回完全相同）。→ 一个把读接口经验（"robotId 传不传都一样"）带到写接口上的
    // Agent，会漏掉一个必填字段，而它的错误反馈与"这个接口坏了"无从区分。
    //
    // ⚠️ **本计划没有请求构建器** —— 逃生舱把 body 原样透传，所以这条事实
    // **只能靠 note 传达**（与 `editKnowledgeNoSimilars` 的字段改名同一条渠道、
    // 同一条理由）。此前 5 条 note **一条都没写它**，而"生成清单"里只写了
    // "请求构建器必须强制它" —— 那个构建器在本计划里不存在，等于没写。
    const WRITES = ['ai.knowledge.addKnowledge', 'ai.knowledge.editKnowledge',
                    'ai.knowledge.deleteKnowledges', 'ai.knowledge.editChannelAnswer',
                    'ai.knowledge.editKnowledgeNoSimilars']
    for (const id of WRITES) {
      expect(byId(id).note ?? '', `${id} 的 note 必须点名 robotId 必填`).toMatch(/robotId/)
    }
  })

  it('知识库写接口的 note 带上文档的字段长度上限 —— 逃生舱不校验 body，note 是唯一渠道', () => {
    // 设计稿 §5.4.1 共享契约（逐字摘自官方字段表）：`answer` 上限 3500 字符；
    // 一条标准问最多 200 个相似问、每个 ≤ 50 字符。⚠️ 这是**文档值、未实测**
    // （写接口在本计划里从不调用），note 必须如实标注"文档"而非暗示实测过。
    // 与 robotId 必填同一条渠道：本计划没有请求构建器，超长 body 会原样发出，
    // 服务端怎么回（14004？截断？静默接受？）无人知道 —— 只能事前提醒。
    const WITH_ANSWER = ['ai.knowledge.addKnowledge', 'ai.knowledge.editKnowledge',
                         'ai.knowledge.editKnowledgeNoSimilars']
    for (const id of WITH_ANSWER) {
      const note = byId(id).note ?? ''
      expect(note, `${id} 的 note 必须点名 answer 的 3500 字符上限`).toMatch(/3500/)
      expect(note, `${id}：上限是文档值不是实测值，必须如实标注`).toMatch(/文档/)
    }
    for (const id of ['ai.knowledge.addKnowledge', 'ai.knowledge.editKnowledge']) {
      const note = byId(id).note ?? ''
      expect(note, `${id} 的 note 必须点名相似问的 200 条 / 50 字符上限`).toMatch(/200 条/)
      expect(note, `${id} 的 note 必须点名相似问的单条 50 字符上限`).toMatch(/50 字符/)
    }
  })

  it('editKnowledge 的 note 点名 validitySwitch —— 它写时必填、却读不到（设计稿 §10.5.5.1）', () => {
    // 同一条推理链（必填字段 → 只能靠 note 传达），但这条坑更隐蔽：
    // `validitySwitch` 在 `editKnowledge` 的文档 `required` 里，而**产出该对象的
    // list 端点（`robot.data.knowledge`）的官方字段表里根本没有这个字段**，
    // 它只出现在 `ai.knowledge.getDetail` 的响应里。→ 一个照着 list 结果去"改
    // 一个字段再写回"的 Agent，读不到它、传漏了、报错与"接口坏了"无从区分。
    // 设计稿把它称为「§5.4.1 读-改-写隐患的一个具体实例」。
    //
    // ⚠️ 此前**全文 0 次出现 `validitySwitch`** —— 连"生成清单"都只写了
    // `similars` 三态与 `question` 字段改名，漏掉了这个"读不到的必填字段"。
    expect(byId('ai.knowledge.editKnowledge').note ?? '',
      'note 必须点名 validitySwitch 及其唯一来源').toMatch(/validitySwitch/)
    expect(byId('ai.knowledge.editKnowledge').note ?? '',
      '必须指出读不到 → 只能从 getDetail 取或显式传').toMatch(/getDetail|显式传/)
  })

  it('merchant.account.login 的 note 记录上游 required 自相矛盾 —— 参数表会误判', () => {
    // 上游页面（api-10845577）的 description 写「code和shopCode必填其一」，
    // 而同一页 schema 的 required 把 userName/code/shopCode 三者都标了必填。
    // 参数表（params/merchant.account.login.json）忠实按 schema 生成 —— 上游快照
    // 不得篡改，所以矛盾只能经 note 这一个渠道告诉调用方，否则"只传其一"会被
    // 误判为不完整请求。
    const note = byId('merchant.account.login').note ?? ''
    expect(note, 'note 必须点名 code/shopCode 必填其一与 required 的冲突').toMatch(/必填其一/)
    expect(note, 'note 必须指向会误判的那份参数表').toMatch(/merchant\.account\.login\.json/)
  })
})

describe('loadSpecs —— 加载期校验（唯一挡住门禁 fail-open 的地方）', () => {
  // 这些分支只在模块加载时跑一次，且**只在注册表畸形时**触发。
  // 它们挡的正是「生成脚本产出的 154 条漏了字段」这种真实场景：
  // 漏了 dangerous，门禁就静默 fail-open，而 api call 是唯一的写入口。
  const base = { id: 'x', title: 't', method: 'POST', path: '/p', direction: 'outbound',
                 callable: true, dangerous: false, auth: 'checksum', verified: false, envelope: 'A' }

  it('顶层不是数组时抛错，而不是把对象当数组用', () => {
    expect(() => loadSpecs({})).toThrow(/数组/)
  })

  it('缺少 id 时抛错', () => {
    expect(() => loadSpecs([{ ...base, id: '' }])).toThrow(/缺少 id/)
  })

  it('id 重复时抛错 —— 后者会静默覆盖前者，byId 拿到哪条取决于顺序', () => {
    expect(() => loadSpecs([base, base])).toThrow(/重复 id/)
  })

  it('非法 pageId 时抛错', () => {
    expect(() => loadSpecs([{ ...base, pageId: 'bad-page' }])).toThrow(/pageId 非法/)
  })

  it('pageId 末尾带换行也被拒 —— JS 的 $ 不匹配末尾换行之前', () => {
    // ⚠️ 钉住一个**外部审查误报过的**行为：有人以为 `/^api-\d+$/` 会放行 `"api-1\n"`
    // （那是 Python/Perl 里 `$` 的语义）。JS 中无 `m` 标志时 `$` 只匹配输入末尾，
    // 不匹配末尾换行之前，故这里本就抛错。写这条测试是为了让"误报"不能变成
    // "有人照着改成正则" —— 改成 `m` 标志反而会真的放行。
    expect(/^api-\d+$/.test('api-1\n'), '前提：JS 的 $ 不放行末尾换行').toBe(false)
    expect(() => loadSpecs([{ ...base, pageId: 'api-1\n' }])).toThrow(/pageId 非法/)
  })

  it('重复 pageId 时抛错', () => {
    expect(() => loadSpecs([{ ...base, id: 'a', pageId: 'api-1' }, { ...base, id: 'b', pageId: 'api-1' }]))
      .toThrow(/重复 pageId/)
  })
  it('缺少 dangerous 时抛错 —— 这一条就是门禁 fail-open 的唯一防线', () => {
    const { dangerous: _drop, ...noDangerous } = base
    expect(() => loadSpecs([noDangerous])).toThrow(/dangerous/)
  })

  it('dangerous 不是布尔时抛错 —— 字符串 "false" 是 truthy，门禁会反过来误拦', () => {
    expect(() => loadSpecs([{ ...base, dangerous: 'false' }])).toThrow(/dangerous/)
  })

  it('缺少 callable 时抛错', () => {
    const { callable: _drop, ...noCallable } = base
    expect(() => loadSpecs([noCallable])).toThrow(/callable/)
  })

  it('callable 为 true 但没有 path 时抛错 —— 否则会拼出 https://…null 发出去', () => {
    // 实测：path 为 null 时 `${BASE}${spec.path}?...` 得到 `https://qiyukf.comnull?...`，
    // 请求照样发出去，服务端返回一个与真实原因无关的错误。
    // 与 dangerous 同理：宁可加载时炸，也不要运行时静默发一个错误的请求。
    expect(() => loadSpecs([{ ...base, path: null }])).toThrow(/path/)
    expect(() => loadSpecs([{ ...base, path: '' }])).toThrow(/path/)
  })

  it('不可调用的接口没有 path 是合法的（入站推送、文档缺路径）', () => {
    // 反向：`wecom.robot.switch` 这类 path 为 null 但 callable 为 false 的记录
    // 是合法的 —— 校验不能一刀切。
    expect(() => loadSpecs([{ ...base, path: null, callable: false }])).not.toThrow()
  })

  it('入站接口被标成可调用时抛错 —— 这是矛盾组合，且 path="/" 拦不住', () => {
    // ⚠️ 入站推送（`direction: 'inbound'`）是七鱼回调我方，**不存在可主动调用的 URL**。
    // 它的 path 在本计划里是占位符 `"/"`（见 specs.json 的 receive.message）——
    // 而 `"/"` 是 truthy，`callable === true && !path` 那道校验**拦不住它**。
    // 若生成脚本把入站接口误标为 callable，会拼出 `https://qiyukf.com/?appKey=...`
    // 发出去（服务端返回一个与真实原因无关的响应）。这条把矛盾组合在加载时拦下。
    expect(() => loadSpecs([{ ...base, direction: 'inbound', callable: true }]))
      .toThrow(/inbound|入站/)
    // 反向：入站 + 不可调用是合法的（receive.message 就是这样）
    expect(() => loadSpecs([{ ...base, direction: 'inbound', callable: false }])).not.toThrow()
  })

  it('envelope 拼错时抛错，而不是静默退化成宽松模式', () => {
    // ⚠️ 拼错的值不报错的话，形状 C 的接口会把 message 里的 JSON 字符串
    // 原样当载荷返回 —— Agent 拿到的是一段字符串而不是对象，且无从知道原因。
    expect(() => loadSpecs([{ ...base, envelope: 'd' }])).toThrow(/envelope/)
    expect(() => loadSpecs([{ ...base, envelope: 'E' }])).toThrow(/envelope/)
    expect(() => loadSpecs([{ ...base, envelope: 'A ' }])).toThrow(/envelope/)
    // ⚠️ **缺键**同样必须抛（2026-10-05 补）。`undefined` 既不是合法枚举值、
    // 也不是显式的 `null`，守卫 `o.envelope !== null && !ENVELOPES.has(o.envelope)`
    // 会把它接住 —— 但此前**没有一条测试喂过缺键的记录**。
    // 为什么重要：`loadSpecs` 的返回类型要求 `envelope` 存在，若守卫被改成
    // `if (o.envelope != null && !ENVELOPES.has(...))`（一个看似等价的"更安全"写法），
    // 缺键就会**静默通过**，然后在 `api list` 输出里整个丢键（`JSON.stringify`
    // 丢 `undefined`）—— Agent 看到的记录连 `envelope` 字段都没有。
    // 「缺键 = 未实测」与「显式 null = 未实测」是两回事，前者是生成脚本的缺陷。
    const { envelope: _drop, ...noEnv } = base
    expect(() => loadSpecs([noEnv]), '缺 envelope 键必须被拒，不能静默当 null').toThrow(/envelope/)
  })

  it('envelope 的合法取值都通过 —— 含 D 与 D-nf 这两个语义相反的值', () => {
    for (const env of ['A', 'B', 'C', 'D', 'D-nf', null]) {
      expect(() => loadSpecs([{ ...base, envelope: env }]), String(env)).not.toThrow()
    }
  })

  it('注册表里 D 族接口的 envelope 取值被逐一钉住 —— 复核重点 9 的落点在这里', () => {
    // ⚠️ **复核重点 9 声称"落在任务 4 与任务 6"，但任务 6 此前**没有任何测试**兑现它。**
    // 上面那条只断言"枚举合法值能通过"，而第 9 条要守的是**语义错误**：
    // `robot.transfer.config` 与 `robot.session.msgAssociate` 的空报文**逐字节相同**
    // （都是 `{code:200}`），语义却相反 —— 前者正常成功（`'D'`）、后者查无此物（`'D-nf'`）。
    // `loadSpecs` 只校验取值合法性，本来就挡不住"两个接口填同一个值"。
    //
    // 实测确认这个缺口是真的：把 `transfer.config` 的 envelope 从 `'D'` 改成 `'D-nf'`，
    // **全量测试照样全绿**（因为没有任何断言读它的 envelope 值），而它实测返回的空壳
    // `{code:200}` 会被静默判成 `not_found: true` —— 正是第 9 条警告的失败形态本身。
    //
    // → 每个已进注册表的 D 族接口，取值必须逐个钉住。将来生成脚本把 msgAssociate
    // 也加进来时，照抄这一行给它是 `'D-nf'`，而不是想当然的 `'D'`。
    expect(byId('robot.transfer.config').envelope, '空壳是正常成功，不是查无此物').toBe('D')
    // ⚠️ **形状 C 的那条也必须钉住**（2026-10-05 补）。注册表里唯一一条 `'C'` 是
    // `ticket.search` —— 它的 `envelope` 此前**零断言**：改成 `null` 甚至 `'D'`
    // 全量测试仍绿（两个 mock 用例在宽松模式下结论相同）。而后果正是复核重点 6
    // 点名的头号静默失败：形状 C 的接口在 `envelope: null` 下，限流/超限那种
    // `code:200` + 纯文本 message 会被报成"成功但无数据"。
    expect(byId('ticket.search').envelope, '形状 C 的 code:200 可能是错误，必须如实标注').toBe('C')
    expect(byId('robot.session.msgAssociate').envelope).toBe('D-nf')
  })

  it('缺少 title 时抛错 —— 否则门禁消息里会输出 `（undefined）`', () => {
    // ⚠️ `assertConfirmed` 的错误消息是 `接口 ${id}（${title}）是危险操作`。
    // title 缺失（或拼错键名）时它输出 `接口 x（undefined）是危险操作` ——
    // Agent 拿不到人类可读的接口名，不知道该确认什么。
    const { title: _drop, ...noTitle } = base
    expect(() => loadSpecs([noTitle])).toThrow(/title/)
    // ⚠️ 空串也必须抛 —— 上面那条只测了"键缺失"。`|| !o.title` 这一半此前没测
    // （操作符变异扫描确认：把它改成 `&&` 测试照样全绿）。而生成脚本产出一个
    // `title: ""` 是很自然的错误（文档页标题为空），它同样会让门禁消息输出
    // `接口 x（）是危险操作` —— 与缺键是同一个后果，只是入口换了。
    expect(() => loadSpecs([{ ...base, title: '' }])).toThrow(/title/)
  })

  it('direction 拼错时抛错 —— 否则接口会从 api list 里静默消失', () => {
    // ⚠️ 这是 §9.2 头号静默失败的一个变体，发生在注册表加载层：
    // `api list` 默认过滤器是 `e.callable && e.direction === 'outbound'`，
    // 一个拼错的 direction（如 'outboud'）会让该接口**静默不出现在清单里**，
    // Agent 据此判断"这个功能不存在"。必须在加载时就炸。
    expect(() => loadSpecs([{ ...base, direction: 'outboud' }])).toThrow(/direction/)
    expect(() => loadSpecs([{ ...base, direction: 'INBOUND' }])).toThrow(/direction/)
    expect(() => loadSpecs([{ ...base, direction: 'outbound' }])).not.toThrow()
    // ⚠️ inbound 必须配 callable:false —— base 的 callable 是 true，而
    // 「inbound + callable」是矛盾组合（入站接口无法被主动调用），会被另一条校验拦下。
    expect(() => loadSpecs([{ ...base, direction: 'inbound', callable: false }])).not.toThrow()
  })

  it('method 缺失或非法时抛错 —— 否则 fetch 会默认成 GET 并给出误导性错误', () => {
    // ⚠️ method 缺失时 undici 默认 GET；若请求带 body，会抛
    // "Request with GET/HEAD method cannot have body" —— 一个与真实原因
    // （注册表缺字段）毫无关系的错误。
    const { method: _drop, ...noMethod } = base
    expect(() => loadSpecs([noMethod])).toThrow(/method/)
    expect(() => loadSpecs([{ ...base, method: 'PUT' }])).toThrow(/method/)
    for (const m of ['POST', 'GET']) {
      expect(() => loadSpecs([{ ...base, method: m }]), m).not.toThrow()
    }
  })

  it('auth 缺失或非法时抛错 —— 它决定将来是否签名', () => {
    // ⚠️ 本计划的 `call()` 无条件签名，不读 `auth`（见「已知缺口」）——
    // 但字段本身必须是合法枚举：生成脚本产出 154 条时，一个拼错的 auth
    // 会让"这个接口是否需要签名"这个决定失去依据，而它现在没人读、
    // 将来一定会被读（`auth: 'none'` 的接口不该签名）。
    const { auth: _drop, ...noAuth } = base
    expect(() => loadSpecs([noAuth])).toThrow(/auth/)
    expect(() => loadSpecs([{ ...base, auth: 'checkum' }])).toThrow(/auth/)
    for (const a of ['checksum', 'eventType', 'none']) {
      expect(() => loadSpecs([{ ...base, auth: a }]), a).not.toThrow()
    }
  })

  it('path 非字符串或不以 / 开头时抛错 —— 否则会拼出一个看似正常却错误的 URL', () => {
    // ⚠️ 此前只判了 `!o.path`（truthy），实测 `path: 123` 能通过校验，
    // 然后在 `call()` 里被模板串拼成 `https://qiyukf.com123?appKey=...` ——
    // **请求照常发出去**，命中一个与真实原因毫无关系的地址。
    // 这与 `path: null` 是同一种后果，只是入口换了：只判 truthy 挡不住
    // "非空但不是字符串"的值。`path: 'openapi/x'`（不以 / 开头）同样会拼出
    // `https://qiyukf.comopenapi/x`。
    expect(() => loadSpecs([{ ...base, path: 123 }])).toThrow(/path/)
    expect(() => loadSpecs([{ ...base, path: {} }])).toThrow(/path/)
    expect(() => loadSpecs([{ ...base, path: 'openapi/x' }])).toThrow(/path/)
    // 反向：合法形态必须通过 —— 含入站推送的占位符 `/`
    expect(() => loadSpecs([{ ...base, path: '/openapi/x' }])).not.toThrow()
    expect(() => loadSpecs([{ ...base, path: '/' }])).not.toThrow()
    // ⚠️ `path` **键整个缺失**也必须抛错（2026-10-08 补）。此前判据是
    // `o.path !== null && o.path !== undefined` —— 键缺失（undefined）被放行，
    // 而 `EndpointSpec.path` 是必填、`api list` 无条件输出 `path: e.path`，
    // `undefined` 会让该键在 JSON 里**整个消失**（与下面 `verified` 那条同一个病）。
    // ⚠️ 夹具必须 `callable: false` —— 否则会先被上面「callable 却没有 path」接住
    // （那是另一条分支，消息不同）。
    const { path: _dropPath, ...noPath } = base
    expect(() => loadSpecs([{ ...noPath, callable: false }])).toThrow(/缺少 path 字段/)
  })

  it('verified 缺失时抛错 —— undefined 会在 JSON 里整个丢键，Agent 无从判断可信度', () => {
    // ⚠️ `JSON.stringify({verified: undefined})` → `{}` —— 字段**整个消失**，
    // 而不是变成 null。Agent 看到一条连 verified 都没有的记录，无法区分
    // "已实测"与"未实测"，会把注册了当成验证过了。
    const { verified: _drop, ...noVerified } = base
    expect(() => loadSpecs([noVerified])).toThrow(/verified/)
    expect(() => loadSpecs([{ ...base, verified: 'true' }])).toThrow(/verified/)
  })

  it('maxWindowDays 非数字时抛错 —— 字符串会算出 NaN，负数会让所有窗口都超限', () => {
    // ⚠️ 实测 `maxWindowDays: "31"` 能通过加载，然后在 `api list` 里原样输出
    // `"max_window_days": "31"` —— Agent 按 `span <= "31" * 86400000` 算得到 NaN，
    // 切片逻辑静默失效（NaN 比较恒为 false）；负数则会让任何窗口都被判为超限。
    expect(() => loadSpecs([{ ...base, maxWindowDays: '31' }])).toThrow(/maxWindowDays/)
    expect(() => loadSpecs([{ ...base, maxWindowDays: -1 }])).toThrow(/maxWindowDays/)
    expect(() => loadSpecs([{ ...base, maxWindowDays: NaN }])).toThrow(/maxWindowDays/)
    // 反向：正常值通过；省略也合法（表示"没有已知上限"）
    expect(() => loadSpecs([{ ...base, maxWindowDays: 31 }])).not.toThrow()
    expect(() => loadSpecs([base])).not.toThrow()
    // ⚠️ 0 必须通过 —— 文档契约是"**非负**数字"，0 是非负的。把 `< 0` 改成 `<= 0`
    // 会拒绝 0，而测试照样全绿（操作符变异扫描确认）。0 的语义是"只接受零宽窗口"，
    // 退化但不是错误数据；把它在加载时判死会让生成脚本对某个真实上限为 0 的接口无从表达。
    expect(() => loadSpecs([{ ...base, maxWindowDays: 0 }])).not.toThrow()
    // ⚠️ `null` 必须抛错（2026-10-05 加）。此前守卫是 `!== undefined && !== null`，
    // `null` 被跳过校验，而 `api list` 的判据是 `!== undefined` —— 于是
    // `"maxWindowDays": null` 会被原样输出成 `"max_window_days": null`，
    // 与「未输出该键 = 没有已知上限」的约定和 `maxWindowDays?: number` 的类型三处矛盾。
    // 本计划的约定是"缺键 = 没有上限"，所以 null 是非法写法，必须在加载时炸。
    expect(() => loadSpecs([{ ...base, maxWindowDays: null }])).toThrow(/maxWindowDays/)
  })

  it('loadSpecs 的抛错消息不得含 Markdown —— 崩溃栈也是纯文本通道', () => {
    // ⚠️ 同一条规则（"输出给谁看，就按谁的格式写"）的**第三个出口**（2026-10-06 补）：
    // api.test.ts 的两条哨兵守了 help 文本（stdout）与 stderr；而 `loadSpecs` 的
    // 抛错发生在**模块加载期** —— specs.json 畸形时它以未捕获异常的形式**随堆栈
    // 原样进终端**（Node 默认打印器，不经过任何输出层），读者是生成脚本的作者。
    // 实测缺口：maxWindowDays 的消息里写着 `或**整个省略该键**`，终端上就是字面星号。
    //
    // ⚠️ 逐行按 **throw 点清单**点名（⑳ 的教训），不按"我记得有哪几个" ——
    // `loadSpecs` 共 **16** 个抛错分支（2026-10-08：`path` 键缺失那条从
    // "静默放行"改成显式抛错，15 → 16），每行附**期望命中的分支特征**：少了它，
    // 夹具一旦漂移到别的分支，这一行会拿另一条消息的"无 `**`"结果假通过。
    const without = (k: string) => {
      const o: Record<string, unknown> = { ...base }
      delete o[k]
      return o
    }
    const CASES: Array<[string, unknown, RegExp]> = [
      ['顶层不是数组', {}, /顶层必须是数组/],
      ['id 缺失或为空', [{ ...base, id: '' }], /缺少 id/],
      ['id 重复', [base, { ...base }], /重复 id/],
      ['缺 dangerous', [without('dangerous')], /dangerous/],
      ['缺 callable', [without('callable')], /callable/],
      ['可调用却没有 path', [{ ...base, path: null }], /缺少 path/],
      // ⚠️ 2026-10-08 补：`path` **键整个缺失**此前被静默放行 ——
      // 与上一行（path: null + callable）是两条不同的分支：那条走 `!o.path`（callable 检查），
      // 这条走新增的 `!('path' in o)`。夹具必须 callable: false 才能到这条，
      // 否则会先被 `callable && !path` 那条接住（同样含"缺少 path"字样、但那是另一条分支）。
      ['path 键整个缺失', [{ ...without('path'), callable: false }], /缺少 path 字段/],
      ['path 不以 / 开头', [{ ...base, path: 'openapi/x' }], /path 必须是/],
      ['缺 verified', [without('verified')], /verified/],
      ['maxWindowDays 非法（本条的实测来源）', [{ ...base, maxWindowDays: null }], /maxWindowDays/],
      ['入站却标为可调用', [{ ...base, direction: 'inbound', callable: true }], /入站接口/],
      ['envelope 拼错', [{ ...base, envelope: 'E' }], /envelope/],
      ['缺 title', [without('title')], /title/],
      ['direction 拼错', [{ ...base, direction: 'outboud' }], /direction/],
      ['method 非法', [{ ...base, method: 'PUT' }], /method/],
      ['auth 非法', [{ ...base, auth: 'nope' }], /auth/],
    ]
    for (const [label, raw, pattern] of CASES) {
      let msg = ''
      try { loadSpecs(raw) } catch (e) { msg = e instanceof Error ? e.message : String(e) }
      // ⚠️ 先钉住命中的分支 —— 同时排除了"夹具其实合法、根本没抛错"的空转。
      expect(msg, `${label}：夹具必须真的触发对应分支`).toMatch(pattern)
      expect(msg, `${label}：抛错消息含 Markdown 标记，崩溃栈会在终端原样显示它`)
        .not.toMatch(/\*\*/)
    }
  })
})
