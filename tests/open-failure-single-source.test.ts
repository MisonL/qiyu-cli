// tests/open-failure-single-source.test.ts —— 「打开库文件失败」的成因判据只许有一处实现
// （2026-10-31，PR #53）。
//
// 背景（本轮实测：同一份解码规则复制到两处 → 同一输入两个结论）：
// `chmod 000` 的库文件，`store status` 说「请检查路径与所在目录的读写权限」，
// 而 `query` / `db tables` / `stats fields` 说「请确认数据库文件存在且由本 CLI 创建
// （`qiyu store init …`）」—— **同一成因、两个命令族、两种说法**，后者还把 Agent 引向
// 一个对权限问题必然再失败的命令。三处各写各的判据（`commands/store.ts`、
// `query/sandbox.ts`、`commands/sync-run.ts`）是根因；`store/retry.ts` 的
// `classifyOpenFailure` 是收敛后的**唯一实现点**。
//
// 同族前科（本仓库已记录）：同一份「空串 = 未设置」判据散在五处 → `nonEmptyValue`
// 收敛（`tests/empty-string-single-source.test.ts`）；同一份 profile 名解析散在两处 →
// PR #41。本文件守第三种。
//
// ⚠️ 边界（诚实记录）：这是**文本**判据，证明不了运行时行为（那是
// `tests/store/retry.test.ts` / `tests/commands/store.test.ts` /
// `tests/commands/query.test.ts` 的用例负责的）。它只回答一个问题：
// 「打开失败的成因判据是不是还只有一个实现」。
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

/** 抹掉行首整行注释与块注释行（与 `profile-name-single-source.test.ts` 同一约定）。 */
const stripCommentLines = (text: string): string =>
  text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')

/**
 * 「打开失败成因」判据的指纹 —— 都是 **DuckDB 原生报文**的片段（不是 Node `fs` 的
 * `EACCES: …` 前缀；见 `store/retry.ts` 的形态说明）。
 *
 * 为什么用这些片段而不是 `classifyOpenFailure` 的函数名：**复制判据的人不会复制函数名**，
 * 他会复制那段正则。判据的载体是**正则/子串本身**，所以指纹必须钉在它上面。
 */
const PREDICATES: Array<[string, RegExp]> = [
  ['权限 strerror 判据', /Permission denied|Operation not permitted|Read-only file system/],
  ['非 DuckDB 文件判据', /not a valid DuckDB database/i],
]

/** 唯一实现点（相对 ROOT）。 */
const SINGLE_SOURCE = join('src', 'store', 'retry.ts')

function scanText(text: string): Array<{ line: number; why: string; snippet: string }> {
  const lines = stripCommentLines(text).split('\n')
  const hits: Array<{ line: number; why: string; snippet: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const why = PREDICATES.find(([, re]) => re.test(line))?.[0]
    if (why !== undefined) hits.push({ line: i + 1, why, snippet: line.trim().slice(0, 120) })
  }
  return hits
}

describe('打开失败的成因判据必须只有一处实现（classifyOpenFailure）', () => {
  it('除 store/retry.ts 外，全仓不得再出现权限 / 非 DuckDB 文件的判据', () => {
    const hits = walk(SRC)
      .filter((f) => relative(ROOT, f) !== SINGLE_SOURCE)
      .flatMap((f) => scanText(readFileSync(f, 'utf8')).map((h) => ({ file: relative(ROOT, f), ...h })))
    const rendered = hits.map((h) => `${h.file}:${h.line}  [${h.why}]  ${h.snippet}`)
    expect(
      rendered,
      '这些地方在复制「打开失败」的成因判据 —— 请改用 src/store/retry.ts 的'
      + ' classifyOpenFailure()（同一份解码规则复制到多处，会让同一成因在不同命令上'
      + '给出互相矛盾的说法）:\n' + rendered.join('\n'),
    ).toEqual([])
  })

  it('唯一实现点确实在场（防「扫描器扫了个空」——文件被改名/搬走后这条仍须红）', () => {
    const text = readFileSync(join(ROOT, SINGLE_SOURCE), 'utf8')
    const rendered = PREDICATES.map(([why]) => why)
      .filter((why) => !scanText(text).some((h) => h.why === why))
    expect(rendered, `${SINGLE_SOURCE} 缺这些判据（扫描器等于没守任何东西）`).toEqual([])
    expect(text).toMatch(/export function classifyOpenFailure/)
  })

  it('扫描器自身有牙：真实事故的原样文本必须被抓到，合法写法必须放过', () => {
    // ⚠️ 没有这一条，上面的断言可能是「扫了个空」—— 正则退化成永不命中会恒绿。
    const cases: Array<[string, string, number]> = [
      // 事故 1：`commands/store.ts` 里那条**从未执行过**的前缀判据（PR #52 修的那个）
      ['旧前缀判据', "  if (/^(EACCES|EPERM|EROFS)/.test(msg)) {", 0],
      // 事故 2：子串搜索权限文本（CodeRabbit round 1 抓到的误命中形态）
      ['旧子串判据', "  if (/Permission denied|Operation not permitted|Read-only file system/.test(msg)) {", 1],
      // 事故 3：`sync-run.ts` 自己写的那份「非 DuckDB 文件」子串判据
      ['旧 not-duckdb 判据', "  if (/not a valid DuckDB database/i.test(msg)) {", 1],
      // 合法：调用唯一实现
      ['合法 调用', "  const f = classifyOpenFailure(e)", 0],
      ['合法 用结果', "  if (classifyOpenFailure(e)?.cause === 'permission') {", 0],
      // 合法：Node `fs` 的 errno 判据是**另一件事**（它真有 `e.code`，不归本规则管）
      ['合法 fs errno', "    if ((e as { code?: string }).code === 'EACCES') {", 0],
      // 合法：非权限的 DuckDB 报文（库不存在）本就不该被抓
      ['合法 库不存在', "  /cannot open database .* in read-only mode/i.test(msg)", 0],
    ]
    for (const [label, text, want] of cases) {
      expect(scanText(text).length, `${label}：${text}`).toBe(want)
    }
    // 注释里的反例不得算违规（各文件大量引用旧写法做说明）
    expect(scanText("// 旧写法：/Permission denied|Operation not permitted/.test(msg)\nconst a = 1").length,
      '注释里的反例被当成了实现').toBe(0)
  })
})
