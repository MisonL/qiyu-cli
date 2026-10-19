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
import { openSandbox, memoryLimitBytes, type SandboxSession } from '../../src/query/sandbox.js'
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

  it('纯 EXPLAIN 不执行内层：内层写由 layer3 拒、内层文件访问由 layer2 拒', async () => {
    // spec §5.3：EXPLAIN ANALYZE 会真正执行内层语句，已由 layer1 的 ANALYZE 闸门直接拒绝
    //（见下一个 describe）；纯 EXPLAIN 不执行内层，但仍要演示「三层缺一不可」：
    // 纯 EXPLAIN 的内层写由 layer3（READ_ONLY）拒，内层文件访问在 prepare 期由 layer2 拒。
    const { dir, path } = await mkDb()
    const out = join(dir, 'explain-out.csv')
    await withSandbox(path, async (s) => {
      // 内层写：layer1 放行（type=4），执行期被 layer3（READ_ONLY）拒绝 → 不得修改表
      await expectReject(s.run("EXPLAIN INSERT INTO t VALUES (9, 'w')"), { kind: 'internal' })
      // 内层文件访问：prepare 期就被 layer2 拒绝
      await expectReject(s.run(`EXPLAIN COPY t TO '${out}'`), {
        kind: 'usage', code: 'sandbox_blocked',
      })
      const r = await s.run('SELECT COUNT(*) AS n FROM t')
      expect(Number(r.rows[0].n)).toBe(3)
    })
    expect(existsSync(out)).toBe(false)
  })
})

describe('EXPLAIN ANALYZE 内层执行绕过（layer1 追加闸门，spec §5.3 探针 16）', () => {
  it('EXPLAIN ANALYZE CALL enable_profiling() 被拒，且实例配置未被修改', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      await expectReject(s.run('EXPLAIN ANALYZE CALL enable_profiling()'), {
        kind: 'usage', code: 'sandbox_blocked', match: /ANALYZE/,
      })
      // 副作用断言：绕过成立时这里会变成 'query_tree'，后续每条查询的 profile 树会打到 stdout
      const r = await s.run("SELECT current_setting('enable_profiling') AS v")
      expect(r.rows[0].v).toBeNull()
    })
  })

  it('括号形态 (ANALYZE) / (ANALYZE false) / ("ANALYZE") 与 ANALYSE 拼写同样被拒', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      // ("ANALYZE") 实测同样是有效选项名并会执行内层；ANALYSE 是 DuckDB 接受的同义拼写
      const variants = [
        'EXPLAIN (ANALYZE) CALL enable_profiling()',
        'EXPLAIN (ANALYZE false) CALL enable_profiling()',
        'EXPLAIN (ANALYZE, FORMAT JSON) SELECT 1',
        'EXPLAIN ("ANALYZE") CALL enable_profiling()',
        'EXPLAIN ANALYSE CALL enable_profiling()',
        'EXPLAIN ANALYZE PRAGMA enable_profiling',
        'EXPLAIN /*c*/ ANALYZE CALL enable_profiling()',
        'EXPLAIN/**/ANALYZE CALL enable_profiling()',
      ]
      for (const sql of variants) {
        await expectReject(s.run(sql), { kind: 'usage', code: 'sandbox_blocked', match: /ANALYZE/ })
      }
      const r = await s.run("SELECT current_setting('enable_profiling') AS v")
      expect(r.rows[0].v).toBeNull()
    })
  })

  it('EXPLAIN ANALYZE SELECT 被拒；纯 EXPLAIN SELECT 放行', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      await expectReject(s.run('EXPLAIN ANALYZE SELECT * FROM t'), {
        kind: 'usage', code: 'sandbox_blocked', match: /ANALYZE/,
      })
      const r = await s.run('EXPLAIN SELECT * FROM t')
      expect(r.rows.length).toBeGreaterThan(0)
    })
  })

  it('字符串/标识符/注释里的 ANALYZE 不误伤', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      const allowed = [
        "EXPLAIN SELECT 'ANALYZE' AS s",
        "EXPLAIN SELECT 'it''s ANALYZE' AS s",
        'EXPLAIN SELECT 1 AS "ANALYZE"',
        'EXPLAIN SELECT $$ANALYZE$$ AS s',
        'EXPLAIN /* ANALYZE */ SELECT 1',
        'EXPLAIN -- ANALYZE\nSELECT 1',
      ]
      for (const sql of allowed) {
        const r = await s.run(sql)
        expect(r.rows.length, sql).toBeGreaterThan(0)
      }
      // 普通 SELECT 不做记号扫描：列别名 analyze 合法
      expect((await s.run('SELECT 1 AS analyze')).rows).toEqual([{ analyze: 1 }])
      // 引号包裹的列名恰好叫 ANALYZE：不按内层闸门拒绝，照常走到 binder（列不存在 → query_error）
      await expectReject(s.run('EXPLAIN SELECT "ANALYZE" FROM t'), {
        kind: 'usage', code: 'query_error',
      })
    })
  })

  it('词法边界：-- 由 \\r 终止、块注释可嵌套（复审复现的两条绕过）', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      const variants = [
        // DuckDB 的行注释在 \r 处同样终止（实测：本语句 type=4 且会执行内层 CALL）
        'EXPLAIN --x\rANALYZE CALL enable_profiling()',
        // DuckDB 的块注释可嵌套（实测 `SELECT 1 /* /* */ AS x */` 合法）：
        // 按「首个 */ 结束」剥会剩下一段被误当字符串，从而漏掉 ANALYZE
        "EXPLAIN /* /* */ ' */ ANALYZE CALL enable_profiling() -- '",
        'EXPLAIN --x\r\nANALYZE CALL enable_profiling()',
      ]
      for (const sql of variants) {
        await expectReject(s.run(sql), { kind: 'usage', code: 'sandbox_blocked', match: /ANALYZE/ })
      }
      const r = await s.run("SELECT current_setting('enable_profiling') AS v")
      expect(r.rows[0].v).toBeNull()
    })
  })

  it('嵌套块注释里的 ANALYZE 整体剥掉后仍是纯 EXPLAIN（放行）', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      const r = await s.run('EXPLAIN /* /* nested */ ANALYZE */ SELECT 1')
      expect(r.rows.length).toBeGreaterThan(0)
    })
  })

  it('纯 EXPLAIN CALL 不执行内层：放行且配置仍为 null', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      const r = await s.run('EXPLAIN CALL enable_profiling()')
      expect(r.rows.length).toBeGreaterThan(0)
      const v = await s.run("SELECT current_setting('enable_profiling') AS v")
      expect(v.rows[0].v).toBeNull()
    })
  })
})

