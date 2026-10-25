// src/commands/local-fallback-wiring.ts
//
// `retry_strategy` / `fallback` 的真实实现（G1 契约小件）：把限流错误里的
// 「改用本地查询」建议接到同步任务注册表与本地库文件上。
//
// ⚠️ 本文件 import `sync/` 与 `store/` —— 只有 `cli.ts`（入口层）允许调用
// `wireLocalFallback()`。`commands/api.ts` 只 import `local-fallback.ts` 的注入槽
// （见那里的分层说明）。
//
// 诚实边界（写进 hint，也写在这里）：
//   · 映射存在 + 库文件存在 **只说明「有表可查」**，不承诺表非空、更不承诺
//     数据覆盖调用方要的时间窗 —— hint 里明确要求先 `db tables` / `sync status` 确认。
//   · 危险接口**不给**建议：调用方要的是写操作，一个本地读的表名帮不上忙，
//     反而可能被误读成「本地也能执行这个操作」。

import { statSync } from 'node:fs'
import { SYNC_TASKS } from '../sync/registry.js'
import { resolveStoreConfig, currentStoreEnv } from '../store/config.js'
import { setLocalFallbackProvider, type LocalFallback } from './local-fallback.js'

/**
 * endpoint id → 该接口同步落地的本地表（按 `SYNC_TASKS` 声明顺序去重）。
 *
 * 同一接口可能对应多张表（`ticket.search` 路径同时服务 `tickets` 与 `ticket_logs`），
 * 首表作为 `fallback` 命令的落点，其余在 hint 里点名 —— 只给一张表而不说还有别的，
 * 调用方会以为本地只有那部分数据。
 *
 * ⚠️ 键取 `task.endpoint ?? task.id`：与限频闸门（`RunCtx.gate` 的注释）同一口径。
 * 未声明 endpoint 的任务回退任务 id —— 那种 id 不是注册表接口 id，映射自然不命中。
 */
export function buildEndpointTableMap(): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const t of SYNC_TASKS) {
    const endpoint = t.endpoint ?? t.id
    const tables = map.get(endpoint) ?? []
    if (!tables.includes(t.table)) tables.push(t.table)
    map.set(endpoint, tables)
  }
  return map
}

const ENDPOINT_TABLES = buildEndpointTableMap()

/**
 * 默认提供者：映射命中且**库文件存在**（`statSync().isFile()`）才返回建议。
 *
 * ⚠️ 只做 `isFile()` 探测，**不打开 DuckDB**：打开库需要 `@duckdb/node-api`，
 * 与「api call 不加载 DuckDB」的启动成本红线冲突；而且文件存在与否正是本建议
 * 唯一能诚实承诺的事（表里有没有数据、覆盖到哪个窗口，见文件头注）。
 * ⚠️ 任何异常（配置文件不是合法 JSON、路径是目录、权限不足）一律视为「不可用」——
 * 探测失败不能改变原始限流错误（`localFallbackFor` 的 catch 是第二道兜底）。
 */
export function localFallbackProvider(endpointId: string): LocalFallback | undefined {
  const tables = ENDPOINT_TABLES.get(endpointId)
  if (!tables || tables.length === 0) return undefined
  try {
    const { config } = resolveStoreConfig({ env: currentStoreEnv() })
    if (!statSync(config.path).isFile()) return undefined
  } catch {
    return undefined
  }
  return { tables }
}

/** cli.ts 启动时调用：把默认提供者装进注入槽。 */
export function wireLocalFallback(): void {
  setLocalFallbackProvider(localFallbackProvider)
}
