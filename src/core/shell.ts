// src/core/shell.ts
//
// shell 参数的**方言感知引号**（单一实现点）。放在 core 层而非 output.ts：
// `core/config.ts` 的 chmod/icacls hint 也要渲染可执行命令，而架构不变量
// 禁止 core/ import output.js（tests/cli.test.ts 静态扫描钉着）——
// 下沉到这里后 core 与 CLI 层各自引用同一份实现。

/**
 * 单个参数值的 shell 渲染：安全集内裸渲染，其余单引号包裹。
 * POSIX 安全集取自 Python `shlex.quote`（`[A-Za-z0-9_@%+=:,./-]`）；**win32 安全集更窄**
 *（去掉 `@` `%` `,`）—— PowerShell 下裸 `a,b` 会变成 `Object[]`、前导 `@` 是 splatting、
 * `%` 是 ForEach-Object 别名（pwsh 实测：`--profile a,b` → argc=2 且 arg 是数组）。
 * 引号内的转义**方言按平台区分**：
 *   · POSIX 用 `'\''`（关引号→转义单引号→重开引号）；
 *   · PowerShell 用 `''`（反斜杠不是转义符，POSIX 写法会被 pwsh 解析成「提前闭合引号 +
 *     `;` 切命令」，2026-10-30 pwsh 实测能执行注入载荷）。
 * ⚠️ PowerShell 还把 **4 个弯引号 `‘ ’ ‚ ‛`（U+2018/2019/201A/201B）当作单引号定界符**
 *（pwsh 实测：`'/tmp/a’; echo X; #'` 提前闭合并执行 echo）—— win32 分支同样翻倍它们，
 * 只处理 ASCII `'` 会漏（CodeRabbit 2026-10-30 minor，已实测复现）。
 * ⚠️ 解析出的路径恒为绝对路径，不含 `~`，故无「引号会阻止波浪号展开」的问题。
 */
export function shellArg(v: string, platform: string = process.platform): string {
  const win = platform === 'win32'
  const safe = win ? /^[A-Za-z0-9_+=:./-]+$/ : /^[A-Za-z0-9_@%+=:,./-]+$/
  if (safe.test(v)) return v
  const escaped = win
    ? v.replace(/['‘’‚‛]/g, (c) => c + c)
    : v.replace(/'/g, `'\\''`)
  return `'${escaped}'`
}
