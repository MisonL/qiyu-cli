// tests/commands/local-fallback.test.ts
//
// G1 契约小件：`retry_strategy` / `fallback` 的注入槽与默认提供者。
// 设计稿 §9.1 在限流错误示例里声明过这两个字段，此前零生产者（output.ts:18-25
// 的注释写着「本计划不填」）—— Agent 照文档去找 `retry_strategy`，永远找不到。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setLocalFallbackProvider, localFallbackFor } from '../../src/commands/local-fallback.js'
import {
  buildEndpointTableMap, localFallbackProvider,
} from '../../src/commands/local-fallback-wiring.js'

let home = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qiyu-fb-'))
  setLocalFallbackProvider(undefined)
})
afterEach(() => {
  setLocalFallbackProvider(undefined)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  rmSync(home, { recursive: true, force: true })
})

/** 把配置指向一个临时库路径（存在与否由用例决定）。 */
function pointConfigAt(dbPath: string): void {
  const dir = join(home, '.config', 'qiyu')
  mkdirSync(dir, { recursive: true })
  const p = join(dir, 'config.json')
  writeFileSync(p, JSON.stringify({
    profiles: { default: { store: { path: dbPath } } },
  }))
  // 配置层对 0644 会往 stderr 输出权限警告（C1 行为）；本文件测的是 fallback
  // 映射，不是权限 —— 收紧到 0600 免得每个用例都往测试输出里泼一行噪音。
  chmodSync(p, 0o600)
}

describe('注入槽 local-fallback', () => {
  it('没有提供者时返回 undefined（未接线不是错误）', () => {
    expect(localFallbackFor('ticket.search')).toBeUndefined()
  })

  it('提供者给出表列表时原样返回', () => {
    setLocalFallbackProvider((id) => (id === 'ticket.search' ? { tables: ['tickets'] } : undefined))
    expect(localFallbackFor('ticket.search')).toEqual({ tables: ['tickets'] })
    expect(localFallbackFor('unknown.id')).toBeUndefined()
  })

  it('空表列表视为不可用 —— 不能给出一个指向空泛的 fallback', () => {
    setLocalFallbackProvider(() => ({ tables: [] }))
    expect(localFallbackFor('x')).toBeUndefined()
  })

  it('提供者抛异常时吞掉 —— 探测失败绝不能改变原始限流错误', () => {
    // ⚠️ 这是本模块最重要的不变量：调用方在 `mapThrownToExit` 里，
    // 若探测异常漏出去，一条 14009 会被替换成内部错误（或让进程崩），
    // 而真实原因（限流）彻底消失。变异验证：删掉 catch → 本用例红。
    setLocalFallbackProvider(() => { throw new Error('配置畸形') })
    expect(() => localFallbackFor('ticket.search')).not.toThrow()
    expect(localFallbackFor('ticket.search')).toBeUndefined()
  })
})

describe('默认提供者：endpoint → 本地表映射', () => {
  it('同接口多表都保留，首表在前（ticket.search 路径服务 tickets 与 ticket_logs）', () => {
    const map = buildEndpointTableMap()
    // ⚠️ 这两个任务同走 `ticket.search` 路径（sync/tasks/tickets.ts），
    // 只保留一张表会让 Agent 以为本地只有部分数据。
    expect(map.get('ticket.search')).toEqual(['tickets', 'ticket_logs'])
  })

  it('每个同步任务都贡献一条映射，且表名来自任务声明', () => {
    const map = buildEndpointTableMap()
    expect(map.get('statistic.overview')).toEqual(['daily_overview'])
    expect(map.get('robot.data.knowledge')).toEqual(['knowledge_items'])
    // staff.group.list.new 同样是两任务共用一条路径
    expect(map.get('staff.group.list.new')).toEqual(['staff_groups', 'staff_group_members'])
    // 21 个任务：dim 6 + reports 9 + tickets 2 + sessions 1 + knowledge 3。
    // 去重只发生在**键**上（ticket.search / staff.group.list.new 各被两个任务共用），
    // 表一条不丢。
    const totalTables = [...map.values()].reduce((n, t) => n + t.length, 0)
    expect(totalTables).toBe(21)
  })

  it('库文件不存在 → 不给建议（映射存在还不够）', () => {
    pointConfigAt(join(home, 'nope.duckdb'))
    vi.stubEnv('HOME', home)
    expect(localFallbackProvider('ticket.search')).toBeUndefined()
  })

  it('库路径是目录（不是文件）→ 不给建议', () => {
    const dirPath = join(home, 'adir')
    mkdirSync(dirPath)
    pointConfigAt(dirPath)
    vi.stubEnv('HOME', home)
    expect(localFallbackProvider('ticket.search')).toBeUndefined()
  })

  it('库文件存在且映射命中 → 返回全部表（首表是 fallback 落点）', () => {
    const dbPath = join(home, 'x.duckdb')
    writeFileSync(dbPath, '')
    pointConfigAt(dbPath)
    vi.stubEnv('HOME', home)
    expect(localFallbackProvider('ticket.search')).toEqual({ tables: ['tickets', 'ticket_logs'] })
  })

  it('配置文件畸形（非法 JSON）→ 吞掉异常，不给建议', () => {
    const dir = join(home, '.config', 'qiyu')
    mkdirSync(dir, { recursive: true })
    const p = join(dir, 'config.json')
    writeFileSync(p, '{不是 JSON')
    chmodSync(p, 0o600)
    vi.stubEnv('HOME', home)
    // ⚠️ 配置文件坏了是**另一条**错误路径的全部问题；这里只要求它不污染限流错误。
    expect(() => localFallbackProvider('ticket.search')).not.toThrow()
    expect(localFallbackProvider('ticket.search')).toBeUndefined()
  })

  it('映射里没有该接口 → 不给建议（即使库文件存在）', () => {
    const dbPath = join(home, 'x.duckdb')
    writeFileSync(dbPath, '')
    pointConfigAt(dbPath)
    vi.stubEnv('HOME', home)
    expect(localFallbackProvider('message.send')).toBeUndefined()
  })
})
