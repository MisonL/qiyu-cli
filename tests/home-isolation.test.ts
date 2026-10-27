// tests/home-isolation.test.ts —— 静态守卫：测试对 home 的隔离必须同时覆盖 HOME 与 USERPROFILE
//
// 病根（`tests/commands/skill.test.ts` 2026-10-26 就记过，2026-10-28 全仓仍扫出 17 个文件重犯）：
// `os.homedir()` 在 POSIX 读 `HOME`、在 **Windows 读 `USERPROFILE`**。只 stub `HOME` 的用例
// 在 Windows 上会读写**开发者的真实用户目录** —— 例如 `sync install --yes` 会真的往
// `%USERPROFILE%\Library\LaunchAgents` 写 plist。CI 只跑 ubuntu，所以这个洞从未暴露。
//
// 为什么是静态扫描而不是逐条用例：26 处 stub 分散在 17 个文件，靠人记「还要 stub 另一个」
// 必然漂移，而且**漏一处不会有任何东西变红**。静态扫描一处定义、全仓生效
// （与 `tests/plaintext-channels.test.ts` 同一思路）。
//
// ⚠️ 边界（诚实记录）：只看 `vi.stubEnv(...)` 的字面量。直接赋值 `process.env.HOME = …`
// 目前全仓没有；将来若出现，扫描器看不见 —— 那时应把这条规则也并进本文件的扫描模式。
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TESTS = join(ROOT, 'tests')

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

// 用正则而不是字面量：本文件自己的源码里不会出现 `stubEnv('HOME'` 这样的子串，
// 否则扫描器会把自己也判成违规。
const HOME_RE = /stubEnv\((['"])HOME\1/
const PROFILE_RE = /stubEnv\((['"])USERPROFILE\1/

/** 每个 HOME stub 附近（前后几行内）必须有配对的 USERPROFILE stub，反之亦然。 */
function offendersIn(file: string): string[] {
  const lines = readFileSync(file, 'utf8').split('\n')
  const out: string[] = []
  // 纯注释行不算 —— 文档里写 `stubEnv('HOME')` 是在解释规则，不是真的 stub。
  const isCode = (l: string): boolean => !l.trimStart().startsWith('//')
  const check = (re: RegExp, want: RegExp, label: string, window: (i: number) => string[]): void => {
    lines.forEach((l, i) => {
      if (!isCode(l) || !re.test(l)) return
      if (!want.test(window(i).join('\n'))) out.push(`${relative(ROOT, file)}:${i + 1} ${label}`)
    })
  }
  // HOME 的配对通常写在其后（可能隔一两行注释）；USERPROFILE 的配对写在其前。
  check(HOME_RE, PROFILE_RE, '只 stub 了 HOME，缺 USERPROFILE', (i) => lines.slice(i, i + 4))
  check(PROFILE_RE, HOME_RE, '只 stub 了 USERPROFILE，缺 HOME', (i) => lines.slice(Math.max(0, i - 3), i + 1))
  return out
}

describe('测试的 home 隔离（静态扫描）', () => {
  it('HOME 与 USERPROFILE 必须成对 stub（Windows 的 os.homedir() 读后者）', () => {
    const offenders = walk(TESTS).flatMap(offendersIn)
    expect(
      offenders,
      `Windows 上 os.homedir() 读 USERPROFILE，只 stub HOME 会让用例读写开发者的真实用户目录：\n${offenders.join('\n')}`,
    ).toEqual([])
  })
})
