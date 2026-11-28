// auth login 的 Windows 写序错误渲染：win32 分支在 macOS 上跑不到，这里用模块替身钉住文案契约。
//
// 判据都是「同一事实的两种说法」问题（CodeRabbit 2026-11-28 / Codex 65）：
// - 换入已发生、只是复核失败 → 不能说「凭证未写入」；
// - 载荷已发出后进程消失 → 只能说「结果未知」，两种断言都不许下；
// - 自检炸了 → 成功可以给，但必须带 warnings 说「没查成」。
import { describe, expect, beforeEach, afterEach, vi } from 'vitest'
import { it, captureSinks } from '../helpers/capture.js'

const { writeConfigFile, checkPermissions } = vi.hoisted(() => ({
  writeConfigFile: vi.fn(),
  checkPermissions: vi.fn(),
}))

vi.mock('../../src/core/config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/core/config.js')>()
  return { ...mod, writeConfigFile, checkPermissions }
})

import { authCommand } from '../../src/commands/auth.js'
import { WinWriteError } from '../../src/core/win-acl-write.js'

let out = ''
let err = ''
const ORIG_KEY = process.env.QIYU_APP_KEY
const ORIG_SECRET = process.env.QIYU_APP_SECRET

beforeEach(() => {
  out = ''; err = ''
  captureSinks((s) => { out += s }, (s) => { err += s })
  process.env.QIYU_APP_KEY = 'key-sentinel'
  process.env.QIYU_APP_SECRET = 'secret-sentinel'
  writeConfigFile.mockReset()
  checkPermissions.mockReset()
  checkPermissions.mockReturnValue({ ok: true })
})

afterEach(() => {
  if (ORIG_KEY === undefined) delete process.env.QIYU_APP_KEY; else process.env.QIYU_APP_KEY = ORIG_KEY
  if (ORIG_SECRET === undefined) delete process.env.QIYU_APP_SECRET; else process.env.QIYU_APP_SECRET = ORIG_SECRET
})

const login = async (): Promise<number> => authCommand(['login'])
const json = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const errorOf = (): { message: string; hint: string; kind: string } =>
  (json() as { error: { message: string; hint: string; kind: string } }).error

describe('auth login：Windows 写序失败的如实报告', () => {
  it('载荷发出后进程消失 → 结果未知（不得断言已写入或未写入）', async () => {
    writeConfigFile.mockRejectedValue(new WinWriteError('write-secret', 'interrupted', undefined, undefined, undefined, true))
    expect(await login()).toBe(1)
    const e = errorOf()
    expect(e.kind).toBe('config_insecure')
    expect(e.message).toContain('写入结果未知')
    expect(e.message).not.toContain('凭证未写入')
    expect(e.message).not.toContain('凭证已写入')
    expect(e.hint).toContain('复核其 DACL')
  })

  it('换入成功、复核失败 → 已写入（wroteTarget）', async () => {
    writeConfigFile.mockRejectedValue(new WinWriteError('verify-target', 'target-sddl-mismatch'))
    expect(await login()).toBe(1)
    const e = errorOf()
    expect(e.message).toContain('凭证已写入')
    expect(e.message).toContain('target-sddl-mismatch')
    expect(e.hint).toContain('Get-Acl')
  })

  it('换入前失败且有 tmp 残留 → 未写入，并点名残留文件', async () => {
    writeConfigFile.mockRejectedValue(
      new WinWriteError('replace', 'replace-failed', undefined, 'C:\\Users\\t\\.config\\qiyu\\.config.json.tmp-1', true),
    )
    expect(await login()).toBe(1)
    const e = errorOf()
    expect(e.message).toContain('凭证未写入')
    expect(e.hint).toContain('临时文件仍残留')
    expect(e.hint).toContain('.config.json.tmp-1')
  })

  it('写后自检抛异常 → 成功但带 warnings（不能把「没查成」说成「查过且合格」）', async () => {
    writeConfigFile.mockResolvedValue(undefined)
    checkPermissions.mockImplementation(() => { throw new Error('probe output null') })
    expect(await login()).toBe(0)
    const o = json() as { ok: boolean; meta?: { warnings?: string[] } }
    expect(o.ok).toBe(true)
    expect(o.meta?.warnings?.join('\n')).toContain('ACL 自检未完成')
  })
})
