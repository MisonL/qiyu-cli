# 更新日志

本项目的所有重要变更都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 文档

- **设计稿 §9.1 失败样本按真实出口逐字段校准**（2026-11-22）：旧样本写 `retryable: false`（实现恒 `true`，
  `errors.ts` 的裁决注释早就写在源码里）、 `hint` 「该接口每分钟限 1 次」（全 src 无此文案）、
  `retry_after` 缺类型**必填**的 `source`（skill 正文的秒数可信度分流整个建立在它上面）、
  `fallback` 首表与「未登记档」自相矛盾（`order_performance` 的端点已登记 observed/30s）。
  样本是自称的 Agent 契约，错一处就是教 Agent 分支一个不可能出现的形状；`tests/docs.test.ts` 加逐字段双向守卫。
- **§4.1 与 §12 的「原始 TCP 抓包」口径矛盾收口**：§4.1 逐字声称「已抓包逐字节比对」而 §12 挂账「未做」——
  实况是设计期只做过**真实凭证往返**（`code:200`），报文级产物从未留存仓库。§4.1 收窄为如实措辞，
  §12 把挂账升格为**显式非目标**并附判据（校验和与传输层无关、抓 TLS 内层相对本地真 undici 出站无额外
  证明力；`BASE` 硬编码无注入缝，真凭证送 mitm 是泄露面）。
- **§4.3「14003 对 Agent 永不可见」补前提**：实况是「救得回才不可见」——偏差 >5min 或重签仍被拒时
  Agent 看得到 `bad_time`（`errors.ts` 有该出口，`http.test.ts` 有行为用例钉着）。skill 正文早已按实况写，
  这次把设计稿与 `src/core/http.ts` 的注释两条入口对齐；同文件的最终 hint 死提及「HTTP 429/5xx」改为
  插值实际状态码（429 在更早的分支就被截走归 rate_limit，该句只会因 5xx 出现），与 Spring JSON 载体同形。
- **§5.2 `not_found` 的「一律」按实现收窄，并逐轮纠偏到「形状已登记 + 载荷结构性为空 + 按载体分档」**：原文「`code:200` 且无数据字段的
  一律当作 `not_found`」比实现强，收窄过程走了三轮——第一轮（Codex 对裁决文档的 P1-7）去掉「一律」改判结构性为空；第二轮
  （Codex 对 PR #82 的 P2）补上**形状条件**：`envelope` 未登记（`null`）不判，形状 D 的 `{code}` 是纯确认、M 的空 `message`
  与走到 C 却缺 `message` 的是失败响应，均不参与；同为 `{code:200}` 报文的 `robot.transfer.config`（正常空壳）与 `robot.session.msgAssociate`（那是它的
  not-found 路径）只能靠**分别登记 `D` / `D-nf`** 区分；形状 C 判的是 `message` 解析出的载荷；业务性为空
  （`ticket.search` 的 `{total:0,tickets:[]}`）判不出（`responseShape` 已在 schema 透出但判据不消费它）。
  → `not_found:false` 既不保证有数据、也不保证形状已登记。逐格核对 `envelope.ts` 后重写，守卫补形状条件判据。
  另钉一层易误读处：形状 M 的空 `message`、走到形状 C 却缺 `message` 的响应是**失败响应**（`ok:false`，真驱动探针实测），根本不参与 not_found 判定——旧措辞把它们与 D 的「成功但纯确认」并列成「不判」，Agent 会把 `not_found:false` 读成「成功但没查到」。
  第三轮（Codex 对 PR #82 的 round-18 P2）拆掉我自己引入的**新的一刀切**：第二轮的措辞把未登记形状写成「即便载荷空也返回 `notFound:false`」，
  但 `envelope.ts` 的宽松分支对**载荷在 JSON `message` 里**的情况照判空（`normalize({code:200,message:'[]'})` → `notFound:true`，
  `tests/core/envelope.test.ts` 钉住）——`smstask.status` 的 `{code:200,message:"[]"}` 正是「成功但查无此物」；只有 `data`/`result`/无载荷
  才不判（`data` 的语义在读／写接口上相反：`deleteKnowledges` 的空数组是**全部成功**）。同一句里的「`null` 此前观测到的全是写接口」也与源码注释相反——
  `null` 有两类来源：从未实测，以及**实测过但形状不在 A/B/C/D**（`chat.queue.group.query` 的 `staffInfo`、`ipcc.customfield.template.get` 的裸数组）。
- **§3.2 目录树加交付状态注**：`store/sandbox.ts` 实际落在 `src/query/`、`store/kysely.ts` 未交付（C2 挂账）、
  `sync/export.ts` 不是单独文件（实现散在 `src/sync/tasks/pipeline.ts` 与 `sessions.ts`）、`domains/` 整层未建——
  Agent 照树找文件会四处落空。注只纠正「文件在哪」，分层结构结论不变。
- **0.2.4 前置：Windows ACL 机制真机探针（PR #83，设计契约收口，未含实现）**：对 spec §2.4 的候选机制
  在 Windows 10 19045 / PowerShell 5.1 / Node 上做真机探针，给出【已验证】/【推断】/【已证伪】分级，
  并**保留明确未实测项**（`CreateFile + SECURITY_ATTRIBUTES` 的**文件**受限创建等价备选、
  `CreateDirectoryW + SECURITY_ATTRIBUTES`
  受限创建目录（Codex 95 事实性①：创建目录须用 `CreateDirectoryW`，`CreateFileW` 只能打开既有目录）、
  首次登录完整序列与跨账户档（目录句柄的打开与「持有期间挡住祖先改名」已由探针 42/42b/42c
  实测，同账户）、null/空 DACL 的实际
  形态、权限不足时的换名/删除、加 `ChangePermissions` 请求位的七参调用——清单见 spec §2.4 平台假设）。
  （**累计十六轮 / 42 个探针**，逐轮增删——本条最初写作「十一轮 / 29 个探针」，那是历史快照，已不再是最终计数；原始输出存 gitignored 证据）。**结论**：`.NET FileShare.None`
  独占句柄持有期间其**直接父目录**的 `rmdir`/`ren`/重建全部失败（钉住成立；更上层祖先的改名已由
  **探针 42/42b/42c** 补测（同账户）：持 `qiyu` 句柄改自身 `0x20`、改父/祖父 `0x5`（42），第 3、4 级祖先
  `0x5`（42c，同进程），42b 的跨进程档只补了父/祖父两臂——第 3、4 级的跨进程档与跨账户档未测），
  Node 的 fd（libuv 带删除共享）挡不住 `rmdir` 与路径重建（README:119-122；**`fs.renameSync` 未单独实测，按推断记**） → **纯 Node 实现不满足本契约**；secret 交付子进程**只能经 stdin**（argv 会被同机进程
  经 WMI/wmic 读到）；error 87 的真因是把信息类号传错（`FileRenameInfo = 3`），**修正后按句柄换名
  仍闭合不了 ⑥ 残余窗口**（调用成功但目标按路径不可见）；创建/打开失败按异常分档，且**报错必须点名
  真实成因**（`0x80070005` 访问被拒**成因不止一种**——收紧自挡与「路径是目录/别的东西」同码，
  须再读回 DACL 才归因；`0x80070050` 文件已存在 ≠ 有人持有）。
  **写序在第十一轮被推翻并换成合并形态**（CR round 103 major）：共享检查只作用于**数据**访问，
  `WRITE_DAC` 一类**元数据**句柄能与 `FileShare.None` 并存、熬过 ④ 的 `icacls` 重建、再改写 DACL
  把读权限补回来——探针 26 端到端复现「secret 写完、句柄关闭后文件按路径可读、内容逐字等于哨兵」。
  所以「先建空 tmp 再独占打开」作废，改为**一次带受限 SD 的原子创建＋独占持有**
  （`FileStream` 七参重载 + `FileSecurity`，ACE 取 `Read | Write | Delete`——`.NET Framework` 的
  `FileSystemRights` 没有 `ReadWrite` 成员，CR round 106 指出后改正；**最终产物是
  `D:P(A;;0x13019f;;;<自己>)`**，第 110/39 轮起 ACE 含 `DELETE` 供换名用。中间版本曾取 `Read | Write`、
  产物 `0x12019f`，那是历史探针值、**不是现行配方**——照它实现会复现「收紧后换名失败」），
  攻击者拿不到 `WRITE_DAC`，路径从源头消失，①→② 空窗一并消掉；「独占打开=探测既有持有者」随之作废。
  写序现为「⓪**两道检查**：在 ⓪ 所持的 `qiyu` 目录句柄上判 `qiyu` 自身受信，`qiyu` 的**直接父目录**另按路径判属主与写面，两道都过才继续（① 创建后核验路径 `qiyu` 的身份 == 该句柄身份；
  **已存在目录**拿不到目录句柄即 fail closed——CR 139；**首次登录目录不存在**时先持有第一个已存在
  祖先的句柄、判父目录受信，再按受限 SD 原子逐级创建并取得 `qiyu` 句柄）→ ①受限创建＋独占持有 →（② 即 ① 返回的句柄）→ ③判 DACL+**属主 SID**
  → ④收紧（**0.2.4 起绑 ① 句柄的 DACL 写入口**——`SetSecurityInfo`/`SetAccessControl(FileStream)` 或 no-go 时
  fail closed；`icacls` 仅机制证据/诊断兜底；继承关闭在 ④ 之后读回判，**读回跑全部七条，并额外通过 W1**
  （当前用户对 tmp 的**有效** `DELETE`，按 DACL 顺序求值）——**W1 不满足即在 ⑤ 前 fail closed、不写 secret**）→ ⑤经同一句柄写 secret → ⑥关句柄 +
  比身份 + 换名 + 复核」，
  并立**统一规则**：失败路径一律不按路径删除/移动任何对象（那一刻无法正名对象归属）。
  如实声明的残余：介入式「换了又换回」的替换检测不到；**跨账户**「受限创建后就打不开」仍是推断
  （本机只有一个可登账户，0.2.4 须用两个真实账户跑**夹具 13(a)**，即受限创建那一支；且以对方令牌
  **不持有 `SeBackup`/`SeRestore`/`SeTakeOwnership`（可启用但未启用也算持有）** 为前提——持有即可
  绕过 DACL 读取或取属主后改 DACL，见 spec §2.4 信任边界段与夹具 9(h)）。
  **实现与夹具留给 0.2.4**。审查期（CR 99–124 / Codex 33–53）曾围绕设计文本建立一套文本守卫，
