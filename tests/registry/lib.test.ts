import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { parsePage, fixPath, deriveId, extractParams, validateOverrides, applyOverrides, reconcile } from '../../scripts/registry/lib.mjs'

const pageUrl = (id: string) => new URL(`../fixtures/registry/pages/api-${id}.md`, import.meta.url)
const load = (id: string) => readFileSync(pageUrl(id), 'utf8')

describe('parsePage', () => {
  it('参数描述会脱敏固定长度的 appKey，但保留普通描述', () => {
    const raw = parsePage('```yaml\npaths:\n  /x:\n    post:\n      summary: 测试\n      parameters:\n        - name: a\n          in: query\n          description: 企业的appKey，0123456789abcdef0123456789abcdef\n        - name: b\n          in: query\n          description: 普通描述，最多 32 个字符\n      responses: {}\n```', 'api-test')
    expect(raw.params[0].description).toBe('企业的appKey')
    expect(raw.params[0].description).not.toContain('0123456789abcdef')
    expect(raw.params[1].description).toBe('普通描述，最多 32 个字符')
  })



  it('普通 POST：summary 作 title、path 原样、folder 取 x-apifox-folder 的完整层级', () => {
    const r = parsePage(load('10845434'), 'api-10845434')
    expect(r.title).toBe('获取SDK接入地址')
    expect(r.method).toBe('POST')
    expect(r.path).toBe('/openapi/staff/login')
    expect(r.folder).toBe('通用说明/服务端登录')
    expect(r.pageId).toBe('api-10845434')
  })

  it('唯一 GET 接口：method 归一为大写 GET', () => {
    const r = parsePage(load('10845435'), 'api-10845435')
    expect(r.method).toBe('GET')
    expect(r.path).toBe('/get_token')
    expect(r.folder).toBe('CRM 对接/CRM 接口对接')
  })

  it('params 含 query 与 body 字段（body 取 requestBody 里第一个 content 的 schema）', () => {
    const r = parsePage(load('10845572'), 'api-10845572')
    const q = r.params.filter((p: any) => p.in === 'query')
    expect(q.map((p: any) => p.name)).toEqual(['appKey', 'time', 'checksum'])
    expect(q.every((p: any) => p.required)).toBe(true)
    const body = r.params.filter((p: any) => p.in === 'body')
    expect(body.map((p: any) => p.name)).toEqual(['status'])
    expect(body[0].required).toBe(true)
    expect(body[0].type).toBe('integer')
  })

  it('中文 description 原样保留（枚举往往只写在描述里，不是 enum）', () => {
    const r = parsePage(load('10845572'), 'api-10845572')
    expect(r.params.find((p: any) => p.name === 'status')?.description).toContain('模板状态')
  })

  it('page 内嵌 ```text / ```json 围栏时，YAML 不得被截断（10845443 回归）', () => {
    const r = parsePage(load('10845443'), 'api-10845443')
    expect(r.folder, 'folder 丢失 = YAML 被截断').toBe('客户管理/客户标签')
    expect(r.params.map((p: any) => p.name)).toEqual(['appKey', 'time', 'checksum'])
    expect(r.responseShape.kind).toBe('object')
  })

  it('parameters 为空的页面，params 仍含 body 字段（10845543）', () => {
    const r = parsePage(load('10845543'), 'api-10845543')
    expect(r.params.map((p: any) => p.name)).toEqual(['robotId'])
    expect(r.params[0].in).toBe('body')
    expect(r.params[0].required).toBe(true)
  })

  it('security 恒为空数组 —— 解析器不得据此推断 auth', () => {
    expect(parsePage(load('10845434'), 'api-10845434').security).toEqual([])
  })

  it('paths 键数 != 1 时抛错 —— 静默取第一条会吞掉接口', () => {
    const md = load('10845434').replace(/^  \/openapi\/staff\/login:$/m,
      '  /openapi/a:\n  /openapi/b:')
    expect(() => parsePage(md, 'api-10845434')).toThrow(/paths 键数/)
  })

  it('无 yaml 块时抛错', () => {
    expect(() => parsePage('# 只有标题', 'api-00000000')).toThrow(/yaml/)
  })

  it('method 不是 POST/GET 时抛错（150 页实测只有这两种）', () => {
    const md = load('10845434').replace(/^    post:$/m, '    put:')
    expect(() => parsePage(md, 'api-10845434')).toThrow(/意外 method/)
  })
})

