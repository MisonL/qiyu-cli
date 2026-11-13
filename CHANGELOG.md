# 更新日志

本项目的所有重要变更都会记录在此文件。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [未发布]

### 修复

- **`api call` 调用未实测信封的接口时，成功与错误信封都如实声明 `unverified_endpoint: true`**：
  注册表 154 条里 73 条危险接口有 72 条从未观测过响应信封（`verified:false`、`envelope:null`），
  但 `verified` 此前**只在 `api list` 输出**、`callOne` 从不读它 —— Agent 不先跑
  `api list --all` 就完全不知道「这次的 `not_found` 判定、`data` 解包与错误分类只是按文档推的」。
  后果不是抽象的：200 响应里没有载荷键时，信封未实测的接口不判 `not_found` ——
  「空 `data` 是什么意思」没人观测过，`envelope.ts` 记着 `deleteKnowledges` 的空数组
  其实是「全部删成功」，按读接口判据会被报成「什么都没删」。图例逐字写明这个边界，
  以及仍会置位的那个例外（`message` 能解析成 JSON 且为空，同时带 `warning`）。
  现在**所有错误出口也带**（Codex 2026-11-13 P2：只在成功路径声明、而图例明说错误分类也
  只有文档依据，等于自相矛盾）：业务错误、`needs_confirmation`、用法错误的 `error` 里都有
  `unverified_endpoint` 与 `endpoint`，**包括 `byId()` 之前就返回的那几条**（如 `--body`
  不是合法 JSON，CodeRabbit 2026-11-13 minor）。
  错误路径与成功路径口径不同：**已定位的接口在错误信封里显式给 `true | false`**
  （成功路径仍只在未实测时输出，避免对所有人变成噪音），Agent 不必去猜「键不出现」的意思。
  `api call` 的所有用法错误出口（重复 `--body`、未知参数、位置参数、`--body` 缺值/非法 JSON、
  凭证缺失）都经同一个 `failCall()` 带上它。
  实现时抓到并修掉一个**语义反转**：`fail()` 里曾把 `verified` 直接赋给 `unverified_endpoint`，
  于是已实测接口输出 `true`、未实测输出 `false`，与成功路径正好相反 —— 由新加的
  双向用例当场发现。
  图例同步收窄两处原本说过头的话：不再暗示「键不出现 = 该接口实测过」（未知 id 时同样不出现），
  也不再写「一律不判 not_found」（宽松分支仍会置位）。
  判据收敛为单一实现点 `unverifiedOf(spec)`，只在未实测时输出（已实测的接口不带，避免噪音）；
  守卫覆盖两个方向（`ticket.finish` 未实测必须带、`export.session` 实测必须不带）
  与三条错误出口，变异（删实现 / 改无条件 / 逐个拆出口）均实测变红。

- **`--since` 带相对时长时，区间终点不再取决于解析耗时**：`--since 1d` 的终点原本取自
  `parseTimeArg` 内部的时钟，随后「未给 `--until`」又调了一次时钟 —— 两次 `Date.now()`
  之间只要过去 ≥1ms，区间就从「1 天」变成「1 天 + ε」，`sliceByMaxWindow(…, 6, 1)`
  于是切出**第二窗**（起点 = 终点−1 天，几乎与首窗重合）。它被合并窗机制计入 `contained`，
  而覆盖窗失败时按 `skipped` 结算 —— 同一个 `sync run`，同一份凭证，`windows.total` 会是
  1 或 2、`skipped` 会是 0 或 1，全看这两次读钟之间隔了几毫秒。
  2026-11-11 CI 的 Node 24 job 因此拿到 `total: 2`（Node 20.12 / 22 与本机都是 1 ——
  日志只证明它们没触发；推断是两次读钟落在同一毫秒，未做逐 job 的计时埋点）。
  现在区间合成的整段只读一次时钟：`--full`、`parseTimeArg`、以及「缺 `--until` 时的终点」
  共用同一个时刻，区间长度恰为用户要的时长，窗数不再随机器快慢漂移。
  由同一时刻派生的提示（非日界 `--until` + 日对齐任务）也复用这个时刻做**复解析** ——
  同一个 `--until` 必须解析出同一个边界，否则提示描述的日期与实际区间不同。
  ⚠️ 但两条**预测引擎钳制**的提示（请求区间早于接口下界、末端上限）仍**当场读钟**：
  引擎按任务执行时刻的 `nowOf(ctx)` 计算 `windowStartFloorDays` / `windowEndLimit`，
  整轮同步跨过上海午夜时，用早先采样的时刻会把「午夜后就能拉到」误报成「永远拉不到」
  （Codex 2026-11-12 P2）。读得越晚越接近引擎的判据；这一点是**近似**而非保证，
  且没有测试覆盖（`runSyncRun` 的时钟没有注入缝，跨午夜无法确定性构造）。

- **`npm ci` 不再打印 `Cannot find module .../dist/postinstall.js` 的堆栈**：
  npm 的 `postinstall` 在 `prepare`（= `npm run build`）**之前**执行，而本仓库自己就是
  那个包——于是在 `dist/` 尚未生成时，`node dist/postinstall.js || exit 0` 每次都先吐一段
  MODULE_NOT_FOUND 再被 `|| exit 0` 吞掉（CI 三个 Node 版本 job 各一次，用户看到的是
  「装依赖时报错了」）。
  脚本改为**保留路径式真实入口、只在外层加存在性探测**：
  `node -e "const f=require('node:fs'),c=require('node:child_process'),p='dist/postinstall.js';if(f.existsSync(p))try{c.execFileSync(process.execPath,[p],{stdio:'inherit'})}catch{}" || exit 0`。
  ⚠️ 我们试过另一种写法（`node -e "existsSync(…)&&import('./dist/postinstall.js')"`），
  **它能消噪声，但静默关掉了功能**：`node -e` 下 `process.argv[1]` 是 `undefined`，
  `dist/postinstall.js` 的入口守卫 `isEntry()` 恒假 —— 文件被载入了，`mainEntry` 却一个
  字节都不执行（实测：`~/.agents/skills/qiyu` 不产生；CodeRabbit 与 Codex 两路审查各自
  独立发现）。所以载入必须**经文件路径**走 `execFileSync(process.execPath, [p])`，让
  `isEntry()` 成立、真正的安装逻辑照常执行。
  四组实测：`dist/` 在 → 正常安装（SKILL.md 落盘）；`dist/` 缺 → 静默退出 0、无噪声；
  文件在但抛错 → 内层 `try/catch` + 外层 `|| exit 0` 双兜底仍 0（不阻断安装）；
  `~` 下无任何 Agent 目录 → 只提示不建链（原「绝不越权写 home」语义不变）。
  缺 `dist/` 的根因是 `postinstall` 在 `prepare`（= build）**之前**执行，本仓库自身即包；
  这条 `postinstall` 只在全局安装真实触发（`npm_config_global` 判据在文件内部）。

### 测试

- **新增 `tests/helpers/capture.ts`：按用例隔离 stdout/stderr 捕获**（CodeRabbit 2026-11-13 major）。
  27 个测试文件用模块级 `let out` + `beforeEach` 重置的模式挡得住「上一条的输出漏进下一条」
  的**状态**，挡不住**写入方**：上一条超时后，它已发出、尚未 resolve 的异步调用会在下一条
  开始之后才写 stdout（实测 `out="FRESHTAIL"`、`writes=2`）。归属按 `AsyncLocalStorage`
  记录的**发起者**判，而不是按「此刻挂着的 spy」判 —— 延迟回调往往在运行时才查
  `process.stdout.write`，那时挂着的是下一条用例的 spy。守卫含一条「尾巴在中间隔着的
  用例期间落地」的用例与一条「用户 `restoreAllMocks` 之后仍能捕获」的用例，每条都自包含
  （可 `-t` 单独选跑）；变异（改用「当前活动捕获」/ 安装桩退回布尔量）均实测变红。
  另修两处实测问题：用户的 `afterEach(restoreAllMocks)` 之后助手会重装（原先一个
  `installed` 布尔量会让它跳过安装、写入绕过缓冲）；文件结束时由顶层 `afterAll` 恢复 spy
  （vitest 2.1.9 默认不跨用例恢复，不恢复会把下一个测试文件的写入记进最后一个缓冲）。
  ⚠️ 实测：`afterAll` 里的断言在 vitest 2.1.9 只打印错误、**退出码仍为 0（用例算通过）**，
  所以这类断言不能当守卫用 —— 改为在最后一条用例里测判据本身。
  替身同时按 Node stream 契约把 `write(chunk, cb)` / `write(chunk, enc, cb)` 的回调调掉
  （CodeRabbit 2026-11-13 major）：不调的话等待写入完成的用例只能超时。变异验证：
  去掉回调 → 用例超时变红。
  实测记录：vitest 2.1.9 默认 `restoreMocks:false`，跨用例不会自动恢复 spy。

- **27 个测试文件迁移到 `captureSinks()`，模块级 `let out` 不再自己装 spy**。
  每个文件只改三行：`it` 从 `vitest` 改为从 `./helpers/capture.js` 导入（包装版给每条用例
  打上**世代号**）、`describe/it/expect` 其余照旧、`beforeEach` 里的两行
  `vi.spyOn(process.stdout/stderr, 'write')` 换成一行 `captureSinks(…)`。归属仍按
  `AsyncLocalStorage` 记录的发起者判：上一条用例的延迟尾巴写的是**它自己**的缓冲，
  不会污染下一条。两个入口（`captureSinks()` 世代形态 / `startCapture()` 句柄形态）共用
  同一份 spy 安装，避免两套实现各自漂移。
  ⚠️ 迁移中实测到的坑：**不能**用「`process.stdout.write === activeSpy` 就跳过重装」做幂等 —
  `vi.restoreAllMocks()` 还原到的是**上一层 spy**（正是本助手自己装的那个），身份判据成立
  但写入落在旧闭包的 `sinks` 里，`out` 恒空（`cli.test.ts` 当场 11 条失败）。现在每次
  `captureSinks()` 无条件重装。
  变异验证三处：「世代判据恒真」→ 尾巴用例红（`expected 'BTAIL' to be 'B'`）；
  「不调 write 完成回调」→ 回调用例超时红；「加回身份判据」→ `cli.test.ts` 11 条红。
  ⚠️ 包装版 `it` 必须把 vitest 的别名形态全部挂上（`each` / `skip` / `skipIf` / `runIf` /
  `only` / `todo` / `concurrent` / `fails`）：它们是登记函数的**属性**，裸箭头函数上没有。
  首轮迁移漏了这一层，全量报两个「失败文件」，真实情况是 `config-insecure.test.ts`（`it.each`）
  与 `auth.test.ts`（`it.skipIf`）在**收集阶段**就 `TypeError`、一条用例都没跑 ——
  「失败文件数」在小全量里读不出严重性。别名实现只有一个实现点，两种形态共用：
  直接登记（`it.skip(名, 体)`）与柯里化修饰（`it.each(表格)(名, 体)`）。
  守卫用 `it.each` / `it.runIf(false)` / `it.skipIf(true)` / `it.todo` / `it.fails` 各跑一次
  （条件必须真的决定成败，否则「条件被当成用例名丢掉」这条错法测不出来）；
  变异：丢表格行转发 → `it.each` 两行红；别名不展开 → each 与两条条件用例红；
  去掉 `skipIf` 别名 → 整个文件 `TypeError` 红。
  ⚠️ 别名的**两类别名形态**必须分开处理（CodeRabbit 2026-11-14 major，探针实测确认）：
  `skip` / `only` / `fails` / `concurrent` / `todo` 是**直接登记** —— 调用即把用例登记掉、
  返回值 `undefined`，「拿返回值再包执行体」永远包不到，执行体跑在无世代上下文里；
  `each` / `skipIf` / `runIf` 才是柯里化修饰。按键名分两组，不按首参类型猜（实测是等价变异）。
  另修 options-first 重载 `it(名, 选项, 体)`（同轮 major）：只认第二实参时选项对象被当成执行体。
  守卫让这两条的**尾巴真的落地**（`it.fails` / `it.concurrent` / options-first 各留 60ms
  尾巴，下一条断言没收到）；变异：直接别名裸登记 → 两条尾巴用例红；去掉 options-first
  分支 → 对应用例红。

- **捕获助手第二轮审查的两条收口**（CodeRabbit 2026-11-14）：① `it(名, undefined, 体)`
  也是 options-first 重载，选项位置为 `undefined` 时不能被当成「第二实参不是对象」拒绝；
  ② 陈旧世代的写入在**句柄形态**下曾照样追加进最新句柄的 `fallback`，污染 `cap.out` /
  `cap.writes` —— 现在 `cap.run()` 的显式归属优先，没有归属时才过世代判据。
  两条都有尾巴落地的守卫，变异（不认 `undefined` / fallback 不过判据）各自变红。

- **`tests/setup-warm.ts` 的预热失败只降级、不拖垮测试**（Codex 2026-11-14 P2）。
  `@duckdb/node-api` 是 `optionalDependencies`，缺原生 binding 时 `setupFiles` 里的顶层
  await 会抛 —— 那会让**所有**测试文件连收集都进不去，包括不碰数据库的、以及「缺依赖时
  给安装指引」的那几条。现在预热失败只往 stderr 打一行降级说明，测试回到「谁先用谁付
  冷启动」（慢一点，不是错）。
  守卫**真跑一个子 vitest**（`NODE_OPTIONS=--import` 注入一个让预热抛错的全局量），
  断言不碰数据库的用例仍然通过；变异（catch 里重抛）→ 子 vitest 失败、守卫红。
  ⚠️ 子用例文件必须落在仓库 `tests/` 下：放在 /tmp 会因 `include` 过滤报
  「No test files found」，退出码同为 1，看着像守卫通过。
  子 vitest 用 `spawnSync` 的 `timeout` + `SIGKILL` 兜时间（同步等待打不断用例超时，
  CodeRabbit 2026-11-14 major），失败诊断里带 `r.error`。
  预热体抽成可导出的 `warmDuckDb()`，**临时目录创建也在降级范围里**（同轮 major：
  `mkdtempSync` 失败原来绕过 catch）。这条单测直接调预热体 —— 走子 vitest 分不清是预热
  还是 vitest 自身起不来（`TMPDIR` 指向文件时 vitest 在收集阶段就死）。变异：把
  `mkdtempSync` 移出 try → 该用例红。
  预热**有界**（Sourcery 2026-11-14）：setupFiles 在收集之前执行，原生绑定卡住时用例自身的
  超时都还没生效 —— 整个 worker 挂死。现在 `Promise.race` 一个 `QIYU_WARM_TIMEOUT_MS`
  （默认 120s）预算，超时按降级处理。⚠️ 这个定时器**不能** `unref()`：卡住的那一步若没有
  别的 handle，事件循环里只剩它，unref 后直接「无活可做」退出，race 既不 resolve 也不
  reject（实测：注入永不 resolve 的 await 后用例直接 60s 超时）。
  预热体不再自己写 stderr，失败作为返回值交给 setup 入口（本文件被 setupFiles 加载时
  `warmDuckDb` 的导入会先跑一遍预热，自己写 stderr 会让每次跑测试都多一行告警）。
  `init()` 失败也会关库（不把文件句柄带进后续测试文件）；清理目录同样 best-effort。
  ⚠️ Windows 上 Node 的 `os.tmpdir()` 读 `TEMP`/`TMP` 而不是 `TMPDIR`，守卫三个一起设。

- **包装版 `it` 补上 vitest 的 `sequential` 与 `for`**（CodeRabbit 2026-11-14 major）。
  不装的话调用点在**收集阶段** `TypeError`、整文件 0 条；而 `for` 与 `each` 同类（柯里化，
  返回登记函数）—— 当成直接登记会丢表格行，执行体拿到上一层的函数、报
  `function is not iterable`（实测）。
  ⚠️ `it.extend` **刻意不装**：vitest 会解析执行体的源码文本校验 fixture 写法，而包装恰好
  把执行体换成 `(...a) => f(...a)`，报 `The first argument inside a fixture must use object
  destructuring pattern … Instead, received "..a"`。在包装下它用不了，不装反而给出更清楚的
  `it.extend is not a function`。

- **测试进程内只付一次 DuckDB 冷启动费（`tests/setup-warm.ts` + `setupFiles`）。**
  实测：进程内**首次** `DuckDBInstance.create` 在空载时 438ms、本机高负载时 19–34s
  （原生扩展加载 + 首次 mmap），之后同路径重开约 22ms。原先每个真库测试文件的首条用例
  都要承担这段，`hookTimeout`/`testTimeout` 在这台机器上会直接超时。
  现在 `setupFiles` 在**每个 worker 进程**开跑前建一个临时库、`init()`、关掉，用
  `process` 级布尔量保证只做一次（`setupFiles` 在被测模块之前执行，且 worker 进程内跨
  测试文件共享）。`globalSetup` 不行 —— 实测是**另一个进程**（探测 pid 45930 vs 51568），
  预热的 native module 到不了 worker。子进程预热与模板库拷贝两条路也实测无效，理由见
  `HANDOFF.md` §审计③。
  收益：`tests/commands/db.test.ts` 从「首条用例常超时」变为稳定通过（A/B 各 2 轮：
  改前 2/2 有首条超时失败，改后 2/2 全绿）；全量 2576 条在 load 511 下全绿。

- **`tests/commands/db.test.ts` 全文件共用一个库路径，逐条 `resetDb()` 复置。**
  同一文件里原先每条用例各建一个新路径的库（新路径 = 110ms 创建 + 75ms `init`，且绕不过
  首次冷启动），现改为 `beforeAll` 建一次目录、每条用例开头 `DROP TABLE` 全部业务表再
  `init()`。**只在真的用库的 18 条用例里调 `resetDb()`，不是 `beforeEach` 全量** ——
  实测放 `beforeEach` 反而更慢（10.3s → 13.5s）。`hookTimeout` 提到 60s（首次 `beforeAll`
  仍可能撞上冷启动）；两条互不相干的用例原先共用 `alien.db` 会串，改为各自独立路径。

- **钉住「上一条用例的 ticking 时钟不得泄漏」的清理契约**（CodeRabbit 2026-11-12 第三轮 major）：
  新增回归用例会让 `Date.now` 每读一次 +1ms，若清理失效，后续用例会拿到停在 2026-11-11 的
  假时钟、失败变成顺序相关。核实本文件 `afterEach` 的 `vi.restoreAllMocks()` 已覆盖该恢复
  （CodeRabbit 的结论是**假阳性**），但把这个不变量钉成守卫：`Date.now()` 必须明显远离上一条
  用例的 tick 原点。变异验证：删掉那句恢复 → 守卫红且实测时钟停在 `tickOrigin+9`；恢复 → 绿。


## [0.2.2] - 2026-11-12

> tag `v0.2.2` 指向 main `2354cdf`（GitHub / GitLab 双远端），已 publish 到 npm；
> 沙箱安装实测：`qiyu --version` = 0.2.2、`skill check` 退出 0。


### 文档

