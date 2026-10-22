// src/skill/install.ts —— `qiyu skill install` 的核心：把包内 skill 正文复制到实体目录、
// 按链接四态分派建立 agent 链接、写安装清单 `.qiyu-skill.json`。本文件是整个 skill
// 子项目里**唯一会写用户 home 目录**的代码，行为原则只有一条：**绝不静默覆盖用户改动**。
//
// 写入安全性（审查 C1/C2/I1 的落地形态——暂存 + 校验 + 逐文件 rename 换入）：
//   · 先暂存：正文与清单先复制进暂存目录 `<entity>.tmp-XXXXXX`（`mkdtempSync`
//     生成），复制完做哈希校验。暂存阶段任何失败都清掉暂存并抛错，实体一个字节
//     不变——不存在「删了旧文件之后复制才失败」的中间态。
//   · 暂存位与实体**同设备**：暂存目录落在实体目录**真实落点**的父目录
//     （`realpath(entityDir)` 的 dirname）。实体目录本身可能是指向网盘/大盘的
//     符号链接（detect 明确认可这种形态），按字面路径建暂存会落在 home 所在卷
//     上，换入时跨卷 EXDEV、每个文件都写失败却报「已更新」（2026-10-22 审查 B2
//     实测）。设备判断万一仍不一致时，`renameSync` 捕获 EXDEV 降级为
//     「复制 → 删源」并**如实警告**。
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
//   · **status 反映实际写盘结果**（2026-10-22 审查 B2）：计划说要写、实际一个文件
//     都没写进去时，status 退回 'skipped' 并附明确警告——「报 updated 但实体零变化」
//     是对 Agent 的谎报。
//
// 链接按 `linkState` 四态分派（**不能直接 createSkillLink**：symlink 已存在时它抛
// EEXIST，2026-10-20 Task 7 实测）：
//   · ok       → 不碰，记 state='ok'；
//   · missing  → createSkillLink，成功后**复核** linkState，非 ok 不得报 ok
//     （审查 B1：agent 目录本身是符号链接时，链接可能建到解析不到的地方），
//     记 'ok'；
//   · dangling → 先 unlink 再 createSkillLink（重建），成功记 'ok'；重建会删掉
//     用户自己建的那条链接，**必须警告并记下原链接内容**（审查 Minor）；
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
  copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync,
  realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { SKILL_CONTRACT_VERSION } from '../core/edition.js'
import {
  agentSkillDirs, agentsMissingSkillDir, createSkillLink, defaultEntityDir, LINK_NAME, linkState,
  linkTarget, normalizeNewlines,
  type LinkState,
} from './paths.js'

/** 安装清单文件名：落在实体目录根部，记录版本与内容哈希（Task 10 的安装态探测读它）。 */
export const MANIFEST = '.qiyu-skill.json'

/** 暂存目录前缀：`<entity>.tmp-`（`mkdtempSync` 在其后追加唯一随机后缀）。 */
const STAGING_SUFFIX = '.tmp-'

/**
 * 判断一个目录项名是否是本模块的暂存目录名（`<实体名>.tmp-<随机后缀>`）。
 * 消费方是安装开始时的残留清理——只认这个形状，绝不碰用户自己取的别的名字。
 */
function isStagingName(name: string, entityBase: string): boolean {
  return name.startsWith(`${entityBase}${STAGING_SUFFIX}`) && name.length > entityBase.length + STAGING_SUFFIX.length
}

/**
 * `.qiyu-skill.json` 的语义：安装清单 + 版本标记，不是逐字节指纹（spec D8）。
 *
 * `files` 是**可选**扩展（审查 I2）：记录本次安装写入的受管文件相对路径列表，
 * 供下一次 --force 区分「上一版遗留」与「用户新增」。旧版清单没有该字段时视为
 * 「无法识别上一版」，清理阶段不删任何文件、只警告。
 *
 * `file_hashes` 是 `files` 的旁证（2026-10-22 审查 #59）：`files` 可以被人为编辑
 * ——任何能写这个文件的进程（含备份恢复、同步工具）往里加一条 `mine.md`，下一次
 * `--force` 就会把用户的文件当成「上一版遗留」删掉。清理时只删「内容哈希与这里
 * 记录的一致」的文件；不一致 → 视为用户改动，不删、只警告。旧清单没有这个字段时
 * （本次修复之前装的）无从核对，受管文件一律不删、只警告（宁留不删）。
 */
export interface Manifest {
  version: string
  skill_contract_version: number
  content_hash: string
  installed_at: string
  files?: string[]
  /** 键是 `files` 里的相对路径，值是**换行归一化后**内容的 sha256（与 contentHash 同口径）。 */
  file_hashes?: Record<string, string>
}

export interface InstallResult {
  entityDir: string
  /**
   * **实际**写盘结果（审查 B2）：与 `plannedStatus` 不一致时以这里为准。
   * 计划要写、实际一个文件都没写进去 → 这里退为 `'skipped'`，绝不报 updated。
   */
  status: 'installed' | 'skipped' | 'updated'
  /** `planInstall` 当初给出的计划态（dry-run 的 planned_status 是同一个值）。 */
  plannedStatus: 'installed' | 'skipped' | 'updated'
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
      const kind = direntKind(abs, ent)
      if (kind === 'dir') walk(path.join(abs, ent.name), childRel)
      else if (kind === 'file') out.push(childRel)
      // 'other'（符号链接等非常规条目）：不属于受管正文，忽略（复制同样跳过，
      // 两侧口径一致；源里的符号链接既不复制也不参与哈希，因此不会造成幂等漂移）。
    }
  }
  walk(dir, '')
  return out.sort()
}

