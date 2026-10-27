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

## 这份协议自己的安装与配套

本 skill 是随 CLI 分发的正文，装到本机后可能与包内那份不一致。以下三件事都靠 CLI 回答，
不要凭记忆判断。

- **`meta.warnings` 里的 skill 提示**：任何一条成功输出都可能带一句「skill 未安装」或
  「skill 已过期」。它只提示、不改退出码、不改 `data`，也**没有自动改过任何文件**。
  含义是本机装的正文与这份 CLI 不配套；更新方式是 `qiyu skill install --force`——它会写到本机
  的 skill 实体目录与各 Agent 的 skills 目录。**只在人类允许写 home 时执行**，不要自作主张
  改动用户目录；不允许时把这条提示原样转述给人类。
  提示里同时给出裸 `qiyu skill install` 与 `--force` 时（清单缺失/损坏），按这个次序做：
  **先跑裸 `qiyu skill install`**；返回 `status: "skipped"` 且 `meta.warnings` 说「内容与包内不同」
  就说明正文被手工改过——此时**先问人类**，得到允许再用 `--force` 覆盖（那会丢掉手工改动）。
  提示里只有 `--force` 时（版本不一致 / 正文漂移）：**正文可能被手工改过**，`--force`
  会丢掉那些改动——先问人类是否允许覆盖，得到允许再执行。
  若 install 的 `meta.warnings` 说清单路径被非普通文件占用，**先清理那个占用**（那是人该做的事）：
  两个动词都写不进清单，`--force` 还会只覆盖正文、留下「状态 updated 但提示仍在」的半截结果。
- **`qiyu --version`**：输出包版本（`data.version`）与 `data.skill_contract_version`
  （**这份 CLI** 的正文契约号）。
- **`qiyu skill where`**：报告实体目录与各 Agent 链接状态，并给出**已安装那份正文**的
  版本元数据：`data.entity.installed.skill_contract_version`（装的那份的契约号）、
  `data.cli_contract_version`（本 CLI 的）与 `data.entity.installed.compatible`
  （两者是否相等）。**判断「手上的正文能否配这份 CLI」就看这一个字段**，不要拿包版本号
  去比 —— 包版本不同但契约号相同，正文仍然能用。`installed` 为 `null` = 实体不可用，
  或清单缺失/损坏，判定不了，不要当成「兼容」。
  `links[].state` 的 `foreign` 表示**那个路径上是别人的东西**（不是本 CLI 建的链接）——
  install 会跳过它，**不要删、不要覆盖**；`unknown` 是「判定不了」，不是「不存在」。
  各状态的完整含义见该命令输出里的 `meta.field_notes`（每个值都带释义与动作）。
- **`qiyu skill check`**：正文自身的防漂移校验（命令、表名、错误 `kind`、位置参数取值是否
  仍存在于当前 CLI）。默认校验包内那份；`--installed` 校验已安装的那份，`--compare` 比对
  两份并报告差异。有违规时退出码 1。
- **不要手工编辑已安装的正文**：手工改过之后，`qiyu skill install`（不带 `--force`）
  会判定「内容与包内不同」而**跳过不覆盖**，你改的那份会一直留着、也一直与包内不一致。
  要改就改包内（发行包里的）那份，再 `qiyu skill install --force` 覆盖本机那份。

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
