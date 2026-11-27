/**
 * Windows 凭证写序的**通道骨架**（0.2.4 切片 2，Task 1）。
 *
 * 句柄不能跨进程传给 Node，所以写序 ⓪–⑥ 整体跑在一个 PowerShell 进程里：
 * Node 用 `-EncodedCommand` 启动，secret 只经 **stdin** 传入（绝不出现在命令行参数、
 * 环境变量、脚本源码或日志里）；PowerShell 以 JSON 从 stdout 回一条结果记录，
 * Node 只做决策和错误渲染。本任务只有通道，**没有副作用**：脚本的 ⓪–⑥ 段由
 * Task 2–5 填充，真实入口接入在 Task 6。
 *
 * ⚠️ 脚本源码必须纯 ASCII：PowerShell 5 按 ANSI 解码无 BOM UTF-8，中文注释会吞行
 * （真机实测），所以这里注释全英文，中文只出现在本 TS 文件的注释里。
 */
import { spawnSync } from 'node:child_process'

export type Stage =
  | 'probe'
  | 'create-tmp'
  | 'verify-tmp'
  | 'write-secret'
  | 'close'
  | 'check-reparse'
  | 'replace'
  | 'verify-target'
  | 'done'

export interface WriteScriptResult {
  ok: boolean
  stage: Stage
  problem?: string
  path?: string
  sddlReadback?: string
}

export interface WritePlan {
  configPath: string
  parentDir: string
  selfSid?: string
}

export type Runner = (args: {
  script: string
  env: Record<string, string>
  stdin: string
  timeoutMs: number
}) => { status: number; stdout: string; stderr: string }

const STAGES: readonly Stage[] = [
  'probe', 'create-tmp', 'verify-tmp', 'write-secret', 'close', 'check-reparse', 'replace', 'verify-target', 'done',
]

/**
 * 生成 PowerShell 骨架（纯函数、纯 ASCII）。
 *
 * 各阶段的顺序写在注释里，Task 2–5 按注释逐段填入真实机制；此时不读 stdin、
 * 不碰任何文件、不回结果记录（真跑也会因缺结果而判 script-failed，符合 Task 1 无副作用）。
 */
export function renderWriteScript(_plan: WritePlan): string {
  // 注释里逐行钉住写序的阶段名：测试按出现次序查找，改名/换序都会被挡住。
  const order = STAGES.map((s, i) => `# ${i + 1}. ${s}`).join('\r\n')
  return [
    '# Windows credential write-order skeleton (Task 1: no side effects).',
    '# Secret is supplied on stdin only; never in argv, env, script or logs.',
    '# Path inputs: $env:QIYU_ACL_FILE (target), $env:QIYU_ACL_PARENT (parent).',
    '# Stage order (to be filled in by Tasks 2-5; do not reorder):',
    order,
    '# 0. probe: parent directory handle and trusted state.',
    '# 1. create-tmp: create tmp under a restricted SD while holding the handle.',
    '# 2. verify-tmp: read back the SD and verify the handle identity.',
    '# 3. write-secret: write the secret through the same handle.',
    '# 4. close: close the tmp handle after the write is verified.',
    '# 5. check-reparse: reject reparse points before replacement.',
    '# 6. replace: rename tmp over the target on the same volume.',
    '# 7. verify-target: read back target SD and identity after replacement.',
    '# 8. done: emit exactly one JSON result line.',
    '# The single result line is parsed by Node from the LAST stdout line only,',
    '# because PowerShell progress/CLIXML noise may precede it.',
    '# ConvertTo-Json will emit the result record once the stages are implemented.',
    '',
  ].join('\r\n')
}

/** 把配置内容与 secret 分成两个字段：不做序列化、不改内容。 */
export function buildWritePayload(configJson: string, secretText: string): { config: string; secret: string } {
  return { config: configJson, secret: secretText }
}

/** env 只放两个路径变量；secret 永不进 env。 */
export function buildDefaultEnv(configPath: string, parentDir: string): Record<string, string> {
  return { QIYU_ACL_FILE: configPath, QIYU_ACL_PARENT: parentDir }
}

function defaultRunner(script: string, payload: { config: string; secret: string }): ReturnType<Runner> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { input: JSON.stringify(payload), encoding: 'utf8', timeout: 15_000, windowsHide: true },
  )
  return { status: res.status as number, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

const FAILED: WriteScriptResult = { ok: false, stage: 'probe', problem: 'script-failed' }

function isStage(v: unknown): v is Stage {
  return typeof v === 'string' && (STAGES as readonly string[]).includes(v)
}

/** 解析最后一行 JSON；形状不对一律回 null（由调用方收敛为 script-failed）。 */
function parseResultLine(stdout: string): WriteScriptResult | null {
  const lines = stdout.split(/\r?\n/)
  let last = ''
  for (const line of lines) if (line.trim() !== '') last = line
  if (last === '') return null
  let data: unknown
  try {
    data = JSON.parse(last)
  } catch {
    return null
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return null
  const d = data as Record<string, unknown>
  if (typeof d.ok !== 'boolean' || !isStage(d.stage)) return null
  if (d.ok && d.stage !== 'done') return null
  if (!d.ok && (typeof d.problem !== 'string' || d.problem === '')) return null
  if (d.path !== undefined && typeof d.path !== 'string') return null
  if (d.sddlReadback !== undefined && typeof d.sddlReadback !== 'string') return null
  const out: WriteScriptResult = { ok: d.ok, stage: d.stage }
  if (typeof d.problem === 'string') out.problem = d.problem
  if (typeof d.path === 'string') out.path = d.path
  if (typeof d.sddlReadback === 'string') out.sddlReadback = d.sddlReadback
  return out
}

/**
 * 跑写序脚本并把结果收敛成一个封闭形状。
 *
 * 一切失败（Runner 抛错、status 非 0、stdout 畸形/无结果行）统一回
 * `{ ok:false, stage:'probe', problem:'script-failed' }`：原始错误文本可能夹带路径、
 * 列名等外部字节，不回传给上层。
 */
export function runWriteScript(
  script: string,
  configPath: string,
  parentDir: string,
  payload: { config: string; secret: string },
  run?: Runner,
): WriteScriptResult {
  const runner = run ?? ((args: Parameters<Runner>[0]) => defaultRunner(args.script, payload))
  let response: ReturnType<Runner>
  try {
    response = runner({
      script,
      env: buildDefaultEnv(configPath, parentDir),
      stdin: JSON.stringify(payload),
      timeoutMs: 15_000,
    })
  } catch {
    return { ...FAILED }
  }
  // Runner 形状不对（返回 string/null）、status 非 0 都不是结果记录。
  if (typeof response !== 'object' || response === null) return { ...FAILED }
  if ((response as { status?: unknown }).status !== 0) return { ...FAILED }
  const stdout = (response as { stdout?: unknown }).stdout
  if (typeof stdout !== 'string') return { ...FAILED }
  return parseResultLine(stdout) ?? { ...FAILED }
}
