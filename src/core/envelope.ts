// src/core/envelope.ts

/** 注册表按接口记录的解析策略。见设计稿 §9.0。 */
export type EnvelopeShape = 'A' | 'B' | 'C' | 'D' | 'D-nf'

export interface Normalized {
  ok: boolean
  code: string
  /** 归一化后的业务载荷；无载荷时为 undefined（这本身是有意义的信号） */
  payload: unknown
  /** 供错误分类使用的原始文本 */
  messageText: string
  /**
   * 「成功但查无此物」。设计稿 §9.0：`code:200` 且无数据字段的一律当作 not_found。
   * ⚠️ 不能一刀切 —— 形状 D（`robot.transfer.config` 这类纯确认接口）无 data 是**正常**的。
   * 只有注册表知道某个接口是否可能合法地返回无数据，所以这里按 envelope 判定。
   */
  notFound: boolean
}

function tryParseJson(s: string): { parsed: boolean; value: unknown } {
  try {
    return { parsed: true, value: JSON.parse(s) }
  } catch {
    return { parsed: false, value: undefined }
  }
}

/**
 * 修复设计稿 §10.2 记录的畸形 JSON：**整数键没有引号**。
 * 服务端返回的 `follower` / `customField` 形如 `{5000004:"张三",5000001:"李四"}`，
 * `JSON.parse` 与 Python 的 `json.loads` **都会失败**。
 *
 * ⚠️ 这是**真实数据的缺陷，不是假想**：实测 `session.user.profile` 的 message
 * 有 **28/59（47%）** 解析失败，且 28/28 都是这一个原因；`ticket.new.detail`
 * 在较早的工单上有 **18%** 失败（近期的为 0%）。设计稿的结论是
 * 「容错是回补路径特有的正确性要求」，而这个正则**修复了 100% 的失败样本**。
 *
 * ⚠️ 已知局限：正则不区分"结构位置的整数键"与"字符串值里的 `,123:`"。
 * 但**它只在严格解析已经失败之后才运行** —— 合法的 JSON（哪怕字符串值里
 * 恰好含 `,1:`）走的是严格路径，根本到不了这里。
 */
