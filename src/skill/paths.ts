// src/skill/paths.ts —— agent skills 目录探测、实体目录默认位置、链接目标计算、
// 链接四态判定，以及跨平台链接创建与换行归一化。
//
// 本文件是 `src/skill/` 叶子层：只用 `node:*` 标准库，不 import `commands/`、`store/`、
// `core/`，也不被它们反向 import。消费方是 Task 9（安装，用 `LinkState` 填
// `InstallResult.links[].state`）与 Task 11（`skill where` 直接展示四态）。
//
// **注入 home / 注入 env，不读真实环境**：所有路径函数都收调用方给的 `home`，键名
// 归一化函数收调用方给的 `env`（`postinstall.ts` 传 `opts.env`、`detect.ts` 传
// `process.env`），本文件不读 `~`、**不直接**读 `process.env`，测试因此可以完全
// 跑在临时目录与字面量 env 里。唯一的平台依赖是 `createSkillLink` 里的
// `process.platform`，而平台决策本身已抽成纯函数 `linkPlan`，测试可以直接注入
// 平台值来钉住行为。
//
// 链接四态（linkState）：
//   · missing —— 链接路径本身不存在（lstat ENOENT）。
//   · foreign —— 路径存在但不是符号链接，或者是指向别处的符号链接：这块位置被
//     别的东西占了，安装时不能覆盖、要报给用户看。链接目标真实存在、但实体目录
//     自己不存在时，也是 foreign（2026-10-22 审查 Minor #2）。
//   · dangling —— 是符号链接，但链接目标解析不到（实体目录被删了）。
//   · ok —— 是符号链接且解析后指向实体目录。
// 判定必须用 `lstatSync` 而不是 `statSync`：`statSync` 会顺着链接走，链接本身与
// 「链接指向的东西」就分不开了 —— 而四态的全部意义正是区分这两者。

import { lstatSync, realpathSync, statSync, type Stats } from 'node:fs'
import { symlink } from 'node:fs/promises'
import path from 'node:path'

/** 一个被支持的 agent，以及它存放 skills 的目录（绝对路径）。 */
export interface AgentDir {
  name: 'claude-code' | 'codex'
  dir: string
}

/**
 * 安装清单文件名：落在实体目录根部，记录版本与内容哈希（`install.ts` 写、
 * `detect.ts` 与 `install.ts` 读）。
 *
 * 它是**路径事实**，所以收敛在 paths.ts 这个事实源里（G4/D6）：此前 `install.ts` 与
 * `scripts/copy-assets.mjs` 各写一份字面量，改一处必漏另一处。`install.ts` 仍 re-export
 * 以保持既有 import 路径兼容；`copy-assets.mjs` 是纯 JS 构建脚本（不能 import TS），
 * 两侧字面量的一致性由 `tests/skill/constants.test.ts` 的交叉校验用例钉住。
 */
export const MANIFEST = '.qiyu-skill.json'

/**
 * agent skills 目录下的链接名。skill 身份固定为 `qiyu`（正文 frontmatter 同名），
 * 不随实体位置变化。
 *
 * 本常量是**路径事实**，所以放在 paths.ts 这个路径事实源里：`install.ts`（安装）
 * 与 `commands/skill.ts`（`--dry-run`/`where` 的计划与探测）都从这里取，避免两份
 * 字符串镜像各自漂移（终审 Minor-1）。
 */
export const LINK_NAME = 'qiyu'

/**
 * 已知 agent → 它存放 skills 的目录（相对 `home`）。
 *
 * 用 `Record<AgentDir['name'], string>` 而不是数组：新增/重命名 agent 时联合类型
 * 会让这里编译失败，子目录字符串因此有编译期保护（终审 Minor-2 要求保留）。
 */
const AGENT_SKILL_SUBDIR_BY_NAME: Record<AgentDir['name'], string> = {
  'claude-code': path.join('.claude', 'skills'),
  codex: path.join('.codex', 'skills'),
}

/**
 * 已知 agent 及其 skills 目录相对 `home` 的位置，按展示顺序排列。
 *
 * 从上面的 `Record` 派生（而不是另写一份数组），消费方是 `agentSkillDirs()` 与
 * `commands/skill.ts` 的 ENOTDIR 退化探测——两处看到的是同一份事实。
 */
export const AGENT_SKILL_SUBDIRS: readonly { name: AgentDir['name']; subdir: string }[] =
  (Object.keys(AGENT_SKILL_SUBDIR_BY_NAME) as AgentDir['name'][]).map((name) => ({
    name,
    subdir: AGENT_SKILL_SUBDIR_BY_NAME[name]!,
  }))

/**
 * 按 agent 名取 skills 子目录（相对 `home`）。消费方是 `commands/skill.ts` 的
 * ENOTDIR 退化探测与 `skill where` 的 missing 条目——它们手里只有 agent 名。
 */
