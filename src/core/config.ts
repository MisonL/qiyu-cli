// src/core/config.ts
//
// 配置文件的**通用层**（G1 第三批抽取）：路径解析、读文件、JSON 解析、
// 键白名单校验、credentials/robots 块校验、权限检查、原子写。
// 只 import node:fs/os/path —— 这是「commands/auth.ts 与 commands/api.ts
// 不得加载 store/」这条分层红线（layering.test.ts 钉着）的解法：
// auth/api 只 import 本文件，`store/config.ts` 内部也走这里。
//
// ⚠️ 与 `store/config.ts` 的分工：本文件不知道任何 **store 专属**字段
// （backend/path/readOnlyRetryMs/batchSize/options 的语义校验仍在 store 侧），
// 只提供「配置文件作为载体」的全部通用能力。错误文案与 C1 逐字兼容 ——
// 现有 25 条 config.test.ts 一条不改地全绿是本次抽取的验收线。

import { readFileSync, writeFileSync, lstatSync, statSync, existsSync, mkdirSync, renameSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'

/** 顶层已知键 —— 未知键 fail-closed（spec §3.3）。 */
export const KNOWN_TOP = new Set(['defaultProfile', 'profiles'])
/** profile 内已知键：store（C1）+ credentials/robots（G1 起，`auth login` 写入）。 */
export const KNOWN_PROFILE = new Set(['store', 'credentials', 'robots'])

/** profile 级凭证块。写入方（auth login）与读取方（whoami/api）共用这一形态。 */
export interface CredentialsBlock { appKey: string; appSecret: string }

/** 某个 profile 的完整配置块（store 部分的语义校验在 store/config.ts）。 */
export interface ProfileBlock {
  store?: Record<string, unknown>
  credentials?: CredentialsBlock
  robots?: Record<string, string>
}

/** 整份配置文件（解析并校验后的形态）。 */
export interface QiyuConfigFile {
  defaultProfile?: string
  profiles: Record<string, ProfileBlock>
}

/** 配置文件的默认路径（`~/.config/qiyu/config.json`）。 */
export function configPathFor(home: string = homedir()): string {
  return join(home, '.config', 'qiyu', 'config.json')
}

/** 读出配置文件原文并解析为普通对象；文件不存在返回 `{}`。校验由 `parseConfig` 做。 */
export function readConfigRaw(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {}
  let raw: string
  try {
    raw = readFileSync(configPath, 'utf8')
  } catch (e) {
    throw new Error(`无法读取配置文件 ${configPath}：${e instanceof Error ? e.message : String(e)}`)
  }
  try {
    return JSON.parse(raw) as Record<string, unknown>
  } catch (e) {
    throw new Error(`配置文件 ${configPath} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
  }
}

function assertObject(v: unknown, label: string): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) {
    throw new Error(`配置文件 ${label} 必须是对象`)
  }
  return v as Record<string, unknown>
}

/**
 * 结构校验：顶层/profile/credentials/robots 的形态与类型。
 * ⚠️ **不**校验 store 块的内容（backend 枚举、正整数上界等）—— 那是
 * `store/config.ts` 的领域知识，本文件只保证「它是一个对象、键已知」。
 */
export function parseConfig(raw: Record<string, unknown>): QiyuConfigFile {
  for (const k of Object.keys(raw)) {
    if (!KNOWN_TOP.has(k)) throw new Error(`配置文件未知键：${k}`)
  }
  const profiles: Record<string, ProfileBlock> = {}
  if (raw.profiles !== undefined) {
    const profObj = assertObject(raw.profiles, 'profiles')
    for (const [name, prof] of Object.entries(profObj)) {
      const p = assertObject(prof, `profiles.${name}`)
      for (const k of Object.keys(p)) {
        if (!KNOWN_PROFILE.has(k)) throw new Error(`配置文件未知键：profiles.${name}.${k}`)
      }
      const block: ProfileBlock = {}
      if (p.store !== undefined) block.store = assertObject(p.store, `profiles.${name}.store`)
      if (p.credentials !== undefined) {
        const c = assertObject(p.credentials, `profiles.${name}.credentials`)
        if (typeof c.appKey !== 'string' || !c.appKey) {
          throw new Error(`配置文件 profiles.${name}.credentials.appKey 必须是非空字符串`)
        }
        if (typeof c.appSecret !== 'string' || !c.appSecret) {
          throw new Error(`配置文件 profiles.${name}.credentials.appSecret 必须是非空字符串`)
        }
        block.credentials = { appKey: c.appKey, appSecret: c.appSecret }
      }
      if (p.robots !== undefined) {
        const r = assertObject(p.robots, `profiles.${name}.robots`)
        for (const [rid, rname] of Object.entries(r)) {
          if (!/^\d+$/.test(rid)) {
            throw new Error(`配置文件 profiles.${name}.robots 的键必须是数字 id，实际是 ${JSON.stringify(rid)}`)
          }
          if (typeof rname !== 'string' || rname.trim() === '') {
            throw new Error(`配置文件 profiles.${name}.robots.${rid} 必须是非空字符串`)
          }
        }
        block.robots = r as Record<string, string>
      }
      profiles[name] = block
    }
  }
  let defaultProfile: string | undefined
  if (raw.defaultProfile !== undefined) {
    if (typeof raw.defaultProfile !== 'string') throw new Error('配置文件 defaultProfile 必须是字符串')
    defaultProfile = raw.defaultProfile
  }
  return { defaultProfile, profiles }
}

/** 读 + 解析一步完成（文件不存在返回空结构）。**不含权限裁决**（见 `loadConfigChecked`）。 */
export function loadConfigFile(configPath: string): { file: QiyuConfigFile; exists: boolean } {
  const exists = existsSync(configPath)
  const raw = readConfigRaw(configPath)
  return { file: parseConfig(raw), exists }
}

/**
 * 权限拒绝的**唯一构造点**（两个配置解析入口共用同一句话）。
 *
 * ⚠️ 为什么必须共用（2026-10-26 实测）：此前 `loadConfigChecked`（auth/api 走）抛带
 * `kind: config_insecure` 的错误，而 `store/config.ts`（store/db/query/stats/sync 走）
 * 抛**无 kind** 的普通 Error，各命令 catch 又一律 `usageFail(...)` —— 同一个危险状态
 * 因此有两种行为：`auth whoami` 是退出码 1 + `kind: config_insecure` + `chmod` hint；
 * 其余六条命令是退出码 2 + `kind: usage`（语义是"改参数重来"）且 hint 丢失。
 * Agent 会照退出码去改参数，而这件事只能由人去 chmod —— 设计稿 §3.4 与 README
 * 写的都是前者，所以 store 那条路径是缺陷，不是另一种口径。
 */
export function insecureConfigError(configPath: string, reason: 'file' | 'dir'): Error {
  const dir = dirname(configPath)
  const what = reason === 'file'
    ? `配置文件 ${configPath} 含凭证但权限过宽（group/other 可访问，其他用户可读到 appSecret）`
    : `配置目录 ${dir} 权限过宽（group/other 可写，文件可被整体替换）且配置含凭证`
  const fix = reason === 'file' ? `chmod 600 ${configPath}` : `chmod 700 ${dir}`
  return Object.assign(
    new Error(`${what}，已拒绝读取`),
    {
      code: 'config_insecure', kind: 'config_insecure', retryable: false,
      hint: `这是配置文件的权限问题，重试无用 —— 请执行：${fix}`,
    },
  )
}

/**
 * 读 + 解析 + **权限裁决**（含凭证且过宽 → 抛带 kind 的错误）。
 *
 * ⚠️ 这是所有「按配置取凭证」的入口（auth/api/sync/store）应走的函数 ——
 * 权限裁决必须与读取同源，否则会出现「某条命令查了、另一条没查」的不一致，
 * 而那正是「同一个危险状态，两种行为」。无凭证的文件维持警告（C1 既有口径）。
 *
 * 抛出的错误带 `code/kind: 'config_insecure'`（退出码 1，重试无用）——
 * 调用方用 `failFromTagged` 原样转成信封；**不要**用 usageFail 包它
 * （那是"改参数重来"的语义，而这件事只能由人去 chmod）。
 */
export function loadConfigChecked(configPath: string): { file: QiyuConfigFile; exists: boolean } {
  const loaded = loadConfigFile(configPath)
  if (!loaded.exists) return loaded
  const perm = checkPermissions(configPath, {
    hasCredentials: configHasCredentials(loaded.file),
    onWarn: (m) => process.stderr.write(`${m}\n`),
  })
  if (!perm.ok) throw insecureConfigError(configPath, perm.reason)
  return loaded
}

/**
 * 本进程内已发出过警告的路径 —— **警告去重**。
 *
 * ⚠️ 为什么需要（G1 实测）：`sync run` 一次执行读**两遍**配置 —— 凭证合流
 * （`credentials-source.ts`）与 `resolveStoreConfig` 各调一次权限检查。文件不含凭证
 * 但权限过宽时，同一条「权限过宽（建议 chmod 600）」会在 stderr 出现**两次**，
 * 用户会以为有两个不同的问题。拒绝路径不受影响（第一次就直接抛了）。
 * 按「检查项 + 路径」记键，同进程只说一次；跨进程（下一次命令调用）仍会提醒 ——
 * 警告的职责是"这次运行的环境有问题"，不是"这台机器上只许提一次"。
 */
const warnedPermissionPaths = new Set<string>()
/** 测试用：清空警告去重表（同 `__resetBuckets` 的先例 —— 模块级状态必须可重置）。 */
export function __resetPermissionWarnings(): void { warnedPermissionPaths.clear() }

/**
 * 权限检查（spec §3.4）。G1 起**含凭证即拒绝**（不再只是警告）：
 * 文件 0644 落盘的 appSecret 对同机其他用户可读 —— 「警告不阻断」是
 * C1 无凭证时代的口径，写入凭证后继续沿用等于每次调用都打印一句
 * 没人执行的提示。
 *
 * ⚠️ 拒绝判据 = 文件 group/other 有**任何**位 && 至少一个 profile 含 credentials。
 * 无 credentials 的文件维持警告（既有行为，C1 测试钉着）。
 * ⚠️ `auth login` 的写入路径（`writeConfigFile`）总是产出 0600 文件 —— 所以
 * 「含凭证且过宽」只会在用户手工 chmod 放宽时出现，此时拒绝并提示收紧。
 */
export function checkPermissions(
  configPath: string,
  opts: { hasCredentials: boolean; onWarn: (msg: string) => void },
): { ok: true } | { ok: false; reason: 'file' | 'dir' } {
  if (process.platform === 'win32') return { ok: true }
  const mode = statSync(configPath).mode & 0o777
  const fileWide = (mode & 0o077) !== 0
  if (fileWide) {
    if (opts.hasCredentials) return { ok: false, reason: 'file' }
    const key = `file:${configPath}`
    if (!warnedPermissionPaths.has(key)) {
      warnedPermissionPaths.add(key)
      opts.onWarn(`配置文件 ${configPath} 权限过宽（建议 chmod 600）`)
    }
  }
  // 父目录：只查 group/other **写位**（0o755 是常规 umask 产物，不警告）；
  // 目录可整体替换文件 → 含凭证时同样拒绝。
  const dirMode = statSync(dirname(configPath)).mode & 0o777
  if ((dirMode & 0o022) !== 0) {
    if (opts.hasCredentials) return { ok: false, reason: 'dir' }
    const dirKey = `dir:${dirname(configPath)}`
    if (!warnedPermissionPaths.has(dirKey)) {
      warnedPermissionPaths.add(dirKey)
      opts.onWarn(`配置目录 ${dirname(configPath)} 权限过宽（建议 chmod 700）`)
    }
  }
  return { ok: true }
}

/** 配置文件是否含任何 credentials 块（权限升级判据）。 */
export function configHasCredentials(file: QiyuConfigFile): boolean {
  return Object.values(file.profiles).some((p) => p.credentials !== undefined)
}

/** 读某个 profile 的结果（凭证/robots 的共用出口）。 */
export interface FileProfileResult {
  profileName: string
  profile?: ProfileBlock
  /** 带 kind 的致命错误（权限拒绝）—— 调用方**必须** `failFromTagged` 转出，不能当"没读到"。 */
  fatal?: unknown
  /** 非致命问题（JSON 畸形/未知键）—— env 齐备时命令仍应工作，所以不阻断。 */
  warn?: string
}

/**
 * 读配置里某个 profile 的块（G1：凭证与 robots 都从这里取）。
 *
 * ⚠️ 走 `loadConfigChecked` —— **权限裁决与读取同源**，否则会出现
 * 「auth 查了、api 没查」的不一致：同一个危险状态两种行为。
 * ⚠️ 畸形配置**不抛**（只记 `warn`）：环境变量齐备时 `api call` 仍应能工作 ——
 * 把一个坏掉的配置文件升级成"所有命令都不可用"是过度反应。
 * 但**缺凭证**的最终判定仍由 `resolveCredentials` 做，本函数不越权下结论。
 */
export function fileProfile(
  configPath: string = configPathFor(),
  envProfile: string | undefined = process.env.QIYU_PROFILE,
): FileProfileResult {
  let file: QiyuConfigFile
  try {
    file = loadConfigChecked(configPath).file
  } catch (e) {
    // ⚠️ 空串当未设置：`export QIYU_PROFILE=`（变量未设的典型形态）不该选中
    // 一个名叫 '' 的 profile —— 与凭证侧「空串视为缺失」同一口径。
    const name = envProfile !== undefined && envProfile !== '' ? envProfile : 'default'
    // 权限拒绝带 kind（`config_insecure`）→ 致命；畸形配置无 kind → 非致命。
    return (e as { kind?: string }).kind !== undefined
      ? { profileName: name, fatal: e }
      : { profileName: name, warn: (e as Error).message }
  }
  const profileName = envProfile !== undefined && envProfile !== '' ? envProfile
    : file.defaultProfile !== undefined && file.defaultProfile !== '' ? file.defaultProfile
    : 'default'
  const profile = file.profiles[profileName]
  return profile === undefined ? { profileName } : { profileName, profile }
}

/** 配置里某个 profile 的凭证（`fileProfile` 的便捷视图，供 `resolveCredentials` 的第三参）。 */
export function fileCredentials(
  configPath?: string,
  envProfile?: string,
): FileProfileResult & { creds?: CredentialsBlock } {
  const r = fileProfile(configPath, envProfile)
  return r.profile?.credentials === undefined ? r : { ...r, creds: r.profile.credentials }
}

/**
 * 原子写配置文件：0700 目录 + 0600 临时文件 + rename 换入。
 *
 * ⚠️ **绝不用 writeFileSync 直写**：写一半崩溃会留下一个被截断的 config.json，
 * 下一次任何命令都起不来。临时文件与目标同目录（rename 跨文件系统才原子）。
 * ⚠️ config 是符号链接时拒绝 —— 写入会穿透到链接目标（可能是任意路径）。
 * ⚠️ 合并语义由调用方先算好完整内容；本函数只负责「安全落盘」。
 */
export function writeConfigFile(configPath: string, content: QiyuConfigFile): void {
  const dir = dirname(configPath)
  // ⚠️ lstat 不跟随链接：statSync 会穿透到目标，探测不到「config 本身是链接」。
  // 文件不存在（首次 login）是正常路径 —— ENOENT 放行，其余 errno 照常抛。
  try {
    if (lstatSync(configPath).isSymbolicLink()) {
      throw new Error(`配置文件 ${configPath} 是符号链接，拒绝写入（写入会穿透到链接目标）`)
    }
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = join(dir, `.config.json.tmp-${process.pid}-${Date.now()}`)
  writeFileSync(tmp, serializeConfig(content), { mode: 0o600 })
  chmodSync(tmp, 0o600)   // mkdir 的 umask 不作用于文件，显式 chmod 兜住 0o600
  renameSync(tmp, configPath)
}

/** 读出的整份配置序列化回 JSON（保存时的规范形态：缩进 2 + 尾换行）。 */
export function serializeConfig(content: QiyuConfigFile): string {
  return JSON.stringify(content, null, 2) + '\n'
}
