# 更新日志

本项目的所有重要变更都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 修复

- **`sync status` 的 `range_status` 两个取值字面与事实相反，且四个命令的状态位全仓无释义**。
  这条命令是 skill 协议指定的「看水位与缺口」入口，而它输出的 `range_status`
  （`pending`/`complete`/`null`）此前**一个释义都没有**。逐格实测（2026-10-27，真库）：
  · 3 窗中第 2 窗失败 → run 报 `status: "partial"`、`windows.failed=1`，而 `range_status`
    仍是 **`complete`** —— 引擎在每个成功窗的同一事务里调 `advanceWatermark`，它无条件写
    complete（设计稿 §6.1 的原话是「全窗口成功」，实现比它弱）。按字面读 `complete` 会
    得出「这段数据完整」，而缺口就在同一次输出的 `gaps` 里；
  · 3 窗中首窗失败 → `range_status: "pending"`、`watermark: null`，但表里**有 2 行数据**
    （首窗失败时 `watermarkRange` 为 null，后续成功窗照常落库、只是不推水位）。按字面读
    `pending` 会得出「库里没数据」。
  同轮还核实：`sync run` 的 `status: "partial"` **也覆盖「一行都没落」的全窗失败**
  （`succeeded: 0`，`failed` 只留给快照任务被限频闸门拦下）；`sync status` 的
  `locked: true` 是**残留章**而不是「正在同步中」（并发写者实测会让本命令退避等待 7.4 秒
  后正常返回，等不到才报 `store_locked`）；`sync verify` 的
  `state_windows_consistent: true` 同样**不代表数据完整**（中窗失败的库实测给出
  `drift: []` + 退出码 0）。修法：`RANGE_STATUSES`/`RUN_STATUSES` 改 `as const` 数组
  （运行时可导出，双向核对才有对象）+ `satisfies Record<枚举, string>` 的释义表 +
  四个命令的 `meta.field_notes`（`sync run`/`status`/`verify`/`tasks` 各一套，
  集中在新模块 `src/commands/sync-notes.ts` —— 放 `sync.ts` 会让 `sync-run.ts` 反向
  import 成环）。图例不只写「不代表 X」，还写**机制**（为什么 pending 时表里有数据、
  为什么 complete 时可能仍有缺口）。
  新增 `tests/sync-state-legends.test.ts`：枚举 ⊆ 图例、图例 ⊆ 枚举、README 图例覆盖、
  路径形态（`gaps[]` 是数组、`drift[]` 是数组）、无 `**`、无幽灵键，**外加四条真库行为
  用例把图例的字面结论钉在引擎事实上**（中窗失败 → complete；首窗失败 → pending 但有数据；
  残留章 → locked:true 且 verify 仍报一致；从未同步 → null）。变异 9 条全红，其中两条
  最初是绿的（只断言了「不代表」三个字，没钉机制），补强后才红 —— 连同一条引擎变异
  （`advanceWatermark` 改回写 pending）验证「真库用例钉的是引擎事实，不是图例自说自话」。
  README 补两张图例表（`range_status` / `tasks[].status`）+ `locked` 与 `verify` 的边界
  说明；skill `protocols.md` §2 补四条 Agent 侧警告。
  CodeRabbit 四条（全部核实成立并修，`src/commands/sync-notes.ts` 与 README/skill 同步）：
  ① **Major** —— `verify` 的图例一度写「要判完整性看 drift 与本命令退出码」，而本 PR 自己
  的用例正证明中窗失败的库给 `drift: []` + 退出码 0：图例在自相矛盾，改成「drift 为空 /
  退出码 0 同样不能当完整性证据」+ 正确的替代路径；② `resolved_range` 说成「本轮**实际
  覆盖**到的区间」是过度承诺 —— 日对齐任务的首残段会被跳过、`start` 前缀不会自动前移，
  改成「请求的水位区间 + 不是已覆盖的保证」并指向 `windows.skipped`；③ 判「有没有拿到
  数据」不能用 `windows.succeeded`（**空窗也算成功窗**，`tests/sync/engine.test.ts`
  「两次都空 → 判空推进」钉着），必须同时点名 `rows.written`；④ `gaps` 说「按 reason 判断
  是否仍缺」是错的 —— 旧记录的 reason 与新记录**相同**，区分不出新旧，改成按 `range`
  对照 + 说不清就写「新鲜度未确认」。四条各补一条变异验证（回退措辞即红）。
  **第二轮三条**（同样核实成立）：⑤ verify 那句「本命令只核对同步状态」会把**快照任务**
  一起否认掉——快照任务有上游行数核对，必须限定为「对 windowed 任务」；⑥ `tasksFieldNotes`
  的 `kind`/`sensitive_columns` 写成**裸键**，而它们在 `tasks[]` 条目里（路径写错 =
  Agent 找不到）——测试里接受错误路径的 `TOP_KEYS` 一并收窄；⑦ 「按 range 对照判新鲜度」
  仍不成立：换边界重跑后数据可能已补齐，而旧缺口的 range 仍与新评估区间**重叠**——
  range 只能说明「相关」，没有一次覆盖核对就不能确认新鲜度。四条各补一条变异验证。
  **第三轮一条**：⑧ `tasks[].status` 的 `complete` 说成「全部窗口成功」仍不准确 ——
  `windows.skipped > 0` 且 `failed = 0` 时同样是 `complete`（被跳过的残段窗没跑也没写），
  照「正常」行事会漏掉那段区间。改成「没有失败窗口」+ 指向 `windows.skipped`。
  **第四轮一条（Major）**：⑨ `complete` 的图例仍写「判定数据完整只能看 `gaps`」——
  实测反例（真库）：日对齐任务 + 非日界起点的显式区间 → `skipped: 2`、`gaps: []`、
  `status: complete`，而请求区间只有中间一段被拉取。改成综合三个判据（覆盖范围 /
  历史缺口新鲜度 / 空 gaps 不等于完整），并把这个反例钉成真库用例。
  **第五轮两条**：⑩ `sync status` 的 `resolved_range` 说成「上次成功推进**覆盖**的区间」
  同样过度承诺 —— 实测 `start` 等于**请求起点**（含被跳过的首残段前缀，而首个整日窗
  其实从 16:00Z 才开始），且本命令不输出 `windows.skipped`；改成「水位区间 + 判实际
  覆盖要看 `sync run` 的 `windows.skipped`」。⑪ `pending` 的图例写「该任务尚未成功
  推进过水位」不成立 —— `markPending` 每轮开跑就置 pending，实测「先成功一轮、再跑一轮
  首窗失败」会回到 `pending` 而 `watermark` **保留上一轮的值**；改成「最近一次运行没有
  成功推进水位」并列出三种误读。两条各补变异验证，另加一条**分隔符守卫**（枚举释义正文
  不得含 `；`，否则 `renderNotes` 的反向解析会产生幽灵取值 —— 这个坑本轮踩了两次）。
  **自查补三处**（CodeRabbit 配额用尽期间自己复审）：⑫ verify 的替代路径把
  `windows.skipped` 说成 `sync status` 里有的 —— status 与 verify 都不输出它，必须点名去
  `sync run` 找；⑬ `expected_from_api` 的「用 kind 区分」含糊（kind 是 drift 条目的字段），
  改成「看 drift 里有没有 fetch_failed」；⑭ `watermark.initial` 的「首跑从 0 起」漏了
  `windowStartFloorDays` 的抬升（接口物理上给不出更早的数据）。⑫ 补变异验证。

