# 请求构建与 body 校验（B 子项目 · 设计）

- **日期**：2026-10-10
- **状态**：已批准（设计经用户逐节/逐题确认；**v2** —— 经 6 路独立只读审查后按发现修订，见 §十一 修订记录）
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

- **不做响应体校验**（`responseShape` 只在 `api schema` 里原样输出，B 不消费其内容做校验）。
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
（出现即未知参数 → 2）。次序与 `list()`/`callOne()` 逐字一致：
**未知/位置参数 → help → `--pretty` → `byId`**；`--help` 不吞额外参数。

**输出**（stdout，`ok(data, meta)` 形态，退出码 0）：

```json
{
  "ok": true,
  "data": {
    "id": "ai.knowledge.addKnowledge",
    "title": "新增知识",
    "method": "POST",
    "path": "/openapi/ai/knowledge/add",
    "callable": true,
    "dangerous": false,
    "body_kind": "json",
    "has_body_schema": true,
    "params": [
      { "name": "appKey", "in": "query", "required": true, "type": "string",
        "description": "企业的appKey", "example": "{{appKey}}", "auto": true },
      { "name": "robotId", "in": "body", "required": true, "type": "integer",
        "description": "机器人id" }
    ],
    "response_shape": { "kind": "object" }
  },
  "meta": {
    "endpoint": "ai.knowledge.addKnowledge",
    "field_notes": { "…": "…" },
    "note": "…（该接口 specs.json 里有 note 才输出）"
  }
}
```

字段语义（逐条都是给 Agent 读的，不是装饰）：

- `auto: true` —— CLI 自填的鉴权 query 参数（`appKey`/`time`/`checksum`）。它们在
  `in: "query"` 里但调用方**不该也不能**通过 `--body` 传；不标注则 Agent 会以为要自己填。
- `body_kind` —— 原样来自 params 文件。
- `has_body_schema` —— **能力**标志：「该接口有可比对的 body 参数表」，判据
  `body_kind === 'json' && body 参数数 > 0`（与 §四 `unknown_field` 的触发条件同源：没有表就不谈「未知」）。
  ⚠️ **命名刻意不叫 `body_validated`**（v1 的名字读起来像「本次 body 已通过校验」，实为「有表可比对」——
  审查判为易误判，见 §十一）。它**不代表**本次请求校验通过；本次结果看 `api call` 的 `meta.warnings`。
  ⚠️ **与 `bodyIgnored` 的组合**：若某接口在 override 里标了 `bodyIgnored`（§五）但确有 body 参数，
  `has_body_schema` 仍为 `true`（表存在），而 `api call` **不会**执行比对——`has_body_schema` 只答
  「**有没有表**」，不答「**本次会不会比**」；后者由 `--no-validate` 与 override 共同决定。B **不**为此
  再加一个「本次是否校验」的字段（那会是又一个「声明了没人读」的装饰键）。
- `response_shape` —— **原样透传** params 文件里的 `{"kind": "..."}` 对象。
  ⚠️ 设计稿 §5.2 写的是 `responseShape: string`（旧设计）；A 的现行接口缝（`params/*.json`）是结构化对象，
  **以 A 的产物为准**，B 不改写成字符串（见 §八.2）。
- `in: "path"`/`in: "header"` 参数照原样输出、标原值（Apifox 原貌，B 不消费）。
- `meta.field_notes` —— 解释上面几个 B 新增字段的**含义**（沿用 `api list` 既有约定），
  让 Agent 不至于把 `has_body_schema`/`body_kind`/`auto` 误读。至少含这三条的说明。
- `callable: false` 的接口 `api schema` **照常输出、退出码 0**（查 schema 不是调用；纯本地读，
  不经 `assertCallable`）——见 §九 验收 14。
- 未知 id → 与 `api call` 同一条 `byId` 抛错 → 用法错误、退出码 2、stdout JSON + stderr 文本。

## 四、`api call` 的分级校验（D1/D4/D5/D7/D8/D10）

接入点：`callOne` 内、命令行次序门（未知/位置 → help → `--pretty`、body JSON.parse）之后，
**`byId` 之后**（必须先有 spec）、**`assertCallable` 之后**（不可调用接口不该先因 params 报错）、
**`assertConfirmed` 之前**（D5）：

```
命令行门（未知/位置 → help → --pretty，body JSON.parse）
→ byId(id)                          // 未知 id → 2（既有）
→ assertCallable(spec)              // 不可调用 → 2（既有）
→【B：normalizeAliases → validateBody】  // 硬违规 → 2，零网络请求
→ assertConfirmed(spec, --yes)      // 危险未确认 → 4（既有，D5）
→ 凭证解析 → call()
```

**flag 语义**：
- `--no-validate`：跳过 `normalizeAliases` + `validateBody` 的**全部**行为（校验、别名改写、warnings）。
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
   ⚠️ **必须带「实际传了 body」这一条**：`bodyKind: "none"` 的接口（10 个，其中 8 个 callable，
   如 `export.session`）正常用法就是**不传 body**——此时不该有任何 warning。对 `bodyKind: "none"`
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
（那是 `api list`/`api schema` 的），所以每条 warning 的 `message` 必须自带完整语境
（例：「未知字段 `foo` 不在 ai.knowledge.addKnowledge 的文档参数表中，服务端可能忽略它」）。
`warnings` 的**顺序**：按 `params` 表顺序、再按 body 键的出现顺序（稳定，便于测试与 Agent 解析）。

