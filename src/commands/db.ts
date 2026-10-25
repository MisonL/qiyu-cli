// src/commands/db.ts —— E 组查询命令骨架；Task 6：`db tables`（spec §8.1），
// Task 7：`db describe`（spec §8.2）。
//
// 形态沿 store.ts / sync.ts：parseStoreFlags（值位守卫）→ usageFail/fail 双通道 →
// 查询层统一错误出口 thrownToQueryExit。
//
// 三条硬约束：
//   · 所有查询走 `query/sandbox.ts` 的三层只读沙箱（spec §5.1）——本文件不直接
//     触碰 DuckDB 驱动（驱动包名字面量禁止出现在 src/commands/，layering 红线）；
//   · `db tables` 的清单以 `TABLES` 为权威（spec §8.1）：声明有而库中无的表**不出现**
//     在 `data.tables`（`rows` 恒为真实 COUNT，不编造），与「库中有而声明无」一样
//     只进 `meta.warnings`（controller 裁决 R4）；
//   · `time_range` 的 min/max **所有 kind** 都经 `msToShanghaiIso` 输出 `+08:00`
//     形态（裁决 R1）：iso-day/iso-instant 的 MIN/MAX 是 ISO 字符串，epoch-ms 是
//     数字字符串（BIGINT 经 JSON 层），三者统一为同一形态。
//   · `db describe` 的列清单同样以 `TABLES` 为权威；声明有而库中无的表**仍输出声明
//     元数据**（`row_count`/`time_range` 为 null + warning，裁决 R5）——Agent 需要知道
//     该表应该有什么列，才能判断是没同步还是没建库。
import { statSync } from 'node:fs'
import { resolveStoreConfig, currentStoreEnv } from '../store/config.js'
import { openSandbox } from '../query/sandbox.js'
import type { SandboxSession } from '../query/sandbox.js'
import { timeShapeClauses } from '../query/time-shape.js'
import { suggestNames, thrownToQueryExit } from '../query/errors.js'
import { TABLES, tableByName } from '../store/schema.js'
import type { ColumnDef, TableDef, TimeColumnKind } from '../store/schema.js'
import type { StoreConfig } from '../store/types.js'
import { msToShanghaiIso, MAX_SHANGHAI_SAFE_MS } from '../core/time.js'
import { ok, fail, usageFail, sanitizeControlChars, describeArgs, setPretty } from '../output.js'
import { parseStoreFlags } from './store-flags.js'
import type { StoreFlags } from './store-flags.js'
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES, prettyAfterSubcommand, REJECTED_FLAGS, STORE_FLAGS } from './spec-types.js'
import type { CommandSpec } from './spec-types.js'

/**
 * 命令契约（F 组 D4）：`skill check` 据此判断 skill 正文里的 `qiyu db …` 是否真的存在。
 * `flags` 是**完整接受集**（含全局 flag），`--pretty` 同时在 `rejected` 里。
 * 值位解析走共享的 `parseStoreFlags`（它从 `STORE_FLAGS` 派生接受集），与这里同源。
 */
export const DB_SPECS: CommandSpec[] = [
  {
    path: ['db', 'tables'],
    flags: [...GLOBAL_FLAGS, ...STORE_FLAGS],
    positionals: [],
    rejected: REJECTED_FLAGS,
  },
  {
    path: ['db', 'describe'],
    flags: [...GLOBAL_FLAGS, ...STORE_FLAGS],
    positionals: [{ name: '表', domain: 'tables' }],
    rejected: REJECTED_FLAGS,
  },
]

const USAGE = `用法：qiyu db <子命令> [参数]

子命令：
  db tables [--db <path>] [--profile <name>] [--backend <name>]
                           列出库中全部表：行数、粒度、时间范围、PII 列
  db describe <表> [--db <path>] [--profile <name>] [--backend <name>]
                           查看单表列定义

存储定位：--db / --profile / --backend（store 命令同族）。
`

const KNOWN = new Set(GLOBAL_FLAG_NAMES)

