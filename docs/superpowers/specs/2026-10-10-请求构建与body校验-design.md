# 请求构建与 body 校验（B 子项目 · 设计）

- **日期**：2026-10-10
- **状态**：已批准（设计经用户逐节/逐题确认）。**v2.3** —— 经 6 路独立只读审查修订（v2）
  ＋ 用户两轮追问后 controller 逐行复读复查（v2.1 补 5 条遗漏、v2.2 修 4 处实测缺陷）
  ＋ 3 路对抗性证伪审查（v2.3 补 16 条契约/可实现性缺陷）＋ 第二轮 6 路全维度审查
  （v2.3 再补 14 条：判据自相矛盾、模块初始化断言被实测证伪、联动文案不全等）
  ＋ 收官自查（v2.3 再补 7 条：help 次序、warnings 合成次序、注入点等）
  ＋ 第三轮自查（v2.3 再补 3 条：none 专属解释、验收 24 降级、spec 参数用途）
  ＋ **第三轮 6 路全维度审查**（v2.3 再补 21 条：安全关键 message 无钉、README 安全段失真、
  override 两形态分叉、验收 12 落不了地、root 注入无接线、§三 params 与验收 25 矛盾等）
  ＋ **第四轮 6 路全维度审查**（v2.3 再补 21 条：对准前三轮盲区——历史裁决复核、验收逐条模拟、
  决策链覆盖、实施者冷启动、安全全场景、联动终审：message 重发防护无钉、`--strict` 硬形态模板缺失、
  `--no-validate`×`loadParams` 未定义、验收 31 kind 拼错、验收 21 在 CI 不可达等）
  ＋ **联动终审的逐字对拍与遗漏扫描**（v2.3 再补 4 条：README「尚未实现」段整条移出、
  `README.md:139` 当前状态句、`api.test.ts:166` 正则兼容、`responseShape` 误判撤销标注），
  全部修订见 §十一（68 条）
- **上游**：`docs/superpowers/specs/2026-10-09-后续交付路线图-design.md`（§二 B 节、§八 条目 6/7）、
  `docs/qiyu-cli-design.md`（§5.2 注册表与 ParamSpec、**§5.2 元数据陷阱**（§5.2 尾部）、§5.4 写接口与字段改名、§9.1 输出契约）、
  A 的交付物（`src/core/registry/params/*.json` 154 份 + `src/core/registry/specs.json` 154 条，合入 `main` `a3f1c17`）。
- **依赖**：A（✅ 已满足）。与 C（存储层）文件不重叠、可并行。

## 一、目标与非目标

**目标**（一句话）：让 `qiyu api call <id> --body <JSON>` 的 body **在发出请求之前**、
**在本地**与注册表参数表比对——缺必填字段当场拒绝（退出码 2、零网络请求），可疑之处
以结构化 warnings 提示；对**已实测的字段改名**做受控归一化（§五 D8）；并新增
`qiyu api schema <id>` 把参数表本身暴露给 Agent。

解决路线图 §八 条目 7 登记的「**154 份 params 已打包但无任何运行时消费方**」缺口；
§八 条目 6 的 `category` 悬置在本 spec §七 给出处置意见（B 不动它、决定权归 G1）。

⚠️ **回答路线图 §八 条目 4**（v2.3 补，见 §十一 第 67 条）：路线图 `:162` 登记「**B vs A/E**：
请求构建/校验归属哪个子项目——**仍开放**（B 的 spec 决定）」。本 spec 的答复是：**B 独立交付**，
**不并入 A**（A 的产物是 `scripts/` 生成管线与 `registry/` 数据，B 新增 `src/core/params.ts`/
`src/core/validate.ts` 运行时消费层，是独立的读侧）、**不并入 E**（E 是查询/报表，B 在 `api call`
路径上）。同时回答路线图 `:91` 的「**校验的松紧度**」头号设计题：D1 分级（硬校验只覆盖
「缺必填 + 非对象 body」这一最不可能出错的子集，其余降为提示，见 §八.1）。故路线图 §八 条目 4
**就此关闭**（验收 33 一并断言条目 4 已标关闭）。

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
| 附 | **`category` 归 G1**（路线图 §八 条目 6 允许「B 或 G1」二择；本 spec 把决定权交给 G1，见 §七）——B 不读它、也不动它 |

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
3. —— help 请求（含 --help/-h）在此**提前处理**，见下方 3a/3b（help 优先于"位置参数数量"与"缺 id"）
   3a. help 请求**且**位置参数 > 0 个 → 2（`--help` 不吞额外参数，位置参数是多余的）
   3b. help 请求**且**位置参数为 0 → 输出 API_USAGE、退出码 0
       —— ⚠️ help 优先于"缺 id"：`schema --help`（无 id）给帮助而非报错，
          与 `callOne` 的 `api call --help` 同款（help 是"请求帮助"，不是"写错 id"）
       —— ⚠️ **有 id 时的行为差异是刻意的**（v2.3 补，见 §十一 第 67 条）：`schema a --help`
          按 3a → **2**（help 不吞额外位置参数），而 `api call ticket.search --help` → **0**
          （`api.ts:436` 的 help 判定在 id 与 body 之后、不检查后续 token）。两者同为「带 id + help」，
          退出号不同——实施者**不得**把 callOne 的写法照搬给 schema，也不得把 schema 的写法搬给 callOne。
          原文只声明了「无 id 时同款」，未交代有 id 时的差异，可能误导实施者以为全部场景一致。
4. 非 help 请求且位置参数 > 1 个 → 2（点名多出来的）
5. --pretty → 2（尚未实现，同 list/callOne）
6. 位置参数为 0 → 2（`用法：qiyu api schema <接口id>`）
7. byId(id) → 未知 id → 2
```

⚠️ **次序的关键：help 判定必须在「位置参数 > 1」之前、且自身要检查位置参数**（v2.3 修正，见 §十一 第 56 条）。
原写法把「位置参数 > 1 → 2」排在 help 前，导致 `schema --help extra`（只有 1 个位置参数）不触发该步、
落到 help 给出**退出码 0** —— 与「`--help` 不吞额外参数」直接矛盾。三条输入的结果必须同时正确：
`schema --help` → 0；`schema --help extra` → 2；`schema a --help` → 2（`a` 对 help 是多余位置参数）；
`schema a b` → 2（非 help、位置参数 > 1）。

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
    "field_notes": { "…": "…" }
  }
}
```

> ⚠️ **样例用 `ai.knowledge.search` 而非 `ai.knowledge.addKnowledge`**（v2.3 定，见 §十一 第 42 条）：
> `addKnowledge` 是 `dangerous: true`，样例里写 `"dangerous": false` 就是一个**与事实相反**的字段值
> （契约诚实性审查的原始标准）。`search` 是 `dangerous: false` 且 body 字段一必填一可选，
> 同时展示 `required` 两种取值。`params` 只列**节选**（真实 `search` 有 5 个 body 字段）。

字段语义（逐条都是给 Agent 读的，不是装饰）：

- `params` —— ⚠️ **不是逐字节原样**（v2.3 澄清，见 §十一 第 29 条、第 67 条）：实现是**浅复制**每个参数对象，
  仅对 `in === "query"` 且 `name ∈ {appKey, time, checksum}` 的元素**追加** `auto: true`。
  ⚠️ **`required` 输出的是「应用 override 之后」的值**（v2.3 补，见 §十一 第 67 条）：该接口 override
  的 `relaxRequired` 列出的字段，其 `required` 输出为 `false`（如 `merchant.account.login` 的
  `code`/`shopCode`——params 文件里是 `true`，schema 输出 `false`）。理由：schema 的作用是让 Agent
  **调用前**就知道会发生什么；若输出文件原值 `true` 而 `api call` 按 `relaxRequired` 当 `false` 判，
  schema 就与 `api call` 的实际行为矛盾（且与 `one_of` 输出自相矛盾：`one_of` 说「二选一」，
  `required` 却说「两个都必填」）。其余键值**原样保留**。
  对应类型是 `SchemaParam = ParamSpec & { auto?: true }`（`ParamSpec` 本身**不含** `auto`——
  它是输出层加工，不是文件字段）。
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
  ⚠️ **`field_notes.one_of` 必须解释「组内任一存在即可」**（v2.3 补，见 §十一 第 67 条）：只写
  「one_of（若输出）」没有最小内容要求——实施者可能写出「二选一组定义」这类不足以消除
  「全部必填」/「全可省」两种误读的措辞。必含口径：「`one_of` 数组每项是一组『**组内任一存在
  即可满足**』的字段，全缺会被拒绝（退出码 2）；组内字段的 `required` 已因此降为 `false`
  ——`false` 是『二选一』的意思，**不是**『两个都可省』」。验收 25 钉住该解释存在且含
  「任一」字样。
- `in: "path"`/`in: "header"` 参数照原样输出、标原值（Apifox 原貌，B 不消费）。
- `meta.note` —— **条件输出**（v2.3 补，见 §十一 第 67 条）：该接口在 `specs.json` 里**有** `note` 时，
  原样带上（与 `api call` 成功 meta 的 `note` 同源同款）；**无** `note` 时不输出该键
  （不是 `null`/空串——与 `api list` 对条件键「未输出 = 没有」的惯例一致）。⚠️ 原文只在验收 1 的
  括号里提了这句、正文未列 `note`，实施者照本节字段清单实现会**永不输出** note。
- `meta.field_notes` —— 解释**本输出**中所有非自明键的含义（与 `api list` 同款约定：键 =
  本子命令输出的字段名，两条子命令的键集各自独立，Agent 不应跨子命令套用）。至少含：
  `has_body_schema`（=「有可比对的表」，**不代表**本次已校验；且**只有 `body_kind === 'json'`
  且该接口有 body 参数时才为 true**——其余 bodyKind 一律 false）、`body_kind`（含「**只有 `json`
  会被 `api call` 比对字段，其余原样透传不校验**」）、`auto`（CLI 自填的鉴权参数，调用方不要传）、
  `dangerous`（true → 调用需 `--yes`，否则退出码 4；⚠️ 措辞**不得**出现「加 `--yes` 重来」式指引——
  见 §六 安全审查，须复用 `needs_confirmation` hint 的「**必须由人类确认，不要自动追加 `--yes`**」口径）、
  `callable`（false = 结构上不可主动调用）、`path`（null = 路径未收录；`"/"` = 入站占位符——
  与 `api list` 的 `path` 说明同源）、`response_shape`（**仅供参照，不做校验**）、`one_of`（若输出）。
  只输出不解释 = 没输出（v2.3 扩围，见 §十一 第 34 条、第 48 条）。
- `callable: false` 的接口 `api schema` **照常输出、退出码 0**（查 schema 不是调用；纯本地读，
  不经 `assertCallable`）——见 §九 验收 14。
- 未知 id → 与 `api call` 同一条 `byId` 抛错 → 用法错误、退出码 2、stdout JSON + stderr 文本。
- **params 文件缺失/畸形 → 退出码 1**（`kind:'internal'`，只出 stdout）——
  **仅限命令执行期**（`loadParams` 在 `callOne` 内被调用时抛的错，且**限非被 override 引用的 id**：
  被引用的 2 个 id 的 params 损坏走模块初始化期裸崩，见 §四 错误分类）。模块初始化期
  （`validate.json`/`specs.json` 损坏）走未捕获异常、stdout 空、stderr 堆栈（§十.0，与 `specs.json` 既有行为逐字一致）。
  `api schema` 走的是与 `api call` **同一条** `loadParams`/`loadValidationOverrides` 路径，
  错误分类一致（见 §四 错误分类、§九 验收 13）。⚠️ `schema` 的 `callOne` 式 catch 必须与
  `callOne` **共用**出口，不得各自写一份（同族错误两种表现）。

## 四、`api call` 的分级校验（D1/D4/D5/D7/D8/D10）

接入点：`callOne` 内、命令行次序门（未知/位置 → **body JSON.parse** → help → `--pretty`）之后，
**`byId` 之后**（必须先有 spec）、**`assertCallable` 之后**（不可调用接口不该先因 params 报错）、
**`assertConfirmed` 之前**（D5）：

```
命令行门（未知/位置 → body JSON.parse → help → --pretty）
→ byId(id)                          // 未知 id → 2（既有）
→ assertCallable(spec)              // 不可调用 → 2（既有）
→ assertNoValidateStrictConflict()  // 互斥 → 2（v2.3 排进次序，见 §十一 第 49 条）
→【B】file = loadParams(spec.id)    // 缺文件/畸形 → kind:'internal' → 1
       ov   = overrides[spec.id]
       ({ body, warnings } = normalizeAliases(file, body, ov))   // body 被改写（D8）；冲突 → 抛普通 Error → 2
       vr   = validateBody(spec, file, body, ov, { strict })     // 返回 {hard, soft}；hard 非空 → 抛普通 Error → 2
→ assertConfirmed(spec, --yes)      // 危险未确认 → 4（既有，D5）
→ 凭证解析 → call(spec, body)       // ⚠️ 必须用**改写后**的 body（见下）
```

