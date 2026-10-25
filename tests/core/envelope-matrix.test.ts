// tests/core/envelope-matrix.test.ts —— §12 第二条：信封矩阵表驱动
//
// 设计稿 §9.0 记录：**26 种顶层 key 组合 / 40 种 key+type 签名**（原始 40 条实测样本
// 不在仓库里）。本文件把其中**有语义差异的维度**抽成矩阵，逐格断言：
//
//   行 = 信封形状（A / B / C / D / D-nf / 未登记（undefined）/ 裸数组 / Spring 404）
//   列 = `message` 的 5 种类型（string / object / integer / boolean / array）
//
// ⚠️ **矩阵覆盖的是「形状 × 类型」的语义，不是那 40 条样本本身** —— 后者是实测
// 快照，会随服务端演化；前者是契约。每格要么断言"怎么解释"，要么显式标注
// "这一格没有实测依据、按哪条通用规则处理"。不留空格：空格等于没人检查过。
//
// ⚠️ 与 envelope.test.ts 的分工：那边按**接口**讲每个真实缺陷的故事（可读性），
// 这边按**矩阵**穷举组合（覆盖面）。两边断言重叠是刻意的 —— 表驱动漏一行时，
// 故事那条会红；故事被改写时，矩阵那条会红。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalize } from '../../src/core/envelope.js'
import type { EnvelopeShape } from '../../src/core/envelope.js'

/**
 * 矩阵**实际喂进过 `normalize` 的**形状。
 *
 * ⚠️ 这是一个**观测记录**，不是手抄清单：下面每个 `describe` 块的用例都在真正调用
 * `normalize` 时把形状登记进来。自检只认这里 —— 早先的写法是手抄一份
 * `MATRIX_SHAPES = ['A','B','C','D','D-nf']` 去跟类型定义比，Sourcery（2026-10-25）
 * 指出它守不住真正该守的东西：往 `EnvelopeShape` 加一个新形状、再把它抄进
 * `MATRIX_SHAPES`，自检照样通过，而那个形状的语义**没有任何用例**。观测式登记不会
 * 有这个问题 —— 没跑过的形状不可能出现在集合里。
 */
const EXERCISED = new Set<string>()

/** 带登记地调用 `normalize`：矩阵里所有断言都走这里，保证 `EXERCISED` 反映真实覆盖。 */
function normalizeIn(raw: unknown, shape?: EnvelopeShape) {
  if (shape !== undefined) EXERCISED.add(shape)
  return normalize(raw, shape)
}

/** 5 种 message 类型 —— 设计稿 §9.0 实测到的全部形态。 */
const MESSAGES = {
  string: 'OK',
  'json-object': '{"a":1}',
  'json-array': '[1,2]',
  integer: 200,
  boolean: true,
  array: [{ a: 1 }],
} as const

type MessageKey = keyof typeof MESSAGES

/** 把 message 塞进信封；`undefined` 表示**没有 message 键**（与「值为空」是两回事）。 */
function envelope(code: unknown, message: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const o: Record<string, unknown> = { code, ...extra }
  if (message !== undefined) o.message = message
  return o
}

