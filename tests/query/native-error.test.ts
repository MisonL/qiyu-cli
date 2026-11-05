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
import {
  isInterrupt, isLayer2Blocked, isExtensionAutoloadBlocked, withoutSqlEcho,
  duckDbSaysMissingName, isBinderOrCatalogError, isOutOfMemory, isParserError,
  stripOomSolutions,
} from '../../src/query/native-error.js'

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

describe('isExtensionAutoloadBlocked —— 扩展自动安装被沙箱拦下的独立形态', () => {
  // 2026-11-05 审查实测（`delta_scan` / `iceberg_scan` / `postgres_scan`）：
  // 前缀是 `Extension Autoloading Error:`，**不是** `Permission Error:` ——
  // 旧实现落到 query_error +「请检查表名、列名与 SQL 语法」，把「这个函数在这里
  // 用不了」说成「SQL 写错了」。
  const REAL = 'Extension Autoloading Error: An error occurred while trying to automatically '
    + "install the required extension 'delta':\n"
    + 'Cannot access directory "/Users/x/.duckdb/extensions/v1.5.6/osx_amd64" '
    + '- file system operations are disabled by configuration'
  it('真实报文 → true', () => {
    expect(isExtensionAutoloadBlocked(REAL)).toBe(true)
  })
  it('带 SQL 回显仍 → true', () => {
    expect(isExtensionAutoloadBlocked(REAL + "\n\nLINE 1: SELECT * FROM delta_scan('/tmp/x')")).toBe(true)
  })
  it('与 isLayer2Blocked 互斥：两者都不该命中对方的报文', () => {
    expect(isLayer2Blocked(REAL)).toBe(false)
    expect(isExtensionAutoloadBlocked(
      'Permission Error: Cannot access file "/etc/passwd" - file system operations are disabled by configuration'))
      .toBe(false)
  })
  it('前缀在 SQL 回显里 → false（不认回显里的仿冒前缀）', () => {
    const fake = 'Failed to extract statements: Parser Error: syntax error\n\n'
      + "LINE 1: SELECT 'Extension Autoloading Error: x - file system operations are disabled by configuration'"
    expect(isExtensionAutoloadBlocked(fake)).toBe(false)
  })
  it('句尾不是特征句（扩展安装因网络失败）→ false（不得说成沙箱拦截）', () => {
    const net = "Extension Autoloading Error: An error occurred while trying to automatically install the required extension 'delta': HTTP GET error"
    expect(isExtensionAutoloadBlocked(net)).toBe(false)
  })
})

// —— 2026-11-01 审查（第二轮，同族第三个落点）——
// 表/列不存在、Binder/Catalog、Out of Memory、未绑参四条**分类判据**此前都是裸子串判，
// 与 isInterrupt/isLayer2Blocked 同一形态。用户数据（Conversion Error 回显列值）与用户
// SQL（Parser Error 回显出错行）都能逐字包含这些串。以下用例逐字取自探针实测。
describe('分类判据同样只认 DuckDB 自己那句话（回显/列值里的仿冒串不算）', () => {
  it('Conversion Error 的列值含「表不存在」串 → duckDbSaysMissingName 不命中', () => {
    // 探针实测：`SELECT * FROM sessions LIMIT '<值>'` 在 prepare 期常量折叠
    const real = "Conversion Error: Could not convert string 'Catalog Error: Table with name zzz does not exist!' to INT64"
      + '\n\nLINE 1: SELECT * FROM sessions LIMIT \'…\'\n        ^'
    expect(duckDbSaysMissingName(real, /Catalog Error: Table with name ([^\s]+) does not exist/)).toBeNull()
    // 对照：真报文（探针逐字）必须命中
    const real2 = 'Catalog Error: Table with name sessons does not exist!\nDid you mean "sessions"?'
      + '\n\nLINE 1: SELECT * FROM sessons\n                      ^'
    expect(duckDbSaysMissingName(real2, /Catalog Error: Table with name ([^\s]+) does not exist/)?.[1])
      .toBe('sessons')
  })
  it('Parser Error 的 SQL 回显里含「表不存在」串 → 不命中', () => {
    const real = 'Failed to extract statements: Parser Error: syntax error at or near "SELEC"\n\n'
      + 'LINE 1: SELEC\'Binder Error: Referenced table "sessons" not found!\'\n        ^'
    expect(duckDbSaysMissingName(real, /Binder Error: Referenced table "([^"]+)" not found/)).toBeNull()
  })
  it('带 `Failed to extract statements: ` 包装的真 Binder/Catalog 报文仍命中（包装要容忍）', () => {
    expect(duckDbSaysMissingName('Failed to extract statements: Binder Error: Referenced table "x" not found',
      /Binder Error: Referenced table "([^"]+)" not found/)?.[1]).toBe('x')
  })
  it('isBinderOrCatalogError：真报文 true，列值/回显里的仿冒串 false', () => {
    expect(isBinderOrCatalogError('Binder Error: No function matches the given name')).toBe(true)
    expect(isBinderOrCatalogError('Catalog Error: Table with name x does not exist!')).toBe(true)
    expect(isBinderOrCatalogError(
      "Conversion Error: Could not convert string 'Catalog Error: Table with name zzz does not exist!' to INT64"))
      .toBe(false)
  })
  it('isOutOfMemory：真报文 true，列值含该串的 Conversion Error false', () => {
    // 真报文逐字（探针：SET memory_limit 小 + 大分配）
    expect(isOutOfMemory('Out of Memory Error: failed to allocate data of size 16.0 MiB (16.5 MiB/28.6 MiB used)'))
      .toBe(true)
    expect(isOutOfMemory(
      "Conversion Error: Could not convert string 'Out of Memory Error: fake' to INT32 when casting from source column x"))
      .toBe(false)
  })
})

