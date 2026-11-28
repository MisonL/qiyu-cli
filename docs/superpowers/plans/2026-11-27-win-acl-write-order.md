# Windows 凭证写序（0.2.4 切片 2）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `auth login` 在 Windows 上的写配置从「普通写 + chmod 不映射 NTFS」改为设计稿 §2.4a 的写序 ⓪–⑥：script 生成的 secret 只经过一个受限 SD 创建、由我方独占持有、并在该句柄上收紧过 DACL 的 tmp 文件，换入后逐条复核。

**Architecture:** 句柄不能跨进程传给 Node，所以整个写序跑在**一个 PowerShell 进程**里：Node 用 `-EncodedCommand` 启动它，secret 经 **stdin** 传入（绝不出现在命令行参数/进程列表里），PowerShell 以 UTF-8 JSON 从 stdout 回一条结果记录；Node 只做决策（用已有的读写入口）与错误渲染。Python 不在依赖表里，`CreateFileW`/`SetSecurityInfo`/`CreateDirectoryW`/`MoveFileExW` 全部 P/Invoke。

**Tech Stack:** Node 20.12+ / TypeScript（ESM）、`node:child_process`、PowerShell 5.1（Windows 随附）；测试 vitest（`--maxWorkers=1`）。

**Spec:** `docs/superpowers/specs/2026-11-22-剩余功能域对接封装-design.md` §2.4 / §2.4a（写序 ⓪–⑥ 与清单 `W1`）/ §2.4c。规格是权威，本计划是它的论证。

## Global Constraints

- 随包分发的 `.ps1`/内嵌脚本**纯 ASCII**（PowerShell 5 按 ANSI 解码无 BOM UTF-8，中文注释会吞行——真机实测）。
- secret 只经 stdin 或已持有的文件句柄；**不得**出现在命令行、环境变量、日志、结果记录里；错误报文只回路径、身份/ACL 状态，**不断言内容**。
- 一切失败一律「写前失败或写入 0 / 已写入但身份核不了」按规格分支如实报告，**不删除、不移动**任何对象（统一规则）。
- 受限 SD 配方：文件取规格 §2.4a ④ 的 `Read|Write|Delete → 0x13019f` 位集，写成 `D:P(A;;0x13019f;;;<当前用户 SID>)`；目录 `D:P(A;;FA;;;<当前用户 SID>)`（规格「目录的 SD 要单独给」段）。
- 「SDDL 逐字相等」比较前必须剥掉 ACL 级 `AI` 标志（真机读回带 `PAI`）。
- 每个任务结束：`npx tsc --noEmit` 0、`npx vitest run <相关文件> --maxWorkers=1` 绿、真实入口真机跑过（Task 2 起）。
- 提交署名 `MisonL <35633790+MisonL@users.noreply.github.com>` + `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`。

## Review Focus

1. **交错臂**：持有祖先句柄期间换树（13(f)）——必须写前失败或不宣称防护。
2. **既有宽松 ACL 目录的复用**（复用档）：仍宽松时必须拒绝静默复用并给出「重建或显式接受」。
3. **`configured:true` 的诚实性**：任何「写入发生但复核不了」的分支都不得报 `configured:true`。
4. **secret 泄漏面**：进程列表、报错、temp 残留、crash 中间态。
5. **POSIX 零变化**：Windows 写序不得改动 `writeConfigFile` 在 POSIX 上的行为。

---

### Task 1: secret 通道与脚本调用骨架（无副作用）

**Files:**
- Create: `src/core/win-acl-write.ts`
- Create: `tests/core/win-acl-write.test.ts`

**Interfaces:**
- Produces:
  - `interface WriteScriptResult { ok: boolean; stage: Stage; problem?: string; path?: string; sddlReadback?: string }`
  - `type Stage = 'probe' | 'create-tmp' | 'verify-tmp' | 'write-secret' | 'close' | 'check-reparse' | 'replace' | 'verify-target' | 'done'`
  - `function renderWriteScript(plan: WritePlan): string` —— 纯函数，返回**纯 ASCII** 的 PowerShell 源码。
  - `interface WritePlan { configPath: string; parentDir: string; secret: 'stdin'; selfSid?: string }`
  - `function buildWritePayload(configJson: string, secretText: string): { config: string; secret: string }` —— 序列化（不打印）。
  - `function runWriteScript(script: string, configPath: string, parentDir: string, payload: { config: string; secret: string }, run?: Runner): WriteScriptResult`
  - `type Runner = (args: { script: string; env: Record<string, string>; stdin: string; timeoutMs: number }) => { status: number; stdout: string; stderr: string }`

