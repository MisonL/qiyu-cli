import type { ParamFile } from './registry/params.js'
import type { ValidationOverride } from './registry/validation-overrides.js'
import type { EndpointSpec } from './registry/index.js'

export interface Violation { kind: string; field?: string; message: string }
export interface ValidateResult { hard: Violation[]; soft: Violation[] }

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/** 归一化别名（D8）：返回改写后的 body 与 alias_normalized 警告；源/目标键冲突 → 抛（硬）。 */
export function normalizeAliases(
  file: ParamFile, body: unknown, ov: ValidationOverride | undefined,
): { body: unknown; warnings: Violation[] } {
  // ⚠️ 非普通对象原样返回：别名扫描只对普通对象做，绝不在 undefined 上调 Object.keys/展开。
  if (!ov?.aliases || !isPlainObject(body)) return { body, warnings: [] }
  const aliases = ov.aliases
  const srcPresent = Object.keys(aliases).filter((s) => Object.hasOwn(body, s))
  if (srcPresent.length === 0) return { body, warnings: [] }
  for (const s of srcPresent) {
    if (Object.hasOwn(body, aliases[s])) {
      throw new Error(`body 同时含别名源键 ${s} 与目标键 ${aliases[s]} —— 只传其一（不预设谁优先）`)
    }
  }
  // 按 body 键出现顺序输出 warning
  const warnings: Violation[] = []
  const rewritten: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(body)) {
    if (Object.hasOwn(aliases, k)) {
      const dst = aliases[k]
      rewritten[dst] = v
      warnings.push({ kind: 'alias_normalized', field: k,
        message: `${k} 已按本接口约定改写为 ${dst} 发送；请求正常，无需重试` })
    } else {
      rewritten[k] = v
    }
  }
  return { body: rewritten, warnings }
}
