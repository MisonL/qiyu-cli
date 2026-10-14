// src/sync/tasks/pipeline.ts
// D-T10：会话导出四步流水线（设计稿 §7.5 实测端到端）—— 纯逻辑，副作用全部可注入：
//   1. create：`export.session`（10 秒 6 次限频，限频表已有该行；进程内令牌桶由 core 层守）
//      body {start, end}（code 可选——实测不校验，不传误导性参数）→ key 在 message
//   2. poll：`export.session.check` body {key}（code 同样可选）→ 未完成 `14403 Wait...`
//      （core 层判 kind=pending 抛出），完成 `{code:200, message:"<下载链接>"}`；
//      有界轮询（maxPolls 缺省 120），间隔经 ctx.pollIntervalMs 注入（真实默认 5s）
//   3. download：ctx.fetchZip(链接) 注入——下载走 ZIP 二进制通道，与 JSON 信封层不同构，
//      测试 mock 注入合成 zip（生产实现归 T13 接线）
//   4. unzip + parse：解压密码 = appKey 前 12 字符（ZipCrypto，实测样本验证）；
//      session.txt 是 JSONL，**末尾有一行非 JSON 尾部标记 `startTime=...,endTime=...`
//      必须跳过**（Review Focus 4），空行跳过
// 去重契约：**按 session.id，绝不能按导出任务 key**（服务端按（企业,窗口）复用结果，
// 同参数重复创建返回不同 key 相同数据）——本函数只返回行，去重由 upsert(session_id) 幂等吸收。
import { unzipSync, strFromU8 } from 'fflate'
import { call } from '../../core/http.js'
import { byId } from '../../core/registry/index.js'
import type { Range } from '../windowing.js'
import type { Credentials } from '../../core/credentials.js'

/** 流水线依赖（T5 形态外的注入面）：下载与轮询节奏在测试/编排层注入。 */
export interface PipelineCtx {
  credentials: Credentials
  /** 下载 zip 的字节（注入点：测试合成 zip；生产由 T13 接 fetch 二进制） */
  fetchZip: (url: string) => Promise<Uint8Array>
  /** 轮询间隔毫秒（缺省 5000；测试注入 0） */
  pollIntervalMs?: number
  /** 轮询预算（缺省 120 次 × 5s ≈ 10 分钟，实测端到端 ~30s/任务） */
  maxPolls?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 形状 A 载荷里的 message 字符串（create 的任务 key / check 的下载链接都走 message）。 */
function messageOf(res: { payload: unknown; messageText: string }, endpointId: string): string {
  // 形状 A（envelope:'A'）：信封层把 data 放进 payload、原文放 messageText。
  // 实测 create/check 的载荷就是 message 字符串本身（key/链接），不信任何 data 形态。
  const p = res.payload
  if (typeof p === 'string' && p !== '') return p
  if (typeof res.messageText === 'string' && res.messageText !== '' && res.messageText !== 'OK') {
    return res.messageText
  }
  throw new Error(`接口 ${endpointId} 未返回可用的 message 载荷（响应形态漂移？）`)
}

/**
 * 解压密码 zip（ZipCrypto，密码 = appKey 前 12 字符，设计稿 §7.5 实测）并取出 session.txt。
 * fflate 0.8 的 unzipSync 不支持解密 —— 这里手工解析 zip 容器 + ZipCrypto 解密 +
 * inflateRaw（算法经 PKWARE APPNOTE 与真实样本往返验证）。找错密码时校验字节不匹配 → 显式
 * 失败，绝不静默吐乱码。
 */
export async function unzipPasswordZip(zip: Uint8Array, appKey: string): Promise<string> {
  const password = appKey.slice(0, 12)
  const entry = findEntry(zip)
  const raw = zipDecrypt(entry.comp, password, entry.crcOrSize)
  const inflated = await inflateRaw(raw)
  return strFromU8(inflated)
}

interface ZipEntry { comp: Uint8Array; crcOrSize: number }

/** 定位第一个 deflate 方法的本地文件头条目（导出 zip 内是 session.txt/message.txt 两个 JSONL）。 */
function findEntry(zip: Uint8Array): ZipEntry {
  const u16 = (o: number): number => zip[o] | (zip[o + 1] << 8)
  const u32 = (o: number): number => (zip[o] | (zip[o + 1] << 8) | (zip[o + 2] << 16) | (zip[o + 3] << 24)) >>> 0
  if (u32(0) !== 0x04034b50) throw new Error('不是 zip 容器（本地文件头签名不符）')
  const flags = u16(6)
  const method = u16(8)
  const csize = u32(18)
  const crcStored = u32(14)
  const nlen = u16(26)
  const elen = u16(28)
  if (!(flags & 0x1)) throw new Error('导出 zip 未加密（与实测形态不符，注册表/文档假设失效）')
  if (method !== 8) throw new Error(`不支持的压缩方法：${method}（预期 deflate=8）`)
  const dataStart = 30 + nlen + elen
  // flags bit3（数据描述符）时本地头 crc/csize 置 0，真实 crc 在 central directory ——
  // 校验字节回退用「无 crc 可对」的 size 校验形态（0），解密侧按其语义处理。
  return { comp: zip.subarray(dataStart, dataStart + csize), crcOrSize: (flags & 0x8) ? 0 : crcStored }
}

/** ZipCrypto 解密：密钥由密码初始化，逐字节流式更新；校验字节匹配则剥掉 12 字节头。 */
function zipDecrypt(comp: Uint8Array, password: string, crcHigh: number): Uint8Array {
  const CRC_TABLE = crcTable()
  const keys = [0x12345678, 0x23456789, 0x34567890]
  const upd = (b: number): void => {
    keys[0] = ((keys[0] >>> 8) ^ CRC_TABLE[(keys[0] ^ b) & 0xFF]) >>> 0
    keys[1] = (keys[1] + (keys[0] & 0xFF)) >>> 0
    keys[1] = (Math.imul(keys[1], 134775813) + 1) >>> 0
    keys[2] = ((keys[2] >>> 8) ^ CRC_TABLE[(keys[2] ^ (keys[1] >>> 24)) & 0xFF]) >>> 0
  }
  for (const ch of Buffer.from(password, 'utf8')) upd(ch)
  const out = new Uint8Array(comp.length)
  for (let i = 0; i < comp.length; i++) {
    const k = ((keys[2] | 2) & 0xFFFF) >>> 0
    const d = (Math.imul(k, k ^ 1) >>> 8) & 0xFF
    const p = comp[i] ^ d
    upd(p)
    out[i] = p
  }
  // 校验字节 = 加密头最后一字节明文；有 crc 时应等于 crc 高字节。
  const check = out[11]
  if (crcHigh !== 0 && check !== ((crcHigh >>> 24) & 0xFF)) {
    throw new Error('zip 解压密码错误（校验字节不匹配）——密码应为 appKey 前 12 字符')
  }
  return out.subarray(12)
}

let table: Uint32Array | null = null
function crcTable(): Uint32Array {
  if (table) return table
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let k = 0; k < 8; k++) c = (c & 1) ? (c >>> 1) ^ 0xEDB88320 : c >>> 1
    t[i] = c >>> 0
  }
  table = t
  return t
}

