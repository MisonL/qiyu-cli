// tests/commands/store.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeCommand } from '../../src/commands/store.js'

let dir = '', out = '', err = ''
const dbPath = (): string => join(dir, 'q.db')
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-cmd-'))
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
  vi.stubEnv('HOME', dir)   // 隔离真实 ~
  vi.stubEnv('USERPROFILE', dir)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }) })
const data = (): Record<string, unknown> => JSON.parse(out).data

describe('store init', () => {
  // ⚠️ 偏离声明：本用例 vitest 超时从默认 5s 提到 40s —— 偶发（实测约 1/10）rw close
  // 后文件锁释放有延迟，紧接的 ro 打开撞锁走 30s 退避；超时会让未决的 stdout 写入
  // 污染下一用例（双行 JSON 级联）。若真撞锁，status 返回 store_locked，断言仍会红，
  // 不会静默。
  it('internal 兜底端到端：status 撞执行期错误 → 1 + internal + 中文包装不裸透（验收 54，I 组 H1）', { timeout: 40000 }, async () => {
    // 用 vi.doMock 替换 openStore，把注入英文执行期错误的 store 交给 status ——
    // thrownToExit 的「无 kind」分支被端到端钉住：退出码 1、kind=internal、
    // message 是「存储操作失败（底层：…）」中文包装形态、hint 中性（不含「写入」）。
    expect(await storeCommand(['init', '--db', dbPath()])).toBe(0)
    out = ''; err = ''
    // 动态 import 使 doMock 生效（storeCommand 内部的 openStore 从 index.js 来）
    // ⚠️ J-M2 实测裁决：doMock + 动态 import 在 vitest 2.1.9 下依赖「doMock 后动态
    // import 重新求值模块链」。首跑发现 mock 未生效（顶层静态 import 已求值模块链），
    // 按 brief 预案在 doMock 前加 vi.resetModules() 再动态 import —— 不改 store.ts 实现。
    vi.resetModules()
    vi.doMock('../../src/store/index.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../../src/store/index.js')>()
      const { createDuckDbStore } = await import('../../src/store/duckdb.js')
      return {
        ...orig,
        openStore: async (cfg: unknown, mode: unknown) => {
          const s = await createDuckDbStore(cfg as never, mode as never)
          // 注入英文执行期错误（无 kind —— 模拟 DuckDB 原生错误穿过 thrownToExit）
          vi.spyOn(s as unknown as { execSql: (sql: string) => Promise<unknown> }, 'execSql')
            .mockRejectedValue(new Error('Constraint Error: NOT NULL constraint failed'))
          return s
        },
      }
    })
    // 动态 import 使 doMock 生效（storeCommand 内部的 openStore 从 index.js 来）
    // ⚠️ J-M2 实测裁决：doMock + 动态 import 在 vitest 2.1.9 下依赖「doMock 后动态
    // import 重新求值模块链」。若首跑发现 mock 未生效（e.kind 是 store_not_initialized
    // 而非 internal），先在 doMock 前加 `vi.resetModules()` 再动态 import——不要去改
    // store.ts 实现（mock 未生效的表象与 internal 分支缺陷同形，改实现无解）。
    const { storeCommand: mockedCommand } = await import('../../src/commands/store.js')
    try {
      expect(await mockedCommand(['status', '--db', dbPath()])).toBe(1)
      const e = JSON.parse(out).error
      expect(e.kind).toBe('internal')
      expect(e.code).toBe('internal')
      expect(e.message).toMatch(/存储操作失败（底层：.*Constraint Error/)
      expect(e.hint).not.toMatch(/写入/)
    } finally {
      vi.doUnmock('../../src/store/index.js')
      vi.restoreAllMocks()
    }
  })

  it('退出码 0、输出六字段', async () => {
    expect(await storeCommand(['init', '--db', dbPath()])).toBe(0)
    const d = data()
    expect(d.path).toBe(dbPath())
    expect(d.backend).toBe('duckdb')
    expect(typeof d.config_path).toBe('string')
    expect(d.config_exists).toBe(false)
    expect(d.schema_version).toBe(9)
    expect(d.tables).toEqual(['daily_overview', 'knowledge_categories', 'knowledge_items',
      'knowledge_points', 'order_performance', 'robot_summary',
      'schema_version', 'sessions', 'staff', 'staff_attendance', 'staff_group_members',
      'staff_groups', 'staff_quality', 'staff_salary_detail', 'staff_satisfaction',
      'staff_workload', 'sync_gaps', 'sync_state', 'tags', 'ticket_categories', 'ticket_logs',
      'ticket_template_fields', 'ticket_templates', 'tickets', 'transfer_human'])
  })

  it('重复 init 幂等（验收 41 + 18：schema_version 不变）', async () => {
    await storeCommand(['init', '--db', dbPath()])
    const v1 = data().schema_version
    out = ''   // ⚠️ 本用例两次 init 各写一行 JSON；不清 out 则 data() 的 JSON.parse 撞第二行
    expect(await storeCommand(['init', '--db', dbPath()])).toBe(0)
    expect(data().schema_version).toBe(v1)
  })

  it('不创建配置文件（验收 45：文件系统事实，非字段自洽）', async () => {
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    await storeCommand(['init', '--db', dbPath()])
    expect(data().config_exists).toBe(false)
    // 直接断言文件系统：配置文件不存在（若实现误创建则此处必红）
    expect(existsSync(join(dir, '.config', 'qiyu', 'config.json'))).toBe(false)
  })
})

