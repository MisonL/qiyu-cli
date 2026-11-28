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
import { spawn, spawnSync } from 'node:child_process'
import {
  evaluateDirectoryAcl, evaluateParentAcl, parseAclSnapshot, type TokenSnapshot,
} from './win-acl.js'
import { pickSafeEnv } from './win-env.js'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
  /** 失败收尾时 tmp 是否仍残留（含 secret，ACL 受限）。 */
  tmpLeft?: boolean
  /** 载荷已发送后子进程消失/超时：目标可能已被换入，写入结果未知（Node 侧标记，不来自脚本）。 */
  outcomeUnknown?: boolean
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
    '# Windows credential write-order script (Task 5: 0. probe + checkpoints).',
    '# Secret is supplied on stdin ONLY after QIYU-READY; never in argv, env, script or logs.',
    '# Path inputs: $env:QIYU_ACL_FILE (target), $env:QIYU_ACL_PARENT (dir), $env:QIYU_ACL_TMP (tmp).',
    '# Stage order (do not reorder):',
    order,
    '# Protocol: QIYU-CP <json> (wait for GO or "STOP <problem>"), QIYU-READY, QIYU-RESULT <json>.',
    '# A processed failure still exits 0; only a hard crash may exit non-zero.',
    '',
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    '',
    'Add-Type -TypeDefinition @"',
    'using System;',
    'using System.Runtime.InteropServices;',
    'using System.Text;',
    '',
    '[StructLayout(LayoutKind.Sequential)]',
    'public struct QiyuSA { public int nLength; public IntPtr sd; public bool inherit; }',
    '[StructLayout(LayoutKind.Sequential)]',
    'public struct ACLSIZE { public uint AceCount; public uint AclBytesInUse; public uint AclBytesFree; }',
    '[StructLayout(LayoutKind.Sequential)]',
    'public struct ACEHEAD { public byte Type; public byte Flags; public ushort Size; }',
    '[StructLayout(LayoutKind.Sequential)]',
    'public struct USTR { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }',
    '[StructLayout(LayoutKind.Sequential)]',
    'public struct OATTR { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr QualityOfService; }',
    '[StructLayout(LayoutKind.Sequential)]',
    'public struct IOSB { public IntPtr Status; public IntPtr Information; }',
    '',
    'public static class QiyuWrite {',
    '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string s, uint rev, out IntPtr sd, out uint size);',
    '  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev, uint info, out IntPtr str, out uint len);',
    '  [DllImport("advapi32.dll", SetLastError=true)]',
    '  static extern uint GetSecurityInfo(IntPtr h, int type, uint info, out IntPtr owner, out IntPtr group, out IntPtr dacl, out IntPtr sacl, out IntPtr sd);',
    '  [DllImport("advapi32.dll")]',
    '  static extern bool GetSecurityDescriptorDacl(IntPtr sd, out bool present, out IntPtr dacl, out bool def);',
    '  [DllImport("advapi32.dll")]',
    '  static extern bool GetSecurityDescriptorControl(IntPtr sd, out ushort control, out uint rev);',
    '  [DllImport("advapi32.dll")]',
    '  static extern bool GetAclInformation(IntPtr acl, ref ACLSIZE info, uint len, int cls);',
    '  [DllImport("advapi32.dll")]',
    '  static extern bool GetAce(IntPtr acl, uint idx, out IntPtr ace);',
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  static extern IntPtr CreateFileW(string name, uint access, uint share, ref QiyuSA sa, uint disposition, uint flags, IntPtr template);',
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  static extern IntPtr CreateFileW(string name, uint access, uint share, IntPtr sa, uint disposition, uint flags, IntPtr template);',
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  static extern bool CreateDirectoryW(string path, ref QiyuSA sa);',
    '  [DllImport("ntdll.dll")]',
    '  static extern int NtOpenFile(out IntPtr h, uint access, ref OATTR oa, out IOSB iosb, uint share, uint options);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  static extern bool GetFileInformationByHandle(IntPtr h, out BY_HANDLE_FILE_INFORMATION info);',
    '  [DllImport("kernel32.dll", SetLastError=true)]',
    '  static extern bool GetFileInformationByHandleEx(IntPtr h, int cls, byte[] buf, uint size);',
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
    '  [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]',
    '  [return: MarshalAs(UnmanagedType.Bool)]',
    '  public static extern bool MoveFileExW(string from, string to, uint flags);',
    '  [DllImport("kernel32.dll")]',
    '  static extern IntPtr LocalFree(IntPtr p);',
    '',
    '  [StructLayout(LayoutKind.Sequential)]',
    '  public struct BY_HANDLE_FILE_INFORMATION {',
    '    public uint FileAttributes, CreationTimeLow, CreationTimeHigh, LastAccessLow, LastAccessHigh, LastWriteLow, LastWriteHigh, VolumeSerialNumber, FileSizeHigh, FileSizeLow, NumberOfLinks, FileIndexHigh, FileIndexLow;',
    '  }',
    '',
    '  // GENERIC_READ|GENERIC_WRITE|WRITE_DAC|DELETE ; FILE_SHARE_READ ; CREATE_NEW(1) ; FILE_ATTRIBUTE_NORMAL(0x80)',
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
    '  // Directory handle: FILE_LIST_DIRECTORY|FILE_ADD_FILE|READ_CONTROL, share READ|WRITE (no DELETE),',
    '  // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT (attribute is checked separately).',
    '  public static IntPtr OpenDir(string path, out int err) {',
    '    IntPtr h = CreateFileW(path, 0x1u | 0x2u | 0x80u | 0x20000u, 0x3u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);',
    '    err = (h == new IntPtr(-1)) ? Marshal.GetLastWin32Error() : 0;',
    '    return h;',
    '  }',
    '',
    '  // FILE_READ_DATA|FILE_READ_ATTRIBUTES|READ_CONTROL ; share R|W|D ; OPEN_EXISTING',
    '  public static IntPtr OpenFile(string path, out int err) {',
    '    IntPtr h = CreateFileW(path, 0x1u | 0x80u | 0x20000u, 0x7u, IntPtr.Zero, 3u, 0x80u, IntPtr.Zero);',
    '    err = (h == new IntPtr(-1)) ? Marshal.GetLastWin32Error() : 0;',
    '    return h;',
    '  }',
    '',
    '  public static int CreateDir(string path, string sddl) {',
    '    IntPtr sd; uint size;',
    '    if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, 1, out sd, out size)) return Marshal.GetLastWin32Error();',
    '    try {',
    '      QiyuSA sa = new QiyuSA(); sa.nLength = Marshal.SizeOf(typeof(QiyuSA)); sa.sd = sd; sa.inherit = false;',
    '      if (CreateDirectoryW(path, ref sa)) return 0;',
    '      return Marshal.GetLastWin32Error();',
    '    } finally { LocalFree(sd); }',
    '  }',
    '',
    '  // Relative open of one child directory name under a directory handle (no SYNC flag: it requires SYNCHRONIZE).',
    '  public static IntPtr OpenChildDir(IntPtr root, string name, out int err) {',
    '    IntPtr nb = Marshal.StringToHGlobalUni(name);',
    '    IntPtr sb = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(USTR)));',
    '    try {',
    '      USTR us; us.Length = (ushort)(name.Length * 2); us.MaximumLength = (ushort)((name.Length + 1) * 2); us.Buffer = nb;',
    '      Marshal.StructureToPtr(us, sb, false);',
    '      OATTR oa; oa.Length = Marshal.SizeOf(typeof(OATTR)); oa.RootDirectory = root; oa.ObjectName = sb;',
    '      oa.Attributes = 0x40u; oa.SecurityDescriptor = IntPtr.Zero; oa.QualityOfService = IntPtr.Zero;',
    '      IOSB iosb; IntPtr h;',
    '      int st = NtOpenFile(out h, 0x1u | 0x2u | 0x80u | 0x20000u, ref oa, out iosb, 0x7u, 0x00200001u);',
    '      err = st;',
    '      return st == 0 ? h : IntPtr.Zero;',
    '    } finally { Marshal.FreeHGlobal(sb); Marshal.FreeHGlobal(nb); }',
    '  }',
    '',
    '  public static string Identity(IntPtr h) {',
    '    BY_HANDLE_FILE_INFORMATION i;',
    '    if (!GetFileInformationByHandle(h, out i)) return "";',
    '    return i.VolumeSerialNumber.ToString("x8") + ":" + i.FileIndexHigh.ToString("x8") + i.FileIndexLow.ToString("x8");',
    '  }',
    '',
    '  public static int IsReparse(IntPtr h) {',
    '    byte[] buf = new byte[8];',
    '    if (!GetFileInformationByHandleEx(h, 9, buf, 8)) return -1;',
    '    return (BitConverter.ToUInt32(buf, 0) & 0x400u) != 0 ? 1 : 0;',
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
    '',
    '  // Structured ACL for Node-side evaluation: owner, protected flag, ACE list.',
    '  // Object/callback ACEs are reported as cls "unsupported" so Node can fail closed.',
    '  public static string AclJson(IntPtr h) {',
    '    IntPtr o, g, d, s, sd;',
    '    uint rc = GetSecurityInfo(h, 1, 7, out o, out g, out d, out s, out sd);',
    '    if (rc != 0) return null;',
    '    try {',
    '      string owner = (o == IntPtr.Zero) ? "" : new System.Security.Principal.SecurityIdentifier(o).Value;',
    '      ushort control; uint rev;',
    '      GetSecurityDescriptorControl(sd, out control, out rev);',
    '      bool isProtected = (control & 0x1000u) != 0; // SE_DACL_PROTECTED',
    '      bool present; IntPtr dacl; bool def;',
    '      if (!GetSecurityDescriptorDacl(sd, out present, out dacl, out def)) return null;',
    '      var sb = new StringBuilder();',
    '      sb.Append("{\\"sddl\\":\\"").Append(SddlFromHandle(h).Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"")).Append("\\",\\"daclProtected\\":").Append(isProtected ? "true" : "false");',
    '      sb.Append(",\\"ownerSid\\":\\"").Append(owner).Append("\\",\\"aces\\":[");',
    '      if (present) {',
    '        ACLSIZE info = new ACLSIZE(); GetAclInformation(dacl, ref info, (uint)Marshal.SizeOf(typeof(ACLSIZE)), 2);',
    '        for (uint i = 0; i < info.AceCount; i++) {',
    '          IntPtr ace; if (!GetAce(dacl, i, out ace)) return null;',
    '          ACEHEAD hd = (ACEHEAD)Marshal.PtrToStructure(ace, typeof(ACEHEAD));',
    '          if (i > 0) sb.Append(",");',
    '          if (hd.Type == 0 || hd.Type == 1) {',
    '            uint mask = (uint)Marshal.ReadInt32(IntPtr.Add(ace, 4));',
    '            string sid = new System.Security.Principal.SecurityIdentifier(IntPtr.Add(ace, 8)).Value;',
    '            bool io = (hd.Flags & 0x8) != 0;',
    '            sb.Append("{\\"type\\":\\"").Append(hd.Type == 0 ? "Allow" : "Deny").Append("\\",\\"cls\\":\\"System.Security.AccessControl.FileSystemAccessRule\\",\\"sid\\":\\"").Append(sid);',
    '            sb.Append("\\",\\"mask\\":").Append(mask).Append(",\\"inheritOnly\\":").Append(io ? "true" : "false").Append("}");',
    '          } else {',
    '            sb.Append("{\\"type\\":\\"Allow\\",\\"cls\\":\\"unsupported\\",\\"sid\\":\\"\\",\\"mask\\":0,\\"inheritOnly\\":false}");',
    '          }',
    '        }',
    '      }',
    '      sb.Append("]}");',
    '      return sb.ToString();',
    '    } finally { LocalFree(sd); }',
    '  }',
    '',
    '  // Reject a reparse-point target before replacement. 1 = reparse, 0 = plain/missing, negative = undecidable.',
    '  public static int TargetIsReparse(string path) {',
    '    IntPtr h = CreateFileW(path, 0x80u, 0x7u, IntPtr.Zero, 3u, 0x02200000u, IntPtr.Zero);',
    '    if (h == new IntPtr(-1)) { int e = Marshal.GetLastWin32Error(); return e == 2 ? 0 : -e; }',
    '    try { return IsReparse(h); } finally { CloseHandle(h); }',
    '  }',
    '',
    '  public static int WriteAll(IntPtr h, byte[] b) {',
    '    long pos; SetFilePointerEx(h, 0, out pos, 0);',
    '    uint w;',
    '    if (!WriteFile(h, b, (uint)b.Length, out w, IntPtr.Zero)) return Marshal.GetLastWin32Error();',
    '    return ((int)w == b.Length) ? 0 : 1;',
    '  }',
    '',
    '  public static string ReadAll(IntPtr h) {',
    '    long size, pos;',
    '    if (!GetFileSizeEx(h, out size)) return null;',
    '    SetFilePointerEx(h, 0, out pos, 0);',
    '    byte[] buf = new byte[size];',
    '    uint read;',
    '    if (!ReadFile(h, buf, (uint)size, out read, IntPtr.Zero)) return null;',
    '    return System.Text.Encoding.UTF8.GetString(buf, 0, (int)read);',
    '  }',
    '}',
    '"@',
    '',
    '$result = @{ ok = $false; stage = "probe" }',
    '$qi = [IntPtr]::Zero; $ph = [IntPtr]::Zero; $rel = [IntPtr]::Zero; $h = [IntPtr]::Zero',
    '$hph = [IntPtr]::Zero; $fh = [IntPtr]::Zero',
    'function Emit([string]$line) { [Console]::Out.WriteLine($line); [Console]::Out.Flush() }',
    '# stdin is UTF-8 (the payload carries non-ASCII config text); [Console]::In would decode as OEM.',
    '$stdinReader = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), [System.Text.Encoding]::UTF8)',
    'function ReadCtl { return $stdinReader.ReadLine() }',
    'try {',
    '  $file = $env:QIYU_ACL_FILE',
    '  $parent = $env:QIYU_ACL_PARENT',
    '  $tmp = $env:QIYU_ACL_TMP',
    '  if ([string]::IsNullOrEmpty($file) -or [string]::IsNullOrEmpty($parent) -or [string]::IsNullOrEmpty($tmp)) { $result.problem = "missing-paths"; throw "stop" }',
    '  $sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value',
    '  $result.selfSid = $sid',
    '  # Explicit owner: without O: the new object takes the token default owner, which an',
    '  # elevated token may resolve to Administrators and then fail our own owner check.',
    '  $fileDacl = "D:P(A;;0x13019f;;;" + $sid + ")"',
    '  $dirDacl = "D:P(A;;FA;;;" + $sid + ")"',
    '  $fileSddl = "O:" + $sid + $fileDacl',
    '  $dirSddl = "O:" + $sid + $dirDacl',
    '',
    '  # 0. probe: bind the parent handle FIRST (hold it), read its ACL, let Node decide.',
    '  #    First login needs a second checkpoint after the directory is created (the recipe',
    '  #    of the new directory is judged then). Both checkpoints must pass before any write.',
    '  $created = $false',
    '  $createdTmp = $false',
    '  $err = 0',
    '  $up = Split-Path -Parent $parent',
    '  $ph = [QiyuWrite]::OpenDir($up, [ref]$err)',
    '  if ($ph -eq [IntPtr]::Zero -or $ph.ToInt64() -eq -1) {',
    '    # A fresh Windows account has no ~/.config: create it with the same user-only recipe',
    '    # the qiyu directory gets, then bind the handle. Real-machine e2e 2026-11-28.',
    '    if ($err -ne 2 -and $err -ne 3) { $result.problem = "parent-open-failed"; throw "stop" }',
    '    # Bind the first existing ancestor (HOME) before the first filesystem change.',
    '    # $HOME is a read-only automatic variable (rename; real-machine 2026-11-28).',
    '    $homeDir = Split-Path -Parent $up',
    '    $err = 0',
    '    $hph = [QiyuWrite]::OpenDir($homeDir, [ref]$err)',
    '    if ($hph -eq [IntPtr]::Zero -or $hph.ToInt64() -eq -1) { $result.problem = "ancestor-open-failed"; throw "stop" }',
    '    $homeAcl = [QiyuWrite]::AclJson($hph)',
    '    $pcerr = [QiyuWrite]::CreateDir($up, $dirSddl)',
    '    if ($pcerr -ne 0) { $result.problem = "parent-create-failed"; throw "stop" }',
    '    $err = 0',
    '    $ph = [QiyuWrite]::OpenDir($up, [ref]$err)',
    '    if ($ph -eq [IntPtr]::Zero -or $ph.ToInt64() -eq -1) { $result.problem = "parent-open-failed"; throw "stop" }',
    '  }',
    '  $leaf = Split-Path -Leaf $parent',
    '  $qi = [QiyuWrite]::OpenDir($parent, [ref]$err)',
    '  if ($qi -eq [IntPtr]::Zero -or $qi.ToInt64() -eq -1) {',
    '    if ($err -ne 2 -and $err -ne 3) { $result.problem = "dir-open-failed"; throw "stop" }',
    '    $created = $true',
    '  }',
    '  $cp1 = @{ stage = "probe"; phase = "parent"; selfSid = $sid; created = $created }',
    '  $cp1.parent = [QiyuWrite]::AclJson($ph)',
    '  if (-not [string]::IsNullOrEmpty($homeAcl)) { $cp1.home = $homeAcl }',
    '  if (-not $created) {',
    '    $rel = [QiyuWrite]::OpenChildDir($ph, $leaf, [ref]$err)',
    '    $idRel = if ($rel -eq [IntPtr]::Zero) { "" } else { [QiyuWrite]::Identity($rel) }',
    '    $idQ = [QiyuWrite]::Identity($qi)',
    '    if ($idRel -eq "" -or $idQ -eq "") { $result.problem = "identity-failed"; throw "stop" }',
    '    $cp1.identityMatch = ($idRel -eq $idQ)',
    '    $rp = [QiyuWrite]::IsReparse($qi)',
    '    if ($rp -lt 0) { $result.problem = "reparse-check-failed"; throw "stop" }',
    '    $cp1.reparse = ($rp -eq 1)',
    '    $cp1.qiyu = [QiyuWrite]::AclJson($qi)',
    '  }',
    '  Emit ("QIYU-CP " + ($cp1 | ConvertTo-Json -Compress -Depth 6))',
    '  $reply = ReadCtl',
    '  if ($null -eq $reply) { $result.problem = "no-decision"; throw "stop" }',
    '  if ($reply -ne "GO") {',
    '    # Never echo an unexpected reply: a caller that already sent the payload would',
    '    # otherwise get the secret copied into the error text.',
    '    $result.problem = if ($reply.StartsWith("STOP ") -and $reply.Length -gt 5) { $reply.Substring(5) } else { "unexpected-reply" }',
    '    throw "stop"',
    '  }',
    '  if ($created) {',
    '    $cerr = [QiyuWrite]::CreateDir($parent, $dirSddl)',
    '    if ($cerr -ne 0) { $result.problem = "dir-create-failed"; throw "stop" }',
    '    $err = 0',
    '    $qi = [QiyuWrite]::OpenDir($parent, [ref]$err)',
    '    if ($qi -eq [IntPtr]::Zero -or $qi.ToInt64() -eq -1) { $result.problem = "dir-open-failed"; throw "stop" }',
    '    $rel = [QiyuWrite]::OpenChildDir($ph, $leaf, [ref]$err)',
    '    $cp2 = @{ stage = "probe"; phase = "created"; selfSid = $sid; created = $true }',
    '    $idRel2 = if ($rel -eq [IntPtr]::Zero) { "" } else { [QiyuWrite]::Identity($rel) }',
    '    $idQ2 = [QiyuWrite]::Identity($qi)',
    '    if ($idRel2 -eq "" -or $idQ2 -eq "") { $result.problem = "identity-failed"; throw "stop" }',
    '    $cp2.identityMatch = ($idRel2 -eq $idQ2)',
    '    $rp2 = [QiyuWrite]::IsReparse($qi)',
    '    if ($rp2 -lt 0) { $result.problem = "reparse-check-failed"; throw "stop" }',
    '    $cp2.reparse = ($rp2 -eq 1)',
    '    $cp2.qiyu = [QiyuWrite]::AclJson($qi)',
    '    Emit ("QIYU-CP " + ($cp2 | ConvertTo-Json -Compress -Depth 6))',
    '    $reply2 = ReadCtl',
    '    if ($null -eq $reply2) { $result.problem = "no-decision"; throw "stop" }',
    '    if ($reply2 -ne "GO") {',
    '      $result.problem = if ($reply2.StartsWith("STOP ") -and $reply2.Length -gt 5) { $reply2.Substring(5) } else { "unexpected-reply" }',
    '      throw "stop"',
    '    }',
    '  }',
    '',
    '  $result.stage = "create-tmp"',
    '  $err = 0',
    '  $h = [QiyuWrite]::CreateRestricted($tmp, $fileSddl, [ref]$err)',
    '  if ($h -eq [IntPtr]::Zero -or $h.ToInt64() -eq -1) {',
    '    $result.problem = if ($err -eq 80 -or $err -eq 183) { "already-exists" } else { "create-failed" }',
    '    throw "stop"',
    '  }',
    '  $createdTmp = $true',
    '  $tmpId = [QiyuWrite]::Identity($h)',
    '  $result.path = $tmp',
    '  $result.sddlReadback = [QiyuWrite]::SddlFromHandle($h)',
    '',
    '  # verify-tmp: the readback must carry the requested DACL and the current owner.',
    '  # Some flows read back with the ACL-level AI flag (D:PAI); normalize it before comparing.',
    '  $result.stage = "verify-tmp"',
    '  $rbTmp = $result.sddlReadback -replace ":PAI\\(", ":P("',
    '  $daclOk = $rbTmp.Contains($fileDacl)',
    '  $ownerOk = $result.sddlReadback.StartsWith("O:$sid")',
    '  if (-not ($daclOk -and $ownerOk)) { $result.problem = "sddl-mismatch"; throw "stop" }',
    '',
    '  $result.stage = "write-secret"',
    '  Emit "QIYU-READY"',
    '  $payloadText = ReadCtl',
    '  if ($null -eq $payloadText) { $result.problem = "missing-payload"; throw "stop" }',
    '  $payload = $payloadText | ConvertFrom-Json',
    '  if ([string]::IsNullOrEmpty([string]$payload.config)) { $result.problem = "missing-payload"; throw "stop" }',
    '  $bytes = [System.Text.Encoding]::UTF8.GetBytes([string]$payload.config)',
    '  $wrc = [QiyuWrite]::WriteAll($h, $bytes)',
    '  if ($wrc -ne 0) { $result.problem = "write-failed"; throw "stop" }',
    '  $back = [QiyuWrite]::ReadAll($h)',
    '  if ($back -ne [string]$payload.config) { $result.problem = "readback-mismatch"; throw "stop" }',
    '  $result.ok = $true',
    '',
    '  # close',
    '  $result.stage = "close"',
    '  $closed = [QiyuWrite]::CloseHandle($h)',
    '  if (-not $closed) { $result.ok = $false; $result.problem = "close-failed"; throw "stop" }',
    '',
    '  # check-reparse: the replacement target must not be a reparse point.',
    '  $result.stage = "check-reparse"',
    '  $tattr = [QiyuWrite]::TargetIsReparse($file)',
    '  if ($tattr -lt 0) { $result.ok = $false; $result.problem = "reparse-check-failed"; throw "stop" }',
    '  if ($tattr -eq 1) { $result.ok = $false; $result.problem = "target-is-reparse"; throw "stop" }',
    '',
    '  # replace',
    '  $result.stage = "replace"',
    '  if (-not [QiyuWrite]::MoveFileExW($tmp, $file, [uint32]1)) { $result.ok = $false; $result.problem = "replace-failed"; throw "stop" }',
    '  $createdTmp = $false',
    '',
    '  # verify-target',
    '  $result.stage = "verify-target"',
    '  $err = 0',
    '  $fh = [QiyuWrite]::OpenFile($file, [ref]$err)',
    '  if ($fh -eq [IntPtr]::Zero -or $fh.ToInt64() -eq -1) { $result.ok = $false; $result.problem = "target-open-failed"; throw "stop" }',
    '  if ([string]::IsNullOrEmpty($tmpId) -or [QiyuWrite]::Identity($fh) -ne $tmpId) { $result.ok = $false; $result.problem = "target-identity-mismatch"; throw "stop" }',
    '  $final = ([QiyuWrite]::SddlFromHandle($fh)) -replace ":PAI\\(", ":P("',
    '  if (-not $final.StartsWith("O:" + $sid)) { $result.ok = $false; $result.problem = "target-owner-mismatch"; throw "stop" }',
    '  if (-not $final.Contains($fileDacl)) { $result.ok = $false; $result.problem = "target-sddl-mismatch"; throw "stop" }',
    '  $result.stage = "done"',
    '} catch {',
    '  if (-not $result.ContainsKey("problem")) { $result.problem = "script-error" }',
    '} finally {',
    '  foreach ($hh in @($h, $fh, $qi, $rel, $ph, $hph)) { if ($hh -ne [IntPtr]::Zero) { [QiyuWrite]::CloseHandle($hh) | Out-Null } }',
    '  # A failed run must not leave the secret in the tmp file. Best effort: remove it and report.',
    '  # Only OUR tmp: on already-exists/create-failed the same name belongs to someone else.',
    '  if ($createdTmp -and $result.stage -ne "done" -and [System.IO.File]::Exists($tmp)) {',
    '    try { [System.IO.File]::Delete($tmp) } catch { }',
    '    $result.tmpLeft = [System.IO.File]::Exists($tmp)',
    '  }',
    '}',
    'Emit ("QIYU-RESULT " + ($result | ConvertTo-Json -Compress))',
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

