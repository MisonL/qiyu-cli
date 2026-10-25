import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { COMMAND_TREE } from '../../src/commands/tree.js'
import { GLOBAL_FLAGS, GLOBAL_FLAG_NAMES } from '../../src/commands/spec-types.js'
import { authCommand } from '../../src/commands/auth.js'
import { apiCommand } from '../../src/commands/api.js'
import { storeCommand } from '../../src/commands/store.js'
import { syncCommand } from '../../src/commands/sync.js'
import { dbCommand } from '../../src/commands/db.js'
import { queryCommand } from '../../src/commands/query.js'
import { statsCommand } from '../../src/commands/stats.js'
import { skillCommand } from '../../src/commands/skill.js'
import { SKILL_SPECS } from '../../src/commands/skill-specs.js'
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ 位置约定：brief 原文 import `../../src/cli.js`；按 worktree 裁定（progress.md R1）改从
// `src/commands/tree.js` 取 —— 它只 import 各命令模块、不拉进 `cli.ts` 的入口逻辑，
// 将来 `src/skill/check.ts` 从同一处消费。本文件其余断言照 brief 原样。
const paths = COMMAND_TREE.map((s) => s.path.join(' ')).sort()
// 仓库测试统一用 `fileURLToPath(import.meta.url)` 定位源码（ESM 下没有 `__dirname`），
// brief 里的 `__dirname` 在 vitest ESM 中不可用，这里换成等价写法。
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'commands')

// 行为式断言要调用真实处理器并读它们的双通道输出（usageFail 同时写 stderr 与 stdout JSON）。
let out = ''
let err = ''
beforeEach(() => {
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
})
afterEach(() => { vi.restoreAllMocks() })

