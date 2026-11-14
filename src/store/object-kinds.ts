// src/store/object-kinds.ts —— 库内对象类型（基表 / view …）的**唯一实现点**
// （2026-11-14，Codex PR#76）。
//
// 为什么在 store/ 而不是 commands/：`store/duckdb.ts` 的 `init()` 自身也必须判断
// 「这个对象是不是基表」（他人库指纹不认同名 view），而 `store/` 不得 import
// `commands/`。SQL 字符串在 `commands/store-precheck.ts` 的 `OBJECT_KINDS_SQL`
// （那里按命令层用法导出），本模块只放**判据**——两边共用这一份。

/** `{table_name, table_type}` 行（`OBJECT_KINDS_SQL` 的结果形态）。 */
export interface ObjectKind {
  name: string
  /** 元数据原样（`BASE TABLE` / `VIEW`），未大小写归一。 */
  type: string
}

export function objectKinds(rows: ReadonlyArray<Record<string, unknown>>): ObjectKind[] {
  return rows.map((r) => ({ name: String(r.table_name), type: String(r.table_type ?? '') }))
}

/** 是否为基表（类型缺失一律按「不是」处理 —— 宁可多拦，不可漏拦）。 */
export function isBaseTable(o: ObjectKind): boolean {
  return o.type.toUpperCase() === 'BASE TABLE'
}

/**
 * 是否为同一个对象名（DuckDB 标识符大小写不敏感）。
 *
 * ⚠️ 实测（Codex PR#76）：`CREATE VIEW "TICKETS"` 之后 `SELECT COUNT(*) FROM "tickets"`
 * 执行的就是这条 view —— 元数据里的名字是 `TICKETS`，本 CLI 的声明名全是小写，
 * 精确字符串比较会漏掉它并继续执行 view 本体。所有「声明名 ↔ 库内对象」的比对都走这里。
 *
 * ⚠️ **只折叠 ASCII A–Z**（CodeRabbit PR#76 第二轮）：DuckDB 的标识符大小写不敏感只针对
 * ASCII 字母 —— 实测引号建的 `"ticKets"`（U+212A KELVIN SIGN）与 `"tickets"` 是两个对象，
 * 而 JS 的 `toLowerCase()` 会把它折叠成 `tickets`（`"ticKets".toLowerCase() === "tickets"`），
 * 于是两条同名字符串上本存在一个名字含 `K` 的基表、一个含 `K` 的 view 时，会把基表也当成
 * 非基表跳过。用 `replace(/[A-Z]/g, …)` 替代 `toLowerCase()` / `localeCompare`（后者同样做
 * Unicode 折叠与区域设置相关的排序）。
 */
export function sameObjectName(a: string, b: string): boolean {
  return foldAscii(a) === foldAscii(b)
}

const foldAscii = (s: string): string => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32))
