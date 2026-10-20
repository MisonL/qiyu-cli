---
name: qiyu
description: 查询与分析网易七鱼客服数据（会话、工单、知识库、统计报表）的 CLI 使用协议——先同步本地库再查，事实一律运行时获取。
---

# 七鱼数据操作手册

本 skill 教你在七鱼（网易七鱼客服系统）数据上正确工作：查会话、查工单、查知识库、算统计报表。
所有表名、列名、接口清单、指标单位都**不写死在本 skill 里**——用 CLI 的自描述在运行时获取，
因为写死的名字会随版本漂移，而猜错是静默失败。

## 开场协议：任何数据任务的第一步

```
qiyu sync status
```

它给出每条同步任务的水位、上次成功同步时间、实际覆盖区间、缺口与锁。在看过它之前，
不要对数据下任何结论。**如果所有任务的水位与覆盖区间都是 null**（说明还没有成功同步过），
先跑 `qiyu sync run`，跑完再看。（安装调度时，`sync install` 的前置探测会以
`kind: sync_not_run` 报同一事实。）

拿到覆盖范围后，按需自描述：

- 有哪些表、行数、粒度、时间范围、PII 标注：`qiyu db tables`
- 单表的列定义：`qiyu db describe <表>`
- 报表指标的单位、本地观测分布、哨兵值：`qiyu stats fields <报表表>`
- 接口清单与参数表：`qiyu api list`、`qiyu api schema <接口id>`
- 同步任务清单：`qiyu sync tasks`
- 凭证是否已配置：`qiyu auth whoami`
- 库状态与各表行数：`qiyu store status`

## 通道路由决策树

先判断任务特征，再选通道——不要一律走 API，也不要一律查本地。

| 任务特征 | 通道 | 起点命令 |
|---|---|---|
| 历史趋势、聚合、跨天/跨窗口统计 | 本地同步库（受约束查询） | `qiyu query --table <表>` |
| 需要 JOIN、跨表聚合，受约束查询表达不了 | 本地同步库（只读 SQL） | `qiyu query --sql <SQL>` |
| 刚刚发生的事、单条记录明细 | 实时 API | `qiyu api list` 找接口 → `qiyu api call <接口id>` |
| 写操作（创建、修改、派发、回复等） | 实时 API（有确认闸门） | `qiyu api call <接口id> --body <JSON>` |
| 本地库里没有要的表 | 先补同步，或走实时 API | `qiyu db tables` 确认 → `qiyu sync run` 或 `qiyu api call <接口id>` |

三条判据：

- `qiyu query --table <表>` 是受约束通道：表名闭集校验、时间过滤、分组计数、默认脱敏。
  **单表的行、计数、时间范围一律优先用它**。
- `qiyu query --sql <SQL>` 只用于受约束通道表达不了的 JOIN / 跨表聚合；拿它跑单表简单过滤
  是绕过列白名单与精确脱敏（见 forbidden.md）。
- 写操作命中确认闸门时返回退出码 4 与 `kind: needs_confirmation`——停下来向人类复述操作与
  目标，**绝不自动追加 `--yes`**（见 errors.md）。

## 输出与退出码

- stdout 只有一行 JSON：成功为 `{"ok":true,"data":…}`（部分命令附带 `"meta":…`），失败为
  `{"ok":false,"error":…}`；日志与进度走 stderr，不要把 stderr 当数据。
- 出错时按 `error.kind` 分支，不要按 `code`（见 errors.md）。
- 退出码：`0` 成功 · `1` 业务错误 · `2` 用法错误 · `3` 网络错误 · `4` 需要人工确认。

## 其余五份协议（按需阅读）

- [protocols.md](protocols.md)——数据可信度：下结论前看什么、0 行怎么解读、单位与时间怎么核对。
- [metrics.md](metrics.md)——指标语义：三处「行数 ≠ 实体数」。
- [errors.md](errors.md)——错误处理：按 kind 分支的动作表。
- [forbidden.md](forbidden.md)——禁止事项。
- [setup.md](setup.md)——需要人工配置的机器人编号等 ID。
