// tests/core/win-acl.test.ts —— Windows 读面 ACL 判据（0.2.4）
//
// 纯函数用合成快照驱动：真实 NTFS 上的 ACL 行为由 Windows 真机验证（Windows 真机），
// 这里钉的是「给定安全描述符该判什么」——每条断言对应设计稿 §2.4 清单的一条判据或
// 一条已知的假绿形态。合成快照的形状与 `probeWinAcl` 的真实输出一致（字段取自真机样本）。

import { describe, it, expect, beforeEach } from 'vitest'
import {
  checkWinAcl, evaluateWinAcl, parseProbeOutput, evaluateDirectoryAcl, isAclProblem,
  type AceSnapshot, type AclSnapshot, type ProbeSnapshot, type TokenSnapshot,
} from '../../src/core/win-acl.js'
import { __resetPermissionWarnings, checkPermissions } from '../../src/core/config.js'

const USER = 'S-1-5-21-3861268055-4207080600-3105454512-1001'
const OTHER_USER = 'S-1-5-21-3861268055-4207080600-3105454512-1005'
const SYSTEM = 'S-1-5-18'
const ADMINS = 'S-1-5-32-544'
const USERS = 'S-1-5-32-545'
const EVERYONE = 'S-1-1-0'

const READ = 0x120089 // READ_CONTROL|READ_DATA|READ_ATTRIBUTES|READ_EA|SYNCHRONIZE
const FULL = 0x1f01ff
const FILE_ADD_FILE = 0x2

const token = (over: Partial<TokenSnapshot> = {}): TokenSnapshot => ({
  userSid: USER,
  // 已启用的 Administrators（提权令牌的实测形态：attr=15）
  groups: [{ sid: ADMINS, attr: 0xf }],
  restrictedSids: [],
  ...over,
})

const ace = (
  type: 'Allow' | 'Deny', sid: string, mask: number, opts: { inheritOnly?: boolean; cls?: string } = {},
): AceSnapshot => ({
  type,
  cls: opts.cls ?? 'System.Security.AccessControl.FileSystemAccessRule',
  sid,
  mask,
  inheritOnly: opts.inheritOnly ?? false,
})

const acl = (aces: AceSnapshot[], opts: Partial<AclSnapshot> = {}): AclSnapshot => ({
  sddl: 'D:PAI',
  daclProtected: true,
  ownerSid: USER,
  aces,
  ...opts,
})

/** 一份合规的父目录：属主当前用户，只授读给 Users（读面无关的写类位必须没有）。 */
const cleanParent = (): AclSnapshot => acl([ace('Allow', USER, FULL), ace('Allow', USERS, READ)])

const snapshot = (file: AclSnapshot, parent: AclSnapshot = cleanParent(), tok = token()): ProbeSnapshot => ({
  file,
  parent,
  token: tok,
})

describe('读面：受信状态清单（安全路径）', () => {
  it('受保护 DACL 只授当前用户 FullControl → ok（当前用户自持 WRITE_DAC 不算违规）', () => {
    expect(evaluateWinAcl(snapshot(acl([ace('Allow', USER, FULL)])))).toEqual({ ok: true, checked: true })
  })

  it('SYSTEM/Administrators 持有 FullControl → ok（内置受信主体，设计上等价全权）', () => {
    const file = acl([ace('Allow', USER, READ), ace('Allow', SYSTEM, FULL), ace('Allow', ADMINS, FULL)])
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: true, checked: true })
  })

  it('allow 在前的 deny 不撤销已授予的权利（RemainingAccess：deny 只与待定集合相交才生效）', () => {
    const file = acl([ace('Allow', USER, READ), ace('Deny', USER, 0x1)])
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: true, checked: true })
  })

  it('属主隐含 READ_CONTROL：DACL 只授 0x100089（不含 READ_CONTROL）仍判可读', () => {
    const file = acl([ace('Allow', USER, 0x100089)])
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: true, checked: true })
  })
})

