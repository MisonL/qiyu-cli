// src/skill/install.ts —— `qiyu skill install` 的核心：把包内 skill 正文复制到实体目录、
// 按链接四态分派建立 agent 链接、写安装清单 `.qiyu-skill.json`。本文件是整个 skill
// 子项目里**唯一会写用户 home 目录**的代码，所以行为原则只有一条：**绝不静默覆盖
// 用户改动**。
//
// 决策表（brief Step 3）：
//   · 实体目录不存在 / 存在但没有正文文件 → 复制 + 写清单，status='installed'；
//   · 正文哈希与源一致、清单也一致 → 什么都不写，status='skipped'（幂等）；
//   · 正文哈希一致但清单版本/契约版本落后 → 只重写清单，status='updated'
//     （否则 Task 10 的漂移探测会永远报 stale——内容明明没变）；
//   · 正文哈希不同且未给 --force → 不动任何文件，status='skipped' + 警告提到 --force；
//   · 正文哈希不同且给了 --force → 覆盖正文、清理上一版遗留文件（列进警告，不静默）、
//     重写清单，status='updated'。
//
// 链接按 `linkState` 四态分派（**不能直接 createSkillLink**：symlink 已存在时它抛
// EEXIST，2026-10-20 Task 7 实测）：
//   · ok       → 不碰，记 state='ok'；
//   · missing  → createSkillLink，成功记 'ok'；
//   · dangling → 先 unlink 再 createSkillLink（重建），成功记 'ok'；
//   · foreign  → 不覆盖，记 'foreign' + 警告「已被占用」。
// 任何链接创建失败、或 linkState 抛异常（自指循环链接的 ELOOP 不落四态；Task 7 实测）
// 都收敛进 warnings，不让整个安装失败——实体已经就位，链接可以下次再修。
// ELOOP 这类「判定不了」的路径按 foreign 处理：不触碰、只报告，这是最保守的归类。
//
// 内容比较用 `contentHash`：对目录下所有文件按**相对路径（'/' 分隔）升序**，依次
// update「路径 + '\n' + 换行归一化后的内容」，SHA-256。'\n' 是必要的定界符——没有它
// 「文件 a 内容 bc」与「文件 ab 内容 c」会拼出同一字节流（测试钉住）。`.qiyu-skill.json`
// 不参与哈希：否则 installed_at 每次安装都变，目标永远被判「内容不同」。
//
// 分层：`skill/` 叶子层，只 import `node:*` 与 `core/`；不 import `commands/`。
// 测试通过 opts 注入 home，本文件不读真实环境。

