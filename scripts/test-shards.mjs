#!/usr/bin/env node
// 固定分片测试 runner —— 把测试文件分成 N 片并行跑，每片内部仍是单进程单 worker。
//
// ⚠️ **为什么分片而不是放宽 maxWorkers**（2026-10-05 事故，见 vitest.config.ts）：
// 那天是一份变异脚本**循环**调用 `npx vitest run`、vitest 按 16 核起满 worker，
// 其中一个变异让数组无界增长，三个 worker 各涨到约 16 GB，64 GB 耗尽，
// macOS Jetsam 杀掉 1414 个进程。
// 根因是「无界循环 × 无界增长」，不是「并发」本身。本脚本：
//   1. 分片数**固定**（默认 4），不随 CPU 数放大 —— 不是循环，也不是自适应；
//   2. 每片仍带 `--maxWorkers=1 --no-file-parallelism`，单进程单 worker 的防护原样保留；
//   3. 每片额外用 `--max-old-space-size` 钉住堆上限，把「无界增长」也关进笼子。
//
// 用法：
//   node scripts/test-shards.mjs             # 默认 4 片
//   QIYU_TEST_SHARDS=1 node scripts/test-shards.mjs   # 单片（等价旧行为）
//   QIYU_TEST_SHARDS=8 node scripts/test-shards.mjs
//
// 环境变量：
//   QIYU_TEST_SHARDS    分片数，默认 4，上限 8（超过上限按 8 处理并告警）
//   QIYU_TEST_HEAP_MB   每片 Node 堆上限，默认 2048

import { spawn } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const DEFAULT_SHARDS = 4
export const MAX_SHARDS = 8
const DEFAULT_HEAP_MB = 2048

/**
 * 从环境变量字面量里解析分片数与堆上限（**纯函数**，不读 `process.env`、不 `process.exit`）。
 *
 * ⚠️ 拆成纯函数是为了**可测**（gap 9）：旧版直接在 `readOptions()` 里 `process.exit(2)`，
 * 测试无法断言「非法值退 2」，只能绕道 spawn 一个真进程；而 spawn 真 runner 会递归调
 * vitest（2026-10-05 事故的直接原因）。现在非法值以 `{ error }` 返回，由调用方决定退出码。
 *
 * @returns `{ shards, heapMb, warn? }` 或 `{ error }`（error 是给用户看的中文说明）
 */
export function parseOptions(env = {}) {
  const rawShardsText = env.QIYU_TEST_SHARDS
  const rawShards = Number(rawShardsText ?? DEFAULT_SHARDS)
  if (!Number.isInteger(rawShards) || rawShards < 1) {
    return { error: `QIYU_TEST_SHARDS 必须是 ≥1 的整数，收到：${rawShardsText}` }
  }
  const shards = Math.min(rawShards, MAX_SHARDS)
  // 上限告警随结果带出（不在解析里就往 stderr 写），测试可断言它「有没有出现」。
  const warn = rawShards > MAX_SHARDS
    ? `⚠️ QIYU_TEST_SHARDS=${rawShards} 超过上限，按 ${MAX_SHARDS} 片执行`
    : undefined

  const rawHeapText = env.QIYU_TEST_HEAP_MB
  const heapMb = Number(rawHeapText ?? DEFAULT_HEAP_MB)
  if (!Number.isInteger(heapMb) || heapMb < 256) {
    return { error: `QIYU_TEST_HEAP_MB 必须是 ≥256 的整数，收到：${rawHeapText}` }
  }
  return { shards, heapMb, ...(warn === undefined ? {} : { warn }) }
}

/**
 * 读分片数与堆上限。**只在真正要跑测试时调用** —— 顶层直接读环境变量会让
 * 「import 本模块拿 planShards」这个动作连带触发一次全量测试
 * （2026-10-20 实测踩到：审查者 import 它核对分片构成，结果无意中跑了两次全量）。
 */
function readOptions() {
  const parsed = parseOptions(process.env)
  if (parsed.error !== undefined) {
    console.error(parsed.error)
    process.exit(2)
  }
  const { shards, heapMb, warn } = parsed
  if (warn !== undefined) console.warn(warn)
  return { shards, heapMb }
}

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.test.ts') ? [p] : []
  })

