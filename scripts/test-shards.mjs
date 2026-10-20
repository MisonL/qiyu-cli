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

const DEFAULT_SHARDS = 4
const MAX_SHARDS = 8
const DEFAULT_HEAP_MB = 2048

const rawShards = Number(process.env.QIYU_TEST_SHARDS ?? DEFAULT_SHARDS)
if (!Number.isInteger(rawShards) || rawShards < 1) {
  console.error(`QIYU_TEST_SHARDS 必须是 ≥1 的整数，收到：${process.env.QIYU_TEST_SHARDS}`)
  process.exit(2)
}
const shards = Math.min(rawShards, MAX_SHARDS)
if (rawShards > MAX_SHARDS) {
  console.warn(`⚠️ QIYU_TEST_SHARDS=${rawShards} 超过上限，按 ${MAX_SHARDS} 片执行`)
}

const heapMb = Number(process.env.QIYU_TEST_HEAP_MB ?? DEFAULT_HEAP_MB)
if (!Number.isInteger(heapMb) || heapMb < 256) {
  console.error(`QIYU_TEST_HEAP_MB 必须是 ≥256 的整数，收到：${process.env.QIYU_TEST_HEAP_MB}`)
  process.exit(2)
}

const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name)
    return statSync(p).isDirectory() ? walk(p) : p.endsWith('.test.ts') ? [p] : []
  })

/** 按文件字节数降序贪心装箱：最重的先放，每次放进当前最轻的一片。 */
export function planShards(files, count) {
  const sorted = [...files].sort((a, b) => statSync(b).size - statSync(a).size)
  const buckets = Array.from({ length: count }, () => ({ files: [], weight: 0 }))
  for (const f of sorted) {
    const lightest = buckets.reduce((a, b) => (a.weight <= b.weight ? a : b))
    lightest.files.push(f)
    lightest.weight += statSync(f).size
  }
  return buckets.map((b) => b.files).filter((g) => g.length > 0)
}

const vitestBin = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')

function runShard(files, index) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(
      process.execPath,
      [
        `--max-old-space-size=${heapMb}`,
        vitestBin, 'run',
        '--maxWorkers=1', '--no-file-parallelism',
        ...files,
      ],
      { stdio: 'inherit', env: process.env },
    )
    child.on('close', (code, signal) => {
      resolve({ index, code: code ?? 1, signal, ms: Date.now() - started, count: files.length })
    })
  })
}

const allFiles = walk('tests').sort()
if (allFiles.length === 0) {
  console.error('未找到任何测试文件（tests/**/*.test.ts）')
  process.exit(2)
}

const groups = planShards(allFiles, shards)
console.log(`\n分片执行：${groups.length} 片 / ${allFiles.length} 个测试文件 / 每片堆上限 ${heapMb} MB\n`)

const startedAll = Date.now()
const results = await Promise.all(groups.map((files, i) => runShard(files, i + 1)))
const totalMs = Date.now() - startedAll

console.log('\n—— 分片结果 ——')
for (const r of results.sort((a, b) => a.index - b.index)) {
  const status = r.code === 0 ? '通过' : `失败（退出码 ${r.code}${r.signal ? `，信号 ${r.signal}` : ''}）`
  console.log(`  片 ${r.index}: ${r.count} 文件  ${(r.ms / 1000).toFixed(1)}s  ${status}`)
}
console.log(`  合计墙钟：${(totalMs / 1000).toFixed(1)}s\n`)

const failed = results.filter((r) => r.code !== 0)
if (failed.length > 0) {
  console.error(`❌ ${failed.length}/${results.length} 片失败`)
  process.exit(1)
}
