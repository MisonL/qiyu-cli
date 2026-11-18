import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import type { DuckDbDeps } from '../../src/store/duckdb.js'
import { TABLES } from '../../src/store/schema.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

// L1 对冲：本文件全部用例走真库（DuckDB 冷启动偶发 >5s），统一放宽到 15s。
vi.setConfig({ testTimeout: 15_000 })

let dir = ''
let cfg: StoreConfig
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-duck-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30000, batchSize: 1000 }
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(cfg, 'rw')
  await s.init()
  return s
}

describe('duckdb —— 建表与查询', () => {
  it('init 建出全部表（tables() 排序：v3 批次维度表随迁移落库）', async () => {
    const s = await fresh()
    expect(await s.tables()).toEqual(['daily_overview', 'knowledge_categories', 'knowledge_items',
      'knowledge_points', 'order_performance', 'robot_summary',
      'schema_version', 'sessions', 'staff', 'staff_attendance', 'staff_group_members',
      'staff_groups', 'staff_quality', 'staff_salary_detail', 'staff_satisfaction',
      'staff_workload', 'sync_gaps', 'sync_state', 'tags', 'ticket_categories', 'ticket_logs',
      'ticket_template_fields', 'ticket_templates', 'tickets', 'transfer_human'])
    await s.close()
  })

  it('count 返回 number（BIGINT 字符串收敛，验收 21/31）', async () => {
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: '标签A', color: '#FF0000' }])
    const n = await s.count('tags')
    expect(n).toBe(1)
    expect(typeof n).toBe('number')
    await s.close()
  })

  it('同主键二次 upsert 更新非键列、行数仍 1', async () => {
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FF0000' }])
    await s.upsert('tags', [{ id: '1', name: 'B', color: '#00FF00' }])
    expect(await s.count('tags')).toBe(1)
    const r = await s.query('SELECT name, color FROM tags WHERE id = ?', ['1'])
    expect(r.rows[0]).toEqual({ name: 'B', color: '#00FF00' })
    await s.close()
  })

  it('同批重复主键收敛为一行、后出现的获胜，且与 batchSize 无关', async () => {
    // DuckDB 的多行 INSERT ... ON CONFLICT 在同一语句内遇到重复键时保留**第一条**；
    // 逐条写入（batchSize=1）时则是后一条覆盖前一条 —— 旧实现让结果取决于 batchSize。
    // 现在统一为「后出现者获胜」并返回收敛后的行数。
    for (const batchSize of [1000, 1]) {
      const s = await createDuckDbStore({ ...cfg, batchSize }, 'rw')
      await s.init()
      const n = await s.upsert('tags', [
        { id: '1', name: 'first', color: '#111111' },
        { id: '1', name: 'second', color: '#222222' },
        { id: '2', name: 'other', color: '#333333' },
      ])
      expect(n, `batchSize=${batchSize}：返回值应是收敛后的实际写入行数`).toBe(2)
      expect(await s.count('tags')).toBe(2)
      const r = await s.query('SELECT name, color FROM tags WHERE id = ?', ['1'])
      expect(r.rows[0], `batchSize=${batchSize}：后出现的行应获胜`).toEqual({ name: 'second', color: '#222222' })
      await s.close()
    }
  })

  it('VARCHAR 主键的 number 1 与字符串 \'1\' 是同一个存储值 —— 去重键按列类型归一化', async () => {
    // 按 JS typeof 区分会让 1 与 '1' 分成两个键：同批时 DuckDB 保留第一条、
    // 逐条写入时后者获胜 —— 结果又取决于 batchSize（CodeRabbit PR #65 指出）。
    for (const batchSize of [1000, 1]) {
      const s = await createDuckDbStore({ ...cfg, batchSize }, 'rw')
      await s.init()
      const n = await s.upsert('tags', [
        { id: 1 as unknown as string, name: 'num', color: '#AAAAAA' },
        { id: '1', name: 'str', color: '#BBBBBB' },
      ])
      expect(n, `batchSize=${batchSize}：应合并为一行`).toBe(1)
      expect(await s.count('tags')).toBe(1)
      const r = await s.query('SELECT name FROM tags WHERE id = ?', ['1'])
      expect(r.rows[0]).toEqual({ name: 'str' })
      await s.close()
    }
  })

  it('复合 VARCHAR 主键的去重键无歧义：列值可能含分隔符时不得撞 key', async () => {
    // 用 JSON.stringify 元组序列化，不用分隔符 join（CodeRabbit PR #65）：
    // 若 `group_id` 与 `staff_id` 的值能拼出同一条  串，旧实现会把两行当成一行。
    const s = await fresh()
    // staff_group_members 主键是 (group_id, staff_id)，两列都 VARCHAR。
    const rows = [
      { group_id: 'a', staff_id: 'b', synchronized_at: 't1' },
      { group_id: 'a', staff_id: 'c', synchronized_at: 't2' },
      { group_id: 'a', staff_id: 'b', synchronized_at: 't3' },  // 与第一行同主键，应被合并
    ]
    const n = await s.upsert('staff_group_members', rows)
    expect(n).toBe(2)
    const r = await s.query('SELECT group_id, staff_id, synchronized_at FROM staff_group_members ORDER BY staff_id')
    expect(r.rows).toEqual([
      { group_id: 'a', staff_id: 'b', synchronized_at: 't3' },
      { group_id: 'a', staff_id: 'c', synchronized_at: 't2' },
    ])
    // 构造旧实现的真实撞 key：join('\u0001') 下
    //   ('ab', 'c') → "abc"，('a', 'bc') → "abc"
    // 两组复合值拼出同一条串 —— 旧实现会把它们当成同一主键、静默丢一行。
    const s2 = await createDuckDbStore({ ...cfg, path: join(dir, 'q2.db') }, 'rw')
    await s2.init()
    const n2 = await s2.upsert('staff_group_members', [
      { group_id: 'a\u0001b', staff_id: 'c', synchronized_at: 't5' },
      { group_id: 'a', staff_id: 'b\u0001c', synchronized_at: 't6' },
    ])
    expect(n2, '两组不同的复合主键不得被合并').toBe(2)
    expect(await s2.count('staff_group_members')).toBe(2)
    await s2.close()
  })

  it('19 位 ID 往返仍是字符串、精度不变', async () => {
    const s = await fresh()
    const big = '1234567890123456789'
    await s.upsert('tags', [{ id: big, name: 'X', color: '#000000' }])
    const r = await s.query('SELECT id FROM tags')
    expect(r.rows[0].id).toBe(big)
    await s.close()
  })

  it('查询结果 JSON.stringify 不抛且无 Date 实例', async () => {
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFFFFF' }])
    const r = await s.query('SELECT * FROM tags')
    expect(() => JSON.stringify(r)).not.toThrow()
    for (const v of Object.values(r.rows[0])) expect(v instanceof Date).toBe(false)
    await s.close()
  })

  it('query 的 ? 占位绑定生效（值含引号不破坏语句）', async () => {
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: "O'Brien", color: '#123456' }])
    const r = await s.query('SELECT name FROM tags WHERE id = ?', ['1'])
    expect(r.rows[0].name).toBe("O'Brien")
    expect(r.columns).toEqual(['name'])
    await s.close()
  })
})

describe('duckdb —— upsert 契约', () => {
  it('缺列 → usage 错误、点名列与表', async () => {
    const s = await fresh()
    await expect(s.upsert('tags', [{ id: '1', name: 'A' }] as never)).rejects.toThrow(/color/)
    await s.close()
  })

  it('批次内键集不一致 → usage 错误', async () => {
    const s = await fresh()
    await expect(s.upsert('tags', [
      { id: '1', name: 'A', color: '#FFFFFF' }, { id: '2', name: 'B' },
    ] as never)).rejects.toThrow(/color/)
    await s.close()
  })

  it('未知表/未知列 → usage 错误', async () => {
    const s = await fresh()
    await expect(s.upsert('nope', [{ a: 1 }])).rejects.toThrow(/nope/)
    await expect(s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF', x: 1 }])).rejects.toThrow(/x/)
    await s.close()
  })

  it('null 到 NOT NULL 列 → usage 预检拒绝', async () => {
    const s = await fresh()
    await expect(s.upsert('tags', [{ id: '1', name: null, color: '#FFF' }] as never)).rejects.toThrow(/name/)
    await s.close()
  })

  it('1000 行批量 upsert 走多值 INSERT（spy 断言语句数 == 批次数）', async () => {
    const s = await createDuckDbStore({ ...cfg, batchSize: 1000 }, 'rw')
    await s.init()
    const rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i), name: `n${i}`, color: '#000000' }))
    const spy = vi.spyOn(s as unknown as { execSql: (sql: string, p?: unknown[]) => Promise<unknown> }, 'execSql')
    await s.upsert('tags', rows)
    expect(spy).toHaveBeenCalledTimes(1)
    expect((spy.mock.calls[0][0] as string).match(/VALUES/gi)?.length).toBe(1)
    expect(await s.count('tags')).toBe(1000)
    await s.close()
  })

  // ⚠️ N 组 N6 实测：本用例真库耗时 ≈2.7s（25000 行 2 条 upsert 语句）——
  // 5s testTimeout 内但余量 <40%，单独放宽到 15s 防慢机器/冷启动抖动。
  // ⚠️ 放宽到 60s（2026-11-16 实测）：25000 行的截断库插入 + count，本机负载 700+ 时 15s 必爆
  //（单独重跑仍超时，与改动无关；CI 上约 2s）。同理下一条 2500 行的用例保持 15s 不变。
  it('batchSize 大于硬顶时被 65000 参数硬顶二次切住（M2：行数 = min(batchSize, floor(65000/列数))）', { timeout: 60_000 }, async () => {
    // batchSize=25000、tags 3 列：硬顶 floor(65000/3)=21666 行/语句
    // → 25000 行拆 2 条语句（超大 batchSize 仍被硬顶切住）。
    const s = await createDuckDbStore({ ...cfg, batchSize: 25000 }, 'rw')
    await s.init()
    const rows = Array.from({ length: 25000 }, (_, i) => ({ id: String(i), name: `n${i}`, color: '#000000' }))
    const spy = vi.spyOn(s as unknown as { execSql: (sql: string, p?: unknown[]) => Promise<unknown> }, 'execSql')
    const n = await s.upsert('tags', rows)
    expect(n).toBe(25000)
    expect(spy.mock.calls.length).toBe(2)
    expect(await s.count('tags')).toBe(25000)
    await s.close()
  })

  it('batchSize 小于硬顶时按 batchSize 切批（M2：首选切批尺寸恢复生效）', { timeout: 15_000 }, async () => {
    // batchSize=600、tags 3 列：硬顶 21666 行/语句远未触及 → 2500 行拆 ceil(2500/600)=5 条语句。
    const s = await createDuckDbStore({ ...cfg, batchSize: 600 }, 'rw')
    await s.init()
    const rows = Array.from({ length: 2500 }, (_, i) => ({ id: String(i), name: `n${i}`, color: '#000000' }))
    const spy = vi.spyOn(s as unknown as { execSql: (sql: string, p?: unknown[]) => Promise<unknown> }, 'execSql')
    const n = await s.upsert('tags', rows)
    expect(n).toBe(2500)
    expect(spy.mock.calls.length).toBe(5)   // BEGIN/COMMIT 闭包直调，spy 只数数据语句
    expect(await s.count('tags')).toBe(2500)
    await s.close()
  })

  it('null 到 nullable 列 → 正常写入并读回 null（显式 null ≠ 缺列）', async () => {
    const s = await fresh()
    // G2（v9）起 sync_state 共 11 列：完整列集须含 next_allowed_at / last_rate_limited_at
    // 与 resolved_range_start / resolved_range_end。
    await s.upsert('sync_state', [{ dataset: 'tags', watermark: null, range_status: null,
      last_error: null, locked_by: null, locked_at: null, last_synced_at: null,
      next_allowed_at: null, last_rate_limited_at: null,
      resolved_range_start: null, resolved_range_end: null }])
    const r = await s.query('SELECT watermark, range_status FROM sync_state WHERE dataset = ?', ['tags'])
    expect(r.rows[0].watermark).toBeNull()
    expect(await s.count('sync_state')).toBe(1)
    await s.close()
  })

  it('WriteTx 类型上不含 query/init/close（29c，编译期契约的运行时投影）', async () => {
    // 运行时能做的投影断言：tx 对象自身可枚举属性不含三个被剥掉的方法。
    const s = await fresh()
    await s.transaction(async (tx) => {
      const own = Object.keys(tx)
      expect(own).not.toContain('query')
      expect(own).not.toContain('init')
      expect(own).not.toContain('close')
    })
    await s.close()
  })
})

