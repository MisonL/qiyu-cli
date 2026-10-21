import { describe, it, expect } from 'vitest'
import { collectSegments, extractRefs } from '../../src/skill/refs.js'

/**
 * `CommandRef` 的 `path` 与 `positionals` 是**同一串字面 token**（refs 层不认识命令树，
 * 切不出「命令词 / 位置参数」的分界；分界由 check 层按 `spec.path.length` 切）。
 * 这个辅助函数把这条不变量钉在一处，避免每条用例重复写两遍。
 */
const ref = (path: string[], flags: string[], line: number) => ({ path, positionals: path, flags, line })

describe('extractRefs', () => {
  it('提取命令路径与 flag', () => {
    const r = extractRefs('先跑 `qiyu sync status` 看覆盖范围。')
    expect(r.commands).toEqual([ref(['sync', 'status'], [], 1)])
  })
  it('flag 与占位符：只校验到占位符之前', () => {
    const r = extractRefs('用 `qiyu query --table <表> --since <时间>`。')
    expect(r.commands[0]).toMatchObject({ path: ['query'], flags: ['--table', '--since'] })
  })
  it('含管道或省略号的记为 unverifiable', () => {
    const r = extractRefs('`qiyu sync run | json`')
    expect(r.commands).toEqual([])
    expect(r.unverifiable[0].reason).toBe('含选择/省略符号')
  })
  it('围栏代码块也扫', () => {
    const r = extractRefs('```\nqiyu db tables\n```')
    expect(r.commands[0].path).toEqual(['db', 'tables'])
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
    expect(r.commands.map((c) => c.path.join(' '))).toEqual(['db tables', 'sync tasks'])
  })
})

describe('护栏：占位符之后的管道与省略号（审查 Important-1）', () => {
  it('管道右侧的 flag 不算进本命令：| head -20', () => {
    const r = extractRefs('`qiyu query --table <表> | head -20`')
    expect(r.commands).toEqual([ref(['query'], ['--table'], 1)])
    expect(r.unverifiable).toEqual([])
  })
  it('管道右侧的 flag 不算进本命令：| grep -v x', () => {
    expect(extractRefs('`qiyu query --table <表> | grep -v x`').commands[0]!.flags).toEqual(['--table'])
  })
  it('管道右侧的 flag 不算进本命令：| jq -r', () => {
    expect(extractRefs('`qiyu query --table <表> | jq -r .items`').commands[0]!.flags).toEqual(['--table'])
  })
  it('占位符后的管道不判 unverifiable（路径已封口，管道不影响命令结构）', () => {
    const r = extractRefs('`qiyu sync run <任务id> | head`')
    expect(r.commands).toEqual([ref(['sync', 'run'], [], 1)])
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
    const r = extractRefs('`````\n```bash\nqiyu db tables\n```\n`````')
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
    expect(r.commands.map((c) => c.path.join(' '))).toEqual(['db tables', 'sync status'])
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
    expect(r.commands).toEqual([ref(['query'], ['--table'], 1)])
  })
  it('flag 的紧邻字面值不当路径 token', () => {
    const r = extractRefs('`qiyu query --table sessions --since 7d`')
    expect(r.commands).toEqual([ref(['query'], ['--table', '--since'], 1)])
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
      ref(['query'], ['--table'], 3),
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

describe('护栏：位置参数字面值（终审 I1）', () => {
  it('字面位置参数进 positionals（与 path 同一串 token）', () => {
    const r = extractRefs('`qiyu db describe sessions`')
    expect(r.commands).toEqual([ref(['db', 'describe', 'sessions'], [], 1)])
  })
  it('占位符不是字面值：`qiyu db describe <表>` 的 positionals 只有命令词', () => {
    // 变异「占位符之前的 token 外，占位符本身也收进 positionals」→ 本用例红。
    expect(extractRefs('`qiyu db describe <表>`').commands[0]!.positionals).toEqual(['db', 'describe'])
  })
  it('flag 取值不是位置参数：`--table sessions` 的 sessions 不进 positionals', () => {
    // 变异「去掉 expectFlagValue 分支 / 把紧邻字面值也 push 进 positionals」→ 本用例红。
    const r = extractRefs('`qiyu query --table sessions`')
    expect(r.commands[0]!.positionals).toEqual(['query'])
  })
  it('占位符后的管道止步：管道右侧的 token 不进 positionals', () => {
    const r = extractRefs('`qiyu sync run <任务id> | head -20`')
    expect(r.commands[0]!.positionals).toEqual(['sync', 'run'])
  })
  it('等号形态的 flag 值不是位置参数', () => {
    expect(extractRefs('`qiyu query --table=sessions`').commands[0]!.positionals).toEqual(['query'])
  })
  it('多个位置参数保持出现顺序', () => {
    const r = extractRefs('`qiyu sync run a.task b.task`')
    expect(r.commands[0]!.positionals).toEqual(['sync', 'run', 'a.task', 'b.task'])
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
