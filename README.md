# qiyu-cli

网易七鱼（Qiyu）开放 API 的命令行封装，**主要用户是 AI Agent，人类是次要用户**。

它把七鱼官方 API 的一堆"对 Agent 不友好"之处抹平成一套可预测的契约：默认输出机器可读的
JSON、用退出码表达该做什么、错误按语义分类、危险操作有硬门禁。有了它，Agent 不必先学会
七鱼 API 的 26 种响应信封、3 种分页和一堆静默失败，就能正确调用。

> **本仓库仍在早期**：已实现「认证 + 通用 API 通道」＋ API 参数校验（`api schema`/body 分级校验）＋ 存储基础（见[当前状态](#当前状态)）。
> 本地数据仓库的**同步**（`qiyu sync`）已交付，见[当前状态](#当前状态)；**查询**（`qiyu query`）尚未实现。

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

> 核心命令（`auth`、`api`）零运行时依赖。`store` 命令需要 `@duckdb/node-api`（可选依赖，缺失时会给出安装指引）——`npm install` 会默认安装它。该包含平台原生二进制，实测安装体积约 130 MB。`sync` 命令**零常规运行时依赖**：会话导出的加密 zip 解压走 Node 内置 `DecompressionStream`（zip 容器解析与 ZipCrypto 解密是本仓库内的实现）；`fflate` 仅测试夹具合成加密 zip 用，见 `devDependencies`。

## 配置凭证

凭证通过环境变量读取：

```bash
export QIYU_APP_KEY=你的AppKey
export QIYU_APP_SECRET=你的AppSecret
```

在七鱼控制台「设置 → 开放平台」可以找到这一对密钥。检查是否已配置：

```bash
qiyu auth whoami
# {"ok":true,"data":{"configured":true}}
```

存储配置需**手工编辑** `~/.config/qiyu/config.json`——CLI 目前不会自动创建该文件（`auth login` 尚未实现）。也可用 `--db`/`QIYU_DB_PATH` 直接指定库路径。**凭证字段暂不支持写入该文件（会报未知键），请继续用 `QIYU_APP_KEY`/`QIYU_APP_SECRET` 环境变量。**若配置文件权限过宽（group/other 可读），CLI 会在 stderr 给出警告但不阻断执行；数据库正常关闭后 `.wal` 临时文件会自动消失，请勿手工删除。

> ⚠️ `whoami` **只检查凭证是否存在**，不校验它是否有效——一个拼错的 AppKey 同样返回
> `configured: true`。第一次真实调用才是唯一的验证。

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
qiyu auth whoami                     检查凭证是否已配置
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
```

## 输出契约

这是本项目的核心。Agent 靠**退出码**和 **stdout 的 JSON** 做决定，不解析人类文本。

### 成功

```json
{"ok":true,"data":<接口载荷>,"meta":{...}}
```

三个键恒在。`data` 即使为空也写成 `null`（不会整个消失），这样 Agent 能区分
"接口无载荷"与"我解析错了"。

### 失败

```json
{"ok":false,"error":{"code":"...","kind":"...","retryable":false,"message":"...","hint":"..."}}
```

**请按 `kind` 分支，不要按 `code`。** `code` 只是个标签：它可能是服务端的数字码
（如 `14009`），也可能是本 CLI 合成的词（`usage` / `network` / `internal` /
`auth_missing` / `confirm_required` / `store_locked` / `store_not_initialized` /
`local_rate_limit` / `unknown`）。合成词在官方
错误码表里查不到。

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

## 安全

- **危险操作硬门禁**：标记为 `dangerous` 的接口在缺少 `--yes` 时，**绝不发出任何请求**：body 合法则返回退出码 4，body 缺必填/非对象则**先**报参数错误（退出码 2），并给出 `confirm_required` / `confirm_arg` / `risk` / `target` 四个字段。
  危险接口不可自动重试——避免人工确认过的不可逆操作被自动重放。
- **凭证绝不外泄**：`appKey` / `appSecret` / `checksum` 在所有输出（含错误消息与 stderr）中
  都会被抹成 `<已隐藏>`。`auth whoami` 连末尾四位都不回显。
- **服务端内部信息过滤**：服务端偶发的错误消息里会泄漏 Java 包名/类名与请求 id，
  透出前一律替换为占位符。

## 当前状态

本仓库实现了设计稿中的**前两个子项目**：认证与通用 API 通道、API 参数校验（`api schema`/body 分级校验）。

**已实现**：`auth whoami`、`api list`、`api call`、`api schema`、完整的错误分类与脱敏、危险门禁、
限频感知（`retry_after`）、本地数据仓库——`store init` / `store status`（存储层已交付，
含 `Store` 抽象、DuckDB 后端、schema 迁移与 `store_locked`/`store_not_initialized` 错误分类）
与同步引擎——`sync tasks` / `sync run` / `sync status` / `sync verify` / `sync install` / `sync uninstall`
（21 个任务覆盖维度/报表/工单/会话/知识库数据集；增量水位、断点续跑、缺口记录、本地限频冷却持久化、
跨平台调度安装；会话导出走 create→poll→download→unzip→parse 流水线）。
`sync install` 的安装前置是**至少成功同步过一次**（sync_state 有 `range_status=complete`
或 `last_synced_at` 非空的行——全败的 run 只留 pending，不算跑通）。

body 分级校验：`api call` 的 `--body` 与注册表参数表比对——缺必填拒绝（退出码 2），
未知字段/类型不符出 `meta.warnings`；`--strict` 可升级、`--no-validate` 可关闭。
参数表见 `qiyu api schema <id>`（`data.params`、`data.response_shape`）。
只依据文档生成的参数表，不构成对服务端行为的保证；**响应体不做校验**；
校验只对 `body_kind: json` 且有 body 参数表的接口生效，其余原样透传。
`--strict` 只做本地参数表闭集一致性检查（「严格」≠「正确严格」），误拒时**不要删字段重试**。

**尚未实现**（调用时会**明确报错**，不会静默假装成功）：

- `auth login`（配置文件写入）——目前只支持环境变量；
- `--pretty`（人类可读输出）——目前只输出紧凑 JSON；
- 本地数据仓库的**查询**（`qiyu query`）——存储与同步（`store init/status`、`sync` 六个子命令）已可用，见「当前状态」；

`api list` 输出的 `meta.registry_complete` 会如实反映注册表是否已收录全部接口。

## 浏览器 / 文档

完整的接口语义、字段行为、限频与错误码的实测记录，见
[`docs/qiyu-cli-design.md`](docs/qiyu-cli-design.md)。

## 开发

```bash
npm install
npm run typecheck         # 类型检查（含测试）
npm test                  # 运行测试

# ⚠️ 测试必须单进程运行。vitest.config.ts 已写死 maxWorkers: 1 +
#    fileParallelism: false，但命令行参数会覆盖配置——不要去掉这两个限制。
```

测试覆盖了响应信封归一化、错误分类、签名、脱敏、限频、注册表校验、CLI 契约等。
所有对外部 API 的调用都用 mock，**测试不联网**。

CI（`.github/workflows/ci.yml`）在 push/PR 到 `main` 时对 Node 20.12（engines 下限）、
22（维护期 LTS）与 24（当前 LTS）跑 `npm ci` → `npm run typecheck` → `npm test`；测试并发
限制来自 `package.json` 的 test 脚本，CI 不另传并发参数。

### 目录结构

```
src/
  cli.ts                入口与顶层分派
  output.ts             输出契约（ok / fail / usageFail，退出码）
  store/                存储抽象（src/store/：Store 接口、DuckDB 后端、schema 与迁移）
  sync/                 同步引擎（src/sync/：引擎、状态、限频门、窗口切分、任务注册表与 21 个任务）
  schedule/             跨平台调度安装（launchd / systemd / schtasks）
  commands/             子命令（auth / api / store / sync）
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
