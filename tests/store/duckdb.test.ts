import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
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
  it('init 建出四张表（tables() 排序）', async () => {
    const s = await fresh()
    expect(await s.tables()).toEqual(['schema_version', 'sync_gaps', 'sync_state', 'tags'])
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
    // D-T4 起 sync_state 共 9 列：完整列集须含 next_allowed_at / last_rate_limited_at。
    await s.upsert('sync_state', [{ dataset: 'tags', watermark: null, range_status: null,
      last_error: null, locked_by: null, locked_at: null, last_synced_at: null,
      next_allowed_at: null, last_rate_limited_at: null }])
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
      // ⚠️ D-T3 起真实清单已有 v2，注入失败条目改用 version 3（真实清单跳到 v4，3 不撞号）。
      .mockReturnValue([...real, { version: 3, up: async () => { throw new Error('注入的迁移失败') } }] as never)
    const s1 = await createDuckDbStore(cfg, 'rw')
    await expect(s1.init()).rejects.toThrow('注入的迁移失败')
    expect(await s1.count('schema_version')).toBe(2)   // v1/v2 已记、v3 未记（失败不推进）
    await s1.close()
    // 恢复真实迁移，重新 init → 重放路径只补 v3（真实清单无 v3，MAX 保持 2）
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
    expect(Number(v.rows[0].v)).toBe(4)   // D-T4 起 v1+v2+v4，MAX=4（v3 空档预留给 T6）
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

  it('读者撞锁：退避超限 → 包装 store_locked + hint（验收 35，注入假时钟；跨进程持真锁 + 按轮换全新路径重试 ≤5 轮）', { timeout: 60000 }, async () => {
    // ⚠️ 回移 T7 方案（同文件写者用例同款，M3 修间歇红）：@duckdb/node-api 有
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
        try {
          await expect(createDuckDbStore({ ...cfg, path: p, readOnlyRetryMs: 1000 }, 'ro', {
            sleep: async (ms) => { t += ms }, now: () => t,
          })).rejects.toMatchObject({
            kind: 'store_locked',
            retryable: true,
            // hint 逐字（P 组 P-M2 改：前半句复述 message 已删，给第二动作）
            hint: '请稍后重试；等待上限可经配置文件 readOnlyRetryMs（默认 30000 毫秒）调整，或用 --db 指向其他数据库文件',
            message: expect.stringMatching(/被写进程占用/),
          })
          expect(t).toBeGreaterThan(0)   // 读者确实走了退避（与写者「不退避」分形）
          asserted = true
        } catch { /* 锁竞态窗口（CONFLICT 后仍打开），换轮重来 */ }
      }
      expect(asserted, '5 轮内未取得「锁生效且读者撞锁」——锁落盘竞态超预期').toBe(true)
    } finally {
      holder?.kill('SIGKILL')
    }
  })

  it('写者撞锁：不重试、立即抛 store_locked（注入 sleep 证明未调用；跨进程持真锁 + 按轮换全新路径重试 ≤5 轮）', { timeout: 60000 }, async () => {
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
        try {
          await expect(createDuckDbStore({ ...cfg, path: p }, 'rw', { sleep, now: () => 0 }))
            .rejects.toMatchObject({
              kind: 'store_locked',
              retryable: true,
              hint: expect.stringMatching(/写锁/),
            })
          expect(sleep).not.toHaveBeenCalled()   // 写者不退避（spec §5.2）
          asserted = true
        } catch { /* 锁竞态窗口（CONFLICT 后仍打开），换轮重来 */ }
      }
      expect(asserted, '5 轮内未取得「锁生效且写者撞锁」——锁落盘竞态超预期').toBe(true)
    } finally {
      holder?.kill('SIGKILL')
    }
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