describe('store status', () => {
  it('未初始化 → 1 + store_not_initialized + hint 含 store init', async () => {
    expect(await storeCommand(['status', '--db', dbPath()])).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/store init/)
  })

  it('成功路径含六字段与 tables[{name,rows}]，且无 locked 字段', async () => {
    await storeCommand(['init', '--db', dbPath()])
    out = ''
    expect(await storeCommand(['status', '--db', dbPath()])).toBe(0)
    const d = data()
    // 六字段全断言（验收 47）
    expect(d.path).toBe(dbPath())
    expect(d.backend).toBe('duckdb')
    expect(typeof d.config_path).toBe('string')
    expect(d.config_exists).toBe(false)
    expect(d.schema_version).toBe(9)
    expect(Array.isArray(d.tables)).toBe(true)
    const t0 = (d.tables as Array<Record<string, unknown>>)[0]
    expect(t0).toHaveProperty('name')
    expect(t0).toHaveProperty('rows')
    expect('locked' in d).toBe(false)
  })

  it('--db 指向目录（非普通文件）→ 1', async () => {
    expect(await storeCommand(['status', '--db', dir])).toBe(1)
  })

  it('status 缺表两半边：空库 → hint 含 store init；他人库 → hint 含换路径', async () => {
    // 空库（合法 DuckDB、零表）→ 「请运行：qiyu store init」
    // ⚠️ 真实 API：instance 关闭是 closeSync()（第四轮实测）
    const empty = join(dir, 'empty.db')
    const mod = (await import('@duckdb/node-api')) as unknown as { DuckDBInstance: { create: (p: string, o?: unknown) => Promise<{ connect: () => Promise<{ run: (sql: string) => Promise<unknown> }>; closeSync: () => void }> } }
    const inst = await mod.DuckDBInstance.create(empty) as { closeSync: () => void }
    inst.closeSync()
    expect(await storeCommand(['status', '--db', empty])).toBe(1)
    let e = JSON.parse(out).error
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/store init/)
    // 他人库（有表、无 schema_version）→ 「请换 --db 路径」
    const alien = join(dir, 'alien.db')
    const inst2 = await mod.DuckDBInstance.create(alien) as { connect: () => Promise<{ run: (sql: string) => Promise<unknown>; closeSync: () => void }>; closeSync: () => void }
    const conn = await inst2.connect()
    await conn.run('CREATE TABLE alien (a INTEGER)')
    conn.closeSync()   // ⚠️ N 组 N1：connection 也要关，否则锁随进程存活
    inst2.closeSync()
    out = ''
    expect(await storeCommand(['status', '--db', alien])).toBe(1)
    e = JSON.parse(out).error
    expect(e.hint).toMatch(/换 --db 路径/)
  })
})

