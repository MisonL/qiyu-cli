// tests/helpers/lock-holder.test.ts —— 锁夹具自身的一条判据：**只有锁报文才算 CONFLICT**。
//
// ⚠️ 为什么这条必须有（CodeRabbit 2026-11-19 major）：旧版校验脚本是
// `main().catch(() => console.log('CONFLICT'))` —— 父目录不存在、`closeSync` 抛错这类
// **夹具自己的失败**同样打 CONFLICT。撞锁用例于是会把「夹具坏了」当成「锁生效了」放行，
// 而它的断言恰恰以「校验说 CONFLICT」为前提。
//
// 这条用例只做一件事：拿一个**父目录不存在**的路径去校验，要求它**响亮失败**、
// 且在错误里带上 DuckDB 的原始报文 —— 既不是 CONFLICT，也不是 OPENED（后者会让用例
// 静默换轮、最后报「锁落盘竞态超预期」，把夹具问题说成平台竞态）。
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { lockVerdict, LOCK_BUDGET_MS } from './lock-holder.js'

let dir = ''
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qiyu-lockfix-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

describe('lockVerdict —— 夹具失败与「锁生效」必须分得开', () => {
  it('父目录不存在 → 抛错并带上 DuckDB 原始报文（不是 CONFLICT / OPENED）', { timeout: LOCK_BUDGET_MS + 60_000 }, async () => {
    // 父目录 `missing/` 不存在：`DuckDBInstance.create` 报
    // `IO Error: Cannot open file "…": No such file or directory`（实测 2026-11-19）。
    // 这条报文不是锁报文 —— 必须走「夹具或环境问题」那一支。
    const p = join(dir, 'missing', 'q.db')
    const err = await lockVerdict(p, dir, Date.now() + LOCK_BUDGET_MS).then(() => null, (e: unknown) => e)
    expect(err, '父目录不存在必须让校验响亮失败，不得返回 CONFLICT/OPENED').toBeInstanceOf(Error)
    expect(String((err as Error).message), '错误里必须带上原始报文，否则无法定位').toMatch(/Cannot open file|No such file/)
    expect(String((err as Error).message), '不得把它说成锁竞态').toMatch(/夹具或环境问题/)
  })
})
