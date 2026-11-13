// tests/command-legends-reverse.test.ts —— 「输出里的每个字段都必须有释义」的**反向**兜底，
// 覆盖**每条有图例的命令**，并下沉到**元素层**（2026-11-04，#38 挂账的收口）。
//
// 为什么单独一个文件而不是并入某个命令自己的图例测试：本项目的图例测试大多是**单向**的
// ——「图例里的键必须真实存在」（防止解释一个读不到的字段）。反方向「输出里有这个字段、
// 图例却没解释它」只在少数命令自己的文件里零散查过，且**多数只查顶层键**：
//   · `skill where` 的 `cli_contract_version` 曾裸奔（2026-10-28）；
//   · `db describe.columns[]` 的元素键删掉释义时，只查顶层键的版本全绿（2026-10-28 实测）；
//   · `sync status` 的 `tasks[].gaps[].detail` / `recorded_at`、`sync run` 的
//     `tasks[].windows.total/succeeded/failed`、`tasks[].rows.fetched/written`、
//     `tasks[].notes`、`api schema` 的 `params[]` 元素键、`api list` 的 4 个 meta 键
//     —— 此前**没有任何**反向守卫（2026-11-04 全仓 sweep 实测）。
//
// 本文件对**每条有 `meta.field_notes` 的命令**跑真实输出（需要库的用真 DuckDB 预置），
// 递归断言：data 与 meta 的**每个叶子字段**要么被图例覆盖（`k` / `k.` / `k[]` 三种前缀，
// 支持 `<字段>` 通配段），要么在该命令的**自明清单**里。
//
// ⚠️ 自明清单是**契约**不是垃圾桶：每加一个词就少一分把关（同 skill-field-notes 的注释）。
// 清单只放「字段名即含义、且值不是需要分支的机器枚举」的键。放进去之前问：Agent 会不会
// 误读它？会 → 补释义，别进清单。
import { describe, expect, beforeEach, afterEach, vi } from 'vitest'
import { it, captureSinks } from './helpers/capture.js'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, versionFieldNotes } from '../src/cli.js'
import { skillCommand, whereFieldNotes, installFieldNotes, checkFieldNotes } from '../src/commands/skill.js'
import { authCommand } from '../src/commands/auth.js'
import { apiCommand } from '../src/commands/api.js'
import { dbCommand } from '../src/commands/db.js'
import { queryCommand } from '../src/commands/query.js'
import { statsCommand } from '../src/commands/stats.js'
import { syncCommand } from '../src/commands/sync.js'
import { taskOut } from '../src/commands/sync-run.js'
import { runFieldNotes, statusFieldNotes, verifyFieldNotes, tasksFieldNotes, syncInstallFieldNotes } from '../src/commands/sync-notes.js'
import { createDuckDbStore } from '../src/store/duckdb.js'

vi.setConfig({ testTimeout: 40_000 })

let dir = ''
let out = ''
const dbPath = (): string => join(dir, 'q.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-revlegend-'))
  out = ''
  captureSinks((s) => { out += s }, () => {})
  vi.stubEnv('HOME', dir) // 隔离真实 ~
  vi.stubEnv('USERPROFILE', dir)
  // sync verify / sync run 的入口要求凭证存在（不看有效性）。存根值只为通过前置检查。
  vi.stubEnv('QIYU_APP_KEY', 'k-test')
  vi.stubEnv('QIYU_APP_SECRET', 's-test')
  vi.stubEnv('QIYU_PROFILE', '')
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const parsed = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const data = (): unknown => parsed().data
const meta = (): Record<string, unknown> => (parsed().meta ?? {}) as Record<string, unknown>
const notes = (): Record<string, string> => (meta().field_notes ?? {}) as Record<string, string>

/**
 * 收集 data 的**叶子路径**（不含 field_notes —— 它自身不是被解释的字段）。
 *
 * 数组只取首元素（`x[]`）：同一数组的元素形状相同，取一个即代表。空数组不贡献叶子
 * （没有可解释的元素字段）。元素是标量的数组（如 query 的 `columns`）按**该键本身**
 * 记一个叶子 —— 里面每个字符串不是「字段」。
 *
 * `opaque` 是「里面的键是数据不是契约」的容器（如 query 的 `rows` 是查询结果行，
 * 列名随表而变）：停在那里记一个叶子，不再往下拆。
 */
