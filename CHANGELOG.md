# 更新日志

本项目的所有重要变更都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 新增

- 注册表补全至 154 条接口（150 个文档页 + 4 个文档外接口），并新增每接口的 `params/` 参数表。
- `qiyu api schema <id>` —— 查看接口请求参数表与响应形状
- `api call` 的 body 分级校验
- `store init` / `store status`（`qiyu store init` / `qiyu store status`）—— 初始化本地数据库（DuckDB）与查看各表行数
- `qiyu db` / `qiyu query` / `qiyu stats` —— 本地数据仓库的查询接口（E 子项目）：
  - `db tables`（25 表清单 + 粒度 + 行数 + 数据时间范围 + PII 列）、`db describe <表>`
    （列/类型/可空/敏感标记/观测枚举/时间列/单位）；声明与实况不一致逐条进 `meta.warnings`
  - `query --sql` —— 任意只读 SQL，**三层只读沙箱缺一不可**：语句白名单
    （单条 + `prepare().statementType` ∈ {SELECT, EXPLAIN}；`DESCRIBE`/`SHOW` 实测归入
    这两类的类型值故一并放行）、每实例首次连接
    `SET enable_external_access=false` + `SET lock_configuration=true`（含 `memory_limit` 加固
    与自检）、实例 `access_mode=READ_ONLY`；
    另有行数上限（默认 1000）、`--timeout`（`conn.interrupt`）与按 reader 多读一行的准确截断
    （不做 SQL `LIMIT` 包装——那需要剥尾分号/尾注释，`SELECT 1; -- x` 会炸）
  - `query --table` —— 受约束通道：`--since`/`--until` 按时间列三形态（`iso-day` 向下取整到
    上海自然日 / `iso-instant` 字符串比较 / `epoch-ms` `TRY_CAST`）生成谓词，
    `--group-by` 列闭集校验（敏感列拒绝）、`resolved_range`/`data_coverage` 回显
  - `stats fields <报表>` —— 指标自描述：`declared`（每条带 `source`：设计稿实测 / 命名推断）
    与 `observed`（`rows_present`/`minus_one`/`nulls`/`min`/`max`）分离，`-1` 哨兵明确呈现为
    「无数据」而非负数比率，`unknown_fields` 如实列出判不出单位的字段
- 查询默认脱敏：`query` 两条通道默认按 `TABLES.sensitive` 脱敏（手机号/邮箱/IPv4 按形态打码，
  其余整值 `<已脱敏>`），`--no-mask` 才输出原始值（并追加 PII 风险警告）；`meta.masked_columns`
  只记**实际被改写**的列，`--sql` 通道的别名绕过缺口与 payload 缺口（`payload` 不做列名级，
  姓名/地址等无格式 PII 会原样输出）都进 `meta.mask_warnings`
- 新增错误 kind：`query_timeout`（`--timeout` 触发 `conn.interrupt`，退出码 1）
- 查询无 schema 迁移：`TABLES` 的元数据扩展（`grain`/`timeColumn`/`observed_enum`/`unit`/`note`）
  是纯 TypeScript 侧声明，不进 DDL、不新增迁移条目，旧库无需任何操作即可查询
- `Store` 抽象与 DuckDB 后端、`~/.config/qiyu/config.json` 存储配置支持
- 新增错误 kind：`store_locked` / `store_not_initialized`（退出码 1）
- `qiyu sync` —— 本地数据仓库同步引擎（`sync tasks` / `sync run` / `sync status` / `sync verify` / `sync install` / `sync uninstall`）：
  21 个任务覆盖维度/报表/工单/会话/知识库数据集，增量水位与断点续跑、缺口落 `sync_gaps`、
  `pending/complete` 区分「未同步」与「空数据」、水位与数据落库同事务、
  会话导出 create→poll→download→unzip→parse 流水线、`sync verify` 快照三方一致性核对
