// tests/commands/skill.test.ts —— F 子项目 Task 11：`qiyu skill install/check/where` 命令层。
//
// 全部在临时 home 下跑：`--dir` 显式注入实体位置，`QIYU_HOME_FOR_TEST` 注入 agent 目录
// 探测的根（D1：命令层的 home 只经 `resolveHome()` 取，见 `src/commands/skill.ts`）。
// **绝不读写真实 `~`**；`HOME` / `USERPROFILE` 在本文件里**刻意不动**——它们是平台相关
// 的，Windows 上命令层根本不读它们，靠它们隔离是 D1 要消灭的那种假安全。
// `QIYU_SKILL_DIR` 每个用例前清成空串（命令层把它当「未设」）。
//
// brief 的 14 条要点逐条对应下面的用例；另补了几条 brief 在「约束」里点名、
// 但没列进 14 条的行为：where 的逐 agent 兜异常（ELOOP / ENOTDIR）、check 模式互斥、
// install 成功后清除安装前探测提示（Task 10 审查疑虑 2 的交接）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOME_FOR_TEST_ENV, resolveHome, skillCommand } from '../../src/commands/skill.js'
import { MANIFEST, installSkill } from '../../src/skill/install.js'
import { resetSkillDetectionCache, resolveSkillSourceDir } from '../../src/skill/detect.js'
import { ok, setSkillWarning } from '../../src/output.js'
import { PACKAGE_VERSION, SKILL_CONTRACT_VERSION } from '../../src/core/edition.js'
import { SYNC_TASKS } from '../../src/sync/registry.js'
import { run } from '../../src/cli.js'

let out = ''
let err = ''
let home = ''
let entity = ''

beforeEach(() => {
  out = ''; err = ''
  // macOS 上 `/var` 指向 `/private/var`：realpath 归一化后路径字符串才稳定可比。
  home = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-skillcmd-')))
  entity = join(home, 'entity')
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
  // D1：命令层的 home 走 QIYU_HOME_FOR_TEST（不 stub HOME/USERPROFILE——那正是要消灭的
  // 平台依赖）。启动探测（cli.run）仍读 process.env 的 NODE_ENV 做测试门，照旧 stub。
  vi.stubEnv(HOME_FOR_TEST_ENV, home)
  // ⚠️ 兜底网（2026-10-22 G4 实测的教训）：**做 D1 变异时**（把 resolveHome 改回
  // homedir()）命令层会回落到平台 home —— 本文件当时真的在真实 `~` 下写出了两条悬空
  // 链接。变异是「证明守卫在岗」的必要手段，但守卫一旦停用，隔离就不能只靠它。
  // 所以平台 home 变量在这里也一并指到临时目录：即便守卫被摘掉，落点仍是 tmp。
  // D1 的三条用例在用例内**覆盖**这两个变量（指向另一个 tmp），判别力不受影响。
  vi.stubEnv('HOME', home)
  vi.stubEnv('USERPROFILE', home)
  vi.stubEnv('NODE_ENV', 'test')
  // 空串 = 未设（命令层的解析与 detect 的实体目录解析同口径）。
  vi.stubEnv('QIYU_SKILL_DIR', '')
  setSkillWarning(undefined)
  resetSkillDetectionCache()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
  setSkillWarning(undefined)
  resetSkillDetectionCache()
})

/** stdout 的 JSON 信封。 */
const envelope = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const data = (): Record<string, unknown> => envelope().data as Record<string, unknown>
/** meta.warnings 拼成一段文本（没有 meta 时为空串）。 */
const metaWarnings = (): string => {
  const meta = envelope().meta as { warnings?: unknown[] } | undefined
  return (meta?.warnings ?? []).map((w) => (typeof w === 'string' ? w : JSON.stringify(w))).join('\n')
}
/** 从 where 输出里按 agent 名取链接条目。 */
const linkOf = (agent: string): Record<string, unknown> | undefined =>
  (data().links as Array<Record<string, unknown>>).find((l) => l.agent === agent)

describe('skill 分派层', () => {
  it('skill --help → 0，stdout 含三个子命令，stderr 为空', async () => {
    expect(await skillCommand(['--help'])).toBe(0)
    expect(out).toContain('skill install')
    expect(out).toContain('skill check')
    expect(out).toContain('skill where')
    expect(err).toBe('')
  })

  it('skill nope → 2，点名 token 并列出可用子命令', async () => {
    expect(await skillCommand(['nope'])).toBe(2)
    expect(err).toContain('未知子命令：nope')
    const e = envelope().error as Record<string, unknown>
    expect(e).toMatchObject({ code: 'usage', kind: 'usage' })
    expect(String(e.message)).toContain('install')
    // 无参数是另一件事：不能报成「未知子命令：undefined」
    out = ''; err = ''
    expect(await skillCommand([])).toBe(2)
    expect(err).toContain('用法：')
    expect(err).not.toContain('undefined')
  })

  it('叶子命令 --help 不吞额外参数：install --help → 0，install --help --bod → 2', async () => {
    expect(await skillCommand(['install', '--help'])).toBe(0)
    expect(out).toContain('skill install')
    out = ''; err = ''
    expect(await skillCommand(['install', '--help', '--bod'])).toBe(2)
    expect(err).toContain('--bod')
  })

  it('未知 flag 与位置参数都报用法错误（不静默忽略）', async () => {
    expect(await skillCommand(['install', '--bogus'])).toBe(2)
    expect(err).toContain('--bogus')
    out = ''; err = ''
    expect(await skillCommand(['where', 'extra'])).toBe(2)
    expect(err).toContain('extra')
  })

  it('cli.run() 接线：skill 已注册，且分派到 where 的输出与直调一致', async () => {
    // run() 会先做安装态探测：NODE_ENV=test 且 QIYU_SKILL_DIR 为空时探测被门掉，
    // 因此不会读写真实 ~、也不会给 meta 塞提示。
    expect(await run(['skill', '--help'])).toBe(0)
    expect(out).toContain('skill install')
    out = ''; err = ''
    expect(await run(['skill', 'where', '--dir', entity])).toBe(0)
    expect(data().entity).toMatchObject({ path: entity, source: '--dir', state: 'missing' })
  })
})