- **`stats fields` 是唯一没有 `meta.field_notes` 的读命令，`declared` 的机器值域全仓无释义**。
  这条命令的整个意义就是让 Agent **不猜单位**（设计稿 §9.2：「单位不确定 → 查 `stats fields`
  的 `unit`；绝不要猜百分比还是绝对值」），可它输出的 `declared.<字段>.unit` 四个取值
  （`ratio`/`count`/`ms`/`unknown`）在 README 与 skill 正文里**一个释义都没有** ——
  被告知「别猜」的 Agent 拿到 `unit: "ratio"` 之后，仍然得猜是 0–1 还是 0–100。
  实测（2026-10-27）：`meta` 只有 `warnings` 一个键。修法：三组枚举改 `as const` 数组
  （`METRIC_UNITS`/`METRIC_SOURCES`，类型由 `typeof ARR[number]` 派生）+ `satisfies
  Record<枚举, string>` 的释义表 + `meta.field_notes` 逐值给出释义与动作
  （`ratio` = 0–1 小数、实测样本 `assignedRatio=0.987`，**不是** 0–100 的百分数，且只有
  该字段经实测、其余是命名推断；`ms` = 毫秒；`unknown` = 判不出单位，**不是「没有单位」**）。
  新增 `tests/stats-field-notes.test.ts` 双向核对（枚举 ⊆ 图例、图例 ⊆ 枚举）+ README 图例，
  断言取生产渲染路径 `statsFieldNotes()`；`tests/commands/stats.test.ts` 加行为用例钉住
  「图例真的挂上了 `meta`」（单测绿不代表命令层挂上了）。变异 4 条全红。
  skill `protocols.md` 同步指向 `meta.field_notes`，并**限定成立条件**：0–1 量纲只有
  `assignedRatio` 经实测，其余 `ratio` 是命名推断；而 `observed` 的 min/max 只能核对
  **一致性、不是量纲证据**（全落在 0–1 与「数值恰好都 <1% 的百分数」同样相容），量纲
  不明确时报告原值并标注不确定，不要自行换算成百分比（CodeRabbit 两轮 —
  第一次我只写了「先看 observed 核对」，仍然是把一致性当证据）。图例键的**路径形态**
  也钉进测试：`declared` 是按字段名分组的对象（`declared.<字段>.unit`），`observed`
  才是数组（`observed[].min`）—— 写成 `declared[].unit` 指的是一个不存在的路径
  （CodeRabbit 抓到我最初就写错了）。

