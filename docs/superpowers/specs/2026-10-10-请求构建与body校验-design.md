# 请求构建与 body 校验（B 子项目 · 设计）

- **日期**：2026-10-10
- **状态**：已批准（设计经用户逐节/逐题确认）。**v2.3** —— 经 6 路独立只读审查修订（v2）
  ＋ 用户两轮追问后 controller 逐行复读复查（v2.1 补 5 条遗漏、v2.2 修 4 处实测缺陷）
  ＋ 3 路对抗性证伪审查（v2.3 补 16 条契约/可实现性缺陷），全部修订见 §十一（43 条）
- **上游**：`docs/superpowers/specs/2026-10-09-后续交付路线图-design.md`（§二 B 节、§八.6/.7 遗留）、
  `docs/qiyu-cli-design.md`（§5.2 注册表与 ParamSpec、§5.3 元数据陷阱、§5.4 写接口与字段改名、§9.1 输出契约）、
  A 的交付物（`src/core/registry/params/*.json` 154 份 + `src/core/registry/specs.json` 154 条，合入 `main` `a3f1c17`）。
- **依赖**：A（✅ 已满足）。与 C（存储层）文件不重叠、可并行。

## 一、目标与非目标

**目标**（一句话）：让 `qiyu api call <id> --body <JSON>` 的 body **在发出请求之前**、
**在本地**与注册表参数表比对——缺必填字段当场拒绝（退出码 2、零网络请求），可疑之处
以结构化 warnings 提示；对**已实测的字段改名**做受控归一化（§五 D8）；并新增
`qiyu api schema <id>` 把参数表本身暴露给 Agent。

解决路线图 §八.7 登记的「**154 份 params 已打包但无任何运行时消费方**」缺口；
§八.6 的 `category` 悬置在本 spec §七 给出处置意见（B 不动它、决定权归 G1）。

**非目标**：

- **不做响应体校验**（`response_shape` 只在 `api schema` 里原样输出，B 不消费其内容做校验）。
- **不做文件/表单/XML 的 body 构建**——非 `json` 的 bodyKind 一律原样透传（见 §四 D4），B 只消费 JSON 字面量。
- **不预校验 `maxWindowDays`**（窗口起止在哪个字段里、单位是什么，B 不接管；那是 D/E 的候选）。
- **不修改 `params/*.json` 的生成源**——B 是纯消费方 + 一份自己的校验 override 表。
- **不改 `core/http.ts` 的签名/行为**（B 只在 `callOne` 里、`call()` 之前介入）。
- **不补齐 `rateLimit.scope`**（设计稿 §5.2 有、A 未落）——`api schema` 只输出 A 的 params 文件字段
  与 B 的校验元数据，**不承诺**成为「完整自描述的 Endpoint 元数据」；`scope` 仍归 G1。

## 二、已锁定决策（用户拍板）

| # | 决策 |
|---|---|
| D1 | **分级校验（缺必填硬拒，其余提示）**：缺必填 → 退出码 2 不发请求；未知字段/类型不符 → 只提示 |
| D2 | **暴露形态 = 新子命令 `qiyu api schema <id>`**（不并入 `api list`） |
| D3 | **B 带一份校验 override 表**（`src/core/registry/validate.json`，与 `specs.json` 同目录），登记「文档必填不可靠」的接口：降级 required、定义二选一组（one-of）。B 读 params 时应用它 |
| D4 | **只对 `bodyKind: 'json'` 校验**；其余（none/xml/multipart/text/form）`--body` 原样透传不校验，`api schema` 标注 bodyKind、`api call` 提示「该接口 body 非 JSON」。⚠️ **非 json 的 callable 接口实测共 13 个**（none 9 + xml 1 + multipart 2 + text 1；2 个 form 均 `callable: false`）——见 §十一 修订 |
| D5 | **校验排在危险接口门禁（`assertConfirmed`）之前**——与既有契约「参数错误不能被门禁掩盖」一致：硬校验违规 → 2；只有 body 校验通过才轮到 `--yes` 的 4 |
| D6 | **软警告 = 结构化数组** `meta.warnings = [{kind, field?, message}]`，`kind ∈ unknown_field \| type_mismatch \| non_json_body \| alias_normalized` |
| D7 | **`--strict` 只把「可归咎调用方」的提示升级为硬拒**（`unknown_field`、`type_mismatch`）；`non_json_body`/`alias_normalized` 是 CLI 行为或能力缺口，`--strict` 下仍只提示 |
| D8 | **受控别名归一化**：override 可对已实测的字段改名登记 `aliases`（如 `editKnowledgeNoSimilars` 的 `name → question`）；校验前归一化、发送前改写 body，并在 `meta.warnings` 里以 `alias_normalized` 如实报告。**这是 B 唯一允许的 body 改写**，仅对显式登记项生效（见 §五） |
| D9 | **`api schema` 不输出 `meta.validation`**（v1 的那条固定字符串被两条审查路判为「声明了但没人读」的装饰键，删除）；改以 `meta.field_notes` 解释新字段（沿用 `api list` 的既有约定） |
| D10 | **不设 `no_body` 警告**（v1 有；v2 曾收紧到「有必填 body 字段」，但该条件会**先触发缺必填硬拒**，使该警告永不可达——见 §十一 ruling）。「忘写 `--body`」的提醒折进缺必填硬拒的消息（body 为 `undefined` 时消息显式点明「未传 `--body`」） |
| 附 | **`--no-validate`**：完全关闭 B 的校验、别名归一化与 warnings；**绝不触碰 `assertConfirmed`**（红线，见 §六） |
| 附 | **`category` 归 G1**（路线图 §八.6 允许「B 或 G1」二择；本 spec 把决定权交给 G1，见 §七）——B 不读它、也不动它 |

## 三、`api schema <id>`（D2 / D9）

新子命令，与 `api list`/`api call` 同层进 `API_USAGE`；有**自己的** `KNOWN` 集合
（`--pretty`/`--help`/`-h`），不接受 `--body`/`--yes`/`--no-validate`/`--strict`
（出现即未知参数 → 2）。

⚠️ **`schema` 的位置参数规则与 `list()` 不同**（v2.3 澄清，见 §十一 第 30 条）：`list()` 不收任何位置
参数，`callOne()` 收「接口 id + 可选 flag」。`schema` 收**恰好一个**位置参数（接口 id），无 flag。
故**不能**照抄 `list()` 的"位置参数一律报错"，也不能照抄 `callOne()` 的"首个 token 必须是 id"。
`schema` 的次序（**独立定义**，不套用另两处）：

```
1. 分离 flag 与位置参数（判据同 list/callOne：以 `-` 开头为 flag）
2. 未知 flag（不在 {--pretty,--help,-h}）→ 2（点名）
3. 位置参数 > 1 个 → 2（点名多出来的）
4. help 请求（含 --help/-h）→ 输出 API_USAGE、退出码 0
   —— ⚠️ help 优先于"缺 id"：`schema --help`（无 id）给帮助而非报错，
      与 `callOne` 的 `api call --help` 同款（help 是"请求帮助"，不是"写错 id"）
5. --pretty → 2（尚未实现，同 list/callOne）
6. 位置参数为 0 → 2（`用法：qiyu api schema <接口id>`）
7. byId(id) → 未知 id → 2
```

`--help` 不吞额外参数（与另两处一致）：`schema --help extra` → 2（extra 是多余位置参数）。

**输出**（stdout，`ok(data, meta)` 形态，退出码 0）：

```json
{
  "ok": true,
  "data": {
    "id": "ai.knowledge.search",
    "title": "获取问题列表",
    "method": "POST",
    "path": "/openapi/ai/knowledge/search",
    "callable": true,
    "dangerous": false,
    "body_kind": "json",
    "has_body_schema": true,
    "params": [
      { "name": "appKey", "in": "query", "required": true, "type": "string",
        "description": "企业的appKey", "example": "{{appKey}}", "auto": true },
      { "name": "robotId", "in": "body", "required": true, "type": "integer",
        "description": "机器人id" },
      { "name": "keyWord", "in": "body", "required": false, "type": "string",
        "description": "搜索关键词" }
    ],
    "response_shape": { "kind": "object" }
  },
  "meta": {
    "endpoint": "ai.knowledge.search",
    "field_notes": { "…": "…" },
    "note": "…（该接口 specs.json 里有 note 才输出）"
  }
}
```

> ⚠️ **样例用 `ai.knowledge.search` 而非 `ai.knowledge.addKnowledge`**（v2.3 定，见 §十一 第 42 条）：
> `addKnowledge` 是 `dangerous: true`，样例里写 `"dangerous": false` 就是一个**与事实相反**的字段值
> （契约诚实性审查的原始标准）。`search` 是 `dangerous: false` 且 body 字段一必填一可选，
> 同时展示 `required` 两种取值。`params` 只列**节选**（真实 `search` 有 5 个 body 字段）。

