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
    expect(session.warnings[0]).toMatch(/引用了 payload/)
    expect(session.warnings[0]).toMatch(/姓名\/地址/)
    expect(session.warnings[0]).toContain('sessions')
    expect(report.warnings).toEqual([])   // daily_overview 的 payload 不是 PII 载体

    // 复审 I-1 残留：别名与 JSON 提取的输出列名都不叫 payload，PII 照样整段漏出 ——
    // 判据必须是「输出列含 payload 或 SQL 文本出现 payload」，只看输出列名会全漏。
    // （`json_extract` 那条还会同时命中 userName 的缺口警告 → 2 条，故只断言「包含」。）
    for (const sql of [
      'SELECT payload AS p FROM sessions',
      "SELECT json_extract(payload, '$.userName') AS n FROM sessions",
      "SELECT concat(payload, '') AS c FROM sessions",
      'select PAYLOAD from sessions',              // 大小写
    ]) {
      const aliased = maskQueryRows({
        rows: [{ p: '{"userName":"张三"}' }], columns: ['p'], mode: sqlMode(sql),
      })
      expect(aliased.warnings.join('\n'), sql).toMatch(/引用了 payload/)
    }
    // SELECT * 输出 payload 列但 SQL 文本里没有 payload 字样 → 仍要警告（靠输出列名那半支）
    const star = maskQueryRows({
      rows: [{ session_id: 's-1', payload: '{"userName":"张三"}' }],
      columns: ['session_id', 'payload'], mode: sqlMode('SELECT * FROM sessions'),
    })
    expect(star.warnings).toHaveLength(1)

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

    // 定点复审记录的第三类形态：整行序列化——SQL 无 payload 记号、输出列名是函数表达式，
    // 但值就是整行 JSON（姓名/地址原样）。判据补「原始行里存在 JSON 对象/数组值」。
    for (const sql of [
      'SELECT row_to_json(t) AS r FROM sessions t',
      'SELECT to_json(t) AS r FROM sessions t',
    ]) {
      const whole = maskQueryRows({
        rows: [{ r: '{"userName":"张三","userAddress":"北京市朝阳区"}' }],
        columns: ['r'], mode: sqlMode(sql),
      })
      expect(whole.warnings, sql).toHaveLength(1)
      expect(whole.warnings[0], sql).toMatch(/整行 JSON/)
    }
    // 反证 1：报表表的 JSON payload 不是 PII 载体 → 不警告
    const reportBlob = maskQueryRows({
      rows: [{ r: '{"total":42}' }], columns: ['r'],
      mode: sqlMode('SELECT row_to_json(t) AS r FROM daily_overview t'),
    })
    expect(reportBlob.warnings).toEqual([])
    // 反证 2：聚合数字列（非 JSON）不误报
    const agg = maskQueryRows({
      rows: [{ c: 3 }], columns: ['c'], mode: sqlMode('SELECT COUNT(*) AS c FROM sessions'),
    })
    expect(agg.warnings).toEqual([])
    // 反证 3：同样的整行 JSON 但表与 payload 无关（staff 无敏感 payload）→ 不警告
    const staffBlob = maskQueryRows({
      rows: [{ r: '{"username":"x"}' }], columns: ['r'],
      mode: sqlMode('SELECT row_to_json(t) AS r FROM staff t'),
    })
    expect(staffBlob.warnings).toEqual([])
  })

  it('security S1：STRUCT/LIST/MAP 整值替换（非字符串 JSON 形态的列名级/值级都够不着）', () => {
    // DuckDB 的 `SELECT t FROM sessions t` 返回 STRUCT → JS 对象；`SELECT [t]` 返回
    // LIST → JS 数组。这类值既不是字符串（旧的 JSON 字符串分支够不着）、也没有列名
    // 可归属（列名级够不着），结果漏出全量 PII 且零警告（Critical）。
    const struct = maskQueryRows({
      rows: [{ t: { userPhone: '13800138000', userName: '张三', session_id: 's1' } }],
      columns: ['t'], mode: sqlMode('SELECT t FROM sessions t'),
    })
    expect(struct.rows[0].t).toBe(FULL)
    expect(struct.maskedColumns).toContain('t')

    const list = maskQueryRows({
      rows: [{ t: [{ userPhone: '13800138000', userName: '张三' }] }],
      columns: ['t'], mode: sqlMode('SELECT [t] AS t FROM sessions t'),
    })
    expect(list.rows[0].t).toBe(FULL)

    const map = maskQueryRows({
      rows: [{ m: { a: { userPhone: '13800138000' } } }],
      columns: ['m'], mode: sqlMode("SELECT {'a': t} AS m FROM sessions t"),
    })
    expect(map.rows[0].m).toBe(FULL)

    // 还有 payload 缺口警告一并起（sessions 的表名在 SQL 里 → payloadPiiTables 非空；
    // hasJsonBlob 因对象/数组为 true → 穿透）。
    expect(struct.warnings.length).toBeGreaterThanOrEqual(1)
    expect(struct.warnings[0]).toMatch(/payload 或整行 JSON/)

    // 反证：聚合对象的反证——不含 PII 表名的查询不触发 payload 警告。
    // ⚠️ 聚合 struct 本身仍被整值替换（slight over-masking），但这是代价最小的安全选择。
    const agg = maskQueryRows({
      rows: [{ s: { min: 42, max: 99 } }], columns: ['s'],
      mode: sqlMode("SELECT {'min': MIN(x), 'max': MAX(x)} AS s FROM daily_overview"),
    })
    expect(agg.rows[0].s).toBe(FULL)
    expect(agg.warnings).toEqual([])  // daily_overview 不在 payloadPiiTables
  })

  it('STRUCT/LIST 被别名成敏感列名时同样整值替换（CodeRabbit 终审 major）', () => {
    // 实测（DuckDB 1.5.6-r.1）：`SELECT t AS userName FROM sessions t` 返回
    // `{userName: {…整行…}}`（JS 对象），`SELECT [t] AS userName` 返回数组。
    // 旧实现走 nameHit 分支 → maskValue 对非字符串原样返回 → 全量 PII 漏出；
    // 而 matchedSensitive 含 userName → 缺口警告也不触发（静默）。
    for (const [sql, value] of [
      ['SELECT t AS userName FROM sessions t', { userPhone: '13800138000', userName: '张三' }],
      ['SELECT [t] AS userName FROM sessions t', [{ userPhone: '13800138000', userName: '张三' }]],
      ["SELECT {'a': t} AS userPhone FROM sessions t", { a: { userPhone: '13800138000' } }],
    ] as const) {
      const out = maskQueryRows({
        rows: [{ userName: value }], columns: ['userName'],
        mode: sqlMode(sql),
      })
      expect(out.rows[0].userName, sql).toBe(FULL)
      expect(out.maskedColumns, sql).toContain('userName')
      expect(JSON.stringify(out.rows[0]), sql).not.toContain('13800138000')
    }

    // 反证：标量值仍走原规则（不被一刀切成 FULL）
    const scalar = maskQueryRows({
      rows: [{ userName: '张三' }], columns: ['userName'],
      mode: sqlMode('SELECT userName FROM sessions'),
    })
    expect(scalar.rows[0].userName).toBe(FULL)   // full 规则本来就是整值替换
    const phone = maskQueryRows({
      rows: [{ userPhone: '13800138000' }], columns: ['userPhone'],
      mode: sqlMode('SELECT userPhone FROM sessions'),
    })
    expect(phone.rows[0].userPhone).toBe('138****8000')  // phone 规则按位保留
  })

  it('security S2：DuckDB 去重列名 userPhone:1/userPhone:2 必须脱敏', () => {
    // 自连接 `SELECT a.userName, b.userName FROM sessions a JOIN sessions b ON …`
    // → DuckDB 把输出列去重成 userName 与 userName:1（冒号 + 数字）。
    // 精确匹配放过 userName:1 → 姓名/地址原样漏出且零警告（Critical）。
    const selfJoin = maskQueryRows({
      rows: [{ userName: '张三', 'userName:1': '李四' }],
      columns: ['userName', 'userName:1'],
      mode: sqlMode(
        'SELECT a.userName, b.userName FROM sessions a JOIN sessions b ON a.session_id < b.session_id'),
    })
    expect(selfJoin.rows[0].userName).toBe(FULL)
    expect(selfJoin.rows[0]['userName:1']).toBe(FULL)
    expect(selfJoin.maskedColumns).toContain('userName')
    expect(selfJoin.maskedColumns).toContain('userName:1')

    // phone 列同样覆盖（有格式 → 按 phone 规则而不是整值）
    const phoneJoin = maskQueryRows({
      rows: [{ userPhone: '13800138000', 'userPhone:1': '13900139000' }],
      columns: ['userPhone', 'userPhone:1'],
      mode: sqlMode(
        'SELECT a.userPhone, b.userPhone FROM sessions a JOIN sessions b ON a.session_id < b.session_id'),
    })
    expect(phoneJoin.rows[0].userPhone).toBe('138****8000')
    expect(phoneJoin.rows[0]['userPhone:1']).toBe('139****9000')
    expect(phoneJoin.maskedColumns).toContain('userPhone')
    expect(phoneJoin.maskedColumns).toContain('userPhone:1')

    // 三列同名 userPhone, userPhone, userPhone → :1 与 :2 都要脱敏
    const triple = maskQueryRows({
      rows: [{ userPhone: '13800138000', 'userPhone:1': '13900139000', 'userPhone:2': '13700137000' }],
      columns: ['userPhone', 'userPhone:1', 'userPhone:2'],
      mode: sqlMode('SELECT userPhone, userPhone, userPhone FROM sessions'),
    })
    expect(triple.rows[0].userPhone).toBe('138****8000')
    expect(triple.rows[0]['userPhone:1']).toBe('139****9000')
    expect(triple.rows[0]['userPhone:2']).toBe('137****7000')

    // 缺口警告不能因 :N 改名而误报（matchedSensitive 用 baseName）
    expect(selfJoin.warnings).toEqual([])
    expect(phoneJoin.warnings).toEqual([])
  })

  it('敏感列被 cast 成非字符串时整值替换（CodeRabbit 复审）', () => {
    // `SELECT userPhone::DOUBLE AS userPhone` 返回数字 13800138000 —— 列名命中敏感名，
    // 但 maskValue 对非字符串原样返回 → 数字形态的手机号照样漏出（PII 不因类型而消失）。
    for (const [sql, value] of [
      ['SELECT userPhone::DOUBLE AS userPhone FROM sessions', 13800138000],
      ['SELECT CAST(userPhone AS BIGINT) AS userPhone FROM sessions', 13800138000],
      ['SELECT true AS userPhone FROM sessions', true],
    ] as const) {
      const out = maskQueryRows({
        rows: [{ userPhone: value }], columns: ['userPhone'], mode: sqlMode(sql),
      })
      expect(out.rows[0].userPhone, sql).toBe(FULL)
      expect(out.maskedColumns, sql).toContain('userPhone')
    }

    // 反证：null / undefined / 空串照旧原样（不是 PII，也不该被替换成标记）
    const nullish = maskQueryRows({
      rows: [{ userPhone: null }, { userPhone: '' }], columns: ['userPhone'],
      mode: sqlMode('SELECT userPhone FROM sessions'),
    })
    expect(nullish.rows[0].userPhone).toBeNull()
    expect(nullish.rows[1].userPhone).toBe('')
    expect(nullish.maskedColumns).toEqual([])
  })

  it('SQL 引用敏感列但输出列名不匹配 → mask_warnings（去重、上限 5、词边界、SQL 侧大小写不敏感）', () => {
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

    // 大小写不敏感（CodeRabbit 终审 major）：DuckDB 标识符不分大小写 ——
    // `SELECT username AS n FROM sessions` 读的就是 sessions.userName，而输出列名是 n，
    // 列名级够不着、值级检测不出姓名 → 大小写敏感时**零警告静默漏出**。
    // 代价是 staff.username（非敏感列）也吃一条警告 —— spec §十五.4 明确要求
    // 「误报方向必须多警告而非少警告」，这个方向是对的。
    const lowerAlias = maskQueryRows({
      rows: [{ n: '张三' }], columns: ['n'],
      mode: sqlMode('SELECT username AS n FROM sessions'),
    })
    expect(lowerAlias.warnings.join('\n')).toContain('userName')

    // 值本身仍不被改写（列名级只认输出列名，staff.username 不是敏感列）；重声明的方向是
    // 「多一条警告」，不是「整列误杀」。
    const staff = maskQueryRows({
      rows: [{ username: 'agent01' }], columns: ['username'],
      mode: sqlMode('SELECT username FROM staff'),
    })
    expect(staff.rows[0].username).toBe('agent01')
    expect(staff.maskedColumns).toEqual([])
    expect(staff.warnings.join('\n')).toContain('userName')   // 误报方向安全
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

describe('--sql 通道：脱敏对分析结果的副作用必须声明（场景审查 7.2/7.3）', () => {
  it('GROUP BY 敏感列 → 警告「不同原值会映射成同一个脱敏值」（否则 Agent 会把 3 个号码读成 1 个）', () => {
    const out = maskQueryRows({
      rows: [
        { userPhone: '13800001111', n: 1 },
        { userPhone: '13899991111', n: 1 },
        { userPhone: '13812341111', n: 1 },
      ],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT userPhone, COUNT(*) AS n FROM sessions GROUP BY userPhone',
        tables: TABLES,
      },
    })
    // 三条不同号码被压成同一个占位符 —— 这是规则本身，无法避免，必须警告
    expect(new Set(out.rows.map((r) => r.userPhone)).size).toBe(1)
    expect(out.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
    expect(out.warnings.join('\n')).toContain('分组结果与计数可能失真')
  })

  it('GROUP BY 的是**别名列** → 分组失真警告照发（输出列名不再叫 userPhone）', () => {
    // 2026-11-05 审查实测：`SELECT userPhone AS p, COUNT(*) … GROUP BY p` 的输出列叫 `p`，
    // matchedSensitive 为空 → 旧判据只发「别名缺口」一条，分组把不同号码压成同一行这件事
    // 一个字都不提。Agent 会拿 `n` 当真。
    const out = maskQueryRows({
      rows: [
        { p: '13800001111', n: 1 },
        { p: '13899991111', n: 1 },
        { p: '13812341111', n: 1 },
      ],
      columns: ['p', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT userPhone AS p, COUNT(*) AS n FROM sessions GROUP BY p',
        tables: TABLES,
      },
    })
    expect(new Set(out.rows.map((r) => r.p)).size).toBe(1)   // 确实被压平
    const w = out.warnings.join('\n')
    expect(w).toContain('GROUP BY / DISTINCT')
    expect(w, '警告里要点名的是 SQL 引用的敏感列').toContain('userPhone')
    // 大小写不敏感：DuckDB 标识符不分大小写（`username AS n` 同样漏出）
    const lower = maskQueryRows({
      rows: [{ n: 2 }],
      columns: ['n'],
      mode: { kind: 'sql', sql: 'SELECT username AS n, COUNT(*) AS c FROM sessions GROUP BY n', tables: TABLES },
    })
    expect(lower.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
  })

  it('反证：GROUP BY 完全不碰敏感列时不得发出分组失真警告（避免噪音淹没真警告）', () => {
    const out = maskQueryRows({
      rows: [{ session_type: 'chat', n: 7 }],
      columns: ['session_type', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT session_type, COUNT(*) AS n FROM sessions GROUP BY session_type',
        tables: TABLES,
      },
    })
    expect(out.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })

  it('反证：敏感列只出现在 WHERE / HAVING（过滤而非分组键）→ 不得发分组失真警告', () => {
    // Codex 2026-11-05 P2：按「SQL 里出现过敏感列」判会把这些查询谎报成分组失真，
    // 而那条警告还建议 --no-mask —— 等于诱导用户白关脱敏。
    const where = maskQueryRows({
      rows: [{ session_type: 'chat', n: 3 }],
      columns: ['session_type', 'n'],
      mode: {
        kind: 'sql',
        sql: "SELECT session_type, COUNT(*) AS n FROM sessions WHERE userPhone = '13800001111' "
          + 'GROUP BY session_type',
        tables: TABLES,
      },
    })
    expect(where.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
    const having = maskQueryRows({
      rows: [{ session_type: 'chat', n: 3 }],
      columns: ['session_type', 'n'],
      mode: {
        kind: 'sql',
        sql: "SELECT session_type, COUNT(*) AS n FROM sessions GROUP BY session_type "
          + "HAVING max(userPhone) = '13800001111'",
        tables: TABLES,
      },
    })
    expect(having.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
    const distinct = maskQueryRows({
      rows: [{ session_type: 'chat' }],
      columns: ['session_type'],
      mode: {
        kind: 'sql',
        sql: "SELECT DISTINCT session_type FROM sessions WHERE userPhone = '13800001111'",
        tables: TABLES,
      },
    })
    expect(distinct.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })

  it('正例：DISTINCT 直接作用在敏感列（含别名）上 → 仍要警告分组失真', () => {
    const direct = maskQueryRows({
      rows: [{ userPhone: '13800138000' }],
      columns: ['userPhone'],
      mode: { kind: 'sql', sql: 'SELECT DISTINCT userPhone FROM sessions', tables: TABLES },
    })
    expect(direct.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
    const aliased = maskQueryRows({
      rows: [{ p: '13800138000' }],
      columns: ['p'],
      mode: { kind: 'sql', sql: 'SELECT DISTINCT userPhone AS p FROM sessions', tables: TABLES },
    })
    expect(aliased.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
    // WHERE 里的敏感列不影响：DISTINCT 的键是选择列表
    const other = maskQueryRows({
      rows: [{ p: '138****8000' }],
      columns: ['p'],
      mode: {
        kind: 'sql',
        sql: "SELECT DISTINCT userEmail AS p FROM sessions WHERE userPhone = '1'",
        tables: TABLES,
      },
    })
    expect(other.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
  })

  it('GROUP BY 引用的是字面量/字符串里的词 → 不算分组键（不被子句切片骗过）', () => {
    const out = maskQueryRows({
      rows: [{ k: 'x', n: 1 }],
      columns: ['k', 'n'],
      mode: {
        kind: 'sql',
        sql: "SELECT session_type AS k, COUNT(*) AS n FROM sessions GROUP BY session_type "
          + "ORDER BY 'userPhone'",
        tables: TABLES,
      },
    })
    expect(out.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })

  it('词法边界：双引号标识符里的撇号（"it\'s"）不得把后面的 GROUP BY 一起吞掉', () => {
    // DuckDB 实测接受带 `'` 的双引号标识符（`SELECT "it's" … GROUP BY "it's"`）；
    // 旧实现只抹单引号，那个 `'` 被当成字符串起点，GROUP BY 整段被抹 → 警告静默丢失。
    const out = maskQueryRows({
      rows: [{ userPhone: '138****1111', n: 1 }],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: `SELECT "it's", userPhone, COUNT(*) AS n FROM sessions GROUP BY "it's", userPhone`,
        tables: TABLES,
      },
    })
    expect(out.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
  })

  it('词法边界：美元引号字符串（$$…$$ / $tag$…$tag$）里的撇号不得开启字符串字面量', () => {
    // DuckDB 实测支持美元引号；`$$don't$$` 里的 `'` 是内容、不是引号。
    // 若词法器不认美元引号，这个 `'` 会被当成字符串起点、一路吞到文末 ——
    // 真的 `GROUP BY userPhone` 整段消失，分组失真警告静默丢失。
    const plain = maskQueryRows({
      rows: [{ userPhone: '138****1111', n: 1 }],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: "SELECT userPhone, $$it's userPhone$$ AS k, COUNT(*) AS n FROM sessions "
          + 'GROUP BY userPhone',
        tables: TABLES,
      },
    })
    expect(plain.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
    const tagged = maskQueryRows({
      rows: [{ userPhone: '138****1111', n: 1 }],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: "SELECT userPhone, $q$it's userPhone$q$ AS k, COUNT(*) AS n FROM sessions "
          + 'GROUP BY userPhone',
        tables: TABLES,
      },
    })
    expect(tagged.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
    // 反证：美元引号里的 `GROUP BY …` 只是文本 —— 按常量分组时不误报
    const constGroup = maskQueryRows({
      rows: [{ k: 'x', n: 1 }],
      columns: ['k', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT session_type AS k, COUNT(*) AS n FROM sessions '
          + 'GROUP BY $$GROUP BY userPhone $$',
        tables: TABLES,
      },
    })
    expect(constGroup.warnings.join('\n'), '按常量分组不是按敏感列分组').not.toContain('GROUP BY / DISTINCT')
  })

  it('词法边界：-- 注释以 \\r 结尾时不能把其后的 GROUP BY 一起抹掉', () => {
    // DuckDB 实测 `--c\rGROUP BY userPhone` 的 GROUP BY 生效（\r 也终止行注释）。
    const out = maskQueryRows({
      rows: [{ userPhone: '138****1111', n: 1 }],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT userPhone, COUNT(*) AS n FROM sessions --note\rGROUP BY userPhone',
        tables: TABLES,
      },
    })
    expect(out.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
  })

  it('GROUP BY ALL（DuckDB）= 按全部非聚合选择项分组 → 敏感列照样要警告（CodeRabbit 2026-11-05 第二轮）', () => {
    const all = maskQueryRows({
      rows: [{ userPhone: '138****1111', n: 1 }],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT userPhone, COUNT(*) AS n FROM sessions GROUP BY ALL',
        tables: TABLES,
      },
    })
    expect(all.warnings.join('\n'), 'ALL 是选择列表的缩写，不是普通键').toContain('GROUP BY / DISTINCT')
    const clean = maskQueryRows({
      rows: [{ session_type: 'chat', n: 3 }],
      columns: ['session_type', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT session_type, COUNT(*) AS n FROM sessions GROUP BY ALL',
        tables: TABLES,
      },
    })
    expect(clean.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })

  it('子查询里的 GROUP BY 不把外层 WHERE 吞进分组键（CodeRabbit 2026-11-05 第二轮）', () => {
    // `sliceClause` 深度 0 遇到 `)` 必须收尾；否则外层 WHERE 里的 userPhone 会被读成分组键。
    const out = maskQueryRows({
      rows: [{ session_type: 'chat', n: 1 }],
      columns: ['session_type', 'n'],
      mode: {
        kind: 'sql',
        sql: "SELECT * FROM (SELECT session_type, COUNT(*) AS n FROM sessions "
          + "GROUP BY session_type) t WHERE userPhone = '13800001111'",
        tables: TABLES,
      },
    })
    expect(out.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })

  it('分组键没被投影出来 → 不报警（脱敏不改可见输出，Codex 2026-11-05 第二轮 P2）', () => {
    // 实测 `SELECT COUNT(*) … GROUP BY userPhone` 返回 [{n:1},{n:1}]：分组键不在输出里，
    // 脱敏前后输出完全一样，报「分组失真」并建议 --no-mask 是纯误报。
    const hidden = maskQueryRows({
      rows: [{ n: 1 }, { n: 1 }],
      columns: ['n'],
      mode: { kind: 'sql', sql: 'SELECT COUNT(*) AS n FROM sessions GROUP BY userPhone', tables: TABLES },
    })
    expect(hidden.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
    // GROUP BY ALL + 聚合别名（`max(userPhone) AS userPhone`）同理：那一项是聚合值不是分组键
    const agg = maskQueryRows({
      rows: [{ userPhone: '13899991111', n: 2 }],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT max(userPhone) AS userPhone, COUNT(*) AS n FROM sessions GROUP BY ALL',
        tables: TABLES,
      },
    })
    expect(agg.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })

  it('GROUP BY 的是字符串字面量 → 按常量分组，不算分组键（Codex 2026-11-05 第二轮 P3）', () => {
    // 实测 `SELECT COUNT(*) … GROUP BY 'userPhone'` 返回一行 n=2（按常量分组）。
    const out = maskQueryRows({
      rows: [{ n: 2 }],
      columns: ['n'],
      mode: {
        kind: 'sql',
        // `session_type AS k`：让 k 成为一个**非敏感**的可见分组键 —— 否则选择列表里
        // 只有聚合项，visible(userPhone) 直接不成立，字面量那一档根本到不了。
        sql: "SELECT session_type AS k, COUNT(*) AS n FROM sessions GROUP BY k, 'userPhone'",
        tables: TABLES,
      },
    })
    expect(out.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
    // ⚠️ 诚实记录：合法 SQL 里「敏感列可见却只被字面量提及」的组合几乎不存在（可见的
    // 非聚合选择项必须同时出现在 GROUP BY 里），所以**分组**这一档对字面量抹除是等价变异；
    // 真正靠它挡住的是下面的缺口警告用例。
  })

  it('列名只以字面量出现的引用（struct_extract / row_to_json）→ 缺口警告必须照发', () => {
    // CodeRabbit PR #68 第三轮 major：`struct_extract(t, 'userName')`、`row_to_json(t)->>'userName'`
    // 里列名**只**以字符串字面量出现，而姓名/地址没有值级检测 —— 抹掉字面量会让这类查询
    // 静默零警告（实测两者都返回 `"n":"张三"`）。方向按 spec §十五.4：缺口警告宁多勿少。
    for (const sql of [
      "SELECT struct_extract(t, 'userName') AS n FROM sessions t",
      "SELECT row_to_json(t)->>'userName' AS n FROM sessions t",
    ]) {
      const out = maskQueryRows({
        rows: [{ n: '张三' }], columns: ['n'], mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.warnings.join('\n'), sql).toContain('引用了敏感列 userName')
    }
    // 代价如实记录：`WHERE x = 'userPhone'` 这种纯字面量也会多报一条（可接受）
    const over = maskQueryRows({
      rows: [{ session_type: 'userPhone' }],
      columns: ['session_type'],
      mode: {
        kind: 'sql',
        sql: "SELECT session_type FROM sessions WHERE session_type = 'userPhone'",
        tables: TABLES,
      },
    })
    expect(over.warnings.join('\n'), '过报方向，spec §十五.4 允许').toContain('引用了敏感列 userPhone')
  })

  it('选择列表解析不了 / 是 `*` 时，退回输出列名命中（保住旧警告，CodeRabbit 2026-11-05 第三轮）', () => {
    // `SELECT DISTINCT *` 实测输出全部敏感列，去重后打码仍可能把两行压成同一行。
    const star = maskQueryRows({
      rows: [{ userPhone: '138****1111', session_type: 'chat' }],
      columns: ['userPhone', 'session_type'],
      mode: { kind: 'sql', sql: 'SELECT DISTINCT * FROM sessions', tables: TABLES },
    })
    expect(star.warnings.join('\n'), 'DISTINCT * 覆盖全部敏感列').toContain('GROUP BY / DISTINCT')
    // `WITH … SELECT` 取不到选择列表 → 与 `SELECT *` 同样退回列名命中
    const cte = maskQueryRows({
      rows: [{ userPhone: '138****1111', n: 1 }],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: 'WITH x AS (SELECT * FROM sessions) SELECT userPhone, COUNT(*) AS n FROM x GROUP BY userPhone',
        tables: TABLES,
      },
    })
    expect(cte.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
    // 反证：解析得出来时不退回 —— 聚合别名是聚合值，不该被当成可见分组键
    const agg = maskQueryRows({
      rows: [{ userPhone: '13899991111', n: 2 }],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT max(userPhone) AS userPhone, COUNT(*) AS n FROM sessions GROUP BY ALL',
        tables: TABLES,
      },
    })
    expect(agg.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })

  it('字面量里的 GROUP BY / DISTINCT 不算查询结构（Codex 2026-11-05 第三轮 P2）', () => {
    const gb = maskQueryRows({
      rows: [{ userPhone: '138****1111', label: 'GROUP BY userPhone' }],
      columns: ['userPhone', 'label'],
      mode: {
        kind: 'sql',
        sql: "SELECT userPhone, 'GROUP BY userPhone' AS label FROM sessions",
        tables: TABLES,
      },
    })
    expect(gb.warnings.join('\n'), '字面量不是分组子句').not.toContain('GROUP BY / DISTINCT')
    const dist = maskQueryRows({
      rows: [{ userPhone: '138****1111', label: 'SELECT DISTINCT' }],
      columns: ['userPhone', 'label'],
      mode: {
        kind: 'sql',
        sql: "SELECT userPhone, 'SELECT DISTINCT' AS label FROM sessions",
        tables: TABLES,
      },
    })
    expect(dist.warnings.join('\n'), '字面量不是 DISTINCT').not.toContain('GROUP BY / DISTINCT')
  })

  it('被标量函数包裹的聚合项不是分组键（Codex 2026-11-05 第三轮 P2）', () => {
    // 实测 `SELECT coalesce(max(userPhone), NULL) AS userPhone, COUNT(*) … GROUP BY ALL`
    // 返回一行 —— 是聚合值，不是分组键。
    const out = maskQueryRows({
      rows: [{ userPhone: '13899991111', n: 2 }],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT coalesce(max(userPhone), NULL) AS userPhone, COUNT(*) AS n '
          + 'FROM sessions GROUP BY ALL',
        tables: TABLES,
      },
    })
    // ⚠️ 必须配一条**真有非敏感分组键**的组：`userPhone AS userPhone` 的聚合别名会让
    // `visible(userPhone)` 直接不成立，聚合识别的变异因此一直是绿的（本用例初版如此）。
    // 这里 `session_type` 是可见分组键，`userPhone` 以裸列名出现在选择项里 —— 只有
    // 「整个表达式里搜聚合函数」才能挡住误报。
    const mixed = maskQueryRows({
      rows: [{ session_type: 'chat', userPhone: '13899991111', n: 2 }],
      columns: ['session_type', 'userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT session_type, coalesce(max(userPhone), NULL) AS userPhone, COUNT(*) AS n '
          + 'FROM sessions GROUP BY ALL',
        tables: TABLES,
      },
    })
    expect(mixed.warnings.join('\n'), '聚合表达式不是分组键').not.toContain('GROUP BY / DISTINCT')
    expect(out.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })

  it('`SELECT * … GROUP BY ALL` → 星号列退回输出列名，分组失真照报（Codex 2026-11-05 第三轮 P2）', () => {
    // 实测输出全部敏感列并按它们分组：不同手机号打码后可能合并。
    const out = maskQueryRows({
      rows: [{ session_type: 'chat', userPhone: '138****1111' }],
      columns: ['session_type', 'userPhone'],
      mode: { kind: 'sql', sql: 'SELECT * FROM sessions GROUP BY ALL', tables: TABLES },
    })
    expect(out.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
  })

  it('带正则元字符的别名（`AS "p("` / `AS "[x"`）→ 照常报警且不得抛 SyntaxError（CodeRabbit 第六轮 minor）', () => {
    // 实测 DuckDB 接受这两种别名并按它分组；旧实现把别名直接拼进 `new RegExp`，
    // `\bp(\b` / `\b[x\b` 直接抛 SyntaxError —— 查询已成功，脱敏阶段却让整条命令报 internal。
    for (const [sql, alias] of [
      ['SELECT userPhone AS "p(", COUNT(*) AS n FROM sessions GROUP BY "p("', 'p('],
      ['SELECT userPhone AS "[x", COUNT(*) AS n FROM sessions GROUP BY "[x"', '[x'],
    ] as const) {
      const out = maskQueryRows({
        rows: [{ [alias]: '138****1111', n: 1 }],
        columns: [alias, 'n'],
        mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.warnings.join('\n'), sql).toContain('GROUP BY / DISTINCT')
    }
    // 反证：不参与分组的标点别名不报警（分组键是 session_type）
    const noGroup = maskQueryRows({
      rows: [{ 'p(': '138****1111', session_type: 'chat' }],
      columns: ['p(', 'session_type'],
      mode: {
        kind: 'sql',
        sql: 'SELECT userPhone AS "p(", session_type FROM sessions GROUP BY session_type',
        tables: TABLES,
      },
    })
    expect(noGroup.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })

  it('`DISTINCT ON (非敏感列)` 投影敏感列 → 不报警；`DISTINCT ON (敏感列)` → 报警（Codex 2026-11-05 第五轮核实）', () => {
    // 去重键是 ON (...) 里的列，不是整张选择列表 —— 正则在 execTopLevel 改写后必须仍保留
    // 捕获组（`distinct[1]`），否则会把整个投影当去重键、对 `DISTINCT ON (session_type)` 误报。
    // 实测 DuckDB：`SELECT DISTINCT ON (session_type) userPhone …` 按 session_type 去重，
    // 每个会话类型只留一行，手机号本身并不参与去重。
    const byType = maskQueryRows({
      rows: [{ userPhone: '138****1111', session_type: 'chat' }],
      columns: ['userPhone', 'session_type'],
      mode: {
        kind: 'sql',
        sql: 'SELECT DISTINCT ON (session_type) userPhone FROM sessions ORDER BY session_type',
        tables: TABLES,
      },
    })
    expect(byType.warnings.join('\n'), '去重键是 session_type').not.toContain('GROUP BY / DISTINCT')
    const byPhone = maskQueryRows({
      rows: [{ userPhone: '138****1111', session_type: 'chat' }],
      columns: ['userPhone', 'session_type'],
      mode: {
        kind: 'sql',
        sql: 'SELECT DISTINCT ON (userPhone) userPhone, session_type FROM sessions ORDER BY userPhone',
        tables: TABLES,
      },
    })
    expect(byPhone.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
  })

  it('无空格写法 `SELECT DISTINCT(userPhone)` 同样要报警（CodeRabbit PR #68 第十四轮 minor）', () => {
    // 实测 DuckDB 接受该写法并去重（3 行 → 2 行）；两处 DISTINCT 正则若要求 `\s+`，
    // 这条查询会一条警告都没有 —— 比改动前的判据（任何 DISTINCT + 命中列名即报）还退步。
    const out = maskQueryRows({
      rows: [{ userPhone: '138****1111' }, { userPhone: '138****1111' }],
      columns: ['userPhone'],
      mode: { kind: 'sql', sql: 'SELECT DISTINCT(userPhone) FROM sessions', tables: TABLES },
    })
    expect(out.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
    // 反证：作用域仍然要守住 —— 子查询里的无空格 DISTINCT 不算本层
    const inner = maskQueryRows({
      rows: [{ userPhone: '138****1111', session_type: 'chat' }],
      columns: ['userPhone', 'session_type'],
      mode: {
        kind: 'sql',
        sql: 'SELECT userPhone, session_type FROM sessions '
          + 'WHERE session_type IN (SELECT DISTINCT(session_type) FROM sessions)',
        tables: TABLES,
      },
    })
    expect(inner.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })

  it('反证：子查询里的 DISTINCT 不是本层的去重 → 不报警（DISTINCT 判据同样按作用域）', () => {
    // 外层只是把子查询的原值行投影出来，脱敏不合并行；把内层 DISTINCT 当成外层去重
    // 会对外层投影的敏感列谎报「分组失真」（2026-11-05 第四轮自查，同族缺陷）。
    for (const sql of [
      'SELECT userPhone, session_type FROM sessions '
      + 'WHERE session_type IN (SELECT DISTINCT session_type FROM sessions)',
      'SELECT userPhone FROM (SELECT DISTINCT userPhone FROM sessions) t',
    ]) {
      const out = maskQueryRows({
        rows: [{ userPhone: '138****1111', session_type: 'chat' }],
        columns: ['userPhone', 'session_type'],
        mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.warnings.join('\n'), sql).not.toContain('GROUP BY / DISTINCT')
    }
  })

  it('表达式别名（`lower(userPhone) AS p` + `GROUP BY p`）→ 必须报警（Codex 2026-11-05 第四轮 P2 漏报）', () => {
    // 实测 DuckDB：`SELECT lower(userPhone) AS p, COUNT(*) … GROUP BY p` 返回两行 ——
    // 按 lower(userPhone) 分组，脱敏后两个号码塌成同一行。整串正则只认「列名紧跟别名」，漏了。
    const out = maskQueryRows({
      rows: [
        { p: '13800138000', n: 1 },
        { p: '13800138000', n: 1 },
        { p: '13900139000', n: 1 },
      ],
      columns: ['p', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT lower(userPhone) AS p, COUNT(*) AS n FROM sessions GROUP BY p',
        tables: TABLES,
      },
    })
    expect(out.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
  })

  it('反证：表达式别名不为敏感列分组时不报警（别名属于其它列 / 是聚合项）', () => {
    // 反方向两条：`session_type` 的别名与敏感列无关；`max(userPhone) AS m` 是聚合值。
    for (const sql of [
      "SELECT lower(session_type) AS p, userPhone FROM sessions GROUP BY p",
      'SELECT max(userPhone) AS m, session_type FROM sessions GROUP BY session_type',
    ]) {
      const out = maskQueryRows({
        rows: [{ p: 'chat', userPhone: '138****8000', m: '138****8000', session_type: 'chat' }],
        columns: ['p', 'userPhone', 'm', 'session_type'],
        mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.warnings.join('\n'), sql).not.toContain('GROUP BY / DISTINCT')
    }
  })

  it('子查询里先出现 GROUP BY，外层才是真分组 → 必须报警（Codex 2026-11-05 第四轮 P2）', () => {
    // 实测 DuckDB：外层按 userPhone 分成两组。取「第一个 GROUP BY」会落在子查询上
    //（那里按 session_type 分组），于是漏掉把手机号压平的那一次分组。
    const out = maskQueryRows({
      rows: [{ userPhone: '138****1111', n: 1 }, { userPhone: '138****1111', n: 1 }],
      columns: ['userPhone', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT userPhone, COUNT(*) AS n FROM (SELECT any_value(userPhone) AS userPhone '
          + 'FROM sessions GROUP BY session_type) t GROUP BY userPhone',
        tables: TABLES,
      },
    })
    expect(out.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
  })

  it('只有子查询按敏感列分组、外层不分组 → 不报警（子句归属按括号层级判定）', () => {
    // 反方向：切片起点必须落在**本层**。外层没有 GROUP BY，内层的分组不改变外层输出。
    const out = maskQueryRows({
      rows: [{ userPhone: '138****1111' }],
      columns: ['userPhone'],
      mode: {
        kind: 'sql',
        sql: 'SELECT userPhone FROM (SELECT any_value(userPhone) AS userPhone '
          + 'FROM sessions GROUP BY userPhone) t',
        tables: TABLES,
      },
    })
    expect(out.warnings.join('\n'), '内层 GROUP BY 不是本层的分组').not.toContain('GROUP BY / DISTINCT')
  })

  it('带双引号的别名（`AS "p"` + `GROUP BY p`）→ 必须报警（Codex 2026-11-05 第二轮 P2 漏报）', () => {
    // 实测 DuckDB 接受该写法并按 userPhone 分成两组；`GROUP BY p` 引用的是 "p"。
    const out = maskQueryRows({
      rows: [{ p: '138****1111', n: 1 }, { p: '138****1111', n: 1 }],
      columns: ['p', 'n'],
      mode: {
        kind: 'sql',
        sql: 'SELECT userPhone AS "p", COUNT(*) AS n FROM sessions GROUP BY p',
        tables: TABLES,
      },
    })
    expect(out.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
  })

  it('值级兜底命中非敏感列 → 警告「可能是业务数字被误改」（11 位订单号）', () => {
    const out = maskQueryRows({
      rows: [{ order_id: '13800138000' }],
      columns: ['order_id'],
      mode: { kind: 'sql', sql: 'SELECT order_id FROM order_performance', tables: TABLES },
    })
    expect(out.rows[0].order_id).toBe('138****8000')   // 规则不放宽（放宽就漏 PII）
    expect(out.warnings.join('\n')).toContain('不在敏感列清单里')
    expect(out.warnings.join('\n')).toContain('业务数字')
  })

  it('反证：SQL 引用敏感列时不再报「非敏感列误伤」（别名场景已有缺口警告）', () => {
    const out = maskQueryRows({
      rows: [{ p: '13800138000' }],
      columns: ['p'],
      mode: { kind: 'sql', sql: 'SELECT userPhone AS p FROM sessions', tables: TABLES },
    })
    expect(out.warnings.join('\n')).toContain('脱敏可能不完整')
    expect(out.warnings.join('\n')).not.toContain('不在敏感列清单里')
  })

  it('--no-mask 时漂移列的警告仍保留（形态问题与脱敏开关无关，契约审查 C-06）', () => {
    const sessions = tableByName('sessions')!
    const out = maskQueryRows({
      rows: [{ session_id: 's1', extra_col: 'x' }],
      columns: ['session_id', 'extra_col'],
      mode: { kind: 'table', table: sessions },
      noMask: true,
    })
    expect(out.rows[0].extra_col).toBe('x')          // 确实没脱敏
    expect(out.warnings[0]).toBe(NO_MASK_WARNING)
    expect(out.warnings.join('\n')).toContain('extra_col')
    expect(out.warnings.join('\n')).toContain('表定义之外的列')
  })
})

describe('SUMMARIZE 形态：敏感列的统计值必须脱敏（2026-11-07 审查，严重）', () => {
  // 实测事故形态：`query --sql "SUMMARIZE sessions"` 的输出列是通用的
  // column_name/min/max/q25/q50/q75，真列名在**行值**里 —— 列名级、SQL 文本、payload
  // 三条启发式全部落空，`userName`/`userAddress` 的 min/max 原值静默输出且
  // `mask_warnings` 为空（完整绕过，README「默认脱敏」承诺被击穿）。
  const summarizeRows = () => [
    { column_name: 'session_id', min: 's1', max: 's2', q25: null, q50: null, q75: null },
    { column_name: 'userName', min: '张三丰', max: '李四光', q25: null, q50: null, q75: null },
    { column_name: 'userAddress', min: '北京市朝阳区', max: '上海市浦东新区', q25: null, q50: null, q75: null },
    { column_name: 'userPhone', min: '13800138000', max: '13900139000', q25: null, q50: null, q75: null },
    { column_name: 'staffId', min: '7', max: '8', q25: null, q50: null, q75: null },
  ]
  const columns = ['column_name', 'min', 'max', 'q25', 'q50', 'q75']

  it('无格式敏感列整值替换；手机号按 phone 规则；非敏感列原样', () => {
    const out = maskQueryRows({
      rows: summarizeRows(), columns,
      mode: { kind: 'sql', sql: 'SUMMARIZE sessions', tables: TABLES },
    })
    const byName = Object.fromEntries(out.rows.map((r) => [String(r.column_name), r]))
    expect(byName.userName!.min).toBe(FULL)
    expect(byName.userName!.max).toBe(FULL)
    expect(byName.userAddress!.min).toBe(FULL)
    expect(byName.userPhone!.min, '手机号按 138****8000 形态').toBe('138****8000')
    expect(byName.session_id!.min, '非敏感列原样').toBe('s1')
    expect(byName.staffId!.min).toBe('7')
    expect(out.maskedColumns).toContain('min')
    expect(out.maskedColumns).toContain('max')
  })

  it('脱敏发生时声明 SUMMARIZE 的残余缺口（别名/表达式列不在匹配范围）', () => {
    const out = maskQueryRows({
      rows: summarizeRows(), columns,
      mode: { kind: 'sql', sql: 'SUMMARIZE sessions', tables: TABLES },
    })
    expect(out.warnings.join('\n')).toContain('SUMMARIZE')
    expect(out.warnings.join('\n')).toContain('别名/表达式列')
  })

  it('反向：普通查询输出不含 column_name 形状时不受影响（不得误伤）', () => {
    const out = maskQueryRows({
      rows: [{ min: '张三丰', max: '李四光' }],
      columns: ['min', 'max'],
      mode: { kind: 'sql', sql: 'SELECT min(userName) AS min, max(userName) AS max FROM sessions', tables: TABLES },
    })
    // 普通查询里 min/max 是输出列名，按既有启发式（SQL 文本命中 userName → 缺口警告）
    // 处理；这里只钉「不会因为列名叫 min/max 就被当成 SUMMARIZE 行去改写」。
    expect(out.rows[0].min).toBe('张三丰')
    expect(out.rows[0].max).toBe('李四光')
  })

  // —— Codex 2026-11-08 四条回归（P1 泄漏 / 三条 P2 误改、误判、漏警告）——
  it('P1：值级兜底已整段替换的 JSON 不得被列规则降级覆盖（@ 后内容重新可见）', () => {
    // `SUMMARIZE SELECT row_to_json(t) AS userEmail FROM sessions t`：min 是紧凑 JSON，
    // 无空白且恰含一个 @ → EMAIL_RE 整串命中。旧实现用 row[stat] 原本重算，把 FULL 覆盖成
    // `{***@x.com","secret":"z"}` —— 不是邮箱的值被当成邮箱打码，@ 后的字段（含 secret）明文回归。
    const json = '{"userEmail":"a@x.com","secret":"z"}'
    const out = maskQueryRows({
      rows: [{ column_name: 'userEmail', min: json, max: json }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SUMMARIZE SELECT row_to_json(t) AS userEmail FROM sessions t', tables: TABLES },
    })
    expect(out.rows[0]!.min).toBe(FULL)
    expect(out.rows[0]!.max).toBe(FULL)
  })

  it('P2b：形状判据必须看 SQL 里的 SUMMARIZE —— 元数据查询的 min 数字不得改写', () => {
    // SELECT column_name, MIN(ordinal_position) AS min FROM information_schema.columns
    // GROUP BY column_name —— 输出列与 SUMMARIZE 同形（column_name/min），min 却是列位置。
    // 只按输出列名判形状会把 `min: 3` 改成 <已脱敏>，让此前正确的元数据查询返回错误值。
    const out = maskQueryRows({
      rows: [{ column_name: 'userName', min: 3 }],
      columns: ['column_name', 'min'],
      mode: {
        kind: 'sql',
        sql: 'SELECT column_name, MIN(ordinal_position) AS min FROM information_schema.columns GROUP BY column_name',
        tables: TABLES,
      },
    })
    expect(out.rows[0]!.min).toBe(3)
    expect(out.warnings.join('\n')).not.toContain('SUMMARIZE')
  })

  it('P2b 反向：可静态证明的两种形态命中；query() 包装保持原值并声明缺口（第十二轮契约收窄）', () => {
    // ⚠️ 2026-11-09 第十二轮结论：query() 内层分析十余轮都被构造出「内层输出其实是常量」
    // 的合法反例，无法静态证明 → 一律保持原值 + 缺口警告，不再猜来源。
    for (const sql of ['SUMMARIZE sessions', 'SELECT * FROM (SUMMARIZE sessions)']) {
      const out = maskQueryRows({
        rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
        columns: ['column_name', 'min', 'max'],
        mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.rows[0]!.min, sql).toBe(FULL)
      expect(out.rows[0]!.max, sql).toBe(FULL)
    }
    const q = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: "SELECT * FROM query('SUMMARIZE sessions')", tables: TABLES },
    })
    expect(q.rows[0]!.min).toBe('张三丰')
    expect(q.warnings.join('\n')).toContain('无法确认来源')
  })

  it('P2b 词法反向：字符串/注释里的 SUMMARIZE 同名词不得触发形状（合法元数据查询）', () => {
    // Codex 2026-11-08 第二轮 P2：关键字判据必须作用在剥除字面量/注释后的文本上。
    // 否则 `SELECT 'SUMMARIZE' AS marker, column_name, MIN(ordinal_position) AS min …`
    // 会被误判成 SUMMARIZE 输出，把元数据里的位置数字改成 <已脱敏>。
    const base = {
      rows: [{ column_name: 'userName', min: 3 }],
      columns: ['column_name', 'min'],
      tables: TABLES,
    }
    for (const sql of [
      "SELECT 'SUMMARIZE' AS marker, column_name, MIN(ordinal_position) AS min FROM information_schema.columns GROUP BY column_name",
      'SELECT column_name, MIN(ordinal_position) AS min FROM information_schema.columns GROUP BY column_name -- SUMMARIZE sessions',
      "SELECT $$SUMMARIZE sessions$$ AS marker, column_name, MIN(ordinal_position) AS min FROM information_schema.columns GROUP BY column_name",
      // Codex 第三轮 P2：注释里伪装的 query() 调用、双引号标识符同名词都不得算关键字
      "SELECT 'userName' AS column_name, 3 AS min /* query('SUMMARIZE sessions') */",
      'SELECT "SUMMARIZE" AS marker, column_name, MIN(ordinal_position) AS min FROM information_schema.columns GROUP BY column_name',
      // Codex 第五轮 P2：SUMMARIZE 作为**未加引号别名**（DuckDB 实测合法）不是语句头关键字
      "SELECT 0 AS SUMMARIZE, 'userName' AS column_name, 3 AS min",
      // Codex 第五轮 P2：query() 内层 SQL 里 SUMMARIZE 只出现在注释中
      "SELECT * FROM query('SELECT ''userName'' AS column_name, 3 AS min /* SUMMARIZE */')",
      // Codex 第六轮 P2：完整标识符边界 —— `$` 不是词字符，`\b` 在 `SUMMARIZE$q$` 处成立
      // 会把它误判成关键字；DuckDB 实测该查询是普通 SELECT（返回 marker/column_name/min 三列）
      "SELECT (SUMMARIZE$q$) AS marker, 'userName' AS column_name, 3 AS min FROM (SELECT 0 AS SUMMARIZE$q$) t",
      // Codex 第六轮 P2：块注释可**嵌套**（DuckDB 实测合法）—— 停在第一个 `*/` 会把仍在
      // 注释里的 `'SUMMARIZE sessions'` 当成 query() 实参，误判成 SUMMARIZE 输出把 min 改成脱敏值
      "SELECT * FROM query(/* outer /* inner */ 'SUMMARIZE sessions' */ 'SELECT 1')",
    ]) {
      const out = maskQueryRows({ ...base, mode: { kind: 'sql', sql, tables: TABLES } })
      expect(out.rows[0]!.min, sql).toBe(3)
      expect(out.warnings.join('\n'), sql).not.toContain('SUMMARIZE')
    }
  })

  it('P2 位置判据：query() 不在最终输出来源时不得改写普通值，只声明缺口（Codex 第七轮）', () => {
    // 真机实测（probe9）：`SELECT 'userName' AS column_name, 3 AS min WHERE EXISTS
    // (SELECT 1 FROM query('SUMMARIZE sessions'))` 合法，输出 column_name/min、min 是**常量 3**。
    // 按全 SQL 判据脱敏会把业务常量篡改成 `<已脱敏>`（Codex 第七轮 P2）。逗号并列来源同理。
    for (const sql of [
      "SELECT 'userName' AS column_name, 3 AS min WHERE EXISTS (SELECT 1 FROM query('SUMMARIZE sessions'))",
      "SELECT 'userName' AS column_name, 3 AS min FROM sessions, query('SUMMARIZE sessions')",
    ]) {
      const out = maskQueryRows({
        rows: [{ column_name: 'userName', min: 3 }],
        columns: ['column_name', 'min'],
        mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.rows[0]!.min, sql).toBe(3)
      expect(out.warnings.join('\n'), sql).toContain('无法确认是否构成最终输出')
    }
    // 反向（第十二轮契约收窄）：顶层 FROM query(...) 也不再按统计值脱敏 ——
    // query() 内层无法静态证明输出是统计值，一律保持原值 + 缺口警告。
    const top = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: "SELECT * FROM query('SUMMARIZE sessions')", tables: TABLES },
    })
    expect(top.rows[0]!.min).toBe('张三丰')
    expect(top.warnings.join('\n')).toContain('无法确认来源')
  })

  it('P2 E-string：query 的 E 字符串实参按 DuckDB 转义语义解码后再判（Codex 第七轮）', () => {
    // 真机实测（probe9/probe10）：
    //   · `\x2f\x2a` = `/*`、`\x2a\x2f` = `*/` —— 不解码会把注释里的 SUMMARIZE 当关键字，
    //     把常量 min=3 脱敏；
    //   · `\'` 是 E 串里的转义引号（不结束字符串），不按 E 语义扫引号边界会截断实参、
    //     漏掉后面的真 SUMMARIZE；
    //   · `\x53` = `S` —— 解转义后关键字必须仍被识别（含 E 串正则误伤方向的对照）。
    const noHit = maskQueryRows({
      rows: [{ column_name: 'userName', min: 3 }],
      columns: ['column_name', 'min'],
      mode: {
        kind: 'sql',
        sql: `SELECT * FROM query(E'SELECT ''userName'' AS column_name, 3 AS min \\x2f\\x2a FROM (SUMMARIZE sessions) \\x2a\\x2f')`,
        tables: TABLES,
      },
    })
    expect(noHit.rows[0]!.min).toBe(3)

    // ⚠️ 内层必须**自身输出统计值**才脱敏（Codex 第十一轮 P2，真机 probe17）：
    // `SELECT 'userName' AS column_name, 3 AS min … FROM (SUMMARIZE …)` 的内层输出是常量 3 ——
    // 按统计值脱敏就是篡改普通值。改断言为「常量保持不变」；真统计来源用纯透传内层。
    const quoted = maskQueryRows({
      rows: [{ column_name: 'userName', min: 3, max: 4 }],
      columns: ['column_name', 'min', 'max'],
      mode: {
        kind: 'sql',
        sql: `SELECT * FROM query(E'SELECT ''userName'' AS column_name, 3 AS min, 4 AS max /* it\\'s */ FROM (SUMMARIZE sessions)')`,
        tables: TABLES,
      },
    })
    expect(quoted.rows[0]!.min).toBe(3)
    // 纯透传内层（`SELECT * FROM (SUMMARIZE …)`）也不再按统计值脱敏（第十二轮）：
    // query() 包装整体只发缺口警告，保持原值。
    const pureQuoted = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: {
        kind: 'sql',
        sql: `SELECT * FROM query(E'SELECT * FROM (SUMMARIZE sessions /* it\\'s */)')`,
        tables: TABLES,
      },
    })
    expect(pureQuoted.rows[0]!.min).toBe('张三丰')
    expect(pureQuoted.warnings.join('\n')).toContain('无法确认来源')

    const hexed = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: {
        kind: 'sql',
        sql: `SELECT * FROM query(E'\\x53UMMARIZE sessions')`,
        tables: TABLES,
      },
    })
    expect(hexed.rows[0]!.min).toBe('张三丰')
    expect(hexed.warnings.join('\n')).toContain('无法确认来源')
  })

  it('P2 来源核验：query 内层重投影、多来源与 query 来源一律不改写（Codex/CodeRabbit 第十一轮）', () => {
    // probe17 真机实测：三条合法 SQL 的正常常量输出都被旧判据误改成 <已脱敏>。
    const cases: Array<[string, Record<string, unknown>, string[], unknown, string?]> = [
      // ① query() 实参是「SELECT 常量 FROM (SUMMARIZE …)」：内层输出不是统计值
      //     → think 对应命中的是 query() 的「缺口」警告（SQL 使用了 query()/query_table()/COLUMNS()…），
      //       不是 SUMMARIZE 的缺口
      ["SELECT * FROM query('SELECT ''userName'' AS column_name, 3 AS min, 4 AS max FROM (SUMMARIZE (SELECT 1 AS userName))')",
        { column_name: 'userName', min: 3, max: 4 }, ['column_name', 'min', 'max'], 3, 'query()/query_table()/COLUMNS()'],
      // ② 显式列举但来自 JOIN 的 VALUES 侧（v.min / v.max）
      ["SELECT v.column_name, v.min, v.max FROM (SUMMARIZE (SELECT 1 AS userName)) s CROSS JOIN (VALUES ('userName', 3, 4)) v(column_name, min, max)",
        { column_name: 'userName', min: 3, max: 4 }, ['column_name', 'min', 'max'], 3],
      // ③ `SELECT *` 多来源混 SUMMARIZE 与 query(普通 SELECT)（右侧 column_name:1/min:1）
      ["SELECT * FROM (SUMMARIZE (SELECT 1 AS userName)) s, query('SELECT ''userName'' AS column_name, 3 AS min') q",
        { column_name: 'userName', min: 1, 'column_name:1': 'userName', 'min:1': 3 },
        ['column_name', 'min', 'column_name:1', 'min:1'], 1],
    ]
    for (const [sql, row, cols, expectMin, expectedWarn] of cases) {
      const out = maskQueryRows({ rows: [row], columns: cols, mode: { kind: 'sql', sql, tables: TABLES } })
      expect(out.rows[0]!.min, sql).toBe(expectMin)
      if (expectedWarn) {
        expect(out.warnings.join('\n'), sql).toContain(expectedWarn)
      } else {
        expect(out.warnings.join('\n'), sql).toContain('无法确认来源')
      }
    }
  })

  it('P2 白名单透传：表达式/集合操作/重名列/非敏感同名列/星号多来源一律不改写（Codex 第九~十轮）', () => {
    // 全部真机实测（probe14）。方向统一：无法证明是 SUMMARIZE 输出透传时**只声明缺口、
    // 不改写任何值** —— 数据损坏比漏脱敏更糟。
    // ① 非敏感同名列不得被大小写不敏感匹配误改（staff.username ≠ sessions.userName）——
    //    这是合法透传、只是没有敏感列，既不脱敏也不应报缺口
    const staff = maskQueryRows({
      rows: [{ column_name: 'username', min: 'support-a', max: 'support-b' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SUMMARIZE staff', tables: TABLES },
    })
    expect(staff.rows[0]!.min).toBe('support-a')
    expect(staff.warnings.join('\n')).not.toContain('未脱敏')
    const cases: Array<[string, Record<string, unknown>, string[], string | number]> = [
      // ② 重排自连接：`:N` 后缀不能证明同组
      ['SELECT a.column_name, b.column_name, b.min, a.min FROM (SUMMARIZE sessions) a, (SUMMARIZE sessions) b',
        { column_name: 'userName', column_name_1: 'session_id', min: 's1', min_1: '张三丰' },
        ['column_name', 'column_name:1', 'min', 'min:1'], 's1'],
      // ③ 省略 AS 的别名 `3 min`
      ['SELECT column_name, 3 min FROM (SUMMARIZE sessions)', { column_name: 'userName', min: 3 },
        ['column_name', 'min'], 3],
      // ④ 字符串常量别名
      ["SELECT column_name, 'not PII' AS min FROM (SUMMARIZE sessions)", { column_name: 'userName', min: 'not PII' },
        ['column_name', 'min'], 'not PII'],
      // ⑤ 前置别名 `min: 3`
      ['SELECT column_name, min: 3 FROM (SUMMARIZE sessions)', { column_name: 'userName', min: 3 },
        ['column_name', 'min'], 3],
      // ⑥ UNION ALL 追加普通行
      ["SELECT column_name, min FROM (SUMMARIZE sessions) UNION ALL SELECT 'userName', 'ordinary constant'",
        { column_name: 'userName', min: '张三丰' }, ['column_name', 'min'], '张三丰'],
      // ⑦ `SELECT *` + 多来源（JOIN/逗号并列）：`:N` 后缀无法证明配对（Codex 第十轮 P2）
      ["SELECT * FROM (SUMMARIZE (SELECT 1 AS userName)) s CROSS JOIN (VALUES ('userName', 3)) v(column_name, min)",
        { column_name: 'userName', 'column_name:1': 'userName', min: 3, 'min:1': 3 },
        ['column_name', 'column_name:1', 'min', 'min:1'], 3],
    ]
    for (const [sql, row, cols, expectMin] of cases) {
      const out = maskQueryRows({
        rows: [row], columns: cols, mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.rows[0]!.min, sql).toBe(expectMin)
      expect(out.warnings.join('\n'), sql).toContain('无法确认来源')
    }
    // ⑦ E 串转义引号：SUMMARIZE 只出现在字符串里，且外层投影是**可证明的裸透传** ——
    //    若 withoutLiterals 不按 E 语义跳过 \\'，字符串会在 `it\\` 处截断、后半段的
    //    `FROM (SUMMARIZE sessions)` 裸露 → 误判成 SUMMARIZE 输出并改写 `min`。
    //    真机实测（probe15）：该查询合法，返回 column_name=userName / min=x 一行。
    const eStr = maskQueryRows({
      rows: [{ column_name: 'userName', min: 'x' }],
      columns: ['column_name', 'min'],
      mode: {
        kind: 'sql',
        sql: `SELECT column_name, min FROM (SELECT 'userName' AS column_name, 'x' AS min) t WHERE E'it\\'s FROM (SUMMARIZE sessions)' = 'x' OR TRUE`,
        tables: TABLES,
      },
    })
    expect(eStr.rows[0]!.min).toBe('x')
    // 反向：可证明透传（`SELECT *` 单一 SUMMARIZE 来源）仍照常脱敏；
    // 显式列举（`SELECT column_name, min, max`）第十二轮起归入缺口（来源不可静态证明）
    const ok = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SELECT * FROM (SUMMARIZE sessions)', tables: TABLES },
    })
    expect(ok.rows[0]!.min).toBe(FULL)
    expect(ok.warnings.join('\n')).not.toContain('无法确认来源')
    const listed = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SELECT column_name, min, max FROM (SUMMARIZE sessions)', tables: TABLES },
    })
    expect(listed.rows[0]!.min).toBe('张三丰')
    expect(listed.warnings.join('\n')).toContain('无法确认来源')
  })

  it('P2 column_name 重投影：大小写改写后仍须脱敏并声明缺口（CodeRabbit 第九轮）', () => {
    // 真机实测（probe13）：`SELECT lower(column_name) AS column_name, min, max FROM
    // (SUMMARIZE sessions)` 的行值是 `username`/`userphone`，min/max 是明文。
    // 大小写敏感比较（旧行为）不命中 → 明细明文且零警告。
    for (const fn of ['lower', 'upper']) {
      const out = maskQueryRows({
        rows: [{ column_name: fn === 'lower' ? 'username' : 'USERNAME', min: '张三丰', max: '李四光' }],
        columns: ['column_name', 'min', 'max'],
        mode: { kind: 'sql', sql: `SELECT ${fn}(column_name) AS column_name, min, max FROM (SUMMARIZE sessions)`, tables: TABLES },
      })
      // 第十二轮收窄：显式列举来源不可静态证明 → 保持原值 + 缺口
      expect(out.rows[0]!.min, fn).toBe('张三丰')
      expect(out.warnings.join('\n'), fn).toContain('无法确认来源')
    }
    // 反向：`SELECT *` 单一 SUMMARIZE 来源不触发
    const ok = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SELECT * FROM (SUMMARIZE sessions)', tables: TABLES },
    })
    expect(ok.rows[0]!.min).toBe(FULL)
    expect(ok.warnings.join('\n')).not.toContain('无法确认来源')
    // 显式列举也发出「无法确认来源」缺口
    const listed = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SELECT column_name, min, max FROM (SUMMARIZE sessions)', tables: TABLES },
    })
    expect(listed.rows[0]!.min).toBe('张三丰')
    expect(listed.warnings.join('\n')).toContain('无法确认来源')
  })

  it('P2 投影来源：统计列被重投影成常量/聚合时不得改写，只声明缺口（Codex 第八轮）', () => {
    // 真机实测（probe12）：`SELECT column_name, 3 AS min FROM (SUMMARIZE sessions)` 返回
    // column_name/min、min 是**常量 3**；`COUNT(*) AS min` 返回 1。按行值脱敏会把常量篡改。
    for (const sql of [
      'SELECT column_name, 3 AS min FROM (SUMMARIZE sessions)',
      'SELECT column_name, COUNT(*) AS min FROM (SUMMARIZE sessions) GROUP BY column_name',
    ]) {
      const out = maskQueryRows({
        rows: [{ column_name: 'userName', min: 3 }],
        columns: ['column_name', 'min'],
        mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.rows[0]!.min, sql).not.toBe(FULL)
      expect(out.warnings.join('\n'), sql).toContain('无法确认来源')
    }
    // 反向：`SELECT *` 单一来源仍照常脱敏
    const ok = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SELECT * FROM (SUMMARIZE sessions)', tables: TABLES },
    })
    expect(ok.rows[0]!.min).toBe(FULL)
    expect(ok.warnings.join('\n')).not.toContain('无法确认来源')
  })

  it('P2 递归与 E 串边界：嵌套 query 的位置判据、\x27 引号、大写 \X（Codex 第八轮）', () => {
    // ① 嵌套 query() 的内层命中在 WHERE EXISTS 里（非输出路径）→ 外层不得当成统计来源
    //   （真机实测 probe12：输出 column_name/min、min 是常量 3）
    const nested = maskQueryRows({
      rows: [{ column_name: 'userName', min: 3 }],
      columns: ['column_name', 'min'],
      mode: {
        kind: 'sql',
        sql: `SELECT * FROM query('SELECT ''userName'' AS column_name, 3 AS min WHERE EXISTS (SELECT 1 FROM query(''SUMMARIZE sessions''))')`,
        tables: TABLES,
      },
    })
    expect(nested.rows[0]!.min).toBe(3)
    // ② E 串用 \x27\x27 编码内层空串：解码后是两个引号（不得二次折叠成引号边界错乱）
    //   （真机实测 probe12：返回 a=""/marker/column_name/min，min 是常量 3）
    const quoted = maskQueryRows({
      rows: [{ a: '', marker: 'FROM (SUMMARIZE sessions)', column_name: 'userName', min: 3 }],
      columns: ['a', 'marker', 'column_name', 'min'],
      mode: {
        kind: 'sql',
        sql: `SELECT * FROM query(E'SELECT \\x27\\x27 AS a, \\x27FROM (SUMMARIZE sessions)\\x27 AS marker, \\x27userName\\x27 AS column_name, 3 AS min')`,
        tables: TABLES,
      },
    })
    expect(quoted.rows[0]!.min).toBe(3)
    // ③ 大写 \X 不是十六进制转义（真机实测 E'\X41' → 'X41'）：注释里的 SUMMARIZE 不成立
    const upper = maskQueryRows({
      rows: [{ column_name: 'userName', min: 3 }],
      columns: ['column_name', 'min'],
      mode: {
        kind: 'sql',
        sql: `SELECT * FROM query(E'SELECT ''userName'' AS column_name, 3 AS min /* \\X2a\\X2f FROM (SUMMARIZE sessions) */')`,
        tables: TABLES,
      },
    })
    expect(upper.rows[0]!.min).toBe(3)
    // ④ 对照（第十二轮收窄）：query() 包装不再脱敏 → 保持原值 + 缺口警告
    const nestedTop = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: {
        kind: 'sql',
        sql: `SELECT * FROM query('SELECT * FROM query(''SUMMARIZE sessions'')')`,
        tables: TABLES,
      },
    })
    expect(nestedTop.rows[0]!.min).toBe('张三丰')
    expect(nestedTop.warnings.join('\n')).toContain('无法确认来源')
  })

  it('重名列：自连接两个 SUMMARIZE 时带 :N 后缀的统计列也必须脱敏（CodeRabbit 第八轮）', () => {
    // 真机实测（probe11）：`SELECT * FROM (SUMMARIZE sessions) a, (SUMMARIZE sessions) b`
    // 的 columnNames() 是两组**同名**列，sandbox 层按驱动规则去重为 `column_name`/
    // `column_name:1`、`min`/`min:1`（行键与 columns 同一序列，sandbox.ts deduplicateNames）。
    // 行级判据必须按同后缀配对，否则第二组 min:1/max:1 明文漏出且无警告。
    const sql = 'SELECT * FROM (SUMMARIZE sessions) a, (SUMMARIZE sessions) b'
    const out = maskQueryRows({
      rows: [{
        column_name: 'userName', min: '张三丰', max: '李四光',
        'column_name:1': 'userName', 'min:1': '张三丰', 'max:1': '李四光',
      }],
      columns: ['column_name', 'min', 'max', 'column_name:1', 'min:1', 'max:1'],
      mode: { kind: 'sql', sql, tables: TABLES },
    })
    // 第十二轮收窄：逗号并列建立多个来源，来源不可静态证明 → 保持原值 + 缺口
    expect(out.rows[0]!.min).toBe('张三丰')
    expect(out.rows[0]!['min:1']).toBe('张三丰')
    expect(out.warnings.join('\n')).toContain('无法确认来源')
    // 反向：第二组是非敏感列（session_id）时同样缺口警告
    const ok = maskQueryRows({
      rows: [{
        column_name: 'userName', min: '张三丰', max: '李四光',
        'column_name:1': 'session_id', 'min:1': 's1', 'max:1': 's2',
      }],
      columns: ['column_name', 'min', 'max', 'column_name:1', 'min:1', 'max:1'],
      mode: { kind: 'sql', sql, tables: TABLES },
    })
    expect(ok.rows[0]!.min).toBe('张三丰')
    expect(ok.rows[0]!['min:1']).toBe('s1')
  })

  it('缺口声明：SUMMARIZE 在无法确认是否构成最终输出（多层子查询）必须警告且不冒认脱敏（CodeRabbit 第七轮）', () => {
    // 真机实测（2026-11-08 probe8）：`WITH t AS (SUMMARIZE sessions) SELECT * FROM t` 是
    // Parser Error（A CTE needs a SELECT）—— 评审给的第一例不成立；但
    // `SELECT * FROM (SELECT * FROM (SUMMARIZE sessions))` 合法，输出 column_name/min/max
    // 且 userName 的 min/max 是**明文**。深度 2 不在可识别层级 → 行级脱敏不生效，
    // 必须发缺口警告（只声明，不伪造脱敏：值级兜底对姓名无从下手，原值保留）。
    const sqls = [
      'SELECT * FROM (SELECT * FROM (SUMMARIZE sessions))',
      'WITH t AS (SELECT * FROM (SUMMARIZE sessions)) SELECT * FROM t',
    ]
    for (const sql of sqls) {
      const out = maskQueryRows({
        rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
        columns: ['column_name', 'min', 'max'],
        mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.rows[0]!.min, sql).toBe('张三丰')
      expect(out.warnings.join('\n'), sql).toContain('无法确认是否构成最终输出')
      expect(out.warnings.join('\n'), sql).toContain('未脱敏')
    }
    // 反向：别名位置（`0 AS SUMMARIZE`，形状列齐全 —— 最接近误报的形态）不得触发
    const ok = maskQueryRows({
      rows: [{ column_name: 'userName', min: 3 }],
      columns: ['column_name', 'min'],
      mode: { kind: 'sql', sql: "SELECT 0 AS SUMMARIZE, 'userName' AS column_name, 3 AS min", tables: TABLES },
    })
    expect(ok.warnings.join('\n')).not.toContain('无法确认是否构成最终输出')
    // 反向：可识别位置（深度 1 的 FROM (）已被行级脱敏覆盖，不吃这条警告
    const ok2 = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SELECT * FROM (SUMMARIZE sessions)', tables: TABLES },
    })
    expect(ok2.rows[0]!.min).toBe(FULL)
    expect(ok2.warnings.join('\n')).not.toContain('无法确认是否构成最终输出')
  })

  it('P2b 词法正向：真 query() 调用不再脱敏，但必须声明缺口（第十二轮契约收窄）', () => {
    // 第十二轮结论：query() 内层无法静态证明输出是统计值（十余轮都有合法反例），
    // 一律保持原值 + 「无法确认来源」缺口；脱敏只保留可证明的语句头与 SELECT * 形态。
    for (const sql of [
      "SELECT * FROM query('SUMMARIZE sessions')",
      "SELECT * FROM query(/* gap */ 'SUMMARIZE sessions')",
      "SELECT * FROM query(E'SUMMARIZE sessions')",
    ]) {
      const out = maskQueryRows({
        rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
        columns: ['column_name', 'min', 'max'],
        mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.rows[0]!.min, sql).toBe('张三丰')
      expect(out.warnings.join('\n'), sql).toContain('无法确认来源')
    }
  })

  it('P2 内层重投影：query() 实参不是纯透传时也必须声明缺口（第十二轮收窄的静默缺口）', () => {
    // `SELECT * FROM query('SELECT column_name, min FROM (SUMMARIZE sessions)')` 合法且输出
    // 就是统计值 → 必须走缺口警告。修复前 innerIsPure=false 且不下探到 gap，**一条 SUMMARIZE
    // 警告都不发**（只有 query() 自身的 nestedSql 泛化提示），属于「声明缺口、绝不静默」的反例。
    for (const sql of [
      "SELECT * FROM query('SELECT column_name, min FROM (SUMMARIZE sessions)')",
      // 表达式重投影：真机实测 `'x' AS min` 合法（注意 `min + 0` 会在 VARCHAR 上 Binder Error，不可用）
      "SELECT * FROM query('SELECT column_name, ''x'' AS min FROM (SUMMARIZE sessions)')",
    ]) {
      const out = maskQueryRows({
        rows: [{ column_name: 'userName', min: '张三丰' }],
        columns: ['column_name', 'min'],
        mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.rows[0]!.min, sql).toBe('张三丰')
      expect(out.warnings.join('\n'), sql).toContain('内层投影**不是原样透传**')
      // 两档缺口互斥：不重复发泛化的「无法确认是否构成最终输出」
      expect(out.warnings.join('\n'), sql).not.toContain('无法确认是否构成最终输出')
    }
  })

  it('缺口声明：SUMMARIZE 输出列名被改写（重投影）时必须警告，不得静默漏出（CodeRabbit 第六轮）', () => {
    // `SELECT column_name AS c, min AS m, max AS x FROM (SUMMARIZE sessions)`：真机实测
    // 输出列是 c/m/x，userName 行的 m/x 是原值 —— 形状判据不匹配 → 行级脱敏够不着，
    // SQL 文本又不含敏感列名、其余缺口警告也不发。按「声明缺口，绝不静默」策略补警告。
    const out = maskQueryRows({
      rows: [{ c: 'userName', m: '张三丰', x: '李四光' }],
      columns: ['c', 'm', 'x'],
      mode: { kind: 'sql', sql: 'SELECT column_name AS c, min AS m, max AS x FROM (SUMMARIZE sessions)', tables: TABLES },
    })
    // 值级兜底对这些无格式值无从下手 —— 不能伪造脱敏，但缺口必须可见
    expect(out.warnings.join('\n'), '缺口警告必须在场').toContain('输出列名已被改写')
    expect(out.warnings.join('\n')).toContain('可能**未脱敏**')
    expect(out.warnings.join('\n')).toContain('query --table')
    // 反向：形状匹配的正常 SUMMARIZE 不吃这条警告（避免噪音）
    const ok = maskQueryRows({
      rows: [{ column_name: 'userName', min: '张三丰', max: '李四光' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SUMMARIZE sessions', tables: TABLES },
    })
    expect(ok.warnings.join('\n')).not.toContain('输出列名已被改写')
  })

  it('P2a 词法正向：非 ASCII 标识符里的 $q$ 也不得当美元引号（DuckDB 实测合法别名）', () => {
    // 四档字符：中文（BMP 字母）、补充平面字母 U+1D49C 𝒜（UTF-16 代理对 —— 只看
    // text[i-1] 会拿到孤立低代理项）、货币符号 U+00A2 ¢（Sc 类别，DuckDB 实测接受）、
    // U+2028 行分隔符（JS 的 `\s` 算空白、DuckDB 实测算标识符字符 —— Codex 第六轮 P2）。
    for (const alias of ['列', '𝒜', '¢', 'x\u2028']) {
      const sql = `SELECT userPhone, 1 AS ${alias}$q$, COUNT(*) AS n FROM sessions GROUP BY userPhone, ${alias}$q$`
      const out = maskQueryRows({
        rows: [{ userPhone: '13800138000', n: 1 }],
        columns: ['userPhone', 'n'],
        mode: { kind: 'sql', sql, tables: TABLES },
      })
      expect(out.warnings.join('\n'), `${alias}：分组失真警告必须在场`).toContain('GROUP BY / DISTINCT')
    }
  })

  it('P2b 聚合判据：双引号别名里的 COUNT(* 文本不得把投影项判成聚合（分组失真警告不得丢失）', () => {
    // DuckDB 实测合法的输出别名（Codex 第六轮 P2）：`SELECT userPhone AS "Bob's COUNT(*)'s label",
    // COUNT(*) AS n … GROUP BY userPhone`。withoutLiterals 保留了双引号内容，别名里的
    // `COUNT(*` 曾让 userPhone 投影被当成聚合项排除出 projected → 分组失真警告静默丢失。
    // 别名只可能是标识符、不可能是调用本身，剥掉方向安全。
    const sql = `SELECT userPhone AS "Bob's COUNT(*)'s label", COUNT(*) AS n FROM sessions GROUP BY userPhone`
    const out = maskQueryRows({
      rows: [{ "Bob's COUNT(*)'s label": '13800138000', n: 3 }],
      columns: ["Bob's COUNT(*)'s label", 'n'],
      mode: { kind: 'sql', sql, tables: TABLES },
    })
    expect(out.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
    expect(out.warnings.join('\n')).toContain('userPhone')
  })

  it('P families：SUMMARIZE 的 avg/std 也是 PII 派生值，一并替换', () => {
    const out = maskQueryRows({
      rows: [{ column_name: 'userPhone', min: null, max: null, avg: '13800138000.5', std: '3' }],
      columns: ['column_name', 'min', 'max', 'avg', 'std'],
      mode: { kind: 'sql', sql: "SUMMARIZE SELECT userPhone::DOUBLE AS userPhone FROM sessions", tables: TABLES },
    })
    expect(out.rows[0]!.avg).toBe(FULL)
    expect(out.rows[0]!.std).toBe(FULL)
  })

  it('P2c：混合结果里非敏感行被值级兜底改写时，误伤警告必须保留', () => {
    // SUMMARIZE sessions：userPhone 行是**有意**脱敏；session_id 行的 min 恰好是手机号形态
    //（真实客户数据的样子）—— 被值级兜底改写时必须仍报「列 min 不在敏感列清单里」。
    // 旧实现把 min 加进列级 structuralMasked，非敏感行的改写就再也到不了告警。
    const out = maskQueryRows({
      rows: [
        { column_name: 'userPhone', min: '13800138000', max: '13900139000' },
        { column_name: 'session_id', min: '13800123456', max: '13900123457' },
      ],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SUMMARIZE sessions', tables: TABLES },
    })
    // 敏感行：按列规则（phone）脱敏
    expect(out.rows[0]!.min).toBe('138****8000')
    // 非敏感行：值级兜底改写
    expect(out.rows[1]!.min).toBe('138****3456')
    expect(out.warnings.join('\n'), '值形态误伤告警').toContain('按**值形态**')
  })

  it('P2c 基线保持：纯 SUMMARIZE 里被值级兜底改写的统计列仍按基线告警（不因有意脱敏而静默）', () => {
    // 基线行为（SUMMARIZE 行规则落地之前）：`min` 被值级兜底改写 → falsePositive 告警。
    // 本判据只要求**不回归**这条基线告警（方向安全、多警告）；有意脱敏的残余缺口另有一条。
    const out = maskQueryRows({
      rows: [{ column_name: 'userPhone', min: '13800138000', max: '13900139000' }],
      columns: ['column_name', 'min', 'max'],
      mode: { kind: 'sql', sql: 'SUMMARIZE sessions', tables: TABLES },
    })
    expect(out.warnings.join('\n'), '与基线一致的误伤告警').toContain('按**值形态**')
    expect(out.warnings.join('\n'), '残余缺口声明（有意脱敏确实发生了）').toContain('别名/表达式列')
  })

  it('P2a：标识符里的 $q$ 不得被当成美元引号字符串（分组失真警告必须保留）', () => {
    const sql = 'SELECT userPhone, 1 AS marker$q$, COUNT(*) AS n FROM sessions GROUP BY userPhone, marker$q$'
    const out = maskQueryRows({
      rows: [{ userPhone: '13800138000', n: 1 }],
      columns: ['userPhone', 'n'],
      mode: { kind: 'sql', sql, tables: TABLES },
    })
    expect(out.warnings.join('\n'), '分组键含敏感列，警告必须在场').toContain('GROUP BY / DISTINCT')
    // 对照：同样的查询去掉 $ 别名 → 也必须有警告（判据看的确实是 GROUP BY，不是别的）
    const ctrl = maskQueryRows({
      rows: [{ userPhone: '13800138000', n: 1 }],
      columns: ['userPhone', 'n'],
      mode: { kind: 'sql', sql: 'SELECT userPhone, COUNT(*) AS n FROM sessions GROUP BY userPhone', tables: TABLES },
    })
    expect(ctrl.warnings.join('\n')).toContain('GROUP BY / DISTINCT')
  })

  it('P2a 反向：真正的美元引号字面量仍被抹掉（边界修复不得回退字面量处理）', () => {
    // 字面量里写着 GROUP BY userPhone —— 不是子句，不得触发分组失真警告
    const out = maskQueryRows({
      rows: [{ marker: 'x' }],
      columns: ['marker'],
      mode: { kind: 'sql', sql: "SELECT $q$GROUP BY userPhone$q$ AS marker FROM sessions", tables: TABLES },
    })
    expect(out.warnings.join('\n')).not.toContain('GROUP BY / DISTINCT')
  })
})
