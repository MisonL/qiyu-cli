// src/schedule/install.ts —— D-T14：系统调度条目生成（spec §7.6 / 设计稿 §7.6）。
// 平台条目：darwin=launchd plist / linux=systemd unit+timer（crontab 兜底行在 notes）/
// win32=schtasks 命令行。**平台检测与外部命令执行是注入点**（__setPlatform/__setRun，
// 沿 reports.ts __setSleep 的测试注入惯例）——命令层永远经 currentPlatform()/
// runScheduleCommand() 取用，不直接触 process.platform / child_process。
//
// cron 换算的三条诚实性约束：
//   ① 解析不出的 cron 显式抛 usage（绝不静默装一个错误时刻的计划）；
//   ② cron 的「日 + 周」同时受限是 OR 语义 —— launchd 用 array of dicts、
//      systemd 用两条 OnCalendar 表达（单 dict/单行是 AND，会静默收窄触发面）；
//   ③ win32 的 schtasks 只能表达一个子集（每 N 分 / 每 N 时 / 每日 / 每周 / 每月），
//      子集外显式失败并指引手工创建。
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

export type Platform = 'darwin' | 'linux' | 'win32'

/** 平台检测的显式失败形态（usage）：未知平台不猜测、不静默回退。 */
export function detectPlatform(): Platform {
  const p = process.platform
  if (p === 'darwin' || p === 'linux' || p === 'win32') return p
  throw usageError(`当前平台（${p}）不支持 sync install/uninstall：支持 darwin / linux / win32`)
}

// —— 测试注入点（reports.ts __setSleep 同族惯例）——
type PlatformFn = () => Platform
type RunFn = (argv: string[]) => void

const defaultRun: RunFn = (argv) => {
  // 子进程 stdout 不透传（调度器命令的输出对 Agent 无价值）；stderr 保留便于排障。
  execFileSync(argv[0]!, argv.slice(1), { stdio: ['ignore', 'ignore', 'inherit'] })
}

let platformFn: PlatformFn = detectPlatform
let runFn: RunFn = defaultRun

/** 仅测试用：替换平台检测（命令层经 currentPlatform() 间接取用）。 */
export function __setPlatform(fn: PlatformFn): void { platformFn = fn }
/** 仅测试用：替换外部命令执行（默认 execFileSync）。 */
export function __setRun(fn: RunFn): void { runFn = fn }
export function __resetScheduleDeps(): void { platformFn = detectPlatform; runFn = defaultRun }

export function currentPlatform(): Platform { return platformFn() }
export function runScheduleCommand(argv: string[]): void { runFn(argv) }

function usageError(msg: string): Error {
  const e = new Error(msg)
  ;(e as { kind?: string }).kind = 'usage'
  return e
}

// —— cron 解析（5 段；支持 * / a / a-b / a-b/k / */k / 逗号列表；数字不含名称）——

export interface CronField { values: number[]; wildcard: boolean }
export interface CronSpec {
  minute: CronField; hour: CronField; day: CronField; month: CronField; weekday: CronField
}

interface FieldDef { name: string; min: number; max: number }

const FIELDS: FieldDef[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  // cron 的周字段：0=周日；7 亦是周日（归一到 0）
  { name: 'weekday', min: 0, max: 6 },
]

const WILDCARD = (min: number, max: number): CronField =>
  ({ values: fullRange(min, max), wildcard: true })

function fullRange(min: number, max: number): number[] {
  const out: number[] = []
  for (let i = min; i <= max; i++) out.push(i)
  return out
}

