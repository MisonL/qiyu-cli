// tests/core/errors.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { classify, redactInternal, ERROR_KINDS, type ErrorKind } from '../../src/core/errors.js'
import { fail } from '../../src/output.js'

// ErrorKind 闭集用例要观察 fail() 的 stdout 信封（与 tests/output.test.ts 同款 spy）。
let out = ''
beforeEach(() => {
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
})
afterEach(() => { vi.restoreAllMocks() })

describe('错误分类', () => {
  it('14001 鉴权错误不可重试', () => {
    expect(classify(14001, 'appKey error')).toMatchObject({ kind: 'auth', retryable: false })
  })

  it('14002 / 14008 / 14515 都归为 auth —— 它们的 hint 各不相同，不能只测一个', () => {
    // ⚠️ 这三个 case 此前**没有任何测试** —— 变异测试确认：逐个删掉，
    // 全量测试全绿。它们各自承载不同的**可执行动作**，合并成一个 case 或
    // 让某个掉进 default（unknown）都会让 Agent 失去行动依据：
    //   14002 → 签名不匹配，是 CLI 内部缺陷（要报告，不是改凭证）
    //   14008 → 本机 IP 不在白名单（要加白名单，不是改 appKey）
    //   14515 → 该接口需单独申请权限（要申请，不是改任何本地配置）
    // ⚠️ 必须断言 hint —— 只断言 kind:'auth' 的话，三者互相顶替都能通过。
    expect(classify(14002, 'Bad checksum')).toMatchObject({ kind: 'auth', retryable: false })
    expect(classify(14002, 'Bad checksum').hint).toMatch(/内部缺陷/)
    expect(classify(14008, 'ip not allowed')).toMatchObject({ kind: 'auth', retryable: false })
    expect(classify(14008, 'ip not allowed').hint).toMatch(/白名单/)
    expect(classify(14515, 'no permission')).toMatchObject({ kind: 'auth', retryable: false })
    expect(classify(14515, 'no permission').hint).toMatch(/申请/)
  })

  it('14003 判定为 bad_time，且 hint 指向"校对时钟"而不是"重试"', () => {
    // core 会先自动重签重试一次；Agent 能拿到这个错误，就说明重签也没救回来
    // （重签只是重读同一个偏移的时钟）。此时若标 retryable:true，
    // Agent 会无限重试一个它自己修不好的东西。
    const e = classify(14003, 'Bad time')
    expect(e).toMatchObject({ kind: 'bad_time', retryable: false })
    expect(e.hint).toMatch(/时钟/)
    // ⚠️ 必须**同时给 macOS 与 Linux 两条命令**（2026-10-06 补）。此前只给
    // `sudo sntp -sS time.apple.com` —— 那是 macOS 专有语法配苹果的 NTP 服务器，
    // 而这是个跨平台 npm 包。在 Linux 容器里（Agent 的常见运行环境）那条命令
    // 跑不通，于是 hint 指向了一个不可执行的动作 —— 与「hint 必须可执行」相反。
    // 只断言"提到时钟"的话，把整条命令删掉也照样通过。
    expect(e.hint, '必须给 macOS 的校时命令').toMatch(/sntp/)
    expect(e.hint, '必须给 Linux 的校时命令').toMatch(/timedatectl|ntpdate/)
  })

  // —— 复核重点 5：限流语义横跨**五个**错误码、多种措辞 ——
  it('14009 的三种措辞都识别为限流', () => {
    expect(classify(14009, 'api call too frequent').kind).toBe('rate_limit')
    expect(classify(14009, 'api request too frequent,60s can request less than 10 times').kind)
      .toBe('rate_limit')
    expect(classify(14009, 'Call too frequent, please call later').kind).toBe('rate_limit')
  })

  it('14500 + 单位时间内请求过于频繁 也识别为限流，而不是内部错误', () => {
    expect(classify(14500, '单位时间内请求过于频繁')).toMatchObject({ kind: 'rate_limit' })
  })

  it('限流的冷却时间不来自 classify —— 它必须由调用方按接口限频表填', () => {
    // 实测冷却随接口变化：报表约 30 秒、ipcc 60 秒、知识库数分钟。
    // 任何写死在分派器里的秒数，对其中某类接口必然是错的。
    expect(classify(14009, 'api call too frequent').retryAfter).toBeUndefined()
  })

  it('三个限流码都被识别（其中 12001/14402 官方 10 行表里没有，14009 官方表里有）', () => {
    // ⚠️ message 必须用**不认识**的文本 —— 否则中文/英文措辞那条分支会先命中，
    // 错误码分支即使被删掉测试也照样通过，等于没测。
    //
    // ⚠️ 标题此前写作"官方 10 行错误码表里没有它们"，把 `14009` 也算进去了 ——
    // **这是错的**：设计稿 §4.3 逐字核验的官方 10 行表是
    // `200、14001、14002、14003、14004、14008、14009、14500、14501、14515`，
    // **`14009` 在里面**；"补充错误码体系"表只列了 `12001` 与 `14402`。
    // 把官方有的码说成"实测补充"，属于本仓库明令要消灭的"测试名比事实说得多"。
    // （⚠️ 此处此前误标为 §4.1 —— §4.1 是「签名」，两张错误码表都在 §4.3「错误处理」。）
    //
    // ⚠️ 标题说"三个"，这里此前只断言了**两个** —— `14009` 漏掉了，
    // 于是 `case '14009':` 被删掉时**没有任何测试失败**（变异测试确认：
    // 全量测试全绿）。上面那条「14009 的三种措辞」用的全是**含限流词的**文本，
    // 走的是文本分支，根本到不了这个 case。标题里的数字必须与断言数一致。
    expect(classify(14009, 'unrecognized text').kind).toBe('rate_limit')
    expect(classify(12001, 'unrecognized text').kind).toBe('rate_limit')
    expect(classify(14402, 'unrecognized text').kind).toBe('rate_limit')
  })

  it('12001 的中文措辞「查询间隔小于一分钟」按文本识别 —— 官方登记的唯一文本', () => {
    // ⚠️ 这条分支此前**零覆盖**：`grep '查询间隔小于一分钟' tests/` 零命中，
    // 变异测试确认删掉它全量仍全绿。而它是设计稿 §4.3 补充表里 `12001` 的
    // **唯一官方文本** —— 若只靠 `case '12001'` 兜底，将来服务端改回该码配这段
    // 文本时就会漏判。用一个**不在任何 code 分支**的码强制走文本匹配，
    // 证明这条中文分支真的生效（而不是被 code 分支掩盖）。
    expect(classify(99999, '查询间隔小于一分钟').kind).toBe('rate_limit')
  })

  it('8011 的 `create too fast` 按文本识别 —— 不能只靠 case 8011 兜底', () => {
    // ⚠️ 上一条「8011 的两种措辞」用的码就是 8011，于是 `create too fast`
    // 这条文本分支删掉后仍由 `case '8011'` 兜住，测试照样绿（变异测试确认）。
    // 用一个无 code 分支的码强制走文本匹配，把这条分支单独钉住。
    expect(classify(99999, 'create too fast').kind).toBe('rate_limit')
  })

  it('英文限流措辞即使配一个未知错误码也能识别 —— 证明确实按文本匹配', () => {
    // ⚠️ 这条守的是「限流分支先于错误码判断」这个顺序本身。
    // 用一个**没有任何 code 分支**的码（99999）配英文措辞：
    // 只有文本匹配真的生效，才会得到 rate_limit；否则会落到 unknown。
    // 变异测试确认：删掉 `too frequent` 或 `Forbidden For Time rate` 任一行，这条会失败。
    expect(classify(99999, 'api call too frequent').kind).toBe('rate_limit')
    expect(classify(99999, 'Too many running task').kind).toBe('rate_limit')
    expect(classify(99999, 'Forbidden For Time rate').kind).toBe('rate_limit')
    // 反向：未知码 + 不认识的文本仍然是 unknown（不能一律判限流）
    expect(classify(99999, 'something else entirely').kind).toBe('unknown')
  })

  it('8011 的两种措辞都是限流 —— 只认一种会让 Agent 该重试时直接放弃', () => {
    // 设计稿 §4.3：`create too fast` 与 `Too many running task` 都来自会话导出创建
    expect(classify(8011, 'create too fast')).toMatchObject({ kind: 'rate_limit', retryable: true })
    expect(classify(8011, 'Too many running task')).toMatchObject({ kind: 'rate_limit', retryable: true })
  })

  it('8011 即使文本里没有任何限流词也判为限流 —— 该码本身就是限流码', () => {
    // ⚠️ 上面那两种措辞已被**顶部的文本分支**拦下，根本走不到 `case '8011'`。
    // 因此那条测试并没有钉住 `case '8011'` 的语义 —— 删掉整个 case 它照样通过
    // （变异测试确认过）。这里用一个**不含限流词**的文本，强制走到错误码分支，
    // 把"8011 这个码本身就代表限流（会话导出创建的限流码，措辞会变）"钉死。
    expect(classify(8011, '某种没见过的措辞')).toMatchObject({
      kind: 'rate_limit', retryable: true,
    })
  })

  // —— 14500 的多种含义 ——
  it('14500 + Service Offline 判定为模块未开通，不可重试（必须熔断）', () => {
    expect(classify(14500, 'Service Offline')).toMatchObject({
      kind: 'module_offline', retryable: false,
    })
  })

  it('14500 + Param format error 判定为参数错误，不可重试', () => {
    expect(classify(14500, 'Param format error,please check')).toMatchObject({
      kind: 'param', retryable: false,
    })
  })

  it('14500 + can not cast to JSONObject. 判定为请求构造 bug，不可重试', () => {
    expect(classify(14500, 'can not cast to JSONObject.')).toMatchObject({
      kind: 'param', retryable: false,
    })
  })

  // —— 复核重点 2：两种 NPE 措辞 ——
  it('14500 的两种 Java NPE 措辞都判定为参数错误', () => {
    // 只断言「以 Cannot invoke " 为前缀」这一行为，不绑定任何真实类名 ——
    // 厂商内部包名不该出现在本仓库里，测试夹具也不例外。
    const a = 'Cannot invoke "example.internal.pkg.SomeClass.getId()" because "staff" is null'
    const b = 'Cannot invoke "example.internal.pkg.SomeMap.containsKey(Object)" because "msg" is null'
    expect(classify(14500, a)).toMatchObject({ kind: 'param', retryable: false })
    expect(classify(14500, b)).toMatchObject({ kind: 'param', retryable: false })
  })

  it('14500 的单独 NullPointerException 也判定为参数错误', () => {
    // ⚠️ redactInternal 会把 `java.lang.NullPointerException` 替换成 `<内部类>`，
    // 所以这条测试验证的是"在 redact 之前检查原始 message"这一逻辑。
    expect(classify(14500, 'java.lang.NullPointerException')).toMatchObject({ kind: 'param', retryable: false })
    expect(classify(14500, 'NullPointerException')).toMatchObject({ kind: 'param', retryable: false })
  })

  it('14500 + 起止时间不能超过X天 判定为 window_too_large，而不是内部错误', () => {
    // 来自 ai.statistic.transferHuman（365 天上限）。若落入兜底分支，
    // Agent 会认为是服务端内部错误，反复重试并永远失败。
    expect(classify(14500, '起止时间不能超过365天')).toMatchObject({
      kind: 'window_too_large', retryable: false,
    })
    expect(classify(14500, '起止时间间隔不能超过365天')).toMatchObject({ kind: 'window_too_large' })
    // ⚠️ 反向必须断言 —— 三个词是 `&&` 关系，缺一不可。只测正向时，把 `&&` 改成 `||`
    // （任一词命中即判跨度超限）测试照样全绿（操作符变异扫描确认）。而 `天` 是极常见的字：
    // `该功能今天不可用`、`今天维护` 都会被误判成 `window_too_large`（retryable:false
    // 且 hint 让 Agent 去切片）—— 一个本该退避重试或报告内部故障的错误，被说成"你的窗口太大"。
    for (const m of ['该功能今天不可用', '今天维护', '起止时间格式错误']) {
      expect(classify(14500, m), `只有「天」不该判跨度：${m}`).toMatchObject({ kind: 'internal' })
    }
  })

  it('14500 的两种"内部错误"措辞都判定为可退避重试', () => {
    expect(classify(14500, 'Unexpected internal error, hint: deadbeef')).toMatchObject({
      kind: 'internal', retryable: true,
    })
    expect(classify(14500, 'Internal Error, retry later')).toMatchObject({
      kind: 'internal', retryable: true,
    })
  })

  it('14500 光秃秃的 Internal error 判为不可重试 —— 且三种近似措辞互不串味', () => {
    // 这三段文本只差几个字符，动作却相反。设计稿 §4.3 把前两种列为"服务端内部错误
    // → 退避重试"；光秃秃的 `Internal error` **不在该表内**（按表体应落末行"退避
    // 重试"），本计划**有意偏离**该表、判为不可重试 —— 依据是 §6.2 记录的两个来源
    // （**都在 §6.2**：`ticket.list` 传 staffId=-1/-99、空结果集上 `page > 1`）——
    // 两者都是 Agent 改参数就能解决、重试永远失败的。
    // ⚠️ 此前这里把"`transferHuman` 用超限窗口"当作第三个来源 —— **那是错的**：设计稿
    // §7.4.1 已**显式撤回**早前"transferHuman 在 364 天会失败"的说法（"不存在
    // 「边界不稳定」这回事……那是错的"），且 transferHuman 真正超限时的报文是
    // `14500 起止时间不能超过365天`（**带数字**），已被本文件的 `起止时间`+`不能超过`
    // +`天` 三词分支接走（→ window_too_large），**根本到不了裸 `Internal error` 这一支**。
    // 故这里只记 §6.2 的两个来源，不再援引被撤回的成因。
    // ⚠️ 承重的是**分支次序**，不是 `has` 的大小写：`retry later` 分支在本分支
    // **之前**，`Internal Error, retry later` 先被它接走（该措辞里的 `retry later`
    // 原样小写出现，`has` 改不改大小写都命中）。会把它错判成不可重试的，是把
    // 裸 `/internal error/i` 分支挪到前面 —— 2026-10-08 实测：调换次序 → **2 条**
    // 失败（「14500 的两种"内部错误"措辞都判定为可退避重试」与本条同时红）。
    // 这条断言把三种措辞的**分派**钉死，而不是钉"恰好没匹配上"。
    expect(classify(14500, 'Internal error')).toMatchObject({
      kind: 'internal', retryable: false,
    })
    expect(classify(14500, 'Internal error').retryable).toBe(false)
    // 大小写变体也必须走可重试分支（显式匹配 `retry later`，不靠大小写巧合）
    expect(classify(14500, 'Internal Error, retry later').retryable).toBe(true)
    expect(classify(14500, 'Unexpected internal error, hint: deadbeef').retryable).toBe(true)
  })

  it('脱敏先于措辞匹配 —— 否则 NPE 分支会被自己抹成不可达', () => {
    // classify 第一步就是 redactInternal。若哪天把顺序调过来（先匹配再脱敏，
    // 或者匹配用原文、脱敏只用于输出），含真实包路径的 NPE 报文就会走到
    // `Cannot invoke` 的匹配上——这条断言把"脱敏后的文本仍可分类"钉住。
    expect(classify(14500, 'Cannot invoke "a.b.c.SomeClass.getId()" because "x" is null').kind)
      .toBe('param')
    expect(classify(14500, 'Cannot invoke "a.b.c.SomeClass.getId()" because "x" is null').message)
      .not.toContain('SomeClass')
  })

  it('14500 无法匹配任何措辞时退避重试，而不是崩溃', () => {
    expect(classify(14500, '某种没见过的报文')).toMatchObject({
      kind: 'internal', retryable: true,
    })
  })

  // —— 14501 有两种含义，必须靠 message 区分（设计稿 §6.2）——
  it('14501 跨度超限判定为 window_too_large —— 且 hint 必须给出 Agent 能执行的动作', () => {
    expect(classify(14501, '(endTime-startTime)/millsADay > 31 is invalid'))
      .toMatchObject({ kind: 'window_too_large', retryable: false })
    expect(classify(14501, '(endTime-startTime)/millsADay > 365 is invalid'))
      .toMatchObject({ kind: 'window_too_large' })
    // 主用户是 Agent：hint 若写"core 会重切"，它会等一个本计划根本不存在的重试。
    // 本计划没有自动切片（见「已知缺口」），hint 必须指向它自己能做的动作。
    expect(classify(14501, '(endTime-startTime)/millsADay > 31 is invalid').hint)
      .toMatch(/切片/)
  })

  it('14501 对齐错误判定为 window_misaligned —— 切片修不好它', () => {
    // 设计稿 §6.2 实测：staffAttendance / performance 在 endTime = now 时
    // 返回的就是这一种。对它"自动分片"是无效修复，正确动作是把 endTime
    // 对齐到自然日边界。两者错误码相同、修复方式完全不同。
    expect(classify(14501, 'endTime is invalid')).toMatchObject({
      kind: 'window_misaligned', retryable: false,
    })
  })

  // —— 14004 与 14500 一样是多义码（设计稿 §4.3 明确要求分发表）——
  it('14004 的"跨度超限"措辞归为 window_too_large，而不是普通参数错误', () => {
    expect(classify(14004, '超出按天获取数据的最大时间范围，请检查参数'))
      .toMatchObject({ kind: 'window_too_large' })
    // 同上：hint 必须可执行，不能承诺一个不存在的自动重试
    expect(classify(14004, '超出按天获取数据的最大时间范围，请检查参数').hint)
      .toMatch(/切片/)
    expect(classify(14004, 'opTime range over limit'))
      .toMatchObject({ kind: 'window_too_large' })
    // ⚠️ 与 14501 不同，这条报文**不带数字** —— hint 必须指向注册表的
    // max_window_days，否则 Agent 只能猜（实测 ticket.search 硬限 90 天，
    // 而 opStart 另被钳到 31 天，两个数字报文里都没有）。
    expect(classify(14004, 'opTime range over limit').hint).toMatch(/max_window_days/)
  })

  it('14004 的其余措辞归为参数错误', () => {
    expect(classify(14004, 'Not found param').kind).toBe('param')
    expect(classify(14004, 'uid参数不能为空，请检查').kind).toBe('param')
    expect(classify(14004, 'Bad json payload').kind).toBe('param')
    expect(classify(14004, 'group not exist or deleted').kind).toBe('param')
  })

  it('14007 被识别，尽管它不在官方 10 行错误码表里', () => {
    const r = classify(14007, 'user not in queue')
    expect(r).toMatchObject({ kind: 'not_in_queue' })
    // ⚠️ **必须同时断言 hint**（2026-10-05 修）：只钉 kind 的话，把 hint 整段删掉
    // 测试照样绿 —— 而这条 hint 承载的正是设计稿记下的关键事实：厂商对 code 的
    // 描述（"用户不存在"）与实际 message 不一致。少了它，agent 最可能的推理是
    // "用户不存在" → 删用户或报错说用户没了，而真相是"未排队、别重试"。
    // 断言命中"不要重试"与"描述不一致"两个要点，而不是只断言 hint 存在。
    expect(r.hint, '14007 必须给 hint').toBeTruthy()
    expect(r.hint).toMatch(/不要重试|非故障|业务状态/)
    expect(r.hint, 'hint 必须点破厂商描述与实际的出入').toMatch(/不一致/)
  })

  it('其余补充错误码不会掉进 unknown', () => {
    expect(classify(67406, 'PARAM_LOSS').kind).toBe('param')
    expect(classify(8002, 'appKey dose not belong to a platform').kind).toBe('auth')
    expect(classify(14200, 'Not supported category type').kind).toBe('param')
    expect(classify(14301, 'session can not be found').kind).toBe('param')
    expect(classify(8012, '该任务id不存在').kind).toBe('param')
    expect(classify(67506, 'TASK_ID_SIZE_OVERFLOW').kind).toBe('param')
  })

  it('四个 param 补充码的 hint 各不相同 —— 只断言 kind 的话它们能互相顶替', () => {
    // ⚠️ 语句删除变异扫描确认：`67406`/`14200`/`14301`/`8012` 四个 case 的
    // `return param(...)` **逐个删掉，全量测试都全绿**（扫描当时 242 条通过）。
    // 那是**当时的快照**，不是本文件的契约 —— 测试条数会随后续补测增长，
    // 本条的结论是"变异存活"这件事本身，不依赖任何具体数字。原因是
    // 上一条测试只断言 `.kind`，而四个 case 的 kind 都是 `'param'` —— 删掉一个的
    // return 就**落穿到下一个 case**，kind 仍是 param，断言照样通过。
    //
    // 可观测后果（实测逐个删掉后的输出）：
    //   删 67406 → 67406 的 hint 变成「分类接口的 type 取值非法」（14200 的）
    //   删 14200 → 14200 拿到 14301 的 hint，依此类推
    // 四个 hint 各自指向**不同的可执行动作**（补短信参数 / 改 category type /
    // 换会话模板 / 查呼叫任务 id）。落穿后 Agent 会照着错误的动作去改参数 ——
    // 正是「面向 Agent 的契约诚实性」要消灭的形态：**错误的指引比没有指引更坏**。
    // （与本文件里 14002/14008/14515 那条同源：kind 相同、hint 不同，必须断言 hint。）
    expect(classify(67406, 'PARAM_LOSS').hint).toMatch(/短信/)
    expect(classify(14200, 'Not supported category type').hint).toMatch(/分类接口的 type/)
    expect(classify(14301, 'session can not be found').hint).toMatch(/会话不存在|模板/)
    expect(classify(8012, '该任务id不存在').hint).toMatch(/呼叫任务/)
  })

  it('14001 的 hint 指向「检查 appKey」，不是别的 auth 码的 hint', () => {
    // ⚠️ 语句删除变异扫描确认：删掉 `case '14001'` 的 return，全量测试全绿。
    // `14001` 后面紧邻 `case '14002'`，两者 kind 都是 `'auth'`、retryable 都是
    // false，所以只断言 kind 的测试看不出差别。可观测后果（实测）：
    //   删掉后 14001 的 hint 从「请检查 QIYU_APP_KEY 是否正确」变成
    //   「签名不匹配，这是 CLI 的内部缺陷」（14002 的 hint）。
    // 这个方向的错误**特别有害**：14001 是 appKey 没配对，Agent 若被告知
    // "CLI 内部缺陷"，会去报告/排查代码，而正确动作是检查环境变量。
    const e = classify(14001, 'appKey error')
    expect(e).toMatchObject({ kind: 'auth', retryable: false })
    expect(e.hint).toMatch(/APP_KEY|appKey/)
    // 反向：14002 的 hint 必须**不含** appKey —— 否则两者又串了
    expect(classify(14002, 'Bad checksum').hint).not.toMatch(/APP_KEY/)
  })

  it('401/403 的 hint 指向「凭证或权限」，不能落穿到 14001 的 appKey 提示', () => {
    // ⚠️ 语句删除变异扫描确认：删掉 `case '401': case '403':` 的 return，全量测试全绿。
    // 它紧邻 `case '14001'`，两者 kind 都是 `'auth'`、retryable 都是 false，
    // 只断言 kind 的测试看不出差别。可观测后果（实测）：
    //   删掉后 401/403 的 hint 从「请求被拒绝（HTTP 401）—— 凭证或权限问题，重试无用」
    //   变成「请检查 QIYU_APP_KEY 是否正确」（14001 的 hint）。
    // 后果：HTTP 401/403 是**网关拒绝**（凭证过期 / 无权限），却被告知去改 appKey 环境变量。
    //
    // ⚠️ http.test.ts 里那条 `expect(err.hint).toMatch(/凭证|权限/)` **覆盖不到这里** ——
    // 它走的是 http.ts 的"响应体非 JSON"分支（自带字面量 hint），与本条走的
    // "Spring JSON body → classify()" 是两套代码。两条路径都要各自钉住。
    for (const s of ['401', '403']) {
      const e = classify(s, 'Unauthorized')
      expect(e, `HTTP ${s}`).toMatchObject({ kind: 'auth', retryable: false })
      expect(e.hint, `HTTP ${s} 必须指向凭证/权限`).toMatch(/凭证|权限/)
      expect(e.hint, `HTTP ${s} 不得落穿到 14001 的 appKey 提示`).not.toMatch(/APP_KEY|appKey/)
    }
  })

  // —— 14100 / 14106 / 14403：三个各自有专属 kind 的码 ——
  it('14100 判为参数错误，并指向 status=1 这个可执行动作', () => {
    // 设计稿 §6.2：ticket.list 的 staffId 必须是在职客服，
    // status=2/3 各 14/14 返回它。约 55% 的客服会撞上 —— 若只说"参数错误"，
    // Agent 不知道要按 status=1 过滤。
    const e = classify(14100, 'Bad holder staff id')
    expect(e).toMatchObject({ kind: 'param', retryable: false })
    expect(e.hint).toMatch(/status=1/)
  })

  it('14106 判为参数错误，指向 worksheet', () => {
    // 设计稿 §9.0：ticket.new.detail / ticket.log 的失败路径。
    //
    // ⚠️ 必须断言 hint —— 测试名承诺「指向 worksheet」，但此前只断言 kind/retryable。
    // 把 hint 换成任意别的文案（甚至删掉）测试照样全绿 —— 属"测试名比断言强"。
    // 与 `14100` 那条同源（它已断言 `hint).toMatch(/status=1/)`），本条此前漏了。
    // ⚠️ 注意本条**不是**落穿缺口：14106 的下一 case 是 14403（kind 为 `pending`），
    // 与 14106 的 `param` 不同，所以删掉 return 会被 kind 断言抓到。
    // 它是纯粹的"名称强于断言"——hint 是 Agent 唯一能据此知道"该去查工单还是改参数"的字段。
    const e = classify(14106, 'Invalid worksheet')
    expect(e).toMatchObject({ kind: 'param', retryable: false })
    expect(e.hint).toMatch(/worksheet/)
  })

  it('14403 判为 pending 且可重试 —— 它是中间态，不是故障', () => {
    // 设计稿 §7.5：会话导出 check 未完成时返回它。判成 unknown/不可重试
    // 会让 Agent 放弃一个仍在正常进行的导出。
    expect(classify(14403, 'Wait...')).toMatchObject({
      kind: 'pending', retryable: true,
    })
  })

  it('404 判为 route_not_found 且不可重试 —— 两种 404 形态共用同一个 kind', () => {
    // 设计稿 §4.3：`/openapi/*` 回 Spring JSON、`/platform/api/*` 回 nginx HTML。
    // 形态不同、事实相同（路由不存在 = 注册表路径写错），必须归到同一个 kind，
    // 否则 Agent 对同一故障要写两套处理。
    expect(classify(404, 'Not Found')).toMatchObject({
      kind: 'route_not_found', retryable: false,
    })
    expect(classify('404', '')).toMatchObject({ kind: 'route_not_found', retryable: false })
  })

  it('Spring 错误体的 5xx/401/403 不被当成 unknown —— 瞬时故障必须可重试', () => {
    // ⚠️ Spring Boot 的 BasicErrorController 对**所有**错误状态码都返回同一个
    // 5 键 body（{timestamp,status,error,message,path}），而 envelope.ts 只按
    // body 形状识别、不区分 status 值 —— 所以 500/503 会带着 `code:'500'` 之类
    // 到达 classify。若没有这几个分支，它们会落到 default → unknown/不可重试，
    // 一个瞬时的 5xx 会被 Agent 直接放弃。
    for (const s of ['429', '500', '502', '503', '504']) {
      expect(classify(s, 'Internal Server Error'), `HTTP ${s}`)
        .toMatchObject({ kind: 'network', retryable: true })
    }
    for (const s of ['401', '403']) {
      expect(classify(s, 'Unauthorized'), `HTTP ${s}`)
        .toMatchObject({ kind: 'auth', retryable: false })
    }
    // 反向：不能把所有 4xx 都当 auth —— 404 仍是 route_not_found
    expect(classify('404', '')).toMatchObject({ kind: 'route_not_found' })
  })

  it('未知错误码不崩溃，归入 unknown', () => {
    expect(classify(99999, '???')).toMatchObject({ kind: 'unknown' })
  })
})

