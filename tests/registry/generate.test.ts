import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { generate } from '../../scripts/registry/generate.mjs'
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
})
