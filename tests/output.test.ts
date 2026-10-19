import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ok, fail, usageFail, describeArgs, sanitizeControlChars } from '../src/output.js'

let out: string
// ⚠️ 用法错误现在**双通道**（stderr 给人、stdout 给 Agent），所以 err 也要捕获。
let err: string
beforeEach(() => {
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
})
afterEach(() => vi.restoreAllMocks())

describe('sanitizeControlChars —— 不受信文本不得注入终端控制序列', () => {
  it('替换 C0/C1 控制字符但保留 Tab', () => {
    expect(sanitizeControlChars('a\u001b]0;pwned\u0007\t\nb')).toBe('a·]0;pwned·\t·b')
  })

  it('usageFail 在出口净化 message 与 hint（security S4：不是靠每个调用点自觉）', () => {
    // 实测缺口：`query --table "nosuch\033]0;OWNED\007"` 走了净化、而同一文件的
    // `未知参数：…` / `--help` 多余参数路径没走 —— 逐调用点补会漏。
    out = ''; err = ''
    usageFail('未知参数：--bogus\u001b[2J', '提示：\u001b]0;OWNED\u0007')
    expect(err).not.toContain('\u001b')
    expect(err).toContain('未知参数：--bogus·[2J')
    const parsed = JSON.parse(out)
    expect(parsed.error.message).not.toContain('\u001b')
    expect(parsed.error.hint).not.toContain('\u001b')

    // 多行 message 的换行结构必须保住（净化是逐行做的，不是整串抹掉 \n）
    out = ''; err = ''
    usageFail('第一行\n第二行')
    expect(err).toBe('第一行\n第二行\n')
    expect(JSON.parse(out).error.message).toBe('第一行\n第二行')
  })
})

describe('成功输出', () => {
  it('形态为 {ok:true,data,meta}，且 stdout 是纯 JSON', () => {
    // ⚠️ data 与 meta 用**不同**的夹具（2026-10-07 修）：此前两者都是 `{ rows: 1 }`，
    // 于是把它们写反（`data: meta`）或一个槽位覆盖另一个，本条照样全绿。
    const code = ok({ rows: 1 }, { rows: 2 })
    const parsed = JSON.parse(out)
    expect(parsed.ok).toBe(true)
    expect(parsed.data, 'data 承载第一个实参').toEqual({ rows: 1 })
    expect(parsed.meta, 'meta 承载第二个实参，不能与 data 混').toEqual({ rows: 2 })
    expect(code).toBe(0)  // 字面量，不写 EXIT.OK —— 契约是数字（见 ㉙）
  })

  it('未提供 meta 时不输出该键', () => {
    ok({ a: 1 })
    expect(JSON.parse(out)).not.toHaveProperty('meta')
  })

  it('data 为 undefined 时仍输出 data:null，而不是丢掉整个键', () => {
    // ⚠️ 实测 robot.transfer.config 返回空壳 {code:200}，它的 payload 是 undefined。
    // 若 ok() 直接写 { ok:true, data }，JSON.stringify 会丢掉值为 undefined 的键，
    // 产出 {"ok":true} —— Agent 无法区分"这个接口没有载荷"与"解析出错"。
    // 设计稿 §9.1 的成功形态是 {ok, data, meta}，三个键都在。
    ok(undefined, { endpoint: 'robot.transfer.config' })
    const parsed = JSON.parse(out)
    expect(parsed).toHaveProperty('data')
    expect(parsed.data).toBeNull()
  })

  it('不带 meta 时 data 为 undefined 同样输出 data:null', () => {
    // ⚠️ `ok()` 有两个分支：带 meta 与不带 meta（两个**独立**的对象字面量）。
    // 上一条只覆盖了带 meta 的那支 —— 变异测试确认：把不带 meta 那支改回
    // `{ ok:true, data }`，上一条照样通过。两支必须各钉一条。
    ok(undefined)
    const parsed = JSON.parse(out)
    expect(parsed).toHaveProperty('data')
    expect(parsed.data).toBeNull()
    expect(parsed).not.toHaveProperty('meta')
  })

  it('data 为 0 / false / 空串时保持原值，不被 ?? 吞掉', () => {
    // 反向：`data ?? null` 只应在 null/undefined 上触发。
    // 若误写成 `data || null`，这三个合法的假值会被改成 null。
    for (const v of [0, false, '']) {
      out = ''
      ok(v)
      expect(JSON.parse(out).data, String(v)).toBe(v)
    }
  })
})

