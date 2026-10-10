# 请求构建与 body 校验（B 子项目 · 设计）

- **日期**：2026-10-10
- **状态**：已批准（设计 7 节经用户逐节/逐题确认；本文件经确认后进入 writing-plans）
- **上游**：`docs/superpowers/specs/2026-10-09-后续交付路线图-design.md`（§二 B 节、§八.6/.7 遗留）、
  `docs/qiyu-cli-design.md`（§5.2 注册表与 ParamSpec、§5.3 元数据陷阱）、A 的交付物
  （`src/core/registry/params/*.json` 154 份 + `src/core/registry/specs.json` 154 条，合入 `main` `a3f1c17`）。
- **依赖**：A（✅ 已满足）。与 C（存储层）文件不重叠、可并行。

## 一、目标与非目标

**目标**（一句话）：让 `qiyu api call <id> --body <JSON>` 的 body **在发出请求之前**、
**在本地**与注册表参数表比对——缺必填字段当场拒绝（退出码 2、零网络请求），可疑之处
以结构化 warnings 提示；并新增 `qiyu api schema <id>` 把参数表本身暴露给 Agent。

解决路线图 §八.7 登记的「**154 份 params 已打包但无任何运行时消费方**」缺口；
§八.6 的 `category` 悬置在本 spec §七 给出处置意见（B 不动它、决定权归 G1）。

**非目标**：

- **不做响应体校验**（`responseShape` 只在 `api schema` 里原样输出，B 不消费其内容做校验）。
- **不做文件/表单/XML 的 body 构建**——非 `json` 的 bodyKind 一律原样透传（见 §四），B 只消费 JSON 字面量。
- **不预校验 `maxWindowDays`**（窗口起止在哪个字段里、单位是什么，B 不接管；那是 D/E 的候选）。
- **不修改 `params/*.json` 的生成源**——B 是纯消费方 + 一份自己的校验 override 表。
- **不改 `core/http.ts` 的签名/行为**（B 只在 `callOne` 里、`call()` 之前介入）。

## 二、已锁定决策（用户拍板，7 条）

| # | 决策 |
|---|---|
| D1 | **分级校验（缺必填硬拒，其余提示）**：缺必填 → 退出码 2 不发请求；未知字段/类型不符 → 只提示 |
| D2 | **暴露形态 = 新子命令 `qiyu api schema <id>`**（不并入 `api list`） |
| D3 | **B 带一份校验 override 表**（形式同 A 的 `overrides/`），登记「文档必填不可靠」的接口：降级 required、定义二选一组（one-of）。B 读 params 时应用它 |
| D4 | **只对 `bodyKind: 'json'` 校验**；其余（xml/multipart/text/form，共 6 个 callable）`--body` 原样透传不校验，`api schema` 标注 bodyKind、`api call` 提示「该接口 body 非 JSON」 |
| D5 | **校验排在危险接口门禁（`assertConfirmed`）之前**——与既有契约「参数错误不能被门禁掩盖」一致：硬校验违规 → 2；只有 body 校验通过才轮到 `--yes` 的 4 |
| D6 | **软警告 = 结构化数组** `meta.warnings = [{kind, field?, message}]`，`kind ∈ unknown_field \| type_mismatch \| non_json_body \| no_body` |
| D7 | **`--strict` 只把「可归咎调用方」的提示升级为硬拒**（`unknown_field`、`type_mismatch`）；`no_body`/`non_json_body` 是 CLI 自身能力缺口（无法校验），`--strict` 下仍只提示 |
| 附 | **`--no-validate`**（题设已含）：完全关闭 B 的校验与 warnings，等价于 B 之前的逃生舱行为 |
| 附 | **`category` 归 G1**（路线图 §八.6 允许「B 或 G1」二择；本 spec 把决定权交给 G1，见 §七）——B 不读它、也不动它 |

## 三、`api schema <id>`（D2）

新子命令，与 `api list`/`api call` 同层进 `API_USAGE` 与 `callOne`/`list` 同款次序门
（未知/位置参数 → help → `--pretty`）。

**输出**（stdout，`ok(data)` 形态，退出码 0）：

