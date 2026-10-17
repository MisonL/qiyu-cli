// tests/query/sandbox.test.ts
// 三层只读沙箱（spec §5.2/§5.3/§5.4、§十三）。
// ⚠️ 全部用例走真 DuckDB 临时库（mkdtemp 隔离）；单进程单 worker 由 vitest.config.ts 钉死。
// ⚠️ 断言只到 kind/code + 关键子串（plan Self-Review 裁决：不断言 message 全文）。
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { openSandbox, type SandboxSession } from '../../src/query/sandbox.js'
import type { StoreConfig } from '../../src/store/types.js'

// DuckDB 冷启动偶发 >5s，与 tests/store/duckdb.test.ts 同款放宽到 15s。
vi.setConfig({ testTimeout: 15_000 })

const dirs: string[] = []
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true })
})

const cfgFor = (path: string): StoreConfig =>
  ({ backend: 'duckdb', path, readOnlyRetryMs: 30000, batchSize: 1000 })

/** 夹具：rw 建库 + 建表 t（3 行）→ 关闭；返回库路径。只读打开由各用例自己做。 */
async function mkDb(): Promise<{ dir: string; path: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'qiyu-sandbox-'))
  dirs.push(dir)
  const path = join(dir, 'q.db')
  const { DuckDBInstance } = await import('@duckdb/node-api')
  const inst = await DuckDBInstance.create(path)
  try {
    const conn = await inst.connect()
    try {
      await conn.run('CREATE TABLE t (a INTEGER, s VARCHAR)')
      await conn.run("INSERT INTO t VALUES (1, 'x'), (2, 'y'), (3, 'z')")
    } finally {
      conn.closeSync()
    }
  } finally {
    inst.closeSync()
  }
  return { dir, path }
}

async function withSandbox<T>(path: string, fn: (s: SandboxSession) => Promise<T>): Promise<T> {
  const s = await openSandbox(cfgFor(path))
  try {
    return await fn(s)
  } finally {
    await s.close()
  }
}

interface Want { kind: string; code?: string; match?: RegExp }

/** 断言 Promise 必然拒绝，并校验 kind/code/关键子串；返回错误对象供进一步断言。 */
async function expectReject(p: Promise<unknown>, want: Want): Promise<Error & Record<string, unknown>> {
  let caught: unknown
  try {
    await p
  } catch (e) {
    caught = e
  }
  expect(caught, '本应抛错，实际成功返回').toBeInstanceOf(Error)
  const e = caught as Error & Record<string, unknown>
  expect(e.kind, `kind 不符（message: ${e.message}）`).toBe(want.kind)
  if (want.code) expect(e.code, `code 不符（message: ${e.message}）`).toBe(want.code)
  if (want.match) expect(e.message).toMatch(want.match)
  return e
}

/** statSync 的 errno（不存在 → 'ENOENT'）。 */
function statCode(p: string): string {
  try {
    statSync(p)
    return 'EXISTS'
  } catch (e) {
    return (e as NodeJS.ErrnoException).code ?? ''
  }
}

