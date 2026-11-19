import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import type { DuckDbDeps } from '../../src/store/duckdb.js'
import { TABLES } from '../../src/store/schema.js'
import type { Store, StoreConfig, QueryResult } from '../../src/store/types.js'
import { spawnLockHolder, lockVerdict, seedEmptyDb, LOCK_BUDGET_MS } from '../helpers/lock-holder.js'

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
/** 事务令牌的类型从依赖缝的签名里取（令牌类型不导出，测试不需要知道它的形状）。 */
type TxStore = Parameters<FakeAls['run']>[0]

describe('duckdb —— 事务', () => {
  it('关闭后调用 transaction()：发 usage，且不得重新启用事务上下文（Codex PR#81 第十八轮 P2）', async () => {
    // 事故路径（探针复现）：`close()` 里 `alsTx.disable()` 之后，迟到的 `transaction()` 会
    // 走到 `alsTx.run()` —— 它把实例**重新启用**（被 Node 全局 storageList 强引用），而这条
    // 失败路径不会再 disable，每次迟到调用都在攒一个启用态上下文。`upsert()` 本来就在
    // 入口先查 `closed`，`transaction()` 漏了。
    // 启用状态在 Node 上读不到，所以观察**重新启用的唯一途径**：`run()` 有没有被调用。
    let runs = 0
    const makeAls = (): FakeAls => {
      const real = new AsyncLocalStorage<TxStore>()
      return {
        run: <T>(token: TxStore, f: () => T): T => { runs++; return real.run(token, f) },
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
      const real = new AsyncLocalStorage<TxStore>()
      return {
        run: <T>(token: TxStore, f: () => T): T => { runs++; return real.run(token, f) },
        getStore: () => real.getStore(),
        disable: () => real.disable(),
      }
    }
    const s = await createDuckDbStore(cfg, 'rw', { makeAls })
    await s.init()
    // ⚠️ init 的每次迁移都走**托管事务**（CR 第三十八轮 major #1），所以基线不是 0 而是
    // 「迁移条数次」。判据改为**增量**：本次事务正常路径只应增加 1 次（BEGIN 那次），
    // 关闭后的回滚路径不得再进入上下文（否则增量是 2）。
    const before = runs
    expect(before, '前提：迁移确实走了托管事务（基线为迁移条数）').toBeGreaterThan(0)
    const tx = s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
      await s.close()                       // 事务进行中关库：后续语句必失败
    })
    const err = await tx.then(() => null, (e: unknown) => e)
    expect(err, '事务中的语句在关闭后报 usage').toMatchObject({ kind: 'usage' })
    expect(runs - before, '关闭后的回滚路径不得再进入上下文').toBe(1)
  })

  it('外部语句在途（尚未执行）→ 事务在 BEGIN 前被拒；语句落定后事务正常（CR 第三十八轮 major）', { timeout: 90_000 }, async () => {
    // 新不变量（CR 第三十八轮）：**BEGIN 只在连接上没有任何在途语句时发出**。原始 SQL 无法
    // 静态判定读写；它在 BEGIN 之后执行会落进本事务，在 ROLLBACK / COMMIT 之后执行则会在
    // autocommit 里落库，而调用方拿到的却是失败。旧实现允许事务插进来、靠跨代记号兜底 ——
    // 那条标记路径正是本用例替换掉的（现在按设计不可达，保留为内部不变量兜底）。
    const real = await import('@duckdb/node-api')
    const sqls: string[] = []
    let releaseExecute!: () => void
    let executeGate: Promise<void> | undefined
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  sqls.push(sql)
                  if (!holdNext || !sql.includes('bad_cast_q38')) return cc.runAndReadAll(sql, params)
                  holdNext = false
                  executeGate = new Promise<void>((r) => { releaseExecute = r })
                  await executeGate
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
    await orig.call(s, "CREATE VIEW bad_cast_q38 AS SELECT CAST('x' AS INT) AS v")
    sqls.length = 0
    holdNext = true
    const outside = s.query('SELECT * FROM bad_cast_q38').then(() => 'ok', (e: unknown) => e as Error)
    for (const deadline = Date.now() + 10_000; executeGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(executeGate, '前提：外部语句已通过下发检查、停在执行闸门上').toBeDefined()
    const txErr = await s.transaction(async () => { /* 不该进来 */ })
      .then(() => null, (e: unknown) => e as Error)
    expect(txErr, '语句在途时不得开启事务').toMatchObject({ kind: 'internal' })
    expect((txErr as Error).message, '成因要点名「还没交回结果」').toMatch(/还没有交回结果/)
    expect(sqls.filter((q) => q === 'BEGIN'), '一道 BEGIN 都不许发出').toEqual([])
    releaseExecute()
    const outsideErr = await outside
    expect(outsideErr, '语句自己的驱动错误必须原样交回（不是「跨代」的 internal）').not.toBeNull()
    expect((outsideErr as Error).message, '驱动原文透传（CAST 失败）').toMatch(/Conversion|CAST|类型/)
    // 语句落定（成功或失败都交回）之后，事务恢复正常
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }]) })
    expect(await s.count('tags')).toBe(2)
    await s.close()
  })

  it('外部语句已执行、结果未交回 → 同样不得开启事务；结果交回后事务正常（CR 第三十八轮 major）', { timeout: 90_000 }, async () => {
    // 与上一条互补：语句**已执行完**，只差结果交回。驱动在「执行完、结果返回」之间还有异步点，
    // 事务仍可能与它的落点交错，所以判据是「交回结果之前一律不开 BEGIN」。
    const real = await import('@duckdb/node-api')
    const sqls: string[] = []
    let releaseDeliver!: () => void
    let deliverGate: Promise<void> | undefined
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  sqls.push(sql)
                  if (!holdNext || !sql.includes('q38_ok')) return cc.runAndReadAll(sql, params)
                  holdNext = false
                  const outcome = cc.runAndReadAll(sql, params)
                  await outcome
                  deliverGate = new Promise<void>((r) => { releaseDeliver = r })
                  await deliverGate
                  return outcome
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
    sqls.length = 0
    holdNext = true
    const outside = s.query('SELECT 42 AS q38_ok').then((r) => ({ r }), (e: unknown) => ({ err: e as Error }))
    for (const deadline = Date.now() + 10_000; deliverGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(deliverGate, '前提：语句已执行完、结果被扣住').toBeDefined()
    const txErr = await s.transaction(async () => { /* 不该进来 */ })
      .then(() => null, (e: unknown) => e as Error)
    expect(txErr, '结果未交回时不得开启事务').toMatchObject({ kind: 'internal' })
    expect((txErr as Error).message).toMatch(/还没有交回结果/)
    expect(sqls.filter((q) => q === 'BEGIN'), '一道 BEGIN 都不许发出').toEqual([])
    releaseDeliver()
    const out = await outside
    expect(out, '语句自己的结果必须原样交回').toHaveProperty('r')
    expect((out as { r: QueryResult }).r.rows[0].q38_ok).toBe(42)
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }]) })
    expect(await s.count('tags')).toBe(2)
    await s.close()
  })

  it('已完成事务残留的异步上下文里下发的语句 → 在下发前就被拒，随后的事务不受影响（CR 第三十五/三十七轮 major）', { timeout: 90_000 }, async () => {
    // 事务 A 里排下的定时器**带着 A 的令牌**在 A 结束后才跑（AsyncLocalStorage 按异步资源传播）。
    // 旧实现把它当普通外部语句放行、靠 B 提交时拒绝来兜底（CR 第三十五轮）；CR 第三十七轮要求更硬：
    // 它所属的事务已经结束，结果与副作用都不可信 —— **一条语句都不许发到驱动**，更不能落进 B。
    const real = await import('@duckdb/node-api')
    const sqls: string[] = []
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  sqls.push(sql)
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
    await orig.call(s, "CREATE VIEW bad_cast_q35 AS SELECT CAST('x' AS INT) AS v")
    sqls.length = 0
    let dispatched!: () => void
    const dispatchedP = new Promise<void>((r) => { dispatched = r })
    let outside: Promise<unknown> | undefined
    await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '2', name: 'A2', color: '#FFF' }])
      setTimeout(() => {
        outside = s.query('SELECT * FROM bad_cast_q35').then(() => 'ok', (e: unknown) => e)
        dispatched()
      }, 30)
    })
    await dispatchedP
    const outsideErr = await outside
    expect(outsideErr, '残留上下文里下发的语句必须在下发前被拒').toMatchObject({ kind: 'internal' })
    expect((outsideErr as Error).message, '成因要点名「事务已经结束」').toMatch(/事务已经结束/)
    expect(sqls.filter((q) => q.includes('bad_cast_q35')), '这条语句一条都不许发到驱动').toEqual([])
    // 随后的事务不受影响：A 的残留上下文既不挡新事务，也不得把语句带进去
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '3', name: 'B', color: '#FFF' }]) })
    expect(await s.count('tags'), 'B 的写入正常提交；A 的两行保留').toBe(3)
    await s.close()
  })

  it('事务回调没有 await 写就返回 → 提交必须拒绝（CR 第三十六轮 major）', { timeout: 90_000 }, async () => {
    // 所有者自己的语句不登记 `foreignInFlight`（它归自己看得到）—— 但调用方若漏了 await，
    // 回调返回时这条语句还在驱动里，随后可能落进别人的事务并被提交。判据：提交前统计
    // **本令牌**在途语句（`txInFlight`），不为零就不提交。存储层只承诺 collide 会失败，
    // 不承诺把「没 await 的写」变成成功。
    const s = await createDuckDbStore(cfg, 'rw')
    await s.init()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    const err = await s.transaction(async (t) => {
      // 故意不 await；收尾期它的后续语句会被拒（令牌已退役），拒绝在这里接住
      void t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }]).catch(() => {})
    }).then(() => null, (e: unknown) => e)
    expect(err, '未 await 的写不得被当成已提交').not.toBeNull()
    // 成因要点名「本事务还有写操作没完成」，而不是笼统的「语句没交回结果」
    expect((err as Error).message, '成因要点名本事务未完成的写操作').toMatch(/写操作没有完成/)
    expect(await s.count('tags'), '该事务的写入不得残留').toBe(1)
    // 串行的正常用法不受影响
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '3', name: 'C', color: '#FFF' }]) })
    expect(await s.count('tags')).toBe(2)
    await s.close()
  })

  it('外部原始 SQL 写在途（尚未执行）→ 事务在 BEGIN 前被拒；释放后写的结果与行状态一致（CR 第三十八轮 major #5/#10）', { timeout: 90_000 }, async () => {
    // CR 第三十八轮的疑问：B 回滚时那条被扣在**原生执行之前**的 DELETE，释放后会不会在
    // autocommit 里删掉行、而调用方拿到 internal？新判据下它**没有**这个机会：写还在途时
    // B 根本不许开始。释放后 DELETE 自己正常返回，行确实被删 —— 结果与事实一致。
    const real = await import('@duckdb/node-api')
    const sqls: string[] = []
    let releaseExecute!: () => void
    let executeGate: Promise<void> | undefined
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  sqls.push(sql)
                  if (!holdNext || !sql.startsWith('DELETE FROM "tags"')) return cc.runAndReadAll(sql, params)
                  holdNext = false
                  executeGate = new Promise<void>((r) => { releaseExecute = r })
                  await executeGate
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
    sqls.length = 0
    holdNext = true
    const outside = s.query(`DELETE FROM "tags" WHERE id = '1'`)
      .then((r) => ({ ok: r }), (e: unknown) => ({ err: e as Error }))
    for (const deadline = Date.now() + 10_000; executeGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(executeGate, '前提：原始 SQL 写已下发、停在执行闸门上').toBeDefined()
    const txErr = await s.transaction(async () => { /* 不该进来 */ })
      .then(() => null, (e: unknown) => e as Error)
    expect(txErr, '写在途时不得开启事务').toMatchObject({ kind: 'internal' })
    expect((txErr as Error).message).toMatch(/还没有交回结果/)
    expect(sqls.filter((q) => q === 'BEGIN'), '一道 BEGIN 都不许发出').toEqual([])
    releaseExecute()
    const out = await outside
    expect(out, '写自己的结果必须成功交回（与事实一致）').not.toHaveProperty('err')
    expect(await s.count('tags'), '行确实被删（写已生效）').toBe(0)
    // 写落定之后事务恢复正常
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }]) })
    expect(await s.count('tags')).toBe(1)
    await s.close()
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

  it('delete 还在进行时，另一条链的事务不得开 BEGIN（判据前移到 BEGIN 准入）（CR 第三十七轮 major，改写自 PR#81 major）', async () => {
    // 旧缺口：`del` 先 count（await）再 DELETE。若只在入口/派发点判归属，别人正好在这段
    // await 里开事务，那条 DELETE 就被并进去、随对方回滚消失 —— 而返回值还说「删了 N 行」。
    // 上一代修法是让 DELETE 在派发点被拒；CR 第三十七轮指出**反过来**的问题：DELETE 的实际
    // 执行可能早于 BEGIN（autocommit 已提交）、结果晚于 BEGIN 才交回，调用方拿到「跨代失败」
    // 而**行却真的删了**，重试还会报「删了 0 行」。最终判据：写操作未完成时一道 BEGIN 都不发，
    // 写操作自己的结果保持准确（这里删了 1 行）。
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
    const delP = s.delete('tags', 'id = ?', ['1']).then((n) => ({ n }), (e: unknown) => e)
    await inCount                       // delete 已卡在 count 里
    // 此时尝试开事务：必须在 BEGIN 前被拒（`admitBegin`），写操作照常完成
    const tx = s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#00FF00' }])
    }).then(() => null, (e: unknown) => e as Error)
    const txErr = await tx
    expect(txErr, '写操作未完成时不得开启事务').toMatchObject({ kind: 'internal' })
    expect((txErr as Error).message, '成因要点名未完成的写操作').toMatch(/写操作/)
    releaseCount()                      // 让那条 DELETE 走到派发点
    expect(await delP, '写操作自己的结果必须准确（删了 1 行）').toEqual({ n: 1 })
    // 数据面证据：那一行确实被删（结果与事实一致），事务从未开始、它的写入不存在
    const after = (await s.query('SELECT id FROM tags ORDER BY id')).rows.map((r) => String(r.id))
    expect(after).toEqual([])
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

  it('原始事务控制一律拒绝；托管回调里发 COMMIT 被挡在派发前，回调抛错仍整体回滚（CR 第三十九轮 major #4）', async () => {
    // CR 第三十九轮的疑问：托管回调可以捕获 `store` 并发 `s.query('COMMIT')` —— 它通过归属检查，
    // 把回调里的写入提前提交；回调随后抛错也回滚不了（「报失败、数据却落库」）。
    // 判据：事务控制只能由 Store 自己发出；`query` / 原始 SQL 的 BEGIN / COMMIT / ROLLBACK
    // 一律在**派发前**拒绝（usage）。
    const s = await fresh()
    const sAny = s as unknown as { execSql: (q: string, p?: unknown[]) => Promise<unknown> }
    await expect(s.query('BEGIN')).rejects.toMatchObject({ kind: 'usage' })
    await expect(s.query('COMMIT')).rejects.toMatchObject({ kind: 'usage' })
    await expect(sAny.execSql('ROLLBACK')).rejects.toMatchObject({ kind: 'usage' })
    // 托管回调里的原始 COMMIT：拒绝发生在派发前，回调自己的错误照常整体回滚
    const err = await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '9', name: 'X', color: '#FFF' }])
      await expect(s.query('COMMIT')).rejects.toMatchObject({ kind: 'usage' })
      throw new Error('boom')
    }).then(() => null, (e: unknown) => e)
    expect(err, '回调自己的错误原样透传').toBeInstanceOf(Error)
    expect((err as Error).message).toBe('boom')
    expect(await s.count('tags'), '写入必须随回调失败整体回滚').toBe(0)
    // 托管事务本身照常可用
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '7', name: 'Y', color: '#222222' }]) })
    expect(await s.count('tags')).toBe(1)
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

  it('delete 的 count 在 await 期间，事务同样不得开启 —— count 的错误只属于 delete 自己（CR 第三十七轮 major，改写自 PR#81 第十六轮）', async () => {
    // 旧缺口：delete 已过入口审查、卡在 count 的 await 里，事务随后开起来 —— count 的 SELECT
    // 会落进别人的事务执行，一次 Conversion Error 就把那条事务标成 aborted，所有者的 COMMIT
    // 返回成功而写入被丢弃。上一代修法是让 SELECT 在派发点被拒；CR 第三十七轮把判据前移到
    // **BEGIN 准入**：写操作未完成时事务根本不许开始，count 的错误因此只属于 delete 自己。
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
    const delP = s.delete('robot_summary', 'TRUE').then(() => null, (e: unknown) => e as Error)
    await inCount
    const txP = s.transaction(async (tx) => {
      await tx.upsert('tags', [{ id: '9', name: 'owner', color: '#FFF' }])
    }).then(() => 'committed' as const, (e: unknown) => ({ rejected: e as Error }))
    const txOut = await txP
    expect(txOut, '写操作未完成时不得开启事务').toHaveProperty('rejected')
    expect((txOut as { rejected: Error }).rejected, '成因要点名未完成的写操作（internal）')
      .toMatchObject({ kind: 'internal' })
    expect((txOut as { rejected: Error }).rejected.message).toMatch(/写操作/)
    releaseCount()                        // count 恢复执行 —— 此时没有任何事务，错误只属于 delete
    const delErr = await delP
    expect(delErr, '这条 count 的 Conversion Error 是 delete 自己的失败（不是「跨代」的 internal）').not.toBeNull()
    expect((delErr as Error).message, '不得被归因成「另一条异步链开启了事务」')
      .not.toMatch(/另一条异步链开启事务/)
    expect((delErr as Error).message, '驱动原文必须透传').toMatch(/Conversion|CAST|类型/)
    const ids = (await s.query('SELECT id FROM tags')).rows.map((r) => String(r.id))
    expect(ids, '事务从未开始：它的一行不得存在').toEqual([])
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

  it('事务回调没有 await 的写被扣在驱动里 → 必须先等在途语句交回、再 ROLLBACK，写入不得落库（CR 第三十七轮 major）', { timeout: 90_000 }, async () => {
    // 事故路径（CR 第三十七轮 #1/#3）：回调 `void t.upsert(...)` 后立即返回，`doUpsert` 的
    // 首条 count 已下发、尚未交回。修前：`commitOrRefuse` 拒绝提交后**先**发 ROLLBACK，
    // 驱动里的 count 随后才执行完，`doUpsert` 继续把 INSERT 发到 ROLLBACK **之后** ——
    // 它在 autocommit 里真的落库，而事务报的却是「已整体回滚」。判据：INSERT 一条都不许发出。
    const real = await import('@duckdb/node-api')
    const events: string[] = []
    let releaseExecute!: () => void
    let executeGate: Promise<void> | undefined
    let releaseDeliver!: () => void
    let deliverGate: Promise<void> | undefined
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (sql === 'ROLLBACK' || sql === 'COMMIT') events.push(`${sql.toLowerCase()}-dispatched`)
                  if (!holdNext || !sql.startsWith('INSERT INTO "tags"')) return cc.runAndReadAll(sql, params)
                  events.push('insert-dispatched')
                  holdNext = false
                  executeGate = new Promise<void>((r) => { releaseExecute = r })
                  await executeGate
                  const outcome = cc.runAndReadAll(sql, params)
                    .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }))
                  const settled = await outcome
                  events.push('insert-executed')
                  deliverGate = new Promise<void>((r) => { releaseDeliver = r })
                  await deliverGate
                  events.push('insert-returned')
                  if (!settled.ok) throw settled.e
                  return settled.r
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
    events.length = 0 // 只观察事务期间真正发出的语句（建表与初始化不参与判定）
    holdNext = true
    let writeOutcome: unknown = 'pending'
    const tx = s.transaction(async (t) => {
      // 故意不 await：写的第一条语句已下发，回调随即返回
      void t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }]).then(
        () => { writeOutcome = 'resolved' }, (e: unknown) => { writeOutcome = e })
    }).then(() => null, (e: unknown) => e as Error)
    for (const deadline = Date.now() + 10_000; executeGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(executeGate, '前提：回调没 await 的写已把 INSERT 下发到驱动里').toBeDefined()
    await new Promise((r) => setTimeout(r, 50))
    expect(events, '在途语句交回之前不得发 ROLLBACK —— 否则它会在 autocommit 里执行')
      .not.toContain('rollback-dispatched')
    releaseExecute()
    for (const deadline = Date.now() + 10_000; deliverGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(deliverGate, '前提：INSERT 已执行完、结果被扣住').toBeDefined()
    releaseDeliver()
    const txErr = await tx
    expect(txErr, '未 await 的写不得被当成已提交').not.toBeNull()
    // 这条写跨了多个批次，提交判据必须按「本事务的写操作」计数，而不是看某一刻的在途语句
    expect((txErr as Error).message, '成因要点名本事务未完成的写操作').toMatch(/写操作没有完成/)
    expect(events, '那条写只允许出现一次（不得在回滚后补发）').toEqual(
      ['insert-dispatched', 'insert-executed', 'insert-returned', 'rollback-dispatched'])
    for (const deadline = Date.now() + 10_000; writeOutcome === 'pending' && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(writeOutcome, '结果在事务结束后才交回时不得当成成功').toMatchObject({ kind: 'internal' })
    expect((writeOutcome as Error).message, '成因要点名「事务已经结束」').toMatch(/事务已经结束/)
    expect(await s.count('tags'), '该事务的写入不得残留').toBe(1)
    await s.close()
  })

  it('事务回调以 undefined / 带 txRefusal 字段的伪造对象拒绝 → 原值透传、事务照样回滚（CR 第三十七轮 major）', async () => {
    // 修前：catch 里读 `(e as {...}).txRefusal` —— 拒绝值是 `undefined`/`null` 时读属性直接
    // TypeError（原错误被吞、`finally` 清掉归属却没结束事务）；别人也能在自己的错误对象上
    // 挂一个 `txRefusal: true` 让回滚被跳过。判据：拒绝值原样透传，且两种情形都必须回滚。
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    const undef = await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
      throw undefined
    }).then(() => 'resolved' as const, (e: unknown) => ({ rejected: true as const, value: e }))
    expect(undef, 'undefined 不能被替换成一个 TypeError').toEqual({ rejected: true, value: undefined })
    expect(await s.count('tags'), '抛出 undefined 时同样要回滚').toBe(1)
    const fake = { txRefusal: true }
    const out = await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '3', name: 'C', color: '#FFF' }])
      throw fake
    }).then(() => 'resolved' as const, (e: unknown) => e)
    expect(out, '原对象必须原样透传').toBe(fake)
    expect(await s.count('tags'), '无关对象上的 txRefusal 字段不得让回滚被跳过').toBe(1)
    // 回滚后连接仍然可用（守卫不粘滞）
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '4', name: 'D', color: '#FFF' }]) })
    expect(await s.count('tags')).toBe(2)
    await s.close()
  })

  it('事务回调里没有 await 的 tx.delete 被扣在 count 上 → 回滚后不得把它发成 autocommit 的 DELETE（CR 第三十七轮 major）', { timeout: 90_000 }, async () => {
    // 与上上条同源：`del` 的 count 已下发、回调返回；事务拒绝提交并回滚。修前 count 随后
    // 交回（没有跨代，epoch 判据放行），`del` 发现 Store 已空闲，就把 DELETE 在 autocommit
    // 里发出去 —— 行被删了，而事务报的是「已整体回滚」。判据：DELETE 一条都不许发出。
    const real = await import('@duckdb/node-api')
    const events: string[] = []
    let releaseExecute!: () => void
    let executeGate: Promise<void> | undefined
    let releaseDeliver!: () => void
    let deliverGate: Promise<void> | undefined
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (sql === 'ROLLBACK' || sql === 'COMMIT') events.push(`${sql.toLowerCase()}-dispatched`)
                  if (sql.startsWith('DELETE FROM "tags"')) events.push('delete-dispatched')
                  if (!holdNext || !sql.startsWith('SELECT COUNT(*) AS n FROM "tags"')) {
                    return cc.runAndReadAll(sql, params)
                  }
                  holdNext = false
                  executeGate = new Promise<void>((r) => { releaseExecute = r })
                  await executeGate
                  const outcome = cc.runAndReadAll(sql, params)
                    .then((r) => ({ ok: true as const, r }), (e: unknown) => ({ ok: false as const, e }))
                  await outcome
                  deliverGate = new Promise<void>((r) => { releaseDeliver = r })
                  await deliverGate
                  const settled = await outcome
                  events.push('count-returned')
                  if (!settled.ok) throw settled.e
                  return settled.r
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
    events.length = 0
    holdNext = true
    let delOutcome: unknown = 'pending'
    const tx = s.transaction(async (t) => {
      void t.delete('tags', "id = '1'").then(() => { delOutcome = 'resolved' }, (e: unknown) => { delOutcome = e })
    }).then(() => null, (e: unknown) => e as Error)
    for (const deadline = Date.now() + 10_000; executeGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(executeGate, '前提：没 await 的 delete 已把 count 下发到驱动里').toBeDefined()
    releaseExecute()
    for (const deadline = Date.now() + 10_000; deliverGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    releaseDeliver()
    const txErr = await tx
    for (const deadline = Date.now() + 10_000; delOutcome === 'pending' && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(txErr, '未 await 的删除不得被当成已随事务回滚').not.toBeNull()
    expect((txErr as Error).message, '成因要点名本事务未完成的写操作').toMatch(/写操作没有完成/)
    expect(delOutcome, '在已结束事务里恢复的 delete 必须被拒（internal），'
      + '不能把 DELETE 发到 autocommit 里').toMatchObject({ kind: 'internal' })
    expect(events, '回滚之后那条 DELETE 不得再发出').not.toContain('delete-dispatched')
    expect(await s.count('tags'), '行必须还在').toBe(1)
    await s.close()
  })

  it('事务内一条语句执行期报错（回调自己接住并正常返回）→ 提交必须拒绝（CR 第三十七轮 major）', async () => {
    // 修前：失败语句跑在**当前令牌**下，只有「跨代」才打 brokenTx 记号 —— 回调接住错误、
    // 正常返回后 `commitOrRefuse` 看到零在途，照常发 COMMIT；DuckDB 1.5.6 把已失效事务上的
    // COMMIT 转成 ROLLBACK 并**返回成功**，调用方拿到「提交成功」，写入却没了。
    // 判据：本事务内语句执行期报错 → 提交必须被拒并整体回滚。
    const s = await fresh()
    const sAny = s as unknown as { execSql: (q: string, p?: unknown[]) => Promise<unknown> }
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    await sAny.execSql("CREATE VIEW bad_cast_q37 AS SELECT CAST('x' AS INT) AS v")
    const txErr = await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
      await sAny.execSql('SELECT * FROM bad_cast_q37').catch(() => { /* 回调自己接住 */ })
    }).then(() => null, (e: unknown) => e as Error)
    expect(txErr, '语句已把事务标成 aborted，回调返回成功不能掩盖写丢失').not.toBeNull()
    expect((txErr as Error).message, '成因要点名未提交').toMatch(/事务未提交/)
    expect(await s.count('tags'), '该事务的写入不得残留').toBe(1)
    // 守卫不粘滞：随后的事务照常可用
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '3', name: 'C', color: '#FFF' }]) })
    expect(await s.count('tags')).toBe(2)
    await s.close()
  })

  it('ROLLBACK 未能确认（注入：在执行前就被拒绝）→ Store 必须退役、后续语句 internal，行状态一致（CR 第三十七轮 major #4）', { timeout: 90_000 }, async () => {
    // CR 的疑问：驱动能否在**转发 ROLLBACK 之前**就拒绝它、同时连接仍可用？若真如此，旧实现
    // 会清掉归属、让之后的语句落进那条还开着的事务。这里用导入缝**直接注入这种失败**，
    // 并钉住我们的答案：回滚无法确认 → 整个 Store 退役（任何后续语句 internal），
    // 连接在 close 时随进程/句柄一起结束，失败事务的写入不得落库。
    const real = await import('@duckdb/node-api')
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (sql === 'ROLLBACK') throw new Error('注入：ROLLBACK 在执行前被拒绝')
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
    const boom = new Error('boom')
    const txErr = await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
      throw boom
    }).then(() => null, (e: unknown) => e)
    expect(txErr, '原始错误必须原样透传').toBe(boom)
    const after = await s.count('tags').then(() => null, (e: unknown) => e as Error)
    expect(after, '回滚未能确认后任何后续语句都必须被拒（连接已退役）').toMatchObject({ kind: 'internal' })
    expect((after as Error).message).toMatch(/退役|无法确认/)
    await s.close()
    // 另一个连接看持久化结果：失败事务的写入不得落库
    const s2 = await createDuckDbStore(cfg, 'rw')
    expect(await s2.count('tags'), '失败事务的写入不得残留').toBe(1)
    await s2.close()
  })

  it('delete 还在执行（结果未交回）→ 显式事务与自动事务都必须在 BEGIN 前被拒（CR 第三十七轮 major #6）', { timeout: 90_000 }, async () => {
    // 修前：delete 先 count、再 DELETE，两步之间别人可以开事务；DELETE 的实际执行可能早于
    // BEGIN（autocommit 已提交），而调用方拿到的是「跨代」的 internal —— 报了失败、行却真的
    // 没了，重试还会报「删了 0 行」。判据：写操作未完成时**一道 BEGIN 都不许发出**，
    // 写操作的结果必须保持准确。
    const real = await import('@duckdb/node-api')
    const sqls: string[] = []
    let releaseExecute!: () => void
    let executeGate: Promise<void> | undefined
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  sqls.push(sql)
                  if (!holdNext || !sql.startsWith('DELETE FROM "tags"')) return cc.runAndReadAll(sql, params)
                  holdNext = false
                  executeGate = new Promise<void>((r) => { releaseExecute = r })
                  await executeGate
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
    sqls.length = 0
    holdNext = true
    const outside = s.delete('tags', "id = '1'").then((n) => ({ n }), (e: unknown) => ({ err: e as Error }))
    for (const deadline = Date.now() + 10_000; executeGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(executeGate, '前提：DELETE 已下发、停在执行闸门上').toBeDefined()
    const txErr = await s.transaction(async () => { /* 不该进来 */ })
      .then(() => null, (e: unknown) => e as Error)
    expect(txErr, '写操作未完成时不得开启事务').toMatchObject({ kind: 'internal' })
    // ⚠️ 判决文案来自更宽的「有语句在途」判据（CR 第三十八轮：原始 SQL 无法静态判定读写，
    // 任何在途语句都让 BEGIN 不安全）—— 成因只要点明「有东西还没交回结果」即可。
    expect((txErr as Error).message, '成因要点名返回结果之前的那条在途语句').toMatch(/还没有交回结果/)
    const upErr = await s.upsert('tags', [{ id: '9', name: 'X', color: '#FFF' }])
      .then(() => null, (e: unknown) => e as Error)
    expect(upErr, '自动事务同样不得在写操作未完成时发 BEGIN').toMatchObject({ kind: 'internal' })
    expect((upErr as Error).message).toMatch(/还没有交回结果/)
    expect(sqls.filter((q) => q === 'BEGIN'), '一道 BEGIN 都不许发出').toEqual([])
    releaseExecute()
    expect(await outside, '写操作自己的结果必须准确（删了 1 行），不能是「跨代」的失败').toEqual({ n: 1 })
    expect(await s.count('tags')).toBe(0)
    // 写操作落定之后事务恢复正常
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }]) })
    expect(await s.count('tags')).toBe(1)
    await s.close()
  })

  it('已结束事务的残留上下文不得再开启新事务（自动 upsert / transaction 都在换令牌前被拒）（CR 第三十八轮 major）', async () => {
    // CR 第三十八轮 #2：`upsert` 的自动事务与 `transaction()` 会在 `alsTx.run` 里把旧令牌替换成
    // 新令牌，替换之后 execSql 的退役检查读到的就是新令牌了 —— 残留续体（定时器）因此能开一条
    // 全新事务并提交，调用方却以为它的写入属于那条已回滚的事务。判据：入口就拒。
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    let lateUpsert: Promise<unknown> | undefined
    let lateTx: Promise<unknown> | undefined
    await s.transaction(async () => {
      setTimeout(() => {
        lateUpsert = s.upsert('tags', [{ id: '9', name: 'X', color: '#FFF' }]).then(() => 'ok', (e: unknown) => e as Error)
        lateTx = s.transaction(async () => { /* 不该进来 */ }).then(() => 'ok', (e: unknown) => e as Error)
      }, 30)
    })
    for (const deadline = Date.now() + 10_000; (lateUpsert === undefined || lateTx === undefined) && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const upOut = await lateUpsert
    expect(upOut, '残留上下文里的 upsert 不得开新自动事务').toMatchObject({ kind: 'internal' })
    expect((upOut as Error).message).toMatch(/事务已经结束/)
    const txOut = await lateTx
    expect(txOut, '残留上下文里的 transaction 同样不得开新事务').toMatchObject({ kind: 'internal' })
    expect((txOut as Error).message).toMatch(/事务已经结束/)
    expect(await s.count('tags'), '两次尝试都不得写入').toBe(1)
    await s.close()
  })

  it('init 的迁移走托管事务：迁移进行中另一条链的 transaction() 在入口被拒（CR 第三十八轮 major）', { timeout: 90_000 }, async () => {
    // CR 第三十八轮 #1：裸 `execSql('BEGIN')` 不登记归属 —— 迁移暂停时另一条链的 transaction()
    // 会再发一条 BEGIN（DuckDB 拒绝它并把迁移事务标成 aborted），随后它的失败处理回滚掉迁移事务，
    // init 恢复后就在事务外执行语句。托管事务把归属登记收敛到同一处。
    const real = await import('@duckdb/node-api')
    let releaseExecute!: () => void
    let executeGate: Promise<void> | undefined
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (!holdNext || !sql.includes('CREATE TABLE')) return cc.runAndReadAll(sql, params)
                  holdNext = false
                  executeGate = new Promise<void>((r) => { releaseExecute = r })
                  await executeGate
                  return cc.runAndReadAll(sql, params)
                },
              }
            },
          }
        },
      },
    })
    const s = await createDuckDbStore(cfg, 'rw', { importer })
    holdNext = true
    const initP = s.init()
    for (const deadline = Date.now() + 10_000; executeGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(executeGate, '前提：迁移的第一条 DDL 已下发、停在执行闸门上').toBeDefined()
    // 迁移事务此刻开着 —— 另一条链的 transaction() 必须在入口被拒（不得发 BEGIN）
    const txErr = await s.transaction(async () => { /* 不该进来 */ })
      .then(() => null, (e: unknown) => e as Error)
    expect(txErr, '迁移进行中不得再开事务（归属登记必须覆盖迁移）').toMatchObject({ kind: 'internal' })
    expect((txErr as Error).message).toMatch(/事务尚未提交/)
    releaseExecute()
    await initP
    // 迁移已完成，事务恢复正常
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }]) })
    expect(await s.count('tags')).toBe(1)
    await s.close()
  })

  it('A 的提交拒绝被在 B 的回调里原样抛出 → B 仍必须回滚（拒绝按令牌归属）（CR 第三十八轮 major）', { timeout: 90_000 }, async () => {
    // CR 第三十八轮 #3：只按错误对象的身份判断「回滚已由它负责」时，A 的拒绝对象被 B 原样抛出
    // 会让 B 跳过回滚 —— 而 A 的回滚与 B 无关，B 的 DuckDB 事务仍开着。
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    const refusal = await s.transaction(async (t) => {
      void t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }]).catch(() => {})
    }).then(() => null, (e: unknown) => e)
    expect(refusal, '前提：A 确实被拒绝').toMatchObject({ kind: 'internal' })
    const out = await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '3', name: 'C', color: '#FFF' }])
      throw refusal
    }).then(() => null, (e: unknown) => e)
    expect(out, '原对象必须原样透传').toBe(refusal)
    expect(await s.count('tags'), 'B 的写入必须被回滚').toBe(1)
    // B 的事务必须真的结束（若跳过回滚，这里会撞上「cannot start a transaction within a transaction」）
    await s.transaction(async (t) => { await t.upsert('tags', [{ id: '4', name: 'D', color: '#FFF' }]) })
    expect(await s.count('tags')).toBe(2)
    await s.close()
  })

  it('WriteTx 是回调作用域：把投影带出回调后调用必须被拒（CR 第三十八轮 major）', async () => {
    // CR 第三十八轮 #4：`const tx = await transaction(async (t) => t)` 返回后，投影的每个方法
    // 原先是 Store 别名 —— 在 autocommit 里写，调用方却以为它还在事务里。
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    const escaped = await s.transaction(async (t) => t)
    await expect(escaped.delete('tags', 'TRUE')).rejects.toMatchObject({ kind: 'internal' })
    await expect(escaped.upsert('tags', [{ id: '9', name: 'X', color: '#FFF' }])).rejects.toMatchObject({ kind: 'internal' })
    await expect(escaped.tables()).rejects.toMatchObject({ kind: 'internal' })
    await expect(escaped.transaction(async () => undefined)).rejects.toMatchObject({ kind: 'internal' })
    expect(await s.count('tags'), '带出回调的投影不得改动数据').toBe(1)
    await s.close()
  })

  it('事务内可恢复错误（Catalog/Binder）不影响提交；只有真的废掉事务的错误才拒绝（CR 第三十八轮 major）', async () => {
    // 直连驱动实测（2026-11-18）：Catalog Error / Binder Error **不**废事务（后续 INSERT 正常、
    // COMMIT 后写入落库）；Conversion Error 才把事务标成 aborted（后续语句报
    // `Current transaction is aborted`，COMMIT 返回成功却丢写）。判据用探针问连接，不按报文猜。
    const s = await fresh()
    const sAny = s as unknown as { execSql: (q: string, p?: unknown[]) => Promise<unknown> }
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    // ① Catalog Error：回调接住后正常返回 → 必须照常提交
    await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
      await sAny.execSql('SELECT * FROM no_such_table_q38').catch(() => { /* 回调自己接住 */ })
    })
    expect(await s.count('tags'), 'Catalog Error 不废事务，写入必须落库').toBe(2)
    // ② Binder Error：同样可恢复
    await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '3', name: 'C', color: '#FFF' }])
      await sAny.execSql('SELECT no_such_column_q38 FROM tags').catch(() => { /* 回调自己接住 */ })
    })
    expect(await s.count('tags'), 'Binder Error 不废事务，写入必须落库').toBe(3)
    // ③ Conversion Error：事务被废 → 必须拒绝提交并整体回滚（与上一条「事务内报错」互补）
    await sAny.execSql("CREATE VIEW bad_cast_q38b AS SELECT CAST('x' AS INT) AS v")
    const txErr = await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '4', name: 'D', color: '#FFF' }])
      await sAny.execSql('SELECT * FROM bad_cast_q38b').catch(() => { /* 回调自己接住 */ })
    }).then(() => null, (e: unknown) => e as Error)
    expect(txErr, 'Conversion Error 已废掉事务，提交必须被拒').not.toBeNull()
    expect((txErr as Error).message).toMatch(/事务未提交.*已整体回滚/)
    expect(await s.count('tags'), '被废事务的写入不得残留').toBe(3)
    await s.close()
  })

  it('COMMIT 在驱动里执行期间，残留续体不得再下发语句（先退役令牌，再发 COMMIT）（CR 第三十八轮 major）', { timeout: 90_000 }, async () => {
    // CR 第三十八轮 #9：回调返回、零在途时照常 COMMIT；但 COMMIT 的**执行**与其结果交回之间
    // 还有窗口，残留续体（定时器）在这段时间里若仍被准入，INSERT 会排在 COMMIT 之后在 autocommit
    // 里执行 —— 事务报成功，数据却来路不明。判据：COMMIT 下发前就退役令牌。
    const real = await import('@duckdb/node-api')
    let releaseDeliver!: () => void
    let deliverGate: Promise<void> | undefined
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (!holdNext || sql !== 'COMMIT') return cc.runAndReadAll(sql, params)
                  holdNext = false
                  const outcome = cc.runAndReadAll(sql, params)
                  await outcome                       // COMMIT 已原生执行完
                  deliverGate = new Promise<void>((r) => { releaseDeliver = r })
                  await deliverGate                   // 结果扣住
                  return outcome
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
    let late: Promise<unknown> | undefined
    const txP = s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
      setTimeout(() => {
        late = t.upsert('tags', [{ id: '3', name: 'C', color: '#FFF' }]).then(() => 'ok', (e: unknown) => e as Error)
      }, 20)
    }).then(() => null, (e: unknown) => e as Error)
    for (const deadline = Date.now() + 10_000; deliverGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(deliverGate, '前提：COMMIT 已执行、结果被扣住').toBeDefined()
    // 让定时器在 COMMIT 的结果交回之前触发
    for (const deadline = Date.now() + 10_000; late === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    releaseDeliver()
    const txErr = await txP
    expect(txErr, '正常事务必须提交成功').toBeNull()
    const lateOut = await late
    expect(lateOut, 'COMMIT 执行期间的续体不得再下发语句').toMatchObject({ kind: 'internal' })
    expect((lateOut as Error).message).toMatch(/事务已经结束/)
    expect(await s.count('tags'), '迟到的写不得在 autocommit 里落库').toBe(2)
    await s.close()
  })

  it('极老的事务残留上下文在 64 条事务之后仍被拒（令牌自带结束标志）（CR 第三十八轮 major）', { timeout: 120_000 }, async () => {
    // CR 第三十八轮 #8：全局「已结束令牌集合」按 FIFO 淘汰后，极老上下文里的语句又能通过检查。
    // 令牌改成对象、自带 `ended`，随异步上下文存活多久都有效。
    const s = await fresh()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    let late: Promise<unknown> | undefined
    // ⚠️ 定时器不能「到点就下发」：那样它可能在 70 条事务跑完**之前**就执行，FIFO 还没淘汰它，
    // 用例会假绿（实测：M7 变异下仍通过）。改成等测试放行后再下发，淘汰一定已经发生。
    let release!: () => void
    const go = new Promise<void>((r) => { release = r })
    await s.transaction(async () => {
      setTimeout(() => {
        void go.then(() => { late = s.query('SELECT 1').then(() => 'ok', (e: unknown) => e as Error) })
      }, 0)
    })
    for (let i = 0; i < 70; i++) {
      await s.transaction(async (t) => { await t.upsert('tags', [{ id: String(i + 2), name: `T${i}`, color: '#FFF' }]) })
    }
    release()
    for (const deadline = Date.now() + 10_000; late === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    const out = await late
    expect(out, '70 条事务之后，第 1 条事务的残留上下文仍必须被拒').toMatchObject({ kind: 'internal' })
    expect((out as Error).message).toMatch(/事务已经结束/)
    expect(await s.count('tags')).toBe(71)
    await s.close()
  })

  it('BEGIN 原生已成功、结果交回时才拒绝 → 连接必须退役，不得留下一条还开着的事务（CR 第三十八轮疑问实测）', { timeout: 90_000 }, async () => {
    // CR 第三十八轮 #7 的疑问：驱动能否在原生 BEGIN **成功后**才拒绝交回结果？若能，`beganTx`
    // 若在 BEGIN 返回之后才登记就是空的 —— 随后 ROLLBACK 也失败时不会触发退役，事务其实还开着，
    // 后续语句会落进去（Codex 复现：查询照常、再写报 `cannot start a transaction within a
    // transaction`）。这里用导入缝**直接注入这种失败**并钉住我们的答案：禁止后续语句。
    const real = await import('@duckdb/node-api')
    let failBegin = false
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (sql === 'ROLLBACK') throw new Error('注入：ROLLBACK 在执行前被拒绝')
                  const out = await cc.runAndReadAll(sql, params)
                  if (sql === 'BEGIN' && failBegin) {
                    failBegin = false
                    throw new Error('注入：BEGIN 结果交回时被拒绝')
                  }
                  return out
                },
              }
            },
          }
        },
      },
    })
    const s = await createDuckDbStore(cfg, 'rw', { importer })
    await s.init()
    failBegin = true
    const txErr = await s.transaction(async () => { /* 不该进来 */ })
      .then(() => null, (e: unknown) => e)
    expect(txErr, '交回期的拒绝必须透传给调用方').not.toBeNull()
    expect((txErr as Error).message).toMatch(/BEGIN 结果交回时被拒绝/)
    const after = await s.count('tags').then(() => null, (e: unknown) => e as Error)
    expect(after, '原生 BEGIN 已成功、回滚又未能确认 → 后续语句必须被拒（连接已退役）')
      .toMatchObject({ kind: 'internal' })
    expect((after as Error).message).toMatch(/退役|无法确认/)
    await s.close()
  })

  it('写操作未完成导致 upsert 准入失败 → 不得为此发 ROLLBACK（CR 第三十九轮 major）', { timeout: 90_000 }, async () => {
    // CR 第三十九轮 #1：准入在 upsert 拿到事务、发出 BEGIN **之前**就拒绝了；旧实现仍进入
    // 回滚处理，把 ROLLBACK 发到一条**忙着的**连接上 —— 若连接上已有手开事务，那条 ROLLBACK
    // 会把别人的写入一起回滚掉，而且拒绝被拖到驱动回应之后。只有 BEGIN 尝试过才允许回滚。
    const real = await import('@duckdb/node-api')
    const sqls: string[] = []
    let releaseExecute!: () => void
    let executeGate: Promise<void> | undefined
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  sqls.push(sql)
                  if (!holdNext || !sql.includes('q39_hold')) return cc.runAndReadAll(sql, params)
                  holdNext = false
                  executeGate = new Promise<void>((r) => { releaseExecute = r })
                  await executeGate
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
    sqls.length = 0
    holdNext = true
    const outside = s.query('SELECT 42 AS q39_hold').then((r) => ({ r }), (e: unknown) => ({ err: e as Error }))
    for (const deadline = Date.now() + 10_000; executeGate === undefined && Date.now() < deadline;) {
      await new Promise((r) => setTimeout(r, 10))
    }
    expect(executeGate, '前提：外部语句已下发、停在执行闸门上').toBeDefined()
    const upErr = await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
      .then(() => null, (e: unknown) => e as Error)
    expect(upErr, '准入失败必须 internal').toMatchObject({ kind: 'internal' })
    expect(sqls.filter((q) => /^\s*ROLLBACK\b/i.test(q)), '还没碰过 BEGIN，一条 ROLLBACK 都不许发').toEqual([])
    releaseExecute()
    expect(await outside, '外部语句自己的结果原样交回').toHaveProperty('r')
    // 写操作照常可用
    await s.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }])
    expect(await s.count('tags'), '第一次 upsert 从未开始，只有第二行').toBe(1)
    await s.close()
  })

  it('回调没有 await 的多批次写：整条写操作完成前不得提交（不是只看单条语句）（CR 第三十九轮 major）', { timeout: 90_000 }, async () => {
    // CR 第三十九轮 #2：多批次写两条语句之间 `txInFlight` 会瞬间归零 —— 回调没 await 它时，
    // `commitOrRefuse` 可能恰好在「上一批已交回、下一批还没下发」的窗口里看到零并 COMMIT，
    // 事务报成功、第二批随后被拒（只有部分行落库）。
    // 导入缝让第一条 INSERT **不落原生**、直接返回：它的交回与下一批的下发分处两个微任务，
    // 提交判据恰好在窗口里执行（把按语句计数改回按令牌计数即变红）。
    const real = await import('@duckdb/node-api')
    let fakeNext = false
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (fakeNext && sql.startsWith('INSERT INTO "tags"')) {
                    fakeNext = false
                    return { getRowObjectsJson: () => [], columnNames: () => [] }
                  }
                  return cc.runAndReadAll(sql, params)
                },
              }
            },
          }
        },
      },
    })
    const s = await createDuckDbStore({ ...cfg, batchSize: 1 }, 'rw', { importer })
    await s.init()
    await s.upsert('tags', [{ id: '0', name: 'S', color: '#FFF' }])
    fakeNext = true
    const txErr = await s.transaction(async (t) => {
      // 故意不 await：两行分成两批，第一批的交回与第二批的下发分处两个微任务
      void t.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }, { id: '2', name: 'B', color: '#FFF' }])
        .catch(() => { /* 收尾期被拒 */ })
    }).then(() => null, (e: unknown) => e as Error)
    expect(txErr, '未完成的写不得被当成已提交（旧实现这里会是 null）').not.toBeNull()
    expect((txErr as Error).message, '成因要点名未完成的写操作').toMatch(/写操作没有完成/)
    expect(await s.count('tags'), '只保留 setup 行：事务整体回滚').toBe(1)
    await s.close()
  })

  it('COMMIT 已执行、结果交回失败 → 必须交回「结果未知，可能已落库」并退役连接（CR 第三十九轮疑问实测）', { timeout: 90_000 }, async () => {
    // CR 第三十九轮的疑问：原生 COMMIT 成功、结果交回失败时，调用方会不会拿到一个可以
    // 「安全重试」的失败（而写入其实已在库里）？答案：交回结果未知的专用错误，并退役连接；
    // 新连接核对能看到那行 —— 警告里的「可能已经落库」是事实，不是保守话术。
    const real = await import('@duckdb/node-api')
    let failCommit = false
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  const out = await cc.runAndReadAll(sql, params)
                  if (sql === 'COMMIT' && failCommit) {
                    failCommit = false
                    throw new Error('注入：COMMIT 结果交回时被拒绝')
                  }
                  return out
                },
              }
            },
          }
        },
      },
    })
    const s = await createDuckDbStore(cfg, 'rw', { importer })
    await s.init()
    failCommit = true
    const txErr = await s.transaction(async (t) => {
      await t.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    }).then(() => null, (e: unknown) => e as Error)
    expect(txErr, '提交结果未知必须作为失败交回').not.toBeNull()
    expect((txErr as Error).message, '必须点明「结果未知、可能已落库」').toMatch(/提交结果未知.*可能已经落库/)
    expect((txErr as Error).message, '必须劝阻直接重试').toMatch(/不要按失败直接重试/)
    const after = await s.count('tags').then(() => null, (e: unknown) => e as Error)
    expect(after, '结果未知后不得继续使用同一连接').toMatchObject({ kind: 'internal' })
    expect((after as Error).message).toMatch(/退役|无法确认/)
    await s.close()
    const s2 = await createDuckDbStore(cfg, 'rw')
    expect(await s2.count('tags'), '写入确实已经落库 —— 警告不是话术').toBe(1)
    await s2.close()
  })

  it('收尾等不到在途语句 → 先中断再等，交回后照常 ROLLBACK（CR 第三十九轮 major：关闭不解卡）', { timeout: 90_000 }, async () => {
    // CR 第三十九轮的疑问：drainOwned 超时后让调用方「关闭并重建」安不安全？直连驱动实测
    // （2026-11-19）：**不安全** —— closeSync 不取消原生任务，语句仍卡在原生执行里时，
    // 关连接/关实例各 0ms 返回，但进程再也不会自行退出（CPU 0%，被原生线程卡住，只能 kill）。
    // 修法：超时先 interrupt()，语句以 INTERRUPT 交回后照常 ROLLBACK。
    // 本用例走导入缝让「交回」发生在中断之后（闸门而不是真查询），把时序钉死。
    const real = await import('@duckdb/node-api')
    const events: string[] = []
    let holdInsert = false
    let releaseDeliver!: () => void
    let deliverGate: Promise<void> | undefined
    let interrupted = false
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                // 中断可由测试注入（原生连接上没有真正卡住的查询）
                interrupt: () => {
                  interrupted = true
                  events.push('interrupted')
                  releaseDeliver?.()
                },
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  if (sql === 'ROLLBACK') events.push('rollback-dispatched')
                  if (!holdInsert || !sql.startsWith('INSERT INTO "tags"')) return cc.runAndReadAll(sql, params)
                  events.push('insert-executed')
                  holdInsert = false
                  deliverGate = new Promise<void>((r) => { releaseDeliver = r })
                  await deliverGate
                  events.push('insert-returned')
                  if (interrupted) throw new Error('INTERRUPT Error: Interrupted!')
                  return cc.runAndReadAll(sql, params)
                },
              }
            },
          }
        },
      },
    })
    const s = await createDuckDbStore(cfg, 'rw', {
      importer, drainCapMs: 150, drainInterruptGraceMs: 5_000,
    })
    await s.init()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    const txErr = await s.transaction(async (t) => {
      // 不 await：收尾时它仍在途（闸门扣着结果）
      holdInsert = true
      void t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }]).catch(() => {})
    }).then(() => null, (e: unknown) => e as Error)
    expect(txErr, '未交回的写不得被当成已提交').not.toBeNull()
    expect(interrupted, '超时后必须先中断在途语句（否则关闭不解卡、进程卡住）').toBe(true)
    expect(events, '中断要发生在 ROLLBACK 之前，且语句交回后照常回滚')
      .toEqual(['insert-executed', 'interrupted', 'insert-returned', 'rollback-dispatched'])
    // 中断路径成功 → 连接**不**退役：后续语句照常可用
    expect(await s.count('tags'), '该事务的写入不得残留，连接未被退役').toBe(1)
    await s.close()
  })

  it('真原生执行卡住 → interrupt() 让语句以 INTERRUPT 交回、ROLLBACK 照常确认、库不损坏（CR 第三十九轮 major）', { timeout: 90_000 }, async () => {
    // 闸门用例把「交回发生在中断之后」的时序钉死了，但 CR 明确要求用**真实原生执行**回答
    // 「关闭/中断到底能不能解卡」。直连驱动实测（2026-11-19，1.5.6-r.1）：
    //  · 不回滚直接 close：连接/实例各 0ms 返回、库可重建，但进程永不退出（CPU 0%）；
    //  · interrupt()：语句 ~100ms 内以 `INTERRUPT Error: Interrupted!` 交回，ROLLBACK 成功，
    //    行状态不变、进程正常退出。
    // 本用例跑真库真查询，钉死第二条：库内容不变、事务报「已整体回滚」、连接不退役。
    // ⚠️ 宽限必须明显短于这条查询的自然耗时（本机实测 ~6s）：否则「不中断、光等」也能通过，
    // 用例就区分不出 interrupt 有没有发（第三十九轮变异 M5 实测：宽限 10s 时该变异存活）。
    const s = await createDuckDbStore(cfg, 'rw', { drainCapMs: 200, drainInterruptGraceMs: 2_000 })
    await s.init()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    const txErr = await s.transaction(async (t) => {
      void t.count('tags').catch(() => {})
      // 不 await 的**原生重查询**（2e10 行计数，>200ms；drain 到点后必须靠 interrupt 收场）
      void s.query('SELECT count(*) AS n FROM range(20000000000)').catch(() => {})
    }).then(() => null, (e: unknown) => e as Error)
    expect(txErr, '未交回的语句不得被当成已提交').not.toBeNull()
    expect((txErr as Error).message, '中断让它交回，回滚因此可确认').toMatch(/已整体回滚/)
    expect((txErr as Error).message, '不得声称连接退役').not.toMatch(/退役/)
    expect(await s.count('tags'), '中断属于回滚路径，库内容不变、连接仍可用').toBe(1)
    await s.close()
  })

  it('中断后仍不交回 → 退役连接，且错误如实说明回滚未能确认（不冒充「已回滚」）', { timeout: 90_000 }, async () => {
    // 中断不是万能的（原生任务卡在不可中断点上）。此时 drainOwned 返回 false 的语义必须保留：
    // 退役连接、不发 ROLLBACK、错误里写「回滚也未能确认」而不是「已整体回滚」。
    const real = await import('@duckdb/node-api')
    let holdInsert = false
    let interrupted = false
    const sqls: string[] = []
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
              const cc = c as { runAndReadAll: (s: string, p?: unknown[]) => Promise<unknown>; closeSync?: () => void }
              return {
                ...(c as object),
                closeSync: () => cc.closeSync?.(),
                interrupt: () => { interrupted = true },
                runAndReadAll: async (sql: string, params?: unknown[]) => {
                  sqls.push(sql)
                  if (!holdInsert || !sql.startsWith('INSERT INTO "tags"')) return cc.runAndReadAll(sql, params)
                  // 永远不交回：模拟卡在不可中断的原生点上
                  await new Promise(() => {})
                },
              }
            },
          }
        },
      },
    })
    const s = await createDuckDbStore(cfg, 'rw', {
      importer, drainCapMs: 150, drainInterruptGraceMs: 150,
    })
    await s.init()
    await s.upsert('tags', [{ id: '1', name: 'A', color: '#FFF' }])
    holdInsert = true
    const txErr = await s.transaction(async (t) => {
      void t.upsert('tags', [{ id: '2', name: 'B', color: '#FFF' }]).catch(() => {})
    }).then(() => null, (e: unknown) => e as Error)
    expect(interrupted, '前提：确实中断过').toBe(true)
    expect((txErr as Error).message, '回滚未确认时不得说「已整体回滚」').toMatch(/回滚也未能确认/)
    expect(sqls.filter((q) => q === 'ROLLBACK'), '无法确认时不得发 ROLLBACK').toEqual([])
    const after = await s.count('tags').then(() => null, (e: unknown) => e as Error)
    expect(after, '退役后任何后续语句都必须被拒').toMatchObject({ kind: 'internal' })
    expect((after as Error).message).toMatch(/退役|无法确认/)
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

  it('close 后跨进程可立即重开（N1 钉死：close 必须真释放锁）', { timeout: 180_000 }, async () => {
    // ⚠️ 单独放宽到 180s（文件默认 15s）：本用例要 spawn 一个**新 node 进程**，它不吃
    // `tests/setup-warm.ts` 的进程内预热，必须自己付一次原生绑定冷启动。高负载实测
    // 首开 10–34s，极端记录 89.5s（见 HANDOFF / 记忆 local-load-slow-duckdb-startup），
    // 15s 会把「机器忙」报成「close 没放锁」。等待本身是条件式的（等子进程 exit），
    // 这里的上限只是环境故障判据，不是竞态阈值。
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

  it('读者撞锁：退避超限 → 包装 store_locked + hint（验收 35，注入假时钟；跨进程持真锁 + 按轮换全新路径重试）', { timeout: LOCK_BUDGET_MS + 60_000 }, async () => {
    // ⚠️ 超时预算（LOCK_BUDGET_MS + 60s）：跨进程锁用例每轮要 spawn 2–3 个**新进程**，
    // 它们不吃 tests/setup-warm.ts 的进程内预热，各自付一次原生绑定冷启动（高负载实测
    // 10–34s，极端 89.5s）。预算由 helpers/lock-holder.ts 的**单一下载截止时刻**统管：
    // 每次等待只花剩余预算，耗尽就带着子进程原始输出报错，不把「机器忙」说成「竞态」。
    //
    // 回移 T7 方案（同文件写者用例同款，M3 修间歇红）：@duckdb/node-api 有
    // **进程内单例缓存** —— 测试进程打开过的库路径再开一律命中缓存、绕过文件锁，
    // 同进程 seed 再撞锁是间歇红根因。改为：
    // ① 持锁者直接对**全新路径**持锁（DuckDBInstance.create 会建文件，无需 seed）；
    // ② 持锁者先跑一条语句再打标记 —— 语句执行成功即证明写事务已取得，文件锁已落盘
    //    （实测对照：跑语句后 20/20 CONFLICT），再用独立子进程校验 CONFLICT 兜底；
    // ③ 极少数情况下校验 CONFLICT 后读者仍能打开（锁落盘竞态窗口）——每轮换
    //    全新路径重试，最多 5 轮。锁生效是平台保证，重试只对冲竞态窗口。
    // 被测语义不变（验收 35）：kind=store_locked、retryable=true、假时钟退避超限。
    const deadline = Date.now() + LOCK_BUDGET_MS
    let holder: import('node:child_process').ChildProcess | undefined
    try {
      let asserted = false
      let roundsRun = 0
      let lockConfirmed = 0   // 独立子进程看到 CONFLICT 的轮数（区分「锁没生效」与「锁生效后仍打开」）
      for (let round = 0; round < 5 && !asserted; round++) {
        roundsRun = round + 1
        const p = join(dir, `r-${round}.db`)   // 每轮换全新路径（避开本进程实例缓存）
        if (holder) holder.kill('SIGKILL')
        holder = await spawnLockHolder({ dbPath: p, scriptDir: dir, name: `r-holder-${round}`, deadline })
        if (await lockVerdict(p, dir, deadline) !== 'CONFLICT') continue   // 锁未落盘，换轮
        lockConfirmed++
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
      // ⚠️ 归因要分两种：lockConfirmed == 0 说明**锁根本没生效**（夹具坏了/平台行为变了），
      // 不是「竞态窗口」；lockConfirmed > 0 却每轮都 opened 才是那条竞态窗口。此前两者
      // 共用一句「锁落盘竞态超预期」—— 变异实测（把持有者的实例提前关掉）会红成这句话，
      // 把「锁根本没持住」说成平台竞态，归因是错的。
      expect(lockConfirmed, '5 轮里没有任何一轮的独立校验看到 CONFLICT —— 锁未生效（夹具或平台行为变了），不是竞态窗口').toBeGreaterThan(0)
      expect(asserted, `未取得「锁生效且读者撞锁」—— 已跑 ${roundsRun} 轮（${lockConfirmed} 轮锁已确认）。锁落盘竞态超预期，不是被测代码。`).toBe(true)
    } finally {
      holder?.kill('SIGKILL')
    }
  })

  it('写者撞锁：不重试、立即抛 store_locked（注入 sleep 证明未调用；跨进程持真锁 + 按轮换全新路径重试）', { timeout: LOCK_BUDGET_MS + 60_000 }, async () => {
    // ⚠️ 超时预算与读者用例同因（LOCK_BUDGET_MS + 60s）：每轮两次子进程冷启动；
    // 等待统管在 helpers/lock-holder.ts 的单一截止时刻上，耗尽就报「预算耗尽」。
    //
    // ⚠️ 回移 T7 方案（tests/commands/store.test.ts 同款）：@duckdb/node-api 有
    // **进程内单例缓存** —— 测试进程打开过的库路径再开一律命中缓存、绕过文件锁，
    // 同进程 seed 再撞锁是间歇红根因。改为：
    // ① 持锁者直接对**全新路径**持锁（DuckDBInstance.create 会建文件，无需 seed）；
    // ② 持锁者先跑一条语句再打标记（语句成功即证明写事务已取得、锁已落盘；实测 20/20
    //    CONFLICT），再用独立子进程校验 CONFLICT 兜底；
    // ③ 极少数情况下校验 CONFLICT 后写者仍能打开（锁落盘竞态窗口）——每轮换
    //    全新路径重试，最多 5 轮。锁生效是平台保证，重试只对冲竞态窗口。
    // 被测语义不变：kind=store_locked、retryable=true、写者不退避（sleep 未调用）。
    const deadline = Date.now() + LOCK_BUDGET_MS
    let holder: import('node:child_process').ChildProcess | undefined
    try {
      let asserted = false
      let roundsRun = 0
      let lockConfirmed = 0   // 独立子进程看到 CONFLICT 的轮数（区分「锁没生效」与「锁生效后仍打开」）
      for (let round = 0; round < 5 && !asserted; round++) {
        roundsRun = round + 1
        const p = join(dir, `w-${round}.db`)   // 每轮换全新路径（避开本进程实例缓存）
        if (holder) holder.kill('SIGKILL')
        holder = await spawnLockHolder({ dbPath: p, scriptDir: dir, name: `w-holder-${round}`, deadline })
        if (await lockVerdict(p, dir, deadline) !== 'CONFLICT') continue   // 锁未落盘，换轮
        lockConfirmed++
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
      expect(lockConfirmed, '5 轮里没有任何一轮的独立校验看到 CONFLICT —— 锁未生效（夹具或平台行为变了），不是竞态窗口').toBeGreaterThan(0)
      expect(asserted, `未取得「锁生效且写者撞锁」—— 已跑 ${roundsRun} 轮（${lockConfirmed} 轮锁已确认）。锁落盘竞态超预期，不是被测代码。`).toBe(true)
    } finally {
      holder?.kill('SIGKILL')
    }
  })

  it('只读持有者同样挡住写者 —— 报错不得把持有者说成「写进程」', { timeout: LOCK_BUDGET_MS + 60_000 }, async () => {
    // 2026-11-05 审查实测：DuckDB 是「写者独占 / 读者共享」—— 一个以 READ_ONLY 打开的
    // 进程同样会让写者拿到 `Conflicting lock`。旧文案「数据库被写进程占用 / 另一个进程
    // 持有数据库写锁」把只读持有者说成写者，Agent 会去等一个并不存在的同步任务。
    //
    // ⚠️ 与同文件另外两条撞锁用例同款的三段式，缺一段就会间歇红：
    // ① 每轮换全新路径（@duckdb/node-api 进程内实例缓存会绕过文件锁）；
    // ② 持有者跑一条语句后再打标记，用独立子进程校验 CONFLICT（锁可能尚未落盘）；
    // ③ 极少数情况下校验通过后写者仍能打开（锁落盘竞态窗口）→ 换轮重来。
    // ⚠️ 超时预算与另两条同因：每轮三个子进程（种子/持有者/校验）各付一次冷启动；
    // 等待统管在 helpers/lock-holder.ts 的单一截止时刻上。
    const deadline = Date.now() + LOCK_BUDGET_MS
    let holder: import('node:child_process').ChildProcess | undefined
    try {
      let asserted = false
      let roundsRun = 0
      let lockConfirmed = 0   // 独立子进程看到 CONFLICT 的轮数（区分「锁没生效」与「锁生效后仍打开」）
      for (let round = 0; round < 5 && !asserted; round++) {
        roundsRun = round + 1
        const p = join(dir, `ro-lock-${round}.db`)
        if (holder) holder.kill('SIGKILL')
        // 只读实例要求文件已存在 → 先由**子进程**建一个合法的空 DuckDB 文件
        // （种子放本进程会命中实例缓存，后续持有者/写者都绕开文件锁）。
        await seedEmptyDb(p, dir, deadline)
        holder = await spawnLockHolder({ dbPath: p, scriptDir: dir, name: `ro-holder-${round}`, accessMode: 'READ_ONLY', deadline })
        if (await lockVerdict(p, dir, deadline) !== 'CONFLICT') continue   // 锁未落盘，换轮
        lockConfirmed++
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
      expect(lockConfirmed, '5 轮里没有任何一轮的独立校验看到 CONFLICT —— RO 持有者的锁未生效，不是竞态窗口').toBeGreaterThan(0)
      expect(asserted, `未取得「RO 持有者生效且写者撞锁」—— 已跑 ${roundsRun} 轮（${lockConfirmed} 轮锁已确认）。锁落盘竞态超预期，不是被测代码。`).toBe(true)
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