describe('fixPath', () => {
  it('双斜杠 → 折叠为单斜杠', () => {
    expect(fixPath('//openapi/v2/ticket/template/list'))
      .toEqual({ path: '/openapi/v2/ticket/template/list', rule: 'double-slash' })
  })

  it('含 method+origin → 去掉前缀，保留 URL 的 pathname', () => {
    expect(fixPath('/POST https://qiyukf.com/platform/api/openapi/merchant/account/login'))
      .toEqual({ path: '/platform/api/openapi/merchant/account/login', rule: 'method-origin' })
  })

  it('双 /openapi/ 前缀 → 折叠（10845542 实测）', () => {
    expect(fixPath('/openapi/openapi/ai/statistic/transferHuman'))
      .toEqual({ path: '/openapi/ai/statistic/transferHuman', rule: 'double-openapi' })
  })

  it('入站占位符 / 原样保留（是合法 path，不是异常）', () => {
    expect(fixPath('/')).toEqual({ path: '/', rule: null })
  })

  it('模板占位符 path → null', () => {
    expect(fixPath('/{modify_cb}')).toEqual({ path: null, rule: 'placeholder' })
    expect(fixPath('/{path}')).toEqual({ path: null, rule: 'placeholder' })
  })

  it('中文散文 → null（含空白/汉字即判散文）', () => {
    expect(fixPath('/**简要描述：**  - 针对企业微信切换机器人场景 **频率限制：** - 1次/秒'))
      .toEqual({ path: null, rule: 'prose' })
  })

  it('正常 path → rule 为 null，path 原样', () => {
    expect(fixPath('/openapi/staff/login')).toEqual({ path: '/openapi/staff/login', rule: null })
  })
})

describe('deriveId', () => {
  it('剥 /openapi/ 前缀、剥 /vN 版本段、其余 / → .', () => {
    expect(deriveId('/openapi/v2/ticket/search')).toBe('ticket.search')
    expect(deriveId('/openapi/message/send')).toBe('message.send')
    expect(deriveId('/openapi/ai/knowledge/deleteKnowledges')).toBe('ai.knowledge.deleteKnowledges')
  })

  it('只剥**开头**的 /vN —— 中段的 v2 保留（与 kefu.v2.query 一致）', () => {
    expect(deriveId('/openapi/kefu/v2/query')).toBe('kefu.v2.query')
    expect(deriveId('/openapi/v2/staff/group/members/new')).toBe('staff.group.members.new')
  })

  it('平台电商路径剥 /platform/api/openapi/ 前缀', () => {
    expect(deriveId('/platform/api/openapi/merchant/update')).toBe('merchant.update')
  })

  it('无前缀的 CRM 回调路径原样（/get_*）', () => {
    expect(deriveId('/get_token')).toBe('get_token')
  })

  it('null 与不可派生形态返回 null（须由 ids.json 显式给 id）', () => {
    expect(deriveId(null)).toBeNull()
    expect(deriveId('/{modify_cb}')).toBeNull()
  })
})

