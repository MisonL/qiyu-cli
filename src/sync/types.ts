// src/sync/types.ts
// D-T5：同步引擎的任务声明模型（spec §4.1 全形）。
// 任务目录是代码（src/sync/tasks/*.ts，Task 6+ 交付）——实测事实以类型检查守护，
// 不引入 JSON 任务文件的解析层与「声明了但没人读」风险（契约诚实性）。
import type { Range } from './windowing.js'
import type { Credentials } from '../core/credentials.js'
import type { RateGate } from './rate-gate.js'
import type { Store } from '../store/types.js'

/** 事务内写落库视图：引擎的写路径只拿这些原语（不暴露 query/init/close）。 */
export type WriteOps = Pick<Store, 'delete' | 'upsert'>

/**
 * `sync run` 每任务的 `status` 取值（闭集）。
 *
 * ⚠️ 运行时数组而不是裸联合类型：这是**输出数据里的机器值**，Agent 要按它分支
 * （重跑 / 报告人类 / 放弃）。值域必须能在运行时导出，图例与测试才能双向核对。
 *
 * ⚠️⚠️ **`partial` 的字面语义是「部分成功」，但它同样覆盖「一行都没落」**：
 * windowed 任务的引擎对「全部窗口都失败」也产出 `partial`（`succeeded: 0,
 * failed: N`）——`failed` 只留给连窗口循环都进不去的异常路径（快照任务的限频闸门拦截）。
 * 2026-10-27 实测：`tickets.search --since 1d` 全窗失败 → `status: "partial"`、
 * `windows: {succeeded: 0, failed: 1}`、退出码 1。所以判「这次到底有没有拿到数据」
 * 要看 `windows.succeeded` 或退出码，**不要**看 `status` 的字面。
 */
export const RUN_STATUSES = ['complete', 'partial', 'failed'] as const
export type RunStatus = typeof RUN_STATUSES[number]

/** runTask 的结果（spec §七 sync run 输出的任务条目形态）。 */
export interface TaskRunResult {
  taskId: string
  /**
   * 窗口计数（修复批 6 #2 起 `skipped` 恒在）：total = succeeded + failed + skipped；
   * 物理切出的窗数 = total + contained（见 contained 的说明）。
   * skipped = 残段窗（日对齐任务被显式区间钳出的非日界首/末段）——引擎跳过不 fetch、
   * 不写库、不推水位（半日聚合不写日行）：末残段的整日值**可能**由其请求区间覆盖该
   * 整天的日对齐 run 补全（水位停在末整日窗 end、续跑起点落回日界；请求区间未覆盖
   * 该整天时该段仍是残段、继续跳过）；首残段不落日行也**不补**（该半日段
   * 没有合法落点，属显式 --since 区间的边界语义，要覆盖该日请给更宽的 --since）。
   * 跳过窗仍如实计数可见，绝不静默消失。
   */
  windows: {
    total: number; succeeded: number; failed: number; skipped: number
    /**
     * 被重叠区合并掉的窗数（`skipContained` 剔除，2026-11-09 起）。这些窗**不执行**：
     * 它们完全落在前一窗的回看重叠区内（overlapDays > 0 的任务，如工单 3 天回看），
     * 数据已由前一窗覆盖 —— 所以既不算 succeeded 也**不算 skipped**（skipped 的语义是
     * 「该拉的没拉」，而这里的没拉是因为重复）。仅在 > 0 时输出；**不计入 total** ——
     * 物理切出的窗数 = total + contained。
     */
    contained?: number
  }
  rows: { fetched: number; written: number }
  resolvedRange: Range
  gaps: GapInfo[]
  status: RunStatus
}

export type { Range }

/**
 * 写策略（spec §4.2）：报表按范围删旧插新；维度/会话/知识库按主键幂等 upsert。
 *
 * `deleteRangeInsert` 的**删除基准是二选一**的（两种都只删「本窗覆盖的那一段」）：
 *   · 按范围列（日粒度列，`stat_date` 等）删 → 精确前提是每个窗起止都落上海日界；
 *   · 按行内逐行瞬时时间列删 → `[start, end)` 精确，不依赖日对齐。
 * 两臂互斥而非「范围列 + 可选覆盖」：考勤表没有按天删除的用法，声明一个没人读的
 * `rangeColumns` 就是契约谎报（2026-11-03 审查）。选择依据见各臂注释。
 */
