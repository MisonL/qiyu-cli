// tests/commands/skill.test.ts —— F 子项目 Task 11：`qiyu skill install/check/where` 命令层。
//
// 全部在临时 home 下跑：`--dir` 显式注入实体位置，`HOME` 注入 agent 目录探测的根
// （`os.homedir()` 在 POSIX 上读 `HOME`）。**绝不读写真实 `~`**；`QIYU_SKILL_DIR`
// 每个用例前清成空串（命令层把它当「未设」）。
//
// brief 的 14 条要点逐条对应下面的用例；另补了几条 brief 在「约束」里点名、
// 但没列进 14 条的行为：where 的逐 agent 兜异常（ELOOP / ENOTDIR）、check 模式互斥、
// install 成功后清除安装前探测提示（Task 10 审查疑虑 2 的交接）。

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skillCommand } from '../../src/commands/skill.js'
import { MANIFEST } from '../../src/skill/install.js'
import { __resetSkillDetectionForTest } from '../../src/skill/detect.js'
import { ok, setSkillWarning } from '../../src/output.js'
import { SKILL_CONTRACT_VERSION } from '../../src/core/edition.js'
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
  vi.stubEnv('HOME', home)
  vi.stubEnv('NODE_ENV', 'test')
  // 空串 = 未设（命令层的解析与 detect.resolveEntityDir 同口径）。
  vi.stubEnv('QIYU_SKILL_DIR', '')
  setSkillWarning(undefined)
  __resetSkillDetectionForTest()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
  setSkillWarning(undefined)
  __resetSkillDetectionForTest()
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
    expect(data()).toMatchObject({ dry_run: true, action: 'install', entity_state: 'absent' })
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
})

describe('skill where', () => {
  it('未安装 → 0，entity 状态 missing，source 报告定位规则', async () => {
    expect(await skillCommand(['where', '--dir', entity])).toBe(0)
    expect(data().entity).toMatchObject({
      path: entity, source: '--dir', exists: false, state: 'missing',
    })
    expect(data().links).toEqual([])
  })

  it('装过且 ~/.claude/skills 存在 → 0，claude-code 为 ok', async () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    out = ''; err = ''
    expect(await skillCommand(['where', '--dir', entity])).toBe(0)
    expect(data().entity).toMatchObject({ exists: true, state: 'ok' })
    expect(linkOf('claude-code')).toMatchObject({
      path: join(home, '.claude', 'skills', 'qiyu'), state: 'ok',
    })
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

  it('--installed 与 --compare 互斥 → 2', async () => {
    expect(await skillCommand(['check', '--installed', '--compare'])).toBe(2)
    expect(err).toContain('互斥')
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

  it('--compare 在未安装时报告差异并退出 1（不抛 ENOENT）', async () => {
    expect(await skillCommand(['check', '--compare', '--dir', entity])).toBe(1)
    const d = data()
    expect((d.installed as Record<string, unknown>)).toMatchObject({ present: false })
    expect((d.differences as string[]).join('\n')).toContain('不存在')
  })
})
