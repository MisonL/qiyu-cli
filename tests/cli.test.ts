import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run } from '../src/cli.js'
// 版本常量从 `core/edition.ts` 取（唯一定义点）：断言对**同一个常量**，
// 单一事实源 —— 源码里数值若被改动，断言跟着改的就是那一处，不会出现测试
// 与实现的字面量各抄一份、改一处忘另一处。⚠️ 它**不**保护构建期覆写
// （Task 13 只改 `dist/core/edition.js`，而测试导入的是 `src/core/edition.ts`）；
// 「构建产物非占位」由 Task 13 的产物级测试钉住。
import { PACKAGE_VERSION, SKILL_CONTRACT_VERSION } from '../src/core/edition.js'
import { resetSkillDetectionCache } from '../src/skill/detect.js'
import { setSkillWarning } from '../src/output.js'

let out = ''
let err = ''
beforeEach(() => {
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
})
afterEach(() => vi.restoreAllMocks())

describe('命令行入口', () => {
  it('无参数时返回用法错误码 2', async () => {
    expect(await run([])).toBe(2)
    // ⚠️ stderr 是给人读的 —— 无参数是用法错误，不是"用户请求帮助"
    expect(err).toContain('用法：')
    // ⚠️ **stdout 同时必须是合法 JSON**（2026-10-05 修，见 output.ts `usageFail`）。
    // 此前此处 stdout 为空：`qiyu | jq` 拿到空输入、jq 报 parse error，Agent 看不到原因。
    // 这条断言正是防止它退回"只写 stderr"的那个钉子。
    expect(JSON.parse(out).error).toMatchObject({
      code: 'usage', kind: 'usage', retryable: false,
    })
  })

  it('未知子命令返回用法错误码 2', async () => {
    expect(await run(['不存在的命令'])).toBe(2)
    expect(err).toContain('未知子命令：不存在的命令')
    // ⚠️ 这里**只**断言"走到了「可用子命令：」这条分支"，早期任务不断言列表里具体有哪些命令。
    // 原因是本文件在**任务 1 就被创建**，`COMMANDS` 从空表逐步挂载 —— 空表时正确输出是
    // 「可用子命令：（暂无）」，挂载后才列出具体命令 —— 正确输出本身随任务推进变化。
    // 现在（store 挂载后）列表已含 auth、api、store，其内容在下方
    // 「store 子命令注册 → 未知子命令消息含 store」用例中单独锚定。
    // 曾经这里写过 `toMatch(/可用子命令：[\s\S]*auth/)`，
    // 那在任务 1 必然失败（空表拿不到 auth），与步骤 5「预期 PASS」矛盾。
    //
    // 关于 `Object.keys(COMMANDS).join('、') || '（暂无）'` 的 `||`→`&&` 变异：
    // 它确实无法在本文件里用一条断言钉死（理由同上）。本计划**如实记录这个覆盖缺口**，
    // 不假装已覆盖 —— 该变异的可观测后果是"空表时输出空串、非空表时输出（暂无）"，
    // 属低危（错误信息少列几个命令，不改变退出码），且它保护的是"未来有人手滑改错"。
    expect(err, '必须走到「可用子命令：」这条分支').toContain('可用子命令：')
  })

  it('--help 走 stdout 且退出码为 0 —— 它是"请求帮助"，不是错误', async () => {
    // ⚠️ 全局约束承诺「CLI 的 --help 一律中文」。若不实现它，
    // `qiyu --help` 会落到「未知子命令」分支（实测输出"未知子命令：--help"、退出码 2）——
    // 对一个 Agent 而言那是坏交互：它请求帮助，却得到一个错误。
    expect(await run(['--help'])).toBe(0)
    expect(out).toContain('用法：')
    expect(out).toContain('api call')
    expect(err).toBe('')
  })

  it('-h 与 --help 等价', async () => {
    expect(await run(['-h'])).toBe(0)
    expect(out).toContain('用法：')
  })

  it('--help 不吞额外参数 —— 拼错的 flag / 多余的位置参数必须报出来（2026-10-08 修）', async () => {
    // ⚠️ 此前 `--help` 是"首个 token 特判且排在最前"：实测 `qiyu --help --bod` /
    // `qiyu --help extra` 都返回 0，把错误静默吞掉（而 `qiyu --bod` 单独跑是 2）——
    // "多带一个 --help"把一条用法错误变成了静默成功，与 `api list --al --help`
    // 是同一个坑（叶子命令 2026-10-05/08 修过两轮，分派层这一处漏了）。
    // 修法与叶子命令同一条次序：未知/位置参数 → help。
    expect(await run(['--help', '--bod'])).toBe(2)
    expect(err, 'stderr 要给人读').toContain('未知参数：--bod')
    expect(JSON.parse(out).error.message, 'stdout 要给 Agent 读')
      .toContain('--help 不接受额外参数')
    out = ''; err = ''
    expect(await run(['--help', 'extra'])).toBe(2)
    expect(err).toContain('未知参数：extra')
    // `--help --help` 仍给帮助 —— `--help`/`-h` 是这条伪命令仅有的合法 token，
    // 不算"额外参数"（与 `api list --help --help` 同答）。
    out = ''; err = ''
    expect(await run(['--help', '--help'])).toBe(0)
    expect(out).toContain('用法：')
    expect(err).toBe('')
  })

  it('纯空白的子命令也要点名，不能渲染成不可见的名字（2026-10-08 修）', async () => {
    // `qiyu " "`（shell 变量展开成一个空格）此前报「未知子命令： ；可用子命令：…」——
    // 冒号后是空格，Agent 看不出自己传了什么。规则同 output.ts 的 describeArgs。
    expect(await run([' '])).toBe(2)
    expect(err).toContain("未知子命令：' '")
  })

  it('帮助文本告知「按 kind 分支、code 只是标签」（2026-10-07 补）', async () => {
    // ⚠️ 契约里唯一没写清的一件事：`error.code` 混合了**服务端数字码**与
    // **本 CLI 合成的词**（usage / network / internal / auth_missing /
    // confirm_required / local_rate_limit）。字段名 `code` 强烈暗示"服务端错误码"，
    // 而设计稿 §4.3 的错误码表全是数字 —— Agent 按 code 去查表会查不到合成词，
    // 而设计稿 §11.2 D 的分支依据其实是 **kind**。
    // 此前这句话在 CLI 的任何输出里都不存在（只写在计划的「已知缺口」里，而
    // Agent 手里没有那份文档）。help 是 Agent 唯一能读到的契约说明，放在这里。
    // ⚠️ 断言必须命中"按 kind"与"合成"两个要点，而不是只断言出现了 kind 一词。
    await run(['--help'])
    expect(out, 'help 必须告诉 Agent 按 kind 分支').toMatch(/按 kind 分支/)
    expect(out, 'help 必须点破 code 可能是合成词').toMatch(/合成/)
    expect(out, '必须点破合成词查不到官方错误码表').toMatch(/查不到|不在官方/)
  })

  it('帮助文本里不出现未实现的子命令 —— 那会是一句指向不存在能力的指引', async () => {
    // `auth login` 在「已知缺口」里明确未实现（会显式报错）。
    // 把它写进 --help 等于向 Agent 承诺一个跑不通的命令。
    await run(['--help'])
    expect(out).not.toContain('auth login')
  })

  it('原型链上的键（toString/constructor/valueOf…）按未知子命令处理，不是处理器', async () => {
    // ⚠️ 这条分支此前**没有测试**，且实现原本是错的。变异/实测确认：
    // `const handler = COMMANDS[sub]` + `if (!handler)` 在 `COMMANDS` 是普通对象
    // 字面量时会命中 `Object.prototype` 上的方法（**truthy**），于是
    // `if (!handler)` 不成立，原型方法被当成子命令处理器调用。实测（Node 24）：
    //   toString / constructor → 返回非数字，随后 `process.exitCode = <非数字>`
    //     抛 ERR_INVALID_ARG_TYPE
    //   valueOf / hasOwnProperty / __proto__ → 直接抛 TypeError
    // 后果是 unhandled rejection（入口当时也没有 .catch）：Node 打一段堆栈、
    // 退出码 1 —— 既不是「未知子命令」的退出码 2，也不符合输出契约。
    //
    // 仓库已在 `core/ratelimit.ts` 用 `Object.hasOwn` 修过同一类问题
    // （并有测试钉 `limitFor('constructor')`）—— 分发表当时漏了。
    // 这里逐个断言**退出码 2** 与**「未知子命令」文本**，而不只是"不抛"。
    for (const key of ['toString', 'constructor', 'valueOf', 'hasOwnProperty',
                       'isPrototypeOf', '__proto__', '__defineGetter__']) {
      out = ''; err = ''
      expect(await run([key]), `原型键 ${key} 必须按未知子命令返回 2`).toBe(2)
      expect(err, `原型键 ${key} 必须报「未知子命令」`).toContain('未知子命令')
    }
  })

  it('除 --help 外，stdout 一律是合法 JSON —— 这是 Agent 能 `| jq` 的前提', async () => {
    // ⚠️ 全局约束是「stdout 只输出 JSON」，唯一例外是 --help。
    //
    // ⚠️ 这条测试此前**标题与断言互相矛盾**（2026-10-05 修）：标题说「stdout 一律是
    // 合法 JSON」，断言却是 `expect(out).toBe('')` —— 断言的是"stdout 为空"。两者不是
    // 一回事：空 stdout 恰恰是 **Agent 最坏**的情形（`| jq` 拿到空输入、报
    // `Unexpected end of JSON input`，而全局约束明写「其余任何情况下 stdout
    // 都必须是合法 JSON —— 包括所有错误输出」）。测试一直绿，是因为它只钉住了当时
    // 的实现（只写 stderr），漏掉了约束本身。现在两条都钉：stdout 是合法 JSON，
    // **且** stderr 有人类可读的说明。
    const cases: Array<[string[], string]> = [
      [[], '无参数'],
      [['不存在的命令'], '未知子命令'],
    ]
    for (const [argv, label] of cases) {
      out = ''; err = ''
      await run(argv)
      // 1) stdout 必须是合法 JSON（不是空、不是纯文本）—— 这才是"能 `| jq`"的含义
      const parsed = JSON.parse(out)
      expect(parsed.ok, `${label} 的 stdout 应是 ok:false 的错误信封`).toBe(false)
      expect(parsed.error.code, `${label} 的 code 应是 usage`).toBe('usage')
      // 2) stderr 同时有人类可读说明（两个通道各服务一类读者）
      expect(err, `${label} 应走 stderr`).not.toBe('')
    }
    // --help 是唯一的例外，且必须是纯文本（不是 JSON）
    out = ''
    await run(['--help'])
    expect(() => JSON.parse(out)).toThrow()
  })
})