/**
 * `Dirent` 的类型归类。`withFileTypes` 在 d_type=`DT_UNKNOWN` 的文件系统
 * （CIFS 挂载、部分 XFS 等）上给出的是「既不是文件也不是目录也不是符号链接」的
 * 空壳，Node 不会替我们补 stat（2026-10-22 审查 #40）。此时补一次 `lstatSync`
 * 再归类——否则非空的网络盘实体会被 `contentHash` 判成空集，与本地源永远不一致，
 * 安装永远 skipped、「--force 也收敛不了」。
 *
 * 补 stat 之后仍不是普通文件/目录（FIFO、设备、符号链接）→ `'other'`，照旧忽略。
 * 条目在 readdir 与 lstat 之间消失（ENOENT）→ 按 `'other'` 忽略（它已不在）。
 */
function direntKind(abs: string, ent: { name: string; isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }): 'file' | 'dir' | 'other' {
  if (ent.isDirectory()) return 'dir'
  if (ent.isFile()) return 'file'
  if (ent.isSymbolicLink()) return 'other'
  try {
    const st = lstatSync(path.join(abs, ent.name))
    if (st.isDirectory()) return 'dir'
    if (st.isFile()) return 'file'
  } catch (err) {
    if (!isErrno(err, 'ENOENT')) throw err
  }
  return 'other'
}

/**
 * 相对路径的**统一分隔符口径**（2026-10-22 审查 #37）：清单 `files` 里的两种分隔符
 * 都当分隔符处理。只认 `/` 时，Windows 上 `..\\..\\evil` 会被当成一整段普通名字
 * 穿过字符串层与父链层，三层防线退化为只剩 realpath 一层。
 */
const REL_SEP_RE = /[\\/]/

/**
 * 把相对路径（'/' 或 '\\' 分隔）还原为平台路径。
 *
 * 两种分隔符都按分隔符处理（审查 #37）：清单是外部数据，`..\\..\\evil` 这种
 * Windows 写法必须在每一层防御里都被当成多段路径看待，否则前三层防线在 Windows
 * 上形同虚设。我们自己写出的清单一律用 '/'（`listFiles` 的口径），所以这只影响
 * 被篡改的清单——那种情况下「解析到实体目录内的另一个文件」正是我们要拦的。
 */
function joinRel(root: string, rel: string): string {
  return path.join(root, ...rel.split(REL_SEP_RE))
}

/**
 * `rel` 是否是一个**合法的、限定在实体目录内**的相对路径（审查 N1）。
 *
 * 清单 `files` 是**不可信输入**（用户可以编辑它、也可能被篡改），删除前必须当外部
 * 数据校验：绝对路径、盘符、`..` 段、空段（`a//b`）、`.` 段一律拒绝。只做字符串
 * 层面判定；符号链接父链造成的逃逸由 `verifyPlainParents` + `realpath` 复核兜住。
 *
 * 分隔符 `/` 与 `\` 都认（审查 #37）：判定要与平台无关——一份在 Linux 上写的清单
 * 被带到 Windows（或反过来）时，两者的含义必须一致、防线层数不缩水。
 */
function isContainedRel(rel: string): boolean {
  if (rel === '' || path.isAbsolute(rel) || path.win32.isAbsolute(rel) || /^[A-Za-z]:/.test(rel)) return false
  return rel.split(REL_SEP_RE).every((part) => part !== '' && part !== '.' && part !== '..')
}

/**
 * 只读版的父链验证：`rel` 的每个父组件在 `base` 下都必须存在且是**真实目录**
 * （不是符号链接/文件）。与 `ensurePlainParents` 同一套判定，但**不创建**任何目录
 * ——删除路径绝不能有副作用。任一父组件缺失（返回 'missing'）或不是真实目录
 * （返回 false）即不可删除。
 */
