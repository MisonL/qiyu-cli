import { describe, it, expect } from 'vitest'
import { COMMAND_TREE } from '../../src/commands/tree.js'
import { GLOBAL_FLAGS } from '../../src/commands/spec-types.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// ⚠️ 位置约定：brief 原文 import `../../src/cli.js`；按 worktree 裁定（progress.md R1）改从
// `src/commands/tree.js` 取 —— 它只 import 各命令模块、不拉进 `cli.ts` 的入口逻辑，
// 将来 `src/skill/check.ts` 从同一处消费。本文件其余断言照 brief 原样。
const paths = COMMAND_TREE.map((s) => s.path.join(' ')).sort()
// 仓库测试统一用 `fileURLToPath(import.meta.url)` 定位源码（ESM 下没有 `__dirname`），
// brief 里的 `__dirname` 在 vitest ESM 中不可用，这里换成等价写法。
const srcRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'commands')

describe('COMMAND_TREE', () => {
  it('覆盖全部 16 条叶命令', () => {
    expect(paths).toEqual([
      'api call', 'api list', 'api schema', 'auth whoami', 'db describe', 'db tables',
      'query', 'stats fields', 'store init', 'store status',
      'sync install', 'sync run', 'sync status', 'sync tasks', 'sync uninstall', 'sync verify',
    ])
  })
  it('每条 spec 都带 --help/-h，且都拒绝 --pretty', () => {
    for (const s of COMMAND_TREE) {
      const names = s.flags.map((f) => f.name)
      expect(names, s.path.join(' ')).toContain('--help')
      expect(names, s.path.join(' ')).toContain('-h')
      expect(s.rejected, s.path.join(' ')).toContain('--pretty')
    }
  })
  it('api call 接受 --body/--yes/--no-validate/--strict，api list 只接受 --all', () => {
    const call = COMMAND_TREE.find((s) => s.path.join(' ') === 'api call')!
    expect(call.flags.map((f) => f.name)).toEqual(expect.arrayContaining(['--body', '--yes', '--no-validate', '--strict']))
    const list = COMMAND_TREE.find((s) => s.path.join(' ') === 'api list')!
    expect(list.flags.map((f) => f.name).filter((n) => !['--help', '-h', '--pretty'].includes(n))).toEqual(['--all'])
  })
  it('sync install 有 --schedule 与 --yes', () => {
    const s = COMMAND_TREE.find((x) => x.path.join(' ') === 'sync install')!
    expect(s.flags.map((f) => f.name)).toEqual(expect.arrayContaining(['--schedule', '--yes']))
  })
  it('db describe 与 stats fields 的位置参数域正确', () => {
    expect(COMMAND_TREE.find((s) => s.path.join(' ') === 'db describe')!.positionals[0].domain).toBe('tables')
    expect(COMMAND_TREE.find((s) => s.path.join(' ') === 'stats fields')!.positionals[0].domain).toBe('report-tables')
  })
  // 反漂移：每条 spec 的非全局 flag 必须能在对应命令模块的源码里找到字面量，
  // 否则说明 spec 是手抄的、与解析器脱节。
  //
  // ⚠️ 共享 flag 例外：存储定位三件套（`--db/--profile/--backend`）的**声明处**是
  // `spec-types.ts` 的 `STORE_FLAGS`（Task 2 把 db/store/stats 三份逐字相同的解析器收成
  // 一份，正是为了不在各命令模块里再抄字面量）。对这些 flag 查声明处，而不是逼实现者
  // 把副本加回去 —— 那会重新制造 Task 2 刚消灭的漂移。其余 flag 仍查命令模块本身。
  it('每个 flag 都在对应命令模块源码里以字面量出现', () => {
    const fileOf: Record<string, string> = {
      auth: 'auth.ts', api: 'api.ts', store: 'store.ts', sync: 'sync.ts', db: 'db.ts', query: 'query.ts', stats: 'stats.ts',
    }
    // flag 名 → 它的**声明文件**（缺省 = 命令模块自己）。
    const sharedSource: Record<string, string> = {
      '--db': 'spec-types.ts', '--profile': 'spec-types.ts', '--backend': 'spec-types.ts',
    }
    const extra = readFileSync(join(srcRoot, 'sync-run.ts'), 'utf8')
    const shared = readFileSync(join(srcRoot, 'spec-types.ts'), 'utf8')
    for (const s of COMMAND_TREE) {
      const file = s.path[0] === 'sync' && s.path[1] === 'run' ? extra : readFileSync(join(srcRoot, fileOf[s.path[0]]), 'utf8')
      for (const f of s.flags) {
        if (GLOBAL_FLAGS.some((g) => g.name === f.name)) continue
        const target = sharedSource[f.name] === undefined ? file : shared
        expect(target, `${s.path.join(' ')} 的 ${f.name}`).toContain(`'${f.name}'`)
      }
    }
  })
  // 错误文案与解析器同源，但**最终字符串**不得变：多处测试钉着「可用：…」的逐字文案
  // （`api.test.ts` / `readme.test.ts` 按字面量，`sync run` 的旧文案分隔符是空格不是「、」）。
  // 这里按**源文本**钉住渲染形态：分隔符写错时，运行时断言未必覆盖到（`sync run` 的
  // 「可用：」分支此前无任何测试）。
  it('「可用：」文案与解析器同源 —— sync run 空格分隔，api list 从常量渲染', () => {
    const runSrc = readFileSync(join(srcRoot, 'sync-run.ts'), 'utf8')
    expect(runSrc).toMatch(/renderFlagNames\(RUN_FLAGS, \{ separator: ' ' \}\)/)
    const apiSrc = readFileSync(join(srcRoot, 'api.ts'), 'utf8')
    // `readme.test.ts` 按源文本钉这一句：它必须保持字面量（含 `<JSON>` 占位符）。
    expect(apiSrc).toMatch(/可用：--body <JSON>、--yes、--no-validate、--strict/)
    expect(apiSrc).toMatch(/const LIST_AVAILABLE = renderFlagNames\(LIST_FLAGS\)/)
  })
  // 上一条保留了 `api call` 的字面量文案，这里把字面量与 spec 对齐：文案里点名的每个 flag
  // 都必须是 `api call` 的接受集成员，且名单不能漏（否则「可用：」会承诺一个不存在的 flag、
  // 或漏掉一个真实存在的）。`<JSON>` 是 `--body` 的取值占位符，剥掉再比。
  it('api call 字面量文案点名的 flag 与 spec 接受集完全一致', () => {
    const apiSrc = readFileSync(join(srcRoot, 'api.ts'), 'utf8')
    const line = apiSrc.match(/可用：(--body[^`\n]*)`/)?.[1] ?? ''
    const listed = line.split('、').map((s) => s.trim().split(' ')[0])
    const call = COMMAND_TREE.find((s) => s.path.join(' ') === 'api call')!
    const accepted = call.flags.map((f) => f.name).filter((n) => !GLOBAL_FLAGS.some((g) => g.name === n))
    expect(listed).toEqual(accepted)
  })
  // ⚠️ 与 brief 表格的一处刻意偏离，钉住以免被「改回去」：
  // brief 给 `sync uninstall` 列了 `STORE_FLAGS`，理由是「CLI 接受它们」——但实测不然：
  // `syncUninstall` 的解析是 `parseSubFlags(argv, [], ['--yes'])`，
  // `node dist/cli.js sync uninstall --db /tmp/x` → 退出码 2、`未知参数：--db`。
  // spec 若写上它们，`skill check` 会把 `qiyu sync uninstall --db …` 判为合法（实际必失败），
  // 正是它要防的假阴性。以解析器为准：只接受 `--yes`。
  it('sync uninstall 的接受集与解析器一致：只有 --yes，不含 store 三件套', () => {
    const s = COMMAND_TREE.find((x) => x.path.join(' ') === 'sync uninstall')!
    const business = s.flags.map((f) => f.name).filter((n) => !GLOBAL_FLAGS.some((g) => g.name === n))
    expect(business).toEqual(['--yes'])
  })
  // Task 1 复审 N-2 钉 tree 不变量：`findSpec` 用「tree 里还有更深 spec」判分组，
  // 若某条 spec 既是叶命令、又是更深的 spec 的前缀（如同时有 `['sync']` 与 `['sync','run']`），
  // 它会把 `sync --db x run`、甚至 `sync run` 之后的 flag 场景误判 —— 真实分派取 argv[0]
  // 当子命令，这种形状不可能在 spec 里正确表达。所以 tree 里不得出现。
  it('tree 不变量：不得存在既是叶命令、又是更深 spec 前缀的 path', () => {
    for (const s of COMMAND_TREE) {
      const isPrefixOfDeeper = COMMAND_TREE.some(
        (o) => o !== s && o.path.length > s.path.length && s.path.every((seg, i) => o.path[i] === seg),
      )
      expect(isPrefixOfDeeper, `${s.path.join(' ')} 同时是更深 spec 的前缀`).toBe(false)
    }
  })
})
