# qiyu-cli

网易七鱼（Qiyu）开放 API 的命令行封装，**主要用户是 AI Agent，人类是次要用户**。

它把七鱼官方 API 的一堆"对 Agent 不友好"之处抹平成一套可预测的契约：默认输出机器可读的
JSON、用退出码表达该做什么、错误按语义分类、危险操作有硬门禁。有了它，Agent 不必先学会
七鱼 API 的 26 种响应信封、3 种分页和一堆静默失败，就能正确调用。

> **本仓库仍在早期**：已实现「认证 + 通用 API 通道」＋ API 参数校验（`api schema`/body 分级校验）＋ 存储基础（见[当前状态](#当前状态)）。
> 本地数据仓库的**同步**（`qiyu sync`）与**查询**（`qiyu db` / `qiyu query` / `qiyu stats`）均已交付，见[当前状态](#当前状态)。

## 为什么需要它

七鱼官方 API 对自动化调用者有几个系统性的坑，而且大多是**静默**的——不报错，只是答案错了：

| 问题 | 具体表现（均来自只读实测） |
|---|---|
| 响应信封不统一 | `message` 字段的类型横跨 string / object / integer / boolean / array；同一段文本既可能是错误信息，也可能是要二次解析的 JSON 载荷 |
| 分页三套并存 | 游标（`mid`+`isEnd`）、页码（`curPage`/`page`/`offset`）、以及完全不分页；大多数接口不返回 `total` |
| 错误码语义重叠 | 同一错误码（如 `14500`）承载多种含义，靠码分派必然出错；必须按 `message` 精确文本分派 |
| 静默失败 | 时间参数传错单位 → `code:200` 但字段全是 `-1`；`opEnd` 缺省 → 静默返回全量；`robotId` 被静默忽略 |
| 危险操作无区分 | 写接口与读接口在文档里长得一样，误调用不可逆 |

`qiyu-cli` 把这些差异收敛到一个稳定的 CLI 契约里，并让每一次失败都能被 Agent 程序化地处理。

## 安装

需要 Node.js ≥ 20.12（会话导出的 zip 解压依赖 `DecompressionStream('deflate-raw')`，
该格式 Node 20.12 起才被接受；CI 在 20.10 上实测失败后把下限钉在这里）。

```bash
# 作为一次性命令运行（推荐）
npx qiyu-cli --help

# 或全局安装
npm install -g qiyu-cli

# 或从源码构建
git clone https://github.com/MisonL/qiyu-cli.git
cd qiyu-cli && npm install && npm run build
```

> 核心命令（`auth`、`api`）零运行时依赖。`store` / `db` / `query` / `stats` 命令需要
> `@duckdb/node-api`（可选依赖，缺失时会给出安装指引）——`npm install` 会默认安装它。
> 该包含平台原生二进制，实测安装体积约 130 MB。`sync` 命令**零常规运行时依赖**：会话导出的加密 zip 解压走 Node 内置 `DecompressionStream`（zip 容器解析与 ZipCrypto 解密是本仓库内的实现）；`fflate` 仅测试夹具合成加密 zip 用，见 `devDependencies`。

### 装完之后：安装 skill（推荐）

`qiyu` 附带一份 Agent 操作协议（skill），装到 `~/.agents/skills/qiyu` 并链接进各 Agent 的
skills 目录（当前支持 Claude Code 的 `~/.claude/skills` 与 Codex 的 `~/.codex/skills`）。

**当前版本，自动安装基本不会发生**，请直接跑一次：

```bash
qiyu skill install        # 安装 / 更新 skill 正文并建链接
```

原因如实说：`package.json` 里虽有 `postinstall`，但它**只在 npm 全局安装、且不是 npx 调用时**
才尝试安装（判据是 `npm_config_global === 'true'` 且 `npm_command !== 'exec'`）。而
**npm 12 / pnpm 12 / bun 默认阻断安装脚本**；更麻烦的是，以 tarball / `file:` 方式安装时
npm 无法确认可信版本、也就无法 pin 版本，`--allow-scripts` 同样不生效——脚本**根本没跑**
（npm 仍退 0，只有一行 warn，极易被当成成功）。npx 场景下它还会主动跳过（不往你的 home 写东西）。
所以**不要指望 postinstall：直接运行 `qiyu skill install`**。

安装是幂等的：正文一致时不动正文（清单缺失或损坏时会补写 `.qiyu-skill.json`）；要覆盖
你改过的正文得加 `--force`。其他子命令：
`qiyu skill where` 报告实体目录与各 Agent 的链接状态（只读，不修复），并给出**已安装那份
正文**的契约号与兼容判定（`data.entity.installed.compatible`，与 `data.cli_contract_version`
比较；判定不了时为 `null`，不是 `false`）；`qiyu skill check`
校验 skill 引用的命令/表/错误 kind 是否仍存在（有违规退出码 1，CI 可跑；`--compare` 模式下
两份正文内容不一致、或已安装那份不可用，同样退 1）。

> 兜底提示：若 skill 未安装或已过期，`qiyu` 每次成功输出都会在 `meta.warnings` 里提醒
> 「未安装 / 已过期」——提示只写进 JSON，不改退出码。

## 配置凭证

凭证通过环境变量读取：

```bash
export QIYU_APP_KEY=你的AppKey
export QIYU_APP_SECRET=你的AppSecret
```

在七鱼控制台「设置 → 开放平台」可以找到这一对密钥。检查是否已配置：

```bash
qiyu auth whoami
# {"ok":true,"data":{"configured":true,"source":"env","profile":"default","robots":[]}}
```

也可以把凭证**写进配置文件**，之后就不必每次 export：

```bash
export QIYU_APP_KEY=... QIYU_APP_SECRET=...
qiyu auth login                      # 写入 default profile
qiyu auth login --profile staging    # 写入指定 profile
```

`auth login` 只从**环境变量**读凭证——不接受 `--app-key`/`--app-secret`（命令行参数会留在
shell 历史与 `ps` 输出里）。它把配置写到 `~/.config/qiyu/config.json`（目录 `0700`、文件 `0600`），
合并保留该 profile 下已有的 `store`/`robots` 键，且**绝不回显**凭证（连末四位都不）。
配置文件是符号链接时拒绝写入（防止穿透到任意路径）。

凭证的两个来源都支持，优先级是**环境变量 > 配置文件**。两边各给一个也是合法的，
此时 `auth whoami` 的 `source` 报 `mixed`。

存储配置仍是**手工编辑** `~/.config/qiyu/config.json`；也可用 `--db`/`QIYU_DB_PATH` 直接指定库路径。

配置文件的完整结构（**顶层 / profile / store 三层的键名写错会被拒绝，退出码 2**）：

```json
{
  "defaultProfile": "default",
  "profiles": {
    "default": {
      "store": {
        "path": "~/.qiyu/duckdb/qiyu.duckdb",
        "backend": "duckdb",
        "readOnlyRetryMs": 30000,
        "batchSize": 1000,
        "options": { "knowledgeRobotIds": [1000001] }
      },
      "credentials": { "appKey": "…", "appSecret": "…" },
      "robots": { "1000001": "机器人A" }
    }
  }
}
```

- 顶层只认 `defaultProfile` 与 `profiles`；profile 内只认 `store`/`credentials`/`robots`；
  `store` 内只认上面那五个键。**没有 `store` 这一层之外的简写** —— 例如
  `knowledgeRobotIds` 必须在 `profiles.<name>.store.options` 里，放到 `profiles.<name>` 下会被拒绝。
- ⚠️ `profiles.<name>.store.options` 的内层键**不做未知键校验**（内容由消费方解释）：在它里面把
  `knowledgeRobotIds` 拼成 `knowledgeRobotId` 不会被拒绝，只会静默不生效。改这一块时请对照
  上面的示例逐字核对。
- `credentials` 由 `qiyu auth login` 写入（也可手写）；**`store` 与 `robots` 只能手写** ——
  `auth login` 会保留已有的 `robots` 映射，但不会创建或更新它。
- **profile 的选择顺序**：`--profile` > `QIYU_PROFILE` > 顶层 `defaultProfile` > 内置 `default`。
  点名的 profile **必须存在于 `profiles` 里**：`--profile prodd`（拼错）或 `defaultProfile`
  指向不存在的名字会被拒绝（退出码 2，错误里列出已有的 profile），**不会静默回落到默认库**。
  刻意保留的回落只有四种：配置文件不存在（首次运行）、`profiles` 为空、profile 存在但没写
  `store` 块（用内置默认路径）、未点名任何 profile 时直接用内置 `default`（它不在
  `profiles` 里也不报错）。空串口径：`--profile ''` 是 usage 错误；`QIYU_PROFILE=` 与
  `"defaultProfile": ""` 视为未设置。

**权限规则**：配置文件**含凭证**且 group/other 可读（如 `0644`）时，**任何读取配置的命令都会
拒绝读取**（`kind: config_insecure`，退出码 1，hint 点名要执行的 `chmod`）——因为落盘的
appSecret 对同机其他用户可读。不读配置的命令（`--version`、`api list`、`skill where`、
`sync tasks` 等）不受影响，它们不碰凭证。不含凭证的文件维持「只在 stderr 警告、不阻断」。
父目录 group/other **可写**（文件可被整体替换）时同样拒绝。`auth login` 是**唯一的例外**：
它不拒绝，而是把已有文件重写为 `0600`（马上要写入新的 secret，拒绝没有意义），写完自检
不合格才报 `config_insecure`。Windows 上跳过这些检查。数据库正常关闭后 `.wal` 临时文件会
自动消失，请勿手工删除。

> ⚠️ `whoami` **只检查凭证是否存在**，不校验它是否有效——一个拼错的 AppKey 同样返回
> `configured: true`。第一次真实调用才是唯一的验证。
>
> `whoami` 输出的 `robots` 来自配置里的 `profiles.<name>.robots`（`{"1000001":"机器人A"}` 形态），
> 同样**未校验有效性**。它是 `sync run` 的兜底来源：`profiles.<name>.store.options.knowledgeRobotIds`
> 缺席时，知识库类目同步会用这些 id 驱动（`knowledgeRobotIds` 优先）。

## 使用

```bash
# 列出可主动调用的接口
qiyu api list

# 连同不可主动调用的接口（入站推送等）一起列出
qiyu api list --all

# 调用一个接口
qiyu api call ticket.search --body '{"opStart":1730000000000,"opEnd":1730100000000}'

# 危险接口（写/破坏性操作）必须显式确认
qiyu api call message.send --body '{...}' --yes
```

### 命令一览

```
qiyu auth whoami                     检查凭证是否已配置（来源/robots）
qiyu auth login [--profile <name>]   把环境变量里的凭证写入配置文件
qiyu api list [--all]                列出接口
qiyu api call <id> [--body <JSON>] [--yes] [--no-validate] [--strict]
                                     调用接口
qiyu api schema <id>                 查看接口参数表与响应形状
qiyu store init [--db <path>] [--profile <name>] [--backend <name>]
                                     初始化本地数据库（DuckDB）
qiyu store status [--db <path>] [--profile <name>] [--backend <name>]
                                     查看数据库状态与各表行数
qiyu sync tasks                      列出全部同步任务（含敏感列清单）与不支持的数据集
qiyu sync run [任务...] [--full] [--since T] [--until T] [--quiet]
                                     同步数据进本地库（缺省全部任务；进度走 stderr）
qiyu sync status [任务...]           水位、区间状态（resolved_range）、缺口（gaps）、锁
qiyu sync verify [任务...]           核对本地与远端一致性（drift 非空退出码 1）
qiyu sync install --schedule CRON [--yes]
                                     安装系统调度条目（默认 dry-run）
qiyu sync uninstall [--yes]          移除系统调度条目（默认 dry-run）
qiyu db tables                       本地表清单 + 粒度 + 行数 + 数据时间范围 + PII 列
qiyu db describe <表>                列名/类型/可空/敏感标记/观测枚举/时间列/单位
qiyu query --sql <SQL>               任意只读 SQL（三层沙箱 + 默认脱敏 + 行数上限 + 超时）
qiyu query --table <表> [--since T] [--until T] [--group-by <列>]
                                     受约束查询通道（列白名单、时间列语义化、精确脱敏）
qiyu stats fields <报表>              指标自描述（声明 + 本地观测分布 + -1 哨兵）
qiyu skill install [--dir <path>] [--link <agent>]... [--no-link] [--force] [--dry-run]
                                     安装 skill 正文并链接进各 Agent 的 skills 目录
qiyu skill check [--installed [--dir <path>] | --compare [--dir <path>]]
                                     校验 skill 引用的命令/表/错误 kind（有违规退出码 1；
                                     --compare 下内容不一致也算失败）
qiyu skill where [--dir <path>]      报告实体目录与各 Agent 链接状态（只读，不修复），
                                     并报已安装正文的契约号与 compatible 判定
qiyu --version                       包版本 + skill_contract_version
```

## 输出契约

这是本项目的核心。Agent 靠**退出码**和 **stdout 的 JSON** 做决定，不解析人类文本。

### 成功

```json
{"ok":true,"data":<接口载荷>}
```

`ok` 与 `data` 两个键恒在：`data` 即使为空也写成 `null`（不会整个消失），这样 Agent 能区分
"接口无载荷"与"我解析错了"。`meta` **不是恒在的**——只在命令有元数据要报时才出现
（`query` 的 `rows`/`resolved_range`、`db tables` 的 `notice` 等），或 skill 安装态
有待提醒时经 `meta.warnings` 进来。没有任何可报内容的成功输出就只有 `{ok, data}`
两个键（如无 skill 提示时的 `--version`、`store status`、`sync tasks`）——
**读 `meta` 前先判存在**，键不出现 = 没有这项信息（与下方
失败信封的可选键同一纪律），不是 `null`、更不是解析失败。

### 失败

```json
{"ok":false,"error":{"code":"...","kind":"...","retryable":false,"message":"...","hint":"..."}}
```

**请按 `kind` 分支，不要按 `code`。** `code` 只是个标签：它可能是服务端的数字码
（如 `14009`），也可能是本 CLI 合成的词（`usage` / `network` / `internal` /
`auth_missing` / `confirm_required` / `store_locked` / `store_not_initialized` /
`local_rate_limit` / `query_error` / `sandbox_blocked` / `query_timeout` / `unknown`）。
合成词在官方错误码表里查不到；完整清单见 `qiyu --help`。

错误信封还可能有这几个**可选**键（缺省即不出现该键）：

- `retry_after: {seconds, source}` —— 建议等待秒数与它的来源（`observed` 实测 /
  `doc` 文档值 / `local` 本地令牌桶 / `fallback` 保守兜底）
- `retry_strategy` + `fallback` —— **只在 `api call` 撞限流、且该接口非危险操作、
  有对应本地表、本地库文件存在时出现**：`"switch_to_local"` + 一条
  `qiyu query --table <表>` 命令。⚠️ 表存在**不等于**已同步或覆盖你要的时间窗，
  先 `qiyu db tables` 看行数、`qiyu sync status` 看水位再采信（`hint` 里也写了这句）
- `confirm_required` / `confirm_arg` / `risk` / `target` —— 退出码 4 的四件套

`api schema <id>` 的 `data.rate_limit` 是**三态**：不出现该键 = 该接口未登记在本地限频表
（没测过）；`null` = 实测无限制；对象 = 有限频（含 `scope`，当前恒为 `endpoint`）。

### 退出码

| 退出码 | 含义 | Agent 该做什么 |
|---|---|---|
| `0` | 成功 | 读 `data` |
| `1` | 业务错误 | 看 `kind`/`retryable` 决定重试或上报 |
| `2` | 用法错误 | 改参数重来（`--strict` 误拒除外——那是本地参数表未收录，不要删字段重试） |
| `3` | 网络错误 | 退避后重试 |
| `4` | 需要 `--yes`（写接口仍需显式确认） | **停下来，向人类确认** |

### 用法错误是双通道的

用法错误的**同一句话**会同时写到 `stderr`（给人看）和 `stdout` 的 `{ok:false,error}`
（给 Agent 看）。所以无论人还是 Agent，都不会读到空输出。

### store 命令的输出

`store init` 与 `store status` 成功时输出六字段：`path` / `backend` / `config_path` /
`config_exists` / `schema_version` / `tables`。其中 `tables` 是 `[{name, rows}]` 数组——
每张表的名字与行数。`store status` 的每次调用都要对各表做全表 `COUNT`（行数无缓存），
轮询代价与数据量成正比，Agent 不应把它当作高频健康检查来用。

### sync 命令的输出

`sync run` 的 stdout 是 `{tasks:[...], truncated:false}`，每个任务含 `task` / `status`
（complete/partial/failed）/ `windows`（`{total, succeeded, failed, skipped}`，
`total = succeeded + failed + skipped`，`skipped` 是跳过的残段窗数，见下）/ `rows` /
`resolved_range`（Asia/Shanghai 的 `+08:00` ISO 二元组）/ `watermark` / `last_synced_at` /
`gaps` / `notes`。`gaps[].range` 与 `resolved_range` 同形态（同一套时间解析）；
`notes` 是中文说明数组（恒在，常为空），例如「请求区间早于接口可得数据的最早边界」
——把「区间不可得」与「同步故障」分开。

**`ok` 与退出码的双轨语义**：`ok:true` 表示「命令已产出结果」，**退出码才是成败的权威
判据**。全失败（退出码 1）与 `sync verify` 的 drift 非空（退出码 1）时 stdout 仍是
`{ok:true,data:...}`——缺口/漂移就是它要报告的内容。请先看退出码，再看 `data`。

`sync status` 每任务输出 `{task, watermark, range_status, last_synced_at, resolved_range,
gaps, gaps_count, locked}`：`resolved_range` 是上次成功推进覆盖的区间（形态同 run 的
`resolved_range`），`gaps` 是历史缺口逐条 `{range, reason, detail, recorded_at}`。
`sync verify` 输出 `{task, local_rows, expected_from_api, state_windows_consistent, drift}`：
**`expected_from_api` 只对快照任务有意义**（上游 fetch 的行数）；windowed 任务不做上游
全量重拉，该字段恒为 `null`，核对方式是「本地行数 ↔ sync_state 成功状态」的一致性
（`state_windows_consistent`）——两种任务的核对方式不同，读 drift 前先看任务 kind。
`sync tasks` 每任务含 `sensitive_columns`——该表标注为敏感的 PII 列清单（会话/工单的
`payload` 列在列内，它是整行 PII 的完整副本，不要 `SELECT *`）。本阶段**没有**任务的
启用/停用机制：注册表里的任务总是全部执行（选定任务靠命令行显式列出）。

**聚合报表按天切片（窗口 1 天）**：九个报表接口返回的是**窗口聚合值**（`overview` 一行
全局汇总、`staffworklod` 每客服一行、`transferHuman` 恒 1 行），响应里的 `date` 原文是
"this date has no specific meaning, it only indicates the start time of the current query"
——多天窗口会把 N 天汇总标成某一天（`daily_overview` 的「每日概览」会读到 31 天累计值）。
所以窗口上限是 **1 天**（唯一例外：`staff_attendance`/考勤响应逐行带可信小时戳，保持
31 天窗口、`stat_date` 按该行时间戳推导）。**代价如实写在明处：窗口数 = 天数**，
`sync run --full` 对报表任务会从 1970 起切出**上万窗**（≈ 56 年 × 每天 1 窗，每窗至少
一次调用）——首跑与回补历史请用 `--since/--until` 限定区间（如 `--since 30d` = 30 窗/任务）。

**窗口端点按上海日界对齐**：8 个 `stat_date` 为主键的报表任务（考勤除外）的窗口对齐
上海自然日 0 点（`windowAlign: 'shanghaiDay'`）——水位续跑（`watermark+1ms`）或任意时刻
`--since` 产生的「错相位窗」（如 `[今天18:23, 明天18:23)`）只写一行 `stat_date` 却装着
跨两天聚合、还会把「明天」日的行删掉不重写。对齐后：**实际拉取的每窗恰是一个完整上海
自然日**，按日增量的「每日概览」日行恒为全天值。**显式区间的非日界首末段是残段窗**（如
`--since 30d` 的首段 `[起点, 次日0点)` 与末段 `[昨天0点, 终点)`、`--full` 起点钳出的
16 小时段）——引擎**跳过不落库**（半日聚合不写日行，避免覆盖该日的整日聚合值；
`windows.skipped` 如实计数、每窗一条 stderr 进度行）。**末残段**的整日值**可能**由其
请求区间覆盖该整天的日对齐 run 补全（水位停在最后一个整日窗末端；若下一轮的请求区间
仍未覆盖该整天，该段仍是残段、继续跳过——不保证「下一次 run」就补上）；
**首残段**不落日行也**不补**——该半日段没有合法落点（写入即半日覆盖整日），属显式
`--since` 的边界语义（`windows.skipped` 与 stderr 进度行如实可见），要覆盖该日请给
更宽的 `--since`（起点落到该日 0 点或更早；`resolved_range.start` 的前缀不会自动前移）。
`resolved_range.start` 是**水位起点语义**（含可能被跳过的首残段前缀，≤ 1 天、不会
自动前移），表内首个整日行可能是 `> start` 的次日——读方按 `resolved_range`
的 end（水位）与 `skipped` 判断真实覆盖。
末窗终点被 `--until` 钳制（窗数至多多 1）。

**`sync install` 与调度环境**：调度条目不继承你的 shell 环境——launchd 的用户域不含
shell rc 变量。存储定位走环境变量（`QIYU_DB_PATH` 等）时，install 会把**解析出的绝对
路径/名称固化为调度命令的 `--db/--profile/--backend` 参数**（显式 flag 优先；只走配置
文件或默认值时不固化，调度任务自己读得到 HOME 下的配置文件）。若凭证走
`QIYU_APP_KEY`/`QIYU_APP_SECRET`，请确认其对该调度上下文可用——调度条目**不写入任何
凭证**（秘密进 plist/unit 文件是安全红线）。

### 查询命令的输出

五个查询命令都走同一个信封 `{ok,data,meta}`，`meta` 恒含 `warnings`（可为空数组）——
**0 行不等于没有数据**：**带时间过滤**而结果 0 行时，`warnings` 会说明「同步可能未覆盖该区间」，
而不是让你据此得出「那段时间真的没数据」。触发条件是**逐个判定的**：`--table` 通道给了
`--since`/`--until` 即触发；`--sql` 通道仅当 SQL 文本引用了业务时间列名
（`stat_date` / `work_date` / `hour_ts` / `startTime` / `endTime`）才触发——它与子句位置无关，
`WHERE stat_date > '…'` 也算；用**其它**列（如 `createtime`）的 `WHERE` 过滤出的 0 行不附带此警告。

`query --sql` 与 `query --table` 的 `data` 形态是 `{columns, rows}`（`rows` 为对象数组）；
`meta` 恒含：
`rows`（截断后的实际行数）/ `truncated`（是否被 `--limit` 截断）/ `limit_applied`（生效上限）/
`masked`（本次是否脱敏）/ `masked_columns`（**实际被改写**的列名，全 null 的列不算）/
`mask_warnings`（脱敏缺口警告）/ `resolved_range` / `data_coverage` / `warnings`。

- `--table` 通道的输出顺序是**确定的**：无 `--group-by` 时，**有时间列的表**按时间列降序、
  再按主键升序（`--limit` 截到的因此是**最新**的那些行）；**无时间列的表**只能按主键升序。
  有 `--group-by` 时按 `count` 降序、分组列升序。
- `resolved_range`：`--table` 给了 `--since`/`--until` 时回显**实际生效**的区间
  （`+08:00` ISO 二元组），不是原始输入——`iso-day` 表会向下取整到上海自然日，
  所以要按它判断覆盖了哪几天。`--sql` 通道恒为 `null`（任意 SQL 无法通用判定）。
- `data_coverage`：该表时间列在**过滤范围内**的 MIN/MAX（`+08:00` ISO）；`--sql` 通道恒为 `null`。
  它有三种 `null` 成因，用 `resolved_range` 与 `warnings` 区分：`--sql` 通道 / 该表无时间列 /
  有过滤范围但范围内一行都没有。
- **`--sql` 通道的数值是 JSON 安全形态的字符串**：`COUNT(*)` / `SUM` / `BIGINT` / `HUGEINT` /
  `DECIMAL` 一律输出字符串（如 `"n":"12"`、`"d":"1.50"`），这是驱动为避免精度丢失的取舍。
  做算术或比较前先转数字（`Number(x)`）；`--table --group-by` 的 `count`、`db describe` 的
  `row_count`、`stats fields` 的 `observed` 则都是数字——两种口径不同，别混用。
- **`iso-day` 列在库内是 UTC `…Z` 形态**（上海日零点 = 前一日 16:00Z），而所有元数据出口
  （`db tables.time_range`、`db describe` 的 `unit`、`resolved_range`、`data_coverage`）呈现
  的是 `+08:00` 形态。`--table` 通道已处理取整语义；**`--sql` 里直接按字符串比较时要用 UTC 形态**，
  否则会少算一天（如 `WHERE stat_date >= '2026-10-12T16:00:00.000Z'`）。检测到
  「iso-day 列 + 日期形态字面量」时 `meta.warnings` 会明确提示。
- `db tables` / `db describe` 的 `meta.notice` 恒在（本库含客户 PII 的提示）；
  声明与实况不一致（缺表/缺列/多列/时间列脏值）逐条进 `meta.warnings`，不静默——`db tables` 做表级
  与列集核对，`db describe` 给出该表的逐列差异细节。时间列里不符合约定形态的值**不进**
  `time_range`（否则 `not-a-date` 会在字典序上赢下 MAX），并由 warning 点名数量。

`stats fields <报表>` 的输出把**声明**与**观测**分开：`declared`（每条带 `source`：
`design-doc` 实测 / `name-suffix` 命名推断）、`observed`（`rows_present` / `minus_one` /
`nulls` / `min` / `max`）、`unknown_fields`（判不出单位的字段）、`sentinel`
（`-1` = 该窗口或筛选条件没有匹配到数据，**不是负数比率**）。`-1` 是厂商未文档化的哨兵值，
`observed.minus_one` 与 `rows_present` 相等时说明该字段本次全是哨兵。
⚠️ 这是**聚合观测，不是逐行取值**：`rows_present` 为 1 时 `min` 与 `max` 都等于那一行的原值
（例：薪资明细表只有一行时，极值就是该行金额）；`min`/`max` **排除 `-1` 哨兵**，因此某字段
全是 `-1` 时两者均为 `null`（此时看 `minus_one`）。需要逐行数据请用 `query --sql` 并自行承担
脱敏边界；payload 不是合法 JSON 的行不计入统计，**含空字符串键 `""` 的行仍计入该行其它字段**
（只跳过那个键本身），两者都会在 `meta.warnings` 里点名数量。

## 安全

- **危险操作硬门禁**：标记为 `dangerous` 的接口在缺少 `--yes` 时，**绝不发出任何请求**：body 合法则返回退出码 4，body 缺必填/非对象则**先**报参数错误（退出码 2），并给出 `confirm_required` / `confirm_arg` / `risk` / `target` 四个字段。
  危险接口不可自动重试——避免人工确认过的不可逆操作被自动重放。
- **凭证绝不外泄**：`appKey` / `appSecret` / `checksum` 在所有输出（含错误消息与 stderr）中
  都会被抹成 `<已隐藏>`。`auth whoami` 连末尾四位都不回显。
- **服务端内部信息过滤**：服务端偶发的错误消息里会泄漏 Java 包名/类名与请求 id，
  透出前一律替换为占位符。
- **查询默认脱敏**：`query` 两条通道都默认脱敏（`sensitive: true` 的列），
  要原始值必须显式 `--no-mask`（此时 `meta.warnings` 追加 PII 风险提示）。
  脱敏的边界如实写在明处：`--table` 通道是**精确**的（列名来自 `TABLES` 元数据）；
  `--sql` 通道是「列名级 + 值级兜底」，**别名绕过时姓名/地址无法值级检测仍会漏**——
  这类情形会在 `meta.mask_warnings` 里点名（是警告不是防护），要完整覆盖请用 `--table`。
  两个已知缺口同样进 `meta.mask_warnings`，不会静默：**`--sql` 不按列名脱敏 `payload`**
  （报表 payload 是聚合数字，整值替换会误杀；会话/工单的 payload 只靠值级检测，
  其中的姓名/地址会原样输出——SQL 里出现 `payload`、输出含该列、或输出含整行 JSON 值
  即警告，别名 `payload AS p`、`json_extract(payload,…)`、`row_to_json(t)` 都覆盖）；
  **`--table` 通道对 `TABLES` 之外的列不脱敏**
  （库中多出来的列可能来自旧版 CLI，只警告不改写）。
  ⚠️ 这些是**警告不是防护**：`--sql` 通道的 payload 缺口只能靠 Agent 读到警告后改用
  `--table` 或 `--no-mask` 显式承担风险来闭合，CLI 无法在保持报表 payload 可用的前提下
  替你做整值替换。
- **只读沙箱三层缺一不可**：`query --sql` 只接受单条只读语句（`SELECT` / `DESCRIBE` / `SHOW` / `EXPLAIN`——
  后两者实测归入 `statementType` 的 SELECT/EXPLAIN 类型值），
  每实例首次连接时 `enable_external_access=false` + `lock_configuration=true`，
  实例 `access_mode=READ_ONLY`。文件读写、网络、`ATTACH`、`COPY TO`、多语句全部被拦；
  `EXPLAIN ANALYZE` 也拒（它会真正执行内层语句）。

## 当前状态

本仓库已交付设计稿中的**前六个子项目**：认证与通用 API 通道、API 参数校验
（`api schema`/body 分级校验）、存储层、同步引擎、查询接口与只读沙箱、Skill 化
（`qiyu skill install` / `skill check` / `skill where`，见上方「装完之后：安装 skill」）。

**已实现**：`auth whoami`、`auth login`（从环境变量写入配置文件，原子写 + `0600`）、`api list`、`api call`、`api schema`、完整的错误分类与脱敏、危险门禁、
限频感知（`retry_after`）、本地数据仓库——`store init` / `store status`（存储层已交付，
含 `Store` 抽象、DuckDB 后端、schema 迁移与 `store_locked`/`store_not_initialized` 错误分类）
与同步引擎——`sync tasks` / `sync run` / `sync status` / `sync verify` / `sync install` / `sync uninstall`
（21 个任务覆盖维度/报表/工单/会话/知识库数据集；增量水位、断点续跑、缺口记录、本地限频冷却持久化、
跨平台调度安装；会话导出走 create→poll→download→unzip→parse 流水线）。
`sync install` 的安装前置是**至少成功同步过一次**（sync_state 有 `range_status=complete`
或 `last_synced_at` 非空的行——全败的 run 只留 pending，不算跑通）。
查询与只读沙箱——`db tables` / `db describe` / `query --sql` / `query --table` / `stats fields`
（三层只读沙箱、默认脱敏、时间列三形态语义化、`-1` 哨兵呈现、声明与观测分离）。
Skill 化——`skill install`（复制正文 + 建 Agent 链接，幂等，`--dry-run` 只算计划）/
`skill check`（校验正文引用的命令、表名、错误 `kind` 与位置参数取值是否仍存在；
`--installed`/`--compare` 改基准；有违规退出码 1，`--compare` 下内容不一致也算失败）/
`skill where`（只读报告实体目录与各 Agent 链接四态：
`ok`/`missing`/`dangling`/`foreign`，无法判定时报 `unknown` 而非「不存在」），
外加 `qiyu --version`（输出包版本与 `skill_contract_version`）。

body 分级校验：`api call` 的 `--body` 与注册表参数表比对——缺必填拒绝（退出码 2），
未知字段/类型不符出 `meta.warnings`；`--strict` 可升级、`--no-validate` 可关闭。
参数表见 `qiyu api schema <id>`（`data.params`、`data.response_shape`）。
只依据文档生成的参数表，不构成对服务端行为的保证；**响应体不做校验**；
校验只对 `body_kind: json` 且有 body 参数表的接口生效，其余原样透传。
`--strict` 只做本地参数表闭集一致性检查（「严格」≠「正确严格」），误拒时**不要删字段重试**。

**输出格式**：所有命令默认输出紧凑 JSON（一行、可解析）。`--pretty` 输出缩进 JSON（人类可读）——
写在**具体子命令之后**（如 `qiyu api list --pretty`）。Agent 不需要它：默认输出已是合法 JSON，
缩进只是给人看的。用法错误（退出码 2）仍是紧凑 JSON —— 先修参数，再看格式。

`api list` 输出的 `meta.registry_complete` 会如实反映注册表是否已收录全部接口。

## 浏览器 / 文档

完整的接口语义、字段行为、限频与错误码的实测记录，见
[`docs/qiyu-cli-design.md`](docs/qiyu-cli-design.md)。

## 开发

```bash
npm install
npm run typecheck         # 类型检查（含测试）
npm test                  # 运行测试（默认 4 分片并行，≈50s）

# ⚠️ 每个分片内部仍是**单进程单 worker**。vitest.config.ts 写死 maxWorkers: 1 +
#    fileParallelism: false，分片 runner 也照传这两个参数——不要去掉。
#    分片数是固定值（默认 4，上限 8），不随 CPU 数放大：2026-10-05 的内存耗尽事故
#    根因是「无界循环 × 无界增长」，不是并发本身。

QIYU_TEST_SHARDS=1 npm test   # 单片串行（≈110s，排查时序问题或复现 CI 时用）
npm run test:single           # 等价写法
QIYU_TEST_SHARDS=8 npm test   # 更多分片（16 核机器上收益递减）
QIYU_TEST_HEAP_MB=1024 npm test   # 收紧每片 Node 堆上限（默认 2048）
```

测试覆盖了响应信封归一化、错误分类、签名、脱敏、限频、注册表校验、CLI 契约等。
所有对外部 API 的调用都用 mock，**测试不联网**。

CI（`.github/workflows/ci.yml`）在 push/PR 到 `main` 时对 Node 20.12（engines 下限）、
22（维护期 LTS）与 24（当前 LTS）跑 `npm ci` → `npm run typecheck` → `npm test`；测试并发
限制来自 `package.json` 的 test 脚本，CI 不另传并发参数。

除上述三步外，CI 还会在**最低版本矩阵项**跑一次**发布产物门禁**（`npm run check:pack`）：
用 `npm pack --dry-run --json` 取真实包内容，断言 skill 正文逐篇在包内、`dist/postinstall.js`
存在、`dist/core/edition.js` 的版本已注入且与 `package.json` 一致。它防的是「构建脚本退化
（例如 build 只剩 tsc）时功能测试仍全绿、发布包却静默缺文件」——`npm test` 直接 import
`src/**`，从不触碰构建产物，只有这一步会。本地想跑同一条门禁：`npm run check:pack`。

### 目录结构

```
src/
  cli.ts                入口与顶层分派
  output.ts             输出契约（ok / fail / usageFail，退出码）
  store/                存储抽象（src/store/：Store 接口、DuckDB 后端、schema 与迁移）
  sync/                 同步引擎（src/sync/：引擎、状态、限频门、窗口切分、任务注册表与 21 个任务）
  query/                查询层（src/query/：三层只读沙箱、脱敏、错误分派、表查询构造、指标目录）
  schedule/             跨平台调度安装（launchd / systemd / schtasks）
  commands/             子命令（auth / api / store / sync / db / query / stats）
  core/
    sign.ts             七鱼签名（checksum = SHA1(appSecret + md5(body) + time)）
    http.ts             请求构建、重试、限频
    envelope.ts         响应信封归一化
    errors.ts           按 message 文本的错误分类
    credentials.ts      凭证解析与脱敏
    ratelimit.ts        逐接口限频表
    registry/           接口注册表（specs.json、validate.json、params/）
docs/                   设计文档与实施计划
tests/                  测试
```

## 许可

[MIT](LICENSE)