- **文档一致性回写（PR5）：陈旧声明改实况 + 承诺收窄，四个文档 + 一处 skill 正文，配 13 条双向自检守卫**。
  把「文档说了但代码不是这么干的」逐条对齐到实现，区分「没说清/说错」与「真没做」：

  **陈旧回写（已实现的能力不再被说成未实现）**：
  · 设计稿 §11.2 E「不要使用 `--pretty`（未实现）」—— `--pretty` 已实现（G1/2026-10-24），
    禁的是「写进命令示例」不是「会失败」；§2 两条语义化命令（工单域 / 知识库只读）补
    「未交付挂账」状态注 —— 并点明缺的是**语义层而非数据**（远程 `api call`、本地
    `query --table` / `query --sql`，四张表都在 `TABLES` 里且有同步任务）；
  · 设计稿 §4.2 `auth whoami` 原文「校验凭证」—— 它只检查凭证**存在性**、从不联网，
    故改口为「显示来源」并在状态注明写「不校验有效性」（这是 `auth` 零加载 store + 不碰
    网络的分层约束的结果，不是缺陷）；
  · 存储层 spec `auth login` 三条「尚未实现」就地状态注（2026-10-25 已实现）与
    `--pretty` 验收口径作废（`store init --pretty` 现在是 0 而非 2）；E/skill 两个 spec 的
    `--pretty` 拒绝建模与「待评审」状态行各加作废注；
  · skill 正文 `forbidden.md` §2 的 `--pretty` 口径从「未实现」改为「对 Agent 没有增益」；
    `src/skill/check.ts` 注释里「`--pretty` 同时在 rejected 清单里」的**历史残留**改实况
    （rejected 当前为空、次序规则保留）；
  · skill spec 的违规判据删掉「推荐了 `--pretty`」一档 —— 实现里从来没有这条检查
    （`ViolationRule` 只有 `table_name` / `sql_sequence` / `unknown_kind`，flag 侧只有
    `rejected_flag`，而它当前为空），写明了「这是写作口径、不是可校验判据」。

  **承诺收窄（把「必须/应」改到与实现一致，避免被读成已交付契约）**：
  · §4.3 `14500` 熔断：落地的是**等效防死循环**（`Service Offline` 一次判死、不重试），
    「连续 N 次 + 写熔断状态」的计数器与持久化**未实现** —— 下个进程仍会再打一次网络；
  · §4.3 `14501`：core **不切片**（只翻成 `kind: window_too_large`），分片在同步引擎、
    `api call` 不切片（注册表不登记窗口字段）；
  · §6.4：重试是**固定 200ms 间隔**不是指数退避（指数会越过 `maxMs` 有界承诺）；
    陈旧锁超时**未实现**（`locked_by/locked_at` 已落库、但无接管逻辑，与 sync 前台进程
    形态自洽）；§6.5 `CHECKPOINT` 不自动执行，是**运维责任**；
  · §7.4 限频持久化只对 `sync` 成立（`api call` 一次性进程、令牌桶在进程内不落库，
    即 `auth`/`api` 零加载 store 的红线所致）；§7.4.1 `maxWindowDays` 预校验只 `sync` 做、
    `api call` 只输出不拦（注册表无 params）；
  · §9.1 `meta.cached` 从输出样本**删除**（无生产者、无查询缓存——缓存从未进入任何
    子项目范围）；§11.2 `store_locked` 行删除「D 交付后缓存查询生效」旧承诺。

  测试 `tests/docs.test.ts` 新增 **13 条**「PR5 回写」守卫，全部**双向自检**（事故原文必红 +
  回写措辞必在场），并修一处自检陷阱：`--pretty` 的反向断言只锚「E 禁止事项」那一行，
  不能对全文 `not.toMatch` —— 回写的状态注本身就逐字引用了旧措辞，对全文判会把
  「解释旧错」误判成「仍在犯旧错」。**变异验证 18 处，全部转红**（E 行退回未实现 / 14501 恢复
  自动分片 / whoami 退回校验 / 存储 spec 状态注删除 / forbidden.md 退回未实现 / §2 挂账块删除 /
  §2 数据通道退回「只能经逃生通道」/ 两种 14501 合并成一种 / 把 api 加回读者清单 /
  违规判据加回「推荐 --pretty」/ CHECKPOINT 退回「文件只增不减」/
  加回「不切就拿到 window_too_large」/ 加回「不会无界膨胀」/
  状态注翻成「已交付」/ 手动指引改成承诺完全回收 / 删掉 endTime 的上界条件 /
  重写到新文件 / 表行缺上界 / 删掉纯历史窗口的对齐澄清），逐条 grep 确认改动真落地。
  **另 1 处稳健性检查**（往范围清单插一行）**应当保持绿、实测保持绿** ——
  它验的是「锚定不依赖清单行数」，与变异方向相反，因此不计入上面的 18。
  CodeRabbit 复审（round 1，2 条 minor）两条都核实成立并已修：① skill spec 违规判据里的
  「推荐 `--pretty`」实现中不存在此检查 → 删除该档并写明是写作口径；② §2 状态注
  「只能经逃生通道访问」会让人以为数据拿不到 → 点明缺的是语义层而非数据（本地四表可查）。
  round 2（再 2 条 minor）同样核实成立并已修：③ §4.3 把两种 `14501` 都写成
  `window_too_large` + 「按 maxWindowDays 切片」—— 但 `endTime is invalid`（越界）是
  `window_misaligned`（对齐自然日边界），切片救不了越界，混为一谈会让 Agent 反复重试
  同一个失败请求；④ §6.4 读者重试清单里列了 `api` —— 而 `api call` 零加载 `store/`、
  根本不打开本地库，不会撞 `store_locked`（改为 query/db/sync status/sync verify/stats，
  并加「api.ts 一旦 import store/ 这条守卫就失效、必须复核」的反向自检）。
  round 3（再 2 条 minor）同样核实成立并已修：⑤ `CHECKPOINT` 运维须知把两件事说过头了 ——
  「文件只增不减、只能手动回收」是错的（DuckDB 内置 `wal_autocheckpoint` 会按 WAL 大小
  自动 checkpoint，仓库不改默认），手动 `CHECKPOINT` 也只**部分**回收已删除行空间；
  改为「CLI 不执行 + 可手动 + 部分回收 + 未实测边界」；⑥ §4.3 **表格行本身**也要区分
  两种 `14501`（不能只在下方状态注里说，只读表格的读者会照旧按「切片」处理越界）。
  round 4（再 2 条 minor）同样核实成立并已修：⑦ §7.4.1 不得承诺「不切就拿到
  `window_too_large`」—— 超限报错码按接口族不同（statistic/* → 14501、summary → 14004、
  transferHuman → 14500），只有**已识别的那几种报文**才归成该 kind；⑧ §6.5 不得写
  「不会无界膨胀」—— 自动 checkpoint 限制的是 WAL 累积而非 DB 文件大小，已删除行空间
  只部分回收，主库文件仍可能增长。
  round 5（1 条 major，发生在**测试代码**上）已修：§2 守卫写成
  `/工单领域的语义化命令[\s\S]{0,400}未交付/` —— 它的匹配起点是**范围清单那一行**、
  不是状态注，且实测正好卡在 400 字边界（间距 400），清单多一行就变红、状态注写成别的
  意思也能过。改为**先把状态注那一块切出来、再在块内断言**（两条命令各自点名 +
  「上面两条……未交付」的论断 + 「不是交付清单」），并验证「往清单里插一行」不再影响它。
  （CodeRabbit 说「该断言在本次改动后的文档上必然失败、测试跑不过」—— **这一句不成立**：
  实测它当时是通过的，卡在边界上而非超出。但**脆弱性是真的**，所以照改。）
  round 6（再 2 条 minor）同样核实成立并已修：⑨「手动 CHECKPOINT 只部分回收」的断言写的是
  全文 `/部分|一部分/` —— 上面「自动 checkpoint 不等于文件有界」那段也有这句话，即使**手动
  指引那一句**改成承诺完全回收也照样绿（实测变异验证确认了这个假绿）→ 改为锚到手动指引
  那一句本身；⑩ `window_misaligned` 的处置是**双条件**（对齐 **且** 不得晚于今天 00:00），
  只写「对齐」会让 Agent 把「明天 00:00」这种**已对齐但越界**的值原样重发 → 补上界与
  「挪回允许区间」，并与 `errors.ts` 的 hint 逐字对拍。
  round 7（1 条 minor）同样核实成立并已修：⑪ §4.3 回写注的不安全示例同上，改为「纯历史日期」
  + CLI 自身做法。
  round 8（3 条 minor）同样核实成立并已修：⑫ §4.3 回写注的上界断言对全文 `toMatch` —— 该措辞在
  §6.2/§7.2 的表格里多处出现，即使把 §4.3 回写注里的上界删掉也照样绿，改为切块断言；
  ⑬ CHECKPOINT 说成「把数据重写到新文件」是错的（DuckDB 定义是把 WAL 同步回主数据文件，
  紧凑新文件要用 `COPY FROM DATABASE`）；⑭ 14501 表行 `window_misaligned` 的指引也要带上界条件
  （只写「对齐」会让 Agent 把明天 00:00 这种已对齐但越界的值原样重发）。
  round 9（再 2 条 minor）同样核实成立并已修：⑮ §4.3 回写注里的「对齐」不应被读成
  「每个 endTime 都必须写成 0:00」—— 纯历史日期取任意时刻都接受（§6.2 实测
  `5 天前 0:00 → 5 天前 12:00` 返回 200），唯一被拒的是「晚于今天 0:00」；⑯ §6.2 的
  「今天的数据拿不到」没说清时间 —— 补 D+2 日的具体举例（clamp 到昨天 0:00 ⇒
  11-02 跑才覆盖 10-31），并指向 `resolved_range`/水位判断覆盖范围。
  round 10（再 2 条 minor）同样核实成立并已修 —— 这一轮承认前 9 轮把同一件事**改反了方向**：
  ⑰ 「不得晚于今天 00:00」放行了**等号**，而 `endTime = 今天 0:00` 恰是 §6.2 实测
  **本身不稳定**的那条边界（同一取值有时 200 有时 14501）—— 于是「写对了边界」的指引
  反过来教 Agent 去踩它。改为**严格早于**：「`endTime` 必须早于今天 00:00（用纯历史日期，
  不要包含今天的数据）」，`src/core/errors.ts` 的 hint、§4.3 表行与回写注、§6.2 的
  `staffAttendance` 行同步改口（这是 PR5 唯一一处**改动 Agent 可见输出**的地方 ——
  hint 是主用户读的动作指令，文档说一套、hint 说另一套本身就是契约不诚实，故一并改）；
  连带把 §6.2「整日对齐检查」的命名改回**上界检查**（`5 天前 12:00` 非整日对齐却 200，
  证明被查的是上界不是对齐），`src/core/time.ts` / `sync/engine.ts` / `sync/tasks/reports.ts`
  的注释一并更正。⑱ §2 状态注的四个本地表名原先对**全文** `toContain` —— 四张表在 §6 等
  别处也逐字出现，把它们从状态注里整段删掉后全文判照样绿（实测：`tickets` 全文仍有 2 处、
  `knowledge_items` 8 处），假护栏。改为与同组第一条用例一样**先切出状态注块再判**。
  测试同步加硬：`tests/core/errors.test.ts` 的 `window_misaligned` 用例**直接断言 hint**
  （必须含「早于今天 00:00」、不得含「不晚于今天 00:00」），文档侧另加「转述行与实现
  hint 逐字一致」的对拍 —— hint 从此有行为测试兜底，不再只靠文档一致性守卫间接覆盖。
  当前共 **13 条**守卫、**22 处**变异验证（另有 1 处稳健性检查，方向相反）。

### 修复

- **真实凭证端到端实测发现的会话导出两处硬故障 + 契约诚实性收敛（2026-11-07/08 多代理审计，每条发现先复现再改）**：

  **真实采样复现（此前从未端到端跑通过 `sync run sessions.export`）**：
  · **恰好 144.0 小时的窗口被服务端拒绝**：引擎 Range 是半开 `[start, end)`，
    `sessions.export` 却把 `w.end` 原样发给导出接口，跨度恰为 `6 × 86400000 = 518400000ms`
    —— 实测 `14004 Timestamp interval limit`，而 `518399999ms`（143.9999h）通过。
    修复前两窗全部 `fetch_failed`、水位冻结、一行不落；修复后 `fetchSessions` 按
    「半开 → 闭区间」映射发 `end − 1`，fixture 核对与 gap 文案统一改用实际请求窗口。
    **端到端复跑**：两窗全成功、32,497 行落库、零 gap、水位推进到请求末端。
    注册表 `export.session` 的 note、`max_window_days` 图例与类型注释同步写明
    「边界是开的，必须严格小于」；`14004 Timestamp interval limit` 从兜底 `param`
    （「核对字段名与类型」的假归因）改判 `window_too_large` 并给可执行的「严格小于」hint。
  · **导出 zip 的条目名带不可预测的导出 id 前缀**：真实 zip 是
    `5411798/session.txt`，中央目录精确匹配 `session.txt` 永远落空 —— 第二个窗口
    全部报「没有 session.txt 条目」。改为**按基名**匹配，基名重复时显式拒绝
    （形态漂移，不猜用哪一条）；真实 zip 上实测解压 112,829,042 字节、7679 行，
    尾部标记与请求窗口吻合。
  · **`max_window_days` 只说「`<=` 即安全」、报表族与导出族边界开闭相反**：图例改为
    「按毫秒精确比较，但边界开闭随接口而变」并点名 export.session；`api call` 的用户
    不会再切回「恰好 6 天」这个必失败的边界。

  **其余审计发现（每条都有复现出处与回归守卫）**：
  · **无子命令的四个命令族把帮助当成功输出**：`store / db / stats / sync` 无子命令时
    裸文本进 stdout、退 0，与顶层及 `api / auth` 的 `usageFail`（退 2 + JSON）相反；
    统一为用法错误，并给「可用子命令」hint。
  · **`--pretty` 写反位置在五个命令族说法矛盾**：`db --pretty tables` 说「未知参数：
    tables」（tables 明明是已知子命令），别的命令说「必须写在子命令之后」；收敛到
    `prettyAfterSubcommand` 单一渲染点，位置参数一律按「顺序写反」引导。
  · **`api call` 的 `data` 图例谎称「原样透传、不改写」并指向不存在的响应字段表**：
    信封 M 会 trim、形状 C 的畸形 JSON 键先修复再解析；`api schema` 只有请求参数与
    信封种类，没有响应字段表。`non_json_body` 告警也不再说「按原样字面量发送」——
    `--body` 一律 JSON.parse → JSON.stringify、Content-Type 恒 application/json，
    且按 `bodyKind === 'none'` 分形（该接口不接收 body，服务端多半忽略）。
  · **`sync tasks` 的水位图例把请求端点说成库表列**：`op_end` 等字段不在
    `tickets / ticket_logs` 表里，图例改为「请求参数里的时间端点」并保留
    「同名字段形状随命令不同」的提醒。
  · **`statSync` 失败一律说「检查权限」**：实测还有 `ELOOP` / `ENOTDIR` /
    `ENAMETOOLONG` 三种成因；`statFailureHint(errno)` 按 errno 分形，未归类如实说
    「未专门归类」，不猜。
  · **他人库的 `schema_version` 表骗过前置检查**：探针实测
    `schema_version(version_id, applied_at)` 放行后落 internal「备份重建」——
    把「不是本 CLI 的库」说成损坏缓存。`db / store / sync` 三处共用
    `SCHEMA_VERSION_COLUMNS_SQL` 查列名，缺 `version` 列即显式「换 --db 路径」。
  · **`--db` 相对路径按 HOME 解析却无人告知**：顶层与五个命令族 `--help` 统一经
    `DB_PATH_HELP` 单一出处写出「不是当前目录」；与调度条目固化路径的设计取舍同源。
  · **`fail()` 漏净化 `code`**：服务端回 `code:"\u009b31mX"`（CSI）时控制字节原样进
    stdout；补上与 message/hint/target 同一条最终防线。
  · **`retryStrategy` / `fallback` 的注释仍说「本计划不填 / query 不存在」**：G1 已
    实现「有本地表映射且库文件存在时填」，注释改实况并写明不承诺表非空/覆盖窗口。
  · **查询掩码词法器的三个缺口**：双引号标识符内容、美元引号字符串（`$$…$$` /
    `$tag$…$tag$`）、以及 `--` 注释在 `\r` 处终止 —— 补词法分支并加 3 条可区分的
    变异用例（其中美元引号用例两度重写到「移除分支必红」才定稿）。
  · **`SUMMARIZE <表>` 绕过 PII 掩码（严重）**：输出列是通用的 `column_name / min / max`，
    真正的列名在**行值**里，三条列名级启发式全部落空 —— 实测 `userName` 的
    `min:"张三丰"`、`max:"李四光"` 明文输出且零警告。行级补「形状 + 基名命中」判据，
    命中行的统计列按该列规则脱敏并计入结构性命中（不再被误报成「业务数字被误改」）。
    **Codex 复审（2026-11-08）又抓出该补丁自身的四条回归，逐条探针复现后修复**：
    ① 值级兜底已整段替换的 JSON 被列规则重新降级 —— 紧凑 JSON 整串命中邮箱正则，
    `@` 之后（含 `secret` 字段）明文回归（P1）；② 形状判据只看输出列名，
    `SELECT column_name, MIN(ordinal_position) … FROM information_schema.columns`
    的数字 `min` 被误改成 `<已脱敏>`（P2）；③ 列级 `structuralMasked` 让混合结果里
    非敏感行（`session_id` 的 min 恰为手机号形态）的误伤告警静默消失（P2）；
    ④ 美元引号识别没查标识符边界，`marker$q$` 这类合法别名被当成引号对，
    把中间的 `GROUP BY` 抹掉 → 分组失真警告丢失（P2）。修复后补 7 条回归用例
    （含「对照组必须有警告」的反向判据），**四条变异逐一转红**。第二轮复审追加：
    ⑤ 关键词判据作用在原始 SQL 上，字符串/注释里的 `'SUMMARIZE'` 同名词会误触发
    形状（合法元数据查询被改值）→ 改判**剥除字面量与注释后**的词法文本，
    `query('SUMMARIZE …')` 嵌套形态单独判（P2）；⑥ `14004 Timestamp interval limit`
    的 hint 把成因说死成「跨度超限」，而设计稿 §7.5 明载 `start>end` / `start==end` /
    超限三成因共码不可区分 → hint 改为「最常见成因」并给出第二成因的核对动作
    （CodeRabbit minor）。第三轮复审追加：⑦ 关键词/嵌套调用判据仍扫原始 SQL ——
    注释里的 `query('SUMMARIZE sessions')`、双引号别名 `"SUMMARIZE"` 都会误触发；
    关键词改判 `bareKeywords`（单/双引号、美元引号、注释全剥）的裸 token，嵌套调用
    改为「裸 token 定位 query( → 回原文读字符串实参」（P2）；⑧ 美元引号边界判据是
    ASCII-only 字符类，DuckDB 实测接受 `1 AS 列$q$` 这类非 ASCII 标识符，两个 `$q$`
    又被当成引号对 → 字符类扩到 `\p{L}\p{N}\p{M}`（P2）。第四轮复审追加：
    ⑨ `query(/* gap */ '…')` 与 `query(E'…')`（DuckDB 实测均合法）漏检 →
    跳过注释、识别字符串前缀（P1，漏检意味着 PII 统计值原样输出）；⑩ 七个命令族的
    `--pretty` 分派分支只查未知 flag，位置参数里的拼错子命令名被 `--help` 静默吞成
    退出码 0（`api --pretty typo --help`）→ 新增共享判据 `prettyPositionalProblem`
    （拼错词在 help 前拒绝，合法子命令名仍走顺序写反引导），七族接入
    （CodeRabbit/Codex 同指）。第五轮 minor 再收敛判据边界：第一个裸位置 token 之后
    的 token 属子命令自己的参数域（`db --pretty describe sessions --help` 的
    `sessions`），flag **取值**（`--db /tmp/x` 的 `/tmp/x`）也不是位置参数 ——
    判据只查第一个裸位置 token，并按 FlagSpec 跳过值位（否则 `sync --pretty
    --db /tmp/x status --help` 会把取值误判成拼错词，退化成退出码 2）。
    第六轮复审追加（Codex 3 条 P2）：⑪ `SUMMARIZE` 是**语句头关键字**而非任意裸词 ——
    `SELECT 0 AS SUMMARIZE, …` 是 DuckDB 实测合法别名，按裸词判会误改元数据数字；
    判据要求前面是文首/`(`/`;`（P2）；⑫ `query('…')` 实参要先解码、再对**内层 SQL**
    跑同一词法判据 —— 内层注释里的 `SUMMARIZE` 此前会误触发（P2）；⑬ 美元引号标识符
    边界要按**完整码点**判 —— 补充平面字母 `𝒜`（U+1D49C，代理对被 `text[i-1]` 截断）
    与货币符号 `¢`（U+00A2）都是 DuckDB 实测合法标识符字符（P2）。
    五轮共 17 条回归用例、13 处变异转红。
    **2026-11-09 第 6–12 轮双路复核（SUMMARIZE 词法判据的七轮结构性收窄）**：
    CodeRabbit/Codex 十二轮复审发现 28 条新缺陷，每次均探针复现后再修复：
    ⑭ 重投影缺口静默（minor）：输出列名被 `AS` 改写（`column_name AS c`）时行级判据不触发
    且其余警告也不发 — 补「可能未脱敏」缺口（CodeRabbit 六轮）；⑮ 完整标识符边界 + 完整码点
    + 嵌套块注释 + 双引号别名文本不得参与聚合 + U+2028 标识符字符（P2：Codex 六轮）；
    ⑯ 深层子查询 `FROM (SELECT * FROM (SUMMARIZE …))` 的合法 SUMMARIZE 输出同样明文漏出
    → 补 `unrecognizedParen` 缺口（major：CodeRabbit 七轮）；⑰ `query()` 输出路径与 E-string
    解码 —— `WHERE EXISTS` 里的 SUMMARIZE 只参与过滤、输出是常量 3，按全 SQL 判据脱敏会把
    常量篡改 → `atTopOutput` 位置信号，非输出路径只发缺口（P2：Codex 七轮）；⑱ 自连接重名列
    后缀配对（minor：CodeRabbit 八轮）；⑲ 统计列投影来源核验 —— `3 AS min`/`COUNT(*) AS min`/
    `'not PII' AS min`/省略 AS 的 `3 min`/前置别名 `min: 3`/UNION 追加普通行/重排自连接后缀错配
    → 行级脱敏收窄为白名单（P2×6：Codex 八~九轮）；⑳ 大小写误配：`staff.username` 匹配
    `sessions.userName` → 只在下 TableDef 大小写不敏感查列时放宽（major + P2：CR 九轮
    + Codex 九轮）；㉑ 星号多来源（`*` + CROSS JOIN）与 `query()` 来源验证（minor + P2×2：
    CR 十轮 + Codex 十至十一轮）；㉒ 显式列举路径也要求单一 `(SUMMARIZE …)` 来源
    （P2：Codex 十一轮）；㉓ 第十二轮结论性收窄：**行级脱敏只保留两类可静态证明的形态**
    —— `SUMMARIZE <表>`（语句头）与 `SELECT * FROM (SUMMARIZE <表>)`（单一来源无 JOIN/
    逗号/列别名列表）；`query(…)` 包装、显式列举、集合操作、FROM-first、`*`+多来源、
    全部降级为「声明缺口、不改写任何值」（上述 28 条缺陷每条都是同一个根因：
    「猜来源」在更复杂的 SQL 组合下总能被构造出新反例，真机 probe17 钉死边界）。
    收窄后自查补一处静默缺口：`query()` 内层被**显式重投影**
    （`query('SELECT column_name, min FROM (SUMMARIZE sessions)')`）时内层不满足纯透传，
    旧接线既不置 hit 也不置 gap → 外层一条 SUMMARIZE 警告都不发；现统一由
    `queryCall.gap` 兜住，缺口文案改为「无法确认是否构成最终输出」以覆盖「位置已知但投影不可证明」。
    73 条 mask 用例全绿；引用 mask 的 3 个测试文件共 145 用例全绿。
  · **SUMMARIZE 缺口 + schema_version 列名大小写（2026-11-09 第十三轮双路复核）**：
    ㉔ 位置无法确认的嵌套 SUMMARIZE 若列名被改写
    （`SELECT * FROM (SELECT column_name AS c, min AS m, max AS x FROM (SUMMARIZE sessions))`、
    CTE 写法）既不满足位置档的 `shapeColumns`、也不满足改写档的 `summarizeSql` →
    `warnings=[]` 明文漏出（major：CR）；现按「位置无法确认 **且** 输出不是可证明透传」补缺；
    ㉕ `schema_version` 列名按**大小写精确**比较，把 `"VERSION"`/`"Version"` 这类 DuckDB
    照样能解析的库判成「不是本 CLI 创建的」、挡住全部读命令（P2：Codex；真机实测带空格的
    `" version"`/`"version "` 确实解析失败，只有大小写变体不可区分）→ 改为大小写不敏感。
    **第十四轮（CodeRabbit minor×2）**：㉖ `query($$SUMMARIZE sessions$$)` / `query($q$…$q$)`
    美元引号实参被实参扫描跳过（只认单引号）→ hit/gap 双假、一条 SUMMARIZE 缺口都不发；
    实参扫描与 `withoutLiterals` 收敛到同一个 `dollarQuoteEnd` 扫描点（判据只许一个实现点）；
    ㉗ 自连接重排用例的行键写成 `column_name_1` 而列名是 `column_name:1`，`name in out` 为假 →
    `:1` 列从未进入脱敏，用例没覆盖它声称的场景。
    73 条 mask 用例 + 15 条前置检查用例全绿，两处修复均做撤销即红的变异验证。
  · **`api call --help` 对 `--no-validate` 的描述大于实现**：CLI 级安装提示（skill
    未安装等）不受该开关影响、照旧出现在 warnings；帮助文字改为精确表述。
  · **分页响应首页有 total、后续页缺 total 时静默短读**：旧逻辑清空 declared 并
    break，短读终检永不执行；改为抛「响应形态漂移，拒绝落库」。
  · **systemd ExecStart 与 crontab 对同一参数的转义不一致**：`--profile o'brien`
    的裸单引号在 systemd 解析里会被当引号符切开命令行；`systemdArg` 改为单引号
    也触发双引号包裹（多载体转义契约的第 4 个载体）。
  · **`store status/internal` 的恢复 hint 自指**：失败命令本身就是 `store status` 时
    让 Agent 重跑刚失败的命令；改为「换 --db 验证 + 备份后经渲染器重建」，恢复命令
    一律经 `storeInitCommand` / `syncRunCommand` 渲染并写明占位符替换契约。

  **验证**：`npm run typecheck` 0；全量 2 分片 `--maxWorkers=1` 全绿（52 + 51 文件，
  1252 / 1207 用例）；`npm run build` 0；`npm run check:pack` 通过（238 文件）。
  行为修复逐条变异验证（请求映射、错误分类、zip 基名匹配、词法分支、errno 分形、
  列检查、图例与帮助守卫等），变异均转红、恢复均转绿；本轮新写的 internal hint
  曾触发 `BARE_HINT` 漂移守卫，已按渲染器口径修正并复测。

- **skill / 凭证 / CLI 输出的三十八处契约修正（2026-11-06 独立三路审查：skill 域 / auth 与凭证域 / cli 与输出域，24 条发现逐条先复现再改）**：

  · **`skill install` 与 `where` / `check` 对「受管文件集」的口径分叉**：install 把用户额外
    放进 skill 目录的任意文件也算成「可能被手工修改」并建议 `--force`，而 `--force` 又不
    管这些文件 —— 提示永远不收敛；`check --compare` 还会无端退 1。三处统一为**受管文件集**
    口径，改掉 3 条把错误行为钉死的旧用例，补 2 条正/反用例 + 1 条反向对照。
    比对还要求**文件集与包内完全一致**：包升级增删文件时，只比清单子集会得出「正文一致」，
    随后只重写清单、不复制新文件却报 updated —— 现在如实报「文件集与上次安装不同」并要求
    `--force`（新增用例钉住「清单不得提前声称新文件已安装」）。
  · **三条检查规则的释义与实现不符**：`table_name` 是「写了就红」（不查表是否存在）、
    `sql_sequence` 要求 SELECT 与 FROM 同时出现（`DROP TABLE` 不属这条）、
    `unknown_positional` 按命令 spec 域判定。README 两处与 SKILL.md 删掉「检查表名是否
    仍存在」的承诺，新增 3 条行为对拍用例（真实/编造表名、DROP 不触发、detail 点名域）。
  · **`skill where --dir` 时把启动探测的结论套到本命令上**：启动探测不读命令行参数，
    定位不到实体时说的是「未安装/已过期」，而本命令的实体根本不来自探测。新增
    `explicitSource` 分支，改说「启动探测未定位实体（不读命令行参数），本命令实体来自
    `--dir`，不受影响」，用例钉住旧文案不再出现。
  · **清单被占用时 `--force` 的效果被写成单一状态**：实测两种状态 —— 正文被手工改过时
    `--force` 只覆盖正文（status 报 updated），正文与包内一致时连 `--force` 也零写入
    （status 报 skipped）。hint 与 SKILL.md 改为分状态表述，用例把文案与两条实测状态绑在一起。
  · **`--profile` 不作用于凭证**：sync run / sync verify 的存储路径、机器人配置读的是
    `--profile` 档，凭证却只按环境变量 / 默认档取 —— 多档用户会拿 A 档的 key 去开 B 档的库。
    `resolveCredentialsUsingFile` 增 `profile` 槽位并由两个调用点传入，两条端到端用例
    断言请求 URL 里的 appKey 来自 `--profile` 指定的档。
  · **`auth login --profile` 写非 default 档后默认档名是否跟着改没说清**：行为（顶层默认
    档名不变）是刻意的，但文档没写 —— README 与 login 的字段说明补上「之后的命令仍须用
    `--profile` 或 `QIYU_PROFILE` 指向它」。
  · **顶层 `--help` 漏列 `auth login`**，而测试还用「未实现」把它钉死 —— 帮助清单与
    `command-tree` 用例同步补齐，测试改为按命令树集合对照。
  · **`auth login` 对已存在的 0755 目录的处理被文档说过头**：实测已有目录原样保留（不改
    权限，只对**新建**目录设 0700），文档 5 处收窄为「新建的目录 0700」，并新增用例钉住
    「不改已存在目录」。
  · **配置文件权限判据的文案窄于实现**：实现拒绝任何 group/other 权限位，文案只说
    「group/other 可写」—— 0644（可读）能通过提示却同样会泄漏 appSecret。改为「含凭证
    但权限过宽：group/other 有权限位；可读时其他用户就能读到 appSecret」，
    0602/0601 两条用例钉住判据与措辞。
  · **`resolveCredentials` 的 `fromArgs` 形参是死参数**：没有任何调用方传过非空值，
    「预留的第三来源」只会让人以为凭证可以从命令行给。删除形参，设计稿 §4.2 同步注明
    凭证只有环境变量与配置文件两层。
  · **README 的脱敏承诺大于实现**：改写为「请求/响应链路」的输出都会脱敏，并明写边界 ——
    不扫描用户自己敲进 argv 的凭证（`auth login` 拒收 `--app-key` 正是为了这个）。
  · **配置文件权限警告的用例是空转**：原用例把 stderr 攒在内存变量里却断言别的东西，
    警告删掉也不红。改为真实捕获 stderr 并断言警告在场（变异：置空 onWarn → 红）。
  · **帮助与 README 的 error kind 清单漏 `sync_not_run`**：三个帮助入口补齐，README 改成
    「常见值，不是穷举」并指向 `ERROR_KINDS` / skill `errors.md`，新增 `--help` 运行时断言。
  · **`api call` 的「不接受任何参数」与事实相反**：它接受 `--help` / `--pretty`。改为
    「只接受 `--help` / `--pretty`，不接受其他参数」，两处测试锚同步。
  · **`auth login` 写盘失败的 hint 会把人引向不存在的路径**：配置路径由 `HOME` 固定、
    CLI 没有改路径的参数，旧 hint 却让人「检查路径」。改为点名目录与文件（可写、不是
    符号链接），并明写「路径固定、不要去找别的路径」，新增 EACCES 用例。
  · **纯空白凭证被当成有效值**：`' '` 是 truthy，一路穿到签名，服务端回 14001 ——
    报错点离真正给坏值的地方隔了一层命令。新增 `isWhitespaceOnly` 单一实现，
    credentials-source / `auth whoami` / `auth login` / core 四处拒绝并**点名来源**
    （环境变量名 vs 配置键：空白环境变量会遮蔽配置文件里的真值，所以必须先拒绝再读文件）。
  · **控制台地址一处写成唯一形态**：两种写法都有（有无 `admin` 段），以后台真实页为准，
    两处都列出；尝试浏览器核对未登录、无法实证，如实标注为未验证。
  · **`--help` 与合法参数同现被判「未知参数」**（8 个命令族）：`--help` 是帮助请求，
    追加的已知参数（如 `query --help --sql`）不该报未知。改为「`--help` 不接受额外参数」
    并把额外参数逐个点名。
  · **`--help` / `--version` / `--pretty` 三个伪命令互相不豁免**：`api list --pretty --help`
    一类组合会被一侧判成未知参数，三处统一按「全局选项任意次序」处理。
  · **退出码 1 但 stdout 仍是 `{ok:true,…}` 的路径没有机器可读标志**：skill check 两条
    路径（单文件检查与 `--compare`）都补了**真实的** `meta.exit_code` 字段与图例，写明
    「不要按 `error.kind` 分支、也不要用『有没有 error』判断检查是否通过，先看退出码」。
  · **`output.test.ts` 的 kind 覆盖不全且集合断言自比较恒真**：旧表只钉 9 个 kind、
    其对照组两边都是本文件常量（除自相矛盾外恒真）。改为与 `ERROR_KINDS` 对照，
    新增 kind 必然变红，并覆盖全部 16 个 kind 的字面输出形态。
  · **`query --help` 的额外参数列表是自拼字符串**：空串会渲染成「冒号后空白」，且不
    点名取值。改为 `describeArgs` 统一渲染（全仓唯一实现）。
  · **「可用：」清单一处列 `--pretty`、两处不列**：三处统一为同一份清单来源。

  **验证**：`tests/commands/skill.test.ts`、`tests/commands/credentials-source.test.ts`、
  `tests/commands/sync.test.ts`、`tests/commands/auth.test.ts`、`tests/core/config.test.ts`、
  `tests/core/credentials.test.ts`、`tests/skill/check.test.ts`、`tests/skill/detect.test.ts`、
  `tests/cli.test.ts`、`tests/commands/api.test.ts`、`tests/commands/command-tree.test.ts`
  共新增 **30** 条 `it`、改写或删除 **7** 条。行为修复逐条做变异验证（A1 的三种透传形态、A4 对已存在目录
  chmod、A5 权限判据放宽一位、A8 置空 onWarn、A11 恢复旧 hint、A12 四处空串判据、S3 去掉
  explicitSource 分支、S4 退回单一 --force 表述），变异后对应用例全部转红、还原后转绿。
  `skill check` 的 `exit_code` 图例还触发两条静态守卫（图例键必须有真实字段、
  `field_notes` 不得含 `**`）：先补真实 `meta.exit_code` 再收敛文案。

  **收敛轮次追加修正（review 过程中发现的新形态，同样做了复现 + 变异验证）**：
  · **`check --compare` 只比清单文件集**（Codex）：与 `install` 同款缺陷的第二处 ——
    包新增文件后，实体与包在旧子集上相等 → CI 的 `--compare` 退 0 漏报「装的是旧包」。
    改成文件集必须与包内一致，并给出独立原因（「已安装的文件集与包内不同」）；
  · **`--profile` 拼错被报成缺凭证**（Codex）：凭证侧先按 flag 选档，拼错的档选不到
    凭证 → `auth_missing`（退 1），而真相是参数错误（退 2）。`sync run` / `sync verify`
    改为**先解析 store 配置**（它已有「点名的档必须存在」守卫）再取凭证 ——
    参数错误排在环境错误之前；
  · **帮助模式的取值规则与正常解析不同源**（Codex 两轮）：`db tables --db --bogus --help`
    曾打印帮助并静默吞掉 `--bogus`；改成「取值不以 `--` 开头才跳过」后又把
    `query --sql "-- 注释…"` 的合法 SQL 判成未知 flag、且 `--db --help`（缺值）不报。
    最终规则改为**每个 flag 自己的取值规则**：`FlagSpec.dashValue`（`--sql` 允许取值以
    `--` 开头，只有恰好是已知 flag 才算缺值）驱动帮助检查与 query 解析器同一份判据；
    缺值在帮助模式下照报（与正常解析同文案）；
  · **EACCES 用例在 root / Windows 上假失败**（CodeRabbit）：收掉目录写位造不出
    EACCES，改用 `it.skipIf`（仓库既有约定）；
  · **`whoami` 漏了配置文件里的空白凭证**（Codex）：只查环境变量时，文件里的 `" "`
    被 `nonEmptyValue` 当成「有」→ `configured: true`，而 api/sync 会拒绝它。
    改为按**逐字段优先级**判定（env 已给值时文件那一层根本不会被选中，此时不得误报）；
  · **`writeWideConfig(mode)` 的 `mode` 没被用上**（CodeRabbit）：0602 / 0601 两条
    用例实际跑在 0644 上 —— 上面 A5 那条「两条用例钉住判据与措辞」在修复前是**假的**。
    修好后用变异复核（把判据从 `0o077` 放宽到 `0o044`）两条用例必须变红；
  · **文件集比对把「重复条目」当相等**（Codex 第四轮）：清单含重复条目并漏一个文件时
    长度恰好相等 → `check --compare` 退 0、`install` 的 `--force` 也跳过修复。
    判据收口到 `sameFileSet`（去重后比较，重复条目一律判「不同」），两处同源；
  · **`sync tasks --help` 用全族并集校验参数**（Codex 第四轮）：兄弟命令的
    `--full` / `--db` 被当成合法参数（退 0 打印帮助），而正常解析与 `skill check`
    都判非法 —— 运行时与契约校验又一次分叉。改为走该子命令自己的 spec；
  · **umask 077 下的夹具假失败**（Codex 第四轮）：`mkdirSync({ mode: 0o755 })` 会被
    进程 umask 收紧成 0700，断言 0755 的用例假失败 —— 夹具改为显式 `chmodSync`；
  · **受管条目直接 `readFileSync` 会挂死**（Codex 第五轮）：换成受管集哈希后，
    清单里一条被 **FIFO** 占住 → `readFileSync` 打开读端等写端 → `install` 与
    `check --compare` **无限阻塞**（实测去掉筛选后进程跑满 600s、`testTimeout`
    打不断同步读取）；被换成**指向目录外的符号链接**则读取跟随、可能误判「正文一致」。
    新增 `managedContentHash`：先验证每个条目是**实体目录内的普通文件**，不可比的形态
    给出点名原因（缺失 / 非普通文件 / 逃出实体）而不读取；
  · **README 的 `--profile` 建议对部分命令不可执行**（Codex 第五轮）：`api *` /
    `auth whoami` / `sync tasks` 都**不接受** `--profile`（逐个实测退 2），原文
    「在每条命令上写 `--profile staging`」是做不到的动作。按命令能力二分：接受它的
    命令写 flag，其余只能 `QIYU_PROFILE` 或改 `defaultProfile`；
  · **接受清单里错列了 `sync uninstall`**（Codex 第六轮）：它只接受全局 flag 与 `--yes`
    （实测 `sync uninstall --profile staging` 退 2）—— 照新文档执行必然失败。从接受清单
    移除，并把守卫加强为「接受那一行不得出现 uninstall」；
  · **清单文件自身是 FIFO 同样挂死**（Codex 第六轮）：上一处只挡住了受管正文，
    `readManifestSafe` / `readManifestStrict` 仍直接 `readFileSync` 清单 —— 清单路径被
    FIFO 占住时 `skill install` / `where` / `check --compare` 全部无限阻塞。新增
    `assertPlainFile` / `readPlainTextFile`（读前验类型，唯一的普通文件判据），
    三处读清单全部走它；判据用 `statSync`（跟随符号链接）以保留既有语义 ——
    清单路径上的**断链**照旧读成「缺失」（stale），指向文件的链接照旧可读；
  · **`auth login` 的空白变量 hint 建议 `unset` 后重跑**（Codex 第七轮）：
    login 只从环境变量读、不回落配置文件（实测：`unset` 后重跑必然是「缺少 …」退 2）
    —— 照 hint 执行解决不了问题。恢复动作改为「设为真实值后重跑」，并写明 login 的
    读取范围；
  · **whoami 的空白配置键 hint 建议「删掉这个键」**（Codex 第七轮）：`credentials`
    块要求 appKey / appSecret 同时是非空字符串，只删一个键会让 `parseConfig` 拒绝
    **整份配置**（实测：按旧 hint 操作后 whoami 变成「配置文件读取失败」，api/sync
    也读不到其它档）。改为「删掉该档的整个 credentials 块」，并补一条正向对照用例
    （整个块删掉 → 文件恢复可读）钉住这条死路。`resolveCredentials` 的兜底错误同样
    按**值来源**给动作（环境变量 → `unset`；配置文件 → 整个块），两个字段都坏时一起点名；

- **查询 / 存储 / 元数据命令的十五处契约修正（2026-11-05 第二路独立审查，三路探子 + 探针实测 + 十余轮双路收敛）**：

  · **执行期的文件访问与扩展加载被误报成「internal，请报告此问题」**：layer2 拦截
    （`sniff_csv` 这类在执行期才碰文件的函数）与 `Extension Autoloading Error` 只判在
    prepare 期，执行期 catch 一律包成 internal —— 用户拿到的是「请报告此问题」，而真相是
    「沙箱拦截了它，换个写法就能跑」。执行期同样归 `sandbox_blocked` 并给出替代做法。
  · **写者撞锁把持有者说成「写进程」**：实测 DuckDB 是「写者独占 / 读者共享」，一个
    READ_ONLY 会话同样挡住写者；旧文案让 Agent 去等一个并不存在的同步任务。改为
    「被其他进程占用」，hint 讲明只读会话也会挡住写者并给出 `lsof` 排查动作。
  · **库文件已损坏没有归因**：截断（`Could not read enough bytes from file`）与页校验和
    （`Corrupt database file: computed checksum` 不同）两类报文此前既不匹配权限、也不匹配
    「非 DuckDB 文件」，落进各命令的兜底 —— `store status` 说「请用 store status 检查」
    （拿自己查自己）、`query` 说「跑 store init」（对损坏文件同样打不开）。新增第三种成因
    `corrupt`，三个出口共用一份 hint：先备份，再用 `--db` 指向新路径重建（之后 `sync run`
    必须带同一个 `--db <新路径>`，否则仍读到损坏的原文件）。
  · **`mask_warnings` 图例只讲了一半来源**：该键还装 `GROUP BY` / `DISTINCT` 压平、
    `query()`/`query_table()`/`COLUMNS()` 嵌套、非敏感列按值形态误改 —— 图例改为按
    「缺口 / 副作用」两组穷举并声明「包括但不限于」。
  · **`GROUP BY` 别名列漏掉分组失真警告（判据只看分组键）**：`SELECT userPhone AS p … GROUP BY p` 的输出列
    不叫 `userPhone`，判据只看输出列名 → 只剩「别名缺口」一条，而「3 个号码被压成 1 行」一个字
    不提。判据改为只看**分组键**：GROUP BY 项里的敏感列、别名（`GROUP BY p`）、序号（`GROUP BY 1`）
    以及 `DISTINCT` 的选择列表。⚠️ 不用「SQL 里出现过敏感列」判 —— 敏感列只出现在 `WHERE`/`HAVING`
    里时脱敏不改变分组与计数，那样判会谎报分组失真（Codex PR #68 P2 指出，已补反例）。
    判据再收窄到「**可见且非聚合**」：分组键没被投影出来（`SELECT COUNT(*) … GROUP BY userPhone`）、
    或被标量函数包裹的聚合别名（`coalesce(max(userPhone), NULL) AS userPhone … GROUP BY ALL`）
    都不报；`GROUP BY ALL` 按全部非聚合选择项理解（`ALL` 本身不是键）；`SELECT *` / `WITH … SELECT`
    解析不出选择列表时退回输出列名命中（宁多勿少）。字面量与注释不参与关键字/列名判定
    （`'GROUP BY userPhone'`、`GROUP BY 'userPhone'` 都不算分组），但 `struct_extract(t, 'userName')`
    这类「列名只在字面量里」的构造**照样**发缺口警告（§十五.4 方向，过报可接受）。
  · **`db describe` 的 `time_column` 图例路径错位**：枚举翻译挂在 `time_column` 上（实际
    在 `time_column.kind`），而 `time_column: null`（没有声明时间列）没有释义。枚举挪到
    `time_column.kind`，`time_column` 讲形态与 null 含义；守卫下沉到该对象的每个字段。
  · **OOM 报文透出沙箱里必然失败的 `SET` 建议**：DuckDB 的「Possible solutions」三条 SET
    在只读沙箱（`lock_configuration=true`）里全部报 `configuration has been locked`。
    报文截到成因行（最后一个标记处，避开用户文本回声），hint 改为可执行动作并点破这一点。
  · **时间过滤静默丢掉脏时间值**：`query --table --since/--until` 的 WHERE 里带形态谓词，
    脏值行不进 `rows`、不进 `data_coverage`，而 `db tables` 对同一张表会报数量 —— 现在
    `query` 也点名数量并说明它们被排除（没有时间过滤时不报：那时脏值行照常返回）。
    这次计数是**诊断性**的：失败/超时只降级为一条警告，不会把已成功的查询变成失败。
  · **元数据命令的超时 hint 建议了它们没有的参数**：`db tables` / `db describe` /
    `stats fields` 共用 `query` 的「缩小时间范围或加过滤条件」，而它们不接受任何过滤参数。
    超时 hint 改为按调用方注入（`withTimeoutHint` 覆盖会话的所有内部查询）。⚠️ 前置检查
    （`schema_version` 探测）跑在调用方包装**之前**，同一条命令因此在探测阶段给 `query`
    口径、在正式阶段给元数据口径 —— 探测改为经同一个注入点（Codex 第四轮 P3 实测）。
    ⚠️ 但探测 hint 必须由**调用方**决定，不能无脑注入元数据口径：`query` 也走这条路径，
    而它**有** `--since/--until/--limit/--timeout` —— 探测超时时沿用 query 自己的说法才
    对；套上元数据口径会让它建议「改用 `qiyu query --sql`」，正是用户正在跑的命令
    （CodeRabbit 第六轮 minor，两个方向各配源码守卫）。
  · **带正则元字符的别名会让脱敏阶段崩掉**：`SELECT userPhone AS "p(" … GROUP BY "p("`
    的查询本身已成功，`wordHit` 却把别名直接拼进 `new RegExp`，`\bp(\b` 抛 SyntaxError ——
    整条命令报 internal、一行数据都拿不回来（`AS "[x"` 同）。转义统一收口到 `escapeRe`，
    边界改用「前后不是标识符字符」的 lookaround（`\b` 对带标点的别名本就匹配不上）。
  · **分组判据不认子句的作用域**：`GROUP BY` / `DISTINCT` 的起点取的是**第一个**匹配，
    而它可能在子查询里 —— `SELECT userPhone … FROM (SELECT any_value(userPhone) …
    GROUP BY session_type) t GROUP BY userPhone` 只看到内层那次分组，外层真正把手机号
    压平的那一次反而漏报（Codex 第四轮 P2）。起点改在**括号外**定位：只有本层的子句
    才算本层的分组，内层的分组不改变本层输出（反方向同样有用例守着）。
  · **表达式别名不产生分组警告**：别名解析只认「列名紧跟别名」，`SELECT lower(userPhone)
    AS p, COUNT(*) … GROUP BY p` 实测按 `lower(userPhone)` 分组、脱敏后两个号码塌成一行，
    却一条警告都没有（Codex 第四轮 P2）。解析改为按**选择项**（顶层逗号切分）逐项做：
    项形如 `<表达式> [AS] <标识符>` 且表达式里引用了敏感列即算，聚合项除外。
  · **`DISTINCT` 判据既不看作用域、也丢了过去重键**（两个方向都错）：`WHERE x IN
    (SELECT DISTINCT x …)` 里的内层去重被当成外层 `DISTINCT`，拿外层选择列表判完就对外层
    投影的敏感列谎报分组失真（CodeRabbit 第五轮 minor）；而 `DISTINCT ON (…)` 的去重键是
    `ON (…)` 里的**列**、不是整张选择列表 —— 收敛作用域时把 `(ON\s*\()` 的捕获组写成
    非捕获组，于是 `SELECT DISTINCT ON (session_type) userPhone …`（实测按 session_type
    去重）被误报（Codex 第五轮 P2）。两处都配正/反方向用例。
  · **撞锁提示里残留「写锁」自我否定**：写者撞锁的 hint 前半句写「正持有该数据库**写锁**」，
    后半句又说持有者可能是只读会话 —— READ_ONLY 持有的是共享锁，前半句把同一个错误归因
    带了回来（CodeRabbit 第十三轮 minor；测试只锚后半句，所以一直没发现）。改为「持有该
    数据库的锁」，用例补「hint 不得出现『写锁』」；同时把 `sandbox.ts` 那条「与 duckdb.ts
    同款」的注释改成如实说明两条**有意分叉**（只读被挡时持有者必是写者，说「写进程」是对的），
    并给存储 spec 里的旧样例加注。
  · **`SELECT DISTINCT(userPhone)` 无空格写法零警告**：两处 `DISTINCT` 正则都要求 `\s+`，
    而 DuckDB 实测接受无空格写法并去重（3 行 → 2 行）—— 这条查询会一条警告都没有，比
    改动前的判据（任何 DISTINCT + 命中列名即报）还退步（CodeRabbit 第十四轮 minor）。
    两处正则改为 `DISTINCT\b\s*`；配正/反方向用例（本层报、子查询里的不报）。

  守卫：`classifyOpenFailure` 的漂移扫描补「文件损坏判据」两档与两条事故形态自检；
  元数据超时 hint 的包装形态与文案另加源码漂移守卫（含前置探测的注入形态）；OOM 剥除、
  `withTimeoutHint`、`time_column` 元素层覆盖各配行为用例；子句作用域（内/外两个方向）
  与表达式别名（正/反两个方向）、`DISTINCT` 作用域、标点别名（不崩且照报）各配行为用例。
  另加一条**「声明 N 处 ↔ 实际 N 条」的守卫**（`tests/docs.test.ts`）：修复批的标题写数字、
  正文用 bullet 逐条列，收敛轮次补条目后忘改标题已经发生过三次（本批 + 同步与调度批 +
  注册表批，后两处计数一并改正）；数词改为**结构取段**（取「的」与「处契约修正」之间的整段交给解析器，认不出的字形判 NaN 报红）而不是枚举字形 —— 枚举没有终点（先漏「百/零」、补上又漏繁体「兩」）。当前共 **15 条**修复、**40 处**变异验证
  （各方向均已实测变红后恢复绿；含审查收敛轮次里补的判据收窄与诊断降级）。

- **同步与调度的十处契约修正（2026-11-05 独立审查）**：

  · **launchd 的 Weekday 被整体后移一天**：cron 与 launchd 是**同一套**周几编号
    （man launchd.plist：「0 and 7 are Sunday」，1 = 周一），旧代码 `v + 1` 让
    「周一执行」装成周日，**每条按周计划都错一天**；而测试把错误行为钉成了期望值
    （断言 cron 1 → launchd 2）。去掉偏移并改正两处断言。
  · **`sessions.export` 的缺 id 行造成整窗回滚**：缺 id 行此前留到 enrich 才丢，而
    `apiCount` 按**丢弃前**的行数取好 —— written < expected → 整窗 count_mismatch
    回滚（连正常行一起丢），gap 只说「应写 N 实际 M」不点名成因。改为 fetch 侧过滤、
    apiCount 取过滤后行数、丢弃记 `row_missing_key` gap（与 reports 族同一口径）。
    键取值同时收敛到单一实现点 `sessionKeyOf`：此前 fetch 用 `session_id ?? id`、
    投影用 `id ?? session_id`，写反时 `{id:'', session_id:'x'}` 会在 fetch 判「有键」、
    在 enrich 判「缺键」，又回到整窗回滚。
  · **cron 分隔符只接受空格与 Tab**：`trim()` / `split(/\s+/)` 会把 CR/LF/U+00A0/
    U+2028 当空白放过，而 schedule 原文又原样进 crontab 兜底行与回显 —— 实测
    `0 0 *\r* *` 解析成合法 5 段、兜底行里是字面 CR（cron 整行失效），
    `0 0 * * *\n` 把一条计划劈成两行。与 `assertSchedulable` 同族：显式拒绝不清洗。
  · **linux 卸载把 daemon-reload 跑在删文件之前**：命令层是「跑完 commands 再删文件」，
    于是 reload 的仍是即将被删的 unit，删完后没人让 systemd 忘掉它（notes 却写着
    「再删除 unit 文件并 daemon-reload」）。`UninstallPlan` 拆出 `postRemoveCommands`，
    删完后执行；dry-run 输出 `post_remove_commands`（条件键，只有 linux 有），
    `--yes` 的 `commands[]` 按真实次序汇总。
  · **schtasks 分钟计划的相位漂移**：`/SC MINUTE /MO N` 缺 `/ST` 时起始时刻取
    「本机当前时刻」，`*/30` 会装成「安装那一刻 + 30 分」的相位（14:07 装 →
    :07/:37），而 cron 是 :00/:30。补 `/ST 00:MM`（与 HOURLY 支同款锚相位）。
  · **schtasks 每月计划用多日 `/D`**：`/SC MONTHLY /D` 只接受一个日期（文档原文），
    `0 0 1,15 * *` 此前被 join 成 `/D 1,15`，dry-run 先给出一个装了也会被拒的计划。
    多日显式落 `unmappable`。
  · **systemd `ExecStart=` 孤立一个 `;` 未转义**：裸 `;` 是命令分隔符，会把一条
    ExecStart 劈成两条命令（systemd.service(5)：「An argument solely consisting of
    ";" must be escaped, i.e. specified as "\;"」）。`a;b` 这类值不受影响。
  · **快照任务不用 `apiCount`**：windowed 与 `sync verify` 都把它当配对核对基准，快照
    只用 `kept.length` —— 同一字段三条路径三种读法，上游声明多于解析结果时只有快照
    静默吞掉。统一为 `apiCount ?? kept.length`（当前所有快照任务取过滤后行数，行为
    零漂移）。
  · **四处图例口径**：`rows.written` 补「快照的 count_mismatch / write_failed 记 0
    （偏小而非偏大）」并修正 README「落库行数」的绝对说法；`rows.fetched` 改为
    「进入引擎的行数」并点明 fetch 侧丢弃行不计入；`range_status.pending` 的「每轮
    开跑就置 pending」收窄为「有可执行窗口的轮次」；`commands[].command` 点明是 argv
    空格拼接、不能直接粘进 shell（win32 的 `/TR` 本身就是命令串）。
  · **同一窗的两类缺口互相覆盖**：`sessions.export` 既可能缺行（`row_missing_key`）
    又可能缺尾部标记行（`export_fixture_unreported`），旧实现让后者「让位」，消费方按
    `gaps[].reason` 分支时永远漏一类；而 `sync_gaps` 主键 `(dataset, range_start)` 也
    让两条提示在落库时互相覆盖。`FetchResult.gapHint` 改为「单条或数组」，引擎按条落库；
    新增 **v10 迁移**把 `sync_gaps` 主键扩为 `(dataset, range_start, reason)`（DuckDB
    不能改主键 → COPY→DROP→RENAME，历史 NULL reason 补 `unknown`），`clearGap` 仍按
    起点清全部 reason。存储层 spec 里「主键是 C1 假设、设计稿未给依据」的两处记录就地
    补状态注。

  守卫同步：`assertLegendMatches` 的条件键豁免改为按前缀匹配（`post_remove_commands`
  派生的元素键一并豁免），并新增 linux 正向用例 —— 条件键在它真正的平台上必须出现，
  否则「标成条件键」会变成让守卫闭嘴的借口；元素释义从同一份 `SYNC_COMMAND_NOTES`
  派生，避免两处文案漂移。变异 13 处全红（launchd 偏移、sessionKeyOf、fetch 侧丢弃、
  分隔符守卫、卸载次序、`/ST`、多日 `/D`、孤立 `;`、快照 apiCount、图例字符、图例键、
  gapHint 折叠回单条、`sync_gaps` 主键退回两列）。

- **注册表与 api 图例的九处契约修正（2026-11-04 独立审查）**：

  · **`export.session` / `export.session.check` 的唯一载荷被丢弃并谎报「无数据」**：
    设计稿 §7.5 实测两者的成功载荷就是 message 原文（任务 key / 下载链接），
    同步流水线也按此实现；但注册表把它们登记成形状 A（载荷在 data），而响应里没有
    data —— `api call` 输出 `"data":null, "not_found":true, "warning":"接口返回成功但无数据"`，
    Agent 完成导出创建后拿不到 key。新增信封形状 **M**（成功载荷 = message 原文；
    非 200 或无 message 判失败，空 message 不判 not_found），两个接口改登记为 M，
    并补矩阵/信封/集成测试与流水线占位符守卫（'OK' 不得当链接）。判据一律作用在
    **trim 后**的 message 上（`'   '` 是空载荷、`' OK '` 是占位符，都不放行；
    payload 取 trim 值），且**裸数组不是 M 的合法形态** —— 若落到「裸数组一律成功」的
    前置分支，形态漂移会被报成成功、数组被当成任务 key / 下载链接交给调用方。
  · **`export.*` 四个文档外接口的 body 参数表是空的**：生成器对它们硬编码
    `params: []`、`body_kind: 'none'`，而 create/check 的 body 是必需的、流水线就在发。
    Agent 按 `api schema` 会看到「没有参数」，照着发出空 body。在 `EXTERNAL_ENDPOINTS`
    声明实测字段集（`{start,end}` / `{key}` / `{sessionId}` / `{sessionId,mTypes}`），
    生成器与产物同步补齐。
  · **`icoutcall.history.team` 的路径与 seat 完全相同**：设计稿两处记载 team 是独立路径
    `/ipcc/history/team`、载荷为对象（55 字段），而注册表沿用了文档页重复项（与 seat
    同路径、信封 C 数组）—— 按旧登记调用会把 team 的 body 发到 seat 路由、静默拿到坐席
    数组。经 `paths.json` 修正路径，envelope/verified 降为未实测并写明原因；
    限频行的 20 秒同步从 `observed` 降为 `doc`（那次「观测」打在 seat 上）。
  · **`api list` 的 `verified` 图例把「实测范围」全指给每行 note**：53 条 verified:true
    里 42 条没有 note，Agent 无从判断。改为「true = 该接口被真实观测过，不等于成功路径
    一定走通过（receive.message 只验证了不可调用）；具体范围只在该行有 note 时才有
    说明，没有 note 不要假定更多」。
  · **`path` 图例说 null 路径「仍可能是本方可主动调用的」**：加载器强制
    `callable:true` 必有 path，该组合不可达。改为点明「null 必然伴随 callable=false，
    direction 仍可为 outbound」。
  · **`body_kind` 图例说非 json「原样透传」**：实现恒 `JSON.stringify` +
    `application/json`，xml/multipart/text 的原始字节无法表达（`--body '<xml>'` 直接
    退出码 2）。改口并点明「传 JSON 对象给它们 ≠ 字段按接口文档生效」。
  · **`params[].type/required` 的强制范围漏了 body_kind**：`validateBody` 对
    `bodyKind !== 'json'` 直接早返回，`kefu.add`（xml）传 `{}` 不报缺必填；图例却承诺
    「缺必填拒绝」。两处限定为「`body_kind=json` 且 `in=body`」，并点明入站接口的
    required=true 鉴权字段没有任何自动填充/传参通道。
  · **`warnings` 图例把 `missing_required` 列为告警 kind**：它是硬拒绝（退出码 2、
    错误信封），永远不进 warnings。示例改为 `unknown_field` / `type_mismatch` /
    `alias_normalized`，并显式声明它不会出现。
  · **`not_found` 图例漏掉 message 载体与宽松模式**：形状 C 或 envelope 未登记时，
    message 能解析成 JSON 且解析结果为空同样置位。判据按实现写全（形状 C 的「无
    message」是失败、走不到末尾兜底，故不在「整条 200 无载荷键」的接口族里）。

  守卫同步加硬：`specs.json` 与 `overrides` 表的一致性（生成物不得陈旧于事实源）、
  生成器必须产出 export 参数表、信封矩阵覆盖 M、export 集成用例断言 key/链接不再丢、
  图例字符约束（无 `**`、无分隔符 `；`）。变异 13 处全红（M 分支、M payload、生成器
  params、path 漂移、verified 名单、messageOf 占位符、矩阵覆盖；CodeRabbit 首轮追加的
  M 的 'OK' 占位符、team 按文档值 300 秒、verified 图例反例、not_found 措辞；
  第 3 轮追加的 M 的 trim 后判空/占位；第 4 轮追加的 M 的裸数组形态）。

- **核心请求/错误/存储写入的九处契约修正（2026-11-04 独立审查）**：

  · **配置文件解析失败会回显文件内容（安全红线）**：`readConfigRaw` 把 V8 的
    `JSON.parse` 原文拼进错误（实测 `Unexpected token 'X', "FAKESECRET..." is not valid
    JSON`）——配置文件里就有 appSecret，等于把凭据前若干字符写进 stdout。改为只保留
    位置信息（`position N（第 L 行第 C 列）`），原文片段一律丢弃。
  · **HTTP 429 被当成「可能已执行」的网络故障**：429 是服务端在执行业务逻辑**之前**
    拒绝的限流（肯定没执行），却被归 `network` —— 危险接口收到「请求可能已被服务端执行，
    重发会再执行一次」的反向劝阻，且不带任何等待建议。现在 429 在两种载体（网关 HTML /
    Spring JSON）都归 `rate_limit`，统一经 `decorateRateLimit` 附 `retry_after` 与来源
    说明，且不自动重试（立即重试只会继续吃限流）。⚠️ hint 不承诺「一定未执行」——
    网关可能在转发后合成 429，危险接口仍要求先只读确认；响应带 `Retry-After` 头时
    （秒数或 HTTP 日期）以它为准，`source` 新增 `header`（优先于限频表与兜底）。
  · **限流 hint 把「实测无限频」说成「未登记」**：`limitFor` 把两者压成同一个 null，
    5 个显式登记为 `null` 的接口（如 `export.session.check`）撞限流时被告知「未登记在
    本地限频表」——与 `api schema` 的 `rate_limit` 图例（「null = 实测过，确实没有」）
    直接矛盾。改用 `registeredRateLimit` 三态分别措辞。
  · **`14004 appId not bind` 被说成「核对字段名与类型」**：真实成因是账号未绑定公众号，
    改参数与重试都无效。新增分支归 `module_offline` 并点名「绑定公众号」。
  · **`retryAfter.source:'local'` 的注释断言「交付形态不可达」**：`qiyu sync run` 在
    同进程对同一路径反复 `call()` 时就会撞上本地令牌桶（`pace.ts` 专为它而写），注释
    会让后续维护者把它当死值。改为如实说明「单次 `api call` 不可达、sync 可达」。
  · **`--no-validate` 的 usage 只说「关闭 body 校验」**：它实际还关闭别名改写与
    warnings（spec §九 验收 19 的既定语义）。行为不变，把说法补全，并加守卫钉住。
  · **未知接口 id 的 hint 指向默认 `api list`**：默认列表只含 136 条可主动调用接口，
    入站接口与不可调用项要 `--all`。打字打错一个入站 id 的 Agent 会按提示跑默认列表、
    得出「这个接口不存在」。改为 `qiyu api list --all`。
  · **`integer` 类型校验放行 1.5**：只判 `typeof === 'number'`，小数 id/页码静默通过，
    而图例承诺「类型不符是软告警」。改为 `Number.isInteger`。
  · **同批重复主键的 upsert 结果取决于 batchSize**：DuckDB 多行 `INSERT ... ON CONFLICT`
    在同一语句内遇到重复键保留**第一条**，逐条写入则后一条获胜。现在写入前先收敛为
    一行（后出现的获胜），返回值按收敛后的实际写入行数计。去重键按**列的存储类型**
    归一化（VARCHAR 主键的 `1` 与 `'1'` 是同一个值），不按 JS `typeof` —— 否则混合类型
    的主键仍会随 batchSize 变化。

  13 处变异验证全部变红（回显原文、`typeof` 判型、429 归 network、三态压平、`appId`
  分支失效、hint 退回裸 `api list`、upsert 去重失效、usage 退回旧文案；CodeRabbit 两轮
  追加的 Retry-After 头、非有限值/零值/非 HTTP-date 形态拒绝、按列类型归一化去重键、
  复合主键无歧义编码、「无副作用」承诺七处）。

- **#63 新增图例的自查修正：params 的「通道」谎言、recorded_at 形态说反、rows.written 记法（2026-11-04）**：

  PR #63 补齐反向图例覆盖后，我逐条把**每条新图例当成事实断言**回到实现里核对，发现
  七处与实现不符 —— 全是「图例写得像真的、代码不是这么干的」：

  · **`params[].in` 声称了不存在的传参通道（最重）**：初版写「`path` = 进路径占位符、
    `header` = 进请求头」，读起来像调用方有四个通道；而 `api call` 的 URL 是
    `${BASE}${spec.path}?${q}`（**不做**占位符替换），headers 只有硬编码的
    `Content-Type`。这正是本仓库在 `http.ts` 自己警告过的「不要写到不存在的通道上」。
    实际只有 `in=body` 能经 `--body` 传；query 鉴权三件套由 CLI 自填；非鉴权 query 与
    path 参数只出现在不可主动调用的接口上；header 只有 content-type、由 CLI 固定发送。
    `params[].type` / `params[].required` / `params[].name` / `params[].example` 同步把
    强制范围收窄到 body 参数（`validateBody` 只校验 `in=body`，此前写成了普适承诺）。
    CodeRabbit 首轮又抓到一处同类收窄：初版结尾写「不要把非 body 参数塞进 --body
    （会得到 unknown_field 提示）」——该提示只在接口有 JSON body 参数表且未加
    `--no-validate` 时产生，其余情形会被原样发出，已限定条件。
  · **`sync status` 的 `gaps[].recorded_at` 形态说反**：初版写「epoch 毫秒数」，
    实际落库值是 `new Date(...).toISOString()`（实测 `"2026-11-04T02:29:50.268Z"`，
    ISO 8601 UTC 字符串）—— 反倒是同条目的 `range` 才是 epoch 毫秒字符串。
    初版的守卫还只查「图例含『毫秒』二字」，等于把错误说法钉住了；现改为**双向**：
    数据必须匹配 ISO 形态 + 图例必须写 ISO + 旧说法不得复活。
  · **`sync run` 的 `rows.written` 不是「真正落库的行数」**：引擎对 `count_mismatch` /
    `write_failed` 的失败窗记的是「参与核对的应写行数」（已随事务回滚，见
    `sync/engine.ts` 的 catch 分支与 brief 钉死用例）—— 图例说成恒为实际落库会把回滚掉的
    行当成已入库。`tasks[].status` 的 partial 释义里有同一句错话，两处一起改
    （单一计数在空态与非空路径各写一遍的老形态）。
  · **`sync tasks` 的 `maxWindowDays` 声称了不存在的逻辑**：初版说「撞上游 14501 时也按它
    判断是不是切宽了」—— 引擎没有这段逻辑，14501 走与普通取数失败同一条
    `fetch_failed` gap 路径。新增引擎用例真跑钉住：首窗 14501 → 该窗失败记 gap、
    不自动重切、其余窗照跑。

  守卫同步加硬：`api-legend-paths` 新增注册表不变量（可主动调用接口的非 body 参数只能是
  鉴权 query 三件套或 content-type；path 参数只出现在不可调用接口上）——谁破坏了它，
  「非 body 参数没有人工通道」这句图例就不再为真。变异 4 处全红（旧 `in` 措辞、旧
  `recorded_at` 说法、`rows.written` 说法、14501 行为）。全量 **2326** 用例 2 分片通过
  （片 1 1136 + 片 2 1190；此前记录的「1189」只是**片 2 的用例数**，误当成全量）。

- **反向图例覆盖：18 个带图例的命令补齐「输出 ⊆ 图例 ∪ 自明键」，下沉到元素层（HANDOFF #38 挂账，2026-11-04）**：

  此前全仓图例守卫（`command-legends-complete` / `api-legend-paths` / `stats-field-notes`）
  只查「图例 ⊆ 输出」——图例里写的键必须在输出上存在；反方向「输出里的每个叶子键都在
  图例（或登记过的自明键）里有解释」基本无人守。后果是新增字段不留痕：Agent 面对一个
  没有任何释义的键只能猜。新增 `tests/command-legends-reverse.test.ts`，对 18 个带
  `field_notes` 的命令逐个**真跑**，递归收集输出的叶子路径（数组下钻到元素、根数组不带
  `[]` 前缀、`query.rows` 这类列名随表变化的容器登记为 `OPAQUE` 停止下钻），再按
  `covered()` 判据核对。判据要点：图例键是**路径**（`tasks[].gaps[].detail` 而非裸名）；
  `[]` 剥离后逐段前缀匹配，`<字段>` / `<name>` / `*` 恰好匹配一段；**枚举规则**——容器
  一旦有任一条子图例键，它的每个子键都必须自带条目，粗粒度容器注释不得遮蔽缺失的元素级
  键（否则「删掉一个元素级图例、其余键仍覆盖」的假守卫会原样复发）。`warnings` / `notice`
  是 README 一次说明的全局元键，`id` / `columns[].name` 等自明键在测试里显式登记，
  不靠隐式放过。

  本轮补齐的图例全部对应实测能读到的真实字段：`api list` 的 meta 键
  `rows` / `filter` / `registry_complete` / `registry_note`；`api schema` 的
  `params[].in/type/required/name/description/example` 与 `endpoint` / `note`；
  `skill install` 的 `dry_run`、`links[].error`；`sync run` 的
  `windows.total/succeeded/failed`、`rows.fetched/written`、`notes`、`gaps[].reason/detail`；
  `sync status` 的 `gaps[].detail`、`gaps[].recorded_at`；`sync tasks` 的
  `maxWindowDays` / `overlapDays`。`api-legend-paths.test.ts` 同步改为可解析 data **或**
  meta 上的路径（并把 `request_schema` 登记为「不含参数表」的独立否定声明，而非路径）。

  守卫自身做双向验证：`covered()` 携带 5 条最小反例用例（粗容器遮蔽、元素级漏一、
  通配符越界、前缀反写、根数组），防止判据退化成恒真；变异 M1–M6（删除/改名图例）与
  G2–G6（放宽判据）全部变红，G1 经核实为等价变异（单段顶层叶子的两条分支同值）如实记录。
  过程中即抓到判据自身的一处死代码（枚举规则的元素比较写成了整段比较、永不命中，
  放宽兜底让漏标蒙混过关），靠变异 M2 复现后修正。另加一条形态约束：stdout JSON 的
  图例文本禁用 `**` Markdown 加粗（终端里是字面量，不是渲染）。

- **报表空载荷漂移守卫：`{}` / `[]` 不再被当合法空窗（HANDOFF 报表层 #6，2026-11-04 真实上游采样）**：

  `payloadRows` 的「一行全局汇总」兜底会把空对象写成一行全空行（覆盖同键的真实汇总），
  空数组则被当合法空窗（0 行、`complete`、零 gap）—— 两种都是「静默吃掉一整窗」。
  ⚠️ 此前按「裸 `[]` 对 per-staff 族可能是合法空窗」挂账，**本次用真实凭证逐个采样**九个
  报表接口的空窗形状后收窄：空窗从来不是空容器 —— `overview` 带 69 字段的全零行、
  `robot.summary` 带字段汇总行、`transferHuman` **一行数组**、`salaryDetail` 带
  account/date/id 的一行对象、`staffworklod`/`satisfaction`/`staffAttendance` 是
  `{result:[],total:0}`、`staffquality`/`performance` 另带 `sum` 字段。故 `{}` 与 `[]`
  一律**显式失败**（与 `api` 层 `not_found` 同一判据，同步侧升级为拒绝落库）。
  3 条用例（含「实测两种合法空窗照常接受」的反向对照）+ 2 处变异验证。

- **sync 行丢弃留痕：缺主键列的行不再静默消失（HANDOFF 报表层 #5，2026-11-03/04）**：

  · **报表/工单/类目树的映射阶段丢弃行时不留痕（中）**：`fetchPagedStaff`（缺 `staffId`）、
    `staff_attendance`（缺 `staffId` 或脏时间戳）、`order_performance`（缺 `orderId`）、
    `tickets.search`/`tickets.logs`（缺 `id`）、`knowledge.categories`（缺 `id`）都在
    `apiCount` **之前**丢弃行 —— 配对核对因此恒等、`fetched == written`、窗口照样
    `status: complete`，Agent 无从知道上游有一批行没落库。
    → 新增任务层 gap reason **`row_missing_key`**（进 `TASK_GAP_LOSSY_REASONS` 丢失档），
    逐处统计丢弃行数并在成功窗落 `sync_gaps`（`detail` 是规模）；`knowledge.categories`
    复用 `knowledge_row_malformed`（缺 id 的节点连同**子树**一并计数，它们同样没落库）。
  · **顺带删除两处死代码（同属契约诚实性）**：`fetchSimple` 的 `perStaff` 参数与
    `dim.ts 的 `perRow` 回调**所有调用点都传 `undefined`** —— 永不执行、一旦执行就静默
    丢行的一支。删除后「丢行」在本层只剩「显式抛错」（`keyCols` 空主键）与「计数 + gap」
    两种形态。`fetchSimple` 也因此不再可能写出与全局汇总行同键互覆的 `sum` 行（显式注释）。

  ⚠️ README 的「上表**后五行**是成功窗上的提示」改为逐名点出四个失败类 reason —— 位置
  指代依赖没有守卫的表格顺序（新增一行即失真），与 `sync-notes` 的 run 图例同一纪律。
  配 5 条行为用例（含「全部行都有主键 → 不产生 gap」的反向对照）与 4 处变异验证。
  **CodeRabbit #61 补的三处**：`ticket.logs` 的 detail 用了不存在的任务 id `tickets.logs`
  （注册表里是 `ticket.logs`）；缺 id 的 touched 工单其**日志整单未拉取**，必须与「丢弃的
  日志行」分开计数并点名（此前静默 complete）；知识库类目节点的**空串 id** 与缺键同判
  （`''` 会写成可被反复覆盖的同键行）。

- **skill install/where/check 五处契约不诚实（独立审查 #9–#13，2026-11-03，逐条真实 CLI 复现）**：

  · **#9 悬空符号链接占着实体路径 → where 报「未安装」并推荐 install，而 install 必退 1**：
    `statSync` 顺着链接抛 ENOENT，旧实现把「链接占着这个位置」当成「根本不存在」。
    引入共享判据 `dirShape()`（`paths.ts`，唯一实现点）：`'dir' | 'absent' | 'not_a_directory'`，
    后者同时覆盖普通文件与悬空链接；install / where / detect 三处 `statSync` 判定全部改为消费它。
  · **#10 `compatible` 只读清单就给改过的正文背书**：手工改过实体正文后 `where` 仍报
    `compatible:true`，而 SKILL.md 教 Agent「就看这一个字段」。现在 `where` 拿实体当前内容哈希与
    清单记录的 `content_hash` 比：不一致（或正文读不动）→ `compatible:null`（判定不了，
    不是 `false`）+ 点名 `--force` 的警告。四个载体（SKILL.md / README / where 的
    `field_notes` / `--version` 的 `field_notes`）同步收窄口径；「正文与 CLI 不配套」这条
    断言只在正文与清单一致时出现 —— 否则同一份输出里 `compatible:null` 与「不配套」自相矛盾
    （CodeRabbit #60）。判据用**受管文件**（清单 `files` + `file_hashes` 逐个核对）而不是
    实体目录总哈希：用户自己放进实体的额外文件 `--force` 刻意不删，只比总哈希会让
    `compatible` 永远停在 null 而警告推荐的 `--force` 修不好（CodeRabbit #60 实测复现）；
    额外文件单独如实列出、不改变配套结论；旧清单没有受管文件列表时退回总哈希并如实声明
    「分不出正文被改与额外文件」。
  · **#11 agent 的 skills 路径被普通文件占住：where 报 unknown+ENOTDIR、install 报 missing+
    「目录不存在」（事实错误）**：两边现在都先走 `dirShape`，同报 `unknown` +
    「路径存在但不是目录」。
  · **#12 `skill_check_failed` 的 hint 点名一个已不可能触发的成因**：`checkSkillDir` 早已递归
    进入 `*.md` 子目录（不再当文件读、不会 EISDIR），hint 却仍教用户「把名为 *.md 的子目录改成
    文件」—— 一句点错方向的指引。改为按系统错误分派：EACCES/EPERM → 权限；ENOENT/ENOTDIR →
    路径不存在/不是目录；其余 I/O 错误看具体路径。
  · **#13 真实安装对 ELOOP 自环链接报 `foreign`、dry-run 与 where 报 `unknown`**：
    `foreign` 的释义是「路径上是别人的东西」，而 ELOOP 是连它是什么都判定不了。install 统一
    改记 `unknown`（`LINK_REPORT_STATES` 报告域，来自 `paths.ts`），动作不变——不触碰；
    agent 目录本身无法检查（EACCES/ELOOP）时 links 同样记 `unknown` 而非 `missing`
    （CodeRabbit #60：`missing` 含义是「不存在」，而那里只是判定不了）。

  每条配变异验证（4 个变异各自令对应用例红），全量 582 用例 / 4 分片通过。

- **报表/窗口五处数据完整性缺陷（独立审查 agent「报表与窗口数学」路线，2026-11-03，逐条探针复现）**：

  · **staff_attendance 的窗边界日丢小时且 `status: complete`（严重）**：`deleteRangeInsert`
    的删除范围是 `[dayOf(start), dayOf(end−1ms)]`，而 31 天窗从任意起点切 —— 下一窗的
    start 落在上一窗末段的那个自然日之内，删除范围从头删掉该日**全部**小时行、随后只重写
    start 之后那些，边界日前半段被删且永不重写（实测 fetched=written=960、零 gap，边界日
    只有 16/24 小时）。修法（两轮收敛）：`deleteRangeInsert` 的删除基准拆成二选一 ——
    ① 按日粒度范围列删（剩余 8 张报表，窗起止都落上海日界，删除精确覆盖窗）或
    ② 按行内逐行瞬时时间列删（考勤：`instantColumn: 'hour_ts'`，按 `[w.start, w.end)` 精确删，
    不依赖日对齐）。中间版本「只删完整落在窗内的自然日」修好了丢数据却留下**陈旧行**
    （CodeRabbit #59：半个边界日里被上游撤掉的小时永不删、仍 complete）—— 逐行时间列同时
    做到「窗内精确覆盖、窗外一行不碰」。
    ⚠️ 曾试「给该任务声明 `windowAlign:'shanghaiDay'`」，复核发现 31 天步长的日对齐网格 +
    残段窗跳过会让「水位+1ms 落在日中间」的首窗被跳过后再跳 +31 天、中间 30 天不抓 —— 已回退。
    两类删除基准的**声明前提**由 `sync/write-contract.ts` 在注册表加载期 fail-fast 校验
    （按日删 ⇒ 必须**同时** `rangeAlign:'shanghaiDay'` **与** `windowAlign:'shanghaiDay'`；
    瞬时列删 ⇒ 必须是表的 `timeColumn` 且 `kind='iso-instant'`），配
    `tests/sync/delete-boundary-contract.test.ts` 双向自检。
    ⚠️ `rangeAlign` 一档是 CodeRabbit #59 三轮补的：漏声明时引擎落到「非天对齐」分支，
    拿 `toISOString()` 的瞬时串（`…T00:00:00.000Z`）比日粒度列值（`YYYY-MM-DD`），
    字符串前缀关系让窗起点那一整日的行永远删不掉（陈旧行）而窗口仍 complete ——
    实测探针：同一删除条件，日对齐形式删掉 `2026-11-03` 行保留 `2026-11-04`，
    瞬时串形式两行都在。
  · **staff_quality 不分页，`total=1500` 只取 1000 行仍 complete（严重）**：走 `fetchSimple`
    单次调用、不读 total（C 中-3 的短读终检只在 `pagedRaw` 里）。实测事实（设计稿 §6.2）：
    `staffquality` **分页**且 `sum` 覆盖全集 → 改走 `fetchPagedStaff(..., withSum)`，
    sum 行照旧落 `staff_id='sum'`；回归测试钉「2 个页面都拉到、1501 行」与「短读必须 partial」。
  · **`windowEndClamp` 之外的窗整窗丢弃且不计数（中）**：既不在 `windows.total` 也不在
    `skipped`、无进度行 —— 请求「今天」的考勤/绩效得到 `total:0, complete, gaps:[]`，
    与「已同步完成」不可分，与仓库自定的「绝不静默消失」相悖。修法：`runWindowed` 与轮转
    路径都统计 `droppedByClamp` 进 total/skipped，并逐窗出「晚于末端上限」进度行。
    ⚠️ 轮转路径的**非空分支**当时仍漏发进度行（只有空窗分支发了 —— CodeRabbit #59 指出，
    与 `runWindowed` 两条路径都发不一致）：已补 + 回归（部分钳制 = 1 可执行窗 + 1 丢弃窗）；
    同时 `windows.skipped` 的 README 与 `meta.field_notes` 释义从「残段窗数」改为
    「残段窗 + 整窗晚于末端上限（两种成因分开点名）」，不然 `skipped>0` 会被读成只有残段。
  · **order_performance 的 sum 哨兵行跨天互相覆盖（中）**：裸 `order_id='sum'` 在主键只有
    `order_id` 的表里是**全局一行**，回补前一天会 upsert 覆盖后一天的汇总（实测先 day1 再
    day0，day1 汇总消失）。注释声称「与 staff_quality 一致」不成立（后者主键含 stat_date）。
    修法：哨兵随窗口日 `sum:<上海日>`，自描述且按天唯一（无需迁移）。
  · **README 的报表任务计数与事实不符（轻）**：写「8 个 `stat_date` 为主键的报表任务」，
    实际 windowAlign 有 8 个、主键含 `stat_date` 的只有 6 个（`order_performance` 主键
    `order_id`、`staff_salary_detail` 是 `staff_id + work_date`），会误导 Agent 按
    `stat_date` 关联这两张表。改说清两个口径，并加双向守卫（枚举计数 + README 措辞 +
    旧说法不得复活）。

  另删掉 `sync/windowing.ts` 的 `mergeRanges`：导出但**无任何生产调用方**（只有自己的测试），
  属「声明了没人读」的导出面。

  以上每条均做变异验证（改坏实现 → 对应用例红 → 还原）。

- **七处错误出口 / 限频闸门缺陷（独立审查 agent 第六轮，2026-11-02，逐条真实命令复现后修）**：

  · **`fail()` 本体不净化（中高·安全）**：`usageFail` / `failFromTagged` / `emitQueryFailure`
    三个上层出口各自净化，而走 `fail()` 直出的路径（`statGuard` 的库前置检查、
    `storeNotInitializedHint`、`thrownToExit` 多数分支）把 C1 控制字符原样写进 stdout ——
    实测 `store status --db $'/tmp/x\u009b31mBAD.db'` 输出原始字节 `c2 9b 33 31 6d`（CSI，
    终端可改色/清屏），同一输入在 `db describe` 的 hint 里却是 `·31m`。JSON.stringify
    不转义 `\u007F-\u009F`，这层净化是终端注入的唯一防线。修法：净化收敛到 `fail()` 唯一
    出口（幂等，上层出口已净化的消息再过一遍不变），`target` 一并净化。
  · **`--pretty` 下用法错误被缩进（中）**：`emitQueryFailure` 为保住真实 code
    （`query_error` / `sandbox_blocked`）复刻了 `usageFail` 的 stderr 写法，却没复刻
    「临时关掉 --pretty」那一步 —— `query --sql 'SELEC 1' --pretty` 输出缩进错误信封、
    退出码 2，与 README「--pretty 只修饰成功输出」相反。复刻一半比不复刻更危险。
    修法：`output.ts` 新增 `failCompact()` 作为紧凑信封的唯一实现，`usageFail` 与
    `emitQueryFailure` 都走它。
  · **`store status` / `store init` 对缺表静默（高）**：两者此前只报「库中有而声明无」，
    声明表被删时零 warnings、`ok:true` —— 同一库上 `db tables` 在警告、`store status`
    说没事，而 README 恰恰教 Agent「数量不等时先读 warnings」。修法：`storeTablesWarnings()`
    成为三命令两半漂移的唯一渲染点，缺表那半复用 `missingTableCauses()`（与 db/query/stats
    逐字同源）；`tests/missing-table-causes.test.ts` 的对拍矩阵从 4 出口扩到 6 出口。
  · **危险接口的 5xx 说「请退避后重试」（严重）**：`message.send` 这类危险接口在
    fetch 抛错 / body 读取失败两支网络故障里有「不会被自动重试」的收窄说明，但 5xx 的
    两种载体（网关 HTML / Spring JSON）仍报「网关瞬时故障，请退避后重试」—— 而 502/504
    恰恰是「上游收到请求后失败」的典型形态，Agent 照做就是一次确认变成两次执行。
    修法：`DANGEROUS_NETWORK_HINT` 常量成为四支网络分支的唯一文案源；实测两种载体下
    `message.send` 均只发 1 个请求且 hint 同源。
  · **瞬时 5xx 不走 core 重试预算（中）**：只有 fetch 抛错与 body 读取失败会重试，
    5xx 直接抛出；而 `sync/engine.ts` 的 `isTransient` 以「core 已重试 2 次」为前提
    不再重试网络类错误 —— 于是（实测）一次网关 502 只发 1 个请求就把整个窗口打成
    `fetch_failed` gap，且 gap detail 还写着「可退避重试」。修法：HTML 与 Spring JSON
    两支 5xx 也走同一 `networkAttempts` 预算（实测各 3 次请求），`isTransient` 的前提
    注释如实记录「此前是假的」。
  · **闸门键不覆盖任务实际调用的全部 endpoint（中）**：`callPaced` 命中限流时 penalize
    写的是**当下那个** endpoint 的冷却行，而引擎取数前只 acquire `task.endpoint` ——
    一个任务调多个 endpoint 时，被限流端点的冷却永远读不到。实测：`ticket.logs` 的
    `ticket.log` 被限流 → 冷却行 `__ratelimit__:ticket.log` 落库，`acquire('ticket.search')`
    放行，紧接着又发 4 次 `ticket.log`；`dim.ticket_template_fields` 的
    `ticket.template.list` 同理。修法：`SyncTask.gateEndpoints` 声明全部实际端点
    （tickets/dim/sessions 三处补声明），引擎逐个 acquire；`tests/sync/gate-keys.test.ts`
    以**真实调用采集**（记录型 fetch 跑每个任务）双向核对「声明 ⊇ 实调」，不靠扫源码。
  · **store/sync 的「未知参数」不渲染空串（中）**：两文件 10 处出口用 `join(' ')`，
    `store status --db x ''` 报「未知参数：」冒号后空白，Agent 读不出自己传了什么
    （其余命令早已用 `describeArgs`）。全部收敛到 `describeArgs`。

  以上每条均做变异验证（改坏实现 → 对应用例红 → 还原）。

- **三处「说的和做的不一致」（独立审查 agent 第四轮，2026-11-02）**：

  · **`dim.ts` 产出的 gap reason 不在枚举里**。`dim.staff_group_members` 写 `staff_id_list_malformed`，
    而 `TASK_GAP_REASONS` 当时只声明四个 —— 运行时产出了枚举外的值，Agent 按 `gaps[].reason` 分支时
    在 README 图例里查不到任何释义，图例自称的「全部取值」也少一个。为什么 `typecheck` 没抓住：
    `...(gapHint ? { gapHint } : {})` 这种扩展表达式让返回值的 contextual type 消失，把该 reason
    改成 `12345` 仍是 0 error（同一文件改成 `rows: 123` 立刻报错）—— 类型在这里给不出保证。
    修法：补进 `TASK_GAP_REASONS`，README 图例与 skill 协议同步，并新增**静态扫描守卫**：
    `src/sync/tasks/*.ts` 里每个 `reason:` 字面量都必须属于枚举，配「扫不到任何字面量则判据退化」
    的下限断言与变异自检。顺带清掉「8 值」「这四个」这类随枚举长度失真的计数断言（同一个谎报的另一种形态）。
    该守卫本身也被 CodeRabbit 补了两刀（均已复现）：判据原用**并集** `GAP_REASONS` 核对，任务层写
    `reason: 'fetch_failed'` 会让成功窗提示长出引擎失败语义而照样放行（现值域收窄到 `TASK_GAP_REASONS`
    并显式排除引擎侧值）；正则原只认单引号，写 `reason: "unknown"` 会被整条漏扫而既有命中仍满足
    下限断言（现两种引号都收，并加双引号形态的捕获自检）。

  · **`SyncTask.id` 的注释举例了一个不存在的数据集**。原文写「数据集 id（`'reports.overview'`、`'tag.all'`…）」，
    但 `tag.all` 只是可调接口、不是同步数据集 —— `tags` 表在 V1 就建了，全仓没有任何同步任务声明它，
    `sync run tag.all` 只会得到「未知任务」。例子换成真实存在的 `'tickets.search'`；`dim.ts` 头注释里
    「tags 归属 T12 汇总时一并声明」的旧说法改实况（明确写出没人同步它）。

  · **`sync install` 的 crontab 兜底行用了另一套引号实现**。该行是给人手工复制的 POSIX shell 行
    （cron 以 `/bin/sh -c` 执行），却走 install.ts 自己的 `shellQuote` —— 它只把空白与 `"` 视作需引号，
    `--db /tmp/q$(id).db` 会**裸着**印出来，粘进 shell 时 `$(id)` 真的执行。改走 `output.ts` 的
    `shellArg`（shlex.quote 同一安全集、POSIX 方言），同一契约不再有两个实现点；测试双向钉住
    （含 `$()`/空白的路径必须被单引号包住，安全集内的路径不得多套引号）。`ExecStart` 与 schtasks
    不经 shell；schtasks 收单个 `/TR` 字符串、由计划程序直接 CreateProcess，保持原有双引号渲染。

- **同一族缺陷的另外两个载体 + 一处文案分档（Sourcery 复审与独立 agent 第五轮，2026-11-02）**。
  Sourcery 只点了 crontab 的 `%`；顺着「同一转义契约在多个载体各写一套」这条往下查，
  同一份参数实际有**四个载体**（plist XML / systemd ExecStart / crontab 行 / schtasks `/TR`），
  逐个体检后确认另外两个也各错一处：

  · **`ExecStart` 的 `%` 与 `$` 会被 systemd 自己替换掉**。它不是 shell，但官方文档写明它在
    把 argv 交给程序前做替换：systemd.unit(5)「`%` specifiers…Use "%%" in place of "%"」、
    systemd.service(5)「to pass a literal dollar sign, use "$$"」；本轮再核 systemd.syntax(7)
    发现**第三条**：`\` 是 C 转义且「any backslashes should be doubled」（引号内外都解析）。
    于是 `--db /tmp/a%b.db` 被换成 boot id、`--db /tmp/$HOME/q.db` 被展开到别处、
    `--db 'C:\q\q.db'` 被吃掉反斜杠 —— 与 crontab 的 `%` 同族。修法：新增 `systemdArg`
    （`shellQuote` 之前先做 `\`→`\\`、`%`→`%%`、`$`→`$$`），**必须用函数式替换**——
    替换串里的 `$$` 有特殊含义，写 `.replace(/\$/g, '$$')` 实测只产出一个 `$`（转义被自身吃掉，
    首轮实现就踩了这个坑并被新测试抓住）。
  · **crontab 兜底行的 `%` 没转义**（Sourcery 原始发现）。crontab(5) 原文：`%` 除非写成 `\%`，
    否则被换成换行、第一个 `%` 之后的内容整体变成命令的 stdin —— 这一层发生在 sh **之前**，
    所以单引号包不住它；实测修前 `--db /tmp/a%b.db` 裸着落在兜底行里，照抄执行会跑
    `--db /tmp/a`、`b.db` 变 stdin，**静默跑错库**。注意 `%` 本就在 `shellArg` 的 POSIX 安全集里，
    只有 `\%` 能挡。
  · **参数含换行/回车会装出一条「计划里的计划」**：crontab 行与 systemd unit 都是逐行格式，
    实测 `--db '/tmp/a\n0 0 * * * touch /tmp/x\nb.db'` 让兜底行变成 3 个物理行、中间那行是
    一条**真的 cron 计划**（以安装者身份执行）。新增 `assertSchedulable()`，三平台统一以用法
    错误拒绝（launchd 的 plist 技术上能承载换行，但同一份参数在三平台形态应当一致）。
  · **README / skill 把两种相反的实况合并成了一句「数据未必缺」**。`knowledge_row_malformed`
    与 `staff_id_list_malformed` 描述的行**确实没落库**（必须核对上游形态），而
    `filter_matched_no_staff`（上游本就没命中）、`export_fixture_unreported`（该不该有行尚不可知）
    是「未必缺数据」——Agent 按同一句话处理会低估前者。修法：新增单一出处
    `TASK_GAP_LOSSY_REASONS`，README 图例段、skill 协议、`sync run` 图例三处都从它说话，
    测试钉住「真划分」（非空 + 真子集 + `filter_matched_no_staff` 不在其中）与三处文案两档齐全；
    同时把 `staff_id_list_malformed` 的释义拆到「整组」与「该成员」两种成因（原子句「该组成员
    未落库」把两种成因合并成一个规模：非数组时确实是整组、空 id 时只有该成员，原句在后者上夸大）。

  **判据自身的两处退化（CodeRabbit 第二轮）**：
  · gap reason 的静态扫描正则写成 `[a-z_]+`，`reason: 'v2_bad_reason'` 整条不匹配，而**其余文件
    照样满足 `>= 4` 的下限断言** → 判据静默放行（枚举值含数字完全正常，判据不该靠「值里没有
    数字」这条未声明的隐含假设成立）。字符集放宽到 `[a-z0-9_]+` 并加数字后缀形态的捕获自检。
  · 同一族形态的教训：**下限断言可被别处的既有命中满足**，所以每条扫描判据都要配「它必须能
    捕获的最小反例」，而不是只靠计数。

  **变异验证**：本批 8 处全红 —— `ExecStart` 退回 `shellQuote`（2 红）、`crontabArg` 去掉 `\%`、
  删掉 `assertSchedulable` 调用、`systemdArg` 去掉 `\` 转义、README 两档合并成一句、
  reason 扫描退到 `[a-z_]+`、任务层 reason 改成 `v2_bad_reason`。
  ⚠️ **边界**：`ExecStart` / crontab 的转义依据官方文档，本机是 darwin、**未在真实 systemd 或
  cron 上端到端实测**；不含 `\`/`%`/`$` 的值是恒等变换（既有条目形态零漂移）。
- **四条错误分类判据（本轮第二批落点）之外，另有五处独立缺陷**（均由独立审查 agent 发现并复现）：

  · **`api call` / `api schema` 的用法错误在 `--pretty` 下被缩进**。`usageFail()` 是「用法错误
    永远紧凑」的唯一收口点（README 与设计稿都写明这条契约），而这两个子命令的用法错误走的是
    **手写的第三个出口** `mapThrownToExit`，它自己净化、自己写 stderr、自己调 `fail()` ——
    前两项与 `usageFail` 逐字重复，第三项漏了最重要的一条。实测 `api call nosuchid --pretty`
    与 `api call ticket.search --body '[]' --pretty` 都输出**缩进**信封，而同一退出码的
    `api list extra --pretty` 是紧凑的。测试只钉了走 `usageFail` 的三条分支。现改为 `usageFail`。
  · **`api list` 的 `direction` 图例把 inbound 说成「其 path 是占位符 `/`」** —— 全称断言，
    而 17 条 inbound 里 9 条是 `/`、**5 条有真实路径**（`get_token` `/get_token` 等，全部
    `callable: false`）、3 条是 `null`。Agent 会拿「path 是不是 `/`」当 inbound 的判据。
    已收窄并点明真正依据是 `direction` / `callable` 两个字段。
  · **`api call` 的 `meta.warnings` 图例承诺 `--no-validate` 时恒不出现** —— 假承诺：
    skill 安装态提示经 `ok()` 的 `mergeSkillWarning` 并进**任何**成功输出，`--no-validate`
    也不例外（实测 `meta.warnings = ["skill 未安装到 …"]`）；且元素形状**不统一**
    （无软告警时是裸字符串，消费者按 `w.kind` 取值会得 `undefined`）。已如实改写。
  · **`postinstall` 的「已是最新，跳过」是假归因** —— `planInstall` 的 `skipped` 有四种含义，
    而判据只看了 `status === 'skipped' && plannedStatus === 'skipped'`，于是「正文被手工改动、
    未加 `--force`」这一支（零写入、正文没跟上）也被说成「已是最新」，**紧接着下一行又打印
    「内容与包内不同，未覆盖」，同一进程两行自相矛盾**（实测复现）。判据改为 `installSkill`
    算出的 `upToDate` 一个字段（消费方不必各写一份四态判断）。
  · **`auth whoami` 的 `robots` 图例说「空数组有两种成因」，实为三种，且第三种静默** ——
    凭证齐全时畸形配置（非法 JSON / 未知键 / 权限不足）被吞进 `configError`，成功路径完全不提，
    `robots` 静默变 `[]`。实测 `{profiles:{…}, unknownKey:1}` 时输出 `configured:true` + `robots:[]`
    且无任何警告，Agent 照图例只会得出「该档没配 robots」。现成功路径也把原因放进 `meta.warnings`。

  **Sourcery 复审补了四处**（均已核实并修）：
  · `upToDate` 漏了**并发收敛**这一支 —— 两个安装进程竞争一个不存在的实体时，赢家装出的
    内容可能与包内**完全一致**，而本进程 `plan.status` 恒为 `'installed'`，于是判成
    「未完成更新」（对一个已装好的实体说反话）。现加 `convergedByConcurrent` 标记，
    并**双向**钉住：完全一致 → `upToDate: true`；仅清单落后 → `false`。
  · `api call` 图例把 `field` 说成软告警的必备键 —— `non_json_body`（body_kind 非 json 时
    照原样发字面量）是**整条请求**级提示，只带 `kind` 与 `message`，消费者按 `w.field`
    取值会得 `undefined`。已写明 `field` 只在告警属于具体字段时出现。
  · `whoami` 图例把「权限不足」也归进「配置读取失败 → meta.warnings」—— 权限过宽（含凭证）
    走的是 `failFromTagged` → `config_insecure` **错误**，根本到不了成功路径。已如实区分。
  · README 第 176 行仍写「空数组有两种成因」—— 与同 PR 改过的图例不一致（第二事实源漏改）。
    已改为三种并指向 `meta.warnings`。

  **变异验证**：本批 6 处全红 —— `mapThrownToExit` 退回手写出口、`direction` 退回全称断言、
  `upToDate` 去掉 `plan.warnings.length === 0`、`upToDate` 去掉并发标记、
  并发标记不看 `action === 'none'`、`whoami` 去掉成功路径的 warnings。

- **同一形态的第三批落点：四条错误分类判据也是裸子串判，能被列值与 SQL 回显仿冒**。
  上一批只把 `isInterrupt` / `isLayer2Blocked` 收紧，**同一文件里另外四条分类判据漏在外面**
  —— 表/列不存在（四条正则）、`Parser Error`、`Binder|Catalog Error`、`Out of Memory Error`。
  它们同样是「拿整条报文做子串搜索」，而报文里嵌着外部字节。实测：
  · `SELECT * FROM sessions LIMIT '<值>'` 在 **prepare 期**常量折叠成
    `Conversion Error: Could not convert string 'Catalog Error: Table with name zzz does not exist!' to INT64 …`
    —— 类型转换错误被报成「表 zzz 不存在」+ 候选清单，把 Agent 支使去改它没写过的表名；
  · ``SELEC'Binder Error: Referenced table "sessons" not found!'`` —— 纯语法错被报成
    「表 sessons 不存在」+「候选：sessions」；
  · 列值含 `Out of Memory Error` 时，类型转换错误拿到「缩小时间范围或加过滤条件」的假修法；
  · 列值含 `Parser Error` 时，类型转换错误被报成「SQL 语法错误」。
  **修法**：四条判据一并收进 `src/query/native-error.ts`（`duckDbSaysMissingName` /
  `isParserError` / `isBinderOrCatalogError` / `isOutOfMemory`），统一「剥 SQL 回显 +
  要求 DuckDB 自己那句话**在报文开头**」（容忍 `Failed to extract statements: ` 包装 ——
  真 Parser 报文实测带它；真 Catalog/Binder 报文实测不带）。
  **连带修**：`driftFailureFor`（`query --table` 的库漂移识别）此前拿 sandbox 包装后的
  中文串去匹配，判据收窄后**永远不命中**，hint 退化成「用 `db describe <表>` 查看列清单」
  —— 正是它要防的那句话。改为吃 `cause` 上的原生原文。

  首版还差一步（CodeRabbit 抓到并在同 PR 内修）：只查「报文以类别前缀开头」不够 ——
  **列名是用户给的**，可以整段长成另一条报文的形状。实测
  `SELECT "Catalog Error: Table with name zzz does not exist!" FROM sessions` 时，
  DuckDB 说 `Binder Error: Referenced column "…" not found`，前缀检查通过而表名正则
  在**列名内部**命中 →「列不存在」被报成「表 zzz 不存在」。现判据模式本身也锚在那句话的开头。

- **撞锁判据的子串搜索把「路径里含 `Conflicting lock` 的非 DuckDB 文件」判成撞锁**。
  实测：`db tables --db '/tmp/Conflicting lock/q.db'`（内容是垃圾）耗时 **30.1 秒**、报
  `store_locked` + `retryable: true`（「数据库被写进程占用，请稍后重试」）—— 而同一份内容
  放在不含该词的路径上 0.3 秒就给出正确的 `store_not_initialized`。根因：DuckDB 的**非锁**
  报文也把库路径原文嵌进去（`IO Error: The file "…" exists, but it is not a valid DuckDB
  database file!`）。判据改为锚 DuckDB 的模板骨架（`Could not set lock on file "…":` +
  `Conflicting lock is held in ` + ` by user `），三处都不在路径里，没有第二种报文能命中。
  设计稿 §5.2 的「message 含 `Conflicting lock`」已就地回写为该口径（意图不变：非锁错误不
  无谓退避）。

  ⚠️ **同 PR 内的 CI 修正**：首版判据锚了三段骨架（含 ` by user `），那是**只在本机
  （macOS）探针过**的产物 —— CI 的 Node 20.12 / 22 / 24 **三个矩阵项全红**，而同一个用例
  在我这里绿。真实原因是平台差异：**Linux 的锁报文没有 ` by user ` 那段**
  （`… Conflicting lock is held in /opt/hostedtoolcache/node/24.22.1/x64/bin/node (PID 4894). See also …`）。
  现只锚两段跨平台都有的骨架，并给测试补了 Linux 形态夹具。教训与「采样源按平台核对」同族。

  同 PR 内还回写了**实施计划**（`docs/superpowers/plans/2026-10-13-存储层.md`）里那份
  已作废的 `isLockError` 实现与示例夹具 —— 照抄计划的人会把缺陷原样搬回来
  （Sourcery 指出）。计划不是只读历史：它是对后来者的**指令**。

- **`db` / `stats` 的「未知参数」把空串渲染成隐形**。`query` / `api` 早走 `describeArgs`
  （空串渲染成 `''`），`db` / `stats` 共八处仍是裸 `join(' ')` —— `db tables ''` 得到
  「未知参数：」冒号后一片空白，退出码 2 的全部价值（「改哪里」）丢失。八处统一改走
  `describeArgs`。

- **`sync run` 的 `tasks[].gaps` 图例用位置指代「后四个 reason」**。位置依赖 README 图例表的
  排列顺序，而那个顺序**没有任何守卫**（`tests/sync-enums.test.ts` 的双向核对用 `sort()`，
  重排表格照样绿）；更关键的是 Agent 读的是 run 输出、手里未必有那张表 ——「后四个」在它那里
  无法解析。改为从 `TASK_GAP_REASONS` **逐名渲染**（加了值也同步），README 同段一起改。

- **`tests/store-field-notes.test.ts` 的文件头与文件内断言互相矛盾**：头部注释写「`db tables`
  只列业务表、两边数量不同」，而下方用例 `expect(dbNames).toEqual(storeNames)` 早已证伪
  （实测两边都含内部表、都是同一组）。用例标题与注释一并改为实况。

  **变异验证**：本轮 11 处变异全部转红 —— `Binder|Catalog` 判据退回裸子串、`OOM` 判据退回
  裸子串、`duckDbSaysMissingName` 去掉 `^` 锚、判据模式不锚开头（列名伪装）、
  锁判据加回 ` by user ` 段（Linux 上退化成永不命中）、
  `driftFailureFor` 不再吃 `cause`、
  `db` / `stats` 的 `describeArgs` 退回裸 join（三处）、锁判据退回
  `msg.includes('Conflicting lock')`、图例退回「后四个」；每处先 `grep` 确认落地，
  跑完 `diff` 确认还原。

- **DuckDB 报文回声污染：用户数据与用户 SQL 能把错误伪装成「查询超时」或「沙箱拦截」**。
  DuckDB 的报文会带进外部文本：`Conversion Error` 回显**列值**，`Parser Error` 在
  `\nLINE n:` 之后回显出错行的 **SQL 原文**。原判据对整条 message 做子串搜索，于是：
  · 列值恰好含 `interrupt` 时（实测 `CAST(name AS INT)`，`name = 'interrupt'`），类型转换
    错误被报成 `query_timeout`，`--timeout 0`（不限时）下也照样报超时，真实线索整体丢失；
  · SQL 里恰好含特征句时（实测 `SELEC 'file system operations are disabled by configuration'`），
    语法错被报成「已被只读沙箱拦截」。
  **修法**：新增 `src/query/native-error.ts` 作为**唯一实现点**（`isInterrupt` /
  `isLayer2Blocked` / `withoutSqlEcho`）：先剥 SQL 回显，再要求类别前缀 `INTERRUPT Error:` /
  `Permission Error:` 锚在**开头**（只锚词不够：值恰为 `'INTERRUPT Error: Interrupted!'` 时
  Conversion Error 的头部就逐字含这串，实测）；layer2 还要求特征句 `- file system operations are disabled by configuration` 锚在**句尾**
  （报文头部的引号路径由用户给出，路径里含这句话也不能算数）
  （裸 `Permission Error: Cannot access file "…"` 是库文件的 OS 权限问题，不算拦截）。
  `sandbox.ts` 与 `query/errors.ts` 此前各写一份逐字相同的正则，现在都调它。
  诚实边界：类别前缀是 DuckDB 的书写惯例、不是可解析的结构；判据失配时退化方向是
  「真拦截被报成原生错误」，不会再把别的错误说成超时或拦截。
- **`store status` 遇到库里有未声明的表时整条命令失败（`未知表：stray_table`，退出码 2）**。
  `tables` 来自全库 `information_schema`，而逐表 `COUNT` 走 `store.count()`，它的
  `assertTable` 只认本 CLI 声明的表 —— 判据问的是「是不是声明表」，调用点要回答的却是
  「库里有几张表」。旧版 CLI 或其它工具建过表的库因此根本看不了状态。
  现在 `store status` / `store init` 的 `tables` 只列声明表（与 `db tables` 同一组，两边
  数量在双向漂移下实测一致：都是 24），未声明表在 `meta.warnings` 中点名。
  README 与 `field_notes.tables` 的「两边数量应当一致」此前只解释了「缺表」一个方向，
  会把 Agent 引向「库不完整 → 重建」，而重建会**销毁**那些未声明表；两处都改为两个方向
  都解释，并明说数量不等时先读 `warnings`。
- **`TYPE_NAMES[21]` 写成 `INSTALL`，驱动枚举里 21 是 `LOAD`**。`LOAD json` 被拒时报
  「不接受 INSTALL 语句」，点名的语句与用户写的不符。整张表改为按 `@duckdb/node-api` 的
  `StatementType` 逐值抄写（顺带补上此前落裸数字的 6/8/12/18/26），新增逐值对拍守卫
  `tests/query/statement-type-names.test.ts`。
- **skill 正文 `errors.md` 仍教「结束边界不得晚于今天零点」**。`不得晚于` 是 ≤，把实测不稳定
  的边界值 `endTime = 今天 0:00` 划进了安全区；设计稿与 `core/errors.ts` 的 hint 早已改成
  「早于」，Agent 真正读的 skill 正文漏改。已改并加守卫。
- **只读库前置检查的三份副本收敛到 `src/commands/store-precheck.ts`**。`db` / `sync` / `store`
  各自维护一份 `statGuard`（不存在 / 权限 / 非普通文件）与 `schema_version` 缺表探测，
  `store init` 还把命名管道、设备等特殊文件一律报成「是目录」（`!isFile()` 覆盖四种成因，
  文案只写了一种）。现在七个读命令对目录 / FIFO / 字符设备 / 父目录 `chmod 000` / 不存在 /
  空库 / 他人库给出逐字相同的 hint，特殊文件报「不是普通文件」。
- **三条恒真的漂移守卫**（独立审查发现）：`tests/docs.test.ts` 的「补全承诺限定末残段」反锚
  用的锚句 `由下轮日对齐` 已不在正文里，循环零次迭代；`tests/commands/command-tree.test.ts`
  的「first 只许在第一槽位」在真实树上零次迭代（没有命令有两个槽位）；README tables 形态
  断言的备选正则 `/name.*rows/` 会撞上无关段落，删掉被守卫的原句仍绿。三条都改为先证明
  锚存在（或判据先在合成输入上双向自检）再断言。

  **变异验证**：本轮 16 处变异全部转红 —— 裸 `INTERRUPT` 判、`INTERRUPT Error` 不锚开头、
  layer2 特征句不锚句尾、`store init` 去掉未声明表过滤、`status` 错误过滤成只剩一张表、
  `isInterrupt` 与 `isLayer2Blocked` 各自不剥回显、`errors.ts` 裸特征句判、
  `TYPE_NAMES[21]` 退回 `INSTALL`、`store status` 去掉未声明表过滤、skill 正文退回
  「不得晚于」、`sync-run.ts` 复制回一份空库 hint、锚句措辞漂移、去掉「末残段」限定、
  删掉 tables 形态句、给第二槽位标 `first`；
  每处先 `grep` 确认改动落地，跑完逐文件 `diff` 确认还原。

- **同一起因、两个命令族、两种说法：「打开库文件失败」的解码规则收敛到单一实现点**。
  上一轮修掉 `thrownToExit` 的死分支后，`--db` 指向同一个 `chmod 000` 的文件时，
  七个命令给出的 hint 仍然**互相矛盾**：`store status` / `sync status` / `sync install`
  说「请检查路径与所在目录的读写权限」，而 `db tables` / `query` / `stats fields` /
  `db describe` 说「请确认数据库文件存在且由本 CLI 创建（`qiyu store init …`）」
  —— 后者对权限问题**必然再失败**（文件就在那儿，`store init` 也打不开它）。
  根因是同一份判据被复制到三处：`commands/store.ts`、`query/sandbox.ts`、
  `commands/sync-run.ts` 各写各的正则、各配各的文案。
  这是本仓库记录过的形态「同一份解码规则复制到多处 → 同一输入两个结论」的又一实例
  （前科：`nonEmptyValue` 的空串判据收敛、profile 名解析）。

  **修法**：新增 `src/store/retry.ts` 的 `classifyOpenFailure(e): OpenFailure | null`
  作为**唯一实现点**（`{ cause: 'not_duckdb' } | { cause: 'permission' }`），
  连同两份 hint 文案常量 `NOT_DUCKDB_HINT` / `PERMISSION_HINT` 一并收在那里；
  三处调用点改为消费分类结果，删掉各自的正则与文案。放 `store/retry.ts` 是因为
  query 层有 import 白名单（查询接口与沙箱 spec），而该文件是纯函数、已在白名单内
  —— 收敛不需要放宽分层约束。

  **`isModuleNotFound` 只认 ESM 错误码，平台 binding 缺失的生产路径从不命中**（同一轮发现）。
  原判据要求 `e.code === 'ERR_MODULE_NOT_FOUND'`，而该码只在 **ESM 解析**阶段出现，
  能命中它的 specifier 恒是 `@duckdb/node-api` 本身（整个包不装时）。
  **平台子包缺失**是另一条路径：`@duckdb/node-bindings` 内部走 **CJS `require`**
  （`require('@duckdb/node-bindings-<平台>/duckdb.node')`），抛出的 `e.code` 是
  **`MODULE_NOT_FOUND`**（无 `ERR_` 前缀）。实测（删掉平台包后真跑）：
  `code = "MODULE_NOT_FOUND"`、`msg = "Cannot find module '@duckdb/node-bindings-darwin-x64/duckdb.node'"`。
  只认 ESM 码时这条一路返回 `null` → `depError` 的二分退化成单分支，
  **「当前平台无预编译包」那句 hint 在生产上从未被执行过**，Agent 拿到的是
  「未安装 DuckDB 依赖，请 `npm install @duckdb/node-api`」—— 而 `@duckdb/node-api`
  **本来就装着**（缺的是它的平台子包），照 hint 重装修不好。这正是该分支存在的唯一理由
  （`optionalDependency` 在不支持的平台漏装）。判据改为同时接受两种码，
  报文两种形态都覆盖（ESM `Cannot find package '…'` / CJS `Cannot find module '…'`）。

  测试：`tests/store/retry.test.ts` 新增 `classifyOpenFailure` 四条（含双向近似命中：
  路径含该措辞但真因是权限 → `permission`；路径含该措辞但真因是别的 → `null`）；
  `tests/store/errors.test.ts` 的 `isModuleNotFound` 夹具换成**真实形态**
  （`code: 'MODULE_NOT_FOUND'` + `Cannot find module '@duckdb/node-bindings-<平台>/duckdb.node'`）
  并补反向自检（缺 `@duckdb/node-api` 本身时**不得**给平台 hint）；
  `tests/store-hint-selection.test.ts` 与 `tests/commands/query.test.ts` 的断言改为统一文案
  并加反向检查（非 DuckDB 文件的 hint **不得**再引导向 `store init` —— 那是死路）；
  新增 `tests/open-failure-single-source.test.ts` 漂移守卫（扫描器 + 扫描器自身的双向自检：
  三条真实事故原文必红、调用点与 Node `fs` errno 判据必放过、注释里的反例不算违规）。
  ⚠️ 另设**禁用形态**一档（CodeRabbit 2026-10-31 两轮指出）：单靠「复制的判据」指纹抓不到
  事故 1 —— 旧判据的文本是 `EACCES: …`（Node `fs` 形态），不在指纹里，于是
  「把死分支写回去」会让守卫保持绿。禁用形态按**判据**钉：errno 名只许出现在属性比较
  （`.code === 'EACCES'`）或集合成员判定（`['EACCES', …].includes(code)`）里，
  于是禁两类 —— ① 把 errno 名当正则文本做择一（`/^(EACCES|EPERM|EROFS)/`）；
  ② 把 errno 名当报文文本去挑（`msg.startsWith('EACCES')` / `msg.includes('EACCES')`，
  即 errno 字面量出现在字符串检查方法的**实参位**，round 2 抓到 round 1 的守卫漏了这一类）。
  自检里三条合法 `fs` errno 分流都钉住了、不被误伤。
  ⚠️ 边界如实记录：两条指纹都是**文本**匹配，抓不到「先切片再比相等」的间接形态 ——
  但 DuckDB 报文里**根本不含 errno 名**（只有 strerror 文本），那种写法不可能是从真实报文抄来的。
  **变异验证 13 处**：`sync-run.ts` 判据退回自写子串 → 守卫红；把权限判据复制进
  `src/commands/db.ts` → 守卫红且点名该行；`MODULE_NOT_FOUND` 不接受 → 3 条红；
  只匹配 `package` 不匹配 `module` → 2 条红；去掉 `$` 句尾锚 → 2 条红；
  非 DuckDB 判据放宽锚定 → 1 条红；杀掉权限分支 → 5 条红；
  把旧前缀判据写回 `commands/store.ts` → 禁用形态守卫红；
  把旧前缀判据塞进唯一实现点自己 → 同一条红且点名 `retry.ts`；
  把 `startsWith('EACCES')` 变体写进 `commands/db.ts` → 第 ② 条指纹红并点名该行；
  改坏写锁 hint 断言 → 报 `StringMatching /写锁XXXX/`（而不是伪装成「锁落盘竞态超预期」）。

- **`store` 的权限错误归因是死的：真实 EACCES 拿到「数据库执行期错误」的 hint**。
  `src/commands/store.ts` 的 `thrownToExit` 有一条按 errno 分流权限错误的分支（R 组 R6），
  判据写作 `/^(EACCES|EPERM|EROFS)/` —— 那是 **Node `fs` 的报文形态**
  （`EACCES: permission denied, open '…'`）。但 store 链路**零 `node:fs`**：
  `lstat`/`stat`/`mkdir` 的 errno 分流都在命令层就地完成，到达 `thrownToExit` 的只有
  **DuckDB 原生错误**，其报文是 `IO Error: Cannot open file "…": Permission denied`
  —— strerror 在**句尾**、`e.code` 为 `undefined`（探针 + DuckDB 二进制里的
  `Cannot open file "%s": %s` 模板双向确认）。**前缀锚定因此一个都匹配不上**：
  这条分支从写下起就没执行过，真实权限错误全部落进 `internal` 兜底，
  hint 把 Agent 指向「用 `qiyu store status` 检查数据库状态，或用 --db 指向其他数据库文件」
  —— 而真正要做的是改文件权限。**这是本仓库记录过的形态「错误里点名的成因全都到不了该分支」
  的又一实例**：分支存在、注释齐全、判据与真实报文形态不符，于是静默失效。
  判据改为匹配真实到达该函数的三种 strerror 文本
  （`Permission denied` / `Operation not permitted` / `Read-only file system`），
  并**锚在句尾**（`Cannot open file "…": <真因>` 是 DuckDB 固定模板）—— 只搜子串会被
  路径本身带这些词的文件误命中（`/tmp/Permission denied.db` 报 `No such file or
  directory` 会被判成权限错误）；hint 同时**改为读写中性**（原判据只覆盖 `EACCES`，
  文案是「路径写权限」—— 而 `status`/`query` 是只读命令，只读权限不足会被引导去跑 `store init`）。
  测试两条：一条逐字注入三种真实报文断言分流与文案（含「非权限错误仍归 internal」的对照，
  以及 CodeRabbit 指出的**近似命中**双向：路径含该词但真因不同 → `internal`；
  路径含该词且真因确是权限 → 仍归权限），
  一条端到端 `chmod 000` 走真 DuckDB（**修前必红**：`kind` 是 `internal`）；
  root/Windows 下 `chmod` 不拦读写，端到端那条按仓内既有惯例早退。
- **撞锁用例的 `catch` 把断言失败说成平台竞态**（`tests/store/duckdb.test.ts` 读/写两条）。
  跨进程持真锁 + 换路径重试 ≤5 轮的用例里，断言写成 `expect(...).rejects.toMatchObject(...)`
  并整段包在 `catch { /* 锁竞态窗口，换轮重来 */ }` —— 于是「锁真的生效但断言写错」
  （kind 改名、hint 改文案）与「锁没落盘」**落进同一个 catch**，重试耗尽后只报
  「5 轮内未取得…锁落盘竞态超预期」：**归因指错了方向**，红的是断言、报出来的是平台。
  改为显式分类：打开成功 = 竞态（换轮）、抛 `store_locked` = 走断言（错了直接红）、
  抛其他 = 被测代码 bug（也直接红）。变异验证：把写者用例的 hint 期望改成不可能的正则，
  现在红在 `AssertionError: … to match object … "hint": StringMatching /写锁XXXXXXXX/`，
  修前只会报「锁落盘竞态超预期」。
  （同批挂账的第三条「`status` 路径 TOCTOU 双 `statSync`」核实**已在 b252ffd 修掉**，
  本轮不再改动；仅此项从「低优先过程项」升为缺陷，因为探针显示判据本身失效。）
- **只读接口实测收口（20 个）：A6 的 `verified:false` 从「全都未实测」变成「逐个如实登记」**。
  用真实凭证对 20 个未实测的只读接口逐个采样（`ticket.log` / `ticket.new.detail` /
  `ticket.list` / `chat.queue.group.query` / `ipcc.calltaskdetail.get` /
  `ipcc.customfield.template.get` / `robot.session.commonQuestions` /
  `robot.session.msgPredict` / `event.queryQueueStatus` / `merchant.{list,query}` /
  `ipcc.calltask.get` / `robot.session.chat` / 7 个 `icoutcall.*`），把结果写进注册表：
  8 个走通了成功路径 → `verified:true` + 实测 `envelope`（`ticket.log`/`ticket.new.detail`/
  `ipcc.calltaskdetail.get`/`robot.session.commonQuestions`/`robot.session.msgPredict` →
  形状 A；`ticket.list` → 形状 C；`chat.queue.group.query` 与 `ipcc.customfield.template.get`
  实测确认形状**不在 A/B/C/D 里**（载荷在 `staffInfo` / 裸数组），以 `envelope:null` +
  `verified:true` 登记，note 逐条点明「null 不表示未实测」）；其余 12 个保持
  `verified:false`，note 如实记录实测到的错误（`icoutcall.*` ×7 → `14500 Service Offline`，
  且同模块 `icoutcall.history.seat` 实测可用，证明离线是按子服务判定；`merchant.*` → `8002`
  需平台版 appKey；`ipcc.calltask.get` → `8012` 需真实任务 id；`robot.session.chat` → `14004`
  `msg` 须传对象——该接口是写行为、不继续采样；`event.queryQueueStatus` → `14007` 需排队中 uid）。

  实测同时修正两处**文档与实测不符**的旧断言：
  · `ticket.list` 的 `staffId` 非法时返回 **`code:14100`** + 纯文本 `Bad holder staff id`，
    不是「形状 C 的错误也都返回 code:200」—— 该量词已从 `src/core/envelope.ts` 的注释收回
    （设计稿 §9.0 的同源表述随文档一致性一并回写）；
  · `ticket.log` / `ticket.new.detail` 实测成功信封是 `{code,data}`（**无 message**）。

  新增可重复采样器 `scripts/registry/sample.mjs`：凭据只从 env 读、签名复用
  `dist/core/sign.js`（单一实现点）、输出只含结构不含值、**只读白名单默认拒绝**
  （`dangerous:false` 不等于只读 —— `robot.session.chat` 就是反例），22 条护栏 +
  8 处变异验证（白名单失效 / 黑名单拼错 id / 非 JSON 分支贴正文 / 键不脱敏 /
  数组长度丢失 / 口径注释漂移 / 凭证走 argv / CI 误入）。

  CodeRabbit 三轮复审补出五条，都已处理：
  ① 非 JSON 分支自称「只报类别」却打印 `text.slice(0, 20)` —— 前 20 个字符**就是正文**，
     破了它自己声明的约束，且这一支当时没有任何用例；改为 `describeNonJson` 只报
     状态码/Content-Type/长度/是否 HTML，哨兵放在正文**最开头**（放在第 20 位之后，
     `slice(0,20)` 的回归照样能通过，那条用例就只是看着像在守）。
  ② `dangerous:false` 被当成只读放行 —— 改用显式 `READ_ONLY_IDS` 白名单，
     默认拒绝，加接口必须有人写下"它是只读的"。
  ③ 业务值可能出现在**键**上而不只在值上（`follower`/`customField` 形如
     `{5000004:"张三"}`，键是员工 id）—— `describeShape` 现在把不匹配
     `[A-Za-z_][A-Za-z0-9_]{0,39}` 的键折成 `<redacted-keys>` 计数。
  ④ 数组长度丢失，1 条与 8 条在元素形状相同时输出完全一样，无法支撑任何计数观测 ——
     改为 `{array: 长度, element: 形状}`；空数组只报 `{array:'empty'}`，不多带一个
     什么都没说的 `element: 'undefined'`。
  ⑤ ASCII 人名当键挡不住（`{AliceSmith:'x'}` 会原样打印）—— **不扩正则硬堵**
     （那要靠「已知字段名」白名单，会让采样器失去发现新字段的能力），改为把口径
     收窄：保证「不含**值**」，并写明「键名会上屏，别整段当可公开样本贴出去」；
     用例同时钉住行为与这句口径，防止它悄悄漂回「不含任何标识信息」。

- **只读诊断 hint 不带存储选择：照做会去读默认库，Agent 据此断定「表真的不存在」（#45 边界 ②）**。
  2026-10-30 补全与上一条同族的另一半：上一条只修了**恢复**命令（`store init` / `sync run`），
  而**只读诊断**命令（`db tables` / `db describe` / `sync status` / `query --table` / `query --sql`）
  同样会打偏库 —— 读错库与写错库一样误导。例：`query --table sessions --db <非默认库>` 报
  「未知表」时，裸 `qiyu db tables` 列的是默认库的表，Agent 会得出「这张表真的不存在」的结论。
  修法：`src/output.ts` 新增 `StoreLocation` 与六个渲染器（`storeLocationFlags` /
  `dbTablesCommand` / `dbDescribeCommand` / `syncStatusCommand` / `queryTableCommand` /
  `querySqlCommand`），参数统一走 `shellArg`（含 win32 的 PowerShell 方言）；定位由
  `storeLocationOf(已解析路径, 档名)` 或 `storeLocationFromFlags(原始 flag)` 构造。
  线程到 7 个文件：`query/errors.ts`（未知表/未知列/漂移守卫）、`query/mask.ts`（漂移列与
  `--sql` 缺口警告）、`query/table-query.ts`（敏感列分组）、`query/sandbox.ts`（打开失败的
  store init）、`commands/{query,db,stats}.ts`（0 行/截断/iso-day/脏时间值/坏 payload/闭集校验）。
  漂移守卫：`tests/store-hint-selection.test.ts` 新增 `BARE_DIAG_HINT`（闭合形态 + 字面量在命令名处
  截断的拼接形态），豁免仅两处且各有可证伪理由（`output.ts` 是唯一实现点；`api call` 不吃
  `--db`/`--profile`，并有「api 一吃上存储 flag 就变红」的自检）。
  行为覆盖 15 个用例（真 DuckDB）：未知表/未知列/敏感分组/0 行（两通道）/脱敏建议/iso-day/
  截断/闭集校验三命令/漂移列/sandbox 打开失败/脏时间值/坏 payload。
  CodeRabbit 复审另补一条 minor（已修复）：`querySqlCommand` 最初渲染成
  `qiyu query --sql --db <path>` —— `--db` 落在 `--sql` 的**值位**上，而 `query` 的
  值位守卫把「取值恰好是已知 flag」判为缺值，逐字执行报「--sql 缺少取值」退出 2。
  **hint 里的命令必须真的能跑**，所以改为 `qiyu query --sql '<SQL>' --db <path>`
  （占位符加引号：SQL 含空格，`--sql SELECT 1` 会被 shell 拆成两个参数）；
  并新增「渲染出的诊断命令占位符替换后逐条真的执行」用例（含 `--no-mask` 形态），
  把「带上了 --db」与「命令可执行」两件事分开守。
  第二轮复审再补一条 major（已修复）：占位符在**引号里**，用户若只替换引号内的词而
  保留引号，SQL 自带单引号会提前闭合 —— `--sql 'SELECT '2026-10-01''` 经 shell 解析后
  变成 `SELECT 2026-10-01`（DuckDB 算成 2015，**静默给错结果**）。新增
  `SQL_ARG_REPLACE_NOTE`（「整段替换成按你的 shell 规则转义好的 SQL」）并接到三处
  `--sql` hint；加「凡渲染 `querySqlCommand` 的文件必须同时带上该契约」的漂移守卫
  （剥掉 import 行再判，否则单靠 import 就假绿 —— 实测过），可执行性用例改用
  **带单引号的 SQL** + `shellArg` 整段替换来复现原失败形态。
  变异验证 13 处（`storeLocationFlags` 恒空、逐点丢 `loc`、闭集校验丢原始 flag、
  `querySqlCommand` 退回无值位、源码重新引入裸形态），对应用例均红（逐条 grep 确认改动真落地）。

- **反向图例覆盖不完整（#38 挂账）：`stats fields` 的 `table`/`sentinel` 与 `query` 的 data 字段无释义，`api schema` 无「输出 ⊆ 图例」方向**。
  2026-10-30 补齐三处：
  ① `statsFieldNotes()` 新增 `table`（回显输入、不是「库里有哪张表」的依据）与 `sentinel`
  （`-1` 是「没有数据」的哨兵、**不是负值或负数比率**）；`tests/stats-field-notes.test.ts`
  的 `TOP_KEYS` 补这两项，并加「每个顶层键都必须有释义」的反向断言（此前只查「图例 ⊆ 输出」）。
  ② `query` 补「data 只应有自明的 `columns`/`rows`」反向守卫（此前只覆盖 meta 9 键）。
  ③ `command-legends-complete.test.ts` 新增 `api schema` 真实输出的反向守卫：`id`/`title`/`method`
  自明，其余字段必须有释义（`params` 靠 `params[].auto`）。
  变异验证：`sentinel` 图例键改名 / 去掉 `api schema` 的 `path` 图例 / 往 `query` 的 data 塞未释义
  字段，对应用例均红（逐条 grep 确认改动真落地）。

- **README「尚未实现」清单的测试是假护栏；`auth` 字段可能与「无条件签名」矛盾；README 横幅陈旧**。
  2026-10-30 审计三处：
  ① `tests/docs.test.ts` 两条用例把 README 的「尚未实现」段切出来再 `.not.toMatch(...)`，
  但六个子项目交付后该段已删 → `?? ''` 让切片恒为空串、断言**恒真**（假护栏：声称守
  「已交付命令不得列为未实现」，实际什么都没守）。`tests/readme.test.ts` 同款：
  `slice(indexOf('**已实现**'), indexOf('**尚未实现**'))` 在段缺失后 end=-1 退化成"到末尾"，
  下一步 `slice(indexOf('**尚未实现**'))` = `slice(-1)` 只查最后一个字符。
  修法：抽取器段缺失时返回 `null`（区分"无段"与"空段"），断言按段存在与否二选一
  （无段 = 全部交付；有段 = 其中不得含已交付命令），并加**双向自检**（事故文本必红、
  合法文本放过）；readme.test.ts 改为按小节标题切片 + 全文否定旧 bullet。
  ② 注册表 7 条 `auth:"none"` 与 9 条 `auth:"eventType"` 全是 `callable:false`，而
  `call()` 对所有出站请求**无条件签名**、不读 `auth`。加加载期不变量
  `callable ⇒ auth === 'checksum'`：将来接入免签名出站接口时加载期立刻炸，逼开发者先给
  `call()` 补不签名分支，而不是带着「声明不用签名、实际照签」的矛盾上线。
  刻意**不**加当前不可达的死签名分支（等价变异）。
  ③ README 横幅「本仓库仍在早期：仅实现认证 + 参数校验 + 存储基础」与「当前状态」段的
  「前六个子项目已交付」自相矛盾，改为如实陈述已交付的六个子项目。
  变异验证：禁用不变量 / 抽取器恒 null / 往 README 塞回事故段 / 横幅塞回「仍在早期」，
  对应用例均红（逐条已用 grep 确认改动真落地）。

- **恢复命令的 hint 不带存储选择：照做会在默认库上建库/同步，原问题原样保留**。
  2026-10-30 真库实测：`db describe tickets --db <空库>` 的 hint 是「请先运行：
  qiyu store init」—— 逐字执行会在 `~/.qiyu/duckdb/qiyu.duckdb` 建出**默认库**，
  原命令重跑仍报同一句（死循环）；`sync install --db <未同步库>` 的 hint
  「请先运行：qiyu sync run」同理：同步的是默认库，install 仍报 `sync_not_run`。
  这与上一条 CodeRabbit 指出的 `MISSING_TABLE_CAUSES` 是同一缺陷族 —— 上一条只修了
  `db describe` 路径的文案，其余出口仍是裸命令。
  涉及 12 处出口：`store init` 七处（db 的 statGuard/openGuardedSession、sync 的
  statGuard/openRo、store status 两处、sync run 的 storeInitFail）、`sync run` 建议五处
  （query/stats 空表警告、sync verify 的 not_synced 与 state_pending、sync install 前置探测），
  以及 `missingTableCauses` 的四处。CodeRabbit 复审另补两条 major（均已修复）：
  ① `sync run` 还从**解析出的档**读 `store.options.knowledgeRobotIds` 与
  `profiles.<name>.robots`（robotId 注入面），只回显 `--db` 会让知识库任务用错 robot 集合
  ——（真库实测：带 `--profile alpha` 解析出 `[1000001]`，不带则空）故
  `resolveStoreConfig` 新增 `profileFlag`（仅**有显式来源**的档名；内置 default 不回显，
  否则显式 `--profile default` 会触发「点名档必须存在」守卫），`syncRunCommand` 与
  `missingTableCauses` 回显它；`store init` 不读 options/robots，故不回显。
  ② 路径/档名按 POSIX shell 语义引号化（Python `shlex.quote` 同一安全集）：未引号的
  `--db /tmp/x; touch /tmp/marker; #` 被 Agent 复制进 shell 会真的执行 `touch`。
  单引号包裹；安全集内裸渲染保持可读。第三轮复审（major）再修正：引号方言必须按平台
  区分 —— **PowerShell 的反斜杠不是转义符**，POSIX 的 `'\''` 写法会提前闭合引号、
  让载荷里的 `; touch …` 真的执行（pwsh 实测复现：argc=3 且注入执行）；win32 改用
  PowerShell 方言（内嵌 `'` 翻倍为 `''`，实测 argc=1、字面完整、未执行）。
  win32 的 hint 面向 PowerShell；cmd.exe 不识别单引号，不要原样粘贴（边界如实记录）。
  修法：`output.ts` 新增 `storeInitCommand(path)` / `syncRunCommand(path)` 唯一实现，
  一律渲染成带**本次解析出的绝对路径**的 `--db <path>` —— `--db` 优先级高于环境变量与
  配置文件、绝对路径不受工作目录影响，任何来源的存储选择都能被精确复现；
  `MISSING_TABLE_CAUSES` 常量同步改为 `missingTableCauses(path)` 函数。
  ⚠️ 边界（如实记录）：① `sync run` 的 storeInitFail 缺省分支在当前错误源下**不可达**
  （duckdb 的 `store_not_initialized` 都带 hint，其余失败落到「不是 DuckDB 文件」分支）——
  给它带路径是防御性的，变异只有静态守卫会红；② 只读诊断提示（`qiyu db tables` /
  `qiyu db describe` / `qiyu query --sql`）仍是无选择的裸命令（多在 query/ 纯层产生、
  拿不到存储位置），跟随错误选择**读**错库同样误导，留待后续单独处理。
  测试：新增 `tests/store-hint-selection.test.ts` —— 空库六出口 / 缺库 / 空表 /
  verify 的 not_synced 与 state_pending / install / 含空白与 `;` 注入载荷的路径 /
  `--profile alpha` 回显与「内置 default 不回显」/ win32 方言共 8 条真库用例（空库与
  缺库端到端验证「照 hint 做 → 原命令收敛、默认库不被创建」），加静态漂移守卫
  （裸恢复命令 hint 指纹 + 自检：5 条事故原文必红、4 条修复形态放过）。变异 14 条：
  13 条红，1 条（storeInitFail 缺省分支）如实记录为行为层不可达、仅静态守卫红。