describe('失败输出', () => {
  it('形态为 {ok:false,error}，退出码按 kind 映射', () => {
    const code = fail({ code: '14009', kind: 'rate_limit', retryable: true, message: '太快' })
    const parsed = JSON.parse(out)
    expect(parsed.ok).toBe(false)
    expect(parsed.error.code).toBe('14009')
    expect(code).toBe(1)
  })

  it('危险操作未确认时退出码为 4，并携带确认所需字段', () => {
    // ⚠️ 调用方只给 confirmRequired 一个字段。原先这里传了 confirmArg/risk 并加
    // `as never` 绕过类型检查 —— 那两个键 ErrorInput 根本不认，fail() 也从不读，
    // 传了等于没传，还掩盖了"它们其实是硬编码"这个事实。
    const code = fail({
      code: 'confirm_required', kind: 'needs_confirmation', retryable: false,
      message: '需要确认', confirmRequired: true, target: 'message.send',
    })
    const parsed = JSON.parse(out)
    expect(code).toBe(4)
    expect(parsed.error.confirm_required).toBe(true)
    expect(parsed.error.confirm_arg).toBe('--yes')
    expect(parsed.error.risk).toBe('irreversible')
    expect(parsed.error.target).toBe('message.send')
    // 门禁错误必须是"不可重试" —— 让 Agent 重试一个需要人类确认的操作，
    // 只会让它把同一个错误再撞一遍。
    expect(parsed.error.retryable).toBe(false)
  })

  it('未设 confirmRequired 时，四个确认字段一个都不出现', () => {
    // 反向：普通业务错误里冒出 confirm_required 会让 Agent 去等一个不存在的确认。
    // ⚠️ `target` 也算确认字段 —— 它是"被拦下的接口 id"，只在 needs_confirmation 语义下
    // 有意义。实测确认：把 `e.target = error.target ?? ''` 从 `if (confirmRequired)` 块里
    // **移出**（变成无条件赋值），普通错误会多出一个 `"target": ""`，而此前只断言了
    // 前三个键、**测试照样全绿**。四个键必须一起断言。
    fail({ code: '14009', kind: 'rate_limit', retryable: true, message: '太快' })
    const parsed = JSON.parse(out)
    expect(parsed.error).not.toHaveProperty('confirm_required')
    expect(parsed.error).not.toHaveProperty('confirm_arg')
    expect(parsed.error).not.toHaveProperty('risk')
    expect(parsed.error).not.toHaveProperty('target')
  })

  it('网络错误退出码为 3', () => {
    expect(fail({ code: 'network', kind: 'network', retryable: true, message: '断了' }))
      .toBe(3)
  })

  it('hint / retry_after 等可选字段被原样透出 —— 它们是错误分类的全部产出', () => {
    // ⚠️ `hint` 是**多数**错误分类的产出，但**不是每条分支都有** —— 限流族就没有：
    // `rate()`（任务 3）返回的 `QiyuError` 不带 `hint`，因此真实的 14009 输出里
    // 只有 `code/kind/retryable/message/retry_after`，**没有 hint**。
    // 本用例是**手工传一个 hint 给 fail()**、再断言它透出 —— 它测的是 `fail()` 的
    // 透传能力，**不是**「14009 的真实输出带 hint」（后者其实不带）。
    // 若将来想让限流也带 hint，应在 `call()` 的 `err.kind === 'rate_limit'` 分支补，
    // 而不是在这里改注释或断言。
    // `retry_after` 则是限流的可执行信息。此前这两组字段没有任何测试：
    // 若 `fail()` 漏传 `hint`，**所有**分类的 hint 会静默消失，而现有测试全绿。
    fail({
      code: '14009', kind: 'rate_limit', retryable: true, message: '太快',
      hint: '请退避 30 秒后重试', retryAfter: { seconds: 30, source: 'observed' },
    })
    const e = JSON.parse(out).error
    expect(e.hint).toBe('请退避 30 秒后重试')
    // 入参驼峰 `retryAfter` → 出参下划线 `retry_after`，这是 Agent 契约的一部分。
    // ⚠️ 必须连带断言 `source`（2026-10-05 加）—— 此前 `toEqual({ seconds: 30 })`
    // 只钉住数字，把 `source` 整个删掉测试照样绿，而 Agent 正是靠它分辨
    // "实测冷却" / "文档值" / "本地桶" / "未登记接口的 60 秒兜底"。
    expect(e.retry_after).toEqual({ seconds: 30, source: 'observed' })
    // ⚠️ `retryStrategy` / `fallback` 也必须断言 —— `ErrorInput` 声明了它们、
    // `fail()` 也实现了透传（`if (error.retryStrategy) e.retry_strategy = …`），
    // 但此前**零断言**：删掉那两行透传，`retry_strategy` / `fallback` 就成了
    // 永不出现的契约字段，而全部测试不红。名字里的"等可选字段"必须真的覆盖到它们。
    out = ''
    fail({
      code: '14009', kind: 'rate_limit', retryable: true, message: '太快',
      retryStrategy: 'switch_to_local', fallback: 'qiyu query --table sessions',
    })
    const e3 = JSON.parse(out).error
    expect(e3.retry_strategy).toBe('switch_to_local')
    expect(e3.fallback).toBe('qiyu query --table sessions')
    // 反向：未提供时不该冒出这两个键
    out = ''
    fail({ code: 'x', kind: 'param', retryable: false, message: 'm' })
    const e2 = JSON.parse(out).error
    expect(e2).not.toHaveProperty('hint')
    expect(e2).not.toHaveProperty('retry_after')
    expect(e2).not.toHaveProperty('retry_strategy')
    expect(e2).not.toHaveProperty('fallback')
  })

  it('每个 kind 都映射到正确的退出码 —— 拼错 kind 会静默落到 default', () => {
    // ⚠️ `ErrorInput.kind` 是 `string` 而不是联合类型（刻意的解耦），
    // 所以把 'needs_confirmation' 拼成 'needs_confirm' **不会报编译错**，
    // 只会落到 default → 退出码 1，而 Agent 期待 4。
    // 这条把每个 kind → 退出码的映射逐一钉住。
    //
    // ⚠️ 期望值写**字面量** 3/2/1，不写 `EXIT.NETWORK` 等（2026-10-07 改）——
    // 写常量的话，把 `EXIT.NETWORK` 的值从 3 改成 5，测试与实现同步变，照样绿；
    // 而契约（全局约束那行「`3` 网络错误」）是字面数字，Agent 是按字面解析的。
    //
    // ⚠️ 覆盖**全部 16 个 kind**（旧表只钉了 9 个 —— 漏掉的 7 个只走 default，
    // 等于没测）：`classify` 产出 13 个，另加 `usageFail` 的 `usage`、
    // 确认路径的 `needs_confirmation`、环境检查的 `auth_missing`。
    // ⚠️ **2026-10-08 更正**：`classify` 实际产出 **14** 个 kind（`auth`、
    // `bad_time`、`param`、`rate_limit`、`module_offline`、`window_too_large`、
    // `window_misaligned`、`not_in_queue`、`pending`、`route_not_found`、
    // `internal`、`network`、`unknown`、`auth_missing`），不是 13 —— 漏数的是
    // `auth_missing`（它由 `commands/auth.ts` 与 `commands/api.ts` 直接构造，
    // 不经 `classify`）。14 + `usage` + `needs_confirmation` = 16，
    // **总数对、子分类错**。判据：`grep -oE "kind: '[a-z_]+'" src/core/errors.ts
    // | sort -u` 得 13 个（`auth_missing` 不在 errors.ts 里，在 commands/ 下）。
    // ⚠️ **同日第二次更正（我把自己刚写的更正又写错了）**：`classify` 产出的是
    // **13** 个，不是 14 —— `auth_missing` **不在** `classify` 的产出里，所以它
    // 属于"另加"那一组，不该被算进 14。13 + `usage` + `needs_confirmation`
    // + `auth_missing` = 16。**我犯的是"把刚发现的漏数直接加进被更正的数"** ——
    // 更正本身对（漏的是 `auth_missing`），但加错了位置：它该进"另加"组，
    // 不是把 13 抬成 14。判据不变（errors.ts 内 13 个 kind 字面量），
    // 但**读法**要跟着改：13 是 `classify` 的产出，`auth_missing` 是第 14 个、
    // 由 commands/ 直接构造。
    // `needs_confirmation` **不给** confirmRequired 时必须落 default → 1
    // （退出码 4 只由 confirmRequired 决定，见 `fail()`）——否则能构造出
    // "返回 4 却没告诉 Agent 确认什么"的输出，违反设计稿 §9.1 的「必须」。
    const table: Array<[string, number]> = [
      ['network', 3],
      ['usage', 2],
      // 其余一律是业务错误（1）—— 兜住 default 分支这一路
      ['auth', 1],
      ['auth_missing', 1],
      ['bad_time', 1],
      ['internal', 1],
      ['module_offline', 1],
      ['not_in_queue', 1],
      ['param', 1],
      ['pending', 1],
      ['rate_limit', 1],
      ['route_not_found', 1],
      ['unknown', 1],
      ['window_misaligned', 1],
      ['window_too_large', 1],
      ['needs_confirmation', 1],
    ]
    expect(table.map(([k]) => k).sort(), 'kind 全集必须与本文件出现的 16 个一致')
      .toEqual(['auth', 'auth_missing', 'bad_time', 'internal', 'module_offline',
                'needs_confirmation', 'network', 'not_in_queue', 'param', 'pending',
                'rate_limit', 'route_not_found', 'unknown', 'usage',
                'window_misaligned', 'window_too_large'])
    for (const [kind, want] of table) {
      expect(fail({ code: 'x', kind, retryable: false, message: 'm' }), kind).toBe(want)
    }
    // 退出码 4 的唯一入口：kind 随便写，但必须给 confirmRequired
    expect(fail({ code: 'x', kind: 'needs_confirmation', retryable: false,
                  message: 'm', confirmRequired: true })).toBe(4)
  })

  it('退出码 4 ⟺ 四个确认字段齐全 —— 不存在"返回 4 却没说确认什么"', () => {
    // ⚠️ 钉住设计稿 §9.1 的「必须」：退出码 4 必须携带
    // confirm_required/confirm_arg/risk/target 且 retryable:false。
    // 此前退出码（按 kind）与确认字段（按 confirmRequired）是两个独立闸门，
    // 能构造出「返回 4、四个字段一个都没有」。现在两者共用 confirmRequired
    // 这一个判据，下面逐个方向都钉一遍。
    out = ''
    const code = fail({ code: 'confirm_required', kind: 'needs_confirmation', retryable: false,
                        message: 'm', confirmRequired: true, target: 'message.send' })
    const e = JSON.parse(out).error
    expect(code, '给了 confirmRequired 就必须返回 4').toBe(4)
    for (const k of ['confirm_required', 'confirm_arg', 'risk', 'target']) {
      expect(e, `退出码 4 时 ${k} 必须存在`).toHaveProperty(k)
    }
    // 反向：不给 confirmRequired 就绝不返回 4，哪怕 kind 写的就是 needs_confirmation
    out = ''
    const not4 = fail({ code: 'x', kind: 'needs_confirmation', retryable: false, message: 'm' })
    expect(not4, '没给 confirmRequired 就不该是 4').not.toBe(4)
    expect(JSON.parse(out).error, '没给就不该有确认字段').not.toHaveProperty('confirm_required')
    // 就算调用方硬给 retryable:true，也必须被覆写成 false ——
    // 让人工确认一个不可逆操作失败后自动重试，是最坏的结果（重复执行）。
    out = ''
    fail({ code: 'x', kind: 'needs_confirmation', retryable: true, message: 'm',
           confirmRequired: true })
    expect(JSON.parse(out).error.retryable, '确认类错误不允许 retryable:true').toBe(false)
  })
})