```json
{
  "ok": true,
  "data": {
    "id": "ai.knowledge.addKnowledge",
    "title": "新增知识",
    "method": "POST",
    "path": "/openapi/ai/knowledge/add",
    "body_kind": "json",
    "body_validated": true,
    "params": [
      { "name": "appKey", "in": "query", "required": true, "type": "string",
        "description": "企业的appKey", "example": "{{appKey}}", "auto": true },
      { "name": "robotId", "in": "body", "required": true, "type": "integer",
        "description": "机器人id" }
    ],
    "response_shape": { "kind": "object" },
    "note": "…（该接口 specs.json 里有 note 才输出）"
  },
  "meta": { "validation": "hard_missing_required_soft_others" }
}
```

- `auto: true` 标注 CLI 自填的鉴权 query 参数（`appKey`/`time`/`checksum`）——它们在
  `in: "query"` 里但调用方**不该也不能**通过 `--body` 传；不标注则 Agent 会以为要自己填。
- `body_kind`：原样来自 params 文件。`body_validated`：「有 body 参数表可比对」，
  即 `body_kind === 'json' && body 参数数 > 0`（与 §四 末同一判据；两者不一致
  （如 `tag.all`：json 但 0 body 参数）时以 0 参数为准 → `body_validated: false`）。
  两者合起来回答「我这个 body 会被校验吗」。
- **校验 override 表已应用的字段**照常输出（required 已是降级后的值）；覆盖过 required 的
  字段不加额外标记——override 的语义是「**这才是文档的真实约束**」，不是「这是被改过的」。
  但 `meta.validation` 反映**生效中的**校验模式即可。
- `in: "path"`（仅 inbound 推送的占位模板）与 `in: "header"`（`content-type` 一类）照原样
  输出、标原值——它们是 Apifox 的原貌，B 不消费（可调用接口里 path 参数 0 个、header 参数
  只有 `content-type`，实测 2026-10-10）。
- 未知 id → 与 `api call` 同一条 `byId` 抛错 → 用法错误、退出码 2、stdout JSON + stderr 文本。
- `callable: false` 的接口 `api schema` **照常输出**（查 schema 不是调用；schema 是纯本地读）。

**次序契约**（与 `list()`/`callOne()` 逐字一致）：未知 flag/位置参数 → help → `--pretty` →
`byId`。`--help` 不吞额外参数。

## 四、`api call` 的分级校验（D1/D4/D5/D7）

接入点：`callOne` 内、命令行次序门（未知/位置 → help → `--pretty`、body JSON.parse）
之后——**必须先有 spec 才能查 params**，所以排在 `byId` 之后；且在 `assertConfirmed` **之前**（D5）：

```
命令行门（未知/位置 → help → --pretty，body JSON.parse）
→ byId(id)                       // 未知 id → 2（既有）
→ assertCallable(spec)           // 不可调用 → 2（既有）
→【B：validateBody(spec, body)】  // 硬违规 → 2，零网络请求
→ assertConfirmed(spec, --yes)   // 危险未确认 → 4（既有，D5）
→ 凭证解析 → call()
```

**`--no-validate`**：跳过整个校验与 warnings（含 non_json_body 提示）。
**`--strict`**：默认软的 `unknown_field`/`type_mismatch` 升级为硬；`no_body`/`non_json_body` 不升。

### 校验规则（`bodyKind === 'json'` 时）

先取 `params` 中 `in: "body"` 的字段，应用 override（D3）。

**硬（退出码 2、发不出请求；经既有 catch 的双通道出口，stdout JSON + stderr 文本）：**

1. **缺必填**：override 后仍 `required: true` 且 body 中**键缺失或值为 `undefined`**。
   `null` 算存在（服务端可能允许；B 不替服务端做非空判定）。
   - one-of 组（override 定义）：组内**任一**字段存在即该组满足；全缺 → 硬。
   - 消息点名缺的字段名 + `qiyu api schema <id>` 查看完整表。
2. **`--strict` 下**的 `unknown_field` / `type_mismatch`（见软列表）。

**软（`meta.warnings`，请求照发）：**

3. `kind: "unknown_field"`：body 里出现了不在 params body 表、也不在 override 白名单里的键。
   （文档不全 + 服务端对未知字段常**静默忽略**——硬拒会误伤合法调用，见 D1 理由。）
