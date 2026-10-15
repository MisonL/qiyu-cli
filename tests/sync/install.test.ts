// tests/sync/install.test.ts —— D-T14：调度条目生成的单元测试（纯函数，无库无网络）。
// 平台条目：darwin=launchd plist / linux=systemd unit+timer（crontab 兜底在 notes）/
// win32=schtasks 命令行。平台检测与命令执行在命令层注入（__setPlatform/__setRun），
// 本文件直接以显式 platform 参数测 planInstall/planUninstall。
import { describe, it, expect } from 'vitest'
import { parseCron, planInstall, planUninstall } from '../../src/schedule/install.js'

const EXEC = ['/usr/local/bin/node', '/opt/qiyu/cli.js']
const HOME = '/home/tester'

describe('parseCron', () => {
  it('*/30 * * * *：步进展开 minute=[0,30]，其余字段通配', () => {
    const c = parseCron('*/30 * * * *')
    expect(c.minute).toEqual({ values: [0, 30], wildcard: false })
    expect(c.hour).toEqual({ values: expect.any(Array), wildcard: true })
    expect(c.day.wildcard).toBe(true)
    expect(c.month.wildcard).toBe(true)
    expect(c.weekday.wildcard).toBe(true)
  })
  it('0 2 * * *：固定分时', () => {
    const c = parseCron('0 2 * * *')
    expect(c.minute.values).toEqual([0])
    expect(c.hour.values).toEqual([2])
    expect(c.minute.wildcard).toBe(false)
  })
  it('0 9 * * 1-5：范围展开与周日为 0', () => {
    const c = parseCron('0 9 * * 1-5')
    expect(c.weekday.values).toEqual([1, 2, 3, 4, 5])
  })
  it('列表与范围混合：0,15-17 → [0,15,16,17]；7 归一为周日 0', () => {
    const c = parseCron('0,15-17 1 * * 7')
    expect(c.minute.values).toEqual([0, 15, 16, 17])
    expect(c.weekday.values).toEqual([0])
  })
  it('*/1 归一为通配（全值域 = 通配的语义等价，输出不该展开成 60 个值）', () => {
    const c = parseCron('*/1 * * * *')
    expect(c.minute.wildcard).toBe(true)
  })
  it('非法表达式显式抛错（字段数不足/越界/坏步进/逆序范围）', () => {
    expect(() => parseCron('*/30 * * *')).toThrow(/5 段/)
    expect(() => parseCron('60 * * * *')).toThrow(/minute/)
    expect(() => parseCron('* 25 * * *')).toThrow(/hour/)
    expect(() => parseCron('* * 0 * *')).toThrow(/day/)
    expect(() => parseCron('* * * 13 *')).toThrow(/month/)
    expect(() => parseCron('* * * * 8')).toThrow(/weekday/)
    expect(() => parseCron('x * * * *')).toThrow(/minute/)
    expect(() => parseCron('5/10 * * * *')).toThrow(/minute/)
    expect(() => parseCron('10-5 * * * *')).toThrow(/minute/)
    expect(() => parseCron('*/0 * * * *')).toThrow(/minute/)
  })
})