function parseField(src: string, def: FieldDef): CronField {
  const values = new Set<number>()
  for (const item of src.split(',')) {
    if (item === '*') return WILDCARD(def.min, def.max)
    let m = /^\*\/(\d+)$/.exec(item)
    if (m) {
      const step = Number(m[1])
      if (step < 1) throw usageError(`无法解析的 cron 字段（${def.name}）：步进必须 ≥ 1（${item}）`)
      for (let v = def.min; v <= def.max; v += step) values.add(v)
      continue
    }
    m = /^(\d+)-(\d+)(?:\/(\d+))?$/.exec(item)
    if (m) {
      const a = Number(m[1]); const b = Number(m[2]); const step = m[3] === undefined ? 1 : Number(m[3])
      if (step < 1) throw usageError(`无法解析的 cron 字段（${def.name}）：步进必须 ≥ 1（${item}）`)
      if (a > b) throw usageError(`无法解析的 cron 字段（${def.name}）：范围逆序（${item}）`)
      if (a < def.min || b > def.max) {
        throw usageError(`无法解析的 cron 字段（${def.name}）：${item} 超出 ${def.min}-${def.max}（weekday 的 7 表示周日，请写 0）`)
      }
      for (let v = a; v <= b; v += step) values.add(v)
      continue
    }
    if (/^\d+$/.test(item)) {
      const v = Number(item)
      // weekday 允许 7（周日）并归一到 0 —— 常见书写习惯
      const norm = def.name === 'weekday' && v === 7 ? 0 : v
      if (norm < def.min || norm > def.max) {
        throw usageError(`无法解析的 cron 字段（${def.name}）：${item} 超出 ${def.min}-${def.max}（weekday 的 7 表示周日，请写 0）`)
      }
      values.add(norm)
      continue
    }
    throw usageError(`无法解析的 cron 字段（${def.name}）：${item}（支持 * / 数字 / a-b / a-b/k / */k / 逗号列表；不支持月份与星期名称）`)
  }
  const sorted = [...values].sort((a, b) => a - b)
  // 全值域 = 通配（语义等价，输出不展开成 60 个值）
  const wildcard = sorted.length === def.max - def.min + 1
  return { values: sorted, wildcard }
}

/** 解析 5 段 cron；解析失败抛 usage（契约诚实性：绝不静默装错时刻的计划）。 */
export function parseCron(expr: string): CronSpec {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) {
    throw usageError(`无法解析的 cron 表达式：必须是 5 段（分 时 日 月 周），实际 ${parts.length} 段：${expr}`)
  }
  const [minute, hour, day, month, weekday] = parts.map((p, i) => parseField(p, FIELDS[i]!))
  return { minute: minute!, hour: hour!, day: day!, month: month!, weekday: weekday! }
}

const WEEKDAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

