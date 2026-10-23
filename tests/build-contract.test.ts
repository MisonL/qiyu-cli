// tests/build-contract.test.ts —— 构建产物的契约与门禁（G7 / gap 5 / [42]）。
//
// 测试与 CI 的分工：
//   · 本文件钉住**契约**：build 脚本必须包含 copy-assets、排除名单必须含清单文件名、
//     CI 必须真的调用产物门禁、门禁判定逻辑本身要能拒绝坏产物；
//   · 真实产物（`npm pack` 的文件清单、注入后的版本）由 `scripts/check-pack.mjs`
//     在 CI 里断言 —— 本仓库的测试只 import `src/**`，不跑真实构建。
//
// 为什么契约也要测：门禁最容易被「顺手简化」掉。删掉 CI 那一步、或把 build 改回纯
// `tsc`，功能测试全绿而发布包静默坏掉 —— 只有这里的用例会红。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPack, parsePackJson, PLACEHOLDER_VERSION } from '../scripts/pack-gate.mjs'
import { MANIFEST } from '../src/skill/paths.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const read = (rel: string): string => readFileSync(join(repoRoot, rel), 'utf8')

/** 一组合法的产物数据：门禁应当通过；各用例只改坏其中一处。 */
function goodPack(): {
  files: string[]
  editionSource: string
  pkgVersion: string
  expectedSkillDocs: string[]
} {
  return {
    files: [
      'dist/cli.js',
      'dist/postinstall.js',
      'dist/core/edition.js',
      'dist/skill/qiyu/SKILL.md',
      'dist/skill/qiyu/errors.md',
      'dist/skill/qiyu/setup.md',
    ],
    editionSource: "export const PACKAGE_VERSION = '1.2.3';\n",
    pkgVersion: '1.2.3',
    // 与 check-pack.mjs 同构：源码目录里的 .md 全集映射成包内路径。
    expectedSkillDocs: ['dist/skill/qiyu/SKILL.md', 'dist/skill/qiyu/errors.md', 'dist/skill/qiyu/setup.md'],
  }
}

describe('G7：build 脚本契约', () => {
  it('build 必须同时跑 tsc 与 copy-assets（只留 tsc = 产物缺 skill 正文与版本注入）', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    const build = pkg.scripts.build ?? ''
    expect(build).toContain('tsc')
    expect(build).toContain('scripts/copy-assets.mjs')
  })

  it('prepare 挂在 build 上（npm ci / npm pack 因此都会触发完整构建）', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.prepare).toBe('npm run build')
  })

  it('copy-assets 拷贝 skill 正文时把清单文件列进排除名单', () => {
    const source = read('scripts/copy-assets.mjs')
    // 锚定「skill 正文拷贝」那一行，而不是只看文件里出现过 MANIFEST。
    const line = source.split('\n').find((l) => l.includes("copyDirFresh('src/skill/qiyu'"))
    expect(line, '找不到 skill 正文的 copyDirFresh 调用').toBeDefined()
    expect(line).toContain('new Set([MANIFEST])')
  })

  it('copy-assets 的 MANIFEST 字面量与 paths.ts 一致（漂移会让真清单漏进包）', () => {
    const source = read('scripts/copy-assets.mjs')
    const m = /^const MANIFEST = '([^']*)'/m.exec(source)
    expect(m?.[1]).toBe(MANIFEST)
  })

  // —— 终审 F5：占位版本号有**三份**字面量，漂移会让门禁的「仍是占位版本」检查静默失效 ——
  it('占位版本三处字面量一致：edition.ts / copy-assets.mjs / pack-gate.mjs', () => {
    const edition = /export const PACKAGE_VERSION = '([^']*)'/.exec(read('src/core/edition.ts'))
    expect(edition?.[1], '找不到 edition.ts 的 PACKAGE_VERSION').toBeDefined()
    const copyAssets = /^const PLACEHOLDER = '([^']*)'/m.exec(read('scripts/copy-assets.mjs'))
    expect(copyAssets?.[1], '找不到 copy-assets.mjs 的 PLACEHOLDER').toBeDefined()
    // 源码里的那个占位值就是三者共同的事实源：
    expect(copyAssets?.[1]).toBe(edition![1])
    expect(PLACEHOLDER_VERSION).toBe(edition![1])
  })
})

