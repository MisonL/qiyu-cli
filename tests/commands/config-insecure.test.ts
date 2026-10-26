// tests/commands/config-insecure.test.ts
//
// 「同一个危险状态，六条命令一种行为」（2026-10-26 修）。
//
// ⚠️ 修的是什么：配置含凭证且权限过宽（0644）时，`loadConfigChecked`（auth/api 走）
// 抛带 `kind: config_insecure` 的错误，而 `store/config.ts`（store/db/query/stats/sync 走）
// 抛的是**无 kind 的普通 Error**，各命令 catch 又一律 `usageFail(...)` —— 于是同一份
// 配置：`auth whoami` 是退出码 1 + `config_insecure` + `chmod 600` hint；
// 另外六条是退出码 2 + `kind: usage`（语义「改参数重来」）且 hint 丢失。
// 设计稿 §3.4 与 README 承诺的都是前者，所以后者是缺陷而非另一种口径。
//
// ⚠️ 为什么是**一个文件**覆盖六条命令，而不是各命令测试里补一条：本缺陷的形态正是
// 「同一判据在不同命令上分叉」。分文件写就复现不了这个形态 —— 下一个人在 checkPermissions
// 上加了第三个拒绝原因、只给 store 路径接上，跨文件断言不会红。这里的 `it.each`
// 把六条命令绑在**同一张表**上，漏接一条即红。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { storeCommand } from '../../src/commands/store.js'
import { dbCommand } from '../../src/commands/db.js'
import { queryCommand } from '../../src/commands/query.js'
import { statsCommand } from '../../src/commands/stats.js'
import { syncCommand } from '../../src/commands/sync.js'
import { authCommand } from '../../src/commands/auth.js'
import { __resetPermissionWarnings } from '../../src/core/config.js'

vi.setConfig({ testTimeout: 30_000 })

let home = ''
let out = ''
let err = ''
const dbPath = (): string => join(home, 'q.db')

/** 写一份**含凭证**且权限过宽（0644）的配置 —— 唯一的触发条件。 */
function writeWideConfig(): string {
  const dir = join(home, '.config', 'qiyu')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'config.json')
  writeFileSync(p, JSON.stringify({
    profiles: { default: { credentials: { appKey: 'k', appSecret: 's' } } },
  }, null, 2))
  chmodSync(p, 0o644)
  return p
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qiyu-insecure-'))
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
  vi.stubEnv('HOME', home)   // 隔离真实 ~，且让 configPathFor() 指到临时目录
  // ⚠️ 环境变量给上完整凭证（2026-10-26）：否则 `sync run` / `api` 会**先**在凭证层
  // 撞上同一个 config_insecure（`resolveCredentialsUsingFile` 也读这份文件），
  // 于是用例覆盖的是那条路径、`sync-run.ts` 自己的 `resolveStoreConfig` catch
  // 永远跑不到 —— 实测把 `sync-run.ts` 那行改回 `usageFail` 全绿（假绿）。
  // 给了 env 凭证后凭证层直接返回，命令继续走到配置解析，才是本条要钉的那一处。
  vi.stubEnv('QIYU_APP_KEY', 'test-key')
  vi.stubEnv('QIYU_APP_SECRET', 'test-secret')
  // 模块级警告去重表：用例之间必须互不污染（同 config.test.ts 的先例）。
  __resetPermissionWarnings()
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

const errorOf = (): Record<string, unknown> => JSON.parse(out).error

// ⚠️ Windows 上 `checkPermissions` 直接返回 `{ok: true}`（POSIX 权限位在 Windows 上没有
// 对应语义，`chmodSync` 也不生效）——这两组用例在 Windows 上必然全红，而它们测的是
// POSIX 权限裁决本身。仓库既有约定：`tests/skill/detect.test.ts` 等 13 处用
// `process.platform === 'win32'` 跳过同类用例。
const posixOnly = describe.skipIf(process.platform === 'win32')