describe('三层沙箱 · 攻击表（spec §5.4）', () => {
  it('COPY TO 被拒且目标文件未创建（layer2 在 prepare 期拦截）', async () => {
    const { dir, path } = await mkDb()
    const target = join(dir, 'out.csv')
    await withSandbox(path, async (s) => {
      await expectReject(s.run(`COPY t TO '${target}'`), { kind: 'usage', code: 'sandbox_blocked' })
    })
    // 副作用断言是这行的全部意义：只断言"报错"而不断言"文件没被创建"等于没测。
    expect(statCode(target)).toBe('ENOENT')
  })

  it('read_csv / read_text / glob 被拒（layer2，用临时目录自建文件）', async () => {
    const { dir, path } = await mkDb()
    const secret = join(dir, 'secret.csv')
    writeFileSync(secret, 'a\n42\n')
    await withSandbox(path, async (s) => {
      for (const sql of [
        `SELECT * FROM read_csv('${secret}')`,
        `SELECT * FROM read_text('${secret}')`,
        `SELECT * FROM glob('${dir}/*')`,
      ]) {
        const e = await expectReject(s.run(sql), { kind: 'usage', code: 'sandbox_blocked' })
        // 文件内容不得以任何形式泄漏到错误消息里
        expect(e.message, sql).not.toContain('42')
      }
    })
  })

  it('ATTACH / EXPORT / INSTALL 被拒且不留副作用', async () => {
    const { dir, path } = await mkDb()
    const attachTarget = join(dir, 'attached.db')
    const exportDir = join(dir, 'exp')
    await withSandbox(path, async (s) => {
      // ATTACH 在 prepare 期就能拿到类型（25），由 layer1 拒绝
      await expectReject(s.run(`ATTACH '${attachTarget}' AS a`), {
        kind: 'usage', code: 'sandbox_blocked', match: /ATTACH/,
      })
      // EXPORT 在 prepare 期就被 layer2 拦下（写文件）
      await expectReject(s.run(`EXPORT DATABASE '${exportDir}'`), {
        kind: 'usage', code: 'sandbox_blocked',
      })
      // INSTALL 的报告类型是 21（LOAD/INSTALL），由 layer1 拒绝
      await expectReject(s.run('INSTALL httpfs'), {
        kind: 'usage', code: 'sandbox_blocked', match: /INSTALL/,
      })
    })
    expect(existsSync(attachTarget)).toBe(false)
    expect(existsSync(exportDir)).toBe(false)
  })

  it('SSRF：read_csv(http://127.0.0.1:PORT/x) 被拒且本地服务收到 0 请求', async () => {
    const { path } = await mkDb()
    const hits: string[] = []
    const server = createServer((req, res) => {
      hits.push(req.url ?? '')
      res.end('a\n1\n')
    })
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
    const port = (server.address() as AddressInfo).port
    try {
      await withSandbox(path, async (s) => {
        await expectReject(s.run(`SELECT * FROM read_csv('http://127.0.0.1:${port}/x.csv')`), {
          kind: 'usage', code: 'sandbox_blocked',
        })
        await expectReject(s.run(`SELECT * FROM read_text('http://127.0.0.1:${port}/x.txt')`), {
          kind: 'usage', code: 'sandbox_blocked',
        })
      })
    } finally {
      await new Promise<void>((resolve) => { server.close(() => resolve()) })
    }
    // 「请求发不出」是 layer2 的验收点：服务端必须一次都没被访问。
    expect(hits).toEqual([])
  })

  it('多语句 SELECT 1; DROP TABLE t 被拒且表仍在', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      await expectReject(s.run('SELECT 1; DROP TABLE t'), {
        kind: 'usage', code: 'sandbox_blocked', match: /一次只接受一条语句/,
      })
      // 表还在（多语句闸门在 prepare 之前，DROP 根本没被执行）
      const r = await s.run('SELECT COUNT(*) AS n FROM t')
      expect(Number(r.rows[0].n)).toBe(3)
    })
  })

  it('PRAGMA enable_external_access=true 被拒（报告类型为 20/SET）', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      await expectReject(s.run('PRAGMA enable_external_access=true'), {
        kind: 'usage', code: 'sandbox_blocked', match: /SET/,
      })
      const r = await s.run("SELECT current_setting('enable_external_access') AS ea")
      expect(r.rows[0].ea).toBe(false)
    })
  })
})

