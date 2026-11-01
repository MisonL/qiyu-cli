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
import { statSync } from 'node:fs'
import { fail, storeInitCommand } from '../output.js'
import type { ErrorInput } from '../output.js'
import { TABLES } from '../store/schema.js'

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
 * 只读命令的库前置检查（`statSync` 的 ENOENT / 权限 / 非普通文件三分）。
 * 合格（是一个普通文件）→ `null`，调用方继续打开库。
 *
 * hint 一律指向 `qiyu store init` 的**完整命令**（带本次 `--db` 绝对路径）——
 * 裸命令会作用在默认库上，逐字执行即死循环（`tests/store-hint-selection.test.ts`）。
 */
export function statGuard(path: string): number | null {
  let st: ReturnType<typeof statSync>
  try { st = statSync(path) } catch (e) {
    if ((e as { code?: string }).code === 'ENOENT') {
      return fail({
        code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
        message: `数据库文件不存在：${path}`,
        hint: storeNotInitializedHint(path),
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
  return names.filter((n) => !declared.has(n))
}

/**
 * 「库中有而声明无」的 warning 文案 —— **唯一渲染点**（`store init` / `store status` /
 * `db tables` 共用口径；后者的文案稍有不同，见它自己的实现）。
 * 空数组 → `undefined`（不产生 `meta.warnings` 键：该键是**条件键**）。
 */
export function undeclaredTablesWarning(undeclared: readonly string[]): string[] | undefined {
  if (undeclared.length === 0) return undefined
  return [`库中有而声明无：${undeclared.join('、')}。这些表没有元数据声明（可能来自旧版 CLI `
    + '或其他工具），不出现在 tables 中']
}

/**
 * 库结构校验：已有 `schema_version` → `null`；否则给出**按成因分形**的失败载荷。
 *
 * ⚠️ **成因必须分形**：「有表但无 `schema_version`」是**他人库** —— `store init` 会再次
 * 拒绝（`store/duckdb.ts` 的他人库防线），把它一并引导向 `store init` 就是
 * `store init` → 原命令的死循环；「零表」才是 `init` 可补的成因。
 *
 * ⚠️ 返回载荷而不是自己 `fail()`：调用方失败前还得先关掉自己持有的会话
 * （`openSandbox` 的 session / `openStore` 的 store），关会话是调用方的所有权责任。
 */
export function schemaVersionMissing(path: string, names: readonly string[]): ErrorInput | null {
  if (names.includes('schema_version')) return null
  return {
    code: 'store_not_initialized', kind: 'store_not_initialized', retryable: false,
    message: `数据库结构不完整（缺表）：${path}`,
    hint: names.length > 0
      ? '目标数据库不是本 CLI 创建的，请换 --db 路径'
      : '空库（无任何表）。请先运行：' + storeInitCommand(path),
  }
}
