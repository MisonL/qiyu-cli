// tests/skill/detect.test.ts —— 安装态探测（Task 10，设计稿 D2.1）。
//
// 全部在临时目录里构造实体与源目录，绝不读写真实 `~`。`resolveEntityDir()` 的
// `NODE_ENV === 'test'` 门有独立用例：测试环境下不探测真实路径，探测结果因此
// 不依赖「开发者机器上装没装过 skill」。
//
// 判定矩阵（brief 原文）：
//   · 实体缺失 → absent；
//   · manifest 版本不同 → stale（带 installedVersion）；
//   · 版本与哈希都一致 → current；
//   · 实体在但 manifest 缺失/损坏 → stale（版本记 'unknown'）；
//   · 实体不可读 → unknown，且不抛。
// 「哈希」指 manifest 里记录的 content_hash 与**包内**（sourceDir）的内容哈希是否
// 一致 —— 探测只读清单、不读实体正文（spec D2.1 的「零成本」）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  __resetSkillDetectionForTest, detectSkillState, resolveEntityDir, resolveSkillSourceDir, skillWarning,
} from '../../src/skill/detect.js'
import { contentHash, MANIFEST } from '../../src/skill/install.js'
import { defaultEntityDir } from '../../src/skill/paths.js'
import { PACKAGE_VERSION, SKILL_CONTRACT_VERSION } from '../../src/core/edition.js'

let home: string

beforeEach(() => {
  // macOS 上 `/var` 指向 `/private/var`：realpath 归一化后路径字符串才稳定可比。
  home = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-detect-')))
  __resetSkillDetectionForTest()
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  __resetSkillDetectionForTest()
})

