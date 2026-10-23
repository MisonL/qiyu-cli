// scripts/check-pack.mjs —— 发布产物门禁 CLI（G7 / gap 5 / [42]）。
//
// 取真实数据后交给 `pack-gate.mjs` 的纯函数判定：
//   1. `npm pack --dry-run --json` —— 真实的「会发布什么」清单（不是 `files` 字段的猜测）；
//   2. 构建后的 `dist/core/edition.js` —— 版本注入是否真的落地；
//   3. `package.json` 的 version —— 注入值是否与包版本一致。
//
// ⚠️ `npm pack` 会触发 `prepare`（= `npm run build`），所以本脚本自身就是一次完整构建；
// 在 CI 里它跑在 `npm ci`（已经构建过一次）之后，多一次幂等重建是刻意的：门禁校验的
// 必须是**本次**构建的产物，而不是上一轮留下的 dist。
//
// 输出：通过时一行摘要 + 退出 0；任一条不满足时逐条打印并以 1 退出。

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPack } from './pack-gate.mjs'

/** 仓库根：本脚本在 `<root>/scripts/` 下，向上两级。不依赖 cwd。 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`[check-pack] 错误：${message}`)
  process.exit(1)
}

/**
 * 解析 `npm pack --dry-run --json` 的 stdout（npm 10/11 输出数组，个别版本输出单对象）。
 *
 * ⚠️ 不能按「首个 `[` 字符」切：prepare 的日志行 `[copy-assets] ...` 里就带 `[`。
 * 正确做法是**逐行起点**往后试解析，第一个能解析出带 `files` 数组的结果即命中
 * （日志行永远不是合法 JSON，会被跳过）。
 */
function parsePackJson(stdout) {
  const lines = stdout.split('\n')
  let offset = 0
  for (const line of lines) {
    const trimmed = line.trimStart()
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed = JSON.parse(stdout.slice(offset + (line.length - trimmed.length)))
        const entry = Array.isArray(parsed) ? parsed[0] : parsed
        if (entry && Array.isArray(entry.files)) {
          return entry.files.map((f) => (typeof f === 'string' ? f : f.path)).filter(Boolean)
        }
      } catch {
        // 不是 JSON 起点（多半是日志行），继续往下试。
      }
    }
    offset += line.length + 1
  }
  fail(`npm pack --dry-run --json 的输出里找不到含 files 的 JSON：${stdout.slice(0, 200)}`)
}

let packStdout
try {
  packStdout = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
} catch (err) {
  fail(`npm pack --dry-run --json 执行失败：${err.message}`)
}

const files = parsePackJson(packStdout)

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
if (typeof pkg.version !== 'string' || pkg.version === '') {
  fail(`package.json 的 version 不可用：${JSON.stringify(pkg.version)}`)
}

const editionPath = path.join(root, 'dist', 'core', 'edition.js')
const editionSource = readFileSync(editionPath, 'utf8')

const problems = checkPack({ files, editionSource, pkgVersion: pkg.version })
if (problems.length > 0) {
  console.error('[check-pack] 发布产物门禁未通过：')
  for (const p of problems) console.error(`  · ${p}`)
  process.exit(1)
}

console.log(
  `[check-pack] 通过：${files.length} 个文件，含 skill 正文与 postinstall，版本 ${pkg.version} 已注入`,
)
