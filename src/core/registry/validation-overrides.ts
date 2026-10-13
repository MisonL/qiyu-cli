import raw from './validate.json' with { type: 'json' }
import { allEndpoints, type EndpointSpec } from './index.js'
import { loadParams, type ParamFile } from './params.js'

export interface ValidationOverride {
  note?: string
  relaxRequired?: string[]
  oneOf?: { anyOf: string[]; message: string }[]
  aliases?: Record<string, string>
}

/** 纯函数：fail-closed 校验（§五 加载规则），坏数据抛普通 Error（模块初始化期由入口兜底为裸崩）。 */
export function validateOverrides(
  rawIn: unknown,
  specs: readonly EndpointSpec[],
  paramsFor: (id: string) => ParamFile,
): Record<string, ValidationOverride> {
  if (rawIn === null || typeof rawIn !== 'object' || Array.isArray(rawIn)) {
    throw new Error('validate.json 顶层必须是对象')
  }
  const ids = new Set(specs.map((s) => s.id))
  const out: Record<string, ValidationOverride> = {}
  for (const [id, v] of Object.entries(rawIn as Record<string, unknown>)) {
    if (!ids.has(id)) throw new Error(`validate.json 的键 ${id} 不是注册表里的接口 id`)
    if (v === null || typeof v !== 'object' || Array.isArray(v)) {
      throw new Error(`validate.json[${id}] 必须是对象`)
    }
    const o = v as Record<string, unknown>
    const file = paramsFor(id)
    const bodyNames = new Set(file.params.filter((p) => p.in === 'body').map((p) => p.name))
    const requiredBody = new Set(file.params.filter((p) => p.in === 'body' && p.required).map((p) => p.name))
    const ov: ValidationOverride = {}
    if (o.note !== undefined) {
      if (typeof o.note !== 'string') throw new Error(`validate.json[${id}].note 必须是字符串`)
      ov.note = o.note
    }
    if (o.relaxRequired !== undefined) {
      if (!Array.isArray(o.relaxRequired) || !o.relaxRequired.every((x) => typeof x === 'string')) {
        throw new Error(`validate.json[${id}].relaxRequired 必须是字符串数组`)
      }
      for (const f of o.relaxRequired as string[]) {
        if (!bodyNames.has(f)) throw new Error(`validate.json[${id}].relaxRequired 引用了非 body 字段 ${f}`)
        if (!requiredBody.has(f)) throw new Error(`validate.json[${id}].relaxRequired 引用了非必填字段 ${f}（无效果死配置）`)
      }
      ov.relaxRequired = o.relaxRequired as string[]
    }
    if (o.oneOf !== undefined) {
      if (!Array.isArray(o.oneOf)) throw new Error(`validate.json[${id}].oneOf 必须是数组`)
      ov.oneOf = (o.oneOf as unknown[]).map((g, gi) => {
        if (g === null || typeof g !== 'object' || Array.isArray(g)) {
          throw new Error(`validate.json[${id}].oneOf[${gi}] 必须是对象`)
        }
        const gg = g as { anyOf?: unknown; message?: unknown }
        if (!Array.isArray(gg.anyOf) || gg.anyOf.length < 2 || !gg.anyOf.every((x) => typeof x === 'string')) {
          throw new Error(`validate.json[${id}].oneOf[${gi}].anyOf 必须是 ≥2 的字符串数组`)
        }
        for (const f of gg.anyOf as string[]) {
          if (!bodyNames.has(f)) throw new Error(`validate.json[${id}].oneOf[${gi}].anyOf 引用了非 body 字段 ${f}`)
        }
        if (typeof gg.message !== 'string') throw new Error(`validate.json[${id}].oneOf[${gi}].message 必须是字符串`)
        return { anyOf: gg.anyOf as string[], message: gg.message }
      })
    }
    if (o.aliases !== undefined) {
      if (o.aliases === null || typeof o.aliases !== 'object' || Array.isArray(o.aliases)) {
        throw new Error(`validate.json[${id}].aliases 必须是对象`)
      }
      const targets = new Set<string>()
      for (const [src, dst] of Object.entries(o.aliases as Record<string, unknown>)) {
        if (typeof dst !== 'string') throw new Error(`validate.json[${id}].aliases 的目标键必须是字符串`)
        if (!bodyNames.has(dst)) throw new Error(`validate.json[${id}].aliases 的目标键 ${dst} 不是 body 字段`)
        if (bodyNames.has(src)) throw new Error(`validate.json[${id}].aliases 的源键 ${src} 本身就是 body 字段（不该被别名覆盖）`)
        if (targets.has(dst)) throw new Error(`validate.json[${id}] 的别名目标 ${dst} 被多个源键指向`)
        targets.add(dst)
      }
      ov.aliases = o.aliases as Record<string, string>
    }
    const known = new Set(['note', 'relaxRequired', 'oneOf', 'aliases'])
    for (const k of Object.keys(o)) {
      if (!known.has(k)) throw new Error(`validate.json[${id}] 含未知键 ${k}`)
    }
    out[id] = ov
  }
  return out
}

/**
 * 生产入口（与 `specs.json` 的 `const SPECS = loadSpecs(raw)` 同款两段式）：
 * **模块级常量**，在模块初始化期求值一次并缓存，**不是每次调用重读**（spec §十.0 第 40 条）。
 * 后果（spec §十.0 明文，均为有意）：validate.json 畸形 → 模块**求值期**抛错 →
 * ESM 静态 import 链下入口模块体未执行、`cli.ts` 的 `.catch()` 未注册 → **未捕获异常**：
 * stdout 0 字节、stderr 原生堆栈、退出码 1；且失败范围是**整个 CLI**（`auth whoami`/`api list` 一起挂）。
 * 这与 `specs.json` 的既有行为逐字一致，B 不引入第二种失败语义。
 * `loadValidationOverrides()` 仅作只读访问器，供 `callOne`/`schema` 取常量值。
 */
const OVERRIDES: Record<string, ValidationOverride> = validateOverrides(raw, allEndpoints(), loadParams)

export function loadValidationOverrides(): Record<string, ValidationOverride> {
  return OVERRIDES
}
