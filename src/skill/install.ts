// src/skill/install.ts —— `qiyu skill install` 的核心：把包内 skill 正文复制到实体目录、
// 按链接四态分派建立 agent 链接、写安装清单 `.qiyu-skill.json`。本文件是整个 skill
// 子项目里**唯一会写用户 home 目录**的代码，行为原则只有一条：**绝不静默覆盖用户改动**。
//
// 写入安全性（审查 C1/C2/I1 的落地形态——暂存 + 校验 + 逐文件 rename 换入）：
//   · 先暂存：正文与清单先复制进实体旁的暂存目录 `<entity>.tmp-XXXXXX`（`mkdtempSync`
//     生成，同父目录 ⇒ 同设备，rename 才必然成功），复制完做哈希校验。暂存阶段任何
//     失败都清掉暂存并抛错，实体一个字节不变——不存在「删了旧文件之后复制才失败」的
//     中间态。
//   · 后换入：暂存成功后才动实体，逐文件 `rename` 换入：目标是普通文件 → 原子替换
//     （POSIX rename 语义，没有先删后写的窗口）；缺失 → 换入；符号链接/目录/设备
//     → 一律不写、如实警告。rename 会替换符号链接本身、copy 会**写穿**符号链接
//     （2026-10-21 审查 WT1/WT2/WT3 实测），所以实体里与包内同名的任何非普通文件
//     都按「用户占用」处理。父目录链同样逐级验证——目录符号链接会让 rename 写进
//     实体之外（同样的写穿，换了个入口）。
//   · 清单最后换入：中途失败时实体里还是旧清单，重跑 --force 即收敛（已换入的文件
//     会被再次原子替换，幂等）。
//
// 决策表：
//   · 实体不存在 → 暂存后一次性 rename 换入，status='installed'；
//   · 实体「真空」（除根部清单外无任何条目；符号链接/子目录都算用户内容，审查 C1）
//     → 没有用户内容可保护，换入，status='installed'；
//   · 正文哈希一致、清单一致 → status='skipped'（幂等，一个字节不写）；
//   · 正文哈希一致、清单落后/损坏 → 只重写清单（清单损坏视为落后，不视为用户改动，
//     审查 M2），status='updated'；
//   · 哈希不同或**无法计算**（EACCES 等，审查 I4）、无 --force → 什么都不写，
//     status='skipped' + 警告提 --force；
//   · 同上但有 --force → 暂存 → 换入 → 清理「上一版有、本版没有」的受管文件
//     （审查 I2 采纳的更优方案：以上一版清单界定，而不是删一切包外文件；清单不可
//     识别则不清理、只警告；用户新增内容一律保留并警告），status='updated'。
//
// 链接按 `linkState` 四态分派（**不能直接 createSkillLink**：symlink 已存在时它抛
// EEXIST，2026-10-20 Task 7 实测）：
//   · ok       → 不碰，记 state='ok'；
//   · missing  → createSkillLink，成功记 'ok'；
//   · dangling → 先 unlink 再 createSkillLink（重建），成功记 'ok'；
//   · foreign  → 不覆盖，记 'foreign' + 警告「已被占用」。
// 链接阶段任何异常——建链失败、linkState 抛 ELOOP（自指循环链接不落四态，Task 7
// 实测）、agent 目录不可检查（ENOTDIR/EACCES）——都收敛进 warnings，不让整个安装
// 失败。ELOOP 这类「判定不了」的路径按 foreign 处理：不触碰、只报告，最保守的归类。
//
// 内容比较用 `contentHash`：对目录下所有普通文件按**相对路径（'/' 分隔）升序**，依次
// update「路径 + 换行 + 换行归一化后的内容」，SHA-256。定界符是必要的——没有它
// 「文件 a 内容 bc」与「文件 ab 内容 c」会拼出同一字节流（测试钉住）。`.qiyu-skill.json`
// 不参与哈希：否则 installed_at 每次安装都变，目标永远被判「内容不同」。源目录里的
// 符号链接既不复制也不参与哈希（复制与哈希同口径），因此不会造成幂等漂移。
//
// 分层：`skill/` 叶子层，只 import `node:*` 与 `core/`；不 import `commands/`。
// 测试通过 opts 注入 home，本文件不读真实环境。