- `sync install` / `sync uninstall` —— 跨平台定时调度（macOS launchd / Linux systemd user / Windows schtasks），默认 dry-run，`--yes` 才写入/删除；安装前置要求**至少成功同步过一次**（全败的 run 不算）
- 新增错误 kind：`rate_limit_local`（本地限频冷却，`retry_after` 精确到毫秒且跨进程持久化）
- 同步引擎零常规运行时依赖：会话导出的加密 zip 解压走 Node 内置 `DecompressionStream`；`fflate` 降为开发依赖（仅测试夹具合成 zip 用）——`@duckdb/node-api` 仍为可选依赖
- `sync status` 输出上次成功覆盖区间（`resolved_range`）与逐条历史缺口（`gaps`）；`sync run` 的 `gaps[].range` 统一为 `+08:00` ISO 形态，并在请求区间早于接口可得下界时给出 `notes` 提示
- 新增错误 kind：`sync_not_run`（尚无成功同步的证据，退出码 1）——此前只在运行时以字符串出现、不在 `ErrorKind` 联合里
- `sync tasks` 输出每表的 `sensitive_columns`（PII 列清单）；会话/工单表的 `payload` 列（整行 PII 的完整副本）标注为敏感（含 `ticket_logs.payload` —— `ticket.log` 行携带邮箱清单/处理人与日志正文）
- 会话导出核对尾部标记行（导出自己声明的窗口）：标记窗口不覆盖请求窗口 → 该窗显式失败（水位冻结、不落库）；标记缺失 → 记 gap `export_fixture_unreported`；标记窗口宽于请求 → 记 gap `export_window_mismatch`
- 同步 schema 迁移 v9：`sync_state` 补 `resolved_range_start`/`resolved_range_end` 两列
- `store_not_initialized` 的 hint 统一为 `qiyu store init`（C1 与同步引擎同口径）
- CI（`.github/workflows/ci.yml`）：push/PR 到 `main` 时对 Node 20.12（engines 下限）、22（维护期 LTS）与 24（当前 LTS）跑 `npm ci` → `npm run typecheck` → `npm test`；此前仓库无任何 CI，测试只在本地跑
- Node 下限由 ≥20.10 修正为 **≥20.12**：会话导出的 zip 解压用 `DecompressionStream('deflate-raw')`，该格式 Node 20.12 起才被接受（20.10/20.11 抛 `format is invalid`，CI 在 20.10 上实测 11 个 pipeline 用例失败后确认）；此前的 `engines` 声明与实现不符
- 同步引擎修复：请求区间**整体**早于接口下界时（如 `--until` 指向 40 天前），此前从哨兵起点 0 按 31 天切片会切出数百窗（702 窗实测），首窗被 op 守卫拒绝、其余各发一次无意义调用（生产上 opStart 被服务端静默钳制）——现收成单窗直送守卫，显式失败一次、gap 可见
- **F 子项目（Skill 化）**：
  - `qiyu skill install` —— 把 skill 正文装到实体目录（默认 `~/.agents/skills/qiyu`）并链接进已存在的 Agent skills 目录（`claude-code` / `codex`）；幂等（内容一致不写盘）、`--force` 才覆盖、`--dry-run` 只输出计划；点名的 agent 目录不存在时**不替用户创建**，只进 `meta.warnings`；`--dir` > `QIYU_SKILL_DIR` > 默认位置
  - `qiyu skill check` —— 校验 skill 正文引用的命令、表名与错误 `kind` 是否仍存在于当前 CLI；默认校验包内那份（不依赖本机装没装过），`--installed` / `--compare` 可改基准；有违规时 `ok:true` 但退出码 1（与 `sync verify` 同双轨语义）
  - `qiyu skill where` —— 只读报告实体路径与各 Agent 链接状态四态（`ok`/`missing`/`dangling`/`foreign`），无法判定时报 `unknown`（`exists: null`）而不是谎报「不存在」；只报告、不修复
  - skill 文档六篇（`SKILL.md` 入口 + `protocols.md` / `metrics.md` / `errors.md` / `forbidden.md` / `setup.md`），构建期由 `scripts/copy-assets.mjs` 拷进 `dist/skill/qiyu/`；正文不硬编码表名/列名/错误码，事实一律运行时自描述，`skill check` 静态校验其引用
  - `qiyu --version` —— 输出 `{version, skill_contract_version}`（遵循既有信封契约，非裸文本；`--version --bod` 退出码 2）；`SKILL_CONTRACT_VERSION` 定义在 `src/core/edition.ts`，包版本由构建期注入（源码保持 `0.0.0-dev` 占位）
  - 首次运行漂移提示：每个命令启动时探测一次安装态，未安装/已过期时往成功输出的 `meta.warnings` 注入一句提示（只提示，绝不改退出码、`data` 或任何文件）；探测失败静默跳过
  - `postinstall` —— `npm i -g` 后尽力而为地装一次 skill：仅在 npm 全局安装且非 npx 时尝试、`force` 恒 false、任何失败都返回 0 不阻断安装。**实际很少触发**（npm 12 / pnpm 12 / bun 默认阻断安装脚本），主路径仍是显式 `qiyu skill install`
  - `tests/store/layering.test.ts` 补分层红线：`core/` `store/` `query/` `sync/`、`commands/`（`skill.ts` 除外）与 `src/` 根文件（`cli.ts` / `postinstall.ts` 除外）一律不得 import `skill/`；扫描器同时覆盖静态 `from`、动态 `import()` 与裸副作用三种写法，并跳过整行注释（注释里的反例代码不是依赖）

