#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { realpathSync } from 'node:fs'
import { authCommand } from './commands/auth.js'
import { fail, usageFail, describeArgs } from './output.js'
import { apiCommand } from './commands/api.js'
import { storeCommand } from './commands/store.js'
import { syncCommand } from './commands/sync.js'
import { dbCommand } from './commands/db.js'
import { queryCommand } from './commands/query.js'
import { statsCommand } from './commands/stats.js'

const COMMANDS: Record<string, (argv: string[]) => Promise<number>> = {
  auth: authCommand,
  api: apiCommand,
  store: storeCommand,
  sync: syncCommand,
  db: dbCommand,
  query: queryCommand,
  stats: statsCommand,
}

/**
 * 顶层用法说明。**走 stdout、退出码 0** —— 这不是错误，是请求帮助。
 * ⚠️ 全局约束承诺了「CLI 的 `--help` 一律中文」，所以这里必须实现它，
 * 不能让它落到「未知子命令」分支（实测那会输出「未知子命令：--help」，退出码 2）。
 */
const USAGE = `用法：qiyu <子命令> [参数]

子命令：
  auth whoami              检查凭证是否已配置
  api list [--all]         列出接口（默认只列可主动调用的出站接口）
  api call <id> [--body <JSON>] [--yes] [--no-validate] [--strict]
                           调用接口；危险接口必须加 --yes
  api schema <id>         查看接口的请求参数表与响应形状
  store init [--db <path>] [--profile <name>] [--backend <name>]
                           初始化本地数据库（DuckDB）
  store status [--db <path>] [--profile <name>] [--backend <name>]
                           查看数据库状态与各表行数
  sync tasks               列出全部同步任务与不支持的实时快照数据集
  sync run [任务...]        同步数据进本地库（--full / --since / --until / --quiet）
  sync status [任务...]     水位、区间状态、缺口与锁（只读；缺省全部任务）
  sync verify [任务...]     核对本地与远端一致性（快照三方核对；drift 非空退出码 1）
  sync install --schedule CRON [--yes]
                           安装系统定时调度（macOS=launchd / linux=systemd user /
                           win32=schtasks。默认 dry-run；--yes 才写入）
  sync uninstall [--yes]   移除系统调度条目（默认 dry-run，--yes 才删除）
  db tables                列出库中全部表：行数、粒度、时间范围、PII 列
  db describe <表>         查看单表列定义（列名、类型、可空、敏感标记、时间列）
  query --sql <SQL>        任意只读 SQL（三层只读沙箱 + 默认脱敏 + 行数上限 + 超时）
  query --table <表> --since <时间> [--group-by <列>]
                           受约束查询通道（列白名单、时间列语义化、精确脱敏）
  stats fields <报表表>     指标声明（带出处）+ 本地观测分布 + -1 哨兵

查询族参数：
  query --limit <n> / --timeout <秒> / --no-mask
                           行数上限 / 超时 / 关闭默认脱敏（细节见 qiyu query --help）
  --db <path> / --profile <name> / --backend <name>
                           db / query / stats 共用的存储定位（与 store / sync 同族）

出错时 stdout 是 {"ok":false,"error":{code,kind,retryable,message,hint?}}。
  ⚠️ 请按 kind 分支，不要按 code —— code 只是个标签：它可能是服务端的
     数字码（如 14009），也可能是本 CLI 合成的词（usage / network / internal /
     auth_missing / confirm_required / store_locked / store_not_initialized /
     local_rate_limit / unknown）。合成词查不到官方错误码表。

退出码：0 成功 · 1 业务错误 · 2 用法错误 · 3 网络错误 · 4 需要 --yes
`