### 错误分类（v2 新增，消解「usage 2 vs internal 1」冲突）

- **硬校验违规**（`validateBody` 抛出的普通 `Error`，**不挂 `kind`**）→ 落进 `callOne` catch 的
  usage 兜底分支 → 退出码 **2**、双通道（stdout JSON + stderr 文本）。实现**不得**给它挂
  `kind: 'internal'`/`'validation'` 之类，否则会走业务错误分支变成退出码 1。
- **params 文件缺失/畸形、override 加载失败**（打包缺陷，**不是**调用方写错）→ 抛带
  `kind: 'internal'` 的 `Error` → 落进 catch 的 `err.kind && err.kind !== 'usage'` 分支 →
  退出码 **1**（业务错误，只出 stdout JSON，不出 stderr）。**绝不**报成 usage 2（那会让 Agent
  去改命令行，而真正的问题是产物缺文件）。

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
  },
  "tag.all": {
    "note": "实测该接口对任何 body 都返回 200（含格式错误的 {），文档「body 必须是字面量 all」不成立。",
    "bodyIgnored": true
  }
}
```

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
- `bodyIgnored: true` —— 该接口**不比对**任何字段（未知字段、类型、必填全不查）。
  用于「body 语义已实测与文档完全不符」的接口（`tag.all`）。
  ⚠️ **安全约束（fail-closed，v2 新增）**：`bodyIgnored` **禁止用于 `dangerous: true` 的接口**——
  它会静默放宽对写/破坏性调用的 body 保护。加载期发现「dangerous 接口带 `bodyIgnored`」→ 抛错。
  同一条精神也适用于 `relaxRequired`/`oneOf`/`aliases` 作用于危险接口：**允许**（`editKnowledgeNoSimilars`
  本身是危险接口且确需 `aliases`），但**必须在 `note` 里写明实测/文档依据**，且新增这类条目时
  测试要逐条钉住——见 §八.5。
- `note` —— 进 override 的理由。⚠️ 它是**唯一**不进 CLI 输出、只供 review 的字段（v1 因此被
  判为「会腐化的注释」，见 §十一）。缓解：`note` 必须写明**证据来源**（设计稿节号 / 实测日期），
  且 §九 验收 12 要求「override 引用的字段必须存在于 params」在加载期强制——证据漂移的下限防线。

**加载规则（fail-closed，与 `loadSpecs` 同款）**：顶层必须是对象；每条 key 必须是注册表里
存在的 id；`relaxRequired`/`oneOf.anyOf`/`aliases` 的值必须满足上面的引用约束；
`bodyIgnored` 不得用于 dangerous 接口。加载失败 = B 不可用（宁可炸，不可静默变成「没有 override」——
那会把 one-of 接口的合法调用硬拒掉，正是 D3 要防的事）。

**初始收录范围（有实测/文档证据才写）**：`merchant.account.login`（one-of）、
`ai.knowledge.editKnowledgeNoSimilars`（aliases，设计稿 §5.4）、`tag.all`（bodyIgnored，§5.3 陷阱 2）。
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
   「引用必须存在」（§五）、`bodyIgnored` 禁用于危险接口、新增条目必须带证据并逐条测试。
6. **`has_body_schema` 的判据分叉**（§三/§四）：`body_kind === 'json'` 与「body 表非空」不总一致
   （`tag.all` 是 json 但 0 body 参数）。实现与测试必须分别钉住这两个条件，合并成一个布尔会造出
   「json 但无表」时声称 validated 的谎言。
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
2. **`src/commands/api.ts` 的 `field_notes.request_schema`**（`api list` 的 meta）——
   现值：「本 meta **不提供**接口的请求参数表（`params`）与响应形状（`responseShape`）……本 CLI
   无法校验其字段是否正确」。
   B 之后应改为（逐字建议）：
   > 本 meta 不含参数表（体积考虑）；用 `qiyu api schema <id>` 查该接口的 `params`/`responseShape`。
   > `api call --body` 会做**有限**校验（缺必填拒绝、未知字段/类型提示）——见 `api schema` 的
   > `meta.field_notes`。⚠️ **响应体不做校验**，`responseShape` 仅供参照。

   ⚠️ **不得只机械删旧句**：旧句里「无法校验」是当时的事实，删掉后必须补上**新的事实**（校验了什么、
   没校验什么），否则会从「说了假话」变成「什么都没说」，而 Agent 无从判断边界。特别是
   **响应体仍不校验**这一点必须保留——否则 Agent 会以为 `responseShape` 被用上了。
3. 路线图 §八.7（「params 无运行时消费方」）在 B 合入后应标记为**已关闭**。


## 九、验收判据（spec 级，供实施计划展开为测试）

1. `qiyu api schema ai.knowledge.addKnowledge` → 0；stdout 含 `body_kind:"json"`、
   `has_body_schema:true`、`params` 里 `appKey` 带 `auto:true`、`robotId` 为 `required:true`；
   `meta.field_notes` 存在。
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
8. `qiyu api call tag.all --body '{"foo":"bar"}'` → 0，**不出** `unknown_field`（`bodyIgnored`）。
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
12. `validate.json`：加一个不存在的 id → B 启动即抛；`relaxRequired` 引用不存在的字段 / 引用非必填字段
    → 抛；`aliases` 的目标键不存在 / 源键恰是 body 字段 → 抛；`bodyIgnored` 用在 `dangerous:true` 的接口
    → 抛。消息点名接口 id 与字段名。
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
    对 `ai.knowledge.search` 传 `--body '{}'`（缺 `robotId`）→ 不再硬拒，**改为真实发请求**（mock 断言「已发出」）；
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
/** 归一化别名（D8）：返回改写后的 body 与 alias_normalized 警告；源/目标键冲突 → 抛（硬） */
export function normalizeAliases(
  file: ParamFile, body: unknown, ov: ValidationOverride | undefined,
): { body: unknown; warnings: Violation[] }
/** 纯函数：顶层形状契约 + 硬/软规则；不碰 I/O。
 *  `file` 为 `loadParams` 的结果（生产非 null）；`ov` 为该接口的 override（可能 undefined）。 */
export function validateBody(
  spec: EndpointSpec, file: ParamFile, body: unknown,
  ov: ValidationOverride | undefined, mode: { strict: boolean },
): ValidateResult
```

