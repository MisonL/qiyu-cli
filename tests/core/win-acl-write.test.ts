// tests/core/win-acl-write.test.ts —— Windows 凭证写序的脚本通道骨架（0.2.4 切片 2，Task 1）
//
// 本文件钉的是**通道契约**，不钉写序机制（Task 2 起才有真实的 CreateFileW/MoveFileExW）：
// - 脚本源码纯 ASCII（PowerShell 5 按 ANSI 解码无 BOM UTF-8，中文会吞行——真机实测）；
// - secret 只经 stdin 传入：脚本、env、命令行参数里都不得出现；
// - stdout 只认**最后一行**（PowerShell progress/CLIXML 噪声在前，真机实测）；
// - 一切失败收敛到稳定字符串，不把原始异常/退出码抛给上层。
// 真实 Runner 在 macOS 上跑不起 powershell.exe，这里全部注入假 Runner。

import { spawnSync } from 'node:child_process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildDefaultEnv, buildWritePayload, defaultTmpPath, renderWriteScript, runWriteScript, runWriteInteractive,
  CP_PREFIX, READY_LINE, RESULT_PREFIX, judgeCheckpoint, writeConfigFileWin32, WinWriteError,
  type SpawnLike, type WriteScriptResult,
  type Runner, type Stage, type WritePlan,
} from '../../src/core/win-acl-write.js'

// 默认 Runner 的 spawnSync 契约用替身钉住（真实 powershell.exe 只在 Windows 上有）。
// 只影响本文件模块图；被 mock 的模块若还导出别的名字，这里必须一并列出。
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }))

const CONFIG = 'C:\\Users\\tester\\AppData\\Local\\qiyu\\config.json'
const PARENT = 'C:\\Users\\tester\\AppData\\Local\\qiyu'
const TMP = 'C:\\Users\\tester\\AppData\\Local\\qiyu\\.config.json.tmp-4321-1'
const USER_SID = 'S-1-5-21-3861268055-4207080600-3105454512-1001'

/** 高熵哨兵：任何一处出现都判泄漏（不会被误伤成普通子串）。 */
const SECRET = 'SENTINEL-SECRET-7f3a9c2e-DO-NOT-LEAK'
const CONFIG_JSON = JSON.stringify({ appId: 'app-1', appSecret: SECRET })

const plan = (over: Partial<WritePlan> = {}): WritePlan => ({
  configPath: CONFIG,
  parentDir: PARENT,
  tmpPath: TMP,
  ...over,
})

const payload = () => buildWritePayload(CONFIG_JSON)

const FAILED: WriteScriptResult = { ok: false, stage: 'probe', problem: 'script-failed' }

/** 记录每次调用的假 Runner。 */
function recording(impl: Runner = () => ({ status: 0, stdout: '{"ok":true,"stage":"done"}', stderr: '' })) {
  const calls: Parameters<Runner>[0][] = []
  const run: Runner = (args) => {
    calls.push(args)
    return impl(args)
  }
  return { run, calls }
}

describe('renderWriteScript：纯 ASCII 骨架', () => {
  it('输出全部落在 ASCII 范围（/^[\\x00-\\x7F]*$/）', () => {
    const script = renderWriteScript(plan())
    expect(script.length).toBeGreaterThan(0)
    expect(script).toMatch(/^[\x00-\x7F]*$/)
  })

  it('路径与 secret 都不进脚本：路径经 env 传，secret 经 stdin', () => {
    const script = renderWriteScript(plan())
    expect(script).not.toContain(CONFIG)
    expect(script).not.toContain(PARENT)
  })

  it('注释里按顺序写出将来各阶段（probe → … → done）', () => {
    const script = renderWriteScript(plan())
    const stages: Stage[] = [
      'probe', 'create-tmp', 'verify-tmp', 'write-secret', 'close', 'check-reparse', 'replace', 'verify-target', 'done',
    ]
    let at = -1
    for (const s of stages) {
      const next = script.indexOf(s, at + 1)
      expect(next, `stage ${s} 应按次序出现在脚本注释里`).toBeGreaterThan(at)
      at = next
    }
  })

  it('脚本覆盖 ⓪–⑥ 机制与交互协议标记', () => {
    const script = renderWriteScript(plan())
    // 不借助 .NET 的写文件 API（内容只经我方句柄写）
    expect(script).not.toMatch(/WriteAllText|WriteAllBytes|Out-File|Set-Content/)
    expect(script).toMatch(/ConvertTo-Json -Compress/)
    expect(script).toMatch(/CreateRestricted/)
    expect(script).toMatch(/already-exists/)
    expect(script).toMatch(/0x13019f/)
    expect(script).toMatch(/TargetIsReparse/)
    expect(script).toMatch(/MoveFileExW\(\$tmp, \$file, \[uint32\]1\)/)
    expect(script).toMatch(/verify-target/)
    // ⓪：目录句柄、相对打开、按句柄取 ACL
    expect(script).toMatch(/OpenDir/)
    expect(script).toMatch(/OpenChildDir/)
    expect(script).toMatch(/AclJson/)
    // 协议：checkpoint 在写 secret 之前，READY 才读载荷
    expect(script).toMatch(/Emit \("QIYU-CP "/)
    expect(script).toMatch(/Emit "QIYU-READY"/)
    expect(script.indexOf('Emit "QIYU-READY"')).toBeLessThan(script.indexOf('Emit ("QIYU-RESULT "'))
  })
})

describe('buildDefaultEnv / defaultTmpPath：路径经 env 传，secret 不进 env', () => {
  it('tmp 与目标同目录、名字沿用既有约定（换名必须同卷）', () => {
    const tmp = defaultTmpPath(CONFIG, 1234)
    expect(tmp.startsWith(PARENT + '\\')).toBe(true)
    expect(tmp).toMatch(/\.config\.json\.tmp-\d+-1234$/)
  })
  it('只放两个路径变量', () => {
    const env = buildDefaultEnv(CONFIG, PARENT, TMP)
    expect(env).toEqual({ QIYU_ACL_FILE: CONFIG, QIYU_ACL_PARENT: PARENT, QIYU_ACL_TMP: TMP })
  })
})

describe('buildWritePayload：整份配置是唯一载荷、不改内容', () => {
  it('config 逐字节等于入参', () => {
    const p = buildWritePayload(CONFIG_JSON)
    expect(p.config).toBe(CONFIG_JSON)
  })

  it('config 不是 JSON 字符串（不二次序列化）', () => {
    const p = buildWritePayload('{"a": 1}\n')
    expect(p.config).toBe('{"a": 1}\n')
    expect(p.config).not.toBe(JSON.stringify('{"a": 1}\n'))
  })

  it('载荷形状封闭：只有 config 一个字段（不留没人读的 secret 槽位）', () => {
    expect(buildWritePayload('plain')).toEqual({ config: 'plain' })
  })
})

describe('runWriteScript：stdin 是 secret 的唯一去向', () => {
  it('secret 在 stdin 里，不在 env / script 里', () => {
    const { run, calls } = recording()
    const script = renderWriteScript(plan())
    runWriteScript(script, CONFIG, PARENT, payload(), run)

    expect(calls).toHaveLength(1)
    const call = calls[0]!
    expect(call.stdin).toContain(SECRET)
    expect(call.script).toBe(script)
    expect(call.script).not.toContain(SECRET)
    for (const [k, v] of Object.entries(call.env)) {
      expect(v, `env ${k} 泄漏了 secret`).not.toContain(SECRET)
    }
    // stdin 是「{config, secret}」的 JSON：secret 只出现在 secret 字段
    const stdin = JSON.parse(call.stdin) as Record<string, unknown>
    expect(stdin).toEqual({ config: CONFIG_JSON })
  })

  it('注入的 Runner 只拿到两个路径键（其余 env 由默认 Runner 自己按白名单补）', () => {
    const { run, calls } = recording()
    runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), run, TMP)
    expect(calls[0]!.env).toEqual(buildDefaultEnv(CONFIG, PARENT, TMP))
  })

  it('超时与默认值写死成 15000ms', () => {
    const { run, calls } = recording()
    runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), run)
    expect(calls[0]!.timeoutMs).toBe(15_000)
  })
})