describe('内部信息脱敏', () => {
  it('抹掉 Java 包路径与类名，只保留人类可读的部分', () => {
    const msg = 'Cannot invoke "example.internal.pkg.SomeClass.getId()" because "staff" is null'
    const out = redactInternal(msg)
    // 关键：前缀必须留下（分类器靠它识别 NPE），包路径必须消失
    expect(out).toContain('Cannot invoke')
    expect(out).not.toContain('SomeClass')
    expect(out).not.toContain('example.internal')
  })

  it('抹掉 32 位十六进制的内部 hint', () => {
    // 这串必须是**恰好 32 位** —— 少一位正则就匹配不上，
    // 而测试若用 31 位字符串，会断言一个永远为真的"脱敏成功"。
    const hint = 'a'.repeat(32)
    expect(redactInternal(`Unexpected internal error, hint: ${hint}`)).not.toContain(hint)
  })

  it('不误伤短十六进制串与正常业务文本', () => {
    expect(redactInternal('user not in queue')).toBe('user not in queue')
    expect(redactInternal('deadbeef')).toBe('deadbeef')
  })

  it('超长无分隔 token 不会让脱敏回溯爆炸（ReDoS 防护）', () => {
    // ⚠️ 这是**唯一**能钉住这条正则的测试 —— ReDoS 不改变输出，只改变耗时，
    // 所以只能断言**上界**。2026-10-05 实测：`[\w$]*` 版本处理 20 万字符的
    // 连续 token 要 **54 秒**（单次 classify 27 秒）；加 `{0,64}` 上界后 77ms。
    // 若有人把上界去掉（"反正真实报文不会有 20 万字符的 token"），这条会超时失败。
    // 为什么它真实可达：`messageText` 直接取服务端 JSON 的 `message`/`error`
    // （见 envelope.ts），是**不可信输入** —— 网关或异常上游返回一个长 token 即可。
    const pathological = 'x'.repeat(200_000)
    const t0 = Date.now()
    redactInternal(pathological)
    const elapsed = Date.now() - t0
    // 上界给得宽松（真实 77ms，阈值 3 秒）—— 只为抓"指数级"回归，不追求精确计时。
    expect(elapsed, `超长 token 脱敏耗时 ${elapsed}ms，疑似正则回溯爆炸`).toBeLessThan(3000)
  })
})