export type WriteStrategy =
  | {
    kind: 'deleteRangeInsert'
    /**
     * 按日粒度范围列删旧。**只有窗起止都落上海日界时才是精确覆盖** ——
     * 声明本臂的任务必须同时 `windowAlign: 'shanghaiDay'`（首/末残段窗会被跳过、
     * 末端上限钳制点也在日界；见 engine.ts 的切片与 `isResidualWindow`）。这个前提由
     * `src/sync/write-contract.ts` 在注册表加载期校验、`tests/sync/delete-boundary-contract.test.ts` 钉住。
     */
    rangeColumns: string[]
    /**
     * 范围列的对齐口径：'shanghaiDay' = 删除边界按上海自然日零点对齐。
     * 必须与行内日期列（stat_date/work_date）的写法同源——若行按天对齐而删除按毫秒
     * 对齐，`--full`（start=0）与增量（start=水位+1）的删除范围互不覆盖，
     * 同一个业务日会留下两行（A 中-2 的键分裂）。
     */
    rangeAlign?: 'shanghaiDay'
  }
  | {
    kind: 'deleteRangeInsert'
    /**
     * 行内逐行时间列（ISO 字符串，与 `new Date(ms).toISOString()` 同形）：按
     * `[start, end)` 精确删该列（`>= start AND <= end−1ms`），**不依赖窗是否日对齐**。
     * 用于窗起止不在日界的表（例：`staff_attendance` 按 31 天从任意起点切窗，行带
     * `hour_ts`）。按自然日删在这里无解：
     *   · 按 `[dayOf(start), dayOf(end−1)]` 删 → 会删到相邻窗已经写好的半个边界日
     *     （实测边界日只剩 16/24 小时）且永不重写；
     *   · 只删完整自然日 → 半个边界日里被上游撤掉的行永远留着（陈旧行）。
     * 逐行时间列同时做到「窗内精确覆盖、窗外一行不碰」。该列必须是表声明的
     * `timeColumn`（kind='iso-instant'）——`write-contract.ts` 校验。
     */
    instantColumn: string
  }
  | { kind: 'upsertRows' }

/**
 * 任务层 `gapHint.reason` 的**全部取值**（业务提示类缺口）。
 *
 * ⚠️ 与引擎侧四个失败原因（`ENGINE_GAP_REASONS`，见 engine.ts）共同构成
 * `sync_gaps.reason` / `sync status` 的 `gaps[].reason` / `sync run` 的 `gaps[].reason`
 * 的完整值域 —— 消费方（Agent）按值分支，所以这里的每个值都必须在 README 图例里有
 * 释义与动作（`tests/sync-enums.test.ts` 钉住两个方向：枚举 ⊆ 图例、图例 ⊆ 枚举）。
 *
 * 与失败类缺口的区别：这些是**成功窗上的提示** —— 窗口数据照常提交，`gaps` 非空
 * 不等于同步失败。此前类型是 `string`、引擎用 `as WindowGapReason` 强转，把
 * 「类型只声明四个」的谎报压了下去（2026-10-27 修）。
 *
 * ⚠️⚠️ 「提示」**不等于**「数据没缺」——这一族里有两档，消费方的动作不同，
 * 合并成一句「数据未必缺」是误导（2026-11-02 审查）：
 *   · **确实没落库**（`TASK_GAP_LOSSY_REASONS`）：描述的行/成员**真的没进库**，
 *     `detail` 是丢失规模，必须核对上游形态；
 *   · **未必缺数据**（其余）：可能只是筛选没命中、或空窗本来就空，按 `detail` 判断。
 * 两档在 README 图例段有各自的一句话，`tests/sync-enums.test.ts` 双向核对
 * （常量改了而 README 没改 → 红）。
 */
