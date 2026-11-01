// tests/store-precheck-single-source.test.ts —— 只读命令的「库前置检查」只许有一处实现
// （2026-10-31，PR #54）。
//
// 背景（起因 × 九个命令逐条对照的 E2E 矩阵实测）：这套检查此前在 `commands/db.ts`、
// `commands/sync.ts`、`commands/store.ts` 里各写了一份，复制出来的已经漂移 ——
// 其中一处是**事实错误**：
//   · `store status --db <FIFO>` / `--db /dev/null` 说「--db 指向的是**目录**而非数据库
//     文件」，而那个路径根本不是目录（`mkfifo`、字符设备实测）；判据是 `!isFile()`
//     （覆盖目录 / FIFO / 设备 / 套接字四种成因），文案却按「目录」一种写死。
//     Agent 会去查「我是不是传了目录」（它没有），而真正要做的只是换个路径。
//   · 同一成因在其余八个命令上是「指向的不是普通文件」—— **同一输入两种说法**。
//   · 「缺 schema_version」同理：`store status` 说「请运行：qiyu store init」，
//     其余命令说「空库（无任何表）。请先运行：…」。
// 形态归属：「同一份解码规则复制到多处 → 同一输入两个结论」。
// 同族前科：`nonEmptyValue` 空串判据（`tests/empty-string-single-source.test.ts`）、
// profile 名解析（PR #41）、打开失败成因（`tests/open-failure-single-source.test.ts`）。
//
// 本文件两层守卫：
//   ① 行为层（真 fs 造前置状态）：同一成因在**所有**读命令上给出逐字相同的说法，
//      且非普通文件的说法与 `stat` 的真实结果一致（目录 ≠ FIFO）；
//   ② 漂移层（源码文本）：前置检查的文案不得再散在别处，附双向自检。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbCommand } from '../src/commands/db.js'
import { queryCommand } from '../src/commands/query.js'
import { statsCommand } from '../src/commands/stats.js'
import { storeCommand } from '../src/commands/store.js'
import { syncCommand } from '../src/commands/sync.js'
import { DIRECTORY_DB_HINT, NON_REGULAR_DB_HINT, statGuard } from '../src/commands/store-precheck.js'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

// DuckDB 冷启动偶发 >5s（与 tests/store-hint-selection.test.ts 同款放宽）：
// 本文件每个用例要连开多个真库，机器高负载下实测单例 >6s。
vi.setConfig({ testTimeout: 30_000 })

let dir = ''
let out = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-precheck-'))
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('HOME', dir)
  vi.stubEnv('USERPROFILE', dir)
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const errorOf = (): Record<string, unknown> => JSON.parse(out).error

/**
 * 所有**到达**库前置检查的只读命令（按 `--db` 参数化同一 argv 形态）。
 * ⚠️ 边界如实记录：`sync verify` 不在此列 —— 它先解析凭证，无凭证时直接 `auth_missing`
 * 返回，**根本到不了**库前置检查（`src/commands/sync.ts` 的调用次序），所以它不是本
 * 规则的消费者；`sync run` 是写命令，走 `storeInitFail` 的兜底，也不在此列。
 */
const READERS: Array<[string, (db: string) => Promise<number>]> = [
  ['store status', (db) => storeCommand(['status', '--db', db])],
  ['db tables', (db) => dbCommand(['tables', '--db', db])],
  ['db describe', (db) => dbCommand(['describe', 'tickets', '--db', db])],
  ['query', (db) => queryCommand(['--sql', 'SELECT 1', '--db', db])],
  ['stats fields', (db) => statsCommand(['fields', 'daily_overview', '--db', db])],
  ['sync status', (db) => syncCommand(['status', '--db', db])],
  ['sync install', (db) => syncCommand(['install', '--schedule', '0 3 * * *', '--db', db])],
]