describe('分层约束（架构不变量）', () => {
  it('core/ 不得 import commands/ —— 否则 core 无法脱离 CLI 复用为 MCP Server', async () => {
    // ⚠️ 这条约束写在「全局约束」里，但没有任何东西守着它 ——
    // 加一行 `import { fail } from '../output.js'` 就能悄悄违反，
    // 而后果（core 层绑死 CLI）要等到复用时才暴露。
    // 用一个静态扫描把它钉住，成本几乎为零。
    const { readdirSync, readFileSync, statSync, existsSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core')

    // ⚠️ 必须守卫：`src/core/` 要到任务 2 才创建，而本用例在任务 1 就要跑通。
    // 没有这行，任务 1 步骤 5 会抛 ENOENT（readdirSync 一个不存在的目录），
    // 与「预期：PASS」直接矛盾 —— 照做的执行者会卡在"计划说该过、实际不过"。
    if (!existsSync(root)) return

    const walk = (dir: string): string[] =>
      readdirSync(dir).flatMap((n) => {
        const p = join(dir, n)
        if (statSync(p).isDirectory()) return walk(p)
        return p.endsWith('.ts') ? [p] : []
      })

    const offenders: string[] = []
    for (const file of walk(root)) {
      const src = readFileSync(file, 'utf8')
      // 匹配任何指向 commands/ 或 output.js 的 import（相对路径写法）
      for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
        const spec = m[1]
        if (/commands\//.test(spec) || /(^|\/)output\.js$/.test(spec)) {
          offenders.push(`${file} → ${spec}`)
        }
      }
    }
    expect(offenders, `core/ 里出现了指向 CLI 层的 import：\n${offenders.join('\n')}`).toEqual([])
  })
})

