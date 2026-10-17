// src/commands/db.ts —— E 组查询命令骨架；Task 6：`db tables`（spec §8.1）。
//
// 形态沿 store.ts / sync.ts：parseFlags（值位守卫）→ usageFail/fail 双通道 →
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
import { statSync } from 'node:fs'
import { resolveStoreConfig } from '../store/config.js'
import { openSandbox } from '../query/sandbox.js'
import type { SandboxSession } from '../query/sandbox.js'
import { thrownToQueryExit } from '../query/errors.js'
import { TABLES } from '../store/schema.js'
import type { TableDef } from '../store/schema.js'
import { msToShanghaiIso } from '../core/time.js'
import { ok, fail, usageFail, sanitizeControlChars } from '../output.js'

const USAGE = `用法：qiyu db <子命令> [参数]

子命令：
  db tables [--db <path>] [--profile <name>] [--backend <name>]
                           列出库中全部表：行数、粒度、时间范围、PII 列
  db describe <表> [--db <path>] [--profile <name>] [--backend <name>]
                           查看单表列定义

存储定位：--db / --profile / --backend（store 命令同族）。
`

const KNOWN = new Set(['--help', '-h', '--pretty'])

/** PII 提示（设计稿 §6.5 要求 `db tables` / `db describe` 必须携带）。 */
const PII_NOTICE = '本数据库包含客户 PII；不要将其写入日志或对外报表'

interface StoreFlags { db?: string; profile?: string; backend?: string }

function parseFlags(argv: string[]): StoreFlags & { rest: string[] } {
  const out: StoreFlags & { rest: string[] } = { rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db' || a === '--profile' || a === '--backend') {
      const v = argv[i + 1]
      // 值位守卫（沿 store.ts）：值位缺失或以 -- 开头 → 报缺值，
      // 否则 `db tables --db --profile x` 会把 --profile 当路径。
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 缺少取值`)
      if (a === '--db') out.db = v
      else if (a === '--profile') out.profile = v
      else out.backend = v
      i++
    } else out.rest.push(a)
  }
  return out
}

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
 * 单表时间范围（spec §8.1 / §四）。
 * iso-day / iso-instant：列本身就是 ISO 字符串 → 直接 MIN/MAX；
 * epoch-ms：列是数字字符串 → 先 TRY_CAST 成 BIGINT 再取极值（非数字值不炸、按 NULL 跳过）。
 * 空表（或全 NULL）→ null；非空则两端都过 `msToShanghaiIso`（裁决 R1）。
 */
async function timeRangeOf(
  session: SandboxSession, t: TableDef,
): Promise<{ min: string; max: string } | null> {
  const tc = t.timeColumn
  if (tc === undefined) return null
  const agg = tc.kind === 'epoch-ms'
    ? `MIN(TRY_CAST("${tc.name}" AS BIGINT)) AS mn, MAX(TRY_CAST("${tc.name}" AS BIGINT)) AS mx`
    : `MIN("${tc.name}") AS mn, MAX("${tc.name}") AS mx`
  const r = await session.run(`SELECT ${agg} FROM "${t.name}"`)
  const row = r.rows[0] ?? {}
  if (row.mn === null || row.mn === undefined || row.mx === null || row.mx === undefined) return null
  return {
    min: msToShanghaiIso(row.mn as string | number),
    max: msToShanghaiIso(row.mx as string | number),
  }
}

async function dbTables(argv: string[]): Promise<number> {
  // 子命令级次序沿 store.ts：--help 分流 → --pretty 显式拒绝 → parseFlags → 未知参数。
  if (argv.includes('--help') || argv.includes('-h')) {
    const rawRest = argv.filter((a) => !KNOWN.has(a))
    if (rawRest.length > 0) return usageFail(`未知参数：${rawRest.join(' ')}`)
    process.stdout.write(USAGE)
    return 0
  }
  if (argv.includes('--pretty')) return usageFail('--pretty 尚未实现 —— 目前只输出紧凑 JSON')

  let flags: ReturnType<typeof parseFlags>
  try { flags = parseFlags(argv) } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }
  if (flags.rest.length > 0) return usageFail(`未知参数：${flags.rest.join(' ')}`)

  let config
  try {
    config = resolveStoreConfig({
      flags: { db: flags.db, profile: flags.profile, backend: flags.backend },
      env: {
        QIYU_DB_PATH: process.env.QIYU_DB_PATH,
        QIYU_STORE_BACKEND: process.env.QIYU_STORE_BACKEND,
        QIYU_PROFILE: process.env.QIYU_PROFILE,
      },
    }).config
  } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }

  const guarded = statGuard(config.path)
  if (guarded !== null) return guarded

  let session: SandboxSession
  try {
    session = await openSandbox(config)
  } catch (e) { return thrownToQueryExit(e, TABLES) }

  try {
    // 库结构校验（spec §十一「库不存在/缺表 → store_not_initialized、退出码 1」；
    // hint 沿 sync.ts openRo 形态：同时指「换 --db 路径」与「qiyu store init」）。
    // 口径与下方实际表集查询一致：限定 table_schema='main'（别库同名表不算数）。
    const sv = await session.run(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='main' AND table_name='schema_version'")
    if (sv.rows.length === 0) {
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库结构不完整（缺表）：${config.path}`,
        hint: '目标数据库不是本 CLI 创建的，请换 --db 路径，或先运行：qiyu store init',
      })
    }

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
        + '若迁移已完成而表被删或损坏，store init 不会重建该表——需重建库或重新同步')
    }
    const undeclared = actualNames.filter((n) => !declaredSet.has(n)).sort()
    if (undeclared.length > 0) {
      warnings.push(`库中有而声明无：${undeclared.join('、')}。`
        + '这些表没有元数据声明（可能来自旧版 CLI 或其他工具），不出现在 tables 中')
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
      tables.push({
        name: t.name,
        rows,
        grain: t.grain,
        time_range: await timeRangeOf(session, t),
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

export async function dbCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h') {
    // --help 不吞额外参数；--pretty 豁免（store.ts 同族惯例）
    const extra = rest.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
    process.stdout.write(USAGE)
    return 0
  }
  // `--pretty` 是合法 flag（承诺过未实现），不是「未知子命令」（store.ts 同族）。
  if (sub === '--pretty') return usageFail('--pretty 尚未实现 —— 目前只输出紧凑 JSON')
  if (sub !== 'tables' && sub !== 'describe') {
    return usageFail(`未知子命令：${sub}\n可用子命令：tables、describe`)
  }
  if (sub === 'describe') return usageFail('db describe 尚未实现（见 qiyu db --help；将在后续版本提供）')
  return dbTables(rest)
}
