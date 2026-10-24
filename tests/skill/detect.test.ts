// tests/skill/detect.test.ts —— 安装态探测（Task 10，设计稿 D2.1）。
//
// 全部在临时目录里构造实体与源目录，绝不读写真实 `~`。`startupEntityDir()` 的
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
import { fileURLToPath } from 'node:url'
import {
  resetSkillDetectionCache, detectSkillState, entityUndeterminedNote, npmRelativeBase,
  resolveEntityDirSources, resolveSkillSourceDir, skillWarning,
} from '../../src/skill/detect.js'
import { contentHash, MANIFEST } from '../../src/skill/install.js'
import { defaultEntityDir } from '../../src/skill/paths.js'
import { setSkillWarning } from '../../src/output.js'
import { run } from '../../src/cli.js'
import { PACKAGE_VERSION, SKILL_CONTRACT_VERSION } from '../../src/core/edition.js'

/**
 * 启动探测取到的实体目录（终审 F4：`resolveEntityDir` 曾是一个**零生产调用点**的包装，
 * `cli.ts` 已改直调 `resolveEntityDirSources`；测试钉着死包装等于验证一条不在生产路径上
 * 的代码）。这里按 `cli.ts` 的真实调用形态（`process.env` + `npmRelativeBase()`）取，
 * 与生产同一条路。
 */
function startupEntityDir(): string | undefined {
  const r = resolveEntityDirSources({ env: process.env, baseDir: npmRelativeBase(process.env, () => process.cwd()) })
  return r.decided ? r.dir : undefined
}

/**
 * `statSync` 的故障注入开关（D3.5，默认 null = 走真实实现）。
 *
 * 为什么必须在**顶层** `vi.mock` 而不是用例内 `vi.spyOn`：`node:fs` 的命名导出不可
 * 重定义（spyOn 抛 `Cannot redefine property`），而 `detect.ts` 的 `import { statSync }
 * from 'node:fs'` 在模块求值时已绑定 —— 事后改导出对象的属性影响不到它（实测：
 * 用 `process.getBuiltinModule` 拿同一份对象再覆盖，用例仍读到真实 stat）。顶层 mock
 * 只替换这一个函数，其余函数原样转出；需要故障的用例设开关、`finally` 清空。
 */
const fsStatFault = vi.hoisted(() => {
  const state: { path: string | null } = { path: null }
  return {
    armFor(p: string): void { state.path = p },
    clear(): void { state.path = null },
    matched(p: unknown): boolean { return state.path !== null && String(p) === state.path },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: ((p: Parameters<typeof actual.statSync>[0], opts?: unknown) => {
      if (fsStatFault.matched(p)) {
        const e = new Error('EACCES: permission denied') as NodeJS.ErrnoException
        e.code = 'EACCES'
        throw e
      }
      return (actual.statSync as (a: unknown, b?: unknown) => unknown)(p, opts)
    }) as typeof actual.statSync,
  }
})

let home: string

