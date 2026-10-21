// scripts/copy-assets.mjs —— 构建期拷贝 tsc 不会产出的资源，并把真实版本号注入 dist。
//
// 三个职责（旧 `copy-params.mjs` 的两个已并入本文件，旧文件已删除）：
//   1. 注册表参数表：`src/core/registry/params/` → `dist/core/registry/params/`；
//   2. 注册表校验文件：`src/core/registry/validate.json` → `dist/core/registry/validate.json`；
//   3. skill 正文：`src/skill/qiyu/` → `dist/skill/qiyu/`（`qiyu skill install` 与
//      `resolveSkillSourceDir()` 的包内源目录，发布形态靠这一份）。
//
// **幂等**（重复 `npm run build` 必须成功且结果一致）：拷贝前先 `rmSync` 目标目录再
// `cpSync`，不残留上一次构建的旧文件；版本注入对「已是目标版本」的文件是 no-op。
//
// **`.qiyu-skill.json` 绝不进包**：那是安装清单，只由 `installSkill` 写到用户的实体
// 目录，包内源目录里出现它只会让 `contentHash` 两边口径不一致。源里若被误放入同名
// 文件，拷贝时显式排除并提示——不能悄悄带进发布产物。
//
// **版本注入**（spec D7）：`files: ["dist"]` 发布后包里没有 package.json，运行时读不
// 到版本，所以 `src/core/edition.ts` 用 `PACKAGE_VERSION = '0.0.0-dev'` 占位，
// 由本脚本在 tsc 之后把 `dist/core/edition.js` 里**那一行**替换成 package.json 的
// version。只替换 `export const PACKAGE_VERSION = '...'` 这一处——注释里提到占位值
// 是正常的（edition.ts 的注释就写了它），全局替换会把注释也改掉。替换必须**校验**：
// 找不到该行（tsc 输出形态变了）或替换后该行仍是占位值，都打印错误并以非 0 退出
// ——发布产物绝不能静默带着 `0.0.0-dev`。

import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 仓库根：本脚本在 `<root>/scripts/` 下，向上两级。不依赖 cwd，从任何目录调用都正确。 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 安装清单文件名：与 src/skill/install.ts 的 MANIFEST 一致，只由安装逻辑写进用户目录。 */
const MANIFEST = '.qiyu-skill.json'

/** 版本占位值：与 src/core/edition.ts 的 PACKAGE_VERSION 源码值一致。 */
const PLACEHOLDER = '0.0.0-dev'

function fail(message) {
  console.error(`[copy-assets] 错误：${message}`)
  process.exit(1)
}

/**
 * 拷贝目录：先删目标再递归复制（幂等、不残留旧文件）。
 * `excludeNames` 里的文件名在**任意层级**都跳过；返回被跳过的相对路径列表。
 */
function copyDirFresh(fromRel, toRel, excludeNames = new Set()) {
  const from = path.join(root, fromRel)
  const to = path.join(root, toRel)
  if (!existsSync(from)) fail(`缺少源目录：${fromRel}`)
  if (!statSync(from).isDirectory()) fail(`源路径不是目录：${fromRel}`)

  const skipped = []
  rmSync(to, { recursive: true, force: true })
  mkdirSync(path.dirname(to), { recursive: true })
  cpSync(from, to, {
    recursive: true,
    force: true,
    filter: (src) => {
      // 根目录本身永远保留（filter 也会对 src 根本身调用一次）。
      if (path.resolve(src) === from) return true
      const name = path.basename(src)
      if (excludeNames.has(name)) {
        skipped.push(path.relative(from, src))
        return false
      }
      return true
    },
  })
  return skipped
}

/** 拷贝单个文件（覆盖，幂等）。 */
function copyFileFresh(fromRel, toRel) {
  const from = path.join(root, fromRel)
  const to = path.join(root, toRel)
  if (!existsSync(from)) fail(`缺少源文件：${fromRel}`)
  rmSync(to, { force: true })
  mkdirSync(path.dirname(to), { recursive: true })
  cpSync(from, to, { force: true })
}

// —— 1. 注册表参数表（旧 copy-params.mjs 的职责） ——
copyDirFresh('src/core/registry/params', 'dist/core/registry/params')
console.log('[copy-assets] 已复制注册表参数表 → dist/core/registry/params')

// —— 2. 注册表校验文件 ——
copyFileFresh('src/core/registry/validate.json', 'dist/core/registry/validate.json')
console.log('[copy-assets] 已复制注册表校验文件 → dist/core/registry/validate.json')

// —— 3. skill 正文（排除安装清单） ——
const skipped = copyDirFresh('src/skill/qiyu', 'dist/skill/qiyu', new Set([MANIFEST]))
for (const rel of skipped) {
  console.warn(`[copy-assets] 已排除 ${rel}：${MANIFEST} 是安装清单，由 \`qiyu skill install\` 写入用户目录，不能进包`)
}
console.log('[copy-assets] 已复制 skill 正文 → dist/skill/qiyu')

// —— 4. 版本注入：只替换 PACKAGE_VERSION 那一行 ——
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
if (typeof pkg.version !== 'string' || pkg.version === '' || pkg.version === PLACEHOLDER) {
  fail(`package.json 的 version 不可用：${JSON.stringify(pkg.version)}`)
}
const version = pkg.version

const editionRel = 'dist/core/edition.js'
const editionPath = path.join(root, editionRel)
if (!existsSync(editionPath)) fail(`找不到构建产物 ${editionRel}，请先运行 tsc`)

const source = readFileSync(editionPath, 'utf8')
// 精确锚定 export 行（占位值单引号、带分号——tsc 的实际输出形态）。
// 用 exec 逐处计数：出现 0 处说明 tsc 输出形态变了，出现多处说明有歧义，都不能猜。
const exportPattern = /export const PACKAGE_VERSION = '([^']*)'/g
const matches = [...source.matchAll(exportPattern)]
if (matches.length !== 1) {
  fail(`${editionRel} 中 \`export const PACKAGE_VERSION = '...'\` 出现 ${matches.length} 次（期望 1 次），tsc 输出形态可能已变，拒绝注入版本`)
}
const current = matches[0][1]

if (current === version) {
  // 已注入过（例如单独重跑本脚本而未重跑 tsc）：幂等，不重复写。
  console.log(`[copy-assets] ${editionRel} 已是目标版本 ${version}，跳过注入`)
} else if (current !== PLACEHOLDER) {
  fail(`${editionRel} 中 PACKAGE_VERSION 的值是 ${JSON.stringify(current)}，既不是占位值 ${PLACEHOLDER} 也不是目标版本，拒绝注入`)
} else {
  // 只替换匹配到的那一处。用函数形式的替换值（不是字符串模式）：版本号里若含 `$`
  // 字符，字符串模式会被当作替换模式解释（`$&`、`$1` 等），函数返回值原样插入。
  const injected = source.replace(
    exportPattern,
    () => `export const PACKAGE_VERSION = '${version}'`,
  )
  writeFileSync(editionPath, injected)
  console.log(`[copy-assets] 已注入包版本 ${version} → ${editionRel}`)
}

// —— 5. 复核：重读文件，export 行必须是目标版本（注入失败绝不静默） ——
const check = readFileSync(editionPath, 'utf8')
const checkMatches = [...check.matchAll(exportPattern)]
if (checkMatches.length !== 1 || checkMatches[0][1] !== version) {
  fail(`${editionRel} 版本复核失败：PACKAGE_VERSION 不是 ${version}，发布产物不得带占位版本`)
}