字段语义（逐条都是给 Agent 读的，不是装饰）：

- `params` —— ⚠️ **不是逐字节原样**（v2.3 澄清，见 §十一 第 29 条）：实现是**浅复制**每个参数对象，
  仅对 `in === "query"` 且 `name ∈ {appKey, time, checksum}` 的元素**追加** `auto: true`，
  其余键值原样保留。对应类型是 `SchemaParam = ParamSpec & { auto?: true }`（`ParamSpec` 本身
  **不含** `auto`——它是输出层加工，不是文件字段）。
- `auto: true` —— CLI 自填的鉴权 query 参数（`appKey`/`time`/`checksum`）。它们在
  `in: "query"` 里但调用方**不该也不能**通过 `--body` 传；不标注则 Agent 会以为要自己填。
  判定写死为那三个名字（与 `http.ts` 的 `signedQuery` 同源），**不**按"所有 query 都 auto"推断。
- `body_kind` —— 原样来自 params 文件。
- `has_body_schema` —— **能力**标志：「该接口有可比对的 body 参数表」，判据
  `body_kind === 'json' && body 参数数 > 0`（与 §四 `unknown_field` 的触发条件同源：没有表就不谈「未知」）。
  ⚠️ **命名刻意不叫 `body_validated`**（v1 的名字读起来像「本次 body 已通过校验」，实为「有表可比对」——
  审查判为易误判，见 §十一）。它**不代表**本次请求校验通过；本次结果看 `api call` 的 `meta.warnings`。
  唯一能让「有表却不比对」的情形是 `--no-validate`（用户显式关闭），B **不**为此再加一个
  「本次是否校验」的字段（那会是又一个「声明了没人读」的装饰键）。
- `response_shape` —— **原样透传** params 文件里的 `{"kind": "..."}` 对象。
  ⚠️ 设计稿 §5.2 写的是 `responseShape: string`（旧设计）；A 的现行接口缝（`params/*.json`）是结构化对象，
  **以 A 的产物为准**，B 不改写成字符串（见 §八.2）。
- `one_of` —— **仅当**该接口的 override 定义了 one-of 组时输出，形如
  `"one_of": [{"anyOf": ["code","shopCode"], "message": "…"}]`，与 §五 的 `oneOf` 逐字对应。
  ⚠️ **没有它 schema 会撒谎**：`relaxRequired` 已把组内字段的 `required` 降为 `false`，
  Agent 读到的就是「两者都可省」——调用时才撞硬拒。schema 必须让 Agent **调用前**就知道二选一
  （v2.3 定，见 §十一 第 35 条；原 §十二.2 开放问题就此关闭）。
- `in: "path"`/`in: "header"` 参数照原样输出、标原值（Apifox 原貌，B 不消费）。
- `meta.field_notes` —— 解释**本输出**中所有非自明键的含义（与 `api list` 同款约定：键 =
  本子命令输出的字段名，两条子命令的键集各自独立，Agent 不应跨子命令套用）。至少含：
  `has_body_schema`（=「有可比对的表」，**不代表**本次已校验）、`body_kind`、`auto`
  （CLI 自填的鉴权参数，调用方不要传）、`dangerous`（true → 调用需 `--yes`，否则退出码 4）、
  `response_shape`（**仅供参照，不做校验**）、`one_of`（若输出）。只输出不解释 = 没输出
  （v2.3 扩围，见 §十一 第 34 条）。
- `callable: false` 的接口 `api schema` **照常输出、退出码 0**（查 schema 不是调用；纯本地读，
  不经 `assertCallable`）——见 §九 验收 14。
- 未知 id → 与 `api call` 同一条 `byId` 抛错 → 用法错误、退出码 2、stdout JSON + stderr 文本。
- **params 文件缺失/畸形、override 加载失败 → 退出码 1**（`kind:'internal'`，只出 stdout）——
  `api schema` 走的是与 `api call` **同一条** `loadParams`/`loadValidationOverrides` 路径，
  错误分类一致（见 §四 错误分类、§九 验收 13）。⚠️ `schema` 的 `callOne` 式 catch 必须与
  `callOne` **共用**出口，不得各自写一份（同族错误两种表现）。

## 四、`api call` 的分级校验（D1/D4/D5/D7/D8/D10）

接入点：`callOne` 内、命令行次序门（未知/位置 → help → `--pretty`、body JSON.parse）之后，
**`byId` 之后**（必须先有 spec）、**`assertCallable` 之后**（不可调用接口不该先因 params 报错）、
**`assertConfirmed` 之前**（D5）：

```
命令行门（未知/位置 → help → --pretty，body JSON.parse）
→ byId(id)                          // 未知 id → 2（既有）
→ assertCallable(spec)              // 不可调用 → 2（既有）
→【B】file = loadParams(spec.id)    // 缺文件/畸形 → kind:'internal' → 1
       ov   = overrides[spec.id]
       ({ body, warnings } = normalizeAliases(file, body, ov))   // body 被改写（D8）
       vr   = validateBody(spec, file, body, ov, { strict })     // 硬违规 → 2，零网络请求
→ assertConfirmed(spec, --yes)      // 危险未确认 → 4（既有，D5）
→ 凭证解析 → call(spec, body)       // ⚠️ 必须用**改写后**的 body（见下）
```

⚠️ **单一 body 来源契约**（v2.3 澄清，见 §十一 第 31 条）：`call()` 收到的 body 必须是
`normalizeAliases` **改写后**的那一份——实现上就是**重新赋值** `body`（`api.ts` 现有的是
`let body`，可赋值）。**不得**在 `call()` 处重新用 `JSON.parse` 的原始值。这是**强制接线**，
不只靠验收 7 的 mock 断言兜底（否则"别名改写生效"只在测试里成立、生产路径可能漏改）。

**flag 语义**：
- `--no-validate`：跳过 `normalizeAliases` + `validateBody` 的**全部**行为（校验、别名改写、warnings）。
  ⚠️ **不跳过**任何既有的命令行检查——`--body` 的 `JSON.parse`（非法 JSON 仍 → 2）、重复 `--body`
  检查、未知/位置参数检查、`assertCallable`、`assertConfirmed` **全部照旧**。`--no-validate` 只关 B。
- `--strict`：把默认软的 `unknown_field`/`type_mismatch` 升级为硬。
- ⚠️ **`--no-validate` 与 `--strict` 同时出现 → 用法错误、退出码 2**（互斥；`--no-validate` 的语义是
  「完全关闭」，与「升级为硬」直接矛盾，静默取其一会让 Agent 无从知道哪个生效）。见 §九 验收 15。

### 顶层 body 形状契约（v2 新增，消解边界歧义）

先按 `bodyKind` 分流，再按下表判定「body 的顶层形状」。**所有**「键存在/字段比对」规则
都以本表为前提，避免 `Object.hasOwn(null, …)` 抛异常或对数组误用 `Object.keys`：

| `--body` 实参 | `JSON.parse` 后 | 判定 |
|---|---|---|
| 未传 `--body` | `undefined` | 「无 body」：若该接口有**必填** body 字段 → 走 2 号**缺必填硬拒**（消息显式点明「未传 `--body`」）；若有 body 表但无必填、或 0 body 表 → **不报**（无可归咎的错误） |
| `null` | `null` | **非对象** |
| `[]` / `[1]` | 数组 | **非对象** |
| `"x"` / `1` / `true` | 标量 | **非对象** |
| `{}` / `{"a":1}` | 普通对象 | **对象** |

- 该接口有 `in: "body"` 字段（`has_body_schema`）时：
  - **对象** → 逐字段比对（下面硬/软规则）。
  - **非对象** → **硬拒**（退出码 2）：消息说明「该接口需要 JSON 对象 body，实际是
    `null`/数组/标量」，并提示 `qiyu api schema <id>`。理由：body 表非空却传了非对象，
    服务端必然无法按字段解析——本地拦下比让它去撞 14004 更诚实（D1 的「缺必填硬拒」同族）。
- 该接口 **0 个** `in: "body"` 字段（`has_body_schema: false`，如 `tag.all`、`export.session`）时：
  顶层形状**不判**、不报——没有可比对的表，对形状的任何断言都是无根据的。
  ⚠️ **已知边界（有意接受，不是遗漏）**：这类接口传任何 body（含拼错的字段名）都**静默通过**，
  既不硬拒也不 warning。这不是能力缺口而是**证据缺口**——B 没有该接口的 body 参数表，
  任何「这个字段可疑」的断言都无根据（与 §八.1 同一条理由）。schema 侧的补偿是
  `has_body_schema: false` 让 Agent **调用前**就知道「本接口没有可查的参数表」；
  `api call` 侧**不**为此加 warning（那会是「声明了没人读」的装饰，且对 `bodyKind: none`
  的合法调用稳定误报）。见 §十一 第 36 条。

