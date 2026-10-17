// tests/query/errors.test.ts
// DuckDB 原生错误 → 中文 QueryFailure（spec §十一）。
// ⚠️ 原生错误原文逐字取自探针 15（@duckdb/node-api 1.5.6-r.1 实测），不联网、不碰 DuckDB。
// ⚠️ 候选一律来自 src/store/schema.ts 的真实 TABLES 元数据，测试不自己维护名字清单。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { classifyDuckDbError, suggestNames, thrownToQueryExit } from '../../src/query/errors.js'
import { TABLES } from '../../src/store/schema.js'
import type { TableDef } from '../../src/store/schema.js'

describe('原生报错 → 中文 + 候选（spec §十一）', () => {
  it('Table with name sessons … Did you mean "sessions"? → 未知表 + 候选 sessions', () => {
    const e = new Error(
      'Catalog Error: Table with name sessons does not exist!\n' +
      'Did you mean "sessions"?\n\n' +
      'LINE 1: SELECT * FROM sessons\n' +
      '                      ^',
    )
    const f = classifyDuckDbError(e, TABLES)
    expect(f).toMatchObject({
      kind: 'usage', code: 'query_error', retryable: false, message: '表 sessons 不存在',
    })
    // suggestNames 与原生候选都是 sessions → 去重后只剩一个
    expect(f.hint).toBe('候选：sessions')
  })

  it('Referenced column "paylod" … Candidate bindings: "payload" → 未知列 + 候选 payload', () => {
    const e = new Error(
      'Binder Error: Referenced column "paylod" not found in FROM clause!\n' +
      'Candidate bindings: "payload", "session_id"\n\n' +
      'LINE 1: SELECT paylod FROM sessions\n' +
      '               ^',
    )
    const f = classifyDuckDbError(e, TABLES)
    expect(f).toMatchObject({
      kind: 'usage', code: 'query_error', retryable: false, message: '列 paylod 不存在',
    })
    // suggestNames 先给 payload（来自 TABLES），原生候选 session_id 追加在后
    expect(f.hint).toBe('候选：payload、session_id')
  })

  it('Permission Error … disabled by configuration → sandbox_blocked', () => {
    const e = new Error(
      'Permission Error: Cannot access file "/etc/passwd" - ' +
      'file system operations are disabled by configuration',
    )
    expect(classifyDuckDbError(e, TABLES)).toEqual({
      kind: 'usage', code: 'sandbox_blocked', retryable: false,
      message: '该语句尝试访问文件或网络，已被只读沙箱拦截',
    })
  })

  it('Parser/Binder/Catalog 其它 → usage query_error，含底层原文', () => {
    // 语法错：中文前缀 + 原生原文（不裸透）
    const parser = classifyDuckDbError(new Error('Parser Error: syntax error at or near "SELEC"'), TABLES)
    expect(parser.kind).toBe('usage')
    expect(parser.code).toBe('query_error')
    expect(parser.message.startsWith('SQL 语法错误')).toBe(true)
    expect(parser.message).toContain('syntax error at or near "SELEC"')

    // 非「表/列不存在」的 Catalog 错误：同样归 usage/query_error，原文附在中文包装后
    const catalog = classifyDuckDbError(
      new Error('Catalog Error: Scalar Function with name "foo" does not exist!'),
      TABLES,
    )
    expect(catalog.kind).toBe('usage')
    expect(catalog.code).toBe('query_error')
    expect(catalog.message.startsWith('SQL 无法执行')).toBe(true)
    expect(catalog.message).toContain('Scalar Function with name "foo" does not exist')

    // sandbox 会包一层前缀（`Failed to extract statements: …`）——分类不能依赖行首锚定
    const wrapped = classifyDuckDbError(
      new Error('Failed to extract statements: Parser Error: syntax error at or near "SELEC"'),
      TABLES,
    )
    expect(wrapped.kind).toBe('usage')
    expect(wrapped.message.startsWith('SQL 语法错误')).toBe(true)
  })

  it('Out of Memory Error → internal + 缩小范围 hint', () => {
    const e = new Error(
      'Out of Memory Error: failed to allocate data of size 8.0 GiB (1.0 GiB/1.0 GiB used)',
    )
    const f = classifyDuckDbError(e, TABLES)
    expect(f.kind).toBe('internal')
    expect(f.code).toBe('internal')
    expect(f.retryable).toBe(false)
    expect(f.hint).toBe('缩小时间范围或加过滤条件')
    // 不裸透：中文开头，原文在括号里
    expect(f.message.startsWith('查询内存不足')).toBe(true)
    expect(f.message).toContain('Out of Memory Error')
  })

  it('无原生候选时从 TABLES 计算前缀/编辑距离候选', () => {
    // 表：编辑距离（sessons → sessions，距离 1）
    const byDistance = classifyDuckDbError(
      new Error('Catalog Error: Table with name sessons does not exist!'), TABLES,
    )
    expect(byDistance.hint).toBe('候选：sessions')

    // 表：前缀（sess → sessions）
    const byPrefix = classifyDuckDbError(
      new Error('Catalog Error: Table with name sess does not exist!'), TABLES,
    )
    expect(byPrefix.hint).toBe('候选：sessions')

    // 完全不相干 → 不硬凑候选，回退到可操作提示
    const nothing = classifyDuckDbError(
      new Error('Catalog Error: Table with name zzzzzz does not exist!'), TABLES,
    )
    expect(nothing.hint).toBe('用 `qiyu db tables` 查看可用表')

    // 列：无 Candidate bindings 时从全部表的全部列名计算
    const col = classifyDuckDbError(
      new Error('Binder Error: Referenced column "paylod" not found in FROM clause!'), TABLES,
    )
    expect(col.hint).toBe('候选：payload')

    const noCol = classifyDuckDbError(
      new Error('Binder Error: Referenced column "zzzzzz" not found in FROM clause!'), TABLES,
    )
    expect(noCol.hint).toBe('用 `qiyu db describe <表>` 查看列清单')
  })

  it('原生候选是系统表噪音时，TABLES 候选排在前（探针 15：无近似表时 DuckDB 给 pg_constraint）', () => {
    const e = new Error(
      'Catalog Error: Table with name sessons does not exist!\nDid you mean "pg_constraint"?',
    )
    expect(classifyDuckDbError(e, TABLES).hint).toBe('候选：sessions、pg_constraint')
  })

  it('候选超过 5 个 → 展示前 5 个 + 「等」', () => {
    const mkTable = (name: string): TableDef => ({
      name,
      columns: [{ name: 'id', type: 'VARCHAR', nullable: false }],
      primaryKey: ['id'],
      grain: '测试表',
    })
    const tables = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7'].map(mkTable)
    const f = classifyDuckDbError(
      new Error('Catalog Error: Table with name a does not exist!'), tables,
    )
    expect(f.hint).toBe('候选：a1、a2、a3、a4、a5等')
  })
})

