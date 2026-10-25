// tests/commands/api.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { apiCommand, assertGetHasNoBody } from '../../src/commands/api.js'
import { authCommand } from '../../src/commands/auth.js'
import { __resetBuckets } from '../../src/core/http.js'
import { setLocalFallbackProvider } from '../../src/commands/local-fallback.js'
// `registry_complete` 那条测试要拿注册表**实际条数**与 `meta.registry_note` 比对，
// 才能证明该字段是由数据推导的、不是一个独立写死的常量。
import { allEndpoints } from '../../src/core/registry/index.js'
import { setParamsRoot } from '../../src/core/registry/params.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let out = ''
let err = ''
beforeEach(() => {
  out = ''
  err = ''
  // ⚠️ 令牌桶是 http.ts 的**模块级** Map，同一测试文件内的用例共享它。
  // 本文件有 24 处 `apiCommand(['call', 'ticket.search', …])`（2026-10-08 三次重测：
  // 13 → 23 → 24，每次都是增删用例后没人跟着改），其中**恰好 5 处**
  // 真的发到 `call()`（其余 19 处够不到令牌桶）；另有 1 处走 `message.send`，
  // 本文件共 **6 次**进 `call()`。
  // ⚠️ 四个数里只有这两个是**探针实测**的：「5 处」「共 6 次」（2026-10-08 复测，
  // 在 `call()` 入口插 `appendFileSync` 后 `sort | uniq -c` 得到
  // 5×ticket.search + 1×message.send）。
  // 「24 处」是 grep 出现次数、「19 处」是 24 − 5 推出来的 —— 它们随用例增删漂，
  // **别给它们编子分类**（比如"15 处返回 2 / 4 处走 help"）：真实测试环境里
  // 各用例的凭证 stub 不同，同一 argv 在探针环境与单测环境里会得到不同的退出码，
  // 那种子分类要么实测要么不写。数法：在 `call()` 入口临时插一行
  // `appendFileSync('/tmp/probe.log', spec.id)`，跑一次单文件测试再 `sort | uniq -c`。
  // **别用读代码数调用点** —— 夹具里 `stubEnv` 配了凭证、`--yes` 又能放行门禁，
  // "源码里写了几次"与"真的发了几次"不是一回事（24 处调用点里 19 处够不到
  // `call()`，而其中 5 处 + message.send 那处才发出去）。
  //
  // 当前 ticket.search 不在限频表里、桶不启用，所以不重置也看不出问题 ——
  // 但这是**脆弱的**：一旦生成脚本给它补上限频行，本文件连续 5 次 `call(ticket.search)`
  // 会把令牌消耗殆尽。⚠️ **实测过这个反事实**（2026-10-06 初测 3 条，
  // 2026-10-08 因新用例抢先持桶而变 4 条）：给 ticket.search 补一行
  // `1 次/180 秒` 并注释掉本行 `__resetBuckets()` → **4 条失败**
  // （`请求构造失败` 那条**抢先拿到令牌**、不受影响；随后的 `成功但查无此物`、
  // `正常有数据的成功响应`、`成功响应也带上该接口的 note`、`--yes 重复写` 必被拒），
  // 是**确定性**的失败（首次之后的每次调用必被拒），不是"随机" —— 别把它当成
  // 偶发 flake 去重跑。与 http.test.ts 一致地重置。
  __resetBuckets()
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  // stderr 也要捕获 —— 只断言退出码区分不出"哪个分支拦下的"：
  // --pretty 与未知参数都返回 2，删掉 --pretty 分支测试照样绿（变异测试确认过）。
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
})
// 用例会 stubEnv 配凭证（否则"没发请求"的断言会因缺凭证而假通过），
// 所以这里必须一并清掉，避免污染后续用例。
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

const rows = () => JSON.parse(out).data as Array<Record<string, unknown>>

