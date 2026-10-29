// tests/empty-string-single-source.test.ts —— 「环境变量里的空串 = 未设置」只许有一处实现
// （2026-10-29）。
//
// 背景（同一族缺陷的第三个受害者，前两个在 `profile-name-single-source.test.ts`）：
// `''` 不是 null/undefined，`??` 会把它当有效值放行 —— 于是环境变量的空串会**遮蔽**
// 下一层的真实配置：
//   · `QIYU_PROFILE=` → `auth login` 把凭证写进 `profiles[""]`（没人读的档）；
//   · `QIYU_DB_PATH=` → 配置文件里配好的 `store.path` 失效，命令以「路径不能为空」
//     失败，而报错还声称 `store.path` 也是空的（真库实测）；
//   · `QIYU_DB_PATH=`（sync install）→ 把**回落后的**路径固化成 `--db` 烘进调度命令。
//
// 修法是唯一实现 `nonEmptyValue`（`core/config.ts`），五个调用方共用它。本文件守**漂移**：
// 以后谁再对 QIYU_* 环境变量手写 `!== undefined` / `!== ''` / `?? env.X`，直接红。
//
// ⚠️ 边界（诚实记录）：这是**文本**判据，证明不了运行时行为（那是
// `tests/store/config.test.ts` / `tests/commands/sync.test.ts` 的用例负责的）。
// 且只扫**单行**形态：跨多行拆开的链抓不到（仓库现有写法都是单行，自检用例钉住了
// 三个真实事故的原样文本）。它只回答一个问题：「空串口径是不是还只有一个实现」。
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

/** QIYU_* 环境变量的读取（`process.env.QIYU_X` / 注入的 `env.QIYU_X`）。 */
const ENV_READ = String.raw`(?:process\.env|env)\.QIYU_[A-Z_]+`

/**
 * 三种手写空串判据的指纹（都精确到**同一行**）：
 *   ① `env.X !== ''` —— 自己实现空串判据；
 *   ② `?? env.X` —— 裸 `??` 链读 env（`''` 会被当有效值放行）；
 *   ③ `env.X !== undefined` —— 只判存在、不看空串（遮蔽缺陷的本体）。
 * ②③ 与 ① 会同时对一行命中，这里按行去重（一行只算一处违规）。
 */
const FINGERPRINTS: Array<[string, RegExp]> = [
  ['手写空串判据（!== \'\'）', new RegExp(String.raw`${ENV_READ}\s*!==\s*''`)],
  ['裸 ?? 链读环境变量', new RegExp(String.raw`\?\?\s*${ENV_READ}`)],
  ['只判存在（!== undefined）', new RegExp(String.raw`${ENV_READ}\s*!==\s*undefined`)],
]

const ENV_READ_RE = new RegExp(ENV_READ)

/**
 * 扫描一段源码，返回违规行。
 *
 * 两种形态都抓：
 *   ① **直接**：同一行里读 `QIYU_*` 并判空/判存在；
 *   ② **间接**：先把 env 值存进局部变量、随后几行才手写判据（`auth.ts` 2026-10-29 的
 *      历史事故原样就是这种：`const envKey = process.env.QIYU_APP_KEY` 之后
 *      `envKey !== undefined && envKey !== ''`）。只做 ① 会漏掉真实事故形态。
 *      赋值右侧已经套了 `nonEmptyValue(` 的变量视为已归一，不再追踪。
 */
function scanText(text: string): Array<{ line: number; why: string; snippet: string }> {
  const lines = stripCommentLines(text).split('\n')
  const hits = new Map<number, { line: number; why: string; snippet: string }>()
  const add = (i: number, why: string): void => {
    if (hits.has(i)) return
    hits.set(i, { line: i + 1, why, snippet: (lines[i] ?? '').trim().slice(0, 120) })
  }
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const why = FINGERPRINTS.find(([, re]) => re.test(line))?.[0]
    if (why !== undefined) add(i, why)
  }
  // ② 间接形态：追踪「从 QIYU_* 赋值出来的局部变量」，看后续 6 行内是否被手写判据消费。
  for (let i = 0; i < lines.length; i++) {
    const m = /(?:const|let)\s+(\w+)\s*=\s*(.*)$/.exec(lines[i] ?? '')
    if (m === null) continue
    const [, id, rhs] = m
    if (id === undefined || rhs === undefined) continue
    if (!ENV_READ_RE.test(rhs) || rhs.includes('nonEmptyValue(')) continue
    const useRe = new RegExp(String.raw`\b${id}\b\s*(?:!==|===)\s*(?:''|undefined)|\?\?\s*\b${id}\b`)
    for (let j = i; j < Math.min(i + 7, lines.length); j++) {
      if (useRe.test(lines[j] ?? '')) add(j, `局部变量 ${id} 承载 QIYU_* 值后被手写判据消费`)
    }
  }
  return [...hits.values()].sort((a, b) => a.line - b.line)
}