describe('读面：逐条拒绝形态', () => {
  it('第 1 条 null DACL：SDDL 没有 D: 段 → dacl-missing（不安全，不是判不了）', () => {
    const file = acl([ace('Allow', USER, FULL)], { sddl: 'O:' + USER + 'G:' + USERS })
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: true, problem: 'dacl-missing' })
  })

  it('第 1 条 null DACL 的显式形态 D:NO_ACCESS_CONTROL → dacl-missing', () => {
    const file = acl([ace('Allow', USER, FULL)], { sddl: 'D:NO_ACCESS_CONTROL' })
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: true, problem: 'dacl-missing' })
  })

  it('第 2 条空 DACL → dacl-empty（「拒绝所有人」不是收紧成功）', () => {
    expect(evaluateWinAcl(snapshot(acl([])))).toEqual({ ok: false, checked: true, problem: 'dacl-empty' })
  })

  it('第 3 条非受信属主 → untrusted-owner（属主隐含 WRITE_DAC，可自补读权限）', () => {
    const file = acl([ace('Allow', USER, FULL)], { ownerSid: OTHER_USER })
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: true, problem: 'untrusted-owner' })
  })

  it('第 4 条具名用户的允许 ACE → untrusted-allow（黑名单式实现会漏掉这条）', () => {
    const file = acl([ace('Allow', USER, FULL), ace('Allow', OTHER_USER, READ)])
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: true, problem: 'untrusted-allow' })
  })

  it('第 4 条继承来的 Everyone 只读 ACE 同样判 untrusted-allow', () => {
    const file = acl([ace('Allow', EVERYONE, READ), ace('Allow', USER, FULL)])
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: true, problem: 'untrusted-allow' })
  })

  it('第 5 条 deny READ_DATA 在 allow 之前 → read-denied', () => {
    const file = acl([ace('Deny', USER, 0x1), ace('Allow', USER, FULL)])
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: true, problem: 'read-denied' })
  })

  it('第 5 条 allow 只授了部分读权利 → read-denied（缺的角色不因别的 ACE 全授而补齐）', () => {
    const file = acl([ace('Allow', USER, 0x1)])
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: true, problem: 'read-denied' })
  })

  it('INHERIT_ONLY 的 allow 不参与求值：它排在前也不算授予，后面的 deny 仍然生效', () => {
    const file = acl([
      ace('Allow', USER, FULL, { inheritOnly: true }),
      ace('Deny', USER, 0x1),
      ace('Allow', USER, FULL),
    ])
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: true, problem: 'read-denied' })
  })

  it('OWNER RIGHTS（S-1-3-4）ACE 在场时属主隐含被抑制 → 只授 0x100089 时 read-denied', () => {
    const file = acl([
      ace('Allow', USER, 0x100089),
      ace('Deny', 'S-1-3-4', 0x20000), // OWNER RIGHTS：撤销隐含的 READ_CONTROL
    ])
    // Deny 命中的是 S-1-3-4，不是当前用户的 SID；它抑制隐含授予的机制靠「存在即可」。
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: true, problem: 'read-denied' })
  })

  it('第 6 条继承未关闭 → dacl-inherited', () => {
    const file = acl([ace('Allow', USER, FULL)], { daclProtected: false })
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: true, problem: 'dacl-inherited' })
  })

  it('第 7 条父目录给非受信主体 FILE_ADD_FILE → parent-writable', () => {
    const parent = acl([ace('Allow', USER, FULL), ace('Allow', USERS, FILE_ADD_FILE)])
    expect(evaluateWinAcl(snapshot(acl([ace('Allow', USER, FULL)]), parent))).toEqual({
      ok: false, checked: true, problem: 'parent-writable',
    })
  })

  it('第 7 条父目录属主非受信 → parent-untrusted-owner', () => {
    const parent = acl([ace('Allow', USER, FULL)], { ownerSid: OTHER_USER })
    expect(evaluateWinAcl(snapshot(acl([ace('Allow', USER, FULL)]), parent))).toEqual({
      ok: false, checked: true, problem: 'parent-untrusted-owner',
    })
  })
})

describe('读面：令牌属性（deny-only 组）', () => {
  const denyOnlyAdmins: TokenSnapshot = { userSid: USER, groups: [{ sid: ADMINS, attr: 0x10 }], restrictedSids: [] }

  it('allow 授给 deny-only 的 Administrators 不算获授 → read-denied（照「是不是组成员」实现会假绿）', () => {
    const file = acl([ace('Allow', ADMINS, FULL)])
    expect(evaluateWinAcl(snapshot(file, cleanParent(), denyOnlyAdmins))).toEqual({
      ok: false, checked: true, problem: 'read-denied',
    })
  })

  it('deny 来自 deny-only 的组仍算拒绝 → read-denied', () => {
    const file = acl([ace('Deny', ADMINS, 0x1), ace('Allow', USER, FULL)])
    expect(evaluateWinAcl(snapshot(file, cleanParent(), denyOnlyAdmins))).toEqual({
      ok: false, checked: true, problem: 'read-denied',
    })
  })
})