describe('planInstall darwin —— launchd plist', () => {
  it('生成 plist 到 ~/Library/LaunchAgents/，含 Label/ProgramArguments/StartCalendarInterval/日志路径', () => {
    const p = planInstall('darwin', '*/30 * * * *', { home: HOME, exec: EXEC })
    expect(p.entries.length).toBe(1)
    const e = p.entries[0]!
    expect(e.path).toBe('/home/tester/Library/LaunchAgents/com.qiyu-cli.sync.plist')
    expect(e.content).toMatch(/<key>Label<\/key><string>com\.qiyu-cli\.sync<\/string>/)
    expect(e.content).toMatch(/<string>\/usr\/local\/bin\/node<\/string>/)
    expect(e.content).toMatch(/<string>\/opt\/qiyu\/cli\.js<\/string>/)
    expect(e.content).toMatch(/<string>sync<\/string><string>run<\/string>/)
    expect(e.content).toMatch(/<key>StartCalendarInterval<\/key>/)
    expect(e.content).toMatch(/<key>Minute<\/key><array><integer>0<\/integer><integer>30<\/integer><\/array>/)
    expect(e.content).toMatch(/<key>StandardOutPath<\/key>/)
    // 通配字段不进 StartCalendarInterval（Hour 通配 → 无 Hour 键）
    expect(e.content).not.toMatch(/<key>Hour<\/key>/)
    // 安装命令：launchctl load（提示性质，dry-run 不执行）
    expect(p.commands).toContainEqual(['launchctl', 'load', e.path])
  })
  it('0 2 * * *：单 dict 固定 Minute/Hour', () => {
    const p = planInstall('darwin', '0 2 * * *', { home: HOME, exec: EXEC })
    expect(p.entries[0]!.content).toMatch(/<key>Minute<\/key><integer>0<\/integer>/)
    expect(p.entries[0]!.content).toMatch(/<key>Hour<\/key><integer>2<\/integer>/)
  })
  it('day 与 weekday 同时受限 → array of two dicts（cron 的 OR 语义）', () => {
    const p = planInstall('darwin', '0 9 1 * 1', { home: HOME, exec: EXEC })
    const c = p.entries[0]!.content
    expect(c).toMatch(/<key>StartCalendarInterval<\/key><array>/)
    expect(c).toMatch(/<key>Day<\/key><integer>1<\/integer>/)
    expect(c).toMatch(/<key>Weekday<\/key><integer>2<\/integer>/)   // cron 1(周一) → launchd 2
  })
  it('exec 路径含 XML 特殊字符时转义', () => {
    const p = planInstall('darwin', '0 2 * * *', { home: HOME, exec: ['/usr/local/bin/node&', '/a<b>.js'] })
    const c = p.entries[0]!.content
    expect(c).toMatch(/&amp;/)
    expect(c).toMatch(/&lt;b&gt;/)
  })
  it('Day/Hour/Month/Weekday 的多值字段 → 键内数组（launchd 键内 OR；静默丢值 = 装错时刻）', () => {
    const p = planInstall('darwin', '0 9 1,15 * 1,5', { home: HOME, exec: EXEC })
    const c = p.entries[0]!.content
    expect(c).toMatch(/<key>Day<\/key><array><integer>1<\/integer><integer>15<\/integer><\/array>/)
    expect(c).toMatch(/<key>Hour<\/key><integer>9<\/integer>/)
    expect(c).toMatch(/<key>Weekday<\/key><array><integer>2<\/integer><integer>6<\/integer><\/array>/)
  })
})

describe('planInstall linux —— systemd unit + timer（crontab 兜底在 notes）', () => {
  it('生成 service + timer 到 ~/.config/systemd/user/，OnCalendar 由 cron 换算', () => {
    const p = planInstall('linux', '*/30 * * * *', { home: HOME, exec: EXEC })
    expect(p.entries.length).toBe(2)
    const svc = p.entries.find((e) => e.path.endsWith('qiyu-sync.service'))!
    const timer = p.entries.find((e) => e.path.endsWith('qiyu-sync.timer'))!
    expect(svc.path).toBe('/home/tester/.config/systemd/user/qiyu-sync.service')
    expect(svc.content).toMatch(/\[Unit\]/)
    expect(svc.content).toMatch(/Type=oneshot/)
    expect(svc.content).toMatch(/ExecStart=\/usr\/local\/bin\/node \/opt\/qiyu\/cli\.js sync run/)
    expect(timer.content).toMatch(/OnCalendar=\*-\*-\* \*:00,30:00/)
    expect(timer.content).toMatch(/Persistent=true/)
    expect(timer.content).toMatch(/WantedBy=timers\.target/)
    // 安装命令：daemon-reload + enable --now
    expect(p.commands).toContainEqual(['systemctl', '--user', 'daemon-reload'])
    expect(p.commands).toContainEqual(['systemctl', '--user', 'enable', '--now', 'qiyu-sync.timer'])
    // crontab 兜底行（无 systemd 的机器手工可用）
    expect(p.notes.some((n) => n.includes('crontab') && n.includes('*/30 * * * *'))).toBe(true)
  })
  it('固定时刻：0 2 * * * → OnCalendar=*-*-* 02:00:00', () => {
    const p = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC })
    const timer = p.entries.find((e) => e.path.endsWith('qiyu-sync.timer'))!
    expect(timer.content).toMatch(/OnCalendar=\*-\*-\* 02:00:00/)
  })
  it('day 与 weekday 同时受限 → 两条 OnCalendar（systemd 单行是 AND，多行是 OR）', () => {
    const p = planInstall('linux', '0 9 1 * 1', { home: HOME, exec: EXEC })
    const timer = p.entries.find((e) => e.path.endsWith('qiyu-sync.timer'))!
    expect(timer.content).toMatch(/OnCalendar=Mon \*-\*-\* 09:00:00/)
    expect(timer.content).toMatch(/OnCalendar=\*-\*-01 09:00:00/)
  })
})

