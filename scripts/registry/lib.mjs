// 注册表生成器的纯函数层：无 I/O、无网络，测试直接 import。
import { parse as yamlParse } from 'yaml'

/**
 * @typedef {Object} ParamSpec
 * @property {string} name
 * @property {'query'|'header'|'body'|'path'} in
 * @property {boolean} required
 * @property {string} type
 * @property {string} description
 * @property {string} [example]
 */

/**
 * @typedef {Object} RawEndpoint
 * @property {string} pageId
 * @property {string} title
 * @property {'POST'|'GET'} method
 * @property {string} path
 * @property {string|null} folder
 * @property {ParamSpec[]} params
 * @property {{kind:'object'|'array'|'primitive'|'none', description?:string}} responseShape
 * @property {unknown[]} security
 * @property {Record<string, unknown>} op 原始 OpenAPI operation
 */

function extractYaml(md) {
  const match = /^```yaml\n([\s\S]*?)^```$/m.exec(md)
  if (!match) throw new Error('页面缺 ```yaml 块')
  return match[1]
}

function sanitizeDescription(description) {
  return String(description).replace(/[，,]\s*[0-9a-f]{32}\b/gi, '')
}

function toParamSpec(param) {
  const schema = param.schema ?? {}
  return {
    name: param.name,
    in: param.in,
    required: !!param.required,
    type: schema.type ?? 'string',
    description: sanitizeDescription(param.description ?? ''),
    ...(param.example !== undefined ? { example: String(param.example) } : {}),
  }
}

function firstBodySchema(operation) {
  const content = operation?.requestBody?.content ?? {}
  return Object.values(content)[0]?.schema ?? null
}

/**
 * 从 Apifox 页面 markdown 同步解析出 RawEndpoint。
 * @returns {RawEndpoint}
 */
export function parsePage(md, pageId) {
  const doc = yamlParse(extractYaml(md))
  const pathKeys = Object.keys(doc.paths ?? {})
  if (pathKeys.length !== 1) {
    throw new Error(`${pageId}: paths 键数 ${pathKeys.length} ≠ 1 —— 无法确定该页对应哪个接口`)
  }
  const path = pathKeys[0]
  const methods = Object.keys(doc.paths[path] ?? {})
  if (methods.length !== 1) {
    throw new Error(`${pageId}: path ${path} 上有 ${methods.length} 个 method —— 预期 1 个`)
  }
  const method = methods[0].toUpperCase()
  if (method !== 'POST' && method !== 'GET') {
    throw new Error(`${pageId}: 意外 method ${method} —— 150 页实测只有 POST/GET`)
  }
  const op = doc.paths[path][methods[0]]
  const params = (op.parameters ?? []).map(toParamSpec)
  const body = firstBodySchema(op)
  for (const [name, schema] of Object.entries(body?.properties ?? {})) {
    params.push({
      name,
      in: 'body',
      required: (body.required ?? []).includes(name),
      type: schema.type ?? 'string',
      description: sanitizeDescription(schema.description ?? ''),
      ...(schema.example !== undefined ? { example: String(schema.example) } : {}),
    })
  }

  const response = op.responses?.['200']?.content?.['application/json']?.schema
  const responseShape = response
    ? {
        kind: response.type === 'array' ? 'array' : response.type === 'object' || response.type === undefined ? 'object' : 'primitive',
        ...(response.description ? { description: response.description } : {}),
      }
    : { kind: 'none' }

  return {
    pageId,
    title: op.summary ?? /^# (.+)$/m.exec(md)?.[1] ?? '',
    method,
    path,
    folder: op['x-apifox-folder'] ?? null,
    params,
    responseShape,
    security: doc.security ?? [],
    op,
  }
}

const BODY_KINDS = {
  'application/json': 'json',
  'application/x-www-form-urlencoded': 'form',
  'multipart/form-data': 'multipart',
  'application/xml': 'xml',
  'text/plain': 'text',
}