4. `kind: "type_mismatch"`：值的 JS 类型与声明 `type` 不符。映射：
   `string→string`；`integer/number→number`（**不**拒小数——类型表没有「必须整数」的
   语义层，拒小数是超出证据的断言）；`boolean→boolean`；`array→Array.isArray`；
   `object→非数组的 typeof 'object' 且非 null`。日期串/数字字符串**不**判 mismatch
   （`type` 来自 Apifox 展示类型，实测与真实取值域不总一致）。
5. `kind: "no_body"`：body 为 `undefined`（**未传 `--body`**）**且**该接口 params 里有 ≥1 个
   `in: "body"` 字段（**不要求该字段必填**）——该接口按文档是要带 JSON body 的，而调用方
   一个字节都没传，服务端将走它自己的默认行为。
   ⚠️ **判据是「有 body 字段」而不是「有必填 body 字段」**——本仓头号静默失败的样本
   `ticket.search` 的 12 个 body 字段**全部可选**（`opEnd` 缺省时服务端返回全量），
   按「有必填」判会漏掉它，恰好漏掉 B 最该提醒的那一个。对「所有 body 字段都可选、
   调用方确实想拿全量」的接口，这条 warning 是**冗余但无害**的提示（软警告，不拦请求）。
   `--body '{}'`（显式空对象）走 1 号硬规则（若存在必填字段则硬拒），**不**走本条。
6. `kind: "non_json_body"`：`bodyKind !== 'json'` **且实际传了 `--body`**（D4）——**整类只出这一条**，
   不做任何字段比对。`--body` 值原样 `JSON.parse` 后传入 `call()`（行为与 B 之前一致）。
   ⚠️ **必须带「实际传了 body」这一条**：`bodyKind: "none"` 的接口（10 个，其中 8 个 callable，
   如 `export.session`）正常用法就是**不传 body**——此时不该有任何 warning，
   说「你的 body 未经校验」是**事实错误**（根本没有 body）。对 `bodyKind: "none"` 却传了
   body 的调用，这条 warning 的含义是「该接口按文档不接受 body，你传的值已被原样发送」。
   B 不承诺帮调用方构 XML/multipart。

**`bodyKind === 'json'` 且 params 的 body 表为空**（实测：`tag.all`、4 个 `export.*` 等）：
不做任何比对——**不**套 5 号 `no_body`（body 表空 = 无法判断「该不该有 body」，
说「缺必填」会是事实错误）；body 非空也不出 `unknown_field`（没有可比对的表，
「未知」无从谈起）——5、6 两条的判据都归结为「**body 参数表非空**」，与 §三 的
`body_validated` 同源；`bodyKind !== 'json'` 时表再空也归 6 号（有 body 才有 6 号，见上）。

### 成功输出的接线

```ts
return ok(r.payload, {
  endpoint: spec.id,
  ...(warnings.length ? { warnings } : {}),   // 结构化（D6）
  ...(r.notFound ? { not_found: true, warning: '接口返回成功但无数据' } : {}),
  ...(spec.note ? { note: spec.note } : {}),
})
```

`warnings` 与既有 `warning`（not_found 那条单数字符串）**并存不冲突**：`warning` 是信封层
的「成功但无数据」，`warnings` 是请求构建层的 body 比对结果；两者键名相邻、语义不同，
`field_notes` 不适用于 call 的 meta（call 没有 field_notes），所以每条 warning 的 `message`
必须自带完整语境（例如「未知字段 `foo` 不在 ai.knowledge.addKnowledge 的文档参数表中，
服务端可能忽略它」）。

## 五、校验 override 表（D3）

**路径**：`src/core/registry/overrides/validate.json`（**归 B 所有**——A 的
`ids/paths/attrs.json` 归 A，生成管线 `generate.mjs` 不读本文件；B 是唯一消费方，
生成管线重跑不会碰它，结构上互不干扰）。

**形状**：

```json
{
  "merchant.account.login": {
    "note": "上游自相矛盾：接口描述要求 code/shopCode 必填其一，schema 却把三者全标必填。按接口描述建模为 one-of。",
    "relaxRequired": ["code", "shopCode"],
    "oneOf": [{ "anyOf": ["code", "shopCode"], "message": "code 与 shopCode 必填其一（都存在时以 code 为准）" }],
    "keepRequired": ["userName"]
  },
  "tag.all": {
    "note": "实测该接口对任何 body 都返回 200（含格式错误的 {），文档「body 必须是字面量 all」不成立。",
    "relaxRequired": [],
    "oneOf": [],
    "bodyIgnored": true
  }
}
```