/** 以指定 `--db` 逐个跑一遍所有读命令，断言全部退出码 1，返回 name → hint。 */
async function hintsFor(dbPath: string): Promise<Record<string, string>> {
  const got: Record<string, string> = {}
  for (const [name, run] of READERS) {
    out = ''
    expect(await run(dbPath), `${name} 应当以退出码 1 失败（前置检查拒绝）`).toBe(1)
    got[name] = String(errorOf().hint)
  }
  return got
}

describe('只读前置检查：同一成因在所有命令上给出同一说法（真 fs）', () => {
  it('目录：所有读命令都说「指向的是目录」（不是笼统的「不是普通文件」）', async () => {
    const got = await hintsFor(dir)
    const uniq = [...new Set(Object.values(got))]
    expect(uniq, '同一成因必须只有一种说法:\n' + JSON.stringify(got, null, 2)).toEqual([DIRECTORY_DB_HINT])
  })

  it('FIFO：所有读命令都说「不是普通文件」，**不得**说「是目录」（那是假话）', async () => {
    if (process.platform === 'win32') return   // mkfifo 不存在
    const fifo = join(dir, 'pipe.duckdb')
    execFileSync('mkfifo', [fifo])
    const got = await hintsFor(fifo)
    const uniq = [...new Set(Object.values(got))]
    expect(uniq, '同一成因必须只有一种说法:\n' + JSON.stringify(got, null, 2)).toEqual([NON_REGULAR_DB_HINT])
    // ⚠️ 这条是本轮修的那个缺陷本身：FIFO **不是目录**，说「是目录」会把 Agent
    // 引向「我是不是传了目录」（它没有），而真正要做的只是换个路径。
    for (const [name, hint] of Object.entries(got)) {
      expect(hint, `${name} 对 FIFO 说了「是目录」`).not.toContain('是目录')
    }
  })

  it('字符设备：同上（/dev/null 是最容易被误传的「文件」）', async () => {
    if (process.platform === 'win32') return
    const got = await hintsFor('/dev/null')
    const uniq = [...new Set(Object.values(got))]
    expect(uniq).toEqual([NON_REGULAR_DB_HINT])
  })

  it('权限不足（父目录 000）：所有读命令同一说法，且指向权限而非「未初始化」', async () => {
    if (process.platform === 'win32') return
    if (process.getuid?.() === 0) return   // root 下 chmod 不拦
    const locked = join(dir, 'locked')
    mkdirSync(locked)
    writeFileSync(join(locked, 'q.duckdb'), 'x')
    execFileSync('chmod', ['000', locked])
    try {
      const got = await hintsFor(join(locked, 'q.duckdb'))
      const uniq = [...new Set(Object.values(got))]
      expect(uniq.length, JSON.stringify(got, null, 2)).toBe(1)
      expect(uniq[0]).toContain('权限')
      // 权限问题不得被说成「未初始化」——那会把 Agent 引向 store init（对权限必然再失败）
      expect(uniq[0], '权限成因不得引导向 store init').not.toContain('store init')
    } finally { execFileSync('chmod', ['755', locked]) }
  })

  it('缺库：所有读命令同一说法，且恢复命令带本次 --db（不是裸命令）', async () => {
    const missing = join(dir, 'nope.duckdb')
    const got = await hintsFor(missing)
    const uniq = [...new Set(Object.values(got))]
    expect(uniq.length, JSON.stringify(got, null, 2)).toBe(1)
    expect(uniq[0]).toContain('store init --db ' + missing)
  })
})