describe('三层对照（缺一不可）', () => {
  it('仅 READ_ONLY 的实例：read_csv 成功、COPY TO 成功且文件被创建', async () => {
    const { dir, path } = await mkDb()
    const src = join(dir, 'in.csv')
    writeFileSync(src, 'a,b\n1,2\n')
    const out = join(dir, 'ro-out.csv')
    const { DuckDBInstance } = await import('@duckdb/node-api')
    // layer3 单独：库是只读的，但文件系统访问仍然开着 —— 这正是「缺一不可」的实证。
    const inst = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' })
    try {
      const conn = await inst.connect()
      try {
        const r = await conn.runAndReadAll(`SELECT * FROM read_csv('${src}')`)
        expect(r.getRowObjectsJson()).toHaveLength(1)
        await conn.run(`COPY t TO '${out}'`)
      } finally {
        conn.closeSync()
      }
    } finally {
      inst.closeSync()
    }
    expect(existsSync(out)).toBe(true)
  })

  it('完整沙箱上同一组语句被拒', async () => {
    const { dir, path } = await mkDb()
    const src = join(dir, 'in.csv')
    writeFileSync(src, 'a,b\n1,2\n')
    const out = join(dir, 'sandbox-out.csv')
    await withSandbox(path, async (s) => {
      await expectReject(s.run(`SELECT * FROM read_csv('${src}')`), {
        kind: 'usage', code: 'sandbox_blocked',
      })
      await expectReject(s.run(`COPY t TO '${out}'`), {
        kind: 'usage', code: 'sandbox_blocked',
      })
    })
    expect(existsSync(out)).toBe(false)
  })

  it('EXPLAIN ANALYZE（type=4）会真正执行内层语句，靠 layer3/layer2 兜底且无副作用', async () => {
    // spec §5.3：EXPLAIN ANALYZE 报告为 4、会真正执行内层语句 —— layer1 放行它，
    // 内层写被 READ_ONLY 拒、内层文件访问在 prepare 期被 layer2 拒。这是「三层缺一不可」
    // 的实证场景，spec 要求单列验收。
    const { dir, path } = await mkDb()
    const out = join(dir, 'explain-out.csv')
    await withSandbox(path, async (s) => {
      // 内层写：layer1 放行，执行期被 layer3（READ_ONLY）拒绝 → 不得修改表
      await expectReject(s.run("EXPLAIN ANALYZE INSERT INTO t VALUES (9, 'w')"), { kind: 'internal' })
      // 内层文件访问：prepare 期就被 layer2 拒绝
      await expectReject(s.run(`EXPLAIN ANALYZE COPY t TO '${out}'`), {
        kind: 'usage', code: 'sandbox_blocked',
      })
      const r = await s.run('SELECT COUNT(*) AS n FROM t')
      expect(Number(r.rows[0].n)).toBe(3)
    })
    expect(existsSync(out)).toBe(false)
  })
})

describe('加固自检与顺序', () => {
  it('current_setting 为 ea=false / lc=true / tz=Asia/Shanghai', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      const r = await s.run(
        "SELECT current_setting('enable_external_access') AS ea, " +
        "current_setting('lock_configuration') AS lc, " +
        "current_setting('TimeZone') AS tz")
      expect(r.rows[0]).toEqual({ ea: false, lc: true, tz: 'Asia/Shanghai' })
    })
  })

  it('lock 之后 SET TimeZone 报 configuration has been locked（顺序敏感的实证）', async () => {
    // 沙箱自身的 SET 会被 layer1 拒绝（type=20），观察不到这条 —— 因此在原生实例上
    // 复现同一加固序列，钉死「顺序敏感」这个 DuckDB 行为（spec §5.2 探针 6）。
    const { path } = await mkDb()
    const { DuckDBInstance } = await import('@duckdb/node-api')
    const inst = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' })
    try {
      const conn = await inst.connect()
      try {
        for (const sql of [
          "SET TimeZone='Asia/Shanghai'", "SET memory_limit='1GB'",
          'SET enable_external_access=false', 'SET lock_configuration=true',
        ]) await conn.run(sql)
        await expect(conn.run("SET TimeZone='UTC'")).rejects.toThrow(/configuration has been locked/)
      } finally {
        conn.closeSync()
      }
    } finally {
      inst.closeSync()
    }
  })

  it('同实例新连接继承加固；不同实例（同一文件）不继承', async () => {
    const { path } = await mkDb()
    const { DuckDBInstance } = await import('@duckdb/node-api')
    const inst = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' })
    try {
      const c1 = await inst.connect()
      try {
        for (const sql of [
          "SET TimeZone='Asia/Shanghai'", "SET memory_limit='1GB'",
          'SET enable_external_access=false', 'SET lock_configuration=true',
        ]) await c1.run(sql)
      } finally {
        c1.closeSync()
      }
      // 配置是实例级：同实例新连接继承设置与锁
      const c2 = await inst.connect()
      try {
        const r = await c2.runAndReadAll(
          "SELECT current_setting('enable_external_access') AS ea, " +
          "current_setting('lock_configuration') AS lc")
        expect(r.getRowObjectsJson()[0]).toEqual({ ea: false, lc: true })
      } finally {
        c2.closeSync()
      }

      // 同一文件的新实例不受影响 —— 所以每个进程/实例首次连接都必须自行加固
      const inst2 = await DuckDBInstance.create(path, { access_mode: 'READ_ONLY' })
      try {
        const c3 = await inst2.connect()
        try {
          const r = await c3.runAndReadAll(
            "SELECT current_setting('enable_external_access') AS ea, " +
            "current_setting('lock_configuration') AS lc")
          expect(r.getRowObjectsJson()[0]).toEqual({ ea: true, lc: false })
        } finally {
          c3.closeSync()
        }
      } finally {
        inst2.closeSync()
      }
    } finally {
      inst.closeSync()
    }
  })
})