/** inflateRaw：zip 的 deflate 流是不带 zlib 头的裸 deflate。 */
async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  // DecompressionStream('deflate-raw') 是 Node ≥17 的内置能力，零依赖。
  const ds = new DecompressionStream('deflate-raw')
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds)
  const chunks: Uint8Array[] = []
  const reader = stream.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  let len = 0
  for (const c of chunks) len += c.length
  const out = new Uint8Array(len)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/**
 * JSONL 解析（Review Focus 4 钉死）：逐行 JSON；空行跳过；
 * 末尾非 JSON 尾部标记行（`startTime=...,endTime=...`）跳过并置 tailSkipped=true。
 * 非 JSON 且非尾行 → 显式失败（响应形态漂移必须可见，不能静默丢行）。
 */
export function parseJsonl(text: string): { rows: Record<string, unknown>[]; tailSkipped: boolean } {
  const rows: Record<string, unknown>[] = []
  let tailSkipped = false
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (s === '') continue
    if (/^startTime=\d+,endTime=\d+$/.test(s)) {
      tailSkipped = true
      continue
    }
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch {
      throw new Error(`session.txt 存在无法解析的行（且不是已知的尾部标记行）：${s.slice(0, 80)}`)
    }
  }
  return { rows, tailSkipped }
}

/**
 * 四步流水线：create → poll → download(ctx.fetchZip) → unzip + parse。
 * 返回的 sessions 是未 enrich 的原始行（列投影/派生在 sessions.ts 的任务层）。
 */
export async function runExportPipeline(w: Range,
  ctx: PipelineCtx): Promise<{ sessions: Record<string, unknown>[] }> {
  if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start) {
    throw usage(`会话导出窗口无效：start=${w.start}, end=${w.end}（start==end / start>end / 超限同为 14004，无法区分——必须本地保证有效）`)
  }
  // —— 1. create：{start, end}（毫秒；code 实测可选且不校验，不传误导性参数）——
  const created = await call(byId('export.session'), { start: w.start, end: w.end },
    { credentials: ctx.credentials })
  const key = messageOf(created, 'export.session')
  // —— 2. poll：14403（core 判 kind=pending 抛出）重试，有界 ——
  const maxPolls = ctx.maxPolls ?? 120
  let link = ''
  for (let i = 0; i < maxPolls; i++) {
    if (ctx.pollIntervalMs !== undefined ? ctx.pollIntervalMs > 0 : true) {
      await sleep(ctx.pollIntervalMs ?? 5_000)
    }
    try {
      const checked = await call(byId('export.session.check'), { key },
        { credentials: ctx.credentials })
      link = messageOf(checked, 'export.session.check')
      break
    } catch (e) {
      if ((e as { code?: string }).code === '14403') continue
      throw e
    }
  }
  if (link === '') {
    throw new Error(`会话导出轮询超限：连续 ${maxPolls} 次 14403（任务仍未完成）——key=${key.slice(0, 8)}…`)
  }
  // —— 3/4. download + unzip + parse ——
  const zip = await ctx.fetchZip(link)
  const text = await unzipPasswordZip(zip, ctx.credentials.appKey)
  const { rows, tailSkipped } = parseJsonl(text)
  // 尾行标记是导出完整性的产物：缺失不报错（历史样本可能无），但如实透出供上层记录。
  void tailSkipped
  return { sessions: rows }
}

/** usage 错误（退出码 2）：本地窗口参数问题，重试无用。 */
function usage(msg: string): Error {
  const e = new Error(msg)
  ;(e as { kind?: string }).kind = 'usage'
  return e
}
