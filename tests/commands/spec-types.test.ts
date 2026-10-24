import { describe, it, expect } from 'vitest'
import { findSpec, GLOBAL_FLAGS, REJECTED_FLAGS, STORE_FLAGS, type CommandSpec } from '../../src/commands/spec-types.js'

const tree: CommandSpec[] = [
  { path: ['sync'], flags: [], positionals: [], rejected: REJECTED_FLAGS },
  { path: ['sync', 'run'], flags: [{ name: '--full', kind: 'bool' }], positionals: [{ name: '任务', domain: 'task-ids' }], rejected: REJECTED_FLAGS },
  { path: ['db', 'describe'], flags: [], positionals: [{ name: '表', domain: 'tables' }], rejected: REJECTED_FLAGS },
  // 必须有这条：I-1 的核心误命中是 `db --profile tables` 被滤成 `db tables`，
  // tree 里没有 `['db','tables']` 时两种实现都返回 undefined，测试等于没钉住。
  { path: ['db', 'tables'], flags: [], positionals: [], rejected: REJECTED_FLAGS },
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
  // I-1：flag 插在子命令位。真实分派（db.ts / sync.ts 的 `const [sub, ...rest] = argv`）
  // 会把 flag 当子命令报「未知子命令」退出 2，findSpec 不能把这种命令判成合法。
  it('findSpec 不把插在子命令位的 flag 当成路径段（db --profile tables）', () => {
    expect(findSpec(tree, ['db', '--profile', 'tables'])).toBeUndefined()
  })
  it('findSpec 不把插在子命令位的 flag 当成路径段（sync --db x run）', () => {
    expect(findSpec(tree, ['sync', '--db', 'x', 'run'])).toBeUndefined()
  })
  it('findSpec 路径之后的位置参数不影响命中（db describe sessions）', () => {
    expect(findSpec(tree, ['db', 'describe', 'sessions'])?.path).toEqual(['db', 'describe'])
  })
  it('findSpec 路径之后的 flag 不影响命中（sync run --full dim.staff）', () => {
    expect(findSpec(tree, ['sync', 'run', '--full', 'dim.staff'])?.path).toEqual(['sync', 'run'])
  })
  // M-6：flags 是**含全局 flag** 的完整接受集，Task 3 的 command-tree.test.ts 要求
  // 每条 spec 都带 --help/-h；组装形态固定为 [...GLOBAL_FLAGS, ...业务 flag]。
  it('CommandSpec.flags 是含全局 flag 的完整接受集', () => {
    const spec: CommandSpec = {
      path: ['api', 'list'],
      flags: [...GLOBAL_FLAGS, { name: '--all', kind: 'bool' }],
      positionals: [],
      rejected: REJECTED_FLAGS,
    }
    expect(spec.flags.map((f) => f.name)).toEqual(['--help', '-h', '--pretty', '--all'])
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