- **`db describe` 缺表时给的成因是错的：`表 X 在库中不存在（未同步或未建库）`——
  两个成因都到不了这个分支**。2026-10-29 真库实测：
  ① 「未同步」不产生缺表 —— `store init` 的迁移一次建全部 25 张声明表，从未同步过的库
  表数仍是 25、`db describe tickets` 给出 `row_count: 0` 且无缺表警告（`sync run` 自身
  也先调 `store.init()`）；② 「未建库」在这个分支之前就被拦下 —— 库文件不存在或零表时
  `openGuardedSession` 早已返回 `store_not_initialized`（退出码 1，hint 指 `store init`）。
  Agent 照这句话会去「先同步一次」，而对被删的表那只会撞 `Catalog Error: Table with name
  tickets does not exist!`——`store init` 也只重放 `version > MAX(version)` 的迁移，
  已迁移库上 DROP 掉的表返回 ok 却仍然缺（实测）。
  同一份事实的另外三个出口（`db tables` 的 warning、`query --table` 与 `stats fields` 的
  hint）早就写对了两条真实成因与对策，只有 `db describe` 分叉——正是本仓库一直在消除的
  「同一规则多处拷贝」。
  修法：两句话提取为 `src/query/errors.ts` 的 `MISSING_TABLE_CAUSES`（唯一实现），
  四个出口共用；`db describe` 的文案改为「声明有而库中无 …… （row_count/time_range
  无法得知，置 null）」+ 该共享成因（旧措辞不得复活，因为它指向一个不存在的动作）。
  CodeRabbit 复审（major）补正：「重建库」是**破坏性**动作——库中可能有未声明表与
  超出 API 回补窗口的本地历史，删除后重建 + 重新同步都拿不回来，故文案改为
  「先备份库文件，再删除并重新 `qiyu store init`、重新同步」，并注明删除前先确认；
  恢复命令还必须带**与本次相同的 `--db/--profile/--backend` 选择**——hint 会出现在
  `query --table --db <自定义路径>` 的输出里，只说「运行 qiyu store init」会让 Agent
  初始化默认库，选中的库依然缺失（同轮第二条 major）。
  测试：新增 `tests/missing-table-causes.test.ts`——行为层在真 DuckDB 上删表，断言四个
  出口逐字共用同一份成因、都不得出现「未同步」、都给出「store init 不会重建」
  「需重建库」「先备份库文件」与「与本次相同的 --db」；另有「从未同步的库无缺表
  警告」的正面用例；漂移层静态扫描 `src/`（注释除外），成因字符串只许出现在
  `errors.ts`，附自检用例防止守卫退化成恒真。`tests/commands/db.test.ts` 的 R5 用例
  补钉共享文案与两条对策。
  变异 5 条红（改回假成因 / stats 内联拷贝 / 把「不会重建」改成「会重建」/ 删掉
  「先备份库文件」/ 删掉「与本次相同的 --db」），无等价变异。