export const TASK_GAP_REASONS = [
  'knowledge_row_malformed',    // 快照映射时缺键列的行被丢弃（响应形态漂移）
  'staff_id_list_malformed',    // staffIdList 非数组（整组）或成员 id 为空（该成员）→ 这些成员未落库
  'row_missing_key',            // 窗口任务（报表/工单）映射时行缺主键列（缺键/空串）→ 该行被丢弃、未落库
  'filter_matched_no_staff',    // 报表筛选条件未命中任何客服（本窗按 0 行记）
  'export_fixture_unreported',  // 导出流未上报窗口声明行（空窗可能真空也可能被截断）
  'export_window_mismatch',     // 导出声明的窗口宽于请求（重叠行幂等吸收）
] as const
export type TaskGapReason = typeof TASK_GAP_REASONS[number]

/**
 * `TASK_GAP_REASONS` 里「**描述的行确实没落库**」的那一档（其余是「未必缺数据」的提示）。
 *
 * 判据是任务层对行的处理：`knowledge_row_malformed` 丢弃缺键列的行、
 * `staff_id_list_malformed` 丢弃整组（非数组时）或空 id 成员、
 * `row_missing_key` 丢弃窗口任务里缺主键列的行 —— 这些行不会以任何形式进库；
 * 而 `filter_matched_no_staff`（上游本就没命中）、
 * `export_window_mismatch`（重叠行被幂等 upsert 吸收，数据在库里）都不属于这一档，
 * `export_fixture_unreported` 是「该不该有行」尚不可知，同样不在这一档。
 *
 * `tests/sync-enums.test.ts` 钉住它与 `TASK_GAP_REASONS` 的关系是**真划分**
 * （非空、真子集），并核对 README 两档文案与它一致 —— 单一出处，不得在别处重抄一份。
 */
export const TASK_GAP_LOSSY_REASONS = [
  'knowledge_row_malformed',
  'staff_id_list_malformed',
  'row_missing_key',
] as const

/** 任务层能记的一条「成功窗提示」缺口（reason 取值见 `TaskGapReason`）。 */
export interface FetchGapHint {
  reason: TaskGapReason
  detail: string
  /**
   * 会话导出尾部标记行原文（C-8）：`startTime=…,endTime=…`，**导出自己的窗口声明**，
   * 实测样本里恰好一行、紧随全部 JSON 行之后（4687 行 + 1 行；声明 24h 窗口）。
   * 引擎落 `sync_gaps` 前把它追加进 detail（`（fixture：…）`）——「为什么可疑」与
   * 「可疑的那行原文」在同一条缺口里可见。该行只有两个整数时间戳、不含 PII，
   * 长度由形态限死（≤16 位十进制 × 2 + 常量 ≈ 54 字符）。
   */
  fixture?: string
}

/** fetch 结果：rows 是未 enrich 的原始行；apiCount 是 API 侧声称的行数（配对核对基准）。 */
export interface FetchResult {
  rows: Record<string, unknown>[]
  /** API 侧行数（配对核对基准）；缺省取 enrich 过滤后的应写行数。 */
  apiCount?: number
  /**
   * 引擎可在此窗口记 gap（如 order_performance 的 orders:null 筛选失败，spec §5.2）。
   *
   * ⚠️ 单条或**数组**（2026-11-05，CodeRabbit PR #67）：同一个窗口可能存在**互不覆盖**
   * 的两类提示 —— 例如会话导出既「缺行」（row_missing_key，数据真的少了）又「没有尾部
   * 标记行」（export_fixture_unreported，窗口覆盖无从核对）。消费方按 `gaps[].reason`
   * 分支，把两类压成一条会让其中一类**成体系地消失**（此前取「丢行优先」，于是有丢行的
   * 窗口永远看不到「窗口覆盖未核对」）。引擎按条落 `sync_gaps`，一个 reason 一条。
   */
  gapHint?: FetchGapHint | FetchGapHint[]
}

/** 窗口引用：fetch 的入参（半开区间毫秒时间戳）。 */
export type WindowRef = Range & { index: number; total: number }