### 修复

- **聚合报表按天切片（窗口 1 天）**：九个报表接口返回窗口聚合值、响应 `date` 只表示
  「本次查询的起点」，多天窗口会把 N 天汇总标成第 1 天且水位每月才推进一次 →
  `overview`/`staff_workload`/`staff_quality`/`staff_satisfaction`/`robot_summary`/
  `transfer_human`/`order_performance`/`staff_salary_detail` 窗口上限改为 1 天；
  考勤保持 31 天（响应逐行带可信小时戳）但 `stat_date` 改由该行时间戳推导。
  窗口数 = 天数：`--full` 对报表任务会切出上万窗，回补历史请用 `--since/--until`
- **断链后 `resolved_range` 不再谎报覆盖**：水位冻结在连续成功末端时，覆盖区间同样
  冻结（此前会回显到失败窗之后的窗口末，`sync status` 输出失真）
- **`deleteRangeInsert` 删除上界越界一天**：天对齐删除上界改为 `dayOf(end − 1ms)`
  （半开窗口的最后一个瞬时）——`--until` 指定日期 / 昨天零点钳制这类「end 恰在日界」
  的窗口此前会多删**下一天**的行，而本轮不重拉
- **知识库快照丢行不再静默**：缺键行被丢弃（快照全删重插下从表里消失）时记 gap
  `knowledge_row_malformed`（detail 含行数）
- **`sync install` 把存储参数写进调度命令**：`--db`/`--profile`/`--backend` 随
  launchd/systemd/crontab/schtasks 条目透传——此前前置探测用指定库、调度任务却跑默认库
- **schtasks 映射修正**：步进要求整除周期（`*/7` 分钟在 cron 每小时重置、schtasks 不
  重置 → 拒绝映射，绝不错位）；`HOURLY` 判据改为「固定分钟 + 小时步进」
  （`0 */2 * * *` 可映射、`* */2 * * *` 显式拒绝而非静默收窄）
- **zip 解压**：条目定位改以中央目录为唯一来源（修复 bit3 数据描述符下第二个条目
  `session.txt` 找不到）；ZipCrypto 校验字节在 bit3 时接受 DOS 修改时间高字节
  （此前恒与 CRC 高字节比较，合法包被判「密码错误」）；解压后用中央目录 CRC 全量校验
- **导出包下载加 120 秒超时**：签名 URL 挂起不再让 `sync run` 永久挂住、写锁不释放
- **`knowledgeRobotIds` 整数组校验**：非法元素（非正整数）退出码 2 并指出非法值，
  不再静默过滤成空数组（注入面静默失效）
- **聚合报表窗口按上海日界对齐**：8 个 `stat_date` 为主键的报表任务（`windowAlign:
  'shanghaiDay'`）的窗口端点对齐上海自然日 0 点，水位续跑起点落到日界（此前
  `watermark+1ms` 的错相位窗只写一行 `stat_date` 却拉到跨两天聚合，删除范围会把
  「明天」日的行删掉而不重写，「每日概览」语义每天漂移）；工单（3 天回看重叠、
  任意起点）与考勤（逐行时间戳）不受影响
- **残段窗跳过（`windows.skipped`）**：日对齐报表任务被显式区间（`--since/--until/--full`）
  钳出的非日界首末段（如 `--since 30d` 的 `[起点11:15, 次日0点)`）装的是半日聚合值，
  写 `stat_date` 日行会覆盖该日的整日聚合 → 引擎跳过不 fetch、不写库、不推水位
  （末残段的整日值可能由其请求区间覆盖该整天的日对齐 run 补全，不保证「下一次 run」
  就补上；首残段不补，要覆盖该日请给更宽的 `--since`）；
  跳过窗计入 `total` 并标 `skipped`、逐窗 stderr
  进度行，绝不静默消失
