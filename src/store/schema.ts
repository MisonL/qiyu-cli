// src/store/schema.ts
export interface ColumnDef {
  name: string
  type: 'VARCHAR' | 'INTEGER'
  nullable: boolean
  /** ⚠️ E 交付前无运行时读取者 —— 是给 E 的 `db describe` 的预置位（spec §6.2）。 */
  sensitive?: boolean
}
export interface TableDef { name: string; columns: ColumnDef[]; primaryKey: string[] }

const col = (name: string, type: 'VARCHAR' | 'INTEGER', nullable = true): ColumnDef =>
  ({ name, type, nullable, sensitive: false })

export const TABLES: TableDef[] = [
  { name: 'schema_version', columns: [col('version', 'INTEGER', false)], primaryKey: ['version'] },
  {
    name: 'sync_state',
    columns: [col('dataset', 'VARCHAR', false), col('watermark', 'VARCHAR'), col('range_status', 'VARCHAR'),
      col('last_error', 'VARCHAR'), col('locked_by', 'VARCHAR'), col('locked_at', 'VARCHAR'),
      // D-T3：水位状态的同步时间（readWatermark 的 lastSyncedAt 往返落点）。
      col('last_synced_at', 'VARCHAR')],
    primaryKey: ['dataset'],
  },
  {
    name: 'sync_gaps',
    columns: [col('dataset', 'VARCHAR', false), col('range_start', 'VARCHAR', false), col('range_end', 'VARCHAR'),
      col('reason', 'VARCHAR'), col('recorded_at', 'VARCHAR'),
      // D-T3：缺口诊断详情（recordGap 的 detail 落点）。
      col('detail', 'VARCHAR')],
    primaryKey: ['dataset', 'range_start'],
  },
  {
    name: 'tags',
    columns: [col('id', 'VARCHAR', false), col('name', 'VARCHAR', false), col('color', 'VARCHAR', false)],
    primaryKey: ['id'],
  },
]

export function tableByName(name: string): TableDef | undefined {
  return TABLES.find((t) => t.name === name)
}

/** ⚠️ 只产 v1 基线建表语句 —— 对已存在的库加不了列。任何 TABLES 变更必须新增迁移条目（spec §6.2）。 */
export function ddlFor(t: TableDef): string {
  const cols = t.columns.map((c) => `"${c.name}" ${c.type}${c.nullable ? '' : ' NOT NULL'}`).join(', ')
  const pk = t.primaryKey.map((k) => `"${k}"`).join(', ')
  return `CREATE TABLE IF NOT EXISTS "${t.name}" (${cols}, PRIMARY KEY (${pk}))`
}

/** 迁移条目：函数式（可 ALTER TABLE）。一版本一行；当前版 = MAX(version)（spec §6.2）。 */
export interface Migration { version: number; up: (exec: (sql: string) => Promise<void>) => Promise<void> }

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: async (exec) => {
      for (const t of TABLES) await exec(ddlFor(t))
    },
  },
  // D-T3 迁移：为已有 C1 库补 sync_state.last_synced_at 与 sync_gaps.detail 两列。
  // ⚠️ 新库 v1 建表时 TABLES 已含这两列，故用 IF NOT EXISTS 保证幂等（v1+ v2 连放不炸）。
  {
    version: 2,
    up: async (exec) => {
      await exec('ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "last_synced_at" VARCHAR')
      await exec('ALTER TABLE "sync_gaps" ADD COLUMN IF NOT EXISTS "detail" VARCHAR')
    },
  },
]

// ⚠️ 预留给 E（`db describe <table>` 的列定义展示）消费；C1 无调用方，保留导出（L2）。
export const LATEST_VERSION = MIGRATIONS.reduce((m, x) => Math.max(m, x.version), 0)
