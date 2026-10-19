// src/store/retry.ts
// ⚠️ 曲线是**固定间隔**（实测 2.6s/13 次成功 ≈ 200ms 间隔，spec §5.2）——
// 不是指数：指数曲线在剩余预算不足时会大幅越过 maxMs。

/** 锁冲突的识别规则（spec §5.2 定死）：message 含 `Conflicting lock`。 */
export function isLockError(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e)
  return msg.includes('Conflicting lock')
}

/** 识别 ERR_MODULE_NOT_FOUND 并取出缺失的 specifier（spec §5.1 的二分规则）。 */
export function isModuleNotFound(e: unknown): { missing: string } | null {
  const err = e as { code?: string; message?: string }
  if (err?.code !== 'ERR_MODULE_NOT_FOUND') return null
  const m = /Cannot find (?:package|module) '([^']+)'/.exec(err.message ?? '')
  return { missing: m?.[1] ?? '' }
}

export interface RetryOpts<T> {
  tryOpen: () => Promise<T>
  isRetryable: (e: unknown) => boolean
  maxMs: number
  intervalMs?: number
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 有界重试：可重试错误按固定间隔重试至 maxMs，超限抛最后一个错误。 */
export async function retryWithBackoff<T>(opts: RetryOpts<T>): Promise<T> {
  const intervalMs = opts.intervalMs ?? 200
  const sleep = opts.sleep ?? defaultSleep
  const now = opts.now ?? (() => Date.now())
  const start = now()
  for (;;) {
    try {
      return await opts.tryOpen()
    } catch (e) {
      if (!opts.isRetryable(e)) throw e
      if (now() - start + intervalMs > opts.maxMs) throw e
      await sleep(intervalMs)
    }
  }
}