/** fetch 上下文：任务拿到的库句柄与凭证（红线 1：fetch 内部经 http.call + normalize）。 */
export interface FetchCtx {
  store: Store
  credentials: { appKey: string; appSecret: string }
  /** 持久化限频闸门（引擎注入）：远端限频命中时任务层写冷却；缺省退化为纯等待（中-1）。 */
  gate?: RateGate
  /** 注入时钟（毫秒）：任务层 synchronized_at 盖章的确定性来源（低-4）；缺省真实时间。 */
  clock?: () => number
}

/**
 * enrich：确定性派生/过滤（红线 1 推论：同输入行永远同输出）。
 * 返回 null 表示该行被本地决策淘汰——计入 fetched，但不写库；
 * 若淘汰导致 written < fetch 声明的 apiCount，引擎按红线 2 记 count_mismatch
 *（淘汰是本地决策，mismatch 是核查信号——口径见 engine.ts 与 task-5-report）。
 */
export type EnrichFn = (row: Record<string, unknown>) => Record<string, unknown> | null

/** 同步任务声明（spec §4.1）。 */
export interface SyncTask {
  /** 数据集 id（'reports.overview'、'tickets.search'…），sync_state/sync_gaps 的 dataset 主键。 */
  id: string
  /** 目标表（schema.ts TABLES 中的名字）。 */
  table: string
  /** 窗口型（时间切片）| 快照型（全量拉取，全删重插）。 */
  kind: 'windowed' | 'snapshot'
  watermark: { field: string; initial: string | null }
  /** 窗口切分上限天数（windowed 必填；本地预校验依据，spec §九）。 */
  maxWindowDays?: number
  /** 相邻窗口重叠天数（去重依赖 upsert/删除范围语义吸收）。 */
  overlapDays?: number
  /** 红线 1：只能在上游业务键。 */
  primaryKey: string[]
  /**
   * 限频闸门的键：该任务**主要**调用的注册表 endpoint id（与 fetch 实际路径同源）。
   * 同路径的多个任务必须声明同一值（`tickets.search` / `ticket.logs` → `ticket.search`），
   * 否则冷却各记一份、同路径交替调用照样超发（B 中-6）。缺省回退任务 id。
   */
  endpoint?: string
  /**
   * 该任务 fetch **实际会调用**的全部 endpoint id（闸门在取数前逐个 acquire）。
   *
   * ⚠️ 为什么 `endpoint` 一个不够（2026-11-02 实测修）：闸门的两端用的是**不同的键源**
   * —— `callPaced(endpointId, …)` 命中远端限频时 penalize 写的是**当下这个** endpoint，
   * 而引擎取数前 acquire 用的是 `task.endpoint`。于是「一个任务调多个 endpoint」时，
   * 被限流的那个端点写了冷却行，引擎却去查另一把键，冷却**永远不会被读到**，下一窗
   * 照旧超发。实测：`ticket.logs` 的 `ticket.log` 被限流 → 冷却行
   * `__ratelimit__:ticket.log` 落库，而 `acquire('ticket.search')` 放行，紧接着又发了
   * 4 次 `ticket.log`；`dim.ticket_template_fields` 的 `ticket.template.list` 同理。
   * 缺省（未声明）视为 `[endpoint ?? id]`，与旧行为一致。
   * ⚠️ 声明必须**覆盖 fetch 里每一个 callPaced 的 endpoint id** —— 少写一个就是上面那个
   * 缺陷的形状；`tests/sync/gate-keys.test.ts` 按真实 fetch 调用的 id 集合双向核对。
   */
  gateEndpoints?: readonly string[]
  fetch: (w: WindowRef, ctx: FetchCtx) => Promise<FetchResult>
  write: WriteStrategy
  enrich?: EnrichFn
  /**
   * 窗口末端上限（声明式，只给少数接口）：'shanghaiYesterday' = 窗口 end 不得晚于
   * 上海「昨天 00:00」。实测 `staffAttendance` / `statistic.performance` 的 `endTime`
   * 晚于今天 0:00 直接报 `14501 endTime is invalid`，且今天 0:00 这条边界不稳定
   *（同一取值时而 200 时而 14501）→ 留整日余量：当天数据不做，次日自动补上。
   * 上限同时作用于窗口末端与水位推进（end 与 deletion 同源），不会留下「水位越过了
   * 但数据没拉」的空洞。
   */
  windowEndClamp?: 'shanghaiYesterday'
  /**
   * 窗口边界对齐（声明式，只给 stat_date 为主键的聚合报表）：'shanghaiDay' =
   * 每个切出的窗都是上海自然日边界 `[某日 0:00, 另一日 0:00)`（首窗 start 允许被钳到
   * range.start、末窗 end 允许被钳到 range.end）。
   * 为什么必须有：窗口起点来自水位续跑（`watermark+1ms`）或任意时刻的 `--since` 时，
   * 窗形如 `[今天18:23, 明天18:23)` —— 只写一行 `stat_date=dayOf(start)`，拉到的却是
   * 跨两天的聚合值；而 `deleteRangeInsert` 的删除范围是 `[dayOf(start), dayOf(end−1ms)]`
   * = 两天，会把「明天」日的行删掉而不重写（该日数据是上次 run 的切片聚合）。
   * 「每日概览」因此只在对齐 run 下才是精确全天值。声明本字段 = **该表的按日行集
   * 必须与按日窗口闭环**（对齐与 overlapDays 无关：报表任务 overlapDays=0；若将来有
   * overlapDays > 0 的任务声明此项，重叠窗同样落在对齐网格上——对齐只决定边界，
   * 不改变重叠语义，跳过包含窗的判据仍按真实重叠毫秒数算）。
   */
  windowAlign?: 'shanghaiDay'
  /**
   * 窗口起点的下界（声明式，只给少数接口）：`now − N 天`。
   * 实测 `ticket.search` 的 `opStart` 被服务端**静默钳到「当前时刻前约 31 天」**——
   * 而引擎在「--full / 仅 --until / 首跑水位为空」时合成的起点是 0（哨兵，不是真实日期），
   * 发出去只会拿到一段被服务端静默改写过的窗口（客户端以为「从最早开始」，实际是
   * 「服务端说了算」）。声明本字段后，引擎把**哨兵起点（≤0）**抬到下界，抬升结果
   * 如实回显在 resolved_range 里；显式**正数**起点（--since/--until 时刻）原样照发。
   */
  windowStartFloorDays?: number
  /** 报表按天轮转标记（spec §5.2，Task 7 消费；T5 落类型位）。 */
  reportDayRotation?: boolean
}