### 硬（退出码 2、发不出请求；经 `callOne` 既有 catch 的 usage 出口，stdout JSON + stderr 文本）

1. **非对象 body**（上表）：有 body 表却传了 `null`/数组/标量。
2. **缺必填**：override 后仍 `required: true` 且 body 中**键缺失或值为 `undefined`**。
   ⚠️ body 整个为 `undefined`（未传 `--body`）时也走本条（所有必填字段都「缺失」），
   消息**显式点明「未传 `--body`」**（比逐个列缺失字段更直指病因）。
   - `null` 值算**存在**（键在）——但「存在」只影响本条的缺失判定，**不**代表类型通过：
     若该字段声明了 `type`，`null` 会在软规则里触发 `type_mismatch`（`--strict` 下即硬拒）。
     §九 验收 16 钉住这个「存在 ≠ 通过」。
   - one-of 组（override 定义）：组内**任一**字段存在即满足；全缺 → 硬，消息用 override 的 `message`。
   - 消息点名缺的字段名 + 提示 `qiyu api schema <id>` 查看完整表。
3. **`--strict` 下**的 `unknown_field` / `type_mismatch`（见软列表）。

⚠️ **硬违规一旦成立即短路**：`validateBody` 返回的 warnings 在硬拒时**不输出**（失败响应里没有
`meta`，也就没有 warnings）。这条是**规范要求**，不是实现细节——§九 验收 4 依赖它（否则
「未知字段进不了软列表」就是没根据的断言，见 §十一）。

### 软（`meta.warnings`，请求照发）

4. `kind: "unknown_field"`：body（对象）里出现了不在 params body 表、也**不在该接口
   override 的 `aliases` 源键**里的键。
   ⚠️ **不存在「override 白名单」**（v1 的措辞有误，见 §十一）——override 表里唯一能让某个
   非 params 键不算未知的机制是 `aliases`（源键会被归一化，见 D8）。`relaxRequired`/`oneOf`
   列出的字段**本来就是 params 里的 body 字段**，不产生新的「白名单键」。
5. `kind: "type_mismatch"`：值的 JS 类型与声明 `type` 不符。映射：
   `string→string`；`integer/number→number`（**不**拒小数——类型表没有「必须整数」的语义层，
   拒小数是超出证据的断言）；`boolean→boolean`；`array→Array.isArray`；
   `object→非数组的 typeof 'object' 且非 null`。日期串/数字字符串**不**判 mismatch。
   `null` 值（键存在）对任何声明了 `type` 的字段都判 `type_mismatch`（除非该字段无 `type`）。
6. `kind: "non_json_body"`（D4）：`bodyKind !== 'json'` **且实际传了 `--body`**——整类只出这一条，
   不做任何字段比对；`--body` 值原样 `JSON.parse` 后传入 `call()`。
   ⚠️ **必须带「实际传了 body」这一条**：`bodyKind: "none"` 的接口（10 个，其中 **9 个 callable**、
   1 个不可调用 `event.queueEnter`；如 `export.session`）正常用法就是**不传 body**——此时不该有任何 warning。对 `bodyKind: "none"`
   却传了 body 的调用，这条的含义是「该接口按文档不接受 body，你传的值已被原样发送」。
   ⚠️ **命令行表达**：`--body` 的值经 `JSON.parse`，故「原始 XML 文本」`<foo/>` **不能**直接作为
   命令行 body（`JSON.parse('<foo/>')` 抛错 → 既有的「不是合法 JSON」退出码 2）。B 的语义是
   「**JSON.parse 后的 JS 值**原样透传」；要传 XML 需写成 JSON 字符串字面量 `'"<foo/>"'`。
   B 不承诺帮调用方构 XML/multipart。
7. `kind: "alias_normalized"`（D8）：调用了 `aliases` 的源键、已被改写为服务端字段名。
   如实报告「`name` → `question`」；**永不**被 `--strict` 升级（这是该接口的预期用法，不是调用方错误）。

### 成功输出的接线

```ts
return ok(r.payload, {
  endpoint: spec.id,
  ...(warnings.length ? { warnings } : {}),   // 结构化（D6）
  ...(r.notFound ? { not_found: true, warning: '接口返回成功但无数据' } : {}),
  ...(spec.note ? { note: spec.note } : {}),
})
```

`warnings` 与既有 `warning`（not_found 的单数字符串）**并存不冲突**：`warning` 是信封层的
「成功但无数据」，`warnings` 是请求构建层的结果。`api call` 的 meta **没有** `field_notes`
（那是 `api list`/`api schema` 的），所以每条 warning 的 `message` 必须自带完整语境。

**四种 `kind` 的 `message` 最小必含语义**（v2.3 定，见 §十一 第 32 条——不规定模板则各实现措辞不一，
Agent 学不到稳定规则；`field` 字段独立承载字段名，`message` 负责后果与下一步）：

| kind | `field` | `message` 必须说清 |
|---|---|---|
| `unknown_field` | 未知字段名 | 「该字段不在本接口的文档参数表中，**服务端可能忽略它**」 |
| `type_mismatch` | 不符字段名 | 「声明类型 `<type>`，实际是 `<实际类型>`」（两者都要有） |
| `non_json_body` | 无 | 「本接口 bodyKind 是 `<kind>`，你的 `--body` 已被**原样发送、未经字段校验**」 |
| `alias_normalized` | 源字段名 | 「`<源>` 已按本接口约定改写为 `<目标>` 发送；**请求正常，无需重试**」 |

⚠️ **`alias_normalized` 必须显式写"无需重试"**：它是**信息性**事件（退出码 0 的成功调用）。
一个"见 warning 就改输入重试"的 Agent，若把 `name` 改成 `question` 再调一次**危险接口**
（`editKnowledgeNoSimilars` 是 `dangerous:true`），会**重复执行一次写操作**。message 里那句
「请求正常，无需重试」是这条警告唯一的安全价值——不得省略。

`warnings` 的**顺序**：按 `params` 表顺序、再按 body 键的出现顺序（稳定，便于测试与 Agent 解析）。

### 错误分类（v2 新增，消解「usage 2 vs internal 1」冲突）

- **硬校验违规**（`validateBody` 抛出的普通 `Error`，**不挂 `kind`**）→ 落进 `callOne` catch 的
  usage 兜底分支 → 退出码 **2**、双通道（stdout JSON + stderr 文本）。实现**不得**给它挂
  `kind: 'internal'`/`'validation'` 之类，否则会走业务错误分支变成退出码 1。
- **params 文件缺失/畸形、override 加载失败**（打包缺陷，**不是**调用方写错）→ 抛带
  `kind: 'internal'` 的 `Error` → 落进 catch 的 `err.kind && err.kind !== 'usage'` 分支 →
  退出码 **1**（业务错误，只出 stdout JSON，不出 stderr）。**绝不**报成 usage 2（那会让 Agent
  去改命令行，而真正的问题是产物缺文件）。
  ⚠️ **`internal` 的错误契约必须完整**（v2.3 定，见 §十一 第 33 条），否则它和普通业务错误
  （同是退出码 1、同是只出 stdout）无法区分，Agent 不知道该改什么：固定
  `code: 'internal'`、`kind: 'internal'`、`retryable: false`，
  `message` 必须说明「**这是 CLI 的打包/注册表缺陷，不是你的请求或服务端的问题**」，
  `hint` 给出方向（「重装或报告此问题；`params`/`validate.json` 缺失或损坏」）。
  Agent 据此**不应**修改请求重试。

## 五、校验 override 表（D3 / D8）

**路径**：`src/core/registry/validate.json`（与 `specs.json` 同目录、同款加载）。

⚠️ **为什么不在 `overrides/` 下**（v2.2 修正，见 §十一 第 26 条）：`src/core/registry/overrides/`
（A 的 `ids/paths/attrs.json`）是**构建期**目录——生成管线读它、**不打进 dist**（实测
`dist/core/registry/` 只有 `index.js`/`params/`/`specs.json`，无 `overrides/`；`copy-params.mjs`
只拷 `params/`）。B 的 `validate.json` 是**运行时**消费，若放进 `overrides/` 则打包后 CLI
根本读不到它。放在 `specs.json` 旁边、用**同款静态 JSON import**，则由 tsc 自动拷进 `dist`
（`specs.json` 正是这么进 dist 的），无需改 `copy-params.mjs`。

**形状**（v2）：

```json
{
  "merchant.account.login": {
    "note": "上游自相矛盾：接口描述要求 code/shopCode 必填其一，schema 却把三者全标必填。按接口描述建模为 one-of。",
    "relaxRequired": ["code", "shopCode"],
    "oneOf": [{ "anyOf": ["code", "shopCode"], "message": "code 与 shopCode 必填其一（都存在时以 code 为准）" }]
  },
  "ai.knowledge.editKnowledgeNoSimilars": {
    "note": "设计稿 §5.4：该接口取 question，复用 editKnowledge body 形态的调用方会传 name——改名必须在请求构建器处理，不能留给调用方。",
    "aliases": { "name": "question" }
  }
}
```

