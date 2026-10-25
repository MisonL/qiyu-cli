// tests/commands/credentials-source.test.ts —— 凭证来源合流（G1 / PR 3）
//
// 三处调用点（api / sync / sync-run）共用这一份合流逻辑。此前它们各自手写
// `resolveCredentials({}, { appKey: process.env.QIYU_APP_KEY, … })`，配置文件
// 在 G1 之前根本不是来源 —— `auth login` 写进去的凭证因而对谁都不可见。
//
// ⚠️ 每条用例都在临时 HOME 里跑（不隔离就会读开发机真实的配置文件）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveCredentialsUsingFile } from '../../src/commands/credentials-source.js'

let home = ''
const cfgPath = (): string => join(home, '.config', 'qiyu', 'config.json')

function writeCfg(obj: unknown, mode = 0o600): void {
  mkdirSync(join(home, '.config', 'qiyu'), { recursive: true })
  writeFileSync(cfgPath(), JSON.stringify(obj))
  chmodSync(cfgPath(), mode)
}

const FILE_OK = { profiles: { default: { credentials: { appKey: 'fk', appSecret: 'fs' } } } }

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qiyu-credsrc-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('QIYU_PROFILE', '')
})
afterEach(() => { vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }) })

describe('环境变量 > 配置文件', () => {
  it('两个都齐 → 用 env，且**不读**文件（文件就算是坏的不影响）', () => {
    // ⚠️ 这条是"env 完整时不读文件"契约的直接证明：文件被写成畸形 JSON，
    // 若实现无条件读文件，这里会带出「配置文件不是合法 JSON」的 warn 或直接失败。
    writeFileSync(join(home, 'x'), '')
    mkdirSync(join(home, '.config', 'qiyu'), { recursive: true })
    writeFileSync(cfgPath(), '{ 坏 JSON')
    const r = resolveCredentialsUsingFile({ appKey: 'ek', appSecret: 'es' }, { configPath: cfgPath() })
    expect(r).toEqual({ ok: true, creds: { appKey: 'ek', appSecret: 'es' } })
  })

  it('env 只给一个 → 另一个从文件补（合法组合，不是错误）', () => {
    writeCfg(FILE_OK)
    const r = resolveCredentialsUsingFile({ appKey: 'ek' }, { configPath: cfgPath() })
    expect(r).toEqual({ ok: true, creds: { appKey: 'ek', appSecret: 'fs' } })
  })

  it('env 全缺 → 两个都来自文件（`auth login` 写入后的典型形态）', () => {
    writeCfg(FILE_OK)
    const r = resolveCredentialsUsingFile({}, { configPath: cfgPath() })
    expect(r).toEqual({ ok: true, creds: { appKey: 'fk', appSecret: 'fs' } })
  })

  it('env 的空串视为未设置（shell 里 `export X=` 的形态）', () => {
    writeCfg(FILE_OK)
    const r = resolveCredentialsUsingFile({ appKey: '', appSecret: '' }, { configPath: cfgPath() })
    expect(r).toEqual({ ok: true, creds: { appKey: 'fk', appSecret: 'fs' } })
  })

  it('按 QIYU_PROFILE 选 profile', () => {
    writeCfg({ profiles: {
      prod: { credentials: { appKey: 'pk', appSecret: 'ps' } },
      staging: { credentials: { appKey: 'sk', appSecret: 'ss' } },
    } })
    vi.stubEnv('QIYU_PROFILE', 'staging')
    const r = resolveCredentialsUsingFile({}, { configPath: cfgPath() })
    expect(r).toEqual({ ok: true, creds: { appKey: 'sk', appSecret: 'ss' } })
  })
})

describe('失败路径', () => {
  it('两处都没有 → auth_missing（退出码 1），hint 同时给 login 与环境变量', () => {
    const r = resolveCredentialsUsingFile({}, { configPath: cfgPath() })
    expect(r.ok).toBe(false)
    const e = (r as { error: { kind: string; hint: string } }).error
    expect(e.kind).toBe('auth_missing')
    // ⚠️ G1 起 hint **可以**指向 auth login —— 它真的存在了（旧文案只能提环境变量）。
    expect(e.hint).toMatch(/auth login/)
    expect(e.hint).toMatch(/QIYU_APP_KEY/)
  })

  it('含凭证且权限过宽 → config_insecure 原样透出（不被降级成 auth_missing）', () => {
    // ⚠️ 这条钉的是"安全问题不许被瞒下"：env 缺项时才读文件，所以这正是
    // 用户真的要用的那份文件 —— 它权限过宽必须拒绝，而不是"读不到就当没配"。
    writeCfg(FILE_OK, 0o644)
    const r = resolveCredentialsUsingFile({}, { configPath: cfgPath() })
    expect(r.ok).toBe(false)
    const e = (r as { error: { kind: string; hint?: string } }).error
    expect(e.kind).toBe('config_insecure')
    expect(e.hint).toMatch(/chmod 600/)
  })

  it('配置文件畸形 → 仍报 auth_missing，但把真正的原因说出来', () => {
    mkdirSync(join(home, '.config', 'qiyu'), { recursive: true })
    writeFileSync(cfgPath(), '{ 坏 JSON')
    const r = resolveCredentialsUsingFile({}, { configPath: cfgPath() })
    expect(r.ok).toBe(false)
    const e = (r as { error: { kind: string; message: string } }).error
    expect(e.kind).toBe('auth_missing')
    // 只说"请设置环境变量"的话，用户照做后仍然可能被坏文件挡住，而它无从知道原因。
    expect(e.message).toMatch(/配置文件/)
  })
})
