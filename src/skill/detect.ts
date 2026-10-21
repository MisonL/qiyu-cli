// src/skill/detect.ts —— 安装态探测与首次运行提示（设计稿 D2.1）。
//
// 背景漏洞（spec D2.1）：用户装过旧版 skill → 包升级改了命令 → 已安装的那份还在
// 教 Agent 用死命令，而没有任何东西报警。补法是**任何 `qiyu` 命令启动时做一次
// 零成本探测**（只读 `.qiyu-skill.json` 清单，不读全部正文），据结果往
// `meta.warnings` 加**一条**提示：
//
//   · absent  → 「skill 未安装到 <实体目录>；运行 `qiyu skill install`」；
//   · stale   → 三个成因三支文案（实现见 `skillWarning`）：
//               版本不同 → 「与当前 CLI 版本不一致（安装于 <旧>，当前 <新>）」；
//               版本相同仅内容漂移 → 「内容与包内当前版本不一致（版本 <v>）」；
//               版本未知 → 「无法确认已安装 skill 的版本（安装清单缺失或损坏）」；
//               均以「运行 `qiyu skill install --force` 更新」收尾；
//   · current / unknown → 不提示（unknown = 判定不了，宁可闭嘴也不打扰）。
//
// **只提示、绝不改退出码、绝不改 data、绝不自动改文件**——自动覆盖用户可能改过的
// 正文是局部破坏（spec D2.1）。探测失败（权限、路径异常）静默归为 unknown，不影响
// 命令本身。
//
// 探测结果**按参数元组（entityDir + sourceDir + currentVersion 拼接）缓存在进程内**：
// 同参重复调用复用，不重复 stat；换参（如测试换 tmp 目录）重新探测。缓存键必须含
// 全部三个参数——测试在同进程内换 tmp 目录跑，只按实体目录做键就会命中错结果。
//
// 测试环境（NODE_ENV === 'test'）的 `resolveEntityDir()` 返回 undefined、跳过真实
// 路径探测。理由有二（全局约束 + brief Step 5）：
//   ① **测试绝不读写真实 `~`**——探测会 stat 用户 home 下的实体目录；
//   ② **探测结果不得依赖开发者机器装没装过 skill**——否则同一份测试在本机装过的
//      人那里全量多出 meta.warnings、没装过的人不出现，`toEqual({...})` 断言两种
//      命运。修门（跳过探测）而不是放宽断言。
//
// 分层：`skill/` 叶子层，只 import `node:*`、`core/` 与 `skill/` 内部；`output.ts`
// **不得** import 本文件（Task 14 分层红线钉住）——提示文案经
// `output.setSkillWarning()` 注入，探测与输出解耦。

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentHash, MANIFEST, type Manifest } from './install.js'
import { defaultEntityDir } from './paths.js'

/**
 * 安装态四态（brief 接口）：
 *   · absent  —— 实体目录缺失（未安装）；
 *   · stale   —— 已安装但与包内不一致：manifest 版本不同，或 manifest 缺失/损坏/
 *                字段不全、或清单哈希与包内内容哈希不同（包更新了而装的那份没跟上）。
 *                `installedVersion` 取自清单，取不到（缺失/损坏/字段残缺）记
 *                `'unknown'`——不编造版本号；
 *   · current —— 版本与内容哈希都与包内一致；
 *   · unknown —— 探测失败（实体不可读、路径异常等），宁可闭嘴也不打扰。
 */
export type SkillState =
  | { kind: 'absent' }
  | { kind: 'stale'; installedVersion: string }
  | { kind: 'current' }
  | { kind: 'unknown' }

// ⚠️ 进程内一次判定：命中后**不随文件系统变化**（装完 skill 再调同参仍返回旧结论，
// 这正是「一个进程只探测一次」的语义）。`__resetSkillDetectionForTest()` 仅测试用，
// 生产路径不存在清除动作——CLI 每个命令都是新进程，缓存天然只活一次命令。
const cache = new Map<string, SkillState>()

