# qiyu-cli

网易七鱼（Qiyu）开放 API 的命令行封装，**主要用户是 AI Agent，人类是次要用户**。

它把七鱼官方 API 的一堆"对 Agent 不友好"之处抹平成一套可预测的契约：默认输出机器可读的
JSON、用退出码表达该做什么、错误按语义分类、危险操作有硬门禁。有了它，Agent 不必先学会
七鱼 API 的 26 种响应信封、3 种分页和一堆静默失败，就能正确调用。

> **本仓库仍在早期**：已实现「认证 + 通用 API 通道」＋ API 参数校验（`api schema`/body 分级校验）（见[当前状态](#当前状态)）。
> 本地数据仓库、查询、同步等能力尚未实现。

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

需要 Node.js ≥ 20.10。

```bash
# 作为一次性命令运行（推荐）
npx qiyu-cli --help

# 或全局安装
npm install -g qiyu-cli

# 或从源码构建
git clone https://github.com/MisonL/qiyu-cli.git
cd qiyu-cli && npm install && npm run build
```

> `qiyu-cli` 零运行时依赖。`npm install` 是为构建（TypeScript）与测试准备的。

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
`auth_missing` / `confirm_required` / `local_rate_limit` / `unknown`）。合成词在官方
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
限频感知（`retry_after`）。

body 分级校验：`api call` 的 `--body` 与注册表参数表比对——缺必填拒绝（退出码 2），
未知字段/类型不符出 `meta.warnings`；`--strict` 可升级、`--no-validate` 可关闭。
参数表见 `qiyu api schema <id>`（`data.params`、`data.response_shape`）。
只依据文档生成的参数表，不构成对服务端行为的保证；**响应体不做校验**；
校验只对 `body_kind: json` 且有 body 参数表的接口生效，其余原样透传。
`--strict` 只做本地参数表闭集一致性检查（「严格」≠「正确严格」），误拒时**不要删字段重试**。

**尚未实现**（调用时会**明确报错**，不会静默假装成功）：

- `auth login`（配置文件写入）——目前只支持环境变量；
- `--pretty`（人类可读输出）——目前只输出紧凑 JSON；
- 本地数据仓库（`store/`）、查询（`qiyu query`）、同步（`qiyu sync`）；

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

### 目录结构

```
src/
  cli.ts                入口与顶层分派
  output.ts             输出契约（ok / fail / usageFail，退出码）
  commands/             子命令（auth / api）
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
