// src/sync/tasks/knowledge.ts
// D-T11：知识库 3 快照任务（spec §5.4，设计稿 §10.5 实测事实）：
//   ① robot.data.knowledge / robot.data.kpoint 是**游标分页**：mid = 上一页末行 id
//      （严格大于）、size ≤ 1000、isEnd=1 终止；信封形状 C——message 是 JSON 字符串，
//      归一化在 core/envelope 层完成（payload 即解析物），任务代码不二次猜测；
//   ② **robot.data.knowledge 的 robotId 被服务端静默忽略**（实测 A/B：传与不传 total
//      相同）——静默丢弃比报错更危险（看起来像过滤生效），含 robotId 的参数在构造
//      body 前客户端 usage 拒绝、绝不透传（契约诚实性）；
//   ③ knowledge_items 是全部机器人的**并集**；knowledge_categories **按 robotId 隔离**
//     （实测 5 个 robotId 得到 5 棵不同的树）——两接口语义不同，谁也不能从对方推断。
//      categories 的驱动序只能来自 knowledge_items 落库后的 DISTINCT robot_id
//     （robot.data.knowledge 响应含 robotId，是全量遍历下唯一的 API 侧发现途径）；
//   ④ getCategoryTree 空树机器人返回 {code:200,message:'success'} 且**无 data 键**
//      （形状 A not_found）——是「知识库无类目」的合法状态，0 行、不报错；
//   ⑤ 计数红线：**测试断言不变量，不硬编码实测行数**（12778 等计数会漂移）。
// 全部 kind=snapshot：幂等来自引擎快照路径的全删重插（engine.ts runSnapshot）。
import { call } from '../../core/http.js'
import { byId } from '../../core/registry/index.js'
import type { SyncTask, FetchResult, FetchCtx, WindowRef } from '../types.js'

/** 单页上限（文档与实测一致：size 一次最多 1000）。 */
const PAGE_SIZE = 1000

let sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
/** 仅测试用：替换等待实现（翻页/逐机器人撞 180 秒本地冷却时按 retryAfter 等待，不可测）。 */
export function __setSleep(fn: (ms: number) => Promise<void>): void { sleep = fn }

/** usage 错误（退出码 2）：本地参数问题，重试无用（形态与 tickets.ts 一致）。 */
function usageError(msg: string, hint: string): Error {
  const e = new Error(msg)
  ;(e as { kind?: string }).kind = 'usage'
  ;(e as { hint?: string }).hint = hint
  return e
}

/**
 * robotId 透传守卫：robot.data.knowledge / robot.data.kpoint 的 robotId 被服务端
 * **静默忽略**——任务 fetch 收到含 robotId 的参数必须 usage 拒绝（绝不发请求）。
 * ⚠️ 只有这两个 items/points 接口如此；getCategoryTree 的 robotId 是生效参数
 *（按机器人隔离），由 categories 任务正常使用。
 */
function assertNoRobotId(w: WindowRef, taskId: string): void {
  if (w !== null && typeof w === 'object' && 'robotId' in (w as Record<string, unknown>)) {
    throw usageError(
      `${taskId} 不接受 robotId：robot.data 系列接口会静默忽略它（返回企业全量而非该机器人的数据），` +
        '传了只会误导调用方。按机器人过滤请用 knowledge.categories（getCategoryTree 按 robotId 隔离）。',
      '这是同步任务的本地参数问题（robotId 被服务端静默忽略），删除该参数后重跑')
  }
}

/**
 * 带冷却重试的调用：任务内多次调用（翻页/逐机器人）会撞进程内令牌桶
 *（robot.data.knowledge 冷却实测长达 180 秒）——真实同步里按 retryAfter 等待后重试
 *（宁可慢，不超发）；测试经 __setSleep 注入零等待。有界重试，防冷却行坏数据死循环。
 */
async function callPaced(endpointId: string, body: unknown, ctx: FetchCtx,
  attempt = 0): Promise<{ payload: unknown }> {
  try {
    return await call(byId(endpointId), body, { credentials: ctx.credentials })
  } catch (e) {
    const rl = e as { code?: string; retryAfter?: { seconds?: number } }
    if (rl.code === 'local_rate_limit' && attempt < 3) {
      await sleep(((rl.retryAfter?.seconds ?? 30) + 1) * 1000)
      return callPaced(endpointId, body, ctx, attempt + 1)
    }
    throw e
  }
}

