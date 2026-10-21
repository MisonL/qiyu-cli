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
//     别的东西占了，安装时不能覆盖、要报给用户看。
//   · dangling —— 是符号链接，但链接目标解析不到（实体目录被删了）。
//   · ok —— 是符号链接且解析后指向实体目录。
// 判定必须用 `lstatSync` 而不是 `statSync`：`statSync` 会顺着链接走，链接本身与
// 「链接指向的东西」就分不开了 —— 而四态的全部意义正是区分这两者。

import { lstatSync, realpathSync, type Stats } from 'node:fs'
import { symlink } from 'node:fs/promises'
import path from 'node:path'

/** 一个被支持的 agent，以及它存放 skills 的目录（绝对路径）。 */
export interface AgentDir {
  name: 'claude-code' | 'codex'
  dir: string
}

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

/** 实体目录的默认位置：`<home>/.agents/skills/qiyu`。 */
export function defaultEntityDir(home: string): string {
  return path.join(home, '.agents', 'skills', 'qiyu')
}

/**
 * 从 `agentDir` 指向 `entityDir` 的相对链接目标。用相对路径而非绝对路径，
 * 是为了让整个 `~` 目录可以整体搬迁/复制而不失效。
 */
export function linkTarget(agentDir: string, entityDir: string): string {
  return path.relative(agentDir, entityDir)
}

export type LinkState = 'ok' | 'dangling' | 'foreign' | 'missing'

/**
 * 判定 `linkPath` 相对 `entityDir` 的状态。比较前两边都过 `path.resolve`，
 * 抹平相对/绝对与 `..` 段的写法差异，避免「同一个目录、两种字符串」被判成 foreign。
 *
 * 注意：自指或成环的符号链接（realpath 解析超过系统上限）会抛 ELOOP，**不落四态** ——
 * ELOOP 不在内部吞掉的错误之列（`lstatOrNull` 只吞 ENOENT，`realpathOrNull` 吞
 * ENOENT/ENOTDIR，其余一律照常抛）。Task 11 的 `skill where`
 * 若要在这种异常环境下仍然给出可读输出，需要自己在调用处兜住。
 */
export function linkState(linkPath: string, entityDir: string): LinkState {
  const stat = lstatOrNull(linkPath)
  if (stat === null) return 'missing'
  if (!stat.isSymbolicLink()) return 'foreign'

  // 实体目录自己都不存在，链接必然悬空；不必再尝试解析链接目标。
  if (lstatOrNull(entityDir) === null) return 'dangling'

  // realpathSync 在目标解析不到时抛 ENOENT —— 链接悬空。
  const resolvedLink = realpathOrNull(linkPath)
  if (resolvedLink === null) return 'dangling'
  const resolvedEntity = realpathOrNull(entityDir)
  if (resolvedEntity === null) return 'dangling'

  // 两边都过 realpath 后再 path.resolve 严格比较。POSIX 上 realpath 已消除
  // `..`、重复斜杠与符号链接，严格相等即同一目录（本机已由用例覆盖）。Windows
  // 上 realpath 预期返回卷上的规范写法，使大小写差异自然消解 —— 这一条是推断，
  // 未在本机实测（见 spec §跨平台）。
  return path.resolve(resolvedLink) === path.resolve(resolvedEntity) ? 'ok' : 'foreign'
}

/**
 * 平台决策的纯函数：给定链接路径、目标与平台，返回实际要传给 `symlink` 的参数。
 *
 * Windows 的 junction 只接受**绝对路径**，所以 win32 上把相对 target 按
 * `dirname(linkPath)` 解析成绝对路径，并指定 type `'junction'`；其他平台原样
 * 保留相对 target、不指定 type（POSIX 下 Node 会自行判断 file/dir）。
 *
 * ⚠️ Windows 上 junction 的真实行为未在本机实测（spec §跨平台 已声明未覆盖）；
 * 这里保证的只是决策逻辑本身，由用例钉住。
 */
export function linkPlan(
  linkPath: string,
  target: string,
  platform: NodeJS.Platform,
): { target: string; type?: 'junction' } {
  if (platform === 'win32') {
    return { target: path.resolve(path.dirname(linkPath), target), type: 'junction' }
  }
  return { target }
}

/**
 * 在 `linkPath` 创建指向 `target` 的链接。平台相关的一切都交给 `linkPlan`，
 * 这里只做一次 `symlink` 调用。调用方负责保证 `linkPath` 的父目录存在，
 * 以及 `linkPath` 当前不是已存在的东西（`symlink` 本身遇到已存在路径会 EEXIST）。
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