describe('suggestNames：前缀优先，其次编辑距离 ≤ 2', () => {
  it('sessons → sessions；完全不相干 → 空数组（不硬凑）', () => {
    expect(suggestNames('sessons', ['sessions', 'tickets'])).toEqual(['sessions'])
    expect(suggestNames('zzzzzz', ['sessions', 'tickets'])).toEqual([])
  })

  it('前缀匹配优先于编辑距离，且大小写不敏感（返回定义大小写）', () => {
    expect(suggestNames('sess', ['staff', 'sessions', 'sync_state'])).toEqual(['sessions'])
    expect(suggestNames('SESSION', ['sessions'])).toEqual(['sessions'])
  })

  it('与输入完全同名的名字不重复建议；名字池重复（列名跨表重名）只建议一次；max 截断', () => {
    expect(suggestNames('sessions', ['sessions'])).toEqual([])
    expect(suggestNames('paylod', ['payload', 'payload', 'session_id'])).toEqual(['payload'])
    expect(suggestNames('a', ['ab', 'ac', 'ad', 'ae', 'af', 'ag'], 3)).toEqual(['ab', 'ac', 'ad'])
  })
})

describe('已分类错误原样透传（sandbox 抛出的 kind/code/hint/retryable 不被重分类）', () => {
  it('带 kind 的错误逐字段保留', () => {
    const e = Object.assign(new Error('该语句尝试访问文件或网络，已被只读沙箱拦截'), {
      kind: 'usage', code: 'sandbox_blocked', hint: '沙箱只允许读取数据库内的数据', retryable: false,
    })
    expect(classifyDuckDbError(e, TABLES)).toEqual({
      kind: 'usage', code: 'sandbox_blocked', retryable: false,
      message: '该语句尝试访问文件或网络，已被只读沙箱拦截',
      hint: '沙箱只允许读取数据库内的数据',
    })
  })

  it('code 缺省时用 kind；retryable 缺省 false', () => {
    const e = Object.assign(new Error('查询超过 30000ms 未完成，已中断'), { kind: 'query_timeout' })
    expect(classifyDuckDbError(e, TABLES)).toEqual({
      kind: 'query_timeout', code: 'query_timeout', retryable: false,
      message: '查询超过 30000ms 未完成，已中断',
    })
  })

  it('其余执行期错误 → internal，中文包装 + 底层原文', () => {
    const f = classifyDuckDbError(
      new Error('Invalid Input Error: Could not convert string "abc" to INT32'), TABLES,
    )
    expect(f.kind).toBe('internal')
    expect(f.code).toBe('internal')
    expect(f.retryable).toBe(false)
    expect(f.message.startsWith('查询执行失败')).toBe(true)
    expect(f.message).toContain('Could not convert string "abc" to INT32')
  })
})

