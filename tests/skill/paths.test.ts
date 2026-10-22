import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync, realpathSync, readdirSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  AGENT_SKILL_SUBDIRS, LINK_NAME, agentSkillDirs, agentSkillSubdir, agentsMissingSkillDir,
  defaultEntityDir, envIndex, linkPlan, linkState, linkTarget, createSkillLink, normalizeNewlines,
  readEnvByNormalizedKey,
} from '../../src/skill/paths.js'

let home: string
// realpathSync 在这里是防御性归一化，不是正确性前提：macOS 的 /var 是指向
// /private/var 的符号链接，但 linkState 内部对两边都做 realpath 后再比较，
// 即便 home 保留 /var 写法，比较仍会落在同一目录上（已实测：去掉这层归一化
// 后本文件全绿）。留着是为了让用例里直接比较的路径字符串（如 linkPlan 的
// 期望值、defaultEntityDir 的结果）也稳定为规范形式，失败信息更好读。
beforeEach(() => { home = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-skill-'))).toString() })
afterEach(() => { rmSync(home, { recursive: true, force: true }) })

describe('paths', () => {
  it('只返回已存在的 agent 目录', () => {
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    expect(agentSkillDirs(home).map((a) => a.name)).toEqual(['claude-code'])
  })
  it('一个都没有时返回空数组', () => {
    expect(agentSkillDirs(home)).toEqual([])
  })
  it('默认实体目录在 ~/.agents/skills/qiyu', () => {
    expect(defaultEntityDir(home)).toBe(join(home, '.agents', 'skills', 'qiyu'))
  })
  it('linkTarget 从 ~/.claude/skills 回到实体是两级 ..', () => {
    expect(linkTarget(join(home, '.claude', 'skills'), join(home, '.agents', 'skills', 'qiyu')))
      .toBe(join('..', '..', '.agents', 'skills', 'qiyu'))
  })
  it('linkTarget 按真实层级现算，不是写死的两级 ..', () => {
    // 三层深的 agent 目录需要三级 ..；若实现硬编码两级 ..，这条会红。
    mkdirSync(join(home, '.config', 'claude', 'skills'), { recursive: true })
    expect(linkTarget(join(home, '.config', 'claude', 'skills'), join(home, '.agents', 'skills', 'qiyu')))
      .toBe(join('..', '..', '..', '.agents', 'skills', 'qiyu'))
  })
  it('linkState: missing / ok / dangling / foreign', () => {
    const entity = join(home, 'entity'); mkdirSync(entity)
    const link = join(home, 'link')
    expect(linkState(link, entity)).toBe('missing')
    symlinkSync(entity, link)
    expect(linkState(link, entity)).toBe('ok')
    rmSync(entity, { recursive: true })
    expect(linkState(link, entity)).toBe('dangling')
    const foreign = join(home, 'foreign')
    mkdirSync(foreign); writeFileSync(join(foreign, 'x'), '')
    expect(linkState(foreign, entity)).toBe('foreign')
    // 指向别处的符号链接也是 foreign。entity 已在上面 dangling 步骤被删，先补回来：
    // 实体不存在时走「实体缺失 → dangling」的提前返回（brief 规定的语义），
    // 比较分支覆盖不到 —— 这条与「路径不是符号链接」的 foreign 是不同分支，两者都钉。
    mkdirSync(entity)
    symlinkSync(foreign, join(home, 'else'))
    expect(linkState(join(home, 'else'), entity)).toBe('foreign')
  })
  it('createSkillLink 建出可解析的相对链接', async () => {
    const agent = join(home, '.claude', 'skills'); mkdirSync(agent, { recursive: true })
    const entity = defaultEntityDir(home); mkdirSync(entity, { recursive: true })
    await createSkillLink(join(agent, 'qiyu'), linkTarget(agent, entity))
    expect(linkState(join(agent, 'qiyu'), entity)).toBe('ok')
  })
  it('linkPlan：win32 用绝对路径 + junction，其余平台保留相对路径', () => {
    const link = join(home, '.claude', 'skills', 'qiyu')
    const rel = join('..', '..', '.agents', 'skills', 'qiyu')
    expect(linkPlan(link, rel, 'win32')).toEqual({ target: join(home, '.agents', 'skills', 'qiyu'), type: 'junction' })
    expect(linkPlan(link, rel, 'darwin')).toEqual({ target: rel })
    expect(linkPlan(link, rel, 'linux')).toEqual({ target: rel })
  })
  it('normalizeNewlines 把 CRLF 折成 LF', () => {
    expect(normalizeNewlines(Buffer.from('a\r\nb\r\n')).toString()).toBe('a\nb\n')
  })
  // 终审 Minor-1 / Minor-2 的单一事实源：字符串只有一份，两个消费方都从这里取。
  it('LINK_NAME 与 AGENT_SKILL_SUBDIRS 是对外导出的事实源', () => {
    expect(LINK_NAME).toBe('qiyu')
    expect(AGENT_SKILL_SUBDIRS.map((a) => a.name)).toEqual(['claude-code', 'codex'])
    expect(agentSkillSubdir('claude-code')).toBe(join('.claude', 'skills'))
    expect(agentSkillSubdir('codex')).toBe(join('.codex', 'skills'))
  })
})

// —— 审查 B1：agent 目录本身是符号链接 ——
describe('B1：linkTarget 按真实落点计算', () => {
  it('agentDir 是符号链接且深度不同：相对目标按真实落点算，建出可解析的链接', async () => {
    // 字面路径 3 层（home/.claude/skills），真实落点 2 层（home/dotfiles/x）。
    const dotfiles = join(home, 'dotfiles', 'x')
    mkdirSync(dotfiles, { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    const agentLiteral = join(home, '.claude', 'skills')
    symlinkSync(dotfiles, agentLiteral)
    const entity = defaultEntityDir(home)
    mkdirSync(entity, { recursive: true })

    const target = linkTarget(agentLiteral, entity)
    // 修复前按字面路径算：'../../.agents/skills/qiyu'；真实落点只需 '../.agents/skills/qiyu'。
    expect(target).toBe(linkTarget(dotfiles, entity))
    await createSkillLink(join(dotfiles, 'qiyu'), target)
    expect(linkState(join(agentLiteral, 'qiyu'), entity)).toBe('ok')
    expect(realpathSync(join(dotfiles, 'qiyu'))).toBe(realpathSync(entity))
  })

  it('agentDir 不存在时退回原值（不抛）', () => {
    const missing = join(home, 'nope', 'skills')
    expect(linkTarget(missing, join(home, 'entity'))).toBe(join('..', '..', 'entity'))
  })
})

// —— 审查 #2 / #36：四态判定的比较口径 ——
describe('linkState 的比较口径（审查 #2 / #36）', () => {
  it('实体缺失、链接指向别处的真实存在目录 → foreign（不是 dangling）', () => {
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere)
    const link = join(home, 'link')
    symlinkSync(elsewhere, link)
    expect(linkState(link, join(home, 'not-there'))).toBe('foreign')
  })

  it('实体缺失、链接目标也解析不到 → dangling', () => {
    const link = join(home, 'link')
    symlinkSync(join(home, 'gone'), link)
    expect(linkState(link, join(home, 'not-there'))).toBe('dangling')
  })

  it('同一目录仅大小写不同 → ok（按 inode 判定，不按字符串）', () => {
    // macOS 默认 APFS 大小写不敏感：`entity` 与 `Entity` 是同一目录，但 realpathSync
    // 不归一化大小写（只把传入的拼写原样带出来）。只有按 dev+ino 比较才判得对
    // （字符串比较会判 foreign）。
    const entity = join(home, 'Entity')
    mkdirSync(entity)
    const link = join(home, 'link')
    symlinkSync(entity, link)
    // 自检本机文件系统是否大小写不敏感：另一种拼写能否 stat 到（**不能**用
    // realpathSync 比字符串来判——它本来就不归一化大小写，那样判永远为 false）。
    let caseInsensitiveFs: boolean
    try {
      statSync(join(home, 'ENTITY'))
      caseInsensitiveFs = true
    } catch {
      caseInsensitiveFs = false
    }
    if (!caseInsensitiveFs) return // 大小写敏感卷（Linux 等）：不存在「同一目录两种写法」
    expect(statSync(link).ino).toBe(statSync(join(home, 'entity')).ino) // 前提自检
    expect(linkState(link, join(home, 'entity'))).toBe('ok')
  })

  it('不同目录 → foreign（inode 不同）', () => {
    const entity = join(home, 'a')
    const other = join(home, 'b')
    mkdirSync(entity)
    mkdirSync(other)
    const link = join(home, 'link')
    symlinkSync(other, link)
    expect(linkState(link, entity)).toBe('foreign')
  })
})

// —— 审查 B3：区分「装了 Agent 但缺 skills」与「没装 Agent」 ——
describe('agentsMissingSkillDir（B3）', () => {
  it('装了 ~/.claude 但缺 skills 子目录 → 报出缺失的目录', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    expect(agentsMissingSkillDir(home)).toEqual([
      { name: 'claude-code', dir: join(home, '.claude', 'skills') },
    ])
  })
  it('skills 子目录已存在、或根本没装 Agent → 都不报', () => {
    expect(agentsMissingSkillDir(home)).toEqual([])
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    expect(agentsMissingSkillDir(home)).toEqual([])
  })
  it('根是文件（ENOTDIR）→ 不当作「装了 Agent」', () => {
    writeFileSync(join(home, '.codex'), '不是目录\n')
    expect(agentsMissingSkillDir(home)).toEqual([])
    // 不创建任何目录。
    expect(readdirSync(home).sort()).toEqual(['.codex'])
  })
})

describe('envIndex / readEnvByNormalizedKey（postinstall 与漂移探测共用的唯一归一化）', () => {
  it('键名归一化：小写 + `-` → `_`', () => {
    const index = envIndex({ 'npm_config_qiyu-skill-dir': '/x', NPM_COMMAND: 'install' })
    expect(index.get('npm_config_qiyu_skill_dir')).toBe('/x')
    expect(index.get('npm_command')).toBe('install')
  })
  it('只收字符串值（undefined 视同不存在）', () => {
    // NodeJS.ProcessEnv 的值类型允许 undefined；envIndex 不把它们写进索引。
    const index = envIndex({ A: undefined, B: ' ' } as unknown as NodeJS.ProcessEnv)
    expect(index.has('a')).toBe(false)
    expect(index.get('b')).toBe(' ')
  })
  it('大小写与连字符变体命中同一键', () => {
    expect(readEnvByNormalizedKey({ NPM_CONFIG_QIYU_SKILL_DIR: '/abs' }, 'npm_config_qiyu_skill_dir'))
      .toBe('/abs')
    expect(readEnvByNormalizedKey({ 'npm_config_qiyu-skill-dir': ' /rel ' }, 'npm_config_qiyu_skill_dir'))
      .toBe('/rel')
  })
  it('空串 / 纯空白视为未设（与 QIYU_SKILL_DIR 同口径）', () => {
    expect(readEnvByNormalizedKey({ npm_config_qiyu_skill_dir: '' }, 'npm_config_qiyu_skill_dir')).toBeUndefined()
    expect(readEnvByNormalizedKey({ npm_config_qiyu_skill_dir: '   ' }, 'npm_config_qiyu_skill_dir')).toBeUndefined()
  })
})
