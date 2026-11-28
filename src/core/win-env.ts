// src/core/win-env.ts
/**
 * 启动 Windows 子进程（PowerShell）时允许继承的**系统变量白名单**。
 *
 * ⚠️ 不能 `{...process.env}`：`auth login` 的 secret 来源之一就是 `QIYU_APP_SECRET`
 * 环境变量（`src/commands/auth.ts`），整份继承会把明文 secret 随环境交给子进程，
 * 违背「secret 只经 stdin」这条约束。读面 probe 与写序脚本必须共用这一份清单
 * （两处各写一份会漂移：CodeRabbit 2026-11-28 发现 probe 仍在整份继承）。
 */
const SAFE_ENV_KEYS = [
  'PATH', 'PATHEXT', 'COMSPEC', 'SystemRoot', 'windir',
  'TEMP', 'TMP', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA',
] as const

export function pickSafeEnv(source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {}
  for (const k of SAFE_ENV_KEYS) {
    const v = source[k]
    if (typeof v === 'string') out[k] = v
  }
  return out
}