describe('入口退出行为（架构不变量）', () => {
  it('入口不得用 process.exit() —— 它会在 stdout 排空前强杀进程，静默截断大输出', async () => {
    // ⚠️ 实测（Node 24）：`process.exit(0)` 紧跟一个大 stdout 写入、且输出走**管道**时，
    // 只写出 131072 字节（正好是 128 KiB 管道缓冲区），其余被丢弃 —— 退出码仍是 0，
    // 没有任何报错。而 `qiyu api call <大结果集> | jq` 正是 Agent 的标准用法，
    // 也是**唯一**值得管道的场景（`ticket.search` 实测 2885 行、报表 17765 行）。
    // Agent 拿到的 JSON 会在中间断掉，jq 报一个与真实原因（输出太大）无关的解析错误。
    // 设 `process.exitCode` 让事件循环自然结束，Node 会先把 stdout 排空再退出。
    //
    // 为什么只能扫源码、不能行为断言：vitest 里 `process.stdout.write` 被 mock 成
    // 往字符串累加（见各测试文件），**完全绕过了 OS 管道** —— 那种 mock 下
    // `process.exit()` 不会截断任何东西，行为测试永远抓不到这个缺陷。
    // 与 http.test.ts 里「不读 Content-Length」那条同理：不改变可观测行为的代码
    // 只能静态钉住。
    const { readFileSync } = await import('node:fs')
    const { join, dirname } = await import('node:path')
    const { fileURLToPath } = await import('node:url')
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts'), 'utf8')
    // ⚠️ 扫**代码**不扫注释（2026-10-07 改）：cli.ts 的注释里本来就写着
    // 「不要用 `process.exit`」之类的说明（本计划自己在 3 处代码块注释里写了
    // `process.exit()` 这个字样）—— 裸扫时，谁把说明补全成带括号的
    // `process.exit()`，这条就**假红**。与 http.test.ts 的 Content-Length 那条
    // 同一种假红形态，同一种修法：匹配点之前有同行 `//` 即视为注释。
    // 两个断言都走 inCode：负向的防假红，正向的防「注释里写了 `exitCode =`
    // 就以为真的设置了退出码」——那是另一种空转。
    // ⚠️ 局限（如实标注）：判据是"匹配点之前有没有同行 `//`"，只有 `https://`
    // 这种前一字符是 `:` 的 `//` 被排除。若某行**真代码里含 `//` 字符串**
    // （如 `const u = 'a//b'`）且匹配点在其后，会被误判成注释。当前两个被扫的词
    // （`process.exit(` / `exitCode =`）在 cli.ts 里都不挨着这种字符串，不触发；
    // 要更严可上真正的词法扫描，但为两条断言引依赖不值 —— 记在这里，别当它万无一失。
    const inCode = (text: string, re: RegExp): boolean => {
      for (const line of text.split('\n')) {
        const m = line.match(re)
        if (!m || m.index === undefined) continue
        const c = line.indexOf('//')
        if (c < 0 || c > m.index || line[c - 1] === ':') return true
      }
      return false
    }
    expect(inCode(src, /process\.exit\(/),
      '入口的代码必须用 process.exitCode 而不是 process.exit()（注释提及不受限）')
      .toBe(false)
    expect(inCode(src, /process\.exitCode\s*=/),
      '入口必须真的设置退出码（注释里写不算），否则失败也会返回 0').toBe(true)
    // ⚠️ shebang 必须是**字面第一行**（2026-10-06 补）。本计划的代码块约定是
    // "首行写 `// <路径>` 归属注释"，而 `cli.ts` 的第一行是 `#!/usr/bin/env node` ——
    // 照抄含归属行的块会把 shebang 挤到第二行，Node/tsc 直接拒绝整个文件
    // （实测 `TS18026: '#!' can only be used at the start of a file`，紧跟一条 `TS1005`）。
    // 影响面是 3 个测试文件（本文件 + 两个在用例内 `await import()` 它的）——
    // 不是"整个套件全挂"，但足以让入口永远不可用且**报错指向语法**、
    // 不指向"你多抄了一行注释"。
    // 这条断言把"落盘时删掉归属行"从一句嘱咐变成机器可查的事实 ——
    // 它同时也是"包能不能被 npx 执行"的前提：shebang 不在首行，`dist/cli.js`
    // 就不是可执行脚本。
    expect(src.split('\n')[0], 'shebang 必须是第一行（归属注释不能挤在它前面）')
      .toBe('#!/usr/bin/env node')
  })
})

describe('查询族子命令注册（db / query / stats）', () => {
  it('顶层 USAGE 列出 db / query / stats 五个子命令', async () => {
    // ⚠️ 这五条是 spec §三「命令面」的逐条承诺。少列一条 = Agent 读 --help
    // 看不到那条能力；多列一条 = 指向不存在的能力（同 `auth login` 那条禁令）。
    // 断言到「子命令 + 方式」粒度，而不是只断言出现了 db / query / stats 三个词 ——
    // 后者在只挂一个空壳子命令时也会绿。
    expect(await run(['--help'])).toBe(0)
    for (const line of ['db tables', 'db describe', 'query --sql', 'query --table', 'stats fields']) {
      expect(out, `顶层 USAGE 必须列出 ${line}`).toContain(line)
    }
    expect(err).toBe('')
  })

  it('qiyu db / query / stats --help → 退出码 0 且输出各自用法', async () => {
    // ⚠️ 只断言「顶层列了」不够：COMMANDS 没挂上时，`qiyu db --help` 会落到
    // 「未知子命令」分支（退出码 2）—— 帮助请求变成错误，对 Agent 是坏交互。
    const cases: Array<[string, RegExp, string]> = [
      ['db', /db tables/, 'db 用法'],
      ['query', /query --sql/, 'query 用法'],
      ['stats', /stats fields/, 'stats 用法'],
    ]
    for (const [sub, re, label] of cases) {
      out = ''; err = ''
      expect(await run([sub, '--help']), `${label} 必须是退出码 0`).toBe(0)
      expect(out, `${label} 必须走 stdout`).toMatch(re)
      expect(err, `${label} 不是错误，不该写 stderr`).toBe('')
    }
  })

  it('未知子命令仍报「未知子命令」并列出新增命令', async () => {
    expect(await run(['nope'])).toBe(2)
    expect(err).toContain('未知子命令：nope')
    // 「可用子命令：」这一行必须真的能引导 Agent —— 它列的就是 COMMANDS 的键，
    // 所以新注册的三个命令必须出现在同一行里。
    const line = err.split('\n').find((l) => l.includes('可用子命令：')) ?? ''
    for (const name of ['db', 'query', 'stats']) {
      expect(line, `「可用子命令：」行必须含 ${name}`).toContain(name)
    }
  })

  it('qiyu --help --bogus → 退出码 2（既有行为不得回归）', async () => {
    // ⚠️ 2026-10-08 修过的行为：`--help` 不吞额外参数。本任务动了 USAGE 与
    // COMMANDS，不能顺手把这条分派层规则碰坏。
    expect(await run(['--help', '--bogus'])).toBe(2)
    expect(err).toContain('未知参数：--bogus')
    expect(JSON.parse(out).error.message).toContain('--help 不接受额外参数')
  })
})

describe('store 子命令注册', () => {
  it('store 进 COMMANDS 且 dispatch 可达（store --help → 0）', async () => {
    const { run } = await import('../src/cli.js')
    let o = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { o += s; return true })
    expect(await run(['store', '--help'])).toBe(0)
    expect(o).toMatch(/store init/)
  })
  it('顶层 --help 含两条 store 用法', async () => {
    const { run } = await import('../src/cli.js')
    let o = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { o += s; return true })
    await run(['--help'])
    expect(o).toMatch(/store init/)
    expect(o).toMatch(/store status/)
  })
  it('未知子命令消息含 store', async () => {
    const { run } = await import('../src/cli.js')
    let e = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { e += s; return true })
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    await run(['nope'])
    expect(e).toMatch(/store/)
  })
  it('顶层 USAGE 的 store 行含 --backend 占位（spec §8.3 第 1 处逐字）', async () => {
    const { run } = await import('../src/cli.js')
    let o = ''
    vi.spyOn(process.stdout, 'write').mockImplementation((s) => { o += s; return true })
    await run(['--help'])
    expect(o).toMatch(/\[--backend <name>\]/)
  })
})

