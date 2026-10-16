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
- `Store` 抽象与 DuckDB 后端、`~/.config/qiyu/config.json` 存储配置支持
- 新增错误 kind：`store_locked` / `store_not_initialized`（退出码 1）
- `qiyu sync` —— 本地数据仓库同步引擎（`sync tasks` / `sync run` / `sync status` / `sync verify` / `sync install` / `sync uninstall`）：
  21 个任务覆盖维度/报表/工单/会话/知识库数据集，增量水位与断点续跑、缺口落 `sync_gaps`、
  `pending/complete` 区分「未同步」与「空数据」、水位与数据落库同事务、
  会话导出 create→poll→download→unzip→parse 流水线、`sync verify` 快照三方一致性核对
- `sync install` / `sync uninstall` —— 跨平台定时调度（macOS launchd / Linux systemd user / Windows schtasks），默认 dry-run，`--yes` 才写入/删除；安装前置要求**至少成功同步过一次**（全败的 run 不算）
- 新增错误 kind：`rate_limit_local`（本地限频冷却，`retry_after` 精确到毫秒且跨进程持久化）
- 新增常规依赖：`fflate`（会话导出的加密 zip 解压）——`@duckdb/node-api` 仍为可选依赖
- `sync status` 输出上次成功覆盖区间（`resolved_range`）与逐条历史缺口（`gaps`）；`sync run` 的 `gaps[].range` 统一为 `+08:00` ISO 形态，并在请求区间早于接口可得下界时给出 `notes` 提示
- `sync tasks` 输出每表的 `sensitive_columns`（PII 列清单）；会话/工单表的 `payload` 列（整行 PII 的完整副本）标注为敏感
- 同步 schema 迁移 v9：`sync_state` 补 `resolved_range_start`/`resolved_range_end` 两列
- `store_not_initialized` 的 hint 统一为 `qiyu store init`（C1 与同步引擎同口径）

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
