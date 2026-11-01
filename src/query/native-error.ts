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
 * DuckDB 说「表/列不存在」时，它**自己**那句话必须出现在报文的开头。
 *
 * ⚠️ 为什么判据要锚开头（2026-11-01 审查实测，与 `isInterrupt` 同族）：
 * `errors.ts` 的四条表/列正则只锚了类别前缀（`Catalog Error:` / `Binder Error:`），
 * 以为这样就挡住了 Parser Error 的 SQL 回显。**挡不住** —— 回显本身就是用户写的文本，
 * 用户（或数据）写的字符串里可以逐字含类别前缀：
 *   · `Conversion Error: Could not convert string 'Catalog Error: Table with name zzz does not exist!' to INT64 …`
 *     （prepare 期常量折叠，实测：`SELECT * FROM sessions LIMIT '<值>'`）
 *   · `Parser Error: …\n\nLINE 1: SELEC'Binder Error: Referenced table "sessons" not found!'`
 * 两者都让 `TABLE_NAME_RE` 命中，于是**类型转换错误/语法错被谎报成「表 X 不存在」**，
 * 还附带一份候选清单把 Agent 支使去改一个它没写过的表名。
 * 真报文（探针逐字）：`Catalog Error: Table with name sessons does not exist!` —— 类别前缀
 * 就在开头；带包装的只有 Parser（`Failed to extract statements: Parser Error: …`），
 * 而 Parser 不是本判据要认的类别。故「剥回显 + 锚开头（容忍该包装）」两者都满足才算。
 */
export function duckDbSaysMissingName(msg: string, pattern: RegExp): RegExpExecArray | null {
  const own = withoutSqlEcho(msg)
  const wrap = /^\s*(?:Failed to extract statements:\s*)?/.exec(own)?.[0] ?? ''
  const rest = own.slice(wrap.length)
  if (!/^(?:Catalog|Binder) Error:/i.test(rest)) return null
  // ⚠️ 判据模式本身也必须锚在**那句话的开头**（2026-11-01 CodeRabbit）：只查「报文以类别
  // 前缀开头」还不够 —— 列名是用户给的，可以整段长成另一条报文的形状。实测：
  // 列名 = `Catalog Error: Table with name zzz does not exist!` 时，DuckDB 说
  // `Binder Error: Referenced column "Catalog Error: Table with name zzz does not exist!" not found`
  // —— 前缀检查通过（Binder Error: 在开头），而表名正则在**列名内部**命中，
  // 于是「列不存在」被报成「表 zzz 不存在」（实测复现）。锚开头后两者不会互串。
  return new RegExp('^(?:' + pattern.source + ')', pattern.flags.replace('g', '')).exec(rest)
}

/**
 * DuckDB **自己**说语法错（`Parser Error: syntax error at or near …`）。
 *
 * ⚠️ 同样不能只搜子串（2026-11-01 审查实测，与同族三条同一形态）：`Conversion Error`
 * 回显列值时，值里含 `Parser Error` 就会被判成「SQL 语法错误」——而归因是假的
 *（真实成因是类型转换，修法完全不同：改数据或改 cast，不是改语法）。
 * 实测：`SELECT CAST(x AS INT) FROM t`（`t.x` 值含该串）→ 曾被报成语法错。
 *
 * ⚠️ 容忍 `Failed to extract statements: ` 包装：真 Parser 报文实测就带它
 *（`extractStatements` 阶段抛出，探针逐字）。
 */
export function isParserError(msg: string): boolean {
  return /^\s*(?:Failed to extract statements:\s*)?Parser Error:/i.test(withoutSqlEcho(msg))
}

/**
 * DuckDB **自己**说内存不足（`Out of Memory Error: failed to allocate …`，探针实测）。
 *
 * ⚠️ 同样不能只搜子串（2026-11-01 审查实测）：`Conversion Error` 会回显列值，
 * 值里含 `Out of Memory Error` 时（实测 `INSERT INTO t VALUES ('Out of Memory Error: fake')`
 * 后 `CAST(x AS INT)`）子串判会给这条**类型转换错误**补上「缩小时间范围或加过滤条件」的
 * hint —— 真正的修法是改数据/改 cast，按 hint 去缩窗口只会白跑一轮。
 */
export function isOutOfMemory(msg: string): boolean {
  return /^\s*(?:Failed to extract statements:\s*)?Out of Memory Error:/i.test(withoutSqlEcho(msg))
}

/**
 * DuckDB **自己**说的 Binder/Catalog 错误（函数不存在、类型不匹配等）。
 *
 * ⚠️ 子串判可被列值/回显伪造（同族）：值里含 `Catalog Error:` 时，
 * `Conversion Error` 的报文会被判成「SQL 写错了」——真正的修法完全不同。
 * 真报文在开头（Parser 形态带 `Failed to extract statements: ` 包装），故锚开头。
 */
export function isBinderOrCatalogError(msg: string): boolean {
  return /^\s*(?:Failed to extract statements:\s*)?(?:Binder|Catalog) Error:/i.test(withoutSqlEcho(msg))
}

/**
 * layer2 只读沙箱的文件/网络拦截。实测五形态（read_csv / read_text / glob / COPY /
 * ATTACH / EXPORT / INSTALL）报文恒以 `Permission Error: Cannot access file|directory
 * "…" - file system operations are disabled by configuration` 开头。
 *
 * ⚠️ 四个条件缺一不可：
 *   · 剥掉 SQL 回显后判定 —— `Parser Error` 会把出错行 SQL 全文附在 `LINE n:` 之后，
 *     SQL 里恰好含特征句（`SELEC 'file system operations are disabled by configuration'`，
 *     实测）会被判成「已被沙箱拦截」（真实成因是语法错，归因是假的）；
 *   · 锚**类别前缀** `Permission Error:` —— 特征句单独出现在回显区/列值里不算数；
 *   · 同时要特征句 **`file system operations are disabled`** —— 这才是「配置禁用」的
 *     标记。`Cannot access file` 单独出现不作数：裸的文件访问失败也可能带
 *     `Permission Error:` 前缀，把它算成「被沙箱拦截」会把环境问题说成用法问题。
 *   · 特征句还必须锚在**句尾**（` - … by configuration` 结尾，2026-11-01 Sourcery）：
 *     头部里的引号路径是用户给的，路径本身含这句话时只搜子串仍会误判。
 *     七种实测形态全部以这半句收尾。
 */
export function isLayer2Blocked(msg: string): boolean {
  const head = withoutSqlEcho(msg)
  return /^Permission Error:/i.test(head)
    && / - file system operations are disabled by configuration\s*$/i.test(head)
}
