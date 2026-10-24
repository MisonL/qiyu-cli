import { describe, it, expect } from 'vitest'
import { collectSegments, extractRefs, isPlaceholderToken, splitWords } from '../../src/skill/refs.js'

/**
 * `CommandRef` 的新契约（2026-10-22 全维度审查修复波）：
 *   · `tokens` —— **全部** token（命令词 / 位置参数 / flag / flag 取值 / 占位符模板），
 *     按原文顺序、引号已去。refs 层不认识命令树，**不判断**哪个 token 是 flag 的取值；
 *   · `flags` —— 每个 flag 的名字与它在 `tokens` 里的下标。
 *
 * 「位置参数是哪几个」由 check 层按 `spec.flags` 的 `kind` 重建（bool 不吞、value 吞），
 * refs 层给不出这个答案 —— 旧版在 refs 层一刀切吞掉 flag 紧邻的词，把 bool flag 之后的
 * 位置参数也吞掉，位置参数域校验因此整段失效（审查 A1）。
 *
 * 这个辅助函数把「一条命令引用长什么样」钉在一处，避免每条用例重复写两遍。
 */
const ref = (tokens: string[], flags: { name: string; tokenIndex: number }[], line: number) => ({
  tokens,
  flags,
  line,
})

/** 只要 flag 名序列（`--table` / `--since` …），用于绝大多数用例。 */
const flagNames = (r: ReturnType<typeof extractRefs>) => r.commands[0]?.flags.map((f) => f.name) ?? []

describe('extractRefs', () => {
  it('提取命令路径与 flag', () => {
    const r = extractRefs('先跑 `qiyu sync status` 看覆盖范围。')
    expect(r.commands).toEqual([ref(['sync', 'status'], [], 1)])
  })
  it('flag 与占位符：只校验到占位符之前', () => {
    const r = extractRefs('用 `qiyu query --table <表> --since <时间>`。')
    expect(r.commands[0]).toMatchObject({ flags: [{ name: '--table' }, { name: '--since' }] })
  })
  it('含管道或省略号的记为 unverifiable', () => {
    const r = extractRefs('`qiyu sync run | json`')
    expect(r.commands).toEqual([])
    expect(r.unverifiable[0].reason).toBe('含选择/省略符号')
  })
  it('围栏代码块也扫', () => {
    const r = extractRefs('```\nqiyu db tables\n```')
    expect(r.commands[0].tokens).toEqual(['db', 'tables'])
  })
  it('散文里的 qiyu 不算引用', () => {
    expect(extractRefs('可以直接运行 qiyu sync status 命令').commands).toEqual([])
  })
  it('提取 kind', () => {
    const r = extractRefs('按 `kind: rate_limit` 分支。')
    expect(r.kinds).toEqual([{ name: 'rate_limit', line: 1 }])
  })
  it('提取 SQL 序列', () => {
    const r = extractRefs('不要写 `SELECT * FROM sessions`')
    expect(r.sqlSequences[0].text).toBe('SELECT * FROM sessions')
  })
  it('只有 SELECT 没有 FROM 不算', () => {
    expect(extractRefs('`SELECT 1`').sqlSequences).toEqual([])
  })
  it('行号准确', () => {
    const r = extractRefs('第一行\n第二行 `qiyu sync status`\n第三行')
    expect(r.commands[0].line).toBe(2)
  })
  it('多个反引号片段各自计数', () => {
    const r = extractRefs('`qiyu db tables` 与 `qiyu sync tasks`')
    expect(r.commands.map((c) => c.tokens.join(' '))).toEqual(['db tables', 'sync tasks'])
  })
})

