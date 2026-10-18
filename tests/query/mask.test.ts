// tests/query/mask.test.ts
// 默认脱敏纯函数（spec §七）：四规则、两条通道、缺口警告、--no-mask。
// ⚠️ 全部合成数据（开源自检：不出现真实企业信息）；不碰 DuckDB、不读文件、不联网。
// ⚠️ 列名一律取自 src/store/schema.ts 的真实元数据 —— 脱敏是元数据驱动的，
//    测试断言的是「按标记脱敏」，不是测试里自己维护的列名清单。
import { describe, it, expect } from 'vitest'
import { FULL, NO_MASK_WARNING, maskQueryRows, maskValue, ruleForColumn } from '../../src/query/mask.js'
import { TABLES, tableByName } from '../../src/store/schema.js'

describe('maskValue 四规则（spec §7.1）', () => {
  it('手机号 → 138****1234；邮箱 → a***@x.com；IPv4 → 末段打码', () => {
    expect(maskValue('13800138000', 'phone')).toBe('138****8000')
    expect(maskValue('a@x.com', 'email')).toBe('a***@x.com')
    expect(maskValue('alice@example.com', 'email')).toBe('a***@example.com')
    expect(maskValue('10.2.3.4', 'ip')).toBe('10.2.3.*')
    expect(maskValue('192.168.1.20', 'ip')).toBe('192.168.1.*')
  })

  it('姓名/地址/payload 等无格式敏感值 → <已脱敏>；null/undefined/空串/非字符串原样', () => {
    expect(maskValue('张三', 'full')).toBe(FULL)
    expect(maskValue('{"userPhone":"13800138000"}', 'full')).toBe(FULL)
    // 空串不是 PII：原样返回
    expect(maskValue('', 'phone')).toBe('')
    expect(maskValue(null, 'phone')).toBeNull()
    expect(maskValue(undefined, 'email')).toBeUndefined()
    // 非字符串（数字/布尔）原样：schema 里 PII 列全是 VARCHAR，数字不可能是本函数的合法输入
    expect(maskValue(13800138000, 'phone')).toBe(13800138000)
    expect(maskValue(true, 'full')).toBe(true)
  })

  it('规则与值形态不匹配时退化为整值 <已脱敏>（不按位截取）', () => {
    // 实现取舍（写进 src/query/mask.ts 注释）：模式不匹配就无法可靠定位「保留段」，
    // 按位截取反而可能暴露更多 —— 与 spec §7.1「其余 → 整值替换」一致。
    expect(maskValue('010-88886666', 'phone')).toBe(FULL) // 带区号座机
    expect(maskValue('+8613800138000', 'phone')).toBe(FULL) // 带国际区号
    expect(maskValue('1380013800', 'phone')).toBe(FULL) // 只有 10 位
    expect(maskValue('not-an-email', 'email')).toBe(FULL)
    expect(maskValue('10.2.3', 'ip')).toBe(FULL) // 不是四段
  })

  it('ruleForColumn：phone/email/ip 三组显式列，其余 full', () => {
    for (const n of ['userPhone', 'crmUserPhone', 'userMobile']) expect(ruleForColumn(n)).toBe('phone')
    for (const n of ['userEmail', 'crmUserEmail']) expect(ruleForColumn(n)).toBe('email')
    expect(ruleForColumn('fromIp')).toBe('ip')
    for (const n of ['userName', 'crmUserName', 'userAddress', 'userIpCity', 'userCrmInfo', 'payload']) {
      expect(ruleForColumn(n)).toBe('full')
    }
  })
})