type FakeAls = ReturnType<NonNullable<DuckDbDeps['makeAls']>>

describe('duckdb —— 事务', () => {
  it('关闭后调用 transaction()：发 usage，且不得重新启用事务上下文（Codex PR#81 第十八轮 P2）', async () => {
    // 事故路径（探针复现）：`close()` 里 `alsTx.disable()` 之后，迟到的 `transaction()` 会
    // 走到 `alsTx.run()` —— 它把实例**重新启用**（被 Node 全局 storageList 强引用），而这条
    // 失败路径不会再 disable，每次迟到调用都在攒一个启用态上下文。`upsert()` 本来就在
    // 入口先查 `closed`，`transaction()` 漏了。
    // 启用状态在 Node 上读不到，所以观察**重新启用的唯一途径**：`run()` 有没有被调用。
    let runs = 0
    const makeAls = (): FakeAls => {
      const real = new AsyncLocalStorage<symbol>()
      return {
        run: <T>(store: symbol, f: () => T): T => { runs++; return real.run(store, f) },
        getStore: () => real.getStore(),
        disable: () => real.disable(),
      }
    }
    const s = await createDuckDbStore(cfg, 'rw', { makeAls })
    await s.init()
    await s.transaction(async (tx) => { await tx.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }]) })
    const before = runs
    expect(before, '前提：正常事务确实用了上下文').toBeGreaterThan(0)
    await s.close()
    const err = await s.transaction(async () => { throw new Error('不该到这里') }).then(() => null, (e: unknown) => e)
    expect(err, '关闭后的 transaction() 必须报 usage').toMatchObject({ kind: 'usage' })
    expect(runs, '关闭后不得再进入上下文（那会把 disable 过的实例重新启用）').toBe(before)
  })

  it('事务进行中被 close：失败路径的回滚不得再进入上下文（CodeRabbit PR#81 第十九轮 minor）', async () => {
    // 事故路径：`close()` 置 `closed` 并 `alsTx.disable()`；进行中的事务下一次语句（通常是
    // COMMIT）报「连接已关闭」→ catch 里原样 `alsTx.run(token, safeRollback)` 又把它启用，
    // 而 `safeRollback` 因 `closed` 必然失败、之后也没人 disable。每次「事务中关库」都漏一个。
    let runs = 0
    const makeAls = (): FakeAls => {
      const real = new AsyncLocalStorage<symbol>()
      return {
        run: <T>(store: symbol, f: () => T): T => { runs++; return real.run(store, f) },
        getStore: () => real.getStore(),
        disable: () => real.disable(),
      }
    }
    const s = await createDuckDbStore(cfg, 'rw', { makeAls })
    await s.init()
    // ⚠️ 钉住判据的前提（CodeRabbit PR#81 第二十七轮 major 的疑问：`init()` 会不会自己让
    // `runs` 非零、使下面的精确断言与回滚无关地成立）：实测 init 不进入事务上下文。
    expect(runs, '前提：初始化不进入事务上下文（否则下面的 runs===1 不能归因于事务）').toBe(0)
    const tx = s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
      await s.close()                       // 事务进行中关库：后续语句必失败
    })
    const err = await tx.then(() => null, (e: unknown) => e)
    expect(err, '事务中的语句在关闭后报 usage').toMatchObject({ kind: 'usage' })
    // 正常路径上 BEGIN / 回调 / COMMIT 共用**一次** `alsTx.run`：`runs === 1`。
    // 回滚若也进入上下文就是 2 —— 精确断言，宽松的 `<= n` 会被正常路径自身满足。
    expect(runs, '关闭后的回滚路径不得再进入上下文').toBe(1)
  })

  it('语句下发期间另一条链开启事务 → 该语句被拒、对方事务不丢写（CodeRabbit PR#81 第二十八轮 major）', async () => {
    // 事故路径（实测复现，见 src/store/duckdb.ts 的 `txEpoch` 注释）：`execSql` 的归属检查在
    // **下发前**，检查与驱动真正执行之间隔着 await（驱动内部 `runUntilLast` / `prepared.run()`）。
    // 外部链的语句在这段窗口里，另一条链开了事务 —— 前者就落进后者的事务；它一旦执行期报错
    // （CAST 失败的 view），所有者 COMMIT 返回成功而写入被静默丢弃（实测 count 从 1 变 0）。
    //
    // 复现：经 `deps.importer` 注入包装后的驱动 —— 连接上的 `runAndReadAll` 在真正执行外部
    // 那条语句前，先等另一条链把事务**完整地**开起来（BEGIN 已发出）。这道闸门位于 `execSql`
    // 的归属检查**之后**，正是事故窗口的位置。
    const real = await import('@duckdb/node-api')
    let release!: () => void
    let gate: Promise<void> | undefined = undefined
    let holdNext = false
    const importer = async (): Promise<unknown> => ({
      ...real,
      DuckDBInstance: {
        create: async (...a: unknown[]) => {
          const inst = await (real.DuckDBInstance.create as (...x: unknown[]) => Promise<unknown>)(...a)
          const ii = inst as { connect: () => Promise<unknown>; closeSync?: () => void }
          return {
            ...(inst as object),
            // ⚠️ `Store.close()` 调的是原型上的 `closeSync()`，对象展开复制不到 —— 两层都要转发
            // （CodeRabbit PR#81 第三十一/三十二轮 major：不转发会泄漏原生连接与实例）
            closeSync: () => ii.closeSync?.(),
            connect: async () => {
              const c = await ii.connect()
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  const target = cc
                  if (holdNext && sql.includes('bad_cast_q28')) {
                    holdNext = false
                    gate = new Promise<void>((r) => { release = r })
                    await gate
                  }
                  return target.runAndReadAll(sql, params)
                },
              }
            },
          }
        },
      },
    })
    const s = await createDuckDbStore(cfg, 'rw', { importer })
    await s.init()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    const orig = (s as unknown as { execSql: (sql: string, p?: unknown[]) => Promise<unknown> }).execSql
    await orig.call(s, "CREATE VIEW bad_cast_q28 AS SELECT CAST('x' AS INT) AS v")
    holdNext = true
    const outside = s.query('SELECT * FROM bad_cast_q28').then(() => 'ok', (e: unknown) => e)
    // 等外部语句通过归属检查、停在驱动闸门上
    for (let i = 0; i < 200 && gate === undefined; i++) await new Promise((r) => setImmediate(r))
    expect(gate, '前提：外部语句确实停在下发之前的窗口里').toBeDefined()
    // 窗口内开事务并写一行；BEGIN 发出后再放行外部语句
    let began!: () => void
    const beganP = new Promise<void>((r) => { began = r })
    const tx = s.transaction(async (t) => {
      began()
      await new Promise((r) => setTimeout(r, 80))   // 等外部语句在事务里下发完
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
    })
    await beganP
    await new Promise((r) => setTimeout(r, 20))
    release()
    const outsideErr = await outside
    const txErr = await tx.then(() => null, (e: unknown) => e)
    expect(outsideErr, '窗口内下发的语句必须被拒绝（internal），不能静默落进别人的事务')
      .toMatchObject({ kind: 'internal' })
    // ⚠️ 这条语句是**执行期**报错的（CAST 失败在服务端才发生），事务已被标成 aborted —— 那一步
    // 无法撤销。判据要保证的是**不静默**：所有者随后无论 COMMIT 还是写都会响亮失败（原先
    // COMMIT 返回成功、写入被丢弃、count 从 1 变 0）。这里断言「要么成功且行在，要么失败且行不在」。
    const rows = await s.count('tags')
    expect(rows, '事务失败时其写入不得部分残留；成功时必须完整在库里')
      .toBe(txErr === null ? 2 : 1)
    // ⚠️ 显式关库：包装器已转发两层 `closeSync`（见 `importer` 注释），必须真的关到原生连接与实例 ——
    // 否则锁随进程存活，且 teardown 的 `rmSync` 会撞锁（CR 第三十二轮 major 要求先证明已关闭）。
    await s.close()
  })

  it('语句下发期间另一条链开事务、外部语句执行期报错、回调直接返回 → 事务必须响亮失败，不得 COMMIT 成功而丢写（CodeRabbit PR#81 第三十一轮 major / Codex P2）', async () => {
    // 事故路径（探针实测，DuckDB 1.5.6）：事务内一条语句执行期报错后，DuckDB 把整条事务标成
    // aborted —— 所有者回调若直接 return，`COMMIT` 的结局取决于时序：可能报 aborted，也可能
    // 返回成功而事务内的写入**全部被丢弃**。外部语句的错误只 reject 给发起它的那条链，
    // 所有者原本看不到。判据：所有者不得拿到成功；事务内写入不得残留。
    const real = await import('@duckdb/node-api')
    let release!: () => void
    let gate: Promise<void> | undefined
    let holdNext = false
    // 事件序列（CR 第三十三轮要求证明「外部语句确实在所有者事务内执行、它的错误在 COMMIT 之后
    // 才交回」）：前两个事件由测试在关键点追加，另两个由包装器在驱动返回 / 交回错误时记录。
    const events: string[] = []
    // ⚠️ 包装对象替身整个实例：`Store.close()` 调的是 `conn.closeSync()` / `inst.closeSync()`，
    // 它们挂在**原型**上，对象展开复制不到 —— 不转发就等于原生连接/实例泄漏（锁随进程存活）。
    // 所以在包 `runAndReadAll` 的同时把两层 `closeSync` 一并转发（CodeRabbit PR#81 第三十一轮 major）。
    const importer = async (): Promise<unknown> => ({
      ...real,
      DuckDBInstance: {
        create: async (...a: unknown[]) => {
          const inst = await (real.DuckDBInstance.create as (...x: unknown[]) => Promise<unknown>)(...a)
          const ii = inst as { connect: () => Promise<unknown>; closeSync?: () => void }
          return {
            ...(inst as object),
            closeSync: () => ii.closeSync?.(),
            connect: async () => {
              const c = await ii.connect()
              const cc = c as {
                runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>
                closeSync?: () => void
              }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (holdNext && sql.includes('bad_cast_q31')) {
                    // 闸门在**执行之后、结果返回之前**：语句已在事务内执行并污掉事务，外部调用方
                    // 还没拿到错误。⚠️ 拒绝也要**先接住**再扣住（CR/Codex 第三十三轮 P2）：直接
                    // `await cc.runAndReadAll()` 会在 reject 时跳过闸门，错误不被延迟。
                    holdNext = false
                    gate = new Promise<void>((r) => { release = r })
                    // 错误必须**先接住**再扣住：不接的话拒绝在闸门之前就交回调用方了。接住 = 语句
                    // 已执行完（事务被污掉），闸门只挡住「结果 / 错误交回」。
                    const seen = cc.runAndReadAll(sql, params).then(() => 'ok' as const, (e: unknown) => e)
                    await seen
                    events.push('external-executed')
                    await gate
                    const res = await seen
                    events.push('external-settled')
                    if (res !== 'ok') throw res
                    return res
                  }
                  return cc.runAndReadAll(sql, params)
                },
              }
            },
          }
        },
      },
    })
    const s = await createDuckDbStore(cfg, 'rw', { importer })
    await s.init()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    const orig = (s as unknown as { execSql: (sql: string, p?: unknown[]) => Promise<unknown> }).execSql
    await orig.call(s, "CREATE VIEW bad_cast_q31 AS SELECT CAST('x' AS INT) AS v")
    holdNext = true
    const outside = s.query('SELECT * FROM bad_cast_q31').then(() => 'ok', (e: unknown) => e)
    // ⚠️ 外部语句必须**先进入事务内执行**（它是在所有者 BEGIN 之后才下发的，crossEpoch 检查在
    // 下发前通过、执行期间代号变了）；然后才起所有者 —— 不能先起事务再等外部语句执行完：
    // 那样它的 BEGIN 会撞上事务的归属检查「跨代即拒绝」，断言就测不到 COMMIT 那条路径了。
    for (let i = 0; i < 200 && gate === undefined; i++) await new Promise((r) => setImmediate(r))
    expect(gate, '前提：外部语句确实停在下发之前的窗口里').toBeDefined()
    let began!: () => void
    const beganP = new Promise<void>((r) => { began = r })
    const tx = s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
      began()
      events.push('began')
      await new Promise((r) => setTimeout(r, 80))
      // ⚠️ 关键：回调在此**直接返回**（不再发任何语句 —— 不会被 aborted 挡住而偶然失败）
    })
    await beganP
    await new Promise((r) => setTimeout(r, 20))
    // ⚠️ 闸门**不动**：外部语句的结果（这里是错误）直到事务落定之后才交回 —— 所有者提交时
    // 看不到任何由「错误交回」得出的记号（`txBrokenByExternal` 在错误路径里设置，此刻还没跑）。
    const txErr = await tx.then(() => null, (e: unknown) => e)
    events.push('tx-settled')
    release()
    expect(await outside, '外部语句被拒').toMatchObject({ kind: 'internal' })
    expect(txErr, '事务必须响亮失败，不得返回成功').not.toBeNull()
    // 成因必须点名「事务未提交 + 已整体回滚」（`commitOrRefuse`），不能只说驱动原文 ——
    // 只报驱动原文时调用方不知道数据没落库，也不会去查并行调用。
    expect((txErr as Error).message, '成因要点名未提交与整体回滚').toMatch(/事务未提交.*已整体回滚/)
    expect(await s.count('tags'), '事务内的写入不得残留（整体回滚）').toBe(1)
    await s.close()
  })

  it('外部语句在所有者提交之后才报错 → 同样不得 COMMIT 冒充成功（CR 第三十三轮 major）', async () => {
    // CR 第三十三轮的两条成因：①「记号要等外部拒绝交回才设置」；②「外部语句在所有者 BEGIN
    // **之前**就执行完」。本用例把两者同时摆正：外部语句在所有者 BEGIN 之前就已**执行完**，
    // 但它的错误一直扣到所有者事务落定之后才交回 —— 所有者提交那一刻没有任何「错误已交回」
    // 的记号可用，只能靠执行期就留下的证据。
    const real = await import('@duckdb/node-api')
    const events: string[] = []
    let release!: () => void
    let gate: Promise<void> | undefined
    let holdNext = false
    const importer = async (): Promise<unknown> => ({
      ...real,
      DuckDBInstance: {
        create: async (...a: unknown[]) => {
          const inst = await (real.DuckDBInstance.create as (...x: unknown[]) => Promise<unknown>)(...a)
          const ii = inst as { connect: () => Promise<unknown>; closeSync?: () => void }
          return {
            ...(inst as object),
            closeSync: () => ii.closeSync?.(),
            connect: async () => {
              const c = await ii.connect()
              const cc = c as {
                runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>
                closeSync?: () => void
              }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (!holdNext || !sql.includes('bad_cast_q33')) return cc.runAndReadAll(sql, params)
                  holdNext = false
                  gate = new Promise<void>((r) => { release = r })
                  // 错误必须**先接住**再扣住：不接的话拒绝在闸门之前就交回调用方了。接住 = 语句
                  // 已执行完（事务被污掉），闸门只挡住「结果 / 错误交回」。
                  const outcome = cc.runAndReadAll(sql, params).then(() => 'ok', (e: unknown) => e)
                  await outcome
                  events.push('external-executed')
                  await gate
                  const res = await outcome
                  events.push('external-settled')
                  if (res !== 'ok') throw res
                  return res
                },
              }
            },
          }
        },
      },
    })
    const s = await createDuckDbStore(cfg, 'rw', { importer })
    await s.init()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    const orig = (s as unknown as { execSql: (sql: string, p?: unknown[]) => Promise<unknown> }).execSql
    await orig.call(s, "CREATE VIEW bad_cast_q33 AS SELECT CAST('x' AS INT) AS v")
    holdNext = true
    const outside = s.query('SELECT * FROM bad_cast_q33').then(() => 'ok', (e: unknown) => e)
    for (let i = 0; i < 200 && gate === undefined; i++) await new Promise((r) => setImmediate(r))
    expect(gate, '前提：外部语句确实停在下发之前的窗口里').toBeDefined()
    let began!: () => void
    const beganP = new Promise<void>((r) => { began = r })
    const tx = s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
      began()
      events.push('began')
      await new Promise((r) => setTimeout(r, 80))
    })
    await beganP
    await new Promise((r) => setTimeout(r, 20))
    // 闸门**不动**：外部错误直到所有者落定之后才交回，提交那一刻没有任何「错误已交回」的记号。
    const txErr = await tx.then(() => null, (e: unknown) => e)
    events.push('tx-settled')
    release()
    expect(await outside, '外部语句被拒').toMatchObject({ kind: 'internal' })
    expect(events.slice(0, 3), '外部语句先执行完、所有者随后才开始、事务先落定').toEqual(
      ['external-executed', 'began', 'tx-settled'])
    expect(events.indexOf('tx-settled'), '事务在外部错误交回之前落定').toBeLessThan(events.indexOf('external-settled'))
    expect(txErr, '所有者不得拿到提交成功').not.toBeNull()
    expect((txErr as Error).message, '成因要点名未提交与整体回滚').toMatch(/事务未提交.*已整体回滚/)
    expect(await s.count('tags'), '事务内的写入不得残留（整体回滚）').toBe(1)
    await s.close()
  })

  it('语句下发期间另一条链开启事务（语句本身成功）→ 同样被拒（CodeRabbit PR#81 第二十八轮 major）', async () => {
    // 成功路径与失败路径共用同一个判据（`txEpoch`）：这条语句若落进别人的事务，它的成功
    // 只说明"在本事务里执行成功"，仍会随对方回滚而消失，或把对方的事务一起带下车 ——
    // 与失败路径同样归为 internal。这条用例用**成功**的 SELECT 走一遍。
    const real = await import('@duckdb/node-api')
    let release!: () => void
    let gate: Promise<void> | undefined
    let holdNext = false
    const importer = async (): Promise<unknown> => ({
      ...real,
      DuckDBInstance: {
        create: async (...a: unknown[]) => {
          const inst = await (real.DuckDBInstance.create as (...x: unknown[]) => Promise<unknown>)(...a)
          const ii = inst as { connect: () => Promise<unknown>; closeSync?: () => void }
          return {
            ...(inst as object),
            // ⚠️ `Store.close()` 调的是原型上的 `closeSync()`，对象展开复制不到 —— 两层都要转发
            // （CodeRabbit PR#81 第三十一/三十二轮 major：不转发会泄漏原生连接与实例）
            closeSync: () => ii.closeSync?.(),
            connect: async () => {
              const c = await ii.connect()
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  const target = cc
                  if (holdNext && sql.includes('tags')) {
                    holdNext = false
                    gate = new Promise<void>((r) => { release = r })
                    await gate
                  }
                  return target.runAndReadAll(sql, params)
                },
              }
            },
          }
        },
      },
    })
    const s = await createDuckDbStore(cfg, 'rw', { importer })
    await s.init()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    holdNext = true
    const outside = s.count('tags').then(() => 'ok', (e: unknown) => e)
    for (let i = 0; i < 200 && gate === undefined; i++) await new Promise((r) => setImmediate(r))
    expect(gate, '前提：外部语句停在下发之前').toBeDefined()
    let began!: () => void
    const beganP = new Promise<void>((r) => { began = r })
    const tx = s.transaction(async (t) => {
      began()
      await new Promise((r) => setTimeout(r, 80))
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
    })
    await beganP
    await new Promise((r) => setTimeout(r, 20))
    release()
    expect(await outside, '成功路径同样必须被拒绝（internal）').toMatchObject({ kind: 'internal' })
    await tx.then(() => null, () => null)
    await s.close()
    // ⚠️ **只断言「s.close() 不抛」证明不了实例已关**（实测记录）：把三处包装器的实例 `closeSync`
    // 转发删掉，本文件 61 条全绿；s.close() 在自己**进程内**释放实例锁（单进程重复打开会走共享/等待），
    // 文件也能删。真实泄漏信号只出现在**跨进程**（锁随进程存活，见 duckdb.ts 的 N1 实测）。
    // 所以这里不去造一个本机证明不了的断言（试过「删库不抛」，变异后依旧全绿，已撤）：
    // 转发本身照 `wrapConn`（同文件，已有真实覆盖）的写法做，跨进程泄漏不在单测可达范围内 —— 如实记录。
  })

  it('事务回调里 close() 之后再写/删/读 → 一律 usage「数据库连接已关闭」，不得误诊成并发竞争（Codex PR#81 第二十五轮 P3）', async () => {
    // 事故路径（实测复现）：`transaction(async () => { await s.close(); await s.upsert(…) })` 时
    // `inTx` 还没复位，写路径若先判归属就抛 internal + 「不要用 Promise.all 并行调用…」——
    // 成因说反了（真实原因是连接已关，唯一修法是别在关闭后继续用）。同一个 Store 上 `count`
    // 走 `execSql`（先判 closed）报的是 usage —— 三路必须同一口径。
    const cases: Array<[string, (s: Store) => Promise<unknown>]> = [
      ['upsert', (s) => s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])],
      ['delete', (s) => s.delete('tags', 'TRUE')],
      ['count', (s) => s.count('tags')],
    ]
    for (const [name, act] of cases) {
      const s = await fresh()
      // ⚠️ **`act(s)` 的 rejection 必须单独取**（CodeRabbit PR#81 第二十七轮 minor）：
      // 原先只断言事务整体的 rejection —— `act` 若退化成「关闭后静默成功」，回调正常结束，
      // 紧接着的 COMMIT 照样在已关连接上失败并报 usage，用例**照样通过**（假绿，探针确认过）。
      // 现在把两者分开：act 自己必须拒绝且点名「数据库连接已关闭」；事务完成路径另有一条断言。
      let actErr: unknown = 'act 未抛错'
      const txErr = await s.transaction(async () => {
        await s.close()
        actErr = await act(s).then(() => 'act 未抛错', (e: unknown) => e)
      }).then(() => null, (e: unknown) => e)
      expect(actErr, `${name}：关闭后 act 本身必须拒绝`).toMatchObject({ kind: 'usage' })
      expect((actErr as Error).message, `${name}：报错点名真正成因（连接已关闭），不得说成并发竞争`)
        .toContain('数据库连接已关闭')
      expect(txErr, `${name}：事务完成路径同样报 usage（不再静默成功）`).toMatchObject({ kind: 'usage' })
    }
  })

  it('事务进行中：所有者链自己的读照常工作；只有**别的链**的读才被拒（CodeRabbit PR#81 第二十一轮 major 的反面证据）', async () => {
    // CR 担心的形态：闸门下移到 `execSql` 后读语句也过归属检查，会不会把**既有调用方**的读
    // 从「能跑」变成 `internal`。判据是「谁在发」：同一事务所有者链里的读（tx.count / tx.tables）
    // 与事务外的顺序读都必须照常返回，只有别的异步链在事务期间发的读才被拒。
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    const outsideBefore = await s.count('tags')          // 事务之前：正常
    // 注意：upsert 自开的自动事务覆盖了事务外的调用；这里随后做显式事务。
    let ready!: () => void
    const txReady = new Promise<void>((r) => { ready = r })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let insideCount = -1
    let insideTables: string[] = []
    const tx = s.transaction(async (tx) => {
      await tx.upsert('tags', [{ id: '2', name: 'B', color: '#00FF00' }])
      insideCount = await tx.count('tags')               // 所有者链的 count
      insideTables = await tx.tables()                   // 所有者链的 tables
      ready()
      await gate
    })
    await txReady
    const other = await s.count('tags').then(() => null, (e: unknown) => e)
    release()
    await tx
    expect(outsideBefore).toBe(1)
    expect(insideCount, '所有者链的 count 必须照常返回').toBe(2)
    expect(insideTables, '所有者链的 tables 必须照常返回').toContain('tags')
    expect(other, '**别的链**在事务期间的读被拒成 internal（并入会污染事务）').toMatchObject({ kind: 'internal' })
    expect(await s.count('tags'), '事务结束后事务外的读恢复').toBe(2)
    await s.close()
  })

  it('成功提交', async () => {
    const s = await fresh()
    await s.transaction(async (tx) => { await tx.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }]) })
    expect(await s.count('tags')).toBe(1)
    await s.close()
  })

  it('异常回滚（tx 内多批 upsert → 回滚后全无，验收 29a）', async () => {
    const s = await createDuckDbStore({ ...cfg, batchSize: 1 }, 'rw')
    await s.init()
    await expect(s.transaction(async (tx) => {
      await tx.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
      await tx.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(await s.count('tags')).toBe(0)
    await s.close()
  })

  it('tx 外 upsert 自开事务（验收 29b）', async () => {
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    expect(await s.count('tags')).toBe(1)
    await s.close()
  })

  it('delete 在 await count 期间被别人的事务截胡 → 拒绝（CodeRabbit PR#81 major）', async () => {
    // 事故路径：`del` 先 `count`（await）再 DELETE。若归属检查只在**入口**判一次，
    // 别的调用方正好在这段 await 里开事务，那条 DELETE 就被并进去、随对方回滚一起消失
    // （而返回值还说「删了 N 行」）。判据必须贴着语句派发。
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FF0000' }])
    const origCount = s.count.bind(s)
    let enteredCount!: () => void
    const inCount = new Promise<void>((r) => { enteredCount = r })
    let releaseCount!: () => void
    const countGate = new Promise<void>((r) => { releaseCount = r })
    ;(s as unknown as { count: (t: string) => Promise<number> }).count = async (t: string) => {
      enteredCount()
      await countGate
      return origCount(t)
    }
    const delP = s.delete('tags', 'id = ?', ['1']).then(() => null, (e: unknown) => e)
    await inCount                       // delete 已卡在 count 里
    // 此时开一条事务（`inTx` 在这一刻变成 true），并把它**挂住**直到观察到结论 ——
    // 否则它会在我们放行 count 之前就 COMMIT，`inTx` 已回到 false，这条用例变成空转
    // （首版就是这么写的，实测 delete 静默通过）。
    let txReady!: () => void
    const txStarted = new Promise<void>((r) => { txReady = r })
    let releaseTx!: () => void
    const txHold = new Promise<void>((r) => { releaseTx = r })
    const tx = s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#00FF00' }])
      txReady()
      await txHold
    })
    await txStarted
    releaseCount()                      // 让那条 DELETE 走到派发点
    const delErr = await delP
    releaseTx()
    await tx
    expect(delErr, '截胡的 DELETE 必须被拒绝，不能静默并入别人的事务').toMatchObject({ kind: 'internal' })
    // 数据面证据：那一行既没被删（DELETE 没执行），事务那一行正常提交
    const after = (await s.query('SELECT id FROM tags ORDER BY id')).rows.map((r) => String(r.id))
    expect(after).toEqual(['1', '2'])
    await s.close()
  })

  it('transaction() 正卡在 BEGIN 时，外部 delete 不得被并入（CodeRabbit PR#81 第七轮 major）', async () => {
    // 事故路径：归属登记（`inTx`/`txToken`）原先在 `await execSql('BEGIN')` **之后**才做。
    // 于是 BEGIN 这条 await 期间 `inTx` 仍是 false：外部 `delete` 的归属检查直接放行，
    // 它的 DELETE 被排到 BEGIN 之后 —— 并入这条事务、随它回滚而消失，而 delete 还返回
    // 「删了 N 行」。与「await count 期间被截胡」是同一个缺口的两端（那里是入口到派发，
    // 这里是 BEGIN 本身）。
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FF0000' }])
    // ⚠️ count 必须**立即**敲定：真实 SELECT 的往返可能晚于 BEGIN 落定，窗口就关闭了，
    // 这条用例会空转（与上面那条「首版 count 先完成」同一个坑）。
    ;(s as unknown as { count: (t: string) => Promise<number> }).count = async () => 0
    let releaseTx!: () => void
    const txHold = new Promise<void>((r) => { releaseTx = r })
    let txReady!: () => void
    const txStarted = new Promise<void>((r) => { txReady = r })
    const tx = s.transaction(async (t) => {
      txReady()
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#00FF00' }])
      await txHold
      throw new Error('回滚')
    }).catch(() => null)
    // 同步紧随其后发起：此刻 transaction() 正卡在 `await execSql('BEGIN')`
    const delP = s.delete('tags', 'id = ?', ['1']).then(() => null, (e: unknown) => e)
    await txStarted
    const delErr = await delP
    releaseTx()
    await tx
    expect(delErr, 'BEGIN 窗口内的 DELETE 必须被拒绝，不能静默并入别人的事务').toMatchObject({ kind: 'internal' })
    const after = (await s.query('SELECT id FROM tags ORDER BY id')).rows.map((r) => String(r.id))
    expect(after, '回滚后那一行必须还在（DELETE 不得真的执行）').toEqual(['1'])
    await s.close()
  })

  it('不支持路径上的第二条 BEGIN 不会发出（评审建议的核心诉求），且手开事务的失败形态是响亮的', async () => {
    // 背景（CodeRabbit PR#81 第八轮 major 的实测裁定）：手开事务存在时，`transaction()` /
    // `upsert` 的 BEGIN 会被 DuckDB 拒绝，**且它已把那条事务标记为 aborted** —— 不管我们
    // 之后发不发 ROLLBACK，那条事务的数据都保不住。实测两种收尾：
    //   · 发 ROLLBACK（本实现）：连接恢复干净；调用方随后的 COMMIT 报 `no transaction is
    //     active`（**响亮**）；
    //   · 不发：COMMIT 返回成功，但写入被静默丢弃（行数归零、无报错）—— 更糟。
    // 所以收了 major 的**真正诉求**：不让第二条 BEGIN 在支持路径上出现（自动事务登记归属），
    // 拒绝了它的收尾方案。本用例钉住两点：① 并发显式事务在入口被拒（不发 BEGIN）；
    // ② 手开事务被撞时的失败是响亮的（COMMIT 报错），而不是静默丢数据。
    const s = await fresh() as unknown as Store & { execSql: (q: string, p?: unknown[]) => Promise<unknown> }
    await s.execSql('BEGIN')
    await s.execSql(`INSERT INTO "tags" VALUES ('9', 'locked', '#000000')`)
    await expect(s.transaction(async () => { /* 不该进来 */ })).rejects.toThrow(/within a transaction/)
    await expect(s.execSql('COMMIT'), '被撞的手开事务必须**响亮**失败，而不是 COMMIT 成功却丢了行')
      .rejects.toThrow(/no transaction is active/)
    // 登记已复位、连接可用
    await s.upsert('tags', [{ id: '7', name: 'Y', color: '#222222' }])
    expect((await s.query('SELECT id FROM tags ORDER BY id')).rows.map((r) => String(r.id))).toEqual(['7'])
    await s.close()
  })

  it('外部 delete 的第一条语句（count）报错也不得污掉所有者的事务（CodeRabbit PR#81 第十轮 major）', async () => {
    // 事故路径（实测复现）：`del` 先 `count`、后判归属。若只在 count **之后**判，这条
    // count 就已经落在别人的事务里执行了 —— 而**任何**执行期错误（实测：目标表被换成
    // CAST 失败的 view）都会把那条事务标成 aborted：所有者的 COMMIT 返回**成功**，
    // 写入却被静默丢弃（实测 tags 行数归零、无任何报错）。
    // 判据：外部 delete 必须**一条语句都不发**被拒；所有者的写入必须在提交后真实存在。
    const s = await fresh()
    const sAny = s as unknown as { execSql: (q: string, p?: unknown[]) => Promise<unknown> }
    await sAny.execSql('CREATE TABLE aux (v VARCHAR)')
    await sAny.execSql(`INSERT INTO aux VALUES ('not-an-int')`)
    await sAny.execSql('DROP TABLE "robot_summary"')
    await sAny.execSql('CREATE VIEW "robot_summary" AS SELECT v FROM aux WHERE CAST(v AS INTEGER) > 0')
    let ready!: () => void
    const txReady = new Promise<void>((r) => { ready = r })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const txP = s.transaction(async (tx) => {
      await tx.upsert('tags', [{ id: '9', name: 'owner', color: '#FFF' }])
      ready()
      await gate
    }).then(() => 'committed', (e: unknown) => `rejected: ${(e as Error).message}`)
    await txReady
    // 外部 delete 打到那张一执行就报错的 view 上
    const outside = await s.delete('robot_summary', 'TRUE')
      .then(() => 'ok', (e: unknown) => e)
    expect(outside, '外部 delete 必须在发出任何语句前被拒（kind:internal），'
      + '否则它的 count 会执行并污掉所有者的事务').toMatchObject({ kind: 'internal' })
    release()
    expect(await txP).toBe('committed')
    const ids = (await s.query('SELECT id FROM tags')).rows.map((r) => String(r.id))
    expect(ids, '所有者 COMMIT 报成功但写入被静默丢弃 —— 正是本用例要挡的形态').toEqual(['9'])
    await s.close()
  })

  it('delete 的 count 在 await 期间被事务截胡 → SELECT 必须在派发点被拒，不得污掉所有者的事务（CodeRabbit PR#81 第十六轮 major）', async () => {
    // 事故路径（实测复现，与上一条是同一缺口的另一半）：上一条是 delete **入口**时事务已开；
    // 这一条是 delete 已过入口审查、卡在 count 的 await 里，事务随后开起来。归属若只在方法
    // 入口判，这条 count 的 SELECT 就会落进别人的事务执行 —— 而目标表只要一执行就报错
    // （实测：`CAST(v AS INTEGER)` 的 view 做 count），DuckDB 就把那条事务标成 aborted：
    // 所有者的 COMMIT 返回**成功**，写入却被静默丢弃（实测 tags 行数归零、无任何报错）。
    // 判据：count 这条语句本身必须在**派发点**（execSql 闸门）被拒 —— 它连发都不发，
    // 就不能在别人的事务里执行期报错；所有者的写入必须在提交后真实存在。
    const s = await fresh()
    const sAny = s as unknown as { execSql: (q: string, p?: unknown[]) => Promise<unknown> }
    await sAny.execSql('CREATE TABLE aux (v VARCHAR)')
    await sAny.execSql(`INSERT INTO aux VALUES ('not-an-int')`)
    await sAny.execSql('DROP TABLE "robot_summary"')
    await sAny.execSql('CREATE VIEW "robot_summary" AS SELECT v FROM aux WHERE CAST(v AS INTEGER) > 0')
    // 把 count 挂住：delete 已过入口审查、事务尚未开始 —— 正是修复前那道缺口。
    const origCount = s.count.bind(s)
    let enteredCount!: () => void
    const inCount = new Promise<void>((r) => { enteredCount = r })
    let releaseCount!: () => void
    const countGate = new Promise<void>((r) => { releaseCount = r })
    ;(s as unknown as { count: (t: string) => Promise<number> }).count = async (t: string) => {
      enteredCount()
      await countGate
      return origCount(t)
    }
    const delP = s.delete('robot_summary', 'TRUE').then(() => null, (e: unknown) => e)
    await inCount
    // 事务在 count 的 await 期间开起来，并挂住直到 count 的结论落定
    let txReady!: () => void
    const txStarted = new Promise<void>((r) => { txReady = r })
    let releaseTx!: () => void
    const txHold = new Promise<void>((r) => { releaseTx = r })
    const txP = s.transaction(async (tx) => {
      await tx.upsert('tags', [{ id: '9', name: 'owner', color: '#FFF' }])
      txReady()
      await txHold
    }).then(() => 'committed', (e: unknown) => `rejected: ${(e as Error).message}`)
    await txStarted
    releaseCount()                        // count 恢复执行 —— 修复前它的 SELECT 会落进所有者的事务
    const delErr = await delP
    expect(delErr, 'count 的 SELECT 必须在派发点被拒（kind:internal）—— 让它落进所有者的事务里执行，'
      + '一次 Conversion Error 就把那条事务标成 aborted').toMatchObject({ kind: 'internal' })
    releaseTx()
    expect(await txP, '所有者的事务必须正常提交').toBe('committed')
    const ids = (await s.query('SELECT id FROM tags')).rows.map((r) => String(r.id))
    expect(ids, '所有者 COMMIT 报成功但写入被静默丢弃 —— 正是本用例要挡的形态').toEqual(['9'])
    await s.close()
  })

  it('自动事务进行中，另一条链的显式 transaction() 在入口就被拒（不得发出 BEGIN）', async () => {
    // ⚠️ 「不得发出 BEGIN」必须在**闭包层**观察（CodeRabbit PR#81 第十八轮疑问，探针证实）：
    // `transaction()` 的 BEGIN 与自动事务的 BEGIN 都走闭包 `execSql`，实例属性上的 spy 看不到。
    // 实测（去掉入口守卫、spy 记全部语句）`sqls` 仍是 `['INSERT']` —— 原来的
    // `toEqual(['INSERT'])` 恒真，什么也没证明。这里包装原生连接，记下每一条真正发出的语句。
    const sqls: string[] = []
    const realImporter = async (): Promise<unknown> => {
      const m = await import('@duckdb/node-api')
      const origCreate = (m as { DuckDBInstance: { create: (p: string, o?: unknown) => Promise<unknown> } })
        .DuckDBInstance.create
      const wrapConn = (c: unknown): unknown => {
        const cc = c as {
          runAndReadAll: (q: string, p?: unknown[]) => Promise<unknown>
          closeSync?: () => void
        }
        // ⚠️ 包装对象**替身整个实例**：`Store.close()` 调的是 `conn.closeSync()` / `inst.closeSync()`，
        // 它们挂在**原型**上、对象展开 / 手写字面量都复制不到。必须把两层的 `closeSync` 都转发给原生
        // 对象，否则 `Store.close()` 静默关不到真连接（Codex PR#81 第三十轮 P2：去掉了转发的版本里，
        // `close()` 之后连接仍能执行 `SELECT 42`）—— 用例结束漏关连接，Windows 上还会挡住删库目录。
        return {
          runAndReadAll: (q: string, p?: unknown[]) => {
            sqls.push(q === 'BEGIN' || q === 'COMMIT' || q === 'ROLLBACK' ? q : q.trim().split(/\s+/)[0]!.toUpperCase())
            return cc.runAndReadAll(q, p)
          },
          closeSync: () => cc.closeSync?.(),
        }
      }
      return {
        DuckDBInstance: {
          create: async (p: string, o?: unknown) => {
            const inst = await origCreate(p, o) as { connect: () => Promise<unknown>; closeSync?: () => void }
            return { connect: async () => wrapConn(await inst.connect()), closeSync: () => inst.closeSync?.() }
          },
        },
      }
    }
    // ⚠️ 包装版 Store 关不掉原生连接（见 `wrapConn` 的注释）—— 用例收尾时要直接关掉**裸 Store**：
    // 它先 open + init 建出库文件（建表语句会进 `sqls`，之后清空），包装版随后接同一路径。
    const raw = await createDuckDbStore(cfg, 'rw')
    await raw.init()
    const s = await createDuckDbStore(cfg, 'rw', { importer: realImporter as never })
    await s.init()
    sqls.length = 0                           // 只关心事务窗口内发出的语句
    // 用一个大批次把自动事务**挂住**在 INSERT 之前（闸门里等信号）
    const orig = (s as unknown as { execSql: (a: string, b?: unknown[]) => Promise<unknown> }).execSql
    let releaseInsert!: () => void
    const insertGate = new Promise<void>((r) => { releaseInsert = r })
    let enteredInsert!: () => void
    const inInsert = new Promise<void>((r) => { enteredInsert = r })
    ;(s as unknown as { execSql: (a: string, b?: unknown[]) => Promise<unknown> }).execSql =
      async (sql: string, p?: unknown[]) => {
        if (sql.startsWith('INSERT')) { enteredInsert(); await insertGate }
        return orig(sql, p)
      }
    const up = s.upsert('tags', [{ id: '1', name: 'A', color: '#FF0000' }])
    await inInsert                          // 自动事务已 BEGIN 并卡在 INSERT
    const txErr = await s.transaction(async () => { throw new Error('不该到这里') })
      .then(() => null, (e: unknown) => e)
    expect(txErr, '并发显式事务必须被拒成 internal（不是 usage 嵌套）').toMatchObject({ kind: 'internal' })
    // 此刻闭包层只应看到自动事务的那条 BEGIN（INSERT 还挂在闸门前）；被拒的显式事务
    // 一条都不发 —— 这条断言在闭包层，实例属性 spy 看不到 BEGIN（探针证实过）。
    expect(sqls, '被拒的显式事务不得发出 BEGIN（闭包层观察）').toEqual(['BEGIN'])
    releaseInsert()
    expect(await up).toBe(1)
    expect(sqls, '自动事务完整序列：BEGIN → INSERT → COMMIT').toEqual(['BEGIN', 'INSERT', 'COMMIT'])
    await s.close()
    await raw.close()
  })

  it('显式事务开着时，另一条链的 transaction() 报 internal（不是 usage 嵌套），读语句也不得落进去（CodeRabbit PR#81 第十七轮 minor）', async () => {
    // 事故路径（实测复现）：原先只有「自动事务被撞」区分成 internal，持有 `symbol` 令牌的
    // 显式事务被另一条链 `transaction()` 撞上时落到 `usage('不得嵌套事务')` —— 竞争方拿到
    // 退出码 2 的「参数写错」信号，且没有串行化提示。它不是嵌套（不在所有者上下文里）。
    // 另一半：闸门下移到 `execSql` 后读语句也过它，文案必须对读成立（原先说"写操作"）。
    const s = await fresh()
    let ready!: () => void
    const txReady = new Promise<void>((r) => { ready = r })
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    const tx = s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
      ready()
      await gate
    })
    await txReady
    const race = await s.transaction(async () => 'x').then(() => null, (e: unknown) => e)
    expect(race, '竞争方的显式事务必须报 internal（串行化），不能报成 usage 嵌套').toMatchObject({ kind: 'internal' })
    expect((race as { hint?: string }).hint, 'internal 必须带串行化提示').toMatch(/串行/)
    const read = await s.count('tags').then(() => null, (e: unknown) => e)
    expect(read, '竞争方的读同样必须被拒成 internal').toMatchObject({ kind: 'internal' })
    expect((read as Error).message, '文案必须对读成立 —— 不能只说"写操作"，否则只读调用方会被引到错误成因上')
      // ⚠️ 锚在**被改动的那句**（"又发起了 X"）上，不能只匹配 /读/：消息后半句本来就解释
      // 了读的后果，只匹配 /读/ 的话把首句改回"写操作"变异也照样绿（实测存活过一轮）。
      .toMatch(/又发起了语句/)
    expect((read as { hint?: string }).hint).toMatch(/query/)
    release()
    await tx
    // 所有者上下文里的真嵌套仍是 usage（这条不能跟着变成 internal）
    await expect(s.transaction(async (t) => {
      await (t as unknown as { transaction: (f: unknown) => Promise<unknown> }).transaction(async () => {})
    })).rejects.toMatchObject({ kind: 'usage' })
    await s.close()
  })

  it('tx 内嵌套 transaction() → usage', async () => {
    const s = await fresh()
    await expect(s.transaction(async (tx) => {
      await (tx as unknown as { transaction: (f: unknown) => Promise<unknown> }).transaction(async () => {})
    })).rejects.toThrow(/嵌套|usage/)
    await s.close()
  })

  it('事务外的另一条异步链 upsert → 拒绝，不得并入别人的事务（历史审查 PR#4 复核）', async () => {
    // 事故事实（Sourcery PR#4）：`inTx` 是**整个 Store 实例共享的布尔**，于是事务外的
    // 调用方会被当成「事务内」，直接被写进别人那条未提交的事务里 —— 对方一旦回滚，
    // 这一行的写入**静默消失**，而 upsert 还返回了成功行数。
    // 后果不是「报错」而是「成功却丢数据」：Agent 收到 1 行写入成功，库里却没有。
    // 实测形态（修前，本条红）：outside 分支 resolves，tx 回滚后 count === 0。
    const s = await fresh()
    let release!: () => void
    const gate = new Promise<void>((r) => { release = r })
    let ready!: () => void
    const txReady = new Promise<void>((r) => { ready = r })
    const tx = s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '1', name: 'A', color: '#FF0000' }])
      // ⚠️ 就绪信号必须由**事务内部**发出（CodeRabbit PR#81 major）：此前用
      // `s.query('SELECT 1')` 空转等「事务开起来了」，而那条查询恒有行 —— 循环立刻退出，
      // 外面的写可能在 BEGIN 之前就跑了，正确实现下这条用例反而会随机红。
      ready()
      await gate          // 事务挂在这里，等外面的第二次写先发生
      throw new Error('boom')
    })
    await txReady
    const outside = await s.upsert('tags', [{ id: '2', name: 'B', color: '#00FF00' }])
      .then(() => null, (e: unknown) => e)
    // 同一道判据必须覆盖**所有写原语**，不能只修被点名的那一个 `upsert`：
    // `delete` 走的是同一条「并入当前事务」的路径（修前：DELETE 落在别人的事务里，
    // 回滚后那条删除也一起消失，而返回值还说删了 0 行）。
    const outsideDel = await s.delete('tags', 'id = ?', ['1']).then(() => null, (e: unknown) => e)
    release()
    await tx.catch(() => {})
    expect(outside, '事务外的写必须被拒绝，不能静默并入别人的事务').not.toBeNull()
    expect(outside).toMatchObject({ kind: 'internal' })
    expect((outside as Error).message).toMatch(/事务/)
    expect(outsideDel, 'delete 同样不得被并入别人的事务').toMatchObject({ kind: 'internal' })
    // 拒绝之后库里必须干净：tx 回滚，且那一行从未被写入
    expect(await s.count('tags')).toBe(0)
    // 事务结束之后，普通 upsert 恢复正常（守卫不粘滞）
    await expect(s.upsert('tags', [{ id: '3', name: 'C', color: '#0000FF' }])).resolves.toBe(1)
    await s.close()
  })
})