describe('读面：判不了（checked:false，与「不安全」分开）', () => {
  it('callback/条件 ACE → unsupported-ace 且 checked:false', () => {
    const file = acl([ace('Allow', USER, FULL, { cls: 'System.Security.AccessControl.CommonAce' })])
    expect(evaluateWinAcl(snapshot(file))).toEqual({ ok: false, checked: false, problem: 'unsupported-ace' })
  })

  it('受限令牌 → restricted-token 且 checked:false（WRITE_RESTRICTED 标志读不出，不按任一档假定）', () => {
    const tok = token({ restrictedSids: ['S-1-5-32-545'] })
    expect(evaluateWinAcl(snapshot(acl([ace('Allow', USER, FULL)]), cleanParent(), tok))).toEqual({
      ok: false, checked: false, problem: 'restricted-token',
    })
  })
})

describe('checkPermissions 的 win32 接线（注入平台与探测；不依赖宿主 OS）', () => {
  const CFG = 'C:\\Users\\u\\.config\\qiyu\\config.json'
  const okProbe = (): { verdict: { ok: true; checked: true }; userSid: string } => ({
    verdict: { ok: true, checked: true }, userSid: USER,
  })

  beforeEach(() => { __resetPermissionWarnings() })

  it('探测安全 → ok:true, checked:true', () => {
    expect(checkPermissions(CFG, { hasCredentials: true, onWarn: () => {} }, 'win32', okProbe))
      .toEqual({ ok: true, checked: true })
  })

  it('不安全 + 含凭证 → 拒绝（reason=acl），并带成因与当前用户 SID 供 hint 生成 icacls', () => {
    const probe = (): { verdict: { ok: false; checked: true; problem: 'untrusted-allow' }; userSid: string } => ({
      verdict: { ok: false, checked: true, problem: 'untrusted-allow' }, userSid: USER,
    })
    expect(checkPermissions(CFG, { hasCredentials: true, onWarn: () => {} }, 'win32', probe)).toEqual({
      ok: false, checked: true, reason: 'acl', aclProblem: 'untrusted-allow', selfSid: USER,
    })
  })

  it('判不了 + 含凭证 → 拒绝且 checked:false（reason=acl-unchecked，与「不安全」分开）', () => {
    const probe = (): { verdict: { ok: false; checked: false; problem: 'probe-failed' } } => ({
      verdict: { ok: false, checked: false, problem: 'probe-failed' },
    })
    expect(checkPermissions(CFG, { hasCredentials: true, onWarn: () => {} }, 'win32', probe)).toEqual({
      ok: false, checked: false, reason: 'acl-unchecked', aclProblem: 'probe-failed', selfSid: undefined,
    })
  })

  it('不安全 + 无凭证 → 警告不阻断，同进程只警告一次（与 POSIX 分支同构）', () => {
    const warns: string[] = []
    const probe = (): { verdict: { ok: false; checked: true; problem: 'dacl-inherited' } } => ({
      verdict: { ok: false, checked: true, problem: 'dacl-inherited' },
    })
    const opts = { hasCredentials: false, onWarn: (m: string) => warns.push(m) }
    expect(checkPermissions(CFG, opts, 'win32', probe)).toEqual({ ok: true, checked: true })
    expect(checkPermissions(CFG, opts, 'win32', probe)).toEqual({ ok: true, checked: true })
    expect(warns).toHaveLength(1)
  })
})

