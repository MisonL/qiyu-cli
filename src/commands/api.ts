// src/commands/api.ts
import { allEndpoints, byId, assertCallable, assertConfirmed } from '../core/registry/index.js'
import { resolveCredentials } from '../core/credentials.js'
import { call } from '../core/http.js'
import type { QiyuError } from '../core/errors.js'
import { ok, fail, usageFail, describeArgs, EXIT } from '../output.js'

const API_USAGE = `用法：qiyu api <list|call> [参数]

  qiyu api list [--all]                      列出接口
  qiyu api call <接口id> [--body <JSON>] [--yes]   调用接口

--all     连同不可主动调用的接口一起列出
--body    请求体（JSON 字面量）。省略与传 {} 是两条不同的服务端路径
--yes     危险接口（写/破坏性操作）必须显式确认

出错时 stdout 是 {"ok":false,"error":{code,kind,retryable,message,hint?}}。
  ⚠️ 请按 kind 分支，不要按 code —— code 只是个标签：它可能是服务端的
     数字码（如 14009），也可能是本 CLI 合成的词（usage / network / internal /
     auth_missing / confirm_required / local_rate_limit / unknown）。合成词查不到官方错误码表。

退出码：0 成功 · 1 业务错误 · 2 用法错误 · 3 网络错误 · 4 需要 --yes
`

export async function apiCommand(argv: string[]): Promise<number> {
  const [sub] = argv
  // ⚠️ 子命令层的 --help 必须走 stdout + 退出码 0，与顶层一致。
  // 否则 `qiyu api --help` 会得到「用法：qiyu api <list|call>」+ 退出码 2 ——
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
  // ⚠️ 分派层的 `--pretty` 与叶子层同答（2026-10-08 统一）：次序 **未知/位置 → help
  // → `--pretty`**。此前它落到「未知子命令：--pretty」—— 把承诺过、未实现的合法 flag
  // 说成"未知子命令"，与 ㉖ 在叶子层修的是同一类事实错误。
  if (sub === '--pretty') {
    const unknown = argv.slice(1).filter((a) => a.startsWith('-') && a !== '--pretty' && a !== '--help' && a !== '-h')
    const positional = argv.slice(1).filter((a) => !a.startsWith('-'))
    const extra = [...unknown, ...positional]
    if (extra.length > 0) {
      return usageFail(`未知参数：${describeArgs(extra)}。--pretty 尚未实现，不接受额外参数`)
    }
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(API_USAGE)
      return EXIT.OK
    }
    return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
  }
  if (sub === 'list') return list(argv.slice(1))
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
    return usageFail(`用法：qiyu api <list|call> [参数]（\`qiyu api --help\` 查看全部）`,
      '可用子命令：list、call')
  }
  // ⚠️ 用 describeArgs 渲染 sub（2026-10-08 修）：`qiyu api " "` 此前报
  // 「未知子命令： 」—— 名字是纯空白、不可见（与空串参数同一个病）。
  return usageFail(
    `未知子命令：${describeArgs([sub])}\n可用子命令：list、call`,
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
  const KNOWN = new Set(['--all', '--pretty', '--help', '-h'])
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
    return usageFail(`未知参数：${describeArgs(unknown)}。可用：--all`)
  }
  // ⚠️ 位置参数也必须报错。`api list` 不接受任何位置参数，而此前它们被**无声丢弃** ——
  // 实测 `api list extra` 返回退出码 0 与全部 9 行（默认过滤后的行数）。这与下面 `call` 的情况同族：
  // 拼错一个 flag 会被拦下（`--al` → 退出码 2），写错一个位置参数却被放过。
  const positional = argv.filter((a) => !a.startsWith('-'))
  if (positional.length > 0) {
    return usageFail(`未知参数：${describeArgs(positional)}。api list 不接受位置参数，可用：--all`)
  }
  // 命令行已证明合法 —— 现在 help 优先于其余（见上方 ②）。
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(API_USAGE)
    return EXIT.OK
  }
  // ⚠️ `--pretty` 在全局约束里承诺过，但本计划没实现（见「已知缺口」）。
  // 静默忽略会让 Agent 以为格式化生效了，然后去解析一个它没拿到的格式。
  // 显式拒绝，比无声无息好 —— 这是"契约诚实性"而不是"功能完整性"。
  if (argv.includes('--pretty')) {
    // ⚠️ message 里**不能**写「见计划的「已知缺口」」（2026-10-06 修）——
    // 那是计划文档的章节标题，Agent 手里只有这个 CLI。
    return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
  }

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
      // ⚠️ **必须说清"没有哪些字段"**（2026-10-05 加）。上面每条都只解释**存在**的
      // 字段，而 Agent 真正会做错的动作是：读到 `id` + `title` 就以为可以据此拼出
      // 一次调用 —— 但注册表**没有** `params`/`responseShape`（见「已知缺口」），
      // 所以它拼出的 body 只能靠猜。本计划反复强调"声明了但没人读的字段"，
      // 这是它的镜像：**没声明的字段，Agent 会以为不存在（或以为自己能推出来）**。
      // 一句话点破"要参数得去查文档"，比让 Agent 在 14004 或静默忽略上撞墙便宜得多
      // （⚠️ 不是 14003 —— 那是 `time` 错误、鉴权层的码，与 body 字段无关）。
      request_schema:
        '本 meta **不提供**接口的请求参数表（`params`）与响应形状（`responseShape`）。' +
        '`id`/`title`/`path` 足以**定位**接口，但不足以**构造 body**：' +
        '`qiyu api call <id> --body <JSON>` 的 body 必须查官方文档得到，' +
        '本 CLI 无法校验其字段是否正确 —— 传错的字段可能被服务端以 **14004** 拒绝，' +
        '也可能被**静默忽略**（实测：有接口对必填字段照单全收却不生效）。' +
        '别把"返回成功"当作"字段写对了"。',
    },
  })
}