function leaves(value: unknown, prefix = '', opaque: string[] = []): string[] {
  if (opaque.includes(prefix)) return [prefix]
  if (Array.isArray(value)) {
    const first = value[0]
    if (first === undefined) return []
    if (first === null || typeof first !== 'object') return prefix === '' ? [] : [prefix]
    // 根数组（api list / sync tasks 的 data 是数组）不加 `[]` 前缀：行字段名即图例键。
    return leaves(first, prefix === '' ? '' : `${prefix}[]`, opaque)
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .flatMap(([k, v]) => leaves(v, prefix === '' ? k : `${prefix}.${k}`, opaque))
  }
  return [prefix]
}

/** 图例键的**段**（`.` 与 `[]` 都是分隔；`[]` 先剥掉，`<字段>` 保留为一段）。 */
function segments(path: string): string[] {
  return path.replace(/\[\]/g, '').split('.').filter((s) => s !== '')
}

/**
 * 叶子 `leaf` 是否被图例解释。
 *
 * 「段前缀」匹配：图例键 `tables` 覆盖 `tables[].rows`；`declared.<字段>.unit` 覆盖
 * `declared.assignedRatio.unit`（`<字段>` / `<name>` / `*` 通配**恰好一段**；`[]` 剥掉）。
 *
 * ⚠️ 但段前缀单独用会太松：只要有一条容器粗说明（如 `tasks[].gaps`），它就会盖住漏掉的
 * 元素键（`tasks[].gaps[].detail`）—— 正是「元素层删一个键还有别的键顶着」的假护栏形态。
 * 所以加一条**枚举判据**：一旦某容器下**已经有任一子键释义**（如 `tasks[].gaps[].reason`），
 * 这个容器就被视为「已开始枚举」—— 它的**每一个**子字段都必须有自己的释义，容器粗说明不再兜底。
 *
 * 两条合起来：没开始枚举的容器（如 store status 的 `tables` 只有一条粗说明）可以一段话解释
 * 一整块；一旦开始逐个解释，就必须解释完（db tables 的 `tables[].rows` 存在 → `tables[].name`
 * 也得有）。
 */
function covered(leaf: string, legendKeys: string[]): boolean {
  const ls = segments(leaf)
  const wild = (seg: string, i: number): boolean =>
    seg === ls[i] || seg === '<字段>' || seg === '<name>' || seg === '*'
  const isPrefix = (k: string): boolean => {
    const ns = segments(k)
    return ns.length <= ls.length && ns.every(wild)
  }
  const parent = ls.slice(0, -1)
  // 父容器是否已被「开始枚举」：存在一条图例键恰好比 parent 深一段（即它在该容器下
  // 直接解释了一个子字段）。**只比 parent 的段**（parent.every），不能比 key 的全部段
  // ——否则「多出来的那一子段」永远对不上 parent，判据恒 false（本判据初版就踩过：
  // 于是枚举规则成了死代码，`tasks[].gaps[].detail` 靠容器粗说明兜底蒙混过关）。
  // 顶层（parent 为空）永远按「已枚举」处理 —— 顶层叶子没有更粗的容器可兜底。
  const enumerated = parent.length === 0 || legendKeys.some((k) => {
    const ns = segments(k)
    return ns.length === parent.length + 1 && parent.every((seg, i) =>
      ns[i] === seg || ns[i] === '<字段>' || ns[i] === '<name>' || ns[i] === '*')
  })
  if (enumerated) {
    // 已开始枚举 → 叶子必须自己有释义（段前缀到达叶子这一层）
    return legendKeys.some((k) => isPrefix(k) && segments(k).length >= ls.length)
  }
  // 未枚举 → 容器粗说明即可
  return legendKeys.some(isPrefix)
}

/**
 * 全命令共享、在 README 里集中说明的 meta 键 —— 不进各命令的 field_notes。
 *
 * `warnings` 是所有命令共用的提示通道（README「输出契约」段的 `meta.warnings` 一处说明），
 * 每个命令的 field_notes 再各写一份就是抄 18 遍。`notice` 同理（`db tables` / `db describe`
 * 恒带的 PII 提示，README 一处说明）。允许它们缺席，但**必须**显式列在这里，
 * 而不是靠「图例里没有就跳过」—— 那会让这条反向判据对 meta 全失效。
 */
