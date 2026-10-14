// tests/store/errors.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openStore } from '../../src/store/index.js'
import { isModuleNotFound } from '../../src/store/duckdb.js'
import type { StoreConfig } from '../../src/store/types.js'

let dir = ''
let cfg: StoreConfig
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qiyu-err-')); cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 100, batchSize: 10 } })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('isModuleNotFound —— 缺失模块识别', () => {
  it('ERR_MODULE_NOT_FOUND 取出 specifier', () => {
    const e = Object.assign(new Error("Cannot find package '@duckdb/node-api' imported from x"), { code: 'ERR_MODULE_NOT_FOUND' })
    expect(isModuleNotFound(e)).toEqual({ missing: '@duckdb/node-api' })
  })
  it('非该错误码 → null', () => {
    expect(isModuleNotFound(new Error('x'))).toBeNull()
  })
})

describe('openStore —— 未知后端', () => {
  it('未知 backend → usage 错误', async () => {
    await expect(openStore({ ...cfg, backend: 'oracle' as never }, 'ro')).rejects.toThrow(/oracle|未知/)
  })
})

describe('openStore —— 依赖缺失（注入 importer mock）', () => {
  it('缺 @duckdb/node-api → store_not_initialized + 安装 hint', async () => {
    const { createDuckDbStore } = await import('../../src/store/duckdb.js')
    const importer = vi.fn(async () => {
      throw Object.assign(new Error("Cannot find package '@duckdb/node-api'"), { code: 'ERR_MODULE_NOT_FOUND' })
    })
    await expect(createDuckDbStore(cfg, 'ro', { importer })).rejects.toMatchObject({
      kind: 'store_not_initialized', hint: expect.stringMatching(/npm install @duckdb\/node-api/),
    })
  })

  it('缺 @duckdb/node-bindings-* → 平台不支持 hint', async () => {
    const { createDuckDbStore } = await import('../../src/store/duckdb.js')
    const importer = vi.fn(async () => {
      throw Object.assign(new Error("Cannot find package '@duckdb/node-bindings-linux-x64'"), { code: 'ERR_MODULE_NOT_FOUND' })
    })
    await expect(createDuckDbStore(cfg, 'ro', { importer })).rejects.toMatchObject({
      kind: 'store_not_initialized', hint: expect.stringMatching(/平台|node-gyp/),
    })
  })
})
