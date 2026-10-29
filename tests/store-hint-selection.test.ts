// tests/store-hint-selection.test.ts —— 恢复命令必须指向**本次使用的库**（2026-10-30）。
//
// 背景（真库实测，PR #44 CodeRabbit major 的推广）：hint 里写「请先运行：qiyu store init」
// 时，若本次是用 `--db`/`--profile`/环境变量选了非默认库，逐字执行会作用在**默认库**上：
//   · `db describe tickets --db <空库>` → 照 hint 跑 `qiyu store init` → 建出
//     ~/.qiyu/duckdb/qiyu.duckdb，原命令再跑仍报同一句（死循环，实测）；
//   · `sync install --db <未同步库>` → 照 hint 跑 `qiyu sync run` → 同步默认库，
//     install 仍报 sync_not_run。
// 修法：点名的命令一律经 `storeInitCommand` / `syncRunCommand`（output.ts 唯一实现）
// 渲染成带 `--db <本次解析出的绝对路径>` 的完整命令。
//
// 本文件两层守卫：
//   ① 行为层（真 DuckDB）：非默认 --db 上触发每一类 hint，断言恢复命令带本次路径；
//      空库/缺库两类端到端验证「照 hint 做 → 原命令收敛、默认库不被创建」；
//   ② 漂移层（源码文本）：恢复命令 hint 不得再以裸命令出现（必须经共享渲染），
//      附自检（事故原文必须红、修复后的拼接形态必须放过）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbCommand } from '../src/commands/db.js'
import { queryCommand } from '../src/commands/query.js'
import { statsCommand } from '../src/commands/stats.js'
import { storeCommand } from '../src/commands/store.js'
import { syncCommand } from '../src/commands/sync.js'
import { storeInitCommand, syncRunCommand } from '../src/output.js'
import { createDuckDbStore } from '../src/store/duckdb.js'
import { markPending } from '../src/sync/state.js'

// DuckDB 冷启动偶发 >5s（与 tests/commands/db.test.ts 同款放宽）。
vi.setConfig({ testTimeout: 15_000 })

let dir = ''
let out = ''
const dbPath = (name = 'q.db'): string => join(dir, name)
const defaultDbPath = (): string => join(dir, '.qiyu', 'duckdb', 'qiyu.duckdb')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-hint-'))
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('HOME', dir)   // 隔离真实 ~（配置文件与默认库路径都走 HOME）
  vi.stubEnv('USERPROFILE', dir)
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const meta = (): Record<string, unknown> => JSON.parse(out).meta
const errorOf = (): Record<string, unknown> => JSON.parse(out).error

/** 建一个合法的空 DuckDB 文件（零表）。 */
async function emptyDb(path: string): Promise<void> {
  const mod = (await import('@duckdb/node-api')) as unknown as {
    DuckDBInstance: { create: (p: string, o?: unknown) => Promise<{ closeSync: () => void }> }
  }
  ;(await mod.DuckDBInstance.create(path)).closeSync()
}

