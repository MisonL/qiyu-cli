// src/core/errors.ts

/**
 * 全部错误 kind 的**单一事实源**（F 子项目 Task 4）。
 *
 * 类型与运行时共用这一份：`ErrorKind` 由它派生，`skill check` 也拿它校验
 * skill 正文里的 `kind: x` 引用是否真实存在（设计稿 §11.4）。
 *
 * 加/删成员只改这里。漏抄的保护分两档，**不是**一律都由 typecheck 兜住
 * （复审 M-2 修正了此处早先的过度承诺）：
 *   · 大多数字面量走 `fail(ErrorInput)`，而 `ErrorInput.kind` 是 `string` ——
 *     这条路径**不**受 `ErrorKind` 约束，漏抄时 typecheck 不会报错；
 *   · 受约束的是 `classify()` 的返回值、`sandboxError(kind: ErrorKind)` 这类，
 *     以及 `tests/core/errors.test.ts` 的 `ALL satisfies readonly ErrorKind[]`。
 * 所以漏抄的最终防线是**测试 + typecheck 一起**，不是 typecheck 单独一条。
 */
export const ERROR_KINDS = [
  'auth',                  // 凭证**无效**（14001/14002/14008/14515）—— 发出去被服务端拒了
  'auth_missing',          // 凭证**根本没配置**（本地就拦下，从未发出请求）—— 设计稿 §9.5
  'bad_time',              // 时间戳超期：core 先自动重签重试；仍失败说明本机时钟真的偏了
  'param',                 // 参数错误，重试无用
  'rate_limit',            // 限流，延迟重试
  'module_offline',        // 模块未开通，永久失败
  'window_too_large',      // 时间跨度超限，调用方需自行切片后重试
  'window_misaligned',     // 时间边界没对齐自然日 —— 切片修不好，必须对齐 endTime
  'not_in_queue',          // 业务态，不是故障
  'pending',               // 异步任务未完成（如会话导出轮询），可重试
  'route_not_found',       // 服务端没有这条路由 —— 注册表的路径写错了，重试无用
  'internal',              // 服务端内部错误，退避重试
  'network',               // 网络层故障
  'usage',                 // 调用方式有误（未知接口 id、--body 不合法），对应退出码 2
  'unknown',
  // `--yes` 门禁拒绝时的 kind —— `api.ts` 的 `fail()` 产出它，
  // 对应 `code: 'confirm_required'`（危险接口未加 --yes），退出码 4
  'needs_confirmation',
  // 存储层（C1）：数据库被写进程持锁（读者退避超限 / 写者立即）—— 退出码 1，可重试
  'store_locked',
  // 存储层（C1）：库不存在 / 缺表 / 依赖缺失 / 非 DuckDB 文件 / 他人库 —— 退出码 1
  'store_not_initialized',
  // 查询层（E）：只读查询超时（conn.interrupt 生效）—— 退出码 1；
  // `output.ts` 的 `exitCodeFor` 不设分支，落 default（EXIT.BUSINESS）
  'query_timeout',
  // 同步层（D）：sync status/verify 尚无成功 run 的证据 —— 退出码 1。
  // 此前只在 `sync.ts` 里以字符串字面量出现、不在本联合里，按 kind 分支的 Agent
  // 会收到一个未在任何类型/文档中出现的值（契约审查 C-03）。
  'sync_not_run',
  // 配置层（G1）：配置文件**含凭证**却权限过宽（group/other 可访问，或父目录
  // 可被整体替换）—— 退出码 1，重试无用，必须由人执行 chmod 收紧密码。
  // ⚠️ 与 `auth_missing` 的区别：那是「没配」，这是「配了但落在不安全的位置」。
  'config_insecure',
] as const

// ⚠️ `sandbox_blocked` / `query_error` 是 **code** 不是 kind：查询层的这两类失败
// 都归 `kind: 'usage'`（退出码 2），见 `src/query/errors.ts` 的分类表。

export type ErrorKind = typeof ERROR_KINDS[number]

