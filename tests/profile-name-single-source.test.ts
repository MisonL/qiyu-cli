// tests/profile-name-single-source.test.ts —— profile 名的解析只许有一处实现（2026-10-29）。
//
// 背景（真库实测的缺陷）：档名解析此前有**四份**实现 —— `core/config.ts` 的
// `fileProfile`、`store/config.ts` 的 `resolveStoreConfig`、以及 `commands/auth.ts` 里
// `whoami` / `login` 各自手写的 `??` 链。前两份把空串当未设置，后两份没有（`''` 不是
// null/undefined，`??` 直接放行），于是同一份配置在两个命令上解出两个档名：
//   · `"defaultProfile": ""` → `auth login` 把凭证写进 `profiles[""]`，而 `api call`
//     按内置 `default` 读 —— login/whoami 都报 configured: true，第一次真实调用却报
//     「缺少 appKey」（凭证写进了没人读的档）；
//   · `QIYU_PROFILE=` → `whoami` 报 auth_missing，而 `api call` 照样从 defaultProfile
//     的档读到凭证并发出请求。
//
// 修法是把解析收敛到 `core/config.ts` 的 `resolveProfileName`。本文件守**漂移**：
// 以后谁再在别处手写一条「envProfile ?? defaultProfile ?? 'default'」式的链，直接红
// —— 与 `plaintext-channels.test.ts` 同为「一处定义、全仓生效」的静态扫描。
//
// ⚠️ 边界（诚实记录）：这是**文本**判据，证明不了运行时行为（那是 `tests/core/config.test.ts`
// 的 `resolveProfileName` 单测与各命令自己的用例负责的）。它只回答一个问题：
// 「档名解析是不是还只有一处实现」。
import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const SRC = join(ROOT, 'src')

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })

/**
 * 抹掉行首整行注释与块注释行（与 `tests/store/layering.test.ts` 同一约定与同一已知边界）。
 *
 * ⚠️ 必须剥注释：`core/config.ts` 的 `resolveProfileName` 文档注释里逐字引用了反例
 * `envProfile ?? defaultProfile ?? 'default'`，纯文本正则会把说明当实现、让唯一实现
 * 的那个文件**自己判红**。
 */
const stripCommentLines = (text: string): string =>
  text.split('\n').filter((l) => !/^\s*(\/\/|\/\*|\*)/.test(l)).join('\n')

/**
 * 手写档名链的指纹：**同一个 `??` 链里既有配置键、又有兜底字面量 `'default'`**。
 *
 * 为什么不按「提到 defaultProfile 就红」：合法用法里 `file.defaultProfile` 是作为
 * **参数**传给 `resolveProfileName` 的（`auth.ts` 与 `store/config.ts` 都这样），
 * 按关键字一刀切会把正确实现判红。真正要禁的是那条手写解析的指纹 ——
 * 它同时携带「配置键」与「没有任何配置时的兜底」两个语义。
 *
 * 语句可跨行（旧 `login` 的链就是跨两行的），因此向前后各取 2 行补齐上下文。
 */
function scanText(text: string): Array<{ line: number; snippet: string }> {
  const lines = stripCommentLines(text).split('\n')
  const hits: Array<{ line: number; snippet: string }> = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (!/\?\?/.test(line) || !/['"]default['"]/.test(line)) continue
    const context = [lines[i - 2], lines[i - 1], line, lines[i + 1], lines[i + 2]]
      .filter((l): l is string => l !== undefined).join('\n')
    if (!/defaultProfile|QIYU_PROFILE|envProfile/.test(context)) continue
    hits.push({ line: i + 1, snippet: line.trim().slice(0, 120) })
  }
  return hits
}

const render = (hits: Array<{ file: string; line: number; snippet: string }>): string[] =>
  hits.map((h) => `${h.file}:${h.line}  ${h.snippet}`)

describe('profile 名解析必须只有一个实现（resolveProfileName）', () => {
  it('除 core/config.ts 外，全仓不得出现手写的「… ?? \'default\'」档名链', () => {
    const hits = walk(SRC)
      .filter((f) => !f.endsWith(join('core', 'config.ts')))
      .flatMap((f) => scanText(readFileSync(f, 'utf8')).map((h) => ({ file: relative(ROOT, f), ...h })))
    expect(
      render(hits),
      '这些地方在手写档名解析 —— 请改用 core/config.ts 的 resolveProfileName()'
      + '（空串口径的分叉曾让 auth login 把凭证写进没人读的档）：\n' + render(hits).join('\n'),
    ).toEqual([])
  })

  it('扫描器自身有牙：手写链必须被抓到，合法调用与无关兜底必须放过', () => {
    // ⚠️ 没有这一条，上面的断言可能是「扫了个空」—— 路径写错、正则退化成永不命中，
    // 都会让它恒绿。下面四个样例把两个方向都钉住（判据本身只有一份实现，就在这里）。
    const cases: Array<[string, string, number]> = [
      ['跨行旧 whoami 形态', "  const a = envProfile ?? file?.defaultProfile ?? 'default'", 1],
      ['单行旧 login 形态', "  const b = file.defaultProfile ?? 'default'", 1],
      ['合法：作为参数传给唯一实现',
        "  const c = resolveProfileName({ envProfile, defaultProfile: file?.defaultProfile }).name", 0],
      ['无关兜底：无配置键参与', "  const d = flags.db ?? env.QIYU_DB_PATH ?? 'x'", 0],
    ]
    for (const [label, text, want] of cases) {
      expect(scanText(text).length, `${label}：${text}`).toBe(want)
    }
    // 注释里的反例不得算违规（`core/config.ts` 的文档注释逐字引用旧写法）
    expect(scanText("// 旧写法：envProfile ?? defaultProfile ?? 'default'\nconst a = 1").length,
      '注释里的反例被当成了实现').toBe(0)
  })
})