describe('切词：引号感知（审查 A2）', () => {
  it('双引号里的空格算一个词', () => {
    expect(splitWords('--schedule "0 3 * * *"')).toEqual(['--schedule', '0 3 * * *'])
  })
  it('单引号里的空格算一个词', () => {
    expect(splitWords(`--body '{"opStart": 1, "opEnd": 2}'`)).toEqual(['--body', '{"opStart": 1, "opEnd": 2}'])
  })
  it('引号被剥掉，取值内容保留', () => {
    expect(splitWords(`'abc'`)).toEqual(['abc'])
  })
  it('未闭合引号退化为非空白切，不丢整段', () => {
    // 变异「切词改成 split(/\s+/)」→ 本用例红（会多出 'abc' / 'def' 两个词）。
    expect(splitWords(`'abc def`)).toEqual(["'abc", 'def'])
  })
  it('引号取值整体进 tokens，不再被拆成多个位置参数', () => {
    const r = extractRefs('`qiyu sync install --schedule "0 3 * * *"`')
    expect(r.commands[0]!.tokens).toEqual(['sync', 'install', '--schedule', '0 3 * * *'])
  })
  it('JSON body 含空格时整体是一个 token', () => {
    const r = extractRefs(`\`qiyu api call ticket.search --body '{"opStart": 1}'\``)
    expect(r.commands[0]!.tokens).toEqual(['api', 'call', 'ticket.search', '--body', '{"opStart": 1}'])
  })
  it('引号内的 # 不是注释（围栏行）', () => {
    // 变异「剥注释不保护引号」→ 本用例红（取值会被从 # 处截断，后面多出两个假 token）。
    const r = extractRefs("```\nqiyu api call ticket.search --body '{\"keyword\":\"a # b\"}'\n```")
    expect(r.commands[0]!.tokens).toEqual(['api', 'call', 'ticket.search', '--body', '{"keyword":"a # b"}'])
  })
  it('引号内的 # 不是注释（散文行内代码）', () => {
    const r = extractRefs("`qiyu api call ticket.search --body '{\"keyword\":\"a # b\"}'`")
    expect(r.commands[0]!.tokens).toEqual(['api', 'call', 'ticket.search', '--body', '{"keyword":"a # b"}'])
  })
  it('引号外的 # 仍然是注释', () => {
    const r = extractRefs('```\nqiyu db tables  # 不要用 --pretty\n```')
    expect(r.commands[0]!.tokens).toEqual(['db', 'tables'])
  })
})

describe('护栏：占位符之后的管道与省略号（审查 Important-1）', () => {  it('管道右侧的 flag 不算进本命令：| head -20', () => {
    const r = extractRefs('`qiyu query --table <表> | head -20`')
    expect(r.commands).toEqual([ref(['query', '--table', '<表>'], [{ name: '--table', tokenIndex: 1 }], 1)])
    expect(r.unverifiable).toEqual([])
  })
  it('管道右侧的 flag 不算进本命令：| grep -v x', () => {
    expect(flagNames(extractRefs('`qiyu query --table <表> | grep -v x`'))).toEqual(['--table'])
  })
  it('管道右侧的 flag 不算进本命令：| jq -r', () => {
    expect(flagNames(extractRefs('`qiyu query --table <表> | jq -r .items`'))).toEqual(['--table'])
  })
  it('占位符后的管道不判 unverifiable（路径已封口，管道不影响命令结构）', () => {
    const r = extractRefs('`qiyu sync run <任务id> | head`')
    expect(r.commands).toEqual([ref(['sync', 'run', '<任务id>'], [], 1)])
    expect(r.unverifiable).toEqual([])
  })
})

describe('护栏：围栏的缩进与长度配对（审查 Important-2 / Minor-5）', () => {
  it('列表内缩进的围栏整块可提取（≤3 空格）', () => {
    const r = extractRefs('  ```bash\n  qiyu db tables\n  ```')
    expect(r.commands).toEqual([ref(['db', 'tables'], [], 2)])
  })
  it('缩进的闭合围栏能正常闭合，不把后续散文当围栏内容', () => {
    const r = extractRefs('```bash\nqiyu db tables\n  ```\n后续散文 qiyu nope x')
    expect(r.commands).toEqual([ref(['db', 'tables'], [], 2)])
  })
  it('嵌套围栏按长度配对：内层 ``` 不翻转外层 `````', () => {
    // ⚠️ 判别力：fixture 里的内层围栏**不带 info string**（` ``` ` 而不是 ` ```bash `），
    // 否则闭合判定先被 info string 挡掉，长度配对根本没被触发 —— 旧 fixture 是空转的
    // （审查 Minor-5）。变异「refs.ts 的 `close[1].length >= openLen` 去掉长度条件」→
    // 内层 ``` 提前闭合外层，`qiyu db tables` 落到围栏外（散文不扫裸文本）→ 本用例红。
    const r = extractRefs('`````\n```\nqiyu db tables\n```\n`````\n散文 qiyu nope x')
    expect(r.commands).toEqual([ref(['db', 'tables'], [], 3)])
  })
})

