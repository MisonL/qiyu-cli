// tests/registry/sample.test.ts —— 采样器（scripts/registry/sample.mjs）的三条硬约束。
//
// ⚠️ 为什么这几条必须有测试：`scripts/registry/sample.mjs` 是**唯一会带着真实凭证
// 打生产接口**的脚本，而它的三条约束（签名单一实现点 / 凭证只从 env / 输出不含业务值）
// 全都是「不做某件事」型契约 —— 不做的事没有输出，也就没有别的地方能发现它被违反。
// 它们坏掉的方式都很安静：
//   · 有人把 checksum 抄一份进脚本 → 两份实现漂移，症状是线上 14500 查不出原因；
//   · 有人图省事加个 `--key` 参数 → 凭证进 shell 历史 / `ps` / CI 日志；
//   · 有人把 `describeShape` 改成返回原值 → 真实客户数据上屏，采样者顺手贴进工单。
//
// ⚠️ 本文件不联网、不发任何请求：只测导出的纯函数 + 静态检查脚本源码与 CI 配置。

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  describeShape, describeNonJson, summarize, assertSampleable, readCreds,
} from '../../scripts/registry/sample.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const read = (p: string): string => readFileSync(join(repoRoot, p), 'utf8')
const SAMPLE_SRC = 'scripts/registry/sample.mjs'

describe('describeShape —— 只有结构，没有业务值', () => {
  it('叶子全部折成类型名，哨兵值一个都不出现在输出里', () => {
    // 这两个哨兵是真会出现在七鱼返回里的形状（姓名、手机号），也是 note 里
    // 反复点名的 PII 字段 —— 只要它们上屏，采样输出就已经泄漏了。
    const raw = {
      code: 200,
      data: {
        name: '哨兵姓名-XYZ',
        phone: '13900001111',
        nested: { deep: { deeper: { secret: 'SENTINEL-DEEP' } } },
        list: [{ content: 'SENTINEL-LIST' }],
      },
    }
    const text = JSON.stringify(summarize(raw))
    for (const sentinel of ['哨兵姓名-XYZ', '13900001111', 'SENTINEL-DEEP', 'SENTINEL-LIST']) {
      expect(text, `${sentinel} 泄漏进了采样输出`).not.toContain(sentinel)
    }
    // 结构本身必须还在 —— 否则"不含值"可以靠返回空对象作弊
    expect(JSON.parse(text).data.name).toBe('string')
    expect(JSON.parse(text).data.list).toEqual({ array: { content: 'string' } })
  })

  it('数组只给长度与首元素形状（空数组显式标 empty，不是 null）', () => {
    expect(describeShape([])).toEqual({ array: 'empty' })
    expect(describeShape([1, 2, 3])).toEqual({ array: 'number' })
    expect(describeShape(null)).toBe('null')
    // 超过深度上限只报类型名，不无限展开
    expect(describeShape({ a: { b: { c: { d: 1 } } } }, 0)).toEqual({
      a: { b: { c: 'object' } },
    })
  })

  it('形状 C 的 message 只报「种类」与解析后的结构，不报内容', () => {
    const raw = { code: 200, message: JSON.stringify({ total: 104170, tickets: [{ content: 'SENTINEL-TICKET' }] }) }
    const s = summarize(raw) as Record<string, unknown>
    expect(s.message).toBe('json-string:object')
    expect(s.messageShape).toEqual({ tickets: { array: { content: 'string' } }, total: 'number' })
    expect(JSON.stringify(s)).not.toContain('SENTINEL-TICKET')
    expect(JSON.stringify(s)).not.toContain('104170')
  })

  it('message 的四种非 JSON 形态各自可区分 —— 注册表要登记的正是这个', () => {
    expect((summarize({ code: 200, message: 'OK' }) as Record<string, unknown>).message).toBe('plain-text')
    expect((summarize({ code: 200, message: { a: 1 } }) as Record<string, unknown>).message)
      .toBe('non-string:object')
    expect((summarize({ code: 200 }) as Record<string, unknown>).message).toBe('absent')
    expect((summarize({ code: 200, message: '[]' }) as Record<string, unknown>).message)
      .toBe('json-string:array')
  })

  it('裸数组：顶层标 <array>，形状挂在 shape 上', () => {
    const s = summarize([{ id: 1, name: 'SENTINEL-NAME' }]) as Record<string, unknown>
    expect(s.top).toBe('<array>')
    expect(s.shape).toEqual({ array: { id: 'number', name: 'string' } })
    expect(JSON.stringify(s)).not.toContain('SENTINEL-NAME')
  })
})

describe('describeNonJson —— 非 JSON 响应一个正文字符都不带', () => {
  it('HTML 错误页与纯文本网关页都只报元数据，正文字符不上屏', () => {
    // ⚠️ 该支最初写成 `text.slice(0, 20)` 并自称「只报类别」（CodeRabbit 2026-10-30
    // 指出）。而 nginx 错误页/网关纯文本的开头完全可能带业务信息 —— 这个破口正好
    // 落在唯一没有用例的分支上，所以这里必须钉住：哨兵放在**正文最开头**，
    // 任何"截前 N 个字符"的回归都会被直接抓住（放在第 20 位之后的话，
    // slice(0,20) 依然通过 —— 那样这条就只是看着像在守）。
    const body = 'SENTINEL-ORDER <html><body>上游 500 处理失败</body></html>'
    const s = describeNonJson(500, 'text/html', body) as Record<string, unknown>
    expect(JSON.stringify(s)).not.toContain('SENTINEL-ORDER')
    expect(JSON.stringify(s)).not.toContain('html><body>')
    expect(s).toEqual({
      httpStatus: 500, nonJson: true, contentType: 'text/html',
      length: body.length, looksLikeHtml: false,
    })
  })

  it('纯文本网关页：looksLikeHtml=false，contentType 缺失时是 null 而不是 undefined', () => {
    // undefined 在 JSON 里会整个丢键 —— Agent 读到的是"没有这个字段"，而不是"服务端没给"
    const s = describeNonJson(502, null, 'Bad Gateway\nSENTINEL-HOST') as Record<string, unknown>
    expect(s.looksLikeHtml).toBe(false)
    expect(s.contentType).toBeNull()
    expect(JSON.stringify(s), 'undefined 会让键整个消失').toContain('"contentType":null')
    expect(JSON.stringify(s)).not.toContain('SENTINEL-HOST')
  })
})

