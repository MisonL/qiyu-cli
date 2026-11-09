// src/commands/auth.ts
import { dirname } from 'node:path'
import { resolveCredentials } from '../core/credentials.js'
import { ok, fail, usageFail, failFromTagged, describeArgs, setPretty, EXIT } from '../output.js'
import {
  configPathFor, loadConfigFile, loadConfigChecked, writeConfigFile, checkPermissions,
  isWhitespaceOnly, nonEmptyValue,
  resolveProfileName, shellPath,
} from '../core/config.js'
import type { QiyuConfigFile, ProfileBlock } from '../core/config.js'
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES, prettyAfterSubcommand, prettyPositionalProblem, REJECTED_FLAGS } from './spec-types.js'
import type { CommandSpec, FlagSpec } from './spec-types.js'

/** `auth login` 的业务 flag：只有 `--profile`（凭证从**环境变量**读，见命令内注释）。 */
const LOGIN_FLAGS: FlagSpec[] = [{ name: '--profile', kind: 'value' }]

/**
 * 命令契约（F 组 D4）：`skill check` 据此判断 skill 正文里的 `qiyu auth …` 是否真的存在。
 * `flags` 是**完整接受集**（含全局 flag）。
 */
export const AUTH_SPECS: CommandSpec[] = [
  {
    path: ['auth', 'whoami'],
    flags: [...GLOBAL_FLAGS],
    positionals: [],
    rejected: REJECTED_FLAGS,
  },
  {
    path: ['auth', 'login'],
    flags: [...GLOBAL_FLAGS, ...LOGIN_FLAGS],
    positionals: [],
    rejected: REJECTED_FLAGS,
  },
]

const AUTH_USAGE = `用法：qiyu auth <whoami|login> [参数]

  qiyu auth whoami            检查凭证是否已配置（只检查存在性，不校验有效性）
  qiyu auth login [--profile <name>]
                              把环境变量里的凭证写入配置文件

凭证来源与优先级：环境变量 > 配置文件（QIYU_APP_KEY / QIYU_APP_SECRET）。
⚠️ whoami 成功不代表凭证可用 —— 一个拼错的 appKey 同样返回 configured: true。
   第一次真实调用才是唯一的验证。

auth login 从环境变量读取凭证（不接受 --app-key/--app-secret：命令行参数会
留在 shell 历史与进程列表里）。写入 ~/.config/qiyu/config.json：新建的目录 0700、文件 0600；
已存在的目录不改动，但 group/other 可写（能整体替换文件）时拒绝写入。

出错时 stdout 是 {"ok":false,"error":{code,kind,retryable,message,hint?}}。
  ⚠️ 请按 kind 分支，不要按 code —— code 只是个标签：它可能是服务端的
     数字码（如 14009），也可能是本 CLI 合成的词（usage / network / internal /
     auth_missing / config_insecure / confirm_required / store_locked / store_not_initialized /
     local_rate_limit / sync_not_run / unknown）。合成词查不到官方错误码表。

退出码：0 成功 · 1 业务错误 · 2 用法错误 · 3 网络错误 · 4 需要 --yes
`

