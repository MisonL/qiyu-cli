/**
 * Windows NTFS ACL 读面判据（0.2.4，设计稿 §2.4 清单第 1–8 条）。
 *
 * 为什么需要这个模块：`checkPermissions` 原先在 win32 首行 `return { ok: true }` ——
 * 「含凭证且过宽即拒绝」在 Windows 上整条蒸发（连警告都没有），`auth login` 的写后自检
 * 因此恒真。POSIX 的 `mode & 0o077` 判据在 Windows 上无意义（普通文件回读 666），
 * 必须换成「枚举安全描述符 + 按受信状态清单判」。
 *
 * 判据是**封闭清单**，不是黑名单：逐条补「已知坏形态」（具名用户、null DACL、属主）
 * 会一直漏，所以按「整份安全描述符是否处于受信状态」判，任一条不满足即拒绝：
 *   1. DACL 存在（null DACL = 无访问控制，所有人完全访问）
 *   2. DACL 非空（空 DACL = 拒绝所有人，不是本 CLI 写序可能产出的形态）
 *   3. 属主 ∈ {当前用户, SYSTEM, Administrators}
 *   4. 所有允许 ACE 的主体 ∈ 同一受信集合
 *   5. 当前用户按跨 ACE 顺序模拟（MS-DTYP `RemainingAccess`）确实持有读权限，
 *      且 WRITE_DAC/WRITE_OWNER 未授予集合外主体
 *   6. 继承关闭（`SE_DACL_PROTECTED`）
 *   7. 父目录属主受信，且非受信主体没有写类权限
 *   8. 任一条判不了 → `checked:false`，不冒认 ok
 *
 * 三态：安全 `{ok:true,checked:true}`；不安全 `{ok:false,checked:true}`；
 * 判不了 `{ok:false,checked:false}`。**「不安全」与「判不了」不得混成一个 ok:false** ——
 * 两者的修法完全不同（前者清 ACL，后者查环境/权限来源）。
 *
 * 已知边界（0.2.4 后续切片关闭，别当成已实现）：
 * - 本模块按**路径**取安全描述符；「判定与读取绑定同一对象」的读面 TOCTOU
 *   （设计稿 §2.4c-①）需要句柄化读取，尚未落地。
 * - 令牌若为受限令牌（restricting SID 非空），`WRITE_RESTRICTED` 标志无法从公开 API
 *   读出——判不了就走 `checked:false`，不按某一档假定。
 */
import { execFileSync } from 'node:child_process'
import { pickSafeEnv } from './win-env.js'

// ── 位与 SID 常量（MS-DTYP / WinNT.h）───────────────────────────────────────
const SID_SYSTEM = 'S-1-5-18'
const SID_ADMINISTRATORS = 'S-1-5-32-544'
const SID_OWNER_RIGHTS = 'S-1-3-4'

/** 读面请求掩码：READ_CONTROL | FILE_READ_DATA | FILE_READ_ATTRIBUTES | FILE_READ_EA | SYNCHRONIZE。 */
const READ_REQUEST = 0x20000 | 0x1 | 0x80 | 0x8 | 0x100000
const WRITE_DAC = 0x40000
const WRITE_OWNER = 0x80000
/** 目录「写类」权限：创建/删除子项 + 改 DACL + 改属主（清单第 7 条）。 */
const DIR_WRITE_CLASS = 0x2 | 0x4 | 0x40 | 0x10000 | WRITE_DAC | WRITE_OWNER

/** 令牌组属性位（WinNT.h `SE_GROUP_*`）。 */
const SE_GROUP_ENABLED = 0x4
const SE_GROUP_USE_FOR_DENY_ONLY = 0x10

/** `Get-Acl` 对普通 ACE 返回的类型名；callback/条件 ACE 不是它。 */
const FILE_SYSTEM_ACCESS_RULE = 'System.Security.AccessControl.FileSystemAccessRule'

