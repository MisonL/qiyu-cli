// src/sync/types.ts
// D-T5：同步引擎的任务声明模型（spec §4.1 全形）。
// 任务目录是代码（src/sync/tasks/*.ts，Task 6+ 交付）——实测事实以类型检查守护，
// 不引入 JSON 任务文件的解析层与「声明了但没人读」风险（契约诚实性）。
import type { Range } from './windowing.js'
import type { Credentials } from '../core/credentials.js'
import type { RateGate } from './rate-gate.js'
import type { Store } from '../store/types.js'

/** 事务内写落库视图：引擎的写路径只拿这些原语（不暴露 query/init/close）。 */
export type WriteOps = Pick<Store, 'delete' | 'upsert'>

/** runTask 的结果（spec §七 sync run 输出的任务条目形态）。 */
export interface TaskRunResult {
  taskId: string
  windows: { total: number; succeeded: number; failed: number }
  rows: { fetched: number; written: number }
  resolvedRange: Range
  gaps: GapInfo[]
  status: 'complete' | 'partial' | 'failed'
}

export type { Range }

/** 写策略（spec §4.2）：报表按范围删旧插新；维度/会话/知识库按主键幂等 upsert。 */
export type WriteStrategy =
  | { kind: 'deleteRangeInsert'; rangeColumns: string[] }
  | { kind: 'upsertRows' }

/** fetch 结果：rows 是未 enrich 的原始行；apiCount 是 API 侧声称的行数（配对核对基准）。 */
export interface FetchResult {
  rows: Record<string, unknown>[]
  /** API 侧行数（配对核对基准）；缺省取 enrich 过滤后的应写行数。 */
  apiCount?: number
  /** 引擎可在此窗口记一条 gap（如 order_performance 的 orders:null 筛选失败，spec §5.2）。 */
  gapHint?: { reason: string; detail: string }
}

/** 窗口引用：fetch 的入参（半开区间毫秒时间戳）。 */
export type WindowRef = Range & { index: number; total: number }

/** fetch 上下文：任务拿到的库句柄与凭证（红线 1：fetch 内部经 http.call + normalize）。 */
export interface FetchCtx {
  store: Store
  credentials: { appKey: string; appSecret: string }
}

/** enrich 返回 null 表示该行被正当淘汰（不计入 written 也不算 count_mismatch）。 */
export type EnrichFn = (row: Record<string, unknown>) => Record<string, unknown> | null

/** 同步任务声明（spec §4.1）。 */
export interface SyncTask {
  /** 数据集 id（'reports.overview'、'tag.all'…），sync_state/sync_gaps 的 dataset 主键。 */
  id: string
  /** 目标表（schema.ts TABLES 中的名字）。 */
  table: string
  /** 窗口型（时间切片）| 快照型（全量拉取，全删重插）。 */
  kind: 'windowed' | 'snapshot'
  watermark: { field: string; initial: string | null }
  /** 窗口切分上限天数（windowed 必填；本地预校验依据，spec §九）。 */
  maxWindowDays?: number
  /** 相邻窗口重叠天数（去重依赖 upsert/删除范围语义吸收）。 */
  overlapDays?: number
  /** 红线 1：只能在上游业务键。 */
  primaryKey: string[]
  fetch: (w: WindowRef, ctx: FetchCtx) => Promise<FetchResult>
  write: WriteStrategy
  enrich?: EnrichFn
  /** 报表按天轮转标记（spec §5.2，Task 7 消费；T5 落类型位）。 */
  reportDayRotation?: boolean
}

/** 引擎产出的缺口信息（run 结果里返回，同步落 sync_gaps）。 */
export interface GapInfo {
  rangeStart: string
  rangeEnd: string
  reason: string
  detail: string
}

/** 引擎运行上下文（runTask 的入参）。 */
export interface RunCtx {
  store: Store
  credentials: Credentials
  /** 持久化限频闸门（endpointId 取任务 id）。 */
  gate: RateGate
  /** 注入时钟（毫秒），D 层确定性测试的钉子。 */
  clock: () => number
  /** 进度回调（人读 stderr 的落点，Task 13 接线）。 */
  onProgress?: (line: string) => void
  /** 显式范围覆盖（--full/--since/--until 的合成落点，Task 13 接线）；缺省从水位续跑到 clock 当前。 */
  rangeOverride?: Range
}
