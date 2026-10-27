// tests/sync-state-legends.test.ts —— sync 三个命令的状态位图例必须有出处（2026-10-27）。
//
// 背景：`sync status` 的 `range_status`、`sync run` 的 `status`、`sync status` 的 `locked`
// 都是 Agent 要**按值分支**的机器值，而此前全仓没有一处给出释义（README 只列字段名）。
// 更糟的是**两个取值的字面与事实相反**（2026-10-27 逐格实测）：
//   · `range_status: "complete"` —— 引擎每个**成功窗**都写它，中窗失败时 run 报 partial
//     而它仍是 complete。按字面读会得出「这段数据完整」，而缺口就在 gaps 里；
//   · `range_status: "pending"` —— 首窗失败时后续成功窗照样落库、只是不推水位，
//     于是 pending 而表里有数据。按字面读会得出「库里没数据」。
// 这两条都是第 11 种形态的变体（**释义的字面与实际不相符**，比没有释义更危险）。
//
// 本文件把**源码枚举**、**生产渲染路径**与 **README 图例**三方锁住，并把两条「字面与
// 事实相反」的断言钉在**真跑出来的输出**上 —— 光读代码看不出引擎在失败窗之后还写 complete。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDuckDbStore } from '../src/store/duckdb.js'
import { runTask } from '../src/sync/engine.js'
import { RateGate } from '../src/sync/rate-gate.js'
import { RANGE_STATUSES } from '../src/sync/state.js'
import { RUN_STATUSES } from '../src/sync/types.js'
import { runFieldNotes, statusFieldNotes, tasksFieldNotes, verifyFieldNotes } from '../src/commands/sync-notes.js'
import { syncCommand } from '../src/commands/sync.js'
import type { SyncTask, RunCtx } from '../src/sync/types.js'
import type { Store, StoreConfig } from '../src/store/types.js'

const DAY = 86_400_000
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')
const ROOT_SRC = read('src/commands/sync-notes.ts')

// 真库冷启动在本机负载高时偶发慢（同 tests/commands/sync.test.ts 的 L1 对冲）。
vi.setConfig({ testTimeout: 30_000 })

let dir = ''
let cfg: StoreConfig
let db = ''
let out = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-rs-legend-'))
  db = join(dir, 'q.db')
  cfg = { backend: 'duckdb', path: db, readOnlyRetryMs: 500, batchSize: 1000 }
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
})
afterEach(() => { vi.restoreAllMocks(); rmSync(dir, { recursive: true, force: true }) })

const parsed = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const data = (): Record<string, unknown> => parsed().data as Record<string, unknown>
const meta = (): Record<string, unknown> => parsed().meta as Record<string, unknown>
const tasks = (): Array<Record<string, unknown>> => data().tasks as Array<Record<string, unknown>>

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(cfg, 'rw')
  await s.init()
  return s
}

function ctx(store: Store, start: number, end: number): RunCtx {
  return { store, credentials: { appKey: 'k', appSecret: 's' }, gate: new RateGate(store, () => 0),
    clock: () => 1_700_000_000_000, rangeOverride: { start, end } }
}

/** 三窗的 windowed 假任务（fetch 由用例注入，第 n 次调用按 n 决定行为）。 */
function threeWindowTask(onFetch: (n: number) => Promise<{ rows: Record<string, unknown>[]; apiCount: number }>): SyncTask {
  let n = 0
  return {
    id: 'reports.overview', table: 'tags', kind: 'windowed', maxWindowDays: 1, overlapDays: 0,
    primaryKey: ['id'], watermark: { field: 'stat_date', initial: null },
    fetch: async () => onFetch(++n),
    write: { kind: 'upsertRows' },
  }
}

const row = (id: string): { rows: Record<string, unknown>[]; apiCount: number } =>
  ({ rows: [{ id, name: 'A', color: '#111111' }], apiCount: 1 })

