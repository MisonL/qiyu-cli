
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

/**
 * 输出是否缩进（`--pretty`，G1 交付）。
 *
 * ⚠️ **为什么是模块级开关 + 各命令自设，而不是在 `cli.ts` 统一检测**：
 * ① `--pretty` 的**值位语义**必须由各命令自己的解析器裁决 —— `--body --pretty`
 *    里的 `--pretty` 是 body 的值（`api call` 实测报「不是合法 JSON」），
 *    cli.ts 在分派前扫描 argv 会把它误当成开关；
 * ② 命令模块的测试直接调用 `xxxCommand(argv)`（不经 cli.ts），入口层统一检测
 *    在那些测试里根本不会跑；
 * ③ 各命令原有的「未知/位置参数 → help → --pretty」次序必须逐字保留 ——
 *    设置点就放在**原先拒绝 `--pretty` 的同一位置**，次序天然不变。
 *
 * 生命周期：每条命令入口在函数开头 `setPretty(false)` 重置（同一进程内
 * `run()` 会被测试反复调用，不重置会让上一条命令的开关泄漏到下一条）。
 * 进程级只有一次真实设置点：命令在「命令行已证明合法」之后调用 `setPretty(true)`。
 */
let prettyOutput = false

/** 设置输出是否缩进。命令入口以 `false` 重置，原拒绝点以 `true` 打开。 */
export function setPretty(on: boolean): void {
  prettyOutput = on
}

function write(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj, null, prettyOutput ? 2 : undefined) + '\n')
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

/**
 * 渲染「恢复命令必须指向**本次使用的库**」的完整命令（唯一实现，2026-10-30）。
 *
 * 背景（真库实测）：hint 里写「请先运行：qiyu store init」时，若本次是用 `--db`/
 * `--profile`/环境变量选了非默认库，逐字执行会作用在**默认库**上：
 *   · `db describe tickets --db <空库>` → 照 hint 跑 `qiyu store init` → 建出
 *     `~/.qiyu/duckdb/qiyu.duckdb`，原命令再跑仍报同一句（死循环，实测）；
 *   · `sync install --db <未同步库>` → 照 hint 跑 `qiyu sync run` → 同步默认库，
 *     install 仍报 `sync_not_run`。
 * 修法：点名的命令一律带**本次解析出的绝对路径** `--db <path>`。为什么用解析后的
 * 路径而不是回显用户给的 flag：选择可能来自配置文件或环境变量（没有 flag 可回显），
 * 而 `--db` 的优先级高于两者 —— 解析后的路径在任何来源下都精确复现本次目标，
 * 且是绝对路径，换工作目录也成立。
 *
 * `syncRunCommand` 还要回显**档名**（CodeRabbit 2026-10-30 major）：`--db` 只固定库文件，
 * 而 `sync run` 还从**解析出的档**读 `store.options.knowledgeRobotIds` 与
 * `profiles.<name>.robots`（robotId 注入面）。实测：同一份 config 下带 `--profile alpha`
 * 解析出 `options={"knowledgeRobotIds":[1000001]}`、robots `["2000002"]`，不带则两者皆空 ——
 * 只回显 `--db` 的 hint 会让知识库任务用错 robot 集合。`store init` 不读 options/robots
 *（只跑迁移），故 `storeInitCommand` 不回显档名。
 *
 * ⚠️ 参数值经 `shellArg` 渲染（Python `shlex.quote` 同一安全集）：路径/档名含空白或
 * shell 元字符时用单引号包裹（`'` → `'\''`），否则裸渲染保持可读。**为什么必须引号**：
 * hint 是给 Agent 复制执行的命令 —— 未引号的 `--db /tmp/x; touch /tmp/marker; #`
 * 粘进 shell 会真的执行 `touch`（CodeRabbit 2026-10-30 major）。引号按 **POSIX shell**
 * 语义（bash/sh，也是本项目 crontab 兜底行的目标）；win32 下 PowerShell 的单引号同为
 * 字面串、可直接用，cmd.exe 不识别单引号（该平台请手工改写）—— 边界如实记录。
 */
export function storeInitCommand(path: string): string {
  return `qiyu store init --db ${shellArg(path)}`
}

/**
 * `qiyu sync run` 恢复命令，指向本次解析出的库与档（口径见 `storeInitCommand`）。
 * `profileFlag`：本次**有显式来源**的档名（flag / QIYU_PROFILE / defaultProfile，
 * 由 `resolveStoreConfig().profileFlag` 给出）；内置 default 不传 —— 显式
 * `--profile default` 会触发「点名档必须存在」守卫，在 profiles 非空且无 default 档时
 * 反而让恢复命令失败。
 */
export function syncRunCommand(path: string, profileFlag?: string): string {
  return `qiyu sync run --db ${shellArg(path)}`
    + (profileFlag === undefined ? '' : ` --profile ${shellArg(profileFlag)}`)
}