/**
 * 纯探测：三个参数全部由调用方给（实体目录、包内 skill 源目录、当前 CLI 版本），
 * 本函数不读 `process.env`、不猜路径。内部按参数元组缓存——一个进程内同一组参数
 * 只探测一次（spec D2.1：零成本、不重复 stat）。
 *
 * 判定顺序：
 *   1. 实体目录 stat：ENOENT → absent；存在但不是目录（路径被文件占用）→ unknown
 *      （不是「未安装」，也不能谎报 stale，宁可闭嘴）；其余错误 → unknown；
 *   2. 读清单：缺失、JSON 损坏、字段不全（类型不对）→ stale + installedVersion='unknown'
 *      （正文在而清单没了，最可能是旧版安装或手工清理，按「需要更新」提示是对的）；
 *      清单**读不动**（EACCES 等）则不是「缺失」，重抛进第 5 条 → unknown；
 *   3. 版本不同 → stale（带清单里的版本）；
 *   4. 版本一致 → 比较清单 content_hash 与**包内**源目录的内容哈希（与安装同一套
 *      `contentHash` 算法，CRLF 归一化、排除清单自身）：一致 → current，不同 → stale。
 *      源码态下 PACKAGE_VERSION 恒为占位值，版本号区分不了包的新旧——哈希比较是
 *      发现「包变了、装的那份没跟上」的唯一判据；
 *   5. 以上任何一步抛错（EACCES、ELOOP……）→ unknown，**绝不向上抛**——探测失败
 *      不允许影响命令本身。
 */
export function detectSkillState(entityDir: string, sourceDir: string, currentVersion: string): SkillState {
  // 键用 NUL 分隔（路径里不可能出现 NUL，杜绝 'a'+'bc' 与 'ab'+'c' 拼出同键）。
  const key = `${entityDir}\u0000${sourceDir}\u0000${currentVersion}`
  const hit = cache.get(key)
  if (hit !== undefined) return hit

  const state = probe(entityDir, sourceDir, currentVersion)
  cache.set(key, state)
  return state
}

/** 真正的探测逻辑（无缓存）。任何异常都收敛成 unknown。 */
function probe(entityDir: string, sourceDir: string, currentVersion: string): SkillState {
  try {
    // statSync 会顺着符号链接走——实体目录本身是指向别处的符号链接是合法安装
    // 形态（用户可能把实体放在大盘/网盘上），按最终指向判定。
    let isDir: boolean
    try {
      isDir = statSync(entityDir).isDirectory()
    } catch (err) {
      if (isErrno(err, 'ENOENT')) return { kind: 'absent' }
      throw err
    }
    if (!isDir) return { kind: 'unknown' } // 路径被文件占用：不是未安装，也不能谎报 stale

    // 只读清单、不读实体正文（spec D2.1 的「零成本」）。readManifestStrict 对
    // 缺失/损坏/字段不全统一返回 null。
    const manifest = readManifestStrict(entityDir)
    if (manifest === null) return { kind: 'stale', installedVersion: 'unknown' }

    if (manifest.version !== currentVersion) {
      return { kind: 'stale', installedVersion: manifest.version }
    }

    // 版本一致，再比内容哈希：清单记录的是「上次安装时的包内哈希」。
    const sourceHash = contentHash(sourceDir)
    return manifest.content_hash === sourceHash
      ? { kind: 'current' }
      : { kind: 'stale', installedVersion: manifest.version }
  } catch {
    // contentHash 对源目录不可读会抛（Task 9 的 I4 只在安装路径上容错，detect
    // 侧自己兜）。探测失败一律 unknown：宁可闭嘴也不打扰，绝不让提示搞挂命令。
    return { kind: 'unknown' }
  }
}

/**
 * 读清单，要求四个核心字段（version / skill_contract_version / content_hash /
 * installed_at）类型齐全才返回，否则 null。判据与 `install.ts` 的 `readManifestSafe`
 * 一致，但**只读前四个字段、忽略 `files`**——那是 Task 9 为 --force 清理加的扩展，
 * 探测不消费它；探测是只读旁路，也没有删除决策可被它污染。
 *
 * 错误分界（brief 判定矩阵的两条不同结论）：
 *   · 文件不存在 / JSON 损坏 / 字段不全 → 返回 null（= stale，版本记 'unknown'）；
 *   · 文件**读不动**（EACCES 等，如实体目录 chmod 000）→ 原样重抛（= unknown）。
 *     「清单没了」与「清单看不了」是两种安装态：前者能确定装过但内容不明，
 *     后者连「装没装」都判定不了——按 brief，后者静默。
 */