绝大部分 findings 落在守卫的形态面（换一种写法就漏）；**该阶段关于守卫形态的 findings 未再提出
  新的契约要求**——但同期契约本身仍在修订（CR 103 推翻主写序等，见上方探针条目与 spec §6.27），
  且守卫移除（CR 125 / Codex 54 当时仍审已移除的文本守卫）之后的 CR 126 起又有多轮纯文档的契约修订，见下；
  **用户裁决（2026-11-26）：不对文档写测试**——本 PR 的全部文本守卫已移除，`tests/docs.test.ts`
  回退到 `origin/main`，另删一条因 §2.4 重写而失效的旧断言块（85→84，spec §6.55）。契约的执行性验证留给 0.2.4 用真实文件系统 + 真实子进程断言
  （读面判据、写序 ⓪–⑥、夹具 9(i)–9(k)/13/14（含 13(g)））。守卫移除后另继续了纯文档的事实核对轮次
  （CR 126–177 / Codex 55–95 + 一份过期快照回报，**Codex 92/93/94/95 的完整回执逐条处置见
  §6.118/§6.119/§6.120/§6.122**，CR 177 的换回式三档见 §6.121；留痕见 §6.56–§6.122），不再涉及文本守卫。

- **364 天口径冲突如实标注（未裁决）**：§7.3 与 §14 的「`transferHuman` 364 天报 Internal error、上限压 ≤360」
  与 §7.4.1 的 2026-09-30 二分结论（「不存在边界不稳定」）互斥，两边都自称实测而无可复核记录留存——
  两处各加「未裁决、勿作实现依据」标注；裁决留给一次只读真接口复测（需授权，且 sync 侧早已按天切片）。

### 测试

- 锁夹具的「锁晚到」用例修正**测量对象**（CI 上实测真红，`ff498d9`）：原 holder 在 marker **之后**才首次打开
  数据库，而 DuckDB 的首开是**进程级冷启动**（CI 实测 >5s）——5s 观测窗口测到的永远是冷启动、不是锁落盘
  竞态， 18 次校验全 OPENED 后如实红。改成先用 `:memory:` 把冷启动付掉、再打 marker，窗口才只覆盖
  「已热且不持锁 → 持锁」这一段（同因也会打断 READ_WRITE 变体「锁挡住另一进程」的断言：首开落在两条
  校验之间）。机制变异验证：让 holder 永不持锁 → 窗口耗尽后用例照常红（修正没有把真失败也吞掉）。
- 文档校准的守卫全部是**双向自检**形态：从文档按行提取样本、逐字段过判据（不写会漂移的行号锚），
  事故原文喂给同一判据必红、校准后文本必绿。`tests/core/http.test.ts` 新增「非 JSON 的 5xx 与 429」用例，
  钉住 hint 按状态码插值、两种载体同落 rate_limit/network（RED 证据：修改前实测 hint 是「HTTP 429/5xx」死提及）。
- **夹具不再依赖宿主 umask**（2026-11-23，Linux 真机首次全量暴露）：`mkdirSync(dir, { recursive: true })`
  不传 mode 时权限是 `0777 & ~umask` —— umask 0022 的机器上 0755（无 group 写位）、umask 0002 的机器上
  0775（group 有写位），后者会让产品侧 `checkPermissions` 的目录判据 `(dirMode & 0o022) !== 0` **正当**
  告警「配置目录权限过宽」，于是 23 条断言「无警告」的用例假红（5 条 config + 18 条命令层）。
  产品侧一行未改（写目录本就用 `mode: 0o700`，umask 只会去位）；8 个测试文件的夹具显式收紧配置目录权限
  （`mode: 0o700` + `chmodSync` 双保险；systemd user / LaunchAgents / DuckDB 目录不动）。
  验证：macOS umask 0022 与 0002 各 310/310，Linux 真机 umask 0002 310/310 且全量 110 文件 2865 passed。
- 锁夹具的失败诊断输出改为**从 spawn 起累积**（`LockHolder.lockOutput`）：`waitForMarker` 成功即
  `dispose()` 自己的 data 监听，用例事后挂监听拿不到唯一的 `locked` 行，那条「holder 中途死掉 vs
  锁没生效」的归因文案会永远打 `(空)`。先红后绿钉住；`expectClean` 的数据监听零容忍同步改为减去
  标记监听（只减标记，不放宽）。


## [0.2.3] - 2026-11-22

> 2026-11-22 发布：tag `v0.2.3`（指向 main `5756fa8`，GitHub/GitLab 双远端）+ npm publish
> （shasum `a2deaeba9e62db20b2bb626f190eebb13a9b43e7`）；沙箱安装实测通过
> （`qiyu --version` = 0.2.3、`skill check` 退出 0）。
> **本段的逐轮审查明细已折叠（2026-11-27）**：每条只保留一句结论；「N 处契约修正」批保留全部 N 条
> （每条约一行，`tests/docs.test.ts` 钉数词与条目数一致）。完整取证过程在 git 历史。
> 0.2.0 段**不折叠**：其关键短语与命令形态由既有测试钉住（E-T12、批 8），是行为契约的载体。

### 新增

- `api call` 调用未实测信封的接口时，成功与业务错误信封都带 `unverified_endpoint`，标明`not_found` 判定、`data` 解包与错误分类只有文档依据（74 条危险接口中 73 条未观测过响应）。

### 修复