describe('护栏：围栏内的行内反引号（审查 Important-3）', () => {
  it('围栏里的行内代码命令能提取', () => {
    const r = extractRefs('```\n`qiyu db tables`\n```')
    expect(r.commands).toEqual([ref(['db', 'tables'], [], 2)])
  })
  it('shell 命令替换不引入噪声', () => {
    const r = extractRefs('```\necho `date`\n```')
    expect(r.commands).toEqual([])
    expect(r.kinds).toEqual([])
    expect(r.sqlSequences).toEqual([])
    expect(r.unverifiable).toEqual([])
  })
  it('同一行同一内容只记一次（裸文本与行内片段不双计 SQL）', () => {
    const r = extractRefs('```\n`SELECT * FROM x`\n```')
    expect(r.sqlSequences).toEqual([{ text: 'SELECT * FROM x', line: 2 }])
  })
  it('同一行两个相同片段只记一次', () => {
    expect(extractRefs('`qiyu db tables` 与 `qiyu db tables`').commands).toHaveLength(1)
  })
  it('裸命令与行内命令在同一行各自提取', () => {
    const r = extractRefs('```\nqiyu db tables `qiyu sync status`\n```')
    expect(r.commands.map((c) => c.tokens.join(' '))).toEqual(['db tables', 'sync status'])
  })
})

describe('护栏：跨行 SQL（审查 Minor-1）', () => {
  it('围栏内跨两行的 SELECT...FROM 按块记入', () => {
    const r = extractRefs('```sql\nSELECT id\nFROM sessions\n```')
    expect(r.sqlSequences).toEqual([{ text: 'SELECT id\nFROM sessions', line: 2 }])
  })
  it('单行 SQL 仍按行记，且不与块级双报', () => {
    const r = extractRefs('```\nSELECT * FROM x\n```')
    expect(r.sqlSequences).toEqual([{ text: 'SELECT * FROM x', line: 2 }])
  })
})

describe('护栏：flag 归一化（审查 Minor-2）', () => {
  it('等号形态按 = 切出 flag 名', () => {
    const r = extractRefs('`qiyu query --table=<表>`')
    expect(r.commands).toEqual([ref(['query', '--table=<表>'], [{ name: '--table', tokenIndex: 1 }], 1)])
  })
  it('flag 的紧邻字面值也进 tokens（是否取值由 check 层按 kind 判定）', () => {
    // 变异「refs 层继续吞掉 flag 紧邻的词」→ 本用例红（tokens 会少一个）。
    // ⚠️ 旧实现在这里吞掉 `sessions`，正是审查 A1 的根因：bool flag（`--full`）之后的
    // 位置参数也被吞，位置参数域校验整段失效。
    const r = extractRefs('`qiyu query --table sessions --since 7d`')
    expect(r.commands[0]!.tokens).toEqual(['query', '--table', 'sessions', '--since', '7d'])
    expect(flagNames(r)).toEqual(['--table', '--since'])
  })
  it('flag 的 token 下标指向 tokens 里的真实位置', () => {
    const r = extractRefs('`qiyu query --table sessions --since 7d`')
    expect(r.commands[0]!.flags).toEqual([
      { name: '--table', tokenIndex: 1 },
      { name: '--since', tokenIndex: 3 },
    ])
  })
  // —— 复审 F7 纠正：`-` 开头一律记为 flag（提取层不做「是不是取值」的判断）——
  //
  // 曾经改成「单横线只有单字母短旗才算」，前提是「`--since -7d` 是合法调用」——**前提是错的**：
  // 真实 CLI 对 `query --since -7d` 退 2（「--since 无法解析：-7d」）、对 `query --timeout -1`
  // 也退 2（「必须是非负数」）。若按那个改法，这两条非法调用会变成 check 零违规（漏报）。
  // 提取层只回答「哪些 token 长得像 flag」，取值合法性交给 check 层。
  it('`--since -7d` 里的 `-7d` 仍记为 flag（取值合法性不在本层判断）', () => {
    const r = extractRefs('`qiyu query --sql "SELECT 1" --since -7d`')
    expect(flagNames(r)).toEqual(['--sql', '--since', '-7d'])
  })
  it('`--timeout -1` 里的 `-1` 同样记为 flag', () => {
    const r = extractRefs('`qiyu query --table sessions --timeout -1`')
    expect(flagNames(r)).toEqual(['--table', '--timeout', '-1'])
  })
  it('单字母短旗 `-h` 记为 flag', () => {
    const r = extractRefs('`qiyu db tables -h`')
    expect(flagNames(r)).toEqual(['-h'])
  })
})

