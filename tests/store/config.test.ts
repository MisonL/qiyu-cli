// tests/store/config.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveStoreConfig } from '../../src/store/config.js'

let home = ''
const writeCfg = (obj: unknown): string => {
  const dir = join(home, '.config', 'qiyu')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'config.json')
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj))
  return p
}
beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'qiyu-home-')) })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('store 配置 —— 默认值与三级优先级', () => {
  // ⚠️ C1 范围注记（如实标注）：三级优先级对 **path** 逐级断言可完整验证；
  // backend 的三级（flag/env/文件）C1 仅「设置存在即可达」——因为 C1 只有一个
  // 后端，逐级覆盖断言留到 C2 引入第二个后端时补（spec §3.1 的交接）。
  it('未设任何配置时走内置默认', () => {
    const { config } = resolveStoreConfig({ home })
    expect(config.backend).toBe('duckdb')
    expect(config.path).toBe(join(home, '.qiyu', 'duckdb', 'qiyu.duckdb'))
    expect(config.readOnlyRetryMs).toBe(30000)
    expect(config.batchSize).toBe(1000)
  })

  it('配置文件 store.path 覆盖默认', () => {
    writeCfg({ profiles: { default: { store: { path: '/tmp/from-file.duckdb' } } } })
    expect(resolveStoreConfig({ home }).config.path).toBe('/tmp/from-file.duckdb')
  })

  it('QIYU_DB_PATH 覆盖配置文件', () => {
    writeCfg({ profiles: { default: { store: { path: '/tmp/from-file.duckdb' } } } })
    const env = { QIYU_DB_PATH: '/tmp/from-env.duckdb' }
    expect(resolveStoreConfig({ home, env }).config.path).toBe('/tmp/from-env.duckdb')
  })

  it('--db 覆盖 QIYU_DB_PATH', () => {
    const env = { QIYU_DB_PATH: '/tmp/from-env.duckdb' }
    const flags = { db: '/tmp/from-flag.duckdb' }
    expect(resolveStoreConfig({ home, env, flags }).config.path).toBe('/tmp/from-flag.duckdb')
  })

  it('~ 前缀展开为 home', () => {
    writeCfg({ profiles: { default: { store: { path: '~/db/x.duckdb' } } } })
    expect(resolveStoreConfig({ home }).config.path).toBe(join(home, 'db', 'x.duckdb'))
  })
})

describe('store 配置 —— profile 选择', () => {
  it('--profile 选中对应 profile 的 store 块', () => {
    writeCfg({ profiles: { default: { store: { path: '/tmp/d.duckdb' } }, prod: { store: { path: '/tmp/p.duckdb' } } } })
    expect(resolveStoreConfig({ home, flags: { profile: 'prod' } }).config.path).toBe('/tmp/p.duckdb')
  })

  it('未指定 profile 时用 defaultProfile', () => {
    writeCfg({ defaultProfile: 'prod', profiles: { default: { store: { path: '/tmp/d.duckdb' } }, prod: { store: { path: '/tmp/p.duckdb' } } } })
    expect(resolveStoreConfig({ home }).config.path).toBe('/tmp/p.duckdb')
  })

  it('QIYU_PROFILE 生效，且被 --profile 覆盖', () => {
    writeCfg({ profiles: { a: { store: { path: '/tmp/a.duckdb' } }, b: { store: { path: '/tmp/b.duckdb' } } } })
    expect(resolveStoreConfig({ home, env: { QIYU_PROFILE: 'a' } }).config.path).toBe('/tmp/a.duckdb')
    expect(resolveStoreConfig({ home, env: { QIYU_PROFILE: 'a' }, flags: { profile: 'b' } }).config.path).toBe('/tmp/b.duckdb')
  })

  it('profile 存在但缺 store 块 → 走默认', () => {
    writeCfg({ profiles: { prod: {} } })
    expect(resolveStoreConfig({ home, flags: { profile: 'prod' } }).config.path).toBe(join(home, '.qiyu', 'duckdb', 'qiyu.duckdb'))
  })
})

describe('store 配置 —— 后端与行为参数', () => {
  it('--backend 覆盖 QIYU_STORE_BACKEND 覆盖配置文件', () => {
    writeCfg({ profiles: { default: { store: { backend: 'duckdb' } } } })
    expect(resolveStoreConfig({ home, env: { QIYU_STORE_BACKEND: 'duckdb' }, flags: { backend: 'duckdb' } }).config.backend).toBe('duckdb')
  })

  it('行为参数来自配置文件', () => {
    writeCfg({ profiles: { default: { store: { readOnlyRetryMs: 5000, batchSize: 250 } } } })
    const { config } = resolveStoreConfig({ home })
    expect(config.readOnlyRetryMs).toBe(5000)
    expect(config.batchSize).toBe(250)
  })

  it('行为参数非正整数 → usage 错误并点名键路径', () => {
    for (const bad of [0, -1, 1.5, 'x' as unknown as number]) {
      writeCfg({ profiles: { default: { store: { batchSize: bad } } } })
      expect(() => resolveStoreConfig({ home }), `batchSize=${String(bad)}`).toThrow(/batchSize/)
    }
  })
})