describe('恢复命令指向本次的库（真 DuckDB）', () => {
  it('空库：六个出口的 store init hint 都带 --db <本次路径>，照做后原命令收敛', async () => {
    const empty = dbPath('empty.db')
    await emptyDb(empty)

    // 六个出口：E 族四命令 + sync status + store status（全部经 statGuard/openGuardedSession/openRo）
    const cases: Array<[string, () => Promise<number>]> = [
      ['db tables', () => dbCommand(['tables', '--db', empty])],
      ['db describe', () => dbCommand(['describe', 'tickets', '--db', empty])],
      ['query --table', () => queryCommand(['--table', 'sessions', '--db', empty])],
      ['stats fields', () => statsCommand(['fields', 'daily_overview', '--db', empty])],
      ['sync status', () => syncCommand(['status', '--db', empty])],
      ['store status', () => storeCommand(['status', '--db', empty])],
    ]
    for (const [name, run] of cases) {
      out = ''
      expect(await run(), name).toBe(1)
      const e = errorOf()
      expect(e.kind, name).toBe('store_not_initialized')
      // 恢复命令必须带本次解析出的绝对路径（不是默认库、不是裸命令）
      expect(String(e.hint), name).toContain(storeInitCommand(empty))
      expect(String(e.hint), name).toContain('--db ' + empty)
    }

    // 照 hint 的命令执行（同一 argv 形态）→ 原命令全部收敛，默认库不被创建
    out = ''
    expect(await storeCommand(['init', '--db', empty])).toBe(0)
    expect(existsSync(defaultDbPath())).toBe(false)
    for (const [name, run] of cases) {
      out = ''
      expect(await run(), name).toBe(0)
    }
  })

  it('缺库（文件不存在）：hint 带本次 --db；照做建在指定路径，默认库不被创建', async () => {
    const missing = dbPath('missing.duckdb')

    out = ''
    expect(await dbCommand(['tables', '--db', missing])).toBe(1)
    expect(String(errorOf().hint)).toContain(storeInitCommand(missing))

    out = ''
    expect(await storeCommand(['init', '--db', missing])).toBe(0)
    expect(existsSync(missing)).toBe(true)
    // 关键回归：裸 `qiyu store init` 会在默认路径建库，把 Agent 送进死循环
    expect(existsSync(defaultDbPath())).toBe(false)

    out = ''
    expect(await dbCommand(['tables', '--db', missing])).toBe(0)
  })

  it('空表：query --table / stats fields 的「先运行 sync run」建议带 --db <本次路径>', async () => {
    const db = dbPath('s.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', db])).toBe(0)

    out = ''
    expect(await queryCommand(['--table', 'sessions', '--db', db])).toBe(0)
    const w1 = (meta().warnings ?? []) as string[]
    expect(w1.some((x) => x.includes(syncRunCommand(db))), w1.join('\n')).toBe(true)
    // 独立于共享渲染器的字面断言：helper 自身漏掉 --db 时这里也会红
    expect(w1.some((x) => x.includes('--db ' + db)), w1.join('\n')).toBe(true)

    out = ''
    expect(await statsCommand(['fields', 'daily_overview', '--db', db])).toBe(0)
    const w2 = (meta().warnings ?? []) as string[]
    expect(w2.some((x) => x.includes(syncRunCommand(db))), w2.join('\n')).toBe(true)
    expect(w2.some((x) => x.includes('--db ' + db)), w2.join('\n')).toBe(true)
  })

  it('路径含空白 / shell 元字符 → 恢复命令用单引号包裹（复制进 shell 不注入）', async () => {
    // 空目录里放一个空库；路径同时含空格与 `; touch` 注入载荷
    const weird = join(dir, 'a b; touch PWNED; #.duckdb')
    await emptyDb(weird)

    out = ''
    expect(await dbCommand(['tables', '--db', weird])).toBe(1)
    const hint = String(errorOf().hint)
    // 单引号包裹后是**一个**参数：`; touch` 不会被 shell 拆成命令
    expect(hint).toContain("--db '" + weird + "'")
    expect(hint).toContain(storeInitCommand(weird))
    // shellArg 自检：安全集内裸渲染、含单引号正确转义
    expect(storeInitCommand('/tmp/q.db')).toContain('--db /tmp/q.db')
    expect(storeInitCommand("/tmp/it's q.db")).toContain("--db '/tmp/it'\\''s q.db'")
  })

  it('--profile 选中的档名随恢复命令回显（sync run 的 robotId 注入面按档读）', async () => {
    // 非默认档 alpha：store.options.knowledgeRobotIds 与 robots 只在 alpha 下可见
    mkdirSync(join(dir, '.config', 'qiyu'), { recursive: true, mode: 0o700 })
    const cfg = join(dir, '.config', 'qiyu', 'config.json')
    writeFileSync(cfg, JSON.stringify({
      profiles: { alpha: { robots: { 2000002: 'B' }, store: { options: { knowledgeRobotIds: [1000001] } } } },
    }))
    const db = dbPath('pf.duckdb')
    out = ''
    expect(await storeCommand(['init', '--profile', 'alpha', '--db', db])).toBe(0)

    // sync install 的 sync_not_run hint：必须回显 --profile alpha
    out = ''
    expect(await syncCommand(['install', '--schedule', '0 2 * * *', '--profile', 'alpha', '--db', db])).toBe(1)
    const hint = String(errorOf().hint)
    expect(hint).toContain(syncRunCommand(db, 'alpha'))
    expect(hint).toContain('--profile alpha')

    // 空表 warning 同源
    out = ''
    expect(await queryCommand(['--table', 'sessions', '--profile', 'alpha', '--db', db])).toBe(0)
    const w = (meta().warnings ?? []) as string[]
    expect(w.some((x) => x.includes('--profile alpha')), w.join('\n')).toBe(true)

    // 反向：未点名档（无 flag/env/defaultProfile）→ 不回显内置 default
    //（显式 --profile default 会触发「点名档必须存在」守卫，profiles 非空且无 default 时反而失败）
    out = ''
    expect(await syncCommand(['install', '--schedule', '0 2 * * *', '--db', db])).toBe(1)
    expect(String(errorOf().hint)).not.toContain('--profile')
  })

  it('sync verify 的 state_pending detail 也带 --db（重跑建议同样不能打偏库）', async () => {
    const db = dbPath('p.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', db])).toBe(0)
    // 预置一行 pending（引擎「开跑先置 pending」的落库形态）→ verify 出 state_pending
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: db, readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.transaction(async (tx) => { await markPending(tx, 'reports.overview') })
    } finally { await s.close() }

    out = ''
    expect(await syncCommand(['verify', 'reports.overview', '--db', db])).toBe(1)
    const tasks = (JSON.parse(out).data as {
      tasks: Array<{ drift: Array<{ kind: string; detail: string }> }>
    }).tasks
    const drift = tasks[0]!.drift.find((d) => d.kind === 'state_pending')
    expect(drift, JSON.stringify(tasks)).toBeDefined()
    expect(drift!.detail).toContain(syncRunCommand(db))
    expect(drift!.detail).toContain('--db ' + db)
  })

  it('sync install 的 sync_not_run hint 与 sync verify 的 not_synced detail 都带 --db', async () => {
    const db = dbPath('i.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', db])).toBe(0)

    // install 前置探测：从未成功同步 → hint 必须指向本次的库
    out = ''
    expect(await syncCommand(['install', '--schedule', '0 2 * * *', '--db', db])).toBe(1)
    const e = errorOf()
    expect(e.kind).toBe('sync_not_run')
    expect(String(e.hint)).toContain(syncRunCommand(db))
    expect(String(e.hint)).toContain('--db ' + db)

    // verify（windowed 任务不请求上游）：drift.not_synced 的 detail 同样指向本次的库
    out = ''
    expect(await syncCommand(['verify', 'reports.overview', '--db', db])).toBe(1)
    const tasks = (JSON.parse(out).data as {
      tasks: Array<{ drift: Array<{ kind: string; detail: string }> }>
    }).tasks
    const drift = tasks[0]!.drift.find((d) => d.kind === 'not_synced')
    expect(drift, JSON.stringify(tasks)).toBeDefined()
    expect(drift!.detail).toContain(syncRunCommand(db))
    expect(drift!.detail).toContain('--db ' + db)
  })
})

