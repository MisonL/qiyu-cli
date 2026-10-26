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
import { configPathFor, loadConfigFile, checkPermissions, configHasCredentials, insecureConfigError } from '../core/config.js'
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

  const profileName = flags.profile ?? env.QIYU_PROFILE ?? file.defaultProfile ?? 'default'
  const prof = profiles[profileName] ?? {}
  const storeBlock = (prof.store ?? {}) as Record<string, unknown>

  const rawBackend = flags.backend ?? env.QIYU_STORE_BACKEND ?? (storeBlock.backend as string | undefined) ?? DEFAULTS.backend
  if (rawBackend !== 'duckdb') {
    throw new Error(`未知后端：${rawBackend}。目前仅支持 duckdb`)
  }
  // ⚠️ path 类型守卫（K 组 M1）：配置写数字/对象时，expandHome 会对非字符串调
  // startsWith 抛裸英文 TypeError，且不点名键路径 —— 违反 fail-closed 点名键路径约定。
  if (storeBlock.path !== undefined && typeof storeBlock.path !== 'string') {
    throw new Error(`配置文件 profiles.${profileName}.store.path 必须是字符串`)
  }
  const rawPath = flags.db ?? env.QIYU_DB_PATH ?? (storeBlock.path as string | undefined) ?? DEFAULTS.relPath
  // ⚠️ 空串守卫（K 组 M4）：`--db ""`（脚本里变量未设的典型形态）会穿过所有前置检查
  // 直达 DuckDB，产出难懂的底层错误。空串不是合法路径，usage 拒绝。
  if (rawPath.trim() === '') {
    throw new Error('数据库路径不能为空（--db / QIYU_DB_PATH / store.path 均为空）')
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