- **`sync install` 固化 env 派生的存储定位**：存储定位走环境变量（`QIYU_DB_PATH`/
  `QIYU_PROFILE`/`QIYU_STORE_BACKEND`）时，把解析出的绝对路径/名称写进调度命令的
  `--db/--profile/--backend`——launchd/schtasks/cron 不继承 shell 环境，此前探测用
  env 指到的库、调度任务却跑默认库；显式 flag 仍优先，只走配置文件/默认值时不固化。
  输出 notes 写明「调度条目不继承 shell 环境、不写入任何凭证」的部署事实
- **查询层脱敏的两处泄漏（2026-10-20 全维度审查）**：① 重名输出列被驱动去重成 `userPhone:1`
  后从未被遍历——`SELECT userPhone, userPhone FROM sessions` 与自连接 `SELECT * …` 会让
  第二列原始 PII 静默输出（`meta.masked` 仍为 true）；② 错误消息的值回显只挡单引号句式，
  `CAST(… AS DECIMAL)` / `strptime` 的双引号形态与 `Malformed JSON … Input: "<payload>"`
  都会原样带出表内 PII。两处均已收口，并补了「回退即红」的回归用例
- **时间比较一律按时刻、不再按字符串**：iso-day 的无毫秒形态 `…T16:00:00Z` 与 iso-instant 的
  `+08:00` 写法在字典序上与时间序相反，导致 `query --table` 的过滤/排序/缺省下界与
  `db tables`/`db describe` 的 `time_range` 互相矛盾（同一状态两种说法）。现统一
  `TRY_CAST(… AS TIMESTAMPTZ)` 比较与 `arg_min/arg_max` 取极值；epoch-ms 增加数值区间判据
  （`-1` 哨兵、秒级/微秒级误写不再被当成 1970 或万年后的时刻）
- **`query --table` 的时间过滤带上形态谓词**：`'2026-10-15garbage'` 之类的脏值不再出现在
  结果行里，与 `data_coverage` 同口径；自然日缺口按**自然日**去重，且今天有行时不再掩盖
  昨天的真缺口
- **`sync run --help` 不再吞掉额外参数**：`--help --bogus` 此前退出码 0（`--bogus` 被静默
  忽略），`--pretty --help` 与 `--help --pretty` 还会因书写顺序得到 2 / 0 两种结果
- **`sync run` 的存储失败不再一律提示 `store init`**：「路径不是 DuckDB 文件」「他人库」
  「依赖未安装」跑 `store init` 必然再次失败，现保留底层错误的 hint
- `api call` / `api schema` 的用法错误出口补上控制字符净化（此前可向 stderr 注入 ANSI/OSC）
- 脱敏对分析结果的副作用现在会声明：对敏感列 `GROUP BY`/`DISTINCT` 时提示「不同原值会映射成
  同一个脱敏值」；值级兜底命中非敏感列（11 位订单号等）时提示「可能是业务数字被误改」
- `query()`/`query_table()`/`COLUMNS()` 这类在内部再执行 SQL 的构造会声明脱敏缺口
  （此前 `SELECT * FROM query('SELECT userName AS n …')` 完全静默）
- 超范围时间值（微秒级脏值、`--since 999999999d`）不再让整条命令以 `internal` 崩溃；
  带时刻的 ISO 也会回验日历日（`2026-02-30T00:00:00` 不再静默进位成 3/2）

## [0.1.0] - 2026-10-09

首个版本：认证与通用 API 通道。

### 新增

- `qiyu auth whoami` —— 检查凭证是否已配置
- `qiyu api list [--all]` —— 列出接口（默认只列可主动调用的出站接口）
- `qiyu api call <id> [--body <JSON>] [--yes]` —— 调用接口
- 统一输出契约：成功 `{ok:true,data,meta}`、失败 `{ok:false,error}`，
  退出码 `0/1/2/3/4` 分别表示成功 / 业务错误 / 用法错误 / 网络错误 / 需要 `--yes`
- 按 `message` 文本（而非错误码）的错误分类——覆盖七鱼错误码语义重叠的实测情况
- 危险操作硬门禁：未加 `--yes` 时绝不发出请求
- 凭证与签名的全通道脱敏，以及服务端内部信息（Java 类名、请求 id）过滤
- 响应信封归一化，含畸形 JSON（整数键未加引号）的容错修复
- 逐接口限频表与 `retry_after` 提示

[未发布]: https://github.com/MisonL/qiyu-cli/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/MisonL/qiyu-cli/releases/tag/v0.1.0