describe('store 命令面与 help', () => {
  it('--help 走 stdout 退出码 0', async () => {
    expect(await storeCommand(['--help'])).toBe(0)
    expect(out).toMatch(/store init/)
  })

  it('--help 不得声称「CLI 不会自动创建配置文件」—— auth login 会创建它（2026-10-28 实测）', async () => {
    // 旧文案：「存储配置需手工编辑 ~/.config/qiyu/config.json（CLI 不会自动创建）」。
    // G1 起 `auth login` 就会创建这个文件（目录 0700、文件 0600，只含 credentials）——
    // 「CLI 不会创建」已是假话，Agent 会据此以为文件不可能存在、跳过排查。
    expect(await storeCommand(['--help'])).toBe(0)
    expect(out, '不能再说 CLI 不会创建配置文件').not.toMatch(/CLI 不会自动创建/)
    expect(out, '必须点明谁可能创建了它').toMatch(/auth login/)
    expect(out, '必须说明创建出来的文件不含 store 段').toMatch(/不含 store 段/)
  })

  it('未知参数优先于 help（store --bogus --help → 2）', async () => {
    expect(await storeCommand(['--bogus', '--help'])).toBe(2)
  })

  it('store init --pretty → 成功且缩进（G1 已实现）；--db --pretty 仍报缺值（值位优先）', async () => {
    // ⚠️ G1 前是「显式拒绝退出 2」；现在 --pretty 是真实的输出开关。
    // 值位守卫必须先于它：`--db --pretty` 里的 --pretty 是 --db 的（假想）取值位置。
    expect(await storeCommand(['init', '--db', dbPath(), '--pretty'])).toBe(0)
    expect(out.startsWith('{\n  "ok": true,'), 'init --pretty 必须缩进').toBe(true)
    out = ''; err = ''
    expect(await storeCommand(['init', '--db', '--pretty'])).toBe(2)
    expect(err).toMatch(/--db 缺少取值/)
  })

  it('store --help --pretty → 0', async () => {
    expect(await storeCommand(['--help', '--pretty'])).toBe(0)
  })

  it('store init --db --profile x → 2（值位遇 flag → 缺少取值）', async () => {
    expect(await storeCommand(['init', '--db', '--profile', 'x'])).toBe(2)
    expect(err).toMatch(/--db 缺少取值/)
  })

  it('store init --bogus → 2（未知参数，usageFail 双通道）', async () => {
    expect(await storeCommand(['init', '--bogus'])).toBe(2)
    expect(err.length).toBeGreaterThan(0)                    // stderr 文本通道
    expect(() => JSON.parse(out)).not.toThrow()              // stdout JSON 通道（验收 53）
    expect(JSON.parse(out).error.kind).toBe('usage')
  })

  it('配置层 usage 错误端到端 → 退出码 2（验收 8/9/11/40 的命令级链路，I 组 M1）', async () => {
    vi.stubEnv('HOME', dir)
    vi.stubEnv('USERPROFILE', dir)
    // ① 配置含未知键 → resolveStoreConfig 抛 → usageFail（验收 8）
    const cfgDir = join(dir, '.config', 'qiyu')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({ bogus: 1 }))
    expect(await storeCommand(['status'])).toBe(2)
    expect(JSON.parse(out).error.kind).toBe('usage')
    // ② 畸形 JSON → 退出码 2（验收 9）
    writeFileSync(join(cfgDir, 'config.json'), '{ not json')
    out = ''
    expect(await storeCommand(['status'])).toBe(2)
    expect(err.length).toBeGreaterThan(0)
    // ③ 行为参数非正整数 → 退出码 2（验收 11）
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify(
      { profiles: { default: { store: { batchSize: 0 } } } }))
    out = ''
    expect(await storeCommand(['status'])).toBe(2)
    // ④ 未知 backend → 退出码 2（验收 40 的 config.ts 校验侧）
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify(
      { profiles: { default: { store: { backend: 'oracle' } } } }))
    out = ''
    expect(await storeCommand(['status'])).toBe(2)
    expect(JSON.parse(out).error.message).toMatch(/oracle/)
    rmSync(cfgDir, { recursive: true, force: true })
  })

  it('--db 指向非 DuckDB 文件 → 1 + store_not_initialized + 原字节未动（验收 41）', async () => {
    const p = join(dir, 'notdb.bin')
    writeFileSync(p, 'THIS IS NOT A DUCKDB FILE'.repeat(100))
    const before = readFileSync(p)
    expect(await storeCommand(['init', '--db', p])).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toMatch(/换 --db|不是 DuckDB/)
    // 字节级未改动断言：init 失败不得破坏用户的既有文件
    expect(readFileSync(p).equals(before)).toBe(true)
  })

  it('--db 是符号链接 → init 拒绝（lstat，hint 逐字），status 跟随打开真实库', async () => {
    const real = join(dir, 'real.db')
    expect(await storeCommand(['init', '--db', real])).toBe(0)
    const link = join(dir, 'link.db')
    symlinkSync(real, link)
    out = ''; err = ''
    // init：拒绝（spec §7.1 步骤 2 —— 防误操作写穿链接）
    expect(await storeCommand(['init', '--db', link])).toBe(1)
    let e = JSON.parse(out).error
    expect(e.kind).toBe('store_not_initialized')
    expect(e.hint).toBe('--db 目标是符号链接，请给出真实路径')
    // status：只读跟随符号链接打开真实库（spec §7.2 无此防线）
    out = ''
    expect(await storeCommand(['status', '--db', link])).toBe(0)
    expect(data().schema_version).toBe(9)
  })

  it('父目录创建失败 → 1 + message 含路径与底层原因（验收 41，fs 注入）', async () => {
    // 父路径是一个普通文件 → mkdirSync 必失败
    const blocker = join(dir, 'blocker')
    writeFileSync(blocker, 'x')
    const p = join(blocker, 'sub', 'q.db')
    expect(await storeCommand(['init', '--db', p])).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('store_not_initialized')
    expect(e.message).toMatch(/无法创建父目录/)
    expect(e.message).toContain(p)
  })

  it('写者撞锁不重试 → 立即抛 store_locked（跨进程持真锁，spec §5.2）', { timeout: 120_000 }, async () => {
    // ⚠️ 锁只在跨进程成立（第四轮实测：同进程双开不撞锁）——spawn 子进程持锁，
    // storeCommand 的写者（init 用 rw 模式）打开 → 立即失败、不走退避。
    // status 是 ro 会真退避 30s，不能在本测试用。
    // ⚠️ 偏离声明（探针实测，三层平台竞态，brief 测试文本未覆盖）：
    // ① @duckdb/node-api 有**进程内实例缓存** —— 测试进程打开过的库再开一律
    //    命中缓存、绕过文件锁（因此不做「先 init 建库」，holder 直接对全新路径
    //    持锁，DuckDBInstance.create 会建文件）；
    // ② 子进程打印 'locked' 时锁可能尚未真正落盘（探针 12 次中 1 次）——打印
    //    信号不可信，需要独立子进程校验锁已生效；
    // ③ 极少数情况下校验 CONFLICT 后写者仍能打开（锁落盘竞态窗口）——按轮
    //    重试：每轮换全新路径，直到「校验 CONFLICT 且 init 返回 1」，最多 5 轮。
    //    锁生效是平台保证的行为（T5 duckdb.test.ts 同款用例也间歇红），重试只
    //    对冲竞态窗口，不改变被测语义。
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
    // 独立子进程校验锁（绕开进程内实例缓存）：
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
        const p = dbPath()   // 每轮换全新路径（避开本进程实例缓存）
        if (holder) holder.kill('SIGKILL')
        holder = await spawnHolder(p)
        if (await lockVerdict(p) !== 'CONFLICT') continue   // 锁未落盘，换轮
        out = ''; err = ''
        const t0 = Date.now()
        const rc = await storeCommand(['init', '--db', p])
        if (rc !== 1) continue   // 锁竞态窗口（CONFLICT 后仍打开），换轮重来
        const e = JSON.parse(out).error
        expect(e.kind).toBe('store_locked')
        expect(e.retryable).toBe(true)
        expect(Date.now() - t0).toBeLessThan(5000)   // 未走满 30s 退避（写者不重试）
        asserted = true
      }
      expect(asserted, '5 轮内未取得「锁生效且 init 撞锁返回 1」——锁落盘竞态超预期').toBe(true)
    } finally {
      holder?.kill('SIGKILL')
    }
  })

  it('query 不是可用子命令（消息含「未知子命令」）', async () => {
    expect(await storeCommand(['query', 'SELECT 1'])).toBe(2)
    expect(err).toMatch(/未知子命令/)
  })

  it('thrownToExit 的 usage 分流：kind=usage 的错误走 usageFail 双通道、退出码 2（M1）', async () => {
    // C1 运行时路径不触发 store 层 usage 错误（upsert 尚无命令入口），直接构造
    // kind:'usage' 的错误对象注入 thrownToExit —— 用 vi.doMock 替换 openStore 抛出。
    expect(await storeCommand(['init', '--db', dbPath()])).toBe(0)
    out = ''; err = ''
    vi.resetModules()
    vi.doMock('../../src/store/index.js', async (importOriginal) => {
      const orig = await importOriginal<typeof import('../../src/store/index.js')>()
      const { createDuckDbStore } = await import('../../src/store/duckdb.js')
      return {
        ...orig,
        openStore: async (cfg: unknown, mode: unknown) => {
          const s = await createDuckDbStore(cfg as never, mode as never)
          // store 层 usage 错误形态（duckdb.ts 的 usage() 构造：kind='usage' + hint）
          const e = new Error('未知表：nope')
          ;(e as { kind?: string }).kind = 'usage'
          ;(e as { hint?: string }).hint = '请检查表名'
          vi.spyOn(s as unknown as { init: () => Promise<void> }, 'init').mockRejectedValue(e)
          return s
        },
      }
    })
    const { storeCommand: mockedCommand } = await import('../../src/commands/store.js')
    try {
      expect(await mockedCommand(['init', '--db', dbPath()])).toBe(2)
      // usageFail 双通道：stderr 纯文本 + stdout JSON（code/kind=usage）
      expect(err).toMatch(/未知表/)
      const e = JSON.parse(out).error
      expect(e.code).toBe('usage')
      expect(e.kind).toBe('usage')
      expect(e.hint).toBe('请检查表名')
    } finally {
      vi.doUnmock('../../src/store/index.js')
    }
  })
})

