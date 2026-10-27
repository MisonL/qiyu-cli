// tests/api-call-field-notes.test.ts —— `api call` 的 meta 图例（2026-10-28）。
//
// 为什么单独一条：`api call` 的 `data` 是**上游载荷**（按信封形状取 data/result/staffInfo），
// 与其余命令的 `data`（CLI 自己的契约）不是一回事。`not_found` 只覆盖**结构性为空**，
// 是 Agent 最容易误读成「有数据」的地方。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiCommand } from '../src/commands/api.js'
import { callFieldNotes } from '../src/commands/api-notes.js'

vi.setConfig({ testTimeout: 30_000 })

let dir = ''
let out = ''
let err = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-apinotes-'))
  out = ''
  err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((x) => { err += x; return true })
  vi.stubEnv('HOME', dir) // 隔离真实 ~
  vi.stubEnv('USERPROFILE', dir) // Windows 的 os.homedir() 读它
  vi.stubEnv('QIYU_PROFILE', '')
  vi.stubEnv('QIYU_APP_KEY', 'k-test')
  vi.stubEnv('QIYU_APP_SECRET', 's-test')
})
afterEach(() => {
  vi.restoreAllMocks()
  // 与 tests/commands/api.test.ts 同款：stubBody 装的 fetch 是**全局**替身，
  // restoreAllMocks 不管它 —— 不显式清掉会漏给同 worker 的后续用例。
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const envelope = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const meta = (): Record<string, unknown> => envelope().meta as Record<string, unknown>
const notes = (): Record<string, string> => meta().field_notes as Record<string, string>

/** 按上游信封形状打桩：`data` 形状（ticket.search）与 `result` 形状（tag.all）不同。 */
function stubBody(body: unknown): void {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
    JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } }))))
}

/** 图例键里只有这些是条件键（可能不出现）。 */
const CONDITIONAL = ['warnings', 'not_found', 'warning', 'note']

describe('api call 的图例与真实输出', () => {
  it('成功响应：非条件键都在输出里，meta 的每个键都有释义（双向）', async () => {
    stubBody({ code: 200, message: JSON.stringify({ total: 1, tickets: [{ id: 1 }] }) })
    expect(await apiCommand(['call', 'ticket.search']), out.slice(0, 400)).toBe(0)
    const legend = Object.keys(callFieldNotes())
    // 正向：非条件键必须真实存在（data 在信封顶层，其余在 meta）
    expect(Object.keys(envelope()), 'data 必须在信封顶层').toContain('data')
    expect(meta().endpoint).toBe('ticket.search')
    for (const k of legend) {
      if (CONDITIONAL.includes(k)) continue
      const present = k === 'data' ? 'data' in envelope() : k in meta()
      expect(present, `图例键 ${k} 不在输出里`).toBe(true)
    }
    // 反向：meta 的每个键（field_notes 自身除外）都要有释义
    for (const k of Object.keys(meta())) {
      if (k === 'field_notes') continue
      expect(legend, `meta.${k} 没有释义`).toContain(k)
    }
  })

  it('ticket.search 有注册表 note：note 出现，图例解释它是静态说明', async () => {
    stubBody({ code: 200, message: JSON.stringify({ total: 0, tickets: [] }) })
    expect(await apiCommand(['call', 'ticket.search']), out.slice(0, 400)).toBe(0)
    expect(meta().note, 'ticket.search 的 note 必须透出').toBeTruthy()
    expect(notes().note, 'note 的释义必须点明是静态说明').toContain('静态说明')
  })

  it('结构上为空 → not_found + warning；图例点明业务为空不会置位', async () => {
    // tag.all 是 result 形状（信封 B）；空 result 判 notFound。
    stubBody({ code: 200, result: {} })
    expect(await apiCommand(['call', 'tag.all']), out.slice(0, 400)).toBe(0)
    expect(meta().not_found).toBe(true)
    expect(meta().warning).toBeTruthy()
    expect(notes().not_found, '必须点明业务为空不置位').toContain('没有 not_found 不等于有数据')
    expect(notes().not_found, '判据必须说清作用在解包后的 payload 上').toContain('判据作用在解包后的 payload 上')
    expect(notes().not_found).toContain('业务为空')
  })

  it('--no-validate：warnings 不出现，图例仍解释它', async () => {
    stubBody({ code: 200, message: JSON.stringify({ total: 0, tickets: [] }) })
    expect(await apiCommand(['call', 'ticket.search', '--no-validate']), out.slice(0, 400)).toBe(0)
    expect(meta().warnings).toBeUndefined()
    expect(notes().warnings, '--no-validate 的省略必须写明').toContain('--no-validate 时恒不出现')
  })

  it('data 的释义必须点明是上游载荷、不要按其他命令的形状推断', () => {
    expect(callFieldNotes().data).toContain('原样透传')
    expect(callFieldNotes().data).toContain('不要按其他命令 data 的形状推断')
  })

  it('图例不带 `**`、正文不含分隔符 `；`', () => {
    for (const [k, v] of Object.entries(callFieldNotes())) {
      expect(v, `${k} 含 **`).not.toContain('**')
      expect(v, `${k} 含分隔符 ；`).not.toContain('；')
    }
  })
})
