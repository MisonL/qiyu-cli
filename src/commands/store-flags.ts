// src/commands/store-flags.ts —— `--db / --profile / --backend` 的值位解析。
//
// 此前 db.ts / store.ts / stats.ts 各有一份逐字相同的 `parseFlags`，三处还各有
// 「改动必须同步另两处」的互指注释（架构审查 M-2）。新增共享定位 flag 时漏改任何
// 一份，那条命令会静默把它当位置参数（不报错、把下一个 token 吃成路径）——这类
// 漂移没有任何测试能替人拦住，所以收成唯一一份。
//
// ⚠️ query.ts 里也有一个 parseFlags，**不合并**：它是第四份但语义有意不同
// （`FLAG_TOKENS` 值位守卫，接受的 flag 集也不同）。
//
// 接受的 flag 名从 `STORE_FLAGS` 派生而不是在这里再手写一遍：`CommandSpec` 的
// 完整接受集也消费 `STORE_FLAGS`，两边共用同一份才不会出现「spec 说接受、解析器
// 不认」。
import { STORE_FLAGS } from './spec-types.js'

export interface StoreFlags { db?: string; profile?: string; backend?: string }

/** 值位 flag 名（`--db` 等，带 `--`），顺序沿 `STORE_FLAGS`。 */
export const STORE_VALUE_FLAG_NAMES: readonly string[] = STORE_FLAGS.map((f) => f.name)

// ⚠️ 模块级断言（Task 2 复审 M1，Task 3 顺带落地）：`parseStoreFlags` 用 `a.slice(2)`
// 推键名，前提是每个名字都以 `--` 开头。若将来给 `STORE_FLAGS` 加一个短 flag（如 `-x`），
// `slice(2)` 会把键写成空串并静默落进结果对象（复审实测：`{ rest: [], '': 'v' }`），
// 既不报错也不被消费。这里 fail fast —— 这是编程错误，不该等到 Agent 拿到空串键才发现。
if (!STORE_VALUE_FLAG_NAMES.every((n) => n.startsWith('--'))) {
  throw new Error(`STORE_FLAGS 含非 -- 前缀的名字：${STORE_VALUE_FLAG_NAMES.join('、')}`)
}

/**
 * 把 `--db/--profile/--backend` 及其值位从 argv 里剥出来，其余 token 原序进 `rest`
 * （由调用方判「未知参数」还是「位置参数」）。
 *
 * 值位守卫（沿 store.ts 的 v1 计划缺陷与 B 的 isBodyValue 惯例）：值位缺失或以 `--`
 * 开头 → 报缺值。否则 `store init --db --profile x` 会把 `--profile` 当成路径。
 * ⚠️ 错误文案 `${flag} 缺少取值` 逐字保持——多个既有测试钉着它。
 *
 * `--pretty` 是已知布尔开关（G1 实现后收下，不再进 `rest`）：它不带值，进了 `rest`
 * 会被调用方当未知参数误拒。值位守卫仍先于它 —— `store init --db --pretty` 报
 * 「--db 缺少取值」，与 `--profile` 同款（下一个 token 以 `--` 开头即缺值）。
 */
export function parseStoreFlags(argv: string[]): StoreFlags & { rest: string[] } {
  const out: StoreFlags & { rest: string[] } = { rest: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (STORE_VALUE_FLAG_NAMES.includes(a)) {
      const v = argv[i + 1]
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} 缺少取值`)
      // a 已由上面的 includes 收窄为三件套之一，slice(2) 得到 db/profile/backend。
      out[a.slice(2) as keyof StoreFlags] = v
      i++
    } else if (a === '--pretty') {
      // G1：已实现的输出开关 —— 解析层收下；开启动作在命令层（原拒绝点 setPretty(true)）。
      continue
    } else out.rest.push(a)
  }
  return out
}
