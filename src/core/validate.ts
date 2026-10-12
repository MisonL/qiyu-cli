import type { ParamFile, ParamSpec } from './registry/params.js'
import type { ValidationOverride } from './registry/validation-overrides.js'
import type { EndpointSpec } from './registry/index.js'

export interface Violation { kind: string; field?: string; message: string }
export interface ValidateResult { hard: Violation[]; soft: Violation[] }

/** 应用 override 后的**有效 body 参数表**（只含 `in === 'body'` 的参数）：把 `ov.relaxRequired` 列出的
 *  body 字段 required 降为 false；其余原样。
 *  ⚠️ **必须只返回 body 参数**（不是 `file.params` 全量）：`validateBody` 拿它做
 *  `hasBodySchema = bodyKind==='json' && bodyParams.length > 0` 与缺必填判定——若把 query 参数
 *  也算进来，像 `tag.all`（json、0 body、3 个 required 的鉴权 query）会被误判「有表」且硬拒
 *  「缺 appKey/time/checksum」（那是 CLI 自填的 query，从不经 --body）。见验收 8/27。
 *  ⚠️ `api schema` 的 params 输出（Task 7）与 `validateBody` 的缺必填判定（Task 5）**共用本函数**
 *  （spec §十.0 :999-1004）；schema 用 `file.params` 取全量、用本函数的返回值只查 body 字段的 override。
 *  纯函数、无 I/O。 */
export function effectiveBodyParams(file: ParamFile, ov: ValidationOverride | undefined): ParamSpec[] {
  const bodyOnly = file.params.filter((p) => p.in === 'body')
  if (!ov?.relaxRequired || ov.relaxRequired.length === 0) return bodyOnly
  const relax = new Set(ov.relaxRequired)
  return bodyOnly.map((p) => (relax.has(p.name) ? { ...p, required: false } : p))
}

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