export function agentSkillSubdir(name: AgentDir['name']): string {
  return AGENT_SKILL_SUBDIR_BY_NAME[name]
}

/**
 * 返回 `home` 下**已存在**的 agent skills 目录。不存在的 agent 不返回 ——
 * 调用方据此决定「这个 agent 没装，跳过」，而不是替它建目录。
 */
export function agentSkillDirs(home: string): AgentDir[] {
  const result: AgentDir[] = []
  for (const { name, subdir } of AGENT_SKILL_SUBDIRS) {
    const dir = path.join(home, subdir)
    if (exists(dir)) result.push({ name, dir })
  }
  return result
}

/**
 * 装了 Agent 根目录（如 `~/.claude`）但没有 skills 子目录的 agent，返回其**缺失的**
 * skills 目录路径（不创建）。消费方是 `install.ts`：自动模式下一条链接都没建时，
 * 用它区分「这台机器上根本没有 Agent」（正常，不告警）与「Agent 装了、但 skills
 * 子目录还没建」（审查 B3：此前静默不建链、零警告，用户拿到的是「装好了」）。
 *
 * 根目录也不存在（`~/.claude` 本身就没有、或是文件）的 agent 不返回——那不是
 * 「可以修」的状态，是没装。
 */
export function agentsMissingSkillDir(home: string): AgentDir[] {
  const result: AgentDir[] = []
  for (const { name, subdir } of AGENT_SKILL_SUBDIRS) {
    const parts = subdir.split(path.sep)
    const root = path.join(home, parts[0]!)
    // 根必须是**真实目录**（`~/.claude` 是文件 → ENOTDIR 不算装了 Agent）。先判根
    // 再判子目录：根是文件时 `lstat(root/skills)` 直接抛 ENOTDIR，顺序反了会把
    // 一个正常状态（用户没有 ~/.claude 目录）变成异常。
    let rootIsDir: boolean
    try {
      rootIsDir = statSync(root).isDirectory()
    } catch (err) {
      if (isEnoent(err) || isEnotdir(err)) continue
      throw err
    }
    if (!rootIsDir) continue
    const dir = path.join(home, subdir)
    if (exists(dir)) continue
    result.push({ name, dir })
  }
  return result
}

/**
 * 实体目录的默认位置：`<home>/.agents/skills/qiyu`（叶子名与 `LINK_NAME` 同一份事实，
 * D6：此前这里另写了一个 `'qiyu'` 字面量，与链接名两处镜像）。
 *
 * `pathImpl` 是**平台语义注入缝**（D3.15 / D1）：默认用当前平台的 `path`，测试可以传
 * `path.win32` 在不切平台的前提下钉住 Windows 的拼接结果。注入只改变路径运算，不改变
 * 任何目录选择。
 */
export function defaultEntityDir(home: string, pathImpl: typeof path = path): string {
  return pathImpl.join(home, '.agents', 'skills', LINK_NAME)
}

/**
 * 从 `agentDir` 指向 `entityDir` 的相对链接目标。用相对路径而非绝对路径，
 * 是为了让整个 `~` 目录可以整体搬迁/复制而不失效。
 *
 * ⚠️ 相对路径是**相对链接所在目录的真实落点**解析的，所以 `agentDir` 必须先过
 * `realpathSync`（stow/dotfiles 布局下 `~/.claude/skills` 本身就是符号链接，真实
 * 落点可能与字面路径深度不同；2026-10-22 审查 B1 实测：不归一化时建出的链接指向
 * 不存在的路径，却报 state='ok'）。解析失败（目录不存在等）退回原值：此时建链本来
 * 就会失败并进 warnings，不在这里制造第二个错误。
 */
export function linkTarget(agentDir: string, entityDir: string): string {
  return path.relative(realpathOrSelf(agentDir), entityDir)
}

/** `realpathSync` 的「失败即退回原值」版本（供 linkTarget 使用，见其注释）。 */
function realpathOrSelf(p: string): string {
  try {
    return realpathSync(p).toString()
  } catch {
    return p
  }
}

export type LinkState = 'ok' | 'dangling' | 'foreign' | 'missing'