describe('skill install', () => {
  it('--dir <tmp> → 0，写出 SKILL.md 与 .qiyu-skill.json', async () => {
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    expect(existsSync(join(entity, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(entity, MANIFEST))).toBe(true)
    expect(data()).toMatchObject({ dry_run: false, status: 'installed', entity_dir: entity, entity_source: '--dir' })
    // 没有 agent 目录时不应凭空造目录（spec D1）
    expect(existsSync(join(home, '.claude'))).toBe(false)
    expect(existsSync(join(home, '.codex'))).toBe(false)
  })

  it('再跑一次 → 0，幂等跳过，meta.warnings 提到已存在', async () => {
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    expect(data().status).toBe('skipped')
    expect(metaWarnings()).toMatch(/已存在/)
    expect(err).toBe('')
  })

  it('实体正文被改后无 --force → 跳过并提示 --force；--force → 覆盖', async () => {
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    writeFileSync(join(entity, 'SKILL.md'), '# 用户改过的正文\n')
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    expect(data().status).toBe('skipped')
    expect(metaWarnings()).toContain('--force')
    // 未加 --force 时用户改动必须原样保留
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# 用户改过的正文\n')
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity, '--force'])).toBe(0)
    expect(data().status).toBe('updated')
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toContain('name: qiyu')
  })

  it('--dry-run → 0，输出计划且一个字节都不写', async () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    expect(await skillCommand(['install', '--dir', entity, '--dry-run'])).toBe(0)
    expect(existsSync(entity)).toBe(false)
    expect(existsSync(join(home, '.claude', 'skills', 'qiyu'))).toBe(false)
    expect(data()).toMatchObject({ dry_run: true, action: 'install', planned_status: 'installed' })
    const links = data().links as Array<Record<string, unknown>>
    expect(links).toEqual([
      { agent: 'claude-code', path: join(home, '.claude', 'skills', 'qiyu'), state: 'missing', action: 'create' },
    ])
  })

  it('--link nope → 2（未知 agent 名，文案列出可用名），且不写盘', async () => {
    expect(await skillCommand(['install', '--dir', entity, '--link', 'nope'])).toBe(2)
    expect(err).toContain('claude-code')
    expect(err).toContain('codex')
    expect(existsSync(entity)).toBe(false)
  })

  it('--link claude-code 但目录不存在 → 0，warnings 提及，且不创建目录', async () => {
    expect(await skillCommand(['install', '--dir', entity, '--link', 'claude-code'])).toBe(0)
    expect(metaWarnings()).toContain('claude-code')
    expect(metaWarnings()).toContain('目录不存在')
    expect(existsSync(join(home, '.claude'))).toBe(false)
    // 实体照常安装
    expect(existsSync(join(entity, 'SKILL.md'))).toBe(true)
  })

  it('--link 与 --no-link 互斥 → 2，且不写盘', async () => {
    expect(await skillCommand(['install', '--dir', entity, '--link', 'claude-code', '--no-link'])).toBe(2)
    expect(err).toContain('互斥')
    expect(existsSync(entity)).toBe(false)
  })

  it('--no-link → 0，只放实体不建链', async () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
    expect(existsSync(join(entity, 'SKILL.md'))).toBe(true)
    expect(existsSync(join(home, '.claude', 'skills', 'qiyu'))).toBe(false)
    expect(data().links).toEqual([])
  })

  it('安装成功后清掉安装前探测出的提示（Task 10 审查疑虑 2）', async () => {
    setSkillWarning('skill 未安装到某处（哨兵）')
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    expect(out).not.toContain('哨兵')
    // 同一进程内后续成功输出也不应再带旧提示
    out = ''
    ok({ ok: true })
    expect(JSON.parse(out).meta).toBeUndefined()
  })

  it('--link codex 在无关 agent 坏掉（~/.claude 是文件）时照常安装并链 codex（审查 M4）', async () => {
    // 自动模式在同一环境下是 exit 0（claude 记警告、codex 照常链）；
    // 显式点名 codex 不该因为无关的 claude 整体失败。
    writeFileSync(join(home, '.claude'), '不是目录\n')
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true })
    expect(await skillCommand(['install', '--dir', entity, '--link', 'codex'])).toBe(0)
    expect(data().status).toBe('installed')
    // 点名映射在 ENOTDIR 下仍要给出可读的 agent 名（而不是目录路径）
    expect(data().links).toEqual([
      { agent: 'codex', path: join(home, '.codex', 'skills', 'qiyu'), state: 'ok' },
    ])
    expect(lstatSync(join(home, '.codex', 'skills', 'qiyu')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(entity, 'SKILL.md'))).toBe(true)
  })

  it('--link claude-code 恰好点到坏掉的那个 agent：警告并跳过，其余照常（不创建目录）', async () => {
    writeFileSync(join(home, '.claude'), '不是目录\n')
    expect(await skillCommand(['install', '--dir', entity, '--link', 'claude-code'])).toBe(0)
    expect(metaWarnings()).toContain('claude-code')
    expect(metaWarnings()).toContain('ENOTDIR')
    expect(data().links).toEqual([])
  })
})

// —— D1：命令层的 home 注入缝（Windows 上测试绝不写真实 home） ——
//
// 病根：`os.homedir()` 在 Windows 读 `USERPROFILE`，而旧测试只 stub `HOME` ——
// Windows 上跑测试就真的往用户 home 写 skill。修法是命令层所有 home 取值收进
// `resolveHome()`，优先级 `QIYU_HOME_FOR_TEST`（非空）?? `homedir()`。
describe('D1：命令层 home 注入缝 QIYU_HOME_FOR_TEST', () => {
  it('install 把链接建到注入的 home，而不是 HOME/USERPROFILE 指向的另一个目录', async () => {
    // 变异「resolveHome 改回 homedir()」→ 本用例红：链接会建到 platformHome 下。
    const platformHome = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-d1-platform-')))
    const alt = join(platformHome, '.claude', 'skills')
    mkdirSync(alt, { recursive: true })
    // 注入的 home 也真有 agent 目录（否则 install 会走「目录不存在 → 不建链」分支，
    // 那证明不了「建到哪个 home」）。
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    // Windows 读 USERPROFILE、POSIX 读 HOME：两个都指到 platformHome，模拟「平台默认 home」。
    vi.stubEnv('HOME', platformHome)
    vi.stubEnv('USERPROFILE', platformHome)
    try {
      expect(await skillCommand(['install', '--dir', entity])).toBe(0)
      // 注入的 home 下建链
      expect(lstatSync(join(home, '.claude', 'skills', 'qiyu')).isSymbolicLink()).toBe(true)
      // 平台 home 的 agent 目录一个条目都没多出来（链接与实体都不许落在那里）
      expect(readdirSync(alt)).toEqual([])
    } finally {
      rmSync(platformHome, { recursive: true, force: true })
    }
  })

  it('where 的 agent 探测同样走注入的 home（不读平台 home）', async () => {
    // 变异「probeAgentLinks 处仍用 homedir()」→ 本用例红：注入 home 下的链接报 missing。
    const platformHome = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-d1-platform-')))
    mkdirSync(join(platformHome, '.claude', 'skills'), { recursive: true })
    vi.stubEnv('HOME', platformHome)
    vi.stubEnv('USERPROFILE', platformHome)
    try {
      mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
      expect(await skillCommand(['where', '--dir', entity])).toBe(0)
      // 链接路径按注入的 home 拼；平台 home 下的那个 agent 目录不该出现在任何条目里。
      expect(linkOf('claude-code')).toMatchObject({
        path: join(home, '.claude', 'skills', 'qiyu'), state: 'missing',
      })
      expect(out).not.toContain(platformHome)
    } finally {
      rmSync(platformHome, { recursive: true, force: true })
    }
  })

  it('未给 --dir 时默认实体位以注入的 home 为根（不是平台 home）', async () => {
    // 变异「resolveEntity 不传 home」→ 本用例红：默认实体位落到 platformHome/.agents/...。
    const platformHome = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-d1-platform-')))
    vi.stubEnv('HOME', platformHome)
    vi.stubEnv('USERPROFILE', platformHome)
    try {
      expect(await skillCommand(['install', '--no-link'])).toBe(0)
      expect(data().entity_dir).toBe(join(home, '.agents', 'skills', 'qiyu'))
      expect(existsSync(join(home, '.agents', 'skills', 'qiyu', 'SKILL.md'))).toBe(true)
      expect(existsSync(join(platformHome, '.agents'))).toBe(false)
    } finally {
      rmSync(platformHome, { recursive: true, force: true })
    }
  })

  it('QIYU_HOME_FOR_TEST 为空串 / 纯空白时按未设处理（回落到平台 home 语义，不解析成相对路径）', () => {
    // 变异「读 process.env 直接返回、不 trim 不判空」→ 本用例红（返回 '' 或 '   '）。
    // 纯函数级断言：注入 env 字面量，不碰磁盘、不读真实 home。
    expect(resolveHome({ [HOME_FOR_TEST_ENV]: '' })).toBe(homedir())
    expect(resolveHome({ [HOME_FOR_TEST_ENV]: '   ' })).toBe(homedir())
    expect(resolveHome({ [HOME_FOR_TEST_ENV]: ` ${home} ` })).toBe(home)
  })
})

