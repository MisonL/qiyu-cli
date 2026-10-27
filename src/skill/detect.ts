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
//               前两支以「运行 `qiyu skill install --force` 更新」收尾——内容与包内
//               不同，不带 `--force` 只会跳过；第三支推**不带 `--force`** 的
//               `qiyu skill install`（正文与包内一致时它只补写清单）；
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
// 测试环境（`NODE_ENV === 'test'` 或 vitest 的 `VITEST=true`）的 `resolveEntityDirSources()`：
// 实体目录**不是**由 `--dir` / `QIYU_SKILL_DIR` 显式指定时返回 undefined、跳过真实路径
// 探测；`npm_config_qiyu_skill_dir` 排在测试门**之后**读取（G3 审查 [21]：宿主环境里的
// `npm_config_*` 不得泄进测试）。理由有二（全局约束 + brief Step 5）：
//   ① **测试绝不读写真实 `~`**——探测会 stat 用户 home 下的实体目录；
//   ② **探测结果不得依赖开发者机器装没装过 skill**——否则同一份测试在本机装过的
//      人那里全量多出 meta.warnings、没装过的人不出现，`toEqual({...})` 断言两种
//      命运。修门（跳过探测）而不是放宽断言。
// 另有显式开关 `QIYU_DISABLE_SKILL_PROBE`（在 `resolveEntityDirSources` 的测试门里读）；
// 被抑制时 `entityUndeterminedNote()` 给出可解释的文案——`skill where` 与 `--version` 的
// meta.warnings 都据此如实报告，不静默。
//
// 分层：`skill/` 叶子层，只 import `node:*`、`core/` 与 `skill/` 内部；`output.ts`
// **不得** import 本文件（Task 14 分层红线钉住）——提示文案经
// `output.setSkillWarning()` 注入，探测与输出解耦。

import { readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { contentHash, MANIFEST, type Manifest } from './install.js'
import { defaultEntityDir, readEnvByNormalizedKey } from './paths.js'

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

/** 已安装正文清单里**对外可报**的两个版本号（`skill where` 消费）。 */
export interface InstalledManifestInfo {
  /** 安装时那份 CLI 的包版本。 */
  version: string
  /** 安装时那份正文的契约版本（设计稿 D6）。 */
  skillContractVersion: number
}

/**
 * 读已安装正文的清单版本信息（`skill where` 用）。
 *
 * ⚠️ **为什么需要它**（2026-10-26 实测发现）：`SKILL.md` 教 Agent
 * 「用 `skill_contract_version` 判断手上的正文能否配这份 CLI」，但此前**没有任何命令
 * 报出已安装那份的契约号** —— `qiyu --version` 给的是 CLI 自己的，`skill check
 * --installed` 的 `meta.skill_contract_version` 同样是 CLI 自己的（容易被读成"已安装
 * 那份的"），`skill where` 完全不报。于是那句承诺是**空的**：Agent 手上没有可比的数。
 * 实测佐证：把已安装清单的 `skill_contract_version` 改成 99，上面三条命令的输出
 * 一字不变、`meta.warnings` 也不出现任何提示。
 *
 * 返回 `null` 的情形与 `readManifestStrict` 一致（缺失/损坏/字段不全），另外
 * **读不动**（EACCES 等）也归 `null` —— 本函数是排查命令的辅助，不该因为权限问题
 * 让整条 `skill where` 失败；调用方据此报 `null`（= 无法判定），不编造。
 *
 * 契约号还要求是**非负整数**（2026-10-26 审查）：`readManifestStrict` 只做类型检查
 * （`typeof === 'number'`），`1.5` / `-3` 都能溜进来。那些值不可能是任何一版安装器
 * 写出的契约号 —— 是一份**损坏**的清单，正确结论是「判定不了」（null），而不是拿它
 * 去比出一个 `compatible:false`：后者会让 Agent 以为「正文版本旧了，重装即可」，
 * 而真实状态是「清单坏了，重装前先确认没别的问题」。0 放行：合法判定归调用方，
 * 本函数只管「这是不是一个像样的契约号」。
 */
export function readInstalledManifestInfo(entityDir: string): InstalledManifestInfo | null {
  try {
    const m = readManifestStrict(entityDir)
    if (m === null) return null
    if (!Number.isInteger(m.skill_contract_version) || m.skill_contract_version < 0) return null
    return { version: m.version, skillContractVersion: m.skill_contract_version }
  } catch {
    return null
  }
}

// 进程内判定：同参只探测一次（spec D2.1 的「零成本」）。缓存**不会随文件系统变化自动
// 失效**，所以凡是「本进程刚改过实体目录」的路径都必须主动调 `resetSkillDetectionCache()`。
//
// ⚠️ 已知的生产形态是「CLI 每个命令一个新进程，缓存天然只活一次命令」，但 `cli.run()`
// 在同一进程里被多次调用是**真实存在的形态**（测试与嵌入式用法）：先 `--version`（探测
// 出 absent 并缓存）、再 `skill install` 装好实体、再 `--version` —— 不失效的话第三条仍
// 报「skill 未安装」（2026-10-22 review G4 的 D5）。因此 `skill install` 成功路径显式
// 失效，`resetSkillDetectionCache()` 是**正式的生产入口**，不再只是测试开关。
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
      // 清单缺失/损坏但正文与包内一致 → `planInstall` 返回 rewrite-manifest：不带
      // `--force` 的 `qiyu skill install` 就只补写清单、一个正文字节不动（brief D7）。
      // 推 `--force` 会让用户以为要覆盖正文——那是另一支（内容漂移/版本不一致）才需要。
      return '无法确认已安装 skill 的版本（安装清单缺失或损坏）；运行 `qiyu skill install` 更新'
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
 * 实体目录的来源（`skill where` / `install` 输出里的 `entity.source` 即此字符串）。
 *
 * 四个取值与解析优先级一一对应：`--dir` > `QIYU_SKILL_DIR` > `npm_config_qiyu_skill_dir`
 * > 默认位置（`~/.agents/skills/qiyu`）。`npm_config_qiyu_skill_dir` 是 postinstall 的
 * 安装通道（spec C5），命令层与探测层都必须认识它——否则「装到自定义目录」之后每条命令
 * 都误报「未安装」并建议再装一份（终审 I2）。
 */
/** 实体目录来源（优先级即数组顺序）—— 输出里的 `entity.source`/`entity_source` 取值。 */
export const ENTITY_SOURCES = ['--dir', 'QIYU_SKILL_DIR', 'npm_config_qiyu_skill_dir', 'default'] as const
export type EntitySource = typeof ENTITY_SOURCES[number]

/** 实体目录「没有确定」的原因——`skill where` 据此如实解释，而不是让下游静默。 */
export type EntityUndeterminedReason = 'env' | 'node-test'

export type EntityDirResolution =
  | {
      /** 实体目录的**绝对路径**（相对来源已按基准解析，G3 审查 C4）。 */
      dir: string
      /** 目录是由哪条规则定位到的（如实标注来源）。 */
      source: EntitySource
      decided: true
    }
  | {
      dir: undefined
      source: undefined
      decided: false
      /** 为什么没有确定（显式关闭开关，或测试门）。 */
      reason: EntityUndeterminedReason
    }

export interface EntityDirOptions {
  /** `skill install/check/where --dir` 的取值（未 trim；空白视为未设）。 */
  flagDir?: string | undefined
  /** 注入的环境变量（生产传 `process.env`；postinstall 传 `opts.env`）。 */
  env: NodeJS.ProcessEnv
  /** 默认实体位置的 home 根（缺省 `os.homedir()`）。 */
  home?: string
  /**
   * 相对路径的基准（缺省 `process.cwd()`）。
   *
   * npm 生命周期脚本必须传 `INIT_CWD ?? cwd`（见 `npmRelativeBase`）——npm 的 cwd 是包根，
   * 用户设 `npm_config_qiyu_skill_dir=./my-skill` 时按包根解析会装进 `node_modules`。
   */
  baseDir?: string
  /**
   * 是否应用测试门（缺省 true）。
   *
   * `postinstall` 传 false：它的 `env` 是 npm 给的（`npm_command === 'exec'` 等判据已经
   * 挡掉了测试借用的场景），与 `npm i -g` 的语义保持一致；而 `npm test` 自己会设
   * `INIT_CWD`/`VITEST`，若 postinstall 也吃这道门，测试就永远覆盖不到安装分支。
   *
   * **命令层**（`skill install/check/where`）也传 false：它是用户**显式发起**的查询，
   * 必须如实回答「实体在哪」——终审 I2 要求命令层认 `npm_config_qiyu_skill_dir` 这条
   * postinstall 通道（否则装到自定义目录的用户每条命令都误报「未安装」）。把它门掉
   * 只会把「装第二份实体」的病换一种形式治。
   */
  testGate?: boolean
}

/**
 * npm 相对路径的唯一基准（G3 审查 C3）：`INIT_CWD ?? cwd`。
 *
 * npm 生命周期脚本的 cwd 是**包根**（`node_modules/qiyu-cli`），用户执行 install 的目录
 * 是 `INIT_CWD`（spec C6：npm/pnpm/yarn/bun 唯一都提供的变量）。三处解析（postinstall、
 * 命令层、启动探测）统一按这一条基准走，「装到哪里」与「去哪里找」因此是同一个目录——
 * 此前 detect/commands 用 cwd、postinstall 用 INIT_CWD，相对路径下两者必然分叉。
 *
 * `cwd()` 由调用方注入（生产传 `() => process.cwd()`），本函数不直接读进程状态。
 */
export function npmRelativeBase(env: NodeJS.ProcessEnv, cwd: () => string): string {
  const init = env.INIT_CWD?.trim()
  if (init !== undefined && init !== '') return init
  return cwd()
}

/** 显式关闭启动探测的环境变量（用户 / 嵌入式调用方可用）。 */
export const DISABLE_PROBE_ENV = 'QIYU_DISABLE_SKILL_PROBE'

/**
 * 「进程像 Node 测试」——`NODE_ENV=test` **或** vitest 恒设的 `VITEST=true`。
 *
 * 两个都认的理由：只认 `NODE_ENV` 时，宿主把 `NODE_ENV` 改成别的值就能让本仓库的测试
 * 去读宿主路径（审查 [21] 的同一类风险：`.npmrc` 里的 `qiyu-skill-dir` 经 `npm_config_*`
 * 注入所有子进程）；只认 `VITEST` 时，裸 `node --test` 之类的运行器又不受控。
 * 两个都认 = 覆盖面最广、误伤最小。
 */
export function looksLikeNodeTest(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === 'test' || env.VITEST === 'true'
}

/**
 * 实体目录解析——**全仓唯一实现**（G3 审查 C3/C4）。
 *
 * 优先顺序：`--dir` > `QIYU_SKILL_DIR` > **[测试门]** > `npm_config_qiyu_skill_dir` > 默认。
 *
 * **所有来源的相对路径一律按 `baseDir` 解析成绝对路径**（C4）：此前 `--dir rel` 与
 * `QIYU_SKILL_DIR=rel` 原样返回，`skill install` 按进程 cwd 装、`skill where` 按另一个
 * cwd 比，链接状态因此报 dangling。绝对化之后三条通路对同一条相对写法得到同一个目录。
 *
 * **测试门**（追加审查 [21]/[57]）：
 *   · `QIYU_DISABLE_SKILL_PROBE` 置真 → 关闭（**显式**开关：调用方主动要求不探测）。
 *   · 进程像 Node 测试（`NODE_ENV=test` / `VITEST=true`）→ 关闭**隐式**来源：
 *     `npm_config_qiyu_skill_dir` 与默认位置都不再读，返回 `decided: false` + 原因。
 *     显式来源（`--dir` / `QIYU_SKILL_DIR`）在门之前，照常生效——测试正是靠它注入临时目录。
 *     理由有二：测试绝不读写真实 `~`（全局硬约束）；宿主 `.npmrc` 里的 `qiyu-skill-dir`
 *     会经 `npm_config_*` 注入**所有**子进程，不得泄进测试、把漂移提示写进模块级
 *     `pendingSkillWarning` 污染同文件后续断言（审查 [21] 实测 4 条红）。
 *
 * ⚠️ 与审查 [57] 的偏差（如实记录，不静默）：[57] 要求「`NODE_ENV=test` 本身不再作为
 * 关闭条件，只认显式开关」。本仓库**没有 vitest setup 文件**，且大量用例直接依赖
 * 「`NODE_ENV=test` → 探测被门挡掉」这条既有语义（`tests/skill/detect.test.ts`、
 * `tests/cli.test.ts` 各有用例逐条钉住），改成纯显式开关是一次全量测试改造，超出 G3 的
 * 授权范围。按 brief 允许的第二条路走：门保留，但**留下可解释痕迹**——
 * `entityUndeterminedNote()` 给出「为什么没定位到实体目录」的文案，`skill where` 如实报告，
 * 且显式开关 `QIYU_DISABLE_SKILL_PROBE` 始终可用。
 *
 * 本函数**纯字符串**，不碰磁盘；`home` 只用于默认位置（`defaultEntityDir(home)`），
 * 显式来源不经过 home——因此绝不会把相对路径解析成真实 home 下的路径。
 *
 * 三个调用方（`commands/skill.ts` 的 `resolveEntity`、`cli.ts` 的启动探测、`postinstall.ts`）
 * 都走这里；加第四种来源时只改这一处。
 */
export function resolveEntityDirSources(opts: EntityDirOptions): EntityDirResolution {
  const base = opts.baseDir ?? process.cwd()
  const resolve = (raw: string, source: EntitySource): EntityDirResolution => ({
    dir: path.resolve(base, raw),
    source,
    decided: true,
  })
  const flagDir = opts.flagDir?.trim()
  if (flagDir !== undefined && flagDir !== '') return resolve(flagDir, '--dir')
  const explicit = opts.env.QIYU_SKILL_DIR?.trim()
  if (explicit !== undefined && explicit !== '') return resolve(explicit, 'QIYU_SKILL_DIR')
  if (opts.testGate !== false) {
    if (readEnvByNormalizedKey(opts.env, DISABLE_PROBE_ENV) !== undefined) {
      return { dir: undefined, source: undefined, decided: false, reason: 'env' }
    }
    if (looksLikeNodeTest(opts.env)) {
      return { dir: undefined, source: undefined, decided: false, reason: 'node-test' }
    }
  }
  const fromNpm = readEnvByNormalizedKey(opts.env, 'npm_config_qiyu_skill_dir')
  if (fromNpm !== undefined) return resolve(fromNpm, 'npm_config_qiyu_skill_dir')
  return resolve(defaultEntityDir(opts.home ?? homedir()), 'default')
}

/** 实体未确定时给用户看的一句话（已确定返回 undefined）。 */
export function entityUndeterminedNote(
  resolution: EntityDirResolution,
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  if (resolution.decided) return undefined
  if (resolution.reason === 'env') {
    return `skill 实体目录未确定：探测已被 ${DISABLE_PROBE_ENV} 显式关闭；需要时显式给出 --dir 或 QIYU_SKILL_DIR`
  }
  return 'skill 实体目录未确定：当前进程像 Node 测试（NODE_ENV='
    + `${env.NODE_ENV ?? ''}，VITEST=${env.VITEST ?? ''}），且没有显式给出 --dir 或 QIYU_SKILL_DIR`
    + '——不读宿主 npm_config_qiyu_skill_dir、也不碰真实 home。'
    + '要定位实体请显式给出 --dir 或 QIYU_SKILL_DIR'
}

/**
 * 包内 skill 源目录解析：**与本模块同层**的 `qiyu/` 目录。
 *
 * 本文件在源码态是 `src/skill/detect.ts`、发布态是 `dist/skill/detect.js` ——
 * 两种形态下正文都在同层的 `qiyu/`（构建期由 `copy-assets.mjs` 复制进
 * `dist/skill/qiyu/`）。因此不需要在包根下猜路径。
 *
 * ⚠️ **不能先查 `<包根>/dist/skill/qiyu`**（CodeRabbit 审查）：仓库的 `prepare` 挂在
 * `npm run build` 上，任何 `npm install` / `npm ci` 都会产出 `dist/`。先查 dist 会让
 * 源码态（vitest / tsx / 本地开发）读到**构建期的旧副本**而不是刚改的 `src/` 正文：
 * `skill check` 对旧文本报零违规、启动探测哈希到旧值、`skill install` 装出旧副本。
 * 同层目录不存在（如被裁剪的运行环境）返回 undefined **不抛**——探测是旁路，
 * 源找不到就整个静默跳过。
 */
export function resolveSkillSourceDir(): string | undefined {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'qiyu')
  return isRealDirectory(dir) ? dir : undefined
}

/** 路径存在且是目录（顺符号链接）；其余一律 false，不抛。 */
function isRealDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * 清进程内探测缓存。
 *
 * **生产入口**（D5）：`skill install` 成功后会改变实体目录内容，同进程内后续的
 * `cli.run()` 必须重新探测，否则 `meta.warnings` 仍报「skill 未安装」（缓存按参数元组
 * 命中旧结论）。测试同样用它隔离用例（换 tmp 目录装好实体后不调用就会命中旧结果）。
 */
export function resetSkillDetectionCache(): void {
  cache.clear()
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}
