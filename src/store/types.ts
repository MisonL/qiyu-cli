// src/store/types.ts
// ⚠️ 本文件**不得**出现任何 DuckDB 类型（DuckDBInstance / getRowObjectsJson …）——
// C2 接外部后端时只新增 kysely.ts 与 BackendName 成员，不改本文件的方法签名。

export type BackendName = 'duckdb'
export type StoreMode = 'ro' | 'rw'

export interface StoreConfig {
  backend: BackendName
  path: string
  /** 读者拿锁的退避上限（毫秒）。**仅读者使用** —— 写者撞锁不重试（spec §5.2）。 */
  readOnlyRetryMs: number
  /** 多值 INSERT 每批行数。正整数；超限批次由实现二次切批。 */
  batchSize: number
  /** 后端专属配置（C2 的连接串等——承载形态见 C2 spec，§十二.1 仍是开放问题）。
   * C1 忽略。 */
  options?: Record<string, unknown>
}

export interface QueryResult {
  columns: string[]
  /** JSON 安全值：无 BigInt、无 Date 包装对象。 */
  rows: Record<string, unknown>[]
}

/** 事务回调视图：**不含** query/init/close（spec §4.2.6 的防线分层）。 */
export type WriteTx = Omit<Store, 'query' | 'init' | 'close'>

export interface Store {
  /** 幂等建表 + 推进迁移。**仅 rw 模式合法**（ro 上调用 → usage 错误）。 */
  init(): Promise<void>
  /** 表名清单（含元数据表），**按名称排序**。 */
  tables(): Promise<string[]>
  /** 单表行数。返回 number —— BIGINT 聚合经 JSON 层是字符串，实现必须收敛。 */
  count(table: string): Promise<number>
  /**
   * 批量 upsert。**每行必须提供该表完整列集**，同一批次内键集必须一致（否则 usage）。
   * 事务语义：处于活动事务内则加入，否则自开单次事务（整批原子）。
   * 返回实际写入行数。
   */
  upsert(table: string, rows: Record<string, unknown>[]): Promise<number>
  /** 条件删除。where 是可信代码常量（禁外部派生字符串，同 query 红线）；返回删除行数。 */
  delete(table: string, where: string, params?: unknown[]): Promise<number>
  /** 事务：回调内的写操作原子提交，抛异常整体回滚。不得嵌套（→ usage）。 */
  transaction<T>(fn: (tx: WriteTx) => Promise<T>): Promise<T>
  /**
   * 原始查询原语，位置参数用 `?` 占位。**不受白名单保护** —— 只接受可信代码的
   * 字面 SQL；E 的三层沙箱是对外唯一护栏。C1 不通过任何命令暴露它。
   */
  query(sql: string, params?: unknown[]): Promise<QueryResult>
  close(): Promise<void>
}
