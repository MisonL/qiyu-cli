# qiyu-cli 设计文档

日期：2026-09-30（Version 2）
状态：实施中——A/B/C1/D 已交付（D 同步引擎已交付 2026-10-15，见 `src/sync/`；E 查询与沙箱已交付 2026-10-17，见 `src/query/`）；F Skill 化已交付（2026-10-21，见 `src/skill/` 与 `qiyu skill install/check/where`）
修订说明：Version 1 的核心论据是错的（见 §13）；Version 2 予以更正，并纳入会话明细同步

> **关于本文档中的实测数据**：本文档中出现的所有 ID（robotId、staffId、groupId、categoryId、会话 ID 等）、人名与业务内容，**均为合成的占位值**，不指向任何真实企业。标注为「实测」的结论（字段行为、分页语义、限频、错误码、统计口径、比例、行数）来自对某个真实七鱼企业账号的**只读**探测，并已做匿名化处理；**其结构性结论可直接复用于任何七鱼企业，但具体数量级会随企业规模而变化**。
>
> **关于中文字符串的说明**：文档中少量中文出现在反引号里（例如 `` `单位时间内请求过于频繁` ``、`` `该任务id不存在` ``）。这些是**七鱼 API 在 `message` 字段中逐字返回的真实字节值**，属原样引用，不是未翻译的残留文本。本文档的核心论点之一就是「错误分类必须依据 `message` 的精确文本」，因此翻译它们会摧毁所描述语义本身。

## 1. 目标与背景

将七鱼开放 API 封装为一个 CLI 工具，并在其上叠加一个本地数据仓库，使 AI Agent 能够高效地完成**运营数据分析**（主要用途）与**工单管理**（次要用途）。

### 用户

**AI Agent 是第一用户，人类是第二用户。** 所有设计决策都以这一点为标尺：非交互、默认输出 JSON、自描述、机器可读的错误、可重试的失败。

### 需要解决的问题

七鱼官方 API 对 Agent 极不友好，而这正是 CLI 的真正价值所在：

| 问题 | 现状（实测） |
|---|---|
| 响应信封 | **26** 种顶层 key 组合 / **40** 种 key+type 签名。`message` 的类型横跨 string/object/integer/boolean/array；10 个接口的 schema 为空；对于 `create ticket`，`message` 是新建工单的 ID |
| 分页 | 三种：游标（`mid`+`isEnd`）、页码（`curPage`/`page`/`offset`）、以及无分页。大多数没有 `total` |
| 时间单位 | 鉴权 `time` 是**秒**，报表 `startTime` 是**毫秒**，而 `behavior track` 请求体中的 `time` 是毫秒却又**与一个鉴权参数同名而含义不同**。**同一 API 家族内部也存在不一致**：`knowledge.updateTime` 是毫秒，而 `kpoint.updateTime` 是**秒**（见 §10.5.7） |
| ID 与名称 | Agent 只会说“把这个转给张三”，但 API 只接受 staffId |
| 报表粒度 | 报表返回的是**窗口聚合值**；`date` 字段原文写着：“this date has no specific meaning, it only indicates the start time of the current query” |
| 接口名重复 | **6 组、在 132 个唯一路径上有 24 个重复实例** —— `/` ×9、`ipcc/calltask/add` ×5、`message/send` ×3、`push/msg` ×3、`ipcc/history/seat` ×2、`{modify_cb}` ×2；接口无法通过路径定位 |

### 核心洞察（Version 2 中已更正）

**报表接口只提供窗口聚合值；行级明细只存在于会话导出中。** 实测：在 6 张报表的响应中，`category` 字段出现 **0 次**，因此无法回答“客户在问什么”；而会话导出（`/openapi/export/session`）包含按会话粒度给出的 `category`、`categoryDetail`、`evaluation`、`staffId`、`startTime`、`endTime` 等字段。

因此，持久化到本地数据库的理由是：**要拿到行级数据就必须走会话导出（一个异步 zip），而这条导出链路又慢又受限，不适合 Agent 实时查询** —— 同步一次，查询无限次。

> Version 1 曾主张“报表限频 5 分钟 ⇒ 必须持久化”。**那个论据是错的**：5 分钟间隔只存在于呼叫系统接口；6 个在线报表接口没有任何限频记录。见 §13。

## 2. 范围

### 本阶段范围内

- 鉴权与签名层
- 通用 API 逃生通道（registry + 自描述）
- 本地数据仓库：DuckDB（默认），外部数据库可选
- 同步引擎：增量 + 全量重同步 + 断点续传 + 单写者并发模型
- **同步范围**：
  - 维度表：`staff`、`staff_groups`、`staff_group_members`、`tags`、`ticket_categories`、`ticket_templates`、`ticket_template_fields`
  - 报表：**10 张表**（见 §6.2；其中 2 张不是“一行一个人工客服”：座席考勤在传入 `startTime` 时是**座席 × 小时**，不传时是**座席 × 天**，而实时数据是**无法回补的快照**）
  - **会话明细 `sessions`（不含 `messages`）** —— **同时覆盖人工客服与机器人会话**，其中机器人约占 68%，按 `session_type` 分支处理（§7.5）
  - **机器人知识库**：`knowledge_items`（截至 2026-09-30 为 12778 行 —— 见 §10.5 的漂移说明，覆盖全部 5 个机器人）+ `knowledge_points`（309 行）+ `knowledge_categories`（按 robotId 隔离）。**只读**，见 §10.5
  - 工单 `tickets` + `ticket_logs`
- Agent 查询接口（`--sql` 只读沙箱 + 预置分析）
- 本地数据库自描述（`db tables` / `db describe`）
- 工单领域的语义化命令
- **知识库领域的语义化命令（只读）**：知识检索、按 `group_id` 聚合、标准问题 / 相似问题定义切换
- 定时任务生成（crontab / launchd / systemd / Task Scheduler）
- 配套 skill（Agent 手册）

> **⚠️ 交付状态（2026-10-30 回写）**：本节是**范围声明**，不是交付清单 —— 两者曾被混读。
> 本阶段实际交付了前六个子项目（见 README「当前状态」）：鉴权与签名层、通用 API 逃生通道、
> 本地数据仓库、同步引擎、Agent 查询接口与只读沙箱、配套 skill，外加本地数据库自描述
> （`db tables` / `db describe`）与定时任务生成（`sync install` / `sync uninstall`）。
> **上面两条**语义化命令**未交付、且当前无落点**：
> · **工单领域的语义化命令** —— 从未进入路线图任何子项目（A/B/C1/D/E/F 都不含）；
> · **知识库领域的语义化命令（只读）** —— 同上。
> **缺的是"语义层"，不是"数据"**（这两件事别混）：两条领域的**数据**都能拿到 ——
> 远程走 `api call <接口 id>`（如 `v2/ticket/search`），落库后走 `query --table` /
> `query --sql`（`tickets` / `ticket_logs` / `knowledge_items` / `knowledge_categories`
> 都在 `TABLES` 里、都有对应同步任务）。**没有的是**把这些包成人类语义的
> 那层命令（§9.4 设想的那种 `qiyu ticket … --assignee "张三"` 名称解析、按 `group_id` 聚合、
> 标准问/相似问切换）—— 所以 Agent 得自己看 `api schema` 拼 body、或自己写 SQL。
> `src/cli.ts` 的命令树里没有 `ticket` / `kb` 命令。
> 这是**挂账**而非放弃：重开需要独立 spec→plan，理由与 §9.4 名称解析那条同源
> （语义化命令要复用的写命令族同样不存在）。**读本节时不要把它当作"已经有了"。**

### 本阶段范围外

- **消息明细 `messages`**（一行一句话，体量最大；`sessions` 已覆盖分类/时长/评价维度）
- 呼叫系统与外呼任务的语义化命令（仍可通过逃生通道访问）
- **知识库写操作命令** —— 本阶段是**只读同步**。5 个写接口已在 registry 中登记，可通过逃生通道加 `--yes` 访问，但不构建一等命令。理由与重新评估的条件见 §5.5
- 实时事件接入（webhook server）
- **质检数据**：只存在于推送事件 `receive session QA event notification` 中，没有拉取通道 → 本阶段不可用
- MCP Server（架构上已预留：`core/` 不依赖 CLI 框架）

## 3. 架构

### 3.1 双通道

```
qiyu
├── realtime channel ──→ Qiyu OpenAPI (132 callable interfaces)
│                  write operations, immediate queries, domains not persisted locally
└── local channel ──→ DuckDB (default) / Postgres / MySQL / SQLite
                   analytical queries: fast, no rate control, JOINable
                        ▲
                        └── the sync engine pulls data from Qiyu
```

### 3.2 目录结构

```
src/
  core/                    unrelated to Qiyu business logic, independently testable
    sign.ts                the single checksum implementation
    http.ts                send / timeout / backoff retry
    envelope.ts            41 envelope shapes → unified structure
    errors.ts              error code → {kind, retryable, hint, retry_after}
    ratelimit.ts           token bucket + per-interface rate limit table
    registry/              interface metadata (see §5)
      index.ts             stable ID, direction, callable, dangerous
      specs.json           parameter schema generated from the official docs
  store/                   storage abstraction
    types.ts               Store interface definition
    duckdb.ts              embedded implementation (default)
    kysely.ts              external database implementation
    schema.ts              table definitions and migrations
    sandbox.ts             read-only query sandbox (three layers of protection)
  sync/
    engine.ts              scheduling, watermark, idempotent writes, single-writer lock
    tasks/                 one task per dataset
    export.ts              session export path (create→poll→download→unzip→parse)
  domains/
    stats/                 reports: time slicing, metric catalog
    ticket/                tickets: state machine, field normalization
    knowledge/             knowledge base: full snapshot sync, standard question/similar question normalization, robotId isolation
    resolve/               name → ID cache
  commands/                CLI command layer
  schedule/                scheduled task generation (crontab/launchd/systemd/schtasks)
```

分层原则：`core/` 不 import `commands/`；`store/` 不 import `sync/`。

## 4. 鉴权

### 4.1 签名

130 个接口共用一个方案（另有 3 个机器人接口在文档中声明不需要鉴权）。凭证放在 **query** 中：

```
checksum = SHA1(appSecret + md5(body 原文) + time)     // 小写十六进制
time     = current UTC second-level timestamp                 // 有效期 5 分钟
```

**md5 必须针对实际发送的字节计算。** 任何序列化差异（key 顺序、空白、中文转义）都会导致 14002。**序列化一次，签名，原样发送。**

已对线上 API 验证（原始 TCP 抓包、逐字节比对，覆盖中文/emoji/转义/换行）：undici 将字符串 body 编码为 UTF-8，`Content-Length` 为字节数，所有往返校验均通过。两点补充：
- 你**必须显式设置** `Content-Type: application/json`（undici 默认是 `text/plain`）
- undici 会透明解压 gzip 响应，但保留压缩后的 `Content-Length` 头 → 需要时在请求中加上 `Accept-Encoding: identity`

上传文件时，md5 变为**文件内容**的 md5。

**不传 body 时按 `md5('')` 签名（2026-10-02 用真实凭证实测）。** 对 `ticket.search` 完全不传 body，签名用 `md5('')`，返回 `code:200`。这与"传 `{}`"（用 `md5('{}')`）是两条不同的路径，两者都返回 `code:200` —— 所以空 body 的签名没有特殊约定，`body ?? ''` 即正确。

### 4.2 凭证管理

优先级：**命令行参数 > 环境变量 > 配置文件**。

```bash
export QIYU_APP_KEY=xxx        # Agent / CI 场景
export QIYU_APP_SECRET=yyy
qiyu auth login --profile prod # 人工使用：写入 ~/.config/qiyu/config.json（目录 0700 / 文件 0600）
qiyu auth whoami               # 显示当前 profile 与凭证**来源**（+ source / robots）
```

> **⚠️ 措辞收窄（2026-10-30 回写）**：`auth whoami` 的原文是「**校验**凭证」。**它不校验。**
> `src/commands/auth.ts` 的 `whoami()` 只判断凭证**是否存在**（键在 env 或文件里、且非空），
> **从不向服务端发请求**——所以「凭证过期了」「appKey 被重置了」「IP 不在白名单」这些情形，
> `whoami` 全部报成功。要真的校验，只能跑一条真实调用（如 `qiyu api call <某只读接口>`）看返回。
> 这不是缺陷，是分层约束的结果：`auth` 命令**零加载 `store/` 且不碰网络**（`tests/store/layering.test.ts`
> 钉着），校验就得联网；而无网络的 `whoami` 至少能回答「这台机器上配没配、从哪读到的」——
> 这正是 Agent 最常问的那个问题。原文的「校验」二字会让人以为成功 = 凭证有效，故改掉。

**✅ 已交付（G1 第三批，2026-10-25）**：`auth login` 从**环境变量**读凭证（不接受
`--app-key`/`--app-secret` —— argv 会留在 shell 历史与 `ps` 里），原子写（临时文件 +
`rename` 换入），合并保留该 profile 的其它键，符号链接拒绝，绝不回显凭证。
凭证两个来源都生效，优先级不变。**权限规则分两级**：含凭证的文件 group/other 可读时
**拒绝读取**（`kind: config_insecure`，退出码 1）；不含凭证时维持「警告不阻断」。

> **⚠️ 拒绝必须是「七条命令一种行为」（2026-10-26 修）**：拒绝错误在 core 层**只构造一处**
> （`insecureConfigError`），`loadConfigChecked` 与 `store/config.ts` 两个入口共用，
> 各命令的 catch 一律走 `failFromTagged`（带 `kind` 就如实透出、含 `hint`）。
> 此前 store 那条路径抛的是无 `kind` 的普通 Error，被 `usageFail` 降级成退出码 2 +
> `kind: usage` 且 hint 丢失 —— 同一份配置在 `auth whoami` 与 `db tables` 上给出互相
> 矛盾的指引（"去 chmod" vs "改参数重来"）。`errors.md` 对 `config_insecure` 的描述
> （重试无用、按 hint 执行 chmod）在修复前只对 auth/api 成立。
> **不读配置的命令**（`--version`、`api list`、`skill where`、`sync tasks`）不受影响；
> `auth login` 是唯一例外（重写为 0600 而非拒绝，因为它马上要写入新的 secret）。

凭证从哪里来：七鱼管理后台 → “系统” → “扩展与集成” → 开发者 ID（`appSecret` 首次必须点击“重置”生成）。

**凭证绝不能出现在 stdout / 日志中。** 这是 CLI 层的输出过滤，而不是 skill 里的一句提醒。

### 4.3 错误处理

| Code | 含义 | retryable | 处理 |
|---|---|---|---|
| 14001 | appKey 错误 | 否 | hint 指向配置 |
| 14002 | checksum 错误 | 否 | 内部 bug |
| 14003 | time 错误 | — | **core 层自动重新签名并重试，对 Agent 永不可见** |
| 14004 | 格式校验错误 | 否 | 透出服务端 message |
| 14008 | IP 不在白名单 | 否 | 必须在七鱼控制台配置 |
| 14009 | 请求频率过快 | 见下文 | 携带 `retry_after` + `retry_strategy` |
| 14500 | **语义歧义的 code（已对线上 API 验证出 4 种含义，见下文）** | — | **绝不能只看 code**：内部错误 → core 退避；`Service Offline` → **永久熔断**；`Param format error` → **不可重试**；`单位时间内请求过于频繁` → **是限流，必须延迟重试** |
| 14501 | 数据量超限 | — | **core 层不切片**；按 message 区分两种并各自给下一步（见下）：跨度过大 → `kind: 'window_too_large'`（按上限切片）；endTime 越界 → `kind: 'window_misaligned'`（对齐自然日边界） |
| 14515 | 权限不足 | 否 | 该接口需单独申请 |

**原则：凡是 CLI 自己能吸收的错误，都不以 `retryable: true` 的形式暴露给 Agent。** 14003/14500 在 core 层被吸收（重签重试 / 判死为 `module_offline`）；**14501 只被翻译、不被吸收** —— 见下方收窄说明。`retryable: true` 只保留给 Agent 必须**改变策略**的情况。

> **⚠️ 「core 层自动分片」的收窄（2026-10-30 回写）**：本表原写 `14501 → core 层自动分片`。
> 实现里 **core 不做分片**：`src/core/errors.ts` 把两种 `14501` 报文翻成**两个不同的 kind** ——
> `endTime is invalid`（越界）→ `kind: 'window_misaligned'`，hint 是一个**双条件**动作
> （与 `src/core/errors.ts` 逐字一致）：`endTime 必须对齐到自然日边界（不得晚于今天 00:00）`
> —— **对齐**与**上界**是两件事，两个都要满足：明天 00:00 是"对齐的"但越界，仍会被拒，
> 必须把它**挪回允许区间**（§6.2 实测：同一 `endTime = 今天 0:00` 有时 200 有时被拒，
> 故拉取含今天的窗口要留余量，用「昨天 0:00 → 今天 0:00」）；`…is invalid`（跨度过大）→
> `kind: 'window_too_large'`、`retryable: false`（hint 让调用方「按 `maxWindowDays` 切片后重试」）。
> **两者不能混**：切片救不了越界 —— 一个 1–2 天的窗口，endTime 越界照样报 `endTime is invalid`
> （§6.2 实测）—— 一律当"跨度"让 Agent 反复按切片重试同一个失败请求，会浪费一排网络往返。
> **真正切片的只有同步引擎**（`src/sync/engine.ts` 的 `sliceForTask` / `sliceByMaxWindow`）：
> 它按任务注册的 `maxWindowDays` 把范围切成多窗、逐窗发请求、合并结果。
> `qiyu api call` **不切片** —— 它没有分片所需的参数知识（注册表不登记窗口起止在哪个字段里），
> 所以给 Agent 的是一个可执行的下一步（按 `max_window_days` 自己切），而不是替它切。
> **读法**：本表这一行的「14501 是数据量超限」这个分类学没错，错的是「core 层自动」四个字 ——
> 分片能力存在，但它在 sync，不在 core。

**⚠️ 官方通用错误码表只有 10 行，完全没有描述七鱼真实的错误面。** 已对 `https://qiyukf.apifox.cn/doc-436972.md` 逐字核验（2026-09-30）—— 完整表为 `200`、`14001`、`14002`、`14003`、`14004`、`14008`、`14009`、`14500`、`14501`、`14515`。这就是全部；没有第二张表，也没有逐码展开说明。由此有三个塑造错误层的结论：

| 发现 | 证据 | 设计后果 |
|---|---|---|
| **文档声称每个 code 只有一个含义** | `14500` 的文档说明只有 `服务器内部错误，请反馈给我们具体场景`；`14009` 只有 `请求频率过快，超出接口限制` | `14500` 的文档含义**在现实中是错的** —— 它同时还是限流码、参数类型错误、以及模块未开通的信号（见下文 §4.3）。**不要把公开的 code 列表当作语义来源** |
| **`14xxx` 之外的每个 code 都没有文档** | `8011`、`12001`、`67406`、`8002`、`14200`、`14301`、`14402`、`8012` 在官方列表中**完全不存在** | 下文的“补充错误码体系”表**全部来自实测** —— 没有任何文档依据，必须按租户重新验证 |
| **文档不区分共用一个 code 的多种成因** | 整套文档中没有任何一处文字提到某个 code 承载多种含义 | 这正是 §4.3 存在的意义所在：**公开规范对最要紧的那件事只字未提** |

> ⚠️ **`14004` 被低估的程度和 `14500` 一模一样。** 本表把它记录为单一的“格式校验错误”，但仅在一个探测组内它就承载了 **5 种**不同含义：“缺少 `uid`”（`msgPredict`）、“body 格式错误 / 跨度超范围”（`robot.statistic.summary`）、“必填字段缺失”（`queryQueueStatus` → `key uid absent`；`robot.evaluation.setting` → `Bad json payload`）、通用的 `Bad json payload`，以及文档中记载的 `group not exist or deleted`。**`14004` 需要和 `14500` 一样的 message 文本分发表**，理由也完全相同。

> ⚠️ **错误信息的语言按接口固定，无法请求切换。** 发送 `Accept-Language: en-US`、`zh-CN` 或什么都不发，得到的 message **逐字节相同**。`robot.statistic.summary` 与 `transferHuman` 用中文回答；`smstask` 与 `robot/transfer/config` 用英文回答。→ 一个以 message 文本为键的错误层（§4.3 的规则）必须按接口携带**逐字**字符串，并带上它的语言；英文转述永远匹配不上。

> **这是对本项目论点（§1）最有力的单点佐证。** 官方文档声称每个 code 一个含义；实际探测仅 `14500` 一个码就发现四种含义。信任文档的 Agent 会把 `14500 单位时间内请求过于频繁` 当作“服务器内部错误”而退避 —— 更糟的是，把 `14500 Service Offline` 当作可重试而无限循环。**CLI 的价值恰恰集中在这里。**

**补充错误码体系** —— **在官方 10 行列表中完全不存在**的码，无论其数字区间如何（此前表头写的是“不是 14xxx”，但其中大多数**确实**是 `14xxx`；真正的区分特征是官方列表遗漏了它们）：

| Code | 含义 | 场景 |
|---|---|---|
| `12001` | 查询间隔小于一分钟 | 咨询分类接口（限频 60s） |
| **`14007`** | **`user not in queue`** | **对未排队的 uid，`event/queryQueueStatus` 每次调用都返回它** —— 官方 10 行列表与本表的早期版本中都没有。⚠️ 厂商自己对该接口 `code` 的描述是 “user does not exist or has not applied to connect to an agent”，这与**实际返回的 message 并不一致** |
| `8011` | `create too fast` / `Too many running task` | 会话导出创建 |
| `67406` | `PARAM_LOSS` | 短信接口 —— **传入*空数组*（`{"taskIdList":[]}`）也会触发**，不只是缺 key |
| `8002` | `appKey dose not belong to a platform` | 平台电商需要平台版 appKey |
| `14200` | `Not supported category type` | 分类接口的 type 值错误 |
| `14301` | `session can not be found` / `not supported template type` | 会话不存在 / 模板类型非法 |
| `14402` | `Forbidden For Time rate` | **通话记录限频（20s）** |
| `8012` | `该任务id不存在` | 呼叫任务不存在 |
| **`67506`** | **`TASK_ID_SIZE_OVERFLOW`** | `smstask/status` 传入超过 100 个 id；厂商文档的措辞是 `参数个数限制` |

**两种 404 形态**：`/platform/api/*` 返回 **nginx HTML**，`/openapi/*` 返回 **Spring JSON** —— 错误识别层必须同时覆盖这两者，不能只解析 JSON。

**SSL 抖动必须与限流区分开**：线上测试中偶发 `SSL: UNEXPECTED_EOF_WHILE_READING`，重试即可成功。HTTP 层必须把它归类为“可重试的网络错误”（退出码 3），而不是限流。

**⚠️ 14500 必须熔断（否则无限循环）**：已对线上 API 验证，`/openapi/icoutcall/*` 下全部 8 条路径都返回 `14500 Service Offline`。这是**永久性**的（模块未开通）；在 0s/10s/30s/60s 重试得到的响应逐字节相同。
若实现为“14500 → core 层退避重试”，这些接口将**永远重试下去**。熔断是必须的：同一路径连续 N 次返回 `14500 Service Offline`（推荐 3 次）→ 判定模块未开通，立即失败并给出明确信息，同时写入本地熔断状态，避免之后反复尝试。

> **⚠️ 承诺收窄（2026-10-30 回写）**：落地的是**等效防死循环**，不是这里描述的那个熔断器。
> 实测（`src/core/errors.ts`）：`14500` + `message` 含 `Service Offline` → 直接判
> `kind: 'module_offline'`、`retryable: false`。**一次就判死，不重试** —— 因为 `Service Offline`
> 在 0s/10s/30s/60s 的响应逐字节相同（本段自己的实测），"连续 N 次"与"一次"结论必然一致，
> 计数只是把同一个答案多算几遍。**未实现的两样**：① 跨次调用的**计数器**（没有"上次也是它"的记忆）；
> ② **持久化的熔断状态**（没有写进本地库的"这个模块别试了"标记）—— 因此下一个 `qiyu api call`
> 进程仍会再打一次网络、再拿一次 `Service Offline`。**代价如实说明**：Agent 反复调用同一未开通
> 接口，每次都会付一次网络往返；换来的是**永不无限循环**（这是熔断在这里的唯一目的）与
> `kind: module_offline` 这个可分派的答案。真正需要"一次失败后再也不碰"的场景（如同一进程内
> 批量调用），由调用方自己按 `kind` 短路 —— 判据是 `kind`，不是计数器。

**14500 的第三种含义：缺参数导致的 NPE**。已对线上 API 验证，`kefu/v2/query` 不传 `id`、`robot/session/assist` 不传 `content`，两者都返回 `14500`，并**泄漏 Java 内部类名与包路径**（形如 `Cannot invoke "<厂商内部包>.<类名>.getId()" because "staff" is null`）。

→ 因此 14500 的 `retryable` **不能只由错误码决定**；必须结合 `message`：包含 `Service Offline` → 永久熔断；包含 Java 类名/NPE → 参数错误（不可重试）；否则 → 服务端内部错误（可重试）。CLI 还应在透出 `message` 之前**过滤掉 Java 类名等内部信息**。

**14500 的第四种含义：它本身就是限流码（已对线上 API 验证，此处必须更正）**。此前只知道 `14009` 是限流，但 `/openapi/ai/knowledge/*` 系列**在限流时返回的是 `14500 单位时间内请求过于频繁`**，而不是 `14009`。

| 已验证场景 | 响应 |
|---|---|
| `ai/knowledge/getCategoryTree` 用正确 body 连续请求 6 次 | `200 / 14500 单位时间内请求过于频繁 ×3 / 200 / 14500 …` |
| `ai/knowledge/getCategoryTree` 对仅支持 POST 的路径发 **GET** | `14500 Unexpected internal error, hint: <32 位 hex>` |
| `robot/data/getQuestionsByCategoryName` 参数以 `string` 传入（应为 `array`） | `14500 Param format error,please check` |
| 同一接口参数以 `array` 传入（正确） | `200 success` |

→ **`14500` 四种含义的分发表**（必须以 `message` 文本为准进行分发，而不是只看 code）：

| `message` 包含 | 含义 | 动作 |
|---|---|---|
| `单位时间内请求过于频繁` | **限流** | **延迟并重试**（走令牌桶），不算错误 |
| `Unexpected internal error, hint:` | 服务端内部错误 / 方法不匹配 | 退避重试（最多 3 次） |
| `Param format error` | **参数类型错误** | **立即失败**；重试无用，还会烧掉限流配额 |
| `Service Offline` | 模块未开通 | **熔断**，永久失败 |
| Java 类名 / `NullPointerException` | 缺参数导致的 NPE | 立即失败，并过滤内部信息 |
| `can not cast to JSONObject.` | body 不是可解析的 JSON | **不可重试** —— 请求构造 bug |
| `Internal Error, retry later` | 服务端内部错误（措辞与 `Unexpected internal error, hint:` *不同*） | 退避重试 ⚠️ **见下方争议** |
| 以上都不匹配 | 未知内部错误 | 退避重试 |

> **⚠️ 本表与 §9.0 冲突，未解决（2026-10-02 记录）。** 上表把 `Internal Error, retry later` 列为"服务端内部错误 → 退避重试"，但 §9.0 信封特例表的 `evaluation.setting.get` 条目记录**缺 `fromType` 时返回的正是这条文本** —— 缺参数重试无用，应"立即失败"。两处不能同时成立。**当前实现按上表（可重试）**，理由：本表是专门的 `14500` 分派表、更权威；"缺 fromType"仅单接口观察到。待用真实凭证在 `evaluation.setting.get` 上复测确认后收敛。**注意**：`has()` 大小写敏感，`Internal Error, retry later` 与 `Internal error` 只差几个字符却动作相反，实现必须显式列出可重试白名单（`Unexpected internal error` / `retry later`）+ 大小写不敏感兜底，**不得**依赖大小写巧合。（⚠️ 本脚注此前把该条目标为 §10.1，是错的：§10.1 是「增量同步」，全文不含 `evaluation.setting.get`；该条目在 §9.0。）

**⚠️ Java NPE 泄漏不止一种措辞 —— 过滤器不能只匹配单个字符串。** 仅对 `kefu.v2.query` 的实测：空 body `{}` 泄漏的是*一种*（形如 `Cannot invoke "<厂商内部包>.<类名>.getId()" because "staff" is null`），而**完全不传 body** 泄漏的是*另一种*（形如 `Cannot invoke "<JSON 库包>.<JSONObject>.containsKey(Object)" because "msg" is null`）。两者都是 `14500`。→ 内部信息过滤器必须以 **`Cannot invoke "` 前缀**为键，而不是任何单个类名或包名 —— 类名与包名都是厂商内部实现细节，不应出现在本仓库或任何输出中。

**教训**：`14500` 是七鱼的“万能错误码”，它的含义完全由 `message` 承载。**错误识别层必须以 `message` 文本为主键、以错误码为二级索引** —— 这一点同样适用于 `14501`（§6.2 中的两种措辞）。

## 5. 接口注册表

### 5.1 为什么需要它

对照线上 API 核实：**6 组、24 个接口路径重复**，标题也冲突（"获取 SDK 接入地址"出现两次）。路径和标题都无法唯一确定一个接口。此外，**18 个接口无法主动调用**。

### 5.2 元数据结构

