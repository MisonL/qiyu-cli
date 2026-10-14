// tests/commands/sync.test.ts —— D-T12：sync tasks 子命令形态（骨架沿 store.ts）。
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { syncCommand } from '../../src/commands/sync.js'

let out = ''
let err = ''
beforeEach(() => {
  out = ''; err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => { err += s; return true })
})
afterEach(() => { vi.restoreAllMocks() })
const data = (): Record<string, unknown> => JSON.parse(out).data

describe('sync tasks', () => {
  it('输出 21 个任务与 2 个 unsupported 条目', async () => {
    expect(await syncCommand(['tasks'])).toBe(0)
    const d = data()
    const tasks = d.tasks as Array<Record<string, unknown>>
    const unsupported = d.unsupported as Array<Record<string, unknown>>
    expect(tasks.length).toBe(21)
    expect(unsupported).toEqual([
      { id: 'realtime.session', unsupported: 'realtime' },
      { id: 'realtime.ipcc', unsupported: 'realtime' },
    ])
    // 任务条目带 id 与 table（Agent 可直接对回表名）
    const overview = tasks.find((t) => t.id === 'reports.overview')
    expect(overview).toBeDefined()
    expect(overview!.table).toBe('daily_overview')
  })

  it('任务条目不泄漏函数字段（fetch/write/enrich 不进 JSON）', async () => {
    expect(await syncCommand(['tasks'])).toBe(0)
    const tasks = data().tasks as Array<Record<string, unknown>>
    for (const t of tasks) {
      expect(t.fetch).toBeUndefined()
      expect(t.write).toBeUndefined()
      expect(t.enrich).toBeUndefined()
    }
  })
})

describe('sync 用法', () => {
  it('--help 输出用法、退出码 0', async () => {
    expect(await syncCommand(['--help'])).toBe(0)
    expect(out).toMatch(/用法：qiyu sync/)
    expect(out).toMatch(/sync tasks/)
  })

  it('未知子命令 usageFail、退出码 2', async () => {
    expect(await syncCommand(['nope'])).toBe(2)
    expect(JSON.parse(out).error.kind).toBe('usage')
    expect(JSON.parse(out).error.message).toMatch(/未知子命令/)
  })

  it('无子命令输出用法、退出码 0（store.ts 同族惯例：无参数是请求帮助不是错误）', async () => {
    expect(await syncCommand([])).toBe(0)
    expect(out).toMatch(/用法：qiyu sync/)
  })
})
