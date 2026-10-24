// tests/skill/copy-assets.test.ts —— 构建脚本的钉子（Task 13 审查 M1）。
//
// `scripts/copy-assets.mjs` 是**独立脚本**（不经 tsc、不在模块图里），所以测试用
// 子进程跑它，而不是重构成可注入模块：在临时目录搭一个 mini 仓库（脚本从真实仓库
// 复制、其余产物按最小形态造），`execFileSync(process.execPath, [script])` 执行，
// 断言它对文件系统的实际效果。
//
// 脚本内部一切路径都由 `import.meta.url` 定位仓库根（不与 cwd 耦合），所以复制到
// 别处仍能正确工作——这正是「直接复制可用」的前提，本测试顺带钉住了它。
//
// 覆盖审查报告的三个变异（B / F / 注入复核）：
//   · 清单排除（F：把 `new Set([MANIFEST])` 换成空 Set → 清单会漏进 dist）；
//   · fail() 的退出码（B：去掉 `process.exit(1)` → 坏输入会静默成功）；
//   · 版本注入与幂等（二次运行内容不变）。

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

/** 真实仓库根（本文件在 `<root>/tests/skill/` 下，向上三级）。 */
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

let sandbox: string

beforeEach(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-copy-assets-')))
})
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

/** 写文件（自动建父目录）。 */
function write(root: string, rel: string, content: string): void {
  const p = join(root, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

/**
 * 搭一个最小仓库：脚本从真实仓库复制（保证测试的是真脚本），其余形态按脚本要求造。
 * `editionContent` 可覆盖 `dist/core/edition.js` 以构造「tsc 输出形态变了」。
 */
function makeMiniRepo(opts: { version?: string; edition?: string } = {}): string {
  const version = opts.version ?? '9.9.9'
  write(sandbox, 'package.json', JSON.stringify({ name: 'mini', version }, null, 2) + '\n')
  write(sandbox, 'scripts/copy-assets.mjs', readFileSync(join(repoRoot, 'scripts/copy-assets.mjs'), 'utf8'))
  write(sandbox, 'src/core/registry/params/a.b.json', '{"x":1}\n')
  write(sandbox, 'src/core/registry/validate.json', '{"a.b":{}}\n')
  write(sandbox, 'src/skill/qiyu/SKILL.md', '# qiyu\n')
  write(sandbox, 'src/skill/qiyu/protocols.md', '协议正文\n')
  // 源目录里**故意**误放一份安装清单：脚本必须排除它。
  write(sandbox, 'src/skill/qiyu/.qiyu-skill.json', '{"version":"stale"}\n')
  // tsc 的产物形态：占位值单引号 + 分号（与真实构建一致）。
  write(
    sandbox,
    'dist/core/edition.js',
    opts.edition
      ?? "// 注释里提到 '0.0.0-dev' 是正常的，不能被替换\nexport const PACKAGE_VERSION = '0.0.0-dev';\n",
  )
  return sandbox
}

/** 跑脚本，返回 { status, stdout, stderr }（不抛，退出码由用例断言）。 */
function runScript(root: string): { status: number; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [join(root, 'scripts/copy-assets.mjs')], {
    cwd: root,
    encoding: 'utf8',
  })
  return { status: r.status ?? -1, stdout: r.stdout, stderr: r.stderr }
}

describe('scripts/copy-assets.mjs', () => {
  it('版本注入：export 行变成 package.json 的 version，注释里的占位值不被误改', () => {
    const root = makeMiniRepo()
    const r = runScript(root)
    expect(r.status, r.stderr).toBe(0)

    const edition = readFileSync(join(root, 'dist/core/edition.js'), 'utf8')
    expect(edition).toContain("export const PACKAGE_VERSION = '9.9.9';")
    // 注释里的 '0.0.0-dev' 是正常的说明文字，不能被全局替换掉（裁定 3）。
    expect(edition).toContain("'0.0.0-dev'")
    expect(edition).not.toContain("PACKAGE_VERSION = '0.0.0-dev'")
  })

  it('清单排除：源里的 .qiyu-skill.json 不进 dist，且有一行提示', () => {
    const root = makeMiniRepo()
    const r = runScript(root)
    expect(r.status, r.stderr).toBe(0)

    expect(existsSync(join(root, 'dist/skill/qiyu/.qiyu-skill.json'))).toBe(false)
    expect(existsSync(join(root, 'dist/skill/qiyu/SKILL.md'))).toBe(true)
    expect(existsSync(join(root, 'dist/skill/qiyu/protocols.md'))).toBe(true)
    expect(r.stderr).toContain('.qiyu-skill.json')
  })

  it('三条拷贝职责都在：params、validate.json、skill 正文', () => {
    const root = makeMiniRepo()
    expect(runScript(root).status).toBe(0)
    expect(existsSync(join(root, 'dist/core/registry/params/a.b.json'))).toBe(true)
    expect(existsSync(join(root, 'dist/core/registry/validate.json'))).toBe(true)
    expect(existsSync(join(root, 'dist/skill/qiyu/SKILL.md'))).toBe(true)
  })

  it('幂等：第二次运行内容不变、退出 0', () => {
    const root = makeMiniRepo()
    expect(runScript(root).status).toBe(0)
    const first = readFileSync(join(root, 'dist/core/edition.js'), 'utf8')
    const firstSkill = readFileSync(join(root, 'dist/skill/qiyu/SKILL.md'), 'utf8')

    const again = runScript(root)
    expect(again.status, again.stderr).toBe(0)
    expect(readFileSync(join(root, 'dist/core/edition.js'), 'utf8')).toBe(first)
    expect(readFileSync(join(root, 'dist/skill/qiyu/SKILL.md'), 'utf8')).toBe(firstSkill)
    // 已是目标版本时走「跳过注入」分支（幂等的可见证据）。
    expect(again.stdout).toContain('已是目标版本')
  })

  it('找不到 export 行（tsc 输出形态变了）→ 非 0 退出且报错', () => {
    const root = makeMiniRepo({ edition: 'const somethingElse = 1;\n' })
    const r = runScript(root)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('出现 0 次')
  })

  it('export 行是第三种值（既非占位也非目标版本）→ 非 0 退出', () => {
    const root = makeMiniRepo({ edition: "export const PACKAGE_VERSION = '8.8.8';\n" })
    const r = runScript(root)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('既不是占位值')
  })

  it('package.json 的 version 是占位值 → 非 0 退出（拒绝把占位值当版本注入）', () => {
    const root = makeMiniRepo({ version: '0.0.0-dev' })
    const r = runScript(root)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('version 不可用')
  })

  // —— D3.10：`export const …` 匹配到多处时的歧义保护 ——
  it('export 行出现多次（歧义）→ 非 0 退出，拒绝猜哪一行是版本', () => {
    // 变异「去掉 `matches.length !== 1` 的检查」→ 本用例红：脚本会拿第一处匹配注入、
    // 退 0，把一份有歧义的构建产物当成成功。
    // 构造：两处 `export const PACKAGE_VERSION = '...'`（第二处是重复导出/打包残留的形态）。
    const root = makeMiniRepo({
      edition: [
        "// 注释里提到 '0.0.0-dev' 是正常的，不能被替换",
        "export const PACKAGE_VERSION = '0.0.0-dev';",
        "export const PACKAGE_VERSION = '0.0.0-dev';",
        '',
      ].join('\n'),
    })
    const r = runScript(root)
    expect(r.status).not.toBe(0)
    expect(r.stderr).toContain('出现 2 次')
    // 歧义时**一个字节都不写**：两行都还是占位值（没有「猜一处先注入」的半成品）。
    const edition = readFileSync(join(root, 'dist/core/edition.js'), 'utf8')
    expect(edition.match(/PACKAGE_VERSION = '0\.0\.0-dev'/g)).toHaveLength(2)
  })
})
