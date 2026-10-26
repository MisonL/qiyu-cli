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
import { SKILL_CONTRACT_VERSION } from '../../src/core/edition.js'

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
        'callable-endpoint-ids': allEndpoints().filter((e) => e.callable).map((e) => e.id),
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
  // 回归钉（CodeRabbit CLI minor）：`store_not_initialized` 有多种成因，只有「库不存在 /
  // 迁移未跑完」能靠 store init 解决；「他人库 / 路径不是 DuckDB 文件 / 依赖未安装」跑
  // store init 会再次失败 —— 无条件指它会把 Agent 送进 store init → sync run 死循环
  // （sync-run.ts storeInitFail 保底层 hint 的同一裁定，架构审查 F1）。
  it('errors.md 的 store_not_initialized 按 hint 行动，不无条件推荐 store init', () => {
    const text = readFileSync(join(dir, 'errors.md'), 'utf8')
    const row = text.split('\n').find((l) => l.includes('`kind: store_not_initialized`')) ?? ''
    expect(row, '找不到 store_not_initialized 行').not.toBe('')
    expect(row).toContain('按 `hint` 行动')
    expect(row).not.toMatch(/先跑 `qiyu store init`/)
  })

  // —— 契约号与正文结构绑定（2026-10-26 审查 Sourcery）——
  // 问题：`--version` 的测试从 `SKILL_CONTRACT_VERSION` 推导期望值，于是若有人改了
  // 正文却忘了递增契约号，测试照样绿 —— 而 spec D6 的整条纪律就是「正文结构性改变
  // 必须递增」。把期望值写死成字面量 `2` 只是换个地方抄常量：下次正当递增要改测试，
  // 且「改了正文忘了递增」这个失败模式依然抓不到。
  // 本组用**正文里真实存在的结构标记**当锚，把「标记条数」与「契约号」锁在一起：
  // 递增号却没补标记 → 红；补了标记却没递增号 → 红；标记指向的段落被删 → 红。
  // 诚实边界：「这次改动算不算结构性」仍是 D6 要求的人为判断，测试只能保证**一旦
  // 判定为结构性，两条记录（号与标记）必须同时动**，不能替人做这个判断。
  describe('契约号与正文结构一致（spec D6）', () => {
    // 每条 = 一次**结构性**变更引入的正文标记（新增/改写协议段落）。
    // 追加时同步递增 SKILL_CONTRACT_VERSION，并在 edition.ts 变更记录里写一行。
    const STRUCTURAL_MARKERS: Array<{ since: number; name: string; file: string; pattern: RegExp }> = [
      {
        since: 2,
        name: 'skill where 报出已安装正文的契约号与 compatible',
        file: 'SKILL.md',
        pattern: /`data\.entity\.installed\.compatible`/,
      },
    ]

    it('标记条数 == 契约号 - 1（版本 1 为初版，无标记）', () => {
      expect(
        STRUCTURAL_MARKERS.length,
        '正文结构标记与 SKILL_CONTRACT_VERSION 脱节：加了协议段落要递增契约号，'
        + '增了契约号要在 STRUCTURAL_MARKERS 里补一条对应标记',
      ).toBe(SKILL_CONTRACT_VERSION - 1)
    })

    it.each(STRUCTURAL_MARKERS)('契约 ≥ $since 的标记「$name」确实在正文里', ({ file, pattern }) => {
      // 标记本身也必须真实存在 —— 否则有人删掉协议段落、标记表没动，前一条仍绿。
      expect(readFileSync(join(dir, file), 'utf8'), `${file} 里找不到该结构标记`).toMatch(pattern)
    })
  })
})
