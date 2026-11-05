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

  it('分隔符只接受空格与 Tab：CR/LF/异常空白显式拒绝（不得流进逐行产物）', () => {
    // ⚠️ 实测（修前）：`0 0 *\r* *` 被 `\s+` 当分隔符拆成合法 5 段，而 schedule 原文
    // 又原样进了 crontab 兜底行与回显 —— 那一行里的 CR 让 cron 整行失效；
    // `0 0 * * *\n` 则把一条计划劈成两条物理行。判据：拒绝，不静默清洗。
    expect(() => parseCron('0 0 * * *\r')).toThrow(/U\+000D/)
    expect(() => parseCron('0 0 *\r* *')).toThrow(/U\+000D/)
    expect(() => parseCron('0 0 * * *\n')).toThrow(/U\+000A/)
    expect(() => parseCron('0 0 * * * ')).toThrow(/U\+00A0/)
    // 空格与 Tab 仍是合法分隔符（不得误伤）
    expect(() => parseCron('0\t0 * * *')).not.toThrow()
    expect(() => parseCron('0  0 * * *')).not.toThrow()
  })

  it('空/空白表达式：消息把取值渲染成可见形式（此前冒号后空白）', () => {
    // ⚠️ 2026-10-29：`sync install --schedule ''` 此前报「…实际 1 段：」冒号后什么都没有，
    // Agent 看不出「表达式是空串」还是「消息渲染坏了」。describeArgs 把空串渲染成 `''`。
    expect(() => parseCron('')).toThrow(/实际 1 段：''/)
    expect(() => parseCron('   ')).toThrow(/实际 1 段：'   '/)
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
    // ⚠️ launchd 与 cron 同一套 Weekday 编号（0/7=周日、1=周一）——
    // 此前断言「cron 1 → launchd 2」把整体后移一天的错误行为钉住了。
    expect(c).toMatch(/<key>Weekday<\/key><integer>1<\/integer>/)   // cron 1(周一) → launchd 1
  })
  it('exec 路径含 XML 特殊字符时转义', () => {
    const p = planInstall('darwin', '0 2 * * *', { home: HOME, exec: ['/usr/local/bin/node&', '/a<b>.js'] })
    const c = p.entries[0]!.content
    expect(c).toMatch(/&amp;/)
    expect(c).toMatch(/&lt;b&gt;/)
  })
  it('修复批 4 #4：storeArgs 进 ProgramArguments（三平台一致）', () => {
    const storeArgs = ['--db', '/tmp/q.db', '--profile', 'default']
    const darwin = planInstall('darwin', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs })
    const c = darwin.entries[0]!.content
    // 逐参数 <string> 元素（不是拼成一串）——launchd 不做 shell 解析
    expect(c).toMatch(/<string>sync<\/string><string>run<\/string><string>--db<\/string><string>\/tmp\/q\.db<\/string><string>--profile<\/string><string>default<\/string>/)
    const linux = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs })
    const svc = linux.entries.find((e) => e.path.endsWith('qiyu-sync.service'))!
    expect(svc.content).toMatch(/ExecStart=.* sync run --db \/tmp\/q\.db --profile default/)
    expect(linux.notes.some((n) => n.includes('sync run --db /tmp/q.db --profile default'))).toBe(true)
  })
  it('修复批 4 #4：未给存储参数 → 三平台都不追加（不引入默认值漂移）', () => {
    const darwin = planInstall('darwin', '0 2 * * *', { home: HOME, exec: EXEC })
    expect(darwin.entries[0]!.content).toMatch(/<string>sync<\/string><string>run<\/string><\/array>/)
    const linux = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC })
    const svc = linux.entries.find((e) => e.path.endsWith('qiyu-sync.service'))!
    expect(svc.content).toMatch(/ExecStart=.* sync run\n/)
  })
  it('Day/Hour/Month/Weekday 的多值字段 → 键内数组（launchd 键内 OR；静默丢值 = 装错时刻）', () => {
    const p = planInstall('darwin', '0 9 1,15 * 1,5', { home: HOME, exec: EXEC })
    const c = p.entries[0]!.content
    expect(c).toMatch(/<key>Day<\/key><array><integer>1<\/integer><integer>15<\/integer><\/array>/)
    expect(c).toMatch(/<key>Hour<\/key><integer>9<\/integer>/)
    expect(c).toMatch(/<key>Weekday<\/key><array><integer>1<\/integer><integer>5<\/integer><\/array>/)
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
  it('crontab 兜底行按 POSIX shell 方言渲染：含 $() / 空白的路径必须单引号包住', () => {
    // ⚠️ 2026-11-02 审查：该行此前用 install.ts 的 shellQuote（只认空白与 `"`），
    // `--db /tmp/q$(id).db` 会裸着印进这条「手工复制执行」的兜底行 —— cron 用
    // `/bin/sh -c` 跑它，`$(id)` 会被真的当成命令替换。
    const hostile = '/tmp/a b$(id).db'
    const p = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', hostile] })
    const note = p.notes.find((n) => n.includes('crontab'))!
    expect(note).toContain(`--db '${hostile}'`)
    // 反向：安全集内的路径不加多余引号（挡住「一律套引号」的过度修法）
    const benign = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', '/tmp/q.db'] })
    expect(benign.notes.find((n) => n.includes('crontab'))!).toContain('sync run --db /tmp/q.db')
  })

  // ⚠️ 2026-11-02（Sourcery）：cron **在交给 sh 之前**自己处理 `%`（crontab(5) 原文：
  // 「Percent-signs (%), unless escaped with backslash (\), will be changed into newline
  // characters, and all data after the first % will be sent to the command as standard
  // input」）—— 单引号挡不住它，因为这一层替换发生在 sh 之前。实测修前
  // `--db /tmp/a%b.db` 裸着落在兜底行里：照抄执行会跑 `--db /tmp/a`、`b.db` 变 stdin，
  // **静默跑错库**。注意 `%` 也在 `shellArg` 的 POSIX 安全集里，所以这条只有 `\%` 能挡。
  it('crontab 兜底行把 % 转义成 \\%：cron 在 sh 之前就把裸 % 换成换行 + stdin', () => {
    const p = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', '/tmp/a%b.db'] })
    const note = p.notes.find((n) => n.includes('crontab'))!
    expect(note).toContain('--db /tmp/a\\%b.db')
    // 反向：不含 `%` 的值不得被改动（挡住「一律加反斜杠」的过度修法，也钉住
    // 「`%` 就在 shellArg 安全集里、原本是裸的」这一事实）
    const benign = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', '/tmp/q.db'] })
    expect(benign.notes.find((n) => n.includes('crontab'))!).toContain('--db /tmp/q.db')
    expect(benign.notes.find((n) => n.includes('crontab'))!).not.toContain('\\%')
  })

  // ⚠️ 2026-11-02：三个载体里 systemd unit 与 crontab 行都是**逐行格式**，值里的换行会把
  // 一条条目劈成两条 —— crontab 兜底行实测会变成 3 个物理行，中间那行是一条**真的 cron
  // 计划**，以安装者身份执行。系统调度器装出来的东西不该由用户输入决定，所以显式拒绝。
  it('参数含换行/回车 → 三个平台都拒绝安装（逐行格式会被劈成两条条目）', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const) {
      for (const v of ['/tmp/a\n0 0 * * * touch /tmp/x\nb.db', '/tmp/c\rd.db']) {
        expect(() => planInstall(platform, '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', v] }),
          `${platform} 必须拒绝含换行的参数`).toThrow(/不能含换行或回车/)
      }
      // 反向：同一位置放良性值必须照常生成（挡住「一律拒绝 storeArgs」的过度修法）
      expect(planInstall(platform, '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', '/tmp/q.db'] }).commands.length)
        .toBeGreaterThan(0)
    }
  })

  // ⚠️ 2026-11-02：`ExecStart=` **不是 shell**，但 systemd 自己在把 argv 交给程序前做三轮
  // 替换（官方文档原文）：`\` 是 C 转义（systemd.syntax(7)「any backslashes should be
  // doubled」，引号内外都解析）、`%` 是指令说明符（systemd.service(5)）、`$` 会做环境变量
  // 替换（「to pass a literal dollar sign, use "$$"」）。与 crontab 的 `%` 是同一族缺陷的
  // 不同载体 —— 只修 crontab 会漏掉它。含 `\` 的路径在 Windows 上极常见（本轮修的是渲染，
  // 不是平台支持）。
  it('systemd ExecStart 转义字面 % 与 $（否则被 systemd 自己替换成 boot id / 环境变量）', () => {
    const p = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', '/tmp/a%b$HOME%c.db'] })
    const svc = p.entries.find((e) => e.path.endsWith('qiyu-sync.service'))!
    expect(svc.content).toContain('ExecStart=/usr/local/bin/node /opt/qiyu/cli.js sync run --db /tmp/a%%b$$HOME%%c.db')
    // 反向：良性值逐字不变（既有条目的形态零漂移）
    const benign = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', '/tmp/q.db'] })
    expect(benign.entries.find((e) => e.path.endsWith('qiyu-sync.service'))!.content)
      .toContain('ExecStart=/usr/local/bin/node /opt/qiyu/cli.js sync run --db /tmp/q.db')
  })

  it('systemd ExecStart 把字面反斜杠写成 \\\\：未成对的反斜杠会被 C 转义吃掉/续行', () => {
    // `C:\qiyu` 里的 `\q` 不是合法转义序列 —— systemd 会告警并按未知转义处理；
    // `C:\tmp\` 行尾反斜杠更糟：systemd.syntax(7) 说它「may be used to merge lines」。
    const p = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', 'C:\\tmp\\q.db'] })
    const svc = p.entries.find((e) => e.path.endsWith('qiyu-sync.service'))!
    expect(svc.content).toContain('--db C:\\\\tmp\\\\q.db')
    // 单引号包住的值同样要转义（systemd 不给单引号「禁止转义」的特权）
    const spaced = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', 'C:\\a b\\q.db'] })
    expect(spaced.entries.find((e) => e.path.endsWith('qiyu-sync.service'))!.content)
      .toContain('--db "C:\\\\a b\\\\q.db"')
  })

  it('systemd ExecStart：孤立一个 `;` 的参数必须转义（否则被当成命令分隔符）', () => {
    // systemd.service(5)：「An argument solely consisting of ";" must be escaped, i.e.
    // specified as "\;"」—— 裸 `;` 会把一条 ExecStart 劈成两条命令，静默执行别的东西。
    const p = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', ';'] })
    const svc = p.entries.find((e) => e.path.endsWith('qiyu-sync.service'))!
    expect(svc.content).toContain('--db \\;')
    // 反向：`;` 在值中间（`a;b`）不是独立参数，文档没有要求转义 → 保持原样
    const inner = planInstall('linux', '0 2 * * *', { home: HOME, exec: EXEC, storeArgs: ['--db', '/tmp/a;b.db'] })
    expect(inner.entries.find((e) => e.path.endsWith('qiyu-sync.service'))!.content)
      .toContain('--db /tmp/a;b.db')
  })
})