字段语义：

- `relaxRequired: string[]` —— 把列出的字段的 `required` 降为 false（其余不动）。
- `keepRequired: string[]` —— 显式保住不许被 relax 误伤的必填（与 relax 同表出现，写清意图）。
- `oneOf: {anyOf: string[], message: string}[]` —— 组内任一存在即满足；全缺 → 硬违规，
  消息用 `message`。
- `bodyIgnored: true` —— 该接口**不比对**任何字段（未知字段、类型、必填全不查）。用于
  「body 语义已实测与文档完全不符」的接口（`tag.all`）。`no_body` 提示也一并不出：
  既然参数表对该接口毫无约束力，用它的字段数去推「该不该有 body」同样是无根据的断言。
- `note` —— 进 override 的理由，供 review 与将来核对；**不**进 CLI 输出。

**加载规则（fail-closed，与 `loadSpecs` 同款理由）**：`validate.json` 顶层必须是对象；
每条 key 必须**是注册表里存在的 id**（否则是拼写错误，加载时炸而不是静默无效）；
每个数组字段元素必须是该接口 params 里真实存在的 `in: "body"` 字段名；
`anyOf` 至少 2 个元素。加载失败 = B 不可用（宁可炸，不可静默变成「没有 override」——
那会把 one-of 接口的合法调用硬拒掉，正是 D3 要防的事）。

**初始收录范围（有实测/文档证据才写）**：`merchant.account.login`（D3 题面已确认）、
`tag.all`（§5.3 陷阱 2：body 语义与文档完全相反）。其余接口先不录——
**override 是证据驱动的，不是预防性的**：没有实测就不写，宁可让软警告兜底。

## 六、退出码与 flags（约束自 README，B 的增量）

| 情形 | 退出码 | 说明 |
|---|---|---|
| 缺必填（含 one-of 全缺）/ strict 下的 unknown/type | **2** | 用法错误，双通道（stdout JSON + stderr 文本），经 `callOne` 既有 catch 的 usage 出口 |
| 未知 id / 不可调用 / `--body` 非法 JSON | 2 | 既有，B 不改 |
| 危险未确认 | 4 | 既有；B 的硬校验在其**之前**（D5） |
| 软警告请求成功 | 0 | `meta.warnings` 随成功 meta 输出 |

`API_USAGE` 增补：`schema` 子命令行、`--no-validate`、`--strict`。
`KNOWN` 集合**只加 `callOne` 的**（`api list` 不校验 body，给 `list` 加就是「声明了没人读」）；
`schema` 的 `KNOWN` 只有 `--pretty`/`--help`/`-h`，不接受 `--body`/`--yes`/`--no-validate`/`--strict`
（它们出现在 `schema` 上是未知参数 → 2）。

## 七、`category` 处置（路线图 §八.6 的 B 侧答案）

**B 不动它**——既不删数据、也不补类型/输出。`EndpointSpec` 本就没声明 category、
`api list` 本就不输出，B 的 `EndpointSpec` 变更（消费 params 相关）不涉及它，保持现状。

**决定权归 G1**（路线图 §八.6 本来就写「归 B 或 G1」，本 spec 选 G1），理由：
- 删数据要改 A 的生成脚本（`generate.mjs` 不再写 category）并再生 154 条——跨进 A 的文件，
  B 没有理由为一个自己不读的字段动 A 的生成管线；
- 补类型+输出要有真实消费方（目前没有）——为「字段存在」而输出正是本仓反对的形态。
→ 路线图 §八.6 交付后应把该条从「归 B 或 G1」改成「已归 G1」（随本 spec 的合并一并改）。

## 八、边界与风险

1. **params 与真实服务端的偏差**（D2 的根源）：文档字段表与真实返回不一致是实测常态
   （`merchant.account.login` required 自相矛盾、`statistic.performance` 字段名拼写
   与文档不符、§5.3 陷阱 2）。因此 B 的硬校验**只覆盖「缺必填」这一最不可能出错的子集**，
   其余全部降为可忽略的提示——这是设计而非妥协。