/**
 * 判定 requestBody 的种类。
 *
 * ⚠️ 实测 150 页里 body 有 6 种形态（json 138 / 无 requestBody 6 / form 2 /
 * multipart 2 / xml 1 / text 1）。**未知 content-type 必须抛错** —— 静默归为
 * `none` 会让一个"参数在别的 content-type 里"的接口看起来像没有 body。
 *
 * @param {RawEndpoint} raw
 */
export function extractParams(raw) {
  const content = raw.op?.requestBody?.content ?? {}
  const types = Object.keys(content)
  if (types.length === 0) return { params: raw.params, bodyKind: 'none' }
  if (types.length > 1) {
    throw new Error(`${raw.pageId}: requestBody 有 ${types.length} 种 content-type（${types.join(', ')}）—— 实测每页只有 0 或 1 种`)
  }
  const bodyKind = BODY_KINDS[types[0]]
  if (!bodyKind) {
    throw new Error(`${raw.pageId}: 未知 requestBody content-type「${types[0]}」—— 不得静默当作 none`)
  }
  return { params: raw.params, bodyKind }
}

/**
 * 修复文档页里畸形的 path。
 *
 * ⚠️ 判定**有次序**：`method-origin` 必须排在"含空白即散文"之前 ——
 * origin 形态的 path（`/POST https://…`）本身就含空格，先判散文会把它误杀成 null。
 *
 * 规则（实测清单，设计稿 §5）：
 * - `/`            → 原样（入站占位符，是合法 path，不是异常）
 * - `/{…}`         → null（模板占位符，真实路径由调用方运行时决定）
 * - `//…`          → 折叠为单斜杠
 * - `/<METHOD> <URL>` → 取 URL 的 pathname
 * - 含空白或汉字    → null（中文散文，不可恢复）
 * - `/openapi/openapi/…` → 折叠重复前缀
 */
