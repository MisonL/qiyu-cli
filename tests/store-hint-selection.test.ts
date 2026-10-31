// tests/store-hint-selection.test.ts —— 恢复命令必须指向**本次使用的库**（2026-10-30）。
//
// 背景（真库实测，PR #44 CodeRabbit major 的推广）：hint 里写「请先运行：qiyu store init」
// 时，若本次是用 `--db`/`--profile`/环境变量选了非默认库，逐字执行会作用在**默认库**上：
//   · `db describe tickets --db <空库>` → 照 hint 跑 `qiyu store init` → 建出
//     ~/.qiyu/duckdb/qiyu.duckdb，原命令再跑仍报同一句（死循环，实测）；
//   · `sync install --db <未同步库>` → 照 hint 跑 `qiyu sync run` → 同步默认库，
//     install 仍报 sync_not_run。
// 修法：点名的命令一律经 `storeInitCommand` / `syncRunCommand`（output.ts 唯一实现）
// 渲染成带 `--db <本次解析出的绝对路径>` 的完整命令。
//
// 本文件两层守卫：
//   ① 行为层（真 DuckDB）：非默认 --db 上触发每一类 hint，断言恢复命令带本次路径；
//      空库/缺库两类端到端验证「照 hint 做 → 原命令收敛、默认库不被创建」；
//   ② 漂移层（源码文本）：恢复命令 hint 不得再以裸命令出现（必须经共享渲染），
//      附自检（事故原文必须红、修复后的拼接形态必须放过）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dbCommand } from '../src/commands/db.js'
import { queryCommand } from '../src/commands/query.js'
import { statsCommand } from '../src/commands/stats.js'
import { storeCommand } from '../src/commands/store.js'
import { syncCommand } from '../src/commands/sync.js'
import { storeInitCommand, syncRunCommand, shellArg } from '../src/output.js'
import {
  dbTablesCommand, dbDescribeCommand, syncStatusCommand, queryTableCommand, querySqlCommand,
} from '../src/output.js'
import { createDuckDbStore } from '../src/store/duckdb.js'
import { markPending } from '../src/sync/state.js'

// DuckDB 冷启动偶发 >5s（与 tests/commands/db.test.ts 同款放宽）。
// 2026-10-30：本文件现在每个用例要连开多个库（init → 写 → 读），机器高负载下
// 实测单例 >15s，放宽到 30s；CI（空闲 runner）通常 2–8s。
vi.setConfig({ testTimeout: 30_000 })

let dir = ''
let out = ''
const dbPath = (name = 'q.db'): string => join(dir, name)
const defaultDbPath = (): string => join(dir, '.qiyu', 'duckdb', 'qiyu.duckdb')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-hint-'))
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('HOME', dir)   // 隔离真实 ~（配置文件与默认库路径都走 HOME）
  vi.stubEnv('USERPROFILE', dir)
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const meta = (): Record<string, unknown> => JSON.parse(out).meta
const errorOf = (): Record<string, unknown> => JSON.parse(out).error

/** 建一个合法的空 DuckDB 文件（零表）。 */
async function emptyDb(path: string): Promise<void> {
  const mod = (await import('@duckdb/node-api')) as unknown as {
    DuckDBInstance: { create: (p: string, o?: unknown) => Promise<{ closeSync: () => void }> }
  }
  ;(await mod.DuckDBInstance.create(path)).closeSync()
}

