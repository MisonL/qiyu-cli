// 读 registry-src/pages/*.md + overrides/ → 产出 specs.json + params/*.json + report.md
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parsePage, applyOverrides, validateOverrides, reconcile, deriveId, fixPath } from './lib.mjs'

const PAGES_DIR = 'registry-src/pages'
const OUT_DIR = 'src/core/registry'
const OVERRIDES_DIR = 'src/core/registry/overrides'
const REPORT = 'registry-src/report.md'

/** 4 个文档外接口（会话导出流水线，150 页里 0 命中）。 */
const EXTERNAL_ENDPOINTS = [
  { id: 'export.session', title: '创建会话导出任务', method: 'POST', path: '/openapi/export/session' },
  { id: 'export.session.check', title: '查询会话导出任务', method: 'POST', path: '/openapi/export/session/check' },
  { id: 'export.session.one', title: '单条会话查询', method: 'POST', path: '/openapi/export/session/one' },
  { id: 'export.session.one.message', title: '单条会话消息查询', method: 'POST', path: '/openapi/export/session/one/message' },
]

/**
 * 读取页面和 override 表，生成注册表、参数文件及对账报告。
 * @param {{pagesDir?: string, outDir?: string, overridesDir?: string, reportPath?: string, rateLimits?: Record<string, unknown>}} options
 */
export async function generate({
  pagesDir = PAGES_DIR, outDir = OUT_DIR, overridesDir = OVERRIDES_DIR,
  reportPath = REPORT, rateLimits,
} = {}) {
  const read = (p) => JSON.parse(readFileSync(p, 'utf8'))
  const ids = read(join(overridesDir, 'ids.json'))
  const attrs = read(join(overridesDir, 'attrs.json'))
  const paths = read(join(overridesDir, 'paths.json'))
  const tables = { ids, attrs, paths }
  const files = readdirSync(pagesDir).filter((f) => f.endsWith('.md')).sort()
  const raws = files.map((f) => parsePage(readFileSync(join(pagesDir, f), 'utf8'), f.replace(/\.md$/, '')))
  const knownIds = new Set([
    ...Object.values(ids),
    ...raws.map((r) => ids[r.pageId] ?? deriveId(fixPath(r.path).path)),
    ...EXTERNAL_ENDPOINTS.map((e) => e.id),
  ])
  validateOverrides(tables, new Set(raws.map((r) => r.pageId)), knownIds)

  const usedIds = new Set()
  const specs = []
  const paramsById = {}
  for (const raw of raws) {
    const { spec, params, bodyKind } = applyOverrides(raw, tables, usedIds)
    specs.push(spec)
    paramsById[spec.id] = { params, responseShape: raw.responseShape, bodyKind }
  }
  for (const e of EXTERNAL_ENDPOINTS) {
    if (usedIds.has(e.id)) throw new Error(`id 冲突：文档外接口 ${e.id} 与某页撞名`)
    usedIds.add(e.id)
    const a = attrs[e.id] ?? {}
    specs.push({
      id: e.id, title: e.title, method: e.method, path: e.path,
      direction: a.direction ?? 'outbound', callable: a.callable ?? true,
      dangerous: a.dangerous ?? true, auth: a.auth ?? 'checksum',
      verified: a.verified ?? false, envelope: a.envelope ?? null,
      ...(a.maxWindowDays !== undefined ? { maxWindowDays: a.maxWindowDays } : {}),
      ...(a.category !== undefined ? { category: a.category } : {}),
      ...(a.note !== undefined ? { note: a.note } : {}),
    })
    paramsById[e.id] = { params: [], responseShape: { kind: 'none' }, bodyKind: 'none' }
  }
  specs.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))
  mkdirSync(join(outDir, 'params'), { recursive: true })
  writeFileSync(join(outDir, 'specs.json'), JSON.stringify(specs, null, 2) + '\n')
  for (const id of Object.keys(paramsById).sort()) {
    writeFileSync(join(outDir, 'params', `${id}.json`), JSON.stringify(paramsById[id], null, 2) + '\n')
  }
  let rl = rateLimits
  if (rl === undefined) {
    ({ RATE_LIMITS: rl } = await import('../../dist/core/ratelimit.js'))
  }
  const { report, errors } = reconcile(specs, rl)
  writeFileSync(reportPath, report)
  return { specs, report, errors }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { errors } = await generate()
  if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
  console.log('生成完成 → src/core/registry/{specs.json,params/}')
}
