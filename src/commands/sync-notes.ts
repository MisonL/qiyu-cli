// src/commands/sync-notes.ts
//
// `sync run` / `sync status` / `sync verify` 的 `meta.field_notes` 图例 —— 三个命令
// **共用同一个构造点**。
//
// ⚠️ 为什么单独一个模块而不是放在 sync.ts：`sync.ts` import `sync-run.ts`
// （`runSyncRun`），把 `runFieldNotes` 放进 sync.ts 会让 sync-run.ts 反向 import，
// 形成模块环。图例本身不依赖任何一方，独立成叶子模块最干净。
//
// ⚠️ 为什么必须逐值写出来：这三个命令输出的是 Agent 要**按值分支**的机器值
// （`range_status` / `status` / `locked` / `state_windows_consistent`），而其中两个
// 取值的字面与事实相反（详见 RANGE_STATUS_NOTES / RUN_STATUS_NOTES 的注释）。
// 只输出英文词不解释 = 把猜测从字段名挪到了枚举值上。
import type { RunStatus } from '../sync/types.js'
import type { RangeStatusValue } from '../sync/state.js'

/** 渲染成 `a = 释义；b = 释义` —— field_notes 的单元格形态（与 api list / skill where 同款）。 */
function renderNotes(notes: Record<string, string>): string {
  return Object.entries(notes).map(([k, v]) => `${k} = ${v}`).join('；')
}

/**
 * `range_status` 三个取值（含 null）的释义。
 *
 * ⚠️ 两个取值的字面都在撒谎，图例必须把**真实语义**写出来（2026-10-27 实测）：
 *  · `complete` ≠ 「全窗口成功」（设计稿 §6.1 的原话）：引擎每个成功窗都
 *    `advanceWatermark`，它无条件写 complete。3 窗中窗失败 → run 报 partial，
 *    而 range_status 仍是 complete。它只说明「水位推进过」。
 *  · `pending` ≠ 「一行都没写」：首窗失败时 watermarkRange 为 null，后续成功窗
 *    照常落库但不推水位 → pending 而表里有数据。它只说明「水位没动过」。
 *  · `null` = 该任务在 sync_state 里**没有行**（从未跑过，或只跑过被跳过的残段窗）。
 * 所以判「这段数据完整吗」不能只看 `gaps`：`windows.skipped > 0` 时可能 gaps 为空，
 * 但请求区间仍有未覆盖段。必须综合三个判据：
 *   1. 覆盖是否完整？→ `resolved_range.end >= 请求 end` 且 `windows.skipped = 0`
 *   2. 历史缺口是否还成立？→ 把每条 gap 的 range 与请求区间对照；对不上或说不清就写「新鲜度未确认」
 *   3. 空 gaps 是否意味着完整？→ 不一定！若 skipped > 0 或有其他未完成路径，仍是残缺。
 */
export const RANGE_STATUS_NOTES = {
  pending: '最近一次运行没有成功推进水位（引擎每轮开跑就把状态置 pending，只有成功窗才推回'
    + ' complete）。⚠️ 三种误读都要避免。① 不代表库里没有数据：首窗失败时后续成功窗照常落库、'
    + '只是不推水位（实测 3 窗首窗失败 → pending 且表里有 2 行）。② 不代表「从未同步过」：'
    + '先成功一轮、再跑一轮首窗失败，同样回到 pending 而 watermark 保留着上一轮的值'
    + '（实测 watermark 仍是上一轮的 1970-01-04）。③ 不代表「正在同步」：运行中的写者会让'
    + '本命令先退避等待、等到后读到的是那一轮的结果',
  complete: '水位推进过。⚠️ 不代表「全窗口成功」：引擎每个成功窗都写 complete，'
    + '中窗失败时 run 报 partial 而这里仍是 complete（实测）。判定数据完整要综合三个判据：'
    + '覆盖范围（resolved_range / windows.skipped）、历史缺口新鲜度（按 range 对照）与'
    + '空 gaps 的真实含义（skipped > 0 时可能 gaps 为空但仍有未覆盖段）。',
  'null': '该任务在 sync_state 里没有行（从未运行过，或只跑过被跳过的残段窗）。'
    + '与 pending 不同：pending 至少有 markPending 写过行',
} satisfies Record<RangeStatusValue | 'null', string>