const GLOBAL_META_KEYS = ['warnings', 'notice']

/** 断言 data 与 meta 的每个叶子都有释义（或在自明清单 / 全局 meta 白名单里）。 */
function assertAllCovered(where: string, selfEvident: string[] = [], opaque: string[] = []): void {
  const keys = Object.keys(notes())
  for (const leaf of leaves(data(), '', opaque)) {
    if (selfEvident.includes(leaf)) continue
    expect(covered(leaf, keys), `${where} 的字段 ${leaf} 没有释义（图例键：${keys.join('、')}）`).toBe(true)
  }
  for (const k of Object.keys(meta())) {
    if (k === 'field_notes' || GLOBAL_META_KEYS.includes(k)) continue
    if (selfEvident.includes(k)) continue
    expect(covered(k, keys), `${where} 的 meta.${k} 没有释义（图例键：${keys.join('、')}）`).toBe(true)
  }
}

/** 跑一条命令并断言返回码，便于在用例里连锁 & 保持 out 干净。 */
async function ok(fn: () => Promise<number>, opts: { code?: number } = {}): Promise<void> {
  out = ''
  const code = await fn()
  expect(code, `命令退出码（输出：${out.slice(0, 300)}）`).toBe(opts.code ?? 0)
}

async function fresh(): Promise<void> {
  const s = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  await s.init(); await s.close()
}

/** 往 daily_overview 塞一行带 payload 的数据（让 query 的 rows / stats 的 observed 非空）。 */
async function seedDailyOverview(): Promise<void> {
  const s = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  await s.upsert('daily_overview', [{
    stat_date: '2026-10-01T00:00:00.000Z',
    payload: JSON.stringify({ sessions: 3, assignedRatio: 0.9 }),
    synchronized_at: '2026-10-02T00:00:00.000Z',
  }])
  await s.close()
}

/** 自明键的**总清单**（跨命令）—— 列出它们本身也是契约：多一个就少一分把关。 */
const SELF_EVIDENT: Record<string, string[]> = {
  // 行字段名即含义：id/title/method 是接口的身份三件套，note 是该行的自由说明文本。
  'api list': ['id', 'title', 'method', 'note'],
  // params[] 元素键的「名字即含义」部分（in/type/required/example 有机器取值，另列释义）。
  'api schema': ['id', 'title', 'method', 'params[].name', 'params[].description', 'params[].example'],
  'db describe': ['table', 'columns[].name'],
  'db tables': ['tables[].name'],
  'store status': ['tables[].name'],
  // 实体/链接的路径与 Agent 名即含义。
  'skill where': ['entity.path', 'links[].path', 'links[].agent'],
  // 路径、版本号、两个布尔「本次是否带了这个 flag」—— 名字即含义。
  'skill install': ['entity_dir', 'source_dir', 'version', 'force', 'no_link', 'links[].agent', 'links[].path'],
  'query': ['columns'],
  'sync tasks': ['tasks[].id', 'tasks[].table', 'tasks[].primaryKey'],
  // `observed[]` 的元素键是契约（固定六个）；`field` 就是这个对象自己的键名，无需释义。
  'stats fields': ['declared.<字段>', 'observed[].field'],
}

/**
 * 「里面的键是数据不是契约」的容器 —— 停在那里记一个叶子，不往下拆。
 *
 * `query --table` 的 `rows` 是查询结果行：列名随被查的表而变（同一个 `rows` 下的键
 * 可以是 `stat_date` 也可以是 `staff_id`），**不可能**给每个写一条图例。它的形状由
 * `data.columns` 描述、列语义由 `db describe` 给 —— 所以它属「数据」不属「输出契约」。
 */
const OPAQUE: Record<string, string[]> = {
  'query': ['rows'],
}

