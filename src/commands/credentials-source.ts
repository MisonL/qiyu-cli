// src/commands/credentials-source.ts
//
// 凭证来源合流（G1 第三批）：环境变量 > 配置文件（`auth login` 写入的那份）。
// api / sync / sync-run 三处调用点共用 —— 此前各自手写
// `resolveCredentials({}, { appKey: process.env.QIYU_APP_KEY, … })`，G1 起配置文件
// 成为第二来源，三处若各写一遍「缺哪项才读文件」，任何一处漏改就会出现
// 「api 认配置、sync 只认环境变量」的分叉，而 Agent 无法从报错里看出这种差异。
//
// ⚠️ **缺哪一项才读配置文件**（不是无条件读）：两个都齐时读文件只会多一个
// 失败通道（权限拒绝/畸形 JSON 会挡下一次本来完全正常的调用），而它提供的
// 值一个也用不上。「env 完整时不读文件」是钉死在测试里的契约。
// ⚠️ 权限拒绝（`config_insecure`）**必须**原样透出 —— 那是一个安全问题，
// 不能因为 env 恰好齐备就替用户瞒下它。读文件的前提（env 缺项）意味着
// 这条只会在「真的要用的文件」上触发。

import { resolveCredentials } from '../core/credentials.js'
import type { Credentials } from '../core/credentials.js'
import { fileCredentials, nonEmptyValue } from '../core/config.js'

export interface CredEnv { appKey?: string; appSecret?: string }

/**
 * 当前进程的凭证环境变量（架构审查 M-3 的同款收口：调用方应传
 * `currentCredentialEnv()`，需要注入的测试自己传对象 —— 缺省 env 是静默忽略，
 * 加第 3 个变量时漏改任何一处，那条命令就会静默丢一个凭证来源）。
 */
export function currentCredentialEnv(): CredEnv {
  return { appKey: process.env.QIYU_APP_KEY, appSecret: process.env.QIYU_APP_SECRET }
}

/** `fail()` 的信封形态（不 import output.ts —— 保持本模块零输出副作用，便于纯测）。 */
export interface ErrorEnvelope {
  code: string; kind: string; retryable: boolean; message: string; hint?: string
}

export type CredOutcome = { ok: true; creds: Credentials } | { ok: false; error: ErrorEnvelope }

/** env 里该字段是否有**非空**值（空串视为未设置 —— 判据的唯一实现在 core/config.ts）。 */
const has = (v: string | undefined): boolean => nonEmptyValue(v) !== undefined

export function resolveCredentialsUsingFile(
  env: CredEnv = currentCredentialEnv(),
  opts: { configPath?: string } = {},
): CredOutcome {
  const envKey = has(env.appKey)
  const envSecret = has(env.appSecret)
  let fromFile: Partial<Credentials> | undefined
  let configWarn: string | undefined
  if (!envKey || !envSecret) {
    const r = fileCredentials(opts.configPath)
    if (r.fatal !== undefined) {
      // 权限拒绝带 kind（config_insecure）：如实透出 —— 退出码 1、hint 点名 chmod。
      const t = r.fatal as ErrorEnvelope & { message: string }
      return {
        ok: false,
        error: {
          code: t.code ?? 'config_insecure', kind: t.kind ?? 'config_insecure',
          retryable: t.retryable ?? false, message: t.message, ...(t.hint !== undefined ? { hint: t.hint } : {}),
        },
      }
    }
    fromFile = r.creds
    configWarn = r.warn
  }
  try {
    // 空串视为未设置传给 resolveCredentials：`??` 链会把 '' 当有效值放行，
    // 随后 `if (!appKey)` 又按缺失报错 —— 两层对"空"的判定不一致，先归一。
    const creds = resolveCredentials(
      {},
      {
        appKey: has(env.appKey) ? env.appKey : undefined,
        appSecret: has(env.appSecret) ? env.appSecret : undefined,
      },
      fromFile,
    )
    return { ok: true, creds }
  } catch (e) {
    // ⚠️ 缺凭证是**环境配置**问题（退出码 1），不是参数写错 —— 否则 Agent 会去改
    // 命令行参数，而正确动作是配凭证。与 `auth whoami` 同一 kind，两处必须一致。
    const detail = configWarn !== undefined ? `（另外：配置文件读取失败 —— ${configWarn}）` : ''
    return {
      ok: false,
      error: {
        code: 'auth_missing', kind: 'auth_missing', retryable: false,
        message: `${e instanceof Error ? e.message : String(e)}${detail}`,
        hint: '运行 `qiyu auth login`（从环境变量 QIYU_APP_KEY/QIYU_APP_SECRET 写入配置文件），或直接设置这两个环境变量',
      },
    }
  }
}