/** 引擎产出的缺口信息（run 结果里返回，同步落 sync_gaps）。 */
export interface GapInfo {
  rangeStart: string
  rangeEnd: string
  reason: string
  detail: string
}

/** 引擎运行上下文（runTask 的入参）。 */
export interface RunCtx {
  store: Store
  credentials: Credentials
  /**
   * 持久化限频闸门。**键是 endpoint id**（不是 task id —— B 中-6 的修复口径）：
   * 闸门按路径拦调用、`RATE_LIMITS` 按路径登记，而任务与接口是多对一
   *（`tickets.search` / `ticket.logs` 同走 `ticket.search` 路径）。引擎取任务的
   * `endpoint` 声明，缺省回退任务 id（未声明 endpoint 的测试假任务仍可用）。
   */
  gate: RateGate
  /** 注入时钟（毫秒），D 层确定性测试的钉子。 */
  clock: () => number
  /**
   * 引擎侧时钟（毫秒）。`clock` 是**任务层**的盖章时钟（synchronized_at / gap 记录），
   * 在命令层注入固定值让输出可断言；本字段是**引擎自己**的「现在」——窗口上界、
   * 昨日零点钳制、锁盖章都读它。缺省 = clock（未注入时两者同源，行为不变）。
   */
  now?: () => number
  /** 进度回调（人读 stderr 的落点，Task 13 接线）。 */
  onProgress?: (line: string) => void
  /** 显式范围覆盖（--full/--since/--until 的合成落点，Task 13 接线）；缺省从水位续跑到 clock 当前。 */
  rangeOverride?: Range
  /** 限频等待注入点（中-2①）：gate 冷却等待的 sleep 实现；缺省真实 setTimeout，测试注入假时钟推进。 */
  sleep?: (ms: number) => Promise<void>
}
