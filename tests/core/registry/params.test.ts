import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadParams, validateParamsFile, setParamsRoot } from '../../../src/core/registry/params.js'

function makeRoot(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), 'qiyu-params-'))
  mkdirSync(join(dir, 'params'), { recursive: true })
  for (const [id, content] of Object.entries(files)) {
    const p = join(dir, 'params', `${id}.json`)
    writeFileSync(p, typeof content === 'string' ? content : JSON.stringify(content))
  }
  return dir
}

let root: string | undefined
afterEach(() => {
  // ⚠️ 必须复位：setParamsRoot 设的是模块级单例，不复位会污染同文件后续用例。
  setParamsRoot(undefined)
  if (root) { rmSync(root, { recursive: true, force: true }); root = undefined }
})

describe('loadParams', () => {
  it('从注入的 root 读到 params 文件并返回结构校验后的对象', () => {
    root = makeRoot({ 'x.y': { params: [
      { name: 'robotId', in: 'body', required: true, type: 'integer' },
      { name: 'appKey', in: 'query', required: true, type: 'string' },
    ], bodyKind: 'json', responseShape: { kind: 'object' } } })
    setParamsRoot(root)
    const f = loadParams('x.y')
    expect(f.bodyKind).toBe('json')
    expect(f.params).toHaveLength(2)
    expect(f.responseShape).toEqual({ kind: 'object' })
  })

  it('缓存键是 (root,id)：不同 root 不互相污染', () => {
    const r1 = makeRoot({ 'x.y': { params: [], bodyKind: 'none', responseShape: { kind: 'none' } } })
    const r2 = makeRoot({ 'x.y': { params: [], bodyKind: 'json', responseShape: { kind: 'object' } } })
    try {
      setParamsRoot(r1); expect(loadParams('x.y').bodyKind).toBe('none')
      setParamsRoot(r2); expect(loadParams('x.y').bodyKind).toBe('json')
      setParamsRoot(r1); expect(loadParams('x.y').bodyKind).toBe('none')
    } finally { rmSync(r1, { recursive: true, force: true }); rmSync(r2, { recursive: true, force: true }) }
  })

  it('文件缺失 → 抛 kind:internal', () => {
    root = makeRoot({})
    setParamsRoot(root)
    let caught: unknown
    try { loadParams('missing.id') } catch (e) { caught = e }
    expect((caught as { kind?: string }).kind).toBe('internal')
  })

  it('畸形 JSON → 抛 kind:internal', () => {
    root = makeRoot({ 'x.y': '{ 不是 json' })
    setParamsRoot(root)
    let caught: unknown
    try { loadParams('x.y') } catch (e) { caught = e }
    expect((caught as { kind?: string }).kind).toBe('internal')
  })
})

describe('validateParamsFile', () => {
  it('bodyKind 非法 → 抛', () => {
    expect(() => validateParamsFile('x.y', { params: [], bodyKind: 'jsonx', responseShape: { kind: 'object' } })).toThrow()
  })
  it('in 非法 → 抛', () => {
    expect(() => validateParamsFile('x.y', { params: [{ name: 'a', in: 'cookies', required: true }], bodyKind: 'json', responseShape: { kind: 'object' } })).toThrow()
  })
  it('required 非布尔 → 抛', () => {
    expect(() => validateParamsFile('x.y', { params: [{ name: 'a', in: 'body', required: 'yes' }], bodyKind: 'json', responseShape: { kind: 'object' } })).toThrow()
  })
  it('同名字段跨 in（body + query）→ 抛', () => {
    expect(() => validateParamsFile('x.y', { params: [
      { name: 'dup', in: 'body', required: true }, { name: 'dup', in: 'query', required: true },
    ], bodyKind: 'json', responseShape: { kind: 'object' } })).toThrow()
  })
  it('顶层非对象 → 抛', () => {
    expect(() => validateParamsFile('x.y', null)).toThrow()
  })
})
