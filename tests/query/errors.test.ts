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
    // suggestNames 先给 payload（来自 TABLES），原生候选 session_id 追加在后。
    // 正确性 P2 起，原生候选须过相关性闸门（suggestNames 同阈值）：session_id 与 paylod
    // 前缀/编辑距离都不沾边 → 不再收进候选；payload 相关、保留。
    expect(f.hint).toBe('候选：payload')
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

  it('原生候选与本输入无关时不再展示（正确性 P2：robot_summary → staff_group_members）', () => {
    // DuckDB 的 binder 候选可能与自己毫无关系（实测删掉 robot_summary 后给 staff_group_members）
    // —— 直接展示会把 Agent 推向另一张表。判据与其他候选同一阈值：前缀或编辑距离 ≤2。
    const e = new Error(
      'Catalog Error: Table with name robot_summary does not exist!\n' +
      'Candidate bindings: "staff_group_members"',
    )
    const f = classifyDuckDbError(e, TABLES)
    expect(f.message).toBe('表 robot_summary 不存在')
    expect(f.hint).toBe('用 `qiyu db tables` 查看可用表')

    // 反证：原生候选**确实相关**时保留（sessons → sessions 距离 1）
    const relevant = new Error(
      'Catalog Error: Table with name sessons does not exist!\nDid you mean "sessions"?',
    )
    expect(classifyDuckDbError(relevant, TABLES).hint).toBe('候选：sessions')
  })

  it('裸 Permission Error（OS 权限问题）不得误报 sandbox_blocked', () => {
    // 审查实测形态：读库文件本身被 OS 拒绝，前缀同为 Permission Error。
    // 与 sandbox.ts 的收窄裁决对齐：只认「文件系统操作被配置禁用」的措辞。
    const f = classifyDuckDbError(
      new Error('Permission Error: opening database file: Operation not permitted'), TABLES,
    )
    expect(f.code).not.toBe('sandbox_blocked')
    expect(f.kind).toBe('internal')
    expect(f.message.startsWith('查询执行失败')).toBe(true)
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
    expect(classifyDuckDbError(e, TABLES).hint).toBe('候选：sessions')
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

// 审查实测的四种真实形态（@duckdb/node-api 1.5.6-r.1，原文逐字）。
describe('限定名 / Candidate tables / 无 FROM 变体 → 候选不丢', () => {
  it('Table "sessions" does not have a column named "paylod" + 双冒号 Candidate bindings → 列候选', () => {
    const e = new Error(
      'Binder Error: Table "sessions" does not have a column named "paylod"\n' +
      'Candidate bindings: : "payload"\n\n' +
      'LINE 1: SELECT sessions.paylod FROM sessions',
    )
    const f = classifyDuckDbError(e, TABLES)
    expect(f).toMatchObject({ kind: 'usage', code: 'query_error', message: '列 paylod 不存在' })
    expect(f.hint).toBe('候选：payload')
  })

  it('Referenced table "sessons" not found + Candidate tables → 表候选', () => {
    const e = new Error(
      'Binder Error: Referenced table "sessons" not found!\n' +
      'Candidate tables: "sessions"\n\n' +
      'LINE 1: SELECT sessons.paylod FROM sessions',
    )
    const f = classifyDuckDbError(e, TABLES)
    expect(f).toMatchObject({ kind: 'usage', code: 'query_error', message: '表 sessons 不存在' })
    expect(f.hint).toBe('候选：sessions')
  })

  it('无 FROM 的 "was not found because the FROM clause is missing" → 列候选', () => {
    const e = new Error(
      'Binder Error: Referenced column "paylod" was not found because the FROM clause is missing',
    )
    const f = classifyDuckDbError(e, TABLES)
    expect(f).toMatchObject({ kind: 'usage', code: 'query_error', message: '列 paylod 不存在' })
    expect(f.hint).toBe('候选：payload')
  })

  it('Parser Error 回显里含「Referenced column "x" not found」字样时不得误判成列不存在（审查 Minor 20）', () => {
    // DuckDB 的错误消息会回显 SQL 原文（LINE 1: …）。若用户 SQL 里恰好写了这段字样，
    // 未锚定 `Binder Error:` 的正则会把它当成真实的列错误 —— 实测原文是 Parser Error。
    const e = new Error(
      'Parser Error: syntax error at or near "column"\n\n' +
      'LINE 1: SELECT 1 WHERE x = Referenced column "zzz" not found\n' +
      '                                      ^',
    )
    const f = classifyDuckDbError(e, TABLES)
    expect(f.kind).toBe('usage')
    expect(f.code).toBe('query_error')
    expect(f.message.startsWith('SQL 语法错误')).toBe(true)
    expect(f.message).not.toMatch(/列 zzz 不存在/)
  })

  it('未绑参（Expected N parameters）→ usage + query_error + 参数化提示', () => {
    const f = classifyDuckDbError(
      new Error('Invalid Input Error: Expected 1 parameters, but none were supplied'), TABLES,
    )
    expect(f.kind).toBe('usage')
    expect(f.code).toBe('query_error')
    expect(f.message.startsWith('SQL 参数个数不匹配')).toBe(true)
    expect(f.hint).toContain('参数化查询仅供 CLI 内部代码使用')
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

  it('仅大小写不同 → 把定义大小的名字作为候选（edge F6）', () => {
    // 此前 `lower === needle` 一律 continue，把「只差大小写」的正确答案排除了 ——
    // Agent 拿 `SESSIONS` 查不到候选，而 DuckDB 标识符大小写不敏感（--sql 通道同写法能跑）。
    expect(suggestNames('SESSIONS', ['sessions', 'tickets'])).toEqual(['sessions'])
    expect(suggestNames('sessions', ['SESSIONS'])).toEqual(['SESSIONS'])
  })

  it('空输入 / max<=0 / 空名字池 → 空数组', () => {
    expect(suggestNames('', ['sessions'])).toEqual([])
    expect(suggestNames('sessons', ['sessions'], 0)).toEqual([])
    expect(suggestNames('sessons', [], 5)).toEqual([])
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

  it('非 Error 抛出（字符串 / null）→ internal 中文包装，不崩溃', () => {
    const str = classifyDuckDbError('boom', TABLES)
    expect(str.kind).toBe('internal')
    expect(str.message.startsWith('查询执行失败')).toBe(true)
    expect(str.message).toContain('boom')

    const nil = classifyDuckDbError(null, TABLES)
    expect(nil.kind).toBe('internal')
    expect(nil.message.startsWith('查询执行失败')).toBe(true)
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
    // 原生候选 session_id 与 paylod 不相关（P2 闸门）→ 只剩 TABLES 侧的相关候选
    expect(f.hint).toBe('候选：payload')
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

  it('kind 不是 usage 时 cause 的表/列错误不补算（Minor #6 守卫）', () => {
    const e = Object.assign(new Error('查询执行失败：Catalog Error: Table with name sessons does not exist!'), {
      kind: 'internal', code: 'internal', cause: native('Catalog Error: Table with name sessons does not exist!'),
    })
    expect(classifyDuckDbError(e, TABLES)).toEqual({
      kind: 'internal', code: 'internal', retryable: false,
      message: '查询执行失败：Catalog Error: Table with name sessons does not exist!',
    })
  })

  it('R11：internal + cause 含 Out of Memory Error → 补「缩小范围」hint，message 不变', () => {
    const e = Object.assign(new Error('查询执行失败：Out of Memory Error: failed to allocate 8.0 GiB'), {
      kind: 'internal', code: 'internal', retryable: false,
      cause: native('Out of Memory Error: failed to allocate data of size 8.0 GiB'),
    })
    expect(classifyDuckDbError(e, TABLES)).toEqual({
      kind: 'internal', code: 'internal', retryable: false,
      message: '查询执行失败：Out of Memory Error: failed to allocate 8.0 GiB',
      hint: '缩小时间范围或加过滤条件',
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

  it('internal 路径 → 退出码 1、stdout JSON 含 code/kind/retryable/message/hint、stderr 空', () => {
    const e = new Error('Out of Memory Error: failed to allocate data of size 8.0 GiB')
    expect(thrownToQueryExit(e, TABLES)).toBe(1)
    const j = JSON.parse(out)
    expect(j.ok).toBe(false)
    expect(j.error).toMatchObject({
      code: 'internal', kind: 'internal', retryable: false,
      hint: '缩小时间范围或加过滤条件',
    })
    expect(j.error.message.startsWith('查询内存不足')).toBe(true)
    expect(err).toBe('')
  })

  it('DuckDB 原文回显 SQL 时，stderr/stdout 都裁掉 LINE n 之后的 SQL（security S3）', () => {
    // Parser/Binder 错误会把出错行的 SQL 全文附在 LINE n: 之后 —— 那段可能含调用方
    // 写进 SQL 的 PII（如手机号）。原样透传等于把原始值写进 stderr。
    const e = new Error(
      'Parser Error: syntax error at or near "="\n\n' +
      'LINE 1: SELECT 1 FROM (SELECT userPhone FROM sessions) WHERE x = \n' +
      '                                                              ^',
    )
    expect(thrownToQueryExit(e, TABLES)).toBe(2)
    const j = JSON.parse(out)
    expect(String(j.error.message)).not.toContain('userPhone')
    expect(String(j.error.message)).toContain('LINE 1: （SQL 原文已省略）')
    expect(err).not.toContain('userPhone')
    expect(err).toContain('LINE 1: （SQL 原文已省略）')
    // 类别与可操作性保住：仍是 SQL 语法错误 + 中文包装
    expect(String(j.error.message)).toMatch(/SQL 语法错误/)
  })

  it('message 里的终端控制字符在出口被净化（security S4，DuckDB 原文路径）', () => {
    const e = Object.assign(new Error('该语句尝试访问文件或网络\u001b]0;OWNED\u0007，已被只读沙箱拦截'), {
      kind: 'usage', code: 'sandbox_blocked',
    })
    expect(thrownToQueryExit(e, TABLES)).toBe(2)
    expect(err).not.toContain('\u001b')
    expect(String(JSON.parse(out).error.message)).not.toContain('\u001b')
  })
})