describe('api list', () => {
  it('默认只列可主动调用的出站接口', async () => {
    await apiCommand(['list'])
    // 先断言非空 —— 否则 every() 对空数组恒为 true，这个用例等于没测
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().every((r) => r.callable === true && r.direction === 'outbound')).toBe(true)
  })

  it('默认不包含被动推送事件', async () => {
    await apiCommand(['list'])
    expect(rows().length).toBeGreaterThan(0)
    expect(rows().some((r) => r.path === '/')).toBe(false)
  })

  it('--all 时包含不可调用的接口，并标明原因', async () => {
    await apiCommand(['list', '--all'])
    const push = rows().find((r) => r.id === 'receive.message')
    expect(push).toBeDefined()
    expect(push!.callable).toBe(false)
    expect(push!.note, '不可调用接口必须带说明为什么').toMatch(/入站|推送/)
  })

  it('`path: null` 与 `path: "/"` 含义不同，meta 必须分别解释', async () => {
    // ⚠️ `--all` 会输出两种"路径不可用"，但含义完全相反：
    //   `null` = 路径**未收录**（文档页没给可用路径，是数据缺口）
    //   `"/"`  = 入站推送的**占位符**（不是真实路径）
    // 而 `direction` 的 note 说「outbound = 本方主动调用它」—— 于是
    // `direction: outbound` + `path: null` 表面自相矛盾，Agent 无从判断该信哪个。
    // 缺了说明它最可能拿 id 去猜路径拼 URL（必然 404，报错与真实原因无关）。
    // 断言命中"未收录"与"占位符"两个要点，而不是只断言 key 存在。
    await apiCommand(['list', '--all'])
    const note = JSON.parse(out).meta.field_notes.path
    expect(note, 'path 的两种不可用形态必须分别解释').toMatch(/未收录/)
    expect(note, '必须点明 "/" 是占位符').toMatch(/占位符/)
    // 顺带确认注册表里这两种形态真的都存在 —— 否则上面那条 note 在描述一个
    // 当前不存在的分支，测试就成了"对着假想写断言"。
    const all = rows()
    expect(all.some((r) => r.path === null), '注册表应有一条 path:null 的接口').toBe(true)
    expect(all.some((r) => r.path === '/'), '注册表应有一条入站占位符接口').toBe(true)
  })

  it('危险接口被标注出来', async () => {
    await apiCommand(['list', '--all'])
    expect(rows().find((r) => r.id === 'message.send')!.dangerous).toBe(true)
  })

  it('每条记录都带 id 与标题，供 Agent 据此**定位**接口', async () => {
    // ⚠️ 标题原写"据此发起调用"，**是过强的**（2026-10-05 改）：`id`/`title` 只够定位，
    // 不够构造 body —— 注册表没有 `params`（见「已知缺口」）。标题写"发起调用"而
    // 实际给不出参数，正是本计划在修的"测试名比断言强"。改成"定位"才与断言相符。
    await apiCommand(['list'])
    expect(rows().length).toBeGreaterThan(0)
    // ⚠️ 不能只断言 `typeof r.id === 'string'`（2026-10-07 改）—— 那是**恒真**的：
    // `loadSpecs` 已强制 id/title 为非空字符串，能进 `rows()` 的记录必然满足，
    // 于是这个循环对任何实现都绿，等于没测。改成钉**内容**：默认视图（可调用 + 出站）
    // 恰好是这 9 条，id 与 title 一一对应且 title 不是 id 的复读。
    expect(rows().map((r) => r.id).sort()).toEqual([
      'ai.knowledge.addKnowledge', 'ai.knowledge.deleteKnowledges',
      'ai.knowledge.editChannelAnswer', 'ai.knowledge.editKnowledge',
      'ai.knowledge.editKnowledgeNoSimilars', 'ai.knowledge.getCategoryTree',
      'ai.knowledge.getDetail', 'ai.knowledge.search', 'ai.statistic.transferHuman',
      'category.list', 'chat.queue.group.query', 'crm.syncCrmInfo', 'data.overview.ipcc',
      'data.overview.session', 'evaluation.setting.get', 'event.applyStaff',
      'event.evaluate', 'event.queryQueueStatus', 'event.quitQueue', 'event.updateUInfo',
      'export.session', 'export.session.check', 'export.session.one',
      'export.session.one.message', 'icoutcall.callIntercept.list',
      'icoutcall.dialogFlow.fuzzySearch', 'icoutcall.dialogFlow.getDialogFlowList',
      'icoutcall.get.customer', 'icoutcall.get.jobdetail', 'icoutcall.get.jobproperties',
      'icoutcall.history.seat', 'icoutcall.history.team', 'icoutcall.job.create',
      'icoutcall.job.importcustomer', 'icoutcall.job.pause', 'icoutcall.job.readdcustomer',
      'icoutcall.job.start', 'icoutcall.job.terminate', 'icoutcall.phone.getLineList',
      'ipcc.calltask.add.auto', 'ipcc.calltask.add.byCustom', 'ipcc.calltask.add.byRelation',
      'ipcc.calltask.add.toGroup', 'ipcc.calltask.add.toStaff', 'ipcc.calltask.get',
      'ipcc.calltaskdetail.add', 'ipcc.calltaskdetail.delete', 'ipcc.calltaskdetail.get',
      'ipcc.calltaskdetail.update', 'ipcc.customfield.template.get', 'ipcc.login',
      'kefu.add', 'kefu.delete', 'kefu.update', 'kefu.v2.query', 'kefuGroup.add',
      'kefuGroup.delete', 'kefuGroup.update', 'kefuGroup.updateKefus',
      'merchant.account.login', 'merchant.changePassword', 'merchant.create',
      'merchant.disable', 'merchant.enable', 'merchant.list', 'merchant.query',
      'merchant.update', 'message.send', 'message.send.image', 'message.send.voice',
      'message.sendFile', 'message.uploadFile', 'online.session.category.list',
      'online.session.customfield.template', 'online.session.customfield.update',
      'order.upload', 'push.msg.image', 'push.msg.richText', 'push.msg.text',
      'robot.data.getQuestionsByCategoryName', 'robot.data.knowledge', 'robot.data.kpoint',
      'robot.data.queryStandardByEffectiveQuestion', 'robot.data.queryStandardQuestionList',
      'robot.evaluation.comment', 'robot.evaluation.setting', 'robot.session.assist',
      'robot.session.chat', 'robot.session.close', 'robot.session.commonQuestions',
      'robot.session.create', 'robot.session.evaluation', 'robot.session.msgAssociate',
      'robot.session.msgEvaluation', 'robot.session.msgPredict', 'robot.session.transfer',
      'robot.session.uploadFile', 'robot.statistic.summary', 'robot.transfer.config',
      'session.user.profile', 'settings.wxTemplates', 'smstask.create', 'smstask.status',
      'staff.group.list.new', 'staff.group.members.new', 'staff.list.new', 'staff.login',
      'statistic.overview', 'statistic.performance', 'statistic.salaryDetail',
      'statistic.satisfaction.report', 'statistic.staffAttendance', 'statistic.staffquality',
      'statistic.staffworklod', 'tag.all', 'tag.batchUpdate', 'tag.update', 'ticket.apply',
      'ticket.batch.modify', 'ticket.create', 'ticket.filter.count', 'ticket.filter.list',
      'ticket.finish', 'ticket.followers.update', 'ticket.list', 'ticket.log', 'ticket.modify',
      'ticket.new.detail', 'ticket.reminder', 'ticket.reopen', 'ticket.reply', 'ticket.search',
      'ticket.template.fields', 'ticket.template.list', 'ticket.transfer', 'track.event.set',
    ])
    for (const r of rows()) {
      expect(r.title, `${r.id} 的 title 必须非空`).not.toBe('')
      expect(r.title, `${r.id} 的 title 不能只是把 id 复读一遍 —— 它得是中文名`).not.toBe(r.id)
    }
  })

  it('meta 明说请求参数表**不在**本注册表里 —— 否则 Agent 以为能据此构造 body', async () => {
    // ⚠️ 每条记录都带着 `id`，一个自然的误读是"我能拼出这次调用"。但 body 需要
    // `params`（本计划没有），Agent 只能猜字段，然后在 14004 或静默忽略上撞墙，
    // 且无从知道是自己猜错了还是接口坏了。`request_schema` 这条元信息把
    // "没有这个能力"显式说出来 —— 与 `verified`/`direction` 同一条标准。
    await apiCommand(['list'])
    const note = JSON.parse(out).meta.field_notes.request_schema
    expect(note).toMatch(/不含|不提供|没有/)
    expect(note).toMatch(/响应体不做校验/)
    expect(note).toMatch(/不要删字段重试/)
    expect(note).toMatch(/api schema/)
    // ⚠️ 这条字符串**逐字输出给 Agent**，所以它点名的错误码必须是"传错字段"真会得到的。
    // 此前写的是「多半回 14003/14004」（2026-10-06 修）—— 而 14003 是 `time` 错误
    // （鉴权层的时间戳/时钟偏移），与 body 字段毫无关系：设计稿 §4.3 错误码表如此定义
    // （⚠️ 2026-10-07 修：此前误标 §4.2 —— §4.2 是「凭证管理」，全文无错误码表；
    //  两张错误码表都在 §4.3「错误处理」—— 与上文那处更正一致（原文逐字：「两张错误码表都在 §4.3「错误处理」」）），
    // 本计划自己的 `classify` 也把 14003 判成 `bad_time` 并把 hint 指向"校对时钟"。
    // 传错字段只会得到 14004（或干脆被静默忽略）。Agent 读到 14003 会把一个鉴权问题
    // 当成参数问题去查 body —— 方向完全相反。
    expect(note, 'request_schema 必须点名传错字段真会得到的码').toMatch(/14004/)
    expect(note, '14003 是 time 错误，与 body 字段无关，不得在此出现')
      .not.toMatch(/14003/)
  })

  it('明确告知注册表尚未收录全部接口', async () => {
    // 只列 9 条（默认过滤后的行数）却不说"不完整"，Agent 会据此判断某个功能不存在
    //
    // ⚠️ 这条断言现在**有意义**了：此前实现是写死的字面量 `false`，测试断言
    // `=== false` 属于"常量等于它自己"——补齐 specs.json 到 154 条后它仍是 false、
    // 测试仍全绿。现在实现是 `allEndpoints().length >= 154`，**数据补齐会自动翻面**，
    // 于是这条断言变成一个哨兵：谁补齐了注册表而没改测试/阈值，这里会红。
    // 下方反向断言确保它不会**恒真**（恒真同样是无信息的哨兵）。
    //
    // ⚠️ 阈值是 **154** 不是 150：设计稿 §5.3 的 150 是**文档页面数**，而 §7.5 另有
    // 4 个接口不在那 150 个清单里、**必须单独编入注册表** —— 它们是会话导出流水线的
    // 端点（`export/session`、`export/session/check`、`export/session/one`、`/one/message`），
    // 不是 `smstask` 一族（`smstask` 在 §4.3/§7.4/§9.0，与 line 928 无关）。
    // 本测试此前写 150 而实现写 154 —— 两者当前都产出 `false` 所以没暴露，
    // 但生成脚本补到 154 条那一刻，测试算 `true`、实现算 `false`，会以**错误的理由**变红
    // （此刻注册表其实仍缺那 4 条）。测试与实现必须引用同一阈值。
    await apiCommand(['list'])
    const meta = JSON.parse(out).meta
    expect(meta.registry_complete).toBe(true)
    // ⚠️ 断言用**推导式**写，而不是 `toBe(false)` 字面量 —— 这表达的是"该字段的
    // 契约是 `条数 >= 154`"，读者一眼看到阈值，数据补齐后这行会**自动**要求 true。
    //
    // ⚠️ 但要如实说明：**在当前数据下（11 条），这条断言无法区分"推导"与"写死 false"** ——
    // 两者都产出 `false`，是一个**等价变异体**，任何测试此刻都杀不掉它
    // （实测：把实现改回 `registry_complete: false` 字面量，本用例仍全绿）。
    // 所以这条的价值不在"现在能抓 bug"，而在**数据补齐的那一刻**：届时候选值变 true，
    // 而字面量实现仍是 false，两者分道扬镳 —— 写死的人会立刻看到红。
    // 这正是"由数据推导"相对"写死常量"的全部意义，本计划不假装它现在就可测。
    expect(meta.registry_complete, 'registry_complete 的契约是 (实际条数 >= 154)')
      .toBe(allEndpoints().length >= 154)
    // registry_note 带条数 —— 这条**能**杀掉"note 里删掉条数"的变异（实测已确认）。
    expect(meta.registry_note, 'registry_note 必须写出当前条数，便于补齐时定位')
      .toContain(String(allEndpoints().length))
  })

  it('每条记录带 verified，且 meta 解释了它的含义', async () => {
    // ⚠️ `verified` 若只输出不解释，就是一个"声明了但没人读"的字段：
    // Agent 会看到 true/false 却不知道差别，于是把"注册了"当成"验证过了"。
    // 当前 154 条注册表中，callable && !dangerous && verified 的接口共有 44 条。
    await apiCommand(['list'])
    expect(rows().length).toBeGreaterThan(0)
    // 默认视图是 callable && outbound，共 136 条，其中 44 条已实测。
    expect(rows().filter((r) => r.verified).map((r) => r.id).sort())
      .toEqual([
        'ai.knowledge.getCategoryTree', 'ai.knowledge.getDetail', 'ai.knowledge.search',
        'ai.statistic.transferHuman', 'category.list', 'data.overview.ipcc',
        'data.overview.session', 'evaluation.setting.get', 'export.session',
        'export.session.check', 'export.session.one', 'export.session.one.message',
        'icoutcall.history.seat', 'icoutcall.history.team', 'kefu.v2.query',
        'online.session.category.list', 'online.session.customfield.template',
        'robot.data.getQuestionsByCategoryName', 'robot.data.knowledge', 'robot.data.kpoint',
        'robot.data.queryStandardByEffectiveQuestion', 'robot.data.queryStandardQuestionList',
        'robot.evaluation.setting', 'robot.session.msgAssociate', 'robot.statistic.summary',
        'robot.transfer.config', 'session.user.profile', 'smstask.status',
        'staff.group.list.new', 'staff.group.members.new', 'staff.list.new',
        'statistic.overview', 'statistic.performance', 'statistic.salaryDetail',
        'statistic.satisfaction.report', 'statistic.staffAttendance', 'statistic.staffquality',
        'statistic.staffworklod', 'tag.all', 'ticket.filter.count', 'ticket.filter.list',
        'ticket.search', 'ticket.template.fields', 'ticket.template.list',
      ])
    expect(rows().filter((r) => !r.verified).length, '默认视图 136 条里有 44 条实测过')
      .toBe(92)
    const notes = JSON.parse(out).meta.field_notes
    expect(notes.verified).toMatch(/实测/)
    // ⚠️ 全局说明是**索引**不是全文（2026-10-07 加）：true 的实测范围三条各不相同
    // （ticket.search 是信封+窗口行为，robot.transfer.config 是信封+鉴权，
    // receive.message 是"不可调用"），false 里也有一条（wxTemplates）有实测片段。
    // 全局若把范围写死成一种，就与每行 note 冲突 —— 必须把 Agent 引到 note。
    expect(notes.verified, '全局说明必须把实测范围指向每行 note').toMatch(/note/)
    // ⚠️ `direction` / `callable` 也必须有解释 —— 与 verified 同一条标准。
    // Agent 判断「我方能调它」还是「它回调我方」的唯一依据就是 direction；
    // 只输出 `outbound`/`inbound` 两个英文词，它无从知道哪个能主动调用，
    // 可能对着 inbound 接口拼 URL（那类 path 是占位符 `/`，必然 404）。
    expect(notes.direction, 'direction 必须解释 outbound 与 inbound 的差别').toMatch(/主动调用|推送/)
    expect(notes.callable, 'callable=false 的含义必须解释').toMatch(/不可主动调用|只能查/)
    // ⚠️ `dangerous` 的说明**此前零断言**（2026-10-05 补）。七个 field_notes 里
    // 其余六个各有一条断言，唯独这条没有 —— 变异测试确认：把
    // `dangerous: 'true = 危险操作，调用时需 --yes'` 整行删掉，全量测试仍全绿。
    // 而它恰是**安全关键**的那一条：`dangerous` 是本计划 `--yes` 门禁的**唯一依据**，
    // Agent 若不知道 `true` 意味着什么，就无从判断哪些接口需要人工确认 ——
    // 而 `callOne` 只在**调用时**才拦，`api list` 是它**事前**唯一的知情渠道。
    // 与 verified 同一条标准：只输出不解释的字段等于没输出。
    expect(notes.dangerous, 'dangerous 必须解释 --yes 的关联').toMatch(/--yes|危险/)
    // 反向：说明必须说清 `true` 是"危险"，不能反过来 —— 断言它不把语义写反。
    expect(notes.dangerous, '不能把 true 说成"安全"').not.toMatch(/true = 安全/)
  })

  it('有 maxWindowDays 的接口输出 max_window_days，没有的**不输出该键**', async () => {
    // ⚠️ 这个字段是上界，Agent 必须按 `span <= max_window_days 天` 精确比较来切片。
    // 设计稿 §7.4.1：statistic/* 族向下取整（多给约 24 小时余量），
    // 而 robot.statistic.summary / transferHuman 是精确比较 —— 按严格形式切对两族都安全。
    // ⚠️ 这条是"契约诚实性"的守卫，不是格式偏好：
    // `14501` 的 hint 让 Agent 来 `api list` 查切片上限。若这里不输出，
    // 那句话就是指向不存在能力的承诺，Agent 只能按文档值（工单写 90 天）
    // 切片 —— 而服务端会静默钳到 31 天，每片少取约 58 天且无从察觉。
    await apiCommand(['list'])
    const search = rows().find((r) => r.id === 'ticket.search')!
    expect(search.max_window_days).toBe(31)
    // 反向：没有上限的接口不能凭空多出一个 undefined 键 ——
    // Agent 会把它当成"上限未知"而不是"没有上限"。
    const other = rows().find((r) => r.id === 'robot.transfer.config')!
    expect('max_window_days' in other).toBe(false)
    // ⚠️ 字段输出还不够 —— 它的语义（"精确比较"而非"向下取整"）必须解释，
    // 否则 Agent 会按向下取整切到 N 天零若干小时，在精确比较的接口上撞 14004。
    // 与 `verified` 同理：只输出不解释的字段等于没输出。
    expect(JSON.parse(out).meta.field_notes.max_window_days).toMatch(/精确|86400000/)
  })

  it('--pretty 已实现（G1）：输出缩进 JSON、退出码 0、stderr 为空', async () => {
    // ⚠️ 2026-10-24 前 `--pretty` 是「承诺过、未实现」，每个命令显式拒绝它；
    // G1 起它真的输出缩进 JSON。这条从「必须拒绝」翻转为「必须缩进」——
    // 断言的是**行为**（换行 + 缩进），不是"不再报错"（后者无法区分"实现了"与"静默吞掉"）。
    const code = await apiCommand(['list', '--pretty'])
    expect(code).toBe(0)
    expect(err, '--pretty 是合法用法，stderr 必须为空').toBe('')
    expect(out.startsWith('{\n  "ok": true,')).toBe(true)
    expect(out.split('\n').length).toBeGreaterThan(10)
    // 缩进版仍是合法 JSON、内容与紧凑版一致
    const pretty = JSON.parse(out)
    out = ''
    expect(await apiCommand(['list'])).toBe(0)
    expect(pretty).toEqual(JSON.parse(out))
    // ⚠️ 同一进程内下一条命令**不带** --pretty 时必须回到紧凑输出 ——
    // 这条守的是「入口 setPretty(false) 重置」：删掉重置，上一条的开关会泄漏到这里。
    expect(out.split('\n')[0]).not.toMatch(/^\{ *$/)
    expect(out).toMatch(/^\{"ok":true,/)
  })

  it('坏参数与 --pretty 同时出现时，三个子命令给同一个答案（2026-10-07 修；G1 起 --pretty 已实现，坏参数仍优先）', async () => {
    // ⚠️ 实测：`api call ticket.search --al --pretty` 此前报「--pretty 尚未实现」，
    // 而同样输入的 `api list --al --pretty` 报「未知参数：--al」——
    // **同一个坏参数在两个子命令上得到两种答案**。根因是 `callOne` 把 `--pretty`
    // 分支提到了未知参数检查**之前**，而 `list()` 的次序是「未知/位置参数 → help
    // → --pretty」。
    // `--al` 是真的拼错（该报未知参数）、`--pretty` 是真的存在（该报未实现）——
    // 两者同时出现先报哪个都对，但**必须选同一个**，否则又是一族"同族错误两种行为"。
    // 这里钉住"未知参数优先"，与 `list()` 一致。
    // ⚠️ 只断言退出码不够（两者都是 2），必须断言 stderr 的**分支锚**。
    // ⚠️ 循环体必须真的跑**三个**子命令（2026-10-08 修）：此前后者只有两个
    // （list、call），而用例名一直说「三个子命令」—— 第三个 `auth whoami` 从没进过
    // 这个循环，名实不符。本文件已 import `authCommand`，补第三行即可。
    const cases: Array<[(argv: string[]) => Promise<number>, string[]]> = [
      [apiCommand, ['list', '--al', '--pretty']],
      [apiCommand, ['call', 'ticket.search', '--al', '--pretty']],
      [authCommand, ['whoami', '--al', '--pretty']],
    ]
    for (const [cmd, argv] of cases) {
      out = ''; err = ''
      expect(await cmd(argv), argv.join(' ')).toBe(2)
      expect(err, `${argv.join(' ')}：坏参数必须优先于 --pretty`)
        .toContain('未知参数：--al')
      expect(err, `${argv.join(' ')}：不能因为带了 --pretty 就改报未实现`)
        .not.toContain('--pretty 尚未实现')
    }
    // 反向：只有 --pretty、没有坏参数时，命令必须**成功且真的缩进**（G1 语义）。
    // ⚠️ 不能用 `.not.toBe(2)`（2026-10-25 评审发现）：缺凭证会返回 1，那条断言
    // 照样通过 —— 它证明的是"不是用法错误"，不是"格式化生效了"。必须配齐凭证与
    // fetch 后断言退出码 0 + 输出首两行是缩进形态。
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ code: 200, message: '{"data":[]}' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))))
    out = ''; err = ''
    expect(await apiCommand(['call', 'ticket.search', '--pretty'])).toBe(0)
    expect(err, '成功路径 stderr 必须为空').toBe('')
    expect(out.startsWith('{\n  "ok": true,')).toBe(true)
  })

  it('面向 Agent 的文案不得引用计划文档的章节 —— Agent 手里只有这个 CLI', async () => {
    // ⚠️ 这条守的是一类**悬空引用**（2026-10-06 补）。`message`/`hint`/`field_notes`
    // 都是 Agent 运行时读到的文本，而「已知缺口」是**计划文档**的章节标题 ——
    // Agent 没有那份文档，照着找不到任何东西。这与「hint 指向不存在的命令」
    // 是同一类问题：读者被指向一个它够不到的地方。
    // 此前有三处：`auth login 尚未实现（见计划的「已知缺口」）`、
    // `--pretty 尚未实现（见计划的「已知缺口」）`、`request_schema` 里的
    // `它们不在本计划交付的注册表里（见「已知缺口」）`。三处都改成说清
    // **当前能做什么**，而不是指向一份 Agent 拿不到的文档。
    //
    // ⚠️ **按出口清单逐个扫**（2026-10-08 修，⑳ 的教训：按调用点清单点名，
    // 不按"我记得有哪几个"）。此前只扫 `api list` 的 meta 与 `api list --pretty`
    // 一条错误 message —— 而上面点名的三处修复里，`auth login` 的 message
    // 根本不在扫描范围（4 个出口只覆盖了 1 个）。现在把 meta/note 出口与
    // usageFail 的 message/hint 出口一起列全。
    // 不扫源码注释 —— 注释里引用计划章节是**正确的**，那是给读代码的人看的。
    const texts: Array<[string, string]> = []
    out = ''
    await apiCommand(['list'])
    const meta = JSON.parse(out).meta
    for (const [k, v] of Object.entries(meta.field_notes)) texts.push([`field_notes.${k}`, String(v)])
    texts.push(['registry_note', String(meta.registry_note)])
    for (const [label, cmd, argv] of [
      // G1 起 `--pretty` 不再是错误（实现为缩进输出），从本清单移除；
      // 替入仍然走 usageFail 的路径，出口清单的覆盖面不缩水。
      ['api 分派层 --pretty 指引', apiCommand, ['--pretty']],
      ['api 未知子命令', apiCommand, ['未知子命令']],
      ['api 缺子命令', apiCommand, []],
      ['auth 分派层 --pretty 指引', authCommand, ['--pretty']],
      ['auth 未知子命令', authCommand, ['未知子命令']],
      ['auth login', authCommand, ['login']],
    ] as const) {
      out = ''; err = ''
      await cmd([...argv])
      const e = JSON.parse(out).error
      texts.push([`${label} 的 message`, String(e.message ?? '')])
      if (e.hint) texts.push([`${label} 的 hint`, String(e.hint)])
    }
    for (const [label, text] of texts) {
      expect(text, `${label} 引用了计划文档的章节`).not.toMatch(/已知缺口|本计划|设计稿\s*§/)
    }
  })

  it('specs.json 的 note 里也不得出现内部用语 —— 它会原样输出给 Agent', async () => {
    // ⚠️ 上一条只扫了 `field_notes`/`registry_note`/错误 message，**漏了 `note`**
    // （2026-10-06 补）。而 `note` 同样逐字进 `api list` 与 `api call` 的输出 ——
    // 它是 Agent 读到的**逐接口事实**。此前两条 note 里写着「本计划唯二 ……」与
    // 「设计稿 §9.2 的头号静默失败」，Agent 读到的是：
    //   · 「本计划」—— 它手里没有"计划"，这四个字指向一个不存在的东西；
    //   · 「唯二」—— 那是**按 11 条骨架**算的，154 条时这个数就不再成立，
    //     而 note 是随注册表一起分发的，会一直错下去。
    // 事实本身要留（三条限制、空壳语义），但**表述要脱离计划文档**。
    // 断言用 `note` 的实际输出，不是读源码 —— 这样 `specs.json` 改了也会被抓住。
    out = ''
    await apiCommand(['list', '--all'])
    for (const r of rows()) {
      const note = String(r.note ?? '')
      expect(note, `${r.id} 的 note 用了「本计划」—— Agent 没有这份文档`)
        .not.toMatch(/本计划/)
      expect(note, `${r.id} 的 note 引用了设计稿章节`).not.toMatch(/设计稿\s*§/)
      expect(note, `${r.id} 的 note 引用了「已知缺口」`).not.toMatch(/已知缺口/)
    }
  })

  it('api --help 走 stdout 且退出码 0 —— 与顶层 --help 行为一致', async () => {
    // ⚠️ 若子命令层不处理 --help，`qiyu api --help` 会落到用法错误分支
    // （退出码 2）—— Agent 请求帮助却拿到一个错误。
    expect(await apiCommand(['--help'])).toBe(0)
    expect(out).toContain('用法：qiyu api')
    expect(err).toBe('')
    // ⚠️ `API_USAGE` 与顶层 `USAGE`、`AUTH_USAGE` 一样，必须告知"按 kind 分支、
    // code 只是标签"（2026-10-08 补）：此前那句说明只写进了顶层 `USAGE`，
    // 而「已知缺口」段却声称三处都写了 —— 现在三处都写上，并各有一条断言钉住。
    expect(out, 'API_USAGE 必须告知按 kind 分支').toMatch(/按 kind 分支/)
    // ⚠️ `--help` 不吞额外参数（2026-10-08 修）：此前 `api --help --bod` /
    // `api --help extra` 返回 0，把拼错的 flag / 多余的位置参数静默吞掉
    // （`api --bod` 单独跑是 2）。与叶子命令同一条次序：未知/位置参数 → help。
    out = ''; err = ''
    expect(await apiCommand(['--help', '--bod'])).toBe(2)
    expect(err).toContain('未知参数：--bod')
    expect(JSON.parse(out).error.message).toContain('--help 不接受额外参数')
    out = ''; err = ''
    expect(await apiCommand(['--help', 'extra'])).toBe(2)
    expect(err).toContain('未知参数：extra')
    // `--help --help` 仍给帮助（--help/-h 是这条伪命令仅有的合法 token）
    out = ''; err = ''
    expect(await apiCommand(['--help', '--help'])).toBe(0)
    expect(out).toContain('用法：qiyu api')
    expect(err).toBe('')
  })

  it('api 未知子命令：点名那个 token，且 stdout/stderr 都有说明', async () => {
    // ⚠️ 这条分支此前**零测试**（2026-10-05 补）：全部 api 用例只跑过
    // list / call / --help 三种形态，`apiCommand(['未知'])` 与 `apiCommand([])`
    // 从没被调用过 —— 该分支可以被改回"只写 stderr"而全量测试仍绿。
    // 而它此前**只吐整段用法、不点名 token**，与顶层 `run()` 的「未知子命令：x」
    // 行为不一致。下面两个方向都钉住。
    const code = await apiCommand(['未知子命令'])
    expect(code).toBe(2)
    expect(err, 'stderr 要给人读').toContain('未知子命令')
    const e = JSON.parse(out).error
    expect(e, 'stdout 要给 Agent 读').toMatchObject({ code: 'usage', kind: 'usage' })
    expect(e.message, '必须点名那个 token，而不是只吐一屏用法').toContain('未知子命令')
    // 无参数是另一件事，不能报成"未知子命令：undefined"（事实错误）
    out = ''; err = ''
    expect(await apiCommand([])).toBe(2)
    expect(JSON.parse(out).error.message, '缺子命令 ≠ 未知子命令').not.toContain('undefined')
    expect(err).toContain('用法')
    // ⚠️ 纯空白同样必须点名（2026-10-08 修）：`api " "` 此前报「未知子命令： 」
    // —— 名字不可见（describeArgs 的空白渲染，见 output.ts）。
    out = ''; err = ''
    expect(await apiCommand([' '])).toBe(2)
    expect(err, '空白子命令必须渲染成可见形式').toContain("未知子命令：' '")
  })

  it('未知参数报用法错误', async () => {
    const code = await apiCommand(['list', '--al'])
    expect(code).toBe(2)
    // ⚠️ stdout 必须是合法 JSON 且说清是哪个参数 —— Agent 不会去读 stderr。
    const e = JSON.parse(out).error
    expect(e).toMatchObject({ code: 'usage', kind: 'usage', retryable: false })
    expect(e.message).toContain('--al')
    expect(err).toContain('未知参数：--al')
  })

  it('api list 的位置参数报用法错误，而不是静默忽略', async () => {
    // ⚠️ 上面的「未知参数」只筛 `--` 开头的，位置参数此前被**无声丢弃** ——
    // 实测 `api list extra` 返回退出码 0 与全部 9 行（默认过滤后的行数）。
    // 与 `--al` 拼错被拦下是同一族问题：写错一个位置参数却被放过。
    const code = await apiCommand(['list', 'extra'])
    expect(code).toBe(2)
    // ⚠️ 同上：stdout 的 JSON 必须带原文，stderr 只是给人读的镜像。
    expect(JSON.parse(out).error.message).toContain('extra')
    expect(err).toContain('未知参数：extra')
  })

  it('空串位置参数也要报出"有一个空参数"，而不是一句没指名任何东西的错误', async () => {
    // ⚠️ 这条守的是「退出码 2 的全部价值是告诉 Agent 改哪里」。shell 里
    // `qiyu api list "$UNSET"`（变量未设置）会展开成一个空串参数；此前报出的是
    // `未知参数：。` —— 冒号后面**什么都没有**，Agent 无从知道该改哪个参数。
    // 修法见 output.ts 的 `describeArgs`：空串渲染成 `''`。
    // 变异测试确认：把 `describeArgs` 换回裸 `join('、')`，这条会失败。
    const code = await apiCommand(['list', ''])
    expect(code).toBe(2)
    expect(err, '必须点明"你传了一个空参数"').toContain("''")
    expect(err, '不能渲染成一句什么都没指名的错误').not.toMatch(/未知参数：。/)
    expect(JSON.parse(out).error.message, 'stdout 的 JSON 同样要点名').toContain("''")
  })

  it('纯空白的参数同样要点名 —— 空串的兄弟，渲染规则相同（2026-10-08 修）', async () => {
    // ⚠️ describeArgs 的函数头注释从写下那天就写着"空白参数"也要处理，实现只做了空串 ——
    // `api list " "` 报「未知参数： 。」、`api call " "` 报「未知接口： 。」，
    // 名字都不可见（与空串是同一个病）。修法：纯空白渲染成 `' '`。
    // 变异确认：describeArgs 判据退回 `=== ''` → list 那半失败；
    // byId 的手写副本（任务 6，无法 import describeArgs）退回裸插值 → call 那半失败。
    expect(await apiCommand(['list', ' '])).toBe(2)
    expect(err, 'list 的空白位置参数').toContain("未知参数：' '")
    expect(JSON.parse(out).error.message, 'stdout 的 JSON 同样要点名').toContain("未知参数：' '")
    out = ''; err = ''
    expect(await apiCommand(['call', ' '])).toBe(2)
    expect(err, 'call 的空白接口 id（走 byId 的手写渲染副本）').toContain("未知接口：' '")
  })

  it('终端控制字符在 stderr 出口被净化，不得注入 ANSI/OSC（架构审查 F3）', async () => {
    // 实测：`api call $'\x1b]0;pwned\x07'` 曾把原始 ESC/BEL 写进 stderr，
    // 而 `db tables` 同样的输入经 usageFail 会变成 `·`。mapThrownToExit 是第三个
    // 手写用法出口，同样必须在出口净化。
    const evil = '\u001b]0;pwned\u0007'
    expect(await apiCommand(['call', evil])).toBe(2)
    expect(err).not.toContain('\u001b')
    expect(err).not.toContain('\u0007')
    expect(err).toContain('·')
    expect(JSON.parse(out).error.message).not.toContain('\u001b')
  })

  it('`api list -h` 走 help（stdout + 退出码 0），不报"未知参数"', async () => {
    // ⚠️ 全局约束把 `--help`/`-h` 定为「stdout 只输出 JSON」的**唯一例外**：
    // 出人类可读用法、退出码 0。顶层 `apiCommand`、`callOne`、任务 10 的
    // `authCommand` 都有这个特判，`list()` 此前漏了 —— `api list -h` 落到
    // 未知参数分支返回 2。Agent 请求帮助却拿到错误，是坏交互，也违反全局约束。
    const code = await apiCommand(['list', '-h'])
    expect(code, '请求帮助必须成功，不能返回用法错误').toBe(0)
    expect(err, 'help 走 stdout，不该有 stderr').toBe('')
    expect(out, 'help 的用法说明必须真的输出到 stdout').toContain('用法')
  })

  it('单横线未知 flag（-x）报"未知参数"而不是"位置参数" —— 说明文字不能与事实相反', async () => {
    // ⚠️ 判据必须是"以 `-` 开头"，否则单横线的 `-x` 既不是"未知 flag"
    // 也不"合法"，掉进位置参数那条 —— 报出「未知参数：-x。api list 不接受位置参数」，
    // 这句话里有两个错误：`-x` 明明是 flag，不是位置参数。
    // Agent 读到一句自相矛盾的说明，比读到"未知参数"更糟 —— 它会去猜哪个才是真的。
    const code = await apiCommand(['list', '-x'])
    expect(code).toBe(2)
    expect(err).toContain('未知参数：-x')
    expect(err, '不能把 flag 说成位置参数').not.toContain('不接受位置参数')
  })

  it('`--help` 不吞别的错误：先验合法再判 help，拼错一个 flag 不能被它静默吞掉', async () => {
    // ⚠️ 三条互为犄角的用例（2026-10-05 补；2026-10-07 改名 —— 旧名「只在首位触发 help」
    // 与实现相反：实现是 `argv.includes()`，`--help` 排第几位都判，只是**排在**
    // 未知/位置参数检查之后。下面 ③ `['--all','--help']` 返回 0 也证明它不只在首位触发，
    // 旧名照字面读是一句错话）。此前用 `argv.includes('--help')` 全量
    // 匹配（无前置校验），于是 `api list --al --help` 返回**退出码 0**、`--al` 被无声丢弃 ——
    // 而 `api list --al` 单独跑是退出码 2。"多带一个 --help"把一条用法错误变成了
    // 静默成功，正是本文件反复在修的那一类。
    // ① 拼错的 flag + help → 仍必须报未知参数（help 不得吞掉别的东西）
    out = ''; err = ''
    expect(await apiCommand(['list', '--al', '--help'])).toBe(2)
    expect(err, '拼错的 flag 不能被 --help 静默吞掉').toContain('未知参数：--al')
    // ② --pretty 排在 help 之后（此前在前）→ help 必须先判，否则
    //    `api list --pretty --help` 返回 2，违反"help 本该永远成功"这条自己的结论
    out = ''; err = ''
    expect(await apiCommand(['list', '--pretty', '--help'])).toBe(0)
    expect(out).toContain('用法')
    expect(err, 'help 不该有 stderr').toBe('')
    // ③ help 在非首位时照样触发（实现是 includes()，不看位置）——
    //    且**不是未知参数**（它在 KNOWN 里）。若掉出 KNOWN 会报「未知参数：--help」，
    //    那是一句事实错误的说明：`--help` 确实是合法 flag
    out = ''; err = ''
    expect(await apiCommand(['list', '--all', '--help'])).toBe(0)
    expect(err, '--help 是合法 flag，不能被报成未知参数').not.toContain('未知参数：--help')
  })

  it('run(["api", "list"]) 会走到 apiCommand —— 挂载没漏', async () => {
    // 同任务 10：漏登记 COMMANDS 表会让 CLI 静默返回"未知子命令"，
    // 而 apiCommand 自己的测试全绿。
    // ⚠️ 动态 import 整个 cli 图（含 store/query 的命令注册），冷启动 transform 实测可超 5s
    //（本机 8.6s），默认 5s 超时会偶发假失败。
    const { run } = await import('../../src/cli.js')
    expect(await run(['api', 'list'])).toBe(0)
    expect(JSON.parse(out).data.length).toBeGreaterThan(0)
  }, 30_000)

  it('help 文本里不得出现 Markdown 标记 —— 它走 stdout，是纯文本不是渲染后的文档', async () => {
    // ⚠️ 这条守的是"帮助文本是给终端看的"这个前提（2026-10-06 补）。
    // `--help` 是全局约束里 stdout 出**纯文本**的唯一例外；但此前
    // `API_USAGE` 里写着 `是**两条不同的服务端路径**`、`AUTH_USAGE` 里写着
    // `成功**不代表凭证可用**` —— 那是对着文档写的，终端上会原样显示成
    // `是**两条不同的服务端路径**`，多出四个星号。人读着别扭，
    // 而 Agent 读到的是一段带噪声的文本，可能把它当成格式约定去解析。
    // 这与"输出字段必须可解释"是同一条标准：**输出给谁看，就按谁的格式写**。
    // JSON 字段值里的 Markdown 不受此限（那是给 Agent 读的结构化文本）。
    // ⚠️ 但**其他纯文本通道同样不受该豁免** —— 本条只守 stdout 的 help 文本；
    // stderr 与加载期崩溃栈各有独立哨兵（2026-10-06 补）：
    // 本文件下面的「用法错误的 stderr 也不得出现 Markdown 标记」与
    // registry.test.ts 的「loadSpecs 的抛错消息不得含 Markdown」。
    //
    // ⚠️ **三处帮助文本都要查**（2026-10-06 补，此前漏了顶层）：`cli.ts` 的 `USAGE`、
    // `api.ts` 的 `API_USAGE`、`auth.ts` 的 `AUTH_USAGE` 是**三个独立常量**，
    // 而原来只查了后两个。变异实测确认这个缺口是真的：给顶层的 `USAGE` 里那句
    // 「退出码：0 成功」加上 `**` 加粗，`cli.test.ts` 当时的 9 条**全绿**（该文件
    // 现已 12 条）—— 顶层的 `--help` 测试只断言退出码与 `contains('用法：')`，
    // 没有一条读文本格式。
    // 这不改变当前行为（顶层 USAGE 实测 0 个 `**`），但它是三处里唯一没有哨兵的 ——
    // 下一个人在顶层加一句"强调"时不会有任何反馈。
    for (const argv of [['--help'], ['list', '--help']]) {
      out = ''
      await apiCommand(argv)
      expect(out, `qiyu api ${argv.join(' ')} 的帮助文本里有 Markdown 标记`)
        .not.toMatch(/\*\*/)
    }
    // `auth` 的帮助文本同样要查 —— 它在任务 10，实现是另一个常量。
    out = ''
    await authCommand(['--help'])
    expect(out, 'qiyu auth --help 的帮助文本里有 Markdown 标记').not.toMatch(/\*\*/)
    // 顶层的帮助文本走 `run()`，与上面两处不同源（任务 1 的实现）。
    // ⚠️ 用 `await import()` 而不是顶部静态 import —— 与本文件上面那条
    // `run(["api", "list"])` 用例同一手法：`cli.ts` 的 shebang 只在被 esbuild
    // 单独转换时才可能出问题，运行期 import 让失败局限在用到它的那一条用例上。
    const { run } = await import('../../src/cli.js')
    out = ''
    await run(['--help'])
    expect(out, 'qiyu --help 的帮助文本里有 Markdown 标记').not.toMatch(/\*\*/)
  })

  it('用法错误的 stderr 也不得出现 Markdown 标记 —— stderr 是第二个纯文本通道', async () => {
    // ⚠️ 与上一条同源的缺口（2026-10-06 补）。上一条只守了 `--help` 的 stdout；
    // 而 `usageFail` 把 message **逐字**写进 stderr —— 那是"给人读的纯文本"，
    // JSON 豁免（"字段值是给 Agent 的结构化文本"）**不覆盖它**。实测缺口：
    // `api call ticket.search '{"a":1}'`（位置参数）的报错里写着
    // `**body 必须用 --body 传入…**`，用真实 CLI 抓 stderr（`2>文件`）拿到的
    // 就是四个字面星号。这与 ⑬/⑳ 是**同一条规则**，只是出口换到了 stderr ——
    // 按 ㉔㉕ 的教训，补哨兵要按**通道清单**清点，stderr 就是此前漏掉的那个通道。
    // （⑳ 的教训是另一条：同一条规则的三份实现要按**常量清单**点名。）
    //
    // ⚠️ 逐行按**写 stderr 的调用点清单**点名（⑳ 的教训），不按"我记得有哪几个"：
    // 全仓 **30 处** `usageFail(...)` **调用点**（api **16** + auth **9** + cli **5**；
    // 定义在 output.ts，不计）+ `callOne` catch 里 1 处手工 `process.stderr.write`
    // （byId / assertCallable 两个来源共用它）。
    // ⚠️ 数调用点要用**代码判据**（匹配点前无同行 `//`），不是 `grep -c`：
    // 本注释自己就多次写到 `usageFail(...)` 这个词，`grep -c` 会把注释一起数进去。
    // ⚠️ **2026-10-07 更正**：此前写「18 处（api 12 + auth 4 + cli 2）」—— **过期**。
    // `--pretty` 三子命令统一拒绝那次改动给 api 与 auth 各加了 1 个分支
    // （`api call --pretty`、`auth whoami --pretty`），调用点涨到 20，而这里没跟着改。
    // 更糟的是当时 CASES 表里**没有**这两个新分支 —— 「逐个覆盖」是假的：
    // 表只有 18 行，漏的恰是新增的两个。现在补上（见下方 `--pretty` 两行）。
    // ⚠️ **2026-10-08 两次更正**：先前写「调用点 23」→ 复审计数为 24 —— **都错了，
    // 实测 30**。三笔账各漏一次：
    //   · `07872d3` 给 `auth whoami` 补 KNOWN 后把「未知参数」**拆成两条分支**
    //     （未知 flag / 位置参数，见 auth.ts），20 → 21，当时无人记账；
    //   · 三处分派层 `--help` 守卫，21 → 24；
    //   · 三处分派层 `--pretty` 分支（每处裸拒绝 + 带额外参数两条 = 6 个），
    //     24 → 30 —— 这 6 个与 21→24 的 3 个是同一次提交（`975698d`）加的，
    //     当时只记了 help 守卫那半边，`--pretty` 那半边整批漏记。
    // **教训同 ㊴**：计数不是"大致对就行"—— 它在这里的作用是断言"表覆盖了**全部**
    // 调用点"，数错就意味着没人真去数过，而真去数就会发现下面的缺口 B 与缺口 C。
    // ⚠️ **缺口 B（2026-10-08 实测发现，已补）**：30 个调用点里有 **7 个从未进表** ——
    // `auth.ts` 的 `whoami` **未知 flag** 分支（`未知参数：X。auth whoami 不接受任何参数`）。
    // 表里那条 `['auth whoami 多余参数', ['whoami', 'extra']]` 走的是**位置参数**分支，
    // 两条分支的 message **逐字相同**，所以锚字符串看着对得上、实则从未走到 unknown 那条。
    // 变异证明：给该分支的 message 加 `**`，**286 条全绿**（哨兵只认表里的行）。
    // 已补一行 `['auth whoami 未知 flag', ['whoami', '--bod'], ...]` —— 锚改用
    // 那条分支独有的输入，两条分支从此各有各的行。
    // ⚠️ **缺口 C（2026-10-08 二次实测发现，已补）**：**分派层 `--pretty` 的 6 个
    // 调用点全部零覆盖** —— cli.ts / api.ts / auth.ts 各 2 个（裸拒绝、带额外参数）。
    // 变异证明（三处逐一删块、每删一次跑全量）：删掉任一整块，**286 条全绿**；
    // 全测试文件 grep `run(['--pretty']` / `apiCommand(['--pretty']` /
    // `authCommand(['--pretty']` 无任何命中 —— 首 token 就是 `--pretty` 的输入
    // 从没进过分派层。表已补 6 行（见下方「2026-10-08 补缺口 C」注释）。
    // ⚠️ 与「最后 2 行覆盖 catch 的两个来源」这句对齐：catch 的两个来源
    // （`未知接口`/`不可主动调用`）在表中是**第 10、11 行**，不在最后 ——
    // 末两行是 TOP_CASES（cli 的 usageFail）。此句已删，改为按实际位置点名。
    // ⚠️ 每个 CASE 带**期望命中的分支锚**（2026-10-07 补，⑨ 的教训）：只断言"非空 +
    // 无 `**`"的话，某行退化成落到「未知参数」等别的分支（同样 2、同样写 stderr、
    // 同样无 `**`）照样通过，而它声称守的那个错误文案已经没被走到。
    // 锚字符串取自真实输出（逐条实测过），与 registry 那条「夹具必须真的触发对应分支」
    // 是同一纪律。
    const CASES: Array<[string, string[], (a: string[]) => Promise<number>, RegExp]> = [
      ['api 无子命令', [], apiCommand, /用法：qiyu api </],
      ['api 未知子命令', ['未知子命令'], apiCommand, /未知子命令：未知子命令/],
      ['call 缺接口 id', ['call'], apiCommand, /用法：qiyu api call </],
      ['call 接口 id 以 - 开头', ['call', '--yes'], apiCommand, /必须是第一个参数/],
      ['call --body 重复', ['call', 'ticket.search', '--body', '{}', '--body', '{}'], apiCommand, /--body 只能出现一次/],
      ['call 未知参数', ['call', 'ticket.search', '--bod'], apiCommand, /未知参数：--bod。可用：--body/],
      ['call 位置参数（本条的实测来源）', ['call', 'ticket.search', '{"a":1}'], apiCommand, /接口 id 之后的参数必须写成 --body/],
      ['call --body 缺值', ['call', 'ticket.search', '--body'], apiCommand, /--body 后面缺少 JSON 值/],
      ['call --body 非法 JSON', ['call', 'ticket.search', '--body', '{坏'], apiCommand, /--body 不是合法 JSON：\{坏/],
      ['call 未知接口 id（catch 补写 stderr）', ['call', '不存在的接口'], apiCommand, /未知接口：不存在的接口/],
      ['call 不可调用的接口（catch 补写 stderr）', ['call', 'receive.message'], apiCommand, /不可主动调用/],
      ['list 未知参数', ['list', '--al'], apiCommand, /未知参数：--al。可用：--all/],
      ['list 位置参数', ['list', 'extra'], apiCommand, /不接受位置参数/],
      // G1 起 --pretty 合法（退出码 0），从 markdown 哨兵清单移除；替入仍在 stderr 说话的路径
      ['list 未知参数', ['list', '--al'], apiCommand, /未知参数/],
      // ⚠️ call / auth 的 --pretty 也是 usageFail 调用点，必须同列（2026-10-07 补）：
      // 此前只列了 `list --pretty`，另两处调用点没进表 —— 而它们正是那次"三子命令统一"
      // 新增的，谁把它们改回「未知参数」这条哨兵都不会红（同样 exit 2、同样写 stderr、
      // 同样无 `**`）—— 与上面「分支锚」要挡的是同一类漏网。
      // G1 起 --pretty 合法，call --pretty 从拒绝清单移除
      // G1 起 --pretty 合法，whoami --pretty 从拒绝清单移除
      ['auth login 未实现', ['login'], authCommand, /auth login 尚未实现/],
      ['auth 无子命令', [], authCommand, /用法：qiyu auth </],
      ['auth 未知子命令', ['未知子命令'], authCommand, /未知子命令：未知子命令/],
      ['auth whoami 多余参数', ['whoami', 'extra'], authCommand, /不接受任何参数/],
      // ⚠️ 2026-10-08 补**缺口 B**：`whoami` 的**未知 flag** 分支此前从未进表 ——
      // 上面那条 `['whoami','extra']` 走的是**位置参数**分支，两条的 message 逐字相同
      // （都是「未知参数：X。auth whoami 不接受任何参数」），锚字符串看着对得上、
      // 实则 unknown 那条从未被走到。变异证明：给它加 `**` 全量 286 条全绿。
      // 输入用 `--bod`（只有 unknown 分支会接住它；`extra` 走 positional）。
      ['auth whoami 未知 flag（与上一行是两条分支，消息相同）', ['whoami', '--bod'], authCommand, /未知参数：--bod。auth whoami/],
      // ⚠️ 2026-10-08 新增的六个分支（三处分派层 help 守卫 + 三处空白渲染）：
      ['api --help 不吞额外参数（2026-10-08 补）', ['--help', '--bod'], apiCommand, /--help 不接受额外参数/],
      ['auth --help 不吞额外参数（2026-10-08 补）', ['--help', '--bod'], authCommand, /--help 不接受额外参数/],
      ['api 空白子命令（describeArgs 空白渲染）', [' '], apiCommand, /未知子命令：' '/],
      ['auth 空白子命令（describeArgs 空白渲染）', [' '], authCommand, /未知子命令：' '/],
      ['list 空白位置参数（describeArgs 空白渲染）', ['list', ' '], apiCommand, /未知参数：' '。api list 不接受位置参数/],
      ['call 空白接口 id（byId 的手写渲染副本）', ['call', ' '], apiCommand, /未知接口：' '/],
      // ⚠️ 2026-10-08 补**缺口 C**：分派层 `--pretty` 的 6 个调用点此前全部零覆盖 ——
      // 删掉 cli / api / auth 任一整块，286 条全绿（逐块实测）；全测试文件没有一处
      // 以 `--pretty` 作首 token 调 run / apiCommand / authCommand。每个分派层
      // 两条分支（裸拒绝 / 带额外参数）各一行，锚逐字取自真实输出。
      // TOP_CASES 里 cli 那两行同因单列（run 与 api/auth 不同源）。
      ['api 分派层 --pretty 裸调用', ['--pretty'], apiCommand, /必须写在具体子命令之后/],
      ['api 分派层 --pretty 带额外参数', ['--pretty', '--bod'], apiCommand, /未知参数：--bod/],
      ['auth 分派层 --pretty 裸调用', ['--pretty'], authCommand, /必须写在具体子命令之后/],
      ['auth 分派层 --pretty 带额外参数', ['--pretty', '--bod'], authCommand, /未知参数：--bod/],
    ]
    for (const [label, argv, fn, anchor] of CASES) {
      out = ''; err = ''
      expect(await fn(argv), `${label}：这类错误必须走用法错误的退出码 2`).toBe(2)
      // ⚠️ 先断言 stderr 非空 —— 否则"没有 `**`"在空串上恒真，整行是空转。
      expect(err, `${label}：用法错误必须同时写 stderr（人看的那份）`).not.toBe('')
      // ⚠️ 再钉分支锚 —— 证明这行真的走到了它声称的那个错误分支，而不是别的 2 分支。
      expect(err, `${label}：stderr 必须来自该错误分支（锚：${anchor}）`).toMatch(anchor)
      expect(err, `${label}：stderr 是纯文本通道，Markdown 标记会被终端原样显示`)
        .not.toMatch(/\*\*/)
    }
    // 顶层 `run()` 的两个分支（任务 1 的实现，与上面两处不同源）。
    const { run } = await import('../../src/cli.js')
    const TOP_CASES: Array<[string[], RegExp]> = [
      [[], /用法：qiyu <子命令>/],
      [['未知子命令'], /未知子命令：未知子命令/],
      // ⚠️ 2026-10-08 新增的两条：分派层 help 守卫 + 空白渲染（cli.ts 的手写分支
      // 与 usageFail 分支不同源，必须单独进 TOP_CASES 而不是 CASES）。
      [['--help', '--bod'], /--help 不接受额外参数/],
      [[' '], /未知子命令：' '/],
      // ⚠️ 2026-10-08 补缺口 C：cli 分派层 `--pretty` 的两条分支（与上面同因单列）。
      // G1 起 --pretty 已实现：顶层裸调用给出「写在子命令之后」的指引（不再是未实现话术）
      [['--pretty'], /--pretty 是输出格式开关/],
      [['--pretty', '--bod'], /未知参数：--bod。--pretty 必须写在具体子命令之后/],
    ]
    for (const [argv, anchor] of TOP_CASES) {
      out = ''; err = ''
      expect(await run(argv), `run(${JSON.stringify(argv)})`).toBe(2)
      expect(err, `run(${JSON.stringify(argv)})：必须写 stderr`).not.toBe('')
      expect(err, `run(${JSON.stringify(argv)})：必须来自该错误分支`).toMatch(anchor)
      expect(err, `run(${JSON.stringify(argv)})：不得出现 Markdown 标记`).not.toMatch(/\*\*/)
    }
    // ⚠️ 未知子命令的**列表内容**断言在**这里**兑现（2026-10-07 补）。
    // 任务 1 的 cli.test.ts 明写「列表内容的断言在任务 11（`api` 挂载后）单独引入，
    // 见该任务的测试」—— 而任务 11 此前**没有**这条：承诺了一处、兑现方却不存在。
    // 挂载完成后再断言才有意义：任务 1 时 `COMMANDS` 是空表（正确输出是
    // 「可用子命令：（暂无）」），现在 auth 与 api 都挂了，正确输出含这两个名字。
    // 它钉的是 `Object.keys(COMMANDS).join('、') || '（暂无）'` 里
    // `||` 被手滑改成 `&&` 的变异：非空表时会输出「（暂无）」——错误信息把
    // 真实存在的命令说成没有，Agent 会据此以为功能不存在。
    out = ''; err = ''
    expect(await run(['不存在的命令'])).toBe(2)
    expect(err, '挂载后必须列出真实子命令，不是（暂无）').toMatch(/可用子命令：.*auth/)
    expect(err, '挂载后必须列出真实子命令，不是（暂无）').toMatch(/可用子命令：.*api/)
    expect(err, '非空表不得输出（暂无）').not.toContain('（暂无）')
  })
})

