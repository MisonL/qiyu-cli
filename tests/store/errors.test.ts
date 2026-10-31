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
  it('ERR_MODULE_NOT_FOUND 取出 specifier（整包不装：ESM 解析）', () => {
    const e = Object.assign(new Error("Cannot find package '@duckdb/node-api' imported from x"), { code: 'ERR_MODULE_NOT_FOUND' })
    expect(isModuleNotFound(e)).toEqual({ missing: '@duckdb/node-api' })
  })
  // ⚠️ 2026-10-31 实测：平台 binding 缺失走的是 **CJS require**，错误码是
  // `MODULE_NOT_FOUND`（无 ERR_ 前缀）、报文是 `Cannot find module '…/duckdb.node'`。
  // 只认 ESM 码时这条返回 null，「当前平台无预编译包」那句 hint 永远够不到。
  // 下面两条用的是**真实形态**（复现脚本逐字抄来：删掉 node-bindings-darwin-x64 后
  // 真跑 `import('@duckdb/node-api')` 得到 code / message）。
  it('MODULE_NOT_FOUND 也认（平台 binding 缺失：CJS require，specifier 带 /duckdb.node 后缀）', () => {
    const e = Object.assign(
      new Error("Cannot find module '@duckdb/node-bindings-darwin-x64/duckdb.node'\nRequire stack:\n- x/duckdb.js"),
      { code: 'MODULE_NOT_FOUND' })
    expect(isModuleNotFound(e)).toEqual({ missing: '@duckdb/node-bindings-darwin-x64/duckdb.node' })
  })
  it('非该错误码 → null', () => {
    expect(isModuleNotFound(new Error('x'))).toBeNull()
  })
  it('码对但报文不是「Cannot find …」形态 → missing 为空串（不猜）', () => {
    // 形态错配时宁可给空 specifier（落「未安装依赖」那一支）也不要瞎猜一个包名
    expect(isModuleNotFound(Object.assign(new Error('boom'), { code: 'MODULE_NOT_FOUND' })))
      .toEqual({ missing: '' })
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

  it('缺 @duckdb/node-bindings-* → 平台不支持 hint（用真实 CJS 形态：MODULE_NOT_FOUND）', async () => {
    const { createDuckDbStore } = await import('../../src/store/duckdb.js')
    const importer = vi.fn(async () => {
      // 真实形态（2026-10-31 复现脚本逐字抄来）：平台 binding 由 CJS require 抛出。
      throw Object.assign(
        new Error("Cannot find module '@duckdb/node-bindings-linux-x64/duckdb.node'\nRequire stack:\n- x/duckdb.js"),
        { code: 'MODULE_NOT_FOUND' })
    })
    await expect(createDuckDbStore(cfg, 'ro', { importer })).rejects.toMatchObject({
      kind: 'store_not_initialized', hint: expect.stringMatching(/平台|node-gyp/),
    })
  })

  it('反向自检：缺 @duckdb/node-api 时**不得**给「平台不支持」的 hint（二分没退化成一支）', async () => {
    const { createDuckDbStore } = await import('../../src/store/duckdb.js')
    const importer = vi.fn(async () => {
      throw Object.assign(new Error("Cannot find package '@duckdb/node-api'"), { code: 'ERR_MODULE_NOT_FOUND' })
    })
    const e = await createDuckDbStore(cfg, 'ro', { importer }).catch((x: unknown) => x) as { hint?: string }
    expect(e.hint, '整包不装 → 装 node-api；不得说「平台无预编译包」').not.toMatch(/平台|node-gyp/)
  })
})
