// src/commands/skill.ts —— F 子项目对用户的正式门面：`qiyu skill install/check/where`。
//
// 分层豁免（brief 第 6 条）：本文件是全仓**唯一**允许 import `skill/` 的 commands 文件 ——
// 它是 skill 子系统的门面；其余 commands 文件与 core/store/query/sync 一律不得 import
// `skill/`（Task 14 的分层测试钉住）。
//
// 三个子命令的分工（设计稿 D2/D3）：
//   · install —— 调 `installSkill` 复制正文 + 建 agent 链接。`--dry-run` 只算计划、不写盘；
//                `--link` 的值是 agent 名（不是路径），点名但目录不存在时**不创建目录**，
//                只进 warnings（spec D1）。
//   · check   —— 默认校验**包内那份**（CI 可跑，不依赖 `~/.agents/skills` 存在）；
//                `--installed` 校验已安装那份；`--compare` 两份都校验并报告差异。
//                有违规 → `ok(...)` 之后返回 1（与 `sync verify` 同一写法）。
//   · where   —— 纯只读：报告实体路径与各 agent 链接状态，**只报告、不修复、不删除**
//                （spec D2）。要修复就让用户重跑 `qiyu skill install`。
//
// 实体定位统一为 `--dir` > `QIYU_SKILL_DIR` > `defaultEntityDir(os.homedir())`；
// home 一律取 `os.homedir()`（测试用 `HOME` 注入，绝不读写真实 `~`）。
//
// `skill where` 的逐 agent 兜异常（brief 硬要求）：`linkState` 对自指/成环链接抛 ELOOP，
// `agentSkillDirs` 在 `~/.claude` 是文件时抛 ENOTDIR（Task 7 实测）。一个坏链接不能让
// 整条排查命令崩掉——每个 agent 的探测各自 try/catch，异常如实写进该 agent 的
// `state: 'unknown'` 与 `error`，其余照常报告。`agentSkillDirs` 本身是**整体抛出**的
// （paths.ts 在第一个坏路径就抛），所以它失败时退化为逐个已知 agent 探测，坏的那个
// 记 unknown，好的照常——否则「其余照常报告」在 ENOTDIR 下就落空了。

import { lstatSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describeArgs, fail, ok, setSkillWarning, usageFail } from '../output.js'
import { PACKAGE_VERSION, SKILL_CONTRACT_VERSION } from '../core/edition.js'
import { ERROR_KINDS } from '../core/errors.js'
import { TABLES } from '../store/schema.js'
import { COMMAND_TREE } from './tree.js'
import { checkSkillDir, type CheckContext, type CheckResult } from '../skill/check.js'
import { contentHash, installSkill } from '../skill/install.js'
import { detectSkillState, resolveSkillSourceDir } from '../skill/detect.js'
import {
  agentSkillDirs, defaultEntityDir, linkState, type AgentDir, type LinkState,
} from '../skill/paths.js'

/**
 * agent skills 目录下的链接名。与 `skill/install.ts` 的 `LINK_NAME` 是同一事实
 * （那里未导出；本任务只允许改三个文件，故在此镜像一份）。skill 身份固定为 `qiyu`。
 */
const LINK_NAME = 'qiyu'

/**
 * 已知 agent 的 skills 子目录。正常路径用 `agentSkillDirs(home)`（paths.ts 的事实源）；
 * 只在它整体抛出（ENOTDIR）时作为逐 agent 退化探测用。`Record` 的键是联合类型，
 * 新增/重命名 agent 时这里会编译失败——子目录字符串本身的漂移没有编译期保护，
 * 这是本任务不能改 paths.ts 的已知代价（报告里注明）。
 */
const AGENT_SUBDIRS: Record<AgentDir['name'], string> = {
  'claude-code': join('.claude', 'skills'),
  codex: join('.codex', 'skills'),
}

/**
 * 已知 agent 名（`--link` 的合法取值）。从 `AGENT_SUBDIRS` 的键派生，不再手写第二份：
 * `AgentDir['name']` 是类型层的唯一事实源，`Record` 保证这里覆盖全部成员。
 */
const KNOWN_AGENTS = Object.keys(AGENT_SUBDIRS) as AgentDir['name'][]

