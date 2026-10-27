// src/commands/api.ts
import { allEndpoints, byId, assertCallable, assertConfirmed } from '../core/registry/index.js'
import type { EndpointSpec } from '../core/registry/index.js'
import { resolveCredentialsUsingFile, currentCredentialEnv } from './credentials-source.js'
import { call } from '../core/http.js'
import { registeredRateLimit } from '../core/ratelimit.js'
import type { QiyuError } from '../core/errors.js'
import type { ParamSpec } from '../core/registry/params.js'
import type { ValidationOverride } from '../core/registry/validation-overrides.js'
import { loadValidationOverrides } from '../core/registry/validation-overrides.js'
import { loadParams } from '../core/registry/params.js'
import { effectiveBodyParams, normalizeAliases, validateBody } from '../core/validate.js'
import { ok, fail, usageFail, describeArgs, setPretty, EXIT } from '../output.js'
import { sanitizeMessage } from '../core/sanitize.js'
import { localFallbackFor } from './local-fallback.js'
import { callFieldNotes } from './api-notes.js'
import { GLOBAL_FLAGS, prettyAfterSubcommand, REJECTED_FLAGS, renderFlagNames } from './spec-types.js'
import type { CommandSpec, FlagSpec } from './spec-types.js'

/** `api list` 的业务 flag（`flags` 里还要再并上全局 flag）。 */
const LIST_FLAGS: FlagSpec[] = [{ name: '--all', kind: 'bool' }]
/** `api call` 的业务 flag；顺序即「可用：」文案的顺序。 */
const CALL_FLAGS: FlagSpec[] = [
  { name: '--body', kind: 'value' },
  { name: '--yes', kind: 'bool' },
  { name: '--no-validate', kind: 'bool' },
  { name: '--strict', kind: 'bool' },
]
/** `api schema` 没有业务 flag——只有全局 flag（其中 `--pretty` 在 rejected 里）。 */
const SCHEMA_FLAGS: FlagSpec[] = []

/**
 * 命令契约（F 组 D4）：`skill check` 据此判断 skill 正文里的 `qiyu api …` 是否真的存在。
 * `flags` 是**完整接受集**（含全局 flag），`--pretty` 同时在 `rejected` 里。
 */
export const API_SPECS: CommandSpec[] = [
  {
    path: ['api', 'list'],
    flags: [...GLOBAL_FLAGS, ...LIST_FLAGS],
    positionals: [],
    rejected: REJECTED_FLAGS,
  },
  {
    path: ['api', 'call'],
    flags: [...GLOBAL_FLAGS, ...CALL_FLAGS],
    // `callable-endpoint-ids`（G3 审查 C2）：`api call` 只能调 `callable: true` 的接口，
    // 用全集会把 `api call crm.modifyOrder`（真实 exit 2「不可主动调用」）判成合法。
    //
    // ⚠️ `first: true`（G9）—— 唯一一条带位置纪律的命令：`callOne` 是 `const [id] = argv`，
    // 把 `argv[0]` 直接当接口 id，`qiyu api call --yes ticket.search` 报「接口 id 必须是
    // 第一个参数」退出 2。相邻的 `api schema` **不标**：它先用 `filter` 剥掉 flag 再取
    // 位置参数，`api schema --pretty ticket.search` 与 `ticket.search --pretty` 同答。
    positionals: [{ name: '接口id', domain: 'callable-endpoint-ids', first: true }],
    rejected: REJECTED_FLAGS,
  },
  {
    path: ['api', 'schema'],
    flags: [...GLOBAL_FLAGS, ...SCHEMA_FLAGS],
    // 与 `api call` 不同：`api schema` 只查形状，对 `callable: false` 的接口同样合法
    // （实测 `api schema crm.modifyOrder` → 退出码 0），所以这里用全集 `endpoint-ids`。
    positionals: [{ name: '接口id', domain: 'endpoint-ids' }],
    rejected: REJECTED_FLAGS,
  },
]

/** 各子命令的 `KNOWN`：解析器接受的 token 集 = spec 的完整接受集，两处同源。 */
const LIST_KNOWN = new Set([...GLOBAL_FLAGS, ...LIST_FLAGS].map((f) => f.name))
const CALL_KNOWN = new Set([...GLOBAL_FLAGS, ...CALL_FLAGS].map((f) => f.name))
const SCHEMA_KNOWN = new Set([...GLOBAL_FLAGS, ...SCHEMA_FLAGS].map((f) => f.name))

/**
 * 「可用：…」文案里的 flag 清单。`api list` 只有 `--all`，从常量渲染即可。
 * ⚠️ `api call` / `api schema` 的文案保持**字面量**：`readme.test.ts:58` 按**源文本**
 * 钉着 `可用：--body <JSON>、--yes、--no-validate、--strict`，改成渲染会让它变红；
 * 而两处的运行时文案又被 `api.test.ts` 钉着，不能改。事实源仍是上面的 `FlagSpec` 常量
 * ——`command-tree.test.ts` 有一条断言把文案里点名的 flag 与 spec 的接受集对齐。
 */
const LIST_AVAILABLE = renderFlagNames(LIST_FLAGS)

const API_USAGE = `用法：qiyu api <list|call|schema> [参数]

  qiyu api list [--all]                      列出接口
  qiyu api schema <接口id> [--pretty]          查看接口的请求参数表
  qiyu api call <接口id> [--body <JSON>] [--yes] [--no-validate] [--strict]   调用接口

--all     连同不可主动调用的接口一起列出
--body    请求体（JSON 字面量）。省略与传 {} 是两条不同的服务端路径
--yes     危险接口（写/破坏性操作）必须显式确认
--no-validate  关闭 body 校验（危险门禁不受影响）
--strict       把「未知字段/类型不符」的提示升级为拒绝

出错时 stdout 是 {"ok":false,"error":{code,kind,retryable,message,hint?}}。
  ⚠️ 请按 kind 分支，不要按 code —— code 只是个标签：它可能是服务端的
     数字码（如 14009），也可能是本 CLI 合成的词（usage / network / internal /
     auth_missing / config_insecure / confirm_required / store_locked / store_not_initialized / local_rate_limit / unknown）。合成词查不到官方错误码表。

退出码：0 成功 · 1 业务错误 · 2 用法错误 · 3 网络错误 · 4 需要 --yes
`