```ts
interface Endpoint {
  id: string          // 稳定的点分标识符，如 ticket.search
  title: string       // 中文标题
  method: 'POST' | 'GET'
  path: string
  category: string
  direction: 'outbound' | 'inbound'   // inbound = 七鱼回调我们
  callable: boolean                    // 为 false 时 api call 直接拒绝
  dangerous: boolean                   // 写/破坏性操作 → 需要 --yes
  auth: 'checksum' | 'eventType' | 'none'
  rateLimit?: { limit: number; windowSeconds: number; scope: 'endpoint' | 'global'; source: 'doc' | 'observed' }
  verified: boolean                    // false = 文档有缺陷，需实测复核
  params: ParamSpec[]
  responseShape: string
}
```

**ID 命名规则**：`<domain>.<action>`，冲突时追加限定词。例如 `ticket.search`、`ticket.template.list`、`staff.group.members`。

**⚠️ 探测过程中发现两个元数据陷阱，两者都会让注册表说谎：**

1. **不要从 `direction: 'outbound'` 推断出 `dangerous: false`。** `settings.wxTemplates` 是一个**写操作** —— 它配置租户的微信模板绑定 —— 但第一轮分类却把它归为安全的读操作。`dangerous` 标志必须按接口逐个参照厂商自己的文字描述来赋值，而不能从调用形态推导。（其成功路径**在本租户上无法验证**：每个请求都返回 `14004 appId not bind`，因为没有绑定任何公众号。）
2. **不要从兄弟接口的行为推断"这个接口会校验其 body"。** `/openapi/tag/all` 对**任何** body 都返回 `200`/`success`，包括格式错误的 `{` —— 厂商文档声称 body 必须是字面量 `all`，这一说法根本不成立。而 `kefu.v2.query` 对同类输入返回 `14004 Bad json payload`。→ body 到底是否被解析，是一个**逐接口实测的事实**，而非某一族的属性；无法从路径前缀推断。

### 5.3 实测分布

| 类别 | 数量 | 备注 |
|---|---|---|
| 可主动调用 | **132** | 其中 **130 个使用 `appKey`+`time`+`checksum`**，另有 **2 个机器人接口在其文档中声明无任何鉴权**（`robot/transfer/config`、`robot/session/transfer`）。第 3 个无鉴权机器人接口（企业微信开关）路径已损坏、无法调用 —— 见"路径损坏"行。⚠️ **这两个接口中至少有一个的声明是错的** —— 见下方鉴权说明 |
| 被动推送事件 | **9** | `path = /`，七鱼调用我方，`callable: false` |
| CRM 回调 | **7** | `/get_token`、`/get_user_info`、`/get_order` 等（含 2 个 `/{modify_cb}`），**即我们必须实现的服务端** |
| 客户标签变更事件 | 1 | `/{path}`，被动 |
| 路径损坏 | 1 | 企业微信机器人开关，path 字段是一段中文描述 → `callable: false` |

**150 个文档页面如何分解**（2026-09-30 依据全部 150 个页面的解析后 OpenAPI 重新推导；这是上表的审计轨迹）：

| 桶 | 数量 | 规则 |
|---|---|---|
| 主动调用、路径可用 | **130** | 路径以 `/openapi` 或 `/platform` 开头 —— **加上下面 2 个可恢复的无路径行 = 132** |
| ↳ 其中 `/platform/*` | 6 | 平台电商版；**鉴权方案未经审计**（超出范围，见 §2） |
| ↳ 其中 `/openapi/*` | 124 | 其中 2 个路径以双斜杠开头（`//openapi/v2/ticket/template/{list,fields}`） |
| 被动推送事件 | 9 | 路径恰好为 `/` |
| CRM 回调 | 5 | 路径以 `/get_` 开头（`get_token`、`get_user_info`、`get_call_user_info`、`get_order`、`get_call_order`） |
| CRM 回调、路径含模板 | 2 | 路径为 `/{modify_cb}`（更新用户信息、更新订单信息） |
| 客户标签变更事件 | 1 | 路径为 `/{path}` |
| **无可用路径的页面** | **3** | 见下；其中 2 个可恢复并回到主动调用行，从而得到上表中的 **132** |
| **合计** | **150** | |

**⚠️ 这 3 个无路径页面 —— 注册表无法只靠解析 `paths:` 建立起来。** 有三个页面在其 OpenAPI 文档中不含机器可读的路径，因此朴素解析会得到 `path: null`，该接口便悄悄消失：

| 接口 | 页面实际包含的内容 | 恢复方式 |
|---|---|---|
| 企业微信机器人开关 | `paths:` 的**键是一段散文**（先是中文描述，接着是限流说明 `1次/秒`），而不是路径 | **无法恢复** → `callable: false`（即上文的"路径损坏"行） |
| 平台电商第三方登录 | `paths:` 键为 `POST https://qiyukf.com/platform/api/openapi/merchant/account/login` —— **HTTP 方法被前置到了路径上** | 去掉方法 → `/platform/api/openapi/merchant/account/login` |
| 平台电商创建商户 | 同样的畸形 → `.../merchant/create` | 去掉方法 |

→ **注册表构建器必须从 `paths:` 键中去掉前置的 `<METHOD> <origin>`，并对仍然不是路径的键做出标记，而不是把该页面丢掉。**

`api list` **默认只列出 `direction: outbound && callable: true`**。

**误调用的后果，已对照线上 API 核实**（这是 `callable: false` 不可或缺的证明）：

| 接口 | 误调用后的实际响应 |
|---|---|
| `/get_token`、`/get_user_info`、`/get_order` | **POST 405 + `Allow: GET, HEAD`**（在 HTTP 层被拒绝） |
| `/`（推送事件） | **POST 302** 重定向到网易云商产品页；GET 返回该网站的 HTML |

Agent 拿到的是 405/404 或 302+HTML，这正是触发"漫长的自我调试"的根源。

**⚠️ `robot/transfer/config` 声明无鉴权，但它确实会校验鉴权（实测）。** 不带 `checksum`/`time` 时它返回 `14500 Unexpected internal error, hint: <32位十六进制>`，而 checksum **错误**时它也返回 `14500` —— **并非** `robot.session.msgAssociate` 和 `robot.data.kpoint` 在同类故障下返回的 `14002 Bad checksum`。因此该接口是受鉴权保护的，但它的鉴权失败与**服务端故障或模块未开通**无法区分（§4.3）。注册表不得仅凭厂商页面就将其归类为 `auth: 'none'`；`robot.session/transfer` **未**经过测试（它是写操作 —— 微信机器人切换），其声明仍然未经核实。

**双斜杠不是缺陷（已对照线上 API 核实，推翻了先前的假设）**：`//openapi/...`、`///openapi/...`、`/openapi//v2/...` **全部返回 200，且响应逐字节相同**（原始 socket 验证确认 nginx 确实收到了字面量 `//` 并仍成功路由）→ **这是 nginx 层的全局归一化，而非客户端行为**。注册表**统一存储单斜杠**（双斜杠能用，但不标准，且依赖 nginx 配置）。
**唯一真正的路径错误是 `transferHuman` 中重复的 `openapi`**：已核实为 **404** + Spring Boot 风格 JSON（`{"status":404,"error":"Not Found",...}`）；改用正确路径 `/openapi/ai/statistic/transferHuman` 并补上 `startTime`/`endTime` 后返回 `code=200`。**两个彼此独立的 Agent 各自复现了这个 404**，因此证据是充分的。

> **⚠️ 把斜杠规则表述准确，否则这两条发现读起来会自相矛盾。** nginx 归一化折叠的是**斜杠**，而不是**路径段**：
>
> | 请求 | 结果 |
> |---|---|
> | `//openapi/ai/statistic/transferHuman`、`///openapi/...`、`/openapi//ai/...`、带尾斜杠 | **200 成功**（已归一化） |
> | `/openapi/openapi/ai/statistic/transferHuman`（+ 尾斜杠、+ `//` 前缀） | **404** —— 重复的*路径段*是路由失败，而非格式问题 |
>
> → "双斜杠无害"和"重复的 `openapi` 是真实错误"两者都成立；区别在于斜杠 vs 路径段。

> **⚠️ 那个 404 body 是通用的未知路由响应，而不是该接口的特征。** `/openapi/zzz/not/a/path` 和 `/openapi/robot/nope` 返回**完全相同**的 5 键 Spring body（`timestamp,status,error,message,path`），其中 `path` 回显请求路径。→ 错误层应把"5 键 Spring 404"普遍视为**路由未找到**，不得为 `transferHuman` 做特判。
>
> **⚠️ 但这个 5 键 body 形状是 Spring Boot `BasicErrorController` 的通用错误响应，不专属于 404。**（2026-10-02 记录）同一形状也会出现在 500/503/401/403 等**所有**错误状态码上，只有 `status` 字段的值不同。因此错误层**不能只按 body 形状判定** —— 必须读 `status` 的值：`404` → 路由未找到；`5xx`/`429` → 瞬时故障（可退避重试）；`401`/`403` → 鉴权/权限问题。若只按形状把一切 5 键 body 都当 404（或都当"未知"），一个本该重试的 5xx 会被判成永久失败。

**`/openapi` 根路径**：`/openapi` 和 `/openapi/` 均返回 **404**，**不存在 API 目录／自描述入口**。

**`kefu.add` 的 Content-Type 是文档笔误（依据实测判定）**：`kefu/add` 实际无法调用（红线），因此用同域的只读接口 `/openapi/kefu/list` 做对照实验 ——

| 发送的 body | 声明的 Content-Type | 结果 |
|---|---|---|
| `{}`（JSON） | `application/xml` | **200 正常响应** |
| `{}`（JSON） | `text/plain` | **200 正常响应** |
| `<root>...</root>`（XML） | `application/xml` | `14004 Bad json payload` |
| `<root>...</root>`（XML） | `application/json` | `14004 Bad json payload` |

→ **网关完全忽略请求头的 Content-Type，只把 body 当作 JSON 解析**。在注册表中该接口应标记为 `application/json`。

### 5.4 危险接口（需要 `--yes`）

已核实：**12** 个高风险接口，**其中两个的后果比删除更严重**：

| 接口 | 后果 |
|---|---|
| `message.send`（文本/图片/语音） | **向真实客户发送消息** |
| `sms.task.create` | **发送真实短信，产生费用** |
| `kefu.delete` / `kefuGroup.delete` | 删除客服／客服组 |
| `robot.knowledge.delete` | 删除知识库条目 |
| `icoutcall.job.terminate` / `pause` | 终止／暂停外呼任务 |
| `merchant.changePassword` | 修改商户密码 |
| `tag.batchUpdate` / `crm.syncCrmInfo` | 批量修改客户数据 |

**门禁必须按接口注册（`dangerous: true`）并在统一分发路径上拦截** —— 而不是按命令名，否则 `qiyu api call` 这个逃生舱会绕过所有门禁。

#### 5.4.1 知识库写接口（5 个接口，来自官方文档）

知识库**不是只读的**。官方文档列出了 **5 个写接口**（来源：Apifox 文档页 `api-10845534` 至 `api-10845538`）。其路径取自文档，**并非来自实际调用** —— 见下方警告。**这些路径本身随后（2026-09-30）已在未执行任何写操作的前提下被验证确实存在**，见表格之后的说明。

| 接口 | 路径 | 限流 | 作用 |
|---|---|---|---|
| 新增问题 | `POST /openapi/ai/knowledge/addKnowledge` | **1/s** | 创建一条标准问（+ 相似问）。返回新 id |
| **更新问题** | `POST /openapi/ai/knowledge/editKnowledge` | **1/s** | 替换 name/answer/similars/category。**破坏性：省略 `similars` 会保持其不变，但传 `[]` 会清空它们** |
| **删除问题** | `POST /openapi/ai/knowledge/deleteKnowledges` | **1/s** | **批量删除。** body 接收 `knowledgeIds: []`。返回**删除失败**的 id |
| 更新规则答案 | `POST /openapi/ai/knowledge/editChannelAnswer` | 10/s | 按标签定向的答案（`ruleType: 1`）。**空数组会清空全部规则答案；非空数组则整体替换。** ⚠️ **文档给出的上限：`不能超过20个` —— 每次调用最多 20 条规则答案** |
| 更新忽略相似问 | `POST /openapi/ai/knowledge/editKnowledgeNoSimilars` | 10/s | 类似 `editKnowledge`，但可在一次调用中同时携带规则答案，并且**完全不含 `similars`**。⚠️ **问题字段改了名：该接口取 `question`，而非 `name`**（已对照官方字段表核实）。复用 `editKnowledge` body 形态的调用方会传 `name`，而这里并没有这个字段 —— **改名必须在请求构建器里处理，不能留给调用方** |

> **✅ 这 5 条路径已确认存在，且确认过程中未执行任何写操作。** 一个**完全不带 body** 的 `GET` 无法满足写处理器，因此构造上就是安全的：它返回方法不匹配的特征信号，不会改动任何东西。实测：
>
> | 请求 | 响应 |
> |---|---|
> | 对 5 条写路径发 `GET`，不带 body | **`14500 Unexpected internal error, hint: <32位十六进制>`** —— 5 条全部如此，形态逐字节相同 |
> | 对一个**已知可用的仅 POST** 对照路径发 `GET`（`ai.knowledge.search`） | **相同的** `14500` + 32 位十六进制 hint |
> | 对一个**故意不存在**的路径发 `GET`（`ai.knowledge.thisPathDoesNotExist`） | **HTTP 404** |
>
> → 三方对比把"路由存在但方法不对"与"路由不存在"区分开来。5 条文档写路径**都是真实路由**，因此上表中的路径可信，不再只依赖文档。该 `hint` 是**每次请求都不同的随机 32 位十六进制值**（一个请求 id，而非稳定标识）—— 不得缓存、不得用于匹配、也不得暴露给 Agent。

**共享契约**（5 个接口均适用）：鉴权 checksum 放在查询串中；body 为 JSON；`robotId` **每一个都必填** —— 这与读接口不同，读接口中 `robot.data.knowledge` 会静默忽略它（§10.5.2）。限制（逐字摘自官方字段表）：`answer` 字段上限为 **3500 字符**（`机器人答案，最大长度限制为3500字`）；一条标准问最多支持 **200 个相似问**，每个 ≤ **50 字符**（`单个标准问你最多设置200个相似问；单个相似问最大长度限制为50字符`）。

**⚠️ 这五个响应信封全都不同 —— 不存在共享的响应类型。**

| 接口 | 有 `requestId`？ | 成功时 `data` 类型 |
|---|---|---|
| `addKnowledge` | 有 | **integer** —— 新建问题的 id |
| `editKnowledge` | 有 | **boolean**（`true`） |
| `editKnowledgeNoSimilars` | 有 | **boolean**（`true`） |
| `editChannelAnswer` | **无** | **boolean**（`true`） |
| `deleteKnowledges` | **无** | **array\<integer\>** —— **失败**的 id |

→ 三种不同的 `data` 形态（id／boolean／array），加上可选的 `requestId`。单一的 `WriteResult` 类型必然要对其中至少一种说谎，因此 CLI 需要**每个接口一个结果类型**，并且 `deleteKnowledges` 的数组是**失败**列表，不是成功列表。另请注意，不带 `requestId` 的两个接口恰好就是 `data` 不是 boolean 的那两个 —— 所以 `requestId` 也不能用作"是否成功"的信号。

**另请注意：文档中的 schema 本身就不完整。** `search` 的响应 schema 省略了 `id`，却在示例 body 中使用了它；`getDetail` 的 schema 省略了 `answer`，却在示例中使用了它。**这两个接口已发布的 schema 都不是定义响应类型的安全依据** —— 注册表必须把 schema 与示例合并，并标注这一差异。

**这些接口特有的三个坑**：

| 坑 | 细节 |
|---|---|
| **`deleteKnowledges` 是批量删除** | 一次调用可移除多条问题，且这些 id 是标准问 id。返回的 `data` 是**失败**列表，因此空数组意味着全部成功 —— **与通常约定相反**，很容易被误读为"什么都没发生" |
| **空数组 ≠ 无操作** | 在 `editChannelAnswer` 和 `editKnowledgeNoSimilars` 中，`channelAnswers: []` 会**清空**规则答案，非空数组则会**替换**它们（"历史内容被清除"）。不存在部分更新 |
| **`editKnowledge` 需要完整对象，但仍有三个字段是三态的** | `id`/`robotId`/`name`/`answer`/`validitySwitch`/`categoryId` 都在文档的 `required` 列表中，因此它是**读-改-写**，而不是 patch。**但 `similars`、`effectiveTime` 和 `failureTime` 并非必填，且确确实实是三态的**：关于 `similars` 的原文是 `传[]清空相似问，不传该字段不更新` —— **省略 = 不变，`[]` = 清空，有值 = 替换**。"总是全量发送"和"省略即清空"都不对，而且这两种失败模式恰好相反：body 不完整会丢掉六个必填字段，而激进的 `[]` 则会无声地抹掉一条问题的相似问列表 |

> **⚠️ 这 5 个接口在实测中被刻意**未**调用。** 本文档中其他每个接口都有实测探针支撑；这些**仅有文档依据**，在注册表中必须标记为 `verified: false`。读侧（`robot.data.knowledge`、`ai.knowledge.getDetail`）已完全核实，因此存在一种安全的实现模式：**先读取当前对象，然后仅改动目标字段再写回**，并且每次写操作都要求 `--yes`。

### 5.5 知识库写能力（CLI 应暴露什么）

接口是存在的，所以 CLI *可以*支持知识库维护。是否*应该*支持是一个设计决策，而且其风险画像与读侧差异很大：

| | 读侧（本阶段） | 写侧 |
|---|---|---|
| 影响范围 | 无 —— 本地库可以通过重新同步重建 | **生产机器人的行为立即改变**；客户得到不同的答案 |
| 可逆性 | 轻而易举 | **`deleteKnowledges` 无法通过 API 恢复。** 没有撤销删除，除非事先导出，否则删除项也没有全量内容备份 |
| 验证程度 | 每个接口都经过实测探针 | **5 个写接口一个都没调用过**，因此信封形态、错误模式、幂等性全部未经核实 |
| 失败模式 | 同步错误可见且可重试 | 畸形的 `editKnowledge` 会静默覆盖 `answer`；`[]` 会静默清空 200 条相似问 |

**本阶段建议**：把写操作**保持在范围之外**（如 §2 目前所述），但**把这 5 个接口注册进注册表**，使逃生舱可以触达它们，并由 `--yes` 把关。若日后需要知识库维护，应作为独立阶段来构建，并包含：

1. **强制性的先读后写步骤** —— CLI 先获取当前对象，展示究竟会改什么、以 diff 形式呈现，并要求确认。绝不接受来自 Agent 的裸 body。
2. **每次破坏性调用前做快照** —— 既然 API 没有撤销，CLI 就应先把受影响的问句转存到本地库，这样至少删除后还能重建。
3. **`deleteKnowledges` 外加一道门禁** —— 它是整个 API 面中唯一的批量破坏性接口；要求显式的数量确认（`--confirm-delete N`），而不仅仅是 `--yes`。
4. **限流感知** —— **三个** 1/s 的接口会让批量编辑被限流；CLI 应通过令牌桶把它们串行化，而不是让 Agent 以踩坑的方式撞见 `14500`。（⚠️ 本行此前写"两个"，与 §5.4.1 的表格冲突 —— 那张表逐行列的是 **3 个** 1/s：`addKnowledge` / `editKnowledge` / `deleteKnowledges`；10/s 的两个是 `editChannelAnswer` / `editKnowledgeNoSimilars`。以表格为准，2026-10-04 修正。）

## 6. 存储层

### 6.1 后端

| 模式 | 实现 | 备注 |
|---|---|---|
| **嵌入式（默认）** | `@duckdb/node-api` 原生绑定 | 列式存储，适合行级会话数据分析 |
| 外部 | Kysely + driver | Postgres / MySQL / SQLite |

> 一旦纳入会话明细，数据量就变成**行级**（数百万行），这正是 DuckDB 的 OLAP 优势所在。

Kysely **没有官方的 DuckDB dialect**（内置只有 5 种：PG/MySQL/MSSQL/SQLite/PGlite），因此 DuckDB 走原生 API。

### 6.2 表设计

**维度表**（字段名与主键**全部对照线上 API 实测**；与文档不一致之处已标注）：

| 表 | 来源接口 | 主键 | 实测关键字段 |
|---|---|---|---|
| `staff` | `staff.list` | **`id`** | **17 个字段，330/330 行全部存在。** `id`（int，**真实字段名是 `id`，不是 `staffId`**）、`realname`、`nickname`、`username`、`role`（int，实测 ∈{0,1,2,-2} —— `-1` 从未观测到，但作为筛选项被接受并返回 0 行）、`roleId`（int，**30 个不同取值 —— 唯一稳定的角色划分键**）、`status`（int，∈{1,2,3}）、`createtime`（int，13 位，毫秒，**小写 t**）、`updateTime`（int，毫秒，**大写 T** —— ⚠️ **在 120/330 行（36%）与 `createtime` 逐字节相同**，因此几乎不携带信息）、`email`（**92/330 为空**）、`phone`（**55/330 为空**）、`workNumber`（**89/330 为空**）、`telephone`（**⚠️ 330/330 为空 —— 零区分度；从表中删掉它**）、`maxServiceCount`（int ∈{0..8,10,25}）、`skillScoreChat`（int ∈{1..6,10}）、`skillScoreIpcc`（int ∈{1,2,4,5,10}）、**`groupInfo`（列表 `[{groupId,groupName}]`，文档中没有；**160/330 为空**，共 350 条记录）** |
| | | | ⚠️ **`status` 和 `role` 在实践中都是可选的。** 厂商文档把 `role` 标为必填，但两者都省略时会返回全部 330 行。`status:0` 也返回全部 330 行（0 不是筛选取值）；`status:4` / `role:-1` 返回 0 行。 |
| `staff_groups` | `staff.group.list` | `id` | **恰好 3 个键、33 行，没有其他键：`id`（int —— ⚠️ **字段是 `id`；该响应中任何地方都没有 `groupId` 键**，这与 `staff.list[].groupInfo` 不同，后者用的是 `groupId`）、`name`（str；**21/33 含 `/`** 以表达层级，因此裸叶子名可能在不同父节点下重名 —— 见 §9.4）、`staffIdList`（**`[int]`**，纯 int，仅在传入 `staff:true` 时才有值，否则每行都是 `[]`；带 `staff:true` 时共 359 名成员） |
| `staff_group_members` | 上述 `staff:true` 的 **`staffIdList`** | `(groupId,staffId)` | **不要使用 `staff.group.members` 接口** —— 实测：33 个组中有 **9 个缺人**（一个组的 `staffIdList`=1，而 members 返回 0 行）。来自 `group.members` 的集合始终等于从 `staff.list[].groupInfo` 推导出的集合 → **权威来源是 `staff.group.list?staff=true`**。**⭐ 机制（实测，且它解释了这一差异）**：在**全部 9 个**组中，对称差**恰好是 1 个人**，而这个人始终是**组管理员（`role=1`）** —— 跨 5 个不同客服共 9 条成员关系，4 个在职、1 个已禁用。→ **`staffIdList` 包含组管理员；`groupInfo` 和 `members` 都排除他们。** 应按这条规则记录，而不是记成"有些组缺人"。**⚠️ `members` 返回的行形态也比 `staff.list` 更窄 —— 10 个键（`createtime,email,id,maxServiceCount,nickname,phone,realname,role,status,username`），没有 `roleId`、`telephone`、`workNumber` 或 `groupInfo`** → 它不能作为 `staff` 表的直接替代品。`role` 在这里**是**可用的筛选项（`role=0`/`role=1` 会收窄结果；`role=2`/`role=-2` 返回空）。伪造的 `groupId` 返回 `{code:200, data:[]}` 且**不报错**；缺失 `groupId` 返回 `14004 Bad json params` |
| `tags` | `tag.all` | `id` | **24 行，每行恰好 3 个键：`id`（int）、`name`（str，24/24 非空）、`color`（str，24/24 匹配 `^#[0-9A-F]{6}$`，11 个不同取值）。扁平结构，无层级／parentId。** 多次调用顺序稳定，但**未按 `id` 排序**。⚠️ **该接口完全忽略其请求 body** —— 厂商文档声称 body 必须是字面量 `all`，但不传 body、`{}`、`"all"`、`{"foo":"bar"}` 甚至**格式错误的** `{` 全都返回逐字节相同的 `200`/`success`。→ 注册表不得假定该接口会校验 JSON；兄弟接口的 `14004 Bad json payload` 不能一概而论 |
| `ticket_categories` | `category.list` | `id` | `id`（int）、`name`、`parentId`（int，0=根）、`rank`（int，⚠️ **并非稀疏 —— 它是覆盖整棵树的稠密全局序号**：实测在 **0..173** 区间内有 169 个不同取值，3 个根分别为 0/1/2，每个父节点的子节点延续这一全局序列。此前"稀疏，实测 1/3/5/9/15/17"的说法是首页造成的假象）。实测 253 个分类，4 层深（分布 `{0:3,1:15,2:58,3:177}`），**以扁平形式返回，因此树必须由调用方构建**，无悬空 parentId |
| `ticket_templates` | `ticket.template.list` | `id` | `id`（int）、`name`、`createTime`（毫秒，大写 T）、`autoFlow`/`autoStatus`/`fileStatus`（0/1）、`autoGuide`（str）。**实测 35 条中 `status` 全为 1，因此不携带信息**（已停用的模板仍在列表中；停用信息只存在于名称中） |
| `ticket_template_fields` | `ticket.template.fields` | `(templateId,fieldId)` | **`fieldId`（int，写工单时用它对应 `customFields[].id`）**、`id`（int，**与 fieldId 不同**，它是模板-字段关联 ID）、`name`、`type`（∈{0,1,2,3,6,7}）、`required`（**int ∈{0,1,2}，三种状态，不是布尔值！**）、`customer`（0/1）、`description`（**同一字段名承载两种语义**：当 `type=1` 时它是 JSON 数组字符串 `[{"text":"..."}]`，当 `type=0` 时它是裸字符串）、`prefill`（JSON 字符串）。实测 294 条中 `status` 全为 0，因此不携带信息 |

> **关于 ID 类型的统一结论（实测）**：`staffId`/`groupId`/`tagId`/`templateId`/`fieldId`/`categoryId`/`ticketId` 在响应中**永远是整数**；请求传 int 或 str 都能通过。
> **无分页**：`staff.list`（传 `{}` 返回全部 330 行；`pageNo`/`pageSize` 被忽略）、`staff.group.list`（33 个组）、`group.members`、`tag.all`、`category.list`、`template.list`、`template.fields`、`filter.list` —— 它们都不分页。
> **文档中的参数名有误**：`kefu.v2.query` 的必填参数是 **`id`**，不是 `kefuId`；传 `kefuId` 会触发**Java NPE 泄漏**（`14500 Cannot invoke "...<类名>.getId()" because "staff" is null`）。

**事实表**：
- `sessions` —— 每个会话一行（来自导出）
  > **⚠️ `session_type` 列是必须的** —— 实测：机器人会话占 **68.3%**（3201/4687），且其字段集与人工会话**不同**（机器人侧有 **25 个字段**始终为空，另有 6 个字段存在但只取单一常量值，因此**31 个字段没有区分度** —— 见 §7.5；`closeReason`/`transferRgType` 的取值域也完全不同）。判别方式：`staffId<0 and !=-1` → `robot`，`==-1` → `internal`，`>0` → `human`。**不要用 `sType`**（与机器人/人工无关）。见 §7.5。
  > 机器人侧始终为空的字段（`sessionDuration`/`staffAccount`/`avgRespDuration`/`staffMessageCount`/`queueDuration`/`description` 等）**不应建索引，且聚合必须按 `session_type` 过滤**。
- `messages` —— 本阶段不在范围内，不预留任何列（真正实现时字段必然与现在的猜测不同）
- `tickets` —— 每张工单一行
  > **⚠️ 线上有 27 个键，文档只有 16 个。** `ticket.list`/`ticket.search` 的行携带 13–16 个未入文档的字段（`connectionId`、`connectionType`、`crmId`、`crmForeignId`、`firstDispatchTime`、`holderId`、`holderPlatformId`、`lastFinishProcessor`、`modifyLast`、`modifyTime`、`userId`，外加 `crm*` 的那三个 PII 字段）。→ 按 payload 建 schema（§10.5.5.1 的规则）。
  > **⚠️ `ticket.list` 的 `staffId` 必须是"在职"客服。** 扫遍真实 id：`status=1` 返回数据；**`status=2` 和 `status=3` 都返回 `14100 Bad holder staff id`**（各 14/14）。`staffId=-1`/`-99` 返回 `14500 Internal error`；`0` 和不存在的 id 返回 `14100`。→ 遍历所有客服的同步会在约 55% 已停用的客服上失败；必须先按 `status=1` 过滤，并把 `14100` 视为"客服不在职"，而不是通用错误。
  > **`ticket.list` 的 `limit` 被硬性限制在 50**（51/100/500/1000 都只返回 50）—— 远低于 `ticket.search` 的 500 上限。`offset` 可翻到末尾。
  > **`ticket.filter.list` 接受空 body**，无需任何参数（59 个筛选器；按在职 `staffId` 限定后得到严格 10 项的子集）。在 7/7 个筛选器上，`ticket.filter.count` 对同一 `(staffId, filterId)` 的结果与 `ticket.list` 的 `total` 完全一致，且其计数以**裸十进制字符串**返回（`'101596'`），不是数字。
