// src/commands/auth.ts
import { resolveCredentials } from '../core/credentials.js'
import { ok, fail, usageFail, describeArgs, EXIT } from '../output.js'
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES, REJECTED_FLAGS } from './spec-types.js'
import type { CommandSpec } from './spec-types.js'

/**
 * 命令契约（F 组 D4）：`skill check` 据此判断 skill 正文里的 `qiyu auth …` 是否真的存在。
 * `flags` 是**完整接受集**（含全局 flag），`--pretty` 同时在 `rejected` 里。
 * 本文件没有业务 flag：`KNOWN` 直接就是全局那三个。
 */
export const AUTH_SPECS: CommandSpec[] = [
  {
    path: ['auth', 'whoami'],
    flags: [...GLOBAL_FLAGS],
    positionals: [],
    rejected: REJECTED_FLAGS,
  },
]

const AUTH_USAGE = `用法：qiyu auth whoami

  qiyu auth whoami   检查凭证是否已配置（只检查存在性，不校验有效性）

凭证从环境变量读取：QIYU_APP_KEY / QIYU_APP_SECRET
⚠️ whoami 成功不代表凭证可用 —— 一个拼错的 appKey 同样返回 configured: true。
   第一次真实调用才是唯一的验证。

出错时 stdout 是 {"ok":false,"error":{code,kind,retryable,message,hint?}}。
  ⚠️ 请按 kind 分支，不要按 code —— code 只是个标签：它可能是服务端的
     数字码（如 14009），也可能是本 CLI 合成的词（usage / network / internal /
     auth_missing / confirm_required / store_locked / store_not_initialized / local_rate_limit / unknown）。合成词查不到官方错误码表。

退出码：0 成功 · 1 业务错误 · 2 用法错误 · 3 网络错误 · 4 需要 --yes
`

