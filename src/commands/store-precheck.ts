// src/commands/store-precheck.ts —— 只读命令的「库前置检查」：**唯一实现点**
// （2026-10-31，PR #54）。
//
// 背景（起因 × 九个命令逐条对照的 E2E 矩阵实测）：这套前置检查此前在**三个文件**里
// 各写了一份 —— `commands/db.ts`（E 族四命令共用）、`commands/sync.ts`（sync 三命令）、
// `commands/store.ts` 的 status 路径。复制出来的那几份已经漂移，其中一处是**事实错误**：
//   · `store status --db <FIFO>` / `--db /dev/null` 说「**--db 指向的是目录**而非数据库文件」,
//     而那个路径根本不是目录（`mkfifo`、字符设备实测）—— 判据是 `!isFile()`（覆盖
//     命名管道 / 设备 / 套接字），文案却按「目录」这一种成因写死；
//   · 同一成因在其余八个命令上是「指向的不是普通文件」—— **同一输入两种说法**，
//     且前一种把 Agent 引向「我传了个目录」这个不存在的方向；
//   · 「缺 schema_version」同理：`store status` 说「请运行：qiyu store init」，
//     其余命令说「空库（无任何表）。请先运行：…」。
// 形态归属：「同一份解码规则复制到多处 → 同一输入两个结论」。
// 同族前科：`nonEmptyValue` 空串判据（`tests/empty-string-single-source.test.ts`）、
// profile 名解析（PR #41）、打开失败成因（PR #53）。
//
// ⚠️ **本模块只服务只读命令**。`store init` 的前置检查是**另一条规则**（用 `lstatSync`
// 拒绝符号链接 + 建父目录，出口是「写」），结构不并入此处；它只复用本模块的两条
// **非普通文件**文案，免得同一成因在 init 与只读命令上说两套话。
import { lstatSync, statSync } from 'node:fs'
import { fail, storeInitCommand } from '../output.js'
import type { ErrorInput } from '../output.js'
import { TABLES } from '../store/schema.js'
import { objectKinds, isBaseTable, sameObjectName } from '../store/object-kinds.js'
import { missingTableCauses } from '../query/errors.js'

/**
 * 「库尚未初始化」的恢复命令 hint —— **唯一渲染点**。
 *
 * 两个产地共用这一句：① 本模块 `statGuard` 的 ENOENT 分支；② `sync-run.ts` 的
 * `storeInitFail` 兜底（store 打开失败但底层没带 hint 时）。两处成因不同、**动作相同**
 * （都是「跑一次 store init」），文案因此也必须同源 —— 各写一份就是下一次漂移的种子
 * （本轮 `store-precheck-single-source.test.ts` 的指纹扫描正是从 `sync-run.ts` 抓到它的）。
 */
export function storeNotInitializedHint(path: string): string {
  return '数据库尚未初始化。请先运行：' + storeInitCommand(path)
}

/** `--db` 指向**目录**时的 hint。 */
export const DIRECTORY_DB_HINT =
  '--db 指向的是目录而非数据库文件，请给出 .duckdb 数据库文件路径'

/**
 * `--db` 指向目录以外的非普通文件（命名管道 / 设备 / 套接字）时的 hint。
 * ⚠️ **不能**与 `DIRECTORY_DB_HINT` 合并成一句：「是目录」对 FIFO 是**假话**，
 * Agent 会去查自己是不是传了目录（它没有），而真正要做的只是换个路径。
 */
export const NON_REGULAR_DB_HINT =
  '--db 指向的不是普通文件（命名管道 / 设备 / 套接字等特殊文件），请给出 .duckdb 数据库文件路径'

/**
 * 非普通文件的 hint —— 按 `stat` 的**实际结果**分形。
 * 判据只问「是不是普通文件」，成因却有两种；把一种当成全部就是本轮修的那个错。
 */
export function nonRegularFileHint(isDirectory: boolean): string {
  return isDirectory ? DIRECTORY_DB_HINT : NON_REGULAR_DB_HINT
}

/**
 * `statSync` 失败（ENOENT 之外）的 hint —— **按 errno 分形**。
 *
 * ⚠️ 2026-11-07 审查实测：此前所有非 ENOENT 错误一律说「请检查路径权限」，
 * 而实测 `statSync` 的失败原因至少还有三种，逐字报文（macOS）：
 *   · `ELOOP: too many symbolic links encountered`（`ln -s loop loop`）
 *   · `ENOTDIR: not a directory`（`plain.txt/child`）
 *   · `ENAMETOOLONG: name too long`（300 字符路径）
 * 这三种都不是权限问题 —— 让 Agent 去查权限，它会在一个没有权限问题的地方白找一轮。
 * 判据只问「能不能 stat」，成因必须由 errno 说出来。
 * 未归类的 errno 如实说「未专门归类」，不猜成权限。
 */