- **`declared.higher_is_better` 恒为 `null` 却没有任何出处**。`src/` 里零个非 null 生产者
  （设计稿从未给出「越大越好/越小越好」的依据，裁定不猜），但设计稿 §8 把它当作本命令的
  卖点列出，输出里也从不解释 —— 第 2 种形态（声明了但没人读）：Agent 会一直等它变成
  true/false，或把 `null` 当 `false`。修法：`meta.field_notes` 明写「恒为 null」+ 为什么
  （设计稿 §9.2），并在测试里把这句话与**代码事实**绑住 —— 若未来某条声明填了非 null，
  该用例会红、逼着图例同步改，而不是让「恒为 null」留在输出里骗 Agent。

- **「清单缺失/损坏」的 skill 提示只推荐了一条只在半数成因下收敛的动词**。版本未知这一支
  （`.qiyu-skill.json` 没了或损坏）判不出**正文是否被手工改过**——探测刻意不读正文
  （设计稿 D2.1 的「零成本」）。此前文案只有「运行 `qiyu skill install` 更新」，实测
  （2026-10-27，六格收敛矩阵）它在两种成因里只收敛一种：
  清单损坏/缺失 + 正文一致 → 裸 install 走 rewrite-manifest，状态回到 `current`；
  清单损坏/缺失 + **正文被改过** → 「内容不同且无 `--force`」→ `skipped` + **零写入**，
  **提示原样还在**——照做的人白跑一趟，且看不出为什么没修好。修法：一条提示里给出**两个**
  动词并各自注明成立条件（正文一致 → 裸 install 补写清单；正文被改过 → `--force` 覆盖）。
  同时补上第二条前提：清单路径被**非普通文件**（符号链接/目录）占用时（`writeTargetWarning`
  拦截），正文一致则裸 install 与 `--force` 都 `skipped`、实体零变化；正文漂移时 `--force`
  报 `updated` 但**只覆盖了正文**，清单仍写不进去、探测仍报 stale（CodeRabbit 指出的部分
  写入）——所以文案不能说「两个命令都不会覆盖」，那只对清单成立。
  `tests/skill/detect.test.ts` 新增三个**行为**用例（真的把动词各跑一遍、断言状态何时收敛），
  把「清单损坏+正文漂移」「清单被非普通文件占用（正文一致 / 漂移）」三种情形钉死；
  五处变异（回退文案 / 删掉占用前提 / 把部分写入说回「都不会覆盖」/ 让被占用的清单放行 ×2）
  全部转红。README 与 SKILL.md 同步：提示给的是「能收敛的动词」，两个动词各有前提；
  SKILL.md 并要求 `--force`（含「不配套」那条警告自带的 `--force`）先经人类确认 ——
  内容漂移就意味着正文可能被手工改过，覆盖会丢掉那些改动，而「允许写 home」不等于
  「允许丢弃手工改动」。两个占用用例在非提权 Windows 上会因 `symlinkSync` EPERM 跳过
  （目录占位走的是另一个分支：EISDIR → `unknown`，根本不发提示）。

