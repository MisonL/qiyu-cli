// src/commands/query.ts —— E-T8：`query --sql`（spec §五 / §七 / §十 / §十一）。
//
// 形态沿 store.ts / db.ts：parseFlags（值位守卫）→ usageFail/fail 双通道 →
// 查询层统一错误出口 thrownToQueryExit。
//
// 三条硬约束：
//   · 执行只走 `query/sandbox.ts` 的三层只读沙箱（spec §5.1）——本文件不直接触碰
//     DuckDB 驱动（驱动包名字面量禁止出现在 src/commands/，layering 红线）；
//   · 默认脱敏，原始值必须显式 `--no-mask`（spec §七）。脱敏的唯一出口是
//     `query/mask.ts`，本文件不自己改值；
//   · 0 行 ≠ 没有数据（spec §十）：SQL 含时间列而结果 0 行 → 必须附可操作警告。
//
// `--table` 由 Task 9 在同一文件追加；本任务只保留互斥检查与占位分支。
import { resolveStoreConfig } from '../store/config.js'
import { openSandbox } from '../query/sandbox.js'
import type { SandboxSession } from '../query/sandbox.js'
import { thrownToQueryExit } from '../query/errors.js'
import { maskQueryRows } from '../query/mask.js'
import { TABLES } from '../store/schema.js'
import { statGuard } from './db.js'
import { ok, fail, usageFail, sanitizeControlChars, describeArgs } from '../output.js'

const USAGE = `用法：qiyu query <查询方式> [参数]

查询方式（二选一）：
  query --sql <SQL>        任意只读 SQL（三层只读沙箱 + 默认脱敏 + 行数上限 + 超时）
  query --table <表>       受约束查询通道（尚未实现）

参数：
  --limit <n>             最多返回行数，1–10000 的整数（默认 1000）
  --timeout <秒>          超时秒数，非负数，0 = 无超时（默认 30）
  --no-mask               关闭默认脱敏，输出原始 PII（不要写入日志或对外报表）
  --db <path> / --profile <name> / --backend <name>
                          存储定位（与 store / sync 命令同族）

只接受单条 SELECT / DESCRIBE / SHOW / EXPLAIN；写操作、多语句、文件与网络访问一律被沙箱拦截。
`

const KNOWN = new Set(['--help', '-h', '--pretty'])

/** 值位参数（缺值或值以 `--` 开头 → 报缺值，防止把下一个 flag 当取值）。 */
const VALUE_FLAGS = new Set(['--sql', '--table', '--limit', '--timeout', '--db', '--profile', '--backend'])

/**
 * 全部已知 flag token（含布尔 flag 与 help/pretty）。
 * 值位守卫用它区分两件事：「取值恰好是下一个 flag」（真缺值）与
 * 「取值只是以 `--` 开头」（SQL 的行注释，合法输入）。
 */
const FLAG_TOKENS = new Set([...VALUE_FLAGS, '--no-mask', '--help', '-h', '--pretty'])

/**
 * 超时上界 = Node 定时器的最大延迟（2^31−1 ms）。超过它 setTimeout 会**溢出成 1ms**
 * 立即触发 —— 用户本想「几乎不限时」却得到「立刻超时」，是静默的语义反转，必须拒绝。
 */
const TIMEOUT_MAX_MS = 2_147_483_647

/**
 * 0 行警告的触发正则（spec §十）：SQL 文本命中任一业务时间列名即认为这是一次
 * 时间过滤查询 —— 0 行更可能是同步未覆盖该区间，而不是「那段时间真没有数据」。
 */
const ZERO_ROW_TIME_RE = /\b(stat_date|work_date|hour_ts|startTime|endTime)\b/

interface QueryFlags {
  sql?: string
  table?: string
  limit?: string
  timeout?: string
  noMask: boolean
  db?: string
  profile?: string
  backend?: string
}