describe('usageFail —— 用法错误必须双通道（2026-10-05 修）', () => {
  it('stderr 出人类可读文本，stdout 出合法 JSON，退出码 2', () => {
    // ⚠️ 这条是**契约的核心**：全局约束要求「其余任何情况下 stdout 都必须是合法 JSON」。
    // 此前用法错误只写 stderr、stdout 为空 —— `qiyu api call x --bogus | jq` 拿到空输入。
    // 断言必须**同时**覆盖两个通道：只断言 stderr 会漏掉 stdout 为空的老毛病。
    const code = usageFail('用法：qiyu api call <接口id>')
    expect(code).toBe(2)
    expect(err).toContain('用法：qiyu api call')
    const parsed = JSON.parse(out)          // 解析不过就是契约违例
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toMatchObject({ code: 'usage', kind: 'usage', retryable: false })
    expect(parsed.error.message).toBe('用法：qiyu api call <接口id>')
  })

  it('stdout 的 message 去掉尾部换行，stderr 的文本保留换行', () => {
    // ⚠️ JSON 里不该带控制字符；但 stderr 是终端文本，换行便于阅读。两者刻意不同。
    out = ''; err = ''
    usageFail('未知子命令：foo\n可用子命令：bar\n')
    expect(JSON.parse(out).error.message).toBe('未知子命令：foo\n可用子命令：bar')
    expect(err.endsWith('\n')).toBe(true)
    // 缺换行时 stderr 也要补一个，避免与下一条输出粘在一起
    out = ''; err = ''
    usageFail('没有换行')
    expect(err).toBe('没有换行\n')
  })

  it('hint 可选，给了就原样透出到 stdout；stderr 仍是同一句 message', () => {
    // ⚠️ 断言 stderr（2026-10-08 补）：hint 是**给 Agent 的结构化提示**，
    // stderr 是给人读的通道 —— 后者的契约是"与 stdout 的 message 同一句话"，
    // 不是"把 hint 也抄一份"。若实现把 hint 追加进 stderr，人和 Agent 会读到
    // 两段不一致的说明（与 ㉔ 的"逐字写进 stderr"是同一条纪律）。
    out = ''; err = ''
    usageFail('用法错误', '正确的写法见 --help')
    expect(JSON.parse(out).error.hint).toBe('正确的写法见 --help')
    expect(err, 'hint 不得进 stderr —— stderr 只写 message').toBe('用法错误\n')
  })
})

