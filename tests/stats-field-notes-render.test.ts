// tests/stats-field-notes-render.test.ts
// `statsFieldNotes(loc)` 的渲染纯函数：库定位里的 `$` 序列不得被 `String.replace` 二次解释。
// ⚠️ 纯函数、不碰 DuckDB —— 本轮真库夹具在负载下有 80s+ 冷开，回归必须能快速跑。
//
// 断言用 `shellArg` 的转义形态而不是裸路径：含单引号的路径在 shell 里必须写成 `'\''`，
// 裸路径「逐字出现」本来就是错的要求；真实契约是「渲染出的命令的每个字节都来自正确的
// 转义，没有被 replacement 语法改写」。
import { describe, expect, it } from 'vitest'
import { statsFieldNotes } from '../src/commands/stats.js'
import { shellArg } from '../src/output.js'

const unitNote = (loc?: { db?: string; profile?: string }): string =>
  statsFieldNotes(loc)['declared.<字段>.unit']!

describe('statsFieldNotes 渲染核实命令（Codex 2026-11-10 第九轮 P2）', () => {
  it.each([
    ['$&', '/tmp/q$&.duckdb'],
    ['$$', '/tmp/q$$.duckdb'],
    ['$\'', '/tmp/q$\'.duckdb'],
    ['$`', '/tmp/q$`.duckdb'],
    ['$1', '/tmp/q$1.duckdb'],
  ])('库路径含 %s 时转义后逐字保留在提示里', (_label, db) => {
    const note = unitNote({ db })
    expect(note).toContain(shellArg(db))
    // 反向：replacement 特殊序列被解释的痕迹不得出现
    expect(note, '`{@query}` 字面量说明模板占位被回填了').not.toContain('{@query}')
  })

  it('档名里的 `$` 序列同样逐字保留', () => {
    expect(unitNote({ profile: 'p$&x' })).toContain(shellArg('p$&x'))
  })

  it('未给定位时不出现模板占位符', () => {
    expect(unitNote()).not.toContain('{@query}')
    expect(unitNote()).toContain('qiyu query --sql')
  })
})
