// scripts/registry/fetch.mjs
// 联网抓取 Apifox 公开文档页。**不进 CI** —— Apifox 站点可用性不是本项目的依赖。
// 用法：node scripts/registry/fetch.mjs [输出目录]（默认 registry-src/pages/，已 gitignore）
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const INDEX_URL = 'https://qiyukf.apifox.cn/llms.txt'

/** 从 llms.txt 提取全部 api-*.md 的 URL，去重后按出现顺序返回。 */
export async function listPageUrls(fetchImpl = fetch) {
  const text = await (await fetchImpl(INDEX_URL)).text()
  const urls = []
  const seen = new Set()
  for (const m of text.matchAll(/https:\/\/qiyukf\.apifox\.cn\/api-\d+\.md/g)) {
    if (seen.has(m[0])) continue
    seen.add(m[0])
    urls.push(m[0])
  }
  return urls
}

/** 抓一个页面并写到 outDir/<basename>。返回写入的文件名。 */
export async function fetchPage(url, outDir, fetchImpl = fetch) {
  const name = url.split('/').pop()
  const res = await fetchImpl(url)
  if (!res.ok) throw new Error(`抓取 ${url} 失败：HTTP ${res.status}`)
  await writeFile(join(outDir, name), await res.text(), 'utf8')
  return name
}

/** 抓全部页面。默认并发 6（Apifox 是静态站）。 */
export async function fetchAll(outDir = 'registry-src/pages', fetchImpl = fetch, concurrency = 6) {
  await mkdir(outDir, { recursive: true })
  const urls = await listPageUrls(fetchImpl)
  let fetched = 0
  for (let i = 0; i < urls.length; i += concurrency) {
    const names = await Promise.all(urls.slice(i, i + concurrency).map((u) => fetchPage(u, outDir, fetchImpl)))
    fetched += names.length
  }
  return { total: urls.length, fetched }
}

// 直接运行时才执行（被 import 时不跑）
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const outDir = process.argv[2] ?? 'registry-src/pages'
  const r = await fetchAll(outDir)
  console.log(`抓取完成：${r.fetched}/${r.total} 个页面 → ${outDir}/`)
}