describe('query --table 通道：精确', () => {
  const sessions = tableByName('sessions')!
  const allColumns = sessions.columns.map((c) => c.name)
  const sensitiveColumns = sessions.columns.filter((c) => c.sensitive).map((c) => c.name)

  const rawRow = {
    session_id: 's-1', payload: '{"userPhone":"13800138000"}', staffId: '42',
    startTime: '1750000000000', categoryDetail: '售前/咨询',
    userPhone: '13800138000', userName: '张三', userEmail: 'alice@example.com',
    userAddress: '上海市某区某路 1 号', fromIp: '10.2.3.4', userIpCity: '上海',
    userCrmInfo: '{"vip":true}', synchronized_at: '2026-10-01T00:00:00Z',
  }

  it('sessions 的 8 个 sensitive 列全脱敏，非敏感列不误伤', () => {
    // 元数据事实（D 已实测）：sessions 的 PII 列恰为这 8 个
    expect(sensitiveColumns).toEqual(['payload', 'userPhone', 'userName', 'userEmail',
      'userAddress', 'fromIp', 'userIpCity', 'userCrmInfo'])

    const out = maskQueryRows({ rows: [rawRow], columns: allColumns, mode: { kind: 'table', table: sessions } })
    const r = out.rows[0]
    expect(r.userPhone).toBe('138****8000')
    expect(r.userEmail).toBe('a***@example.com')
    expect(r.fromIp).toBe('10.2.3.*')
    for (const n of ['payload', 'userName', 'userAddress', 'userIpCity', 'userCrmInfo']) {
      expect(r[n]).toBe(FULL)
    }
    // 非敏感列逐字保留
    expect(r.session_id).toBe('s-1')
    expect(r.staffId).toBe('42')
    expect(r.startTime).toBe('1750000000000')
    expect(r.categoryDetail).toBe('售前/咨询')
    expect(r.synchronized_at).toBe('2026-10-01T00:00:00Z')
    expect(out.maskedColumns).toEqual(sensitiveColumns)
    expect(out.warnings).toEqual([])
    // 纯函数：输入行不被就地改写
    expect(rawRow.userPhone).toBe('13800138000')
    expect(rawRow.userName).toBe('张三')
  })

  it('tickets 的 sensitive 列（crm* + userMobile + payload）按元数据脱敏', () => {
    const tickets = tableByName('tickets')!
    const row = {
      ticket_id: 't-1', payload: '{"crmUserPhone":"13800138000"}',
      crmUserName: '李四', crmUserPhone: '13900139000',
      crmUserEmail: 'bob@corp.example', userMobile: '13700137000',
      synchronized_at: '2026-10-01T00:00:00Z',
    }
    const out = maskQueryRows({ rows: [row], columns: tickets.columns.map((c) => c.name), mode: { kind: 'table', table: tickets } })
    const r = out.rows[0]
    expect(r.payload).toBe(FULL)
    expect(r.crmUserName).toBe(FULL)
    expect(r.crmUserPhone).toBe('139****9000')
    expect(r.crmUserEmail).toBe('b***@corp.example')
    expect(r.userMobile).toBe('137****7000')
    expect(r.ticket_id).toBe('t-1')
    expect(out.maskedColumns).toEqual(['payload', 'crmUserName', 'crmUserPhone', 'crmUserEmail', 'userMobile'])
    expect(out.warnings).toEqual([])
  })

  it('不在 TableDef 的额外输出列不脱敏但**给警告**；敏感列全为 null 时不计入 maskedColumns', () => {
    const row = { session_id: 's-2', userPhone: null, extra: '13800138000' }
    const out = maskQueryRows({
      rows: [row], columns: ['session_id', 'userPhone', 'extra'],
      mode: { kind: 'table', table: sessions },
    })
    expect(out.rows[0].userPhone).toBeNull()
    // --table 通道没有值级兜底：未知列原样返回（spec §7.2「精确」）——
    // 但不得静默（审查 Minor 1）：db describe 对同一漂移会警告，这里只看不说就是
    // 「`SELECT *` 把库里多出来的 PII 列原样带出且 masked:true」。
    expect(out.rows[0].extra).toBe('13800138000')
    expect(out.warnings).toHaveLength(1)
    expect(out.warnings[0]).toMatch(/表定义之外的列 extra/)
    expect(out.warnings[0]).toMatch(/未做脱敏/)
    // `count` 是 --group-by 的聚合别名（不在 TableDef.columns），不算漂移列
    const grouped = maskQueryRows({
      rows: [{ session_type: 'robot', count: 3 }], columns: ['session_type', 'count'],
      mode: { kind: 'table', table: sessions },
    })
    expect(grouped.warnings).toEqual([])
    // spec line 217「实际脱敏」：本行输出一个字节都没改 → 空清单（Agent 据此判断是否被改写）
    expect(out.maskedColumns).toEqual([])
  })

  it('maskedColumns 跨行合并：某列只要有一行被改写就计入，全 null 的列不计入', () => {
    const out = maskQueryRows({
      rows: [
        { session_id: 's-3', userPhone: null, userName: '张三' },
        { session_id: 's-4', userPhone: '13800138000', userName: null },
      ],
      columns: ['session_id', 'userPhone', 'userName'],
      mode: { kind: 'table', table: sessions },
    })
    expect(out.rows[0].userPhone).toBeNull()
    expect(out.rows[1].userName).toBeNull()
    expect(out.maskedColumns).toEqual(['userPhone', 'userName'])
  })
})