describe('runWriteScript：失败统一收敛', () => {
  const failureCases: [string, Runner][] = [
    ['Runner 抛错', () => { throw new Error('ENOENT powershell.exe') }],
    ['Runner 返回 string（与 spawnSync 返回 string 的坑）', (() => 'oops') as unknown as Runner],
    ['Runner 返回 null', (() => null) as unknown as Runner],
    ['status 非 0', () => ({ status: 1, stdout: '', stderr: 'boom' })],
    ['status null（进程被杀/超时）', () => ({ status: null as unknown as number, stdout: '', stderr: '' })],
    ['stdout 空', () => ({ status: 0, stdout: '', stderr: '' })],
    ['stdout 非 JSON', () => ({ status: 0, stdout: 'not json at all', stderr: '' })],
    ['stdout 是 JSON 但不是对象', () => ({ status: 0, stdout: '"done"', stderr: '' })],
    ['stdout JSON 缺 ok/stage', () => ({ status: 0, stdout: '{"ok":true}', stderr: '' })],
    ['stdout ok 不是布尔', () => ({ status: 0, stdout: '{"ok":"yes","stage":"done"}', stderr: '' })],
    ['stdout stage 不在 Stage 集合', () => ({ status: 0, stdout: '{"ok":true,"stage":"nope"}', stderr: '' })],
    ['stdout ok:false 但缺 problem', () => ({ status: 0, stdout: '{"ok":false,"stage":"probe"}', stderr: '' })],
    ['stdout ok:false 且 stage 是 done（自相矛盾的另一面）', () => ({ status: 0, stdout: '{"ok":false,"stage":"done","problem":"x"}', stderr: '' })],
    // status 校验必须独立于「stdout 解析得出解析不出」：这一档有合法结果行，只有 status 拦得住
    ['status 非 0 但 stdout 是合法成功行', () => ({ status: 1, stdout: '{"ok":true,"stage":"done"}', stderr: '' })],
    ['status 非 0 但 stdout 是合法失败行', () => ({ status: 2, stdout: '{"ok":false,"stage":"replace","problem":"x"}', stderr: '' })],
  ]

  for (const [name, impl] of failureCases) {
    it(`${name} → { ok:false, stage:'probe', problem:'script-failed' }`, () => {
      const result = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), impl)
      // 不夹带 path/sddlReadback 等半截字段：失败时结果就是要收敛的这一个形状
      expect(result).toEqual(FAILED)
    })
  }

  it('原始异常文本不进结果（不把 stderr/PowerShell 报文泄漏给上层）', () => {
    const result = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), () => ({
      status: 1, stdout: '', stderr: `Access denied to ${CONFIG}`,
    }))
    expect(JSON.stringify(result)).not.toContain('Access denied')
  })
})