describe('恢复命令指向本次的库（真 DuckDB）', () => {
  it('空库：六个出口的 store init hint 都带 --db <本次路径>，照做后原命令收敛', async () => {
    const empty = dbPath('empty.db')
    await emptyDb(empty)

    // 六个出口：E 族四命令 + sync status + store status（全部经 statGuard/openGuardedSession/openRo）
    const cases: Array<[string, () => Promise<number>]> = [
      ['db tables', () => dbCommand(['tables', '--db', empty])],
      ['db describe', () => dbCommand(['describe', 'tickets', '--db', empty])],
      ['query --table', () => queryCommand(['--table', 'sessions', '--db', empty])],
      ['stats fields', () => statsCommand(['fields', 'daily_overview', '--db', empty])],
      ['sync status', () => syncCommand(['status', '--db', empty])],
      ['store status', () => storeCommand(['status', '--db', empty])],
    ]
    for (const [name, run] of cases) {
      out = ''
      expect(await run(), name).toBe(1)
      const e = errorOf()
      expect(e.kind, name).toBe('store_not_initialized')
      // 恢复命令必须带本次解析出的绝对路径（不是默认库、不是裸命令）
      expect(String(e.hint), name).toContain(storeInitCommand(empty))
      expect(String(e.hint), name).toContain('--db ' + empty)
    }

    // 照 hint 的命令执行（同一 argv 形态）→ 原命令全部收敛，默认库不被创建
    out = ''
    expect(await storeCommand(['init', '--db', empty])).toBe(0)
    expect(existsSync(defaultDbPath())).toBe(false)
    for (const [name, run] of cases) {
      out = ''
      expect(await run(), name).toBe(0)
    }
  })

  it('缺库（文件不存在）：hint 带本次 --db；照做建在指定路径，默认库不被创建', async () => {
    const missing = dbPath('missing.duckdb')

    out = ''
    expect(await dbCommand(['tables', '--db', missing])).toBe(1)
    expect(String(errorOf().hint)).toContain(storeInitCommand(missing))

    out = ''
    expect(await storeCommand(['init', '--db', missing])).toBe(0)
    expect(existsSync(missing)).toBe(true)
    // 关键回归：裸 `qiyu store init` 会在默认路径建库，把 Agent 送进死循环
    expect(existsSync(defaultDbPath())).toBe(false)

    out = ''
    expect(await dbCommand(['tables', '--db', missing])).toBe(0)
  })

  it('空表：query --table / stats fields 的「先运行 sync run」建议带 --db <本次路径>', async () => {
    const db = dbPath('s.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', db])).toBe(0)

    out = ''
    expect(await queryCommand(['--table', 'sessions', '--db', db])).toBe(0)
    const w1 = (meta().warnings ?? []) as string[]
    expect(w1.some((x) => x.includes(syncRunCommand(db))), w1.join('\n')).toBe(true)
    // 独立于共享渲染器的字面断言：helper 自身漏掉 --db 时这里也会红
    expect(w1.some((x) => x.includes('--db ' + db)), w1.join('\n')).toBe(true)

    out = ''
    expect(await statsCommand(['fields', 'daily_overview', '--db', db])).toBe(0)
    const w2 = (meta().warnings ?? []) as string[]
    expect(w2.some((x) => x.includes(syncRunCommand(db))), w2.join('\n')).toBe(true)
    expect(w2.some((x) => x.includes('--db ' + db)), w2.join('\n')).toBe(true)
  })

  it('只读诊断 hint 带本次 --db（#45 边界 ②）：未知表/未知列/敏感分组/0 行/脱敏建议/iso-day', async () => {
    // 读错库与写错库同样误导：`query --table sessions --db <非默认库>` 报「未知表」时
    // 照裸 `qiyu db tables` 执行会去列**默认库**，Agent 据此断定「表真的不存在」。
    const db = dbPath('diag.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', db])).toBe(0)
    const loc = { db }

    // ① 未知表（--sql 通道；无候选 → 落到 db tables）
    out = ''
    expect(await queryCommand(['--sql', 'SELECT * FROM no_such_table', '--db', db])).toBe(2)
    expect(String(errorOf().hint), '未知表').toContain(dbTablesCommand(loc))
    // 独立于渲染器的字面断言：渲染器漏 --db 时这里也会红
    expect(String(errorOf().hint), '未知表').toContain('--db ' + db)

    // ② 未知列 → db describe（列名来自全部表，定位不到表 → 占位符 <表>）
    out = ''
    expect(await queryCommand(['--sql', 'SELECT no_such_column FROM sessions', '--db', db])).toBe(2)
    expect(String(errorOf().hint), '未知列').toContain(dbDescribeCommand('<表>', loc))

    // ③ --group-by 敏感列 → query --sql --no-mask
    out = ''
    expect(await queryCommand(['--table', 'sessions', '--group-by', 'userPhone', '--db', db])).toBe(2)
    // usageFail 把整句放进 message（hint 字段为空）：断言 message 里的建议命令
    expect(String(errorOf().message), '敏感分组').toContain(querySqlCommand(loc) + ' --no-mask')

    // ④ 0 行 + 引用了业务时间列 → sync status
    out = ''
    expect(await queryCommand(
      ['--sql', 'SELECT * FROM sessions WHERE startTime IS NOT NULL', '--db', db])).toBe(0)
    const w = (meta().warnings ?? []) as string[]
    expect(w.some((x) => x.includes(syncStatusCommand(loc))), w.join('\n')).toBe(true)

    // ⑤ --sql 引用了敏感列但输出列名不匹配 → 脱敏建议（mask.ts 线程）
    out = ''
    expect(await queryCommand(['--sql', 'SELECT userPhone AS p FROM sessions', '--db', db])).toBe(0)
    const mw = (meta().mask_warnings ?? []) as string[]
    expect(mw.some((x) => x.includes(queryTableCommand('<表>', loc))), mw.join('\n')).toBe(true)

    // ⑥ iso-day 列 + 日期字面量 → query --table --since/--until
    out = ''
    expect(await queryCommand(
      ['--sql', "SELECT * FROM daily_overview WHERE stat_date >= '2026-10-13'", '--db', db])).toBe(0)
    const w2 = (meta().warnings ?? []) as string[]
    expect(w2.some((x) => x.includes(queryTableCommand('<表>', loc) + ' --since/--until')),
      w2.join('\n')).toBe(true)

    // ⑦ --table 通道的 0 行警告（另一处调用点，与 ④ 的 --sql 通道分开覆盖）
    out = ''
    expect(await queryCommand(['--table', 'sessions', '--since', '7d', '--db', db])).toBe(0)
    const w3 = (meta().warnings ?? []) as string[]
    expect(w3.some((x) => x.includes(syncStatusCommand(loc))), w3.join('\n')).toBe(true)

    // ⑨ 闭集校验先于 I/O 的三条（尚未解析 → 复现用户原始 flag）
    out = ''
    expect(await queryCommand(['--table', 'no_such_table', '--db', db])).toBe(2)
    expect(String(errorOf().hint), 'query 未知表').toContain(dbTablesCommand({ db }))
    out = ''
    expect(await dbCommand(['describe', 'no_such_table', '--db', db])).toBe(2)
    expect(String(errorOf().hint), 'db describe 未知表').toContain(dbTablesCommand({ db }))
    out = ''
    expect(await statsCommand(['fields', 'no_such_table', '--db', db])).toBe(2)
    expect(String(errorOf().hint), 'stats 未知表').toContain(dbTablesCommand({ db }))

    // ⑧ 截断警告（--sql 通道）→ db describe
    out = ''
    expect(await queryCommand(
      ['--sql', 'SELECT * FROM range(10)', '--limit', '3', '--db', db])).toBe(0)
    expect(meta().truncated).toBe(true)
    const w4 = (meta().warnings ?? []) as string[]
    expect(w4.some((x) => x.includes('qiyu db describe <表> --db ' + db)), w4.join('\n')).toBe(true)
  })

  it('mask --table 的漂移列警告（db describe）也带本次 --db', async () => {
    // 库里多出表定义之外的列时，mask.ts 警告 Agent 去 db describe 核对 ——
    // 这条 hint 同样必须指回本次的库（#45 边界 ②）。
    const db = dbPath('drift.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', db])).toBe(0)
    const mod = (await import('@duckdb/node-api')) as unknown as {
      DuckDBInstance: { create: (p: string) => Promise<{
        connect: () => Promise<{ run: (q: string) => Promise<unknown>; closeSync?: () => void }>
        closeSync: () => void
      }> }
    }
    const inst = await mod.DuckDBInstance.create(db)
    const conn = await inst.connect()
    try { await conn.run('ALTER TABLE sessions ADD COLUMN leaked_extra VARCHAR') } finally {
      conn.closeSync?.(); inst.closeSync()
    }

    out = ''
    expect(await queryCommand(['--table', 'sessions', '--db', db])).toBe(0)
    const mw = (meta().mask_warnings ?? []) as string[]
    expect(mw.some((x) => x.includes(dbDescribeCommand('sessions', { db }))), mw.join('\n')).toBe(true)
  })

  it('sandbox 打开失败 / 脏时间值 / 坏 payload 的 hint 也带本次 --db', async () => {
    const mod = (await import('@duckdb/node-api')) as unknown as {
      DuckDBInstance: { create: (p: string) => Promise<{
        connect: () => Promise<{ run: (q: string) => Promise<unknown>; closeSync?: () => void }>
        closeSync: () => void
      }> }
    }
    const exec = async (path: string, sql: string): Promise<void> => {
      const inst = await mod.DuckDBInstance.create(path)
      const conn = await inst.connect()
      try { await conn.run(sql) } finally { conn.closeSync?.(); inst.closeSync() }
    }

    // ① 不是 DuckDB 文件 → sandbox 的「该路径已存在且不是 DuckDB 数据库，请换 --db 路径」hint
    //    ⚠️ 2026-10-31：成因分流收敛到 `store/retry.ts` 的 `classifyOpenFailure` 后，
    //    「不是 DuckDB 文件」的 hint 与 `store status` 同口径（换 --db 路径），不再给
    //    「请确认…由本 CLI 创建（store init）」—— 后者会引导 Agent 往一个非 DuckDB 文件上
    //    跑 `store init`（store init 也会拒绝它，是死路）。判据与三处共用见那三个文件的注释。
    const bogus = dbPath('not-a-db.duckdb')
    writeFileSync(bogus, 'this is not duckdb')
    out = ''
    expect(await dbCommand(['tables', '--db', bogus])).toBe(1)
    expect(String(errorOf().hint), '打开失败').toContain('该路径已存在且不是 DuckDB 数据库')
    expect(String(errorOf().hint), '不得再引导向 store init（对非 DuckDB 文件是死路）').not.toContain('store init')

    // ② 脏时间值 → db tables 的 query --sql 建议
    const dirty = dbPath('dirty.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', dirty])).toBe(0)
    await exec(dirty, "INSERT INTO sessions (session_id, startTime) VALUES ('s1', 'not-a-time')")
    out = ''
    expect(await dbCommand(['tables', '--db', dirty])).toBe(0)
    const w = (meta().warnings ?? []) as string[]
    expect(w.some((x) => x.includes(querySqlCommand({ db: dirty }))), w.join('\n')).toBe(true)

    // ③ 坏 payload → stats fields 的 query --sql 建议
    const bad = dbPath('bad.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', bad])).toBe(0)
    await exec(bad, "INSERT INTO daily_overview (stat_date, payload) VALUES ('2026-10-01', 'not-json')")
    out = ''
    expect(await statsCommand(['fields', 'daily_overview', '--db', bad])).toBe(0)
    const w2 = (meta().warnings ?? []) as string[]
    expect(w2.some((x) => x.includes(querySqlCommand({ db: bad }))), w2.join('\n')).toBe(true)
  })

  it('渲染出的诊断命令真的能跑：占位符替换后逐条执行不得报「缺少取值」', async () => {
    // ⚠️ 这是 CodeRabbit 2026-10-30 minor 的回归守卫：`querySqlCommand` 曾渲染成
    // `qiyu query --sql --db <path>` —— `--db` 落在 `--sql` 的值位上，逐字执行报
    // 「--sql 缺少取值」退出 2。**hint 里的命令必须真的能跑**，而不只是「带上了 --db」。
    //
    // 契约是「替换占位符后能跑」（`<表>` 与 `<SQL>` 都是占位符，全仓同一约定）：
    //   · `<表>` 不用引号 —— 表名不含空白，替换后天然是一个参数；
    //   · `<SQL>` **必须引号** —— SQL 含空格，`--sql SELECT 1` 会被 shell 拆成两个参数
    //     （`1` 成为位置参数 → 未知参数退出 2），`<`/`>` 不带引号还会变成重定向。
    const db = dbPath('runnable.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', db])).toBe(0)
    const loc = { db }
    // 按 shell 分词（单引号段视为一个词，含 shellArg 的 `'\''` 字面量引号形态）：
    // 只有真的按 shell 语义切分，才能证明「照 hint 粘进 shell 能跑」。
    const split = (cmd: string): string[] => {
      const out: string[] = []
      let cur = ''
      let i = 0
      while (i < cmd.length) {
        const c = cmd[i]!
        if (c === ' ') { if (cur !== '') { out.push(cur); cur = '' }; i++; continue }
        if (c === "'") {
          i++
          while (i < cmd.length) {
            if (cmd[i] === "'") {
              if (cmd.startsWith("'\\''", i)) { cur += "'"; i += 4; continue }
              i++; break
            }
            cur += cmd[i]; i++
          }
          continue
        }
        cur += c; i++
      }
      if (cur !== '') out.push(cur)
      return out
    }
    const run = async (cmd: string): Promise<number> => {
      const argv = split(cmd).slice(1) // 去掉 `qiyu`
      out = ''
      if (argv[0] === 'db') return dbCommand(argv.slice(1))
      if (argv[0] === 'stats') return statsCommand(argv.slice(1))
      if (argv[0] === 'sync') return syncCommand(argv.slice(1))
      return queryCommand(argv.slice(1))
    }
    // ⚠️ `<SQL>` 的替换契约是**整段（含引号）**替换（CodeRabbit 2026-10-30 major）：
    // 只换引号里的那个词而保留引号时，SQL 自带单引号会把引号提前闭合 ——
    // `--sql 'SELECT '2026-10-01''` 经 shell 解析后变成 `SELECT 2026-10-01`
    //（DuckDB 会把它算成 2015，静默给错结果）。所以这里按契约用 shellArg 整体替换，
    // 并故意用带单引号的 SQL 来复现那种失败形态。
    const sql = "SELECT '2026-10-01' AS d"
    const commands = [
      dbTablesCommand(loc), dbDescribeCommand('<表>', loc), syncStatusCommand(loc),
      queryTableCommand('<表>', loc), querySqlCommand(loc),
      // 敏感列分组建议的完整形态：`--no-mask` 必须排在值位之后（同一处 minor）
      querySqlCommand(loc) + ' --no-mask',
    ].map((c) => c.split("'<SQL>'").join(shellArg(sql)))
    for (const raw of commands) {
      const cmd = raw.split('<表>').join('sessions')
      const code = await run(cmd)
      // 只要不是 2（用法错误）就说明命令形态本身是合法的：数据/覆盖问题不是本用例的目标
      expect(code, `命令不可执行：${cmd}`).not.toBe(2)
      const err = JSON.parse(out).error as { message?: string } | undefined
      expect(String(err?.message ?? ''), cmd).not.toContain('缺少取值')
    }
  })

  it('路径含空白 / shell 元字符 → 恢复命令用单引号包裹（复制进 shell 不注入）', async () => {
    // 空目录里放一个空库；路径同时含空格与 `; touch` 注入载荷
    const weird = join(dir, 'a b; touch PWNED; #.duckdb')
    await emptyDb(weird)

    out = ''
    expect(await dbCommand(['tables', '--db', weird])).toBe(1)
    const hint = String(errorOf().hint)
    // 单引号包裹后是**一个**参数：`; touch` 不会被 shell 拆成命令
    expect(hint).toContain("--db '" + weird + "'")
    expect(hint).toContain(storeInitCommand(weird))
    // shellArg 自检：安全集内裸渲染、含单引号按 POSIX 方言转义
    expect(storeInitCommand('/tmp/q.db')).toContain('--db /tmp/q.db')
    expect(shellArg("/tmp/it's q.db", 'darwin')).toBe("'/tmp/it'\\''s q.db'")
  })

  it('win32 用 PowerShell 方言（单引号翻倍）—— POSIX 写法在 pwsh 里会真的执行注入载荷', () => {
    // 2026-10-30 实测（pwsh 在 PATH 上）：同一份载荷
    //   POSIX 方言 '/tmp/x'''; touch /tmp/pwned; #''''  → pwsh argc=3，注入**执行**
    //   PowerShell 方言 '/tmp/x''; touch /tmp/pwned; #'''  → pwsh argc=2、参数字面完整、未执行
    const payload = "/tmp/x'; touch /tmp/pwned2; #'"
    expect(shellArg(payload, 'darwin')).toBe("'/tmp/x'\\''; touch /tmp/pwned2; #'\\'''")
    expect(shellArg(payload, 'win32')).toBe("'/tmp/x''; touch /tmp/pwned2; #'''")
    // PowerShell 还把 4 个弯引号当单引号定界符（pwsh 实测：只翻倍 ASCII ' 会漏）
    for (const q of ['\u2018', '\u2019', '\u201A', '\u201B']) {
      const v = `/tmp/a${q}; touch /tmp/pwned3; #`
      expect(shellArg(v, 'win32'), q).toBe(`'/tmp/a${q}${q}; touch /tmp/pwned3; #'`)
      // POSIX 侧它们只是普通字符（不是定界符），仍按 ' 处理——这里没有 ASCII '，故无转义
      expect(shellArg(v, 'darwin'), q).toBe(`'/tmp/a${q}; touch /tmp/pwned3; #'`)
    }
    // win32 的安全集更窄：裸 `a,b` 在 PowerShell 里是 Object[]、前导 @ 是 splatting、% 是别名
    expect(shellArg('a,b', 'win32')).toBe("'a,b'")
    expect(shellArg('a,b', 'darwin')).toBe('a,b')
    expect(shellArg('@x', 'win32')).toBe("'@x'")
    expect(shellArg('%x', 'win32')).toBe("'%x'")
    expect(shellArg('@x', 'darwin')).toBe('@x')
    // 两种方言都必须包在一个单引号串里（无双引号、无未转义的顶层引号）
    for (const p of ['darwin', 'win32']) {
      const out = shellArg(payload, p)
      expect(out.startsWith("'") && out.endsWith("'"), p).toBe(true)
    }
    // shellArg 是可注入平台的纯函数，与命令渲染器共用同一实现
    expect(storeInitCommand('/tmp/q.db')).toBe('qiyu store init --db /tmp/q.db')
  })

  it('--profile 选中的档名随恢复命令回显（sync run 的 robotId 注入面按档读）', async () => {
    // 非默认档 alpha：store.options.knowledgeRobotIds 与 robots 只在 alpha 下可见
    mkdirSync(join(dir, '.config', 'qiyu'), { recursive: true, mode: 0o700 })
    const cfg = join(dir, '.config', 'qiyu', 'config.json')
    writeFileSync(cfg, JSON.stringify({
      profiles: { alpha: { robots: { 2000002: 'B' }, store: { options: { knowledgeRobotIds: [1000001] } } } },
    }))
    const db = dbPath('pf.duckdb')
    out = ''
    expect(await storeCommand(['init', '--profile', 'alpha', '--db', db])).toBe(0)

    // sync install 的 sync_not_run hint：必须回显 --profile alpha
    out = ''
    expect(await syncCommand(['install', '--schedule', '0 2 * * *', '--profile', 'alpha', '--db', db])).toBe(1)
    const hint = String(errorOf().hint)
    expect(hint).toContain(syncRunCommand(db, 'alpha'))
    expect(hint).toContain('--profile alpha')

    // 空表 warning 同源
    out = ''
    expect(await queryCommand(['--table', 'sessions', '--profile', 'alpha', '--db', db])).toBe(0)
    const w = (meta().warnings ?? []) as string[]
    expect(w.some((x) => x.includes('--profile alpha')), w.join('\n')).toBe(true)

    // 反向：未点名档（无 flag/env/defaultProfile）→ 不回显内置 default
    //（显式 --profile default 会触发「点名档必须存在」守卫，profiles 非空且无 default 时反而失败）
    out = ''
    expect(await syncCommand(['install', '--schedule', '0 2 * * *', '--db', db])).toBe(1)
    expect(String(errorOf().hint)).not.toContain('--profile')
  })

  it('sync verify 的 state_pending detail 也带 --db（重跑建议同样不能打偏库）', async () => {
    const db = dbPath('p.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', db])).toBe(0)
    // 预置一行 pending（引擎「开跑先置 pending」的落库形态）→ verify 出 state_pending
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: db, readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
    try {
      await s.transaction(async (tx) => { await markPending(tx, 'reports.overview') })
    } finally { await s.close() }

    out = ''
    expect(await syncCommand(['verify', 'reports.overview', '--db', db])).toBe(1)
    const tasks = (JSON.parse(out).data as {
      tasks: Array<{ drift: Array<{ kind: string; detail: string }> }>
    }).tasks
    const drift = tasks[0]!.drift.find((d) => d.kind === 'state_pending')
    expect(drift, JSON.stringify(tasks)).toBeDefined()
    expect(drift!.detail).toContain(syncRunCommand(db))
    expect(drift!.detail).toContain('--db ' + db)
  })

  it('sync install 的 sync_not_run hint 与 sync verify 的 not_synced detail 都带 --db', async () => {
    const db = dbPath('i.duckdb')
    out = ''
    expect(await storeCommand(['init', '--db', db])).toBe(0)

    // install 前置探测：从未成功同步 → hint 必须指向本次的库
    out = ''
    expect(await syncCommand(['install', '--schedule', '0 2 * * *', '--db', db])).toBe(1)
    const e = errorOf()
    expect(e.kind).toBe('sync_not_run')
    expect(String(e.hint)).toContain(syncRunCommand(db))
    expect(String(e.hint)).toContain('--db ' + db)

    // verify（windowed 任务不请求上游）：drift.not_synced 的 detail 同样指向本次的库
    out = ''
    expect(await syncCommand(['verify', 'reports.overview', '--db', db])).toBe(1)
    const tasks = (JSON.parse(out).data as {
      tasks: Array<{ drift: Array<{ kind: string; detail: string }> }>
    }).tasks
    const drift = tasks[0]!.drift.find((d) => d.kind === 'not_synced')
    expect(drift, JSON.stringify(tasks)).toBeDefined()
    expect(drift!.detail).toContain(syncRunCommand(db))
    expect(drift!.detail).toContain('--db ' + db)
  })
})