describe('sync 状态位图例 ↔ 源码枚举 ↔ README（三方双向）', () => {
  it('值域本身非空且无重复（判据不在空集合上恒真）', () => {
    for (const [name, arr] of [['RANGE_STATUSES', RANGE_STATUSES], ['RUN_STATUSES', RUN_STATUSES]] as const) {
      expect(arr.length, name).toBeGreaterThan(0)
      expect(new Set(arr).size, name).toBe(arr.length)
    }
  })

  it('每个取值在它出现的那条命令的 field_notes 里都有释义（枚举 ⊆ 图例）', () => {
    const run = runFieldNotes()['tasks[].status']!
    for (const v of RUN_STATUSES) expect(run, `run status 缺 ${v}`).toContain(`${v} = `)
    const st = statusFieldNotes().range_status!
    for (const v of RANGE_STATUSES) expect(st, `range_status 缺 ${v}`).toContain(`${v} = `)
    // `null` 是第三种真实取值（从未运行），必须也被解释 —— 它不在 RANGE_STATUSES 里
    expect(st, 'range_status 的 null 也必须释义').toContain('null = ')
  })

  it('图例里没有枚举之外的值（图例 ⊆ 枚举）—— 增删任一方向都要红', () => {
    // 反向解析：`a = 释义；b = 释义` 拆回取值集合（与生产渲染同一分隔约定）。
    const keys = (cell: string): string[] => cell.split('；').map((seg) => seg.split(' = ')[0]!.trim())
    expect(keys(runFieldNotes()['tasks[].status']!).sort()).toEqual([...RUN_STATUSES].sort())
    expect(keys(statusFieldNotes().range_status!).sort())
      .toEqual([...RANGE_STATUSES, 'null'].sort())
  })

  it('README 的图例段覆盖全部取值（人读版与输出同一组值）', () => {
    const md = read('README.md')
    const start = md.indexOf('**`range_status` 的取值**')
    expect(start, 'README 缺 range_status 图例段').toBeGreaterThan(-1)
    const legend = md.slice(start, md.indexOf('\n\n', start) === -1 ? undefined : md.indexOf('\n\n', start))
      + md.slice(md.indexOf('| `complete` |', start), md.indexOf('**`drift[].kind` 的全部取值**'))
    for (const v of RANGE_STATUSES) expect(legend, `README 缺 range_status ${v}`).toContain(`\`${v}\``)
    expect(legend).toContain('`null`')
    const runStart = md.indexOf('**`tasks[].status` 的三个取值**')
    expect(runStart, 'README 缺 tasks[].status 图例段').toBeGreaterThan(-1)
    const runLegend = md.slice(runStart, md.indexOf('`sync status` 每任务输出', runStart))
    for (const v of RUN_STATUSES) expect(runLegend, `README 缺 run status ${v}`).toContain(`\`${v}\``)
  })

  it('field_notes 不带 Markdown 加粗（stdout JSON 给 Agent，`**` 是噪声）', () => {
    for (const notes of [runFieldNotes(), statusFieldNotes(), verifyFieldNotes(), tasksFieldNotes()]) {
      for (const [k, v] of Object.entries(notes)) expect(v, k).not.toContain('**')
    }
  })

  it('只解释该输出里真实存在的字段（反向：解释不存在的键 = 让 Agent 去找读不到的字段）', () => {
    // run 输出：{tasks:[…], truncated} —— 任务条目键集来自 taskOut()，比照抄在下面；
    // 改 taskOut 删键时这条会红，逼着图例一起改。
    const TASK_KEYS = ['task', 'status', 'windows', 'rows', 'resolved_range', 'watermark',
      'last_synced_at', 'gaps', 'notes']
    for (const k of Object.keys(runFieldNotes())) {
      if (!k.startsWith('tasks[].')) {
        expect(['truncated'], `run 图例键 ${k} 不在 run 输出里`).toContain(k)
        continue
      }
      const rest = k.slice('tasks[].'.length)
      // windows 是嵌套对象：`tasks[].windows.skipped` 的 rest 是 `windows.skipped`
      expect(TASK_KEYS, `run 图例键 ${k} 不在任务条目里`).toContain(rest.split('.')[0])
    }
    // status 输出：{task, watermark, range_status, last_synced_at, resolved_range, gaps,
    // gaps_count, locked}（gaps 元素的键另算）
    const STATUS_KEYS = ['task', 'watermark', 'range_status', 'last_synced_at', 'resolved_range',
      'gaps', 'gaps_count', 'locked']
    const GAP_KEYS = ['range', 'reason', 'detail', 'recorded_at']
    for (const k of Object.keys(statusFieldNotes())) {
      // 数组元素的路径形态是 `gaps[]`（`gaps` 是数组）；写成 `gaps.` 指的是对象形态。
      const [head, sub] = k.split('.')
      if (sub !== undefined) {
        expect(head, `status 图例键 ${k} 的父字段不在输出里`).toBe('gaps[]')
        expect(GAP_KEYS, `status 图例键 ${k} 不在 gap 条目里`).toContain(sub)
      } else {
        expect(STATUS_KEYS, `status 图例键 ${k} 不在输出里`).toContain(head)
      }
    }
    // verify 输出：{task, local_rows, expected_from_api, state_windows_consistent, drift}
    // （`drift` 是数组 → 元素路径形态是 `drift[]`）
    const VERIFY_KEYS = ['task', 'local_rows', 'expected_from_api', 'state_windows_consistent',
      'drift', 'drift[]']
    for (const k of Object.keys(verifyFieldNotes())) {
      expect(VERIFY_KEYS, `verify 图例键 ${k} 不在输出里`).toContain(k.split('.')[0])
    }
    // tasks 输出：{tasks:[{id, table, kind, watermark{field,initial}, maxWindowDays,
    // overlapDays, primaryKey, sensitive_columns}], unsupported:[{id, unsupported}]}
    const TASK_ITEM_KEYS = ['id', 'table', 'kind', 'watermark', 'maxWindowDays',
      'overlapDays', 'primaryKey', 'sensitive_columns']
    // 顶层图例键（`tasks[].` 前缀之外的）：只有 `unsupported` 是顶层数组
    // （`kind`/`sensitive_columns` 在任务条目里 → 必须写 `tasks[].` 前缀）
    const TOP_KEYS = ['unsupported']
    for (const k of Object.keys(tasksFieldNotes())) {
      if (!k.startsWith('tasks[].')) {
        expect(TOP_KEYS, `tasks 图例键 ${k} 不在输出里`).toContain(k)
        continue
      }
      // `tasks[].watermark.initial`：父字段链必须都能在任务条目里走通
      const path = k.slice('tasks[].'.length).split('.')
      expect(TASK_ITEM_KEYS, `tasks 图例键 ${k} 的第一段不在任务条目里`).toContain(path[0])
      if (path.length > 1) {
        expect(['field', 'initial'], `tasks 图例键 ${k} 的 watermark 子键不对`).toContain(path[1])
      }
    }
  })

  it('图例的「字面与事实相反」警告真的写出来了（这是本轮缺陷的核心）', () => {
    // ⚠️ 只钉「不代表 XX」是不够的 —— 那句话可以是空话。必须钉住**机制**：
    // 为什么 pending 时表里有数据（后续成功窗照常落库、只是不推水位）、
    // 为什么 complete 时可能仍有缺口（每个成功窗都写 complete）。
    // 变异验证：把机制句删掉、只留「不代表库里没有数据」时，这条必须红。
    const rangeNotes = statusFieldNotes().range_status!
    expect(rangeNotes, 'complete 的误读方向必须写出来').toContain('不代表「全窗口成功」')
    expect(rangeNotes, 'complete 的机制必须写出来（每个成功窗都写 complete）')
      .toContain('每个成功窗')
    expect(rangeNotes, 'pending 的误读方向必须写出来').toContain('不代表库里没有数据')
    expect(rangeNotes, 'pending 的机制必须写出来（数据照常落库、只是不推水位）')
      .toContain('照常落库')
    expect(rangeNotes, 'pending 的机制必须写出来（水位没动）').toContain('不推水位')
    expect(runFieldNotes()['tasks[].status'], 'partial 的误读必须写出来')
      .toContain('一行都没落')
    // CodeRabbit（2026-10-27）：空窗也算成功窗，所以「有没有拿到数据」不能用
    // windows.succeeded 回答 —— 必须同时点名 rows.written。
    expect(runFieldNotes()['tasks[].status'], '必须区分「成功窗数」与「落库行数」')
      .toContain('rows.written')
    // CodeRabbit（2026-10-27）：日对齐任务的首残段可能被跳过，resolved_range.start
    // 前缀不会自动前移 —— 说「本轮实际覆盖到的区间」是过度承诺。
    expect(runFieldNotes()['tasks[].resolved_range'], 'start 不是覆盖保证')
      .toContain('不是「已覆盖」的保证')
    expect(runFieldNotes()['tasks[].resolved_range'], '必须指向 windows.skipped')
      .toContain('windows.skipped')
    // CodeRabbit（2026-10-27）：gaps 是历史记录，旧记录的 reason 与新记录相同 ——
    // 「按 reason 判断是否仍缺」是错的，必须改成按 range 对照 + 新鲜度未确认。
    expect(statusFieldNotes().gaps, 'gaps 图例必须说明 reason 区分不出新旧')
      .toContain('区分不出新旧')
    expect(statusFieldNotes().gaps, 'range 只能说明相关，不能确认新鲜度')
      .toContain('只能说明「相关」')
    expect(statusFieldNotes().gaps, '必须点明「没有覆盖核对就不能确认新鲜度」')
      .toContain('不能确认新鲜度')
    expect(statusFieldNotes().locked, 'locked 不是「正在同步中」必须写出来')
      .toContain('不是「正在同步中」')
    expect(statusFieldNotes().locked, 'locked 的机制必须写出来（退避等待 vs store_locked）')
      .toContain('退避等待')
    // CodeRabbit（2026-10-27）：verify 的图例一度写「要判完整性看 drift 与退出码」——
    // 而本文件另一条用例正证明中窗失败的库给 drift: [] + 退出码 0。图例必须自相矛盾地
    // 说「不能用它们当完整性证据」，否则 Agent 会拿本命令的绿灯当数据完整的证明。
    const verifyNotes = verifyFieldNotes().state_windows_consistent!
    expect(verifyNotes, 'verify 的图例不得把 drift/退出码当完整性证据')
      .toContain('不能当完整性证据')
    expect(verifyNotes, '必须给出正确的替代路径（另行核对 gaps 与覆盖范围）')
      .toContain('另行核对')
    // CodeRabbit 第二轮：这句话不能把快照任务也一起否认掉 —— 快照任务有上游行数核对。
    expect(verifyNotes, '必须限定到 windowed，不能否认快照任务的远端核对')
      .toContain('对 windowed 任务')
    expect(verifyNotes, '快照任务的核对路径必须保留').toContain('快照任务则另有上游行数核对')
    // 会话里给 Agent 的主入口（skill 正文）也必须带这两条，不能只在 README
    const p = read('src/skill/qiyu/protocols.md')
    expect(p).toContain('两个取值字面都在撒谎')
    expect(p).toContain('windows.succeeded')
    // CodeRabbit 第二轮：skill 正文同样不能把 verify 说成「只核对状态」而不限 windowed
    expect(p).toContain('对 windowed 任务')
    expect(p).toContain('没有一次覆盖核对就不能确认新鲜度')
  })

  it('源码注释里的「实测」锚点与真跑出来的输出一致（判据不靠人肉记忆）', () => {
    // ⚠️ 这条是防「注释自说自话」：注释声称 `complete` 在中窗失败时仍出现、`pending` 在
    // 有数据时仍出现 —— 两个断言都由下面两条真库用例独立钉住，这里只核对注释没被删掉
    // （删掉注释 = 下一个改引擎的人再也看不到这条反直觉事实）。
    expect(ROOT_SRC).toContain('不代表「全窗口成功」')
    expect(ROOT_SRC).toContain('不代表库里没有数据')
  })
})