describe('G7：CI 必须真的跑产物门禁', () => {
  const ci = read('.github/workflows/ci.yml')

  it('CI 调用了 scripts/check-pack.mjs', () => {
    expect(ci).toContain('node scripts/check-pack.mjs')
  })

  it('产物门禁只在一个矩阵项跑（产物与 Node 版本无关，三个都跑纯拖慢 CI）', () => {
    const step = ci.split('\n').find((l) => l.includes('node scripts/check-pack.mjs'))
    // 上一步的 if 条件与 run 在同一 step 块里；向前找到最近的 if: 行。
    const lines = ci.split('\n')
    const idx = lines.findIndex((l) => l.includes('node scripts/check-pack.mjs'))
    const block = lines.slice(Math.max(0, idx - 4), idx + 1).join('\n')
    expect(block).toMatch(/if:\s*matrix\.node-version\s*==\s*'20\.12'/)
  })
})

describe('G7：门禁判定逻辑', () => {
  it('合法产物 → 无问题', () => {
    expect(checkPack(goodPack())).toEqual([])
  })

  it('缺 SKILL.md（copy-assets 没跑）→ 拒绝', () => {
    const input = goodPack()
    input.files = input.files.filter((f) => !f.endsWith('/SKILL.md'))
    expect(checkPack(input).some((p) => p.includes('SKILL.md'))).toBe(true)
  })

  it('源码有 3 篇正文、包里只有 1 篇（数量判据会漏）→ 逐文件比对拒绝（终审 F9）', () => {
    const input = goodPack()
    input.files = input.files.filter((f) => f !== 'dist/skill/qiyu/errors.md' && f !== 'dist/skill/qiyu/setup.md')
    const problems = checkPack(input)
    expect(problems.some((p) => p.includes('errors.md')), '缺的每篇都要点名').toBe(true)
    expect(problems.some((p) => p.includes('setup.md'))).toBe(true)
  })

  it('缺 postinstall.js → 拒绝', () => {
    const input = goodPack()
    input.files = input.files.filter((f) => !f.endsWith('postinstall.js'))
    expect(checkPack(input).some((p) => p.includes('postinstall'))).toBe(true)
  })

  it('edition.js 仍是占位版本（版本注入没跑）→ 拒绝', () => {
    const input = goodPack()
    input.editionSource = `export const PACKAGE_VERSION = '${PLACEHOLDER_VERSION}';\n`
    expect(checkPack(input).some((p) => p.includes('占位版本'))).toBe(true)
  })

  it('edition.js 版本与 package.json 不一致 → 拒绝', () => {
    const input = goodPack()
    input.editionSource = "export const PACKAGE_VERSION = '9.9.9';\n"
    expect(checkPack(input).some((p) => p.includes('不一致'))).toBe(true)
  })

  it('edition.js 里 PACKAGE_VERSION 出现多处（tsc 输出形态变了）→ 拒绝', () => {
    const input = goodPack()
    input.editionSource =
      "export const PACKAGE_VERSION = '1.2.3';\nexport const PACKAGE_VERSION = '1.2.3';\n"
    expect(checkPack(input).some((p) => p.includes('期望 1 次'))).toBe(true)
  })
})

// —— 复审 N1：`npm pack --json` 有三种顶层形态，解析必须都认 ——
//
// 旧实现只认「数组」与「单对象带 files」，npm ≥12 改成按包名键控
// `{"qiyu-cli": {…}}` 后整条门禁直接 fail（等于门禁不存在）。本机 npm 12.2.1 实测。
describe('G7/N1：npm pack --json 三种输出形态', () => {
  const files = [{ path: 'dist/cli.js', size: 1, mode: 420 }]

  it('npm 10/11：顶层是数组', () => {
    expect(parsePackJson(`[{"files":${JSON.stringify(files)}}]`)).toEqual(['dist/cli.js'])
  })

  it('npm 11 单包：顶层是带 files 的对象', () => {
    expect(parsePackJson(JSON.stringify({ files }))).toEqual(['dist/cli.js'])
  })

  it('npm ≥12：顶层按包名键控', () => {
    expect(parsePackJson(JSON.stringify({ 'qiyu-cli': { files } }))).toEqual(['dist/cli.js'])
  })

  it('前面混入 prepare 的日志行（含 `[`）也能找到 JSON', () => {
    const stdout = [
      '> qiyu-cli@0.1.0 prepare',
      '[copy-assets] 已复制注册表参数表 → dist/core/registry/params',
      '> tsc && node scripts/copy-assets.mjs',
      JSON.stringify({ 'qiyu-cli': { files } }),
    ].join('\n')
    expect(parsePackJson(stdout)).toEqual(['dist/cli.js'])
  })
})
