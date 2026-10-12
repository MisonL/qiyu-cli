import { describe, it, expect } from 'vitest'
import { normalizeAliases, validateBody } from '../../src/core/validate.js'
import type { ParamFile } from '../../src/core/registry/params.js'
import type { EndpointSpec } from '../../src/core/registry/index.js'

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

const spec = (id = 'a.b'): EndpointSpec => ({
  id, title: 't', method: 'POST', path: '/x', direction: 'outbound',
  callable: true, dangerous: false, auth: 'checksum', verified: false, envelope: null,
})
const jsonFile = (params: Array<{ name: string; in: 'body' | 'query'; required: boolean; type?: string }>): ParamFile => ({
  params: params as never, bodyKind: 'json', responseShape: { kind: 'object' },
})

describe('validateBody —— 硬规则', () => {
  it('缺必填 → hard（消息点名字段 + 提示 api schema）', () => {
    const r = validateBody(spec(), jsonFile([{ name: 'robotId', in: 'body', required: true, type: 'integer' }]), {}, undefined, { strict: false })
    expect(r.hard).toHaveLength(1)
    expect(r.hard[0].field).toBe('robotId')
    expect(r.hard[0].message).toMatch(/robotId/)
    expect(r.hard[0].message).toMatch(/api schema/)
  })
  it('未传 body（undefined）→ hard，消息点明「未传 --body」', () => {
    const r = validateBody(spec(), jsonFile([{ name: 'robotId', in: 'body', required: true }]), undefined, undefined, { strict: false })
    expect(r.hard[0].message).toMatch(/未传 --body/)
  })
  it('非对象 body + 有 body 表 → hard（kind=non_object_body；null/数组 各出对应渲染词）', () => {
    for (const v of [null, [], 'x', 1]) {
      const r = validateBody(spec(), jsonFile([{ name: 'robotId', in: 'body', required: true }]), v, undefined, { strict: false })
      expect(r.hard).toHaveLength(1)
      expect(r.hard[0].kind).toBe('non_object_body')
    }
    const m = validateBody(spec(), jsonFile([{ name: 'robotId', in: 'body', required: true }]), null, undefined, { strict: false }).hard[0].message
    expect(m).toMatch(/null/)
    const ma = validateBody(spec(), jsonFile([{ name: 'robotId', in: 'body', required: true }]), [], undefined, { strict: false }).hard[0].message
    expect(ma).toMatch(/数组/)
  })
  it('null 值算存在（不触发缺必填），但触发 type_mismatch（软）', () => {
    const r = validateBody(spec(), jsonFile([{ name: 'robotId', in: 'body', required: true, type: 'integer' }]), { robotId: null }, undefined, { strict: false })
    expect(r.hard).toEqual([])
    expect(r.soft.some((w) => w.kind === 'type_mismatch' && w.field === 'robotId')).toBe(true)
  })
  it('one-of：组内任一存在即满足；全缺 → hard 用 override message', () => {
    const file = jsonFile([{ name: 'userName', in: 'body', required: true }, { name: 'code', in: 'body', required: true }, { name: 'shopCode', in: 'body', required: true }])
    const ov = { relaxRequired: ['code', 'shopCode'], oneOf: [{ anyOf: ['code', 'shopCode'], message: 'M' }] }
    expect(validateBody(spec(), file, { userName: 1, code: 2 }, ov, { strict: false }).hard).toEqual([])
    const r = validateBody(spec(), file, {}, ov, { strict: false })
    expect(r.hard.map((h) => h.message).join('\n')).toMatch(/M/)
    expect(r.hard.map((h) => h.message).join('\n')).toMatch(/userName/)
    expect(r.hard.map((h) => h.kind)).toEqual(['missing_required', 'one_of_missing'])
    expect(r.hard[0].message).toMatch(/userName/)
  })
})

describe('validateBody —— 软规则与 strict', () => {
  it('unknown_field 只软；strict 下升硬', () => {
    const file = jsonFile([{ name: 'robotId', in: 'body', required: true }])
    const soft = validateBody(spec(), file, { robotId: 1, bogus: 1 }, undefined, { strict: false })
    expect(soft.hard).toEqual([])
    expect(soft.soft[0]).toMatchObject({ kind: 'unknown_field', field: 'bogus' })
    const strict = validateBody(spec(), file, { robotId: 1, bogus: 1 }, undefined, { strict: true })
    expect(strict.hard.some((h) => h.field === 'bogus')).toBe(true)
    expect(strict.soft).toEqual([])
    const hb = strict.hard.find((h) => h.field === 'bogus')!
    expect(hb.message).not.toMatch(/已(随请求)?发出|已经发出/)
    expect(hb.message).toMatch(/不要删字段/)
  })
  it('type_mismatch：integer 收到字符串 "1" 判 mismatch；strict 升硬', () => {
    const file = jsonFile([{ name: 'robotId', in: 'body', required: true, type: 'integer' }])
    expect(validateBody(spec(), file, { robotId: '1' }, undefined, { strict: false }).soft.some((w) => w.kind === 'type_mismatch')).toBe(true)
    const strictTm = validateBody(spec(), file, { robotId: '1' }, undefined, { strict: true })
    expect(strictTm.hard.some((h) => h.kind === 'type_mismatch')).toBe(true)
    expect(strictTm.hard.find((h) => h.kind === 'type_mismatch')!.message).toMatch(/不要删字段/)
  })
  it('type_mismatch 的 <实际类型> 用固定词 null/数组/string，不用 typeof', () => {
    const file = jsonFile([{ name: 'robotId', in: 'body', required: true, type: 'integer' }])
    const m = validateBody(spec(), file, { robotId: null }, undefined, { strict: false }).soft[0].message
    expect(m).toMatch(/null/)
    const m2 = validateBody(spec(), file, { robotId: [] }, undefined, { strict: false }).soft[0].message
    expect(m2).toMatch(/数组/)
  })
  it('硬违规短路：有 hard 时 soft 为空', () => {
    const file = jsonFile([{ name: 'robotId', in: 'body', required: true }])
    const r = validateBody(spec(), file, { bogus: 1 }, undefined, { strict: false })
    expect(r.hard.length).toBeGreaterThan(0)
    expect(r.soft).toEqual([])
  })
  it('has_body_schema=false（json 但 0 body 参数）→ 不比对、不报', () => {
    const file = jsonFile([{ name: 'appKey', in: 'query', required: true }])
    expect(validateBody(spec(), file, { foo: 1 }, undefined, { strict: false })).toEqual({ hard: [], soft: [] })
    expect(validateBody(spec(), file, [], undefined, { strict: false })).toEqual({ hard: [], soft: [] })
  })
  it('has_body_schema=false（xml 但 14 body 参数）：不比对字段；传了 body → 只出 non_json_body（软）', () => {
    const file: ParamFile = { params: Array.from({ length: 14 }, (_, i) => ({ name: `f${i}`, in: 'body', required: true })) as never, bodyKind: 'xml', responseShape: { kind: 'object' } }
    expect(validateBody(spec(), file, undefined, undefined, { strict: false })).toEqual({ hard: [], soft: [] })
    const r = validateBody(spec(), file, [], undefined, { strict: false })
    expect(r.hard).toEqual([])
    expect(r.soft).toHaveLength(1)
    expect(r.soft[0]).toMatchObject({ kind: 'non_json_body' })
    expect(r.soft[0].message).toMatch(/已(随请求)?发出|已经发出/)
    expect(r.soft[0].message).toMatch(/不要重发/)
    expect(r.soft[0].message).not.toMatch(/未验证/)
  })
})

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