export async function apiCommand(argv: string[]): Promise<number> {
  setPretty(false) // G1：每条命令入口重置输出格式 —— 同一进程内多次 run（测试）不残留上一条命令的开关。
  const [sub] = argv
  // ⚠️ 子命令层的 --help 必须走 stdout + 退出码 0，与顶层一致。
  // 否则 `qiyu api --help` 会得到「用法：qiyu api <list|call|schema>」+ 退出码 2 ——
  // Agent 请求帮助却拿到一个错误，这是坏交互。
  // ⚠️ `--help` 不吞额外参数（2026-10-08 修）—— 与叶子命令同一条次序
  // （未知/位置参数 → help）：实测 `qiyu api --help --bod` / `qiyu api --help extra`
  // 此前返回 0，拼错的 flag / 多余的位置参数被静默吞掉（`qiyu api --bod` 单独跑是 2）。
  // `--help --help` 仍给帮助（与 `api list --help --help` 同答）。
  if (sub === '--help' || sub === '-h') {
    // ⚠️ `--help` 不吞额外参数（2026-10-08 修）—— 与叶子命令同一条次序
    // （未知/位置参数 → help）：实测 `qiyu api --help --bod` / `qiyu api --help extra`
    // 此前返回 0，拼错的 flag / 多余的位置参数被静默吞掉（`qiyu api --bod` 单独跑是 2）。
    // `--help --help` 仍给帮助（与 `api list --help --help` 同答）。
    // ⚠️ `--pretty` 同样豁免（2026-10-08）：`qiyu api --help --pretty` 给帮助
    // （与 `api list --help --pretty` 同答）—— `--pretty` 是合法 flag，不是"额外参数"。
    const extra = argv.slice(1).filter((a) => a !== '--help' && a !== '-h' && a !== '--pretty')
    if (extra.length > 0) {
      return usageFail(`未知参数：${describeArgs(extra)}。--help 不接受额外参数`)
    }
    process.stdout.write(API_USAGE)
    return EXIT.OK
  }
  // ⚠️ 分派层的 `--pretty`（G1 起已实现，原"未实现"话术退役）：它必须写在具体
  // 子命令之后（`api list --pretty`）。次序保持 **未知/位置 → help → pretty 指引**。
  if (sub === '--pretty') {
    const unknown = argv.slice(1).filter((a) => a.startsWith('-') && a !== '--pretty' && a !== '--help' && a !== '-h')
    const positional = argv.slice(1).filter((a) => !a.startsWith('-'))
    const extra = [...unknown, ...positional]
    if (extra.length > 0) {
      return usageFail(`未知参数：${describeArgs(extra)}。--pretty 不接受额外参数`)
    }
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(API_USAGE)
      return EXIT.OK
    }
    return usageFail(prettyAfterSubcommand('api'))
  }
  if (sub === 'list') return list(argv.slice(1))
  if (sub === 'schema') return await schema(argv.slice(1))
  if (sub === 'call') return callOne(argv.slice(1))
  // ⚠️ 用法错误必须也出 stdout JSON（见 output.ts 的 `usageFail` 说明）：
  // 人类在 stderr 读用法，Agent 在 stdout 读 `{ok:false,error}`。
  //
  // ⚠️ **必须点名那个 token**（2026-10-05 修）。此前这里只吐整段用法，Agent 收到
  // 一屏文字却不知道自己错在哪 —— 而顶层 `run()` 的同类分支**是**点名的
  // （`未知子命令：${sub}` + 可用清单）。同一条契约在两层行为不一致，Agent 无法
  // 学会一个统一的规则。子命令层只有两个（list/call），点名的成本是零。
  //
  // 顺带修掉无参数的情形：`qiyu api`（sub 为 undefined）不该被说成"未知子命令：
  // undefined"—— 那是一句**事实错误**的说明（undefined 不是用户写的东西）。
  // 顶层 `run()` 的 `if (!sub)` 已经把这两件事分开了，这里照做。
  if (!sub) {
    return usageFail(`用法：qiyu api <list|call|schema> [参数]（\`qiyu api --help\` 查看全部）`,
      '可用子命令：list、call、schema')
  }
  // ⚠️ 用 describeArgs 渲染 sub（2026-10-08 修）：`qiyu api " "` 此前报
  // 「未知子命令： 」—— 名字是纯空白、不可见（与空串参数同一个病）。
  return usageFail(
    `未知子命令：${describeArgs([sub])}\n可用子命令：list、call、schema`,
    '`qiyu api --help` 查看完整用法')
}

