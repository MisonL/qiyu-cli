import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listPageUrls, fetchPage, fetchAll } from '../../scripts/registry/fetch.mjs'

// 假的 fetch 实现：用真实 Response 对象（类型与运行时行为都对齐 Node 的 fetch）。
const ok = (body: string) => () => Promise.resolve(new Response(body, { status: 200 }))
const bad = (status: number) => () => Promise.resolve(new Response('error page', { status }))

describe('fetch', () => {
  it('索引返回非 2xx 时抛错 —— 否则会打出「0/0」的假成功', async () => {
    // ⚠️ llms.txt 若 404/5xx，正文是错误页，正则 0 命中；若不查 res.ok，
    // fetchAll 会把「一页都没抓到」报成「抓取完成：0/0」——
    // 而目录里可能还留着上次的旧页，看起来更像成功。
    await expect(listPageUrls(bad(404) as unknown as typeof fetch)).rejects.toThrow(/HTTP 404/)
  })

  it('索引里 0 命中 api-*.md 时抛错 —— 不是"站点本来就没有接口页"', async () => {
    await expect(listPageUrls(ok('no urls here') as unknown as typeof fetch))
      .rejects.toThrow(/没有匹配到/)
  })

  it('从索引提取 URL：去重且保持出现顺序', async () => {
    const body = [
      'https://qiyukf.apifox.cn/api-1.md',
      'https://qiyukf.apifox.cn/api-2.md',
      'https://qiyukf.apifox.cn/api-1.md',
      'https://qiyukf.apifox.cn/not-an-api.md',
    ].join('\n')
    expect(await listPageUrls(ok(body) as unknown as typeof fetch)).toEqual([
      'https://qiyukf.apifox.cn/api-1.md',
      'https://qiyukf.apifox.cn/api-2.md',
    ])
  })

  it('fetchPage 非 2xx 时抛错，且不落盘', async () => {
    await expect(
      fetchPage('https://qiyukf.apifox.cn/api-1.md', mkdtempSync(join(tmpdir(), 'fetch-')),
        bad(500) as unknown as typeof fetch),
    ).rejects.toThrow(/HTTP 500/)
  })

  it('fetchAll 把每个页面落盘，返回 {total, fetched}', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fetch-'))
    const index = 'https://qiyukf.apifox.cn/api-7.md\nhttps://qiyukf.apifox.cn/api-8.md'
    const impl = (url: RequestInfo | URL) =>
      Promise.resolve(new Response(
        String(url).includes('llms.txt') ? index : `# ${url}`, { status: 200 })) as unknown as Promise<Response>
    const r = await fetchAll(dir, impl as typeof fetch, 2)
    expect(r).toEqual({ total: 2, fetched: 2 })
    expect(readFileSync(join(dir, 'api-7.md'), 'utf8')).toBe('# https://qiyukf.apifox.cn/api-7.md')
    expect(readFileSync(join(dir, 'api-8.md'), 'utf8')).toBe('# https://qiyukf.apifox.cn/api-8.md')
  })
})
