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
  buildDefaultEnv, buildWritePayload, defaultTmpPath, renderWriteScript, runWriteScript,
  type Runner, type Stage, type WritePlan, type WriteScriptResult,
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

  it('Task 2 只创建 tmp：不写内容、不读 stdin；结果单行、已处理失败 exit 0', () => {
    const script = renderWriteScript(plan())
    // 还不写任何内容（secret 写入在 Task 3）
    expect(script).not.toMatch(/WriteAllText|WriteAllBytes|Out-File|Set-Content|\[Console\]::In\b/)
    expect(script).toMatch(/ConvertTo-Json -Compress/)
    expect(script).toMatch(/processed failure still exits 0/)
    // 受限创建与错误码映射必须在脚本里
    expect(script).toMatch(/CreateRestricted/)
    expect(script).toMatch(/already-exists/)
    expect(script).toMatch(/0x12019f/)
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
    expect(argv).toEqual([
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64'),
    ])
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