describe('探测：输出解析与失败映射', () => {
  // 真机样本（protected DACL 只授自己）的字段形状。
  const realSample = JSON.stringify({
    file: {
      sddl: 'O:' + USER + 'G:S-1-5-21-3861268055-4207080600-3105454512-513D:PAI(A;;FA;;;' + USER + ')',
      daclProtected: true,
      ownerSid: USER,
      aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: USER, mask: FULL, inheritOnly: false }],
    },
    parent: {
      sddl: 'D:AI(A;ID;FA;;;SY)',
      daclProtected: false,
      ownerSid: USER,
      aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: SYSTEM, mask: FULL, inheritOnly: false }],
    },
    token: { userSid: USER, groups: [ADMINS + ';15', USERS + ';7'], restrictedSids: [] },
  })

  it('真机形状的 JSON 可解析，且求值为 ok', () => {
    const snap = parseProbeOutput(realSample)
    expect(snap).not.toBeNull()
    expect(snap!.token.groups).toEqual([{ sid: ADMINS, attr: 15 }, { sid: USERS, attr: 7 }])
    expect(evaluateWinAcl(snap!)).toEqual({ ok: true, checked: true })
  })

  it('JSON 畸形 / 字段缺失 → null（调用方给 checked:false，不得当成通过）', () => {
    expect(parseProbeOutput('not json')).toBeNull()
    expect(parseProbeOutput('{"file":{}}')).toBeNull()
    expect(parseProbeOutput(JSON.stringify({ file: { sddl: 'D:', daclProtected: true, ownerSid: USER, aces: [{ type: 'Allow' }] } }))).toBeNull()
  })

  it('探测进程失败 → checked:false + probe-failed（环境问题不归「不安全」）', () => {
    const failing = (): string => { throw new Error('powershell missing') }
    expect(checkWinAcl('C:\\x\\config.json', 'C:\\x', failing)).toEqual({
      verdict: { ok: false, checked: false, problem: 'probe-failed' },
    })
  })

  it('探测成功但 ACL 过宽 → checked:true + 具体成因（两态不混）', () => {
    const loose = JSON.stringify({
      file: { sddl: 'D:AI(A;ID;FA;;;' + EVERYONE + ')', daclProtected: false, ownerSid: USER,
        aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: EVERYONE, mask: FULL, inheritOnly: false }] },
      parent: { sddl: 'D:AI(A;ID;FA;;;' + SYSTEM + ')', daclProtected: false, ownerSid: USER,
        aces: [{ type: 'Allow', cls: 'System.Security.AccessControl.FileSystemAccessRule', sid: SYSTEM, mask: FULL, inheritOnly: false }] },
      token: { userSid: USER, groups: [], restrictedSids: [] },
    })
    expect(checkWinAcl('C:\\x\\config.json', 'C:\\x', () => loose)).toEqual({
      verdict: { ok: false, checked: true, problem: 'untrusted-allow' },
      userSid: USER,
    })
  })
})

describe('目录配方判定（写序 ⓪ 的 qiyu 目录档）', () => {
  const FA = 0x1f01ff
  const base = (aces: AceSnapshot[], opts: Partial<AclSnapshot> = {}): AclSnapshot => ({
    sddl: 'D:PAI', daclProtected: true, ownerSid: USER, aces, ...opts,
  })

  it('受保护、属主自己、只授自己 FA → ok（FA 覆盖七项必需位）', () => {
    expect(evaluateDirectoryAcl(base([ace('Allow', USER, FA)]), USER)).toEqual({ ok: true })
  })

  it('少一项必需位（缺 SYNCHRONIZE）→ dir-recipe-mismatch', () => {
    expect(evaluateDirectoryAcl(base([ace('Allow', USER, FA & ~0x100000)]), USER)).toEqual({
      ok: false, problem: 'dir-recipe-mismatch',
    })
  })

  it('把允许 ACE 授给 SYSTEM → untrusted-allow（目录档只认当前用户）', () => {
    expect(evaluateDirectoryAcl(base([ace('Allow', SYSTEM, FA)]), USER)).toEqual({ ok: false, problem: 'untrusted-allow' })
  })

  it('属主不是当前用户 / 继承未关闭 / 空 DACL → 各自成因', () => {
    expect(evaluateDirectoryAcl(base([ace('Allow', USER, FA)], { ownerSid: 'S-1-5-21-9-9' }), USER)).toEqual({ ok: false, problem: 'untrusted-owner' })
    expect(evaluateDirectoryAcl(base([ace('Allow', USER, FA)], { daclProtected: false }), USER)).toEqual({ ok: false, problem: 'dacl-inherited' })
    expect(evaluateDirectoryAcl(base([]), USER)).toEqual({ ok: false, problem: 'dacl-empty' })
  })

  it('INHERIT_ONLY 的允许 ACE 不计入配方（继承来的 ACE 不能冒认）', () => {
    expect(evaluateDirectoryAcl(base([ace('Allow', USER, FA, { inheritOnly: true })]), USER)).toEqual({
      ok: false, problem: 'dir-recipe-mismatch',
    })
  })
})

describe('isAclProblem：运行期成员清单（唯一出处）', () => {
  it('ACL 成因在内；写序的路径/IO 成因不在内', () => {
    expect(isAclProblem('parent-writable')).toBe(true)
    expect(isAclProblem('dir-recipe-mismatch')).toBe(true)
    expect(isAclProblem('probe-failed')).toBe(true)
    for (const p of ['parent-open-failed', 'parent-create-failed', 'dir-open-failed', 'already-exists', 'not-done']) {
      expect(isAclProblem(p), p).toBe(false)
    }
  })
})

