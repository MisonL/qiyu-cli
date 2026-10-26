import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync, readFileSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { authCommand } from '../../src/commands/auth.js'

let out = ''
// ⚠️ stderr 也统一捕获（2026-10-05 加）—— 与 api/cli 两个测试文件一致。
// 此前本文件只捕获 stdout，于是"用法错误是否双通道"这件事在这里无法断言：
// 各用例若要看 stderr 得自己临时 spy，容易漏（「未知子命令」那条就只断言了退出码）。
let err = ''
let home = ''
const cfgPath = (): string => join(home, '.config', 'qiyu', 'config.json')

/** 写配置文件并把权限收紧到 0600（含凭证的文件权限过宽会被拒绝，见 checkPermissions）。 */
function writeCfg(obj: unknown, mode = 0o600): string {
  const dir = join(home, '.config', 'qiyu')
  mkdirSync(dir, { recursive: true })
  const p = cfgPath()
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2))
  chmodSync(p, mode)
  return p
}

beforeEach(() => {
  out = ''; err = ''
  // ⚠️ **必须隔离 HOME**（G1 起 auth 会读写 `~/.config/qiyu/config.json`）：
  // 不隔离就会读开发机真实的配置文件，测试结果取决于本机环境。
  home = mkdtempSync(join(tmpdir(), 'qiyu-auth-'))
  vi.stubEnv('HOME', home)
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

describe('auth whoami', () => {
  it('环境变量齐备时报告 configured/source=env，且不泄露任何凭证内容', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'abcdef123456')
    vi.stubEnv('QIYU_APP_SECRET', 'topsecret')
    expect(await authCommand(['whoami'])).toBe(0)
    expect(out).not.toContain('topsecret')
    expect(out).not.toContain('abcdef123456')
    const d = JSON.parse(out).data
    expect(d.configured).toBe(true)
    expect(d.source).toBe('env')
    expect(d.robots).toEqual([])
    expect(JSON.parse(out).meta.field_notes.configured).toMatch(/不代表.*有效/)
  })

  it('凭证拼错但非空时，whoami 仍然报 configured —— 这是已知局限，不是 bug', async () => {
    // 把这条**已知的局限**写成测试，而不是留一句注释：
    // 它钉住"whoami 不做真实性校验"这个事实，任何人想让它变成校验
    // 都必须先改这条断言，也就必须先看见设计稿 §4.2 的说明。
    vi.stubEnv('QIYU_APP_KEY', '这不是一个有效的 appKey')
    vi.stubEnv('QIYU_APP_SECRET', '也不是')
    expect(await authCommand(['whoami'])).toBe(0)
    expect(JSON.parse(out).data.configured).toBe(true)
  })

  it('凭证只来自配置文件时 source=file；env 与文件各出一个时 source=mixed', async () => {
    // ⚠️ `mixed` 不是凑数的第三态：export 了 appKey、appSecret 留在配置里是
    // 完全合法的组合，只报 'env' 或 'file' 都是谎报 —— Agent 会据此判断
    // "我 export 的那个到底生效了没有"。
    writeCfg({ profiles: { default: { credentials: { appKey: 'fk', appSecret: 'fs' } } } })
    expect(await authCommand(['whoami'])).toBe(0)
    expect(JSON.parse(out).data.source).toBe('file')

    out = ''
    vi.stubEnv('QIYU_APP_KEY', 'ek')          // env 只给一半
    expect(await authCommand(['whoami'])).toBe(0)
    expect(JSON.parse(out).data.source).toBe('mixed')
  })

  it('robots 映射如实输出（未校验），无配置时是空数组', async () => {
    writeCfg({ profiles: { default: {
      credentials: { appKey: 'k', appSecret: 's' },
      robots: { '1000001': '机器人A', '1000002': '机器人B' },
    } } })
    expect(await authCommand(['whoami'])).toBe(0)
    const d = JSON.parse(out).data
    expect(d.robots).toEqual([{ id: 1000001, name: '机器人A' }, { id: 1000002, name: '机器人B' }])
    expect(JSON.parse(out).meta.field_notes.robots).toMatch(/未校验/)
  })

  it('凭证缺失时返回业务错误码，并给出可操作指引（不再是「未实现」的 login）', async () => {
    const code = await authCommand(['whoami'])
    expect(code).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('auth_missing')
    expect(e.message).toMatch(/QIYU_APP_KEY|未检测到完整凭证/)
    // ⚠️ hint 现在**可以**指向 `auth login` —— G1 起它真的存在（此前指向它是悬空引用）。
    expect(e.hint).toMatch(/auth login|QIYU_APP_KEY/)
  })

  it('配置文件坏了不等于「凭证没配」—— 如实分流，不把配置事故说成缺环境变量', async () => {
    writeCfg('{ 不是 JSON')
    const code = await authCommand(['whoami'])
    expect(code).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('auth_missing')
    // ⚠️ 必须把真正的原因说出来：只说"请设置环境变量"的话，用户照做后仍然失败
    // （坏文件还在），而它无从知道问题在哪。
    expect(e.message, '必须提及配置文件读取失败').toMatch(/配置文件/)
  })

  it('含凭证但权限过宽（0644）→ config_insecure 拒绝，hint 点名 chmod', async () => {
    writeCfg({ profiles: { default: { credentials: { appKey: 'k', appSecret: 's' } } } }, 0o644)
    const code = await authCommand(['whoami'])
    expect(code).toBe(1)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('config_insecure')
    expect(e.hint).toMatch(/chmod 600/)
  })

  it('未知子命令返回用法错误码，且点名 token、双通道都有说明', async () => {
    expect(await authCommand(['未知'])).toBe(2)
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
    // ⚠️ 必须断言 stderr 文本 —— 只断言退出码区分不出是哪条分支拦下的。
    vi.stubEnv('QIYU_APP_KEY', 'k')
    vi.stubEnv('QIYU_APP_SECRET', 's')
    for (const extra of ['extra', '--bod', '--yes']) {
      out = ''; err = ''
      expect(await authCommand(['whoami', extra]), `whoami ${extra} 应报用法错误`).toBe(2)
      // ⚠️ stdout 也必须是合法 JSON（2026-10-05 修）—— 此前这里断言 stdout 为空，
      // 与全局约束「stdout 一律是合法 JSON」矛盾。两个通道都断言。
      expect(JSON.parse(out).error).toMatchObject({ code: 'usage', kind: 'usage' })
      expect(err).toContain(`未知参数：${extra}`)
    }
    // ⚠️ `--pretty` 单独一条（G1 2026-10-24 起**已实现**）：whoami 是合法叶命令，
    // `whoami --pretty` 必须成功并输出缩进 JSON —— 旧断言（报「尚未实现」）已翻转。
    out = ''; err = ''
    expect(await authCommand(['whoami', '--pretty'])).toBe(0)
    expect(err).not.toContain('未知参数')
    expect(out.startsWith('{\n  "ok": true,'), 'whoami --pretty 必须缩进').toBe(true)
    // 下一条（不带 --pretty）回到紧凑 —— 守入口 setPretty(false) 重置
    out = ''
    expect(await authCommand(['whoami'])).toBe(0)
    expect(out.startsWith('{"ok":true,')).toBe(true)
  })

  it('auth --help 走 stdout、退出码 0，且列出已实现的 login', async () => {
    expect(await authCommand(['--help'])).toBe(0)
    expect(out).toContain('用法：qiyu auth')
    // ⚠️ G1 起 login **已实现** —— 旧的 `not.toContain('auth login')` 断言翻转。
    // 用法里必须列出它（列一个跑不通的命令才是承诺，列一个真命令是基本要求）。
    expect(out).toContain('auth login')
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

  it('auth whoami --help 也给帮助 —— 与其余 help 入口一致（2026-10-07 修）', async () => {
    // ⚠️ 此前 `auth whoami --help` 落到"多余参数"分支报「未知参数：--help」——
    // 而 `--help` 是合法 flag，那是一句**事实错误**的说明。
    // ⚠️ 必须断言 stdout 有用法文本 —— 只断言退出码 0 区分不出"给了帮助"
    // 与"别的原因恰好返回 0"。
    for (const flag of ['--help', '-h']) {
      out = ''; err = ''
      expect(await authCommand(['whoami', flag]), `whoami ${flag} 应给帮助`).toBe(0)
      expect(out, `whoami ${flag} 的帮助必须走 stdout`).toContain('用法：qiyu auth')
      expect(err, `whoami ${flag} 是帮助，不该写 stderr`).toBe('')
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
})

describe('auth login', () => {
  it('从环境变量写入配置：0600、目录 0700、不回显凭证', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'mykey123456')
    vi.stubEnv('QIYU_APP_SECRET', 'mysecret789')
    expect(await authCommand(['login'])).toBe(0)
    const d = JSON.parse(out).data
    expect(d.configured).toBe(true)
    expect(d.profile).toBe('default')
    expect(d.config_path).toBe(cfgPath())
    // ⚠️ 绝不回显凭证 —— 连末四位都不（与 whoami 同一条约束）。
    expect(out).not.toContain('mykey123456')
    expect(out).not.toContain('mysecret789')
    // 落盘内容与权限
    const written = JSON.parse(readFileSync(cfgPath(), 'utf8'))
    expect(written.profiles.default.credentials).toEqual({ appKey: 'mykey123456', appSecret: 'mysecret789' })
    expect(statSync(cfgPath()).mode & 0o777).toBe(0o600)
    expect(statSync(join(home, '.config', 'qiyu')).mode & 0o777).toBe(0o700)
  })

  it('--profile 指定 profile；默认取 defaultProfile；其它键被合并保留', async () => {
    writeCfg({
      defaultProfile: 'prod',
      profiles: { prod: { store: { batchSize: 250 }, robots: { '1': '甲' } } },
    })
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    expect(await authCommand(['login'])).toBe(0)
    expect(JSON.parse(out).data.profile).toBe('prod')
    const written = JSON.parse(readFileSync(cfgPath(), 'utf8'))
    // ⚠️ 覆盖式写入会把用户手工配的 store/robots 一起抹掉 —— 必须合并。
    expect(written.profiles.prod.store).toEqual({ batchSize: 250 })
    expect(written.profiles.prod.robots).toEqual({ '1': '甲' })
    expect(written.profiles.prod.credentials).toEqual({ appKey: 'k', appSecret: 's' })

    out = ''
    vi.stubEnv('QIYU_APP_KEY', 'k2')
    expect(await authCommand(['login', '--profile', 'staging'])).toBe(0)
    expect(JSON.parse(out).data.profile).toBe('staging')
  })

  it('缺任一环境变量 → usage 2，并点名要 export 什么', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k')   // 只给一个
    expect(await authCommand(['login'])).toBe(2)
    const e = JSON.parse(out).error
    expect(e.kind).toBe('usage')
    expect(e.message).toMatch(/QIYU_APP_SECRET/)
  })

  it('**不接受** --app-key / --app-secret（argv 会留在 ps 与 shell 历史里）', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    out = ''; err = ''
    expect(await authCommand(['login', '--app-key', 'leak'])).toBe(2)
    expect(err).toContain('未知参数：--app-key')
  })

  it('配置文件畸形时拒绝覆盖 —— 不静默丢掉用户手写的内容', async () => {
    writeCfg('{ 坏 JSON')
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    expect(await authCommand(['login'])).toBe(2)
    expect(JSON.parse(out).error.message).toMatch(/无法读取现有配置文件/)
    // ⚠️ 必须同时断言 stderr 无 Markdown 标记（2026-10-26 逐点变异实测发现）：
    // 本分支**被**这条用例走到了，但它只断言了 message —— 给该 usageFail 的文案
    // 注入 `**`，全量测试**仍全绿**（`api.test.ts` 的哨兵表覆盖不到这里：那条表
    // 的每一行都是一次裸调用，构造不出"配置文件畸形"的前置状态）。
    // 也就是说这个调用点的「stderr 是纯文本」规则此前无人守。
    expect(err).not.toMatch(/\*\*/)
    // 坏文件必须**原样没动**（没有被覆盖成一个"看起来成功"的新文件）
    expect(readFileSync(cfgPath(), 'utf8')).toBe('{ 坏 JSON')
  })

  it('配置文件是符号链接 → 拒绝写入（防止穿透到任意路径）', async () => {
    const target = join(home, 'elsewhere.json')
    writeFileSync(target, JSON.stringify({ profiles: {} }))
    mkdirSync(join(home, '.config', 'qiyu'), { recursive: true })
    symlinkSync(target, cfgPath())
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    const code = await authCommand(['login'])
    expect(code).toBe(1)
    expect(JSON.parse(out).error.kind).toBe('config_insecure')
    // 链接目标不得被写入
    expect(readFileSync(target, 'utf8')).toBe(JSON.stringify({ profiles: {} }))
  })

  it('值位守卫：--profile 缺值 / 重复给 / 多余位置参数 → usage 2', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    out = ''; err = ''
    expect(await authCommand(['login', '--profile'])).toBe(2)
    expect(err).toContain('--profile 后面缺少取值')
    out = ''; err = ''
    expect(await authCommand(['login', '--profile', 'a', '--profile', 'b'])).toBe(2)
    expect(err).toContain('--profile 只能出现一次')
    out = ''; err = ''
    expect(await authCommand(['login', 'extra'])).toBe(2)
    expect(err).toContain('未知参数：extra')
  })

  it('login --pretty → 缩进 JSON（G1）', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    expect(await authCommand(['login', '--pretty'])).toBe(0)
    expect(out.startsWith('{\n  "ok": true,')).toBe(true)
  })

  it('profile 选取次序与全局优先级一致：--profile > QIYU_PROFILE > defaultProfile > default', async () => {
    // ⚠️ `QIYU_PROFILE` 必须**先于** `defaultProfile`（spec §3.2 的优先级，
    // 与 store/config.ts 的取法一致）。此前实现把它排在 defaultProfile 之后 ——
    // 于是 export 了 QIYU_PROFILE 的用户发现凭证写进了另一个 profile，
    // 而之后的命令（按 QIYU_PROFILE 解析）读不到它，报"凭证没配"。
    writeCfg({ defaultProfile: 'prod', profiles: { prod: {}, staging: {} } })
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubEnv('QIYU_PROFILE', 'staging')
    expect(await authCommand(['login'])).toBe(0)
    expect(JSON.parse(out).data.profile).toBe('staging')

    out = ''
    expect(await authCommand(['login', '--profile', 'prod'])).toBe(0)
    expect(JSON.parse(out).data.profile, '--profile 优先于 QIYU_PROFILE').toBe('prod')
  })

  it('--pretty 之后的用法错误仍是紧凑 JSON（契约：用法错误永远紧凑）', async () => {
    // 同 api.test.ts 那条：`auth login --pretty` 缺环境变量时，`setPretty(true)` 已经执行过。
    out = ''; err = ''
    expect(await authCommand(['login', '--pretty'])).toBe(2)
    expect(out).not.toContain('\n  ')
    out = ''; err = ''
    expect(await authCommand(['whoami', 'extra', '--pretty'])).toBe(2)
    expect(out).not.toContain('\n  ')
  })

  it('环境变量为空串 → 视为缺失（不让空凭证落盘）', async () => {
    vi.stubEnv('QIYU_APP_KEY', ''); vi.stubEnv('QIYU_APP_SECRET', 's')
    expect(await authCommand(['login'])).toBe(2)
    expect(JSON.parse(out).error.message).toMatch(/QIYU_APP_KEY/)
    // 什么都没写出去
    expect(existsSync(cfgPath())).toBe(false)
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
    const { run } = await import('../../src/cli.js')
    expect(await run(['auth', '未知'])).toBe(2)
    expect(err).not.toContain('未知子命令：auth')
  })
})