// 环境白名单的唯一实现在 win-env.ts（读面 probe 与写序脚本共用）；这里转出以保留既有导入面。
export { pickSafeEnv } from './win-env.js'

/**
 * 把脚本写到临时 `.ps1` 再执行。
 *
 * ⚠️ 不能用 `-EncodedCommand`：写序脚本已接近 10KB，UTF-16LE base64 后超过 Windows
 * 命令行 32767 字符上限，`spawn` 直接 ENAMETOOLONG（真机实测）。脚本是纯 ASCII、
 * 且**不含 secret**（路径走 env、载荷走 stdin），所以落临时文件不扩大暴露面。
 */
function withTempScript<T>(script: string, fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'qiyu-write-'))
  const file = join(dir, 'write.ps1')
  try {
    writeFileSync(file, script, { encoding: 'utf8', mode: 0o600 })
    return fn(file)
  } finally {
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* 清理失败不改变结果 */ }
  }
}

const PS_FLAGS = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'] as const

function defaultRunner(args: Parameters<Runner>[0]): ReturnType<Runner> {
  const res = withTempScript(args.script, (file) => spawnSync(
    'powershell.exe',
    [...PS_FLAGS, file],
    {
      // 路径经 env 传给脚本（$env:QIYU_ACL_FILE / $env:QIYU_ACL_PARENT）；其余 env 只来自
      // 系统变量白名单，secret 只经 stdin，绝不随环境进子进程。
      env: { ...pickSafeEnv(), ...args.env },
      input: args.stdin,
      encoding: 'utf8',
      timeout: args.timeoutMs,
      windowsHide: true,
    },
  ))
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
  try {
    return coerceResult(JSON.parse(last.startsWith(RESULT_PREFIX) ? last.slice(RESULT_PREFIX.length) : last))
  } catch {
    return null
  }
}

