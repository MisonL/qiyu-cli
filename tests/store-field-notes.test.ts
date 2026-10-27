// tests/store-field-notes.test.ts —— `store init` / `store status` 的 meta 图例（2026-10-28）。
//
// 背景：这两个命令输出的 `schema_version` 是一个裸数字，`tables` 则是**全库**表清单
// （含内部表），而 `db tables` 只列业务表 —— 三处都容易被 Agent 误读。真库实测：
//   · 新库 `schema_version` = 当前 CLI 的 LATEST_VERSION，要跟它比才有意义；
//   · `store status` 的 `tables` 含 `schema_version` / `sync_state` / `sync_gaps`，
//     而 `db tables` 只列 TABLES 闭集里的业务表，**两边数量不同**；
//   · `config_exists: false` 不代表存储不可用（`--db` 照样工作，init 也不写配置文件）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { storeCommand } from '../src/commands/store.js'
import { dbCommand } from '../src/commands/db.js'
import { storeFieldNotes } from '../src/commands/store-notes.js'
import { LATEST_VERSION, TABLES } from '../src/store/schema.js'

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

vi.setConfig({ testTimeout: 40_000 })

let dir = ''
let out = ''
let err = ''
const dbPath = (): string => join(dir, 'q.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-storenotes-'))
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
  vi.stubEnv('HOME', dir) // 隔离真实 ~
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const parsed = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const data = (): Record<string, unknown> => parsed().data as Record<string, unknown>
const meta = (): Record<string, unknown> => parsed().meta as Record<string, unknown>
const notes = (): Record<string, string> => meta().field_notes as Record<string, string>

async function store(...args: string[]): Promise<number> {
  out = ''; err = ''
  return storeCommand([...args, '--db', dbPath()])
}

describe('图例本身：键集、形态与措辞', () => {
  it('init 与 status 都带 field_notes，且键集 == data 键集（双向）', async () => {
    expect(await store('init')).toBe(0)
    expect(meta().field_notes, 'store init 必须带 field_notes').toBeDefined()
    expect(Object.keys(notes()).sort()).toEqual(Object.keys(storeFieldNotes()).sort())
    const initKeys = Object.keys(data()).sort()

    expect(await store('status')).toBe(0)
    expect(meta().field_notes, 'store status 必须带 field_notes').toBeDefined()
    expect(Object.keys(notes()).sort()).toEqual(Object.keys(storeFieldNotes()).sort())
    expect(Object.keys(data()).sort(), '两个命令的输出形状必须一致').toEqual(initKeys)

    // 双向：图例 ⊆ data，data ⊆ 图例
    expect(Object.keys(storeFieldNotes()).sort()).toEqual(initKeys)
  })

  it('field_notes 不带 `**`、正文不含分隔符 `；`', () => {
    for (const [k, v] of Object.entries(storeFieldNotes())) {
      expect(v, `${k} 含 **`).not.toContain('**')
      expect(v, `${k} 含分隔符 ；`).not.toContain('；')
    }
  })

  it('四处关键措辞都在（内部表 / 形状不同 / 版本对照 / config_exists 不阻断）', () => {
    const n = storeFieldNotes()
    expect(n.tables, 'tables 必须点明含内部表').toContain('含内部表')
    expect(n.tables, '必须点明两个命令的形状不同').toContain('形状随命令不同')
    expect(n.tables, '必须点明与 db tables 是同一组表').toContain('与 db tables 列的是同一组表')
    expect(n.schema_version, 'schema_version 必须给出对照基准').toContain('当前 CLI 是')
    expect(n.config_exists, 'config_exists 必须说明 false 不阻断').toContain('不代表存储不可用')
    expect(n.config_path, 'config_path 必须说明它不是库路径').toContain('不是库路径')
  })

  it('README 同步：store 段点明内部表与版本对照，且不再把 store status 当无 meta 例子', () => {
    const md = read('README.md')
    expect(md, 'README 必须点明 tables 含内部表').toContain('含内部表')
    // README 按行宽折行，短语会被换行切开 —— 压掉空白再比。
    expect(md.replace(/\s+/g, ''), 'README 必须点明两边是同一组表').toContain('两边数量应当一致')
    expect(md, 'store status 已带 meta，不能再当无 meta 的例子')
      .not.toMatch(/无 skill 提示时的 `--version`、`store status`/)
  })
})

describe('真库实测：图例的字面结论靠它成立', () => {
  it('新库的 schema_version == LATEST_VERSION，且图例里写着这个数字', async () => {
    expect(await store('init')).toBe(0)
    expect(data().schema_version).toBe(LATEST_VERSION)
    expect(notes().schema_version, '图例里的版本号必须与常量同步（不能写死旧值）')
      .toContain(`当前 CLI 是 ${LATEST_VERSION}`)
  })

  it('store status 的 tables 含内部表，而 db tables 只列业务表（两边数量不同）', async () => {
    expect(await store('init')).toBe(0)
    out = ''
    expect(await store('status')).toBe(0)
    const storeNames = (data().tables as Array<{ name: string }>).map((t) => t.name)
    for (const internal of ['schema_version', 'sync_state', 'sync_gaps']) {
      expect(storeNames, `store status 必须列出内部表 ${internal}`).toContain(internal)
    }

    out = ''
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)
    const dbNames = (data().tables as Array<{ name: string }>).map((t) => t.name)
    // ⚠️ 实测：db tables 也列内部表（TABLES 闭集里就有），两边是**同一组**表。
    // 我最初以为「db tables 只列业务表、两边数量不同」—— 是错的，被这条断言抓住。
    for (const internal of ['schema_version', 'sync_state', 'sync_gaps']) {
      expect(dbNames, `db tables 同样列内部表 ${internal}`).toContain(internal)
    }
    expect(dbNames.sort(), '两边应当是同一组表').toEqual(storeNames.sort())
    expect(dbNames.length, '两边都等于 TABLES 闭集的长度').toBe(TABLES.length)
  })

  it('config_exists: false 时存储照样可用（本用例本身就是证据）', async () => {
    expect(await store('init')).toBe(0)
    expect(data().config_exists, 'HOME 是空目录 → 没有配置文件').toBe(false)
    expect(await store('status'), '没有配置文件也能 status').toBe(0)
    expect(data().config_exists).toBe(false)
    // path 是库、config_path 是配置，两者不同
    expect(data().path).toBe(dbPath())
    expect(data().config_path).not.toBe(data().path)
  })

  it('store init 的 tables 是表名数组，store status 是 [{name, rows}]（形状不同）', async () => {
    expect(await store('init')).toBe(0)
    const initTables = data().tables as unknown[]
    expect(typeof initTables[0], 'init 给的是字符串').toBe('string')
    out = ''
    expect(await store('status')).toBe(0)
    const statusTables = data().tables as Array<Record<string, unknown>>
    expect(typeof statusTables[0], 'status 给的是对象').toBe('object')
    expect(Object.keys(statusTables[0]!).sort()).toEqual(['name', 'rows'])
  })

  it('tables 的 rows 是真实行数（内部表也在内）', async () => {
    expect(await store('init')).toBe(0)
    out = ''
    expect(await store('status')).toBe(0)
    const byName = new Map((data().tables as Array<{ name: string; rows: number }>)
      .map((t) => [t.name, t.rows]))
    expect(byName.get('schema_version'), '迁移记录表非空').toBeGreaterThan(0)
    expect(byName.get('daily_overview'), '业务表空表为 0').toBe(0)
  })
})