export function fixPath(path) {
  if (path === '/') return { path: '/', rule: null }
  if (path.startsWith('/{')) return { path: null, rule: 'placeholder' }
  if (path.startsWith('//')) return { path: path.replace(/\/{2,}/g, '/'), rule: 'double-slash' }
  const mo = /^\/(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS)\s+(https?:\/\/\S+)$/.exec(path)
  if (mo) return { path: new URL(mo[2]).pathname, rule: 'method-origin' }
  if (/[\s\p{Script=Han}]/u.test(path)) return { path: null, rule: 'prose' }
  if (!path.startsWith('/')) return { path: null, rule: 'prose' }
  if (path.startsWith('/openapi/openapi/')) {
    return { path: path.replace(/^\/openapi\/openapi\//, '/openapi/'), rule: 'double-openapi' }
  }
  return { path, rule: null }
}

/**
 * 从（已修复的）path 派生 id。派生不出合法 id 时返回 null —— 该页必须由
 * `ids.json` 显式给 id，生成器对 null 抛错（不静默丢接口）。
 *
 * 规则：剥 `/platform/api/openapi/` 或 `/openapi/` 前缀 → 剥开头的 `/vN/` →
 * 其余 `/` 换成 `.`。安全性由白名单字符集兜底：出现 `{`、汉字、空格等即拒绝。
 */
export function deriveId(path) {
  if (!path) return null
  const p = path
    .replace(/^\/platform\/api\/openapi\//, '/')
    .replace(/^\/openapi\//, '/')
    .replace(/^\/v\d+\//, '/')
    .replace(/^\//, '')
    .split('/')
    .join('.')
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*$/.test(p)) return null
  return p
}

const ENVELOPES = ['A', 'B', 'C', 'D', 'D-nf']

/**
 * 校验三张 override 表与当前页面集合一致。**未知键一律抛错** —— 静默忽略
 * 会让"我以为改了"与"实际没改"无法区分，而那正是本计划要消灭的形态。
 *
 * @param {{ids:Record<string,string>, paths:Record<string,string|null>, attrs:Record<string,object>}} tables
 * @param {Set<string>} knownPageIds
 * @param {Set<string>} [knownIds] 已知 id（默认只校验 attrs 的 envelope/verified 形状）
 */
export function validateOverrides(tables, knownPageIds, knownIds) {
  for (const [pageId, id] of Object.entries(tables.ids ?? {})) {
    if (!knownPageIds.has(pageId)) throw new Error(`ids.json 含未知 pageId：${pageId}`)
    if (typeof id !== 'string' || !id) throw new Error(`ids.json[${pageId}] 的 id 必须是非空字符串`)
  }
  for (const [pageId, p] of Object.entries(tables.paths ?? {})) {
    if (!knownPageIds.has(pageId)) throw new Error(`paths.json 含未知 pageId：${pageId}`)
    if (p !== null && (typeof p !== 'string' || !p.startsWith('/'))) {
      throw new Error(`paths.json[${pageId}] 只能是 null 或以 / 开头的字符串`)
    }
  }
  for (const [id, a] of Object.entries(tables.attrs ?? {})) {
    if (knownIds && !knownIds.has(id)) throw new Error(`attrs.json 含未知 id：${id}`)
    if (a.envelope !== undefined && a.envelope !== null && !ENVELOPES.includes(a.envelope)) {
      throw new Error(`attrs.json[${id}] 的 envelope 非法：${a.envelope}`)
    }
    if (a.envelope !== undefined && a.envelope !== null && a.verified !== true) {
      throw new Error(`attrs.json[${id}] 登记了 envelope 却未标 verified:true —— 没实测过就不该登记形状`)
    }
  }
}

/** EndpointSpec 的字段顺序 —— 固定顺序才有稳定的 diff。 */
const FIELD_ORDER = ['id','pageId','title','method','path','direction','callable','dangerous',
                     'auth','verified','envelope','maxWindowDays','category','note']

/**
 * @typedef {Object} GeneratedSpec
 * @property {string} id
 * @property {string} [pageId]
 * @property {string} title
 * @property {'POST'|'GET'} method
 * @property {string|null} path
 * @property {'outbound'|'inbound'} direction
 * @property {boolean} callable
 * @property {boolean} dangerous
 * @property {'checksum'|'eventType'|'none'} auth
 * @property {boolean} verified
 * @property {'A'|'B'|'C'|'D'|'D-nf'|null} envelope
 * @property {number} [maxWindowDays]
 * @property {string|null} [category]
 * @property {string} [note]
 * @property {unknown} [key]
 */

/**
 * 把一个 RawEndpoint 合成为注册表条目。
 *
 * **默认值刻意选成 fail-closed 的那一侧**：`dangerous:true`、`auth:'checksum'`、
 * `envelope:null`、`verified:false`。人工 override 只能把它们往"更宽松"改，
 * 且每一处放宽都在 attrs.json 里有据可查。
 *
 * @param {RawEndpoint} raw
 * @param {{ids:Record<string,string>, paths:Record<string,string|null>, attrs:Record<string,object>}} tables
 * @param {Set<string>} [usedIds] 已占用的 id（用于冲突检测）
 * @returns {{spec: GeneratedSpec, params:ParamSpec[], bodyKind:string}}
 */
export function applyOverrides(raw, tables, usedIds = new Set()) {
  const fixed = tables.paths && Object.hasOwn(tables.paths, raw.pageId)
    ? { path: tables.paths[raw.pageId], rule: 'override' }
    : fixPath(raw.path)

  const id = tables.ids?.[raw.pageId] ?? deriveId(fixed.path)
  if (!id) throw new Error(`${raw.pageId}: 派生不出 id，且 ids.json 未显式给出`)
  if (usedIds.has(id)) throw new Error(`id 冲突：${id} 被 ${raw.pageId} 与另一页共用 —— 共享 path 必须显式命名`)
  usedIds.add(id)

  const a = tables.attrs?.[id] ?? {}
  const direction = a.direction ?? 'outbound'
  const callable = a.callable ?? (direction === 'outbound' && fixed.path !== null)
  // ⚠️ fail-closed：不给 danger 就是 true。设计稿 §5.4 的 16 条是下限不是全部。
  const dangerous = a.dangerous ?? true
  const auth = a.auth ?? 'checksum'
  const verified = a.verified ?? false
  const envelope = a.envelope ?? null

  const spec = {
    id,
    pageId: raw.pageId,
    title: a.title ?? raw.title,
    method: raw.method,
    path: fixed.path,
    direction,
    callable,
    dangerous,
    auth,
    verified,
    envelope,
    ...(a.maxWindowDays !== undefined ? { maxWindowDays: a.maxWindowDays } : {}),
    category: a.category ?? raw.folder,
    ...(a.note !== undefined ? { note: a.note } : {}),
  }
  return { spec: orderFields(spec), params: extractParams(raw).params, bodyKind: extractParams(raw).bodyKind }
}

/** 按 FIELD_ORDER 重排键（未列出的键排在其后，保持相对顺序）。 */
function orderFields(obj) {
  const out = {}
  for (const k of FIELD_ORDER) if (k in obj) out[k] = obj[k]
  for (const k of Object.keys(obj)) if (!(k in out)) out[k] = obj[k]
  return out
}

/**
 * 对账，产出自查报告与错误列表。`errors` 非空时生成器必须失败退出。
 *
 * ⚠️ 第 ② 项是**回归哨兵**：`RATE_LIMITS` 是手工表，注册表是生成的，两者靠 id
 * 对齐。生成脚本补齐 specs.json 时若忘了同步限频表 id，这里会拦下 —— 而不是
 * 让限频层静默失效（`limitFor` 查不到就返回 null = 不限频）。
 *
 * @param {Array<Record<string, unknown>>} specs 任务 5 产出的 EndpointSpec[]
 * @param {Record<string, unknown>} rateLimits RATE_LIMITS（键为 id）
 * @returns {{ report: string, errors: string[] }}
 */
export function reconcile(specs, rateLimits) {
  const errors = []
  const lines = []

  // ① 同一 path 上所有 id 的限频必须一致
  // 设计稿 §验收判据 4：不一致要**打印差异**，故错误里按 id 展开各自档位，而非只报 path。
  // ⚠️ 档位归并「未登记（undefined）」与「显式登记为 null」：`limitFor`（ratelimit.ts）
  // 用 `Object.hasOwn` 区分二者，但**返回值都是 null（不限频），行为等价** —— 故比较时
  // 按同一档位归并是忠实的，不会漏报真实的档位差异。
  const byPath = new Map()
  for (const s of specs) {
    if (!s.path) continue
    byPath.set(s.path, [...(byPath.get(s.path) ?? []), s])
  }
  let sharedPaths = 0
  for (const [path, group] of byPath) {
    if (group.length < 2) continue
    sharedPaths++
    const tierOf = (s) => JSON.stringify(rateLimits[s.id] ?? null)
    const tiers = new Set(group.map(tierOf))
    if (tiers.size !== 1) {
      errors.push(`同 path 限频不一致：${path} ← ${group.map((s) => `${s.id}=${tierOf(s)}`).join(', ')}`)
    }
  }

  // ② RATE_LIMITS 的每个键都能在注册表里找到 id
  const ids = new Set(specs.map((s) => s.id))
  const orphans = Object.keys(rateLimits).filter((k) => !ids.has(k))
  if (orphans.length) errors.push(`RATE_LIMITS 的 id 不在注册表里：${orphans.join(', ')}`)

  // ③ 计数
  const dangerous = specs.filter((s) => s.dangerous).length
  const inbound = specs.filter((s) => s.direction === 'inbound').length
  const measured = specs.filter((s) => s.envelope !== null).length
  lines.push(`# 对账报告`, '',
    `- 条目总数：**${specs.length}**（页面级计数；文档页 ${specs.filter((s) => s.pageId).length} + 文档外 ${specs.filter((s) => !s.pageId).length}）`,
    `- 危险接口：**${dangerous}**`, `- 入站接口：**${inbound}**`,
    `- 已实测信封：**${measured}**（其余 envelope:null / verified:false）`,
    `- 共享 path 组：**${sharedPaths}**`, `- RATE_LIMITS 键数：**${Object.keys(rateLimits).length}**`,
    '', `## 异常`, ...(errors.length ? errors.map((e) => `- ❌ ${e}`) : ['- ✅ 全部通过']), '')

  return { report: lines.join('\n'), errors }
}