describe('恢复命令的漂移守卫（源码文本）', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const SRC = join(ROOT, 'src')
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  /** 抹掉行首整行注释与块注释行（与 `empty-string-single-source.test.ts` 同一约定）。 */
  const stripCommentLines = (text: string): string =>
    text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')

  /**
   * 裸恢复命令 hint 的指纹：动词短语后紧跟命令名，中间只允许冒号/空白/反引号。
   * 经共享渲染的正确形态是 `'…请先运行：' + storeInitCommand(path)` —— 冒号后是引号，
   * 不会命中。
   */
  const BARE_HINT = /(?:运行|重跑|先跑通一次同步)[：:]?\s*`?qiyu (?:store init|sync run)/

  it('源码里不得再出现裸的恢复命令 hint（必须经 storeInitCommand/syncRunCommand 渲染）', () => {
    const offenders: string[] = []
    for (const f of walk(SRC)) {
      const code = stripCommentLines(readFileSync(f, 'utf8'))
      if (BARE_HINT.test(code)) offenders.push(relative(SRC, f))
    }
    expect(offenders).toEqual([])
  })

  it('自检：事故原文必须命中，修复后的拼接形态必须放过', () => {
    // 修复前四处真实文案（原样）
    const incidents = [
      "hint: '数据库尚未初始化。请先运行：qiyu store init',",
      "detail: 'sync_state 无该任务记录（从未同步）。请先运行：qiyu sync run',",
      "warnings.push('该表无数据；先运行 `qiyu sync run`')",
      "hint: '安装调度前请先跑通一次同步：qiyu sync run',",
      "'…一致性——重跑 qiyu sync run 补全后再 verify。'",
    ]
    for (const t of incidents) expect(BARE_HINT.test(t), t).toBe(true)
    // 修复后的形态（共享渲染）必须放过
    const fixed = [
      "hint: '数据库尚未初始化。请先运行：' + storeInitCommand(path),",
      "warnings.push('该表无数据；先运行 `' + syncRunCommand(input.dbPath) + '`')",
      "'…一致性——重跑 ' + syncRunCommand(resolved.path) + ' 补全后再 verify。'",
      "'若为建库未完成（迁移未跑完），运行 ' + storeInitCommand(path) + ' 可补建缺失的迁移；'",
    ]
    for (const t of fixed) expect(BARE_HINT.test(t), t).toBe(false)
  })
})
