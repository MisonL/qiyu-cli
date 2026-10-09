// src/core/http.ts
import { signedQuery } from './sign.js'
import { classify, type QiyuError } from './errors.js'
import { normalize } from './envelope.js'
import { TokenBucket, limitFor, type RateLimit } from './ratelimit.js'
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

/** 发起一次已签名调用。业务错误以分类后的异常抛出。 */
export async function call(
  spec: EndpointSpec,
  body: unknown,
  opts: CallOptions,
): Promise<CallResult> {
  const now = opts.now ?? (() => Date.now())
  const creds = opts.credentials
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
        throw Object.assign(new Error(err.message), err, {
          hint: '危险接口的网络故障**不会被自动重试** —— 请求可能已被服务端执行，' +
                '重发会再执行一次。请先用只读接口确认当前状态，再决定是否重新调用',
        })
      }
      if (opts.noRetry || networkAttempts >= 2) throw Object.assign(new Error(err.message), err)
      await sleep(300 * 2 ** networkAttempts)
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
          throw Object.assign(new Error(err.message), err, {
            hint: '危险接口的网络故障**不会被自动重试** —— 请求可能已被服务端执行，' +
                  '重发会再执行一次。请先用只读接口确认当前状态，再决定是否重新调用',
          })
        }
        if (opts.noRetry || networkAttempts >= 2) throw Object.assign(new Error(err.message), err)
        await sleep(300 * 2 ** networkAttempts)
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
      const transient = status === 429 || status === 500 || status === 502 ||
                        status === 503 || status === 504
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
      // 冷却秒数由**限频表**决定，不由分派器猜 —— 实测冷却随接口变化
      const limit = limitForSpec(spec)
      if (err.kind === 'rate_limit') {
        // ⚠️ **必须标出这个数字的来源**（2026-10-05 修）。
        // 此前是裸的 `{ seconds: N }`，Agent 分不出来：设计稿 §11.2 D 的分流协议
        // 按 `retry_after > 60` 二分（`> 60` → 不要 sleep，去查本地库），而**兜底值
        // 恰好就是 60**、实测值里也真的有 60（ipcc 报表）—— 同一个数字承载不同的
        // 来源与可信度，Agent 无从判断该不该信。
        // ⚠️ 直接用**限频表自己的 `source`**，不要压成一个布尔：表里 6 行是
        // `'doc'`（文档值、从未实测），压成 `measured: true` 会把它们谎报成实测。
        err.retryAfter = limit
          ? { seconds: limit.windowSeconds, source: limit.source }
          // 接口没登记限频、但服务端确实报了限流 —— 此时**必须**给个保守兜底，
          // 否则 Agent 收到限流却拿不到任何等待建议，只能立刻重试、继续吃 14009。
          //
          // ⚠️ **兜底值恰好等于设计稿 §11.2 D 的分流阈值（`retry_after > 60`），这是刻意的。**
          // 该协议说：`> 60` → 「**不要 sleep**；改为查询本地数据库」。
          // 本计划**没有 `store/`**（见「已知缺口」），所以"查询本地数据库"这条动作
          // 对本计划的 Agent **不可执行** —— 那等于把 Agent 指向一个不存在的能力。
          // 落在 `<= 60` 这一侧（可以 sleep）才是当前唯一可执行的下一步。
          // → **不要**为了让"未登记接口也走不要 sleep 分支"而把这个值改成 61：
          // 那会把 Agent 送去查一个本计划没有的数据库。等有 `store/` 之后再改，
          // 届时这个兜底值才有第二种正确取法。
          : { seconds: 60, source: 'fallback' }
        // ⚠️ 兜底时**必须**说清它不是实测值，并指明真正的配额要去哪查 ——
        // 否则 Agent 睡满 60 秒就重试，很可能再吃一次 14009。
        if (!limit) {
          err.hint = '该接口未登记在本地限频表，下面的等待秒数是**保守兜底值、不是实测冷却**，' +
            '可能短于服务端真实冷却（睡完仍可能再吃限频）。真实配额见接口文档。' +
            (err.hint ? ` 原分类提示：${err.hint}` : '')
        } else if (limit.source === 'doc') {
          // ⚠️ `doc` 来源也必须说清（2026-10-07 补）。限频表里 6 行是 `source: 'doc'`
          // —— 秒数抄自厂商文档、**从未实测过**。此前它与 `observed` 走同一段代码、
          // hint 一字不差，等于把文档值当实测值报给 Agent —— 与 `source` 存在的
          // 唯一目的（让 Agent 分辨该不该信）相反。
          // `source` 字段本身对 Agent 零解释（见「已知缺口」登记），所以 hint 是
          // 唯一能传达这件事的渠道 —— 与 `fallback` 那条同一条理由。
          err.hint = '下面的等待秒数取自**厂商文档、未对本租户实测**，' +
            '真实冷却可能不同（睡完仍可能再吃限频）。' +
            (err.hint ? ` 原分类提示：${err.hint}` : '')
        }
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
