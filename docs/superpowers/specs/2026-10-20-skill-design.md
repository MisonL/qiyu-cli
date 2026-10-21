# F 子项目：Skill 化 —— 设计

> 状态：待评审（brainstorming 完成，三路调研已回收）
> 权威来源：`docs/qiyu-cli-design.md` §11；`docs/superpowers/specs/2026-10-09-后续交付路线图-design.md` §四.F
> 前置：A（注册表）、E（查询与沙箱）均已交付
> 日期：2026-10-20

## 一、问题与目标

Agent 拿到 `qiyu` 二进制之后，仍然不知道**该怎么用它**：先查什么、什么时候查本地库、什么时候走实时 API、0 行意味着什么、哪些数字会被误读。这些不是 CLI 能强制的（§11.5 明言 skill 不是安全边界），但可以让 Agent 有一份随版本走、可校验、不漂移的操作协议。

F 交付三样东西：

1. **一份 skill 文档**——随 npm 包发布，装到 `~/.agents/skills/qiyu/`
2. **`qiyu skill install` / `qiyu skill check`**——安装与防漂移校验
3. **`qiyu --version`**——输出包版本与 `skill_contract_version`

## 二、关键约束（来自调研，均为实测/源码确认）

### C1. `~/.agents/skills` 不是 Claude Code 的用户级 skill 目录

Claude Code 只扫 `~/.claude/skills/`。本机能用 `~/.agents/skills` 里的 skill，靠的是 `~/.claude/skills/` 下 **32 个相对符号链接**（`../.agents/skills/<name>`）。

→ **只往 `~/.agents/skills/qiyu/` 复制文件，Claude 根本不会加载它。**

### C2. `.skill-lock.json` 不是加载前提

本机 117 个 skill 目录中 **77 个没有锁条目**（含 `ego-browser`、`web-perf`、`esxi`），照常可用。Claude Code 二进制里对 `skill-lock` 的搜索命中数为 0。

→ 写锁文件只影响 `npx skills` 的 `list/update/remove`，与加载无关。

### C3. 写锁文件有真实破坏风险

`npx skills` 的 `readSkillLock()` 在「文件不存在 / JSON 解析失败 / version 不是 number / 没有 skills / version < 3」时**一律返回空锁**，下一次写操作会**整份覆盖**——静默清空用户全部 40 条登记。

且锁文件的 `sourceType` 只有 `github / git / gitlab / well-known / download / local` 六种，**没有 npm 包来源的位置**。

### C4. postinstall 在主流包管理器下默认不执行

| 包管理器 | 默认行为（实测） |
|---|---|
| npm 12.0.2 | **阻断**，打 `npm warn install-scripts`（本机 `~/.npmrc` 有 `strict-allow-scripts=true`，会变成硬报错 `ESTRICTALLOWSCRIPTS`） |
| pnpm 12.4.2 | **阻断并报错** `ERR_PNPM_IGNORED_BUILDS` |
| bun 1.4.3 | **阻断**，提示 `bun pm untrusted` |
| yarn 4.0.1 | 执行 |

npx 场景下 postinstall 失败会让整个调用**静默退出码 1，几乎没有错误信息**。

→ **postinstall 不能承担"必须成功"的职责。**

### C5. 自定义参数的命令行形式在 npm 12 已失效

- `npm i -g qiyu-cli --qiyu-skill-dir=/x`：npm 12 **报 `EUNKNOWNCONFIG` 直接失败**，脚本根本跑不到（npm 9 静默可用、11 警告可用）
- `npm_config_qiyu_skill_dir=/x npm i -g qiyu-cli`：npm 9–12 都可用，但 npm 12 打 `Unknown env config` 警告，**npm 源码注释写明计划在 npm 13 改为报错**

→ 环境变量是唯一跨版本可用的通路，但它有明确的生命周期终点。

### C6. 环境变量判据只在 npm 下成立

`npm_config_global === "true"` 判全局、`npm_command === "exec"` 判 npx —— **只有 npm 提供**。pnpm / yarn / bun 全部没有这两个变量（bun 连 `npm_lifecycle_event` 都是 null）。唯一四者都有的变量是 `INIT_CWD`。

### C7. 跨平台符号链接

Windows 上创建符号链接默认需要管理员权限或开发者模式。`npx skills` 用的是 **junction**（目录联接，不需要特权）。本机只有 macOS，**Windows 行为无法实测**——本 spec 明确标注为「未覆盖」。

## 三、决策