function readManifestStrict(entityDir: string): Manifest | null {
  let text: string
  try {
    text = readFileSync(path.join(entityDir, MANIFEST), 'utf8')
  } catch (err) {
    if (isErrno(err, 'ENOENT')) return null
    throw err
  }
  try {
    const raw = JSON.parse(text) as Partial<Manifest>
    if (
      typeof raw.version === 'string'
      && typeof raw.skill_contract_version === 'number'
      && typeof raw.content_hash === 'string'
      && typeof raw.installed_at === 'string'
    ) {
      // 显式只取四个字段：files 即使是数组也不带出来（brief：忽略 files）。
      return {
        version: raw.version,
        skill_contract_version: raw.skill_contract_version,
        content_hash: raw.content_hash,
        installed_at: raw.installed_at,
      }
    }
    return null
  } catch {
    return null
  }
}

/**
 * 把安装态翻译成一句 meta.warnings 文案。
 *
 * `ctx` 是 brief 签名之外的**可选**上下文（缺省时文案退化为不含路径/版本的通用
 * 说法，单参调用与 brief 接口完全兼容）：
 *   · entityDir      —— absent 提示里点名实体位置；
 *   · currentVersion —— stale 提示里点名当前版本（调用方传 PACKAGE_VERSION）。
 *
 * current / unknown 返回 undefined（不提示）。文案必须**可执行**：告诉 Agent
 * 下一条命令是什么（`qiyu skill install` / `--force`），而不是只说「不一致」。
 */
export function skillWarning(
  state: SkillState,
  ctx?: { entityDir?: string; currentVersion?: string },
): string | undefined {
  if (state.kind === 'absent') {
    const where = ctx?.entityDir !== undefined ? `到 ${ctx.entityDir}` : ''
    return `skill 未安装${where}；运行 \`qiyu skill install\` 安装`
  }
  if (state.kind === 'stale') {
    // 三种 stale 来源，文案必须各自准确——不能把「内容漂移」说成「版本不一致」：
    //   · 清单缺失/损坏 → 连安装版本都不可知；
    //   · 版本相同、仅内容哈希漂移 → 版本号相同，说「版本不一致」自相矛盾；
    //   · 版本不同 → 说清「安装于 X，当前 Y」。
    if (state.installedVersion === 'unknown') {
      return '无法确认已安装 skill 的版本（安装清单缺失或损坏）；运行 `qiyu skill install --force` 更新'
    }
    if (ctx?.currentVersion !== undefined && state.installedVersion === ctx.currentVersion) {
      return `已安装的 skill 内容与包内当前版本不一致（版本 ${state.installedVersion}）；运行 \`qiyu skill install --force\` 更新`
    }
    const current = ctx?.currentVersion !== undefined ? `，当前 ${ctx.currentVersion}` : ''
    return `已安装的 skill 与当前 CLI 版本不一致（安装于 ${state.installedVersion}${current}）；运行 \`qiyu skill install --force\` 更新`
  }
  return undefined
}

/**
 * 实体目录解析：显式 `QIYU_SKILL_DIR` 优先；测试环境（NODE_ENV === 'test'）且未
 * 显式设置时返回 undefined——**测试绝不读写真实 `~`**，且探测结果不得依赖开发者
 * 机器装没装过 skill（否则全量测试的 meta 形态随机器而变，理由见文件头注释）。
 * 纯空白（含空串）环境变量视为未设：空路径不是有意义的实体位置，前后空白也几乎
 * 不可能是路径的一部分（多半是 shell 里无意带入的）。
 */
export function resolveEntityDir(): string | undefined {
  const explicit = process.env.QIYU_SKILL_DIR?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  if (process.env.NODE_ENV === 'test') return undefined
  return defaultEntityDir(homedir())
}

/**
 * 包内 skill 源目录解析：发布形态是 `<包根>/dist/skill/qiyu`（Task 13 复制进去），
 * 源码态回退 `<repo>/src/skill/qiyu`。两者都不存在（如被裁剪的运行环境）返回
 * undefined **不抛**——探测是旁路，源都找不到就整个静默跳过。
 */
export function resolveSkillSourceDir(): string | undefined {
  // 本文件在源码态是 src/skill/detect.ts、发布态是 dist/skill/detect.js ——
  // 两级 dirname 后两种形态都落在包根，候选路径因此是同一句话。
  const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
  for (const rel of ['dist/skill/qiyu', 'src/skill/qiyu']) {
    const dir = path.join(base, rel)
    if (isRealDirectory(dir)) return dir
  }
  return undefined
}

/** 路径存在且是目录（顺符号链接）；其余一律 false，不抛。 */
function isRealDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** 清进程内探测缓存（测试用；不清的话换 tmp 目录装好实体后仍命中旧结果）。 */
export function __resetSkillDetectionForTest(): void {
  cache.clear()
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}
