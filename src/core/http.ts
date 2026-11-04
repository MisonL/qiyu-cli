// src/core/http.ts
import { signedQuery } from './sign.js'
import { classify, type QiyuError } from './errors.js'
import { normalize } from './envelope.js'
import { TokenBucket, limitFor, registeredRateLimit, type RateLimit } from './ratelimit.js'
import { redact, type Credentials } from './credentials.js'
import type { EndpointSpec } from './registry/index.js'

const BASE = 'https://qiyukf.com'

export interface CallOptions {
  credentials: Credentials
  /**
   * 跳过令牌桶与重试。
   *
   * ⚠️ **本计划只有测试传它**（`api call` 不传）—— 与 `timeoutMs` 同款：
   * 保留是为了让"不重试"可注入，**不要以为 CLI 上有对应开关**。
   * 它的存在有测试价值：三条重试路径（令牌桶 / 网络重试 / 14003 重签）
   * 都靠它独立关闭，才能逐条断言"只发一次请求"。
   */
  noRetry?: boolean
  /**
   * 单次请求的超时（毫秒），默认 30 秒。
   *
   * ⚠️ **这是"每次尝试"的超时，不是整个调用的超时。** 超时被归类为
   * `network`/可重试，所以读接口在最坏情况下会走满重试预算 ——
   * 实测默认值下总耗时可达 3 × 30 秒 + 退避。给危险接口不重试（见网络重试分支），
   * 所以它们最多 30 秒。
   *
   * ⚠️ **本计划没有任何命令传它** —— `api call` 用默认值。保留它是为了
   * 让"超时"是一个可注入的参数（测试与将来的批量命令需要），
   * 但**不要以为 CLI 上有 `--timeout` 参数**：没有，且加了也没人读。
   */
  timeoutMs?: number
  /** 注入时钟，便于测试 */
  now?: () => number
}

export interface CallResult {
  /**
   * ⚠️ **恒为 `true`。** `call()` 对每一个 `ok:false` 的归一化结果都**抛异常**
   * （见函数末尾的 `if (!norm.ok) throw ...`），所以能返回的必是成功。
   *
   * 保留它是因为 `Normalized` 有这个字段、而 `CallResult` 是它的超集 ——
   * 但**不要写 `if (r.ok)` 分支**：那是永真分支，会让人以为 `call()` 存在
   * "返回失败而不是抛异常"的路径。判失败只有一种方式：`try/catch` 捕获
   * 带 `kind` 字段的异常。`notFound` 是另一回事（成功但无数据），见下。
   */
  ok: boolean
  /**
   * ⚠️ **本计划没有任何读取点**（2026-10-05 记）。`CallResult` 是 `Normalized`
   * 的超集，这两个字段是**透传**过来的 —— `call()` 内部读的是归一化结果的
   * `norm.code` / `norm.messageText`（用于分派与限流判定），而**返回给调用方**的
   * 这一份，`api.ts` 的 `callOne` 只读 `r.payload` 与 `r.notFound`。
   *
   * 与 `ok` 同一类：保留是为了让 `CallResult` 与 `Normalized` 形状一致，
   * 不是承诺调用方会用。**不要**据此以为 `api call` 的输出里会带上原始
   * `code`/`message` —— 成功响应只出 `{ok:true, data, meta}`（见设计稿 §9.1），
   * 原始报文不进 stdout。判失败看异常上的 `code`/`kind`（`call()` 抛的是
   * 分类后的 `QiyuError`，那才是 Agent 契约的一部分）。
   */
  code: string
  payload: unknown
  /** 同上：透传自 `Normalized`，本计划无读取点。 */
  messageText: string
  /** 「成功但查无此物」——由注册表的 envelope 形状判定，见 envelope.ts */
  notFound: boolean
}

/**
 * 令牌桶按**路径**缓存，不按 id。
 *
 * ⚠️ 实测限频粒度是按路径的（设计稿 §7.4，183 次探测：同一路径 30 秒内连续调用
 * 必返回 14009，跨不同路径的连续调用全部成功）。设计稿 §5.1 实测**线上**有 6 组 24 个
 * 重复路径（当前骨架里没有，生成脚本补齐后会出现）——
 * 按 id 分桶会让同一路径上的多个 id 各拿一份配额 —— 本地放行数倍流量，
 * 服务端照旧按路径拒绝，Agent 看到的错误反而更难解释。
 */
