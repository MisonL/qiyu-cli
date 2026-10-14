// tests/sync/pipeline.test.ts
// D-T10：会话导出四步流水线（create→poll→download→unzip→parse）+ sessions 表任务。
// Review Focus 4 钉死：JSONL 末尾 `startTime=...,endTime=...` 尾行标记跳过、空行跳过。
// 实测事实（设计稿 §7.5）：窗口 ≤6 天、overlapDays=1、水位 endTime（导出按 endTime 过滤）；
// 解压密码 = appKey 前 12 字符（ZipCrypto）；去重按 session.id（绝不能按导出任务 key）；
// enrich 派生 session_type（staffId 数字判别：< -1 robot / == -1 internal / > 0 human）+
// categoryDetail 归一化（导出 " / " 带空格 → 无空格）；PII 列 sensitive: true。
// 真库夹具照 tests/store/duckdb.test.ts；http mock 照 tests/core/http.test.ts。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync, strToU8 } from 'fflate'
import { createDuckDbStore } from '../../src/store/duckdb.js'
import { runTask } from '../../src/sync/engine.js'
import { RateGate } from '../../src/sync/rate-gate.js'
import { parseJsonl, unzipPasswordZip, runExportPipeline, type PipelineCtx } from '../../src/sync/tasks/pipeline.js'
import { SESSIONS_TASKS, taskById as sessionsById } from '../../src/sync/tasks/sessions.js'
import { __resetBuckets } from '../../src/core/http.js'
import { tableByName } from '../../src/store/schema.js'
import type { RunCtx, SyncTask } from '../../src/sync/types.js'
import type { Store, StoreConfig } from '../../src/store/types.js'

vi.setConfig({ testTimeout: 15_000 })

const DAY = 86_400_000
const APP_KEY = 'testkey123456'   // 前 12 字符 = 'testkey12345'（解压密码）

let dir = ''
let cfg: StoreConfig
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-pipeline-'))
  cfg = { backend: 'duckdb', path: join(dir, 'q.db'), readOnlyRetryMs: 30000, batchSize: 1000 }
  __resetBuckets()
})
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(cfg, 'rw')
  await s.init()
  return s
}

function ctx(store: Store, over: Partial<RunCtx> = {}): RunCtx {
  return {
    store,
    credentials: { appKey: APP_KEY, appSecret: 'test-secret' },
    gate: new RateGate(store, () => 0),
    clock: () => 1_700_000_000_000,
    rangeOverride: over.rangeOverride ?? { start: 0, end: DAY },
    ...over,
  }
}

