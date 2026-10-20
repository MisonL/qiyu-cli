import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { agentSkillDirs, defaultEntityDir, linkTarget, linkState, linkPlan, createSkillLink, normalizeNewlines } from '../../src/skill/paths.js'

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
})