⚠️ **门内次序是「body JSON.parse 在 help 之前」**（v2.3 修正，见 §十一 第 67 条）：原文括号写成
「未知/位置 → help → `--pretty`，body JSON.parse」，把 body 解析排在 `--pretty` 之后——与实际代码相反
（`api.ts:406-421` 的 `JSON.parse` 在 help(`:436`)/`--pretty`(`:443`) **之前**，`api.ts:432-435` 注释明写
「body 解析排在两者之前」）。B 块的插入点不受此影响，但错误描述会误导实施者对门内次序的理解。
⚠️ **`assertNoValidateStrictConflict()` 是 `byId`/`assertCallable` 之后的新例外**（v2.3 补，见 §十一 第 67 条）：
`api.ts:296-314` 有一条既有不变量「**参数校验必须全部在 `byId(id)` 之前**」，而互斥检查（纯 flag 检查）
排在 `byId`/`assertCallable` 之后。**Ruling**：接受——它是**flag 组合**检查（不是单条命令行的语法错误），
且退出码仍恒为 2（`不存在的id --no-validate --strict` → byId 抛「未知接口」2；不可调用接口 → 「不可调用」2），
fail-closed 无请求发出。代价：同一 flag 错误会因接口是否存在/可调用而给不同 message——**有意接受**，
因为它排在门禁之前（§九 验收 15 依赖这一点）。

⚠️ **单一 body 来源契约**（v2.3 澄清，见 §十一 第 31 条）：`call()` 收到的 body 必须是
`normalizeAliases` **改写后**的那一份——实现上就是**重新赋值** `body`（`api.ts` 现有的是
`let body`，可赋值）。**不得**在 `call()` 处重新用 `JSON.parse` 的原始值。这是**强制接线**，
不只靠验收 7 的 mock 断言兜底（否则"别名改写生效"只在测试里成立、生产路径可能漏改）。

**flag 语义**：
- `--no-validate`：跳过 `normalizeAliases` + `validateBody` 的**全部**行为（校验、别名改写、warnings）。
  ⚠️ **`loadParams` 不跳过**（v2.3 补，见 §十一 第 68 条）：`--no-validate` 只关 B 的**校验逻辑**，
  **不关读 params 文件**——`loadParams` 缺失/畸形仍抛 `kind:'internal'` → 退出码 1。若跳过，
  「危险接口 + `--no-validate` + 合法/缺失 body + 无 `--yes` + params 文件损坏」会得 1 而非
  §六 红线承诺的 **4**（同一格子两种实现两种退出码）。次序图上 `loadParams` 画在【B】块内是
  「与校验同属 B 的数据准备」，**不是**「被 `--no-validate` 跳过」的意思。
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
  ⚠️ **「先按 `bodyKind` 分流」与「0 body 表则形状不判」的优先级**（v2.3 澄清，见 §十一 第 45 条）：
  分流**先于**形状表——`bodyKind !== 'json'` 的接口**根本不进**顶层形状表（形状表只对 json 接口生效）。
  故 `bodyKind: none` 传对象 body → 只出 `non_json_body`（软）；`bodyKind: none` 传标量 → 同样只出
  `non_json_body`（**不**硬拒）；`bodyKind: json` 但 0 body 表 → 形状也不判（静默）。
  三条规则串起来才得到这些结论，实施者不得把「形状表」当成对所有 bodyKind 生效。

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
   ⚠️ **硬形态的 message 不得复用软形态模板**（v2.3 补，见 §十一 第 68 条）：软形态的 message
   被强制含「**本次请求已经发出**（退出码 0）」（见下 message 表），而 `--strict` 下同类违规变
   **硬拒**（退出码 2，**没有请求发出**）——复用软模板会在退出码 2 的响应里宣称「请求已发出」，
   正是本仓定义的「说了假话」。硬形态 message 必须说清「**本地参数表未收录该字段 / 类型不符，
   未发出请求**，请修正后重试」。验收 29 断言其**不含**「已发出」。

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
   `object→非数组的 typeof 'object' 且非 null`。
   ⚠️ **映射是「按 JS 类型直接判」，没有豁免**（v2.3 修正，见 §十一 第 68 条）：原句「日期串/数字字符串**不**判 mismatch」有歧义——它本意是「声明为 `string` 的字段收到日期串/数字串当然不算 mismatch」（那是 `string→string`，本就通过），但读起来像「日期串/数字串一律豁免」。若实施者按后者实现，`{"robotId":"1"}`（声明 `integer`）**不会**产生 `type_mismatch`，与验收 28 的第三条断言直接矛盾。**正确表述**：只按「声明 `type` → JS 类型」映射判，声明 `integer`/`number` 的字段收到字符串 `"1"` **就是** `type_mismatch`（`string` 类型不符）。
   `null` 值（键存在）对任何声明了 `type` 的字段都判 `type_mismatch`（除非该字段无 `type`）。
6. `kind: "non_json_body"`（D4）：`bodyKind !== 'json'` **且实际传了 `--body`**——整类只出这一条，
   不做任何字段比对；`--body` 值原样 `JSON.parse` 后传入 `call()`。
   ⚠️ **必须带「实际传了 body」这一条**：`bodyKind: "none"` 的接口（10 个，其中 **9 个 callable**、
   1 个不可调用 `event.queueEnter`；如 `export.session`）正常用法就是**不传 body**——此时不该有任何 warning。对 `bodyKind: "none"`
   却传了 body 的调用，这条的含义是「该接口按文档不接受 body，你传的值已被原样发送」。
   ⚠️ 该句是 **`bodyKind: "none"` 专属解释**，**不是**通用 message 文本——xml/multipart/form
   接口**接受** body（只是 CLI 不校验），通用文案见 §四 的 message 表（v2.3 澄清，见 §十一 第 63 条）。
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
| `unknown_field` | 未知字段名 | 「该字段不在本接口的文档参数表中，**服务端可能忽略它**；**但本次请求已经发出**（退出码 0）——**不要重发**（重发 = 再执行一次接口，写接口会重复写入）」 |
| `type_mismatch` | 不符字段名 | 「声明类型 `<type>`，实际是 `<实际类型>`」（两者都要有；`<实际类型>` 用固定词汇 `null`/`数组`/`string`/`number`/`boolean`/`object` 之一渲染，**不**直接用 `typeof`——`typeof null`、`typeof []` 都是 `object`，会与实际不符）——⚠️ 必须附「**本值已随请求发出**（退出码 0），**不要重发**」 |
| `non_json_body` | 无 | 「本接口 `body_kind` 是 `<kind>`，你的 `--body` 已按**原样字面量**发送、**未经字段校验**；本 CLI 不构造非 JSON 的 body 编码」——⚠️ 必须附「**该字面量已随请求发出**，**不要因『未验证』而重发**」（危险接口上不得诱导实验性重发） |
| `alias_normalized` | 源字段名 | 「`<源>` 已按本接口约定改写为 `<目标>` 发送；**请求正常，无需重试**」 |

⚠️ **三条 `message` 的重发防护必须无条件、不得留缺口**（v2.3 补，见 §十一 第 68 条）：①不得写「确认写没写对要看 `data`」这类**可能无法完成的验证任务**——`api list` 的 `request_schema` 自己承认「传错的字段…也可能被**静默忽略**」，此时 `data` 根本不回显字段是否生效，Agent 会因「无法确认」而重发；②不得用「**只凭**这条警告不要重发」这类限定语（留出「若有别的理由则可重发」的缺口）；③`non_json_body` 不得保留「服务端实际能否接受该字面量**未验证**」——「未验证」正是「值得再试」的措辞（改为陈述「已发出 + 不要重发」）。

⚠️ **危险接口上「请求已发出」是三种警告共同的前提**（v2.3 补，见 §十一 第 66 条）：三者都可能出现在**危险接口**（实测 `dangerous:true` 共 73 个）带 `--yes` 的成功响应（退出码 0）里，而 `message` 原本只对 `alias_normalized` 写了「无需重试」。对 `unknown_field`/`type_mismatch`/`non_json_body` 读 Agent 是**同一动作**：「见 warning → 改输入重发」= 对写接口**再执行一次**。第 32 条的推理对三类一并成立，故三种 `message` 都补「已发出 + 不要重发」口径；`alias_normalized` 的「无需重试」措辞不变（它已含请求正常语义）。
⚠️ **这四类 `message` 的最小必含语义必须由验收钉住**（v2.3 补，见 §十一 第 68 条）：第 66 条只把 `alias_normalized` 的「无需重试」列进验收 7，另外三条的「已发出 + 不要重发」**无任何验收**——实施者漏写或改写它们，`npm test` 全绿。验收 5/9/28 相应加强。

⚠️ **`alias_normalized` 必须显式写"无需重试"**：它是**信息性**事件（退出码 0 的成功调用）。
一个"见 warning 就改输入重试"的 Agent，若把 `name` 改成 `question` 再调一次**危险接口**
（`editKnowledgeNoSimilars` 是 `dangerous:true`），会**重复执行一次写操作**。message 里那句
「请求正常，无需重试」是这条警告唯一的安全价值——不得省略。

`warnings` 的**顺序**（v2.3 精化，见 §十一 第 67 条）：`alias_normalized` 按 **body 键出现顺序**；
`vr.soft` 里的 `type_mismatch` 按 **params 表顺序**、`unknown_field` 按 **body 键出现顺序**
（未知字段不在 params 表里，只能按 body 键序）。原文笼统写「按 params 表顺序、再按 body 键出现顺序」——
对 `unknown_field` 不适用（它的字段根本不在 params 表里），会让实施者困惑。
⚠️ **两来源的合成次序**（v2.3 定，见 §十一 第 58 条）：`meta.warnings = [...aliasWarnings, ...vr.soft]`
——别名归一化在比对之前发生，其警告也排在前；两段各自内部按上述顺序规则。不定义则两种实现
对 `{"bogus":1,"name":"q"}` 会输出互为逆序的数组，而单键验收杀不掉这个分歧。

### 错误分类（v2 新增，消解「usage 2 vs internal 1」冲突）

- **硬校验违规**（`validateBody` 抛出的普通 `Error`，**不挂 `kind`**）→ 落进 `callOne` catch 的
  usage 兜底分支 → 退出码 **2**、双通道（stdout JSON + stderr 文本）。实现**不得**给它挂
  `kind: 'internal'`/`'validation'` 之类，否则会走业务错误分支变成退出码 1。
  ⚠️ **别名冲突的抛错同属此类**（v2.3 补，见 §十一 第 47 条）：`normalizeAliases` 的源/目标键冲突
  也是**普通 `Error`、不挂 `kind`**，同样落 usage 出口 → 2。§六 的「alias 冲突 → 2」依赖这条。
  ⚠️ **抛错主体在 `callOne`，不在 `validateBody`**（v2.3 澄清，见 §十一 第 50 条）：`validateBody`
  是**纯函数、返回 `{hard, soft}`、不抛**；由 `callOne` 在 B 块内检查 `vr.hard.length > 0` 后
  `throw new Error(拼接后的硬违规消息)`（普通 `Error`，不挂 `kind`）。这样 `ValidateResult.hard`
  与错误分类不冲突，且单元测试可以直接断言 `vr.hard` 内容而不必包 `toThrow`。
  `normalizeAliases` 的冲突则**必须抛**（它是纯函数、无返回值语义），`callOne` 让它落进同一个
  catch 出口即可——两处的**分类规则一致**：都是「普通 Error、不挂 kind、→ 2」。
- **params 文件缺失/畸形、override 加载失败**（打包缺陷，**不是**调用方写错）→ 抛带
  `kind: 'internal'` 的 `Error` → 落进 catch 的 `err.kind && err.kind !== 'usage'` 分支 →
  退出码 **1**（业务错误，只出 stdout JSON，不出 stderr）。**绝不**报成 usage 2（那会让 Agent
  去改命令行，而真正的问题是产物缺文件）。
  ⚠️ 这是**命令执行期**的形态；模块初始化期（`validate.json`/`specs.json` 损坏）是未捕获异常、
  stdout 空、stderr 堆栈（§十.0 加载时机第 1 条），**没有** `code/kind/message/hint` 契约——
  两形态不得混为一谈。
  ⚠️ **「override 加载失败」只可能发生在模块初始化期**（v2.3 修正，见 §十一 第 67 条）：
  override 是**模块级常量**（`const OVERRIDES = validateOverrides(raw, …)`），只在模块初始化时
  求值一次——`loadValidationOverrides()` 没有「每次调用重读」的路径，故「override 加载失败 →
  命令执行期 internal 1」是**不可能的组合**。原文把它列在「命令执行期」条目里，实施者若据此写
  一条「override 损坏 → 内部 1」的测试会发现构造不出来。另有一处**易踩的跨形态分叉**：
  `validateOverrides` 在模块初始化时会对 `validate.json` 里出现的 id 调 `paramsFor`（当前 2 份），
  故这 **2 个 id 的 params 文件**损坏时，`loadParams` 的 `kind:'internal'` 抛出发生在
  **模块初始化期**（裸崩，stdout 空）而非命令执行期——验收 13 的判据对**另外 152 个 id** 成立，
  对这 2 个不成立（验收 13 用非引用 id 构造即无碍）。
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
  且新增这类条目时测试要逐条钉住——对应 §八.3（`--strict` 的安全边界）与 §八.5（override 腐化/被滥用）。
  （v2.3 第三轮曾有一路审查把原引用「见 §八.5」判为张冠李戴——实测本 spec §八.5 正是
  「override 腐化/被滥用」，引用成立；此处显式写明两条对应关系以免后续读者再误读。）

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
| `--no-validate` 与 `--strict` 同传 | **2** | 互斥（v2）；**排在 B 块之前、`assertConfirmed` 之前**（见 §四 次序） |
| 未知 id / 不可调用 / `--body` 非法 JSON / 未知 flag | 2 | 既有 |
| **params 文件缺失或畸形** | **1** | 分两形态：**命令执行期**挂 `kind:'internal'`、只出 stdout（§四 错误分类）；**模块初始化期**（被 `validate.json` 引用的 2 个 id 的 params 文件损坏 / `validate.json` / `specs.json` 损坏）= 未捕获异常、stdout 空、stderr 堆栈（§十.0，B 不改变既有行为） |
| **override（`validate.json`）加载失败** | **1** | **只有模块初始化期一种形态**（override 是模块级常量，无命令执行期重读路径——v2.3 修正，见 §四 错误分类、§十一 第 67 条） |
| 危险未确认 | 4 | 既有；B 的硬校验在其**之前**（D5） |
| 软警告请求成功 | 0 | `meta.warnings` 随成功 meta 输出 |

