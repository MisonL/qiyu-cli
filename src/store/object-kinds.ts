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
 */
export function sameObjectName(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