posixOnly('含凭证且权限过宽（0644）→ 六条命令同一种行为', () => {
  // 每条命令给一个**最小可跑**的 argv：它必须真的走到配置解析那一步。
  // 带不带 `--db` 都走到同一处（resolveStoreConfig 无条件查权限），两种都收一条。
  const cases: Array<[string, () => Promise<number>]> = [
    ['store status', () => storeCommand(['status'])],
    ['store init', () => storeCommand(['init', '--db', dbPath()])],
    ['db tables', () => dbCommand(['tables'])],
    ['db tables --db', () => dbCommand(['tables', '--db', dbPath()])],
    ['query --table staff', () => queryCommand(['--table', 'staff'])],
    ['stats fields daily_overview', () => statsCommand(['fields', 'daily_overview'])],
    ['sync status', () => syncCommand(['status'])],
    ['sync run knowledge.categories', () => syncCommand(['run', 'knowledge.categories', '--quiet'])],
    ['auth whoami', () => authCommand(['whoami'])],
  ]

  it.each(cases)('%s：退出码 1 + kind/code 都是 config_insecure', async (_name, run) => {
    writeWideConfig()
    expect(await run()).toBe(1)
    const e = errorOf()
    expect(e.kind).toBe('config_insecure')
    expect(e.code).toBe('config_insecure')
    // 重试无用：Agent 不该退避重试，人 chmod 完才可能成功。
    expect(e.retryable).toBe(false)
  })

  it.each(cases)('%s：hint 点名要执行的 chmod 命令', async (_name, run) => {
    writeWideConfig()
    await run()
    // ⚠️ hint 必须**可执行**（带路径），不是"请检查权限"这类无动作的提醒 ——
    // 此前 store 路径连 hint 都没有（被 usageFail 丢掉了）。
    expect(String(errorOf().hint)).toMatch(/chmod 600 /)
  })

  it.each(cases)('%s：message 说清是权限问题，不是用法问题', async (_name, run) => {
    writeWideConfig()
    await run()
    const message = String(errorOf().message)
    expect(message).toMatch(/权限过宽/)
    expect(message).toMatch(/已拒绝读取/)
    // 退出码 2 的语义是"改参数重来"，这里必须没有那层含义 —— 消息里不该出现
    // 任何指向参数的指引（配置路径是家目录下的固定文件，与 argv 无关）。
    expect(message).not.toMatch(/未知参数|用法/)
  })

  it('不含凭证的文件维持「只警告不阻断」—— 两条路径都不能矫枉过正', async () => {
    // 反向钉子：改法若把整个拒绝逻辑挂到「文件权限过宽」上（丢掉 hasCredentials 判据），
    // 这条会红。C1 既有口径在 store 侧由 tests/store/config.test.ts 钉着，
    // 这里在**命令级**再钉一次（那条是解析层）。
    const dir = join(home, '.config', 'qiyu')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'config.json')
    writeFileSync(p, JSON.stringify({ profiles: { default: {} } }, null, 2))
    chmodSync(p, 0o644)
    expect(await storeCommand(['status', '--db', dbPath()])).not.toBe(2)
    expect(errorOf().kind).not.toBe('config_insecure')
  })
})

posixOnly('父目录可写且含凭证 → 同样如实透出（hint 点名 chmod 700）', () => {
  it('db tables：config_insecure + 目录 chmod', async () => {
    // ⚠️ 文件必须 0600 —— 否则命中的是**文件**那一条（`checkPermissions` 先查文件位），
    // hint 会是 chmod 600，本用例就测不到目录分支了。
    const p = writeWideConfig()
    chmodSync(p, 0o600)
    chmodSync(join(home, '.config', 'qiyu'), 0o777)
    expect(await dbCommand(['tables'])).toBe(1)
    const e = errorOf()
    expect(e.kind).toBe('config_insecure')
    expect(String(e.hint)).toMatch(/chmod 700 /)
  })
})

posixOnly('hint 里的路径必须可直接粘贴执行（含空格的 HOME）', () => {
  // ⚠️ 实测来源（CodeRabbit 2026-10-26）：配置路径来自 HOME，而 HOME 可以含空格
  //（如 `/Users/John Doe`）。不引号时 `chmod 600 /Users/John Doe/...` 会被 shell
  // 拆成多个参数 —— 用户照着 hint 抄反而得到 `chmod: 无法访问 'Doe/...'`，
  // 而这条 hint 的全部价值就是"照着执行就能修好"。
  it('HOME 含空格 → hint 里的路径被双引号包住', async () => {
    // 换一个带空格的 home 目录：beforeEach 的 home 是 mkdtemp 产物（无空格）。
    const spaced = join(home, 'with space')
    mkdirSync(join(spaced, '.config', 'qiyu'), { recursive: true })
    const p = join(spaced, '.config', 'qiyu', 'config.json')
    writeFileSync(p, JSON.stringify({
      profiles: { default: { credentials: { appKey: 'k', appSecret: 's' } } },
    }, null, 2))
    chmodSync(p, 0o644)
    vi.stubEnv('HOME', spaced)
    __resetPermissionWarnings()
    expect(await storeCommand(['status'])).toBe(1)
    const hint = String(errorOf().hint)
    expect(hint).toContain(`chmod 600 "${p}"`)
    // 反证：不引号的话这条 hint 在 shell 里是坏的 —— 断言"路径整体在一个引号内"
    expect(hint).not.toMatch(/chmod 600 \/.* with space\//)
  })

  it('不含空格的路径不加引号（不让每条 hint 都变吵）', async () => {
    writeWideConfig()
    expect(await storeCommand(['status'])).toBe(1)
    const hint = String(errorOf().hint)
    expect(hint).toMatch(/chmod 600 \/[^"]*config\.json$/)
  })

  it('auth login 写后自检的 hint 同样引号（与 core 的构造点同源）', async () => {
    // ⚠️ `auth login` 是唯一不走 `insecureConfigError` 的权限 hint（消息不同：
    // 凭证已经写进去了）。两处引号规则必须一致 —— 否则同一个 chmod 在一处可执行、
    // 在另一处不可执行。
    const spaced = join(home, 'with space')
    const dir = join(spaced, '.config', 'qiyu')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'config.json'), JSON.stringify({
      profiles: { default: { credentials: { appKey: 'k', appSecret: 's' } } },
    }, null, 2))
    chmodSync(join(dir, 'config.json'), 0o600)
    chmodSync(dir, 0o777)   // 目录过宽 → 写后自检拒绝
    vi.stubEnv('HOME', spaced)
    expect(await authCommand(['login'])).toBe(1)
    const hint = String(errorOf().hint)
    expect(hint).toContain(`chmod 700 "${dir}"`)
  })
})
