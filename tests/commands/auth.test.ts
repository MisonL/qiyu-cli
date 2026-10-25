import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { authCommand } from '../../src/commands/auth.js'

let out = ''
// ⚠️ stderr 也统一捕获（2026-10-05 加）—— 与 api/cli 两个测试文件一致。
// 此前本文件只捕获 stdout，于是"用法错误是否双通道"这件事在这里无法断言：
// 各用例若要看 stderr 得自己临时 spy，容易漏（「未知子命令」那条就只断言了退出码）。
let err = ''
beforeEach(() => {
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

describe('auth whoami', () => {
  it('凭证齐备时报告已配置，且不泄露任何凭证内容', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'abcdef123456')
    vi.stubEnv('QIYU_APP_SECRET', 'topsecret')
    const code = await authCommand(['whoami'])
    expect(code).toBe(0)
    expect(out).not.toContain('topsecret')
    expect(out).not.toContain('abcdef123456')
    expect(JSON.parse(out).data).toEqual({ configured: true })
    // ⚠️ 用 toEqual 而不是 toMatchObject：本计划没有配置文件支持，
    // 多出任何字段（尤其 source）都是在向 Agent 暗示一种不存在的能力。
    // toMatchObject 会让这类字段悄悄溜过。
    //
    // ⚠️ 字段名必须是 `configured`，不能改成 `valid`/`authenticated` ——
    // 这个函数只检查环境变量**存在**，一个拼错的 appKey 同样得到 true。
    // 换名字等于向 Agent 承诺一次它没做过的校验。
  })

  it('凭证拼错但非空时，whoami 仍然报 configured —— 这是已知缺口，不是 bug', async () => {
    // 把这条**已知的局限**写成测试，而不是留一句注释：
    // 它钉住"whoami 不做真实性校验"这个事实，任何人想让它变成校验
    // 都必须先改这条断言，也就必须先看见设计稿 §4.2 与「已知缺口」的这段说明。
    vi.stubEnv('QIYU_APP_KEY', '这不是一个有效的 appKey')
    vi.stubEnv('QIYU_APP_SECRET', '也不是')
    const code = await authCommand(['whoami'])
    expect(code).toBe(0)
    expect(JSON.parse(out).data).toEqual({ configured: true })
  })

  it('凭证缺失时返回业务错误码，并给出可操作的指引', async () => {
    vi.stubEnv('QIYU_APP_KEY', '')
    vi.stubEnv('QIYU_APP_SECRET', '')
    const code = await authCommand(['whoami'])
    expect(code).toBe(1)
    // ⚠️ 只匹配 QIYU_APP_KEY，不匹配 `auth login` —— 那个命令在本计划里
    // 明确未实现（会显式报错）。让 hint 指向一个跑不通的命令，
    // 正是「面向 Agent 的契约诚实性」要消灭的那类指引。
    expect(JSON.parse(out).error.message).toMatch(/QIYU_APP_KEY/)
  })

  it('未知子命令返回用法错误码，且点名 token、双通道都有说明', async () => {
    // ⚠️ 只断言退出码不够（2026-10-05 改）：把它换成任何返回 2 的写法
    // （含"只写 stderr"的老写法）测试照样绿 —— 而同文件的 `whoami` 多余参数、
    // `login` 两条都同时断言了 stderr 与 stdout JSON，唯独这条没有。
    const code = await authCommand(['未知'])
    expect(code).toBe(2)
    expect(err, 'stderr 要给人读').toContain('未知子命令')
    const e = JSON.parse(out).error
    expect(e, 'stdout 要给 Agent 读').toMatchObject({ code: 'usage', kind: 'usage' })
    expect(e.message, '必须点名那个 token').toContain('未知子命令')
    // 无参数是另一件事 —— 不能报成"未知子命令：undefined"（事实错误）
    out = ''; err = ''
    expect(await authCommand([])).toBe(2)
    expect(JSON.parse(out).error.message).not.toContain('undefined')
    expect(err).toContain('用法')
    // ⚠️ 纯空白同样必须点名（2026-10-08 修）：`auth " "` 此前报「未知子命令： 」
    // —— 名字不可见（describeArgs 的空白渲染，见 output.ts）。
    out = ''; err = ''
    expect(await authCommand([' '])).toBe(2)
    expect(err, '空白子命令必须渲染成可见形式').toContain("未知子命令：' '")
  })

  it('whoami 后面跟任何参数都报用法错误，而不是静默忽略', async () => {
    // ⚠️ 实测：此前 `whoami extra` / `--bod` / `--pretty` / `--yes`
    // **全部返回退出码 0 与 `{"ok":true,"data":{"configured":true}}`**。
    // 与 `api list`/`api call` 是同族问题（那两个已修），这是第三个漏网的子命令 ——
    // 参数校验只在两个命令上做，第三个就没人管。
    //
    // 后果最重的是 `--pretty`：被无声吞掉后 Agent 会去解析一个它没拿到的格式，
    // 与 `api list --pretty` 是同一个坑（那条已经显式拒绝）。
    // ⚠️ 必须断言 stderr 文本 —— 只断言退出码区分不出是哪条分支拦下的。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const err: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true })
    for (const extra of ['extra', '--bod', '--yes']) {
      out = ''; err.length = 0
      expect(await authCommand(['whoami', extra]), `whoami ${extra} 应报用法错误`).toBe(2)
      // ⚠️ stdout 也必须是合法 JSON（2026-10-05 修）—— 此前这里断言 stdout 为空，
      // 与全局约束「stdout 一律是合法 JSON」矛盾。两个通道都断言。
      expect(JSON.parse(out).error).toMatchObject({ code: 'usage', kind: 'usage' })
      expect(err.join('')).toContain(`未知参数：${extra}`)
    }
    // ⚠️ `--pretty` 单独一条（G1 2026-10-24 起**已实现**）：whoami 是合法叶命令，
    // `whoami --pretty` 必须成功并输出缩进 JSON —— 旧断言（报「尚未实现」）已翻转。
    out = ''; err.length = 0
    expect(await authCommand(['whoami', '--pretty'])).toBe(0)
    expect(err.join('')).not.toContain('未知参数')
    expect(out.startsWith('{\n  "ok": true,'), 'whoami --pretty 必须缩进').toBe(true)
    // 下一条（不带 --pretty）回到紧凑 —— 守入口 setPretty(false) 重置
    out = ''
    expect(await authCommand(['whoami'])).toBe(0)
    expect(out.startsWith('{"ok":true,')).toBe(true)
    // 反向：不带多余参数时仍然正常
    out = ''; err.length = 0
    expect(await authCommand(['whoami'])).toBe(0)
    expect(JSON.parse(out).data).toEqual({ configured: true })
  })

  it('auth --help 走 stdout 且退出码 0，且不列未实现的 login', async () => {
    expect(await authCommand(['--help'])).toBe(0)
    expect(out).toContain('用法：qiyu auth')
    expect(out).not.toContain('auth login')
    // ⚠️ `--help` 不吞额外参数（2026-10-08 修）：此前 `auth --help --bod` /
    // `auth --help extra` 返回 0，把拼错的 flag / 多余的位置参数静默吞掉
    // （`auth --bod` 单独跑是 2）。与叶子命令同一条次序：未知/位置参数 → help。
    out = ''; err = ''
    expect(await authCommand(['--help', '--bod'])).toBe(2)
    expect(err).toContain('未知参数：--bod')
    expect(JSON.parse(out).error.message).toContain('--help 不接受额外参数')
    out = ''; err = ''
    expect(await authCommand(['--help', 'extra'])).toBe(2)
    expect(err).toContain('未知参数：extra')
    // `--help --help` 仍给帮助（--help/-h 是这条伪命令仅有的合法 token）
    out = ''; err = ''
    expect(await authCommand(['--help', '--help'])).toBe(0)
    expect(out).toContain('用法：qiyu auth')
    expect(err).toBe('')
  })

  it('auth whoami --help 也给帮助 —— 与其余五个 help 入口一致（2026-10-07 修）', async () => {
    // ⚠️ 此前 `auth whoami --help` 落到"多余参数"分支报「未知参数：--help」——
    // 而 `--help` 是合法 flag，那是一句**事实错误**的说明。更重的是不一致：
    // 顶层 `qiyu --help`、`api --help`、`auth --help`、`api list --help`、
    // `api call --help` 全给帮助，唯独这里报错（六个 help 入口里唯一报错的一个）。
    // 计划自己的规则「help 本该永远成功」+「三个子命令必须一致」都要求给帮助。
    // ⚠️ 必须断言 stdout 有用法文本 —— 只断言退出码 0 区分不出"给了帮助"
    // 与"别的原因恰好返回 0"。
    for (const flag of ['--help', '-h']) {
      out = ''; err = ''
      expect(await authCommand(['whoami', flag]), `whoami ${flag} 应给帮助`).toBe(0)
      expect(out, `whoami ${flag} 的帮助必须走 stdout`).toContain('用法：qiyu auth')
      expect(err, `whoami ${flag} 是帮助，不该写 stderr`).toBe('')
      // ⚠️ `AUTH_USAGE` 与顶层 `USAGE`、`API_USAGE` 一样必须告知"按 kind 分支"
      // （2026-10-08 补，见 api.test.ts 同款断言）。
      expect(out, 'AUTH_USAGE 必须告知按 kind 分支').toMatch(/按 kind 分支/)
    }
    // ⚠️ 次序必须与 list() 相同：未知参数**先于** help 报错 —— 否则
    // `whoami --bod --help` 会因为带了 --help 而返回 0，把 `--bod` 无声吞掉。
    out = ''; err = ''
    expect(await authCommand(['whoami', '--bod', '--help'])).toBe(2)
    expect(err).toContain('未知参数：--bod')
    // help 先于 --pretty（list() 的 ② 条）
    out = ''; err = ''
    expect(await authCommand(['whoami', '--pretty', '--help'])).toBe(0)
    expect(out).toContain('用法：qiyu auth')
  })

  it('auth login 显式报"未实现"，而不是静默返回一个看起来成功的响应', async () => {
    // ⚠️ 实测：把 login 与 whoami 合并时，`authCommand(['login'])` 返回退出码 0
    // 与 `{"ok":true,"data":{"configured":true}}` —— Agent 会据此认为登录成功。
    // 这条断言钉住"必须失败且必须说清楚"。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    const err: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true })
    const code = await authCommand(['login'])
    expect(code).toBe(2)
    // ⚠️ stdout 也必须有合法 JSON（stderr 供人读，stdout 供 Agent 读）。
    expect(JSON.parse(out).error).toMatchObject({ code: 'usage', kind: 'usage' })
    expect(err.join('')).toMatch(/尚未实现/)
  })
})

describe('auth 已挂载到入口', () => {
  it('run(["auth", ...]) 会走到 authCommand，而不是报"未知子命令"', async () => {
    // ⚠️ 这条守的是"挂载"本身。光有 authCommand 实现而忘了登记进 COMMANDS 表，
    // 各子命令的单测全绿，而 CLI 会静默返回"未知子命令：auth"。
    //
    // 判别式**不能是退出码**：`authCommand(['未知'])` 和"子命令未登记"都返回 2，
    // 断言 toBe(2) 时删掉登记测试照样绿（实测踩到过）。必须看 stderr 文本 ——
    // 只要没出现"未知子命令：auth"，就证明请求确实进了 authCommand 而不是被入口挡下。
    const err: string[] = []
    vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err.push(String(s)); return true })
    const { run } = await import('../../src/cli.js')
    expect(await run(['auth', '未知'])).toBe(2)
    expect(err.join('')).not.toContain('未知子命令：auth')
  })
})