/**
 * 判定 `linkPath` 相对 `entityDir` 的状态。
 *
 * 判「是不是同一个目录」用 **dev + ino**（`statSync` 两边，顺着链接走），不比较
 * 路径字符串：macOS 默认 APFS 是大小写不敏感卷，而 `realpathSync` **不做大小写
 * 归一化**（磁盘上是 `Qiyu`、传入 `qiyu`，realpath 只会把后者原样拼回去）——
 * 字符串严格比较会把同一个目录判成 foreign，让 `where` 报错、让 install 拒绝修复
 * 一条其实 ok 的链接（2026-10-22 审查 Minor #36 实测）。同 inode 判定对大小写不
 * 敏感卷、大小写敏感卷、bind mount、符号链接都成立。
 *
 * inode 读不到（EACCES 等）时退回 realpath + `path.resolve` 的字符串比较；那种
 * 环境下也读不到链接目标，调用方本来就会按异常收敛。
 *
 * 注意：自指或成环的符号链接（realpath 解析超过系统上限）会抛 ELOOP，**不落四态** ——
 * ELOOP 不在内部吞掉的错误之列（`lstatOrNull` 只吞 ENOENT，`statOrNull`/`realpathOrNull`
 * 只吞 ENOENT/ENOTDIR，其余一律照常抛）。Task 11 的 `skill where`
 * 若要在这种异常环境下仍然给出可读输出，需要自己在调用处兜住。
 */
export function linkState(linkPath: string, entityDir: string): LinkState {
  const stat = lstatOrNull(linkPath)
  if (stat === null) return 'missing'
  if (!stat.isSymbolicLink()) return 'foreign'

  // 顺着链接走：目标解析不到 → 链接悬空。ELOOP 不吞（自指/成环不落四态，见函数
  // 注释）——判定不了就如实抛，由调用方按「不触碰、只报告」处理。
  const linkTargetStat = statOrNull(linkPath)
  if (linkTargetStat === null) return 'dangling'
  const entityStat = statOrNull(entityDir)
  // 实体目录自己不存在，但链接目标**能**解析到（说明它指向别处一个真实存在的东西）
  // —— 按四态语义是 foreign（「路径存在但不是指向我们的链接」）。2026-10-22 审查
  // Minor #2/#7 实测：此前这里在解析目标之前就短路成 dangling，导致 `where` 报
  // dangling / dry-run 预告 rebuild，而真实安装（装好实体后再判定）报 foreign 并
  // 拒绝覆盖——同一链接两种说法。
  if (entityStat === null) return 'foreign'

  // 首选的判据：同一 inode（见函数注释）。只有两侧都拿到了 inode 才用。
  if (hasInode(linkTargetStat) && hasInode(entityStat)) {
    return linkTargetStat.dev === entityStat.dev && linkTargetStat.ino === entityStat.ino
      ? 'ok'
      : 'foreign'
  }
  // 兜底：realpath 后按字符串比（realpath 抛错已在上面 statOrNull 阶段被吞成 null）。
  const resolvedLink = realpathOrNull(linkPath)
  const resolvedEntity = realpathOrNull(entityDir)
  if (resolvedLink === null || resolvedEntity === null) return 'foreign'
  return path.resolve(resolvedLink) === path.resolve(resolvedEntity) ? 'ok' : 'foreign'
}

/** `Stats` 是否带可用的 inode 数字（Windows 的 stat 也有 ino，但为 0 时不可比）。 */
function hasInode(st: Stats): boolean {
  return typeof st.ino === 'number' && st.ino !== 0 && typeof st.dev === 'number'
}

/**
 * 平台决策的纯函数：给定链接路径、目标与平台，返回实际要传给 `symlink` 的参数。
 *
 * Windows 的 junction 只接受**绝对路径**，所以 win32 上把相对 target 按
 * `dirname(linkPath)` 解析成绝对路径，并指定 type `'junction'`；其他平台原样
 * 保留相对 target、不指定 type（POSIX 下 Node 会自行判断 file/dir）。
 *
 * `pathImpl` 是**平台语义注入缝**（D3.15，与 `defaultEntityDir` 同一个理由）：默认用
 * 当前平台的 `path`（行为与以前逐字相同），测试可以传 `path.win32` 并用 win32 形态的
 * 输入，在不切平台的前提下钉住 Windows 分支真正走的是 win32 的路径运算
 * ——此前那条「win32」用例在 POSIX 机器上实际跑的是 POSIX `path.resolve`。
 *
 * ⚠️ Windows 上 junction 的真实行为未在本机实测（spec §跨平台 已声明未覆盖）；
 * 这里保证的只是决策逻辑本身，由用例钉住。
 */
export function linkPlan(
  linkPath: string,
  target: string,
  platform: NodeJS.Platform,
  pathImpl: typeof path = path,
): { target: string; type?: 'junction' } {
  if (platform === 'win32') {
    // ⚠️ 解析基准必须是链接所在目录的**真实落点**：junction 的 target 是绝对路径，
    // 而相对 target 是相对「链接实际所在的那个目录」解析的——agent 目录本身是符号
    // 链接时，字面路径与真实落点深度不同（审查 B1 的同一根因）。realpath 失败
    // （目录还不存在等）退回字面路径，与旧行为一致。
    return { target: pathImpl.resolve(realpathOrSelf(pathImpl.dirname(linkPath)), target), type: 'junction' }
  }
  return { target }
}

