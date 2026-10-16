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
//      必须跳过**（Review Focus 4），空行跳过。该行是**导出自己声明的窗口**（C-8）——
//      之前它被 `void` 丢弃，现在随返回值带出供任务层与请求窗口核对（见 parseExportFixture）。
// 去重契约：**按 session.id，绝不能按导出任务 key**（服务端按（企业,窗口）复用结果，
// 同参数重复创建返回不同 key 相同数据）——本函数只返回行，去重由 upsert(session_id) 幂等吸收。
import { callPaced } from './pace.js'
import type { RateGate } from '../rate-gate.js'
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
  /** 持久化限频闸门（B 高-1 接线）：create/check 经 callPaced，远端限频落冷却行 */
  gate?: RateGate
  /** 注入时钟（callPaced 无 clock 需求，透传给任务层盖章口径保持一致） */
  clock?: () => number
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
 * F 低-4：解出的字节用 Node 内置 TextDecoder 解码（不再引 fflate 的 strFromU8 ——
 * 解压/解密路径本来就是零依赖实现，只有这一处解码借了 fflate）。
 */
export async function unzipPasswordZip(zip: Uint8Array, appKey: string): Promise<string> {
  const password = appKey.slice(0, 12)
  const entry = findEntry(zip)
  const raw = zipDecrypt(entry.comp, password, entry.crcOrSize)
  const inflated = await inflateRaw(raw)
  return new TextDecoder().decode(inflated)
}

interface ZipEntry { comp: Uint8Array; crcOrSize: number }

/** 定位名为 session.txt 的条目（导出 zip 内是 session.txt/message.txt 两个 JSONL——
 * 只吃会话，message.txt 即使排在前面也不取；找不到显式抛错）。 */
function findEntry(zip: Uint8Array): ZipEntry {
  const u16 = (o: number): number => zip[o] | (zip[o + 1] << 8)
  const u32 = (o: number): number => (zip[o] | (zip[o + 1] << 8) | (zip[o + 2] << 16) | (zip[o + 3] << 24)) >>> 0
  if (u32(0) !== 0x04034b50) throw new Error('不是 zip 容器（本地文件头签名不符）')
  const decoder = new TextDecoder()
  // 逐条目扫本地文件头（30 字节定长 + 名 + 扩展），按名字匹配 session.txt
  let o = 0
  while (o + 30 <= zip.length && u32(o) === 0x04034b50) {
    const flags = u16(o + 6)
    const method = u16(o + 8)
    const nlen = u16(o + 26)
    const elen = u16(o + 28)
    const name = decoder.decode(zip.subarray(o + 30, o + 30 + nlen))
    // flags bit3（数据描述符）：本地头的 crc 与 csize 都置 0，真实值只在 central directory。
    // ⚠️ D 中-1：此时**绝不能退化成「不校验、长度按 0 算」**——crc=0 会让错密码静默吐
    // 乱码，csize=0 会让本地头扫描原地打转（把密文当文件头读）。必须回中央目录取
    // 真实 crc + csize；取不到就显式失败（响应形态漂移，宁可失败不给乱码）。
    const cd = (flags & 0x8) !== 0 ? centralEntry(zip, name) : null
    const csize = cd !== null ? cd.csize : u32(o + 18)
    const crcStored = cd !== null ? cd.crc : u32(o + 14)
    if (name === 'session.txt') {
      if (!(flags & 0x1)) throw new Error('导出 zip 未加密（与实测形态不符，注册表/文档假设失效）')
      if (method !== 8) throw new Error(`不支持的压缩方法：${method}（预期 deflate=8）`)
      const dataStart = o + 30 + nlen + elen
      return { comp: zip.subarray(dataStart, dataStart + csize), crcOrSize: crcStored }
    }
    o = o + 30 + nlen + elen + csize
  }
  throw new Error('导出 zip 内没有 session.txt 条目（响应形态漂移？）')
}

/**
 * 从 central directory 取指定条目的真实 CRC 与压缩长度（bit3 数据描述符形态的唯一来源）。
 * 路径：EOCD（尾部 22 字节定长 + 可选注释）→ CD 起始偏移/条目数 → 逐条 CD 记录
 *（46 字节定长 + 名 + 扩展 + 注释）按名匹配。找不到/结构不符 → 显式抛错：宁可失败，
 * 也绝不在「无校验字节可对」的状态下把错密码的乱码当数据吐出去。
 */
