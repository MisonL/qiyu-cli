// tests/query/native-error.test.ts —— DuckDB 原生报文判据（单一实现点 + 双向自检）
// 2026-11-01，PR #54。
//
// 背景（探针 + E2E 实测，两个真实缺陷）：
//   ① `/INTERRUPT/i` 子串判 —— `Conversion Error` 会回显**列值原文**，
//      数据里恰好含 `interrupt` 时（`Could not convert string 'interrupt' to INT32 …`）
//      把类型转换错误谎报成查询超时（kind 相反、`--timeout 0` 下也报超时）。
//   ② layer2 判据子串搜整条报文 —— `Parser Error` 会回显**出错行 SQL 全文**，
//      SQL 里含特征句时（`SELEC 'file system operations are disabled by configuration'`）
//      把纯语法错谎报成「已被只读沙箱拦截」。
// 两条同根：**判据拿整条报文做子串搜索，而报文会把外部文本带进来**。
// 修法：判据集中到 `query/native-error.ts`，锚 DuckDB 自己的类别前缀，并在判定前剥 SQL 回显。
import { describe, it, expect } from 'vitest'
import { isInterrupt, isLayer2Blocked, withoutSqlEcho } from '../../src/query/native-error.js'

describe('withoutSqlEcho —— 剥掉 DuckDB 的 SQL 回显', () => {
  it('裁掉 \\nLINE n: 及其后全文，保留类别与行号标记', () => {
    const real = 'Permission Error: Cannot access file "/etc/passwd" - file system operations are disabled by configuration'
      + "\n\nLINE 1: SELECT * FROM read_csv('/etc/passwd')\n                      ^"
    expect(withoutSqlEcho(real)).toBe(
      'Permission Error: Cannot access file "/etc/passwd" - file system operations are disabled by configuration')
  })
  it('没有回显时原样返回', () => {
    expect(withoutSqlEcho('INTERRUPT Error: Interrupted!')).toBe('INTERRUPT Error: Interrupted!')
  })
})

describe('isInterrupt —— 只认真中断（实测报文：INTERRUPT Error: Interrupted!）', () => {
  it('真实超时报文 → true', () => {
    expect(isInterrupt('INTERRUPT Error: Interrupted!')).toBe(true)
  })
  it('⚠️ 事故原文：列值回显含 interrupt 的 Conversion Error → false（此前被谎报成超时）', () => {
    // 逐字取自 2026-11-01 探针实测（`INSERT INTO probe_txt VALUES ('interrupt')` 后 CAST）
    const real = "Conversion Error: Could not convert string 'interrupt' to INT32 when casting from source column x"
      + '\n\nLINE 1: SELECT CAST(x AS INT) AS n FROM probe_txt\n               ^'
    expect(isInterrupt(real), '数据里含 interrupt ≠ 查询被中断').toBe(false)
  })
  it('⚠️ 事故原文：SQL 文本含 interrupt 的 Parser Error → false', () => {
    const real = 'Failed to extract statements: Parser Error: syntax error at or near "-"\n\n'
      + 'LINE 1: SELECT -- interrupt me\n               ^'
    expect(isInterrupt(real)).toBe(false)
  })
  it('⚠️ 事故原文：回显列值恰为中断报文原文的 Conversion Error → false（CodeRabbit round 1）', () => {
    // 2026-11-01 探针实测：值恰为 `INTERRUPT Error: Interrupted!` 时，Conversion Error 的
    // **头部**逐字含这串 —— 只锚词、不锚「开头」的写法会把类型转换错误再谎报成超时
    //（上一版只把裸 `/INTERRUPT/i` 收紧到 `/INTERRUPT Error/i`，这个值仍能骗过它）。
    const real = "Conversion Error: Could not convert string 'INTERRUPT Error: Interrupted!' to INT32 when casting from source column x"
      + '\n\nLINE 1: SELECT CAST(x AS INT) AS n FROM t\n               ^'
    expect(isInterrupt(real), '头部含该串 ≠ 报文本身就是它').toBe(false)
  })
  it('真中断报文带 SQL 回显也 → true（剥回显是防御性；实测真中断无回显）', () => {
    // 诚实边界：探针实测 `runAndReadUntil` 抛出的真中断报文恰为 `INTERRUPT Error: Interrupted!`，
    // 不携带回显；这里钉的是「若将来驱动附带回显，剥除不破坏判定」。
    expect(isInterrupt("INTERRUPT Error: Interrupted!\n\nLINE 1: SELECT COUNT(*) FROM range(1e11)")).toBe(true)
  })
  it('大小写与措辞：类别前缀大小写不敏感', () => {
    expect(isInterrupt('interrupt error: Interrupted!')).toBe(true)
  })
})

