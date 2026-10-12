import { describe, it, expect } from 'vitest'
import { normalizeAliases } from '../../src/core/validate.js'
import type { ParamFile } from '../../src/core/registry/params.js'

const file = (): ParamFile => ({
  params: [{ name: 'question', in: 'body', required: true }],
  bodyKind: 'json', responseShape: { kind: 'object' },
})
const ov = { aliases: { name: 'question' } }

describe('normalizeAliases', () => {
  it('源键被改写为目标键，并出 alias_normalized 警告；非别名键原样保留', () => {
    const r = normalizeAliases(file(), { name: 'q' }, ov)
    expect(r.body).toEqual({ question: 'q' })
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toMatchObject({ kind: 'alias_normalized', field: 'name' })
    expect(r.warnings[0].message).toMatch(/无需重试/)
    // spec §四 D8：其它字段原样保留（防止实现「只留别名键」丢弃其余）
    const r2 = normalizeAliases(file(), { name: 'q', answer: 'a', robotId: 2 }, ov)
    expect(r2.body).toEqual({ question: 'q', answer: 'a', robotId: 2 })
  })
  it('无 aliases → 原样返回、零警告', () => {
    const r = normalizeAliases(file(), { question: 'q' }, undefined)
    expect(r.body).toEqual({ question: 'q' })
    expect(r.warnings).toEqual([])
  })
  it('非对象（undefined/null/数组/标量）原样返回、不抛', () => {
    for (const v of [undefined, null, [], 'x', 1]) {
      const r = normalizeAliases(file(), v, ov)
      expect(r.body).toBe(v)
      expect(r.warnings).toEqual([])
    }
  })
  it('源键与目标键同时存在 → 抛（硬拒歧义）', () => {
    expect(() => normalizeAliases(file(), { name: 'q', question: 'q2' }, ov)).toThrow(/只传其一/)
  })
})