describe('runWriteScript：stdout 噪声只认最后一行', () => {
  const okJson = '{"ok":true,"stage":"done","path":"C:\\\\x\\\\config.json","sddlReadback":"D:P(A;;0x13019f;;;S-1-5-21-1)"}'

  it('前面有 progress/CLIXML 噪声行、JSON 在最后一行 → 解析最后一行', () => {
    const stdout = [
      '#< CLIXML',
      '<Objs Version="1.1.0.1" xmlns="http://schemas.microsoft.com/powershell/2004/04"><Obj S="progress"/></Objs>',
      'Preparing modules for first use.',
      'json is not the first line {"ok":false,"stage":"probe"}',
      okJson,
    ].join('\r\n')
    const result = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), () => ({ status: 0, stdout, stderr: '' }))
    expect(result).toEqual({
      ok: true,
      stage: 'done',
      path: 'C:\\x\\config.json',
      sddlReadback: 'D:P(A;;0x13019f;;;S-1-5-21-1)',
    })
  })

  it('最后一行后有空白/换行 → 仍解析最后一行', () => {
    const stdout = `noise\r\n${okJson}\r\n\r\n`
    const result = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), () => ({ status: 0, stdout, stderr: '' }))
    expect(result.ok).toBe(true)
    expect(result.stage).toBe('done')
  })

  it('噪声在前、失败 JSON 在最后 → 原样回传失败记录', () => {
    const stdout = ['some progress', '{"ok":false,"stage":"create-tmp","problem":"already-exists"}'].join('\n')
    const result = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), () => ({ status: 0, stdout, stderr: '' }))
    expect(result).toEqual({ ok: false, stage: 'create-tmp', problem: 'already-exists' })
  })

  it('最后一行是噪声、JSON 在中间 → 不解析中间行，按失败收敛', () => {
    const stdout = [okJson, 'trailing garbage'].join('\n')
    const result = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), () => ({ status: 0, stdout, stderr: '' }))
    expect(result).toEqual(FAILED)
  })

  it('路径/阶段之外的未知字段不透传（结果形状封闭）', () => {
    const stdout = '{"ok":true,"stage":"done","secret":"leak?"}'
    const result = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), () => ({ status: 0, stdout, stderr: '' }))
    expect(result).toEqual({ ok: true, stage: 'done' })
  })

  it('失败记录的 path/sddlReadback 是可选字段，给了就原样回（数据，不是断言）', () => {
    const stdout = '{"ok":false,"stage":"verify-target","problem":"dacl-mismatch","path":"C:\\\\x\\\\config.json","sddlReadback":"D:PAI(A;;FA;;;SY)"}'
    const result = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), () => ({ status: 0, stdout, stderr: '' }))
    expect(result).toEqual({
      ok: false,
      stage: 'verify-target',
      problem: 'dacl-mismatch',
      path: 'C:\\x\\config.json',
      sddlReadback: 'D:PAI(A;;FA;;;SY)',
    })
  })

  it('path/sddlReadback 类型不对 → 按失败收敛（不当半截记录回传）', () => {
    const stdout = '{"ok":true,"stage":"done","path":42}'
    const result = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), () => ({ status: 0, stdout, stderr: '' }))
    expect(result).toEqual(FAILED)
  })
})

describe('defaultRunner：spawnSync 命令行契约', () => {
  const mocked = vi.mocked(spawnSync)
  // 上一个 describe 的「Runner 抛错」不会走 spawnSync，但显式清干净，免得用例次序一变就串味
  beforeEach(() => mocked.mockReset())

  it('powershell.exe + 五个固定参数；script 以 UTF-16LE base64 进 -EncodedCommand', () => {
    const script = renderWriteScript(plan())
    mocked.mockReturnValue({ status: 0, stdout: '{"ok":true,"stage":"done"}', stderr: '' } as never)
    const result = runWriteScript(script, CONFIG, PARENT, payload())

    expect(result).toEqual({ ok: true, stage: 'done' })
    expect(mocked).toHaveBeenCalledTimes(1)
    const [file, argv, opts] = mocked.mock.calls[0]!
    expect(file).toBe('powershell.exe')
    // 脚本走临时 .ps1（-EncodedCommand 会超 Windows 命令行上限）；前五个参数固定
    expect((argv as string[]).slice(0, 5)).toEqual(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])
    expect((argv as string[])[5]).toMatch(/qiyu-write-.+write\.ps1$/)
    const o = opts as Record<string, unknown>
    expect(o).toMatchObject({
      input: JSON.stringify({ config: CONFIG_JSON }),
      encoding: 'utf8',
      timeout: 15_000,
      windowsHide: true,
    })
    // 路径必须真的经 env 传给脚本：漏传就是给空路径动手（父进程环境合并保留 PATH 等）。
    expect(o.env).toMatchObject({ QIYU_ACL_FILE: CONFIG, QIYU_ACL_PARENT: PARENT })
  })

  it('secret 不在文件名、argv 或 env 选项里（只经 stdin）', () => {
    mocked.mockReturnValue({ status: 0, stdout: '{"ok":true,"stage":"done"}', stderr: '' } as never)
    runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload())

    const [file, argv, opts] = mocked.mock.calls[0]!
    expect(String(file)).not.toContain(SECRET)
    expect((argv as string[]).join('\u0000')).not.toContain(SECRET)
    const o = opts as Record<string, unknown>
    expect(JSON.stringify(o.env ?? {})).not.toContain(SECRET)
    // env 必须传（否则脚本取不到路径），但只多出两个路径键，secret 只走 stdin
    expect(Object.keys(o.env as Record<string, string>)).toEqual(
      expect.arrayContaining(['QIYU_ACL_FILE', 'QIYU_ACL_PARENT']),
    )
  })

  it('process.env 里的凭证变量不得进子进程 env（auth login 的 secret 来源之一）', () => {
    const saved = process.env.QIYU_APP_SECRET
    process.env.QIYU_APP_SECRET = SECRET
    try {
      mocked.mockReturnValue({ status: 0, stdout: '{"ok":true,"stage":"done"}', stderr: '' } as never)
      runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), undefined, TMP)
      const [, , opts] = mocked.mock.calls[0]!
      const env = (opts as Record<string, unknown>).env as Record<string, string>
      expect(env.QIYU_APP_SECRET).toBeUndefined()
      expect(JSON.stringify(env)).not.toContain(SECRET)
      // 白名单仍然带上 PowerShell 启动所需的系统变量
      expect(Object.keys(env)).toEqual(expect.arrayContaining(['QIYU_ACL_FILE', 'QIYU_ACL_PARENT']))
    } finally {
      if (saved === undefined) delete process.env.QIYU_APP_SECRET
      else process.env.QIYU_APP_SECRET = saved
    }
  })

  it('spawnSync 的 error（ENOENT/超时不抛，回 error+status null）→ script-failed', () => {
    mocked.mockReturnValue({
      status: null, stdout: '', stderr: '', error: new Error('spawnSync powershell.exe ENOENT'),
    } as never)
    const result = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload())
    expect(result).toEqual(FAILED)
  })

  it('stdout 为 null / 非 string（encoding 契约被打断）→ script-failed', () => {
    mocked.mockReturnValue({ status: 0, stdout: null, stderr: '' } as never)
    expect(runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload())).toEqual(FAILED)
  })
})

