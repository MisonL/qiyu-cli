// src/commands/stats.ts —— E-T10：`stats fields <table>`（spec §九）。
//
// 形态沿 db.ts / query.ts：parseStoreFlags（值位守卫）→ usageFail/fail 双通道 →
// 查询层统一错误出口 thrownToQueryExit。
//
// 三条硬约束：
//   · 只统计**报表域表**（REPORT_TABLES 闭集，spec §9.1）——会话/工单的 payload 是
//     PII 副本，统计它没有价值且扩大暴露面；其它表 → usage + 可用表清单；
//   · 声明与观测分离（spec §9.2）：`declared` 来自代码内受控目录（metric-catalog），
//     每条带 source；`observed` 是本地 payload 的数据分布，不是语义；
//   · `-1` 是「该窗口没有匹配到数据」的哨兵（设计稿实测，厂商未文档化）——
//     sentinel 恒在，且 min/max 一律排除 -1（否则 Agent 会报出 -100%）。
import { thrownToQueryExit, suggestNames } from '../query/errors.js'
import { METRIC_CATALOG, REPORT_TABLES, declareMetric } from '../query/metric-catalog.js'
import type { MetricDecl, MetricSource, MetricUnit } from '../query/metric-catalog.js'
import { TABLES } from '../store/schema.js'
import { openGuardedSession } from './db.js'
import { parseStoreFlags } from './store-flags.js'
import { ok, fail, usageFail, sanitizeControlChars, describeArgs, setPretty } from '../output.js'
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES, prettyAfterSubcommand, REJECTED_FLAGS, STORE_FLAGS } from './spec-types.js'
import type { CommandSpec } from './spec-types.js'

/**
 * 命令契约（F 组 D4）：`skill check` 据此判断 skill 正文里的 `qiyu stats …` 是否真的存在。
 * `flags` 是**完整接受集**（含全局 flag），`--pretty` 同时在 `rejected` 里。
 * 位置参数的 `report-tables` 域就是 `REPORT_TABLES` 闭集，校验方据此比对正文里的表名。
 */
export const STATS_SPECS: CommandSpec[] = [
  {
    path: ['stats', 'fields'],
    flags: [...GLOBAL_FLAGS, ...STORE_FLAGS],
    positionals: [{ name: '报表表', domain: 'report-tables' }],
    rejected: REJECTED_FLAGS,
  },
]

const USAGE = `用法：qiyu stats <子命令> [参数]

子命令：
  stats fields <表> [--db <path>] [--profile <name>] [--backend <name>]
                           指标声明（带出处）+ 本地观测分布 + -1 哨兵

可用表（报表域，payload 内业务字段）：
  ${REPORT_TABLES.join('、')}

存储定位：--db / --profile / --backend（store 命令同族）。
`

const KNOWN = new Set(GLOBAL_FLAG_NAMES)

/**
 * -1 哨兵（spec §9.2，逐字）。设计稿 §6.2 用 A/B 实测证明：数据充足的 31 天窗口
 * 给出 assignedRatio=0.987，什么都匹配不到的筛选条件给出 -1.0 —— 不是负比率。
 */
const SENTINEL = {
  value: -1,
  meaning: '该窗口或筛选条件没有匹配到数据（设计稿 §6.2 实测：报表面族统一哨兵，厂商未文档化）',
} as const

