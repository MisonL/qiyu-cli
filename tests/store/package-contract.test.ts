import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
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

  it('fflate 是唯一常规依赖（D-T10：会话导出解压）；@duckdb/node-api 不在 dependencies', () => {
    expect(pkg.dependencies).toEqual({ fflate: '^0.8.3' })
  })
})