function parseFlags(argv: string[]): QueryFlags & { rest: string[] } {
  const out: QueryFlags & { rest: string[] } = { noMask: false, rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (VALUE_FLAGS.has(a)) {
      const v = argv[i + 1]
      // 值位守卫（沿 store.ts / db.ts）：值位缺失，或取值**恰好是已知 flag** → 报缺值，
      // 否则 `query --sql --limit 2` 会把 --limit 当成 SQL 文本。
      // ⚠️ `--sql` 只拒绝「恰好是已知 flag」的值：SQL 以 `--` 开头是合法行注释
      // （`--sql '-- 注释\nSELECT 1'` 必须能跑）。路径/名字/数字的合法取值不会以 `--`
      // 开头，所以其余值位参数仍按前缀拒绝。
      if (v === undefined || (a === '--sql' ? FLAG_TOKENS.has(v) : v.startsWith('--'))) {
        throw new Error(`${a} 缺少取值`)
      }
      if (a === '--sql') out.sql = v
      else if (a === '--table') out.table = v
      else if (a === '--limit') out.limit = v
      else if (a === '--timeout') out.timeout = v
      else if (a === '--db') out.db = v
      else if (a === '--profile') out.profile = v
      else out.backend = v
      i++
    } else if (a === '--no-mask') {
      out.noMask = true
    } else out.rest.push(a)
  }
  return out
}

/** `--limit`：1–10000 的整数（spec §5.3；越界/非整数一律 usage，不做静默钳制）。 */
function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 1000
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isInteger(n) || n < 1 || n > 10000) {
    throw new Error(`--limit 必须是 1–10000 的整数，收到：${raw}`)
  }
  return n
}

/**
 * `--timeout`：非负秒数，0 = 无超时（spec §5.3）。
 * ⚠️ 极小正数（如 0.0001）四舍五入后是 0ms —— 若原样传给沙箱就变成「无超时」，
 * 与用户意图相反；钳到 1ms，保证「给了正数就真的有超时」。
 * ⚠️ 上界见 `TIMEOUT_MAX_MS`：超过 Node 定时器上限会溢出成立即超时，必须拒绝。
 */
function parseTimeoutMs(raw: string | undefined): number {
  if (raw === undefined) return 30_000
  const n = Number(raw)
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0) {
    throw new Error(`--timeout 必须是非负数（秒，0 = 无超时），收到：${raw}`)
  }
  const ms = Math.round(n * 1000)
  if (ms > TIMEOUT_MAX_MS) {
    throw new Error(
      `--timeout 过大（上限 ${TIMEOUT_MAX_MS / 1000} 秒），收到：${raw}；` +
      '再大会溢出 Node 定时器、变成立即超时。若想不限时请用 --timeout 0')
  }
  return n > 0 && ms === 0 ? 1 : ms
}

