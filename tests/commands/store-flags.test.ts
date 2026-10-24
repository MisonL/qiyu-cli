import { describe, it, expect } from 'vitest'
import { parseStoreFlags, STORE_VALUE_FLAG_NAMES } from '../../src/commands/store-flags.js'

describe('parseStoreFlags', () => {
  it('解析三个值位', () => {
    expect(parseStoreFlags(['--db', '/x', '--profile', 'p', '--backend', 'duckdb']))
      .toEqual({ db: '/x', profile: 'p', backend: 'duckdb', rest: [] })
  })
  it('未出现的键不存在于结果里（不是 undefined 键）', () => {
    const r = parseStoreFlags(['--db', '/x'])
    expect(Object.keys(r).sort()).toEqual(['db', 'rest'])
  })
  it('非 flag token 进 rest', () => {
    expect(parseStoreFlags(['a', '--db', '/x', 'b']).rest).toEqual(['a', 'b'])
  })
  it.each(['--db', '--profile', '--backend'])('%s 缺值报「缺少取值」', (flag) => {
    expect(() => parseStoreFlags([flag])).toThrow(`${flag} 缺少取值`)
  })
  it.each(['--db', '--profile', '--backend'])('%s 的值以 -- 开头时报缺值（防止吞下下一个 flag）', (flag) => {
    expect(() => parseStoreFlags([flag, '--profile', 'p'])).toThrow(`${flag} 缺少取值`)
  })
  it('STORE_VALUE_FLAG_NAMES 与解析器接受的一致', () => {
    for (const f of STORE_VALUE_FLAG_NAMES) {
      expect(Object.keys(parseStoreFlags([f, 'v']))).toContain(f.slice(2))
    }
  })
})