describe('isLayer2Blocked —— 只认真 layer2 拦截（实测五形态）', () => {
  // 2026-11-01 探针逐字抄来（SET enable_external_access=false 后逐个跑到）
  const REAL: Array<[string, string]> = [
    ['read_csv', 'Permission Error: Cannot access file "/etc/passwd" - file system operations are disabled by configuration'],
    ['read_text', 'Permission Error: Cannot access file "/etc/passwd" - file system operations are disabled by configuration'],
    ['glob', 'Permission Error: Cannot access file "/etc/*" - file system operations are disabled by configuration'],
    ['COPY TO', 'Permission Error: Cannot access file "/tmp/zz.csv" - file system operations are disabled by configuration'],
    ['ATTACH', 'Permission Error: Cannot access file "/private/tmp/a.db" - file system operations are disabled by configuration'],
    // ⚠️ EXPORT / INSTALL 说的是 `directory` 不是 `file` —— 判据必须两种都认
    ['EXPORT', 'Permission Error: Cannot access directory "/tmp/exp" - file system operations are disabled by configuration'],
    ['INSTALL', 'Permission Error: Cannot access directory "/Users/x/.duckdb/extensions/v1.5.6/osx_amd64" - file system operations are disabled by configuration'],
  ]
  for (const [label, msg] of REAL) {
    it(`${label}：真实拦截报文 → true`, () => {
      expect(isLayer2Blocked(msg)).toBe(true)
    })
  }
  it('带 SQL 回显的真实拦截报文仍 → true（剥离回显不影响判定）', () => {
    const real = 'Permission Error: Cannot access file "/etc/passwd" - file system operations are disabled by configuration'
      + "\n\nLINE 1: SELECT * FROM read_csv('/etc/passwd')\n                      ^"
    expect(isLayer2Blocked(real)).toBe(true)
  })

  it('⚠️ 事故原文：SQL 回显里含特征句的语法错 → false（此前被谎报成「已被沙箱拦截」）', () => {
    // 逐字取自 2026-11-01 E2E：`query --sql "SELEC 'file system operations are disabled by configuration'"`
    const real = 'Failed to extract statements: Parser Error: syntax error at or near "SELEC"\n\n'
      + "LINE 1: SELEC 'file system operations are disabled by configuration'\n               ^"
    expect(isLayer2Blocked(real), 'SQL 文本里含特征句 ≠ 沙箱拦截了它').toBe(false)
  })
  it('⚠️ 事故原文：SQL 回显里含 Cannot access file 的语法错 → false', () => {
    const real = 'Failed to extract statements: Parser Error: syntax error at or near "SELEC"\n\n'
      + "LINE 1: SELEC 'Cannot access file /etc/passwd'\n               ^"
    expect(isLayer2Blocked(real)).toBe(false)
  })

  it('裸 Permission Error（库文件的 OS 权限问题）→ false（不许说成沙箱拦截）', () => {
    // 实测形态：`IO Error: Cannot open file "…": Permission denied` 是 IO Error；
    // 但若出现裸 Permission Error（无特征句），也不能判成 layer2
    expect(isLayer2Blocked('Permission Error: Cannot access file "/x"')).toBe(false)
    expect(isLayer2Blocked('Permission Error: Loading external extensions is disabled through configuration')).toBe(false)
  })
  it('引号路径里含特征句、句尾不是它 → false（特征句必须锚句尾，Sourcery）', () => {
    // 合成形态（如实标注）：路径由用户给出，可以包含任意文本。
    const synthetic = 'Permission Error: Cannot access file '
      + '"/tmp/file system operations are disabled by configuration/x.csv": Permission denied'
    expect(isLayer2Blocked(synthetic)).toBe(false)
    // 对照：同样的怪路径、但真被沙箱拦截（句尾是特征句）→ 仍是 true
    expect(isLayer2Blocked('Permission Error: Cannot access file '
      + '"/tmp/file system operations are disabled by configuration/x.csv"'
      + ' - file system operations are disabled by configuration')).toBe(true)
  })
  it('前缀真在开头、特征句只在 SQL 回显里 → false（剥回显真正防的那一种）', () => {
    // 合成形态（如实标注，非实测原文）：头部是不带特征句的 Permission Error，
    // SQL 字面量里恰好含特征句。不剥回显时「锚开头 + 搜特征句」两个条件都满足 → 误判拦截。
    const synthetic = 'Permission Error: Cannot access file "/x"'
      + "\n\nLINE 1: SELECT 'file system operations are disabled by configuration' FROM t\n        ^"
    expect(isLayer2Blocked(synthetic)).toBe(false)
  })
  it('回显区里的 Permission Error 前缀不生效（前缀必须锚在被判定文本的开头）', () => {
    const real = 'Failed to extract statements: Parser Error: syntax error\n\n'
      + 'LINE 1: SELECT \'Permission Error: Cannot access file "/etc/passwd" - file system operations are disabled by configuration\''
    expect(isLayer2Blocked(real)).toBe(false)
  })
})
