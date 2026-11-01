// tests/native-error-single-source.test.ts —— DuckDB 原生报文判据只许有一处实现
// （2026-11-01，PR #54）。
//
// 背景（探针 + E2E 实测，两个真实缺陷，2026-11-01）：
//   ① `query/sandbox.ts` 用 `/INTERRUPT/i` **子串**判超时。`Conversion Error` 会把**列值
//      原文**回显进 message —— 数据里恰好含 `interrupt` 时
//      （`Could not convert string 'interrupt' to INT32 …`），类型转换错误被谎报成
//      查询超时：kind 与真实成因相反、真实错误线索被整体丢弃、`--timeout 0` 下也报超时。
//   ② layer2 判据 `/file system operations are disabled|Cannot access file/i` 子串搜
//      **整条报文**。`Parser Error` 会把**出错行 SQL 全文**回显进 message —— SQL 里含
//      特征句时（`SELEC 'file system operations are disabled by configuration'`，实测），
//      纯语法错被谎报成「该语句尝试访问文件或网络，已被只读沙箱拦截」。
// 两条同根：**报文会把外部文本带进来**（用户数据、用户 SQL），子串判因此可被污染；
// 而判据又在 `query/sandbox.ts` 与 `query/errors.ts` 各写一份（逐字相同），改一处漏一处。
// 收敛：`query/native-error.ts` 是**唯一实现点**（锚类别前缀 + 剥 SQL 回显）。
//
// 同族前科：`nonEmptyValue`（empty-string）、profile 名解析（PR #41）、打开失败成因
// （open-failure-single-source）、库前置检查（store-precheck-single-source）。
//
// ⚠️ 边界（诚实记录）：这是**文本**判据，证明不了运行时行为（那是
// `tests/query/native-error.test.ts` 用真实报文逐字钉住的）。它只回答：
// 「这两条原生报文判据是不是还只有一个实现」。
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

/** 抹掉行首整行注释与块注释行（与本目录其它 single-source 守卫同一约定）。 */
const stripCommentLines = (text: string): string =>
  text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')

/** 唯一实现点（相对 ROOT）。 */
const SINGLE_SOURCE = join('src', 'query', 'native-error.ts')

/**
 * 判据的**载体**指纹 —— 复制判据的人不会复制函数名，他会复制那段正则/调用形态。
 *
 * 「中断判据」钉两种形态：事故原文的裸子串 `/INTERRUPT/i`（不带类别锚），与
 * 正确写法的调用点。后者不是违规 —— 它在 PREDICATES 里只为防「唯一实现点被改名/
 * 搬走后扫描器扫了个空」，用 FORBIDDEN 才是主判据。
 */
const PREDICATES: Array<[string, RegExp]> = [
  ['中断判据（锚类别前缀）', /INTERRUPT Error/i],
  ['layer2 判据（特征句）', /file system operations are disabled/i],
]

/**
 * **任何**文件都不得出现的判据 —— 指纹是这条规则**禁用**的形态。
 *
 * ⚠️ 用函数而不是单条正则：禁用形态是「**判据的载荷**里出现了那个词、却**没有**
 * 类别锚」。写成 `① 含 X ② 不含 Y` 两个条件用一条正则表达不出来（负向先行断言在
 * 「词出现在同一行任意位置」这种要求下会漏），写成函数则逐字可读、也不怕各种
 * 正则字面量写法（`/INTERRUPT/i`、`/interrupt/`、`/\bINTERRUPT\b/i`）。
 *
 * ⚠️ 边界如实记录：「有没有剥 SQL 回显」这条**文本**抓不到（它取决于调用点是否
 * 先调 `withoutSqlEcho`）；那由 `tests/query/native-error.test.ts` 的行为用例钉住。
 */
