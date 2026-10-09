import raw from './specs.json' with { type: 'json' }

export interface EndpointSpec {
  id: string
  title: string
  method: 'POST' | 'GET'
  /** null 表示文档页没有可用的路径 —— 该接口不可调用 */
  path: string | null
  direction: 'outbound' | 'inbound'
  callable: boolean
  /**
   * ⚠️ 必须显式给出，不得省略。这是 `--yes` 门禁唯一的依据：
   * 键缺失会得到 undefined → falsy → 门禁静默失效。
   * 加载时会校验，缺失即抛错（见 loadSpecs）。
   */
  dangerous: boolean
  auth: 'checksum' | 'eventType' | 'none'
  verified: boolean
  /**
   * null = 该接口的信封形状未经实测，解析时退化为宽松模式。
   * ⚠️ `'D'` 与 `'D-nf'` 的报文**逐字节相同**（都是 `{code:200}`），语义相反 ——
   * 前者是正常成功，后者是查无此物。生成脚本不得因为"设计稿把这两个接口
   * 写在同一行"就把两者都填成 `'D'`，那样 msgAssociate 的 not-found 会静默变成成功。
   */
  envelope: 'A' | 'B' | 'C' | 'D' | 'D-nf' | null
  /**
   * 时间跨度上限（天）。**这是上界，按"精确比较"理解** —— 调用方必须
   * 保证 `span <= maxWindowDays * 86400000` 毫秒。
   *
   * ⚠️ 设计稿 §7.4.1 实测两个报表族的判定式不同：`/openapi/statistic/*`
   * 是**向下取整**（`floor(span/86400000) > 31`，所以 31 天 + 23:59:59.999 也接受），
   * 而 `robot.statistic.summary` 与 `ai.statistic.transferHuman` 是**精确比较**
   * （summary 在 31 天 + 1 毫秒即拒绝）。按严格形式（`span <= N 天`）切片
   * 对两族都正确且安全；按向下取整理解则会在 summary 上多取一天并拿到 14004。
   * → 本字段刻意**不**携带"判定式"信息：严格形式是两族的安全交集。
   */
  maxWindowDays?: number
  note?: string
}

/**
 * 校验并载入注册表。
 *
 * ⚠️ 不能只写 `raw as EndpointSpec[]` —— 那是纯编译期断言，运行时零校验。
 * 生成脚本产出的 154 条若漏了 `dangerous`，门禁会静默 fail-open，
 * 而 `qiyu api call` 正是唯一的写操作入口。宁可加载时炸，也不要运行时静默放行。
 */