- `ticket_logs` —— 工单日志
  > **必需**：`ticket search` 只返回 `createTime`，**没有关闭／转接／领取时间**。没有 `ticket_logs` 就无法回答"张三昨天处理了多少工单"或"平均处理时长"。
- **三张知识库表**（`knowledge_items` / `knowledge_points` / `knowledge_categories`）—— **企业级全量快照，只读**。字段与实测分布见 §10.5.3；`categoryInfo` 可能缺键的情况见 §10.5.9。
  > **⚠️ 两个反直觉之处**：① `knowledge_items` **是所有机器人的并集**（12778 行，涵盖 5 个机器人），而 `knowledge_categories` **按 robotId 隔离** —— **两个接口语义不同，谁也不能从对方推断出来**；② **73% 的行是相似问**（`type=10`，`answer` 始终为空）→ **"知识条数"必须声明其定义**；报告 12778 会把业务实体数量夸大约 **3.75 倍**（12778/3410；标准问实际是 3410 条）。

**报表**（10 张表，**全部实测**，粒度和主键如下）。最后两行是**实时快照，不是报表** —— 它们列在这里是因为共用 shape-C 信封和 `-1` 哨兵值，但它们无法作为历史数据同步：

| 表 | 接口 | 实测粒度 | 主键 | 最大跨度 |
|---|---|---|---|---|
| `staff_workload` | `statistic.staffworklod` | 每个客服一行 | `stat_date + staff_id` | 31d |
| `staff_satisfaction` | `statistic.satisfaction.report` | 每个客服一行 | `stat_date + staff_id` | 31d |
| **`staff_attendance`** | `statistic.staffAttendance` | **⚠️ 粒度取决于请求** —— 提供 `startTime` 时为**小时**（31d ⇒ 17,765 行），省略时为**天**（⇒ 1,646 行） | **`staff_id + hour_ts`** —— ⚠️ 对天粒度路径来说是错的，见下 | 31d |
| `staff_quality` | `statistic.staffquality` | 每个客服一行 + 一条 `sum` 全局汇总 | `staff_date + staff_id` | 31d |
| `order_performance` | `statistic.performance` | 订单明细 + 一条 `sum` 汇总 | `order_id`（+ 全局 sum 表） | **365d** |
| `daily_overview` | `statistic.overview` | 一行全局汇总（69 个字段） | `stat_date` | 31d |
| `staff_salary_detail` | `statistic.salaryDetail` | **1 次调用 = 1 个客服，且只覆盖窗口起始的那一天** | `staff_id + work_date` | **无** |
| `robot_summary` | `robot.statistic.summary` | 一行全局汇总（27 个字段） | `stat_date` | 31d |
| `transfer_human` | `ai.statistic.transferHuman` | 永远 1 行（`type` 始终为 0） | `stat_date` | **365d** |
| `realtime_session` | `data.overview.session` | **全局实时快照** —— **线上 28 个字段 vs 文档 15 个**；文档中的 `evaluationCount` 在线上**不存在** | `captured_at` | **不支持任何时间参数**；`toGroup`/`toStaff`/`assignStaff` 为**必填**，`-1` 表示"全部" |
| `realtime_ipcc` | `data.overview.ipcc` | **全局实时快照** —— **线上 31 个字段 vs 文档 16 个** | `captured_at` | **不支持任何时间参数**，但 JSON body **是**必需的（没有则 `14004 Not found param`）。⚠️ **不属于那 10 张报表** —— 与 `realtime_session` 一样它是快照，列在这里只是因为共用 shape-C 信封 |

> **⚠️ 版本 1 把 `staff_attendance` 称为"每个客服一行"是错的** —— 实测 `date` 是**按小时对齐的时间戳**（100/100 满足 `% 3600000 == 0`），粒度是**客服 × 小时**。1 天窗口约 614 行。
>
> **⚠️⚠️ 但粒度并不固定 —— 它随是否提供 `startTime` 而切换，这是一次无声的 10 倍少抓：**
>
> | 请求 | 粒度 | `total` | `date` 对齐 | `loginDuration` 最大值 |
> |---|---|---|---|---|
> | **提供 `startTime`** | **客服 × 小时** | **17,765** | 按小时对齐 | 3,600,001 毫秒 |
> | **省略 `startTime`**（只给 `endTime`，或都不给） | **客服 × 天** | **1,646** | 按天对齐 | 86,400,024 毫秒 |
>
> 在共享的 `(staff, date)` 上交叉核对：天粒度行报告 `loginDuration = 86400024`，而同一客服的小时行报告 `3600001`。相同的 `(staff, date)` 对从不重复。
>
> → **省略 `startTime` 的同步会把天粒度行写进主键为 `staff_id + hour_ts` 的表，并无声地少抓约 10 倍。** 同步必须**始终传 `startTime`**，且表必须记录粒度，以便混合粒度可被检出。（`endTime` 仍不得晚于今天 00:00 —— `endTime = now` 返回 `14501 endTime is invalid`。）
> **⚠️ `data.overview.session` 不是报表** —— 它只返回**当前实时快照**，**没有历史回填能力**。把它放进报表同步是错的；应作为实时接口单独列出。
>
> **⚠️ 但它并非"忽略所有输入参数" —— 本说明的早期版本这么写过，这是错的。** A/B 交替实测 5 轮：当 `toGroup`/`toStaff`/`assignStaff` 全为 `[-1]` 时响应为 `sessionCount=15, totalSessionCount=1121, kefuCount=6`；传**真实** id 时为 `sessionCount=0, totalSessionCount=0, kefuCount=0, averageWaitingTime=-1`。秒级内可复现、可逆转。→ **`-1` 是真正的"不过滤／全部"选择器，而且这三个键确实必填**（完全省略 body 会返回 `14004 Not found param`）。只有 `type` 固定为 `1`。传真实 id 的调用方会得到一份全零快照，看起来像"没有流量"。

**`date` 字段不可信（逐接口实测）**：

| 接口 | `date` 的真实语义 | 处理方式 |
|---|---|---|
| `staffworklod` | **始终为 `0`** | 必须由调用方按窗口填写 |
| `satisfaction.report` | **按天取整的窗口起点** —— ⚠️ 早期版本称之为"对 `startTime` 的逐字回显"，这不准确：实测 `date` 在所有 96 行中都恒定，等于窗口起点**向下取整到当天零点**，因此只有当 `startTime` 本身就是零点时它才与请求逐字节相同 | **不是业务日期，不可持久化** |
| `staffquality` | **`timestamp` 是客服账号的创建时间**（实测为 2023 年） | 不是报表日期；内联的 `startTime`/`endTime` 字段始终为 0 |
| `staffAttendance` | **该小时按小时对齐的时间戳** | ✅ 唯一可直接使用的 |
| `salaryDetail` | **窗口起始日**（跟随 `startTime`） | 当窗口 ≠ 起始日时，它不能充当窗口日期 |
| `overview`/`robot_summary`/`transfer_human` | **完全没有日期字段** | 由调用方填写 |

→ **统一结论：日期一律由调用方按窗口填写**；不要相信响应内的任何日期字段。

**⚠️ `-1` 是整个报表面族中表示"无数据"的哨兵值，而厂商在任何地方都没有记录它。** 它出现在 `overview`（**69 个字段中的 29 个**）、`staffworklod`（`noReplyRatio`、`avgRobotHostingDuration`）、`satisfaction.report` 和 `staffquality`（各 7 个比率字段）、`data.overview.session`（`averageWaitingTime`）以及 `ipcc`（`callOutDiffCalleeAnswerRatio`）上。在 `overview` 上通过 A/B 得到证明：一个数据充足的 31 天窗口给出 `assignedRatio=0.987, sessions=48695`，而一个什么都匹配不到的筛选条件给出 `assignedRatio=-1.0, sessions=0`。**`-1` 从不表示负比率 —— 它表示"该窗口或筛选条件没有匹配到数据"。** 有两个字段**无论数据如何、每次**运行都是 `-1`（`sessionInviteRatio`、`avgRobotHostingDuration`），有一个始终是 `null`（`carrier`）。→ **CLI 必须把 `-1` 呈现为"无数据"，绝不能当作数值**，否则 Agent 会报出 −100% 的满意度。

**⚠️ `statistic.performance` 的全 null 形态是筛选失败，而不是空窗口。** 当 `staffIdList`/`staffGroupList` 含有**该租户上不存在的 id** 时，会出现 `{orders:null, sum:null, total:null}` 且 `code:200`（厂商自己的示例 body 就能复现）。有效 id、不传 id、以及真正的空窗口都返回正常的 `{orders:[], sum:{…0s}, total:0}`。→ 把 `orders:null` 注册为 `kind: "filter_matched_no_staff"`，绝不能注册为 `empty`。同样未入文档的还有：**空结果集上 `page > 1` 会返回 `14500 Internal error`**。

**⚠️ `statistic.performance` 的字段名在厂商文档中拼错了**：文档中的 `translationRatio` / `translation48Ratio` / `sellMoneyRatio` 在线上是 **`translationRadio` / `translation48Radio` / `sellMoneyRadio`**（是 `Radio`，不是 `Ratio`），而文档中的 `nameSpell`/`userName` 在 `sum` 中并不存在。所有内容都在 `sum` 之下；文档中那些平铺的 `message.*` 字段并不存在。→ 又一个 §10.5.5.1 规则的实例：按 payload 建注册表。

**同步策略：按天轮转，而不是按接口串行（实测得出的策略结论）**

限流是**按路径独立 30 秒**（实测：对同一路径的连续调用总是返回 `14009`；对不同路径连续 7 次调用全部成功）。因此：

```
❌ Serial per interface over 31 days: 10 interfaces × 31 days = 310 calls → 310 × 30s ≈ 2.6 hours
✅ Rotate by day:            31 days × 30s          ≈ 16 minutes
   for day in last_31_days:
       for api in all_10_apis: call(api, day)   # 同一天内不同路径可以连续跑
       sleep(30)                                 # 只有同一路径需要等待
```

**⚠️ 空结果必须重试**：`staffAttendance` 实测到**偶发的假空**（同一 body 先返回 `{"result":[],"total":0}`，重试后恢复出 17765 行）→ **每个空结果至少重试一次再判定为空**，否则整段数据会被无声地丢掉。

**分页**：参数是 **`page`**（不是 `pageNo`）；`pageSize` 默认 100，最大 1000。`staffAttendance` 的 `total` 是完整行数（31d = 17765），而**默认只覆盖最近 3 天** → 必须显式传 `pageSize=1000` 并翻页。

**其他实测坑点**：
- **`staffquality` 的 `sum` 与分页无关，始终覆盖全集**（`pageSize=5` 时 `result` 有 5 行，但 `sum` 仍统计全部 123 次评价）→ 写入全局表时要单独处理
- **`salaryDetail` 需要单个 `staffId`**（省略返回 `14004 staff id can not null`；传数组 `staffIds` 不被识别）→ 每个客服一次调用
- **`robot_summary` 忽略 `robotId`**（传与不传，`data` 逐字段相同）；**`transfer_human` 忽略 `type`**
- **时间参数始终是毫秒**。传秒**不报错，但会无声降级**（`overview` 会把 69 个字段中的 49 个变成 `-1`，而 `code` 仍是 200）—— 最危险的坑
- **⭐ `data.overview.session`（实时报表）有三个必填请求参数，其全部文档就是一个哨兵值**：`toGroup`、`toStaff`、`assignStaff` 都是 `array<integer>`，都被列为 `required`，而官方对每一个的说明逐字为 **`当前版本是-1`**（当前版本是 -1）。文档中唯一可用的取值是 **`-1`**，给在示例 body 里。→ **Agent 无法从任何地方推导出这一点** —— 参数名暗示着真实的筛选语义（"发给哪个组／哪个客服／指派给谁"），而 API 却忽略它们。CLI 必须硬编码文档给出的 `-1` 三元组，并在 `--help` 中说明这些是占位符，以免 Agent 被误导去传真实的组或客服 id

**⚠️ `endTime` 的整日对齐检查只对两个接口成立（实测，逐接口核实）**

| 接口 | `endTime` 越界（晚于今天 0:00） | 是否需要整日对齐 |
|---|---|---|
| **`staffAttendance`** | **`14501 endTime is invalid`** | ✅ **需要** |
| **`performance`** | **`14501 endTime is invalid`** | ✅ **需要** |
| `overview` / `staffworklod` / `staffquality` / `satisfaction.report` | **正常返回 200**（传 `NOW` 也可以） | ❌ 不需要 |

- 对齐检查**与跨度无关**：实测在 `staffAttendance` 跨度只有 1–2 天时，越界的 `endTime` 仍报 `endTime is invalid`
- 纯历史窗口**不受此限制**（`5 天前 0:00 → 5 天前 12:00` 正常工作）
- **⚠️ 今天 0:00 这条边界不稳定**：实测同一个 `endTime = 今天 0:00` 有时返回 200，有时返回 `endTime is invalid` → **拉取包含今天的窗口时留出安全余量（用 `昨天 0:00 → 今天 0:00`，不要贴着边界）**

**⚠️ 两种 `14501` 必须靠 message 区分**：`endTime is invalid` 是**对齐问题**，`(endTime - startTime)/millsADay > 31 is invalid` 是**跨度问题**。错误码相同，但修复方式完全不同 —— CLI 必须解析 message，而不能只看 code。

**元数据表**：`sync_state`（水位、区间状态、最近错误）、`sync_gaps`

### 6.3 类型与序列化（实测约束）

| 约束 | 原因 | 解决方案 |
|---|---|---|
| **必须使用 `getRowObjectsJson()`** | `getRows()` 返回 `DuckDBDateValue` 之类的包装对象；`getRowsJS()` 含 BigInt + Date，`JSON.stringify` **直接抛错**（实测：`Do not know how to serialize a BigInt`） | 只用 `getRowObjectsJson()`，它输出 JSON 安全的值 |
| **绝不对 DuckDB 时间值使用本地时间 getter** | 实测：在 `TZ=America/New_York` 下，`DATE '2026-01-01'` 通过 `getRowsJS()` 读回为 2025-12-31 | 一律走 `getRowObjectsJson()`（返回字符串，无时区问题）；在测试中断言跨三个时区 |
| **所有 ID 列使用 `VARCHAR`** | DuckDB 的 `BIGINT` 读回为 bigint，SQLite 读回为 number（无声丢精度）；`node:sqlite` 直接抛 `RangeError` | 统一用 VARCHAR；两种后端都将其映射为 JS 字符串 |
| **upsert 使用 `ON CONFLICT ... DO UPDATE SET`** | 实测：`INSERT OR REPLACE` 语义不一致 —— DuckDB 保留未列出的列，SQLite 将其置为 NULL | 显式列出每个非键列；注意 DuckDB 在没有 UNIQUE 约束时会拒绝 |
| **批量写入使用多值 INSERT** | 实测：逐行 243.6ms/批 vs 多值 10.9ms/批（**快 22 倍**），且在 80 万行时也不退化 | `Store.upsert` 必须在内部构建多值语句，绝不循环 |
| **`message` 需要二次解析** | **实测**：报表接口的 `message` 是 **JSON 字符串**（例如 `'{"result":[...]}'`），既不是对象也不是数组 | 信封归一化层必须检测 `message` 是否为可解析的 JSON 字符串，若是则再 `JSON.parse` 一次 |

### 6.4 并发模型（实测约束）

**DuckDB 的跨进程锁是排他的。** 实测 4×4 矩阵：

| 组合 | 结果 |
|---|---|
| `rw → rw` | **阻塞** |
| `rw → ro` | **阻塞** |
| `ro → rw` | **阻塞** |
| `ro → ro` | 正常 |

错误原文逐字：`IO Error: Could not set lock on file ... Conflicting lock is held`。官方文档只承诺当**所有**进程都为只读时并发可行；它**从未**承诺在 RW 持有者存活期间另一进程能以只读方式打开。

**设计**：
- **单写者**：`sync` 持有 RW，并在进程退出时释放
- **读者重试**：`query` / `db` / `sync status` / `sync verify` / `stats` 等读库命令以 RO 模式打开，冲突时**以固定间隔退避重试**（实测：一个读者在约 2.6 秒、13 次重试后成功）
  （**2026-10-30 收窄：`api call` 不在其中** —— 它零加载 `store/`（§7.4），根本不打开本地库、不持有 RO 锁，也不会撞 `store_locked`，别指望它等你。）
- **有界重试**：超过阈值（默认 30 秒）后返回 `kind: "store_locked"` + `hint`；**Agent 不得被无限阻塞**
- **`sync` 之间的互斥**：在 `sync_state` 中加入 `locked_by` / `locked_at`
- 多个纯读进程可以并发运行（实测：3/3 成功）

> **⚠️ 两处收窄（2026-10-30 回写）**：
> 1. **曲线是固定间隔，不是指数退避。** 实现（`src/store/retry.ts`）每次重试间隔恒为 **200ms**，
>    由实测反推：2.6 秒 13 次成功 ≈ 200ms/次。原文的「指数退避」是错的 —— 指数曲线在剩余预算
>    不足时会大幅越过 `maxMs`（例如最后只剩 300ms 预算却按指数该睡 1.6s），与「超过 30 秒就返回
>    `store_locked`」这条有界承诺直接冲突。**按固定间隔读，按固定间隔实现。**
> 2. **陈旧锁超时未实现。** `locked_by` / `locked_at` 两列**已落库**、任务开始盖上、结束（含异常）
>    清空，但**没有**"锁超过 N 分钟就判定持有者已死、强行接管"的逻辑。这与 `sync` 的实际形态
>    自洽：`sync` 是**前台进程**（不是守护进程 —— 守护进程明确列为非目标），进程退出时锁必然被
>    清空；能留下的陈旧锁只有 `kill -9` 一类硬杀。**当前行为**：`sync status` 的 `locked` 字段
>    会照实报告「被持有」，`locked_at` 供读方自行判断是否陈旧；CLI 不替你做接管。
>    若将来 `sync` 变成常驻/后台形态，这条必须补实现 —— 那时陈旧锁才是真问题。

**写操作必须包在事务中。** 实测：DuckDB 的 `BEGIN/DELETE/INSERT/COMMIT` 可避免空档；在 `kill -9` 之后 WAL 会自动重放，数据完整且未损坏。

### 6.5 PII 处理（实测：数据中确实含有真实客户隐私信息）

**实测确认**：`/openapi/export/session` 含有**真实客户 PII**。对全部 4687 行逐字段核实（计数 = 该字段存在且非空的行数）：

| 字段 | 行数 | 类别 |
|---|---|---|
| `userPhone` | **4640 / 4687** | 手机号 —— 最敏感的单字段，出现在 **99%** 的行上 |
| `userName` | **4687 / 4687** | 客户姓名，**每一行**都有 |
| `userEmail` | 294（字段存在于 768 行） | 邮箱 |
| `userAddress` | 2726（字段存在于 2983 行） | 实体地址 |
| `fromIp` / `userIpCity` | 4642 | IP 及其所在城市 |
| `userCrmInfo` | **4446** | ⚠️ 是 **JSON 字符串**，不是对象 —— 见下 |

> **⚠️ 字段名更正。** 本节的早期版本使用了 `userMobile`、`crmUserPhone` 和 `crmUserEmail` 这三个名称。**这三个在会话导出中都不存在**（4687 行中 0 次出现）。真实名称是 `userPhone` 和 `userEmail`。错误名称不得用于脱敏配置或 `db describe` —— 挂在一个不存在字段上的 `sensitive: true` 标志等于什么都没保护，而 `userPhone` 会被原样输出。
>
> **⚠️⚠️ 但该更正仅限会话导出，绝不能推广 —— 工单域用的是相反的字段名，只按会话字段名脱敏会在那里泄漏。** 在 `ticket/search`（500 行）、`ticket/list`（100 行）和 `ticket/new/detail`（299 行）上实测：
>
> | 字段 | 会话导出 | 工单域 |
> |---|---|---|
> | `userPhone` | **真正的载体（99%）** | **不存在** |
> | `userMobile` | 不存在 | 存在于 100% 的行，**非空率 0%** |
> | `userName` | 存在，100% 有值 | 存在于 100%，**非空率 0%** |
> | `userEmail` | 存在，稀疏 | 存在于 100%，**非空率 0%** |
> | **`crmUserPhone`** | 不存在 | 存在于 100%，**非空率约 78–81%** |
> | **`crmUserName`** | 不存在 | 存在于 100%，**非空率 100%** |
> | `crmUserEmail` | 不存在 | 存在（48–100%），非空率 1–2% |
>
> → **两个域使用的 PII 字段名互不相交。** 在工单上，那些*看起来*像 PII 的字段（`userMobile`、`userName`、`userEmail`）**普遍存在且普遍为空** —— 它们不携带任何内容 —— 而真正的载体是 **`crmUserPhone` 和 `crmUserName`**。按文档字段名配置的脱敏在工单域上**什么都保护不了**，而且会漏掉真正的手机号。因此 `db describe` 必须**按表**、基于实测普查来标注 `sensitive: true`，绝不能依赖跨域共享的名称模式。

> **⚠️ `userCrmInfo` 是 JSON *字符串*，不是对象。** 实测：在全部 4446 个非空行上它都是 `str`，解析后为 `{index, isCustomField, key, label, value}` 项的 JSON 数组 —— **4446/4446 解析成功，0 失败**。这与报表的 `message` 字段（§6.3）是同一类陷阱：值在 payload 中看起来是结构化的，却以文本形式到达。**它承载企业自定义字段**（由租户配置的逐行标签和值，例如组织、门店、合作伙伴、内部评级等字段）→ 必须将其视为**无界的、含 PII 的 blob**，整体脱敏而非逐字段脱敏，并且绝不能原样写入日志或报表。

**⚠️ 会话导出不是唯一的 PII 面。** `POST /openapi/session/user/profile` 是**第二个、独立的面**，而且它*不是*会话导出 —— 它是按 `sessionId` 键控的逐客户查询。对 70 个真实会话实测（计数 = 该键存在的行数）：

| 字段 | 行数 | 类别 |
|---|---|---|
| `phone` | **70 / 70** | 手机号 |
| `name` | **70 / 70** | 客户姓名 |
| `address` | 35 / 70 | 实体地址 |
| `email` | 5 / 70 | 邮箱 |
| `customField` | 35 / 70 | ⚠️ **与 `userCrmInfo` 相同的无界、租户配置 blob** —— 其取值为自由文本，包含手机号、街道地址、人名和业务单元名 |

→ 必须把 `session.user.profile` 加入 `sensitive: true` 列表，并纳入下文"整体脱敏该 blob、绝不原样记日志"的规则。**它的 `customField` 与 `userCrmInfo` 属于同一类风险，只是经由另一个接口到达** —— 只脱敏 `userCrmInfo` 会把这一处敞开着。

**为什么这里的风险高于普通 BI 工具**：主要使用者是 **AI Agent**。被持久化的 PII 将会：
1. **长期留存**在本地数据库中（不像人的一次查询，它不会随会话消失）
2. 被 Agent 写入**日志、报表和对话上下文**
3. 通过 `--sql` 被任意 SELECT 出来，随后由 Agent 复述给人类

**设计决策**：

| 措施 | 备注 |
|---|---|
| **`db describe` 必须标注敏感列** | 在列元数据上标记 `sensitive: true`（手机号／邮箱／地址／IP／身份证号等），使 Agent 可以避免 SELECT * |
| **默认脱敏；只有 `--no-mask` 才输出原始值** | 手机号脱敏为 `138****1234`，邮箱为 `a***@x.com`，IP 末段打码。**这是 CLI 层的输出转换，不是存储层的** |
| **`db tables` / `db describe` 必须明确说明** | 在输出中加入一行："本数据库包含客户 PII；不要将其写入日志或对外报表" |
| **skill 中的显式约束** | "不要把 PII 写进给人看的报表；必须引用时使用脱敏形式" |
| **不做加密存储** | 与"Agent 能通过 `--sql` 直接查询"这一目标冲突；密钥管理也超出 CLI 的范围。**明确记为范围之外，而不是遗忘** |

> 取舍：默认脱敏会给"导出客户名单"之类的正当需求增加一步 `--no-mask`，但**默认安全**胜过默认便利 —— 尤其考虑到使用者是不受监督的 Agent。

**`DELETE` 不会回收空间**：官方文档明确写道"执行 DELETE 并不意味着空间被回收"；需要定期执行 `CHECKPOINT`。

> **⚠️ 运维须知（2026-10-30 回写）**：CLI **不执行 `CHECKPOINT`**，也没有任何命令替你做这件事
> （全仓无 `CHECKPOINT` 调用 —— 这是范围外而非遗漏）。
> **「不回空间」不等于「文件只增不减」**：DuckDB **自己**会按 WAL 大小自动 checkpoint
> （内置设置 `wal_autocheckpoint`；本仓库不改它、用默认值 —— 该设置名可从随包的
> `libduckdb.dylib` 字符串表核到），所以 WAL 的累积是被自动限制的。
> **但自动 checkpoint 不等于「文件大小有界」** —— 它限制的是 **WAL** 的增长，而
> **已删除行的空间只回收一部分**，所以反复同步**仍可能**让主库文件缓慢增长。
> **别把「会自动 checkpoint」读成「不用管文件大小」**：要盯着看 `ls -l`。
> **什么时候需要手动做**：删过大量行、想让空间尽量回收时，用 DuckDB 客户端连上库执行
> `CHECKPOINT`。**别期待它一定把文件缩小** —— checkpoint 会把数据重写到新文件，但**已删除行
> 的空间只回收一部分**，能否变小取决于剩余数据布局。**判断依据**：`store status` 报的行数是
> **逻辑行数**，不反映文件膨胀；文件大小要自己看 `ls -l`。
> **✅ / ⚠️ 边界**：以上「DuckDB 自动 checkpoint」来自其文档与随包二进制的设置名，
> **本仓库未对「多大 WAL 触发」做实测**；手动 `CHECKPOINT` 的回收效果同样**未实测**。

## 7. 同步引擎

**可重复的全量同步是一等公民** —— 只有第一次快不叫生产力；随时能重建才叫。

### 7.1 命令

```bash
qiyu sync run [task]            # 增量同步
qiyu sync run --full [task]     # 全量重刷（重新冲刷一个区间）
qiyu sync run --since --until   # 指定一个区间
qiyu sync status                # 水位、最近一次结果、缺口、是否加锁
qiyu sync tasks                 # 列出可用任务（含每任务敏感列出口）
qiyu sync verify [task]         # 校验本地与远端一致性
```

`sync run` 是幂等的，可以直接交给系统调度器。

### 7.2 幂等与可重复性

- **报表类表用「按范围删除 + 插入」，而不是纯 upsert**。实测：纯 upsert **不会删除行**，所以当坐席离职或某天没有数据时，陈旧行会残留（3 行 → 仍是 3 行）。按范围删除是必须的。要把它包在事务里，以避免出现空窗。
- **`--full` 的先删后插必须放在事务内**，并且 `sync_state` 要记录范围状态（`pending`/`complete`），这样 Agent 才能区分「没有数据」和「没有同步」。
- **水位线按范围推进**，只有整个范围成功后才提交。中断之后会自动续跑。
- **故障隔离**：一个任务失败不影响其他任务；失败的范围记录在 `sync_gaps` 里。
- **主键稳定性**：所有 ID 都用 VARCHAR（见 §6.3）。

### 7.3 时间切片与水位线

> **窗口上限与水位线全部来自实测**（2026-09-30，183 次探测 + 在呼叫系统上的实测）。在版本 1 中，这张表里有很多条目是文档值；这些已经被更正。

| 数据集 | 窗口上限（实测） | 水位线 | 备注 |
|---|---|---|---|
| 历史数据概览 `statistic.overview` | **31 天** | `query_start` | 无必填参数；默认 = 最近 31 天 |
| 坐席工作量 / 质量 / 满意度 | **31 天** | `query_start` | 每个坐席 1 行；`date` 不可信 |
| **坐席考勤 `staffAttendance`** | **31 天** | `query_start` | **只有传入 `startTime` 时粒度才是 坐席 × 小时**；不传则得到 坐席 × 天，且 `total` 约小 10 倍（§6.2）。**务必传 `startTime`**。`endTime` 不得晚于今天 00:00 |
| **考勤明细 `salaryDetail`** | **无限制**（400 天也可以） | `staff_id + work_date` | **必须传单个 `staffId`**；只返回该窗口的起始日 |
| **订单绩效 `performance`** | **365 天** | `query_start` | 明细 + `sum`；测试账号没有这类数据 |
| **机器人会话统计 `robot.summary`** | **31 天** | `query_start` | 忽略 `robotId`；超限报 `14004`（不是 `14501`） |
| **转人工统计 `transferHuman`** | **365 天**（建议 ≤360） | `query_start` | 忽略 `type`；364 天会报 `Internal error` |
| **实时数据 `data.overview.session`** | **不支持任何时间参数** | `captured_at` | **实时快照，无法回补** |
| 呼叫概览 `/ipcc/overview` | 实时快照 | — | **间隔 ≥5 分钟**，无法回补 |
| 呼叫坐席历史 `/ipcc/history/seat` | 文档说 90 天 | `query_start` | 实测约 20 秒冷却 / `14402`；`message` = JSON 字符串 → **数组** |
| 呼叫团队历史 `/ipcc/history/team` | 同上 | `query_start` | **独立路径**（不与 `seat` 共用）；→ **对象**（55 个字段） |
| 工单检索 | **名义上 90 天，但操作时间窗口实际 ≤31 天** | **`opStart`/`opEnd`** | ⚠️ **按 ≤31 天切分操作时间窗口，不是 90 天** —— `opStart` 会被静默截断到 *当前时间* 之前约 31 天，而更宽的窗口不会返回更多行，也不报错。见 §10.1 |
| 会话导出 | **6 天** | **`endTime`** | 见 §7.5 |
| **知识库 `robot.data.knowledge`** | **全量**（无时间参数） | **`updateTime`** | 游标分页（`mid`+`isEnd`）；实测 12778 行 / 13 页。见 §10.5 |
| **知识点 `robot.data.kpoint`** | **全量** | **`updateTime`** | 实测 309 行，size=1000 一次调用即可全部取回 |