describe('加固自检与顺序', () => {
  it('current_setting 为 ea=false / lc=true / tz=Asia/Shanghai / ml≥512MiB', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      const r = await s.run(
        "SELECT current_setting('enable_external_access') AS ea, " +
        "current_setting('lock_configuration') AS lc, " +
        "current_setting('TimeZone') AS tz, " +
        "current_setting('memory_limit') AS ml")
      expect(r.rows[0]).toMatchObject({ ea: false, lc: true, tz: 'Asia/Shanghai' })
      // 审查 I-5：memory_limit 是 spec §5.2 声明的加固项，但此前无任何测试观测 ——
      // 删掉 HARDENING_SQL 里那行仍全绿。加固是**封顶**，故断言上限（≤ 1 GiB）：
      // 未加固时回显是机器内存的 80%（本机 51.1 GiB），删行后这条必红。
      // 复审残留：解析失败返回 0 必须算失败（fail-closed），故同时断言 > 0。
      expect(memoryLimitBytes(r.rows[0].ml)).toBeGreaterThan(0)
      expect(memoryLimitBytes(r.rows[0].ml)).toBeLessThanOrEqual(1024 ** 3)
    })
  })

  it('memoryLimitBytes 解析 DuckDB 的格式化回显；无法解析 → 0（自检据此拒绝服务）', () => {
    expect(memoryLimitBytes('953.6 MiB')).toBeCloseTo(953.6 * 1024 ** 2, 0)
    expect(memoryLimitBytes('1.0 GiB')).toBeCloseTo(1024 ** 3, 0)
    expect(memoryLimitBytes('51.1 GiB')).toBeCloseTo(51.1 * 1024 ** 3, 0)
    expect(memoryLimitBytes('1024.0 KiB')).toBe(1024 * 1024)
    expect(memoryLimitBytes('512 B')).toBe(512)
    // 未设 / 改格式 / 非字符串 → 0，宁可拒绝服务也不放过半加固状态
    expect(memoryLimitBytes(null)).toBe(0)
    expect(memoryLimitBytes(undefined)).toBe(0)
    expect(memoryLimitBytes('unlimited')).toBe(0)
    expect(memoryLimitBytes('1GB')).toBe(0)   // 注意：回显不带这种写法，认不出就不认
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
        ['DELETE FROM t', /DELETE/],                                 // 5（类型名，不再是裸数字）
        ['UPDATE t SET a = 1', /UPDATE/],                            // 3
        ['DROP TABLE t', /DROP/],                                    // 15
        ['ALTER TABLE t ADD COLUMN c INTEGER', /ALTER/],             // 9
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

  it('重名输出列：columns 必须是驱动去重后的键（x / x:1），否则脱敏遍历不到第二列（安全 Critical）', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      // 实测（DuckDB 1.5.6-r.1 + @duckdb/node-api）：
      //   columnNames()             = ["a","a"]
      //   deduplicatedColumnNames() = ["a","a:1"]
      //   getRowObjectsJson() 的行键 = {"a":…, "a:1":…}
      // 返回未去重的序列会让调用方（脱敏层）只遍历 a 两次，a:1 永远不被访问。
      const r = await s.run('SELECT a, a FROM t ORDER BY a LIMIT 1')
      expect(r.columns).toEqual(['a', 'a:1'])
      expect(Object.keys(r.rows[0]!).sort()).toEqual(['a', 'a:1'])
    })
  })

  it('timeoutMs 负数 → usage（0 = 无超时）', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      await expectReject(s.run('SELECT 1', { timeoutMs: -1 }), { kind: 'usage' })
      expect((await s.run('SELECT 1 AS x', { timeoutMs: 0 })).rows).toEqual([{ x: 1 }])
    })
  })

  it('列名 __proto__ 被驱动映射成原型属性时 fail-closed，不静默丢列（edge F3）', async () => {
    // 实测：`SELECT "__proto__", b FROM …` 时 getRowObjectsJson 产出的行对象只有 b，
    // 旧实现用 `Object.keys(rows[0])` 取列名 → 显式请求的 __proto__ 连值带名消失、
    // 退出码 0 且零警告。现在列名取 columnNames()，缺自有键即 fail-closed。
    const fakeMod = {
      DuckDBInstance: {
        create: async () => ({
          connect: async () => ({
            run: async () => ({}),
            runAndReadAll: async () => ({
              getRowObjectsJson: () => [{ ea: false, lc: true, ml: '953.6 MiB' }],
              columnNames: () => [] as string[],
            }),
            extractStatements: async () => ({
              count: 1,
              prepare: async () => ({
                statementType: 1,
                parameterCount: 0,
                bind: () => {},
                runAndReadUntil: async () => ({
                  // 行对象**缺** __proto__ 自有键（原型赋值），但真实列名里有它
                  getRowObjectsJson: () => [{ b: 1 }],
                  columnNames: () => ['__proto__', 'b'],
                }),
                destroySync: () => {},
              }),
            }),
            interrupt: () => {},
            closeSync: () => {},
          }),
          closeSync: () => {},
        }),
      },
      StatementType: {},
    }
    const importer = async (): Promise<unknown> => fakeMod
    const s = await openSandbox(cfgFor('/nonexistent/q.db'), { importer })
    try {
      const e = await expectReject(s.run('SELECT "__proto__", b FROM t'), {
        kind: 'internal', code: 'internal', match: /__proto__/,
      })
      expect(e.hint).toMatch(/别名/)
      expect(e.message).toMatch(/无法安全表示/)
    } finally {
      await s.close()
    }
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

  it('close() 真正释放文件锁：子进程能以 READ_WRITE 打开同一文件', async () => {
    // ⚠️ 必须用子进程（测试审查 F1）：DuckDB 的锁是**进程级**的，同一进程里只读会话
    // 仍然开着时 RW create 照样成功 —— 旧版本的同进程断言是空证（把 closeRaw 改成空函数
    // 后 sandbox 仍 40/41 绿）。子进程打开时父进程若仍持锁会报 Conflicting lock。
    const { path } = await mkDb()
    const s = await openSandbox(cfgFor(path))
    await s.close()
    const { execFileSync } = await import('node:child_process')
    const stdout = execFileSync(process.execPath, [
      '--input-type=module',
      '-e',
      `import { DuckDBInstance } from '@duckdb/node-api';
       const i = await DuckDBInstance.create(${JSON.stringify(path)}, { access_mode: 'READ_WRITE' });
       const c = await i.connect();
       await c.run("INSERT INTO t VALUES (4, 'w')");
       const r = await c.runAndReadAll('SELECT COUNT(*) AS n FROM t');
       console.log(r.getRowObjectsJson()[0].n);
       c.closeSync(); i.closeSync();`,
    ], { cwd: process.cwd(), stdio: 'pipe', timeout: 30_000 })
    expect(Number(String(stdout).trim())).toBe(4)
  })

  it('prepare 期错误挂上 cause（原生原文），供 Task 5 补算表/列候选', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      const e = await expectReject(s.run('SELECT * FROM nosuchtable'), {
        kind: 'usage', code: 'query_error',
      })
      expect(e.cause, 'cause 必须是原生 Error').toBeInstanceOf(Error)
      expect((e.cause as Error).message).toMatch(/nosuchtable/)
      // message 仍是「中文前缀 + 原生原文」，格式未变
      expect(e.message).toMatch(/^SQL 无法执行：/)
    })
  })

  it('执行期错误也挂 cause（R11：OOM 的可操作 hint 依赖它）', async () => {
    const { path } = await mkDb()
    await withSandbox(path, async (s) => {
      // CAST 失败发生在执行期（prepare 成功）—— 确定性、不依赖内存压力。
      const e = await expectReject(s.run("SELECT CAST('abc' AS INTEGER) AS n"), {
        kind: 'internal', code: 'internal',
      })
      expect(e.cause, '执行期错误也必须挂原生 Error').toBeInstanceOf(Error)
      expect((e.cause as Error).message).toMatch(/Conversion Error/i)
      expect(e.message).toMatch(/^查询执行失败：/)
    })
  })

  it('Permission 之外的普通错误不被误分类为 sandbox_blocked（收窄后的映射）', async () => {
    // 只有 layer2 的两个签名（file system operations are disabled / Cannot access file）
    // 才归 sandbox_blocked；其它带 "Permission" 字样的原生错误照常走 query_error。
    const fakeMod = {
      DuckDBInstance: {
        create: async () => ({
          connect: async () => ({
            run: async () => ({}),
            runAndReadAll: async () => ({
              getRowObjectsJson: () => [{ ea: false, lc: true, ml: "953.6 MiB" }],
              columnNames: () => [] as string[],
            }),
            extractStatements: async () => ({
              count: 1,
              prepare: async () => {
                throw new Error('Permission Error: opening database file: Operation not permitted')
              },
            }),
            interrupt: () => {},
            closeSync: () => {},
          }),
          closeSync: () => {},
        }),
      },
      StatementType: {},
    }
    const importer = async (): Promise<unknown> => fakeMod
    const s = await openSandbox(cfgFor('/nonexistent/q.db'), { importer })
    try {
      const e = await expectReject(s.run('SELECT 1'), {
        kind: 'usage', code: 'query_error', match: /Operation not permitted/,
      })
      expect(e.code).not.toBe('sandbox_blocked')
    } finally {
      await s.close()
    }
  })

  it('StatementType 的值为字符串时回退常量（不静默挡掉一切）', async () => {
    // 假模块把 StatementType 给成字符串：SELECT 仍应放行（回退 1），而不是全被拒。
    const fakeMod = {
      DuckDBInstance: {
        create: async () => ({
          connect: async () => ({
            run: async () => ({}),
            runAndReadAll: async () => ({
              getRowObjectsJson: () => [{ ea: false, lc: true, ml: "953.6 MiB" }],
              columnNames: () => ['x'],
            }),
            extractStatements: async () => ({
              count: 1,
              prepare: async () => ({
                statementType: 1,
                parameterCount: 0,
                bind: () => {},
                runAndReadUntil: async () => ({
                  getRowObjectsJson: () => [{ x: 1 }],
                  columnNames: () => ['x'],
                }),
                destroySync: () => {},
              }),
            }),
            interrupt: () => {},
            closeSync: () => {},
          }),
          closeSync: () => {},
        }),
      },
      StatementType: { SELECT: '1', EXPLAIN: '4' },
    }
    const importer = async (): Promise<unknown> => fakeMod
    const s = await openSandbox(cfgFor('/nonexistent/q.db'), { importer })
    try {
      expect((await s.run('SELECT 1 AS x')).rows).toEqual([{ x: 1 }])
    } finally {
      await s.close()
    }
  })

  it('加固自检 fail-closed：memory_limit 回显无法解析 / 超过上限 → 拒绝服务（复审 I-5 残留）', async () => {
    // 解析失败（未来 DuckDB 改格式）或未加固（回显机器内存 80%）都必须拒服务，
    // 而不是静默放行一个没封顶的会话。fake importer 让自检回显难以解析的值。
    const makeMod = (ml: string) => ({
      DuckDBInstance: {
        create: async () => ({
          connect: async () => ({
            run: async () => ({}),
            runAndReadAll: async () => ({
              getRowObjectsJson: () => [{ ea: false, lc: true, ml }],
              columnNames: () => ['x'],
            }),
            interrupt: () => {},
            closeSync: () => {},
          }),
          closeSync: () => {},
        }),
      },
      StatementType: {},
    })
    for (const ml of ['unlimited', '51.1 GiB', '']) {
      const importer = async (): Promise<unknown> => makeMod(ml)
      const e = await expectReject(openSandbox(cfgFor('/nonexistent/q.db'), { importer }), {
        kind: 'internal', match: /只读沙箱自检失败/,
      })
      expect(e.message, ml).toContain('memory_limit=')
    }
    // 正例：加固值（953.6 MiB）通过 —— 上面的拒绝不是「一律拒」的退化行为
    const importer = async (): Promise<unknown> => makeMod('953.6 MiB')
    const s = await openSandbox(cfgFor('/nonexistent/q.db'), { importer })
    await s.close()
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