function list(argv: string[]): number {
  // ⚠️ **次序是：先证明命令行合法 → 再判 help → 再判 --pretty**（2026-10-05 修）。
  // 这个次序是三条约束一起逼出来的，任何一条单独看都会给出错误的排法：
  //
  // ① 「未知参数不能静默忽略」→ 未知 flag 必须**先于** help 报错。
  //    此前用 `argv.includes('--help')` 全量匹配，`api list --al --help` 返回
  //    **退出码 0**、`--al` 被无声丢弃（而 `api list --al` 单独跑是 2）——
  //    "多带一个 --help"把一条用法错误变成了静默成功。
  // ② 「help 本该永远成功」→ help 必须**先于** `--pretty` 报错。
  //    此前 `--pretty` 的分支排在 help 前，`api list --pretty --help` 返回 **2**，
  //    Agent 请求帮助却拿到错误 —— 违反这句注释自己的结论。
  // ③ 「说明文字不能与事实相反」→ help token 必须进 KNOWN，否则
  //    `api list --all --help` 会报「未知参数：--help」——一句**事实错误**的说明
  //    （`--help` 确实是合法 flag）。
  // 三条合起来 → 检查顺序必须是「未知/位置参数 → help → --pretty」。
  // ⚠️ `callOne` 2026-10-08 起与这里逐字同序（此前它 help 只认**首个** token、
  // `--pretty` 又排在位置参数之前，实测三处不一致 —— 见 `callOne` 内注释）。
  const KNOWN = LIST_KNOWN
  // ⚠️ 判据是"以 `-` 开头"，不是"以 `--` 开头" —— 否则单横线的 `-x` 既不算
  // 未知参数、也不进位置参数（那条的判据同样收在"不以 `-` 开头"），会被**静默
  // 丢弃**（2026-10-08 反事实实测：单改本判据为 `--`，`api list -x` 返回 0、
  // stderr 空、全量照发）。⚠️ 更早的版本里**两条判据都是 `--` 开头**（d105d9d
  // 一次改了四条），那时 `-x` 会被位置参数分支接住、报出
  // 「未知参数：-x。api list 不接受位置参数」—— 一句话里两个错误：
  // 它不是位置参数，且 `-h` 是 `--help` 的别名、本不该报"未知"。
  // 本条判据与位置参数那条是**一对**，动一个必须同时想另一个。
  const unknown = argv.filter((a) => a.startsWith('-') && !KNOWN.has(a))
  if (unknown.length > 0) {
    return usageFail(`未知参数：${describeArgs(unknown)}。可用：${LIST_AVAILABLE}`)
  }
  // ⚠️ 位置参数也必须报错。`api list` 不接受任何位置参数，而此前它们被**无声丢弃** ——
  // 实测 `api list extra` 返回退出码 0 与全部 9 行（默认过滤后的行数）。这与下面 `call` 的情况同族：
  // 拼错一个 flag 会被拦下（`--al` → 退出码 2），写错一个位置参数却被放过。
  const positional = argv.filter((a) => !a.startsWith('-'))
  if (positional.length > 0) {
    return usageFail(`未知参数：${describeArgs(positional)}。api list 不接受位置参数，可用：${LIST_AVAILABLE}`)
  }
  // 命令行已证明合法 —— 现在 help 优先于其余（见上方 ②）。
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(API_USAGE)
    return EXIT.OK
  }
  // G1：--pretty 已实现 —— 原拒绝点开启缩进输出（次序不变：未知/位置 → help → 这里）。
  if (argv.includes('--pretty')) setPretty(true)

  const all = argv.includes('--all')
  const rows = allEndpoints()
    .filter((e) => all || (e.callable && e.direction === 'outbound'))
    .map((e) => ({
      id: e.id, title: e.title, method: e.method, path: e.path,
      // direction 必须输出：调用方要据此区分"我们能调它"与"它回调我们"
      direction: e.direction,
      callable: e.callable, dangerous: e.dangerous,
      // verified 必须输出：它区分"实测过、可依赖"与"只有文档依据"。
      // ⚠️ 本计划 11 条里只有 2 条是 `callable && !dangerous && verified`
      // （ticket.search、robot.transfer.config），其余可调用的都是**成功路径未走通**的
      // 写接口（6 条从未调用过；`settings.wxTemplates` 被调用过但每次都停在 14004，
      // 见「已知缺口」）。Agent 不看这个字段就会把"注册了"当成"验证过了"。
      verified: e.verified, note: e.note,
      // ⚠️ maxWindowDays 必须输出，且**只在存在时输出**。
      // `14501` 的 hint 让 Agent 来 `api list` 查它 —— 若这里不输出，
      // 那条 hint 就是一句指向不存在能力的承诺。Agent 只能猜切片宽度，
      // 按文档值（如工单的 90 天）切会每片静默少取约 58 天。
      //
      // ⚠️ **这里只输出、不校验，别把这段注释读成"CLI 已经会拦超限窗口"。**
      // 设计稿 §7.4.1 要求的是「CLI 不能靠错误码判断『超限』；它必须按注册表里的
      // `maxWindowDays` **预先校验**」。本计划 `call()` 没有这道预检 ——
      // 缺它是因为注册表**没有 `params`**（窗口起止在哪个字段里都不知道）。
      // 兑现的是「**让 Agent 能自己查到上限**」，不是「替 Agent 拦住」。
      // 详见「已知缺口」里 `maxWindowDays` 那条。
      //
      // ⚠️ 这个数字是**上界，必须按"精确比较"理解**（`span <= N 天` 才安全）。
      // 设计稿 §7.4.1 实测：两个报表族用的判定式不同 —— `/openapi/statistic/*`
      // 是向下取整（31 天 + 23:59:59.999 也接受），而 `robot.statistic.summary`
      // 与 `transferHuman` 是精确比较（summary 在 31 天 + 1 毫秒就拒绝）。
      // 按严格形式校验对两族都正确，按向下取整理解则会在 summary 上多取一天并拿到 14004。
      ...(e.maxWindowDays !== undefined ? { max_window_days: e.maxWindowDays } : {}),
      // ⚠️ category 与 max_window_days 同款：**只在存在时输出**。
      // 4 个文档外接口（export.session 一族）没有文档页、自然没有分组 ——
      // 缺失 = 文档页无分组，不是数据缺口。来源是 Apifox 目录（x-apifox-folder），
      // 厂商调整文档结构时它可能变，不是稳定契约（见 field_notes.category）。
      ...(e.category !== undefined ? { category: e.category } : {}),
    }))
  // 注册表当前只有 11 条，而完整注册表最终是 154 条（150 文档页 + 4 文档外）。不告诉 Agent 这一点，
  // 它会把这 11 条当成 API 的全部能力，甚至据此判断"某功能不存在"。
  //
  // ⚠️ `registry_complete` 必须**由数据推导**，不能写死 `false`。
  // 此前它是字面量 `false`，而测试断言 `meta.registry_complete === false` ——
  // 那是"一个常量等于它自己"，能守住"键必须存在"，却守不住"它与注册表实际条数一致"：
  // 生成脚本把 specs.json 补齐到 154 条后，标志仍是 `false`，测试照样全绿 ——
  // 字段宣称描述注册表状态、实际与注册表无关，正是"契约不诚实"的典型。
  // 设计稿 §5.3 定的是 **150 个文档页面**；§7.5（设计稿 line 928）另点明有 **4 个接口
  // 不在那 150 个清单里、必须单独编入注册表** —— 是会话导出流水线的端点
  // （`export/session`、`export/session/check`、`export/session/one`、`/one/message`）。
  // ⚠️ 此前这里把它们标成「`smstask` 一族」是**错的**：smstask 出现在 §4.3/§7.4/§9.0，
  // 与 line 928 所在的 §7.5（会话导出流水线）无关 —— 按 smstask 去补会补错对象。
  // 故注册表完整阈值是 **154**，不是 150 —— 写 150 会让 `registry_complete` 在还缺那 4 条时提前翻成 true。
  // ⚠️ 此前这里写「设计稿 §2 定的是 150 条（+4 个不在此计划范围）」—— 两处都错：
  // ① §2 是「范围」，全节无任何接口计数（150 出自 §5.3）；② 「不在此计划范围」
  // 与设计稿 §7.5「必须单独编入注册表」直接冲突。生成脚本产出的必须是 154 条。
  // ⚠️ 设计稿 §13 第 3 条写「共 150 个」，那是在拆分文档页（132 可调用 + 17 不可调用
  // + 1 坏路径 = 150），同样不含那 4 条，不构成对 154 的反驳。
  const REGISTRY_TOTAL = 154
  // 与 `registry.test.ts` 里"限频表 id 与注册表 id 对得上"那条同源：都是从数据推导、
  // 并在数据补齐时**自动翻面**，而不是靠人记得改一个字面量。
  return ok(rows, {
    rows: rows.length,
    filter: all ? '全部' : '可主动调用',
    registry_complete: allEndpoints().length >= REGISTRY_TOTAL,
    // ⚠️ note 必须**跟着 registry_complete 走** —— 此前它无条件说「尚未收录全部接口」，
    // 而同一个 meta 里 registry_complete 可能已经是 true，两者自相矛盾：Agent 读到
    // complete=true 却又被告知「尚未收录」，不知道该信哪个。完整时要说「已收录」。
    registry_note: allEndpoints().length >= REGISTRY_TOTAL
      ? `注册表已收录全部接口（${allEndpoints().length}/${REGISTRY_TOTAL}）`
      : `注册表尚未收录全部接口（当前 ${allEndpoints().length}/${REGISTRY_TOTAL}）；` +
        '未列出的接口不等于不存在',
    // ⚠️ 逐条字段的含义必须写出来，否则 verified 就是一个"声明了但没人读"的字段。
    field_notes: {
      // ⚠️ 全局措辞**不能**比每行 note 承诺得更多（2026-10-07 改）。
      // 旧文「true = 已对线上实测过」——但 receive.message 的 true 指的是
      // 「不可主动调用已实测」，其信封恰恰**无从实测**（见该行 note）；
      // 旧文「false = 仅有文档依据」——但 settings.wxTemplates 实测时真调用过
      // （每次都 14004 appId not bind，错误模式有实测片段，只是成功路径没走通）。
      // 全局只当**索引**：true/false 各自测到/没测到什么，以该行 note 为准。
      verified: 'true = 已实测（实测范围以该行 note 为准，各不相同）；' +
        'false = 成功路径未实测（已知的实测片段同样以该行 note 为准）',
      dangerous: 'true = 危险操作，调用时需 --yes',
      // ⚠️ direction 也必须解释 —— 它是 Agent 判断「我方能调它」还是「它回调我方」
      // 的唯一依据。只输出 `outbound`/`inbound` 两个英文词，Agent 无从知道哪个
      // 是"我可以主动调用"，可能对着 inbound 的接口去拼 URL（那类接口路径是
      // 占位符 `/`，拼出来必然 404）。与 verified/dangerous 同一条标准：只输出
      // 不解释 = 没输出。
      direction: 'outbound = 本方主动调用它；inbound = 对方向本方推送（不可主动调用，' +
        '其 path 是占位符 `/`，拼 URL 必然失败）',
      callable: 'false = 结构上不可主动调用（如 inbound 推送）；Agent 只能查、不能调',
      // ⚠️ **`path` 的两种"不可用"必须区分**（2026-10-05 加）。`api list --all` 会输出
      // `path: null` 的行（`wecom.robot.switch` 的文档页 paths 键是中文散文、解析不出路径）。
      // 而 `direction` 那条 note 说的是「outbound = 本方主动调用它」—— 于是一个
      // `direction: outbound` + `path: null` 的组合**自相矛盾**：方向说"能主动调"，
      // 路径却不存在。Agent 无从判断该信哪个，最可能的两种猜法都错：
      // ① 拿 `id` 去猜路径拼 URL（必然 404，且错误与真实原因无关）；
      // ② 认为该接口"方向未知"从而不去用它 —— 而它其实只是**路径未收录**。
      // 必须点明：`null` = 路径未收录（数据缺口），不是"方向未知"也不是"不存在"。
      path:
        '本行 path 的两种不可用形态含义不同：' +
        '`null` = **路径未收录**（文档页未提供可用路径，是数据缺口；不代表接口不存在，' +
        '也不影响 direction 判定 —— 该接口仍可能是本方可主动调用的）；' +
        '`"/"` = **入站推送的占位符**（path 是占位符不是真实路径，见 direction 说明）。' +
        '两种情况都**不可**据此拼 URL 调用。',
      // ⚠️ `max_window_days` 的语义必须解释 —— 它是最容易被误读的字段。
      // 设计稿 §7.4.1 实测两个报表族的判定式不同（一个向下取整、一个精确比较），
      // 而字段只存一个数字。若不说明"按精确比较理解"，Agent 会按向下取整
      // 切到"31 天零 23 小时"，然后在精确比较的接口（robot.statistic.summary）
      // 上撞 14004 —— 而它无从知道是自己把上界理解松了。
      max_window_days:
        '时间跨度上界（天），**按精确比较理解**：必须 `end - start <= max_window_days * 86400000` 毫秒。' +
        '不要按"向下取整"切到 N 天零若干小时 —— 部分接口（robot.statistic.summary）会拒绝。' +
        '未输出该键的接口没有已知上限',
      // ⚠️ category 的**来源与稳定度**都必须说清：它是 Apifox 文档目录路径，
      // 不是厂商 API 契约的一部分。不说清，Agent 会把它当稳定枚举去写分支逻辑
      // （如按 category 前缀选接口），而厂商调一次文档结构就全线失效。
      category:
        '文档页所属分组（Apifox 目录路径，如 `工单系统`、`机器人/知识库管理`），' +
        '**仅供人读/检索，不是稳定契约** —— 厂商调整文档结构时会变。' +
        '未输出该键 = 文档页无分组（4 个文档外接口），不是数据缺口。不要据此写分支逻辑',
      // ⚠️ **必须说清"没有哪些字段"**（2026-10-05 加）。上面每条都只解释**存在**的
      // 字段，而 Agent 真正会做错的动作是：读到 `id` + `title` 就以为可以据此拼出
      // 一次调用 —— 但注册表**没有** `params`/`responseShape`（见「已知缺口」），
      // 所以它拼出的 body 只能靠猜。本计划反复强调"声明了但没人读的字段"，
      // 这是它的镜像：**没声明的字段，Agent 会以为不存在（或以为自己能推出来）**。
      // 一句话点破"要参数得去查文档"，比让 Agent 在 14004 或静默忽略上撞墙便宜得多
      // （⚠️ 不是 14003 —— 那是 `time` 错误、鉴权层的码，与 body 字段无关）。
      request_schema:
        '本 meta 不含参数表（体积考虑）；用 `qiyu api schema <id>` 查该接口的 `params`/`response_shape`。' +
        '`api call --body` 会做**有限**校验（缺必填拒绝、未知字段/类型提示）——见 `api schema` 的 ' +
        '`meta.field_notes`。⚠️ **响应体不做校验**，`response_shape` 仅供参照。' +
        '⚠️ `--strict` 把「未知字段/类型不符」升级为拒绝，但那是「本地参数表闭集一致性」检查，' +
        '**不是对服务端行为的保证**——参数表漏记时它会误拒合法字段，此时**不要删字段重试**。' +
        '⚠️ 传错的字段可能被服务端以 **14004** 拒绝，也可能被**静默忽略**——**别把「返回成功」当作「字段写对了」**。',
    },
  })
}