> ⚠️ **`tag.all` 不进这张表**（v2.3，见 §十一 第 28 条）：它 `bodyKind: json` 但 **0 个 body 参数**，
  §四 的比对本就全部跳过（`has_body_schema: false`）——给它写任何 override 都是**零效果的死配置**。
  v1/v2 曾设想一个 `bodyIgnored` 标记，实测**没有任何接口需要它**（凡「body 语义与文档不符」的接口，
  要么本就没有 body 参数表，要么该用 `relaxRequired`/`aliases` 精确表达），故**不设该字段**
  （与删 `keepRequired` 同一条理由：零效果字段 = 「声明了但没人读」）。

字段语义：

- `relaxRequired: string[]` —— 把列出的字段 `required` 降为 false。**加载期校验**：每个元素
  必须是该接口 params 里 `in: "body"` 且**当前 `required: true`** 的字段名（引用不存在的字段、
  或引用本就非必填的字段 → 加载即抛：前者是拼写错误，后者是无效果的死配置）。
- `oneOf: {anyOf: string[], message: string}[]` —— 组内任一存在即满足；全缺 → 硬违规，用 `message`。
  `anyOf` 至少 2 个元素；每个元素必须是该接口的 body 字段名。
- `aliases: Record<string,string>` —— **源键 → 服务端字段名**（如 `name → question`）。语义（D8）：
  1. **归一化在校验之前**：调用方传 `name` 时，先当作 `question`（`name` 不再算 `unknown_field`，
     `question` 也不再算缺必填）。
  2. **发送前改写 body**：把 `name` 键改写为 `question`（值是调用方给的值）。
  3. **冲突 → 硬拒**：若 body 里**同时**有源键与目标键（`name` 和 `question` 都在）→ 用法错误 2
     （歧义，消息要求只传其一）。
  4. **如实报告**：出 `alias_normalized` 警告（永不升级）。
  5. 目标键必须是该接口 params 里的 body 字段名（加载期校验）；源键**不得**是 body 字段名
     （否则它本就是合法字段，不该被别名覆盖 → 加载期抛）。
- `note` —— 进 override 的理由。⚠️ 它是**唯一**不进 CLI 输出、只供 review 的字段（v1 因此被
  判为「会腐化的注释」，见 §十一）。缓解：`note` 必须写明**证据来源**（设计稿节号 / 实测日期），
  且 §九 验收 12 要求「override 引用的字段必须存在于 params」在加载期强制——证据漂移的下限防线。
- ⚠️ **危险接口的约束**：`relaxRequired`/`oneOf`/`aliases` **允许**作用于 `dangerous: true` 的接口
  （`editKnowledgeNoSimilars` 本身是危险接口且确需 `aliases`），但**必须在 `note` 里写明实测/文档依据**，
  且新增这类条目时测试要逐条钉住——见 §八.5。

**加载规则（fail-closed，与 `loadSpecs` 同款）**：顶层必须是对象；每条 key 必须是注册表里
存在的 id；`relaxRequired`/`oneOf.anyOf`/`aliases` 的值必须满足上面的引用约束。
加载失败 = B 不可用（宁可炸，不可静默变成「没有 override」——
那会把 one-of 接口的合法调用硬拒掉，正是 D3 要防的事）。

**初始收录范围（有实测/文档证据才写）**：`merchant.account.login`（one-of）、
`ai.knowledge.editKnowledgeNoSimilars`（aliases，设计稿 §5.4）。
其余不录——**override 是证据驱动的，不是预防性的**。

## 六、退出码与 flags

| 情形 | 退出码 | 说明 |
|---|---|---|
| 硬校验违规（非对象 body / 缺必填含 one-of / strict 下 unknown·type / alias 冲突） | **2** | 用法错误，双通道，经 catch 的 usage 出口（普通 `Error`，不挂 kind） |
| `--no-validate` 与 `--strict` 同传 | **2** | 互斥（v2） |
| 未知 id / 不可调用 / `--body` 非法 JSON / 未知 flag | 2 | 既有 |
| **params 文件缺失或畸形 / override 加载失败** | **1** | internal（打包缺陷），挂 `kind:'internal'`，只出 stdout |
| 危险未确认 | 4 | 既有；B 的硬校验在其**之前**（D5） |
| 软警告请求成功 | 0 | `meta.warnings` 随成功 meta 输出 |

`API_USAGE` 增补：`schema` 子命令行、`--no-validate`、`--strict`。
`KNOWN` 集合：**只给 `callOne` 加** `--no-validate`/`--strict`（`api list` 不校验 body）；
`schema` 有独立 `KNOWN`（`--pretty`/`--help`/`-h`）。

**红线（安全审查确认，须测试钉死）**：`--no-validate` **只**关闭 B 的校验与 warnings，
**绝不**影响 `assertConfirmed`——危险接口带 `--no-validate`、body 任意或缺失、**无 `--yes`** 时
**仍返回 4**。见 §九 验收 17。

⚠️ **退出码 2 与 4 的语义分工必须让 Agent 分得清**（安全审查建议）：**2 = 参数写错了，改参数重来，
不需要人类介入**；**4 = 不可逆操作，必须停下向人类确认**。D5（校验先于门禁）会让一个"危险接口 +
缺必填 + 无 `--yes`"的调用先得到 2——这是**有意的**：Agent 该先修参数，修好后**必然**撞上 4 才去问人。
B 的硬拒消息里**不得**出现任何"需要人类确认"的暗示（那会把 2 与 4 混淆）；`API_USAGE` 的退出码说明
沿用既有的「2 用法错误 · 4 需要 --yes」，不新增歧义。

## 七、`category` 处置（路线图 §八.6 的 B 侧答案）

**B 不动它**——既不删数据、也不补类型/输出。`EndpointSpec` 本就没声明 category、`api list`
本就不输出，B 的变更不涉及它。**决定权归 G1**（删数据要改 A 的生成脚本并再生 154 条、补输出
要有真实消费方，两者 B 都不做）。路线图 §八.6 已同步改为「已归 G1」。

## 八、边界与风险

1. **params 与真实服务端的偏差**（D2 的根源）：文档字段表与真实返回不一致是实测常态。因此
   B 的硬校验**只覆盖「缺必填 + 非对象 body」这一最不可能出错的子集**，其余降为提示。
2. **`responseShape` 形态**（v2 新增说明）：设计稿 §5.2 是 `string`，A 产物是 `{kind}` 对象。
   **以 A 的产物为准**，B 原样透传、不改写。来源优先级：`params/*.json` 的 schema 由 A 定义。
3. **`--strict` 的安全边界**（v2 新增）：`unknown_field` 的判定依赖 params 完整性，而文档常不全——
   故 `--strict` 的硬拒**可能误伤合法调用**（params 漏记了服务端实际接受的字段）。**「严格」≠「正确严格」**。
   文档/help 必须写明：`--strict` 只做「本地参数表闭集一致性检查」，不构成对服务端行为的保证。
4. **`--strict` 的升级范围**（D7）：只有 `unknown_field`/`type_mismatch` 被升级；
   `non_json_body`/`alias_normalized` 永远软，`--strict` 不改变它们。
5. **override 腐化 / 被滥用**：`note` 是唯一不进输出的字段，会随文档漂移。缓解：加载期强制
   「引用必须存在」（§五）、新增条目必须带证据并逐条测试。
6. **`has_body_schema` 的判据分叉**（§三/§四）：`body_kind === 'json'` 与「body 表非空」不总一致。
   实现与测试必须分别钉住这两个条件，合并成一个布尔会造出「json 但无表」时声称 validated 的谎言。
   ⚠️ **判据是「body 参数数 > 0」，与 bodyKind 无关**（v2.3 澄清）：实测 154 里有 **5 个**
   `bodyKind: json` 却 0 body 参数（`tag.all`、`tag.batchUpdate`、`track.event.set`、
   `ipcc.calltaskdetail.update/delete`）——它们 `has_body_schema: false`、**不比对**（§四 静默通过边界）。
   4 个是危险接口，故本 spec 的验收**只用 `tag.all`**（唯一非危险的那个）。反过来，
   `kefu.add` 是 `bodyKind: xml` 却有 14 个 body 参数——仍 `has_body_schema: false`（D4 只校验 json）。
   ⚠️ 因此**测试禁止用 `has_body_schema === (bodyKind === 'json')` 做断言**（该式在 9 个接口上为假）。
7. **同名字段跨 `in`**（理论边界）：实测 0 个，但加载期仍应加护栏——同一接口里同一 `name`
   不得同时出现在 `in: "body"` 与 `in: "query"`（否则 `(name,in)` 身份歧义）。属防御性检查。

