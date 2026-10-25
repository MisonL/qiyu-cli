// tests/core/http.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { call, buildBody, __resetBuckets } from '../../src/core/http.js'
import { byId } from '../../src/core/registry/index.js'
import { checksum } from '../../src/core/sign.js'
// ⚠️ 仅类型导入：把 catch 到的异常断言成 `Error & Partial<QiyuError>` 时用。
// 不用它就会退化成 `Error | CallResult`（call() 成功时返回后者），
// 于是 `err.message` 报 TS2339 —— tsc 实测踩到过。
import type { QiyuError } from '../../src/core/errors.js'

const CREDS = { appKey: 'k', appSecret: 's' }
let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  // 令牌桶是模块级状态：不清空的话，限频用例会污染其他用例
  __resetBuckets()
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

function ok(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), {
    status: 200, headers: { 'content-type': 'application/json' },
  }))
}

/** 形状 C 的自建夹具：限流报文以纯文本出现在 message 里。 */
const BASE_SAMPLESPEC = {
  method: 'POST' as const, path: '/openapi/x', direction: 'outbound' as const,
  callable: true, dangerous: false, auth: 'checksum' as const, verified: true,
  envelope: 'C' as const,
}

/** 自建 spec 夹具：让限频用例不依赖注册表里恰好有哪几条。 */
const BASE_SPEC = {
  method: 'POST' as const, path: '/openapi/statistic/overview',
  direction: 'outbound' as const, callable: true, dangerous: false,
  auth: 'checksum' as const, verified: true, envelope: 'C' as const,
}

describe('buildBody —— 复核重点 2：不传 body 与传 {} 是两回事', () => {
  it('未提供 body 时返回 undefined，而不是 "{}"', () => {
    expect(buildBody(undefined)).toBeUndefined()
  })

  it('显式传入空对象时序列化为 "{}"', () => {
    expect(buildBody({})).toBe('{}')
  })

  it('body 原样序列化，不做 key 排序（排序会让签名与实际发送的字节不一致）', () => {
    expect(buildBody({ b: 1, a: 2 })).toBe('{"b":1,"a":2}')
  })

  it('判据是 `=== undefined`，不是 falsy —— null/0/""/false 都必须原样发送', () => {
    // ⚠️ 变异测试确认：把 `body === undefined` 改成 `!body`，全量测试仍全绿 ——
    // 因为现存用例只覆盖了 `undefined`、`{}`、`{b:1,a:2}`，而 `{}` 是真值，
    // `!body` 对它为 false，测不出差别。
    // 但 `!body` 会把 **null / 0 / "" / false** 一并当成"没传 body"，
    // 而这些都是**合法的 JSON body**：`--body null`、`--body 0`、`--body ""`
    // 从命令层（`JSON.parse(raw)`）可以直接产生。
    // 后果与"不传 body vs 传 {}"是同一类：静默把用户给的 body 丢掉，
    // 发出一个**没有 body** 的请求，而服务端走的是完全不同的代码路径。
    expect(buildBody(null)).toBe('null')
    expect(buildBody(0)).toBe('0')
    expect(buildBody('')).toBe('""')
    expect(buildBody(false)).toBe('false')
    // 只有 undefined 才是"没传"
    expect(buildBody(undefined)).toBeUndefined()
  })
})