/** 写文件（自动建父目录）。 */
function write(dir: string, rel: string, content: string): void {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

/** 包内 skill 源目录：两个文件，足够让哈希有区分度。 */
function makeSource(): string {
  const src = join(home, 'pkg-skill')
  write(src, 'SKILL.md', '# qiyu\n')
  write(src, 'protocols.md', '协议正文\n')
  return src
}

/** 在实体目录里放一份「与源一致」的正文 + 指定版本/哈希的清单。 */
function installEntity(entity: string, src: string, version: string, hash = contentHash(src)): void {
  write(entity, 'SKILL.md', '# qiyu\n')
  write(entity, 'protocols.md', '协议正文\n')
  write(entity, MANIFEST, JSON.stringify({
    version,
    skill_contract_version: SKILL_CONTRACT_VERSION,
    content_hash: hash,
    installed_at: new Date().toISOString(),
  }))
}

describe('detectSkillState —— 判定矩阵', () => {
  it('实体目录不存在 → absent', () => {
    const src = makeSource()
    expect(detectSkillState(join(home, 'no-such-entity'), src, '1.0.0')).toEqual({ kind: 'absent' })
  })

  it('manifest 版本不同 → stale，并带上已安装版本', () => {
    const src = makeSource()
    const entity = join(home, 'entity')
    installEntity(entity, src, '0.9.0')
    expect(detectSkillState(entity, src, '1.0.0')).toEqual({ kind: 'stale', installedVersion: '0.9.0' })
  })

  it('版本与哈希都一致 → current', () => {
    const src = makeSource()
    const entity = join(home, 'entity')
    installEntity(entity, src, '1.0.0')
    expect(detectSkillState(entity, src, '1.0.0')).toEqual({ kind: 'current' })
  })

  it('版本一致但清单哈希与包内不同（包更新过、版本没变）→ stale', () => {
    // 源码态下 PACKAGE_VERSION 恒为占位值 '0.0.0-dev'，版本号无法区分包的新旧；
    // 哈希比较是唯一能发现「包变了、装的那份没跟上」的判据。
    const src = makeSource()
    const entity = join(home, 'entity')
    installEntity(entity, src, '1.0.0')
    write(src, 'SKILL.md', '# qiyu 新版\n') // 包内容变了，版本号没变
    expect(detectSkillState(entity, src, '1.0.0'))
      .toEqual({ kind: 'stale', installedVersion: '1.0.0' })
  })

  it('实体在但 manifest 缺失 → stale，版本记 unknown', () => {
    const src = makeSource()
    const entity = join(home, 'entity')
    write(entity, 'SKILL.md', '# qiyu\n')
    expect(detectSkillState(entity, src, '1.0.0'))
      .toEqual({ kind: 'stale', installedVersion: 'unknown' })
  })

  it('manifest 损坏（JSON 残缺）→ stale，版本记 unknown', () => {
    const src = makeSource()
    const entity = join(home, 'entity')
    write(entity, 'SKILL.md', '# qiyu\n')
    write(entity, MANIFEST, '{ 残缺的 JSON')
    expect(detectSkillState(entity, src, '1.0.0'))
      .toEqual({ kind: 'stale', installedVersion: 'unknown' })
  })

  it('manifest 字段不全（缺 content_hash）→ stale，版本记 unknown', () => {
    const src = makeSource()
    const entity = join(home, 'entity')
    write(entity, 'SKILL.md', '# qiyu\n')
    write(entity, MANIFEST, JSON.stringify({ version: '1.0.0', installed_at: new Date().toISOString() }))
    expect(detectSkillState(entity, src, '1.0.0'))
      .toEqual({ kind: 'stale', installedVersion: 'unknown' })
  })

  it('实体目录不可读（chmod 000）→ unknown，且不抛', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return // root 下 chmod 不拦读取
    const src = makeSource()
    const entity = join(home, 'entity')
    installEntity(entity, src, '1.0.0')
    chmodSync(entity, 0o000)
    try {
      expect(() => detectSkillState(entity, src, '1.0.0')).not.toThrow()
      expect(detectSkillState(entity, src, '1.0.0')).toEqual({ kind: 'unknown' })
    } finally {
      chmodSync(entity, 0o755) // 让 afterEach 能清理
    }
  })

  it('实体路径是文件（不是目录）→ unknown，不抛', () => {
    const src = makeSource()
    const entity = join(home, 'entity-is-file')
    writeFileSync(entity, '')
    expect(() => detectSkillState(entity, src, '1.0.0')).not.toThrow()
    expect(detectSkillState(entity, src, '1.0.0')).toEqual({ kind: 'unknown' })
  })

  it('包内源目录不可读 → unknown，且不抛（探测失败不影响命令本身）', () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return // root 下 chmod 不拦读取
    const src = makeSource()
    const entity = join(home, 'entity')
    installEntity(entity, src, '1.0.0')
    chmodSync(src, 0o000)
    try {
      expect(() => detectSkillState(entity, src, '1.0.0')).not.toThrow()
      expect(detectSkillState(entity, src, '1.0.0')).toEqual({ kind: 'unknown' })
    } finally {
      chmodSync(src, 0o755)
    }
  })
})

describe('detectSkillState —— 按参数元组缓存', () => {
  it('同参重复调用复用结果（不重探）；换参或 reset 后重新探测', () => {
    const src = makeSource()
    const entity = join(home, 'entity')

    // 第一次：实体还没装 → absent，并写入缓存。
    expect(detectSkillState(entity, src, '1.0.0')).toEqual({ kind: 'absent' })

    // 装好之后同参再调：命中缓存，仍是 absent（证明没有重探）。
    installEntity(entity, src, '1.0.0')
    expect(detectSkillState(entity, src, '1.0.0')).toEqual({ kind: 'absent' })

    // 换一个参数（版本）→ 新键 → 重新探测，这次能看到刚装上的 1.0.0。
    expect(detectSkillState(entity, src, '9.9.9')).toEqual({ kind: 'stale', installedVersion: '1.0.0' })

    // reset 后回到原键，重新探测 → current。
    __resetSkillDetectionForTest()
    expect(detectSkillState(entity, src, '1.0.0')).toEqual({ kind: 'current' })
  })

  it('三个参数任一不同都是新键（entityDir / sourceDir / currentVersion）', () => {
    const src = makeSource()
    const entity = join(home, 'entity')
    installEntity(entity, src, '1.0.0')

    expect(detectSkillState(entity, src, '1.0.0')).toEqual({ kind: 'current' })
    // 换实体目录（缺失）→ 不命中缓存。
    expect(detectSkillState(join(home, 'other'), src, '1.0.0')).toEqual({ kind: 'absent' })
    // 换源目录（内容不同）→ 清单哈希与它不符 → stale。
    const src2 = join(home, 'pkg-skill-2')
    write(src2, 'SKILL.md', '# qiyu 另一个版本\n')
    expect(detectSkillState(entity, src2, '1.0.0'))
      .toEqual({ kind: 'stale', installedVersion: '1.0.0' })
  })
})

