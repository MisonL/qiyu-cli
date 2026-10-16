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
import { parseJsonl, parseExportFixture, unzipPasswordZip, runExportPipeline, type PipelineCtx } from '../../src/sync/tasks/pipeline.js'
import { SESSIONS_TASKS, taskById as sessionsById, assertFixtureGranularity } from '../../src/sync/tasks/sessions.js'
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

/** 单条目的 ZipCrypto 加密数据（加密头 12 字节 + deflate 密文），密码即密钥种子。
 * checkByte 缺省 = CRC 高字节（非 bit3 写法）；bit3 时按 PKWARE 约定传修改时间高字节。 */
function encryptEntry(content: string, password: string,
  checkByte?: number): { enc: Uint8Array; crc: number; rawLen: number } {
  const raw = strToU8(content)
  const comp = deflateSync(raw, { level: 6 })
  // ZipCrypto 密钥初始化与更新（PKWARE APPNOTE）—— 密钥按条目重置（标准行为）
  const keys = [0x12345678, 0x23456789, 0x34567890]
  const upd = (b: number): void => {
    keys[0] = ((keys[0] >>> 8) ^ CRC_TABLE[(keys[0] ^ b) & 0xFF]) >>> 0
    keys[1] = (keys[1] + (keys[0] & 0xFF)) >>> 0
    keys[1] = (Math.imul(keys[1], 134775813) + 1) >>> 0
    keys[2] = ((keys[2] >>> 8) ^ CRC_TABLE[(keys[2] ^ (keys[1] >>> 24)) & 0xFF]) >>> 0
  }
  for (const ch of strToU8(password)) upd(ch)
  const crc = crc32(raw)
  // 加密头 12 字节：11 随机 + 1 校验字节 —— ZipCrypto 对整个明文流
  //（含这 12 字节头）连续加密，密钥状态跨头/体连续
  const hdr = new Uint8Array(12)
  for (let i = 0; i < 11; i++) hdr[i] = (i * 37 + 11) & 0xFF
  hdr[11] = checkByte ?? ((crc >>> 24) & 0xFF)
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
  return { enc, crc, rawLen: raw.length }
}

const le = (v: number, bytes: number): Uint8Array => {
  const a = new Uint8Array(bytes)
  for (let i = 0; i < bytes; i++) a[i] = (v >>> (8 * i)) & 0xFF
  return a
}

/** 多文件 ZipCrypto 加密 zip（deflate 方法）—— 测试合成专用。
 * entries 顺序即容器内条目顺序（message.txt 在前的用例靠它构造）。
 * bit3=true 时本地头 crc/csize 置 0、置数据描述符标志位，真实 crc 只写在 central directory；
 * 且按 PKWARE/Info-ZIP 约定把**加密头校验字节写成 DOS 修改时间高字节**（modTime=0x3A20
 * → 0x3A）——写入方在 bit3 下无法预先知道 CRC（修复批 4 #6）。数据区后补一个 12 字节
 * 数据描述符（可选记录，真实写入器会写；条目定位不得依赖它）。 */
