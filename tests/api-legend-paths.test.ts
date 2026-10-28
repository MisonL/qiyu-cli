// tests/api-legend-paths.test.ts —— `api schema` / `api list` 的图例键必须是真实输出上的路径
// （2026-10-28，同 PR #38 的缺陷类）。
//
// 背景：`api schema` 的图例把 `auto` 写成顶层裸名，而真实字段在 `params[]` 元素上
// （实测 `data.params[0].auto === true`，`data.auto === undefined`）—— 按图例路径
// `data.auto` 去找什么也找不到。同一条图例里其余键（`dangerous` / `callable` / `path` /
// `body_kind` …）都是 data 的顶层字段，只有 `auto` 混进了一个元素级字段：
// 这正是「图例键是路径」被破坏的形态。
//
// 两个命令的 data 形状不同，核对方式也不同：
//   · `api schema` 的 data 是**对象** → 图例键是路径（`params[].auto` 这类）；
//   · `api list` 的 data 是**根数组** → 图例键只能是行字段名（没有可写的顶层路径），
//     且 `max_window_days` 这类字段只在部分行上存在（未登记上限的行不输出该键）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiCommand } from '../src/commands/api.js'

vi.setConfig({ testTimeout: 30_000 })

let dir = ''
let out = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-apilegend-'))
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('HOME', dir) // 隔离真实 ~
  vi.stubEnv('USERPROFILE', dir)
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const parsed = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const data = (): unknown => parsed().data
const notes = (): Record<string, string> =>
  (parsed().meta as Record<string, unknown>).field_notes as Record<string, string>

/** 路径解析：`a.b` 逐段下钻；`x[]` 段要求该键是数组且**任一元素**能继续走通。 */
function hasPath(root: unknown, path: string): boolean {
  const segs = path.split('.')
  const walk = (cur: unknown, i: number): boolean => {
    if (i === segs.length) return true
    if (cur === null || typeof cur !== 'object') return false
    const tok = segs[i]!
    const isArr = tok.endsWith('[]')
    const key = isArr ? tok.slice(0, -2) : tok
    if (!(key in (cur as object))) return false
    const next = (cur as Record<string, unknown>)[key]
    if (isArr) {
      if (!Array.isArray(next)) return false
      return next.some((el) => walk(el, i + 1))
    }
    return walk(next, i + 1)
  }
  return walk(root, 0)
}

describe('api schema 的图例键必须能在真实输出上解析', () => {
  // 条件键：图例文本已写明「不出现该键 = …」的语义（限频未登记 / 该接口无 oneOf 覆盖）。
  // 它们允许在本接口缺席 —— 所以本用例只对**非条件键**做存在性要求。
  const CONDITIONAL = ['rate_limit', 'one_of']

  it('ticket.search：除条件键外，每个图例键都是 data 上的真实路径', async () => {
    expect(await apiCommand(['schema', 'ticket.search'])).toBe(0)
    for (const k of Object.keys(notes())) {
      if (CONDITIONAL.includes(k)) continue
      expect(hasPath(data(), k), `api schema 图例键 ${k} 在真实输出上不可解析`).toBe(true)
    }
    // 钉死本轮的缺陷：`auto` 是**元素级**字段，只能在 `params[]` 里找到；
    // 写成顶层裸名 `auto` 时 hasPath 会失败（data.auto 不存在）。
    expect(notes()['params[].auto'], 'auto 的图例键必须是 params[].auto').toBeTruthy()
    expect(notes().auto, '不得再写顶层裸名 auto').toBeUndefined()
    expect(hasPath(data(), 'params[].auto'), 'params[] 元素上确实有 auto 字段').toBe(true)
  })

  it('merchant.account.login：条件键 one_of 确实出现时，它也必须是可解析的路径', async () => {
    expect(await apiCommand(['schema', 'merchant.account.login'])).toBe(0)
    // 本接口有 oneOf 覆盖 → 该条件键必须真的出现，且出现在 data 上（而不是只写在图例里）
    expect(hasPath(data(), 'one_of'), '本接口的 one_of 应当出现在 data 上').toBe(true)
    for (const k of Object.keys(notes())) {
      // rate_limit 仍是条件键（本接口未登记限频表）
      if (k === 'rate_limit') continue
      expect(hasPath(data(), k), `api schema 图例键 ${k} 在真实输出上不可解析`).toBe(true)
    }
  })
})

describe('api list 的图例键是行字段（data 是根数组）', () => {
  // `request_schema` 不是行字段：它是「本 meta 不含参数表」的独立说明键
  //（内容本身就写着「不含」，所以它不是一条指向字段的路径，而是一条否定声明）。
  const NOT_ROW_KEYS = ['request_schema']

  it('data 是数组，且每个图例键要么是行字段、要么在部分行上存在', async () => {
    expect(await apiCommand(['list', '--all'])).toBe(0)
    const rows = data() as Array<Record<string, unknown>>
    expect(Array.isArray(rows), 'api list 的 data 是数组').toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    const rowKeys = new Set(rows.flatMap((r) => Object.keys(r)))
    for (const k of Object.keys(notes())) {
      if (NOT_ROW_KEYS.includes(k)) continue
      expect(rowKeys.has(k), `api list 图例键 ${k} 不是行字段（全部行字段：${[...rowKeys].join('、')}）`).toBe(true)
    }
    // 反向：行字段里不能有图例完全没解释的（`id` / `title` / `method` 是自明键）
    const SELF_EVIDENT = ['id', 'title', 'method', 'note']
    for (const k of rowKeys) {
      if (SELF_EVIDENT.includes(k)) continue
      expect(Object.keys(notes()), `api list 行字段 ${k} 没有释义`).toContain(k)
    }
    expect(notes().request_schema, 'request_schema 必须说明参数表不在本 meta').toMatch(/不含|不提供|没有/)
  })
})