const SCHEMA_USAGE = `用法：qiyu api schema <接口id> [--pretty]\n\n  查看某接口的请求参数表（params）与响应形状（response_shape）。\n\n--pretty  输出缩进 JSON（人类可读；Agent 解析不需要它，默认紧凑输出已是合法 JSON）\n`

async function schema(argv: string[]): Promise<number> {
  const unknown = argv.filter((a) => a.startsWith('-') && !SCHEMA_KNOWN.has(a))
  // ⚠️ 文案逐字保留 `可用：--pretty`：历史输出只列这一项（`--help`/`-h` 是帮助开关，
  // 不进「可用参数」清单）；`--pretty` 本身在 spec 的 `rejected` 里，不能从 `flags` 派生。
  if (unknown.length > 0) return usageFail(`未知参数：${describeArgs(unknown)}。可用：--pretty`)
  const positional = argv.filter((a) => !a.startsWith('-'))
  const help = argv.includes('--help') || argv.includes('-h')
  // 3a/3b：help 优先于「缺 id」与「位置参数 > 1」，但自身检查位置参数
  if (help) {
    if (positional.length > 0) return usageFail(`未知参数：${describeArgs(positional)}。--help 不接受额外参数`)
    process.stdout.write(SCHEMA_USAGE)
    return EXIT.OK
  }
  if (positional.length > 1) return usageFail(`未知参数：${describeArgs(positional.slice(1))}。api schema 只接受一个接口 id`)
  // G1：--pretty 已实现 —— 原拒绝点开启缩进输出。
  if (argv.includes('--pretty')) setPretty(true)
  if (positional.length === 0) return usageFail('用法：qiyu api schema <接口id>')
  const id = positional[0]
  try {
    const spec = byId(id)
    const file = loadParams(spec.id)
    const ov = loadValidationOverrides()[spec.id]
    const bodyParams = effectiveBodyParams(file, ov)
    const hasBodySchema = file.bodyKind === 'json' && bodyParams.length > 0
    const AUTH = new Set(['appKey', 'time', 'checksum'])
    // ⚠️ params 输出的 required 必须是应用 override 之后的值，且必须与 validateBody 共用 effectiveBodyParams。
    const effBody = effectiveBodyParams(file, ov)
    const effByName = new Map(effBody.map((p) => [p.name, p]))
    const params: SchemaParam[] = file.params.map((p) => {
      const base = p.in === 'body' ? (effByName.get(p.name) ?? p) : p
      return p.in === 'query' && spec.callable && spec.auth === 'checksum' && AUTH.has(p.name)
        ? { ...base, auto: true as const } : { ...base }
    })
    const data: Record<string, unknown> = {
      id: spec.id, title: spec.title, method: spec.method, path: spec.path,
      callable: spec.callable, dangerous: spec.dangerous,
      body_kind: file.bodyKind, has_body_schema: hasBodySchema,
      params, response_shape: file.responseShape,
      ...(ov?.oneOf ? { one_of: ov.oneOf } : {}),
    }
    // ⚠️ rate_limit 是**三态**（G1 交付，设计稿 §9.1 示例里声明过该字段）：
    //   · 未登记（undefined）→ **不输出该键**（没测过，说什么都是编的）
    //   · 显式 null          → 输出 `null`（实测过，确实没有限频）
    //   · 有限频             → 输出对象（含 scope，见 ratelimit.ts 的类型注释）
    // 三态不能压成两态：把"没测过"也报成 null 等于谎称实测无限频，
    // 而 Agent 会据此去掉退避逻辑。`limitFor` 把两者合并成 null（`call()` 要的
    // 语义），这里必须用 `registeredRateLimit` 区分。
    const rl = registeredRateLimit(spec.id)
    if (rl !== undefined) {
      data.rate_limit = rl === null
        ? null
        : { limit: rl.limit, window_seconds: rl.windowSeconds, source: rl.source, scope: rl.scope }
    }
    return ok(data, {
      endpoint: spec.id,
      ...(spec.note ? { note: spec.note } : {}),
      field_notes: {
        rate_limit:
          '本键**三种形态含义不同**：' +
          '① 不出现该键 = 该接口**未登记**在本地限频表（没测过，不要假定它与 null 同义）；' +
          '② `null` = 实测过，**确实没有限频**；' +
          '③ 对象 = 有限频：`limit`（窗口内允许次数）/ `window_seconds`（窗口长度）/ ' +
          '`source`（`observed` = 对本租户实测 / `doc` = 抄自厂商文档、未实测）/' +
          '`scope`（当前恒为 `endpoint` = 按路径各自独立；**尚未观测到跨接口共享配额**）。' +
          '⚠️ 限频桶是**进程内**的，跨 `qiyu api call` 不共享状态 —— 本表只用于告诉调用方' +
          '「撞上限流后该等多久」，不承诺 CLI 会替你排队',
        has_body_schema: 'true = 本接口有可比对的 body 参数表（body_kind 为 json 且 body 参数数 > 0）；不代表本次请求已校验，也不代表其余 bodyKind。本次校验结果见 api call 的 meta.warnings',
        body_kind: '只有 json 会被 api call 比对字段，其余（none/xml/multipart/text/form）原样透传不校验',
        auto: 'true = 仅对 callable 且 auth 为 checksum 的接口，CLI 自填鉴权 query 参数（appKey/time/checksum）；入站/eventType 接口由回调方提供，不标 auto，调用方不要也不能通过 --body 传',
        dangerous: 'true = 危险操作，调用时需 --yes，否则退出码 4。必须由人类确认，不要自动追加 --yes',
        callable: 'false = 结构上不可主动调用（如 inbound 推送）；Agent 只能查、不能调',
        path: 'null = 路径未收录（数据缺口）；"/" = 入站占位符。两者都不可据此拼 URL',
        response_shape: '仅供参照，不做校验',
        one_of: 'one_of 数组每项是一组「组内任一存在即可满足」的字段，全缺会被拒绝（退出码 2）；组内字段的 required 已因此降为 false —— false 是「二选一」的意思，不是「两个都可省」',
      },
    })
  } catch (e) {
    // 与 callOne 的 catch 共用唯一出口；schema 不经过门禁。
    return mapThrownToExit(e)
  }
}

