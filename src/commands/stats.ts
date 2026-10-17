// src/commands/stats.ts —— E-T10：`stats fields <table>`（spec §九）。
//
// 形态沿 db.ts / query.ts：parseFlags（值位守卫）→ usageFail/fail 双通道 →
// 查询层统一错误出口 thrownToQueryExit。
//
// 三条硬约束：
//   · 只统计**报表域表**（REPORT_TABLES 闭集，spec §9.1）——会话/工单的 payload 是
//     PII 副本，统计它没有价值且扩大暴露面；其它表 → usage + 可用表清单；
//   · 声明与观测分离（spec §9.2）：`declared` 来自代码内受控目录（metric-catalog），
//     每条带 source；`observed` 是本地 payload 的数据分布，不是语义；
//   · `-1` 是「该窗口没有匹配到数据」的哨兵（设计稿实测，厂商未文档化）——
//     sentinel 恒在，且 min/max 一律排除 -1（否则 Agent 会报出 -100%）。
import { resolveStoreConfig } from '../store/config.js'
import { openSandbox } from '../query/sandbox.js'
import type { SandboxSession } from '../query/sandbox.js'
import { thrownToQueryExit } from '../query/errors.js'
import { METRIC_CATALOG, REPORT_TABLES, declareMetric } from '../query/metric-catalog.js'
import type { MetricDecl } from '../query/metric-catalog.js'
import { TABLES } from '../store/schema.js'
import { statGuard } from './db.js'
import { ok, fail, usageFail, sanitizeControlChars } from '../output.js'

const USAGE = `用法：qiyu stats <子命令> [参数]

子命令：
  stats fields <表> [--db <path>] [--profile <name>] [--backend <name>]
                           指标声明（带出处）+ 本地观测分布 + -1 哨兵

可用表（报表域，payload 内业务字段）：
  ${REPORT_TABLES.join('、')}

存储定位：--db / --profile / --backend（store 命令同族）。
`

const KNOWN = new Set(['--help', '-h', '--pretty'])

/**
 * -1 哨兵（spec §9.2，逐字）。设计稿 §6.2 用 A/B 实测证明：数据充足的 31 天窗口
 * 给出 assignedRatio=0.987，什么都匹配不到的筛选条件给出 -1.0 —— 不是负比率。
 */
const SENTINEL = {
  value: -1,
  meaning: '该窗口或筛选条件没有匹配到数据（设计稿 §6.2 实测：报表面族统一哨兵，厂商未文档化）',
} as const

interface StoreFlags { db?: string; profile?: string; backend?: string }

