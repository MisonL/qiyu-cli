// src/commands/local-fallback.ts
//
// 「改用本地查询」的注入槽（G1 契约小件）。设计稿 §9.1 的限流错误示例里声明了
// `retry_strategy` / `fallback` 两个字段，而它们的值依赖**同步任务注册表**与
// **本地库文件** —— 两者都在 `sync/` 与 `store/` 里。
//
// ⚠️ 本文件必须保持**零依赖**（不 import sync/、store/、node:fs），这是分层红线：
// `commands/api.ts` 与 `commands/auth.ts` 不得加载 store/（layering.test.ts 用
// 源文本钉着）。所以 api.ts 只 import 这个槽；真正的映射与库文件探测在
// `local-fallback-wiring.ts`，由 `cli.ts`（入口层，允许同时 import 两边）在
// 进程启动时注入。
//
// ⚠️ 不用「cli.ts 启动期算好一份快照」而是**惰性回调**：`run()` 在测试里会被
// 同一进程反复调用，库文件可能在两次调用之间被创建；回调让每次判定都读到当下状态。
// 探测本身只发生在**限流错误真的出现时**（一次），不是每条命令都付代价。

/** 某接口的本地替代：映射到的表（第一张是首选，其余是同接口的其它表）。 */
export interface LocalFallback {
  tables: string[]
}

export type LocalFallbackProvider = (endpointId: string) => LocalFallback | undefined

let provider: LocalFallbackProvider | undefined

/** 设置（或清除，传 undefined）fallback 提供者。cli.ts 注入；测试可直接注入。 */
export function setLocalFallbackProvider(fn: LocalFallbackProvider | undefined): void {
  provider = fn
}

/**
 * 查该接口是否有可用的本地替代。任何异常（提供者内部探测失败、配置畸形等）
 * 一律吞掉返回 `undefined` —— 它只用于给限流错误**附加**一条建议，
 * **绝不能因为探测失败改变原始错误本身**（那会把限流报成 internal）。
 */
export function localFallbackFor(endpointId: string): LocalFallback | undefined {
  try {
    const fb = provider?.(endpointId)
    return fb && fb.tables.length > 0 ? fb : undefined
  } catch {
    return undefined
  }
}