export interface QiyuError {
  code: string
  kind: ErrorKind
  retryable: boolean
  message: string   // 已脱敏
  hint?: string
  /**
   * 冷却秒数。**不在这里填** —— 它随接口变化，由调用方按限频表决定。
   *
   * ⚠️ `source` 说明这个秒数**凭什么可信**（2026-10-05 加，取代了早先的布尔
   * `measured`）。四种取值，每种都是"该怎么信它"的答案：
   *   `'observed'` = 限频表里**实测**到的窗口（最可信）；
   *   `'doc'`      = 限频表里来自**厂商文档**的值，**从未实测过**；
   *   `'local'`    = 本地令牌桶**精确算出**的等待（我方自己限的流）——
   *     ⚠️ **交付形态下这个取值不可达**（2026-10-07 补）：CLI 每次 `api call`
   *     是一个**新进程**，桶开局为空、`tryAcquire` 在 `for(;;)` 之外只跑一次，
   *     单次调用撞不上本地桶。它只有**同进程连续多次 `call()`** 才能触发
   *     （单元测试就是这么构造的）。保留取值是因为有存储层/批量命令的计划
   *     会走到它，但**当前 Agent 不会在真实输出里见到 'local'** —— 别把它
   *     当成"实测过的行为"去反推 CLI 有本地限频能力；
   *   `'fallback'` = 接口未登记限频时的**保守兜底 60 秒**，可能短于服务端真实冷却。
   *
   * ⚠️ **为什么不能用一个布尔**：限频表本身就把来源分成 `'doc'` 与 `'observed'`
   * 两类（见 `RateLimit.source`，设计稿 §7.4 要求每行标来源）。早先写成
   * `measured: true/false` 时，**所有**已登记接口都标了 `true` —— 包括 6 条
   * `source: 'doc'`（知识库 `getDetail` 与 5 个写接口，从未被调用过）——
   * 等于把一个文档值谎报成实测值，而 `measured` 存在的唯一目的就是让 Agent
   * 分辨该不该信。设计稿 §11.2 D 按 `retry_after > 60` 分流，兜底值恰是 60、
   * 实测值里也有 60（ipcc 报表），来源不写清 Agent 无从判断。
   */
  retryAfter?: { seconds: number; source: 'observed' | 'doc' | 'local' | 'fallback' }
}

/** 抹掉服务端泄漏的内部实现细节。必须在任何 message 透出前调用。 */
export function redactInternal(message: string): string {
  let out = message
  // Java 包路径 / 类名：三段及以上的点分标识符（com.example.Foo.bar）
  //
  // ⚠️ **`{0,64}` 的上界不是可选的，是 ReDoS 防护**（2026-10-05 实测）。
  // 写成 `[\w$]*` 时外层 `{2,}` 与内层 `*` 在**无分隔符的超长 token** 上回溯爆炸：
  //   20 万字符的连续 `x` → 本次实测 **54 秒**（单次 classify 27 秒）。
  // 而 `message` 是**服务端返回的不可信字段**（`String(o.message ?? o.error ?? '')`），
  // 网关/异常上游返回一个长 token 就会让 CLI 挂死 —— Agent 侧表现为无响应而非报错。
  // 真实形态不受影响：HTML 错误页 45K → 2ms、长 JSON 117K → 2ms（都有分隔符）。
  // 上界 64 对 Java 标识符段绰绰有余（实际段长极少超过 30），不损失任何脱敏能力。
  out = out.replace(/[a-zA-Z_$][\w$]{0,64}(?:\.[a-zA-Z_$][\w$]{0,64}){2,}/g, '<内部类>')
  // 32 位十六进制的内部 hint（每次请求都不同的请求 id，不得外泄）
  out = out.replace(/\b[0-9a-f]{32}\b/g, '<已隐藏>')
  return out
}

const has = (m: string, s: string) => m.includes(s)