`API_USAGE` 增补：`schema` 子命令行、`--no-validate`、`--strict`。
⚠️ **`API_USAGE` 不是唯一会失真的字符串**（v2.3 补，见 §十一 第 51 条）：`api.ts` 里还有
**子命令清单**（`qiyu api <list|call>`、`可用子命令：list、call` 两处）与 `callOne` 的**未知参数提示**
（`可用：--body <JSON>、--yes`）——B 之后必须把 `schema`、`--no-validate`、`--strict` 一并列出，
否则 Agent 读到的是**事实错误**的子命令/flag 清单（本仓对「说明文字不能与事实相反」有前科式敏感）。
同样，`cli.ts` 的顶层 `USAGE` 子命令表与 `README` 命令一览也要同步（见 §八之二）。
`KNOWN` 集合：**只给 `callOne` 加** `--no-validate`/`--strict`（`api list` 不校验 body）；
`schema` 有独立 `KNOWN`（`--pretty`/`--help`/`-h`）。

**红线（安全审查确认，须测试钉死）**：`--no-validate` **只**关闭 B 的校验、别名归一化与 warnings，
**绝不**影响 `assertConfirmed`——危险接口带 `--no-validate`、body **为合法 JSON 的任意值或缺失**、
**无 `--yes`** 时**仍返回 4**（非法 JSON 仍是 2，见 §九 验收 17）。

⚠️ **`has_body_schema:false` 的静默放行也作用于 4 个危险接口**（v2.3 补，见 §十一 第 67 条）：
实测 `json` + 0 body 参数的 5 个接口里，**4 个是危险接口**（`tag.batchUpdate`、`track.event.set`、
`ipcc.calltaskdetail.update`、`ipcc.calltaskdetail.delete`），§八.6 自述「验收只用 `tag.all`」
（唯一非危险的）。**Ruling**：静默放行的边界（第 36 条）对危险接口**同样接受**——理由是证据缺口
（无 body 参数表则任何字段断言无根据，且这些接口的 params 文件**只有鉴权 query 参数**
（`appKey`/`time`/`checksum`，`ipcc.calltaskdetail.*` 另含 1 个 `content-type:header`），
**无任何 body 字段**，实测确认），但代价明确：对 `ipcc.calltaskdetail.delete` 这类**删除**接口，
若真实需要 body 而注册表漏抽，CLI 会静默放行一次破坏性调用。**缓解**：这是 A 的数据抽取问题、B 不假装能覆盖（若为它们
硬编码「必须传 body」就是超出证据的断言）。**验收 27 只钉非危险的 `tag.all`**，规则同样作用于
危险 4 个但**不单独验收**——避免把「对危险接口静默放行」写成预期行为。

⚠️ **退出码 2 与 4 的语义分工必须让 Agent 分得清**（安全审查建议）：**2 = 参数写错了，改参数重来，
不需要人类介入**；**4 = 不可逆操作，必须停下向人类确认**。D5（校验先于门禁）会让一个"危险接口 +
缺必填 + 无 `--yes`"的调用先得到 2——这是**有意的**：Agent 该先修参数，修好后**必然**撞上 4 才去问人。
B 的硬拒消息里**不得**出现任何"需要人类确认"的暗示（那会把 2 与 4 混淆）。
⚠️ **「2 = 改参数重来」有既存例外**（v2.3 补，见 §十一 第 52 条）：`auth.ts` 已记录一类
「换任何参数都过不了」的 2（如「接口不可主动调用」「`auth login` 未实现」）——B 的硬拒**都属于可修类**
（消息指引 `api schema`），但 `API_USAGE` 的退出码说明应沿用既有文本，不新增歧义、也不宣称
「所有 2 都能靠改参数解决」。

## 七、`category` 处置（路线图 §八 条目 6 的 B 侧答案）

**B 不动它**——既不删数据、也不补类型/输出。`EndpointSpec` 本就没声明 category、`api list`
本就不输出，B 的变更不涉及它。**决定权归 G1**（删数据要改 A 的生成脚本并再生 154 条、补输出
要有真实消费方，两者 B 都不做）。路线图 §八 条目 6 已同步改为「已归 G1」。
⚠️ **记法**（v2.3 澄清，见 §十一 第 67 条）：路线图 §八 是**编号条目列表**（无 6/7 小节），
故引用一律写「§八 条目 6/7」，不写「§八.6/§八.7」——后者与本 spec 自己的 §八.6（`has_body_schema`
判据）/§八.7（同名字段跨 `in`）**同号不同物**，易混。

## 八、边界与风险

1. **params 与真实服务端的偏差**（D2 的根源）：文档字段表与真实返回不一致是实测常态。因此
   B 的硬校验**只覆盖「缺必填 + 非对象 body」这一最不可能出错的子集**，其余降为提示。
2. **`response_shape` 形态**（v2 新增说明）：设计稿 §5.2（:260）是 `string`，A 产物是 `{kind}` 对象。
   **以 A 的产物为准**，B 原样透传、不改写。来源优先级：`params/*.json` 的 schema 由 A 定义。
   ⚠️ 实测 154 份的 `responseShape` 恒为 `{"kind":"object"}`（150）/`{"kind":"none"}`（4），**从不是**字符串——
   设计稿的 `string` 是 A 之前的历史形态（v2.3 补，见 §十一 第 59 条）。
3. **`--strict` 的安全边界**（v2 新增）：`unknown_field` 的判定依赖 params 完整性，而文档常不全——
   故 `--strict` 的硬拒**可能误伤合法调用**（params 漏记了服务端实际接受的字段）。**「严格」≠「正确严格」**。
   文档/help 必须写明：`--strict` 只做「本地参数表闭集一致性检查」，不构成对服务端行为的保证。
   ⚠️ **误拒的次生风险**（v2.3 补，见 §十一 第 68 条）：README 把退出码 2 教成「改参数重来」，
   但 `--strict` 的误拒**不能靠改参数解决**——一个只会看退出码的 Agent 会**删掉该字段再发**，
   对危险接口就从「未发生的写」变成「缺字段的错误写」（fail-safe → 错误执行）。
   故 `--strict` 的 `unknown_field` 硬拒消息必须与「参数写错了」区分开：明确说**是本地参数表未收录**，
   **不要为绕过它而删字段**，应改用默认（非 strict）模式或报告缺失项（§四 硬形态 message、验收 29）。
4. **`--strict` 的升级范围**（D7）：只有 `unknown_field`/`type_mismatch` 被升级；
   `non_json_body`/`alias_normalized` 永远软，`--strict` 不改变它们。
5. **override 腐化 / 被滥用**：`note` 是唯一不进输出的字段，会随文档漂移。缓解：加载期强制
   「引用必须存在」（§五）、新增条目必须带证据并逐条测试。
6. **`has_body_schema` 的判据分叉**（§三/§四）：`body_kind === 'json'` 与「body 表非空」不总一致。
   实现与测试必须分别钉住这两个条件，合并成一个布尔会造出「json 但无表」时声称 validated 的谎言。
   ⚠️ **判据是 `bodyKind === 'json' 且 body 参数数 > 0`（合取式），两个条件缺一不可**（v2.3 澄清，见 §十一 第 44 条）：
   实测 154 里有 **5 个** `bodyKind: json` 却 0 body 参数（`tag.all`、`tag.batchUpdate`、`track.event.set`、
   `ipcc.calltaskdetail.update/delete`）——它们 `has_body_schema: false`、**不比对**（§四 静默通过边界）。
   4 个是危险接口（`tag.batchUpdate`/`track.event.set`/`ipcc.calltaskdetail.update`/`ipcc.calltaskdetail.delete`），
   故本 spec 的验收**只用 `tag.all`**（唯一非危险的那个）——但**规则同样作用于危险 4 个**，
   静默放行对它们的代价与 Ruling 见 §四 红线后的说明（v2.3 补，见 §十一 第 67 条）。另一侧同样有反例：
   `kefu.add` 是 `bodyKind: xml` 却有 14 个 body 参数——仍 `has_body_schema: false`（**只按参数数判就会给 true**）。
   ⚠️ 因此**测试禁止把 `has_body_schema` 写成单一条件的推断**（`=== (bodyKind === 'json')` 在 **5** 个接口上为假、
   写成 `> 0` 又在 **5** 个非 json 接口上为假——两个方向的等价变异体都要钉住），且**不得**由上层把
   `bodyKind` 预先"过滤"后再把判定简化成单条件。
7. **同名字段跨 `in`**（理论边界）：实测 0 个，但加载期仍应加护栏——同一接口里同一 `name`
   不得同时出现在 `in: "body"` 与 `in: "query"`（否则 `(name,in)` 身份歧义）。属防御性检查。

## 八之二、联动文案修正（契约诚实性审查：B 合入后不改这些文字就是「说了假话」）

B 上线后，**现有**多处文字会与代码矛盾，必须随实现一起改（**这是 B 的交付内容，不是可选项**）：

1. **`README.md:149`** —— 现值：「请求参数校验：`api call` 的 `--body` 不做字段校验，也**无法**校验——
   注册表已收录全部 **154** 条（150 个文档页 + 4 个文档外接口），并含每接口的 `params`/`responseShape`（`dist/core/registry/params/`）」。
   ⚠️ **该条位于「尚未实现」段内，替换必须整条移出**（v2.3 终审补，见 §十一 第 68 条）：
   §八之二 第 1 条的逐字建议若就地留在「尚未实现」段里，会变成「把已实现的功能写进未实现清单」——
   比原失真更糟。正确形态：**整条从「尚未实现」段删除**（验收 23 断言该段不再含「请求参数校验」），
   其功能描述移入「已实现」段/「当前状态」（见第 6 条）。
   ⚠️ **同段第二行的 `responseShape` 是注册表的 JSON 字段名、不是失真**（v2.3 终审确认）：
   `README.md:150` 描述的是 `dist/core/registry/params/` 里的文件内容，而 params 文件的顶层键
   确实是 `responseShape`（已实测：`ai.knowledge.search.json` 顶层键为 `params`/`responseShape`/`bodyKind`）——
   那里写 `responseShape` **是对的**，§十一 第 37 条的键名统一只面向 **CLI 输出键**。
   ⚠️ 但**整条移出「尚未实现」段后，第 150 行随第 149 行一起消失**，不存在「残留半条」问题。
   B 之后该 bullet 的建议归宿（第 6 条「已实现」清单新增行，逐字建议）：
   > body 分级校验：`api call` 的 `--body` 与注册表参数表比对——缺必填拒绝（退出码 2），
   > 未知字段/类型不符出 `meta.warnings`；`--strict` 可升级、`--no-validate` 可关闭。
   > 参数表见 `qiyu api schema <id>`（`data.params`、`data.response_shape`）。
   > ⚠️ 只依据文档生成的参数表，不构成对服务端行为的保证；**响应体不做校验**；
   > 校验只对 `body_kind: json` 且有 body 参数表的接口生效，其余原样透传。
   > ⚠️ `--strict` 只做本地参数表闭集一致性检查（「严格」≠「正确严格」），误拒时**不要删字段重试**。
   ⚠️ 另两处口径修正（v2.3 复查，见 §十一 第 67 条）：①「仍会返回 4」缺前提——安全审查已指出
   「缺 `--yes` 时绝不发出任何请求，直接返回 4」在 B 之后**不再恒真**（硬拒 2 先于门禁），
   故补「body 缺必填/非对象时先报 2」的前提；②「需要 `--yes`」→「需要 `--yes`（写接口仍需显式确认）」——
   与 `needs_confirmation` hint 的安全口径对齐（「必须由人类确认，不要自动追加 `--yes`」），
   避免「显式确认」被 Agent 解读为「自己加 --yes 也算显式」。