async function callOne(argv: string[]): Promise<number> {
  const [id] = argv
  if (!id) {
    return usageFail('用法：qiyu api call <接口id> [--body <JSON>] [--yes] [--no-validate] [--strict]')
  }
  // ⚠️ 接口 id 必须是第一个参数。若第一个 token 是 flag（`--yes`/`--body`/`--bod`…），
  // 用户把 flag 写在了 id 之前 —— 此前它会落到 `byId('--yes')` 报出
  // 「未知接口：--yes」，一句**事实错误**的说明（`--yes` 是 flag，不是接口 id）。
  // 给出准确、可操作的指引，而不是让 Agent 去猜 `--yes` 是不是某个接口的名字。
  //
  // ⚠️ `--help`/`-h` 是**唯一的例外**（2026-10-08 修）：它们是"请求帮助"，
  // 不是"写错位置的接口 id"，判定挪到了下面 —— 与 `list()` 同一条次序
  // 「未知/位置参数 → help → `--pretty`」。此前这里是"首个 token 特判且排在最前"，
  // 实测三处与 `list()` 不一致，且都是"同形状两种答案"：
  //   · `api call --help --bod` 返回 0、`--bod` 被静默吞掉（`api list --al --help` 是 2）；
  //   · `api call --help extra` 返回 0、位置参数被吞（`api list --help extra` 是 2）；
  //   · `api call ticket.search --help` 报「未知参数：--help」—— 而 `--help` 是**合法
  //     flag**，这句说明与事实相反（`api list --all --help` 给帮助、退出码 0）。
  // 后者的修法：`<id> --help` 也给帮助。给的是**通用** `API_USAGE`（本 CLI 没有
  // 逐接口帮助 —— 那需要注册表的 `params`，见「已知缺口」）；用法开头就是
  // `qiyu api <list|call>`，不会被误认成某个接口的帮助。
  // ⚠️ 其余 flag 出现在 id 位置仍是**结构性错误**，它先于 help 报出：
  // `api call --pretty --help` 报「接口 id 必须是第一个参数」而不是给帮助 ——
  // 缺 id 是硬错误，help 修不了它（与 `list()` 的「未知/位置参数 → help」同源）。
  if (id.startsWith('-') && id !== '--help' && id !== '-h') {
    return usageFail(
      `用法：接口 id 必须是第一个参数，但你给的是 flag \`${id}\`。\n` +
        '正确写法：qiyu api call <接口id> [--body <JSON>] [--yes] [--no-validate] [--strict]',
    )
  }

  // ⚠️ **参数校验必须全部在 `byId(id)` 之前。** 此前它们是交错在 `byId`/
  // `assertConfirmed` 之间的，导致两个可证实的缺陷（2026-10-04 记录）：
  //
  // ① **事实错误的报错文案**：`callOne` 先 `byId(argv[0])`，而 flag 写在接口 id
  //    之前时 `argv[0]` 就是那个 flag，于是 `api call --yes message.send` 报出
  //    「未知接口：--yes」—— `--yes` 是 flag，不是接口 id，这是一句事实错误的说明。
  //    本文件多处（`api call --help` 那段、`api list -h` 那段）反复强调"说明文字
  //    不能与事实相反"，`--help`/`-h` 被特判救下了（2026-10-04 当时是"首个 token
  //    特判"；2026-10-08 起改为"id 位置检查里豁免 help"—— 效果同：help 不落进
  //    这条分支），其余 flag 全部漏网。
  // ② **门禁掩盖参数错误**：`assertConfirmed` 在 `--body` 的 JSON 校验之前执行，
  //    于是对一个危险接口传非法 JSON / 未知 flag / 位置参数时，**一律**得到
  //    「需要 --yes」（退出码 4），参数错误被门禁掩盖。Agent 先被要求"加 --yes
  //    重来"，加了才发现参数是错的 —— 而退出码语义的本意是"改参数重来"（2）
  //    与"别重试了"（4）要能分开。
  //
  // → 正确顺序：**先证明命令行本身合法（退出码 2 的所有情形），再谈接口是否存在、
  //    是否可调用、是否需要确认。** 这两类错误都该在发请求前拦下，但退出码语义
  //    不同，且"你参数写错了"是无条件的真，不依赖接口是什么。

  const i = argv.indexOf('--body')
  // ⚠️ `--body` 的**值位置**（`i + 1`）不参与 flag 判定 —— 一个恰好以 `-` 开头的
  // **值**（如 `--body --yes`）是值、不是 flag。`i >= 0` 不能省：没有 `--body` 时
  // `i + 1 === 0`，会把**接口 id 的位置**误判成值位置。
  // ⚠️ 规则（2026-10-08 定型）：**排在 body 解析之前的 flag 判定必须跳过值位置**
  // （下面两处：未知参数、位置参数）；**排在 body 解析之后的不用跳**（help、`--pretty`）——
  // 能走到那里的值位置 token 必已通过 `JSON.parse`，而 `--help`/`-h`/`--pretty`
  // 都不是合法 JSON 文本，物理上不可能出现在那个位置。
  // 此前 `--pretty` 的判定排在 body 解析**之前**又用裸 `argv.includes`，两处叠加，
  // 于是 `api call ticket.search --body --pretty` 报「--pretty [未实现]」，
  // 而 `api call ticket.search --body --yes` 报「不是合法 JSON：--yes」：
  // 同一个值位置，两种答案（2026-10-08 修：判定挪到 body 解析之后，与 `list()` 同形）。
  // ⚠️ 这条规则在 2026-10-24（--pretty 实现）后仍必须保持 —— 值位置优先的判据是
  // 「token 是否落在 --body 的取值位」，与那个 flag 实不实现无关。
  const isBodyValue = (idx: number) => i >= 0 && idx === i + 1

  // ⚠️ `--body` 重复出现必须报错。`--body` 在 KNOWN 集合里，所以第二次出现时
  // 既不算未知参数、也不会被当作"第一个 --body 的值"跳过 —— 结果是第二个被
  // 无声丢弃，请求带着第一个 body 照常发出（实测：`--body '{"a":1}' --body '{"b":2}'`
  // 发出的 body 是 `{"a":1}`、退出码 0）。这与下面「未知参数不能静默忽略」
  // （`--bod` 拼错会报错）是同一族问题：拼错字母被拦下，重复 flag 却被放过。
  //
  // ⚠️ **只有 `--body` 需要这条检查，`--yes` 不需要** —— 这是刻意的不对称，
  // 不要"为了统一"给 `--yes` 也加上（`api list` 的 `--all` 同理）：
  //   · `--body` 带**值**，且取值方式是 `indexOf`（**第一个赢**）。重复出现时
  //     第二个值被**静默丢弃**，而 Agent 以为自己提交了两个里较新的那个 ——
  //     请求内容与它的意图不符，属于本计划要消灭的那一类静默失败。
  //   · `--yes` 是**布尔**开关，取值方式是 `argv.includes('--yes')` —— 幂等。
  //     `--yes --yes` 与 `--yes` 的行为逐字节相同，不存在"被丢弃的值"，
  //     也不存在两种读法。为它报错是**给一个无歧义的输入制造错误**：
  //     退出码 2 的语义是"改参数重来"，而这里没有任何东西需要改。
  // → 判据是**"重复是否会丢掉一个值"**，不是"是否为布尔 flag"。
  if (i >= 0 && argv.indexOf('--body', i + 1) >= 0) {
    return usageFail('用法：--body 只能出现一次')
  }

  // ⚠️ 未知参数必须报错，不能静默忽略。实测：`--bod '{"a":1}'`（拼错一个字母）
  // 会被无声丢掉，请求照常发出、body 为 undefined，服务端返回的却是一个
  // 与拼写错误毫无关系的错误。Agent 会去查接口文档，而问题在自己的命令行上。
  //
  // ⚠️ 判据是"以 `-` 开头"而非"以 `--` 开头" —— 与 `list` 同理：否则单横线的
  // `-b` 既不算未知参数、也不进位置参数（同一条收窄的判据），会被**静默丢弃**；
  // 更早的版本里两条判据都是 `--` 开头（d105d9d 一次改了四条），`-h` 会被
  // 位置参数分支接住，报出「它是位置参数」这种事实错误的说明。
  //
  // ⚠️ `--body` 的值位置（`idx === i + 1`）必须跳过：否则一个恰好以 `-` 开头的
  // **值**（如 `--body --yes`）会被当成 flag。见下方位置参数分支的同一判据。
  //
  // ⚠️ `--pretty` 与 `--help`/`-h` 必须进 KNOWN（`--pretty` 2026-10-07 修，
  // `--help`/`-h` 2026-10-08 修）—— 它们是**合法 flag**，不能报成「未知参数」。
  // 但**它们的判定分支要排在本检查之后**，与 `list()` 的次序
  // 「未知/位置参数 → help → --pretty」逐字一致：
  //   实测 `api call ticket.search --al --pretty` 此前报「--pretty 尚未实现」，
  //   而同样输入的 `api list --al --pretty` 报「未知参数：--al」——
  //   同一个坏参数（`--al`）在两个子命令上得到两种答案，Agent 学不到统一规则。
  //   根因就是这里把 `--pretty` 分支提到了未知参数检查**之前**。
  //   `--al` 是**真的拼错**（该报未知参数），`--pretty` 是**真的存在**（当时该报未实现，
  //   G1 起是合法的输出开关）—— 两者同时出现时，先报哪个都对，但**三个子命令必须选同一个**，
  //   否则又是一族 "同族错误两种行为"。选"未知参数优先"与 `list()` 一致。
  const KNOWN = CALL_KNOWN
  const unknown = argv.filter((a, idx) =>
    a.startsWith('-') && !KNOWN.has(a) && !isBodyValue(idx))
  if (unknown.length > 0) {
    // ⚠️ 这一句保持**字面量**：`readme.test.ts:58` 按源文本逐字钉着它（含 `<JSON>` 占位符，
    // 渲染无法无参复现）。`command-tree.test.ts` 有一条断言把这里点名的 flag 与
    // `CALL_FLAGS` 对齐，所以它不会与 spec 漂移。
    return usageFail(`未知参数：${describeArgs(unknown)}。可用：--body <JSON>、--yes、--no-validate、--strict`)
  }

  // ⚠️ **位置参数同样必须报错** —— 上面那条只筛 `-` 开头的。`api call` 除接口 id
  // 外不接受任何位置参数，而此前它们被无声丢弃（实测 `call ticket.search extra`
  // 与 `call ticket.search --yes extra` 都返回退出码 0）。
  //
  // 为什么这条比 `list` 上那条更要命：**忘写 `--body` 是最自然的输入错误**，
  // 而它恰好踩中本计划反复警告的头号静默失败。实测
  // `qiyu api call ticket.search '{"opStart":…,"opEnd":…}'`（漏掉 `--body`）
  // 退出码 0、实际发出的 body 是 undefined，而 `ticket.search` 在
  // **opEnd 缺省时返回全量数据**（见该接口的 note）—— Agent 拿到 2885 条，
  // 以为这就是它那个窗口的结果，而它的窗口参数从未离开过命令行。
  // 拼错一个 flag 会被拦下，漏写一个 flag 却发出一个语义完全不同的请求，
  // 这是同一族问题里后果最重的一种。
  const positional = argv.filter((a, idx) => idx !== 0 && !isBodyValue(idx) && !a.startsWith('-'))
  if (positional.length > 0) {
    // ⚠️ 消息里**不得**用 Markdown 加粗（2026-10-06 修）。`usageFail` 把 message
    // **逐字**写进 stderr（人看的纯文本通道），`**…**` 在终端上会原样显示成四个
    // 星号 —— 与 help 文本同一条规则：输出给谁看，就按谁的格式写。这句强调此前
    // 写成了 `**body 必须用 --body 传入…**`，是 stderr 通道上唯一一处 Markdown。
    // 哨兵在 tests/commands/api.test.ts 的「用法错误的 stderr 也不得出现 Markdown」。
    return usageFail(
      `未知参数：${describeArgs(positional)}。` +
        '接口 id 之后的参数必须写成 --body <JSON> / --yes / --no-validate / --strict —— ' +
        'body 必须用 --body 传入，直接写 JSON 会被忽略（那会发出一个没有 body 的请求）',
    )
  }

  let body: unknown
  if (i >= 0) {
    const raw = argv[i + 1]
    if (raw === undefined) {
      // 静默当成 {} 会掩盖用户的输入错误，并可能触发"空 body"那条代码路径
      return usageFail('用法：--body 后面缺少 JSON 值')
    }
    try {
      body = JSON.parse(raw)
    } catch {
      // ⚠️ 用 describeArgs 渲染，不裸插值（2026-10-07 修）：`--body ''`（如 shell 变量未设置）
      // 会让裸插值产出 `--body 不是合法 JSON：` —— 冒号后什么都没有，退出码 2 的全部信息量归零。
      // 与 `describeArgs` 存在的理由完全同款（见 output.ts 该函数注释）。
      return usageFail(`--body 不是合法 JSON：${describeArgs([raw])}`)
    }
  }

  // ⚠️ 次序与 `list()` 逐字一致：**未知/位置参数/值 → help → `--pretty`**（2026-10-08 修）。
  // 两处都在"命令行已证明合法"之后才判 —— 这与 `list()` 的三条约束同源
  // （未知参数不能静默忽略 / help 本该永远成功 / 说明文字不能与事实相反）：
  //   · help 排在位置参数之后：`api call --help extra` 报「未知参数：extra」
  //     （与 `api list --help extra` 同），而不是把 `extra` 吞掉返回 0；
  //   · `--pretty` 排在 help 之后：`api call ticket.search --pretty --help` 给帮助
  //     （与 `api list --pretty --help` 同）；
  //   · `--pretty` 排在位置参数之后：`api call ticket.search extra --pretty` 报
  //     「未知参数：extra」（与 `api list extra --pretty` 同），而不是「--pretty 尚未实现」。
  //   · **body 解析排在两者之前**：`--body '{坏' --pretty` / `--body '{坏' --help` 报
  //     「不是合法 JSON：{坏」—— 坏 JSON 属于"命令行不合法"，`--pretty` 帮不了它。
  // ⚠️ 与 `list()` 的唯一差别是上面那句 body 解析；**这两处的写法与 `list()` 逐字相同**
  // （裸 `argv.includes`，不带值位置守卫 —— 守卫为什么不必要，见 `isBodyValue` 处规则）。
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(API_USAGE)
    return EXIT.OK
  }
  // G1：--pretty 已实现 —— 原拒绝点开启缩进输出（body 解析仍在它之前：
  // `--body '{坏' --pretty` 报「不是合法 JSON」，那是"命令行不合法"）。
  if (argv.includes('--pretty')) setPretty(true)

  // ⚠️ 命令行已证明合法，现在才谈接口是否存在 / 可调用 / 需确认。
  // 这三者都抛异常，由下方 catch 统一映射退出码（未知 id → usage 2、
  // 不可调用 → usage 2、危险未确认 → needs_confirmation 4）。
  // ⚠️ spec 提升到 try 外：catch 里的 mapThrownToExit 需要它来判断
  // 「限流错误要不要附本地 fallback 建议」（G1）。byId 抛错时它仍是 undefined，
  // 那种错误是 usage，走不到 fallback 分支。
  let spec: EndpointSpec | undefined
  try {
    spec = byId(id)
    assertCallable(spec)
    assertGetHasNoBody(spec, body)
    assertNoValidateStrictConflict(argv)
    const noValidate = argv.includes('--no-validate')
    const strict = argv.includes('--strict')
    const overrides = loadValidationOverrides()
    const file = loadParams(spec.id)
    const ov: ValidationOverride | undefined = overrides[spec.id]
    const warnings: Array<{ kind: string; field?: string; message: string }> = []
    if (!noValidate) {
      const norm = normalizeAliases(file, body, ov)
      body = norm.body
      warnings.push(...norm.warnings)
      const vr = validateBody(spec, file, body, ov, { strict })
      if (vr.hard.length > 0) {
        throw new Error(vr.hard.map((h) => h.message).join('\n'))
      }
      warnings.push(...vr.soft)
    }
    assertConfirmed(spec, argv.includes('--yes'))

    // ⚠️ 凭证解析必须**先于** call()，且失败时走 `auth` 而不是 `usage`。
    // 缺凭证是**环境配置**问题，不是参数写错 —— 若归为 usage（退出码 2），
    // Agent 会去改命令行参数，而正确动作是去配 QIYU_APP_KEY。
    // `auth whoami` 在同样情形下返回的也是退出码 1（kind 同样是 `auth_missing`，
    // 经 `exitCodeFor` 的 default 落到业务错误；不是 `auth`），两处必须一致。
    // ⚠️ G1 起凭证有两个来源（环境变量 > 配置文件）—— 合流逻辑收在
    // `credentials-source.ts`，三处调用点（api/sync/sync-run）共用一份，
    // 避免「api 认配置文件、sync 只认环境变量」这种 Agent 看不出来的分叉。
    const credOutcome = resolveCredentialsUsingFile(currentCredentialEnv())
    if (!credOutcome.ok) return fail(credOutcome.error)
    const creds = credOutcome.creds
    const r = await call(spec, body, { credentials: creds })
    // ⚠️ 「成功但查无此物」必须显式标出来。设计稿 §9.2：0 行是比报错危险得多的
    // 失败模式 —— Agent 的错误处理根本不触发，它会向人类汇报"没有数据"。
    //
    // ⚠️ **但 `notFound` 只覆盖三种"结构性为空"**（`data` 键缺失 / `{}` / `[]`）。
    // 它**判不出"业务为空"** —— 实测 `ticket.search` 查到 0 条时返回
    // `{total:0, tickets:[]}`，信封层看到的是"一个有 2 个键的对象"，判为不空。
    // 要判这一种必须知道每个接口的载荷形状（设计稿 §5.2 的 `responseShape`），
    // 本计划没有这个字段（见「已知缺口」）。
    // → 所以这里**不谎称**"没有 not_found 就是有数据"，只如实报告结构性判定的结果。
    //
    // ⚠️ 但**必须把该接口的 note 透出** —— 计划文末「已知缺口」承认「`api call` 输出里
    // 没有 `not_found` 不等于有数据」，可此前 note **只出现在 `api list` 的输出里**，
    // `callOne` 从不读 `spec.note`。后果是设计稿 §10.1 记录的静默失败对 Agent 完全隐形：
    // `api call ticket.search`（不传 body）会成功返回 `ok:true` + 全量数据
    // （`opEnd` 缺省被服务端忽略），`meta` 里既无 `warning` 也无任何提示 ——
    // Agent 会把这批数据当成"我这个窗口的精确结果"向人类汇报。
    // 该接口的 note 恰恰逐字写明了这个坑，而它就在注册表里，只差没被读。
    // 只给有 note 的接口输出（`api list` 已是这个口径），保持两处一致。
    return ok(r.payload, {
      field_notes: callFieldNotes(),
      endpoint: spec.id,
      ...(warnings.length ? { warnings } : {}),
      ...(r.notFound ? { not_found: true, warning: '接口返回成功但无数据' } : {}),
      ...(spec.note ? { note: spec.note } : {}),
    })
  } catch (e) {
    const err = e as Partial<QiyuError> & { needsConfirmation?: true; target?: string }
    // 门禁拦下 —— 转成"需要确认"的信号。
    //
    // ⚠️ **这条 hint 是安全关键，不是装饰。** 此前这里只给四个确认字段、没有 hint，
    // 而 `confirm_arg: "--yes"` 恰好把"怎么绕过"直接递到了 Agent 手上 ——
    // 最自然的推理就是"加上 `--yes` 重来"。但设计稿 §11.2 D 明令：
    // `needs_confirmation` 时 Agent 必须**停下来、向人类复述该操作及目标、
    // 绝不自动追加 `--yes`**。§11.5 又说明 skill 不是安全边界，所以这条约束
    // 只能靠**输出本身**传达。仅靠"显式确认"这四个字是歧义的（Agent 自己加 --yes
    // 也算"显式"）。hint 必须把"人类"和"不要自动加"说清楚。
    if (err.needsConfirmation) {
      return fail({
        code: 'confirm_required', kind: 'needs_confirmation', retryable: false,
        message: e instanceof Error ? e.message : String(e),
        hint: '这是不可逆的写操作。**必须由人类确认**后再执行 —— 不要自动追加 --yes。' +
              '请把该操作及其目标（接口 id 见 target）复述给人类，得到许可后才可重试。',
        confirmRequired: true, target: err.target ?? id,
      })
    }
    // 已分类的业务/网络错误与其余用法错误共用 mapThrownToExit，避免同族错误两种表现。
    // spec 传下去用于限流错误的本地 fallback 建议（G1）。
    return mapThrownToExit(e, spec)
  }
}