export type AclProblem =
  | 'dacl-missing'
  | 'dacl-empty'
  | 'unsupported-ace'
  | 'untrusted-owner'
  | 'untrusted-allow'
  | 'read-denied'
  | 'dacl-inherited'
  | 'parent-untrusted-owner'
  | 'parent-writable'
  | 'dir-recipe-mismatch'
  | 'restricted-token'
  | 'probe-failed'
  | 'parent-dacl-missing'
  | 'parent-unsupported-ace'
  | 'ancestor-dacl-missing'
  | 'ancestor-unsupported-ace'
  | 'ancestor-untrusted-owner'
  | 'ancestor-writable'

/** 运行期成员清单（唯一出处）：`AclProblem` 是类型，hint/文案分支需要运行期判据。 */
const ACL_PROBLEM_SET: ReadonlySet<string> = new Set<AclProblem>([
  'dacl-missing', 'dacl-empty', 'unsupported-ace', 'untrusted-owner', 'untrusted-allow', 'read-denied',
  'dacl-inherited', 'parent-untrusted-owner', 'parent-writable', 'dir-recipe-mismatch', 'restricted-token', 'probe-failed',
  'parent-dacl-missing', 'parent-unsupported-ace', 'ancestor-dacl-missing', 'ancestor-unsupported-ace',
  'ancestor-untrusted-owner', 'ancestor-writable',
])

export function isAclProblem(p: string): p is AclProblem {
  return ACL_PROBLEM_SET.has(p)
}

export interface AceSnapshot {
  type: 'Allow' | 'Deny'
  /** .NET 返回的 ACE 类名；不是 `FileSystemAccessRule` 即 callback/条件 ACE。 */
  cls: string
  sid: string
  /** 访问掩码（已是位集）。 */
  mask: number
  /** `INHERIT_ONLY_ACE` 置位——访问检查**根本不看**这类 ACE，求值前必须剔除。 */
  inheritOnly: boolean
}

export interface AclSnapshot {
  /** 完整 SDDL；null DACL 的表现为**没有 `D:` 段**（或 `D:NO_ACCESS_CONTROL`）。 */
  sddl: string
  /** `SE_DACL_PROTECTED`（继承关闭）。 */
  daclProtected: boolean
  ownerSid: string
  aces: AceSnapshot[]
}

export interface TokenSnapshot {
  userSid: string
  groups: { sid: string; attr: number }[]
  restrictedSids: string[]
}

export interface ProbeSnapshot {
  file: AclSnapshot
  parent: AclSnapshot
  token: TokenSnapshot
}

export type WinAclVerdict =
  | { ok: true; checked: true }
  | { ok: false; checked: true; problem: AclProblem }
  | { ok: false; checked: false; problem: AclProblem }

/**
 * 成因的**唯一文案出处**（`core/config.ts` 的错误与 `commands/auth.ts` 的写后自检共用，
 * 免得两处对同一个 problem 说两套话）。
 */
export function describeAclProblem(problem: AclProblem): string {
  switch (problem) {
    case 'dacl-missing':
      return 'DACL 缺失（null DACL = 无访问控制，所有账户都能读）'
    case 'dacl-empty':
      return 'DACL 为空（拒绝所有人，当前用户自己也读不了）'
    case 'unsupported-ace':
      return '存在条件/callback ACE，读面无法求值'
    case 'untrusted-owner':
      return '属主不是当前用户/SYSTEM/Administrators（属主可随时给自己补读权限）'
    case 'untrusted-allow':
      return '存在授给受信名单之外主体的允许 ACE（他人可直接读到 appSecret）'
    case 'read-denied':
      return '当前用户的有效读权利不完整（按 DACL 顺序求值后仍缺读权限）'
    case 'dacl-inherited':
      return 'DACL 继承未关闭（父目录 ACL 变化会把名单外主体重新带进来）'
    case 'parent-untrusted-owner':
      return '父目录属主不是受信主体（配置文件可被整体替换）'
    case 'parent-writable':
      return '父目录对受信名单之外的主体有写类权限（配置文件可被整体替换）'
    case 'dir-recipe-mismatch':
      return '配置目录的 ACL 不等于本契约的目录配方（受保护、只授当前用户、含七项目录访问位）'
    case 'restricted-token':
      return '进程是受限令牌，无法判定 restricting SID 的求值档'
    case 'probe-failed':
      return 'ACL 探测执行失败（PowerShell 不可用、超时或输出无法解析）'
    case 'parent-dacl-missing':
      return '父目录 DACL 缺失（null DACL = 所有账户可写，配置可被整体替换）'
    case 'parent-unsupported-ace':
      return '父目录存在条件/对象 ACE，写面无法求值'
    case 'ancestor-dacl-missing':
      return '配置目录的上一级（首个既有祖先）DACL 缺失（null DACL = 所有账户可写）'
    case 'ancestor-unsupported-ace':
      return '首个既有祖先存在条件/对象 ACE，写面无法求值'
    case 'ancestor-untrusted-owner':
      return '首个既有祖先的属主不是受信主体'
    case 'ancestor-writable':
      return '首个既有祖先对受信名单之外的主体有写类权限（配置目录可被整体替换）'
  }
}