describe('两条反直觉事实的真库实测（图例的字面结论靠它成立）', () => {
  it('中窗失败 → run 报 partial、windows.failed=1，而 range_status 仍是 complete', async () => {
    const store = await fresh()
    const t = threeWindowTask(async (n) => {
      if (n === 2) throw new Error('中窗炸')
      return row(String(n))
    })
    const r = await runTask(t, ctx(store, 0, 3 * DAY))
    await store.close()

    // 引擎层：run 如实报 partial
    expect(r.status).toBe('partial')
    expect(r.windows).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0 })

    // 命令层：range_status 仍是 complete —— 这就是「字面与事实相反」的实证
    out = ''
    expect(await syncCommand(['status', 'reports.overview', '--db', db])).toBe(0)
    const tk = tasks()[0]!
    expect(tk.range_status, '中窗失败时 range_status 仍是 complete（图例的根据）').toBe('complete')
    expect(tk.gaps_count).toBe(1)
    expect((tk.gaps as Array<Record<string, unknown>>)[0]!.reason).toBe('fetch_failed')
    // 而图例必须告诉 Agent：判完整性看 gaps，不是 range_status
    expect(meta().field_notes).toBeDefined()
  })

  it('首窗失败、后两窗成功 → range_status 是 pending，但表里确实有数据', async () => {
    const store = await fresh()
    const t = threeWindowTask(async (n) => {
      if (n === 1) throw new Error('首窗炸')
      return row(String(n))
    })
    const r = await runTask(t, ctx(store, 0, 3 * DAY))
    // 引擎层：两个窗成功、数据落了库
    expect(r.windows).toEqual({ total: 3, succeeded: 2, failed: 1, skipped: 0 })
    expect(r.rows.written).toBe(2)
    const rowsInTable = await store.count('tags')
    await store.close()
    expect(rowsInTable, '落库了 2 行 —— 这就是「pending ≠ 库里没数据」的实证').toBe(2)

    out = ''
    await syncCommand(['status', 'reports.overview', '--db', db])
    const tk = tasks()[0]!
    expect(tk.range_status, '水位没推进过 → pending').toBe('pending')
    expect(tk.watermark).toBeNull()
    // 同一次输出里既有 pending 又有 1 条 gap —— 与「表里有数据」并存
    expect(tk.gaps_count).toBe(1)
  })

  it('残留写者章 → locked:true，而 verify 仍报一致（「不是正在同步中」的实证）', async () => {
    const store = await fresh()
    await store.transaction(async (tx) => {
      await tx.upsert('sync_state', [{ dataset: 'reports.overview',
        watermark: '1970-01-02T00:00:00.000Z', range_status: 'complete', last_error: null,
        locked_by: 'pid 999', locked_at: '2026-10-27T00:00:00.000Z',
        last_synced_at: '2026-10-27T00:00:00.000Z', next_allowed_at: null,
        last_rate_limited_at: null, resolved_range_start: '0', resolved_range_end: '86400000' }])
    })
    await store.close()

    // 写进程已退出、章留在库里 —— 本命令照样正常返回（真持锁的话根本打不开库）
    out = ''
    expect(await syncCommand(['status', 'reports.overview', '--db', db])).toBe(0)
    expect(tasks()[0]!.locked, '残留章 → locked:true').toBe(true)

    out = ''
    expect(await syncCommand(['verify', 'reports.overview', '--db', db])).toBe(0)
    const tk = tasks()[0]!
    expect(tk.state_windows_consistent).toBe(true)
    expect(meta().field_notes, 'verify 必须解释「一致 ≠ 数据完整」').toBeDefined()
  })

  it('从未同步过的任务 → range_status 是 null（与 pending 不同：连行都没有）', async () => {
    const store = await fresh()
    await store.close()
    out = ''
    expect(await syncCommand(['status', 'tickets.search', '--db', db])).toBe(0)
    const tk = tasks()[0]!
    expect(tk.range_status).toBeNull()
    expect(tk.watermark).toBeNull()
    expect(tk.locked).toBe(false)
  })
})