const buckets = new Map<string, TokenBucket>()

function bucketKey(spec: EndpointSpec): string {
  return spec.path ?? spec.id
}

/**
 * 取该接口的限频行。
 *
 * ⚠️ **桶按 path 缓存，限频行按 id 查** —— 这两者必须靠一条注册表不变量兜住：
 * **同一条路径上的所有 id，限频行必须一致**。
 *
 * 若不一致，桶的窗口就取决于该路径上**谁先被调用**（那一行只在建桶时读一次），
 * 结果顺序敏感。这里刻意不做"遍历所有同路径 id 取最严"——限频表里的 id
 * 大多不在注册表里（注册表目前只有 11 条骨架），遍历不到它们，
 * 那种"取最严"是假的安全感。真正管用的是把不变量测出来（见 registry 测试）。
 */
function limitForSpec(spec: EndpointSpec): RateLimit | null {
  return limitFor(spec.id)
}

/**
 * 解析 HTTP `Retry-After`（RFC 9110）：秒数或 HTTP 日期两种形态；非法/缺失返回 undefined。
 * 日期形态按注入时钟折算成秒（向上取整、不小于 0）——不要把"过去的时间"折成负数。
 */
function parseRetryAfterSeconds(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined
  const t = header.trim()
  // delay-seconds 语法是 1*DIGIT，但 0 秒等于「立刻重试」——在 429 语境下必然再吃限流，
  // 与 malformed 一样退回兜底（0 无法给出有意义的等待建议）。
  if (/^\d+$/.test(t)) { const n = Number(t); return Number.isFinite(n) && n > 0 ? n : undefined }
  // ⚠️ 不能直接 `Date.parse` 任何非数字串（CodeRabbit PR #65 第三轮）：V8 的宽松日期解析
  // 接受 `1.5`（→ 2001 年）、`-1`（→ 2001 年）这类非 HTTP-date 值，折算成"过去"后
  // 被 max(0) 压成 0 秒 —— Agent 会立刻重试、再吃限流。HTTP-date 必然含英文星期/月份名，
  // 用它做形态门（RFC 9110 的三种格式都满足）。
  if (!/[A-Za-z]/.test(t)) return undefined
  const at = Date.parse(t)
  if (Number.isNaN(at)) return undefined
  return Math.max(0, Math.ceil((at - nowMs) / 1000))
}

/**
 * 限流错误的统一装饰：`retry_after` + 来源说明 + 三态 hint。
 * 所有 `kind=rate_limit` 的出口（服务端业务码、HTTP 429 的两种载体）都必须经过这里 ——
 * 否则同一类限流会因载体不同给出不同的等待建议（实测：HTTP 429 曾直接抛出，
 * 从不附 retry_after）。本地令牌桶的 `local_rate_limit` 自带精确等待，不经过这里。
 */