describe('store 命令 —— 未知 profile 必须拒绝（2026-10-27 实测修）', () => {
  // ⚠️ 端到端钉住「拼错的 profile 不再静默读/建默认库」：此前
  // `store init --profile prodd` 会在 ~/.qiyu/duckdb/qiyu.duckdb 创建一个
  // 用户从未配置的库并返回 ok:true；`store status --profile prodd` 则读默认库。
  // 配置层已有单测（tests/store/config.test.ts），这里钉的是**命令出口**：
  // 退出码 2（usage：改参数重来）+ 绝不产生文件。
  const writeConfig = (): void => {
    const cfgDir = join(dir, '.config', 'qiyu')
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'config.json'), JSON.stringify({
      defaultProfile: 'prod',
      profiles: { prod: { store: { path: join(dir, 'prod.duckdb') } } },
    }))
  }

  it('store init --profile prodd → 退出码 2 + usage，且不在默认路径建库', async () => {
    writeConfig()
    expect(await storeCommand(['init', '--profile', 'prodd'])).toBe(2)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('usage')
    expect(e.message).toMatch(/没有 profile "prodd"（来自 --profile；现有：prod）/)
    expect(existsSync(join(dir, '.qiyu', 'duckdb', 'qiyu.duckdb')), '不得创建用户未配置的默认库').toBe(false)
    expect(existsSync(join(dir, 'prod.duckdb')), '也不得误建别的 profile 的库').toBe(false)
  })

  it('store status --profile prodd → 退出码 2 + usage（不再静默读默认库）', async () => {
    writeConfig()
    expect(await storeCommand(['status', '--profile', 'prodd'])).toBe(2)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('usage')
    expect(e.message).toMatch(/没有 profile "prodd"/)
  })
})
