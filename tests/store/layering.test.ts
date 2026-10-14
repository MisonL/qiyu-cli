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
  it('store/ 不得 import sync/', () => {
    const root = join(src, 'store')
    if (!existsSync(root)) return
    for (const f of walk(root)) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        expect(m[1], `${f} → ${m[1]}`).not.toMatch(/\/sync\/|\.\.\/sync/)
      }
    }
  })
  it('core/ 不得 import store/', () => {
    for (const f of walk(join(src, 'core'))) {
      for (const m of readFileSync(f, 'utf8').matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        expect(m[1], `${f} → ${m[1]}`).not.toMatch(/\/store\/|\.\.\/store/)
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
      expect(text, `${f} import store`).not.toMatch(/from\s+['"][^'"]*\/store\//)
    }
  })
})
