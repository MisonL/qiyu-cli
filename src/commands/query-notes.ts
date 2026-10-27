// src/commands/query-notes.ts
//
// `query` 两个通道（`--table` / `--sql`）共用的 `meta.field_notes` —— 9 个键的逐条释义。
//
// ⚠️ 为什么需要：`query` 是 skill 协议指定的主查询入口，它的 meta 里有一半是 Agent
// 要**按值分支**的机器值，而其中三处的字面与事实不符（2026-10-27 真库实测）：
//   · `masked: true` ≠ 「有值被改写」—— 它只表示脱敏开关开着，实际改写看 `masked_columns`
//     （实测：脱敏开着而 `masked_columns: []` 是常态）；
//   · `mask_warnings: []` ≠ 「脱敏完整」—— `--no-mask` 时它**恒为空**，风险警告在
//     `warnings` 里（实测）；
//   · `data_coverage` 只有首尾两点，**看不见内部缺口** —— 实测 7 天窗口里只有第 1、7 天
//     有数据时它照样报满区间，且 iso-instant / epoch-ms 表**没有任何警告兜底**
//     （`buildCoverageQuery` 只对 iso-day 算 `days`，其余是 `NULL AS days`）。
//
// ⚠️ 释义正文不用 `；`：`renderNotes` 系（sync / stats）用它拼 `a = 释义；b = 释义`，
// 正文里再出现会让反向解析多出幽灵取值（PR #26 踩过两次）。本文件没有枚举字段，
// 但保持同一约定，将来加枚举时不必回头改。

/** `query` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function queryFieldNotes(): Record<string, string> {
  return {
    rows: '本次返回的行数（= data.rows.length，脱敏与截断之后）。'
      + '⚠️ 它不是「命中的总行数」：truncated 为 true 时实际命中更多',
    truncated: 'true = 命中行数超过 limit_applied，本次只返回前 limit_applied 行。'
      + '⚠️ false 只说明「没超过上限」，不说明结果是全表——过滤条件仍可能排除了你要的行',
    limit_applied: '本次生效的行数上限（没给 --limit 时是默认 1000，可设 1–10000）。'
      + '它是上限不是实际行数，实际行数看 rows',
    masked: 'true = 脱敏开着（默认）。false = 本次用了 --no-mask，输出是原始 PII。'
      + '⚠️ true 不代表「有值被改写」——那要看 masked_columns',
    masked_columns: '本次实际被改写的列（至少一行的值在脱敏前后不同）。'
      + '⚠️ 为空不代表「没有敏感列」：只说明本次结果里没有需要改写的值'
      + '（全 null、全空串、或敏感列没被查出来）',
    mask_warnings: '脱敏缺口警告（声明为敏感、却因列不在表定义内或值形态无法归属而没脱敏）。'
      + '⚠️ --no-mask 时恒为空数组——空不等于脱敏完整，那是「根本没脱敏」，风险警告在 warnings 里',
    warnings: '非空必须逐条读：0 行成因、截断、窗口内部缺口、库漂移缺列、--no-mask 风险都在这里。'
      + '忽略它们的 Agent 会把残缺数据当事实汇报',
    resolved_range: '实际生效的时间过滤边界（+08:00 ISO）。⚠️ 它是过滤边界不是「有数据的范围」，'
      + '后者看 data_coverage。null 有四种成因：--sql 通道不判定区间、没给 --since/--until、'
      + '表没有时间列、只给 --until 而该表时间列无可用值（下界解析不出，此时 warnings 里有说明）',
    data_coverage: '时间列在过滤范围内的 MIN/MAX（+08:00 ISO，没有时间过滤时是全表的）。'
      + '独立于 --limit 计算，不受截断影响。'
      + '⚠️ 结构上只有首尾两点，看不见内部缺口：7 天里只有第 1、7 天有数据时它照样报满区间。'
      + 'iso-day 表另有 warnings 兜底（「区间内应有 N 个自然日，实际只有 M 个有数据」），'
      + 'iso-instant 与 epoch-ms 表没有任何兜底，必须另想办法核对（例如按自然日 GROUP BY 数行）。'
      + 'null 有三种成因：--sql 通道、表没有时间列、过滤范围内 0 行',
  }
}
