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
 * 所以判「这段数据完整吗」只能看 `gaps`，不能看 `range_status`。
 */
export const RANGE_STATUS_NOTES = {
  pending: '水位没动过（该任务尚未成功推进过水位）。⚠️ 不代表库里没有数据：'
    + '首窗失败时后续成功窗照常落库、只是不推水位（实测 3 窗首窗失败 → pending 且表里有 2 行）。'
    + '也不代表「正在同步」——运行中的写者会让本命令先退避等待、等到后读到的是那一轮的结果',
  complete: '水位推进过。⚠️ 不代表「全窗口成功」：引擎每个成功窗都写 complete，'
    + '中窗失败时 run 报 partial 而这里仍是 complete（实测）。判定数据是否完整只能看 gaps',
  'null': '该任务在 sync_state 里没有行（从未运行过，或只跑过被跳过的残段窗）。'
    + '与 pending 不同：pending 至少有 markPending 写过行',
} satisfies Record<'pending' | 'complete' | 'null', string>

/**
 * `sync run` 的 `status` 三个取值的释义。
 *
 * ⚠️ `partial` 字面是「部分成功」，但它同样覆盖「一行都没落」：windowed 任务的引擎
 * 对「全部窗口都失败」也产出 partial（succeeded: 0），`failed` 只留给连窗口循环都
 * 进不去的异常路径（快照任务的限频闸门拦截）。实测 `tickets.search --since 1d`
 * 全窗失败 → status=partial、windows.succeeded=0、退出码 1。
 */
export const RUN_STATUS_NOTES = {
  complete: '全部窗口成功（failed=0）',
  partial: '至少一个窗口失败。⚠️ 它也覆盖「一行都没落」的全窗失败——'
    + '判有没有拿到数据看 windows.succeeded，不要看这个字面',
  failed: '连窗口循环都没进（目前只有快照任务被本地限频闸门拦下这一条路径）',
} satisfies Record<RunStatus, string>

/** `sync run` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function runFieldNotes(): Record<string, string> {
  return {
    'tasks[].status': renderNotes(RUN_STATUS_NOTES),
    'tasks[].windows.skipped': '残段窗数（日对齐任务被显式区间钳出的非日界首/末段）：'
      + '引擎跳过不 fetch、不写库、不推水位，但计入 total（total = succeeded + failed + skipped）',
    'tasks[].resolved_range': '本轮实际覆盖到的区间。末端与水位同源：出现失败窗后水位冻结在'
      + '连续成功末端，因此它可能早于你请求的 end —— 那正是「没覆盖完」的证据',
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
    gaps: 'sync_gaps 里的历史缺口（含已不再适用的旧记录：成功窗只清它自己那个起点的缺口，'
      + '换了窗口边界重跑不会清掉旧起点的记录）。gaps 非空 ≠ 当前数据有问题，按 reason 判断',
    'gaps[].reason': '取值与动作见 README 的 gaps 图例（与 sync run 的 gaps[].reason 同一组值）',
    'gaps[].range': '原样回显 sync_gaps 的存储值（epoch 毫秒字符串），不是 run 输出的'
      + ' +08:00 ISO 形态 —— 要比较请先按同一形态解析',
    resolved_range: '上次成功推进覆盖的区间；null = 尚无成功推进（或 v9 之前的旧记录）',
  }
}

/** `sync verify` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function verifyFieldNotes(): Record<string, string> {
  return {
    state_windows_consistent: 'true = sync_state 记录为「水位已推进且 range_status=complete」。'
      + '⚠️ 这不代表数据完整：range_status 的 complete 只说明「水位推进过」，'
      + '中窗失败的 run 同样是 complete。要判完整性看 drift 与本命令退出码',
    expected_from_api: 'null 有两种成因，用 kind 区分：windowed 任务不做上游全量重拉'
      + '（成本高，恒为 null），或快照任务的上游取数失败（此时 drift 里有 fetch_failed）',
    'drift[].kind': '取值与动作见 README 的 drift 图例',
    'drift[].detail': '给人读的中文说明；程序判断请用 kind',
  }
}

/** `sync tasks` 的 `meta.field_notes`（导出供测试核对真实渲染路径）。 */
export function tasksFieldNotes(): Record<string, string> {
  return {
    kind: 'windowed = 窗口型：按时间切片增量拉，有水位；'
      + 'snapshot = 快照型：全量拉取、全删重插（幂等）。'
      + '⚠️ 读 verify 的输出前必须先看它：只有 snapshot 的 expected_from_api 有意义',
    unsupported: '明确不做同步的数据集及原因（不是遗漏）。目前唯一取值 realtime = '
      + '实时快照，数据随推随逝、不可回放——这类数据只能走 api call 实时取，别去 sync run 里找',
    'tasks[].watermark.initial': '恒为 null —— 全部 21 个任务都没有声明初始水位'
      + '（首跑从 0 / --since 起）。看到非 null 才需要按它解释续跑起点',
    sensitive_columns: '该表标注为敏感的 PII 列清单（来自 schema 的声明闭集）。'
      + '查询这些列会默认脱敏；不要 SELECT *',
  }
}