import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSkillDirs, defaultEntityDir, linkTarget, linkState, linkPlan, createSkillLink, normalizeNewlines } from '../../src/skill/paths.js'

let home: string
// realpathSync 不可省：macOS 的 /var 是指向 /private/var 的符号链接，不归一化的话
// 临时目录里建出的链接与 join(home, …) 拼出的路径字符串对不上，路径比较会假失败。
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
})