- **`sync run --since ''` / `--until ''` 被静默当成「没给区间」，`--full --since ''`
  因此绕过互斥守卫跑了一次全量重刷**。2026-10-29 真库实测：判据此前是**真值**
  （`flags['--since'] || flags['--until']`），而 `''` 是假值 —— 于是显式给出的空白取值
  整个消失：
  ① `sync run --full --since ''` 拿到一次全量重刷、退出码 0（而 `--full --since 30d`
  是用法错误「互斥」）—— 用户以为「同传会报错」，实际跑了最贵的那个分支；
  ② 单独 `--since ''` 落进水位续跑，与不带这个 flag 逐字相同；
  ③ 同一个输入 `query --table X --since ''` 一直是 usage（`--since 无法解析：''`）——
  两个命令对同一份参数给出相反结论。
  修法：空白取值（`''` 与纯空白）是**用法错误**、不是「未设置」（README 的空串口径
  管的是 **env**；**显式 flag** 的空白取值是用法错误，与 `--db ''` / `--profile ''`
  同一条规则）。取值一律用 `describeArgs` 渲染（`''` / `'   '`），否则消息是
  「无法解析：。」冒号后空白。互斥/分支判据同步改用存在性（`!== undefined`）——
  **如实记录：改回真值全部用例仍绿（等价变异）**，保留存在性写法是防御性的，防止
  日后挪走空值守卫又分叉出静默分支。
  同轮三处相邻缺口（同一族：空白取值渲染成隐形 / 参数错误被环境错误遮住）：
  `sync run` 与 `sync status` 的 `未知任务：` 用 `describeArgs` 渲染任务名
  （`sync run ''` 此前冒号后空白）；`sync install --schedule ''` 的 cron 错误消息
  同样渲染取值；`sync install` 的 cron 解析**前移到存储前置探测之前** —— 未同步过的库上
  `--schedule '不是 cron'` 此前报 `sync_not_run`（退出码 1，「先去跑一次同步」），
  Agent 会照 hint 白跑一轮全量同步才看到真正的参数错误（query 的 `--table` 早已是
  「闭集校验先于一切 I/O」）。
  测试：`tests/commands/sync.test.ts` 三例（空/空白 `--since`/`--until` 四个组合逐一断言
  usage + 可见渲染 + `--full` 不再绕过；非空合法取值回归护栏；空白任务名 `run`/`status`
  两命令 + 两取值；cron 前置校验在未同步库上先报参数错误、合法 cron 不被误伤）；
  `tests/sync/install.test.ts` 补 `parseCron('')` 的可见渲染；`tests/docs.test.ts`
  钉住 README 的三条实质主张。变异 8 条红 / 2 条如实记录为等价变异（M15/M16）。
  全量 4 分片 2107 用例全绿。

