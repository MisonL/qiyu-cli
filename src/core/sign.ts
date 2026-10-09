import { createHash } from 'node:crypto'

/** 计算字符串的 md5，小写十六进制。按 UTF-8 字节计算。 */
export function md5Hex(body: string): string {
  return createHash('md5').update(body, 'utf8').digest('hex')
}

/**
 * 七鱼鉴权签名。
 * checksum = SHA1(appSecret + md5(body原文) + time)，小写十六进制。
 * time 为秒级时间戳，有效期 5 分钟。
 *
 * ⚠️ body 必须是**即将原样发送**的那个字符串。任何序列化差异都会导致 14002。
 */
export function checksum(appSecret: string, body: string, time: number): string {
  const raw = `${appSecret}${md5Hex(body)}${time}`
  return createHash('sha1').update(raw, 'utf8').digest('hex')
}

/** 拼出完整的鉴权查询串。顺序固定为 appKey、time、checksum。 */
export function signedQuery(
  appKey: string,
  appSecret: string,
  body: string,
  time: number,
): string {
  const cs = checksum(appSecret, body, time)
  return `appKey=${encodeURIComponent(appKey)}&time=${time}&checksum=${cs}`
}
