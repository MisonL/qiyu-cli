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

// 追加到 tests/core/validate.test.ts（effectiveBodyParams 的落点在 validate.ts）
import { effectiveBodyParams } from '../../src/core/validate.js'

describe('effectiveBodyParams', () => {
  it('把 relaxRequired 字段的 required 降为 false，其余原样；**只返回 body 参数**', () => {
    const file = { params: [
      { name: 'appKey', in: 'query', required: true },      // 不得出现在结果里
      { name: 'userName', in: 'body', required: true },
      { name: 'code', in: 'body', required: true },
      { name: 'shopCode', in: 'body', required: true },
    ], bodyKind: 'json', responseShape: { kind: 'object' } } as never
    const out = effectiveBodyParams(file, { relaxRequired: ['code', 'shopCode'] })
    expect(out.map((p: { name: string }) => p.name)).toEqual(['userName', 'code', 'shopCode'])
    expect(out.every((p: { in: string }) => p.in === 'body')).toBe(true)
    expect(out.find((p) => p.name === 'userName')!.required).toBe(true)
    expect(out.find((p) => p.name === 'code')!.required).toBe(false)
    expect(out.find((p) => p.name === 'shopCode')!.required).toBe(false)
  })
  it('无 override 时返回**仅 body** 参数（过滤掉 query/path/header）—— tag.all 语义：全 query → 空', () => {
    const file = { params: [
      { name: 'appKey', in: 'query', required: true },
      { name: 'time', in: 'query', required: true },
      { name: 'checksum', in: 'query', required: true },
    ], bodyKind: 'json', responseShape: { kind: 'object' } } as never
    // ⚠️ tag.all（json、0 body、3 个 required query）必须返回 []，否则 validateBody 会误判 hasBodySchema=true
    //    并硬拒「缺 appKey/time/checksum」（验收 8）。
    expect(effectiveBodyParams(file, undefined)).toEqual([])
  })
  it('relaxRequired 为空数组 → 与 undefined 等价（不改 required）', () => {
    const file = { params: [
      { name: 'a', in: 'body', required: true },
    ], bodyKind: 'json', responseShape: { kind: 'object' } } as never
    const out = effectiveBodyParams(file, { relaxRequired: [] })
    expect(out.map((p: { name: string }) => p.name)).toEqual(['a'])
    expect(out[0].required).toBe(true)
  })
  it('relaxRequired 含不存在的字段名 → 忽略，其余原样（不误伤别人）', () => {
    const file = { params: [
      { name: 'a', in: 'body', required: true },
      { name: 'b', in: 'body', required: true },
    ], bodyKind: 'json', responseShape: { kind: 'object' } } as never
    const out = effectiveBodyParams(file, { relaxRequired: ['ghost'] })
    expect(out.map((p: { name: string }) => p.name)).toEqual(['a', 'b'])
    expect(out.every((p) => p.required)).toBe(true)
  })
  it('不改写传入的 file.params（纯函数，不污染 loadParams 的缓存对象）', () => {
    const file = { params: [
      { name: 'a', in: 'body', required: true },
    ], bodyKind: 'json', responseShape: { kind: 'object' } } as never
    effectiveBodyParams(file, { relaxRequired: ['a'] })
    expect((file as { params: Array<{ required: boolean }> }).params[0].required).toBe(true)
  })
})
