import { describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { checkSkillDoc, checkSkillDir, type CheckContext } from '../../src/skill/check.js'
// 位置约定：brief 原文 import `../../src/cli.js`；按 worktree 裁定 R1 改从
// `src/commands/tree.js` 取（`cli.ts` 只是兼容 re-export，直接取权威位置不拉入 CLI 入口图）。
import { COMMAND_TREE } from '../../src/commands/tree.js'
import { TABLES } from '../../src/store/schema.js'
import { ERROR_KINDS } from '../../src/core/errors.js'
import { REPORT_TABLES } from '../../src/query/metric-catalog.js'
import { SYNC_TASKS } from '../../src/sync/registry.js'
import { allEndpoints } from '../../src/core/registry/index.js'

// 与 `commands/skill.ts` 的 `checkContext()` 同一份组装方式：五个取值域闭集从各自权威
// 位置取，`check.ts` 自己不认识它们（终审 I1 的分层要求）。
const ctx: CheckContext = {
  tree: COMMAND_TREE,
  tableNames: TABLES.map((t) => t.name),
  errorKinds: ERROR_KINDS,
  domains: {
    tables: TABLES.map((t) => t.name),
    'report-tables': REPORT_TABLES,
    'task-ids': SYNC_TASKS.map((t) => t.id),
    'endpoint-ids': allEndpoints().map((e) => e.id),
    'callable-endpoint-ids': allEndpoints().filter((e) => e.callable).map((e) => e.id),
  },
}

// 目录返回顺序在真实文件系统上不可控，没法用「反序写文件」验证 checkSkillDir 的排序。
// 用 vi.mock 把 readdirSync 换成可注入的代理：默认仍走真实实现（其余用例照常读临时目录），
// 排序用例里临时改成返回反序数组。`vi.hoisted` 供 mock 工厂与用例共享同一个可写引用。
const fsState = vi.hoisted(() => ({
  readdir: undefined as unknown as (path: string) => string[],
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  fsState.readdir = actual.readdirSync as unknown as (path: string) => string[]
  return { ...actual, readdirSync: (path: string) => fsState.readdir(path) }
})

describe('checkSkillDoc', () => {
  it('合规文档零违规', () => {
    const r = checkSkillDoc('先跑 `qiyu sync status`，再按 `kind: rate_limit` 分支。', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toEqual([])
  })
  it('未知命令 → unknown_command', () => {
    const r = checkSkillDoc('`qiyu nope foo`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'unknown_command' })
  })
  it('未知 flag → unknown_flag', () => {
    const r = checkSkillDoc('`qiyu api list --no-validate`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'unknown_flag', detail: expect.stringContaining('--no-validate') })
  })
  it('推荐 --pretty → rejected_flag', () => {
    const r = checkSkillDoc('`qiyu api list --pretty`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'rejected_flag' })
  })
  it('出现表名 → table_name', () => {
    const r = checkSkillDoc('查 `sessions` 表', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'table_name', detail: expect.stringContaining('sessions') })
  })
  it('出现 SQL 序列 → sql_sequence', () => {
    const r = checkSkillDoc('`SELECT id FROM x`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'sql_sequence' })
  })
  it('不存在的 kind → unknown_kind', () => {
    const r = checkSkillDoc('`kind: ambiguous`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'unknown_kind', detail: expect.stringContaining('ambiguous') })
  })
  it('无法静态判定的进 warnings 而非 violations', () => {
    const r = checkSkillDoc('`qiyu sync run | head`', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toHaveLength(1)
  })
  it('位置参数取值不在域闭集 → unknown_positional（接口 id）', () => {
    // 终审 I1 复现行 1：真实 CLI 会以「未知接口」退出 2，check 此前却判通过。
    const r = checkSkillDoc('`qiyu api call totally.bogus.id`', ctx)
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]).toMatchObject({
      rule: 'unknown_positional',
      detail: expect.stringContaining('totally.bogus.id'),
    })
    expect(r.violations[0]!.detail).toContain('endpoint-ids 闭集')
  })
  // G3 审查 C2：`api call` 与 `api schema` 的接口 id 域**不同**——
  // `api call` 只能调 callable 的（运行时 exit 2），`api schema` 对不可调用的同样合法（只查形状）。
  // 两条都钉住：只钉一侧时「两个域互换」或「都用全集」会有一侧活着。
  it('[C2] api call 调不可调用接口 → unknown_positional（运行时必然 exit 2）', () => {
    const nonCallable = allEndpoints().find((e) => !e.callable)!
    const r = checkSkillDoc(`\`qiyu api call ${nonCallable.id}\``, ctx)
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]).toMatchObject({
      rule: 'unknown_positional',
      detail: expect.stringContaining('callable-endpoint-ids 闭集'),
    })
  })
  it('[C2] api schema 查同一个不可调用接口 → 零违规（只查形状，合法）', () => {
    const nonCallable = allEndpoints().find((e) => !e.callable)!
    expect(checkSkillDoc(`\`qiyu api schema ${nonCallable.id}\``, ctx).violations).toEqual([])
  })
  it('[C2] api schema 查不存在的接口 → unknown_positional（全集域照样拦截）', () => {
    const r = checkSkillDoc('`qiyu api schema totally.bogus.id`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'unknown_positional' })
    expect(r.violations[0]!.detail).toContain('endpoint-ids 闭集')
  })
  it('位置参数取值不在域闭集 → unknown_positional（表名）', () => {
    // 终审 I1 复现行 3。
    const r = checkSkillDoc('`qiyu db describe totally_bogus_table`', ctx)
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]).toMatchObject({
      rule: 'unknown_positional',
      detail: expect.stringContaining('totally_bogus_table'),
    })
  })
  it('位置参数取值为真实接口 id / 表名时不报 unknown_positional', () => {
    // 变异「不比对闭集、只判有无位置参数」→ 第一条不会红；变异「闭集取反 / 用错域」→ 两条都红。
    const id = allEndpoints()[0]!.id
    expect(checkSkillDoc(`\`qiyu api call ${id}\``, ctx).violations).toEqual([])
    // 真实表名本身会命中 table_name（数据侧事实不得硬编码），这里只钉住位置参数域不误报。
    const table = TABLES[0]!.name
    const r = checkSkillDoc(`\`qiyu db describe ${table}\``, ctx)
    expect(r.violations.filter((v) => v.rule === 'unknown_positional')).toEqual([])
  })
  it('占位符不是字面位置参数：`qiyu db describe <表>` 不产生 unknown_positional', () => {
    // 变异「把占位符也当位置参数」→ 本用例红（`<表>` 会被判成不在 tables 闭集里）。
    const r = checkSkillDoc('`qiyu db describe <表>`', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toEqual([])
  })
  it('flag 取值不是位置参数：`qiyu query --table sessions` 不产生 unknown_positional', () => {
    // `sessions` 是 --table 的取值而非位置参数（`query` 的 positionals 是空数组）。
    // 变异「flag 紧邻字面值也进 positionals」→ 本用例红（query 没有位置参数 → 超量违规）。
    const r = checkSkillDoc('`qiyu query --table sessions`', ctx)
    expect(r.violations.filter((v) => v.rule === 'unknown_positional')).toEqual([])
  })
  it('位置参数个数超过 spec 声明 → unknown_positional', () => {
    // `api list` 不接受位置参数；`db describe` 只接受一个。
    const extraOnZero = checkSkillDoc('`qiyu api list bogus`', ctx)
    expect(extraOnZero.violations[0]).toMatchObject({
      rule: 'unknown_positional',
      detail: expect.stringContaining('bogus'),
    })
    expect(extraOnZero.violations[0]!.detail).toContain('只接受 0 个位置参数')
  })
  it('最后一个槽位 repeatable 时，超出的取值按它的域继续比（终审 fix 自查）', () => {
    // `sync run [任务...]` 接受任意多个真实任务 id——把两个合法 id 判成「超量」
    // 是对正确内容的误报，比漏报更糟。`db describe`（单槽位不 repeatable）
    // 的第二个参数仍然要报「只接受 1 个」。
    const twoTasks = checkSkillDoc('`qiyu sync run dim.staff dim.staff_groups`', ctx)
    expect(twoTasks.violations.filter((v) => v.rule === 'unknown_positional')).toEqual([])
    const twoTables = checkSkillDoc('`qiyu db describe sessions daily_overview`', ctx)
    const over = twoTables.violations.find((v) => v.rule === 'unknown_positional')
    expect(over, JSON.stringify(twoTables.violations)).toBeDefined()
    expect(over!.detail).toContain('只接受 1 个位置参数')
    // 变长槽位里的非法值仍要报：变长 ≠ 放弃校验。
    const badSecond = checkSkillDoc('`qiyu sync run dim.staff totally-bogus-task`', ctx)
    expect(badSecond.violations.filter((v) => v.rule === 'unknown_positional')).toHaveLength(1)
  })
  it('终审报告的四行复现现在全部报 unknown_positional', () => {
    // 这四行在真实 CLI 里分别退出 2（未知接口 / 未知任务 / 未知表 / 只接受报表域表）；
    // 合并成一份文档时 `unknown_positional` 必须恰好四条（排序后行号 1..4）。
    const doc = [
      '`qiyu api call totally.bogus.id`',
      '`qiyu sync run totally-bogus-task`',
      '`qiyu db describe totally_bogus_table`',
      '`qiyu stats fields totally_bogus_report`',
    ].join('\n')
    const r = checkSkillDoc(doc, ctx)
    expect(r.violations.map((v) => v.rule)).toEqual([
      'unknown_positional', 'unknown_positional', 'unknown_positional', 'unknown_positional',
    ])
    expect(r.violations.map((v) => v.line)).toEqual([1, 2, 3, 4])
  })
  it('单数 tag 不是表名，不生成 matcher（真正的词边界钉在下方边界用例）', () => {
    // 裁定：原 brief 用例写的是 `tags`（在 TABLES 里，必然命中 table_name），改为单数
    // `tag`（不在 TABLES、`tags` 在）。本用例只证明「不在 TABLES 的词不会被误判」，
    // 不构成词边界证据 —— 词边界 / 大小写 / 扫描面三个属性分别由下面三条用例钉住。
    const r = checkSkillDoc('这里是 tag 列表，不是 `tag` 表', ctx)
    expect(r.violations).toEqual([])
  })
  it('词边界：以表名结尾的标识符不命中 table_name（左 lookbehind）', () => {
    // 变异「正则去掉 (?<![\\w-])」→ 本用例红（`my_sessions` / `all_tags` 会命中）。
    // ⚠️ 审查 Minor 指出的判别力缺口：原用例 `staffing` 只钉住**右**边界，删掉左侧仍绿。
    const r = checkSkillDoc('`my_sessions` 与 `all_tags` 是内部标识符', ctx)
    expect(r.violations).toEqual([])
  })
  it('词边界：右边界（`staffing` 含表名 staff 但不命中 table_name）', () => {
    // 变异「正则去掉 (?![\\w-])」→ 本用例红。
    const r = checkSkillDoc('`staffing` 是英文单词', ctx)
    expect(r.violations).toEqual([])
  })
  it('大小写敏感：`Sessions` 不命中表名 sessions', () => {
    // 变异「RegExp 加 i」→ 本用例红。
    const r = checkSkillDoc('`Sessions` 是接口字段名', ctx)
    expect(r.violations).toEqual([])
  })
  it('只在代码面扫：散文里的 sessions 不算引用', () => {
    // 变异「把扫描面从 collectSegments 换成全文 text」→ 本用例红。
    const r = checkSkillDoc('这里直接写 sessions 不算引用', ctx)
    expect(r.violations).toEqual([])
  })
  it('表名含正则元字符时按字面匹配', () => {
    // 变异「正则不转义」→ `a.b` 会命中 `axb`，第一条断言红。
    const special: CheckContext = { ...ctx, tableNames: ['a.b'] }
    expect(checkSkillDoc('`axb`', special).violations).toEqual([])
    expect(checkSkillDoc('`a.b`', special).violations[0]).toMatchObject({ rule: 'table_name' })
  })
  it('表名与位置参数域不矛盾：真实接口 id 里的表名片段不报 table_name（审查 52）', () => {
    // `staff.list.new` 是**真实接口 id**（在 endpoint-ids 闭集里），但它的 `staff` 段
    // 恰好也是一张表名。旧正则只把 `[\w-]` 当词字符，`.` 不在其中 → 误报 table_name
    // 「出现表名 staff」，把**正确内容判成违规**。
    // 变异「点号边界 (?<!\\w\\.) / (?!\\.\\w) 去掉」→ 本用例红。
    const id = 'staff.list.new'
    expect(allEndpoints().some((e) => e.id === id)).toBe(true)
    const r = checkSkillDoc(`\`qiyu api schema ${id}\``, ctx)
    expect(r.violations).toEqual([])
  })
  it('点号边界：`dim.staff` 这类任务 id 不报 table_name（审查 52）', () => {
    // 变异「点号边界去掉」→ 本用例红（`staff` 前面是 `m.` → 旧正则命中）。
    const r = checkSkillDoc('`qiyu sync run dim.staff`', ctx)
    expect(r.violations.filter((v) => v.rule === 'table_name')).toEqual([])
  })
  it('点号边界：`staff.group.list.new` 不报 table_name（审查 52）', () => {
    const r = checkSkillDoc('`qiyu api schema staff.group.list.new`', ctx)
    expect(r.violations.filter((v) => v.rule === 'table_name')).toEqual([])
  })
  it('点号边界：句末的 `staff.` 仍命中 table_name（那确实是在提表名）', () => {
    // 右边界只排除「点号后紧跟词字符」，句末的点号不排除。
    const r = checkSkillDoc('查 `staff.` 的数据', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'table_name' })
  })
  it('点号边界：独立的 `staff` 仍命中 table_name', () => {
    const r = checkSkillDoc('查 `staff` 表', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'table_name' })
  })
  it('violations 按行升序（跨规则合并后排序）', () => {
    // kind 在第 1 行、表名在第 5 行；收集顺序是「表名先于 kind」，不排序时表名会排前面。
    const r = checkSkillDoc('`kind: ambiguous`\n\n\n\n查 `sessions` 表', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['unknown_kind', 'table_name'])
    expect(r.violations.map((v) => v.line)).toEqual([1, 5])
  })
})

describe('审查 A1：bool flag 不吞位置参数（位置参数域校验不得被架空）', () => {
  it('`sync run --full <未知任务>` → unknown_positional', () => {
    // 实测：旧 check 给 0 违规；真实 CLI `qiyu sync run --full no_such_task` 退出 2 未知任务。
    // 变异「check 层重建位置参数时把 bool flag 也当吃值的」→ 本用例红。
    const r = checkSkillDoc('`qiyu sync run --full no_such_task`', ctx)
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]).toMatchObject({
      rule: 'unknown_positional', detail: expect.stringContaining('no_such_task'),
    })
  })
  it('`sync run --quiet <未知任务>` → unknown_positional', () => {
    const r = checkSkillDoc('`qiyu sync run --quiet no_such_task`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['unknown_positional'])
  })
  it('`api call --yes <未知接口>` → unknown_positional（外加 flag 位置违规）', () => {
    // 真实 CLI：`qiyu api call --yes no.such.endpoint` 退出 2「接口 id 必须是第一个参数」。
    // 取值域这一层同样不能放过它（两处都不该判通过）。
    const r = checkSkillDoc('`qiyu api call --yes no.such.endpoint`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['flag_before_positional', 'unknown_positional'])
  })
  it('正例：bool flag 之后是合法任务 id → 零违规', () => {
    // 误报方向同样要守：`--full` 是 bool，`dim.staff` 回到位置参数后按 task-ids 域校验通过。
    const r = checkSkillDoc('`qiyu sync run --full dim.staff`', ctx)
    expect(r.violations).toEqual([])
  })
  it('正例：bool flag 夹在两个合法任务之间 → 零违规', () => {
    expect(checkSkillDoc('`qiyu sync run dim.staff --quiet dim.staff_groups`', ctx).violations).toEqual([])
  })
  it('值位 flag 仍吞一个取值：`sync run --since 7d <未知任务>` → unknown_positional', () => {
    // 变异「value flag 也不吞」→ 本用例红（`7d` 会被当成任务 id 报违规）。
    const r = checkSkillDoc('`qiyu sync run --since 7d no_such_task`', ctx)
    expect(r.violations).toHaveLength(1)
    expect(r.violations[0]).toMatchObject({ detail: expect.stringContaining('no_such_task') })
  })
  it('未知 flag 不吞后面的值：`sync run --bogus dim.staff` 只报 unknown_flag', () => {
    // 未知 flag 已会报 unknown_flag，再把 `dim.staff` 吞掉只会掩盖位置参数的问题。
    const r = checkSkillDoc('`qiyu sync run --bogus dim.staff`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['unknown_flag'])
  })
  it('值位 flag 缺取值 → flag_missing_value（`db tables --db`）', () => {
    // 实测：旧 check 0 违规；真实 CLI `qiyu db tables --db` 退出 2「--db 缺少取值」。
    // 变异「缺值不报」→ 本用例红。
    const r = checkSkillDoc('`qiyu db tables --db`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['flag_missing_value'])
    expect(r.violations[0]!.detail).toContain('--db')
  })
  it('值位 flag 后紧跟另一个 flag → flag_missing_value（`db tables --db --profile p`）', () => {
    const r = checkSkillDoc('`qiyu db tables --db --profile p`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['flag_missing_value'])
  })
  it('占位符是取值模板，不算缺值：`db describe <表> --db <路径>` 零违规', () => {
    const r = checkSkillDoc('`qiyu db describe <表> --db <路径>`', ctx)
    expect(r.violations).toEqual([])
  })
  it('等号形态的 flag 取值不算缺值：`query --table=<表> --limit=10` 零违规', () => {
    expect(checkSkillDoc('`qiyu query --table=<表> --limit=10`', ctx).violations).toEqual([])
  })
})

describe('审查 A2：引号取值（合法文档不得被判违规）', () => {
  it('CRON 取值含空格 → 零违规', () => {
    // 实测：旧 check 报 4 条 unknown_positional（「多出的不接受：3 / * / * / *"」）。
    // 变异「切词改回 split(/\\s+/)」→ 本用例红。
    const r = checkSkillDoc('`qiyu sync install --schedule "0 3 * * *"`', ctx)
    expect(r.violations).toEqual([])
  })
  it('JSON body 含空格 → 零违规', () => {
    // 实测：旧 check 报 3 条 unknown_positional。
    const r = checkSkillDoc(`\`qiyu api call ticket.search --body '{"opStart": 1, "opEnd": 2}'\``, ctx)
    expect(r.violations).toEqual([])
  })
  it('围栏里的 CRON 同样零违规', () => {
    const r = checkSkillDoc('```bash\nqiyu sync install --schedule "0 3 * * *"\n```', ctx)
    expect(r.violations).toEqual([])
  })
  it('引号内的 # 不被当注释截断', () => {
    // 实测：旧实现把取值从 `#` 处截断，产出 `#` / `b"}'` 两条假位置参数。
    // 变异「stripComment 去掉引号保护」→ 本用例红。
    const r = checkSkillDoc("```\nqiyu api call ticket.search --body '{\"keyword\":\"a # b\"}'\n```", ctx)
    expect(r.violations).toEqual([])
  })
  it('反例：未加引号的 JSON 仍按多个位置参数判违规', () => {
    // 修复不能变成「什么都放过」：不写引号时 shell 真的会把取值拆开，判违规是对的。
    const r = checkSkillDoc('`qiyu api call ticket.search --body {"opStart": 1}`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['unknown_positional'])
  })
  it('反例：引号里的未知任务照样报 unknown_positional', () => {
    const r = checkSkillDoc('`qiyu sync run "no such task"`', ctx)
    expect(r.violations[0]).toMatchObject({ rule: 'unknown_positional' })
  })
})

describe('审查 A3：flag 的位置（写在子命令位 / 第一个位置参数位必失败）', () => {
  it('`db --profile prod tables` → flag_before_subcommand', () => {
    // 实测：旧 check 0 违规；真实 CLI 退出 2「未知子命令：--profile」。
    // 变异「findSpec 之前把 flag 剥掉 / 不做 flag 位置判定」→ 本用例红。
    const r = checkSkillDoc('`qiyu db --profile prod tables`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['flag_before_subcommand'])
    expect(r.violations[0]!.detail).toContain('--profile')
  })
  it('`sync --db /tmp/x.duckdb run` → flag_before_subcommand', () => {
    const r = checkSkillDoc('`qiyu sync --db /tmp/x.duckdb run`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['flag_before_subcommand'])
  })
  it('`db --profile tables`（无取值，flag 之后就是子命令名）→ flag_before_subcommand', () => {
    const r = checkSkillDoc('`qiyu db --profile tables`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['flag_before_subcommand'])
  })
  it('`api call --yes ticket.search` → flag_before_positional（接口 id 必须是第一个参数）', () => {
    const r = checkSkillDoc('`qiyu api call --yes ticket.search`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['flag_before_positional'])
    expect(r.violations[0]!.detail).toContain('--yes')
  })
  it('`api call --body <JSON> ticket.search` → flag_before_positional', () => {
    const r = checkSkillDoc('`qiyu api call --body <JSON> ticket.search`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['flag_before_positional'])
  })
  it('正例：`api call ticket.search --yes` 零违规', () => {
    expect(checkSkillDoc('`qiyu api call ticket.search --yes`', ctx).violations).toEqual([])
  })
  it('正例：其余命令 flag 与位置参数可交错（`sync run --full dim.staff`）', () => {
    expect(checkSkillDoc('`qiyu sync run --full dim.staff`', ctx).violations).toEqual([])
  })
  it('正例：`db tables --profile prod`（flag 在命令词之后）零违规', () => {
    expect(checkSkillDoc('`qiyu db tables --profile prod`', ctx).violations).toEqual([])
  })
  it('全局 flag 写在子命令位：与真实 CLI 一致地报（`qiyu --pretty api list` 真实退出 2）', () => {
    // ⚠️ 旧用例写的是「不误报 flag_before_subcommand」—— 那与真实 CLI 相反：顶层 `run()`
    // 把 argv[0] 当子命令，`--pretty` 走的是「--pretty 不接受额外参数」分支，退出码 2。
    // 所以这一行本来就该失败，只是失败原因不是 rejected_flag。两条都要报。
    const r = checkSkillDoc('`qiyu --pretty api list`', ctx)
    expect(r.violations.map((v) => v.rule)).toEqual(['rejected_flag', 'flag_before_subcommand'])
  })
})

describe('审查 A4：&& / ; / > / < 降级为 warning（与 | 一致）', () => {
  it('`store init && sync run` → warning，零违规', () => {
    // 实测：旧 check 报 4 条 unknown_positional。
    // 变异「UNVERIFIABLE_RE 不含 &&」→ 本用例红。
    const r = checkSkillDoc('`qiyu store init && qiyu sync run`', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toHaveLength(1)
  })
  it('`store init; sync run` → warning，零违规', () => {
    // 实测：旧 check 报 unknown_command「未知命令：qiyu store init; qiyu sync run」。
    const r = checkSkillDoc('`qiyu store init; qiyu sync run`', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toHaveLength(1)
  })
  it('`api list > /tmp/x.json` → warning，零违规', () => {
    // 实测：旧 check 报 2 条 unknown_positional。
    const r = checkSkillDoc('`qiyu api list > /tmp/x.json`', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toHaveLength(1)
  })
  it('`api list < /tmp/in.json` → warning，零违规', () => {
    const r = checkSkillDoc('`qiyu api list < /tmp/in.json`', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toHaveLength(1)
  })
  it('占位符之后的重定向：`query --sql <SQL> > out.json` 既不报违规也不报 warning', () => {
    // brief 指定用例：`>` 在占位符之后，扫描已止步。
    const r = checkSkillDoc('`qiyu query --sql <SQL> > out.json`', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toEqual([])
  })
  it('引号外的单个 < 与 > 都降级（`query --sql <SQL` 之外的裸符号）', () => {
    expect(checkSkillDoc('`qiyu api list >x`', ctx).warnings).toHaveLength(1)
    expect(checkSkillDoc('`qiyu api list <x`', ctx).warnings).toHaveLength(1)
  })
  it('等号形态的占位符不被 `>` 误伤：`query --table=<表>` 零违规零 warning', () => {
    // `--table=<表>` 里的 `<`/`>` 是模板括号，不是重定向。
    const r = checkSkillDoc('`qiyu query --table=<表>`', ctx)
    expect(r.violations).toEqual([])
    expect(r.warnings).toEqual([])
  })
  it('引号里的 > 是数据（比较运算符），不降级也不报违规', () => {
    // shell 语义：`--sql 'SELECT a > b'` 的 `>` 在引号里，不是重定向。
    const r = checkSkillDoc("`qiyu query --sql 'SELECT count(*) FROM x WHERE a > b'`", ctx)
    expect(r.violations.filter((v) => v.rule !== 'sql_sequence')).toEqual([])
  })
})

describe('审查 52：表名扫描与位置参数取值域不矛盾', () => {
  it('真实接口 id `staff.list.new` 里的 staff 段不报 table_name', () => {
    // 变异「表名正则去掉点号边界」→ 本用例红。
    const r = checkSkillDoc('`qiyu api schema staff.list.new`', ctx)
    expect(r.violations).toEqual([])
  })
  it('任务 id `dim.staff` 不报 table_name（三个变体）', () => {
    for (const doc of ['`qiyu sync run dim.staff`', '`qiyu sync run dim.staff dim.staff_groups`',
      '`qiyu sync run dim.staff_groups`']) {
      expect(checkSkillDoc(doc, ctx).violations, doc).toEqual([])
    }
  })
  it('`staff.group.list.new` 不报 table_name', () => {
    expect(checkSkillDoc('`qiyu api schema staff.group.list.new`', ctx).violations).toEqual([])
  })
  it('真正的表名仍要报：`staff` / 句末 `staff.` / 散文里的 staff', () => {
    for (const doc of ['查 `staff` 表', '查 `staff.` 的数据', '看 `the staff table`']) {
      const r = checkSkillDoc(doc, ctx)
      expect(r.violations[0], doc).toMatchObject({ rule: 'table_name', detail: expect.stringContaining('staff') })
    }
  })
  it('左边界：`my_sessions` / `all_tags` 不报 table_name', () => {
    expect(checkSkillDoc('`my_sessions` 与 `all_tags`', ctx).violations).toEqual([])
  })
})

describe('审查 13：checkSkillDir 递归子目录', () => {
  it('子目录里的未知命令要被校验，detail 带子目录前缀', () => {
    // 变异「collectMarkdownFiles 不递归」→ 本用例红（子目录里的违规看不见）。
    const dir = mkdtempSync(join(tmpdir(), 'qiyu-skill-check-'))
    try {
      mkdirSync(join(dir, 'references'))
      writeFileSync(join(dir, 'SKILL.md'), '# 入口\n')
      writeFileSync(join(dir, 'references', 'a.md'), '第一行\n`qiyu nope sub`\n')
      const r = checkSkillDir(dir, ctx)
      expect(r.violations).toHaveLength(1)
      expect(r.violations[0]).toMatchObject({ line: 2, rule: 'unknown_command' })
      expect(r.violations[0]!.detail).toContain('references/a.md:2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('多级子目录、隐藏目录与隐藏文件不参与', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qiyu-skill-check-'))
    try {
      mkdirSync(join(dir, 'references', 'deep'), { recursive: true })
      mkdirSync(join(dir, '.draft'))
      writeFileSync(join(dir, 'references', 'deep', 'b.md'), '`qiyu nope deep`\n')
      writeFileSync(join(dir, '.draft', 'c.md'), '`qiyu nope hidden-dir`\n')
      writeFileSync(join(dir, '.hidden.md'), '`qiyu nope hidden-file`\n')
      const r = checkSkillDir(dir, ctx)
      expect(r.violations.map((v) => v.detail.split(' ')[0])).toEqual(['references/deep/b.md:1'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('符号链接：指向目录内的收，指向目录外的不收', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qiyu-skill-check-'))
    const outside = mkdtempSync(join(tmpdir(), 'qiyu-skill-outside-'))
    try {
      mkdirSync(join(dir, 'references'))
      writeFileSync(join(dir, 'references', 'a.md'), '`qiyu nope inside`\n')
      writeFileSync(join(outside, 'evil.md'), '`qiyu nope outside`\n')
      symlinkSync(join(dir, 'references'), join(dir, 'linked'))
      symlinkSync(outside, join(dir, 'escape'))
      const r = checkSkillDir(dir, ctx)
      // 同一份 `references/a.md` 经两条路径各扫一次：detail 里报告的是**逻辑路径**，
      // 用户按原样就能找到文件（realpath 化的写法会冒出 tmpdir 的绝对路径）。
      expect(r.violations.map((v) => v.detail.split(' ')[0])).toEqual([
        'linked/a.md:1', 'references/a.md:1',
      ])
      expect(r.violations.every((v) => v.detail.includes('inside'))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})

describe('checkSkillDir', () => {
  it('只读 .md，detail 带「文件:行」前缀', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qiyu-skill-check-'))
    try {
      writeFileSync(join(dir, 'a.md'), '第一行\n`qiyu nope`\n')
      writeFileSync(join(dir, 'b.md'), '`qiyu sync run | head`\n')
      writeFileSync(join(dir, 'c.txt'), '`qiyu nope txt`\n')
      const r = checkSkillDir(dir, ctx)
      expect(r.violations).toHaveLength(1)
      expect(r.violations[0]).toMatchObject({ line: 2, rule: 'unknown_command' })
      expect(r.violations[0]!.detail).toContain('a.md:2')
      expect(r.warnings).toHaveLength(1)
      expect(r.warnings[0]!.detail).toContain('b.md:1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
  it('按文件名排序，不依赖 readdirSync 的返回顺序', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qiyu-skill-check-'))
    const realReaddir = fsState.readdir
    try {
      writeFileSync(join(dir, 'a.md'), '`qiyu nope a`\n')
      writeFileSync(join(dir, 'b.md'), '`qiyu nope b`\n')
      // 变异「删掉 collectMarkdownFiles 里的 .sort()」→ 输出按 ['b.md','a.md'] 的顺序，本用例红。
      fsState.readdir = () => ['b.md', 'a.md']
      const r = checkSkillDir(dir, ctx)
      expect(r.violations.map((v) => v.detail.split(' ')[0])).toEqual(['a.md:1', 'b.md:1'])
    } finally {
      fsState.readdir = realReaddir
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