export async function authCommand(argv: string[]): Promise<number> {
  setPretty(false) // G1：每条命令入口重置输出格式 —— 同一进程内多次 run（测试）不残留上一条命令的开关。
  const [sub] = argv
  // ⚠️ `--help` 不吞额外参数（2026-10-08 修）—— 与叶子命令同一条次序
  // （未知/位置参数 → help）：实测 `qiyu auth --help --bod` / `qiyu auth --help extra`
  // 此前返回 0，拼错的 flag / 多余的位置参数被静默吞掉（`qiyu auth --bod` 单独跑是 2）。
  // `--help --help` 仍给帮助（与 `api list --help --help` 同答）。
  // ⚠️ `--pretty` 同样豁免（2026-10-08；G1 起已实现为缩进开关）：它是**合法 flag**，
  // 不是"额外参数"。
  if (sub === '--help' || sub === '-h') {
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
  // G1：--pretty 已实现，但必须写在具体子命令之后（`auth whoami --pretty`）。
  if (sub === '--pretty') {
    const unknown = argv.slice(1).filter((a) => a.startsWith('-') && a !== '--pretty' && a !== '--help' && a !== '-h')
    if (unknown.length > 0) {
      return usageFail(`未知参数：${describeArgs(unknown)}。--pretty 不接受额外参数`)
    }
    const badPos = prettyPositionalProblem(argv.slice(1), AUTH_SPECS)
    if (badPos !== undefined) return usageFail(badPos)
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(AUTH_USAGE)
      return EXIT.OK
    }
    // ⚠️ 位置参数按「顺序写反」引导（2026-11-07 审查）—— 见 db.ts 同款注释。
    return usageFail(prettyAfterSubcommand('auth'))
  }
  if (sub === 'login') return login(argv.slice(1))
  if (sub !== 'whoami') {
    // ⚠️ **必须点名 token、并把"无参数"与"未知子命令"分开**（2026-10-05 修）。
    // 此前这里对两者都只吐整段用法：Agent 拿到一屏文字不知道自己错在哪；
    // 而 `qiyu auth`（无参数）会被报成"未知子命令"——它其实只是**没给子命令**。
    // 顶层 `run()` 的 `if (!sub)` 已经把这两件事分开了，三处（顶层/api/auth）
    // 必须一致，否则 Agent 学不到统一规则。
    if (!sub) {
      return usageFail('用法：qiyu auth <whoami|login> [参数]（`qiyu auth --help` 查看全部）',
        '可用子命令：whoami、login')
    }
    // ⚠️ 用 describeArgs 渲染 sub（2026-10-08 修）：`qiyu auth " "` 此前报
    // 「未知子命令： 」—— 名字是纯空白、不可见（与空串参数同一个病）。
    return usageFail(
      `未知子命令：${describeArgs([sub])}\n可用子命令：whoami、login`,
      // ⚠️ 不能写「见「已知缺口」」—— 那是**计划文档**的章节标题，
      // Agent 手里只有这个 CLI，没有那份文档，读到的是一个悬空引用
      // （2026-10-06 修）。要指向 Agent 自己能观察到的现象：跑一下就知道了。
      '`qiyu auth --help` 查看完整用法')
  }
  // ⚠️ `whoami --help` / `-h` 必须给帮助（2026-10-07 修）。
  // 此前它落到下面的"多余参数"分支，报「未知参数：--help」—— 而 `--help` 是合法
  // flag，那是一句**事实错误**的说明。更重的是不一致：顶层 `qiyu --help`、`api --help`、
  // `auth --help`、`api list --help`、`api call --help` 全部给帮助，唯独
  // `auth whoami --help` 报错。
  //
  // ⚠️ **次序必须与 `list()` 完全相同**：未知/位置参数 → help → `--pretty`。
  const KNOWN = new Set(GLOBAL_FLAG_NAMES)
  const unknown = argv.slice(1).filter((a) => a.startsWith('-') && !KNOWN.has(a))
  if (unknown.length > 0) {
    return usageFail(`未知参数：${describeArgs(unknown)}。auth whoami 只接受 --help / --pretty，不接受其他参数`)
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
    return usageFail(`未知参数：${describeArgs(positional)}。auth whoami 只接受 --help / --pretty，不接受其他参数`)
  }
  // 命令行已证明合法 —— 现在 help 优先于 `--pretty`（与 `list()` 的 ② 同源）。
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(AUTH_USAGE)
    return EXIT.OK
  }
  // G1：--pretty 已实现 —— 原拒绝点开启缩进输出（次序不变：未知/位置 → help → 这里）。
  if (argv.includes('--pretty')) setPretty(true)
  return whoami()
}

/** profile 名解析与格式校验（login 与 whoami 共用）。 */
function normalizeProfile(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined
  if (raw.trim() === '') throw new Error('--profile 不能为空')
  return raw
}

/**
 * `auth login`：把**环境变量**里的凭证写进配置文件（G1）。
 *
 * ⚠️ **不接受 `--app-key` / `--app-secret`**（有意的不对称，不要"为了完整"补上）：
 * 命令行参数会留在 shell 历史、进程列表（`ps`）与 CI 日志里 —— 凭证的三种最常见
 * 泄漏途径全都命中。环境变量是唯一入口（`QIYU_APP_KEY`/`QIYU_APP_SECRET`，
 * 与 whoami/api 的既有约定同源）。
 *
 * ⚠️ **不回显凭证**，连末四位都不 —— 与 whoami 同一条约束（全局约束：
 * 「凭证绝不出现在 stdout」）。输出只有 configured/profile/config_path。
 *
 * ⚠️ **不发网络请求**：login 只做"把已有凭证落盘"，不校验它是否有效 ——
 * `whoami` 的既有说明（「拼错的 appKey 同样返回 configured: true」）对 login
 * 同样成立。第一次真实调用才是唯一的验证。
 */