export async function authCommand(argv: string[]): Promise<number> {
  const [sub] = argv
  // ⚠️ `--help` 不吞额外参数（2026-10-08 修）—— 与叶子命令同一条次序
  // （未知/位置参数 → help）：实测 `qiyu auth --help --bod` / `qiyu auth --help extra`
  // 此前返回 0，拼错的 flag / 多余的位置参数被静默吞掉（`qiyu auth --bod` 单独跑是 2）。
  // `--help --help` 仍给帮助（与 `api list --help --help` 同答）。
  if (sub === '--help' || sub === '-h') {
    // ⚠️ `--help` 不吞额外参数（2026-10-08 修）—— 与叶子命令同一条次序
    // （未知/位置参数 → help）：实测 `qiyu auth --help --bod` / `qiyu auth --help extra`
    // 此前返回 0，拼错的 flag / 多余的位置参数被静默吞掉（`qiyu auth --bod` 单独跑是 2）。
    // `--help --help` 仍给帮助（与 `api list --help --help` 同答）。
    // ⚠️ `--pretty` 同样豁免（2026-10-08）：`qiyu auth --help --pretty` 给帮助
    // （与 `auth whoami --help --pretty` 同答）—— `--pretty` 是合法 flag，不是"额外参数"。
    const extra = argv.slice(1).filter((a) => a !== '--help' && a !== '-h' && a !== '--pretty')
    if (extra.length > 0) {
      return usageFail(`未知参数：${describeArgs(extra)}。--help 不接受额外参数`)
    }
    process.stdout.write(AUTH_USAGE)
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
      process.stdout.write(AUTH_USAGE)
      return EXIT.OK
    }
    return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
  }
  if (sub === 'login') {
    // ⚠️ `login` 在「已知缺口」里明确未实现（配置文件写入留给计划 2）。
    // 但它必须**显式报错**，不能静默落到 whoami：实测把两者合并时
    // `qiyu auth login` 会返回退出码 0 与 `{"ok":true,"data":{"configured":true}}` ——
    // Agent 会据此认为"登录成功"，而后继续用一套它以为已经落盘的凭证。
    // 契约诚实性：没实现就说没实现，别给一个看起来成功的响应。
    // ⚠️ message 里**不能**写「见计划的「已知缺口」」（2026-10-06 修）—— 那是
    // 计划文档的章节标题，Agent 手里只有这个 CLI。悬空引用与"指向不存在的命令"
    // 是同一类：读者照着找不到东西。改成说清**当前能做什么**。
    // ⚠️ 必须明说「**不是参数问题**」（2026-10-07 改）——退出码 2 的契约语义是
    // 「用法错误 → 改参数重来」（见全局约束那行），而这条是"改参数也救不了"的一类。
    // ⚠️ **这一类不止它一个**（2026-10-07 实证更正：此前写「全 CLI 仅有的两个」，
    // 是错的 —— 用真实 CLI 逐个试过）：除本处与 `--pretty`（三个子命令各一处），
    // 还有「接口不可主动调用」的拒绝（`api call receive.message` /
    // `api call wecom.robot.switch` —— 换任何 body/flag 都不会成功，只有换接口 id 才行）。
    // 区别在于：`未知参数：--xyz` / `未知接口：xxx` 这类**换参数就能过**，属正常用法错误；
    // 上面几类**换参数也过不了**，Agent 若按退出码 2 的通用语义反复重试就是白烧预算。
    // 本条明说「不是参数问题」，正是把这一子类标出来。
    return usageFail('auth login 尚未实现 —— 不是参数问题，换任何参数都不会成功。' +
      '当前只支持环境变量：请设置 QIYU_APP_KEY / QIYU_APP_SECRET。')
  }
  if (sub !== 'whoami') {
    // ⚠️ 不再写 `<whoami|login>` —— login 未实现（见「已知缺口」），
    // 把它列进用法就是在承诺一个跑不通的命令。
    //
    // ⚠️ **必须点名 token、并把"无参数"与"未知子命令"分开**（2026-10-05 修）。
    // 此前这里对两者都只吐整段用法：Agent 拿到一屏文字不知道自己错在哪；
    // 而 `qiyu auth`（无参数）会被报成"未知子命令"——它其实只是**没给子命令**。
    // 顶层 `run()` 的 `if (!sub)` 已经把这两件事分开了，三处（顶层/api/auth）
    // 必须一致，否则 Agent 学不到统一规则。
    if (!sub) {
      return usageFail('用法：qiyu auth <whoami> [参数]（`qiyu auth --help` 查看全部）',
        '可用子命令：whoami')
    }
    // ⚠️ 用 describeArgs 渲染 sub（2026-10-08 修）：`qiyu auth " "` 此前报
    // 「未知子命令： 」—— 名字是纯空白、不可见（与空串参数同一个病）。
    return usageFail(
      `未知子命令：${describeArgs([sub])}\n可用子命令：whoami`,
      // ⚠️ 不能写「见「已知缺口」」—— 那是**计划文档**的章节标题，
      // Agent 手里只有这个 CLI，没有那份文档，读到的是一个悬空引用
      // （2026-10-06 修）。要指向 Agent 自己能观察到的现象：跑一下就知道了。
      '`qiyu auth --help` 查看完整用法。auth 目前只支持 whoami（没有 login）')
  }
  // ⚠️ `whoami --help` / `-h` 必须给帮助（2026-10-07 修）。
  // 此前它落到下面的"多余参数"分支，报「未知参数：--help」—— 而 `--help` 是合法
  // flag，那是一句**事实错误**的说明。更重的是不一致：顶层 `qiyu --help`、`api --help`、
  // `auth --help`、`api list --help`、`api call --help` 全部给帮助，唯独
  // `auth whoami --help` 报错。
  // 计划自己的规则是「help 本该永远成功」与「三个子命令的参数校验必须一致」——
  // 两句话都要求这里给帮助，而不是报未知参数。
  //
  // ⚠️ **次序必须与 `list()` 完全相同**：未知/位置参数 → help → `--pretty`。
  // 三条理由在那边写全了，这里只重申对本函数的影响：
  //   · `whoami --bod --help` 必须报「未知参数：--bod」（① 未知参数不能被 help 吞掉），
  //     而不是因为带了 `--help` 就返回 0；
  //   · `whoami --pretty --help` 必须给帮助（② help 先于 `--pretty`）；
  //   · `--help`/`-h` 必须在 KNOWN 里，否则 `whoami --help` 会报
  //     「未知参数：--help」—— 正是本条要修的那句事实错误（③）。
  // 此前这里既没有 help 特判、也没有 KNOWN 集合，三条全部落空。
  const KNOWN = new Set(GLOBAL_FLAG_NAMES)
  const unknown = argv.slice(1).filter((a) => a.startsWith('-') && !KNOWN.has(a))
  if (unknown.length > 0) {
    return usageFail(`未知参数：${describeArgs(unknown)}。auth whoami 不接受任何参数`)
  }
  // ⚠️ `whoami` **不接受任何位置参数**，多出来的必须报错，不能静默忽略。
  // 实测此前 `qiyu auth whoami extra` / `--bod` / `--pretty` / `--yes`
  // **全部返回退出码 0 与 `{"ok":true,"data":{"configured":true}}`** ——
  // 与 `api list`/`api call` 是同族问题，只是这条命令的后果不同：
  // 它不发出任何请求，所以不会造成静默失败；但 `--pretty` 被无声吞掉后
  // Agent 会去解析一个它没拿到的格式（与 `api list --pretty` 完全一样的坑），
  // 而 `--yes` 被吞掉会让人以为这个命令接受确认参数。
  // 三个子命令的参数校验必须一致 —— 只在两个上做，第三个就是漏网。
  const positional = argv.slice(1).filter((a) => !a.startsWith('-'))
  if (positional.length > 0) {
    return usageFail(`未知参数：${describeArgs(positional)}。auth whoami 不接受任何参数`)
  }
  // 命令行已证明合法 —— 现在 help 优先于 `--pretty`（与 `list()` 的 ② 同源）。
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(AUTH_USAGE)
    return EXIT.OK
  }
  // ⚠️ `--pretty` 同上（2026-10-07 修）：它是承诺过、未实现的 flag，不是未知参数。
  // 三个子命令给同一句，Agent 才学得到统一规则。
  if (argv.includes('--pretty')) {
    return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
  }
  return whoami()
}

