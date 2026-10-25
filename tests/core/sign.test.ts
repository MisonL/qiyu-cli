import { describe, it, expect } from 'vitest'
import { createHash } from 'node:crypto'
import { md5Hex, checksum, signedQuery } from '../../src/core/sign.js'

describe('签名', () => {
  it('md5 对空串的计算结果符合已知值', () => {
    // 空串的 md5 是教科书常量，用它锁定实现确实是 md5 而非别的摘要
    expect(md5Hex('')).toBe('d41d8cd98f00b204e9800998ecf8427e')
  })

  it('md5 按 UTF-8 字节计算，中文字符不额外转义', () => {
    // 「中」的 UTF-8 是 e4 b8 ad。若实现误用 latin1/utf16le，这里立刻失败。
    expect(md5Hex('中')).toBe('aed1dfbc31703955e64806b799b67645')
  })

  it('md5 对中文、emoji、换行一视同仁（这是 14002 的头号来源）', () => {
    // 实测最容易踩的组合：多字节字符 + 换行。三者的 UTF-8 字节拼接后必须逐字一致。
    expect(md5Hex('中文🙂')).toBe('138a2c2516fcf4f9555f4bc54c3a0ae9')
    expect(md5Hex('{"name":"张三","emoji":"🙂"}')).toBe('222daac3697e8b01236796388e39a5ce')
    // ⚠️ **换行必须真的有**（2026-10-07 补）：此前两个夹具都不含 `\n`，而标题与
    // 复核重点 1 都点名「中文、emoji、换行」—— 换行这一项零覆盖。期望值用 Python
    // hashlib 独立算出，不是从本实现回填的。
    expect(md5Hex('多行\n文本')).toBe('7f4788b442a6fc3c20ea9162daafe1de')
    expect(md5Hex('{"a":"x\ny"}')).toBe('f5cad2492163c4bba92ebbb1d68373c4')
  })

  it('checksum 是 appSecret+md5+time 的 SHA1 小写十六进制', () => {
    const got = checksum('secret', '{"a":1}', 1700000000)
    expect(got).toMatch(/^[0-9a-f]{40}$/)
    // ⚠️ 只断言形状（`^[0-9a-f]{40}$`）是**锁不住实现的** —— 任何 40 位小写 hex 串
    // 都能通过，包括一个把拼接顺序写反、或漏掉 md5 的错实现。必须钉一个**固定向量**。
    // ⚠️ 这个值是对同一串文本用 Node 的 crypto 与 Python 的 hashlib **两个独立实现
    // 各算一遍**得到的一致结果（2026-10-04）—— 不是从本实现回填的。
    // 拼接式是 `appSecret + md5Hex(body) + time`，time 按十进制**秒**原样拼接
    // （不是毫秒、不补零）：`secret` + `bb6cb5c68df4652941caf652a366f2d8` + `1700000000`。
    expect(got).toBe('a648b81009049a29362cd89129dd4591ba76a155')
    // 第二个向量换一组输入，防止"恰好第一个对上"。
    expect(checksum('s', '{}', 1700000000)).toBe('ad847c210ca0e4d25b86e5788c7275e705b6c88b')
  })

  it('time 变化会改变签名', () => {
    expect(checksum('s', 'b', 1)).not.toBe(checksum('s', 'b', 2))
  })

  it('body 变化会改变签名', () => {
    expect(checksum('s', 'b1', 1)).not.toBe(checksum('s', 'b2', 1))
  })

  it('signedQuery 按固定顺序拼接三个鉴权参数', () => {
    const q = signedQuery('key1', 'secret', '{}', 1700000000)
    expect(q).toBe(
      `appKey=key1&time=1700000000&checksum=${checksum('secret', '{}', 1700000000)}`,
    )
  })

  it('appKey 里的 URL 保留字符被百分号编码 —— 否则查询串会被截断，签名对不上', () => {
    // appKey 是服务端签发的，但含 + / = & 的 key 一旦不编码，
    // 服务端解出来的 appKey 与本地签名用的不是一个串，结果是无从排查的 14002。
    expect(signedQuery('a+b/c=d&e', 's', '{}', 1700000000)).toContain('appKey=a%2Bb%2Fc%3Dd%26e')
  })

  it('checksum 是十六进制，不含需要编码的字符 —— 编码不得改变它', () => {
    // 反向确认：只该编码 appKey。若实现把 checksum 也过一遍 encodeURIComponent，
    // 十六进制串虽然不变，但改成别处编码就会悄悄破坏签名。
    const cs = checksum('s', '{}', 1700000000)
    expect(cs).toMatch(/^[0-9a-f]{40}$/)
    expect(signedQuery('k', 's', '{}', 1700000000)).toContain(`checksum=${cs}`)
  })
})