const pad2 = (n: number): string => String(n).padStart(2, '0')
const pad2List = (f: CronField): string => f.values.map(pad2).join(',')

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function shellQuote(s: string): string {
  return /[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s
}

// —— 条目生成 ——

export interface InstallEntry { path: string; content: string }
export interface InstallPlan {
  platform: Platform
  schedule: string
  /** 要写入的文件条目（win32 为空：schtasks 的载体就是命令本身）。 */
  entries: InstallEntry[]
  /** 安装后要执行的命令（argv 形态；--yes 时执行，dry-run 仅列出）。 */
  commands: string[][]
  /** 人读备注（crontab 兜底行、平台注意事项）。 */
  notes: string[]
}

export interface UninstallPlan {
  platform: Platform
  remove: Array<{ path: string; exists: boolean }>
  commands: string[][]
  notes: string[]
}

export const LAUNCHD_LABEL = 'com.qiyu-cli.sync'
export const SYSTEMD_NAMES = { service: 'qiyu-sync.service', timer: 'qiyu-sync.timer' } as const
export const SCHTASKS_TASK_NAME = 'qiyu-cli-sync'

/** 调度条目要运行的命令（sync run）。 */
function runArgs(exec: string[]): string[] {
  return [...exec, 'sync', 'run']
}

/** launchd 单键的 XML：单值 <integer>，多值 <array>。 */
function launchdKey(key: string, f: CronField): string {
  const value = f.values.length === 1
    ? `<integer>${f.values[0]}</integer>`
    : `<array>${f.values.map((v) => `<integer>${v}</integer>`).join('')}</array>`
  return `<key>${key}</key>${value}`
}

function launchdCalendarXml(spec: CronSpec): string {
  const base = (extra: string): string => {
    let inner = ''
    if (!spec.minute.wildcard) inner += launchdKey('Minute', spec.minute)
    if (!spec.hour.wildcard) inner += launchdKey('Hour', spec.hour)
    if (!spec.month.wildcard) inner += launchdKey('Month', spec.month)
    return `<dict>${inner}${extra}</dict>`
  }
  // ⚠️ launchd 单 dict 内多键是 AND（同键数组是键内 OR）；cron 日+周是 OR ——
  // 同时受限拆成 array of two dicts。月/时/分的键内 OR 与 cron 一致，数组直通。
  const dayR = !spec.day.wildcard
  const wdR = !spec.weekday.wildcard
  const dicts: string[] = []
  if (dayR) dicts.push(base(launchdKey('Day', spec.day)))
  if (wdR) {
    // cron 0=周日 → launchd Weekday 1=周日 … 7=周六；多值 → 键内数组（launchd 键内 OR）
    const wd: CronField = { values: spec.weekday.values.map((v) => v + 1), wildcard: false }
    dicts.push(base(launchdKey('Weekday', wd)))
  }
  if (dicts.length === 0) return base('')
  if (dicts.length === 1) return dicts[0]!
  return `<array>${dicts.join('')}</array>`
}

function systemdOnCalendar(spec: CronSpec): string[] {
  const dow = spec.weekday.wildcard
    ? null
    : spec.weekday.values.map((n) => WEEKDAY_NAMES[n]!).join(',')
  const month = spec.month.wildcard ? '*' : pad2List(spec.month)
  const hour = spec.hour.wildcard ? '*' : pad2List(spec.hour)
  const minute = spec.minute.wildcard ? '*' : pad2List(spec.minute)
  const time = `${hour}:${minute}:00`
  const dateOf = (day: CronField): string => `*-${month}-${day.wildcard ? '*' : pad2List(day)}`
  // ⚠️ systemd 单条 OnCalendar 内 DOW 与日期是 AND；cron 日+周是 OR —— 多行表达 OR。
  const dayR = !spec.day.wildcard
  const wdR = !spec.weekday.wildcard
  if (dayR && wdR) {
    return [`${dow} ${dateOf(WILDCARD(1, 31))} ${time}`, `${dateOf(spec.day)} ${time}`]
  }
  if (wdR) return [`${dow} ${dateOf(spec.day)} ${time}`]
  return [`${dateOf(spec.day)} ${time}`]
}

/** 值列是否为「从 0 起的等差数列」（cron 步进语义，可映射 schtasks /MO）。 */
function progressionStep(values: number[], fullMax: number): number | null {
  if (values.length < 2) return null
  if (values[0] !== 0) return null
  const step = values[1]! - values[0]!
  if (step < 2) return null
  for (let i = 1; i < values.length; i++) {
    if (values[i]! - values[i - 1]! !== step) return null
  }
  // 覆盖到值域末端（*/30 → [0,30] 收尾于 59 语义下不算，cron 步进覆盖 0..max-1）
  if (values[values.length - 1]! + step <= fullMax) return null
  return step
}

/**
 * cron → schtasks 计划形态（子集映射；子集外显式失败）。
 * 支持：每 N 分钟 / 每 N 小时（步进或单值）、每日定时、每周定时、每月定时、全通配（每分钟）。
 */
function schtasksScheduleArgs(spec: CronSpec): string[] {
  const time = `${pad2(spec.hour.values[0]!)}:${pad2(spec.minute.values[0]!)}`
  const dateRestricted = !spec.day.wildcard || !spec.month.wildcard

  if (dateRestricted && !spec.day.wildcard && spec.month.wildcard
    && spec.weekday.wildcard && spec.minute.values.length === 1 && spec.hour.values.length === 1) {
    return ['/SC', 'MONTHLY', '/D', spec.day.values.join(','), '/ST', time]
  }
  if (!spec.weekday.wildcard && spec.day.wildcard && spec.month.wildcard
    && spec.minute.values.length === 1 && spec.hour.values.length === 1) {
    return ['/SC', 'WEEKLY', '/D', spec.weekday.values.map((n) => WEEKDAY_NAMES[n]!.toUpperCase()).join(','), '/ST', time]
  }
  if (spec.day.wildcard && spec.month.wildcard && spec.weekday.wildcard) {
    if (spec.minute.wildcard && spec.hour.wildcard) {
      return ['/SC', 'MINUTE', '/MO', '1']
    }
    if (!spec.minute.wildcard && spec.hour.wildcard) {
      const step = progressionStep(spec.minute.values, 59)
      if (step !== null) return ['/SC', 'MINUTE', '/MO', String(step)]
      throw unmappable()
    }
    if (spec.minute.wildcard && !spec.hour.wildcard) {
      const step = progressionStep(spec.hour.values, 23)
      if (step !== null) return ['/SC', 'HOURLY', '/MO', String(step), '/ST', `00:${pad2(spec.minute.values[0]!)}`]
      throw unmappable()
    }
    if (!spec.minute.wildcard && !spec.hour.wildcard
      && spec.minute.values.length === 1 && spec.hour.values.length === 1) {
      return ['/SC', 'DAILY', '/ST', time]
    }
  }
  throw unmappable()
}

function unmappable(): Error {
  return usageError('无法把该 cron 映射为 schtasks 计划（支持：每 N 分钟 / 每 N 小时 / 每日 / 每周 / 每月的固定时刻）。'
    + '请在 Windows 任务计划程序中手工创建，或换一个可映射的时刻')
}

function crontabLine(schedule: string, exec: string[]): string {
  return `${schedule} ${runArgs(exec).map(shellQuote).join(' ')}`
}

/** 生成安装计划（纯函数，不写 fs）。 */
export function planInstall(platform: Platform, schedule: string,
  opts: { home: string; exec: string[] }): InstallPlan {
  const spec = parseCron(schedule)
  const run = runArgs(opts.exec)

  if (platform === 'darwin') {
    const dir = `${opts.home}/Library/LaunchAgents`
    const path = `${dir}/${LAUNCHD_LABEL}.plist`
    const logsDir = `${opts.home}/Library/Logs`
    const argsXml = run.map((a) => `<string>${xmlEscape(a)}</string>`).join('')
    const content = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>${argsXml}</array>
  <key>StartCalendarInterval</key>${launchdCalendarXml(spec)}
  <key>StandardOutPath</key><string>${xmlEscape(logsDir)}/qiyu-sync.log</string>
  <key>StandardErrorPath</key><string>${xmlEscape(logsDir)}/qiyu-sync.err.log</string>
</dict>
</plist>
`
    return {
      platform, schedule,
      entries: [{ path, content }],
      commands: [['launchctl', 'load', path]],
      notes: ['launchd 在下次登录时自动加载 ~/Library/LaunchAgents/ 下的条目；立即生效请执行上面的 launchctl load 命令。',
        '若已装过旧版本，先 launchctl unload 再覆盖。'],
    }
  }

  if (platform === 'linux') {
    const dir = `${opts.home}/.config/systemd/user`
    const servicePath = `${dir}/${SYSTEMD_NAMES.service}`
    const timerPath = `${dir}/${SYSTEMD_NAMES.timer}`
    const execLine = run.map(shellQuote).join(' ')
    const onCalendar = systemdOnCalendar(spec)
    const service = `[Unit]
Description=七鱼数据同步（qiyu sync run）

[Service]
Type=oneshot
ExecStart=${execLine}
`
    const timer = `[Unit]
Description=七鱼数据同步定时器

[Timer]
${onCalendar.map((c) => `OnCalendar=${c}`).join('\n')}
Persistent=true

[Install]
WantedBy=timers.target
`
    return {
      platform, schedule,
      entries: [
        { path: servicePath, content: service },
        { path: timerPath, content: timer },
      ],
      commands: [
        ['systemctl', '--user', 'daemon-reload'],
        ['systemctl', '--user', 'enable', '--now', SYSTEMD_NAMES.timer],
      ],
      notes: [`crontab 兜底（无 systemd 用户会话时手工可用）：${crontabLine(schedule, opts.exec)}`,
        '安装后需执行上面的 systemctl 命令（daemon-reload + enable --now）定时器才会运行。'],
    }
  }

  // win32：条目就是命令本身
  const cmd = ['schtasks', '/Create', '/TN', SCHTASKS_TASK_NAME,
    '/TR', run.map(shellQuote).join(' '), ...schtasksScheduleArgs(spec), '/F']
  return {
    platform, schedule,
    entries: [],
    commands: [cmd],
    notes: ['Windows 无文件条目：--yes 时直接执行 schtasks 命令；dry-run 仅打印。'],
  }
}

/** 生成卸载计划（读 fs 只为报告条目存在性，dry-run 展示用；exists 可注入）。 */
export function planUninstall(platform: Platform,
  opts: { home: string; exists?: (p: string) => boolean }): UninstallPlan {
  const exists = opts.exists ?? ((p: string) => existsSync(p))

  if (platform === 'darwin') {
    const path = `${opts.home}/Library/LaunchAgents/${LAUNCHD_LABEL}.plist`
    return {
      platform, remove: [{ path, exists: exists(path) }],
      commands: [['launchctl', 'unload', path]],
      notes: ['卸载次序：先 launchctl unload（停止已加载的代理），文件随后删除。'],
    }
  }
  if (platform === 'linux') {
    const dir = `${opts.home}/.config/systemd/user`
    const paths = [`${dir}/${SYSTEMD_NAMES.service}`, `${dir}/${SYSTEMD_NAMES.timer}`]
    return {
      platform, remove: paths.map((path) => ({ path, exists: exists(path) })),
      commands: [
        ['systemctl', '--user', 'disable', '--now', SYSTEMD_NAMES.timer],
        ['systemctl', '--user', 'daemon-reload'],
      ],
      notes: ['卸载次序：先 disable --now（停定时器），再删除 unit 文件并 daemon-reload。'],
    }
  }
  return {
    platform, remove: [],
    commands: [['schtasks', '/Delete', '/TN', SCHTASKS_TASK_NAME, '/F']],
    notes: ['Windows：卸载即执行 schtasks /Delete（--yes 时执行）。'],
  }
}
