// tests/readme-command-table.test.ts —— README「命令一览」表与命令树双向一致（2026-10-28）。
//
// 为什么需要：README 的命令表是**给人抄的第一出处**，而它此前没有任何机器核对 ——
// `skill check` 只校验 skill 正文，`--help` 文案另有测试。新增一条命令、改名、
// 或给命令加了 flag 而 README 忘了跟着改，都不会有任何东西变红。
//
// 两个方向都查：
//   · 表里每条 `qiyu …` 的路径必须在 `COMMAND_TREE` 里存在，表里点名的每个 flag
//     必须是该命令接受集里的 flag（写错名字 = 读者照抄必失败）。
//   · `COMMAND_TREE` 里每个叶子命令必须出现在表里（文档漏了新命令）。
//
// ⚠️ 解析口径：只取每条目**首行**里第一段命令（描述文字与命令之间以连续 ≥2 空格分隔）。
// 续行是人读的说明，其中可能出现 `--compare` 这类 flag 名，不能当参数解析。
//
// ⚠️ 刻意**不查**的边界：表里可以省略 flag（现状：存储定位 `--db/--profile/--backend`
// 与 `query --limit/--timeout/--no-mask` 是有意省略的，写全会变成维护负担）。
// 因此「某命令删掉了表里的一个 flag」不会变红 —— 这个守卫管的是**写错的必失败**
// （路径不存在 / flag 不被接受 / 命令漏登），不是「表必须穷举」。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { COMMAND_TREE } from '../src/commands/tree.js'

const md = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8')

interface Entry { path: string[]; flags: string[]; raw: string; line: number }

/** 从「### 命令一览」的围栏块里解析命令条目。 */
function parseTable(): Entry[] {
  const lines = md.split('\n')
  const head = lines.findIndex((l) => l.trim() === '### 命令一览')
  expect(head, 'README 必须有「命令一览」小节').toBeGreaterThan(-1)
  let i = head + 1
  while (i < lines.length && lines[i]!.trim() !== '```') i++
  expect(i, '「命令一览」后必须有围栏块').toBeLessThan(lines.length)
  const out: Entry[] = []
  for (let n = i + 1; n < lines.length; n++) {
    const l = lines[n]!
    if (l.trim() === '```') break
    if (!l.startsWith('qiyu ')) continue // 续行是说明文字，不解析
    // 命令段 = 首行里第一段（与描述之间以连续 ≥2 空格分隔）
    const cmdPart = l.split(/\s{2,}/)[0]!
    const tokens = cmdPart.replace(/[[\]|]/g, ' ').trim().split(/\s+/)
    expect(tokens[0], `第 ${n + 1} 行不以 qiyu 开头`).toBe('qiyu')
    const path: string[] = []
    for (const t of tokens.slice(1)) {
      if (/^[-[]/.test(t) || t.startsWith('<')) break
      if (!/^[a-z][a-z-]*$/.test(t)) break
      path.push(t)
    }
    // ⚠️ 收「所有以 - 开头的 token」而不是 `--[a-z]+`：`---compare` / `--Compare` 这类
    // 畸形 flag 若被过滤掉，断言就会放行一个读者根本用不了的参数（CodeRabbit 2026-10-28）。
    // 它们不在接受集里，必然变红。
    const flags = tokens.slice(1 + path.length).filter((t) => t.startsWith('-'))
    out.push({ path, flags, raw: cmdPart, line: n + 1 })
  }
  return out
}

// 惰性解析：顶层抛错会变成「no tests」这种难读的收集期失败，落在测试体里才是正常断言失败。
let cached: Entry[] | undefined
const entries = (): Entry[] => (cached ??= parseTable())

describe('README 命令一览 ↔ COMMAND_TREE', () => {
  it('解析到了条目，且数量与命令树同量级（防空解析假绿）', () => {
    expect(entries().length, '解析出的条目数').toBeGreaterThanOrEqual(COMMAND_TREE.length)
  })

  it('表里每条命令路径都存在于命令树，点名的 flag 都被该命令接受', () => {
    for (const e of entries()) {
      if (e.path.length === 0) {
        // `qiyu --version` 这类顶层开关：由 cli.ts 直接处理，不在 COMMAND_TREE 里
        expect(e.raw, `第 ${e.line} 行路径为空`).toMatch(/^qiyu --version$/)
        continue
      }
      const key = e.path.join(' ')
      const spec = COMMAND_TREE.find((s) => s.path.join(' ') === key)
      expect(spec, `README 第 ${e.line} 行的命令在命令树里不存在：qiyu ${key}`).toBeDefined()
      const accepted = new Set(spec!.flags.map((f) => f.name))
      for (const f of e.flags) {
        expect(accepted, `README 第 ${e.line} 行给了 ${spec!.path.join(' ')} 不接受的 flag：${f}`)
          .toContain(f)
      }
    }
  })

  it('命令树里每个叶子命令都出现在表里（新增命令忘写文档会红）', () => {
    const documented = new Set(entries().filter((e) => e.path.length > 0).map((e) => e.path.join(' ')))
    const missing = COMMAND_TREE.map((s) => s.path.join(' ')).filter((p) => !documented.has(p))
    expect(missing, `README 命令一览缺少这些命令：${missing.join('、')}`).toEqual([])
  })

  it('表里点名的 flag 不能是「已知但显式拒绝」的那一族', () => {
    // rejected 机制保留（当前为空）。若将来有命令重新拒绝某个 flag，README 里
    // 把它当可用参数写出来就是假文档 —— 这里当场拦住。
    for (const e of entries()) {
      if (e.path.length === 0) continue
      const spec = COMMAND_TREE.find((s) => s.path.join(' ') === e.path.join(' '))!
      for (const f of e.flags) {
        expect(spec.rejected, `README 第 ${e.line} 行推荐了被 ${spec.path.join(' ')} 拒绝的 flag：${f}`)
          .not.toContain(f)
      }
    }
  })
})