function decorateRateLimit(err: QiyuError, spec: EndpointSpec, serverSeconds?: number): QiyuError {
  // ⚠️ 服务端 `Retry-After` 头优先于本地限频表（CodeRabbit PR #65）：429 同时带
  // `Retry-After: 3600` 时，限频表的 20/30 秒会诱导 Agent 提前重试、继续吃限流。
  if (serverSeconds !== undefined) {
    err.retryAfter = { seconds: serverSeconds, source: 'header' }
    err.hint = `服务端通过 Retry-After 指定了等待 ${serverSeconds} 秒（最可信的来源，优先于本地限频表）。` +
      (err.hint ? ` 原分类提示：${err.hint}` : '')
    return err
  }
  const limit = limitForSpec(spec)
  // ⚠️ **必须标出这个数字的来源**（2026-10-05 修）：设计稿 §11.2 D 的分流协议按
  // `retry_after > 60` 二分（`> 60` → 不要 sleep，去查本地库），而**兜底值恰好就是 60**、
  // 实测值里也真的有 60（ipcc 报表）—— 同一个数字承载不同的来源与可信度。
  // ⚠️ 直接用**限频表自己的 `source`**，不要压成一个布尔：表里 6 行是 `'doc'`
  // （文档值、从未实测），压成 `measured: true` 会把它们谎报成实测。
  err.retryAfter = limit
    ? { seconds: limit.windowSeconds, source: limit.source }
    : { seconds: 60, source: 'fallback' }
  // ⚠️ **三态**（2026-11-04 修）：`limitFor` 把「未登记」与「显式 null（实测过、确实
  // 没有限频）」压成同一个 null。旧 hint 一律说「未登记在本地限频表」—— 对显式 null 的
  // 5 个接口（`export.session.check` 等）与 `api schema` 的 `rate_limit` 图例
  // （「null = 实测过，确实没有限频」）直接矛盾：Agent 被告知"没测过"，schema 刚说"测过"。
  const registered = registeredRateLimit(spec.id)
  if (registered === undefined) {
    err.hint = '该接口未登记在本地限频表，下面的等待秒数是**保守兜底值、不是实测冷却**，' +
      '可能短于服务端真实冷却（睡完仍可能再吃限频）。真实配额见接口文档。' +
      (err.hint ? ` 原分类提示：${err.hint}` : '')
  } else if (registered === null) {
    err.hint = '本表对该接口的实测结论是「没有限频」（不是没测过），但服务端本次确实限流 —— ' +
      '以服务端为准；下面的等待秒数是保守兜底值、不是该接口的实测冷却。' +
      (err.hint ? ` 原分类提示：${err.hint}` : '')
  } else if (limit?.source === 'doc') {
    // ⚠️ `doc` 来源也必须说清（2026-10-07 补）：秒数抄自厂商文档、**从未实测过**。
    // 此前它与 `observed` 走同一段代码、hint 一字不差，等于把文档值当实测值报给 Agent。
    err.hint = '下面的等待秒数取自**厂商文档、未对本租户实测**，' +
      '真实冷却可能不同（睡完仍可能再吃限频）。' +
      (err.hint ? ` 原分类提示：${err.hint}` : '')
  }
  return err
}

function bucketFor(spec: EndpointSpec): TokenBucket {
  const key = bucketKey(spec)
  let b = buckets.get(key)
  if (!b) {
    const limit = limitForSpec(spec)
    b = new TokenBucket(limit?.limit ?? null, limit?.windowSeconds ?? null)
    buckets.set(key, b)
  }
  return b
}

/** 仅测试用：清空桶缓存，避免用例之间通过模块级状态互相污染。 */
export function __resetBuckets(): void {
  buckets.clear()
}

/**
 * 把 body 序列化成**将要原样发送**的字符串。
 *
 * ⚠️ 不传 body 与传 `{}` 是**两条不同的服务端代码路径**（实测会泄漏不同的 Java NPE 措辞），
 * 因此这里必须保留 undefined 与 {} 的区别，不能用 falsy 判断合并。
 * ⚠️ 不做 key 排序：排序会让 md5 与"实际发送的字节"脱钩，从而返回 14002。
 */
export function buildBody(body: unknown): string | undefined {
  if (body === undefined) return undefined
  return JSON.stringify(body)
}

/**
 * 网络层错误。**必须脱敏** —— message 是否含 URL 因失败类型而异（连接失败恒为
 * `"fetch failed"`，见本任务测试用例的注释（http.test.ts 的「redact 会擦掉异常
 * message 里的 appKey…」）；构造类异常带完整 URL），与其逐条判断
 * 哪些异常路径会带 URL，不如**无条件** redact —— URL 的查询串就是
 * `appKey=...&time=...&checksum=...`。
 */
function networkError(e: unknown, creds: Credentials): QiyuError {
  const raw = e instanceof Error ? e.message : String(e)
  return {
    code: 'network',
    kind: 'network',
    retryable: true,
    message: redact(raw, creds),
    hint: '网络层故障，可重试',
  }
}