describe('白名单与截断', () => {
  it('statementType 表驱动：SELECT/EXPLAIN 放行，2/7/11/16/17/19/20/21/25 拒绝', async () => {
    const { dir, path } = await mkDb()
    await withSandbox(path, async (s) => {
      expect((await s.run('SELECT 1 AS x')).rows).toEqual([{ x: 1 }])
      expect((await s.run('EXPLAIN SELECT 1')).rows.length).toBeGreaterThan(0)

      const blocked: Array<[string, RegExp]> = [
        ["INSERT INTO t VALUES (9, 'w')", /INSERT/],                 // 2
        ['CREATE TABLE z (a INTEGER)', /CREATE/],                    // 7
        [`COPY t TO '${join(dir, 'copy.csv')}'`, /文件或网络/],       // 11（layer2 先拦）
        [`EXPORT DATABASE '${join(dir, 'exp')}'`, /文件或网络/],      // 16（layer2 先拦）
        ['PRAGMA force_checkpoint', /PRAGMA/],                       // 17
        ['CALL pragma_version()', /CALL/],                           // 19
        ["SET TimeZone='UTC'", /SET/],                               // 20
        ['INSTALL httpfs', /INSTALL/],                               // 21
        [`ATTACH '${join(dir, 'a.db')}' AS a`, /ATTACH/],            // 25
        ['DELETE FROM t', /类型 5/],                                 // 映射表外的类型 → 「类型 N」
      ]
      for (const [sql, re] of blocked) {
        await expectReject(s.run(sql), { kind: 'usage', code: 'sandbox_blocked', match: re })
      }
    })
  })

  it('DESCRIBE / SHOW / PRAGMA table_info / PRAGMA database_list 放行（都报告为 type=1）', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      for (const sql of ['DESCRIBE t', 'SHOW TABLES', 'PRAGMA table_info(t)', 'PRAGMA database_list']) {
        const r = await s.run(sql)
        expect(r.rows.length, sql).toBeGreaterThan(0)
      }
    })
  })

  it('空串/纯空白/纯注释/";" 拒绝；"SELECT 1;;" 与尾注释放行', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      for (const sql of ['', '   ', '-- only comment', ';']) {
        await expectReject(s.run(sql), { kind: 'usage', code: 'query_error', match: /为空或无有效语句/ })
      }
      expect((await s.run('SELECT 1;;')).rows).toHaveLength(1)
      expect((await s.run('SELECT 1; -- tail')).rows).toHaveLength(1)
    })
  })

  it('语法错 → usage/query_error 且带底层原文，不得误报「SQL 为空」', async () => {
    // ⚠️ 实测：`SELEC 1` 也在 extractStatements 阶段抛（"Failed to extract statements:
    // Parser Error: syntax error …"），与空串的 "Error in native callback" 同为抛异常。
    // 若一律映射成「SQL 为空」，打错关键字的用户会拿到一条与事实不符的错误。
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      const e = await expectReject(s.run('SELEC 1'), {
        kind: 'usage', code: 'query_error', match: /syntax error/,
      })
      expect(e.message).not.toMatch(/为空/)
      // 列不存在同样在 prepare 期抛 → usage/query_error + 原文（候选由 Task 5 细化）
      await expectReject(s.run('SELECT * FROM t WHERE nosuchcol = 1'), {
        kind: 'usage', code: 'query_error', match: /nosuchcol/,
      })
    })
  })

  it('未绑参（? 且 params 数量不符）拒绝；提供参数则正常执行', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      await expectReject(s.run('SELECT * FROM t WHERE a = ?'), {
        kind: 'usage', code: 'query_error', match: /参数占位符/,
      })
      const r = await s.run('SELECT a FROM t WHERE a = ?', { params: [2] })
      expect(r.rows).toEqual([{ a: 2 }])
    })
  })

  it('limit 截断：3 行表 limit 2 → rows=2/truncated=true；limit 3 → false', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      const r2 = await s.run('SELECT a FROM t ORDER BY a', { limit: 2 })
      expect(r2.rows.map((r) => r.a)).toEqual([1, 2])
      expect(r2.truncated).toBe(true)

      const r3 = await s.run('SELECT a FROM t ORDER BY a', { limit: 3 })
      expect(r3.rows).toHaveLength(3)
      expect(r3.truncated).toBe(false)

      const r4 = await s.run('SELECT a FROM t ORDER BY a', { limit: 4 })
      expect(r4.truncated).toBe(false)

      // 空结果也要给真实列名（不能是空数组）
      const r0 = await s.run('SELECT a AS q FROM t WHERE 1=0')
      expect(r0).toEqual({ columns: ['q'], rows: [], truncated: false })
    })
  })

  it('limit 非 1–10000 的整数 → usage', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      for (const limit of [0, -1, 1.5, 10001]) {
        await expectReject(s.run('SELECT 1', { limit }), { kind: 'usage' })
      }
    })
  })

  it('timeoutMs 负数 → usage（0 = 无超时）', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      await expectReject(s.run('SELECT 1', { timeoutMs: -1 }), { kind: 'usage' })
      expect((await s.run('SELECT 1 AS x', { timeoutMs: 0 })).rows).toEqual([{ x: 1 }])
    })
  })

  it('超时：大范围查询 + timeoutMs=50 → query_timeout；中断后连接仍可用、可正常关闭', async () => {
    const { path } = await mkDb()
    const s = await openSandbox(cfgFor(path))
    try {
      const e = await expectReject(
        s.run('SELECT COUNT(*) FROM range(100000000000)', { timeoutMs: 50 }),
        { kind: 'query_timeout', code: 'query_timeout' })
      expect(e.hint).toMatch(/缩小|timeout/i)
      // 实测：interrupt 后连接仍可用（探针 6/9）
      expect((await s.run('SELECT 1 AS x')).rows).toEqual([{ x: 1 }])
    } finally {
      await s.close()
    }
  })
})