/** 把 catch 到的异常映射为退出码与输出 —— `callOne` 与 `api schema` **共用**的唯一出口（spec §三 :207）。
 *  两类：① 已分类的业务/网络错误（kind!=='usage'）→ 只出 stdout JSON（失败也 classification 直传）；
 *        ② 其余（未知 id、不可调用、校验硬拒、`--no-validate`/`--strict` 冲突等）→ usage 双通道 + 退出码 2。
 *  ⚠️ 不含 needsConfirmation 分支 —— 那是 callOne 独有（schema 不过门禁），由 callOne 在调本函数前先判。
 *  ⚠️ `spec` 可选：只有 `callOne` 传（限流错误的本地 fallback 建议需要它，G1）；
 *     `api schema` 不经过网络层，永远产不出 `rate_limit`，不传。 */
function mapThrownToExit(e: unknown, spec?: EndpointSpec): number {
  // ⚠️ 用 `Partial<QiyuError>`（src/core/errors.ts:53，`retryAfter` 是 `{seconds,source}` 对象）——
  // 不要写成 `retryAfter: number`（fail() 的入参类型是对象，tsc 会 TS2322 红）。
  const err = e as Partial<QiyuError>
  if (err.kind && err.kind !== 'usage') {
    // —— 限流 → 本地 fallback 建议（G1 交付；设计稿 §9.1 示例里声明过这两个字段）——
    //
    // ⚠️ 只对**非危险接口**给建议：危险接口的调用方要的是写操作，一个本地读的
    // 表名帮不上忙，反而可能被误读成「本地也能执行这个操作」。
    // ⚠️ 诚实边界：映射存在 + 库文件存在**只说明「有表可查」**，不承诺表非空、
    // 也不承诺覆盖调用方要的时间窗 —— hint 里写明先 `db tables` / `sync status` 确认。
    // 无映射 / 库文件不存在 / 探测失败 → 两个字段都**不输出**（output.test.ts 钉着
    // 「未提供就不出现键」），原始限流错误原样返回。
    let retryStrategy: string | undefined
    let fallback: string | undefined
    let hint = err.hint
    if (err.kind === 'rate_limit' && spec && !spec.dangerous) {
      const fb = localFallbackFor(spec.id)
      if (fb) {
        retryStrategy = 'switch_to_local'
        const [first, ...rest] = fb.tables
        fallback = `qiyu query --table ${first}`
        const others = rest.length > 0 ? `（该接口另有本地表：${rest.join('、')}）` : ''
        // ⚠️ 措辞必须只承诺**实际检查过的事**（CodeRabbit 2026-10-25 实测发现）。
        // 探测只做了两件：① 该接口在同步任务里有对应表；② 配置指向的路径**是个文件**。
        // 此前这里写「本地有对应表」，读起来像「那张表确实存在」—— 而把
        // `QIYU_DB_PATH` 指向一个空文件（或任意普通文件）时本分支照样触发，
        // 那个库根本没有这张表，`qiyu query --table tickets` 会直接失败。
        // 探测不去打开库是有意的（打开要加载 DuckDB，与「api call 零 DuckDB」冲突），
        // 所以正确的做法是**把边界写在明处**，让调用方先自己确认，而不是替它断言。
        const note =
          `该接口在同步任务里有本地表映射：${first}${others}。` +
          '⚠️ 但这里只确认了「配置指向的库文件存在」，**没有打开库、没有确认这些表存在**，' +
          '更没有确认它们有数据或覆盖你要的时间窗 —— 用之前先跑 `qiyu db tables` 看清单与行数。' +
          '⚠️ 它还是**整表数据源，不是这次请求的等价替代** —— 不会带上你这次 body 里的任何' +
          '筛选条件（时间窗、状态、关键字等），拿到的行可能根本不符合你要的条件。' +
          '要用它请自己补 WHERE 条件（`--sql` 更灵活，`--since`/`--until` 只覆盖时间列）；' +
          '水位与覆盖范围用 `qiyu sync status` 看。'
        hint = hint ? `${hint} ${note}` : note
      }
    }
    return fail({
      code: err.code ?? 'unknown', kind: err.kind, retryable: err.retryable ?? false,
      message: err.message ?? String(e), hint, retryAfter: err.retryAfter,
      ...(retryStrategy !== undefined ? { retryStrategy } : {}),
      ...(fallback !== undefined ? { fallback } : {}),
    })
  }
  // 用法错误双通道：fail() 出 stdout JSON，同时手工补 stderr 一条（与 usageFail 的可见性一致）
  // ⚠️ 必须在出口净化（架构审查 F3）：`api call <ESC 序列>` 曾把原始 ANSI/OSC 写进 stderr，
  // 而 db/query 走 `usageFail` 的同款输入会变成 `·`。与 output.ts 的「净化在出口做一次」
  // 是同一约定 —— 这是第三个手写出口，同样不能漏。
  const raw = e instanceof Error ? e.message : String(e)
  const message = sanitizeMessage(raw)
  process.stderr.write(message.endsWith('\n') ? message : message + '\n')
  return fail({ code: 'usage', kind: 'usage', retryable: false, message: message.replace(/\n+$/, ''), hint: err.hint })
}