describe('恢复命令的漂移守卫（源码文本）', () => {
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
  const SRC = join(ROOT, 'src')
  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n)
      return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
    })
  /** 抹掉行首整行注释与块注释行（与 `empty-string-single-source.test.ts` 同一约定）。 */
  const stripCommentLines = (text: string): string =>
    text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')

  /**
   * 裸恢复命令 hint 的指纹：动词短语后紧跟命令名，中间只允许冒号/空白/反引号。
   * 经共享渲染的正确形态是 `'…请先运行：' + storeInitCommand(path)` —— 冒号后是引号，
   * 不会命中。
   */
  const BARE_HINT = /(?:运行|重跑|先跑通一次同步)[：:]?\s*`?qiyu (?:store init|sync run)/

  /**
   * 裸**只读诊断**命令的指纹（#45 边界 ②，2026-10-30）：反引号里是一个完整、闭合的
   * `qiyu db tables` / `db describe` / `sync status` / `query --table` / `query --sql`。
   * 经共享渲染的正确形态是 ``'用 `' + dbTablesCommand(loc) + '` 查看'`` —— 反引号后紧跟
   * 引号，不命中；而事故原文 `` '用 `qiyu db tables` 查看可用表' `` 必中。
   */
  const BARE_DIAG_HINT =
    /`qiyu (?:db tables|db describe|sync status|query --table|query --sql)[^'`\n]*`/

  /**
   * 两个合法例外（都有可证伪的理由，不是「先放过」）：
   *   · `output.ts` 是**唯一实现点**——`dbTablesCommand` 等渲染器本身的模板串就长这样；
   *   · `api call` 不吃 `--db`/`--profile`（下方自检钉着），限流建议里的裸命令与
   *     探测读的是同一份配置/环境解析结果，没有「本次选择」可复现。
   */
  const BARE_DIAG_ALLOW: ReadonlyMap<string, string> = new Map([
    ['output.ts', '诊断命令渲染器本身（唯一实现点）'],
    [join('commands', 'api.ts'), 'api call 不吃 --db/--profile，裸命令即本次解析结果'],
  ])

  it('源码里不得再出现裸的只读诊断命令（必须经 dbTablesCommand 等渲染器）', () => {
    const offenders: string[] = []
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f)
      if (BARE_DIAG_ALLOW.has(rel)) continue
      const code = stripCommentLines(readFileSync(f, 'utf8'))
      if (BARE_DIAG_HINT.test(code)) offenders.push(rel)
    }
    expect(offenders).toEqual([])
  })

  it('凡渲染 querySqlCommand 的文件，必须同时带上占位符替换契约', () => {
    // 占位符在引号里：不带契约时用户可能只替换引号内的词，SQL 自带单引号会提前闭合
    // 引号（CodeRabbit 2026-10-30 major）—— `--sql 'SELECT '2026-10-01''` 静默变成
    // `SELECT 2026-10-01`。渲染器没法替用户转义，只能把契约写在 hint 里；这条守卫保证
    // 新增的调用点不会漏掉它。
    const missing: string[] = []
    for (const f of walk(SRC)) {
      const rel = relative(SRC, f)
      if (rel === 'output.ts') continue // 渲染器与契约常量的定义处
      // ⚠️ 必须连 import 行一起剥掉：`import { querySqlCommand, SQL_ARG_REPLACE_NOTE }`
      // 单独就能让「含该标识符」成立，守卫会变成假绿（实测：只删用法、留着 import 时
      // 该用例仍通过）。剥掉后剩下的只有真正的使用点。
      const code = stripCommentLines(readFileSync(f, 'utf8'))
        .split('\n').filter((l) => !/^\s*import\b/.test(l)).join('\n')
      if (code.includes('querySqlCommand(') && !code.includes('SQL_ARG_REPLACE_NOTE')) {
        missing.push(rel)
      }
    }
    expect(missing).toEqual([])
    // 双向自检：事故形态必红、修复形态放过（判据与上面逐字同款，防止守卫本身写歪）
    const flagged = (code: string): boolean =>
      code.includes('querySqlCommand(') && !code.includes('SQL_ARG_REPLACE_NOTE')
    expect(flagged("+ '` 单独查看它们以确认成因')")).toBe(false) // 无 querySqlCommand → 不适用
    expect(flagged(
      "'用 `' + querySqlCommand(loc) + '` 单独查看它们以确认成因')")).toBe(true)
    expect(flagged(
      "'用 `' + querySqlCommand(loc) + '` 单独查看（' + SQL_ARG_REPLACE_NOTE + '）')")).toBe(false)
  })

  it('自检：只读诊断的裸形态必红、经渲染的拼接形态放过', () => {
    const incidents = [
      "hint: candidates.length > 0 ? candidateHint(candidates) : '用 `qiyu db tables` 查看可用表',",
      "'请用 `qiyu db describe <表>` 看总行数与时间范围，或加过滤条件'",
      "warnings.push(`查询返回 0 行…用 `qiyu sync status` 查看覆盖范围`)",
      "'或改用 `qiyu query --table <表> --since/--until`（该通道已处理取整语义）'",
      "'用 `qiyu query --sql` 单独查看它们以确认成因'",
    ]
    for (const t of incidents) expect(BARE_DIAG_HINT.test(t), t).toBe(true)
    const fixed = [
      "'用 `' + dbTablesCommand(loc) + '` 查看可用表'",
      "'请用 `' + dbDescribeCommand('<表>', loc) + '` 看总行数与时间范围'",
      "'用 `' + syncStatusCommand(loc) + '` 查看覆盖范围'",
      "'或改用 `' + queryTableCommand('<表>', loc) + ' --since/--until`'",
      "'用 `' + querySqlCommand(loc) + '` 单独查看它们以确认成因'",
    ]
    for (const t of fixed) expect(BARE_DIAG_HINT.test(t), t).toBe(false)
    // 豁免理由必须持续成立：api 侧一吃上 --db/--profile，这条就红，逼着把 hint 线程化
    const apiSrc = readFileSync(join(SRC, 'commands', 'api.ts'), 'utf8')
    expect(apiSrc).not.toMatch(/'--db'|'--profile'/)
  })

  it('源码里不得再出现裸的恢复命令 hint（必须经 storeInitCommand/syncRunCommand 渲染）', () => {
    const offenders: string[] = []
    for (const f of walk(SRC)) {
      const code = stripCommentLines(readFileSync(f, 'utf8'))
      if (BARE_HINT.test(code)) offenders.push(relative(SRC, f))
    }
    expect(offenders).toEqual([])
  })

  it('自检：事故原文必须命中，修复后的拼接形态必须放过', () => {
    // 修复前四处真实文案（原样）
    const incidents = [
      "hint: '数据库尚未初始化。请先运行：qiyu store init',",
      "detail: 'sync_state 无该任务记录（从未同步）。请先运行：qiyu sync run',",
      "warnings.push('该表无数据；先运行 `qiyu sync run`')",
      "hint: '安装调度前请先跑通一次同步：qiyu sync run',",
      "'…一致性——重跑 qiyu sync run 补全后再 verify。'",
    ]
    for (const t of incidents) expect(BARE_HINT.test(t), t).toBe(true)
    // 修复后的形态（共享渲染）必须放过
    const fixed = [
      "hint: '数据库尚未初始化。请先运行：' + storeInitCommand(path),",
      "warnings.push('该表无数据；先运行 `' + syncRunCommand(input.dbPath) + '`')",
      "'…一致性——重跑 ' + syncRunCommand(resolved.path) + ' 补全后再 verify。'",
      "'若为建库未完成（迁移未跑完），运行 ' + storeInitCommand(path) + ' 可补建缺失的迁移；'",
    ]
    for (const t of fixed) expect(BARE_HINT.test(t), t).toBe(false)
  })
})