// 裁决 R9：sandbox 在 prepare 期把原生错误包成 usage/query_error 并挂到 `cause` ——
// kind/code 以 sandbox 为准，message/hint 从 cause 原文补算（否则候选永远算不出来）。
describe('sandbox 包装错误：cause 带原生表/列错误时补算中文消息与候选', () => {
  const native = (text: string): Error => new Error(text)

  it('表不存在：kind/code 保持 sandbox 的 usage/query_error，message/hint 来自 cause', () => {
    const cause = native(
      'Catalog Error: Table with name sessons does not exist!\nDid you mean "sessions"?',
    )
    const e = Object.assign(
      new Error('SQL 无法执行：Catalog Error: Table with name sessons does not exist!'),
      { kind: 'usage', code: 'query_error', retryable: false, cause },
    )
    const f = classifyDuckDbError(e, TABLES)
    expect(f.kind).toBe('usage')
    expect(f.code).toBe('query_error')
    expect(f.message).toBe('表 sessons 不存在')
    expect(f.hint).toBe('候选：sessions')
  })

  it('列不存在：同理，候选来自 cause 的 Candidate bindings ∪ TABLES 列名', () => {
    const cause = native(
      'Binder Error: Referenced column "paylod" not found in FROM clause!\n' +
      'Candidate bindings: "payload", "session_id"',
    )
    const e = Object.assign(
      new Error('SQL 无法执行：Binder Error: Referenced column "paylod" not found in FROM clause!'),
      { kind: 'usage', code: 'query_error', cause },
    )
    const f = classifyDuckDbError(e, TABLES)
    expect(f.kind).toBe('usage')
    expect(f.code).toBe('query_error')
    expect(f.message).toBe('列 paylod 不存在')
    expect(f.hint).toBe('候选：payload、session_id')
  })

  it('cause 是无关错误（如 INTERRUPT）→ message 保持 sandbox 原文不变', () => {
    const e = Object.assign(new Error('查询执行失败：查询被中断'), {
      kind: 'usage', code: 'query_error', hint: 'sandbox 给的 hint', cause: native('INTERRUPT Error: query interrupted'),
    })
    expect(classifyDuckDbError(e, TABLES)).toEqual({
      kind: 'usage', code: 'query_error', retryable: false,
      message: '查询执行失败：查询被中断', hint: 'sandbox 给的 hint',
    })
  })
})

describe('thrownToQueryExit：usage 双通道退出码 2，其余 fail 退出码 1', () => {
  let out = ''
  let err = ''
  beforeEach(() => {
    out = ''
    err = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
  })
  afterEach(() => { vi.restoreAllMocks() })

  it('usage → 退出码 2、stdout JSON 保留 code（spec §十一 的 code 列）、stderr 同一句话', () => {
    const e = Object.assign(new Error('该语句尝试访问文件或网络，已被只读沙箱拦截'), {
      kind: 'usage', code: 'sandbox_blocked',
    })
    expect(thrownToQueryExit(e, TABLES)).toBe(2)
    expect(JSON.parse(out)).toMatchObject({
      ok: false,
      error: { code: 'sandbox_blocked', kind: 'usage', retryable: false },
    })
    expect(err).toContain('该语句尝试访问文件或网络，已被只读沙箱拦截')
  })

  it('未知表（无 kind 的原生错误）→ 退出码 2、code=query_error、hint 带候选', () => {
    expect(thrownToQueryExit(
      new Error('Catalog Error: Table with name sessons does not exist!'), TABLES,
    )).toBe(2)
    const j = JSON.parse(out)
    expect(j.error).toMatchObject({ code: 'query_error', kind: 'usage', hint: '候选：sessions' })
    expect(err).toContain('表 sessons 不存在')
  })

  it('query_timeout 透传 → 退出码 1（不被误判为 usage）', () => {
    const e = Object.assign(new Error('查询超过 30000ms 未完成，已中断'), {
      kind: 'query_timeout', code: 'query_timeout', hint: '请缩小时间范围',
    })
    expect(thrownToQueryExit(e, TABLES)).toBe(1)
    expect(JSON.parse(out).error).toMatchObject({
      code: 'query_timeout', kind: 'query_timeout', hint: '请缩小时间范围',
    })
    expect(err).toBe('')
  })
})
