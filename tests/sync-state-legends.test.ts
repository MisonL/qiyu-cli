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
import { RANGE_STATUSES, advanceWatermark, markPending, readWatermark, recordGap } from '../src/sync/state.js'
import { RUN_STATUSES } from '../src/sync/types.js'
import { RANGE_STATUS_NOTES, RUN_STATUS_NOTES, runFieldNotes, statusFieldNotes, tasksFieldNotes, verifyFieldNotes } from '../src/commands/sync-notes.js'
import { syncCommand } from '../src/commands/sync.js'
import { taskOut } from '../src/commands/sync-run.js'
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
  vi.stubEnv('HOME', dir) // 隔离真实 ~（store 配置解析在 --db 之外仍会读它）
  vi.stubEnv('USERPROFILE', dir) // Windows 的 os.homedir() 读它
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })

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
    const st = statusFieldNotes()['tasks[].range_status']!
    for (const v of RANGE_STATUSES) expect(st, `range_status 缺 ${v}`).toContain(`${v} = `)
    // `null` 是第三种真实取值（从未运行），必须也被解释 —— 它不在 RANGE_STATUSES 里
    expect(st, 'range_status 的 null 也必须释义').toContain('null = ')
  })

  it('图例里没有枚举之外的值（图例 ⊆ 枚举）—— 增删任一方向都要红', () => {
    // 反向解析：`a = 释义；b = 释义` 拆回取值集合（与生产渲染同一分隔约定）。
    const keys = (cell: string): string[] => cell.split('；').map((seg) => seg.split(' = ')[0]!.trim())
    expect(keys(runFieldNotes()['tasks[].status']!).sort()).toEqual([...RUN_STATUSES].sort())
    expect(keys(statusFieldNotes()['tasks[].range_status']!).sort())
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
    // ⚠️ 结束边界必须是**稳的**锚，且找到与否要显式断言（CodeRabbit 2026-10-28）：
    // 此前锚在上文那句「`sync status` 每任务输出」上，而同一 PR 把该句改成了
    // 「`sync status` 的 `data` 是 `{tasks:[…]}`」—— `indexOf` 返回 -1，
    // `slice(runStart, -1)` 把 README 剩下的全文都吞进来，于是 run 表删掉一行
    // 也照样能找到取值（range_status 的表在后面顶着）。锚在下一个**小节标题**上，
    // 并断言 end > runStart，才不会再出现「找不到边界 → 悄悄放宽」。
    const runEnd = md.indexOf('**`range_status` 的取值**', runStart)
    expect(runEnd, 'README 缺 range_status 小节（run 图例的结束边界）').toBeGreaterThan(runStart)
    const runLegend = md.slice(runStart, runEnd)
    for (const v of RUN_STATUSES) expect(runLegend, `README 缺 run status ${v}`).toContain(`\`${v}\``)
  })

  it('枚举释义的**取值**里不得出现分隔符 `；`（否则反向解析产生幽灵取值）', () => {
    // ⚠️ 这条被咬过两次（stats 的 ratio、本文件的 pending）：renderNotes 用 `；` 拼
    // `a = 释义；b = 释义`，释义正文里再出现 `；` 就会把一句话劈成两个「取值」。
    // 只查枚举释义（它们的正文才是取值集合的来源）；其它 field_notes 是单值说明，不受影响。
    for (const [name, notes] of [
      ['RANGE_STATUS_NOTES', RANGE_STATUS_NOTES], ['RUN_STATUS_NOTES', RUN_STATUS_NOTES]] as const) {
      for (const [k, v] of Object.entries(notes)) {
        expect(v, `${name}.${k} 含分隔符 ；—— 会让反向解析多出一个幽灵取值`).not.toContain('；')
      }
    }
  })

  it('field_notes 不带 Markdown 加粗（stdout JSON 给 Agent，`**` 是噪声）', () => {
    for (const notes of [runFieldNotes(), statusFieldNotes(), verifyFieldNotes(), tasksFieldNotes()]) {
      for (const [k, v] of Object.entries(notes)) expect(v, k).not.toContain('**')
    }
  })

  it('只解释该输出里真实存在的字段（反向：解释不存在的键 = 让 Agent 去找读不到的字段）', () => {
    // run 输出：{tasks:[…], truncated}。任务条目的键集**从生产构造函数 `taskOut()` 推导**，
    // 不手抄 —— 手抄清单是假护栏：删掉 taskOut 里的键，手抄的清单不会跟着红（本项目已经
    // 在 TOP_KEYS 上踩过一次）。`windows` 是嵌套对象，`tasks[].windows.skipped` 的第一段
    // 仍是 `windows`，所以只比第一段就够。
    const TASK_KEYS = Object.keys(taskOut(
      { taskId: 't', status: 'complete', windows: { total: 1, succeeded: 1, failed: 0, skipped: 0 },
        rows: { fetched: 0, written: 0 }, resolvedRange: { start: 0, end: 0 }, gaps: [] },
      null, null))
    for (const k of Object.keys(runFieldNotes())) {
      if (!k.startsWith('tasks[].')) {
        expect(['truncated'], `run 图例键 ${k} 不在 run 输出里`).toContain(k)
        continue
      }
      const rest = k.slice('tasks[].'.length)
      // windows 是嵌套对象：`tasks[].windows.skipped` 的 rest 是 `windows.skipped`
      // 数组元素级路径（`tasks[].gaps[].range`）的第一段带 `[]`，先剥掉再比
      expect(TASK_KEYS, `run 图例键 ${k} 不在任务条目里`).toContain(rest.split('.')[0]!.replace(/\[\]$/, ''))
    }
    // status / verify 不在这里核对 —— 这两个命令的 data 是 `{tasks:[…]}`，图例键是
    // 指向输出的**路径**（`tasks[].x`），必须拿**真跑出来的输出**逐条解析（下面的
    // 「图例键在真跑出来的输出上逐条可解析」用例）。手抄字段清单是假护栏：它镜像图例
    // 而不是镜像输出，2026-10-28 之前图例键写成裸字段名（`range_status` / `locked` …）
    // 它照样绿。
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

  it('status / verify 的图例键在真跑出来的输出上逐条可解析（真库，2026-10-28）', async () => {
    // 缺陷实证：这两个命令的 data 是 `{tasks:[…]}`，而图例键此前是裸字段名
    // （`range_status` / `locked` / `gaps[].reason` / `state_windows_consistent` /
    // `drift[].kind` …）—— 按图例路径去 data 里找什么也找不到，图例等于没有。
    // 上面的手抄清单护栏放过了它（它镜像图例而不是镜像输出），所以这条用
    // **真库 + 真命令** 把「图例 ⊆ 输出」钉死：每个键必须能作为路径解析到真实字段。
    const s = await fresh()
    await s.transaction(async (tx) => {
      await advanceWatermark(tx, 'dim.staff', 'w1', { start: 0, end: 1 }, 't1')
      await markPending(tx, 'reports.overview')
      await recordGap(tx, 'reports.overview', '100', '200', 'fetch_failed', '网络抖动', { now: () => 0 })
    })
    await s.close()

    // 路径解析器：`a.b` 逐段下钻；`x[]` 段要求该键是数组并对**任一元素**继续
    //（任务多、缺口/漂移挂在个别任务上，首元素不一定带数据 —— 用 some 才是「路径真实存在」）。
    const hasPath = (root: unknown, path: string): boolean => {
      const segs = path.split('.')
      const walk = (cur: unknown, i: number): boolean => {
        if (i === segs.length) return true
        if (cur === null || typeof cur !== 'object') return false
        const tok = segs[i]!
        const isArr = tok.endsWith('[]')
        const key = isArr ? tok.slice(0, -2) : tok
        if (!(key in (cur as object))) return false
        const next = (cur as Record<string, unknown>)[key]
        if (isArr) {
          if (!Array.isArray(next)) return false
          return next.some((el) => walk(el, i + 1))
        }
        return walk(next, i + 1)
      }
      return walk(root, 0)
    }

    // —— status：dim.staff 已推进（complete），reports.overview 带一条 gap（元素键可核对）
    out = ''
    expect(await syncCommand(['status', '--db', db])).toBe(0)
    for (const k of Object.keys(statusFieldNotes())) {
      expect(hasPath(data(), k), `status 图例键 ${k} 在真实输出上不可解析（输出 data 键：${Object.keys(data()).join('、')}）`).toBe(true)
    }

    // —— verify：reports.overview 是 pending → drift 非空（state_pending），元素键可核对
    out = ''
    expect(await syncCommand(['verify', 'reports.overview', '--db', db]), 'pending 任务 → drift 非空 → 退出码 1').toBe(1)
    for (const k of Object.keys(verifyFieldNotes())) {
      expect(hasPath(data(), k), `verify 图例键 ${k} 在真实输出上不可解析`).toBe(true)
    }
  })

  it('watermark 与 resolved_range 是同一时刻的两种写法 —— 图例必须点破，字符串比较是错的', async () => {
    // 2026-10-28 实测（真库）：同一任务条目里
    //   watermark      = "2025-10-09T08:53:20.000Z"      （UTC Z，引擎写库原样）
    //   resolved_range = ["2025-10-07T16:00:00+08:00", "2025-10-09T16:53:20+08:00"]
    // 两者末端是同一瞬间，但字符串比较给出 "08:53…Z" < "16:53…+08:00" —— 相反结论。
    const s = await fresh()
    const end = Date.UTC(2025, 9, 9, 8, 53, 20)
    await s.transaction(async (tx) => {
      await advanceWatermark(tx, 'dim.staff', new Date(end).toISOString(),
        { start: end - 2 * DAY, end }, new Date(end + 300_000).toISOString())
    })
    await s.close()
    out = ''
    expect(await syncCommand(['status', 'dim.staff', '--db', db])).toBe(0)
    const t = tasks()[0]!
    // 事实：两种写法、同一时刻
    expect(t.watermark, 'watermark 是 UTC Z 形态').toBe('2025-10-09T08:53:20.000Z')
    const rr = t.resolved_range as [string, string]
    expect(rr[1], 'resolved_range 末端是 +08:00 形态').toBe('2025-10-09T16:53:20+08:00')
    expect(new Date(t.watermark as string).getTime(), '两者是同一时刻')
      .toBe(new Date(rr[1]).getTime())
    expect((t.watermark as string) < rr[1], '字符串比较会给出错误结论（这正是图例要警告的）').toBe(true)
    // 图例必须写出来：形态不同 + 不要按字符串比较
    const note = statusFieldNotes()['tasks[].watermark']!
    expect(note, '必须点明 watermark 是 UTC Z 形态').toContain('UTC `Z`')
    expect(note, '必须点明与 resolved_range 写法不同').toContain('写法不同')
    expect(note, '必须警告字符串比较会得相反结论').toContain('字符串比较')
    // last_synced_at 同样要说清与 watermark 是两个量
    const lsNote = statusFieldNotes()['tasks[].last_synced_at']!
    expect(lsNote, 'last_synced_at 必须与 watermark 区分').toContain('两个不同的量')
    // ⚠️ 2026-10-28 真库实测推翻了早前的「失败轮不更新它」：中窗失败（1、3 成，2 败）
    // → run status=partial 而 last_synced_at 已是本轮时钟值（引擎按成功窗推进写它）。
    expect(lsNote, 'last_synced_at 必须说明 partial 轮照样更新').toContain('partial')
    expect(lsNote, '不得再声称「失败轮不更新」—— 对 partial 轮是错的').not.toContain('失败轮不更新')
    // watermark 的共用释义只许点名 resolved_range（两命令同为 +08:00）；
    // gaps[].range 两命令形态不同，由各命令自己的图例承担（CodeRabbit 2026-10-28）。
    expect(note, 'watermark 的共用释义不得声称 gaps[].range 是 +08:00').not.toContain('gaps[].range')
    expect(runFieldNotes()['tasks[].gaps[].range']!, 'run 的缺口区间必须自称 +08:00').toContain('+08:00')
    expect(statusFieldNotes()['tasks[].gaps[].range']!, 'status 的缺口区间必须自称 epoch 毫秒').toContain('epoch 毫秒')
    // run 与 status 共用同一段释义（同一份 sync_state 列，形态必然相同）
    expect(runFieldNotes()['tasks[].watermark'], 'run 与 status 的 watermark 释义同源')
      .toBe(note)
    // sync tasks 的 watermark 是对象（另一个命令里的同名字段形状不同）
    expect(tasksFieldNotes()['tasks[].watermark.field'], '必须点明同名不同形')
      .toContain('形状随命令不同')
    // ⚠️ CodeRabbit 2026-10-28 复核：run/status 的 watermark **可以是 null**（从未成功
    // 推进），描述成「是字符串」会让消费者直接对它做字符串操作。两处都要写明。
    expect(tasksFieldNotes()['tasks[].watermark.field']!, '必须写明 run/status 侧可为 null')
      .toContain('字符串或 null')
    expect(note, 'WATERMARK_NOTE 必须写明 null 的含义').toContain('null = ')
  })

  it('图例的「字面与事实相反」警告真的写出来了（这是本轮缺陷的核心）', () => {
    // ⚠️ 只钉「不代表 XX」是不够的 —— 那句话可以是空话。必须钉住**机制**：
    // 为什么 pending 时表里有数据（后续成功窗照常落库、只是不推水位）、
    // 为什么 complete 时可能仍有缺口（每个成功窗都写 complete）。
    // 变异验证：把机制句删掉、只留「不代表库里没有数据」时，这条必须红。
    const rangeNotes = statusFieldNotes()['tasks[].range_status']!
    expect(rangeNotes, 'complete 的误读方向必须写出来').toContain('不代表「全窗口成功」')
    expect(rangeNotes, 'complete 的机制必须写出来（每个成功窗都写 complete）')
      .toContain('每个成功窗')
    expect(rangeNotes, 'pending 的误读方向必须写出来').toContain('不代表库里没有数据')
    expect(rangeNotes, 'pending 的机制必须写出来（数据照常落库、只是不推水位）')
      .toContain('照常落库')
    expect(rangeNotes, 'pending 的机制必须写出来（水位没动）').toContain('不推水位')
    // CodeRabbit 第四轮：`complete` 那段一度写「判定完整性只能看 gaps」—— 而 skipped > 0
    // 时可能 gaps 为空但仍有未覆盖段。必须要求综合三个判据。
    expect(rangeNotes, 'complete 不得只指向 gaps').toContain('windows.skipped')
    expect(rangeNotes, '必须点明「空 gaps 不等于完整」').toContain('空 gaps')
    expect(rangeNotes, '必须给覆盖范围的判据').toContain('resolved_range')
    // CodeRabbit 第五轮：`pending` 一度被写成「尚未成功推进过水位」—— 而 markPending
    // 每轮开跑都置 pending，「pending + 旧 watermark」可达。这条钉住措辞。
    // 钉**定义句**本身：写成「尚未成功推进过水位」就是错的（上一轮的值还在）。
    expect(rangeNotes, 'pending 的定义必须限定为「最近一次运行」').toContain('最近一次运行没有成功推进水位')
    expect(rangeNotes, 'pending 不得说成「从未同步过」').toContain('不代表「从未同步过」')
    expect(rangeNotes, 'pending 的三种误读都要点名').toContain('三种误读')
    // 同一轮：status 的 resolved_range.start 不是覆盖起点（含被跳过的残段前缀）
    expect(statusFieldNotes()['tasks[].resolved_range'], 'status 的 resolved_range 不得说成「覆盖的区间」')
      .toContain('水位区间')
    expect(statusFieldNotes()['tasks[].resolved_range'], '必须点明 start 含被跳过的前缀')
      .toContain('首残段')
    expect(statusFieldNotes()['tasks[].resolved_range'], '必须指向 sync run 的 windows.skipped')
      .toContain('windows.skipped')
    expect(runFieldNotes()['tasks[].status'], 'partial 的误读必须写出来')
      .toContain('一行都没落')
    // CodeRabbit（2026-10-27）：空窗也算成功窗，所以「有没有拿到数据」不能用
    // windows.succeeded 回答 —— 必须同时点名 rows.written。
    expect(runFieldNotes()['tasks[].status'], '必须区分「成功窗数」与「落库行数」')
      .toContain('rows.written')
    // CodeRabbit 第三轮：`complete` 只表示「没有失败窗」，skipped>0 时也成立 ——
    // 说成「全部窗口成功」会让 Agent 漏掉被跳过的区间。
    expect(runFieldNotes()['tasks[].status'], 'complete 不得说成「全部窗口成功」')
      .toContain('不保证「全部窗口都跑了」')
    expect(runFieldNotes()['tasks[].status'], 'complete 必须指向 windows.skipped')
      .toContain('windows.skipped')
    // 自查（2026-10-27）：`failed` 一度被写成「只有快照任务被本地限频闸门拦下这一条路径」——
    // 引擎里快照有**三条**失败路径（限频闸门 / 上游取数失败 / 落库失败或行数核对不符，
    // engine.ts 的 673 / 691 / 717），`tests/sync/engine.test.ts`「快照失败记 gap」钉着
    // fetch 失败也给 `failed`。只提闸门会让 Agent 把「取数失败」误读成 partial。
    expect(runFieldNotes()['tasks[].status'], 'failed 必须覆盖取数失败，不能只说限频闸门')
      .toContain('上游取数失败')
    expect(runFieldNotes()['tasks[].status'], 'failed 必须覆盖落库失败/行数核对不符')
      .toContain('行数核对不符')
    expect(runFieldNotes()['tasks[].status'], 'failed 必须说明 windowed 不会给出它')
      .toContain('windowed 任务不会给出 failed')
    // CodeRabbit（2026-10-27）：日对齐任务的首残段可能被跳过，resolved_range.start
    // 前缀不会自动前移 —— 说「本轮实际覆盖到的区间」是过度承诺。
    expect(runFieldNotes()['tasks[].resolved_range'], 'start 不是覆盖保证')
      .toContain('不是「已覆盖」的保证')
    expect(runFieldNotes()['tasks[].resolved_range'], '必须指向 windows.skipped')
      .toContain('windows.skipped')
    // CodeRabbit（2026-10-27）：gaps 是历史记录，旧记录的 reason 与新记录相同 ——
    // 「按 reason 判断是否仍缺」是错的，必须改成按 range 对照 + 新鲜度未确认。
    expect(statusFieldNotes()['tasks[].gaps'], 'gaps 图例必须说明 reason 区分不出新旧')
      .toContain('区分不出新旧')
    expect(statusFieldNotes()['tasks[].gaps'], 'range 只能说明相关，不能确认新鲜度')
      .toContain('只能说明「相关」')
    expect(statusFieldNotes()['tasks[].gaps'], '必须点明「没有覆盖核对就不能确认新鲜度」')
      .toContain('不能确认新鲜度')
    expect(statusFieldNotes()['tasks[].locked'], 'locked 不是「正在同步中」必须写出来')
      .toContain('不是「正在同步中」')
    expect(statusFieldNotes()['tasks[].locked'], 'locked 的机制必须写出来（退避等待 vs store_locked）')
      .toContain('退避等待')
    // CodeRabbit（2026-10-27）：verify 的图例一度写「要判完整性看 drift 与退出码」——
    // 而本文件另一条用例正证明中窗失败的库给 drift: [] + 退出码 0。图例必须自相矛盾地
    // 说「不能用它们当完整性证据」，否则 Agent 会拿本命令的绿灯当数据完整的证明。
    const verifyNotes = verifyFieldNotes()['tasks[].state_windows_consistent']!
    expect(verifyNotes, 'verify 的图例不得把 drift/退出码当完整性证据')
      .toContain('不能当完整性证据')
    expect(verifyNotes, '必须给出正确的替代路径（另行核对 gaps 与覆盖范围）')
      .toContain('另行核对')
    // CodeRabbit 第二轮：这句话不能把快照任务也一起否认掉 —— 快照任务有上游行数核对。
    expect(verifyNotes, '必须限定到 windowed，不能否认快照任务的远端核对')
      .toContain('对 windowed 任务')
    expect(verifyNotes, '快照任务的核对路径必须保留').toContain('快照任务则另有上游行数核对')
    // 自查（2026-10-27）：verify 的替代路径一度把 windows.skipped 说成 status 里有的 ——
    // status 与 verify 都不输出它，必须点名去 sync run 找。
    expect(verifyNotes, 'windows.skipped 必须指向 sync run').toContain('sync run 的 windows.skipped')
    // 会话里给 Agent 的主入口（skill 正文）也必须带这两条，不能只在 README
    const p = read('src/skill/qiyu/protocols.md')
    expect(p).toContain('两个取值字面都在撒谎')
    expect(p).toContain('windows.succeeded')
    // CodeRabbit 第二轮：skill 正文同样不能把 verify 说成「只核对状态」而不限 windowed
    expect(p).toContain('对 windowed 任务')
    expect(p).toContain('没有一次覆盖核对就不能确认新鲜度')
    expect(p, 'skill 正文也必须点明空 gaps 不等于完整').toContain('空 `gaps` 不等于完整')
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

  it('日对齐任务 + 残段窗跳过 → skipped > 0 / gaps=[] / status=complete，请求区间仍不全', async () => {
    // CodeRabbit 第四轮：`skipped > 0` 时可能 gaps 为空但仍有未覆盖段 —— 所以「判完整性
    // 只能看 gaps」是错的。这条把那个反例钉在真库上。
    const store = await fresh()
    const reqStart = 12 * 3600_000       // 上海时间中午起点（非日界）
    const reqEnd = reqStart + 2 * DAY
    let n = 0
    const t: SyncTask = {
      id: 'reports.overview', table: 'tags', kind: 'windowed', maxWindowDays: 1,
      overlapDays: 0, windowAlign: 'shanghaiDay',
      primaryKey: ['id'], watermark: { field: 'stat_date', initial: null },
      fetch: async () => { n++; return { rows: [{ id: String(n), name: 'A', color: '#111111' }], apiCount: 1 } },
      write: { kind: 'upsertRows' },
    }
    const ctx: RunCtx = { store, credentials: { appKey: 'k', appSecret: 's' },
      gate: new RateGate(store, () => 0), clock: () => 1_700_000_000_000,
      rangeOverride: { start: reqStart, end: reqEnd } }
    const r = await runTask(t, ctx)
    await store.close()

    // 引擎层：两个残段窗被跳过、只有中间那个整日窗成功
    expect(r.windows).toEqual({ total: 3, succeeded: 1, failed: 0, skipped: 2 })
    expect(r.gaps, '没有失败缺口 —— 这正是「gaps 为空」的来源').toEqual([])
    expect(r.status, '没有失败窗 → complete，尽管一半的窗根本没跑').toBe('complete')

    // 命令层：sync status 看到 gaps=0 且 range_status=complete，但请求区间没被覆盖完
    out = ''
    expect(await syncCommand(['status', 'reports.overview', '--db', db])).toBe(0)
    const tk = tasks()[0]!
    expect(tk.range_status).toBe('complete')
    expect(tk.gaps_count, 'gaps 确实为空').toBe(0)
    // ⚠️ CodeRabbit 第五轮：resolved_range.start **不是**「已覆盖」的起点 ——
    // 实测它等于**请求起点**（含被跳过的首残段前缀），而首个整日窗其实从 16:00Z 才开始。
    // 精确断言（不是 not.toBeNull）—— 这条断言是 status 图例那句「start 是水位起点语义」
    // 的唯一证据。
    const rr = tk.resolved_range as [string, string]
    expect(new Date(rr[0]).getTime(), 'resolved_range.start = 请求起点（含被跳过的前缀）')
      .toBe(reqStart)
    expect(new Date(rr[1]).getTime(), 'resolved_range.end = 最后成功推进处').toBe(144000000)
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

  it('成功一轮后再跑、首窗失败 → range_status 回到 pending 而 watermark 保留上一轮的值', async () => {
    // ⚠️ CodeRabbit 第五轮：`pending` 一度被写成「尚未成功推进过水位」—— 但这个状态
    // 说明它不成立：markPending 每轮开跑就置 pending，所以「pending + 旧 watermark」可达。
    const store = await fresh()
    let n = 0
    const t1 = threeWindowTask(async () => { n++; return row(String(n)) })
    const r1 = await runTask(t1, ctx(store, 0, 3 * DAY))
    expect(r1.status).toBe('complete')
    const afterFirst = await readWatermark(store, 'reports.overview')
    expect(afterFirst.rangeStatus).toBe('complete')
    expect(afterFirst.watermark).toBe('1970-01-04T00:00:00.000Z')

    // 第二轮：换一段区间、首窗失败
    let m = 0
    const t2 = threeWindowTask(async () => {
      m++
      if (m === 1) throw new Error('首窗炸')
      return row('z' + m)
    })
    await runTask(t2, ctx(store, 3 * DAY, 6 * DAY))
    await store.close()

    out = ''
    expect(await syncCommand(['status', 'reports.overview', '--db', db])).toBe(0)
    const tk = tasks()[0]!
    expect(tk.range_status, '新一轮没有成功窗 → 回到 pending').toBe('pending')
    expect(tk.watermark, '但 watermark 保留上一轮的值 —— 所以 pending ≠ 从未同步过')
      .toBe('1970-01-04T00:00:00.000Z')
    expect(tk.last_synced_at, 'last_synced_at 同样保留').not.toBeNull()
  })

  it('中窗失败的 partial 轮照样写 last_synced_at —— 图例的「失败轮不更新」是错的（2026-10-28 实测）', async () => {
    // CodeRabbit 2026-10-28 指出：一轮里某个窗口成功推了水位、另一个窗口失败，
    // 整轮报 partial —— 那一轮**已经更新**了 last_synced_at。图例早前写的是
    // 「失败轮不更新它」，与引擎事实相反（engine.ts commitWindow 在每个带水位写入的
    // 成功窗里调 advanceWatermark，写入的就是 now）。
    // 这条同时钉住第二个细节：last_synced_at 是**末个成功窗**的提交时刻，可能晚于
    // 水位实际前进的时刻（断链后水位冻结在首窗末端，但后续成功窗仍刷新它）。
    const store = await fresh()
    let tick = 1_700_000_000_000
    let n = 0
    const t = threeWindowTask(async () => {
      n++
      tick += 100_000 // 每次 fetch 推进时钟，三个窗的提交时刻各不相同
      if (n === 2) throw new Error('中窗炸')
      return row(String(n))
    })
    const runCtx: RunCtx = { store, credentials: { appKey: 'k', appSecret: 's' },
      gate: new RateGate(store, () => 0), clock: () => tick, rangeOverride: { start: 0, end: 3 * DAY } }
    const r = await runTask(t, runCtx)
    const st = await readWatermark(store, 'reports.overview')
    await store.close()

    expect(r.status, '整轮报 partial').toBe('partial')
    expect(r.windows.succeeded).toBe(2)
    // 水位冻结在首窗末端（DAY）—— 失败窗之后的成功窗不推进水位
    expect(st.watermark, '断链水位冻结在首窗末端').toBe('1970-01-02T00:00:00.000Z')
    // 但 last_synced_at 是末窗（第 3 窗）的提交时刻：第 1 窗 22:15:00Z、第 3 窗 22:18:20Z
    expect(st.lastSyncedAt, 'partial 轮也写了 last_synced_at，且取末个成功窗的时刻')
      .toBe('2023-11-14T22:18:20.000Z')
    expect(new Date(st.lastSyncedAt!).getTime(), '实证：它晚于水位实际前进的时刻')
      .toBeGreaterThan(new Date(st.watermark!).getTime())
    expect(st.rangeStatus, '成功窗把 range_status 也写成 complete').toBe('complete')
    // 图例必须与这条实测一致：不能说「失败轮不更新」，且要点破「可能晚于水位前进」
    const lsNote = statusFieldNotes()['tasks[].last_synced_at']!
    expect(lsNote, '必须点明 partial 轮照样更新').toContain('partial')
    expect(lsNote, '不得再声称「失败轮不更新」').not.toContain('失败轮不更新')
    expect(lsNote, '必须点破「可能晚于水位实际前进的时刻」').toContain('晚于水位实际前进')
  })

  it('gaps[].range 的形态随命令不同：run 是 +08:00 ISO、status 是 epoch 毫秒原样（图例分开说）', async () => {
    // CodeRabbit 2026-10-28：共用释义一度声称「resolved_range / gaps[].range 都是 +08:00」，
    // 而 status 的 gaps[].range 原样回显 sync_gaps 的存储值（毫秒字符串）。这条把
    // 两个命令的真实形态都钉住，防止共用一段话说谎。
    // —— run 侧：生产构造函数 taskOut 把引擎的毫秒串格式化成 +08:00
    const runOut = taskOut({
      taskId: 'reports.overview', status: 'partial',
      windows: { total: 1, succeeded: 0, failed: 1, skipped: 0 },
      rows: { fetched: 0, written: 0 }, resolvedRange: { start: 0, end: DAY },
      gaps: [{ rangeStart: '0', rangeEnd: String(DAY), reason: 'fetch_failed', detail: 'x' }],
    }, null, null)
    const runGap = (runOut.gaps as unknown as Array<{ range: [string, string] }>)[0]!
    expect(runGap.range, 'run 的缺口区间已格式化')
      .toEqual(['1970-01-01T08:00:00+08:00', '1970-01-02T08:00:00+08:00'])

    // —— status 侧：原样回显存储值
    const store = await fresh()
    await store.transaction(async (tx) => {
      await markPending(tx, 'reports.overview')
      await recordGap(tx, 'reports.overview', '0', String(DAY), 'fetch_failed', 'x', { now: () => 0 })
    })
    await store.close()
    out = ''
    expect(await syncCommand(['status', 'reports.overview', '--db', db])).toBe(0)
    const g = (tasks()[0]!.gaps as Array<{ range: [string, string] }>)[0]!
    expect(g.range, 'status 的缺口区间是 epoch 毫秒原样').toEqual(['0', String(DAY)])

    // 图例必须各说各的形态，且共用段不得声称 gaps 是 +08:00
    expect(runFieldNotes()['tasks[].gaps[].range']!, 'run 图例自称 +08:00').toContain('+08:00')
    expect(runFieldNotes()['tasks[].gaps[].range']!, 'run 图例必须点破 status 的同名字段不同形态')
      .toContain('sync status')
    expect(statusFieldNotes()['tasks[].gaps[].range']!, 'status 图例自称 epoch 毫秒').toContain('epoch 毫秒')
    expect(statusFieldNotes()['tasks[].watermark']!, '共用段不得声称 gaps[].range 是 +08:00')
      .not.toContain('gaps[].range')
    // README 的同一段也必须改过来（人读版与图例同一事实；CodeRabbit 2026-10-28 指的正是它）
    const md = read('README.md')
    const paraStart = md.indexOf('`watermark` / `last_synced_at` 是 UTC `Z` 形态')
    expect(paraStart, 'README 缺 watermark / last_synced_at 形态段').toBeGreaterThan(-1)
    const paraEnd = md.indexOf('\n\n', paraStart)
    expect(paraEnd, '段落结束边界').toBeGreaterThan(paraStart)
    const para = md.slice(paraStart, paraEnd)
    expect(para, 'README 不得再声称「失败轮不更新」').not.toContain('失败轮不更新')
    expect(para, 'README 必须点明 partial 轮照样更新').toContain('partial')
    expect(para, 'README 必须点破「可能晚于水位实际前进的时刻」').toContain('晚于水位实际前进')
    expect(para, 'README 必须点破 status 的 gaps[].range 形态不同').toContain('gaps[].range')
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

  it('快照取数失败 → status=failed；windowed 全窗失败 → 只能是 partial（failed 是快照专属）', async () => {
    // 自查（2026-10-27）：图例一度把 `failed` 说成「只有快照任务被本地限频闸门拦下这一条
    // 路径」。引擎里快照有三条 failed 出口（engine.ts 673 闸门 / 691 取数 / 717 落库），
    // 而 windowed 的窗口循环只有 complete/partial 两种出口。这条把两侧边界同时钉住。
    const store = await fresh()
    const snap: SyncTask = {
      id: 'dim.staff', table: 'tags', kind: 'snapshot', maxWindowDays: 31, overlapDays: 0,
      primaryKey: ['id'], watermark: { field: 'stat_date', initial: null },
      fetch: async () => { throw new Error('上游全量炸了') },
      write: { kind: 'upsertRows' },
    }
    const r1 = await runTask(snap, ctx(store, 0, 3 * DAY))
    expect(r1.status, '快照取数失败 → failed（不是 partial）').toBe('failed')
    expect(r1.windows).toEqual({ total: 1, succeeded: 0, failed: 1, skipped: 0 })

    const win = threeWindowTask(async () => { throw new Error('每窗都炸') })
    const r2 = await runTask(win, ctx(store, 0, 3 * DAY))
    expect(r2.status, 'windowed 全窗失败仍是 partial —— failed 是快照专属').toBe('partial')
    expect(r2.windows).toEqual({ total: 3, succeeded: 0, failed: 3, skipped: 0 })
    await store.close()
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