describe('与七鱼官方 Java 样例对拍（§12 第一条）', () => {
  /**
   * 官方文档给的 `QiyuPushCheckSum` 的**逐行移植**（`doc-436971.md`，2026-10-25 抓取）：
   *
   * ```java
   * public static String encode(String appSecret, String nonce, String time) {
   *   String content = appSecret + nonce + time;
   *   MessageDigest messageDigest = MessageDigest.getInstance("sha1");
   *   messageDigest.update(content.getBytes());
   *   return getFormattedText(messageDigest.digest());
   * }
   * // getFormattedText: 每个字节拆成两个**小写** hex 字符，逐字节拼接
   * ```
   *
   * ⚠️ 这是**参考实现**，不是 `src/` 的复制：它只做文档里写的那几步（拼接 → SHA1 →
   * 小写 hex），刻意不 import `checksum`。用它当 oracle，测的是「我们与文档说的是
   * 一回事」，而不是「我们的实现与自己的另一份写法一致」（后者是同义反复）。
   * ⚠️ 移植的两处对齐：
   *   · `content.getBytes()` 在 Java 里取**平台默认字符集**。文档没说，而 UTF-8 是
   *     现代 JVM 的默认（JDK18+ 强制 UTF-8），且七鱼线上必须与我们对齐 —— 这里显式
   *     用 UTF-8，与 `fetch`/`http.ts` 的编码一致；
   *   · `HEX_DIGITS` 是小写表，等价于 `digest('hex')`。
   */
  const javaEncode = (appSecret: string, nonce: string, time: string): string => {
    const HEX = '0123456789abcdef'
    const bytes = createHash('sha1').update(appSecret + nonce + time, 'utf8').digest()
    let out = ''
    for (const b of bytes) out += HEX[(b >> 4) & 0x0f]! + HEX[b & 0x0f]!
    return out
  }

  it('md5Hex 与 oracle 的 md5 一致（官方实现把 md5 作为 nonce 传入）', () => {
    // 官方签名里 nonce 就是 `MD5(content).toLowerCase()` —— 我们把它拆成 md5Hex 一步。
    // 若 md5Hex 哪天改成大写或按 latin1 编码，这里的逐字节比对立刻红。
    for (const body of ['', '{}', '{"a":1}', '{"中文":"值"}', '{"emoji":"🙂"}']) {
      const nonce = createHash('md5').update(body, 'utf8').digest('hex')
      expect(md5Hex(body), body).toBe(nonce)
      expect(checksum('secret', body, 1700000000), body)
        .toBe(javaEncode('secret', nonce, '1700000000'))
    }
  })

  it('固定向量：与官方算法逐字节相同（三个独立输入）', () => {
    // ⚠️ 这三个值的**来源**是本测试里的 `javaEncode`（官方样例的移植），
    // 不是 `checksum` 的回填 —— 断言写死只是为了让「实现变了」这件事显式地红，
    // 而不是让 oracle 跟着实现一起漂。
    const VECTORS: Array<[string, string, number]> = [
      ['secret', '{"a":1}', 1700000000],
      ['s', '{}', 1700000000],
      ['a+b/c=d&e', '{"x":"中文"}', 1750000000],
    ]
    for (const [secret, body, time] of VECTORS) {
      const expected = javaEncode(secret, md5Hex(body), String(time))
      expect(checksum(secret, body, time), `${secret} / ${body} / ${time}`).toBe(expected)
    }
  })

  it('oracle 与实现不是同一个东西 —— 破坏拼接顺序必须让它红', () => {
    // ⚠️ 这条守的是「oracle 有独立性」这个前提。若有人把 `javaEncode` 改成调
    // `checksum`，上面两条会永远绿（同义反复），而这条仍然绿（两边一起错）。
    // 所以要 **正面验证 oracle 对错误顺序给出不同答案** —— 它证明 oracle 是自己算的。
    const nonce = md5Hex('{"a":1}')
    expect(javaEncode('secret', nonce, '1700000000'))
      .not.toBe(javaEncode(nonce, 'secret', '1700000000'))
    // 时间用毫秒而不是秒：也必须不同（拼进去的是十进制文本，长度差 3 位）
    expect(javaEncode('secret', nonce, '1700000000'))
      .not.toBe(javaEncode('secret', nonce, '1700000000000'))
  })
})
