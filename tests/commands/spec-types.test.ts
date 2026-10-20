import { describe, it, expect } from 'vitest'
import { findSpec, GLOBAL_FLAGS, REJECTED_FLAGS, STORE_FLAGS, type CommandSpec } from '../../src/commands/spec-types.js'

const tree: CommandSpec[] = [
  { path: ['sync'], flags: [], positionals: [], rejected: REJECTED_FLAGS },
  { path: ['sync', 'run'], flags: [{ name: '--full', kind: 'bool' }], positionals: [{ name: '任务', domain: 'task-ids' }], rejected: REJECTED_FLAGS },
  { path: ['db', 'describe'], flags: [], positionals: [{ name: '表', domain: 'tables' }], rejected: REJECTED_FLAGS },
]

describe('spec-types', () => {
  it('findSpec 按最长前缀匹配（sync run 优先于 sync）', () => {
    expect(findSpec(tree, ['sync', 'run', 'dim.staff'])?.path).toEqual(['sync', 'run'])
  })
  it('findSpec 跳过 flag 与位置参数，只看命令 token', () => {
    expect(findSpec(tree, ['db', 'describe', 'sessions', '--db', 'x'])?.path).toEqual(['db', 'describe'])
  })
  it('findSpec 对未知命令返回 undefined', () => {
    expect(findSpec(tree, ['nope'])).toBeUndefined()
  })
  it('findSpec 对空 argv 返回 undefined', () => {
    expect(findSpec(tree, [])).toBeUndefined()
  })
  // 反向：tree 里更深一层的路径在 argv 未写全时不得命中——省略号不等于通配符。
  it('findSpec 在 flag 之后仍有位置参数时仍命中最长命令', () => {
    expect(findSpec(tree, ['sync', 'run', '--full', 'dim.staff'])?.path).toEqual(['sync', 'run'])
  })
  // 反向：tree 里更深一层的路径在 argv 未写全时不得命中——省略号不等于通配符。
  it('findSpec 不给未写全的更深路径凑命中', () => {
    const t2: CommandSpec[] = [...tree, { path: ['db', 'describe', 'run'], flags: [], positionals: [], rejected: REJECTED_FLAGS }]
    expect(findSpec(t2, ['db', 'describe', 'sessions', '--db', 'x'])?.path).toEqual(['db', 'describe'])
  })
  it('findSpec 命中结果对位置参数相等也不放长（不存在 db describe sessions 时）', () => {
    const t2: CommandSpec[] = [...tree, { path: ['db'], flags: [], positionals: [], rejected: REJECTED_FLAGS }]
    expect(findSpec(t2, ['db', 'sessions'])?.path).toEqual(['db'])
  })
  it('GLOBAL_FLAGS 含 --help/-h/--pretty 且都是 bool', () => {
    expect(GLOBAL_FLAGS.map((f) => f.name)).toEqual(['--help', '-h', '--pretty'])
    expect(GLOBAL_FLAGS.every((f) => f.kind === 'bool')).toBe(true)
  })
  it('REJECTED_FLAGS 只含 --pretty', () => {
    expect(REJECTED_FLAGS).toEqual(['--pretty'])
  })
  it('STORE_FLAGS 是三个值位', () => {
    expect(STORE_FLAGS.map((f) => f.name)).toEqual(['--db', '--profile', '--backend'])
    expect(STORE_FLAGS.every((f) => f.kind === 'value')).toBe(true)
  })
})