> **知识库属于「全量快照」型，不是时间窗口型** —— 该接口**完全不接受任何时间参数**，所以只能整批拉取，然后在本地基于 `updateTime` 做成增量。因此它**不走窗口切分逻辑**；一次同步要 13 个请求（在 30 秒限频下约 6.5 分钟）。这是本阶段唯一不需要水位线窗口的数据集。

**工单的水位线必须用 `opStart`/`opEnd`（操作时间），而不是 `start`/`end`（创建时间）。** 工单行只有 `createTime`，所以按创建时间做增量同步**永远拿不到状态变更**（关闭 / 转交 / 驳回）。需要一个重叠的回看窗口（默认 3 天）来覆盖乱序到达的变更。

### 7.4 限频

各接口的限频被硬编码进 `ratelimit.ts` 的令牌桶。**实测分布如下（不要外推）**：

| 接口 | 限制 | 错误码 | 来源 |
|---|---|---|---|
| **咨询分类 `online/session/category/list`** | **60 秒** | **`12001`** | 实测 |
| **10 个报表接口** | **约 30 秒，按路径各自独立** | `14009` | 实测（183 次探测） |
| 会话导出 · 创建 | **每 10 秒 6 次**（10 秒冷却） | **`8011`** | 实测 |
| 会话导出 · 检查 | **无限频** | — | 实测 |
| **呼叫概览 `/ipcc/overview`** | **10 次请求 / 60 秒（滚动）** | `14009` `api request too frequent,60s can request less than 10 times` | **实测 —— 文档说的「≥5 分钟」差了约 30 倍** |
| 呼叫坐席/团队历史 | 间隔 ≥5 分钟 | `14009` | 文档 —— ⚠️ **本行已被实测推翻，见下方注** |
| ~~订单绩效导出~~ | ~~每分钟 1 次~~ | — | **实测未能复现**：与其他报表一样，按路径 30 秒 |
| ~~转人工会话统计~~ | ~~每秒 1 次~~ | — | **实测未能复现**：按路径 30 秒 |
| 知识库大部分接口 | 每秒 1 次 | `14009` | 文档 |
| 知识库详情 / 规则回答接口 | 每秒 10 次 | `14009` | 文档 |
| `chat/queue/group/query`、`evaluation/setting/get`、`customfield/template`、`event/queryQueueStatus`、`smstask/status` | **完全没有限频** | — | 实测 |
| **维表与工单域，13 个接口** | **完全没有限频**（50×200 并发，零 `14009`） | — | 实测 |
| ~~坐席考勤报表「默认只返回前 100 行」~~ | 不是限频，而是**分页默认 `pageSize=100`** | — | 实测 |

> ⚠️ **`14009` 的报文同样不止一种字符串。** `/openapi/statistic/*` 返回 `api call too frequent`，而 `/openapi/data/overview/ipcc` 返回 `api request too frequent,60s can request less than 10 times`。→ 因为 §4.3 要求按报文文本分派，限频探测必须**同时接受这两种措辞**（并且按共有的 `too frequent` 词干匹配，而不是匹配完整字符串）。
>
> ⚠️ **「呼叫坐席/团队历史」那一行的「间隔 ≥5 分钟」是文档值，已被实测推翻（2026-10-02 记录）。** 本表写它来自文档、错误码 `14009`，但 §4.3 的补充错误码表与 §7.4.1 的表格都记录了实测结果：**实际冷却约 20 秒、错误码是 `14402`（`Forbidden For Time rate`）**，而非文档说的 5 分钟 / `14009`。→ 实现取实测值（20 秒 / `observed`）；按文档填 300 秒会让 CLI 白白等待 15 倍的时间。本行与 §4.3/§7.4.1 冲突，**以后者为准**。
>
> ⚠️ **限频完全不统一**：冷却时间有四种 —— 30 秒 / 60 秒 / 5 分钟 / 10 秒；错误码有三种 —— `14009` / `12001` / `8011`；还有些接口**完全无限频**。
> **CLI 绝不能假定统一的 30 秒冷却或统一的 `14009`。** `ratelimit.ts` 必须逐个接口配置，并且必须同时识别这三种错误码。

> 版本 1 把「5 分钟」推广到所有报表是**错的**。限频表的每一行都必须标注来源。

**限频粒度是实测出来的：按路径各自独立**（183 次探测）：同一路径上 30 秒内的连续调用总是返回 `14009`，而**跨不同路径的 7 次连续调用全部成功**。这正是**报表同步策略的关键** —— 应该**按天**轮转（同一天内不同接口背靠背调用），而不是逐个接口串行推进：31 天从约 2.6 小时降到约 16 分钟。见 §6.2。

> **`RateLimit.scope` 的交付状态（2026-10-24，G1）**：限频表每一行都带 `scope` 字段，**27 个非 null 行全部是 `'endpoint'`** —— 上面的 183 次探测只支持「按路径独立」这一种结论，从未观测到跨接口共享配额（`'global'`）。联合类型里保留 `'global'` 只是给「将来真的实测到」留一个显式落点；**出现第二种取值必须同时改 `ratelimit.ts` 的注释、`ratelimit.test.ts` 的逐行断言与 `api schema` 的 `field_notes.rate_limit`**。消费方：`api schema <id>` 的 `data.rate_limit` 三态输出 —— 未登记不输出该键（没测过）、显式 `null`（实测无限频）、对象（含 `limit`/`window_seconds`/`source`/`scope`）。

### 7.4.1 报表时间跨度上限（逐接口实测，并不统一）

| 上限 | 接口 | 错误 | 来源 |
|---|---|---|---|
| **31 天** | `overview`、`staffworklod`、`staffquality`、`satisfaction.report`、`staffAttendance` | `14501 (endTime-startTime)/millsADay > 31 is invalid` | 两者一致 —— 文档说 `默认查询31天内数据之和` |
| **文档 30 天 / 实测 31 天** | `robot.statistic.summary` | **`14004`** `超出按天获取数据的最大时间范围，请检查参数`（不是 `14501`） | 文档说 **30**：`一次最多支持获取30天时间范围内的数据` |
| **365 天** | `statistic.performance`、`ai.statistic.transferHuman` | `14501 (endTime-startTime)/millsADay > 365 is invalid` / `14500 起止时间不能超过365天` | 文档说 365（`transferHuman` 是 `起止时间间隔不能超过365天`） |
| **90 天** | `v2/ticket/search` | — | 文档：`时间跨度不得超过90天` |
| **无限制** | `statistic.salaryDetail` | 实测 400 天窗口可正常返回数据 | 实测 |

> **⚠️ `robot.statistic.summary` 文档写的是 30 天，但实际可执行的上限是 31**（`一次最多支持获取30天时间范围内的数据`；实测，31 天精确到毫秒被接受，31 天 + 1 毫秒被拒绝）。它也是唯一一个超限错误是 `14004` 而不是 `14501` 的报表。→ **注册 `maxWindowDays: 31` 以对齐服务端实际执行的口径，并保留 `14004` 的分派。** 注册文档里的 30 会每个窗口都静默少取一天；注册实测的 31 既正确又安全。

> ⚠️ **上限和错误码都不统一** —— 对于同一个「超限」情形，有的返回 `14501`，有的返回 `14004`，而且报文中英混杂。**CLI 不能靠错误码判断「超限」；它必须按接口注册表里的 `maxWindowDays` 预先校验**，否则 Agent 会收到一个它无法理解的错误。

> **⚠️ 承诺收窄（2026-10-30 回写）：预校验只有 `sync` 做，`api call` 不做。**
> · **`sync`**：任务注册了 `maxWindowDays`，引擎按它**切窗**（`src/sync/engine.ts`
>   `sliceForTask`）—— 超限窗口**发不出去**，这才是这条要求真正兑现的地方。
> · **`api call`**：`src/commands/api.ts` 的 `call()` **没有这道预检**，`api list` / `api schema`
>   只**输出** `max_window_days`（供 Agent 自己看），不拦你。**为什么**：注册表**不登记 `params`**
>   —— 它不知道这个接口的窗口起止放在 body 的哪两个字段里，无从校验。硬做只能按字段名猜
>   （`startTime`/`endTime`/`start`/`end`/`query_start`…），猜错就是对着合法调用报错。
> · **对 Agent 的实际含义**：`api call` 里读到 `max_window_days` **必须自己按它切**。
>   **别指望「不切也一定能拿到某个固定 kind」** —— 超限的**报错码与报文按接口族不同**
>   （§7.4.1 的表格：`/openapi/statistic/*` 是 `14501`、`robot.statistic.summary` 是 `14004`、
>   `ai.statistic.transferHuman` 是 `14500`、`ticket.search` 是 `14004 range over limit`）。
>   CLI 把**已识别的那几种报文**都归成 `kind: 'window_too_large'`（hint 里带上限数字），
>   但这是「识别到的措辞」而非「所有接口的保证」：某个接口若换一种没见过的超限报文，
>   就会落到 `param` / `unknown`。**判据**：先按 `max_window_days` 切，别等报错再猜 ——
>   切错了是白打一次网络，猜错了是把参数错误当成能靠重试解决的。
> ⚠️ **判定式并不是 `span > N days`，而且两个报表族用的判定方式不同。** 已线上二分验证（2026-09-30）：
>
> | 族 | 判定式 | 接受 | 拒绝 |
> |---|---|---|---|
> | `/openapi/statistic/*`（`overview`、`staffworklod`、`staffquality`、`staffAttendance`、`satisfaction.report`） | **`floor(span / 86400000) > 31`** —— 向下取整 | **31 天 + 23 小时 59 分 59 秒 999 毫秒** | **恰好 32 天**（`14501 (endTime - startTime)/millsADay > 31 is invalid`） |
> | `robot.statistic.summary` | **`span > 31 * 86400000`** —— 精确比较 | **恰好 31 天** | **31 天 + 1 毫秒**（`14004 超出按天获取数据的最大时间范围，请检查参数`） |
> | `/openapi/statistic/performance` | **`floor(span / 86400000) > 365`** —— 向下取整 | **366 天 − 1 毫秒** | **恰好 366 天**（`14501 ... > 365 is invalid`） |
> | `ai.statistic.transferHuman` | 精确比较 | **365 天 − 2 毫秒** | **恰好 365 天**（`14500 起止时间不能超过365天`） |
>
> → **不存在「边界不稳定」这回事**（本说明的早前版本声称 `transferHuman` 在 364 天会失败；那是错的）。但也不存在统一的判定式：**`statistic/*` 族在名义上限之上还多给了约 24 小时的余量，而 `summary` 和 `transferHuman` 是精确比较。** 一个按 `span <= N * 86400000` 做预校验的 CLI 对这四个都是正确且安全的；一个假定向下取整形式的 CLI 会在 `summary` 上多取一天并拿到 `14004`。**用严格形式校验，并按族分别注册判定方式。**

> ⚠️ **`robot.statistic.summary` 把四种不同的故障塌缩成一个错误码和一条报文。** 缺 `startTime`、缺 `endTime`、`start == end` 和 `start > end` **全都**返回 `14004 Bad json payload, please check your param` —— 而超跨度范围返回的**并不**在其中（那一条带上文里的中文报文），所以这两类可以靠报文区分，但那四种畸形情形彼此之间无法区分。在这里，光看错误码什么都分辨不出来。

> ⚠️ **在该接口上，把秒当毫秒传同样会静默降级。** `robot.statistic.summary` 传一个秒级别的范围会返回 **`code:200` 且所有计数器都是 `0`** —— 不报错，一份看起来很像样的空报表。§14 已经为 `overview` 记录了这个坑；它并非 `overview` 独有，注册表必须按接口标注单位。

CLI 在本地持久化限频状态：命中 14009 之后它会记下「下次可调用时间」，之后对同一接口的调用**不碰网络直接快速失败**，因此 `retry_after` 永远是准确的。

> **⚠️ 承诺收窄（2026-10-30 回写）**：这句话**只对 `sync` 成立**，对 `api call` 不成立。
> - **`sync`**：`src/sync/rate-gate.ts` 把冷却写进 `sync_state`（`next_allowed_at` /
>   `last_rate_limited_at` 两列），**跨进程持久** —— 这是本节要的东西。
> - **`api call` / `auth` 等**：令牌桶是**进程内**的 `Map`（`src/core/ratelimit.ts`），不落库、
>   不跨进程。而 `api call` 是**一次性进程**（一调一退），所以两次 `qiyu api call` 之间**没有任何
>   共享状态** —— 每次都是全新的空桶。"记下下次可调用时间、下次不碰网络"对它**完全不成立**：
>   第二次调用照样打网络，`retry_after` 来自**这一次**服务端的响应（或本地桶对同一进程内后续调用的估计）。
>   **这也不是缺陷**：CLI 有一条红线「`auth`/`api` 零加载 `store/`」（`tests/store/layering.test.ts`），
>   要把冷却写进库就得把 DuckDB 拖进 `api call` 的启动路径 —— 为一次读调用付一个数据库引擎的
>   启动代价，得不偿失。限频表真正约束的是**将来那个单进程内批量调用的命令**（如同进程循环批量编辑）；
>   对当前的单次 `api call`，它在"同一进程里被调用多次"时才生效。
> **Agent 的实际依据**：单次 `api call` 撞限流时，读 `retry_after` 与 `retry_strategy` —— 那是这次
> 服务端如实给的，不是持久化状态推出来的。

### 7.5 会话导出流水线（本阶段的核心）—— 实测

**整条流水线已经端到端跑通**（实测：4687 个会话 / 37508 条消息，端到端约 65 秒）：

1. `POST /openapi/export/session` body `{start, end, code}` → `{code:200, message:"<task key>"}`
2. `POST /openapi/export/session/check` body `{key, code}` → 未完成 `14403 Wait...`，完成 `{code:200, message:"<download link>"}`
3. 下载 zip（**解压密码 = appKey 的前 12 个字符**），解压得到 **2 个 JSONL 文件**
4. 单条查询：`/openapi/export/session/one`（`{sessionId}`，**无需 code**）、`/one/message`（`{sessionId, mTypes}`）

#### 文档 vs 实测（5 处不一致，其中 2 处是重大不一致）

| # | 文档 | 实测 |
|---|---|---|
| 1 | 窗口 **≤2 天** | **≤6 天**（143.5 小时通过 / 144.0 小时返回 14004）→ **回补窗口从每年 183 个降到 61 个** |
| 2 | 链接有效期 **6 小时** | **192 小时（8 天）** |
| 3 | `code` 必填 | **可选** |
| 4 | `mTypes` | **必须是逗号分隔的字符串；传数组 → `14500`** |
| 5 | 未记录 | **创建限频每 10 秒 6 次**（超限返回 `8011 create too fast`，冷却 10 秒）；`check` **无限频** |

#### 关键行为（影响同步正确性）

- **⚠️ 导出是按 `endTime` 过滤，不是按 `startTime`**。判定式是 `window.start <= endTime <= window.end`。实测两个窗口的越界行数：按 `endTime` 有 0 行越界，按 `startTime` 有 14/17 行越界。→ **水位线必须用 `endTime`**。
- **⚠️ 相邻窗口必须重叠**：跨越窗口的长会话会被漏掉。实测两个相邻窗口的交集：5 个会话、16 条消息。
- **⚠️ `message.txt` 是按 `time` 过滤**（与会话的 `endTime` 不同）→ 一个会话的消息可能只被部分导出（实测：24 个 sessionId 出现在 message.txt 中却不在 session.txt 中）。**本阶段不同步消息，所以这个坑没有被触发，但以后启用时必须处理。**
- 创建错误码：`start>end` / `start==end` / 窗口超限 **全都返回同一个 `14004 Timestamp interval limit`**，无法区分。
- **不存在的企业 `code` 同样返回 200 + 一个正常的 key**（完全不做校验）。
- 用相同参数重复创建**可以无限重复**：实测用相同参数连续创建 8 次全部成功，返回 8 个不同的 key，但内部导出 id 是同一个（`7000001`），数据**逐字节完全相同**。→ 服务端按（企业，窗口）复用已计算的结果。
  **⚠️ 去重必须按 `session.id` / `message.id`，絕不能按导出任务 key。**

#### 文件格式（与预期不同）

- **JSONL**（每行一个完整 JSON 对象），**不是 CSV/TSV**；UTF-8 无 BOM；LF；无表头
- **⚠️ 文件末尾有一行非 JSON 的尾部标记行**：`startTime=...,endTime=...` —— **解析时必须跳过它，否则会报错**
- `session.txt`：**93 个字段**（74 个恒存在 + 19 个条件存在）
- `message.txt`：25 个字段（本阶段不同步）

#### 字段陷阱

| 陷阱 | 说明 |
|---|---|
| **`categoryId` 是接待坐席组 ID，不是咨询分类** | 已验证：1414 个 `categoryId` 非零的会话中，**1414/1414 都命中了坐席组表**（`/openapi/v2/staff/group/list/new`），零例外。因此它是 **`staff_groups.id` 外键**，不是分类。看起来像「一个 `categoryId` 对应 60 多个分类」，只是因为一个组承接了很多叶子分类。→ **不要拿它去关联知识库分类树**；要关联 `staff_groups`。 |
| **`categoryDetail` 才是咨询分类（4 级）** | 与 `categoryId` 无关。格式是以 `" / "` 分隔的 **4 段**，只有两个单段哨兵值例外。⚠️ **哨兵值是中文字面量，不是英文**：`未分类`（**2301 行** —— 机器人 **1656**、人工 **616**、内部 **29**）和 `无效会话`（**1545 行**，**仅机器人**）。二者合计恰好覆盖全部 3846 个单段 `categoryDetail` 值。**两个都必须按字面量精确匹配** —— 用 `"Invalid session"` 这种英文去匹配会命中 **0 行**，哨兵值就会悄悄变成最大的分类。**这才是用来回答「客户在问什么」的字段** —— 它也正是报表接口所缺失的那套分类体系（§1）。 |
| **`categoryId=0` 不是一回事** | 有 3273 行 `categoryId=0`，但它们按会话类型分开：**机器人会话 3198 行**（机器人会话没有接待组）、**人工会话 68 行**、内部 7 行。而且 `categoryId=0` 下的 `categoryDetail` *并不*总是 `未分类` —— 它也承载 `无效会话`（1545 行中的 1543 行）以及 **6 行带有真实 4 段路径**。→ **不能把 `categoryId=0` 读成「未分类」**；要读 `categoryDetail`。 |
| **`categoryDetail` 有两种格式** | 在导出里是 `" / "`（**带空格**），在 `/one` 里是 `"/"`（无空格），而且实测同一个会话两者不相等 → **落库前必须归一化**，否则 JOIN 会失败 |
| 时长字段是字符串 | `sessionDuration` 形如 `"00:01:12"` 或 `""`，不是数字。**⚠️ 那 3230 个空值不是随机缺失，而是结构性空值 = 机器人会话数（3201）+ `staffId=-1`（29）**，见下一节 |
| 机器人 staffId 为负 | 实测 `-1000002`/`-1000003`/`-1000004`/`-1000001`，外加 `-1`，它对应空的 staffName；正的 staffId ↔ staffName 严格一一对应 |
| `treatedTime` 全是 0 | 无信息；不要用它 |
| `evaluationType` 恒为 4 | 无区分度 |
| 当 `/one` 不存在时 | **返回 `{code:200, message:"success"}` 且没有 `data` 字段** → 信封层必须把「200 但没有 data」当作 `not_found` |

#### 机器人会话占 68%（实测；请重新估算容量假设）

**`/openapi/export/session` 从单一数据源同时覆盖两种会话类型；不需要第二个数据源。** 实测（1 天窗口，4687 行，已独立复现）：

| 类别 | 行数 | 占比 |
|---|---|---|
| **机器人会话**（`staffId < 0 且 != -1`） | **3201** | **68.3%** |
| 人工坐席会话（`staffId > 0`） | 1457 | 31.1% |
| `staffId == -1`（第三类，见下文） | 29 | 0.6% |

**机器人会话是主体，不是边缘情况。** 所有基于「人工坐席会话占主导」做的容量和表设计假设，都必须重新估算。

**而且机器人会话不是「转人工之后剩下的残渣」**：这 3201 行中有 **1907 行（59.6%）的 `closeReason=1`，意味着从未被转出** —— 这些是纯机器人会话。

**`session_type` 判别字段（有三个字段可用，但只有一个是精确的 —— 选 `staffId`）**：

| 字段 | 规则 | 机器人取值 | 人工取值 | 精确？ |
|---|---|---|---|---|
| **`staffId`** | **`<0 且 !=-1` → 机器人**（推荐） | 负的 robotId | 正整数 | ✅ **精确，而且是唯一还能把 `internal` 单独隔离出来的字段** |
| `interaction` | `==1` → 机器人 | `1` | `0` | ⚠️ 能区分机器人和**非**机器人，但**分不出 `human` 和 `internal`**（两者都是 `0`） |
| `staffName` | `=="机器人"` | `"机器人"` | 人工坐席真实姓名 | ⚠️ **对机器人 vs 非机器人是精确的，但字面量是中文** —— 见下文 |

> **⚠️ 机器人的 `staffName` 字面量是中文词 `"机器人"`，不是 `"Robot"`。** 实测：全部 3201 行机器人中**恰好只有 1 个不同取值**，长度为 3，等于 `机器人`。本表的早前版本写的是 `=="Robot"` —— **实现者若写成 `staffName === "Robot"` 会命中 0 行，并把每个机器人会话静默归类为人工。** 代码里绝不能出现这个英文拼写。
> 这是 API 返回的字面量，所以按开头说明里的约定，它在本文档中保持原样 —— 把它翻译过来正是造成该错误的原因。

> **⚠️ 「三个字段等价」这个说法太强了。** `staffId` 是唯一精确的判别字段：它是唯一一个取负后也能得到 `robotId` 的字段（已验证：4 个不同的 `-staffId` 取值是知识库中 5 个 robotId 的子集，0 例外），也是唯一能把那 29 行 `internal` 与 `human` 分开的字段。`interaction` 和 `staffName` 都会把 `human` 和 `internal` 塌进同一个桶（`interaction=0`、`staffName=""`）。

**⚠️ `staffId < 0` 不等于机器人 —— 必须排除 `-1`。** 实测，那 29 行 `staffId=-1` / `staffName=""` / `interaction=0` 是**企业内部员工会话**（`sType` ∈{2,3}、`relatedType=1`、`userTags` = employee/manager）；把它们误标会污染机器人统计。

**⚠️ 不要用 `sType` 作判别字段**：实测 `{0:4613, 2:1, 3:28, 4:45}`，与机器人/人工**不相关**（全部 3201 行机器人都是 `sType=0`，而且有 1412 行人工也是 `sType=0`）。`sType=4` 是企业微信渠道，`sType=3` 是员工会话。

**⭐ `staffId = -robotId`，可直接反推**（实测，与 §11.3 的 robotId 表一致）：

| staffId | robotId | 机器人 | 1 天会话数 |
|---|---|---|---|
| -1000003 | 1000003 | 机器人 C | 1599 |
| -1000002 | 1000002 | 机器人 B | 1421 |
| -1000004 | 1000004 | 机器人 D | 157 |
| -1000001 | 1000001 | 机器人 A | 24 |

→ **`sessions` 表不需要额外的映射表**。注意在导出中 `staffName` 永远是那一个字面量 `机器人`（它不含具体机器人名），所以要拿到机器人名必须按 `-staffId` 关联；对 `staffName` 建索引在机器人侧没有区分度。

#### 在机器人会话上没有区分度的字段（不要为它们建索引或做聚合）

**机器人侧有两种不同的退化，把它们混为一谈统称「总是为空」会写出错误的查询：**

**A. 25 个字段在 100% 的机器人行上确实为空**（在全部 3201 行上重新推导）：

`assistStaffIdList` · `description` · `evaluationRemark` · `externalEscrowId` · `externalUserId` · `fromStaff` · `humanTransferSessionId` · `intelligentEvaluationBasis` · `intelligentEvaluationResults` · `noneOneOffSessionIdList` · `oneOff` · `overflowCondition` · `overflowFrom` · `overflowRuleName` · `preQueue` · `queueDuration` · `satisfactionTags` · `searchKey` · `sessionDuration` · `staffAccount` · `staffReceptionDuration` · `transferFromGroup` · `transferFromStaffName` · `transferRemarks` · `transferType`

**B. 另有 6 个字段在每一行机器人上都存在，但只带一个恒定值** —— 它们**不是 NULL**，所以 `IS NULL` 检查找不到它们：

| 字段 | 机器人：不同取值数 | 人工：不同取值数 |
|---|---|---|
| `avgRespDuration` | **1** | 1288 |
| `staffFirstReplyTime` | **1** | 1296 |
| `firstReplyCost` | **1** | 1286 |
| `staffMessageCount` | **1**（恒为 `0`） | 38 |
| `fromHumanTransfer` | **1** | 2 |
| `fromGroupId` | **2** | 12 |

> **⚠️ 本表的早前版本把 `avgRespDuration`、`staffFirstReplyTime`、`firstReplyCost`、`staffMessageCount`、`fromGroupId` 和 `fromHumanTransfer` 列为在机器人侧「100% 为 null」。那是错的 —— 这六个字段实测的 null 率都是 0%。** 它们是恒定值，不是不存在。这个实务差别很重要：设计建议（「不要聚合它们」）不变，但写成 `WHERE avgRespDuration IS NULL` 的查询会返回 **0 行**，而一个按 null 过滤的报表会在人工口径的窗口里悄悄把机器人算进去。

> **⚠️ `staffMessageCount=0` 对机器人恒成立，但机器人确实会回复**（`/one/message` 实测，返回 6 条机器人回复）。在机器人会话里这个字段**不是「有没有说话」，而是没有意义** —— 这是恒定值陷阱最清楚的例子，而它按原样成立。

**有两个字段*近乎*为空，必须按「近乎为空」对待，而不是当作布尔值**：`fromGroup`（机器人侧 99.9% 为空，人工侧 4.7%）和 `worksheetIds`（机器人 99.9%，人工 97.0%）。给出人工侧的比率，是为了让共用查询能对两边都做合理性检查。

**机器人侧独有的信号**：
- **`closeReason` 的取值域完全不同**。机器人 `{1,33,38,42,46,48,34,35,30,7,51}`；人工 `{0,8,1,2,7,5,4,3}`。`33` 在机器人侧出现 974 次（转人工的主要出口），在人工侧出现 0 次
- **⚠️ 两个取值域都没有文档记载。** 整套文档里唯一有记载的枚举属于**人工**会话（`接收会话结束通知`）：`0-客服关闭；1-访客离开页面失效关闭；2-访客离开超时关闭；3-访客申请其他客服关闭；4-网络差客服掉线关闭；5-客服转接关闭；6-管理员接管关闭；7-访客主动关闭；8-系统关闭，静默超时关闭；9-系统关闭，静默转接关闭；10-访客未说话；11-访客排队超时清队列；12-访客放弃排队；13-客服离线清队列；16-系统关闭会话；其他-机器人转人工` —— 它**不包含 `46`**。机器人会话的 `closeReason` 在 `robot/session/close` 中只有一句两个取值的说明：`关闭机器人会话原因，1-访客离开 30-访客主动转人工`。**所以 11 个机器人取值中有 9 个（以及主导出口 `33` 的含义）只能靠实测得知**；注册表必须携带实测取值集合，绝不能按任何有文档的列表去校验 `closeReason`
- **`transferRgType`（转人工规则名）只出现在机器人侧**：40.4% 的机器人行有值，**100% 的人工行为空**。它与 `closeReason=1`（纯机器人）完全互斥 —— 实测交集为 **0** —— 而在 1294 行 `closeReason!=1` 的机器人行中恰好有 **1** 行缺少它（那一行的 `closeReason=7`）
- **`category` 对机器人几乎没有信息量**：只有 2 个取值，都是哨兵值 —— `未分类`（1656）和 `无效会话`（1545）；人工侧有 89 个不同取值

**机器人 → 人工的关联**：在 1294 行 `closeReason!=1` 的机器人行中，**有 1253 行的 `relatedId` 指向同一次导出中的人工会话**；反过来，1457 个人工会话中有 1262 个的 `startReason="转自机器人"`（字面量是中文，见上文 `staffName` 的警告）。**⚠️ `relatedId` 不保证能解析到人工会话**：剩下的 41 行分成**27 行指向 `internal` 会话和 14 行悬空**（同一次导出中没有匹配行）。因此写成 `ON robot.relatedId = human.id` 的 JOIN 会**静默丢掉 1294 行中的 41 行** —— 这个关联必须带类型，不能想当然。

#### 机器人会话的可获得性（2026-09-30 更正）

**早前「会话历史页面没有机器人会话」的结论是错的。** 实际情况：