function parseFlags(argv: string[]): StoreFlags & { rest: string[] } {
  const out: StoreFlags & { rest: string[] } = { rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--db' || a === '--profile' || a === '--backend') {
      const v = argv[i + 1]
      // 值位守卫（沿 db.ts / query.ts）：值位缺失或以 -- 开头 → 报缺值，
      // 否则 `stats fields x --db --profile y` 会把 --profile 当路径。
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
 * 观测 SQL（spec §9.2 原型 SQL，探针 17 实测通过）。
 *
 * 逐字段统计（不是逐行取值）：
 *   · `rows_present`：payload 中出现该键的行数（缺键不进 json_keys；payload 为 SQL NULL /
 *     `{}` 的行不贡献任何字段行）；
 *   · `minus_one`：数值恰为 -1 的行数（哨兵）；
 *   · `nulls`：JSON null 的行数（`json_type(raw)='NULL'`）；
 *   · `min`/`max`：**排除 -1** 后的数值极值；非数值字段为 null（不报错）。
 *
 * ⚠️ 表名来自 REPORT_TABLES 闭集，是代码内常量，不承载外部输入。
 * ⚠️ JSON 路径用 `$."k"` 加引号形态：字段名含特殊字符（空格等）时仍成立（探针 6/17）。
 */
function observeSql(table: string): string {
  return `WITH kv AS (
  SELECT j.k AS k, t.payload AS payload
  FROM "${table}" t, unnest(json_keys(t.payload)) AS j(k)
), vals AS (
  SELECT k, payload,
         json_extract(payload, '$."' || k || '"') AS raw,
         TRY_CAST(json_extract_string(payload, '$."' || k || '"') AS DOUBLE) AS num
  FROM kv
)
SELECT k AS field, COUNT(*) AS rows_present,
       SUM(CASE WHEN num = -1 THEN 1 ELSE 0 END) AS minus_one,
       SUM(CASE WHEN raw IS NULL OR json_type(raw) = 'NULL' THEN 1 ELSE 0 END) AS nulls,
       MIN(CASE WHEN num <> -1 THEN num END) AS min,
       MAX(CASE WHEN num <> -1 THEN num END) AS max
FROM vals GROUP BY k ORDER BY k`
}

/** COUNT/SUM 经 getRowObjectsJson() 是**字符串**（BIGINT/DECIMAL 的 JSON 形态）→ Number() 收敛。 */
function countOf(v: unknown): number {
  return Number(v)
}

/** MIN/MAX：DOUBLE 或 null；null 原样保留（非数值字段没有极值，不编造 0）。 */
function extremeOf(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

/** 输出形态：note 缺省写成显式 null（spec §9.2 的声明形态四个键恒在）。 */
interface DeclOut {
  unit: MetricDecl['unit']
  higher_is_better: boolean | null
  source: MetricDecl['source']
  note: string | null
}

function declOut(d: MetricDecl): DeclOut {
  return {
    unit: d.unit,
    higher_is_better: d.higher_is_better,
    source: d.source,
    note: d.note ?? null,
  }
}

interface Observed {
  field: string
  rows_present: number
  minus_one: number
  nulls: number
  min: number | null
  max: number | null
}

async function statsFields(argv: string[]): Promise<number> {
  // 子命令级次序沿 db.ts：--help 分流 → --pretty 显式拒绝 → parseFlags → 位置参数。
  if (argv.includes('--help') || argv.includes('-h')) {
    const extra = argv.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
    process.stdout.write(USAGE)
    return 0
  }
  if (argv.includes('--pretty')) return usageFail('--pretty 尚未实现 —— 目前只输出紧凑 JSON')

  let flags: ReturnType<typeof parseFlags>
  try { flags = parseFlags(argv) } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }

  const flagish = flags.rest.filter((a) => a.startsWith('-'))
  if (flagish.length > 0) return usageFail(`未知参数：${flagish.join(' ')}`)
  if (flags.rest.length === 0) {
    return usageFail(`缺少表名：请给 stats fields <表>\n可用表：${REPORT_TABLES.join('、')}`)
  }
  if (flags.rest.length > 1) return usageFail(`未知参数：${flags.rest.slice(1).join(' ')}`)

  const table = sanitizeControlChars(flags.rest[0])
  // spec §9.1：闭集校验先于一切 I/O —— 非报表表不进库、不开连接。
  if (!REPORT_TABLES.includes(table)) {
    return usageFail(
      `stats fields 只接受报表域表，收到：${table}\n可用表：${REPORT_TABLES.join('、')}`,
      '会话/工单的 payload 是 PII 副本，统计它没有价值且扩大暴露面')
  }

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
    // 库结构校验（spec §十一「库不存在/缺表 → store_not_initialized、退出码 1」）：
    // ① 无 schema_version = 不是本 CLI 创建的库；② 有库但缺目标表 = 建库不完整。
    const sv = await session.run(
      "SELECT 1 FROM information_schema.tables WHERE table_name='schema_version'")
    if (sv.rows.length === 0) {
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库结构不完整（缺表）：${config.path}`,
        hint: '目标数据库不是本 CLI 创建的，请换 --db 路径，或先运行：qiyu store init',
      })
    }
    const target = await session.run(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='main' AND table_name='${table}'`)
    if (target.rows.length === 0) {
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库中缺表：${table}（${config.path}）`,
        hint: '建库可能不完整或库损坏，请先运行：qiyu store init',
      })
    }

    const result = await session.run(observeSql(table))
    const observed: Observed[] = result.rows.map((r) => ({
      field: String(r.field),
      rows_present: countOf(r.rows_present),
      minus_one: countOf(r.minus_one),
      nulls: countOf(r.nulls),
      min: extremeOf(r.min),
      max: extremeOf(r.max),
    }))

    // declared = 目录声明（即便该表当前没有数据，声明也不依赖数据）+ 每个观测字段。
    // ⚠️ 用 Map 而非普通对象累积：payload 的键名不受信，名为 `__proto__` 的键经
    // `obj[k] = v` 赋值会**改原型而不是建自有键**（实测：该字段从输出里静默消失，
    // 违反「每个 observed 字段都要在 declared 里有一条」）。`Object.fromEntries(Map)`
    // 保留它为自有键，JSON.stringify 也能正常序列化。
    const declared = new Map<string, DeclOut>()
    const group = Object.hasOwn(METRIC_CATALOG, table) ? METRIC_CATALOG[table] : undefined
    if (group !== undefined) {
      for (const [field, d] of Object.entries(group)) declared.set(field, declOut(d))
    }
    for (const o of observed) declared.set(o.field, declOut(declareMetric(table, o.field)))

    // unknown_fields：目录（含后缀派生）判不出单位的字段 —— Agent 据此知道
    // 「哪些字段没有单位信息」。observed 已按 field 排序，过滤保序。
    const unknownFields = observed
      .filter((o) => declared.get(o.field)?.unit === 'unknown')
      .map((o) => o.field)

    // 空结果有两种成因，警告必须分开说（「没有行」与「有行但 payload 没有可观测键」
    // 是不同的事实，前者指向同步、后者指向 payload 落库形态）。
    const warnings: string[] = []
    if (observed.length === 0) {
      const n = Number((await session.run(`SELECT COUNT(*) AS n FROM "${table}"`)).rows[0]?.n)
      if (n === 0) {
        warnings.push('该表无数据；先运行 `qiyu sync run`')
      } else {
        warnings.push(`该表有 ${n} 行，但 payload 均无可观测字段（payload 为 NULL / 空对象 / 非对象）。`
          + '字段自描述需要 payload 内的 JSON 键；请确认同步写入的是报表原始 JSON')
      }
    }
    // 观测 SQL 一行 = 一个字段；沙箱默认行数上限 1000，超限会被截断。
    // 报表 payload 实测几十个键，正常不会触发 —— 但截断不得静默（Agent 会把
    // 「只看到 1000 个字段」当成事实）。
    if (result.truncated) {
      warnings.push('字段数超过单次上限（1000），observed/declared/unknown_fields 只含前 1000 个字段；'
        + '该表的字段集可能不完整')
    }

    return ok(
      { table, sentinel: SENTINEL, declared: Object.fromEntries(declared), observed, unknown_fields: unknownFields },
      { warnings })
  } catch (e) {
    return thrownToQueryExit(e, TABLES)
  } finally {
    await session.close()
  }
}

export async function statsCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h') {
    // --help 不吞额外参数；--pretty 豁免（db.ts 同族惯例）
    const extra = rest.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
    process.stdout.write(USAGE)
    return 0
  }
  // `--pretty` 是合法 flag（承诺过未实现），不是「未知子命令」（db.ts 同族）。
  if (sub === '--pretty') return usageFail('--pretty 尚未实现 —— 目前只输出紧凑 JSON')
  if (sub !== 'fields') {
    return usageFail(`未知子命令：${sub}\n可用子命令：fields`)
  }
  return statsFields(rest)
}