/**
 * 按 message 文本分类。code 只是二级索引 ——
 * 设计稿 §4.3 的实测结论：同一个 code 可以承载多种语义，反之同一语义也可跨 code。
 *
 * ⚠️ 这里**不填冷却秒数**。实测冷却随接口变化（报表约 30 秒、ipcc 60 秒、
 * 知识库数分钟），任何写死在这里的秒数对某类接口必然是错的。
 * `retryAfter` 由调用方按 `RATE_LIMITS` 填。
 *
 * ⚠️ **设计稿在限流的 `retryable` 上自相矛盾，本计划取 `true`，理由记在这里。**
 *   · §9.1 的失败示例把 `14009` 写作 `"retryable": false`
 *   · §4.3 的原则却是「凡是 CLI 自己能吸收的错误，都不以 `retryable: true` 的形式
 *     暴露给 Agent」，并把 14003/14500/14501 列为 core 层吸收 —— **14009 不在其中**，
 *     因为 core 吸收不了它（冷却随接口变化，core 不替 Agent 睡）
 *   · §11.2 D「错误处理协议」表按 `retry_after` 分流：「`rate_limit`（retry_after > 60）
 *     → **不要 sleep**，改为查询本地数据库」—— 这句话预设了 `retry_after <= 60`
 *     时**可以** sleep 后重试，也就是 `retryable: true` 的那一支
 *     ⚠️ 这张表**不在 §9.4**（§9.4 是「名称解析」，讲 `--assignee` 的重名歧义）——
 *     它在 §11.2「Skill / 内容」下的 D 表。此前这里误标为 §9.4，已更正。
 * → 两处（§4.3 的原则 + §11.2 D 的分流）支持 `true`，只有 §9.1 的示例写 `false`。
 * 取 `true` 的理由：若为 `false`，§11.2 D 那条「retry_after > 60 才不要 sleep」的
 * 分流就没有意义（既然一律不可重试，就不必按秒数分流了）。**代价**：Agent 若
 * 只看 `retryable` 而不看 `retry_after`，会对一个 180 秒冷却的接口（知识库）
 * 立刻重试、继续吃 14009 —— 所以 `retry_after` **必须**随 `retryable: true` 一起
 * 给出（`call()` 已保证：命中 `rate_limit` 必填 `retryAfter`）。
 */