export function statFailureHint(errno: string | undefined): string {
  switch (errno) {
    case 'EACCES':
    case 'EPERM':
      return '请检查路径权限（只读命令不需要写权限）'
    case 'ELOOP':
      return '路径中存在符号链接成环（ELOOP），stat 无法解析 —— 请改用真实路径，或先修掉循环链接'
    case 'ENOTDIR':
      return '路径中有一段不是目录（ENOTDIR）—— 请检查 --db 的拼写（它可能把文件当成了目录）'
    case 'ENAMETOOLONG':
      return '路径过长（ENAMETOOLONG）—— 请缩短 --db 路径'
    default:
      return `无法访问该路径（errno=${errno ?? '未知'}）：本 CLI 只按 errno 归类了权限 / 链接成环 /`
        + '路径中有非目录段 / 路径过长四种，其余请按报文里的系统错误码定位'
  }
}

/**
 * 断链符号链接的 hint（`statGuard` 的 ENOENT 分流用）；不是断链时返回 `null`。
 *
 * 只读命令对断链必须说「链接目标不存在」，**不得**指向 `store init` ——
 * `store init` 拒绝符号链接（`目标是符号链接，请给出真实路径`），照 hint 执行只会换一句错。
 * `lstat` 本身再失败（父目录不存在等）时同样返回 `null`，交回「路径不存在」原分支。
 */
function danglingSymlinkHint(path: string): string | null {
  let lst: ReturnType<typeof lstatSync>
  try { lst = lstatSync(path) } catch { return null }
  if (!lst.isSymbolicLink()) return null
  return `路径是一个符号链接，但它指向的目标不存在（stat 跟随链接后得到 ENOENT）。`
    + '请改用真实路径，或把链接改指向存在的库；`store init` 不接受符号链接路径，'
    + '照「先运行 store init」执行只会得到第二条错误'
}

/**
 * 只读命令的库前置检查（`statSync` 的 ENOENT / 非普通文件 / 其余 errno 三分）。
 * 合格（是一个普通文件）→ `null`，调用方继续打开库。
 *
 * hint 一律指向 `qiyu store init` 的**完整命令**（带本次 `--db` 绝对路径）——
 * 裸命令会作用在默认库上，逐字执行即死循环（`tests/store-hint-selection.test.ts`）。
 */