## 八之二、联动文案修正（契约诚实性审查：B 合入后不改这些文字就是「说了假话」）

B 上线后，**现有**两处文字会与代码矛盾，必须随实现一起改（**这是 B 的交付内容，不是可选项**）：

1. **`README.md:149`** —— 现值：「请求参数校验：`api call` 的 `--body` 不做字段校验，也**无法**校验」。
   B 之后应改为（逐字建议）：
   > 请求参数校验：`api call` 的 `--body` 会与注册表参数表比对——**缺必填字段会拒绝**
   > （退出码 2），未知字段/类型不符会以 `meta.warnings` 提示（`--strict` 可升级为拒绝，
   > `--no-validate` 可关闭）。参数表见 `qiyu api schema <id>`。
   > ⚠️ 校验只依据文档生成的参数表，**不构成对服务端行为的保证**；**响应体不做校验**。
   > ⚠️ 校验发生在**危险接口确认门禁之前**：危险接口即使 body 合法，仍会返回 **4**（需要 `--yes`）——
   > 校验通过 ≠ 可以直接发出，写接口仍需显式确认。
2. **`src/commands/api.ts` 的 `field_notes.request_schema`**（`api list` 的 meta）——
   现值：「本 meta **不提供**接口的请求参数表（`params`）与响应形状（`responseShape`）……本 CLI
   无法校验其字段是否正确」。
   B 之后应改为（逐字建议）：
   > 本 meta 不含参数表（体积考虑）；用 `qiyu api schema <id>` 查该接口的 `params`/`response_shape`。
   > `api call --body` 会做**有限**校验（缺必填拒绝、未知字段/类型提示）——见 `api schema` 的
   > `meta.field_notes`。⚠️ **响应体不做校验**，`response_shape` 仅供参照。

   ⚠️ **键名口径统一**：上面两处建议文案一律写 **`response_shape`**（下划线）——那是
   `api schema` 输出里的**实际键名**；旧文里的 `responseShape` 是设计稿 §5.2 的 TS 字段名，
   不是 CLI 输出键。文案面向 Agent，写错键名会让它去读一个不存在的键（v2.3 定，见 §十一 第 37 条）。
   ⚠️ **不得只机械删旧句**：旧句里「无法校验」是当时的事实，删掉后必须补上**新的事实**（校验了什么、
   没校验什么），否则会从「说了假话」变成「什么都没说」，而 Agent 无从判断边界。特别是
   **响应体仍不校验**这一点必须保留——否则 Agent 会以为 `response_shape` 被用上了。
3. 路线图 §八.7（「params 无运行时消费方」）在 B 合入后应标记为**已关闭**。


## 九、验收判据（spec 级，供实施计划展开为测试）

1. `qiyu api schema ai.knowledge.search` → 0；stdout 含 `body_kind:"json"`、
   `has_body_schema:true`、`params` 里 `appKey` 带 `auto:true`、`robotId` 为 `required:true`；
   `meta.field_notes` 存在；`data` 里**没有** `one_of` 键（本接口无 one-of 组，验收 25 的另一半）；
   `meta.note` **不输出**（该接口 specs.json 无 note；这是 D9 后 schema 的正确行为——
   `addKnowledge` 那种「有 note 就带上」才是会输出它的例子）。
2. `qiyu api schema 不存在的id` → 2；stdout `{"ok":false,…}`、stderr 有点名的 `byId` 消息。
3. `qiyu api call ai.knowledge.addKnowledge --body '{"name":"x","answer":"y","similars":[],"validitySwitch":1,"categoryId":1}'`
   （**只缺** `robotId`；其余必填齐）→ **2、零网络请求**（mock fetch 断言未被调用）、stderr 点名 `robotId`、
   stdout `error.kind==="usage"` 且**不含** `confirm_required`。
4. 同上 body 再加 `"bogus":1` → 仍 **2**（硬拒短路，**不**输出 warnings——验收 §四 的短路规则）。
   ⚠️ 3/4 之所以是 2 而不是 4：`ai.knowledge.addKnowledge` 是**危险接口**，但 D5 让校验先于门禁——
   缺必填在本地拦下，根本走不到 `--yes` 门禁。这**正是** D5 的验收。
5. **改用非危险接口** `ai.knowledge.search`（必填 body 字段仅 `robotId`，`dangerous:false`）：
   `--body '{"robotId":1,"bogus":1}'` → **0**，`meta.warnings` 含 `{kind:"unknown_field", field:"bogus"}`。
   （不用 addKnowledge：它是危险接口，合法 body 会撞 `--yes` 门禁返回 4，验不到「软警告 + 成功」。）
6. `merchant.account.login`（**危险接口，须加 `--yes`**）只传 `userName+code`（缺 `shopCode`）→ **0**
   （one-of 满足、不误拒）；三者全缺 → 2 且消息来自 override 的 `message`（缺必填在校验期拦下，早于门禁）。
7. `ai.knowledge.editKnowledgeNoSimilars`（危险接口，加 `--yes`）传
   `--body '{"id":1,"robotId":2,"name":"q","answer":"a","validitySwitch":1,"categoryId":1,"ruleType":0,"channelAnswers":[]}'`
   （用源键 `name`，其余必填齐）→ **0**；`meta.warnings` 含 `{kind:"alias_normalized", field:"name"}`，
   且**实际发给 `call()` 的 body 用 `question`**（mock 断言）；`name` 不产生 `unknown_field`。
   同 body 再加 `"question":"q2"`（源键与目标键都在）→ **2**（歧义硬拒）。
8. `qiyu api call tag.all --body '{"foo":"bar"}'` → **0**，**不出** `unknown_field`——因为 `tag.all`
   有 0 个 body 参数（`has_body_schema:false`），§四 的比对本就跳过（无需任何 override）。
9. **非 json body**（用**非危险**的 `icoutcall.phone.getLineList`，`bodyKind:"none"`、`callable`、`dangerous:false`）：
   带 `--body '"x"'` → **0**、`meta.warnings` 含 `{kind:"non_json_body"}`、请求照发（mock）。
   （⚠️ 不用 `kefu.add`：它是危险接口，不带 `--yes` 会返回 4，验不到「警告 + 成功」。xml 的透传路径
   与 none 走的是同一段 `bodyKind !== 'json'` 逻辑。）
10. `icoutcall.phone.getLineList`（bodyKind none、0 body 参数、非危险）不带 `--body` → **0、无任何 warning**；
    `ticket.search`（12 个 body 字段全可选、非危险）不带 `--body` → **0、无任何 warning**（无必填 → 不报，D10）；
    `ai.knowledge.addKnowledge`（危险）不带 `--body` → **2**（有必填 → 缺必填硬拒**先于**门禁，
    消息显式点明「未传 `--body`」；⚠️ 是 2 不是 4，D5）。
11. 危险接口 `message.send` 缺必填（body 有必填 `uid/msgType/content`）+ 无 `--yes` → **2**（不是 4，D5）；
    补必填 + 无 `--yes` → **4**（`needs_confirmation`、含确认字段）。
12. `validate.json`：加一个不存在的 id → 加载即抛；`relaxRequired` 引用不存在的字段 / 引用非必填字段
    → 抛；`aliases` 的目标键不存在 / 源键恰是 body 字段 → 抛。消息点名接口 id 与字段名。
    ⚠️ **测试方式**：这些分支用**合成数据**直接调纯函数 `validateOverrides(raw, specs, paramsFor)`
    （§十.0 两段式），**不**去改真实的 `validate.json`（模块级常量，改了要重启进程，且会污染其他用例）。
    另有一条**集成级**验收：`loadValidationOverrides()` 的模块初始化失败 → 由 `cli.ts` 入口
    `.catch()` 兜住 → 退出码 **1**、`kind:"internal"`、**不出现未捕获堆栈**（§十.0 加载时机第 1 条）。
13. **params 文件缺失/畸形** → 退出码 **1**、`kind:"internal"`、**不是** usage 双通道
    （构造：对某接口临时移除/改坏 `params/<id>.json`，断言 call 与 schema 行为一致）。
14. `qiyu api schema crm.modifyOrder`（`callable:false`）→ **0**，输出照常（不经 `assertCallable`）。
15. `--no-validate --strict` 同传 → **2**。
16. `--body '{"robotId":null}'`（用非危险的 `ai.knowledge.search`，必填 `robotId` 值为 null）：
    普通模式 → **0** + `type_mismatch`；`--strict` → **2**。钉住「存在 ≠ 通过」。