- **存储层事务安全**：归属闸门下沉到唯一的语句派发点（原始 SQL 的解析判据同样先判归属，外部链的解析不再被记到事务所有者的账上）；按令牌统计在途语句与未完成的写操作，阻止提前`COMMIT`；`query` 下发事务控制（按 DuckDB 解析出的语句类型判定，含 `END` / `ABORT` /`START` / 注释前缀 / 多语句 / **`EXPLAIN ANALYZE` 里层**）一律拒收，多语句现在与关键字初筛**无关地**先解析（`A; B` 的第一条会被驱动先执行掉），解析结果在 `close()` 之后才交回时不再在已关闭连接上预编译；`COMMIT` 结果未知时报「可能已落库、不要直接重试」并**当场退役**连接（重新创建后先核对数据再决定是否重放）；`ROLLBACK` 自身有界，收尾超时先 `interrupt()` 再放弃（不中断会让原生线程占住、进程再也退不出）。
- 提交被拒、收尾又退役时，那条拒绝错误也带 `code: store_retired`（编排层按它识别实例不可用）。
- **主失败在任何形态下都不丢**：回调抛出的错误即使被冻结（只读）也能带上「回滚未能确认」与「重建 → 核对 → 再重放」（包一层并保留 `cause`，不再变成赋值失败的 TypeError）；退役后的默认提示也不再声称「未提交的写入不会落库」（该状态的准确含义就是无法确认）。
- 回调拒绝的值**连文本都转不出**（如 `Object.create(null)`，`String()` 自身会抛）时，回滚未确认的补注不再让那个转换动作换掉主失败：原值仍挂在 `cause`，「重建 → 核对 → 再重放」与`store_retired` 状态照常交回。
- `sync run` 不再在**清锁事务**丢失 COMMIT 回执时谎报 `complete`（此前把它当「次生失败」吞掉，而实例已退役、写者锁可能仍留着）：读水位成功说明实例此前可用，此后清锁事务的首次退役属本次运行自己的失败，按「提交结果未知」交回并要求先核对。
- 补记同步缺口的事务自身丢失 COMMIT 回执（首次让实例退役）时，交回的错误同时保留原始窗口失败与「缺口记录可能没落库、后续窗口写不进」，不再无条件用原始失败顶掉这条退役事实。
- 驱动把 `COMMIT` 以**非 Error 值**（如 `null`）拒绝时，仍按「提交结果未知、可能已落库、不要直接重试」交回（此前读 `.kind` 会抛 `TypeError`，把整段恢复指令换掉）。
- `ROLLBACK` 的拒绝值恰好是 `undefined` 时不再被当成「已整体回滚」：收尾状态按显式的拒绝标志判，回滚未确认的事务照常补「事务也许仍然开着、实例已退役」与「先核对再重放」。
- 错误对象的 `message` 是抛异常的访问器时，补话包层仍能构造出来（原对象挂在 `cause`），不再让读取消息的二次异常顶掉主失败。
- 错误对象的 `kind` 若是抛异常的访问器，补话包层仍能构造出来（按「无 kind」补 `internal`、原对象挂在 `cause`）—— 此前第二次读取会把原失败换成 `TypeError`。
- **退役是两层重试判据的最高优先终止条件**：回滚未确认的撞锁失败会保留 `kind: store_locked`并打上 `code: store_retired`；此前 `sync run` 只按 kind 判「撞锁可重试」，会再碰已退役的实例、把主失败换成「Store 已退役」。
- **退役连接上一条语句都不再发出**：事务与自动事务的入口直接拒绝（此前会先发 `BEGIN`，失败路径再把原错误换成「回滚未确认」）；回滚收尾的事务状态探针在退役状态下直接给出保守答案，`COMMIT` 结果未知后的收尾路径也不再在已退役连接上查询 `txid_current()`。
- `sync run` 的取数失败在补记缺口时撞上实例退役，交回的错误保留**原始取数失败**与「先核对再重放」，不再被「缺口记录未落库」的退役文案顶掉（六处补记缺口的调用点统一走主失败优先的合并规则）。
- **事务失效性探针有界**：语句执行期报错后问连接「事务是否已废」（`SELECT 1`）的那次探测直接走原生连接、此前没有超时 —— 原生线程被上一条失败语句占住时，这条拒绝永远交不回调用方，回滚收尾（连同 `ROLLBACK` 自己的有界预算）根本没机会开始，整个事务 API 挂死。
- **无法解析语句数时拒绝派发**：`extractStatements` 失败曾被当成「放行、让驱动给原文」——真驱动探针实测：首次解析异步失败、随后放行时，`CREATE TABLE a; CREATE TABLE b` 两条都被驱动逐条执行。
- **`ROLLBACK` 放弃前补发一次中断**：驱动把 ROLLBACK 拆成准备与执行两段，第一次 `interrupt()`可能落在进入原生执行之前、被随后的准备阶段清掉 —— 只发一次在慢准备下等于没中断，原生线程会把进程占死。
- 错误对象的 `hint` / `kind` 不是字符串（例如 `Symbol`）时按「缺失」处理：「回滚未能确认」的包层不再因为模板拼接 `Symbol` 抛 TypeError 而丢掉主失败与恢复动作。
- **`EXPLAIN` 里的字面量不再误拒 **：`EXPLAIN ANALYZE SELECT 'COMMIT'` 与注释里的关键字不执行，旧判据匹配整条原文、把合法只读诊断报成 usage；现在先剥掉字符串 / 引号标识符 /行注释 / 块注释 / dollar 引用再匹配（事务控制不可能藏在字面量里执行，判据不放宽）。
- **`BEGIN` 在执行前就被拒时不再退役整个实例 **：`beganTx` 在发出 BEGIN 之前登记（兜住「原生已成功、结果交回才拒」），驱动的拒绝若发生在原生执行之前，事务根本没开过 ——现在收尾时问一次连接（两次 `txid_current()` 同值才是有活动事务），确认没开 → 按「无可回滚」交回原错误、实例继续可用；探针失败 / 有事务 → 保守退役（行为不变）。
- 回归钉住：`COMMIT` 在执行前就被拒（事务可能仍开着、实例已退役）时，未提交写入随连接关闭丢弃 —— 重开库核对为零行，与「可能已落库」的措辞不矛盾。
- **「回滚未能确认」的状态不再写进调用方的错误对象 **：回滚状态属于这次事务尝试，不属于那个`Error` —— 同一个 `Error` 被回调跨 Store / 跨事务复用时，A 的 `code: store_retired` 与「本实例已退役」会被 B（回滚已确认、实例仍可用）原样继承。
- 回调抛出的拒绝值是 ** 已撤销的 Proxy** 时（`instanceof` 在它上面会抛 TypeError），「回滚未能确认」的包层仍能构造：原值挂在 `cause`，`store_retired` 与「先核对再重放」照常交回。
- `COMMIT` 的归因不再读拒绝值上的 `kind`（访问器可抛、驱动对象也能伪造同名字段）：本地派发前的关闭守卫用身份集合登记，驱动拒绝一律按「提交结果未知」退役。
- 语句失败后探测到事务已废时，即使驱动的 `message` 是抛异常的访问器，aborted 标记也照常落下—— 回调吞掉失败后不会再出现「COMMIT 报成功、写入被静默丢弃」。
- 驱动错误 ** 连文本都转不出 **（如 `Object.create(null)`）时，事务仍被标记为 aborted：状态标记先于措辞，拼接文案的异常不再让一次已中止的事务被当成成功提交；`sync run` 的取数 / 落库 / gap五处失败说明同样改走安全转换 —— 上游抛出的拒绝值转不出文本时仍照常记 `fetch_failed` gap，不再让 `TypeError` 顶掉整次运行。
- 事务收尾的等待预算改用单调时钟，系统时钟被 NTP 步进时不再把 5 秒预算拉长或缩短。
- `sync run` 补记缺口的事务 ** 首次 ** 退役时，摘要改用那条错误自己的成因（可能是「回滚未能确认」，而不是「COMMIT 已下发」）—— 恢复动作不再指向一次并不存在的提交。
- **「回滚未能确认」不再与「已整体回滚」同形 **：事务回调失败且 `ROLLBACK` 未能确认时，交回的诊断（包层，原错误在 `cause`）在 message / hint 上补「回滚可能没执行、写入状态不可信」与「重建实例 → 核对 → 再决定是否重放」；自动事务与显式事务两条路径一致，提交被拒的那条拒绝错误同样自带该恢复动作。
- 事务回调里 `close()` 之后调用事务对象的方法，报「数据库连接已关闭」（`usage`），与 Store自身方法同一分类（此前报「事务已结束」，两种退出码）。
- ** 事务失效性探针超时后不再与回滚赛跑 **：探针（`SELECT 1`）超时并补发中断后，再有界等它交回；仍未交回时按「连接可能仍被它占用、`ROLLBACK` 无法安全发出」交回「回滚未能确认」并跳过 `ROLLBACK` —— 不再把「回滚根本没轮到」误报成「回滚失败」后错误退役。
- 事务状态探针在 ** 每次 ** 原生 `txid_current()` 派发前复核连接状态：`close()` / 退役落在两次探针之间时，不再向已关闭的连接发探测语句（此前第二次探针的报错会被当成事务状态结论）。
- `sync run` 的失败判据对 ** 任意拒绝值 ** 安全：`code` / `kind` / `hint` / `retryable` 统一经安全读取，`null` 或访问器抛异常的拒绝值不再让判据自己抛 `TypeError`、顶掉原始失败与恢复指令（此前 `releaseLock` 读 `code`、限频分派读 `kind` 都会踩到）。
- `robot.session.chat` 改判 `dangerous: true`（它会自动创建真实会话），`--yes` 门禁生效。
- 与声明表同名的 **view 不再被当作表执行 **：`db tables` / `db describe` / `query --table` /`stats fields` / `sync verify` / `store status` 只认基表；「同名」按 DuckDB 规则大小写不敏感。
- 目录查询显式放大行上限、截断即报错，不再把截断页当完整目录（对象多于 1000 个时曾误报缺表）。
- 限频闸门只预检本次真正调用的端点，空快照不再被记为失败。
- `sync run` 落库目标不是基表时点名成因，并给出「备份 → 换新路径重建 → 重新同步」的恢复动作。
- `--since` 带相对时长时，区间终点不再取决于解析耗时（同一条命令的窗口数不再随机器快慢漂移）。
- `npm ci` 不再打印 `Cannot find module .../dist/postinstall.js` 堆栈；`postinstall` 照常按文件路径执行。
- 历史 PR 审查收口：查询 / 存储 / 元数据、同步与调度、注册表与图例、skill / 凭证 / CLI 输出的数十处契约问题修正（陈旧文案、错误归因、跨命令口径分叉），逐条经复现与回归验证。
- **`EXPLAIN` 里的 `CASE … END` 不再被误当成事务控制**：事务控制的初判先剥掉成对的`CASE…END`（从最内层剥、可嵌套，有界迭代到不动点）再匹配关键字 ——旧判据把 `END` 当`COMMIT` 的同类，`EXPLAIN ANALYZE SELECT CASE WHEN … THEN … END` 这类合法只读诊断被误拒。
- **解析 / 预编译期就废掉的事务，回调吞掉错误后也不得报成功**：DuckDB 在 `prepare` 期做常量折叠与 table-function 参数求值，`range(CAST('x' AS BIGINT))` 的 Conversion Error在**派发之前**就把整条事务标成 aborted；旧实现把这次拒绝当普通失败交回，回调吞掉后`COMMIT` 被驱动静默改成 `ROLLBACK`，写入丢失。
- **事务失效探针「超时那一刻在途」≠「收尾时仍占用连接」**：探针 50ms 超时之后、回调返回之前自己交回的形态，旧判据只看 `stuck` 会为一个已经结束的探针跳过 ROLLBACK 并错误退役。
- **事务控制改回词法判据，分类不再预编译**（Codex第十四轮 P2）：旧实现为取 `statementType`对触发初筛的 SQL调 `prepare(0)`，而 DuckDB在 prepare期就会求值 table function参数 ——真驱动探针实测 `SELECT * FROM range(nextval('s'))`在分类路径上序列前进两格（结果2行、下一次 nextval=3；基线是1行/2），自动提交下还会以内部断言「read-only but has madechanges」失败、把合法查询变成 internal错误。
- **失效探针未交回时拒绝新语句**（Codex第十四轮 P2）：探针超时且中断后仍未交回，连接仍被它占着；回调 catch掉原错误再 `await count()/query()`时，新语句排在后面永不交回，回调与回滚收尾一起挂死。
- **收尾三态的 `none`与 `unconfirmed`不再混说**（Codex第十四轮 P2）：ROLLBACK真的执行、只是回执被拒，活动事务探针确认连接上已无事务时 `closeTx`返回 `none`（实例未退役）；旧拒绝文案把所有非 `confirmed`都写成「该连接已退役」并打 `store_retired`，而同一实例随后还能成功查询。
- **事务失效探针各记各的账**（CR第六十七轮 major）：同一事务里两条在途语句先后失败会各自起一次探针；「已交回」原用一个共享布尔，旧探针交回会把**仍挂住的新探针**记成已结束 →收尾发出ROLLBACK、排在挂住的探针后面超时，把「探针挂住」误报成「回滚未确认」。
- **嵌套块注释按 DuckDB 规则完整剥离**（Codex 第十五轮 P2）：DuckDB 的块注释可以嵌套（真驱动探针 2026-11-21：`/* outer /* inner */ COMMIT */ SELECT 1` 返回 `{v:1}`）；第六十七轮引入的词法判据在「到第一个星号加斜杠为止」的剥离器上会把内层之后的 `COMMIT */ SELECT` 当成代码，把合法查询误拒成 `usage`。