describe.each([
  ['--version', async (): Promise<void> => { await ok(() => run(['--version'])) }],
  ['skill where', async (): Promise<void> => {
    // 先真安装一次，让 `entity.installed` 是被填满的对象（否则它是 null，其元素键
    // `version` / `skill_contract_version` / `compatible` 永远不会被本守卫检查到）。
    // ⚠️ 还要建一个 agent skills 目录：否则 `links` 是空数组，`links[].agent` /
    // `links[].path` / `links[].state` 也永远不被检查（空数组不产生元素叶子）。
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
    await ok(() => skillCommand(['install', '--dir', join(dir, 'sk')]))
    await ok(() => skillCommand(['where', '--dir', join(dir, 'sk')]))
    expect(Object.keys(notes()).sort(), '发出图例须与 whereFieldNotes() 一致')
      .toEqual(Object.keys(whereFieldNotes()).sort())
    expect((data() as { links: unknown[] }).links.length, 'fixture 必须真的产生一条链接，否则 links[] 子键不被检查')
      .toBeGreaterThan(0)
  }],
  ['skill install', async (): Promise<void> => {
    // 同上：dry-run 的 `links[]` 元素键也要有真实元素可查。
    mkdirSync(join(dir, '.claude', 'skills'), { recursive: true })
    await ok(() => skillCommand(['install', '--dir', join(dir, 'sk'), '--dry-run']))
    expect(Object.keys(notes()).sort(), '发出图例须与 installFieldNotes(dry-run) 一致')
      .toEqual(Object.keys(installFieldNotes('dry-run')).sort())
    expect((data() as { links: unknown[] }).links.length, 'fixture 必须真的产生一条链接')
      .toBeGreaterThan(0)
  }],
  ['skill check', async (): Promise<void> => {
    await ok(() => skillCommand(['check']))
    expect(notes()['violations[].rule'], '规则释义必须挂在 violations[].rule 上').toBeTruthy()
  }],
  ['auth whoami', async (): Promise<void> => {
    vi.stubEnv('QIYU_APP_KEY', 'k-test'); vi.stubEnv('QIYU_APP_SECRET', 's-test')
    await ok(() => authCommand(['whoami']))
  }],
  ['auth login', async (): Promise<void> => {
    vi.stubEnv('QIYU_APP_KEY', 'k-test'); vi.stubEnv('QIYU_APP_SECRET', 's-test')
    await ok(() => authCommand(['login']))
  }],
  ['api list', async (): Promise<void> => { await ok(() => apiCommand(['list', '--all'])) }],
  ['api schema', async (): Promise<void> => { await ok(() => apiCommand(['schema', 'ticket.search'])) }],
  ['db tables', async (): Promise<void> => { await fresh(); await ok(() => dbCommand(['tables', '--db', dbPath()])) }],
  ['db describe', async (): Promise<void> => { await fresh(); await ok(() => dbCommand(['describe', 'tickets', '--db', dbPath()])) }],
  ['query', async (): Promise<void> => { await fresh(); await seedDailyOverview(); await ok(() => queryCommand(['--table', 'daily_overview', '--db', dbPath()])) }],
  ['stats fields', async (): Promise<void> => { await fresh(); await seedDailyOverview(); await ok(() => statsCommand(['fields', 'daily_overview', '--db', dbPath()])) }],
  ['store init', async (): Promise<void> => { await ok(() => run(['store', 'init', '--db', dbPath()])) }],
  ['store status', async (): Promise<void> => { await fresh(); await ok(() => run(['store', 'status', '--db', dbPath()])) }],
  ['sync tasks', async (): Promise<void> => { await ok(() => syncCommand(['tasks'])) }],
  ['sync status', async (): Promise<void> => { await fresh(); await ok(() => syncCommand(['status', '--db', dbPath()])) }],
  // verify 在「有漂移」时**正确**退出 1（未同步任务不是通过）—— 本用例只查图例覆盖面。
  ['sync verify', async (): Promise<void> => { await fresh(); await ok(() => syncCommand(['verify', '--db', dbPath()]), { code: 1 }) }],
  ['sync uninstall', async (): Promise<void> => { await ok(() => syncCommand(['uninstall'])) }],
])('%s：data 与 meta 的每个叶子字段都必须被图例覆盖（反向，含元素层）', (label, body) => {
  it('全覆盖', async () => {
    await body()
    assertAllCovered(label as string, SELF_EVIDENT[label as string] ?? [], OPAQUE[label as string] ?? [])
  })
})

