/** 把不受信文本（调用方 body 的字段名等）中的终端控制字符抹成占位，防止 stderr 注入 ANSI/OSC 序列。 */
export function sanitizeControlChars(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000A-\u001F\u007F-\u009F]/g, '·')
}

/**
 * 逐行净化：保留换行结构（多行消息的可读性），剥掉每一行里的终端控制字符。
 *
 * `sanitizeControlChars` 会把 `\n` 一并抹掉（它落在 `\u000A-\u001F` 区间），故直接对整个
 * 多行消息调用它会把换行也毁掉。错误出口（`usageFail` / `emitQueryFailure`）的 message
 * 是多行的（用法说明、DuckDB 原文），走这个既防 stderr 注入又保住行结构。
 */
export function sanitizeMessage(s: string): string {
  return s.split('\n').map(sanitizeControlChars).join('\n')
}

/**
 * 裁掉 DuckDB 错误原文里的 SQL 回显。DuckDB 的 Parser/Binder 错误会把出错行的 SQL 全文
 * 附在 `LINE n: …` 之后（实测 `Parser Error … LINE 1: SELECT 1 FROM (SELECT userPhone …`）
 * ——其中可能含调用方写进 SQL 的 PII（security S3：这是把原始值写进 stderr 的主要载体）。
 * 保留错误类别与行号标记（`LINE n:` 之前的全部内容），只把回显的 SQL 本体换成占位。
 */
export function stripSqlEcho(s: string): string {
  return s.replace(/(\n\s*LINE \d+:)[\s\S]*$/, '$1 （SQL 原文已省略）')
}