### 文档

- README 可读性重构：当前状态、输出契约、配置凭证分节，事实与承诺不变。
- `2026-10-10-请求构建与body校验` spec 补历史状态注：`--pretty` 与 `auth login` 均已实现。

### 测试

- 并发静态守卫补：循环初始化里的同名绑定同样遮蔽外层 rest 参数（`for (const args of …)`），hook 登记经 `.call` / `.apply` 触发时的 bind 预绑定回调（实参为数组的 apply 形态同样摊平）。
- 并发静态守卫再补：计算键 `['__proto__']` 按**自有数据属性**收进模型（真 runner 探针——vitest 2.1.9，并发峰值——确认 describe / it 三种形态下计算键都不换原型、子用例串行；非计算的 `__proto__:` 才是原型来源，对照 peak 2）；循环赋值目标（`for (setup of …)` 同样算重绑定）；转存进容器的选项（`box.opts = opts` 之后经 `box.opts` 写穿同一对象）。
- 撞锁用例的换轮循环在预算耗尽后显式停下；锁夹具三个入口在预算已过期时**不写脚本、不 spawn**（此前负数预算下照样起子进程、到点才 kill，失败被报成「未就绪」）。
- 锁夹具的 spawn 失败也等有界的 `close`：`error` 事件不等于 stdio 已关（Node 之后仍会发close），未确认时交回「清理未确认」并把原始错误挂在 `cause` 上，不再让调用方提前删目录。
- 新增 `tests/helpers/capture.ts`，按用例隔离 stdout/stderr 捕获，27 个测试文件迁移；并发与 hook 延迟写入两类边界改由 AST 静态守卫关闭。
- 每个 worker 进程只付一次 DuckDB 冷启动（`tests/setup-warm.ts`），预热失败降级、预算可配。
- 跨进程锁夹具收敛为 `tests/helpers/lock-holder.ts`：等待改为贯穿用例的截止时刻，校验只把真正的锁报文判为 `CONFLICT`；高负载下的假失败与超时一并修正。
- 采样器把逐条分发抽成可注入依赖的 `runCases`，「被拒的接口一个请求都不发」改由**真实主循环**验证（校验必须是 `fetch` 之前的步骤）。
- 并发静态守卫补：`switch` 的 `case` / `default` 子句里的同名声明同样遮蔽外层 rest 参数；迭代对象是**名前绑定的数组**（`const list = [opts]; for (const item of list)`）时照常追踪元素别名（初始化器解析加重入守卫，同一名字递归回来时保守放弃、不再栈溢出）。
- 闸门用例的断言失败路径同样收尾：`finally` 里释放全部闸门、收回已启动的操作、关闭 Store后才把断言失败交回 —— 此前挂起的原生语句会把用例拖到超时并污染后续用例。
- `prepare` 失败用例钉住「确实走到类型判定」的前提并断言后续目录查询不被同一注入波及；退役包装经命令出口 `thrownToExit` 渲染出 `retryable: false` + 「核对后再重放」hint 的完整输出（引擎层断言到 Agent 之间的最后一段出口不再无人看守）；重型查询的中断用例先等查询真正进入原生执行再返回（慢机上截止可能早于派发、中断会被驱动初始化清掉）。
- 并发静态守卫补：命名 hook 回调按**登记所在作用域**解析（兄弟套件各声明一次同名 `setup`时不再两份都不扫；同层重复声明按运行时语义取最后一次）；`for (item of [opts])` 这类**既有变量目标**同样带出元素别名，而裸标识符目标只算重新绑定、不算写入（只读循环不再被误判成「值已变」）；测试注册器的**本地别名**（`const check = it`）同样按登记处理；`isMutated` 的结果按 (文件, 名字) 缓存，多个互不相关的循环源不再各自重跑全文件扫描。
- captureSinks 的配置面守卫：仓库配置文件 / package 脚本 / 分片器不得启用`sequence.concurrent`（全局并发下写入无法归属；正则本身带双向自检）。
- 事务里程碑等待（`awaitMilestone`）在事务先失败/结束时立刻交回原始错误（此前裸等就绪信号，回调在里程碑前抛错时只能等 90s 超时）；原生中断用例里事务内 `count` 的结局按调度接受「先跑完 / 被中断 / 事务结束后才交回」三种确定形态；两段闸门用例的失败收尾改为**反复放闸**直到全部操作落定（第二道闸门在第一道释放后才创建，放一遍会漏）；`SELECT 1` 失效探针挂住的用例以「60s 超时」作 RED 证据（修复后毫秒级返回）。
- 并发静态守卫补：`beforeEach.bind(null, setup)()` 的预绑定实参、套件体内声明的命名回调、`{ __proto__: { sequential: true }, ...opts }` 的未知自有键可能覆盖继承声明（不再误判串行）；完整属性链别名（`box.nested.opts`）、已解析命名回调的 hook 身份（被 await 的链不再误报）、`apply`/静态展开的实参还原、原型已确定串行时收口（不再把合法串行套件报成并发）、解构赋值左侧的重绑定目标；经容器属性读出的对象身份（`const box = { opts }; box.opts`）与「登记前被重新赋值的 hook 回调」（无法静态确认时响亮报告，不静默放过）；同文件唯一命名回调下钻。
- 并发静态守卫补：同文件唯一命名回调（`beforeEach(setup)` 下钻 setup 的函数体）、`for...of`字面量元素建立的别名（`for (const item of [opts])`）；条件表达式分支里的别名、数组展开（`[...[opts]]` 容器复制但元素身份不变，`[...opts]` 才是复制）、`Reflect.deleteProperty` 也算写入、catch 的解构绑定同样遮蔽 rest、timer 模块的默认导入；套件同写 `concurrent: false` 与 `sequential: false` 按串行判（不再误报并发）。
- 锁夹具：`close` 的**到达时刻**与 deadline 分开比（截止定时器迟到、close 先交付时，seed 不再把 exit 0 当按时完成、verdict 不报 OPENED 而报 TIMEOUT）；就绪信号必须被观察到在 `deadline` 之内（截止后才出现的 marker 不算）、失败描述统一带子进程 pid、子进程 close 未确认时保留夹具目录；「夹具隔离」回归改为单条自包含用例，故障注入用例的 Store 收尾放进 `try/finally`（断言失败也不泄漏实例）。
- 并发静态守卫补三处看不见的形态：`Object.setPrototypeOf` / `Reflect.setPrototypeOf` 换原型同样是写入（原型链上的 `concurrent` 对套件生效）；被更近局部绑定（块级声明 / 更近同名参数）遮蔽的rest 展开不再当转发边界；套件同写 `concurrent: true` 与 `sequential: true` 时按 Vitest 的解析判串行（此前把合法串行套件判红）。
- 并发静态守卫再补四种看不见的形态：**解构赋值**建立的别名（`[a] = [opts]` 之后写 `a`）、计算键是**逗号表达式**（`[('x', 'concurrent')]` 取最右值）、调度原语经 **timer 模块导入改名**（`import { setTimeout as later } from 'node:timers'`，含命名空间导入与 `.call`）、以及**解构声明**与 rest 参数同名时的遮蔽（`const { args } = …`）。
- 并发静态守卫继续补形态：**解构默认值**里的别名（`const [a = opts] = []`）、同时存在的**多个**timer 命名空间导入、vitest 的**命名空间导入** hook（`import * as vt from 'vitest'; vt.beforeEach(…)`）、更近的**解构参数**遮蔽外层 rest、以及**接入键**的逗号表达式（`it[(0, 'concurrent')](…)`）与声明侧同一条解析；并发豁免只对**测试登记**的 `.concurrent` 生效（换成 `describe.concurrent` 或选项形态顶掉同名用例不再被豁免）。
- 迁移形态判据认**命名空间导入**（`import * as cap from './capture.js'; cap.captureSinks(…)`）；并发豁免同时排除**参数化登记**（`it.concurrent.each(…)`）。
- 并发判据认 vitest 的**命名空间导入登记**（`import * as vt from 'vitest'; vt.it.concurrent(…)` /`vt.describe('x', { concurrent: true }, …)`）。
- 跨进程锁校验只接受**正常退出**的结论：校验器写出 `OPENED` / `CONFLICT` 后因信号（OOM /外部 kill）或非零退出而死时，残留 JSON 不再被采信；「没有结论」优先交回，点名退出状态与stdout/stderr（信号终止与非零退出两形态各有用例；删掉闸门即红）。
- 引擎失败判据的拒绝值形态两路钉住（`null` 与 `kind` 访问器抛异常）：交回值必须是**同一引用**。
- 并发静态守卫补：`sequence.concurrent` 的配置面按**值**判（`--sequence.concurrent=false` 是显式关闭，引号包裹的键名一样启用）；命名 hook 回调的**本地别名**（`const init = setup`）沿不可变初始化器追踪；`for (opts of […])` 改写被登记绑定本身才算写入（按收集前快照判，只读循环的新变量目标不再被误判）；`isMutated` 只缓存最外层求值结果（嵌套求值在别名扩张窗口里的半途结论不落缓存 —— 该深度判据无独立可观测用例，如实按结构性防护记录）。
- 迁移形态判据认**本地别名**（`const install = captureSinks`，含命名空间别名，沿已知初始化器追到不动点）；hook 的**常量元组展开**（`beforeEach(...hooks)`）照常下钻，解析不出的展开（参数 / 非字面量）**响亮报告**而不是当成「没有实参」；hook 回调的别名链**无法静态确认**（重赋值后 / 参数形参 / 非函数初始化）同样报告（Codex 第十三轮 P2）；使用点上**参数绑定遮蔽**同名执行体时按未知选项判（`it('x', body)` 的形参运行时可能是 `{concurrent: true}`）；同一段文本里**每一处** `--sequence.concurrent` 旗标都要看（`=false` 后面再启用不再被第一处遮住）。
- 纯文本扫描器在函数边界只跟随**会被交出的值**（表达式体 / `return` 表达式 / 被 `return`的变量初始化器 / 构造器 `this.x =` 字段）：立即执行的块体箭头里只用于变量声明、且从不返回的 `new Error` 不再被当成可见（判据用原始 `new` 节点，不用正在跨越边界的子节点）。
- 持锁者收尾统一走 `terminateHolder`：监听先挂再 `SIGKILL`，有界等待 `close`（stdio 与库句柄真放开后才交回）；宽限内没有 `close` 或 `kill` 自身抛错都**响亮失败**（后者原错误挂 `cause`），不再把「清理未确认」说成正常收尾。
- 变异记录（每条新增守卫删掉 / 改坏即红）：删本地别名决议 → 别名用例红；不展开常量元组 →元组用例红；不报告无法解析的展开 → 对应用例红；去掉参数遮蔽判据 → 遮蔽用例红；`matchAll`退回单次 `exec` → 多处旗标用例红；别名链 `null` 不报告 → 别名链用例红；删构造器 `this`交出判据 → 匿名类样本红；删 `flowsToReturn` 闸门 → 变量声明丢弃样本红；`terminateHolder`不等 `close` → 宽限用例红（promise resolved）；`stripCaseEnds` 退化为不剥离 → `EXPLAIN`CASE 用例红；预编译期探针不记账 → 提交误报成功；收尾只看 `stuck` → 探针已交回用例红。
- 分类判据回归（Codex第十四轮）：带注释/字符串关键字的 `range(nextval('s'))`只求值一次（基线语义：1行、下次取值2；旧分类路径实测2行/3，自动提交下还会内部断言失败）；`EXPLAIN ANALYZE SELECT 1 AS start`、`(ANALYZE) … AS "transaction"`不再被误拒；`EXPLAIN ANALYZE COMMIT` / `(ANALYZE) ROLLBACK`仍按词法判据拒收（判据自检：真驱动枚举了全部 type=10写法）。
- 锁夹具的「marker 就绪 → 锁对另一进程可见」按 helper 文档的竞态窗口处理（CI Node 22 job 实测两种模式各偶发一次 OPENED；本机含 CPU 压力无法复现、根因未定位）：新增有界等待`conflictWithin`（默认 5s 窗口、200ms 复查），窗口耗尽仍是 OPENED 照常判红；「锁晚到」用例用闸门把拿锁时机变成确定性的（marker 已到、锁未落盘时首查必为 OPENED，开闸后窗口内落到CONFLICT）；机制层用例用可注入读源钉住「窗口内继续等」「耗尽不得改写 OPENED」「TIMEOUT 不重试」。
- 端到端用例标题改用 `%s`（vitest 2.1.9 不替换 `$0`，此前 CI 失败时分不清是 READ_WRITE 还是READ_ONLY）。
- `terminateHolder` 在「kill 接受信号、失败只经原生 `error` 事件到达、随后宽限内 close」时，清理已确认后仍把原始错误交回（此前只检查同步抛出的 kill 错误，会把「信号没送达」吞成成功；Codex 第十五轮 P2）。
- 变异记录（第六十八轮）：去掉嵌套深度 → 嵌套注释用例红；`terminateHolder` 退回只看同步 kill错误 → error→close 用例红；`conflictWithin` 单次化 / 耗尽改写 OPENED / holder 永不拿锁 → 机制与端到端用例各红；全部恢复字节一致。
## [0.2.2] - 2026-11-12