- **空串存储环境变量：`QIYU_DB_PATH=` 让配好的 `store.path` 失效，且报错谎称它也是空的**。
  2026-10-29 真库实测：配置文件里 `store.path` 明明有值，`export QIYU_DB_PATH=`（变量没填的
  典型形态）时 `store`/`db`/`query`/`sync` 一律以退出码 2 失败，文案是
  「数据库路径不能为空（--db / QIYU_DB_PATH / store.path 均为空）」—— 三层一起指控，
  而真正空的只有环境变量那一层；同一个库把变量去掉就工作正常。`QIYU_STORE_BACKEND=`
  同理：`??` 链把 `''` 当有效值放行，遮蔽配置文件里的 `backend`，报「未知后端：。」
  （空值渲染成隐形）。修法：环境变量层的空串**一律视为未设置**（与 `QIYU_PROFILE=`、
  凭证侧的 `has()` 同一口径），照常回落到配置文件 / 内置默认；**显式** `--db ''` /
  `--backend ''` 仍是用法错误 —— 把用户明确给出的空值悄悄换成另一份资源是静默改道。
  报错文案改为点名**真正给了空白值的那一层**（`--db` / `QIYU_DB_PATH` / 配置键路径），
  空白值用 `JSON.stringify` 渲染成可见形态。顺带补上 `store.backend` 的类型守卫
  （配置写 `123` / `{}` 此前只得到「未知后端：[object Object]」，不点名键路径）。
  `sync install` 的 `storeArgsFor` 同步修：空串 `QIYU_DB_PATH` / `QIYU_STORE_BACKEND`
  不再把**回落后的**解析结果固化成 `--db`/`--backend` 烘进 plist/unit ——
  那等于把「安装当时读到的配置文件值」悄悄升级成显式 flag，之后改配置文件对已装的
  调度任务永远不生效。
  测试：`tests/store/config.test.ts` 五例（回落两个方向 / 空白串仍拒绝 / backend 类型守卫 /
  文案不再谎称三层都空）；`tests/commands/sync.test.ts` 新增调度固化用例（含非空 env
  仍照常固化的反向断言）；`tests/docs.test.ts` 钉住 README 的实质主张。变异 6 条全红
  （先确认变异已应用）。
  同轮把这条口径收敛成**唯一实现** `nonEmptyValue()`（`core/config.ts`）——
  `resolveProfileName` / `resolveStoreConfig` / `storeArgsFor` / `credentials-source` /
  `auth login` / `sync-run` 的 robots 兜底 / `skill` 的 `QIYU_SKILL_DIR` 七处共用它，
  不再各自手写 `x !== undefined && x !== ''`。新增静态漂移守卫
  `tests/empty-string-single-source.test.ts`：除定义处外，全仓不得对 `QIYU_*` 环境变量
  手写空串/存在判据（含「先存局部变量再判」的间接形态，那正是 PR #41 的原样事故）。
  守卫自检双向（三个真实事故的原样文本必须红、合法调用与注释必须放过）。

