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
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPack, parsePackJson } from './pack-gate.mjs'

/** 仓库根：本脚本在 `<root>/scripts/` 下，向上两级。不依赖 cwd。 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function fail(message) {
  console.error(`[check-pack] 错误：${message}`)
  process.exit(1)
}

/** 递归列出目录下的 `.md`（相对路径，`/` 分隔）；目录不存在返回空数组。 */
function listSourceDocs(dir, prefix = '') {
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return []
  }
  const out = []
  for (const ent of entries) {
    if (ent.name.startsWith('.')) continue
    const rel = prefix === '' ? ent.name : `${prefix}/${ent.name}`
    if (ent.isDirectory()) out.push(...listSourceDocs(path.join(dir, ent.name), rel))
    else if (ent.isFile() && ent.name.endsWith('.md')) out.push(rel)
  }
  return out
}

let packStdout
try {
  // ⚠️ Windows（复审 F8）：`execFileSync('npm.cmd', …)` **不行** —— Node 自 CVE-2024-27980
  // 起在 `_WIN32` 下对 `.bat`/`.cmd` 且 `shell` 未设时直接返回 `UV_EINVAL`
  // （`process_wrap.cc` / `spawn_sync.cc`），libuv 的 PATH 搜索也不追加 `.cmd`。
  // 正确形态是走 shell（`cmd.exe` 会按 PATHEXT 找到 npm.cmd）。shell 模式下参数由
  // shell 解析，所以这里传**拼好的整条命令**而不是数组，避免 DEP0190 的转义歧义。
  const isWin = process.platform === 'win32'
  const cmd = 'npm pack --dry-run --json'
  packStdout = execFileSync(isWin ? 'cmd.exe' : 'npm', isWin ? ['/d', '/s', '/c', cmd] : ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  })
} catch (err) {
  fail(`npm pack --dry-run --json 执行失败：${err.message}`)
}

let files
try {
  files = parsePackJson(packStdout)
} catch (err) {
  fail(err instanceof Error ? err.message : String(err))
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
if (typeof pkg.version !== 'string' || pkg.version === '') {
  fail(`package.json 的 version 不可用：${JSON.stringify(pkg.version)}`)
}

// 包内应有哪些 skill 正文：以**源码目录**为事实源（copy-assets 原样拷过去）。
// 逐文件比对而不是数数量（终审 F9：6 篇缺 5 篇时数量判据仍绿）。
const sourceDocs = listSourceDocs(path.join(root, 'src', 'skill', 'qiyu'))
if (sourceDocs.length === 0) fail('src/skill/qiyu 下找不到任何 .md（源码正文缺失）')
const expectedSkillDocs = sourceDocs.map((rel) => `dist/skill/qiyu/${rel}`)

const editionPath = path.join(root, 'dist', 'core', 'edition.js')
const editionSource = readFileSync(editionPath, 'utf8')

const problems = checkPack({ files, editionSource, pkgVersion: pkg.version, expectedSkillDocs })
if (problems.length > 0) {
  console.error('[check-pack] 发布产物门禁未通过：')
  for (const p of problems) console.error(`  · ${p}`)
  process.exit(1)
}

console.log(
  `[check-pack] 通过：${files.length} 个文件，含 ${expectedSkillDocs.length} 篇 skill 正文与 postinstall，版本 ${pkg.version} 已注入`,
)