describe('api call —— B 块（body 校验）', () => {
  it('验收 3/4：addKnowledge 只缺 robotId → 2、零网络、消息点名 robotId、不含 confirm_required', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'ai.knowledge.addKnowledge', '--body',
      '{"name":"x","answer":"y","similars":[],"validitySwitch":1,"categoryId":1}'])
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(err).toMatch(/robotId/)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('usage')
    expect(e.confirm_required).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('验收 4：硬拒短路 —— 同时缺必填与含未知字段时，仍 2 且不输出 warnings', async () => {
    // spec §九 第 4 条：硬拒短路，不输出 warnings（soft 被清空）。
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'ai.knowledge.addKnowledge', '--body',
      '{"name":"x","answer":"y","similars":[],"validitySwitch":1,"categoryId":1,"bogus":1}'])
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(JSON.parse(out).meta?.warnings, '硬拒时 soft 必须被清空').toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('验收 11：message.send 缺必填 + 无 --yes → 2（不是 4，D5：校验先于门禁）', async () => {
    // spec §九 第 11 条前半句。⚠️ 必须用危险接口验：非危险接口返回 0，
    //    无法区分「门禁被跳过」与「门禁本就不管」。
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'message.send', '--body', '{"uid":1}'])
    expect(code, '缺必填必须报参数错误 2，而不是先撞门禁报 4').toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    const e = JSON.parse(out).error
    expect(e.kind).toBe('usage')
    expect(e.confirm_required).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('验收 5：search 带 bogus → 0，warning 含「已发出」「不要重发」', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    const code = await apiCommand(['call', 'ai.knowledge.search', '--body', '{"robotId":1,"bogus":1}'])
    expect(code).toBe(0)
    const w = JSON.parse(out).meta.warnings
    expect(w[0]).toMatchObject({ kind: 'unknown_field', field: 'bogus' })
    expect(w[0].message).toMatch(/已(随请求)?发出|已经发出/)
    expect(w[0].message).toMatch(/不要重发/)
    vi.unstubAllGlobals()
  })

  it('验收 9：非危险接口 non_json_body → 0，warning 含「已发出」「不要重发」且不含「未验证」', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    const code = await apiCommand(['call', 'icoutcall.phone.getLineList', '--body', '"x"'])
    expect(code).toBe(0)
    const w = JSON.parse(out).meta.warnings
    const nj = w.find((x: { kind: string }) => x.kind === 'non_json_body')
    expect(nj).toBeTruthy()
    expect(nj.message).toMatch(/已(随请求)?发出|已经发出/)
    expect(nj.message).toMatch(/不要重发/)
    expect(nj.message).not.toMatch(/未验证/)
    vi.unstubAllGlobals()
  })

  it('验收 28：type_mismatch message 含「已随请求发出」+ 渲染词（如 null）', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    const code = await apiCommand(['call', 'ai.knowledge.search', '--body', '{"robotId":"1"}'])
    expect(code).toBe(0)
    const tm = JSON.parse(out).meta.warnings.find((x: { kind: string }) => x.kind === 'type_mismatch')
    expect(tm).toBeTruthy()
    expect(tm.message).toMatch(/已(随请求)?发出|已经发出/)
    expect(tm.message).toMatch(/不要重发/)
    vi.unstubAllGlobals()
  })

  it('验收 31：危险接口（带 --yes）成功响应里 warning 照出', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    expect(await apiCommand(['call', 'message.send', '--yes', '--body', '{"uid":1,"msgType":"TEXT","content":"x","bogus":1}'])).toBe(0)
    const w = JSON.parse(out).meta.warnings
    expect(w.some((x: { kind: string; field?: string }) => x.kind === 'unknown_field' && x.field === 'bogus')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('验收 31：危险接口（--yes）成功响应里 non_json_body 照出', async () => {
    // spec §九 第 31 条：危险接口成功响应里 non_json_body/alias_normalized 也照出。
    // kefu.add 是 xml + dangerous:true，带 --yes 过门禁，body 出 non_json_body 软警告。
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    const code = await apiCommand(['call', 'kefu.add', '--yes', '--body', '"x"'])
    expect(code).toBe(0)
    const w = JSON.parse(out).meta.warnings
    expect(w.some((x: { kind: string }) => x.kind === 'non_json_body')).toBe(true)
    vi.unstubAllGlobals()
  })

  it('验收 15：--no-validate --strict 同传 → 2', async () => {
    expect(await apiCommand(['call', 'ai.knowledge.search', '--no-validate', '--strict', '--body', '{}'])).toBe(2)
  })

  it('验收 17（红线）：危险接口 + --no-validate + 合法/缺失 body + 无 --yes → 4，fetch 未被调用', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn(); vi.stubGlobal('fetch', fetchSpy)
    expect(await apiCommand(['call', 'message.send', '--no-validate', '--body', '{"uid":1}'])).toBe(4)
    expect(await apiCommand(['call', 'message.send', '--no-validate'])).toBe(4)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('验收 7：editKnowledgeNoSimilars 用 name → 0，mock body 用 question；加 question → 2', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchSpy)
    const body = '{"id":1,"robotId":2,"name":"q","answer":"a","validitySwitch":1,"categoryId":1,"ruleType":0,"channelAnswers":[]}'
    expect(await apiCommand(['call', 'ai.knowledge.editKnowledgeNoSimilars', '--yes', '--body', body])).toBe(0)
    const sent = JSON.parse((fetchSpy.mock.calls[0][1] as { body: string }).body)
    expect(sent).toHaveProperty('question'); expect(sent).not.toHaveProperty('name')
    expect(JSON.parse(out).meta.warnings.some((x: { kind: string; field?: string }) => x.kind === 'alias_normalized' && x.field === 'name')).toBe(true)
    out = ''
    expect(await apiCommand(['call', 'ai.knowledge.editKnowledgeNoSimilars', '--yes', '--body',
      '{"id":1,"robotId":2,"name":"q","question":"q2","answer":"a","validitySwitch":1,"categoryId":1,"ruleType":0,"channelAnswers":[]}'])).toBe(2)
    expect(err).toMatch(/只传其一/)
    vi.unstubAllGlobals()
  })

  it('验收 34：meta.warnings 两来源合成次序 [alias_normalized(name), unknown_field(bogus)]', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    expect(await apiCommand(['call', 'ai.knowledge.editKnowledgeNoSimilars', '--yes', '--body',
      '{"id":1,"robotId":2,"name":"q","answer":"a","validitySwitch":1,"categoryId":1,"ruleType":0,"channelAnswers":[],"bogus":1}'])).toBe(0)
    const w = JSON.parse(out).meta.warnings
    expect(w.map((x: { kind: string }) => x.kind)).toEqual(['alias_normalized', 'unknown_field'])
    vi.unstubAllGlobals()
  })

  it('验收 13/26：root 注入下 params 缺失 → api call 走 loadParams 抛 kind:internal → 1', async () => {
    try {
      vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
      const emptyRoot = mkdtempSync(join(tmpdir(), 'qiyu-empty-'))
      setParamsRoot(emptyRoot)
      expect(await apiCommand(['call', 'ai.knowledge.search', '--body', '{"robotId":1}'])).toBe(1)
      const e = JSON.parse(out).error
      expect(e.kind).toBe('internal')
      expect(e.code).toBe('internal')
      expect(await apiCommand(['call', 'ai.knowledge.search', '--no-validate', '--body', '{}'])).toBe(1)
    } finally {
      setParamsRoot(undefined)
    }
  })

  it('验收 19：--no-validate 下 search 传 --body {} → 请求照发，warnings 全静默、别名改写关闭', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn((_url: string | URL | Request, _init?: RequestInit) => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchSpy)
    expect(await apiCommand(['call', 'ai.knowledge.search', '--no-validate', '--body', '{}'])).toBe(0)
    expect(fetchSpy).toHaveBeenCalled()
    expect(JSON.parse(out).meta.warnings).toBeUndefined()
    out = ''
    expect(await apiCommand(['call', 'ai.knowledge.editKnowledgeNoSimilars', '--yes', '--no-validate', '--body',
      '{"id":1,"robotId":2,"name":"q","answer":"a","validitySwitch":1,"categoryId":1,"ruleType":0,"channelAnswers":[]}'])).toBe(0)
    const sent = JSON.parse((fetchSpy.mock.calls[1][1] as { body: string }).body)
    expect(sent).toHaveProperty('name'); expect(sent).not.toHaveProperty('question')
    expect(JSON.parse(out).meta.warnings).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('验收 6：merchant.account.login（危险）one-of：userName+code+--yes → 0；{} 全缺 → 2 且同时含组消息与 userName', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    expect(await apiCommand(['call', 'merchant.account.login', '--yes', '--body', '{"userName":1,"code":2}'])).toBe(0)
    out = ''
    expect(await apiCommand(['call', 'merchant.account.login', '--yes', '--body', '{}'])).toBe(2)
    expect(err).toMatch(/userName/)
    expect(err).toMatch(/code 与 shopCode 必填其一/)
    vi.unstubAllGlobals()
  })

  it('验收 10：无必填的接口不带 --body → 0、无 warning（json 有表无必填 + bodyKind none 两个方向）', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, message: '{}' }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    expect(await apiCommand(['call', 'ticket.search'])).toBe(0)
    expect(JSON.parse(out).meta.warnings).toBeUndefined()
    out = ''
    expect(await apiCommand(['call', 'icoutcall.phone.getLineList'])).toBe(0)
    expect(JSON.parse(out).meta.warnings).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('验收 16：robotId=null 普通模式 → 0 + type_mismatch；--strict → 2（存在 ≠ 通过）', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    expect(await apiCommand(['call', 'ai.knowledge.search', '--body', '{"robotId":null}'])).toBe(0)
    expect(JSON.parse(out).meta.warnings.some((w: { kind: string }) => w.kind === 'type_mismatch')).toBe(true)
    out = ''
    expect(await apiCommand(['call', 'ai.knowledge.search', '--strict', '--body', '{"robotId":null}'])).toBe(2)
    vi.unstubAllGlobals()
  })

  it('验收 18：非对象 body 对「有表」接口 → 2；对 0 body 表接口（getLineList）→ 不因形状报错', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    for (const b of ['[]', 'null', '"x"']) {
      out = ''; err = ''
      expect(await apiCommand(['call', 'ai.knowledge.search', '--body', b]), b).toBe(2)
      expect(err, b).toMatch(/需要 JSON 对象/)
    }
    out = ''
    expect(await apiCommand(['call', 'icoutcall.phone.getLineList', '--body', '[]'])).toBe(0)
    vi.unstubAllGlobals()
  })

  it('验收 20：--strict 下 non_json_body 与 alias_normalized 仍只提示', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    expect(await apiCommand(['call', 'icoutcall.phone.getLineList', '--strict', '--body', '"x"'])).toBe(0)
    expect(JSON.parse(out).meta.warnings.some((w: { kind: string }) => w.kind === 'non_json_body')).toBe(true)
    out = ''
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    expect(await apiCommand(['call', 'ai.knowledge.editKnowledgeNoSimilars', '--yes', '--strict', '--body',
      '{"id":1,"robotId":2,"name":"q","answer":"a","validitySwitch":1,"categoryId":1,"ruleType":0,"channelAnswers":[]}'])).toBe(0)
    const w = JSON.parse(out).meta.warnings
    expect(w.some((x: { kind: string }) => x.kind === 'alias_normalized')).toBe(true)
    expect(w.some((x: { kind: string }) => x.kind === 'unknown_field')).toBe(false)
    vi.unstubAllGlobals()
  })

  it('验收 29：--strict 硬拒消息点名 bogus 且不含「已发出」', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    const code = await apiCommand(['call', 'ai.knowledge.search', '--strict', '--body', '{"robotId":1,"bogus":1}'])
    expect(code).toBe(2)
    expect(err).toMatch(/bogus/)
    expect(err).not.toMatch(/已(随请求)?发出|已经发出/)
  })
})

