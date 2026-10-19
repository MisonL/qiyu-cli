// tests/store/layering.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

describe('分层约束（架构不变量）', () => {
  // ⚠️ 只扫静态 `from '…'` 会漏掉两类等价写法（架构审查 M-1）：动态
  // `await import('../sync/engine.js')`（仓库里已有这种惯用法：sandbox.ts:49、
  // sync-run.ts:125）与裸副作用 `import '../commands/db.js'`。两者都能静默穿透红线。
  // 本函数把三种形态一并取出，供各条规则共用。
  const importSpecifiers = (f: string): string[] => {
    const text = readFileSync(f, 'utf8')
    return [
      ...text.matchAll(/from\s+['"]([^'"]+)['"]/g),
      ...text.matchAll(/import\s*\(\s*['"]([^'"]+)['"]\s*\)/g),
      ...text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm),
    ].map((m) => m[1])
  }

  it('store/ 不得 import sync/', () => {
    const root = join(src, 'store')
    if (!existsSync(root)) return
    for (const f of walk(root)) {
      for (const m of importSpecifiers(f)) {
        expect(m, `${f} → ${m}`).not.toMatch(/\/sync\/|\.\.\/sync/)
      }
    }
  })
  it('core/ 不得 import store/', () => {
    for (const f of walk(join(src, 'core'))) {
      for (const m of importSpecifiers(f)) {
        expect(m, `${f} → ${m}`).not.toMatch(/\/store\/|\.\.\/store/)
      }
    }
  })
  // core 是 query 与 sync 的共同底座（`core/time.ts` 就是为了让两边共用而沉淀的）——
  // 它一旦反向依赖 sync/，那条沉淀就白做了，且 query 会间接拉进写侧引擎。
  it('core/ 不得 import sync/', () => {
    for (const f of walk(join(src, 'core'))) {
      for (const m of importSpecifiers(f)) {
        expect(m, `${f} → ${m}`).not.toMatch(/\/sync\/|\.\.\/sync/)
      }
    }
  })
  it('sync/ 不得 import commands/（引擎与任务不知道命令层，spec §十一.15）', () => {
    for (const f of walk(join(src, 'sync'))) {
      for (const m of importSpecifiers(f)) {
        expect(m, `${f} → ${m}`).not.toMatch(/\/commands\/|\.\.\/commands/)
      }
    }
  })
  // E 的红线（spec §5.1 / 裁决 R2）：查询层是**被命令层调用**的库，不是命令层的一部分。
  // 反向依赖会让 `query/` 里的纯函数（mask / errors / table-query）间接拉进命令层与同步引擎，
  // 单测被迫加载整个 CLI；`sync/` 更是写侧引擎，只读层依赖它意味着沙箱的只读性无法静态论证。
  it('query/ 不得 import sync/ 与 commands/', () => {
    for (const f of walk(join(src, 'query'))) {
      for (const m of importSpecifiers(f)) {
        expect(m, `${f} → ${m}`).not.toMatch(/\/sync\/|\.\.\/sync|\/commands\/|\.\.\/commands/)
      }
    }
  })
  // spec design.md:100 明列：query/ 不得依赖 `store/duckdb.ts` 的 Store 实现（测试审查 F10）。
  it('query/ 不得 import store/duckdb（驱动实现）', () => {
    for (const f of walk(join(src, 'query'))) {
      for (const m of importSpecifiers(f)) {
        expect(m, `${f} → ${m}`).not.toMatch(/store\/duckdb/)
      }
    }
  })
  it('store/ 不得 import query/', () => {
    for (const f of walk(join(src, 'store'))) {
      for (const m of importSpecifiers(f)) {
        expect(m, `${f} → ${m}`).not.toMatch(/\/query\/|\.\.\/query/)
      }
    }
  })
  // ⚠️ 第三条规则（Q 组 Q-中-2）：静态 import 扫描拦不住 commands 层的动态 import ——
  // 「auth/api 完全不加载 @duckdb/node-api」是 Global Constraints 红线，用源文本
  // 字面量扫描补上（覆盖 ~95% 风险；进程级断言成本高，不采用）。
  it('auth/api 不得出现 @duckdb/node-api 字面量与 /store/ import（零加载红线的源文本防线）', () => {
    for (const f of ['auth.ts', 'api.ts'].map((n) => join(src, 'commands', n))) {
      const text = readFileSync(f, 'utf8')
      expect(text, `${f} 含 @duckdb 字面量`).not.toMatch(/@duckdb/)
      // ⚠️ 必须同时覆盖三种写法（测试审查 F8）：静态 `from '…'`、动态 `import('…')`、
      // 裸副作用 `import '…'`。只匹配 `from` 时，加一行 `await import('../store/index.js')`
      // 就能静默穿透「auth/api 零加载」红线。
      expect(text, `${f} import store`).not.toMatch(
        /(?:from\s*|import\s*\(\s*|import\s+)['"][^'"]*\/store\//)
    }
  })
})
