// tests/store/layering.test.ts
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs'
import { join, dirname, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const src = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src')
const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

describe('分层约束（架构不变量）', () => {
  // ⚠️ **why 要剥注释**：`src/output.ts` 的 doc 注释为了说明「为什么不能直接 import」，
  // 逐字写了反例 `import { skillWarning } from './skill/detect.js'` —— 纯文本正则会把
  // 注释当代码，让「不得 import skill/」这条红线**假红**（而注释不是依赖，不该判红）。
  //
  // **边界（错误方向是假红，不是假绿 —— 红线宁可误报，不可漏报）**：只剔除
  // 「注释标记在行首」的整行注释（本仓库注释风格如此：块注释每行带 ` *`，行注释 `//`）。
  // ① 块注释中间不带前缀的行不会被剔除 → 那种写法的 import 形态仍会被扫到并判红；
  // ② 真实 import 不可能以 `//` / `*` 开头，因此不会漏扫。
  // 另一条更自然的「状态机剥离」不可取：正则字面量（如 `query/errors.ts` 里的
  // `(['"])`）会让朴素状态机误入「字符串」状态，反而把后续真实代码当注释吞掉。
  const stripCommentLines = (text: string): string =>
    text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')

  // ⚠️ 只扫静态 `from '…'` 会漏掉两类等价写法（架构审查 M-1）：动态
  // `await import('../sync/engine.js')`（仓库里已有这种惯用法：sandbox.ts:49、
  // sync-run.ts:125）与裸副作用 `import '../commands/db.js'`。两者都能静默穿透红线。
  // 本函数把三种形态一并取出，供各条规则共用。
  const importSpecifiers = (f: string): string[] => {
    // 剥注释后再取（见上方 `stripCommentLines` 的 why 与边界）。
    const text = stripCommentLines(readFileSync(f, 'utf8'))
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
  // ⚠️ **传递闭包**版（G1 补）：上面那条只扫 `auth.ts` / `api.ts` 自身的源文本，
  // 于是「auth.ts import 一个新工具模块，那个模块 import store/」可以静默穿透 ——
  // 源文本里没有 `/store/`，而进程启动时 DuckDB 照样被加载。G1 恰恰就是在这个位置
  // 动刀（抽 `core/config.ts` 让 auth/api 有配置能力而不碰 store），所以把守卫
  // 升级成**从这两个入口出发的静态 import 传递闭包不得到达 `src/store/**`**。
  // ⚠️ 只跟**相对路径**的 import（`./` `../`）：包名（`node:fs`、`@duckdb/node-api`）
  // 解析不到仓内文件，且有上一条的字面量哨兵兜底。
  it('auth/api 的**静态 import 传递闭包**不得到达 src/store/（G1：源文本防线之外的第二层）', () => {
    const resolveSpec = (fromFile: string, spec: string): string | undefined => {
      if (!spec.startsWith('.')) return undefined
      // ⚠️ **必须处理 `.js` 后缀**：本仓库是 TS ESM（`moduleResolution: node16`），
      // 源码里一律写 `'../core/config.js'` 而磁盘上是 `.ts`。不剥离后缀就一个也
      // 解析不到 —— 变异验证会假绿（第一版就踩了：把 auth 链路改成 import store/
      // 仍然 10 条全绿）。
      const base = join(dirname(fromFile), spec.replace(/\.js$/, '.ts'))
      for (const cand of [base, join(base.replace(/\.ts$/, ''), 'index.ts'), `${base}`]) {
        if (existsSync(cand) && statSync(cand).isFile()) return cand
      }
      return undefined
    }
    for (const entry of ['auth.ts', 'api.ts'].map((n) => join(src, 'commands', n))) {
      const seen = new Set<string>()
      const queue = [entry]
      const storeReached: string[] = []
      while (queue.length > 0) {
        const cur = queue.pop()!
        if (seen.has(cur)) continue
        seen.add(cur)
        if (cur.startsWith(join(src, 'store') + sep)) { storeReached.push(cur); continue }
        for (const spec of importSpecifiers(cur)) {
          const target = resolveSpec(cur, spec)
          if (target !== undefined) queue.push(target)
        }
      }
      expect(storeReached, `${entry} 的 import 闭包到达了 src/store/`).toEqual([])
    }
  })
  // D5.1 的分层红线：`src/skill/` 是**叶子层**，它消费 core/ commands/ store/，这些层
  // 一律不得反向依赖它。反向 import 会让纯函数（output/tree/查询层）被迫加载 skill 探测
  // （读 home、读包内文件），而「未安装提示」本该是入口层的职责。
  it('core/commands/store/query/sync 与 src 根文件（cli.ts 除外）不得 import skill/', () => {
    // ⚠️ 扫 src 根目录下的单文件：`src/output.ts` 不在任何子目录里，而它正是
    // 「不得 import skill/」最需要钉住的文件（Task 10 为此改成注入式 setSkillWarning）。
    // **三处豁免**：`src/cli.ts`（入口层，负责 setSkillWarning 注入）、`src/commands/skill.ts`
    // （skill 子系统的命令门面，消费 skill/check|install|paths 是它的职责）与
    // `src/postinstall.ts`（顶层入口，spec D5.1 明说它 import skill/install.ts 用同一份
    // 安装逻辑，不是复制）。其余任何文件 import skill/ 都要红。
    const roots = ['core', 'store', 'query', 'sync'].map((d) => join(src, d))
    const commandFiles = walk(join(src, 'commands')).filter((f) => !f.endsWith(`${sep}skill.ts`))
    const rootFiles = readdirSync(src)
      .filter((n) => n.endsWith('.ts') && n !== 'cli.ts' && n !== 'postinstall.ts')
      .map((n) => join(src, n))
    for (const f of [...roots.flatMap(walk), ...commandFiles, ...rootFiles]) {
      for (const m of importSpecifiers(f)) {
        expect(m, `${f} → ${m}`).not.toMatch(/\/skill\/|\.\.\/skill/)
      }
    }
  })
})
