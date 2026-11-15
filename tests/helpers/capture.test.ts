// tests/helpers/capture.test.ts
//
// 守卫 `tests/helpers/capture.ts` 本身。⚠️ 每条用例都**自包含**——不依赖"上一条先跑过"，
// 这样 `vitest -t '某条'` 单独选一条也能跑（CodeRabbit 2026-11-13 minor）。
//
// 两个事故形态：
// ① 上一条用例发出、尚未 resolve 的异步调用在它结束后才执行，写入落进**下一条**
//    的缓冲（实测 `out="FRESHTAIL"`、`writes=2`）。关键在于延迟回调**在运行时才查**
//    `process.stdout.write`（CodeRabbit major），只保存旧引用测不出来。
// ② 用户的 `afterEach(restoreAllMocks)` 摘掉 spy 后，助手若不重装，写入直接绕过缓冲。
import { describe, it, expect, vi } from 'vitest'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startCapture, captureInstalled } from './capture.js'
import { argRange, blankComments } from './source-scan.js'

// ⚠️ 文件结束时 `process.stdout.write` 必须已恢复（Codex 2026-11-13 P2：vitest 2.1.9
// 默认 `restoreMocks:false`，不恢复的话同 worker 的**下一个测试文件**会把写入记进
// 本文件最后一个捕获）。恢复由 `capture.ts` 顶层注册的 `afterAll` 负责。
//
// ⚠️ 不能用 `afterAll` 里的断言来钉它：实测 vitest 2.1.9 只打印这类断言错误、
// **退出码仍是 0（用例算通过）**，等于假守卫。改为在**最后一条用例**里测：
// 调一次 `vi.restoreAllMocks()`（模拟文件结束），再断言助手的判据认为「已恢复」——
// 删掉 capture.ts 的 afterAll 不影响这条，所以它测的是**判据本身**是否正确；
// 真正的跨文件行为见 capture.ts 注释里的实测。

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('tests/helpers/capture.ts', () => {
  it('本条写入原样入账（正向，最小形态）', async () => {
    const cap = startCapture()
    await cap.run(async () => {
      process.stdout.write('{"a":1}')
      expect(cap.out).toBe('{"a":1}')
      expect(cap.writes).toBe(1)
    })
  })

  it('另一条用例的尾巴记回它自己，不进本条（事故形态 ①）', async () => {
    // 用例 A：发一条 60ms 后才落地、且**运行时才查 write** 的尾巴。
    const a = startCapture()
    let tail: Promise<void> = Promise.resolve()
    await a.run(async () => {
      tail = new Promise<void>((resolve) => {
        setTimeout(() => { process.stdout.write('TAIL'); resolve() }, 60)
      })
      await tick(1) // A 结束时尾巴尚未落地
    })
    // 用例 B：等尾巴落地，看它记到谁头上。
    const b = startCapture()
    await b.run(async () => {
      process.stdout.write('FRESH')
      await tail
      await tick(20)
      expect(b.out, '本条缓冲里绝不能出现 A 的尾巴').toBe('FRESH')
      expect(b.writes).toBe(1)
      expect(a.out, 'A 的尾巴必须落回 A 自己的捕获').toBe('TAIL')
    })
  })

  it('中间隔着别的用例也不串（尾巴按发起者归账，不按「上一条」）', async () => {
    const a = startCapture()
    let tail: Promise<void> = Promise.resolve()
    await a.run(async () => {
      tail = new Promise<void>((resolve) => { setTimeout(() => { process.stdout.write('T2'); resolve() }, 60) })
      await tick(1)
    })
    const middle = startCapture()
    await middle.run(async () => {
      process.stdout.write('M')
      await tick(120) // 尾巴在中间用例期间落地
      expect(middle.out, '中间用例不得收到别的用例的尾巴').toBe('M')
    })
    expect(a.out).toBe('T2')
  })

  it('用户调过 restoreAllMocks 之后仍能捕获（事故形态 ②）', () => {
    startCapture()
    vi.restoreAllMocks()
    const cap = startCapture()
    cap.run(() => process.stdout.write('X'))
    expect(cap.out, '恢复后若不重装 spy，写入会绕过缓冲').toBe('X')
  })

  it('恢复之后 `captureInstalled()` 必须为 false（判据本身）', () => {
    startCapture()
    expect(captureInstalled()).toBe(true)
    vi.restoreAllMocks()
    expect(captureInstalled(), '恢复后必须认为已卸载').toBe(false)
  })

  it('回调式写入必须被回调掉（Node stream 契约；否则等待它的用例只能超时）', async () => {
    const cap = startCapture()
    await cap.run(async () => {
      await new Promise<void>((resolve) => { process.stdout.write('X', () => resolve()) })
      // Node 运行时支持三参数形态，但 @types/node 的 stdout 重载没列出它 ——
      // 按 unknown 调用以覆盖这条运行路径。
      await new Promise<void>((resolve) => { (process.stdout.write as unknown as (c: string, e: string, cb: () => void) => boolean)('Y', 'utf8', resolve) })
      await new Promise<void>((resolve) => { process.stderr.write('E', () => resolve()) })
      expect(cap.out).toBe('XY')
      expect(cap.err).toBe('E')
    })
  })

  it('本条自己的 stderr 照常入账', async () => {
    const cap = startCapture()
    await cap.run(async () => {
      process.stderr.write('NEW-ERR')
      expect(cap.err).toBe('NEW-ERR')
    })
  })

  // ⚠️ **跨文件**这条没有守卫 —— 不是没查，是查了、**结构上不可达**（CodeRabbit 2026-11-14
  // major 要求核查）。实测证据（2026-11-14）：
  //   ① 每个测试文件一个独立环境：文件 A 写在 `globalThis` 上的东西，文件 B 里读不到；
  //      同一个 helper 模块在两个文件里各加载一次（函数对象身份不同）。
  //   ② 执行顺序可以强制（临时 config + 升序 sequencer 已验证 A → B），但即便顺序对了，
  //      B 也拿不到 A 留下的那个 Promise —— 因为 `globalThis` 不共享。
  //   ③ 文件 A 结束时它的定时器随环境销毁，不会在 B 里触发。
  // 所以「上一条用例的尾巴漏进下一个文件」在这个配置下没有到达路径，写一条跨文件守卫只能是
  // 假绿（我写过一个，先是通过，后来把「B 必须拿到 A 的尾巴」这一条钉上后立刻红 —— 那正是
  // ②的证据）。真正的跨用例隔离见上面几条守卫（同文件内、尾巴真的落地）。
  // 若将来有人改 vitest 配置成单环境（`isolate: false`），这条边界要重新评估。
})