describe('环境变量的空串判据必须只有一处实现（nonEmptyValue）', () => {
  it('除 core/config.ts 外，全仓不得对 QIYU_* 环境变量手写空串/存在判据', () => {
    // `core/config.ts` 是 nonEmptyValue 的定义处（它本身不读 env 做判据，列进豁免
    // 只是让「唯一实现」这条话在文件层面也成立）。
    const hits = walk(SRC)
      .filter((f) => !f.endsWith(join('core', 'config.ts')))
      .flatMap((f) => scanText(readFileSync(f, 'utf8')).map((h) => ({ file: relative(ROOT, f), ...h })))
    const rendered = hits.map((h) => `${h.file}:${h.line}  [${h.why}]  ${h.snippet}`)
    expect(
      rendered,
      '这些地方在对 QIYU_* 环境变量手写空串判据 —— 请改用 core/config.ts 的 nonEmptyValue()'
      + '（空串被当有效值放行曾让配置文件里的 store.path 失效）：\n' + rendered.join('\n'),
    ).toEqual([])
  })

  it('扫描器自身有牙：三个真实事故的原样文本必须被抓到，合法调用必须放过', () => {
    // ⚠️ 没有这一条，上面的断言可能是「扫了个空」—— 路径写错、正则退化成永不命中，
    // 都会让它恒绿。下面每个样例都取自仓库里**真实出现过**的代码行。
    const cases: Array<[string, string, number]> = [
      // 事故 1：auth login 的**间接**形态（PR #41 的原样事故）—— env 值先存进局部
      // 变量，下一行才手写判据。只扫「同一行」会漏掉它，所以扫描器带变量追踪。
      ['旧 login 间接', "  const envKey = process.env.QIYU_APP_KEY\n  const k = envKey !== undefined && envKey !== '' ? envKey : undefined", 1],
      ['旧 login 直读', "  const k = process.env.QIYU_APP_KEY !== '' ? process.env.QIYU_APP_KEY : undefined", 1],
      // 事故 2：resolveStoreConfig 的 ?? 链（本轮）
      ['旧 store 链', "  const rawPath = flags.db ?? env.QIYU_DB_PATH ?? (storeBlock.path as string | undefined)", 1],
      // 事故 3：storeArgsFor 只判存在（本轮）
      ['旧 sync 判据', "  if (parsed.values['--db'] === undefined && process.env.QIYU_DB_PATH !== undefined) {", 1],
      // 合法：唯一实现的调用方
      ['合法 nonEmptyValue', "  const p = nonEmptyValue(process.env.QIYU_DB_PATH)", 0],
      // 合法：把 env 值原样传下去（归一化在 resolveStoreConfig 里做）
      ['合法透传', "    QIYU_DB_PATH: process.env.QIYU_DB_PATH,", 0],
      // 合法：非 QIYU_ 的变量不归这条规则管（npm 的 INIT_CWD 有自己的 trim 口径）
      ['非 QIYU_ 变量', "  if (init !== undefined && init !== '') return init", 0],
    ]
    for (const [label, text, want] of cases) {
      expect(scanText(text).length, `${label}：${text}`).toBe(want)
    }
    // 注释里的反例不得算违规（各文件的说明注释大量引用旧写法）
    expect(scanText("// 旧写法：flags.db ?? env.QIYU_DB_PATH ?? 'x'\nconst a = 1").length,
      '注释里的反例被当成了实现').toBe(0)
  })
})
