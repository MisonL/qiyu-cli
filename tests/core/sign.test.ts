import { describe, it, expect } from 'vitest'
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