describe('call', () => {
  it('成功时返回归一化载荷', async () => {
    // ticket.search 在注册表里是形状 C —— 载荷是 message 里的 JSON 字符串
    fetchMock.mockReturnValueOnce(ok({ code: 200, message: '{"data":[1]}' }))
    const r = await call(byId('ticket.search'), {}, { credentials: CREDS })
    expect(r.ok).toBe(true)
    expect(r.payload).toEqual({ data: [1] })
  })

  it('查询串里带齐 appKey/time/checksum', async () => {
    fetchMock.mockReturnValueOnce(ok({ code: 200, message: '{"data":null}' }))
    await call(byId('ticket.search'), {}, { credentials: CREDS })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toMatch(/[?&]appKey=k&/)
    expect(url).toMatch(/&time=\d+&/)
    expect(url).toMatch(/&checksum=[0-9a-f]{40}$/)
  })

  it('checksum 是对**实际发送的那个 body 字节**计算的（序列化一次的不变量）', async () => {
    // ⚠️ 这是整个签名方案的**核心不变量**，而上面那条只断言了"URL 里有 checksum"，
    // 没有断言"它对应的是 fetch 收到的那个 body"。若有人把 call() 改成
    // "对一个字符串签名、却发送另一个"（例如两次序列化、或签名前做了 key 排序），
    // 上面的测试**照样通过**，而线上会返回 14002。
    // 这条独立地重算一遍：拿 fetch 实际收到的 body 与 URL 里的 time，算出期望的
    // checksum，与 URL 里的比对。
    const body = { name: '张三', emoji: '🙂', n: 1 }
    fetchMock.mockReturnValueOnce(ok({ code: 200, message: '{"data":null}' }))
    await call(byId('ticket.search'), body, { credentials: CREDS })
    const url = String(fetchMock.mock.calls[0][0])
    const sentBody = fetchMock.mock.calls[0][1].body as string
    const time = Number(/[?&]time=(\d+)&/.exec(url)![1])
    const got = /&checksum=([0-9a-f]{40})$/.exec(url)![1]
    // 用与实际发送完全相同的字节重算 —— 含中文/emoji 才能暴露 UTF-8 编码差异
    expect(sentBody).toBe(JSON.stringify(body))
    expect(got).toBe(checksum(CREDS.appSecret, sentBody, time))
  })

  it('显式设置 Content-Type 为 application/json（undici 默认是 text/plain）', async () => {
    fetchMock.mockReturnValueOnce(ok({ code: 200, message: '{"data":null}' }))
    await call(byId('ticket.search'), { a: 1 }, { credentials: CREDS })
    const init = fetchMock.mock.calls[0][1]
    expect(init.headers['Content-Type']).toBe('application/json')
  })

  it('每次请求都带一个超时 signal（默认 30 秒，可被 timeoutMs 覆盖）', async () => {
    // ⚠️ 没有这条断言，把 `signal:` 整行删掉测试也全绿 —— 而后果是
    // **一次卡住的请求会让 CLI 永久挂起**，Agent 侧表现为超时退出或一直等。
    // 超时是本计划唯一防止"永久挂起"的机制，必须钉住它确实被传下去了。
    //
    // ⚠️ 只断言 `signal instanceof AbortSignal` 是**锁不住超时值**的：
    // `AbortSignal.timeout(30_000)`、`timeout(5)`、`timeout(undefined)` 产出同一类型，
    // 断言无法区分。若实现把 `opts.timeoutMs` 整个忽略、永远写死 30_000，
    // `toBeInstanceOf` 照样全绿 —— 于是 `timeoutMs` 成了没人读的死参数。
    // 所以下面两条都 spy 静态方法、断言**实参**，而不只看类型。
    const spy = vi.spyOn(AbortSignal, 'timeout')
    fetchMock.mockReturnValueOnce(ok({ code: 200, message: '{"data":null}' }))
    await call(byId('ticket.search'), {}, { credentials: CREDS })
    expect(spy, '默认超时必须是 30 秒').toHaveBeenCalledWith(30_000)
    expect(fetchMock.mock.calls[0][1].signal, '每次请求都必须带超时 signal').toBeInstanceOf(AbortSignal)

    // timeoutMs 必须真的被使用（不是被忽略的死参数）
    spy.mockClear()
    fetchMock.mockReturnValueOnce(ok({ code: 200, message: '{"data":null}' }))
    await call(byId('ticket.search'), {}, { credentials: CREDS, timeoutMs: 5_000 })
    expect(spy, 'timeoutMs 覆盖必须真的传进 AbortSignal.timeout').toHaveBeenCalledWith(5_000)
    expect(fetchMock.mock.calls[1][1].signal).toBeInstanceOf(AbortSignal)
    spy.mockRestore()
  })

  it('超时（DOMException TimeoutError）归类为可重试网络错误 —— 它不是本地构造错误', async () => {
    // ⚠️ 这条守的是一个**容易被误判的形状**：`AbortSignal.timeout` 抛的是
    // `DOMException`（`name: 'TimeoutError'`），而 `isLocalRequestError` 判的是
    // `instanceof TypeError`。实测确认 DOMException 不是 TypeError，
    // 所以超时会正确地走 network 分支而不是被当成"本地构造错误"（那可重试性相反）。
    // 若有人把 `isLocalRequestError` 放宽成 `e instanceof Error && !e.cause`
    // （为了兜住别的形状），超时会被误判成用法错误 —— 这条断言会失败。
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    let attempts = 0
    fetchMock.mockImplementation(() => { attempts++; return Promise.reject(timeout) })
    await expect(call(byId('ticket.search'), {}, { credentials: CREDS }))
      .rejects.toMatchObject({ kind: 'network', retryable: true })
    expect(attempts, '读接口的超时应重试').toBe(3)
  })

  it('要求 identity 编码；且代码不读 Content-Length（它可能是压缩前的值）', async () => {
    fetchMock.mockReturnValueOnce(ok({ code: 200, message: '{"data":null}' }))
    await call(byId('ticket.search'), {}, { credentials: CREDS })
    expect(fetchMock.mock.calls[0][1].headers['Accept-Encoding']).toBe('identity')

    // ⚠️ 上面那条只断言了**请求头**。测试名承诺的是两件事，而第二件
    // （"代码不读 Content-Length"）此前**根本没有断言** —— 实测把
    // `http.ts` 改成先读 `res.headers.get('content-length')` 再决定是否解析，
    // 全量测试**全绿**。测试名比测试本身说得更多，正是「契约诚实性」要消灭的形态。
    //
    // 为什么行为断言不够：只要那段代码不改变可观测行为（读出来看一眼再丢掉），
    // 任何夹具都测不出来 —— 而它一旦被用来截断或校验，就会读坏 gzip 数据
    // （undici 透明解压，但**保留压缩后的 Content-Length**）。所以只能扫源码。
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'core', 'http.ts'),
      'utf8',
    )
    // ⚠️ 扫**代码**不扫注释（2026-10-07 改）：裸 `src` 连同注释一起匹配，
    // 于是给 http.ts 加一句说明注释「⚠️ 不要读 Content-Length」就会**假红** ——
    // 而它守的规则（不读该头）恰恰没被违反。扫描器的粒度必须与规则一致：
    // 规则管的是**语句**，注释里提这个词是允许的（甚至是必要的文档）。
    // 判法：逐行看匹配位置之前有没有同行的 `//`；`https://` 里的 `//` 前一个字符
    // 是 `:`，那是 URL 不是注释，不误判。
    // ⚠️ 局限（与 cli.test.ts 那份 inCode 同一处）：真代码里含 `//` 字符串时会被
    // 误判成注释。当前 `content-length` 在 http.ts 里不挨着这种字符串，不触发。
    const inCode = (text: string, re: RegExp): boolean => {
      for (const line of text.split('\n')) {
        const m = line.match(re)
        if (!m || m.index === undefined) continue
        const c = line.indexOf('//')
        if (c < 0 || c > m.index || line[c - 1] === ':') return true
      }
      return false
    }
    expect(inCode(src, /content-length/i),
      'http.ts 的代码不得出现 Content-Length —— 它可能是压缩前的值（注释提及不受限）')
      .toBe(false)
  })

  it('未传 body 时按"无 body 请求"发送，而不是发送 "{}"', async () => {
    fetchMock.mockReturnValueOnce(ok({ code: 200, message: '{"data":null}' }))
    await call(byId('ticket.search'), undefined, { credentials: CREDS })
    expect(fetchMock.mock.calls[0][1].body).toBeUndefined()
  })

  it('业务错误被分类后抛出，且 message 已脱敏', async () => {
    // ⚠️ 夹具特意放了 Java 内部类路径 —— 作者本意就是查脱敏，但此前只断言了
    // kind/retryable，**没有一条 message 断言**。若 `redact(err.message, creds)`
    // 这一步退化成不脱敏或顺序颠倒，本条察觉不到。
    // （凭证维度的脱敏另有专测覆盖，但那是"名字强于断言"之外的另一回事：
    //  本条的名字承诺了 message 脱敏，就该有对应的断言。）
    fetchMock.mockReturnValueOnce(ok({
      code: 14500,
      message: 'Cannot invoke "example.internal.pkg.SomeClass.getId()" because "staff" is null',
    }))
        // ⚠️ 捕获后必须**显式收窄成 Error**：`call()` 成功时返回 `CallResult`，
    // `.catch((e) => e as Error)` 的类型是 `CallResult | Error`，
    // 直接写 `err.message` 会报 TS2339（`message` 不在 `CallResult` 上）——
    // 这是 tsc 实测抓到的，不是假想。
    const thrown = await call(byId('ticket.search'), {}, { credentials: CREDS })
      .then(() => null)
      .catch((e: unknown) => e as Error & Partial<QiyuError>)
    expect(thrown, '本夹具应走业务错误分支').not.toBeNull()
    const err = thrown!
    expect(err).toMatchObject({ kind: 'param', retryable: false })
    // `Cannot invoke` 前缀必须留（错误分类靠它识别缺参 NPE），但内部包名/类名要抹掉
    expect(err.message, '分类依赖的前缀必须保留').toContain('Cannot invoke')
    expect(err.message, 'Java 内部包路径属于实现细节，必须脱敏').not.toContain('example.internal')
  })

  // —— 复核重点 4：时钟偏移 ——
  // ⚠️ 时钟**故意冻结**：这正是生产中最常见的场景 —— 两次取时钟之间只隔一次
  // fetch 往返（< 100ms），几乎必然落在同一秒。此前测试用 `now = () => (t += 5_000)`
  // 让时钟每次前进 5 秒，恰好把这个事实遮住了：那种时钟下 `Math.floor(now()/1000)`
  // 天然递增，即使实现只写 `signedTime = Math.floor(now()/1000)` 也能通过。
  // 冻结时钟才能验证"重签保证 time 严格递增"这条真正的契约。
  it('14003 时用**严格递增**的时间戳重签并重试一次（时钟冻结时也必须变）', async () => {
    const t = 1_700_000_000_000
    const now = () => t                       // 时钟完全静止 —— 最坏情况
    fetchMock
      .mockImplementationOnce(() => ok({ code: 14003, message: 'Bad time' }))
      .mockImplementationOnce(() => ok({ code: 200, message: '{"data":"ok"}' }))

    const r = await call(byId('ticket.search'), {}, { credentials: CREDS, now })
    expect(r.ok).toBe(true)

    const timeOf = (i: number) => Number(new URL(String(fetchMock.mock.calls[i][0])).searchParams.get('time'))
    const checksumOf = (i: number) => new URL(String(fetchMock.mock.calls[i][0])).searchParams.get('checksum')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // 关键断言：即使时钟静止，重签的 time 也必须严格大于首次 —— 否则 checksum
    // 逐字节相同，重试等于原地重发，设计稿"对 Agent 不可见"的承诺不成立。
    expect(timeOf(1), '重签的 time 必须严格递增，不能等于首次').toBe(timeOf(0) + 1)
    expect(checksumOf(1), 'time 变了 checksum 必须跟着变').not.toBe(checksumOf(0))
  })

  it('14003 重试只发生一次，不会无限循环', async () => {
    // ⚠️ 必须用 mockImplementation —— mockReturnValue 会复用同一个 Response，
    // 第二次 res.json() 抛 "Body is unusable"，测试会以 kind:'internal' 失败，
    // 看起来像"重试逻辑坏了"，其实是夹具写错了。
    fetchMock.mockImplementation(() => ok({ code: 14003, message: 'Bad time' }))
    await expect(call(byId('ticket.search'), {}, { credentials: CREDS })).rejects.toMatchObject({
      kind: 'bad_time',
    })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('重签也救不回来时，抛给 Agent 的错误必须是不可重试且带可执行 hint 的', async () => {
    // 这条守的是"Agent 不会无限重试"。core 重签一次仍失败 → 本机时钟真的偏了，
    // 重试一万次也一样。retryable 若为 true，Agent 会照着重试下去。
    fetchMock.mockImplementation(() => ok({ code: 14003, message: 'Bad time' }))
    const err = await call(byId('ticket.search'), {}, { credentials: CREDS }).catch((e) => e)
    expect(err).toMatchObject({ kind: 'bad_time', retryable: false })
    expect(err.hint).toMatch(/时钟/)
  })

  it('网络抖动归类为可重试的网络错误（退出码 3 的来源）', async () => {
    fetchMock.mockRejectedValueOnce(new Error('SSL: UNEXPECTED_EOF_WHILE_READING'))
    await expect(call(byId('ticket.search'), {}, { credentials: CREDS, noRetry: true }))
      .rejects.toMatchObject({ kind: 'network', retryable: true })
  })

  it('本地请求构造错误（undici 的无 cause TypeError）判为用法错误，且不重试', async () => {
    // ⚠️ undici 对"给 GET 传 body"这类构造错误同步抛 TypeError（**无 cause**），
    // 与真正的网络失败（有 cause）同类但性质相反。此前 catch 一律当网络错误 ——
    // 实测会重试 3 次并返回退出码 3（"网络错误"），Agent 会去排查服务端。
    // 这里用真实形状的 TypeError（无 cause）模拟。
    const local = new TypeError('Request with GET/HEAD method cannot have body.')
    let attempts = 0
    fetchMock.mockImplementation(() => { attempts++; return Promise.reject(local) })
    await expect(call(byId('ticket.search'), {}, { credentials: CREDS }))
      .rejects.toMatchObject({ kind: 'usage', retryable: false })
    expect(attempts, '构造错误不该被重试').toBe(1)
  })

  it('noRetry 下 14003 不再重签重试 —— 与"跳过令牌桶与重试"的语义一致', async () => {
    // ⚠️ 网络重试那一支有 opts.noRetry 检查，14003 重签这一支此前漏了 ——
    // 实测 noRetry:true 时仍会发出第二个请求。两条重试路径的语义必须一致。
    let attempts = 0
    fetchMock.mockImplementation(() => {
      attempts++
      return Promise.resolve(new Response(JSON.stringify({ code: 14003, message: 'Bad time' }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    await expect(call(byId('ticket.search'), {}, { credentials: CREDS, noRetry: true }))
      .rejects.toMatchObject({ kind: 'bad_time' })
    expect(attempts, 'noRetry 下只该发一次请求').toBe(1)
  })

  it('危险接口的 14003 仍然重签重试 —— 它与网络重试的危险性相反', async () => {
    // ⚠️ 这条守的是"不要把 dangerous 的收窄误加到 14003 分支上"。
    // 两条重试路径看起来都是"重发请求"，但：
    //   · 14003 是服务端在**执行任何逻辑之前**拒绝鉴权时间戳 —— 重发只会执行一次
    //   · 网络故障可能发生在**执行之后**（断在响应阶段）—— 重发会再执行一次
    // 若有人"顺手加固"给 14003 也加上 dangerous 判断，本机时钟一偏移，
    // 所有写接口就全部失败 —— 而那正是 14003 重签唯一要解决的问题。
    // 服务端已用 14003 明确拒绝了请求，所以这里重发是安全的。
    let attempts = 0
    fetchMock.mockImplementation(() => {
      attempts++
      if (attempts === 1) {
        return Promise.resolve(new Response(JSON.stringify({ code: 14003, message: 'Bad time' }),
          { status: 200, headers: { 'content-type': 'application/json' } }))
      }
      return Promise.resolve(new Response(JSON.stringify({ code: 200, data: {} }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    const r = await call(byId('message.send'), { uid: 1 }, { credentials: CREDS })
    expect(r.ok, '危险接口也应能从 14003 自动恢复').toBe(true)
    expect(attempts, '14003 重签应发两次').toBe(2)
  })

  it('call() 的失败一律抛异常，绝不返回 ok:false —— 上面那些 r.ok 断言都是永真的', async () => {
    // ⚠️ 这条钉住一个**容易被误读的契约**：`CallResult.ok` 恒为 true，
    // 因为每一个 `ok:false` 的归一化结果都在 `call()` 末尾被抛成异常了。
    // 上面几条用例里的 `expect(r.ok).toBe(true)` 因此是**永真断言** ——
    // 它们不是在验证成功，只是在读取一个常量。真正的成功判据是
    // "`await` 没有抛"，失败判据是 "catch 到的异常带 `kind` 字段"。
    //
    // 为什么值得一条专门的测试：若有人日后改成"失败也返回 ok:false"，
    // 那么 `api.ts` 里 `ok(r.payload, ...)` 会把一个失败的 payload 当成功输出 ——
    // 而现有的每一条 `r.ok` 断言都不会失败，因为**成功的用例照样是 true**。
    // 这条用"失败必须抛"的反向断言把这个歧义钉死。
    const failing = [
      { code: 14500, message: 'Param format error,please check' },  // 业务错误
      { code: 200, message: 'not json at all' },                    // 形状 C 解析失败
    ]
    for (const body of failing) {
      fetchMock.mockImplementationOnce(() => ok(body))
      await expect(
        call(byId('ticket.search'), {}, { credentials: CREDS, noRetry: true }),
        `${JSON.stringify(body)} 应抛异常，而不是返回 ok:false`,
      ).rejects.toMatchObject({ kind: expect.any(String) })
    }
  })

  it('网关故障（429/500/502/503/504 返回 HTML）归类为可重试，而不是永久失败', async () => {
    // 实测：网关返回 HTML 错误页时，res.json() 抛错。原先一律判 internal +
    // retryable:false —— Agent 会直接放弃，但这是**瞬时**故障，本该退避重试。
    //
    // ⚠️ 这五个码必须与 `errors.ts` 的 `classify` 瞬时集**逐字一致**
    // （两处都是 429/500/502/503/504，见 errors.ts 那条 `for (const s of [...])`）——
    // 否则同一个 500 会因"代理返回 HTML"（走这里）还是"Spring JSON"（走 classify）
    // 而落到不同分支。此前这里**漏了 500**：把 http.ts 的 `status === 500 ||` 删掉，
    // 全量测试仍全绿，而 500 会从"可重试的网络故障"退化为"不可重试的内部错误"，
    // Agent 直接放弃 —— 正是本用例声称要防的那件事。改一处必须改两处。
    for (const status of [429, 500, 502, 503, 504]) {
      fetchMock.mockImplementationOnce(() => Promise.resolve(
        new Response('<html><body>Bad Gateway</body></html>',
          { status, headers: { 'content-type': 'text/html' } })))
      await expect(call(byId('ticket.search'), {}, { credentials: CREDS, noRetry: true }))
        .rejects.toMatchObject({ kind: 'network', retryable: true })
    }
  })

  it('404 且响应不是 JSON（nginx HTML）→ route_not_found，不是 internal', async () => {
    // ⚠️ 这条分支此前**没有测试** —— 变异测试确认：把 `if (status === 404)` 改成
    // `if (false)`，全量测试全绿。上面那条网关用例虽然也覆盖了 5 个瞬时码
    // （429/500/502/503/504），但 404 走的是**另一条**分支
    // （route_not_found 而不是 network）—— 两条分支的 kind、retryable、hint 全不同。
    //
    // 设计稿 §4.3 实测两种 404 形态：`/openapi/*` 回 Spring JSON（在 envelope.ts 里
    // 识别），`/platform/api/*` 回 **nginx HTML** —— 后者必然走到这里。
    // 判成 internal 会让 Agent 以为"服务端有缺陷"，而正确动作是**报告注册表路径写错了**。
    fetchMock.mockImplementationOnce(() => Promise.resolve(
      new Response('<html><head><title>404 Not Found</title></head></html>',
        { status: 404, headers: { 'content-type': 'text/html' } })))
    const err = await call(byId('ticket.search'), {}, { credentials: CREDS, noRetry: true })
      .catch((e) => e)
    expect(err).toMatchObject({ kind: 'route_not_found', retryable: false })
    // hint 必须指向"注册表路径写错了"这个可执行结论，而不是泛泛的"服务端错误"
    expect(err.hint).toMatch(/路径|注册表/)
  })

  it('401/403 且响应不是 JSON（网关 HTML 拒绝页）→ auth，不是 internal', async () => {
    // ⚠️ 这条分支此前**没有测试** —— 变异测试确认：把
    // `if (status === 401 || status === 403)` 改成 `if (false)`，全量测试全绿。
    // 上面那条网关用例覆盖 429/500/502/503/504（五个瞬时码），404 是**另一条**分支，
    // 而 401/403 走的是**第三条**（auth 而不是 network 或 route_not_found）。
    //
    // 为什么它和 gateway 那些必须分开：401/403 落在 `transient` 判定**之外**，
    // 所以兜底分支会把它们判成 `kind: 'internal'`。实测行为差异：
    //   正确 → { kind: 'auth',     retryable: false }
    //   变异 → { kind: 'internal', retryable: false }
    // 两者 `retryable` 与**退出码**都相同（`exitCodeFor` 的 switch 里没有 `auth`
    // 和 `internal`，两者都落 `default` → `EXIT.BUSINESS` = 1），所以差别**只在**
    // `kind` 字段本身，以及给 Agent 的 `hint`（后者说"网关瞬时故障可重试"，
    // 那是**误导**——凭证问题退避一万次也一样）。对只看退出码的调用方不可见，
    // 但 Agent 读的是 JSON 里的 `kind` 和 `hint`，那才是它做下一步判断的依据。
    //
    // 与 errors.ts 的一致性：Spring 错误体里的 `'401'`/`'403'`（body 是 JSON 时）
    // 也归 `auth`（见 errors.test.ts）。两处是**不同代码路径**——一条看 body 里的
    // code，一条看 HTTP 状态码，且只在 body 非 JSON 时才走到后者 —— 各需各的测试。
    for (const status of [401, 403]) {
      fetchMock.mockImplementationOnce(() => Promise.resolve(
        new Response(`<html><head><title>${status}</title></head></html>`,
          { status, headers: { 'content-type': 'text/html' } })))
      const err = await call(byId('ticket.search'), {}, { credentials: CREDS, noRetry: true })
        .catch((e) => e)
      // 断言到具体值：写 `not.toBe('internal')` 的话，将来若 kind 改成第三个
      // 无关值，这条测试照样通过 —— 那又是一句比实现更强的断言。
      expect(err.kind, `HTTP ${status} 必须判为 auth，不能落进 internal 兜底`).toBe('auth')
      expect(err.code).toBe(String(status))
      expect(err.retryable, '凭证问题重试无用').toBe(false)
      // hint 必须指向"换凭证/查权限"，不能复用 429/5xx 那句"网关瞬时故障"
      expect(err.hint).toMatch(/凭证|权限/)
    }
  })

  it('服务端返回非 JSON 但状态码是 200 —— 那是真缺陷，不可重试', async () => {
    // 反向：**乙类**（body 完整但不是 JSON）的区分依据是 HTTP 状态码。
    // 200 + 非 JSON 意味着服务端真的返回了畸形响应，重试一万次也一样。
    fetchMock.mockImplementationOnce(() => Promise.resolve(
      new Response('not json at all', { status: 200, headers: { 'content-type': 'text/plain' } })))
    await expect(call(byId('ticket.search'), {}, { credentials: CREDS, noRetry: true }))
      .rejects.toMatchObject({ kind: 'internal', retryable: false })
  })

  it('响应头已到、但 body 读取失败（超时/中断）→ network 可重试，不是 internal', async () => {
    // ⚠️ 这条守的是**甲类**：`res.json()` 抛的不是 `SyntaxError`，而是 body 流错误
    // （`TimeoutError`/`AbortError`/`TypeError`）。实测（Node 24，本地服务器发一半
    // body 后挂住 + timeoutMs 250ms）：**`res.status` 此时已经是 200**，而
    // `await res.json()` 抛 `TimeoutError`。若判据只看状态码，200 会落进 `else`
    // 被判成 `internal/retryable:false` —— **一个瞬时的 body 读取故障被报成
    // "服务端有缺陷，重试无用"**，Agent 会直接放弃。
    //
    // 这尤其重要，因为 `AbortSignal.timeout` 对"建连"与"读 body"是**同一个** signal，
    // 而"接收大结果集时读慢/断流"正是 Agent 最常见的场景。
    // 判据是**异常类型**：`SyntaxError` → 乙类（看状态码）；其余 → 甲类（可重试网络错误）。
    const bodyReadError = new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    // 用一个 status=200、json() 直接抛 TimeoutError 的假 Response
    const fakeRes = {
      status: 200,
      json: () => Promise.reject(bodyReadError),
    } as unknown as Response
    let attempts = 0
    fetchMock.mockImplementation(() => { attempts++; return Promise.resolve(fakeRes) })
    await expect(call(byId('ticket.search'), {}, { credentials: CREDS }))
      .rejects.toMatchObject({ kind: 'network', retryable: true })
    // 读接口必须真的重试（与 fetch 抛错那条分支同样走满预算）
    expect(attempts, 'body 读取失败也必须走网络重试预算').toBe(3)
  })

  it('body 读取失败对**危险**接口不自动重发 —— 与 fetch 抛错同一收窄', async () => {
    // 与上面那条配对：读失败也属于"请求可能已被服务端执行"，危险接口不得自动重发。
    const fakeRes = {
      status: 200,
      json: () => Promise.reject(new DOMException('aborted', 'AbortError')),
    } as unknown as Response
    let attempts = 0
    fetchMock.mockImplementation(() => { attempts++; return Promise.resolve(fakeRes) })
    await expect(call(byId('message.send'), {}, { credentials: CREDS }))
      .rejects.toMatchObject({ kind: 'network', retryable: true })
    expect(attempts, '危险接口的 body 读取失败不得自动重发').toBe(1)
  })

  // —— 凭证绝不能出现在任何输出中（全局约束）——
  it('redact 会擦掉异常 message 里的 appKey、编码后的 appKey、以及 checksum', async () => {
    // ⚠️ **这条测试的名字此前是错的**：原名「网络错误的 message 里不会残留 appKey ——
    // fetch 的异常会带完整 URL」，前提"fetch 的异常会带完整 URL"**不成立**。
    // Node 24.19.0 实测：真实网络失败（连接被拒/DNS 失败/SSL 中断）抛出的 message
    // 恒为字面量 `"fetch failed"`，URL 在 `e.cause` 里（也不含 URL）；只有**可解析
    // 失败**的 URL 才把 URL 写进 message，而那条带 `cause`、走 `networkError`，
    // 与这里构造的形态不同。所以本用例证明的是 **redact 本身**，不是某条真实路径 ——
    // 原名属"测试因错误的理由通过"。改名后名实相符。
    //
    // ⚠️ 夹具用**含 URL 保留字符**的凭证，且 URL 由真实编码形式拼成 ——
    // 因为 `signedQuery` 对 appKey 做 `encodeURIComponent`，fetch 失败时 message 里
    // 出现的是编码形式（`appKey=a%2Bb`），而 redact 若只用原始值 split/join 会漏掉它。
    // 这条正是那个编码分支的回归测试（单字符 `k` 的旧夹具测不出它）。
    const creds = { appKey: 'a+b', appSecret: 's' }
    fetchMock.mockRejectedValueOnce(
      new Error('fetch failed: https://qiyukf.com/openapi/v2/ticket/search' +
                '?appKey=a%2Bb&time=1&checksum=' + 'deadbeef'.repeat(5)),
    )
    const err = await call(byId('ticket.search'), {}, { credentials: creds, noRetry: true })
      .catch((e) => e)
    expect(err.message).not.toContain('a%2Bb')   // 编码后的 appKey
    expect(err.message).not.toContain('a+b')      // 原始 appKey
    expect(err.message).not.toContain('deadbeefdeadbeef')  // checksum 的前缀
    // ⚠️ 必须**同时**断言三者 —— 复核重点 8 要求 appKey 与 checksum 都抹，
    // 只断言 appKey 的话，删掉 checksum 那行正则测试照样通过。
  })

  it('危险接口的网络故障不自动重发 —— 一次 --yes 不能变成多次执行', async () => {
    // ⚠️ 网络错误有两种，从 fetch 的异常上**无法区分**：
    //   · 请求没发出去（DNS 失败）—— 重发安全
    //   · 请求已到达且**已被执行**，断在响应阶段（实测形态 SSL EOF）—— 重发会再执行一次
    // 对 message.send / deleteKnowledges，后者意味着一次确认发出多条写请求。
    // 门禁的语义是"人确认了**一次**"，自动重发把它变成 N 次，而 Agent 无从知道
    // 服务端执行了几次 —— 正是 risk:'irreversible' 承诺要避免的事。
    let attempts = 0
    fetchMock.mockImplementation(() => {
      attempts++
      return Promise.reject(new Error('SSL: UNEXPECTED_EOF_WHILE_READING'))
    })
    const err = await call(byId('message.send'), { uid: 1 }, { credentials: CREDS })
      .catch((e) => e)
    expect(attempts, '危险接口只该发一次请求').toBe(1)
    // 仍然是可重试的 network —— 由 Agent 决定要不要重新确认，而不是 CLI 替它决定
    expect(err).toMatchObject({ kind: 'network', retryable: true })
    expect(err.hint).toMatch(/不会.*重试|重新调用|确认/)
  })

  it('读接口的网络故障照常重试 —— 收窄只针对 dangerous', async () => {
    // 反向：上面那条不能把重试整个关掉。读接口重发最多多读一次，没有副作用。
    let attempts = 0
    fetchMock.mockImplementation(() => {
      attempts++
      return Promise.reject(new Error('ECONNRESET'))
    })
    // ⚠️ 不能只断言"抛了"——`rejects.toBeTruthy()` 对任何错误都成立，
    // 包括退出码 4 的误判或 kind 错标。必须钉住网络故障的契约字段：
    // Agent 靠 `retryable` 决定要不要自己重试，靠 `kind` 决定重试还是找人类。
    await expect(call(byId('ticket.search'), {}, { credentials: CREDS }))
      .rejects.toMatchObject({ kind: 'network', retryable: true })
    expect(attempts, '读接口应重试到预算耗尽（3 次）').toBe(3)
  })

  it('服务端回显凭证时，错误 message 里也不会残留', async () => {
    fetchMock.mockImplementation(() =>
      ok({ code: 14500, message: 'Param format error, got appKey=k secret=s' }))
    await expect(call(byId('ticket.search'), {}, { credentials: CREDS }))
      .rejects.toMatchObject({ message: expect.not.stringContaining('secret=s') })
  })

  // —— 限频 ——
  it('本地限频触发时抛出 rate_limit，并给出等待秒数', async () => {
    // 限频表里登记过的接口才走得到这个分支；用自建 spec 避免依赖注册表内容
    fetchMock.mockImplementation(() => ok({ code: 200, message: '{"data":null}' }))
    const spec = { ...BASE_SPEC, id: 'statistic.overview', title: '历史数据概览' }
    const opts = { credentials: CREDS, now: () => 1_700_000_000_000 }
    await call(spec, {}, opts)
    await expect(call(spec, {}, opts)).rejects.toMatchObject({
      // ⚠️ `code` 也要断言 —— 它是 Agent 契约的一等字段。此前只断言 kind 与
      // retryAfter，改掉这个 code 测试照样全绿 —— 而 Agent 判断"该等一会儿"（本地桶
      // 拦的）还是"该去查服务端的配额表"（14009/14500 命中）的唯一依据正是它。
      // ⚠️ 2026-10-07 更正：此前这里写「`local_rate_limit` 是全计划**唯一的合成码**
      // （其余错误都由服务端码填充）」—— **是假的**：`usageFail` 的 `usage`、
      // 网络层的 `network`、`auth_missing`、`confirm_required`、`internal`
      // 全是合成码（本文件满篇 `code: 'usage'` 即证据）。真正的事实是：
      // **限频分支里它是唯一的非服务端码**（14009/14500/12001/14402/8011 之外），
      // 断言点也正落在这句上 —— 把"唯一"错放到全计划口径，谁信了就会以为
      // 见到非数字 code 就只有这一条。
      code: 'local_rate_limit',
      kind: 'rate_limit', retryable: true,
      retryAfter: { seconds: 30, source: 'local' },
    })
    // ⚠️ `source: 'local'` 必须断言（2026-10-05 加）：本地桶算出的等待是**全系统
    // 唯一精确计算**出来的，却是三者中此前唯一没被钉住的。标成 'fallback' 后，
    // Agent 会把一个精确的 30 秒当成"不知道所以给的保守估计"而改变行为。
  })

  it('限频桶按**路径**分桶 —— 同一路径的不同 id 共享配额', async () => {
    // 实测限频粒度是按路径的（183 次探测）。设计稿 §5.1 实测**线上**有 6 组 24 个重复路径
    // （154 条注册表现已覆盖这些共享 path），
    // 若按 id 分桶，同一路径上的多个 id 会各拿一份配额，本地放行数倍流量，
    // 而服务端照旧按路径报 14009。
    fetchMock.mockImplementation(() => ok({ code: 200, message: '{"data":null}' }))
    const now = () => 1_700_000_000_000
    const specA = { ...BASE_SPEC, id: 'statistic.overview', title: 'A' }
    const specB = { ...BASE_SPEC, id: 'statistic.overview.alias', title: 'B' }

    await call(specA, {}, { credentials: CREDS, now })
    await expect(call(specB, {}, { credentials: CREDS, now }))
      .rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('同一路径上的两个 id 共享配额', async () => {
    // 桶按 path 建，所以同一路径的多个 id 共用一份配额，而不是各拿一份。
    //
    // ⚠️ 这条测试**依赖注册表的不变量**：同一路径上的所有 id 必须有一致的限频行。
    // 若某个 id 没登记限频，它先被调用时会把整条路径的桶建成"不限频"，
    // 之后已登记的 id 也跟着不受限 —— 所以那个不变量由注册表测试来守
    // （见 tests/core/registry.test.ts 的「同一路径上的所有 id 限频必须一致」——
    // 引号里的用例名必须逐字可 grep，缩短的版本搜不到）。
    fetchMock.mockImplementation(() => ok({ code: 200, message: '{"data":null}' }))
    const now = () => 1_700_000_000_000
    const shared = { ...BASE_SPEC, path: '/openapi/shared' }
    const a = { ...shared, id: 'statistic.overview', title: 'A' }
    const b = { ...shared, id: 'statistic.staffworklod', title: 'B' }

    await call(a, {}, { credentials: CREDS, now })
    await expect(call(b, {}, { credentials: CREDS, now }))
      .rejects.toMatchObject({ kind: 'rate_limit' })
  })

  it('未登记限频的接口收到服务端限流时，仍给出保守的等待秒数', async () => {
    // 最需要等待建议的时候恰恰是本地没有这一行的时候。
    // 缺了它 Agent 只能立刻重试，继续吃 14009。
    fetchMock.mockImplementation(() => ok({ code: 200, message: '14500 单位时间内请求过于频繁' }))
    const spec = { ...BASE_SAMPLESPEC, id: '某个未登记限频的接口',
                   title: '未登记限频', path: '/openapi/unlisted' }
    await expect(call(spec, {}, { credentials: CREDS }))
      .rejects.toMatchObject({ kind: 'rate_limit', retryAfter: { seconds: 60 } })
  })

  it('已登记限频的接口收到服务端限流时，等待秒数取自**限频表**，不是固定值', async () => {
    // ⚠️ 上一条只覆盖了"未登记 → 兜底 60 秒"那一支。**已登记那一支的取值无任何断言** ——
    // 变异测试确认：把 `{ seconds: limit.windowSeconds }` 改成 `{ seconds: 999 }`，
    // 全量测试仍全绿。而 `call()` 的契约（见**设计稿** §11.2 D 的错误处理表，以及
    // `QiyuError.retryAfter` 的类型定义）明确要求"命中 rate_limit 必填
    // retryAfter"，其**值**必须是这个接口真实的冷却窗口 —— 填错会让 Agent 要么等太久
    // （白白浪费配额窗口）要么等太短（继续吃 14009）。
    // ⚠️ 此前这里误标为「见 §9.5」—— 设计稿 §9.5 是「状态码」，只有
    // `store_not_initialized`/`auth_missing`/`store_locked` 三条，**不含 rate_limit**。
    // 本计划开头对 §9.5 的描述（"仅 auth_missing"）才是对的。
    // `statistic.overview` 在限频表里是 1 次/30 秒，取它当夹具。
    fetchMock.mockImplementation(() => ok({ code: 200, message: '14009 api call too frequent' }))
    const spec = { ...BASE_SAMPLESPEC, id: 'statistic.overview',
                   title: '报表总览', path: '/openapi/statistic/overview', envelope: 'C' as const }
    const err = await call(spec, {}, { credentials: CREDS }).catch((e) => e)
    expect(err).toMatchObject({ kind: 'rate_limit', retryAfter: { seconds: 30 } })
    // ⚠️ **必须断言 `source`**（2026-10-05 加）—— `statistic.overview` 在限频表里是
    // `source: 'observed'`（实测），秒数取自限频表。若把 source 写死成别的值
    // （或整个漏掉），Agent 会把一个实测窗口误当成文档值/兜底值，行为随之改变。
    expect(err.retryAfter.source, '已登记接口的等待来源必须与限频表一致').toBe('observed')
  })

  it('source 为 doc 的接口，hint 必须说清"这是文档值、未实测"（2026-10-07 补）', async () => {
    // ⚠️ 限频表里 6 行是 `source: 'doc'`（知识库 `getDetail` 与 5 个写接口，
    // **从未被调用过**）。它们的秒数来自厂商文档，不是实测 —— 而 `source` 这个
    // 字段对 Agent **零解释**（见「已知缺口」那条登记），所以 Agent 只能靠 hint
    // 分辨"实测窗口"与"文档值"。此前 `doc` 与 `observed` 走同一段代码、hint 一字不差，
    // 等于把文档值谎报成实测值 —— 与 `source` 存在的唯一目的相反。
    // ⚠️ 断言必须命中"文档/未实测"措辞，而不是只断言 hint 存在（泛泛一句也能过）。
    fetchMock.mockImplementation(() => ok({ code: 200, message: '14009 api call too frequent' }))
    const spec = { ...BASE_SAMPLESPEC, id: 'ai.knowledge.getDetail',
                   title: '知识库详情', path: '/openapi/ai/knowledge/getDetail', envelope: 'C' as const }
    const err = await call(spec, {}, { credentials: CREDS }).catch((e) => e)
    expect(err).toMatchObject({ kind: 'rate_limit', retryAfter: { seconds: 1, source: 'doc' } })
    expect(err.hint, 'doc 来源必须说明它是文档值').toMatch(/文档|未实测|未观测/)
    // 反向：observed 来源**不得**说"文档值" —— 否则实测窗口被说成没验证过
    const spec2 = { ...BASE_SAMPLESPEC, id: 'statistic.overview',
                    title: '报表总览', path: '/openapi/statistic/overview', envelope: 'C' as const }
    const err2 = await call(spec2, {}, { credentials: CREDS }).catch((e) => e)
    expect(err2.retryAfter.source).toBe('observed')
    expect(err2.hint ?? '', 'observed 来源不得自称文档值').not.toMatch(/文档值|未实测/)
  })

  it('未登记限频的接口收到服务端限流时，标出 60 秒是**兜底、非实测**', async () => {
    // ⚠️ 与上一条配对：同一类错误，一个 source:'observed'、一个 source:'fallback'。
    // 只断数字的话两者都是 `{ seconds: N }`、无法分辨 —— 而设计稿 §11.2 D 的分流
    // 正是按 retry_after 走，兜底值又恰好落在 60 这个阈值上，Agent 分不清就会
    // 把保守估计当成真实配额。hint 也必须点破"不是实测"。
    fetchMock.mockImplementation(() => ok({ code: 200, message: '14009 api call too frequent' }))
    // 自建 spec，确保它**不在**限频表里（避免依赖注册表里恰好有/没有某个 id）
    const spec = { ...BASE_SAMPLESPEC, id: 'definitely.not.registered',
                   title: '未登记', path: '/openapi/definitely/not/registered', envelope: 'C' as const }
    const err = await call(spec, {}, { credentials: CREDS }).catch((e) => e)
    expect(err).toMatchObject({ kind: 'rate_limit', retryAfter: { seconds: 60 } })
    expect(err.retryAfter.source, '未登记接口的 60 秒是兜底值').toBe('fallback')
    expect(err.hint, '兜底时必须说明它不是实测冷却').toMatch(/兜底|不是实测|保守/)
  })

  it('限频表里来源是「文档」的接口，source 必须是 doc 而不是 observed', async () => {
    // ⚠️ 这条守的是"别把文档值谎报成实测值"（2026-10-05 加）。
    // 限频表把来源分成 `'doc'` 与 `'observed'` 两类（`RateLimit.source`），
    // 而 `call()` 必须**原样透传**、不能压成一个布尔 —— 早先写成
    // `measured: true` 时，6 条 `source: 'doc'` 的接口（知识库 getDetail 与 5 个
    // 写接口，**从未被调用过**）全被标成"实测"，而 Agent 正是靠这个字段判断
    // 该不该信那个秒数。`ai.knowledge.getDetail` 是表里 source 为 doc 的一条。
    fetchMock.mockImplementation(() => ok({ code: 200, message: '14009 api call too frequent' }))
    const spec = { ...BASE_SAMPLESPEC, id: 'ai.knowledge.getDetail',
                   title: '知识库详情', path: '/openapi/ai/knowledge/getDetail', envelope: 'C' as const }
    const err = await call(spec, {}, { credentials: CREDS }).catch((e) => e)
    expect(err.retryAfter.source,
      '文档来源的限频行不能被标成 observed —— 那是一次对可信度的谎报').toBe('doc')
  })
})

describe('GET 请求不带 body（G1）', () => {
  // ⚠️ 当前 154 条注册表里唯一的 GET（`get_token`）是 inbound、不可主动调用，
  // 生产路径不可达 —— 本组用**合成 spec** 覆盖，不要把它读成"线上 GET 已实测"。
  const GET_SPEC = {
    id: 'synthetic.get', title: '合成 GET', method: 'GET' as const, path: '/openapi/synthetic/get',
    direction: 'outbound' as const, callable: true, dangerous: false,
    auth: 'checksum' as const, verified: false, envelope: 'C' as const,
  }

  it('GET 不传 body 时 fetch 收到 body: undefined，签名按 md5(空串) 计算', async () => {
    // ⚠️ 这是 GET 分支的核心不变量。此前 `call()` 对任何 method 都发
    // `body: bodyStr` —— 若某个调用点给 GET 传了 {}，undici 会在构造阶段抛
    // TypeError（被 isLocalRequestError 兜成 usage），但那是一条**错误驱动**的路径。
    // 现在要求：GET + 无 body → 正常发送、body 为 undefined、checksum == md5('')。
    fetchMock.mockReturnValueOnce(ok({ code: 200, message: '{"data":null}' }))
    await call(GET_SPEC as never, undefined, { credentials: CREDS })
    const init = fetchMock.mock.calls[0][1]
    expect(init.method).toBe('GET')
    expect(init.body).toBeUndefined()
    // 用与实现相同的口径独立重算：md5('') 参与签名（2026-10-02 真实凭证实测的约定）
    const url = String(fetchMock.mock.calls[0][0])
    const time = Number(/[?&]time=(\d+)&/.exec(url)![1])
    expect(/&checksum=([0-9a-f]{40})$/.exec(url)![1]).toBe(checksum(CREDS.appSecret, '', time))
  })

  it('GET + body 在本地就抛 usage（零 fetch），不静默丢弃 body', async () => {
    // ⚠️ 静默丢弃会让 Agent 以为参数生效了 —— 与「不传 body 与传 {} 是两条路径」
    // 同一条诚实性要求。必须在发请求前拦下，且 kind 是 usage（改参数重来）。
    const err = await call(GET_SPEC as never, { a: 1 }, { credentials: CREDS }).catch((e) => e)
    expect(err).toMatchObject({ kind: 'usage', retryable: false })
    expect(err.message).toMatch(/GET.*不接受请求体/)
    // ⚠️ hint 不得指向不存在的通道（2026-10-25 评审发现）：本 CLI 没有 GET 的
    // query 参数输入路径。承诺它会让调用方去找一个没有的 flag。
    expect(err.hint ?? '').not.toMatch(/走 query 串/)
    expect(err.hint ?? '').toMatch(/没有.*query 参数通道|无法.*参数/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('POST 仍照常发送 body —— GET 分支没有误伤 POST', async () => {
    fetchMock.mockReturnValueOnce(ok({ code: 200, message: '{"data":null}' }))
    await call(byId('ticket.search'), { a: 1 }, { credentials: CREDS })
    expect(fetchMock.mock.calls[0][1].body).toBe('{"a":1}')
  })
})