/**
 * 单个参数值的 shell 渲染（POSIX）：安全集内裸渲染，其余单引号包裹。
 * 安全集取自 Python `shlex.quote`（`[A-Za-z0-9_@%+=:,./-]`）—— 含 `$` / 反引号 /
 * 空白 / `;` / `&` / `|` 等一律引号化。单引号内一切字面，`'` 自身以 `'\''` 转义。
 * ⚠️ 解析出的路径恒为绝对路径，不含 `~`，故无「引号会阻止波浪号展开」的问题。
 */
function shellArg(v: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(v) ? v : `'${v.replace(/'/g, `'\\''`)}'`
}

/** 把不受信文本（调用方 body 的字段名等）中的终端控制字符抹成占位，防止 stderr 注入 ANSI/OSC 序列。 */
export { sanitizeControlChars, sanitizeMessage, stripSqlEcho } from './core/sanitize.js'
// usageFail 的出口净化要用（re-export 不建立本地绑定）。
import { sanitizeMessage } from './core/sanitize.js'

export function ok(data: unknown, meta?: unknown): number {
  // ⚠️ `data` 必须**始终存在**，即便值是 undefined 也写成 null。
  // 设计稿 §9.1 的成功形态是 `{ok, data, meta}` —— 但只有 `ok`/`data` 恒在：
  // `meta` 是**条件键**（有内容才出现，见下方两个分支与 `tests/output.test.ts`
  // 「未提供 meta 时不输出该键」）。这条注释早前写的是「三个键都在」，与实现相反，
  // 还经 README 传成了对 Agent 的承诺（2026-10-26 修正）。
  // 若直接 `{ ok: true, data }`，JS 的 JSON.stringify 会把值为 undefined 的键**整个丢掉**，
  // 于是 `ok(undefined)` 产出 `{"ok":true}`，Agent 无法区分
  // "这个接口没有载荷"（robot.transfer.config 实测就是这样）与"我解析错了"。
  // 这与本计划在信封层反复强调的「`data` 键缺失是一种有意义的编码」是同一件事 ——
  // 输出层不能自己制造那种歧义。
  const withSkill = mergeSkillWarning(meta)
  write(withSkill === undefined
    ? { ok: true, data: data ?? null }
    : { ok: true, data: data ?? null, meta: withSkill })
  return EXIT.OK
}

/**
 * 待并入下一次成功输出 `meta.warnings` 的安装态提示（Task 10，spec D2.1）。
 *
 * ⚠️ **为什么是模块级注入而不是 `ok()` 自己探测**：`output.ts` 属于 CLI 输出层，
 * 而探测在 `skill/`（叶子层）。分层红线（Task 14 用测试钉住）要求
 * `output.ts`/`core/`/`commands/` 不得 import `skill/` —— 直接在这里
 * `import { skillWarning } from './skill/detect.js'` 会让这条红线失守。所以由
 * `cli.ts`（允许 import 两边）探测后经 `setSkillWarning()` 注入一句纯文本，
 * `ok()` 只负责合并。探测本身只发生一次、且在命令启动时（缓存见 detect.ts）。
 *
 * 生命周期是**进程级**：cli.ts 在 `run()` 开头设一次，进程内所有成功输出都带上
 * 同一条提示；测试用 `setSkillWarning(undefined)` 清除。
 */
let pendingSkillWarning: string | undefined

/** 设置（或清除，传 undefined）下一次及后续成功输出要带的安装态提示。 */
export function setSkillWarning(text: string | undefined): void {
  pendingSkillWarning = text
}

/**
 * 把 `pendingSkillWarning` 合并进 `meta.warnings`。
 *
 * 不变量（brief 逐条要求，测试钉住）：
 *   · `pendingSkillWarning === undefined` → 返回**原样的** meta（不新建空 meta、
 *     不补空 warnings 数组）——大量现有断言是 `toEqual({...})`，多一个键就全红；
 *   · meta 是普通对象 → **复制**出新对象再合并（不改调用方的对象），已有
 *     `warnings` 数组则 append，否则新建；
 *   · meta 不是对象（字符串/数组/null 等）→ 原样返回，不硬塞提示；
 *   · meta 为 undefined 且有提示 → 新建 `{ warnings: [提示] }`（这是提示唯一
 *     能出现的通道，也是唯一允许新建 meta 的情形）。
 *
 * ⚠️ **元素形状跟随既有数组保持同质**（审查 I3，控制器裁定）：不同命令的
 * `meta.warnings` 形状不同——`api call` 是结构化对象数组
 * （`{ kind, field?, message }`，见 api.ts），其余命令多为字符串数组。消费者按
 * 自己的形状读：`api call` 的消费者按 `w.kind` 过滤，若往对象数组里塞一个裸字符串，
 * `w.kind` 就是 `undefined`，静默丢失（或更糟：字符串被当对象取值）。所以：
 *   ① 没有 warnings → 新建字符串数组 `[text]`；
 *   ② 有数组且**首元素是非 null 对象** → 按对象形状 append
 *      `{ kind: 'skill_drift', message: text }`（与 api.ts 同形）；
 *   ③ 其余（空数组 / 字符串数组 / 首元素是 null 等）→ append 字符串。
 * 每个命令的 warnings 数组因此保持自身同质，两类读者都不被破坏。
 */
function mergeSkillWarning(meta: unknown): unknown {
  if (pendingSkillWarning === undefined) return meta
  if (meta === undefined) return { warnings: [pendingSkillWarning] }
  // 数组也是 object，但它不是「meta 对象」——不能给它挂 warnings 键（JSON 里
  // 数组的可枚举自有属性会被序列化掉一部分，形态不可预期）。只认普通对象。
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return meta

  const existing = (meta as { warnings?: unknown }).warnings
  let warnings: unknown[]
  if (!Array.isArray(existing)) {
    warnings = [pendingSkillWarning]
  } else if (existing.length > 0 && isPlainObject(existing[0])) {
    // 既有元素是结构化对象：保持同形，新元素带 kind 便于消费者过滤。
    warnings = [...existing, { kind: 'skill_drift', message: pendingSkillWarning }]
  } else {
    warnings = [...existing, pendingSkillWarning]
  }
  return { ...(meta as Record<string, unknown>), warnings }
}

/** 非 null 的普通对象（数组不算——它是容器，不是元素形状）。 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
/**
 * 「带 kind 的错误走 `fail()`，其余走 `usageFail()`」的统一出口（G1）。
 *
 * ⚠️ 为什么需要它：各命令的 catch 此前一律 `usageFail((e as Error).message)` ——
 * 于是**带 kind 的错误**（如 `config_insecure`：配置含凭证但权限过宽，退出码 1、
 * 只能由人 chmod 修）被降级成"用法错误，改参数重来"（退出码 2）。Agent 照退出码
 * 的语义去改参数，而这件事与参数无关。
 * → 有 `kind` 就如实透传（含 hint/retryable），没有才当用法错误。
 */
export function failFromTagged(e: unknown): number {
  const err = e as { code?: string; kind?: string; retryable?: boolean; message?: string; hint?: string }
  if (err.kind) {
    // ⚠️ 净化必须在出口做（与 usageFail 同一约定）：带 kind 的错误也会拼进路径/服务端原文，
    // 此前这条分支直接透传 —— 而调用方换成 failFromTagged 后，原本 usageFail 里的净化就
    // 消失了。sanitizeMessage 保留换行结构，正常文案一字不变。
    return fail({
      code: err.code ?? 'unknown', kind: err.kind, retryable: err.retryable ?? false,
      message: sanitizeMessage(err.message ?? String(e)),
      ...(err.hint !== undefined ? { hint: sanitizeMessage(err.hint) } : {}),
    })
  }
  return usageFail(sanitizeMessage(err.message ?? String(e)))
}

export function usageFail(message: string, hint?: string): number {
  // ⚠️ stderr 是不受信文本进终端的主通道（security S4）：未知参数、未知表名、DuckDB 原文
  // 都拼进 message，未经净化就能注入 ANSI/OSC 序列。净化必须在**出口**做一次，
  // 而不是靠每个调用点自觉补 —— 实测 `db describe` / `query --table` 的未知表路径补了、
  // 而同文件的 `未知参数` / `--help` 多余参数路径没补，两种行为并存正是缺口的来源。
  const safe = sanitizeMessage(message)
  process.stderr.write(safe.endsWith('\n') ? safe : safe + '\n')
  // ⚠️ 用法错误**永远是紧凑 JSON**，即使 `--pretty` 已开启（CodeRabbit 2026-10-25 实测发现）。
  // 契约写在 README「输出格式」与设计稿 §11.2：`--pretty` 只修饰**成功输出**，
  // 用法错误（退出码 2）保持紧凑 —— 理由不是审美，而是"先修参数，再看格式"：
  // 一个带缩进的错误信封恰好出现在"你这条命令根本没跑起来"的时刻，
  // 而 Agent 判断格式是否生效时会拿它当"格式化已生效"的证据。
  // 此前有多条分支在 `setPretty(true)` **之后**才报用法错误（如 `api schema --pretty`
  // 缺 id、`auth login --pretty` 缺环境变量），那些路径输出的就是缩进错误信封。
  // 现在在唯一的出口处强制收窄 —— 逐个调用点调整次序既脆弱又会随新分支漂移。
  const prevPretty = prettyOutput
  prettyOutput = false
  try {
    return fail({
      code: 'usage', kind: 'usage', retryable: false,
      // message 去尾换行 —— stdout 的 JSON 里不该带控制字符；stderr 的文本保留换行便于阅读。
      message: safe.replace(/\n+$/, ''),
      ...(hint !== undefined ? { hint: sanitizeMessage(hint) } : {}),
    })
  } finally {
    // 还原：用法错误是命令的终点，但同进程内连续多次 `run()`（测试里常见）时，
    // 下一条命令不该因为上一条报了个用法错误就丢掉它的 `--pretty`。
    prettyOutput = prevPretty
  }
}
