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
// ✅ 「每个 worker 只暖一次」已实测（CodeRabbit 2026-11-14 major）：给预热加一行 stderr 探针，
// `vitest run output/cli/errors/store-errors --maxWorkers=1` 下**四个文件只出现一次**探针；
// vitest 2.1.9 从不启用 isolation 的单 worker 进程里复用同一 worker，setupFiles 在每个文件
// 前重跑但被标记挡住。另外出现的第二个 pid 是 vitest 自己带特殊参数（`--config` 探测等）
// 起的子跑，不跑测试文件。
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

/** 预热体的结果（导出只为可测）。 */
export type WarmOutcome =
  | { ok: true }
  /** `already`：同一进程里已经暖过一次，`warmDuckDb()` 直接返回、没有再做。 */
  | { ok: false; already: true }
  | { ok: false; already: false; error: unknown }

/**
 * 预热体：建临时库、`init()`、关掉。**所有**失败（含临时目录建不出来、超时）都收在这一步
 * 的返回值里，由调用方（setup 入口）打到 stderr —— 导出只为可测
 * （`tests/setup-warm.test.ts` 直接调它，不必端到端构造「vitest 自己都起不来」的场景）。
 * `ifWarmed` 只给测试用：守卫文件自己被 setupFiles 加载时进程标记已是 true，
 * 不换掉这个判据就永远只能拿到 `already`、测不到真正的失败路径。
 *
 * ⚠️ 这里**不写 stderr**：`tests/setup-warm.test.ts` 自己是被 `setupFiles` 加载的
 * （`warmDuckDb` 的导入会先让本文件跑一遍预热），若这里直接 `process.stderr.write`，
 * 每次跑测试都会多一行「预热跳过」，而且会干扰那条子进程守卫里对告警文本的断言。
 */
export async function warmDuckDb(opts: { ifWarmed?: () => boolean } = {}): Promise<WarmOutcome> {
  if ((opts.ifWarmed ?? (() => (process as Marked)[FLAG] === true))()) return { ok: false, already: true }
  // ⚠️ 预热必须**有界**（Sourcery 2026-11-14）：setupFiles 在收集**之前**执行，原生绑定
  // 卡住不返回时，用例自身的 `testTimeout`/`hookTimeout` 都还没生效 —— 整个 worker 挂死，
  // 表象是「测试跑了很久没动静」。超时按降级处理（没暖成 = 慢一点，不是错）。
  // 可用 `QIYU_WARM_TIMEOUT_MS` 调小，供守卫验证这条路径。
  const budgetMs = Number(process.env.QIYU_WARM_TIMEOUT_MS ?? 120_000)
  // ⚠️ 整个预热（**含临时目录创建**）都在 try 里：`mkdtempSync` 也会失败（`TMPDIR` 指向
  // 一个文件等），放在 try 外就绕过了降级（CodeRabbit 2026-11-14 major）。
  // 清理同理走 best-effort（目录可能被删过、或库仍打开）。
  let dir: string | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let pending: Promise<void> | undefined
  try {
    dir = mkdtempSync(join(tmpdir(), 'qiyu-warm-'))
    const warmDir = dir
    pending = (async (): Promise<void> => {
      // 探针缝：`tests/setup-warm.test.ts` 在**子进程**里设这个环境变量，用来验证
      // 「预热抛错/卡住不影响测试」。子进程与父进程不共享 `process`，所以经环境变量传代码串。
      // 注入点必须在**受超时保护的这一段里** —— 放在 race 之外就绕过了预算。
      if (process.env.QIYU_WARM_FAIL_INJECT) {
        const injected = new Function(`return (${process.env.QIYU_WARM_FAIL_INJECT})`)() as unknown
        if (injected instanceof Error) throw injected
        await injected
      }
      const { createDuckDbStore } = await import('../src/store/duckdb.js')
      const s = await createDuckDbStore(
        { backend: 'duckdb', path: join(warmDir, 'warm.db'), readOnlyRetryMs: 30_000, batchSize: 1000 }, 'rw')
      try {
        await s.init()
      } finally {
        // `init()` 失败也要关（Sourcery 2026-11-14）：库实例保持打开会把文件句柄带进后续
        // 每个测试文件。关的时候再抛同样不许逃出预热 —— 失败已被 catch 兜过，这里 best-effort。
        await s.close().catch(() => {})
      }
    })()
    await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        // ⚠️ 不能 `unref()` 这个定时器：卡住的那一步若没有任何 handle，事件循环里只剩这个
        // 定时器，unref 掉之后进程直接「无活可做」退出，`Promise.race` 既不 resolve 也不
        // reject —— 预热反而变成无限挂起（2026-11-14 实测：注入永不 resolve 的 await 后
        // 用例直接 60s 超时）。预热本身很短，多留 120s 的定时器无所谓。
        timer = setTimeout(() => reject(new Error(`预热超过 ${budgetMs}ms 未完成`)), budgetMs)
      }),
    ])
    return { ok: true }
  } catch (error) {
    // ⚠️ **绝不能**让预热失败拖垮整个测试收集（Codex 2026-11-14 P2）：`@duckdb/node-api` 是
    // optionalDependencies，缺原生 binding 时这里会抛 —— 若不吞，连不碰数据库的测试文件
    // 都跑不起来，而「缺依赖要有安装指引」正是本仓库承诺的行为、也有测试钉着。
    // 预热只是**提速**：没暖成功就退回原来的「谁先用谁付冷启动」，
    // 代价是慢，不是错。
    return { ok: false, already: false, error }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // 超时后 body 可能还在跑：不让它后来的失败变成未处理的 rejection（它的句柄也会在
    // 进程结束时释放；这里不 await，预热已经超时，不能再等它）。
    pending?.catch(() => {})
    if (dir !== undefined) {
      try { rmSync(dir, { recursive: true, force: true }) } catch { /* 库仍打开/已被删：清理失败不影响正确性 */ }
    }
  }
}

if (!(process as Marked)[FLAG]) {
  // setup 入口：失败原因打到 stderr，真出问题时可追（不静默）。
  const outcome = await warmDuckDb()
  if (!outcome.ok && !outcome.already) {
    const e = outcome.error
    process.stderr.write(`[setup-warm] DuckDB 预热跳过（不影响测试正确性，仅慢一点）：${e instanceof Error ? `${e.name}: ${e.message}` : String(e)}\n`)
  }
  ;(process as Marked)[FLAG] = true
}