describe('assertSampleable —— 拒采样写接口，判据取自注册表', () => {
  const ok = { id: 'x', dangerous: false, callable: true, path: '/openapi/x' } as never

  it('危险写接口一律拒绝（即使用例文件里写了它）', () => {
    // 用真实注册表里的 id 当样本：`icoutcall.job.create` 是 dangerous:true 的写接口。
    // 这条守的是「采样器不会因为用例文件手滑就改动生产数据」。
    expect(() => assertSampleable({ ...(ok as object), dangerous: true } as never, 'icoutcall.job.create'))
      .toThrow(/危险写接口/)
  })

  it('不可主动调用 / 没有 path 的接口拒绝 —— 拼出来必然 404，属于无意义调用', () => {
    expect(() => assertSampleable({ ...(ok as object), callable: false } as never, 'receive.message'))
      .toThrow(/不可主动调用/)
    expect(() => assertSampleable({ ...(ok as object), path: null } as never, 'wecom.robot.switch'))
      .toThrow(/没有可用 path/)
  })

  it('不在注册表里的 id 拒绝 —— 拼不出 path，也不该瞎猜', () => {
    expect(() => assertSampleable(undefined, 'no.such.id')).toThrow(/不在注册表/)
  })

  it('正常只读接口放行', () => {
    expect(() => assertSampleable(ok, 'x')).not.toThrow()
  })
})

describe('readCreds —— 只认环境变量', () => {
  it('缺一个就报错，且错误里不出现另一个的值（连长度都不给）', () => {
    let msg = ''
    try { readCreds({ QIYU_APP_KEY: 'SENTINEL-KEY-VALUE' }) } catch (e) { msg = String(e) }
    expect(msg).toMatch(/QIYU_APP_KEY|QIYU_APP_SECRET/)
    expect(msg).not.toContain('SENTINEL-KEY-VALUE')
  })

  it('两个都在才返回', () => {
    expect(readCreds({ QIYU_APP_KEY: 'k', QIYU_APP_SECRET: 's' })).toEqual({ appKey: 'k', appSecret: 's' })
  })
})

describe('采样器的源码级约束（静态）', () => {
  it('签名只有一个实现点：脚本 import dist/core/sign.js，不得自带 checksum 实现', () => {
    // ⚠️ 这条守的是「同一逻辑只许一个实现点」。两份 SHA1 实现会漂移，
    // 而漂移的症状是「线上 14500 Internal Error，本地一切正常」—— 设计稿 §4.3
    // 点名的正是这种查不出原因的码。
    const src = read(SAMPLE_SRC)
    expect(src, '必须复用 dist/core/sign.js').toContain("import('../../dist/core/sign.js')")
    // 反向：不得出现自己算哈希的痕迹（crypto / sha1 / createHash）
    expect(src, '不得在脚本里重写签名').not.toMatch(/createHash|sha1|SHA1/)
  })

  it('凭证不从 argv 读 —— 只认环境变量来源（readCreds 只用 env 参数 / main 只读 process.env）', () => {
    const src = read(SAMPLE_SRC)
    // readCreds 的入参叫 env、main 把它接到 process.env —— 两种写法都承认
    // 「凭证只来自环境变量」。下面的 argv 约束是真正的红线。
    expect(src).toMatch(/\bQIYU_APP_KEY\b/)
    expect(src).toMatch(/\bQIYU_APP_SECRET\b/)
    // argv 只允许多种用途：用例文件路径（argv[2]）与「是否直接执行」的判定（argv[1]）。
    // 断言里点名这两处，任何**新的** argv 读法都会让这条变红 —— 那正是要人复核的时刻。
    const argvUses = [...src.matchAll(/process\.argv\[(\d+)\]/g)].map((m) => m[1])
    expect([...new Set(argvUses)].sort(), '脚本里出现了新的 argv 读取点，请确认它不是凭证').toEqual(['1', '2'])
  })

  it('不进 CI —— 采样要真实凭证与网络，CI 里跑必然失败或静默跳过', () => {
    // ⚠️ 这条同样是"不做某事"型契约：有人往 CI 加一行 `node scripts/registry/sample.mjs`
    // 不会让任何用例变红，但 CI 会在没有凭证的 runner 上退 2，或者更糟 ——
    // 某天有人把凭证塞进 CI secret，于是每次 push 都往生产租户打一轮读请求。
    for (const f of ['.github/workflows/ci.yml', '.github/workflows/ci.yaml']) {
      let text = ''
      try { text = read(f) } catch { continue }
      expect(text, `${f} 里不得调用采样器`).not.toContain('scripts/registry/sample.mjs')
    }
  })
})
