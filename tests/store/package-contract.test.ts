import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  optionalDependencies?: Record<string, string>
}

describe('依赖契约 —— DuckDB 必须是可选依赖', () => {
  it('@duckdb/node-api 在 optionalDependencies 且不在 dependencies', () => {
    expect(pkg.optionalDependencies?.['@duckdb/node-api']).toBe('1.5.6-r.1')
    expect(pkg.dependencies?.['@duckdb/node-api']).toBeUndefined()
  })

  it('lockfile 含 @duckdb/node-api 条目（npm ci 消费者依赖它同步）', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, unknown>
    }
    expect(Object.keys(lock.packages ?? {}).some((k) => k.includes('@duckdb/node-api'))).toBe(true)
  })

  it('零常规运行时依赖：dependencies 不存在常规依赖，fflate 只在 devDependencies（修复批 3）', () => {
    // 修复批 3 口径：src/ 已零 fflate 引用（zip 解压走 Node 内置 DecompressionStream +
    // 手工 ZipCrypto；解码走 TextDecoder），fflate 只剩**测试夹具合成**用
    //（tests/sync/pipeline.test.ts 的 deflateSync/strToU8 造加密 zip）→ 开发依赖，不是运行时依赖。
    // 空对象与「键不存在」都算合规；关键是真断言「没有任何常规依赖」。
    expect(pkg.dependencies ?? {}).toEqual({})
    expect(pkg.devDependencies?.['fflate']).toBe('^0.8.3')
    // 同步引擎声称的零依赖是**包级**事实，不只是源码事实：常规依赖为空即消费者 npm install
    // 不为其多装任何东西（@duckdb/node-api 仍是 optionalDependencies，缺失时给安装指引）。
    expect(pkg.optionalDependencies?.['@duckdb/node-api']).toBe('1.5.6-r.1')
  })

  it('lockfile 联动：fflate 条目标 dev: true（npm ci 消费者不会把它当运行时依赖装）', () => {
    const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { dev?: boolean } | undefined>
    }
    const entry = lock.packages?.['node_modules/fflate']
    expect(entry?.dev).toBe(true)
    // 根条目也不得再声明 dependencies（npm 语义：空 dependencies 键会进发布元数据）
    const rootEntry = lock.packages?.[''] as { dependencies?: unknown } | undefined
    expect(rootEntry?.dependencies).toBeUndefined()
  })
})