- **空串档名：写凭证的命令与读凭证的命令解出两个不同的 profile**。`auth whoami` 与
  `auth login` 各自用 `??` 链解析档名，而 `''` 不是 null/undefined、`??` 会把它放行。
  2026-10-29 真库实测两条后果：
  ① `"defaultProfile": ""`（JSON 里清空字段）时 `auth login` 把凭证写进 `profiles[""]`，
  而 `api call` / `store` / `sync` 按内置 `default` 读 —— `login` 与 `whoami` 都报
  `configured: true`，`api call` 却报「缺少 appKey」：**凭证写进了没人读的档**；
  ② `QIYU_PROFILE=`（变量没填的典型形态）时 `whoami` 选中空串档报 `auth_missing`，
  而 `api call` 照样从 `defaultProfile` 的档读到凭证并发出请求 —— 同一台机器上两个命令
  给出相反的「凭证有没有配」。
  修法：新增 `resolveProfileName()`（`core/config.ts`）作为档名的**唯一解析点**
  （`--profile` > `QIYU_PROFILE` > `defaultProfile` > 内置 `default`，空串一律视为未设置），
  四个调用点（`fileProfile` / `resolveStoreConfig` / `whoami` / `login`）共用它，
  不得再各自写 `??` 链。
  同轮两处相邻缺口：`whoami` 的 `profile` 字段此前**没有释义**（图例只有三个键），
  补上「这是本命令会去读的档名，不保证该档存在」—— env 拼错时 `whoami` 照样报
  `configured`，而**只要配置文件里已有其它档**，`store`/`db`/`sync`/`query` 对同一个
  名字就以退出码 2 拒绝（`profiles` 为空时它们按内置默认路径照常工作，不报错）；
  `robots` 的释义补上「空数组的第二种成因是该档根本不存在」。
  另修一处调度缺陷：`sync install` 把 `QIYU_PROFILE=` 固化成 `--profile <空>` 烘进
  plist/unit —— 安装期（dry-run 与 `--yes`）一律成功，装完之后**每次调度执行**都因
  「--profile 不能为空」退出码 2 永久失败，且只在调度日志里可见。
  测试：`resolveProfileName` 三条单测；`tests/commands/auth.test.ts` 新增三例真库用例
  （whoami 与 `fileCredentials` 解出同一档 / login 不创建空档名 / 图例点破「档名不保证存在」）；
  `tests/commands/sync.test.ts` 新增调度固化用例；`tests/command-legends-complete.test.ts`
  补 `auth whoami` 的反向覆盖。变异 6 条全红（先确认变异已应用）。

