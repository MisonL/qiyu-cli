// src/query/metric-catalog.ts —— 指标声明目录（spec §9.2）。
//
// 职责只有一个：把「有出处的指标声明」集中在一处，供 `stats fields` 输出。
// 三条硬规则：
//   1. 每条声明**必须带 source**：
//        · 'design-doc' = 设计稿实测明说（如 assignedRatio=0.987 且 -1=无数据）
//        · 'name-suffix' = 按字段名后缀推断（*Ratio/*Radio→ratio、*Count/sessions→count、
//          *Duration/*Time→ms）—— 标明这是命名推断，不是实测；
//   2. `higher_is_better` **没有任何上游来源**（设计稿从未给出）→ 一律 null，不猜；
//   3. 宁缺毋滥：只收录有出处的条目，其余靠运行时后缀派生。
//
// ⚠️ 后缀派生是**启发式**：判不出单位时如实返回 'unknown'，命令层据此填 unknown_fields
// ——绝不为了「输出好看」给一个编造的单位。
//
// 分层约束（spec §5.1）：本文件是纯数据 + 纯函数，不 import 任何模块。

/**
 * 指标单位（闭集；'unknown' = 目录与后缀都判不出）。
 *
 * ⚠️ 运行时数组 + `typeof ARR[number]` 而不是裸联合类型：这是**输出数据里的机器值**
 * （`stats fields` 的 `declared.<字段>.unit`），Agent 要按它分支（比率要不要乘 100、
 * 毫秒要不要换算）。值域必须能在运行时导出，`meta.field_notes` 的图例与测试才能
 * 双向核对「枚举 ⊆ 图例、图例 ⊆ 枚举」—— 裸联合类型编译后就没了，谁加了值都不会红。
 */
export const METRIC_UNITS = ['ratio', 'count', 'ms', 'unknown'] as const
export type MetricUnit = typeof METRIC_UNITS[number]

/** 声明出处：设计稿实测 / 命名后缀推断（同上：运行时可导出）。 */
export const METRIC_SOURCES = ['design-doc', 'name-suffix'] as const
export type MetricSource = typeof METRIC_SOURCES[number]

export interface MetricDecl {
  unit: MetricUnit
  /** 越大越好？没有上游来源 → null（不猜）。 */
  higher_is_better: boolean | null
  source: MetricSource
  /** 一句话依据（仅 design-doc 级声明通常需要）。 */
  note?: string
}

/**
 * 报表域表（spec §9.1）：字段自描述只对「业务字段收敛进 payload」的报表域有意义。
 * 会话/工单的 payload 是 PII 副本，统计它没有价值且扩大暴露面 —— 故是**闭集**，
 * 其它表一律 usage + 可用表清单。
 */
export const REPORT_TABLES: readonly string[] = [
  'daily_overview',
  'staff_workload',
  'staff_quality',
  'staff_satisfaction',
  'staff_attendance',
  'order_performance',
  'staff_salary_detail',
  'robot_summary',
  'transfer_human',
]

/**
 * 目录（按表名分组）。初始内容**宁缺毋滥**——只有设计稿实测明说的才进 'design-doc'。
 *
 * `assignedRatio`：设计稿 §6.2（表设计前的实测约束一节）用 31 天窗口 A/B 实测
 * assignedRatio=0.987、sessions=48695；什么都匹配不到的筛选条件给出 -1。注意
 * -1 是「无数据」哨兵，不是数值（spec §9.2 的 sentinel 条目同源）。
 */
export const METRIC_CATALOG: Record<string, Record<string, MetricDecl>> = {
  daily_overview: {
    assignedRatio: {
      unit: 'ratio',
      higher_is_better: null,
      source: 'design-doc',
      note: '设计稿 §6.2 实测 0.987；-1 = 无数据',
    },
    sessions: { unit: 'count', higher_is_better: null, source: 'name-suffix' },
  },
}

/** 后缀 → 单位（spec §9.2；顺序即优先级，见 deriveMetric 的注释）。 */
const SUFFIX_RULES: ReadonlyArray<readonly [string, MetricUnit]> = [
  ['Ratio', 'ratio'],
  ['Radio', 'ratio'],
  ['Count', 'count'],
  ['Duration', 'ms'],
  ['Time', 'ms'],
]

/**
 * 按字段名后缀派生声明（source 恒为 'name-suffix'，higher_is_better 恒 null）。
 *
 * ⚠️ `sessions` 是**精确名**不是后缀（`sessionsCount` 走 *Count 规则，结果相同）。
 * 规则按 SUFFIX_RULES 顺序匹配；互斥的后缀之间顺序无影响，写成数组是为了
 * 让「新增一条规则」是加一行而不是改判断树。
 */
export function deriveMetric(field: string): MetricDecl {
  if (field === 'sessions') return { unit: 'count', higher_is_better: null, source: 'name-suffix' }
  for (const [suffix, unit] of SUFFIX_RULES) {
    if (field.endsWith(suffix)) return { unit, higher_is_better: null, source: 'name-suffix' }
  }
  return { unit: 'unknown', higher_is_better: null, source: 'name-suffix' }
}

/**
 * 单字段声明：目录优先，目录没有则后缀派生。
 *
 * ⚠️ 用 `Object.hasOwn` 而非直接下标：字段名来自本地库 payload 的键（不受信数据），
 * 名为 `__proto__` / `constructor` 的键在普通对象下标里会命中原型，返回的不是声明。
 */
export function declareMetric(table: string, field: string): MetricDecl {
  const group = Object.hasOwn(METRIC_CATALOG, table) ? METRIC_CATALOG[table] : undefined
  if (group !== undefined && Object.hasOwn(group, field)) return group[field]
  return deriveMetric(field)
}