// ── 交互协议（Task 5）：checkpoint → GO/STOP → READY 之后才允许发送秘密 ──────
describe('runWriteInteractive：secret 只在 READY 之后进入子进程', () => {
  class FakeChild {
    writes: string[] = []
    private out: ((c: Buffer | string) => void)[] = []
    private exit: ((code: unknown) => void)[] = []
    private close: ((code: unknown) => void)[] = []
    private error: ((e: unknown) => void)[] = []
    stdin = { write: (c: string) => { this.writes.push(c); return true }, end: () => {} }
    stdout = { on: (_e: 'data', cb: (c: Buffer | string) => void) => { this.out.push(cb) } }
    stderr = { on: () => {} }
    on = (e: 'exit' | 'close' | 'error', cb: (arg: unknown) => void) => {
      if (e === 'exit') this.exit.push(cb)
      else if (e === 'close') this.close.push(cb)
      else this.error.push(cb)
    }
    kill = () => {}
    emitLine(s: string): void { for (const cb of this.out) cb(s + '\r\n') }
    emitClose(code = 0): void { for (const cb of this.close) cb(code) }
    emitExit(code: number): void { for (const cb of this.exit) cb(code) }
    emitError(e: unknown): void { for (const cb of this.error) cb(e) }
  }

  const CP = CP_PREFIX + JSON.stringify({ stage: 'probe', selfSid: 'S-1-5-21-1' })

  it('happy path：CP→GO、READY→载荷、RESULT→结果；载荷前没有 secret', async () => {
    const child = new FakeChild()
    const spawnArgs: { cmd: string; argv: string[]; opts: Record<string, unknown> }[] = []
    const spawnImpl: SpawnLike = (cmd, argv, opts) => { spawnArgs.push({ cmd, argv, opts }); return child }
    const decide = vi.fn(() => ({ go: true as const }))
    const p = runWriteInteractive({
      script: renderWriteScript(plan()), configPath: CONFIG, parentDir: PARENT, tmpPath: TMP,
      config: CONFIG_JSON, onCheckpoint: decide, spawnImpl, timeoutMs: 5000,
    })

    child.emitLine('noise line')
    child.emitLine(CP)
    expect(child.writes).toEqual(['GO\n'])
    expect(decide).toHaveBeenCalledWith({ stage: 'probe', selfSid: 'S-1-5-21-1' })

    child.emitLine(READY_LINE)
    expect(child.writes[1]).toBe(JSON.stringify({ config: CONFIG_JSON }) + '\n')
    // 载荷里有 secret，但它只在第 2 次写入时出现；argv/env 都没有
    expect(spawnArgs[0]!.argv.join('\u0000')).not.toContain(SECRET)
    expect(JSON.stringify(spawnArgs[0]!.opts.env)).not.toContain(SECRET)

    child.emitLine(RESULT_PREFIX + '{"ok":true,"stage":"done"}')
    await expect(p).resolves.toEqual({ ok: true, stage: 'done' })
  })

  it('STOP 后即使脚本打印 READY 也不得发送载荷', async () => {
    const child = new FakeChild()
    const p = runWriteInteractive({
      script: renderWriteScript(plan()), configPath: CONFIG, parentDir: PARENT, tmpPath: TMP,
      config: CONFIG_JSON,
      onCheckpoint: () => ({ go: false, problem: 'parent-writable' }),
      spawnImpl: () => child, timeoutMs: 5000,
    })
    child.emitLine(CP)
    expect(child.writes).toEqual(['STOP parent-writable\n'])
    child.emitLine(READY_LINE)
    expect(child.writes).toEqual(['STOP parent-writable\n'])
    await expect(p).resolves.toEqual({ ok: false, stage: 'probe', problem: 'parent-writable' })
  })

  it('超时 / 无结果退出 / 结果行畸形 → script-failed', async () => {
    const mk = (): FakeChild => new FakeChild()
    const runWith = (timeoutMs: number, drive: (c: FakeChild) => void): Promise<WriteScriptResult> => {
      const c = mk()
      const p = runWriteInteractive({
        script: renderWriteScript(plan()), configPath: CONFIG, parentDir: PARENT, tmpPath: TMP,
        config: CONFIG_JSON, onCheckpoint: () => ({ go: true }), spawnImpl: () => c, timeoutMs,
      })
      drive(c)
      return p
    }
    await expect(runWith(30, () => {})).resolves.toEqual(FAILED)
    await expect(runWith(5000, (c) => c.emitClose(1))).resolves.toEqual(FAILED)
    await expect(runWith(5000, (c) => c.emitLine(RESULT_PREFIX + 'not json'))).resolves.toEqual(FAILED)
  })

  it('checkpoint 出现在载荷之后 → 立即失败（协议被破坏）', async () => {
    const child = new FakeChild()
    const p = runWriteInteractive({
      script: renderWriteScript(plan()), configPath: CONFIG, parentDir: PARENT, tmpPath: TMP,
      config: CONFIG_JSON, onCheckpoint: () => ({ go: true }), spawnImpl: () => child, timeoutMs: 5000,
    })
    child.emitLine(CP)
    child.emitLine(READY_LINE)
    child.emitLine(CP)
    await expect(p).resolves.toEqual(FAILED)
  })
})

