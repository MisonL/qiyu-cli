// tests/core/envelope.test.ts
import { describe, it, expect } from 'vitest'
import { normalize } from '../../src/core/envelope.js'
// 有一条端到端用例要把两个模块接起来测：形状 C 提取出的错误码能否被正确分派。
// 分开测会漏掉"接口对不上"这类问题 —— 这正是上一轮遗漏的那类缺陷。
import { classify } from '../../src/core/errors.js'

describe('信封归一化', () => {
  it('形状 A：数据在 data，message 是普通文本', () => {
    const r = normalize({ code: 200, message: 'OK', data: [{ id: 1 }] })
    expect(r).toMatchObject({ ok: true, code: '200', messageText: 'OK' })
    expect(r.payload).toEqual([{ id: 1 }])
  })

  it('形状 B：数据在 result，而非 data', () => {
    const r = normalize({ code: 200, message: 'success', result: [{ id: 1 }], total: 0 })
    expect(r.payload).toEqual([{ id: 1 }])
    expect(r.notFound).toBe(false)
  })

  it('形状 B 的 result 为空时也判 notFound —— total 不可作数', () => {
    // tag.all 的 total 恒为 0（24 个标签也返回 total:0），所以判空只能看 result。
    const r = normalize({ code: 200, message: 'success', result: [], total: 0 }, 'B')
    expect(r.notFound).toBe(true)
  })

  it('未实测信封的接口带 result 时**不判** notFound —— 与 data 分支同一条规则', () => {
    // ⚠️ 这条与上面那条**只差第二个参数**，正是要钉住这个差别：同一个 `{code:200,
    // result:[]}`，注册表说得出形状（'B'）就判 notFound，说不出（undefined）就不判。
    //
    // 没有这条守卫时，`envelope == null` 会落到 `isEmptyPayload([]) === true`，
    // 于是"注册表没登记过的接口"被默默按读接口处理 —— 而 §5.4.1 已列 5 个写接口，
    // 它们的 `data` 语义与读接口相反（`deleteKnowledges` 的空数组是"全部成功"）。
    // 今天还没有写接口用 `result`，但这条规则不该依赖那个偶然。
    expect(normalize({ code: 200, message: 'success', result: [], total: 0 }).notFound)
      .toBe(false)
  })

  it('形状 C：数据是 message 里的 JSON 字符串，需要二次解析', () => {
    const r = normalize({ code: 200, message: '{"total":2,"data":[1,2]}' })
    expect(r.payload).toEqual({ total: 2, data: [1, 2] })
  })

  it('形状 C 变体：message 解析后是数组', () => {
    expect(normalize({ code: 200, message: '[1,2,3]' }).payload).toEqual([1, 2, 3])
  })

  it('形状 C 变体：message 解析后是数字（ticket.filter/count）', () => {
    expect(normalize({ code: 200, message: '101596' }).payload).toBe(101596)
  })

  it('形状 D：只有 code，无 message 也无 data', () => {
    const r = normalize({ code: 200 })
    expect(r).toMatchObject({ ok: true, code: '200', messageText: '' })
    expect(r.payload).toBeUndefined()
  })

  it('裸数组（无信封）原样作为 payload', () => {
    expect(normalize([1, 2]).payload).toEqual([1, 2])
  })

  it('裸数组**不判** notFound —— 否则 ipcc.customfield.template.get 的正常返回被误报', () => {
    // ⚠️ 上一条只断言了 payload，没断言 notFound —— 变异测试确认：把裸数组分支的
    // `notFound: false` 改成 `true`，全量测试仍全绿。
    // `ipcc.customfield.template.get` 返回的**就是**一个裸 JSON 数组（设计稿 §9.0：
    // 完全没有 {code,message} 信封）。若判 notFound，`api.ts` 会输出
    // `not_found:true` + "接口返回成功但无数据"，把一次正常返回描述成"查无此物"。
    expect(normalize([1, 2]).notFound, '裸数组不是"查无此物"').toBe(false)
    // 空数组也是正常返回（"这个模板没有任何字段"），不是 not_found ——
    // 该接口没有 code，无从表达"错误"，空数组只能是合法结果。
    expect(normalize([]).notFound, '空裸数组同样不是 not_found').toBe(false)
    expect(normalize([]).ok).toBe(true)
  })

  it('Spring 404 形态识别为失败，且不被误标为业务 notFound', () => {
    // ⚠️ 此前测试名写「并保留 path」，但 `Normalized`（见步骤 3 的接口定义）
    // 只有 ok / code / payload / messageText / notFound 五个字段，**没有 path**，
    // 实现对 `path` 零引用。名字承诺了一个函数不具备的能力 —— 这正是本仓库
    // 要消灭的「承诺了但不存在的能力」。夹具里保留 path 字段（它是真实报文的
    // 一部分），但**不断言**它被保留。
    const r = normalize({ timestamp: 't', status: 404, error: 'Not Found',
                          message: 'No message available', path: '/openapi/x' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('404')
    // ⚠️ notFound 也要钉住 —— 现存断言只覆盖 ok 与 code，变异测试确认：
    // 把这个分支的 `notFound: false` 改成 `true`，全量测试仍全绿。
    // Spring 404 是"路由不存在"，与业务层的"查无此物"（notFound）是两回事：
    // 前者该让 Agent 去查注册表路径，后者是正常的空结果。混为一谈会误导排查方向。
    expect(r.notFound, 'Spring 404 是路由错误，不是业务 not_found').toBe(false)
  })

  it('Spring 404 的三个子条件各自都不能省 —— 单带 status 或单带 timestamp 都不算', () => {
    // ⚠️ 判别式是 `'status' in o && 'timestamp' in o && !('code' in o)`。
    // 现存夹具**同时**带 status 与 timestamp，两个条件"恰好一起满足"，
    // 于是单独删任一个都无测试察觉（变异测试确认：删 `'status' in o`、
    // 删 `'timestamp' in o` 均全绿）。分别构造只满足一半的报文，各钉一次 ——
    // 且断言**具体 code**，因为变异后两条路径都会给出可区分的值：
    //   · 删 `'status' in o` → `{timestamp}` 被当成 Spring 404，code 取 `String(o.status)`
    //     即 `'undefined'`；
    //   · 删 `'timestamp' in o` → `{status:500}` 被当成 Spring 404，code 变 `'500'`。
    // 若只断言 `not.toBe('404')`，两种变异都存活（它们给出的本就不是 '404'）。
    const onlyTs = normalize({ timestamp: 't', message: 'boom' })
    expect(onlyTs.code, '缺 status 时不得走 Spring 404 分支').toBe('unknown')
    const onlyStatus = normalize({ status: 500, message: 'boom' })
    expect(onlyStatus.code, '缺 timestamp 时不得走 Spring 404 分支').toBe('unknown')
  })

  it('带 code 的响应永远不会被当成 Spring 404 —— `!(\'code\' in o)` 是判别式', () => {
    // ⚠️ 上面那条只测了正向。把守卫里的 `&&` 改成 `||`、或去掉 `!('code' in o)`，
    // 都存活（操作符变异扫描确认）。而 Spring 的错误体是 `{timestamp,status,error,message,path}`
    // —— **没有 code**；七鱼的业务响应**必有 code**。所以「有 code 就不是 Spring 404」
    // 是这条守卫的判别式，必须钉住。
    // 触发条件是一个同时带 status 与 timestamp 的业务响应（有些接口会回服务器时间戳）。
    // 少了 `!('code' in o)`，它会被判成 ok:false/code:'404'，Agent 会以为路由不存在、
    // 跑去报告注册表路径写错了 —— 而真相是它拿到了一个正常的业务响应。
    const r = normalize({ code: 200, status: 200, timestamp: 't', message: 'OK', data: [1] })
    expect(r.ok, '带 code 的响应不该被当成 404').toBe(true)
    expect(r.code).toBe('200')
    expect(r.payload).toEqual([1])
  })

  // —— 关键：code:200 不代表成功，形状 C 的报错也走 200 ——
  it('形状 C 上 code:200 + 纯文本 message 是错误，不是"成功但无数据"', () => {
    // 设计稿 §9.0 实测：报表族（形状 C）的每一个错误都返回 code:200，
    // 配一段纯文本 message。若判成成功，Agent 会把限流当成"上周没有数据"，
    // 这正是 §9.2 点名的头号静默失败模式。
    for (const [msg, wantCode] of [
      ['14501 (endTime - startTime)/millsADay > 31 is invalid', '14501'],
      ['14004 Not found param', '14004'],
      ['14009 api call too frequent', '14009'],
    ] as const) {
      const r = normalize({ code: 200, message: msg }, 'C')
      expect(r.ok, `应判为失败：${msg}`).toBe(false)
      expect(r.messageText).toBe(msg)
      // ⚠️ 必须断言 code 被提取出来。顶层是 200，真实错误码在 message 开头；
      // 若原样返回 '200'，下游 classify 会一律落到 unknown，
      // 14501 的双义分派与 14004 的分发表就全废了。
      expect(r.code, `应从 message 提取错误码：${msg}`).toBe(wantCode)
    }
  })

  it('形状 C 上 code:200 但 message 缺失/为空/非字符串时判为失败，并给出可诊断的 message', () => {
    // ⚠️ 这条分支此前**没有任何测试** —— 变异测试确认：把 `if (!messageText)` 整行
    // 改成 `if (false)`，全量测试全绿。它守的是形状 C 的第三态：
    // message 既不是"可解析的 JSON"（成功），也不是"解析不了的纯文本"（错误，
    // 真实码在开头）—— 而是**根本没有 message**。
    //
    // 为什么必须判失败：形状 C 的载荷**只能**从 message 里来。没有 message 就没有载荷，
    // 而顶层 code 恒为 200 —— 若放过去，Agent 会拿到一个"成功且无数据"的结果。
    // 这正是本计划反复点名的头号静默失败，只是入口换成了第三种。
    // `message: 123` 也要覆盖：`typeof o.message === 'string'` 把它压成空串，
    // 与"缺 message"走同一条路径，不能因为类型不同就漏掉。
    for (const raw of [{ code: 200 }, { code: 200, message: '' }, { code: 200, message: 123 }]) {
      const r = normalize(raw, 'C')
      expect(r.ok, `${JSON.stringify(raw)} 应判为失败`).toBe(false)
      expect(r.payload).toBeUndefined()
      // ⚠️ 这一条才是这个分支**唯一可观测的效果**。删掉分支后 ok/payload/code
      // 都不变（空 message 会一路走到"提取不到错误码 → 保留 200"），只有 messageText
      // 从合成的诊断变成空串。若不断言它，这条测试就抓不到那个变异 ——
      // 实测：只断言 ok/payload 时，变异**存活**。
      // 空 message 会让下游 classify 得到 `kind:'unknown'` + 空 message，
      // Agent 收到一个什么都不说的错误；合成一句说明，才让它知道是响应形状不对。
      expect(r.messageText, '缺 message 时必须合成一句可诊断的说明，而不是留空')
        .toMatch(/message/)
    }
  })

  it('形状 C 上整数键未加引号的畸形 JSON 要能修复，不能判成错误', () => {

    // 设计稿 §10.2 实测：`session.user.profile` 的 message 有 28/59（47%）
    // 解析失败，且 28/28 都是"整数键没有引号"这一个原因。它是**形状 C**，
    // 若不修复就会走"解析失败 → 判错"的分支 —— 近一半的正常响应变成
    // `ok:false` 且 code 停在 '200'（下游 classify 落 unknown）。
    const msg = '{"id":1,"name":"x","customField":{5000004:"a",5000001:"b"}}'
    const r = normalize({ code: 200, message: msg }, 'C')
    expect(r.ok, '畸形但可修复的 JSON 必须判为成功').toBe(true)
    expect(r.payload).toEqual({ id: 1, name: 'x', customField: { 5000004: 'a', 5000001: 'b' } })
  })

  it('修复只在严格解析失败后触发 —— 合法 JSON 不受正则影响', () => {
    // 正则 `(\{|,)(\d+):` 不区分结构位置与字符串值。若它在严格解析之前跑，
    // 一个值里恰好含 `,1:` 的**合法** JSON 会被改坏。断言它只在失败后跑。
    const r = normalize({ code: 200, message: '{"a":"x,1:y","b":2}' }, 'C')
    expect(r.ok).toBe(true)
    expect(r.payload).toEqual({ a: 'x,1:y', b: 2 })
  })

  it('未登记 envelope 的接口走宽松模式时，也要修复整数键未加引号的畸形 JSON', () => {
    // ⚠️ 这条此前**零覆盖** —— 变异测试确认：把宽松分支（尾部 `if (messageText)`
    // 里的）修复那半行回退成"只严格解析、不修复"，全量测试仍全绿。形状 C 的修复
    // 有测试，但**同一个畸形也出现在未登记 envelope 的端点上**，走的是宽松分支。
    //
    // 后果同设计稿 §10.2：`session.user.profile` 有 28/59（47%）的 message 是这种畸形。
    // 宽松分支若不修复，`ok` 仍为 true 但 `payload` 静默变成 undefined ——
    // Agent 拿到"成功但无载荷"，正是 §9.2 的头号静默失败。
    // （该接口实际登记为 'C'，但"未登记"是生成脚本补齐 154 条时的常态，必须守住。）
    const msg = '{"id":1,"customField":{5000004:"a"}}'
    const r = normalize({ code: 200, message: msg })
    expect(r.ok, '宽松模式也要修复畸形 JSON').toBe(true)
    expect(r.payload, '不能修复失败就静默丢载荷').toEqual({ id: 1, customField: { 5000004: 'a' } })
  })

  it('形状 C 的修复分支解析出载荷时按载荷判 notFound', () => {
    // ⚠️ 修复分支的 `notFound: isEmptyPayload(repaired.value)` 与"恒 false"**语义等价**，
    // 无法被变异测试区分 —— 这不是覆盖缺口，而是这条守卫在本实现里**不可能取到空**：
    // 修复只给整数键加引号，而"空载荷"（`{}`/`[]`/`null`）的原文都是**合法 JSON**，
    // 严格解析就会成功、根本走不到修复分支。留着它是防御性的（正则将来若放宽，
    // 或修复逻辑改变），但**不要假装它被钉住了**。
    // 这里能钉住的只是：修复分支解析出非空载荷时 notFound 为 false。
    expect(normalize({ code: 200, message: '{5000004:"a"}' }, 'C').notFound).toBe(false)
    // `{}` 走的是**正常解析**分支（不是修复分支），但同样该判 notFound —— 一并钉住。
    expect(normalize({ code: 200, message: '{}' }, 'C').notFound).toBe(true)
  })

  it('形状 C 的错误码提取后，能被 classify 正确分派', () => {
    // 端到端把两个模块接起来测一次 —— 分开测会漏掉"接口对不上"这类问题
    const r1 = normalize({ code: 200, message: '14501 endTime is invalid' }, 'C')
    expect(classify(r1.code, r1.messageText).kind).toBe('window_misaligned')
    const r2 = normalize({ code: 200, message: '14501 (endTime - startTime)/millsADay > 31 is invalid' }, 'C')
    expect(classify(r2.code, r2.messageText).kind).toBe('window_too_large')
    const r3 = normalize({ code: 200, message: '14004 Not found param' }, 'C')
    expect(classify(r3.code, r3.messageText).kind).toBe('param')
  })

  it('形状 A 上 code:200 + 纯文本 message 是正常成功（staff.list 的 message 就是 "OK"）', () => {
    const r = normalize({ code: 200, message: 'OK', data: [{ id: 1 }] }, 'A')
    expect(r.ok).toBe(true)
  })

  it('形状 A 上 code:200 但连 data 键都没有 —— ok 仍为 true，但标记 notFound', () => {
    // ok 表示"服务端没报错"，notFound 表示"没查到东西"。两者正交：
    // 缺 data 键是 §9.0 三种"成功但为空"编码中的第一种，信封层直接判掉，
    // 不留给调用方 —— 调用方拿不到原始响应体，判不了。
    const r = normalize({ code: 200, message: 'OK' }, 'A')
    expect(r.ok).toBe(true)
    expect(r.payload).toBeUndefined()
    expect(r.notFound).toBe(true)
  })

  it('不传 envelope 时退化为宽松模式，不抛错', () => {
    expect(normalize({ code: 200, message: 'OK', data: 1 }).ok).toBe(true)
  })

  it('响应是裸标量（字符串/数字/null）时判为失败，而不是崩在属性访问上', () => {
    // ⚠️ 这条分支此前**没有测试** —— 变异测试确认：把
    // `if (typeof raw !== 'object' || raw === null)` 改成 `if (false)`，
    // 全量测试全绿。裸数组那条分支覆盖不到它（数组走的是上面的 `Array.isArray`）。
    //
    // 为什么必须有：网关/代理在极端情况下会返回一个裸标量（如 `"error"` 或 `null`）。
    // 删掉这个守卫后，`raw` 会直接进到 `'status' in o` —— 对 `null` 抛
    // `TypeError: Cannot use 'in' operator`，对一个字符串返回 false 但后续
    // `o.code` 取到 undefined…… 结果是**一个与真实原因无关的崩溃**，
    // 而 Agent 看到的是一个未分类的异常。判成 ok:false/unknown 才是可诊断的。
    for (const raw of ['error', 42, null] as const) {
      const r = normalize(raw)
      expect(r.ok, `${JSON.stringify(raw)} 应判为失败`).toBe(false)
      expect(r.payload).toBeUndefined()
    }
  })

  it('data 存在但为空对象/空数组，标记为 notFound', () => {
    // 设计稿 §9.0：整个 API 上有三种"成功但为空"的编码 —— data 缺失、{}、[]。
    // 三种都必须判为 notFound，否则 Agent 会汇报"这段时间没有数据"。
    const empty = normalize({ code: 200, message: 'OK', data: {} }, 'A')
    expect(empty.payload).toEqual({})
    expect(empty.notFound).toBe(true)

    const emptyArr = normalize({ code: 200, message: 'OK', data: [] }, 'A')
    expect(emptyArr.payload).toEqual([])
    expect(emptyArr.notFound).toBe(true)

    const missing = normalize({ code: 200, message: 'success' }, 'A')
    expect(missing.payload).toBeUndefined()
    expect(missing.notFound).toBe(true)
  })

  it('isEmptyPayload 的标量边界：null/undefined 为空，0/""/false 不是空', () => {
    // ⚠️ 这条守 `isEmptyPayload` 的两个边界，此前都没有测试（操作符变异扫描确认）：
    //   · `v === null || v === undefined → true` 改成 `&&` 或改成 `false` 都存活 ——
    //     因为 `data: null` 从未被断言过。而实测 `robot.statistic.summary` 之类接口
    //     的 data 确实可能是 null，判成"有数据"会让 Agent 去读一个空载荷。
    //   · 尾部 `return false`（标量不是空）改成 `return true` 也存活 ——
    //     而 `ticket.filter.count` 的载荷就是**数字** `0`（"0 条"），
    //     `smstask.status` 的 message 也可能是 `"0"`。若把标量也判空，
    //     一个真实的计数 0 会被报成 not_found —— 与真实原因（就是 0 条）无关。
    // 这两条方向相反，必须各钉一个。
    expect(normalize({ code: 200, data: null }, 'A').notFound, 'data:null 是空').toBe(true)
    expect(normalize({ code: 200, data: undefined }, 'A').notFound, 'data:undefined 是空').toBe(true)
    // 标量不是空 —— 形状 A 的 data 是数字，形状 C 的 message 解析出数字
    expect(normalize({ code: 200, data: 0 }, 'A').notFound, '0 不是空').toBe(false)
    expect(normalize({ code: 200, message: '0' }, 'C').notFound, '"0" 不是空').toBe(false)
    expect(normalize({ code: 200, data: false }, 'A').notFound, 'false 不是空').toBe(false)
    expect(normalize({ code: 200, data: '' }, 'A').notFound, '空串不是空').toBe(false)
  })

  it('未实测信封 + message 承载载荷：仍要判 notFound（有实测依据的那一种空载荷）', () => {
    // 设计稿 §9.0 点名 smstask.status 未知任务 id 返回 {code:200, message:"[]"}。
    // 若因为该接口 envelope 还没实测就硬编码 notFound:false，
    // §9.2 的头号静默失败会在宽松模式下原样复现。
    // ⚠️ 标题此前写作"未实测信封的接口**也要判 notFound**" —— 它只覆盖了 message
    // 承载载荷这一条路径，却把结论推广到全部"未实测"，与下面 data 分支的规则相反。
    // 未实测接口**无任何载荷**时走的是尾部兜底，那一条**不判**（见下面那条测试）。
    expect(normalize({ code: 200, message: '[]' }).notFound).toBe(true)
    expect(normalize({ code: 200, message: '{}' }).notFound).toBe(true)
    expect(normalize({ code: 200, message: '{"a":1}' }).notFound).toBe(false)
  })

  it('未实测信封 + 完全无载荷：**不判** notFound —— 与 data/result 分支同一条规则', () => {
    // ⚠️ 这条守的是尾部兜底分支里一处**方向不一致**（此前无测试，实测确认）：
    // 尾部写 `envelope !== 'D'` 时，`null !== 'D'` 为真 → 未实测接口的 {code:200}
    // 被判成 notFound:true。而同一个未实测接口若载荷挂在 data 上（`{code,data:[]}`），
    // data 分支判的是 false。**同一批接口、两条路径给出相反答案**，判据只是
    // "载荷挂在哪个键上"，而那个键恰恰是注册表还没实测的东西。
    //
    // 对未实测的写接口（message.send / settings.wxTemplates 等），`{code:200}` 无载荷
    // 可能就是"操作成功"，判成 notFound 会把一次成功的写描述成"什么都没发生"。
    // 设计稿 §9.0 的"无数据字段一律 not_found"是**注册表查询**规则，它假定接口登记了
    // envelope；`null` 表示没登记，就该和 data 分支一样不断言。
    expect(normalize({ code: 200 }).notFound, '未实测 + 无载荷不应臆断为查无此物').toBe(false)
    expect(normalize({ code: 200, message: 'OK' }).notFound, 'message 纯文本、无 data、未实测').toBe(false)
    // 反向：已登记的取值仍必须区分 —— 别把这条修成"null 与 'D-nf' 一视同仁"
    expect(normalize({ code: 200 }, 'D-nf').notFound).toBe(true)
    expect(normalize({ code: 200 }, 'D').notFound).toBe(false)
    expect(normalize({ code: 200 }, 'A').notFound).toBe(true)
    // ⚠️ `'C'` 的裸 {code:200}（无 message）**不是** notFound：形状 C 的判据是
    // "message 能否解析成 JSON 载荷"，没有 message 时在**形状 C 分支内早退**
    // （`ok:false` + `messageText:'响应缺少 message'`，`notFound:false`）。
    // ⚠️ 2026-10-08 更正：此前写"落回尾部兜底" —— 控制流描述是错的（尾部兜底
    // 对 A/D 形状的裸 {code:200} 判 `notFound:true`，真落那里结论会相反）。
    // 断言本身一直是对的，错的是它给的理由。
    // 这里曾按直觉写成 `true`，实测纠正为 `false`。
    expect(normalize({ code: 200 }, 'C').notFound).toBe(false)
  })

  it('未实测信封的接口带 data 时**不判** notFound —— 写接口的空 data 是成功信号', () => {
    // ⚠️ 这条守的是一个**方向相反的静默失败**，且它落在最危险的接口上。
    //
    // 设计稿 §5.4.1 的**文档依据**（该段明确：这 5 个接口在实测中被刻意未调用、
    // 注册表须标 `verified: false`）：envelope 未实测的接口**全部是写接口**，
    // 而写接口的 `data` 语义与读接口相反 —— 尤其 `deleteKnowledges`（不可逆的
    // 批量删除）返回的是**失败**的 id 列表，**空数组 = 全部成功**。
    // （⚠️ 2026-10-08 更正：此前写"§5.4.1 实测"，与设计稿原文相反 —— 恰恰是**未实测**。）
    //
    // 旧实现无条件套用读接口的"空 data ⇒ not_found"，实测把一次**全部成功**的
    // 批量删除报成 `not_found: true` + "接口返回成功但无数据" ——
    // Agent 会以为**什么都没删掉**，而真相是**全部删掉了**。
    // 这是 §9.2 最危险的方向：把一个已完成的破坏性操作描述成空操作。
    //
    // → 注册表不知道某个未实测接口的 `data` 语义时，就不能假装知道。
    const r = normalize({ code: 200, data: [], message: 'success' })
    expect(r.notFound, 'deleteKnowledges 的 data:[] 是"全部成功"，不是"查无此物"').toBe(false)
    expect(r.payload).toEqual([])
    // 反向：已实测的形状 A 仍必须判 —— 设计稿 §9.0 的 group.members 传错 groupId 返回 []
    expect(normalize({ code: 200, message: 'OK', data: [] }, 'A').notFound).toBe(true)
    expect(normalize({ code: 200, message: 'OK', data: {} }, 'A').notFound).toBe(true)
  })

  it('形状 D（纯确认接口）无 data 是正常的，不是 notFound', () => {
    // robot.transfer.config 这类接口本来就只回一个 code
    expect(normalize({ code: 200 }, 'D').notFound).toBe(false)
    expect(normalize({ code: 200 }, 'D').ok).toBe(true)
  })

  it('形状 D-nf：同一形状的另一个接口，{code} 是它的"未找到"', () => {
    // robot.session.msgAssociate 在会话/消息不存在时只回 {code:200}，没有 data。
    // 与形状 D 的报文**完全一样**，语义相反 —— 只能靠注册表里的 envelope 区分。
    // ⚠️ 这两条必须成对断言：单看 D-nf 为 true 是**测不出东西**的，
    // 因为尾部兜底对任何非 'D' 的值都给 true。真正的差异在"同报文、不同判定"。
    expect(normalize({ code: 200 }, 'D-nf').notFound).toBe(true)
    expect(normalize({ code: 200 }, 'D').notFound).toBe(false)
  })

  it('形状 D-nf：带 data 时不是 notFound', () => {
    expect(normalize({ code: 200, data: { a: 1 } }, 'D-nf').notFound).toBe(false)
  })

  it('四个"载荷分支"的 ok 都跟着 code 走 —— code≠200 一律判失败', () => {
    // ⚠️ 这四条分支（result / data / staffInfo / 尾部兜底）都写成 `ok: codeOk`，
    // 而写下本循环之前，全量测试里**没有一条**喂过非 200 的 code（`codeOk` 恒为
    // true）—— 变异测试确认那时把这四处逐个改成 `ok: true`、全量测试仍全绿；
    // 下面的循环就是为补上这一缺口而写。
    //
    // ⚠️ **代码里 `ok: codeOk` 共 5 处，不是 4 处**（2026-10-07 核实，10-08 复核）：
    // 第 5 处是**宽松模式**（未登记形状）的 `message` 解析成功分支
    // （`if (parsed) return { ok: codeOk, … }`），它**不**由本条覆盖，而由下面
    // 「形状 C 上 code 非 200 时判失败」那条**末尾**不传形状的断言守
    // （各自单独变异确认：改掉任一处都恰好红 1 条）。两条测试合起来才是全部 5 处。
    // ⚠️ 原记「第 5 处是形状 C 的 message 解析成功分支」不成立 —— 形状 C 的解析
    // 成功分支写的是 `ok: true`（上方已有 `if (!codeOk)` 守卫，两写法等价），
    // 不在 `ok: codeOk` 清单里；真正没被本条覆盖的是宽松模式那一处。
    //
    // 为什么必须钉：`ok` 是 Agent 唯一的"服务端报没报错"信号。若某条分支恒 true，
    // 一个 `{code:14100, result:[...]}` 会被报成成功，Agent 会拿着一段
    // **失败响应里的残留载荷**当正常数据用 —— 这正是本计划反复强调的静默失败。
    // 四条的取值互不相同，必须各钉一次，不能只测其中一条。
    for (const [raw, shape] of [
      [{ code: 14100, result: [] }, 'B'],
      [{ code: 14100, data: {} }, 'A'],
      [{ code: 14100, staffInfo: [] }, 'A'],
      [{ code: 14100, message: 'OK' }, 'A'],
    ] as const) {
      const r = normalize(raw, shape as never)
      expect(r.ok, `${JSON.stringify(raw)} 的 code≠200，不能判成功`).toBe(false)
      expect(r.code).toBe('14100')
    }
    // 反向：同一个报文把 code 换成 200 就该是成功 —— 否则上面四条可能只是
    // 因为"分支根本没走到"而通过。`staffInfo` 那条尤其要正着测一次。
    expect(normalize({ code: 200, staffInfo: [] }, 'A').ok).toBe(true)
  })

  it('空的 staffInfo 是"无人在线"，不是 notFound', () => {
    expect(normalize({ code: 200, staffInfo: [] }, 'A').notFound).toBe(false)
  })

  it('有数据时不标 notFound', () => {
    expect(normalize({ code: 200, message: 'OK', data: [{ id: 1 }] }, 'A').notFound).toBe(false)
  })

  it('chat.queue.group.query：数据在 staffInfo，成功时 message 反而缺失', () => {
    // 设计稿 §9.0 实测集合里唯一有此倒置的接口。空的 staffInfo 是"无人在线"，不是错误。
    const r = normalize({ code: 200, staffInfo: [] }, 'A')
    expect(r.ok).toBe(true)
    expect(r.payload).toEqual([])
  })

  it('形状 C 上 code 非 200 时判失败 —— 即便 message 恰好是可解析的 JSON', () => {
    // ⚠️ 这条此前写作 `normalize({ code: 14100, message: 'Bad holder staff id' })`
    // —— **没传第二个参数**（于是走宽松模式/尾部兜底），夹具的 message
    // `'Bad holder staff id'` 本身也**不是合法 JSON**。所以它压根到不了形状 C 的
    // `if (!codeOk)` 守卫，测试名承诺的"message 是可解析 JSON 时仍判 false"从未被断言
    // （变异测试确认：删掉 C 分支那行 `if (!codeOk) return …`，全量测试仍全绿）。
    // 真正的判别式是：形状 `'C'` + message 可解析 + code≠200 → 必须判失败，
    // 而不是把那个 JSON 当载荷、把 14100 报成成功。
    const r = normalize({ code: 14100, message: '{"a":1}' }, 'C')
    expect(r.ok, 'code≠200 的形状 C 端点，即便 message 是 JSON 也判失败').toBe(false)
    expect(r.code).toBe('14100')
    expect(r.payload).toBeUndefined()
    // 宽松模式（不传形状）下同一报文走的是另一条路径：先解析、再由 `ok: codeOk`
    // 判 —— code 非 200，所以**同样判失败**（`ok:false`），与上面严格 C 结论一致，
    // 只是**路径**不同：严格 C 在解析前就用 `if (!codeOk)` 拒了，宽松模式先解析。
    // ⚠️ 2026-10-08 更正：此处曾写"message 可解析 → 判成功但 code 非 200"——
    // 与实现相反（宽松模式那行是 `ok: codeOk`，code 非 200 时 `ok` 为 false）。
    // 两者都保留，正是"注册表说得出形状就严格判、说不出就试探"的体现。
    expect(normalize({ code: 14100, message: '{"a":1}' }).ok).toBe(false)
  })
})
