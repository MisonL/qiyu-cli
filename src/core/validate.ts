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

const BODY_TYPE_MAP: Record<string, (v: unknown) => boolean> = {
  string: (v) => typeof v === 'string',
  integer: (v) => typeof v === 'number',
  number: (v) => typeof v === 'number',
  boolean: (v) => typeof v === 'boolean',
  array: (v) => Array.isArray(v),
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
}
/** 渲染实际类型（固定词汇，不用 typeof —— typeof null/[] 都是 object）。 */
function renderActual(v: unknown): string {
  if (v === null) return 'null'
  if (Array.isArray(v)) return '数组'
  return typeof v
}

/** 纯函数：顶层形状契约 + 硬/软规则；不碰 I/O。 */
export function validateBody(
  spec: EndpointSpec, file: ParamFile, body: unknown,
  ov: ValidationOverride | undefined, mode: { strict: boolean },
): ValidateResult {
  // hasBodySchema 判据 = 合取式（§三/§八.6）：bodyKind==='json' 且 body 参数数 > 0。
  const bodyParams = effectiveBodyParams(file, ov)
  const hasBodySchema = file.bodyKind === 'json' && bodyParams.length > 0
  // bodyKind !== 'json' 的接口根本不进形状表：只可能出 non_json_body（软）。
  // ⚠️ message 不得含「未验证」（spec §四 第 68 条③ + 验收 9）——那是「值得再试」的措辞；只陈述「已发出 + 不要重发」。
  if (file.bodyKind !== 'json') {
    if (body === undefined) return { hard: [], soft: [] }
    return { hard: [], soft: [{ kind: 'non_json_body',
      message: `本接口 body_kind 是 ${file.bodyKind}，你的 --body 已按原样字面量发送、未经字段校验；本 CLI 不构造非 JSON 的 body 编码。该字面量已随请求发出，不要重发（重发 = 再执行一次接口，写接口会重复写入）` }] }
  }
  if (!hasBodySchema) return { hard: [], soft: [] }

  const hard: Violation[] = []
  // 非对象 body + 有表 → 硬拒
  if (body === undefined) {
    const missing = bodyParams.filter((p) => p.required)
    if (missing.length > 0) {
      return { hard: [{ kind: 'missing_required', field: missing[0].name,
        message: `未传 --body，但该接口需要 JSON 对象 body（缺必填字段：${missing.map((p) => p.name).join('、')}）。用 qiyu api schema ${spec.id} 查看完整参数表` }], soft: [] }
    }
    return { hard: [], soft: [] }
  }
  if (!isPlainObject(body)) {
    return { hard: [{ kind: 'non_object_body',
      message: `该接口需要 JSON 对象 body，实际是 ${body === null ? 'null' : Array.isArray(body) ? '数组' : '标量'}。用 qiyu api schema ${spec.id} 查看参数表` }], soft: [] }
  }

  const bodyNames = new Set(bodyParams.map((p) => p.name))
  const aliasSrc = new Set(Object.keys(ov?.aliases ?? {}))
  const soft: Violation[] = []
  // 硬：逐字段缺必填（params 表顺序）
  for (const p of bodyParams) {
    if (p.required && (!Object.hasOwn(body, p.name) || body[p.name] === undefined)) {
      hard.push({ kind: 'missing_required', field: p.name,
        message: `缺少必填字段 ${p.name}（body 里没有该键）。用 qiyu api schema ${spec.id} 查看完整参数表` })
    }
  }
  // 硬：one-of 组（组内任一存在即满足；全缺 → 用 override message），排在 per-field 之后
  for (const g of ov?.oneOf ?? []) {
    if (!g.anyOf.some((f) => Object.hasOwn(body, f) && body[f] !== undefined)) {
      hard.push({ kind: 'one_of_missing', message: g.message })
    }
  }
  if (hard.length > 0) return { hard, soft: [] }

  // 软：unknown_field（body 键序）、type_mismatch（params 表序）
  for (const k of Object.keys(body)) {
    if (!bodyNames.has(k) && !aliasSrc.has(k)) {
      soft.push({ kind: 'unknown_field', field: k,
        message: `字段 ${k} 不在本接口的文档参数表中，服务端可能忽略它；但本次请求已经发出（退出码 0）——不要重发（重发 = 再执行一次接口，写接口会重复写入）` })
    }
  }
  for (const p of bodyParams) {
    if (p.type && Object.hasOwn(body, p.name) && body[p.name] !== undefined) {
      const check = BODY_TYPE_MAP[p.type]
      if (check && !check(body[p.name])) {
        soft.push({ kind: 'type_mismatch', field: p.name,
          message: `字段 ${p.name} 声明类型 ${p.type}，实际是 ${renderActual(body[p.name])}。本值已随请求发出（退出码 0），不要重发` })
      }
    }
  }
  // strict 升级：unknown_field / type_mismatch 从软转硬（硬形态 message 不得含「已发出」）
  if (mode.strict) {
    const upgraded = soft.filter((w) => w.kind === 'unknown_field' || w.kind === 'type_mismatch')
    if (upgraded.length > 0) {
      const hardMsgs: Violation[] = upgraded.map((w) => ({ kind: w.kind, field: w.field,
        message: w.kind === 'unknown_field'
          ? `本地参数表未收录字段 ${w.field}，未发出请求，请修正后重试（这是本地参数表闭集一致性检查，不是对服务端行为的保证 —— 若确认该字段合法，请改用默认模式或报告缺失的注册表项，不要删字段重试）`
          : `字段 ${w.field} 类型不符（声明类型与传入值不符），未发出请求，请修正后重试 —— 不要删字段重试` }))
      return { hard: hardMsgs, soft: [] }
    }
  }
  return { hard: [], soft }
}