describe('api call —— 危险操作门禁', () => {
  it('未加 --yes 调危险接口：退出码 4，且不发任何网络请求', async () => {
    // 逃生舱是唯一的写入口。门禁若在这里失效，等于所有写保护都不存在。
    // 凭证配好，确保"没发请求"确实是因为门禁，而不是因为缺凭证先抛错。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'message.send', '--body', '{"uid":1,"msgType":"TEXT","content":"x"}'])
    expect(code).toBe(4)
    expect(fetchSpy).not.toHaveBeenCalled()
    const e = JSON.parse(out).error
    expect(e.confirm_required).toBe(true)
    expect(e.confirm_arg).toBe('--yes')
    expect(e.retryable).toBe(false)
    // target 是端到端链路上最容易掉的一环：门禁抛出的 err 经 api.ts 的
    // `target: err.target ?? id` 再经 fail() 落到出参。任何一环漏了，
    // Agent 都不知道自己该确认的是哪个接口。
    expect(e.target).toBe('message.send')
    expect(e.risk).toBe('irreversible')
    // ⚠️ hint 必须**明确禁止自动加 --yes**。只给 `confirm_arg: "--yes"` 等于把
    // 绕过方式递到 Agent 手上；设计稿 §11.2 D 要求 Agent 停下来找人类确认，
    // 而 §11.5 说明 skill 不是安全边界 —— 这条约束只能靠输出传达。
    // 断言"提到人类"且"禁止自动确认"，而不是只断言 hint 存在（泛泛一句也能过）。
    expect(e.hint, '确认类错误必须给 hint').toBeTruthy()
    expect(e.hint, 'hint 必须点明需要人类确认').toMatch(/人类/)
    expect(e.hint, 'hint 必须明确禁止自动追加 --yes').toMatch(/不要自动|不要自行|不应自动/)
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('加了 --yes 的危险接口**放行**并真的发出请求 —— 门禁不能永远拦着', async () => {
    // ⚠️ 这是门禁的**正向**路径，此前**零覆盖**（2026-10-05 补）：全部危险接口用例
    // 只测了"没 --yes → 4"、"坏参数 → 2"、"flag 前置 → 2"三种**拦下**的情形，
    // 没有任何一条证明"给了 --yes 就能通过"。把 `assertConfirmed(spec, argv.includes('--yes'))`
    // 的第二参改成常量 `false`（或恒假表达式），**全量测试仍绿** —— 门禁变成
    // "危险接口永远调不通"。这不是安全洞（方向是 fail-safe），但正是本计划反复在修的
    // 「某个 if 改坏测试仍绿」；`registry.test.ts` 只钉住 `assertConfirmed` 函数本身，
    // 钉不住 `api.ts` 传给它的那个实参。
    vi.stubEnv('QIYU_APP_KEY', 'k'.repeat(32))
    vi.stubEnv('QIYU_APP_SECRET', 's'.repeat(32))
    // 让请求"成功"，从而证明它真的发到了 fetch 这一步
    const fetchSpy = vi.fn(() => Promise.resolve(
      new Response(JSON.stringify({ code: 200, data: { ok: 1 } }),
        { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'message.send', '--yes', '--body', '{"uid":1,"msgType":"TEXT","content":"x"}'])
    expect(fetchSpy, '--yes 必须让请求真的发出去，而不是被门禁继续拦着').toHaveBeenCalledTimes(1)
    expect(code, '放行后走正常成功路径').toBe(0)
    expect(JSON.parse(out).ok).toBe(true)
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('不可主动调用的接口被拦下，退出码 2（用法错误）', async () => {
    // 调用方点名了一个不该调的接口 —— 这是用法问题，不是业务失败。
    // 退出码 2 让 Agent 明白"换个接口"而不是"重试"。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'receive.message'])
    expect(code).toBe(2)
    expect(JSON.parse(out).error.message).toMatch(/不可主动调用/)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('未知接口 id 是用法错误，退出码 2，且 stdout/stderr 都有说明', async () => {
    // ⚠️ 只断言退出码不够：`api call` 缺 id、`--help` 误落、未知参数**都**返回 2，
    // 退出码区分不出是哪条分支拦下的。必须断言文本，才能证明
    // "id 不存在"（应去 `api list` 查）与"没给 id"（应看用法）是不同的分支。
    // ⚠️ **两个通道都要断言**（2026-10-05 修）：这条路径是 `byId()` 抛异常被 catch
    // 兜住的，此前只 `fail()` 写 stdout、**stderr 为空**；而「缺 id」那条用法错误
    // 反过来只写 stderr。同一族用法错误两种表现 —— 现在统一为两边都写。
    expect(await apiCommand(['call', '不存在的接口'])).toBe(2)
    expect(err, 'stderr 要给人读').toContain('未知接口')
    const e = JSON.parse(out).error
    expect(e, 'stdout 要给 Agent 读').toMatchObject({ code: 'usage', kind: 'usage' })
    expect(e.message).toContain('未知接口')
  })

  it('请求构造失败（fetch 抛无 cause TypeError）也是用法错误，且 stdout/stderr 双通道', async () => {
    // ⚠️ 2026-10-08 补（先证伪、再修，台账 61）：`isLocalRequestError` 产出的错误
    // 带 `kind:'usage'`，此前落进 catch 的 `if (err.kind)` 分支 —— 只出 stdout、
    // **stderr 空**，与上面「未知接口」那条同族两种表现，恰好是 catch 注释自己
    // 点名要避免的。注释只点了 `classify` / `networkError` 两个来源，漏了这第三个。
    // 判别式不能是退出码（三条路径都是 2），必须钉双通道 + 分支锚。
    // `isLocalRequestError` 判「instanceof TypeError 且无 cause」—— 用真实形状模拟
    // （与 http.test.ts 同一夹具）；生产路径要真出现 GET 接口才触发，故这里 mock。
    vi.stubEnv('QIYU_APP_KEY', 'k'.repeat(32))
    vi.stubEnv('QIYU_APP_SECRET', 's'.repeat(32))
    vi.stubGlobal('fetch', vi.fn(() =>
      Promise.reject(new TypeError('Request with GET/HEAD method cannot have body.'))))
    expect(await apiCommand(['call', 'ticket.search'])).toBe(2)
    expect(err, '请求构造失败必须写 stderr（人看的那份）').toContain('请求构造失败')
    const e = JSON.parse(out).error
    expect(e, 'stdout 给 Agent 的 JSON').toMatchObject({ code: 'usage', kind: 'usage', retryable: false })
    expect(e.hint, 'isLocalRequestError 的 hint 不能在双通道改造中丢掉').toContain('重试无用')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('api call 不带接口 id 时给用法提示，而不是静默当成"未知接口"', async () => {
    // ⚠️ 这条分支此前**没有测试** —— 变异测试确认：把它删掉后（`if (!id)` → 恒假），
    // 当时**全部** api 测试仍全绿。原因是它被**下一个分支遮蔽**：id 为 undefined 时会落到
    // `byId(undefined)` → 抛「未知接口：undefined」，同样返回退出码 2。
    // 两者退出码相同、语义却不同：一个是"你没给 id"（该看用法），
    // 一个是"你给的 id 不存在"（该去 `api list` 查）。必须断言文本才能区分。
    const code = await apiCommand(['call'])
    expect(code).toBe(2)
    expect(err).toContain('用法：qiyu api call')
  })

  it('api call --help 给帮助（stdout + 退出码 0），而不是报「未知接口：--help」', async () => {
    // ⚠️ 此前 `api call --help` 会落到 `byId('--help')` → 「未知接口：--help」。
    // 两个问题：① Agent 请求帮助却拿到一个错误（计划两处都写明了这是坏交互，
    // 顶层与 `api --help` 都已修，`call` 是第三个漏网的）；② 「未知接口：--help」
    // 是一句**事实错误**的说明 —— `--help` 是 flag，不是接口 id。与 `api list -h`
    // 曾被报成"位置参数"同族：说明文字与事实相反。
    // ⚠️ 必须断言 stdout 里有用法文本 —— 只断言退出码区分不出它与"未知接口"分支
    // （两者都返回 2，只是后者写 stderr）。
    const code = await apiCommand(['call', '--help'])
    expect(code).toBe(0)
    expect(out).toContain('用法：qiyu api')
    expect(err).toBe('')
    // `-h` 等价
    out = ''; err = ''
    expect(await apiCommand(['call', '-h'])).toBe(0)
    expect(out).toContain('用法：qiyu api')
    // ⚠️ **`<id> --help` 也给帮助**（2026-10-08 改）。此前它报「未知参数：--help」
    // （退出码 2）—— 而 `api list --all --help` 给帮助。同一个合法 flag
    // 两个子命令两种答案；且 `--help` 是**合法 flag**，报「未知参数」是事实错误。
    // ⚠️ 给的是**通用** `API_USAGE` —— 本 CLI 没有逐接口帮助（那需要注册表的
    // `params`，见「已知缺口」）；用法开头就是 `qiyu api <list|call>`，不会被误认。
    out = ''; err = ''
    expect(await apiCommand(['call', 'ticket.search', '--help'])).toBe(0)
    expect(out).toContain('用法：qiyu api')
    expect(err).toBe('')
    // ⚠️ 反向：`--help` **不能吞掉别的错误** —— 与 `list()` 同一条次序
    // （未知/位置参数先于 help）。此前 `api call --help --bod` 与
    // `api call --help extra` 都返回 0，拼错的 flag / 多余的位置参数被无声丢弃。
    out = ''; err = ''
    expect(await apiCommand(['call', '--help', '--bod'])).toBe(2)
    expect(err).toContain('未知参数：--bod')
    out = ''; err = ''
    expect(await apiCommand(['call', '--help', 'extra'])).toBe(2)
    expect(err).toContain('未知参数：extra')
  })

  it('api call 的 help / --pretty 次序与值位置与 list() 逐字一致', async () => {
    // ⚠️ 三条 2026-10-08 实测确认的不一致，合并成一条哨兵 —— 都是"同族错误两种行为"：
    // ① 位置参数 vs `--pretty` 的先后：`api call ticket.search extra --pretty` 此前报
    //    「--pretty 尚未实现」，而 `api list extra --pretty` 报「未知参数：extra」。
    // ② `--body` 的值位置：`--body --pretty` 里的 `--pretty` 是**值**，此前被当成 flag
    //    报「尚未实现」，而 `--body --yes` 报「不是合法 JSON」—— 同一个位置两种答案。
    // ③ help 先于 `--pretty`：`api call ticket.search --pretty --help` 必须给帮助。
    // 次序统一为 list() 的「未知/位置参数/值 → help → --pretty」。
    out = ''; err = ''
    expect(await apiCommand(['list', 'extra', '--pretty'])).toBe(2)
    expect(err).toContain('未知参数：extra')
    out = ''; err = ''
    expect(await apiCommand(['call', 'ticket.search', 'extra', '--pretty'])).toBe(2)
    expect(err, '位置参数必须先于 --pretty 报出').toContain('未知参数：extra')
    expect(err).not.toContain('--pretty 尚未实现')
    out = ''; err = ''
    expect(await apiCommand(['call', 'ticket.search', '--body', '--pretty'])).toBe(2)
    expect(err, '--body 的值位置必须按值处理 —— 该报 JSON 错，不是「尚未实现」')
      .toContain('不是合法 JSON：--pretty')
    expect(err).not.toContain('--pretty 尚未实现')
    out = ''; err = ''
    expect(await apiCommand(['call', 'ticket.search', '--body', '--help'])).toBe(2)
    expect(err, '--body 的值位置必须按值处理 —— 该报 JSON 错，不是给帮助')
      .toContain('不是合法 JSON：--help')
    expect(out).not.toContain('用法：qiyu api')
    // ⚠️ **body 解析先于 help / --pretty**（值位置之外的次序，2026-10-08 补断言）。
    // 都是退出码 2，但报错对象必须是**坏掉的那个值** —— `--pretty` 本身没有错，
    // 帮不了坏的 JSON。这与 list() 的「先证明命令行合法 → 再判 help → 再判 --pretty」
    // 是同一条：坏 JSON 属于"命令行不合法"，排在两者之前。
    out = ''; err = ''
    expect(await apiCommand(['call', 'ticket.search', '--body', '{坏', '--pretty'])).toBe(2)
    expect(err, '坏 JSON 必须先于 --pretty 报出').toContain('不是合法 JSON：{坏')
    expect(err).not.toContain('--pretty 尚未实现')
    out = ''; err = ''
    expect(await apiCommand(['call', 'ticket.search', '--body', '{坏', '--help'])).toBe(2)
    expect(err, '坏 JSON 必须先于 help 报出').toContain('不是合法 JSON：{坏')
    expect(out).not.toContain('用法：qiyu api')
    out = ''; err = ''
    expect(await apiCommand(['call', 'ticket.search', '--pretty', '--help'])).toBe(0)
    expect(out, 'help 先于 --pretty').toContain('用法：qiyu api')
    // 反向：只有 `--pretty`（无坏参数）时命令**成功且缩进** —— G1 起它是真实的输出开关。
    // ⚠️ 不用 `.not.toBe(2)`（2026-10-25 评审发现）：缺凭证返回 1 也能通过，
    // 证明不了格式化生效。配齐凭证与 fetch 后断言 0 + 缩进。
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ code: 200, message: '{"data":[]}' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))))
    out = ''; err = ''
    expect(await apiCommand(['call', 'ticket.search', '--pretty'])).toBe(0)
    expect(out.startsWith('{\n  "ok": true,')).toBe(true)
  })

  it('--body 不是合法 JSON 时按用法错误处理，不发请求', async () => {
    // ⚠️ 必须先把凭证配好。否则缺凭证会先抛错，请求本来就发不出去，
    // "没发请求"这条断言就是因错误的理由而成立的 —— 变异测试证明过：
    // 把非法 JSON 静默吞掉，测试照样全绿。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await apiCommand(['call', 'ticket.search', '--body', '{坏'])).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('--body 后面没有值时也按用法错误处理，而不是静默当成 {}', async () => {
    // 静默当 {} 会掩盖输入错误，并**踩中"空 body"那条完全不同的服务端代码路径**
    // （实测：不传 body 与传 {} 泄漏的是两种不同的 Java NPE 措辞）。
    // ⚠️ 凭证必须配好，否则请求本来就发不出去，"没发请求"的断言会因错误的理由通过。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    expect(await apiCommand(['call', 'ticket.search', '--body'])).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    // ⚠️ 必须断言 stderr 文本。只断言退出码的话，删掉 `raw === undefined` 这一支
    // 测试**照样绿** —— 实测：变异后 `--body` 会落到下面的 `JSON.parse(undefined)`
    // 抛错分支，同样返回 2，而报错变成"不是合法 JSON：undefined"。
    // 这与本文件里 `--pretty` 那条的教训完全相同（见其注释）。
    expect(err).toContain('--body 后面缺少 JSON 值')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('「成功但查无此物」在输出里显式标出 not_found', async () => {
    // 设计稿 §9.2：0 行是比报错危险得多的失败模式 —— Agent 的错误处理不触发，
    // 它会向人类汇报"这段时间没有数据"。必须在 meta 里给出信号。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(JSON.stringify({ code: 200, message: '{}' }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }))))
    const code = await apiCommand(['call', 'ticket.search'])
    expect(code).toBe(0)
    expect(JSON.parse(out).meta.not_found).toBe(true)
    vi.unstubAllGlobals()
  })

  it('正常有数据的成功响应**不得**出现 not_found —— 否则每个结果都被误报', async () => {
    // ⚠️ 反向断言，此前缺失。实测确认：把 `api.ts` 里
    // `...(r.notFound ? { not_found: true, warning: … } : {})` 的条件改成恒 `true`，
    // **全量测试仍全绿**（上面那条只断言了"空报文 → not_found 为 true"，
    // 没有任何一条断言"有数据时不该有 not_found"）。
    // 而 `not_found` 是设计稿 §9.2「0 行静默失败」防护的核心信号：它若被钉成恒真，
    // Agent 会把**每一个**正常结果都当成"查无此物" —— 正是该字段要消灭的失败模式的反面。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(
        JSON.stringify({ code: 200, message: JSON.stringify({ total: 3, tickets: [{ id: 1 }] }) }),
        { status: 200, headers: { 'content-type': 'application/json' } }))))
    const code = await apiCommand(['call', 'ticket.search'])
    expect(code).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.meta).not.toHaveProperty('not_found')
    expect(parsed.meta).not.toHaveProperty('warning')
    vi.unstubAllGlobals()
  })

  it('成功响应也带上该接口的 note —— 头号静默失败不能只写在注册表里', async () => {
    // ⚠️ 设计稿 §10.1 实测记录的静默失败（`code:200`、信封层拦不住的那一类）：
    // `ticket.search` 的 `opEnd` 缺省或为 0 时，服务端**静默忽略整个 op 参数对、
    // 返回全量**。不传 body 调这个接口就会拿到全量数据。
    // （⚠️ 2026-10-08 更正：此前记成 §9.2 —— §9.2 讲的是"0 行"型静默失败，
    // opEnd 这条实例在 §10.1。）
    // 那个接口的 note 里逐字写明了这个坑，但它此前**只出现在 `api list` 的输出里**，
    // `callOne` 从不读 `spec.note` —— 于是 Agent 调接口时完全看不到这条警告，
    // 会把全量数据当成"我这个窗口的精确结果"向人类汇报。
    // 这条钉住 note 必须随每次成功响应透出（它就在注册表里，只差没被读）。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(
        JSON.stringify({ code: 200, message: JSON.stringify({ total: 2885 }) }),
        { status: 200, headers: { 'content-type': 'application/json' } }))))
    const code = await apiCommand(['call', 'ticket.search'])
    expect(code).toBe(0)
    const meta = JSON.parse(out).meta
    expect(meta.endpoint).toBe('ticket.search')
    // note 必须出现，且包含那个具体坑 —— 只断言"有 note"太弱，
    // 任何一句泛泛的说明都能通过。
    expect(meta.note, 'note 缺失则头号静默失败对 Agent 隐形').toBeTruthy()
    expect(meta.note, 'note 必须点明 opEnd 缺省会返回全量').toMatch(/opEnd/)
    vi.unstubAllGlobals()
  })

  it('缺凭证时是 auth 错误（退出码 1），不是用法错误 —— 且与 auth whoami 一致', async () => {
    // ⚠️ 缺凭证是**环境配置**问题，不是参数写错。归为 usage（退出码 2）会让
    // Agent 去改命令行参数，而正确动作是去配 QIYU_APP_KEY。
    // 同一个错误在 `auth whoami` 里返回 1、在 `api call` 里返回 2 是不自洽的。
    vi.stubEnv('QIYU_APP_KEY', '')
    vi.stubEnv('QIYU_APP_SECRET', '')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'ticket.search'])
    expect(code).toBe(1)
    expect(fetchSpy).not.toHaveBeenCalled()
    const e = JSON.parse(out).error
    // ⚠️ kind 必须是 `auth_missing`，不是 `auth` —— 但 §9.5 **只点名了 auth_missing**
    // （三条 kind：store_not_initialized / auth_missing / store_locked），没有 `auth`。
    // `auth` 是本计划自建的 kind，语义是"发出去被服务端拒了"。这里用 auth_missing
    // 是因为缺凭证根本没发出请求，与"被拒"是两回事 —— 这个区分是计划的设计决定。
    expect(e.kind).toBe('auth_missing')
    expect(e.hint).toMatch(/QIYU_APP_KEY/)
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('--pretty 之后的用法错误仍是紧凑 JSON（契约：用法错误永远紧凑）', async () => {
    // ⚠️ 实测来源（CodeRabbit 2026-10-25）：`api schema --pretty` 缺 id 这类分支在
    // `setPretty(true)` **之后**才报错，输出的是缩进错误信封，而 README「输出格式」
    // 与设计稿 §11.2 写着「用法错误（退出码 2）仍是紧凑 JSON」。
    // 逐条断言命令级出口（不是只在 output.test.ts 测 usageFail）：命令的解析次序
    // 决定它走哪个分支，那正是当初出问题的地方。
    for (const [label, argv] of [
      ['api schema 缺 id', ['schema', '--pretty']],
      ['api call 缺 id', ['call', '--pretty']],
      ['api list 位置参数', ['list', 'extra', '--pretty']],
    ] as const) {
      out = ''; err = ''
      expect(await apiCommand([...argv]), label).toBe(2)
      expect(out, `${label}：缩进错误信封违反「用法错误紧凑」的承诺`).not.toContain('\n  ')
      expect(JSON.parse(out).error.kind).toBe('usage')
    }
  })

  it('未知参数报用法错误，而不是静默忽略', async () => {
    // 实测：`--bod '{"a":1}'`（拼错一个字母）被无声丢掉，请求照常发出、
    // body 为 undefined，服务端返回一个与拼写错误毫无关系的错误。
    // 主用户是 Agent —— 它会去查接口文档，而问题在自己的命令行上。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'ticket.search', '--bod', '{"a":1}'])
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    // ⚠️ 必须断言 stderr 文本。只断言退出码的话，删掉「未知参数」这一支测试**照样绿** ——
    // 实测：变异后 `--bod` 会落到位置参数检查，同样返回 2，报错却变成
    // "未知参数：{"a":1}…"（把值当成了位置参数）。两条分支返回同一个退出码，
    // 只有文本能区分是哪一条拦下的。同 `--pretty` 那条的教训。
    expect(err).toContain('未知参数：--bod')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('漏写 --body、把 JSON 直接当位置参数时，报用法错误而不是发出无 body 请求', async () => {
    // ⚠️ 这是「位置参数被静默丢弃」里后果最重的一种，因为**忘写 --body 是最自然的
    // 输入错误**。实测 `call ticket.search '{"opStart":…,"opEnd":…}'` 退出码 0、
    // 发出的 body 是 undefined；而 ticket.search 在 **opEnd 缺省时返回全量数据**
    // （见该接口的 note）—— Agent 拿到 2885 条，以为这就是它那个窗口的结果。
    // 一个从未离开命令行的参数，变成了一个语义完全不同的请求。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'ticket.search', '{"opStart":1,"opEnd":2}'])
    expect(code).toBe(2)
    expect(fetchSpy, '漏写 --body 时绝不能发请求').not.toHaveBeenCalled()
    // 报错必须**说清楚该写成什么**，而不是只说"未知参数" ——
    // Agent 看到"未知参数：{...}"未必能推出"我漏了 --body"。
    expect(err).toContain('--body')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('--body 的值恰好是 --yes 时，不把值误判成未知参数', async () => {
    // 边界：--body 后面跟的字符串以 -- 开头时，未知参数扫描必须跳过它，
    // 否则一个合法的（虽然内容不合法的）JSON 位置会被当成 flag。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    // 值不是合法 JSON → 应报"不是合法 JSON"，而不是"未知参数"
    const code = await apiCommand(['call', 'ticket.search', '--body', '--yes'])
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('--body 的值是**未知 flag** 时，仍跳过值位置 —— 用 --yes 测不出这一点', async () => {
    // ⚠️ 上一条用 `--yes` 当 body 值，而 `--yes` **本身就在 KNOWN 集合里** ——
    // 无论是否跳过值位置，它都不会被报成"未知参数"，于是那条测试**因错误的理由
    // 而通过**，钉不住 `idx !== i + 1` 这个跳过逻辑（变异测试确认：删掉
    // unknown/positional 两处过滤里的 `idx !== i + 1`，全量测试仍全绿）。
    // 必须用一个**不在 KNOWN 集合**的值（`--bod`）才能区分：跳过生效 → 报
    // "--body 不是合法 JSON：--bod"；跳过失效 → 报"未知参数：--bod"。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'ticket.search', '--body', '--bod'])
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    // 值位置被跳过 → 报的是"不是合法 JSON"，而不是"未知参数"
    expect(err).toContain('--body 不是合法 JSON：--bod')
    expect(err, 'body 的值不能被当成未知参数').not.toContain('未知参数：--bod')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('flag 写在接口 id 之前时报准确的用法错误，而不是「未知接口：--yes」', async () => {
    // ⚠️ `callOne` 此前先 `byId(argv[0])`，flag 前置时 argv[0] 就是那个 flag，
    // 于是报出「未知接口：--yes」—— `--yes` 是 flag，不是接口 id，一句**事实错误**
    // 的说明。本文件多处强调"说明文字不能与事实相反"，`--help`/`-h` 被特判救下了
    // （当时是"首个 token 特判"），其余 flag 全部漏网。必须断言文本：退出码都是 2，
    // 只有文本能区分它是"未知接口"分支还是"flag 前置"分支。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', '--yes', 'message.send'])
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(err).toContain('接口 id 必须是第一个参数')
    expect(err, '不能把 flag 说成接口 id').not.toContain('未知接口：--yes')
    // 其余 flag 同理 —— 不是只救 --yes 一个
    err = ''
    expect(await apiCommand(['call', '--bod', 'message.send'])).toBe(2)
    expect(err).not.toContain('未知接口：--bod')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('参数错误先于危险接口门禁 —— 危险接口 + 坏参数报 2（用法），不是 4（需确认）', async () => {
    // ⚠️ 此前 `assertConfirmed` 在 `--body` 的 JSON 校验之前执行，于是对危险接口
    // 传非法 JSON 一律得到退出码 4「需要 --yes」—— 参数错误被门禁掩盖。Agent 先被
    // 要求"加 --yes 重来"，加了才发现参数是错的。退出码语义的本意是让 Agent 分开
    // "改参数重来"（2）与"别重试了/去确认"（4）；顺序错了这条信息就丢了。
    // 必须同时断言 stderr 文本：两者退出码不同（2 vs 4），但还要确认走的是
    // JSON 校验分支而非门禁分支。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'message.send', '--body', '{坏'])
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(err).toContain('--body 不是合法 JSON')
    expect(err, '不能被门禁抢先').not.toContain('--yes')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('--body 出现两次时报用法错误，而不是静默用第一个、丢掉第二个', async () => {
    // ⚠️ `--body` 在 KNOWN 集合里，所以它**第二次**出现时既不是未知参数、
    // 也不会被当成"第一个 --body 的值"跳过 —— 结果是第二个被无声丢弃，
    // 请求带着第一个 body 照常发出（实测：`--body '{"a":1}' --body '{"b":2}'`
    // 发出的 body 是 `{"a":1}`，退出码 0）。这与本计划反复强调的
    // 「未知参数不能静默忽略」（`--bod` 拼错会报错）是同一族问题：
    // 拼错一个字母会被拦下，而重复写一个 flag 却被放过，Agent 无从察觉。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'ticket.search', '--body', '{"a":1}', '--body', '{"b":2}'])
    expect(code).toBe(2)
    expect(fetchSpy).not.toHaveBeenCalled()
    // ⚠️ 必须断言 stderr 文本。位置参数检查（后加的那条）也会返回 2 ——
    // 删掉本分支后 `{"b":2}` 会落到那里被当成位置参数，退出码一样、报错却不同。
    // 实测确认：只断言退出码时，删掉 `--body` 重复检查，全部测试照样绿。
    expect(err).toContain('--body 只能出现一次')
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('--yes 重复写**不**报错 —— 布尔开关是幂等的，为无歧义的输入造错误是倒退', async () => {
    // ⚠️ 这条钉住一处**刻意的不对称**：上面那条要求 `--body` 重复时报错，
    // 但 `--yes` 重复不报错。不要"为了统一"给 `--yes` 也加上检查 ——
    // 判据是**「重复是否会丢掉一个值」**，不是「是不是 flag」。
    //
    //   · `--body` 取值是 `indexOf`（第一个赢），重复时第二个值被**静默丢弃**
    //     → 请求内容与 Agent 的意图不符，属于要消灭的那类静默失败。
    //   · `--yes` 取值是 `argv.includes('--yes')` —— **幂等**。`--yes --yes` 与
    //     `--yes` 的行为逐字节相同，不存在被丢弃的值，也不存在两种读法。
    //     给它报退出码 2 是在「没有需要改的东西」时命令 Agent 去改参数。
    //
    // 断言的是**真实行为**（退出码 0 + 真的发出了请求），不是"注释说了什么"。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const fetchSpy = vi.fn().mockImplementation(() =>
      Promise.resolve(new Response(
        JSON.stringify({ code: 200, message: JSON.stringify({ total: 1 }) }),
        { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchSpy)
    const code = await apiCommand(['call', 'ticket.search', '--yes', '--yes'])
    expect(code, '幂等的布尔开关重复不该变成用法错误').toBe(0)
    expect(fetchSpy, '请求照常发出').toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })
})

// 追加到 tests/commands/api.test.ts
import { assertNoValidateStrictConflict } from '../../src/commands/api.js'

describe('assertNoValidateStrictConflict', () => {
  it('同传抛普通 Error（不挂 kind）', () => {
    let caught: unknown
    try { assertNoValidateStrictConflict(['--no-validate', '--strict']) } catch (e) { caught = e }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as { kind?: string }).kind).toBeUndefined()
    // spec §六：消息须可操作、点明两个 flag 冲突
    expect((caught as Error).message).toMatch(/--no-validate/)
    expect((caught as Error).message).toMatch(/--strict/)
  })
  it('单传 / 都不传不抛', () => {
    expect(() => assertNoValidateStrictConflict(['--no-validate'])).not.toThrow()
    expect(() => assertNoValidateStrictConflict(['--strict'])).not.toThrow()
    expect(() => assertNoValidateStrictConflict([])).not.toThrow()
  })
})

describe('api schema', () => {
  it('验收 1：search → 0，含 body_kind/has_body_schema/auto/response_shape，meta 无 validation，无 one_of，无 note', async () => {
    expect(await apiCommand(['schema', 'ai.knowledge.search'])).toBe(0)
    const o = JSON.parse(out)
    expect(o.data.body_kind).toBe('json')
    expect(o.data.has_body_schema).toBe(true)
    expect(o.data.params.find((p: { name: string }) => p.name === 'appKey').auto).toBe(true)
    expect(o.data.params.find((p: { name: string }) => p.name === 'robotId').required).toBe(true)
    expect(o.data.response_shape).toEqual({ kind: 'object' })
    expect(o.meta.field_notes.has_body_schema).toBeTruthy()
    expect(o.meta.field_notes.body_kind).toMatch(/json/)
    expect(o.meta.validation).toBeUndefined()
    expect(o.data.one_of).toBeUndefined()
    expect(o.meta.note).toBeUndefined()
  })
  it('验收 1 补：addKnowledge（有 note）→ meta.note 存在', async () => {
    await apiCommand(['schema', 'ai.knowledge.addKnowledge'])
    expect(JSON.parse(out).meta.note).toBeTruthy()
  })
  it('event.sessionData 的鉴权 query 参数不标 auto', async () => {
    expect(await apiCommand(['schema', 'event.sessionData'])).toBe(0)
    const params = JSON.parse(out).data.params
    for (const name of ['time', 'checksum']) {
      const param = params.find((p: { name: string }) => p.name === name)
      expect(param, `${name} 必须保留在 schema params 中`).toBeDefined()
      expect(param.auto).not.toBe(true)
    }
  })
  it('ai.knowledge.search 的 time 仍标 auto', async () => {
    expect(await apiCommand(['schema', 'ai.knowledge.search'])).toBe(0)
    const time = JSON.parse(out).data.params.find((p: { name: string }) => p.name === 'time')
    expect(time).toBeDefined()
    expect(time.auto).toBe(true)
  })
  it('验收 25：merchant.account.login → one_of 输出 + relaxRequired 生效 + field_notes.one_of 含「任一」', async () => {
    await apiCommand(['schema', 'merchant.account.login'])
    const o = JSON.parse(out)
    expect(o.data.one_of[0].anyOf).toEqual(['code', 'shopCode'])
    expect(o.data.params.find((p: { name: string }) => p.name === 'code').required).toBe(false)
    expect(o.meta.field_notes.one_of).toMatch(/任一/)
  })
  it('验收 2：未知 id → 2，stderr 点名 id 与未知接口', async () => {
    expect(await apiCommand(['schema', '不存在的id'])).toBe(2)
    expect(err).toContain('不存在的id')
    expect(err).toContain('未知接口')
  })
  it('验收 14：callable:false 照常输出 → 0', async () => {
    expect(await apiCommand(['schema', 'crm.modifyOrder'])).toBe(0)
    expect(JSON.parse(out).data.callable).toBe(false)
  })
  it('位置参数规则：schema --help extra → 2；schema a --help → 2；schema a b → 2；schema --help → 0', async () => {
    expect(await apiCommand(['schema', '--help', 'extra'])).toBe(2)
    expect(await apiCommand(['schema', 'ai.knowledge.search', '--help'])).toBe(2)
    expect(await apiCommand(['schema', 'a', 'b'])).toBe(2)
    expect(await apiCommand(['schema', '--help'])).toBe(0)
  })
  it('帮助次序：未知参数优先于 help，help 优先于 --pretty（只看退出码区分不开，必须断 stderr 文本）', async () => {
    // ① 未知参数优先于 help：`--bad` 是真拼错 → 必须报「未知参数：--bad」，而不是给帮助
    out = ''; err = ''
    expect(await apiCommand(['schema', '--bad', '--help'])).toBe(2)
    expect(err, '未知参数必须先于 help 报出').toContain('未知参数：--bad')
    // ⚠️ 次序颠倒（help 先执行）时 `--bad --help` 会返回 0 并把**用法文本**写进 stdout ——
    //    故必须断 stdout **不含用法文本**；`toBe('')` 是错的（usageFail 必然 fail() 写失败 JSON）。
    expect(out, '不得因 help 分支先执行而输出用法文本').not.toContain('用法：qiyu api schema')
    // ② help 优先于 --pretty：help 本该永远成功（spec：`schema --help` → 0）
    out = ''; err = ''
    expect(await apiCommand(['schema', '--pretty', '--help'])).toBe(0)
    expect(out, 'help 先于 --pretty').toContain('用法：qiyu api schema')
    // ③ 反向：只有 --pretty、无 help 时命令**成功且缩进**（G1 起它是真实的输出开关；
    // help 优先的次序不变 —— 上一步已钉）
    out = ''; err = ''
    expect(await apiCommand(['schema', 'ai.knowledge.search', '--pretty'])).toBe(0)
    expect(err).toBe('')
    expect(out.startsWith('{\n  "ok": true,'), '--pretty 必须输出缩进 JSON').toBe(true)
    // 不带 --pretty 的同一条命令回到紧凑输出（守入口重置不泄漏）
    out = ''
    expect(await apiCommand(['schema', 'ai.knowledge.search'])).toBe(0)
    expect(out.startsWith('{"ok":true,')).toBe(true)
  })
  it('验收 8：schema tag.all → has_body_schema:false、body_kind json', async () => {
    await apiCommand(['schema', 'tag.all'])
    const o = JSON.parse(out)
    expect(o.data.has_body_schema).toBe(false)
    expect(o.data.body_kind).toBe('json')
  })
  it('验收 27：schema kefu.add（xml、14 body 参数）→ has_body_schema:false、body_kind xml', async () => {
    await apiCommand(['schema', 'kefu.add'])
    const o = JSON.parse(out)
    expect(o.data.body_kind).toBe('xml')
    expect(o.data.has_body_schema).toBe(false)
  })
  it('验收 27（api call 半边）：tag.all --body 非对象 → 0、无 warning、不硬拒', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    for (const b of ['[]', 'null', '"x"']) {
      out = ''
      expect(await apiCommand(['call', 'tag.all', '--body', b])).toBe(0)
      expect(JSON.parse(out).meta?.warnings).toBeUndefined()
    }
    vi.unstubAllGlobals()
  })
  it('验收 26：schema 走 loadParams，params 缺失（root 注入）→ 1（internal），与 api call 同一条路径', async () => {
    try {
      const emptyRoot = mkdtempSync(join(tmpdir(), 'qiyu-schema-empty-'))
      setParamsRoot(emptyRoot)
      const code = await apiCommand(['schema', 'ai.knowledge.search'])
      expect(code).toBe(1)
      const e = JSON.parse(out).error
      expect(e.kind).toBe('internal')
      expect(e.retryable).toBe(false)
      expect(err, 'internal 只出 stdout，不补 stderr（与 callOne 同一出口）').toBe('')
    } finally {
      setParamsRoot(undefined)
    }
  })
})

describe('限流 → 本地 fallback 建议（G1）', () => {
  // ⚠️ 设计稿 §9.1 的限流错误示例声明了 `retry_strategy` / `fallback`，此前**零生产者**
  // （output.ts 的注释写着「本计划不填」）—— Agent 照文档去找，永远找不到。
  // 这里钉住三个方向：映射存在 → 两字段出现；危险接口 → 不给；无映射 → 不给。
  const rateLimited = () => vi.fn(() => Promise.resolve(new Response(
    JSON.stringify({ code: 200, message: '14009 api call too frequent' }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )))
  beforeEach(() => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
  })
  afterEach(() => { setLocalFallbackProvider(undefined) })

  it('读接口撞限流且有本地表 → retry_strategy + fallback（首表）+ hint 说明边界', async () => {
    vi.stubGlobal('fetch', rateLimited())
    setLocalFallbackProvider((id) => (id === 'ticket.search' ? { tables: ['tickets', 'ticket_logs'] } : undefined))
    expect(await apiCommand(['call', 'ticket.search'])).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('rate_limit')
    expect(e.retry_strategy).toBe('switch_to_local')
    expect(e.fallback).toBe('qiyu query --table tickets')
    // 多表接口必须在 hint 里点名其余表 —— 只说首表会让 Agent 以为本地只有那部分数据
    expect(e.hint).toContain('ticket_logs')
    // ⚠️ 诚实边界：「有表」不等于「有数据」/「覆盖你的时间窗」。这句不能省 ——
    // 省了 Agent 会直接采信一个空表或半个月前的快照。
    expect(e.hint).toMatch(/db tables|sync status/)
    expect(e.hint).toMatch(/不承诺|不等于|未必|先.*确认|没有.*确认/)
    // ⚠️ **更强的一条**（CodeRabbit 2026-10-25）：探测只确认「映射存在 + 路径是文件」，
    // **不确认表真的存在** —— 把 QIYU_DB_PATH 指向任意普通文件时本分支照样触发。
    // hint 必须说清这一点，否则 Agent 会以为 CLI 已经替它验证过表。
    expect(e.hint, '必须承认没打开库、没确认表存在').toMatch(/没有打开库|没.*确认.*表.*存在/)
    // 反向：不得出现「（表）确实存在」这类断言式措辞
    expect(e.hint, '不得断言表存在').not.toMatch(/本地有对应表/)
    // ⚠️ **fallback 是整表数据源、不是原请求的等价替代**（2026-10-25 评审发现）：
    // 生成的命令不带原请求 body 的筛选条件，直接用会拿到不符合条件的行。
    // hint 必须明说这一点 —— 只说「表可能没同步」是不够的（那是另一件事）。
    expect(e.hint, '必须点破「筛选条件不会被带过去」').toMatch(/筛选条件|整表|WHERE/)
    expect(e.hint, '必须告诉调用方自己补条件').toMatch(/自己补|重新|--sql|--since/)
  })

  it('无映射 → 两个键都不出现（不编一个查不到的命令）', async () => {
    vi.stubGlobal('fetch', rateLimited())
    setLocalFallbackProvider(() => undefined)
    expect(await apiCommand(['call', 'ticket.search'])).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('rate_limit')
    // output.test.ts 钉着「未提供就不出现键」—— 这里验证调用链真的没提供
    expect(e).not.toHaveProperty('retry_strategy')
    expect(e).not.toHaveProperty('fallback')
  })

  it('危险接口撞限流 → 不给本地建议（要的是写操作，不是读数）', async () => {
    // message.send 是危险接口；即使有人给它造了映射也不能出现建议。
    // 用 --no-validate 跳过 body 表校验（本用例只关心限流分支），--yes 过门禁。
    // ⚠️ 报文形状与读接口不同：message.send 的信封直接以 `code: 14009` 表达限流
    // （不像形状 C 把 "14009 …" 塞进 message 文本）。
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ code: 14009, message: 'api call too frequent' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ))))
    setLocalFallbackProvider(() => ({ tables: ['some_table'] }))
    expect(await apiCommand(['call', 'message.send', '--body', '{}', '--yes', '--no-validate'])).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('rate_limit')
    expect(e).not.toHaveProperty('retry_strategy')
    expect(e).not.toHaveProperty('fallback')
  })

  it('探测抛异常 → 原始限流错误原样返回，不变成内部错误', async () => {
    // ⚠️ 这是「fallback 探测绝不能改变原始错误」的行为级证明：
    // 若异常漏出 `localFallbackFor`，一条 14009 会变成 internal（退出码 1、kind 全变）。
    vi.stubGlobal('fetch', rateLimited())
    setLocalFallbackProvider(() => { throw new Error('boom') })
    expect(await apiCommand(['call', 'ticket.search'])).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('rate_limit')
    expect(e.code).toBe('14009')
  })
})

describe('RateLimit.scope 与 api schema 的三态输出（G1）', () => {
  it('有限频接口 → rate_limit 对象含 limit/window_seconds/source/scope', async () => {
    expect(await apiCommand(['schema', 'statistic.overview'])).toBe(0)
    const o = JSON.parse(out)
    expect(o.data.rate_limit).toEqual({
      limit: 1, window_seconds: 30, source: 'observed', scope: 'endpoint',
    })
    expect(o.meta.field_notes.rate_limit).toMatch(/三种|三态|不出现该键/)
  })

  it('实测无限频（显式 null）→ rate_limit 为 null，不是缺键', async () => {
    // ⚠️ 三态的第二态：`null` 表示"实测过，确实没有"。与缺键（没测过）压成一个
    // 会让 Agent 把"未测量"当"无限制"，从而去掉退避。
    expect(await apiCommand(['schema', 'event.queryQueueStatus'])).toBe(0)
    const o = JSON.parse(out)
    expect(o.data).toHaveProperty('rate_limit')
    expect(o.data.rate_limit).toBeNull()
  })

  it('未登记限频 → 不输出 rate_limit 键（没测过，说什么都是编的）', async () => {
    expect(await apiCommand(['schema', 'ticket.search'])).toBe(0)
    expect(JSON.parse(out).data).not.toHaveProperty('rate_limit')
  })
})

describe('category 接入（G1）', () => {
  it('api list 有分组的接口输出 category，文档外接口不输出该键', async () => {
    await apiCommand(['list', '--all'])
    const all = rows()
    const withCat = all.find((r) => r.id === 'ticket.search')!
    expect(withCat.category).toBe('工单系统')
    // export.session 一族是 4 个文档外接口 —— 没有文档页就没有分组
    const exportRow = all.find((r) => r.id === 'export.session')!
    expect(exportRow).not.toHaveProperty('category')
    // 前提校验：注册表里确实两种都存在，否则上面两条在描述一个不存在的分支
    expect(all.some((r) => typeof r.category === 'string')).toBe(true)
    expect(all.some((r) => !('category' in r))).toBe(true)
  })

  it('field_notes.category 说清来源与稳定度（Apifox 目录、不是契约）', async () => {
    await apiCommand(['list'])
    const note = JSON.parse(out).meta.field_notes.category
    expect(note).toMatch(/Apifox|文档/)
    expect(note, '必须劝阻把它当稳定枚举用').toMatch(/不是稳定契约|仅供|不要据此/)
  })
})

describe('assertGetHasNoBody（G1）', () => {
  it('GET + body 抛普通 Error（→ 退出码 2），GET 无 body 放行，POST 不受影响', () => {
    const get = { id: 'x', title: 't', method: 'GET', path: '/p', direction: 'outbound',
                  callable: true, dangerous: false, auth: 'checksum', verified: false,
                  envelope: null } as const
    const post = { ...get, method: 'POST' } as const
    expect(() => assertGetHasNoBody(get as never, { a: 1 })).toThrow(/GET.*不接受请求体/)
    expect(() => assertGetHasNoBody(get as never, undefined)).not.toThrow()
    // null / 0 / "" 是合法 JSON body —— 对 GET 同样必须拒（判据是 !== undefined）
    expect(() => assertGetHasNoBody(get as never, null)).toThrow(/GET/)
    expect(() => assertGetHasNoBody(post as never, { a: 1 })).not.toThrow()
    // 不挂 kind：这是用法错误，走 usage 双通道（与 assertNoValidateStrictConflict 同型）
    try { assertGetHasNoBody(get as never, {}) } catch (e) {
      expect((e as { kind?: string }).kind).toBeUndefined()
      // ⚠️ **不得承诺「参数走 query 串」**（2026-10-25 评审发现）：
      // 本 CLI 没有 GET 的 query 参数通道 —— URL 查询串只由 signedQuery 生成
      // （appKey/time/checksum）。写到不存在的通道上，调用方会去找一个没有的 flag。
      expect((e as Error).message, '不得指向不存在的 query 参数通道').not.toMatch(/走 query 串/)
      expect((e as Error).message, '必须如实说明当前没有该通道').toMatch(/没有.*query 参数通道|无法.*带.*参数/)
    }
  })
})