function centralEntry(zip: Uint8Array, name: string): { crc: number; csize: number } {
  const u16 = (o: number): number => zip[o] | (zip[o + 1] << 8)
  const u32 = (o: number): number => (zip[o] | (zip[o + 1] << 8) | (zip[o + 2] << 16) | (zip[o + 3] << 24)) >>> 0
  // EOCD 从尾往前找（签名 0x06054b50；注释最长 64KB）
  let eocd = -1
  for (let i = zip.length - 22; i >= 0 && i >= zip.length - 22 - 65_535; i--) {
    if (u32(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('zip 缺 central directory 结束记录（EOCD）——无法校验解压密码，拒绝落库')
  const count = u16(eocd + 10)
  let o = u32(eocd + 16)
  const decoder = new TextDecoder()
  for (let i = 0; i < count; i++) {
    if (o + 46 > zip.length || u32(o) !== 0x02014b50) {
      throw new Error('zip central directory 结构不符——无法校验解压密码，拒绝落库')
    }
    const nlen = u16(o + 28)
    const elen = u16(o + 30)
    const clen = u16(o + 32)
    const entryName = decoder.decode(zip.subarray(o + 46, o + 46 + nlen))
    if (entryName === name) return { crc: u32(o + 16), csize: u32(o + 20) }
    o = o + 46 + nlen + elen + clen
  }
  throw new Error(`zip central directory 内没有 ${name} 条目——无法校验解压密码，拒绝落库`)
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
 * 导出尾部标记行（C-8）：`startTime=…,endTime=…` 的两个毫秒时间戳 = **导出自己的窗口声明**。
 * 实测（private/raw/session.txt，4687 行样本）：文件里恰好一行，紧随全部 JSON 行之后，
 * 声明一个 24h 窗口且边界不落在整日/整分上 —— 与「客户端传什么窗口」同形（1 天窗口调用）。
 * 形态判定与解析共用本函数：parseJsonl 的「跳过尾行」与任务层的窗口核对不会各写一套正则。
 * 数值宽度上限 16 位十进制（epoch 毫秒 13 位）同时是**长度上界**：该行最多 ~54 字符，
 * 不存在「无限长原文」——更宽的数字串不是这个形态，按形态漂移显式失败（不静默截断放行）。
 */
export function parseExportFixture(line: string): { start: number; end: number } | null {
  const m = /^startTime=(\d{1,16}),endTime=(\d{1,16})$/.exec(line)
  return m === null ? null : { start: Number(m[1]), end: Number(m[2]) }
}

/** JSONL 解析（Review Focus 4 钉死）：逐行 JSON；空行跳过；
 * 末尾非 JSON 尾部标记行（`startTime=...,endTime=...`）跳过并置 tailSkipped=true、
 * 原文带出为 fixture（C-8：该信号此前被调用方 `void` 丢弃，任务层无从核对导出窗口）。
 * 非 JSON 且非尾行 → 显式失败（响应形态漂移必须可见，不能静默丢行）。
 * ⚠️ F 中-1：错误消息**只带行号与长度，不带原文** —— session.txt 的每一行都是 PII
 *（电话/邮箱/地址/IP/CRM 备注），而错误消息会进 stdout、日志与 Agent 上下文；
 * 把行内容截 80 字符贴出去等于把 PII 抄了一份出去（仓库存放区域不可控）。
 * 尾部标记行是唯一的例外（它只有两个整数时间戳、无 PII，且长度由形态限死 ≤54 字符）。
 */
export function parseJsonl(text: string): { rows: Record<string, unknown>[]; tailSkipped: boolean; fixture?: string } {
  const rows: Record<string, unknown>[] = []
  let tailSkipped = false
  let fixture: string | undefined
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i].trim()
    if (s === '') continue
    if (parseExportFixture(s) !== null) {
      tailSkipped = true
      fixture = s
      continue
    }
    try {
      rows.push(JSON.parse(s) as Record<string, unknown>)
    } catch {
      // 不回显原文（PII 红线）：行号 + 字节长度足以定位与判断形态漂移。
      throw new Error(`session.txt 第 ${i + 1} 行无法解析为 JSON（且不是已知的尾部标记行）：` +
        `该行长度 ${s.length} 字节。原始行内容不回显（含用户 PII），请直接查看导出文件对应行`)
    }
  }
  return { rows, tailSkipped, ...(fixture === undefined ? {} : { fixture }) }
}

/**
 * 四步流水线：create → poll → download(ctx.fetchZip) → unzip + parse。
 * 返回的 sessions 是未 enrich 的原始行（列投影/派生在 sessions.ts 的任务层）；
 * `fixture` 是导出尾部标记行的原文（C-8：**不再 `void` 丢弃** —— 它是导出自己声明的
 * 窗口，交由调用方与请求窗口核对；缺失/不符都在任务层有出口）。
 */
export async function runExportPipeline(w: Range,
  ctx: PipelineCtx): Promise<{ sessions: Record<string, unknown>[]; fixture?: string }> {
  if (!Number.isFinite(w.start) || !Number.isFinite(w.end) || w.end <= w.start) {
    throw usage(`会话导出窗口无效：start=${w.start}, end=${w.end}（start==end / start>end / 超限同为 14004，无法区分——必须本地保证有效）`)
  }
  // —— 1. create：{start, end}（毫秒；code 实测可选且不校验，不传误导性参数）——
  // B 高-1：走 callPaced —— 裸 call 让本地令牌桶（export.session 10 秒 6 次）的拒绝
  // 直接冒泡成 fetch_failed gap，远端限频的证据（冷却行）也没人写。
  const created = await callPaced('export.session', { start: w.start, end: w.end }, ctx)
  const key = messageOf(created, 'export.session')
  // —— 2. poll：14403（core 判 kind=pending 抛出）重试，有界 ——
  const maxPolls = ctx.maxPolls ?? 120
  let link = ''
  for (let i = 0; i < maxPolls; i++) {
    if (ctx.pollIntervalMs !== undefined ? ctx.pollIntervalMs > 0 : true) {
      await sleep(ctx.pollIntervalMs ?? 5_000)
    }
    try {
      // export.session.check 在限频表里显式登记为 null（无限频）—— 仍走 callPaced
      // 以统一路径（本地桶/错误形态处理一致；闸门侧 null 登记即豁免，不写冷却行）。
      const checked = await callPaced('export.session.check', { key }, ctx)
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
  const { rows, fixture } = parseJsonl(text)
  return { sessions: rows, ...(fixture === undefined ? {} : { fixture }) }
}

/** usage 错误（退出码 2）：本地窗口参数问题，重试无用。 */
function usage(msg: string): Error {
  const e = new Error(msg)
  ;(e as { kind?: string }).kind = 'usage'
  return e
}
