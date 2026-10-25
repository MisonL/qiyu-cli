// src/commands/store.ts
import { statSync, lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveStoreConfig, currentStoreEnv } from '../store/config.js'
import { openStore } from '../store/index.js'
import { ok, fail, usageFail, sanitizeControlChars, setPretty } from '../output.js'
import { parseStoreFlags } from './store-flags.js'
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES, prettyAfterSubcommand, REJECTED_FLAGS, STORE_FLAGS } from './spec-types.js'
import type { CommandSpec } from './spec-types.js'

/**
 * 命令契约（F 组 D4）：`skill check` 据此判断 skill 正文里的 `qiyu store …` 是否真的存在。
 * `flags` 是**完整接受集**（含全局 flag），`--pretty` 同时在 `rejected` 里。
 */
export const STORE_SPECS: CommandSpec[] = [
  {
    path: ['store', 'init'],
    flags: [...GLOBAL_FLAGS, ...STORE_FLAGS],
    positionals: [],
    rejected: REJECTED_FLAGS,
  },
  {
    path: ['store', 'status'],
    flags: [...GLOBAL_FLAGS, ...STORE_FLAGS],
    positionals: [],
    rejected: REJECTED_FLAGS,
  },
]

const USAGE = `用法：qiyu store <子命令> [参数]

子命令：
  store init [--db <path>] [--profile <name>] [--backend <name>]
                           初始化本地数据库（DuckDB）
  store status [--db <path>] [--profile <name>] [--backend <name>]
                           查看数据库状态与各表行数

⚠️ 存储配置需手工编辑 ~/.config/qiyu/config.json（CLI 不会自动创建）。
   也可用 --db / QIYU_DB_PATH 直接指定库路径。
`

const KNOWN = new Set(GLOBAL_FLAG_NAMES)

export function thrownToExit(e: unknown): number {
  const err = e as { kind?: string; message?: string; hint?: string; retryable?: boolean }
  // usage 类错误（store 层预检抛出，如未知列/缺列/连接已关闭）：归 usageFail 双通道、
  // 退出码 2 —— 这是用法错误不是环境故障（M1 修：此前被下方排除条件挡住后落 internal）。
  if (err.kind === 'usage') {
    return usageFail(err.message ?? String(e), err.hint)
  }
  if (err.kind) {
    return fail({ code: err.kind, kind: err.kind, retryable: err.retryable ?? false,
      message: err.message ?? String(e), hint: err.hint })
  }
  // ⚠️ 无 kind 的错误分两类（spec §8.2 验收 41/54）：
  // ① DuckDB 拒绝打开非 DuckDB 文件 / 执行期错误 → 环境/数据问题，退出码 1、internal；
  // ② 其余 → 用法错误，退出码 2（usageFail 双通道）。
  const msg = err.message ?? String(e)
  if (/not a valid DuckDB database/i.test(msg)) {
    return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `无法打开 ${msg}`, hint: '该路径已存在且不是 DuckDB 数据库，请换 --db 路径' })
  }
  // ⚠️ open/执行期 errno 分流（R 组 R6）：EACCES/EPERM/EROFS 是环境问题不是程序错误，
  // 归因必须准（K 组 M3 只做了 lstat/statSync 层，这里补 open 期）。
  if (/^(EACCES|EPERM|EROFS)/.test(msg)) {
    return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `无法打开 ${msg}`, hint: '请检查路径写权限（磁盘只读或目录无写权限都会导致无法打开）' })
  }
  // ⚠️ internal 兜底（第四轮 I 组 H1/M8 修）：spec §8.2 禁止把 DuckDB 英文原文裸透
  // 给 Agent —— 必须中文包装 + 底层原文；hint 中性化（status 只读路径也会走到这里，
  // 不能说「写入」）。
  return fail({ code: 'internal', kind: 'internal', retryable: false,
    message: `存储操作失败（底层：${msg}）`, hint: '数据库执行期错误。若持续出现，请用 qiyu store status 检查数据库状态，或用 --db 指向其他数据库文件' })
}

