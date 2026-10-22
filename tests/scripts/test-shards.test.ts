// tests/scripts/test-shards.test.ts —— gap 9：固定分片 runner 的护栏此前**零覆盖**。
//
// ⚠️ **本文件绝不 spawn vitest**（2026-10-05 事故的直接原因：一份变异脚本循环调用
// `npx vitest run`，按 CPU 数起满 worker，64 GB 耗尽、Jetsam 杀掉 1414 个进程）。
// 所以这里只测 `scripts/test-shards.mjs` 导出的**纯函数**：
//   · `parseOptions`        —— 分片数/堆上限的解析、上限截断与告警、非法值
//   · `planShards`          —— 贪心装箱的「不重不漏」与片数上限
//   · `buildShardArgs`      —— spawn 参数表里三样防护逐字都在
//   · `aggregateExit`       —— 任一片失败 → 整体退 1（失败不得被分片掩盖）
// 这些函数是为此拆出来的（runner 入口 `main()` 仍照旧 spawn，不在测试里跑）。
//
// ⚠️ 用**静态** import：`.mjs` 在 `tsconfig.test.json` 的 `allowJs` 下可被解析，
// vitest 也能直接加载。曾试过「动态 import + beforeAll 赋值」，但 `describe` 回调在
// 收集期就执行、早于 `beforeAll`，模块级取值会是 undefined —— 静态导入没有这个时序坑。
import { describe, it, expect } from 'vitest'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import {
  MAX_SHARDS, parseOptions, planShards, buildShardArgs, aggregateExit,
} from '../../scripts/test-shards.mjs'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * `parseOptions` 的结果是 `{ shards, heapMb, warn? } | { error }` 联合 ——
 * `allowJs` 下 tsc 按字面量形状收窄，直接 `parsed.shards` 会被判「属性不存在」。
 * 这里统一成一个可索引的视图（用例里断言「该有/不该有」，收窄交给运行时）。
 */
type Parsed = { shards?: number; heapMb?: number; warn?: string; error?: string }
const opts = (env: Record<string, string>): Parsed => parseOptions(env) as Parsed

describe('parseOptions —— 分片数与堆上限', () => {
  it('缺省：4 片 / 2048 MB 堆，无告警', () => {
    expect(parseOptions({})).toEqual({ shards: 4, heapMb: 2048 })
  })

  it('合法值原样生效', () => {
    expect(parseOptions({ QIYU_TEST_SHARDS: '1' })).toEqual({ shards: 1, heapMb: 2048 })
    expect(parseOptions({ QIYU_TEST_SHARDS: '3', QIYU_TEST_HEAP_MB: '512' }))
      .toEqual({ shards: 3, heapMb: 512 })
  })

  // 上限是事故防护的一部分：「16 核起满 worker」正是事故形态，分片数不得随 CPU 放大。
  it('QIYU_TEST_SHARDS 超上限 → 截到 MAX_SHARDS 并带告警', () => {
    const parsed = opts({ QIYU_TEST_SHARDS: '99' })
    expect(parsed.shards).toBe(MAX_SHARDS)
    expect(MAX_SHARDS).toBeLessThan(99)
    expect(parsed.warn).toMatch(/超过上限/)
    expect(parsed.warn).toMatch(/99/)
    expect(parsed.error).toBeUndefined()
  })

  it('恰好等于上限 → 不告警', () => {
    const parsed = opts({ QIYU_TEST_SHARDS: String(MAX_SHARDS) })
    expect(parsed.shards).toBe(MAX_SHARDS)
    expect(parsed.warn).toBeUndefined()
  })

  // 非法值以 `{ error }` 返回，由入口 `readOptions()` 兑现为 `process.exit(2)`。
  // 纯函数化之后测试无需 spawn 一个真进程——这正是 gap 9 里「要么 spawn 要么抽函数」
  // 选择后者的理由。
  it('QIYU_TEST_SHARDS 非法（0 / 非整数 / 负数 / 非数字）→ error', () => {
    for (const bad of ['0', '-1', '2.5', 'abc', '']) {
      const parsed = opts({ QIYU_TEST_SHARDS: bad })
      expect(parsed.error, `QIYU_TEST_SHARDS=${JSON.stringify(bad)}`).toBeDefined()
      expect(parsed.error).toMatch(/QIYU_TEST_SHARDS/)
    }
  })

  it('QIYU_TEST_HEAP_MB 非法（< 256 / 非整数）→ error', () => {
    for (const bad of ['255', '0', '-1', '1.5', 'abc']) {
      const parsed = opts({ QIYU_TEST_HEAP_MB: bad })
      expect(parsed.error, `QIYU_TEST_HEAP_MB=${JSON.stringify(bad)}`).toBeDefined()
      expect(parsed.error).toMatch(/QIYU_TEST_HEAP_MB/)
    }
    // 恰好 256 合法（边界不是排除侧）
    expect(parseOptions({ QIYU_TEST_HEAP_MB: '256' })).toEqual({ shards: 4, heapMb: 256 })
  })
})