- **在管理后台可见**：`Online Customer Service → Session History`（`/madmin/session/history`）上的会话类型下拉框**有两个条目：Human Sessions（默认）/ Robot Sessions**。默认是「Human Sessions」，这就是机器人会话乍看之下看不见的原因 —— 也是早前误判的成因（旁边那个「会话开始来源」筛选器被当成了会话类型）。
- 切到「Robot Sessions」后实测**总数 ≈ 1490**，列包括 `Receiving agent`（值 = 机器人名称）、`Transfer source robot`、`Transfer destination robot`。点击会话 ID 会在右侧打开详情面板，含完整对话时间线 + 客户资料。
- **机器人后台 `/aiP/` 本身没有会话详情**：它的菜单只有 数据报表（8 项聚合）/ 知识运营 / 知识库 / 词库 / 设置；「数据概览」只给聚合数字。

**✅ 已解决**：`/openapi/export/session` **完整包含机器人会话**，从单一数据源覆盖两种类型，不需要第二个数据源（见上一节的实测）。

**⚠️ 未解决**：机器人会话和人工坐席会话的**字段集合不同** → `sessions` 表必须携带 `session_type` 并按类型分支；不能用一张表硬塞两种语义（见上一节的 null 率表）。

**`/one` 对机器人会话有效**：它返回 89 个字段，比人工坐席会话**少 6 个**（`userPhone`、`userCrmInfo`、`oneOff`、`level2Category`、`level3Category`、`level4Category`），**多 1 个**（`overflowRuleName`）；`/one/message` 同样有效。

#### 有价值的字段

- **分类**：**4687 行中有 841 行（17.9%）**在 `category` 中带有真实分类；**这 841 行全是人工会话**，因此在人工子集内真实分类率为 **57.7%（841/1457）**。→ `GROUP BY category` 能回答「客户在问什么」，但**必须先排除两个哨兵值并过滤到人工会话**
  > **⚠️ 这个结论只在人工坐席会话子集内成立。** 一旦把机器人算进全集，两个哨兵值 `未分类`（1656）+ `无效会话`（1545）就会**膨胀成前两大桶**（机器人侧的 `category` 只有这 2 个取值）。→ **要回答「客户在问什么」就必须加 `WHERE session_type='human'`**。
- **评价**：`evaluation`（`0` 未评价 4536 / `100` 136 / `-1` 9 / `1` 4 / `75` 1 / `25` 1）；定性反馈还有 `evaluationRemark`（客户手写）和 `satisfactionTags`（列表）
- **`/one` 有 14 个独有字段**：包括 `level1Category`（顶级分类！）、`agentSensitiveWords`、`customerSensitiveWords`、`responseTimeout`、`firstResponseTimeout`、`robotHosting` 等 —— 导出里拿不到，所以单条查询路径值得利用
- 渠道 `fromType` 实测有 4 个取值：`web` / `wx_sdk` / `wx_cs` / `ios`
- 关联工单 `worksheetIds`（4687 行中有 47 行有值）

#### 限制

- **平台电商版**要求访问时间在**每天凌晨 2 点到 6 点之间**（来源：`doc-437069.md`）；**非平台版没有这种限制**（`doc-437023.md`，「访问时间没有限制」）。测试账号是**非平台版，所以任何时间都能创建**。
- 文档中「相同参数 24 小时内只能并发调用 1 次」**未能复现**：实测相同参数可以无限次重复创建。
- **并发上限无法测出**：一次队列饱和测试跑满 600 秒，创建了 **274** 个任务，始终没有触发 `Too many running task`（累计 300+；唯一的拦截是 `create too fast`）。这个错误确实存在（早期密集创建时触发过一次），但阈值非常高，或者与队列积压深度有关。
  **设计既不能假定并发=1，也不能靠并发上限做流控** —— 唯一可靠的流控是每 10 秒 6 次的创建限频。
- 文档中「`/one` 限频每秒 5 次」**未能复现**：实测 50~80 请求/秒没有触发 `14009`。仍建议按每秒 5 次节流（高并发下会出现 SSL EOF，说明连接层有压力）。
- 这 4 个接口**不在官方 150 个接口的清单里**，必须单独编入注册表。

#### 回补成本（已更正）

一年 = **61 个六天窗口**（原先估算为 183 个两天窗口）。但**队列是串行放行的**：实测 13 个任务平均每个 25~35 秒 → **总耗时 ≈ 任务数 × 30 秒**，所以一年回补大约 **30 分钟**。

它必须设计成**可中断、可续跑、有进度输出**（进度走 stderr），支持 `--until` 分段。**绝不能阻塞 Agent。**

### 7.6 调度

用户要求「支持**配置**定时同步任务」。**不要做守护进程**（崩溃重启、日志轮转、单实例锁、信号处理都不在范围内）。

```bash
qiyu sync install --schedule "*/30 * * * *"   # 生成并安装系统计划任务
qiyu sync uninstall
```

写入系统调度器之前**必须先征得用户确认**。跨平台支持：

| 平台 | 机制 |
|---|---|
| Linux | systemd timer（首选）/ crontab |
| macOS | launchd plist（首选）/ crontab |
| Windows | 任务计划程序（schtasks） |

`install` 默认**空跑并打印将要写入的内容**；必须加 `--yes` 才真正安装。

## 8. 查询接口与沙箱

> **E 阶段：✅ 已交付（2026-10-17）** —— 落点在 `src/query/`（三层只读沙箱、默认脱敏、错误分派、
> 表查询构造、指标目录）与 `src/commands/{db,query,stats}.ts`。本节的三层沙箱、脱敏默认开启、
> `-1` 哨兵呈现均按下述设计实现；实现期的两处修正记录在
> `docs/superpowers/specs/2026-10-17-查询接口与沙箱-design.md`：①`EXPLAIN ANALYZE` 会真正执行
> 内层语句，沙箱额外拒绝带 ANALYZE 的 EXPLAIN；②DuckDB 行注释在 `\r` 也终止、块注释可嵌套，
> 词法剥离必须按深度而非首个 `*/`。

```bash
qiyu db tables                    # 本地表清单 + 粒度 + 行数 + 数据时间范围
qiyu db describe <table>          # 列名、类型、单位、枚举值、是否可空
qiyu query --sql "SELECT ..."     # 只读
qiyu query --table sessions --since 30d --group-by session_type
qiyu stats fields <report>        # 指标自描述（单位/取值范围/higher_is_better）
```

### 8.1 为什么需要 `db tables` / `db describe`

Version 1 的致命缺口：Agent 写 `SELECT ... FROM staff_satisfaction`，但**没有任何命令能告诉它表名或列名**。表名靠猜 → 5 到 10 轮试错。

基于 DuckDB 的 `information_schema` 实现；开销可以忽略不计。

### 8.2 `--sql` 沙箱（三层防护，一层都不能少）

**仅靠字符串匹配拒绝非 SELECT 远远不够。** 在一个未加防护的 DuckDB 上对线上 API 实测验证，以下语句**全部执行成功**：

| 攻击 | 实测结果 |
|---|---|
| `COPY t TO '/tmp/x.csv'` | 文件被创建 |
| `SELECT * FROM read_csv('/etc/hosts')` | 内容被读取 |
| `SELECT * FROM read_text('/etc/passwd')` | 内容被读取 |
| `SELECT * FROM glob('/etc/*')` | 目录被列出 |
| `ATTACH '/tmp/a.db' AS a` | 文件被创建 |
| `EXPORT DATABASE '/tmp/exp'` | 目录被创建 |
| `INSTALL httpfs` | 成功 |
| `SELECT * FROM read_csv('http://127.0.0.1:18080/x')` | **SSRF 实证：本地 HTTP 服务器收到了请求** |
| `SELECT 1; DROP TABLE t` | **每条语句都被执行，表被删除** |

官方文档也明确写道："Treat SQL in DuckDB like code in Bash or Python."

**三层防护**：

| 层级 | 措施 | 实测效果 |
|---|---|---|
| 1. 语句类型白名单 | `extractStatements()` 取语句数 + 对 `prepare(i).statementType` 做白名单 | 拦住多语句、`WITH..INSERT`、`COPY`(11)、`ATTACH`(25)、`EXPORT`(16)、`INSTALL`(21)、`SET`(20)、`CALL`(19) |
| 2. 文件系统沙箱 | 每个连接执行 `SET enable_external_access=false` + `SET lock_configuration=true` | **整套攻击面全部拦住**（含 read_csv/read_text/glob/COPY/ATTACH/EXPORT/INSTALL/SSRF） |
| 3. 只读事务 | `access_mode=READ_ONLY` | 拦住库内 DDL/DML |

**实测出的三个坑**：
1. `enable_external_access` **不会持久化**；进程重开后恢复为 `true` → **必须在每个连接上设置**
2. **单靠 `access_mode=READ_ONLY` 完全不够**——在 READ_ONLY 下实测，`COPY TO` 依然能写文件，`read_csv` 依然能读
3. `PRAGMA database_list` 被报告为 SELECT 类型，会绕过第 1 层 → **第 2 层才是必需的兜底**

## 9. Agent 契约

### 9.0 信封特例（实测，必须硬编码）

`code` 不是唯一的错误码字段名，数据也不总在 `data` 里。**经实测确认的特例**：

**维度表与工单两个域共实测出 4 种信封形状**（13 个接口全测）：

| 形状 | 接口 | 数据位置 | 二次解析 |
|---|---|---|---|
| **A** `{code,message:"OK",data}` | `staff.list`、`staff.group.list`、`staff.group.members`、`evaluation.setting.get`、`robot.evaluation.setting`、`robot.statistic.summary` | `data` | 否 |
| **B** `{code,result,message:"success",total:0}` | `tag.all` | **`result`** | 否 |
| **C** `{code,message:"<JSON 字符串>"}` | `category.list`、`online.session.category.list`、`ticket.template.list`、`ticket.template.fields`、`ticket.filter.list`、`ticket.filter.count`、`ticket.search`、`session.user.profile` | **`message`** | **是** |
| **D** `{code}` — **只有 `code`，没有 `message`，没有 `data`** | `robot.session.msgAssociate`、`robot.transfer.config` | 无（纯确认） | 否 |

> **⚠️ 形状 D 曾被记为 `ticket.new.detail` / `ticket.log` 返回 `{code,data}`（无 message）。** 这两个接口后来实测返回的是 **`{code,message}`**（失败路径返回 `14106 Invalid worksheet`），而唯一观测到单独返回 `code` 的接口就是那两个无需鉴权的机器人端点。注册表必须以**精确的顶层键集合**为键，而不是以"是否有 `message`"为键。

> **⚠️ `code:200` 且 `message` 为纯文本、没有 `data` 时，与成功无法区分。** 在三个接口上实测——`kefu.v2.query` → `{code:200, message:"OK"}`、`robot.data.queryStandardByEffectiveQuestion` → `{code:200, message:"success"}`、`ai.knowledge.getDetail` → `{code:200, message:"success"}`。**其中第二个和第三个是 `not_found` 响应；从返回体里根本无从分辨。** 这正是下面 §9.0 规则是*注册表查询*而非启发式判断的原因：只有注册表知道某个接口是否可能合法地返回无数据。
>
> **⚠️ 本句对 `kefu.v2.query` 的暗示（"只有后两个是 not_found"）与下方专表冲突，以专表为准（2026-10-04 记录）。** 本句把 `kefu.v2.query` 与另外两个并列却只说"第二个和第三个是 `not_found`"，读者会得出"第一个（`kefu.v2.query`）是正常成功"的结论。但下方 §9.0 专门为 `kefu.v2.query` 开的「有三种结果，不是两种」表格，以及对真实/合成 id 的实测，把它的 `{code:200, message:"OK"}`（无 `data` 键）与 `{code:200, message:"OK", data:{}}` **都列为 `not_found`**；§9.0 表头也把它记作"同一端点上有三种不同的『什么都没查到』编码"。**三处（专表、实测、表头）对一处（本旁注），以专表为准**：`kefu.v2.query` 的无载荷报文是 `not_found`，不是成功。本旁注是 §9.0 全表中唯一说它是成功的说法。

**坑**：`staff.list` 的 `message` 字面量就是 `"OK"` —— **不能统一按"message 永远是 JSON"处理**。`tag.all` 的 `total` 永远是 0（24 个标签仍然返回 `total:0`）—— **不可用**。

**⭐ 真正的判别依据不是键集合，而是 `message` 能否解析为 JSON。** 对全部 28 个返回 `code:200` 的白名单接口重新推导（2026-09-30）：仅 `{code,message}` 这一形状就分裂成**五**种——`message` 是 JSON **对象**（10 个接口：`statistic/*` 全部、`data.overview.session`、`robot.data.knowledge`、`robot.data.kpoint`、`ticket.search`）、是 JSON **数组**（`category.list`）、是 JSON **数字**（`ticket.filter.count` → `"0"`）、是纯文本 `"OK"`/`"success"`（`kefu.v2.query`、`robot.data.queryStandardByEffectiveQuestion`、`ai.knowledge.getDetail`、`robot.data.queryStandardQuestionList`）、以及完全缺失（那两个机器人端点）。**只按键集合分支的解析器，这五种里会错四种。** 注册表必须按接口 id 记录解析策略，正如下面的规则所述。

**⚠️ 报表域实测出第 5 种形状**（183 次探测，10 个报表接口）：

| 形状 | 接口 | 数据位置 | 二次解析 |
|---|---|---|---|
| `{code,message:"<JSON 字符串>"}` | `statistic.overview`、`staffworklod`、`staffquality`、`staffAttendance`、`satisfaction.report`、`salaryDetail`、`performance`、`data.overview.session`、**`data.overview.ipcc`** | **`message`** | **是** |
| `{code,message:"success",data}` | `robot.statistic.summary`（**data 是对象**）、`ai.statistic.transferHuman`（**data 是数组**） | **顶层 `data`** | **否** |

> **⚠️ 在形状 C 的端点上，`code:200` 并不意味着 `message` 能解析。** 这一族的每一个错误也都返回 `code:200`，配一段**纯文本**的 `message`（`14501 (endTime - startTime)/millsADay > 31 is invalid`、`14004 Not found param`、`14009 api call too frequent`）。→ **解析器必须对 `message` 做 try-parse，并把解析失败当作错误，永远不要假定 `200` 就意味着返回体是 JSON。** 这是上面 `kefu.v2.query` 案例在报表域的孪生情形。

→ **在同一个报表域内，这两种形状是混用的。** 唯一的判别方式是在注册表里按接口 id 查询——而不是看路径前缀（`/openapi/statistic/*` 全是形状 C，但 `/openapi/robot/statistic/summary` 和 `/openapi/ai/statistic/transferHuman` 是形状 A）。

**其他已确认的特例**：

| 接口 | 数据字段 | 说明 |
|---|---|---|
| `robot.session.msgAssociate` | `data` | **文档说 `error_code`，实测是 `code`** —— ⚠️ **并不是"整个站点唯一的笔误"**，这个说法可以被证伪：单在一个探测组内，`msgPredict` 对自己的 `code`/`message` 描述错误、`robot/evaluation/setting` 把 `robotId` 的描述复制给了 `fromType`、`close` 把 `sessionId`/`userId` 的描述对调了。真正独一无二的是缺陷的**种类**——响应 schema 里的键名写错。**文档必须从返回体重建，不能当作规范来读。** 另外：`{code}` 是这个端点的 **not-found** 路径，而不是它唯一的路径——命中时返回 `{code,data}`，`data{content,questionList,robotId}`，`questionList[]={id,question,type}`（其中的 `id` 无文档） |
| `kefu.v2.query` | 无 | **同一端点上有三种不同的"什么都没查到"编码** —— 见下方区块 |
| `chat.queue.group.query` | `staffInfo` | **`{code, staffInfo}` —— `message` 在*失败*时出现，在*成功*时反而缺失**（实测集合里唯一有此倒置的接口）。空的 `staffInfo`（`[]`）是正常的"无人在线"状态，不是错误：24 个真实组中有 15 个返回 `[]` 且 `code:200` |
| `ipcc.customfield.template.get` | 无 | **裸 JSON 数组，完全没有 `{code,message}` 信封** → 解析器必须先看第一个字符 |
| 通话记录 `history.seat` / `history.team` | `message` | JSON 字符串，分别解析为**数组**（35 个字段）/ **对象**（55 个字段） |
| `smstask.status` | `message` | **`{code,message}`，其中 `message` 是 JSON 数组字符串——成功路径上也是如此**（未知任务 id 返回 `{code:200, message:"[]"}`）。二次解析是强制的，而该端点此前漏在信封表之外 |
| `online.session.customfield.template` | `message` | 形状 C，且厂商 schema 在约 6 处有误：`templates` 是**列表**而非对象（120/120），`sessionInfo` 的备注键是 **`remarks`**（不是文档里那个被选项卡包裹得面目全非的字符串），`sessionInfo.category` 是**对象或 `null`**，`historyFieldValues[].fieldValue` 永远是 **str**（文档说是对象），`assignFields[].fieldId` 是 **int**（878/878，文档说是字符串）。系统行（`system=1`）的 `id`/`type`/`description`/`required`/`valueEditable` 全为 `null`。⚠️ **工单的 `connectionId` 可直接用作 `sessionId`** |
| 知识库 6 个接口（`robot.data.getQuestionsByCategoryName`、`queryStandardByEffectiveQuestion`、`queryStandardQuestionList`、`ai.knowledge.getCategoryTree`、`search`、`getDetail`） | **`data`** | **形状 A：`{code,data,message}`，且 `data` 是裸数组或裸对象** —— 这 6 个接口此前**都没有登记进信封表**。⚠️ **其中 3 个在 `not_found` 时会整个丢掉 `data` 键**（`queryStandardByEffectiveQuestion`、`getCategoryTree` 空树、`getDetail`），返回 `{code:200, message:"success"}`，与成功无法区分。⚠️ **厂商对这一个模块的响应 schema 系统性地多套了一层**：5 个接口文档写 `data.data[...]`，实际是 `data` 直接就是数组/对象 —— **照文档生成的客户端会在每次调用上都失败** |
| `online.session.category.list` | `message` | 形状 C，解析为**嵌套树**（253 个节点，3 个根），键恰好为 `{id,name,children}`。⚠️ **`children` 在全部 253 个节点上都存在，但在那 177 个叶子上为 `null`** —— 写成 `for c in node["children"]` 会抛 `TypeError`。厂商文档把它标注为 `array<string>`。对比 `category.list`，其返回体是**扁平**的，带 `parentId` |
| `evaluation.setting.get` | `data` | 形状 A，但 **`fromType` 从不做枚举校验** —— 传入未知值（`"qq"`、`""`，甚至整数 `4`）都会静默返回 `code:200` 以及 **WEB** 配置。真实渠道集合 ≥6 且大小写不敏感（`iOS android WEB wx wx_ma wb` 外加一个无文档的 `Facebook`），`list[]` 项还带有无文档的 `commentRequired`/`tagRequired`。缺失 `fromType` 会返回 **`14500 Internal Error, retry later`**（⚠️ 这条与 §4.3 分派表冲突，见 §4.3 表下的争议注） |
| `robot.evaluation.setting` | `data` | 形状 A；**12 个键对 9 个有文档的键**（多出 `forceEvaluation`、`forceEvaluationRounds`、`pattern`）。`fromType` 只校验**非空**（`14004 Bad json payload`），从不做枚举校验 |
| `session.user.profile` 的 `customField` | — | **非法 JSON（整数键未加引号）** —— 见下方比率 |
| `session.user.profile` | `message` | JSON 字符串解析为**扁平对象** —— 且**厂商关于它的 schema 几乎处处有误**。对 70 个真实会话实测，键为 `id, name, phone, foreignId, forignId, vipLevel?, remarks?, address?, customField?, email?, externalUserId?`：⚠️ **`field125` 不存在**，厂商的 `foreign_id` 实际是 `foreignId`，并且**`forignId`（`foreignId` 的拼写错误副本，值永远与它相同）和 `externalUserId` 都无文档**。**键集合并不固定** —— 70 行里出现了 8 种不同的键集合，因此除五个核心字段外每个字段都是可选的。`vipLevel` 在 62/70 的样例中为 `0`。注册表在这里必须从返回体重建，而不是照抄文档页面 |

> **⭐ `kefu.v2.query` 有三种结果，不是两种**（对真实和合成 id 实测）：
>
> | 输入 | 响应 | 含义 |
> |---|---|---|
> | 存在的 id（含 `status:2` 已禁用员工） | `{code:200, message:"OK", data:{16 个键}}` | found —— `data` 与 `staff.list` 的行逐字段一致，**只少 `groupInfo`** |
> | **任意负数 id**（`-1`、`-5`、`-<某个真实 id>`） | `{code:200, message:"OK", data:{}}` | **`data` 存在但为空** → `not_found` |
> | 不存在的非负 id（`0`、`1`、`424242`） | `{code:200, message:"OK"}` —— **没有 `data` 键** | `not_found` |
>
> → **整个 API 上存在三种不同的"成功但为空"编码，而此前只记录了最后一种**：`data` 键**缺失**、`data` = `{}`、`data` = `[]`（`group.members` 传错误的 groupId；空的 `staffInfo`）。信封层必须把三种都当作 `not_found`/空，而不是只处理键缺失那一种。
>
> **⚠️ 本句与上方 `chat.queue.group.query` 那行（§9.0 表）冲突，以那一行为准（2026-10-02 记录）。** 本句把「空的 `staffInfo`」列为应判 `not_found` 的编码之一，但同一张表里 `chat.queue.group.query` 那行明确写着"空的 `staffInfo`（`[]`）是正常的『无人在线』状态，不是错误：24 个真实组中有 15 个返回 `[]` 且 `code:200`"。**两者不能同时成立** —— 若按本句把空 `staffInfo` 判为 `not_found`，会把 **62%（15/24）的正常响应误报为"查无此物"**，正是 §9.2 要消灭的静默失败，只是方向相反。→ **实现取"不是 not_found"**（`envelope.ts` 的 `staffInfo` 分支返回 `notFound:false`）。本句的"三种编码"里，`data` 缺失与 `data`/`{}`/`[]` 是**通用**规则，而空 `staffInfo` 是**该接口特有**的正常状态，不应并入通用规则。

**规则**：信封归一化层不得假定 `code`/`data`/`message` 是固定组合；它必须**按接口 id 在注册表中查询 `envelope` 字段**来决定解析策略。`code:200` 且无数据字段的，一律当作 `not_found`，不当作成功。

### 9.0.1 实测限频（证伪文档所暗示的普遍性）

**文档中记录的限频并不普遍适用。** 跨 13 个维度表/工单接口实测：**没有任何一个被限频**：

| 接口 | 测试 | 结果 |
|---|---|---|
| `ticket.search` | 并发 50 × 200 次调用 | **200/200 全为 200，零个 14009** |
| `ticket.log` | 并发 20 × 60 次调用 | 60/60 全为 200 |
| 其余 11 个 | 每个并发 15 × 30 次调用 | 每个 30/30 全为 200 |
| `statistic.staffworklod`（对照） | 连续 4 次调用 | `[200,14009,14009,14009]` |

→ **`14009` 只出现在 `/openapi/statistic/*` 报表接口上**（约 30 秒冷却，按接口独立而非全局）。维度表和工单接口**可以并发拉取，无需冷却**。

> **⚠️ 但"`14009` 仅限报表域"这个结论已被证伪（2026-09-30 复测）。** `robot.data.knowledge` **也会返回 `14009`**，消息是 **`Call too frequent, please call later`**（注意与报表域的 `api call too frequent` 是**两个不同的英文串**），而且**冷却长达数分钟**——有一轮实测连续 8 次 `14009`、跨 160 秒才恢复。→ **`14009` 不是报表域专属**；限频判定必须按接口配置，不能按路径前缀推断。
>
> **而且同一个"太频繁"条件，在知识库域内部就用两种错误码表达：**
>
> | 接口 | 错误码 | 消息（逐字） |
> |---|---|---|
> | `robot.data.knowledge` | **`14009`** | `Call too frequent, please call later`（冷却数分钟） |
> | `robot.data.kpoint` | 未观测到 | 突发 6 次全部 200 |
> | `robot.data.getQuestionsByCategoryName` | **`14500`** | `单位时间内请求过于频繁`（约 1/s） |
> | `robot.data.queryStandardByEffectiveQuestion` | **`14500`** | `单位时间内请求过于频繁`（约 1/s） |
> | `robot.data.queryStandardQuestionList` | **`14500`** | `单位时间内请求过于频繁`（约 1/s） |
> | `ai.knowledge.getCategoryTree` | **`14500`** | `单位时间内请求过于频繁`（文档 1/s，**正确**） |
> | `ai.knowledge.search` | **`14500`** | `单位时间内请求过于频繁`（文档 1/s，**正确**） |
> | `ai.knowledge.getDetail` | 未观测到 | 突发 8 次全部 200（文档 10/s，**正确**） |
>
> → **"太频繁"这一个语义，横跨 `14009` 与 `14500` 两个错误码、三条不同的英文/中文消息。** §4.3 要求的"按 `message` 文本分派"因此必须同时覆盖这三种措辞，且**不能只认 `14009`**。
>
> ⚠️ §4.3 里记的 `ai/knowledge/getCategoryTree` "`200 / 14500×3 / 200 / …` 交替"是**间隔决定的假象**：间隔 0.4 秒时确实交替，间隔为 0 时是 `1 次成功 / 5 次 14500`。不要把它当成固定节奏。

### 9.1 输出

```jsonc
// 成功（`meta` 是条件键：有元数据要报时才出现，没有就是 `{ok, data}` 两个键）
{"ok": true, "data": {...}, "meta": {
  "rows": 42, "truncated": false, "limit_applied": 1000,
  "resolved_range": ["2026-09-23T00:00:00+08:00", "2026-09-29T23:59:59+08:00"],
  "data_coverage": {"min": "...", "max": "..."},
  "last_synced_at": "2026-09-30T10:15:00+08:00"
}}

// 失败
{"ok": false, "error": {
  "code": "14009", "kind": "rate_limit", "retryable": false,
  "message": "api call too frequent",
  "hint": "该接口每分钟限 1 次",
  "retry_after": {"seconds": 43},
  "retry_strategy": "switch_to_local",
  "fallback": "qiyu query --table order_performance"
}}
```

- stdout 只输出 JSON；`--pretty` 用于人类可读（**G1 已实现**：缩进 JSON，写在具体子命令之后；用法错误仍是紧凑 JSON —— 先修参数再看格式）；日志走 stderr
- **退出码**：`0` 成功 · `1` 业务错误 · `2` 用法错误 · `3` 网络错误 · `4` 需要 `--yes`
- **退出码 4 必须携带** `confirm_required: true` + `confirm_arg: "--yes"` + `risk: "irreversible"` + `target`，以及 `retryable: false`

> **`retry_strategy` / `fallback` 的交付状态（2026-10-24，G1）**：上面示例里这两个字段**已有生产者** —— `api call` 撞限流（`kind: rate_limit`）且该接口**非危险**、有同步任务映射、本地库文件存在时，输出 `retry_strategy: "switch_to_local"` 与 `fallback: "qiyu query --table <表>"`，并在 `hint` 里点名该接口的其余本地表。三处诚实边界：
> ① **只承诺「有表可查」**，不承诺表非空、更不承诺覆盖调用方要的时间窗 —— hint 要求先 `qiyu db tables` / `qiyu sync status` 确认；
> ② **危险接口不给**（调用方要的是写操作，一个本地读的表名帮不上忙，反而可能被误读成本地也能执行）；
> ③ 无映射 / 库文件不存在 / 探测异常 → **两个键都不出现**（不编一个指向不存在表的命令），原始限流错误原样返回。

> **⚠️ `meta.cached` 已从样本里删掉（2026-10-30 回写）**：它是**承诺过、没有实现**的字段 ——
> 全仓没有生产者（`grep -r "'cached'" src/` 无命中），也没有任何查询缓存。它曾是本节的
> 「成功输出样本」的一部分，读的人会以为每次成功都能读到它、并据此判断数据是不是缓存来的。
> **实际判据**：要判断数据新鲜度看 `meta.last_synced_at` 与 `data_coverage`（这两个**有**生产者）；
> §11.2 错误处理表的 `store_locked` 行同源 —— 缓存能力整体未交付，也从未进入任何子项目的范围。
> 删掉样本里的键，是为了不让一份不存在的契约看起来像存在。
> 实现分层：`commands/local-fallback.ts` 是零依赖注入槽（`api.ts` 只 import 它，保住 auth/api 零 store 加载红线），`commands/local-fallback-wiring.ts` 持有映射与探测，由 `cli.ts` 在启动时接线。

### 9.2 静默失败防护

**0 行是比报错危险得多的失败模式** —— Agent 的错误处理根本不会触发，它会向人类汇报"上周没有满意度数据。"

- `meta` 必须携带 `resolved_range` 和 `data_coverage`
- SQL 中带时间过滤条件却返回 0 行 → 附加一条 `warning`
- 表/列不存在 → 提示中给出候选列表（而不是 DuckDB 的英文原始报错）
- 单位不确定 → 查 `stats fields` 的 `unit`；**绝不要猜百分比还是绝对值**

### 9.3 时区

**所有相对时间都在 `Asia/Shanghai` 下解析**，并且响应回显 `resolved_range`。

> **范围收窄（2026-10-24）**：本节早前写的「可在 profile 中配置」**删除** —— 实现是硬编码 `Asia/Shanghai`，没有任何 profile 键能改它；在配置面声明一个不存在的开关正是「声明了但没人读」。若未来出现真实的多时区需求，应作为独立子项目带三时区测试矩阵交付，而不是顺手加一个没人实现的键。

> Agent 常运行在 UTC 容器里，于是 `yesterday` 解析成 UTC 的昨天，而七鱼的报表使用 Asia/Shanghai 的自然日——8 小时前的数据会被归到错误的一天，**而且不会抛出任何错误**。

