import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

export type BodyKind = 'json' | 'none' | 'form' | 'xml' | 'multipart' | 'text'
export interface ParamSpec {
  name: string
  in: 'query' | 'body' | 'path' | 'header'
  required: boolean
  type?: string
  description?: string
  example?: string
}
export interface ResponseShape { kind: string }
export interface ParamFile {
  params: ParamSpec[]
  bodyKind: BodyKind
  responseShape: ResponseShape
}

const BODY_KINDS = new Set<BodyKind>(['json', 'none', 'form', 'xml', 'multipart', 'text'])
const IN_KINDS = new Set(['query', 'body', 'path', 'header'])

/** 运行时校验 params 文件结构（in/required/type/bodyKind 枚举；同名跨 in 护栏），失败即抛。 */
export function validateParamsFile(id: string, raw: unknown): ParamFile {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`params/${id}.json 顶层必须是对象`)
  }
  const o = raw as Record<string, unknown>
  if (!Array.isArray(o.params)) throw new Error(`params/${id}.json 缺少 params 数组`)
  if (typeof o.bodyKind !== 'string' || !BODY_KINDS.has(o.bodyKind as BodyKind)) {
    throw new Error(`params/${id}.json 的 bodyKind 非法：${JSON.stringify(o.bodyKind)}`)
  }
  const rs = o.responseShape
  if (rs === null || typeof rs !== 'object' || typeof (rs as { kind?: unknown }).kind !== 'string') {
    throw new Error(`params/${id}.json 的 responseShape 必须是含 kind 字符串的对象`)
  }
  const seenBodyNames = new Set<string>()
  const seenQueryNames = new Set<string>()
  const params: ParamSpec[] = o.params.map((p, i) => {
    const e = p as Record<string, unknown>
    if (typeof e.name !== 'string' || !e.name) throw new Error(`params/${id}.json[${i}] 缺少 name`)
    if (typeof e.in !== 'string' || !IN_KINDS.has(e.in)) {
      throw new Error(`params/${id}.json[${i}] 的 in 非法：${JSON.stringify(e.in)}`)
    }
    if (typeof e.required !== 'boolean') {
      throw new Error(`params/${id}.json[${i}]（${e.name}）的 required 必须是布尔`)
    }
    if (e.in === 'body') {
      if (seenQueryNames.has(e.name as string)) {
        throw new Error(`params/${id}.json 的字段 ${e.name} 同时出现在 body 与 query —— (name,in) 身份歧义`)
      }
      seenBodyNames.add(e.name as string)
    } else if (e.in === 'query') {
      if (seenBodyNames.has(e.name as string)) {
        throw new Error(`params/${id}.json 的字段 ${e.name} 同时出现在 body 与 query —— (name,in) 身份歧义`)
      }
      seenQueryNames.add(e.name as string)
    }
    return e as unknown as ParamSpec
  })
  return { params, bodyKind: o.bodyKind as BodyKind, responseShape: rs as ResponseShape }
}

let injectedRoot: string | undefined
/** 测试专用：设置 params 根目录。生产不调用（injectedRoot 恒 undefined，用 import.meta.url 定位）。 */
export function setParamsRoot(dir: string | undefined): void { injectedRoot = dir }

// ⚠️ 同进程内 root 一经首次读取即并入缓存（键为 `${root}\0${id}`）。同一路径内容被改写后
// 要靠新模块图才能重读——但改 root 本身不需要 reset（不同 root 是不同缓存键）。
const cache = new Map<string, ParamFile>()

/** 惰性读 + 缓存；缺文件/畸形 JSON/结构非法 → 抛 kind:'internal'。 */
export function loadParams(id: string, root: string | undefined = injectedRoot): ParamFile {
  const base = root ?? fileURLToPath(new URL('.', import.meta.url))
  const key = `${base}\0${id}`
  const hit = cache.get(key)
  if (hit) return hit
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(fileURLToPath(new URL(`./params/${id}.json`, pathToFileURL(base + '/'))), 'utf8'))
  } catch (e) {
    throw Object.assign(
      new Error(`读取 params/${id}.json 失败：${e instanceof Error ? e.message : String(e)}`),
      { code: 'internal', kind: 'internal', retryable: false,
        message: `params/${id}.json 缺失或损坏 —— 这是 CLI 的打包/注册表缺陷，不是你的请求或服务端的问题`,
        hint: '重装或报告此问题；params 文件缺失或损坏' },
    )
  }
  let file: ParamFile
  try {
    file = validateParamsFile(id, raw)
  } catch (e) {
    throw Object.assign(
      new Error(`params/${id}.json 结构非法：${e instanceof Error ? e.message : String(e)}`),
      { code: 'internal', kind: 'internal', retryable: false,
        message: `params/${id}.json 结构非法 —— 这是 CLI 的打包/注册表缺陷，不是你的请求或服务端的问题`,
        hint: '重装或报告此问题；params 文件缺失或损坏' },
    )
  }
  cache.set(key, file)
  return file
}