function repairUnquotedIntKeys(s: string): string {
  return s.replace(/(\{|,)(\d+):/g, '$1"$2":')
}

/**
 * 「成功但为空」。设计稿 §9.0 列出三种编码：`data` 键**缺失**、`data = {}`、`data = []`。
 * 第一种（`data` 键缺失）由调用点的末尾分支处理，`{}` / `[]` 两种走这里。
 */
function isEmptyPayload(v: unknown): boolean {
  if (v === null || v === undefined) return true
  if (Array.isArray(v)) return v.length === 0
  if (typeof v === 'object') return Object.keys(v as object).length === 0
  return false
}

/**
 * 把七鱼的各种响应形态归一到统一结构。
 *
 * ⚠️ 判据不是 key 集合，而是「该接口在注册表里登记的形状」+「message 能否解析为 JSON」。
 * 仅 {code,message} 一种形状就分裂成五种（JSON 对象/数组/数字/纯文本/键不存在），
 * 只按键集合分支的解析器会错四种。
 *
 * ⚠️ 最要命的一条：**形状 C 的端点，错误也可能返回 code:200**，配一段纯文本的
 * message（`14501 ...`、`14004 Not found param`、`14009 api call too frequent`）。
 * 因此形状 C 上"message 解析不出 JSON"必须判为**失败**，不能当"成功但无数据"——
 * 否则 Agent 会把限流当成"这段时间没有数据"，这是设计稿 §9.2 点名的头号静默失败。
 *
 * ⚠️ 本句此前写作「每一个错误都返回 code:200」，2026-10-30 实测 `ticket.list` 证伪：
 * 它的 `staffId` 非法时返回 **`code:14100`** + 纯文本 `Bad holder staff id`。
 * 判据不变（C 上 message 解析失败仍判错，且本分支先判 code、非 200 直接失败），
 * 但"每一个"这个量词是错的 —— 留着它会让人以为"C 的响应只要 code 是 200 就安全"。
 */
export function normalize(raw: unknown, envelope?: EnvelopeShape): Normalized {
  // 裸数组：ipcc.customfield.template.get 完全没有信封
  if (Array.isArray(raw)) {
    return { ok: true, code: '200', payload: raw, messageText: '', notFound: false }
  }

  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, code: 'unknown', payload: undefined,
             messageText: String(raw), notFound: false }
  }

  const o = raw as Record<string, unknown>

  // Spring Boot 404：/openapi 下的路由不存在时返回这种形态
  if ('status' in o && 'timestamp' in o && !('code' in o)) {
    return {
      ok: false,
      code: String(o.status),
      payload: undefined,
      messageText: String(o.message ?? o.error ?? ''),
      notFound: false,
    }
  }

  const code = String(o.code ?? 'unknown')
  const codeOk = code === '200'
  const messageText = typeof o.message === 'string' ? o.message : ''

  // 形状 C：数据藏在 message 里的 JSON 字符串。
  // 解析成功 → 成功；解析失败 → **错误**（见上方说明），即便 code 是 200。
  if (envelope === 'C') {
    const nf = { notFound: false }
    if (!codeOk) return { ok: false, code, payload: undefined, messageText, ...nf }
    if (!messageText) return { ok: false, code, payload: undefined, messageText: '响应缺少 message', ...nf }
    const { parsed, value } = tryParseJson(messageText)
    // 形状 C 的载荷就是 message 解析出来的东西，所以 `{}` / `[]` 同样是"成功但为空"
    if (parsed) return { ok: true, code, payload: value, messageText,
                         notFound: isEmptyPayload(value) }
    // ⚠️ 严格解析失败**不等于**服务端出错 —— `session.user.profile` 有 47% 的
    // **正常**响应带整数键未加引号的畸形 JSON（设计稿 §10.2）。先试着修复再判错，
    // 否则近一半的正常响应会被报成 `ok:false`（且 code 停在 '200'，下游落 unknown）。
    const repaired = tryParseJson(repairUnquotedIntKeys(messageText))
    if (repaired.parsed) return { ok: true, code, payload: repaired.value, messageText,
                                  notFound: isEmptyPayload(repaired.value) }
    // ⚠️ 关键：这一族的错误报文里，**顶层的 code 恒为 200，真实错误码写在 message 开头**
    // （`14501 (endTime-startTime)/millsADay > 31 is invalid`、`14004 Not found param`、
    // `14009 api call too frequent`）。若原样返回 200，下游 classify 会一律落到
    // default → unknown，任务 3 建的 14501 双义分派与 14004 分发表就全部失效。
    // 必须把开头的错误码提取出来当作 code。
    const m = /^\s*(\d{4,6})\b/.exec(messageText)
    return { ok: false, code: m ? m[1] : code, payload: undefined, messageText, ...nf }
  }

  // 形状 B：数据在 result
  // ⚠️ 必须和形状 A 一样判空载荷。若这里硬编码 notFound:false，
  // `tag.all` 返回 `{code:200, result:[], total:0}` 时会被当成"成功且有数据" ——
  // 而设计稿 §9.0 明说该接口的 total 恒为 0、不可作数，只能看 result 本身。
  // ⚠️ 与 data 分支同理：只在 envelope 已实测时才敢判 notFound ——
  // 未实测的接口，"空 result 意味着什么"同样无从得知。
  //
  // 与 data 分支不同的是，**今天还没有实测到语义反转的 result 写接口**（形状 B 只有
  // `tag.all` 一个读接口）。这条守卫因此是**防御性**的：它守的不是已发生的 bug，而是
  // 「data 能反转、result 凭什么不能」这个不对称 —— 两个分支都是"载荷为空"的判据，
  // 没有理由一个查注册表、另一个靠猜。写接口在注册表里会越来越多（§5.4.1 已列 5 个），
  // 其中任何一个改用 `result` 承载失败列表，这里就会和 data 一样静默反转。
  // → 宁可现在写死这条规则，也不留给下一个人去重新发现。
  if ('result' in o) {
    return { ok: codeOk, code, payload: o.result, messageText,
             notFound: codeOk && envelope !== null && envelope !== undefined
                       && isEmptyPayload(o.result) }
  }

  // 形状 A / D：数据在 data
  //
  // ⚠️ **但"data 为空 ⇒ not_found"这条规则只在 envelope 已登记时成立。**
  // envelope 为 null 的接口里，此前观测到的**全部是写接口**，而写接口的 `data` 语义
  // 与读接口相反 —— 设计稿 §5.4.1 的**文档依据**（这 5 个接口实测中刻意未调用）：
  //   · `addKnowledge`  → `data` 是新 id（integer）
  //   · `editKnowledge` / `editKnowledgeNoSimilars` / `editChannelAnswer` → `data` 是 `true`
  //   · `deleteKnowledges` → `data` 是**失败**的 id 列表，**空数组 = 全部成功**
  //
  // 最后一个是**不可逆的批量删除**，而"空数组"在这里是**最成功**的结果。
  // 旧实现无条件套用读接口的判据，实测把它报成
  // `not_found: true` + "接口返回成功但无数据" —— Agent 会以为**什么都没删掉**，
  // 而真相是**全部删掉了**。这是 §9.2 静默失败最危险的方向：它把一个已完成的
  // 破坏性操作描述成一次空操作。
  //
  // ⚠️ **2026-10-30 起 `envelope: null` 有两种含义**，不再等于"未经实测"：
  //   ① 该接口的信封**从未实测**（写接口全部如此，`verified: false`）；
  //   ② 实测过，但形状**不在 A/B/C/D 里**（`chat.queue.group.query` 的 staffInfo、
  //      `ipcc.customfield.template.get` 的裸数组）—— 两者都由更前面的结构分支接住，
  //      **根本走不到这里**，所以 null 对它们无害。
  // 两种情况下这条 `data` 分支的判据都一样：**不判 not_found**。
  //
  // → 不知道 `data` 语义的接口**不判 not_found**：注册表既然不知道这个接口的
  // `data` 语义，就不能假装知道。"空 data 是什么"这个问题，只有实测过才能回答。
  if ('data' in o) {
    return { ok: codeOk, code, payload: o.data, messageText,
             notFound: codeOk && envelope !== null && envelope !== undefined
                       && isEmptyPayload(o.data) }
  }

  // chat.queue.group.query：数据在 staffInfo，且成功时 message 反而缺失。
  // 空的 staffInfo（[]）是"无人在线"的合法状态，不是错误。
  if ('staffInfo' in o) {
    // ⚠️ 空的 staffInfo 是"无人在线"的**正常**状态（24 个组里 15 个如此），不是 not_found
    return { ok: codeOk, code, payload: o.staffInfo, messageText, notFound: false }
  }

  // 宽松模式（envelope 为 undefined 或 null）：该接口的信封形状未经登记 ——
  // 可能是从未实测，也可能是实测确认形状不在 A/B/C/D 里（登记了非标形状的两个接口
  // 由更前面的结构分支提前接住，走不到这里）。
  // 按设计稿 §9.0，此时唯一能做的就是试探 message 能否解析。
  // ⚠️ 这与形状 C 的严格语义不同：解析失败**不判错**，因为无从区分
  // "形状 C 的错误报文"与"staff.list 那种 message='OK' 的正常响应"。
  if (messageText) {
    // 同样先严格、失败再修复（见上方 repairUnquotedIntKeys 的说明）
    let { parsed, value } = tryParseJson(messageText)
    if (!parsed) ({ parsed, value } = tryParseJson(repairUnquotedIntKeys(messageText)))
    // ⚠️ 这里同样要判空载荷。设计稿 §9.0 点名 `smstask.status` 未知任务 id 返回
    // `{code:200, message:"[]"}` —— 那正是"成功但查无此物"。若因为该接口的
    // envelope 还没实测（填 null）就硬编码 notFound:false，§9.2 的头号静默失败
    // 会在宽松模式下原样复现。
    //
    // ⚠️ **为什么这里不判 envelope、而上面 data/result 两条要判** —— 这不是疏漏：
    //   · `message` 是 JSON 载荷的载体时，"载荷为空"就是**查无此物**，
    //     设计稿 §9.0 对 `smstask.status` / `getDetail` 等接口**实测**过这一点。
    //   · `data` 为空则有**两种相反**的实测含义：读接口是"查无此物"（`group.members`
    //     传错 groupId），写接口是"全部成功"（`deleteKnowledges` 的失败列表为空）。
    //     在不知道是哪种时断言其一，就是在制造下面那条注释描述的静默失败。
    // → 两者的区别不是"严格 vs 宽松"，而是"这个形状有没有出现过语义反转的实测证据"。
    if (parsed) return { ok: codeOk, code, payload: value, messageText,
                         notFound: codeOk && isEmptyPayload(value) }
  }

  // 其余形状走到这里意味着"200 但无载荷"。
  //
  // ⚠️ **envelope 为 undefined 或 null 时与 data/result 两个分支取同一条规则：不判 not_found。**
  // 设计稿 §9.0 的规则原文是"`code:200` 且无数据字段的，一律当作 not_found"，但它同时
  // 写明这条规则"必须是**注册表查询**而非启发式判断"—— 它假定每个接口都登记了 `envelope`。
  // 骨架里那 5 个知识库写接口的 `envelope` 正是 `null`（未实测），生成脚本产出 154 条时
  // `null` 只会更多。若这里写 `envelope !== 'D'`，`null !== 'D'` 为真，于是
  // **同一个未实测接口**会因为"载荷挂在 data 上还是完全缺席"得到相反的判定：
  // `{code:200,data:[]}` 走 data 分支判 false，`{code:200}` 走这里判 true。
  // 对未实测的写接口，`{code:200}` 无载荷恰恰可能就是"操作成功"，判成 not_found 会把
  // 一次成功的写描述成"什么都没发生"—— 与 data 分支注释里那条最危险的静默失败同构。
  //
  // ⚠️ **2026-10-30 起 envelope:null 有第二种来源，同样依赖这条规则：**
  //   实测过的接口若返回 `{code}`（无 data/result/message/staffInfo），说明该接口
  //   的"成功但查无此物"与"纯确认"是**同一报文**，而 `normalize` 只收到一个 envelope
  //   参数、不知道是哪个接口 —— 它无法替调用方分辨。这类接口（`msgAssociate` 的
  //   not-found 路径、`robot.transfer.config` 的正常空壳）靠注册表按接口登记
  //   `'D-nf'` / `'D'` 兑现。若某个实测接口没机会这样登记（形状是无结构分支的
  //   branch 提前接住），它的 notFound 取尾部兜底 —— 与 data/result 分支同规则。
  // → 与 data/result 对齐：不知道就不断言。'D' / 'D-nf' 这些**已登记**的取值照旧区分。
  //
  // ⚠️ 形状 D 这一族里**语义相反的两个接口共用同一个报文**，必须分开登记：
  //   `robot.transfer.config`      → `{code}` 是**正常成功**（它就是返回一个空壳）
  //   `robot.session.msgAssociate` → `{code}` 是它的 **not-found 路径**
  //     （命中时返回 `{code,data}`，`data{content,questionList,robotId}`）
  // 两者都返回 `{code:200}`、都没有 data，从报文里**根本无从分辨**。
  //
  // 区分它们的，就是这一行末尾那个 `envelope !== 'D'` 子句（前两个 `!= null` 子句管的是
  // 未实测的情形，与 D 族无关）：
  // `'D'` 落在 `!== 'D'` 的假分支（不判 not_found），`'D-nf'` 落在真分支（判）。
  // 因此这里**刻意不为 `'D-nf'` 单独开分支** —— 那会是一段不改变任何行为的死代码
  // （变异测试确认：删掉它全量测试仍全绿）。`'D-nf'` 的全部意义就是
  // "形状 D，但空报文表示查无此物"，让它可以被登记，而不需要被特判。
  return { ok: codeOk, code, payload: undefined, messageText,
           notFound: codeOk && envelope !== null && envelope !== undefined && envelope !== 'D' }
}
