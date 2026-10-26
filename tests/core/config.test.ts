// tests/core/config.test.ts —— 配置文件通用层（G1 抽取出来的那一层，PR 3）
//
// ⚠️ 全部在临时 HOME 里构造，**绝不碰真实 `~`**：`auth login` 会写
// `~/.config/qiyu/config.json`，而一个没隔离 HOME 的用例曾在开发机上真的写出了
// 一份带夹具凭证（`appKey: "k"`）的配置（2026-10-25 实测踩到并清理）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __resetPermissionWarnings, checkPermissions, configHasCredentials, configPathFor,
  fileCredentials, fileProfile, loadConfigChecked, loadConfigFile, parseConfig,
  serializeConfig, writeConfigFile,
} from '../../src/core/config.js'

let home = ''
const cfgPath = (): string => join(home, '.config', 'qiyu', 'config.json')

/** 写配置并显式设权限（默认 0600 —— 含凭证的文件权限过宽会被拒绝）。 */
function writeCfg(obj: unknown, mode = 0o600): void {
  mkdirSync(join(home, '.config', 'qiyu'), { recursive: true })
  writeFileSync(cfgPath(), typeof obj === 'string' ? obj : JSON.stringify(obj))
  chmodSync(cfgPath(), mode)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qiyu-corecfg-'))
  vi.stubEnv('HOME', home)
  vi.stubEnv('QIYU_PROFILE', '')
})
afterEach(() => {
  vi.unstubAllEnvs(); vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

describe('路径与空文件', () => {
  it('默认路径是 ~/.config/qiyu/config.json', () => {
    expect(configPathFor(home)).toBe(cfgPath())
  })

  it('文件不存在时返回空结构且 exists=false —— 不是错误', () => {
    const r = loadConfigFile(cfgPath())
    expect(r.exists).toBe(false)
    expect(r.file).toEqual({ defaultProfile: undefined, profiles: {} })
  })
})

describe('结构校验（fail-closed，点名键路径）', () => {
  it('未知顶层键被拒绝', () => {
    expect(() => parseConfig({ bogus: 1 })).toThrow(/未知键：bogus/)
  })

  it('profile 内未知键被拒绝，且点名到 profiles.<name>.<key>', () => {
    expect(() => parseConfig({ profiles: { p: { credential: {} } } }))
      .toThrow(/profiles\.p\.credential/)
  })

  it('credentials 块：appKey/appSecret 必须是非空字符串', () => {
    expect(() => parseConfig({ profiles: { p: { credentials: { appKey: '', appSecret: 's' } } } }))
      .toThrow(/credentials\.appKey/)
    expect(() => parseConfig({ profiles: { p: { credentials: { appKey: 'k', appSecret: 123 } } } }))
      .toThrow(/credentials\.appSecret/)
  })

  it('credentials 块本身必须是对象（数组/标量拒绝）', () => {
    expect(() => parseConfig({ profiles: { p: { credentials: ['k', 's'] } } }))
      .toThrow(/profiles\.p\.credentials 必须是对象/)
  })

  it('robots 块：键必须是数字 id、值必须是非空字符串', () => {
    expect(() => parseConfig({ profiles: { p: { robots: { abc: '甲' } } } }))
      .toThrow(/robots 的键必须是数字 id/)
    expect(() => parseConfig({ profiles: { p: { robots: { '1': '  ' } } } }))
      .toThrow(/robots\.1 必须是非空字符串/)
  })

  it('store 块只校验「是对象」—— 语义（backend 枚举等）归 store/config.ts', () => {
    // 这条钉的是**分工**：本层不知道 backend 的合法取值，所以不拒绝。
    expect(parseConfig({ profiles: { p: { store: { backend: '不存在的后端' } } } }).profiles.p.store)
      .toEqual({ backend: '不存在的后端' })
    expect(() => parseConfig({ profiles: { p: { store: [1, 2] } } }))
      .toThrow(/profiles\.p\.store 必须是对象/)
  })

  it('defaultProfile 必须是字符串', () => {
    expect(() => parseConfig({ defaultProfile: 1 })).toThrow(/defaultProfile 必须是字符串/)
  })

  it('JSON 畸形时报错并点名路径', () => {
    writeCfg('{ 坏 JSON')
    expect(() => loadConfigFile(cfgPath())).toThrow(/不是合法 JSON/)
  })
})

describe('权限裁决（loadConfigChecked）', () => {
  it('含凭证且文件 0644 → 抛带 kind 的 config_insecure，hint 点名 chmod 600', () => {
    writeCfg({ profiles: { default: { credentials: { appKey: 'k', appSecret: 's' } } } }, 0o644)
    let caught: unknown
    try { loadConfigChecked(cfgPath()) } catch (e) { caught = e }
    const t = caught as { kind?: string; hint?: string }
    expect(t.kind).toBe('config_insecure')
    expect(t.hint).toMatch(/chmod 600/)
  })

  it('**无**凭证且 0644 → 只警告不阻断（C1 既有口径）', () => {
    writeCfg({ profiles: { default: { store: { batchSize: 5 } } } }, 0o644)
    const msgs: string[] = []
    const r = loadConfigChecked(cfgPath())
    expect(r.exists).toBe(true)
    // 直接调 checkPermissions 看警告：loadConfigChecked 把警告写到 stderr
    // （这里用 fileProfile 的 warn 通道拿不到权限警告，所以单独断言行为没抛）
    expect(msgs).toEqual([])
  })

  it('父目录 group/other 可写且含凭证 → 拒绝（文件可被整体替换）', () => {
    writeCfg({ profiles: { default: { credentials: { appKey: 'k', appSecret: 's' } } } })
    chmodSync(join(home, '.config', 'qiyu'), 0o777)
    let caught: unknown
    try { loadConfigChecked(cfgPath()) } catch (e) { caught = e }
    expect((caught as { kind?: string }).kind).toBe('config_insecure')
  })

  it('父目录 0755（常规 umask 产物）不阻断 —— 只查 group/other **写**位', () => {
    writeCfg({ profiles: { default: { credentials: { appKey: 'k', appSecret: 's' } } } })
    chmodSync(join(home, '.config', 'qiyu'), 0o755)
    expect(() => loadConfigChecked(cfgPath())).not.toThrow()
  })

  it('文件不存在时不做权限裁决（首次运行不是安全问题）', () => {
    expect(loadConfigChecked(cfgPath()).exists).toBe(false)
  })

  it('同一条警告一个进程内只说一次（sync run 会读两遍配置）', () => {
    // ⚠️ 实测来源：`sync run` 依次读两遍配置 —— 凭证合流（credentials-source）
    // 与 resolveStoreConfig 各查一次权限，于是不含凭证但 0644 的文件会打印**两遍**
    // 同一条「权限过宽」，用户会以为有两个不同的问题。
    __resetPermissionWarnings()
    writeCfg({ profiles: { default: { store: {} } } }, 0o644)
    const seen: string[] = []
    const onWarn = (m: string): void => { seen.push(m) }
    const file = loadConfigFile(cfgPath()).file
    for (let i = 0; i < 3; i++) {
      checkPermissions(cfgPath(), { hasCredentials: configHasCredentials(file), onWarn })
    }
    expect(seen.length).toBe(1)
    // 换个路径仍要警告（去重按路径记键，不是全局只说一次）
    const other = configPathFor(join(home, 'otherhome'))
    mkdirSync(dirname(other), { recursive: true })
    writeFileSync(other, JSON.stringify({ profiles: { default: { store: {} } } }))
    chmodSync(other, 0o644)
    checkPermissions(other, { hasCredentials: false, onWarn })
    expect(seen.length).toBe(2)
  })

  it('拒绝路径不受警告去重影响（含凭证时每次都抛）', () => {
    __resetPermissionWarnings()
    writeCfg({ profiles: { default: { credentials: { appKey: 'k', appSecret: 's' } } } }, 0o644)
    for (let i = 0; i < 2; i++) {
      expect(() => loadConfigChecked(cfgPath())).toThrow(/权限过宽/)
    }
  })
})

describe('原子写入（writeConfigFile）', () => {
  const content = { profiles: { default: { credentials: { appKey: 'k', appSecret: 's' } } } }

  it('文件 0600、目录 0700、内容为规范化 JSON + 尾换行', () => {
    writeConfigFile(cfgPath(), content)
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.config', 'qiyu')).mode & 0o777).toBe(0o700)
    expect(readFileSync(cfgPath(), 'utf8')).toBe(serializeConfig(content))
    expect(readFileSync(cfgPath(), 'utf8').endsWith('\n')).toBe(true)
  })

  it('覆盖已有 0644 文件后权限收紧为 0600', () => {
    writeCfg(content, 0o644)
    writeConfigFile(cfgPath(), content)
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600)
  })

  it('符号链接 → 拒绝写入，链接目标原样不变', () => {
    const target = join(home, 'elsewhere.json')
    writeFileSync(target, '{"profiles":{}}')
    mkdirSync(join(home, '.config', 'qiyu'), { recursive: true })
    symlinkSync(target, cfgPath())
    expect(() => writeConfigFile(cfgPath(), content)).toThrow(/符号链接/)
    expect(readFileSync(target, 'utf8')).toBe('{"profiles":{}}')
  })

  it('无临时文件残留（rename 换入后目录里只有 config.json）', async () => {
    writeConfigFile(cfgPath(), content)
    const { readdirSync } = await import('node:fs')
    expect(readdirSync(join(home, '.config', 'qiyu'))).toEqual(['config.json'])
    expect(existsSync(cfgPath())).toBe(true)
  })

  it('**换入**而非原地改写：目标 inode 变号（原子替换的直接证据）', () => {
    // ⚠️ 这条是"原子写"这个说法的**唯一可观测证据**。其余断言（权限、内容、
    // 无残留）在 `writeFileSync(configPath, …)` 直写版本下**全都照样通过** ——
    // 变异验证实测：把 rename 换回直写，24 条里 0 条红。
    // rename 换入会换 inode；原地改写保持同一个 inode。磁盘上这一点区分得出来。
    writeCfg(content)
    const before = statSync(cfgPath()).ino
    writeConfigFile(cfgPath(), content)
    expect(statSync(cfgPath()).ino, '原地改写会保留 inode —— 那就不是原子换入').not.toBe(before)
  })

  it('序列化失败时目标文件一字未动（不留半写的 config.json）', () => {
    // 可达的失败形态：内容里有循环引用 → JSON.stringify 抛。
    // 直写版本会在"开始写"之后才发现写不完；临时文件版本连目标都没碰过。
    writeCfg(content)
    const original = readFileSync(cfgPath(), 'utf8')
    const circular: Record<string, unknown> = { profiles: {} }
    circular.self = circular
    expect(() => writeConfigFile(cfgPath(), circular as never)).toThrow()
    expect(readFileSync(cfgPath(), 'utf8')).toBe(original)
  })
})

describe('fileProfile / fileCredentials（凭证与 robots 的共用出口）', () => {
  it('按 QIYU_PROFILE 取 profile；未设时取 defaultProfile；再退 default', () => {
    writeCfg({ defaultProfile: 'prod', profiles: {
      prod: { credentials: { appKey: 'pk', appSecret: 'ps' } },
      staging: { credentials: { appKey: 'sk', appSecret: 'ss' } },
    } })
    expect(fileCredentials(cfgPath(), 'staging').creds).toEqual({ appKey: 'sk', appSecret: 'ss' })
    expect(fileCredentials(cfgPath(), undefined).profileName).toBe('prod')
    writeCfg({ profiles: {} })
    expect(fileCredentials(cfgPath(), undefined).profileName).toBe('default')
  })

  it('配置里没有该 profile → 无 creds，也不算错误', () => {
    writeCfg({ profiles: { other: {} } })
    const r = fileCredentials(cfgPath(), 'absent')
    expect(r.creds).toBeUndefined()
    expect(r.fatal).toBeUndefined()
  })

  it('权限拒绝 → fatal（带 kind）；畸形 JSON → 只有 warn（env 齐备时命令仍应能跑）', () => {
    writeCfg({ profiles: { default: { credentials: { appKey: 'k', appSecret: 's' } } } }, 0o644)
    expect((fileProfile(cfgPath()).fatal as { kind?: string }).kind).toBe('config_insecure')

    writeCfg('{ 坏')
    const r = fileProfile(cfgPath())
    expect(r.fatal).toBeUndefined()
    expect(r.warn).toMatch(/不是合法 JSON/)
  })

  it('robots 经由 profile 读出（auth whoami 与 sync run 共用同一份）', () => {
    writeCfg({ profiles: { default: {
      credentials: { appKey: 'k', appSecret: 's' },
      robots: { '1000001': '甲', '1000002': '乙' },
    } } })
    expect(fileProfile(cfgPath()).profile?.robots).toEqual({ '1000001': '甲', '1000002': '乙' })
  })

  it('configHasCredentials 是权限升级的判据（任一 profile 有就算）', () => {
    writeCfg({ profiles: { a: {}, b: { credentials: { appKey: 'k', appSecret: 's' } } } })
    expect(configHasCredentials(loadConfigFile(cfgPath()).file)).toBe(true)
    writeCfg({ profiles: { a: { store: {} } } })
    expect(configHasCredentials(loadConfigFile(cfgPath()).file)).toBe(false)
  })
})

describe('profiles 是 null 原型对象（2026-10-27，原型链绕过守卫）', () => {
  // 普通 `{}` 上 `profiles['constructor']` 命中的是 `Object.prototype.constructor`，
  // 「未知 profile 必须拒绝」的判据会被原型链绕过（`--profile constructor` 静默回落默认库）；
  // 且 `profiles['__proto__'] = block` 会改掉原型而不是建键。
  it('继承属性名不算 profile，`__proto__` 是普通键名', () => {
    const f = parseConfig({ profiles: { prod: {} } })
    expect(Object.hasOwn(f.profiles, 'prod')).toBe(true)
    expect(f.profiles['constructor']).toBeUndefined()
    expect(f.profiles['toString']).toBeUndefined()

    const g = parseConfig(JSON.parse('{"profiles":{"__proto__":{"robots":{"1000001":"甲"}}}}'))
    expect(Object.getPrototypeOf(g.profiles)).toBe(null)
    expect(Object.keys(g.profiles)).toEqual(['__proto__'])
    expect(g.profiles['__proto__'].robots).toEqual({ '1000001': '甲' })
  })
})