describe('两个 data 形状特殊、需生产构造函数或预置数据才有元素键的命令', () => {
  it('sync run：任务条目含 windows/rows/notes 元素键（此前全部裸奔）', () => {
    // ⚠️ `sync run` 要真跑网络，本用例用它的**生产构造函数** `taskOut()` 造出真实形态
    // （与 sync-state-legends.test.ts 同款），再把图例键逐个下沉核对。
    const row = taskOut(
      { taskId: 't', status: 'complete', windows: { total: 1, succeeded: 1, failed: 0, skipped: 0 },
        rows: { fetched: 1, written: 1 }, resolvedRange: { start: 0, end: 86_400_000 },
        gaps: [{ rangeStart: '0', rangeEnd: '86400000', reason: 'fetch_failed', detail: 'x' }] },
      null, null, ['区间早于接口下界'])
    const keys = Object.keys(runFieldNotes())
    const check = (v: unknown, prefix: string): void => {
      if (Array.isArray(v)) { if (v[0] !== undefined) check(v[0], `${prefix}[]`); return }
      if (v !== null && typeof v === 'object') {
        for (const [k, sub] of Object.entries(v as Record<string, unknown>)) {
          check(sub, prefix === '' ? k : `${prefix}.${k}`)
        }
        return
      }
      // 图例键带 `tasks[].` 前缀（data 是 {tasks:[...]}）—— 逐字段核对要在该前缀下比。
      expect(covered(`tasks[].${prefix}`, keys),
        `sync run 的字段 tasks[].${prefix} 没有释义（图例键：${keys.join('、')}）`).toBe(true)
    }
    for (const [k, v] of Object.entries(row)) check(v, k)
  })

  it('sync status：缺口元素含 detail / recorded_at（此前 detail / recorded_at 裸奔）', async () => {
    await fresh()
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    await s.transaction(async (tx) => {
      const st = await import('../src/sync/state.js')
      await st.markPending(tx, 'reports.overview')
      await st.recordGap(tx, 'reports.overview', '100', '200', 'fetch_failed', '网络抖动', { now: () => 0 })
    })
    await s.close()
    await ok(() => syncCommand(['status', '--db', dbPath()]))
    const notes2 = notes()
    const g = (data() as { tasks: Array<{ gaps: Array<Record<string, unknown>> }> }).tasks
      .find((t) => t.gaps.length > 0)!.gaps[0]!
    // 缺口元素上真实存在的每个键都要有释义
    for (const k of Object.keys(g)) {
      expect(Object.keys(notes2).some((n) => n === `tasks[].gaps[].${k}`),
        `sync status 缺口元素键 gaps[].${k} 没有释义`).toBe(true)
    }
    // ⚠️ recorded_at 的**真实形态**是 `new Date(...).toISOString()`（sync/state.ts 的
    // recordGap）—— ISO 8601 UTC `Z` 字符串，不是 epoch 毫秒数（2026-11-04 自查：
    // 初版图例与这里的断言都把形态说反了，测试只查「含毫秒」等于钉住了错误说法）。
    // 两个方向都钉：数据是 ISO 形态 + 图例这么写、且旧的错误说法不得复活。
    expect(g.recorded_at, 'recorded_at 是落库时刻的 ISO 字符串')
      .toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(notes2['tasks[].gaps[].recorded_at'], '图例必须点明 ISO 8601 UTC 形态').toContain('ISO 8601')
    expect(notes2['tasks[].gaps[].recorded_at'], '旧错误说法（epoch 毫秒数）不得复活')
      .not.toContain('epoch 毫秒数')
  })

  it('sync install：四个形态各自只解释该形态真实存在的键（含 commands 元素）', async () => {
    // sync install 需要「至少成功同步过一次」的前置；这里直接核对图例与**元素契约**，
    // 用真实安装输出（uninstall 不需要前置）覆盖 uninstall-dry/real 两形态。
    // ⚠️ `sync uninstall` **没有** `--dry-run` flag（UNINSTALL_FLAGS 只有 `--yes`）：
    // 不带 `--yes` 走的就是 dry-run 输出（sync.ts 的 `if (!yes)` 分支，
    // field_notes=uninstall-dry）；`--yes` 才是真实卸载。所以这里不带参数即 dry-run 形态。
    // 真实卸载会执行 launchctl/schtasks 与删文件，不在用例里跑。
    for (const mode of ['uninstall-dry'] as const) {
      await ok(() => syncCommand(['uninstall']))
      const keys = Object.keys(notes())
      expect(keys.sort(), `${mode} 发出的图例须与 syncInstallFieldNotes('${mode}') 一致`)
        .toEqual(Object.keys(syncInstallFieldNotes(mode)).sort())
      for (const leaf of leaves(data())) {
        expect(covered(leaf, keys), `sync uninstall 的字段 ${leaf} 没有释义`).toBe(true)
      }
    }
  })
})

