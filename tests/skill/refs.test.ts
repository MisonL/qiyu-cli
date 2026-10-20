import { describe, it, expect } from 'vitest'
import { extractRefs } from '../../src/skill/refs.js'

describe('extractRefs', () => {
  it('提取命令路径与 flag', () => {
    const r = extractRefs('先跑 `qiyu sync status` 看覆盖范围。')
    expect(r.commands).toEqual([{ path: ['sync', 'status'], flags: [], line: 1 }])
  })
  it('flag 与占位符：只校验到占位符之前', () => {
    const r = extractRefs('用 `qiyu query --table <表> --since <时间>`。')
    expect(r.commands[0]).toMatchObject({ path: ['query'], flags: ['--table', '--since'] })
  })
  it('含管道或省略号的记为 unverifiable', () => {
    const r = extractRefs('`qiyu sync run | json`')
    expect(r.commands).toEqual([])
    expect(r.unverifiable[0].reason).toBe('含选择/省略符号')
  })
  it('围栏代码块也扫', () => {
    const r = extractRefs('```\nqiyu db tables\n```')
    expect(r.commands[0].path).toEqual(['db', 'tables'])
  })
  it('散文里的 qiyu 不算引用', () => {
    expect(extractRefs('可以直接运行 qiyu sync status 命令').commands).toEqual([])
  })
  it('提取 kind', () => {
    const r = extractRefs('按 `kind: rate_limit` 分支。')
    expect(r.kinds).toEqual([{ name: 'rate_limit', line: 1 }])
  })
  it('提取 SQL 序列', () => {
    const r = extractRefs('不要写 `SELECT * FROM sessions`')
    expect(r.sqlSequences[0].text).toBe('SELECT * FROM sessions')
  })
  it('只有 SELECT 没有 FROM 不算', () => {
    expect(extractRefs('`SELECT 1`').sqlSequences).toEqual([])
  })
  it('行号准确', () => {
    const r = extractRefs('第一行\n第二行 `qiyu sync status`\n第三行')
    expect(r.commands[0].line).toBe(2)
  })
  it('多个反引号片段各自计数', () => {
    const r = extractRefs('`qiyu db tables` 与 `qiyu sync tasks`')
    expect(r.commands.map((c) => c.path.join(' '))).toEqual(['db tables', 'sync tasks'])
  })
})
