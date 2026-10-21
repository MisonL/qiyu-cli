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

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import {
  __resetSkillDetectionForTest, detectSkillState, resolveEntityDir, resolveSkillSourceDir, skillWarning,
} from '../../src/skill/detect.js'
import { contentHash, MANIFEST } from '../../src/skill/install.js'
import { defaultEntityDir } from '../../src/skill/paths.js'
import { setSkillWarning } from '../../src/output.js'
import { run } from '../../src/cli.js'
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
  // 终审 I2：`npm_config_qiyu_skill_dir` 是 postinstall 的自定义位置通路，探测必须认识它。
  // 宿主环境可能真的设了这组变量（CI 上 `npm_config_*` 很常见），所以每个用例前后都要
  // 清干净——否则「未显式注入 → undefined」那条会被宿主的变量污染成假红。
  const NPM_KEYS = ['npm_config_qiyu_skill_dir', 'NPM_CONFIG_QIYU_SKILL_DIR', 'npm_config_qiyu-skill-dir']
  const savedNpm = new Map<string, string | undefined>()
  beforeEach(() => {
    for (const k of NPM_KEYS) {
      savedNpm.set(k, process.env[k])
      delete process.env[k]
    }
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = savedEnv
    if (savedDir === undefined) delete process.env.QIYU_SKILL_DIR
    else process.env.QIYU_SKILL_DIR = savedDir
    for (const [k, v] of savedNpm) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
  })

  it('NODE_ENV=test 且未设 QIYU_SKILL_DIR → undefined', () => {
    // 理由（brief 要求写进实现注释）：测试绝不读写真实 `~`，且探测结果不得依赖
    // 开发者机器上装没装过 skill —— 否则本机装过的人跑全量会多出 meta.warnings，
    // 没装过的人不会，同一份代码两种结果。未显式注入两个变量之一时，测试门保持原样。
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

  it('QIYU_SKILL_DIR 为纯空白同样视为未设（审查 M1）', () => {
    // `QIYU_SKILL_DIR="   "`（shell 里无意带入的空白）此前被当成合法路径，
    // 探测会 stat 一个叫「   」的目录并给出「skill 未安装到    」的文案。
    process.env.NODE_ENV = 'test'
    process.env.QIYU_SKILL_DIR = '   '
    expect(resolveEntityDir()).toBeUndefined()
  })

  it('路径前后有空白时按 trim 后的值使用', () => {
    process.env.NODE_ENV = 'test'
    process.env.QIYU_SKILL_DIR = '  /tmp/some-entity  '
    expect(resolveEntityDir()).toBe('/tmp/some-entity')
  })

  it('非测试环境返回默认实体位置（纯字符串计算，不碰磁盘）', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.QIYU_SKILL_DIR
    expect(resolveEntityDir()).toBe(defaultEntityDir(homedir()))
  })

  // —— 终审 I2：postinstall 与漂移探测必须走同一条位置通路 ——
  it('npm_config_qiyu_skill_dir 生效（装到自定义目录后不再误报「未安装」）', () => {
    // 复现终审 P22：postinstall 用这条通路装到 custom-skill，探测此前只认
    // QIYU_SKILL_DIR，于是每条命令都提示「未安装到默认路径」并建议再装一份。
    // 变异「删掉 resolveEntityDir 里的 npm_config 分支」→ 本用例红。
    process.env.NODE_ENV = 'test'
    delete process.env.QIYU_SKILL_DIR
    process.env.npm_config_qiyu_skill_dir = join(home, 'custom-skill')
    expect(resolveEntityDir()).toBe(join(home, 'custom-skill'))
  })

  it('全大写键 NPM_CONFIG_QIYU_SKILL_DIR 同样生效（spec D8 键名不敏感）', () => {
    // 归一化与 postinstall 共用 paths.ts 的 readEnvByNormalizedKey；变异「不做小写归一化」
    // → 本用例红（Windows 上环境变量名大小写不敏感，探测不能只认小写拼法）。
    process.env.NODE_ENV = 'test'
    delete process.env.QIYU_SKILL_DIR
    process.env.NPM_CONFIG_QIYU_SKILL_DIR = join(home, 'custom-upper')
    expect(resolveEntityDir()).toBe(join(home, 'custom-upper'))
  })

  it('QIYU_SKILL_DIR 优先于 npm_config_qiyu_skill_dir', () => {
    // 显式命令层变量优先于 npm 注入的配置（后者是 postinstall 现场留下的）。
    process.env.NODE_ENV = 'test'
    process.env.QIYU_SKILL_DIR = join(home, 'explicit')
    process.env.npm_config_qiyu_skill_dir = join(home, 'from-npm')
    expect(resolveEntityDir()).toBe(join(home, 'explicit'))
  })

  it('npm_config_qiyu_skill_dir 的相对路径按 cwd 解析成绝对路径', () => {
    // 与 postinstall 同语义（installSkill 内部全部按绝对路径运算）；resolveEntityDir
    // 只做字符串解析，不碰磁盘——home 下并没有这个目录。
    process.env.NODE_ENV = 'test'
    delete process.env.QIYU_SKILL_DIR
    process.env.npm_config_qiyu_skill_dir = './rel-skill'
    expect(resolveEntityDir()).toBe(resolve('./rel-skill'))
    expect(isAbsolute(resolveEntityDir()!)).toBe(true)
  })

  it('npm_config_qiyu_skill_dir 为空串 / 纯空白视为未设（测试门仍然生效）', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.QIYU_SKILL_DIR
    process.env.npm_config_qiyu_skill_dir = '   '
    expect(resolveEntityDir()).toBeUndefined()
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

  it('stale（版本不同）：带上已安装版本、当前版本与 --force 更新命令', () => {
    const msg = skillWarning({ kind: 'stale', installedVersion: '0.9.0' }, { currentVersion: '1.0.0' })
    expect(msg).toBeDefined()
    expect(msg).toContain('0.9.0')
    expect(msg).toContain('1.0.0')
    expect(msg).toContain('--force')
    expect(msg).toContain('与当前 CLI 版本不一致')
  })

  it('stale（版本相同、仅内容漂移）：不得说「版本不一致」（审查 I2 的自相矛盾）', () => {
    // 版本号相同而正文哈希漂移（包更新过、版本没变）时，旧文案输出
    // 「版本不一致（安装于 0.0.0-dev，当前 0.0.0-dev）」——同一句话自我矛盾。
    // 这条钉住「内容漂移」专用措辞。
    const msg = skillWarning({ kind: 'stale', installedVersion: '1.0.0' }, { currentVersion: '1.0.0' })
    expect(msg).toBeDefined()
    expect(msg).toContain('内容与包内当前版本不一致')
    expect(msg).toContain('1.0.0')
    expect(msg).toContain('--force')
    expect(msg).not.toContain('与当前 CLI 版本不一致')
  })

  it('stale 且安装版本未知：不编造版本号，用「无法确认版本」措辞（审查 I2）', () => {
    const msg = skillWarning({ kind: 'stale', installedVersion: 'unknown' }, { currentVersion: '1.0.0' })
    expect(msg).toBeDefined()
    expect(msg).toContain('无法确认已安装 skill 的版本')
    expect(msg).toContain('安装清单缺失或损坏')
    expect(msg).not.toContain('安装于 unknown')
    expect(msg).toContain('--force')
  })

  it('current / unknown：不提示', () => {
    expect(skillWarning({ kind: 'current' })).toBeUndefined()
    expect(skillWarning({ kind: 'unknown' })).toBeUndefined()
  })
})

