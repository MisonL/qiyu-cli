// tests/fixtures/corrupt-db.ts —— 造一个「真实的 DuckDB 库 + 真损坏」的文件。
//
// 用途：「打开失败成因 = 已损坏」的行为用例（`store status` / `query` / `sync run`）。
// 损坏必须**真发生**（文件真被截断 / 页校验和真对不上），断言才有意义 ——
// 写一堆随机字节得到的是 `not a valid DuckDB database file`（另一个成因），不能冒充。
//
// ⚠️ 建库必须在**子进程**里做：@duckdb/node-api 有进程内实例缓存，测试进程打开过的
// 路径再开一律命中缓存、绕过真实文件读取 —— 本进程建库再截断，后续打开会读到缓存里
// 的好库，用例只会红成「损坏没有生效」或更糟：假绿。
import { spawn } from 'node:child_process'
import { closeSync, ftruncateSync, openSync, statSync, writeFileSync, writeSync } from 'node:fs'
import { join } from 'node:path'

const PKG_URL = new URL('../../node_modules/@duckdb/node-api/lib/index.js', import.meta.url)

/** 子进程建一个带数据的库（写入足够行数，保证文件远大于头部 + 元数据）。 */
async function seedDb(dir: string, dbPath: string): Promise<void> {
  const script = join(dir, 'corrupt-seed.mjs')
  writeFileSync(script, `
    const { DuckDBInstance } = await import(${JSON.stringify(PKG_URL.href)})
    const inst = await DuckDBInstance.create(${JSON.stringify(dbPath)})
    const c = await inst.connect()
    await c.run('CREATE TABLE t (id INTEGER, payload VARCHAR)')
    await c.run("INSERT INTO t SELECT i, repeat('x', 100) FROM range(2000) tbl(i)")
    inst.closeSync()
  `)
  await new Promise<void>((resolve, reject) => {
    const ch = spawn(process.execPath, [script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let e = ''
    ch.stderr?.on('data', (d) => { e += String(d) })
    ch.on('close', (code) => { code === 0 ? resolve() : reject(new Error(`种子失败：${e.slice(0, 300)}`)) })
  })
}

/**
 * 返回一个已损坏的 DuckDB 库路径。
 * `kind: 'truncated'` —— 文件截半（报 `Could not read enough bytes from file`）；
 * `kind: 'checksum'`  —— 第 8192 字节起 4KB 清零（报 `Corrupt database file: computed checksum …`）。
 */
export async function makeCorruptDb(
  dir: string,
  kind: 'truncated' | 'checksum',
  name = `corrupt-${kind}.db`,
): Promise<string> {
  const dbPath = join(dir, name)
  await seedDb(dir, dbPath)
  if (kind === 'truncated') {
    const half = Math.floor(statSync(dbPath).size / 2)
    const fd = openSync(dbPath, 'r+')
    try { ftruncateSync(fd, half) } finally { closeSync(fd) }
  } else {
    const fd = openSync(dbPath, 'r+')
    try { writeSync(fd, Buffer.alloc(4096), 0, 4096, 8192) } finally { closeSync(fd) }
  }
  return dbPath
}