describe('covered() 判据自身的自检（最小反例，防判据空转/过松）', () => {
  // ⚠️ 每条断言都带一个**只有它能拦住的**反例（memory: 下限断言被别处满足 →
  // 判据必须自带最小反例）。删掉实现里的任一条规则，这里必红。
  it('段前缀覆盖：容器粗说明覆盖子树（未开始枚举时）', () => {
    expect(covered('tables[].rows', ['tables'])).toBe(true)
    expect(covered('entity.installed', ['entity.source', 'entity.installed'])).toBe(true)
  })

  it('开始枚举后容器粗说明**不再**兜底（这条拦住「元素键删了一个还有别的顶着」）', () => {
    // 反例：容器下有 reason/range 两条子释义，detail 却没有 —— 必须判未覆盖。
    expect(covered('tasks[].gaps[].detail',
      ['tasks[].gaps', 'tasks[].gaps[].reason', 'tasks[].gaps[].range'])).toBe(false)
    // 正例：detail 自己也有释义 → 覆盖。
    expect(covered('tasks[].gaps[].detail',
      ['tasks[].gaps', 'tasks[].gaps[].reason', 'tasks[].gaps[].detail'])).toBe(true)
    // 反例：只改了名字（键还在、但对不上叶子）也必须判未覆盖 —— 源码里常见的手误形态。
    expect(covered('tasks[].gaps[].detail',
      ['tasks[].gaps', 'tasks[].gaps[].reason', '_y'])).toBe(false)
  })

  it('顶层叶子没有容器可兜底：必须有它自己的释义', () => {
    expect(covered('truncated', ['truncated'])).toBe(true)
    expect(covered('truncated', ['tasks[].truncated'])).toBe(false)
  })

  it('通配段恰好匹配一段（stats 的 declared.<字段>.unit）', () => {
    expect(covered('declared.assignedRatio.unit', ['declared.<字段>.unit'])).toBe(true)
    // 反例：通配只吃一段，多一层就不该命中。
    expect(covered('declared.a.b.unit', ['declared.<字段>.unit'])).toBe(false)
  })

  it('`[]` 不改变段：数组元素与普通子字段同一套判据', () => {
    expect(covered('links[].agent', ['links[].agent'])).toBe(true)
    expect(covered('links[].agent', ['links[].state'])).toBe(false)
  })
})

describe('图例自身的形态约束（跨全部命令）', () => {
  it('所有图例键与释义都不含那两组会破坏渲染/解析的字符', () => {
    const all = [
      versionFieldNotes(), whereFieldNotes(), installFieldNotes('dry-run'), installFieldNotes('real'),
      checkFieldNotes('package'), checkFieldNotes('compare'), runFieldNotes(), statusFieldNotes(),
      verifyFieldNotes(), tasksFieldNotes(), syncInstallFieldNotes('install-dry'),
      syncInstallFieldNotes('install-real'), syncInstallFieldNotes('uninstall-dry'),
      syncInstallFieldNotes('uninstall-real'),
    ]
    for (const notes of all) {
      for (const [k, v] of Object.entries(notes)) {
        expect(v, `${k} 含 Markdown 加粗（stdout JSON 给 Agent）`).not.toContain('**')
        // ⚠️ 释义是 `meta.field_notes` 的**字符串值**：内部换行会让 Agent/工具在定义
        // 中途断行，读起来像两条不同的说明（CodeRabbit 2026-11-11；实测 `windows.total`
        // 的释义里带过一个源码换行残留）。要断句就写成一句话，别用 `\n` 排版。
        expect(v, `${k} 的释义里含换行符`).not.toMatch(/[\r\n]/)
        // `；` 是 renderNotes 的拼接符；正文里再出现会让反向解析多出幽灵取值。
        // 枚举单元格本身就是 `a = 释义；b = 释义`，豁免（其取值里不得有 `；` 由各自
        // 的枚举测试钉住：sync-state-legends / skill-field-notes / stats / db）。
      }
    }
  })
})
