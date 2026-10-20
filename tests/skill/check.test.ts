import { describe, it, expect, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSkillDoc, checkSkillDir, type CheckContext } from '../../src/skill/check.js'
// 位置约定：brief 原文 import `../../src/cli.js`；按 worktree 裁定 R1 改从
// `src/commands/tree.js` 取（`cli.ts` 只是兼容 re-export，直接取权威位置不拉入 CLI 入口图）。
import { COMMAND_TREE } from '../../src/commands/tree.js'
import { TABLES } from '../../src/store/schema.js'
import { ERROR_KINDS } from '../../src/core/errors.js'

const ctx: CheckContext = { tree: COMMAND_TREE, tableNames: TABLES.map((t) => t.name), errorKinds: ERROR_KINDS }

// 目录返回顺序在真实文件系统上不可控，没法用「反序写文件」验证 checkSkillDir 的排序。
// 用 vi.mock 把 readdirSync 换成可注入的代理：默认仍走真实实现（其余用例照常读临时目录），
// 排序用例里临时改成返回反序数组。`vi.hoisted` 供 mock 工厂与用例共享同一个可写引用。
const fsState = vi.hoisted(() => ({
  readdir: undefined as unknown as (path: string) => string[],
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsState.readdir = actual.readdirSync as unknown as (path: string) => string[]
  return { ...actual, readdirSync: (path: string) => fsState.readdir(path) }
})

describe('checkSkillDoc', () => {
  it('合规文档零违规', () => {
    const r = checkSkillDoc('先跑 `qiyu sync status`，再按 `kind: rate_limit` 分支。', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toEqual([])
  })
  it('未知命令 → unknown_command', () => {
    const r = checkSkillDoc('`qiyu nope foo`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'unknown_command' })
  })
  it('未知 flag → unknown_flag', () => {
    const r = checkSkillDoc('`qiyu api list --no-validate`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'unknown_flag', detail: expect.stringContaining('--no-validate') })
  })
  it('推荐 --pretty → rejected_flag', () => {
    const r = checkSkillDoc('`qiyu api list --pretty`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'rejected_flag' })
  })
  it('出现表名 → table_name', () => {
    const r = checkSkillDoc('查 `sessions` 表', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'table_name', detail: expect.stringContaining('sessions') })
  })
  it('出现 SQL 序列 → sql_sequence', () => {
    const r = checkSkillDoc('`SELECT id FROM x`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'sql_sequence' })
  })
  it('不存在的 kind → unknown_kind', () => {
    const r = checkSkillDoc('`kind: ambiguous`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'unknown_kind', detail: expect.stringContaining('ambiguous') })
  })
  it('无法静态判定的进 warnings 而非 violations', () => {
    const r = checkSkillDoc('`qiyu sync run | head`', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toHaveLength(1)
  })
  it('单数 tag 不是表名，不生成 matcher（真正的词边界钉在下方边界用例）', () => {
    // 裁定：原 brief 用例写的是 `tags`（在 TABLES 里，必然命中 table_name），改为单数
    // `tag`（不在 TABLES、`tags` 在）。本用例只证明「不在 TABLES 的词不会被误判」，
    // 不构成词边界证据 —— 词边界 / 大小写 / 扫描面三个属性分别由下面三条用例钉住。
    const r = checkSkillDoc('这里是 tag 列表，不是 `tag` 表', ctx)
    expect(r.violations).toEqual([])
  })
  it('词边界：`staffing` 含表名 staff 但不命中 table_name', () => {
    // 变异「regex 去掉 (?<![\\w-])/(?![\\w-])」或「includes(name)」→ 本用例红。
    const r = checkSkillDoc('`staffing` 是英文单词', ctx)
    expect(r.violations).toEqual([])
  })
  it('大小写敏感：`Sessions` 不命中表名 sessions', () => {
    // 变异「RegExp 加 i」→ 本用例红。
    const r = checkSkillDoc('`Sessions` 是接口字段名', ctx)
    expect(r.violations).toEqual([])
  })
  it('只在代码面扫：散文里的 sessions 不算引用', () => {
    // 变异「把扫描面从 collectSegments 换成全文 text」→ 本用例红。
    const r = checkSkillDoc('这里直接写 sessions 不算引用', ctx)
    expect(r.violations).toEqual([])
  })
  it('表名含正则元字符时按字面匹配', () => {
    // 变异「正则不转义」→ `a.b` 会命中 `axb`，第一条断言红。
    const special: CheckContext = { ...ctx, tableNames: ['a.b'] }
    expect(checkSkillDoc('`axb`', special).violations).toEqual([])
    expect(checkSkillDoc('`a.b`', special).violations[0]).toMatchObject({ rule: 'table_name' })
  })
  it('violations 按行升序（跨规则合并后排序）', () => {
    // kind 在第 1 行、表名在第 5 行；收集顺序是「表名先于 kind」，不排序时表名会排前面。
    const r = checkSkillDoc('`kind: ambiguous`\n\n\n\n查 `sessions` 表', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['unknown_kind', 'table_name'])
    expect(r.violations.map((v) => v.line)).toEqual([1, 5])
  })
})

describe('checkSkillDir', () => {
  it('只读 .md，detail 带「文件:行」前缀', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qiyu-skill-check-'))
    try {
      writeFileSync(join(dir, 'a.md'), '第一行\n`qiyu nope`\n')
      writeFileSync(join(dir, 'b.md'), '`qiyu sync run | head`\n')
      writeFileSync(join(dir, 'c.txt'), '`qiyu nope txt`\n')
      const r = checkSkillDir(dir, ctx)
      expect(r.violations).toHaveLength(1)
      expect(r.violations[0]).toMatchObject({ line: 2, rule: 'unknown_command' })
      expect(r.violations[0]!.detail).toContain('a.md:2')
      expect(r.warnings).toHaveLength(1)
      expect(r.warnings[0]!.detail).toContain('b.md:1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('按文件名排序，不依赖 readdirSync 的返回顺序', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qiyu-skill-check-'))
    const realReaddir = fsState.readdir
    try {
      writeFileSync(join(dir, 'a.md'), '`qiyu nope a`\n')
      writeFileSync(join(dir, 'b.md'), '`qiyu nope b`\n')
      // 变异「删掉 .sort()」→ 输出按 ['b.md','a.md'] 的顺序，本用例红。
      fsState.readdir = () => ['b.md', 'a.md']
      const r = checkSkillDir(dir, ctx)
      expect(r.violations.map((v) => v.detail.split(' ')[0])).toEqual(['a.md:1', 'b.md:1'])
    } finally {
      fsState.readdir = realReaddir
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
