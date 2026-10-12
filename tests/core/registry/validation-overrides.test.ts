import { describe, it, expect } from 'vitest'
import { validateOverrides } from '../../../src/core/registry/validation-overrides.js'
import type { EndpointSpec } from '../../../src/core/registry/index.js'
import type { ParamFile } from '../../../src/core/registry/params.js'

const spec = (id: string): EndpointSpec => ({
  id, title: 't', method: 'POST', path: '/x', direction: 'outbound',
  callable: true, dangerous: false, auth: 'checksum', verified: false, envelope: null,
})
const file = (params: Array<{ name: string; in: 'body' | 'query'; required: boolean }>): ParamFile => ({
  params: params.map((p) => ({ ...p } as never)), bodyKind: 'json', responseShape: { kind: 'object' },
})
const specs = [spec('a.b'), spec('c.d')]
const paramsFor = (id: string): ParamFile =>
  id === 'a.b' ? file([{ name: 'userName', in: 'body', required: true }, { name: 'code', in: 'body', required: true }, { name: 'shopCode', in: 'body', required: true }])
                : file([{ name: 'question', in: 'body', required: true }])

describe('validateOverrides —— fail-closed', () => {
  it('合法 one-of / relaxRequired 通过', () => {
    const r = validateOverrides({ 'a.b': { relaxRequired: ['code', 'shopCode'], oneOf: [{ anyOf: ['code', 'shopCode'], message: 'm' }] } }, specs, paramsFor)
    expect(r['a.b'].relaxRequired).toEqual(['code', 'shopCode'])
  })
  it('不存在的 id → 抛，且消息点名接口 id（spec 验收 12）', () => {
    expect(() => validateOverrides({ 'no.such': {} }, specs, paramsFor)).toThrow(/no\.such/)
  })
  it('relaxRequired 引用不存在的字段 → 抛', () => {
    expect(() => validateOverrides({ 'a.b': { relaxRequired: ['nope'] } }, specs, paramsFor)).toThrow()
  })
  it('relaxRequired 引用非必填字段 → 抛（无效果死配置）', () => {
    const pf = (id: string) => file([{ name: 'opt', in: 'body', required: false }])
    expect(() => validateOverrides({ 'a.b': { relaxRequired: ['opt'] } }, specs, pf)).toThrow()
  })
  it('oneOf.anyOf 少于 2 个 → 抛', () => {
    expect(() => validateOverrides({ 'a.b': { oneOf: [{ anyOf: ['code'], message: 'm' }] } }, specs, paramsFor)).toThrow()
  })
  it('oneOf.anyOf 引用非 body 字段 → 抛', () => {
    expect(() => validateOverrides({ 'a.b': { oneOf: [{ anyOf: ['code', 'ghost'], message: 'm' }] } }, specs, paramsFor)).toThrow()
  })
  it('aliases 目标键不存在 → 抛', () => {
    expect(() => validateOverrides({ 'c.d': { aliases: { name: 'ghost' } } }, specs, paramsFor)).toThrow()
  })
  it('aliases 源键恰是 body 字段 → 抛', () => {
    expect(() => validateOverrides({ 'c.d': { aliases: { question: 'question' } } }, specs, paramsFor)).toThrow()
  })
  it('顶层非对象 → 抛', () => {
    expect(() => validateOverrides([], specs, paramsFor)).toThrow()
  })
  it('别名冲突：源键与目标键都出现 → normalizeAliases 抛（此处只验加载期通过）', () => {
    const r = validateOverrides({ 'c.d': { aliases: { name: 'question' } } }, specs, paramsFor)
    expect(r['c.d'].aliases).toEqual({ name: 'question' })
  })
})