> tag `v0.2.2` 指向 main `2354cdf`（GitHub / GitLab 双远端），已 publish 到 npm；
> 沙箱安装实测：`qiyu --version` = 0.2.2、`skill check` 退出 0。


> **本段的逐轮审查明细已折叠（2026-11-27）**：每条只保留一句结论；「N 处契约修正」批保留全部 N 条
> （每条约一行，`tests/docs.test.ts` 钉数词与条目数一致）。完整取证过程在 git 历史。


### 文档

- **文档一致性回写（PR5）：陈旧声明改实况 + 承诺收窄，四个文档 + 一处 skill 正文，配 13 条双向自检守卫**。（逐条明细见 git 历史）

### 修复

- **真实凭证端到端实测发现的会话导出两处硬故障 + 契约诚实性收敛（2026-11-07/08 多代理审计，每条发现先复现再改）**（逐条明细见 git 历史）
- **skill / 凭证 / CLI 输出的三十八处契约修正（2026-11-06 独立三路审查：skill 域 / auth 与凭证域 / cli 与输出域，24 条发现逐条先复现再改）**：
  · **`skill install` 与 `where` / `check` 对「受管文件集」的口径分叉**：install 把用户额外放进 skill 目录的任意文件也算成「可能被手工修改」并建议 `--force`，而 `--force` 又不管这些文件 —— 提示永远不收敛；`check --compare` 还会无端退 1。
  · **三条检查规则的释义与实现不符**：`table_name` 是「写了就红」（不查表是否存在）、`sql_sequence` 要求 SELECT 与 FROM 同时出现（`DROP TABLE` 不属这条）、`unknown_positional` 按命令 spec 域判定。
  · **`skill where --dir` 时把启动探测的结论套到本命令上**：启动探测不读命令行参数，定位不到实体时说的是「未安装/已过期」，而本命令的实体根本不来自探测。
  · **清单被占用时 `--force` 的效果被写成单一状态**：实测两种状态 —— 正文被手工改过时`--force` 只覆盖正文（status 报 updated），正文与包内一致时连 `--force` 也零写入（status 报 skipped）。
  · **`--profile` 不作用于凭证**：sync run / sync verify 的存储路径、机器人配置读的是`--profile` 档，凭证却只按环境变量 / 默认档取 —— 多档用户会拿 A 档的 key 去开 B 档的库。
  · **`auth login --profile` 写非 default 档后默认档名是否跟着改没说清**：行为（顶层默认档名不变）是刻意的，但文档没写 —— README 与 login 的字段说明补上「之后的命令仍须用`--profile` 或 `QIYU_PROFILE` 指向它」。
  · **顶层 `--help` 漏列 `auth login`**，而测试还用「未实现」把它钉死 —— 帮助清单与`command-tree` 用例同步补齐，测试改为按命令树集合对照。
  · **`auth login` 对已存在的 0755 目录的处理被文档说过头**：实测已有目录原样保留（不改权限，只对**新建**目录设 0700），文档 5 处收窄为「新建的目录 0700」，并新增用例钉住「不改已存在目录」。
  · **配置文件权限判据的文案窄于实现**：实现拒绝任何 group/other 权限位，文案只说「group/other 可写」—— 0644（可读）能通过提示却同样会泄漏 appSecret。
  · **`resolveCredentials` 的 `fromArgs` 形参是死参数**：没有任何调用方传过非空值，「预留的第三来源」只会让人以为凭证可以从命令行给。
  · **README 的脱敏承诺大于实现**：改写为「请求/响应链路」的输出都会脱敏，并明写边界 ——不扫描用户自己敲进 argv 的凭证（`auth login` 拒收 `--app-key` 正是为了这个）。
  · **配置文件权限警告的用例是空转**：原用例把 stderr 攒在内存变量里却断言别的东西，警告删掉也不红。
  · **帮助与 README 的 error kind 清单漏 `sync_not_run`**：三个帮助入口补齐，README 改成「常见值，不是穷举」并指向 `ERROR_KINDS` / skill `errors.md`，新增 `--help` 运行时断言。
  · **`api call` 的「不接受任何参数」与事实相反**：它接受 `--help` / `--pretty`。
  · **`auth login` 写盘失败的 hint 会把人引向不存在的路径**：配置路径由 `HOME` 固定、CLI 没有改路径的参数，旧 hint 却让人「检查路径」。
  · **纯空白凭证被当成有效值**：`' '` 是 truthy，一路穿到签名，服务端回 14001 ——报错点离真正给坏值的地方隔了一层命令。
  · **控制台地址一处写成唯一形态**：两种写法都有（有无 `admin` 段），以后台真实页为准，两处都列出；尝试浏览器核对未登录、无法实证，如实标注为未验证。
  · **`--help` 与合法参数同现被判「未知参数」**（8 个命令族）：`--help` 是帮助请求，追加的已知参数（如 `query --help --sql`）不该报未知。
  · **`--help` / `--version` / `--pretty` 三个伪命令互相不豁免**：`api list --pretty --help`一类组合会被一侧判成未知参数，三处统一按「全局选项任意次序」处理。
  · **退出码 1 但 stdout 仍是 `{ok:true,…}` 的路径没有机器可读标志**：skill check 两条路径（单文件检查与 `--compare`）都补了**真实的** `meta.exit_code` 字段与图例，写明「不要按 `error.kind` 分支、也不要用『有没有 error』判断检查是否通过，先看退出码」。
  · **`output.test.ts` 的 kind 覆盖不全且集合断言自比较恒真**：旧表只钉 9 个 kind、其对照组两边都是本文件常量（除自相矛盾外恒真）。
  · **`query --help` 的额外参数列表是自拼字符串**：空串会渲染成「冒号后空白」，且不点名取值。
  · **「可用：」清单一处列 `--pretty`、两处不列**：三处统一为同一份清单来源。
  · **`check --compare` 只比清单文件集**（Codex）：与 `install` 同款缺陷的第二处 ——包新增文件后，实体与包在旧子集上相等 → CI 的 `--compare` 退 0 漏报「装的是旧包」。
  · **`--profile` 拼错被报成缺凭证**（Codex）：凭证侧先按 flag 选档，拼错的档选不到凭证 → `auth_missing`（退 1），而真相是参数错误（退 2）。
  · **帮助模式的取值规则与正常解析不同源**（Codex 两轮）：`db tables --db --bogus --help`曾打印帮助并静默吞掉 `--bogus`；改成「取值不以 `--` 开头才跳过」后又把`query --sql "-- 注释…"` 的合法 SQL 判成未知 flag、且 `--db --help`（缺值）不报。
  · **EACCES 用例在 root / Windows 上假失败**（CodeRabbit）：收掉目录写位造不出EACCES，改用 `it.skipIf`（仓库既有约定）；
  · **`whoami` 漏了配置文件里的空白凭证**（Codex）：只查环境变量时，文件里的 `" "`被 `nonEmptyValue` 当成「有」→ `configured: true`，而 api/sync 会拒绝它。
  · **`writeWideConfig(mode)` 的 `mode` 没被用上**（CodeRabbit）：0602 / 0601 两条用例实际跑在 0644 上 —— 上面 A5 那条「两条用例钉住判据与措辞」在修复前是**假的**。
  · **文件集比对把「重复条目」当相等**（Codex 第四轮）：清单含重复条目并漏一个文件时长度恰好相等 → `check --compare` 退 0、`install` 的 `--force` 也跳过修复。
  · **`sync tasks --help` 用全族并集校验参数**（Codex 第四轮）：兄弟命令的`--full` / `--db` 被当成合法参数（退 0 打印帮助），而正常解析与 `skill check`都判非法 —— 运行时与契约校验又一次分叉。
  · **umask 077 下的夹具假失败**（Codex 第四轮）：`mkdirSync({ mode: 0o755 })` 会被进程 umask 收紧成 0700，断言 0755 的用例假失败 —— 夹具改为显式 `chmodSync`；
  · **受管条目直接 `readFileSync` 会挂死**（Codex 第五轮）：换成受管集哈希后，清单里一条被 **FIFO** 占住 → `readFileSync` 打开读端等写端 → `install` 与`check --compare` **无限阻塞**（实测去掉筛选后进程跑满 600s、`testTimeout`打不断同步读取）；被换成**指向目录外的符号链接**则读取跟随、可能误判「正文一致」。
  · **README 的 `--profile` 建议对部分命令不可执行**（Codex 第五轮）：`api *` /`auth whoami` / `sync tasks` 都**不接受** `--profile`（逐个实测退 2），原文「在每条命令上写 `--profile staging`」是做不到的动作。
  · **接受清单里错列了 `sync uninstall`**（Codex 第六轮）：它只接受全局 flag 与 `--yes`（实测 `sync uninstall --profile staging` 退 2）—— 照新文档执行必然失败。
  · **清单文件自身是 FIFO 同样挂死**（Codex 第六轮）：上一处只挡住了受管正文，`readManifestSafe` / `readManifestStrict` 仍直接 `readFileSync` 清单 —— 清单路径被FIFO 占住时 `skill install` / `where` / `check --compare` 全部无限阻塞。
  · **`auth login` 的空白变量 hint 建议 `unset` 后重跑**（Codex 第七轮）：login 只从环境变量读、不回落配置文件（实测：`unset` 后重跑必然是「缺少 …」退 2）—— 照 hint 执行解决不了问题。
  · **whoami 的空白配置键 hint 建议「删掉这个键」**（Codex 第七轮）：`credentials`块要求 appKey / appSecret 同时是非空字符串，只删一个键会让 `parseConfig` 拒绝**整份配置**（实测：按旧 hint 操作后 whoami 变成「配置文件读取失败」，api/sync也读不到其它档）。
