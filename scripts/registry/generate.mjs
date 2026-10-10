// 读 registry-src/pages/*.md + overrides/ → 产出 specs.json + params/*.json + report.md
import { readFileSync, readdirSync, mkdirSync, writeFileSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parsePage, applyOverrides, validateOverrides, reconcile, deriveId, fixPath } from './lib.mjs'

const PAGES_DIR = 'registry-src/pages'
const OUT_DIR = 'src/core/registry'
const OVERRIDES_DIR = 'src/core/registry/overrides'
const REPORT = 'registry-src/report.md'

/** RATE_LIMITS 的构建产物（生成器从这里读对账用的限频表）。 */
export const DIST_RATELIMIT = new URL('../../dist/core/ratelimit.js', import.meta.url)
/** RATE_LIMITS 的源文件 —— 用来判断产物是否过期。 */
export const SRC_RATELIMIT = new URL('../../src/core/ratelimit.ts', import.meta.url)

/**
 * 读对账用的 RATE_LIMITS。
 *
 * ⚠️ **必须在写任何产物文件之前调用**：若放在写完 `specs.json`/`params/` 之后再 import，
 * dist 缺失或过期都要等"已经写了一半"才炸，留下部分更新的产物。
 * ⚠️ 过期产物会让对账拿旧表比对 —— `reconcile` 是"限频表 id ⊆ 注册表 id"的回归哨兵，
 * 旧表会把真实的孤儿 id 藏起来，哨兵静默失效。故源文件比产物新时直接抛错，逼维护者重建。
 *
 * @param {{distUrl?: URL|string, srcUrl?: URL|string}} [options] 路径可注入，便于测试
 * @returns {Promise<Record<string, unknown>>}
 */
export async function loadRateLimits({ distUrl = DIST_RATELIMIT, srcUrl = SRC_RATELIMIT } = {}) {
  const distPath = distUrl instanceof URL ? fileURLToPath(distUrl) : distUrl
  const srcPath = srcUrl instanceof URL ? fileURLToPath(srcUrl) : srcUrl
  if (!existsSync(distPath)) {
    throw new Error(
      `读不到构建产物 ${distPath} —— 生成器要从 dist 读 RATE_LIMITS 做对账，请先运行 \`npm run build\`。`,
    )
  }
  if (existsSync(srcPath) && statSync(srcPath).mtimeMs > statSync(distPath).mtimeMs) {
    throw new Error(
      `${srcPath} 比构建产物 ${distPath} 新 —— RATE_LIMITS 可能已过期，` +
        '对账会拿旧表比对而漏掉孤儿 id。请重新运行 `npm run build`。',
    )
  }
  const { RATE_LIMITS } = await import(distUrl instanceof URL ? distUrl.href : pathToFileURL(distPath).href)
  return RATE_LIMITS
}

/** 4 个文档外接口（会话导出流水线，150 页里 0 命中）。 */
const EXTERNAL_ENDPOINTS = [
  { id: 'export.session', title: '创建会话导出任务', method: 'POST', path: '/openapi/export/session' },
  { id: 'export.session.check', title: '查询会话导出任务', method: 'POST', path: '/openapi/export/session/check' },
  { id: 'export.session.one', title: '单条会话查询', method: 'POST', path: '/openapi/export/session/one' },
  { id: 'export.session.one.message', title: '单条会话消息查询', method: 'POST', path: '/openapi/export/session/one/message' },
]

/**
 * 读取页面和 override 表，生成注册表、参数文件及对账报告。
 * @param {{pagesDir?: string, outDir?: string, overridesDir?: string, reportPath?: string, rateLimits?: Record<string, unknown>, distUrl?: URL|string, srcUrl?: URL|string}} options
 *   `rateLimits` 给定时直接用（测试用）；否则经 `loadRateLimits({distUrl, srcUrl})` 从构建产物读。
 */
export async function generate({
  pagesDir = PAGES_DIR, outDir = OUT_DIR, overridesDir = OVERRIDES_DIR,
  reportPath = REPORT, rateLimits, distUrl, srcUrl,
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

  // ⚠️ 先读限频表、再写任何产物：dist 缺失/过期时立刻抛错，不留半更新的输出。
  // reconcile 的对账结果也依赖它 —— 必须在写文件前拿到。
  // distUrl/srcUrl 为 undefined 时 `loadRateLimits` 的形参默认值接管（指向仓库的 dist/src）。
  const rl = rateLimits ?? (await loadRateLimits({ distUrl, srcUrl }))
  const { report, errors } = reconcile(specs, rl)

  mkdirSync(join(outDir, 'params'), { recursive: true })
  writeFileSync(join(outDir, 'specs.json'), JSON.stringify(specs, null, 2) + '\n')
  for (const id of Object.keys(paramsById).sort()) {
    writeFileSync(join(outDir, 'params', `${id}.json`), JSON.stringify(paramsById[id], null, 2) + '\n')
  }
  writeFileSync(reportPath, report)
  return { specs, report, errors }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { errors } = await generate()
  if (errors.length) { console.error(errors.join('\n')); process.exit(1) }
  console.log('生成完成 → src/core/registry/{specs.json,params/}')
}