export function classify(code: number | string, rawMessage: string): QiyuError {
  const raw = rawMessage ?? ''
  const message = redactInternal(raw)
  const base = { code: String(code), message }
  const rate = (): QiyuError => ({ ...base, kind: 'rate_limit', retryable: true })
  const param = (hint?: string): QiyuError => ({ ...base, kind: 'param', retryable: false, hint })

  // —— 限流：先于错误码判断，因为它横跨 14009 / 14500 / 12001 / 14402 / 8011 ——
  if (has(message, '单位时间内请求过于频繁')) return rate()
  if (has(message, 'too frequent')) return rate()
  if (has(message, 'Forbidden For Time rate')) return rate()
  if (has(message, '查询间隔小于一分钟')) return rate()
  // ⚠️ 会话导出创建（8011）的**两种**措辞（设计稿 §4.3）。
  // `Too many running task` 里**没有任何限流词** —— 它既不含 `too frequent`
  // 也不含 `too fast`，只靠 `case '8011'` 命中。若该措辞出现在别的码上就会漏判，
  // 而设计稿反复强调"限流语义横跨多个错误码、必须按文本分派"。
  // `create too fast` 同理（`too fast` ≠ `too frequent`）。
  if (has(message, 'create too fast')) return rate()
  if (has(message, 'Too many running task')) return rate()

  // —— 14501 有两种含义，必须先按 message 区分（设计稿 §6.2）——
  // 跨度问题 → 调用方切片重试；endTime 越界（晚于今天 0:00）→ 必须用纯历史日期。
  // 两者错误码相同、修复方式完全不同；一律当"跨度"会让 Agent 反复重试无效操作。
  if (String(code) === '14501') {
    if (has(message, 'endTime is invalid'))
      return { ...base, kind: 'window_misaligned', retryable: false,
               // ⚠️ 必须是「早于」而不是「不晚于」：实测 `endTime = 今天 0:00` 本身不稳定
               // （有时 200 有时被拒，设计稿 §6.2），贴着等号的写法会把这条不稳定边界
               // 当成安全上界教给 Agent。纯历史日期是唯一可靠做法。
               hint: 'endTime 必须早于今天 00:00（用纯历史日期，不要包含今天的数据）' }
    if (has(message, 'is invalid'))
      return { ...base, kind: 'window_too_large', retryable: false,
               // ⚠️ 不要写"core 会重切" —— 本计划没有自动切片（见「已知缺口」），
               // 那样 Agent 会等一个永远不发生的重试。主用户是 Agent，hint 必须是它能执行的动作。
               //
               // 报文里带着服务端自己的上限（`> 31 is invalid` / `> 365 is invalid`），
               // 所以这里直接把那个数字指出来 —— 比让 Agent 去查注册表更可靠，
               // 因为 `maxWindowDays` 只有已实测的接口才有。
               hint: '时间跨度超出该接口上限。报文里的数字就是上限天数（如 `> 31` 即 31 天），' +
                     '请按它切片后重试；`qiyu api list` 里带 max_window_days 的接口也标了上限' }
    return { ...base, kind: 'unknown', retryable: false }
  }

  // —— 14004 与 14500 一样是多义码（设计稿 §4.3 明确要求分发表）——
  if (String(code) === '14004') {
    if (has(message, '超出按天获取数据的最大时间范围'))
      // 这条措辞来自 robot.statistic.summary：文档写 30 天，实测上限是 31。
      // ⚠️ 报错文本里**不带**数字（与 14501 不同），所以只能给具体值 ——
      // 这个值必须与注册表里该接口的 maxWindowDays 一致，改一处要改两处。
      return { ...base, kind: 'window_too_large', retryable: false,
               hint: '该接口实测上限 31 天（文档写 30，实测 31）。请按 31 天切片后重试' }
    if (has(message, 'range over limit'))
      // ⚠️ 实测（2026-10-01）：`ticket.search` 的跨度硬限是 90 天，而报文里**不带数字**
      // （与 14501 的 `> 31 is invalid` 不同）。只说"缩小窗口"是不可执行的 ——
      // Agent 不知道缩到多少，很可能缩到 89 天再撞一次，或者缩得太小以致漏数据。
      // 必须指向注册表的 max_window_days，那是唯一带准确数字的地方。
      return { ...base, kind: 'window_too_large', retryable: false,
               // ⚠️ hint 里**不得**写「90 天」这种与注册表冲突的数字（2026-10-07 修）：
               // 注册表对 ticket.search 给的是 max_window_days: 31，而旧 hint 先抛出一个
               // 「实测为 90 天」—— Agent 刚被 91 天窗口拒，最自然的修法是退到那个更近的 90 天，
               // 而那正是静默少取约 58 天的路径。上限只有一个权威来源：注册表。
               hint: '时间跨度超出该接口上限。报文里不带数字，' +
                     '请按 `qiyu api list` 里该接口的 max_window_days 切片后重试' }
    return param('服务端拒绝了参数，请核对字段名与类型')
  }

  switch (String(code)) {
    // ⚠️ 设计稿 §4.3 实测**两种 404 形态**，必须归到同一个 kind：
    //   `/openapi/*`  → Spring JSON `{status,timestamp,error,message,path}`（envelope.ts 识别）
    //   `/platform/api/*` → nginx HTML（http.ts 的 res.json() 失败分支识别）
    // 两者是同一个事实（路由不存在 = 注册表路径写错了），不能一个判 route_not_found、
    // 另一个落 unknown —— 那样 Agent 对同一故障要写两套处理。
    case '404':
      return { ...base, kind: 'route_not_found', retryable: false,
               hint: '该接口在服务端不存在。这通常是注册表的路径写错了，请报告此问题；重试无用' }
    // ⚠️ Spring Boot 的 `BasicErrorController` 对**所有**错误状态码都返回同一个
    // 5 键 body（`{timestamp,status,error,message,path}`），而 envelope.ts 只按
    // body 形状识别它、不区分 status 值。因此 401/403/500/503 都会带着
    // `code: '500'` 之类到达这里。若不在这里兜住，它们会落到 `default` → `unknown`
    // 且 `retryable:false` —— 一个瞬时的 5xx 会被 Agent 当成"未知错误"直接放弃。
    // 5xx 是服务端故障（可退避重试），4xx（除已单独处理的 404）是请求侧问题。
    // ⚠️ 这里只列**实测出现过**的四个 5xx（500/502/503/504）+ 429；设计稿 §5.3 的措辞
    // 是「5xx/429」，但 501（未实现）/505（版本不支持）本身非瞬时，纳入重试反而有害。
    // 故本集合是"实测子集"，不是"5xx 全集" —— 执行者若要扩到 501/505，须先确证它们是瞬时的。
    // ⚠️ 这组状态码必须与 http.ts 里 `res.json()` 失败分支的 `transient` 集合**逐字一致**
    // （两处都是 429/500/502/503/504）—— 否则同一个 500 会因代理返回 HTML 还是 Spring JSON
    // 被判成 internal 或 network，取决于代理行为，不是调用方能解释的差异。
    // 401/403 同理，两处都归 `auth`。
    case '429': case '500': case '502': case '503': case '504':
      return { ...base, kind: 'network', retryable: true,
               hint: `服务端/网关瞬时故障（HTTP ${code}），请退避后重试` }
    case '401': case '403':
      return { ...base, kind: 'auth', retryable: false,
               hint: `请求被拒绝（HTTP ${code}）—— 凭证或权限问题，重试无用` }
    case '14001':
      return { ...base, kind: 'auth', retryable: false, hint: '请检查 QIYU_APP_KEY 是否正确' }
    case '14002':
      return { ...base, kind: 'auth', retryable: false, hint: '签名不匹配，这是 CLI 的内部缺陷' }
    case '14003':
      // core 层会**先用新时间戳重签重试一次**，正常情况下 Agent 不会看到这个错误。
      // ⚠️ 但 Agent 能看到它，就说明重签也没救回来 —— 那是**本机时钟真的偏移了**
      // （重签只是重读同一个错误的时钟）。此时 retryable:true 是危险的：
      // Agent 会无限重试一个它自己修不好的东西。必须给出可执行的动作。
      // ⚠️ 必须给出可执行的动作。⚠️ **不能只给 macOS 的命令**（2026-10-06 修）：
      // 此前写的是 `sudo sntp -sS time.apple.com` —— `-sS` 是 macOS 的 sntp 语法、
      // `time.apple.com` 是苹果的 NTP 服务器，而这是个 `npx` 分发的**跨平台** npm 包
      // （全局约束里没有任何平台限定）。在 Linux 容器里（Agent 的常见运行环境）
      // 这条提示会指向一个跑不通或语法不同的命令 —— 与「hint 必须指向可执行的动作」
      // 同一条标准，只是这次错在平台假设。改为按平台给两条，并让 Agent 能自己判断。
      return { ...base, kind: 'bad_time', retryable: false,
               hint: '本机时钟与服务器偏差超过 5 分钟，且重签重试无效。请校对本机时间后重试：' +
                     'macOS `sudo sntp -sS time.apple.com`；Linux `sudo timedatectl set-ntp true`' +
                     '（或 `sudo ntpdate pool.ntp.org`）。校时后原样重跑即可' }
    case '14007':
      // ⚠️ 必须给 hint（2026-10-05 修）。设计稿 §4.3 的补充错误码表记着厂商对该接口
      // `code` 的描述是 "user does not exist or has not applied to connect to an agent"，
      // （⚠️ 该表在 §4.3「错误处理」，不是 §5「接口注册表」—— §5 全节不含 `14007`。）
      // **与实际返回的 message 不一致** —— 而实测对未排队的 uid **每次调用都返回它**。
      // 所以 agent 看到它时最可能犯的错是：① 以为"用户不存在"（描述是这么写的）
      // 于是去删用户或报错说用户没了；② 反复重试（以为偶发）。
      // 正确动作是"该 uid 尚未接入/排队，不是故障"。相邻的 14008/14100/14003
      // 都有具体动作，14007 原先独缺一条 —— 与其同族的"告诉 agent 该做什么"，
      // 唯独这条只给了 kind，agent 只能自己猜（多半猜成 ①）。
      return { ...base, kind: 'not_in_queue', retryable: false,
               hint: '该 uid 未接入/未排队，属于业务状态而非故障 —— 不要重试。' +
                     '注意：厂商对该 code 的描述是"用户不存在"，但**与实际返回的 message 不一致**；' +
                     '实测对未排队的 uid 每次调用都会返回它，因此不能据此判断用户已不存在' }
    case '14008':
      return { ...base, kind: 'auth', retryable: false, hint: '本机 IP 不在七鱼白名单中' }
    case '14009':
    case '12001':
    case '14402':
      return rate()
    case '14515':
      return { ...base, kind: 'auth', retryable: false, hint: '该接口需要单独申请权限' }
    case '14100':
      // 设计稿 §6.2：`ticket.list` 的 staffId 必须是在职客服。
      // 实测 status=2/3 各 14/14 返回它，`0` 与不存在的 id 也返回它。
      // 遍历全部客服同步时约 55% 会撞上 —— 若不给出具体语义，
      // Agent 只会看到"参数错误"而不知道该按 status=1 过滤。
      return { ...base, kind: 'param', retryable: false,
               hint: '该客服不在职（或 id 不存在）。请先按 status=1 过滤在职客服再重试' }
    case '14106':
      // 设计稿 §9.0：`ticket.new.detail` / `ticket.log` 的失败路径返回它。
      return { ...base, kind: 'param', retryable: false,
               hint: '工单不存在或 worksheet 参数无效' }
    case '14403':
      // 设计稿 §7.5：会话导出**轮询未完成**时返回它 —— 这是正常中间态，
      // 不是错误。判成 unknown/不可重试会让 Agent 放弃一个仍在进行的导出。
      return { ...base, kind: 'pending', retryable: true,
               hint: '会话导出任务尚未完成，请稍后再次轮询 check 接口' }
    // —— 补充错误码：官方 10 行错误码表里完全没有它们 ——
    case '8011':
      // ⚠️ 设计稿 §4.3 补充表在 `8011`（会话导出创建）下并列了两种措辞：
      // `create too fast`（§7.5 实测：创建限频每 10 秒 6 次）与 `Too many running task`
      // （§7.5：并发上限/队列积压 —— 阈值高、实测未复现）。**两者都按限流处理是
      // 本计划的判断**（对 Agent 的正确动作相同：退避重试）—— 只认前一种会让
      // Agent 拿到 retryable:false 直接放弃，而它本该退避重试。
      // （⚠️ 2026-10-08 更正：此前写"设计稿实测两种措辞都是限流"，设计稿从未这么说。）
      return rate()
    case '8002':
      return { ...base, kind: 'auth', retryable: false,
               hint: '平台电商接口需要平台版 appKey' }
    case '67406':
      return param('短信接口参数缺失 —— 传空数组也会触发，不只是缺 key')
    case '14200':
      return param('分类接口的 type 取值非法')
    case '14301':
      return param('会话不存在，或模板类型非法')
    case '8012':
      return param('呼叫任务不存在')
    case '67506':
      return param('smstask 一次最多传入 100 个 id')
    case '14500': {
      if (has(message, 'Service Offline'))
        return { ...base, kind: 'module_offline', retryable: false, hint: '该账号未开通此模块' }
      if (has(message, 'Param format error'))
        return param('参数类型错误；重试无用，还会烧掉限流配额')
      if (has(message, 'can not cast to JSONObject'))
        return param('请求体不是合法 JSON')
      // 跨度超限 —— 在 NPE 检查之前（避免被兜底分支误判为内部错误）
      if (has(message, '起止时间') && has(message, '不能超过') && has(message, '天'))
        return { ...base, kind: 'window_too_large', retryable: false,
                 hint: '时间跨度超出该接口上限（如 transferHuman 的 365 天）。请自行切片后重试' }
      // 以 `Cannot invoke "` 前缀为键 —— NPE 措辞不止一种，不能匹配单个类名
      if (has(message, 'Cannot invoke')) return param('缺少必填参数导致的服务端空指针')
      // ⚠️ redactInternal 会把 `java.lang.NullPointerException` 替换成 `<内部类>`，
      // 所以这里必须在 redact 之前检查原始 message（raw）
      if (has(raw, 'NullPointerException')) return param('缺少必填参数导致的服务端空指针')
      // ⚠️ `14500` 下有三种**措辞近似、动作相反**的「内部错误」文本，
      // 必须显式逐个匹配，**不能**依赖它们"恰好大小写不匹配、落到尾部兜底"。
      // 设计稿 §4.3 的分发表把前两种列为可重试：
      //   · 可重试（服务端瞬时故障）—— `Unexpected internal error, hint:`（§4.3）
      //     与 `Internal Error, retry later`（§4.3 分派表，措辞不同、同为可重试）
      //   · 裸 `Internal error` **不在 §4.3 表内** —— 按表体它落入末行
      //     「以上都不匹配 → 退避重试」；本计划**有意偏离**该表、判为不可重试
      //     （⚠️ 2026-10-08 更正：此前把"不可重试"写成了设计稿的规定，实为本计划
      //     的偏离 —— 完整记录见下方「这是本计划对 §4.3 分派表的一次有意偏离」段），
      //     依据是 §6.2 记录的两个来源（`ticket.list` 传 staffId=-1/-99、
      //     空结果集上 `page > 1` —— 都是 Agent 改参数就能解决的）
      //     ⚠️ 此处此前把 transferHuman 的超限窗口列为第三个来源，但 §7.4.1 已显式撤回
      //     "transferHuman 364 天会失败"这一成因，且该接口真正超限时报文带数字、
      //     已被 `起止时间`+`不能超过`+`天` 三词分支接走，不会落到这一支。
      // 这三者只差几个字符。**可重试白名单在前、大小写不敏感兜底在后**：
      // 显式列出两种可重试措辞，再用 `/i` 兜住其余含 "internal error" 的 ——
      // 这样分派**不依赖** `has` 恰好大小写敏感这一巧合（谁把 `has` 改成
      // 大小写不敏感都不会串味），且白名单里的每一行都是承载语义的，
      // 删掉任何一行都会有测试失败。
      //
      // ⚠️ 设计稿在此处**自相矛盾**，本计划按 §4.3 分派表实现，并在此记录争议：
      // §4.3 的 `14500` 分派表说 `Internal Error, retry later` 是「服务端内部错误 → 退避重试」，
      // 但 §9.0 的 `evaluation.setting.get` 条目又记录它是该接口**缺 fromType** 时的返回
      // —— 缺参数重试无用。两处无法同时成立。选择"可重试"的理由：§4.3 是专门的
      // `14500` 分派表（更权威、更具体），且"缺 fromType"只在一个接口上观察到，
      // 不足以推翻它；万一判断错误，代价只是 Agent 多退避重试几次，而非静默失败。
      // （设计稿 §4.3 脚注**曾**把这处争议源误标成 §10.1，该脚注现已自我更正；
      //   实际条目在 **§9.0 信封特例**，§10.1 是"增量同步"、全文不含
      //   `evaluation.setting.get`。）
      if (has(message, 'Unexpected internal error') || has(message, 'retry later'))
        return { ...base, kind: 'internal', retryable: true }
      // ⚠️ 光秃秃的 `Internal error` 是**已知有歧义**的：设计稿记录了**两个**来源、
      // 而 message 逐字相同，无法区分 ——
      //   · `ticket.list` 传 `staffId=-1`/`-99` → **参数错误**（设计稿 §6.2 表设计）
      //   · 空结果集上 `page > 1`（翻页越界）→ **参数错误**（设计稿 §6.2）
      // ⚠️ 此前这里列过第三条"`transferHuman` 用超限窗口"，**已删除**：设计稿
      // §7.4.1 明确**撤回**了早前"transferHuman 在 364 天会失败"的说法
      //（"不存在「边界不稳定」这回事……那是错的"）；实测 `transferHuman` 走精确比较、
      // 在**恰好 365 天**被拒，报文是 `14500 起止时间不能超过365天` —— 那条**带数字**，
      // 已被本文件的 `起止时间`+`不能超过`+`天` 三词分支接走（→ window_too_large），
      // **根本不会落到裸 `Internal error` 这一支**。把它算作本支来源是错的。
      // 两个来源都是 Agent 自己改一改就能解决的，**重试同一个请求永远失败**。
      // 因此这里刻意**不**标 retryable:true —— 设计稿 §4.3 的原则是
      // "凡是 CLI 自己能吸收的错误都不以 retryable:true 暴露"，而这两个连
      // CLI 都吸收不了（它不知道是哪个接口的哪种毛病），更不能让 Agent 去撞。
      //
      // ⚠️ **这是本计划对 §4.3 分派表的一次有意偏离，必须显式记录。**
      // §4.3 的 `14500` 分派表最后一行是「以上都不匹配 → 未知内部错误 → 退避重试」，
      // 按字面，裸 `Internal error` 不匹配前面任何一行（`retry later` 那行要求含
      // `, retry later`，`Unexpected internal error` 那行要求含 `Unexpected`），
      // 应落入该行 → 退避重试。本计划取反方向（不可重试），依据是 §6.2 的两条实测
      // （`staffId=-1`/`-99`、空结果集 `page > 1` 都返回这条文本，都是参数错误）。
      // 仅读 §4.3 的执行者不会预期这个方向 —— 故在此点明：这是设计稿内部
      // §4.3 表体与 §6.2 实测的又一次冲突，本计划择 §6.2，方向偏保守
      // （Agent 少试几次，而非对参数错误白烧限频预算）。若将来实测发现确有
      // 瞬时故障也返回裸 `Internal error`，应改为可重试并同步更新本节与测试。
      if (/internal error/i.test(message)) {
        return { ...base, kind: 'internal', retryable: false,
                 hint: '该措辞有两个已知来源：参数无效（如 ticket.list 的 staffId=-1）、' +
                       '或空结果集上翻页越界（page > 1）。' +
                       '两者都无法靠重试解决，请检查参数（含页码）后重试' }
      }
      return { ...base, kind: 'internal', retryable: true }
    }
    default:
      return { ...base, kind: 'unknown', retryable: false }
  }
}