- [ ] **Step 1: 写失败用例** —— `renderWriteScript` 输出必须全部为 ASCII（`/^[\x00-\x7F]*$/`）；`runWriteScript` 在 `Runner` 抛错/非 0/非 JSON 时返回 `{ ok:false, stage:'probe', problem:'script-failed' }`。
- [ ] **Step 2: 跑测试确认失败**（模块不存在）。
- [ ] **Step 3: 实现**：`runWriteScript` 用 `spawnSync('powershell.exe', ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand', utf16le→base64], {input: JSON.stringify(payload), encoding:'utf8', timeout})`；stdout 只取**最后一行**解析 JSON（PowerShell 的 progress/CLIXML 噪声在 stdout 前面出现，真机实测）。
- [ ] **Step 4: 跑测试确认通过**，`tsc` 0。
- [ ] **Step 5: 提交** `feat(win-acl): 写序脚本通道骨架（stdin 传 secret、结果 JSON 回传）`

---

### Task 2: 受限 SD 原子创建 tmp（①，与独占持有一体）

**Files:** Modify `src/core/win-acl-write.ts`；Test `tests/core/win-acl-write.test.ts`；真机脚本 `private/evidence/` 下不重复，直接经 ssh 跑。

- [ ] **Step 1: 真机探针先跑**（不写产品代码）：验证 `CreateFileW`(tmp, `GENERIC_READ|GENERIC_WRITE|WRITE_DAC|DELETE`, `FILE_SHARE_READ`, `CREATE_NEW`, SA=受限 SD) 成功、读回剥 `AI` 后逐字相等、二次创建报 **80**。真机结果已有一档（见 HANDOFF「切片 2 前置机制验证」），这里补「share 只有 READ 时别人 `OPEN_EXISTING` 能开但 `DELETE`/改名被挡」一臂。
- [ ] **Step 2: 写测试**：脚本中 CREATE_NEW 报 80 → 结果 `{ok:false, stage:'create-tmp', problem:'already-exists'}`（Node 侧把错误码映射成稳定字符串，不把原始码抛给用户）。
- [ ] **Step 3: 实现脚本的 ① 段**。
- [ ] **Step 4: 真机跑 `auth login` 前的最小脚本**（临时目录，哨兵 secret）核对。
- [ ] **Step 5: 提交**。

### Task 3: 同一句柄上的 ③④（判 DACL、写入 secret、读回七条 + `W1`）

- 判据复用 `src/core/win-acl.ts` 的纯函数：**不在 PowerShell 里重写一份判据**——脚本只回 SDDL 与令牌节点（已由 `probeWinAcl` 覆盖），Node 决策；需要时把 `evaluateAcl` 拆出可对「刚创建的 tmp」调用的导出。
- 写 secret 经同一句柄 `WriteFile`；写后再按路径读回与句柄身份比对（⑥ 前的身份门）。
- [ ] 测试：DACL 不合格 → 不写 secret（结果 `stage:'verify-tmp'`，且产物不含 secret）；写入后读回不一致 → `stage:'write-secret'`。
- [ ] 提交。

### Task 4: ⑥ 关闭 → 重解析点检查 → `MoveFileExW` 换入（含同卷 `REPLACE_EXISTING`）→ 换入后复核

- [ ] 测试：目标路径是 junction（真机夹具）→ `stage:'check-reparse'` 失败且不换名；换入成功后读回目标 SDDL 与 tmp 收紧 SDDL 一致。
- [ ] 提交。

### Task 5: ⓪ 目录绑定（持有 `qiyu` 句柄 + 三步父目录绑定 + 首次登录逐级创建）

- 首次登录（`qiyu` 不存在）：创建前先判第一个已存在祖先受信 → 持有其句柄 → 逐级 `CreateDirectoryW`+受限 SD → 每级按路径打开（`FILE_OPEN_REPARSE_POINT`）→ 父身份核验。
- [ ] 测试：`qiyu` 已存在且受信 → 走相对打开；父目录写面不合格 → `stage:'probe'`（写前失败，写入 0）。
- [ ] 真机夹具：复用档（宽松 ACL 目录）→ 必须拒绝静默复用。

### Task 6: 接入 `auth login`（Windows 分支）与错误渲染

- `writeConfigFile` 在 win32 改走写序；失败按 stage 渲染 `config_insecure`（复用 `describeAclProblem` 与 `aclFixCommand`），绝不报 `configured:true`。
- [ ] 测试：注入脚本结果矩阵 → 每个 stage 的退出码/kind/hint 断言；POSIX 路径逐字节不变（现有用例全绿）。
- [ ] 提交。

### Task 7: 全量 + 真机端到端 + CI

- [ ] 四片全量（`--maxWorkers=1 --no-file-parallelism`）；真机 `auth login` 全链（哨兵凭证、隔离 HOME）；最小 windows-latest job（跑 win-acl 纯函数 + 真机可跑的集成子集）。