// ⚠️ `EXERCISED` 是**运行期**登记，所以末尾那条覆盖度自检依赖「前面的用例先跑」。
// vitest 在同一文件内按声明顺序串行执行 `it`，成立；若哪天把自检挪到前面，
// 它会因为「一个形状都没登记」而红 —— 这是期望的失败方向（宁可误报，不可漏报）。
describe('信封矩阵：形状 × message 类型（§12）', () => {
  // ——— 形状 C：数据藏在 message 里的 JSON 字符串 ———
  // 这一族**每个错误也返回 code:200**，所以「message 解析不出 JSON ⇒ 失败」是
  // 设计稿 §9.2 头号静默失败的防线。
  describe('形状 C（message 承载载荷，code 恒为 200）', () => {
    it.each([
      ['json-object', '{"a":1}', true, false],
      ['json-array', '[1,2]', true, false],
      // 空载荷 → 成功但查无此物（`smstask.status` 的 `message:"[]"`）
      ['empty-array', '[]', true, true],
      ['empty-object', '{}', true, true],
      // 纯文本 / 数字 / 布尔 / 顶层数组：**失败**（形状 C 上解析不出 JSON 就是错误）
      ['string', 'OK', false, false],
      ['string-with-code', '14501 (endTime-startTime)/millsADay > 31 is invalid', false, false],
      ['integer', '200', true, false],   // '200' 是合法 JSON 数字 —— 载荷就是 200
      ['boolean', 'true', true, false],
    ] as const)('message=%s → ok=%s notFound=%s', (_label, message, ok, notFound) => {
      const r = normalizeIn(envelope(200, message), 'C')
      expect(r.ok).toBe(ok)
      expect(r.notFound).toBe(notFound)
    })

    it('非 200 的 code 直接失败，message 原样作为 messageText', () => {
      const r = normalizeIn(envelope(14500, '内部错误'), 'C')
      expect(r).toMatchObject({ ok: false, code: '14500', payload: undefined })
      expect(r.messageText).toBe('内部错误')
    })

    it('message 缺失 / 非字符串 → 失败，且给出可诊断的 messageText', () => {
      // 没有 message 键时 messageText 是空串，下游错误分类会落到 unknown ——
      // 这正是要显式报告"响应缺少 message"的原因（不是静默成功）。
      const r = normalizeIn(envelope(200, undefined), 'C')
      expect(r.ok).toBe(false)
      expect(r.messageText).toBe('响应缺少 message')
    })

    it('message 里以数字开头的错误码被提取为 code（形状 C 的真实错误码）', () => {
      // 顶层的 code 恒 200，真实错误码在 message 开头 —— 不提取的话 14501/14004/14009
      // 的分派表全部失效（设计稿 §9.0 的实测结论）。
      for (const [text, expected] of [
        ['14501 (endTime-startTime)/millsADay > 31 is invalid', '14501'],
        ['14004 Not found param: robotId', '14004'],
        ['14009 api call too frequent', '14009'],
      ] as const) {
        const r = normalizeIn(envelope(200, text), 'C')
        expect(r.code, text).toBe(expected)
        expect(r.ok).toBe(false)
      }
    })

    it('畸形 JSON（整数键未加引号）在严格解析失败后修复，判成功', () => {
      // 实测 session.user.profile 有 47% 的正常响应是这个形态（设计稿 §10.2）。
      const r = normalizeIn(envelope(200, '{5000004:"张三",5000001:"李四"}'), 'C')
      expect(r.ok).toBe(true)
      expect(r.payload).toEqual({ 5000004: '张三', 5000001: '李四' })
    })
  })

  // ——— 形状 A：数据在 data ———
  describe('形状 A（data 承载载荷）', () => {
    it.each([
      ['object', { a: 1 }, false],
      ['array', [1, 2], false],
      ['empty-object', {}, true],
      ['empty-array', [], true],
      ['null', null, true],
    ] as const)('data=%s → notFound=%s', (_label, data, notFound) => {
      const r = normalizeIn(envelope(200, 'OK', { data }), 'A')
      expect(r.ok).toBe(true)
      expect(r.notFound).toBe(notFound)
    })

    it('message 的 5 种类型都不影响 data 分支的判定', () => {
      // ⚠️ 这一格是矩阵的**交叉验证**：形状 A 有 data 时，message 只是旁注 ——
      // 无论它是字符串/对象/数字/布尔/数组，ok 与 notFound 都只由 data 决定。
      // （实测 staff.list 的 message 就是 "OK"；不判 message 类型是刻意的。）
      for (const key of Object.keys(MESSAGES) as MessageKey[]) {
        const r = normalizeIn(envelope(200, MESSAGES[key], { data: { a: 1 } }), 'A')
        expect(r.ok, key).toBe(true)
        expect(r.notFound, key).toBe(false)
      }
    })

    it('未登记信封（undefined）+ 空 data → **不判** notFound（写接口语义反转）', () => {
      // deleteKnowledges 的空 data 是"全部成功"，与读接口相反（设计稿 §5.4.1）。
      // ⚠️ 传 `undefined` 而不是 `null`：`normalize` 的形参是 `EnvelopeShape | undefined`，
      // 唯一调用点 `http.ts:334` 也是 `spec.envelope ?? undefined` —— null 是调用方
      // 永远造不出的值，拿它当「未登记」的代表会把测试钉在一个不存在的入口上。
      const r = normalizeIn(envelope(200, 'OK', { data: [] }), undefined)
      expect(r.ok).toBe(true)
      expect(r.notFound).toBe(false)
    })
  })

  // ——— 形状 B：数据在 result ———
  describe('形状 B（result 承载载荷）', () => {
    it.each([
      ['array', [1], false],
      ['empty-array', [], true],
      ['object', { a: 1 }, false],
      ['empty-object', {}, true],
    ] as const)('result=%s → notFound=%s（已实测）', (_label, result, notFound) => {
      const r = normalizeIn(envelope(200, 'OK', { result, total: 0 }), 'B')
      expect(r.ok).toBe(true)
      expect(r.notFound).toBe(notFound)
    })

    it('total 不参与判定 —— tag.all 的 total 恒为 0、不可作数', () => {
      const r = normalizeIn(envelope(200, 'OK', { result: [{ id: 1 }], total: 0 }), 'B')
      expect(r.notFound).toBe(false)
    })

    it('message 的 5 种类型都不影响 result 分支', () => {
      for (const key of Object.keys(MESSAGES) as MessageKey[]) {
        const r = normalizeIn(envelope(200, MESSAGES[key], { result: [1] }), 'B')
        expect(r.ok, key).toBe(true)
        expect(r.notFound, key).toBe(false)
      }
    })
  })

  // ——— 形状 D / D-nf：只有 code（纯确认接口） ———
  describe('形状 D / D-nf（无载荷是正常的）', () => {
    // ⚠️ `D` 与 `D-nf` 是**语义相反的两个接口共用同一份报文**（设计稿 §9.0）：
    //   · `robot.transfer.config` → `{code:200}` 是正常成功（它本来就返回空壳）
    //   · `robot.session.msgAssociate` → `{code:200}` 无 data 是它的 not-found 路径
    //   两者从报文里无从分辨，所以注册表必须分开登记。矩阵必须把这**两种结论都钉住** ——
    //   写成一格（"D 族都不判 notFound"）会把 msgAssociate 的失败报成成功。
    it('形状 D：200 + 无 data → 成功，**不判** notFound（空壳是正常返回）', () => {
      const r = normalizeIn(envelope(200, 'OK'), 'D')
      expect(r).toMatchObject({ ok: true, notFound: false, payload: undefined })
    })

    it('形状 D-nf：200 + 无 data → 成功但 **notFound=true**（空报文即查无此物）', () => {
      const r = normalizeIn(envelope(200, 'OK'), 'D-nf')
      expect(r).toMatchObject({ ok: true, notFound: true, payload: undefined })
    })

    it('形状 D-nf 有 data 时**不**判 notFound（命中路径）', () => {
      const r = normalizeIn(envelope(200, 'OK', { data: { content: 'x' } }), 'D-nf')
      expect(r).toMatchObject({ ok: true, notFound: false })
    })

    it('形状 D 的非 200 code → 失败', () => {
      const r = normalizeIn(envelope(14515, '权限不足'), 'D')
      expect(r).toMatchObject({ ok: false, code: '14515' })
    })

    it('message 的 5 种类型都不改变形状 D 的结论', () => {
      for (const key of Object.keys(MESSAGES) as MessageKey[]) {
        const r = normalizeIn(envelope(200, MESSAGES[key]), 'D')
        expect(r.ok, key).toBe(true)
        // 形状 D 上 message 即使能解析成空载荷，也不该判 notFound ——
        // 这类接口「没有数据」是设计如此，不是查无此物。
        expect(r.notFound, key).toBe(false)
      }
    })
  })

  // ——— 宽松模式（envelope 未登记） ———
  describe('未登记信封（undefined）：只试探 message', () => {
    it.each([
      ['json-object', '{"a":1}', true, false],
      ['json-array', '[1]', true, false],
      ['empty-array', '[]', true, true],
      ['string', 'OK', true, false],   // ⚠️ 解析失败**不判错**（与形状 C 的关键区别）
      ['integer', '200', true, false],
    ] as const)('message=%s → ok=%s notFound=%s', (_label, message, ok, notFound) => {
      const r = normalizeIn(envelope(200, message), undefined)
      expect(r.ok).toBe(ok)
      expect(r.notFound).toBe(notFound)
    })

    it('message 是**非字符串**（对象/数字/布尔/数组）时不解析、不判错', () => {
      // ⚠️ 只有字符串会被试探解析（`typeof o.message === 'string'`）。其余类型
      // 走到"200 但无载荷"的末尾分支 —— 宽松模式下不判 notFound（同 data/result 规则）。
      for (const key of ['json-object', 'integer', 'boolean', 'array'] as const) {
        const r = normalizeIn(envelope(200, MESSAGES[key]), undefined)
        expect(r.ok, key).toBe(true)
        expect(r.notFound, key).toBe(false)
      }
    })
  })

  // ——— 无信封的两种特殊形态 ———
  describe('特殊形态', () => {
    it('裸数组（无信封）原样作为载荷，不判 notFound', () => {
      // ipcc.customfield.template.get 实测就是裸数组。
      const r = normalizeIn([{ id: 1 }])
      expect(r).toMatchObject({ ok: true, code: '200', notFound: false })
      expect(r.payload).toEqual([{ id: 1 }])
    })

    it('裸数组为空也不判 notFound（无从得知空数组的语义）', () => {
      expect(normalizeIn([], undefined).notFound).toBe(false)
    })

    it.each([
      ['Spring 404', { status: 404, timestamp: 1, message: 'Not Found' }, '404'],
    ] as const)('%s 识别为失败，code 取 status', (_label, raw, code) => {
      const r = normalizeIn(raw)
      expect(r).toMatchObject({ ok: false, code })
    })

    it('带 code 的响应永远不会被当成 Spring 404（`!("code" in o)` 是判别式）', () => {
      const r = normalizeIn({ code: 200, status: 404, timestamp: 1, message: 'OK', data: { a: 1 } })
      expect(r.ok).toBe(true)
    })

    it.each([
      ['string', 'x'], ['number', 1], ['null', null], ['boolean', true],
    ] as const)('裸标量（%s）判失败，而不是崩在属性访问上', (_label, raw) => {
      const r = normalizeIn(raw)
      expect(r.ok).toBe(false)
      expect(r.code).toBe('unknown')
    })

    it('staffInfo 分支：空数组是「无人在线」的合法状态，不是 notFound', () => {
      // chat.queue.group.query 实测 24 个组里 15 个是空 staffInfo。
      const r = normalizeIn({ code: 200, staffInfo: [] })
      expect(r).toMatchObject({ ok: true, notFound: false })
    })
  })

  // ——— 覆盖度自检 ———
  it('矩阵覆盖了 `EnvelopeShape` 联合类型的**每一个**取值（从源码读，不靠手抄）', () => {
    // ⚠️ 第一版写的是 `expect(['A','B','C','D','D-nf']).toEqual(['A','B','C','D','D-nf'])`
    // —— 拿一份手抄清单跟它自己比，恒真，等于没测。第二版改成「手抄清单 vs 类型定义」，
    // 仍是同一类缺陷的另一半（Sourcery 2026-10-25 发现）：往类型里加一个新形状、
    // 再把它抄进那份清单，自检照样通过，而新形状**没有任何用例**。
    // 现在的判据是**观测**：`EXERCISED` 只由 `normalizeIn` 在真实用例里登记，
    // 没被跑过的形状不可能混进来。
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'core', 'envelope.ts'), 'utf8')
    const m = /export type EnvelopeShape\s*=([^\n]+)/.exec(src)
    expect(m, 'EnvelopeShape 的定义形态变了 —— 本自检要跟着改').not.toBeNull()
    const declared = [...m![1]!.matchAll(/'([^']+)'/g)].map((x) => x[1])
    expect(declared.length, '类型里至少要有一个形状').toBeGreaterThan(0)

    // ① 每个声明过的形状都必须被矩阵用例真正喂进过 `normalize`
    const missing = declared.filter((s) => !EXERCISED.has(s))
    expect(missing, `这些形状在类型里声明了，但矩阵没有任何用例跑过它们：${missing.join(', ')}`)
      .toEqual([])
    // ② 反向：矩阵也不许喂一个类型里没有的形状（防止测试比实现更宽而恒真）
    const extra = [...EXERCISED].filter((s) => !declared.includes(s))
    expect(extra, `矩阵喂了类型里不存在的形状：${extra.join(', ')}`).toEqual([])

    // ③ 形状维度必须真的在区分行为：对每个形状喂同一份空报文，把三元组
    // (ok, notFound, payload===undefined) 记下来，要求至少有两个形状给出不同结论
    // （否则说明矩阵行是复制的、没在测区别）。
    // ⚠️ 这里刻意用裸 `normalize` 而非 `normalizeIn`：这是自检自造的探针，
    // 让它登记会把「覆盖度」变成自证。
    const signature = (shape: EnvelopeShape): string => {
      const r = normalize({ code: 200, message: 'OK' }, shape)
      return `${r.ok}/${r.notFound}/${r.payload === undefined}`
    }
    const sigs = declared.map((s) => signature(s as EnvelopeShape))
    expect(new Set(sigs).size, `全部形状给出同一结论（${sigs[0]}）—— 形状维度没有被测到`)
      .toBeGreaterThan(1)
  })
})