function makeEncryptedZip(entries: Array<{ name: string; content: string }>, password: string,
  bit3 = false): Uint8Array {
  const MOD_TIME = 0x3A20   // 合成 DOS 修改时间：高字节 0x3A（≠ 任何真实 CRC 高字节的概率极高）
  const bodies: Uint8Array[] = []
  const cds: Uint8Array[] = []
  let offset = 0
  for (const { name, content } of entries) {
    const { enc, crc, rawLen } = encryptEntry(content, password,
      bit3 ? ((MOD_TIME >>> 8) & 0xFF) : undefined)
    const nameBytes = strToU8(name)
    const lfh = new Uint8Array(30 + nameBytes.length)
    lfh.set([0x50, 0x4B, 0x03, 0x04])
    lfh.set(le(20, 2), 4)        // version
    lfh.set(le(bit3 ? 0x0009 : 0x0001, 2), 6)   // flags: bit0 加密（+bit3 数据描述符）
    lfh.set(le(8, 2), 8)         // method deflate
    lfh.set(le(0, 2), 10); lfh.set(le(0, 2), 12)   // time/date（非 bit3 时为 0）
    if (bit3) lfh.set(le(MOD_TIME, 2), 10)         // bit3：加密头校验字节来源
    lfh.set(le(bit3 ? 0 : crc, 4), 14)          // bit3 时本地头 crc=0（真实值在中央目录）
    lfh.set(le(bit3 ? 0 : enc.length, 4), 18)   // bit3 时本地头 csize=0
    lfh.set(le(bit3 ? 0 : rawLen, 4), 22)       // bit3 时本地头 usize=0
    lfh.set(le(nameBytes.length, 2), 26)
    lfh.set(le(0, 2), 28)
    lfh.set(nameBytes, 30)
    // 数据描述符（bit3）：[可选签名][crc][csize][usize]，紧跟在数据之后
    const dd = bit3 ? new Uint8Array(16) : new Uint8Array(0)
    if (bit3) {
      dd.set(le(0x08074b50, 4), 0)
      dd.set(le(crc, 4), 4); dd.set(le(enc.length, 4), 8); dd.set(le(rawLen, 4), 12)
    }
    const body = new Uint8Array(lfh.length + enc.length + dd.length)
    body.set(lfh); body.set(enc, lfh.length); body.set(dd, lfh.length + enc.length)
    const cd = new Uint8Array(46 + nameBytes.length)
    cd.set([0x50, 0x4B, 0x01, 0x02])
    cd.set(le(20, 2), 4); cd.set(le(20, 2), 6)
    cd.set(le(0x0001, 2), 8)
    cd.set(le(8, 2), 10)
    if (bit3) cd.set(le(MOD_TIME, 2), 12)
    cd.set(le(crc, 4), 16)
    cd.set(le(enc.length, 4), 20)
    cd.set(le(rawLen, 4), 24)
    cd.set(le(nameBytes.length, 2), 28)
    cd.set(le(0, 2), 30); cd.set(le(0, 2), 32); cd.set(le(0, 2), 34)
    cd.set(le(0, 2), 36); cd.set(le(0, 4), 38)
    cd.set(le(offset, 4), 42)   // local header offset
    cd.set(nameBytes, 46)
    bodies.push(body); cds.push(cd)
    offset += body.length
  }
  const body = new Uint8Array(bodies.reduce((n, b) => n + b.length, 0))
  let o = 0
  for (const b of bodies) { body.set(b, o); o += b.length }
  const cdAll = new Uint8Array(cds.reduce((n, c) => n + c.length, 0))
  o = 0
  for (const c of cds) { cdAll.set(c, o); o += c.length }
  const eocd = new Uint8Array(22)
  eocd.set([0x50, 0x4B, 0x05, 0x06])
  eocd.set(le(0, 2), 8)            // 盘号
  eocd.set(le(entries.length, 2), 10)   // central directory 条目数
  eocd.set(le(cdAll.length, 4), 12)     // central directory 大小
  eocd.set(le(body.length, 4), 16)      // central directory 偏移 = local body 之后
  const out = new Uint8Array(body.length + cdAll.length + eocd.length)
  out.set(body); out.set(cdAll, body.length); out.set(eocd, body.length + cdAll.length)
  return out
}

const SESSION_ROW = {
  id: 15503545983, staffId: 1000002, startTime: 1698800000000, endTime: 1698800600000,
  categoryDetail: '售前 / 退换货 / 物流 / 催单', userName: '测试甲', userPhone: '', userEmail: '',
  userAddress: '', fromIp: '', userIpCity: '', userCrmInfo: '', staffName: '测试甲',
}
const TAIL_LINE = `startTime=${SESSION_ROW.startTime},endTime=${SESSION_ROW.endTime}`

/** 尾部标记行 = 导出自己的窗口声明（C-8）：端到端用例必须让它声明**请求的那个窗口**，
 * 否则任务层的窗口核对会（正确地）判形态漂移。 */
const tailFor = (w: { start: number; end: number }): string => `startTime=${w.start},endTime=${w.end}`