/**
 * 游标分页拉取形状 C 载荷（{total, data[], isEnd}），带 total 核对：
 *   · mid 从 0 起，每页后 = 本页末行 id（服务端语义：下一批 **严格大于** mid）；
 *   · isEnd=1 终止；size 恒 1000；
 *   · 空页但 isEnd=0 → 终止循环并显式失败（mid 已无可推进依据，继续翻只会死循环）；
 *   · **翻页上限保护**：maxPages = ceil(total/size) + 5 余量（total 未知时保守 1000 页）
 *     ——非空页但 isEnd 恒 0、或末行 id 缺失致 mid=NaN 原地打转的响应形态漂移，
 *     都在有限次调用后显式失败，绝不挂起；
 *   · 各页声明 total 必须一致、结束时累计行数必须等于 total——「看似成功的短读」
 *     是最危险的静默失败方向（配对核对的前置事实检查）。
 */
async function pagedCursor(endpointId: string, ctx: FetchCtx): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let mid = 0
  let declared: number | null = null
  let page = 0
  for (;;) {
    // 上限在发请求前判定：声明 total 已知 → ceil(total/size)+5；未知 → 保守 1000 页
    const maxPages = declared !== null
      ? Math.ceil(declared / PAGE_SIZE) + 5
      : 1000
    if (page >= maxPages) {
      throw new Error(`接口 ${endpointId} 翻页超限（${page} 页 > 上限 ${maxPages}，声明 total=` +
        `${String(declared)}，已取 ${out.length} 行）：isEnd 恒 0 或游标未推进（响应形态漂移），拒绝落库`)
    }
    page++
    const res = await callPaced(endpointId, { mid, size: PAGE_SIZE }, ctx)
    const p = res.payload as { total?: unknown; data?: unknown; isEnd?: unknown } | null
    if (p === null || typeof p !== 'object' || !Array.isArray(p.data)) {
      throw new Error(`接口 ${endpointId} 载荷缺 data 数组（响应形态漂移？），拒绝落库`)
    }
    const rows = p.data as Record<string, unknown>[]
    out.push(...rows)
    if (typeof p.total === 'number') {
      if (declared === null) declared = p.total
      else if (p.total !== declared) {
        throw new Error(`接口 ${endpointId} 各页声明 total 漂移（${declared} → ${p.total}）：` +
          '遍历期间上游数据变更，拒绝落库（重跑即可）')
      }
    }
    if (rows.length > 0) mid = Number(rows[rows.length - 1]!.id)
    const isEnd = p.isEnd === 1
    // 空页却未到末页：mid 已无可推进依据，继续翻页只会死循环——显式失败（形态漂移）
    if (rows.length === 0 && !isEnd) {
      throw new Error(`接口 ${endpointId} 返回空页但 isEnd=0（声明 total=${String(p.total)}，` +
        `已取 ${out.length} 行）：响应形态漂移，拒绝落库`)
    }
    if (isEnd) {
      if (declared !== null && out.length !== declared) {
        throw new Error(`接口 ${endpointId} 遍历结束行数不符：声明 total=${declared}，实取 ${out.length} 行` +
            '（响应形态漂移/遍历期间上游变更），拒绝落库——重跑即可')
      }
      break
    }
  }
  return out
}

/**
 * 脏行守卫 + 键列提取（按映射表投影）。缺键（undefined）的行丢弃——脏单行不致断流
 * 的统一取舍；**键存在但值为 null 是合法数据**（pointId 仅 37.6% 行有值、robot_name
 * 可空——设计稿 §10.5 实测），落库为 null，绝不因此丢行。
 * ⚠️ INTEGER 列（numericCols 中的）**数字直通**、不做 JSON.stringify——否则 number 1
 * 会被字符串化成 "1" 落 INTEGER 列（依赖 DuckDB 隐式转型是脆弱行为）；VARCHAR 列的
 * 非字符串值（ID 是 BIGINT）才字符串化（BIGINT 精度红线）。
 */
function projectRows(rows: Record<string, unknown>[],
  keys: Record<string, (r: Record<string, unknown>) => unknown>,
  numericCols: ReadonlySet<string>, nowIso: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = []
  for (const r of rows) {
    const mapped: Record<string, unknown> = {}
    let ok = true
    for (const [col, get] of Object.entries(keys)) {
      const v = get(r)   // 只取一次（键缺失判别与取值同一来源）
      if (v === undefined) { ok = false; break }   // 键缺失 → 脏行；null 是合法值
      mapped[col] = v === null ? null
        : numericCols.has(col) ? Number(v)
        : typeof v === 'string' ? v : JSON.stringify(v)
    }
    if (!ok) continue   // 键缺失行：丢弃且不计入 fetched（与 apiCount 口径一致）
    // 其余字段整体收敛进 payload（22 键对 16 键文档漂移——payload 保真全部业务字段）
    out.push({ ...mapped, payload: JSON.stringify(r), synchronized_at: nowIso })
  }
  return out
}