- **查询 / 存储 / 元数据命令的十五处契约修正（2026-11-05 第二路独立审查，三路探子 + 探针实测 + 十余轮双路收敛）**：
  · **执行期的文件访问与扩展加载被误报成「internal，请报告此问题」**：layer2 拦截（`sniff_csv` 这类在执行期才碰文件的函数）与 `Extension Autoloading Error` 只判在prepare 期，执行期 catch 一律包成 internal —— 用户拿到的是「请报告此问题」，而真相是「沙箱拦截了它，换个写法就能跑」。
  · **写者撞锁把持有者说成「写进程」**：实测 DuckDB 是「写者独占 / 读者共享」，一个READ_ONLY 会话同样挡住写者；旧文案让 Agent 去等一个并不存在的同步任务。
  · **库文件已损坏没有归因**：截断（`Could not read enough bytes from file`）与页校验和（`Corrupt database file: computed checksum` 不同）两类报文此前既不匹配权限、也不匹配「非 DuckDB 文件」，落进各命令的兜底 —— `store status` 说「请用 store status 检查」（拿自己查自己）、`query` 说「跑 store init」（对损坏文件同样打不开）。
  · **`mask_warnings` 图例只讲了一半来源**：该键还装 `GROUP BY` / `DISTINCT` 压平、`query()`/`query_table()`/`COLUMNS()` 嵌套、非敏感列按值形态误改 —— 图例改为按「缺口 / 副作用」两组穷举并声明「包括但不限于」。
  · **`GROUP BY` 别名列漏掉分组失真警告（判据只看分组键）**：`SELECT userPhone AS p … GROUP BY p` 的输出列不叫 `userPhone`，判据只看输出列名 → 只剩「别名缺口」一条，而「3 个号码被压成 1 行」一个字不提。
  · **`db describe` 的 `time_column` 图例路径错位**：枚举翻译挂在 `time_column` 上（实际在 `time_column.kind`），而 `time_column: null`（没有声明时间列）没有释义。
  · **OOM 报文透出沙箱里必然失败的 `SET` 建议**：DuckDB 的「Possible solutions」三条 SET在只读沙箱（`lock_configuration=true`）里全部报 `configuration has been locked`。
  · **时间过滤静默丢掉脏时间值**：`query --table --since/--until` 的 WHERE 里带形态谓词，脏值行不进 `rows`、不进 `data_coverage`，而 `db tables` 对同一张表会报数量 —— 现在`query` 也点名数量并说明它们被排除（没有时间过滤时不报：那时脏值行照常返回）。
  · **元数据命令的超时 hint 建议了它们没有的参数**：`db tables` / `db describe` /`stats fields` 共用 `query` 的「缩小时间范围或加过滤条件」，而它们不接受任何过滤参数。
  · **带正则元字符的别名会让脱敏阶段崩掉**：`SELECT userPhone AS "p(" … GROUP BY "p("`的查询本身已成功，`wordHit` 却把别名直接拼进 `new RegExp`，`\bp(\b` 抛 SyntaxError ——整条命令报 internal、一行数据都拿不回来（`AS "[x"` 同）。
  · **分组判据不认子句的作用域**：`GROUP BY` / `DISTINCT` 的起点取的是**第一个**匹配，而它可能在子查询里 —— `SELECT userPhone … FROM (SELECT any_value(userPhone) …GROUP BY session_type) t GROUP BY userPhone` 只看到内层那次分组，外层真正把手机号压平的那一次反而漏报（Codex 第四轮 P2）。
  · **表达式别名不产生分组警告**：别名解析只认「列名紧跟别名」，`SELECT lower(userPhone)AS p, COUNT(*) … GROUP BY p` 实测按 `lower(userPhone)` 分组、脱敏后两个号码塌成一行，却一条警告都没有（Codex 第四轮 P2）。
  · **`DISTINCT` 判据既不看作用域、也丢了过去重键**（两个方向都错）：`WHERE x IN(SELECT DISTINCT x …)` 里的内层去重被当成外层 `DISTINCT`，拿外层选择列表判完就对外层投影的敏感列谎报分组失真（CodeRabbit 第五轮 minor）；而 `DISTINCT ON (…)` 的去重键是`ON (…)` 里的**列**、不是整张选择列表 —— 收敛作用域时把 `(ON\s*\()` 的捕获组写成非捕获组，于是 `SELECT DISTINCT ON (session_type) userPhone …`（实测按 session_type去重）被误报（Codex 第五轮 P2）。
  · **撞锁提示里残留「写锁」自我否定**：写者撞锁的 hint 前半句写「正持有该数据库**写锁**」，后半句又说持有者可能是只读会话 —— READ_ONLY 持有的是共享锁，前半句把同一个错误归因带了回来（CodeRabbit 第十三轮 minor；测试只锚后半句，所以一直没发现）。
  · **`SELECT DISTINCT(userPhone)` 无空格写法零警告**：两处 `DISTINCT` 正则都要求 `\s+`，而 DuckDB 实测接受无空格写法并去重（3 行 → 2 行）—— 这条查询会一条警告都没有，比改动前的判据（任何 DISTINCT + 命中列名即报）还退步（CodeRabbit 第十四轮 minor）。