describe('parseJsonl（Review Focus 4 钉死）', () => {
  it('2 合法行 + 尾行标记 + 空行 → rows=2、tailSkipped=true、fixture 带出尾行原文（C-8）', () => {
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
    // C-8：原文不再是丢弃物 —— 它是导出自己的窗口声明，由任务层与请求窗口核对
    expect(r.fixture).toBe(TAIL_LINE)
    expect(parseExportFixture(r.fixture!)).toEqual({
      start: SESSION_ROW.startTime, end: SESSION_ROW.endTime,
    })
  })

  it('无尾行（纯合法行）→ tailSkipped=false、fixture 缺省；非 JSON 且非尾行 → 显式失败', () => {
    const ok = parseJsonl(JSON.stringify({ id: 1 }))
    expect(ok.tailSkipped).toBe(false)
    expect(ok.fixture).toBeUndefined()
    expect(() => parseJsonl('not json at all')).toThrow()
    // 形似但不是该形态（超宽数字 / 多字段）→ 不算尾标记，按形态漂移显式失败
    expect(() => parseJsonl(`startTime=${'9'.repeat(20)},endTime=1`)).toThrow(/第 1 行/)
    expect(() => parseJsonl('startTime=1,endTime=2,total=3')).toThrow(/第 1 行/)
  })

  it('F 中-1：解析失败的错误消息只带行号/长度，绝不回显行原文（PII 红线）', () => {
    const pii = JSON.stringify({ id: 1, userPhone: '13800001111', userName: '张三', fromIp: '1.2.3.4' })
    let msg = ''
    try {
      parseJsonl(`${JSON.stringify({ id: 0 })}\n{broken ${pii}`)
    } catch (e) { msg = (e as Error).message }
    expect(msg).toMatch(/第 2 行/)
    expect(msg).toMatch(/不回显/)
    // 行内容（PII 片段）绝不能出现在错误消息里
    expect(msg).not.toContain('13800001111')
    expect(msg).not.toContain('张三')
    expect(msg).not.toContain('1.2.3.4')
    expect(msg).not.toContain(pii)
  })
})

describe('zip 解压（密码 = appKey 前 12 字符）', () => {
  it('合成加密 zip → 解出 session.txt → parse（12 字符密码往返）', async () => {
    const zip = makeEncryptedZip([{ name: 'session.txt', content: `${JSON.stringify(SESSION_ROW)}\n${TAIL_LINE}\n` }], APP_KEY.slice(0, 12))
    const text = await unzipPasswordZip(zip, APP_KEY)
    const r = parseJsonl(text)
    expect(r.rows).toEqual([SESSION_ROW])
    expect(r.tailSkipped).toBe(true)
  })

  it('错密码 → 显式失败（不静默给乱码）', async () => {
    const zip = makeEncryptedZip([{ name: 'session.txt', content: `${JSON.stringify(SESSION_ROW)}\n` }], APP_KEY.slice(0, 12))
    await expect(unzipPasswordZip(zip, 'wrong-password')).rejects.toThrow()
  })

  it('两条件目（message.txt 在前）→ 按名匹配只解出 session.txt（fix 中-3 钉死）', async () => {
    const zip = makeEncryptedZip([
      { name: 'message.txt', content: 'not the file you want' },
      { name: 'session.txt', content: `${JSON.stringify(SESSION_ROW)}\n` },
    ], APP_KEY.slice(0, 12))
    const text = await unzipPasswordZip(zip, APP_KEY)
    const r = parseJsonl(text)
    expect(r.rows).toEqual([SESSION_ROW])
  })

  it('zip 内没有 session.txt → 显式抛错（不静默取第一个条目）', async () => {
    const zip = makeEncryptedZip([{ name: 'message.txt', content: 'x' }], APP_KEY.slice(0, 12))
    await expect(unzipPasswordZip(zip, APP_KEY)).rejects.toThrow(/session.txt/)
  })

  it('D 中-1：bit3 数据描述符（本地头 crc=0）→ 真密码仍可解（crc 从中央目录取）', async () => {
    const zip = makeEncryptedZip(
      [{ name: 'session.txt', content: `${JSON.stringify(SESSION_ROW)}\n` }],
      APP_KEY.slice(0, 12), true)
    const text = await unzipPasswordZip(zip, APP_KEY)
    const r = parseJsonl(text)
    expect(r.rows).toEqual([SESSION_ROW])
  })

  it('D 中-1：bit3 数据描述符 + 错密码 → 显式失败（绝不静默吐乱码）', async () => {
    const zip = makeEncryptedZip(
      [{ name: 'session.txt', content: `${JSON.stringify(SESSION_ROW)}\n` }],
      APP_KEY.slice(0, 12), true)
    await expect(unzipPasswordZip(zip, 'wrong-password-xx')).rejects.toThrow(/密码错误/)
  })

  it('修复批 4 #5：两条目 + bit3（session.txt 在后）→ 以中央目录定位仍能取到', async () => {
    // 旧实现的本地头步进遇 bit3 会落在数据描述符上（签名不符）→ 循环退出 →
    // session.txt 永远找不到（旧的 bit3 用例只有单条目，掩盖了这条路径）。
    const zip = makeEncryptedZip([
      { name: 'message.txt', content: '先去的那条消息文件' },
      { name: 'session.txt', content: `${JSON.stringify(SESSION_ROW)}\n${TAIL_LINE}\n` },
    ], APP_KEY.slice(0, 12), true)
    const text = await unzipPasswordZip(zip, APP_KEY)
    const r = parseJsonl(text)
    expect(r.rows).toEqual([SESSION_ROW])
    expect(r.fixture).toBe(TAIL_LINE)
  })

  it('修复批 4 #6：bit3 且加密头写的是修改时间高字节 → 合法包可解（CRC 由解压结果全量校验）', async () => {
    // PKWARE/Info-ZIP 约定：bit3 时写入方无法预知 CRC → 第 12 字节写 DOS 修改时间高字节。
    // 旧实现恒与 CRC 高字节比较 → 把合法包判成「密码错误」。
    const zip = makeEncryptedZip(
      [{ name: 'session.txt', content: `${JSON.stringify(SESSION_ROW)}\n` }],
      APP_KEY.slice(0, 12), true)
    const text = await unzipPasswordZip(zip, APP_KEY)
    expect(parseJsonl(text).rows).toEqual([SESSION_ROW])
    // 错密码仍显式失败（校验字节是时间字节时同样拦得住）
    await expect(unzipPasswordZip(zip, 'wrong-password-xx')).rejects.toThrow(/密码错误/)
  })
})

