import { describe, it, expect } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSkillDoc, checkSkillDir, type CheckContext } from '../../src/skill/check.js'
// 位置约定：brief 原文 import `../../src/cli.js`；按 worktree 裁定 R1 改从
// `src/commands/tree.js` 取（`cli.ts` 只是兼容 re-export，直接取权威位置不拉入 CLI 入口图）。
import { COMMAND_TREE } from '../../src/commands/tree.js'
import { TABLES } from '../../src/store/schema.js'
import { ERROR_KINDS } from '../../src/core/errors.js'

const ctx: CheckContext = { tree: COMMAND_TREE, tableNames: TABLES.map((t) => t.name), errorKinds: ERROR_KINDS }

describe('checkSkillDoc', () => {
  it('合规文档零违规', () => {
    const r = checkSkillDoc('先跑 `qiyu sync status`，再按 `kind: rate_limit` 分支。', ctx)
    expect(r.violations).toEqual([])
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
  it('表名匹配是词边界，不误伤英文单词', () => {
    // 裁定：原 brief 用例写的是 `tags`（在 TABLES 里，必然命中 table_name），改为单数
    // `tag`（不在 TABLES、`tags` 在）验证词边界 —— 校验器不理解否定语境。
    const r = checkSkillDoc('这里是 tag 列表，不是 `tag` 表', ctx)
    expect(r.violations).toEqual([])
  })
})

describe('checkSkillDir', () => {
  it('只读 .md（按文件名排序），detail 带「文件:行」前缀', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qiyu-skill-check-'))
    try {
      // 文件名故意反序写入，验证按文件名排序而不是目录返回顺序。
      writeFileSync(join(dir, 'b.md'), '`qiyu sync run | head`\n')
      writeFileSync(join(dir, 'a.md'), '第一行\n`qiyu nope`\n')
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
})
