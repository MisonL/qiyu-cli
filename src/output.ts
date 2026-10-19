
export const EXIT = {
  OK: 0,            // 成功
  BUSINESS: 1,      // 业务错误
  USAGE: 2,         // 用法错误
  NETWORK: 3,       // 网络错误
  NEEDS_CONFIRM: 4, // 需要 --yes
} as const

/** 调用方传进来的形态：驼峰，因为这是 TypeScript 侧的内部约定。 */
export interface ErrorInput {
  code: string
  kind: string
  retryable: boolean
  message: string
  hint?: string
  retryAfter?: { seconds: number; source: 'observed' | 'doc' | 'local' | 'fallback' }
  /**
   * ⚠️ 本计划不填。设计稿 §9.1 在限流示例里列了它，但"改用本地查询"这个动作
   * 依赖存储层，本计划没有 store/（见「已知缺口」）。留空键、等有实现时再填，
   * 好过写一个 Agent 会照做却查不到表的死值。
   */
  retryStrategy?: string
  /** 同上：fallback 指向的是尚不存在的 `qiyu query` 命令。 */
  fallback?: string
  /**
   * 设为 true 即请求"这是危险操作"。**它同时决定三件事**，调用方只需给这一个字段：
   * 出参的 `confirm_required`、`confirm_arg`（硬编码 `--yes`）、`risk`（硬编码 `irreversible`）
   * 全部由 `fail()` 补齐。调用方**不需要也不应该**传 `confirmArg` / `risk` ——
   * 这两个值没有第二种可能，让调用方传只会多出两个可以被传错的地方。
   */
  confirmRequired?: true
  /** 被拦下的接口 id。缺省时空串 —— 但 `needs_confirmation` 下传空串是无意义的，
   *  门禁路径（任务 11）保证一定给值。 */
  target?: string
}

/** 真正写进 stdout 的形态：下划线命名。这是 Agent 契约的一部分，不可随意改名。 */
export interface ErrorPayload {
  code: string
  kind: string
  retryable: boolean
  message: string
  hint?: string
  retry_after?: { seconds: number; source: 'observed' | 'doc' | 'local' | 'fallback' }
  retry_strategy?: string
  fallback?: string
  confirm_required?: true
  confirm_arg?: '--yes'
  risk?: 'irreversible'
  target?: string
}

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + '\n')
}

/**
 * 把一组参数渲染进错误消息，**保证空串与空白参数不会被渲染成"什么都没有"**。
 *
 * ⚠️ **为什么需要它**（2026-10-05 补，实测）：此前各处直接写
 * `` `${argv.join('、')}` ``，于是 `qiyu api list "$UNSET"`（shell 变量未设置，
 * 展开成空串）得到一句 **`未知参数：。`** —— 冒号后面什么都没有。Agent 收到的是
 * 一个**没有指名任何东西**的用法错误：它不知道该改哪个参数，因为消息里根本没有参数。
 * 而"用法错误"的全部价值就是告诉 Agent **改哪里**（退出码 2 的语义是"改参数重来"）。
 * 空白参数（`" "`、`"\t"`）同样渲染成不可见的字符，效果相同。
 *
 * 修法：空串与**纯空白**都写成 `'…'`（空串即 `''`）—— 引号让它们不再是"什么都没有"，
 * `未知参数：''。` / `未知参数：' '。` 至少指出"你传了一个空/空白参数"这个可操作的事实。
 * 其余参数原样（报错要能直接照抄进命令行）。
 *
 * ⚠️ **空白这条是 2026-10-08 才真正兑现的**：本注释从写下那天起就写着"空白参数同样"
 * 有问题，而实现只处理了空串 —— `qiyu api list " "` 报「未知参数： 。」，
 * 参数名不可见。注释承诺了、实现没做（变异表 ㊿ 实测：只回退空串分支，
 * 空白测试立即变红）。**"其余原样"不含纯空白** —— 纯空白没有"原样"可言，它原样就是不可见。
 */
export function describeArgs(args: readonly string[]): string {
  return args.map((a) => (a.trim() === '' ? `'${a}'` : a)).join('、')
}

/** 把不受信文本（调用方 body 的字段名等）中的终端控制字符抹成占位，防止 stderr 注入 ANSI/OSC 序列。 */
export { sanitizeControlChars, sanitizeMessage, stripSqlEcho } from './core/sanitize.js'
// usageFail 的出口净化要用（re-export 不建立本地绑定）。
import { sanitizeMessage } from './core/sanitize.js'

export function ok(data: unknown, meta?: unknown): number {
  // ⚠️ `data` 必须**始终存在**，即便值是 undefined 也写成 null。
  // 设计稿 §9.1 的成功形态是 `{ok, data, meta}` —— 三个键都在。
  // 若直接 `{ ok: true, data }`，JS 的 JSON.stringify 会把值为 undefined 的键**整个丢掉**，
  // 于是 `ok(undefined)` 产出 `{"ok":true}`，Agent 无法区分
  // "这个接口没有载荷"（robot.transfer.config 实测就是这样）与"我解析错了"。
  // 这与本计划在信封层反复强调的「`data` 键缺失是一种有意义的编码」是同一件事 ——
  // 输出层不能自己制造那种歧义。
  write(meta === undefined
    ? { ok: true, data: data ?? null }
    : { ok: true, data: data ?? null, meta })
  return EXIT.OK
}