### D1. 安装目标与链接策略

```
实体：~/.agents/skills/qiyu/          （用户指定）
链接：<agent skills dir>/qiyu -> <相对路径指向实体>
```

⚠️ **相对路径必须用 `path.relative(agentSkillsDir, entityPath)` 现算，不许硬编码**：本机现存链接是 `~/.claude/skills/<name> -> ../../.agents/skills/<name>`（两级 `..`，实测）——从 `~/.claude/skills` 回到 `~` 要走两级，早先草稿里写的 `../.agents/...` 只走一级、指向 `~/.claude/.agents/`，是错的。agent 目录深度不保证一致（如 `~/.config/claude/skills`），现算是唯一正确做法。

要链接到哪些 agent 目录，按**存在性探测**决定，而不是硬编码：

| agent | skills 目录 | 平台细节 |
|---|---|---|
| Claude Code | `~/.claude/skills/` | POSIX 用相对符号链接；Windows 用 junction |
| Codex | `~/.codex/skills/` | 同上 |

- 目录**已存在才链接**（不替用户创建 `~/.claude/` 这类目录）
- 链接创建失败（权限、文件系统不支持）→ **如实报告，不假装成功**：`meta.warnings` 写明哪个 agent 没链上、原因是什么
- 目标已存在且**不是**指向我们的链接 → 不覆盖，报 warning（用户可能装了同名 skill）

**为什么不写 `.skill-lock.json`**（C2 + C3）：不影响加载、有清空用户账本的风险、且没有合适的 `sourceType`。改为在 skill 目录里放 `.qiyu-skill.json` 记录来源与内容哈希，由 `skill check` 使用。

### D2. 命令形状

```
qiyu skill install [--dir <path>] [--link <agent>]... [--no-link] [--force] [--dry-run]
qiyu skill check   [--installed | --compare]
qiyu skill where   [--dir <path>]
```

- `--dir` 默认 `~/.agents/skills/qiyu`（`QIYU_SKILL_DIR` 环境变量可覆盖）
- `--link` 可重复；缺省 = 探测全部已存在的 agent 目录；`--no-link` = 只放实体不建链
- `install` 直接写入（不设 `--yes` 闸门）：它只是往用户目录复制文本 + 建链接，不是危险操作。这与 `sync install` 不同——后者改的是系统调度。
- **已存在且内容与包内不同 → 跳过 + `meta.warnings`，退出码 0**；`--force` 才覆盖。理由：用户可能手工改过 skill，静默覆盖是局部破坏。
- **`skill where` 接受与 `install` 相同的 `--dir` / `QIYU_SKILL_DIR` 定位参数**，报告：实体路径是否存在、各 agent 链接路径与状态、每个候选目录是用哪条规则定位到的。它是纯**只读**命令——**只报告，不修复、不删除**。要修复就重跑 `skill install`。理由：一个能删链接的排查命令，在用户搞不清状况时会变成第二个问题。

链接状态分四态，`skill where` 必须逐个明确报告（这是它可被验收的前提）：

| 状态 | 含义 |
|---|---|
| `ok` | 链接存在且解析到的实体路径就是本次定位到的实体 |
| `dangling` | 链接存在但目标不存在 |
| `foreign` | 路径存在但不是我们建的（真实目录，或指向别处） |
| `missing` | 该 agent 目录下没有 `qiyu` |

### D2.1 首次运行的漂移提示（含"装了但过期"）

`skill check` 默认校验包内那份（CI 可跑），`skill install` 遇到内容不同又跳过——两者叠加会留一个洞：**用户装过旧版 → 包升级改了命令 → 已安装的那份还引用着死命令，而没有任何东西报警**。

补法：**任何 `qiyu` 命令在启动时做一次零成本探测**（读安装目录里的 `.qiyu-skill.json`，不读全部正文），据结果往 `meta.warnings` 加**一条**提示：

| 安装态 | 提示 | 退出码 |
|---|---|---|
| 未安装 | 「skill 未安装到 `~/.agents/skills/qiyu`；运行 `qiyu skill install`」 | 不变 |
| 已安装但 `content_hash` 与包内不同 | 「已安装的 skill 与当前 CLI 版本不一致（安装于 `<版本>`，当前 `<版本>`）；运行 `qiyu skill install --force` 更新」 | 不变 |
| 已安装且一致 | **不提示** | 不变 |