import { createHash } from 'node:crypto'
import {
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, unlinkSync, writeFileSync,
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

/** 暂存目录前缀：`<entity>.tmp-`（`mkdtempSync` 在其后追加唯一随机后缀）。 */
const STAGING_SUFFIX = '.tmp-'

/**
 * `.qiyu-skill.json` 的语义：安装清单 + 版本标记，不是逐字节指纹（spec D8）。
 *
 * `files` 是**可选**扩展（审查 I2）：记录本次安装写入的受管文件相对路径列表，
 * 供下一次 --force 区分「上一版遗留」与「用户新增」。旧版清单没有该字段时视为
 * 「无法识别上一版」，清理阶段不删任何文件、只警告。
 */
export interface Manifest {
  version: string
  skill_contract_version: number
  content_hash: string
  installed_at: string
  files?: string[]
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
 * 对目录下所有普通文件算内容哈希：按相对路径（'/' 分隔）升序，依次 update
 * 「路径 + '\n' + 换行归一化后的内容」。
 *
 * 根部的 `.qiyu-skill.json` 不参与（清单是安装元数据，不是正文）；子目录里同名的
 * 文件仍参与——只有根部那份是清单。符号链接等非常规条目忽略（不受管内容）。
 *
 * 读取失败（EACCES/ELOOP 等）照常抛出：本函数只负责算，是否容错由调用方决定
 * （安装路径在 I4 处显式捕获）。
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
      // 符号链接等：不属于受管正文，忽略（复制同样跳过，两侧口径一致；
      // 源里的符号链接既不复制也不参与哈希，因此不会造成幂等漂移）。
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
 * `rel` 是否是一个**合法的、限定在实体目录内**的相对路径（审查 N1）。
 *
 * 清单 `files` 是**不可信输入**（用户可以编辑它、也可能被篡改），删除前必须当外部
 * 数据校验：绝对路径、盘符、`..` 段、空段（`a//b`）、`.` 段一律拒绝。只做字符串
 * 层面判定；符号链接父链造成的逃逸由 `verifyPlainParents` + `realpath` 复核兜住。
 */
function isContainedRel(rel: string): boolean {
  if (rel === '' || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false
  return rel.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

/**
 * 只读版的父链验证：`rel` 的每个父组件在 `base` 下都必须存在且是**真实目录**
 * （不是符号链接/文件）。与 `ensurePlainParents` 同一套判定，但**不创建**任何目录
 * ——删除路径绝不能有副作用。任一父组件缺失（返回 'missing'）或不是真实目录
 * （返回 false）即不可删除。
 */
function verifyPlainParents(base: string, rel: string): 'ok' | 'missing' | 'unsafe' {
  let cur = base
  for (const part of rel.split('/').slice(0, -1)) {
    cur = path.join(cur, part)
    let st
    try {
      st = lstatSync(cur)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return 'missing'
      return 'unsafe'
    }
    if (!st.isDirectory()) return 'unsafe'
  }
  return 'ok'
}

/**
 * `abs` 解析后是否仍在 `entityDir` 之内（两边都过 `realpath`，消掉符号链接与 `..`）。
 * 与父链验证互为双保险：父链判定的是「路径字符串逐级看是真实目录」，本函数判定
 * 的是「真实文件系统上最终落在哪里」。任一环节不确定（realpath 抛错）都按不安全处理。
 */
function isRealpathContained(entityDir: string, abs: string): boolean {
  try {
    const root = realpathSync(entityDir).toString()
    const target = realpathSync(abs).toString()
    const prefix = root.endsWith(path.sep) ? root : root + path.sep
    return target === root || target.startsWith(prefix)
  } catch {
    return false
  }
}

/**
 * 实体目录是否「真空」：除根部清单外**没有任何条目**。符号链接、子目录都算内容——
 * 用户把自己的笔记/私有片段以符号链接挂进实体目录是合理用法，不能当空目录删
 * （审查 C1，2026-10-21 实测：只含符号链接的实体被判空，链接被无警告删除）。
 */
function isVacuous(entityDir: string): boolean {
  return readdirSync(entityDir).filter((n) => n !== MANIFEST).length === 0
}

/**
 * 递归复制源目录到目标目录（不转换换行：复制是逐字节的）。根部 `.qiyu-skill.json`
 * 不复制——清单由安装逻辑自己写，源里即使有一份也不该被带进目标。源里的符号链接
 * 不复制（与 `listFiles` 同口径：不受管内容，不参与哈希）。
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

/** 写安装清单（覆盖）。`installed_at` 用 ISO 8601，便于人读与机器解析。 */
function writeManifest(
  dir: string,
  version: string,
  contentHashValue: string,
  files: string[],
): void {
  const manifest: Manifest = {
    version,
    skill_contract_version: SKILL_CONTRACT_VERSION,
    content_hash: contentHashValue,
    installed_at: new Date().toISOString(),
    files,
  }
  writeFileSync(path.join(dir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n')
}

/**
 * 读清单；缺失、JSON 损坏或字段不全都返回 null（安装逻辑据此判断「需要重写」）。
 *
 * 清单损坏/缺失一律**视为清单落后**（重写即可），不视为用户改动——它不是正文，
 * 用户没有理由手工编辑它；把它当用户改动会让安装永远卡在 skipped（审查 M2）。
 *
 * `files` 是**不可信输入**（用户可编辑、也可能被篡改）：解析时先过 `isContainedRel`，
 * 非法条目（绝对路径 / 含 `..` / 空段）直接丢弃。非法条目意味着清单被动过手脚，
 * 整份清单按「落后」处理（返回 null）比只丢几个条目更安全——否则一份被篡改的清单
 * 仍会被当作「上一版的准确记录」，清理范围就建立在不可信数据上（审查 N1）。
 */
function readManifestSafe(entityDir: string): Manifest | null {
  try {
    const raw = JSON.parse(readFileSync(path.join(entityDir, MANIFEST), 'utf8')) as Partial<Manifest>
    if (
      typeof raw.version === 'string'
      && typeof raw.skill_contract_version === 'number'
      && typeof raw.content_hash === 'string'
      && typeof raw.installed_at === 'string'
    ) {
      let files: string[] | undefined
      if (Array.isArray(raw.files)) {
        if (!raw.files.every((f) => typeof f === 'string' && isContainedRel(f))) return null
        files = raw.files as string[]
      }
      return { ...raw as Manifest, files }
    }
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

/** 实体目录根部是否存在清单文件（不论内容是否可读——存在就是「有上一版」）。 */
function manifestExists(entityDir: string): boolean {
  try {
    lstatSync(path.join(entityDir, MANIFEST))
    return true
  } catch {
    return false
  }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * 保证 `rel` 的父目录链在 `base` 下都是**真实目录**（不是符号链接/文件）。
 * 缺的目录建出来；遇到非目录返回 false——目录符号链接会让后续 rename 写进实体
 * 之外（与 C2 同一类写穿，只是换了入口）。
 */
function ensurePlainParents(base: string, rel: string, warnings: string[]): boolean {
  let cur = base
  for (const part of rel.split('/').slice(0, -1)) {
    cur = path.join(cur, part)
    let st
    try {
      st = lstatSync(cur)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) { mkdirSync(cur); continue }
      warnings.push(`检查目录 ${cur} 失败（${errMsg(err)}），未写入 ${rel}`)
      return false
    }
    if (!st.isDirectory()) {
      warnings.push(`实体目录中 ${path.relative(base, cur)} 不是真实目录（符号链接/文件），未写入 ${rel}`)
      return false
    }
  }
  return true
}

/**
 * 把暂存目录里的文件逐个 `rename` 换入实体。目标不存在 → 换入；目标是普通文件 →
 * **原子替换**（POSIX rename 语义，没有先删后写的窗口）；目标是符号链接/目录/设备
 * → 一律不写并警告——`rename` 会替换链接本身、`copyFile` 会写穿链接（审查 C2
 * WT1/WT2/WT3 实测），两种形态都会伤到用户数据，统一按「用户占用」处理。
 *
 * 单个文件失败只警告，不中断（其余文件照常换入）。返回是否**全部**换入成功——
 * 调用方据此决定要不要换清单：有文件没写进去时清单保持上一版，下一次安装的
 * 漂移探测才能如实报 stale（否则清单按「应该装上」的内容谎报 current）。
 */
function swapIn(staging: string, entityDir: string, rels: string[], warnings: string[]): boolean {
  let complete = true
  for (const rel of rels) {
    if (!ensurePlainParents(entityDir, rel, warnings)) { complete = false; continue }
    const to = joinRel(entityDir, rel)
    if (!isSafeWriteTarget(to, `目标 ${rel} `, warnings)) { complete = false; continue }
    try {
      renameSync(joinRel(staging, rel), to)
    } catch (err) {
      complete = false
      warnings.push(`写入 ${rel} 失败（${errMsg(err)}）：${to}`)
    }
  }
  return complete
}

/**
 * 清理「上一版安装过、本版不再有」的受管文件（审查 I2 采纳的方案：以清单里的
 * `files` 界定，而不是删一切包外文件）。用户新增的文件一律保留并警告；上一版
 * 受管文件若已被用户换成符号链接/目录，也不动。
 *
 * 旧清单没有 `files`（本任务之前的安装）→ 无法识别上一版，**不删任何东西**，
 * 只把包外文件列进警告。
 */
function cleanupPreviousManaged(
  entityDir: string,
  prevFiles: string[] | undefined,
  newFiles: string[],
  warnings: string[],
): void {
  const keep = new Set(newFiles)
  if (prevFiles === undefined) {
    const extra = listFiles(entityDir).filter((f) => !keep.has(f))
    if (extra.length > 0) {
      warnings.push(`实体目录中存在不在包内的文件（无法确认是否为上一版遗留，均未删除）：${extra.join('、')}`)
    }
    return
  }

  const prev = new Set(prevFiles)
  const removed: string[] = []
  for (const rel of prevFiles) {
    if (keep.has(rel)) continue
    // —— 纵深防御（审查 N1）：清单是外部数据，删除前逐层复核 ——
    // ① 字符串层：必须是实体内的相对路径（readManifestSafe 已过滤，这里再拦一次）。
    if (!isContainedRel(rel)) {
      warnings.push(`清单 files 含非法路径（绝对路径或路径逃逸），拒绝删除：${rel}`)
      continue
    }
    const abs = joinRel(entityDir, rel)
    // ② 父链层：lstat/unlink 的父组件会顺着符号链接解析——references 是指向个人
    //    目录的链接时，unlink 会删到实体之外。父链必须全是真实目录；父链缺失说明
    //    文件早已不存在，静默跳过。
    const parents = verifyPlainParents(entityDir, rel)
    if (parents === 'missing') continue
    if (parents === 'unsafe') {
      warnings.push(`上一版安装的 ${rel} 所在路径含符号链接或非目录组件，拒绝删除（可能指向实体之外）`)
      continue
    }
    let st
    try {
      st = lstatSync(abs)
    } catch (err) {
      if (isErrno(err, 'ENOENT') || isErrno(err, 'ENOTDIR')) continue
      warnings.push(`检查 ${rel} 失败（${errMsg(err)}），未删除`)
      continue
    }
    if (!st.isFile()) {
      warnings.push(`上一版安装的 ${rel} 已被用户替换为非普通文件，保留不动：${abs}`)
      continue
    }
    // ③ 终点层：解析后的真实位置必须仍在实体目录之内（与父链检查互为双保险）。
    if (!isRealpathContained(entityDir, abs)) {
      warnings.push(`上一版安装的 ${rel} 解析后不在实体目录内，拒绝删除：${abs}`)
      continue
    }
    try {
      unlinkSync(abs)
      removed.push(rel)
    } catch (err) {
      warnings.push(`删除上一版文件 ${rel} 失败（${errMsg(err)}）`)
    }
  }
  if (removed.length > 0) {
    // 删除用户可见的文件必须说出来：--force 是「覆盖」授权，删除仍要如实报告。
    warnings.push(`移除了上一版安装、本版不再包含的文件：${removed.join('、')}`)
  }

  const extra = listFiles(entityDir).filter((f) => !keep.has(f) && !prev.has(f))
  if (extra.length > 0) {
    warnings.push(`保留了实体目录中不在包内的文件（可能是用户新增）：${extra.join('、')}`)
  }
}

/**
 * 最终写入路径的安全门（审查 C2）：缺失或普通文件 → 可写（rename 原子替换/覆盖）；
 * 符号链接/目录/设备 → 一律不写，警告并说明原因。`copyFile` 会写穿符号链接、
 * `rename` 会替换链接本身——实体里与包内路径重合的任何非普通文件都按「用户占用」
 * 处理，无论是否有 --force。
 */
function isSafeWriteTarget(p: string, what: string, warnings: string[]): boolean {
  let st
  try {
    st = lstatSync(p)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return true
    warnings.push(`检查${what} ${p} 失败（${errMsg(err)}），未写入`)
    return false
  }
  if (!st.isFile()) {
    warnings.push(`${what}已被非普通文件占用（符号链接/目录等），不覆盖、保留用户内容：${p}`)
    return false
  }
  return true
}

/**
 * 确定要安装后的写盘路径（审查 I1/I3 的落地）：先在实体旁的暂存目录完成
 * 「复制 + 哈希校验 + 写清单」，全部成功之后才动实体——暂存阶段任何失败都清掉
 * 暂存并抛错，实体一个字节不变；不存在「先删旧文件、复制才失败」的中间态。
 *
 * 暂存位用 `mkdtempSync`（`<entity>.tmp-XXXXXX`）而不是固定 pid 后缀：防御性
 * `rmSync` 面对同名**真实目录**（用户恰好放了这么个目录）时会把里面的用户文件
 * 一起递归删掉（复审 N2 实测）；`mkdtemp` 保证路径必然是本次新建的空目录，
 * 「同名目录」这个面从根上消失。同父目录 ⇒ 同设备，rename 必然可行。
 *
 * 首次安装（实体不存在）：整个暂存目录一次性 `rename` 换入（同设备，原子）。
 * 覆盖安装：逐文件 `rename` 换入（每个文件原子），清单**最后**换入——中途失败时
 * 实体里还是旧清单，重跑 --force 即收敛；清单换入失败也只警告（正文已就位，
 * 下次安装会再补清单）。
 */
function writeInstalled(
  entityDir: string,
  sourceDir: string,
  sourceFiles: string[],
  version: string,
  sourceHash: string,
  warnings: string[],
  prevFiles?: string[],
): void {
  // 清单此刻是否存在（复审 Minor：「保持上一版」的措辞只在真有上一版清单时成立；
  // 首次安装中途被占用根本没写过清单，措辞要区分开）。必须在动实体**之前**判断。
  const hadPrevManifest = manifestExists(entityDir)

  let staging: string | undefined
  try {
    // mkdir/暂存位创建/复制/校验/清单全部算「暂存阶段」：任何一步失败都清掉暂存并
    // 抛错，实体一个字节不变（审查 I1 的「先全部复制成功再动实体」）。暂存位创建
    // 失败（父目录不可写等）同样包进这段文案，不给调用方裸 EACCES。
    mkdirSync(path.dirname(entityDir), { recursive: true })
    staging = mkdtempSync(`${entityDir}${STAGING_SUFFIX}`)
    copyTree(sourceDir, staging)
    if (contentHash(staging) !== sourceHash) {
      throw new Error('暂存内容与源不一致（防御性校验失败）')
    }
    writeManifest(staging, version, sourceHash, sourceFiles)
  } catch (err) {
    if (staging !== undefined) rmSync(staging, { recursive: true, force: true })
    throw new Error(`安装中断：暂存目录写入失败（${errMsg(err)}），实体目录未被改动：${entityDir}`)
  }

  try {
    let entityExists: boolean
    try {
      lstatSync(entityDir)
      entityExists = true
    } catch (err) {
      if (!isErrno(err, 'ENOENT')) throw err
      entityExists = false
    }
    if (!entityExists) {
      mkdirSync(path.dirname(entityDir), { recursive: true })
      renameSync(staging, entityDir)
      return
    }
    const complete = swapIn(staging, entityDir, sourceFiles, warnings)
    cleanupPreviousManaged(entityDir, prevFiles, sourceFiles, warnings)
    if (!complete) {
      // 有文件没能换入（被占用/失败）：清单不换入，如实反映「实际装上的仍是旧内容」。
      // 下一次安装因此会报内容不同并提示 --force；用户清掉占用后重跑即可收敛。
      warnings.push(
        hadPrevManifest
          ? '本次未能完整写入（有文件被占用或写入失败），安装清单保持上一版'
          : '本次未能完整写入（有文件被占用或写入失败），安装清单未写入；清掉占用后重跑安装即可补全',
      )
      return
    }
    if (isSafeWriteTarget(path.join(entityDir, MANIFEST), '清单', warnings)) {
      renameSync(path.join(staging, MANIFEST), path.join(entityDir, MANIFEST))
    }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/**
 * 安装 skill。流程见文件头决策表。链接阶段的任何异常都进 warnings，不向上抛；
 * 只有「源目录不可用」「实体路径被文件占用」「暂存写入失败」这类无法继续的情况
 * 才抛错（调用方 Task 11 会转成 internal 错误信封）。
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

  let sourceFiles: string[]
  let sourceHash: string
  try {
    sourceFiles = listFiles(sourceDir)
    sourceHash = contentHash(sourceDir)
  } catch (err) {
    // 源目录存在但内容不可读（权限等）：源是包内内容，读不了就是硬错误，
    // 但给出比裸 EACCES 更能定位问题的文案。
    throw new Error(`skill 源目录不可读：${sourceDir}（${errMsg(err)}）`)
  }
  let status: InstallResult['status']

  if (!isDirectory(entityDir)) {
    let exists = true
    try {
      lstatSync(entityDir)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) exists = false
      else throw err
    }
    if (exists) throw new Error(`实体路径已存在但不是目录：${entityDir}`)
    writeInstalled(entityDir, sourceDir, sourceFiles, version, sourceHash, warnings)
    status = 'installed'
  } else {
    // —— 分类（审查 I4：分类读取可能因 EACCES 等抛错；失败按「内容不同」处理，
    // 让 --force 仍然可用、无 force 则跳过 + 警告，不把用户卡死） ——
    let vacuous = false
    let targetHash: string | null = null
    let readError: unknown = null
    try {
      vacuous = isVacuous(entityDir)
      if (!vacuous) targetHash = contentHash(entityDir)
    } catch (err) {
      readError = err
    }

    if (vacuous) {
      // 真空（审查 C1 判据：除根部清单外无任何条目）——没有用户内容可保护，按首次安装换入。
      const prev = readManifestSafe(entityDir)
      writeInstalled(entityDir, sourceDir, sourceFiles, version, sourceHash, warnings, prev?.files)
      status = 'installed'
    } else if (targetHash === sourceHash) {
      const m = readManifestSafe(entityDir)
      if (
        m !== null
        && m.version === version
        && m.skill_contract_version === SKILL_CONTRACT_VERSION
        && m.content_hash === sourceHash
      ) {
        status = 'skipped' // 幂等：一个字节都不写
      } else {
        // 审查 M2：清单损坏/字段缺失/旧格式视为「落后」，不视为用户改动——它不是
        // 正文，损坏不构成保护对象；正文哈希一致已证明正文未被改动。只重写清单
        // （否则 Task 10 的漂移探测会永远报 stale）。
        if (isSafeWriteTarget(path.join(entityDir, MANIFEST), '清单', warnings)) {
          writeManifest(entityDir, version, sourceHash, sourceFiles)
          status = 'updated'
        } else {
          status = 'skipped' // 清单被占用：正文一致，用户处理占用后重跑即可
        }
      }
    } else if (force) {
      const prev = readManifestSafe(entityDir)
      writeInstalled(entityDir, sourceDir, sourceFiles, version, sourceHash, warnings, prev?.files)
      status = 'updated'
    } else {
      const reason = readError !== null
        ? `读取实体目录内容失败（${errMsg(readError)}）`
        : '实体目录内容与包内不同（可能被手工修改）'
      status = 'skipped'
      warnings.push(`${reason}，未覆盖；确认后可用 --force 覆盖：${entityDir}`)
    }
  }

  // —— 链接：按四态分派；任何失败都收敛进 warnings ——
  if (!noLink) await linkAgents(opts, entityDir, links, warnings)

  return { entityDir, status, links, warnings }
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
    let dirOk: boolean
    try {
      dirOk = isDirectory(dir)
    } catch (err) {
      // 审查 M1：agent 目录不可检查（EACCES 等）时收敛进 warnings，不让安装失败。
      warnings.push(`检查 ${agent} 的 skills 目录失败（${errMsg(err)}），跳过建链：${dir}`)
      links.push({ agent, path: path.join(dir, LINK_NAME), state: 'missing' })
      continue
    }
    if (!dirOk) {
      // 不替用户创建 agent 目录（spec D1）。显式点名的目录不存在要说出来；
      // links 里补 missing 条目，Task 11 逐 agent 展示状态时不缺行（审查 M3）。
      warnings.push(`${agent} 的 skills 目录不存在，跳过建链：${dir}`)
      links.push({ agent, path: path.join(dir, LINK_NAME), state: 'missing' })
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