describe('库结构校验（缺 schema_version）：同一成因同一说法', () => {
  /** 造一个合法 DuckDB 文件（零表）；foreign=true 时建一张别家的表。 */
  async function makeDb(path: string, foreign: boolean): Promise<void> {
    const mod = (await import('@duckdb/node-api')) as unknown as {
      DuckDBInstance: { create: (p: string) => Promise<{ connect: () => Promise<{ run: (s: string) => Promise<unknown> }>; closeSync: () => void }> }
    }
    const inst = await mod.DuckDBInstance.create(path)
    if (foreign) { const c = await inst.connect(); await c.run('CREATE TABLE someone_else (a INT)') }
    inst.closeSync()
  }

  it('空库（零表）：「空库（无任何表）。请先运行：qiyu store init --db …」——store status 不再说成裸「请运行」', async () => {
    const p = join(dir, 'empty.duckdb')
    await makeDb(p, false)
    const got = await hintsFor(p)
    const uniq = [...new Set(Object.values(got))]
    expect(uniq.length, JSON.stringify(got, null, 2)).toBe(1)
    expect(uniq[0]).toContain('空库（无任何表）')
    expect(uniq[0]).toContain('store init --db ' + p)
  })

  it('他人库（有表无 schema_version）：「不是本 CLI 创建的，请换 --db 路径」且**不**引导向 store init', async () => {
    const p = join(dir, 'foreign.duckdb')
    await makeDb(p, true)
    const got = await hintsFor(p)
    const uniq = [...new Set(Object.values(got))]
    expect(uniq.length, JSON.stringify(got, null, 2)).toBe(1)
    expect(uniq[0]).toBe('目标数据库不是本 CLI 创建的，请换 --db 路径')
    // store init 对他人库会再次拒绝（duckdb.ts 的他人库防线）→ 引导过去是死循环
    for (const [name, hint] of Object.entries(got)) {
      expect(hint, `${name} 把他人库引导向 store init`).not.toContain('store init')
    }
  })
})