describe('stripOomSolutions —— 剥掉沙箱里跑不通的「Possible solutions」', () => {
  // 2026-11-05 探针逐字原文（memory_limit=1GB + lock_configuration=true 真跑）：
  // 三条 SET 在只读沙箱里全部报 `Cannot change configuration option "…" - the configuration
  // has been locked`。原样透出 = 给 Agent 一串照做必然失败的命令。
  const REAL = 'Out of Memory Error: failed to allocate data of size 16.0 MiB (944.5 MiB/953.6 MiB used)\n'
    + '\nPossible solutions:\n'
    + '* Reducing the number of threads (SET threads=X)\n'
    + '* Disabling insertion-order preservation (SET preserve_insertion_order=false)\n'
    + "* Increasing the memory limit (SET memory_limit='...GB')\n"
    + '\nSee also https://duckdb.org/docs/stable/guides/performance/how_to_tune_workloads'

  it('真报文：截到成因行，建议段与 See also 链接一起剥掉', () => {
    expect(stripOomSolutions(REAL)).toBe(
      'Out of Memory Error: failed to allocate data of size 16.0 MiB (944.5 MiB/953.6 MiB used)')
  })
  it('没有标记时原样返回（幂等：已剥过的报文再过一次不变）', () => {
    const head = 'Out of Memory Error: failed to allocate data of size 8.0 GiB'
    expect(stripOomSolutions(head)).toBe(head)
    expect(stripOomSolutions(stripOomSolutions(REAL))).toBe(stripOomSolutions(REAL))
  })
  it('标记出现在报文前半段（用户 SQL/列值回声）→ 截到**最后一个**标记，不吞掉真原因', () => {
    // 边界如实记录：判据是字面标记，用户文本里出现同一句时，最后一处之前的内容都会保留
    const polluted = 'Out of Memory Error: bad value "Possible solutions: x"\n'
      + 'still duckdb explaining\n\nPossible solutions:\n* SET memory_limit=x'
    expect(stripOomSolutions(polluted)).toBe(
      'Out of Memory Error: bad value "Possible solutions: x"\nstill duckdb explaining')
  })
})

describe('isParserError —— 只有 DuckDB 自己说语法错才算（2026-11-01 第二轮）', () => {
  it('真语法错报文（带 extractStatements 包装）→ true', () => {
    expect(isParserError('Failed to extract statements: Parser Error: syntax error at or near "SELEC"')).toBe(true)
    expect(isParserError('Parser Error: syntax error at or near "SELEC"')).toBe(true)
  })
  it('⚠️ 事故原文：列值含 Parser Error 串的 Conversion Error → false（此前被谎报成语法错）', () => {
    const real = "Conversion Error: Could not convert string 'Parser Error: syntax error at or near' to INT32 when casting from source column x"
      + '\n\nLINE 1: SELECT CAST(x AS INT) FROM t\n               ^'
    expect(isParserError(real), '值里的字面量 ≠ DuckDB 说语法错').toBe(false)
  })
})

describe('duckDbSaysMissingName —— 模式也必须锚在那句话的开头（2026-11-01 CodeRabbit）', () => {
  // ⚠️ 只查「报文以类别前缀开头」不够：**列名是用户给的**，可以整段长成另一条报文的形状。
  // 探针实测（`CREATE TABLE t("Catalog Error: Table with name zzz does not exist!" INT)` 后查询）：
  //   `Binder Error: Referenced column "Catalog Error: Table with name zzz does not exist!" not found in FROM clause!`
  // 前缀检查通过（Binder Error: 在开头），而表名正则在**列名内部**命中 ——
  // 「列不存在」被报成「表 zzz 不存在」。
  const TABLE = /Catalog Error: Table with name ([^\s]+) does not exist/
  it('列名里含表不存在句式的真 Binder 报文：表正则不命中、列正则命中', () => {
    const real = 'Binder Error: Referenced column "Catalog Error: Table with name zzz does not exist!" '
      + 'not found in FROM clause!\nCandidate bindings: "id"\n\n'
      + 'LINE 1: SELECT "…" FROM sessions\n               ^'
    expect(duckDbSaysMissingName(real, TABLE), '表正则不得在列名内部命中').toBeNull()
    expect(duckDbSaysMissingName(real, /Binder Error: Referenced column "([^"]+)" (?:was )?not found/)?.[1])
      .toBe('Catalog Error: Table with name zzz does not exist!')
  })
  it('对照：真表不存在报文仍命中', () => {
    expect(duckDbSaysMissingName('Catalog Error: Table with name sessons does not exist!', TABLE)?.[1])
      .toBe('sessons')
  })
  it('包装容忍仍生效（`Failed to extract statements: ` 前缀不破坏锚定）', () => {
    expect(duckDbSaysMissingName('Failed to extract statements: Catalog Error: Table with name x does not exist',
      TABLE)?.[1]).toBe('x')
  })
})