- **同步与调度的十处契约修正（2026-11-05 独立审查）**：
  · **launchd 的 Weekday 被整体后移一天**：cron 与 launchd 是**同一套**周几编号（man launchd.plist：「0 and 7 are Sunday」，1 = 周一），旧代码 `v + 1` 让「周一执行」装成周日，**每条按周计划都错一天**；而测试把错误行为钉成了期望值（断言 cron 1 → launchd 2）。
  · **`sessions.export` 的缺 id 行造成整窗回滚**：缺 id 行此前留到 enrich 才丢，而`apiCount` 按**丢弃前**的行数取好 —— written < expected → 整窗 count_mismatch回滚（连正常行一起丢），gap 只说「应写 N 实际 M」不点名成因。
  · **cron 分隔符只接受空格与 Tab**：`trim()` / `split(/\s+/)` 会把 CR/LF/U+00A0/U+2028 当空白放过，而 schedule 原文又原样进 crontab 兜底行与回显 —— 实测`0 0 *\r* *` 解析成合法 5 段、兜底行里是字面 CR（cron 整行失效），`0 0 * * *\n` 把一条计划劈成两行。
  · **linux 卸载把 daemon-reload 跑在删文件之前**：命令层是「跑完 commands 再删文件」，于是 reload 的仍是即将被删的 unit，删完后没人让 systemd 忘掉它（notes 却写着「再删除 unit 文件并 daemon-reload」）。
  · **schtasks 分钟计划的相位漂移**：`/SC MINUTE /MO N` 缺 `/ST` 时起始时刻取「本机当前时刻」，`*/30` 会装成「安装那一刻 + 30 分」的相位（14:07 装 →:07/:37），而 cron 是 :00/:30。
  · **schtasks 每月计划用多日 `/D`**：`/SC MONTHLY /D` 只接受一个日期（文档原文），`0 0 1,15 * *` 此前被 join 成 `/D 1,15`，dry-run 先给出一个装了也会被拒的计划。
  · **systemd `ExecStart=` 孤立一个 `;` 未转义**：裸 `;` 是命令分隔符，会把一条ExecStart 劈成两条命令（systemd.service(5)：「An argument solely consisting of";" must be escaped, i.e. specified as "\;"」）。
  · **快照任务不用 `apiCount`**：windowed 与 `sync verify` 都把它当配对核对基准，快照只用 `kept.length` —— 同一字段三条路径三种读法，上游声明多于解析结果时只有快照静默吞掉。
  · **四处图例口径**：`rows.written` 补「快照的 count_mismatch / write_failed 记 0（偏小而非偏大）」并修正 README「落库行数」的绝对说法；`rows.fetched` 改为「进入引擎的行数」并点明 fetch 侧丢弃行不计入；`range_status.pending` 的「每轮开跑就置 pending」收窄为「有可执行窗口的轮次」；`commands[].command` 点明是 argv空格拼接、不能直接粘进 shell（win32 的 `/TR` 本身就是命令串）。
  · **同一窗的两类缺口互相覆盖**：`sessions.export` 既可能缺行（`row_missing_key`）又可能缺尾部标记行（`export_fixture_unreported`），旧实现让后者「让位」，消费方按`gaps[].reason` 分支时永远漏一类；而 `sync_gaps` 主键 `(dataset, range_start)` 也让两条提示在落库时互相覆盖。
- **注册表与 api 图例的九处契约修正（2026-11-04 独立审查）**：
  · **`export.session` / `export.session.check` 的唯一载荷被丢弃并谎报「无数据」**：设计稿 §7.5 实测两者的成功载荷就是 message 原文（任务 key / 下载链接），同步流水线也按此实现；但注册表把它们登记成形状 A（载荷在 data），而响应里没有data —— `api call` 输出 `"data":null, "not_found":true, "warning":"接口返回成功但无数据"`，Agent 完成导出创建后拿不到 key。
  · **`export.*` 四个文档外接口的 body 参数表是空的**：生成器对它们硬编码`params: []`、`body_kind: 'none'`，而 create/check 的 body 是必需的、流水线就在发。
  · **`icoutcall.history.team` 的路径与 seat 完全相同**：设计稿两处记载 team 是独立路径`/ipcc/history/team`、载荷为对象（55 字段），而注册表沿用了文档页重复项（与 seat同路径、信封 C 数组）—— 按旧登记调用会把 team 的 body 发到 seat 路由、静默拿到坐席数组。
  · **`api list` 的 `verified` 图例把「实测范围」全指给每行 note**：53 条 verified:true里 42 条没有 note，Agent 无从判断。
  · **`path` 图例说 null 路径「仍可能是本方可主动调用的」**：加载器强制`callable:true` 必有 path，该组合不可达。
  · **`body_kind` 图例说非 json「原样透传」**：实现恒 `JSON.stringify` +`application/json`，xml/multipart/text 的原始字节无法表达（`--body '<xml>'` 直接退出码 2）。
  · **`params[].type/required` 的强制范围漏了 body_kind**：`validateBody` 对`bodyKind !== 'json'` 直接早返回，`kefu.add`（xml）传 `{}` 不报缺必填；图例却承诺「缺必填拒绝」。
  · **`warnings` 图例把 `missing_required` 列为告警 kind**：它是硬拒绝（退出码 2、错误信封），永远不进 warnings。
  · **`not_found` 图例漏掉 message 载体与宽松模式**：形状 C 或 envelope 未登记时，message 能解析成 JSON 且解析结果为空同样置位。
- **核心请求/错误/存储写入的九处契约修正（2026-11-04 独立审查）**：
  · **配置文件解析失败会回显文件内容（安全红线）**：`readConfigRaw` 把 V8 的`JSON.parse` 原文拼进错误（实测 `Unexpected token 'X', "FAKESECRET..." is not validJSON`）——配置文件里就有 appSecret，等于把凭据前若干字符写进 stdout。
  · **HTTP 429 被当成「可能已执行」的网络故障**：429 是服务端在执行业务逻辑**之前**拒绝的限流（肯定没执行），却被归 `network` —— 危险接口收到「请求可能已被服务端执行，重发会再执行一次」的反向劝阻，且不带任何等待建议。
  · **限流 hint 把「实测无限频」说成「未登记」**：`limitFor` 把两者压成同一个 null，5 个显式登记为 `null` 的接口（如 `export.session.check`）撞限流时被告知「未登记在本地限频表」——与 `api schema` 的 `rate_limit` 图例（「null = 实测过，确实没有」）直接矛盾。
  · **`14004 appId not bind` 被说成「核对字段名与类型」**：真实成因是账号未绑定公众号，改参数与重试都无效。
  · **`retryAfter.source:'local'` 的注释断言「交付形态不可达」**：`qiyu sync run` 在同进程对同一路径反复 `call()` 时就会撞上本地令牌桶（`pace.ts` 专为它而写），注释会让后续维护者把它当死值。
  · **`--no-validate` 的 usage 只说「关闭 body 校验」**：它实际还关闭别名改写与warnings（spec §九 验收 19 的既定语义）。
  · **未知接口 id 的 hint 指向默认 `api list`**：默认列表只含 136 条可主动调用接口，入站接口与不可调用项要 `--all`。
  · **`integer` 类型校验放行 1.5**：只判 `typeof === 'number'`，小数 id/页码静默通过，而图例承诺「类型不符是软告警」。
  · **同批重复主键的 upsert 结果取决于 batchSize**：DuckDB 多行 `INSERT ... ON CONFLICT`在同一语句内遇到重复键保留**第一条**，逐条写入则后一条获胜。