/**
 * 观测 SQL（spec §9.2 原型 SQL，探针 17 实测通过）。
 *
 * 逐字段统计（不是逐行取值）：
 *   · `rows_present`：payload 中出现该键的行数（缺键不出现；payload 为 SQL NULL /
 *     `{}`/数组/标量的行不贡献任何字段行）；
 *   · `minus_one`：数值恰为 -1 的行数（哨兵）；
 *   · `nulls`：JSON null 的行数（`json_each` 的 `type = 'NULL'`）；
 *   · `min`/`max`：**排除 -1** 后的数值极值；非数值字段为 null（不报错）。
 *
 * ⚠️ 表名来自 REPORT_TABLES 闭集，是代码内常量，不承载外部输入。
 *
 * ⚠️ 用 `json_each` 展开、**不拼 JSON 路径**（CodeRabbit nitpick，2026-10-19 探针复核）：
 * 早先的写法是 `json_keys` 逐键取，键名来自库里的 payload（不受信），必须按 JSON 路径
 * 语法转义后再 `json_extract`。实测（2026-10-18，DuckDB 1.5.6-r.1）转义写错就有两种病：
 *   · `a"b` / 尾随 `\` → `JSON path error`，**整条命令失败**（一个畸形键名杀掉全部统计）；
 *   · `a\\b`（键内含连续反斜杠）→ 路径静默返回 NULL，非空值被计成 nulls ——
 *     **静默错数**，比报错更糟。
 * `json_each` 直接给出 `key`/`value`/`type`，键名不进路径语法，整类缺陷消失；
 * 顺带每行只展开一次（旧写法对每个键重复解析 payload）。
 * ⚠️ 实测对照（2026-10-19，含 `b"c`、`x\y`、空键、JSON null、-1、非法 JSON、数组、标量）：
 * 新旧两版输出**逐字相同**，仅 `TRY(json_type(payload)) = 'OBJECT'` 把非对象行挡在外面。
 * `min/max` 走 `e.value ->> '$'`（JSON 值转文本再转 DOUBLE），非数值自然为 NULL。
 */
function observeSql(table: string): string {
  return `WITH kv AS (
  SELECT e.key AS k, e.value AS raw, e.type AS jt,
         TRY_CAST(e.value ->> '$' AS DOUBLE) AS num
  FROM (SELECT payload FROM "${table}" WHERE TRY(json_type(payload)) = 'OBJECT') t,
       json_each(t.payload) AS e
  WHERE e.key <> ''
)
SELECT k AS field, COUNT(*) AS rows_present,
       SUM(CASE WHEN num = -1 THEN 1 ELSE 0 END) AS minus_one,
       SUM(CASE WHEN jt = 'NULL' THEN 1 ELSE 0 END) AS nulls,
       MIN(CASE WHEN num <> -1 THEN num END) AS min,
       MAX(CASE WHEN num <> -1 THEN num END) AS max
FROM kv GROUP BY k ORDER BY k`
}

/**
 * 库形态计数（edge cases F1/F2）：一行 payload 不是合法 JSON、或含空键 `""` ——
 * 前者让 `json_keys` 抛 `Malformed JSON`，**一行坏数据会杀掉整条命令**（连不依赖数据的
 * `declared` 都拿不到）；后者拼出 `$.""` 路径、抛 `JSON path error`，同样整命令失败。
 * 观测 SQL 已用 `TRY`/过滤兜住这两类，本查询负责点名成因并进 `meta.warnings`
 * （「有坏行」与「表为空」是不同的事实，不能混成一句）。
 */