describe('cli.run() 接线 —— 提示真的进 meta.warnings，且每次 run 显式清除（审查 I1）', () => {
  // 这两条是 cli.ts 接线的唯一端到端覆盖：`run()` 里的
  // `setSkillWarning(dir && src ? skillWarning(detectSkillState(...)) : undefined)`
  // 若被整段删掉、或退化成「只在有提示时才 set」（不清除残留），下面的用例变红。
  let out: string

  beforeEach(() => {
    out = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    setSkillWarning(undefined)
  })

  it('装了不存在的位置：api list 退出码 0，meta.warnings 含「未安装」提示', async () => {
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('QIYU_SKILL_DIR', join(home, 'absent-entity'))
    expect(await run(['api', 'list'])).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.ok).toBe(true)
    expect(parsed.meta.warnings).toHaveLength(1)
    expect(parsed.meta.warnings[0]).toContain('未安装')
    expect(parsed.meta.warnings[0]).toContain(join(home, 'absent-entity'))
  })

  it('残留清除：第一次 absent 产生提示，第二次换成 current 实体后不得残留上一条', async () => {
    // 构造一个「已安装且与包内一致」的实体：正文从包内源目录原样复制，
    // 清单写当前版本 + 源目录哈希。源目录取 resolveSkillSourceDir() 的解析结果
    // （源码态是 src/skill/qiyu，发布/构建态是 dist/skill/qiyu），哈希与 run()
    // 内部用的是同一份，因此无论哪种形态都判 current。
    const sourceDir = resolveSkillSourceDir() as string
    const currentEntity = join(home, 'current-entity')
    // 递归复制：包内 skill 目录当前是扁平的，但正文结构以后可能加子目录；
    // 用 cpSync 递归复制，来源目录长什么样都不会因为 EISDIR 假红。
    cpSync(sourceDir, currentEntity, { recursive: true })
    writeFileSync(join(currentEntity, MANIFEST), JSON.stringify({
      version: PACKAGE_VERSION,
      skill_contract_version: SKILL_CONTRACT_VERSION,
      content_hash: contentHash(sourceDir),
      installed_at: new Date().toISOString(),
    }))

    vi.stubEnv('NODE_ENV', 'test')

    // 第一次：absent → 产生「未安装」提示（若接线缺失，这条先红）。
    vi.stubEnv('QIYU_SKILL_DIR', join(home, 'absent-entity'))
    out = ''
    expect(await run(['api', 'list'])).toBe(0)
    expect(JSON.parse(out).meta.warnings[0]).toContain('未安装')

    // 第二次：换成 current 实体 → 探测结果无提示。若 cli.ts 只在「有提示」时才
    // setSkillWarning（不清除），上一条提示会残留在本次 meta 里 → 这条红。
    vi.stubEnv('QIYU_SKILL_DIR', currentEntity)
    out = ''
    expect(await run(['api', 'list'])).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.ok).toBe(true)
    expect(parsed.meta, 'current 态不得出现 warnings 键').not.toHaveProperty('warnings')
    expect(out).not.toContain('未安装')
  })
})
