// tests/missing-table-causes.test.ts —— 「声明有而库中无」的成因与对策只许有一处实现
// （2026-10-29）。
//
// 背景：同一事实有四个出口——`db tables` 的 warning、`db describe` 的 warning、
// `query --table` 与 `stats fields` 的 hint。前三个出口写对了（迁移未跑完 → store init
// 可补；迁移完成后表被删 → store init 不会重建，需重建库），只有 `db describe` 独立写成
// 「未同步或未建库」——**两个成因都到不了该分支**（真库实测）：
//   · 已 store init、从未同步的库：25 张声明表全在（row_count=0，无缺表警告）；
//     `sync run` 自身也先调 store.init()；
//   · 库文件不存在或零表：`openGuardedSession` 早已报 store_not_initialized。
// Agent 照旧文案会去「同步一次」——实测对删掉的表只会 Catalog Error，修不好。
//
// 本文件两层守卫：
//   ① 行为层：真 DuckDB 上删表，四个出口必须给出同一份成因与对策（且不得声称「未同步」）；
//   ② 漂移层：成因文案的字符串字面量只许出现在 `src/query/errors.ts` 的
//      MISSING_TABLE_CAUSES——谁再拷贝一份到别处，直接红。
// ⚠️ 边界（诚实记录）：①证明运行时输出，②只是**文本**判据，回答「文案是不是还只有
// 一个实现」，证明不了别处没有语义等价但措辞不同的错误断言。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbCommand } from '../src/commands/db.js'
import { queryCommand } from '../src/commands/query.js'
import { statsCommand } from '../src/commands/stats.js'
import { createDuckDbStore } from '../src/store/duckdb.js'
import { MISSING_TABLE_CAUSES } from '../src/query/errors.js'
import type { Store } from '../src/store/types.js'

// DuckDB 冷启动偶发 >5s（与 tests/commands/db.test.ts 同款放宽）。
vi.setConfig({ testTimeout: 15_000 })

let dir = ''
let out = ''
const dbPath = (): string => join(dir, 'q.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-mtc-'))
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

/** 建库并跑完全部迁移（25 张声明表），不写入任何行、不跑同步。 */
async function initOnly(): Promise<Store> {
  const s = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  await s.init()
  return s
}

describe('缺表成因的行为口径（真 DuckDB）', () => {
  it('「未同步」不产生缺表：只 store init 从未同步，db describe 无缺表警告、row_count=0', async () => {
    const s = await initOnly()
    await s.close()

    expect(await dbCommand(['describe', 'sessions', '--db', dbPath()])).toBe(0)
    const warnings = (meta().warnings ?? []) as string[]
    expect(warnings.join('\n')).not.toMatch(/不存在/)
    expect((JSON.parse(out).data as { row_count: number }).row_count).toBe(0)
  })

  it('表被删后，db tables / db describe / query --table / stats fields 给同一份成因与对策', async () => {
    // 选 daily_overview：stats fields 的闭集只收报表表（sessions 会先被用法校验拒绝）
    const s = await initOnly()
    try { await s.query('DROP TABLE "daily_overview"') } finally { await s.close() }

    const texts: Array<[string, string]> = []

    // ① db tables → meta.warnings
    expect(await dbCommand(['tables', '--db', dbPath()])).toBe(0)
    texts.push(['db tables', ((meta().warnings ?? []) as string[]).join('\n')])

    // ② db describe → meta.warnings
    out = ''
    expect(await dbCommand(['describe', 'daily_overview', '--db', dbPath()])).toBe(0)
    texts.push(['db describe', ((meta().warnings ?? []) as string[]).join('\n')])

    // ③ query --table → error.hint（退出码 1：环境问题，不是用法问题）
    out = ''
    expect(await queryCommand(['--table', 'daily_overview', '--db', dbPath()])).toBe(1)
    texts.push(['query --table', String(errorOf().hint)])

    // ④ stats fields → error.hint
    out = ''
    expect(await statsCommand(['fields', 'daily_overview', '--db', dbPath()])).toBe(1)
    texts.push(['stats fields', String(errorOf().hint)])

    for (const [where, text] of texts) {
      // 四个出口必须逐字共用同一份成因与对策（拷贝漂移在这里暴露）
      expect(text, `${where} 未使用共享的 MISSING_TABLE_CAUSES`).toContain(MISSING_TABLE_CAUSES)
      // 错误成因不得复活：删表与「未同步」无关，Agent 不该被指去跑同步。
      // 用宽判据（只要出现「未同步」就红），防止把「未同步或未建库」改写成
      // 「可能未同步」这类同义复活。
      expect(text, `${where} 仍在声称「未同步」`).not.toMatch(/未同步/)
      // 真正的修复路径必须在场，且必须先备份（重建库是破坏性动作：未声明表与
      // 超出 API 回补窗口的本地历史删了就回不来）
      expect(text, `${where} 缺少「store init 不会重建」的对策`).toContain('store init 不会重建该表')
      expect(text, `${where} 缺少「需重建库」的修复路径`).toContain('需重建库')
      expect(text, `${where} 未要求重建前先备份`).toContain('先备份库文件')
      // 恢复命令必须沿用本次的存储选择：hint 会出现在 `--db <自定义路径>` 的输出里，
      // 只说「运行 qiyu store init」会让 Agent 初始化默认库，选中的库依然缺失
      expect(text, `${where} 未要求沿用本次的 --db/--profile/--backend`).toContain('与本次相同的 --db')
    }
  })
})

describe('缺表成因的漂移守卫（源码文本）', () => {
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

  it('成因与对策的字符串只在 src/query/errors.ts（其余出口必须 import，不得拷贝）', () => {
    const phrases = ['store init 不会重建该表', '需重建库：先备份库文件']
    const offenders: string[] = []
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f)
      const code = stripCommentLines(readFileSync(f, 'utf8'))
      for (const p of phrases) {
        if (code.includes(p) && rel !== join('query', 'errors.ts')) offenders.push(`${rel} 含「${p}」`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('「未同步或未建库」这个错误成因不得再出现在任何输出字符串里（注释除外）', () => {
    // 该短语允许留在注释里（记录本次修正的来龙去脉），但一旦回到字符串字面量
    // 就会重新出现在 Agent 的输出里。
    const offenders = walk(SRC)
      .filter((f) => stripCommentLines(readFileSync(f, 'utf8')).includes('未同步或未建库'))
      .map((f) => relative(SRC, f))
    expect(offenders).toEqual([])
  })

  it('自检：守卫真能抓到拷贝（合成文本）', () => {
    // 防止 stripCommentLines / 短语失配把守卫悄悄变成永远为真
    const bogus = [
      "const hint = '若迁移已完成而表被删或损坏，store init 不会重建该表'",
      "const w = '需重建库：先备份库文件，再删除并重新 qiyu store init、重新同步'",
    ].join('\n')
    expect(stripCommentLines(bogus).includes('store init 不会重建该表')).toBe(true)
    expect(stripCommentLines(bogus).includes('需重建库：先备份库文件')).toBe(true)
    // 注释行必须被抹掉（否则本仓库自己的解释性注释会误报）
    expect(stripCommentLines('// 旧文案「未同步或未建库」').includes('未同步或未建库')).toBe(false)
    expect(stripCommentLines(' * 旧文案「未同步或未建库」').includes('未同步或未建库')).toBe(false)
  })
})