/**
 * SDDL 里的对象 ACE（OA/OU）与条件 ACE（XA/RA 等）标记。.NET 的 `.Access` 投影可能把
 * 这类 ACE 显示成普通 FileSystemAccessRule 或干脆丢掉——只看类名不足以发现它们，
 * 所以在 SDDL 形态上也拦一道（仍不是完备判据：SDDL 也被投影过时无从得知）。
 */
const SDDL_EXTENDED_ACE = /\((?:OA|OU|XA|XD|OD|RA|ZA|ZD)[A-Z]*;/

function hasExtendedAce(acl: AclSnapshot): boolean {
  return SDDL_EXTENDED_ACE.test(acl.sddl)
}

/**
 * 父目录语境的成因（`evaluateParentAcl` 只产出 dacl-missing/unsupported-ace/parent-*）：
 * 前两个补 `parent-` 前缀，读面与 judgeCheckpoint 共用，hint 才能把目标指到 ~/.config。
 */
export function parentProblem(p: AclProblem): AclProblem {
  switch (p) {
    case 'dacl-missing': return 'parent-dacl-missing'
    case 'unsupported-ace': return 'parent-unsupported-ace'
    default: return p
  }
}

function trustedSid(sid: string, token: TokenSnapshot): boolean {
  return sid === token.userSid || sid === SID_SYSTEM || sid === SID_ADMINISTRATORS
}

/** allow 语义的命中：用户本体，或令牌里**已启用且非 deny-only** 的组（MS-DTYP `SidInToken`）。 */
function allowMatches(sid: string, token: TokenSnapshot): boolean {
  if (sid === token.userSid) return true
  return token.groups.some(
    (g) => g.sid === sid && (g.attr & SE_GROUP_ENABLED) !== 0 && (g.attr & SE_GROUP_USE_FOR_DENY_ONLY) === 0,
  )
}

/**
 * deny 语义的命中：已启用或 deny-only 的组参与拒绝（MS-DTYP `SidInToken`）；
 * 被禁用的普通组既不授予也不拒绝——把它算进 deny 会把安全 ACL 误报成 read-denied。
 */
function denyMatches(sid: string, token: TokenSnapshot): boolean {
  if (sid === token.userSid) return true
  return token.groups.some(
    (g) => g.sid === sid && (g.attr & (SE_GROUP_ENABLED | SE_GROUP_USE_FOR_DENY_ONLY)) !== 0,
  )
}

/**
 * 单份安全描述符的读面求值（清单第 1–6 条）。
 *
 * `RemainingAccess` 模拟是机制规则（MS-DTYP《Access Check Algorithm Pseudocode》）：
 * - 先算属主隐含项：属主命中令牌、且 DACL 里没有 `OWNER RIGHTS`（S-1-3-4）ACE 时，
 *   `READ_CONTROL`/`WRITE_DAC` 已隐含授予——漏掉这步会把合法配置误判 `ok:false`；
 * - `INHERIT_ONLY_ACE` 置位的 ACE 直接跳过（Windows 访问检查根本不看它们）；
 * - 依序扫：deny 命中且与**仍待定**权利相交 → 整请求拒绝；allow 命中 → 从待定集合移除其掩码。
 *   已被授予的权利不会被后面的 deny 撤销。
 */
function evaluateAcl(acl: AclSnapshot, token: TokenSnapshot): { ok: true } | { ok: false; problem: AclProblem } {
  // 条件 ACE / callback ACE / 任何非普通 ACE：读面判不了，不冒认。
  const unsupported = acl.aces.some((a) => a.cls !== FILE_SYSTEM_ACCESS_RULE || (a.type !== 'Allow' && a.type !== 'Deny'))
  if (unsupported || hasExtendedAce(acl)) return { ok: false, problem: 'unsupported-ace' }

  // 第 1、2 条：DACL 存在且非空。
  if (!hasDacl(acl.sddl)) return { ok: false, problem: 'dacl-missing' }
  if (acl.aces.length === 0) return { ok: false, problem: 'dacl-empty' }

  // 第 3 条：属主受信（属主隐含 WRITE_DAC，名单外账户可随时给自己补读权限）。
  if (!trustedSid(acl.ownerSid, token)) return { ok: false, problem: 'untrusted-owner' }

  // 第 4 条：任何名单外主体的允许 ACE 即拒绝——不区分广域/具名，也不看它是否另有 deny。
  if (acl.aces.some((a) => a.type === 'Allow' && !trustedSid(a.sid, token))) {
    return { ok: false, problem: 'untrusted-allow' }
  }

  // 第 5 条：按顺序模拟有效读权利。
  // 属主隐含项只在**属主命中令牌**时成立（MS-DTYP `SidInToken`）——属主是 SYSTEM
  // 但进程不是 SYSTEM 时不隐含；按「等于用户 SID」之外的写法都会多给或漏给权利。
  let remaining = READ_REQUEST
  const hasOwnerRightsAce = acl.aces.some((a) => a.sid === SID_OWNER_RIGHTS)
  if (!hasOwnerRightsAce && allowMatches(acl.ownerSid, token)) {
    remaining &= ~(0x20000 | WRITE_DAC)
  }
  for (const ace of acl.aces) {
    if (ace.inheritOnly) continue
    if (ace.type === 'Deny') {
      if (denyMatches(ace.sid, token) && (ace.mask & remaining) !== 0) return { ok: false, problem: 'read-denied' }
      continue
    }
    if (allowMatches(ace.sid, token)) remaining &= ~ace.mask
  }
  if (remaining !== 0) return { ok: false, problem: 'read-denied' }

  // 第 6 条：继承关闭（继承开着时父目录一改就能把名单外主体重新带进来）。
  if (!acl.daclProtected) return { ok: false, problem: 'dacl-inherited' }

  return { ok: true }
}

/** SDDL 里有 `D:` 段才算 DACL 存在；`D:NO_ACCESS_CONTROL` 是 null DACL。 */
function hasDacl(sddl: string): boolean {
  if (/D:NO_ACCESS_CONTROL/i.test(sddl)) return false
  return /D:/.test(sddl)
}

/** 父目录的写面受信（清单第 7 条）：属主受信 + 非受信主体没有写类允许 ACE。 */
export function evaluateParentAcl(parent: AclSnapshot, token: TokenSnapshot): { ok: true } | { ok: false; problem: AclProblem } {
  // null DACL（SDDL 里没有 D: 段）= 无访问控制，所有人可写；空 ACE 列表不等于它。
  if (!hasDacl(parent.sddl)) return { ok: false, problem: 'dacl-missing' }
  // INHERIT_ONLY ACE 只作用于子项，不参与目录自身的访问检查——把它们算进写面会把安全父目录误报。
  const effective = parent.aces.filter((a) => !a.inheritOnly)
  if (effective.some((a) => a.cls !== FILE_SYSTEM_ACCESS_RULE || (a.type !== 'Allow' && a.type !== 'Deny'))) {
    return { ok: false, problem: 'unsupported-ace' }
  }
  if (hasExtendedAce(parent)) return { ok: false, problem: 'unsupported-ace' }
  if (!trustedSid(parent.ownerSid, token)) return { ok: false, problem: 'parent-untrusted-owner' }
  const writable = effective.some(
    (a) => a.type === 'Allow' && !trustedSid(a.sid, token) && (a.mask & DIR_WRITE_CLASS) !== 0,
  )
  if (writable) return { ok: false, problem: 'parent-writable' }
  return { ok: true }
}

/** 「判不了」的成因：修法是查环境/换权限来源，不是清 ACL——不得与「不安全」混成一个 ok:false。 */
const UNDECIDABLE: ReadonlySet<AclProblem> = new Set<AclProblem>([
  'unsupported-ace', 'parent-unsupported-ace', 'ancestor-unsupported-ace', 'restricted-token', 'probe-failed',
])

/**
 * 目录配方的判定（写序 ⓪ 的 `qiyu` 目录档，设计稿 §2.4a「目录的 SD 要单独给」）。
 *
 * 判据取「**至少含七项目录访问位**」而不是与 `FA` 字符串相等：
 * FILE_TRAVERSE(0x20) | FILE_LIST_DIRECTORY(0x1) | FILE_ADD_FILE(0x2) |
 * FILE_ADD_SUBDIRECTORY(0x4) | DELETE(0x10000) | READ_CONTROL(0x20000) | SYNCHRONIZE(0x100000)。
 * 允许比它更宽（`FA` 就是），但不许更窄，也不许把允许 ACE 授给当前用户之外的任何主体
 * （SYSTEM/Administrators 在这个档**不放行**——规格对目录要求「只授当前用户」）。
 */
const DIR_REQUIRED = 0x20 | 0x1 | 0x2 | 0x4 | 0x10000 | 0x20000 | 0x100000

export function evaluateDirectoryAcl(
  acl: AclSnapshot, selfSid: string, token?: TokenSnapshot,
): { ok: true } | { ok: false; problem: AclProblem } {
  if (acl.aces.some((a) => a.cls !== FILE_SYSTEM_ACCESS_RULE || (a.type !== 'Allow' && a.type !== 'Deny'))) {
    return { ok: false, problem: 'unsupported-ace' }
  }
  if (!hasDacl(acl.sddl)) return { ok: false, problem: 'dacl-missing' }
  if (acl.aces.length === 0) return { ok: false, problem: 'dacl-empty' }
  if (acl.ownerSid !== selfSid) return { ok: false, problem: 'untrusted-owner' }
  if (!acl.daclProtected) return { ok: false, problem: 'dacl-inherited' }
  if (acl.aces.some((a) => a.type === 'Allow' && a.sid !== selfSid)) return { ok: false, problem: 'untrusted-allow' }
  if (hasExtendedAce(acl)) return { ok: false, problem: 'unsupported-ace' }
  // 按 ACE 顺序求**有效**权利（与 evaluateAcl 同一 RemainingAccess 模型）：
  // 只并集 allow 会放过「先 deny DELETE、后整份 allow」——Windows 上该目录并不授予 DELETE。
  const tok: TokenSnapshot = token ?? { userSid: selfSid, groups: [], restrictedSids: [] }
  let remaining = DIR_REQUIRED
  for (const ace of acl.aces) {
    if (ace.inheritOnly) continue
    if (ace.type === 'Deny') {
      // deny 对**组成员**同样生效（如 deny Everyone/Users 会拿掉 DELETE）——只看 selfSid 会假绿。
      if (denyMatches(ace.sid, tok) && (ace.mask & remaining) !== 0) {
        return { ok: false, problem: 'dir-recipe-mismatch' }
      }
      continue
    }
    if (ace.sid === selfSid) remaining &= ~ace.mask
  }
  if (remaining !== 0) return { ok: false, problem: 'dir-recipe-mismatch' }
  return { ok: true }
}

/** 三态判据的唯一入口（纯函数，测试用合成快照驱动）。 */
export function evaluateWinAcl(snapshot: ProbeSnapshot): WinAclVerdict {
  // 受限令牌：WRITE_RESTRICTED 标志无法从公开 API 读出，读面走第一遍还是两遍判不了。
  if (snapshot.token.restrictedSids.length > 0) {
    return { ok: false, checked: false, problem: 'restricted-token' }
  }
  const file = evaluateAcl(snapshot.file, snapshot.token)
  if (!file.ok) return { ok: false, checked: !UNDECIDABLE.has(file.problem), problem: file.problem }
  const parent = evaluateParentAcl(snapshot.parent, snapshot.token)
  if (!parent.ok) {
    const problem = parentProblem(parent.problem)
    return { ok: false, checked: !UNDECIDABLE.has(problem), problem }
  }
  return { ok: true, checked: true }
}

// ── 探测（PowerShell）─────────────────────────────────────────────────────

/**
 * PowerShell 侧脚本：一次调用同时取文件、父目录的安全描述符与进程令牌。
 *
 * 为什么用 `Get-Acl` 而不是 `icacls`：icacls 的权限文本是本地化的（中文 Windows 输出
 * 不同 token），按文本分流是旧红线；`.Sddl`/ACE 的 SID 与掩码与语言无关。
 * 路径经环境变量传入，避免命令行引号在中文/空格路径下被吞。
 *
 * 令牌组属性与 restricting SID 用 P/Invoke `GetTokenInformation` 读取——.NET 的
 * `WindowsIdentity.Groups` 不暴露 `SE_GROUP_USE_FOR_DENY_ONLY`，用它会把
 * 「受保护 DACL 只授 deny-only 的 Administrators」判成可读（假绿）。
 */
const PROBE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;

public static class QiyuTok {
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool GetTokenInformation(IntPtr h, int cls, IntPtr buf, int len, out int ret);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("advapi32.dll", SetLastError=true)]
  static extern bool OpenProcessToken(IntPtr p, uint acc, out IntPtr tok);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);

  static string[] Sids(IntPtr tok, int cls) {
    int len = 0;
    GetTokenInformation(tok, cls, IntPtr.Zero, 0, out len);
    if (len == 0) throw new Exception("size");
    IntPtr buf = Marshal.AllocHGlobal(len);
    try {
      int got;
      if (!GetTokenInformation(tok, cls, buf, len, out got)) throw new Exception("query");
      int count = Marshal.ReadInt32(buf);
      int arrOff = IntPtr.Size == 8 ? 8 : 4;
      IntPtr arr = IntPtr.Add(buf, arrOff);
      int structSize = IntPtr.Size == 8 ? 16 : 8;
      var list = new List<string>();
      for (int i = 0; i < count; i++) {
        IntPtr sidPtr = Marshal.ReadIntPtr(IntPtr.Add(arr, i * structSize));
        int attr = Marshal.ReadInt32(IntPtr.Add(arr, i * structSize + IntPtr.Size));
        list.Add(new System.Security.Principal.SecurityIdentifier(sidPtr).Value + ";" + attr);
      }
      return list.ToArray();
    } finally { Marshal.FreeHGlobal(buf); }
  }

  public static string[] Groups() {
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), 0x8, out tok)) throw new Exception("open");
    try { return Sids(tok, 2); } finally { CloseHandle(tok); }
  }
  public static string[] Restricted() {
    IntPtr tok;
    if (!OpenProcessToken(GetCurrentProcess(), 0x8, out tok)) throw new Exception("open");
    try { return Sids(tok, 11); } finally { CloseHandle(tok); }
  }
}
"@