17. **红线**：危险接口带 `--no-validate`、body 任意/缺失、无 `--yes` → **4**（`--no-validate` 不削弱门禁）。
18. `--body '[]'` / `'null'` / `'"x"'` 对「有 body 表」的**非危险**接口（`ai.knowledge.search`）→ **2**
    （非对象硬拒，先于门禁）；对 0 body 表的**非危险**接口（`icoutcall.phone.getLineList`）→ 不因形状报错。
    ⚠️ 不用 `export.session`（危险接口，形状不报错也会撞门禁返回 4）。
19. `--no-validate` 下 B 完全静默（用**非危险**接口验，否则会撞门禁返回 4）：
    对 `ai.knowledge.search` 传 `--body '{}'`（缺 `robotId`）→ 不再硬拒，**请求照常构造并交给
    `call()`**（断言 mock 的 `fetch` **已被调用**，即 `call()` 确实走到网络层；测试中**不产生真实网络流量**）；
    9 的 `non_json_body`、7 的 `alias_normalized` 等 warnings 一律不再输出；
    7 的别名改写也不再发生（`name` 原样发送，用非危险的等价场景验）。
    **危险接口仍需 `--yes`**（见 17）。
20. `--strict` 下 5（`ai.knowledge.search` 带 `bogus`）→ **2**；9 的 `non_json_body`、7 的 `alias_normalized`
    仍只提示（D7）。
21. **生成确定性不受影响**：`validate.json` 不进生成输出；`generate.mjs` 重跑后 `specs.json` 与
    154 份 params 字节不变（复用/扩展 `tests/registry/generate.test.ts`）。
22. `npm test` 全绿、`npm run typecheck` 0 错误；既有计数型断言（154 等）同步核对。
23. **联动文案**（§八之二）：`README.md` 与 `api list` 的 `field_notes.request_schema` 已改为
   与实现一致的新文案；断言二者**不再**含「不做字段校验/无法校验/不提供 params」等旧表述，
    且**保留**「响应体不做校验」的说明。
24. **打包后能读到 `validate.json`**（§五 路径说明的验收）：`npm run build` 后
   `dist/core/registry/validate.json` **存在**；从**非仓库目录**运行打包产物（如
   `node <repo>/dist/cli.js api call ai.knowledge.search --body '{"robotId":1}'`）时，
   override 仍生效（`merchant.account.login` 的 one-of 在打包产物里同样不误拒）。
   —— 钉住「运行时文件确实进了 dist、且路径不依赖 CWD」。
25. **`api schema merchant.account.login` 输出 `one_of`**（§三）：`data.one_of` 存在且
   `[0].anyOf` 含 `code`/`shopCode`、`message` 与 override 逐字一致；同时 `params` 里
   `code`/`shopCode` 的 `required` 已为 `false`（relaxRequired 生效）。
   对**无** one-of 的接口（如 `ai.knowledge.search`）→ 输出里**没有** `one_of` 键（不是 `[]`/`null`）。
26. **`api schema` 的 internal 出口**（§三/§四 错误分类）：对某接口临时移除/改坏
   `params/<id>.json` 后 `qiyu api schema <id>` → **1**、`kind:"internal"`、`retryable:false`、
   **stderr 空**；与验收 13 的 `api call` 行为**逐字段一致**（同一出口，不是两份实现）。

## 十、测试计划（文件落点，v2 新增）

### 10.0 新增类型与函数（可实现性审查 A-严重：v1 未定义，实施者无从下手）

B 必须新建以下符号（现有 `src/core/registry/index.ts` 只有 `EndpointSpec`，无 params 相关类型）：

```ts
// src/core/registry/params.ts
export type BodyKind = 'json' | 'none' | 'form' | 'xml' | 'multipart' | 'text'
export interface ParamSpec {
  name: string
  in: 'query' | 'body' | 'path' | 'header'
  required: boolean
  type?: string          // Apifox 展示类型：string|integer|number|boolean|array|object（实测穷尽）
  description?: string
  example?: string
}
export interface ResponseShape { kind: string }
export interface ParamFile {
  params: ParamSpec[]
  bodyKind: BodyKind
  responseShape: ResponseShape
}
/** 惰性读 + 缓存；缺文件/畸形 JSON/结构非法 → 抛 kind:'internal'（§四 错误分类）。
 *  ⚠️ 生产环境**每个 id 都有** params 文件（实测 154/154），故返回值**非 null**；
 *  「该接口没有 body 表可比对」（如 `tag.all`：json 但 0 body 参数）由**文件内容**表达，
 *  不由 null 表达 —— 调用方拿到 `ParamFile` 后按 `bodyKind` 与 body 参数数自行判定。 */
export function loadParams(id: string): ParamFile
/** 运行时校验 params 文件结构（in/required/type/bodyKind 枚举；同名跨 in 护栏），失败即抛 */
export function validateParamsFile(id: string, raw: unknown): ParamFile
```

```ts
// src/core/validate.ts
export interface Violation { kind: string; field?: string; message: string }
export interface ValidateResult { hard: Violation[]; soft: Violation[] }
/** 归一化别名（D8）：返回改写后的 body 与 alias_normalized 警告；源/目标键冲突 → 抛（硬）。
 *  ⚠️ **非普通对象（含 `undefined`/`null`/数组/标量）原样返回 `{ body, warnings: [] }`** ——
 *  别名扫描只对普通对象做，绝不在 `undefined` 上调 `Object.keys`/展开（那会抛未分类异常，
 *  使"未传 --body"走不到 §四 的缺必填消息）。无 `aliases` 或非对象 → 零开销短路。 */
export function normalizeAliases(
  file: ParamFile, body: unknown, ov: ValidationOverride | undefined,
): { body: unknown; warnings: Violation[] }
/** 纯函数：顶层形状契约 + 硬/软规则；不碰 I/O。
 *  `file` 为 `loadParams` 的结果（生产非 null）；`ov` 为该接口的 override（可能 undefined）。
 *  ⚠️ `hasBodySchema` 的判据是「`file.params` 里 `in==='body'` 的个数 > 0」，**与 `bodyKind` 无关**
 *  （§八.6：5 个 `json` 接口 0 body 参数、`kefu.add` 是 `xml` 却有 14 个 body 参数）——
 *  实现必须由这个函数从 `file` 现算，**不要**另存一个可能与 `bodyKind` 混同的布尔。 */
export function validateBody(
  spec: EndpointSpec, file: ParamFile, body: unknown,
  ov: ValidationOverride | undefined, mode: { strict: boolean },
): ValidateResult
```