- **`skill where` / `skill install` 的状态取值全仓无释义**。五组枚举都是 Agent 要按值
  分支的机器值，此前 README 只给了链接四态的**名字**：`entity.state` 的
  `not_a_directory`、install 的 `action`（`install`/`update`/`skip`）与
  `status`/`planned_status`、`links[].action`（`keep`/`create`/`rebuild`/`skip`）连名字
  都没出现过。**`foreign` 尤其危险** —— 它意味着「那个路径上是别人的东西」，被猜成
  「坏了该修」就会误删用户的文件。修法：五组枚举改 `as const` 数组
  （`ENTITY_STATES`/`LINK_REPORT_STATES`/`LINK_PLAN_ACTIONS`/`INSTALL_ACTIONS`/
  `INSTALL_STATUSES`，`entity.state` 的类型从 `Record<string, unknown>` 收窄），
  释义走**输出自带的 `meta.field_notes`**（与 `api list` 同形态）—— 安装后的 skill
  目录只有六篇正文、没有 README，只写 README 等于 Agent 读不到；且 dry-run 与真实安装
  各只解释**该输出里真实存在**的字段（dry-run 无 `status`、真实安装无 `action`，
  真实安装的 `links[]` 条目也没有 `action`）。**`skip`/`skipped` 的「零写入」限定为
  实体正文**：实测「删掉链接后重装」返回 `status: skipped` 而链接仍被重建
  （`linkAgents` 与计划态无关）—— 不加范围会让 Agent 以为链接也没动、不去看 `links[]`；
  `tests/commands/skill.test.ts` 新增该行为用例（把建链改成 skipped 时跳过，用例会红）。
  `missing` 同理：install 只在该 Agent 的 skills 目录**已存在**时建链、从不创建目录，
  目录不存在时 `links` 里根本没有这个 Agent 的条目（实测）—— 只说「install 会创建」
  会让 Agent 以为装完就修好了。
  README 保留人读版图例。新增 `tests/skill-field-notes.test.ts` 三方核对
  （枚举 ↔ field_notes ↔ README），断言取**生产渲染路径**而非测试自写副本 —— 实测
  自写副本会让「渲染时漏掉 foreign」全绿；`Record<枚举, 释义>` 让新增值漏写释义
  直接编译失败。SKILL.md 同步点明 `foreign` 不要删、`unknown` 不是「不存在」。

- **`gaps[].reason` 与 `drift[].kind` 的取值全仓无图例**。`sync status`/`sync run` 的
  `gaps[].reason` 真实值域是 **8 个**：引擎侧 4 个（`rate_limit_local`/`fetch_failed`/
  `write_failed`/`count_mismatch`）+ 任务 `gapHint` 写入的 4 个业务提示
  （`knowledge_row_malformed`/`filter_matched_no_staff`/`export_fixture_unreported`/
  `export_window_mismatch`）—— 而类型只声明了前 4 个，落库处用 `as WindowGapReason`
  强转把谎报压住；`sync verify` 的 `drift[].kind`（4 值）同样无出处。README 只列字段名，
  skill 协议只让 Agent「看缺口」——按值分支的 Agent 没有值表可查，也分不清
  「失败缺口」与「成功窗上的业务提示」（`gaps` 非空 ≠ 同步失败）。修法：三组枚举改为
  `as const` 数组（`ENGINE_GAP_REASONS`/`TASK_GAP_REASONS`/`DRIFT_KINDS`），
  `gapHint.reason` 收窄为 `TaskGapReason`（删掉三处 `as` 强转，退回 `string` 会编译失败）；
  README 补带动作的图例表，skill `protocols.md` 补分支动作；新增
  `tests/sync-enums.test.ts` **双向核对**（枚举 ⊆ 图例、图例 ⊆ 枚举）——加值不写图例、
  或图例写了源码不存在的值，都会红。

- **配置键路径在文档与提示里写不全，照做会被 CLI 自己的校验拒绝**。配置结构是
  `profiles.<name>.store.<键>`，而多处只给了简写：`store_locked` 的 hint 说「可经配置文件
  `readOnlyRetryMs` 调整」（写进顶层或 profile 级 → 「配置文件未知键」退出码 2）、
  `sync run` 与 `auth whoami` 的文案写 `store.options.knowledgeRobotIds`（同样缺
  `profiles.<name>` 前缀）、skill 正文 `setup.md` 把 `knowledgeRobotIds` 与 `robots`
  写在同一个层级（实际前者低两层）。全部改为完整路径，并新增
  `tests/config-paths.test.ts`：README 的配置示例必须被 `parseConfig` 接受，文档与源码
  文案里点名的每个配置路径都必须能在白名单里走通（裸键名、层级错、代码标识符误伤
  三种形态都在自检里钉住）。
- README 补上**配置文件的完整结构示例** —— 此前全仓没有一处给出它，这正是上面那类
  简写能长期存在的土壤。