/**
 * 按文件字节数降序贪心装箱：最重的先放，每次放进当前最轻的一片。
 * ⚠️ `sizeOf` 可注入（缺省 `statSync` 取真实大小）：测试要构造「几片 / 每片多重」
 * 而不必在磁盘上造真实文件（纯函数层即可覆盖「不重不漏」）。
 */
export function planShards(files, count, sizeOf = (f) => statSync(f).size) {
  const sorted = [...files].sort((a, b) => sizeOf(b) - sizeOf(a))
  const buckets = Array.from({ length: count }, () => ({ files: [], weight: 0 }))
  for (const f of sorted) {
    const lightest = buckets.reduce((a, b) => (a.weight <= b.weight ? a : b))
    lightest.files.push(f)
    lightest.weight += sizeOf(f)
  }
  return buckets.map((b) => b.files).filter((g) => g.length > 0)
}

/**
 * 跑一个分片时，spawn 的参数表（**纯函数**，不 spawn）。
 *
 * ⚠️ 每一片都必须带三样东西，缺一不可（2026-10-05 事故的防护，见文件头）：
 *   1. `--max-old-space-size=${heapMb}` —— 堆上限，把「无界增长」关进笼子；
 *   2. `--maxWorkers=1` —— 不让 vitest 按 CPU 数起满 worker；
 *   3. `--no-file-parallelism` —— 文件之间也不并行。
 * 拆成纯函数是为了让测试能**逐字**断言这三样都在，而不是靠源文本正则碰运气。
 */
export function buildShardArgs({ heapMb, vitestBin, files }) {
  return [
    `--max-old-space-size=${heapMb}`,
    vitestBin, 'run',
    '--maxWorkers=1', '--no-file-parallelism',
    ...files,
  ]
}

/**
 * 分片结果 → 整体退出码（**纯函数**）。任一片非 0 即整体 1 —— 分片不得掩盖失败：
 * 一片失败而其余通过时，若返回 0，CI 会绿着放行（这正是要防的静默失败）。
 */
export function aggregateExit(results) {
  return results.some((r) => r.code !== 0) ? 1 : 0
}

const vitestBin = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')

function runShard(files, index, heapMb) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(
      process.execPath,
      buildShardArgs({ heapMb, vitestBin, files }),
      { stdio: 'inherit', env: process.env },
    )
    child.on('close', (code, signal) => {
      resolve({ index, code: code ?? 1, signal, ms: Date.now() - started, count: files.length })
    })
  })
}

/** 入口：把全部测试文件分片并并行跑完，返回退出码。 */
async function main() {
  const { shards, heapMb } = readOptions()

  const allFiles = walk('tests').sort()
  if (allFiles.length === 0) {
    console.error('未找到任何测试文件（tests/**/*.test.ts）')
    return 2
  }

  const groups = planShards(allFiles, shards)
  console.log(`\n分片执行：${groups.length} 片 / ${allFiles.length} 个测试文件 / 每片堆上限 ${heapMb} MB\n`)

  const startedAll = Date.now()
  const results = await Promise.all(groups.map((files, i) => runShard(files, i + 1, heapMb)))
  const totalMs = Date.now() - startedAll

  console.log('\n—— 分片结果 ——')
  for (const r of results.sort((a, b) => a.index - b.index)) {
    const status = r.code === 0 ? '通过' : `失败（退出码 ${r.code}${r.signal ? `，信号 ${r.signal}` : ''}）`
    console.log(`  片 ${r.index}: ${r.count} 文件  ${(r.ms / 1000).toFixed(1)}s  ${status}`)
  }
  console.log(`  合计墙钟：${(totalMs / 1000).toFixed(1)}s\n`)

  const exit = aggregateExit(results)
  if (exit !== 0) {
    const failed = results.filter((r) => r.code !== 0)
    console.error(`❌ ${failed.length}/${results.length} 片失败`)
  }
  return exit
}

// ⚠️ **只在被直接执行时才跑**：本模块导出 `planShards` 供核对分片构成用，
// 若无条件执行，`import` 一下就会连带跑整轮测试（2026-10-20 实际踩到）。
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await main()
}