export function statGuard(path: string): number | null {
  let st: ReturnType<typeof statSync>
  try { st = statSync(path) } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      // ⚠️ 断链符号链接的 `statSync` 也抛 ENOENT（跟随链接后目标不存在），与「路径真的
      // 不存在」在 errno 上无法区分 —— 但两者该给的 hint 相反（2026-11-09 审计实测）：
      // 前者说「请运行 store init」，而 `store init` 自己 lstat 出是符号链接、拒绝执行，
      // 用户被两条 hint 锁进死循环。先 lstat 一次分流：lstat 层存在 → 一定是断链。
      const link = danglingSymlinkHint(path)
      if (link !== null) {
        return fail({
          code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
          message: `符号链接指向不存在的目标：${path}`,
          hint: link,
        })
      }
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库文件不存在：${path}`,
        hint: storeNotInitializedHint(path),
      })
    }
    return fail({
      code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `无法访问 ${path}：${e instanceof Error ? e.message : String(e)}`,
      hint: statFailureHint((e as { code?: string }).code),
    })
  }
  if (!st.isFile()) {
    return fail({
      code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
      message: `不是普通文件：${path}`,
      hint: nonRegularFileHint(st.isDirectory()),
    })
  }
  return null
}

/**
 * 库里**本 CLI 未声明**的表名（`TABLES` 之外）。
 *
 * ⚠️ 为什么必须是共享实现（2026-11-01 实测修）：`store status` 与 `store init` 都用
 * **全库** `information_schema` 拿表名，但 `store.count()` 内部走 `assertTable` ——
 * 库里有未声明的表时抛 `usage`（`未知表：xxx`，退出码 2），于是 `store status` 在
 * **库恰好有漂移时整条命令失败**（连 `schema_version` 都拿不到）。而 `db tables` 对
 * 同一状态只是把它列进 warnings ——「库中有而声明无」是全仓一致认可**要警告不失败**的
 * 漂移状态（`db tables` 的实现与 README 都这么写）。成因：判据只问了「库里有几张表」，
 * 没问「这几张是不是本 CLI 的」。
 */
export function undeclaredTables(names: readonly string[]): string[] {
  const declared = new Set(TABLES.map((t) => t.name))
  // 排序：`information_schema` 不保证顺序，`db tables` 此前自己 `.sort()`、`store`
  // 不排序 —— 同一库两次输出 warnings 顺序不同。统一在唯一实现点排序。
  return names.filter((n) => !declared.has(n)).sort()
}

/**
 * 「声明有而库中无」的表名（以 `TABLES` 为权威、按声明顺序）。
 *
 * ⚠️ 为什么必须是共享实现（2026-11-02 实测修）：`db tables` / `db describe` 会把它
 * 列进 warnings 并给出成因与对策（`missingTableCauses`），而 `store status` / `store init`
 * 此前只算了「库中有而声明无」那一半 —— 同一库、同一时刻，`db tables` 警告
 * `tickets` 不在，`store status` 却报 `ok` 且零 warnings（README 承诺两边表集一致，
 * 缺表时恰恰不一致，而 Agent 拿到的却是干净的成功）。只说一半漂移是比不说更容易被
 * 当成没事的形态：Agent 见 warnings 为空就以为「声明与实况已对齐」。
 */
export function declaredMissingTables(names: readonly string[]): string[] {
  const actual = new Set(names)
  return TABLES.map((t) => t.name).filter((n) => !actual.has(n))
}

/**
 * 「库中有而声明无」的 warning 文案 —— **唯一渲染点**（`store init` / `store status` /
 * `db tables` 共用；`db tables` 走下面的 `storeTablesWarnings`）。
 * 空数组 → `undefined`（不产生 `meta.warnings` 键：该键是**条件键**）。
 */
export function undeclaredTablesWarning(undeclared: readonly string[]): string[] | undefined {
  if (undeclared.length === 0) return undefined
  return [`库中有而声明无：${undeclared.join('、')}。这些表没有元数据声明（可能来自旧版 CLI `
    + '或其他工具），不出现在 tables 中']
}

/**
 * 库内对象的**类型**清单 SQL —— 与 `SCHEMA_VERSION_COLUMNS_SQL` 同款：唯一字符串，
 * 由各命令经自己的会话执行，判据本体在下面的纯函数里。
 *
 * ⚠️ 必须查出**元数据里的原样名字**（不是 `lower(table_name)`，Codex PR#76）：DuckDB 的
 * 标识符大小写不敏感 —— 引号建的 `"TICKETS"` view 会被 `"tickets"` 解析到（实测
 * `SELECT COUNT(*) FROM "tickets"` 执行的是那个 view），而本 CLI 的表名全是小写。
 * 判据见 `nonBaseTables()`：按「声明 vs 实际」比对，声明名一律小写，所以元数据必须保留原样。
 */
export const OBJECT_KINDS_SQL =
  "SELECT table_name, table_type FROM information_schema.tables WHERE table_schema='main'"

/**
 * 从 `OBJECT_KINDS_SQL` 的结果里挑出**不是基表**的对象（view / 外部表等）。
 *
 * ⚠️ 为什么（2026-11-14，历史审查 PR#4 复核实测）：`store status` 对全库逐表 COUNT，
 * 而 `information_schema.tables` **把 view 也算作表** —— 一条与声明表同名的 view 会作为
 * `COUNT(*)` 的**本体**以用户权限执行（实测：含 `read_csv_auto(…/probe.csv)` 的 `tags`
 * view 让 status 抛 IO Error、整条命令退出 1，而「库有漂移只警告、不失败」是对外承诺）。
 * 表名匹配 ≠ 对象类型匹配：计数前必须先按类型过滤，不是基表就不执行它。
 *
 * ⚠️ 大小写（Codex PR#76 实测确认）：DuckDB 标识符大小写不敏感 —— 一条 `"TICKETS"` view
 * 会在 `COUNT(*) FROM "tickets"` 时被执行，而元数据里的名字是 `TICKETS`、本 CLI 的声明名
 * 全是小写。调用方用**声明名**去比对时（`store status` / `db tables` / `store init` /
 * `sync verify` / `detectForeignStore`），必须用 `sameObjectName()`，不能 `Set.has()` 精确比。
 */
export function nonBaseTables(rows: ReadonlyArray<Record<string, unknown>>): string[] {
  return objectKinds(rows).filter((o) => !isBaseTable(o)).map((o) => o.name).sort()
}

/** 名字比对的大小写规则唯一实现点在 `store/object-kinds.ts`，此处经上面的 import 再导出。 */
export { sameObjectName }

/** 「同名对象不是基表」的警告（空数组 → `undefined`，与 `undeclaredTablesWarning` 同约定）。 */
export function nonBaseTablesWarning(nonBase: readonly string[]): string[] | undefined {
  if (nonBase.length === 0) return undefined
  return [`库中有同名对象但不是基表（view 等）：${nonBase.join('、')}。这些对象不被计数、`
    + '不出现在 tables 中']
}

/**
 * 「声明 vs 实况」两个方向的 `meta.warnings` —— **唯一渲染点**（`store init` /
 * `store status` / `db tables` 三处此前各拼一遍）。
 *
 * 两半都必须在场：只报「库中有而声明无」会让缺表静默（见 `declaredMissingTables` 的说明）。
 * 缺表那半的成因与对策**不得**自带一份，取 `query/errors.ts` 的 `missingTableCauses()`
 * （与 db/query/stats 四个出口逐字同源 —— tests/missing-table-causes.test.ts 钉着）。
 * 两半都为空 → `undefined`（`meta.warnings` 是条件键）。
 */
export function storeTablesWarnings(
  names: readonly string[], path: string, profileFlag?: string,
): string[] | undefined {
  const warnings: string[] = []
  const missing = declaredMissingTables(names)
  if (missing.length > 0) {
    warnings.push(`声明有而库中无：${missing.join('、')}。这些表不出现在 tables 中。`
      + missingTableCauses(path, profileFlag))
  }
  warnings.push(...(undeclaredTablesWarning(undeclaredTables(names)) ?? []))
  return warnings.length > 0 ? warnings : undefined
}

/**
 * 查 `schema_version` 表列名的 SQL —— **唯一字符串**（db/store/sync 三个调用点共用，
 * 各自经自己的会话执行；判据本体在 `schemaVersionMissing`）。
 * 列名原样返回（调用方按 `versionColumns` 判），表名匹配交给 DuckDB 解析器 —— 它在
 * 目录表上不区分大小写，`"SCHEMA_VERSION"` 表同样会返回它的列。
 */
export const SCHEMA_VERSION_COLUMNS_SQL =
  "SELECT column_name FROM information_schema.columns WHERE table_schema='main' "
  + "AND lower(table_name)='schema_version'"

/**
 * 库结构校验：已有 `schema_version` → `null`；否则给出**按成因分形**的失败载荷。
 *
 * ⚠️ **成因必须分形**：「有表但无 `schema_version`」是**他人库** —— `store init` 会再次
 * 拒绝（`store/duckdb.ts` 的他人库防线），把它一并引导向 `store init` 就是
 * `store init` → 原命令的死循环；「零表」才是 `init` 可补的成因。
 *
 * ⚠️ **表名不是身份证明**（2026-11-07 审查实测）：别的工具也会建叫 `schema_version`
 * 的表。探针实测 `schema_version(version_id, applied_at)` 的库：旧判据放行，`store status`
 * 落 internal「存储操作失败（底层：Binder Error: … version not found）」+「备份重建」hint
 * —— 把一个只是**不是本 CLI 的库**说成损坏缓存。调用方用 `SCHEMA_VERSION_COLUMNS_SQL`
 * 查到列名后传 `versionColumns`；**没传**时保持旧判据（不猜）。
 *
 * ⚠️ 返回载荷而不是自己 `fail()`：调用方失败前还得先关掉自己持有的会话
 * （`openSandbox` 的 session / `openStore` 的 store），关会话是调用方的所有权责任。
 */
export function schemaVersionMissing(
  path: string, names: readonly string[], versionColumns?: readonly string[],
): ErrorInput | null {
  // ⚠️ 存在性同样大小写不敏感（Codex PR#76，与上面列名那条同一理由）：库里的
  // `"SCHEMA_VERSION"` 表会被后续按小写名的查询解析到，按精确比较会把它当成「缺表」。
  if (names.some((n) => sameObjectName('schema_version', n))) {
    // ⚠️ 列名比较必须与 DuckDB 的解析规则一致（Codex 2026-11-09 第十三轮 P2，真机实测）：
    // `CREATE TABLE schema_version ("VERSION" INTEGER, …)` 反射出 `VERSION`/`Version`，
    // 而 `SELECT MAX(version)` 照样解析成功 —— 旧的小写精确比较会把**可用的库**判成他人库、
    // 挡住全部读命令。反例同样实测过：带空格的 `" version"` / `"version "` 与 `version_id`
    // 确实解析失败，只有大小写变体不可区分。
    if (versionColumns !== undefined
      && !versionColumns.some((c) => c.toLowerCase() === 'version')) {
      return {
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `目标数据库不是本 CLI 创建的（schema_version 表缺少 version 列，`
          + `实际列：${versionColumns.join('、')}）：${path}`,
        hint: '目标数据库不是本 CLI 创建的，请换 --db 路径',
      }
    }
    return null
  }
  return {
    code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
    message: `数据库结构不完整（缺表）：${path}`,
    hint: names.length > 0
      ? '目标数据库不是本 CLI 创建的，请换 --db 路径'
      : '空库（无任何表）。请先运行：' + storeInitCommand(path),
  }
}