describe('读面：Codex 65 判据（禁用组 / 父目录 INHERIT_ONLY）', () => {
  it('deny 命中被禁用且非 deny-only 的组不算拒绝（既不授予也不拒绝）', () => {
    const disabledAdmins: TokenSnapshot = { userSid: USER, groups: [{ sid: ADMINS, attr: 0 }], restrictedSids: [] }
    const file = acl([ace('Deny', ADMINS, 0x1), ace('Allow', USER, FULL)])
    expect(evaluateWinAcl(snapshot(file, cleanParent(), disabledAdmins))).toEqual({ ok: true, checked: true })
  })

  it('父目录的 INHERIT_ONLY 写 ACE 不参与目录自身访问检查 → 不误报 parent-writable', () => {
    const parent = acl([
      ace('Allow', OTHER_USER, FILE_ADD_FILE, { inheritOnly: true }),
      ace('Allow', USER, FULL),
    ])
    expect(evaluateWinAcl(snapshot(acl([ace('Allow', USER, FULL)]), parent))).toEqual({ ok: true, checked: true })
  })
})

describe('CodeRabbit 17：读面补漏', () => {
  it('父目录 null DACL（SDDL 无 D: 段）不能当成「没人有写权限」', () => {
    const parent = acl([], { sddl: 'O:' + USER })
    const v = evaluateWinAcl(snapshot(acl([ace('Allow', USER, FULL)]), parent))
    expect(v).toEqual({ ok: false, checked: true, problem: 'parent-dacl-missing' })
  })

  it('目录配方按 ACE 顺序求有效权利：deny DELETE 在 allow 前 → 不合格', () => {
    const FA = 0x1f01ff
    const bad = acl([
      ace('Deny', USER, 0x10000),
      ace('Allow', USER, FA),
    ], { sddl: 'D:P' })
    expect(evaluateDirectoryAcl(bad, USER)).toEqual({ ok: false, problem: 'dir-recipe-mismatch' })
  })

  it('allow 在前、deny 只覆盖已授予权利 → 仍合格（RemainingAccess 只减不增）', () => {
    const FA = 0x1f01ff
    const okDir = acl([
      ace('Allow', USER, FA),
      ace('Deny', USER, 0x10000),
    ], { sddl: 'D:P' })
    expect(evaluateDirectoryAcl(okDir, USER)).toEqual({ ok: true })
  })

  it('SDDL 里出现条件/对象 ACE 标记 → 判不了（.NET 的 Access 投影可能丢类型）', () => {
    const file = acl([ace('Allow', USER, FULL)], { sddl: 'D:P(XA;;0x120089;;;S-1-1-0;(Member_of{SID(S-1-5-32-544)}))' })
    const za = acl([ace('Allow', USER, FULL)], { sddl: 'D:P(ZA;;0x120089;;;S-1-1-0)' })
    expect(evaluateWinAcl(snapshot(za, cleanParent()))).toEqual({ ok: false, checked: false, problem: 'unsupported-ace' })
    const v = evaluateWinAcl(snapshot(file, cleanParent()))
    expect(v).toEqual({ ok: false, checked: false, problem: 'unsupported-ace' })
  })
})


describe('Codex CR17 复查：组 deny 与父目录成因语境', () => {
  it('目录 deny 命中令牌里的组（Everyone/Users）→ 有效权利不足，dir-recipe-mismatch', () => {
    const FA = 0x1f01ff
    const USERS = 'S-1-5-32-545'
    const a = acl([
      ace('Deny', USERS, 0x10000),
      ace('Allow', USER, FA),
    ], { sddl: 'D:P' })
    const tok: TokenSnapshot = { userSid: USER, groups: [{ sid: USERS, attr: 0xf }], restrictedSids: [] }
    expect(evaluateDirectoryAcl(a, USER, tok)).toEqual({ ok: false, problem: 'dir-recipe-mismatch' })
  })

  it('父目录条件 ACE → parent-unsupported-ace 且 checked=false（判不了）', () => {
    const parent = acl([ace('Allow', USER, FULL)], { sddl: 'D:AI(XA;;0x120089;;;S-1-1-0;(Member_of{SID(S-1-5-32-544)}))' })
    const v = evaluateWinAcl(snapshot(acl([ace('Allow', USER, FULL)]), parent))
    expect(v).toEqual({ ok: false, checked: false, problem: 'parent-unsupported-ace' })
  })
})