2. **`src/commands/api.ts` 的 `field_notes.request_schema`**（`api list` 的 meta）——
   现值：「本 meta **不提供**接口的请求参数表（`params`）与响应形状（`responseShape`）……本 CLI
   无法校验其字段是否正确」。
   B 之后应改为（逐字建议）：
   > 本 meta 不含参数表（体积考虑）；用 `qiyu api schema <id>` 查该接口的 `params`/`response_shape`。
   > `api call --body` 会做**有限**校验（缺必填拒绝、未知字段/类型提示）——见 `api schema` 的
   > `meta.field_notes`。⚠️ **响应体不做校验**，`response_shape` 仅供参照。
   > ⚠️ `--strict` 把「未知字段/类型不符」升级为拒绝，但那是「本地参数表闭集一致性」检查，
   > **不是对服务端行为的保证**——参数表漏记时它会误拒合法字段，此时**不要删字段重试**。
   > ⚠️ 传错的字段可能被服务端以 **14004** 拒绝，也可能被**静默忽略**——**别把「返回成功」当作「字段写对了」**。

   ⚠️ **键名口径统一**：上面两处建议文案一律写 **`response_shape`**（下划线）——那是
   `api schema` 输出里的**实际键名**；旧文里的 `responseShape` 是设计稿 §5.2 的 TS 字段名，
   不是 CLI 输出键。文案面向 Agent，写错键名会让它去读一个不存在的键（v2.3 定，见 §十一 第 37 条）。
   ⚠️ **不得只机械删旧句**：旧句里「无法校验」是当时的事实，删掉后必须补上**新的事实**（校验了什么、
   没校验什么），否则会从「说了假话」变成「什么都没说」，而 Agent 无从判断边界。特别是
   **响应体仍不校验**这一点必须保留——否则 Agent 会以为 `response_shape` 被用上了。
   ⚠️ **旧句里「静默忽略 / 成功 ≠ 字段写对」两句在 B 之后仍然为真**（B 的软警告只在调用时提示，
   `api list` 这层的全局警示不能丢）——新文案已补回。
   ⚠️ **新文案必须兼容既有测试**（v2.3 终审补，见 §十一 第 68 条）：`tests/commands/api.test.ts:159-178`
   有两条既有断言会命中新文案——①`:166` `expect(note).toMatch(/不提供|没有/)`（新文案用的是「不含」，
   **不匹配**）②`:175` `toMatch(/14004/)` 与 `:176-177` 的 14003 反向断言（新文案保留 14004、无 14003 ✓）。
   实施计划必须把 `:166` 的断言同步改为 `/不含|不提供|没有/`（或等价口径），否则 `npm test` 会红——
   这正是验收 22「`npm test` 全绿」要兜的联动。该测试的**语义**（「明说参数表不在本注册表里」）不变。
3. **路线图 §八 条目 7（「params 无运行时消费方」）在 B 合入后应标记为已关闭**（v2.3 补，见 §十一 第 53 条）。
   ⚠️ 该动作**必须进验收判据**（验收 33），否则「交付清单式执行」会漏掉它。
   ⚠️ 两处口径修正（v2.3 复查，见 §十一 第 67 条）：①「验收 23 增补」是笔误——该动作进的是**验收 33**
   （§十一 第 53 条已如此登记）；②验收 33 必须钉**形式**：保留条目 7 原文 + 加 `~~删除线~~` +
   `✅ 已关闭（B 交付）`（与条目 3 的关闭形态同款）——**不整条删除**：条目 7 是「B 为什么存在」的溯源。
4. **`src/commands/api.ts` 的子命令清单与 flag 清单**（v2.3 补，见 §十一 第 51 条）——
   ⚠️ **按语义分位补，不得混列**（v2.3 复查，见 §十一 第 68 条）：
   **子命令清单**（`qiyu api <list|call>` 用法行、`可用子命令：list、call` 两处）补 **`schema`**；
   **`callOne` 的 flag 清单**补 **`--no-validate`/`--strict`**。**不得**把 `schema` 当 flag 写进
   `可用：--body <JSON>、--yes`（它是子命令），也不得把 `--no-validate`/`--strict` 写进子命令清单。
   ⚠️ **同族四处 flag 用法串一并补**（v2.3 复查，见 §十一 第 67/68 条）：`callOne` 内枚举 flag 的
   用法串共**四处**——缺 id 用法行（`api.ts:268`）、flag 写在 id 位的用法行（`api.ts:291-292`）、
   未知参数提示（`api.ts:377`）、**位置参数分支的排他式指引**（`api.ts:399-403`：
   「接口 id 之后的参数必须写成 `--body <JSON>` / `--yes`」）。四处都补 `--no-validate`/`--strict`。
5. **`src/cli.ts` 的顶层 `USAGE` 子命令表**（v2.3 补）——`api list` / `api call` 两行之后补 `api schema`。
   ⚠️ 同时**不引入**失真（v2.3 复查）：顶层 `USAGE` 的「危险接口必须加 --yes」一行与 README 安全段
   同款——B 之后「缺 `--yes` 必然返回 4」不再恒真（硬拒 2 先于门禁），但该行是**门禁本身**的说明
   （不涉及 body 校验次序），且它不含「即使 body 错也先给 4」的断言，故**不改**——若实施者要动它，
   须同步 §八之二 第 8 条（README 安全段）的口径。
6. **`README` 命令一览与「已实现」清单**（v2.3 补）——`qiyu api schema <id>` 进命令一览；
   「已实现」清单补「body 分级校验」「`api schema`」。
   ⚠️ 同段「**本仓库仍在早期**：当前只实现了『认证 + 通用 API 通道』这一块」（`README.md:9-10`）
   在 B 之后失真（新增了 `api schema` 子命令与 body 校验）——改为「已实现『认证 + 通用 API 通道』
   ＋ API 参数校验（`api schema`/body 分级校验）」（v2.3 复查，见 §十一 第 67 条）。
   ⚠️ **同段「当前状态」句也失真**（v2.3 补，见 §十一 第 68 条）：`README.md:139` 的
   「本仓库实现了设计稿中的**第一个子项目**：认证与通用 API 通道」在 B 之后不再完整——
   改为「已实现设计稿中的**前两个子项目**：认证与通用 API 通道、API 参数校验（`api schema`/body 分级校验）」。
   ⚠️ ~~同段「尚未实现」段里的 `responseShape` 键名也要改~~ → **作废**（v2.3 终审纠正，
   见 §十一 第 68 条）：`README.md:150` 的 `responseShape` **不是失真**——它描述的是
   `dist/core/registry/params/` 里的 JSON 文件字段，而该字段确实叫 `responseShape`（已实测）。
   且该 bullet 按第 1 条**整条移出「尚未实现」段**后，第 150 行随之消失，无残留半条。
   ⚠️ `README` 目录结构段的 `registry/  接口注册表（specs.json）`（`README.md:187`）也失真——
   B 之后该目录还有 `validate.json`（B 新增）与 `params/`（A 起），一并更新。
7. **`CHANGELOG.md`**（v2.3 补）——按其自身规则（「所有重要变更都会记录在此文件」）补 B 的条目
   （`### 新增` 段加 `- qiyu api schema <id> —— …` 与 body 分级校验条目）。**列为验收 35**（v2.3 复查，
   见 §十一 第 67 条：原只写在联动段落、不在验收网内，按「交付清单式执行」会漏）。
8. **`README` 安全段**（v2.3 复查，见 §十一 第 67 条）——现值（`README.md:129-130`）：
   「标记为 `dangerous` 的接口在缺少 `--yes` 时，**绝不发出任何请求**，直接返回退出码 4」。
   B 之后此句**不再恒真**（D5 让硬拒 2 先于门禁）——改为「缺少 `--yes` 时**绝不发出任何请求**：
   body 合法则返回退出码 4，body 缺必填/非对象则**先**报参数错误（退出码 2）」。否则只读安全段的
   Agent 会以为「危险接口 + 坏 body 必得 4、加 --yes 即可」——正是本段开头定义的「说了假话」。
   断言并入验收 23。


## 九、验收判据（spec 级，供实施计划展开为测试）

1. `qiyu api schema ai.knowledge.search` → 0；stdout 含 `body_kind:"json"`、
   `has_body_schema:true`、`params` 里 `appKey` 带 `auto:true`、`robotId` 为 `required:true`；
   `response_shape` 为对象 `{"kind":"object"}`（**不是**字符串——钉住 §八.2 的「原样透传」，
   v2.3 补，见 §十一 第 68 条）；
   `meta.field_notes` 存在；`meta` **不含** `validation` 键（D9 的反向断言，v2.3 补，见 §十一 第 68 条：
   原判据只正向断 `field_notes` 存在，实施者若从 v1 残留代码里继承了 `meta.validation`，全量验收照绿）；
   `data` 里**没有** `one_of` 键（本接口无 one-of 组，验收 25 的另一半）；
   `meta.note` **不输出**（该接口 specs.json 无 note；这是 D9 后 schema 的正确行为）。
   ⚠️ 另验「**有** note 的接口**会**输出 note」（v2.3 补，见 §十一 第 67 条）：`api schema ai.knowledge.addKnowledge`
   （`dangerous:true`、specs.json 带 note）→ `meta.note` 存在且与 specs.json 的 note 逐字一致。
   原判据只在验收 1 的括号里提了「有 note 就带上」，正文无正向说明、也无验收钉——实施者照 §三
   输出字段清单（未列 `note`）实现会**永不输出** note，验收 1 照样绿。
2. `qiyu api schema 不存在的id` → 2；stdout `{"ok":false,…}`、stderr 有点名的 `byId` 消息。
3. `qiyu api call ai.knowledge.addKnowledge --body '{"name":"x","answer":"y","similars":[],"validitySwitch":1,"categoryId":1}'`
   （**只缺** `robotId`；其余必填齐）→ **2、零网络请求**（mock fetch 断言未被调用）、stderr 点名 `robotId`、
   stdout `error.kind==="usage"` 且**不含** `confirm_required`。
4. 同上 body 再加 `"bogus":1` → 仍 **2**（硬拒短路，**不**输出 warnings——§四 的短路规则）。
   ⚠️ 3/4 之所以是 2 而不是 4：`ai.knowledge.addKnowledge` 是**危险接口**，但 D5 让校验先于门禁——
   缺必填在本地拦下，根本走不到 `--yes` 门禁。这**正是** D5 的验收。
5. **改用非危险接口** `ai.knowledge.search`（必填 body 字段仅 `robotId`，`dangerous:false`）：
   `--body '{"robotId":1,"bogus":1}'` → **0**，`meta.warnings` 含 `{kind:"unknown_field", field:"bogus"}`，
   ⚠️ 且**断言其 `message` 含「已发出」与「不要重发」**（v2.3 补，见 §十一 第 68 条：该 message 是
   安全关键文本，此前无验收钉它——实施者漏写「已发出 + 不要重发」，全量验收照绿）。
   （不用 addKnowledge：它是危险接口，合法 body 会撞 `--yes` 门禁返回 4，验不到「软警告 + 成功」。）
6. `merchant.account.login`（**危险接口，须加 `--yes`**）只传 `userName+code`（缺 `shopCode`）→ **0**
   （one-of 满足、不误拒）；`--body '{}'`（**显式空对象**，三者全缺）→ 2，且消息**同时**包含：
   ① override 的 `message`（组全缺）② 缺失的**单个**必填字段名 `userName`（它不在 one-of 组内、
   relax 后仍必填）。
   ⚠️ **「三者全缺」必须用 `--body '{}'` 构造**（v2.3 修正，见 §十一 第 68 条）：若**不传 `--body`**，
   按 §四 硬规则 2 走「未传 `--body`」分支，消息点明「未传 `--body`」而**不再逐个点名缺失字段**
   （那样 ② 的 `userName` 断言会失败）——两种构造结果不同，须钉死。
   ⚠️ 硬拒消息的**合成规则**（v2.3 定，见 §十一 第 54 条）：`vr.hard` 里**每条硬违规各一行**、
   按规则序拼接（组消息与单字段消息都出现），**不**做「只报第一条」短路——否则 Agent 补完
   `userName` 后还会再撞 one-of，多烧一轮且第二条消息未点名 `userName`。
   ⚠️ **拼接次序钉为「先 per-field 缺必填、后 one-of 组」**（v2.3 补，见 §十一 第 68 条）：
   `vr.hard` 的顺序即输出顺序；验收同时断言 `userName` 行出现在组 `message` **之前**——
   与 §四 硬规则「先逐字段、后 one-of」的判定序一致（不钉则两种实现都过验收）。
7. `ai.knowledge.editKnowledgeNoSimilars`（危险接口，加 `--yes`）传
   `--body '{"id":1,"robotId":2,"name":"q","answer":"a","validitySwitch":1,"categoryId":1,"ruleType":0,"channelAnswers":[]}'`
   （用源键 `name`，其余必填齐）→ **0**；`meta.warnings` 含 `{kind:"alias_normalized", field:"name"}`，
   ⚠️ 且**断言其 `message` 含「无需重试」**（v2.3 补，见 §十一 第 66 条：该 message 是安全关键文本，
   但此前无验收钉它——实施者省略或改写，全量验收照绿）。
   且**实际发给 `call()` 的 body 用 `question`**（mock 断言）；`name` 不产生 `unknown_field`。
   同 body 再加 `"question":"q2"`（源键与目标键都在）→ **2**（歧义硬拒）。
8. `qiyu api call tag.all --body '{"foo":"bar"}'` → **0**，**不出** `unknown_field`——因为 `tag.all`
   有 0 个 body 参数（`has_body_schema:false`），§四 的比对本就跳过（无需任何 override）。
   ⚠️ **形状也不判**：再验 `tag.all --body '[]'` / `'null'` → **0、仍不硬拒**（见 27）——
   `has_body_schema:false` 的接口连形状都不比对，这是本 spec 的有意边界。
   另验 **`api schema tag.all`** → `has_body_schema:false`、`body_kind:"json"`（判据是合取式，
   不是「json 就 true」——见 §八.6）。