export function loadSpecs(raw: unknown): EndpointSpec[] {
  if (!Array.isArray(raw)) throw new Error('specs.json 顶层必须是数组')
  const seen = new Set<string>()
  return raw.map((e, i) => {
    const o = e as Record<string, unknown>
    if (typeof o.id !== 'string' || !o.id) throw new Error(`specs.json[${i}] 缺少 id`)
    if (seen.has(o.id)) throw new Error(`specs.json 存在重复 id：${o.id}`)
    seen.add(o.id)
    if (typeof o.dangerous !== 'boolean') {
      throw new Error(
        `specs.json[${o.id}] 缺少 dangerous 字段。` +
          '该字段决定 --yes 门禁是否生效，不允许省略 —— 未知即视为危险。',
      )
    }
    if (typeof o.callable !== 'boolean') throw new Error(`specs.json[${o.id}] 缺少 callable`)
    // ⚠️ `callable: true` 却没有路径，是生成脚本可能产出的畸形组合。
    // 它不会在加载时暴露，而是在**调用时**拼出 `https://qiyukf.comnull?...`
    // 发出去 —— 服务端返回一个与真实原因毫无关系的错误。
    // 与 dangerous 同理：宁可加载时炸，也不要运行时静默发一个错误的请求。
    if (o.callable === true && !o.path) {
      throw new Error(
        `specs.json[${o.id}] 标记为可调用，但缺少 path。` +
          '没有路径就无法拼出请求 URL，这一定是生成脚本的缺陷。',
      )
    }
    // ⚠️ `path` 必须**以 `/` 开头的字符串**。上面那条只判了 truthy —— 实测
    // `path: 123` 能通过校验，然后在 `call()` 里被模板串拼成
    // `https://qiyukf.com123?appKey=...`：**请求照常发出去**，命中一个与真实
    // 原因毫无关系的地址（`qiyukf.com123` 这个主机根本不存在，或者被 DNS 解析到
    // 别处）。这正是上面 `null` 那条注释描述的同一种后果，只是入口换了 ——
    // 只判 truthy 挡不住"非空但不是字符串"的值。
    // 同理，不以 `/` 开头的相对路径会拼出 `https://qiyukf.comopenapi/...`，
    // 同样是一个看似正常却错误的 URL。生成脚本取的是 OpenAPI 的 `paths:` 键，
    // 正常一定是 `/` 开头 —— 不是的话就该在加载时炸。
    //
    // ⚠️ **`path` 键必须存在**（2026-10-08 修）—— 此前判据是
    // `o.path !== null && o.path !== undefined`，**键整个缺失时被放行**。
    // 而 `EndpointSpec.path` 的类型是 `string | null`（必填、无 `?`），
    // `api list` 又**无条件**输出 `path: e.path` —— `undefined` 在
    // `JSON.stringify` 里会让该键**整个消失**，Agent 拿到一行**没有 path 键**的记录。
    // 这与 `verified` 那条「不允许省略」是**同一个理由**（注释就在下面几行），
    // 却唯独漏了 `path`：`field_notes.path` 只声明了 `null`（未收录）与 `"/"`
    // （入站占位符）两种形态，Agent 对一个"没有 path 键"的行无从判断该按哪种理解。
    // 实测确认（2026-10-08）：删掉 `path` 键后 `loadSpecs` 放行、输出里无 `path`。
    // → 判据改为「键必须在，且值是 null 或以 `/` 开头的字符串」。
    if (!('path' in o)) {
      throw new Error(
        `specs.json[${o.id}] 缺少 path 字段。` +
          '它必须是 / 开头的字符串或显式的 null（null = 文档页未提供可用路径）。' +
          '省略会让该键在 api list 的 JSON 输出里整个消失，Agent 无从判断含义。',
      )
    }
    if (o.path !== null) {
      if (typeof o.path !== 'string' || !o.path.startsWith('/')) {
        throw new Error(
          `specs.json[${o.id}] 的 path 必须是 / 开头的字符串或 null，` +
            `实际是 ${JSON.stringify(o.path)}。` +
            '错误的 path 会被拼进 URL 照常发出去，服务端返回一个与真实原因无关的错误。',
        )
      }
    }
    // ⚠️ `verified` 必须显式给出。它区分"实测过、可依赖"与"只有文档依据"，
    // 而 `api list` 会把它原样输出给 Agent —— `undefined` 在 JSON 里会**整个丢键**
    // （`JSON.stringify({verified: undefined})` → `{}`），Agent 看到的是一个
    // 连字段都没有的记录，无从判断可信度。与 `dangerous` 同理：不允许省略。
    if (typeof o.verified !== 'boolean') {
      throw new Error(
        `specs.json[${o.id}] 缺少 verified 字段（true=已实测 / false=成功路径未实测，` +
          `实测范围见该行 note）。` +
          '它会被 api list 输出给 Agent，缺失时该键会在 JSON 里消失。',
      )
    }
    // ⚠️ `maxWindowDays` 是**天数**，必须是非负数字。实测 `"31"`（字符串）能通过
    // 加载，然后在 `api list` 里原样输出 `"max_window_days": "31"` ——
    // Agent 按 `span <= "31" * 86400000` 算会得到 NaN，切片逻辑静默失效；
    // 而负数则会让任何窗口都被判为超限。
    //
    // ⚠️ **`null` 也必须被拒**（2026-10-05 修）：此前守卫写成
    // `!== undefined && !== null`，`null` 被**跳过校验**，可 `api list` 的判据是
    // `e.maxWindowDays !== undefined`（`null !== undefined` 为真）—— 于是
    // `"maxWindowDays": null` 会被原样输出成 `"max_window_days": null`。
    // 而 `field_notes.max_window_days` 明写「未输出该键的接口没有已知上限」，
    // 类型也是 `maxWindowDays?: number` —— 三处互相矛盾，Agent 拿到一个既不是
    // 数字、也不是"没有该键"的值。本计划的约定是「**缺键 = 没有已知上限**」，
    // 所以 `null` 是非法写法，必须在加载时炸，而不是漏到输出层。
    if (o.maxWindowDays !== undefined) {
      if (typeof o.maxWindowDays !== 'number' || !Number.isFinite(o.maxWindowDays) || o.maxWindowDays < 0) {
        // ⚠️ 消息里**不得**用 Markdown 加粗（2026-10-06 修）。加载期的抛错发生在
        // 任何输出层之前 —— specs.json 畸形时它以未捕获异常的形式**随堆栈原样进终端**
        // （Node 默认打印器），`**` 会在那里显示成字面星号。与 help 文本同一条规则：
        // 输出给谁看，就按谁的格式写 —— 崩溃栈也是纯文本通道，哨兵在
        // tests/core/registry.test.ts 的「loadSpecs 的抛错消息不得含 Markdown」。
        throw new Error(
          `specs.json[${o.id}] 的 maxWindowDays 必须是非负有限数字，或整个省略该键` +
            `（省略 = 没有已知上限）；不接受 null。实际是 ${JSON.stringify(o.maxWindowDays)}。`,
        )
      }
    }
    // ⚠️ 入站推送（`direction: 'inbound'`）是七鱼回调我方，**不存在可主动调用的 URL**。
    // 它的 path 是占位符 `"/"`（truthy），上面那条 `callable && !path` 拦不住它 ——
    // 误标 callable 会拼出 `https://qiyukf.com/?appKey=...` 发出去。矛盾组合必须在加载时炸。
    if (o.direction === 'inbound' && o.callable === true) {
      throw new Error(
        `specs.json[${o.id}] 是入站接口（direction: inbound）却被标为可调用。` +
          '入站接口由七鱼回调我方，不存在可调用的 URL —— 这一定是生成脚本的缺陷。',
      )
    }
    // ⚠️ envelope 是**枚举**，拼错的值（`'d'`、`'A '`、`'E'`）不会报错，
    // 而是静默退化成"未实测"的宽松模式。对形状 C 的接口，宽松模式会把
    // message 里的 JSON 字符串**当成载荷原样返回**，Agent 拿到的是一段字符串
    // 而不是解析后的对象 —— 而它无从知道这是因为注册表拼错了字。
    // 与 dangerous 同理：枚举值必须在加载时校验，不能靠运行时兜底。
    const ENVELOPES = new Set(['A', 'B', 'C', 'D', 'D-nf'])
    if (o.envelope !== null && !ENVELOPES.has(o.envelope as string)) {
      throw new Error(
        `specs.json[${o.id}] 的 envelope 取值非法：${JSON.stringify(o.envelope)}。` +
          `合法值为 ${[...ENVELOPES].join('/')} 或 null（未实测）。`,
      )
    }
    // ⚠️ `title` 是 `assertConfirmed` 错误消息的一部分（`接口 id（title）是危险操作`），
    // 也是 `api list` 输出的唯一人类可读标识。缺失时门禁消息会输出 `（undefined）`。
    if (typeof o.title !== 'string' || !o.title) {
      throw new Error(`specs.json[${o.id}] 缺少 title —— 门禁与 api list 都依赖它`)
    }
    // ⚠️ `direction` 拼错会让接口从 `api list` 的默认过滤器里**静默消失**
    // （默认只列 `callable && direction === 'outbound'`），Agent 据此以为
    // "这个功能不存在" —— 这是 §9.2 头号静默失败在注册表层的变体。
    if (o.direction !== 'outbound' && o.direction !== 'inbound') {
      throw new Error(
        `specs.json[${o.id}] 的 direction 取值非法：${JSON.stringify(o.direction)}。` +
          '合法值为 outbound / inbound —— 拼错会让接口从 api list 里静默消失。',
      )
    }
    // ⚠️ `method` 缺失时 undici 默认 GET；若请求带 body 会抛
    // "Request with GET/HEAD method cannot have body" —— 一个与真实原因
    // （注册表缺字段）毫无关系的错误。
    // ⚠️ **本计划 11 条骨架里 method 全是 `POST`，没有一条 GET**（2026-10-06 核实）。
    // 枚举里保留 `GET` 是为了**完整的 154 条**：设计稿 §5.2 的类型定义就是
    // `'POST' | 'GET'`，且 `call()` 按 `spec.method` 发请求，删掉它会让将来
    // 出现的 GET 接口无处登记。但**不要据此以为本计划验过 GET 路径** ——
    // `call()` 对任何 method 都带 body 发（`body: bodyStr`），GET + body 会
    // 被 undici 拒，由 `isLocalRequestError` 接住报 usage（有测试，但那个测试
    // 是用 mock 抛 TypeError 模拟的，不是真的发了一个 GET）。等 154 条里出现
    // 真 GET 接口时，`call()` 必须补上"GET 不带 body"的分支。
    if (o.method !== 'POST' && o.method !== 'GET') {
      throw new Error(
        `specs.json[${o.id}] 的 method 取值非法：${JSON.stringify(o.method)}。` +
          '合法值为 POST / GET。',
      )
    }
    // ⚠️ `auth` 本计划的 `call()` **不读**（见「已知缺口」），但枚举必须合法：
    // 生成脚本产出 154 条时，一个拼错的 auth 会让"该接口是否需要签名"失去依据。
    if (o.auth !== 'checksum' && o.auth !== 'eventType' && o.auth !== 'none') {
      throw new Error(
        `specs.json[${o.id}] 的 auth 取值非法：${JSON.stringify(o.auth)}。` +
          '合法值为 checksum / eventType / none。',
      )
    }
    return o as unknown as EndpointSpec
  })
}

