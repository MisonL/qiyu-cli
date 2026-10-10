import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate, loadRateLimits } from '../../scripts/registry/generate.mjs'
import { parsePage, fixPath, deriveId } from '../../scripts/registry/lib.mjs'

const PAGES_DIR = fileURLToPath(new URL('../fixtures/registry/pages/', import.meta.url))
const OVERRIDES = fileURLToPath(new URL('../../src/core/registry/overrides/', import.meta.url))
const pageIds = readdirSync(PAGES_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, ''))
const EXTERNAL_IDS = ['export.session', 'export.session.check', 'export.session.one', 'export.session.one.message']
const EXPECTED_TOTAL = pageIds.length + 4

function tmpOverrides() {
  const dir = mkdtempSync(join(tmpdir(), 'reg-'))
  const read = (n: string) => JSON.parse(readFileSync(join(OVERRIDES, n), 'utf8'))
  const ids = read('ids.json'), paths = read('paths.json'), attrs = read('attrs.json')
  const keepPage = (o: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(o).filter(([k]) => pageIds.includes(k)))
  writeFileSync(join(dir, 'ids.json'), JSON.stringify(keepPage(ids)))
  writeFileSync(join(dir, 'paths.json'), JSON.stringify(keepPage(paths)))
  const knownIds = new Set(EXTERNAL_IDS)
  for (const pid of pageIds) {
    if (ids[pid]) { knownIds.add(ids[pid]); continue }
    const md = readFileSync(join(PAGES_DIR, `${pid}.md`), 'utf8')
    const id = deriveId(fixPath(parsePage(md, pid).path).path)
    if (id) knownIds.add(id)
  }
  writeFileSync(join(dir, 'attrs.json'), JSON.stringify(
    Object.fromEntries(Object.entries(attrs).filter(([k]) => knownIds.has(k)))))
  return dir
}

describe('generate', () => {
  it('对样本子集跑通：specs 条数 = 样本页 + 4 文档外，params 同数，无对账错误', async () => {
    const out = mkdtempSync(join(tmpdir(), 'out-'))
    const { specs, errors } = await generate({
      pagesDir: PAGES_DIR, outDir: out, overridesDir: tmpOverrides(),
      reportPath: join(out, 'report.md'), rateLimits: {},
    })
    expect(errors, errors.join('\n')).toEqual([])
    expect(specs.length).toBe(EXPECTED_TOTAL)
    expect(readdirSync(join(out, 'params')).length).toBe(EXPECTED_TOTAL)
    expect(JSON.parse(readFileSync(join(out, 'specs.json'), 'utf8')).length).toBe(EXPECTED_TOTAL)
    expect(specs.filter((s: { pageId?: string; id?: string }) => s.pageId).length).toBe(pageIds.length)
  })

  it('确定性：跑两次字节一致', async () => {
    const a = mkdtempSync(join(tmpdir(), 'a-')), b = mkdtempSync(join(tmpdir(), 'b-'))
    const ov = tmpOverrides()
    await generate({ pagesDir: PAGES_DIR, outDir: a, overridesDir: ov, reportPath: join(a, 'r.md'), rateLimits: {} })
    await generate({ pagesDir: PAGES_DIR, outDir: b, overridesDir: ov, reportPath: join(b, 'r.md'), rateLimits: {} })
    expect(readFileSync(join(a, 'specs.json'), 'utf8')).toBe(readFileSync(join(b, 'specs.json'), 'utf8'))
  })

  describe('loadRateLimits', () => {
    // ⚠️ 对账哨兵读的是 dist 里的 RATE_LIMITS。产物缺失/过期时必须**在写任何
    // 产物之前**抛错 —— 否则 specs.json 已经写了一半，目录里新旧混杂。
    it('产物缺失时抛错，且提示先 build', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'nodist-'))
      await expect(
        loadRateLimits({ distUrl: join(dir, 'missing.js'), srcUrl: join(dir, 'missing.ts') }),
      ).rejects.toThrow(/npm run build/)
    })

    it('源文件比产物新时抛错 —— 过期表会藏掉孤儿 id', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'stale-'))
      const dist = join(dir, 'ratelimit.js')
      const src = join(dir, 'ratelimit.ts')
      writeFileSync(dist, 'export const RATE_LIMITS = {}')
      writeFileSync(src, 'export const RATE_LIMITS = {}')
      const old = Date.now() / 1000 - 3600
      const fresh = Date.now() / 1000
      utimesSync(dist, old, old)   // 产物是 1 小时前的
      utimesSync(src, fresh, fresh) // 源文件是刚改的
      await expect(loadRateLimits({ distUrl: dist, srcUrl: src })).rejects.toThrow(/可能已过期/)
    })

    it('产物新鲜时读回 RATE_LIMITS', async () => {
      const dir = mkdtempSync(join(tmpdir(), 'fresh-'))
      const dist = join(dir, 'ratelimit.js')
      writeFileSync(dist, 'export const RATE_LIMITS = { "a.b": { limit: 1, windowSeconds: 1, source: "doc" } }')
      const old = Date.now() / 1000 - 3600
      utimesSync(dist, old, old)
      const rl = await loadRateLimits({ distUrl: dist, srcUrl: join(dir, 'no-src.ts') })
      expect(rl).toEqual({ 'a.b': { limit: 1, windowSeconds: 1, source: 'doc' } })
    })
  })

  it('dist 不可读时抛错，且**不写**任何产物 —— 不留半更新目录', async () => {
    // ⚠️ 这是「先读限频表、再写文件」那条顺序的回归哨兵：若把 loadRateLimits 挪回
    // 写文件之后，specs.json 会先落盘、再因 dist 缺失炸掉，目录里留下新旧混杂的产物。
    const out = mkdtempSync(join(tmpdir(), 'nowrite-'))
    const dir = mkdtempSync(join(tmpdir(), 'nodist-'))
    await expect(generate({
      pagesDir: PAGES_DIR, outDir: out, overridesDir: tmpOverrides(),
      reportPath: join(out, 'report.md'),
      distUrl: join(dir, 'missing.js'), srcUrl: join(dir, 'missing.ts'),
    })).rejects.toThrow(/读不到构建产物/)
    expect(readdirSync(out), '失败后不得留下 specs.json / params/').toEqual([])
  })
})