- **同一个危险状态，两条路径两种行为：含凭证且权限过宽的配置只被其中一条如实报告**。
  配置含凭证且 group/other 可读（`0644`）时，`loadConfigChecked`（`auth`/`api` 走）抛出
  带 `kind: config_insecure` 的错误，而 `store/config.ts`（`store`/`db`/`query`/`stats`/
  `sync` 走）抛的是**无 kind** 的普通 Error，各命令 catch 又一律 `usageFail(...)` ——
  于是同一份配置：`auth whoami` 得到退出码 1 + `kind: config_insecure` + 可执行的
  `chmod 600 <路径>` hint；另外九条调用（`store status`/`store init`/`db tables`/
  `db describe`/`query`/`stats fields`/`sync status`/`sync verify`/`sync install`/
  `sync run`）得到退出码 2 + `kind: usage`（语义是"改参数重来"）且 **hint 丢失**。
  设计稿 §3.4 与 README 承诺的都是前者——Agent 会照退出码去改参数，而这件事与参数无关。
  修法：权限拒绝的错误**只在 core 层构造一处**（`insecureConfigError`，两个入口共用
  同一句话），各命令的 catch 改为如实透传的 `failFromTagged`。顺带补上 `failFromTagged`
  出口缺失的终端控制字符净化（调用方从 `usageFail` 换过来时，那层净化会静默消失）。
  新增 `tests/commands/config-insecure.test.ts`：九条调用绑在**同一张表**上逐条断言
  退出码/kind/retryable/hint —— 分文件写就复现不了"同一判据在不同命令上分叉"这个形态。
  该文件在 Windows 上跳过（`checkPermissions` 在 win32 直接返回 ok，POSIX 权限位没有
  对应语义；沿仓库既有的 `process.platform === 'win32'` 跳过约定）。
- `config_insecure` 的 hint 里路径**加 shell 引号**：配置路径来自 `HOME`，而 `HOME`
  可以含空格（`/Users/John Doe`）。不引号时 hint 里的 `chmod 600 /Users/John Doe/...`
  会被 shell 拆成多个参数，用户照着抄得到 `chmod: 无法访问 'Doe/...'` —— 这条 hint 的
  全部价值就是"照着执行就能修好"。`core/config.ts` 与 `auth login` 的写后自检两处同源
  （`shellPath`），不含空格的路径不加引号。
- README 的权限规则段补上**例外与边界**：不读配置的命令（`--version`、`api list`、
  `skill where`、`sync tasks`）不受影响；`auth login` 是唯一例外，它把已有文件重写为
  `0600` 而非拒绝（马上要写入新 secret，拒绝没有意义），写完自检不合格才报。
- README 成功信封段原写「**三个键恒在**」（`ok`/`data`/`meta`），与实现相反：`ok()` 在
  没有元数据时**故意不输出 `meta`**（`tests/output.test.ts` 把"未提供 meta 时不输出该键"
  钉成契约）。实测（skill 已装、无提示）`--version`、`store status`、`sync tasks`、
  `skill where` 的成功输出只有 `{ok, data}`。改为如实描述 + 给出可操作的读法
  （读 `meta` 前先判存在），并加一条 `tests/readme.test.ts` 断言防回退。
- **拼错的 profile 名静默回落到默认库**。`resolveStoreConfig` 此前是
  `profiles[profileName] ?? {}` —— 把「profile 拼错」和「profile 存在但没配 store」合并成
  同一个静默回落。实测：配置里只有 `prod`/`staging` 时，`--profile prodd`（少一个字母）
  让 `store status` 去读 `~/.qiyu/duckdb/qiyu.duckdb`、`query --sql "SELECT ..."` 返回
  **`ok:true` 与另一个库的数据**（Agent 看不出自己读错了库），`store init --profile prodd`
  还会在默认路径**创建一个用户从未配置的库**。三条入口（`--profile`、`QIYU_PROFILE`、
  顶层 `defaultProfile`）都受影响。现在点名的 profile 不存在即拒绝（退出码 2，错误列出
  已有的 profile 并注明来源），与全仓「未知表/未知任务/未知接口 id/未知后端/未知配置键
  一律拒绝并给候选」一致。刻意保留的回落只有四种：配置文件不存在、`profiles` 为空、
  profile 存在但没写 `store` 块、未点名任何 profile 时用内置 `default`（各自都有用例钉住）。
  空串口径与 `auth login` 对齐：`--profile ''` 是 usage 错误「--profile 不能为空」；
  `QIYU_PROFILE=` 与 `"defaultProfile": ""` 视为未设置（与 core 的 `fileProfile` 同一判据）。
  判据必须查 **own property**：`profiles` 早先是普通 `{}`，`--profile constructor`/
  `toString` 会命中 `Object.prototype` 上的继承属性、绕过守卫后同样回落默认库（CodeRabbit
  实测指出）；`parseConfig` 改为 null 原型对象（顺带关掉 `profiles["__proto__"] = block`
  改写原型的写法），守卫侧再用 `Object.hasOwn` 加第二道锁。

## [0.2.1] - 2026-10-26

### 新增