// —— D5：同进程内 install 之后探测缓存必须失效 ——
//
// 病根：`detectSkillState` 按（实体、源、版本）元组缓存，永不过期。`cli.run()` 在同一
// 进程内被多次调用是真实形态（测试与嵌入式用法）：先 `--version`（无 skill，缓存 absent）
// → `skill install` → 再 `--version`，第三条仍从缓存读 absent 并报「skill 未安装」。
//
// ⚠️ 这三条用例**必须**在同文件、同模块实例里连着调 `run()`，且中途**不得**
// `vi.resetModules()` / 手动 `resetSkillDetectionCache()` —— 那正好掩盖问题。
describe('D5：同进程 install 后探测缓存失效', () => {
  it('先 --version（无 skill）→ install → 再 --version：第三条不再报未安装', async () => {
    // 变异「install 成功路径删掉 resetSkillDetectionCache()」→ 本用例红（第三条仍带
    // 「skill 未安装」；实测过：只保留 setSkillWarning(undefined) 时它照样红）。
    vi.stubEnv('QIYU_SKILL_DIR', entity)
    expect(await run(['--version'])).toBe(0)
    expect(JSON.parse(out).meta.warnings.join('\n')).toContain('未安装')

    out = ''; err = ''
    expect(await run(['skill', 'install', '--no-link'])).toBe(0)
    expect(data().status).toBe('installed')

    out = ''; err = ''
    expect(await run(['--version'])).toBe(0)
    expect(out).not.toContain('未安装')
    // 装的是本进程这份源码的包内正文 → 探测结论是 current，完全不该有 meta。
    expect('meta' in JSON.parse(out)).toBe(false)
  })

  it('反例：不清缓存时同一条命令确实会残留提示（证明上一条靠的是失效而非巧合）', async () => {
    // 这条是**判别力基线**：它直接演示缓存的行为，保证上面那条不是「本来就不缓存」。
    // 变异「detectSkillState 完全不缓存」→ 本用例红。
    vi.stubEnv('QIYU_SKILL_DIR', entity)
    expect(await run(['--version'])).toBe(0)
    expect(JSON.parse(out).meta.warnings.join('\n')).toContain('未安装')
    // 绕过命令层直接装（不经过 install 的失效调用），模拟「缓存没被清」的世界。
    await installSkill({
      home, entityDir: entity, sourceDir: resolveSkillSourceDir()!, version: PACKAGE_VERSION, force: false,
    })
    out = ''; err = ''
    expect(await run(['--version'])).toBe(0)
    expect(JSON.parse(out).meta.warnings.join('\n')).toContain('未安装')
  })
})


//
// 审查实测过四种分叉：A 用户改正文、B 空实体、C 清单被删、D 用户新增文件。
// 修法是从 install.ts 抽出 `planInstall` 供两边共用；这组用例是防漂移的硬要求——
// 同一状态下先 dry-run 断言 action/planned_status，再真实安装断言 status，
// 两者必须一一对应。
describe('skill install --dry-run 与真实安装同判据（审查 I1）', () => {
  /** 先安装一份，供各场景在此基础上制造状态。 */
  async function installed(): Promise<void> {
    expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
  }
  /** dry-run 的 (action, planned_status, warnings)。 */
  async function dryRun(): Promise<{ action: unknown; planned: unknown; warnings: string }> {
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity, '--no-link', '--dry-run'])).toBe(0)
    return { action: data().action, planned: data().planned_status, warnings: metaWarnings() }
  }
  /** 真实安装的 (status, warnings)。 */
  async function realInstall(extra: string[] = []): Promise<{ status: unknown; warnings: string }> {
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity, '--no-link', ...extra])).toBe(0)
    return { status: data().status, warnings: metaWarnings() }
  }

  it('A. 用户改过正文：dry-run 说 skip + --force 警告，真实安装也是 skipped + 同样警告', async () => {
    await installed()
    writeFileSync(join(entity, 'SKILL.md'), '# 用户改过的正文\n')
    const dry = await dryRun()
    expect(dry).toMatchObject({ action: 'skip', planned: 'skipped' })
    expect(dry.warnings).toContain('--force')
    // dry-run 不写盘：用户改动原样
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# 用户改过的正文\n')
    const real = await realInstall()
    expect(real.status).toBe(dry.planned)
    expect(real.warnings).toContain('--force')
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# 用户改过的正文\n')
  })

  it('B. 空实体目录：dry-run 说 install，真实安装 status=installed', async () => {
    mkdirSync(entity, { recursive: true })
    const dry = await dryRun()
    expect(dry).toMatchObject({ action: 'install', planned: 'installed' })
    expect(existsSync(join(entity, 'SKILL.md'))).toBe(false)
    const real = await realInstall()
    expect(real.status).toBe(dry.planned)
    expect(existsSync(join(entity, 'SKILL.md'))).toBe(true)
  })

  it('C. 清单被删、正文一致：dry-run 说 update，真实安装 status=updated（且只重写清单）', async () => {
    await installed()
    rmSync(join(entity, MANIFEST))
    const before = readFileSync(join(entity, 'SKILL.md'), 'utf8')
    const dry = await dryRun()
    expect(dry).toMatchObject({ action: 'update', planned: 'updated' })
    expect(dry.warnings).toBe('')
    // dry-run 不得把清单补回来
    expect(existsSync(join(entity, MANIFEST))).toBe(false)
    const real = await realInstall()
    expect(real.status).toBe(dry.planned)
    expect(existsSync(join(entity, MANIFEST))).toBe(true)
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe(before)
  })

  it('D. 正文一致、用户新增一个文件：dry-run 说 skip + --force 警告，真实安装 skipped + 同样警告', async () => {
    await installed()
    writeFileSync(join(entity, 'my-notes.md'), '用户自己的笔记\n')
    const dry = await dryRun()
    expect(dry).toMatchObject({ action: 'skip', planned: 'skipped' })
    expect(dry.warnings).toContain('--force')
    const real = await realInstall()
    expect(real.status).toBe(dry.planned)
    expect(real.warnings).toContain('--force')
    expect(readFileSync(join(entity, 'my-notes.md'), 'utf8')).toBe('用户自己的笔记\n')
  })

  it('E. 真空实体（只剩清单）：dry-run 说 install，真实安装 installed', async () => {
    mkdirSync(entity, { recursive: true })
    writeFileSync(join(entity, MANIFEST), JSON.stringify({ version: '0.0.0' }))
    const dry = await dryRun()
    expect(dry).toMatchObject({ action: 'install', planned: 'installed' })
    const real = await realInstall()
    expect(real.status).toBe(dry.planned)
  })

  it('F. 用户改正文 + --force：dry-run 说 update，真实安装 updated 且覆盖', async () => {
    await installed()
    writeFileSync(join(entity, 'SKILL.md'), '# 用户改过的正文\n')
    out = ''
    expect(await skillCommand(['install', '--dir', entity, '--no-link', '--dry-run', '--force'])).toBe(0)
    expect(data()).toMatchObject({ action: 'update', planned_status: 'updated' })
    // dry-run 不写盘
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# 用户改过的正文\n')
    const real = await realInstall(['--force'])
    expect(real.status).toBe('updated')
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toContain('name: qiyu')
  })

  it('G. 内容一致且清单最新：dry-run 说 skip、无警告，真实安装 skipped + 「已存在」提示', async () => {
    await installed()
    const dry = await dryRun()
    expect(dry).toMatchObject({ action: 'skip', planned: 'skipped' })
    expect(dry.warnings).toBe('')
    const real = await realInstall()
    expect(real.status).toBe(dry.planned)
    // 命令层对幂等命中补的「已存在」是安装后的说明，不是计划的一部分
    expect(real.warnings).toContain('已存在')
  })

  it('H. 坏 agent（~/.claude 是文件）下 auto 模式：dry-run 与真实安装同样不建链接', async () => {
    // 复审新 Minor：fix 曾让 planLinks 的自动路径改用逐 agent 退化（为 M4 修的），
    // 而真实安装的自动路径是「枚举整体失败 → 本次不建链接」。dry-run 因此会预告
    // 一批真实安装不会发生的链接。这条钉住两边走同一条退化（逐 agent 只用于显式 --link）。
    writeFileSync(join(home, '.claude'), '不是目录\n')
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true })
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity, '--dry-run'])).toBe(0)
    expect(data().links).toEqual([])
    expect(metaWarnings()).toContain('本次不建链接')
    expect(existsSync(join(home, '.codex', 'skills', 'qiyu')), 'dry-run 不得建链').toBe(false)
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    expect(data().links).toEqual([])
    expect(metaWarnings()).toContain('本次不建链接')
    expect(existsSync(join(home, '.codex', 'skills', 'qiyu')), '真实安装同样不建').toBe(false)
    expect(existsSync(join(entity, 'SKILL.md')), '实体照常安装').toBe(true)
  })

  it('dry-run 能预见的失败与真实安装同样报错（实体路径被文件占用）', async () => {
    writeFileSync(entity, '')
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity, '--dry-run'])).toBe(1)
    expect((envelope().error as Record<string, unknown>).message).toContain('无法计算安装计划')
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity])).toBe(1)
    expect((envelope().error as Record<string, unknown>).message).toContain('skill 安装失败')
  })
})