// ── Task 6：判定与 win32 写入入口 ──────────────────────────────────────────
describe('judgeCheckpoint / writeConfigFileWin32', () => {
  const DIR_FA = 0x1f01ff
  const aclJson = (over: Record<string, unknown> = {}): string => JSON.stringify({
    sddl: 'D:PAI',
    daclProtected: true,
    ownerSid: USER_SID,
    aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USER_SID, mask: DIR_FA, inheritOnly: false }],
    ...over,
  })
  const parentAcl = (): string => JSON.stringify({
    sddl: 'D:AI',
    daclProtected: false,
    ownerSid: USER_SID,
    aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USER_SID, mask: DIR_FA, inheritOnly: false }],
  })

  it('复用档全绿 → GO；宽松父目录 → parent-writable', () => {
    expect(judgeCheckpoint({ stage: 'probe', phase: 'parent', selfSid: USER_SID, groups: ['S-1-1-0;15'], created: false, identityMatch: true, reparse: false, qiyu: aclJson(), parent: parentAcl() }))
      .toEqual({ go: true })
    const looseParent = JSON.stringify({
      sddl: 'D:AI', daclProtected: false, ownerSid: USER_SID,
      aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: 'S-1-1-0', mask: 0x2, inheritOnly: false }],
    })
    expect(judgeCheckpoint({ stage: 'probe', phase: 'parent', selfSid: USER_SID, groups: ['S-1-1-0;15'], created: false, identityMatch: true, reparse: false, qiyu: aclJson(), parent: looseParent }))
      .toEqual({ go: false, problem: 'parent-writable' })
  })

  it('身份不符 / 重解析点 / 目录配方不合规 → 各自 STOP', () => {
    expect(judgeCheckpoint({ stage: 'probe', phase: 'created', selfSid: USER_SID, groups: ['S-1-1-0;15'], created: true, identityMatch: false, reparse: false, qiyu: aclJson(), parent: parentAcl() }))
      .toEqual({ go: false, problem: 'dir-identity-mismatch' })
    expect(judgeCheckpoint({ stage: 'probe', phase: 'created', selfSid: USER_SID, groups: ['S-1-1-0;15'], created: true, identityMatch: true, reparse: true, qiyu: aclJson(), parent: parentAcl() }))
      .toEqual({ go: false, problem: 'dir-is-reparse' })
    expect(judgeCheckpoint({ stage: 'probe', phase: 'created', selfSid: USER_SID, groups: ['S-1-1-0;15'], created: true, identityMatch: true, reparse: false, qiyu: aclJson({ daclProtected: false }), parent: parentAcl() }))
      .toEqual({ go: false, problem: 'dacl-inherited' })
  })

  it('首次登录：parent 阶段 created=true 时不要求身份（目录尚不存在）', () => {
    expect(judgeCheckpoint({ stage: 'probe', phase: 'parent', selfSid: USER_SID, groups: ['S-1-1-0;15'], created: true, parent: parentAcl() }))
      .toEqual({ go: true })
  })

  it('writeConfigFileWin32：done 才成功；其余 stage 抛 WinWriteError（不返回部分成功）', async () => {
    const okRun = vi.fn(async () => ({ ok: true, stage: 'done' as const }))
    await expect(writeConfigFileWin32(CONFIG, CONFIG_JSON, { run: okRun as never })).resolves.toBeUndefined()
    const failRun = vi.fn(async () => ({ ok: false, stage: 'verify-tmp' as const, problem: 'sddl-mismatch' }))
    await expect(writeConfigFileWin32(CONFIG, CONFIG_JSON, { run: failRun as never })).rejects.toMatchObject({
      name: 'WinWriteError', stage: 'verify-tmp', problem: 'sddl-mismatch',
    })
    const partialRun = vi.fn(async () => ({ ok: true, stage: 'write-secret' as const }))
    await expect(writeConfigFileWin32(CONFIG, CONFIG_JSON, { run: partialRun as never })).rejects.toMatchObject({ stage: 'write-secret' })
  })
})

// ── 2026-11-28 真机：全新账户没有 ~/.config ────────────────────────────────
describe('⓪ 缺失的上级目录（~/.config）', () => {
  it('先尝试打开，缺失时用目录配方创建再重新绑定（顺序钉住）', () => {
    const script = renderWriteScript(plan())
    const openAt = script.indexOf('OpenDir($up')
    const createAt = script.indexOf('CreateDir($up')
    const reopenAt = script.indexOf('OpenDir($up', openAt + 1)
    expect(openAt).toBeGreaterThan(-1)
    expect(createAt).toBeGreaterThan(openAt)
    expect(reopenAt).toBeGreaterThan(createAt)
    // 只对「不存在」两码走创建，其它错误照旧 parent-open-failed
    expect(script).toMatch(/\$err -ne 2 -and \$err -ne 3\) \{ \$result\.problem = "parent-open-failed"/)
    expect(script).toContain('parent-create-failed')
  })

  it('WinWriteError 携带 selfSid，供 hint 渲染 icacls', async () => {
    const run = vi.fn(async () => ({ ok: false, stage: 'probe' as const, problem: 'parent-writable', selfSid: USER_SID }))
    await expect(writeConfigFileWin32(CONFIG, CONFIG_JSON, { run: run as never })).rejects.toMatchObject({
      selfSid: USER_SID,
    })
  })
})

// ── 真机首登回归（2026-11-28）：CP2 只带新建目录材料 ────────────────────────
describe('judgeCheckpoint：created 阶段不需要 parent', () => {
  const good = (): Record<string, unknown> => {
    const FA = 0x1f01ff
    return {
      stage: 'probe', phase: 'created', selfSid: USER_SID,
      groups: ['S-1-1-0;15'], created: true,
      identityMatch: true, reparse: false,
      qiyu: JSON.stringify({
        sddl: 'D:PAI', daclProtected: true, ownerSid: USER_SID,
        aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USER_SID, mask: FA, inheritOnly: false }],
      }),
    }
  }
  it('缺 parent 也放行（父目录已在 CP1 判过）', () => {
    expect(judgeCheckpoint(good() as never)).toEqual({ go: true })
  })
  it('新建目录配方不合规仍 STOP', () => {
    const cp = good()
    cp.qiyu = JSON.stringify({ sddl: 'D:AI', daclProtected: false, ownerSid: USER_SID, aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USER_SID, mask: 0x1f01ff, inheritOnly: false }] })
    expect(judgeCheckpoint(cp as never)).toEqual({ go: false, problem: 'dacl-inherited' })
  })
})