```ts
// src/core/registry/validation-overrides.ts（或并入 params.ts）
export interface ValidationOverride {
  note?: string
  relaxRequired?: string[]
  oneOf?: { anyOf: string[]; message: string }[]
  aliases?: Record<string, string>
  bodyIgnored?: boolean
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
`bodyIgnored`+dangerous、alias 源/目标非法）都能用**合成数据**直接测，不必去改真实文件；
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
（CLI 从任意目录启动会找不到文件）。`validate.json` 在模块初始化时加载并校验（fail-closed）。

### 10.1 测试文件落点

- `tests/core/registry/params.test.ts`（新）：`loadParams` 惰性加载 + 缓存；缺文件/畸形 JSON →
  `kind:'internal'`；结构校验（`in`/`required`/`type`/`bodyKind` 枚举）；同名跨 `in` 护栏。
- `tests/core/validate.test.ts`（新）：纯函数 `normalizeAliases`（归一化、改写、源/目标键冲突）
  与 `validateBody` 的硬/软全规则；顶层形状契约（对象/数组/标量/null）；
  one-of；`relaxRequired`；`bodyIgnored`；`--strict` 升级集合逐 kind 钉住；warnings 顺序稳定。
- `tests/core/registry/validation-overrides.test.ts`（新）：`validateOverrides` 的全部 fail-closed 分支
  （坏 id、坏字段引用、dangerous+bodyIgnored、alias 源/目标非法）——用**合成数据**直接调纯函数。
- `tests/commands/api.test.ts`（扩展）：`api schema` 成功/未知 id/`--help`/`--pretty`/位置参数/`callable:false`；
  `call` 硬违规退出码与双通道、`--no-validate`/`--strict` 冲突、`meta.warnings` 两态、
  危险接口次序回归、`--no-validate` 不削弱门禁。
- `tests/registry/generate.test.ts`（扩展）：`validate.json` 不进生成、确定性不变。
- **测试基建**：统一 `beforeEach` 注入 `QIYU_APP_KEY`/`QIYU_APP_SECRET`（否则 `resolveCredentials`
  先报 auth_missing，验不到请求路径）；`vi.stubGlobal('fetch', …)` 且硬违规用「被调用即失败」的 mock；
  **不使用真实凭证/网络**。既有 350 用例若含计数哨兵需同步更新。

## 十一、修订记录（v2，经 6 路独立只读审查）

审查维度：事实对拍 / 内部自洽与边界 / 上游一致性 / 契约诚实性 / 安全与门禁 / 可实现性与测试。
据其发现修订如下（每条均经 controller 回代码复核）：

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
| 12 | 新增 `bodyIgnored` **禁用于 dangerous 接口**（安全 fail-closed） | 安全与门禁 |
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

**未采纳**：审查提出的「params 用静态 import 编译期映射」建议——与既有 `copy-params.mjs`
把 params 拷进 `dist` 的机制不符；改为 `fileURLToPath(new URL('./params/<id>.json', import.meta.url))`
+ `readFileSync`（源码与 dist 同构，见 §十.0 与 `params.test.ts`）。

## 十二、开放问题（留给实施计划/后续）

1. `api schema` 是否要 `--all` 输出全部 154 条参数表（体积/分页问题）——**先不实现**。
2. one-of 的**组本身**是否要进 `api schema` 输出（让 Agent 调用前就知道有二选一）——
   当前只输出 override 后的字段 required，不输出组；若发现 Agent 仍踩坑再补。
3. G1 若决定删 `category` 数据（§七把删除权交给 G1），生成脚本与 154 条要一起再生。