describe('单一实现点（漂移守卫）', () => {
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  const stripCommentLines = (text: string): string =>
    text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')

  /** 唯一实现点（相对 ROOT）。 */
  const SINGLE_SOURCE = join('src', 'commands', 'store-precheck.ts')

  /**
   * 前置检查的**文案判据**指纹 —— 这些字符串必须只有一处产地。
   * ⚠️ 指纹钉在**面向 Agent 的文案**上（不是函数名）：复制判据的人不会复制函数名，
   * 他会复制那段字符串。
   */
  const FINGERPRINTS: Array<[string, RegExp]> = [
    ['缺库 message', /数据库文件不存在：/],
    ['权限 hint', /请检查路径权限（只读命令不需要写权限）/],
    ['目录 hint', /--db 指向的是目录而非数据库文件/],
    ['非普通文件 hint', /--db 指向的不是普通文件/],
    ['结构不完整 message', /数据库结构不完整（缺表）：/],
    // ⚠️ 这条指纹必须**同时**覆盖两种历史写法：正确的「空库（无任何表）。请先运行：」与
    // `store status` 漂移出去的裸「请运行：」（少了成因说明）。只钉前者的话，
    // 把裸写法写回去会让守卫保持绿 —— 那正是本轮修的那个漂移。
    ['store init 恢复命令 hint', /请(?:先)?运行：' \+ storeInitCommand\(/],
  ]

  function scanText(text: string): Array<{ line: number; why: string; snippet: string }> {
    const lines = stripCommentLines(text).split('\n')
    const hits: Array<{ line: number; why: string; snippet: string }> = []
    for (let i = 0; i < lines.length; i++) {
      const why = FINGERPRINTS.find(([, re]) => re.test(lines[i]!))?.[0]
      if (why !== undefined) hits.push({ line: i + 1, why, snippet: lines[i]!.trim().slice(0, 120) })
    }
    return hits
  }

  it('除 store-precheck.ts 外，全仓不得再出现前置检查的文案', () => {
    const hits = walk(SRC)
      .filter((f) => relative(ROOT, f) !== SINGLE_SOURCE)
      .flatMap((f) => scanText(readFileSync(f, 'utf8')).map((h) => ({ file: relative(ROOT, f), ...h })))
    const rendered = hits.map((h) => `${h.file}:${h.line}  [${h.why}]  ${h.snippet}`)
    expect(
      rendered,
      '这些地方在复制「库前置检查」的文案 —— 请改用 src/commands/store-precheck.ts 的'
      + ' statGuard() / schemaVersionMissing()（同一份判据复制到多处，会让同一成因在不同命令上'
      + '给出互相矛盾、乃至事实错误的说法）:\n' + rendered.join('\n'),
    ).toEqual([])
  })

  it('唯一实现点确实在场（防「扫描器扫了个空」——文件被改名/搬走后这条仍须红）', () => {
    const text = readFileSync(join(ROOT, SINGLE_SOURCE), 'utf8')
    const missing = FINGERPRINTS.map(([why]) => why)
      .filter((why) => !scanText(text).some((h) => h.why === why))
    expect(missing, `${SINGLE_SOURCE} 缺这些文案（扫描器等于没守任何东西）`).toEqual([])
    expect(text).toMatch(/export function statGuard/)
    expect(text).toMatch(/export function schemaVersionMissing/)
  })

  it('扫描器自身有牙：三个文件里各自那段真实拷贝必须被抓到，合法写法必须放过', () => {
    // ⚠️ 没有这一条，上面的断言可能是「扫了个空」—— 正则退化成永不命中会恒绿。
    const cases: Array<[string, string, number]> = [
      // 事故原文：三份拷贝各自的指纹（逐字取自 2026-10-31 收敛前的源码）
      ['旧 db.ts 权限 hint', "      hint: '请检查路径权限（只读命令不需要写权限）',", 1],
      ['旧 db.ts 非普通文件 hint', "      hint: '--db 指向的不是普通文件，请给出 .duckdb 数据库文件路径',", 1],
      ['旧 store.ts 目录 hint', "      hint: '--db 指向的是目录而非数据库文件，请给出 .duckdb 数据库文件路径' })", 1],
      ['旧 store.ts 空库 hint', "        hint: names.length > 0 ? '目标数据库不是本 CLI 创建的，请换 --db 路径' : '请运行：' + storeInitCommand(config.path) })", 1],
      ['旧缺库 message', "        message: `数据库文件不存在：${path}`,", 1],
      // 合法：调用共享实现
      ['合法 调用 statGuard', "  const guarded = statGuard(resolved.path)", 0],
      ['合法 用 schemaVersionMissing', "    const missing = schemaVersionMissing(config.path, names)", 0],
      ['合法 取用共享文案常量', "      message: `不是普通文件：${config.path}`, hint: nonRegularFileHint(true) })", 0],
      // 合法：`store init` 自己那条**权限** hint 是另一条规则（父目录无执行权限/链接循环）
      ['合法 init 权限 hint', "          hint: '请检查路径权限（父目录无执行权限/链接循环/路径过长都会导致无法访问）' })", 0],
      // 合法：与前置检查无关的其它「不存在」文案
      ['合法 其它不存在', "    message: `表 ${t} 不存在：${name}`,", 0],
    ]
    for (const [label, text, want] of cases) {
      expect(scanText(text).length, `${label}：${text}`).toBe(want)
    }
    // 注释里的反例不得算违规（各文件大量引用旧写法做说明）
    expect(scanText("// 旧写法：'请检查路径权限（只读命令不需要写权限）'\nconst a = 1").length,
      '注释里的反例被当成了实现').toBe(0)
  })

  it('判据只按 `stat` 的实际结果分形：`nonRegularFileHint` 是两条文案的唯一选择点', async () => {
    // 结构断言：目录与非目录必须落到**不同**文案上。合并成一条即本轮修的缺陷复发
    // （FIFO 会说「是目录」）。
    expect(DIRECTORY_DB_HINT).not.toBe(NON_REGULAR_DB_HINT)
    const src = readFileSync(join(ROOT, SINGLE_SOURCE), 'utf8')
    expect(src, '`nonRegularFileHint` 必须真的按 isDirectory 分形')
      .toMatch(/return isDirectory \? DIRECTORY_DB_HINT : NON_REGULAR_DB_HINT/)
  })
})