describe('runExportPipeline —— 四步流水线 mock', () => {
  // 流水线 ctx：RunCtx 基础上追加油水线注入面（fetchZip/poll 节奏）
  function pipeCtx(store: Store, over: Partial<RunCtx> & Partial<PipelineCtx> = {}): PipelineCtx {
    return { credentials: ctx(store).credentials, ...over } as PipelineCtx
  }

  it('create 返回 key → check 先 14403 后成功链接 → fetchZip 返回合成 zip → 行落库（session.id 主键 upsert）', async () => {
    // 尾标记声明请求窗口 [0, DAY]（C-8）：流水线把它带出为 fixture，不再 void 丢弃
    const W = { start: 0, end: DAY }
    const zip = makeEncryptedZip([{ name: 'session.txt', content: `${JSON.stringify(SESSION_ROW)}\n${tailFor(W)}\n` }], APP_KEY.slice(0, 12))
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
      // C-8 新出口：尾标记原文随流水线返回（不再在 pipeline 内被丢弃）
      expect(r.fixture).toBe(tailFor(W))
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('D 中-2：窗口无效（start==end / start>end / 非有限数）→ usage、零请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const base = pipeCtx(store, {
        credentials: { appKey: APP_KEY, appSecret: 'test-secret' },
        fetchZip: async () => new Uint8Array(),
        pollIntervalMs: 0,
      })
      await expect(runExportPipeline({ start: DAY, end: DAY }, base)).rejects.toMatchObject({ kind: 'usage' })
      await expect(runExportPipeline({ start: DAY, end: 0 }, base)).rejects.toMatchObject({ kind: 'usage' })
      await expect(runExportPipeline({ start: Number.NaN, end: DAY }, base)).rejects.toMatchObject({ kind: 'usage' })
      expect(fetchMock.mock.calls.length, '本地参数问题绝不发请求').toBe(0)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('D 中-2：create 载荷无可用 message（形态漂移）→ 显式失败', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response(JSON.stringify({
      code: 200, message: 'OK',   // 无 data、message 是 'OK'（占位）→ messageOf 无可用载荷
    }), { status: 200, headers: { 'content-type': 'application/json' } }))))
    try {
      const store = await fresh()
      await expect(runExportPipeline({ start: 0, end: DAY }, pipeCtx(store, {
        credentials: { appKey: APP_KEY, appSecret: 'test-secret' },
        fetchZip: async () => new Uint8Array(),
        pollIntervalMs: 0,
      }))).rejects.toThrow(/message 载荷/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('D 中-2：导出 zip 未加密（bit0 缺失）→ 显式失败（注册表假设失效可见）', async () => {
    // 明文 zip：本地头无 bit0（直接 deflateSync，不加密）。带合法 EOCD + 中央目录，
    // 让失败落在「未加密」这条守卫上（与修复批 4 #5 的定位改造一致：先定位条目、
    // 再读 flags；只有没有 central directory 的畸形 zip 才报缺 EOCD）。
    const content = `${JSON.stringify(SESSION_ROW)}\n`
    const comp = deflateSync(strToU8(content), { level: 6 })
    const nameBytes = strToU8('session.txt')
    const lfh = new Uint8Array(30 + nameBytes.length)
    lfh.set([0x50, 0x4B, 0x03, 0x04])
    lfh.set(le(20, 2), 4)
    lfh.set(le(0, 2), 6)            // flags = 0：未加密
    lfh.set(le(8, 2), 8)
    lfh.set(le(crc32(strToU8(content)), 4), 14)
    lfh.set(le(comp.length, 4), 18)
    lfh.set(le(strToU8(content).length, 4), 22)
    lfh.set(le(nameBytes.length, 2), 26)
    lfh.set(nameBytes, 30)
    const body = new Uint8Array(lfh.length + comp.length)
    body.set(lfh); body.set(comp, lfh.length)
    // 中央目录：cd 的 flags 字段必须与本地头一致（0）——bit3=false 的条目
    const cd = new Uint8Array(46 + nameBytes.length)
    cd.set([0x50, 0x4B, 0x01, 0x02])
    cd.set(le(20, 2), 4); cd.set(le(20, 2), 6)
    cd.set(le(0x0001, 2), 8)
    cd.set(le(8, 2), 10)
    cd.set(le(crc32(strToU8(content)), 4), 16)
    cd.set(le(comp.length, 4), 20)
    cd.set(le(strToU8(content).length, 4), 24)
    cd.set(le(nameBytes.length, 2), 28)
    cd.set(le(0, 4), 42)
    cd.set(nameBytes, 46)
    const eocd = new Uint8Array(22)
    eocd.set([0x50, 0x4B, 0x05, 0x06])
    eocd.set(le(1, 2), 10)
    eocd.set(le(cd.length, 4), 12)
    eocd.set(le(body.length, 4), 16)
    const zip = new Uint8Array(body.length + cd.length + eocd.length)
    zip.set(body); zip.set(cd, body.length); zip.set(eocd, body.length + cd.length)
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'task-key-0009',
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
      .mockImplementationOnce(() => Promise.resolve(new Response(JSON.stringify({
        code: 200, message: 'https://qiyukf.com/export/plain.zip',
      }), { status: 200, headers: { 'content-type': 'application/json' } })))
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      await expect(runExportPipeline({ start: 0, end: DAY }, pipeCtx(store, {
        credentials: { appKey: APP_KEY, appSecret: 'test-secret' },
        fetchZip: async () => zip,
        pollIntervalMs: 0,
      }))).rejects.toThrow(/未加密/)
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

  it('enrich（C 中-6/C 低-7）：staffId=0 不静默判 human（未知形态落 null）；空串/缺 id 行丢弃', () => {
    const t = sessionsById('sessions.export')!
    const e = t.enrich!
    // staffId=0 是实测样本中从未出现的形态：静默归 human 会伪造「人工接待」的事实
    expect(e({ session_id: '4', staffId: '0' })).toMatchObject({ session_type: null })
    expect(e({ session_id: '5', staffId: 0 })).toMatchObject({ session_type: null })
    // 空串/缺 id 行：丢弃且不计入 fetched（返回 null）
    expect(e({ session_id: '', staffId: '1000002' })).toBeNull()
    expect(e({ staffId: '1000002' })).toBeNull()
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
  /** 合成导出 zip：rows + 尾标记行（声明 `declared` 窗口 —— 正常形态是它与请求窗口一致）。 */
  function mkZip(rows: unknown[], declared: { start: number; end: number }): Uint8Array {
    const lines = rows.map((r) => JSON.stringify(r))
    return makeEncryptedZip([{ name: 'session.txt', content: `${lines.join('\n')}\n${tailFor(declared)}\n` }], APP_KEY.slice(0, 12))
  }
  /** 包装任务 fetch：fetchZip 按**本窗请求窗口**合成 zip（多窗用例每窗各自的声明不同）。 */
  function withZip(t: SyncTask, rows: unknown[]): SyncTask {
    const orig = t.fetch
    return { ...t, fetch: async (w, c) => orig(w, { ...c,
      fetchZip: async () => mkZip(rows, w), pollIntervalMs: 0 } as never) }
  }
  function mocksFor(): ReturnType<typeof vi.fn> {
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
    const fetchMock = mocksFor()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const t = withZip(sessionsById('sessions.export')!, [row])
      const ctx1 = ctx(store, { rangeOverride: { start: 0, end: 6 * DAY } })
      const r1 = await runTask(t, ctx1)
      const r2 = await runTask(t, { ...ctx1, rangeOverride: { start: 5 * DAY, end: 11 * DAY } })
      expect(r1.status).toBe('complete')
      expect(r2.status).toBe('complete')
      // 正常形态（尾标记声明 = 请求窗口）不产生任何缺口（C-8：核对通过 = 无 gap）
      expect(r1.gaps).toEqual([])
      expect(r2.gaps).toEqual([])
      expect(await store.count('sessions')).toBe(1)   // 同 id 两窗口重叠 → 1 行
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('流水线行落库：session.id → session_id VARCHAR 主键、派生 session_type 落库', async () => {
    const fetchMock = mocksFor()
    vi.stubGlobal('fetch', fetchMock)
    try {
      const store = await fresh()
      const t = withZip(sessionsById('sessions.export')!, [SESSION_ROW])
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

describe('C-8：尾部标记行（导出窗口声明）与请求窗口核对', () => {
  function mkZipWith(content: string): Uint8Array {
    return makeEncryptedZip([{ name: 'session.txt', content }], APP_KEY.slice(0, 12))
  }
  /** create/check/zip 三段 mock（zip 由注入的 fetchZip 供给，不走全局 fetch）。 */
  function stubCreateCheck(): ReturnType<typeof vi.fn> {
    let i = 0
    const m = vi.fn(() => {
      const msg = i++ % 2 === 0 ? 'task-key-c8' : 'https://qiyukf.com/export/c8.zip'
      return Promise.resolve(new Response(JSON.stringify({ code: 200, message: msg }),
        { status: 200, headers: { 'content-type': 'application/json' } }))
    })
    vi.stubGlobal('fetch', m)
    return m
  }
  function withContent(t: SyncTask, content: string): SyncTask {
    const orig = t.fetch
    return { ...t, fetch: async (w, c) => orig(w, { ...c,
      fetchZip: async () => mkZipWith(content), pollIntervalMs: 0 } as never) }
  }

  it('① 非空会话 + 尾标记声明的窗口不覆盖请求 → 显式抛错（含「格式漂移」与 fixture）、窗口失败、水位不推', async () => {
    // 导出声明的是一段与请求无交集的历史窗口 —— 行数再多也不可信，宁可失败
    const W = { start: 0, end: 6 * DAY }
    const stale = 'startTime=1700000000000,endTime=1700086400000'
    stubCreateCheck()
    try {
      const store = await fresh()
      const t = withContent(sessionsById('sessions.export')!,
        `${JSON.stringify(SESSION_ROW)}\n${stale}\n`)
      const r = await runTask(t, ctx(store, { rangeOverride: W }))
      expect(r.status).toBe('partial')
      expect(r.windows).toEqual({ total: 1, succeeded: 0, failed: 1 })
      expect(r.gaps.length).toBe(1)
      expect(r.gaps[0]!.reason).toBe('fetch_failed')
      // failDetail 中文包装 + 消息含「格式漂移」与 fixture 原文（原文在 detail 里可见）
      expect(r.gaps[0]!.detail).toMatch(/格式漂移/)
      expect(r.gaps[0]!.detail).toContain(stale)
      // 可疑数据绝不落库（水位与数据同事务：本窗失败 → 什么都没写）
      expect(await store.count('sessions')).toBe(0)
      const gaps = await store.query('SELECT reason, detail FROM sync_gaps')
      expect(gaps.rows.length).toBe(1)
      expect(String(gaps.rows[0]!.detail)).toMatch(/格式漂移/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('② 空会话 + 无尾标记 → gap 落 sync_gaps（reason=export_fixture_unreported，中文说明可见）', async () => {
    // 空窗且导出流没有窗口声明：可能是真空、也可能被截断 —— 不判失败，但绝不静默
    const m = stubCreateCheck()
    try {
      const store = await fresh()
      // 空窗会触发引擎的假空重试一次（fetch 再来一遍）—— zip 内容恒为空窗形态
      const t = withContent(sessionsById('sessions.export')!, '')
      const r = await runTask(t, ctx(store, { rangeOverride: { start: 0, end: DAY } }))
      expect(r.status).toBe('complete')          // gapHint 不把窗口打成失败（提示 ≠ 失败）
      expect(r.windows).toEqual({ total: 1, succeeded: 1, failed: 0 })
      expect(m.mock.calls.length).toBe(4)        // create+check × 2（假空重试）
      expect(r.gaps.length).toBe(1)
      expect(r.gaps[0]!.reason).toBe('export_fixture_unreported')
      expect(r.gaps[0]!.detail).toMatch(/未上报尾部标记行/)
      expect(r.gaps[0]!.detail).toMatch(/空窗可能确实是空/)
      const gaps = await store.query('SELECT dataset, reason, detail FROM sync_gaps')
      expect(gaps.rows.length).toBe(1)
      expect(gaps.rows[0]!.dataset).toBe('sessions.export')
      expect(String(gaps.rows[0]!.detail)).toMatch(/未上报尾部标记行/)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('③ 尾标记声明的窗口宽于请求 → gap（export_window_mismatch）+ 引擎把 fixture 原文拼进 detail', async () => {
    const W = { start: DAY, end: 2 * DAY }
    const wider = `startTime=${DAY - 1},endTime=${2 * DAY + 1}`
    stubCreateCheck()
    try {
      const store = await fresh()
      const t = withContent(sessionsById('sessions.export')!,
        `${JSON.stringify(SESSION_ROW)}\n${wider}\n`)
      const r = await runTask(t, ctx(store, { rangeOverride: W }))
      // 数据仍落库（重叠由 session_id 幂等吸收），但「窗口被改宽」可见
      expect(r.status).toBe('complete')
      expect(await store.count('sessions')).toBe(1)
      expect(r.gaps.length).toBe(1)
      expect(r.gaps[0]!.reason).toBe('export_window_mismatch')
      expect(r.gaps[0]!.detail).toMatch(/宽于请求窗口/)
      // 引擎侧 fixture 拼接（gapHintDetail）：原文在 detail 尾部可见
      expect(r.gaps[0]!.detail).toContain(`（fixture：${wider}）`)
      await store.close()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('fixture 检测面的粒度断言（C-8）：maxWindowDays ≤6 通过；≥7 或缺失 → 载入期失败并写明理由', () => {
    const t = sessionsById('sessions.export')!
    expect(() => assertFixtureGranularity(t)).not.toThrow()      // 声明的 6 天
    expect(t.maxWindowDays).toBe(6)
    expect(() => assertFixtureGranularity({ ...t, maxWindowDays: 7 }))
      .toThrow(/fixture 检测面已失效/)
    expect(() => assertFixtureGranularity({ ...t, maxWindowDays: 30 }))
      .toThrow(/143\.5h 通过 \/ 144\.0h 报 14004/)
    expect(() => assertFixtureGranularity({ ...t, maxWindowDays: undefined }))
      .toThrow(/fixture 检测面已失效/)
  })
})
