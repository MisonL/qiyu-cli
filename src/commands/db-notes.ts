// src/commands/db-notes.ts
//
// `db describe` 与 `db tables` 的 `meta.field_notes` —— 存储层只读命令的逐键释义。
//
// ⚠️ 为什么需要（2026-10-28 真库实测）：这两个命令把**声明**与**实况**混在同一层输出里，
// 而字段名只说了「是什么」、没说「是哪一种」：
//   · `columns` / `pii_columns` / `time_column` 全部来自本 CLI 的表定义（声明），
//     **表不在库中、列被删或多出列时照旧原样输出** —— 实测：`DROP TABLE tickets` 后
//     `db describe tickets` 仍给出 7 个声明列 + 5 个 PII 列，只有 warnings 说表不在库里；
//   · `time_range` 为 null 有四种互不相同的成因（无时间列 / 表不在库 / 时间列被删 /
//     没有一行的时间值能过形态谓词），只看 null 分不出该修什么；
//   · `db tables` 的 `tables` 数组**不含**声明有而库中无的表 —— 它们只在 warnings 里。
//
// ⚠️ 释义正文不用 `；`（renderNotes 的拼接符），也不用 `**`（stdout JSON 给 Agent）。
import type { TimeColumnKind } from '../store/schema.js'

/** 渲染成 `a = 释义；b = 释义` —— field_notes 的单元格形态（与 query / sync / stats 同款）。 */
function renderNotes(notes: Record<string, string>): string {
  return Object.entries(notes).map(([k, v]) => `${k} = ${v}`).join('；')
}

/**
 * `time_column.kind` 三个取值（2026-10-28 真库实测的存储形态）。
 *
 * 导出供测试双向核对（枚举 ⊆ 图例、图例 ⊆ 枚举）。
 */
export const TIME_COLUMN_KINDS = ['iso-day', 'iso-instant', 'epoch-ms'] as const
export type TimeColumnKindValue = typeof TIME_COLUMN_KINDS[number]

export const TIME_COLUMN_KIND_NOTES = {
  'iso-day': '库内存的是 UTC 瞬时串（上海自然日零点 = 前一日 16:00Z），所有元数据出口展示为 '
    + '+08:00。⚠️ 在 --sql 里直接按字符串比较时要用 UTC 形态，否则会少算一天',
  'iso-instant': 'ISO 8601 时刻串，可带 Z 或 +08:00 偏移。取值按解析后的时刻排序，'
    + '不按字符串字典序（混合偏移下两者相反）',
  'epoch-ms': '毫秒时间戳的数字字符串（列类型是 VARCHAR，内容是 BIGINT）。比较前先 CAST 成整数',
} satisfies Record<TimeColumnKindValue, string>

/** `db describe` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function describeFieldNotes(): Record<string, string> {
  return {
    grain: '声明里的行粒度（一行代表什么）。来自本 CLI 的表定义，不是从数据推出来的，'
      + '表不在库中时它照样输出',
    primary_key: '声明里的主键列。同样是声明：库里被删表或改过约束时这里不会变',
    columns: '声明元数据（来自本 CLI 的表定义），不是库里的实况：表不在库中、列被删或多出列时'
      + '这里照旧输出声明值，实况差异只在 warnings 里点名。columns / pii_columns / time_column'
      + '三者都是声明——要判断「库里真实有什么」只能看 warnings',
    'columns[].type': '声明里的列类型（VARCHAR 等）。同样是声明，不是从库里读出来的',
    'columns[].nullable': '声明里的可空性。null 值是否真的允许由库决定，这里不反映实况',
    'columns[].sensitive': 'true = 声明为敏感 PII。声明值，不是库里的实况。'
      + '⚠️ 可靠的按列脱敏只对 query --table 默认成立（--no-mask 可关闭，'
      + '关闭后输出就是原始 PII）。query --sql 不走列白名单，只有列名级与值级兜底，'
      + '别把 --sql 的输出当成已脱敏',
    'columns[].unit': '声明里的单位或形态说明（自由文本）。null = 该列没有声明单位，'
      + '不代表「无单位」',
    'columns[].observed_enum': '声明里记录的上游观测取值。null = 没记录。'
      + '⚠️ 它是观测记录不是约束：列里出现列表之外的值不算错误',
    'columns[].note': '声明里的补充说明。null = 没有',
    pii_columns: '敏感列的名单（从 columns 派生，同样是声明）。'
      + '⚠️ query --table 默认按列精确脱敏（--no-mask 可关闭，关闭后就是原始 PII），'
      + '而 query --sql 不走列白名单、只有列名级与值级兜底——不要把 --sql 的输出当成已脱敏。'
      + '一律不要 SELECT *',
    // ⚠️ 本单元格必须是**纯枚举**（`a = 释义；b = 释义`）：反向解析靠这个形状。
    // 「它也是声明」这条已写进 columns 的释义，别塞回这里（塞进来会让 iso-day 与
    // 前缀句粘成一段，反向解析少一个取值 —— 本文件初版就是这么错的）。
    time_column: renderNotes(TIME_COLUMN_KIND_NOTES),
    row_count: '库中该表的真实行数（COUNT(*)，不是估算）。null = 表不在库中，'
      + '这是唯一的 null 成因。此时 columns 等字段仍是声明元数据，不要当成库里有这张表',
    time_range: '时间列在整表范围内的 MIN/MAX（+08:00 ISO，只算形态合法的行）。'
      + '⚠️ 它是整表首尾，不是「你关心的区间」。null 有四种成因，靠别的字段区分：'
      + '表没有声明时间列（time_column 为 null）、表不在库中（row_count 为 null）、'
      + '时间列被删（warnings 点名少列）、没有一行的时间值能过形态谓词'
      + '（row_count 为 0 或全为脏值/NULL）',
  }
}

/** `db tables` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function tablesFieldNotes(): Record<string, string> {
  return {
    tables: '库中真实存在的表，顺序以本 CLI 的表定义为准。⚠️ 声明有而库中无的表'
      + '不在这里，只在 warnings 里点名——所以「清单里没有某张表」不等于「这张表不存在」',
    'tables[].rows': '该表的真实行数（COUNT(*)，不是估算）',
    'tables[].grain': '声明里的行粒度说明（一行代表什么）。声明，不是从数据推出来的',
    'tables[].time_range': '时间列在整表范围内的 MIN/MAX（+08:00 ISO，只算形态合法的行）。'
      + 'null 有三种成因：表没有声明时间列、时间列被删（warnings 点名）、'
      + '没有一行的时间值能过形态谓词（空表，或全是脏值/NULL —— 脏值另有 warning 报数量）。'
      + '注意这里没有「表不在库中」这一种：那种表根本不会出现在 tables 里',
    'tables[].pii_columns': '敏感列的名单（声明）。⚠️ 按列精确脱敏只对 query --table 默认成立'
      + '（--no-mask 可关闭，关闭后就是原始 PII），query --sql 不走列白名单，'
      + '别把它的输出当成已脱敏',
  }
}