### 9.4 名称解析

`--assignee "张三"` → staffId。**必须拒绝歧义**：返回 `kind: "ambiguous"` + `candidates: [...]`；**绝不静默取第一个**（否则 Agent 会在无人盯着的情况下把工单改派给错误的人）。

**对 330 条线上员工记录实测——歧义并非假想，而字段的选择直接决定它是否存在：**

| 字段 | 去重后取值数 | 冲突 |
|---|---|---|
| **`username`** | **330** | **无 —— 唯一无歧义的键** |
| `realname` | 280 | 46 个值被 2–3 行共用 |
| `nickname` | 279 | 44 个值被共用，其中一个值重复 **7 次** |

- **在 `realname`/`nickname`/`username` 三个字段上，共有 89 个不同字符串映射到不止一个 staffId，单个字符串最多对应 7 个候选。**
- → **必须以 `username` 作为解析键。** `realname` 和 `nickname` 是展示名，重名是合理现象；用它们解析会频繁命中 `ambiguous`，CLI 必须列出候选而不是随便挑一个。
- **组名同样有歧义**：33 个组名中有 21 个包含 `/`，所以裸的叶子名可能在多个父节点下撞名 → **组查询必须使用完整的 `/` 分隔路径**，并采用同样的 `ambiguous` 处理。

> **交付状态（2026-10-24 调查结论）**：本节描述的 `--assignee "张三"` 名称解析**尚未实现，且当前无落点**。历史溯源（`git log a800b65` + 2026-09-30 会话记录）：它出自原始设计稿的「阶段 2 语义层」——`qiyu ticket create --assignee "张三"` 这类**工单写命令**。评审裁决「语义层只保留写操作与名称解析」，但工单写命令族**从未进入路线图任何子项目**（A/B/C1/D/E/F 都不含），于是本节成了一个没有宿主的孤立契约。
> → 处置：设计稿保留本节作为**未来规格**，路线图 G2 标注「依赖 ticket 写命令族，随其交付落地」。skill 正文（`ambiguous` 预告）维持现状不删 —— 它描述的是服务端可能返回的 `kind`，与本地语义层是否实现无关。
> → 若要做：必须同时交付 `ticket.create` / `ticket.modify` / `ticket.transfer` 这一族写命令（含 `--yes` 门禁）与本节的解析器，并复用 `staff` 表（`username` 为解析键、`realname`/`nickname` 走候选列表）；单独实现解析器没有任何命令会调用它。

### 9.5 状态码

- `kind: "store_not_initialized"` + 指向 `qiyu store init` 的提示（C1 阶段与 D 交付后**同口径**：修复批 2 裁定不改指 `qiyu sync run` —— `sync run` 首跑虽会自动建库，但「初始化存储」的最小命令是 store init。**E 期架构审查 F1 收窄**：仅「库不存在 / 空库」四处出口（`store status`/`sync status`/`sync verify`/`sync install`）同指 store init；「他人库 / 非 DuckDB 文件 / 依赖未安装」跑 store init 会再次失败，hint 改指成因（换 `--db` 路径 / 装依赖），skill 正文 errors.md 据此让 Agent 按 `hint` 行动）
- `kind: "auth_missing"` + `retryable: false` + 指向 §4.2 的提示
- `kind: "store_locked"` + 说明正在同步的提示（C1 阶段：写进程持锁，无同步概念；D 交付后为同步窗口；**E 起读者进程也会被同步者的 RW 锁挡住** —— 判定在 DuckDB，不在本层）

### 9.6 机器人会话生命周期（实测）

机器人会话不在本版本范围内，但以下事实对"以后启用它们"和"理解会话数据"都很重要：

| 项 | 实测 |
|---|---|
| `chat` 的 `msg` | **必须是对象** `{"msgType":"text","msgBody":{"content":"..."}}`；传字符串 → `14004`。**文档说 `type: string` 是错的** |
| `sessionId` 从哪来 | 由 `create` 返回；或者会话不存在时 `chat` **自动创建一个**并返回它 |
| **`sessionId` 会自己变** | 同一 uid 连续调用 `chat`，**每 1–2 条未命中 FAQ 的消息就轮换一次**（旧会话以 `closeReason=46` 关闭，该值不出现在任何已公布的枚举中——见 §7.5）。**调用方不得缓存 sessionId** |
| 什么会触发轮换 | 命中 FAQ（`ansType=1`）→ **不轮换**；未命中（`ansType=2`/`10`）→ 轮换 |
| 自动关闭 | **访客最后一条消息之后 10 分钟**（实测 605 秒）。`create` 本身不计入"说话" |
| **用 `endTime` 判断会话结束** | **`status` 不是会话开关状态**，而是**人工客服的处理状态**（0 未解决 / 1 已解决 / 2 解决中）。已结束的会话 `status` 可能为 1。**只有 `endTime > 0` 才表示已结束** |
| `robotId` 的符号 | `chat` 返回**负数** `-1000001`，`create`/`msgAssociate` 返回正数 `1000001` —— **同一个机器人两种符号；不能直接比较** |
| `ansType=10`（转人工） | `ansContent` 结构**与其他三种不同**（只有 `msgType`/`msgBody`，不包在 `answer` 里）→ 解析分支必须区分 |
| `msgPredict` 的 `question` | **死参数** —— 无论传什么（包括不传）都返回同一份静态快捷短语列表。这个接口实际上是"获取快捷短语配置"，**不是意图预测**。⚠️ **但 `uid` 是真必需**：缺失或为 `""` 返回 `14004 uid参数不能为空，请检查`。成功信封是 **`{code,data}`，没有 `message`**，与厂商 schema 矛盾，而后者连 `code` 和 `message` 本身的描述也是错的。此处的 `14004` 表示**缺少参数**——该错误码的第三种不同含义（见 §4.3） |
| `assist` 的 `content` | 真必需；省略会抛 `14500` + 一个 Java NPE |
| `assistType=2` | 实测最多 **5** 条（文档说 1–3） |

**⚠️ 本节中的 `create → chat → close → transfer` 链条是设计构想，不是厂商契约。** 阅读这四个写接口各自的文档页（**未调用**它们——它们是写操作）可以看到：

- **`transfer` 不是会话生命周期的终点。** 它的标题是微信公众号机器人切换，请求体是 `{robotId, appId, fromAccount, groupId}` —— 它切换的是微信访客**与哪个机器人**对话。它与会话无关，也与 `close` 无关。四个页面中没有任何一处把它与 `create`/`chat`/`close` 关联起来。
- **有文档的 `close` 契约无法产生本节所依赖的那些值。** `close` 要求 `{uid, closeReason}`，并把 `closeReason` 只记录为 `1-访客离开 30-访客主动转人工`。§7.5 实测出 **11** 个机器人侧取值，包括 `33`（主要退出原因）和 `46`。→ 有文档的契约对 `closeReason` 而言不是一个可用的规范，正如 §7.5 所说；本节也应当这样讲，而不是把这个枚举当作可用信息呈现。
- **10 分钟自动关闭是有文档的，不只是实测的。** `close` 的正文写明 `访客未说话10分钟后自动关闭`；`create` 的正文只说 `访客长时间未说话自动超时关闭`。实测的 600 秒/605 秒是对文档数值的佐证，而不是孤证。
- **本节有三条主张没有任何厂商页面支持，在不做写操作的前提下仍是 UNVERIFIABLE**：`sessionId` 在 FAQ 未命中时轮换、`status` 是人工客服的处理状态（该字段在 `create`/`chat`/`close`/`transfer` 中完全不出现）、以及 `create`/`chat` 之间 `robotId` 符号相反。保留它们，但须标注为"仅实测"。
- **一个值得作为一类问题记录的厂商缺陷**：`close` 的响应**把两个字段的描述对调了** —— `sessionId` 被描述成 `userId` 的含义，反之亦然。这与 `msgPredict` 的 `code`/`message` 描述错误、以及 `robot/evaluation/setting` 的 `fromType` 描述照抄 `robotId` 属于同一族。

**完整会话记录（2026-09-30，`sessionId 90000001`，uid `qiyu-cli-test-081`）** —— 佐证上表中两条关键结论：

```
13:21:43  System     User entered / greeted by Robot A
13:21:43  Robot      How can I help you?
13:21:43  test-081   Return and exchange policy
13:21:45  Robot      Hello, returns and exchanges are free of charge within 7 days of receipt…
13:21:45  test-081   How do I get an invoice?
13:21:46  Robot      Hello, you can request an electronic invoice from the order detail page…
13:21:47  test-081   Delivery coverage
13:21:48  Robot      We currently deliver to most of the country; remote areas take longer…
13:21:49  test-081   How do I use member points?
13:21:49  Robot      Hello, points can be deducted at checkout; 100 points = 1 yuan…
13:21:50  test-081   Customer service hours
13:21:51  Robot      Human agents are available daily from 9:00 to 21:00…
13:31:51  System     Closed
```

- **5 轮问答全部在同一个 `sessionId` 下** → 佐证"命中 FAQ（`ansType=1`）不会轮换 sessionId"
- **最后一条消息 13:21:51 → 13:31:51 关闭，正好 600 秒** → 佐证"访客最后一条消息之后 10 分钟自动关闭"
- **同一 uid 存在多个 sessionId**（实测：`test-080` / `test-082` **各 3 个**）→ 佐证"sessionId 会自行轮换；调用方不得缓存"
- 另一项独立的生命周期测量：以 30 秒间隔轮询，在**第 605 秒** `closeReason` 从 `1` 变为 `2`，且 `endTime` 出现

## 10. 工单域

- 状态：`1` 已提交 / `5` 待认领 / `10` 处理中 / `20` 已关闭 / `25` 已驳回
  > `25` 来自**推送文档**，而非错误码文档（后者只列到 20），不得将其"纠正"掉
- 优先级：API 的 `5/8/10` → `normal/urgent/critical`
- 已知坑：`reply` 的 `attachments` 为必填（默认为填 `[]`）；`reopen` 用 `targetGroup`/`targetStaff`，而 `transfer` 用 `targetGroupId`/`targetStaffId`（统一为 `--to-staff`/`--to-group`）
- `reopen` 的 `targetGroup`/`targetStaff` 在 apifox 中均为 `required: true`，但描述写的是"与 targetGroupId 二选一"（字段名甚至都对不上）→ CLI 自行消化这一矛盾

### 10.1 增量同步（实测，决定正确性）

**必须使用 `opStart`/`opEnd`，而不是 `start`/`end`：**

| 参数组 | 实际过滤字段 | 后果 |
|---|---|---|
| `start`/`end` | **`createTime`** | **漏掉更新** —— 昨天创建、今天关闭的工单取不到 |
| **`opStart`/`opEnd`** | **"窗口内是否有日志"** | **正确**。实测：一个 4 小时窗口内 34 张工单，逐张取日志：**34/34 都有日志落在该窗口内**；反向验证，取 156 张 `modifyTime` 落在窗口 ±1 天内的工单，**0 漏** |

- **必须成对使用**：只传 `start` 会生效；只传 `end`/`opStart`/`opEnd` 会**静默失效**（返回未过滤的全量——实测时为 2,909 张工单）。**顺序颠倒**的一对（`opStart > opEnd`）同样静默失效。
- **窗口上限 ≤90 天**（91 天报 `14004 Time range over limit`）。⚠️ **op 参数对有自己的、不同的报错信息**：`opStart`/`opEnd` 超跨度返回 **`14004 opTime range over limit`**，而不是 `start`/`end` 的那句措辞。两者都要登记。
- **⚠️⚠️`opStart` 的下限是*当前时刻*前约 31 天，而不是 `opEnd` 前 90 天——且超过该下限会静默丢数据。** 于线上二分测定（2026-09-30）：固定 `opEnd = now − 20d`，向下扫 `opStart`：返回的 `total` **饱和**并停止增长：
>
> | `opStart` | `total` |
> |---|---|
> | `now − 28d` | 848 |
> | `now − 30d` | 1,024 |
> | **`now − 31d`** | **1,086** |
> | `now − 32d` … `now − 89d` | **1,086**（完全相同） |
>
> → **`opStart` 实际被钳制到 `now − 31d`。** 窗口回溯更远的请求，返回的行数**不会多于最近 31 天所包含的行数**，而 `total` 看起来正常且**不报错**。→ **把 op 窗口按 89 天切片的同步——而 90 天上限恰恰在诱导这么做——每个切片会少取约 58 天，且永远不会察觉。** **op 窗口必须按 ≤31 天切片。**
>
> 这也意味着 §10.1 最初的支撑性实测无法发现该下限：它使用的 4 小时窗口远在 31 天之内，而"156 张工单、0 漏"的交叉验证有同样的盲区。
- **⚠️`offset`"约 9245 的硬上限"是错的。** 它不是常量——**行会被一直提供到 `total` 为止**。在一个 `total=9362` 的窗口上实测：`offset=9245` 返回 **117 行**，`offset=9360` 返回 2 行。此前那次二分查找（9242 有数据 / 9250 为空）所处的窗口 `total` 恰好是 9228，于是两次探测都越过了末尾，原因与之无关。→ **不存在固定的 9245 之墙，也不存在分页导致的静默丢失。** 窗口切片仍然是对的设计（正是它让同步可续传），但它不再由 offset 上限来论证。
- **`limit` 上限为 500，且 500 被精确兑现**（实测：50→50、51→51、100→100、**500→500**、501→500、1000→500）。厂商文档的"最大 50"是错的；`pageNo`/`pageSize` 被忽略。

**⚠️ 又一个静默忽略（2026-10-01 用真实凭证复测）：`opEnd` 缺省或为 `0` 时，整个 op 参数对被忽略、返回全量。** 实测对照：`{opStart: now-1d, opEnd: now}` → `total` 100，而 `{opStart: now-1d, opEnd: 0}` 与 `{opStart: now-1d}`（不带 `opEnd`）→ `total` 2885（全量）；`opStart = opEnd = now` 的零窗口同样返回 2885。这与上面「只传一个会静默失效」是同一族，但**更隐蔽**：Agent 会以为 `opEnd: 0` 是一个明确的边界，实际拿到的是全量数据，而响应是合法的 `code:200`，信封层拦不住。

**`search` 会静默忽略的参数**（不报错，危险）：`staffId`/`groupId`/`typeId`/`filterId`/`ids`/`keyword`/`orderBy`/`sort`。
**它实际只识别 8 个参数**：`start`/`end`/`opStart`/`opEnd`/`status`/`templateId`/`limit`/`offset`。

### 10.2 工单详情包含非法 JSON（真实缺陷，容错是强制要求）

当 `ticket.new.detail` 的 `follower` 非空时，**键没有引号**：
```json
"follower":{5000004:"Zhang San",5000001:"Some Department-Li Si"}
```
- Python 的 `json.loads` 和 Node 的 `JSON.parse` **都会失败**
- 扫描 1000 张工单：8 张的 `follower` 非空，且**这 8 张全部解析失败**（为空时是 `{}`，这是合法的）
- **`new/detail` 带有 9 个未文档化的键**（`connectionId`、`connectionType`、`foreword`、`fromType`、`holderPlatformId`、`isRichText`、`receiver`、`sender`，外加 `lastFinishTime`），并且 ⚠️ **detail 上不存在 `modifyTime`** —— 因此 §10.3 的 `lastFinishTime == modifyTime` 等价关系无法在该端点上校验，凡是依赖它的地方都必须重新推导。`lastFinishTime` **仅在 `status=20` 时出现**（status 为 20 时 119/119 存在；status 为 10 时 0/30 存在），印证了 §10.3。
- `/openapi/session/user/profile` 的 `customField` **有同样的缺陷** —— 且比例远高于此前"4 个样本中 3 个"所暗示的水平：在 70 个真实会话上，整个 `message` 字符串有 **28/59 行（47%）解析失败**，并且**这 28/28 行只要把整数键加上引号就能解析**，即 **`customField` 是失败的唯一原因**。此前那个数字是来自 4 行样本的低估；修正后的比例是 **约 47%**，而不是四个样本中的 75%。
- **修复**：在 `text.replace(/(\{|,)(\d+):/g, '$1"$2":')` 之后再解析
- **影响——此前"约 0.8% 的工单被静默丢失"是低估，且比例与样本群相关。** 在 200 个原始响应体上实测：**27 次失败，且这 27 次全部 `follower` 非空**（非空 follower 的 27/27 都失败——相关性是完全的，而非统计性的）。比例按工单新旧急剧分化：
>
> | 样本群 | 失败数 |
> |---|---|
> | 最旧的工单（`sortBy: ct` 升序） | **27/150 = 18.0%** |
> | 最新的工单（`sortBy: ct` 降序） | **0/150 = 0.0%** |
> | 租户级跨步抽样 | **3/194 = 1.55%** |
>
> → 这种畸形是**历史数据**的产物：近期工单是干净的，较早的则不是。回补历史工单会撞上约 18%；只向前的同步则接近 0%。**因此容错是回补路径特有的正确性要求**，而约 0.8% 这个数字对该路径低估了 20 倍以上。
>
> §10.2 的修复正则 `(\{|,)(\d+):` 修复了 **100%** 的失败（28/28、27/27、3/3），在所有取样中**零个不可修复的案例**。

### 10.3 其他实测坑

| 项 | 实测 |
|---|---|
| `search` 的 `follower` | ⚠️ **并不总是 `"[]"`** —— 早前版本如此声称，这是错的。在 2,500 行上：**2,462 行为 `"[]"`，38 行（1.5%）是真实的 JSON 数组字符串**（`"[<staffId>]"`、`"[<staffId>,<staffId>]"`）。`ticket.list` 表现相同（249/250）。→ **两个 list 端点把 follower 承载为 JSON *数组字符串*；`new/detail` 则承载为*键未加引号的字典*（§10.2）。** 一个概念在三个端点上出现三种编码 —— 解析器必须按端点分支，而不是按字段名分支 |
| `ticket.log` 返回顺序 | **时间降序**，`id` 非升序 → **落库前必须自行排序** |
| `ticket.log` 分页 | **无分页**（`limit`/`pageNo`/`pageSize` 全部被忽略）；每张工单只能全量取 |
| `actionType` | **无法穷举**（抽样到 12 种，`110` 出现过 2 次却未抽到名称）；**同一 `actionType` 的 `info` 内容并不一致**（例如 `25` 有时是完整的"工单状态：由已受理变更为已关闭"，有时只是一个标题为空的"已关闭"） |
| `info[].content` | **自然语言**（`由 X 变更为 Y`）；`info.title` 可为空字符串 —— 实测 **22/410（5.4%）**，集中在 `actionType=20`（14/14 为空）与 `25`（8/26）。此前的"79/311"数字形态对但数值错；`title` 是回复内容，`content` 才是实际正文 |
| `ticket.log` 的 `corpName` | **文档标注为必填，但在 0/177 行上存在** —— 一个文档里有、实际不存在的字段。反倒是六个字段未文档化（`customerSee`、`isEditor`、`worksheetMailBoo` 恒定存在；`attachments`、`nodeName`、`preHolder`、`targetStaff`、`ccList`、`toMailList` 稀疏存在） |
| `ticket.log` 的 `action` 与 `actionType` | **`action` 是给人看的标签，与 `actionType` 并非 1:1** —— 实测 `actionType` 为 2、15、100 时渲染出同一个标签。不要由其一推导其二；而 `actionLang`（177/177 存在）未文档化 |
| 系统哨兵值 | `staffId` 可为 **`-1`**（无处理人），`holderId` 可为 **`-99`**（`holderName="System"`）→ **统计前必须过滤，否则会凭空多出一个 `-1` 号员工** |
| `sessionId` 来源 | **= 工单的 `connectionId`**（在全部 6 张工单上验证）；传工单 `id` 或 `userId` 会报 `14004` |
| `lastFinishTime` | **仅在 `status=20` 时出现**，且**恰好等于 `modifyTime`**（20/20，误差 0）。**⚠️ 500 张工单中有 50 张存在 2 个及以上"关闭"动作 → 只同步它就会丢掉中间的关闭事件** |
| `custom[].value` | **永远是字符串**；单选选项的值**本身又是一个 JSON 字符串**（`{"path":...,"idpath":[...],"id":6000001}`）→ 要拿到选项 ID 必须再解析一次 |
| `nodeInfoList` | 暴露了自动流转规则（`nodeType:"TRIGGER_TASK"`、`nodeName:"自动关闭"`） |

### 10.4"张三昨天处理了多少工单"的定义

可以回答，途径是 `ticket.log`，但**必须把"处理"的定义说清楚**：
1. `search(opStart=昨天, opEnd=今天, limit=500, offset=0..n)` → 昨天有操作的工单
2. 逐张 `log(ticketId)` → 过滤出 `time ∈ 昨天窗口` 的日志行
3. 按 `(operatorId, actionType)` 聚合

**三件必须注意的事**：
- **一个人连续改了 8 个字段 = 8 条 `at=100` 日志** → **必须用 `COUNT(DISTINCT ticket_id)`，而不是日志条数**
- **系统操作会混进来**：`超级管理员`的关闭**大多是自动关闭**（`comment="建议工单同步至 itsm，自动关闭"`、`nodeType=TRIGGER_TASK`）→ **不排除系统账号，`超级管理员`会常年霸榜**
- **自然日必须按 `Asia/Shanghai` 计算**；UTC 容器会差 8 小时

### 10.4.1"客户在问什么"的定义（会话导出的核心价值）

这是报表接口**无法**回答的问题（§1：`category` 在全部 6 份报表中出现 0 次）。它只能从会话导出中回答，正确的字段是：

| 字段 | 含义 | 用途 |
|---|---|---|
| **`categoryDetail`** | 4 级咨询类目，以 `" / "` 分隔 | **这就是答案。** 按它（或其第 2/3 段）分组即可得到问题分布 |
| `category` | 仅叶子名称 | 便于展示；等于 `categoryDetail` 的最后一段 |
| **`categoryId`** | **处理客服组 ID** —— 是 `staff_groups` 的外键，*不是*类目 | 只用于"哪个组处理的"。**绝不要把它关联到知识库类目树** |
| `categoryDetail == 无效会话` | 根本不是类目 —— 该会话无效 | 计算任何分布前**必须排除**。**字面量是中文** —— 匹配 `"Invalid session"` 一个都排除不掉 |

**计算分布时的三个陷阱**：
- **机器人会话（68%）不带 `categoryId`**，其 `categoryDetail` 大多是 `未分类` 哨兵 → **必须决定是否纳入**；纳入会把分布静默稀释到 `未分类`
- **`无效会话`（1545 行，33%）是哨兵，不是类目** → 排除它是强制的，否则它会成为最大的单个"类目"。**要匹配中文字面量**
- **那 4 段并非跨组固定的层级**：某个客服组处理的会话也可以带 `消费者 / ...` 路径（实测）→ **不要假定第 1 段就标识所属组**；那正是 `categoryId` 的用途

**这也正是与知识库的自然连接点** —— 但要留意分类体系不匹配问题（§10.5.7）：知识库的 `categoryInfo` 用的是 **FAQ 类目树**，而会话的 `categoryDetail` 用的是**咨询类目树**。这是两套不同的分类体系，没有共享 ID（实测：两个名称集合仅重合 1 个噪声级名称）。→ **"客户在问 X，但知识库没有覆盖"无法通过关联 ID 来回答**；它需要名称级匹配，CLI 应将其呈现为**带明确注意事项的启发式**，而不是硬关联。

### 10.5 机器人知识库（完整实测遍历：全量拉取 12778 行）

> **本节数据来自一次完整连续遍历**：`/openapi/robot/data/knowledge` 从 `mid=0` 逐页拉到 `isEnd=1`，13 页 × size=1000，共 **12778 行**，与响应中声明的 `total: 12778` **完全一致**。此前"首页抽样"的结论被本节推翻（见下文 §10.5.2）。

> **⚠️ 这些计数会漂移，本节数字于 2026-09-30 重新实测。** 首次遍历记录为 **12762** 行；复测得到 **12778**。差值为 **+34 新增 / −18 删除，全部发生在同一个机器人内** —— 知识库是活的，在 CLI 构建期间被客服编辑着。
>
> | 度量 | 首次遍历 | 2026-09-30 复测 |
> |---|---|---|
> | 总行数 | 12,762 | **12,778** |
> | `type=1` 标准问题 | 3,402 | **3,410** |
> | `type=10` 相似问题 | 9,360 | **9,368** |
> | `connectIds` 行数 | 207 | **206** |
> | 缺失 `categoryInfo` 键的行数 | 1,294 | **1,294**（未变） |
> | `categoryInfo` 条目总数 | 28,764 | **28,783** |
>
> → **下文每一项结构性不变量在新数据上依然成立、零例外** —— `type=1` 的 `refId==id`、`type=10` 的 `refId` 可解析、`md5 == md5(question)`、`COUNT(DISTINCT groupId) == COUNT(type=1)`、无 `groupId` 跨机器人。**数字是计数；不变量才是契约。** 测试必须断言不变量（见 §12），不得把本节任何计数硬编码进去。

#### 10.5.1 三个接口的真实形态

| 接口 | 粒度 | 分页 | 必填 | 响应 |
|---|---|---|---|---|
| **`robot.data.knowledge`** | 知识条目（标准问题 + 相似问题） | **游标**（`mid`+`size`，**上限 1000**） | 无（⚠️ `robotId` **被静默忽略**，见 10.5.2） | `message` 是**JSON 字符串**，需二次解析 → `{total, data[], isEnd}` |
| **`robot.data.kpoint`** | 知识点（知识文档） | 同上 | 无 | 同上。实测 `total=309`，size=1000 一次拉完（`isEnd=1`） |
| `ai.knowledge.getCategoryTree` | 类目树 | 无 | **`robotId`** | `data[]` 嵌套 `children`；实测顶层 15 个节点，129 个节点，深度 3 层 |
| `ai.knowledge.search` | 关键词搜索 | 页码（`curPage`+`pageSize`，**上限 200**） | **`robotId`** | **无 `total`/`isEnd` 字段**；只返回标准问题，见 §10.5.8 |
| `ai.knowledge.getDetail` | 条目详情 | — | **`robotId`+`knowledgeId`** | **`data` 是单个对象，不是数组**。另有 `relatives`（关联问题）与 `similarityList`（相似问题，实测 0–519 条）。⚠️ **`knowledgeId` 只接受标准问 id**：传 `type=10` 相似问的 id 会返回 `code:200, message:"success"` 且**没有 `data`** —— 静默失败，不会自动解析到所属标准问。⚠️ `robotId` 必填但**不校验**：用机器人 A 的 `robotId` 查机器人 B 的 `knowledgeId`，返回完全相同 |

**分页语义（实测，一锤定音）**：

| 探测 | 结果 |
|---|---|
| 省略 `size` / `size=0` / `size=200` | **一律返回 200 行** → 默认 200，上限 1000 |
| `size=1000` | 返回 1000 行 |
| `mid=0` | 从**最小 id** 开始 |
| `mid=<上一行 id>` | 返回**严格大于**该 id 的下一批（`mid=20000106` → 首行 `20000107`） |
| `mid=99999999999`（越过末尾） | `data=[]` + `isEnd=1` |
| 一路拉到末尾 | 13 页累计 **12778 = 声明的 total** ✅ |

#### 10.5.2 知识库是**企业级**的，不是每个机器人一套（推翻上一版本结论）

**完整遍历后的机器人分布**：

| robotId | 机器人名称 | 条目数 | 占比 |
|---|---|---|---|
| **1000001** | 机器人 A（默认） | 4965 | 38.9% |
| **1000002** | 机器人 B | 4081 | 31.9% |
| **1000003** | 机器人 C | 3199 | 25.0% |
| 1000004 | 机器人 D | 528 | 4.1% |
| 1000005 | 机器人 E | **5** | 0.04% |
| | **合计** | **12778** | 100% |

**上一版本为何判断失误**：`/openapi/robot/data/knowledge` 按 **id 升序**返回，而**前 1000 行的首页恰好全部是默认机器人机器人 A** → 只看首页就会得出"该接口只包含一个机器人"。**这是抽样假象，不是事实** —— 实测，随着 id 推进，各机器人**交错出现**，5 个全部覆盖。

**但 `getCategoryTree` 确实完全按 robotId 隔离**（实测：5 个 robotId 得到 5 棵不同的树）：

| robotId | 顶层类目数 | 顶层类目（前 4 个） |
|---|---|---|
| 1000001 | 15 | 类目组 A1、类目组 A2、类目组 A3、类目组 A4 |
| 1000002 | 5 | 类目组 B1、类目组 B2、类目组 B3、类目组 B4 |
| 1000003 | 11 | 类目组 C1、类目组 C2、类目组 C3、类目组 C4 |
| 1000004 | 4 | 类目组 D1、类目组 D2、类目组 D3、类目组 D4 |
| 1000005 | **0** | **返回 `{"code":200,"message":"success"}` 且无 `data`** —— 该机器人没有类目树，但确实有 5 个知识条目 |

→ **两个接口的隔离方式不同，谁也不能由谁推断**：`knowledge` 是企业级全量数据，`getCategoryTree` 按 robotId 隔离。CLI 必须**两者都存**，并明确告知 Agent 两者的定义不同。

**⚠️ `robot.data.knowledge` 静默忽略 `robotId`（实测）** —— 传 `robotId=1000002`（机器人 B，全量 4081 行）与不传，返回**完全相同**：