2. **override 表会腐化**：接口文档改了，validate.json 不会自动跟着改。缓解：`note` 必须
   写明证据来源；G1 可加「override 引用的字段是否仍存在于 params」的对账测试（B 先在
   load-time 校验「字段必须存在」，等价于防腐的下限）。
3. **`integer` 类型不校验整除性**（D1 软规则 4）：允许 `1.5` 过 `integer` 字段。已知不精确，
   宁松勿错——服务端才知是否拒。
4. **`--strict` 与 `no_body` 的交互**：`no_body` 永远是软的（D7），`--strict` 不改变它，
   README 的 `--strict` 说明必须写清这一点，否则 Agent 会以为 strict 下「忘写 body」也会被拦。
5. **`bodyValidated` 的判据分叉**（§四末）：`bodyKind === 'json'` 与「body 表非空」是两个
   条件，不总一致（`tag.all` 是 json 但 0 body 参数）。实现与测试必须分别钉住这两个条件，
   合并成一个布尔会造出「json 但无表」时声称 validated 的谎言。

## 九、验收判据（给实施计划的 spec 级验收）

1. `qiyu api schema ai.knowledge.addKnowledge` → 0；stdout JSON 含 `body_kind: "json"`、
   `params` 中 `appKey` 带 `auto: true`、`robotId` 为 `required: true`。
2. `qiyu api schema 不存在的id` → 2；stdout `{"ok":false,...}`、stderr 有点名的 `byId` 消息。
3. `qiyu api call ai.knowledge.addKnowledge --body '{"name":"x","answer":"y","similars":[],"validitySwitch":1}'`
   （缺 `robotId`）→ **2、零网络请求**（mock fetch 断言未被调用）、stderr 点名 `robotId`。
4. 同上再加 `"bogus":1` → 仍 2（先报缺必填，未知字段进不了软列表因为已硬拒）；
   补全 `robotId` 后重跑 → 0，`meta.warnings` 含 `{kind:"unknown_field", field:"bogus"}`。
5. `merchant.account.login` 只传 `userName+code`（缺 `shopCode`）→ **0**（one-of 满足、
   不误拒——D3 的核心验收）；三者全缺 → 2 且消息来自 override 的 `message`。
6. `qiyu api call tag.all --body '{"foo":"bar"}'` → 不出 `unknown_field`（`bodyIgnored`）。
7. `kefu.add`（xml）带任意 body → `meta.warnings` 含 `{kind:"non_json_body"}`、请求照发。
8. `export.session`（bodyKind none、0 body 参数）不带 `--body` → **0 且无 `no_body`
   warning**（body 表空不套 5 号规则）；`ticket.search` 不带 `--body` → 0 但
   `meta.warnings` 含 `{kind:"no_body"}`。
9. 危险接口 `message.send` 缺必填 + 无 `--yes` → **2**（不是 4，D5）；补必填 + 无 `--yes` → 4。
10. `--no-validate` 下 3、4、7、8 全部不再出 warnings/硬拒。
11. `--strict` 下 4（补全后）→ 2；8 的 `no_body` 仍只是 0 + warning（D7）。
12. `validate.json` 加一个不存在的 id → B 启动即抛（fail-closed），消息点名该 id。
13. `npm test` 全绿（新增用例并入现有套件）；`npm run typecheck` 0 错误。

## 十、开放问题（留给实施计划/后续）

1. `api schema` 是否要 `--all` 形态输出**全部** 154 条的参数表（Agent 一次拿全）？
   当前 spec 只定单接口形态；批量输出是体积/分页问题，D2 选择单接口时未展开——**先不实现**。
2. override 的 `oneOf` 消息是否要进 `api schema` 输出（让 Agent 调用前就知道有二选一）？
   当前 §三说「override 已应用的字段照常输出」，one-of 的**组本身**不输出——
   实施时若发现 Agent 只看 schema 仍会踩 one-of，再补 `meta.one_of`（属 D2 形态的增量）。
3. G1 若决定删 `category` 数据（§七把删除权交给 G1），生成脚本与 154 条要一起再生——
   与 B 无耦合，但 G1 动手时应先看本节避免重复决策。