beforeEach(() => {
  // macOS 上 `/var` 指向 `/private/var`：realpath 归一化后路径字符串才稳定可比。
  home = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-detect-')))
  resetSkillDetectionCache()
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
  resetSkillDetectionCache()
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

  // —— D3.5：stat 的非 ENOENT 错误必须当 unknown，不得谎报 absent ——
  //
  // 病根（判别力缺口）：`probe()` 只把 ENOENT 认成 absent，其余错误都重抛进 catch → unknown。
  // 这条**只能用注入**证明：chmod 造不出「stat 本身抛 EACCES 但路径确实存在」以外的形态
  // （上面那条 chmod 用例走的是 readFileSync 的 EACCES，probe 的 stat 分支根本没被单独钉住）。
  // 变异「probe 的 catch 从 `if ENOENT → absent; throw` 改成 `catch { return absent }`」→ 本用例红
  // （结论变 absent，`skillWarning` 会谎报「未安装」）。
  it('stat 抛 EACCES（非 ENOENT）→ unknown，不是 absent（否则 meta.warnings 谎报未安装）', () => {
    const src = makeSource()
    const entity = join(home, 'entity')
    installEntity(entity, src, '1.0.0')
    // 只拦「stat 实体目录本身」那一次：其余 stat（源目录等）走真实实现。
    fsStatFault.armFor(entity)
    try {
      expect(detectSkillState(entity, src, '1.0.0')).toEqual({ kind: 'unknown' })
    } finally {
      fsStatFault.clear()
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
    resetSkillDetectionCache()
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

describe('启动探测取实体目录 —— 测试环境绝不探测真实 ~', () => {
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
    expect(startupEntityDir()).toBeUndefined()
  })

  it('显式设了 QIYU_SKILL_DIR 时优先用它（测试可注入临时目录）', () => {
    process.env.NODE_ENV = 'test'
    process.env.QIYU_SKILL_DIR = join(home, 'custom-entity')
    expect(startupEntityDir()).toBe(join(home, 'custom-entity'))
  })

  it('QIYU_SKILL_DIR 为空串视为未设（空路径不是有意义的实体位置）', () => {
    process.env.NODE_ENV = 'test'
    process.env.QIYU_SKILL_DIR = ''
    expect(startupEntityDir()).toBeUndefined()
  })

  it('QIYU_SKILL_DIR 为纯空白同样视为未设（审查 M1）', () => {
    // `QIYU_SKILL_DIR="   "`（shell 里无意带入的空白）此前被当成合法路径，
    // 探测会 stat 一个叫「   」的目录并给出「skill 未安装到    」的文案。
    process.env.NODE_ENV = 'test'
    process.env.QIYU_SKILL_DIR = '   '
    expect(startupEntityDir()).toBeUndefined()
  })

  it('路径前后有空白时按 trim 后的值使用', () => {
    process.env.NODE_ENV = 'test'
    process.env.QIYU_SKILL_DIR = '  /tmp/some-entity  '
    expect(startupEntityDir()).toBe('/tmp/some-entity')
  })

  it('非测试环境返回默认实体位置（纯字符串计算，不碰磁盘）', () => {
    process.env.NODE_ENV = 'production'
    delete process.env.QIYU_SKILL_DIR
    // vitest 恒设 `VITEST=true`；这条钉的是「生产语义」（非测试进程），所以一并清掉。
    delete process.env.VITEST
    expect(startupEntityDir()).toBe(defaultEntityDir(homedir()))
  })

  // —— 终审 I2 + G3 追加审查 [21]：npm_config 是 postinstall 的位置通道，但不得泄进测试 ——
  //
  // 门在两个方向都要被钉住：
  //   · 生产（非测试进程）：npm_config 必须被认识（否则装到自定义目录后每条命令误报「未安装」）；
  //   · 测试（NODE_ENV=test / VITEST）：门排在 npm_config **之前**，宿主 `.npmrc` 配的
  //     `qiyu-skill-dir` 不得让测试去 stat 真实路径、也不得把漂移提示写进 output.ts 的
  //     模块级 pendingSkillWarning（[21] 实测 4 条红）。
  // 门本身由本组直接调 `resolveEntityDirSources` 验证（`startupEntityDir()` 就是它的
  // 生产调用形态，与 `cli.ts` 逐字对应）。
  const withoutNodeTest = (): void => {
    process.env.NODE_ENV = 'production'
    delete process.env.VITEST
  }

  it('npm_config_qiyu_skill_dir 在生产进程里生效（装到自定义目录后不再误报「未安装」）', () => {
    // 复现终审 P22：postinstall 用这条通路装到 custom-skill，探测此前只认
    // QIYU_SKILL_DIR，于是每条命令都提示「未安装到默认路径」并建议再装一份。
    // 变异「删掉 npm_config 分支」→ 本用例红。
    withoutNodeTest()
    delete process.env.QIYU_SKILL_DIR
    process.env.npm_config_qiyu_skill_dir = join(home, 'custom-skill')
    expect(startupEntityDir()).toBe(join(home, 'custom-skill'))
  })

  it('全大写键 NPM_CONFIG_QIYU_SKILL_DIR 同样生效（spec D8 键名不敏感）', () => {
    // 归一化与 postinstall 共用 paths.ts 的 readEnvByNormalizedKey；变异「不做小写归一化」
    // → 本用例红（Windows 上环境变量名大小写不敏感，探测不能只认小写拼法）。
    withoutNodeTest()
    delete process.env.QIYU_SKILL_DIR
    process.env.NPM_CONFIG_QIYU_SKILL_DIR = join(home, 'custom-upper')
    expect(startupEntityDir()).toBe(join(home, 'custom-upper'))
  })

  it('QIYU_SKILL_DIR 优先于 npm_config_qiyu_skill_dir', () => {
    // 显式命令层变量优先于 npm 注入的配置（后者是 postinstall 现场留下的）。
    withoutNodeTest()
    process.env.QIYU_SKILL_DIR = join(home, 'explicit')
    process.env.npm_config_qiyu_skill_dir = join(home, 'from-npm')
    expect(startupEntityDir()).toBe(join(home, 'explicit'))
  })

  it('npm_config_qiyu_skill_dir 的相对路径按 cwd 解析成绝对路径', () => {
    // 与 postinstall 同语义（installSkill 内部全部按绝对路径运算）；解析只做字符串
    // 拼接，不碰磁盘——home 下并没有这个目录。
    withoutNodeTest()
    delete process.env.QIYU_SKILL_DIR
    process.env.npm_config_qiyu_skill_dir = './rel-skill'
    expect(startupEntityDir()).toBe(resolve('./rel-skill'))
    expect(isAbsolute(startupEntityDir()!)).toBe(true)
  })

  it('[21] NODE_ENV=test + npm_config 已设 + 未设 QIYU_SKILL_DIR → undefined（宿主变量不泄进测试）', () => {
    // 变异「把 npm_config 分支挪回测试门之前」→ 本用例红（返回的是宿主路径而不是 undefined）。
    process.env.NODE_ENV = 'test'
    delete process.env.QIYU_SKILL_DIR
    process.env.npm_config_qiyu_skill_dir = join(home, 'host-npm-entity')
    expect(startupEntityDir()).toBeUndefined()
  })

  it('[21] VITEST=true（NODE_ENV 被改成别的值）同样挡掉 npm_config', () => {
    // vitest 恒设 VITEST=true：只认 NODE_ENV 时，CI 机器把 NODE_ENV 设成 production
    // 就能让测试去读宿主 `.npmrc` 的 qiyu-skill-dir。变异「looksLikeNodeTest 去掉 VITEST」
    // → 本用例红。
    process.env.NODE_ENV = 'production'
    process.env.VITEST = 'true'
    delete process.env.QIYU_SKILL_DIR
    process.env.npm_config_qiyu_skill_dir = join(home, 'host-npm-entity')
    expect(startupEntityDir()).toBeUndefined()
  })

  it('[21] 生产语义下 npm_config 仍被认识（门只关测试，不关生产）', () => {
    // 与上面两条成对：只钉「挡」不钉「不挡」，实现直接 return undefined 也能全绿。
    const env = { NODE_ENV: 'production', npm_config_qiyu_skill_dir: join(home, 'prod-npm-entity') }
    const r = resolveEntityDirSources({ env, baseDir: home })
    expect(r).toMatchObject({ decided: true, source: 'npm_config_qiyu_skill_dir', dir: join(home, 'prod-npm-entity') })
  })

  it('npm_config_qiyu_skill_dir 为空串 / 纯空白视为未设（测试门仍然生效）', () => {
    process.env.NODE_ENV = 'test'
    delete process.env.QIYU_SKILL_DIR
    process.env.npm_config_qiyu_skill_dir = '   '
    expect(startupEntityDir()).toBeUndefined()
  })

  // —— G3 审查 C3/C4：唯一实现 + 相对路径绝对化 ——

  it('[C4] QIYU_SKILL_DIR 的相对路径按 baseDir 解析成绝对路径（不是原样返回）', () => {
    // 此前 `QIYU_SKILL_DIR=rel` 原样返回：install 按进程 cwd 装、where 按另一处 cwd 比，
    // 链接报 dangling。变异「去掉 path.resolve」→ 本用例红。
    const r = resolveEntityDirSources({ env: { QIYU_SKILL_DIR: 'rel-entity' }, baseDir: join(home, 'base') })
    expect(r).toMatchObject({ decided: true, source: 'QIYU_SKILL_DIR', dir: join(home, 'base', 'rel-entity') })
  })

  it('[C4] --dir 的相对路径同样按 baseDir 绝对化，且来源如实标 --dir', () => {
    const r = resolveEntityDirSources({ flagDir: 'rel-flag', env: {}, baseDir: join(home, 'base') })
    expect(r).toMatchObject({ decided: true, source: '--dir', dir: join(home, 'base', 'rel-flag') })
  })

  it('[C4] 默认位置也绝对化，但以注入的 home 为根（不解析成真实 home）', () => {
    // 相对路径不得被解析成真实 home 下的路径：显式来源不经过 home，默认位置只用注入的 home。
    const r = resolveEntityDirSources({ env: { NODE_ENV: 'production' }, home: join(home, 'fake-home') })
    expect(r).toMatchObject({ decided: true, source: 'default', dir: join(home, 'fake-home', '.agents', 'skills', 'qiyu') })
  })

  it('[C3] npmRelativeBase：INIT_CWD 优先，缺失时退回注入的 cwd', () => {
    // postinstall / 命令层 / 启动探测三处解析共用这条基准：「装到哪里」与「去哪里找」才是同一个。
    expect(npmRelativeBase({ INIT_CWD: '/from/init' }, () => '/from/cwd')).toBe('/from/init')
    expect(npmRelativeBase({}, () => '/from/cwd')).toBe('/from/cwd')
    // 空白 INIT_CWD 视为未设（与其它环境变量同口径）。
    expect(npmRelativeBase({ INIT_CWD: '  ' }, () => '/from/cwd')).toBe('/from/cwd')
  })

  it('[C3] 生产进程里 npm_config 的相对路径按 INIT_CWD（而不是进程 cwd）解析', () => {
    // 这正是审查 [17] 的复现：postinstall 按 INIT_CWD 装到 install-cwd/my-skill，
    // 而探测按包根 cwd 算出 pkgroot/my-skill —— 用户看到的「装好了却每条命令都说没装」。
    const r = resolveEntityDirSources({
      env: { NODE_ENV: 'production', INIT_CWD: join(home, 'install-cwd'), npm_config_qiyu_skill_dir: './my-skill' },
      baseDir: npmRelativeBase(
        { INIT_CWD: join(home, 'install-cwd') },
        () => join(home, 'pkgroot'),
      ),
    })
    expect(r).toMatchObject({ decided: true, dir: join(home, 'install-cwd', 'my-skill') })
  })

  it('[57] QIYU_DISABLE_SKILL_PROBE 显式关闭探测，且给出可解释的原因', () => {
    // 显式开关：关闭时不留「为什么没提示」的空白（`skill where` 报告 entityUndeterminedNote）。
    const env = { NODE_ENV: 'production', QIYU_DISABLE_SKILL_PROBE: '1', npm_config_qiyu_skill_dir: join(home, 'x') }
    const r = resolveEntityDirSources({ env, home })
    expect(r.decided).toBe(false)
    if (!r.decided) expect(r.reason).toBe('env')
    expect(entityUndeterminedNote(r)).toContain('QIYU_DISABLE_SKILL_PROBE')
    // 显式来源不受显式开关影响（用户点名了目录，就没有「未确定」可言）。
    expect(resolveEntityDirSources({ flagDir: join(home, 'y'), env, home })).toMatchObject({ decided: true })
  })

  it('[57] 测试门关掉时给出可解释的原因（不是静默）', () => {
    const env = { NODE_ENV: 'test' }
    const r = resolveEntityDirSources({ env, home })
    expect(r.decided).toBe(false)
    expect(entityUndeterminedNote(r, env)).toContain('--dir')
  })
})

describe('resolveSkillSourceDir —— 包内 skill 目录', () => {
  it('返回一个存在的目录且含 SKILL.md，不抛', () => {
    const src = resolveSkillSourceDir()
    expect(src).toBeDefined()
    expect(existsSync(join(src as string, 'SKILL.md'))).toBe(true)
  })

  it('源码态必须解析到与本模块同层的 src/skill/qiyu，不得读过期的 dist 副本（CodeRabbit minor）', () => {
    // 仓库 prepare 挂在 build 上，任何 npm install/ci 都会产出 dist/。
    // 「dist 优先」的旧解析在开发态会把刚改的 src/skill/qiyu/*.md 换成上一次
    // 构建的旧正文：skill check 对旧文本报零违规、探测哈希到旧值、install 装旧副本。
    // 源码态（vitest 下 detect 的 import.meta.url 指向 src/skill/detect.ts）
    // 必须取同层正文。
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
    expect(resolveSkillSourceDir()).toBe(join(repoRoot, 'src', 'skill', 'qiyu'))
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

  it('stale 且安装版本未知：不编造版本号，用「无法确认版本」措辞，且不推 --force（brief D7）', () => {
    const msg = skillWarning({ kind: 'stale', installedVersion: 'unknown' }, { currentVersion: '1.0.0' })
    expect(msg).toBeDefined()
    expect(msg).toContain('无法确认已安装 skill 的版本')
    expect(msg).toContain('安装清单缺失或损坏')
    expect(msg).not.toContain('安装于 unknown')
    // 清单缺失/损坏、正文与包内一致 → planInstall 返回 rewrite-manifest：
    // 不带 --force 的 `qiyu skill install` 只补写清单、不动正文字节。
    // 推 --force 会让用户误以为要覆盖正文（另两支才需要，见上面两条用例）。
    expect(msg).toContain('`qiyu skill install`')
    expect(msg).not.toContain('--force')
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