/** `ParamSpec` 的浅复制 + `auto`：见 §三 `params` 说明。`auto` 只加给 query 里的鉴权参数。 */
export type SchemaParam = ParamSpec & { auto?: true }

/** 私有：`--no-validate` 与 `--strict` 同传 → 抛普通 Error（→ 退出码 2）。 */
export function assertNoValidateStrictConflict(argv: string[]): void {
  if (argv.includes('--no-validate') && argv.includes('--strict')) {
    throw new Error('--no-validate 与 --strict 不能同时使用 —— 前者完全关闭校验，后者把提示升级为拒绝，两者直接矛盾')
  }
}

/**
 * GET 接口不接受请求体（G1）。抛普通 Error → 退出码 2（usage 双通道）。
 *
 * ⚠️ 当前 154 条注册表里**唯一的 GET**（`get_token`）是 `direction: inbound` +
 * `callable: false`，`assertCallable` 先一步拦下 —— 所以本守卫在生产上不可达，
 * 由 `api.test.ts` 直测 + `http.test.ts` 的合成 spec 覆盖。如实记录，别读成
 * "GET 路径已线上实测"。`call()` 里还有一道同判据的守卫（防将来新命令绕过本层）。
 *
 * ⚠️ **不要在这条消息里承诺"参数走 query 串"**（2026-10-25 修正，评审发现）：
 * `api call` 与 `call()` **都没有** query 参数的输入通道，URL 的查询串只由
 * `signedQuery()` 生成（appKey/time/checksum）。对调用方来说那是一个不存在的能力 ——
 * 它照做会去找一个没有的 flag。所以消息改成如实说明「目前没有该通道」。
 * 真要支持时，必须同时交付：`api call` 的 query flag + `call()` 的拼装 + 签名口径
 * 复核（签名只覆盖 body，query 参数不影响 checksum）+ 真实可调用 GET 的实测。
 */
export function assertGetHasNoBody(spec: EndpointSpec, body: unknown): void {
  if (spec.method === 'GET' && body !== undefined) {
    throw new Error(
      `接口 ${spec.id} 是 GET 接口，不接受请求体 —— 去掉 --body。` +
        '⚠️ 本 CLI 目前没有 GET 的 query 参数通道（还没有可主动调用的 GET 接口），' +
        '所以现在无法给它带任何参数；这道守卫是为了将来出现可调用 GET 时不静默丢弃 body',
    )
  }
}