const FORBIDDEN: Array<[string, (line: string) => boolean]> = [
  ['裸 INTERRUPT 判（无类别锚）', (l) =>
    /\/[^/]*INTERRUPT[^/]*\//i.test(l) && !/INTERRUPT\s*Error/i.test(l)],
  ['裸 layer2 特征句判（无类别锚）', (l) =>
    /file system operations are disabled/i.test(l) && !/Permission\s*Error/i.test(l)],
]

function scanText(
  text: string,
  preds: Array<[string, RegExp]>,
  forbidden: Array<[string, (line: string) => boolean]> = [],
): Array<{ line: number; why: string; snippet: string }> {
  const lines = stripCommentLines(text).split('\n')
  const hits: Array<{ line: number; why: string; snippet: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const why = preds.find(([, re]) => re.test(line))?.[0]
      ?? forbidden.find(([, fn]) => fn(line))?.[0]
    if (why !== undefined) hits.push({ line: i + 1, why, snippet: line.trim().slice(0, 120) })
  }
  return hits
}

describe('DuckDB 原生报文判据必须只有一处实现（native-error.ts）', () => {
  it('除 native-error.ts 外，全仓不得再出现中断 / layer2 拦截的判据', () => {
    const hits = walk(SRC)
      .filter((f) => relative(ROOT, f) !== SINGLE_SOURCE)
      .flatMap((f) => scanText(readFileSync(f, 'utf8'), PREDICATES)
        .map((h) => ({ file: relative(ROOT, f), ...h })))
    const rendered = hits.map((h) => `${h.file}:${h.line}  [${h.why}]  ${h.snippet}`)
    expect(
      rendered,
      '这些地方在复制 DuckDB 原生报文判据 —— 请改用 src/query/native-error.ts 的'
      + ' isInterrupt() / isLayer2Blocked()（报文会把用户数据与 SQL 回显带进来，'
      + '子串判会被污染；两处各写一份必然漂移）:\n' + rendered.join('\n'),
    ).toEqual([])
  })

  it('禁用形态（裸子串判）在任何文件里都不得复活', () => {
    // ⚠️ **排除唯一实现点自己**：`native-error.ts` 必然**同时**含这两个词（它就是要认它们），
    // 而它的类别锚在**另一个表达式/另一行**上 —— 逐行的「有词无锚」判据分不开
    // 「锚在上一行的合取」与「压根没锚」。对唯一实现点改用**结构**断言（下一条用例）。
    const hits = walk(SRC)
      .filter((f) => relative(ROOT, f) !== SINGLE_SOURCE)
      .flatMap((f) => scanText(readFileSync(f, 'utf8'), [], FORBIDDEN)
        .map((h) => ({ file: relative(ROOT, f), ...h })))
    const rendered = hits.map((h) => `${h.file}:${h.line}  [${h.why}]  ${h.snippet}`)
    expect(
      rendered,
      '这些地方恢复了按**裸子串**写报文判据的形态（含 × 不含类别锚）—— DuckDB 的报文会把'
      + '用户数据（Conversion Error 回显列值）与用户 SQL（Parser Error 回显出错行）带进来，'
      + '裸子串判会被污染，必须锚类别前缀并剥 SQL 回显:\n' + rendered.join('\n'),
    ).toEqual([])
  })

  it('唯一实现点自身必须**两个条件都在**（结构断言：替掉逐行判据的盲区）', () => {
    const text = readFileSync(join(ROOT, SINGLE_SOURCE), 'utf8')
    // layer2：必须锚类别前缀 **且** 要特征句 —— 只有其一都会误判（见 native-error.ts 注释）
    expect(text, 'isLayer2Blocked 必须锚 `Permission Error:` 类别前缀').toMatch(/\^Permission Error:/i)
    expect(text, 'isLayer2Blocked 必须要求「配置禁用」特征句').toMatch(/file system operations are disabled/i)
    // 中断：必须锚 `INTERRUPT Error`，不得裸用 `/INTERRUPT/i`
    // ⚠️ 负向断言必须跑**剥注释后**的文本：文件头正是用 `/INTERRUPT/i` 逐字解释了
    // 「不能这么写」（本仓库第 5 次踩这个陷阱 —— 对全文判会把「解释旧错」判成「仍在犯旧错」）。
    const codeOnly = stripCommentLines(text)
    expect(codeOnly, 'isInterrupt 必须锚类别前缀').toMatch(/INTERRUPT Error/i)
    // 用 RegExp 构造而不是字面量：这条断言的**说明文字**里就要写出那个被禁的形态，
    // 写成字面量会让 esbuild 在字符串里找正则的结尾（实测报 Unterminated regular expression）。
    expect(codeOnly, 'isInterrupt 不得裸用不带类别锚的子串判')
      .not.toMatch(new RegExp('/INTERRUPT/i'))
    // 剥 SQL 回显的判据必须在场（layer2 判定依赖它）
    expect(text, '必须剥离 SQL 回显后再判定').toMatch(/export function withoutSqlEcho/)
  })

  it('唯一实现点确实在场（防「扫描器扫了个空」——文件被改名/搬走后这条仍须红）', () => {
    const text = readFileSync(join(ROOT, SINGLE_SOURCE), 'utf8')
    const missing = PREDICATES.map(([why]) => why)
      .filter((why) => !scanText(text, PREDICATES).some((h) => h.why === why))
    expect(missing, `${SINGLE_SOURCE} 缺这些判据（扫描器等于没守任何东西）`).toEqual([])
    expect(text).toMatch(/export function isInterrupt/)
    expect(text).toMatch(/export function isLayer2Blocked/)
  })

  it('扫描器自身有牙：真实事故的原样文本必须被抓到，合法写法必须放过', () => {
    // ⚠️ 没有这一条，上面的断言可能是「扫了个空」—— 正则退化成永不命中会恒绿。
    const cases: Array<[string, string, number]> = [
      // 事故 ①：`query/sandbox.ts` 里的裸子串判（2026-11-01 修的那个）—— 必须被抓到
      ['裸 INTERRUPT 子串判', '        if (/INTERRUPT/i.test(msg)) {', 1],
      // 事故 ① 的正确修法（锚类别前缀）→ 命中 PREDICATES 那档，不是违规形态
      ['合法 INTERRUPT Error 锚', '        if (/INTERRUPT Error/i.test(msg)) {', 1],
      // 事故 ②：layer2 判据裸用特征句（同样必须被抓到）
      ['裸 layer2 特征句判', "  if (/file system operations are disabled|Cannot access file/i.test(msg)) {", 1],
      // 合法：调用唯一实现
      ['合法 调用', '        if (isInterrupt(msg)) {', 0],
      ['合法 layer2 调用', '  if (isLayer2Blocked(msg)) {', 0],
      // 合法：与这两条判据无关的其它报文判据
      ['合法 其它判据', "  if (/Out of Memory Error/i.test(msg)) {", 0],
    ]
    for (const [label, text, want] of cases) {
      expect(scanText(text, PREDICATES, FORBIDDEN).length, `${label}：${text}`).toBe(want)
    }
    // 注释里的反例不得算违规（各文件大量引用旧写法做说明）
    expect(scanText("// 旧写法：if (/INTERRUPT/i.test(msg))\nconst a = 1", PREDICATES, FORBIDDEN).length,
      '注释里的反例被当成了实现').toBe(0)
  })
})