async function callOne(argv: string[]): Promise<number> {
  const [id] = argv
  if (!id) {
    return usageFail('用法：qiyu api call <接口id> [--body <JSON>] [--yes]')
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
        '正确写法：qiyu api call <接口id> [--body <JSON>] [--yes]',
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
  // 于是 `api call ticket.search --body --pretty` 报「--pretty 尚未实现」，
  // 而 `api call ticket.search --body --yes` 报「不是合法 JSON：--yes」：
  // 同一个值位置，两种答案（2026-10-08 修：判定挪到 body 解析之后，与 `list()` 同形）。
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
  //   `--al` 是**真的拼错**（该报未知参数），`--pretty` 是**真的存在**（该报未实现）——
  //   两者同时出现时，先报哪个都对，但**三个子命令必须选同一个**，否则又是一族
  //   "同族错误两种行为"。选"未知参数优先"与 `list()` 一致。
  const KNOWN = new Set(['--body', '--yes', '--pretty', '--help', '-h'])
  const unknown = argv.filter((a, idx) =>
    a.startsWith('-') && !KNOWN.has(a) && !isBodyValue(idx))
  if (unknown.length > 0) {
    return usageFail(`未知参数：${describeArgs(unknown)}。可用：--body <JSON>、--yes`)
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
        '接口 id 之后的参数必须写成 --body <JSON> / --yes —— ' +
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
  // ⚠️ `--pretty` 在全局约束里承诺过，但本计划没实现（见「已知缺口」）。
  // 静默忽略会让 Agent 以为格式化生效了，然后去解析一个它没拿到的格式。
  // 显式拒绝，比无声无息好 —— 这是"契约诚实性"而不是"功能完整性"。
  if (argv.includes('--pretty')) {
    // ⚠️ message 里**不能**写「见计划的「已知缺口」」（2026-10-06 修）——
    // 那是计划文档的章节标题，Agent 手里只有这个 CLI。
    return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
  }

  // ⚠️ 命令行已证明合法，现在才谈接口是否存在 / 可调用 / 需确认。
  // 这三者都抛异常，由下方 catch 统一映射退出码（未知 id → usage 2、
  // 不可调用 → usage 2、危险未确认 → needs_confirmation 4）。
  try {
    const spec = byId(id)
    assertCallable(spec)
    assertConfirmed(spec, argv.includes('--yes'))

    // ⚠️ 凭证解析必须**先于** call()，且失败时走 `auth` 而不是 `usage`。
    // 缺凭证是**环境配置**问题，不是参数写错 —— 若归为 usage（退出码 2），
    // Agent 会去改命令行参数，而正确动作是去配 QIYU_APP_KEY。
    // `auth whoami` 在同样情形下返回的也是退出码 1（kind 同样是 `auth_missing`，
    // 经 `exitCodeFor` 的 default 落到业务错误；不是 `auth`），两处必须一致。
    let creds
    try {
      creds = resolveCredentials({}, {
        appKey: process.env.QIYU_APP_KEY, appSecret: process.env.QIYU_APP_SECRET,
      })
    } catch (e) {
      return fail({
        code: 'auth_missing', kind: 'auth_missing', retryable: false,
        message: e instanceof Error ? e.message : String(e),
        hint: '设置 QIYU_APP_KEY / QIYU_APP_SECRET 环境变量',
      })
    }
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
      endpoint: spec.id,
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
    // 已分类的业务/网络错误 —— 字段名与 QiyuError 完全一致，可直传。
    // ⚠️ 这里**不补 stderr**，与全 CLI 的分工一致：只有**用法错误**是双通道
    // （stderr 给人 + stdout 给 Agent）；业务/网络错误只出 stdout JSON ——
    // `auth whoami` 的 auth_missing 路径同样只走 `fail()`。
    // ⚠️ **但 `kind === 'usage'` 必须排除在这条之外**（2026-10-08 修）。此前的
    // 说明只点了 `classify` / `networkError` 两个来源（它们确实永不产出 usage），
    // 漏了第三个 —— `http.ts` 的 `isLocalRequestError`（fetch 抛**无 cause** 的
    // TypeError，如给 GET 传 body）抛的就是 `kind:'usage'`。它若落进这条分支，
    // 就只出 stdout、**stderr 空**，与 `qiyu api call`（缺 id）两边都有输出
    // 形成同族两种表现 —— 恰是"用法错误双通道"契约的反例。
    // 修法：usage 与下方兜底共用双通道出口。（该异常在 http.test.ts 有 `call()`
    // 级的真实测试；本计划 11 条骨架全是 POST、生产路径暂不可达，但 154 条里
    // 出现 GET 时必达 —— 见「已知缺口」。）
    if (err.kind && err.kind !== 'usage') {
      return fail({
        code: err.code ?? 'unknown', kind: err.kind, retryable: err.retryable ?? false,
        message: err.message ?? String(e), hint: err.hint, retryAfter: err.retryAfter,
      })
    }
    // 其余（未知接口 id、不可调用、请求构造失败、危险未确认的兜底）属于**用法**错误 ——
    // 退出码 2，不是业务错误 1。
    //
    // ⚠️ **这条路径的来源是"抛异常"，不是"写 stderr"** —— 所以这里不能调 `usageFail`
    // （它会再往 stderr 写一遍原文）。但契约要求 stdout 出 JSON、且"用法错误也应
    // 让人看得到"。做法：`fail()` 负责 stdout 的 JSON，同时**手工补一条 stderr**
    // 与其余用法错误保持一致 —— 否则 `qiyu api call 不存在的接口` 只在 stdout 有
    // 输出、stderr 空，而 `qiyu api call`（缺 id）在两边都有。同族错误两种表现。
    const message = e instanceof Error ? e.message : String(e)
    process.stderr.write(message.endsWith('\n') ? message : message + '\n')
    return fail({
      code: 'usage', kind: 'usage', retryable: false,
      message: message.replace(/\n+$/, ''),
      // isLocalRequestError 会带 hint（"CLI 侧构造问题、重试无用"）；byId /
      // assertCallable 的普通 Error 没有，undefined 时 fail() 会整个省略该键。
      hint: err.hint,
    })
  }
}