function verifyPlainParents(base: string, rel: string): 'ok' | 'missing' | 'unsafe' {
  let cur = base
  for (const part of rel.split(REL_SEP_RE).slice(0, -1)) {
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

/**
 * 单个文件的内容哈希：换行归一化后的 sha256（与 `contentHash` 里的逐文件口径一致）。
 * 清单用它记录「本工具当时写下的内容」，供下一次 --force 清理时核对（审查 #59）。
 */
function fileHash(abs: string): string {
  return createHash('sha256').update(normalizeNewlines(readFileSync(abs))).digest('hex')
}

/**
 * 写安装清单（覆盖）。`installed_at` 用 ISO 8601，便于人读与机器解析。
 *
 * `file_hashes`（审查 #59）：与 `files` 一一对应的**逐文件内容哈希**。清单里的
 * `files` 是「哪些文件是我们写的」的唯一依据，而它是一份可以被就地编辑的 JSON——
 * 往 `files` 里追加一条用户自己的文件名，下一次 `--force` 就会把它当「上一版遗留」
 * 删掉，且警告还说「移除了上一版安装的文件」（实测）。清理时改为只删「当前哈希与
 * `file_hashes` 记录一致」的文件，其余一律保留并警告。
 *
 * ⚠️ 这不是完整性保护：`file_hashes` 与 `files` 在同一个文件里，能改 `files` 的
 * 进程也能补一份对得上的哈希（本机没有密钥/签名可用）。它挡住的是两类**现实**场景：
 * ① 备份恢复/同步工具/人工编辑让 `files` 多出条目（不会连哈希一起伪造）；
 * ② 用户在上一版之后改过那个文件（哈希必然不符）。
 */
function writeManifest(
  dir: string,
  version: string,
  contentHashValue: string,
  files: string[],
): void {
  const hashes: Record<string, string> = {}
  for (const rel of files) hashes[rel] = fileHash(joinRel(dir, rel))
  const manifest: Manifest = {
    version,
    skill_contract_version: SKILL_CONTRACT_VERSION,
    content_hash: contentHashValue,
    installed_at: new Date().toISOString(),
    files,
    file_hashes: hashes,
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
 *
 * `file_hashes` 同样是不可信输入，但判定方向相反：**形状不对就整份丢字段**
 * （`file_hashes` 为 undefined = 「无从核对」，清理时保守不删任何文件），不接受
 * 部分采用——半份可用的哈希表比没有更容易让后续维护者误以为「已经核对过了」。
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
      let fileHashes: Record<string, string> | undefined
      if (raw.file_hashes !== undefined) {
        if (!isStringRecord(raw.file_hashes)) return null
        fileHashes = raw.file_hashes
      }
      return { ...raw as Manifest, files, file_hashes: fileHashes }
    }
    return null
  } catch {
    return null
  }
}

/** `v` 是否是「键值都为字符串」的普通对象（数组/嵌套值一律拒绝）。 */
function isStringRecord(v: unknown): v is Record<string, string> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return false
  return Object.values(v).every((x) => typeof x === 'string')
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
 * 把暂存目录里的文件逐个换入实体。目标不存在 → 换入；目标是普通文件 →
 * **原子替换**（POSIX rename 语义，没有先删后写的窗口）；目标是符号链接/目录/设备
 * → 一律不写并警告——`rename` 会替换链接本身、`copyFile` 会写穿链接（审查 C2
 * WT1/WT2/WT3 实测），两种形态都会伤到用户数据，统一按「用户占用」处理。
 *
 * 单文件失败只警告，不中断（其余文件照常换入）。返回各计数；调用方据此决定要不要
 * 换清单，以及 status 该报什么（审查 B2：**status 必须反映实际写盘结果**）：
 *   · `complete`（写了本包全部文件）→ 换清单；
 *   · `written === 0` → 一个文件都没写进去，status 不得报 updated；
 *   · 0 < `written` < 总数 → 部分写入，如实警告。
 *
 * 换入方式见 `moveFile`：同设备时 rename，EXDEV 时降级为复制 + 删源并记一条警告。
 */
function swapIn(
  staging: string,
  entityDir: string,
  rels: string[],
  warnings: string[],
): { complete: boolean; written: number; total: number } {
  let written = 0
  for (const rel of rels) {
    if (!ensurePlainParents(entityDir, rel, warnings)) continue
    const to = joinRel(entityDir, rel)
    if (!isSafeWriteTarget(to, `目标 ${rel} `, warnings)) continue
    try {
      moveFile(joinRel(staging, rel), to, warnings)
      written++
    } catch (err) {
      warnings.push(`写入 ${rel} 失败（${errMsg(err)}）：${to}`)
    }
  }
  return { complete: written === rels.length, written, total: rels.length }
}

/**
 * 把 `from` 换到 `to`：先 `renameSync`；遇到 `EXDEV`（跨设备）降级为
 * 「`copyFileSync` 复制 → 删源」。
 *
 * EXDEV 的现实来源（2026-10-22 审查 B2 实测）：「实体目录是指向网盘/大盘的符号
 * 链接」是 detect 明确认可的安装形态，但暂存目录若建在**符号链接的字面父目录**
 * 上，两者可能不在同一设备。暂存改落 `realpath(entityDir)` 的父目录已消除主因
 * （见 `stagingBaseDir`），本降级是第二道保险——卷的挂载点与路径推断未必一致。
 *
 * 降级窗口的语义：`copyFileSync` 覆盖目标时先截断再写入，不再是原子替换——这是
 * 跨设备时唯一可用的手段，但**必须说出来**（warning 记下受影响的文件）：用户据此
 * 知道这次更新不是原子的。用户内容仍受 `isSafeWriteTarget` + 父链验证保护。
 */
function moveFile(from: string, to: string, warnings: string[]): void {
  try {
    renameSync(from, to)
  } catch (err) {
    if (!isErrno(err, 'EXDEV')) throw err
    copyFileSync(from, to)
    unlinkSync(from)
    warnings.push(`暂存目录与实体不在同一设备（EXDEV），已降级为「复制 → 删除源」换入（非原子）：${to}`)
  }
}

/**
 * 清理「上一版安装过、本版不再有」的受管文件（审查 I2 采纳的方案：以清单里的
 * `files` 界定，而不是删一切包外文件）。用户新增的文件一律保留并警告；上一版
 * 受管文件若已被用户换成符号链接/目录，也不动。
 *
 * 旧清单没有 `files`（本任务之前的安装）→ 无法识别上一版，**不删任何东西**，
 * 只把包外文件列进警告。
 *
 * **内容核对层（审查 #59）**：`files` 只是一份可以被编辑的 JSON，「清单里写着它」
 * 不等于「它是我们写的」。删除前还要对得上 `file_hashes` 里记录的哈希：
 *   · 有 `file_hashes`、且该条目的当前哈希与记录一致 → 是本工具写下的、未被改过，删除；
 *   · 有 `file_hashes`、但该条目没有记录 / 哈希不一致 → 不是本工具写的内容（清单被
 *     篡改，或用户改过），保留并警告；
 *   · 旧清单没有 `file_hashes` → 无从核对，**不删**，只警告（宁留不删）。
 * 这一层同样挡不住「连哈希一起伪造」——清单在实体目录里、与正文同权限，本机没有
 * 密钥可用；它挡的是现实中的误伤来源（见 `writeManifest` 注释）。
 */
function cleanupPreviousManaged(
  entityDir: string,
  prevFiles: string[] | undefined,
  prevHashes: Record<string, string> | undefined,
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
  const unverifiable: string[] = []
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
    // ④ 内容核对层（审查 #59）：清单里写着「这是我们写的」还不够——还要对得上
    //    清单记录的哈希。对不上（用户改过 / 清单被改过）→ 不删。
    const recorded = prevHashes?.[rel]
    if (recorded === undefined) {
      unverifiable.push(rel)
      continue
    }
    let current: string
    try {
      current = fileHash(abs)
    } catch (err) {
      warnings.push(`读取上一版文件 ${rel} 计算哈希失败（${errMsg(err)}），未删除`)
      continue
    }
    if (current !== recorded) {
      unverifiable.push(rel)
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
  if (unverifiable.length > 0) {
    // 清单说它是我们写的、内容却对不上（用户改过，或清单被改过）——不删，并说明。
    warnings.push(
      `以下文件在上一版清单中登记、但内容与记录不符（可能已被用户修改或清单被改动），已保留不动：${unverifiable.join('、')}`,
    )
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
 *
 * 判定与文案拆成 `writeTargetWarning`：`planInstall` 需要**只读预判**清单是否可写
 * （dry-run 与真实安装共用同一判据，Task 11 审查 I1），但预判时不能产生警告。
 */
function writeTargetWarning(p: string, what: string): string | null {
  let st
  try {
    st = lstatSync(p)
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    return `检查${what} ${p} 失败（${errMsg(err)}），未写入`
  }
  if (!st.isFile()) {
    return `${what}已被非普通文件占用（符号链接/目录等），不覆盖、保留用户内容：${p}`
  }
  return null
}

function isSafeWriteTarget(p: string, what: string, warnings: string[]): boolean {
  const warning = writeTargetWarning(p, what)
  if (warning === null) return true
  warnings.push(warning)
  return false
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
  prev?: { files?: string[]; hashes?: Record<string, string> },
): WriteOutcome {
  // 清单此刻是否存在（复审 Minor：「保持上一版」的措辞只在真有上一版清单时成立；
  // 首次安装中途被占用根本没写过清单，措辞要区分开）。必须在动实体**之前**判断。
  const hadPrevManifest = manifestExists(entityDir)

  // 暂存位与实体同设备（审查 B2）：落在实体**真实落点**的父目录下。实体目录本身
  // 不存在时 realpath 会失败——退回「逐级向上找最近一个存在的祖先再 realpath」，
  // 这样即便父目录本身是符号链接，也能落在那条链的真实卷上。
  const stagingBase = stagingBaseDir(entityDir)

  let staging: string | undefined
  try {
    mkdirSync(stagingBase, { recursive: true })
    // 崩溃残留（审查 Minor #4）：SIGKILL 打断的安装会留下 `qiyu.tmp-XXXXXX`，
    // 里面还带着正文。在**新建本次暂存位之前**清理同前缀的旧目录——本次的暂存位
    // 尚未创建，不存在「误删自己」的窗口。只认 `<实体名>.tmp-` 这个形状。
    cleanupStaleStaging(stagingBase, path.basename(entityDir), warnings)
    staging = mkdtempSync(path.join(stagingBase, `${path.basename(entityDir)}${STAGING_SUFFIX}`))
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
      try {
        renameSync(staging, entityDir)
        return { complete: true, written: sourceFiles.length, total: sourceFiles.length, manifestKept: false }
      } catch (err) {
        // 并发（gap 8）：另一进程在「判实体不存在」与「rename 换入」之间把实体目录
        // 建了出来（且非空），rename 不能覆盖非空目录 → ENOTEMPTY。这不是失败——
        // 实体现在可能已经是对的；由调用方按**实际状态**决算（`concurrent: true`）。
        if (!isErrno(err, 'ENOTEMPTY') && !isErrno(err, 'EEXIST')) throw err
        warnings.push('检测到另一个 qiyu skill install 正在并发安装（首次换入撞 ENOTEMPTY），按实体实际状态收敛')
        return { complete: false, written: 0, total: sourceFiles.length, manifestKept: false, concurrent: true }
      }
    }
    const swap = swapIn(staging, entityDir, sourceFiles, warnings)
    // 清理只在「确实写进了东西」时跑：一个文件都没写进去（例如整盘只读、每次
    // rename 都 EXDEV 且复制也失败）时删上一版遗留只会让实体更空，且与那份
    // 「什么都没更新」的真实结果不相称。
    if (swap.written > 0) {
      cleanupPreviousManaged(entityDir, prev?.files, prev?.hashes, sourceFiles, warnings)
    }
    if (!swap.complete) {
      // 有文件没能换入（被占用/失败）：清单不换入，如实反映「实际装上的仍是旧内容」。
      // 下一次安装因此会报内容不同并提示 --force；用户清掉占用后重跑即可收敛。
      const detail = swap.written === 0
        ? `本次一个文件都没有写进去（${swap.total} 个文件全部失败）`
        : `本次未能完整写入（${swap.total} 个文件中成功 ${swap.written} 个）`
      warnings.push(
        hadPrevManifest
          ? `${detail}，安装清单保持上一版`
          : `${detail}，安装清单未写入；清掉占用后重跑安装即可补全`,
      )
      return { complete: false, written: swap.written, total: swap.total, manifestKept: hadPrevManifest }
    }
    if (isSafeWriteTarget(path.join(entityDir, MANIFEST), '清单', warnings)) {
      moveFile(path.join(staging, MANIFEST), path.join(entityDir, MANIFEST), warnings)
    }
    return { complete: true, written: swap.written, total: swap.total, manifestKept: false }
  } finally {
    rmSync(staging, { recursive: true, force: true })
  }
}

/** `writeInstalled` 的实际结果；`installSkill` 据此给出与写盘事实一致的 status。 */
interface WriteOutcome {
  /** 本包全部文件都写进去了（清单是否换入另算）。 */
  complete: boolean
  written: number
  total: number
  /** 写不全时旧清单是否还在（措辞用）。 */
  manifestKept: boolean
  /**
   * 首次换入撞上并发（ENOTEMPTY/EEXIST）：实体是**另一个进程**建的。
   * 本进程一个字节都没写，但实体状态由那次安装决定 —— 调用方必须重新判定，
   * 而不是把「零写入」当成失败报给用户（gap 8）。
   */
  concurrent?: boolean
}

/**
 * 暂存目录的落点：实体目录**真实落点**的父目录，保证暂存与实体在同一设备上
 * （审查 B2——`renameSync` 跨设备抛 EXDEV，而旧实现假定「同父目录 ⇒ 同设备」，
 * 对「实体目录是指向网盘/大盘的符号链接」这种 detect 明确认可的形态并不成立）。
 *
 * 实体目录本身可能还不存在（首次安装）：逐级向上找到最近一个存在的祖先，
 * 对它 realpath 后再拼回缺失的那几段。
 */
function stagingBaseDir(entityDir: string): string {
  const abs = path.resolve(entityDir)
  const parts = abs.split(path.sep)
  for (let i = parts.length; i > 0; i--) {
    const candidate = parts.slice(0, i).join(path.sep) || path.sep
    try {
      const real = realpathSync(candidate).toString()
      return path.dirname(path.join(real, ...parts.slice(i)))
    } catch {
      continue
    }
  }
  return path.dirname(abs)
}

/**
 * 清理 SIGKILL 残留的暂存目录（审查 Minor #4）：只删 `stagingBase` 下名字形如
 * `<entityBase>.tmp-XXXXXX` 的**目录**。删不掉只警告，不让安装失败。
 *
 * ⚠️ **不能无差别删**（2026-10-22 并发实测）：两个 install 同时跑时，B 会把 A 正在写的
 * 暂存目录当成「上次中断的残留」删掉，于是 A 的 `copyTree` 撞 `ENOENT`、或哈希校验报
 * 「暂存内容与源不一致」——6 个并发进程 3 轮跑出 13 次失败，其中一半是这种**自伤**
 * （变异验证：禁用本函数后 `copyfile ENOENT` 与「暂存内容与源不一致」全部消失，只剩
 * 真正的 ENOTEMPTY 竞态）。
 *
 * 判据改为**按年龄**：只有最后修改时间早于 `STALE_STAGING_MIN_AGE_MS` 的才算残留。
 * 活着的并发安装会持续往里写文件，mtime 始终是新的，因此不会被误删；而 SIGKILL 留下的
 * 那份不会再被任何进程触碰，过了阈值就必然可清。
 *
 * 为什么不用 pid 文件 / 锁：需要额外写一个「谁在用」的契约，而进程崩溃时那个文件本身
 * 也可能残留，判定问题只是被挪了一层。年龄阈值是同一个判断的最简形式。
 */
const STALE_STAGING_MIN_AGE_MS = 10 * 60_000

function cleanupStaleStaging(
  stagingBase: string,
  entityBase: string,
  warnings: string[],
  now: number = Date.now(),
): void {
  let entries
  try {
    entries = readdirSync(stagingBase, { withFileTypes: true })
  } catch {
    return // 目录还不存在等：本次新建时自然会建出来。
  }
  for (const ent of entries) {
    if (!isStagingName(ent.name, entityBase)) continue
    const abs = path.join(stagingBase, ent.name)
    try {
      const st = lstatSync(abs)
      if (!st.isDirectory()) continue
      // 年轻 = 可能有别的 install 正在写它。留到下次再清（`--force` 也救不了误删）。
      if (now - st.mtimeMs < STALE_STAGING_MIN_AGE_MS) continue
      rmSync(abs, { recursive: true, force: true })
      warnings.push(`清理了上次安装中断时残留的暂存目录：${abs}`)
    } catch (err) {
      warnings.push(`清理残留暂存目录失败（${errMsg(err)}）：${abs}`)
    }
  }
}

/**
 * 安装判定的**唯一事实源**（Task 11 审查 I1）：`installSkill` 与 `qiyu skill install
 * --dry-run` 都调它，dry-run 因此不会与真实安装分叉。
 *
 * 纯只读：只做 stat/readdir/readFile/lstat，不写盘、不建链。返回值里的
 * `action` 告诉调用方「接下来该做哪种写操作」：
 *   · 'write'            —— 调 `writeInstalled`（首次安装 / 真空实体 / --force 覆盖）；
 *   · 'rewrite-manifest' —— 只重写清单（正文一致、清单落后/损坏）；
 *   · 'none'             —— 一个字节都不写。
 * `status` 是**计划预期的**安装完成后 `InstallResult.status`（dry-run 的
 * planned_status 取自这里）。真实安装的实际 status 由 `installSkill` 按写盘结果
 * 修正——计划说要写、实际一个文件都没写进去时，实际 status 会退回 'skipped'
 * （审查 B2）。
 *
 * 抛错边界与 `installSkill` 一致：源目录不可用、实体路径被文件占用。调用方
 * （命令层）把它们转成可读错误；dry-run 也照此报告——计划能预见到失败，就不该
 * 谎报一个会成功的计划。
 */
export interface InstallPlan {
  entityDir: string
  sourceFiles: string[]
  sourceHash: string
  status: InstallResult['status']
  action: 'write' | 'rewrite-manifest' | 'none'
  warnings: string[]
  /** `action === 'write'` 且实体已有上一版清单时，上一版受管文件列表（清理用）。 */
  prevFiles?: string[]
  /** 上一版清单记录的逐文件哈希（清理前的内容核对，审查 #59）。 */
  prevFileHashes?: Record<string, string>
}

export function planInstall(opts: {
  entityDir: string
  sourceDir: string
  version: string
  force: boolean
}): InstallPlan {
  const { entityDir, sourceDir, version, force } = opts
  const warnings: string[] = []

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

  const base = { entityDir, sourceFiles, sourceHash }

  if (!isDirectory(entityDir)) {
    let exists = true
    try {
      lstatSync(entityDir)
    } catch (err) {
      if (isErrno(err, 'ENOENT')) exists = false
      else throw err
    }
    if (exists) throw new Error(`实体路径已存在但不是目录：${entityDir}`)
    return { ...base, status: 'installed', action: 'write', warnings }
  }

  // —— 分类（审查 I4：分类读取可能因 EACCES 等抛错；失败按「内容不同」处理，
  // 让 --force 仍然可用、无 force 则跳过 + 警告，不把用户卡死） ——
  // 「目录列不出来」与「目录里的某个文件读不出来」是**两种**失败：
  //   · listError（列目录失败，如实体目录 chmod 000）：换入要往这个目录里 rename，
  //     同样会被拒——--force 也救不了，实装必然失败。计划如实说「读不到，不覆盖」，
  //     不给一个必然落空的 updated 承诺（审查 #53）。
  //   · hashError（某个文件读不出来，如 SKILL.md chmod 000）：rename 覆盖它需要的
  //     是目录写权限而不是该文件的读权限，--force 仍能修好（审查 I4 的既有用例）。
  let vacuous = false
  let targetHash: string | null = null
  let listError: unknown = null
  let hashError: unknown = null
  try {
    vacuous = isVacuous(entityDir)
  } catch (err) {
    listError = err
  }
  if (listError === null && !vacuous) {
    try {
      targetHash = contentHash(entityDir)
    } catch (err) {
      hashError = err
    }
  }

  if (vacuous) {
    // 真空（审查 C1 判据：除根部清单外无任何条目）——没有用户内容可保护，按首次安装换入。
    const prev = readManifestSafe(entityDir)
    return {
      ...base, status: 'installed', action: 'write', warnings,
      ...prevOf(prev),
    }
  }

  if (targetHash === sourceHash) {
    const m = readManifestSafe(entityDir)
    if (
      m !== null
      && m.version === version
      && m.skill_contract_version === SKILL_CONTRACT_VERSION
      && m.content_hash === sourceHash
    ) {
      return { ...base, status: 'skipped', action: 'none', warnings } // 幂等：一个字节都不写
    }
    // 审查 M2：清单损坏/字段缺失/旧格式视为「落后」，不视为用户改动——它不是
    // 正文，损坏不构成保护对象；正文哈希一致已证明正文未被改动。只重写清单
    // （否则 Task 10 的漂移探测会永远报 stale）。
    const manifestWarning = writeTargetWarning(path.join(entityDir, MANIFEST), '清单')
    if (manifestWarning !== null) {
      // 清单被占用：正文一致，用户处理占用后重跑即可。
      return { ...base, status: 'skipped', action: 'none', warnings: [manifestWarning] }
    }
    return { ...base, status: 'updated', action: 'rewrite-manifest', warnings }
  }

  // 实体目录列不出来（chmod 000 等）：连「里面有什么」都判定不了，而换入本身也需要
  // 该目录的写权限（`rename` 进一个不可遍历的目录同样被拒）。**有 --force 也不能**
  // 承诺 updated —— 此前 dry-run --force 预告 updated、真实 --force 退 1 的分叉
  // （审查 #53）就出在 force 分支无视了这个错误。
  if (listError !== null) {
    warnings.push(
      `读取实体目录失败（${errMsg(listError)}），无法确认内容与写盘可行性，未覆盖；`
      + `请先修复该目录的可读/可写权限再重跑（即使 --force 也会以同样的错误失败）：${entityDir}`,
    )
    return { ...base, status: 'skipped', action: 'none', warnings }
  }

  if (force) {
    const prev = readManifestSafe(entityDir)
    return {
      ...base, status: 'updated', action: 'write', warnings,
      ...prevOf(prev),
    }
  }

  const reason = hashError !== null
    ? `读取实体目录内容失败（${errMsg(hashError)}）`
    : '实体目录内容与包内不同（可能被手工修改）'
  warnings.push(`${reason}，未覆盖；确认后可用 --force 覆盖：${entityDir}`)
  return { ...base, status: 'skipped', action: 'none', warnings }
}

/** 计划里带上上一版清单的清理依据（`files` + 逐文件哈希 `file_hashes`）。 */
function prevOf(prev: Manifest | null): Pick<InstallPlan, 'prevFiles' | 'prevFileHashes'> {
  if (prev === null) return {}
  const out: Pick<InstallPlan, 'prevFiles' | 'prevFileHashes'> = {}
  if (prev.files !== undefined) out.prevFiles = prev.files
  if (prev.file_hashes !== undefined) out.prevFileHashes = prev.file_hashes
  return out
}

/**
 * 安装 skill。流程见文件头决策表。链接阶段的任何异常都进 warnings，不向上抛；
 * 只有「源目录不可用」「实体路径被文件占用」「暂存写入失败」这类无法继续的情况
 * 才抛错（调用方 Task 11 会转成 internal 错误信封）。
 *
 * 判定本身在 `planInstall`（只读）；本函数只负责按计划执行写操作，并把**实际**
 * 写盘结果翻译成 status（审查 B2：计划说要写但实际零写入时，status 退回 skipped
 * 并警告——`data.status` 是 Agent 读的那一个字段，「报 updated、实体零变化」等于谎报）。
 */
export async function installSkill(opts: InstallOptions): Promise<InstallResult> {
  const { home, sourceDir, version, force, noLink = false } = opts
  const entityDir = opts.entityDir ?? defaultEntityDir(home)

  const plan = planInstall({ entityDir, sourceDir, version, force })
  const warnings = [...plan.warnings]

  let status: InstallResult['status'] = plan.status
  if (plan.action === 'write') {
    const outcome = writeInstalled(
      entityDir, sourceDir, plan.sourceFiles, version, plan.sourceHash, warnings,
      { files: plan.prevFiles, hashes: plan.prevFileHashes },
    )
    if (outcome.concurrent === true) {
      // 并发（gap 8）：另一个进程先建出了实体，本进程零写入但**不是失败**——
      // 实体内容由那次安装决定，必须重新判定后如实报告，否则 Agent 会以为要重装。
      const replan = planInstall({ entityDir, sourceDir, version, force })
      status = replan.status
      warnings.push(
        replan.status === 'skipped'
          ? `另一个并发安装已完成，实体内容与包内一致：${entityDir}`
          : `另一个并发安装已完成，但实体内容与包内仍不同（${replan.warnings[0] ?? '计划要求 --force'}）；如需以本包为准请重跑并加 --force`,
      )
    } else if (!outcome.complete && outcome.written === 0) {
      // 零写入：status 必须反映事实。`installed` 也一样退——实体可能只是个空壳。
      status = 'skipped'
      warnings.push(
        `实体目录内容与包内仍不一致（本次零写入），status 按实际结果记为 skipped；修复上述问题后重跑安装即可收敛`,
      )
    }
  } else if (plan.action === 'rewrite-manifest') {
    writeManifest(entityDir, version, plan.sourceHash, plan.sourceFiles)
  }

  // —— 链接：按四态分派；任何失败都收敛进 warnings ——
  const links: InstallResult['links'] = []
  if (!noLink) await linkAgents(opts, entityDir, links, warnings, status, plan.status)

  return { entityDir, status, plannedStatus: plan.status, links, warnings }
}

/** 对每个 agent 目录按 linkState 四态分派建链，结果与失败原因都写进 links/warnings。 */
async function linkAgents(
  opts: InstallOptions,
  entityDir: string,
  links: InstallResult['links'],
  warnings: string[],
  status: InstallResult['status'],
  plannedStatus: InstallResult['status'],
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
      // 审查 B3：这也是「装了 Agent 却零链接」的一种，探测失败的原因已经在这句话里。
      warnings.push(`探测 agent skills 目录失败（${errMsg(err)}），本次不建链接`)
      return
    }
  }

  // 自动模式下一条都没链上（审查 B3 / #58）：`agentSkillDirs` 只返回**已存在**的
  // 目录，所以「装了 Agent 但没 skills 子目录」和「这台机器根本没装 Agent」在这里
  // 都表现为 dirs 为空。用户拿到的是「安装成功」，而 skill 不会被任何 Agent 加载。
  //
  // 不替用户创建目录（spec D1），但要说出来。`idempotent`（本次既没写盘也没别的
  // 警告）时把「已存在」也写进这条：命令层只在 result.warnings 为空时补那句
  // 「已存在且内容一致」，这里补上它就不会被吞掉——幂等重跑同样要告诉用户
  // 「没建链、skill 不会被加载」。
  if (linkDirs === undefined && dirs.length === 0) {
    warnNoAgentLinked(home, status === 'skipped' && plannedStatus === 'skipped' && warnings.length === 0, warnings)
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
      //
      // 重建 dangling 会**删掉用户自己建的那条链接**（审查 Minor #3：目标暂时不存在
      // 的自建链接也会落进 dangling）。删除用户数据必须说出来：把原链接内容记进警告，
      // 用户据此可以自行恢复。
      let previousTarget: string | null = null
      try {
        if (state === 'dangling') {
          previousTarget = readlinkSync(linkPath, { encoding: 'utf8' })
          unlinkSync(linkPath)
        }
        const target = linkTarget(dir, entityDir)
        await createSkillLink(linkPath, target)
        if (previousTarget !== null) {
          warnings.push(`已重建 ${agent} 的悬空链接（原链接 → ${previousTarget}，现为 → ${target}）：${linkPath}`)
        }
        // 事后复核（审查 B1 双保险）：建链“成功”不等于“agent 能解析到实体”——
        // agent 目录本身是符号链接时，相对路径若按错误的前缀算就会指向不存在的位置。
        // 复核不是 ok 就**如实**记 dangling，不得报 ok。
        const after = linkState(linkPath, entityDir)
        if (after === 'ok') {
          links.push({ agent, path: linkPath, state: 'ok' })
        } else {
          let resolved: string | null = null
          try { resolved = readlinkSync(linkPath, { encoding: 'utf8' }) } catch { /* 读回失败不影响结论 */ }
          warnings.push(
            `${agent} 的链接已创建但复核状态为 ${after}——Agent 很可能加载不到本 skill`
            + `（链接内容 ${resolved ?? '?'}，实体 ${entityDir}；若 agent skills 目录本身是符号链接请检查其落点）：${linkPath}`,
          )
          links.push({ agent, path: linkPath, state: after })
        }
      } catch (err) {
        const reason = previousTarget !== null ? `（原链接 → ${previousTarget} 已被移除）` : ''
        warnings.push(`${agent} 建链失败${reason}（${errMsg(err)}）：${linkPath}`)
        // 如实报告失败后的真实状态（dangling 已删但建失败 → missing；删失败 → 仍 dangling）。
        links.push({ agent, path: linkPath, state: recheckState(linkPath, entityDir, state) })
      }
    }
  }
}

