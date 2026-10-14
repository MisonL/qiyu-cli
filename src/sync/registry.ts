// src/sync/registry.ts —— D-T12：任务注册表。
// 五组任务数组的唯一汇总点（D-T6~T11 各自交付的数组在此汇合）；
// 实时快照（realtime.session / realtime.ipcc）不在同步范围：数据随推随逝、
// 无可回放的水位，作为 unsupported 条目在 `sync tasks` 里显式声明（契约诚实性：
// 「不支持」要被说出来，不能靠「查不到」暗示）。
import type { SyncTask } from './types.js'
import { DIM_TASKS } from './tasks/dim.js'
import { REPORT_TASKS } from './tasks/reports.js'
import { TICKET_TASKS } from './tasks/tickets.js'
import { SESSIONS_TASKS } from './tasks/sessions.js'
import { KNOWLEDGE_TASKS } from './tasks/knowledge.js'

/** 全量同步任务注册表：dim 6 + reports 9 + tickets 2 + sessions 1 + knowledge 3 = 21。 */
export const SYNC_TASKS: SyncTask[] = [
  ...DIM_TASKS,
  ...REPORT_TASKS,
  ...TICKET_TASKS,
  ...SESSIONS_TASKS,
  ...KNOWLEDGE_TASKS,
]

/** 按 id 取任务（sync run <id> 的分派入口）。 */
export function taskById(id: string): SyncTask | undefined {
  return SYNC_TASKS.find((t) => t.id === id)
}

/** 明确不支持同步的数据集及原因（reason 目前只有 realtime：实时快照不可回放）。 */
export const UNSUPPORTED_DATASETS: Array<{ id: string; reason: string }> = [
  { id: 'realtime.session', reason: 'realtime' },
  { id: 'realtime.ipcc', reason: 'realtime' },
]