function Get-AclNode([string]$p) {
  $acl = Get-Acl -LiteralPath $p
  $aces = @()
  foreach ($ace in $acl.Access) {
    $aces += [pscustomobject]@{
      type        = $ace.AccessControlType.ToString()
      cls         = $ace.GetType().FullName
      sid         = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
      mask        = [int]$ace.FileSystemRights
      inheritOnly = ((($ace.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0))
    }
  }
  [pscustomobject]@{
    sddl          = $acl.Sddl
    daclProtected = $acl.AreAccessRulesProtected
    ownerSid      = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
    aces          = $aces
  }
}

$out = [ordered]@{
  file   = Get-AclNode $env:QIYU_ACL_FILE
  parent = Get-AclNode $env:QIYU_ACL_PARENT
  token  = [ordered]@{
    userSid       = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    groups        = [QiyuTok]::Groups()
    restrictedSids = [QiyuTok]::Restricted()
  }
}
$out | ConvertTo-Json -Depth 6 -Compress
`

export interface ProbeRunner {
  (script: string, env: Record<string, string>): string
}

function defaultRunner(script: string, env: Record<string, string>): string {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { env: { ...pickSafeEnv(), ...env }, encoding: 'utf8', timeout: 15000, windowsHide: true },
  )
}

/**
 * 读一个配置文件与其直接父目录的安全描述符。
 *
 * 失败（PowerShell 不可用、超时、JSON 畸形、字段缺失）→ `null`；调用方按
 * 清单第 8 条给 `checked:false`，**不得**当成「判定通过」。
 */
export function probeWinAcl(configPath: string, dirPath: string, run: ProbeRunner = defaultRunner): ProbeSnapshot | null {
  let raw: string
  try {
    raw = run(PROBE_SCRIPT, { QIYU_ACL_FILE: configPath, QIYU_ACL_PARENT: dirPath })
  } catch {
    return null
  }
  return parseProbeOutput(raw)
}

/** 解析探测输出（单独导出以便用合成样本测失败路径与形状校验）。 */
export function parseProbeOutput(raw: string): ProbeSnapshot | null {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return null
  }
  const d = data as Record<string, unknown>
  const file = parseAclSnapshot(d.file)
  const parent = parseAclSnapshot(d.parent)
  const token = parseTokenNode(d.token)
  if (file === null || parent === null || token === null) return null
  return { file, parent, token }
}

export function parseAclSnapshot(node: unknown): AclSnapshot | null {
  if (typeof node !== 'object' || node === null) return null
  const n = node as Record<string, unknown>
  if (typeof n.sddl !== 'string' || typeof n.daclProtected !== 'boolean' || typeof n.ownerSid !== 'string') return null
  if (!Array.isArray(n.aces)) return null
  const aces: AceSnapshot[] = []
  for (const raw of n.aces) {
    if (typeof raw !== 'object' || raw === null) return null
    const a = raw as Record<string, unknown>
    if (typeof a.type !== 'string' || typeof a.cls !== 'string' || typeof a.sid !== 'string') return null
    if (typeof a.mask !== 'number' || typeof a.inheritOnly !== 'boolean') return null
    aces.push({ type: a.type as AceSnapshot['type'], cls: a.cls, sid: a.sid, mask: a.mask, inheritOnly: a.inheritOnly })
  }
  return { sddl: n.sddl, daclProtected: n.daclProtected, ownerSid: n.ownerSid, aces }
}

function parseTokenNode(node: unknown): TokenSnapshot | null {
  if (typeof node !== 'object' || node === null) return null
  const n = node as Record<string, unknown>
  if (typeof n.userSid !== 'string' || !Array.isArray(n.groups) || !Array.isArray(n.restrictedSids)) return null
  const groups: { sid: string; attr: number }[] = []
  for (const raw of n.groups) {
    if (typeof raw !== 'string') return null
    const sep = raw.lastIndexOf(';')
    if (sep <= 0) return null
    const attr = Number(raw.slice(sep + 1))
    if (!Number.isFinite(attr)) return null
    groups.push({ sid: raw.slice(0, sep), attr })
  }
  const restrictedSids: string[] = []
  for (const raw of n.restrictedSids) {
    if (typeof raw !== 'string') return null
    const sep = raw.lastIndexOf(';')
    restrictedSids.push(sep > 0 ? raw.slice(0, sep) : raw)
  }
  return { userSid: n.userSid, groups, restrictedSids }
}

/**
 * `checkPermissions` 的 win32 入口：探测 → 求值 → 三态（附带当前用户 SID，
 * 让上层 hint 能生成可执行的 icacls 命令）。
 *
 * 探测本身失败归 `checked:false`（判不了），不归「不安全」。
 */
export function checkWinAcl(configPath: string, dirPath: string, run?: ProbeRunner): {
  verdict: WinAclVerdict
  userSid?: string
} {
  const snapshot = probeWinAcl(configPath, dirPath, run)
  if (snapshot === null) return { verdict: { ok: false, checked: false, problem: 'probe-failed' } }
  return { verdict: evaluateWinAcl(snapshot), userSid: snapshot.token.userSid }
}