/**
 * `sync run` 的 `status` 三个取值的释义。
 *
 * ⚠️ `partial` 字面是「部分成功」，但它同样覆盖「一行都没落」：windowed 任务的引擎
 * 对「全部窗口都失败」也产出 partial（succeeded: 0），`failed` 只留给连窗口循环都
 * 进不去的异常路径（快照任务的限频闸门拦截）。实测 `tickets.search --since 1d`
 * 全窗失败 → status=partial、windows.succeeded=0、退出码 1。
 */
export const RUN_STATUS_NOTES = {
  complete: '没有失败窗口（windows.failed = 0）。⚠️ 它不保证「全部窗口都跑了」：'
    + 'windows.skipped 可能大于 0（残段窗被跳过）。判实际覆盖要看 skipped，见该字段的说明',
  partial: '至少一个窗口失败。⚠️ 它也覆盖「一行都没落」的全窗失败（succeeded=0）——'
    + '不要按这个字面判断结果。两个字段分开读：windows.succeeded = 成功窗数'
    + '（空窗也算成功，所以它大于 0 不代表有行）。rows.written = 真正落库的行数'
    + '（为 0 也可能是「窗口都成功、只是上游没数据」）',
  failed: '快照任务的失败路径（快照没有窗口循环，所以不会出现 partial）：本地限频闸门拦截、'
    + '上游取数失败、落库失败或行数核对不符。windowed 任务不会给出 failed —— 全窗失败也是'
    + ' partial（见上一条）',
} satisfies Record<RunStatus, string>