describe('Codex 65 写序修复', () => {
  it('文件配方含 DELETE（0x13019f，规格 §2.4a）；不再出现无 DELETE 的 0x12019f', () => {
    const script = renderWriteScript(plan())
    expect(script).toContain('0x13019f')
    expect(script).toContain('$fileDacl = "D:P(A;;0x13019f;;;" + $sid + ")"')
    expect(script).not.toContain('0x12019f')
  })

  it('回读带 AI 时先规范化再比（verify-tmp 与 verify-target 两处）', () => {
    const script = renderWriteScript(plan())
    const NORM = String.raw`-replace ":PAI\(", ":P("`
    const normCount = script.split(NORM).length - 1
    expect(normCount).toBe(2)
    // 规范化必须发生在比较之前
    expect(script.indexOf(NORM)).toBeLessThan(script.indexOf('$daclOk = $rbTmp.Contains($fileDacl)'))
  })

  it('注释行不得直接跟在续行符之后（反引号会吞注释，续行后语句被消除）', () => {
    const lines = renderWriteScript(plan()).split('\r\n')
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trimStart().startsWith('#')) {
        expect(lines[i - 1].trimEnd().endsWith('`'), `第 ${i} 行的注释被上一层续行吞掉：${lines[i]}`).toBe(false)
      }
    }

  })

  it('只删本次创建的 tmp：already-exists 时同名文件不是我们的', () => {
    const script = renderWriteScript(plan())
    expect(script).toContain('$createdTmp = $false')
    expect(script).toContain('$createdTmp = $true')
    expect(script).toContain('if ($createdTmp -and $result.stage -ne "done"')
  })

  it('失败收尾会尝试删除含 secret 的 tmp 并报告残留', () => {
    const script = renderWriteScript(plan())
    expect(script).toContain('if ($createdTmp -and $result.stage -ne "done" -and [System.IO.File]::Exists($tmp))')
    expect(script).toContain('[System.IO.File]::Delete($tmp)')
    expect(script).toContain('$result.tmpLeft = [System.IO.File]::Exists($tmp)')
  })

  it('关键操作顺序：绑定父目录 → 受限创建 → 同一句柄写入 → 关闭 → 换名', () => {
    const script = renderWriteScript(plan())
    const order = ['OpenDir($up', 'CreateRestricted($tmp', 'WriteAll($h', 'CloseHandle($h)', 'MoveFileExW($tmp, $file']
    const idx = order.map((op) => script.indexOf(op))
    for (let i = 0; i < idx.length; i++) {
      expect(idx[i], `${order[i]} 应在脚本里`).toBeGreaterThan(-1)
      if (i > 0) expect(idx[i], `${order[i]} 应在 ${order[i - 1]} 之后`).toBeGreaterThan(idx[i - 1])
    }
  })

  it('wroteTarget 只在 verify-target 阶段为真；tmpLeft 透传给上层', async () => {
    const run = vi.fn(async () => ({ ok: false, stage: 'verify-target' as const, problem: 'target-sddl-mismatch', selfSid: USER_SID }))
    await expect(writeConfigFileWin32(CONFIG, CONFIG_JSON, { run: run as never })).rejects.toMatchObject({
      stage: 'verify-target', wroteTarget: true,
    })
    const run2 = vi.fn(async () => ({ ok: false, stage: 'replace' as const, problem: 'replace-failed', tmpLeft: true }))
    await expect(writeConfigFileWin32(CONFIG, CONFIG_JSON, { run: run2 as never })).rejects.toMatchObject({
      wroteTarget: false, tmpLeft: true,
    })
  })
})


describe('Codex 复查：tmpLeft 必须经结果解析器（真实交互通道）', () => {
  const runner = (stdout: string) => () => ({ status: 0, stdout, stderr: '' })
  it('结果行里的 tmpLeft 被复制，而不是在 coerceResult 丢弃', () => {
    const out = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), runner(
      'QIYU-RESULT ' + JSON.stringify({ ok: false, stage: 'replace', problem: 'replace-failed', tmpLeft: true }),
    ), TMP)
    expect(out).toMatchObject({ ok: false, stage: 'replace', problem: 'replace-failed', tmpLeft: true })
  })
  it('tmpLeft 非布尔 → 结果形状不合法（script-failed）', () => {
    const out = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), runner(
      'QIYU-RESULT ' + JSON.stringify({ ok: false, stage: 'replace', problem: 'replace-failed', tmpLeft: 'yes' }),
    ), TMP)
    expect(out).toMatchObject({ ok: false, problem: 'script-failed' })
  })
})


