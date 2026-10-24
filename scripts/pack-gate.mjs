// scripts/pack-gate.mjs —— 发布产物门禁的纯判定逻辑（G7 / gap 5 / [42]）。
//
// 为什么需要它：`npm test` 走 vitest 直接 import `src/**`，**从不触碰构建产物**。
// 于是构建脚本退化时（例如 `build` 从 `tsc && node scripts/copy-assets.mjs` 退回纯
// `tsc`，或 copy-assets 的清单排除失效），测试仍然全绿，而发布包会静默地：
//   · 缺 `dist/skill/qiyu/*.md` —— `qiyu skill install` 的包内源目录是空的；
//   · 缺 `dist/postinstall.js` —— postinstall 静默 no-op（`|| exit 0` 掩盖一切）；
//   · `dist/core/edition.js` 带着占位版本 `0.0.0-dev` —— `qiyu --version` 报假版本。
// 三者都不报错，只是行为悄悄不对，所以必须对**真实 npm 包内容**做断言。
//
// 本文件只放**纯函数**（不读文件系统、不起子进程），由 `scripts/check-pack.mjs`
// 负责取真实数据后调用它；测试因此可以逐条钉住判定逻辑（缺文件 / 占位版本 /
// 版本不一致 / 正常）而不需要真的跑一次 npm pack。

/** 版本占位值：与 `src/core/edition.ts` 的 `PACKAGE_VERSION` 源码值一致。 */
export const PLACEHOLDER_VERSION = '0.0.0-dev'

/** 包内必须存在的 skill 正文入口（其余 `.md` 由 copy-assets 一并拷贝）。 */
export const REQUIRED_SKILL_ENTRY = 'dist/skill/qiyu/SKILL.md'

/** 包内必须存在的 postinstall 入口（缺了它，`npm install` 的首次运行检测静默消失）。 */
export const REQUIRED_POSTINSTALL = 'dist/postinstall.js'

/**
 * 校验发布包内容。
 *
 * @param {{
 *   files: readonly string[],
 *   editionSource: string,
 *   pkgVersion: string,
 *   expectedSkillDocs?: readonly string[],
 * }} input
 *   `files` 是 `npm pack --dry-run --json` 里归一化后的文件路径列表；
 *   `editionSource` 是构建后 `dist/core/edition.js` 的全文；
 *   `pkgVersion` 是 `package.json` 的 `version`；
 *   `expectedSkillDocs` 是**源码目录** `src/skill/qiyu/` 下的全部 `.md` 映射成的包内
 *   路径。给了它就逐文件比对（终审 F9：此前只要 ≥2 篇，6 篇缺 5 篇仍绿）；不给时退回
 *   「至少两篇」的弱判据（仅当调用方无法提供源清单时）。
 * @returns {string[]} 问题描述列表；空数组表示门禁通过。
 */
export function checkPack({ files, editionSource, pkgVersion, expectedSkillDocs }) {
  const problems = []
  const fileSet = new Set(files)

  if (Array.isArray(expectedSkillDocs) && expectedSkillDocs.length > 0) {
    const missing = expectedSkillDocs.filter((p) => !fileSet.has(p))
    if (missing.length > 0) {
      problems.push(`发布包缺少 skill 正文（copy-assets 没有跑，或正文没被拷贝）：${missing.join('、')}`)
    }
  } else {
    if (!fileSet.has(REQUIRED_SKILL_ENTRY)) {
      problems.push(`发布包缺少 ${REQUIRED_SKILL_ENTRY}（copy-assets 没有跑，或 skill 正文没被拷贝）`)
    }
    // 兜底：入口在而参考文档不在同样是坏包。
    const skillMdCount = files.filter(
      (f) => f.startsWith('dist/skill/qiyu/') && f.endsWith('.md'),
    ).length
    if (skillMdCount < 2) {
      problems.push(`发布包里 dist/skill/qiyu/ 下的 .md 只有 ${skillMdCount} 篇（至少应有 SKILL.md 与参考文档）`)
    }
  }

  if (!fileSet.has(REQUIRED_POSTINSTALL)) {
    problems.push(`发布包缺少 ${REQUIRED_POSTINSTALL}（首次运行检测会静默消失）`)
  }

  // 版本注入：锚定 export 行，出现次数必须是 1（tsc 输出形态变了就不能猜）。
  const matches = [...editionSource.matchAll(/export const PACKAGE_VERSION = '([^']*)'/g)]
  if (matches.length !== 1) {
    problems.push(`dist/core/edition.js 中 \`export const PACKAGE_VERSION = '...'\` 出现 ${matches.length} 次（期望 1 次）`)
  } else {
    const actual = matches[0][1]
    if (actual === PLACEHOLDER_VERSION) {
      problems.push(`dist/core/edition.js 仍是占位版本 ${PLACEHOLDER_VERSION}（copy-assets 的版本注入没有跑）`)
    } else if (actual !== pkgVersion) {
      problems.push(`dist/core/edition.js 的版本 ${JSON.stringify(actual)} 与 package.json 的 ${JSON.stringify(pkgVersion)} 不一致`)
    }
  }

  return problems
}

/**
 * 解析 `npm pack --dry-run --json` 的 stdout。
 *
 * 已知三种顶层形态（都实测过）：
 *   · npm 10/11：数组 `[{ …, files: [...] }]`
 *   · npm 11 单包：对象 `{ …, files: [...] }`
 *   · npm ≥12：**按包名键控** `{ "qiyu-cli": { …, files: [...] } }`（复审 N1：
 *     旧实现只认前两种，在 npm 12 上整条门禁直接 fail，等于门禁不存在）
 *
 * ⚠️ 不能按「首个 `[` 字符」切：prepare 的日志行 `[copy-assets] ...` 里就带 `[`。
 * 正确做法是**逐行起点**往后试解析（日志行永远不是合法 JSON，会被跳过）。
 *
 * 解析不出时**抛错**（本模块是纯函数层，不退出进程）；调用方决定怎么报。
 */
export function parsePackJson(stdout) {
  const lines = stdout.split('\n')
  let offset = 0
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(stdout.slice(offset + (line.length - trimmed.length)))
        const files = extractFiles(parsed)
        if (files !== null) return files
      } catch {
        // 不是 JSON 起点（多半是日志行），继续往下试。
      }
    }
    offset += line.length + 1
  }
  throw new Error(`npm pack --dry-run --json 的输出里找不到含 files 的 JSON：${stdout.slice(0, 200)}`)
}

/** 从任一种顶层形态里取出文件路径数组；取不到返回 null。 */
function extractFiles(parsed) {
  const pick = (e) => {
    if (!e || typeof e !== 'object' || !Array.isArray(e.files)) return null
    return e.files.map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean)
  }
  if (Array.isArray(parsed)) return pick(parsed[0])
  const direct = pick(parsed)
  if (direct !== null) return direct
  // npm ≥12：`{ "<包名>": { …, files } }`。取第一个带 files 的值（单包 dry-run 只会有一个键）。
  for (const value of Object.values(parsed)) {
    const nested = pick(value)
    if (nested !== null) return nested
  }
  return null
}
