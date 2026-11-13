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
import { captureSinks } from './helpers/capture.js'
import { warmDuckDb } from './setup-warm.js'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** `setup-warm.ts` 读取的环境变量名（两处必须一致，守卫里断言一下）。 */
const INJECT_ENV = 'QIYU_WARM_FAIL_INJECT'

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
    let err = ''
    try {
      vi.stubEnv('TMPDIR', blocker)
      captureSinks(() => {}, (s) => { err += s })
      await expect(warmDuckDb(), '预热体不得把失败抛出来').resolves.toBeUndefined()
      expect(err, '预热失败应被报出来（不静默）').toContain('[setup-warm] DuckDB 预热跳过')
      expect(err).toMatch(/ENOTDIR|EEXIST|ENOENT/)
    } finally {
      vi.unstubAllEnvs()
      rmSync(blocker, { force: true })
    }
  }, 60_000)
})