const SKILL_USAGE = `用法：qiyu skill <子命令> [参数]

子命令：
  skill install [--dir <path>] [--link <agent>]... [--no-link] [--force] [--dry-run]
                           安装 skill 正文到实体目录，并链接到已存在的 agent 目录
  skill check   [--installed | --compare] [--dir <path>]
                           校验 skill 正文引用与 CLI 契约是否一致（有违规退出码 1）
  skill where   [--dir <path>]
                           报告实体目录与各 agent 链接状态（只读，不修复）

实体目录定位：--dir > QIYU_SKILL_DIR > ~/.agents/skills/qiyu
--link 取值：claude-code、codex（可重复）。点名的 agent 目录不存在时不创建目录，只警告。
--dry-run 只输出将要做的动作，不写盘。

出错时 stdout 是 {"ok":false,"error":{code,kind,retryable,message,hint?}}。
  ⚠️ 请按 kind 分支，不要按 code —— code 只是个标签。

退出码：0 成功 · 1 业务错误 · 2 用法错误 · 3 网络错误 · 4 需要 --yes
`

// —— 参数解析 ——

interface FlagSpec {
  /** 吃一个值的 flag（如 `--dir`）。 */
  value: readonly string[]
  /** 可重复吃值的 flag（如 `--link`）。 */
  repeat: readonly string[]
  /** 布尔 flag。 */
  bool: readonly string[]
}

interface Parsed {
  values: Map<string, string>
  lists: Map<string, string[]>
  flags: Set<string>
  rest: string[]
}

/**
 * 解析叶子命令参数。次序与既有命令一致：`--help`/`-h`/`--pretty` 永远收下
 * （它们的裁决在 `prelude` 里按「未知/位置参数 → help → --pretty」进行），
 * 其余 token 必须是本子命令声明的 flag 或值位。
 *
 * 值位拒绝空串与纯空白（`--dir ""` 会让后续 `mkdtemp` 在 cwd 里落暂存目录）——
 * 缺值就是缺值，不能猜。
 */
function parseFlags(argv: string[], spec: FlagSpec): Parsed {
  const out: Parsed = { values: new Map(), lists: new Map(), flags: new Set(), rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '--help' || a === '-h' || a === '--pretty') {
      out.flags.add(a)
      continue
    }
    if (spec.value.includes(a) || spec.repeat.includes(a)) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--') || v.trim() === '') {
        throw new Error(`${a} 缺少取值`)
      }
      if (spec.repeat.includes(a)) {
        const list = out.lists.get(a) ?? []
        list.push(v)
        out.lists.set(a, list)
      } else {
        out.values.set(a, v)
      }
      i++
      continue
    }
    if (spec.bool.includes(a)) {
      out.flags.add(a)
      continue
    }
    if (a.startsWith('-')) throw new Error(`未知参数：${a}`)
    out.rest.push(a)
  }
  return out
}

/**
 * 叶子命令的公共裁决（与 `api list` / `sync` 同一条次序）：
 * 未知 flag 由 `parseFlags` 先拦；位置参数 → help → `--pretty`。
 * 返回退出码表示已裁决完；返回 null 表示继续执行。
 */
function prelude(parsed: Parsed, sub: string): number | null {
  if (parsed.rest.length > 0) {
    return usageFail(`未知参数：${describeArgs(parsed.rest)}。skill ${sub} 不接受位置参数`)
  }
  if (parsed.flags.has('--help') || parsed.flags.has('-h')) {
    process.stdout.write(SKILL_USAGE)
    return 0
  }
  if (parsed.flags.has('--pretty')) {
    return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
  }
  return null
}

/** 解析 + 公共裁决；失败时直接返回退出码。 */
function parseOrFail(argv: string[], spec: FlagSpec, sub: string): Parsed | number {
  let parsed: Parsed
  try {
    parsed = parseFlags(argv, spec)
  } catch (e) {
    return usageFail((e as Error).message)
  }
  const code = prelude(parsed, sub)
  return code ?? parsed
}

// —— 路径与错误工具 ——

type EntitySource = '--dir' | 'QIYU_SKILL_DIR' | 'default'

/** 实体定位：`--dir` > `QIYU_SKILL_DIR`（空白视为未设）> 默认位置。 */
function resolveEntity(flagDir: string | undefined): { dir: string; source: EntitySource } {
  if (flagDir !== undefined) return { dir: flagDir, source: '--dir' }
  const env = process.env.QIYU_SKILL_DIR?.trim()
  if (env !== undefined && env !== '') return { dir: env, source: 'QIYU_SKILL_DIR' }
  return { dir: defaultEntityDir(homedir()), source: 'default' }
}