describe('duckdb —— init 与关闭', () => {
  it('init 幂等：先写已知行，再 init → 行内容与行数不变', async () => {
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FF0000' }])
    await s.init()
    expect(await s.count('tags')).toBe(1)
    const r = await s.query('SELECT name FROM tags WHERE id = ?', ['1'])
    expect(r.rows[0].name).toBe('A')
    await s.close()
  })

  it('空结果集 columns 取真实列名（非空数组，v3.1 修）', async () => {
    const s = await fresh()
    const r = await s.query('SELECT id, name FROM tags WHERE id = ?', ['no-such-id'])
    expect(r.rows).toEqual([])
    expect(r.columns).toEqual(['id', 'name'])
    await s.close()
  })

  it('schema drift 对拍：真库 information_schema 反射列集 == TABLES 声明（防两处漂移）', async () => {
    const s = await fresh()
    for (const t of TABLES) {
      const r = await s.query(
        "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position",
        [t.name])
      expect(r.rows.map((x) => String(x.column_name)), `${t.name} 列序`).toEqual(t.columns.map((c) => c.name))
      for (const row of r.rows) {
        const cd = t.columns.find((c) => c.name === String(row.column_name))!
        expect(String(row.data_type), `${t.name}.${cd.name} 类型`).toBe(cd.type === 'INTEGER' ? 'INTEGER' : 'VARCHAR')
        expect(String(row.is_nullable), `${t.name}.${cd.name} 可空`).toBe(cd.nullable ? 'YES' : 'NO')
      }
    }
    await s.close()
  })

  it('迁移失败不推进版本、下次 init 重放（验收 19/20，真失败注入，I 组 M3）', async () => {
    // 用 vi.spyOn(MIGRATIONS, 'get') 注入「v2 会失败」的迁移清单（schema.ts 以 const
    // 导出数组，duckdb.ts 以 import 引用——spy getter 可替换模块内读取）。
    // 第一段：v1 成功、v2 失败 → schema_version 仍 1；第二段恢复后 init → 只重放 v2。
    const schema = await import('../../src/store/schema.js')
    const real = schema.MIGRATIONS
    const failingSpy = vi.spyOn(schema, 'MIGRATIONS', 'get')
      // ⚠️ D-T6 起真实清单已有 v3（维度表 DDL），注入失败条目改用 99（不撞号）。
      .mockReturnValue([...real, { version: 99, up: async () => { throw new Error('注入的迁移失败') } }] as never)
    const s1 = await createDuckDbStore(cfg, 'rw')
    await expect(s1.init()).rejects.toThrow('注入的迁移失败')
    expect(await s1.count('schema_version')).toBe(10)  // v1..v10 已记、99 未记（失败不推进）
    await s1.close()
    // 恢复真实迁移，重新 init → 重放路径只补 99（真实清单无 99，MAX 保持 8）
    failingSpy.mockRestore()
    // ⚠️ J-M1 实测裁决（controller 以 vitest 2.1.9 真跑探测）：对本地 ESM 模块命名空间
    // 的具名导出做 `vi.spyOn(mod, 'MIGRATIONS', 'get')` **可用**——vitest 的模块转换
    // 把具名导出变成可 redefine 的 getter，且**静态具名绑定（duckdb.ts 的
    // `import { MIGRATIONS }`）在 spy 后读到的也是替换值**（消费方实测看到 [9]）。
    // 注意：`afterEach` 里不要依赖 restore——本用例结束前必须显式 mockRestore，
    // 否则后续用例拿到的是被替换的 MIGRATIONS。
    const s2 = await createDuckDbStore(cfg, 'rw')
    await s2.init()
    const v = await s2.query('SELECT COALESCE(MAX(version),0) AS v FROM schema_version')
    // v1..v10（v9=G2 区间两列；v10=sync_gaps 主键补 reason）：MAX=10
    expect(Number(v.rows[0].v)).toBe(10)
    await s2.close()
  })

  it('ro 上 init() → usage 错误', async () => {
    const s = await fresh()
    await s.close()
    const ro = await createDuckDbStore(cfg, 'ro')
    await expect(ro.init()).rejects.toThrow(/只读|usage|rw/)
    await ro.close()
  })

  it('close 后跨进程可立即重开（N1 钉死：close 必须真释放锁）', async () => {
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    await s.close()
    // 全新 node 子进程以 rw 打开同一路径：若 close 未释放锁（只关 instance 不关
    // connection），子进程必报 Conflicting lock —— spawn 数组形态不经 shell（R3）。
    const { spawn } = await import('node:child_process')
    const pkgUrl = new URL('../../node_modules/@duckdb/node-api/lib/index.js', import.meta.url)
    const child = spawn(process.execPath, ['-e', `
      import(${JSON.stringify(pkgUrl.href)}).then(async ({ DuckDBInstance }) => {
        const inst = await DuckDBInstance.create(${JSON.stringify(cfg.path)})
        const conn = await inst.connect()
        await conn.runAndReadAll('SELECT COUNT(*) FROM tags')
        console.log('reopened')
        conn.closeSync()
        inst.closeSync()
        process.exit(0)
      }).catch((e) => { console.error(e.message); process.exit(1) })`], { stdio: ['ignore', 'pipe', 'pipe'] })
    let out = ''
    child.stdout?.on('data', (d) => { out += String(d) })
    child.stderr?.on('data', (d) => { out += String(d) })
    const code: number = await new Promise((resolve) => { child.on('exit', (c) => resolve(c ?? -1)) })
    expect(code).toBe(0)
    expect(out).toContain('reopened')
    expect(out).not.toContain('Conflicting lock')
  })

  it('close 后调用 → usage 错误（不裸崩）', async () => {
    const s = await fresh()
    await s.close()
    await expect(s.count('tags')).rejects.toThrow()
  })

  it('他人库防线：有业务表但无 schema_version → 拒绝（kind 断言，验收 37）', async () => {
    // ⚠️ 第四轮实测（1.5.6-r.1，macOS，node 24）：**同进程多实例双开不撞锁**
    // （rw+rw/rw+ro 均成功）——spec §5.5 的「同进程互相看不到写入」与锁无关，
    // 本用例串行建 alien 再打开即可，无锁风险。
    // ⚠️ 真实 API：instance 关闭是 **closeSync()**（同步方法，非 close()——
    // 可选链 `close?.()` 会静默跳过导致连接泄漏）；result 取行用 **runAndReadAll()**
    // （`run()` 返回的 Result 没有 getRowObjectsJson）。
    const mod = (await import('@duckdb/node-api')) as unknown as { DuckDBInstance: { create: (p: string, o?: unknown) => Promise<{ connect: () => Promise<{ run: (sql: string, params?: unknown[]) => Promise<unknown> }>; closeSync: () => void }> } }
    const inst = await mod.DuckDBInstance.create(cfg.path)
    const conn = await inst.connect()
    await conn.run('CREATE TABLE alien (a INTEGER)')
    inst.closeSync()
    const s = await createDuckDbStore(cfg, 'rw')
    await expect(s.init()).rejects.toMatchObject({
      kind: 'store_not_initialized',
      message: expect.stringMatching(/不是本 CLI 创建|alien/),
      hint: expect.stringMatching(/请换 --db 路径/),
    })
    await s.close()
  })

  it('读者撞锁：退避超限 → 包装 store_locked + hint（验收 35，注入假时钟；跨进程持真锁 + 按轮换全新路径重试 ≤5 轮）', { timeout: 120_000 }, async () => {
    // ⚠️ 超时预算（120s 而不是默认 60s）：最坏路径是 5 轮 × (持锁者启动 5s + 落盘校验
    // 10s) = 75s，已经**超过** 60s —— 高负载下（如 CI runner 或本机多任务）这条路一走到
    // 第 2 轮就会先被用例超时杀掉，伪装成「锁竞态超预期」的假失败（2026-10-24 实测
    // 一次无法复现的全量红）。120s = 最坏路径 75s × 2 余量，正常路径 20s 左右不受影响。
    //
    // 回移 T7 方案（同文件写者用例同款，M3 修间歇红）：@duckdb/node-api 有
    // **进程内单例缓存** —— 测试进程打开过的库路径再开一律命中缓存、绕过文件锁，
    // 同进程 seed 再撞锁是间歇红根因。改为：
    // ① 持锁者直接对**全新路径**持锁（DuckDBInstance.create 会建文件，无需 seed）；
    // ② 打印 'locked' 时锁可能尚未落盘 —— 用独立子进程校验 CONFLICT；
    // ③ 极少数情况下校验 CONFLICT 后读者仍能打开（锁落盘竞态窗口）——每轮换
    //    全新路径重试，最多 5 轮。锁生效是平台保证，重试只对冲竞态窗口。
    // 被测语义不变（验收 35）：kind=store_locked、retryable=true、假时钟退避超限。
    const { spawn } = await import('node:child_process')
    const pkgUrl = new URL('../../node_modules/@duckdb/node-api/lib/index.js', import.meta.url)
    const spawnHolder = async (dbPath: string) => {
      const child = spawn(process.execPath, ['-e', `
        import(${JSON.stringify(pkgUrl.href)}).then(async ({ DuckDBInstance }) => {
          const inst = await DuckDBInstance.create(${JSON.stringify(dbPath)})
          console.log('locked')
          setInterval(() => {}, 1 << 30)
          await new Promise(() => {})
        })`], { stdio: ['ignore', 'pipe', 'pipe'] })
      let o = ''
      child.stdout?.on('data', (d) => { o += String(d) })
      const ok = await new Promise<boolean>((resolve) => {
        const iv = setInterval(() => { if (o.includes('locked')) { clearInterval(iv); resolve(true) } }, 100)
        setTimeout(() => { clearInterval(iv); resolve(false) }, 5000)
      })
      if (!ok) { child.kill('SIGKILL'); throw new Error(`锁持有者未能启动：${o.slice(0, 200)}`) }
      return child
    }
    // 独立子进程校验锁已真正落盘（绕开本进程实例缓存）：
    const lockVerdict = async (dbPath: string): Promise<string> => {
      const chk = spawn(process.execPath, ['-e', `
        import(${JSON.stringify(pkgUrl.href)}).then(({ DuckDBInstance }) =>
          DuckDBInstance.create(${JSON.stringify(dbPath)}))
          .then(() => console.log('OPENED'))
          .catch(() => console.log('CONFLICT'))`], { stdio: ['ignore', 'pipe', 'pipe'] })
      let co = ''
      chk.stdout?.on('data', (d) => { co += String(d) })
      return await new Promise<string>((resolve) => {
        chk.on('close', () => resolve(co.includes('CONFLICT') ? 'CONFLICT' : 'OPENED'))
        setTimeout(() => { chk.kill('SIGKILL'); resolve('TIMEOUT') }, 10000)
      })
    }
    let holder: import('node:child_process').ChildProcess | undefined
    try {
      let asserted = false
      for (let round = 0; round < 5 && !asserted; round++) {
        const p = join(dir, `r-${round}.db`)   // 每轮换全新路径（避开本进程实例缓存）
        if (holder) holder.kill('SIGKILL')
        holder = await spawnHolder(p)
        if (await lockVerdict(p) !== 'CONFLICT') continue   // 锁未落盘，换轮
        let t = 0
        // ⚠️ 2026-10-31（B6-3）：这里**不能用** `expect(...).rejects` 包在 `catch { continue }` 里 ——
        // 那样「撞锁成功但断言写错」（kind 变了、hint 改了、假时钟没走）与「锁落盘竞态」
        // 会落进同一个 catch，最终只报「5 轮内未取得…锁落盘竞态超预期」：**归因是错的**，
        // 真正红的是断言，却被说成平台竞态。改为显式分类：开成功 = 竞态（换轮），
        // 抛 store_locked = 断言（错了就直接红），抛别的 = 被测代码 bug（也直接红）。
        let opened = false
        try {
          await createDuckDbStore({ ...cfg, path: p, readOnlyRetryMs: 1000 }, 'ro', {
            sleep: async (ms) => { t += ms }, now: () => t,
          })
          opened = true
        } catch (e) {
          const err = e as { kind?: string }
          if (err.kind !== 'store_locked') throw e   // 不是竞态也不是预期形态 —— 直接失败
          expect(err).toMatchObject({
            kind: 'store_locked',
            retryable: true,
            // hint 逐字（P 组 P-M2 改：前半句复述 message 已删，给第二动作）
            // 2026-10-26 改：键路径补全为 `profiles.<name>.store.readOnlyRetryMs` —— 裸键名
            // 按字面写进顶层/profile 级都会撞「配置文件未知键」，照 hint 做反而更糟。
            hint: '请稍后重试；等待上限可经配置文件 profiles.<name>.store.readOnlyRetryMs（默认 30000 毫秒）调整，或用 --db 指向其他数据库文件',
            message: expect.stringMatching(/被写进程占用/),
          })
          expect(t).toBeGreaterThan(0)   // 读者确实走了退避（与写者「不退避」分形）
          asserted = true
        }
        if (opened) continue   // 锁落盘竞态窗口（CONFLICT 后仍打开），换轮重来
      }
      expect(asserted, '5 轮内未取得「锁生效且读者撞锁」——锁落盘竞态超预期').toBe(true)
    } finally {
      holder?.kill('SIGKILL')
    }
  })

  it('写者撞锁：不重试、立即抛 store_locked（注入 sleep 证明未调用；跨进程持真锁 + 按轮换全新路径重试 ≤5 轮）', { timeout: 120_000 }, async () => {
    // ⚠️ 回移 T7 方案（tests/commands/store.test.ts 同款）：@duckdb/node-api 有
    // **进程内单例缓存** —— 测试进程打开过的库路径再开一律命中缓存、绕过文件锁，
    // 同进程 seed 再撞锁是间歇红根因。改为：
    // ① 持锁者直接对**全新路径**持锁（DuckDBInstance.create 会建文件，无需 seed）；
    // ② 打印 'locked' 时锁可能尚未落盘 —— 用独立子进程校验 CONFLICT；
    // ③ 极少数情况下校验 CONFLICT 后写者仍能打开（锁落盘竞态窗口）——每轮换
    //    全新路径重试，最多 5 轮。锁生效是平台保证，重试只对冲竞态窗口。
    // 被测语义不变：kind=store_locked、retryable=true、写者不退避（sleep 未调用）。
    const { spawn } = await import('node:child_process')
    const pkgUrl = new URL('../../node_modules/@duckdb/node-api/lib/index.js', import.meta.url)
    const spawnHolder = async (dbPath: string) => {
      const child = spawn(process.execPath, ['-e', `
        import(${JSON.stringify(pkgUrl.href)}).then(async ({ DuckDBInstance }) => {
          const inst = await DuckDBInstance.create(${JSON.stringify(dbPath)})
          console.log('locked')
          setInterval(() => {}, 1 << 30)
          await new Promise(() => {})
        })`], { stdio: ['ignore', 'pipe', 'pipe'] })
      let o = ''
      child.stdout?.on('data', (d) => { o += String(d) })
      const ok = await new Promise<boolean>((resolve) => {
        const iv = setInterval(() => { if (o.includes('locked')) { clearInterval(iv); resolve(true) } }, 100)
        setTimeout(() => { clearInterval(iv); resolve(false) }, 5000)
      })
      if (!ok) { child.kill('SIGKILL'); throw new Error(`锁持有者未能启动：${o.slice(0, 200)}`) }
      return child
    }
    // 独立子进程校验锁已真正落盘（绕开本进程实例缓存）：
    const lockVerdict = async (dbPath: string): Promise<string> => {
      const chk = spawn(process.execPath, ['-e', `
        import(${JSON.stringify(pkgUrl.href)}).then(({ DuckDBInstance }) =>
          DuckDBInstance.create(${JSON.stringify(dbPath)}))
          .then(() => console.log('OPENED'))
          .catch(() => console.log('CONFLICT'))`], { stdio: ['ignore', 'pipe', 'pipe'] })
      let co = ''
      chk.stdout?.on('data', (d) => { co += String(d) })
      return await new Promise<string>((resolve) => {
        chk.on('close', () => resolve(co.includes('CONFLICT') ? 'CONFLICT' : 'OPENED'))
        setTimeout(() => { chk.kill('SIGKILL'); resolve('TIMEOUT') }, 10000)
      })
    }
    let holder: import('node:child_process').ChildProcess | undefined
    try {
      let asserted = false
      for (let round = 0; round < 5 && !asserted; round++) {
        const p = join(dir, `w-${round}.db`)   // 每轮换全新路径（避开本进程实例缓存）
        if (holder) holder.kill('SIGKILL')
        holder = await spawnHolder(p)
        if (await lockVerdict(p) !== 'CONFLICT') continue   // 锁未落盘，换轮
        const sleep = vi.fn(async () => {})
        // ⚠️ 2026-10-31（B6-3）：同上，不用 `rejects.toMatchObject` + 空 catch 的组合 ——
        // 断言失败与锁竞态会落进同一个 catch，红的时候归因指向平台竞态而非真错的断言。
        let opened = false
        try {
          await createDuckDbStore({ ...cfg, path: p }, 'rw', { sleep, now: () => 0 })
          opened = true
        } catch (e) {
          const err = e as { kind?: string }
          if (err.kind !== 'store_locked') throw e   // 不是竞态也不是预期形态 —— 直接失败
          expect(err).toMatchObject({
            kind: 'store_locked',
            retryable: true,
            hint: expect.stringMatching(/另一个进程正持有该数据库的锁/),
          })
          expect(sleep).not.toHaveBeenCalled()   // 写者不退避（spec §5.2）
          asserted = true
        }
        if (opened) continue   // 锁落盘竞态窗口（CONFLICT 后仍打开），换轮重来
      }
      expect(asserted, '5 轮内未取得「锁生效且写者撞锁」——锁落盘竞态超预期').toBe(true)
    } finally {
      holder?.kill('SIGKILL')
    }
  })

  it('只读持有者同样挡住写者 —— 报错不得把持有者说成「写进程」', { timeout: 180_000 }, async () => {
    // 2026-11-05 审查实测：DuckDB 是「写者独占 / 读者共享」—— 一个以 READ_ONLY 打开的
    // 进程同样会让写者拿到 `Conflicting lock`。旧文案「数据库被写进程占用 / 另一个进程
    // 持有数据库写锁」把只读持有者说成写者，Agent 会去等一个并不存在的同步任务。
    //
    // ⚠️ 与同文件另外两条撞锁用例同款的三段式，缺一段就会间歇红：
    // ① 每轮换全新路径（@duckdb/node-api 进程内实例缓存会绕过文件锁）；
    // ② 持有者打印 ready 后，用独立子进程校验 CONFLICT（锁可能尚未落盘）；
    // ③ 极少数情况下校验通过后写者仍能打开（锁落盘竞态窗口）→ 换轮重来。
    const { spawn } = await import('node:child_process')
    const { writeFileSync } = await import('node:fs')
    const pkgUrl = new URL('../../node_modules/@duckdb/node-api/lib/index.js', import.meta.url)
    // 只读实例要求文件已存在 → 先由**子进程**建一个合法的空 DuckDB 文件
    // （种子放本进程会命中实例缓存，后续持有者/写者都绕开文件锁）。
    const seed = async (dbPath: string, round: number) => {
      const seedScript = join(dir, `ro-seed-${round}.mjs`)
      writeFileSync(seedScript, `
        const { DuckDBInstance } = await import(${JSON.stringify(pkgUrl.href)})
        const inst = await DuckDBInstance.create(${JSON.stringify(dbPath)})
        inst.closeSync()
      `)
      await new Promise<void>((resolve, reject) => {
        const ch = spawn(process.execPath, [seedScript], { stdio: ['ignore', 'ignore', 'pipe'] })
        let e = ''
        ch.stderr?.on('data', (d) => { e += String(d) })
        ch.on('close', (code) => { code === 0 ? resolve() : reject(new Error(`种子失败：${e.slice(0, 300)}`)) })
      })
    }
    // ⚠️ 子进程用**脚本文件**而非 `-e`：`-e` 里的动态 import 在部分 shell 引号组合下会
    // 被截断（锁持有者静默不启动，用例只会红成「持有者未能启动」）。
    const spawnRoHolder = async (dbPath: string, round: number) => {
      const script = join(dir, `ro-holder-${round}.mjs`)
      writeFileSync(script, `
        const { DuckDBInstance } = await import(${JSON.stringify(pkgUrl.href)})
        const inst = await DuckDBInstance.create(${JSON.stringify(dbPath)}, { access_mode: 'READ_ONLY' })
        const c = await inst.connect()
        await c.run('SELECT 1')
        console.log('ready')
        setInterval(() => {}, 1 << 30)
      `)
      const child = spawn(process.execPath, [script], { stdio: ['ignore', 'pipe', 'pipe'] })
      let o = ''
      child.stdout?.on('data', (d) => { o += String(d) })
      const ok = await new Promise<boolean>((resolve) => {
        const iv = setInterval(() => { if (o.includes('ready')) { clearInterval(iv); resolve(true) } }, 100)
        setTimeout(() => { clearInterval(iv); resolve(false) }, 30_000)
      })
      if (!ok) { child.kill('SIGKILL'); throw new Error(`只读持有者未能启动：${o.slice(0, 200)}`) }
      return child
    }
    // 独立子进程校验锁已真正落盘（写者视角：能被打开 = 锁未生效）。
    const lockVerdict = async (dbPath: string): Promise<string> => {
      const chk = spawn(process.execPath, ['-e', `
        import(${JSON.stringify(pkgUrl.href)}).then(({ DuckDBInstance }) =>
          DuckDBInstance.create(${JSON.stringify(dbPath)}))
          .then(() => console.log('OPENED'))
          .catch(() => console.log('CONFLICT'))`], { stdio: ['ignore', 'pipe', 'pipe'] })
      let co = ''
      chk.stdout?.on('data', (d) => { co += String(d) })
      return await new Promise<string>((resolve) => {
        chk.on('close', () => resolve(co.includes('CONFLICT') ? 'CONFLICT' : 'OPENED'))
        setTimeout(() => { chk.kill('SIGKILL'); resolve('TIMEOUT') }, 10000)
      })
    }
    let holder: import('node:child_process').ChildProcess | undefined
    try {
      let asserted = false
      for (let round = 0; round < 5 && !asserted; round++) {
        const p = join(dir, `ro-lock-${round}.db`)
        if (holder) holder.kill('SIGKILL')
        await seed(p, round)
        holder = await spawnRoHolder(p, round)
        if (await lockVerdict(p) !== 'CONFLICT') continue   // 锁未落盘，换轮
        let opened = false
        try {
          await createDuckDbStore({ ...cfg, path: p }, 'rw', { sleep: async () => {} })
          opened = true
        } catch (e) {
          const err = e as { kind?: string; message?: string; hint?: string }
          if (err.kind !== 'store_locked') throw e   // 不是竞态也不是预期形态 —— 直接失败
          expect(err).toMatchObject({
            kind: 'store_locked',
            retryable: true,
            message: expect.stringMatching(/被其他进程占用/),
            hint: expect.stringMatching(/只读会话同样会挡住写者/),
          })
          // 归因必须正确：不能说成「被写进程占用」；提示里也不能出现「写锁」——
          // READ_ONLY 持有的是共享锁，说「写锁」等于把同一句的后半段（持有者可能是只读
          // 会话）自我否定，Agent 照样会去等一个并不存在的写进程（CodeRabbit 第十三轮 minor）
          expect(err.message).not.toMatch(/被写进程占用/)
          expect(err.hint).not.toMatch(/写锁/)
          asserted = true
        }
        if (opened) continue   // 锁落盘竞态窗口，换轮重来
      }
      expect(asserted, '5 轮内未取得「RO 持有者生效且写者撞锁」——锁落盘竞态超预期').toBe(true)
    } finally {
      holder?.kill('SIGKILL')
    }
  })

  // 2026-11-14（历史审查 PR#4 复核）：此前只要库里有个能读的 `schema_version.version`，
  // `init` 就把外来库当成自己的 —— 实测造 `{secret 表, schema_version(version INTEGER) 空表}`
  // 后 init 报 ok 并往里建 25 张表；同名异形表因 `IF NOT EXISTS` 被静默沿用，后续写入才炸。
  // ⚠️ 用例分开写：一个用例里串两条断言，第一条红了第二条根本没跑（变异时实测）。
  const rawDb = async (name: string, ...sql: string[]): Promise<string> => {
    const mod = (await import('@duckdb/node-api')) as unknown as {
      DuckDBInstance: { create: (x: string) => Promise<{ connect: () => Promise<{ run: (s: string) => Promise<unknown>; closeSync: () => void }>; closeSync: () => void }> }
    }
    const p = join(dir, name)
    const inst = await mod.DuckDBInstance.create(p)
    const conn = await inst.connect()
    for (const q of sql) await conn.run(q)
    conn.closeSync(); inst.closeSync()
    return p
  }

  /**
   * 开库、确信 init 被拒、**在 finally 里关掉**（CodeRabbit PR#74 第六轮）：拒绝路径不关连接，
   * 这条用例自己就成了下一个打开者的锁持有者 —— 用例间是否串味取决于跑哪个先。
   * 关闭放在 `finally` 里，和断言在哪一行无关：断言由调用方写（各自的成因文案不同）。
   */
  const initRejects = async (path: string): Promise<unknown> => {
    const store = await createDuckDbStore({ ...cfg, path }, 'rw')
    try {
      return await store.init().then(() => { throw new Error('init 本应被拒绝，却成功了') })
    } finally {
      await store.close()
    }
  }

  it('他人库指纹 ①：schema_version 缺 version 列 → 拒绝（不回落到「版本 0 照常迁移」）', async () => {
    const p = await rawDb('a.db', 'CREATE TABLE schema_version (version_id INTEGER, applied_at VARCHAR)')
    // 报错必须点名 schema_version —— 否则「拒绝」可能来自别的原因，判据就成了碰巧绿。
    await expect(initRejects(p))
      .rejects.toMatchObject({ kind: 'store_not_initialized',
        message: expect.stringContaining('schema_version 缺少 version 列') })
  })

  it('他人库指纹 ②：有表但 schema_version 一条记录都没有 → 拒绝', async () => {
    const p = await rawDb('b.db',
      'CREATE TABLE schema_version (version INTEGER)',
      'CREATE TABLE secret (k VARCHAR)')
    await expect(initRejects(p))
      .rejects.toMatchObject({ kind: 'store_not_initialized',
        message: expect.stringContaining('schema_version 没有任何记录') })
  })

  it('他人库指纹 ③：记录的版本高于本 CLI 最新迁移 → 拒绝（不按陌生版本号「已是最新」）', async () => {
    const p = await rawDb('c.db',
      'CREATE TABLE schema_version (version INTEGER)',
      'INSERT INTO schema_version VALUES (999)')
    await expect(initRejects(p))
      .rejects.toMatchObject({ kind: 'store_not_initialized',
        message: expect.stringContaining('高于本 CLI 已知的最新迁移') })
  })

  // CodeRabbit PR#74 第五轮：`schema_version` **是 view** 时，init 里的
  // `SELECT COUNT(*), MAX(version)` 会把 view 本体执行一遍（`CAST('x' AS INTEGER)` 直接
  // 报 Conversion Error → internal），既绕开了「他人库」归类，也与 CHANGELOG 里
  // 「是 view 时连 MAX(version) 都不求值」的说法相矛盾。判据要在求值**之前**看对象类型。
  it('他人库指纹 ④：schema_version 是 view → 拒绝且不求值它（否则 view 体被当查询执行）', async () => {
    // 「一执行就炸」的 view（若被求值，报错会是 Conversion Error / internal）
    const p = await rawDb('d.db',
      'CREATE TABLE placeholder (x INTEGER)',
      'CREATE VIEW schema_version AS SELECT CAST(\'x\' AS INTEGER) AS version')
    await expect(initRejects(p))
      .rejects.toMatchObject({ kind: 'store_not_initialized',
        message: expect.stringContaining('schema_version 不是基表') })
  })

  it('他人库指纹 ④b：schema_version 是**大写** view（"SCHEMA_VERSION"）同样拒绝（Codex PR#76）', async () => {
    // DuckDB 按标识符解析（大小写不敏感）：小写的 `MAX(version) FROM schema_version` 会执行这条 view。
    const p = await rawDb('d2.db',
      'CREATE TABLE placeholder (x INTEGER)',
      'CREATE VIEW "SCHEMA_VERSION" AS SELECT CAST(\'x\' AS INTEGER) AS version')
    await expect(initRejects(p))
      .rejects.toMatchObject({ kind: 'store_not_initialized',
        message: expect.stringContaining('schema_version 不是基表') })
  })

  it('他人库指纹不误伤：声明表带声明外的列（既有 schema 漂移）照常可用，只由 db tables 警告', async () => {
    // ⚠️ 首版把这一档也拒了，全量回归当场抓到（`db tables` 的漂移用例给 sessions 加了
    // rogue_col）。多列/少列是既有契约里的漂移，不属于「他人库」。
    const s = await fresh()
    await s.query('ALTER TABLE "sessions" ADD COLUMN rogue_col VARCHAR')
    await s.close()
    // 已初始化的库再 init：不报他人库，照常成功
    const again = await createDuckDbStore(cfg, 'rw')
    await expect(again.init()).resolves.toBeUndefined()
    await again.close()
  })

  it('他人库指纹不误伤：零表的新库照常 init 成功', async () => {
    const s = await fresh()
    expect(await s.tables()).toContain('tags')
    await s.close()
  })

  it('执行期错误（约束违约）经 upsert 抛出 → 无 kind，命令层归 internal（验收 54）', async () => {
    const s = await fresh()
    // 绕过预检直接塞脏数据再读回，或以字面 SQL 注入类型不符值 —— 证明执行期
    // 错误原样抛出（无 kind），由命令层 thrownToExit 归 internal（退出码 1）。
    // ⚠️ 偏差修正：本版本（1.5.6-r.1）DuckDB 会把整数字面量隐式转 VARCHAR（brief 原句
    // "VALUES ('1','A',123)" 不抛错），改用显式 CAST 到 INTEGER 触发 Conversion Error。
    await expect(s.query("INSERT INTO tags (id, name, color) VALUES ('1', 'A', CAST('x' AS INTEGER))"))
      .rejects.toThrow(/Conversion|类型|bind/i)
    await s.close()
  })

  it('delete 按条件删行并返回行数（D: 报表按范围删除的基础）', async () => {
    const store = await fresh()
    await store.init()
    await store.upsert('tags', [
      { id: '1', name: '标签A', color: '#FF0000' },
      { id: '2', name: '标签B', color: '#00FF00' },
    ])
    const n = await store.delete('tags', 'id >= ?', ['2'])
    expect(n).toBe(1)
    expect(await store.count('tags')).toBe(1)
    await store.close()
  })

  // 2026-11-14（历史审查 PR#4 复核）：store 连接此前什么都没设，而实测 DuckDB 默认
  // `enable_external_access = true` —— 打开来源不明的库时，库里声明的 view 会以用户
  // 权限读本地文件/发网络请求。只有查询沙箱设过这一项，store 侧完全没有防线。
  it('store 连接封锁外部访问（enable_external_access=false），读外置文件必须失败', async () => {
    const s = await fresh()
    const now = await s.query("SELECT current_setting('enable_external_access') AS v")
    expect(String(now.rows[0]?.v), 'store 连接必须自证封锁，不能只靠 DuckDB 默认值').toBe('false')
    const csv = join(dir, 'probe.csv')
    writeFileSync(csv, 'x\n1\n')
    await expect(s.query(`SELECT * FROM read_csv_auto('${csv.replace(/'/g, "''")}')`))
      .rejects.toThrow(/external access|Permission|not allowed/i)
    await s.close()
  })

  // 2026-11-14（历史审查 PR#4 复核）：`schema_version` 的唯一列就是主键，`nonKey` 为空，
  // 此前拼出 `ON CONFLICT (...) DO UPDATE SET ` 的空子句 —— DuckDB 报 `Parser Error:
  // syntax error at end of input`，upsert 契约对这张表不成立（`assertTable` 是放行的）。
  it('只有主键列的表也能 upsert（DO NOTHING），且重复写不产生第二行', async () => {
    const s = await fresh()
    await s.init()
    const before = await s.count('schema_version')
    // ⚠️ 用一个**尚未记录**的版本号：`init()` 已经把迁移版本写进去了，拿 version 1
    // 当「新键」会先撞上已存在的行（本用例首版就是这么误判成 0 的）。
    await expect(s.upsert('schema_version', [{ version: 9000 }])).resolves.toBe(1)
    // 「实际写入行数」是契约原文（types.ts `Store.upsert`）：冲突被 DO NOTHING 跳过时
    // 一行都没写，就不能报 1（Codex PR#74 第二轮 P2）。
    await expect(s.upsert('schema_version', [{ version: 9000 }])).resolves.toBe(0)
    expect(await s.count('schema_version'), '冲突行不得被插成第二行').toBe(before + 1)
    await s.close()
  })

  it('只有主键列的表：一批里「已存在 + 新行」时只数真正插进去的那几行', async () => {
    const s = await fresh()
    await s.init()
    const existing = (await s.query('SELECT MAX(version) AS v FROM schema_version')).rows[0]!.v as number
    // 同批 3 行：1 行已存在，2 行新 —— 返回值必须是 2，不是 3
    await expect(s.upsert('schema_version', [
      { version: existing }, { version: 9001 }, { version: 9002 },
    ])).resolves.toBe(2)
    await s.close()
  })

  it('delete 未知表 → usage；在事务内则加入事务（回滚可撤）', async () => {
    const store = await fresh()
    await store.init()
    await expect(store.delete('nope', '1=1')).rejects.toMatchObject({ kind: 'usage' })
    await store.transaction(async (tx) => {
      await tx.upsert('tags', [{ id: '3', name: '标签C', color: '#0000FF' }])
      await tx.delete('tags', 'id = ?', ['3'])
    })
    expect(await store.count('tags')).toBe(0)
    await store.close()
  })
})
