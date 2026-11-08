// src/commands/store.ts
import { lstatSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { resolveStoreConfig, currentStoreEnv } from '../store/config.js'
import { openStore } from '../store/index.js'
import {
  ok, fail, usageFail, failFromTagged, sanitizeControlChars, setPretty,
  storeInitCommand, syncRunCommand, describeArgs,
} from '../output.js'
import { classifyOpenFailure, openFailureHint } from '../store/retry.js'
import { DB_PATH_HELP, parseStoreFlags } from './store-flags.js'
import {
  SCHEMA_VERSION_COLUMNS_SQL, statGuard, schemaVersionMissing, nonRegularFileHint, undeclaredTables,
  storeTablesWarnings,
} from './store-precheck.js'
import { TABLES } from '../store/schema.js'
import { storeFieldNotes } from './store-notes.js'
import { GLOBAL_FLAGS, helpArgsError, prettyAfterSubcommand, prettyPositionalProblem, REJECTED_FLAGS, STORE_FLAGS, subcommandNames } from './spec-types.js'
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

⚠️ 存储配置仍需手工编辑 ~/.config/qiyu/config.json（store 命令本身不写配置；配置文件可能已
由 auth login 创建，但只含 credentials 键，不含 store 段）。也可用 --db / QIYU_DB_PATH 直接指定库路径。
${DB_PATH_HELP}
`

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
  // ⚠️ 打开失败的成因分流走 `store/retry.ts` 的 `classifyOpenFailure`（2026-10-31 单一实现点）：
  // 判据与 hint 口径必须与 `query/sandbox.ts` 的 `openSandbox`、`sync-run.ts` 的
  // `storeInitFail` 一致 —— 此前三处各写各的，
  // 同一个 `chmod 000` 的文件在 `store status` 与 `query` 上给出**互相矛盾**的 hint
  // （一个说「检查读写权限」、一个说「请确认文件存在且由本 CLI 创建，跑 store init」）。
  // 判据本身的形态要求（DuckDB 原生报文、strerror 在句尾、锚 `$` 不能子串搜）见那里的注释。
  const openFailure = classifyOpenFailure(e)
  if (openFailure !== null) {
    return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `无法打开 ${msg}`, hint: openFailureHint(openFailure) })
  }
  // ⚠️ internal 兜底（第四轮 I 组 H1/M8 修）：spec §8.2 禁止把 DuckDB 英文原文裸透
  // 给 Agent —— 必须中文包装 + 底层原文；hint 中性化（status 只读路径也会走到这里，
  // 不能说「写入」）。
  // ⚠️ hint 不得指向 `qiyu store status`（2026-11-07 审查）：本函数是 `store init` 与
  // `store status` **共用**的出口 —— 当失败的命令本身就是 `store status` 时，
  // 「请用 store status 检查数据库状态」是在让 Agent 重跑刚失败的同一条命令（死循环）。
  // 换成两个子命令都成立的诊断动作：换一个 --db 验证库本身是否有问题。
  // ⚠️ 恢复命令必须经渲染器带出（store-hint-selection 的 BARE_HINT 守卫）：
  // 重建目标是一个**尚不存在的新路径**，渲染器只接路径 —— 用全仓统一的占位符 `<新路径>`
  // 传入，替换契约（换成真实 .duckdb 路径、不要指回原文件）随 hint 一并写明。
  return fail({ code: 'internal', kind: 'internal', retryable: false,
    message: `存储操作失败（底层：${msg}）`, hint: '数据库执行期错误（重跑同一条命令不会改变结果）。'
      + '请先用 --db 指向另一个库验证是否是该库的问题；若只有该库失败，请先备份该文件，再用 '
      + storeInitCommand('<新路径>') + ' 重建（把 <新路径> 整段替换成新的 .duckdb 文件路径，'
      + '不要指回出问题的文件 —— 本地库只是缓存），之后带同一个 --db 跑 '
      + syncRunCommand('<新路径>') + ' 可重新拉取' })
}

export async function storeCommand(argv: string[]): Promise<number> {
  setPretty(false) // G1：每条命令入口重置输出格式 —— 同一进程内多次 run（测试）不残留上一条命令的开关。
  const [sub, ...rest] = argv
  // ⚠️ 无子命令 = 用法错误（退 2 + stdout JSON），**不是**裸文本帮助（2026-11-07 审查）：
  // 此前它和 `--help` 共用一个分支，把 USAGE 写进 stdout 并退 0 —— 而顶层 `run()`、
  // `api` / `auth` / `query` / `skill` 五个命令族对同一形态都给 usageFail（退 2 + JSON）。
  // `cli.ts` 的 USAGE 还明写「`--help` 是**唯一**以裸文本输出的情形」，README 则承诺
  // 「Agent 靠退出码和 stdout 的 JSON 做决定」—— 裸文本让 `qiyu store | jq` 直接 parse error。
  // 原始裁决见计划 2026-09-30 §无参数分支：「无参数是用法错误，不是『用户请求帮助』」。
  if (sub === undefined) {
    return usageFail(`用法：qiyu store <init|status> [参数]（\`qiyu store --help\` 查看全部）`,
      '可用子命令：init、status')
  }
  if (sub === '--help' || sub === '-h') {
    // --help 不吞**未知**参数；已知 flag 与子命令名/取值一律放行（2026-11-06 审查：
    // `store status --db /tmp/x --help` 此前被 `GLOBAL_FLAG_NAMES` 判成「未知参数」退 2）。
    const problem = helpArgsError(rest, STORE_SPECS.flatMap((sp) => sp.flags), '。--help 不接受额外参数')
    if (problem !== undefined) return usageFail(problem)
    process.stdout.write(USAGE)
    return 0
  }
  if (sub !== 'init' && sub !== 'status') {
    // store 级：--pretty 是合法**输出开关**，但它必须写在具体子命令之后（`store init --pretty`）。
    // 写在这里时没有任何子命令可修饰 —— 给出正确写法，而不是说成"未知子命令"（B 惯例）。
    if (sub === '--pretty') {
      const problem = helpArgsError(rest, STORE_SPECS.flatMap((sp) => sp.flags))
      if (problem !== undefined) return usageFail(`${problem}。--pretty 不接受额外参数`)
      const badPos = prettyPositionalProblem(rest, subcommandNames(STORE_SPECS))
      if (badPos !== undefined) return usageFail(badPos)
      if (rest.includes('--help') || rest.includes('-h')) {
        process.stdout.write(USAGE)
        return 0
      }
      // ⚠️ 位置参数一律按「顺序写反」引导（2026-11-07 审查）—— 见 db.ts 同款注释。
      return usageFail(prettyAfterSubcommand('store'))
    }
    return usageFail(`未知子命令：${sub}\n可用子命令：init、status`)
  }
  // 子命令级：**先 parseStoreFlags**（消费带值 flag 的值位置），再判未知参数（spec §7.3/验收 46）。
  // ⚠️ 次序不能反：若先过滤「未知 token」再 parseStoreFlags，`store init --db <path>` 的
  // --db 及其值会被当未知参数误拒（v1 计划的实测缺陷，D/F 组独立发现）。
  if (rest.includes('--help') || rest.includes('-h')) {
    const problem = helpArgsError(rest, STORE_SPECS.flatMap((sp) => sp.flags))
    if (problem !== undefined) return usageFail(problem)
    process.stdout.write(USAGE)
    return 0
  }
  // G1：--pretty 已实现 —— 命令行合法即开启缩进输出（原拒绝点）。
  if (rest.includes('--pretty')) setPretty(true)

  let flags
  try { flags = parseStoreFlags(rest) } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }
  // parseStoreFlags 之后剩下的 rest 才是真正的未知参数（带值 flag 的值位已被消费）
  if (flags.rest.length > 0) return usageFail(`未知参数：${describeArgs(flags.rest)}`)

  let resolved
  try {
    resolved = resolveStoreConfig({ flags: { db: flags.db, profile: flags.profile, backend: flags.backend },
      env: currentStoreEnv() })
    // ⚠️ failFromTagged（不是 usageFail）：配置层会抛带 `kind: config_insecure` 的错误
    // （含凭证且权限过宽 —— 退出码 1、只能由人 chmod）。包成 usageFail 会把它降级成
    // 「改参数重来」退出码 2 并丢掉 hint，与 auth/api 那条路径的说法相反。
  } catch (e) { return failFromTagged(e) }

  const { config, configPath, configExists, profileFlag } = resolved

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
      // ⚠️ 两处「非普通文件」文案走 `store-precheck.ts` 的 `nonRegularFileHint`（2026-10-31
      // 单一实现点）——此前 init/status 与 db/sync 各写各的，`!isFile()` 这个判据
      // 覆盖了目录 / FIFO / 设备 / 套接字 四种成因，而 status 只按「目录」写死文案，
      // 对 FIFO 说出「你传了个目录」（假话）。init 的结构不并入共享实现（它的
      // lstat/符号链接拒绝/建父目录是写路径特有），但这段文案与 status/db/sync 同源。
      return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `不是普通文件：${config.path}`, hint: nonRegularFileHint(true) })
    }
    if (st !== undefined && st.isFile() === false && st.isSymbolicLink() === false && st.isDirectory() === false) {
      // 其它特殊文件（设备/套接字等）同样拒绝
      return fail({ code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `不是普通文件：${config.path}`, hint: nonRegularFileHint(false) })
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
      // ⚠️ 与 `store status` 同口径（2026-11-01）：`store.tables()` 给的是**全库**清单
      // （含未声明表），两个命令若一个全给、一个只给声明表，README 承诺的
      // 「两边数量应当一致」就成了假话。未声明的表名进 warnings，不静默丢弃。
      const all = await store.tables()
      const sv = await store.query('SELECT COALESCE(MAX(version),0) AS v FROM schema_version')
      const declared = new Set(TABLES.map((t) => t.name))
      const warnings = storeTablesWarnings(all, config.path, profileFlag)
      return ok({ path: config.path, backend: config.backend, config_path: configPath,
        config_exists: configExists,
        schema_version: Number(sv.rows[0]?.v ?? 0),
        tables: all.filter((n) => declared.has(n)) },
      warnings === undefined
        ? { field_notes: storeFieldNotes() }
        : { field_notes: storeFieldNotes(), warnings })
    } catch (e) { return thrownToExit(e) } finally { await store.close() }
  }

  // status
  // 库前置检查（ENOENT / 权限 / 非普通文件）走 `store-precheck.ts` 的 `statGuard`
  // ——**唯一实现点**（2026-10-31 收敛）。此前这里自己写了一份，与 db/sync 那两份
  // already 漂移出两种说法：本文件的权限 hint 写「status 是只读命令」、非普通文件写
  // 「指向的是目录」（对 FIFO/设备是假话）；db/sync 写「只读命令」「不是普通文件」。
  // ⚠️ 「不存在」成因的裁定保留在此（不进共享实现）：D 交付后本 hint **不改指**
  // `qiyu sync run`（设计稿 §9.5 的「D 交付后改指 sync run」不再采纳）——「初始化存储」
  // 的最小命令是 store init，且 sync status/verify 是只读命令，指它们跑一次写操作并非必要。
  // 同步侧（sync status/verify/install、sync run 的 storeInitFail）与 C1 同口径。
  const guarded = statGuard(config.path)
  if (guarded !== null) return guarded
  let store
  try { store = await openStore(config, 'ro') } catch (e) { return thrownToExit(e) }
  try {
    const names = await store.tables()
    // ⚠️ 成因分形（他人库不引导向 init）在共享实现里，口径与 db/sync 逐字一致。
    // ⚠️ 表名不是身份证明（2026-11-07 审查实测）：他人工具的 schema_version 无 version 列时，
    // 旧判据放行，下面的 MAX(version) 抛 Binder Error 落 internal「备份重建」—— 假归因。
    const versionColumns = names.includes('schema_version')
      ? (await store.query(SCHEMA_VERSION_COLUMNS_SQL)).rows.map((r) => String(r.column_name))
      : undefined
    const missing = schemaVersionMissing(config.path, names, versionColumns)
    if (missing !== null) return fail(missing)
    const tables: Array<{ name: string; rows: number }> = []
    // ⚠️ 只能对**声明表**（`TABLES`）做 COUNT（2026-11-01 实测修）：`store.count()` 内部
    // 走 `assertTable`，库里有未声明的表（旧版 CLI 或其它工具建的）时抛 `usage`
    // （`未知表：xxx`，退出码 2）—— 于是 `store status` 在**库恰好有漂移时整条命令失败**，
    // 连 `schema_version` 都拿不到，而 `db tables` 对同一状态只是把它列进 warnings
    //（README 与 `db tables` 都明确把「库中有而声明无」当作**要警告、不失败**的漂移）。
    // `names` 来自全库 `information_schema`（含未声明表），因此必须按声明集过滤后再 COUNT；
    // 未声明的表名进 warnings（不得静默 —— 与 `db tables` 同口径，README 承诺要报警）。
    const undeclared = new Set(undeclaredTables(names))
    for (const n of names) {
      if (undeclared.has(n)) continue
      tables.push({ name: n, rows: await store.count(n) })
    }
    const sv = await store.query('SELECT COALESCE(MAX(version),0) AS v FROM schema_version')
    // ⚠️ 两半漂移都进 warnings，**唯一渲染点**在 `storeTablesWarnings`（2026-11-02 实测修）：
    // 此前这里只算「库中有而声明无」，声明表被删时 tables 少了几张却零 warnings ——
    // 同一库上 `db tables` 会警告、`store status` 报 ok 且干净，README 又教 Agent
    // 「数量不等时先读 warnings」，于是 Agent 读到空 warnings 反而确认了「没事」。
    const warnings = storeTablesWarnings(names, config.path, profileFlag)
    return ok({ path: config.path, backend: config.backend, config_path: configPath,
      config_exists: configExists,
      schema_version: Number(sv.rows[0]?.v ?? 0), tables },
    warnings === undefined
      ? { field_notes: storeFieldNotes() }
      : { field_notes: storeFieldNotes(), warnings })
  } catch (e) { return thrownToExit(e) } finally { await store.close() }
}