function shapeSql(table: string): string {
  return `SELECT
    COUNT(*) AS total,
    COUNT(*) FILTER (
      WHERE payload IS NOT NULL AND TRY(json_valid(payload)) IS NOT TRUE) AS bad_json,
    COUNT(*) FILTER (
      WHERE TRY(json_valid(payload)) IS TRUE AND
        EXISTS (SELECT 1 FROM unnest(TRY(json_keys(payload))) AS j(k) WHERE j.k = '')) AS empty_key
  FROM "${table}"`
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

/**
 * `declared.<字段>.unit` 的四个取值 —— 图例的**唯一构造点**（`satisfies` 让新增取值
 * 漏写释义直接编译失败）。
 *
 * ⚠️ 为什么必须逐值写出来：`stats fields` 的全部意义就是让 Agent **不猜单位**
 * （设计稿 §9.2「单位不确定 → 查 stats fields 的 unit；绝不要猜百分比还是绝对值」）。
 * 只输出 `ratio`/`count`/`ms`/`unknown` 四个英文词，等于把「猜」从字段名挪到了枚举值上：
 * `ratio` 是 0–1 还是 0–100？`ms` 是毫秒还是别的？不写清，Agent 照样会把 0.987
 * 报成「0.987%」或把毫秒当秒。
 *
 * 诚实边界（写进图例，不藏着）：`ratio` 的量纲只有 `assignedRatio` 一个字段被设计稿
 * §6.2 实测过（0.987 = 98.7%）；其余 ratio 字段是**按名字推断**的（见 source），
 * 量纲未逐一实测 —— 所以图例要指 Agent 去看 `observed` 的实际分布，而不是把推断当实测。
 */
export const UNIT_NOTES = {
  ratio: '比率（实测样本 assignedRatio=0.987，即 0–1 的小数、不是 0–100 的百分数）。'
    + '⚠️ 只有该字段经设计稿实测，其余 ratio 字段是命名推断（见 source）——报告百分比前'
    + '先用 observed 的 min/max 核对量纲',
  count: '计数（整数）',
  ms: '毫秒（实测样本 loginDuration 天粒度 = 86400024，即 86400000 + 24）',
  unknown: '判不出单位（目录未收录、字段名后缀也推不出）—— 不是「没有单位」：'
    + '报告时如实写「单位未知」，不要猜。这些字段同时列在 unknown_fields',
} satisfies Record<MetricUnit, string>

/** `declared.<字段>.source` 的两个取值：标明声明是实测还是命名推断。 */
export const SOURCE_NOTES = {
  'design-doc': '设计稿实测明说（可信度最高，该条 note 通常给出出处）',
  'name-suffix': '按字段名后缀推断（*Ratio/*Radio→ratio、*Count/sessions→count、'
    + '*Duration/*Time→ms）—— 是命名推断，不是实测。后缀推不出的记 unknown',
} satisfies Record<MetricSource, string>

/** 渲染成 `a = 释义；b = 释义` —— field_notes 的单元格形态（与 api list / skill where 同款）。 */
function renderNotes(notes: Record<string, string>): string {
  return Object.entries(notes).map(([k, v]) => `${k} = ${v}`).join('；')
}

/**
 * `stats fields` 的 `meta.field_notes`（导出供测试核对真实渲染路径 —— 测试若自写一份
 * 渲染副本，生产漏渲染某个值时它照样全绿）。
 */
export function statsFieldNotes(): Record<string, string> {
  return {
    'declared[].unit': renderNotes(UNIT_NOTES),
    'declared[].source': renderNotes(SOURCE_NOTES),
    'declared[].higher_is_better':
      '恒为 null —— 设计稿与本 CLI 都没有任何「指标越大越好还是越小越好」的上游依据，'
      + '不猜（设计稿 §9.2）。不要把 null 读成「本字段恰好没测到」，也不要把 null 当 false；'
      + '要判断趋势好坏只能由人给口径',
    'declared[].note': '该条声明的依据（通常只有 source=design-doc 的条目有）。null = 无出处注记',
    unknown_fields: 'unit 为 unknown 的观测字段（判据是「判不出单位」，不是「目录未收录」——'
      + '后缀能派生的字段即使不在目录里也不算）',
    'observed[].minus_one': '值为 -1 的行数。-1 是「该窗口或筛选条件没有匹配到数据」的哨兵'
      + '（厂商未文档化），不是负数比率。等于 rows_present 说明该字段本次全是哨兵',
    'observed[].min': '排除 -1 哨兵后的最小值；全为哨兵或非数值时为 null（不是 0）——'
      + 'null 时看 minus_one',
    'observed[].max': '排除 -1 哨兵后的最大值；全为哨兵或非数值时为 null（不是 0）',
    'observed[].rows_present': 'payload 中出现该键的行数（缺键、payload 为 NULL/空对象/非对象的行不计）',
    'observed[].nulls': '该键值为 JSON null 的行数',
  }
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
  // 子命令级次序沿 db.ts：--help 分流 → --pretty 开启缩进（G1） → parseStoreFlags → 位置参数。
  if (argv.includes('--help') || argv.includes('-h')) {
    const extra = argv.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
    process.stdout.write(USAGE)
    return 0
  }
  // G1：--pretty 已实现 —— 原拒绝点开启缩进输出（次序不变：help → 这里 → 值位解析）。
  if (argv.includes('--pretty')) setPretty(true)

  let flags: ReturnType<typeof parseStoreFlags>
  try { flags = parseStoreFlags(argv) } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }

  const flagish = flags.rest.filter((a) => a.startsWith('-'))
  if (flagish.length > 0) return usageFail(`未知参数：${flagish.join(' ')}`)
  if (flags.rest.length === 0) {
    return usageFail(`缺少表名：请给 stats fields <表>\n可用表：${REPORT_TABLES.join('、')}`)
  }
  if (flags.rest.length > 1) return usageFail(`未知参数：${flags.rest.slice(1).join(' ')}`)

  const table = sanitizeControlChars(flags.rest[0])
  // spec §9.1：闭集校验先于一切 I/O —— 非报表表不进库、不开连接。
  if (!REPORT_TABLES.includes(table)) {
    // ⚠️ hint 必须按**这句话是否成立**来给（2026-10-18 手工验收发现，复审 Minor-1 补齐）：
    // 固定写「会话/工单的 payload 是 PII 副本」对 `staff`/`tags` 这类维度表是假话
    //（它们没有 payload 列），对表名拼错更是毫无信息量。按「有无 payload 列 + 是否敏感」三分：
    //   · 表名未知 → 候选；
    //   · 有敏感 payload（sessions/tickets/ticket_logs）→ PII 理由；
    //   · 有**非敏感** payload（knowledge_* 三表）→ 不能说「没有 payload 列」——那与 schema 相反；
    //   · 无 payload 列（staff/tags/sync_state 等维度/元数据表）→ 收敛说明。
    const known = TABLES.find((t) => t.name === table)
    const candidates = known === undefined ? suggestNames(table, TABLES.map((t) => t.name)) : []
    const payloadCol = known?.columns.find((c) => c.name === 'payload')
    const hint = known === undefined
      ? (candidates.length > 0
        ? `候选：${candidates.join('、')}（stats fields 只接受报表域表；用 \`qiyu db tables\` 查看全部表）`
        : '用 `qiyu db tables` 查看全部表；stats fields 只接受报表域表')
      : payloadCol !== undefined && payloadCol.sensitive
        ? '该表的 payload 是整行 PII 副本：统计它没有价值且会扩大暴露面'
        : payloadCol !== undefined
          ? '该表的业务字段收敛在 payload 里但不属于报表域；stats fields 只做报表指标，字段清单请用 `qiyu db describe ' + table + '`'
          : '该表的业务字段不是整体收敛进 payload 的（没有 payload 列），字段自描述对它没有意义'
    return usageFail(
      `stats fields 只接受报表域表，收到：${describeArgs([table])}\n可用表：${REPORT_TABLES.join('、')}`,
      hint)
  }

  const opened = await openGuardedSession({
    db: flags.db, profile: flags.profile, backend: flags.backend,
  })
  if ('exit' in opened) return opened.exit
  const session = opened.session

  try {
    // 目标表存在性校验（spec §十一「库不存在/缺表 → store_not_initialized、退出码 1」）：
    // schema_version 的库结构校验在 openGuardedSession 里已做（E 族共用，口径见 db.ts 的
    // 注释）——这里只补本命令特有的「目标表缺」分支，并给出对 stats 有意义的 hint。
    const target = await session.run(
      `SELECT 1 FROM information_schema.tables WHERE table_schema='main' AND table_name='${table}'`)
    if (target.rows.length === 0) {
      // ⚠️ 不得承诺 store init 一定能修（审查 Important #1，与 db.ts:184-189 同款）：
      // init 只重放 `version > MAX(version)` 的迁移，已迁移到最新版后被 DROP 的表
      // **不会**被重建（迁移已跳过，返回 ok 而表仍缺）——那是「成功但无效」的修复。
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库中缺表：${table}（${opened.dbPath}）`,
        hint: '若为建库未完成（迁移未跑完），运行 qiyu store init 可补建缺失的迁移；'
          + '若迁移已完成而表被删或损坏，store init 不会重建该表，重新同步也只会写入失败（缺表）'
          + '——需重建库（删除库文件后重新 qiyu store init 并重新同步）',
      })
    }

    const result = await session.run(observeSql(table))
    const shape = (await session.run(shapeSql(table))).rows[0] ?? {}
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
    // 坏行先点名（edge cases F1/F2）：它们不进 observed，但**必须**说明成因 ——
    // 否则 Agent 会把「统计里少了几行」当成「那些字段就是没数据」。
    const badJson = countOf(shape.bad_json)
    if (badJson > 0) {
      warnings.push(`该表有 ${badJson} 行 payload 不是合法 JSON，未计入统计`
        + '（正常同步写入的是 JSON 字符串；这些行可能来自旧版 CLI、外部工具或库损坏）。'
        + '用 `qiyu query --sql` 单独查看它们以确认成因')
    }
    const emptyKey = countOf(shape.empty_key)
    if (emptyKey > 0) {
      warnings.push(`该表有 ${emptyKey} 行 payload 含空字符串键 ""，该键未计入统计`
        + '（JSON 路径无法表达空键名）；其余字段照常统计')
    }
    if (observed.length === 0) {
      const n = Number(shape.total)
      if (n === 0) {
        warnings.push('该表无数据；先运行 `qiyu sync run`')
      } else {
        warnings.push(`该表有 ${n} 行，但 payload 均无可观测字段（payload 为 NULL / 空对象 / 非对象）。`
          + '字段自描述需要 payload 内的 JSON 键；请确认同步写入的是报表原始 JSON')
      }
    }
    // 观测 SQL 一行 = 一个字段；沙箱默认行数上限（1000）超限即截断。
    // 报表 payload 实测几十个键，正常不会触发 —— 但截断不得静默（Agent 会把
    // 「只看到 N 个字段」当成事实）。⚠️ 文案不写死上限值：N 取自实际返回行数
    // （上限是沙箱的默认值，不是本命令的契约）；declared 还含目录声明、可能多于 N。
    if (result.truncated) {
      warnings.push(`观测字段数超过单次行数上限，observed/unknown_fields 只含按字段名排序的前 `
        + `${result.rows.length} 个字段；该表的字段集可能不完整`)
    }

    return ok(
      { table, sentinel: SENTINEL, declared: Object.fromEntries(declared), observed, unknown_fields: unknownFields },
      { field_notes: statsFieldNotes(), warnings })
  } catch (e) {
    return thrownToQueryExit(e, TABLES)
  } finally {
    await session.close()
  }
}

export async function statsCommand(argv: string[]): Promise<number> {
  setPretty(false) // G1：每条命令入口重置输出格式 —— 同一进程内多次 run（测试）不残留上一条命令的开关。
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h') {
    // --help 不吞额外参数；--pretty 豁免（db.ts 同族惯例）
    const extra = rest.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
    process.stdout.write(USAGE)
    return 0
  }
  // G1：--pretty 是输出开关，必须写在具体子命令之后（`stats fields <表> --pretty`）。
  if (sub === '--pretty') {
    const extra = rest.filter((a) => !KNOWN.has(a))
    if (extra.length > 0)
      return usageFail(`未知参数：${extra.join(' ')}。--pretty 不接受额外参数`)
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(USAGE)
      return 0
    }
    return usageFail(prettyAfterSubcommand('stats'))
  }
  if (sub !== 'fields') {
    return usageFail(`未知子命令：${sub}\n可用子命令：fields`)
  }
  return statsFields(rest)
}