describe('resolveEntityDir —— 测试环境绝不探测真实 ~', () => {
  const savedEnv = process.env.NODE_ENV
  const savedDir = process.env.QIYU_SKILL_DIR
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedEnv
    if (savedDir === undefined) delete process.env.QIYU_SKILL_DIR
    else process.env.QIYU_SKILL_DIR = savedDir
  })

  it('NODE_ENV=test 且未设 QIYU_SKILL_DIR → undefined', () => {
    // 理由（brief 要求写进实现注释）：测试绝不读写真实 `~`，且探测结果不得依赖
    // 开发者机器上装没装过 skill —— 否则本机装过的人跑全量会多出 meta.warnings，
    // 没装过的人不会，同一份代码两种结果。
    process.env.NODE_ENV = 'test'
    delete process.env.QIYU_SKILL_DIR
    expect(resolveEntityDir()).toBeUndefined()
  })

  it('显式设了 QIYU_SKILL_DIR 时优先用它（测试可注入临时目录）', () => {
    process.env.NODE_ENV = 'test'
    process.env.QIYU_SKILL_DIR = join(home, 'custom-entity')
    expect(resolveEntityDir()).toBe(join(home, 'custom-entity'))
  })

  it('QIYU_SKILL_DIR 为空串视为未设（空路径不是有意义的实体位置）', () => {
    process.env.NODE_ENV = 'test'
    process.env.QIYU_SKILL_DIR = ''
    expect(resolveEntityDir()).toBeUndefined()
  })

  it('非测试环境返回默认实体位置（纯字符串计算，不碰磁盘）', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.QIYU_SKILL_DIR
    expect(resolveEntityDir()).toBe(defaultEntityDir(homedir()))
  })
})

describe('resolveSkillSourceDir —— 包内 skill 目录', () => {
  it('返回一个存在的目录且含 SKILL.md，不抛', () => {
    const src = resolveSkillSourceDir()
    expect(src).toBeDefined()
    expect(existsSync(join(src as string, 'SKILL.md'))).toBe(true)
  })

  it('PACKAGE_VERSION 来自 core/edition（本文件的探测目标版本）', () => {
    // 只钉住「可用」，不钉具体值：构建期会被 copy-assets 覆写。
    expect(typeof PACKAGE_VERSION).toBe('string')
    expect(PACKAGE_VERSION.length).toBeGreaterThan(0)
  })
})

describe('skillWarning —— 只在需要时给出一条可执行的提示', () => {
  it('absent：说清未安装，并给出安装命令', () => {
    const msg = skillWarning({ kind: 'absent' }, { entityDir: '/tmp/x' })
    expect(msg).toBeDefined()
    expect(msg).toContain('未安装')
    expect(msg).toContain('/tmp/x')
    expect(msg).toContain('qiyu skill install')
  })

  it('stale：带上已安装版本、当前版本与 --force 更新命令', () => {
    const msg = skillWarning({ kind: 'stale', installedVersion: '0.9.0' }, { currentVersion: '1.0.0' })
    expect(msg).toBeDefined()
    expect(msg).toContain('0.9.0')
    expect(msg).toContain('1.0.0')
    expect(msg).toContain('--force')
  })

  it('stale 且安装版本未知：不编造版本号，仍给出 --force', () => {
    const msg = skillWarning({ kind: 'stale', installedVersion: 'unknown' })
    expect(msg).toBeDefined()
    expect(msg).not.toContain('安装于 unknown')
    expect(msg).toContain('--force')
  })

  it('current / unknown：不提示', () => {
    expect(skillWarning({ kind: 'current' })).toBeUndefined()
    expect(skillWarning({ kind: 'unknown' })).toBeUndefined()
  })
})