- **只提示，绝不自动改文件**——自动覆盖用户可能改过的正文是局部破坏
- 探测结果在**一个进程内只算一次**（惰性 + 缓存），不重复 stat
- 探测失败（权限、路径异常）→ 静默跳过，不影响命令本身

### D3. `skill check` 的判定

**校验基准默认是包里那份**（`dist/skill/qiyu/`）——CI 里没有 `~/.agents/skills`，而 `skill check` 必须能在 CI 里跑。`--installed` 校验已安装那份，`--compare` 两份都比并报告差异。

三档结果：

| 档 | 判据 | 退出码 |
|---|---|---|
| 通过 | 引用的命令/flag/位置参数域/`kind` 全部存在 | 0 |
| 违规 | 引用了不存在的命令路径、flag 或 `kind`；正文出现 `TABLES` 里的表名；出现完整 SQL 关键字序列；推荐了 `--pretty` | 1 |
| 无法校验 | 含占位符/管道/省略号等无法静态判定的文本 | 0，`meta.warnings` 列出并指认位置 |

**引用怎么提取**：不要求写标记语法（对写作者是负担，且容易写成假的）。扫描规则：

- 只看行内代码（反引号包裹）
- 只认以 `qiyu ` 开头的
- 遇 `<...>` 占位符时只校验到占位符之前
- 其余含 `<`、`|`、`…` 的视为不可静态校验 → warning

**flag 校验是真实在岗的，不是摆设**：skill 的通道路由部分会推荐 `query --table`、`sync run --full`、`api call --body <JSON> --yes` 这类带 flag 的命令——它们都要过 `CommandSpec.flags` 的比对。判定规则：**引用的 flag 不在该命令的 `flags` 里即违规**；命中 `rejected`（如 `--pretty`）给专门话术「已知但未实现，别用」，其余给「该命令不接受此 flag」。§11.1 禁的是**数据侧事实**（表名/列名/错误码列表/完整 SQL），**不禁 flag**——flag 是 CLI 的稳定接口，正是 skill 该写、也该被校验的内容。

**`kind` 引用也校验**：skill 正文用 `` `kind: rate_limit` `` 这个形态写错误分类（窄模式，易提取）。`core/errors.ts` 把 `ErrorKind` 联合类型改造为**同时导出运行时常量**（`export const ERROR_KINDS = [...] as const; export type ErrorKind = typeof ERROR_KINDS[number]`——标准的类型/常量单源写法）。`skill check` 把正文里的 `kind: x` 逐个对着 `ERROR_KINDS` 比，不存在即违规。逐命令的 `kinds`/`exits` 映射**v1 仍不做**（那没有现存事实源，见 D4）。

### D4. 契约事实源：每个命令导出 `CommandSpec`

**这是 F 能成立的前提。** 不能让 `skill check` 去正则解析 usage 散文——调研已验证散文本身有 3 处与实现不符：

1. `cli.ts` 的顶层 USAGE 里，`db tables` / `db describe` 两行**没写** `--db/--profile/--backend`（它们只在后面的「查询族参数」公共段出现），而 `db.ts` 自己的 USAGE 写了
2. 同理 `sync status` / `sync verify` 的顶层行只写 `[任务...]`，实际接受 store 三件套
3. `api.ts` 的 `api schema <id> [--pretty]` 把 `--pretty` 写进用法，但它在所有命令里都是**显式拒绝**（`api.ts:290`）——扫散文会把一个必然失败的命令判成合法

```ts
export interface FlagSpec {
  name: string
  kind: 'value' | 'bool' | 'repeatable'
}
export interface CommandSpec {
  path: string[]                       // ['db', 'describe']
  flags: FlagSpec[]
  positionals: { name: string; domain: Domain }[]
  rejected: string[]                   // 已知但显式拒绝（当前只有 --pretty）
}
type Domain = 'tables' | 'report-tables' | 'task-ids' | 'endpoint-ids'
```

`cli.ts` 汇总成 `export const COMMAND_TREE: CommandSpec[]`。

**三个硬约束（不满足则退化成第二事实源）：**