function whoami(): number {
  try {
    resolveCredentials({}, {
      appKey: process.env.QIYU_APP_KEY,
      appSecret: process.env.QIYU_APP_SECRET,
    })
  } catch (e) {
    return fail({
      // ⚠️ kind 是 `auth_missing` 而不是 `auth` —— 但**不能**说"设计稿 §9.5 把
      // 这两者列为两个状态码"：§9.5 只有 store_not_initialized / auth_missing /
      // store_locked 三条，**根本没有 `auth` 这个 kind**。`auth` 是本计划自建的
      // kind（文末「设计稿点名的 8 个 kind 里，本计划实现了 3 个」那段里
      // 列的 13 个自建值之一 —— 那张表本身只列设计稿点名的 8 个，`auth` 不在表内），
      // 语义是"发出去被服务端拒"。
      // 分成两个是为了让 Agent 区分"改凭证"与"去配凭证"这两种不同的动作 ——
      // 这个理由是计划自己的设计决定，不是设计稿的规定，不得倒过来援引 §9.5。
      code: 'auth_missing', kind: 'auth_missing', retryable: false,
      message: e instanceof Error ? e.message : String(e),
      hint: '设置 QIYU_APP_KEY / QIYU_APP_SECRET 环境变量',
    })
  }

  // 只报告"是否已配置"。连末四位都不回显 —— 全局约束是
  // "凭证绝不出现在 stdout"，末四位仍属于凭证内容。
  //
  // ⚠️ 不报 `source`。本计划只支持环境变量（`auth login` 与配置文件见「已知缺口」），
  // 而能走到这里就意味着 env 齐备 —— 写成 `process.env.QIYU_APP_KEY ? 'env' : 'file'`
  // 是一个**永假的 else 分支**：它会让人以为已经支持配置文件，
  // 而 Agent 会照着这个字段去判断该不该 `auth login`。
  // 等计划 2 真正接入配置文件时再把这个字段加回来，那时它才有第二种取值。
  return ok({ configured: true })
}
