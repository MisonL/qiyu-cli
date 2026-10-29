// src/store/config.ts
//
// store 配置解析（命令行 > 环境变量 > 配置文件 > 内置默认，spec §3.2）。
//
// ⚠️ **G1 起「配置文件」这层载体抽到了 `core/config.ts`**：auth/api 需要读写同一份
// 文件，而它们按分层红线不得 import `store/`。本文件保留全部 store 语义
// （backend 枚举、路径展开、行为参数上界），配置文件的读取/键校验/权限检查
// 一律委托 core 层 —— 这样 auth 与 store 看到的「未知键」「JSON 畸形」「权限过宽」
// 是同一句话，不会出现两套口径。

import { homedir } from 'node:os'
import { join, isAbsolute } from 'node:path'
import type { BackendName, StoreConfig } from './types.js'
import { configPathFor, loadConfigFile, checkPermissions, configHasCredentials, insecureConfigError, nonEmptyValue, resolveProfileName } from '../core/config.js'
import type { ProfileBlock } from '../core/config.js'

export interface StoreEnv { QIYU_DB_PATH?: string; QIYU_STORE_BACKEND?: string; QIYU_PROFILE?: string }
export interface StoreFlags { db?: string; backend?: string; profile?: string }
export interface ResolveOpts { flags?: StoreFlags; env?: StoreEnv; home?: string; configPath?: string }

export const DEFAULTS = {
  relPath: join('.qiyu', 'duckdb', 'qiyu.duckdb'),
  backend: 'duckdb' as BackendName,
  readOnlyRetryMs: 30000,
  batchSize: 1000,
} as const

// store 块内的已知键 —— 未知键 fail-closed（spec §3.3）。
// ⚠️ options（D-T13）：配置面的「透传不校验内容」键——StoreConfig.options 的落点。
// config 层只保证它是对象、原样透传（消费方如 sync run 的 knowledgeRobotIds 自行
// 校验内容）；列进已知集让未知键检查放行。
const KNOWN_STORE = new Set(['backend', 'path', 'readOnlyRetryMs', 'batchSize', 'options'])

function assertKnownKeys(obj: Record<string, unknown>, known: Set<string>, prefix: string): void {
  for (const k of Object.keys(obj)) {
    if (!known.has(k)) throw new Error(`配置文件未知键：${prefix}${k}`)
  }
}

function expandHome(p: string, home: string): string {
  return p === '~' ? home : p.startsWith('~/') ? join(home, p.slice(2)) : p
}

/**
 * 取「命令行 > 环境变量 > 配置文件 > 内置默认」的某一层，**同时返回来源**（spec §3.2）。
 *
 * 为什么要来源：报错得说清是哪一层坏的（见下面的空白守卫）。
 * ⚠️ 环境变量层的空串已由 `nonEmptyValue`（core/config.ts，全仓唯一实现）归一成
 * undefined —— 传进来的 `env.QIYU_*` 必须先过它，否则 `''` 会遮蔽配置文件里的真值。
 */
function pickLayer(
  layers: ReadonlyArray<{ source: string; value: string | undefined }>,
  fallback: string,
): { value: string; source: string } {
  for (const l of layers) if (l.value !== undefined) return { value: l.value, source: l.source }
  return { value: fallback, source: '内置默认' }
}

function assertPositiveInt(v: unknown, key: string, max?: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
    throw new Error(`配置文件 ${key} 必须是正整数，实际为 ${JSON.stringify(v)}`)
  }
  // ⚠️ 上界守卫（R 组 R4）：readOnlyRetryMs=1e15 会让 status 撞锁时挂起 ~31 年
  //（assertPositiveInt 放行 1e15）—— 挂起级 DoS。超上界 → usage 拒绝点名键路径。
  if (max !== undefined && v > max) {
    throw new Error(`配置文件 ${key} 不得超过 ${max}，实际为 ${JSON.stringify(v)}`)
  }
  return v
}

/**
 * 当前进程的三元环境变量（架构审查 M-3）。
 *
 * 此前 6 个调用点各自手写 `{ QIYU_DB_PATH: process.env.QIYU_DB_PATH, … }` ——
 * `resolveStoreConfig` 对缺省 env 是**静默忽略**（`opts.env ?? {}`），所以加第 4 个
 * 环境变量时漏改任何一处，那条命令就会静默用默认库、与同族命令分叉。
 * 调用方应传 `env: currentStoreEnv()`；需要注入的测试自己传对象。
 */
export function currentStoreEnv(): StoreEnv {
  return {
    QIYU_DB_PATH: process.env.QIYU_DB_PATH,
    QIYU_STORE_BACKEND: process.env.QIYU_STORE_BACKEND,
    QIYU_PROFILE: process.env.QIYU_PROFILE,
  }
}

