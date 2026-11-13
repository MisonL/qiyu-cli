// tests/setup-warm.test.ts —— 守卫「预热失败不得拖垮测试收集」。
//
// 事故形态（Codex 2026-11-14 P2）：`@duckdb/node-api` 是 optionalDependencies，缺原生
// binding 时 `setupFiles` 里顶层 await 抛错 → **所有**测试文件连收集都进不去，包括不碰
// 数据库的、以及「缺依赖时给安装指引」的那几条。
//
// ⚠️ 不用静态扫源码判（那种判据挡不住「catch 了但在 catch 里又抛」）。真跑一个子 vitest：
// 子进程的 `process` 与父进程**不共享**，所以经环境变量传「注入一个让预热抛错的错误」的
// 代码串，由 `setup-warm.ts` 按该变量 `new Function` 求值（只在设置了变量时）——
// 不往 setup 里塞可被误触发的全局量。
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
/** `setup-warm.ts` 读取的环境变量名（两处必须一致，守卫里断言一下）。 */
const INJECT_ENV = 'QIYU_WARM_FAIL_INJECT'

describe('setup-warm：预热失败只降级、不拖垮测试', () => {
  it('预热抛错时，不碰数据库的测试文件仍然通过', () => {
    const warm = readFileSync(join(root, 'tests', 'setup-warm.ts'), 'utf8')
    expect(warm, '注入变量名两边必须一致').toContain(INJECT_ENV)
    try {
      // ⚠️ 用例文件必须落在仓库 `tests/` 下（vitest.config 的 `include` 是 tests/**），否则
      // 子 vitest 直接「No test files found」—— 那也会退出码 1，看着像守卫通过。
      const caseFile = join(root, 'tests', `__setup-warm-guard-${process.pid}.test.ts`)
      writeFileSync(caseFile, "import { it, expect } from 'vitest'\nit('纯函数', () => { expect(1 + 1).toBe(2) })\n")
      const r = spawnSync(process.execPath, [
        join(root, 'node_modules', 'vitest', 'vitest.mjs'), 'run', caseFile, '--maxWorkers=1', '--no-file-parallelism',
      ], {
        cwd: root,
        env: { ...process.env, [INJECT_ENV]: 'new Error("注入：模拟原生 binding 缺失")' },
        encoding: 'utf8',
        // ⚠️ 必须由子进程自己兜时间（CodeRabbit 2026-11-14 major）：`spawnSync` 同步阻塞，
        // 本例的 `timeout` 打不断它 —— 子 vitest 挂住会让整个 worker 卡死。
        timeout: 90_000,
        killSignal: 'SIGKILL',
      })
      const all = `${r.stdout}\n${r.stderr}\nr.error: ${r.error ? `${r.error.name}: ${r.error.message}` : 'none'}`
      // 先断「真正的后果」：预热抛错时子 vitest 必须仍然通过。再断「不静默」。
      expect(r.status, `预热失败拖垮了测试收集\n${all.slice(-2000)}`).toBe(0)
      expect(all, '预热失败应被报出来（不静默）').toContain('[setup-warm] DuckDB 预热跳过')
      expect(all).toMatch(/1 passed/)
    } finally {
      rmSync(join(root, 'tests', `__setup-warm-guard-${process.pid}.test.ts`), { force: true })
    }
  }, 120_000)
})