/** `sync run` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function runFieldNotes(): Record<string, string> {
  return {
    'tasks[].status': renderNotes(RUN_STATUS_NOTES),
    'tasks[].windows.skipped': '残段窗数（日对齐任务被显式区间钳出的非日界首/末段）：'
      + '引擎跳过不 fetch、不写库、不推水位，但计入 total（total = succeeded + failed + skipped）',
    'tasks[].resolved_range': '本轮请求的水位区间（start = 水位/请求起点语义，'
      + '日对齐任务的首残段可能被跳过、start 前缀不会自动前移，所以它不是「已覆盖」的保证）。'
      + '末端与水位同源：出现失败窗后水位冻结在连续成功末端，因此它可能早于你请求的 end。'
      + '评估真实覆盖要看 end 与 windows.skipped，不要只看 start',
    'tasks[].gaps': '本轮失败/提示的缺口逐条记录（reason 取值见 README 图例）。'
      + 'gaps 非空不等于同步失败：后四个 reason 是成功窗上的业务提示',
    truncated: '恒为 false —— sync run 不按 --limit 截断任务列表（这是与 query 的同名字段'
      + '语义不同之处，那边才是「只拿到截断样本」）',
  }
}

/** `sync status` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function statusFieldNotes(): Record<string, string> {
  return {
    range_status: renderNotes(RANGE_STATUS_NOTES),
    locked: 'true = sync_state 里有残留的写者章（上一轮运行被强杀，来不及清）。'
      + '⚠️ 这不是「正在同步中」：真正持有写锁的进程会让本命令先退避等待'
      + '（readOnlyRetryMs，默认 30 秒）——等到了说明那一轮已结束、章也清了（返回 false），'
      + '等不到才报 store_locked。所以看到 true 说明写锁当前是空的、章是残留的，'
      + '重跑 sync run 即可（引擎会重新盖章）',
    gaps: 'sync_gaps 里的历史缺口。⚠️ 它是历史记录、不等于当前仍缺：成功窗只清它自己那个'
      + '起点的缺口，换窗口边界重跑不会清掉旧起点的记录——旧记录的 reason 与新记录相同，'
      + '按 reason 区分不出新旧。range 也只能说明「相关」：换边界重跑后数据可能已补齐，'
      + '而旧缺口的 range 仍与你要评估的区间重叠。所以没有一次覆盖核对就不能确认新鲜度——'
      + '报「该区间有历史缺口记录，新鲜度未确认」，不要直接报成当前故障',
    'gaps[].reason': '取值与动作见 README 的 gaps 图例（与 sync run 的 gaps[].reason 同一组值）',
    'gaps[].range': '原样回显 sync_gaps 的存储值（epoch 毫秒字符串），不是 run 输出的'
      + ' +08:00 ISO 形态 —— 要比较请先按同一形态解析',
    resolved_range: '上次成功推进的水位区间。⚠️ start 是水位起点语义、含可能被跳过的首残段'
      + '前缀（实测：日对齐任务从非日界起点跑 → skipped=2 而 start 仍等于请求起点），'
      + '所以它不是「已覆盖」的保证；本命令不输出 windows.skipped，判实际覆盖要看 '
      + 'sync run 的 windows.skipped。null = 尚无成功推进（或 v9 之前的旧记录）',
  }
}

/** `sync verify` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function verifyFieldNotes(): Record<string, string> {
  return {
    state_windows_consistent: 'true = sync_state 记录为「水位已推进且 range_status=complete」。'
      + '⚠️ 这不代表数据完整；drift 为空 / 退出码 0 同样不能当完整性证据 —— '
      + '对 windowed 任务本命令只核对同步状态记录（实测中窗失败的库同样给 drift: [] 且'
      + '退出码 0），快照任务则另有上游行数核对。windowed 的完整性要另行核对两处：'
      + 'sync status 的 gaps 与 resolved_range（能否确认新鲜度见该字段的说明），'
      + '以及 sync run 的 windows.skipped（本命令与 status 都不输出它）',
    expected_from_api: 'null 有两种成因，看 drift 里有没有 fetch_failed 区分：'
      + 'windowed 任务不做上游全量重拉（成本高，恒为 null）；快照任务则是上游取数失败'
      + '（此时 drift 里有 kind=fetch_failed 的条目）',
    'drift[].kind': '取值与动作见 README 的 drift 图例',
    'drift[].detail': '给人读的中文说明；程序判断请用 kind',
  }
}

/** `sync tasks` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function tasksFieldNotes(): Record<string, string> {
  return {
    'tasks[].kind': 'windowed = 窗口型：按时间切片增量拉，有水位；'
      + 'snapshot = 快照型：全量拉取、全删重插（幂等）。'
      + '⚠️ 读 verify 的输出前必须先看它：只有 snapshot 的 expected_from_api 有意义',
    unsupported: '明确不做同步的数据集及原因（不是遗漏）。目前唯一取值 realtime = '
      + '实时快照，数据随推随逝、不可回放——这类数据只能走 api call 实时取，别去 sync run 里找',
    'tasks[].watermark.initial': '恒为 null —— 全部 21 个任务都没有声明初始水位'
      + '（首跑从 0 或 --since 起；声明了 windowStartFloorDays 的任务还会被抬到'
      + ' now − N 天，因为接口物理上给不出更早的数据）。看到非 null 才需要按它解释续跑起点',
    'tasks[].sensitive_columns': '该表标注为敏感的 PII 列清单（来自 schema 的声明闭集）。'
      + '查询这些列会默认脱敏；不要 SELECT *',
  }
}

/**
 * `sync install` / `sync uninstall` 的四种输出形态。
 *
 * ⚠️ 为什么按模式分开（与 `skill install` 的 `installFieldNotes(mode)` 同款）：
 * 四个分支的键集**各不相同** —— dry-run 有 `entries`/`remove` 而没有 `installed`/`removed`，
 * 真实安装有 `installed` 而没有 `entries`。一份图例解释四个不存在的键，就是「声明了但
 * 没人读」的反向形态。
 */
