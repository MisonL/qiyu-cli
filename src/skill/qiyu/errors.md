# 错误处理协议

失败时 stdout 是 `{"ok":false,"error":{code,kind,retryable,message,hint?}}`。
**按 `kind` 分支，不要按 `code` 分支**——`code` 可能是服务端的数字码，也可能是 CLI 合成的词，
查不到统一的错误码表；`kind` 才是 CLI 承诺的闭集。

退出码：`0` 成功 · `1` 业务错误 · `2` 用法错误 · `3` 网络错误 · `4` 需要人工确认。

## kind → 动作

| 信号 | 动作 |
|---|---|
| `kind: auth_missing` | 凭证未配置（环境变量与配置文件都没有）。按 hint 设置 `QIYU_APP_KEY`/`QIYU_APP_SECRET` 或让人类跑 `qiyu auth login`；原命令重试无用 |
| `kind: config_insecure` | 配置文件**含凭证**但权限过宽（group/other 可读到 appSecret）。重试无用——转告人类执行 hint 里点名的 `chmod` 后重跑 |
| `kind: auth` | 凭证被服务端拒绝（key 错、IP 不在白名单、接口无权限）。按 hint 修配置；重试无用 |
| `kind: bad_time` | 时间戳超期。CLI 已自动重签重试过；仍失败说明本机时钟真的偏了——校准系统时间 |
| `kind: param` | 参数错误。按 message 与 hint 修正；重试无用 |
| `kind: usage` | 调用方式有误（退出码 2）。改命令或参数重来；原样重试毫无意义 |
| `kind: rate_limit` | 限流。看 `retry_after`：`source` 为 `fallback` 表示该秒数是保守兜底、不是实测冷却（睡完可能再吃一次限流）；秒数超过 60 就不要干等——转本地查询通道先做别的分析，稍后再回来 |
| `kind: window_too_large` | 时间跨度超限。上限天数看报文里的数字（如「> 31」即 31 天），或查 `qiyu api list` 输出里该接口的 `max_window_days`；按它切片、分批请求 |
| `kind: window_misaligned` | 时间边界没对齐自然日（结束边界不得晚于今天零点）。切片修不好——把边界对齐到自然日再试 |
| `kind: module_offline` | 模块未开通。永久失败，找人类开通，不要重试 |
| `kind: not_in_queue` | 业务状态，不是故障。按业务语义处理，不重试 |
| `kind: pending` | 异步任务未完成（如会话导出轮询）。这是正常中间态——稍后再次轮询，不要判成失败 |
| `kind: route_not_found` | 服务端没有这条路由。接口 id 写错，或 CLI 的接口注册表有误；重试无用，报告人类 |
| `kind: internal` | 看 `retryable`：true 才退避重试；false 时按 message 的两种已知成因查参数（无效参数、翻页越界），重试无用 |
| `kind: network` | 网络层故障（退出码 3）。检查网络后退避重试 |
| `kind: unknown` | 未分类错误。按 message 判断，不要盲目重试 |
| `kind: needs_confirmation` | 危险操作等待确认（退出码 4）。**停下**，向人类复述该操作及其目标；**绝不自动追加 `--yes`** |
| `kind: store_locked` | 本地库正被写进程持锁（例如同步进行中）。退避后重试；期间可以先用已有数据做分析 |
| `kind: store_not_initialized` | 本地库不可用（不存在 / 缺表 / 不是本 CLI 的库 / 依赖未安装）。**按 `hint` 行动**：只有 hint 指向 `qiyu store init` 时才跑它，再跑 `qiyu sync run`；其余成因换 `--db` 路径或按 hint 安装依赖，原样重跑 `store init` 无效 |
| `kind: query_timeout` | 查询超时。缩小时间窗口、减少分组列或降低 `--limit` 后重试 |
| `kind: sync_not_run` | 还没有成功同步过。这个 kind **只由 `sync install` 的前置探测产出**（`sync status` 不产出它，水位全为 null 时按 `SKILL.md` 的开场协议处理）：先跑一次 `qiyu sync run` 让至少一个任务真正同步成功，再装调度 |

## 退出码 4 的信号

退出码 4 **一定**同时携带 `confirm_required`、`confirm_arg`、`risk` 与 `target`，且
`retryable` 为 false。收到它时：

1. 向人类复述：哪个接口、目标对象是什么、为什么不可逆。
2. 等人类明确同意后，由人类决定是否加 `--yes` 重跑；**不要自己补**。
3. 人类拒绝时，按业务语义收尾（例如改为查询现状），不要换个接口绕过闸门。

## 歧义信号（尚未启用）

名称解析（G2）交付后会引入一个「候选不止一个」的信号，名字是 ambiguous。

- **当前版本不会产出它**——不要为它写分支，也不要假装见过它。
- 它启用后：把候选列表原样交给人类，**不得自行选择**（猜错会把人派错、把工单改错）。
- 在那之前，涉及人名、组名解析的需求直接问人类。

## 重试总则

只在 `retryable` 为 true、且动作本身安全（只读或幂等）时退避重试；`needs_confirmation`、
`usage`、`param`、`auth` 类错误重试是浪费，危险操作重试是事故。
