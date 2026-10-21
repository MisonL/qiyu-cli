import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkSkillDir } from '../../src/skill/check.js'
// 位置约定：brief 原文 import `../../src/cli.js`；与 tests/skill/check.test.ts 同一条
// worktree 裁定（R1）—— 从 `src/commands/tree.js` 取权威位置，不拉进 CLI 入口图。
import { COMMAND_TREE } from '../../src/commands/tree.js'
import { TABLES } from '../../src/store/schema.js'
import { ERROR_KINDS } from '../../src/core/errors.js'
import { REPORT_TABLES } from '../../src/query/metric-catalog.js'
import { SYNC_TASKS } from '../../src/sync/registry.js'
import { allEndpoints } from '../../src/core/registry/index.js'

// 仓库测试统一用 `fileURLToPath(import.meta.url)` 定位源码（ESM 下没有 `__dirname`），
// brief 里的 `__dirname` 在 vitest ESM 中不可用，这里换成等价写法。
const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'skill', 'qiyu')

describe('skill 文档', () => {
  it('零违规（含位置参数取值域，终审 I1）', () => {
    const r = checkSkillDir(dir, {
      tree: COMMAND_TREE,
      tableNames: TABLES.map((t) => t.name),
      errorKinds: ERROR_KINDS,
      domains: {
        tables: TABLES.map((t) => t.name),
        'report-tables': REPORT_TABLES,
        'task-ids': SYNC_TASKS.map((t) => t.id),
        'endpoint-ids': allEndpoints().map((e) => e.id),
      },
    })
    expect(r.violations).toEqual([])
  })
  it('SKILL.md 的 frontmatter 有字符串 name 与 description', () => {
    const text = readFileSync(join(dir, 'SKILL.md'), 'utf8')
    expect(text).toMatch(/^---\n/)
    expect(text).toMatch(/^name:\s*qiyu$/m)
    expect(text).toMatch(/^description:\s*\S+/m)
  })
  it('SKILL.md 小于 1 MB', () => {
    expect(statSync(join(dir, 'SKILL.md')).size).toBeLessThan(1024 * 1024)
  })
  it('SKILL.md 不以参考文件作为内容主体（拆分生效）', () => {
    const skills = readdirSync(dir).filter((f) => f.endsWith('.md') && f !== 'SKILL.md')
    expect(skills.length).toBeGreaterThanOrEqual(4)
  })
  it('不推荐 --pretty', () => {
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.md'))) {
      expect(readFileSync(join(dir, f), 'utf8'), f).not.toMatch(/`qiyu[^`]*--pretty/)
    }
  })
})
