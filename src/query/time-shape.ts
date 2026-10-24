// src/query/time-shape.ts —— 时间列「形态合格」SQL 谓词的**唯一**事实源。
//
// `db tables` / `db describe` 的 time_range（commands/db.ts）与 `query --table` 的
// 主查询 / 覆盖查询 / 缺省下界（query/table-query.ts）必须对「哪些行算合格时间值」
// 给出**同一个**答案：两处分叉的话，同一条脏库会在 db 侧被排除、在 query 侧被当成
// 覆盖范围 —— 同一状态两种说法。此前两份逐字副本只靠注释与字符串相等测试防守，
// gap 2 的缺陷正来自这两份副本；现在由构造保证（CodeRabbit nitpick）。
//
// 约定：`col` 是**已加双引号的列表达式**（两个调用方的引号风格本就一致 ——
// 列名全部来自 `TABLES` 闭集，无注入面）。传各自 `quote(name)` 的产物即可：
// 引号是「拼 SQL」的通用关注点，不属于时间形态，故不在这里收编。
//
// 三条实测约束（逐条都有审查编号与失败形态，别再简化）：
//   · epoch-ms 也必须有数值判据（正确性审查 F5）：`TRY_CAST IS NULL` 只挡非数字，
//     `-1`（七鱼「无值」哨兵）、秒级 / 微秒级误写全部「合法」—— 会让 time_range
//     声称数据从 1970 年开始。写路径对秒级时间戳已有同口径丢弃（`reports.ts` 的
//     `n <= 1e11`）。
//   · epoch-ms 上界是 `MAX_SHANGHAI_SAFE_MS` 而不是 `MAX_DATE_MS`（F 维度审查 gap 2）：
//     回显要加上海偏移，差这 8 小时就会在 `shanghaiIso` 里抛 `RangeError` ——
//     「形状合格」必须 ⊆「能回显」。
//   · iso 两形态：用 `regexp_matches`，不要用 `~`（实测 DuckDB 1.5.6-r.1 的 `~`
//     不是正则匹配，会把所有行都滤掉）；秒必须存在（`:[0-9]{2}` 不可选 ——
//     `T02:00Z` 能过宽松正则却 cast 不了）；正则之外还要 `TRY_CAST(...) IS NOT NULL`
//     （正确性审查 F3：`'2026-10-14T02:00Z'` 过得了正则，`TRY_CAST` 是 NULL ——
//     只按正则判会让它在 arg_min 里被静默踢出 time_range）。
import { MAX_SHANGHAI_SAFE_MS } from '../core/time.js'
import type { TimeColumnKind } from '../store/schema.js'

/**
 * 「该列的哪些行算合格时间值」的 WHERE 片段（调用方用 `AND` 连接）。
 *
 * 判据 = 「形态正则命中」**且**「能解析成时刻 / 整数」。
 */
export function timeShapeClauses(kind: TimeColumnKind, col: string): string[] {
  if (kind === 'epoch-ms') {
    const n = `TRY_CAST(${col} AS BIGINT)`
    return [`${n} > 100000000000`, `${n} <= ${MAX_SHANGHAI_SAFE_MS}`]
  }
  const shape = kind === 'iso-day'
    ? '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$'
    : '^[0-9]{4}-[0-9]{2}-[0-9]{2}[T ][0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?(Z|[+-][0-9]{2}:?[0-9]{2})$'
  return [
    `regexp_matches(${col}, '${shape}')`,
    `TRY_CAST(${col} AS TIMESTAMPTZ) IS NOT NULL`,
  ]
}