describe('extractParams', () => {
  const raw = (id: string) => parsePage(load(id), `api-${id}`)

  it('application/json → json', () => {
    expect(extractParams(raw('10845572')).bodyKind).toBe('json')
  })
  it('application/x-www-form-urlencoded → form', () => {
    expect(extractParams(raw('10845438')).bodyKind).toBe('form')
  })
  it('application/xml → xml', () => {
    expect(extractParams(raw('10845447')).bodyKind).toBe('xml')
  })
  it('multipart/form-data → multipart', () => {
    expect(extractParams(raw('10845468')).bodyKind).toBe('multipart')
  })
  it('text/plain → text', () => {
    expect(extractParams(raw('10845496')).bodyKind).toBe('text')
  })
  it('无 requestBody → none（样本集里没有"无 requestBody"的页，就地构造）', () => {
    const r = raw('10845572')
    expect(extractParams({ ...r, op: {} }).bodyKind).toBe('none')
  })
  it('未知 content-type → 抛错，不得静默当作 none', () => {
    const r = raw('10845572')
    const mutated = { ...r, op: { requestBody: { content: { 'application/msgpack': { schema: {} } } } } }
    expect(() => extractParams(mutated)).toThrow(/未知 requestBody content-type/)
  })
  it('params 原样透传（body 字段已由 parsePage 归入 params）', () => {
    expect(extractParams(raw('10845572')).params.map((p) => p.name))
      .toEqual(['appKey', 'time', 'checksum', 'status'])
  })
})

describe('validateOverrides', () => {
  const pages = new Set(['api-1', 'api-2'])

  it('未知 pageId → 抛错（ids.json / paths.json）', () => {
    expect(() => validateOverrides({ ids: { 'api-9': 'x' }, attrs: {}, paths: {} }, pages))
      .toThrow(/未知 pageId/)
    expect(() => validateOverrides({ ids: {}, attrs: {}, paths: { 'api-9': null } }, pages))
      .toThrow(/未知 pageId/)
  })

  it('paths.json 的值必须是 null 或以 / 开头的字符串', () => {
    expect(() => validateOverrides({ ids: {}, attrs: {}, paths: { 'api-1': 'openapi/x' } }, pages))
      .toThrow(/paths.json/)
  })

  it('envelope 必须是 A/B/C/D/D-nf 之一', () => {
    expect(() => validateOverrides({ ids: {}, paths: {}, attrs: { x: { envelope: 'E' } } }, pages))
      .toThrow(/envelope/)
  })

  it('envelope 非 null 时 verified 必须为 true', () => {
    expect(() => validateOverrides({ ids: {}, paths: {}, attrs: { x: { envelope: 'A' } } }, pages))
      .toThrow(/verified/)
  })

  it('合法的三张表通过', () => {
    expect(() => validateOverrides(
      { ids: { 'api-1': 'a.b' }, paths: { 'api-2': null },
        attrs: { 'a.b': { dangerous: true, envelope: 'A', verified: true } } },
      new Set(['api-1', 'api-2']),
    )).not.toThrow()
  })
})

const TABLES = { ids: {}, paths: {}, attrs: {} }