describe('skill where', () => {
  it('未安装 → 0，entity 状态 missing，每个 agent 都报四态之一', async () => {
    expect(await skillCommand(['where', '--dir', entity])).toBe(0)
    expect(data().entity).toMatchObject({
      path: entity, source: '--dir', exists: false, state: 'missing',
    })
    // 规格 D2 / 验收 1：「对每个 agent 报出 ok/dangling/foreign/missing 之一」。
    // 一个 agent 目录都没有时也必须逐个报 missing，而不是交一张空表——
    // 「没报告」不等于「状态是 missing」，排查时看不出到底缺哪个。
    expect(data().links).toEqual([
      { agent: 'claude-code', path: join(home, '.claude', 'skills', 'qiyu'), state: 'missing' },
      { agent: 'codex', path: join(home, '.codex', 'skills', 'qiyu'), state: 'missing' },
    ])
  })

  it('装过且 ~/.claude/skills 存在 → 0，claude-code 为 ok、未装的 codex 报 missing', async () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    out = ''; err = ''
    expect(await skillCommand(['where', '--dir', entity])).toBe(0)
    expect(data().entity).toMatchObject({ exists: true, state: 'ok' })
    expect(linkOf('claude-code')).toMatchObject({
      path: join(home, '.claude', 'skills', 'qiyu'), state: 'ok',
    })
    // codex 的目录不存在：仍然出现在报告里（state missing），不是从表里消失。
    expect(linkOf('codex')).toMatchObject({ state: 'missing' })
  })

  it('自指循环链接（ELOOP）不崩：该 agent 记 unknown 并进 warnings，其余照常', async () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true })
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    // 把 claude-code 的链接换成自指循环；codex 保持安装时的正常链接
    rmSync(join(home, '.claude', 'skills', 'qiyu'))
    symlinkSync('qiyu', join(home, '.claude', 'skills', 'qiyu'))
    out = ''; err = ''
    expect(await skillCommand(['where', '--dir', entity])).toBe(0)
    expect(linkOf('claude-code')).toMatchObject({ state: 'unknown' })
    expect(String(linkOf('claude-code')?.error)).toContain('ELOOP')
    expect(linkOf('codex')).toMatchObject({ state: 'ok' })
    expect(metaWarnings()).toContain('claude-code')
    expect(metaWarnings()).toContain('ELOOP')
  })

  it('~/.claude 是文件（ENOTDIR）不崩：逐个 agent 兜异常，codex 照常报告', async () => {
    writeFileSync(join(home, '.claude'), '不是目录\n')
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true })
    expect(await skillCommand(['where', '--dir', entity])).toBe(0)
    expect(linkOf('claude-code')).toMatchObject({ state: 'unknown' })
    expect(String(linkOf('claude-code')?.error)).toContain('ENOTDIR')
    expect(linkOf('codex')).toMatchObject({ state: 'missing' })
    expect(metaWarnings()).toContain('ENOTDIR')
  })

  it('未给 --dir 时用 QIYU_SKILL_DIR，并报告定位来源', async () => {
    const envDir = join(home, 'env-entity')
    vi.stubEnv('QIYU_SKILL_DIR', envDir)
    expect(await skillCommand(['where'])).toBe(0)
    expect(data().entity).toMatchObject({ path: envDir, source: 'QIYU_SKILL_DIR', state: 'missing' })
  })

  it('npm_config_qiyu_skill_dir（postinstall 的安装通道）也认，且 QIYU_SKILL_DIR 优先（终审 I2 连带）', async () => {
    // postinstall 只可能写 npm_config_*（spec C5：命令行 flag 在 npm 12 已死，环境变量是
    // 唯一跨版本通路）。命令层的 --dir / where / check --installed 若不认它，用那条通路
    // 装到自定义目录的用户就会对着默认路径报「未安装」——与漂移探测（detect 侧已修）
    // 口径分叉，同一份实体两套结论。
    vi.stubEnv('npm_config_qiyu_skill_dir', join(home, 'npm-entity'))
    expect(await skillCommand(['where'])).toBe(0)
    expect(data().entity).toMatchObject({
      path: join(home, 'npm-entity'), source: 'npm_config_qiyu_skill_dir',
    })
    // 两级优先：显式 QIYU_SKILL_DIR 压过 npm_config_*。
    vi.stubEnv('QIYU_SKILL_DIR', join(home, 'explicit-entity'))
    out = ''
    expect(await skillCommand(['where'])).toBe(0)
    expect(data().entity).toMatchObject({
      path: join(home, 'explicit-entity'), source: 'QIYU_SKILL_DIR',
    })
  })

  it('[57] 探测被门挡掉时 where 如实报告原因（不静默）', async () => {
    // 变异「门关掉时不写任何提示」→ 本用例红。用户在自己设了 NODE_ENV=test 的容器里
    // 看不到「未安装/已过期」提示，where 必须说清「为什么没提示、怎么让它提示」。
    // 本文件 beforeEach 设了 NODE_ENV=test 且 QIYU_SKILL_DIR='' → 门关着。
    expect(await skillCommand(['where'])).toBe(0)
    expect(metaWarnings()).toContain('实体目录未确定')
    expect(metaWarnings()).toContain('QIYU_SKILL_DIR')
  })

  it('[57] 显式给了 QIYU_SKILL_DIR 时门不生效：实体照常报告、且不报「未确定」', async () => {
    // 启动探测只认 env 级显式来源（`--dir` 是逐命令参数，cli.run() 的探测看不到它）。
    // 变异「门无条件生效」→ 本用例红（QIYU_SKILL_DIR 是显式来源，必须照常报告）。
    vi.stubEnv('QIYU_SKILL_DIR', entity)
    expect(await skillCommand(['where'])).toBe(0)
    expect(metaWarnings()).not.toContain('实体目录未确定')
    expect(data().entity).toMatchObject({ path: entity, source: 'QIYU_SKILL_DIR' })
    // 对照：`--dir` 同样照常报告（命令层自己解析，与启动探测无关）。
    out = ''; err = ''
    expect(await skillCommand(['where', '--dir', entity])).toBe(0)
    expect(data().entity).toMatchObject({ path: entity, source: '--dir' })
  })

  it('是纯只读命令：探测后链接与实体原样保留', async () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    const linkPath = join(home, '.claude', 'skills', 'qiyu')
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    out = ''
    expect(await skillCommand(['where', '--dir', entity])).toBe(0)
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    expect(existsSync(join(entity, 'SKILL.md'))).toBe(true)
  })

  it('报告 foreign 与 dangling 两种状态（M7 判别力补强）', async () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true })
    // foreign：链接路径被一个真实目录占用
    mkdirSync(join(home, '.claude', 'skills', 'qiyu'))
    // dangling：链接存在，但目标不存在（实体目录本身存在，否则会先短路成 dangling）
    mkdirSync(entity, { recursive: true })
    symlinkSync(join(home, 'nowhere'), join(home, '.codex', 'skills', 'qiyu'))
    expect(await skillCommand(['where', '--dir', entity])).toBe(0)
    expect(linkOf('claude-code')).toMatchObject({ state: 'foreign' })
    expect(linkOf('codex')).toMatchObject({ state: 'dangling' })
  })

  it('实体不可检查（EACCES）→ exists:null、state:unknown，不谎报「不存在」（审查 M6）', async () => {
    const locked = join(home, 'locked')
    mkdirSync(join(locked, 'entity'), { recursive: true })
    chmodSync(locked, 0o000)
    try {
      expect(await skillCommand(['where', '--dir', join(locked, 'entity')])).toBe(0)
      expect(data().entity).toMatchObject({ exists: null, state: 'unknown' })
      expect(metaWarnings()).toContain('EACCES')
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})

describe('skill check', () => {
  it('默认校验包内那份 → 0，violations 空，meta 带契约版本', async () => {
    expect(await skillCommand(['check'])).toBe(0)
    expect(data()).toMatchObject({ mode: 'package', violations: [] })
    expect((envelope().meta as Record<string, unknown>).skill_contract_version).toBe(SKILL_CONTRACT_VERSION)
    expect(err).toBe('')
  })

  it('--installed 在未安装时 → 1，错误说明未安装并给出可执行 hint', async () => {
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    const e = envelope().error as Record<string, unknown>
    expect(String(e.message)).toContain('未安装')
    expect(String(e.message)).toContain(entity)
    expect(String(e.hint)).toContain('qiyu skill install')
    expect(e.retryable).toBe(false)
  })

  it('把实体里的 SKILL.md 改坏（写入 `qiyu nope`）后 --installed → 1，violations 非空', async () => {
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    writeFileSync(join(entity, 'SKILL.md'), '# 坏掉的正文\n\n`qiyu nope`\n')
    out = ''; err = ''
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    const violations = data().violations as Array<Record<string, unknown>>
    expect(violations.length).toBeGreaterThan(0)
    expect(violations[0]).toMatchObject({ rule: 'unknown_command' })
    expect(String(violations[0]?.detail)).toContain('qiyu nope')
  })

  // ⚠️ 这条用例存在的唯一理由：**消费生产接线**。`tests/skill/check.test.ts` 的 `ctx`
  // 是测试本地组装的，`commands/skill.ts` 里 `checkContext()` 的域闭集被换错它看不见
  // （实测：把 `callable-endpoint-ids` 截断成 `.slice(0, 5)`，那边 32 条全绿）。包内正文
  // 用的又都是 `<接口id>` 占位符，默认 check 同样不可见。这里往实体目录写**具体**接口 id、
  // 走 `--installed` 基准，让断言落在真实的 `checkContext()` 上。
  //   - `data.overview.session`：callable，且在 callable 子集里排第 14 位（下标 13）
  //     → 任何「截断/换域」变异都会把它判成 unknown_positional。
  //   - `crm.modifyOrder`：注册表里真实存在但 `callable: false` → schema 合法、call 必报。
  it('[C2] 生产 checkContext：api call 认 callable 子集、api schema 认全集（具体接口 id 端到端）', async () => {
    mkdirSync(entity, { recursive: true })
    writeFileSync(join(entity, 'SKILL.md'), [
      '# 域接线探针',
      '',
      '- 形状查询：`qiyu api schema crm.modifyOrder`',
      '- 调用：`qiyu api call data.overview.session --body {}`',
      '',
    ].join('\n'))
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(0)
    // 变异「callable 子集截断」→ 这里冒出 unknown_positional（data.overview.session 不在前 5）
    // 变异「endpoint-ids 换成 callable 子集」→ 这里冒出 unknown_positional（crm.modifyOrder 不在子集）
    expect(data().violations).toEqual([])

    // 反向对照（假阴性防线）：同一条不可调用 id 换到 api call，必须报出来。
    writeFileSync(join(entity, 'SKILL.md'), '# 域接线探针\n\n`qiyu api call crm.modifyOrder`\n')
    out = ''; err = ''
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    const violations = data().violations as Array<Record<string, unknown>>
    expect(violations[0]).toMatchObject({ rule: 'unknown_positional' })
    expect(String(violations[0]?.detail)).toContain('crm.modifyOrder')
  })

  it('--installed 与 --compare 互斥 → 2', async () => {
    expect(await skillCommand(['check', '--installed', '--compare'])).toBe(2)
    expect(err).toContain('互斥')
  })

  it('默认（包内）模式下单独给 --dir → 2，不静默忽略（审查 M1）', async () => {
    expect(await skillCommand(['check', '--dir', entity])).toBe(2)
    expect(err).toContain('--installed')
    expect(err).toContain('--compare')
  })

  it('--installed 空目录 → 1，按未安装处理（审查 M2）', async () => {
    mkdirSync(entity, { recursive: true })
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    const e = envelope().error as Record<string, unknown>
    expect(String(e.message)).toContain('未安装')
    expect(String(e.message)).toContain('SKILL.md')
  })

  it('--installed 目录只有无关 .md、没有 SKILL.md → 1（零 md 不等于可用安装）', async () => {
    mkdirSync(entity, { recursive: true })
    writeFileSync(join(entity, 'notes.md'), '# 随手记\n')
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    expect(String((envelope().error as Record<string, unknown>).message)).toContain('SKILL.md')
  })

  it('--compare 空目录 → 1，present=false 且差异提到 SKILL.md（审查 M2）', async () => {
    mkdirSync(entity, { recursive: true })
    expect(await skillCommand(['check', '--compare', '--dir', entity])).toBe(1)
    const d = data()
    expect((d.installed as Record<string, unknown>)).toMatchObject({ present: false })
    expect((d.differences as string[]).join('\n')).toContain('SKILL.md')
  })

  it('--compare 两份都比：一致时 differences 为空、退出码 0', async () => {
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    out = ''; err = ''
    expect(await skillCommand(['check', '--compare', '--dir', entity])).toBe(0)
    const d = data()
    expect(d.mode).toBe('compare')
    expect((d.package as Record<string, unknown>).violations).toEqual([])
    expect((d.installed as Record<string, unknown>)).toMatchObject({ present: true, violations: [] })
    expect(d.differences).toEqual([])
  })

  it('--compare 在已安装那份被改坏时报告差异并退出 1', async () => {
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    writeFileSync(join(entity, 'SKILL.md'), '# 坏掉的正文\n\n`qiyu nope`\n')
    out = ''; err = ''
    expect(await skillCommand(['check', '--compare', '--dir', entity])).toBe(1)
    const d = data()
    expect((d.installed as Record<string, unknown>).violations).not.toEqual([])
    expect((d.differences as string[]).length).toBeGreaterThan(0)
    expect((d.differences as string[]).join('\n')).toContain('内容不同')
  })

  it('--compare 正文内容漂移（追加一句、不改任何引用）→ 退 1，differences 含内容不同（终审 I3）', async () => {
    // spec D2.1 的洞正是「装过旧版、包升级改了正文」；`--compare` 是它在 CI 里的
    // 唯一检测器。此前这条退 0（检测到了却不报），与同数组其它成因（不存在 / 缺
    // SKILL.md / 读取失败 / 哈希失败）的命运不一致。
    // 变异「内容不同不计入 bad」→ 本用例红（退出码变 0）。
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    const metrics = join(entity, 'metrics.md')
    writeFileSync(metrics, `${readFileSync(metrics, 'utf8')}\n<!-- 用户追加的一句 -->\n`)
    out = ''; err = ''
    expect(await skillCommand(['check', '--compare', '--dir', entity])).toBe(1)
    const d = data()
    expect((d.installed as Record<string, unknown>)).toMatchObject({ present: true, violations: [] })
    expect((d.differences as string[]).join('\n')).toContain('内容不同')
  })

  it('--compare 在未安装时报告差异并退出 1（不抛 ENOENT）', async () => {
    expect(await skillCommand(['check', '--compare', '--dir', entity])).toBe(1)
    const d = data()
    expect((d.installed as Record<string, unknown>)).toMatchObject({ present: false })
    expect((d.differences as string[]).join('\n')).toContain('不存在')
  })

  // —— G3 审查 C3/C4：实体目录解析的唯一实现 + 相对路径绝对化 ——
  it('[C4] --dir 给相对路径 → install 与 where 看到同一个绝对路径（不再 install 报 ok / where 报 dangling）', async () => {
    // 复现：此前 `--dir rel` 原样返回，install 按进程 cwd 装、where 按同一 cwd 比，
    // 但链接目标按相对路径算出 → where 报 dangling。绝对化之后两处必然一致。
    // 变异「去掉 path.resolve」→ 本用例红（entity.path 不是绝对路径）。
    const rel = 'qiyu-rel-entity'
    const cwd = process.cwd()
    process.chdir(home)
    try {
      expect(await skillCommand(['install', '--dir', rel, '--no-link'])).toBe(0)
      expect(data().entity_dir).toBe(join(home, rel))
      out = ''; err = ''
      expect(await skillCommand(['where', '--dir', rel])).toBe(0)
      expect(data().entity).toMatchObject({ path: join(home, rel), source: '--dir', state: 'ok' })
    } finally {
      process.chdir(cwd)
    }
  })
  it('[C4] QIYU_SKILL_DIR 给相对路径 → where 报告绝对路径（source 如实标注）', async () => {
    // 变异「QIYU_SKILL_DIR 分支不 resolve」→ 本用例红。
    const cwd = process.cwd()
    process.chdir(home)
    try {
      vi.stubEnv('QIYU_SKILL_DIR', 'qiyu-rel-env')
      expect(await skillCommand(['where'])).toBe(0)
      expect(data().entity).toMatchObject({ path: join(home, 'qiyu-rel-env'), source: 'QIYU_SKILL_DIR' })
    } finally {
      process.chdir(cwd)
    }
  })
  it('[C3] npm_config 通道的命令层与探测层口径一致（同一 env 解析出同一个目录）', async () => {
    // 变异「命令层与探测层各写一份解析」→ 本用例红。
    const envDir = join(home, 'npm-entity')
    vi.stubEnv('npm_config_qiyu_skill_dir', envDir)
    expect(await skillCommand(['where'])).toBe(0)
    expect(data().entity).toMatchObject({ path: envDir, source: 'npm_config_qiyu_skill_dir' })
  })
  // —— 追加审查 [55]：实体目录不可读必须与「没有 SKILL.md」分开 ——
  //
  // [55] 的根因：`hasSkillDoc` 用 `catch { return false }` 把所有失败都当成「没有 SKILL.md」。
  // 实测 chmod 000 时 stat(SKILL.md) 抛 EACCES（父目录读不了）→ 报「未安装（没有 SKILL.md）」。
  // 现在三态分明：读不到 SKILL.md 本身（EACCES/ELOOP）→ checkFailed「不可读」；
  // ENOENT → 「未安装」；其余错误由 probeDir 先拦。
  /** 一个「可 stat、但读不了 SKILL.md」的实体：SKILL.md 是指向自身 → stat 抛 ELOOP。 */
  const unreadableEntity = (): string => {
    mkdirSync(entity, { recursive: true })
    symlinkSync('SKILL.md', join(entity, 'SKILL.md'))
    return entity
  }

  it('[55] SKILL.md 读不了（ELOOP）→ check --installed 报环境错误，不谎报「没有 SKILL.md」', async () => {
    unreadableEntity()
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    const e = envelope().error as Record<string, unknown>
    expect(e.code).toBe('skill_check_failed')
    // 变异「probeSkillDoc 的 unreadable 分支退回 missing」→ 本用例红（消息变成「没有 SKILL.md」）。
    expect(String(e.message)).not.toContain('没有 SKILL.md')
  })
  it('[55] 实体目录确实没有 SKILL.md → 仍然报「未安装（没有 SKILL.md）」', async () => {
    // 与上面那条成对：只钉一侧时「恒报不可读」也能活。
    mkdirSync(entity, { recursive: true })
    writeFileSync(join(entity, 'notes.md'), '# 随手记\n')
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    const e = envelope().error as Record<string, unknown>
    expect(String(e.message)).toContain('没有 SKILL.md')
  })
  it('[55] SKILL.md 读不了 → check --compare 记「不可读」并退 1', async () => {
    unreadableEntity()
    expect(await skillCommand(['check', '--compare', '--dir', entity])).toBe(1)
    const d = data()
    expect((d.differences as string[]).join('\n')).toContain('不可读')
  })
  it('[55] 实体目录本身不可读（chmod 000）→ check --installed 报环境错误（probeDir 通道）', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return // root 下 chmod 不拦读取
    const locked = join(home, 'locked')
    mkdirSync(join(locked, 'entity'), { recursive: true })
    chmodSync(locked, 0o000)
    try {
      expect(await skillCommand(['check', '--installed', '--dir', join(locked, 'entity')])).toBe(1)
      const e = envelope().error as Record<string, unknown>
      expect(e.code).toBe('skill_check_failed')
      expect(String(e.message)).toContain('EACCES')
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  // —— 追加审查 [55]：EACCES 不得把用户引向死路 ——
  //
  // ⚠️ 文案的唯一出处是 `install.ts` 的 `planInstall`，且它区分两种失败（G2 落地）：
  //   · listError（**目录**列不出来，如实体目录 chmod 000）→ 如实说 --force 也会失败；
  //   · hashError（**单个文件**读不出来）→ rename 覆盖要的是目录写权限，--force 真能修好。
  // 命令层曾（G3 单独落地时）把两者统一改写成「不可读，--force 也失败」，那在 hashError
  // 分支上是**反向误导**（实测 --force 退 0、status=updated、文件已换入）。故命令层的改写
  // 已删除，下面三条用例改钉 install.ts 的实际文案，并各自验证 --force 的真实能力。
  it('[55] 实体目录不可读（chmod 000）→ 不推荐 --force，改说「先修权限」且如实说 --force 也会失败', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
    chmodSync(entity, 0o000)
    try {
      out = ''; err = ''
      expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
      expect(data().status).toBe('skipped')
      expect(metaWarnings()).toContain('请先修复该目录的可读/可写权限')
      expect(metaWarnings()).toContain('即使 --force 也会以同样的错误失败')
      expect(metaWarnings()).not.toContain('确认后可用 --force 覆盖')
    } finally {
      chmodSync(entity, 0o755)
    }
  })
  it('[55] 单文件读不出来（目录可读）→ --force 真能修好，因此仍推荐 --force', async () => {
    // 与上一条成对，钉住「两种失败不许用同一句话」：把这两条合并成一种文案 → 必有一条红。
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
    writeFileSync(join(entity, 'SKILL.md'), '# 用户改过的正文\n')
    chmodSync(join(entity, 'SKILL.md'), 0o000)
    try {
      out = ''; err = ''
      expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
      expect(data().status).toBe('skipped')
      expect(metaWarnings()).toContain('确认后可用 --force 覆盖')

      // 实测证据：--force 确实修得动（依赖的是目录写权限，不是该文件的读权限）。
      out = ''; err = ''
      expect(await skillCommand(['install', '--dir', entity, '--force', '--no-link'])).toBe(0)
      expect(data().status).toBe('updated')
      expect(metaWarnings()).not.toContain('不可读')
    } finally {
      chmodSync(join(entity, 'SKILL.md'), 0o644)
    }
  })
  it('[55] 真正的内容不同（且可读）→ 同样推荐 --force', async () => {
    // 与第一条成对：只钉「不可读不推 --force」时把「推 --force」整段删掉也能绿。
    expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
    writeFileSync(join(entity, 'SKILL.md'), '# 用户改过的正文\n')
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
    expect(metaWarnings()).toContain('确认后可用 --force 覆盖')
  })

  // —— 追加审查 [54]：写盘失败必须如实报告，不许谎报成功 ——
  //
  // [54] 说的是「全部文件写失败时仍报 status:'updated'、exit 0，与 warnings 自相矛盾」。
  // 根因（status 只反映 plan、不反映实际写盘）已由 B2 修掉：`installSkill` 在零写入时把
  // status 退回 `skipped`，并新增 `plannedStatus` 区分「计划态」。本用例钉住实际结果。
  it('[54] 实体目录只读 → 每个文件写入失败都必须进 warnings（不静默，且实体零变化、status 如实）', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    mkdirSync(entity, { recursive: true })
    chmodSync(entity, 0o500) // 只读：目录内不能 rename/新建
    try {
      expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
      // 零写入的措辞（B2 落地后的实际文案）：逐文件失败 + 汇总一条。旧版是
      // 「本次未能完整写入」，现在会区分 zero/total 并给出写入计数。
      expect(metaWarnings()).toContain('本次一个文件都没有写进去')
      expect(metaWarnings()).toContain('写入 SKILL.md 失败')
      // 实体一个字节没变，也没有任何「已存在」的成功话术。
      expect(existsSync(join(entity, 'SKILL.md'))).toBe(false)
      expect(metaWarnings()).not.toContain('已存在')
      // status 如实反映写盘结果（B2）：零写入 → skipped，不是 plan 阶段的 'installed'。
      expect(data().status).toBe('skipped')
    } finally {
      chmodSync(entity, 0o755)
    }
  })

  // —— G3 审查 C1：skill 家族自身必须在命令闭集里 ——
  it('[C1] 正文引用 `qiyu skill install/check/where` 不被判 unknown_command', async () => {
    // 变异「COMMAND_TREE 去掉 ...SKILL_SPECS」→ 本用例红（unknown_command + 退 1）。
    // 这三条是 CLI 自己天天在教的命令（detect 的提示、README），check 不能把它们判成不存在。
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    writeFileSync(join(entity, 'SKILL.md'), [
      '# 正文',
      '',
      '升级后运行 `qiyu skill install --force` 更新正文。',
      '排查：`qiyu skill where`；复核：`qiyu skill check --installed`。',
      '',
    ].join('\n'))
    out = ''; err = ''
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(0)
    expect(data().violations).toEqual([])
  })
  it('[C1] skill 家族自身的漂移对 check 可见：`skill where --bogus` / `skill install extra` 判违规', async () => {
    // 变异「tree 不含 skill」时这两行都会是 unknown_command（规则不同）→ 本用例红。
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    writeFileSync(join(entity, 'SKILL.md'), [
      '# 正文',
      '',
      '`qiyu skill where --bogus`',
      '`qiyu skill install extra`',
      '',
    ].join('\n'))
    out = ''; err = ''
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    const rules = (data().violations as Array<Record<string, unknown>>).map((v) => v.rule)
    expect(rules).toEqual(['unknown_flag', 'unknown_positional'])
  })
  it('--compare 内容哈希失败 → 退出 1（无法完成比较 ≠ 一致，审查 M3）', async () => {
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    // 非 .md 文件不参与 checkSkillDir，但参与 contentHash——把它变成不可读，
    // 就能构造「两份都能校验、但内容哈希比较失败」的状态。
    const bad = join(entity, 'notes.txt')
    writeFileSync(bad, '私有内容\n')
    chmodSync(bad, 0o000)
    try {
      out = ''; err = ''
      expect(await skillCommand(['check', '--compare', '--dir', entity])).toBe(1)
      const d = data()
      expect((d.differences as string[]).join('\n')).toContain('内容哈希比较失败')
    } finally {
      chmodSync(bad, 0o644)
    }
  })
})

// —— G4/D3：判别力补强（逐条对应 brief 的 15 项） ——

describe('D3.2：planInstall 的「清单被目录占用」分支', () => {
  it('`.qiyu-skill.json` 被建成目录：plan 给出明确 warning、action=none，不崩也不谎报 updated', async () => {
    // 变异「writeTargetWarning 只判 isFile 不判非普通文件（直接返回 null）」→ 本用例红：
    // action 会变成 rewrite-manifest、status 变 updated，而真实安装根本写不进清单。
    expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
    // 正文一致、只有清单被换成了目录 → 计划本来会走 rewrite-manifest。
    rmSync(join(entity, MANIFEST))
    mkdirSync(join(entity, MANIFEST))
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity, '--no-link', '--dry-run'])).toBe(0)
    expect(data()).toMatchObject({ action: 'skip', planned_status: 'skipped' })
    expect(metaWarnings()).toContain('已被非普通文件占用')
    expect(metaWarnings()).toContain(MANIFEST)
    // 真实安装同一状态下也是 skipped（dry-run 与实装同判据），且清单目录原样保留。
    out = ''; err = ''
    expect(await skillCommand(['install', '--dir', entity, '--no-link'])).toBe(0)
    expect(data().status).toBe('skipped')
    expect(lstatSync(join(entity, MANIFEST)).isDirectory()).toBe(true)
  })
})