/**
 * 静态守卫：迁移形态（`captureSinks`）的两个**结构性**边界不得被"顺手"踩到。
 *
 * 两条都是 Sourcery 在 PR#72 提的，机制上无法在助手里兜住（见下面各自的说明），
 * 所以改成**禁止那种写法落地** —— 与本仓库既有的静态漂移守卫同一手法。
 */
describe('静态守卫：captureSinks 的两条边界不得被踩（Sourcery PR#72）', () => {
  const SRC_TESTS = fileURLToPath(new URL('../', import.meta.url))

  /** 递归取测试文件（跳过 fixtures / helpers 自身）。 */
  function testFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'fixtures') testFiles(p, out); continue }
      if (e.name.endsWith('.test.ts')) out.push(p)
    }
    return out
  }

  /** 调度形态（不论是否 await）：定时器 / 微任务 / 浮空 promise。 */
  const SCHEDULING = /\b(?:setTimeout|setInterval|setImmediate|queueMicrotask)\s*\(|\.then\s*\(|\bvoid\s+[a-zA-Z_$]/g

  /**
   * hook 体里**真正危险**的调度：把「已 await / 已 return 的调度」排除掉。
   *
   * ⚠️ 为什么要区分（CodeRabbit + Codex PR#81）：`beforeEach(async () => { await new
   * Promise((r) => setTimeout(r, 80)) })` 这种写法**不会**留下跨用例尾巴 —— vitest 会等
   * hook 的 promise 落定。此前一视同仁地报 `setTimeout(`，等于让"按提示把活 await 完"的
   * 人照样红，提示与判据自相矛盾。
   * 判据：看该调度所在的**语句**（回扫到最近的 `;` / `{` / `}` / 行首）里有没有
   * `await` / `return`。有 → 视为已等待；没有 → 脱手调度。
   * 边界如实记录（不做类型分析、不跟跨语句）：`const p = new Promise(…); await p` 这种
   * 「先存再 await」的写法会被判成危险（误报方向），以及 hook 调用的辅助函数内部排
   * 定时器完全看不出来（漏报方向）。
   */
  function hazardHits(body: string): Array<{ token: string; awaited: boolean }> {
    const out: Array<{ token: string; awaited: boolean }> = []
    for (const m of body.matchAll(SCHEDULING)) {
      const at = m.index!
      let start = at
      while (start > 0 && !';{}\n'.includes(body[start - 1]!)) start--
      // ① 语句里有 await / return → 已交付；
      // ② 写法是**表达式体箭头**（`beforeEach(() => Promise…then(…)`）：整个表达式就是
      //    hook 的返回值，vitest 会等它 —— 判据是"匹配点之前都没有 `{`"。
      const awaited = /\b(?:await|return)\b/.test(body.slice(start, at))
        || !body.slice(0, at).includes('{')
      out.push({ token: m[0].trim(), awaited })
    }
    return out.filter((h) => !h.awaited)
  }

  /**
   * 该文件是否用「模块级 sink」形态（迁移形态；`captureSinks` 是它的唯一入口）。
   * ⚠️ 用 `RegExp` 构造而不是正则字面量：本文件也在扫描范围内，字面量会让守卫扫到
   * 自己这行判据（自证）。
   */
  const MIGRATED_ENTRY = new RegExp('\\bcaptureSinks\\s*\\(')
  const usesMigratedForm = (src: string): boolean => MIGRATED_ENTRY.test(src)

  /**
   * `.concurrent` 的**豁免清单**：只允许"专门证明并发行为"的文件，且必须自带理由。
   * 空清单才是常态 —— 任何新增条目都要能回答"为什么这里的并发是安全的"。
   */
  const CONCURRENT_EXEMPT: Record<string, string> = {
    'helpers/capture-sinks.test.ts':
      '它用**不与其他用例重叠**的 concurrent 体（J）来证明「concurrent 体的尾巴不会漏进下一条」，'
      + 'K 会 `await` J 的尾巴后再断言 —— 语义上就是本守卫要保护的那条不变量，禁掉它等于删掉证据',
  }

  it('用了 captureSinks 的文件不得用 it.concurrent / test.concurrent（并发下无法归属写入）',
    () => {
      // 为什么不能靠机制兜：迁移形态的 sink 写的是**模块级变量**，两条并发用例本就在往同一个
      // 变量里写，任何归属都分不开（capture.ts 的 `writerIsCurrent` 注释）；改成"按用例身份
      // 取自己的 sink"更糟 —— A 的尾巴会追加进 B 正在写的那个 `out`（实测过，守卫 B/I/K/M 红）。
      // 要并发隔离只能用**句柄形态**（`startCapture()` + `cap.run()`），但那条路径也要求
      // 每次写入都落在 `cap.run` 里，未包住的写入按模块级 `fallback` 归属 —— 并发下同样串。
      // 结论：本助手服务的文件一律不用 `.concurrent`（白名单见 `CONCURRENT_EXEMPT`）。
      const hits: string[] = []
      for (const f of testFiles(SRC_TESTS)) {
        // ⚠️ 必须归一化分隔符（CodeRabbit + Codex PR#81）：Windows 上 `relative()` 返回
        // `helpers\capture-sinks.test.ts`，白名单键写的是 `helpers/capture-sinks.test.ts`，
        // 查表必然落空 → 白名单文件自己被判成违规、守卫在 Windows 上恒红（实测：
        // `path.win32.relative` 下命中 3 处）。
        const rel = relative(SRC_TESTS, f).split(sep).join('/')
        if (CONCURRENT_EXEMPT[rel] !== undefined) continue
        const text = blankComments(readFileSync(f, 'utf8'))
        // ⚠️ 判「是不是迁移形态」必须用**抹掉注释后**的文本：本文件的注释里就写着
        // `captureSinks(`（解释这条判据的边界），拿原文判会让守卫扫到自己。
        if (!usesMigratedForm(text)) continue
        // `.concurrent` 的任何注册形态：`it.concurrent(` / `it.concurrent.each(` /
        // `describe.concurrent(`（describe 级并发同样让用例并行）
        for (const m of text.matchAll(/\b(?:it|test|describe)\.concurrent\b/g)) {
          hits.push(`${rel}:${text.slice(0, m.index!).split('\n').length}`)
        }
      }
      expect(hits, '这些文件同时用了 captureSinks 与 .concurrent —— 并发下写入无法归属，'
        + '要么改用句柄形态并把写入全部放进 cap.run()，要么去掉 .concurrent').toEqual([])
      // ⚠️ 白名单不得变成"永久豁免"：条目必须仍是真的豁免对象（文件存在且确实用了
      // `.concurrent`），否则删掉那条并发用例后豁免会一直留着，将来同名文件重新引入
      // 并发时就静默放行了。
      for (const rel of Object.keys(CONCURRENT_EXEMPT)) {
        expect(rel, 'CONCURRENT_EXEMPT 的键必须是 / 分隔（与上面的归一化一致）').not.toContain('\\')
        const p = join(SRC_TESTS, rel)
        expect(existsSync(p), `CONCURRENT_EXEMPT 里的 ${rel} 不存在（清单过期）`).toBe(true)
        expect(blankComments(readFileSync(p, 'utf8')), `${rel} 已不再用 .concurrent，请从 CONCURRENT_EXEMPT 删除`)
          .toMatch(/\b(?:it|test|describe)\.concurrent\b/)
      }
    })

  it('用了 captureSinks 的文件，hook 体里不得**留下**未 await 的延迟工作（写入会漏进下一条）',
    () => {
      // 事故形态（Sourcery PR#72）：`beforeEach`/`afterEach` 里排一个 80ms 后落地的写入，
      // 它落地时下一条用例的 `captureSinks` 已经装好 —— `writerIsCurrent()` 把"没有世代
      // 上下文"当成当前世代，于是尾巴进了**下一条**的 `out`。
      // 为什么机制兜不住：世代号由 `it` 包装版在**用例体执行时**建立，hook 不在它的
      // `alsGen.run` 里（要给 hook 也套世代得改 29 个文件的 hook 导入，收益与风险不成比例）。
      // 所以这里禁掉"hook 里排延迟工作"这个形态本身：hook 里要么同步写完，要么 await 到底
      //（`await` 的写入在 hook 结束前就落地，不会漏）。
      // 判据边界（如实记录）：只认**直接**写在 hook 体里的这几种调度形态；若 hook 调了一个
      // 内部排定时器的辅助函数，静态扫描看不出来 —— 那种情况由 `writerIsCurrent` 的注释
      // 说明的边界承载，本守卫不假装覆盖它。
      const hits: string[] = []
      for (const f of testFiles(SRC_TESTS)) {
        const rel = relative(SRC_TESTS, f).split(sep).join('/')
        const text = blankComments(readFileSync(f, 'utf8'))
        if (!usesMigratedForm(text)) continue
        for (const m of text.matchAll(/\b(?:beforeEach|afterEach)\s*\(/g)) {
          const [s, e] = argRange(text, m.index! + m[0].length)
          const body = text.slice(s, e)
          const line = text.slice(0, m.index!).split('\n').length
          for (const h of hazardHits(body)) {
            hits.push(`${rel}:${line} hook 体里出现「${h.token}」${h.awaited ? '（已 await）' : ''}`)
          }
        }
      }
      expect(hits, '这些 hook 里排了未 await 的延迟工作 —— 它落地的写入会漏进下一条用例的缓冲。'
        + '把工作 await 完（hook 支持 async），或改用句柄形态并让写入全在 cap.run() 内').toEqual([])
    })

  it('判据本身不许退化：两条正则对合成样本必须真的命中（双向）', () => {
    // ⚠️ 样本一律用 `join` 拼出来，**不在源码里写字面量**：本文件也在扫描范围内，
    // 一条字面量 `beforeEach(() => { setTimeout…` 会让守卫扫到自己的反例（自证）。
    // 拼接后本文件的源码里既没有 `captureSinks(`、也没有 hook 危险形态，扫描它是空操作。
    const conc = /\b(?:it|test|describe)\.concurrent\b/g
    const bad = ['before', 'Each(() => { set', 'Timeout(() => { process.stdout.write("x") }, 80) })'].join('')
    expect(hazardHits(bad).map((h) => h.token), 'hook 危险形态必须被认出').toEqual(['setTimeout('])
    const good = ['before', "Each(async () => { await seed(); process.stdout.write('x') })"].join('')
    expect(hazardHits(good), '单纯 await 别的东西的 hook 不得被误伤').toEqual([])
    // ⚠️ 正控（CodeRabbit + Codex PR#81）：**直接 await 定时器**的合法写法必须放过 ——
    // 否则"按提示 await 到底"仍然红，提示与判据自相矛盾。
    const awaitedTimer = ['before', 'Each(async () => { await new Promise((r) => set',
      'Timeout(r, 80)) })'].join('')
    expect(hazardHits(awaitedTimer), '已 await 的定时器不得被报成脱手调度').toEqual([])
    // 反控：把 await 去掉，同一个形态必须被认出（证明上一条不是因为判据失效而放过）
    const detached = ['before', 'Each(() => { new Promise((r) => set',
      'Timeout(r, 80)) })'].join('')
    expect(hazardHits(detached).map((h) => h.token), '去掉 await 后必须被判为脱手调度')
      .toEqual(['setTimeout('])
    // 反控：`return` 也算已交付（vitest 会等 hook 返回值）
    const returned = ['before', 'Each(() => Promise.resolve().', 'then(() => process.stdout.write("x")))'].join('')
    expect(hazardHits(returned), 'return 出去的 .then 链同样不会漏').toEqual([])
    // `.concurrent` 命中、「迁移形态入口」命中、句柄形态不命中
    expect([...(('it.' + 'concurrent("x", () => {})')).matchAll(conc)]).toHaveLength(1)
    expect([...(('describe.' + 'concurrent("y", () => {})')).matchAll(conc)]).toHaveLength(1)
    expect(/\bcaptureSinks\s*\(/.test(['capture', 'Sinks((a) => {}, (b) => {})'].join(''))).toBe(true)
    expect(/\bcaptureSinks\s*\(/.test('const cap = startCapture()')).toBe(false)
  })
})
