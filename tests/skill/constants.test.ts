// tests/skill/constants.test.ts —— 路径事实源的跨文件一致性（G4/D6）。
//
// 为什么需要它：`MANIFEST` 与 skill 链接名是**路径事实**，理想形态只有一份。但
// `scripts/copy-assets.mjs` 是纯 JS 构建脚本（不经 tsc、不进模块图），无法 import
// TS 常量，只能各自持有字面量。两份字面量一旦漂移，症状很隐蔽：
//   · 构建脚本那份写错 → 真正的清单文件漏进 npm 包，`contentHash` 两边口径不一致；
//   · 源码那份写错 → 老版本安装的实体目录探测不到，被误判成「未安装」。
// 两种都不报错，只是行为悄悄不对。所以用一条用例把两侧钉在一起：**改任何一侧都会红**。
//
// 断言读的是脚本源码文本（而不是执行它）：这里要钉的是「字面量相同」，执行脚本还会
// 混入拷贝/注入等无关行为，噪声大且慢。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path, { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { LINK_NAME, MANIFEST, defaultEntityDir } from '../../src/skill/paths.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 从脚本源码里抠出 `const <name> = '<字面量>'` 的值；抠不到就返回 undefined（用例会红）。 */
function scriptConst(scriptRel: string, constName: string): string | undefined {
  const source = readFileSync(join(repoRoot, scriptRel), 'utf8')
  const m = new RegExp(`^const ${constName} = '([^']*)'`, 'm').exec(source)
  return m?.[1]
}

describe('D6：路径事实源跨文件一致', () => {
  it('scripts/copy-assets.mjs 的 MANIFEST 与 src/skill/paths.ts 的字面量相同', () => {
    expect(scriptConst('scripts/copy-assets.mjs', 'MANIFEST')).toBe(MANIFEST)
  })

  it('MANIFEST 是点号开头的隐藏文件名（不会出现在普通的 ls / 用户视野里）', () => {
    expect(MANIFEST.startsWith('.')).toBe(true)
  })

  it('defaultEntityDir 的叶子名取自 LINK_NAME（不再是一份独立字面量）', () => {
    const dir = defaultEntityDir('/home/someone')
    expect(dir.endsWith(`/skills/${LINK_NAME}`)).toBe(true)
  })

  it('defaultEntityDir 用注入的 pathImpl 拼接（win32 形态可钉住）', () => {
    // 用 path.win32 运算，钉住「注入的 pathImpl 真的被用上了」而不是被忽略
    const dir = defaultEntityDir('C:\\Users\\someone', path.win32)
    expect(dir).toBe('C:\\Users\\someone\\.agents\\skills\\qiyu')
  })
})