/**
 * 解析 store 配置：命令行 > 环境变量 > 配置文件 > 内置默认（spec §3.2）。
 * ⚠️ 只读不写；写入走 `auth login`（`commands/auth.ts` → `core/config.ts`）。
 */
export function resolveStoreConfig(opts: ResolveOpts = {}): {
  config: StoreConfig; configPath: string; configExists: boolean
} {
  const home = opts.home ?? homedir()
  const configPath = opts.configPath ?? configPathFor(home)
  const env = opts.env ?? {}
  const flags = opts.flags ?? {}

  // ⚠️ 读文件与结构解析都在 core 层 —— 「未知键 / JSON 畸形 / 形态不对」的文案
  // 与 auth/api 看到的是同一份，不会出现两套口径。
  const { file, exists: configExists } = loadConfigFile(configPath)

  if (configExists) {
    // ⚠️ 权限检查（spec §3.4）：文件权限过宽 → 警告；**含凭证时升级为拒绝**（G1）。
    const perm = checkPermissions(configPath, {
      hasCredentials: configHasCredentials(file),
      onWarn: (m) => process.stderr.write(`${m}\n`),
    })
    if (!perm.ok) {
      // ⚠️ 必须抛**带 kind** 的错误（2026-10-26 实测修）：这里此前抛普通 Error，而各命令
      // catch 一律 `usageFail(...)` —— 于是「配置含凭证且权限过宽」在 store/db/query/stats/
      // sync 上被降级成退出码 2 + `kind: usage`（"改参数重来"）且 hint 丢失，只有
      // auth/api 那条路径如实给出退出码 1 + `kind: config_insecure`。同一个危险状态两种
      // 行为，Agent 会去改参数而真正的动作是 chmod。统一由 core 的构造点产出。
      throw insecureConfigError(configPath, perm.reason)
    }
  }

  const profiles = file.profiles as Record<string, ProfileBlock>
  for (const [name, prof] of Object.entries(profiles)) {
    const store = prof.store
    if (store === undefined) continue
    // store 块的**语义**校验仍在本层（core 只管「是对象、键已知」的通用形态）。
    assertKnownKeys(store, KNOWN_STORE, `profiles.${name}.store.`)
    // options：透传不校验内容（D-T13），但形态必须是对象（数组/标量显式拒绝）。
    if (store.options !== undefined &&
        (store.options === null || typeof store.options !== 'object' || Array.isArray(store.options))) {
      throw new Error(`配置文件 profiles.${name}.store.options 必须是对象`)
    }
  }

  // ⚠️ 点名的 profile 必须存在（2026-10-27 实测修）：此前 `profiles[profileName] ?? {}`
  // 把「profile 拼错」和「profile 存在但没配 store」合并成同一个静默回落 ——
  // `--profile prodd`（少一个字母）会读到**默认库**并返回 `ok:true` 与其中的数据，
  // Agent 看不出自己读错了库；`store init --profile prodd` 还会在默认路径上创建
  // 一个用户从未配置的库。与全仓「未知名字必须拒绝并给候选」一致（未知表/未知任务/
  // 未知接口 id/未知后端/未知配置键），也与 §3.3「拼错的配置键静默无效等于让用户
  // 以为设置生效了」同一条理由。
  //
  // 边界（刻意保留的回落）：
  //   · 配置文件不存在 → `loadConfigFile` 给出空 file，`profiles` 为空，
  //     下面的 `available.length > 0` 直接放行（首次运行）—— 所以不需要再判
  //     `configExists`（实测删掉该条件全绿：它与长度判据完全冗余，留着是死条件）；
  //   · 配置文件存在但 `profiles` 为空 → 同上（空配置没有可选项）；
  //   · profile 存在但缺 store 块 → 走默认（tests/store/config.test.ts 钉着）；
  //   · 未点名任何 profile（连 defaultProfile 都没有）→ 用内置 `default`，不查。
  // ⚠️ 空串口径与 auth 侧逐字一致：`--profile ''` 是 usage 错误（`auth login` 的
  // normalizeProfile 同样报「--profile 不能为空」）；`QIYU_PROFILE=`（变量未设的
  // 典型形态）与 `defaultProfile: ''` 当未设置 —— 档名解析走 core 的
  // `resolveProfileName`（唯一实现），凭证侧与 store 侧不得对同一份配置给出两种解读。
  if (flags.profile !== undefined && flags.profile.trim() === '') {
    throw new Error('--profile 不能为空')
  }
  const namedProfile = resolveProfileName({
    flag: flags.profile, envProfile: env.QIYU_PROFILE, defaultProfile: file.defaultProfile,
  })
  const profileName = namedProfile.name
  if (namedProfile.source !== undefined) {
    const available = Object.keys(profiles)
    // ⚠️ own-property 判据（2026-10-27，CodeRabbit）：`profiles[x] === undefined` 会被
    // 原型链绕过 —— `--profile constructor` / `toString` 命中 `Object.prototype` 上的
    // 继承属性，守卫放行后回落默认库。parseConfig 已改用 null 原型对象，这里是第二道锁
    // （resolveStoreConfig 的 profiles 只来自 parseConfig，但判据本身不该依赖来源）。
    if (available.length > 0 && !Object.hasOwn(profiles, profileName)) {
      throw new Error(
        `配置文件里没有 profile ${JSON.stringify(profileName)}（来自 ${namedProfile.source}；` +
        `现有：${available.join('、')}）—— 检查拼写，或先在配置文件里加上这个 profile`,
      )
    }
  }
  const prof = Object.hasOwn(profiles, profileName) ? profiles[profileName] : {}
  const storeBlock = (prof.store ?? {}) as Record<string, unknown>

  // backend 的类型守卫与 path 同款（此前只有 path 有）：配置写 123 / {} 时，
  // `未知后端：[object Object]。目前仅支持 duckdb` 既不点名键路径、也读不出坏了什么。
  if (storeBlock.backend !== undefined && typeof storeBlock.backend !== 'string') {
    throw new Error(`配置文件 profiles.${profileName}.store.backend 必须是字符串`)
  }
  const backend = pickLayer([
    { source: '--backend', value: flags.backend },
    { source: 'QIYU_STORE_BACKEND', value: nonEmptyValue(env.QIYU_STORE_BACKEND) },
    { source: `配置文件 profiles.${profileName}.store.backend`, value: storeBlock.backend as string | undefined },
  ], DEFAULTS.backend)
  const rawBackend = backend.value
  if (rawBackend !== 'duckdb') {
    throw new Error(`未知后端：${JSON.stringify(rawBackend)}（来自 ${backend.source}）。目前仅支持 duckdb`)
  }
  // ⚠️ path 类型守卫（K 组 M1）：配置写数字/对象时，expandHome 会对非字符串调
  // startsWith 抛裸英文 TypeError，且不点名键路径 —— 违反 fail-closed 点名键路径约定。
  if (storeBlock.path !== undefined && typeof storeBlock.path !== 'string') {
    throw new Error(`配置文件 profiles.${profileName}.store.path 必须是字符串`)
  }
  const path = pickLayer([
    { source: '--db', value: flags.db },
    { source: 'QIYU_DB_PATH', value: nonEmptyValue(env.QIYU_DB_PATH) },
    { source: `配置文件 profiles.${profileName}.store.path`, value: storeBlock.path as string | undefined },
  ], DEFAULTS.relPath)
  const rawPath = path.value
  // ⚠️ 空串守卫（K 组 M4）：空白值会穿过所有前置检查直达 DuckDB，产出难懂的底层错误。
  // 空串不是合法路径，usage 拒绝。
  // ⚠️ 文案点名**真正给了空白值的那一层**（2026-10-29 实测修）：此前写死
  // 「--db / QIYU_DB_PATH / store.path 均为空」—— 而实测 store.path 明明配了值，
  // 是被 `QIYU_DB_PATH=` 遮蔽的（报错把三层一起指控，Agent 会去改没坏的那层）。
  // ⚠️ 环境变量的**空串**到不了这里（`nonEmptyValue` 已视为未设置）；能到这里的是
  // 显式 flag 的空白值、空白串环境变量（`'   '`）、以及配置文件里的空白 path。
  if (rawPath.trim() === '') {
    throw new Error(`数据库路径不能为空：${path.source} 给了空白值 ${JSON.stringify(rawPath)}。`
      + '空串不是合法路径 —— 想回落到下一层：别传这个 flag / unset 这个变量 / 删掉这个配置键')
  }
  const readOnlyRetryMs = storeBlock.readOnlyRetryMs === undefined
    ? DEFAULTS.readOnlyRetryMs
    : assertPositiveInt(storeBlock.readOnlyRetryMs, `profiles.${profileName}.store.readOnlyRetryMs`, 300_000)
  const batchSize = storeBlock.batchSize === undefined
    ? DEFAULTS.batchSize
    : assertPositiveInt(storeBlock.batchSize, `profiles.${profileName}.store.batchSize`, 100_000)

  // 相对路径（内置默认 relPath）按 home 解析；~ 前缀展开为 home（M-6）
  const expanded = expandHome(rawPath, home)
  const finalPath = isAbsolute(expanded) ? expanded : join(home, expanded)

  return {
    config: {
      backend: rawBackend as BackendName, path: finalPath, readOnlyRetryMs, batchSize,
      // options 透传不校验内容（D-T13）：消费方（sync run 的 knowledgeRobotIds 等）自校验。
      ...(storeBlock.options !== undefined
        ? { options: storeBlock.options as Record<string, unknown> }
        : {}),
    },
    configPath,
    configExists,
  }
}
