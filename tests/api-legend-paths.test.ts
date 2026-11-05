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
import { allEndpoints } from '../src/core/registry/index.js'
import { loadParams } from '../src/core/registry/params.js'

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
const metaRaw = (): Record<string, unknown> => (parsed().meta ?? {}) as Record<string, unknown>
const notes = (): Record<string, string> =>
  (parsed().meta as Record<string, unknown>).field_notes as Record<string, string>

/** 图例键可以指向 data **或** meta 的字段（2026-11-04：补了 meta 侧的键）。 */
function resolves(k: string): boolean {
  return hasPath(data(), k) || hasPath(metaRaw(), k)
}

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

  it('ticket.search：除条件键外，每个图例键都是 data 或 meta 上的真实路径', async () => {
    expect(await apiCommand(['schema', 'ticket.search'])).toBe(0)
    for (const k of Object.keys(notes())) {
      if (CONDITIONAL.includes(k)) continue
      expect(resolves(k), `api schema 图例键 ${k} 在真实输出上不可解析`).toBe(true)
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
      expect(resolves(k), `api schema 图例键 ${k} 在真实输出上不可解析`).toBe(true)
    }
  })
})

describe('api list 的图例键是行字段（data 是根数组）', () => {
  // 不指向**行字段**的图例键：
  //  · `request_schema` —— 「本 meta 不含参数表」的独立说明键（见下方 DECLARATION_ONLY）；
  //  · `rows` / `filter` / `registry_complete` / `registry_note` —— **meta 键**
  //    （2026-11-04 补：它们是整份清单的元信息，不在行里）。
  const NOT_ROW_KEYS = ['rows', 'filter', 'registry_complete', 'registry_note']
  // `request_schema` 既不是行字段、也不在 meta 里 —— 它是「本 meta 不含参数表」的
  // 独立否定声明（内容本身就写着「不含」），不是一条指向某字段的路径。
  const DECLARATION_ONLY = ['request_schema']

  it('data 是数组，且每个图例键要么是行字段、要么是 meta 键', async () => {
    expect(await apiCommand(['list', '--all'])).toBe(0)
    const rows = data() as Array<Record<string, unknown>>
    expect(Array.isArray(rows), 'api list 的 data 是数组').toBe(true)
    expect(rows.length).toBeGreaterThan(0)
    const rowKeys = new Set(rows.flatMap((r) => Object.keys(r)))
    for (const k of Object.keys(notes())) {
      if (DECLARATION_ONLY.includes(k)) continue
      if (NOT_ROW_KEYS.includes(k)) {
        expect(Object.keys(metaRaw()), `图例键 ${k} 既不是行字段、meta 里也没有`).toContain(k)
        continue
      }
      expect(rowKeys.has(k), `api list 图例键 ${k} 不是行字段（全部行字段：${[...rowKeys].join('、')}）`).toBe(true)
    }
    // 反向：行字段里不能有图例完全没解释的（`id` / `title` / `method` / `note` 是自明键）
    const SELF_EVIDENT = ['id', 'title', 'method', 'note']
    for (const k of rowKeys) {
      if (SELF_EVIDENT.includes(k)) continue
      expect(Object.keys(notes()), `api list 行字段 ${k} 没有释义`).toContain(k)
    }
    expect(notes().request_schema, 'request_schema 必须说明参数表不在本 meta').toMatch(/不含|不提供|没有/)
  })
})

