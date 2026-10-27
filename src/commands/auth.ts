// src/commands/auth.ts
import { dirname } from 'node:path'
import { resolveCredentials } from '../core/credentials.js'
import { ok, fail, usageFail, failFromTagged, describeArgs, setPretty, EXIT } from '../output.js'
import {
  configPathFor, loadConfigFile, loadConfigChecked, writeConfigFile, checkPermissions, shellPath,
} from '../core/config.js'
import type { QiyuConfigFile, ProfileBlock } from '../core/config.js'
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES, prettyAfterSubcommand, REJECTED_FLAGS } from './spec-types.js'
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
留在 shell 历史与进程列表里）。写入 ~/.config/qiyu/config.json，目录 0700、文件 0600。

出错时 stdout 是 {"ok":false,"error":{code,kind,retryable,message,hint?}}。
  ⚠️ 请按 kind 分支，不要按 code —— code 只是个标签：它可能是服务端的
     数字码（如 14009），也可能是本 CLI 合成的词（usage / network / internal /
     auth_missing / config_insecure / confirm_required / store_locked / store_not_initialized /
     local_rate_limit / unknown）。合成词查不到官方错误码表。

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
    const positional = argv.slice(1).filter((a) => !a.startsWith('-'))
    const extra = [...unknown, ...positional]
    if (extra.length > 0) {
      return usageFail(`未知参数：${describeArgs(extra)}。--pretty 不接受额外参数`)
    }
    if (argv.includes('--help') || argv.includes('-h')) {
      process.stdout.write(AUTH_USAGE)
      return EXIT.OK
    }
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
  const appKey = envKey !== undefined && envKey !== '' ? envKey : undefined
  const appSecret = envSecret !== undefined && envSecret !== '' ? envSecret : undefined
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
    file = loadConfigFile(configPath).file
  } catch (e) {
    // 读不出来（畸形 JSON / 未知键 / 权限拒绝）——不能"无视坏文件直接覆盖"：
    // 那会静默丢掉用户手写的其它配置。如实报错，让人先修。
    return usageFail(`无法读取现有配置文件：${(e as Error).message}`)
  }
  // ⚠️ 与全局优先级一致（spec §3.2：命令行 > 环境变量 > 配置文件 > 默认）——
  // 此前写成 defaultProfile 优先于 QIYU_PROFILE，同一台机器上 export 过
  // QIYU_PROFILE 的用户会发现自己写进了别的 profile。
  const name = profile
    ?? (process.env.QIYU_PROFILE !== undefined && process.env.QIYU_PROFILE !== '' ? process.env.QIYU_PROFILE : undefined)
    ?? file.defaultProfile ?? 'default'
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
      hint: '请检查路径权限（父目录可写、非符号链接），或换到 HOME 下可写的位置',
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
        + '（拼错的 appKey 同样返回 true —— 用 auth whoami 或一次真实调用验证）',
      profile: '写入的配置档名（--profile 指定，缺省 default）',
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
  const profileName = envProfile ?? file?.defaultProfile ?? 'default'
  const profBlock = file?.profiles[profileName]
  const fileKey = profBlock?.credentials?.appKey
  const fileSecret = profBlock?.credentials?.appSecret

  const fromEnvKey = envKey !== undefined && envKey !== ''
  const fromEnvSecret = envSecret !== undefined && envSecret !== ''
  const fromFileKey = fileKey !== undefined && fileKey !== ''
  const fromFileSecret = fileSecret !== undefined && fileSecret !== ''

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
    field_notes: {
      source: 'env = 两个字段都来自环境变量；file = 都来自配置文件；mixed = 各来自一处（合法组合）',
      robots: '来自配置文件的 profiles.<name>.robots 映射（robotId → 显示名），**未校验有效性**、' +
        '未与本地库比对；sync run 在 profiles.<name>.store.options.knowledgeRobotIds 缺席时回退使用它',
      configured: 'true 只表示"两个字段都有值"，**不代表**它们有效 —— 拼错的 appKey 同样返回 true',
    },
  })
}