- **`sync run` / `sync status` 的 `watermark` / `last_synced_at` 没有释义，而它们是 UTC `Z`
  形态、与同一行里的 `resolved_range`（`+08:00`）写法不同**。2026-10-28 真库实测：同一任务
  条目里 `watermark: "2025-10-09T08:53:20.000Z"` 与
  `resolved_range[1]: "2025-10-09T16:53:20+08:00"` 是**同一瞬间**，而字符串比较给出
  `"08:53…Z" < "16:53…+08:00"` —— 相反结论。Agent 拿它判「同步到哪了」会判错方向。
  同轮补齐的还有：`sync status` 的 `tasks[].task` / `tasks[].gaps_count`、
  `sync verify` 的 `tasks[].task` / `tasks[].local_rows`（后者的「当前行数」语义与
  run/status 都不同）、`sync tasks` 的 `tasks[].watermark.field`（同一字段在三个命令里
  形状不同：这里是 `{field, initial}` 对象，run/status 是字符串）。
  修法：`WATERMARK_NOTE` / `LAST_SYNCED_AT_NOTE` 两个常量由 run 与 status 共用（同一份
  `sync_state` 列，形态必然相同）。共用释义只点名 `resolved_range`（两个命令里都是
  `+08:00`）；`gaps[].range` 的形态**随命令不同**（run 格式化成 `+08:00`、status 原样回显
  epoch 毫秒字符串），由各命令自己的图例承担（CodeRabbit 2026-10-28）。
  同日真库实测又推翻了一处措辞：`last_synced_at` 早前被写成「失败轮不更新它」，但引擎在
  每个带水位写入的成功窗里就写它 —— 一轮里部分窗口失败（`status: partial`）时它照样已是
  末个成功窗的提交时刻。图例改为「按成功窗更新、不按轮」，只有整轮没有任何带水位写入的
  成功提交才保留上一轮的值。同轮还实测到第二层：断链后的成功窗仍刷新它、而水位冻结在
  连续成功末端，所以它**可能晚于水位实际前进的时刻**（推进时钟实测同一轮里相差数分钟）——
  图例与 README 都点破了这一条。
  测试：`tests/sync-state-legends.test.ts` 新增真库用例 —— 断言两种写法确实是同一时刻、
  断言字符串比较确实是错的（把图例的警告钉在实测事实而非措辞上），钉住 partial 轮的
  `last_synced_at` 确实被更新且取末个成功窗的时刻（推进时钟，同时断言它晚于水位）、
  两个命令的 `gaps[].range` 形态确实不同（run 侧走生产构造函数 `taskOut`、status 侧真跑
  命令），并钉住 run 与 status 的释义同源、`sync tasks` 的同名字段形状不同。
  本轮新增/改写的 8 条断言全部做过变异验证（共用释义加回 `gaps[].range` / 恢复
  「失败轮不更新」/ run 图例去掉跨命令警告 / README 恢复旧措辞 / status 图例改称
  `+08:00` / 图例与 README 分别去掉「晚于水位实际前进」/ run-status 侧 watermark 的
  可空性改回「是字符串」，逐一变红）。
  另有一处同源修正：`sync tasks` 的 `tasks[].watermark.field` 图例把 run/status 侧说成
  「是字符串」，而它**可以是 `null`**（从未成功推进）—— 改成「字符串或 null」。

- **`api schema` 的图例键 `auto` 指向一个不存在的顶层字段（真实字段在 `params[].auto`）**。
  2026-10-28 实测：`qiyu api schema ticket.search` 的 `data.auto` 是 `undefined`，
  而 `data.params[0].auto === true`。图例的键是**路径**：写成顶层裸名 = 指一个 Agent
  永远读不到的字段（同型缺陷：`sync status`/`sync verify` 漏 `tasks[].` 前缀、
  stats 的 `declared[].unit`）。同一条图例里其余键（`dangerous` / `callable` / `path` /
  `body_kind` …）都是 data 的顶层字段，只有 `auto` 混进了一个元素级字段。
  修法：键改成 `params[].auto`。
  测试：新增 `tests/api-legend-paths.test.ts` —— 真跑 `api schema` 三个接口，
  对每个非条件图例键做点路径解析（`x[]` 段要求数组里**任一元素**走得通）；
  条件键（`rate_limit` / `one_of`）由输出自身确认存在时才要求可解析。
  另反向钉住 `api list`：它的 `data` 是**根数组**，图例键只能是行字段名
  （逐行核对），唯一例外 `request_schema` 是「本 meta 不含参数表」的否定声明。
  变异 2 条全红（`auto` 改回裸名 / `dangerous` 改成元素级）。

- **`sync status` / `sync verify` 的图例键全是裸字段名，按图例路径在输出里什么也找不到**。
  2026-10-28 真库实测：这两个命令的 `data` 是 `{tasks:[…]}`，所有字段都挂在任务条目上；
  而 `statusFieldNotes()` / `verifyFieldNotes()` 给出的键是 `range_status` / `locked` /
  `gaps` / `gaps[].reason` / `gaps[].range` / `resolved_range` 与
  `state_windows_consistent` / `expected_from_api` / `drift[].kind` / `drift[].detail`
  —— **都不带 `tasks[].` 前缀**。图例的键是**路径**：路径写错 = 指一个 Agent 永远读不到的
  字段，等于没有图例（同型缺陷：stats 的 `declared[].unit`）。实证：`qiyu sync status`
  输出 `data` 的键集是 `['tasks']`，图例键 `range_status` 在 `data` 上解析为 `undefined`。
  旧护栏放过它的原因值得记下来 —— `tests/sync-state-legends.test.ts` 里有一条「只解释该输出
  里真实存在的字段」，但它比的是**手抄的字段清单**，清单镜像的是图例而不是真实输出，所以
  图例键写成裸字段名它照样绿。
  修法：键改成 `tasks[].x` / `tasks[].gaps[].reason` / `tasks[].drift[].kind` 等路径形态。
  测试：删掉那段手抄清单护栏，新增「status / verify 的图例键在真跑出来的输出上逐条可解析」
  —— 真库预置（`advanceWatermark` + `markPending` + `recordGap`）、真跑两个命令、对每个
  图例键做**点路径解析**（`x[]` 段要求该键是数组并对任一元素继续，因为缺口/漂移只挂在个别
  任务上）。变异 3 条（status 顶层键 / gaps 元素键 / verify drift 元素键改回裸名）全红。

- **`store --help` 声称「CLI 不会自动创建配置文件」，而 `auth login` 会创建它**。
  2026-10-28 实测：HOME 为空目录时 `auth login` 建出 `~/.config/qiyu/config.json`
  （目录 0700、文件 0600，只含 `credentials`），`store init` 确实不建（`config_exists: false`）。
  旧文案把「store 命令不写配置」说成了「CLI 不会创建文件」—— Agent 会据此认为该文件
  不可能存在、排查配置来源时直接跳过。新文案点明谁可能创建了它、创建出来的文件不含
  `store` 段。新增 `store --help` 文案用例，变异回退即红。

- **`skill check` 三种形态都没有图例，`violations[].rule` 是 10 值闭集**。
  2026-10-28 实测：
  · `violations[].rule`（`unknown_command` / `flag_before_subcommand` / `table_name` /
    `sql_sequence` … 共 10 个）是 Agent 要按值分支的机器值 ——「改命令行」与「改正文」
    是完全不同的修法，不解释只能猜。
  · `unverifiable` 不是违规、**不改变退出码**（详情另进 `meta.warnings`）。
  · compare 形态：`installed.present=false` 时 `installed.violations` /
    `installed.unverifiable` **不出现**；`differences` 非空时退出码必为 1。
  · 连带修一个真缺陷：compare 的「已安装目录不存在」分支**不设 `installed.error`**，
    present=false 的四种成因里唯独它没有机器可读原因（图例承诺「原因见 installed.error」
    就会是假话）。现在四种成因都有 `error`。
  修法：`skill.ts` 新增 `CHECK_RULE_NOTES`（`Record<ViolationRule, string>`，加规则不补
  释义即编译失败）+ `checkFieldNotes(mode)`（单基准 / compare 两套路径形态），接入
  `reportSingle` 与 compare 的 `ok()`。
  测试：新增 `tests/skill-check-field-notes.test.ts`（7 条，递归路径双向核对 + 行为学断言
  「unverifiable 不改变退出码」）。变异 7 条全红，其中 M6（图例键变成前导点
  `.violations[].line`）正是实现过程中真实犯过的错 —— 被测试的路径解析当场抓住。
- **`api call` 是最后一条没有图例的成功命令；README 还把它当成「只有 `{ok,data}`」的例子**。
  2026-10-28 实测：
  · `api call` **恒带 `meta.endpoint`**，而 README 原写「没有任何可报内容的成功输出就只有
    `{ok, data}` 两个键（如无提示时的 `api call`）」—— 字面与事实相反；全仓也没有任何
    命令真的输出无 `meta` 的成功信封（`ok()` 的条件键行为仍在，但当前无命令触发）。
  · `data` 是**上游载荷**（按信封形状取 `data` / `result` / `staffInfo`），不是 CLI 的
    契约 —— 不点破，Agent 会按 `qiyu db tables` 的形状去读 `ticket.search` 的返回。
  · `not_found` 只覆盖**结构性为空**（判据作用在解包后的 payload 上：`data` / `result`
    形状下是 `{}` / `[]`，或整条 200 响应没有载荷键；`staffInfo` 恒不置位）：业务为空
    （如 `ticket.search` 查到 0 条返回 `{total:0,tickets:[]}`）**不会置位** —— 没有
    `not_found` 不等于有数据。
  · `warnings` 没有软告警时不出现，`--no-validate` 时恒不出现；`note` 是注册表里的
    **静态说明**，不是本次调用的结果。
  修法：新增 `src/commands/api-notes.ts` 的 `callFieldNotes()`（六键），接入 `api call`；
  README 改为「`meta` 是条件键，当前每条成功命令都至少带 `meta`，读之前仍要先判存在」。
  测试：新增 `tests/api-call-field-notes.test.ts`（6 条，含信封 C 的 message-JSON 载荷与
  信封 B 的 result 形状）。变异 7 条全红。
- **`sync install` / `sync uninstall` 的四种输出都没有图例，且 `commands[].ok` 是三值**。
  2026-10-28 实测：
  · `commands[].ok` 是 `null`（dry-run 未执行）/ `true` / `false` 三值 —— Agent 按布尔值
    读会把「没执行」当成「失败」。`dry_run` 只描述**执行模式**、不回答「现在装没装」：
    install 的 dry-run 在已安装时照样只出计划，`uninstall --yes` 在从未安装时也是 `false`；
    真实安装即便某条调度命令失败（退出码 1），条目文件也已经写进去了。
  · `entries[]` / `remove[]` 是**对象数组**（`{path, content}` / `{path, exists}`），不是
    路径字符串；`remove[].exists` 是**计划生成那一刻的探测快照**，不是承诺。
  · `uninstall` 的 `absent` 是**条件键**：为空时整个键不出现 —— 不出现就是「没有这类路径」。
  · `uninstall --yes` 在从未安装时 `commands` 是空数组 —— 那是没有可停的调度器，不是
    执行失败；`notes` 会说原因。
  · 顺带修正一条自己写错的释义：`platform` 原写「其他平台直接报不支持」，而 **win32 是
    支持的**（schtasks），只有 darwin/linux/win32 之外的平台才报错。
  修法：`sync-notes.ts` 新增 `SYNC_INSTALL_MODES` + `syncInstallFieldNotes(mode)`，四个
  分支（install/uninstall × dry-run/--yes）各挂一份只解释**该输出里真实存在**的键。
  新增 `tests/sync-install-notes.test.ts`（11 条，含真实 DuckDB 与真实文件写入/删除）。
  测试的**反向兜底下沉到元素层**：只查顶层键时，同一数组里删掉一个元素键（还有别的键
  顶着）两个方向都查不到 —— 变异 M5 就是这么活下来的。变异 9 条全红。
  CodeRabbit 两条（核实成立并修）：① `absent` 原写「不出现 ≠ 没有这类路径」—— 省略规则
  恰恰是「为空即不出现」，说反了；② `dry_run` 原写「判断装没装看这个字段」—— 它只是执行
  模式，回答不了安装状态（见上）。
- **`sync uninstall --yes` 在 Windows 上什么都不做，还报告「未安装」（写图例时发现的真 bug）**。
  `syncUninstall` 用 `plan.remove.some(r => r.exists)` 当「装没装」的闸门，而 **win32 的
  `plan.remove` 恒为空**（Windows 的调度任务不是文件，是 schtasks 条目）—— 于是已安装的
  Windows 任务永远删不掉：`schtasks /Delete` 从不执行，输出 `commands: []` +
  `notes: ['未安装（无条目文件）…']`，退出码 0。darwin/linux 不受影响（有条目文件可探测）。
  修法：闸门改为 `anyInstalled || platform === 'win32'` —— win32 无法在卸载前探测，就让
  `schtasks /Delete` 本身回答（任务不存在时它报错，如实落进 `commands[].ok=false`、退出码 1）。
  新增 win32 用例（注入平台 + 断言 `schtasks /Delete` 真被执行），变异回退即红。
- **最后三处无图例的输出：`skill where` 的 `cli_contract_version`、`--version`、`auth login`**。
  2026-10-28 实测：
  · **`skill where` 输出 `cli_contract_version`，图例里却没有它** —— 既有图例测试只查了
    单向（图例里的键必须真实存在），反方向「输出里有字段、图例没解释」没人查，于是它
    一直裸奔。这个键恰恰是 SKILL.md 教 Agent 用的那个：`--version` 与
    `entity.installed` 报的是**两个不同的契约号**，不点名就会拿错。
  · `--version` 完全没有 `field_notes`：`skill_contract_version` 是 **CLI 自己**的契约号，
    不是已安装那份的（实测两者可以不等，且 `--version` 不报已安装那份）。
  · `auth login` 的 `source: 'file'` 是**本次写入目标**，不是「下次实际读取来源」——
    实测：login 报 `source: "file"`，而环境变量 `QIYU_APP_KEY` / `QIYU_APP_SECRET` 仍在时，
    下一次 `auth whoami` 报的是 `source: "env"`，login 写的文件只是兜底。
  修法：`whereFieldNotes()` 补 `cli_contract_version`；`cli.ts` 新增
  `versionFieldNotes()` 并挂到 `--version`；`auth login` 挂四个键的图例。
  README 的「无 meta 的成功输出」例子再收窄到 `api call`（无 warnings/note 时）。
  新增 `tests/command-legends-complete.test.ts`（3 条）做**反向兜底**：对每条有图例的
  命令跑真实输出，断言 data 里的每个字段都被图例覆盖（`k` / `k.` / `k[]` 三种前缀）
  或在自明清单里 —— 这正是 `cli_contract_version` 当初漏掉的那类检查。
  变异 8 条全红。CodeRabbit 两条（全部核实成立并修）：① `configured` 的释义推荐用
  `auth whoami` 验证有效性 —— 而 whoami 也只查「有没有配」，拼错的 appKey 同样返回
  true；改成「要验证只能发一次真实请求」。② `profile` 的释义说「缺省 default」——
  实际选择顺序是 `--profile` > `QIYU_PROFILE` > `defaultProfile` > `default`，
  只写 default 会把写入目标指错。两条各补变异验证。
  **第二轮一条（Minor）**：`--version` 的释义写「后者缺失或损坏时为 null」——
  而返回 null 的是**整个 `entity.installed`**，不是它下面的字段；Agent 照字面写
  `entity.installed.skill_contract_version === null` 会在 `entity.installed` 为 null 时崩。
  改成「先判 `entity.installed` 非 null 再读」。补变异验证。

- **`store init` / `store status` 无图例，且 README 把两者的 `tables` 形状说成同一个**。
  逐格真库实测（2026-10-28）：
  · **`schema_version` 是一个裸数字**，没有对照基准就没有意义 —— 它要跟当前 CLI 的
    `LATEST_VERSION` 比，才知道库是不是旧版建的（`store init` 只补建缺失的迁移，
    已应用的不会重放，所以它修不了「表被删」这类损坏）；
  · **`tables` 的形状随命令不同**：`store init` 给表名数组 `["a","b"]`，`store status`
    给 `[{name, rows}]`。而 README 原文写「`store init` 与 `store status` … 其中 `tables`
    是 `[{name, rows}]` 数组」—— 对 `init` 是假话，Agent 按 `tables[0].name` 取值会拿到
    `undefined`。本轮**不改行为**（有测试钉着 init 的字符串数组形状），改文档与图例；
  · `tables` 来自全库 `information_schema`，**含内部表** `schema_version` / `sync_state` /
    `sync_gaps`（`db tables` 列的是同一组表，两边数量应当一致）；
  · `config_exists: false` 不代表存储不可用 —— `--db` / 环境变量 / 默认路径照样工作，
    `store init` 也不写配置文件。
  修法：新增 `src/commands/store-notes.ts`，两个命令各挂一套 `meta.field_notes`；
  README 的 store 段改正 `tables` 形状并点明内部表与版本对照；README 里「无 meta 的成功
  输出」例子把 `store status` 换成 `auth login`（`store status` 现在恒带 `field_notes`）。
  新增 `tests/store-field-notes.test.ts`（9 条）：图例键集 ↔ data 键集双向、两个命令形状
  一致、无 `**`、无 `；`，外加真库用例（版本对照、两边同一组表、`config_exists: false`
  仍可用、`rows` 真实、两个命令的 `tables` 形状确实不同）。变异 8 条全红。
  过程里被测试抓住一处**我自己写错的「事实」**：我原以为 `db tables` 只列业务表、
  两边数量不同 —— 实际 `TABLES` 闭集里就含内部表，两边是同一组 25 张。图例与 README
  已按实测改正。

- **`db describe` / `db tables` 把「声明」与「实况」混在同一层输出里，字段名不区分**。
  逐格真库实测（2026-10-28）：
  · **`columns` / `pii_columns` / `time_column` 全是声明**（来自本 CLI 的表定义），
    表被删、列被删、多出列时**照旧原样输出**。实测：`DROP TABLE robot_summary` 后
    `db describe robot_summary` 仍给出 3 个声明列与 `time_column: {stat_date, iso-day}`，
    只有 `warnings` 说表不在库中；`ALTER TABLE … DROP COLUMN startTime` 后
    `time_column` 同样照旧输出。Agent 把 `columns` 当实况会得出「库里有这些列」。
  · **`row_count: null` 只有一个成因**（表不在库中），而 **`time_range: null` 有四种**
    （表没有声明时间列 / 表不在库中 / 时间列被删 / 没有一行的时间值能过形态谓词——
    空表或全是脏值/NULL）。只看 null 分不出该修什么。
  · **`db tables` 的 `tables` 数组只含库中真实存在的表**：声明有而库中无的表**不在清单里**，
    只在 `warnings` 里点名。所以「清单里没有某张表」不等于「这张表不存在」。
  · `time_column.kind` 的三个取值（`iso-day` / `iso-instant` / `epoch-ms`）此前全仓零释义。
  修法：新增 `src/commands/db-notes.ts`，给 `db describe` 与 `db tables` 各挂一套
  `meta.field_notes`（与 `notice` / `warnings` 并列）；README 与 skill `SKILL.md`
  补「声明 ≠ 实况」与「清单只含真实存在的表」。
  新增 `tests/db-field-notes.test.ts`（17 条）：图例键集 ↔ 真实 meta 键集（含
  `field_notes` 必须存在且键集一致）、`time_column.kind` 枚举双向、无 `**`、
  非枚举单元格不含 `；`，外加**七条真库用例**把每条事实钉住（表被删 / 时间列被删 /
  多出列 / 空表 / 全脏值 / 无时间列 / `db tables` 不含缺失表）。
  变异 17 条全红。两处过程教训：① `time_column` 的单元格初版把「它也是声明」这句前缀
  混进了枚举单元格，反向解析因此少一个取值 —— 与 PR #26/#27 的 `；` 陷阱同源，已改成
  纯枚举并把那句挪进 `columns` 的释义；② 键集测试初版只做单向（图例 ⊆ 字段），删掉
  `columns[].note` 的释义时**全绿** —— 补上反向（字段 ⊆ 图例 ∪ 自明键，含 `columns[]`
  嵌套层）后才红。
  CodeRabbit 四条（全部核实成立并修）：① **Major** —— 释义写「查询这些列默认脱敏」，
  而 `query --sql` 不走列白名单、只有列名级与值级兜底，Agent 会把 `--sql` 的原始 PII
  当已脱敏数据。三处（`columns[].sensitive` / `pii_columns` / `tables[].pii_columns`）
  全部限定到 `query --table`。② `tablesFieldNotes` 的键集断言里
  `k.split(/[.[]/)[0] === 'tables'` 把**每一个** `tables[].x` 都跳过了（第一段都是
  `tables`）—— 等于没断言，改成只跳过顶层键。③ `grain` 与 `primary_key` 同样是声明
  却没有释义，补上。④ SKILL.md 写「两者的 `columns` / `pii_columns` / `time_column`」，
  而 `db tables` 并不输出 `columns` / `time_column`，改成按命令分开点名。
  **第二轮两条（Minor）**：⑤ 脱敏承诺又漏了 `--no-mask`——它连 `query --table` 的脱敏
  也会关掉，三处补「`--no-mask` 可关闭，关闭后就是原始 PII」；⑥ SKILL.md 那句
  「两者输出的字段都来自表定义」把 `row_count` 与 `time_range` 也归成了声明，
  而它们是**实测**（真去库里查）—— 改成分别点名声明字段与实测字段。
  六条各补变异验证。自查另补一处：README 只点了三件套，补上 `grain` / `primary_key`
  并点明 `row_count` / `time_range` 是实测（三处出口必须一致）。另把「脱敏只对
  `--table` 成立」收紧为「可靠的按列脱敏只对 `--table` 成立」——`--sql` 也有列名级与
  值级兜底，原措辞会被读成「`--sql` 完全不脱敏」。

