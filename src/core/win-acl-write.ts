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
  /** 本次探到的当前用户 SID（非秘密；上层用它比对归属与重建 ACL）。 */
  selfSid?: string
  /** 脚本相关路径（tmp 或目标）；不含 secret。 */
  path?: string
  sddlReadback?: string
}

export interface WritePlan {
  configPath: string
  parentDir: string
  /** tmp 的完整路径（必须与目标同目录 → 同卷，换入才成立）。Node 生成，脚本只消费。 */
  tmpPath: string
}

export type Runner = (args: {
  script: string
  env: Record<string, string>
  stdin: string
  timeoutMs: number
}) => { status: number | null; stdout: string; stderr: string }

const STAGES: readonly Stage[] = [
  'probe', 'create-tmp', 'verify-tmp', 'write-secret', 'close', 'check-reparse', 'replace', 'verify-target', 'done',
]

/**
 * 生成 PowerShell 写序脚本（纯函数、纯 ASCII）。
 *
 * 当前已落地 ①（Task 2）：以受限 SD 原子创建 tmp、独占持有、按**句柄**读回 SDDL。
 * ②–⑥ 由 Task 3–5 在「STAGE-BLOCK」之后逐段填充；阶段次序写在注释里，
 * 测试按出现次序查找，改名/换序都会被挡住。
 *
 * 契约（写序实现必须遵守，见计划与设计稿 §2.4a）：
 * - secret 只经 stdin 传入，绝不进 argv / env / 脚本 / 日志；
 * - 结果记录必须**单行**（`ConvertTo-Json -Compress`；PS 5.1 默认多行，Node 只认末行）；
 * - 已处理的失败**一律 exit 0** 并带上 stage/problem（非 0 退出的记录会被 Node 丢弃）。
 */
