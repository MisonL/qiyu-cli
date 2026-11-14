import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDuckDbStore } from '../../src/store/duckdb.js'
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
  it('batchSize 大于硬顶时被 65000 参数硬顶二次切住（M2：行数 = min(batchSize, floor(65000/列数))）', { timeout: 15_000 }, async () => {
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

describe('duckdb —— 事务', () => {
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

  it('tx 内嵌套 transaction() → usage', async () => {
    const s = await fresh()
    await expect(s.transaction(async (tx) => {
      await (tx as unknown as { transaction: (f: unknown) => Promise<unknown> }).transaction(async () => {})
    })).rejects.toThrow(/嵌套|usage/)
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

  it('他人库指纹 ①：schema_version 缺 version 列 → 拒绝（不回落到「版本 0 照常迁移」）', async () => {
    const p = await rawDb('a.db', 'CREATE TABLE schema_version (version_id INTEGER, applied_at VARCHAR)')
    // 报错必须点名 schema_version —— 否则「拒绝」可能来自别的原因，判据就成了碰巧绿。
    await expect(createDuckDbStore({ ...cfg, path: p }, 'rw').then((s) => s.init()))
      .rejects.toMatchObject({ kind: 'store_not_initialized',
        message: expect.stringContaining('schema_version 缺少 version 列') })
  })

  it('他人库指纹 ②：有表但 schema_version 一条记录都没有 → 拒绝', async () => {
    const p = await rawDb('b.db',
      'CREATE TABLE schema_version (version INTEGER)',
      'CREATE TABLE secret (k VARCHAR)')
    await expect(createDuckDbStore({ ...cfg, path: p }, 'rw').then((s) => s.init()))
      .rejects.toMatchObject({ kind: 'store_not_initialized',
        message: expect.stringContaining('schema_version 没有任何记录') })
  })

  it('他人库指纹 ③：记录的版本高于本 CLI 最新迁移 → 拒绝（不按陌生版本号「已是最新」）', async () => {
    const p = await rawDb('c.db',
      'CREATE TABLE schema_version (version INTEGER)',
      'INSERT INTO schema_version VALUES (999)')
    await expect(createDuckDbStore({ ...cfg, path: p }, 'rw').then((s) => s.init()))
      .rejects.toMatchObject({ kind: 'store_not_initialized',
        message: expect.stringContaining('高于本 CLI 已知的最新迁移') })
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
    await expect(s.upsert('schema_version', [{ version: 1 }])).resolves.toBe(1)
    await expect(s.upsert('schema_version', [{ version: 1 }])).resolves.toBe(1) // 再来一次不报错
    expect(await s.count('schema_version'), '冲突行不得被插成第二行').toBe(before)
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
