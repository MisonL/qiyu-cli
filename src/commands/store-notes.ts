// src/commands/store-notes.ts
//
// `store init` 与 `store status` 的 `meta.field_notes` —— 存储层定位与版本信息的逐键释义。
//
// ⚠️ 为什么需要（2026-10-28 真库实测）：
//   · `schema_version` 是一个裸数字，没有对照基准就没有意义 —— 它要跟当前 CLI 的
//     `LATEST_VERSION` 比，才知道库是不是旧版建的；
//   · `tables` 只列**本 CLI 声明的表**（`TABLES`），与 `db tables` 同一组 ——
//     但库里有未声明的表时，两边数量仍会不等（多表），文案必须解释**两个方向**，
//     不能只说「不一致说明有表缺失」（2026-11-01 修：那句把 Agent 引向
//     「库不完整/需重建」，而重建会**销毁它正在观察的那些未声明表**）；
//   · `config_exists: false` 容易被读成「存储没配好」，其实用 `--db` / 环境变量 /
//     默认路径照样工作，`store init` 也不写配置文件。
//
// ⚠️ 释义正文不用 `；`（renderNotes 的拼接符），也不用 `**`（stdout JSON 给 Agent）。
import { LATEST_VERSION } from '../store/schema.js'

/** `store init` / `store status` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function storeFieldNotes(): Record<string, string> {
  return {
    path: '实际生效的库文件路径（--db / QIYU_DB_PATH / 配置文件 / 默认值解析之后的结果），'
      + '不是配置文件里的原始写法',
    backend: '存储后端。当前恒为 duckdb —— 只有这一个取值，不要据此分支',
    config_path: '配置文件路径。⚠️ 它不是库路径：库在 path，配置在这里',
    config_exists: '命令执行时配置文件是否存在。false 不代表存储不可用 —— '
      + '用 --db、环境变量或默认路径照样能工作，store init 也不写配置文件',
    schema_version: `库内已应用的最高迁移版本（当前 CLI 是 ${LATEST_VERSION}）。`
      + '0 = 迁移记录表为空。小于当前版本说明库是旧版 CLI 建的：store init 会补建缺失的迁移，'
      + '已应用的不会重放（所以它修不了「表被删」这类损坏）',
    tables: '库里的表清单。只列本 CLI 声明的表（TABLES），与 db tables 列的是同一组表，'
      + '含内部表 schema_version / sync_state / sync_gaps，所以两边数量应当一致。'
      + '库里有而本 CLI 未声明的表（旧版 CLI 或其它工具建的）不出现在这里 —— '
      + '它们在 meta.warnings 里点名，数量不一致时先读 warnings 判成因，'
      + '⚠️ 不要据此断定「有表缺失」（多了表也会让数量不等，而重建库会销毁那些表）。'
      + '⚠️ 形状随命令不同：store init 给表名数组（["a","b"]），store status 给 '
      + '[{name, rows}] 且 rows 是真实 COUNT(*)（每次都要全表 COUNT，代价与数据量成正比，'
      + '不要当高频健康检查用）',
  }
}