1. **`KNOWN` 不能直接当 `flags`**。6 个模块（store/sync/sync-run/db/stats/query）的 `KNOWN` 只含 `--help`/`-h`/`--pretty`，**不含任何业务 flag**。直接导出会让 `db tables --db` 被判非法。必须先把**各命令接受的 flag 全量**从现有解析器提成命名常量：`db.ts:59` / `store.ts:30` / `stats.ts:52` 的 `a === '--db' || ...`、`sync-run.ts:216` 的内联条件、`sync.ts` 五个调用点的内联数组（含 `sync install` 的 `--schedule`、`sync uninstall` 的 `--yes`）、`api list` 的 `--all`、`api call` 的 `--body/--yes/--no-validate/--strict`、`query` 的十个（`--group-by` 标 `repeatable`）。**`flags` 必须是完整接受集，不能只记 `rejected`**——否则 skill 里写 `` `qiyu api call --no-validate` ``（真实的用法错误）也会被判通过。
2. **`--pretty` 建模成 `rejected`**，不是合法 flag。它在每个模块都走 `usageFail`（`query.ts:434`、`api.ts:290`、`db.ts:275` 等），但 usage 散文里却写着 `[--pretty]`。§11.2 E 也明令「不要使用 `--pretty`」。
3. **v1 不做逐命令的 `kinds` / `exits`**。它们没有任何现存事实源（`ErrorKind` 是全局联合类型、`exitCodeFor` 是 `output.ts` 私有函数），逐命令手写等于新增两份易漂移的声明。`skill check` 改用**全局 `ERROR_KINDS` 常量**校验正文里的 `kind: x` 提及（见 D3）。

**附带修掉一个已知缺陷**：`db.ts:50-53` 的注释自己承认「`parseFlags` 与 store.ts / stats.ts 逐字相同……改动这里必须同步那两处，或干脆收成共享模块」。调研核实**属实**（store 只是类型注解不同）。F 顺带把三份合并到 `src/commands/store-flags.ts`，让 spec 与 parser 消费同一常量。

**分层**：`COMMAND_TREE` 在 `cli.ts`（commands 层）汇总，不新建 `src/core/commands-tree.ts`——后者若要 import `TABLES`/`SYNC_TASKS` 会违反 `tests/store/layering.test.ts:37-52`（`core/` 不得 import `store/` 或 `sync/`）。

**改动量**：约 9–10 个文件，新增约 250 行、修改约 30 行。USAGE 文本与错误文案**原样不动**，因此 `readme.test.ts` / `docs.test.ts` 的源文本断言与全部行为测试保持绿。

### D5. skill 文档的内容与结构

```
src/skill/qiyu/
  SKILL.md              # 入口：frontmatter + 开场协议 + 通道路由决策树
  protocols.md          # 数据可信度协议（§11.2 C / C2）
  metrics.md            # 指标语义（三处「行数 ≠ 实体数」）
  errors.md             # 错误处理协议（§11.2 D，按 kind 分支）
  forbidden.md          # 禁止事项（§11.2 E）
  setup.md              # robotId 等需手工配置的 ID（§11.3）
  .qiyu-skill.json      # 安装元数据（源版本、内容哈希）
```

### D5.1 构建与分层

- **非 tsc 资产**：`scripts/copy-params.mjs` 扩成 `scripts/copy-assets.mjs`（职责：params + `validate.json` + skill 文档），沿用现有「构建期拷贝非 tsc 资产」的形态。`package.json` 的 `files: ["dist"]` 不用改——skill 文档在 `dist/skill/qiyu/` 下。
- **`src/skill/` 的代码**（`check.ts`、`install.ts`、`detect.ts`、`refs.ts`、`paths.ts`）是与 `commands/` 平级的**叶子层**：它消费 `commands/`（`COMMAND_TREE`）、`store/`（`TABLES`）、`core/`（`ERROR_KINDS`、`edition.ts` 的版本常量），**这些一律不得反向 import `skill/`**。`tests/store/layering.test.ts` 补一条红线钉住。
- **`src/postinstall.ts`** → `dist/postinstall.js`，新的顶层入口（与 `cli.ts` 同级）。它 import `skill/install.ts`——同一份安装逻辑，不是复制代码。

**frontmatter** 必须同时满足两套校验：

```yaml
---
name: qiyu
description: <一句话说明何时用，含关键词>
---
```

- `npx skills` 要求 `name` + `description` 都是字符串，否则**不安装**
- Claude Code 缺 `description` 只警告，但仍会加载
- `name` 与目录名保持一致
- `SKILL.md` 必须 < 1 MB，且不能是符号链接

**内容红线（§11.1）**：绝不硬编码表名、列名、错误码列表、完整 SQL。所有事实通过 CLI 自描述在运行时获取。可写的只有命令、flag、`kind`、退出码语义。

**通道二选一——本 spec 的裁决（§11.2 B 与 E 冲突，原文如下）**：

