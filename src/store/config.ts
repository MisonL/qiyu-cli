// src/store/config.ts
import { readFileSync, statSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname, isAbsolute } from 'node:path'
import type { BackendName, StoreConfig } from './types.js'

export interface StoreEnv { QIYU_DB_PATH?: string; QIYU_STORE_BACKEND?: string; QIYU_PROFILE?: string }
export interface StoreFlags { db?: string; backend?: string; profile?: string }
export interface ResolveOpts { flags?: StoreFlags; env?: StoreEnv; home?: string; configPath?: string }

export const DEFAULTS = {
  relPath: join('.qiyu', 'duckdb', 'qiyu.duckdb'),
  backend: 'duckdb' as BackendName,
  readOnlyRetryMs: 30000,
  batchSize: 1000,
} as const

/** 已知键白名单 —— 未知键 fail-closed（spec §3.3）。 */
const KNOWN_TOP = new Set(['defaultProfile', 'profiles'])
const KNOWN_PROFILE = new Set(['store'])
const KNOWN_STORE = new Set(['backend', 'path', 'readOnlyRetryMs', 'batchSize'])

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
 * 解析 store 配置：命令行 > 环境变量 > 配置文件 > 内置默认（spec §3.2）。
 * ⚠️ 只读不写；配置文件由用户手工维护（`auth login` 归 G1，spec §3.5）。
 */
export function resolveStoreConfig(opts: ResolveOpts = {}): {
  config: StoreConfig; configPath: string; configExists: boolean
} {
  const home = opts.home ?? homedir()
  const configPath = opts.configPath ?? join(home, '.config', 'qiyu', 'config.json')
  const env = opts.env ?? {}
  const flags = opts.flags ?? {}

  let file: Record<string, unknown> = {}
  const configExists = existsSync(configPath)
  if (configExists) {
    let raw: string
    try {
      raw = readFileSync(configPath, 'utf8')
    } catch (e) {
      throw new Error(`无法读取配置文件 ${configPath}：${e instanceof Error ? e.message : String(e)}`)
    }
    try {
      file = JSON.parse(raw) as Record<string, unknown>
    } catch (e) {
      throw new Error(`配置文件 ${configPath} 不是合法 JSON：${e instanceof Error ? e.message : String(e)}`)
    }
    assertKnownKeys(file, KNOWN_TOP, '')
    // ⚠️ 权限检查（spec §3.4）：POSIX 下 group/other 有任何位 → 警告，不阻断。
    // C1 配置不含凭证；G1 加入凭证时此处须升级为拒绝（spec §3.4 的交接）。
    if (process.platform !== 'win32') {
      const mode = statSync(configPath).mode & 0o777
      if ((mode & 0o077) !== 0) {
        process.stderr.write(`配置文件 ${configPath} 权限过宽（建议 chmod 600）\n`)
      }
      // 父目录同款检查（spec §3.4 v3 扩面，I 组 M2 补——0777 目录可整体替换文件）。
      // 注：目录只查 group/other 写位（0o755 是常规 umask 产物，不警告）；
      // 文件本身仍查全部 group/other 位。
      const dirMode = statSync(dirname(configPath)).mode & 0o777
      if ((dirMode & 0o022) !== 0) {
        process.stderr.write(`配置目录 ${dirname(configPath)} 权限过宽（建议 chmod 700）\n`)
      }
    }
  }

  // ⚠️ profiles 类型守卫（K 组 M2）：数组/字符串会被 Object.entries 逐索引/逐字符枚举，
  // 产生荒诞的 profile 名而不报错 —— fail-closed 显式拒绝。
  if (file.profiles !== undefined && (file.profiles === null || typeof file.profiles !== 'object' || Array.isArray(file.profiles))) {
    throw new Error('配置文件 profiles 必须是对象')
  }
  const profiles = (file.profiles ?? {}) as Record<string, Record<string, unknown>>
  for (const [name, prof] of Object.entries(profiles)) {
    if (prof === null || typeof prof !== 'object' || Array.isArray(prof)) {
      throw new Error(`配置文件 profiles.${name} 必须是对象`)
    }
    assertKnownKeys(prof, KNOWN_PROFILE, `profiles.${name}.`)
    // store 块存在但非对象（含 null）→ fail-closed 显式报错（不静默走默认，spec §3.3）
    if (prof.store !== undefined && (prof.store === null || typeof prof.store !== 'object' || Array.isArray(prof.store))) {
      throw new Error(`配置文件 profiles.${name}.store 必须是对象`)
    }
    const store = (prof.store ?? {}) as Record<string, unknown>
    if (store !== null && typeof store === 'object' && !Array.isArray(store)) {
      assertKnownKeys(store, KNOWN_STORE, `profiles.${name}.store.`)
    }
  }

  // ⚠️ defaultProfile 非 string → fail-closed（K 组 M2：否则静默走默认库，用户写的
  // profile 名被无声忽略，与 spec §3.3 的 fail-closed 精神相悖）。
  if (file.defaultProfile !== undefined && typeof file.defaultProfile !== 'string') {
    throw new Error('配置文件 defaultProfile 必须是字符串')
  }
  const profileName = flags.profile ?? env.QIYU_PROFILE ?? (file.defaultProfile as string | undefined) ?? 'default'
  const prof = (profiles[profileName] ?? {}) as Record<string, unknown>
  const storeBlock = ((prof.store ?? {}) as Record<string, unknown>)

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
    config: { backend: rawBackend as BackendName, path: finalPath, readOnlyRetryMs, batchSize },
    configPath,
    configExists,
  }
}