/**
 * 零链接时的如实提示（审查 B3 / #58）：skill 装好了，但没有任何 Agent 会加载它。
 *
 * 分两种情况：
 *   · 装了 Agent 根目录（`~/.claude`、`~/.codex`）但缺 skills 子目录 → 用户 mkdir
 *     一下再重跑 `qiyu skill install` 就能建链；
 *   · 连 Agent 根目录都没有 → 这台机器上没装 Agent，属正常状态，也说一声（否则
 *     「装好了」的提示会让人以为 skill 已经能用了）。
 *
 * **不替用户创建目录**（spec D1）：只提示，不 mkdir。
 *
 * `idempotent`（本次一个字节都没写、也没有别的警告）时，句首补上「已存在且内容
 * 一致、未做任何改动」——命令层只在 `result.warnings` 为空时才补这句，这里补上
 * 就不会被吞掉：幂等重跑同样要告诉用户「没建链、skill 不会被加载」。
 */
function warnNoAgentLinked(home: string, idempotent: boolean, warnings: string[]): void {
  let missing: string[]
  try {
    missing = agentsMissingSkillDir(home).map((a) => a.dir)
  } catch {
    missing = []
  }
  const prefix = idempotent ? 'skill 已存在且内容一致，未做任何改动；' : ''
  if (missing.length > 0) {
    warnings.push(
      `${prefix}已装 Agent 但缺少 skills 子目录，本次未建链：${missing.join('、')}；`
      + `创建这些目录后重跑 \`qiyu skill install\` 即可建链（skill 不会被任何 Agent 加载）`,
    )
    return
  }
  warnings.push(
    `${prefix}未发现任何 Agent skills 目录（~/.claude/skills、~/.codex/skills），`
    + '本次未建链：skill 不会被任何 Agent 加载；装好 Agent 后重跑 `qiyu skill install` 即可建链',
  )
}

/** 建链失败后重新判定状态；判定本身再抛（ELOOP 等）就退回尝试前的状态。 */
function recheckState(linkPath: string, entityDir: string, fallback: LinkState): LinkState {
  try {
    return linkState(linkPath, entityDir)
  } catch {
    return fallback
  }
}