- **`query` 的 9 个 meta 键全仓无释义，其中三处的字面与事实不符**。`query` 是 skill 协议
  指定的主查询入口，而它的 `meta` 此前**一条释义都没有**（README 有散文，但 Agent 读的是
  stdout）。逐格真库实测（2026-10-27）：
  · **`masked: true` ≠ 「有值被改写」**——它只表示脱敏开关开着。实测：查 `daily_overview`
    （无敏感列）时 `masked: true` 而 `masked_columns: []` 是常态，只有查到 `userPhone`
    这类敏感列才有改写记录；
  · **`mask_warnings: []` ≠ 「脱敏完整」**——`--no-mask` 时它**恒为空数组**（没脱敏就没有
    「脱敏不完整」可言），风险警告在 `warnings` 里。Agent 拿空数组当「脱敏没问题」会
    把原始 PII 当已脱敏数据汇报；
  · **`data_coverage` 只有首尾两点，看不见内部缺口**——实测 iso-day 表 7 天窗口里只有
    第 1、2、7 天有数据时，它照样报满区间。iso-day 表在**给了 `--since`/`--until` 时**
    另有 `warnings` 兜底（「区间内应有 N 个自然日，实际只有 M 个有数据」），
    **没有时间过滤时这条兜底不触发**（实测：无过滤 + 中间空 4 天 → `warnings: []`）；
    `iso-instant` 与 `epoch-ms` 表任何情况下都没有兜底（实测 epoch-ms 的 `sessions`
    中间空 5 天（09-02..09-06），`data_coverage` 报满首尾且 `warnings: []`）。skill 正文当时把
    `data_coverage` 说成「本地数据的实际覆盖范围」——正是这条没有兜底的字段，属于过度承诺。
  同轮把两个字段的 `null` 成因也数清了（此前只说「恒为 null」）：`resolved_range` 有
  **四种**（`--sql` 通道 / 没给 `--since`/`--until` / 表没有时间列 / 只给 `--until` 而
  该列无可用值），`data_coverage` 有**三种**（`--sql` 通道 / 表没有时间列 / 范围内没有
  一行的时间值能过形态谓词——空表、过滤后 0 行、时间列全是脏值或 NULL 都归这条）——
  两个字段的 `null` **不同源**，只写「恒为 null」会让 Agent 把「没有过滤」与「范围内
  没有数据」混为一谈。第三种最隐蔽：脏值行在无过滤时照常返回，于是 `rows > 0` 而
  `data_coverage` 为 `null`，且不保证有任何警告（实测）。
  修法：新增 `src/commands/query-notes.ts`，两个通道（`--table` / `--sql`）挂**同一份**
  `meta.field_notes`（分叉写两份必然漂移）；README 补 `data_coverage` 的内部缺口盲区与
  `masked` / `mask_warnings` 两个字面陷阱；skill `protocols.md` §1 去掉过度承诺并点名
  「要核对内部覆盖得自己按自然日 GROUP BY 数行」。
  新增 `tests/query-field-notes.test.ts`（19 条）：图例键集 ↔ 真实 meta 键集（含
  `field_notes` 本身必须存在）、无 `**`、正文不含分隔符 `；`、四种/三种 null 成因各配
  真库用例（含三条子路径）、三处字面陷阱各配真库实证（含 `--limit` 不影响
  `data_coverage`、无过滤时缺口兜底不触发）。
  变异 15 条全红，其中**三条最初是绿的**：① 键集测试把 `field_notes` 过滤掉再比较，
  删掉某通道的图例时当时 17 条全绿——改成显式断言其存在后才红；② epoch-ms 那条只跑了
  **无过滤**查询，此时 `resolvedRange` 为 null、缺口警告块根本进不去，把
  `NULL AS days` 改成常量 days 的变异仍然全绿——补一条带过滤的用例后才红；
  ③ 键集测试只断言 `field_notes` **存在**、没断言它的**键集**，某通道只发一个键仍然
  全绿——改成比对发出对象的键集后才红（第三轮 CodeRabbit 抓到的）。
  另同步 `tests/commands/query.test.ts` 两处「meta 九键」的形状钉子（现为十键）。
  CodeRabbit 两条（全部核实成立并修）：① **Major** —— 「iso-day 表另有 warnings 兜底」
  没写触发条件，而缺口检查块要求 `resolvedRange` 非 null（给了时间过滤）；无过滤时
  `data_coverage` 照样报满区间而**没有任何警告**。图例、README、skill 三处一并加上条件，
  并补一条「无过滤 → 兜底不触发」的真库用例。② **Minor** —— `data_coverage` 的 null
  成因把「空表且无过滤」漏了：它既不是「过滤范围内 0 行」（根本没有过滤范围），也不在
  我列的三条里。三条成因合并成同一机制（没有一行能过形态谓词）并把三条子路径逐一点名。
  两条各补变异验证。
  **第二轮一条（Minor）**：`sessions` 的 Sep 1 与 Sep 7 之间缺的是 **5 天**
  （09-02..09-06），我在 CHANGELOG 与测试注释里都写成了 6 天。已改正。
  同轮自查收紧两处措辞：「没有时间过滤时是全表的」漏了「只算时间值形态合法的行」这个
  限定；README 说「用 `resolved_range` 与 `warnings` 区分三种 null 成因」不成立 ——
  脏值那一种两者都给不出信号，改成如实说明前两种能直接判断、第三种只能靠规则本身识别。
  **第三轮一条（Major，又一假护栏）**：键集测试只比了 `queryFieldNotes()` 与 `meta` 的键，
  没比**实际发出**的 `field_notes` 键集 —— 某个通道只发 `{resolved_range: …}` 也能全绿。
  改成两个通道各自比对发出对象的键集；变异（`--sql` 通道只发一个键）→ 红。

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
  ⑮ 「图例键必须在真实输出里存在」那条测试原本**手抄**了一份任务条目键清单，注释却声称
  「改 `taskOut` 删键时这条会红」—— 手抄清单不会跟着红（本项目已在 `TOP_KEYS` 上踩过一次）。
  改成导出 `taskOut()` 并从它的返回对象**推导**键集；变异验证：把 `taskOut` 的 `status`
  键改名 → 测试红。同时把 `RANGE_STATUS_NOTES` 的 `satisfies` 目标从字面量改为
  `RangeStatusValue | 'null'`（与 `RUN_STATUS_NOTES` 同款）：给枚举加值而不写图例现在
  **编译期**就失败。
  ⑯ `tasks[].status` 的 `failed` 一度写成「连窗口循环都没进（目前只有快照任务被本地限频
  闸门拦下这一条路径）」—— 引擎里快照有**三条** `failed` 出口（限频闸门 / 上游取数失败 /
  落库失败或行数核对不符），只提闸门会让 Agent 把「取数失败」误读成 `partial`。改成逐条
  点名，并补一句「windowed 任务不会给出 `failed` —— 全窗失败也是 `partial`」（窗口循环
  只有这两个出口）。新增真库用例同时钉住两侧边界；变异：图例回退 → 断言红，把快照的
  `failed` 改成 `partial` → 真库用例红。

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

- **2026-11-09/10 三路只读审计：查询/统计 8 条、CLI/凭证 3 条、同步 6 条，逐条复现实测后修正**：

  **查询与统计**
  · **`query --table --since <今天>` 在「今天有数据」的库上打成 `internal`**（P1）：
  缺口检查把上界夹到昨天零点后再跑覆盖查询，窗口只剩今天时夹紧后 `hi < lo`，
  `buildCoverageQuery` 抛用法错误、本段又在 `usageFail` 的 try 之外 → 顶层归成
  `internal` +「若反复出现请报告此问题」。现在 `hi < 起始` 时窗口内 0 个应覆盖日、不报缺口。
  · **`stats fields` 空键成因自相矛盾**：`{"":1}` 同时出「其余字段照常统计」与
  「均无可观测字段（NULL / 空对象 / 非对象）」；空键被排除的真正原因是观测 SQL 的
  `WHERE e.key <> ''`（旧文案说的「JSON 路径无法表达」根本走不到）。0 字段时成因改用
  「只有空字符串键」，有字段时不再承诺「其余字段」。
  · **`--sql` 日期字面量警告漏掉最常见的三种错位写法**：`…T00:00:00Z`、
  `… 00:00:00.000Z`、`…T00:00:00.000Z` 都静默少算一天。判据改为按列内真实形态
  （严格 `…T16:00:00.000Z`，`.123` 之类同样错位）逐个字面量判定，词法复用 `mask.ts` 的
  状态机（注释里的条件不报；双引号标识符、美元引号体与 E 串转义按 DuckDB 词法跳过；
  `HH:MM` 缺秒形态、`query('<内层 SQL>')` 包装里的内层写法一并判 —— CodeRabbit/Codex
  2026-11-10 两轮各补）。
  · **列选择器 `COLUMNS('stat.*')` 里藏列名时漏报**（Codex 第六轮 P2）：`WHERE COLUMNS('stat_date')`
    与 `WHERE stat_date` 等价，但字面量被抹掉后判据提前返回零警告。新增 `hasDayColumnSelector`
    + `sqlFunctionCalls`（代码位置匹配，字面量/注释不参与）。
  · **`"query"(…)` 双引号函数名/多余括号/CAST 包裹逃过扫描**（Codex 第六轮 P2）：实参扫描改走
    `sqlFunctionCalls` + `readStaticArg`（只展开整个表达式为静态字符串的形态）；拼接/函数调用
    等无法展开的表达式不再冒认前缀、单独声明缺口。
  · **美元引号体本身是日期字面量**（CR 第五轮 minor）：`$$2026-10-13$$` 与 `'2026-10-13'` 等价、
    此前被整段跳过零警告；扫描统一收进 `readSqlString`。
  · **带尾随字符的列内形态字面量被当成安全格式**（Codex 第七轮 P2）：实测
    `stat_date >= '…16:00:00.000Z '` 在 DuckDB 里为 **false**（库值是字面量的严格前缀），
    边界日整列被排除；旧判据先 `trim()` 再完整匹配，静默放行。判据改为「按前缀认出日形态
    + 逐字一致才放行」，前导空白仍不误报（实测那种比较不排除任何行）。
  · **列表/结构体键形式的时间列引用漏报**（Codex 第八轮 P2，均实测）：`COLUMNS(['stat_date'])`
    （列表里的字符串原样返回、真实等价于列引用）、`struct_extract(d, 'stat_date')`、
    `d['stat_date']` 的列名只出现在字符串里，`withoutLiterals` 抹掉后判据提前返回零警告。
    新增 `hasDayColumnKeyReference`：时间列名字面量出现在函数实参括号或下标方括号里即认；
    普通位置的字符串（`SELECT 'stat_date' AS label`）仍不误报。
  · **`stats fields --db X` 的核实提示指向默认库**（Codex 第八轮 P2）：`UNIT_NOTES` 里写死的
    裸 `qiyu query --sql` 照着执行会查另一份库（或报库未初始化）。模板改为 `{@query}` 占位、
    由 `statsFieldNotes(loc)` 在调用点渲染成本次的 `--db/--profile`，并带上占位符替换契约。
  · **双引号别名里的撇号吞掉后续键字面量**（Codex 第九轮 P2，实测）：`struct_extract("it's",
    'stat_date')` 里别名内的 `'` 被当成开引号，假字面量一路吞掉真正的 `'stat_date'`，
    键引用判据漏报（两天夹具只计一天、零警告）。扫描改为先跳过完整双引号标识符（含 `""` 转义）
    再认字面量。
  · **`$` 序列被替换语法二次解释**（Codex / CodeRabbit 第九轮）：`statsFieldNotes` 用字符串
    替换值回填 `{@query}`，库路径或档名里的 `$&`/`$$`/`` $` ``/`$'`/`$1` 被 `String.replace`
    吃掉，`/tmp/q$&.duckdb` 被渲染成 `/tmp/q{@query}.duckdb`。替换值改为回调函数。
  · **unknown 字段的核实指引照着执行必然失败**（Codex 第九轮 P2，实测）：unknown 字段是报表
    **payload 里的 JSON 键**、不是表的列（`SELECT unlistedMetric` 是 Binder Error），旧文案
    「显式列出该列」误导；改为 `payload ->> '<字段>'` 提取并点明它不是列。
  · **父目录不可搜索时真配置被当成「不存在」**（Codex 第十轮 P2，实测）：`existsSync` 在穿过
    `chmod 000` 的目录时被 EACCES 吞掉、返回 **false**，`assertConfigReadable` 提前返回 ——
    `auth whoami` 报 `auth_missing`（「appKey 来自 （缺失）」）并让人 `auth login`，而 login
    同样进不去这个目录；store/query 还会回落到默认库。改为 `accessSync` 先行、**只有 ENOENT
    才是「没有配置」**；EACCES/EPERM 再按「挡在哪一层」分流：新成因 `dir-unreadable`
    （目录不可搜索 → `chmod 700` 目录）与既有 `unreadable`（文件读不了 → `chmod 600` 文件）
    各自一句文案、各自一条修法。README 与 skill `errors.md` 的 kind 表同步补第三档。
  · **祖先目录挡路时 hint 点名的是「自己其实好好的」那一层**（Codex 第十一轮 P2，实测）：
    `~/.config` 000、`~/.config/qiyu` 本身 700 时，`accessSync(qiyu, X_OK)` 照样 EACCES，
    于是报「配置目录 …/qiyu 不可搜索」并建议 `chmod 700 …/qiyu` —— 这条命令本身就执行不了
    （实测 `chmod: … Permission denied`），照做后配置仍读不出来。新增 `blockedAncestor`：
    从配置目录逐层向上找**最外层** EACCES/EPERM 的目录（它的父目录必然可进入，所以 chmod
    一定可执行），文案与 hint 都点名它，并写明「更深的层修好后重跑会重新点名」；
    端到端实测：按 hint 执行后 `auth whoami` 从 `config_insecure` 变为 `configured: true`。
  · **空格分隔 / 带前导空白的 iso-day 字面量静默漏报**（Codex 第十一轮 P2，实测）：库内形态
    恒为 `…T16:00:00.000Z`，而旧正则把 `[T ]` 都当规范分隔符、`^` 锚又让前导空白根本不匹配 ——
    `stat_date <= '2026-10-13 16:00:00.000Z'` 按字典序把边界日整列排除、`<= ' 2026-…Z'`
    一行不剩，两种都零 warning。分隔符收紧为只认 `T`，前导空白单独识别后同样警告。
    ⚠️ 这**推翻了第七轮**「前导空白不误报」的结论：那条只在 `>=` 方向成立（字面量更小、
    只是多取行），换 `<=` 就是全表漏取；判据看不到运算符，按「方向安全（多警告）」一律算错位。
  · **field_notes 释义值里残留换行**（CodeRabbit 第十二轮 minor，实测）：`windows.total` 的
    释义里带了一个源码折行残留的 `\n`，Agent/工具会把一句定义在中途断行读成两段。删除，
    并在跨命令的图例形态守卫里加「释义不得含换行/回车」的反向断言（此前只查 `**`）。
  · **Windows ACL 拒绝拿到的是 POSIX chmod hint**（Codex 第十二轮 P2）：Windows 上 ACL 拒绝
    同样让 `accessSync` 抛 EACCES/EPERM，旧实现一律建议 `chmod 600/700` —— chmod 不存在于
    Windows，用户拿不到任何可执行的恢复步骤（README 声明 Windows 跳过的是「过宽」检查，
    读拒绝分流出 `config_insecure` 后照样走到这条 hint）。修法平台化：Windows 文案改说
    「被 Windows ACL 拒绝（不是 POSIX 权限语义）」，hint 改为 `icacls <路径> /reset`（恢复
    继承的 ACL，附「属性 → 安全」的手工授权替代），路径引号按 win32 方言走 `shellArg`
    单一实现点。README 与 skill `errors.md` 同步。
  · **权限拒绝的分流只挂在探测点，Windows 上不可达**（CodeRabbit 第十三轮 minor）：Node 的
    `fs.access` 在 Windows 上不评估 NTFS ACL —— 真拒绝发生在 `readFileSync`，被包成无 kind
    的普通 Error，login 报 config_invalid、store 族报 usage 2，上一轮加的 icacls hint 成了死分支
    （Windows 用例只注入 platform，从未走真实探测路径）。把 EACCES/EPERM 的分类收进
    `permissionReadError` 唯一实现点，探测点与**读点**（`readConfigRaw`）共用；POSIX 上顺带兜住
    「access 通过后、读之前权限被改」的竞态。回归：`readConfigRaw` 直接对 000 文件 → config_insecure；
    EISDIR 等非权限读错误维持普通 Error 口径（`<cfg>/x/y` 的 ENOTDIR 会被 existsSync 吞成「不存在」，
    反例只能用「配置路径本身是目录」构造，实测）。
  · **`windows.skipped` 的释义漏了第三种成因**（Codex 第十四轮 P2，引擎源码核对）：覆盖窗失败时，
    其名下被回看重叠区合并的窗「该拉没拉」，`runWindowed` 与 `runRotated` 都把它们计入 `skipped`
    并逐窗出「须重跑补齐」进度行 —— 而 `meta.field_notes` 仍只声明残段窗 / 整窗晚于末端上限两种。
    Agent 会把失败轮的 skipped 读成「都是有意不拉的窗」。释义补第三种成因并点明「此时 status 必为
    partial、看 gaps 找失败覆盖窗」，README 三处同步（定义、complete 判定、clamp 段）。新增守卫
    除钉释义措辞，还直接对引擎源码断言两处结算表达式（防释义与实现各说各话）。
  · **「无法检查」盖过了已确认的日期错位**（CodeRabbit 第十四轮 minor，实测）：外层
    `stat_date >= '2026-10-13'` 是确定的少算一天，同句再带一个拼接实参的 `query()` 时，
    旧实现先返回「无法检查」，**确定**的警告连同修法一起被替换 —— Agent 只看到「没法检查」，
    不会去改那条真会少算的过滤。顺序改为外层扫描优先；只有外层什么都没发现时才声明缺口。
  · **Unicode 别名的下标键引用漏报**（Codex 第十四轮 P2，实测）：键引用扫描的标识符正则
    只认 ASCII，而 DuckDB 接受任何非 ASCII 非空白字符作未引用标识符（`AS 数据` 合法）——
    `数据['stat_date'] >= '2026-10-13'` 与 `d['stat_date']` 等价、边界日被排除，却零警告。
    改为复用 `mask.ts` 的 Unicode 标识符判据（`isIdentAt` 导出、`isIdentCharAt` 判起点），
    标识符规则只许一个实现点。
  · **`config_invalid` 的注释把「权限拒绝」列成自己的成因**（CodeRabbit 第十四轮 minor）：
    权限拒绝走 `config_insecure`（`permissionReadError` / auth 的 insecure 分支），照旧注释
    分流会挑错 kind；注释改为「内容读不出来」并点名权限拒绝归 `config_insecure`。
  · **README 的 `complete` 行把只在 `partial` 出现的成因写进覆盖面**（CodeRabbit 第十五轮 minor）：
    `complete` 的定义是 `windows.failed = 0`，而「覆盖窗失败转 skipped」必然 `windows.failed > 0`、
    只可能出现在 `partial` —— README 却把它并列成 skipped 的第三种成因，Agent 会以为
    「complete 也可能藏着没拉到的合并窗」（与同文 470-474 段、field note 自相矛盾）。
    `complete` 行改回两种成因并加「只会出现在 `partial`」限定；`tests/docs.test.ts` 加行级守卫
    （必须带该限定、不得声称「三种」），变异退回旧文案即红。
  · **`tasks[].notes` 的机器可读释义只声明了两个生产来源中的一个**（Codex 第十五轮 P2）：
    `sync run` 把 `floorNotes`（区间早于接口下界）与 `untilNotes`（日对齐任务遇到非上海日界
    `--until`，分「该日不早于末端上限 / 末窗半个自然日按残段窗跳过」两档）合并写入 notes，
    `runFieldNotes()` 却称「当前唯一生产者是『请求区间早于接口下界』」—— 按 `meta.field_notes`
    解读输出的 Agent 认不出末段提示，会把「该日未同步」读成故障或漏读。释义改为按来源逐档
    说明并指向 `windows.skipped`；README 同段同步；`tests/sync-state-legends.test.ts` 加
    释义守卫（两来源 + 两档 + 源码合并点），`tests/docs.test.ts` 加 README 段落守卫，
    三种变异（退回旧释义 / 删上限档 / README 回旧文）均红。
  · **展不开的 `query()` 实参被当成「检出 SUMMARIZE」**（CodeRabbit 第十六轮 minor + Codex 第十六轮 P2，
    两路独立命中、均真机实测）：`SELECT column_name, min FROM query('SELECT ' || '1')` 合法且内层
    没有 SUMMARIZE，但 `readStaticArg` 返回 null 时只置 `gap`，下游「gap + 统计形状列」两档文案
    断言「内层使用了 SUMMARIZE / SQL 含 SUMMARIZE」——把猜测写成了检出，Agent 会去改一个本来
    没问题的查询。`queryCallSummarize` 新增 `unresolved` 信号：两句检出式文案对它失效，改由
    独立一档说「实参无法静态展开，无法确认内层是否含 SUMMARIZE…可能未脱敏」并给出可执行收口
    （实参改成单个字符串字面量）；该档只在输出确实是统计形状时发，避免给普通查询添噪音
    （`SELECT * FROM query('SELECT ' || '1')` 的泛化 query() 警告已覆盖）。两条变异（取消排除 /
    删新档致缺口静默）均红。
  · **里层 `query()` 的「没法检查」挡住外层已确认的日字面量错位**（CodeRabbit 第十七轮 minor）：
    `dayLiteralHint` 只用 `string | null` 表达结论，递归内层时一旦拿到「无法检查」就提前返回 ——
    外层 `stat_date >= '2026-10-13'` 这种**确定**少算一天的错位连同修法一起丢失（实测
    `... AND EXISTS (SELECT * FROM query($q$SELECT * FROM query('SELECT ' || '1')$q$))`）。
    改为 `{ kind: 'mismatch' | 'unexpandable', text }` 分开携带：只有 `mismatch` 立即返回，
    缺口先记下、外层扫描完仍无发现才降级成缺口。变异（改回提前 return）即红。
  · **嵌套 `query()` 的不可展开没有向上传播**（CodeRabbit 第十七轮 minor）：`queryCallSummarize`
    只把 `sub.gap` 并上去、丢了 `sub.unresolved`，外层于是又把里层的猜测当成检出 SUMMARIZE；
    同一处补 `if (sub.unresolved) unresolved = true`，变异即红。
  · **两条测试断言把宿主平台当成了 POSIX / 裸路径**（CodeRabbit 第十七轮 major ×2）：
    `insecureConfigError` 的 POSIX 用例没显式传 platform（Windows 上拿到 `icacls` hint）、
    `stats fields` 的 `--db` 期望没走 `shellArg`（Windows 反斜杠路径会被引号化）——两条在
    Windows 上都必红。改为显式 `'linux'` 与 `shellArg(...)`；同批把 `--db ` 裸拼接期望
    （`store-hint-selection` / `store-precheck-single-source` / `missing-table-causes` /
    `db.test`，共 12 处）一并收敛到 `shellArg`，判据是「期望必须按渲染方言生成」。
    平台敏感性已实测（传 `'win32'` 即转 icacls、断言红；`shellArg('C:\\Temp\\q.db','win32')`
    返回带引号形态）。
  · **脱敏缺口警告上限 5 条时静默截断**：第 5 条改为「另有 N 个敏感列的缺口警告未列出」并点名；
    上限按**类别**计（本块最多 5 行），不按全局行数扣减 —— 否则其它类别的警告占满 5 条后，
  不发汇总就退回静默截断、发汇总又超上限（Codex 2026-11-10 第三轮 P2）。
  · **库漂移删掉的是时间列时 hint 没有出路**：补「恢复前列名相关用法都会失败」+ 可执行的
  `--sql` 显式列替代（附引号替换契约）。
  · **只读沙箱的接受面说窄了**：`VALUES` / `PRAGMA 查询` / `TABLE` / `FROM` 实测都放行，
  USAGE、拒绝 hint 与 README 按实测写全。
  · **只有 `--until` 时倒置区间的 0 行警告重复归因**：不再叠「同步可能未覆盖该区间」。

  **CLI 与凭证**
  · **断链符号链接死循环**（P1）：只读命令的 `statGuard` 把断链的 `ENOENT` 当成「不存在」
  并指向 `store init`，而 `store init` 拒绝符号链接 —— 先 `lstat` 分流，点名真实成因。
  · **`--db/--profile/--backend` 重复出现静默覆盖**：改为用法错误（与 `api call --body` 同向）——
  `parseStoreFlags`、`query` 的 `parseFlags`、`sync run` 三处解析器都补齐（Codex 2026-11-10 P2：
  只修共享解析器会漏掉各自解析这两个 flag 的命令）。
  · **`auth login` 配置损坏时退出码 2**：改 `kind: config_invalid`（退出码 1，不写任何内容），
  权限拒绝则归 `config_insecure`；`ERROR_KINDS`、README、`qiyu --help`、skill `errors.md` 同步。
  · **配置文件读不出来是因为权限时，各命令给出三种说法**（Codex 2026-11-10 第四轮 P2）：
  读失败被包成无 kind 的普通 Error，与「畸形 JSON」同出口 —— login 报 `config_invalid`
  （它那条 `config_insecure` 分支是死代码）、store/db/query/stats 降级成 `usage` 退出码 2，
  只有 api/sync 报 `config_insecure`。现在在唯一读取点 `loadConfigFile` 读取前分流
  （`accessSync(R_OK)` 失败且 errno 为 EACCES/EPERM → 与权限过宽同一条错误 + `chmod 600` hint），
  四个命令族实测同一状态同一结论。

  **同步**
  · **被重叠区合并的窗从所有计数里消失**：`windows` 新增 `contained`（仅 > 0 输出，
  物理切出窗数 = total + contained；不计入 total，`skipped` 语义保持「该拉的没拉」）；
  `contained` 只在**覆盖它的那一窗成功**时计入 —— 覆盖窗失败时这些窗根本没拉到，
  此前会得到 `failed: 1, contained: 1` 而表是空的（Codex 2026-11-10 第三轮 P2）；
  此时改计 `skipped` 并逐窗出「覆盖窗失败、未覆盖」进度行（`runWindowed` 与轮转两条路径）；
  · **`--until` 非日界时末残段跳过却没有提示**：日对齐任务补 `tasks[].notes`（complete 不等于该段已同步）；
  声明了末端上限（考勤/绩效）且目标日晚于上限时改说「等上限前移」，不再给出照做也无效的
  「改 --until」建议（Codex 2026-11-10）；
  · **同一天的 `--since`/`--until`** 报错只回显两个相同时刻：改为上海 ISO 回显 + 半开区间与「不含当天」说明；
  · **`assertOpWindow` 允许零宽窗**：改为 `start >= end` 拒绝（与管道层同向）；
  · **`windowEndClamp` 截短的窗**：补「窗末端被上限截短」进度行（`runWindowed` 与轮转
  `planRotation` 两条路径都出 —— 考勤/绩效在 `sync run` 里全部走轮转，只修一条等于没修）；
  · USAGE 写明「只给 `--until` 时起点是最早，报表任务会从 1970 按天切出上万窗」。

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

[未发布]: https://github.com/MisonL/qiyu-cli/compare/v0.2.2...HEAD
[0.2.2]: https://github.com/MisonL/qiyu-cli/compare/v0.2.1...v0.2.2
[0.2.1]: https://github.com/MisonL/qiyu-cli/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/MisonL/qiyu-cli/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/MisonL/qiyu-cli/releases/tag/v0.1.0
