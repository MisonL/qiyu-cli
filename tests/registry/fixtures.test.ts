import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

// ⚠️ 用 URL 定位 fixture，不用 `import.meta.dirname`（Node ≥ 20.11 才有，
// 而 engines 是 >=20.10；readFileSync 本就接受 file:// URL）。
// ⚠️ id（pageId）本身已含 `api-` 前缀（见下方 EXPECTED 与任务接口说明），
// 这里**不能**再拼一个 `api-`，否则变成 `api-api-….md` 找不到文件。
const pageUrl = (id: string) => new URL(`../fixtures/registry/pages/${id}.md`, import.meta.url)

const EXPECTED = [
  'api-10845434', 'api-10845435', 'api-10845438', 'api-10845443', 'api-10845446',
  'api-10845447', 'api-10845464', 'api-10845465', 'api-10845466', 'api-10845467',
  'api-10845468', 'api-10845469', 'api-10845496', 'api-10845503', 'api-10845504',
  'api-10845505', 'api-10845506', 'api-10845507', 'api-10845542', 'api-10845543',
  'api-10845545', 'api-10845572', 'api-10845577', 'api-11028998',
]
const PAGES_DIR = fileURLToPath(new URL('../fixtures/registry/pages/', import.meta.url))

describe('样本页面', () => {
  it('恰好 24 个，且与清单逐一对上', () => {
    const files = readdirSync(PAGES_DIR).filter((f) => f.endsWith('.md')).map((f) => f.replace(/\.md$/, '')).sort()
    expect(files).toEqual([...EXPECTED].sort())
  })

  it('每页都有 OpenAPI Specification 段与行首行尾的 ```yaml 围栏', () => {
    for (const id of EXPECTED) {
      const md = readFileSync(pageUrl(id), 'utf8')
      expect(md, `${id} 缺 OpenAPI Specification`).toContain('## OpenAPI Specification')
      // ⚠️ 必须锚定 ^```$（行首行尾）—— 页面 description 里内嵌 ```text/```json
      // 围栏，宽松匹配会匹配到内嵌围栏（见任务 2 的 extractYaml 注释）
      expect(/^```yaml$/m.test(md), `${id} 缺行首的 \`\`\`yaml`).toBe(true)
      expect(/^```$/m.test(md), `${id} 缺行首的收尾 \`\`\``).toBe(true)
    }
  })
})