describe('CodeRabbit 17：写序安全面修复', () => {
  it('文件与目录 SD 都显式写属主（提权令牌默认属主可能是 Administrators）', () => {
    const script = renderWriteScript(plan())
    expect(script).toContain('$dirDacl = "D:P(A;;FA;;;" + $sid + ")"')
    expect(script).toContain('$fileSddl = "O:" + $sid + $fileDacl')
    expect(script).toContain('$dirSddl = "O:" + $sid + $dirDacl')
  })

  it('身份读不到/重解析点判不了 → 在发 CP 之前就停，不能把两个空串当相等', () => {
    const script = renderWriteScript(plan())
    expect(script).toContain('identity-failed')
    expect(script).toContain('reparse-check-failed')
    expect(script).toMatch(/\$idRel -eq "" -or \$idQ -eq ""/)
  })

  it('换入后按句柄复核身份与 ACL（Get-Acl 路径读不再作为终判）', () => {
    const script = renderWriteScript(plan())
    expect(script).toContain('OpenFile($file')
    expect(script).toContain('target-identity-mismatch')
    expect(script).toContain('SddlFromHandle($fh)')
    expect(script).not.toContain('(Get-Acl -LiteralPath $file)')
  })

  it('换入成功后不再把 tmp 名字当自己的（$createdTmp 复位）', () => {
    const script = renderWriteScript(plan())
    const moveAt = script.indexOf('MoveFileExW($tmp, $file')
    const resetAt = script.indexOf('$createdTmp = $false', moveAt)
    expect(resetAt).toBeGreaterThan(moveAt)
  })

  it('同步通道把载荷当回复读到时，problem 是固定码而不是回声（secret 不得进错误文本）', () => {
    const out = runWriteScript(renderWriteScript(plan()), CONFIG, PARENT, payload(), () => ({
      status: 0,
      stdout: `${'QIYU-CP'} {}\r\n` + 'QIYU-RESULT ' + JSON.stringify({ ok: false, stage: 'probe', problem: 'unexpected-reply' }),
      stderr: '',
    }), TMP)
    // 脚本侧固定码：回声路径已被固定码取代（脚本断言）
    const script = renderWriteScript(plan())
    expect(script).toContain('unexpected-reply')
    expect(script).toContain('$reply.Substring(5)')
    expect(out.ok).toBe(false)
  })

  it('载荷发出后子进程关闭 stdin 出错 → 结果未知（不能说未写入）', async () => {
    const c = new FakeChildForUnknown()
    const p = runWriteInteractive({
      script: renderWriteScript(plan()), configPath: CONFIG, parentDir: PARENT, tmpPath: TMP,
      config: CONFIG_JSON, onCheckpoint: () => ({ go: true }), spawnImpl: () => c as never, timeoutMs: 100,
    })
    c.emitLine('QIYU-CP {}')
    c.emitLine('QIYU-READY')
    c.emitStdinError()
    await expect(p).resolves.toMatchObject({ ok: false, outcomeUnknown: true, stage: 'write-secret' })
  })

  it('载荷发出后进程 close → 结果未知；载荷发出前 close 仍是 script-failed', async () => {
    const mk = () => new FakeChildForUnknown()
    const run = (drive: (c: FakeChildForUnknown) => void) => {
      const c = mk()
      const p = runWriteInteractive({
        script: renderWriteScript(plan()), configPath: CONFIG, parentDir: PARENT, tmpPath: TMP,
        config: CONFIG_JSON, onCheckpoint: () => ({ go: true }), spawnImpl: () => c as never, timeoutMs: 5000,
      })
      drive(c)
      return p
    }
    await expect(run((c) => { c.emitLine('QIYU-CP {}'); c.emitLine('QIYU-READY'); c.emitClose(1) }))
      .resolves.toMatchObject({ outcomeUnknown: true })
    const pre = await run((c) => c.emitClose(1))
    expect(pre).toMatchObject({ ok: false, stage: 'probe' })
    expect(pre.outcomeUnknown).toBeUndefined()
  })
})

class FakeChildForUnknown {
  writes: string[] = []
  private out: ((c: Buffer | string) => void)[] = []
  private closeCbs: ((code: unknown) => void)[] = []
  private errCbs: ((e: unknown) => void)[] = []
  private stdinErr: ((e: unknown) => void)[] = []
  stdin = { write: (c: string) => { this.writes.push(c); return true }, end: () => {}, on: (_e: 'error', cb: (e: unknown) => void) => { this.stdinErr.push(cb) } }
  stdout = { on: (_e: 'data', cb: (c: Buffer | string) => void) => { this.out.push(cb) } }
  stderr = { on: () => {} }
  on = (e: 'exit' | 'close' | 'error', cb: (arg: unknown) => void) => {
    if (e === 'close') this.closeCbs.push(cb)
    else if (e === 'error') this.errCbs.push(cb)
  }
  kill = () => {}
  emitLine(s: string): void { for (const cb of this.out) cb(s + '\r\n') }
  emitClose(code = 0): void { for (const cb of this.closeCbs) cb(code) }
  emitStdinError(): void { for (const cb of this.stdinErr) cb(new Error('EPIPE')) }
}


describe('PowerShell 保留变量守卫（真机 script-error 事故 2026-11-28）', () => {
  it('脚本不得给 $home/$input/$args/$error/$host/$pwd 等自动变量赋值', () => {
    const script = renderWriteScript(plan())
    // 事故形态：`$home = Split-Path ...` → SessionStateUnauthorizedAccessException（$HOME 只读），
    // 被 catch 统一收敛成 script-error，看不出成因。
    for (const name of ['home', 'input', 'args', 'error', 'host', 'pwd', 'profile', 'pshome']) {
      expect(script, name).not.toMatch(new RegExp('\\$' + name + '\\s*=', 'i'))
    }
  })
})


describe('Codex CR17 复查：祖先语境 / 结果未知 / 目标被替换', () => {
  const goodParent = (): string => JSON.stringify({
    sddl: 'D:AI', daclProtected: false, ownerSid: USER_SID,
    aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USER_SID, mask: 0x1f01ff, inheritOnly: false }],
  })
  const nullDacl = (): string => JSON.stringify({ sddl: 'O:' + USER_SID, daclProtected: false, ownerSid: USER_SID, aces: [] })

  it('HOME 的 null DACL → ancestor-dacl-missing（不是未加前缀的 dacl-missing）', () => {
    expect(judgeCheckpoint({
      stage: 'probe', phase: 'parent', selfSid: USER_SID,
      groups: ['S-1-1-0;15'], created: true, home: nullDacl(), parent: goodParent(),
    })).toEqual({ go: false, problem: 'ancestor-dacl-missing' })
  })

  it('父目录的 null DACL → parent-dacl-missing', () => {
    expect(judgeCheckpoint({
      stage: 'probe', phase: 'parent', selfSid: USER_SID,
      groups: ['S-1-1-0;15'], created: true, parent: nullDacl(),
    })).toEqual({ go: false, problem: 'parent-dacl-missing' })
  })

  it('脚本：自建 .config 前 HOME 读空即停；建后比身份/重解析点', () => {
    const script = renderWriteScript(plan())
    expect(script).toContain('ancestor-unparsable')
    expect(script).toContain('ancestor-identity-mismatch')
    expect(script).toContain('ancestor-is-reparse')
    expect(script).toContain('OpenFile')
    expect(script).toContain('0x200000') // FILE_FLAG_OPEN_REPARSE_POINT
  })

  it('载荷已发出后收到畸形结果 → 结果未知（不是 script-failed）', async () => {
    const c = new FakeChildForUnknown()
    const p = runWriteInteractive({
      script: renderWriteScript(plan()), configPath: CONFIG, parentDir: PARENT, tmpPath: TMP,
      config: CONFIG_JSON, onCheckpoint: () => ({ go: true }), spawnImpl: () => c as never, timeoutMs: 5000,
    })
    c.emitLine('QIYU-CP {}')
    c.emitLine('QIYU-READY')
    c.emitLine('QIYU-RESULT {broken')
    await expect(p).resolves.toMatchObject({ outcomeUnknown: true })
  })

  it('wroteTarget 只对「身份通过、ACL 不符」成立；身份不符说明目标被替换', async () => {
    const mk = (problem: string) => vi.fn(async () => ({ ok: false, stage: 'verify-target' as const, problem }))
    await expect(writeConfigFileWin32(CONFIG, CONFIG_JSON, { run: mk('target-sddl-mismatch') as never }))
      .rejects.toMatchObject({ wroteTarget: true })
    await expect(writeConfigFileWin32(CONFIG, CONFIG_JSON, { run: mk('target-identity-mismatch') as never }))
      .rejects.toMatchObject({ wroteTarget: false })
  })
})