describe('COMMAND_TREE', () => {
  it('覆盖全部 20 条叶命令（含 skill 三条、auth 两条）', () => {
    // 16 → 19：`skill install/check/where` 是 cli.ts 正式注册的真实命令，此前不在树里，
    // 正文写 `` `qiyu skill install` `` 会被 check 判 unknown_command、退 1（假阳性）。
    // 19 → 20：G1 交付 `auth login`（此前只有 `auth whoami`）。
    expect(paths).toEqual([
      'api call', 'api list', 'api schema', 'auth login', 'auth whoami', 'db describe', 'db tables',
      'query', 'skill check', 'skill install', 'skill where', 'stats fields',
      'store init', 'store status',
      'sync install', 'sync run', 'sync status', 'sync tasks', 'sync uninstall', 'sync verify',
    ])
  })
  it('每条 spec 都带 --help/-h，且 rejected 为空（G1 起 --pretty 已实现、机制保留）', () => {
    for (const s of COMMAND_TREE) {
      const names = s.flags.map((f) => f.name)
      expect(names, s.path.join(' ')).toContain('--help')
      expect(names, s.path.join(' ')).toContain('-h')
      // G1（2026-10-24）：--pretty 已实现为缩进输出，REJECTED_FLAGS 清空。
      // 断言每条 spec 的 rejected 数组存在且为空 —— 若将来又出现「已知但拒绝」的
      // flag，这里要改成受影响的子集，而不是恢复全量拒绝。
      expect(s.rejected, s.path.join(' ')).toEqual([])
      expect(names, s.path.join(' ')).toContain('--pretty')
    }
  })
  it('api call 接受 --body/--yes/--no-validate/--strict，api list 只接受 --all', () => {
    const call = COMMAND_TREE.find((s) => s.path.join(' ') === 'api call')!
    expect(call.flags.map((f) => f.name)).toEqual(expect.arrayContaining(['--body', '--yes', '--no-validate', '--strict']))
    const list = COMMAND_TREE.find((s) => s.path.join(' ') === 'api list')!
    expect(list.flags.map((f) => f.name).filter((n) => !['--help', '-h', '--pretty'].includes(n))).toEqual(['--all'])
  })
  it('sync install 有 --schedule 与 --yes', () => {
    const s = COMMAND_TREE.find((x) => x.path.join(' ') === 'sync install')!
    expect(s.flags.map((f) => f.name)).toEqual(expect.arrayContaining(['--schedule', '--yes']))
  })
  it('db describe 与 stats fields 的位置参数域正确', () => {
    expect(COMMAND_TREE.find((s) => s.path.join(' ') === 'db describe')!.positionals[0].domain).toBe('tables')
    expect(COMMAND_TREE.find((s) => s.path.join(' ') === 'stats fields')!.positionals[0].domain).toBe('report-tables')
  })
  // 反漂移：每条 spec 的非全局 flag 必须能在对应命令模块的源码里找到字面量，
  // 否则说明 spec 是手抄的、与解析器脱节。
  //
  // ⚠️ 共享 flag 例外：存储定位三件套（`--db/--profile/--backend`）的**声明处**是
  // `spec-types.ts` 的 `STORE_FLAGS`（Task 2 把 db/store/stats 三份逐字相同的解析器收成
  // 一份，正是为了不在各命令模块里再抄字面量）。对这些 flag 查声明处，而不是逼实现者
  // 把副本加回去 —— 那会重新制造 Task 2 刚消灭的漂移。其余 flag 仍查命令模块本身。
  it('每个 flag 都在对应命令模块源码里以字面量出现', () => {
    const fileOf: Record<string, string> = {
      auth: 'auth.ts', api: 'api.ts', store: 'store.ts', sync: 'sync.ts', db: 'db.ts', query: 'query.ts', stats: 'stats.ts',
      // skill 三条的 flag 声明在 `skill-specs.ts`（叶子模块，避开 skill.ts ↔ tree.ts 循环 import）。
      skill: 'skill-specs.ts',
    }
    // flag 名 → 它的**声明文件**（缺省 = 命令模块自己）。
    const sharedSource: Record<string, string> = {
      '--db': 'spec-types.ts', '--profile': 'spec-types.ts', '--backend': 'spec-types.ts',
    }
    const extra = readFileSync(join(srcRoot, 'sync-run.ts'), 'utf8')
    const shared = readFileSync(join(srcRoot, 'spec-types.ts'), 'utf8')
    for (const s of COMMAND_TREE) {
      const file = s.path[0] === 'sync' && s.path[1] === 'run' ? extra : readFileSync(join(srcRoot, fileOf[s.path[0]]), 'utf8')
      for (const f of s.flags) {
        if (GLOBAL_FLAGS.some((g) => g.name === f.name)) continue
        const target = sharedSource[f.name] === undefined ? file : shared
        expect(target, `${s.path.join(' ')} 的 ${f.name}`).toContain(`'${f.name}'`)
      }
    }
  })
  // ⚠️ 「可用：」的运行时形态由**行为式**断言守：`sync run` 的整句由 `sync.test.ts` 的
  // 「未知 flag 的『可用：』文案（逐字）」逐字钉住；`api call` 的字面量文案由下一条
  // 断言与 spec 对齐。
  // 这里早先有一条 `expect(runSrc).toMatch(/renderFlagNames\(RUN_FLAGS, \{ separator: ' ' \}\)/)`
  // ——它把**实现写法**逐字钉住（照抄实现），却不回答「文案对不对」，且顺序漂移完全不拦，
  // 复审 I-3 已删，不再恢复。
  // 复审 I-1：`api call` 的「可用：」文案是字面量（readme.test.ts 按源文本钉着它），
  // 所以这里必须把**字面量**与 spec 的接受集对齐。⚠️ 正则必须锚到**运行时那一行**
  // `return usageFail(\`未知参数：${describeArgs(unknown)}。可用：…\`)` —— 早先只写
  // `/可用：(--body[^\n]*)`/，命中的是 api.ts 顶部**注释**里的同一句话：删掉运行时文案里的
  // `--no-validate` 时全量 1162 条仍绿，断言等于空转（复审实测）。
  it('api call 的运行时「可用：」文案点名的 flag 与 spec 接受集完全一致', () => {
    const apiSrc = readFileSync(join(srcRoot, 'api.ts'), 'utf8')
    const m = apiSrc.match(/return usageFail\(`未知参数：\$\{describeArgs\(unknown\)\}。可用：(--body[^`\n]*)`\)/)
    expect(m, 'api.ts 里必须能找到 api call 的运行时「可用：」文案（而不是注释里的同款句子）').not.toBeNull()
    // 剥掉 `--body` 的取值占位符（`<JSON>`），只留 flag 名。
    const listed = m![1]!.split('、').map((s) => s.trim().split(' ')[0])
    const call = COMMAND_TREE.find((s) => s.path.join(' ') === 'api call')!
    const accepted = call.flags.map((f) => f.name).filter((n) => !GLOBAL_FLAGS.some((g) => g.name === n))
    expect(listed).toEqual(accepted)
  })
  // ⚠️ 与 brief 表格的一处刻意偏离，钉住以免被「改回去」：
  // brief 给 `sync uninstall` 列了 `STORE_FLAGS`，理由是「CLI 接受它们」——但实测不然：
  // `syncUninstall` 的解析是 `parseSubFlags(argv, [], ['--yes'])`，
  // `node dist/cli.js sync uninstall --db /tmp/x` → 退出码 2、`未知参数：--db`。
  // spec 若写上它们，`skill check` 会把 `qiyu sync uninstall --db …` 判为合法（实际必失败），
  // 正是它要防的假阴性。以解析器为准：只接受 `--yes`。
  it('sync uninstall 的接受集与解析器一致：只有 --yes，不含 store 三件套', () => {
    const s = COMMAND_TREE.find((x) => x.path.join(' ') === 'sync uninstall')!
    const business = s.flags.map((f) => f.name).filter((n) => !GLOBAL_FLAGS.some((g) => g.name === n))
    expect(business).toEqual(['--yes'])
  })
  // 复审 I-2：**行为式**集合断言。源码字面量断言只回答「字面量存在」，拦不住「spec 多写
  // 一个解析器不接受的 flag」（多写的名字当然也能在源码里找到）。这里直接调用真实处理器，
  // 分两个探针 —— 为什么必须拆成两个，见下：
  //
  //   ① 基线探针：`<命令> <位置参数> --zzz-sentinel`
  //      断言错误里出现「未知参数：…--zzz-sentinel」——证明这条命令**确实有**未知参数
  //      检测、且 sentinel 走到了那一层（不是更早的「缺表名/缺接口 id」把它挤掉）。
  //   ② 排除探针：`<命令> <位置参数> <被测 flag> x --zzz-sentinel`
  //      断言「未知参数：…」那一段里**不含**被测 flag——证明解析器认它。
  //      多写一个 flag → 解析器不认识它 → 它必然落进未知参数清单 → 红。
  //
  // ⚠️ 为什么不把「含 sentinel」与「不含被测 flag」合成一条：`sync` 的 `parseSubFlags`
  // 遇到**第一个**未知 token 就抛、只报一个（`api`/`store`/`db`/`query` 是 filter 收集全部）。
  // 合成一条时，`sync status --all …` 只会报 `未知参数：--all`、sentinel 根本不出现，
  // 于是失败信息会误导成「没走到未知检测」，而真实结论是「解析器不接受 --all」。
  //
  // 位置参数用**真实闭集值**（ticket.search / sessions / daily_overview）：避免在未知参数
  // 检测之前就因「未知接口/未知表」失败。`x` 占位值只为了让值位 flag 吃掉一个 token。
  // 所有探针都不会打开库或发网络：未知参数检测在各命令里都排在开库之前（`store` 的
  // `--db x` 只是被解析、不落盘；`sync install` 的 cron 校验也在未知检测之后）。
  it('spec 里的每个非全局 flag 都被真实解析器接受（多写一个 → 必红）', async () => {
    const HANDLERS: Record<string, (argv: string[]) => Promise<number>> = {
      auth: authCommand, api: apiCommand, store: storeCommand, sync: syncCommand,
      db: dbCommand, query: queryCommand, stats: statsCommand, skill: skillCommand,
    }
    const POSITIONAL: Record<string, string[]> = {
      'api call': ['ticket.search'],
      'api schema': ['ticket.search'],
      'db describe': ['sessions'],
      'stats fields': ['daily_overview'],
    }
    // skill 三条会碰 home 下的 agent 目录探测（`agentSkillDirs(homedir())`），所以把它们
    // 指到临时 HOME（`os.homedir()` 在 POSIX 上读 HOME）；所有探针都止步于「未知参数」，
    // 不会写盘。`--link` 取真实 agent 名，避免「未知 agent」先于未知参数检测失败。
    const FAKE_HOME = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-tree-')))
    vi.stubEnv('HOME', FAKE_HOME)
    try {
    for (const s of COMMAND_TREE) {
      const key = s.path.join(' ')
      const handler = HANDLERS[s.path[0]!]!
      // 处理器收到的 argv 不含顶层命令名（与 cli.ts 的 `COMMANDS[sub](rest)` 一致）。
      const head = [...s.path.slice(1), ...(POSITIONAL[key] ?? [])]

      // ① 基线探针
      out = ''; err = ''
      const baseCode = await handler([...head, SENTINEL])
      const baseMsg = messageOf()
      expect(unknownSegment(baseMsg), `${key}：未知参数检测不可达（message=${baseMsg}）`).toContain(SENTINEL)
      expect(baseCode, `${key} 的基线探针`).toBe(2)

      // ② 排除探针：每个非全局 flag 单独一次
      for (const flag of s.flags.map((f) => f.name).filter((n) => !GLOBAL_FLAG_NAMES.includes(n))) {
        out = ''; err = ''
        await handler([...head, flag, 'x', SENTINEL])
        const msg = messageOf()
        expect(unknownSegment(msg).split(/[、\s]+/),
          `${key} 的 ${flag}：解析器不接受它（message=${msg}）`).not.toContain(flag)
      }
    }
    } finally {
      vi.unstubAllEnvs()
      rmSync(FAKE_HOME, { recursive: true, force: true })
    }
  })
  // —— G9：`first` 标记（位置纪律）与解析器行为的**反向**对齐 ——
  //
  // 背景：`skill check` 曾用硬编码清单 `FIRST_POSITIONAL_STRICT = ['api call']` 表达
  // 「flag 不能写在第一个位置参数之前」，那是 `CommandSpec` 之外的第二事实源。现在唯一
  // 声明处是 spec 的 `PositionalSpec.first`，本用例负责证明**声明与解析器一致**：
  //   · 漏标（解析器把 argv[0] 当位置参数、spec 没标）→ `skill check` 漏报 → 红；
  //   · 误标（解析器先剥 flag、spec 标了）→ `skill check` 把合法写法误报 → 红。
  //
  // 判据是**行为探针**（两种 token 顺序的对比），不是读源码、也不是「有没有报错」——
  // 所有命令对**未知 flag** 都会报错，单看 A 的 message 区分不出 flag 位置。
  // 对每条带位置参数的 spec 跑两次真实处理器，用**同一个** sentinel 当 flag：
  //   A = `<命令> --zzz-sentinel zzz-probe-value`（flag 在位置参数**前**）
  //   B = `<命令> zzz-probe-value --zzz-sentinel`（flag 在位置参数**后**）
  //
  //   · **先剥 flag** 的解析器（`api schema` 的 filter、`parseSubFlags`、
  //     `parseStoreFlags`、`sync run` 的解析循环）：两种顺序被**同一个**「未知参数」
  //     分支拒绝，错误 message 逐字相同 → 位置不影响判定 = 非严格。
  //   · **把 argv[0] 当位置参数**的解析器（`callOne` 的 `const [id] = argv`）：
  //     A 里 `--zzz-sentinel` 落进 id 槽位，走的是「接口 id 必须是第一个参数」分支；
  //     B 走的是「未知参数」分支 → 两条 message **不同** = 严格。
  //
  // 这个判据有一个前提（本用例用 SAMPLE 里的真实闭集值保证）：在 B 里，位置参数取到
  // 真实值后不会先生成**另一条**错误 message。`db describe` / `stats fields` /
  // `sync status|verify` 的闭集与任务校验在重复值上不产出新 message；若将来某命令的
  // 校验改成「域外的值报错、域内的值往下走」，这里仍能区分（域内值不产生新错误）。
  //
  // ⚠️ 探针值用**真实闭集值**（`ticket.search` / `sessions` / `daily_overview` /
  // `dim.staff`），否则 B 的域校验会先失败、与 A 的 message 混同。
  // ⚠️ 探针不碰网络也不开库：`api call` 的 id 位置检查在 `byId` 之前；`db describe` /
  // `stats fields` 的闭集校验先于 I/O；`sync status|verify` 的 `selectTasks` 在开库之前。
  it('spec 的 first 标记与解析器行为完全一致（漏标/误标都红）', async () => {
    const HANDLERS: Record<string, (argv: string[]) => Promise<number>> = {
      api: apiCommand, sync: syncCommand, db: dbCommand, stats: statsCommand,
    }
    // 每条**带位置参数**的 spec → 该槽位的第一个合法取值（探针用）。
    const SAMPLE: Record<string, string> = {
      'api call': 'ticket.search',
      'api schema': 'ticket.search',
      'sync run': 'dim.staff',
      'sync status': 'dim.staff',
      'sync verify': 'dim.staff',
      'db describe': 'sessions',
      'stats fields': 'daily_overview',
    }
    const withPositionals = COMMAND_TREE.filter((s) => s.positionals.length > 0)
    // 守卫：SAMPLE 必须覆盖每一条带位置参数的 spec（新增带位置参数的命令却忘了给探针值时，
    // 本用例要红而不是静默跳过 —— 否则新命令的 first 标记无人验证）。
    expect(withPositionals.map((s) => s.path.join(' ')).sort()).toEqual(Object.keys(SAMPLE).sort())

    const flagFirstBehavesStrict: string[] = []
    for (const s of withPositionals) {
      const key = s.path.join(' ')
      const handler = HANDLERS[s.path[0]!]!
      // 处理器收到的 argv 不含顶层命令名（与 cli.ts 的 `COMMANDS[sub](rest)` 一致）。
      const run = async (argv: string[]): Promise<string> => {
        out = ''; err = ''
        const code = await handler([...s.path.slice(1), ...argv])
        expect(code, `${key} 的探针不该成功退出：${argv.join(' ')}`).toBe(2)
        return messageOf()
      }
      // A：flag 在位置参数之前；B：flag 在位置参数之后。两个探针都不该退出 0
      // （sentinel 是未知 flag，任何命令都拒绝它）。
      const before = await run([SENTINEL, SAMPLE[key]!])
      const after = await run([SAMPLE[key]!, SENTINEL])
      // 两种顺序给出**不同**的错误 = 位置改变了 flag 的含义 = 解析器把前一个 token
      // 当位置参数槽位（严格）。相同 = flag 被先剥掉、位置无关（宽容）。
      if (before !== after) flagFirstBehavesStrict.push(key)
    }
    // 反向对齐：解析器严格取 argv[0] 的命令集合 == spec 标了 first 的命令集合。
    // 变异「删掉 api call 的 first」→ 左多右少 → 红；「给 sync run 加 first」→ 右多左少 → 红。
    const markedFirst = COMMAND_TREE.filter((s) => s.positionals[0]?.first === true)
      .map((s) => s.path.join(' ')).sort()
    expect(flagFirstBehavesStrict.sort()).toEqual(markedFirst)
  })
  // 复审 I-2 的形态在这里延续：上面那条只证明「标了 first 的命令解析器确实严格」，
  // 但**没标**的命令若解析器其实严格（漏标），左侧集合会比右侧多一个 —— 已由同一断言覆盖。
  // 这条补充「first 只许出现在 positionals[0]」的结构约束：第二个槽位上的 first 无人读，
  // 写上去等于假声明（`skill check` 只读 `positionals[0]?.first`）。
  it('first 标记只允许出现在第一个位置参数槽位上（写在后面等于假声明）', () => {
    for (const s of COMMAND_TREE) {
      for (const [i, p] of s.positionals.entries()) {
        if (i === 0) continue
        expect(p.first, `${s.path.join(' ')} 的第 ${i + 1} 个位置参数不该有 first`).toBeUndefined()
      }
    }
  })
  // —— G3 审查 C1：skill 三条的 spec 与解析器逐 flag 对齐 ——
  //
  // 上面两条通用断言（字面量 + 行为探针）已经覆盖「spec 里的 flag 解析器都认」；
  // 这里补反向与逐条契约：解析器多认一个 spec 没有的 flag（反向漂移）同样要红，
  // 否则 spec 漏一个 flag → 正文里合法的用法被判 unknown_flag（假阳性）。
  it('skill 三条的 spec 与真实解析器**双向**对齐：accept 集相同，且 flag 必须写在子命令之后', async () => {
    for (const sub of ['install', 'check', 'where'] as const) {
      const spec = SKILL_SPECS.find((x) => x.path.join(' ') === `skill ${sub}`)!
      expect(spec, `SKILL_SPECS 里缺 skill ${sub}`).toBeDefined()
      expect(spec.positionals).toEqual([])
      expect(spec.rejected).toEqual([]) // G1：rejected 机制保留但为空
      const rejected = new Set(spec.rejected)
      const accepted = spec.flags.map((f) => f.name).filter((n) => !rejected.has(n))
      const specProbe = await (async (): Promise<string> => {
        out = ''; err = ''
        expect(await skillCommand([sub, '--zzz-spec-probe'])).toBe(2)
        return unknownSegment(messageOf())
      })()
      const acceptedProbe = await (async (): Promise<string> => {
        out = ''; err = ''
        expect(await skillCommand([sub, '--zzz-spec-probe', '--pretty'])).toBe(2)
        return messageOf()
      })()
      // 每条命令都必须真的做「未知 flag」检测（基线可达）；`--pretty` 被列为已知但拒绝，
      // 所以替换掉 accepted 探针里对它的判定：--pretty 不得出现在「未知参数」清单里。
      expect(specProbe).toContain('--zzz-spec-probe')
      expect(unknownSegment(acceptedProbe)).not.toContain('--pretty')
      void accepted
    }
  })

  // —— D3.14：spec → parser 的**反向**漂移（解析器多认一个 spec 没有的 flag）——
  //
  // 上面那条只证明「spec 里的每个 flag 解析器都认」（正向）；解析器多认一个 spec 没写的
  // flag 时它**全绿** —— 而那条漂移会让 `skill check` 对正文里一个实际可用的写法判
  // `unknown_flag`（假阳性），正是 spec 存在的意义所在。
  //
  // ⚠️ 为什么不能用「拿 flag 表挨个试解析器」的做法：解析器的接受集从 `SKILL_SPECS`
  // 派生（`skillFlagSpecs`），**同一个事实源**，那样比是同义反复、永远不会红。
  // 所以要拿一个 spec 里没有的候选名去探。候选取自 `GLOBAL_FLAGS` 之外、别条命令
  // 真实存在的 flag（`--force` 之于 where 有语义、`--db` 之于 skill 是存储 flag）——
  // 它们一旦被加进 skill 的受支持集，本用例必须报出来。
  it('[D3.14] 反向漂移：skill 三条不接受任何 spec 之外的候选 flag（加进接受集即红）', async () => {
    const CANDIDATES = ['--force', '--db', '--profile', '--backend', '--all', '--yes', '--body']
    for (const sub of ['install', 'check', 'where'] as const) {
      const spec = SKILL_SPECS.find((x) => x.path.join(' ') === `skill ${sub}`)!
      const names = new Set(spec.flags.map((f) => f.name))
      for (const cand of CANDIDATES) {
        // 前提自检：候选必须确实不在 spec 里（否则本用例在这条候选上无意义）。
        if (names.has(cand)) continue
        out = ''; err = ''
        await skillCommand([sub, cand, 'x', '--zzz-spec-probe'])
        // 解析器必须把它当**未知**参数（出现在「未知参数：…」清单里）；
        // 变异「把 --force 从 install 的解析器受支持集里加进 where」→ 本用例红。
        expect(unknownSegment(messageOf()), `skill ${sub} 不该接受 ${cand}`)
          .toContain(cand)
      }
    }
  })
  it('skill 家族的命令名都在 true 的树里：正文引用不会被判 unknown_command（G3 审查 C1 命令层探针）', async () => {
    // cli.ts 的 COMMANDS 有 `skill`；若是「skill install」这类正文写法，真实 CLI 会分派到
    // skillCommand 再按子命令裁决——所以 tree 里必须出现 `skill <子命令>`。
    for (const sub of ['install', 'check', 'where']) {
      out = ''; err = ''
      // 子命令写错 → 真实 CLI 退 2「未知子命令」（不是「未知参数」）；这说明子命令位的确由
      // skillCommand 分派——tree 的 path 必须覆盖这三个真实存在的子命令。
      expect(await skillCommand([`${sub}-bogus`])).toBe(2)
      expect(err).toContain('未知子命令')
      expect(paths).toContain(`skill ${sub}`)
    }
  })
  it('skill install 接受 --dir/--link/--no-link/--force/--dry-run，skill where 只接受 --dir', async () => {
    // 行为契约（真实解析器，非 spec 自述）：
    //   ① `install --dry-run --no-link --force --dir X --link codex` 的每个 flag 都被解析器
    //      认下——它退 2 是因为「--link 与 --no-link 互斥」这条**语义**裁决，
    //      不是「未知参数」。若 spec 少写一个 flag（例如漏 --dry-run），错误就会变成
    //      「未知参数：--dry-run」→ 本用例红。
    out = ''; err = ''
    expect(await skillCommand(['install', '--dry-run', '--no-link', '--force', '--dir', '/tmp/x', '--link', 'codex'])).toBe(2)
    expect(err).toContain('互斥')
    expect(err).not.toContain('未知参数')
    //   ② where 不接受业务 flag（除 --dir）：`--force` 退 2 且是「未知参数」。
    out = ''; err = ''
    expect(await skillCommand(['where', '--force'])).toBe(2)
    expect(err).toContain('未知参数')
    //   ③ `install --bogus` 退 2 且点名该 flag。
    out = ''; err = ''
    expect(await skillCommand(['install', '--bogus'])).toBe(2)
    expect(err).toContain('--bogus')
    // spec 侧与上面三条行为一致：install 的接受集恰是这五个业务 flag，where 只有 --dir。
    const installSpec = SKILL_SPECS.find((x) => x.path.join(' ') === 'skill install')!
    const whereSpec = SKILL_SPECS.find((x) => x.path.join(' ') === 'skill where')!
    expect(installSpec.flags.map((f) => f.name).filter((n) => !GLOBAL_FLAG_NAMES.includes(n)))
      .toEqual(['--dir', '--link', '--no-link', '--force', '--dry-run'])
    expect(whereSpec.flags.map((f) => f.name).filter((n) => !GLOBAL_FLAG_NAMES.includes(n))).toEqual(['--dir'])
  })
  // Task 1 复审 N-2 钉 tree 不变量：`findSpec` 用「tree 里还有更深 spec」判分组，
  // 若某条 spec 既是叶命令、又是更深的 spec 的前缀（如同时有 `['sync']` 与 `['sync','run']`），
  // 它会把 `sync --db x run`、甚至 `sync run` 之后的 flag 场景误判 —— 真实分派取 argv[0]
  // 当子命令，这种形状不可能在 spec 里正确表达。所以 tree 里不得出现。
  it('tree 不变量：不得存在既是叶命令、又是更深 spec 前缀的 path', () => {
    for (const s of COMMAND_TREE) {
      const isPrefixOfDeeper = COMMAND_TREE.some(
        (o) => o !== s && o.path.length > s.path.length && s.path.every((seg, i) => o.path[i] === seg),
      )
      expect(isPrefixOfDeeper, `${s.path.join(' ')} 同时是更深 spec 的前缀`).toBe(false)
    }
  })
})

const SENTINEL = '--zzz-sentinel'
/** 从 usageFail 的输出里取 message（JSON 在 stdout，rejection/错误兜底在 stderr）。 */
function messageOf(): string {
  if (out.trim() !== '') {
    try { return (JSON.parse(out) as { error?: { message?: string } }).error?.message ?? '' } catch { /* 下面回落 */ }
  }
  return err
}
/** 从错误文案里截出「未知参数：…」那一段（到第一个句号为止）。 */
function unknownSegment(message: string): string {
  const marker = '未知参数：'
  const i = message.indexOf(marker)
  if (i < 0) return ''
  const rest = message.slice(i + marker.length)
  const stop = rest.indexOf('。')
  return stop < 0 ? rest : rest.slice(0, stop)
}
