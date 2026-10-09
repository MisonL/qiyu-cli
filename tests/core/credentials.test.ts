import { describe, it, expect } from 'vitest'
import { resolveCredentials, redact } from '../../src/core/credentials.js'

// ⚠️ 这两个夹具必须是**已解析过的凭证对象**，不是环境变量名。
// 环境变量名 → 对象 的转换发生在 CLI 边界（commands/auth.ts 与 commands/api.ts
// 里写 `{ appKey: process.env.QIYU_APP_KEY, ... }`），不在这一层。
// 若把夹具写成 `{ QIYU_APP_KEY: ... }` 这种环境变量名的形状，本组用例会
// **整体失去意义**：`env.appKey` 永远是 undefined，期望值 'env-key' 永远取不到，
// 于是无论实现里有没有 `?? env.appKey` 都失败（实测：夹具改错后 3 条失败，
// 但失败的原因与"环境变量优先级"这个契约无关）。
const ENV = { appKey: 'env-key', appSecret: 'env-secret' }
const FILE = { appKey: 'file-key', appSecret: 'file-secret' }

describe('凭证解析优先级', () => {
  it('命令行参数优先于环境变量与配置文件', () => {
    expect(resolveCredentials({ appKey: 'cli-k', appSecret: 'cli-s' }, ENV, FILE))
      .toMatchObject({ appKey: 'cli-k', appSecret: 'cli-s' })
  })

  it('无命令行参数时用环境变量', () => {
    expect(resolveCredentials({}, ENV, FILE)).toMatchObject({ appKey: 'env-key' })
  })

  it('都没有时用配置文件', () => {
    expect(resolveCredentials({}, {}, FILE)).toMatchObject({ appKey: 'file-key' })
  })

  it('完全缺失时抛出带指引的错误', () => {
    expect(() => resolveCredentials({}, {}, undefined)).toThrow(/QIYU_APP_KEY/)
  })

  it('只有 appKey 没有 appSecret 时也报错，而不是发出必然失败的请求', () => {
    expect(() => resolveCredentials({}, { appKey: 'k' }, undefined)).toThrow(/QIYU_APP_SECRET/)
  })

  it('环境变量这一层真的生效 —— 删掉它测试必须失败', () => {
    // 上一条用例曾因夹具写错而形同虚设，这条用 A/B 把契约钉死：
    // 给了 env 就必须用 env，哪怕 file 也在场。
    expect(resolveCredentials({}, ENV, FILE).appKey).toBe('env-key')
    expect(resolveCredentials({}, ENV, FILE).appSecret).toBe('env-secret')
  })
})