describe('D3.3：planLinks 的 ELOOP 兜底（自环链接）', () => {
  /** 在 claude-code 的 skills 目录里放一条自指链接（stat 顺着走 → ELOOP）。 */
  const selfLoop = (): void => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    mkdirSync(entity, { recursive: true })
    symlinkSync('qiyu', join(home, '.claude', 'skills', 'qiyu'))
  }

  it('dry-run：不崩、该 agent 记 unknown，warning 点名 ELOOP 并说明安装时会跳过', async () => {
    // 变异「planLinks 的 try/catch 去掉（让 ELOOP 冒泡）」→ 本用例红：整条命令抛错退 1。
    selfLoop()
    expect(await skillCommand(['install', '--dir', entity, '--dry-run'])).toBe(0)
    const links = data().links as Array<Record<string, unknown>>
    expect(links).toEqual([
      expect.objectContaining({ agent: 'claude-code', state: 'unknown', action: 'unknown' }),
    ])
    expect(metaWarnings()).toContain('ELOOP')
    // dry-run 绝不触碰链接：自环原样还在。
    expect(lstatSync(join(home, '.claude', 'skills', 'qiyu')).isSymbolicLink()).toBe(true)
  })

  it('真实安装：同样不崩，按占用处理（不删自环链接），实体照常装上', async () => {
    // 变异「linkAgents 的 catch 分支改成 unlink 自环链接后重建」→ 本用例红（链接消失）。
    selfLoop()
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    expect(data().status).toBe('installed')
    const links = data().links as Array<Record<string, unknown>>
    expect(links).toEqual([expect.objectContaining({ agent: 'claude-code', state: 'foreign' })])
    expect(metaWarnings()).toContain('ELOOP')
    expect(metaWarnings()).toContain('按占用处理')
    // 自环原样保留，实体正文照常写进去了。
    expect(lstatSync(join(home, '.claude', 'skills', 'qiyu')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(entity, 'SKILL.md'))).toBe(true)
  })
})