export async function run(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv
  if (sub === '--help' || sub === '-h') {
    // ⚠️ `--help` 不吞额外参数（2026-10-08 修）—— 与叶子命令同一条次序
    // （未知/位置参数 → help）。此前它是"首个 token 特判且排在最前"，实测
    // `qiyu --help --bod` / `qiyu --help extra` 都返回 0、把拼错的 flag / 多余的位置
    // 参数**静默吞掉**（而 `qiyu --bod` 单独跑是 2）—— "多带一个 --help"把一条用法
    // 错误变成了静默成功，与 `api list --al --help` 是同一个坑，分派层这一处漏了。
    // `--help --help` 仍给帮助：`--help`/`-h` 是这条伪命令仅有的合法 token
    // （与 `api list --help --help` 同答 —— 都不算"额外参数"）。
    // ⚠️ `--pretty` 同样豁免（2026-10-08）：它是**合法 flag**（承诺过、未实现），
    // 不是"额外参数"—— `qiyu --help --pretty` 给帮助（与 `api list --help --pretty` 同答）。
    const extra = rest.filter((a) => a !== '--help' && a !== '-h' && a !== '--pretty')
    if (extra.length > 0) {
      return usageFail(`未知参数：${describeArgs(extra)}。--help 不接受额外参数`)
    }
    process.stdout.write(USAGE)
    return 0
  }
  // ⚠️ 分派层的 `--pretty` 必须与叶子层同答（2026-10-08 统一）。此前它落到
  // 「未知子命令：--pretty」—— 而 `--pretty` 是**承诺过、只是未实现**的合法 flag
  // （与 ㉖ 在叶子层修的是同一句话），把合法 flag 说成"未知子命令"是同一类事实错误；
  // 且 `qiyu --pretty --help` 此前被静默吞成 2（而 `qiyu api list --pretty --help` 是 0）。
  // 次序与叶子层逐字一致：**未知/位置 → help → `--pretty`**。
  if (sub === '--pretty') {
    const unknown = rest.filter((a) => a.startsWith('-') && a !== '--pretty' && a !== '--help' && a !== '-h')
    const positional = rest.filter((a) => !a.startsWith('-'))
    const extra = [...unknown, ...positional]
    if (extra.length > 0) {
      return usageFail(`未知参数：${describeArgs(extra)}。--pretty 尚未实现，不接受额外参数`)
    }
    if (rest.includes('--help') || rest.includes('-h')) {
      process.stdout.write(USAGE)
      return 0
    }
    return usageFail('--pretty 尚未实现（无参数替代它）。当前只输出紧凑 JSON。')
  }
  if (!sub) {
    return usageFail(`用法：qiyu <子命令> [参数]（\`qiyu --help\` 查看全部）`)
  }
  // ⚠️ 判据必须是 `Object.hasOwn` 而**不是** `if (!handler)`。
  // `COMMANDS` 是普通对象字面量，`COMMANDS['toString']` 会命中
  // `Object.prototype.toString`（**truthy**）—— 于是 `if (!handler)` 不成立，
  // 原型方法被当成子命令处理器调用。实测（Node 24）：
  //   toString / constructor → 返回非数字（string / []），
  //     随后 `process.exitCode = <非数字>` 抛 ERR_INVALID_ARG_TYPE
  //   valueOf / hasOwnProperty / __proto__ → 直接抛 TypeError
  // 配合入口缺 `.catch()`（见下方），这些 rejection 会变成 unhandled rejection：
  // Node 打印一段原生堆栈、退出码 1 —— 既不是「未知子命令」的退出码 2，
  // 也不符合「stdout 必须是合法 JSON」的契约（错误要在 stdout 出 JSON，stderr 只是镜像）。
  //
  // 这不是假想的：仓库已在 `core/ratelimit.ts` 修过**同一类问题**
  // （`Object.hasOwn(RATE_LIMITS, endpointId)`，并有测试钉 `limitFor('constructor')`）。
  // 同类缺陷只修了一处 —— 分发表漏了。
  if (!Object.hasOwn(COMMANDS, sub)) {
    // ⚠️ 用 describeArgs 渲染 sub（2026-10-08 修）：`qiyu " "` 此前报
    // 「未知子命令： ；可用子命令：…」—— 名字是纯空白、不可见，
    // 与空串参数是同一个病（说明必须指名它抱怨的东西）。
    return usageFail(
      `未知子命令：${describeArgs([sub])}\n可用子命令：${Object.keys(COMMANDS).join('、') || '（暂无）'}`)
  }
  return COMMANDS[sub](rest)
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  // ⚠️ 用 `process.exitCode = code`，**不要**用 `process.exit` —— 后者会在
  // stdout 尚未排空时强杀进程，把大输出**静默截断**。实测（Node 24）：`api call`
  // 管道输出 392846 字节时只写出 131072 字节（正好是 128 KiB 管道缓冲区），
  // 退出码仍是 0、没有任何报错。而 `qiyu api call ticket.search | jq` 正是 Agent
  // 的标准用法，也是**唯一**值得管道的场景（大结果集）—— 它拿到的 JSON 会在中间
  // 断掉，jq 报一个与真实原因（输出太大）毫无关系的解析错误。
  // 设 `exitCode` 后让事件循环自然结束，Node 会先把 stdout 排空再退出。
  // （`AbortSignal.timeout` 用的是 unref 定时器，不会拖住进程 —— 已验证。）
  // ⚠️ **必须挂 `.catch()`** —— `run()` 的类型签名是 `Promise<number>`，**不保证不抛**。
  // 任一子命令抛出未捕获异常时 `.then` 的成功分支不执行，而没有 `.catch()` 时
  // rejection 变成 unhandled rejection：Node 打印一段原生堆栈（含文件路径与
  // `file://` URL）到 stderr、**stdout 0 字节**、退出码 1。此时 stdout 既不是合法
  // JSON、也没有任何内容 —— 全局约束「其余任何情况下 stdout 都必须是合法 JSON」
  // 在这条路径上完全落空。
  //
  // 为什么各子命令自己的 try/catch 不够：那是**逐命令**的。入口要对
  // 「将来某个任务新增的子命令忘了 catch」与「原型键命中了不存在的处理器」
  // （见上方 `Object.hasOwn` 的说明）这两种情形零防护兜底。
  // → 未捕获异常映射到 `EXIT.BUSINESS`(1)，与 `exitCodeFor` 的 default 一致。
  run(process.argv.slice(2))
    .then((code) => { process.exitCode = code })
    .catch((e: unknown) => {
      // ⚠️ catch 里必须走 `fail()`，stdout 才有合法 JSON —— 只写 stderr 的话
      // `qiyu … | jq` 在这条路径上仍然 parse error，而 jq 报的是解析错误，
      // Agent 看不到真正的原因。全局约束要求「其余任何情况下 stdout 都必须是
      // 合法 JSON」，catch 是其中一条路径，不豁免。
      process.exitCode = fail({
        code: 'internal', kind: 'internal', retryable: false,
        message: e instanceof Error ? e.message : String(e),
        hint: 'CLI 内部错误，这应当报告为缺陷 —— 请附上复现命令。',
      })
    })
}
