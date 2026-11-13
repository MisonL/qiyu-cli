// tests/setup-warm.ts —— vitest `setupFiles`：每个 worker 进程**只**付一次 DuckDB 冷启动。
//
// ⚠️ 为什么需要（2026-11-13 实测）：`@duckdb/node-api` 的首次 `DuckDBInstance.create`
// 要加载原生绑定，本机负载高时实测 10–34s。原先这笔成本落在**第一个用到真库的用例**头上，
// 而它的预算是 15s → 首条用例假红（A/B 实测：旧版两次运行各超时一次，新版两次全过）。
//
// ⚠️ 为什么放在 setupFiles 而不是 `globalSetup`：实测 globalSetup 与 worker 是**两个进程**
// （pid 45930 vs 51568），预热不共享。setupFiles 在本进程内、每个测试文件前执行；
// `process` 上的标记跨模块重置存活，所以整个进程只暖一次。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FLAG = '__qiyu_duckdb_warmed__'
type Marked = typeof process & { [FLAG]?: true }

if (!(process as Marked)[FLAG]) {
  const dir = mkdtempSync(join(tmpdir(), 'qiyu-warm-'))
  try {
    const { createDuckDbStore } = await import('../src/store/duckdb.js')
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: join(dir, 'warm.db'), readOnlyRetryMs: 30_000, batchSize: 1000 }, 'rw')
    await s.init()
    await s.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  ;(process as Marked)[FLAG] = true
}