/**
 * 在 `linkPath` 创建指向 `target` 的链接。平台相关的一切都交给 `linkPlan`，
 * 这里只做一次 `symlink` 调用。调用方负责保证 `linkPath` 的父目录存在，
 * 以及 `linkPath` 当前不是已存在的东西（`symlink` 本身遇到已存在路径会 EEXIST）。
 *
 * `target` 必须是 `linkTarget(agentDir, entityDir)` 的计算结果——`linkPlan` 在
 * win32 上按 `dirname(linkPath)` 解析相对 target，这个写法只在链接目录与
 * `agentDir` 同一字符串时才成立（调用方传的就是同一个 `dir`）。
 * 成功后调用方**必须**用 `linkState` 复核（审查 B1），本函数不替调用方判定。
 */
export async function createSkillLink(linkPath: string, target: string): Promise<void> {
  const plan = linkPlan(linkPath, target, process.platform)
  await symlink(plan.target, linkPath, plan.type)
}

/**
 * 把 CRLF 折成 LF。skill 正文会跨平台分发，Windows 侧产出的 CRLF 不应污染
 * 内容比较与哈希。
 *
 * 按字节处理而不是解码成字符串：UTF-8 多字节字符可能被 0x0D/0x0A 字节序列
 * 切断的顾虑不存在（UTF-8 续字节都 ≥ 0x80），字节级替换对任意内容都无损；
 * 孤立的 `\r`（不是 CRLF 的一部分）原样保留 —— 本函数只承诺 CRLF → LF。
 */
export function normalizeNewlines(buf: Buffer): Buffer {
  const out = Buffer.alloc(buf.length)
  let n = 0
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && i + 1 < buf.length && buf[i + 1] === 0x0a) continue
    out[n++] = buf[i]!
  }
  return out.subarray(0, n)
}

// —— 环境变量（键名归一化） ——

/**
 * 把 env 的键统一成「小写 + `-` 转 `_`」后建索引（spec D8：Windows 环境变量名
 * 大小写不敏感；npm 自己会把配置名里的 `-` 归一化成 `_`，于是
 * `npm_config_qiyu-skill-dir` / `NPM_CONFIG_QIYU_SKILL_DIR` 都命中同一键）。
 * 只收字符串值——`NodeJS.ProcessEnv` 的值类型允许 undefined，未定义的键视同不存在。
 *
 * 导出而不是在 `postinstall.ts` 与 `detect.ts` 各写一份：postinstall 用
 * `npm_config_qiyu_skill_dir` 决定「装到哪」，漂移探测用它决定「去哪找」——两处
 * 的归一化规则一旦不同，装上之后的每条命令都会误报「未安装」（终审 I2）。
 */
export function envIndex(env: NodeJS.ProcessEnv): Map<string, string> {
  const index = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    index.set(normalizeEnvKey(key), value)
  }
  return index
}

/**
 * 按归一化键读一个环境变量，空串/纯空白视同未设（与既有 `QIYU_SKILL_DIR` 口径一致），
 * 返回值已 trim。`key` 自身也过同一归一化，调用方写哪种拼法都行。
 */
export function readEnvByNormalizedKey(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = envIndex(env).get(normalizeEnvKey(key))?.trim()
  return value !== undefined && value !== '' ? value : undefined
}

function normalizeEnvKey(key: string): string {
  return key.toLowerCase().replace(/-/g, '_')
}

// —— 内部工具 ——

/** lstat 的「不存在即 null」版本：只吞 ENOENT，其他错误照常抛。 */
function lstatOrNull(p: string): Stats | null {
  try {
    return lstatSync(p)
  } catch (err) {
    if (isEnoent(err)) return null
    throw err
  }
}

/** realpath 的「解析不到即 null」版本：只吞 ENOENT/ENOTDIR，其他错误照常抛。 */
function realpathOrNull(p: string): string | null {
  try {
    return realpathSync(p).toString()
  } catch (err) {
    if (isEnoent(err) || isEnotdir(err)) return null
    throw err
  }
}

/**
 * `statSync`（**顺着**链接走）的「拿不到即 null」版本：吞 ENOENT/ENOTDIR。
 * ELOOP **不吞**——成环链接在 `linkState` 里是「判定不了」，不是「目标不存在」
 * （四态不覆盖这种情况，调用方按 foreign/unknown 处理）。其余错误照常抛。
 */
function statOrNull(p: string): Stats | null {
  try {
    return statSync(p)
  } catch (err) {
    if (isEnoent(err) || isEnotdir(err)) return null
    throw err
  }
}

/** 目录项是否存在（存在即可，不区分文件/目录/链接）。 */
function exists(p: string): boolean {
  return lstatOrNull(p) !== null
}

function isEnoent(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOENT'
}

function isEnotdir(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === 'ENOTDIR'
}