describe('planShards —— 贪心装箱的不重不漏', () => {
  // 合成文件表：用注入的 sizeOf 造权重（不在磁盘上造真实文件）。
  const sizes = new Map<string, number>([
    ['a.test.ts', 100], ['b.test.ts', 80], ['c.test.ts', 60],
    ['d.test.ts', 40], ['e.test.ts', 20], ['f.test.ts', 10],
  ])
  const files = [...sizes.keys()]
  const sizeOf = (f: string): number => sizes.get(f) ?? 0

  it('每个测试文件恰好落在一个分片里（不重不漏）', () => {
    for (const count of [1, 2, 3, 4, 6]) {
      const groups = planShards(files, count, sizeOf)
      const flat = groups.flat()
      expect(flat.sort(), `count=${count}`).toEqual([...files].sort())
      expect(new Set(flat).size, `count=${count}：有文件被分进两片`).toBe(files.length)
    }
  })

  it('分片数不超过上限；文件数少于片数时空片被剔除', () => {
    for (const count of [1, 2, 4]) {
      expect(planShards(files, count, sizeOf).length).toBeLessThanOrEqual(count)
    }
    // 6 个文件、8 片 → 最多 6 片（空片被过滤掉，不是 8 片里 2 片空跑）
    expect(planShards(files, 8, sizeOf).length).toBeLessThanOrEqual(files.length)
    expect(planShards(files, 8, sizeOf).every((g) => g.length > 0)).toBe(true)
  })

  it('贪心装箱：每片重量均衡，且不按遍历序切块', () => {
    const groups = planShards(files, 2, sizeOf)
    const weightOf = (g: string[]): number => g.reduce((s, f) => s + sizeOf(f), 0)
    // 总 310，两片理想各 155
    expect(Math.abs(weightOf(groups[0]) - weightOf(groups[1]))).toBeLessThanOrEqual(100)
    // 按遍历序切块会是 [a,b,c] / [d,e,f]（240 vs 70），贪心不会这么分
    expect(groups.map(weightOf)).not.toEqual([240, 70])
  })

  // ⚠️ 判别力钉在「先按大小降序」这一步（`planShards` 的 `sort` 行）。
  //
  // 贪心的「放进最轻一片」每次都会重新比较权重，所以只测「两片重量均衡」抓不到它 ——
  // 无排序的贪心同样均衡。真正的差别是：**大的先拿到座位**。用「五个 1 + 一个 3」这组
  // 权重（总和 8，两片理想各 4）：
  //   降序贪心 → 片内 [f(3),d] 与 [a,b,c,e]，重量 {4, 4}
  //   输入序贪心 → [a,c,e] 与 [b,d,f]，重量 {3, 5}
  // 权重多重集不同正是判别点。变异「删掉 sort」→ 这条必红。
  it('最重的文件先拿到座位（降序是装箱前提，变异：删掉 sort 必红）', () => {
    const w: Map<string, number> = new Map([
      ['a.test.ts', 1], ['b.test.ts', 1], ['c.test.ts', 1],
      ['d.test.ts', 1], ['e.test.ts', 1], ['f.test.ts', 3],
    ])
    const sz = (f: string): number => w.get(f) ?? 0
    const groups: string[][] = planShards([...w.keys()], 2, sz)
    const weights = groups
      .map((g) => g.reduce((s, f) => s + sz(f), 0))
      .sort((x, y) => x - y)
    expect(weights).toEqual([4, 4])          // 降序：总 8 恰好平分
    expect(weights).not.toEqual([3, 5])      // 输入序贪心的形态
    // 3 分的文件必须与一个 1 分同片（它在降序里第一个落座，独占重量 3 ≠ 4 就不均衡）
    const heavyGroup = groups.find((g) => g.includes('f.test.ts'))!
    expect(heavyGroup).toHaveLength(2)
  })

  it('分片内顺序 = 降序（重文件排在它那片的第一位）', () => {
    const w: Map<string, number> = new Map([
      ['small.test.ts', 1], ['big.test.ts', 100], ['mid.test.ts', 50],
    ])
    const sz = (f: string): number => w.get(f) ?? 0
    const groups: string[][] = planShards([...w.keys()], 2, sz)
    const bigGroup = groups.find((g) => g.includes('big.test.ts'))!
    expect(bigGroup[0]).toBe('big.test.ts')
  })

  it('缺省 sizeOf 读真实文件大小（真仓库的 tests/ 也能装）', () => {
    const real = [join(repoRoot, 'package.json'), join(repoRoot, 'vitest.config.ts')]
    const groups = planShards(real, 2)
    expect(groups.flat().sort()).toEqual(real.sort())
  })

  it('临时目录里的真实文件：大文件与小文件都被分到', () => {
    const dir = mkdtempSync(join(tmpdir(), 'qiyu-plan-'))
    try {
      const big = join(dir, 'big.test.ts')
      const small = join(dir, 'small.test.ts')
      writeFileSync(big, 'x'.repeat(4_000))
      writeFileSync(small, 'x')
      const groups = planShards([big, small], 2)
      expect(groups.length).toBe(2)
      expect(groups.flat().sort()).toEqual([big, small].sort())
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildShardArgs —— spawn 参数表里的三样事故防护', () => {
  const args = buildShardArgs({
    heapMb: 2048, vitestBin: '/repo/node_modules/vitest/vitest.mjs',
    files: ['tests/a.test.ts', 'tests/b.test.ts'],
  })

  // ① 堆上限（「无界增长」的笼子）。
  it('带 --max-old-space-size=<heapMb>', () => {
    expect(args[0]).toBe('--max-old-space-size=2048')
    // 非缺省值也要跟着变
    const custom = buildShardArgs({ heapMb: 512, vitestBin: 'v.mjs', files: [] })
    expect(custom[0]).toBe('--max-old-space-size=512')
  })

  // ② 单 worker（「按 CPU 起满 worker」的笼子）。
  it('带 --maxWorkers=1', () => {
    expect(args).toContain('--maxWorkers=1')
  })

  // ③ 文件不并行。
  it('带 --no-file-parallelism', () => {
    expect(args).toContain('--no-file-parallelism')
  })

  it('跑的是 vitest run + 本片的文件，文件逐个展开不是数组', () => {
    expect(args[1]).toBe('/repo/node_modules/vitest/vitest.mjs')
    expect(args[2]).toBe('run')
    expect(args.slice(3)).toContain('tests/a.test.ts')
    expect(args.slice(3)).toContain('tests/b.test.ts')
    expect(args.every((a) => typeof a === 'string')).toBe(true)
  })
})

describe('aggregateExit —— 失败不得被分片掩盖', () => {
  it('全部通过 → 0', () => {
    expect(aggregateExit([{ code: 0 }, { code: 0 }, { code: 0 }])).toBe(0)
  })

  // 只有一片失败也必须整体退 1：否则 CI 会绿着放行（分片掩盖静默失败）。
  it('任一片非 0 → 整体 1', () => {
    expect(aggregateExit([{ code: 0 }, { code: 1 }])).toBe(1)
    expect(aggregateExit([{ code: 0 }, { code: 2 }])).toBe(1)
    // 信号终止（code 归一为 1，见 runShard 的 `code ?? 1`）同样算失败
    expect(aggregateExit([{ code: 1 }, { code: 0 }])).toBe(1)
  })

  it('空结果 → 0（没有分片就没有失败；入口对「零测试文件」另走 2）', () => {
    expect(aggregateExit([])).toBe(0)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// 端到端：**真的执行 runner**，但把它要 spawn 的可执行目标换成一个**假的**。
//
// ⚠️ 红线（2026-10-05 事故）：这里**绝不**让 runner 调到真 vitest。做法是搭一个
// 临时 mini 仓库：
//   <tmp>/scripts/test-shards.mjs   ← 从真实仓库**逐字复制**（测的是真脚本）
//   <tmp>/node_modules/vitest/vitest.mjs ← **假的**：只记 argv、按环境变量定退出码
// 然后以 `<tmp>` 为 cwd 执行 `node scripts/test-shards.mjs`。真 vitest 从头到尾
// 不被调用 —— 假 bin 收到的只是文件路径字符串。
// 这一层覆盖的是纯函数测不到的「接线」：readOptions 的 exit 2、argv 真的带堆上限、
// 某片失败时整体退 1。
// ───────────────────────────────────────────────────────────────────────────
describe('端到端：真 runner + 假 vitest（绝不递归调真 vitest）', () => {
  /**
   * 假 vitest：把收到的 `execArgv`（Node 自身的 flag）与 `argv`（脚本参数）都记下来，
   * 退出码由 FAKE_VITEST_EXIT 决定。
   * ⚠️ `--max-old-space-size` 是 **Node 的 flag**（`process.execArgv`），不是脚本参数
   * （`process.argv`）—— 它必须出现在前者里才真的限制了堆。两者都要记，断言才完整。
   */
  const FAKE_VITEST = [
    "import { appendFileSync } from 'node:fs'",
    "const log = process.env.FAKE_VITEST_LOG ?? ''",
    "if (log !== '') appendFileSync(log, JSON.stringify(",
    "  { execArgv: process.execArgv, argv: process.argv.slice(2) }) + '\\n')",
    "process.exit(Number(process.env.FAKE_VITEST_EXIT ?? '0'))",
    '',
  ].join('\n')

  type Mini = { root: string; log: string }
  /** 搭 mini 仓库：真 runner + 假 vitest + `fileCount` 个测试文件。 */
  function makeMini(fileCount = 2): Mini {
    const root = mkdtempSync(join(tmpdir(), 'qiyu-shards-e2e-'))
    const runnerSrc = readFileSync(join(repoRoot, 'scripts', 'test-shards.mjs'), 'utf8')
    mkdirSync(join(root, 'scripts'), { recursive: true })
    writeFileSync(join(root, 'scripts', 'test-shards.mjs'), runnerSrc)
    mkdirSync(join(root, 'node_modules', 'vitest'), { recursive: true })
    writeFileSync(join(root, 'node_modules', 'vitest', 'vitest.mjs'), FAKE_VITEST)
    mkdirSync(join(root, 'tests'), { recursive: true })
    for (let i = 0; i < fileCount; i++) {
      // 大小递增：让贪心装箱有真实的权重差（同尺寸会让每片都等价，测不出装箱）
      writeFileSync(join(root, 'tests', `f${String(i).padStart(2, '0')}.test.ts`), 'x'.repeat(10 * (i + 1)))
    }
    return { root, log: join(root, 'vitest-argv.log') }
  }

  /** 在 mini 仓库里跑真 runner（子进程只是 node 跑那个 mjs，不是 vitest）。 */
  function runRunner(mini: Mini, env: Record<string, string>): { status: number; out: string } {
    // ⚠️ CI 里可能设了 QIYU_TEST_SHARDS=1（见 .github/workflows/ci.yml），本机也可能有 —
    // 先 **删掉** 再按用例注入。不能用空串覆盖：`Number('') === 0` 会被判成非法值。
    const childEnv: Record<string, string> = { ...process.env } as Record<string, string>
    delete childEnv.QIYU_TEST_SHARDS
    delete childEnv.QIYU_TEST_HEAP_MB
    Object.assign(childEnv, { FAKE_VITEST_LOG: mini.log }, env)
    const r = spawnSync(process.execPath, [join(mini.root, 'scripts', 'test-shards.mjs')], {
      cwd: mini.root, env: childEnv, encoding: 'utf8', timeout: 20_000,
    })
    return { status: r.status ?? -1, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
  }

  /** 读假 vitest 收到的全部调用（每行一个 `{ execArgv, argv }`）。 */
  function readCalls(mini: Mini): Array<{ execArgv: string[]; argv: string[] }> {
    if (!existsSync(mini.log)) return []
    return readFileSync(mini.log, 'utf8').trim().split('\n').filter((l) => l !== '')
      .map((l) => JSON.parse(l) as { execArgv: string[]; argv: string[] })
  }

  it('QIYU_TEST_SHARDS=0（非法）→ 退出码 2，且一个分片都没跑', () => {
    const mini = makeMini()
    try {
      const r = runRunner(mini, { QIYU_TEST_SHARDS: '0' })
      expect(r.status).toBe(2)
      expect(r.out).toMatch(/QIYU_TEST_SHARDS/)
      expect(readCalls(mini)).toEqual([])   // 没进到 spawn 那一步
    } finally {
      rmSync(mini.root, { recursive: true, force: true })
    }
  })

  it('全部片通过 → 退出码 0；每个分片进程都带堆上限与单 worker 防护', () => {
    const mini = makeMini()
    try {
      const r = runRunner(mini, { QIYU_TEST_SHARDS: '2', QIYU_TEST_HEAP_MB: '512' })
      expect(r.status).toBe(0)
      const calls = readCalls(mini)
      // 两个测试文件、2 片 → 2 次 spawn（空片被剔除）
      expect(calls.length).toBe(2)
      for (const { execArgv, argv } of calls) {
        // 堆上限是 Node 的 flag（execArgv），单 worker 与文件不并行是 vitest 的（argv）
        expect(execArgv).toContain('--max-old-space-size=512')
        expect(argv).toContain('--maxWorkers=1')
        expect(argv).toContain('--no-file-parallelism')
        expect(argv).toContain('run')
      }
      // 不重不漏：两个文件各被传到恰好一次
      const flat = calls.flatMap((c) => c.argv).filter((a) => a.endsWith('.test.ts')).sort()
      expect(flat).toEqual(['tests/f00.test.ts', 'tests/f01.test.ts'].sort())
    } finally {
      rmSync(mini.root, { recursive: true, force: true })
    }
  })

  it('某片失败 → 整体退出码 1（失败不被其余片掩盖）', () => {
    const mini = makeMini()
    try {
      const r = runRunner(mini, { QIYU_TEST_SHARDS: '2', FAKE_VITEST_EXIT: '1' })
      expect(r.status).toBe(1)
      expect(r.out).toMatch(/片失败/)
      expect(readCalls(mini).length).toBe(2)   // 两片都跑了（并行，不因一片失败就掐另一片）
    } finally {
      rmSync(mini.root, { recursive: true, force: true })
    }
  })

  it('QIYU_TEST_SHARDS=99 超上限 → 只跑上限内的片数并打告警', () => {
    const mini = makeMini(10)   // 10 个文件 > MAX_SHARDS：上限不生效时真会起 99 片
    try {
      const r = runRunner(mini, { QIYU_TEST_SHARDS: '99' })
      expect(r.status).toBe(0)
      expect(r.out).toMatch(/超过上限/)
      // 上限生效 → 恰好 MAX_SHARDS 次 spawn；上限被删掉则会是 99 次（这正是要红的情形）。
      expect(readCalls(mini).length).toBe(MAX_SHARDS)
    } finally {
      rmSync(mini.root, { recursive: true, force: true })
    }
  })

  it('import 本模块不触发任何 spawn（核对分片构成时不该顺手跑全量）', () => {
    const mini = makeMini()
    try {
      const script = join(mini.root, 'import-only.mjs')
      writeFileSync(script, "await import('./scripts/test-shards.mjs')\n")
      const r = spawnSync(process.execPath, [script], {
        cwd: mini.root, env: { ...process.env, FAKE_VITEST_LOG: mini.log }, encoding: 'utf8',
        timeout: 20_000,
      })
      expect(r.status).toBe(0)
      expect(readCalls(mini)).toEqual([])   // 假 vitest 一次都没被调
    } finally {
      rmSync(mini.root, { recursive: true, force: true })
    }
  })
})