- §11.2 B 路由表：「历史趋势 / 聚合 / JOIN / 跨窗口 → 本地数据库」；`query --table` 正是这一通道的受约束入口
- §11.2 E 禁止事项：「不要使用 `--pretty`/`--table`」

逐字读 E 那句，在 B 表明确推荐本地数据库通道的前提下**无法照字面执行**——照做等于禁掉 B 的一半。且设计与骨架都不支持它：§9.1 的限流降级示例本身就建议 `fallback: "qiyu query --table order_performance"`（`docs/qiyu-cli-design.md:1128`），§8 把 `query --table` 定义为「受约束查询通道」（列白名单 + 时间语义 + 精确脱敏）。

**裁决：E 那句里的 `--table` 是指**「拿 `--table` 当**任意查询**的通用替代品」**，不是禁用这条通道。** 依据是 E 这句的写法本身：它与 `--pretty` 并列在「不要使用」下，而 `--pretty` 的性质是「承诺过、未实现」（仓库里每次遇到都给这条明确话术），`--table` 与之并列，说明原意是「别拿某个不成熟的开关当工具用」这一类提醒，而不是通道级禁令。

落到 skill 正文：

- ✅ 该用 `query --table`：B 表判定为本地数据库通道、且问题是「某表的行/计数/时间范围」
- ✅ 该用 `query --sql`：需要 JOIN / 跨表聚合，`--table` 表达不了
- ❌ 不要用 `query --sql` 去跑单表简单过滤——`--table` 更安全（列白名单、精确脱敏）
- ❌ 不要用 `--pretty`（未实现，必然失败）

⚠️ **这处冲突需要回写设计稿 §11.2 E**（把 `--table` 从禁止项里拿掉，或改成「不要把 `--table` 当通用 SQL 替代品」）。本 spec 给出裁决与依据，改设计稿的措辞归 F 的实施波一并做。

**按需加载**：Claude Code 只在 skill 被触发时读 `SKILL.md` 全文，其余文件按正文指示才读。所以拆分 `references/` 不增加每轮上下文成本——这正是 DESIGN 稿鼓励的形态。

**`kind` 表格的来源**：§11.2 D 的表里有 `ambiguous`，但它在**当前版本不存在**——`ErrorKind` 联合类型里没有它，路线图把它归在 **G2（§9.4 名称解析）**，尚未实现。所以 skill 的 `kind` 表**只列当前版本真正会产出的**，`ambiguous` 的处理协议作为「G2 交付后启用」的附注写出，而不是列进正文表格假装它已存在。这与 §11.4「`skill check` 校验引用确实存在」是同一条原则。

### D6. `skill_contract_version`

独立于包版本的整数，定义在 `src/core/edition.ts`（与 `PACKAGE_VERSION` 同处；计划自检①：若放 `src/skill/contract.ts`，`cli.ts` 输出 `--version` 就要反向 import `skill/`，违反分层红线，故上移到 `core/`）：

- skill 正文的**结构性改变**（增删某类协议段落）→ 递增
- 命令/flag 变化但 skill 未受影响 → **不**递增
- 输出位置：`qiyu --version` 与 `qiyu skill check` 的 `meta.skill_contract_version`

⚠️ `qiyu --version` 目前**完全不存在**（§11.4 承诺过，路线图 G1 未列）。

**形状：与 `--help` 同样的顶层伪命令**（走 stdout、退出码 0、不进 `COMMANDS` 分发表），但**输出遵守既有信封契约**：

```json
{"ok":true,"data":{"version":"0.1.0","skill_contract_version":1}}
```

理由：全局约束是「其余任何情况下 stdout 都必须是合法 JSON」，`--help` 的裸文本是**明确的历史例外**，不该再开第二个。`--version` 与 `--pretty` 一样做「不接受额外参数」判定（`qiyu --version --bod` → 退出码 2）。包版本从 `package.json` 读——当前 `dist/` 里没有它，需要构建期注入：`src/core/edition.ts` 里 `PACKAGE_VERSION = '0.0.0-dev'` 占位，`copy-assets.mjs` 在 build 后正则替换 `dist/core/edition.js` 中的该字面量（不能用相对路径 `require('../package.json')` 猜层级，也不能运行时读 `package.json`——`files: ["dist"]` 发布后它不在包里）。

### D7. postinstall：尽力而为，不承担职责

```json
"scripts": { "postinstall": "node dist/postinstall.js" }
```

行为：