export const SYNC_INSTALL_MODES = ['install-dry', 'install-real', 'uninstall-dry', 'uninstall-real'] as const
export type SyncInstallMode = typeof SYNC_INSTALL_MODES[number]

/** 四个分支共用的命令条目释义（`commands[]` 的每一项）。 */
const SYNC_COMMAND_NOTES: Record<string, string> = {
  'commands[].command': '将要执行（dry-run）或已执行（--yes）的命令原文',
  'commands[].executed': '是否真的执行了这条命令。dry-run 恒为 false。--yes 下每条被列出的都执行了'
    + '（uninstall 在「从未安装」时整条 commands 为空数组 —— 那是没有可停的调度器，不是执行失败）',
  'commands[].ok': '三值：null = 未执行（dry-run），true = 执行成功，false = 执行失败。'
    + '⚠️ null 既不是成功也不是失败，别按布尔值用',
  'commands[].error': '失败原因。未执行或成功时为 null',
}

const INSTALL_ENV_NOTE = '给人读的说明。恒含一条「调度条目不继承 shell 环境」——'
  + '凭证走 QIYU_APP_KEY / QIYU_APP_SECRET 时要确认调度上下文能拿到，本条目不写入任何凭证'

/** `sync install` / `sync uninstall` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function syncInstallFieldNotes(mode: SyncInstallMode): Record<string, string> {
  const base: Record<string, string> = {
    platform: '调度平台：darwin = launchd，linux = systemd，win32 = schtasks。'
      + '其他平台在命令入口直接报不支持（退出码 2），不会有本输出',
    dry_run: 'true = 只打印计划，零文件写入、零命令执行。false = 真的执行了。'
      + '⚠️ 判断「装没装」看这个字段，不要只看退出码',
    ...SYNC_COMMAND_NOTES,
  }
  switch (mode) {
    case 'install-dry':
      return {
        ...base,
        schedule: '回显的 cron 表达式（原样）',
        'entries[].path': '将要写入的条目文件路径（dry-run 下文件尚未创建）',
        'entries[].content': '将要写入的完整文件内容（dry-run 只回显，没有写盘）',
        notes: INSTALL_ENV_NOTE,
      }
    case 'install-real':
      return {
        ...base,
        schedule: '回显的 cron 表达式（原样）',
        installed: '已写入的条目文件路径。文件在命令执行之前写入，所以即便随后某条命令失败'
          + '（退出码 1），这些文件也已经写进去了。⚠️ 写入成功不等于调度已生效（launchd 需 load，'
          + 'systemd 需 enable，见 commands[] 的结果）',
        notes: INSTALL_ENV_NOTE,
      }
    case 'uninstall-dry':
      return {
        ...base,
        'remove[].path': '计划要删除的条目文件路径（dry-run 下文件尚未删除）',
        'remove[].exists': '计划生成那一刻探测到的存在性（true = 当时文件在）。'
          + '这是探测快照不是承诺：--yes 会重新探测一次，删除动作对所有条目都执行'
          + '（rmSync force，不存在也不报错），removed 与 absent 按那一次探测的 exists 划分',
        notes: '给人读的说明。darwin/linux 含卸载次序（先停调度器，再删文件），win32 说明 schtasks 的行为',
      }
    case 'uninstall-real':
      return {
        ...base,
        removed: '计划探测时存在、且删除调用未报错的文件路径',
        absent: '计划探测时就不存在、因此没删的文件路径。⚠️ 这是条件键：为空时整个键不出现，'
          + '不出现 ≠ 没有这类路径',
        notes: '给人读的说明。从未安装（探测不到任何条目文件）时只有一条'
          + '「未安装（无条目文件）：未执行任何命令」，此时 commands 为空数组',
      }
  }
}