- `qiyu skill where` 输出补**已安装正文**的版本元数据：
  `data.entity.installed = {version, skill_contract_version, compatible}` 与
  `data.cli_contract_version`；不配套时进 `meta.warnings` 并点名两个号。
  **为什么必须有**：正文一直教 Agent「用 `skill_contract_version` 判断手上的正文能否配
  这份 CLI」，但此前没有任何命令报出**已安装那份**的号（`--version` 与 `skill check`
  的 meta 报的都是 CLI 自己的）—— 实测把清单里的号改成 99，三条命令的输出一字不变、
  `meta.warnings` 为空，那句承诺是空的。实体不可用或清单缺失/损坏时 `installed` 恒为
  `null`（判定不了），不编造兼容结论；清单里的契约号不是非负整数（`1.5`、`-3`）同样
  按清单损坏处理，不拿坏值去比出一个 `compatible:false`。
- `skill_contract_version` 递增到 **2**：`SKILL.md` 新增了「用 `skill where` 判断配套」
  这一整段协议，且新正文**依赖**上述 `skill where` 新字段 —— 0.2.0 的 CLI 没有这些字段，
  契约号不动的话新旧组合会被判成「配套」（spec D6：正文结构性改变才递增）。

### 修复

- `qiyu sync --help` 曾把 `**至少成功同步过一次**` 原样打到终端（help 是纯文本，不是
  渲染后的文档）；`api call` 的 GET 守卫抛错文案同样含 `**`，经 catch 进 stderr。
- 用法错误与抛错文案的「无 Markdown 标记」规则此前只被 api/auth/cli 三个文件的哨兵表
  覆盖（全仓 `usageFail` 调用点有 117 处），新增全仓静态扫描
  （`tests/plaintext-channels.test.ts`，覆盖 `usageFail` / `throw new Error` /
  `process.stderr.write` / `*_USAGE` 的字面量，含跨行 `throw Object.assign(` 形态）。
- 补上 6 个此前**零覆盖**的用法错误分支（`api schema` 四条、`auth login` 的参数分支、
  `cli --version` 的额外参数守卫），以及注册表 `pageId` 的两条抛错分支
  （它们原来的断言是子串匹配，加星号照样通过）。
- 不配套警告曾建议 `qiyu skill install` —— 实测跑完是 `skipped` + 零写入，正文与警告
  都不变（正文一改，实体哈希就与包内不同，不带 `--force` 一律跳过）。改为
  `qiyu skill install --force`，SKILL.md 同步。
- `skill where` 的 `entity.installed` 键此前在实体不可用（缺失/非目录/检查失败）时
  整个消失，调用方拿到 `undefined` —— 与 SKILL.md 定义的 `null`（判定不了）是两种
  不同的沉默。改为恒出现，判定不了就是 `null`。
- 契约号与正文的绑定此前只靠测试从 `SKILL_CONTRACT_VERSION` 推导期望值 —— 改了正文
  忘了递增契约号，测试照样绿。新增 `tests/skill/documents.test.ts` 的标记表：正文里
  每条结构性标记对应一次契约递增，两个方向脱节都会红（诚实边界：「算不算结构性」
  仍是人为判断，测试保证的是判定之后两处记录必须同时动）。

## [0.2.0] - 2026-10-25

### 新增

- 契约小件（G1 第一批，2026-10-24）：
  - 限流错误新增 `retry_strategy: "switch_to_local"` 与 `fallback: "qiyu query --table <表>"` ——
    仅 `api call` 撞限流且接口非危险、有同步任务映射、本地库文件存在时出现；多表接口在 `hint`
    点名其余表，并明确「表存在 ≠ 已同步/覆盖窗口」。无映射/探测失败时两个键都不出现，
    原始限流错误原样返回
  - `api schema` 输出 `rate_limit` 三态（缺键 = 未登记 / `null` = 实测无限频 / 对象含 `scope`），
    `RateLimit.scope` 27 行全部 `'endpoint'`（按路径独立，无全局配额实证）
  - `api list` 输出 `category`（Apifox 文档目录；4 个文档外接口无该键），`EndpointSpec.category`
    补类型与加载期校验，`field_notes.category` 说明它不是稳定契约
  - `call()` 的 GET 分支：GET 不带 body 发送（签名 `md5('')`），GET + body 在本地报用法错误
    （不静默丢弃）；`api call` 侧由 `assertGetHasNoBody` 先行拦截
- `--pretty` 已实现（G1 第二批，2026-10-24）：输出缩进 JSON（人类可读）。写在具体子命令之后
  （如 `qiyu api list --pretty`）；用法错误仍是紧凑 JSON。各命令在原「显式拒绝」位置开启开关，
  错误次序逐字保留；`REJECTED_FLAGS` 清空但 rejected 机制与 `skill check` 的 rejected_flag
  规则保留