describe('planInstall win32 —— schtasks 命令行', () => {
  it('*/30 * * * * → /SC MINUTE /MO 30 /ST 00:00；无文件条目', () => {
    const p = planInstall('win32', '*/30 * * * *', { home: HOME, exec: EXEC })
    expect(p.entries).toEqual([])
    const cmd = p.commands[0]!
    expect(cmd[0]).toBe('schtasks')
    expect(cmd).toContain('/SC')
    expect(cmd.indexOf('/MO')).toBeGreaterThan(-1)
    expect(cmd[cmd.indexOf('/MO') + 1]).toBe('30')
    // ⚠️ /ST 必须给：schtasks 缺省 /ST = 「本机当前时刻」，MINUTE 计划是「从起始时刻起每
    // N 分钟」—— 缺了它 `*/30` 会装成「安装那一刻 + 30 分」的相位（14:07 装 → :07/:37），
    // 而 cron 是 :00/:30。与 HOURLY 支的 /ST 锚相位同理。
    expect(cmd[cmd.indexOf('/ST') + 1]).toBe('00:00')
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
  it('修复批 4 #7：步进必须整除值域宽度（schtasks /MO 不在小时/天边界重置）', () => {
    // */30（分钟，60 % 30 == 0）可映射
    const ok = planInstall('win32', '*/30 * * * *', { home: HOME, exec: EXEC }).commands[0]!
    expect(ok[ok.indexOf('/SC') + 1]).toBe('MINUTE')
    expect(ok[ok.indexOf('/MO') + 1]).toBe('30')
    // */7（60 % 7 != 0）→ cron 每小时重置、schtasks 不重置 → 漂移，显式拒绝
    expect(() => planInstall('win32', '*/7 * * * *', { home: HOME, exec: EXEC }))
      .toThrow(/schtasks/)
    // 小时侧同理：*/6（24 % 6 == 0）可映射、*/5（24 % 5 != 0）拒绝
    const h = planInstall('win32', '0 */6 * * *', { home: HOME, exec: EXEC }).commands[0]!
    expect(h[h.indexOf('/SC') + 1]).toBe('HOURLY')
    expect(h[h.indexOf('/MO') + 1]).toBe('6')
    expect(() => planInstall('win32', '0 */5 * * *', { home: HOME, exec: EXEC }))
      .toThrow(/schtasks/)
  })
  it('修复批 4 #8：HOURLY 判据是「固定分钟 + 小时步进」', () => {
    // 0 */2 * * *（每 2 小时的第 0 分）→ HOURLY /MO 2 /ST 00:00
    const cmd = planInstall('win32', '0 */2 * * *', { home: HOME, exec: EXEC }).commands[0]!
    expect(cmd[cmd.indexOf('/SC') + 1]).toBe('HOURLY')
    expect(cmd[cmd.indexOf('/MO') + 1]).toBe('2')
    expect(cmd[cmd.indexOf('/ST') + 1]).toBe('00:00')
    // * */2 * * *（每分钟、每 2 小时）→ 无法等价映射（语义收窄），显式拒绝
    expect(() => planInstall('win32', '* */2 * * *', { home: HOME, exec: EXEC }))
      .toThrow(/schtasks/)
  })
  it('无法映射的 cron 显式抛错（不静默装错计划）', () => {
    // 两个小时点 + 两个分钟点 → schtasks 无对应形态
    expect(() => planInstall('win32', '0,30 2,4 * * *', { home: HOME, exec: EXEC }))
      .toThrow(/schtasks/)
  })
  it('/SC MONTHLY 只接受一个日期：多日 cron 显式拒绝（不产出注定失败的计划）', () => {
    // schtasks 文档：「you can specify only one day in the schedule」——此前把
    // `0 0 1,15 * *` 直接 join 成 `/D 1,15`，dry-run 先给出一个装了也会被拒的计划。
    const one = planInstall('win32', '0 0 1 * *', { home: HOME, exec: EXEC }).commands[0]!
    expect(one[one.indexOf('/SC') + 1]).toBe('MONTHLY')
    expect(one[one.indexOf('/D') + 1]).toBe('1')
    expect(() => planInstall('win32', '0 0 1,15 * *', { home: HOME, exec: EXEC }))
      .toThrow(/schtasks/)
  })
  it('修复批 4 #4：storeArgs 透传进 /TR 命令（未给出时不追加）', () => {
    const withArgs = planInstall('win32', '0 2 * * *',
      { home: HOME, exec: EXEC, storeArgs: ['--db', '/tmp/q.db'] }).commands[0]!
    const tr = String(withArgs[withArgs.indexOf('/TR') + 1])
    expect(tr).toMatch(/sync run --db \/tmp\/q\.db$/)
    // 未给存储参数 → 不追加（不引入默认值漂移）
    const bare = planInstall('win32', '0 2 * * *', { home: HOME, exec: EXEC }).commands[0]!
    expect(String(bare[bare.indexOf('/TR') + 1])).toMatch(/sync run$/)
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

describe('planInstall linux —— crontab 兜底分隔符', () => {
  it('schedule 原文含 CR/LF 时整条拒绝（此前 `\\s+` 放过且原样进兜底行）', () => {
    // 直接喂 crontab 派生用的原 `schedule` 原文（不含在 planInstall 内部被 parseCron 拦下的
    // 情况）：`parseCron('0 0 * * *\r')` 已在 parseCron 组拦下，这里验证**命令层链路**
    // 是否在任何入口都拦得住 —— planInstall 入口本身就 parseCron，因此必然拒绝。
    for (const s of ['0 0 * * *\r', '0 0 *\r* *', '0 0 * * *\n']) {
      expect(() => planInstall('linux', s, { home: HOME, exec: EXEC })).toThrow(/U\+/)
    }
  })
})