describe('护栏：围栏注释剥离（审查 Minor-4）', () => {
  it('行尾 # 注释不进 path', () => {
    const r = extractRefs('```\nqiyu sync status  # 看覆盖范围\n```')
    expect(r.commands).toEqual([ref(['sync', 'status'], [], 2)])
  })
  it('行尾注释里的 flag 不进 flags（否定语境不误报 rejected_flag）', () => {
    const r = extractRefs('```\nqiyu db tables  # 不要用 --pretty\n```')
    expect(r.commands).toEqual([ref(['db', 'tables'], [], 2)])
  })
  it('整行注释被剥掉，其中的 flag 不进 flags', () => {
    const r = extractRefs('```\n# 不要用 --pretty\nqiyu db tables\n```')
    expect(r.commands).toEqual([ref(['db', 'tables'], [], 3)])
  })
})

describe('护栏：行为决策固化（审查 Minor-3）', () => {
  it('qiyu --help 不记为命令（只有 flag 没路径）', () => {
    expect(extractRefs('`qiyu --help`').commands).toEqual([])
  })
  it('qiyu 只有占位符不记为命令（没有命令词）', () => {
    expect(extractRefs('`qiyu <子命令>`').commands).toEqual([])
  })
  it('未闭合围栏：余下内容按围栏扫（Minor-7 现行为钉住）', () => {
    const r = extractRefs('```\nqiyu db tables\n\nqiyu sync status 看覆盖范围。')
    expect(r.commands).toEqual([
      ref(['db', 'tables'], [], 2),
      ref(['sync', 'status', '看覆盖范围。'], [], 4),
    ])
  })
  it('CRLF 行尾不污染最后一个词', () => {
    const r = extractRefs('第一行\r\n`qiyu sync status`\r\n`qiyu query --table <表>`\r\n')
    expect(r.commands).toEqual([
      ref(['sync', 'status'], [], 2),
      ref(['query', '--table', '<表>'], [{ name: '--table', tokenIndex: 1 }], 3),
    ])
  })
  it('sqlSequences 按行升序：块级兜底混排时不乱序', () => {
    const r = extractRefs('```sql\nSELECT id\nFROM sessions\n```\ntail `SELECT * FROM x`')
    expect(r.sqlSequences.map((s) => s.line)).toEqual([2, 5])
  })
  it('qiyu 单列（无参数）不匹配命令形态', () => {
    expect(extractRefs('`qiyu`').commands).toEqual([])
    expect(extractRefs('`qiyu `').commands).toEqual([])
  })
})

describe('护栏：位置参数由 check 层重建（审查 A1）', () => {
  it('bool flag 之后的字面值仍留在 tokens 里（不吞）', () => {
    // 变异「refs 层对任何 flag 都吞下一个 token」→ 本用例红。
    const r = extractRefs('`qiyu sync run --full totally-bogus-task`')
    expect(r.commands[0]!.tokens).toEqual(['sync', 'run', '--full', 'totally-bogus-task'])
  })
  it('占位符留在 tokens 里（check 层靠它认出「取值是模板而不是缺值」）', () => {
    const r = extractRefs('`qiyu query --table <表> --since <时间>`')
    expect(r.commands[0]!.tokens).toEqual(['query', '--table', '<表>', '--since', '<时间>'])
  })
  it('等号形态的 flag 取值不占下一个 token', () => {
    const r = extractRefs('`qiyu query --table=sessions`')
    expect(r.commands[0]!.tokens).toEqual(['query', '--table=sessions'])
  })
  it('占位符判定导出：isPlaceholderToken 只认整词形态', () => {
    expect(isPlaceholderToken('<表>')).toBe(true)
    expect(isPlaceholderToken('--table=<表>')).toBe(false)
    expect(isPlaceholderToken('a<b')).toBe(false)
  })
})