9. **非 json body**（用**非危险**的 `icoutcall.phone.getLineList`，`bodyKind:"none"`、`callable`、`dangerous:false`）：
   带 `--body '"x"'` → **0**、`meta.warnings` 含 `{kind:"non_json_body"}`、请求照发（mock），
   ⚠️ 且**断言其 `message` 含「已发出」与「不要重发」、且不含「未验证」**（v2.3 补，见 §十一 第 68 条：
   「未验证」是「值得再试」的措辞，危险接口上会诱导实验性重发——必须钉住它不出现）。
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
    模块初始化失败（`loadValidationOverrides()` 求值期抛错 → 退出码 **1**、**stderr 含堆栈、stdout 为空**，
    入口 `.catch()` 兜不住——§十.0 加载时机第 1 条）**不进 `npm test`**：
    ⚠️ **本条是发布前手动 checklist，不写进 `npm test`**（v2.3 定，见 §十一 第 66 条）：这是**进程级**
    断言（模块求值期抛错），而现有 `tests/` 无 `spawn`/`child_process` 先例、无 tsx 依赖、`vitest.config.ts`
    钉死 `testTimeout: 5_000` 无余量、且触发它必须**改坏真实的 `validate.json`**（污染工作区）或
    构造临时副本（`validate.json` 路径写死在 `params.ts` 里，无法注入）。与验收 24 同款处理：
    实施计划把它列为发布前人工步骤（`node dist/cli.js auth whoami` 前改坏 `dist/core/registry/validate.json`，
    观察 stdout 空 + stderr 堆栈 + 退出码 1，复原）。
    ⚠️ 这条与「命令执行期的 `internal` → 退出码 1 + stdout JSON」是**两种不同的失败形态**，
    测试与 Agent 都不得混为一谈。
13. **params 文件缺失/畸形** → 退出码 **1**、`kind:"internal"`、**不是** usage 双通道
    （构造：**经注入的 params 根目录**临时移除/改坏 `params/<id>.json`，断言 call 与 schema 行为一致）。
    ⚠️ 不得直接改仓库里的真文件（会污染工作区、且 `loadParams` 的缓存让同进程内改文件读不到）。
    ⚠️ **注入机制**（v2.3 补，见 §十一 第 67 条）：`params.ts` 持一个模块级 `let injectedRoot: string | undefined`
    并导出 `setParamsRoot(dir: string | undefined)`；`loadParams(id, root = injectedRoot)` 默认取它
    （**调用时**读 `injectedRoot`，不是 import 时）。生产**不调用** `setParamsRoot`
    （`injectedRoot` 恒 `undefined` = 用 `import.meta.url` 定位真目录），`callOne`/`schema` 仍写
    `loadParams(spec.id)` **无需改签名**。**缓存键是 `(root, id)`**（见 §十.0），故不同 root 互不污染。
    测试流程（见 §十.1）：复制 → 改坏 → 设 root → 断言（无需 resetModules）。
14. `qiyu api schema crm.modifyOrder`（`callable:false`）→ **0**，输出照常（不经 `assertCallable`）。
15. `--no-validate --strict` 同传 → **2**。
    ⚠️ 该检查**排在 B 块之前、`assertConfirmed` 之前**（§四 次序图）——故危险接口上
    `NV+S` 无 `--yes` 也先得到 2（互斥），不会先撞 4。
16. `--body '{"robotId":null}'`（用非危险的 `ai.knowledge.search`，必填 `robotId` 值为 null）：
    普通模式 → **0** + `type_mismatch`；`--strict` → **2**。钉住「存在 ≠ 通过」。
17. **红线**：危险接口带 `--no-validate`、body 为**合法 JSON 的任意值或缺失**、无 `--yes` → **4**
    （`--no-validate` 不削弱门禁）。⚠️ 「任意」**不含非法 JSON**——`--body` 的 `JSON.parse` 在 B 之前，
    非法 JSON 恒 → 2（B 不改这条既有行为，`--no-validate` 也不豁免）。
    本条须同时断言 `fetch` **未被调用**（与硬违规同款 mock 约定）。
18. `--body '[]'` / `'null'` / `'"x"'` 对「有 body 表」的**非危险**接口（`ai.knowledge.search`）→ **2**
    （非对象硬拒，先于门禁）；对 0 body 表的**非危险**接口（`icoutcall.phone.getLineList`）→ 不因形状报错。
    ⚠️ 不用 `export.session`（危险接口，形状不报错也会撞门禁返回 4）。
19. `--no-validate` 下 B 完全静默（用**非危险**接口验，否则会撞门禁返回 4）：
    对 `ai.knowledge.search` 传 `--body '{}'`（缺 `robotId`）→ 不再硬拒，**请求照常构造并交给
    `call()`**（断言 mock 的 `fetch` **已被调用**，即 `call()` 确实走到网络层；测试中**不产生真实网络流量**）；
    9 的 `non_json_body`、7 的 `alias_normalized` 等 warnings 一律不再输出。
    **别名改写也不再发生**——但**不用**「非危险的等价场景」验（v2.3 修正，见 §十一 第 55 条）：
    当前 override 表里 `aliases` **只有** `editKnowledgeNoSimilars`（危险接口），不存在非危险替身。
    改为：对 `editKnowledgeNoSimilars` 加 `--yes --no-validate`，断言 mock fetch 收到的 body
    **含 `name` 键、不含 `question` 键**（改写确实被关闭）——危险接口在此无妨（门禁由 `--yes` 放行，
    与验收 17 同款结构）。
20. `--strict` 下 5（`ai.knowledge.search` 带 `bogus`）→ **2**；9 的 `non_json_body`、7 的 `alias_normalized`
    仍只提示（D7）。
21. **生成确定性不受影响**：`validate.json` 不进生成输出；`generate.mjs` 重跑后 `specs.json` 与
    params 字节不变（复用/扩展 `tests/registry/generate.test.ts`）。
    ⚠️ **只能断言 fixture 子集，不能断言 154**（v2.3 修正，见 §十一 第 68 条）：该测试的
    `PAGES_DIR` 指向 `tests/fixtures/registry/pages/`（24 页 → `EXPECTED_TOTAL = 28`），
    真实的 150 页在 `registry-src/pages/` 而该目录被 `.gitignore:48` 忽略（CI/新克隆上不存在）。
    故「重跑后 154 份字节不变」在本仓的常规 CI 路径上**不可达**——断言对象是 fixture 样本的确定性，
    154 的完整性由 `api.test.ts` 的 `allEndpoints().length >= 154`（数据推导式）另行覆盖。
    本条的实质是「生成器不被 validate.json 影响 + 样本重跑确定」，不是「154 份被重生成」。
22. `npm test` 全绿、`npm run typecheck` 0 错误；既有计数型断言（154 等）同步核对。
23. **联动文案**（§八之二）：`README.md` 与 `api list` 的 `field_notes.request_schema` 已改为
   与实现一致的新文案；断言二者**不再**含「不做字段校验/无法校验/不提供 params」等旧表述，
    且**保留**「响应体不做校验」的说明。
    ⚠️ **扩围**（v2.3 补，见 §十一 第 67 条）：本条同时断言 §八之二 第 1 条的两处口径修正
    （①「仍会返回 4」补「body 缺必填/非对象时先报 2」前提；②「需要 `--yes`」→「写接口仍需显式确认」）、
    第 6 条的三处（横幅句、命令一览、已实现清单）、第 8 条（README 安全段「绝不发出任何请求」补
    「body 合法则 4、body 缺必填/非对象则先 2」）、第 7 条（CHANGELOG `[未发布]` 段含 B 条目）。
    原判据只覆盖 README:149 与 `request_schema` 两处，其余联动动作无验收——按「交付清单式执行」会漏。
    ⚠️ **再扩围**（v2.3 补，见 §十一 第 68 条 ⑰）：第 1 条与第 2 条文案均须含
    **「严格」≠「正确严格」/「不是对服务端行为的保证」**口径与**「不要删字段重试」**指引——
    断言两处文案含「严格」（或「参数表闭集」）且含「不要删字段」/「不要为绕过它而删字段」。
    ⚠️ **再扩围**（v2.3 补，见 §十一 第 68 条 ⑯）：第 6 条的验收钉还要覆盖
    「从『尚未实现』段移除、列入已实现」两向断言（该句**不在**「尚未实现」段内 + 在已实现清单内）、
    「第一个子项目」→「前两个子项目」的替换（终审补，见 §十一 第 68 条）——
    两条都是 Agent 会照着读的失真文字，按「交付清单式执行」会漏。
24. **打包后能读到 `validate.json`**（§五 路径说明的验收）：`npm run build` 后
   `dist/core/registry/validate.json` **存在**；从**非仓库目录**运行打包产物（如
   `node <repo>/dist/cli.js api call ai.knowledge.search --body '{"robotId":1}'`）时，
   override 仍生效（`merchant.account.login` 的 one-of 在打包产物里同样不误拒）。
   —— 钉住「运行时文件确实进了 dist、且路径不依赖 CWD」。
   ⚠️ **本条是发布前手动 checklist，不写进 `npm test`**（v2.3 定，见 §十一 第 64 条）：
   `vitest.config.ts` 钉死 `testTimeout: 5_000`，在测试里跑 `npm run build`（tsc + copy-params）
   没有超时余量，且会动 `dist/`。实施计划把它列为发布前人工步骤。
25. **`api schema merchant.account.login` 输出 `one_of`**（§三）：`data.one_of` 存在且
   `[0].anyOf` 含 `code`/`shopCode`、`message` 与 override 逐字一致；同时 `params` 里
   `code`/`shopCode` 的 `required` 已为 `false`（relaxRequired 生效）；
   ⚠️ 且 `meta.field_notes.one_of` 存在并含「**任一**」字样（v2.3 补，见 §十一 第 67 条：
   否则 Agent 可能把「组内任一」读成「全必填」或「全可省」——`required:false` 配无解释的
   `one_of` 反而更像「两个都可省」）。
   对**无** one-of 的接口（如 `ai.knowledge.search`）→ 输出里**没有** `one_of` 键（不是 `[]`/`null`）。
26. **`api schema` 的 internal 出口**（§三/§四 错误分类）：对某接口临时移除/改坏
   `params/<id>.json` 后 `qiyu api schema <id>` → **1**、`kind:"internal"`、`retryable:false`、
   **stderr 空**；与验收 13 的 `api call` 行为**逐字段一致**（同一出口，不是两份实现）。
27. **0 body 表的 json 接口形状不判**（§四 边界）：`tag.all --body '[]'` / `'null'` / `'"x"'`
   → **0、无 warning、不硬拒**（`has_body_schema:false` → 形状表不生效）。
28. **`type_mismatch` 的 `<实际类型>` 渲染**（§四 message 表）：`ai.knowledge.search --body '{"robotId":null}'`
    的 warning message 必须含「实际是 `null`」（**不是** `object`）；`--body '{"robotId":[]}'` → 「实际是 数组」；
    `--body '{"robotId":"1"}'` → 「实际是 `string`」。钉住渲染词汇，防 `typeof` 泄漏。
    ⚠️ 且**断言 message 含「已随请求发出」**（v2.3 补，见 §十一 第 68 条：与验收 5 同款，
    type_mismatch 的重发防护同样无验收则会被漏写）。
29. **`--strict` 硬拒的消息带字段名**（§四）：`ai.knowledge.search --strict --body '{"robotId":1,"bogus":1}'`
    → **2**，stderr/消息**点名 `bogus`**（不能只有一个无字段名的 «usage 错误»——Agent 需知道改哪个键）；
    ⚠️ 且断言消息**不含「已发出」**（v2.3 补，见 §十一 第 68 条：硬形态没有请求发出，
    复用软模板会在退出码 2 里宣称「请求已发出」——与事实相反）。
30. **别名冲突消息**（§四）：`editKnowledgeNoSimilars --yes --body`（同时含 `name` 与 `question`）
    → **2**，消息要求「只传其一」（不预设谁优先）。
31. **`non_json_body`/`alias_normalized` 在危险接口成功响应里也照出**（§四）：危险接口带 `--yes`
    成功时，若触发这两类 warning，`meta.warnings` 照常输出（信息性，不代表失败）。
32. **子命令/flag 清单文案**（§八之二 第 4–6 条）：⚠️ **按语义分位补，不得混列**（v2.3 复查，
    见 §十一 第 68 条）——**子命令清单**（`API_USAGE` 的 `qiyu api <list|call>`、`可用子命令：list、call`
    两处、`cli.ts` 的 `USAGE`、README 命令一览）补 **`schema`**（它是子命令）；
    **`callOne` 的 flag 清单**（`可用：--body <JSON>、--yes` 及同族四处用法串）补
    **`--no-validate`/`--strict`**（它们是 flag），**不得**把 `schema` 塞进 flag 清单、
    也不得把 `--no-validate`/`--strict` 塞进子命令清单——那会产出**事实错误**的清单
    （把子命令当 flag 报给 Agent），正是本仓最敏感的「说明文字与事实相反」。
    断言**不再**出现只列 `list|call` 的旧文本。
33. **路线图 §八 条目 7（与条目 4）标记关闭**（§八之二 第 3 条、§一）：
    `docs/superpowers/specs/2026-10-09-后续交付路线图-design.md` 里 §八 条目 7 已标为「已关闭」、
    条目 4 已标为「已关闭（B 独立交付）」。
    ⚠️ **钉住形式**（v2.3 补，见 §十一 第 67 条）：**保留条目原文 + 加 `~~删除线~~` + `✅ 已关闭`
    （与条目 3 的关闭形态同款）**，**不整条删除**——条目 7 是「B 为什么存在」的溯源，删掉它
    就丢了 B 的动机记录（原判据不钉形式，「整条删掉」也能过验收）。
    ⚠️ **落点**：`tests/readme.test.ts`（读路线图断言条目 7/条目 4 含 `~~` + `✅`）。