- `qiyu auth login [--profile <name>]` —— 把**环境变量**里的凭证写入配置文件（G1 第三批）：
  合并保留该 profile 下的 `store`/`robots` 键、原子写（`0700` 目录 + `0600` 临时文件 +
  `rename` 换入）、符号链接拒绝、**绝不回显**凭证。不接受 `--app-key`/`--app-secret`
  （命令行参数会留在 shell 历史与 `ps` 输出里）
- 凭证来源扩为**环境变量 > 配置文件**两个来源，`api call`/`sync run`/`sync verify` 三处
  共用同一份合流逻辑（`credentials-source.ts`）：env 缺哪一项才读文件，超集时不读
- 新增错误 kind：`config_insecure`（配置文件含凭证却权限过宽 —— group/other 可读，或父目录
  可被整体替换 —— 退出码 1，重试无用）。**不含凭证**的文件维持「只在 stderr 警告、不阻断」
- `auth whoami` 输出补 `source`（`env`/`file`/`mixed` 三态）与 `robots`（配置里的
  robotId → 显示名映射，未校验有效性）；后者是 `sync run` 知识库类目任务的**兜底驱动源**
  （`store.options.knowledgeRobotIds` 优先，向后兼容）

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
- CI 增加**发布产物门禁**（`npm run check:pack`，只在 Node 20.12 矩阵项跑）：用
  `npm pack --dry-run --json` 断言 skill 正文逐篇在包内、`dist/postinstall.js` 存在、
  `dist/core/edition.js` 的版本已注入且与 `package.json` 一致 —— 防「构建脚本退化时功能测试
  仍全绿、发布包静默缺文件」（测试直接 import `src/**`，从不触碰构建产物）
- Node 下限由 ≥20.10 修正为 **≥20.12**：会话导出的 zip 解压用 `DecompressionStream('deflate-raw')`，该格式 Node 20.12 起才被接受（20.10/20.11 抛 `format is invalid`，CI 在 20.10 上实测 11 个 pipeline 用例失败后确认）；此前的 `engines` 声明与实现不符
- 同步引擎修复：请求区间**整体**早于接口下界时（如 `--until` 指向 40 天前），此前从哨兵起点 0 按 31 天切片会切出数百窗（702 窗实测），首窗被 op 守卫拒绝、其余各发一次无意义调用（生产上 opStart 被服务端静默钳制）——现收成单窗直送守卫，显式失败一次、gap 可见
- **F 子项目（Skill 化）**：
  - `qiyu skill install` —— 把 skill 正文装到实体目录（默认 `~/.agents/skills/qiyu`）并链接进已存在的 Agent skills 目录（`claude-code` / `codex`）；幂等（正文一致不动正文；清单缺失/损坏时补写清单）、`--force` 才覆盖、`--dry-run` 只输出计划；点名的 agent 目录不存在时**不替用户创建**，只进 `meta.warnings`；实体目录定位为 `--dir` > `QIYU_SKILL_DIR` > `npm_config_qiyu_skill_dir`（postinstall 的安装通道）> 默认位置
  - `qiyu skill check` —— 校验 skill 正文引用的命令、表名、位置参数取值（表名 / 报表表 / 任务 id / 接口 id 四个闭集）与错误 `kind` 是否仍存在于当前 CLI；默认校验包内那份（不依赖本机装没装过），`--installed` / `--compare` 可改基准；有违规时 `ok:true` 但退出码 1（与 `sync verify` 同双轨语义），`--compare` 下两份正文内容不一致同样退 1（CI 可据此发现「装过旧版、包升级改了正文」）
  - `qiyu skill where` —— 只读报告实体路径与各 Agent 链接状态四态（`ok`/`missing`/`dangling`/`foreign`）；无法判定时：实体路径报 `exists: null`，链接报 `state: unknown`（带 `error`），都不是谎报「不存在」；只报告、不修复
  - skill 文档六篇（`SKILL.md` 入口 + `protocols.md` / `metrics.md` / `errors.md` / `forbidden.md` / `setup.md`），构建期由 `scripts/copy-assets.mjs` 拷进 `dist/skill/qiyu/`；正文不硬编码表名/列名/错误码，事实一律运行时自描述，`skill check` 静态校验其引用
  - `qiyu --version` —— 输出 `{version, skill_contract_version}`（遵循既有信封契约，非裸文本；`--version --bod` 退出码 2）；`SKILL_CONTRACT_VERSION` 定义在 `src/core/edition.ts`，包版本由构建期注入（源码保持 `0.0.0-dev` 占位）
  - 首次运行漂移提示：每个命令启动时探测一次安装态，未安装/已过期时往成功输出的 `meta.warnings` 注入一句提示（只提示，绝不改退出码、`data` 或任何文件）；探测失败静默跳过
  - `postinstall` —— `npm i -g` 后尽力而为地装一次 skill：仅在 npm 全局安装且非 npx 时尝试、`force` 恒 false、任何失败都返回 0 不阻断安装。**实际几乎不会触发**（npm 12 / pnpm 12 / bun 默认阻断安装脚本；tarball / `file:` 安装下 `--allow-scripts` 也不生效——离线实测），且首次运行探测认识 postinstall 用的 `npm_config_qiyu_skill_dir`，装到自定义目录后不会误报「未安装」；主路径是显式 `qiyu skill install`
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
- **`store_not_initialized` 的提示全线按成因分流**（CodeRabbit 审查）：此前 `sync status`/
  `sync verify`/`sync install` 与 `db tables`/`db describe` 对「有表但无 schema_version」
  的**他人库**也建议「或先运行 store init」——而 store init 遇他人库会再次拒绝，Agent 会
  进 `store init` ↔ 原命令的死循环。现在空库（零表）才指 store init、他人库指换 `--db`
  路径；skill 正文 `errors.md` 相应改为「**按 `hint` 行动**」，不再无条件推荐 store init