function exitCodeFor(kind: string): number {
  switch (kind) {
    case 'network': return EXIT.NETWORK
    // 用法错误（未知接口 id、--body 不是合法 JSON 等）必须与业务错误分开：
    // Agent 靠退出码决定"改参数重来"还是"别重试了"，混在一起会让它做错决定。
    case 'usage': return EXIT.USAGE
    // ⚠️ 这里**故意没有** `needs_confirmation` 分支 —— 退出码 4 不由 kind 决定，
    // 而由 `confirmRequired` 决定（见下方 `fail()`）。这样「退出码 4」与
    // 「带齐四个确认字段」永远是同一个条件，不会出现「返回 4 却没告诉 Agent
    // 确认什么」的情况。`ErrorInput.kind` 是 `string`（刻意解耦），拼错成
    // `needs_confirm` 不报编译错；靠 kind 判 4 就更容易静默出错。
    default: return EXIT.BUSINESS
  }
}

export function fail(error: ErrorInput): number {
  // 入参驼峰、出参下划线。这一层改写是刻意的：
  // 内部改字段名不会破坏 Agent 契约，反之亦然。
  const e: ErrorPayload = {
    code: error.code, kind: error.kind, retryable: error.retryable, message: error.message,
  }
  if (error.hint) e.hint = error.hint
  if (error.retryAfter) e.retry_after = error.retryAfter
  if (error.retryStrategy) e.retry_strategy = error.retryStrategy
  if (error.fallback) e.fallback = error.fallback
  // ⚠️ 确认字段与退出码必须由**同一个判据**决定，不能是两个独立闸门。
    // 设计稿 §9.1 要求退出码 4 **必须**携带 `confirm_required`/`confirm_arg`/`risk`/`target`
    // 且 `retryable: false`。此前 `exitCodeFor(kind)` 与 `if (error.confirmRequired)` 互相独立，
    // 于是 `fail({ kind:'needs_confirmation', retryable:false })`（忘给 confirmRequired）
    // **合法通过类型检查、返回退出码 4、输出里一个确认字段都没有** ——
    // Agent 收到「要确认」却不告诉它确认什么、怎么确认。
    // 现在以 `confirmRequired` 为唯一判据：给了它就补齐四字段 + 强制 retryable=false +
    // 返回 4；没给它就绝不会返回 4（`exitCodeFor` 仍按 kind 分派，但它刻意没有
    // `needs_confirmation` 分支 —— 退出码 4 只由 `confirmRequired` 决定，见上方该函数内注释）。
    if (error.confirmRequired) {
      e.confirm_required = true
      e.confirm_arg = '--yes'
      e.risk = 'irreversible'
      e.target = error.target ?? ''
      // ⚠️ 硬置为 false，不接受调用方给别的值 —— 让人工确认一个不可逆操作失败后
      // 自动重试，是最坏的结果（重复执行）。设计稿把这条写成「必须」。
      e.retryable = false
      write({ ok: false, error: e })
      return EXIT.NEEDS_CONFIRM
    }
    write({ ok: false, error: e })
    return exitCodeFor(error.kind)
}

/**
 * 用法错误（退出码 2）的统一出口。
 *
 * ⚠️ **为什么必须与 `fail()` 分开、又必须也写 stdout**（2026-10-05 修，实测发现）：
 *
 * 全局约束写着「其余任何情况下 stdout 都必须是合法 JSON —— 包括所有错误输出（错误是
 * `{ok:false,error}` 形态的 JSON，**不是纯文本**）」，而「不要用 stderr 是否为空来判断
 * 成败，只认退出码与 **stdout 的 JSON**」也写在计划里。但此前**只有**未知接口 id 这一条
 * 用法错误走了 stdout JSON（因为它是 `byId()` 抛异常、被 `callOne` 的 catch 里的 `fail()`
 * 兜住），其余每一条用法错误 —— 顶层无子命令 / 未知子命令、`api` 未知子命令、
 * `api call` 缺 id、flag 写在 id 前、`--body` 重复 / 缺值 / 非法 JSON、未知参数、
 * 位置参数、`auth whoami` 多余参数 —— **一律只写 stderr 纯文本、stdout 空**。
 *
 * 后果可复现：`qiyu api call ticket.search --bogus | jq .` —— Agent 按计划教的方式读
 * stdout 的 JSON，拿到的却是**空输入**（jq 报 `parse error: Unexpected end of JSON input`），
 * 退出码 2 还落在管道里传不出去。同一条契约，"未知接口 id"满足、"未知参数"不满足 ——
 * **是同一族错误里两种行为**，正是本计划反复在修的「说明/行为与承诺不符」。
 *
 * 修法：stderr 仍写人类可读文本（`git`/`docker` 的用户习惯、且测试里多处
 * `expect(err).toContain(…)` 正钉着它），
 * 同时把**同一句话**作为 `{ok:false,error:{code:'usage',kind:'usage',...}}` 写进 stdout。
 * 这样两类读者都照顾到：人看 stderr，Agent 按契约读 stdout 的 JSON。
 */
export function usageFail(message: string, hint?: string): number {
  // ⚠️ stderr 是不受信文本进终端的主通道（security S4）：未知参数、未知表名、DuckDB 原文
  // 都拼进 message，未经净化就能注入 ANSI/OSC 序列。净化必须在**出口**做一次，
  // 而不是靠每个调用点自觉补 —— 实测 `db describe` / `query --table` 的未知表路径补了、
  // 而同文件的 `未知参数` / `--help` 多余参数路径没补，两种行为并存正是缺口的来源。
  const safe = sanitizeMessage(message)
  process.stderr.write(safe.endsWith('\n') ? safe : safe + '\n')
  return fail({
    code: 'usage', kind: 'usage', retryable: false,
    // message 去尾换行 —— stdout 的 JSON 里不该带控制字符；stderr 的文本保留换行便于阅读。
    message: safe.replace(/\n+$/, ''),
    ...(hint !== undefined ? { hint: sanitizeMessage(hint) } : {}),
  })
}
