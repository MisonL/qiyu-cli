// src/commands/sync.ts —— D-T12：sync 命令（当前只有 tasks 子命令；run/status 等后续任务挂载）。
// 骨架沿 store.ts：parseFlags → usageFail/fail 双通道 → thrownToExit 扩展。
import { SYNC_TASKS, UNSUPPORTED_DATASETS } from '../sync/registry.js'
import { ok, usageFail } from '../output.js'

const USAGE = `用法：qiyu sync <子命令> [参数]

子命令：
  sync tasks               列出全部同步任务与不支持的实时快照数据集
`

const KNOWN = new Set(['--help', '-h', '--pretty'])

function parseFlags(argv: string[]): { rest: string[] } {
  const out: { rest: string[] } = { rest: [] }
  for (const a of argv) {
    // 当前 tasks 子命令无带值 flag；出现带值 flag 形态 → 未知参数（留给后续子命令扩展）。
    out.rest.push(a)
  }
  return out
}

export async function syncCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === undefined || sub === '--help' || sub === '-h') {
    const extra = rest.filter((a) => !KNOWN.has(a))
    if (extra.length > 0) return usageFail(`未知参数：${extra.join(' ')}。--help 不接受额外参数`)
    process.stdout.write(USAGE)
    return 0
  }
  if (sub !== 'tasks') {
    if (sub === '--pretty') return usageFail('--pretty 尚未实现 —— 目前只输出紧凑 JSON')
    return usageFail(`未知子命令：${sub}\n可用子命令：tasks`)
  }
  if (rest.includes('--help') || rest.includes('-h')) {
    const rawRest = rest.filter((a) => !KNOWN.has(a))
    if (rawRest.length > 0) return usageFail(`未知参数：${rawRest.join(' ')}`)
    process.stdout.write(USAGE)
    return 0
  }
  if (rest.includes('--pretty')) return usageFail('--pretty 尚未实现 —— 目前只输出紧凑 JSON')

  const flags = parseFlags(rest)
  if (flags.rest.length > 0) return usageFail(`未知参数：${flags.rest.join(' ')}`)

  // tasks：只暴露声明元数据，函数字段（fetch/write/enrich）不进 JSON。
  const tasks = SYNC_TASKS.map((t) => ({
    id: t.id,
    table: t.table,
    kind: t.kind,
    watermark: { field: t.watermark.field, initial: t.watermark.initial },
    maxWindowDays: t.maxWindowDays ?? null,
    overlapDays: t.overlapDays ?? null,
    primaryKey: t.primaryKey,
  }))
  const unsupported = UNSUPPORTED_DATASETS.map((u) => ({ id: u.id, unsupported: u.reason }))
  return ok({ tasks, unsupported })
}