describe('D3.4：`skill where` 的 not_a_directory 分支', () => {
  it('--dir 指向普通文件 → 0，entity.exists=true / state=not_a_directory（不崩、不谎报 missing）', async () => {
    // 变异「state 恒为 'ok'」或「catch 掉 isDirectory 判定」→ 本用例红。
    writeFileSync(entity, '不是目录\n')
    expect(await skillCommand(['where', '--dir', entity])).toBe(0)
    expect(data().entity).toMatchObject({ path: entity, exists: true, state: 'not_a_directory' })
    // 实体不是目录时仍逐 agent 报告（链接状态照常），且不是错误信封。
    expect(envelope().ok).toBe(true)
    expect((data().links as unknown[]).length).toBe(2)
  })
})

describe('D3.6：check --installed / --compare 的目录不可读与 checkFailed', () => {
  // 用「父目录 chmod 000」构造 EACCES（root 下 chmod 不拦读取，跳过并声明）。
  const canChmod = process.platform !== 'win32' && process.getuid?.() !== 0

  it('--installed：父目录不可读 → ok:false、code=skill_check_failed、退出码 1（不崩栈）', async () => {
    // 变异「probeDir 的 error 分支退回 notInstalled」→ 本用例红（错误码变 skill_not_installed）。
    if (!canChmod) return
    const locked = join(home, 'locked')
    mkdirSync(join(locked, 'entity'), { recursive: true })
    chmodSync(locked, 0o000)
    try {
      expect(await skillCommand(['check', '--installed', '--dir', join(locked, 'entity')])).toBe(1)
      const e = envelope().error as Record<string, unknown>
      expect(envelope()).toMatchObject({ ok: false })
      expect(e.code).toBe('skill_check_failed')
      expect(String(e.message)).toContain('读取 skill 目录失败')
      expect(String(e.message)).toContain('EACCES')
    } finally {
      chmodSync(locked, 0o755)
    }
  })

  it('--compare：父目录不可读 → 退出码 1，differences 说明「路径不可用」并带错因', async () => {
    // 变异「compare 分支不区分 probe.error 与 !isDir」→ 本用例红（差异文案丢失错因）。
    if (!canChmod) return
    const locked = join(home, 'locked')
    mkdirSync(join(locked, 'entity'), { recursive: true })
    chmodSync(locked, 0o000)
    try {
      expect(await skillCommand(['check', '--compare', '--dir', join(locked, 'entity')])).toBe(1)
      const d = data()
      expect((d.differences as string[]).join('\n')).toContain('已安装路径不可用')
      expect((d.differences as string[]).join('\n')).toContain('EACCES')
      expect(d.installed).toMatchObject({ present: false })
      expect(String((d.installed as Record<string, unknown>).error)).toContain('EACCES')
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})

describe('D3.12：cli.run() 探测被门挡掉时，上一条命令的 skillWarning 不得残留', () => {
  it('先植入哨兵提示 → 门挡掉探测（NODE_ENV=test 且无显式来源）→ 输出里没有哨兵', async () => {
    // 变异「run() 只在探测成功时才 setSkillWarning」→ 本用例红（哨兵被带进本次输出）。
    setSkillWarning('skill 未安装到哨兵位置（哨兵）')
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('QIYU_SKILL_DIR', '')
    expect(await run(['--version'])).toBe(0)
    expect(out).not.toContain('哨兵')
    expect('meta' in JSON.parse(out)).toBe(false)
  })

  it('显式关闭开关时替换为可解释文案（不是残留的旧提示）', async () => {
    // 与上一条成对：门因 QIYU_DISABLE_SKILL_PROBE 关掉时要换成原因，而不是留着旧的。
    setSkillWarning('旧提示（哨兵）')
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('QIYU_DISABLE_SKILL_PROBE', '1')
    vi.stubEnv('QIYU_SKILL_DIR', '')
    expect(await run(['--version'])).toBe(0)
    expect(out).not.toContain('哨兵')
    expect(JSON.parse(out).meta.warnings.join('\n')).toContain('QIYU_DISABLE_SKILL_PROBE')
  })
})

describe('D3.13：CHECK_CONTEXT 的生产接线（域互换 / 截断都必须红）', () => {
  // 这条用例消费的是 `src/commands/skill.ts` 的 `checkContext()` 本体——`tests/skill/check.test.ts`
  // 的 ctx 是那边本地组装的，域闭集换错它看不见。包内正文用的全是 `<占位符>`，默认
  // `check`（包内基准）也不可见——所以往实体目录写**具体值**、走 `--installed`。
  //
  // ⚠️ 报表表名**不能**做正向探针：TABLES 里同样有它们，正文写出来必然先命中 `table_name`
  // （独立的硬红线）。所以 report-tables 域的可判别证据只有反例：真任务 id 在报表位必须报。
  //   · dim.staff：真任务 id、不含表名 → 放报表位必须 unknown_positional（域是 report-tables 的证据）；
  //   · staff：真表名但不是报表表 → 报表位同样报（域被换成 tables 全集就会消失）；
  //   · reports.overview：真任务 id 且在 SYNC_TASKS 里排第 3 位之后 → task-ids 域没被截断，
  //     同时它是「task-ids 没被换成 report-tables」的证据（换掉它就不在闭集里了）。
  const doc = (lines: string[]): void => {
    mkdirSync(entity, { recursive: true })
    writeFileSync(join(entity, 'SKILL.md'), ['# 域接线探针', '', ...lines, ''].join('\n'))
  }

  it('task-ids 与 report-tables 两个域没有被互换（互不为对方的子集）', async () => {
    // 变异「domains['report-tables'] = SYNC_TASKS.map(id)」→ 第一段红（dim.staff 会被当成合法报表表）；
    // 变异「domains['report-tables'] = tables 全集」→ 第二段红；
    // 变异「domains['task-ids'] = REPORT_TABLES」→ 第三段红（reports.overview 冒出 unknown_positional）；
    // 变异「task-ids 截断成前 3 个」→ 第三段红（见下一条用例）。
    doc(['- 指标：`qiyu stats fields dim.staff`'])
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    let violations = data().violations as Array<Record<string, unknown>>
    expect(violations).toContainEqual(expect.objectContaining({
      rule: 'unknown_positional', detail: expect.stringContaining('dim.staff'),
    }))

    doc(['- 指标：`qiyu stats fields staff`'])
    out = ''; err = ''
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    violations = data().violations as Array<Record<string, unknown>>
    expect(violations.some((v) => v.rule === 'unknown_positional' && String(v.detail).includes('staff'))).toBe(true)

    doc(['- 同步：`qiyu sync run reports.overview`'])
    out = ''; err = ''
    expect(await skillCommand(['check', '--installed', '--dir', entity]), 'reports.overview 是合法任务 id').toBe(0)
    expect(data().violations).toEqual([])
  })

  it('task-ids 闭集没有被截断（只留前 3 个的变异必须红）', async () => {
    // 变异「'task-ids': SYNC_TASKS.map(t => t.id).slice(0, 3)」→ 本用例红：reports.overview
    // 不在前三个（dim.staff / dim.staff_groups / dim.staff_group_members）。
    expect(SYNC_TASKS.findIndex((t) => t.id === 'reports.overview')).toBeGreaterThanOrEqual(3)
    doc(['- 同步：`qiyu sync run reports.overview`'])
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(0)
    expect(data().violations).toEqual([])
  })
})