describe('qiyu --version（Task 12，spec D6）', () => {
  // 为什么 Agent 需要它：已安装的 skill 正文与 CLI 可能**不配套**（skill 是
  // 单独安装的副本）。`skill_contract_version` 是正文契约的版本号，Agent 拿它
  // 与 skill 里声明的期望值比对，才能判断手上的正文能不能配这份 CLI。
  // 输出走 `ok()` 而非裸文本：全局约束只给 `--help` 开了裸文本的口子。
  it('--version → 0，stdout 是 { ok:true, data:{ version, skill_contract_version } }', async () => {
    expect(await run(['--version'])).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.ok).toBe(true)
    // 键名逐字钉住（Agent 契约的一部分）：改名等于把能力对 Agent 关掉。
    // ⚠️ 契约号用**常量**而不是字面量（2026-10-26 改）：此前写死 `1`，于是每次按 D6
    // 正当递增都要顺手改三处测试 —— 而「忘了改」的失败信息是「契约号不对」，会把
    // 一个刻意的版本升级显示成回归。本条真正要钉的是**键名**（改名等于对 Agent 关掉
    // 能力），值的正确性由 `edition.ts` 的常量与 CHANGELOG 负责。
    expect(parsed.data).toEqual({
      version: PACKAGE_VERSION,
      skill_contract_version: SKILL_CONTRACT_VERSION,
    })
    expect(typeof parsed.data.version).toBe('string')
    expect(Number.isInteger(parsed.data.skill_contract_version)).toBe(true)
    // 版本查询是成功输出，不该在 stderr 留任何东西。
    expect(err).toBe('')
  })

  it('--version 不吞额外参数 —— 未知 flag 必须点名（纪律与 --help 一致）', async () => {
    expect(await run(['--version', '--bod'])).toBe(2)
    // stderr 给人读、stdout 给 Agent 读，两个通道都要点名 `--bod`。
    expect(err).toContain('未知参数：--bod')
    expect(err).toContain('--version 不接受额外参数')
    expect(JSON.parse(out).error.message).toContain('--bod')
  })

  it('--version --help 仍给版本 JSON（不开第二个裸文本输出口）', async () => {
    // 裁定：`--help`/`-h`/`--pretty` 是 --version 的合法附带 token，但带了
    // `--help` 也输出**版本 JSON**，而不是 USAGE 裸文本 —— 全局约束只允许
    // 裸文本 `--help` 这一处例外，`qiyu --version --help` 不是那处例外。
    expect(await run(['--version', '--help'])).toBe(0)
    const parsed = JSON.parse(out) // 不抛即「合法 JSON」
    expect(parsed.ok).toBe(true)
    expect(parsed.data.skill_contract_version).toBe(SKILL_CONTRACT_VERSION)
  })

  it('-v 不是 --version 的短别名（保持「未知子命令」退出码 2）', async () => {
    // brief 明确不引入短别名（避免与未来的 -v 冲突）。这条钉住"将来别顺手加"。
    expect(await run(['-v'])).toBe(2)
    expect(err).toContain('未知子命令')
  })

  it('--version --pretty 仍返回 0（豁免清单与 --help 逐字一致）', async () => {
    // 裁定 1：`--pretty` 是**合法 flag**（承诺过、未实现），不是"额外参数" ——
    // 与 `--help --pretty` 同答。没有这条断言时，从豁免清单里删掉 `'--pretty'`
    // 会让 `qiyu --version --pretty` 从 0 变成 2，而整个测试文件仍全绿（审查 M3）。
    expect(await run(['--version', '--pretty'])).toBe(0)
    expect(JSON.parse(out).ok).toBe(true)
    expect(err).toBe('')
  })

  it('顶层 USAGE 必须列出 --version —— 帮助里看不到的能力等于不存在', async () => {
    expect(await run(['--help'])).toBe(0)
    expect(out).toContain('--version')
  })
})

