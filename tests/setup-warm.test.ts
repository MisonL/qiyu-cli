// tests/setup-warm.test.ts —— 守卫「预热失败不得拖垮测试收集」。
//
// 事故形态（Codex 2026-11-14 P2）：`@duckdb/node-api` 是 optionalDependencies，缺原生
// binding 时 `setupFiles` 里 await 预热体抛错 → **所有**测试文件连收集都进不去，包括不碰
// 数据库的、以及「缺依赖时给安装指引」的那几条。
//
// ⚠️ 不用静态扫源码判（那种判据挡不住「catch 了但在 catch 里又抛」）。真跑一个子 vitest：
// 子进程的 `process` 与父进程**不共享**，所以经环境变量传「注入一个让预热抛错的错误」的
// 代码串，由 `setup-warm.ts` 按该变量 `new Function` 求值（只在设置了变量时）——
// 不往 setup 里塞可被误触发的全局量。
import { describe, expect, it, vi } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { warmDuckDb } from './setup-warm.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** `setup-warm.ts` 读取的环境变量名（两处必须一致，守卫里断言一下）。 */
import type { WarmOutcome } from './setup-warm.js'
const INJECT_ENV = 'QIYU_WARM_FAIL_INJECT'
/** 卡住 `os.tmpdir()` 的环境变量名 —— ⚠️ Windows 上 Node 不读 `TMPDIR`，只读 `TEMP` / `TMP`
 *  （CodeRabbit 2026-11-14 major）。三者一起设，跨平台都能让 `mkdtempSync` 失败。 */
const TMPDIR_ENVS = ['TMPDIR', 'TEMP', 'TMP'] as const
/** 失败结果里那条错误（成功 / already 时返回 `null`），供断言用。 */
const errOf = (o: WarmOutcome): unknown => (o.ok || o.already ? null : o.error)

// ⚠️ 预热体**不写 stderr**，把失败作为返回值交给 setup 入口去打（Sourcery 2026-11-14 两轮
// 撞出的同一类问题）：本文件自己被 `setupFiles` 加载时，`setup-warm` 的导入就会先跑一遍
// 预热（同进程标记 → 第二次调用直接返回 `already`），若预热体自己写 stderr，每次跑测试都会
// 多一行「预热跳过」，还会干扰子进程守卫里对告警文本的断言。
describe('setup-warm：预热失败只降级、不拖垮测试', () => {
  /** 在仓库 `tests/` 下建一个临时用例文件（vitest.config 的 `include` 是 tests/**），
   *  跑子 vitest，返回输出。⚠️ 用例文件放在 /tmp 会因 include 过滤报「No test files
   *  found」，退出码同为 1 —— 看着像通过。 */
  function runChild(env: NodeJS.ProcessEnv): { status: number | null; all: string } {
    const caseFile = join(root, 'tests', `__setup-warm-guard-${process.pid}.test.ts`)
    writeFileSync(caseFile, "import { it, expect } from 'vitest'\nit('纯函数', () => { expect(1 + 1).toBe(2) })\n")
    try {
      const r = spawnSync(process.execPath, [
        join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', caseFile, '--maxWorkers=1', '--no-file-parallelism',
      ], {
        cwd: root,
        env,
        encoding: 'utf8',
        // ⚠️ 必须由子进程自己兜时间（CodeRabbit 2026-11-14 major）：`spawnSync` 同步阻塞，
        // 本例的 `timeout` 打不断它 —— 子 vitest 挂住会让整个 worker 卡死。
        timeout: 90_000,
        killSignal: 'SIGKILL',
      })
      return { status: r.status, all: `${r.stdout}\n${r.stderr}\nr.error: ${r.error ? `${r.error.name}: ${r.error.message}` : 'none'}` }
    } finally {
      rmSync(caseFile, { force: true })
    }
  }

  it('预热抛错时，不碰数据库的测试文件仍然通过', () => {
    const warm = readFileSync(join(root, 'tests', 'setup-warm.ts'), 'utf8')
    expect(warm, '注入变量名两边必须一致').toContain(INJECT_ENV)
    const { status, all } = runChild({ ...process.env, [INJECT_ENV]: 'new Error("注入：模拟原生 binding 缺失")' })
    // 先断「真正的后果」：预热抛错时子 vitest 必须仍然通过。再断「不静默」。
    expect(status, `预热失败拖垮了测试收集\n${all.slice(-2000)}`).toBe(0)
    expect(all, '预热失败应被报出来（不静默）').toContain('[setup-warm] DuckDB 预热跳过')
    expect(all).toMatch(/1 passed/)
  }, 120_000)

  // ⚠️ 临时目录创建也在降级范围里（CodeRabbit 2026-11-14 major）：`mkdtempSync` 失败时若放在
  // try 外，预热同样拖垮所有测试，而上面的注入守卫**测不到**这一条（注入发生在建目录之后）。
  // 这一条**不能**走子 vitest：`TMPDIR` 指向一个文件时 vitest **自己**就起不来了（实测收集
  // 阶段直接死），分不清是我们的预热还是 vitest 的错。所以直接调导出的预热体，测它的错误边界。
  it('临时目录建不出来时，预热只降级、不抛', async () => {
    const blocker = join(root, 'tests', `__tmpdir-blocker-${process.pid}`)
    writeFileSync(blocker, '')
    try {
      for (const k of TMPDIR_ENVS) vi.stubEnv(k, blocker)
      const outcome = await warmDuckDb({ ifWarmed: () => false })
      expect(outcome.ok, '预热体不得把失败抛出来').toBe(false)
      expect(String(errOf(outcome))).toMatch(/ENOTDIR|EEXIST|ENOENT/)
    } finally {
      vi.unstubAllEnvs()
      rmSync(blocker, { force: true })
    }
  }, 60_000)

  // ⚠️ 预热必须**有界**（Sourcery 2026-11-14）：setupFiles 在收集之前执行，原生绑定卡住
  // 不返回时用例自身的超时都还没生效，整个 worker 挂死。这里把预算压到 100ms，注入一个
  // 永不 resolve 的步骤 —— 预热必须在预算内返回、并报出来。
  it('预热卡住时按预算降级，不无限等待', async () => {
    try {
      vi.stubEnv('QIYU_WARM_TIMEOUT_MS', '100')
      // 注入**永不 resolve** 的一步（`await` 到它为止；`throw` 的是错误，不是卡住）。
      vi.stubEnv(INJECT_ENV, 'new Promise(() => {})')
      const outcome = await warmDuckDb({ ifWarmed: () => false })
      expect(outcome.ok).toBe(false)
      expect(String(errOf(outcome))).toMatch(/预热超过 100ms/)
    } finally {
      vi.unstubAllEnvs()
    }
  }, 60_000)
})