/** 封闭形状校验（单行结果与交互协议的结果对象共用）。 */
function coerceResult(data: unknown): WriteScriptResult | null {
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
  if (d.tmpLeft !== undefined && typeof d.tmpLeft !== 'boolean') return null
  const out: WriteScriptResult = { ok: d.ok, stage: d.stage }
  if (typeof d.problem === 'string') out.problem = d.problem
  if (typeof d.selfSid === 'string') out.selfSid = d.selfSid
  if (typeof d.path === 'string') out.path = d.path
  if (typeof d.sddlReadback === 'string') out.sddlReadback = d.sddlReadback
  if (typeof d.tmpLeft === 'boolean') out.tmpLeft = d.tmpLeft
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

// ── 交互协议（Task 5）──────────────────────────────────────────────────────
//
// 为什么需要（设计约束，不是风格选择）：⓪ 的判定必须发生在写 secret 之前，而判定是
// Node 侧的纯函数（`win-acl.ts`）——不能为了同步 `spawnSync` 在 PowerShell 里再实现
// 一份规则（同一判据两个实现点＝漂移）。所以脚本在关键点打印单行 checkpoint，
// Node 判定后回 `GO` / `STOP <problem>`；只有脚本走到写入点并打印 `QIYU-READY`
// 之后，Node 才把配置载荷写进 stdin。**secret 的发送时点由这里保证**。

/** 脚本 → Node 的 checkpoint 行前缀。 */
export const CP_PREFIX = 'QIYU-CP '
/** 脚本 → Node：即将读取载荷（只会在全部 checkpoint 通过之后出现）。 */
export const READY_LINE = 'QIYU-READY'
/** 脚本 → Node 的最终结果行前缀。 */
export const RESULT_PREFIX = 'QIYU-RESULT '

export interface WriteCheckpoint {
  stage: Stage
  /** 'parent'（绑定父目录后）或 'created'（首次登录已建目录后）。 */
  phase?: 'parent' | 'created'
  /** 脚本探到的当前用户 SID。 */
  selfSid?: string
  /** 待 Node 判定的 ACL 节点（JSON 字符串或已解析对象，形状同 `AclSnapshot`）。 */
  qiyu?: unknown
  parent?: unknown
  /** 首个既有祖先（首登自建 `~/.config` 时为 HOME）的 ACL；同样按写面受信判。 */
  home?: unknown
  /** qiyu 是否由本次调用创建。 */
  created?: boolean
  /** 相对打开的身份是否与 qiyu 句柄一致（仅复用档有）。 */
  identityMatch?: boolean
  /** qiyu 是否为重解析点。 */
  reparse?: boolean
}

export type CheckpointDecision = { go: true } | { go: false; problem: string }

export interface ChildLike {
  stdin: { write(chunk: string): unknown; end(): void; on?(event: 'error', cb: (arg: unknown) => void): unknown } | null
  stdout: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null
  stderr: { on(event: 'data', cb: (chunk: Buffer | string) => void): unknown } | null
  on(event: 'close' | 'exit' | 'error', cb: (arg: unknown) => void): unknown
  kill(): unknown
}

export type SpawnLike = (cmd: string, argv: string[], opts: Record<string, unknown>) => ChildLike

export interface InteractiveArgs {
  script: string
  configPath: string
  parentDir: string
  tmpPath: string
  /** 整份配置 JSON（秘密载体）——只有 READY 之后才会写进子进程 stdin。 */
  config: string
  onCheckpoint: (cp: WriteCheckpoint) => CheckpointDecision
  spawnImpl?: SpawnLike
  timeoutMs?: number
}

/**
 * 跑交互式写序。返回与 `runWriteScript` 同形状的封闭结果。
 *
 * 失败一律 `{ ok:false, stage:'probe', problem:'script-failed' }`（含：子进程启动失败、
 * 非 0 退出、超时、结果行缺失/畸形）。原始 stderr 不回传（可能夹带路径等外部字节）。
 */
export function runWriteInteractive(args: InteractiveArgs): Promise<WriteScriptResult> {
  const timeoutMs = args.timeoutMs ?? 20_000
  const spawnImpl = args.spawnImpl ?? (spawn as unknown as SpawnLike)
  const env = { ...pickSafeEnv(), ...buildDefaultEnv(args.configPath, args.parentDir, args.tmpPath) }

  // 脚本落临时文件再执行（见 withTempScript 的原因）；退出/超时后清理。
  const scriptDir = mkdtempSync(join(tmpdir(), 'qiyu-write-'))
  const scriptFile = join(scriptDir, 'write.ps1')
  writeFileSync(scriptFile, args.script, { encoding: 'utf8', mode: 0o600 })
  const cleanup = (): void => { try { rmSync(scriptDir, { recursive: true, force: true }) } catch { /* 忽略 */ } }

  return new Promise((resolve) => {
    let settled = false
    const finish = (r: WriteScriptResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill() } catch { /* 已退出 */ }
      cleanup()
      resolve(r)
    }

    let child: ChildLike
    try {
      child = spawnImpl('powershell.exe', [...PS_FLAGS, scriptFile], { env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      cleanup()
      resolve({ ...FAILED })
      return
    }

    let payloadSent = false
    const unknown = (): WriteScriptResult => ({ ok: false, stage: 'write-secret', problem: 'interrupted', outcomeUnknown: true })
    const failNow = (): WriteScriptResult => (payloadSent ? unknown() : { ...FAILED })
    const timer = setTimeout(() => finish(failNow()), timeoutMs)
    let buffer = ''
    /** 任一 checkpoint 被拒后，即使脚本仍打印 READY 也**不得**发送秘密。 */
    let denied: string | null = null

    const onLine = (line: string): void => {
      if (settled) return
      if (line.startsWith(CP_PREFIX)) {
        let cp: WriteCheckpoint
        try {
          cp = JSON.parse(line.slice(CP_PREFIX.length)) as WriteCheckpoint
        } catch {
          finish({ ...FAILED })
          return
        }
        if (payloadSent) { finish({ ...FAILED }); return } // checkpoint 不许出现在载荷之后
        let decision: CheckpointDecision
        try {
          decision = args.onCheckpoint(cp)
        } catch {
          finish({ ...FAILED })
          return
        }
        if (!decision.go) denied = decision.problem
        try {
          child.stdin?.write(decision.go ? 'GO\n' : `STOP ${decision.problem}\n`)
        } catch {
          finish({ ...FAILED })
        }
        return
      }
      if (line.trim() === READY_LINE) {
        // 载荷只在这里发送：它是 secret 进入子进程的唯一时点。
        if (denied !== null) { finish({ ok: false, stage: 'probe', problem: denied }); return }
        payloadSent = true
        try {
          child.stdin?.write(`${JSON.stringify({ config: args.config })}\n`)
        } catch {
          finish({ ...FAILED })
        }
        return
      }
      if (line.startsWith(RESULT_PREFIX)) {
        let parsed: WriteScriptResult | null
        try {
          parsed = coerceResult(JSON.parse(line.slice(RESULT_PREFIX.length)))
        } catch {
          parsed = null
        }
        finish(parsed ?? { ...FAILED })
      }
    }

    child.stdout?.on('data', (chunk) => {
      buffer += chunk.toString()
      for (;;) {
        const idx = buffer.search(/\r?\n/)
        if (idx < 0) break
        const line = buffer.slice(0, idx)
        const sepLen = buffer.startsWith('\r\n', idx) ? 2 : 1
        buffer = buffer.slice(idx + sepLen)
        onLine(line)
      }
    })
    // 'close' 而不是 'exit'：exit 可能先于最后一行 stdout 到达，会把已完成的写入判成失败。
    child.on('close', () => {
      if (!settled) finish(failNow())
    })
    child.on('error', () => finish(failNow()))
    // 子进程提前关闭 stdin 时 write() 会异步发 error；不挂监听会变成未捕获异常。
    child.stdin?.on?.('error', () => finish(failNow()))
  })
}

// ── 判定与入口（Task 6）────────────────────────────────────────────────────

/** checkpoint 的**默认判定**：全部走 `win-acl.ts` 的纯函数（唯一判据实现点）。 */
export function judgeCheckpoint(cp: WriteCheckpoint): CheckpointDecision {
  const userSid = cp.selfSid
  if (typeof userSid !== 'string' || userSid === '') return { go: false, problem: 'missing-selfsid' }
  const token: TokenSnapshot = { userSid, groups: [], restrictedSids: [] }
  const parse = (v: unknown): ReturnType<typeof parseAclSnapshot> => {
    if (typeof v === 'string') { try { return parseAclSnapshot(JSON.parse(v)) } catch { return null } }
    return parseAclSnapshot(v)
  }
  if (cp.phase === 'created') {
    // CP2 只带新建目录的材料：父目录已在 CP1 判过（GO 才可能走到建目录），不重复。
    if (cp.reparse === true) return { go: false, problem: 'dir-is-reparse' }
    if (cp.identityMatch !== true) return { go: false, problem: 'dir-identity-mismatch' }
    const qiyu = parse(cp.qiyu)
    if (qiyu === null) return { go: false, problem: 'dir-unparsable' }
    const dv = evaluateDirectoryAcl(qiyu, userSid)
    return dv.ok ? { go: true } : { go: false, problem: dv.problem }
  }
  if (cp.home !== undefined) {
    const home = parse(cp.home)
    if (home === null) return { go: false, problem: 'ancestor-unparsable' }
    const hv = evaluateParentAcl(home, token)
    if (!hv.ok) return { go: false, problem: hv.problem }
  }
  const parent = parse(cp.parent)
  if (parent === null) return { go: false, problem: 'parent-unparsable' }
  const pv = evaluateParentAcl(parent, token)
  if (!pv.ok) return { go: false, problem: pv.problem }
  // phase 'parent'：复用档（目录已存在）在同一个 checkpoint 里附带了 qiyu 的判定材料。
  if (cp.created !== true) {
    if (cp.reparse === true) return { go: false, problem: 'dir-is-reparse' }
    if (cp.identityMatch !== true) return { go: false, problem: 'dir-identity-mismatch' }
    const qiyu = parse(cp.qiyu)
    if (qiyu === null) return { go: false, problem: 'dir-unparsable' }
    const dv = evaluateDirectoryAcl(qiyu, userSid)
    if (!dv.ok) return { go: false, problem: dv.problem }
  }
  return { go: true }
}

/** 写序失败：带 stage 与 problem，供上层渲染成带修法的错误。 */
export class WinWriteError extends Error {
  /**
   * `wroteTarget`：就绪判据是「stage === 'verify-target'」——换入已发生，目标内容已是新凭证，
   * 只是换入后的 ACL 复核没过；此时不能说「凭证未写入」，否则 Agent 会以为旧配置还在。
   */
  constructor(
    readonly stage: Stage, readonly problem: string, readonly selfSid?: string,
    readonly tmpPath?: string, readonly tmpLeft?: boolean, readonly outcomeUnknown?: boolean,
  ) {
    super(`Windows 写序在 ${stage} 阶段失败（${problem}）`)
    this.name = 'WinWriteError'
  }
  get wroteTarget(): boolean { return this.stage === 'verify-target' }
}

export interface WinWriteOptions {
  run?: typeof runWriteInteractive
  judge?: (cp: WriteCheckpoint) => CheckpointDecision
}

/**
 * win32 的配置写入入口：整条写序（⓪–⑥）在一个 PowerShell 进程内完成。
 *
 * 成功判据必须显式是 `stage === 'done'`（`ok:true` 只表示「走到该 stage 没失败」）。
 * 失败抛 `WinWriteError`，**不返回部分成功**——上层据此报 `config_insecure` 而不是
 * `configured:true`。
 */
export async function writeConfigFileWin32(
  configPath: string, serialized: string, opts: WinWriteOptions = {},
): Promise<void> {
  const parentDir = configPath.slice(0, Math.max(configPath.lastIndexOf('/'), configPath.lastIndexOf('\\')))
  const tmpPath = defaultTmpPath(configPath)
  const script = renderWriteScript({ configPath, parentDir, tmpPath })
  const run = opts.run ?? runWriteInteractive
  const judge = opts.judge ?? judgeCheckpoint
  const r = await run({
    script, configPath, parentDir, tmpPath, config: serialized,
    onCheckpoint: judge,
  })
  if (!r.ok || r.stage !== 'done') {
    throw new WinWriteError(r.stage, r.problem ?? 'not-done', r.selfSid, tmpPath, r.tmpLeft, r.outcomeUnknown)
  }
}