describe('applyOverrides', () => {
  it('默认 fail-closed：未 override 的出站接口 dangerous 为 true', () => {
    const { spec } = applyOverrides(parsePage(load('10845443'), 'api-10845443'), TABLES)
    expect(spec).toMatchObject({
      id: 'tag.all', pageId: 'api-10845443', title: '获取客户标签信息',
      method: 'POST', path: '/openapi/tag/all', direction: 'outbound',
      callable: true, dangerous: true, auth: 'checksum', verified: false, envelope: null,
      category: '客户管理/客户标签',
    })
  })

  it('ids.json 覆盖 id（{modify_cb} 推导不出 id）', () => {
    const { spec } = applyOverrides(parsePage(load('10845438'), 'api-10845438'), {
      ids: { 'api-10845438': 'crm.modifyUser' }, paths: { 'api-10845438': null }, attrs: {},
    })
    expect(spec.id).toBe('crm.modifyUser')
    expect(spec.path).toBeNull()
    expect(spec.callable).toBe(false)
  })

  it('共享 path 上未显式给 id 时推导撞车 → 抛错', () => {
    const a = parsePage(load('10845464'), 'api-10845464')
    expect(() => applyOverrides(a, { ids: {}, paths: {}, attrs: {} }, new Set(['message.send'])))
      .toThrow(/id 冲突/)
  })

  it('入站覆盖生效：direction/callable/auth', () => {
    const { spec } = applyOverrides(parsePage(load('10845467'), 'api-10845467'), {
      ids: { 'api-10845467': 'receive.message' }, paths: {},
      attrs: { 'receive.message': { direction: 'inbound', callable: false, auth: 'eventType' } },
    })
    expect(spec).toMatchObject({ direction: 'inbound', callable: false, auth: 'eventType' })
  })

  it('与现有 specs.json 的 11 条骨架**逐字段一致**（attrs 搬运无误差的回归）', () => {
    // ⚠️ 这条把 attrs.json 里"照抄骨架"的部分钉死：note 文本、envelope、verified、
    // maxWindowDays、auth、dangerous、direction、callable 一个有出入就红。
    // 骨架的 4 条 note 断言（robotId/3500/validitySwitch/envelope）正挂在这些字段上。
    //
    // 做法：给每条骨架造一个 pageId（`skeleton:<id>`），用 ids.json 合成键强制 id、
    // 用 paths.json 合成键强制 null path（wecom 的 path 是 null），attrs 用真实的
    // attrs.json —— 走的就是生产管线，比逐字段手抄断言可靠。
    const realSpecs = JSON.parse(readFileSync(
      new URL('../../src/core/registry/specs.json', import.meta.url), 'utf8')) as Array<Record<string, any>>
    const realAttrs = JSON.parse(readFileSync(
      new URL('../../src/core/registry/overrides/attrs.json', import.meta.url), 'utf8'))
    for (const old of realSpecs) {
      const key = `skeleton:${old.id}`
      const raw = {
        pageId: key, title: old.title, method: old.method,
        path: old.path ?? `/{${old.id}}`, folder: null,
        params: [], responseShape: { kind: 'object' as const }, security: [], op: {},
      }
      const tables = {
        ids: { [key]: old.id },
        paths: old.path === null ? { [key]: null } : {},
        attrs: realAttrs,
      }
      const { spec } = applyOverrides(raw, tables) as { spec: Record<string, unknown> }
      for (const k of ['id','title','method','path','direction','callable','dangerous',
                       'auth','verified','envelope','maxWindowDays','note']) {
        expect(spec[k], `${old.id} 的 ${k} 变了`).toEqual(old[k])
      }
    }
  })
})

describe('reconcile', () => {
  const mk = (id: string, path: string | null, ...extra: object[]) =>
    ({ id, pageId: 'p', title: 't', method: 'POST', path, direction: 'outbound',
       callable: true, dangerous: false, auth: 'checksum', verified: false, envelope: null, ...Object.assign({}, ...extra) })

  it('同一 path 上两个 id 限频不同 → 报错（令牌桶按 path 缓存）', () => {
    const specs = [mk('a.b', '/x'), mk('a.c', '/x')]
    const { errors } = reconcile(specs, { 'a.b': { limit: 1, windowSeconds: 1, source: 'observed' } })
    expect(errors.join('\n')).toMatch(/同 path 限频不一致/)
    // 设计稿验收判据 4 要求「失败并**打印差异**」—— 错误里必须列出各 id 的具体档位，
    // 否则最关键的诊断信息缺失而无人察觉。
    expect(errors.join('\n')).toContain('"limit":1')
    expect(errors.join('\n')).toContain('a.c=null')
  })

  it('限频表里有、注册表里没有的 id → 报错', () => {
    const { errors } = reconcile([mk('a.b', '/x')], { 'a.b': null, 'a.zzz': null })
    expect(errors.join('\n')).toMatch(/RATE_LIMITS 的 id 不在注册表里/)
  })

  it('一致时无错', () => {
    const { errors } = reconcile([mk('a.b', '/x'), mk('a.c', '/x')], { 'a.b': null, 'a.c': null })
    expect(errors).toEqual([])
  })
})