/**
 * undici 在**请求构造阶段**抛出的错误（如给 GET 传 body）与
 * 真正的网络失败都是 `TypeError`，但前者**没有 `cause`**、后者有
 * （`cause` 是底层 socket 错误，形如 `ECONNREFUSED`）。
 *
 * ⚠️ G1 起 `call()` 已在入口拦下 GET + body（直接抛 usage），所以这条分支
 * 不再靠它兜底；保留分类是因为**其他**构造类错误（将来新增的参数拼装缺陷）
 * 仍是本地用法问题，不能报成网络故障。
 *
 * ⚠️ 必须把两者分开：构造错误是**本地用法问题**，重试一万次也一样，
 * 而网络失败必须退避重试。此前 `catch` 一律走 `networkError` —— 实测
 * `GET` + body 会被当成网络故障重试 3 次、返回退出码 3（"网络错误"），
 * Agent 会以为服务端有问题。判据用 `TypeError && !cause` 而不是"有无 cause"，
 * 是为了不误伤 `fetch` 被 mock 成抛普通 `Error` 的测试夹具（那些没有 cause
 * 却代表真实网络故障）。
 *
 * ⚠️ **注释此前把"非法 URL"列为已覆盖用例，那是错的**（Node 24.19.0 实测）：
 * `fetch("http://[::bad")` 抛的 TypeError **带 `cause`**（`cause.code ===
 * 'ERR_INVALID_URL'`），因此本函数对它返回 **false** → 落进 `networkError` →
 * `kind:'network'`、退出码 3、**重试 3 次**，与本函数的分类意图相反。
 * 之所以不修：判据若改成"看 `cause.code` 属不属于 URL 构造类"，就把正确性
 * 绑在 undici 的内部错误码上（稳定性差），而实测生产路径上也构造不出
 * 非法 URL —— `loadSpecs` 校验 `path` 必须以 `/` 开头，URL 由
 * `${BASE}${spec.path}?${q}` 拼成。**这是注释与代码的已知矛盾，不是运行时缺陷**；
 * 若将来真的需要覆盖非法 URL，应显式加判据并加测试，而不是靠改注释掩盖。
 */
function isLocalRequestError(e: unknown): boolean {
  return e instanceof TypeError && !(e as { cause?: unknown }).cause
}

/**
 * 危险接口遇到**网络类**故障时给 Agent 的 hint —— **唯一渲染点**。
 *
 * ⚠️ 三处载体必须共用这一句（2026-11-02 修）：`fetch` 抛错、响应体读取失败、
 * HTTP 5xx/429 的两种载体（网关 HTML / Spring JSON）。此前只有前两处写了对危险接口的
 * 收窄说明，5xx 两处仍报「网关瞬时故障，请退避后重试」—— 同一个 `message.send`
 * 在「连接断了」时被告知"可能已执行，先确认状态"，在「网关 502」时被告知"退避重试"，
 * 而两者**同样可能已经执行**（502/504 恰恰是"上游收到请求后失败"的典型形态）。
 * Agent 照后一句重试，就是一次确认变成两次执行。
 * ⚠️ 逐字复制这条文案到新分支也算缺陷：新分支应当只调用本常量。
 */
const DANGEROUS_NETWORK_HINT =
  '危险接口的网络故障**不会被自动重试** —— 请求可能已被服务端执行，重发会再执行一次。' +
  '请先用只读接口确认当前状态，再决定是否重新调用'

/** 一次网络重试的退避（与 14003 重签重试**不共用**预算，见 call() 里的两个计数器）。 */
const networkBackoffMs = (attempt: number): number => 300 * 2 ** attempt