export function renderWriteScript(_plan: WritePlan): string {
  // 注释里逐行钉住写序的阶段名：测试按出现次序查找，改名/换序都会被挡住。
  const order = STAGES.map((s, i) => `# ${i + 1}. ${s}`).join('\r\n')
  return [
    '# Windows credential write-order script (Tasks 2-5 fill the stages below).',
    '# Secret is supplied on stdin only; never in argv, env, script or logs.',
    '# Path inputs: $env:QIYU_ACL_FILE (target), $env:QIYU_ACL_PARENT (parent), $env:QIYU_ACL_TMP (tmp).',
    '# Stage order (do not reorder):',
    order,
    '# Stage implementations land in order; current file covers 1 (create-tmp).',
    '# Emit the result record as ONE line: ConvertTo-Json -Compress (PS 5.1 defaults to multi-line).',
    '# A processed failure still exits 0 and carries its stage/problem in the record;',
    '# only a hard crash may exit non-zero (Node discards records from non-zero exits).',
    '',
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    '',
    '[StructLayout(LayoutKind.Sequential)]',
    'public struct QiyuSA { public int nLength; public IntPtr sd; public bool inherit; }',
    '',
    'public static class QiyuWrite {',
    '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint rev, out IntPtr sd, out uint size);',
    '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev, uint info, out IntPtr str, out uint len);',
    '  [DllImport("advapi32.dll", SetLastError=true)]',
    '  static extern uint GetSecurityInfo(IntPtr h, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);',
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  static extern IntPtr CreateFileW(string name, uint access, uint share, ref QiyuSA sa, uint disposition, uint flags, IntPtr template);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  [return: MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool CloseHandle(IntPtr h);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  static extern bool WriteFile(IntPtr h, byte[] buf, uint len, out uint written, IntPtr ov);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  static extern bool ReadFile(IntPtr h, byte[] buf, uint len, out uint read, IntPtr ov);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  static extern bool SetFilePointerEx(IntPtr h, long dist, out long pos, uint method);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  static extern bool GetFileSizeEx(IntPtr h, out long size);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  static extern bool GetFileInformationByHandleEx(IntPtr h, int cls, byte[] buf, uint size, out uint ret);',
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);',
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  [return: MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool MoveFileExW(string from, string to, uint flags);',
    '  [DllImport("kernel32.dll")]',
    '  static extern IntPtr LocalFree(IntPtr p);',
    '',
    '  // GENERIC_READ|GENERIC_WRITE|WRITE_DAC|DELETE ; FILE_SHARE_READ ; CREATE_NEW ; FILE_ATTRIBUTE_NORMAL',
    '  public static IntPtr CreateRestricted(string path, string sddl, out int err) {',
    '    IntPtr sd; uint size;',
    '    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size)) { err = Marshal.GetLastWin32Error(); return IntPtr.Zero; }',
    '    try {',
    '      QiyuSA sa = new QiyuSA(); sa.nLength = Marshal.SizeOf(typeof(QiyuSA)); sa.sd = sd; sa.inherit = false;',
    '      IntPtr h = CreateFileW(path, 0xC0000000u | 0x40000u | 0x10000u, 0x1u, ref sa, 1u, 0x80u, IntPtr.Zero);',
    '      err = (h == new IntPtr(-1)) ? Marshal.GetLastWin32Error() : 0;',
    '      return h;',
    '    } finally { LocalFree(sd); }',
    '  }',
    '',
    '  // Write the whole config through the SAME handle; 0 means success.',
    '  public static int WriteAll(IntPtr h, byte[] b) {',
    '    long pos;',
    '    SetFilePointerEx(h, 0, out pos, 0);',
    '    uint w;',
    '    if (!WriteFile(h, b, (uint)b.Length, out w, IntPtr.Zero)) return Marshal.GetLastWin32Error();',
    '    return ((int)w == b.Length) ? 0 : 1;',
    '  }',
    '',
    '  // Read the file back through the same handle (UTF-8); null means read failure.',
    '  public static string ReadAll(IntPtr h) {',
    '    long size, pos;',
    '    if (!GetFileSizeEx(h, out size)) return null;',
    '    SetFilePointerEx(h, 0, out pos, 0);',
    '    byte[] buf = new byte[size];',
    '    uint read;',
    '    if (!ReadFile(h, buf, (uint)size, out read, IntPtr.Zero)) return null;',
    '    return System.Text.Encoding.UTF8.GetString(buf, 0, (int)read);',
    '  }',
    '',
    '  // Reject a reparse-point target before replacement.',
    '  // Returns 1 = reparse point, 0 = plain or missing, negative = could not decide (fail closed).',
    '  public static int TargetIsReparse(string path) {',
    '    // FILE_READ_ATTRIBUTES=0x80 ; share read|write|delete=7 ; OPEN_EXISTING=3 ;',
    '    // FILE_FLAG_OPEN_REPARSE_POINT=0x00200000 | FILE_FLAG_BACKUP_SEMANTICS=0x02000000',
    '    IntPtr h = CreateFileW(path, 0x80u, 7u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);',
    '    if (h == new IntPtr(-1)) { int e = Marshal.GetLastWin32Error(); return e == 2 ? 0 : -e; }',
    '    try {',
    '      byte[] buf = new byte[8];',
    '      uint ret;',
    '      if (!GetFileInformationByHandleEx(h, 9, buf, 8, out ret)) return -1;',
    '      uint attrs = BitConverter.ToUInt32(buf, 0);',
    '      return (attrs & 0x400u) != 0 ? 1 : 0;',
    '    } finally { CloseHandle(h); }',
    '  }',
    '',
    '  // SE_FILE_OBJECT=1, OWNER|GROUP|DACL=7',
    '  public static string SddlFromHandle(IntPtr h) {',
    '    IntPtr o, g, d, s, sd;',
    '    uint rc = GetSecurityInfo(h, 1, 7, out o, out g, out d, out s, out sd);',
    '    if (rc != 0) return "";',
    '    try {',
    '      IntPtr str; uint len;',
    '      if (!ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 7, out str, out len)) return "";',
    '      try { return Marshal.PtrToStringUni(str); } finally { LocalFree(str); }',
    '    } finally { LocalFree(sd); }',
    '  }',
    '}',
    '"@',
    '',
    '$result = @{ ok = $false; stage = "probe" }',
    'try {',
    '  $file = $env:QIYU_ACL_FILE',
    '  $parent = $env:QIYU_ACL_PARENT',
    '  if ([string]::IsNullOrEmpty($file) -or [string]::IsNullOrEmpty($parent) -or [string]::IsNullOrEmpty($env:QIYU_ACL_TMP)) { $result.problem = "missing-paths"; throw "stop" }',
    '  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '  $result.selfSid = $sid',
    '  $result.stage = "create-tmp"',
    '  $sddl = "D:P(A;;0x12019f;;;$sid)"',
    '  $tmp = $env:QIYU_ACL_TMP',
    '  $err = 0',
    '  $h = [QiyuWrite]::CreateRestricted($tmp, $sddl, [ref]$err)',
    '  if ($h -eq [IntPtr]::Zero -or $h.ToInt64() -eq -1) {',
    '    # 80 = ERROR_FILE_EXISTS / 183 = ERROR_ALREADY_EXISTS (CreateFile vs CreateDirectory)',
    '    $result.problem = if ($err -eq 80 -or $err -eq 183) { "already-exists" } else { "create-failed" }',
    '  } else {',
    '    $result.ok = $true',
    '    $result.path = $tmp',
    '    $result.sddlReadback = [QiyuWrite]::SddlFromHandle($h)',
    '    # verify-tmp: the readback must literally carry the requested DACL and the current owner.',
    '    $result.stage = "verify-tmp"',
    '    $daclOk = $result.sddlReadback.Contains($sddl)',
    '    $ownerOk = $result.sddlReadback.StartsWith("O:$sid")',
    '    if (-not ($daclOk -and $ownerOk)) {',
    '      $result.ok = $false',
    '      $result.problem = "sddl-mismatch"',
    '    } else {',
    '      $result.stage = "write-secret"',
    '      $stdin = [Console]::OpenStandardInput()',
    '      $ms = New-Object System.IO.MemoryStream',
    '      $stdin.CopyTo($ms)',
    '      $text = [System.Text.Encoding]::UTF8.GetString($ms.ToArray())',
    '      $payload = $text | ConvertFrom-Json',
    '      if ([string]::IsNullOrEmpty([string]$payload.config)) {',
    '        $result.ok = $false; $result.problem = "missing-payload"',
    '      } else {',
    '        $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$payload.config)',
    '        $wrc = [QiyuWrite]::WriteAll($h, $bytes)',
    '        if ($wrc -ne 0) {',
    '          $result.ok = $false; $result.problem = "write-failed"',
    '        } else {',
    '          $back = [QiyuWrite]::ReadAll($h)',
    '          if ($back -ne [string]$payload.config) { $result.ok = $false; $result.problem = "readback-mismatch" }',
    '        }',
    '      }',
    '    }',
    '  }',
    '  if ($result.ok) {',
    '    # close: the tmp handle must really be closed before renaming (an open handle makes MoveFileEx fail 32).',
    '    $result.stage = "close"',
    '    $closed = [QiyuWrite]::CloseHandle($h)',
    '    if (-not $closed) { $result.ok = $false; $result.problem = "close-failed" }',
    '    else {',
    '      # check-reparse: the replacement target must not be a reparse point.',
    '      $result.stage = "check-reparse"',
    '      $rp = [QiyuWrite]::TargetIsReparse($file)',
    '      if ($rp -lt 0) { $result.ok = $false; $result.problem = "reparse-check-failed" }',
    '      elseif ($rp -eq 1) { $result.ok = $false; $result.problem = "target-is-reparse" }',
    '      else {',
    '        # replace: rename tmp over the target on the same volume.',
    '        $result.stage = "replace"',
    '        if (-not [QiyuWrite]::MoveFileExW($tmp, $file, [uint32]1)) {',
    '          $result.ok = $false; $result.problem = "replace-failed"',
    '        } else {',
    '          # verify-target: read the final ACL back at the destination path.',
    '          $result.stage = "verify-target"',
    '          $final = (Get-Acl -LiteralPath $file).Sddl',
    '          if (-not $final.Contains($sddl)) { $result.ok = $false; $result.problem = "target-sddl-mismatch" }',
    '          else { $result.stage = "done" }',
    '        }',
    '      }',
    '    }',
    '  }',
    '} catch {',
    '  if (-not $result.ContainsKey("problem")) { $result.problem = "script-error" }',
    '}',
    '$result | ConvertTo-Json -Compress',
    'exit 0',
    '',
  ].join('\r\n')
}

/**
 * 写序的唯一载荷：**整份配置 JSON**（credentials 就在里面，它本身就是秘密载体）。
 *
 * ⚠️ 不要拆出单独的 secret 字段：没有任何阶段读它，属于「声明了没人读」的假契约。
 */
export function buildWritePayload(configJson: string): { config: string } {
  return { config: configJson }
}

/** env 只放三个路径变量；secret 永不进 env。 */
export function buildDefaultEnv(configPath: string, parentDir: string, tmpPath = defaultTmpPath(configPath)): Record<string, string> {
  return { QIYU_ACL_FILE: configPath, QIYU_ACL_PARENT: parentDir, QIYU_ACL_TMP: tmpPath }
}

/**
 * 默认 tmp 路径：与目标**同目录**（同卷才能 `MoveFileExW` 换名），名字沿用
 * `writeConfigFile` 的既有约定（`${pid}-${Date.now()}`），并显式给出以便结果记录点名。
 */
export function defaultTmpPath(configPath: string, now: number = Date.now()): string {
  const dir = configPath.slice(0, Math.max(configPath.lastIndexOf('/'), configPath.lastIndexOf('\\')) + 1)
  const base = configPath.slice(dir.length)
  return `${dir}.${base}.tmp-${process.pid}-${now}`
}

/**
 * 传给 PowerShell 子进程的环境变量**白名单**。
 *
 * ⚠️ 不能 `{...process.env}`：`auth login` 的 secret 来源之一就是 `QIYU_APP_SECRET`
 * 环境变量（`src/commands/auth.ts`），整份继承会把明文 secret 随环境交给子进程，
 * 违背「secret 只经 stdin」这条本模块自己的约束（审查 P1）。只放 PowerShell 启动与
 * 临时目录需要的系统变量；业务/凭证类变量一律不传。
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

function defaultRunner(args: Parameters<Runner>[0]): ReturnType<Runner> {
  const encoded = Buffer.from(args.script, 'utf16le').toString('base64')
  const res = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    {
      // 路径经 env 传给脚本（$env:QIYU_ACL_FILE / $env:QIYU_ACL_PARENT）；其余 env 只来自
      // 系统变量白名单，secret 只经 stdin，绝不随环境进子进程。
      env: { ...pickSafeEnv(), ...args.env },
      input: args.stdin,
      encoding: 'utf8',
      timeout: args.timeoutMs,
      windowsHide: true,
    },
  )
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
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
  // `ok:true` 的含义是「走到该 stage 为止没有失败」（分阶段落地期间 Task 2 只到 create-tmp）；
  // 发版脚本只在整条写序走完时给 stage='done'，Task 6 的成功判据必须显式要求 done。
  // 但 `done` 是终态：它带 ok:false 是自相矛盾的结果行，不能放行。
  if (!d.ok && d.stage === 'done') return null
  if (!d.ok && (typeof d.problem !== 'string' || d.problem === '')) return null
  for (const k of ['problem', 'selfSid', 'path', 'sddlReadback'] as const) {
    if (d[k] !== undefined && typeof d[k] !== 'string') return null
  }
  const out: WriteScriptResult = { ok: d.ok, stage: d.stage }
  if (typeof d.problem === 'string') out.problem = d.problem
  if (typeof d.selfSid === 'string') out.selfSid = d.selfSid
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
  payload: { config: string },
  run?: Runner,
  tmpPath: string = defaultTmpPath(configPath),
): WriteScriptResult {
  const runner = run ?? defaultRunner
  let response: ReturnType<Runner>
  try {
    response = runner({
      script,
      env: buildDefaultEnv(configPath, parentDir, tmpPath),
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