describe('params[].in 图例与「本 CLI 只有 body 通道」的注册表不变量', () => {
  // 2026-11-04 自查：`params[].in` 图例的初版写成「path = 进路径占位符；header = 进请求头」，
  // 读起来像调用方有这四个通道 —— 而 api call 的 URL 是 `${BASE}${spec.path}?${q}`
  //（不做占位符替换）、headers 只有硬编码 Content-Type（src/core/http.ts）。
  // 图例已改为如实描述「上游协议位置 ≠ 本 CLI 的通道」。
  //
  // 本用例钉住支撑那句图例的**注册表不变量**：可主动调用的接口上，
  // 非 body 参数只可能是 ① 鉴权三件套（query，CLI 自填、标 auto）
  // 或 ② content-type（header，CLI 固定发送）。谁破坏了它，
  // 「非 body 参数没有人工通道」这句话就不再为真，图例必须跟着改。
  const AUTH = new Set(['appKey', 'time', 'checksum'])
  it('callable 接口的非 body 参数 ∈ {鉴权 query 三件套, content-type}（其余接口族群不可主动调用）', () => {
    const offenders: string[] = []
    for (const e of allEndpoints()) {
      if (!e.callable) continue
      for (const p of loadParams(e.id).params) {
        if (p.in === 'body') continue
        const isAuthQuery = p.in === 'query' && AUTH.has(p.name)
        const isContentType = p.in === 'header' && p.name === 'content-type'
        if (!isAuthQuery && !isContentType) offenders.push(`${e.id}: ${p.name} in=${p.in}`)
      }
    }
    expect(offenders, '出现非 body 且非鉴权/非 content-type 的参数时，params[].in 图例需同步改写').toEqual([])
  })

  it('path 参数只出现在不可主动调用的接口上（api call 不做占位符替换）', () => {
    const offenders = allEndpoints()
      .filter((e) => e.callable)
      .filter((e) => loadParams(e.id).params.some((p) => p.in === 'path'))
      .map((e) => e.id)
    expect(offenders).toEqual([])
  })

  it('api schema：type/required 的强制范围都限定 body_kind=json；body_kind 不得再说「原样透传」', async () => {
    // 实测（2026-11-04）：`kefu.add`（xml）传 --body '{}' 不报缺必填；
    // `--body '<xml>'` 直接 exit 2（CLI 恒 JSON.stringify）。旧图例两处都反着说。
    expect(await apiCommand(['schema', 'ticket.search'])).toBe(0)
    const n = notes()
    expect(n['params[].type'], 'type 比对范围必须限定 body_kind=json').toContain('body_kind=json')
    expect(n['params[].required'], 'required 强制范围必须限定 body_kind=json').toContain('body_kind=json')
    expect(n['params[].required'], '非 json bodyKind 必须点明不做必填检查').toContain('非 json bodyKind')
    expect(n['params[].required'], '入站接口的鉴权字段不能被说成由 CLI 自填').toContain('入站接口')
    expect(n.body_kind, '必须点明非 JSON 编码无法通过本 CLI 表达').toContain('无法通过本 CLI 表达')
    expect(n.body_kind, '旧说法「原样透传」不得复活').not.toContain('原样透传')
  })

  it('api list：verified 不得把「实测范围」全指给 note；path 的 null 必伴随 callable=false', async () => {
    // 实测：53 条 verified:true 里 42 条没有 note —— 旧图例让 Agent「以该行 note 为准」，
    // 而多数行没有 note 可读。path 图例说 null 仍可能 callable，加载器却禁止该组合。
    expect(await apiCommand(['list'])).toBe(0)
    const n = notes()
    expect(n.verified, '没有 note 时必须给出唯一含义').toContain('没有 note')
    // receive.message 的 verified:true 只验证了「不可调用」，没有成功响应 ——
    // 把 true 定义成「成功响应被观测」会让这行变成谎报。
    expect(n.verified, 'verified 不得被定义成「成功响应一定被观测过」').not.toContain('至少观测到一次成功响应')
    expect(n.verified).toContain('不是「成功路径一定走通过」')
    expect(n.path, 'null 路径与 callable=false 的强制关系必须说明').toContain('必然伴随 callable=false')
  })

  it('api call：warnings 不得列 missing_required；not_found 必须覆盖 message 载体与宽松模式', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k'); vi.stubEnv('QIYU_APP_SECRET', 's')
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(
      JSON.stringify({ code: 200, message: '{"total":0,"tickets":[]}' }),
      { status: 200, headers: { 'content-type': 'application/json' } }))))
    expect(await apiCommand(['call', 'ticket.search', '--body', '{}'])).toBe(0)
    const n = notes()
    // 图例**必须**提到这个词（否则 Agent 会去找它），但只能出现在否定句里，
    // 不能出现在「如 ……」的示例清单里。
    expect(n.warnings, 'missing_required 不得被列为 warnings 的示例 kind').not.toMatch(/如 `[^）]*missing_required/)
    expect(n.warnings).toContain('永远不会出现在这里')
    expect(n.not_found, 'message 载体（形状 C / 宽松模式）必须写进判据').toContain('message 能解析成 JSON')
    expect(n.not_found, '宽松模式不区分是否已实测').toContain('宽松模式')
    // 形状 C 的「无 message」在 normalize 里是失败（C 分支先解析 message、走不到末尾兜底），
    // 不能被列进「整条 200 无载荷键 → not_found」的接口族。
    expect(n.not_found, 'C 不得出现在末尾兜底的接口族里').toContain('形状 C 不在此列')
    expect(n.not_found).not.toContain('A/B/C/D-nf')
    vi.unstubAllGlobals()
  })

  it('图例本身不得再声称 path/header 通道（2026-11-04 自查的旧说法）', async () => {
    expect(await apiCommand(['schema', 'ticket.search'])).toBe(0)
    const n = notes()
    // 旧说法：把 in 描述成「该参数放哪里」，等于承诺了四个传参通道。
    expect(n['params[].in'], '不得再写「进路径占位符」这类通道承诺').not.toContain('进路径占位符')
    expect(n['params[].in'], '不得再写「进请求头」这类通道承诺').not.toContain('进请求头')
    expect(n['params[].in'], '必须点明本 CLI 不做占位符替换').toContain('不做占位符替换')
    expect(n['params[].required'], 'required 的强制范围必须限定在 body 参数').toContain('`body_kind=json` 且 `in=body`')
    expect(n['params[].type'], 'type 比对范围必须限定在 body 参数').toContain('`body_kind=json`')
  })
})
