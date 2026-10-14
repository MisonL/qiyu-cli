// src/store/index.ts
import { createDuckDbStore } from './duckdb.js'
import type { BackendName, Store, StoreConfig, StoreMode } from './types.js'

/**
 * 后端注册表（spec §4.2.4）—— 惰性映射，使 openStore 不必静态 import duckdb.js，
 * 这是 optionalDependency 惰性加载的落点。C2 在此加 'postgres'|'mysql'|'sqlite'。
 */
export const BACKENDS: Record<BackendName, (cfg: StoreConfig, mode: StoreMode) => Promise<Store>> = {
  duckdb: (cfg, mode) => createDuckDbStore(cfg, mode),
}

export async function openStore(cfg: StoreConfig, mode: StoreMode): Promise<Store> {
  const make = BACKENDS[cfg.backend]
  if (!make) {
    const e = new Error(`未知后端：${cfg.backend}。目前仅支持 duckdb`)
    ;(e as { kind?: string }).kind = 'usage'
    throw e
  }
  return make(cfg, mode)
}