function isErrno(err: unknown, code: string): boolean {
  return typeof err === 'object' && err !== null && (err as NodeJS.ErrnoException).code === code
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** 包内 skill 源目录缺失时的统一错误（安装包不完整，属于 CLI 自身缺陷）。 */
function sourceMissing(): number {
  return fail({
    code: 'internal', kind: 'internal', retryable: false,
    message: '找不到包内 skill 源目录（dist/skill/qiyu 与 src/skill/qiyu 都不存在）',
    hint: 'CLI 安装包可能不完整，请重装 qiyu-cli 后重试',
  })
}

/**
 * 「已安装的 skill 不存在」的业务错误（退出码 1，brief 明确要求）。
 *
 * ⚠️ kind 用 `unknown` 而不是新造一个：`ERROR_KINDS`（core/errors.ts）是错误 kind 的
 * **单一事实源**，本任务不允许改它；`store_not_initialized` 会误导 Agent 去跑
 * `qiyu store init`（那是数据库，不是 skill）。message 与 hint 已把动作说死，
 * `unknown` 在 errors.md 里的语义是「按 message 判断」——这里 message 足够明确。
 */
function notInstalled(entityDir: string): number {
  return fail({
    code: 'skill_not_installed', kind: 'unknown', retryable: false,
    message: `skill 未安装到 ${entityDir}`,
    hint: '先运行：qiyu skill install（可用 --dir 指定实体目录）',
  })
}

/** 读取 skill 目录失败（权限/目录结构异常）：环境问题，按 message 给出可操作归因。 */
function checkFailed(entityDir: string, detail: string): number {
  return fail({
    code: 'skill_check_failed', kind: 'unknown', retryable: false,
    message: `读取 skill 目录失败：${entityDir}（${detail}）`,
    hint: '请检查目录权限；若目录里有名为 *.md 的子目录，请改成文件或移走',
  })
}

// —— skill install ——

interface PlannedLink {
  agent: string
  path: string
  state: LinkState | 'unknown'
  action: 'keep' | 'create' | 'rebuild' | 'skip' | 'unknown'
  error?: string
}

/** 链接四态 → 安装会采取的动作（dry-run 输出用；与 install.ts 的分派表一致）。 */
function linkAction(state: LinkState | 'unknown'): PlannedLink['action'] {
  switch (state) {
    case 'ok': return 'keep'
    case 'missing': return 'create'
    case 'dangling': return 'rebuild'
    case 'foreign': return 'skip'
    case 'unknown': return 'unknown'
  }
}

/**
 * dry-run 的链接计划：只读探测，绝不建链、绝不建目录。
 * `explicitTargets` 非 undefined 时只规划用户点名的 agent（与 installSkill 的
 * `linkDirs` 语义一致）；否则自动探测全部已存在的 agent 目录。
 */
function planLinks(
  home: string,
  entityDir: string,
  explicitTargets: { name: string; dir: string }[] | undefined,
  noLink: boolean,
): { links: PlannedLink[]; warnings: string[] } {
  if (noLink) return { links: [], warnings: [] }
  let targets: { name: string; dir: string }[]
  if (explicitTargets !== undefined) {
    targets = explicitTargets
  } else {
    try {
      targets = agentSkillDirs(home).map((a) => ({ name: a.name, dir: a.dir }))
    } catch (e) {
      return {
        links: [],
        warnings: [`探测 agent skills 目录失败（${errMsg(e)}），本次不建链接`],
      }
    }
  }
  const links: PlannedLink[] = []
  const warnings: string[] = []
  for (const t of targets) {
    const linkPath = join(t.dir, LINK_NAME)
    try {
      const state = linkState(linkPath, entityDir)
      links.push({ agent: t.name, path: linkPath, state, action: linkAction(state) })
    } catch (e) {
      // ELOOP（自指/成环）等不落四态：如实记 unknown，不触碰。
      links.push({ agent: t.name, path: linkPath, state: 'unknown', action: 'unknown', error: errMsg(e) })
      warnings.push(`无法判定 ${t.name} 链接状态（${errMsg(e)}），安装时会跳过：${linkPath}`)
    }
  }
  return { links, warnings }
}

async function skillInstall(argv: string[]): Promise<number> {
  const parsed = parseOrFail(
    argv,
    { value: ['--dir'], repeat: ['--link'], bool: ['--force', '--dry-run', '--no-link'] },
    'install',
  )
  if (typeof parsed === 'number') return parsed

  const linkNames = [...new Set(parsed.lists.get('--link') ?? [])]
  const noLink = parsed.flags.has('--no-link')
  const force = parsed.flags.has('--force')
  const dryRun = parsed.flags.has('--dry-run')

  // 边界 4（brief）：互斥不猜「后者优先」。
  if (linkNames.length > 0 && noLink) {
    return usageFail('--link 与 --no-link 互斥：要么显式指定要链接的 agent，要么完全不建链接')
  }
  // 边界 1（brief）：值必须是已知 agent 名，而不是路径。
  const unknownAgents = linkNames.filter((n) => !(KNOWN_AGENTS as readonly string[]).includes(n))
  if (unknownAgents.length > 0) {
    return usageFail(`未知 agent：${describeArgs(unknownAgents)}。可用 agent：${KNOWN_AGENTS.join('、')}`)
  }

  const home = homedir()
  const { dir: entityDir, source } = resolveEntity(parsed.values.get('--dir'))
  const sourceDir = resolveSkillSourceDir()
  if (sourceDir === undefined) return sourceMissing()

  const warnings: string[] = []

  // 边界 2（brief）：用户显式点名的 agent 目录不存在 → 不创建目录（spec D1），
  // 该 agent 进 warnings，其余照常安装。显式点名意味着**只**链这些 agent。
  let explicitTargets: { name: string; dir: string }[] | undefined
  if (!noLink && linkNames.length > 0) {
    explicitTargets = []
    let detected: AgentDir[]
    try {
      detected = agentSkillDirs(home)
    } catch (e) {
      return fail({
        code: 'skill_agent_dirs_failed', kind: 'unknown', retryable: false,
        message: `无法探测 agent skills 目录：${errMsg(e)}`,
        hint: '请检查 ~/.claude、~/.codex 是否为目录后重试（不替用户创建或修复这些目录）',
      })
    }
    for (const name of linkNames) {
      const hit = detected.find((a) => a.name === name)
      if (hit === undefined) {
        warnings.push(`${name} 的 skills 目录不存在，跳过（不替用户创建目录）`)
        continue
      }
      explicitTargets.push({ name: hit.name, dir: hit.dir })
    }
  }
  // 边界 3（brief）：未给 --link 且未给 --no-link → 交给 installSkill 自己探测。
  const linkDirs = explicitTargets?.map((t) => t.dir)

  if (dryRun) {
    const state = detectSkillState(entityDir, sourceDir, PACKAGE_VERSION)
    let action: 'install' | 'update' | 'skip' | 'unknown'
    if (state.kind === 'absent') action = 'install'
    else if (state.kind === 'current') action = 'skip'
    else if (state.kind === 'stale') action = force ? 'update' : 'skip'
    else action = 'unknown'
    if (state.kind === 'stale' && !force) {
      warnings.push(`实体目录内容与包内不同（可能被手工修改），未覆盖；确认后可用 --force 覆盖：${entityDir}`)
    } else if (state.kind === 'unknown') {
      warnings.push(`无法判定实体目录状态（可能被文件占用或不可读）：${entityDir}`)
    }
    const planned = planLinks(home, entityDir, explicitTargets, noLink)
    warnings.push(...planned.warnings)
    return ok(
      {
        dry_run: true,
        entity_dir: entityDir,
        entity_source: source,
        source_dir: sourceDir,
        version: PACKAGE_VERSION,
        entity_state: state.kind,
        action,
        force,
        no_link: noLink,
        links: planned.links,
      },
      warnings.length > 0 ? { warnings } : undefined,
    )
  }

  let result
  try {
    result = await installSkill({
      home, sourceDir, version: PACKAGE_VERSION, force, entityDir,
      ...(linkDirs !== undefined ? { linkDirs } : {}),
      noLink,
    })
  } catch (e) {
    // installSkill 只在「源目录不可用 / 实体被文件占用 / 暂存写入失败」三类抛错。
    // kind 用 unknown：这三类都是环境或路径问题，说成 internal 等于谎称 CLI 有缺陷。
    return fail({
      code: 'skill_install_failed', kind: 'unknown', retryable: false,
      message: `skill 安装失败：${errMsg(e)}`,
      hint: '请检查 --dir 目标路径与 agent skills 目录的权限；若 --dir 指向的是文件，请改成目录路径',
    })
  }

  // ⚠️ 安装成功必须清掉启动时探测出的「未安装/已过期」提示（Task 10 审查疑虑 2）：
  // cli.run() 在分派前探测、注入进程级提示；同一进程里安装成功后再输出，
  // 那条提示已经过时。只提示、不改退出码——清掉即可，不重新探测（缓存同参仍旧）。
  setSkillWarning(undefined)

  const allWarnings = [...warnings, ...result.warnings]
  // installSkill 对幂等命中返回 skipped 且**无警告**（一个字节都没写）。命令层补一句
  // 「已存在」——brief 要求重复安装时 meta.warnings 能说明发生了什么，否则 Agent 只能
  // 从 status 猜。内容不同的 skipped 自带 --force 警告，不重复。
  if (result.status === 'skipped' && result.warnings.length === 0) {
    allWarnings.push(`skill 已存在且内容一致，未做任何改动：${result.entityDir}`)
  }

  return ok(
    {
      dry_run: false,
      entity_dir: result.entityDir,
      entity_source: source,
      source_dir: sourceDir,
      version: PACKAGE_VERSION,
      status: result.status,
      links: result.links,
    },
    allWarnings.length > 0 ? { warnings: allWarnings } : undefined,
  )
}

// —— skill check ——

/** 校验上下文：命令树 / 表名 / 错误 kind 全部从各自的权威位置取。 */
const CHECK_CONTEXT: CheckContext = {
  tree: COMMAND_TREE,
  tableNames: TABLES.map((t) => t.name),
  errorKinds: ERROR_KINDS,
}

type CheckOutcome = { result: CheckResult } | { error: string }

/** `checkSkillDir` 不吞错（brief 第 2 条）：命令层守卫，转成可读错误。 */
function runCheck(dir: string): CheckOutcome {
  try {
    return { result: checkSkillDir(dir, CHECK_CONTEXT) }
  } catch (e) {
    return { error: errMsg(e) }
  }
}

/** check 的 meta：契约版本恒在（设计稿 D6）；无法静态判定的条目进 warnings。 */
function checkMeta(warnings: string[]): Record<string, unknown> {
  return {
    skill_contract_version: SKILL_CONTRACT_VERSION,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

/** 单基准（包内 / 已安装）的报告与退出码。 */
function reportSingle(
  mode: 'package' | 'installed',
  dir: string,
  result: CheckResult,
): number {
  const code = ok(
    { mode, baseline: dir, violations: result.violations, unverifiable: result.warnings },
    checkMeta(result.warnings.map((w) => w.detail)),
  )
  return result.violations.length > 0 ? 1 : code
}

interface DirProbe {
  exists: boolean
  isDir: boolean
  error?: string
}

/** stat 一个路径：ENOENT → 不存在；其余错误如实带出（ENOTDIR/EACCES）。 */
function probeDir(dir: string): DirProbe {
  try {
    return { exists: true, isDir: statSync(dir).isDirectory() }
  } catch (e) {
    if (isErrno(e, 'ENOENT')) return { exists: false, isDir: false }
    return { exists: true, isDir: false, error: errMsg(e) }
  }
}

async function skillCheck(argv: string[]): Promise<number> {
  const parsed = parseOrFail(
    argv,
    { value: ['--dir'], repeat: [], bool: ['--installed', '--compare'] },
    'check',
  )
  if (typeof parsed === 'number') return parsed

  const wantInstalled = parsed.flags.has('--installed')
  const wantCompare = parsed.flags.has('--compare')
  if (wantInstalled && wantCompare) {
    return usageFail('--installed 与 --compare 互斥：一次只能选一种校验基准')
  }
  const { dir: entityDir, source } = resolveEntity(parsed.values.get('--dir'))

  // —— 默认：包内那份（CI 可跑） ——
  if (!wantInstalled && !wantCompare) {
    const pkgDir = resolveSkillSourceDir()
    if (pkgDir === undefined) return sourceMissing()
    const outcome = runCheck(pkgDir)
    if ('error' in outcome) return checkFailed(pkgDir, outcome.error)
    return reportSingle('package', pkgDir, outcome.result)
  }

  // —— --installed：已安装那份 ——
  if (wantInstalled) {
    const probe = probeDir(entityDir)
    if (!probe.exists) return notInstalled(entityDir)
    if (probe.error !== undefined) return checkFailed(entityDir, probe.error)
    if (!probe.isDir) {
      return fail({
        code: 'skill_not_installed', kind: 'unknown', retryable: false,
        message: `已安装路径不是目录：${entityDir}`,
        hint: '用 --dir 指向 skill 实体目录（默认 ~/.agents/skills/qiyu）',
      })
    }
    const outcome = runCheck(entityDir)
    if ('error' in outcome) return checkFailed(entityDir, outcome.error)
    return reportSingle('installed', entityDir, outcome.result)
  }

  // —— --compare：两份都比并报告差异 ——
  const pkgDir = resolveSkillSourceDir()
  if (pkgDir === undefined) return sourceMissing()
  const pkgOutcome = runCheck(pkgDir)
  if ('error' in pkgOutcome) return checkFailed(pkgDir, pkgOutcome.error)

  const differences: string[] = []
  const installedData: Record<string, unknown> = { dir: entityDir, present: false }
  let installedUnverifiable: { line: number; detail: string }[] = []
  let installedViolations = 0
  let installedFailed = false

  const probe = probeDir(entityDir)
  if (!probe.exists) {
    differences.push(`已安装目录不存在：${entityDir}`)
    installedFailed = true
  } else if (probe.error !== undefined || !probe.isDir) {
    const why = probe.error ?? '不是目录'
    differences.push(`已安装路径不可用：${entityDir}（${why}）`)
    installedData.error = why
    installedFailed = true
  } else {
    const outcome = runCheck(entityDir)
    if ('error' in outcome) {
      differences.push(`已安装目录读取失败：${outcome.error}`)
      installedData.error = outcome.error
      installedFailed = true
    } else {
      installedViolations = outcome.result.violations.length
      installedUnverifiable = outcome.result.warnings
      installedData.present = true
      installedData.violations = outcome.result.violations
      installedData.unverifiable = outcome.result.warnings
      // 内容哈希与违规数：前者回答「两份正文是否一致」，后者回答「判定结果是否一致」。
      try {
        if (contentHash(pkgDir) !== contentHash(entityDir)) {
          differences.push('包内与已安装的正文内容不同（content_hash 不一致）')
        }
      } catch (e) {
        differences.push(`内容哈希比较失败：${errMsg(e)}`)
      }
      if (installedViolations !== pkgOutcome.result.violations.length) {
        differences.push(
          `违规数不同：包内 ${pkgOutcome.result.violations.length} 处，已安装 ${installedViolations} 处`,
        )
      }
    }
  }

  const warnings = [
    ...pkgOutcome.result.warnings.map((w) => `包内：${w.detail}`),
    ...installedUnverifiable.map((w) => `已安装：${w.detail}`),
  ]
  const code = ok(
    {
      mode: 'compare',
      entity_source: source,
      package: {
        dir: pkgDir,
        violations: pkgOutcome.result.violations,
        unverifiable: pkgOutcome.result.warnings,
      },
      installed: installedData,
      differences,
    },
    checkMeta(warnings),
  )
  const bad = installedFailed
    || pkgOutcome.result.violations.length > 0
    || installedViolations > 0
  return bad ? 1 : code
}

// —— skill where ——

interface LinkReport {
  agent: string
  path: string
  state: LinkState | 'unknown'
  error?: string
}

/**
 * 逐 agent 探测链接状态。正常路径用 `agentSkillDirs(home)`（只返回已存在的目录）；
 * 它整体抛出（ENOTDIR）时退化为逐个已知 agent 探测——坏的那个记 unknown，
 * 好的照常报告，兑现 brief「其余照常报告」。
 *
 * 每个 agent 的 `linkState` 各自 try/catch：自指/成环链接抛 ELOOP，
 * 一个坏链接不能让整条排查命令崩掉（brief 硬要求）。
 */
function probeAgentLinks(
  home: string,
  entityDir: string,
): { links: LinkReport[]; warnings: string[] } {
  const links: LinkReport[] = []
  const warnings: string[] = []
  let targets: { name: string; dir: string }[]

  try {
    targets = agentSkillDirs(home).map((a) => ({ name: a.name, dir: a.dir }))
  } catch (e) {
    warnings.push(`枚举 agent skills 目录失败（${errMsg(e)}），改为逐个 agent 探测`)
    targets = []
    for (const name of KNOWN_AGENTS) {
      const dir = join(home, AGENT_SUBDIRS[name])
      try {
        lstatSync(dir)
        targets.push({ name, dir })
      } catch (err) {
        if (isErrno(err, 'ENOENT')) continue
        // 目录本身不可检查（如父级是文件 → ENOTDIR）：如实记 unknown，继续下一个。
        links.push({ agent: name, path: join(dir, LINK_NAME), state: 'unknown', error: errMsg(err) })
        warnings.push(`${name} 的 skills 目录无法检查（${errMsg(err)}）：${dir}`)
      }
    }
  }

  for (const t of targets) {
    const linkPath = join(t.dir, LINK_NAME)
    try {
      links.push({ agent: t.name, path: linkPath, state: linkState(linkPath, entityDir) })
    } catch (e) {
      links.push({ agent: t.name, path: linkPath, state: 'unknown', error: errMsg(e) })
      warnings.push(`${t.name} 的链接状态无法判定（${errMsg(e)}）：${linkPath}`)
    }
  }
  return { links, warnings }
}

async function skillWhere(argv: string[]): Promise<number> {
  const parsed = parseOrFail(argv, { value: ['--dir'], repeat: [], bool: [] }, 'where')
  if (typeof parsed === 'number') return parsed

  const { dir: entityDir, source } = resolveEntity(parsed.values.get('--dir'))
  const warnings: string[] = []

  // 实体状态：只读 stat；ENOENT 是「未安装」，其余异常如实记 unknown。
  let entity: Record<string, unknown>
  try {
    const st = statSync(entityDir)
    entity = { path: entityDir, source, exists: true, state: st.isDirectory() ? 'ok' : 'not_a_directory' }
  } catch (e) {
    if (isErrno(e, 'ENOENT')) {
      entity = { path: entityDir, source, exists: false, state: 'missing' }
    } else {
      warnings.push(`实体路径无法检查（${errMsg(e)}）：${entityDir}`)
      entity = { path: entityDir, source, exists: false, state: 'unknown', error: errMsg(e) }
    }
  }

  const probed = probeAgentLinks(homedir(), entityDir)
  warnings.push(...probed.warnings)
  return ok(
    { entity, links: probed.links },
    warnings.length > 0 ? { warnings } : undefined,
  )
}

// —— 分派 ——

export async function skillCommand(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  // `--help` 不吞额外参数（与 cli.ts / auth.ts 同一条规则）；`--pretty` 豁免。
  if (sub === undefined || sub === '--help' || sub === '-h') {
    if (sub === undefined) {
      return usageFail('用法：qiyu skill <install|check|where> [参数]（`qiyu skill --help` 查看全部）')
    }
    const extra = rest.filter((a) => a !== '--help' && a !== '-h' && a !== '--pretty')
    if (extra.length > 0) {
      return usageFail(`未知参数：${describeArgs(extra)}。--help 不接受额外参数`)
    }
    process.stdout.write(SKILL_USAGE)
    return 0
  }
  // 分派层的 `--pretty` 与叶子层同答：它是承诺过、未实现的合法 flag，不是未知子命令。
  if (sub === '--pretty') {
    const unknown = rest.filter((a) => a.startsWith('-') && a !== '--pretty' && a !== '--help' && a !== '-h')
    const positional = rest.filter((a) => !a.startsWith('-'))
    const extra = [...unknown, ...positional]
    if (extra.length > 0) {
      return usageFail(`未知参数：${describeArgs(extra)}。--pretty 尚未实现，不接受额外参数`)
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(SKILL_USAGE)
      return 0
    }
    return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
  }
  if (sub !== 'install' && sub !== 'check' && sub !== 'where') {
    return usageFail(`未知子命令：${describeArgs([sub])}\n可用子命令：install、check、where`)
  }
  if (sub === 'install') return skillInstall(rest)
  if (sub === 'check') return skillCheck(rest)
  return skillWhere(rest)
}