- **#63 新增图例的自查修正：params 的「通道」谎言、recorded_at 形态说反、rows.written 记法（2026-11-04）**（逐条明细见 git 历史）
- **反向图例覆盖：18 个带图例的命令补齐「输出 ⊆ 图例 ∪ 自明键」，下沉到元素层（HANDOFF #38 挂账，2026-11-04）**。（逐条明细见 git 历史）
- **报表空载荷漂移守卫：`{}` / `[]` 不再被当合法空窗（HANDOFF 报表层 #6，2026-11-04 真实上游采样）**。（逐条明细见 git 历史）
- **sync 行丢弃留痕：缺主键列的行不再静默消失（HANDOFF 报表层 #5，2026-11-03/04）**（逐条明细见 git 历史）
- **skill install/where/check 五处契约不诚实（独立审查 #9–#13，2026-11-03，逐条真实 CLI 复现）**（逐条明细见 git 历史）
- **报表/窗口五处数据完整性缺陷（独立审查 agent「报表与窗口数学」路线，2026-11-03，逐条探针复现）**（逐条明细见 git 历史）
- **七处错误出口 / 限频闸门缺陷（独立审查 agent 第六轮，2026-11-02，逐条真实命令复现后修）**（逐条明细见 git 历史）
- **三处「说的和做的不一致」（独立审查 agent 第四轮，2026-11-02）**（逐条明细见 git 历史）
- **同一族缺陷的另外两个载体 + 一处文案分档（Sourcery 复审与独立 agent 第五轮，2026-11-02）**。（逐条明细见 git 历史）
- **四条错误分类判据（本轮第二批落点）之外，另有五处独立缺陷**（均由独立审查 agent 发现并复现）（逐条明细见 git 历史）
- **同一形态的第三批落点：四条错误分类判据也是裸子串判，能被列值与 SQL 回显仿冒**。（逐条明细见 git 历史）
- **撞锁判据的子串搜索把「路径里含 `Conflicting lock` 的非 DuckDB 文件」判成撞锁**。
- **`db` / `stats` 的「未知参数」把空串渲染成隐形**。`query` / `api` 早走 `describeArgs`（空串渲染成 `''`），`db` / `stats` 共八处仍是裸 `join(' ')` —— `db tables ''` 得到「未知参数：」冒号后一片空白，退出码 2 的全部价值（「改哪里」）丢失。八处统一改走 `describeArgs`。
- **`sync run` 的 `tasks[].gaps` 图例用位置指代「后四个 reason」**。
- **`tests/store-field-notes.test.ts` 的文件头与文件内断言互相矛盾**：头部注释写「`db tables`只列业务表、两边数量不同」，而下方用例 `expect(dbNames).toEqual(storeNames)` 早已证伪（实测两边都含内部表、都是同一组）。
- **DuckDB 报文回声污染：用户数据与用户 SQL 能把错误伪装成「查询超时」或「沙箱拦截」**。（逐条明细见 git 历史）
- **`store status` 遇到库里有未声明的表时整条命令失败（`未知表：stray_table`，退出码 2）**。
- **`TYPE_NAMES[21]` 写成 `INSTALL`，驱动枚举里 21 是 `LOAD`**。
- **skill 正文 `errors.md` 仍教「结束边界不得晚于今天零点」**。
- **只读库前置检查的三份副本收敛到 `src/commands/store-precheck.ts`**。`db` / `sync` / `store` 各自维护一份 `statGuard`（不存在 / 权限 / 非普通文件）与 `schema_version` 缺表探测，`store init` 还把命名管道、设备等特殊文件一律报成「是目录」（`!isFile()` 覆盖四种成因，文案只写了一种）。现在七个读命令对目录 / FIFO / 字符设备 / 父目录 `chmod 000` / 不存在 / 空库 / 他人库给出逐字相同的 hint，特殊文件报「不是普通文件」。
- **三条恒真的漂移守卫**（独立审查发现）：`tests/docs.test.ts` 的「补全承诺限定末残段」反锚用的锚句 `由下轮日对齐` 已不在正文里，循环零次迭代；`tests/commands/command-tree.test.ts`的「first 只许在第一槽位」在真实树上零次迭代（没有命令有两个槽位）；README tables 形态断言的备选正则 `/name.*rows/` 会撞上无关段落，删掉被守卫的原句仍绿。
- **同一起因、两个命令族、两种说法：「打开库文件失败」的解码规则收敛到单一实现点**。
- **`store` 的权限错误归因是死的：真实 EACCES 拿到「数据库执行期错误」的 hint**。
- **撞锁用例的 `catch` 把断言失败说成平台竞态**（`tests/store/duckdb.test.ts` 读/写两条）。
- **只读接口实测收口（20 个）：A6 的 `verified:false` 从「全都未实测」变成「逐个如实登记」**。（逐条明细见 git 历史）
- **只读诊断 hint 不带存储选择：照做会去读默认库，Agent 据此断定「表真的不存在」（#45 边界 ②）**。
- **反向图例覆盖不完整（#38 挂账）：`stats fields` 的 `table`/`sentinel` 与 `query` 的 data 字段无释义，`api schema` 无「输出 ⊆ 图例」方向**。
- **README「尚未实现」清单的测试是假护栏；`auth` 字段可能与「无条件签名」矛盾；README 横幅陈旧**。
- **恢复命令的 hint 不带存储选择：照做会在默认库上建库/同步，原问题原样保留**。
- **`db describe` 缺表时给的成因是错的：`表 X 在库中不存在（未同步或未建库）`——两个成因都到不了这个分支**。
- **`sync run --since ''` / `--until ''` 被静默当成「没给区间」，`--full --since ''`因此绕过互斥守卫跑了一次全量重刷**。
- **空串存储环境变量：`QIYU_DB_PATH=` 让配好的 `store.path` 失效，且报错谎称它也是空的**。
- **空串档名：写凭证的命令与读凭证的命令解出两个不同的 profile**。
- **`sync run` / `sync status` 的 `watermark` / `last_synced_at` 没有释义，而它们是 UTC `Z`形态、与同一行里的 `resolved_range`（`+08:00`）写法不同**。
- **`api schema` 的图例键 `auto` 指向一个不存在的顶层字段（真实字段在 `params[].auto`）**。
- **`sync status` / `sync verify` 的图例键全是裸字段名，按图例路径在输出里什么也找不到**。
- **`store --help` 声称「CLI 不会自动创建配置文件」，而 `auth login` 会创建它**。
- **`skill check` 三种形态都没有图例，`violations[].rule` 是 10 值闭集**。（逐条明细见 git 历史）
- **`api call` 是最后一条没有图例的成功命令；README 还把它当成「只有 `{ok,data}`」的例子**。（逐条明细见 git 历史）
- **`sync install` / `sync uninstall` 的四种输出都没有图例，且 `commands[].ok` 是三值**。（逐条明细见 git 历史）
- **`sync uninstall --yes` 在 Windows 上什么都不做，还报告「未安装」（写图例时发现的真 bug）**。
- **最后三处无图例的输出：`skill where` 的 `cli_contract_version`、`--version`、`auth login`**。（逐条明细见 git 历史）
- **`store init` / `store status` 无图例，且 README 把两者的 `tables` 形状说成同一个**。（逐条明细见 git 历史）
- **`db describe` / `db tables` 把「声明」与「实况」混在同一层输出里，字段名不区分**。（逐条明细见 git 历史）
- **`query` 的 9 个 meta 键全仓无释义，其中三处的字面与事实不符**。`query` 是 skill 协议指定的主查询入口，而它的 `meta` 此前**一条释义都没有**（README 有散文，但 Agent 读的是 stdout）。（逐条明细见 git 历史）
- **`sync status` 的 `range_status` 两个取值字面与事实相反，且四个命令的状态位全仓无释义**。（逐条明细见 git 历史）
- **`stats fields` 是唯一没有 `meta.field_notes` 的读命令，`declared` 的机器值域全仓无释义**。
- **`declared.higher_is_better` 恒为 `null` 却没有任何出处**。
- **「清单缺失/损坏」的 skill 提示只推荐了一条只在半数成因下收敛的动词**。
- **`skill where` / `skill install` 的状态取值全仓无释义**。
- **`gaps[].reason` 与 `drift[].kind` 的取值全仓无图例**。
- **配置键路径在文档与提示里写不全，照做会被 CLI 自己的校验拒绝**。
- README 补上**配置文件的完整结构示例** —— 此前全仓没有一处给出它，这正是上面那类简写能长期存在的土壤。
- **同一个危险状态，两条路径两种行为：含凭证且权限过宽的配置只被其中一条如实报告**。
- `config_insecure` 的 hint 里路径**加 shell 引号**：配置路径来自 `HOME`，而 `HOME`可以含空格（`/Users/John Doe`）。
- README 的权限规则段补上**例外与边界**：不读配置的命令（`--version`、`api list`、`skill where`、`sync tasks`）不受影响；`auth login` 是唯一例外，它把已有文件重写为`0600` 而非拒绝（马上要写入新 secret，拒绝没有意义），写完自检不合格才报。
- README 成功信封段原写「**三个键恒在**」（`ok`/`data`/`meta`），与实现相反：`ok()` 在没有元数据时**故意不输出 `meta`**（`tests/output.test.ts` 把"未提供 meta 时不输出该键"钉成契约）。
- **拼错的 profile 名静默回落到默认库**。
- **2026-11-09/10 三路只读审计：查询/统计 8 条、CLI/凭证 3 条、同步 6 条，逐条复现实测后修正**（逐条明细见 git 历史）
## [0.2.1] - 2026-10-26

### 新增

- `qiyu skill where` 输出补**已安装正文**的版本元数据：`data.entity.installed = {version, skill_contract_version, compatible}` 与`data.cli_contract_version`；不配套时进 `meta.warnings` 并点名两个号。
- `skill_contract_version` 递增到 **2**：`SKILL.md` 新增了「用 `skill where` 判断配套」这一整段协议，且新正文**依赖**上述 `skill where` 新字段 —— 0.2.0 的 CLI 没有这些字段，契约号不动的话新旧组合会被判成「配套」（spec D6：正文结构性改变才递增）。

### 修复

- `qiyu sync --help` 曾把 `**至少成功同步过一次**` 原样打到终端（help 是纯文本，不是渲染后的文档）；`api call` 的 GET 守卫抛错文案同样含 `**`，经 catch 进 stderr。
- 用法错误与抛错文案的「无 Markdown 标记」规则此前只被 api/auth/cli 三个文件的哨兵表覆盖（全仓 `usageFail` 调用点有 117 处），新增全仓静态扫描（`tests/plaintext-channels.test.ts`，覆盖 `usageFail` / `throw new Error` /`process.stderr.write` / `*_USAGE` 的字面量，含跨行 `throw Object.assign(` 形态）。
- 补上 6 个此前**零覆盖**的用法错误分支（`api schema` 四条、`auth login` 的参数分支、`cli --version` 的额外参数守卫），以及注册表 `pageId` 的两条抛错分支（它们原来的断言是子串匹配，加星号照样通过）。
- 不配套警告曾建议 `qiyu skill install` —— 实测跑完是 `skipped` + 零写入，正文与警告都不变（正文一改，实体哈希就与包内不同，不带 `--force` 一律跳过）。
- `skill where` 的 `entity.installed` 键此前在实体不可用（缺失/非目录/检查失败）时整个消失，调用方拿到 `undefined` —— 与 SKILL.md 定义的 `null`（判定不了）是两种不同的沉默。
- 契约号与正文的绑定此前只靠测试从 `SKILL_CONTRACT_VERSION` 推导期望值 —— 改了正文忘了递增契约号，测试照样绿。
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

[未发布]: https://github.com/MisonL/qiyu-cli/compare/v0.2.3...HEAD
[0.2.3]: https://github.com/MisonL/qiyu-cli/compare/v0.2.2...v0.2.3
[0.2.2]: https://github.com/MisonL/qiyu-cli/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MisonL/qiyu-cli/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MisonL/qiyu-cli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MisonL/qiyu-cli/releases/tag/v0.1.0