| 请求 | `total` | 返回的前 100 行的 `robotId` |
|---|---|---|
| `{mid:0, size:100}` | **12778** | 全部为 1000001（机器人 A） |
| `{mid:0, size:100, robotId:1000002}` | **12778** | **仍然全部为 1000001** |

→ **该参数被静默丢弃**：既不报错，也不改变结果。**这是最危险的一类接口行为**（与 §6.3"给时间参数传秒会静默降级"同类）。CLI 必须**在注册表中把该接口的 `robotId` 标记为不支持**，并且在被传入时**自行报错而不是透传** —— 否则 Agent 会以为自己在查某一个机器人的知识，实际拿到的却是全量。

> **⚠️ 但「知识库接口忽略 `robotId`」不能推广到整个域 —— 它是逐个接口不同的，且有两种不同的失败形态。** 对 `robotId` 语义逐个实测（2026-09-30）：
>
> | 接口 | `robotId` 的实际行为 |
> |---|---|
> | `robot.data.knowledge` | **被静默丢弃**（上表）→ 注册表标记为**不支持** |
> | `robot.data.getQuestionsByCategoryName` | **真正生效** —— 用机器人 A 的 `robotId` 查机器人 B 的类目名，返回 **0 行**（4 个机器人两两交叉验证，一律如此）；查自己的类目才返回数据 |
> | `robot.data.queryStandardByEffectiveQuestion` | **真正生效，但缺省会静默退化** —— 传自己的 `robotId` 有返回；**传别人的、不传、传不存在的 id，一律返回 `code:200` 且无 `data`** |
> | `robot.data.queryStandardQuestionList` | **未能验证**（参数组合不明），注册表标为 `unverified`，**不得**标成「已忽略」 |
> | `ai.knowledge.getCategoryTree` / `search` / `getDetail` | 文档要求必填；`getCategoryTree` 与 `search` 实测按 robotId 隔离；`getDetail` **必填但不校验**（用 A 的 `robotId` 查 B 的 `knowledgeId` 返回完全相同） |
>
> → **两种失败形态必须区分**：**「静默丢弃」（`knowledge`）会返回全量数据，看起来像成功**；**「静默退化」（`queryStandardByEffectiveQuestion` 缺省时）会返回空结果，看起来像"没查到"**。后者尤其像正常的空值，Agent 极难察觉。→ 注册表必须逐接口标注 `robotId: supported | ignored | unverified`，并注明**哪一种**静默行为；缺省不可用时 CLI 必须自行报错而不是透传。
>
> ⚠️ **这一节的结论本身被更正过一次**：初版报告称 `getQuestionsByCategoryName` 与 `queryStandardByEffectiveQuestion` 也忽略 `robotId`；重新交叉验证后**推翻**，实为生效。凡「参数被忽略」的结论都必须用**两个不同的取值做 A/B** 才能成立 —— 单取值的"看起来一样"不足以判定。

#### 10.5.3 表设计

```sql
-- 覆盖全部机器人的企业级全量数据
knowledge_items(
  id            VARCHAR PRIMARY KEY,   -- 合成的占位取值区间，见 §10.5.7
  robot_id      VARCHAR NOT NULL,      -- 1000001 / 1000002 / ...
  robot_name    VARCHAR,
  type          INTEGER NOT NULL,      -- 1=标准问题 10=相似问题（见 §10.5.4）
  group_id      VARCHAR NOT NULL,      -- ⭐ 知识实体的真正主键：3410 组 ↔ 3410 个标准问题（见 §10.5.4）
  ref_id        VARCHAR NOT NULL,      -- 相似问题指向的标准问题 id；标准问题自身恒为 == id
  question      VARCHAR NOT NULL,
  answer        TEXT,                  -- 相似问题恒为空（实测 9368/9368）
  inner_answer  TEXT,                  -- 「内部答复」；仅当 faq_type 为 1 或 2 时非空（见 §10.5.5）
  md5           VARCHAR,               -- md5(question)，实测 12778/12778 完全吻合（见 §10.5.4）
  enabled       INTEGER,               -- 1/0，实测 156 条为停用
  faq_type      INTEGER,               -- 0=仅外部答复，1=仅内部，2=两者都有。实测只出现 {0,2}（见 §10.5.5）
  from_type     INTEGER,               -- 0=手工录入，1=欢迎语库，2=文件导入。实测只出现 {0,2}（见 §10.5.5）
  point_id      VARCHAR,               -- → knowledge_points.id 外键（见 §10.5.6）
  connect_ids   JSON,                  -- → **其他分组**的标准问题 id（见 §10.5.5.1）
  effective_time BIGINT,               -- 毫秒；仅 41 行有此列（见 §10.5.5.1）
  failure_time  BIGINT,                -- 毫秒；仅 41 行有此列（见 §10.5.5.1）
  category_info JSON,                  -- ⚠️ 该键可能缺失，见 §10.5.9。1294 行没有这个键
  creator       VARCHAR, updater VARCHAR,
  create_time   BIGINT, update_time BIGINT,   -- ⚠️ 毫秒（与 kpoint 的秒不同，见 §10.5.7）
  synced_at     TIMESTAMP
)

knowledge_points(               -- 知识文档，即 kpoint 接口
  id VARCHAR PRIMARY KEY, content TEXT NOT NULL, title VARCHAR NOT NULL,
  enabled INTEGER, category_info JSON NOT NULL,   -- 实测 309/309 无缺失键（见 §10.5.7）
  update_time BIGINT,   -- ⚠️ 是秒，不是毫秒！见 §10.5.7
  synced_at TIMESTAMP
)

knowledge_categories(           -- 按 robotId 隔离，必须把 robot_id 纳入联合主键
  robot_id VARCHAR, category_id VARCHAR, name VARCHAR, parent_id VARCHAR, level INTEGER,
  PRIMARY KEY (robot_id, category_id)
)
```

**索引建议**：`(robot_id)`、**`(group_id)`**、`(type)`、`(ref_id)`、`(point_id)`、`(enabled)`。**不要在 `answer` 上建全文索引** —— 实测 9368 行（73.3%）的 `answer` 恒为空；那些是相似问题；全文检索应只覆盖 `type=1`。

#### 10.5.4 `type` / `ref_id` 语义（实测 12778/12778，无例外）

| `type` | 含义 | 行数 | `ref_id` 行为 | `answer` |
|---|---|---|---|---|
| **1** | **标准问题** | 3410 | **恒为 `== id`**（3410/3410） | 有内容 |
| **10** | **相似问题** | 9368 | **恒为 `!= id`**（9368/9368），且**全部指向一个存在的 `type=1`**（9368/9368） | **恒为空**（9368/9368） |

→ **`type=10` 是 `type=1` 的另一种问法**，不是独立的知识。**任何"知识数量"统计都必须先声明其定义**：

- 问"有多少条知识" → 应报 **3410**（标准问题），而不是 12778
- 报 12778 会把行数相对知识数**虚增到 3.75 倍**（12778/3410）；仅相似问题就是标准问题的 **2.75 倍**（9368/3410）

这与 §7.5 中机器人会话占比是同一类坑：**原始行数 ≠ 业务实体数**。skill 必须明确说明这一点。

**⭐ `groupId` 才是知识实体的真正主键（实测 3410 = 3410，严格一一对应）**：

> ⚠️ **`groupId` 在 100% 的行上都存在，包括 `type=10` 相似问题 —— 它并非仅 `type=1` 才有的字段。** 本节早前版本暗示两个计数相等是*因为只有标准问题才带它*；它们相等是出于另一个原因，而这个区别在写 schema 时很关键。正确的表述是：每一行都带 `groupId`，而 `COUNT(DISTINCT groupId)` 恰好等于 `COUNT(type=1)`，是因为每个组恰好持有**一个**标准问题。因此 `WHERE groupId IS NOT NULL` 过滤出来的是 **12778 行，而不是 3410 行** —— 要过滤出知识实体，必须用 `type=1` 或 `DISTINCT groupId`，绝不能对 `groupId` 做非空判断。

| 实测项 | 结果 |
|---|---|
| 带 `groupId` 的行 | **12778 / 12778（100%）** —— 所有 type |
| 不同的 `groupId` 数 | **3410** |
| `type=1` 标准问题数 | **3410** |
| "每组标准问题数 ≠ 1"的组 | **0**（分布恒为 `{1: 3410}`） |
| 相似问题 `refId` == **其本组**标准问题 `id` | **9368 / 9368**（无例外） |
| 每组总行数 | 从 1 到 **520**（即一个知识条目最多携带 519 个相似问题） |

→ **三重等价**：`groupId` ↔ 该组唯一的 `type=1` 的 `id` ↔ 组内每个 `type=10` 的 `refId`。**`groupId` 是知识实体的稳定标识**，而 `id` 只标识"某一种问法"那一行。

**对本设计的两个后果**：
1. **`knowledge_items` 应增加 `group_id` 列并建索引** —— 否则"一个知识条目的所有问法"需要两段查询 `WHERE id=? OR ref_id=?`。有了 `group_id` 一趟就能命中。
2. **"相似问题数"是知识条目的属性** —— 直接用 `SELECT group_id, COUNT(*) FROM knowledge_items GROUP BY group_id` 得到，无需额外的表。

#### 10.5.5 `type` / `faqType` / `fromType` / `innerAnswer` 语义（文档说明，并与实测交叉核对）

官方字段表（`robot.data.knowledge` 的 Apifox 页面）对这四个字段都有说明。**文档中的枚举与实测分布一致**，这正是我们可以把它们当作事实而非猜测来陈述的原因：

| 字段 | 文档含义 | 实测分布 |
|---|---|---|
| `type` | **1 = 标准问题，10 = 相似问题** | `{1: 3410, 10: 9368}` ✅ |
| **`faqType`** | **0 = 仅外部答案，1 = 仅内部答案，2 = 内外部都有** | `{0: 12746, 2: 16}` —— **`1` 从未出现** |
| **`fromType`** | **0 = 用户手动添加，1 = 欢迎语库，2 = 文件导入** | `{0: 11827, 2: 935}` —— **`1` 从未出现** |
| `innerAnswer` | **内部答案**（`faqType` 这对中的"内部"那一半） | 仅 3 行非空 |

→ **`innerAnswer` 现在有了解释**：它是面向内部的答案，仅当 `faqType` 为 `1` 或 `2` 时才被填充。这解决了此前的悬而未决问题 —— 该字段并未废弃，它是文档所载一对中的后一半。

**⚠️ 所观察到的枚举取值集合是不完整的 —— 不要基于它们做校验。** `faqType` 与 `fromType` 各有**三个**文档取值，但实测只看到**两个**：

| 字段 | 文档取值 | 实测值 | 未观察到 |
|---|---|---|---|
| `faqType` | 0, 1, 2 | 0, 2 | **1**（仅内部答案） |
| `fromType` | 0, 1, 2 | 0, 2 | **1**（欢迎语库） |

→ **{0,2} 是一种观察结果，不是值域。** 依据实测集合做校验的 CLI，会在使用欢迎语库或仅内部答案的租户上改写或拒绝合法数据。**注册表必须承载文档记载的 3 值枚举，而不是实测到的 2 值枚举。**

**这两个字段并非干净的行级/组级配对 —— 其不对称性更微妙，笼统表述本身就是个坑。** 在全部 3410 个组上按组重新推导：

| 字段 | 取值在组内是否恒定？ | 非零值是否固定在某一行位置？ |
|---|---|---|
| **`faqType`** | **几乎总是** —— 3409/3410 个组一致；恰好 **1** 个组混杂（2 行取 `2`，6 行取 `0`） | **否。** 16 行 `faqType=2` 中，**13 行是 `type=10` 相似问题**，只有 3 行是标准问题行 |
| **`fromType`** | **否** —— **249 个组**在标准问题行上取 `2`、在其全部相似问题上取 `0`（2467 个组全为 `0`，686 个组全为 `2`） | **是** —— 全部 **935/935** 行 `fromType=2` 都是该组的 `type=1` 标准问题行；每一个相似问题行都是 `0` |

→ **所以准确的表述不是"一个是行级、另一个是组级"：**

- **`fromType`** 是**写在一个固定位置的组属性** —— 它的*取值*在一个组内逐行变化，但它的*非零标记*总是在标准问题行上。`MAX(from_type) GROUP BY group_id` 恰好是对的。
- **`faqType`** 原则上是**逐行的**（一个组内不同行取值可以不同，而本租户就存在这样一个组），但在本租户里它*近乎*组恒定。坑在相反方向：**它的非零值大多落在相似问题行上**，所以"从标准问题上读 `faqType`"这类规则是错的。

> **⚠️ 而且相似问题行上的 `faqType=2` 是自相矛盾的数据**：那 13 行的 `answer` 与 `innerAnswer` 都为空（相似问题从不带答案——§10.5.4）。因此相似问题上的 `faqType` 并不描述该行自身的内容；它似乎是从其所属组的标准问题继承来的。**CLI 不得在不检查 `type=1` 的情况下，把 `faqType` 当作"这一行两种答案都有"来用。**

> **不要用一个模式去聚合这两个字段，也不要用一句话去描述它们。** `db describe` 必须逐一说明：取值是否为组恒定，以及非零值写在哪里。

**`fromType=2`（文件导入）与"挂有知识点"强相关**：

| | 带 `pointId` 的占比 |
|---|---|
| `fromType=2` | **71%**（664/935） |
| `fromType=0`（标准问题） | **31%**（763/2467） |

支持 `fromType=2` 确实是导入路径的旁证：935 行中有 780 行落在 **2025-06~07**（仅 2025-06 就有 542 行），且 `creator` 集中在 3 个账号（`5000002` 542 行、`5000001` 248 行、`5000003` 97 行）—— 与一次性批量文件导入一致。这也排除了其他可能：groupId 区间与 `fromType=0` **完全重叠**（不是分批的），`createTime` 跨度是 2023-06 ~ 2025-10（不是时间截断）。

**`faqType=2`（内外部答案都有）罕见且聚集**：

| 事实 | 实测 |
|---|---|
| `faqType=2` 的行 | **16**，集中在 **3 个 groupId**（`30000005`：8 行，全为 2；`30000004`：6 行，全为 2；`30000003`：8 行中 2 行） |
| `innerAnswer` 非空的行 | **3**，且它们**正是那 3 个组的标准问题行** → **非空 `innerAnswer` ⊂ `faqType=2`（3 ⊂ 16）** |
| `answer` 与 `innerAnswer` 长度 | 120/120、314/316、116/153 → 两个相同，一个不同 → **两个答案可能不一致**；差异是 HTML 空白 |
| 与 `fromType=2` 的交集 | **0**（16 行全部为 `fromType=0`） |

→ 子集关系符合预期：`faqType=2` 意味着两种答案*都存在*，所以其中只有部分行会已经把内部答案填上。

#### 10.5.5.1 文档字段清单不等于返回字段清单（6 个字段未文档化，3 个稀疏）

`robot.data.knowledge` 的官方字段表列出 **16 个字段**。接口实际返回 **22 个**。对全部 12778 行做完整键普查并与官方表交叉核对，两个方向的差异都得以确定：

| | 字段 | 数量 |
|---|---|---|
| 已文档化**且**被返回 | `id` `question` `md5` `answer` `innerAnswer` `faqType` `fromType` `updateTime` `type` `refId` `connectIds` `categoryInfo` `pointId` `enabled` `effectiveTime` `failureTime` | **16** |
| **被返回但未文档化** | **`groupId` `robotId` `robotName` `creator` `updater` `createTime`** | **6** |
| 已文档化但该接口**从不返回** | *（无）* | 0 |

**⭐ 未文档化的 `groupId` 是该表最重要的单个字段** —— 它是知识实体的真正主键（§10.5.4），在 **12778/12778 行**上都存在，却在**官方文档中完全没有出现**。`robotId` + `robotName` 是另一对承重字段：它们是发现机器人身份的唯一 API 侧途径（§11.3、§10.5.10），而它们同样未文档化。

→ **注册表必须依据响应体构建，而不是依据文档。** 若该表是按官方字段清单生成的，它将丢掉主实体的主键，以及发现机器人的唯一途径。

**反方向看，有三个*已文档化*的字段是稀疏的** —— 官方表没有说明这一点，首页抽样也不会暴露：

| 字段 | 行数 | 文档描述（原文照录） |
|---|---|---|
| **`connectIds`** | **207**（1.6%） | `关联的问题id列表` —— **其他组标准问题 id** 的 JSON 数组（"关联知识"） |
| **`effectiveTime`** | **41**（0.3%） | `问题的有效开始时间(enabled=1且有效时间为空说明永久有效，enabled=1且有效时间不为空说明该时间内有效)` |
| **`failureTime`** | **41**（0.3%） | `问题的失效时间` |

**文档中 `effectiveTime` 的那段文字解决了一个光靠实测无法解决的问题**：有效期是**选择性启用**的 —— `enabled=1` 且 `effectiveTime` 为空表示*永久有效*，而不是*无效*。由于只有 41 行带该字段，**CLI 必须把"缺失"当作"始终有效"**，而不是当作需要用默认日期去填的缺值。另需注意，文档把这两个字段的类型写成 `string`，而响应体携带的是 epoch 毫秒 —— 注册表以响应体为准。

另一个已文档化但稀疏的字段是 `categoryInfo`（11484/12778）；其缺失键的行为见 §10.5.9。

**`connectIds` 跨组指向，而非组内**：

| 事实 | 实测 |
|---|---|
| 引用数 | 共 350 条，去重 233 条 |
| 能解析到存在的行 | **344/350**（6 条悬空） |
| 目标 `type` | **全部为 `type=1`**（344/344）—— 它是标准问题指向标准问题 |
| **同 `groupId`** | **0/350** —— 它**从不**指向自组内部 |

→ 这是知识库中的**第三条**图边，与 `ref_id`（相似 → 标准，组内）和 `point_id`（条目 → 知识点，跨表）并列。**三条边都必须建索引**；尤其是 `connect_ids`，正是它让"机器人还应该知道什么"变得可回答。

**教训**：官方字段表**既不完整，也不是密度图**。它直接漏掉六个字段 —— 包括实体的主键 —— 也不告诉你它所列出的字段中有三个出现在不足 2% 的行上。**只有对全量响应体做键普查才能产出可用的 schema**；按文档生成表会丢掉主键，按首页生成表会彻底丢掉 `connectIds`。

**`validitySwitch` 在该接口中不存在** —— 不只是所观察到的行上为空，而是**在 `robot.data.knowledge` 的官方字段表中也不存在**（已对照已发布的文档页核验，2026-09-30），而写入端点却要求它。它只出现在 `ai.knowledge.getDetail` 中。→ **针对 `editKnowledge` 的读-改-写无法从 list 端点取得 `validitySwitch`**；它必须来自 `getDetail`，否则 CLI 必须显式传值。这是 §5.4.1 读-改-写隐患的一个具体实例：**该字段写时必填，却无法从产出该对象的同一个端点读到。**

→ **`fromType` 的非零值只落在一组的标准问题行上**（§10.5.5 —— 注意取值本身在组内仍会变化，所以只说"组级"并不精确）。其文档取值 `2` 是**文件导入**，下文的关联性正是该导入路径所蕴含的。**聚合时不要对全部行求和** —— `fromType=2` 标记的是 935 *个组*，按行计数会把 935 个组误读成 935 行。

**`md5` 的定义得到确认：`md5 = md5(question)`**（实测 **12778/12778 完全匹配**；对原始 `question` 文本取 md5 逐字节相等）。由此得到跨机器人复制的判定标准 —— 实测有 **416 个重复 md5 组**（涉及 832 行），且它们**确实跨机器人**：例如 md5 `a1b2c3d4e5f60718293a4b5c6d7e8f90` 同时存在于 `1000001/机器人 A`（id 20000101）与 `1000004/机器人 D`（id 20000102）。

| 推论 | 实测 |
|---|---|
| 416 个重复组**全部跨机器人**，没有一个在同一机器人内 | ✅ 组内出现重复 md5 的组 = **0**（3410/3410） |
| md5 从不在同一个 `groupId` 内重复 | ✅ 同上（组内各问法彼此不同） |

→ **`md5` 可直接用作"同一种问法"的去重键**，而 `(robot_id, md5)` 是跨机器人去重的正确粒度。**不能假定 id 全局唯一就意味着内容唯一**。

**⭐ `groupId` 从不跨机器人**（实测 3410/3410，一个组内的机器人唯一）→ **`groupId` 全局唯一，可以单独作主键**，无需 `(robot_id, group_id)` 复合键。这与 §10.5.9 中的 `category_id` **形成对照**（后者必须用复合键）：同一种字段，一个全局唯一，一个封闭在机器人内；不可类推。

#### 10.5.6 `point_id` 是指向 kpoint 的真实外键（实测 4805/4805 命中）

共有 **4805** 行 `point_id != 0`（37.6%），涉及 **255 个不同取值**，且 **255 个全部能在 `knowledge_points` 中找到**（命中率 4805/4805 = 100%）。**kpoint 共 309 行，因此有 54 个知识点未被任何条目引用** —— 反方向不成立，不能假定 kpoint 与条目一一对应。

→ **这是两个接口之间唯一的连接**，使"知识条目 ↔ 知识文档"可关联。CLI 应显式建立该外键，并在 `db describe` 中标明。

#### 10.5.7 `kpoint` 与 `knowledge` 的 `updateTime` 单位**不同**（秒 vs 毫秒）

同一 API 家族、同一字段名，**单位不一致**（实测）：

| 接口 | `updateTime` 示例 | 单位 |
|---|---|---|
| `robot.data.knowledge` | `1700000000000` | **毫秒**（13 位） |
| **`robot.data.kpoint`** | **`1700000000`** | **秒**（10 位） |

→ 这是 §1"时间单位"的又一实例（而且是**在同一 API 家族内部**的不一致，比跨模块的更难看穿）。**落库前每个接口必须各自归一化**；不能共用一个解析函数。把 kpoint 统一按毫秒解析，会得到像 **1970-01-20** 这样静默错误的日期（它不报错，只是算错）。

> **⚠️ 这是本项目第三次撞上这类坑**；前两次：鉴权 `time` 用秒 vs 报表用毫秒（§1）；报表 `startTime` 传秒 → `overview` **49/69 个字段静默变成 `-1`，而 `code` 仍是 200**（§6.3）。→ **结论：七鱼的时间字段没有全局约定；每个接口都必须单独实测并登记**。对外 CLI 统一接受 ISO8601（§9.3）；内部按接口各自转换。

**`kpoint` 的字段完整度远好于 `knowledge`**（实测 309/309 全字段存在）：

| 字段 | 缺失数 | 说明 |
|---|---|---|
| `id` / `title` / `content` / `enabled` / `categoryInfo` / `updateTime` | **0** | 全部 309 行完整，**`categoryInfo` 无缺失键**（与 `knowledge` 中 1294 行缺失键形成对照） |
| `content` / `title` 空字符串 | **0** | 全都有内容 |
| `enabled` | — | **全为 1**（无禁用样本；该字段无区分度） |

→ **`knowledge_points.category_info` 可以设为 NOT NULL**，而 `knowledge_items.category_info` **必须可空** —— 两张表不能共用 DDL。

**关于 `kpoint` 的其他结构性事实（实测）**：

| 事实 | 实测 | 影响 |
|---|---|---|
| **只有 6 个字段** | `categoryInfo`/`content`/`enabled`/`id`/`title`/`updateTime` | **没有 `robotId`** → **无法从 kpoint 反查机器人归属**；只能经 `knowledge_items.point_id` 反向推断 |
| `total=309`，`size=1000` 一次拉完 | `isEnd=1` | **无需游标循环**；一次请求即可 |
| **id 空间与 knowledge 完全不重叠** | 两张表的 id 区间**不重叠**（交集 **0**） | 两张表的 id 不会冲突；但**也不能用 id 区间推断关系**。⚠️ **具体区间刻意不予复现**（它们可识别企业身份）；本文档其他位置显示的数字是合成占位符。**尤其不要用 id 的位数来推断它属于哪张表** —— 真实 kpoint id 空间包含两种不同位宽的值，所以"8 位 ⇒ kpoint"这类规则是错的 |
| `categoryInfo` 深度 **1–4 层** | `{1:1, 2:15, 3:149, 4:144}`，**无 0 层** | 与 knowledge 的 `0–5` 层**不同** → 解析深度不能共用 |
| `content` 含 HTML | **298/309** | 必须按 HTML 处理，与 knowledge 的 `answer` 相同 |
| 顶层类目 | 4 个顶层节点，分别含 294 / 12 / 2 / 1 行 | — |

**⭐ kpoint 的类目体系与 FAQ 类目树是两套独立体系** —— kpoint 有 62 个不同类目名，与 `1000001`（机器人 A）的 FAQ 树**仅重合 1 个名称**（而且那一个是"其他"这类噪声级泛称）；但它与 `1000002`（机器人 B）的 FAQ 树**重合 44 个类目名**（即该机器人业务线特有的类目名）。

→ **`knowledge_points.category_info` 与 `knowledge_categories` 之间不存在可用的外键关系**。CLI **不得**尝试关联二者（那会静默产出错误结果）。`knowledge_points` 是"知识文档"，`knowledge_categories` 是"FAQ 类目"；它们属于两个子系统。

**`point_id` 的引用分布高度倾斜，并且存在孤儿**（实测）：

| 事实 | 实测 |
|---|---|
| 被引用的不同 `pointId` | **255**，而 kpoint 共 **309** 个 → **54 个知识点未被任何 FAQ 引用（孤儿）** |
| 被引用最多的 `pointId` | `40000003` 被 **1214** 行引用，`40000002` 被 **948** 行，`40000004` 被 **417** 行 |
| 跨机器人共享的 `pointId` | **仅 4 个**（`40000005`/`40000002`/`40000006`/`40000004`）；其余 251 个各自绑定单一机器人 |
| 每个机器人用到的 `pointId` 数 | 机器人 A **1**，机器人 C **7**，机器人 B **250** |

→ **`point_id` 不是一对一关系**：机器人 A 的 4965 行知识**只挂靠 1 个知识点**。CLI 的 `db describe` 应将 `point_id` 标为"多对一，且可能为 NULL/0"。**孤儿知识点（54 个）是正常状态，不是数据缺失**。

#### 10.5.8 `ai.knowledge.search` 的真实行为（实测）

| 事实 | 实测 | 影响 |
|---|---|---|
| **`pageSize` 服务端硬上限 = 200** | 传 201/500/1000 **一律只返回 200** | **⚠️ 文档写的是最大 50**（`分页每页大小[默认10，最大50]`）—— 服务端容许了文档上限的 **4 倍**。**把文档的 50 登记为契约、把 200 登记为未文档化的容忍度**，否则 CLI 会静默依赖七鱼从未承诺的行为。这也与 `robot.data.knowledge` 的 1000 不同 → 分页常量不能共用 |
| **只返回 `type=1` 标准问题** | 按机器人的计数与全量导出中的 `type=1` 计数**完全一致**（机器人 A 677 / 机器人 B 1814 / 机器人 C 599 / 机器人 D 319 / 机器人 E 1） | **`search` 不是同步来源** —— 它看不到相似问题 |
| **不按 `enabled` 过滤** | 机器人 A 的 **35 行 `enabled=0`** 照旧返回 | 搜索结果可能含已禁用知识；**Agent 必须自行按 `enabled` 过滤** |
| 无 `total`/`isEnd` | — | 无法判断是否还有下一页 |
| **`questionStatus` 是派生状态，不是 `enabled` 的副本** | 实测取值 **`{1, 2, 3}`**（文档另外还列了 `4-未生效`，**从未观测到**）。`status=1` ↔ `enabled=1`；`status=3` ↔ `enabled=0` **或** `enabled=1` 但有效期已过；`status=2` 对应"启用且在有效期内"的少量行 | **不要把它当布尔用** —— 它同时编码了启用状态与有效期窗口。`search` 返回的 6 个键是 `{answer, categoryId, id, name, questionStatus, updateTime}`，`effectiveTime`/`failureTime` 仅部分机器人返回 |
| **`validitySwitch` 在 `search` 中 0 行返回** | 文档为 `search` 声明了该字段，实测 **0/3410 行** | 它只在 `getDetail` 中可取（见 §10.5.5.1 与上表） |

→ **`search` 只能用于"实时搜索"，不能作为同步来源**（它天然缺失 73% 的数据）。skill 应说明：从 `search` 得到的"知识数量"是**标准问题数**，不是知识库总量。

#### 10.5.9 `categoryInfo` 可能缺失键（不是空数组 —— 键根本不存在）

在实测的 12778 行中，**1294 行（10.1%）根本没有 `categoryInfo` 键**；"键存在但为 `[]`"的行数为 **0**。

| 形态 | 行数 |
|---|---|
| 键**完全缺失** | **1294** |
| 键存在但为 `[]` | **0** |
| 键存在且非空 | 11468 |

→ **落库必须是 `NULL`，不能默认成 `[]`** —— 否则"无类目"与"类目为空数组"两种语义会被合并，而后者在数据中根本不存在。`db describe` 应把该列标为可空。

**缺失类目并非相似问题专有**：在 1294 行缺失键中，1116 行是 `type=10`，**178 行是 `type=1` 标准问题**。→ **不要假定"标准问题总归有类目"**。

**无类目比例在机器人之间差异巨大**（印证 §10.5.2 的类目树隔离）：

| 机器人 | 无类目 / 总数 | 比例 |
|---|---|---|
| 机器人 C | 992 / 3199 | **31.0%** |
| 机器人 A | 274 / 4965 | 5.5% |
| 机器人 D | 8 / 528 | 1.5% |
| 机器人 B | 15 / 4081 | **0.4%** |
| **机器人 E** | **5 / 5** | **100%** |