async function login(argv: string[]): Promise<number> {
  const KNOWN = new Set([...GLOBAL_FLAG_NAMES, '--profile'])
  const unknown = argv.filter((a) => a.startsWith('-') && !KNOWN.has(a))
  if (unknown.length > 0) {
    return usageFail(`未知参数：${describeArgs(unknown)}。auth login 只接受 --profile <name>`)
  }
  // ⚠️ help 先于值位解析（与 whoami 同序：未知/位置 → help → 其余）。
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(AUTH_USAGE)
    return EXIT.OK
  }
  // 逐 token 解析：`--profile` 会**吃掉**它的取值，被吃掉的取值不是位置参数。
  // ⚠️ 此前这里用 `argv.filter(a => !a.startsWith('-'))` 找位置参数 —— 于是
  // `login --profile staging` 把取值 `staging` 当成多余的位置参数报错（合法的
  // 调用被判成非法），而 `--profile a --profile b` 报的是「未知参数：a、b」
  // 而不是真正的原因（重复给）。两处都是同一个 bug：不认识值位。
  let profileFlag: string | undefined
  let seenProfile = false
  const positional: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--pretty') continue // 唯一的非 help 全局 flag，不取值
    if (a === '--profile') {
      if (seenProfile) return usageFail('用法：--profile 只能出现一次')
      seenProfile = true
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) return usageFail('用法：--profile 后面缺少取值')
      profileFlag = v
      i++ // 吃掉取值
      continue
    }
    if (!a.startsWith('-')) positional.push(a)
  }
  if (positional.length > 0) {
    return usageFail(`未知参数：${describeArgs(positional)}。auth login 不接受位置参数`)
  }
  // G1：--pretty 已实现 —— 原拒绝点。
  if (argv.includes('--pretty')) setPretty(true)

  let profile: string | undefined
  try { profile = normalizeProfile(profileFlag) } catch (e) {
    return usageFail((e as Error).message)
  }

  // ⚠️ 空串同样视为缺失（`export QIYU_APP_KEY=` 是 shell 里变量未设的典型形态，
  // 与 credentials-source.ts 的口径一致 —— 两层对"空"的判定不能分叉）。
  const envKey = process.env.QIYU_APP_KEY
  const envSecret = process.env.QIYU_APP_SECRET
  // ⚠️ 纯空白不是「缺」也不是「有」（A12，2026-11-06）：`' '` 会穿过 nonEmptyValue，
  // 此前被**原样写进配置文件**，之后每条命令都拿它去签名。拒绝并点名变量。
  const blankEnv = [
    ...(isWhitespaceOnly(envKey) ? ['QIYU_APP_KEY'] : []),
    ...(isWhitespaceOnly(envSecret) ? ['QIYU_APP_SECRET'] : []),
  ]
  if (blankEnv.length > 0) {
    // ⚠️ 不能建议 `unset` 后直接重跑（Codex PR #69 第七轮）：login 只从环境变量读、
    // 不回落配置文件，删掉变量后重跑必然又是「缺少 …」退 2。恢复动作只有「设真实值」。
    return usageFail(
      `环境变量 ${blankEnv.join('、')} 只有空白字符（不是有效凭证），未写入配置文件`,
      `请把它们设为真实值后重新运行 auth login（login 只从环境变量读取，不会回落配置文件）`,
    )
  }
  const appKey = nonEmptyValue(envKey)
  const appSecret = nonEmptyValue(envSecret)
  // ⚠️ 缺任一即 usage（退出码 2）：这是"调用方式"问题（shell 里少 export 一个），
  // 与"凭证无效"（业务错误）不同 —— 后者要发请求才知道，login 不发请求。
  // ⚠️ 必须点名叫用户 export 什么，否则它只知道"少东西"。
  const missing: string[] = []
  if (!appKey) missing.push('QIYU_APP_KEY')
  if (!appSecret) missing.push('QIYU_APP_SECRET')
  if (missing.length > 0 || appKey === undefined || appSecret === undefined) {
    // `missing.length > 0` 与后两个判据等价，但**必须都写**：前者给人看的清单，
    // 后者给类型收窄（TS 推不出 `missing.length === 0 ⇒ appKey 已定义`）。
    return usageFail(
      `auth login 需要从环境变量读取凭证，缺少：${missing.join('、')}`,
      `先在 shell 里设置并导出：export ${missing.join('=… ')}` + '=…，然后重新运行 auth login',
    )
  }

  const configPath = configPathFor()
  let file: QiyuConfigFile
  try {
    // 权限拒绝由 `loadConfigFile` 在读取前分流（唯一读取点，带 kind + chmod hint）——
    // 本 catch 的 insecure 分支因此可达（Codex 2026-11-10 第四轮 P2）。
    file = loadConfigFile(configPath).file
  } catch (e) {
    // 读不出来（畸形 JSON / 未知键 / 权限拒绝）——不能"无视坏文件直接覆盖"：
    // 那会静默丢掉用户手写的其它配置。如实报错，让人先修。
    // ⚠️ 不能报成 usage（退出码 2，2026-11-09 审计实测）：退出码 2 的语义是「改参数
    // 重来」，而换环境变量修不好损坏的 JSON；权限拒绝则是环境问题（whoami 对同一状态
    // 给 config_insecure）。统一走 `config_invalid`（退出码 1）+ 点名修法，
    // 权限拒绝时 hint 直指 chmod（与 `core/config.ts` 的 config_insecure hint 同口径）。
    const insecure = (e as { kind?: string }).kind === 'config_insecure'
    // 权限拒绝的修复动作是唯一的一条 chmod —— 路径由 core 的 `insecureConfigError` 渲染
    // （含 shell 引号），这里只追加“没写任何东西”这个 login 侧事实。
    const coreHint = (e as { hint?: string }).hint
    return fail({
      code: insecure ? 'config_insecure' : 'config_invalid',
      kind: insecure ? 'config_insecure' : 'config_invalid', retryable: false,
      message: `无法读取现有配置文件：${(e as Error).message}`,
      hint: insecure
        ? `${coreHint ?? '这是配置文件权限问题，重试无用'}；本次未写入任何内容`
        : '先修好或移走该文件后重跑（改成合法 JSON、删掉不认识的键，或让当前用户可读）；'
          + '本次未写入任何内容 —— login 不会覆盖读不出来的文件，直接覆盖会丢掉你手写的其它配置',
    })
  }
  // ⚠️ 档名走**共用解析点**（2026-10-29 实测）：此前这里是 `profile ?? envProfile ?? defaultProfile ?? 'default'`
  // 的手写链，而 `??` 会放行空串 —— `"defaultProfile": ""`（JSON 里清空字段）时
  // login 把凭证写进 `profiles[""]`，而 store / api / sync 按内置 `default` 读：
  // login 与 whoami 都报 `configured: true`，第一次真实调用却报「缺少 appKey」——
  // 凭证写进了**没人读的档**。共用的口径与 README 一致：空串视为未设置。
  // 顺序也与 spec §3.2 一致（命令行 > 环境变量 > 配置文件 > 默认）——此前曾写成
  // defaultProfile 优先于 QIYU_PROFILE，同一台机器上 export 过的用户会发现自己
  // 写进了别的 profile；`resolveProfileName` 把这条顺序固化成唯一实现。
  const name = resolveProfileName({
    flag: profile, envProfile: process.env.QIYU_PROFILE, defaultProfile: file.defaultProfile,
  }).name
  const existing: ProfileBlock = file.profiles[name] ?? {}
  const next: QiyuConfigFile = {
    ...(file.defaultProfile !== undefined ? { defaultProfile: file.defaultProfile } : {}),
    profiles: {
      ...file.profiles,
      // 合并保留该 profile 下的其它键（store/robots）——覆盖式写入会把
      // 用户手工配的 knowledgeRobotIds 一起抹掉。
      [name]: { ...existing, credentials: { appKey, appSecret } },
    },
  }
  try {
    writeConfigFile(configPath, next)
  } catch (e) {
    // 写盘失败是环境问题（权限/符号链接/磁盘）——归业务错误（退出码 1），
    // 不是"改参数重来"。文案带上底层原因，否则用户只知道"失败了"。
    const msg = (e as Error).message
    // 符号链接是我们的显式拒绝 —— 也归这里（用户的动作是"换成普通文件"）。
    return fail({
      code: 'config_insecure', kind: 'config_insecure', retryable: false,
      message: `无法写入配置文件 ${configPath}：${msg}`,
      // A11（2026-11-06 审查）：原文案建议「换到 HOME 下可写的位置」，但配置路径**没有通道**
      // （没有 --config/环境变量可改，见 configPathFor）——那是一个做不到的动作。
      hint: `请检查 ${shellPath(dirname(configPath))} 的权限：目录可写、config.json 不是符号链接。`
        + '配置路径固定为 ~/.config/qiyu/config.json（由 HOME 决定），CLI 不提供改路径的参数，'
        + '所以不要去找「别的路径」，先把这一处的权限修好',
    })
  }
  // 权限自检：写出的文件必须 0600，否则这次"成功"是假的（凭证已落盘且可被他人读）。
  // writeConfigFile 用 0600 创建，这里只做一次如实复核 —— 失败则如实报告。
  try {
    const perm = checkPermissions(configPath, { hasCredentials: true, onWarn: () => {} })
    if (!perm.ok) {
      return fail({
        code: 'config_insecure', kind: 'config_insecure', retryable: false,
        message: `凭证已写入 ${configPath}，但落盘权限不合格（${perm.reason === 'file' ? '文件' : '目录'}过宽）`,
        // ⚠️ 路径必须走 shellPath 引号（CodeRabbit 2026-10-26）：HOME 可含空格，
        // 不引号的 chmod 在那种 HOME 下照着抄是坏的。与 core 的 insecureConfigError 同源。
        hint: `请执行 chmod ${perm.reason === 'file' ? `600 ${shellPath(configPath)}` : `700 ${shellPath(dirname(configPath))}`}`,
      })
    }
  } catch { /* 自检失败不影响"已写入"这一事实；下一次任何命令都会再查一次 */ }

  // ⚠️ 绝不回显 appKey/appSecret —— 连末四位都不（与 whoami 同一条约束）。
  return ok({ configured: true, profile: name, config_path: configPath, source: 'file' }, {
    field_notes: {
      configured: 'true 只表示两个字段都已写入配置文件，不代表它们有效'
        + '（拼错的 appKey 同样返回 true）。⚠️ auth whoami 也只查「有没有配」，'
        + '不能验证有效性 —— 要验证只能发一次真实请求',
      profile: '写入的配置档名。选择顺序：--profile > 环境变量 QIYU_PROFILE > '
        + '配置文件里声明的默认档名 > default。⚠️ 不要假定是 default；'
        + '写入非 default 档不会改动顶层的默认档名 —— 之后的命令仍须用 --profile 或 '
        + 'QIYU_PROFILE 指向它，否则读不到这份凭证',
      config_path: '写入的配置文件路径',
      source: '恒为 file —— 表示本次把凭据写进了文件。'
        + '⚠️ 它不表示「下次会从文件读」：环境变量 QIYU_APP_KEY / QIYU_APP_SECRET 仍在时，'
        + '后续命令优先用环境变量（auth whoami 会报 env），login 写的文件只是兜底',
    },
  })
}