describe('openSandbox 的错误路径', () => {
  it('close 幂等；关闭后 run → usage（不裸崩）', async () => {
    const { path } = await mkDb()
    const s = await openSandbox(cfgFor(path))
    await s.close()
    await s.close() // 第二次 close 不得抛
    await expectReject(s.run('SELECT 1'), { kind: 'usage' })
  })

  it('库不存在 → store_not_initialized（不裸崩，hint 指 store init）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qiyu-sandbox-'))
    dirs.push(dir)
    const e = await expectReject(openSandbox(cfgFor(join(dir, 'missing.db'))), {
      kind: 'store_not_initialized', match: /无法打开数据库/,
    })
    expect(e.hint).toMatch(/store init/)
  })

  it('依赖缺失 → store_not_initialized + 安装指引', async () => {
    const { path } = await mkDb()
    const importer = async (): Promise<unknown> => {
      throw Object.assign(new Error("Cannot find package '@duckdb/node-api'"), { code: 'ERR_MODULE_NOT_FOUND' })
    }
    const e = await expectReject(openSandbox(cfgFor(path), { importer }), {
      kind: 'store_not_initialized', match: /无法加载 DuckDB 依赖/,
    })
    expect(e.hint).toMatch(/npm install/)
  })

  it('ro 撞锁退避超限 → store_locked + retryable + hint（注入 importer，不持真锁）', async () => {
    const importer = async (): Promise<unknown> => ({
      DuckDBInstance: {
        create: async () => { throw new Error('Conflicting lock on database file') },
      },
      StatementType: {},
    })
    const e = await expectReject(
      openSandbox({ ...cfgFor('/nonexistent/q.db'), readOnlyRetryMs: 1 }, { importer }),
      { kind: 'store_locked' })
    expect(e.retryable).toBe(true)
    expect(e.hint).toMatch(/readOnlyRetryMs/)
  })

  it('自检不符（ea=true）→ internal「只读沙箱自检失败」，且连接与实例都被关闭', async () => {
    const closed: string[] = []
    const fakeMod = {
      DuckDBInstance: {
        create: async () => ({
          connect: async () => ({
            run: async () => ({}),
            runAndReadAll: async () => ({
              getRowObjectsJson: () => [{ ea: true, lc: false }],
              columnNames: () => [] as string[],
            }),
            extractStatements: async () => { throw new Error('unused') },
            interrupt: () => {},
            closeSync: () => { closed.push('conn') },
          }),
          closeSync: () => { closed.push('inst') },
        }),
      },
      StatementType: {},
    }
    const importer = async (): Promise<unknown> => fakeMod
    await expectReject(openSandbox(cfgFor('/nonexistent/q.db'), { importer }), {
      kind: 'internal', match: /只读沙箱自检失败/,
    })
    expect(closed).toEqual(['conn', 'inst'])
  })
})
