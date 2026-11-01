// src/query/native-error.ts —— DuckDB **原生错误报文**的判据：**唯一实现点**
// （2026-11-01，PR #54）。
//
// 为什么单独一个模块：这些判据此前在 `query/sandbox.ts` 与 `query/errors.ts` 里各写一份
// （layer2 拦截那条是逐字复制），而两者都拿**整条原始报文**做子串搜索 —— 于是
// 「报文里恰好含判据的文本」就能骗过它们。两份拷贝改一处漏一处，同一输入会给出两个结论。
// 形态归属：「同一份解码规则复制到多处 → 同一输入两个结论」（同族：`nonEmptyValue`
// 空串判据、profile 名解析 PR #41、打开失败成因 PR #53、库前置检查 PR #54）。
//
// ## 根本约束：DuckDB 的报文会把**外部文本**带进来
//
// 这不是理论风险，是实测（2026-11-01 探针 + E2E）：
//   · `Conversion Error` 回显**列值原文**：
//     `Conversion Error: Could not convert string 'interrupt' to INT32 when casting from source column x`
//   · `Parser Error` 回显**出错行的 SQL 全文**（`\n\nLINE 1: <SQL>\n     ^`）。
// 所以「报文里出现某个词」**不等于**「那个词是 DuckDB 在说这件事」——
// 用户数据、用户写的 SQL 都会出现在同一根字符串里。
//
// 判据因此必须锚 DuckDB 自己的**类别前缀**（`INTERRUPT Error:` / `Permission Error:`），
// 而不是搜整条报文里有没有那个词。
//
// ⚠️ 边界如实记录：类别前缀是 `Xxx Error:` 形态的**约定**，不是解析出来的结构；
// 若 DuckDB 换掉前缀措辞，这些判据会退化成「不命中」——退化的方向是安全的
// （错误归 internal 并带上原文，不会把无关错误谎报成超时/拦截），且
// `tests/query/native-error.test.ts` 会把真实报文逐字钉住，换措辞时必红。

/** DuckDB 把「出错行的 SQL 全文」附在 `\nLINE n: …` 之后与会话回显区分。 */
const SQL_ECHO = /\n\s*LINE \d+:[\s\S]*$/

/** 去掉报文里的 SQL 回显（判据只看 DuckDB 自己说的那半句）。 */
export function withoutSqlEcho(msg: string): string {
  return msg.replace(SQL_ECHO, '')
}

/**
 * 查询被中断（真超时）。实测原生报文恒为 `INTERRUPT Error: Interrupted!`。
 *
 * ⚠️ **不能**只搜 `/INTERRUPT/i`（2026-11-01 实测修）：`Conversion Error` 会把列值
 * 原文回显进 message，数据里恰好含 `interrupt` 时（如
 * `Could not convert string 'interrupt' to INT32 …`）子串判会把**类型转换错误**
 * 谎报成查询超时 —— kind 与真实成因相反、真实错误线索被整体丢弃，
 * `--timeout 0`（用户显式关闭超时）下也照样报「查询超过 0ms 未完成」。
 *
 * ⚠️ 只锚 `INTERRUPT Error` 这个词也不够（2026-11-01 CodeRabbit + 探针实测）：值恰为
 * `'INTERRUPT Error: Interrupted!'` 时，Conversion Error 的**头部**就逐字含这串
 * （`Could not convert string 'INTERRUPT Error: Interrupted!' to INT32 …`）。
 * 所以与 `isLayer2Blocked` 同样两步：先剥 SQL 回显，再要求前缀锚在**开头**（`^`）。
 * 真实中断报文实测无包装前缀（`runAndReadUntil` 抛出的 message 恰为上面那句）。
 */
export function isInterrupt(msg: string): boolean {
  return /^INTERRUPT Error:/i.test(withoutSqlEcho(msg))
}

/**
 * layer2 只读沙箱的文件/网络拦截。实测五形态（read_csv / read_text / glob / COPY /
 * ATTACH / EXPORT / INSTALL）报文恒以 `Permission Error: Cannot access file|directory
 * "…" - file system operations are disabled by configuration` 开头。
 *
 * ⚠️ 三个条件缺一不可：
 *   · 剥掉 SQL 回显后判定 —— `Parser Error` 会把出错行 SQL 全文附在 `LINE n:` 之后，
 *     SQL 里恰好含特征句（`SELEC 'file system operations are disabled by configuration'`，
 *     实测）会被判成「已被沙箱拦截」（真实成因是语法错，归因是假的）；
 *   · 锚**类别前缀** `Permission Error:` —— 特征句单独出现在回显区/列值里不算数；
 *   · 同时要特征句 **`file system operations are disabled`** —— 这才是「配置禁用」的
 *     标记。`Cannot access file` 单独出现不作数：裸的文件访问失败也可能带
 *     `Permission Error:` 前缀，把它算成「被沙箱拦截」会把环境问题说成用法问题。
 */
export function isLayer2Blocked(msg: string): boolean {
  const head = withoutSqlEcho(msg)
  return /^Permission Error:/i.test(head)
    && /file system operations are disabled/i.test(head)
}
