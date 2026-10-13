/** 把不受信文本（调用方 body 的字段名等）中的终端控制字符抹成占位，防止 stderr 注入 ANSI/OSC 序列。 */
export function sanitizeControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g, '·')
}