export async function queryCommand(argv: string[]): Promise<number> {
  // 次序沿 store.ts / db.ts：--help 分流 → --pretty 显式拒绝 → parseFlags → 未知参数。
  if (argv.includes('--help') || argv.includes('-h')) {
    // --help 不吞额外参数；--pretty 豁免（同族惯例）。
    // 措辞不用「未知参数」：`--sql` 是已知参数、只是不能与 --help 同时出现（同一条闸门）。
    const extra = argv.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`--help 不接受额外参数：${extra.join(' ')}`)
    process.stdout.write(USAGE)
    return 0
  }
  if (argv.includes('--pretty')) return usageFail('--pretty 尚未实现 —— 目前只输出紧凑 JSON')

  let flags: ReturnType<typeof parseFlags>
  try { flags = parseFlags(argv) } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }
  // describeArgs：空串/纯空白参数渲染成 `''`/`' '`，不让消息变成「未知参数：」冒号后空白。
  if (flags.rest.length > 0) return usageFail(`未知参数：${describeArgs(flags.rest)}`)

  // —— 查询方式：互斥且至少给一个（spec §六）——
  const { sql, table } = flags
  if (sql !== undefined && table !== undefined) {
    return usageFail('--sql 与 --table 互斥，只能给一个')
  }
  // Task 9 在同一文件实现 --table；在此之前给明确的「尚未实现」，不伪装成未知参数。
  if (table !== undefined) return usageFail('query --table 尚未实现')
  if (sql === undefined) return usageFail('缺少查询方式：请给 --sql <SQL> 或 --table <表>')

  let limit: number
  let timeoutMs: number
  try {
    limit = parseLimit(flags.limit)
    timeoutMs = parseTimeoutMs(flags.timeout)
  } catch (e) { return usageFail(sanitizeControlChars((e as Error).message)) }

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

  // 库前置检查（ENOENT / 非普通文件 / 权限三分 → 退出码 1，hint 指 store init）。
  const guarded = statGuard(config.path)
  if (guarded !== null) return guarded

  let session: SandboxSession
  try {
    session = await openSandbox(config)
  } catch (e) { return thrownToQueryExit(e, TABLES) }

  try {
    // 库结构校验（spec §十一「库不存在/缺表 → store_not_initialized、退出码 1」）。
    // ⚠️ 必须有：合法 DuckDB 但**没有 schema_version** 的库（空库 / 别的工具建的库 /
    // 迁移没跑完）在沙箱里照样能执行 SQL，于是 `SELECT 1` 会「成功」—— 而 `masked:true`
    // 的语义建立在本 CLI 的 PII 列集上，对不认识的 schema 这个声明没有依据；
    // `SELECT * FROM sessions` 更会得到「表不存在，候选：sessions」，把 Agent 引去改 SQL，
    // 而正确处置是 `qiyu store init`。探测口径与 commands/db.ts 同款（限定 main schema，
    // 避免同名表在别的 schema 里被误认）。
    const sv = await session.run(
      "SELECT 1 FROM information_schema.tables WHERE table_schema='main' AND table_name='schema_version'")
    if (sv.rows.length === 0) {
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库结构不完整（缺表）：${config.path}`,
        hint: '目标数据库不是本 CLI 创建的，请换 --db 路径，或先运行：qiyu store init',
      })
    }

    const result = await session.run(sql, { limit, timeoutMs })
    // 脱敏唯一出口（spec §7.2）：列名级 + 值级兜底 + 缺口警告都在 mask.ts 内。
    const masked = maskQueryRows({
      rows: result.rows, columns: result.columns,
      mode: { kind: 'sql', sql, tables: TABLES }, noMask: flags.noMask,
    })

    // 0 行 ≠ 没有数据（spec §十 / 红线 3）：时间过滤查询 0 行时附可操作提示。
    const warnings: string[] = []
    if (result.rows.length === 0 && ZERO_ROW_TIME_RE.test(sql)) {
      warnings.push(
        '查询返回 0 行，且 SQL 引用了业务时间列。这不代表没有数据：' +
        '同步可能未覆盖该区间——用 `qiyu sync status` 查看覆盖范围，或放宽过滤条件')
    }

    // --no-mask 的风险警告属于「脱敏整体关闭」，进 meta.warnings；mask_warnings 只装
    // 静态缺口警告（没脱敏就没有「脱敏不完整」可言）。spec §7.2。
    const maskWarnings = flags.noMask ? [] : masked.warnings
    if (flags.noMask) warnings.push(...masked.warnings)

    return ok(
      { columns: result.columns, rows: masked.rows },
      {
        rows: masked.rows.length,
        truncated: result.truncated,
        limit_applied: limit,
        masked: !flags.noMask,
        masked_columns: masked.maskedColumns,
        mask_warnings: maskWarnings,
        warnings,
        // --sql 通道无法通用判定请求区间与数据覆盖（spec §十）：恒 null，不猜。
        resolved_range: null,
        data_coverage: null,
      },
    )
  } catch (e) {
    return thrownToQueryExit(e, TABLES)
  } finally {
    await session.close()
  }
}