describe('store 配置 —— fail-closed', () => {
  it('未知键（顶层）→ 报错点名完整路径', () => {
    writeCfg({ bogus: 1 })
    expect(() => resolveStoreConfig({ home })).toThrow(/bogus/)
  })

  it('未知键（store 块内）→ 报错点名完整路径', () => {
    writeCfg({ profiles: { default: { store: { backendd: 'x' } } } })
    expect(() => resolveStoreConfig({ home })).toThrow(/profiles\.default\.store\.backendd/)
  })

  it('未知键（profile 内、store 外）→ 报错', () => {
    writeCfg({ profiles: { default: { bogus: 1 } } })
    expect(() => resolveStoreConfig({ home })).toThrow(/profiles\.default\.bogus/)
  })

  it('store 块存在但非对象（字符串/数组/null）→ 显式报错（不静默走默认）', () => {
    writeCfg({ profiles: { default: { store: 'nope' } } })
    expect(() => resolveStoreConfig({ home })).toThrow(/profiles\.default\.store 必须是对象/)
    writeCfg({ profiles: { default: { store: [] } } })
    expect(() => resolveStoreConfig({ home })).toThrow(/profiles\.default\.store 必须是对象/)
    writeCfg({ profiles: { default: { store: null } } })
    expect(() => resolveStoreConfig({ home })).toThrow(/profiles\.default\.store 必须是对象/)
  })

  it('store 块缺键不报错（走默认）', () => {
    writeCfg({ profiles: { default: { store: { path: '/tmp/only-path.duckdb' } } } })
    const { config } = resolveStoreConfig({ home })
    expect(config.path).toBe('/tmp/only-path.duckdb')
    expect(config.batchSize).toBe(1000)
  })

  it('配置文件 JSON 畸形 → 报错含文件路径', () => {
    const p = writeCfg('{ not json')
    expect(() => resolveStoreConfig({ home })).toThrow(new RegExp(p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  it('store.path 非 string → fail-closed 点名键路径（K 组 M1）', () => {
    writeCfg({ profiles: { default: { store: { path: 123 } } } })
    expect(() => resolveStoreConfig({ home })).toThrow(/profiles\.default\.store\.path 必须是字符串/)
    writeCfg({ profiles: { default: { store: { path: { rel: 'x' } } } } })
    expect(() => resolveStoreConfig({ home })).toThrow(/store\.path 必须是字符串/)
  })

  it('defaultProfile 非 string → fail-closed（K 组 M2：否则静默走默认库）', () => {
    writeCfg({ defaultProfile: 2, profiles: { default: {}, prod: {} } })
    expect(() => resolveStoreConfig({ home })).toThrow(/defaultProfile 必须是字符串/)
  })

  it('profiles 为数组/字符串 → fail-closed（K 组 M2：防逐索引枚举出荒诞 profile 名）', () => {
    writeCfg({ profiles: [] })
    expect(() => resolveStoreConfig({ home })).toThrow(/profiles 必须是对象/)
    writeCfg({ profiles: 'x' })
    expect(() => resolveStoreConfig({ home })).toThrow(/profiles 必须是对象/)
  })

  it('readOnlyRetryMs/batchSize 超上界 → fail-closed 点名键路径（R 组 R4：1e15 会挂起 31 年）', () => {
    writeCfg({ profiles: { default: { store: { readOnlyRetryMs: 1e15 } } } })
    expect(() => resolveStoreConfig({ home })).toThrow(/readOnlyRetryMs 不得超过/)
    writeCfg({ profiles: { default: { store: { batchSize: 5_000_000 } } } })
    expect(() => resolveStoreConfig({ home })).toThrow(/batchSize 不得超过/)
  })

  it('空串路径 → usage 拒绝（K 组 M4：--db "" 穿透所有前置检查的同族事故）', () => {
    expect(() => resolveStoreConfig({ home, flags: { db: '' } })).toThrow(/路径不能为空/)
    expect(() => resolveStoreConfig({ home, flags: { db: '   ' } })).toThrow(/路径不能为空/)
    expect(() => resolveStoreConfig({ home, env: { QIYU_DB_PATH: '' } })).toThrow(/路径不能为空/)
  })
})

describe('store 配置 —— 权限检查', () => {
  it('group/other 可读 → 不抛错（仅警告）', () => {
    const p = writeCfg({ profiles: { default: {} } })
    chmodSync(p, 0o644)
    // stderr 警告断言：警告文案进 stderr，不进 JSON 输出（spec §3.4）
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => resolveStoreConfig({ home })).not.toThrow()
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('权限过宽'))
    } finally {
      errSpy.mockRestore()
    }
  })

  it('0o600（仅所有者）→ 不警告', () => {
    const p = writeCfg({ profiles: { default: {} } })
    chmodSync(p, 0o600)
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => resolveStoreConfig({ home })).not.toThrow()
      expect(errSpy).not.toHaveBeenCalled()
    } finally {
      errSpy.mockRestore()
    }
  })

  it('0o606（other 含写位）→ 警告（写位同查，I 组 M2/L3）', () => {
    const p = writeCfg({ profiles: { default: {} } })
    chmodSync(p, 0o606)
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => resolveStoreConfig({ home })).not.toThrow()
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('权限过宽'))
    } finally {
      errSpy.mockRestore()
    }
  })

  it('父目录权限过宽 → 警告「配置目录」（I 组 M2，spec §3.4 v3 扩面）', () => {
    const p = writeCfg({ profiles: { default: {} } })
    chmodSync(p, 0o600)
    chmodSync(join(home, '.config', 'qiyu'), 0o777)
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
    try {
      expect(() => resolveStoreConfig({ home })).not.toThrow()
      expect(errSpy).toHaveBeenCalledWith(expect.stringMatching(/配置目录.*权限过宽/))
    } finally {
      errSpy.mockRestore()
      chmodSync(join(home, '.config', 'qiyu'), 0o755)   // 还原，防污染后续用例
    }
  })

  it('文件不存在 → configExists=false 且不报错', () => {
    const r = resolveStoreConfig({ home })
    expect(r.configExists).toBe(false)
    expect(r.configPath).toBe(join(home, '.config', 'qiyu', 'config.json'))
  })
})