/** 发起一次已签名调用。业务错误以分类后的异常抛出。 */
export async function call(
  spec: EndpointSpec,
  body: unknown,
  opts: CallOptions,
): Promise<CallResult> {
  const now = opts.now ?? (() => Date.now())
  const creds = opts.credentials
  // ⚠️ GET 请求**绝不带 body**（G1 交付）。此前 `call()` 对任何 method 都发
  // `body: bodyStr`，GET + body 会被 undici 在构造阶段拒掉 —— 分类上兜住了
  // （见 `isLocalRequestError`），但那是一条**错误驱动的**路径：先构造一个非法
  // 请求、再靠异常猜原因。现在在入口就把两件事分开：
  //   · GET + 调用方给了 body → 本地用法错误（静默丢弃会让 Agent 以为 body 生效了）；
  //   · GET 不带 body → 正常发送，签名用 `md5('')`（`bodyStr ?? ''`，与"不传 body
  //     的 POST"同一签名口径；这是 2026-10-02 真实凭证实测的约定）。
  // ⚠️ 当前 154 条注册表里唯一的 GET（`get_token`）是 inbound、不可主动调用，
  // 所以本分支目前只由合成 spec 的测试覆盖 —— 不要把它读成"线上 GET 已实测"。
  if (spec.method === 'GET' && body !== undefined) {
    throw Object.assign(
      new Error(`接口 ${spec.id} 是 GET 接口，不接受请求体`),
      { code: 'usage', kind: 'usage', retryable: false,
        // ⚠️ 不要写「参数走 query 串」—— 本 CLI 没有 GET 的 query 参数通道（评审发现）。
        // 写到不存在的通道上，调用方会去找一个没有的 flag。如实说明现状。
        hint: '本 CLI 目前没有 GET 的 query 参数通道；若该接口需要参数，请去掉 body 后重试' + 
              '（当前注册表里的 GET 接口都不可主动调用，普通调用走不到这里）' },
    )
  }
  // ⚠️ 经上面的守卫，走到这里时 GET 必然无 body —— `buildBody(undefined)`
  // 返回 undefined，fetch 收到的就是 `body: undefined`，签名口径 `md5('')`。
  // 不再写 `GET ? undefined : buildBody(body)`：有守卫在，那是恒等分支。
  const bodyStr = buildBody(body)

  if (!opts.noRetry && !bucketFor(spec).tryAcquire(now())) {
    const waitMs = bucketFor(spec).nextAvailableAt(now())
    throw Object.assign(
      new Error(`接口 ${spec.id} 触发本地限频，还需等待约 ${Math.ceil(waitMs / 1000)} 秒`),
      { code: 'local_rate_limit', kind: 'rate_limit', retryable: true,
        // 本地令牌桶算出的精确等待（不是猜的）—— source: 'local'
        retryAfter: { seconds: Math.ceil(waitMs / 1000), source: 'local' } },
    )
  }

  let signedTime = Math.floor(now() / 1000)
  // 两个独立的预算：网络重试与 14003 重签重试互不挤占。
  // 共用一个计数器会让"先网络失败一次"把重签重试的机会吃掉。
  let networkAttempts = 0
  let resigned = false

  for (;;) {
    // ⚠️ 不传 body 时用 `md5('')` 签名 —— 即 `bodyStr ?? ''`。这是**实测确认**的
    // （2026-10-02，真实凭证）：对 `ticket.search` 不传 body 得到 `code:200`，
    // 若服务端对空 body 另有约定（如跳过 md5），这里会返回 `14002 Bad checksum`。
    // 与传 `{}`（`md5('{}')`）是两条不同路径，两者都实测为 `code:200`。
    const q = signedQuery(creds.appKey, creds.appSecret, bodyStr ?? '', signedTime)
    const url = `${BASE}${spec.path}?${q}`

    let res: Response
    try {
      res = await fetch(url, {
        method: spec.method,
        // 显式设置：undici 默认 text/plain，服务端会按非 JSON 解析
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
        body: bodyStr,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
      })
    } catch (e) {
      // ⚠️ 先分辨"本地构造错误"（如给 GET 传 body）—— 那不是网络故障，
      // 重试无用，且把它报成 network/退出码 3 会让 Agent 误以为是服务端问题。
      // （⚠️ 判据只覆盖"无 cause 的 TypeError"；非法 URL 带 cause，不在此列 —— 见
      // `isLocalRequestError` 的文档注释，那是已知的注释/行为矛盾，生产路径不可达。）
      if (isLocalRequestError(e)) {
        throw Object.assign(
          new Error(`请求构造失败：${redact(e instanceof Error ? e.message : String(e), creds)}`),
          { code: 'usage', kind: 'usage', retryable: false,
            hint: '这是 CLI 侧的请求构造问题（如给 GET 传了 body），重试无用' },
        )
      }
      const err = networkError(e, creds)
      // ⚠️ **危险接口（写/破坏性）绝不自动重发。**
      //
      // 网络错误有两种，从 `fetch` 抛出的异常上**无法区分**：
      //   · 请求根本没发出去（DNS 失败、连接被拒）—— 重发是安全的
      //   · 请求已到达且**已被服务端执行**，断在响应阶段
      //     （实测形态：`SSL: UNEXPECTED_EOF_WHILE_READING`）—— 重发会**再执行一次**
      // 对 `message.send` / `deleteKnowledges` 这类接口，后者意味着
      // **一次 `--yes` 确认发出多条相同的写请求**（实测：一次调用实际发出 2–3 次）。
      // 门禁的语义是"人确认了**一次**这个操作"，自动重发把它变成了 N 次，
      // 而 Agent 无从知道服务端到底执行了几次 —— 这正是 `risk: 'irreversible'`
      // 承诺要避免的事。
      //
      // 读接口没有这个问题（重发最多多读一次），所以只在 `spec.dangerous` 上收窄。
      // 判定放在**抛出之前**：给 Agent 一个可重试的 network 错误，
      // 由它自己决定要不要再确认一次 —— 而不是 CLI 替它做这个决定。
      if (spec.dangerous) {
        throw Object.assign(new Error(err.message), err, { hint: DANGEROUS_NETWORK_HINT })
      }
      if (opts.noRetry || networkAttempts >= 2) throw Object.assign(new Error(err.message), err)
      await sleep(networkBackoffMs(networkAttempts))
      networkAttempts++
      continue
    }

    let raw: unknown
    try {
      raw = await res.json()
    } catch (e) {
      // ⚠️ 走到这里的原因有**两大类**，判据不能只看 HTTP 状态码：
      //
      //  【甲】响应体读取本身失败（不是"body 不是 JSON"）—— `res.json()` 抛
      //       `TimeoutError` / `AbortError` / `TypeError`（undici 的 body 流错误）。
      //       实测（Node 24，本地服务器发一半 body 后挂住 + `timeoutMs` 250ms）：
      //       `res.status` 此时**已经是 200**，而 `await res.json()` 抛 `TimeoutError`。
      //       这类是**瞬时网络故障**，必须 `network`/可重试 —— 否则 Agent 会直接放弃
      //       一个本该退避重试的调用。⚠️ `AbortSignal.timeout` 对"建立连接"与"读取 body"
      //       是**同一个** signal，"接收大结果集时读慢/断流"是常见瞬时故障。
      //  【乙】body 完整到达但不是合法 JSON —— `res.json()` 抛 `SyntaxError`。
      //       这一类才轮到"看状态码"：404/429/5xx 各有含义，其余是服务端畸形响应。
      //
      // 区分依据是**异常类型**，不是响应体内容：`SyntaxError` → 乙；其余 → 甲。
      const isReadFailure = !(e instanceof SyntaxError)
      if (isReadFailure) {
        const err = networkError(e, creds)
        // 与 fetch 抛错那条分支保持同一套语义：危险接口不自动重发，
        // 读接口退避重试（预算与 fetch 失败共用 `networkAttempts`）。
        if (spec.dangerous) {
          throw Object.assign(new Error(err.message), err, { hint: DANGEROUS_NETWORK_HINT })
        }
        if (opts.noRetry || networkAttempts >= 2) throw Object.assign(new Error(err.message), err)
        await sleep(networkBackoffMs(networkAttempts))
        networkAttempts++
        continue
      }
      //
      //  1. 404 —— 路由不存在。设计稿 §4.3 实测**两种 404 形态**：
      //     `/openapi/*` 返回 Spring JSON（那个在 envelope.ts 里处理，不会走到这），
      //     而 `/platform/api/*` 返回 **nginx HTML** —— 它必然走到这里。
      //     这是**注册表 bug**（路径写错了），不是服务端故障。判成 internal 会让
      //     Agent 以为"服务端有缺陷"，而正确动作是报给我们改注册表。
      //  2. 网关/代理故障（429 / 500 / 502 / 503 / 504）—— 瞬时，Agent 必须退避重试；
      //     判成 retryable:false 会让它直接放弃。
      //     ⚠️ 必须与 `errors.ts` 的 `case '429','500','502','503','504'` 用**同一集合** ——
      //     否则同一个 500 会因代理返回 HTML 还是 Spring JSON 而被判成 internal 或 network，
      //     取决于代理行为，不是调用方能解释的差异。
      //  3. 服务端真的返回了非 JSON 的畸形响应 —— 那是内部缺陷，重试无用。
      //
      // 区分（乙类内部的）依据是 HTTP 状态码，不是响应体内容。
      const status = res.status
      if (status === 404) {
        throw Object.assign(
          new Error(`路由不存在（HTTP 404，返回的不是 JSON）—— 注册表里的路径可能有误`),
          { code: '404', kind: 'route_not_found', retryable: false,
            hint: '该接口在服务端不存在。这通常是注册表的路径写错了，请报告此问题；重试无用' },
        )
      }
      // ⚠️ 401/403 与 errors.ts 一致归为 auth（网关 HTML 拒绝页也走这里）
      if (status === 401 || status === 403) {
        throw Object.assign(
          new Error(`请求被拒绝（HTTP ${status}，返回的不是 JSON）`),
          { code: String(status), kind: 'auth', retryable: false,
            hint: `请求被拒绝（HTTP ${status}）—— 凭证或权限问题，重试无用` },
        )
      }
      // ⚠️ 429 先于 transient 处理（2026-11-04 修）：429 是"请求太频繁"，服务端在执行业务
      // 逻辑之前就拒绝了，**没有副作用** —— 与 5xx（可能已执行）的语义相反。若留在这组
      // transient 里，危险接口的 429 会收到 DANGEROUS_NETWORK_HINT（"可能已被执行，重发会
      // 再执行一次"），把确定未执行的限流劝阻成"先确认状态"；且立即退避重试也不符合
      // 限流语义（要按服务端冷却等）。这里抛 kind:rate_limit 并立即经 decorateRateLimit
      // 附上 retry_after 与来源说明（与 Spring JSON 载体走同一条装饰路径）；
      // 不进入下面的自动重试预算 —— 立即重试只会继续吃限流。
      if (status === 429) {
        const e = Object.assign(
          new Error('响应不是合法 JSON（HTTP 429）—— 服务端限流'),
          { code: '429', kind: 'rate_limit', retryable: true,
            hint: '服务端限流（HTTP 429）—— 通常表示请求在执行业务逻辑之前被拒绝，' +
                  '但网关也可能在转发后合成 429：危险接口请先用只读接口确认当前状态再重试；' +
                  '读接口按 retry_after 等待后重试' },
        ) as QiyuError
        throw decorateRateLimit(e, spec, parseRetryAfterSeconds(res.headers.get('retry-after'), now()))
      }
      const transient = status === 500 || status === 502 ||
                        status === 503 || status === 504
      // ⚠️ 危险接口的 5xx 同样可能已经执行（502/504 是"上游收到请求后失败"的典型形态），
      // hint 必须与 fetch-throw / body-read 两支的收窄同源（DANGEROUS_NETWORK_HINT）——
      // 此前这里对 message.send 仍说「请退避后重试」，Agent 照做就是二次执行。
      if (transient && spec.dangerous) {
        throw Object.assign(
          new Error(`网关/服务端故障（HTTP ${status}）—— ` + DANGEROUS_NETWORK_HINT),
          { code: String(status), kind: 'network', retryable: true, hint: DANGEROUS_NETWORK_HINT },
        )
      }
      // ⚠️ 瞬时 5xx 也必须走 core 的重试预算（2026-11-02 修）：此前只有 fetch 抛错与
      // body 读取失败两支会重试，5xx 直接抛出 —— 而 `sync/engine.ts` 的 `isTransient`
      // 正是以「core 已重试 2 次」为前提**不**再重试网络类错误。实测：一次网关 502
      // 只发 1 个请求就把整个窗口打成 fetch_failed gap，那次 502 成了"不可恢复"。
      // 现在四支的预算一致（同一 `networkAttempts`）。
      if (transient && !opts.noRetry && networkAttempts < 2) {
        await sleep(networkBackoffMs(networkAttempts))
        networkAttempts++
        continue
      }
      throw Object.assign(
        new Error(
          `响应不是合法 JSON（HTTP ${status}）` +
            (transient ? '。这通常是网关/代理的瞬时故障，可退避重试' : ''),
        ),
        // 瞬时故障归为 `network`（退出码 3），与 fetch 抛错同一类 ——
        // 两者都是"请求没到达业务层"，而不是"业务层拒绝了请求"。
        transient
          ? { code: String(status), kind: 'network', retryable: true,
              hint: '网关瞬时故障（HTTP 429/5xx），请退避后重试' }
          : { code: String(status), kind: 'internal', retryable: false },
      )
    }

    const norm = normalize(raw, spec.envelope ?? undefined)

    // 时间戳超期：core 层用新时间戳重签重试一次，对 Agent 永不可见。
    // ⚠️ 必须一并检查 `opts.noRetry` —— 否则 `noRetry:true` 下仍会发出第二个
    // 请求，与 `CallOptions.noRetry` 的注释（"跳过令牌桶与重试"）不符。
    // 网络重试那一支已有这个检查，这里漏了会让两条重试路径的语义不一致。
    //
    // ⚠️ **这里对危险接口是安全的，不要加上 `spec.dangerous` 判断** —— 与上面的
    // 网络重试分支不同。`14003` 是服务端在**执行任何逻辑之前**对鉴权时间戳的拒绝，
    // 请求体根本没有被处理；用新时间戳重发一次，服务端只会执行**一次**。
    // 网络故障那一支才是危险的（请求可能已被执行、断在响应阶段）。
    // 两条重试路径的危险性相反，判据必须分开 —— 把它们一起"加固"会让
    // 本机时钟偏移时所有写接口直接失败，而那正是 14003 重签要解决的唯一问题。
    if (norm.code === '14003' && !resigned && !opts.noRetry) {
      // ⚠️ **必须保证严格递增，不能只是重新取一次时钟。**
      // 两次 `Math.floor(now() / 1000)` 之间只隔一次 fetch 往返（通常 < 100ms），
      // 落在同一秒内的概率极高 —— 此时 `time` 不变、md5(body) 不变，
      // 于是 `checksum` 也逐字节相同，**重试等于把刚被拒的请求原样重发**。
      // 设计稿 §4.3 承诺「core 层自动重新签名并重试，对 Agent 永不可见」（逐字引文；
      // "永"的前提 —— 时钟偏移非永久 —— 见复核重点第 4 条的讨论），
      // 若第二次与第一次签名相同，这条承诺实际不成立（本机时钟正常时也一样）。
      // `+ 1` 是最小改动：即使本机时钟完全静止，也保证新签名的 time 不同。
      // 若本机时钟真的偏了 >5 分钟，这次重试仍会被拒，随后落到 `bad_time`
      // （`retryable: false` + 校对时钟的 hint）—— 那正是应有的终态。
      signedTime = Math.max(Math.floor(now() / 1000), signedTime + 1)
      resigned = true
      continue
    }

    if (!norm.ok) {
      const err = classify(norm.code, norm.messageText)
      // ⚠️ 危险接口 + 网络类失败（Spring 错误体里的 429/5xx 会经 classify 归成 network）
      // 必须与另外三支同口径收窄（2026-11-02 修）：Spring JSON 与网关 HTML 是**同一次
      // 故障的两种载体**，此前只有 HTML 载体被收窄，Spring 载体的 `message.send` 仍收到
      // 「服务端/网关瞬时故障，请退避后重试」—— Agent 照着重试就是二次执行。
      // 只改 hint/文案，`retryable` 仍为 true（由 Agent 决定是否重新确认，与其它三支一致）。
      // ⚠️ message 必须放在**最后**并过 `redact`（CodeRabbit PR #58）：`Object.assign`
      // 右覆盖左，写成 `Object.assign(new Error(文案), err)` 会让 `err.message`（含原始
      // 凭证回显）把文案和脱敏结果一起冲掉 —— 与下面通用出口同一条坑。
      if (spec.dangerous && err.kind === 'network') {
        throw Object.assign(new Error(), err, {
          message: redact(err.message, creds), hint: DANGEROUS_NETWORK_HINT,
        })
      }
      // 冷却秒数由**限频表**决定，不由分派器猜 —— 实测冷却随接口变化
      if (err.kind === 'rate_limit') {
        decorateRateLimit(err, spec, parseRetryAfterSeconds(res.headers.get('retry-after'), now()))
      }
      // ⚠️ 瞬时 5xx（Spring JSON 载体）也走 core 的重试预算，与上面四条网络分支
      // 共用 `networkAttempts` —— 同一个 502 不该因为"代理回 HTML 还是 Spring JSON"
      // 而一个重试、一个不重试。危险接口已在上面的分支提前抛出不重试。
      // 429 不在其中：它归 rate_limit（未执行、需按冷却等待），不自动重试。
      if (err.kind === 'network' && !opts.noRetry && networkAttempts < 2) {
        await sleep(networkBackoffMs(networkAttempts))
        networkAttempts++
        continue
      }
      // ⚠️ message 必须放在**最后** —— Object.assign 是右覆盖左，
      // 若写成 Object.assign(new Error(redact(...)), err)，err.message 会把
      // 脱敏结果原样冲掉，脱敏形同虚设。
      throw Object.assign(new Error(), err, { message: redact(err.message, creds) })
    }
    return norm
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
