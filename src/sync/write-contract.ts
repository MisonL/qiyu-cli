// src/sync/write-contract.ts —— 写策略声明的静态契约（2026-11-03，CodeRabbit #59 之后）。
//
// `writeRows` 只有两种删除基准（见 types.ts `WriteStrategy`），各自的精确性都有一个
// **声明前提**。类型系统表达不了这两个前提（都在任务声明的组合里），所以在这里集中
// 校验、由 `registry.ts` 在加载期 fail-fast、由 `tests/sync/delete-boundary-contract.test.ts`
// 对真实注册表与合成反例双向自检。
//
// 前提一（按日粒度范围列删）：窗起止必须都落上海日界。窗口由引擎切、任务只声明
// `windowAlign: 'shanghaiDay'` —— 漏声明的表会把相邻窗写好的边界日整片删掉
//（真实事故：staff_attendance 曾声明 rangeAlign 却按 31 天任意起点切窗，边界日只剩 16/24 小时，
// 且整轮 status=complete、零 gap）。
// 前提二（按逐行瞬时列删）：被删的值与 `new Date(ms).toISOString()` 同形，否则比较口径
// 与写入不同源（列不存在 → 删除直接报错；形态不同 → 静默删不到/删错）。
import type { SyncTask } from './types.js'
import { TABLES } from '../store/schema.js'

/** 返回该任务写策略声明违反的契约（空数组 = 通过）。 */
export function writeContractViolations(task: SyncTask): string[] {
  const write = task.write
  if (write.kind !== 'deleteRangeInsert') return []
  const out: string[] = []
  if ('instantColumn' in write) {
    const table = TABLES.find((t) => t.name === task.table)
    if (table === undefined) {
      out.push(`${task.id}：instantColumn 指向的表 '${task.table}' 不在 TABLES 里`)
      return out
    }
    if (!table.columns.some((c) => c.name === write.instantColumn)) {
      out.push(`${task.id}：instantColumn '${write.instantColumn}' 不是表 '${task.table}' 的列`)
    } else if (table.timeColumn?.name !== write.instantColumn
      || table.timeColumn.kind !== 'iso-instant') {
      out.push(`${task.id}：instantColumn '${write.instantColumn}' 必须是表 '${task.table}' 声明的`
        + ` timeColumn 且 kind='iso-instant'（删除值与 new Date(ms).toISOString() 同形的前提）`)
    }
  } else {
    // 两条独立判据（CodeRabbit #59 三轮）：漏声明 rangeAlign 不会落进「对齐」分支，
    // 引擎于是拿 `toISOString()` 的瞬时串（…T00:00:00.000Z）去比日粒度列值（YYYY-MM-DD）——
    // 字符串前缀关系让窗起点**那一整日**的行永远删不掉（陈旧行），窗口仍报 complete。
    if (write.rangeAlign !== 'shanghaiDay') {
      out.push(`${task.id}：按日粒度范围列（${write.rangeColumns.join(', ')}）删旧必须声明`
        + ` rangeAlign='shanghaiDay' —— 否则引擎用 ISO 瞬时串与日粒度列值比较，`
        + `窗起点那一日的行永远删不掉（静默留陈旧行、窗口仍 complete）；`
        + `行内若有逐行时间列，改用 instantColumn`)
    }
    if (task.windowAlign !== 'shanghaiDay') {
      out.push(`${task.id}：按日粒度范围列删旧只在窗起止都落上海日界时精确，`
        + `但任务未声明 windowAlign='shanghaiDay' —— 边界日会被相邻窗整片删掉；`
        + `让窗对齐到日界，或改用 instantColumn（行内有逐行时间列时）`)
    }
  }
  return out
}

/** 注册表加载期守卫：任一任务违反契约即抛错（fail-fast，绝不带着错误声明起跑）。 */
export function assertWriteContracts(tasks: readonly SyncTask[]): void {
  const violations = tasks.flatMap((t) => writeContractViolations(t))
  if (violations.length > 0) {
    throw new Error(`同步任务写策略声明违反契约：\n- ${violations.join('\n- ')}`)
  }
}

/**
 * 闸门键声明的前提（加载期校验，2026-11-15，Sourcery PR#58 复核）：
 * `gateEndpoints` 一旦声明就必须**非空**且包含主端点。空数组/漏写会静默回退成
 * `[endpoint ?? id]`，多端点任务的次要端点冷却就永远读不到（实测形态见
 * `tests/sync/gate-keys.test.ts` 文件头）。
 * 不声明 `gateEndpoints` 仍是合法的「单端点任务」形态（21 个里 18 个如此）；
 * 要挡住的是「声明了但声明不完整」——那是唯一一种「看起来配了、实际没配上」的写法。
 */
export function gateContractViolations(tasks: readonly SyncTask[]): string[] {
  const out: string[] = []
  for (const t of tasks) {
    if (t.gateEndpoints === undefined) continue   // 单端点任务：合法，回退到 [endpoint ?? id]
    if (!Array.isArray(t.gateEndpoints) || t.gateEndpoints.length === 0) {
      out.push(`${t.id}：gateEndpoints 声明为空 —— 会静默回退成单键，多端点任务的次要冷却读不到；`
        + '不需要闸门多键时请删掉该字段')
      continue
    }
    const primary = t.endpoint ?? t.id
    if (!t.gateEndpoints.includes(primary)) {
      out.push(`${t.id}：gateEndpoints 未包含主端点 ${primary}（声明：${t.gateEndpoints.join('、')}）——`
        + '主端点的冷却会被漏读')
    }
  }
  return out
}

export function assertGateContracts(tasks: readonly SyncTask[]): void {
  const violations = gateContractViolations(tasks)
  if (violations.length > 0) {
    throw new Error(`同步任务闸门键声明违反契约：\n- ${violations.join('\n- ')}`)
  }
}