- 判据：`npm_config_global === "true"` 且非 npx → 尝试安装；否则**只输出提示，不写任何文件**
  - 判据在 pnpm/yarn/bun 下失效（C6）→ 降级为「不区分，只提示」
- 调用与 `qiyu skill install` **同一份**安装逻辑（同一模块，不是复制代码）
- **全部 try/catch，永远 `process.exit(0)`**；错误写 stderr
- 读 `npm_config_qiyu_skill_dir`（兼容 `npm_config_qiyu[_-]skill[_-]dir` 大小写变体）

**为什么它几乎帮不上忙**（C4 + C5）：npm 12 / pnpm 12 / bun 默认阻断它；即使跑成功，默认安装下它的 stderr 也会被 npm 吞掉（除非 `--foreground-scripts`）。

→ **真正的兜底是首次运行检测**（D2.1）：任何 `qiyu` 命令发现 skill 未安装**或已过期**时，在 `meta.warnings` 带一条提示。这条提示不打扰已装好且一致的人，也不依赖任何包管理器行为。

### D8. 跨平台

| 项 | 处理 |
|---|---|
| 符号链接 | POSIX 用相对链接；Windows 用 junction（`fs.symlink(target, path, 'junction')`，不需要特权）；失败则报告不假装 |
| 链接目标 | `path.relative(agentSkillsDir, entityPath)` 现算，不硬编码层级（本机实测是两级 `..`） |
| 路径 | 用 `node:path` 的 `join`/`resolve`，不做字符串拼接；`~` 只用 `os.homedir()` 展开 |
| 内容比对 | 比**规范化后的内容哈希**：逐文件不过滤，但按「相对路径 + 内容」排序后整体哈希，路径分隔符统一成 `/` |
| 换行符 | 复制不转换；哈希时**统一把 CRLF 折成 LF**——否则同一份 skill 在 Windows 检出、macOS 使用会被判成「内容不同」，导致 `install` 永远跳过、首运行永远提示过期 |
| 环境变量 | Windows 环境变量名大小写不敏感，读取时统一转小写比对 |

**`.qiyu-skill.json` 的语义**：它是「安装清单 + 版本标记」，不是逐字节指纹。写入 `{version, skill_contract_version, content_hash, installed_at}`。`content_hash` 用上面那条**换行归一化**的算法，因此跨 OS 重装不会产生伪冲突；而用户手工改正文则一定会被检出。`skill check --installed` 做的是**重新跑引用扫描**，不是拿哈希比对——扫描能告诉你"哪个引用失效了"，哈希只能告诉你"不一样了"。

**明确未覆盖**：Windows 上 junction 的真实行为、macOS/Windows 大小写不敏感文件系统的边界、pnpm/yarn/bun 下 postinstall 的实际触发率。本机只有 macOS，这些只能靠代码路径保证，不能声称实测过。

## 四、验收判据

1. `npm i -g` 后 `qiyu skill install` 一条命令装好实体 + 各 agent 链接；`skill where` 能对每个 agent 报出 `ok`/`dangling`/`foreign`/`missing` 之一
2. skill 正文**零硬编码**：不出现 `TABLES` 里的任何表名、不出现 SQL 关键字序列——`skill check` 主动扫出违规并退出码 1
3. `skill check` 能在 CI 里跑（不依赖 `~/.agents/skills` 存在）
4. 人为把 skill 里某个 flag 写错 → `skill check` 必须变红（变异验证）
5. 人为从 `CommandSpec` 删掉一个 flag → 对应命令的真实解析也必须失效（证明是同一事实源，不是抄了两份）
6. `qiyu --version` 输出 `{"ok":true,"data":{version, skill_contract_version}}`
7. postinstall 在任何失败下都 `exit 0`，不影响 npm 安装
8. 首次运行遇到「未安装」与「已安装但内容不一致」**两种**状态时，`meta.warnings` 各出现对应提示且退出码不变；一致时不提示
9. 链接目标改用 `path.relative` 现算：在 `~/.claude/skills` 下建出的链接能正确解析到实体（用临时 home 目录做断言，不碰真实 `~`）

## 五、不在本次范围

- 不写 `~/.agents/.skill-lock.json`（C2/C3 的理由）
- 不做 `kinds` / `exits` 的逐命令声明（D4 的理由）
- 不实现 `--pretty`（仍是显式拒绝，`skill check` 会把它当违规推荐）
- 不做 skill 的多语言版本（全文中文，与仓库约定一致）