describe('护栏：shell 复合 / 重定向符号降级为 warning（审查 A4）', () => {
  it('&& 判 unverifiable 而不是违规', () => {
    // 变异「UNVERIFIABLE_RE 不含 &&」→ 本用例红（会报 4 条 unknown_positional）。
    const r = extractRefs('`qiyu store init && qiyu sync run`')
    expect(r.commands).toEqual([])
    expect(r.unverifiable).toHaveLength(1)
  })
  it('; 判 unverifiable 而不是违规', () => {
    const r = extractRefs('`qiyu store init; qiyu sync run`')
    expect(r.commands).toEqual([])
    expect(r.unverifiable).toHaveLength(1)
  })
  it('> 判 unverifiable 而不是违规', () => {
    const r = extractRefs('`qiyu api list > /tmp/x.json`')
    expect(r.commands).toEqual([])
    expect(r.unverifiable).toHaveLength(1)
  })
  it('< 判 unverifiable 而不是违规', () => {
    const r = extractRefs('`qiyu api list < /tmp/in.json`')
    expect(r.commands).toEqual([])
    expect(r.unverifiable).toHaveLength(1)
  })
  it('占位符之后的 > 走「止步」而不是 unverifiable', () => {
    // 审查 brief 指定的用例：`>` 在占位符之后，已 break，不报违规也不报 warning。
    const r = extractRefs('`qiyu query --sql <SQL> > out.json`')
    expect(r.commands).toEqual([ref(['query', '--sql', '<SQL>'], [{ name: '--sql', tokenIndex: 1 }], 1)])
    expect(r.unverifiable).toEqual([])
  })
  it('引号里的 > 是数据（比较运算符），不当 shell 语法', () => {
    // 变异「hasShellOperator 不排除引号段」→ 本用例红（整条会被判 unverifiable，
    // 命令引用消失 —— 位置参数域校验也就跟着失效）。
    const r = extractRefs("`qiyu query --sql 'SELECT count(*) FROM x WHERE a > b'`")
    expect(r.unverifiable).toEqual([])
    expect(r.commands[0]!.tokens).toEqual(['query', '--sql', 'SELECT count(*) FROM x WHERE a > b'])
  })
  it('引号外的 > 仍算语法', () => {
    expect(extractRefs('`qiyu api list > x`').unverifiable).toHaveLength(1)
  })
  it('引号里有省略号也降级为 warning（静态判定不了）', () => {
    expect(extractRefs('`qiyu query --sql "SELECT * FROM x WHERE …"`').unverifiable).toHaveLength(1)
  })
  it('管道仍然按原口径判 unverifiable', () => {
    const r = extractRefs('`qiyu store init | tee log`')
    expect(r.unverifiable).toHaveLength(1)
  })
})

describe('collectSegments（Task 6 复用同一扫描面）', () => {
  it('围栏内行：整行裸文本是一个片段', () => {
    expect(collectSegments('```\nqiyu db tables\n```')).toEqual([{ text: 'qiyu db tables', line: 2 }])
  })
  it('围栏内行内反引号：片段内容不带反引号', () => {
    expect(collectSegments('```\n`qiyu db tables`\n```')).toEqual([{ text: 'qiyu db tables', line: 2 }])
  })
  it('缩进围栏：与 extractRefs 同面（同一片段只出现一次）', () => {
    expect(collectSegments('  ```bash\n  qiyu db tables\n  ```')).toEqual([{ text: 'qiyu db tables', line: 2 }])
  })
  it('散文只取行内代码，裸散文不进片段', () => {
    expect(collectSegments('散文 qiyu db tables 与 `qiyu sync status`')).toEqual([
      { text: 'qiyu sync status', line: 1 },
    ])
  })
})