describe('planInstall win32 —— schtasks 命令行', () => {
  it('*/30 * * * * → /SC MINUTE /MO 30；无文件条目', () => {
    const p = planInstall('win32', '*/30 * * * *', { home: HOME, exec: EXEC })
    expect(p.entries).toEqual([])
    const cmd = p.commands[0]!
    expect(cmd[0]).toBe('schtasks')
    expect(cmd).toContain('/SC')
    expect(cmd.indexOf('/MO')).toBeGreaterThan(-1)
    expect(cmd[cmd.indexOf('/MO') + 1]).toBe('30')
    expect(cmd).toContain('/Create')
    expect(cmd.join(' ')).toMatch(/sync run/)
  })
  it('0 2 * * * → /SC DAILY /ST 02:00', () => {
    const cmd = planInstall('win32', '0 2 * * *', { home: HOME, exec: EXEC }).commands[0]!
    expect(cmd[cmd.indexOf('/SC') + 1]).toBe('DAILY')
    expect(cmd[cmd.indexOf('/ST') + 1]).toBe('02:00')
  })
  it('0 9 * * 1,3,5 → /SC WEEKLY /D MON,WED,FRI /ST 09:00', () => {
    const cmd = planInstall('win32', '0 9 * * 1,3,5', { home: HOME, exec: EXEC }).commands[0]!
    expect(cmd[cmd.indexOf('/SC') + 1]).toBe('WEEKLY')
    expect(cmd[cmd.indexOf('/D') + 1]).toBe('MON,WED,FRI')
    expect(cmd[cmd.indexOf('/ST') + 1]).toBe('09:00')
  })
  it('* * * * * → /SC MINUTE /MO 1', () => {
    const cmd = planInstall('win32', '* * * * *', { home: HOME, exec: EXEC }).commands[0]!
    expect(cmd[cmd.indexOf('/SC') + 1]).toBe('MINUTE')
    expect(cmd[cmd.indexOf('/MO') + 1]).toBe('1')
  })
  it('无法映射的 cron 显式抛错（不静默装错计划）', () => {
    // 两个小时点 + 两个分钟点 → schtasks 无对应形态
    expect(() => planInstall('win32', '0,30 2,4 * * *', { home: HOME, exec: EXEC }))
      .toThrow(/schtasks/)
  })
})

describe('planUninstall', () => {
  it('darwin：移除 plist + launchctl unload', () => {
    const p = planUninstall('darwin', { home: HOME })
    expect(p.remove.map((r) => r.path)).toEqual(['/home/tester/Library/LaunchAgents/com.qiyu-cli.sync.plist'])
    expect(p.commands).toContainEqual(['launchctl', 'unload', '/home/tester/Library/LaunchAgents/com.qiyu-cli.sync.plist'])
  })
  it('linux：移除 service+timer + systemctl disable', () => {
    const p = planUninstall('linux', { home: HOME })
    expect(p.remove.map((r) => r.path).sort()).toEqual([
      '/home/tester/.config/systemd/user/qiyu-sync.service',
      '/home/tester/.config/systemd/user/qiyu-sync.timer',
    ].sort())
    expect(p.commands).toContainEqual(['systemctl', '--user', 'disable', '--now', 'qiyu-sync.timer'])
  })
  it('win32：schtasks /Delete（无文件条目）', () => {
    const p = planUninstall('win32', { home: HOME })
    expect(p.remove).toEqual([])
    const cmd = p.commands[0]!
    expect(cmd).toContain('/Delete')
    expect(cmd).toContain('qiyu-cli-sync')
  })
})