// —— 测试内合成加密 zip（ZipCrypto，与实现侧解密同算法的逆）——
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1
    t[i] = c >>> 0
  }
  return t
})()
function crc32(buf: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (const b of buf) c = (c >>> 8) ^ CRC_TABLE[(c ^ b) & 0xFF]
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** 单文件 ZipCrypto 加密 zip（deflate 方法），密码即密钥种子 —— 测试合成专用。 */
function makeEncryptedZip(name: string, content: string, password: string): Uint8Array {
  const raw = strToU8(content)
  const comp = deflateSync(raw, { level: 6 })
  // ZipCrypto 密钥初始化与更新（PKWARE APPNOTE）
  const keys = [0x12345678, 0x23456789, 0x34567890]
  const upd = (b: number): void => {
    keys[0] = ((keys[0] >>> 8) ^ CRC_TABLE[(keys[0] ^ b) & 0xFF]) >>> 0
    keys[1] = (keys[1] + (keys[0] & 0xFF)) >>> 0
    keys[1] = (Math.imul(keys[1], 134775813) + 1) >>> 0
    keys[2] = ((keys[2] >>> 8) ^ CRC_TABLE[(keys[2] ^ (keys[1] >>> 24)) & 0xFF]) >>> 0
  }
  for (const ch of strToU8(password)) upd(ch)
  const crc = crc32(raw)
  // 加密头 12 字节：11 随机 + 1 校验字节（= crc 高字节）—— ZipCrypto 对整个明文流
  //（含这 12 字节头）连续加密，密钥状态跨头/体连续
  const hdr = new Uint8Array(12)
  for (let i = 0; i < 11; i++) hdr[i] = (i * 37 + 11) & 0xFF
  hdr[11] = (crc >>> 24) & 0xFF
  const enc = new Uint8Array(hdr.length + comp.length)
  const stream = (K: number[]): number => {
    const k = ((K[2] | 2) & 0xFFFF) >>> 0
    return (Math.imul(k, k ^ 1) >>> 8) & 0xFF
  }
  for (let i = 0; i < hdr.length; i++) {
    enc[i] = hdr[i] ^ stream(keys)
    upd(hdr[i])
  }
  for (let i = 0; i < comp.length; i++) {
    enc[hdr.length + i] = comp[i] ^ stream(keys)
    upd(comp[i])
  }
  // —— 拼本地文件头 + central directory + EOCD（无数据描述符：crc 直接写本地头）——
  const nameBytes = strToU8(name)
  const le = (v: number, bytes: number): Uint8Array => {
    const a = new Uint8Array(bytes)
    for (let i = 0; i < bytes; i++) a[i] = (v >>> (8 * i)) & 0xFF
    return a
  }
  const lfh = new Uint8Array(30 + nameBytes.length)
  lfh.set([0x50, 0x4B, 0x03, 0x04])
  lfh.set(le(20, 2), 4)        // version
  lfh.set(le(0x0001, 2), 6)    // flags: bit0 加密
  lfh.set(le(8, 2), 8)         // method deflate
  lfh.set(le(0, 4), 10)        // time/date
  lfh.set(le(crc, 4), 14)      // crc（无数据描述符，直接写）
  lfh.set(le(enc.length, 4), 18)
  lfh.set(le(raw.length, 4), 22)
  lfh.set(le(nameBytes.length, 2), 26)
  lfh.set(le(0, 2), 28)
  lfh.set(nameBytes, 30)
  const body = new Uint8Array(lfh.length + enc.length)
  body.set(lfh); body.set(enc, lfh.length)
  const cd = new Uint8Array(46 + nameBytes.length)
  cd.set([0x50, 0x4B, 0x01, 0x02])
  cd.set(le(20, 2), 4); cd.set(le(20, 2), 6)
  cd.set(le(0x0001, 2), 8)
  cd.set(le(8, 2), 10)
  cd.set(le(0, 4), 12)
  cd.set(le(crc, 4), 16)
  cd.set(le(enc.length, 4), 20)
  cd.set(le(raw.length, 4), 24)
  cd.set(le(nameBytes.length, 2), 28)
  cd.set(le(0, 2), 30); cd.set(le(0, 2), 32); cd.set(le(0, 2), 34)
  cd.set(le(0, 2), 36); cd.set(le(0, 4), 38)
  cd.set(le(0, 4), 42)   // local header offset = 0
  cd.set(nameBytes, 46)
  const eocd = new Uint8Array(22)
  eocd.set([0x50, 0x4B, 0x05, 0x06])
  eocd.set(le(0, 2), 8)          // 盘号
  eocd.set(le(1, 2), 10)         // central directory 条目数
  eocd.set(le(cd.length, 4), 12) // central directory 大小
  eocd.set(le(body.length, 4), 16) // central directory 偏移 = local body 之后
  const out = new Uint8Array(body.length + cd.length + eocd.length)
  out.set(body); out.set(cd, body.length); out.set(eocd, body.length + cd.length)
  return out
}

const SESSION_ROW = {
  id: 15503545983, staffId: 1000002, startTime: 1698800000000, endTime: 1698800600000,
  categoryDetail: '售前 / 退换货 / 物流 / 催单', userName: '测试甲', userPhone: '', userEmail: '',
  userAddress: '', fromIp: '', userIpCity: '', userCrmInfo: '', staffName: '测试甲',
}
const TAIL_LINE = `startTime=${SESSION_ROW.startTime},endTime=${SESSION_ROW.endTime}`

describe('parseJsonl（Review Focus 4 钉死）', () => {
  it('2 合法行 + 尾行标记 + 空行 → rows=2、tailSkipped=true', () => {
    const text = [
      JSON.stringify({ id: 1, staffId: 1000002 }),
      '',
      JSON.stringify({ id: 2, staffId: -1000002 }),
      TAIL_LINE,
      '',
    ].join('\n')
    const r = parseJsonl(text)
    expect(r.rows).toEqual([
      { id: 1, staffId: 1000002 },
      { id: 2, staffId: -1000002 },
    ])
    expect(r.tailSkipped).toBe(true)
  })

  it('无尾行（纯合法行）→ tailSkipped=false；非 JSON 且非尾行 → 显式失败', () => {
    const ok = parseJsonl(JSON.stringify({ id: 1 }))
    expect(ok.tailSkipped).toBe(false)
    expect(() => parseJsonl('not json at all')).toThrow()
  })
})

describe('zip 解压（密码 = appKey 前 12 字符）', () => {
  it('合成加密 zip → 解出 session.txt → parse（12 字符密码往返）', async () => {
    const zip = makeEncryptedZip('session.txt', `${JSON.stringify(SESSION_ROW)}\n${TAIL_LINE}\n`, APP_KEY.slice(0, 12))
    const text = await unzipPasswordZip(zip, APP_KEY)
    const r = parseJsonl(text)
    expect(r.rows).toEqual([SESSION_ROW])
    expect(r.tailSkipped).toBe(true)
  })

  it('错密码 → 显式失败（不静默给乱码）', async () => {
    const zip = makeEncryptedZip('session.txt', `${JSON.stringify(SESSION_ROW)}\n`, APP_KEY.slice(0, 12))
    await expect(unzipPasswordZip(zip, 'wrong-password')).rejects.toThrow()
  })
})

describe('runExportPipeline —— 四步流水线 mock', () => {
  // 流水线 ctx：RunCtx 基础上追加油水线注入面（fetchZip/poll 节奏）
  function pipeCtx(store: Store, over: Partial<RunCtx> & Partial<PipelineCtx> = {}): PipelineCtx {
    return { credentials: ctx(store).credentials, ...over } as PipelineCtx
  }

  it('create 返回 key → check 先 14403 后成功链接 → fetchZip 返回合成 zip → 行落库（session.id 主键 upsert）', async () => {
    const zip = makeEncryptedZip('session.txt',
      `${JSON.stringify(SESSION_ROW)}\n${TAIL_LINE}\n`, APP_KEY.slice(0, 12))
    const fetchMock = vi.fn()
      // 1. create：{code:200, message:"<任务key>"}（形状 A，key 在 message）
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'task-key-0001',
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      // 2. check：先 14403 Wait...（信封 A）
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 14403, message: 'Wait...',
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      // 3. check：完成 → 下载链接在 message
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'https://qiyukf.com/export/download/abc.zip',
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const r = await runExportPipeline({ start: 0, end: DAY }, pipeCtx(store, {
        credentials: { appKey: APP_KEY, appSecret: 'test-secret' },
        fetchZip: async () => zip,
        pollIntervalMs: 0,
      }))
      expect(fetchMock.mock.calls.length).toBe(3)
      expect(r.sessions).toEqual([SESSION_ROW])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('poll 有界：持续 14403 超过预算 → 显式失败（不无限等待）', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'task-key-0002',
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
        code: 14403, message: 'Wait...',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    try {
      const store = await fresh()
      await expect(runExportPipeline({ start: 0, end: DAY }, pipeCtx(store, {
        credentials: { appKey: APP_KEY, appSecret: 'test-secret' },
        fetchZip: async () => new Uint8Array(),
        pollIntervalMs: 0, maxPolls: 3,
      }))).rejects.toThrow(/14403|轮询/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('SESSIONS_TASKS 任务声明', () => {
  it('1 任务：sessions.export，windowed、maxWindowDays=6、overlapDays=1、水位 endTime、upsertRows', () => {
    expect(SESSIONS_TASKS.map((t) => t.id)).toEqual(['sessions.export'])
    const t = sessionsById('sessions.export')!
    expect(t.kind).toBe('windowed')
    expect(t.table).toBe('sessions')
    expect(t.maxWindowDays).toBe(6)      // 实测 143.5h 通过 / 144.0h 报 14004
    expect(t.overlapDays).toBe(1)        // 相邻窗口必须重叠（跨窗长会话会漏）
    expect(t.watermark).toEqual({ field: 'endTime', initial: null })   // 导出按 endTime 过滤
    expect(t.write).toEqual({ kind: 'upsertRows' })
    expect(t.primaryKey).toEqual(['session_id'])
  })

  it('enrich：staffId=-1000002 → robot；-1 → internal；1000002 → human（数字判别，staffId 是 VARCHAR 落库）', async () => {
    const t = sessionsById('sessions.export')!
    const mk = (id: number, staffId: number) => ({
      session_id: String(id), staffId: String(staffId),
    }) as Record<string, unknown>
    const e = t.enrich!
    expect(e(mk(1, -1000002))).toMatchObject({ session_id: '1', session_type: 'robot' })
    expect(e(mk(2, -1))).toMatchObject({ session_id: '2', session_type: 'internal' })
    expect(e(mk(3, 1000002))).toMatchObject({ session_id: '3', session_type: 'human' })
  })

  it('enrich：categoryDetail "a / b / c / d" → "a/b/c/d"（归一化），且同输入同输出（确定性）', async () => {
    const t = sessionsById('sessions.export')!
    const row = { session_id: '9', staffId: '1000002', categoryDetail: 'a / b / c / d' }
    expect(t.enrich!(row)).toMatchObject({ categoryDetail: 'a/b/c/d' })
    expect(t.enrich!(row)).toEqual(t.enrich!(row))
  })
})

describe('schema v7 迁移 —— sessions 表', () => {
  it('sessions 表在 TABLES：PII 七列 sensitive: true（information_schema 不可见则经元数据断言）', () => {
    const t = tableByName('sessions')!
    expect(t.primaryKey).toEqual(['session_id'])
    for (const name of ['userPhone', 'userName', 'userEmail', 'userAddress', 'fromIp',
      'userIpCity', 'userCrmInfo']) {
      expect(t.columns.find((c) => c.name === name)?.sensitive, `${name}`).toBe(true)
    }
    // 非敏感列不误标（契约诚实性：sensitive 不得按名称模式泛化）
    expect(t.columns.find((c) => c.name === 'staffId')?.sensitive).toBe(false)
  })

  it('session_type 派生列不进主键、确定性派生（红线 1 推论）', () => {
    const t = tableByName('sessions')!
    expect(t.columns.some((c) => c.name === 'session_type')).toBe(true)
    expect(t.primaryKey).not.toContain('session_type')
  })
})

describe('sessions 任务全链路（重叠去重按 session.id）', () => {
  function mkZip(rows: unknown[]): Uint8Array {
    const lines = rows.map((r) => JSON.stringify(r))
    return makeEncryptedZip('session.txt', `${lines.join('\n')}\n${TAIL_LINE}\n`, APP_KEY.slice(0, 12))
  }
  function mocksFor(_zip: Uint8Array): ReturnType<typeof vi.fn> {
    // 按调用序循环供给 create → check（多窗口流水线各自走一遍同一序列；zip 由 fetchZip 注入）
    let i = 0
    return vi.fn(() => {
      const msg = i++ % 2 === 0 ? 'task-key-x' : 'https://qiyukf.com/export/x.zip'
      return Promise.resolve(new Response(JSON.stringify({ code: 200, message: msg }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
    })
  }

  it('两窗口含同 session.id → 落库行数 1（upsert 幂等吸收重叠；去重按 session.id 不按任务 key）', async () => {
    const row = { ...SESSION_ROW }
    const fetchMock = mocksFor(mkZip([row]))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const t: SyncTask = { ...sessionsById('sessions.export')! }
      const orig = t.fetch
      t.fetch = async (w, c) => orig(w, { ...c,
        fetchZip: async () => mkZip([row]), pollIntervalMs: 0 } as never)
      const ctx1 = ctx(store, { rangeOverride: { start: 0, end: 6 * DAY } })
      const r1 = await runTask(t, ctx1)
      const r2 = await runTask(t, { ...ctx1, rangeOverride: { start: 5 * DAY, end: 11 * DAY } })
      expect(r1.status).toBe('complete')
      expect(r2.status).toBe('complete')
      expect(await store.count('sessions')).toBe(1)   // 同 id 两窗口重叠 → 1 行
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('流水线行落库：session.id → session_id VARCHAR 主键、派生 session_type 落库', async () => {
    const fetchMock = mocksFor(mkZip([SESSION_ROW]))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const t: SyncTask = { ...sessionsById('sessions.export')! }
      const orig = t.fetch
      t.fetch = async (w, c) => orig(w, { ...c,
        fetchZip: async () => mkZip([SESSION_ROW]), pollIntervalMs: 0 } as never)
      const r = await runTask(t, ctx(store, {
        rangeOverride: { start: 0, end: 6 * DAY },
      }))
      expect(r.status).toBe('complete')
      expect(r.rows.written).toBe(1)
      const rows = await store.query('SELECT session_id, session_type, staffId FROM sessions')
      expect(rows.rows).toEqual([{
        session_id: '15503545983', session_type: 'human', staffId: '1000002',
      }])
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