export async function storeCommand(argv: string[]): Promise<number> {
  setPretty(false) // G1：每条命令入口重置输出格式 —— 同一进程内多次 run（测试）不残留上一条命令的开关。
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h') {
    // --help 不吞额外参数；--pretty 豁免（B 惯例）
    const extra = rest.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
    process.stdout.write(USAGE)
    return 0
  }
  if (sub !== 'init' && sub !== 'status') {
    // store 级：--pretty 是合法**输出开关**，但它必须写在具体子命令之后（`store init --pretty`）。
    // 写在这里时没有任何子命令可修饰 —— 给出正确写法，而不是说成"未知子命令"（B 惯例）。
    if (sub === '--pretty') {
      const unknown = rest.filter((a) => a.startsWith('-') && !KNOWN.has(a))
      const positional = rest.filter((a) => !a.startsWith('-'))
      if (unknown.length + positional.length > 0) {
        return usageFail(`未知参数：${[...unknown, ...positional].join(' ')}。--pretty 不接受额外参数`)
      }
      if (rest.includes('--help') || rest.includes('-h')) {
        process.stdout.write(USAGE)
        return 0
      }
      return usageFail(prettyAfterSubcommand('store'))
    }
    return usageFail(`未知子命令：${sub}\n可用子命令：init、status`)
  }
  // 子命令级：**先 parseStoreFlags**（消费带值 flag 的值位置），再判未知参数（spec §7.3/验收 46）。
  // ⚠️ 次序不能反：若先过滤「未知 token」再 parseStoreFlags，`store init --db <path>` 的
  // --db 及其值会被当未知参数误拒（v1 计划的实测缺陷，D/F 组独立发现）。
  if (rest.includes('--help') || rest.includes('-h')) {
    const rawRest = rest.filter((a) => !KNOWN.has(a))
    if (rawRest.length > 0) return usageFail(`未知参数：${rawRest.join(' ')}`)
    process.stdout.write(USAGE)
    return 0
  }
  // G1：--pretty 已实现 —— 命令行合法即开启缩进输出（原拒绝点）。
  if (rest.includes('--pretty')) setPretty(true)

  let flags
  try { flags = parseStoreFlags(rest) } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }
  // parseStoreFlags 之后剩下的 rest 才是真正的未知参数（带值 flag 的值位已被消费）
  if (flags.rest.length > 0) return usageFail(`未知参数：${flags.rest.join(' ')}`)

  let resolved
  try {
    resolved = resolveStoreConfig({ flags: { db: flags.db, profile: flags.profile, backend: flags.backend },
      env: currentStoreEnv() })
  } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }

  const { config, configPath, configExists } = resolved

  if (sub === 'init') {
    // 文件前置检查（spec §7.1 步骤 2；验收 41）
    // ⚠️ lstat 异常按 errno 分流（K 组 M3）：只有 ENOENT 才是「不存在 → DuckDB 会创建」；
    // EACCES/ELOOP/ENAMETOOLONG 等是**可访问性问题**，直接归因给 Agent——否则 DuckDB
    // 的英文底层错误经 internal 兜底透出，Agent 拿不到「检查权限」这个可操作归因。
    let st: ReturnType<typeof lstatSync> | undefined
    try { st = lstatSync(config.path) } catch (e) {
      const code = (e as { code?: string }).code
      // ⚠️ ENOTDIR 与 ENOENT 同样放行（测试为权威的偏离声明：brief 原文只放行 ENOENT，
      // 但 `--db blocker/sub/q.db`（blocker 是普通文件）lstat 抛 ENOTDIR，会被这里的
      // 「无法访问」拦截，永远到不了「无法创建父目录」分支 —— 父路径是普通文件正是
      // 验收 41 的注入场景）。两者都交给下方 mkdirSync 真正失败时归因。
      if (code !== 'ENOENT' && code !== 'ENOTDIR') {
        return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
          message: `无法访问 ${config.path}：${e instanceof Error ? e.message : String(e)}`,
          hint: '请检查路径权限（父目录无执行权限/链接循环/路径过长都会导致无法访问）' })
      }
    }
    if (st !== undefined && st.isFile() === false && st.isDirectory() === true) {
      return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `不是普通文件：${config.path}`, hint: '--db 指向的不是普通文件，请改成一个数据库文件路径' })
    }
    if (st !== undefined && st.isFile() === false && st.isSymbolicLink() === false && st.isDirectory() === false) {
      // 其它特殊文件（设备/套接字等）同样拒绝
      return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `不是普通文件：${config.path}`, hint: '--db 指向的不是普通文件，请改成一个数据库文件路径' })
    }
    if (st !== undefined && st.isSymbolicLink() === true) {
      return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `目标是符号链接：${config.path}`, hint: '--db 目标是符号链接，请给出真实路径' })
    }
    // 父目录不存在 → mkdirSync(recursive)；失败 → 退出码 1、message 含路径与底层原因
    const parent = dirname(config.path)
    try { mkdirSync(parent, { recursive: true }) } catch (e) {
      // ⚠️ message 同时含父目录与目标库完整路径（测试为权威的偏离声明：brief 原文
      // 只含 parent，但验收 41 断言 message 含完整 --db 路径 —— Agent 拿到错误要能
      // 对回自己传的参数）。
      return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `无法创建父目录 ${parent}（目标文件 ${config.path}）：${e instanceof Error ? e.message : String(e)}`,
        hint: '请检查父目录权限，或用 --db 换一个可写的路径' })
    }
    // ⚠️ 魔数在偏移 8（前 8 字节是块校验和）——不自写魔数检查，交给 DuckDB 打开时校验：
    // 非 DuckDB 文件打开即抛 "not a valid DuckDB database"，由 thrownToExit 映射。
    let store
    try {
      store = await openStore(config, 'rw')
    } catch (e) { return thrownToExit(e) }
    try {
      await store.init()
      const tables = await store.tables()
      const sv = await store.query('SELECT COALESCE(MAX(version),0) AS v FROM schema_version')
      return ok({ path: config.path, backend: config.backend, config_path: configPath,
        config_exists: configExists,
        schema_version: Number(sv.rows[0]?.v ?? 0),
        tables })
    } catch (e) { return thrownToExit(e) } finally { await store.close() }
  }

  // status
  // ⚠️ statSync 异常按 errno 分流（K 组 M6）：EACCES 误报「请先运行 init」会把
  // 只读路径的权限错误引导向写操作（init），Agent 必然再失败一次 —— 归因必须准。
  let st: ReturnType<typeof statSync>
  try { st = statSync(config.path) } catch (e) {
    const code = (e as { code?: string }).code
    if (code === 'ENOENT') {
      return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库文件不存在：${config.path}`, hint: '数据库尚未初始化。请先运行：qiyu store init' })
      // ⚠️ 修复批 2 裁定：D 交付后本 hint **不改指** `qiyu sync run`（设计稿 §9.5 的
      // 「D 交付后改指 sync run」不再采纳）——「初始化存储」的最小命令是 store init，
      // 且 sync status/verify 是只读命令，指它们跑一次写操作并非必要。
      // 同步侧（sync status/verify/install、sync run 的 storeInitFail）与 C1 同口径。
    }
    return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `无法访问 ${config.path}：${e instanceof Error ? e.message : String(e)}`,
      hint: '请检查路径权限（status 是只读命令，不需要写权限）' })
  }
  if (!st.isFile()) {
    // ⚠️ P 组 P-H2：目录成因**不能**引导向 store init（init 也拒绝目录 → 死循环）——
    // 独立 hint，与「不存在」成因分形。
    return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `不是普通文件：${config.path}`,
      hint: '--db 指向的是目录而非数据库文件，请给出 .duckdb 数据库文件路径' })
  }
  let store
  try { store = await openStore(config, 'ro') } catch (e) { return thrownToExit(e) }
  try {
    const names = await store.tables()
    if (!names.includes('schema_version')) {
      return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库结构不完整（缺表）：${config.path}`,
        hint: names.length > 0 ? '目标数据库不是本 CLI 创建的，请换 --db 路径' : '请运行：qiyu store init' })
    }
    const tables: Array<{ name: string; rows: number }> = []
    for (const n of names) tables.push({ name: n, rows: await store.count(n) })
    const sv = await store.query('SELECT COALESCE(MAX(version),0) AS v FROM schema_version')
    return ok({ path: config.path, backend: config.backend, config_path: configPath,
      config_exists: configExists,
      schema_version: Number(sv.rows[0]?.v ?? 0), tables })
  } catch (e) { return thrownToExit(e) } finally { await store.close() }
}