import { createHash } from 'node:crypto'
import {
  copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { SKILL_CONTRACT_VERSION } from '../core/edition.js'
import {
  agentSkillDirs, createSkillLink, defaultEntityDir, linkState, linkTarget, normalizeNewlines,
  type LinkState,
} from './paths.js'

/** 安装清单文件名：落在实体目录根部，记录版本与内容哈希（Task 10 的安装态探测读它）。 */
export const MANIFEST = '.qiyu-skill.json'

/** agent skills 目录下的链接名。skill 身份固定为 `qiyu`（正文 frontmatter 同名），不随实体位置变化。 */
const LINK_NAME = 'qiyu'

/** `.qiyu-skill.json` 的语义：安装清单 + 版本标记，不是逐字节指纹（spec D8）。 */
export interface Manifest {
  version: string
  skill_contract_version: number
  content_hash: string
  installed_at: string
}

export interface InstallResult {
  entityDir: string
  status: 'installed' | 'skipped' | 'updated'
  links: { agent: string; path: string; state: LinkState }[]
  warnings: string[]
}

/**
 * `entityDir` 是 brief 接口之外的**扩展**（可选、缺省 `defaultEntityDir(home)`）：
 * Task 11 的 `--dir` / `QIYU_SKILL_DIR` 需要一个通道把自定义实体位置传进来，
 * 否则 `skill install --dir <path>` 无从实现。缺省行为与 brief 完全一致。
 */
export interface InstallOptions {
  home: string
  sourceDir: string
  version: string
  force: boolean
  entityDir?: string
  linkDirs?: string[]
  noLink?: boolean
}

/**
 * 对目录下所有文件（递归，普通文件）算内容哈希：按相对路径（'/' 分隔）升序，
 * 依次 update「路径 + '\n' + 换行归一化后的内容」。
 *
 * 根部的 `.qiyu-skill.json` 不参与（清单是安装元数据，不是正文）；子目录里同名的
 * 文件仍参与——只有根部那份是清单。符号链接等非常规条目忽略（不受管内容）。
 */
export function contentHash(dir: string): string {
  const hash = createHash('sha256')
  for (const rel of listFiles(dir)) {
    // 路径后补 '\n' 定界：没有它，「文件 a + 内容 bc」与「文件 ab + 内容 c」
    // 会拼出同一字节流（测试钉住）。文件名不含换行时定界无歧义。
    hash.update(rel + '\n')
    hash.update(normalizeNewlines(readFileSync(joinRel(dir, rel))))
  }
  return hash.digest('hex')
}

/** 递归列出目录下普通文件的相对路径（'/' 分隔），升序排序；根部清单除外。 */
function listFiles(dir: string): string[] {
  const out: string[] = []
  const walk = (abs: string, rel: string): void => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`
      if (rel === '' && ent.name === MANIFEST) continue
      if (ent.isDirectory()) walk(path.join(abs, ent.name), childRel)
      else if (ent.isFile()) out.push(childRel)
      // 符号链接等：不属于受管正文，忽略（复制同样跳过，两侧口径一致）。
    }
  }
  walk(dir, '')
  return out.sort()
}

/** 把相对路径（'/' 分隔）还原为平台路径。 */
function joinRel(root: string, rel: string): string {
  return path.join(root, ...rel.split('/'))
}

/**
 * 递归复制源目录到目标目录（不转换换行：复制是逐字节的）。根部 `.qiyu-skill.json`
 * 不复制——清单由安装逻辑自己写，源里即使有一份也不该被带进目标。
 */
function copyTree(src: string, dest: string, isRoot = true): void {
  mkdirSync(dest, { recursive: true })
  for (const ent of readdirSync(src, { withFileTypes: true })) {
    if (isRoot && ent.name === MANIFEST) continue
    const from = path.join(src, ent.name)
    const to = path.join(dest, ent.name)
    if (ent.isDirectory()) copyTree(from, to, false)
    else if (ent.isFile()) copyFileSync(from, to)
  }
}

/**
 * 删除目标目录里不属于本次源文件集合的正文文件，返回被删的相对路径。
 * 只删普通文件（根部清单除外）；目录留着（空目录不参与哈希，无害）。
 * 仅在「本次确实要写盘」（首次安装 / --force 覆盖）时调用。
 */
function removeExtraneous(entityDir: string, keep: Set<string>): string[] {
  const removed: string[] = []
  const walk = (abs: string, rel: string): void => {
    for (const ent of readdirSync(abs, { withFileTypes: true })) {
      const childRel = rel === '' ? ent.name : `${rel}/${ent.name}`
      const childAbs = path.join(abs, ent.name)
      if (ent.isDirectory()) { walk(childAbs, childRel); continue }
      if (rel === '' && ent.name === MANIFEST) continue
      if (!keep.has(childRel)) { unlinkSync(childAbs); removed.push(childRel) }
    }
  }
  walk(entityDir, '')
  return removed
}

/** 写安装清单（覆盖）。`installed_at` 用 ISO 8601，便于人读与机器解析。 */
function writeManifest(entityDir: string, version: string, contentHashValue: string): void {
  const manifest: Manifest = {
    version,
    skill_contract_version: SKILL_CONTRACT_VERSION,
    content_hash: contentHashValue,
    installed_at: new Date().toISOString(),
  }
  writeFileSync(path.join(entityDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
}

/** 读清单；缺失、JSON 损坏或字段不全都返回 null（安装逻辑据此判断「需要重写」）。 */
function readManifestSafe(entityDir: string): Manifest | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(entityDir, MANIFEST), 'utf8')) as Partial<Manifest>
    if (
      typeof raw.version === 'string'
      && typeof raw.skill_contract_version === 'number'
      && typeof raw.content_hash === 'string'
      && typeof raw.installed_at === 'string'
    ) return raw as Manifest
    return null
  } catch {
    return null
  }
}

/** 判定路径是否存在且是目录；不存在或不是目录返回 false，其余错误照常抛。 */
function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return false
    throw err
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 安装 skill。流程见文件头决策表。链接阶段的任何异常都进 warnings，不向上抛；
 * 只有「源目录不可用」「实体路径被文件占用」这类无法继续的情况才抛错
 * （调用方 Task 11 会转成 internal 错误信封）。
 */
export async function installSkill(opts: InstallOptions): Promise<InstallResult> {
  const { home, sourceDir, version, force, noLink = false } = opts
  const entityDir = opts.entityDir ?? defaultEntityDir(home)
  const warnings: string[] = []
  const links: InstallResult['links'] = []

  // —— 源目录校验 ——
  let srcIsDir: boolean
  try {
    srcIsDir = statSync(sourceDir).isDirectory()
  } catch (err) {
    if (isErrno(err, 'ENOENT')) throw new Error(`skill 源目录不存在：${sourceDir}`)
    throw err
  }
  if (!srcIsDir) throw new Error(`skill 源目录不是目录：${sourceDir}`)

  // —— 实体目录：三态判定 ——
  const sourceFiles = listFiles(sourceDir)
  const sourceHash = contentHash(sourceDir)
  let status: InstallResult['status']

  if (!isDirectory(entityDir)) {
    // 不存在，或被文件占用。后者明确抛错，绝不覆盖。
    let exists = true
    try { lstatSync(entityDir) } catch (err) { if (isErrno(err, 'ENOENT')) exists = false; else throw err }
    if (exists) throw new Error(`实体路径已存在但不是目录：${entityDir}`)
    writeAll(entityDir, sourceDir, sourceFiles, version, sourceHash, warnings)
    status = 'installed'
  } else {
    const targetFiles = listFiles(entityDir)
    if (targetFiles.length === 0) {
      // 空目录（可能只留着上次失败写的清单）：没有用户内容可保护，按首次安装处理。
      writeAll(entityDir, sourceDir, sourceFiles, version, sourceHash, warnings)
      status = 'installed'
    } else if (contentHash(entityDir) === sourceHash) {
      const m = readManifestSafe(entityDir)
      if (
        m !== null
        && m.version === version
        && m.skill_contract_version === SKILL_CONTRACT_VERSION
        && m.content_hash === sourceHash
      ) {
        status = 'skipped' // 幂等：一个字节都不写
      } else {
        // 正文一致、清单落后（如 CLI 升级但 skill 未变）：只补清单，正文不动。
        writeManifest(entityDir, version, sourceHash)
        status = 'updated'
      }
    } else if (force) {
      writeAll(entityDir, sourceDir, sourceFiles, version, sourceHash, warnings)
      status = 'updated'
    } else {
      status = 'skipped'
      warnings.push(
        `实体目录内容与包内不同，未覆盖（可能被手工修改）；确认后可用 --force 覆盖：${entityDir}`,
      )
    }
  }

  // —— 链接：按四态分派；任何失败都收敛进 warnings ——
  if (!noLink) await linkAgents(opts, entityDir, links, warnings)

  return { entityDir, status, links, warnings }
}

/** 写盘（首次安装与 --force 覆盖共用）：清理遗留文件 → 复制 → 写清单。 */
function writeAll(
  entityDir: string,
  sourceDir: string,
  sourceFiles: string[],
  version: string,
  sourceHash: string,
  warnings: string[],
): void {
  mkdirSync(entityDir, { recursive: true })
  const removed = removeExtraneous(entityDir, new Set(sourceFiles))
  copyTree(sourceDir, entityDir)
  writeManifest(entityDir, version, sourceHash)
  if (removed.length > 0) {
    // 删除用户可见的文件必须说出来：--force 是「覆盖」授权，但删除仍要如实报告。
    warnings.push(`覆盖安装时移除了上一版遗留的文件：${removed.join('、')}`)
  }
}

/** 对每个 agent 目录按 linkState 四态分派建链，结果与失败原因都写进 links/warnings。 */
async function linkAgents(
  opts: InstallOptions,
  entityDir: string,
  links: InstallResult['links'],
  warnings: string[],
): Promise<void> {
  const { home, linkDirs } = opts

  // 目录 → agent 名映射：默认探测直接用探测结果的 name；显式 linkDirs 查映射表，
  // 查不到（自定义目录）就把目录路径本身当 agent 标识，保证 links[].agent 可追溯。
  let dirs: { dir: string; agent: string }[]
  if (linkDirs !== undefined) {
    const nameOf = new Map<string, string>()
    try {
      for (const a of agentSkillDirs(home)) nameOf.set(a.dir, a.name)
    } catch {
      // 映射失败只影响 links[].agent 的可读性，不影响建链，静默退回目录路径。
    }
    dirs = linkDirs.map((dir) => ({ dir, agent: nameOf.get(dir) ?? dir }))
  } else {
    try {
      dirs = agentSkillDirs(home).map((a) => ({ dir: a.dir, agent: a.name }))
    } catch (err) {
      // ~/.claude 是文件时 lstat 抛 ENOTDIR（Task 7 实测）：收敛，不让整个安装失败。
      warnings.push(`探测 agent skills 目录失败（${errMsg(err)}），本次不建链接`)
      return
    }
  }

  for (const { dir, agent } of dirs) {
    if (!isDirectory(dir)) {
      // 不替用户创建 agent 目录（spec D1）。显式点名的目录不存在要说出来。
      warnings.push(`${agent} 的 skills 目录不存在，跳过建链：${dir}`)
      continue
    }
    const linkPath = path.join(dir, LINK_NAME)

    let state: LinkState
    try {
      state = linkState(linkPath, entityDir)
    } catch (err) {
      // ELOOP（自指/成环链接）等不落四态（Task 7 实测）。判定不了的路径按 foreign
      // 处理：不触碰、只报告——这是四态里最保守的归类。
      warnings.push(`无法判定 ${agent} 链接状态（${errMsg(err)}），按占用处理、不触碰：${linkPath}`)
      links.push({ agent, path: linkPath, state: 'foreign' })
      continue
    }

    if (state === 'ok') {
      links.push({ agent, path: linkPath, state })
    } else if (state === 'foreign') {
      warnings.push(`${agent} 的链接路径已被占用（不是指向本 skill 的链接），不覆盖：${linkPath}`)
      links.push({ agent, path: linkPath, state })
    } else {
      // missing / dangling：建链；dangling 必须先删（createSkillLink 遇已存在路径抛 EEXIST）。
      try {
        if (state === 'dangling') unlinkSync(linkPath)
        await createSkillLink(linkPath, linkTarget(dir, entityDir))
        links.push({ agent, path: linkPath, state: 'ok' })
      } catch (err) {
        warnings.push(`${agent} 建链失败（${errMsg(err)}）：${linkPath}`)
        // 如实报告失败后的真实状态（dangling 已删但建失败 → missing；删失败 → 仍 dangling）。
        links.push({ agent, path: linkPath, state: recheckState(linkPath, entityDir, state) })
      }
    }
  }
}

/** 建链失败后重新判定状态；判定本身再抛（ELOOP 等）就退回尝试前的状态。 */
function recheckState(linkPath: string, entityDir: string, fallback: LinkState): LinkState {
  try {
    return linkState(linkPath, entityDir)
  } catch {
    return fallback
  }
}