34. **`meta.warnings` 两来源的合成次序**（§四）：对同时触发 `alias_normalized` 与
    `unknown_field`/`type_mismatch` 的 body（对危险接口 `editKnowledgeNoSimilars` 加 `--yes`），
    `meta.warnings` 必须保持**稳定顺序**：`[...aliasWarnings, ...vr.soft]`，两段各自再按
    「params 表顺序 → body 键出现顺序」。不定义会让两种实现输出互为逆序的数组。
    ⚠️ **测试输入必须补齐全部必填**（v2.3 补，见 §十一 第 68 条）：`{"bogus":1,"name":"q"}`
    **缺 7 个必填**（`id/robotId/answer/validitySwitch/categoryId/ruleType/channelAnswers`——
    `question` 由别名归一化补上），直接传会先撞缺必填硬拒 **2**、到不了 warnings 合成。
    正确输入：`{"id":1,"robotId":2,"name":"q","answer":"a","validitySwitch":1,"categoryId":1,
    "ruleType":0,"channelAnswers":[],"bogus":1}` → 期望
    `[alias_normalized(name), unknown_field(bogus)]`（**这个次序**）。
35. **CHANGELOG 已记录 B**（§八之二 第 7 条，v2.3 补，见 §十一 第 67 条）：
    `CHANGELOG.md` 的 `## [未发布]` 段含 B 的条目（`api schema` 子命令 + body 分级校验）——
    与验收 33 同款：断言存在，否则「按其自身规则记录重要变更」是无人执行的纸面条款。
    ⚠️ **落点**：`tests/readme.test.ts`（读 `CHANGELOG.md` 断言 `[未发布]` 段含 `api schema`），
    与验收 23 的 README 断言同文件。

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
 *  ⚠️ 第二个参数 `root` 是**注入的 params 根目录**（源码态 = `dist`/`src` 同构的
 *  `.../core/registry/`，见下方加载机制），默认指向真实目录；**测试**把 root 指向
 *  `mkdtempSync` 出的副本，以便构造「缺失/畸形」而不污染仓库真文件（见 §九 验收 13/26）。
 *  同进程内 `root` 一经首次读取即并入缓存（缓存键 `(root, id)`，见下），故同一路径内容被
 *  改写后要靠 `vi.resetModules()` 起新模块图才能重读——但**改 root 本身不需要 reset**
 *  （不同 root 是不同缓存键）。
 *  ⚠️ **缓存键是 `(root, id)`**（v2.3 补，见 §十一 第 67 条）：若缓存只按 `id` 键入，
 *  同进程内切 root 后仍会读到旧 root 的文件（缓存会掩盖改动）。
 *  ⚠️ **`setParamsRoot` 与「读 root」必须是同一个 `params.ts` 实例**（v2.3 修正，见 §十一 第 67 条）：
 *  它设的是**被调用时那个实例**的模块级变量，而 `loadParams` 在**调用时**读 `injectedRoot`。
 *  实测（最小 ESM 探针）：**set-then-reset** → `resetModules()` 后拿到新实例、root 丢失
 *  （读回 `undefined`）；**reset-then-set** → 生效。故若测试用 `vi.resetModules()`，
 *  必须**先 reset、后 set**；或干脆**不 reset**——静态 import 的 `apiCommand` 与测试里
 *  `setParamsRoot` 本就是同一个 `params.ts` 实例，直接 `setParamsRoot(copyDir)` 即生效。
 *  ⚠️ 生产环境**每个 id 都有** params 文件（实测 154/154），故返回值**非 null**；
 *  「该接口没有 body 表可比对」（如 `tag.all`：json 但 0 body 参数）由**文件内容**表达，
 *  不由 null 表达 —— 调用方拿到 `ParamFile` 后按 `bodyKind` 与 body 参数数自行判定。 */
export function loadParams(id: string, root?: string): ParamFile
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
 *  ⚠️ `hasBodySchema` 的判据是**合取式**「`file.bodyKind === 'json'` 且 body 参数数 > 0」（§三 / §八.6：
 *  5 个 `json` 接口 0 body 参数、`kefu.add` 是 `xml` 却有 14 个 body 参数——两个条件缺一不可）。
 *  实现必须由这个函数从 `file` 现算，**不要**另存一个可能与单一条件混同的布尔（单向化会造出
 *  「json 但无表」声称 validated、或把 xml 有表接口误判有表两种谎言）。 */
export function validateBody(
  spec: EndpointSpec, file: ParamFile, body: unknown,
  ov: ValidationOverride | undefined, mode: { strict: boolean },
): ValidateResult
// ⚠️ `spec` 的唯一用途：硬拒/警告消息里回显 `spec.id`（`ParamFile` 不含 id）。
//   **不**读 `spec.dangerous`/`callable`——那是 `assertConfirmed`/`assertCallable` 的职责，
//   校验层不得越权（v2.3 补，见 §十一 第 65 条）。
```

```ts
// src/commands/api.ts（`api schema` 的输出层加工，不是文件字段）
/** `ParamSpec` 的浅复制 + `auto`：见 §三 `params` 说明。`auto` 只加给 query 里的鉴权参数 */
export type SchemaParam = ParamSpec & { auto?: true }

/** 应用 override 后的有效 body 参数表（v2.3 补，见 §十一 第 68 条）：
 *  把 `ov.relaxRequired` 列出的字段 `required` 降为 false；其余原样。
 *  ⚠️ **`api schema` 的 `params` 输出与 `validateBody` 的「缺必填」判定必须共用本函数**——
 *  两处各写一份会漂移：schema 说 `required:false`、`api call` 却按 `true` 拒（§三 自己要消灭的矛盾）。
 *  纯函数、不碰 I/O；`ov` 为 `undefined` 时原样返回 `file.params`。 */
export function effectiveBodyParams(file: ParamFile, ov: ValidationOverride | undefined): ParamSpec[]

/** 私有：`--no-validate` 与 `--strict` 同传 → 抛普通 Error（→ 退出码 2，§四 次序图）。
 *  v2.3 补，见 §十一 第 68 条：读 `argv.includes('--no-validate') && argv.includes('--strict')`，
 *  排在 `byId`/`assertCallable` 之后、B 块之前（是「参数校验必须全部在 byId 之前」不变量的例外，
 *  理由见 §四 接入点）。抛普通 Error、不挂 kind → 落 usage 兜底出口。 */