describe('ErrorKind 闭集（E 组扩展）', () => {
  it("'query_timeout' 是合法 kind（只读查询超时，退出码 1）", () => {
    // 编译期检查：这行赋不进 ErrorKind 就说明联合类型没扩展（E spec §十一）。
    // ⚠️ 它靠 `npm run typecheck`（tsc -p tsconfig.test.json，include 含 tests/）兜底，
    // CI 在 `npm test` 之前执行；vitest 只转译不做类型检查（CodeRabbit 终审 minor 的
    // 前提已核实成立：删掉联合成员后 typecheck 在本文件报 TS2322）。
    const k: ErrorKind = 'query_timeout'
    // 运行时事实（不是自比较）：该 kind 真的走 exitCodeFor 的 business 分支 → 退出码 1，
    // 且信封里保留 code/kind。联合成员加了却漏配分派时这里会红。
    expect(fail({ code: k, kind: k, retryable: false, message: '超时' })).toBe(1)
    expect(JSON.parse(out)).toMatchObject({
      ok: false, error: { code: 'query_timeout', kind: 'query_timeout', retryable: false },
    })
  })
})

describe('ERROR_KINDS 运行时常量', () => {
  // 全量清单（20 个，当前版本真正会产出的 kind）—— F 子项目 Task 4。
  // ⚠️ 必须 `as const`：元素类型要是**字面量联合**，下方
  // `Exclude<ErrorKind, (typeof ALL)[number]>` 才可能非空（标注成 `readonly string[]`
  // 会让它恒为 `never`，编译期护栏变成空转）。顺序与 `errors.ts` 的声明顺序一致。
  const ALL = [
    'auth', 'auth_missing', 'bad_time', 'param', 'rate_limit', 'module_offline',
    'window_too_large', 'window_misaligned', 'not_in_queue', 'pending',
    'route_not_found', 'internal', 'network', 'usage', 'unknown',
    'needs_confirmation', 'store_locked', 'store_not_initialized',
    'query_timeout', 'sync_not_run',
  ] as const

  it('包含当前版本全部会产出的 kind', () => {
    for (const k of ALL) {
      expect(ERROR_KINDS, `ERROR_KINDS 少了 ${k}`).toContain(k)
    }
  })

  // ⚠️ `ambiguous` 是路线图 **G2（§9.4 名称解析）** 才交付的 kind，当前版本不存在。
  // `skill check` 拿 ERROR_KINDS 当权威源，所以这里必须反向钉住：
  // 一旦有人把它加进来，这条会红 —— 而那意味着 skill 正文允许引用一个
  // 运行时产不出来的 kind，正是本常量要防的事（设计稿 §11.4）。
  it('不包含尚未实现的 ambiguous（G2 才交付）', () => {
    expect(ERROR_KINDS).not.toContain('ambiguous')
  })

  it('无重复', () => {
    expect(new Set(ERROR_KINDS).size).toBe(ERROR_KINDS.length)
  })

  it('不多不少 —— 与上面那份清单互为闭集', () => {
    expect([...ERROR_KINDS].sort()).toEqual([...ALL].sort())
  })

  // 编译期双向校验（vitest 只转译、不查类型，所以真正的护栏是 `npm run typecheck`）：
  //   · ALL 多出常量里没有的值 → 下方 `satisfies readonly ErrorKind[]` 报 TS1360；
  //   · 常量多出 ALL 里没有的值（有人加 kind 却忘了同步这份清单）→ `Unlisted`
  //     不再是 `never`，`noUnlistedKind: true` 报 TS2322。
  // ⚠️ 这里**不能**写成 `const ks: readonly ErrorKind[] = ERROR_KINDS` ——
  // `ErrorKind` 本身就是从 `ERROR_KINDS` 派生的，那种断言永远为真，
  // 看着像护栏、实际测不到任何漂移（本任务自审时删掉过一次）。
  it('两份清单在类型层面也互为闭集', () => {
    const ks = ALL satisfies readonly ErrorKind[]
    type Unlisted = Exclude<ErrorKind, (typeof ALL)[number]>
    const noUnlistedKind: [Unlisted] extends [never] ? true : never = true
    expect(noUnlistedKind).toBe(true)
    expect(ks.length).toBe(ERROR_KINDS.length)
  })
})