/** 类目树拍平（children 在叶子上为 null，实测形态——空数组/null 都没有子节点）。 */
function flattenTree(robotId: string, nodes: unknown, level: number,
  parentId: string | null, out: Record<string, unknown>[], nowIso: string): void {
  if (!Array.isArray(nodes)) return
  for (const n of nodes as Record<string, unknown>[]) {
    const cid = n.id
    if (cid === null || cid === undefined) continue   // 缺 id 的脏节点：丢弃
    const sId = String(cid)
    out.push({ robot_id: robotId, category_id: sId, name: typeof n.name === 'string' ? n.name : null,
      parent_id: parentId, level, payload: JSON.stringify(n), synchronized_at: nowIso })
    flattenTree(robotId, n.children, level + 1, sId, out, nowIso)
  }
}

/** knowledge_items / knowledge_points 共用的游标快照 fetch。numericCols 是 INTEGER 列集（数字直通）。 */
function fetchCursor(taskId: string, endpointId: string,
  keys: Record<string, (r: Record<string, unknown>) => unknown>,
  numericCols: string[] = []): SyncTask['fetch'] {
  const numeric = new Set(numericCols)
  return async (w, ctx) => {
    assertNoRobotId(w, taskId)
    const nowIso = new Date().toISOString()
    const rows = await pagedCursor(endpointId, ctx)
    const mapped = projectRows(rows, keys, numeric, nowIso)
    return { rows: mapped, apiCount: mapped.length }
  }
}

export const KNOWLEDGE_TASKS: SyncTask[] = [
  {
    id: 'knowledge.items', table: 'knowledge_items', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['id'],
    write: { kind: 'upsertRows' },
    // 企业级全量（全部机器人并集）；robotId 被静默忽略 → fetch 守卫拒绝透传。
    // 键列：id/robot_id/robot_name/group_id/ref_id/point_id（groupId 是知识实体真正的
    // 主键概念但全局键仍是上游 id，红线 1）；type 是响应里的数字（0/1 枚举语义见设计稿）。
    fetch: fetchCursor('knowledge.items', 'robot.data.knowledge', {
      id: (r) => r.id,
      robot_id: (r) => r.robotId,
      robot_name: (r) => r.robotName,
      type: (r) => r.type,
      group_id: (r) => r.groupId,
      ref_id: (r) => r.refId,
      point_id: (r) => r.pointId,
    }, ['type']),
  },
  {
    id: 'knowledge.points', table: 'knowledge_points', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    primaryKey: ['id'],
    write: { kind: 'upsertRows' },
    // kpoint 实测全字段存在且无 robotId 键（归属只能经 items.point_id 反推）——
    // 单键列 id 即可（全字段都在 payload 里保真）。
    fetch: fetchCursor('knowledge.points', 'robot.data.kpoint', {
      id: (r) => r.id,
    }),
  },
  {
    id: 'knowledge.categories', table: 'knowledge_categories', kind: 'snapshot',
    watermark: { field: 'synchronized_at', initial: null },
    // 主键必须含 robot_id（类目 id 空间按机器人划分，§10.5.9——单列主键会跨机器人覆盖）
    primaryKey: ['robot_id', 'category_id'],
    write: { kind: 'upsertRows' },
    // 驱动序来自 knowledge_items 落库后的 DISTINCT robot_id——items 表为空是任务序
    // 错误（先跑 knowledge.items），显式失败而非静默空跑。getCategoryTree 的 robotId
    // 是**生效**参数（按机器人隔离，与 items 语义不同），逐机器人调用；空树机器人
    //（not_found，无 data 键）是合法状态 → 该机器人 0 行、不报错。
    fetch: async (w, ctx) => {
      assertNoRobotId(w, 'knowledge.categories')
      void w
      const nowIso = new Date().toISOString()
      const r = await ctx.store.query('SELECT DISTINCT robot_id FROM knowledge_items ORDER BY robot_id')
      const robotIds = r.rows.map((x) => String(x.robot_id))
      if (robotIds.length === 0) {
        throw new Error('knowledge_items 表为空：knowledge.categories 按 robotId 隔离驱动，' +
          '请先同步 knowledge.items 任务')
      }
      const out: Record<string, unknown>[] = []
      for (const rid of robotIds) {
        const res = await callPaced('ai.knowledge.getCategoryTree', { robotId: Number(rid) }, ctx)
        // 形状 A：data 直接是树数组；空树机器人整个丢 data 键（not_found）→ 0 行合法
        if (res.payload === undefined || res.payload === null) continue
        flattenTree(rid, res.payload, 1, null, out, nowIso)
      }
      return { rows: out, apiCount: out.length }
    },
  },
]

/** 按 id 取知识库任务（T12 汇总与测试的取用形态）。 */
export function taskById(id: string): SyncTask | undefined {
  return KNOWLEDGE_TASKS.find((t) => t.id === id)
}