> **⭐ 机器人 E 的 100% 无类目比例与 §10.5.2 的"其类目树返回为空"是从两个独立接口得到的同一结论** —— 该机器人尚未配置任何类目体系。这种交叉印证提升了两条结论的可信度：**当两个独立接口对同一事实给出相互矛盾的信号时，应交叉验证而不是择一采用**。

**在 `robot.data.knowledge` 的 `categoryInfo` 中不存在 `categoryId=0` 的"未分类"占位行**（实测 0 行）→ 在这里，"未分类"只以"键缺失"表达。

> **⚠️ 但这个结论不能推广到 `ai.knowledge.search` —— 那里 `categoryId=0` 就是货真价实的哨兵。** 实测 4 个机器人分别有 **8 / 20 / 8 / 2** 行返回 `categoryId=0`。→ **同一个字段名、同一个 API 家族，一个接口用"键缺失"表达未分类，另一个用 `0` 表达。** 凡是把两个接口的结果 union 起来再按 `categoryId` 分组的查询，都会把 `0` 和缺失键当成两件事，从而把"未分类"拆成两个桶。CLI 归一化时必须**显式把两者映射到同一个哨兵值**。

**⭐ `categoryInfo[].categoryId` 封闭在单个机器人内（实测 28783/28783，全部命中）** —— 取遍 12778 行中的所有 `categoryId`，与**5 棵类目树的并集**比对：

| 结果 | 数量 |
|---|---|
| 命中**本机器人**的树 | **28783** |
| 未命中本机器人的树 | **0** |
| 未命中本机器人但在**其他**机器人的树中存在 | **0** |

树的规模：机器人 A 129 个节点 / 机器人 B 266 / 机器人 C 51 / 机器人 D 52 / **机器人 E 0**。

→ **`knowledge_categories` 的主键必须是 `(robot_id, category_id)`，而不能只有 `category_id`** —— 否则跨机器人同名类目会互相覆盖。这也**印证了 §10.5.2 的隔离结论**：类目 ID 空间按机器人划分，一个 `categoryInfo` ID 只在其所属机器人的树内有意义。

#### 10.5.10 已知缺口

- **`robotId` 仍无官方发现路径**（§11.3）。但 `robot.data.knowledge` 的响应体**包含 `robotId`+`robotName`**，且**完整遍历覆盖全部 5 个机器人** → 它**可以**作为 robotId 的发现路径，**前提是拉全量**。
  > 早前版本写过"该结论已被推翻（它只返回同一个 robotId）"—— **那次推翻本身就是错的**，成因是 §10.5.2 的首页抽样假象。**结论恢复：完整遍历 `robot.data.knowledge` 是 API 侧发现 robotId 的唯一途径**，但它仍**无法发现知识库为空的机器人**（例如新建、尚无条目的机器人）→ **§11.3 的手工配置仍然必要**；这条路径只是补充。
- **`faq_type` 与 `from_type` 现有文档化的语义**（§10.5.5）：`faq_type` 0/1/2 = 仅外部答案 / 仅内部答案 / 两者；`from_type` 0/1/2 = 手动添加 / 欢迎语库 / 文件导入。⚠️ **但这两个字段都只观察到 `{0,2}`** —— 文档取值 `1` 在本租户从未出现。**{0,2} 是观察结果，不是值域**；校验必须接受全部三个文档取值。**它们的结构性差异比"行级 vs 组级"更微妙**（§10.5.5）：`from_type` 的非零值固定在该组的标准问题行上（935/935），而 `faq_type` 的非零值**大多落在相似问题行上**（16 行中的 13 行）—— 因此"两者套用同一模式"和"从标准问题上读 `faq_type`"都不安全。
- **⚠️ 字段名冲突**：在**会话数据**中 `fromType` 是"渠道"（实测 `web`/`wx_sdk`/`wx_cs`/`ios`，见 §7.5），而在**知识库**中它是"来源标记"（0/2）。**同名不同义，且不在同一张表** → CLI 的类型定义与 `db describe` 必须按表区分，不得共用常量。
- `ai.knowledge.search` **没有 `total`/`isEnd`**，因此无法判断是否还有下一页 → 只用于搜索，不作为同步来源。

## 11. Skill

### 11.1 第一性原理

**绝不在 skill 中硬编码任何事实** —— 不写表名、不写列名、不写错误码列表、不写完整 SQL 文本。所有事实都通过 CLI 自描述在**运行时**获取。

- 反例：写「满意度表叫 `staff_satisfaction`」→ CLI 一改名就失效
- 正例：写「查询某张表之前，先跑 `qiyu db tables` 确认表名」

### 11.2 内容

**A. 开场协议**：任何与数据相关的任务，第一步必须是 `qiyu sync status`（数据覆盖范围、新鲜度、缺口）

**B. 通道路由决策树**

| 任务特征 | 通道 |
|---|---|
| 历史趋势 / 聚合 / JOIN / 跨窗口 | 本地数据库 |
| 刚刚发生 / 单条记录明细 | 实时 API |
| 写操作 | 实时 API |
| 本地数据库中没有该表 | 实时 API，或先执行 `sync run` |

**C. 数据可信度协议**：下结论前先看 `meta`；0 行不能直接报告为「没有数据」；用 `stats fields` 核对单位；时间一律使用绝对日期

**C2. 指标语义协议（新增；防止「把行数当实体数」）**：以下三处**原始行数 ≠ 业务实体数**，回答前必须先声明语义 ——

| 场景 | 陷阱 | 正确语义 |
|---|---|---|
| 知识库条目数 | `knowledge_items` 有 12,778 行（2026-09-30），但其中 **9,368 行是相似问**（`type=10`，`answer` 恒为空） | 「有多少个知识点？」→ **`COUNT(DISTINCT group_id)` = 3410**（等价于 `type=1` 的行数）；如果人类确实要把相似问算进去，必须显式说明 |
| 会话数 | `sessions` 包含机器人会话（68%），且机器人侧很多字段恒为空 | 聚合前先按 `session_type` 过滤；报告「人工客服工作量」时必须排除机器人 |
| 工单工作量 | 一个人改 8 个字段 = 8 条日志 | **`COUNT(DISTINCT ticket_id)`**，而不是日志条数（§10.4） |

**知识库还有一处语义分叉**：`knowledge_items` 是**跨所有机器人的并集**，而 `knowledge_categories` 是**按 robotId 隔离的** → 回答「某个机器人有哪些知识分类」时，**不得**从 `knowledge_items` 的 `category_info` 推断分类树（§10.5.2）。

**D. 错误处理协议**：按 `kind` 分支，而不是按 code 分支

| kind | 动作 |
|---|---|
| `rate_limit`（retry_after > 60） | **不要 sleep**；改为查询本地数据库 |
| `needs_confirmation`（退出码 4） | **停下来**，向人类复述该操作及其目标，**绝不自动追加 `--yes`** |
| `ambiguous` | 把候选交给人类，**不得自行选择** |
| `store_locked` | 正在同步中；稍后重试即可（**本阶段无「查询缓存」能力**，它从未进入任何子项目范围；写进程持锁，退避后重试是唯一出路） |

**E. 禁止事项**：不要读取配置文件（其中含 appSecret），不要把 `--pretty` 写进你生成的命令示例（它**已实现**，但对 Agent 无增益——默认输出已是紧凑可解析的 JSON），不要把 `query --table` 当作任意 SQL 的替代品——需要 JOIN/跨表聚合时用 `--sql`，不要盲目重试，不要在未先确认新鲜度的情况下下结论

> **⚠️ E 的两处陈旧措辞已回写（2026-10-30）**：原文写「不要使用 `--pretty`（未实现）」，而
> `--pretty` **自 2026-10-24（G1）起已实现**（缩进 JSON，须写在具体子命令之后；`REJECTED_FLAGS`
> 已清空为空数组、机制保留）。**禁的是"写进 Agent 生成的命令示例"，不是"它会失败"** ——
> 这个区别很重要：Agent 若把 `--pretty` 当"必然报错"写进排障指引，遇到真的用 `--pretty`
> 的人类用户会给出错误判断。skill 正文（`src/skill/qiyu/forbidden.md` §2）已按此口径写：
> 「对 Agent 没有增益」而不是「未实现」。

> **裁决依据（F 实施波回写，与本 spec D5 一致）**：E 的原文是「不要使用 `--pretty`/`--table`」，逐字执行会与 §11.2 B 的路由表自相矛盾——B 表明确把「历史趋势 / 聚合 / JOIN / 跨窗口」导向本地数据库通道，而 `query --table` 正是这一通道的受约束入口（§8 定义其为列白名单 + 时间语义 + 精确脱敏），禁掉它等于禁掉 B 的一半；§9.1 的限流降级示例本身就建议 `fallback: "qiyu query --table order_performance"`。两个并列项的性质也不同：`--pretty` 是「承诺过、未实现」（每次调用都给明确话术），`--table` 是已交付的通道。故 E 那句的本意是「别把 `--table` 当成任意查询的通用替代品」，而不是通道级禁令。落到 skill 正文：单表过滤/分组计数用 `query --table`（列白名单与精确脱敏），JOIN/跨表聚合用 `query --sql`，`--pretty` 一律不用。
>
> **⚠️ 2026-10-30 复核**：本段裁决**仍然成立**（`--table` 不是通道级禁令），但括号里的依据有一半已过时 ——
> `--pretty` **已实现**（G1，2026-10-24），不再是「承诺过、未实现」。裁决的**结论**（不用 `--pretty` 写进
> 命令示例）不变，理由从「必然失败」变成「对 Agent 无增益」：`--pretty` 与 `--table` 现在都是**已交付的
> 通道**，区别只在于前者对 Agent 无用、后者是 B 表的正规入口。**别把这段读成「`--pretty` 会报错」。**

### 11.3 需要预先配置的 ID

**`robotId` 无法通过开放 API 获得** —— 官方**没有**「机器人列表」接口（实测：枚举 15 条候选路径全部返回 404）。`/openapi/robot/transfer/config` 实测返回空壳 `{"code":200}`，完全没有字段，不可用。

但 13 个知识库接口、机器人统计、机器人会话都依赖它。因此：
- **`robotId` 必须在 CLI 配置文件中手工填写**（多个机器人时可用别名映射）
- skill 必须明确告诉 Agent：`robotId` 缺失时去问人类，而不是尝试猜测或枚举
- **✅ 已交付**：`qiyu auth whoami` 输出 `data.robots`（配置里 `profiles.<name>.robots`
  的 robotId → 显示名映射）。它**只如实透出配置内容**，不校验有效性、不与本地库比对
  （见下方"集合不一致告警"的裁决）。该映射同时是 `sync run` 知识库类目任务的兜底驱动源：
  `store.options.knowledgeRobotIds` 缺席时用它，两者都有时以前者为准。

同类无法通过 API 获得的 ID：`taskId`（手动外呼任务）、`robotCallJobId`（外呼机器人任务）—— 两者都没有「任务列表」接口。

> **✅ `robotId` 有两条 API 侧的补充路径（都不完整，都不能替代手工配置）**：
> 1. **从会话数据反推** —— 实测：`sessions.staffId = -robotId`（§7.5）。会话同步完成后，可通过 `SELECT DISTINCT -staffId FROM sessions WHERE session_type='robot'` 获得。**它只能发现产生过会话的机器人**。
> 2. **知识库全量遍历** —— `robot.data.knowledge` 响应体中包含 `robotId`+`robotName`，且**全量拉取可覆盖全部 5 个机器人**（§10.5.2）。**它只能发现知识库非空的机器人**。
>
> 这两条路径**互补但仍不完整**（新建的、既无会话又无知识的机器人依然发现不了）→ **手工配置是基线；这两条只作校验和补充**。
>
> **裁决（G1）**：`auth whoami` 的「配置的 robotId 与实测发现的集合不一致」告警**不实现**。
> 原文措辞是「**可以**」而非「必须」，而判据是安全红线的直接冲突：`auth` 命令按分层约束
> **零加载 `store/`**（`tests/store/layering.test.ts` 钉着，含传递闭包），要比对集合就必须
> 查本地库 —— 那会把 DuckDB 拖进 `auth whoami` 的启动路径。缺失的这一能力在设计稿里
> **不留悬空承诺**：`auth whoami` 的 `field_notes.robots` 逐字写明「未校验有效性、未与本地库比对」。

### 11.4 防漂移

- `qiyu skill check` —— 校验 skill 引用的命令/表/字段是否仍然存在
- `qiyu --version` 输出 `skill_contract_version`

### 11.5 边界

**skill 不是安全边界。** 静态文档可能不被加载，也可能被忽略。以下必须硬编码进 CLI：
- `--yes` 闸门（按接口注册）
- `--sql` 只读沙箱（三层）
- 限流令牌桶
- 凭据输出过滤

## 12. 测试策略

- **`core/sign`（已交付，2026-10-25）**：与七鱼官方 Java `QiyuPushCheckSum` 样例做**逐字节比对**。样例**已取得** —— 来自 Apifox 文档页 `doc-436971`（`.md` 后缀取全文字段表），存档在 `private/docs/apifox-436971-数据校验.md`（`private/` 已 gitignore，不入公开仓库）。`tests/core/sign.test.ts` 内置该样例的 Node 移植版 `javaEncode` 作对拍 oracle，配固定向量，并附一条**反恒真**断言（oracle 必须与实现给出不同中间结果，否则「两边一致」只是抄了同一份代码）。⚠️ 原始 TCP 抓包验证实际发出的字节 —— **未做**，仍挂账（需要抓包环境，且当前校验和已由签名对拍覆盖）
- **`core/envelope`（已交付，2026-10-25）**：设计稿 §9.0 记录的 **40 条 key+type 实测签名样本不在仓库里**（会随服务端演化），故 `tests/core/envelope-matrix.test.ts` 改覆盖**形状 × `message` 类型**的语义矩阵（A / B / C / D / D-nf × string / object / integer / boolean / array），每格要么断言解释规则、要么显式标注无实测依据。矩阵附**覆盖度自检**：从 `src/core/envelope.ts` 读 `EnvelopeShape` 的真实定义，且覆盖判据是**观测式**的（`normalizeIn` 只在真实用例里登记被喂过的形状），双向断言「声明的形状都跑到了 / 跑到的形状都在声明里」，另要求至少两个形状给出不同结论 —— 手抄清单式的自检（清单 vs 类型定义）守不住「加了新形状但没有用例」这个形态
- `store`：对 DuckDB 和 SQLite 跑同一组用例，断言**类型与 upsert 语义完全一致**（已知差异见 §6.3）。**随 C2（外部后端）交付** —— 当前只有 DuckDB 一个引擎，「两引擎一致」无对照物
- `store/sandbox`：完整攻击用例集（§8.2 表格的全部 9 行）必须全部被拦截
- **时区（已交付，2026-10-25）**：`tests/core/time-timezones.test.ts` 在三个时区（`Asia/Shanghai` / `UTC` / `America/New_York`）下跑同一组日期用例，断言结论逐字一致。**两条自检让一致断言有牙**：① 每个时区先探测本机小时数（20 / 12 / 8），切换未生效就响亮失败 —— 否则「三个都一样」只是「根本没切」；② 另有一条断言要求这组用例对时区**敏感**（三时区下本机日历日不全相同），否则用例可能恰好落在三时区同一天的区间里。用例覆盖跨日（上海已是次日、纽约仍是当日）、跨年、纽约夏令时起止日、无偏移 ISO、`yesterday` 与回显形态。⚠️ **每个时区都重新导入模块**（`vi.resetModules()` + 动态 import）：`Intl.DateTimeFormat` 在构造时就把时区定死，只切 `process.env.TZ` 的写法测不出「formatter 退回默认时区」这类缺陷（实测：构造于上海的 formatter 切到 UTC 后仍返回上海日期）。变异验证四次均转红：`yesterday` 改用本机日期 / 无偏移 ISO 交给 `Date.parse` / 本地零点代替上海零点 / 删掉 formatter 的 `timeZone`
- `sync`：录制 HTTP fixture；验证幂等性（跑两次结果相同）、可断点续传的同步，以及无缺口的事务
- `commands`：端到端 mock server；断言 stdout 是纯 JSON 且退出码正确
- **`sync/knowledge`（新增；必须防采样假象）**：以**一次完整遍历的录制 fixture** 做断言（录制于 2026-09-30，12,778 行 —— **不要在断言里硬编码这个数字**，它会漂移；改为断言下列不变量，并让 fixture 自带行数）—— ① `isEnd` 驱动终止，且累计行数 `==` 声明的 `total`；② **断言全部 5 个 robotId 都出现**（若 fixture 被截断到前 1,000 行，这条断言必须失败 —— 那正是 §13#14 的错误）；③ 每条 `type=10` 行的 `refId` 都能解析到一条 `type=1` 行**且携带相同的 `groupId`**；④ 每行的 `pointId` 都能解析进 `knowledge_points`（4,805 条，全部可解析）；⑤ `COUNT(DISTINCT groupId) == COUNT(type=1)`；⑥ `groupId` 在**每一**行上都存在，且没有 `groupId` 跨越两个 `robotId`
- **`core/errors`（新增）**：对 `14500` 的四路分派做表驱动测试（§4.3）—— 断言「被限流」走延迟重试路径，「参数格式错误」**不**重试，「Service Offline」**熔断**，「内部错误」退避。**任何只断言错误码的测试用例都是无效的**

## 13. Version 1 的错误（记录备查）

| # | Version 1 的错误 | 真相 |
|---|---|---|
| 1 | 「报表的 5 分钟限频是硬约束」 | **错。** 5 分钟间隔只存在于呼叫中心接口；6 个在线报表接口完全没有文档记载的限频。而且 Version 1 自己的 §7.3 表格是对的 —— 是 §1/§7.4 与之矛盾 |
| 2 | 「14 种响应信封」 | 实际是 **26** 种顶层 key 组合 / **40** 种 key+type 签名 |
| 3 | 「154 个接口全部可达」 | 实际**可对外调用的只有 132 个** / 共 150 个 / 17 个结构上不可调用 + 1 条坏路径 |
| 4 | 「报表表主键是 `date + staff_id`」 | 8 张表里只有 3 张成立；`date` 的含义是「查询开始时间」，不是数据日期。**Version 2 仍然是错的**：`staff_attendance` 实际是按 **客服 × 小时**（`date` 是整点对齐的时间戳），`satisfaction.date` 是 `startTime` 的逐字节回显，`staffworklod.date` 恒为 0 → **§6.2 已改写为 10 张表，日期一律由调用方提供** |
| 5 | 「必须本地持久化」的论证 | 论证是错的（它建立在第 1 条之上），但**结论仍然成立** —— 真正的原因在 §1 核心洞见 |
| 6 | 未处理 DuckDB 跨进程锁 | 实测：读写锁会阻塞一切，包括只读 |
| 7 | 「拒绝非 SELECT + 强制 LIMIT」就够了 | 实测：可经 `COPY` / `read_csv` / SSRF 绕过 |
| 8 | 没有本地数据库自描述 | Agent 只能猜每一个表和列的名字 |
| 9 | 时区未定义 | `yesterday` 会静默算出错误的那一天 |
| 10 | 「会话历史页面没有机器人会话」 | **错。** 会话类型下拉框确实有「机器人会话」选项；它默认停在「人工会话」，由此造成误读（把旁边的「会话开始来源」筛选器错当成了会话类型） |
| 11 | 「逐个接口串行拉报表」的隐含成本模型 | 错。限频是**按路径**的，所以按天轮转可行 —— 31 天从约 2.6 小时降到约 16 分钟 |
| 12 | 「`data/overview/session` 是一张报表」 | 错。实测：它**忽略所有参数**，只返回实时快照，没有历史回溯能力 → 无法参与报表同步 |
| 13 | 假设报表时间跨度上限是统一的 | 错。实测：**31 天 / 365 天 / 不限**，共三档，且超限错误码在 `14501` / `14004` / `14500` 之间变化 |
| 14 | 「知识库只包含默认机器人 Robot A」 | **错，而且这个错误被反复翻转了两次。** 最早的说法是它「可以作为 robotId 的发现路径」→ 该说法被「证伪」（只看了前 1,000 行，全是 Robot A）→ **那次证伪本身就是错误。** 对全部 12,778 行做完整遍历后显示**5 个机器人全部存在**。**教训：分页接口的第一页不具代表性；任何关于「全集」性质的论断都必须靠全量拉取来验证** |
| 15 | 「`14500` 是服务端内部错误，统一退避重试」 | **错。** 实测：`14500` 承载 **4 种不同含义**（内部错误 / 限流 / 参数类型错误 / 模块未开通）。只按错误码重试意味着**参数错误白白烧掉限频预算，未开通的模块则永远重试下去**。**教训：七鱼的兜底错误码，其含义完全承载在 `message` 里；错误分类必须按文本判定** |

**Version 1 做对、Version 2 予以保留的部分**：签名对字节敏感（已比对验证）、错误码分类法、stdout/stderr 分离、可断点续传的同步方案、工单域映射、文档缺陷清单，以及会话导出管线的描述。

## 14. 已知风险

| 风险 | 缓解措施 |
|---|---|
| **DuckDB 锁**：`sync` 运行期间 `query` 会被阻塞 | 有界重试 + `store_locked` 状态；skill 会告知同步窗口 |
| ~~报表粒度未实测~~ | **已实测（2026-09-30，183 次探测）**：10 张报表的粒度**各不相同** —— 多数是每个客服一行，但 **`staff_attendance` 是按客服 × 按小时**，`salaryDetail` 是「一次调用 = 一个客服，且只含窗口的起始日」，而 `data.overview.session` **是实时快照，无法作为历史存储**。`date` 字段在每个接口里含义都不同（恒为 0 / startTime 的回显 / 账号创建时间）→ **日期一律由调用方提供**。见 §6.2 |
| ~~限频粒度未知~~ | **已实测**：大约是 **30 秒冷却**，**按接口（路径）**计，不是全局。**不同路径可以连续背靠背调用 7 次** → 报表按**天**轮转，而不是按接口串行 |
| ~~逐日调用报表的成本~~ | **已更正**：按天轮转后，31 天约 **16 分钟**（原先 2.6 小时的估计错误地假设了串行模型）。完整的一年 365 天仍然需要可中断 + 进度输出 + ETA |
| **报表时间跨度上限不统一** | 实测：**31 天 / 365 天 / 不限**，共三档，且超限错误码在 `14501` / `14004` / `14500` 之间变化，文案中英混杂 → **CLI 必须按接口注册 `maxWindowDays` 并提前校验**，而不是依赖错误码。`transferHuman` 在 364 天时也会报 `Internal error`（边界不稳定），因此**要留余量，上限压到 ≤360 天** |
| **报表的空结果可能是瞬时假象** | 实测：`staffAttendance` 用完全相同的请求体首次调用返回 `{"result":[],"total":0}`，重试后恢复了 17,765 行 → **任何空结果都至少重试一次**再判定为空，否则整个窗口会被静默丢弃 |
| **该传毫秒却传了秒时会静默降级** | `overview` 传入秒值 → **69 个字段中有 49 个变成 `-1`，但 `code` 仍是 200** → 这是最危险的一类陷阱；CLI 必须要求 ISO8601 输入，并在内部转换为毫秒 |
| **回填耗时** | 一年的会话是 61 个六天窗口；报表按天轮转。必须可中断，并带进度输出和 ETA |
| ~~文档缺陷（部分已由实测解决）~~ | **已实测**：`transferHuman` 中 `openapi` 写成双斜杠 → **404；必须用单斜杠**（实测 200 + 真实数据）；工单模板的双斜杠 → **可用**（nginx 全局归一化；三个斜杠也返回 200）；创建客服文档标注为 Content-Type xml → **网关完全忽略该 header，只解析 JSON**（文档笔误）；企业微信切换机器人的路径 → **仍未找到**，标记为 `verified: false`；平台电商类路径中混入了 HTTP method → 注册表必须清理这些 |
| DuckDB 原生绑定分发 | 8 个平台包，没有 node-gyp 兜底，不支持的平台直接硬失败；`node_modules` 约 115MB，冷安装约 9 秒 |
| DuckDB 的 `DELETE` 不回收空间 | 定期 `CHECKPOINT` |
| 质检数据不可得 | 只有推送事件，没有拉取通道 → 已在 §2 声明超出范围 |
| 七鱼变更接口 | 注册表与实现分离 |
| **账号未开通该模块** | 实测：呼叫中心接口返回 `14500 Service Offline`（路径正确，但模块未开通）→ CLI 应把这条 message 特殊处理为「本账号未开通该模块」，而不是当成通用的内部错误 |
| **`robotId` 发现盲区** | 实测：**没有任何 OpenAPI 路径能「完整地」获得 `robotId`** —— 枚举 15 条候选路径全部返回 404，`robot/transfer/config` 返回没有字段的空壳 `{"code":200}`。**⚠️ 这一条被反复翻转了两次，以下是最终版本**：曾认为 `robot/data/knowledge` 可作为发现路径 → 随后被「证伪」（理由：它只返回一个 `robotId`，`isEnd=0`）→ **那次证伪本身就是错的**。**最终版本（通过遍历全部 12,778 行实测）**：该接口按 id 升序返回行，而**前 1,000 行恰好全是默认机器人 Robot A**，所以只看第一页必然被误导；完整遍历后**5 个机器人全部出现**（包括只有 5 行的 Robot E）。→ **它是 API 侧唯一能发现 robotId 的路径，但无法发现知识库为空的机器人**，因此 §11.3 的手工配置**仍然必要**；这个缺口**仍算「已知缺口」，不得记录为「已绕过」** |
| **测试期间的限频饱和（运维提示）** | 多个 Agent 共用一个企业账号时，热点接口（如 `ticket.search`）会**长时间 14009 饱和**：实测对该接口连做一轮 11 次重试，每次都返回 `14009`，而**对照组（不带参数）也同样失败** —— 证明这是**接口级饱和，不是参数问题**（该接口此前曾成功返回 `total=12762` —— 后重新实测为 12778）。→ **对热点接口做长时间重试探测基本只是在烧预算；下一轮应协调配额，而不是更用力地重试** |
| **`robotId` 被静默忽略** | `robot.data.knowledge` 接受 `robotId` 但**既不报错也不生效**（实测：传 1000002 得到的响应与不传完全相同，两者的 `total` 一致）→ 与「传秒值会静默降级」同类。**注册表必须把该参数标记为不支持，并在传入时报错** |
| **知识库首页采样会误导（已经发生过一次）** | `robot.data.knowledge` 按 id 升序返回行，而**前 1,000 行恰好全是默认机器人 Robot A** → 只看第一页会得出「只有一个机器人」的错误结论（这个错误发生过并被翻转了两次；见 §13#14）。**任何关于「全集」性质的断言，都必须先拉到 `isEnd=1`。** 缓解措施：§12 中的 `sync/knowledge` 测试会断言 5 个 robotId 全部出现 |
| **知识库：「行数 ≠ 知识数」** | 12,778 行中有 9,368 行（73.3%）是相似问（`type=10`，`answer` 恒为空）；真正的知识数是 `COUNT(DISTINCT group_id)` = **3,410**。报告 12,778 会虚高 3.75 倍 → **skill 现已带有定义协议（§11.2 C2）** |
| **知识库：两个接口的作用域不同** | `knowledge_items` 是**跨所有机器人的并集**，`knowledge_categories` 是**按 robotId 隔离的**，而 `knowledge_points` 的分类体系与 FAQ 分类树**完全无关**（62 个分类名中只有 1 个噪声级重名）。→ **这三者无法互相推断，也不得 join** |
| **`kpoint.updateTime` 的单位是秒** | 与 `knowledge.updateTime`（毫秒）单位不同。统一按毫秒解析会静默产出 **1970-01-20**（不报错，只是答案错）→ 按接口分别归一化，见 §10.5.7 |
| **`faqType` 与 `fromType` 形似而行为不同** | 名字相似、都是整数、在该租户中都是 `{0,2}` —— 但 `from_type` 的非零值落在该组的标准问行上，而 `faq_type` 的非零值大多落在相似问行上。用同一种模式聚合两者，必然有一个是错的。`db describe` 必须逐字段标注：该值是否在组内恒定、非零值写在哪 |
| **会话/工单数据包含真实客户 PII（必须处理）** | 对全部 4687 行实测：会话导出携带真实客户 PII —— `userName` 出现在 **100%** 的行上，`userPhone` 出现在 **99%** 的行上，此外还有 `userEmail`、`userAddress`、`fromIp`/`userIpCity`，以及 `userCrmInfo`（租户自定义字段的 JSON 字符串 blob）。⚠️ **`userMobile` 不是真实字段名** —— 早期版本列了它；真实名称是 `userPhone`（见 §6.5）。**主要用户是 AI Agent** → 一旦持久化就长期留存，而 Agent 可能把 PII 写进日志、报告或上下文。**缓解措施见 §6.5** |
| ~~会话是否包含机器人会话未经验证~~ | **已实测（2026-09-30）**：`/openapi/export/session` **完整包含机器人会话** —— 单一数据源即可覆盖两类，**不需要第二个数据源**。但**机器人会话占 68.3%**（3201/4687），因此容量和表设计的假设必须相应重新估算；`sessions` 表必须携带 `session_type` 并据此分支（**机器人侧有 25 个字段恒为空，另有 6 个字段恒定** —— 见 §7.5）。判别条件是 `staffId < 0 && != -1`；**必须排除 `-1`**（那些是内部员工会话）。见 §7.5 |