```ts
// src/commands/api.ts（`api schema` 的输出层加工，不是文件字段）
/** `ParamSpec` 的浅复制 + `auto`：见 §三 `params` 说明。`auto` 只加给 query 里的鉴权参数 */
export type SchemaParam = ParamSpec & { auto?: true }
```
```

```ts
// src/core/registry/validation-overrides.ts（或并入 params.ts）
export interface ValidationOverride {
  note?: string
  relaxRequired?: string[]
  oneOf?: { anyOf: string[]; message: string }[]
  aliases?: Record<string, string>
}
/** 纯函数：fail-closed 校验（§五 加载规则），坏数据抛 kind:'internal'。可注入测试数据 */
export function validateOverrides(
  raw: unknown, specs: readonly EndpointSpec[], paramsFor: (id: string) => ParamFile,
): Record<string, ValidationOverride>
/** 生产入口：静态 import validate.json → validateOverrides（与 loadSpecs 同款两段式） */
export function loadValidationOverrides(): Record<string, ValidationOverride>
```

⚠️ **两段式**（对齐既有 `loadSpecs(raw)` 的写法：纯函数收 `raw`、模块级常量做生产入口）——
`validateOverrides` 收原始值 + 依赖注入，验收 12 的每条 fail-closed 分支（坏 id、坏字段引用、
alias 源/目标非法）都能用**合成数据**直接测，不必去改真实文件；
`loadValidationOverrides()` 只是 `validateOverrides(raw, allEndpoints(), paramsFor)` 的薄包装。

⚠️ **`validate.json` 用静态 JSON import**（与 `specs.json` 同款）：
`import raw from './validate.json' with { type: 'json' }`——tsc 会把它拷进 `dist`，
无需改 `copy-params.mjs`（见 §五 路径说明）。**不**用 `readFileSync`（那需要额外的打包步骤，
而静态 import 已由既有机制覆盖）。

**加载机制**（可实现性审查 A-严重）：`params.ts` 以**自身模块位置**为根定位文件，源码与 `dist` 同构
（`copy-params.mjs` 已把 `params/` 拷到 `dist/core/registry/params/`）：

```ts
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
const url = new URL(`./params/${id}.json`, import.meta.url)
const raw = JSON.parse(readFileSync(fileURLToPath(url), 'utf8'))
```

**不**用动态 `import()`（ESM 下需 import attributes、缓存语义复杂），**不**用相对 CWD 的路径
（CLI 从任意目录启动会找不到文件）。

**override 的加载时机与失败范围**（v2.3 澄清，见 §十一 第 40 条）：`validate.json` 在
**模块初始化时**加载并校验，与 `specs.json`（`const SPECS = loadSpecs(raw)`）**同款**——
`const OVERRIDES = validateOverrides(raw, allEndpoints(), loadParams)` 是一个模块级常量，
不是每次调用重读。三条后果都必须是有意的：

1. **失败即模块初始化抛错** → 由 `cli.ts` 入口的 `.catch()` 兜住 → 退出码 **1**、`kind:'internal'`
   （不是未捕获堆栈）。验收 12 的「启动即抛」指的是这一层。
2. **失败范围是整个 CLI**，不只 B：`api.ts` 静态 import 了该模块，故 `qiyu auth whoami` /
   `api list` 也会一起失败。**Ruling**：接受。理由——(a) 与 `specs.json` 的既有行为一致
   （它同样在模块初始化抛错、同样拖垮所有命令），不引入第二种失败语义；(b) `validate.json`
   缺失/畸形意味着 **dist 打包不完整**，此时整份产物都不可信，"宁可炸"是 §五 已定的方向；
   (c) 备选方案（惰性加载 + 缓存 + 首次使用才炸）会让 `api call` 的失败点随调用次序漂移，
   测试与 Agent 都更难预期。
3. **只读被引用的接口**：`validateOverrides` 只对 `validate.json` 里出现的 id 调 `paramsFor`，
   故模块初始化**不会**去读全部 154 份 params 文件（当前只读 2 份），启动开销可忽略。

### 10.1 测试文件落点

- `tests/core/registry/params.test.ts`（新）：`loadParams` 惰性加载 + 缓存；缺文件/畸形 JSON →
  `kind:'internal'`；结构校验（`in`/`required`/`type`/`bodyKind` 枚举）；同名跨 `in` 护栏。
- `tests/core/validate.test.ts`（新）：纯函数 `normalizeAliases`（归一化、改写、源/目标键冲突）
  与 `validateBody` 的硬/软全规则；顶层形状契约（对象/数组/标量/null）；
  one-of；`relaxRequired`；`--strict` 升级集合逐 kind 钉住；warnings 顺序稳定。
- `tests/core/registry/validation-overrides.test.ts`（新）：`validateOverrides` 的全部 fail-closed 分支
  （坏 id、坏字段引用、alias 源/目标非法）——用**合成数据**直接调纯函数。
- `tests/commands/api.test.ts`（扩展）：`api schema` 成功/未知 id/`--help`/`--pretty`/位置参数/`callable:false`；
  `call` 硬违规退出码与双通道、`--no-validate`/`--strict` 冲突、`meta.warnings` 两态、
  危险接口次序回归、`--no-validate` 不削弱门禁。
- `tests/registry/generate.test.ts`（扩展）：`validate.json` 不进生成、确定性不变。
- **测试基建**：统一 `beforeEach` 注入 `QIYU_APP_KEY`/`QIYU_APP_SECRET`（否则 `resolveCredentials`
  先报 auth_missing，验不到请求路径）；`vi.stubGlobal('fetch', …)` 且硬违规用「被调用即失败」的 mock；
  **不使用真实凭证/网络**。既有 350 用例若含计数哨兵需同步更新。

## 十一、修订记录

**v2 轮**（6 路独立只读审查）：审查维度 事实对拍 / 内部自洽与边界 / 上游一致性 / 契约诚实性 /
安全与门禁 / 可实现性与测试。**v2.3 轮**（3 路对抗性证伪审查）：审查任务是**证伪**——
专门寻找「文本与代码/数据不符」「承诺了但做不到」「定义了但没消费方」的具体反例，
每条发现均经 controller 回代码/数据复核。据其发现修订如下：

| # | 修订 | 来源 |
|---|---|---|
| 1 | D4 的「非 json callable 共 6 个」→ **13 个**（实测 none 9+xml 1+multipart 2+text 1） | 事实对拍 |
| 2 | 新增 D8 **别名归一化**（`editKnowledgeNoSimilars` 的 `name→question`，设计稿 §5.4 要求） | 上游一致性 + 用户拍板 |
| 3 | 新增 D9：**删 `meta.validation`**（固定值、无消费方），改 `meta.field_notes` | 契约诚实性 + 用户拍板 |
| 4 | **删除 `no_body` 警告**（v1 有）。契约诚实性审查指出它对 `ticket.search` 类合法全量调用稳定误报、却被承诺「无害」；v2 先收紧到「有必填 body 字段」，但**该条件会先触发缺必填硬拒**，使警告永不可达（死代码）。**Ruling**：删除该 kind，把「未传 `--body`」的提醒折进缺必填硬拒的消息。用户选项本意（「别在合法全量调用上误报」）由此忠实实现 | 契约诚实性 + 用户拍板 + controller 自审 |
| 5 | 新增**顶层 body 形状契约**（对象/数组/标量/null 三分） | 内部自洽（2 路） |
| 6 | 删除 v1 误提的「override 白名单」；明确唯一机制是 `aliases` | 内部自洽 |
| 7 | 新增 `--no-validate` 与 `--strict` **互斥 → 2** | 内部自洽 + 可实现性 |
| 8 | 新增**硬违规短路**规则（硬拒时不输出 warnings） | 内部自洽 |
| 9 | `body_validated` → **`has_body_schema`**；`bodyIgnored` 组合语义闭合 | 契约诚实性 + 内部自洽 |
| 10 | 删除 `keepRequired`（与 relax 无交集、零效果、语义不闭合） | 契约诚实性 |
| 11 | 新增**错误分类**：硬违规 usage 2 vs params/override 缺陷 internal 1 | 可实现性 |
| 12 | ~~新增 `bodyIgnored` 禁用于 dangerous 接口~~ → **被 28 取代**（`bodyIgnored` 整个删除，风险随字段消失） | 安全与门禁 |
| 13 | 新增 `responseShape` 形态说明（A 产物覆盖设计稿旧 `string`） | 上游一致性 |
| 14 | 新增 `rateLimit.scope` 声明为「B 不消费、归 G1」 | 上游一致性 |
| 15 | 补 `api schema` 的 `callable:false` 验收、`null` 值「存在≠通过」验收、非对象 body 验收、
    `--no-validate` 不削弱门禁验收 | 内部自洽 + 安全 |
| 16 | 新增 §十 测试计划（文件落点、凭证/mock 基建、计数哨兵） | 可实现性 |
| 17 | 新增 §四 命令行表达说明（`--body` 经 `JSON.parse`，XML 需 JSON 字符串字面量） | 可实现性 |
| 18 | 明确 `--strict` 的安全边界（「严格」≠「正确严格」，可能误伤） | 契约诚实性 |
| 19 | 新增 §五 `note` 腐化缓解（强制引用存在 + 证据来源要求） | 契约诚实性 |
| 20 | 新增 §八.7 同名字段跨 `in` 的加载期护栏（实测 0 个，防御性） | 内部自洽 |
| 21 | 新增 §八之二 **联动文案修正**（README:149 + `field_notes.request_schema` 的逐字改后文案），并列为验收 23；强调不得只机械删旧句、必须保留「响应体不校验」 | 契约诚实性 + 上游一致性 |
| 22 | 新增 §十.0 **类型与函数定义**（`ParamSpec`/`BodyKind`/`ParamFile`/`ResponseShape`/`loadParams`/`validateBody`/`normalizeAliases`/`ValidationOverride` + 加载机制 `import.meta.url`） | 可实现性（A-严重） |
| 23 | 补 `has_body_schema` 与 `bodyIgnored` 的组合语义（表存在 vs 本次是否比对，不再加字段） | 内部自洽 |
| 24 | 补退出码 2 与 4 的**语义分工**说明（2=改参数、不需人类；4=停下问人类；硬拒消息不得暗示确认） | 安全与门禁 |
| 25 | **修正验收判据的接口选择**（v2.2，controller 复查时发现）：验收 5/9/10/16/18 原用**危险接口**（addKnowledge/kefu.add/export.session）却断言退出码 **0** —— 但 D5 让校验先于门禁，合法 body 会撞 `--yes` 门禁返回 **4**，判据自相矛盾。改用**非危险**替身（`ai.knowledge.search` / `icoutcall.phone.getLineList`），并在 6/7 显式标注「危险接口须加 `--yes`」；19/20 的交叉引用同步修正 | controller 复查（非 agent 发现） |
| 26 | **`validate.json` 移出 `overrides/`**（v2.2，controller 复查时发现）：`overrides/` 是 A 的**构建期**目录、不打进 `dist`（实测 `dist/core/registry/` 无 `overrides/`；`copy-params.mjs` 只拷 `params/`）。B 的 `validate.json` 是**运行时**消费，放在那里打包后读不到。改放 `src/core/registry/validate.json`（`specs.json` 旁）、用**同款静态 JSON import** 进 dist；并加验收 24 钉住「打包产物含它」 | controller 复查（非 agent 发现） |
| 27 | **override 加载改两段式**（v2.2）：`validateOverrides(raw, specs, paramsFor)` 纯函数 + `loadValidationOverrides()` 薄包装（对齐既有 `loadSpecs(raw)`），使验收 12 的 fail-closed 分支可用合成数据测试，无需改真实文件 | controller 复查（可测性） |
| 28 | **删除 `bodyIgnored` 字段与 `tag.all` 条目**（v2.3）：它的唯一引证 `tag.all` 是 json 但 **0 个 body 参数**，§四 的比对本就跳过——override 是**零效果的死配置**；实测 154 条里**没有任何接口**需要它（其余「body 语义与文档不符」的案例要么本就没有 body 表，要么该用 `relaxRequired`/`aliases` 精确表达）。零效果字段 = 「声明了但没人读」（与删 `keepRequired` 同一条理由），也违背 §五 自己的「override 是证据驱动的，不是预防性的」。安全审查第 12 条（bodyIgnored 禁用于 dangerous）随字段删除而**自动满足** | controller 复查（契约诚实性） |
| 29 | **`params` 澄清为「浅复制 + 追加 `auto`」**（v2.3）：原文说「原样输出」，但样例里 `appKey` 带 `auto:true`，而 params 文件**没有** `auto` 键——「原样」与「加 auto」自相矛盾。改为明确：浅复制每个参数对象，仅对 `in:"query"` 且 `name ∈ {appKey,time,checksum}` 追加 `auto:true`；类型 `SchemaParam = ParamSpec & { auto?: true }`（`ParamSpec` 不含 auto） | 事实对拍 |
| 30 | **`api schema` 位置参数规则独立定义**（v2.3）：原 §三 只说「有自己的 KNOWN」，未定义位置参数与 help/`--pretty` 的次序，实施者可能照抄 `list()`（「位置参数一律报错」）或 `callOne()`（「首 token 必须是 id」）——两者都与 schema 不符。补 7 步次序（含「help 优先于缺 id」） | 可实现性 |
| 31 | **单一 body 来源契约**（v2.3）：明确 `call()` 必须收到 `normalizeAliases` **改写后**的 body（重新赋值 `let body`），**不得**在 `call()` 处重新用原始 `JSON.parse` 值。原文只说「发送前改写」，未钉死接线点，可能只在测试的 mock 断言里成立而生产路径漏改 | 可实现性 + 内部自洽 |
| 32 | **四种 warning 的 `message` 最小必含语义**（v2.3）：原文只定义 `kind`，不定 `message` 内容——各实现措辞不一，Agent 学不到稳定规则。补表格（每种 kind 必须说清什么）；尤其 `alias_normalized` **必须显式写「无需重试」**——`editKnowledgeNoSimilars` 是危险接口，一个「见 warning 就改输入重试」的 Agent 会**重复执行写操作**，这句是安全关键 | 契约诚实性 + 安全与门禁 |
| 33 | **补全 `internal` 错误契约**（v2.3）：原文只说 `kind:'internal'`、退出码 1，未定 `code`/`retryable`/`message`/`hint`。而它与普通业务错误（同是 1、同是只出 stdout）无法区分，Agent 无从知道该改什么。固定 `code:'internal'`、`retryable:false`、message 说明「CLI 打包/注册表缺陷」、hint 指向重装/报告 | 契约诚实性 |
| 34 | **`api schema` 的 `field_notes` 扩围并明确键集独立**（v2.3）：原文只说解释「上面几个新字段」，未列全、也未说明它与 `api list` 的 `field_notes` 是**两套独立键集**（Agent 不应跨子命令套用）。补：至少含 `has_body_schema`/`body_kind`/`auto`/`dangerous`/`response_shape`/`one_of`，并说明 schema 键 = schema 输出字段名 | 契约诚实性 |
| 35 | **`api schema` 新增输出 `one_of`**（v2.3）：`relaxRequired` 把 one-of 组内字段的 `required` 降为 false，Agent 读到「都可省」——调用时才撞硬拒，schema **撒了谎**。改为输出 `one_of`（与 §五 逐字对应），让 Agent 调用前就知道二选一。原 §十二.2 开放问题就此关闭 | 内部自洽 + 契约诚实性 |
| 36 | **`has_body_schema:false` 的静默通过写成显式边界**（v2.3）：agent 审查指出这类接口传任何 body 都静默通过，原文未提。**Ruling**：这是**证据缺口**不是能力缺口（无参数表则任何「字段可疑」的断言都无根据，与 §八.1 同源），有意接受；schema 侧以 `has_body_schema:false` 补偿，`api call` 侧**不**加 warning（会是「声明了没人读」的装饰，且对 `bodyKind:none` 合法调用稳定误报）。同时澄清 §八.6：判据是「body 参数数>0」，与 bodyKind 无关——实测 5 个 `json` 接口 0 body 参数（4 个危险，故验收只用 `tag.all`） | agent 对抗审查 + controller ruling |
| 37 | **联动文案键名统一为 `response_shape`**（v2.3）：§八之二 建议文案里混用了 `responseShape`（设计稿 TS 字段名）与 `response_shape`（CLI 实际输出键）。面向 Agent 的文案必须用实际键名，否则它会去读一个不存在的键。并给 README 文案补一句「校验先于危险门禁、合法 body 仍返 4」 | 上游一致性 |
| 38 | **验收 19 措辞修正**（v2.3）：「改为真实发请求」在「不使用真实网络」的测试基建下自相矛盾。改为「请求照常构造并交给 `call()`，断言 mock fetch 已被调用」，并显式声明测试不产生真实流量 | 可实现性 |
| 39 | **新增验收 25/26**（v2.3）：25 钉住 `one_of` 输出（含「无 one-of 时键不出现」）；26 钉住 `api schema` 的 internal 出口与 `api call` **逐字段一致**（同一出口，防两份实现） | 内部自洽 + 可实现性 |
| 40 | **补 override 的加载时机与失败范围**（v2.3）：原文只说「模块初始化加载、fail-closed」，未说明失败会拖垮**整个 CLI**（`auth whoami`/`api list` 一起挂）。补三条后果并给出 **Ruling**（接受：与 `specs.json` 同款、dist 不完整时整份产物不可信、惰性加载会让失败点漂移）；同时明确只读被引用的 id（当前 2 份），启动开销可忽略 | 可实现性 + controller ruling |
| 41 | **§十.0 补 `hasBodySchema` 判据与 `SchemaParam` 类型**（v2.3）：`validateBody` 的注释里显式写「由 `file.params` 现算、与 `bodyKind` 无关」，防实现混同；并把 `SchemaParam` 从 §三 的散落描述收进 §十.0 的类型清单 | 可实现性 |
| 42 | **§三 输出样例改用 `ai.knowledge.search`**（v2.3）：原样例用 `ai.knowledge.addKnowledge`，却写 `"dangerous": false` —— 实测它是 **`dangerous: true`**，即样例里有一个**与事实相反**的字段值（正是契约诚实性审查自己反对的）。`search` 实测 `dangerous: false`，且 body 字段一必填（`robotId`）一可选（`keyWord`），同时展示 `required` 两种取值；title/path/description 均按实测逐字对齐 | 事实对拍（controller 复查） |
| 43 | **§一「非目标」与 §八之二 的 `responseShape` → `response_shape`**（v2.3）：面向 Agent 的正文/文案统一用 CLI **实际输出键名**（下划线），仅在设计稿溯源处保留 TS 字段名 `responseShape` | 上游一致性（controller 复查） |

**未采纳**：审查提出的「params 用静态 import 编译期映射」建议——与既有 `copy-params.mjs`
把 params 拷进 `dist` 的机制不符；改为 `fileURLToPath(new URL('./params/<id>.json', import.meta.url))`
+ `readFileSync`（源码与 dist 同构，见 §十.0 与 `params.test.ts`）。

## 十二、开放问题（留给实施计划/后续）

1. `api schema` 是否要 `--all` 输出全部 154 条参数表（体积/分页问题）——**先不实现**。
2. ~~one-of 的**组本身**是否要进 `api schema` 输出~~ —— **已关闭**（v2.3 第 35 条）：
   不输出就是 schema 撒谎（`relaxRequired` 让组内字段看起来都可省），故 `one_of` **必须**输出，
   见 §三 与验收 25。
3. G1 若决定删 `category` 数据（§七把删除权交给 G1），生成脚本与 154 条要一起再生。
4. **`--strict` 的误伤面**（§八.3）——params 漏记的服务端字段会在 `--strict` 下被硬拒。
   是否要在 `--strict` 的拒绝消息里附「若确认该字段合法，请报告缺失的注册表项」之类的指引，
   留待实施计划决定（当前只要求文档写明「严格 ≠ 正确严格」）。