describe('qiyu --version 的 skill 安装态提示通道（Task 12 审查 I1）', () => {
  // ⚠️ 为什么必须单独测：`--version` 走 `ok()` 的目的之一，是让 skill 安装态提示
  // （Task 10，spec D2.1）能经 `meta.warnings` 合并进版本输出。但本文件其余用例
  // 全跑在 `NODE_ENV=test` 且未设 `QIYU_SKILL_DIR` 下，探测被门挡掉、`meta` 永远
  // 不出现 —— 于是「把 `return ok(...)` 改成直写 stdout」这种回退在全量 1365 个
  // 用例下都绿，提示会从 `--version` 静默消失（审查 I1 实测的变异 8）。
  // 这里显式设 `QIYU_SKILL_DIR` 打开探测（只碰临时目录，绝不读写真实 `~`）。
  let home = ''
  let entity = ''

  beforeEach(() => {
    // macOS 上 `/var` 指向 `/private/var`：realpath 归一化后路径字符串才稳定可比。
    home = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-version-')))
    entity = join(home, 'entity')
    vi.stubEnv('QIYU_SKILL_DIR', '')
    setSkillWarning(undefined)
    // 探测按参数元组缓存；上一个用例的结论不能漏到这一个。
    resetSkillDetectionCache()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    setSkillWarning(undefined)
    resetSkillDetectionCache()
    rmSync(home, { recursive: true, force: true })
  })

  it('实体目录不存在 → 0，data 不变，meta.warnings 提示未安装', async () => {
    vi.stubEnv('QIYU_SKILL_DIR', join(entity, 'missing'))
    expect(await run(['--version'])).toBe(0)
    const parsed = JSON.parse(out)
    // 提示只加在 meta 上：data 的形状与内容一个字都不能变（Task 10 的「只提示、
    // 绝不改退出码、绝不改 data」不变量）。
    expect(parsed.data).toEqual({ version: PACKAGE_VERSION, skill_contract_version: SKILL_CONTRACT_VERSION })
    expect(parsed.meta.warnings[0]).toContain('未安装')
    expect(err).toBe('')
  })

  // —— G3 追加审查 [21] / [57]：测试门的两侧与「不静默」 ——
  it('[21] 宿主 npm_config_qiyu_skill_dir + NODE_ENV=test + 未设 QIYU_SKILL_DIR → 不读宿主路径', async () => {
    // 变异「npm_config 分支排在测试门之前」→ 本用例红（meta.warnings 出现「未安装到宿主路径」）。
    // 现实中 CI 机器的 `.npmrc` 里配了 `qiyu-skill-dir` 就会经 npm_config_* 注入所有子进程。
    vi.stubEnv('NODE_ENV', 'test')
    vi.stubEnv('QIYU_SKILL_DIR', '')
    vi.stubEnv('npm_config_qiyu_skill_dir', join(home, 'host-npm-entity'))
    expect(await run(['--version'])).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.ok).toBe(true)
    expect('meta' in parsed, '宿主 npm_config 不得泄进测试进程').toBe(false)
    expect(out).not.toContain('host-npm-entity')
  })

  it('[21] VITEST=true（NODE_ENV 被改成 production）同样挡掉宿主 npm_config', async () => {
    // 变异「looksLikeNodeTest 去掉 VITEST」→ 本用例红。vitest 恒设 VITEST=true。
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('VITEST', 'true')
    vi.stubEnv('QIYU_SKILL_DIR', '')
    vi.stubEnv('npm_config_qiyu_skill_dir', join(home, 'host-npm-entity'))
    expect(await run(['--version'])).toBe(0)
    expect('meta' in JSON.parse(out)).toBe(false)
  })

  it('[57] QIYU_DISABLE_SKILL_PROBE 显式关闭 → 不静默，meta.warnings 说明原因', async () => {
    // 变异「关闭时不写任何提示」→ 本用例红。用户主动关了探测，得看得见「为什么没提示」。
    vi.stubEnv('NODE_ENV', 'production')
    vi.stubEnv('QIYU_DISABLE_SKILL_PROBE', '1')
    vi.stubEnv('QIYU_SKILL_DIR', '')
    expect(await run(['--version'])).toBe(0)
    const parsed = JSON.parse(out)
    expect(parsed.data).toEqual({ version: PACKAGE_VERSION, skill_contract_version: SKILL_CONTRACT_VERSION })
    expect(parsed.meta.warnings.join('\n')).toContain('QIYU_DISABLE_SKILL_PROBE')
  })

  it('已安装且与包内一致（current）→ 0，无 meta 键', async () => {
    vi.stubEnv('QIYU_SKILL_DIR', entity)
    // 用真实安装命令铺出 current 态（清单的版本与内容哈希都与包内一致）。
    expect(await run(['skill', 'install', '--dir', entity, '--no-link'])).toBe(0)
    out = ''; err = ''
    // 安装前那次探测已按同一组参数缓存了 absent —— 不清缓存这里会读到旧结论。
    resetSkillDetectionCache()
    expect(await run(['--version'])).toBe(0)
    // current 不提示：没有 meta 键（而不是 meta:{warnings:[]}）。
    expect('meta' in JSON.parse(out)).toBe(false)
    expect(err).toBe('')
  })
})