describe('query --sql 通道：列名级 + 值级兜底（spec §7.2）', () => {
  const sqlMode = (sql: string) => ({ kind: 'sql' as const, sql, tables: TABLES })

  it('输出列名 userPhone → 列名级脱敏；别名 p → 值级兜底命中手机号', () => {
    const named = maskQueryRows({
      rows: [{ userPhone: '13900139000', nickname: '机器人' }],
      columns: ['userPhone', 'nickname'],
      mode: sqlMode("SELECT userPhone, '机器人' AS nickname FROM sessions"),
    })
    expect(named.rows[0].userPhone).toBe('139****9000')
    expect(named.rows[0].nickname).toBe('机器人')
    expect(named.maskedColumns).toEqual(['userPhone'])
    // 敏感列名出现在输出列名中 → 不构成缺口
    expect(named.warnings).toEqual([])

    const raw = { p: '13800138000', m: 'bob@corp.example', ip: '192.168.1.20', note: '你好' }
    const alias = maskQueryRows({
      rows: [raw], columns: ['p', 'm', 'ip', 'note'],
      mode: sqlMode("SELECT userPhone AS p, userEmail AS m, fromIp AS ip, '你好' AS note FROM sessions"),
    })
    expect(alias.rows[0]).toEqual({ p: '138****8000', m: 'b***@corp.example', ip: '192.168.1.*', note: '你好' })
    // 值级兜底只记「实际改了值」的列；note 无命中 → 不算
    expect(alias.maskedColumns).toEqual(['p', 'm', 'ip'])
    // 三个敏感列被引用但都不在输出列名中 → 三条缺口警告
    expect(alias.warnings).toHaveLength(3)
    expect(raw.p).toBe('13800138000') // 输入不被就地改写
  })

  it('payload 不做列名级（报表 payload 不误杀）；会话 payload 的 JSON 值级检测命中 → 整值 <已脱敏>', () => {
    const reportJson = '{"total":42,"items":[{"name":"x"}]}'
    const report = maskQueryRows({
      rows: [{ payload: reportJson }], columns: ['payload'],
      mode: sqlMode('SELECT payload FROM daily_overview'),
    })
    // 报表 payload 是聚合数字，无 PII 模式 → 原样
    expect(report.rows[0].payload).toBe(reportJson)
    expect(report.maskedColumns).toEqual([])
    // payload 被排除在列名级与缺口警告之外（spec §7.2 的显式取舍）
    expect(report.warnings).toEqual([])

    const sessionJson = '{"userPhone":"13800138000","nested":{"list":[{"email":"a@x.com"}]}}'
    const session = maskQueryRows({
      rows: [{ payload: sessionJson }], columns: ['payload'],
      mode: sqlMode('SELECT payload FROM sessions'),
    })
    expect(session.rows[0].payload).toBe(FULL)
    expect(session.maskedColumns).toEqual(['payload'])

    // 数组根命中；畸形 JSON（parse 失败）无法逐字段判定 → 整值 <已脱敏>，不留半段原值
    const mixed = maskQueryRows({
      rows: [{ payload: '["13800138000"]' }, { payload: '{"broken' }],
      columns: ['payload'],
      mode: sqlMode('SELECT payload FROM sessions'),
    })
    expect(mixed.rows[0].payload).toBe(FULL)
    expect(mixed.rows[1].payload).toBe(FULL)
    expect(mixed.maskedColumns).toEqual(['payload'])

    // JSON 叶子带空白也要识别（hasPiiLeaf 先 trim 再判，与直接值路径一致）
    const padded = maskQueryRows({
      rows: [{ payload: '{"userPhone":" 13800138000 "}' }], columns: ['payload'],
      mode: sqlMode('SELECT payload FROM sessions'),
    })
    expect(padded.rows[0].payload).toBe(FULL)
    expect(padded.maskedColumns).toEqual(['payload'])

    // 审查 I-1：payload 缺口必须点破。值级只认手机号/邮箱/IPv4，姓名/地址会整段原样
    // 输出——而 `masked_columns` 非空（手机号命中），Agent 看到 masked:true 会以为已脱敏。
    // 会话/工单的 payload 标了 sensitive → 警告；报表 payload 未标 → 不警告（避免噪音）。
    expect(session.warnings).toHaveLength(1)
    expect(session.warnings[0]).toMatch(/payload 列/)
    expect(session.warnings[0]).toMatch(/姓名\/地址/)
    expect(session.warnings[0]).toContain('sessions')
    expect(report.warnings).toEqual([])   // daily_overview 的 payload 不是 PII 载体

    // 无格式载荷（无手机号/邮箱/IP）：payload 原样输出、maskedColumns 为空 ——
    // 这正是最危险的形态（Agent 看到 masked_columns 空但 masked:true），警告必须仍在。
    const noFormat = maskQueryRows({
      rows: [{ payload: '{"userName":"张三","userAddress":"北京市朝阳区"}' }],
      columns: ['payload'], mode: sqlMode('SELECT payload FROM sessions'),
    })
    expect(noFormat.rows[0].payload).not.toBe(FULL)
    expect(noFormat.maskedColumns).toEqual([])
    expect(noFormat.warnings).toHaveLength(1)

    // 输出里没有 payload 列（哪怕 SQL 引用了 sessions）→ 无 payload 缺口警告
    const noPayloadCol = maskQueryRows({
      rows: [{ session_id: 's-1' }], columns: ['session_id'],
      mode: sqlMode('SELECT session_id FROM sessions'),
    })
    expect(noPayloadCol.warnings).toEqual([])
  })

  it('SQL 引用敏感列但输出列名不匹配 → mask_warnings（去重、上限 5、词边界、精确大小写）', () => {
    const one = maskQueryRows({
      rows: [{ p: '13800138000' }], columns: ['p'],
      mode: sqlMode('SELECT userPhone AS p FROM sessions'),
    })
    expect(one.warnings).toHaveLength(1)
    expect(one.warnings[0]).toContain('userPhone')
    expect(one.warnings[0]).toContain('脱敏可能不完整')

    // 同一列引用两次 → 去重后一条。
    // 注：columns 刻意只列 ['p'] —— 真实查询里 SELECT userPhone, userPhone AS p 会输出两列
    //（userPhone 与 p），这里模拟「引用两次但输出列名都不匹配」的形态，专测警告去重。
    const dup = maskQueryRows({
      rows: [{ p: '13800138000' }], columns: ['p'],
      mode: sqlMode('SELECT userPhone, userPhone AS p FROM sessions'),
    })
    expect(dup.warnings).toHaveLength(1)

    // 6 个敏感列全部被引用且都以别名输出 → 上限 5 条（columns 与 SQL 输出一一对应）
    const six = maskQueryRows({
      rows: [{ a: '张三', b: '13800138000', c: 'a@x.com', d: '上海', e: '10.2.3.4', f: '上海' }],
      columns: ['a', 'b', 'c', 'd', 'e', 'f'],
      mode: sqlMode('SELECT userName AS a, userPhone AS b, userEmail AS c, userAddress AS d, fromIp AS e, userIpCity AS f FROM sessions'),
    })
    expect(six.warnings).toHaveLength(5)

    // 词边界：userPhoneBook 是更长的标识符，不得触发 userPhone 警告
    const longer = maskQueryRows({
      rows: [{ userPhoneBook: 'x' }], columns: ['userPhoneBook'],
      mode: sqlMode('SELECT userPhoneBook FROM sessions'),
    })
    expect(longer.warnings).toEqual([])

    // 精确大小写（探针 12：输出列名 = 表定义大小写）：staff.username ≠ sessions.userName
    const staff = maskQueryRows({
      rows: [{ username: 'agent01' }], columns: ['username'],
      mode: sqlMode('SELECT username FROM staff'),
    })
    expect(staff.rows[0].username).toBe('agent01')
    expect(staff.maskedColumns).toEqual([])
    expect(staff.warnings).toEqual([])
  })
})

describe('--no-mask', () => {
  it('全部原样 + maskedColumns 为空 + PII 警告（两条通道一致）', () => {
    const sessions = tableByName('sessions')!
    const rows = [{ userPhone: '13800138000', payload: '{"userPhone":"13800138000"}' }]

    const tableOut = maskQueryRows({
      rows, columns: ['userPhone', 'payload'],
      mode: { kind: 'table', table: sessions }, noMask: true,
    })
    expect(tableOut.rows).toEqual(rows)
    expect(tableOut.rows[0].userPhone).toBe('13800138000')
    expect(tableOut.maskedColumns).toEqual([])
    expect(tableOut.warnings).toEqual([NO_MASK_WARNING])

    const sqlOut = maskQueryRows({
      rows, columns: ['userPhone', 'payload'],
      mode: { kind: 'sql', sql: 'SELECT userPhone, payload FROM sessions', tables: TABLES }, noMask: true,
    })
    expect(sqlOut.rows).toEqual(rows)
    expect(sqlOut.maskedColumns).toEqual([])
    expect(sqlOut.warnings).toEqual([NO_MASK_WARNING])
  })
})
