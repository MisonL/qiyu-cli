// tests/setup-warm.ts —— vitest `setupFiles`：每个 worker 进程**只**付一次 DuckDB 冷启动。
//
// ⚠️ 为什么需要（2026-11-13 实测）：`@duckdb/node-api` 的首次 `DuckDBInstance.create`
// 要加载原生绑定，本机负载高时实测 10–34s。原先这笔成本落在**第一个用到真库的用例**头上，
// 而它的预算是 15s → 首条用例假红（A/B 实测：旧版两次运行各超时一次，新版两次全过）。
//
// ⚠️ 为什么放在 setupFiles 而不是 `globalSetup`：实测 globalSetup 与 worker 是**两个进程**
// （pid 45930 vs 51568），预热不共享。setupFiles 在本进程内、每个测试文件前执行；
// `process` 上的标记跨模块重置存活，所以整个进程只暖一次。
//
// ⚠️ 关于「setup 先加载过 `store/duckdb` 会不会让测试文件里的 `vi.mock` 失效」
// （CodeRabbit 2026-11-14 major）：**实测不会**。探针用 `vi.mock('../src/store/duckdb.js',
// () => ({ createDuckDbStore: () => 'MOCKED' }))` 打桩后动态 import，拿到的就是 `MOCKED`
// （vitest 按测试文件建独立模块图，mock 注册后该文件内的 import 走替身）。
// 仓库里唯一按模块打桩的 `store.test.ts` 走 `vi.doMock` + `vi.resetModules()`，与预热无关
// （它自己已把「doMock 不生效」这个坑记在注释里）。若将来有人在这里加**副作用**
// （写文件、改全局），要重新评估：预热跑在每个测试文件之前。

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const FLAG = '__qiyu_duckdb_warmed__'
type Marked = typeof process & { [FLAG]?: true }

if (!(process as Marked)[FLAG]) {
  const dir = mkdtempSync(join(tmpdir(), 'qiyu-warm-'))
  try {
    // 探针缝：`tests/setup-warm.test.ts` 在**子进程**里设这个环境变量，用来验证
    // 「预热抛错不影响测试」。子进程与父进程不共享 `process`，所以经环境变量传代码串。
    if (process.env.QIYU_WARM_FAIL_INJECT) throw new Function(`return (${process.env.QIYU_WARM_FAIL_INJECT})`)()
    const { createDuckDbStore } = await import('../src/store/duckdb.js')
    const s = await createDuckDbStore(
      { backend: 'duckdb', path: join(dir, 'warm.db'), readOnlyRetryMs: 30_000, batchSize: 1000 }, 'rw')
    await s.init()
    await s.close()
  } catch (e) {
    // ⚠️ **绝不能**让预热失败拖垮整个测试收集（Codex 2026-11-14 P2）：`@duckdb/node-api` 是
    // optionalDependencies，缺原生 binding 时这里会抛 —— 若不吞，连不碰数据库的测试文件
    // 都跑不起来，而「缺依赖要有安装指引」正是本仓库承诺的行为、也有测试钉着。
    // 预热只是**提速**：没暖成功就退回原来的「谁先用谁付冷启动」，
    // 代价是慢，不是错。失败原因打到 stderr，真出问题时可追（不静默）。
    const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e)
    process.stderr.write(`[setup-warm] DuckDB 预热跳过（不影响测试正确性，仅慢一点）：${msg}\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  ;(process as Marked)[FLAG] = true
}