const SPECS = loadSpecs(raw)
const INDEX = new Map(SPECS.map((e) => [e.id, e]))

export function allEndpoints(): EndpointSpec[] {
  return SPECS
}

/** 未知 id 直接抛错 —— 静默返回 undefined 会让调用方崩在离病根很远的地方。 */
export function byId(id: string): EndpointSpec {
  const spec = INDEX.get(id)
  if (!spec) {
    // ⚠️ 空白 id 必须渲染成可见形式（2026-10-08 修，规则同 output.ts 的 describeArgs）：
    // `api call " "` 此前报「未知接口： 。可用 …」—— 冒号后不可见，Agent 无从知道
    // 自己传的是空白（多半是 shell 变量展开成了空格）。
    // ⚠️ 本文件在任务 6、output.ts 在任务 9，**无法 import describeArgs** —— 手写同一规则；
    // 将来若调整 describeArgs 的渲染，记得这里有一份副本（同 cli.ts 任务 1 的手写 JSON）。
    const shown = id.trim() === '' ? `'${id}'` : id
    throw new Error(`未知接口：${shown}。可用 \`qiyu api list\` 查看全部接口 id。`)
  }
  return spec
}

export function assertCallable(spec: EndpointSpec): void {
  if (!spec.callable) {
    throw new Error(
      `接口 ${spec.id} 不可主动调用` +
        (spec.path ? `（方向：${spec.direction}）` : `（文档未提供可用路径）`),
    )
  }
  // ⚠️ `callable: true` 但 `path: null` 是**生成脚本可能产出的畸形组合**
  // （文档页没有可用路径，却被标成可调用）。`call()` 里是 `${BASE}${spec.path}?...`，
  // path 为 null 时会拼出 `https://qiyukf.comnull?appKey=...` —— 请求照样发出去，
  // 服务端返回一个与真实原因无关的错误。必须在本地拦下，而不是让它变成网络请求。
  if (!spec.path) {
    throw new Error(
      `接口 ${spec.id} 标记为可调用，但注册表里没有它的路径（path 为 null）。` +
        '这是注册表数据错误，请检查生成脚本。',
    )
  }
}

export function assertConfirmed(spec: EndpointSpec, confirmed: boolean): void {
  if (spec.dangerous && !confirmed) {
    // ⚠️ 这里**只挂两个键**，两个都真的被读：
    //   · `needsConfirmation` —— api.ts 用它分流到 fail() 的 needs_confirmation 分支
    //   · `target`            —— api.ts 读它（`err.target ?? id`）填出参的 target
    // ⚠️ **不要在这里再挂 `confirmArg: '--yes'`。** 它曾在这里，但全仓没有任何读取点 ——
    // 出参的 `confirm_arg` 是 `fail()` 自己硬编码的（见 output.ts）。留着它会制造
    // **两个真相来源**：将来若把确认参数从 `--yes` 改掉，必须同时改两处，而死的这一处
    // 会静默变错、无人发现。这与 `ErrorInput` 不再收 `confirmArg`/`risk` 是同一次清理
    // （那两个键也曾是死键）—— 只是当时漏了抛错点这一处。
    throw Object.assign(
      new Error(`接口 ${spec.id}（${spec.title}）是危险操作，需要显式确认`),
      { needsConfirmation: true, target: spec.id },
    )
  }
}