describe('Codex 第三轮复查：祖先 checkpoint 与会话组', () => {
  const USERS = 'S-1-5-32-545'
  const goodParent = (): string => JSON.stringify({
    sddl: 'D:AI', daclProtected: false, ownerSid: USER_SID,
    aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USER_SID, mask: 0x1f01ff, inheritOnly: false }],
  })
  const goodHome = (): string => JSON.stringify({
    sddl: 'D:AI', daclProtected: false, ownerSid: USER_SID,
    aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USER_SID, mask: 0x1f01ff, inheritOnly: false }],
  })
  const dirWithUsersDeny = (): string => JSON.stringify({
    sddl: 'D:P', daclProtected: true, ownerSid: USER_SID,
    aces: [
      { type: 'Deny', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USERS, mask: 0x10000, inheritOnly: false },
      { type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USER_SID, mask: 0x1f01ff, inheritOnly: false },
    ],
  })

  it('脚本在建 .config 之前先发 phase=ancestor 的 checkpoint（STOP 不留目录）', () => {
    const script = renderWriteScript(plan())
    const cpAncestor = script.indexOf('phase = "ancestor"')
    const createConfig = script.indexOf('CreateDir($up')
    expect(cpAncestor).toBeGreaterThan(-1)
    expect(createConfig).toBeGreaterThan(cpAncestor)
    expect(script).toContain('GroupList()')
  })

  it('ancestor 阶段：HOME 写面不合格 → ancestor-writable', () => {
    const loose = JSON.stringify({
      sddl: 'D:AI', daclProtected: false, ownerSid: USER_SID,
      aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: 'S-1-1-0', mask: 0x2, inheritOnly: false }],
    })
    expect(judgeCheckpoint({ stage: 'probe', phase: 'ancestor', selfSid: USER_SID, groups: ['S-1-1-0;15'], created: false, home: loose }))
      .toEqual({ go: false, problem: 'ancestor-writable' })
  })

  it('checkpoint 的令牌组参与目录判据：deny Users 拿掉 DELETE → dir-recipe-mismatch', () => {
    const cp = {
      stage: 'probe', phase: 'created', selfSid: USER_SID,
      created: true,
      identityMatch: true, reparse: false, qiyu: dirWithUsersDeny(),
      groups: [`${USERS};15`],
    }
    expect(judgeCheckpoint(cp as never)).toEqual({ go: false, problem: 'dir-recipe-mismatch' })
    // 空组不再等价「没有组」：判定不了（组 deny 会被静默放行）
    const noGroups = { ...cp, groups: [] }
    expect(judgeCheckpoint(noGroups as never)).toEqual({ go: false, problem: 'groups-unparsable' })
  })

  it('组列表形状不对 → groups-unparsable（不能当「没有组」放行）', () => {
    expect(judgeCheckpoint({
      stage: 'probe', phase: 'ancestor', selfSid: USER_SID, created: false, home: goodHome(),
      groups: ['not-a-pair'] as never,
    })).toEqual({ go: false, problem: 'groups-unparsable' })
  })

  it('目标打不开属于结果未知：wroteTarget 为 false', async () => {
    const run = vi.fn(async () => ({ ok: false, stage: 'verify-target' as const, problem: 'target-open-failed' }))
    await expect(writeConfigFileWin32(CONFIG, CONFIG_JSON, { run: run as never }))
      .rejects.toMatchObject({ wroteTarget: false })
  })

  it('可复用的材料齐全时 ancestor 阶段放行', () => {
    expect(judgeCheckpoint({ stage: 'probe', phase: 'ancestor', selfSid: USER_SID, groups: ['S-1-1-0;15'], created: false, home: goodHome() }))
      .toEqual({ go: true })
  })
})


describe('Codex 第四轮：组列表形状必须严格', () => {
  const goodHome = (): string => JSON.stringify({
    sddl: 'D:AI', daclProtected: false, ownerSid: USER_SID,
    aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USER_SID, mask: 0x1f01ff, inheritOnly: false }],
  })
  const base = (groups: unknown) => ({
    stage: 'probe', phase: 'ancestor', selfSid: USER_SID, created: false, home: goodHome(), groups,
  })
  it.each([
    ['缺组字段', undefined],
    ['空数组', []],
    ['缺属性值', ['S-1-1-0;']],
    ['多字段', ['S-1-1-0;15;extra']],
    ['属性超 32 位', ['S-1-1-0;4294967296']],
    ['属性为负数', ['S-1-1-0;-1']],
  ])('%s → groups-unparsable', (_label, groups) => {
    expect(judgeCheckpoint(base(groups) as never)).toEqual({ go: false, problem: 'groups-unparsable' })
  })
})