describe('describeArgs —— 错误消息必须指名它抱怨的那个参数', () => {
  it('空串渲染成 \'\'，而不是渲染成"什么都没有"', () => {
    // ⚠️ 这条守的是「退出码 2 的全部价值就是告诉 Agent 改哪里」。shell 里
    // `qiyu api list "$UNSET"` 展开成空串，此前报出的是
    // `未知参数：。` —— 冒号后面什么都没有，Agent 无从知道该改哪个参数。
    // 不直测它，把 `describeArgs` 换成裸 `join('、')` 全量测试仍全绿。
    expect(describeArgs(['']), '单个空参数要说清"是一个空参数"').toBe("''")
    expect(describeArgs(['--all', '']), '混着正常参数时只替换空串').toBe("--all、''")
  })

  it('纯空白参数同样渲染成可见形式（2026-10-08 补）', () => {
    // ⚠️ 函数头注释从 2026-10-05 起就写着"保证空串**与空白参数**不会被渲染成
    // 什么都没有"，而实现只处理了空串 —— 注释承诺了、实现没做。
    // `qiyu api list " "` 报「未知参数： 。」：参数名不可见，与空串是同一个病。
    // 变异确认：判据退回 `a === ''`，本条立即变红（同族的 api/cli 用例一起红）。
    expect(describeArgs([' ']), '空格参数必须可见').toBe("' '")
    expect(describeArgs(['\t']), 'Tab 同理').toBe("'\t'")
    expect(describeArgs(['--all', ' ']), '混着正常参数时只替换纯空白').toBe("--all、' '")
  })

  it('空数组渲染成空串（没有参数可列就是没有，不该编出参数名）', () => {
    expect(describeArgs([])).toBe('')
  })

  it('普通参数原样拼接，不加引号也不转义 —— 报错要可直接照抄', () => {
    expect(describeArgs(['--al', 'extra'])).toBe('--al、extra')
  })
})