- **`query --table` 的空表提示不再被库漂移警告吞掉**：0 行且无时间过滤时，「该表无数据」
  此前要求 `warnings` 为空，于是「库中缺列」警告一出现，空表提示就静默消失——缺列说的是
  schema、空表说的是数据，两件独立事实现在同时报告
- **时间形态 SQL 谓词收敛为唯一实现**（`src/query/time-shape.ts`）：`db tables`/
  `db describe` 的 `time_range` 与 `query --table` 的过滤/覆盖曾各存一份逐字副本，
  只靠注释与字符串相等测试防守（gap 2 的缺陷正来自这两份副本）；现由构造保证同口径
- **skill 源目录解析改为与本模块同层**（CodeRabbit 审查）：仓库 `prepare` 挂在 build 上，
  任何 `npm install` 都会产出 `dist/`——「dist 优先」的旧解析让源码态（vitest/tsx/本地开发）
  读到**上一次构建的旧正文**而不是刚改的 `src/skill/qiyu/*.md`：`skill check` 对旧文本
  报零违规、探测哈希到旧值、`skill install` 装出旧副本。现在源码态取 `src/skill/qiyu`、
  发布态取 `dist/skill/qiyu`（两种形态都在 detect 模块同层），与运行代码永远一致
- `api call` / `api schema` 的用法错误出口补上控制字符净化（此前可向 stderr 注入 ANSI/OSC）
- 脱敏对分析结果的副作用现在会声明：对敏感列 `GROUP BY`/`DISTINCT` 时提示「不同原值会映射成
  同一个脱敏值」；值级兜底命中非敏感列（11 位订单号等）时提示「可能是业务数字被误改」
- `query()`/`query_table()`/`COLUMNS()` 这类在内部再执行 SQL 的构造会声明脱敏缺口
  （此前 `SELECT * FROM query('SELECT userName AS n …')` 完全静默）
- **`skill install` 的三类数据安全问题**：① 并发安装撞 `ENOTEMPTY` 时此前退 1 并把原因
  归成权限问题，现在按实体实际状态收敛（本进程零写入 → `status: skipped` + 如实文案）；
  ② 崩溃残留清理此前会**无差别删除**同前缀暂存目录（把另一个正在进行的安装删掉），
  现在按 mtime 年龄（10 分钟）判活，且只认带独占标记的目录 —— 用户的
  `qiyu.tmp-backup/` 不再被误删；③ 清单 `files` 可被篡改来删用户文件，现在按逐文件
  哈希核对，只删「内容与记录一致」的受管文件（旧清单无哈希则宁留不删）
- **`skill check` 的目录环与分词**：自指符号链接（`loop -> .`）此前会把同一条违规报几十次
  （靠路径长度撞上限才停），现在按递归栈的 realpath 集合挡环；`bool` flag 不再吞掉它后面的
  位置参数、引号内的复合符号不再误判为不可校验
- **`skill where` 无法判定时不再谎报「不存在」**：实体路径报 `exists: null`、链接报
  `state: unknown`（带 `error`）
- 同进程内 `skill install` 之后再跑命令，`meta.warnings` 不再残留「skill 未安装」
  （探测缓存按参数元组命中旧结论，install 成功后现在会失效）
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

[未发布]: https://github.com/MisonL/qiyu-cli/compare/v0.2.1...HEAD
[0.2.1]: https://github.com/MisonL/qiyu-cli/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MisonL/qiyu-cli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MisonL/qiyu-cli/releases/tag/v0.1.0