/** PII 提示（设计稿 §6.5 要求 `db tables` / `db describe` 必须携带）。 */
const PII_NOTICE = '本数据库包含客户 PII；不要将其写入日志或对外报表'

/**
 * 只读命令的库前置检查（ENOENT / 非普通文件 / 权限三分 → 退出码，否则 null）。
 * ⚠️ 与 sync.ts 的私有 statGuard 同款，但**独立落点**：brief 指定 E 族单一落点
 * （本函数由 db.ts 导出给 query/stats 复用，避免三份拷贝漂移；不为它抽独立模块，
 * 两处足够小，YAGNI）。
 * hint 统一指 `qiyu store init`（spec §九）。
 */
export function statGuard(path: string): number | null {
  let st: ReturnType<typeof statSync>
  try { st = statSync(path) } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库文件不存在：${path}`,
        hint: '数据库尚未初始化。请先运行：qiyu store init',
      })
    }
    return fail({
      code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `无法访问 ${path}：${e instanceof Error ? e.message : String(e)}`,
      hint: '请检查路径权限（只读命令不需要写权限）',
    })
  }
  if (!st.isFile()) {
    return fail({
      code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `不是普通文件：${path}`,
      hint: '--db 指向的不是普通文件，请给出 .duckdb 数据库文件路径',
    })
  }
  return null
}

/** 表的 PII 列名（`sensitive: true`，保持声明顺序）——`TABLES` 是唯一权威。 */
function piiColumnsOf(t: TableDef): string[] {
  return t.columns.filter((c) => c.sensitive === true).map((c) => c.name)
}

/**
 * 时间列的**约定形态**（可注入 SQL 片段，`timeRangeOf` 与 `dirtyTimeValues` 共用同一份
 * ——两处口径一旦分叉，就会出现「算极值时排除、计数时不排除」这种自相矛盾的状态）。
 *
 * 实现与 `query/table-query.ts` 共用 `query/time-shape.ts` 的同一函数 —— 口径由构造保证，
 * 不再靠「逐字一致」的注释与字符串相等测试（同一条 README 承诺：「脏值不进 time_range」；
 * 两处分叉的话，同一条脏库会在 `db tables` 被排除、在 `query --table` 被当成覆盖范围）。
 * 具体判据与实测约束（F3/F5/gap 2）见该模块头注释。
 *
 * 两端都锚定（CodeRabbit 终审 minor）：只锚开头会放过 `'2026-10-12garbage'`（它字典序上
 * `g` > `T`，反而赢下 MAX）与只有日期的 `'2026-10-13'`（`msToShanghaiIso` 按 UTC 解析，
 * 输出偏 8 小时）。形态与写路径逐字对应：
 *   · iso-day：`shanghaiDayIso` → `YYYY-MM-DDT16:00:00.000Z`（上海日零点的 UTC 形态）；
 *   · iso-instant：`new Date(ms).toISOString()` → `YYYY-MM-DDTHH:MM:SS.mmmZ`。
 * 兼容旧值：允许省略毫秒（`.000` 之外的零毫秒形态在库里也存在）。
 */
function shapeSqlOf(kind: TimeColumnKind, col: string): string[] {
  return timeShapeClauses(kind, col)
}

/**
 * 单表时间范围（spec §8.1 / §四）。
 * iso-day / iso-instant：列是 ISO 字符串 → 先按约定形态过滤（见下）再 MIN/MAX；
 * epoch-ms：列是数字字符串 → 先 TRY_CAST 成 BIGINT 再取极值（非数字值不炸、按 NULL 跳过）。
 * 空表（或全 NULL）→ null；非空则两端都过 `msToShanghaiIso`（裁决 R1）。
 *
 * ⚠️ ISO 形态过滤（正确性 P1）：脏值（`not-a-date`）会在 VARCHAR 上**赢下** MIN/MAX
 * （字典序上 `n` > `2`），而 `msToShanghaiIso` 对解析不了的值原样回显 —— 于是
 * `time_range.max` 输出一个根本不是时间的字符串。契约要求它是上海 ISO，所以先按
 * 约定形态筛（见 `shapeSqlOf`），脏值不进极值；数量由 `dirtyTimeValues` 单独查，
 * 由调用方进 warnings（不得静默 —— 库漂移/坏数据是 README 承诺要报警的状态）。
 */
async function timeRangeOf(
  session: SandboxSession, t: TableDef,
): Promise<{ min: string; max: string } | null> {
  const tc = t.timeColumn
  if (tc === undefined) return null
  const col = `"${tc.name}"`
  // 形态判据只用于 MIN/MAX 的候选集，不改变列本身的语义（值仍是原样输出的）。
  // ⚠️ 用 `regexp_matches`，**不要**用 `~` 运算符：实测（DuckDB 1.5.6-r.1）`~` 对
  // `'2026-10-13T…' ~ '^2026'` 也返回 false —— 它不是正则匹配，会把所有行都滤掉。
  const shape = shapeSqlOf(tc.kind, col)
  // ⚠️ **三种形态一律按解析后的时刻取极值**（正确性审查 F1/F2）：iso-day 的无毫秒形态
  // `…T16:00:00Z` 在字典序上大于同刻的 `…T16:00:00.000Z`，iso-instant 的 `+08:00` 写法
  // 与 `Z` 写法字典序与时间序相反 —— `MIN/MAX(原始串)` 都会取错那一端。
  // `arg_min/arg_max(col, 时刻)` 按时刻排序、**返回原始字符串**（`msToShanghaiIso` 能
  // 解析全部写法）。epoch-ms 用 BIGINT 极值。
  const agg = tc.kind === 'epoch-ms'
    ? `MIN(TRY_CAST(${col} AS BIGINT)) AS mn, MAX(TRY_CAST(${col} AS BIGINT)) AS mx`
    : `arg_min(${col}, TRY_CAST(${col} AS TIMESTAMPTZ)) AS mn, `
      + `arg_max(${col}, TRY_CAST(${col} AS TIMESTAMPTZ)) AS mx`
  const where = ` WHERE ${shape.join(' AND ')}`
  const r = await session.run(`SELECT ${agg} FROM "${t.name}"${where}`)
  const row = r.rows[0] ?? {}
  if (row.mn === null || row.mn === undefined || row.mx === null || row.mx === undefined) return null
  return {
    min: msToShanghaiIso(row.mn as string | number),
    max: msToShanghaiIso(row.mx as string | number),
  }
}

/**
 * 时间列里不符合约定形态的非空值计数（正确性 P1）。
 * epoch-ms 用 `TRY_CAST` 判（非数字即脏）；iso 两形态用与 `timeRangeOf` 同一份形态。
 * 0 = 干净，不产生任何警告。
 */
async function dirtyTimeValues(
  session: SandboxSession, t: TableDef,
): Promise<number> {
  const tc = t.timeColumn
  if (tc === undefined) return 0
  const col = `"${tc.name}"`
  const shape = shapeSqlOf(tc.kind, col)
  // 脏值 = 非空且不满足全部形态条件。
  // ⚠️ 必须 COALESCE（CodeRabbit 复审 minor，实测）：epoch-ms 的非数字值让 `TRY_CAST`
  // 为 NULL，`NOT (NULL AND NULL)` 仍是 NULL → WHERE 把该行静默丢掉，脏值计数为 0、
  // 警告也不出现。COALESCE(…, false) 把「无法判定」归为「不符合」。
  const bad = `NOT COALESCE((${shape.join(' AND ')}), false)`
  const r = await session.run(
    `SELECT COUNT(*) AS n FROM "${t.name}" WHERE ${col} IS NOT NULL AND ${bad}`)
  return Number((r.rows[0] ?? {}).n)
}

/** 脏时间值的公共警告文案（tables 与 describe 同一句话）。 */
function dirtyTimeWarning(table: string, column: string, n: number): string {
  return `表 ${table} 的时间列 ${column} 有 ${n} 个值不符合约定形态（已从 time_range 中排除）`
    + '——可能来自旧版 CLI、外部工具或库损坏；用 `qiyu query --sql` 单独查看它们以确认成因'
}

/**
 * 打开「已通过前置检查」的只读沙箱会话（**E 族三个命令共用**）：
 * resolveStoreConfig → statGuard → openSandbox → `schema_version` 探测。
 *
 * 返回 `{ exit }` 表示前置检查已产出退出码（调用方直接返回它，不做任何清理）；
 * 返回 `{ session }` 时**所有权归调用方**，必须 `finally session.close()`。
 * ⚠️ `schema_version` 探测的失败/缺表分支在这里就把会话关掉——调用方拿不到
 * session，不能指望它的 finally。
 *
 * ⚠️ 落点就在本文件、由 db 导出给 query/stats（与 `statGuard` 同一放宽口径）：
 * 这三条命令的「库结构校验」必须逐字一致——探测口径（`table_schema='main'`）、
 * 文案与 hint 任何一处漂移都会让 Agent 在不同命令上得到互相矛盾的解释。
 * 此前 query/stats 各自内联了一份拷贝，已合并到此处（架构审查 Important #2）。
 */
export async function openGuardedSession(
  flags: StoreFlags,
): Promise<{ session: SandboxSession; dbPath: string } | { exit: number }> {
  let config: StoreConfig
  try {
    config = resolveStoreConfig({
      flags: { db: flags.db, profile: flags.profile, backend: flags.backend },
      env: currentStoreEnv(),
    }).config
  } catch (e) { return { exit: usageFail(sanitizeControlChars((e as Error).message)) } }

  const guarded = statGuard(config.path)
  if (guarded !== null) return { exit: guarded }

  let session: SandboxSession
  try {
    session = await openSandbox(config)
  } catch (e) { return { exit: thrownToQueryExit(e, TABLES) } }

  try {
    // 库结构校验（spec §十一「库不存在/缺表 → store_not_initialized、退出码 1」）。
    // 口径与实际表集查询一致：限定 table_schema='main'（别库同名表不算数）。
    // ⚠️ 成因分形（sync.ts openRo / store.ts 同款）：「有表但无 schema_version」是**他人库**
    // —— store init 会再次拒绝（duckdb.ts init 的他人库防线），无条件引导过去就是
    // store init → db tables 死循环；「零表」才是「init 可补」的成因。
    const tables = await session.run(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='main'")
    const names = tables.rows.map((r) => String(r.table_name))
    if (!names.includes('schema_version')) {
      await session.close()
      return {
        exit: fail({
          code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
          message: `数据库结构不完整（缺表）：${config.path}`,
          hint: names.length > 0
            ? '目标数据库不是本 CLI 创建的，请换 --db 路径'
            : '空库（无任何表）。请先运行：qiyu store init',
        }),
      }
    }
  } catch (e) {
    await session.close()
    return { exit: thrownToQueryExit(e, TABLES) }
  }
  return { session, dbPath: config.path }
}

async function dbTables(argv: string[]): Promise<number> {
  // 子命令级次序沿 store.ts：--help 分流 → --pretty 开启缩进（G1） → parseStoreFlags → 未知参数。
  if (argv.includes('--help') || argv.includes('-h')) {
    const rawRest = argv.filter((a) => !KNOWN.has(a))
    if (rawRest.length > 0) return usageFail(`未知参数：${rawRest.join(' ')}`)
    process.stdout.write(USAGE)
    return 0
  }
  // G1：--pretty 已实现 —— 原拒绝点开启缩进输出（次序不变：help → 这里 → 值位解析）。
  if (argv.includes('--pretty')) setPretty(true)

  let flags: ReturnType<typeof parseStoreFlags>
  try { flags = parseStoreFlags(argv) } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }
  if (flags.rest.length > 0) return usageFail(`未知参数：${flags.rest.join(' ')}`)

  const opened = await openGuardedSession(flags)
  if ('exit' in opened) return opened.exit
  const session = opened.session

  try {
    // 实际表集 → 与声明比对（spec §8.1「声明与实况的差异不得静默」）。
    const actual = await session.run(
      "SELECT table_name FROM information_schema.tables WHERE table_schema='main'")
    const actualNames = actual.rows.map((r) => String(r.table_name))
    const actualSet = new Set(actualNames)
    const declaredSet = new Set(TABLES.map((t) => t.name))
    const warnings: string[] = []
    const declaredMissing = TABLES.map((t) => t.name).filter((n) => !actualSet.has(n))
    if (declaredMissing.length > 0) {
      // ⚠️ 不得承诺 store init 一定能修（审查 Important #1）：init 只重放
      // `version > MAX(version)` 的迁移，已迁移到最新版后被 DROP 的表**不会**被
      // 重建（迁移已跳过，返回 ok 而表仍缺）——那是「成功但无效」的修复。
      warnings.push(`声明有而库中无：${declaredMissing.join('、')}。`
        + '这些表不出现在 tables 中。若为建库未完成（迁移未跑完），运行 qiyu store init 可补建缺失的迁移；'
        + '若迁移已完成而表被删或损坏，store init 不会重建该表，重新同步也只会写入失败（缺表）'
        + '——需重建库（删除库文件后重新 qiyu store init 并重新同步）')
    }
    const undeclared = actualNames.filter((n) => !declaredSet.has(n)).sort()
    if (undeclared.length > 0) {
      warnings.push(`库中有而声明无：${undeclared.join('、')}。`
        + '这些表没有元数据声明（可能来自旧版 CLI 或其他工具），不出现在 tables 中')
    }

    // 实际列集一次查全库（25 次往返 → 1 次）：时间列被删的表不能让 timeRangeOf 的
    // `MIN("c")` 在 prepare 期抛 Binder Error 把整命令打成退出码 2（Task 7 审查
    // Important #1）——缺列降级为 time_range null + warning。
    const colRows = await session.run(
      "SELECT table_name, column_name FROM information_schema.columns WHERE table_schema='main'")
    const columnsOf = new Map<string, Set<string>>()
    for (const row of colRows.rows) {
      const tableName = String(row.table_name)
      const columnName = String(row.column_name)
      const set = columnsOf.get(tableName)
      if (set === undefined) columnsOf.set(tableName, new Set([columnName]))
      else set.add(columnName)
    }

    // 逐表：行数 + 时间范围；清单与顺序以 TABLES 为权威（裁决 R4：缺表的表整条跳过）。
    const tables: Array<{
      name: string
      rows: number
      grain: string
      time_range: { min: string; max: string } | null
      pii_columns: string[]
    }> = []
    for (const t of TABLES) {
      if (!actualSet.has(t.name)) continue
      const r = await session.run(`SELECT COUNT(*) AS n FROM "${t.name}"`)
      // ⚠️ COUNT 是 BIGINT，经 getRowObjectsJson() 是**字符串** —— 必须 Number() 收敛。
      const rows = Number((r.rows[0] ?? {}).n)
      let timeRange: { min: string; max: string } | null = null
      const tc = t.timeColumn
      // 逐表列核对（审查 I-3）：README 承诺「缺表/缺列/多列逐条进 warnings，不静默」，
      // 而 describe 才有的逐列核对在 tables 清单里缺失就是静默漂移。列集已在上面
      // 一次查全库（columnsOf），这里只做集合差，不加往返。
      const declaredCols = new Set(t.columns.map((c) => c.name))
      const actualCols = columnsOf.get(t.name) ?? new Set<string>()
      // 时间列缺了由下面那条专门警告说明（它还要解释 time_range 为何置 null），
      // 这里排除它，避免同一事实说两遍。
      const missingCols = [...declaredCols].filter((n) => !actualCols.has(n) && n !== t.timeColumn?.name)
      const extraCols = [...actualCols].filter((n) => !declaredCols.has(n)).sort()
      if (missingCols.length > 0 || extraCols.length > 0) {
        const parts: string[] = []
        if (extraCols.length > 0) parts.push(`多列 ${extraCols.join('、')}`)
        if (missingCols.length > 0) parts.push(`少列 ${missingCols.join('、')}`)
        warnings.push(`表 ${t.name} 实际${parts.join('、')}——可能来自旧版 CLI 或库损坏`)
      }
      if (tc !== undefined) {
        if (actualCols.has(tc.name)) {
          timeRange = await timeRangeOf(session, t)
          const dirty = await dirtyTimeValues(session, t)
          if (dirty > 0) warnings.push(dirtyTimeWarning(t.name, tc.name, dirty))
        } else {
          warnings.push(`表 ${t.name} 缺少时间列 ${tc.name}（可能来自旧版 CLI 或库损坏），time_range 置 null`)
        }
      }
      tables.push({
        name: t.name,
        rows,
        grain: t.grain,
        time_range: timeRange,
        pii_columns: piiColumnsOf(t),
      })
    }

    return ok({ tables }, { notice: PII_NOTICE, warnings })
  } catch (e) {
    return thrownToQueryExit(e, TABLES)
  } finally {
    await session.close()
  }
}

/** 单列的对外形态（spec §8.2）：恰好七个键，缺省字段显式 `null`（`sensitive` 缺省 false）。 */
function describeColumn(c: ColumnDef): {
  name: string; type: string; nullable: boolean; sensitive: boolean
  unit: string | null; observed_enum: Array<string | number> | null; note: string | null
} {
  return {
    name: c.name,
    type: c.type,
    nullable: c.nullable,
    sensitive: c.sensitive ?? false,
    unit: c.unit ?? null,
    observed_enum: c.observed_enum ?? null,
    note: c.note ?? null,
  }
}

async function dbDescribe(argv: string[]): Promise<number> {
  // 子命令级次序沿 dbTables：--help 分流 → --pretty 开启缩进（G1） → parseStoreFlags → 位置参数。
  if (argv.includes('--help') || argv.includes('-h')) {
    const rawRest = argv.filter((a) => !KNOWN.has(a))
    if (rawRest.length > 0) return usageFail(`未知参数：${rawRest.join(' ')}`)
    process.stdout.write(USAGE)
    return 0
  }
  // G1：--pretty 已实现 —— 原拒绝点开启缩进输出（次序不变：help → 这里 → 值位解析）。
  if (argv.includes('--pretty')) setPretty(true)

  let flags: ReturnType<typeof parseStoreFlags>
  try { flags = parseStoreFlags(argv) } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }

  // 未知 flag（`--bogus`）会落进 rest —— 先按 `-` 前缀挑出来，避免被当成表名。
  const flagish = flags.rest.filter((a) => a.startsWith('-'))
  if (flagish.length > 0) return usageFail(`未知参数：${flagish.join(' ')}`)
  if (flags.rest.length === 0) {
    return usageFail(`缺少表名：请给 db describe <表>\n可用表：${TABLES.map((t) => t.name).join('、')}`)
  }
  if (flags.rest.length > 1) return usageFail(`未知参数：${flags.rest.slice(1).join(' ')}`)

  // spec §8.2「未知 → usage + 候选」：闭集校验先于一切 I/O（不打开库就知道表名拼错）。
  // 候选来自 `TABLES`（前缀/编辑距离，大小写不敏感），不裸透 DuckDB 英文原文。
  const name = sanitizeControlChars(flags.rest[0])
  const table = tableByName(name)
  if (table === undefined) {
    const candidates = suggestNames(name, TABLES.map((t) => t.name))
    return usageFail(`未知表：${describeArgs([name])}`,
      candidates.length > 0 ? `候选：${candidates.join('、')}` : '用 `qiyu db tables` 查看可用表')
  }

  const opened = await openGuardedSession(flags)
  if ('exit' in opened) return opened.exit
  const session = opened.session

  try {
    // 表名来自 `TABLES` 闭集（代码内常量），拼进字面量安全；用户输入只用于上面的闭集查找。
    const present = (await session.run(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='main' AND table_name='${table.name}'`))
      .rows.length > 0

    const warnings: string[] = []
    let rowCount: number | null = null
    let timeRange: { min: string; max: string } | null = null

    if (!present) {
      // R5：声明有但库中无 → 仍输出声明元数据，不报错（Agent 靠列清单判断
      // 「没同步」还是「没建库」）。此时 row_count/time_range 无从得知，置 null。
      warnings.push(`表 ${table.name} 在库中不存在（未同步或未建库）；以下为声明元数据`)
    } else {
      const r = await session.run(`SELECT COUNT(*) AS n FROM "${table.name}"`)
      // ⚠️ COUNT 是 BIGINT，经 getRowObjectsJson() 是**字符串** —— 必须 Number() 收敛。
      rowCount = Number((r.rows[0] ?? {}).n)

      // 实际列集核对（spec §8.2「声明与实况的差异不得静默」）。
      // ⚠️ 必须**先于** timeRangeOf：声明的时间列若已被删，`MIN("c")` 会在 prepare 期
      // 抛 Binder Error 把整命令打成退出码 2，row_count/columns/pii_columns 全丢——
      // 而「时间列被删」只是「列集不一致」的子集，应降级为 warning + time_range null。
      const actual = (await session.run(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='main' AND table_name='${table.name}'`))
        .rows.map((row) => String(row.column_name))
      const actualSet = new Set(actual)
      const declaredSet = new Set(table.columns.map((c) => c.name))
      const missing = table.columns.map((c) => c.name).filter((n) => !actualSet.has(n))
      const extra = actual.filter((n) => !declaredSet.has(n)).sort()

      const tc = table.timeColumn
      if (tc !== undefined && actualSet.has(tc.name)) {
        timeRange = await timeRangeOf(session, table)
        const dirty = await dirtyTimeValues(session, table)
        if (dirty > 0) warnings.push(dirtyTimeWarning(table.name, tc.name, dirty))
      }
      // tc 缺失时 timeRange 保持 null；下面的「少列」warning 已点名该时间列。

      if (missing.length > 0 || extra.length > 0) {
        const parts: string[] = []
        if (extra.length > 0) parts.push(`多列 ${extra.join('、')}`)
        if (missing.length > 0) parts.push(`少列 ${missing.join('、')}`)
        warnings.push(`表 ${table.name} 实际${parts.join('、')}——可能来自旧版 CLI 或库损坏`)
      }
    }

    return ok({
      table: table.name,
      grain: table.grain,
      primary_key: table.primaryKey,
      // 无时间列 → null（不编造）；有则只出 name/kind 两个键。
      time_column: table.timeColumn === undefined
        ? null : { name: table.timeColumn.name, kind: table.timeColumn.kind },
      row_count: rowCount,
      time_range: timeRange,
      columns: table.columns.map(describeColumn),
      pii_columns: piiColumnsOf(table),
    }, { notice: PII_NOTICE, warnings })
  } catch (e) {
    return thrownToQueryExit(e, TABLES)
  } finally {
    await session.close()
  }
}

export async function dbCommand(argv: string[]): Promise<number> {
  setPretty(false) // G1：每条命令入口重置输出格式 —— 同一进程内多次 run（测试）不残留上一条命令的开关。
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h') {
    // --help 不吞额外参数；--pretty 豁免（store.ts 同族惯例）
    const extra = rest.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
    process.stdout.write(USAGE)
    return 0
  }
  // G1：--pretty 是输出开关，必须写在具体子命令之后（`db tables --pretty`）。
  if (sub === '--pretty') {
    const unknown = rest.filter((a) => a.startsWith('-') && !KNOWN.has(a))
    const positional = rest.filter((a) => !a.startsWith('-'))
    if (unknown.length + positional.length > 0)
      return usageFail(`未知参数：${[...unknown, ...positional].join(' ')}。--pretty 不接受额外参数`)
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(USAGE)
      return 0
    }
    return usageFail(prettyAfterSubcommand('db'))
  }
  if (sub !== 'tables' && sub !== 'describe') {
    return usageFail(`未知子命令：${sub}\n可用子命令：tables、describe`)
  }
  return sub === 'describe' ? dbDescribe(rest) : dbTables(rest)
}