function whoami(): number {
  const configPath = configPathFor()
  let file: QiyuConfigFile | undefined
  let configError: string | undefined
  try {
    // ⚠️ `loadConfigChecked`：含凭证且权限过宽 → 抛带 kind 的错误（不降级成 auth_missing）。
    // 这类是**环境/安全问题**，与"凭证没配"是两件事，必须如实分流。
    file = loadConfigChecked(configPath).file
  } catch (e) {
    const tagged = e as { kind?: string }
    if (tagged.kind) return failFromTagged(e)
    // 配置畸形（非法 JSON / 未知键）**不等于"凭证没配"** —— 但它是配置问题，
    // 继续往下走（会让下方按"未检测到完整凭证"报），并把这句原因拼进 message。
    configError = (e as Error).message
  }

  const envKey = process.env.QIYU_APP_KEY
  const envSecret = process.env.QIYU_APP_SECRET
  const envProfile = process.env.QIYU_PROFILE
  // ⚠️ A12（2026-11-06）：纯空白是 truthy，此前报 `configured: true`、source=env ——
  // 而 api/sync 的凭证合流现在会拒绝它。whoami 必须与它们同答，否则又是一份
  // 「谁都说配好了、只有真调用失败」的分叉。
  const blankEnv = [
    ...(isWhitespaceOnly(envKey) ? ['QIYU_APP_KEY'] : []),
    ...(isWhitespaceOnly(envSecret) ? ['QIYU_APP_SECRET'] : []),
  ]
  if (blankEnv.length > 0) {
    return fail({
      code: 'auth_missing', kind: 'auth_missing', retryable: false,
      message: `环境变量 ${blankEnv.join('、')} 只有空白字符（不是有效凭证）`,
      hint: `请把它们设为真实值；若本意是不设置，用 \`unset ${blankEnv.join(' ')}\``
        + ' 删除变量，让配置文件的凭证生效',
    })
  }
  // ⚠️ 档名解析**必须走共用点**（2026-10-29 实测）：此前这里是 `envProfile ?? defaultProfile ?? 'default'`，
  // 而 `''` 不是 null/undefined、`??` 会把它放行 —— `QIYU_PROFILE=`（变量未设的典型形态）
  // 于是选中一个名叫空串的档，报 `auth_missing`，而同一台机器上的 `api call` 按
  // `defaultProfile` 读到凭证并发出请求：两个命令给出相反的"凭证有没有配"。
  const profileName = resolveProfileName({
    envProfile, defaultProfile: file?.defaultProfile,
  }).name
  const profBlock = file?.profiles[profileName]
  const fileKey = profBlock?.credentials?.appKey
  const fileSecret = profBlock?.credentials?.appSecret

  const fromEnvKey = nonEmptyValue(envKey) !== undefined
  const fromEnvSecret = nonEmptyValue(envSecret) !== undefined
  const fromFileKey = nonEmptyValue(fileKey) !== undefined
  const fromFileSecret = nonEmptyValue(fileSecret) !== undefined

  // ⚠️ 配置文件里同一档的纯空白值也要拒绝（Codex PR #69）：只查环境变量时，配置文件里
  // `" "` 会被 `nonEmptyValue` 当成「有」，whoami 报 configured:true，而 api/sync 的
  // `resolveCredentials` 会拒绝它 —— 又是「谁都说配好了、只有真调用失败」的分叉。
  // ⚠️ 只在**该字段真的会取文件这一层**时才拒（逐字段优先级 env > file）：环境变量已给值时
  // 文件里的空白不会被选中，`api call` 也照常成功 —— 那时报错就是把好状态说成坏的。
  const blankFile = [
    ...(!fromEnvKey && isWhitespaceOnly(fileKey) ? ['appKey'] : []),
    ...(!fromEnvSecret && isWhitespaceOnly(fileSecret) ? ['appSecret'] : []),
  ]
  if (blankFile.length > 0) {
    return fail({
      code: 'auth_missing', kind: 'auth_missing', retryable: false,
      message: `配置文件里 profile ${JSON.stringify(profileName)} 的 ${blankFile.join('、')}`
        + ' 只有空白字符（不是有效凭证）',
      // ⚠️ 不能建议「删掉这个键」再改用环境变量（Codex PR #69 第七轮）：`credentials`
      // 块要求 appKey / appSecret 同时是非空字符串，只删一个键会让 parseConfig 拒绝
      // 整份配置（实测：随后 whoami 报「配置文件读取失败」，api/sync 也读不到其它档）。
      // 要改用环境变量，删的必须是**整个 credentials 块**。
      hint: `请在该档里把它设为真实值；若要改用环境变量（环境变量优先于配置文件），`
        + `删掉该档的整个 credentials 块（只删单个键会让配置文件解析失败）：${configPathFor()}`,
    })
  }

  const configured = (fromEnvKey || fromFileKey) && (fromEnvSecret || fromFileSecret)

  if (!configured) {
    const detail = configError !== undefined
      ? `（另外：配置文件读取失败 —— ${configError}）`
      : ''
    return fail({
      code: 'auth_missing', kind: 'auth_missing', retryable: false,
      message: `未检测到完整凭证。appKey 来自 ${fromEnvKey ? '环境变量' : fromFileKey ? '配置文件' : '（缺失）'}，` +
        `appSecret 来自 ${fromEnvSecret ? '环境变量' : fromFileSecret ? '配置文件' : '（缺失）'}${detail}`,
      hint: '运行 `qiyu auth login`（从环境变量 QIYU_APP_KEY/QIYU_APP_SECRET 写入配置），' +
        '或直接设置这两个环境变量',
    })
  }

  // ⚠️ `source` 必须**如实**是三态（G1 起有意义）：env 给一个、文件给另一个是
  // 合法组合（用户 export 了 appKey、appSecret 留在配置里）。只报单一来源是谎报，
  // 而 Agent 会据此判断"我 export 的那个到底生效了没有"。
  // ⚠️ 判据是**逐字段的实际取值来源**（env 优先），不是"文件是否完整" ——
  // 后者在「文件两个字段齐全 + env 只给 appKey」时错报 'file'，而 appKey 其实
  // 用的是 env 那个（实测踩到：这正是 mixed 最典型的形态）。
  const srcKey = fromEnvKey ? 'env' : 'file'
  const srcSecret = fromEnvSecret ? 'env' : 'file'
  const source = srcKey === srcSecret ? srcKey : 'mixed'

  // ⚠️ robots 不是死字段：`sync run` 的 knowledge.categories 在
  // store.options.knowledgeRobotIds 缺席时回退用它（见 sync-run.ts）。
  // 这里如实输出映射，**不声明**它已被校验过 —— 配置里的 robotId 可能无效或
  // 不属于本租户，CLI 不做这个校验（那需要发请求）。
  const robots = Object.entries(profBlock?.robots ?? {})
    .map(([id, name2]) => ({ id: Number(id), name: name2 }))

  return ok({
    configured: true,
    source,
    profile: profileName,
    robots,
  }, {
    // ⚠️ 配置文件读取失败**必须在成功路径上也可见**（2026-11-02 审查实测）：
    // 凭证齐全时 env 那两票足以让 configured 为 true，畸形配置（非法 JSON / 未知键）
    // 被吞进 `configError` —— 上一段代码只在 `!configured` 时把它拼进 message，
    // 成功路径完全不提，而 `robots` 静默变成 `[]`。实测：配置文件是
    // `{ "profiles": {...}, "unknownKey": 1 }` 时，whoami 输出
    // `{configured:true, source:"env", profile:"default", robots:[]}`，
    // 图例却只说「空数组有两种成因」—— Agent 会得出「该档没配 robots」，
    // 而真相是**配置根本没读成功**（那个档里可能配了 robots）。
    ...(configError !== undefined ? { warnings: [`配置文件读取失败（${configError}），本次的 profile / robots 均按「文件不存在」处理`] } : {}),
    field_notes: {
      source: 'env = 两个字段都来自环境变量；file = 都来自配置文件；mixed = 各来自一处（合法组合）',
      profile: '本次解析出的配置档名。选择顺序：环境变量 QIYU_PROFILE > 配置文件里声明的默认档名 > '
        + '内置 default（空串一律视为未设置）。'
        + '⚠️ 它只表示「本命令会去读哪个档」，**不保证该档在配置文件里存在** —— 环境变量给了一个'
        + '配置文件里没有的名字（拼错）时，本命令照样按 env 凭证报 configured，但这时 robots 必为空，'
        + '且只要配置文件里**已有其它档**，store / db / sync / query 对同一个名字就会以退出码 2 拒绝'
        + '（它们要读该档的 store 块）。注意后者的成立条件是「已有其它档」：配置文件的 profiles 为空时'
        + '它们按内置默认路径照常工作，不报错',
      robots: '来自配置文件的 profiles.<name>.robots 映射（robotId → 显示名），**未校验有效性**、' +
        '未与本地库比对；sync run 在 profiles.<name>.store.options.knowledgeRobotIds 缺席时回退使用它。'
        + '⚠️ 空数组有三种成因：该档没配 robots，该档在配置文件里根本不存在（见 profile 的说明），'
        + '或**配置文件读取失败**（畸形 JSON / 未知键）—— 第三种会在 meta.warnings 里点名，'
        + '先读 warnings 再判断。⚠️ **权限不足不在其列**：含凭证且权限过宽时本命令直接以 '
        + 'config_insecure **报错**（走 failFromTagged），根本到不了这个成功形态',
      configured: 'true 只表示"两个字段都有值"，**不代表**它们有效 —— 拼错的 appKey 同样返回 true',
    },
  })
}