describe('凭证脱敏', () => {
  it('抹掉 appSecret 的一切出现', () => {
    const creds = { appKey: 'mykey', appSecret: 'supersecret' }
    // ⚠️ 夹具里凭证出现**两次**，并断言整串结果，而不只是 `not.toContain`。
    // `not.toContain` 只要求"至少有一处被抹掉"，区分不了"全量替换"与
    // "只替换首次出现" —— 而漏抹第二处正是安全函数最该被抓住的缺陷。
    expect(redact('secret=supersecret 无效；重试时又见 supersecret', creds))
      .toBe('secret=<已隐藏> 无效；重试时又见 <已隐藏>')
  })

  it('抹掉 appKey 的一切出现', () => {
    const creds = { appKey: 'mykey', appSecret: 's' }
    expect(redact('appKey=mykey 不在白名单；又出现 mykey 一次', creds))
      .toBe('appKey=<已隐藏> 不在白名单；又出现 <已隐藏> 一次')
  })

  it('抹掉 URL 查询串里的 checksum —— 它是 5 分钟内有效的可重放凭证', () => {
    // ⚠️ 只要异常 message 里出现 URL，它就是
    // `...?appKey=X&time=Y&checksum=Z`（真实连接失败的 message 恒为 `"fetch failed"`、
    // URL 在 `e.cause`；把 URL 写进 message 的是**构造类异常** —— 见任务 8 用例注释）。
    // 只抹 appKey 不够：checksum 虽然不可逆，
    // 但配上同一个 time 与 body 就能原样重放请求（有效期 5 分钟）。
    // ⚠️ 夹具用**真实长度**的凭证。用单字符（如 'k'）会让 redact 的
    // appKey 替换先命中 checksum 里的同名字符，测出来的"成功"与 checksum 无关。
    const creds = { appKey: 'a'.repeat(32), appSecret: 'b'.repeat(32) }
    const cs = '0123456789abcdef0123456789abcdef01234567'  // 恰好 40 位，不含 'a'/'b' 以外的干扰
    const msg = `request to https://qiyukf.com/x?appKey=${creds.appKey}&time=1&checksum=${cs} failed`
    const out = redact(msg, creds)
    expect(out).not.toContain(cs)
    // 其余部分必须保留 —— 否则 Agent 拿不到有用的错误上下文
    expect(out).toContain('qiyukf.com')
    expect(out).toContain('failed')
  })

  it('不误伤 39 位或 41 位的十六进制串（长度必须精确）', () => {
    // 正则写成 `{40,}` 或 `{39,41}` 都会误伤。
    const creds = { appKey: 'zzzz', appSecret: 'yyyy' }
    const h39 = 'c'.repeat(39)
    const h41 = 'c'.repeat(41)
    expect(redact(h39, creds)).toBe(h39)
    expect(redact(h41, creds)).toBe(h41)
  })

  it('无凭证的文本原样返回', () => {
    expect(redact('普通报文', { appKey: 'k', appSecret: 's' })).toBe('普通报文')
  })

  it('短凭证只按 token 边界替换，不打烂正常文本', () => {
    // ⚠️ 这条曾经锁定的是一个**缺陷**：朴素 split/join 对单字符凭证会把
    // 'status' 打成 '<已隐藏>tatu<已隐藏>' —— 每个 's' 都被替换，Agent 读不懂错误信息。
    // 真实凭证是 32 字符不会踩到，但 redact 是安全函数，行为不该随凭证长度而变。
    // 现在：短凭证走 token 边界（前后不能是单词字符），长凭证仍走无差别替换。
    const short = { appKey: 'k', appSecret: 's' }
    expect(redact('status', short)).toBe('status')
    // 但作为独立 token 出现时仍必须抹掉 —— 安全不能因为"短"而让步
    expect(redact('secret is s here', short)).not.toContain(' s ')
  })

  it('短凭证出现在连字符分隔的串中也被抹掉 —— 边界是单词字符，不含 `-`', () => {
    // ⚠️ 边界正则若写成 `[\w-]`，会把连字符 `-` 当成边界字符，于是 `foo-abc-bar`
    // 里的 `abc` 不被脱敏（前一个字符 `-` 命中 `[\w-]`，`(?<!…)` 失败）。
    // 而计划的**正文契约**是「前后不能是单词字符」—— `\w` = `[A-Za-z0-9_]`，`-` **不是**
    // 单词字符，所以 `-` 前后必须算边界，凭证必须被抹掉。这条钉住 `[\w-]` → `[\w]` 的修正。
    // 属于「宣称的边界比实现的更严」那一类缺陷：承诺了却做不到。
    const short = { appKey: 'k', appSecret: 'abc' }
    expect(redact('foo-abc-bar', short)).toBe('foo-<已隐藏>-bar')
  })

  it('MIN 阈值本身被钉住 —— 7 位走 token 边界、8 位走无差别替换', () => {
    // ⚠️ 上面两条测试用的凭证长度是 1 与 32，**恰好跳过了 `MIN = 8` 这个阈值本身**。
    // 实测确认：把 `const MIN = 8` 改成 7、或把 `secret.length >= MIN` 改成 `> MIN`，
    // 凭证测试 15 条**全部通过** —— 阈值改坏了没有任何断言会失败
    // （2026-10-08 复测：该文件现共 15 条；此前写 14 是它 14 条时的数。
    // 两个变异各红 1 条，正是本用例）。
    // 而这两个改动都不是等价的：8 位凭证在 `>=` 下走无差别替换、在 `>` 下退化成
    // token 边界替换，同一个凭证在不同位置的表现会不一致（安全函数最不该有的性质）。
    // 真实凭证是 32 位、踩不到这条边界，但边界既然写进了代码就该被钉住 ——
    // 否则下一个人调这个数字时没有任何反馈。
    const eight = 'abcd1234'                       // 恰好 8 位
    // 8 位走**无差别**替换：嵌在单词中间也要抹掉
    expect(redact(`x${eight}y`, { appKey: 'k', appSecret: eight })).toBe('x<已隐藏>y')
    const seven = 'abcd123'                        // 恰好 7 位
    // 7 位走 **token 边界**替换：嵌在单词中间**不**抹（避免打烂正常文本）
    expect(redact(`x${seven}y`, { appKey: 'k', appSecret: seven })).toBe(`x${seven}y`)
    // 但作为独立 token 时 7 位同样必须抹掉
    expect(redact(`v ${seven} w`, { appKey: 'k', appSecret: seven })).toBe('v <已隐藏> w')
  })

  it('长凭证（真实的 32 字符）走无差别替换 —— 出现在任何位置都抹掉', () => {
    const creds = { appKey: 'a'.repeat(32), appSecret: 'b'.repeat(32) }
    // 嵌在别的字符串中间也要抹掉（无词边界）
    expect(redact(`prefix${creds.appKey}suffix`, creds)).toBe('prefix<已隐藏>suffix')
  })

  it('凭证含正则元字符时不会破坏正则（escapeRe）', () => {
    // 短凭证走 RegExp 路径，若凭证里含 `.` `*` `(` 等，不转义会抛错或误匹配。
    const creds = { appKey: 'a.c', appSecret: 'x(y' }
    expect(() => redact('value is a.c here', creds)).not.toThrow()
    expect(redact('value is a.c here', creds)).not.toContain('a.c')
  })
})