export function assertNoValidateStrictConflict(argv: string[]): void
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
import { fileURLToPath, pathToFileURL } from 'node:url'
let injectedRoot: string | undefined                       // 模块级；生产恒 undefined
export function setParamsRoot(dir: string | undefined) { injectedRoot = dir }
export function loadParams(id: string, root: string | undefined = injectedRoot): ParamFile {
  const base = root ?? fileURLToPath(new URL('.', import.meta.url))   // 默认：本模块所在目录
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL(`./params/${id}.json`, pathToFileURL(base + '/'))), 'utf8'))
  return validateParamsFile(id, raw)
}
```

⚠️ `root` 参数默认取模块级 `injectedRoot`（生产不调用 `setParamsRoot` → `undefined` → 用
`import.meta.url` 定位真目录）；代码片段必须体现 root 的用法，否则与签名 `loadParams(id, root?)`
不一致（v2.3 补，见 §十一 第 67 条）。`loadParams` 在**调用时**读 `injectedRoot`（不是 import 时），
故测试里 `setParamsRoot` 与调用方静态 import 的必须是**同一实例**（见上注释）。
缓存键 `(root, id)`（见上）。`pathToFileURL` 从 `node:url` 一并 import。

**不**用动态 `import()`（ESM 下需 import attributes、缓存语义复杂），**不**用相对 CWD 的路径
（CLI 从任意目录启动会找不到文件）。

**override 的加载时机与失败范围**（v2.3 澄清，见 §十一 第 40 条）：`validate.json` 在
**模块初始化时**加载并校验，与 `specs.json`（`const SPECS = loadSpecs(raw)`）**同款**——
`const OVERRIDES = validateOverrides(raw, allEndpoints(), loadParams)` 是一个模块级常量，
不是每次调用重读。三条后果都必须是有意的：

1. **失败即模块初始化抛错** → 由 `cli.ts` 入口的 `.catch()` 兜住 → 退出码 **1**、`kind:'internal'`
   （不是未捕获堆栈）。验收 12 的「启动即抛」指的是这一层。
   ⚠️ **这条断言是错的**（v2.3 修正，见 §十一 第 46 条）：ESM 下静态 `import` 的依赖在**模块求值期**
   抛错时，入口模块体还没执行，`cli.ts` 的 `.catch()` 根本没注册——**兜不住**。实测（最小探针 +
   真实 dist 副本改坏 `specs.json`）：stdout **0 字节**、stderr 是原生堆栈、退出码 1。
   故本条改为：**失败 = 未捕获异常**（与 `specs.json` 的既有行为**逐字一致**——它同样裸崩），
   §四 的 `internal` 契约（`code/kind/retryable/message/hint`）**只覆盖命令执行期**的失败
   （`loadParams` 在 `callOne` 内被调用时抛的错），**不覆盖**模块初始化期。
   验收 12 的集成断言相应改为「退出码 1、stderr 含堆栈、**stdout 为空**」——
   这条路径**不承诺** stdout JSON（与全局约束的冲突是既有的、由 `specs.json` 继承来的，B 不扩大也不假装修复）。
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
  危险接口次序回归、`--no-validate` 不削弱门禁；**验收 1 的 `meta.note`、验收 7 的
  `alias_normalized.message`、验收 25 的 `field_notes.one_of`（v2.3 从 `readme.test.ts` 移回，
  见 §十一 第 68 条）**；验收 13/26 的 root 注入流程。
  ⚠️ **既有 `request_schema` 文案断言须同步**（v2.3 终审补，见 §十一 第 68 条）：
  `api.test.ts:166` 的 `toMatch(/不提供|没有/)` 命中新文案「**不含**参数表」会**红**
  （「不含」不匹配该正则）——实施计划把它改为 `/不含|不提供|没有/`；
  `:175` 的 `/14004/` 与 `:176-177` 的 14003 反向断言保持不变（新文案保留 14004）。
- `tests/registry/generate.test.ts`（扩展）：`validate.json` 不进生成、确定性不变。
- `tests/readme.test.ts`（新，v2.3 补，见 §十一 第 60 条）：读 `README.md` 断言 §八之二 第 1 条的
  新文案在、旧表述（「不做字段校验」「无法校验」「不提供 params」）不在、「响应体不做校验」保留——
  验收 23 的 README 部分落这里（原落点清单没有它，会变成无人执行的纸面条款）。
  ⚠️ **扩围**（v2.3 补，见 §十一 第 67/68 条）：同一文件同时断言——①验收 23 扩围（横幅句、
  已实现清单、README 安全段）；②验收 35（CHANGELOG `[未发布]` 段含 `api schema`）；
  ③验收 33（路线图条目 7/条目 4 标关闭）。
  ⚠️ **③④⑤（CLI 行为断言）归 `api.test.ts`，不落这里**（v2.3 修正，见 §十一 第 68 条）：
  验收 1 的 `meta.note`、验收 7 的 `alias_normalized.message`、验收 25 的 `field_notes.one_of`
  都是 `apiCommand` 运行时行为，需要 stdout 捕获 + fetch mock + 凭证 stub 全套夹具
  （在 `api.test.ts:10-49`）；`readme.test.ts` 只读文件、无此夹具。把一条验收（如 7）的
  「kind/field/body 改写」与「message 含无需重试」拆到两个文件，改一处漏一处。
  **`readme.test.ts` 只保留纯文本断言（①②③）；③④⑤ 落 `api.test.ts`。**
  ⚠️ **root 注入测试流程**（v2.3 补，见 §十一 第 67/68 条）：验收 13/26 落 `api.test.ts`——
  ① `mkdtempSync` 复制 `src/core/registry/` 内容 → ② 改坏副本目标文件 → ③ `setParamsRoot(副本目录)`
  → ④ 断言 → ⑤ **`afterEach`/`finally` 里 `setParamsRoot(undefined)` 复位**。
  **不需要 `vi.resetModules()`**：`setParamsRoot` 设的与 `apiCommand` 静态 import 的
  是**同一个 `params.ts` 实例**，而 `loadParams` 在**调用时**读 `injectedRoot`（实测：直接
  set 后调用即生效）。⚠️ **⑤ 复位不可省**（v2.3 补，见 §十一 第 68 条）：`setParamsRoot` 设的是
  **模块级单例**，不复位则同文件后续所有 `apiCommand` 都继续用副本 root；一旦副本被清理删除，
  后续用例会因读不到 params 而集体走 `internal 1`——**级联失败**。⚠️ **若确实用了
  `vi.resetModules()`，顺序必须是「先 reset、后 set」**——实测 set-then-reset 会让新实例的
  root 丢失（读回 `undefined`），reset-then-set 才生效（§十.0 缓存键）。
  ⚠️ **验收 12 的集成级断言**（模块初始化失败）**不落 `npm test`**——发布前手动 checklist
  （见 §十一 第 66 条），`tests/` 无子进程测试基建。
- **测试基建**：
  ⚠️ **凭证注入沿用既有 per-test 口径**（v2.3 修正，见 §十一 第 61 条）：现有 `api.test.ts` 是
  **逐用例** `vi.stubEnv('QIYU_APP_KEY', …)` + `afterEach` 清空（18 处用例），且**存在反向用例**——
  显式 stub 空串来测 `auth_missing`。若新测试文件用共享 `beforeEach` 统一注入凭证，必须
  成对 `afterEach` 清空，且**不得**污染这类反向用例（否则「没发请求」的断言会假绿）。
  需要凭证才能走到请求路径的用例沿用 per-test 注入（与现状一致）。
  `vi.stubGlobal('fetch', …)` 且硬违规用「被调用即失败」的 mock；**不使用真实凭证/网络**。
  既有 350 用例若含计数哨兵需同步更新。

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
| 9 | ~~`body_validated` → **`has_body_schema`**；`bodyIgnored` 组合语义闭合~~ → **两半均被后续裁决推翻、已作废**（v2.3 标注，见 §十一 第 68 条 ㉑）：`bodyIgnored` 整字段被第 28 条删除（本条「组合语义闭合」随之无对象）；`body_validated` 在正文 §三 已改名 `has_body_schema` 且判据为合取式（第 44 条）。**结论以第 28/44 条为准** | 契约诚实性 + 内部自洽 |
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
| 23 | ~~补 `has_body_schema` 与 `bodyIgnored` 的组合语义（表存在 vs 本次是否比对，不再加字段）~~ → **作废**（v2.3 标注，见 §十一 第 68 条 ㉑）：`bodyIgnored` 被第 28 条整体删除，本条无对象。`has_body_schema` 的判据以第 44 条（合取式）为准 | 内部自洽 |
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
| 36 | **`has_body_schema:false` 的静默通过写成显式边界**（v2.3）：agent 审查指出这类接口传任何 body 都静默通过，原文未提。**Ruling**：这是**证据缺口**不是能力缺口（无参数表则任何「字段可疑」的断言都无根据，与 §八.1 同源），有意接受；schema 侧以 `has_body_schema:false` 补偿，`api call` 侧**不**加 warning（会是「声明了没人读」的装饰，且对 `bodyKind:none` 合法调用稳定误报）。⚠️ **本条曾附带「判据是『body 参数数>0』，与 bodyKind 无关」的表述——该表述已被第 44 条推翻并改为合取式，此处不再复述**（v2.3 复查，见第 67 条） | agent 对抗审查 + controller ruling |
| 37 | **联动文案键名统一为 `response_shape`**（v2.3）：§八之二 建议文案里混用了 `responseShape`（设计稿 TS 字段名）与 `response_shape`（CLI 实际输出键）。面向 Agent 的文案必须用实际键名，否则它会去读一个不存在的键。并给 README 文案补一句「校验先于危险门禁、合法 body 仍返 4」 | 上游一致性 |
| 38 | **验收 19 措辞修正**（v2.3）：「改为真实发请求」在「不使用真实网络」的测试基建下自相矛盾。改为「请求照常构造并交给 `call()`，断言 mock fetch 已被调用」，并显式声明测试不产生真实流量 | 可实现性 |
| 39 | **新增验收 25/26**（v2.3）：25 钉住 `one_of` 输出（含「无 one-of 时键不出现」）；26 钉住 `api schema` 的 internal 出口与 `api call` **逐字段一致**（同一出口，防两份实现） | 内部自洽 + 可实现性 |
| 40 | **补 override 的加载时机与失败范围**（v2.3）：原文只说「模块初始化加载、fail-closed」，未说明失败会拖垮**整个 CLI**（`auth whoami`/`api list` 一起挂）。补三条后果并给出 **Ruling**（接受：与 `specs.json` 同款、dist 不完整时整份产物不可信、惰性加载会让失败点漂移）；同时明确只读被引用的 id（当前 2 份），启动开销可忽略 | 可实现性 + controller ruling |
| 41 | **§十.0 补 `hasBodySchema` 判据与 `SchemaParam` 类型**（v2.3）：`validateBody` 的注释里显式写「由 `file.params` 现算、与 `bodyKind` 无关」，防实现混同；并把 `SchemaParam` 从 §三 的散落描述收进 §十.0 的类型清单 | 可实现性 |
| 42 | **§三 输出样例改用 `ai.knowledge.search`**（v2.3）：原样例用 `ai.knowledge.addKnowledge`，却写 `"dangerous": false` —— 实测它是 **`dangerous: true`**，即样例里有一个**与事实相反**的字段值（正是契约诚实性审查自己反对的）。`search` 实测 `dangerous: false`，且 body 字段一必填（`robotId`）一可选（`keyWord`），同时展示 `required` 两种取值；title/path/description 均按实测逐字对齐 | 事实对拍（controller 复查） |
| 43 | **§一「非目标」与 §八之二 的 `responseShape` → `response_shape`**（v2.3）：面向 Agent 的正文/文案统一用 CLI **实际输出键名**（下划线），仅在设计稿溯源处保留 TS 字段名 `responseShape` | 上游一致性 |
| 44 | **§八.6 的 `has_body_schema` 判据改回合取式**（v2.3）：原文（本 spec v2.3 自造）写「判据是『body 参数数 > 0』，**与 bodyKind 无关**」，与 §三 的 `body_kind === 'json' && body 参数数 > 0` 及自身的 kefu.add 反例（xml 有 14 个 body 参数却 `false`）**三处互相矛盾**。统一为合取式；并更正「该式在 9 个接口上为假」——实测 `=== (bodyKind==='json')` 在 **5** 个接口上为假、化成 `> 0` 在另 **5** 个非 json 接口上为假，两个方向的等价变异体都要钉住。**Ruling**：§三/§十.0/§八.6 一律用合取式。⚠️ **本条自身残留已作废表述**（v2.3 标注，见 §十一 第 68 条 ㉑）：「与 bodyKind 无关」是被本条**推翻**的旧结论，保留仅作溯源；判据一律以合取式为准 | 契约诚实性 + 安全门禁（两路独立命中）+ controller 实测 |
| 45 | **§四 澄清「先按 bodyKind 分流」与「0 body 表形状不判」的优先级**（v2.3）：原 §四 说「先按 bodyKind 分流」，但未明说 bodyKind≠json 的接口**根本不进**形状表——实施者可能让 `kefu.add` 的非对象 body 被「非对象硬拒」（2），与 D4（非 json 直发）冲突。补：形状表**只对 json 接口生效**；`none` 传对象/标量 → 只出 `non_json_body` | 安全门禁 + 内部自洽 |
| 46 | **【重要】修正「模块初始化抛错 → 入口 `.catch()` 兜住」的错误断言**（v2.3）：实测证伪（最小探针 + 真实 dist 副本改坏 `specs.json`）——ESM 静态 import 的依赖在**模块求值期**抛错时入口模块体尚未执行、`.catch()` 未注册，故 stdout **0 字节**、stderr 原生堆栈、退出码 1。改：命令执行期的 `internal`（`loadParams` 在 `callOne` 内抛）→ stdout JSON + 退出码 1；**模块初始化期**的失败 = 未捕获异常（与 `specs.json` 既有行为逐字一致，B 不改变也不假装修复）；验收 12 相应改为「退出码 1、stderr 堆栈、stdout 空」 | 可实现性 + 契约诚实性 + 安全门禁（三路独立命中）+ controller 实测 |
| 47 | **错误分类补别名冲突**（v2.3）：§四 只点名 `validateBody` 的硬违规，未覆盖 `normalizeAliases` 的别名冲突抛错——实施者可能给它挂 `kind` → 走成退出码 1，与 §六「alias 冲突 → 2」冲突。补：两处抛出点分类一致（普通 `Error`、不挂 `kind`、→ 2） | 安全门禁 |
| 48 | **`api schema` 的 `field_notes` 必含键补全**（v2.3）：原文未含 `callable`/`path`，且 `dangerous` 的措辞未复用 `needs_confirmation` 的「必须由人类确认，不要自动追加 `--yes`」口径（安全审查指出的两跳绕过链路：硬拒 → `api schema` → 学到「加 --yes 就行」）。补 `callable`/`path` 说明，并把 `dangerous` 措辞钉到安全口径 | 契约诚实性 + 安全门禁 |
| 49 | **互斥检查排进 `callOne` 次序图**（v2.3）：§六 有「`--no-validate` 与 `--strict` 同传 → 2」，但 §四 的次序图没画它——实施者不知道它相对 `loadParams`/门禁的位置（危险接口上 `NV+S` 的退出码可能是 2 也可能是 4）。补 `assertNoValidateStrictConflict()` 于 B 块之前、门禁之前 | 安全门禁 |
| 50 | **澄清 `validateBody` 返回 `{hard,soft}` 不抛、由 `callOne` 抛**（v2.3）：§十.0 让 `validateBody` 返回 `ValidateResult{hard,soft}`，§四 却说「硬违规 → 抛」——实施者不清楚谁抛。补：`validateBody` **纯函数、不抛**；`callOne` 检查 `vr.hard.length > 0` 后抛普通 `Error`；`normalizeAliases` 的冲突**必须抛**（无返回值语义） | 可实现性 + 内部自洽 |
| 51 | **§六/§八之二 补「`API_USAGE` 不是唯一失真字符串」**（v2.3）：`api.ts` 还有子命令清单（`<list|call>`、`可用子命令：list、call` 两处）与 `callOne` 的未知参数提示（`可用：--body <JSON>、--yes`）、`cli.ts` 顶层 `USAGE`、README 命令一览——B 之后都必须补 `schema`/`--no-validate`/`--strict`，否则 Agent 读到事实错误的清单。列为验收 32 | 上游一致性 |
| 52 | **§六 补「2 = 改参数重来」的既存例外**（v2.3）：`auth.ts` 已记录一类换任何参数都过不了的 2（不可调用/未实现）——`API_USAGE` 说明不得宣称「所有 2 都能靠改参数解决」。B 的硬拒都属于可修类 | 安全门禁 |
| 53 | **§八之二 第 3 条的「标记路线图 §八 条目 7 已关闭」进验收**（v2.3）：原只写在联动段落、不在验收网内，按「交付清单式执行」会漏。列为验收 33 | 上游一致性 |
| 54 | **硬拒消息合成规则**（v2.3）：`merchant.account.login` 三者全缺时同时触发「userName 缺必填」与「one-of 组全缺」两条硬违规，原文未定义聚合——实施者若「只报第一条」会导致 Agent 补完 userName 后再撞 one-of。补：`vr.hard` 每条各一行、按规则序拼接、不短路；验收 6 相应加强 | 契约诚实性 |
| 55 | **验收 19 别名改写关闭的验证改用危险接口**（v2.3）：原文说「用非危险的等价场景验」，但 override 表里 `aliases` **只有** `editKnowledgeNoSimilars`（危险），不存在非危险替身——该验收落不了地。改为对 `editKnowledgeNoSimilars --yes --no-validate` 断言 mock fetch 收到 `name`、不含 `question` | 可实现性 |
| 56 | **§三 `schema` 7 步次序修正 help 与位置参数的先后**（v2.3 复查）：原文把「位置参数 > 1 → 2」排在 help 之前，导致 `schema --help extra`（1 个位置参数）不触发该步、落入 help 给出**退出码 0**——与「`--help` 不吞额外参数」直接矛盾。改为 help 提前处理、且自身检查位置参数（3a/3b）；四条输入 `--help` / `--help extra` / `a --help` / `a b` 结果同时正确 | 内部自洽（controller 复查） |
| 57 | **`loadParams` 增可注入的 `root` 参数**（v2.3 复查）：验收 13/26 要构造「params 缺失/畸形」而不污染仓库真文件，原签名无注入点、实施者只能改真文件（会被缓存与工作区污染反噬）。补 `loadParams(id, root?)`（默认真实目录、测试指向 `mkdtempSync` 副本），并注明缓存与 `vi.resetModules()` 的关系；§十.0 的加载机制代码同步。⚠️ 后续第 67 条进一步明确「`setParamsRoot` 与读 root 必须同一实例、无需 resetModules」 | 可实现性（controller 复查） |
| 58 | **§四 定 `meta.warnings` 两来源的合成次序**（v2.3 复查）：`alias_normalized`（来自 `normalizeAliases`，比对前发生）必须排在 `vr.soft` 之前——`meta.warnings = [...aliasWarnings, ...vr.soft]`；两段各自再按「params 表顺序 → body 键出现顺序」。不定义则两种实现输出互为逆序。列为验收 34 | 契约诚实性 + 可实现性 |
| 59 | **§八.2 补 `responseShape` 实测分布**（v2.3 复查）：实测 154 份的 `responseShape` 恒为 `{"kind":"object"}`（150）/`{"kind":"none"}`（4），从不是字符串——设计稿的 `string` 是 A 之前的历史形态 | 事实对拍 |
| 60 | **§十.1 补 `tests/readme.test.ts` 落点**（v2.3 复查）：验收 23 的 README 部分原先无测试落点，按「交付清单式执行」会变成纸面条款 | 可实现性 |
| 61 | **§十.1 修正凭证注入口径**（v2.3 复查）：原文说「统一 `beforeEach` 注入」，但现有 `api.test.ts` 是 per-test `vi.stubEnv`（**18 处用例**——v2.3 第三轮实测更正，原文误植为「19 处」，那是 `api.test.ts:23` 注释里「call() 调用点 24−5=19」的**另一口径**；见第 67 条）且有反向用例（显式 stub 空串测 `auth_missing`，`api.test.ts:1041`）。改为：沿用 per-test 注入；新文件若用 `beforeEach` 必须成对清空、不得污染反向用例 | 可实现性 |
| 62 | **修 §九 验收 4 的措辞**（v2.3 复查）：「验收 §四 的短路规则」会把读者指向不存在的「§四 验收」；应为「§四 的短路规则」 | 内部自洽 |
| 63 | **§四 澄清「该接口按文档不接受 body」是 `none` 专属解释**（v2.3 复查）：该句原与通用 message 表并存，实施者若把它当通用文案，对 xml/multipart 接口（**接受** body、只是 CLI 不校验）就说错了事实。标为 `bodyKind:"none"` 专属；通用文案见 message 表 | 契约诚实性 |
| 64 | **验收 24 降级为发布前手动 checklist**（v2.3 复查）：`vitest.config.ts` 钉死 `testTimeout: 5_000`，在测试里跑 `npm run build`（tsc + copy-params）没有超时余量且会动 `dist/`。改为发布前人工步骤，不写进 `npm test` | 可实现性 |
| 65 | **§十.0 补 `validateBody` 的 `spec` 参数用途**（v2.3 复查）：原文只列了签名、没说 `spec` 用来做什么——实施者可能写成 `_spec` 占位（消息里出现 `qiyu api schema undefined`）或越权读 `dangerous`。补：唯一用途是消息回显 `spec.id`；不读 `dangerous`/`callable` | 可实现性 |
| 66 | **【重要】三种 warning 的 message 补「请求已发出」口径 + 验收 12 降级为手动 checklist**（v2.3 第三轮 6 路审查，三路独立命中）：①`unknown_field`/`type_mismatch`/`non_json_body` 的 message 原本**不含**「已发送/不要重试」语义——`alias_normalized` 的「无需重试」是安全关键文本，但同一推理（「见 warning 就改输入重试」的 Agent 会重复写）对三类**同样成立**，spec 只堵了一类。补「请求已发出 + 重发风险」口径；②`alias_normalized` 的「无需重试」此前**无验收钉**（验收 7 只断 kind/field/body 改写）——列为验收 7 的断言；③验收 12 的模块初始化失败（进程级断言）在 vitest 落不了地（tests/ 无 spawn 先例、无 tsx、testTimeout 5_000 无余量、须改坏真实 validate.json）——降级为发布前手动 checklist（与验收 24 同款） | 契约诚实性 + 安全门禁 + 可实现性（三路独立命中） |
| 67 | **第三轮 6 路审查裁决（21 条机械核验后的落盘）**（v2.3）：①§三 `params` 与验收 25 矛盾（「原样保留」vs「relaxRequired 后 required 已降为 false」）——§三 补「`required` 输出的是应用 override 之后的值」；②`one_of` 的 field_notes 无最小内容要求——补「组内任一存在即可」必含口径，验收 25 钉住含「任一」；③`meta.note` 条件输出只在验收 1 括号里提了一句、正文无正向说明、无验收钉——§三 补条件输出条款，验收 1 补「有 note 接口输出 note」；④`loadParams` 的 root 注入在 api.ts 层无接线方案——§十.0/§九 验收 13 补 `setParamsRoot` + `(root,id)` 缓存键（**并经最小 ESM 探针实测校正**：`setParamsRoot` 与「读 root」必须同一实例、set-then-reset 会丢 root，故测试无需 resetModules）；⑤模块初始化崩溃面比 spec 声称的更宽（被 override 引用的 2 个 id 的 params 损坏也裸崩）——§三/§四/§六 三处补「限非被引用 id」+「override 加载失败只有模块初始化一种形态」；⑥README 安全段「缺 --yes 必返 4」在 B 之后不再恒真（硬拒 2 先于门禁）——§八之二 增第 8 条，验收 23 扩围；⑦README:9「只实现了认证+API 通道」横幅、README:187 目录树失真——第 6 条扩围；⑧验收 33 未钉关闭形式（「整条删掉」也能过）——补「保留原文+删除线+✅」；⑨路线图条目 4「B vs A/E 归属仍开放」从未被 B 的 spec 回应——§一 补「B 独立交付」答案，验收 33 一并断言条目 4 标关闭；⑩spec 头部「§5.3 元数据陷阱」节号失准——改为「§5.2 元数据陷阱（§5.2 尾部）」；⑪CHANGELOG 与「已实现清单」联动无验收——第 7 条列为验收 35；⑫第 8 条 callOne 同族三处用法串只点名一处——补 `api.ts:268/:291/:377` 三处；⑬§四 接入点括号把 body JSON.parse 画在 --pretty 之后（与实际代码相反）——修正为「未知/位置 → body JSON.parse → help → --pretty」；⑭`assertNoValidateStrictConflict` 是「参数校验必须全部在 byId 之前」不变量的新例外——补 Ruling（接受，退出码恒 2、无请求）；⑮§三 3a 与 callOne 的 help 行为差异（schema a --help → 2 vs api call <id> --help → 0）未交代——补「刻意差异」声明；⑯§十.0 加载机制代码无 root 的位置——代码片段补 `injectedRoot` 用法；⑰§十一 第 36 条保留已被第 44 条推翻的「判据与 bodyKind 无关」表述——标注作废；⑱§八之二 第 3 条「验收 23 增补」笔误——改为「验收 33」；⑲（已核为**误判**：审查称第 20 条「§八.7」张冠李戴，实测本 spec §八.7 正是「同名字段跨 `in`」护栏，引用正确，不改）；⑳§十一 第 61 条「19 处」误植（call() 推导数字）——实测 18 处用例，更正；㉑验收 34 示例 body 对危险接口须 --yes 且补必填——补标注。⚠️ 另有两条审查发现经核为**误判**、不改：§八.5 引用（审查以为它指 --strict 升级范围，实为「override 腐化」，引用正确）、§五 第 20 条来源列（见 ⑲） | 第三轮 6 路审查（全部经机械核验） |
| 68 | **第四轮 6 路审查裁决（对准前三轮盲区：历史裁决复核 / 验收逐条模拟 / 决策链覆盖 / 实施者冷启动 / 安全全场景 / 联动终审）**（v2.3）：①**三种 warning 的「已发出 + 不要重发」仍无验收钉**——第 66 条只把 `alias_normalized` 列进验收 7，另三类的安全关键子句无验收；且 `unknown_field` 原文的「确认写没写对要看 `data`」把 Agent 引向**可能无法完成的验证任务**（`data` 常是空壳）、「**只凭**这条警告」留了重发缺口；`non_json_body` 保留「**未验证**」正是「值得再试」的措辞。三处 `message` 改无条件口径，验收 5/9/28 加强；②`--strict` **硬形态** message 未定义——复用软模板会在退出码 2 里宣称「请求已发出」（与事实相反），补硬形态口径 + 验收 29 断言不含「已发出」；③`--no-validate` 是否跳过 `loadParams` 未定义——两种读法给出退出码 1 vs 4，补「只关校验逻辑、不关读文件」；④`type_mismatch` 的「日期串/数字字符串不判 mismatch」有歧义——按字面读会让 `{"robotId":"1"}` 不报错、与验收 28 矛盾，改为「只按声明 type→JS 类型映射判，无豁免」；⑤验收 6「三者全缺」的构造未定（`--body '{}'` vs 不传 body 结果不同）、硬拒消息拼接次序未钉——补构造与次序；⑥验收 21「重跑后 154 份字节不变」在 CI **不可达**（`registry-src/` 被 `.gitignore:48` 忽略、测试用 24 fixture）——改为「fixture 样本确定性」；⑦验收 31 kind 名拼错 `no_json_body`（应 `non_json_body`）——修正；⑧验收 34 示例 body 缺 7 个必填（到不了 warnings 合成）——补全 body；⑨`readme.test.ts` 被塞入 CLI 行为断言（验收 1/7/25）——移回 `api.test.ts`（夹具在那边）；⑩root 注入测试**缺复位**（`setParamsRoot(undefined)`）——会级联失败，补 `afterEach` 复位；⑪`assertNoValidateStrictConflict` 无签名/归属——§十.0 补；⑫`effectiveBodyParams` 共享函数缺失——schema 与 validateBody 两处应用 override 会漂移，§十.0 补；⑬D9 无**反向**断言（`meta.validation` 不存在）——验收 1 补；⑭`response_shape` 原样透传无验收——验收 1 补；⑮§八之二 第 4 条/验收 32 把 `schema`（子命令）与 `--no-validate`/`--strict`（flag）**混列**——会产出「把子命令当 flag」的事实错误清单，改为按语义分位；第 4 条同族 flag 串补**第四处**（`api.ts:399-403`）；⑯README:149 替换文案留在「尚未实现」段内——补「从该段移除、列入已实现」；⑰§八.3 的「--strict 严格≠正确严格」要求文档写明、但 §八之二/验收均无落点——补进第 1/2 条文案与验收 23；⑱§八.3/§十二.4 未覆盖「`--strict` 误拒 → Agent 删字段重发危险写」路径——补风险说明；⑲§四 红线后「params 文件**只有**鉴权 query 参数」不准确（`ipcc.calltaskdetail.*` 还有 `content-type:header`）——修正措辞；⑳§十二.5「B 不扩大裸崩面」与 §十.0 自述的**新触发源**（validate.json + 2 份 params 的初始化期读取）矛盾——改为「形态不变、触发面扩大」；㉑历史裁决复核：第 9/23 条结论被第 28 条推翻但未标注作废、第 44 条内残留被推翻的表述——补作废标注；㉒§八之二 第 1 条建议把「请求参数校验」文案就地替换、但该条位于 README「**尚未实现**」段——原地替换会变成「把已实现功能写进未实现清单」，改为**整条移出**（含第 150 行）并给「已实现」段的新增行逐字建议；㉓§八之二 未联动 `README.md:139`「当前状态」句（「第一个子项目」在 B 之后不完整）——补进第 6 条；㉔§八之二 第 6 条/验收 23 的「`responseShape`→`response_shape`」键名修正**经终审核实为误判**——`README.md:150` 描述的是 params 文件的 JSON 字段（确为 `responseShape`，已实测），且该 bullet 随第 1 条整条移出后无残留——撤销该修正并标注（保留作废标注防回潮）；㉕§八之二 第 2 条新文案用「不含参数表」，与既有测试 `api.test.ts:166` 的 `/不提供|没有/` 正则**不兼容**——§十.1 补「同步改断言为 `/不含|不提供|没有/`」，否则 `npm test` 红；㉖终审逐字对拍确认（✓）：§八之二 各条「现值」引文与 `README.md`/`api.ts` **逐字一致**（第 1 条 149 行、第 2 条 `api.ts:255/:258`、第 6 条 9-10/187、第 8 条 129-130 均核对通过）；`docs/qiyu-cli-design.md` 引用（§5.2/§5.4/§9.1）与路线图条目 4/6/7 现状与 spec 描述一致——**无需修订** | 第四轮 6 路审查（全部经机械核验）＋ 联动终审（逐字对拍 + 上游核对） |

**未采纳**：审查提出的「params 用静态 import 编译期映射」建议——与既有 `copy-params.mjs`
把 params 拷进 `dist` 的机制不符；改为 `readFileSync(pathToFileURL(...))` + `readFileSync`
（源码与 dist 同构，见 §十.0 与 `params.test.ts`）。

## 十二、开放问题（留给实施计划/后续）

1. `api schema` 是否要 `--all` 输出全部 154 条参数表（体积/分页问题）——**先不实现**。
2. ~~one-of 的**组本身**是否要进 `api schema` 输出~~ —— **已关闭**（v2.3 第 35 条）：
   不输出就是 schema 撒谎（`relaxRequired` 让组内字段看起来都可省），故 `one_of` **必须**输出，
   见 §三 与验收 25。
3. G1 若决定删 `category` 数据（§七把删除权交给 G1），生成脚本与 154 条要一起再生。
4. **`--strict` 的误伤面**（§八.3）——params 漏记的服务端字段会在 `--strict` 下被硬拒。
   是否要在 `--strict` 的拒绝消息里附「若确认该字段合法，请报告缺失的注册表项」之类的指引，
   留待实施计划决定（当前只要求文档写明「严格 ≠ 正确严格」）。
   ⚠️ **误伤的 Agent 补救路径必须说清**（v2.3 补，见 §十一 第 68 条）：README 教「2 = 改参数重来」，
   但 `--strict` 的误拒**恰恰不能靠改参数解决**（字段本就合法、是注册表漏记）——一个按退出码 2
   行动的 Agent 会**删掉该字段再发**，对危险接口就从 fail-safe 的「未发生的写」变成「缺字段的错误写」。
   文档/拒绝消息必须写明：`--strict` 的 `unknown_field` 硬拒**不是**「参数写错了」，而是
   「本地参数表未收录」——**不要为绕过它而删字段**，应改用默认（非 strict）模式或报告缺失项。
5. **模块初始化失败的 `stdout` JSON 契约**（§十.0 第 1 条）——当前与 `specs.json` 一致地裸崩
   （stdout 空）。全局约束「其余任何情况下 stdout 都必须是合法 JSON」在这条路径上落空，是既有缺口。
   是否要为**整个 CLI** 加一层顶层兜底（如在 `bin` 脚本外包 try/catch）来兑现该约束，属全局治理，
   **不在 B 的范围**。⚠️ **措辞修正**（v2.3 补，见 §十一 第 68 条）：原文说「B 只保证**不扩大**它」，
   但 B **确实扩大了触发面**——B 之前裸崩源只有 `specs.json`，B 新增了 `validate.json` 静态 import
   与「被 override 引用的 2 个 id 的 params 在模块初始化期被读取」两个源（见 §十.0 第 1/3 条）。
   准确表述是：**失败形态不变（仍 stdout 空 + stderr 堆栈 + 退出码 1），但触发面从 1 个源扩到 3 个源**。
   该缺口**无法在 `npm test` 里断言**（进程级、须改坏真实文件），
   故验收 12 的集成部分降级为发布前手动 checklist（见验收 12、§十一 第 66 条）——
   真正兑现这条全局约束要等「顶层兜底」这个独立议题。
6. **子进程级测试基建**（v2.3 补，见 §十一 第 66 条）——验收 12 的集成断言降级为手动 checklist，
   根因是 `tests/` 无 `spawn`/`child_process` 先例、无 tsx、`testTimeout: 5_000` 无余量。
   是否要引入子进程测试能力（可覆盖模块初始化崩溃、真实 CLI 端到端）留待后续——**不在 B 的范围**
   （B 不为此改测试基建）。
