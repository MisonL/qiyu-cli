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
import ts from 'typescript'
import { calleeChain, callChain, collectCalls, lineOf, objectPropsWithUnknown, parseTs, staticKey, unwrap } from './source-scan.js'

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
 * 注册函数基名。`suite` 是 `describe` 的别名（CodeRabbit PR#81 第七轮）；
 * `itBound` 是 `db.test.ts` 里「注册用例并把库路径绑进异步上下文」的包装（Codex PR#81
 * 第十轮）—— 它把选项原样转给捕获助手的 `it`，所以选项位上的并发开关同样生效。
 */
const REGISTRARS = new Set(['it', 'test', 'describe', 'suite', 'itBound'])
/** 套件级 `sequential: false` 同样让用例并行（Vitest 2.1.9，Codex PR#81 第十轮）。 */
const SUITES = new Set(['describe', 'suite'])
/**
 * 调度原语名（定时器 / 微任务）—— 只放**裸调用**（`f(…)` 或宿主.原语）能命中的名字。
 * ⚠️ `nextTick` 与 `Promise.resolve().then` 的 `.then` 同属微任务（Node 实测顺序：
 * sync → nextTick → Promise.then → queueMicrotask），延迟写入同样落在下一条用例里
 * （Codex PR#81 第二十轮 P2，`FRESHTAIL` 探针复现）。
 * ⚠️ `.then/.catch/.finally` **不在这里**：它们只在**方法链末段**才成立，由判定处单列
 * （放进来只是死条目 —— 裸调用 `then(…)` 不是真实写法，CodeRabbit PR#81 第二十二轮 minor）。
 */
const HOOK_FORBIDDEN = new Set(['setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'nextTick'])
/** 调度原语的宿主：`globalThis.setTimeout(…)` / `global.setTimeout(…)` 同样是调度。 */
const GLOBAL_HOSTS = new Set(['globalThis', 'global', 'window', 'self'])
/**
 * 写入 API 的**方法名**（静态尾段的判据，也是 `writesThroughCallee` 里链名判据的唯一出处 ——
 * 链名与尾段两条判据都从这里取名字，新增一个写入 API 只改这里）。
 */
const WRITE_TAILS = new Set(['assign', 'set', 'defineProperty', 'defineProperties'])
/**
 * 调用方式方法名（`.call` / `.apply` / `.bind`）。`writesThroughCallee` 的静态尾段沿它们往里找
 * 真正的链尾：`(w ?? Reflect).set.call(…)` 的尾段先是 `call`，剥一层才是 `set`。
 */
const METHOD_TAILS = new Set(['call', 'apply', 'bind'])
/** 写入 API 的宿主对象。与 `WRITE_TAILS` 一起构成本文件唯一的写入 API 名单。 */
const WRITE_OBJECTS: ReadonlySet<string> = new Set(['Object', 'Reflect'])
/** hook 名。大小写不敏感（`beforeEach` / `beforeeach` 都按同一规则，Codex PR#81 第十轮）。 */
const HOOK_HOOKS = new Set(['beforeeach', 'aftereach', 'beforeall', 'afterall'])

/** 迁移形态（用了 `captureSinks(`）的语法树判据。字符串 / 注释里的提及不算。 */
function isMigratedFile(sf: ts.SourceFile): boolean {
  return collectCalls(sf).some((c) => callChain(c)?.chain[0] === 'captureSinks')
}

/**
 * 本文件里 `名` 绑到的**函数字面量 / 函数声明**（具名执行体：`function body() {}`、
 * `const body = () => {}`、`const body = function () {}`）。找不到或另有赋值 → undefined。
 * ⚠️ 为什么要它（Codex PR#81 第二十五轮 P2，探针复现）：`it('x', body)` 里 `body` 是**执行体**，
 * 旧判据把它当「解析不出的选项对象」报违规 —— 合法用例过不了门禁（误报）。
 */
function functionBinding(sf: ts.SourceFile, name: string): boolean {
  // 先剥别名（`const wrap = opts` 让「opts 被写过」同样作废初始值），再查写入
  if (isMutated(sf, name)) return false
  let found = false
  let conflicting = false
  // ⚠️ **不限顶层**（Codex PR#81 第二十九轮 P2）：`describe(…, () => { const body = () => {} })`
  // 里声明的执行体同样合法。代价如实记录：不同作用域的同名声明会被并到一起（只会更保守）。
  const visit = (n: ts.Node): void => {
    // ⚠️ 命中**不能 `return`**：那样就再也不下潜这个节点的子节点，内层作用域里的同名声明
    // 全被截断 —— 「不限顶层」只好在函数体内部这一层生效。这条属于**实现不变量**，
    // 当前自检**无法用变异区分**（2026-11-18 实测：只走顶层 / 命中即 return 两种变异，
    // 自检输出完全相同，详见本文件「判据本身不许退化」用例里 M 样本的注释）。
    if (ts.isFunctionDeclaration(n) && n.name?.text === name) found = true
    else if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === name && n.initializer !== undefined) {
      const init = unwrap(n.initializer)
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) found = true
      else conflicting = true
    }
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return found && !conflicting
}

/**
 * 名字 `name` 在文件里**有没有被写过**（任何一处写入都让静态求值不可信）。
 * 判据按「写入的**目标**」写，不按写法：`x = …`、`x.p = …`、`x['p'] = …`、`x.p++`、
 * `Object.assign(x, …)` / `Reflect.set(x, …)` / `Object.defineProperty(x, …)` 的目标里出现
 * `name` 都算（Codex PR#81 第二十五轮 P2，探针复现：`Object.assign(opts, …)` 与
 * `opts['concurrent'] = …` 旧判据都不认，守卫把已被改成并发的选项当成串行放行）。
 */
function isMutated(sf: ts.SourceFile, name: string): boolean {
  // ⚠️ **别名也算目标**：`const t2 = opts; Object.assign(t2, {…})` 改的仍是 opts
  // （Codex PR#81 第二十五轮 P2 的同族形态，探针复现过旧判据放行）。先收集以 name 初始化的
  // 别名（可传递），再按「目标里出现 name 或任一别名」判。
  // ⚠️ 作用域**不限于顶层**：别名常写在 `describe(…, () => { const a = o; … })` 里（同轮 P2）。
  // 代价如实记录：不同作用域里的同名局部变量会被并成一个名字 —— 这只会让判据更保守（多报
  // 「看不清」），不会把真写入漏掉。
  const aliases = new Set<string>([name])
  for (let changed = true; changed;) {
    changed = false
    const collect = (n: ts.Node): void => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer !== undefined) {
        const init = unwrap(n.initializer)
        if (ts.isIdentifier(init) && aliases.has(init.text) && !aliases.has(n.name.text)) {
          aliases.add(n.name.text)
          changed = true
        }
      }
      // ⚠️ 别名不止经**声明初始化**建立：`let a; a = opts; a.concurrent = true` 同样写穿 opts
      // （CodeRabbit PR#81 第二十六轮 minor，序列可复现）。只跟声明初始值时这个序列完全逃过
      // 写入判据 —— `a` 从未进入别名集，就被当成无关变量。与「建立别名不算写入」同一个口径：
      // 这句赋值本身不计为写入，只把 `a` 收进别名集。
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isIdentifier(n.left)) {
        const init = unwrap(n.right)
        if (ts.isIdentifier(init) && aliases.has(init.text) && !aliases.has(n.left.text)) {
          aliases.add(n.left.text)
          changed = true
        }
      }
      ts.forEachChild(n, collect)
    }
    collect(sf)
  }
  /** 表达式是不是「围绕 name 或其别名之一的引用」：`x` / `x.p` / `x['p']` / `(x as T)`。 */
  const refersToAlias = (e: ts.Expression): boolean => {
    const u = unwrap(e)
    if (ts.isIdentifier(u)) return aliases.has(u.text)
    if (ts.isPropertyAccessExpression(u)) return refersToAlias(u.expression)
    if (ts.isElementAccessExpression(u)) return refersToAlias(u.expression)
    return false
  }
  /**
   * 一个表达式的**方法名**（`(w ?? Reflect).set.call(…)` → `call`；`Object['assign']` → `assign`；
   * 逗号表达式取右操作数）。只是「读一个节点的名字」，不沿链下钻 —— 下钻在 `callForm` 里做。
   * ⚠️ 计算键必须另走 `staticKey`：下标访问的 `name` 是键表达式、没有自己的 `.text`
   * （类型上虽有 `name.text`，运行时读不到）。
   */
  const tailOf = (e: ts.Expression): string | undefined => {
    if (ts.isPropertyAccessExpression(e)) return e.name.text
    if (ts.isElementAccessExpression(e)) return staticKey(e.argumentExpression)
    // ⚠️ 逗号表达式取右操作数（与 `calleeChain` 同一口径）：转换产物里 `Object.assign.bind` 可能
    // 写成 `(0, Object.assign.bind)` 一类的引用形态，右操作数才是真正的值。
    if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.CommaToken) return tailOf(unwrap(e.right))
    return undefined
  }
  /**
   * 这次调用**自己的**调用方式名（`call` / `apply` / `bind`）：被调方表达式自己的末段，
   * 被调方又是调用时剥一层（`Object.assign.bind(null)(…)` → 里层的 `bind`）。
   * 只看**一层**调用嵌套：`a.bind()( ).call()( )` 这种形态在自检里没有。
   */
  const callForm = (c: ts.CallExpression): string | undefined => {
    const callee = unwrap(c.expression)
    return tailOf(ts.isCallExpression(callee) ? callee.expression : callee)
  }
  const tailThroughInvocation = (e: ts.Expression): string | undefined => {
    let cur = unwrap(e)
    for (;;) {
      if (ts.isCallExpression(cur)) { cur = unwrap(cur.expression); continue }
      const k = tailOf(cur)
      if (k === undefined) return undefined
      if (!METHOD_TAILS.has(k)) return k
      cur = unwrap((cur as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)
    }
  }
  /**
   * 写入调用在**运行时**实际收哪些实参（含预绑定实参）：纯实参序列，目标总是第一个。
   * 求不出序列（`.apply` 的数组看不清）→ undefined，调用方保守按「写过」。
   */
  const pureArgs = (c: ts.CallExpression): readonly ts.Expression[] | undefined => {
    const callee = unwrap(c.expression)
    const form = callForm(c)
    // ⚠️ **`bind` 那一层自己不是写入**（Codex PR#81 第三十二轮 P2；自检 Q34/Q35）：`const f = Object.assign.bind(null, o)`
    // 只造了绑定函数、`o` 一点没变 —— 返回**空序列**（目标 undefined → 不算写；实参里的展开也不影响）。
    // ⚠️ 「`bind` 结果被立即调用」（`Object.assign.bind(null, o)(x)`）的 callee 就是那个 `bind` 调用，
    // `callForm` 剥一层后也读成 `bind` —— 按 callee 是不是调用分开：是 → 预绑定实参 + 本次实参；
    // 不是（属性 / 下标，即 `bind` 层本身）→ 空序列（被取 `.call` 时走下面的分支）。
    if (form === 'bind') {
      if (!ts.isCallExpression(callee)) return []
      if (callee.arguments.some((a) => ts.isSpreadElement(a))) return undefined
      return [...callee.arguments.slice(1), ...c.arguments]
    }
    // ⚠️ `call` / `apply` 分支**任何判断之前**先看展开（CodeRabbit PR#81 第三十二轮 minor）：
    // 实参里的 `SpreadElement` 会让整条序列不可知（展开能影响它的全部元素）。
    if (form === 'call' || form === 'apply') {
      if (c.arguments.some((a) => ts.isSpreadElement(a))) return undefined
      // 基座是 bind 的调用 → 先放它预绑定的实参（bind 的实参 0 是 thisArg，跳过）；
      // 基座是写入 API 本身（`Object.assign.call(…)` / `Reflect.set.apply(…)`）→ 没有预绑定；
      // 基座是**别的调用**（`x()(…)` / 绑定结果被调用 `Object.assign.bind(null, o)(…)`）→ 看不出
      // 预绑定了什么，整条序列不可知；其余普通表达式（`(w ?? Reflect).set` / 绑定函数变量 `f.call(…)`）
      // → 没有（`f.call` 的预绑定静态看不见 —— 已如实记为边界，见 `writesThroughCallee` 注释）。
      const bu = unwrap((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)
      let base: readonly ts.Expression[] = []
      if (ts.isCallExpression(bu)) {
        if (callForm(bu) !== 'bind') return undefined
        if (bu.arguments.some((a) => ts.isSpreadElement(a))) return undefined
        base = bu.arguments.slice(1)
      }
      if (form === 'call') return [...base, ...c.arguments.slice(1)]
      const arr = c.arguments[1] === undefined ? undefined : unwrap(c.arguments[1])
      if (arr === undefined || !ts.isArrayLiteralExpression(arr)
        || arr.elements.some((e) => ts.isSpreadElement(e) || ts.isOmittedExpression(e))) return undefined
      return [...base, ...(arr.elements as readonly ts.Expression[])]
    }
    // 普通调用（`Object.assign(o, x)` / 绑定函数变量 `f(x)`）：实参里的展开同样不可知。
    if (c.arguments.some((a) => ts.isSpreadElement(a))) return undefined
    return c.arguments
  }
  /**
   * 这次调用是不是**写入 API**，且目标围绕 name / 别名：**静态尾段**沿调用 / `.bind` / `.call` / `.apply`
   * 剥到真正的被调方法名（`(w ?? Reflect).set.call(…)` 剥到 `set`），是写入方法名才继续取目标。
   * ⚠️ 名字链（`calleeChain`）**不参与**：2026-11-18 实测它在测试环境里不可靠 —— 同一份源码在
   * `let` 绑定的函数里链完整、在 function 声明 / 块作用域里 `Object.assign.call(…)` 的 `assign`
   * 读不到（普通 node 进程的小函数里同样复现），链变成 `['Object','call']`。用它做否定判断会把
   * 真写入判成没写；「无 `let` 时绕过链」的改法在现行环境下无法被变异杀死（等价覆盖，如实记录），
   * 不留死代码，只留尾段这一条。
   * 边界（如实记录）：尾段是变量（`const k='set'; o[k](x)`）、`.apply` 的实参数组是变量、反射拼名字，
   * 仍看不见；`a.b.c(…)` 里的 `c` 恰好是 `assign` / `set` 时会把别的方法当成写入（多报不出错）；
   * **绑定函数变量**（`const f = Object.assign.bind(null, o); f(x)` / `f.call(null, x)`）的预绑定实参
   * 静态不追 —— 只有 `f` 本身时按「callee 不是写入 API」放过（Q33，测试钉住的是这条边界本身）。
   */
  const writesThroughCallee = (call: ts.CallExpression): boolean => {
    // 入口先按**静态尾段**认写入方法（`assign` / `set` …），再由 `pureArgs` 还原这次调用**运行时**真正
    // 收到的实参：`bind` 层本身 → 空序列（只创建，不是写入）；`bind` 结果被调用 / `.call` / `.apply` /
    // 普通调用 → 各自的实参序列；`.apply` 的数组看不清 → `undefined` → 按写过。猜不出就按写过。
    // ⚠️ 开发中试过的错误写法，勿回退：① `callForm(call) === 'bind'` 在入口直接放行 —— 「`bind` 结果被
    // 调用」的 callee 也是 `bind`，被一起放行了（Q18 变红）；② 按 `call.parent` 或节点身份
    // （`unwrap(x) === call`）判「只创建」—— 在 vitest 转换产物里都不可靠，判据静默失效。
    if (!WRITE_TAILS.has(tailThroughInvocation(call.expression) ?? '')) return false
    const seq = pureArgs(call)
    if (seq === undefined) return true
    const target = seq[0]
    return target !== undefined && refersToAlias(target)
  }

  let hit = false
  const visit = (n: ts.Node): void => {
    if (hit) return
    // ⚠️ `别的名 = 别名` 只是**建立别名**，不是写入（CodeRabbit PR#81 第二十六轮的赋值式别名）——
    // 左边不是别名本身时跳过。左边的属性写入（`a.p = …`）仍由 `refersToAlias` 判。
    // 判据是「右边是不是围绕别名的引用」—— 左边是**外来名**（刚被收进别名集的 `aliasQ8`），
    // 不能要求它已经在别名集里：`refersToAlias(n.left)` 对单纯 `aliasQ8` 恒假，那样 `hit`
    // 根本不会被置位，这段保护形同虚设（第一版就这么写的，样本 `oQ8` 直接判红才发现）。
    // ⚠️ 但**左边是原名自己**的赋值仍是写入：`opts = opts.next!` 让 `opts` 指向另一个对象
    // （CodeRabbit PR#81 第二十七轮 minor）—— 初始值 `{ concurrent: false }` 不再代表登记时的值。
    const leftIsBareNewName = ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
      // 判据是「左边的**绑定**是不是被重定向」：`name` 自己（原名）被赋值 → 写入；别的标识符
      // 赋值 → 只是建立别名。不能用「左边不在别名集里」判 —— 收集循环先跑，建立别名的左边
      // 早已在集里（样本 `oQ8` 因此判红）。
      && ts.isIdentifier(n.left) && n.left.text !== name && refersToAlias(n.right)
    // ⚠️ **解构赋值的目标**同样是写入（CodeRabbit PR#81 第二十八轮 minor）：`[opts] = [x]` /
    // `({ a: opts } = x)` 的左边是数组 / 对象字面量，`refersToAlias(n.left)` 只看根节点恒假。
    // 判据：赋值左边是解构模式时，逐个看它的**目标元素**（数组元素 / 属性值）是否为别名。
    const destructuresAlias = (e: ts.Node): boolean => {
      // 叶子：标识符（或经括号 / 断言包装）—— 直接按别名引用判
      if (!ts.isArrayLiteralExpression(e) && !ts.isObjectLiteralExpression(e)) {
        return ts.isExpression(e) && refersToAlias(e)
      }
      if (ts.isArrayLiteralExpression(e)) {
        return e.elements.some((x) => !ts.isOmittedExpression(x)
          && (ts.isSpreadElement(x) ? refersToAlias(x.expression) : destructuresAlias(x) || refersToAlias(x as ts.Expression)))
      }
      if (ts.isObjectLiteralExpression(e)) {
        return e.properties.some((p) => (ts.isPropertyAssignment(p) && destructuresAlias(p.initializer))
          || (ts.isShorthandPropertyAssignment(p) && aliases.has(p.name.text))
          || (ts.isSpreadAssignment(p) && refersToAlias(p.expression)))
      }
      return false
    }
    if (ts.isBinaryExpression(n) && ASSIGN_OPS.has(n.operatorToken.kind as ts.SyntaxKind)
      && (refersToAlias(n.left) || destructuresAlias(unwrap(n.left)))
      && !leftIsBareNewName) hit = true
    // ⚠️ **for-of / for-in 的右侧赋值目标同样是写入**（CodeRabbit PR#81 第三十一轮 minor，序列可复现）：
    // `for (opts.concurrent of [true]) {}` 每一轮都给 `opts.concurrent` 赋值，却没有赋值表达式 ——
    // 旧判据只看 BinaryExpression / 自增 / delete / 写入 API 调用，整段循环都看不见。
    // 循环头声明（`for (const x of …)`）不是给别名赋值；其余形态逐层看目标。
    if (ts.isForOfStatement(n) || ts.isForInStatement(n)) {
      const init = n.initializer
      if (ts.isVariableDeclarationList(init)) {
        // `for (const { concurrent } of …)` 会重新绑定局部名，但不是写 opts —— 不算
      } else if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) {
        if (refersToAlias(init)) hit = true
      } else if (destructuresAlias(init)) hit = true
    }
    // ⚠️ **建立别名本身不是写入**（Codex PR#81 第二十五轮 P2 的误报）：`const a = opts` 不改变
    // opts 的任何值 —— 只有别名**之后**再写它的属性才算。首版把这一句当成写入，`const alias = o`
    // 就让合法的串行选项被判成「看不清」。
    if ((ts.isPrefixUnaryExpression(n) || ts.isPostfixUnaryExpression(n))
      && (n.operator === ts.SyntaxKind.PlusPlusToken || n.operator === ts.SyntaxKind.MinusMinusToken)
      && refersToAlias(n.operand)) hit = true
    if (ts.isDeleteExpression(n) && refersToAlias(n.expression)) hit = true
    // ⚠️ 写入 API 的调用（`Object.assign(opts, …)` 一族）—— 判据在 `writesThroughCallee`。
    // 这一行曾被调试代码整行替换掉，暴露出自检样本 `O3c` 是**唯一**钉住它的用例（当时只有它变红）。
    if (ts.isCallExpression(n) && writesThroughCallee(n)) hit = true
    ts.forEachChild(n, visit)
  }
  visit(sf)
  return hit
}

/**
 * 本文件里 `名` 绑到的**求值后不变**的常量初始化表达式（布尔字面量 / 字面量对象）；
 * 找不到、绑到别的东西或**写过**它 → undefined。
 * ⚠️ 判据是"被写过就作废"，与写法无关 —— 见 `isMutated`。
 */
function staticBindingInitializer(sf: ts.SourceFile, name: string): ts.Expression | undefined {
  let found: ts.Expression | undefined
  let shadowed = false
  // ⚠️ 同名声明必须**全文件唯一**（Codex PR#81 第二十五轮 P2「按初始化位置求值」，探针复现：
  // 顶层 `const enabled = true` 被 `describe(…, () => { const enabled = false })` 内部遮蔽时，
  // 旧判据在作用域内仍取顶层的 `true` —— 把实际串行的用例报成并发；反过来也能把并发放行）。
  // 判据取保守侧：只要文件里还有**任何**同名声明（参数 / 解构 / import / 嵌套 const / 函数声明），
  // 静态求值一律作废 —— 不试图判断「这次使用落在哪个作用域」，那需要真实的父链与位置信息，
  // 「看不出来就不放行」比「猜一个作用域」安全。代价如实记录：不同作用域里无关的同名局部变量
  // 也会让顶层常量失效（多报「看不清」），不会漏。
  let declarations = 0
  const countName = (id: ts.Identifier | undefined): number => (id !== undefined && id.text === name ? 1 : 0)
  const countDecl = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) || ts.isParameter(n)) {
      // ⚠️ **解构模式**里的同名绑定也算声明（CodeRabbit PR#81 第二十八轮 minor：
      // `const { enabled } = { enabled: true }` 的 `enabled` 是 BindingElement 的名字，
      // 只看 `VariableDeclaration.name` 是标识符的情况会漏，内层遮蔽因此看不见）。
      const nm = (n as ts.VariableDeclaration | ts.ParameterDeclaration).name
      const countBinding = (b: ts.BindingName): number => ts.isIdentifier(b) ? countName(b)
        : b.elements.reduce((acc: number, e) => acc + (ts.isOmittedExpression(e) ? 0 : countBinding(e.name)), 0)
      declarations += nm === undefined ? 0 : countBinding(nm)
    } else if (ts.isFunctionDeclaration(n) || ts.isClassDeclaration(n) || ts.isEnumDeclaration(n)
      || ts.isInterfaceDeclaration(n) || ts.isTypeAliasDeclaration(n)) {
      declarations += countName(n.name)
    } else if (ts.isImportSpecifier(n)) declarations += countName(n.name)
    else if (ts.isImportClause(n) || ts.isNamespaceImport(n) || ts.isImportEqualsDeclaration(n)) {
      declarations += countName(n.name)
    } else if (ts.isModuleDeclaration(n) && ts.isIdentifier(n.name)) declarations += countName(n.name)
    ts.forEachChild(n, countDecl)
  }
  countDecl(sf)
  if (declarations !== 1) return undefined
  for (const st of sf.statements) {
    if (!ts.isVariableStatement(st)) continue
    for (const d of st.declarationList.declarations) {
      if (ts.isIdentifier(d.name)) {
        if (d.name.text !== name || d.initializer === undefined) continue
        found = unwrap(d.initializer)
      } else {
        // 解构里出现同名绑定 → 值不受我们控制
        const names = d.name as ts.BindingName
        const hit = (b: ts.BindingName): boolean => ts.isIdentifier(b) ? b.text === name
          : b.elements.some((e) => !ts.isOmittedExpression(e) && hit(e.name))
        if (hit(names)) shadowed = true
      }
    }
  }
  if (found === undefined || shadowed) return undefined
  return isMutated(sf, name) ? undefined : found
}

/**
 * 选项的开关值求值（**唯一实现点**）：`true` / `false` 字面量，或本文件里**求值后不变**的常量
 * （`const enabled = true`；被写过就不算）；求不出 → undefined。
 *
 * ⚠️ **为什么只留这一个纯取值函数、把比较留给调用点**（2026-11-17 实测，定位花了很久）：
 * 早先有调用方把「取值 + 三态」包成本函数内的局部闭包（`const flag = v => …`，返回 `'on' | 'no'`
 * 字符串或内联三元），结果同一个值在 `if` 里被静默判错 —— `const seq = seqB === false ? …` 之后
 * `seq === 'on'` 恒为假、整条分支永不进入，而单独调用同一个闭包却返回正确值。改成本函数的
 * 布尔返回值后调用点一次就对。**改这里时：保持返回布尔或 undefined，不要在中间引入字符串
 * 三态/局部闭包**，并跑 `套件计算键 + 括号` / `布尔常量为真 → 并发` 两条自检。
 */
function boolLiteralValue(sf: ts.SourceFile, e: ts.Expression): boolean | undefined {
  const u = unwrap(e)
  if (ts.isIdentifier(u)) {
    const init = staticBindingInitializer(sf, u.text)
    return init === undefined ? undefined : boolLiteralValue(sf, init)
  }
  if (u.kind === ts.SyntaxKind.TrueKeyword) return true
  if (u.kind === ts.SyntaxKind.FalseKeyword) return false
  return undefined
}

/**
 * 本文件顶层 `const 名 = <对象字面量>` 的初始化表达式；找不到、或该名字**另有赋值**时返回 undefined。
 * 只认顶层 const（选项对象按书写惯例出现在模块顶层）；解构 / 二次赋值 / 外部导入一律视为解析不出。
 */
function constObjectInitializer(sf: ts.SourceFile, name: string): ts.ObjectLiteralExpression | undefined {
  const init = staticBindingInitializer(sf, name)
  return init !== undefined && ts.isObjectLiteralExpression(init) ? init : undefined
}

/** 赋值运算符：`=` 与全部复合赋值（`||=` / `&&=` / `??=` 等）都是写入。 */
const ASSIGN_OPS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken, ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken, ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken, ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken, ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken,
])

/**
 * 本文件里 `undefined` 这个标识符**是否被任何声明遮蔽**（变量 / 参数 / 解构）。
 * ⚠️ 按文件缓存（Codex PR#81 第二十七轮 P2）：整棵树遍历只做一次。原先这段遍历写在
 * `concurrentViolations` 的**每个登记调用**循环里 —— `api.test.ts` 约 12082 个节点 × 114 次登记
 * ≈ 137 万次访问，仓扫用例因此耗时 20–24s，且同步遍历不受 Vitest 超时约束。
 * 缓存键是 `SourceFile` 对象本身（WeakMap，不阻 GC；同一文件重复调用只算一次）。
 */
const UNDEFINED_SHADOWED = new WeakMap<ts.SourceFile, boolean>()
function isUndefinedShadowed(sf: ts.SourceFile): boolean {
  const cached = UNDEFINED_SHADOWED.get(sf)
  if (cached !== undefined) return cached
  let shadowed = false
  const scan = (n: ts.Node): void => {
    if (shadowed) return
    if ((ts.isVariableDeclaration(n) || ts.isParameter(n) || ts.isBindingElement(n))
      && ts.isIdentifier((n as ts.VariableDeclaration).name)
      && ((n as ts.VariableDeclaration).name as ts.Identifier).text === 'undefined') { shadowed = true; return }
    // ⚠️ **导入也能遮蔽**（Codex PR#81 第二十八轮 P2）：`import { opts as undefined } from './x'`
    // 是合法 TS，此时 `undefined` 就是那个导入对象 —— `it('x', undefined, fn)` 的"选项"其实是它。
    if (ts.isImportSpecifier(n) && n.name.text === 'undefined') { shadowed = true; return }
    if ((ts.isImportClause(n) || ts.isNamespaceImport(n) || ts.isImportEqualsDeclaration(n))
      && n.name !== undefined && n.name.text === 'undefined') { shadowed = true; return }
    ts.forEachChild(n, scan)
  }
  scan(sf)
  UNDEFINED_SHADOWED.set(sf, shadowed)
  return shadowed
}

/**
 * `concurrentViolations` 里「看不清就不放行」的四类文案的共同片段（自检把它们归为 unknown）。
 * 判据新增一种"看不见"的成因时要同步加在这里 —— 否则自检会把它错归成 `opt`（判成并发）。
 */
const COULD_NOT_SEE = ['无法静态解析', '无法静态求值', '来自访问器', '未知来源的键'] as const

/**
 * 迁移形态文件的并发仓扫（**唯一实现点**：白名单豁免、粗筛、细判都在这里）。
 * 输入是「文件清单」而不是目录 —— 自检可以直接喂合成样本，不需要往仓库里写临时文件。
 * ⚠️ 这里**不再有粗筛**（CodeRabbit PR#81 第二十六轮 minor）：早先按「文件里出现没出现
 * `concurrent` / `sequential` 字样」整份跳过，于是 `import { opts } from './x'; it('x', opts, fn)`
 * 这种文件（选项来自导入、文件里没有任何开关字样）被整份跳过，细判根本不会问它 —— 而 opts
 * 完全可能是并发的。粗筛当初要挡的误报只剩一类：**转发 helper 内部**的 `it(name, ...rest)`
 * （db.test.ts 的 `itBound`），那一类现在由细判自己静默放行（见 `concurrentViolations` 的展开
 * 实参分支），判据仍只有一个实现点。
 */
function scanEntries(entries: Array<{ rel: string; sf: ts.SourceFile }>,
  exempt: Record<string, string>): string[] {
  const hits: string[] = []
  for (const { rel, sf } of entries) {
    if (exempt[rel] !== undefined) continue
    if (!isMigratedFile(sf)) continue
    for (const v of concurrentViolations(sf)) hits.push(`${rel}:${v.line}（${v.why}）`)
  }
  return hits
}

/**
 * 并发判据（**唯一实现点**：仓库扫描与自检都调它）：返回违规说明 + 行号。
 *
 * ① `.concurrent` 修饰链：`it.concurrent(…)` / `describe.shuffle.concurrent(…)` /
 *    `suite.concurrent(…)` —— 名字链里任一段是 `concurrent`。
 * ② 选项对象 `{ concurrent: true }`：注册调用的**对象字面量实参**（含链式登记
 *    `it.each(表)('名', {…}, 体)` 的外层调用）里有该键且值为 `true`；字符串键
 *    （`'concurrent'`）与计算键（`['concurrent']`）同属。
 * 表格式实参与执行体里的同名属性是数据，不判（Vitest 不读它们；AST 天然区分）。
 */
function concurrentViolations(sf: ts.SourceFile): Array<{ line: number; why: string }> {
  const out: Array<{ line: number; why: string }> = []
  const seen = new Set<number>()
  const isFn = (e: ts.Expression): boolean => {
    const u = unwrap(e)
    return ts.isArrowFunction(u) || ts.isFunctionExpression(u)
      || (ts.isIdentifier(u) && functionBinding(sf, u.text))
  }
  /** 选项对象的形状，或"求不出"的成因（报违规时的文案要用）。 */
  type Resolved =
    | { kind: 'obj'; node: ts.ObjectLiteralExpression }
    | { kind: 'ident'; node: ts.Identifier }
    | { kind: 'dynamic'; text: string }
  const resolveOptions = (a: ts.Expression): Resolved => {
    const u = unwrap(a)
    if (ts.isObjectLiteralExpression(u)) return { kind: 'obj', node: u }
    if (ts.isIdentifier(u)) {
      // ⚠️ 选项位可以是**标识符**（`const options = { concurrent: true }; it('x', options, fn)`）：
      // Vitest 2.1.9 照常按它登记并发（CodeRabbit PR#81 第二十四轮 minor，探针确认）。
      // 先在本文件里静态解析 `const 名 = <对象字面量>`；解析不出（外部导入 / 被写过）就
      // **不许放行** —— 与未知展开同一个判据。
      const init = constObjectInitializer(sf, u.text)
      return init === undefined ? { kind: 'ident', node: u } : { kind: 'obj', node: init }
    }
    // 调用返回值 / 条件表达式 / 变量引用 … 静态求不出 —— 同样**不许放行**
    // （Codex PR#81 第二十五轮 P2，探针复现：`it('x', getOptions(), fn)` 与三元表达式旧判据直接跳过）。
    return { kind: 'dynamic', text: a.getText(sf) }
  }
  for (const call of collectCalls(sf)) {
    const c = callChain(call)
    if (c === undefined) continue
    const base = c.chain[0]!
    // 链式登记的两层调用（表格层 / 登记层）落在同一行，同一处违规只报一次
    if (seen.has(lineOf(sf, call))) continue
    if (REGISTRARS.has(base)) {
      const isAlias = c.chain.includes('concurrent')
        || c.chain.some((seg) => seg.toLowerCase() === 'concurrent')
      if (isAlias) {
        out.push({ line: lineOf(sf, call), why: `.concurrent 修饰链：${c.chain.join('.')}` })
        seen.add(lineOf(sf, call))
        continue
      }
      // ⚠️ 只有**选项位**才判：`it.skipIf(x)` / `it.each(cases)` 的实参是条件与表格，
      // 不是选项（2026-11-17 实测：不加这一层，auth.test 的 `posixOnly`、config-insecure 的
      // `cases` 全被误报）。选项位**两种重载**都合法（`@vitest/runner` 的 `parseArguments`）：
      // `it(名, 选项, 体)` 与 `it(名, 体, 选项)` —— 按「谁是函数」区分，而不是固定第 2 个
      // （Codex PR#81 第二十四轮 P2：只认第 2 个时 `it('x', () => {}, { concurrent: true })`
      // 漏判，`it('x', body)` 的具名执行体又被误报为未知选项）。
      // ⚠️ 标识符**不是**自证：`optI1` 既可能是 `const optI1 = {…}`（选项）也可能是具名执行体
      // （`it('x', body)`）。判据：能解析成本文件顶层对象字面量 / 函数字面量的 → 按各自语义；
      // 否则按位置 —— `parseArguments` 只在**第 2 个**实参是函数时把第 3 个当选项，否则第 2 个
      // 就是选项。
      // ⚠️ **登记调用本身也可以经 `.call` / `.apply`**（Codex PR#81 第二十五轮 P2，探针复现：
      // `it.call(null, 名, 选项, 体)` / `it.apply(null, [名, 选项, 体])` 是有效登记，Vitest 照常
      // 按选项登记并发）：先把实参还原成登记形态再定位选项与执行体。
      let args: readonly ts.Expression[] = call.arguments
      const lastSeg = c.chain[c.chain.length - 1]
      if (c.chain.length > 1 && (lastSeg === 'call' || lastSeg === 'apply')) {
        // ⚠️ `Function.prototype.apply(thisArg, argsArray)` 的**第一个实参是 thisArg** —— 之前这里
        // 把 `call.arguments[0]`（thisArg，实测是 `null`）当成实参数组，`it.apply(null, [...])`
        // 直接被判成「实参数组无法静态解析」（Codex PR#81 第二十五轮 P2 的修复本身没生效，
        // 直到有自检样本才暴露）。数组是**第二个**实参。
        const arg0 = call.arguments[0]
        const target = lastSeg === 'apply' ? (call.arguments[1] === undefined ? undefined : unwrap(call.arguments[1])) : undefined
        if (lastSeg === 'call') args = call.arguments.slice(1)
        else if (target !== undefined && ts.isArrayLiteralExpression(target)) {
          // ⚠️ 数组里有展开 / 洞（`[...rest]`、`[名, , {}]`）时位置不可静态确定 —— 按"看不清的选项"报
          if (target.elements.some((e) => ts.isSpreadElement(e) || ts.isOmittedExpression(e))) {
            out.push({ line: lineOf(sf, call), why: `.apply 的实参数组含展开 / 空位，无法确定选项位置` })
            seen.add(lineOf(sf, call))
            continue
          }
          args = target.elements as readonly ts.Expression[]
        } else {
          out.push({ line: lineOf(sf, call), why: `.apply 的实参数组是表达式 ${arg0 === undefined ? '（缺省）' : call.getText(sf)}，无法静态解析` })
          seen.add(lineOf(sf, call))
          continue
        }
      }
      // ⚠️ **数字实参是超时、不是选项**（CodeRabbit PR#81 第二十五轮 minor，探针复现：
      // `it('slow', async () => {}, 40_000)` 被报成「选项位是表达式 40_000 无法静态求值」，
      // 只要文件里别处出现一个 `concurrent` 就让合法用例变红）。依据 `@vitest/runner` 2.1.9 的
      // `parseArguments`：`number` → `{ timeout: n }`；对象 → 选项；函数 → 执行体。
      const isNumericLiteral = (u: ts.Expression): boolean =>
        u.kind === ts.SyntaxKind.NumericLiteral
        || (ts.isPrefixUnaryExpression(u) && u.operator === ts.SyntaxKind.MinusToken
          && u.operand.kind === ts.SyntaxKind.NumericLiteral)
      // ⚠️ 本文件里能静态解析成数字的**常量**也是超时（Codex PR#81 第二十七轮 P2，Vitest 照常登记
      // 串行）：`const TEST_TIMEOUT = 40000; it('x', fn, TEST_TIMEOUT)` 原先被当成「选项位是标识符
      // TEST_TIMEOUT，无法静态解析」，合法用例被判红。解析复用 `staticBindingInitializer`
      // （被写过 / 同名重复声明 → 解析不出 → 仍按原规则报「看不清」，保守侧不变）。
      const isNumberArg = (e: ts.Expression): boolean => {
        const u = unwrap(e)
        if (isNumericLiteral(u)) return true
        if (!ts.isIdentifier(u)) return false
        const init = staticBindingInitializer(sf, u.text)
        return init !== undefined && isNumericLiteral(unwrap(init))
      }
      // ⚠️ `undefined` 是**显式的空选项**（CodeRabbit PR#81 第二十六轮 minor，探针核对
      // `@vitest/runner` 2.1.9 的 `parseArguments`：该实参不落入 object/number 分支 → `options`
      // 保持 `{}`，执行体仍是那个函数）。因此它与数字超时一样**不占**选项位：
      // `it('x', undefined, fn)` 是合法的串行登记，不该被报「选项位是表达式 undefined 无法静态求值」。
      // 边界：标识符 `undefined` 只在文件里**没有同名声明**时才算它（`function f(undefined) {…}`
      // 能让它变成别的值）。`void 0` 的值恒为 `undefined`（与操作数无关），一并认。
      const undefinedShadowed = isUndefinedShadowed(sf)
      const isUndefinedArg = (e: ts.Expression): boolean => {
        const u = unwrap(e)
        if (u.kind === ts.SyntaxKind.UndefinedKeyword) return true
        // `void 0` 恒为 undefined（VoidExpression 的值就是 undefined，与操作数无关）
        if (ts.isVoidExpression(u)) return true
        return ts.isIdentifier(u) && u.text === 'undefined' && !undefinedShadowed
      }
      // ⚠️ **转发 helper**：`it(name, ...rest)`（db.test.ts 的 `itBound` 内部形态）的选项位
      // 由**调用方**决定，静态看不见。原粗筛就是为挡它的误报而存在，副作用是把「选项来自导入」
      // 的文件整份跳过（第二十六轮 minor）。现在只在这一处静默放行，并把边界如实记在这里：
      // helper 的调用方若真的传了 `concurrent: true`，本守卫看不出来 —— 那是跨函数数据流，
      // 超出这份单文件静态判据，需 reviewer 看 helper 的调用点。
      // ⚠️ 但**只能豁免到展开为止**：`it('x', { concurrent: true }, ...([fn] as const))` 的选项是
      // 显式对象、展开只补执行体（CodeRabbit PR#81 第二十七轮 minor）—— 一律跳过会把这种显式并发
      // 放过去。因此只把展开**之前**的实参送去判。
      // ⚠️ 曾在这里加过一个 `fnInArray`（「数组字面量里含函数就算执行体位」）—— 它从未生效：
      // 变异删掉后全部自检仍绿（死代码）。`.apply` 的实参数组由上面的分支整体还原成 `args`，
      // 执行体本来就落在 `rest` 里、由 `isFn` / `thirdResolvesToObject` 认，不需要这层。
      const spreadAt = args.findIndex((e) => ts.isSpreadElement(e))
      const scanArgs = spreadAt < 0 ? args : args.slice(0, spreadAt)
      // ⚠️ 超时实参**按原始位置**识别之后才剔除（Codex PR#81 第二十九轮 P2）：`it('slow', handler, 40_000)`
      // 里执行体来自导入、静态求不出 `isFn` —— 先剔除数字才不会把 `handler` 当成选项。
      const rest = scanArgs.slice(1).filter((e) => !isNumberArg(unwrap(e)) && !isUndefinedArg(e))
      // ⚠️ **第三实参是对象时它就是选项**（Codex PR#81 第二十七轮 P2，`parseArguments` 2.1.9：
      // `typeof optionsOrTest === 'object'` 分支先判，`it(名, 执行体, {…})` 的选项取第三位）。
      // 原先按 `isFn(rest[0])` 定位，执行体来自 import（`isFn` 为假）时把 handler 当成选项，
      // 合法串行用例被报「选项对象是标识符 handler，无法静态解析」。
      // 只认**对象字面量**：标识符 / 调用的第三实参仍需静态求值，落到下面 `resolveOptions` 处理。
      // ⚠️ 第三实参是**能静态解析成对象**的常量时同样是选项（CodeRabbit PR#81 第二十八轮 minor，
      // `const opts = {…}; it('x', handler, opts)` —— `parseArguments` 看的是**运行时类型**）。
      const thirdResolvesToObject = rest.length >= 2
        && (ts.isObjectLiteralExpression(unwrap(rest[1]!))
          || (ts.isIdentifier(unwrap(rest[1]!)) && constObjectInitializer(sf, (unwrap(rest[1]!) as ts.Identifier).text) !== undefined))
      // ⚠️ `it(名, 执行体, 超时)`（Codex PR#81 第二十九轮 P2）：原始**最后一个实参是数字**时，
      // 前面的那个实参就是执行体 —— 它即使来自导入（`isFn` 求不出）也**不是**选项。
      const lastIsNumber = args.length >= 3 && isNumberArg(unwrap(args[args.length - 1]!))
      const optionArgs = thirdResolvesToObject
        ? [rest[1]!]
        : lastIsNumber && rest.length === 1 ? []
          : rest.length > 0 && isFn(rest[0]!) ? rest.slice(1) : rest.slice(0, 1)
      for (const a of optionArgs) {
        const r = resolveOptions(a)
        if (r.kind !== 'obj') {
          out.push({
            line: lineOf(sf, call),
            why: r.kind === 'ident'
              ? `选项对象是标识符 ${r.node.text}，无法静态解析`
              : `选项位是表达式 ${r.text}，无法静态求值`,
          })
          seen.add(lineOf(sf, call))
          continue
        }
        const u = r.node
        const { props, mayHaveUnknown, accessorKeys } = objectPropsWithUnknown(u)
        // ⚠️ 选项值同样要静态求：`{ concurrent: enabled }`（`const enabled = true`）与
        // `{ concurrent: 1 > 0 }` 在 Vitest 里都是真值 → 并发（Codex PR#81 第二十五轮 P2，
        // 探针复现：旧判据只认字面量 `true`，标识符/表达式被当成"没开"）。
        // 三态：`'on'` 为真、`'no'` 为假、`'unknown'` 静态求不出（**不许放行**）。
        // ⚠️ 不用布尔 + undefined 两态：那会把「求不出」和「为假」混成一个判据 ——
        // `{ concurrent: cond }` 会被当成串行放行。
        // ⚠️ **三态求值保持内联**：2026-11-17 实测，把它封装成本函数内的箭头函数再调用时，
        // 调用方拿到的是错值（`'no'` 一路），`if (seq === 'on')` 两者都不成立 —— 分支静默
        // 失效；同一个箭头函数单独调用却返回正确值（差异只在调用点形状，根因未查明）。
        // 内联后分支恢复。换实现时请保持内联，并跑 `套件计算键 + 括号` 那条自检。
        // 三态求值：`true` 为真、`false` 为假、`undefined` 求不出（**不许放行**）。
        // ⚠️ 必须把「求不出」和「为假」分开 —— 两态会把 `{ concurrent: cond }` 当串行放行。
        const concVal = props.get('concurrent')
        if (props.get('concurrent') !== undefined && boolLiteralValue(sf, props.get('concurrent')!) === true) {
          out.push({ line: lineOf(sf, call), why: '选项对象 concurrent 为真' })
          seen.add(lineOf(sf, call))
          continue
        }
        if (props.get('concurrent') !== undefined && boolLiteralValue(sf, props.get('concurrent')!) === undefined) {
          out.push({ line: lineOf(sf, call), why: `选项对象的 concurrent 值 ${concVal!.getText(sf)} 无法静态求值` })
          seen.add(lineOf(sf, call))
          continue
        }
        // `describe`/`suite` 上的 `sequential: false` 与 `concurrent: true` 等价
        const seqVal = SUITES.has(base) ? props.get('sequential') : undefined
        // 访问器声明的键：值是读的时候才求得的，`props.get` 是 undefined —— 不能当成「没写」
        const seqGet = accessorKeys.has('sequential')
        if (!seqGet && seqVal !== undefined && boolLiteralValue(sf, seqVal) === false) {
          out.push({ line: lineOf(sf, call), why: '套件选项 sequential 为假' })
          seen.add(lineOf(sf, call))
          continue
        }
        if (SUITES.has(base) && (seqGet || (seqVal !== undefined && boolLiteralValue(sf, seqVal) === undefined))) {
          out.push({ line: lineOf(sf, call), why: `套件选项的 sequential 值 ${seqVal === undefined ? '访问器' : seqVal.getText(sf)} 无法静态求值` })
          seen.add(lineOf(sf, call))
          continue
        }
        // ⚠️ 未知来源的键（`{ ...opts }` / `{ [key]: … }`）让「没声明并发」变得**看不出来** ——
        // 只看 `props.get` 会把「可能开了并发」当成「确定没开」（CodeRabbit PR#81 第二十三轮）。
        // 判据是静态守卫：**看不见就不许放行**，除非同一个对象里显式声明了串行（`concurrent: false`）。
        // getter 的 `concurrent` 值是**读的时候才知道**（`{ get concurrent() { return true } }`）——
        // Vitest 会读它并登记并发，`props.get` 拿到 `undefined` —— 上面的三态求值拿到 `undefined`
        // 会把它当 `'off'`，所以这里单独拦（Codex PR#81 第二十四轮 P2）。
        if (accessorKeys.has('concurrent')) {
          out.push({ line: lineOf(sf, call), why: '选项对象的 concurrent 来自访问器，值在运行时才知道' })
          seen.add(lineOf(sf, call))
          continue
        }
        const concW = props.get('concurrent')
        const explicitOff = concW !== undefined && boolLiteralValue(sf, concW) === false
        // 显式串行：套件上写 `sequential: true` 就是「串行」的明确声明（`false` 反而是并发，
        // 前面已报）。Codex PR#81 第二十五轮 P2：这里曾比较 `false`，于是
        // `{ ...opts, sequential: true }` 的收口永远不生效。
        const suiteExplicitSeq = seqVal !== undefined && boolLiteralValue(sf, seqVal) === true
        if (mayHaveUnknown && !explicitOff && !suiteExplicitSeq) {
          out.push({ line: lineOf(sf, call), why: '选项对象含未知来源的键（展开 / 动态键），无法确认未开启并发' })
          seen.add(lineOf(sf, call))
        }
      }
    }
  }
  return out
}

/**
 * hook 里排调度的判据（**唯一实现点**）：hook 调用的实参子树里任何**对调度原语名**的
 * 调用都算。字符串 / 正则 / 注释里的同名文本在 AST 里不是调用，天然不算；模板插值
 * （`${f(setTimeout(…))}`）与嵌套模板里的真调用算。
 * 边界（如实记录）：反射（`globalThis['set' + 'Timeout'](…)`）与 hook 转调的 helper
 * 内部排调度，静态看不出来 —— 后者要靠 reviewer 看 helper 的语义。
 */
function hookSchedulingViolations(sf: ts.SourceFile): Array<{ line: number; why: string }> {
  const out: Array<{ line: number; why: string }> = []
  // hook 登记本身也可以是 `beforeEach.call(null, …)` / `.apply(…)`（Codex PR#81 第二十四轮 P2）：
  // 剥掉末段 `call`/`apply` 后再认 hook 名，否则整棵回调都不被扫描。
  /** `bind` 形态是否**真的被调用**：调用节点的被调方是 `X.bind(...)` 的结果（`Call(Call(Prop(X,'bind'),…),…)`）。 */
  const bindResultInvoked = (call: ts.CallExpression): boolean => {
    // ⚠️ `.bind(...).call(...)` / `.apply(...)`：绑定**结果**经 call/apply 被调用，同样是登记
    // （Codex PR#81 第三十二轮 P2，Node 实测照常登记）。先剥本调用的 call/apply 层，回到调用
    // `X.bind(...)` 的那一层再判。
    const form = (() => {
      const u = unwrap(call.expression)
      return ts.isPropertyAccessExpression(u) ? u.name.text
        : ts.isElementAccessExpression(u) ? staticKey(u.argumentExpression) : undefined
    })()
    if ((form === 'call' || form === 'apply') && call.arguments.length >= 1) {
      // 被调方是 `X.bind(...)`（绑定的结果），本调用的实参 0 是 thisArg —— 只剥调用方式那一层，
      // 再判 `X` 确实是 `….bind` 的调用。
      const target = unwrap((unwrap(call.expression) as ts.PropertyAccessExpression).expression)
      return ts.isCallExpression(target)
        && (ts.isPropertyAccessExpression(unwrap(target.expression)) || ts.isElementAccessExpression(unwrap(target.expression)))
        && (ts.isPropertyAccessExpression(unwrap(target.expression))
          ? (unwrap(target.expression) as ts.PropertyAccessExpression).name.text === 'bind'
          : staticKey((unwrap(target.expression) as ts.ElementAccessExpression).argumentExpression) === 'bind')
    }
    // 括号 / 断言包装不影响语义：`((p ?? Promise.resolve()).then.bind(p))(w)` 的 bind 结果
    // 外面套了一层括号再被调用（Codex PR#81 第三十轮 P2，Node 实测 `w` 照样在 hook 之后跑）
    const raw = unwrap(call.expression)
    return ts.isCallExpression(raw)
      && (ts.isPropertyAccessExpression(unwrap(raw.expression)) || ts.isElementAccessExpression(unwrap(raw.expression)))
      && (ts.isPropertyAccessExpression(unwrap(raw.expression))
        ? (unwrap(raw.expression) as ts.PropertyAccessExpression).name.text === 'bind'
        : staticKey((unwrap(raw.expression) as ts.ElementAccessExpression).argumentExpression) === 'bind')
  }
  const isHookName = (chain: string[] | undefined, call?: ts.CallExpression): boolean => {
    if (chain === undefined) return false
    let c = chain
    // `beforeEach.call(null, fn)` / `.apply(...)`：调用方式，末段剥掉
    if (c.length > 1 && (c[c.length - 1] === 'call' || c[c.length - 1] === 'apply')) c = c.slice(0, -1)
    // `beforeEach.bind(null)(fn)`（Codex PR#81 第二十七轮 P2，Node 实测照常登记 hook）：
    // `bind` 后面还有一层调用，`callChain` 穿透它得到 `beforeEach.bind` —— 同样剥掉末段。
    // ⚠️ `callChain` **不区分**「绑定后被调用」与「只创建绑定函数」（`const r = beforeEach.bind(…)`），
    // 后者不登记（Codex PR#81 第二十九轮 P2）—— 因此剥 `bind` 只在**该调用节点的被调方是 `bind`
    // 且它的父是调用**时才算（`isHookName` 的 `call` 参数 = 当前调用节点；不传即不认 bind 形态）。
    if (c.length > 1 && c[c.length - 1] === 'bind') {
      // 只有「绑定的结果又被调用」才算登记
      if (call === undefined || !bindResultInvoked(call)) return false
      c = c.slice(0, -1)
    }
    return c.length === 1 && HOOK_HOOKS.has(c[0]!.toLowerCase())
  }
  /**
   * 这个调用**本身**是否被 directly `await`（含 `return await`、`x = await …`、括号 / 断言包装）。
   * ⚠️ **不穿透外层调用**：`await ignore(x.then(w))` 只等 `ignore` 返回的那个值 —— 它若把实参
   * 原样返回才顺便等到 `w`，否则 `w` 照样落在 hook 之后（Codex PR#81 第二十五轮 P2，探针
   * 复现：旧判据跨过调用实参去找 `await`，把这种写法放行了）。
   */
  /**
   * `n` 是否**真的被 hook 等到**。
   * ⚠️ 判据分两问（CodeRabbit PR#81 第二十七轮 minor，此前只问第一问）：
   *   ① 从 `n` 往上，到**所在的那个函数**为止，途中遇到 `await` 了吗？
   *   ② 那个函数**是不是 hook 的直接回调**？——`beforeEach(() => { void (async () => { await x.then(w) })() })`
   *      里 `x.then(w)` 确实紧挨着 await，但 await 属于内层 IIFE，hook 既不返回也不 await 它，
   *      `w` 照样落在 hook 之后。旧判据只看「最近父节点是不是 await」，这种形态被漏掉。
   * 边界（沿用既有口径）：`await ignore(x.then(w))` 只等 `ignore` 的返回值，**不穿透调用实参** ——
   * 途中遇到「e 是某个调用的实参」即判 false。
   */
  const isHookCallback = (fn: ts.Node): boolean => {
    let e: ts.Node = fn
    for (;;) {
      const p = e.parent
      if (p === undefined) return false
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)
        || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)) { e = p; continue }
      // 传调用节点：`beforeEach.bind(null)(fn)` 的链末段是 `bind`，`isHookName` 要靠它确认
      // 绑定的结果**被调用**才认作登记（Codex PR#81 第三十轮 P2，缺了它合法写法一律被报未等待）
      return ts.isCallExpression(p) && p.arguments.includes(e as ts.Expression) && isHookName(callChain(p)?.chain, p)
    }
  }
  const isAwaited = (n: ts.Node): boolean => {
    let e: ts.Node = n
    let sawAwait = false
    for (;;) {
      const p = e.parent
      if (p === undefined) return false
      if (ts.isAwaitExpression(p) && p.expression === e) { sawAwait = true; e = p; continue }
      if (ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p)
        || ts.isSatisfiesExpression(p) || ts.isTypeAssertionExpression(p)) { e = p; continue }
      // 被调形态（`f()()` / 标签模板）穿过去；作为**实参**时不穿（见上方边界）
      if (ts.isCallExpression(p)) {
        if (p.expression === e) { e = p; continue }
        return false
      }
      if (ts.isTaggedTemplateExpression(p) && p.tag === e) { e = p; continue }
      if (ts.isFunctionLike(p) || ts.isClassLike(p)) return sawAwait && isHookCallback(p)
      // `const r = await x` / `r = await x`（Codex PR#81 第二十八轮 P2，Node 实测就是直接等待）：
      // 从 await 往上还会遇到 VariableDeclaration / 赋值表达式 —— 它们同样在 hook 自己的函数里，
      // 继续走（否则「把结果存进变量」的合法写法被误报）。
      if (ts.isVariableDeclaration(p) || ts.isVariableDeclarationList(p)
        || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === e)) {
        e = p
        continue
      }
      // 语句层（`await x` 的父是表达式语句、再上是块 / case 子句）继续往函数边界走。
      // ⚠️ `ts.isStatement(Block)` 是 **false**（`Block` 的 SyntaxKind 不在 FirstStatement…
      // LastStatement 区间里，尽管类型上它属于 Statement）—— 只写 `isStatement` 的话，
      // `afterAll(async () => { await … })` 会在 Block 处提前 return false，真实文件误报。
      if (ts.isStatement(p) || ts.isBlock(p) || ts.isCaseBlock(p) || ts.isCaseOrDefaultClause(p)) { e = p; continue }
      return false
    }
  }
  for (const call of collectCalls(sf)) {
    if (!isHookName(callChain(call)?.chain, call)) continue
    for (const inner of collectCalls(call)) {
      // ⚠️ 用 `callChain` 而不是 `calleeChain`：`Promise.resolve().then(…)` 的被调对象基座是
      // **调用**，`calleeChain` 对它返回 undefined（Codex PR#81 第二十轮 P2，探针复现）。
      const innerName = callChain(inner)?.chain
      if (innerName === undefined) {
        // 基座求不出名字（`(pending ?? Promise.resolve()).finally(w)` 的 `??` 表达式）时，
        // 名字链整条丢失 —— 但**末段的回调方法**静态可见（Codex PR#81 第二十四轮 P2）。
        const segOf = (c: ts.Expression): string | undefined => {
          const u = unwrap(c)
          return ts.isPropertyAccessExpression(u) ? u.name.text
            : ts.isElementAccessExpression(u) ? staticKey(u.argumentExpression)
              : undefined
        }
        let callee = unwrap(inner.expression)
        let lastSeg = segOf(callee)
        // ⚠️ 未知基座分支同样要先剥 `call`/`apply`（Codex PR#81 第二十五轮 P2，探针复现：
        // `(pending ?? Promise.resolve()).then.call(pending, w)` 的末段是 `call`，不剥就看不见
        // 它调的是 `then` —— 而这段尾巴照样在 hook 之后执行 `w`）。
        if (lastSeg === 'call' || lastSeg === 'apply' || lastSeg === 'bind') {
          // ⚠️ `bind` 同样要剥（Codex PR#81 第二十八轮 P2，Node 实测
          // `(pending ?? P()).then.bind(pending)(w)` 在 hook 返回后才跑 `w`）—— 但只有**被绑定的
          // 那个值又被调用**时才算：`x.then.bind(p)` 单独出现只是造了个绑定函数。
          const wasBind = lastSeg === 'bind'
          // `bind` 的返回值**又被调用**：本调用节点自己是某个 CallExpression 的被调方
          // （形态 `Call(Call(Prop(Prop(基座,'then'),'bind'), 绑定实参), …)`）
          // ⚠️ 包装（括号 / 断言）不影响语义：`((p ?? P()).then.bind(p))(w)` 也**被调用**了
          // （Codex PR#81 第三十轮 P2，Node 实测 `w` 照样在 hook 之后跑）。
          const boundThenCalled = wasBind && (() => {
            let e: ts.Node = inner
            while (e.parent !== undefined
              && (ts.isParenthesizedExpression(e.parent) || ts.isAsExpression(e.parent) || ts.isNonNullExpression(e.parent)
                || ts.isSatisfiesExpression(e.parent) || ts.isTypeAssertionExpression(e.parent))) e = e.parent
            return e.parent !== undefined && ts.isCallExpression(e.parent) && e.parent.expression === e
          })()
          callee = unwrap((callee as ts.PropertyAccessExpression | ts.ElementAccessExpression).expression)
          lastSeg = segOf(callee)
          // `x.then.bind(p)` 单独出现（没被调用）不是调度 —— 只有绑定值又被调用才算
          if (wasBind && !boundThenCalled) continue
        }
        // ⚠️ **被 await 的不算**：`await (pendingTail ?? …).catch(…)` 的尾巴当场收口，
        // 不会落进下一条用例（实测：db.test.ts 的 afterAll 清理正是这种写法，误报过）。
        // ⚠️ 但「被 await」必须**真的挂在 hook 上**：`beforeEach(() => { void (async () => { await x.then(w) })() })`
        // 里 hook 既不返回也不 await 那个 IIFE，`w` 照样落在 hook 之后（CodeRabbit PR#81 第二十七轮
        // minor）。判据：从 `inner` 往上找 `await` 时**遇到函数边界就停**（IIFE 的 `async () =>`
        // 是一道边界）—— `isAwaited` 现在就是这样实现的（遇到非包装父节点即返回 false）。
        if (lastSeg !== undefined && ['then', 'catch', 'finally'].includes(lastSeg) && !isAwaited(inner)) {
          out.push({ line: lineOf(sf, inner), why: `hook 体里出现「?.${lastSeg}(」` })
        }
        continue
      }
      // ⚠️ `.call(…)` / `.apply(…)` 只是调用方式，被调函数不变（Codex PR#81 第二十二轮 P2：
      // `setTimeout.call(null, cb, 1)`、`globalThis.setTimeout.apply(null, […])` 的链末段多出
      // `call`/`apply`，探针确认 hook 尾巴照样串到下一条用例）。先把末段剥掉再匹配原语。
      const last = innerName[innerName.length - 1]
      if (innerName.length > 1 && (last === 'call' || last === 'apply')) {
        innerName.pop()
        // ⚠️ 再剥一层 `bind`：`setTimeout.bind(null).call(null, w, 80)` 的链是
        // `setTimeout.bind.call` —— 绑定结果经 call/apply 被调用同样是调度（Codex PR#81 第三十二轮 P2，
        // 探针复现）。只剥紧挨着的 `bind`（`X.call` 之类的普通调法不受影响）。
        if (innerName.length > 1 && innerName[innerName.length - 1] === 'bind'
          && ts.isCallExpression(unwrap((unwrap(inner.expression) as ts.PropertyAccessExpression).expression))) {
          innerName.pop()
        }
      }
      // `setTimeout.bind(null)(w, 80)`（Codex PR#81 第二十七轮 P2，Node 实测真的排了调度）：
      // `callChain` 穿透 `bind` 那一层调用后得到 `setTimeout.bind` —— 末段剥掉才是原语名。
      // ⚠️ 只对**被调用的**绑定值剥：`f.bind(null)(…)` 的外层调用的被调方是 `f.bind(null)`
      // 这个 CallExpression；内层 `f.bind(null)` 自己也被收集到（链相同），它不是调度 ——
      // 不去重会把同一处报两次。判据：当前调用节点的被调方是不是**另一个调用**。
      if (innerName.length > 1 && innerName[innerName.length - 1] === 'bind'
        && ts.isCallExpression(unwrap(inner.expression))) innerName.pop()
      // `setTimeout(…)` 与 `globalThis.setTimeout(…)` 都是调度；反射（`globalThis['set'+'Timeout']`）
      // 与转调 helper 内部排调度仍看不出来（见上方边界注释）。
      const bare = innerName.length === 2 && GLOBAL_HOSTS.has(innerName[0]!)
        ? [innerName[1]!]
        : innerName
      const forbidden = bare.length === 1 && HOOK_FORBIDDEN.has(bare[0]!)
        // `process.nextTick(…)`：宿主是 `process`，原语是 `nextTick`
        || (bare.length === 2 && bare[0] === 'process' && bare[1] === 'nextTick')
        // `.then/.catch/.finally(…)`：**不限于**基座是 `Promise`（CodeRabbit PR#81 第二十二轮 minor）：
        // `slowOp().then(w)`、`somePromise.finally(w)` 同样排微任务；只认 `Promise` 基座时它们
        // 全漏。代价是 `await x.then(…)` 也会被报 —— 那同样是"在 hook 里留下 Promise 回调"，
        // 判据按「末段是这三个名字」写，宁可多报也不漏（判据的边界写在 `HOOK_FORBIDDEN` 注释里）。
        || (bare.length >= 2 && ['then', 'catch', 'finally'].includes(bare[bare.length - 1]!))
      if (!forbidden) continue
      out.push({ line: lineOf(sf, inner), why: `hook 体里出现「${innerName.join('.')}(」` })
    }
  }
  return out
}

/**
 * 静态守卫：迁移形态（`captureSinks`）的两个**结构性**边界不得被"顺手"踩到。
 *
 * 两条都是 Sourcery 在 PR#72 提的，机制上无法在助手里兜住（见下面各自的说明），
 * 所以改成**禁止那种写法落地** —— 与本仓库既有的静态漂移守卫同一手法。
 *
 * ⚠️ 判据建在 **TypeScript 语法树**上（2026-11-16，PR#81 第九轮后的收敛决定）：
 * 前七轮用「抹注释 → 抹字面量 → 按字符配括号」的手写扫描，每轮修完下一轮又从邻角
 * 冒出新的文本形态（字符串里的 `)`、正则、嵌套模板、插值里的注释、`async (): X =>`
 * 执行体……）。AST 对这些给的是精确答案，判据也变成可陈述的语言层属性。
 * 剩余边界只有反射（`globalThis['set' + 'Timeout']`）与跨模块转调 —— 写在 `HOOK_FORBIDDEN`
 * 的注释里。
 */
describe('静态守卫：captureSinks 的两条边界不得被踩（Sourcery PR#72）', () => {
  const SRC_TESTS = fileURLToPath(new URL('../', import.meta.url))

  /** 递归取测试文件（跳过 fixtures）。 */
  function testFiles(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name)
      if (e.isDirectory()) { if (e.name !== 'fixtures') testFiles(p, out); continue }
      if (e.name.endsWith('.test.ts')) out.push(p)
    }
    return out
  }

  /**
   * 每个测试文件解析一次（两条守卫与白名单检查共用）。
   * ⚠️ `readdirSync` 与 `readFileSync` 之间有竞态（CodeRabbit PR#81 第十四轮）：仓库里确有
   * 测试在 `tests/` 下**临时**写 `.test.ts` 再删掉（`setup-warm.test.ts` 的子 vitest 用例，
   * 名字带 `process.pid`），并行跑时它可能在两次调用之间消失 —— 读到 `ENOENT` 不是"守卫
   * 发现了问题"，直接跳过这个文件（文件都已经没了，不存在要守的东西）。
   */
  const parsed = new Map<string, ts.SourceFile>()
  function parsedOf(f: string): ts.SourceFile | undefined {
    const hit = parsed.get(f)
    if (hit !== undefined) return hit
    let text: string
    try {
      text = readFileSync(f, 'utf8')
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw e
    }
    const sf = parseTs(text, relative(SRC_TESTS, f))
    parsed.set(f, sf)
    return sf
  }

  /** 迁移形态文件的相对路径清单（白名单键的归一化与 Windows 分隔符一致）。 */
  function migratedFiles(): Array<{ rel: string; sf: ts.SourceFile }> {
    const out: Array<{ rel: string; sf: ts.SourceFile }> = []
    for (const f of testFiles(SRC_TESTS)) {
      const sf = parsedOf(f)
      if (sf === undefined) continue
      if (!isMigratedFile(sf)) continue
      out.push({ rel: relative(SRC_TESTS, f).split(sep).join('/'), sf })
    }
    return out
  }

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
      //
      // 判据（AST，覆盖全部已知形态）：
      //   ① `.concurrent` 修饰链：`it.concurrent(…)` / `describe.shuffle.concurrent(…)` /
      //      `suite.concurrent(…)` —— 名字链里任一段是 `concurrent`；
      //   ② 选项对象 `{ concurrent: true }`：注册调用的**对象字面量实参**（含链式登记
      //      `it.each(表)('名', {…}, 体)` 的外层调用）里有该键且值为 `true`；
      //   ③ 字符串键 / 计算键（`{ 'concurrent': true }`）同属 ②。
      // 表格式实参（`it.each([[…]])`）与执行体里的同名属性是数据，不判（Vitest 不读它们）。
      const entries = migratedFiles()
      const hits = scanEntries(entries, CONCURRENT_EXEMPT)
      // ⚠️ 仓扫的合成端（CodeRabbit PR#81 第二十五/二十六轮）：
      //   ① 只开 `sequential` 的文件也要被看见（粗筛曾经只认 `concurrent` 而整份跳过）；
      //   ② **选项来自导入**、文件里没有任何开关字样的文件不得被跳过（粗筛删除后由细判判）；
      //   ③ **转发 helper** 的 `it(name, ...rest)` 静默放行（已声明边界，不再靠整份跳过实现）。
      expect(scanEntries(
        [{ rel: 'synthetic.ts', sf: parseTs(`capture${'Sinks(() => {})'}\ndescribe('g', { se${'quential: false }, () => {})'}`) }],
        {},
      ), '套件 sequential:false 必须命中').toHaveLength(1)
      expect(scanEntries(
        [{ rel: 'synthetic2.ts', sf: parseTs(`capture${'Sinks(() => {})'}\nit('x', { se${'quential: true }, () => {})'}`) }],
        {},
      ), '顺带出现 sequential 的串行文件不得报违规').toEqual([])
      expect(scanEntries(
        [{ rel: 'synthetic3.ts', sf: parseTs(`import { opts } from './x'\ncapture${'Sinks(() => {})'}\nit('x', opts, () => {})`) }],
        {},
      ), '导入的选项必须经过细判（不许被整份跳过）').toHaveLength(1)
      //   ④ 转发 helper 拆成两端：**定义体**（`it(name, ...rest)`）静默 —— 选项由调用方决定，
      //      单文件判据看不见，如实记为边界；**调用点**照常按字面选项判（`itBound` 在登记名单里）。
      expect(scanEntries(
        [{ rel: 'synthetic4.ts', sf: parseTs('capture' + 'Sinks(() => {})\n'
          + "const itBound = (name: string, ...rest: unknown[]) => it(name, ...rest)\n"
          + "itBound('x', () => {})") }],
        {},
      ), '转发 helper 定义体的展开实参静默放行（已声明边界）').toEqual([])
      expect(scanEntries(
        [{ rel: 'synthetic5.ts', sf: parseTs('capture' + 'Sinks(() => {})\n'
          + "const itBound = (name: string, ...rest: unknown[]) => it(name, ...rest)\n"
          + "itBound('x', { con" + "current: true }, () => {})") }],
        {},
      ), '转发 helper 的调用点仍按字面选项判').toHaveLength(1)
      // 细判的合成端（不经粗筛也能咬住）
      expect(concurrentViolations(parseTs(`describe('g', { se${'quential: false }, () => {})'}`)).length,
        '细判必须认套件 sequential:false').toBe(1)
      expect(hits, '这些文件同时用了 captureSinks 与 .concurrent —— 并发下写入无法归属，'
        + '要么改用句柄形态并把写入全部放进 cap.run()，要么去掉 .concurrent').toEqual([])
      // ⚠️ 白名单不得变成"永久豁免"：条目必须仍是真的豁免对象（文件存在且确实用了
      // `.concurrent`），否则删掉那条并发用例后豁免会一直留着，将来同名文件重新引入
      // 并发时就静默放行了。
      for (const rel of Object.keys(CONCURRENT_EXEMPT)) {
        expect(rel, 'CONCURRENT_EXEMPT 的键必须是 / 分隔（与上面的归一化一致）').not.toContain('\\')
        const p = join(SRC_TESTS, rel)
        expect(existsSync(p), `CONCURRENT_EXEMPT 里的 ${rel} 不存在（清单过期）`).toBe(true)
        const sfExempt = parsedOf(p)
        expect(sfExempt, `CONCURRENT_EXEMPT 里的 ${rel} 读不到`).toBeDefined()
        const still = concurrentViolations(sfExempt!).some((v) => v.why.startsWith('.concurrent'))
        expect(still, `${rel} 已不再用 .concurrent，请从 CONCURRENT_EXEMPT 删除`).toBe(true)
      }
    })

  it('用了 captureSinks 的文件，四类 hook 体里不得出现调度原语（含 beforeAll / 嵌套 afterAll）',
    () => {
      // 规则：hook 体里**一律**不得出现调度原语（定时器 / 微任务）—— 它们不在用例的异步
      // 世代里（`alsGen` 上下文只在用例体），排的延迟写入落地时按「无上下文 = 当前世代」
      // 被接收，落进此时在跑的用例。需要延迟就写成模块级 helper，在 hook 里 `await helper()`。
      //
      // ⚠️ 为什么"一律禁"而不是"放过已 await 的"（PR#81 五轮审查的收敛结论）：要静态判断
      // 「这次调度会不会被 vitest 等到」，得同时看懂 await 的对象、promise 由谁敲定、
      // 有无提前 resolve、`.then` 链是否被交出去……CR 与 Codex 五轮里报出 15 种形态，
      // 每轮修完下一轮又从邻角冒出来 —— **静态近似堵不完**。规则化后判据可判定、零误报。
      //
      // 判据（AST）：hook 调用的实参子树里，任何**对调度原语名**的 CallExpression 都算。
      // 字符串里的同名文本（`const s = 'setTimeout('`）不算 —— 那是字面量；
      // 插值 / 注释里的真调用算（`${f(setTimeout(…))}` 确实排了一次调度）。
      // 边界（如实记录）：反射（`globalThis['set' + 'Timeout'](…)`）与 hook 转调的 helper
      // 内部排调度，静态看不出来 —— 后者要靠 reviewer 看 helper 的语义。
      const hits: string[] = []
      for (const { rel, sf } of migratedFiles()) {
        for (const v of hookSchedulingViolations(sf)) hits.push(`${rel}:${v.line} ${v.why}`)
      }
      expect(hits, '这些 hook 里直接排了调度（定时器 / 微任务）—— 它们不在用例的异步世代里，'
        + '延迟写入会落进之后正在跑的用例。把延迟逻辑写成模块级 helper，在 hook 里 `await helper()`').toEqual([])
    })

  it('判据本身不许退化：两条规则的双向自检（含各轮审查报出的全部形态）', () => {
    // ⚠️ 样本一律**拼**出来：本文件也在扫描范围内，字面量会让守卫扫到自己。
    const bt = (...parts: string[]): string => parts.join('')
    const ST = bt('set', 'Timeout')
    const H = bt('before', 'Each')

    // ⚠️ 下面两个辅助**直接调生产判据**（`hookSchedulingViolations` / `concurrentViolations`）
    // —— 不能在本测试里再抄一份。第一版就是抄的：把生产判据改坏（例如 hook 不再下潜实参）
    // 时自检仍然全绿，因为它测的是自己那份副本（2026-11-16 变异实测抓到的）。
    const hookHits = (src: string): string[] =>
      hookSchedulingViolations(parseTs(src)).map((v) => v.why.replace(/^hook 体里出现「/, '').replace(/」$/, ''))
    const concHits = (src: string): string[] => {
        const out: string[] = []
      for (const v of concurrentViolations(parseTs(src))) {
        if (v.why.startsWith('.concurrent')) out.push(`alias:${v.why.replace('.concurrent 修饰链：', '')}`)
        // 「求不出」一律归 unknown —— 判据按**为什么看不见**分了几种文案（无法静态解析 /
        // 无法静态求值 / 来自访问器 / 未知来源的键），自检只关心「不许放行」
        else if (COULD_NOT_SEE.some((s) => v.why.includes(s))) out.push('unknown')
        // 兜底必须带触发条件：任何既不是 `.concurrent`、也不含「看不清」文案的说明都是**新形态**，
        // 不能默认算成 `opt`（那样求值崩掉 / 文案改了都会静默变成「放行」）。
        else if (v.why.startsWith('选项对象 concurrent 为真') || v.why === '套件选项 sequential 为假') out.push('opt')
        else out.push(`未归类：${v.why}`)

      }
      return out
    }

    // —— hook 规则：四类 hook × 四种调度原语都必须命中 ——
    for (const hook of ['before', 'after']) {
      for (const kind of ['Each', 'All']) {
        expect(hookHits(`${bt(hook, kind)}(() => { ${ST}(w, 80) })`), `${hook}${kind}`)
          .toEqual([`${ST}(`])
      }
    }
    expect(hookHits(`${H}(() => setInterval(w, 80))`)).toEqual(['setInterval('])
    expect(hookHits(`${H}(() => queueMicrotask(w))`)).toEqual(['queueMicrotask('])
    expect(hookHits(`${H}(() => setImmediate(w))`)).toEqual(['setImmediate('])
    // 微任务的另两种写法（Codex PR#81 第二十轮 P2，探针复现 FRESHTAIL 串扰）
    expect(hookHits(`${H}(() => process.nextTick(() => { w() }))`), 'nextTick 是微任务').toEqual(['process.nextTick('])
    expect(hookHits(`${H}(() => { Promise.resolve().then(() => { w() }) })`), 'Promise.then 是微任务')
      .toEqual(['Promise.resolve.then('])
    expect(hookHits(`${H}(() => { Promise.resolve().finally(() => { w() }) })`), 'finally 同样是微任务')
      .toEqual(['Promise.resolve.finally('])
    expect(hookHits(`${H}(() => { Promise.reject(e).catch(() => { w() }) })`), 'catch 同样是微任务')
      .toEqual(['Promise.reject.catch('])
    expect(hookHits(`${H}(() => { new Promise((r) => r()).then(() => { w() }) })`), 'new Promise().then')
      .toEqual(['Promise.then('])
    // 不限于 `Promise` 基座（CodeRabbit PR#81 第二十二轮 minor）：任何链末段的 then/catch/finally
    expect(hookHits(`${H}(() => { slowOp().then(w) })`), '任意 Promise 链的 then').toEqual(['slowOp.then('])
    expect(hookHits(`${H}(() => { somePromise.finally(w) })`), '任意链的 finally').toEqual(['somePromise.finally('])
    expect(hookHits(`${H}(() => { x.catch(w) })`), '任意链的 catch').toEqual(['x.catch('])
    // 反例：名字里只是恰好含 then 前缀的不是
    expect(hookHits(`${H}(() => { thenable(w) })`), 'thenable 不是 .then').toEqual([])
    // hook 登记本身经 `.call`（Codex PR#81 第二十四轮 P2）
    expect(hookHits(`${H}.call(null, () => { ${ST}(w, 50) })`), 'hook 经 .call 登记').toEqual([`${ST}(`])
    // 基座求不出名字时仍按末段回调方法判（`(pending ?? Promise.resolve()).finally(w)`）
    expect(hookHits(`${H}(() => { (pending ?? Promise.resolve()).finally(w) })`), '?? 基座的 finally')
      .toEqual(['?.finally('])
    // `.call` / `.apply` 只是调用方式，被调函数不变（Codex PR#81 第二十二轮 P2）
    // 报的是**剥掉 call/apply 之后**的名字（被调函数才是判据的主体）
    expect(hookHits(`${H}(() => { ${ST}.call(null, cb, 1) })`), 'setTimeout.call').toEqual([`${ST}(`])
    expect(hookHits(`${H}(() => { globalThis.${ST}.apply(null, [cb, 1]) })`), 'globalThis.setTimeout.apply')
      .toEqual([`globalThis.${ST}(`])
    // `await` 只算**直接**等待：`await ignore(x.then(w))` 等的是 ignore 的返回值，不是 w
    // （Codex PR#81 第二十五轮 P2，探针复现：旧判据跨过调用实参去找 await，把这种写法放行了）
    expect(hookHits(`${H}(async () => { await ignore((pending ?? Promise.resolve()).then(w)) })`),
      '跨一层调用的实参不算被等待').toEqual(['?.then('])
    // 未知基座分支同样先剥 call/apply（Codex PR#81 第二十五轮 P2）：末段是 `call` 时也要认出 `then`
    expect(hookHits(`${H}(() => { (pending ?? Promise.resolve()).then.call(pending, w) })`),
      '未知基座 + .call').toEqual(['?.then('])
    expect(hookHits(`${H}(() => { (pending ?? Promise.resolve())['catch'].apply(pending, [w]) })`),
      '未知基座 + 下标 + .apply').toEqual(['?.catch('])
    // 反例：普通 Promise 用法与无关的 .then 不是 hook 体里的延迟写入
    expect(hookHits(`${H}(async () => { await Promise.resolve() })`), 'await 不排异步尾巴').toEqual([])
    // 正控：helper 调用 / 字符串里的同名文本 / 别处的同名调用都不算（逐条对应审查报出的形态）
    expect(hookHits(`${H}(async () => { await delay(80) })`), 'await helper 应放过').toEqual([])
    expect(hookHits(`${H}(() => { const sample = "${ST}(" })`), '字符串里的调用名是数据').toEqual([])
    expect(hookHits(`${H}(() => { const re = /${ST}\\(/ })`), '正则里的调用名是数据').toEqual([])
    // 非空断言包装（Codex PR#81 第十二轮）：`setTimeout!(…)` 编译后照常调度
    expect(hookHits(`${H}(() => { ${ST}! (w, 80) })`)).toEqual([`${ST}(`])
    // 全局对象上的调度同样是调度（Codex PR#81 第十轮）
    expect(hookHits(`${H}(() => { globalThis.${ST}(w, 80) })`)).toEqual([`globalThis.${ST}(`])
    expect(hookHits(`${H}(() => { global.${ST}(w, 80) })`)).toEqual([`global.${ST}(`])
    // 字面量下标访问与点号同义（Codex PR#81 第十七轮 P2，探针复现漏检）：`globalThis['setTimeout'](…)`
    // 是**合法写法**、不是反射边界（反射是 `globalThis['set' + 'Timeout']`）。不认下标时
    // `calleeChain` 返回 undefined，这条 hook 直接放行 —— 等于把守卫绕过去。
    expect(hookHits(`${H}(() => { globalThis[${JSON.stringify(ST)}](w, 80) })`), '下标访问的全局调度')
      .toEqual([`globalThis.${ST}(`])
    expect(hookHits(`${H}(() => { window[${JSON.stringify(ST)}](w, 80) })`), 'window 下标访问').toEqual([`window.${ST}(`])
    // 逗号表达式取最右操作数（Codex PR#81 第十八轮 P2）：`(0, setTimeout)(…)` 就是 setTimeout，
    // 下行到 ES5 的模块引用也都是这个形态 —— 不穿透时 `calleeChain` 返回 undefined、守卫放行。
    expect(hookHits(`${H}(() => { (0, ${ST})(w, 1) })`), '逗号表达式里的调度').toEqual([`${ST}(`])
    // `.bind()` 后的立即调用（Codex PR#81 第二十七轮 P2，Node 实测两种形态都真的排了调度）
    expect(hookHits(`${H}.bind(null)(() => { ${ST}(w, 80) })`), 'hook 登记本身经 bind 后调用')
      .toEqual([`${ST}(`])
    expect(hookHits(`${H}(() => { ${ST}.bind(null)(w, 80) })`), 'hook 体内的调度原语经 bind 后调用')
      .toEqual([`${ST}(`])
    // 反例：只**创建**绑定函数、不调用 —— 不登记 hook、不排调度（Codex PR#81 第二十九轮 P2）
    expect(hookHits(`const registerZJ = ${H}.bind(null, () => { ${ST}(w, 80) })`), '只创建绑定函数不算 hook').toEqual([])
    // 未知基座 + `.bind()()`（Codex PR#81 第二十八轮 P2）：`(pending ?? P()).then.bind(p)(w)`
    expect(hookHits(`${H}(() => { (pending ?? Promise.resolve()).then.bind(pending)(w) })`),
      '未知基座的 then 经 bind 后调用').toEqual(['?.then('])
    // bind 的结果**外面套括号**再调用同样是调度（Codex PR#81 第三十轮 P2，Node 实测 `w` 照样在 hook 之后跑）
    expect(hookHits(`${H}(() => { ((pending ?? Promise.resolve()).then.bind(pending))(w) })`),
      '括号包住的 bind 结果被调用').toEqual(['?.then('])
    // `beforeEach.bind(null)(async () => { await ….then(w) })`：hook 自己 await 整条链 → 不算未等待。
    // ⚠️ `isHookName` 必须拿到**调用节点**才能确认 bind 的结果被调用（Codex PR#81 第三十轮 P2，
    // 旧实现不传，合法的绑定 hook 一律被判「未等待」）
    expect(hookHits(`${H}.bind(null)(async () => { await (pending ?? Promise.resolve()).then(w) })`),
      '绑定的 hook 自己 await 整条链').toEqual([])
    // 反例：绑定的 hook **只创建不调用** → 不是 hook，里面什么都不判
    expect(hookHits(`const hookZC = ${H}.bind(null, () => { ${ST}(w, 80) })`), '绑定但不调用的 hook 不扫描').toEqual([])
    // hook 体内的调度原语经 bind 后再经 call/apply 调用（Codex PR#81 第三十二轮 P2，探针复现）
    // ⚠️ 断言只钉「该形态被报出、报一次」—— 可执行性即判据；具体链文案（`setTimeout(` / `setTimeout.bind(`）
    // 取决于 `callChain` 穿透的层数，不在这里钉住
    expect(hookHits(`${H}(() => { ${ST}.bind(null).call(null, w, 80) })`), '调度原语 bind 后经 call 调用')
      .toHaveLength(1)
    expect(hookHits(`${H}(() => { ${ST}.bind(null).apply(null, [w, 80]) })`), '调度原语 bind 后经 apply 调用')
      .toHaveLength(1)
    // 绑定的 hook 经 `.call` / `.apply` 执行同样是登记（Codex PR#81 第三十二轮 P2，Node 实测照常登记）
    expect(hookHits(`${H}.bind(null, () => { ${ST}(w, 80) }).call(null)`), '绑定的 hook 经 call 执行')
      .toEqual([`${ST}(`])
    expect(hookHits(`${H}.bind(null, () => { ${ST}(w, 80) }).apply(null, [])`), '绑定的 hook 经 apply 执行')
      .toEqual([`${ST}(`])
    // 直接 await 后**存进变量**同样算等到（Codex PR#81 第二十八轮 P2）
    expect(hookHits(`${H}(async () => { const r = await (pending ?? Promise.resolve()).catch(w); void r })`),
      'await 结果存入变量仍算等到').toEqual([])
    expect(hookHits(`${H}(async () => { let r; r = await (pending ?? Promise.resolve()).catch(w); void r })`),
      'await 结果声明后赋值仍算等到').toEqual([])
    // 脱离的 IIFE 里的 `await` **不**豁免 hook 调度（CodeRabbit PR#81 第二十七轮 minor）：
    // hook 既不返回也不 await 那个 IIFE，`w` 仍落在 hook 之后
    expect(hookHits(`${H}(() => { void (async () => { await (pending ?? Promise.resolve()).then(w) })() })`),
      'IIFE 内部的 await 不算 hook 等到了').toEqual(['?.then('])
    // 正例：hook 直接 await 整条链 → 当场收口（db.test 的 afterAll 清理写法）
    expect(hookHits(`${H}(async () => { await (pending ?? Promise.resolve()).catch(w) })`),
      'hook 自己 await 整条链').toEqual([])
    // 反例：动态键仍是已声明的反射边界（`['set' + 'Timeout']` 求不出静态名）
    expect(hookHits(`${H}(() => { globalThis[${JSON.stringify('set')} + ${JSON.stringify('Timeout')}](w, 1) })`),
      '反射拼接不在静态判据内（已声明的边界）').toEqual([])
    expect(hookHits(`${H}(() => { /* ${ST}(1) */ })`), '注释里的调用名是数据').toEqual([])
    expect(hookHits(`${bt('function', ' f() { ', ST, '(w, 1) } ', H, '(() => { f() })')}`),
      'hook 之外的同名调用不归本 hook').toEqual([])
    // 真调度在字符串拼接 / 插值 / 嵌套模板里同样算（不是字面量，是代码）
    expect(hookHits(`${H}(() => { const t = \`\${${ST}(w, 1)}\` })`), '模板插值里的调用是真调度').toEqual([`${ST}(`])
    const btick = String.fromCharCode(96)
    expect(hookHits(`${H}(() => { const t = \`\${${btick}b\${${'set'}${'Interval'}(w, 1)}\`}\` })`),
      '嵌套模板插值里的调用是真调度').toEqual(['setInterval('])

    // —— 并发规则：别名 / 选项对象 / 字符串键 / 链式登记 ——
    expect(concHits(`${bt('it.', 'concurrent("x", () => {})')}`)).toEqual(['alias:it.concurrent'])
    expect(concHits(`${bt('describe.', 'shuffle.concurrent("g", () => {})')}`)).toEqual(['alias:describe.shuffle.concurrent'])
    expect(concHits(`${bt('suite.', 'concurrent("s", () => {})')}`), 'suite 是 describe 的别名').toEqual(['alias:suite.concurrent'])
    // 基座是调用、尾巴是修饰名（Codex PR#81 第十二轮）：`it.skipIf(false).concurrent(…)`
    expect(concHits(`${bt('it.skipIf(false).', 'concurrent("q", () => {})')}`), '条件基座 + concurrent')
      .toEqual(['alias:it.skipIf.concurrent'])
    // 字面量下标访问与点号同义（Codex PR#81 第十七轮 P2，探针复现漏检）：不认下标时
    // `callChain` 返回 undefined，`.concurrent` 与选项位同时漏判 —— 守卫被"合法写法"绕过。
    expect(concHits(`${bt('it[', JSON.stringify('concurrent'), ']("x", () => {})')}`), '下标访问的并发修饰')
      .toEqual(['alias:it.concurrent'])
    expect(concHits(`${bt('it[', JSON.stringify('skipIf'), '](false).concurrent(' , '"q2", () => {})')}`),
      '下标基座 + 点号修饰').toEqual(['alias:it.skipIf.concurrent'])
    // 叠加修饰（CodeRabbit PR#81 第十三轮）：条件基座 + concurrent + each。
    // ⚠️ 必须**两层以上**穿透才咬人：`it.skipIf(false).concurrent(…)` 只穿一层也成立，
    // 用单层样本时「只穿一层」的变异会存活（变异实测）。
    expect(concHits(`${bt('it.skipIf(false).concurrent.each([1])', '("case", () => {})')}`), '叠加修饰')
      .toEqual(['alias:it.skipIf.concurrent.each'])
    expect(concHits(`${bt('it.runIf(a).concurrent.skip.each([1, 2])', '("case2", () => {})')}`), '三层叠加')
      .toEqual(['alias:it.runIf.concurrent.skip.each'])
    // ⚠️ 真正依赖**递归穿透**的是「链上没有 concurrent、并发只写在选项位」的外层调用：
    // 内层调用（表格层）自己不含 concurrent，不会被单独判中；只穿一层时外层链为 undefined。
    expect(concHits(`${bt('it.skipIf(false).each([1])', '("case3", { con', 'current: true }, () => {})')}`),
      '条件基座 + each + 选项位并发').toEqual(['opt'])
    expect(concHits(`${bt("it('A', { con", 'current: true }, () => {})')}`)).toEqual(['opt'])
    expect(concHits(`${bt("it('B', { con", 'current: false }, () => {})')}`)).toEqual([])
    expect(concHits(`${bt("it('C', { 'con", "current': true }, () => {})")}`), '字符串键同属选项（Codex 第九轮）').toEqual(['opt'])
    // 计算键被括号 / 断言包装（Codex PR#81 第十二轮）：仍是静态字面量键
    expect(concHits(`${bt("it('C3', { [('con", "current')]: true }, () => {})")}`), '计算键 + 括号').toEqual(['opt'])
    expect(concHits(`${bt("it('C4', { ['con", "current' as const]: true }, () => {})")}`), '计算键 + 断言').toEqual(['opt'])
    expect(concHits(`${bt("describe('G3', { [('se", "quential')]: false }, () => {})")}`), '套件计算键 + 括号').toEqual(['opt'])
    // 括号 / 断言包装不改变语义（Codex PR#81 第十轮）
    expect(concHits(`${bt("it('C2', { con", 'current: (true) }, () => {})')}`), '括号包装').toEqual(['opt'])
    // `sequential: false` 在套件上等价并发；`it` 上的同名键不算（不是套件选项）
    expect(concHits(`${bt("describe('G', { se", 'quential: false }, () => {})')}`), '套件 sequential:false').toEqual(['opt'])
    expect(concHits(`${bt("it('G2', { se", 'quential: false }, () => {})')}`)).toEqual([])
    // itBound 是 db.test.ts 的包装登记函数（Codex PR#81 第十轮）
    expect(concHits(`${bt("itBound('H', { con", 'current: true }, () => {})')}`), 'itBound 的选项原样转给 it').toEqual(['opt'])
    expect(concHits(`${bt("it('D', { [", "'concurrent']: true }, () => {})")}`), '计算键同属选项').toEqual(['opt'])
    expect(concHits(`${bt("it.each([1, 2])('x', { con", 'current: true }, () => {})')}`), '链式登记的选项在外层调用上').toEqual(['opt'])
    // 反例：执行体里的属性 / 表格里的属性 / 无关对象都不是选项
    // 标签模板形态的 each（Codex PR#81 第十轮）：it.each<反引号>a|b<反引号>(名, 选项, 体)
    // 标签模板形态的 each（Codex PR#81 第十轮）：标签模板 + 选项对象
    const tagSrc = bt('it.each', String.fromCharCode(96), 'a|b', String.fromCharCode(96), "('x', { con", 'current: true }, () => {})')
    expect(concHits(tagSrc), '标签模板的 each 登记').toEqual(['opt'])
    // 静态对象展开按属性顺序合并（Codex PR#81 第十八轮 P2，探针证实 Vitest 按合并后的值判并发）
    expect(concHits(`${bt("it('S1', { ...{ con", 'current: true } }, () => {})')}`), '静态展开的选项').toEqual(['opt'])
    expect(concHits(`${bt("describe('S2', { ...{ se", 'quential: false } }, () => {})')}`), '静态展开的套件选项').toEqual(['opt'])
    // 后写覆盖前写：`{ ...{ concurrent: true }, concurrent: false }` 实际是串行
    expect(concHits(`${bt("it('S3', { ...{ con", 'current: true }, con', 'current: false }, () => {})')}`),
      '展开后再写 false → 不是并发').toEqual([])
    // 展开源是变量（静态求不出）：**看不见就不许放行**（CodeRabbit PR#81 第二十三轮 minor）
    expect(concHits(`${bt("const o = { con", 'current: true }\nit(\'S4\', { ...o }, () => {})')}`),
      '变量展开无法确认未开并发 → 报违规').toEqual(['unknown'])
    // ⚠️ 未知展开**可能覆盖任何键** —— 它之前的已知值全部作废（Codex PR#81 第二十轮 P2 的**误报**：
    // `{ concurrent: true, ...opts }` 在 opts 含 `concurrent: false` 时实际串行，判成并发是错的）
    expect(concHits(`${bt("it('S5', { con", 'current: true, ...opts }, () => {})')}`),
      '未知展开之后的旧值不可信 → 报 unknown 而不是判成并发').toEqual(['unknown'])
    // 但同一个对象里**显式**声明串行（展开之后）就确定不并发
    expect(concHits(`${bt("it('S5b', { ...opts, con", 'current: false }, () => {})')}`),
      '显式 concurrent:false 收口').toEqual([])
    // 但未知展开**之后**的显式赋值重新确定值
    expect(concHits(`${bt("it('S6', { con", 'current: true, ...opts, con', 'current: true }, () => {})')}`),
      '未知展开之后的显式并发仍然可判').toEqual(['opt'])
    // 嵌套展开里的未知键同样可能覆盖**外层**的旧值（CodeRabbit PR#81 第二十一轮 minor）
    expect(concHits(`${bt("it('S8', { con", 'current: true, ...{ ...opts } }, () => {})')}`),
      '嵌套展开的未知键向外传播').toEqual(['unknown'])
    // 访问器的**静态计算键**同样只覆盖它自己那个键（Codex PR#81 第二十一轮 P2 的两侧）
    expect(concHits(`${bt("it('S9', { ...{ con", "current: true }, get ['con", "current']() { return false } }, () => {})")}`),
      // 展开给了 `concurrent: true`，但后面的 getter **后写覆盖**它、值运行时才知 → 未知
      '计算键访问器覆盖展开里的并发 → 未知').toEqual(['unknown'])
    expect(concHits(`${bt("it('S10', { con", "current: true, ...{ get ['timeout']() { return 1000 } } }, () => {})")}`),
      '别的键的访问器不得清掉并发').toEqual(['opt'])
    // 选项位是标识符（CodeRabbit PR#81 第二十四轮 minor）：能解析的按值判，解析不出的不许放行
    expect(concHits(`const optI1 = ${JSON.stringify({ concurrent: true })}\nit('I1', optI1, () => {})`),
      '顶层 const 的选项对象按值判').toEqual(['opt'])
    expect(concHits(`const optI2 = ${JSON.stringify({ concurrent: false })}\nit('I2', optI2, () => {})`),
      '顶层 const 的选项对象显式串行').toEqual([])
    expect(concHits(`const optI3 = { con${'current: true }'}\nit('I3', optI3, () => {})`),
      '顶层 const 的选项对象里写并发').toEqual(['opt'])
    expect(concHits(`import { optI4 } from './x'\nit('I4', optI4, () => {})`),
      '外部导入的选项对象无法解析').toEqual(['unknown'])
    expect(concHits(`it.skipIf(posixOnly)('I5', async () => {})`), 'skipIf 的条件不是选项').toEqual([])
    expect(concHits(`it.each(cases)('I6', async () => {})`), 'each 的表格不是选项').toEqual([])
    // 两种重载（Codex PR#81 第二十四轮 P2）
    expect(concHits(`it('O1', () => {}, ${JSON.stringify({ concurrent: true })})`), '执行体在前、选项在后').toEqual(['opt'])
    // 同一片段里声明 + 使用（解析只在本文件内，跨样本不共享）
    expect(concHits(`const optO2 = ${JSON.stringify({ concurrent: false })}\nit('O2', () => {}, optO2)`),
      '执行体在前、串行选项在后').toEqual([])
    // 写入使 const 初始值失效（同一文件里 optI2 未被写入 → 上一条仍按初始化值判）。
    // ⚠️ 判据按「写入的**目标**」写、不按写法（Codex PR#81 第二十五轮 P2 探针复现：
    // `Object.assign(opts, …)` 与 `opts['concurrent'] = …` 旧判据都不认，守卫把已被改成并发的
    // 选项当成串行**放行** —— 每一行都必须各自咬住一种写法，见同轮变异验证）。
    const W = JSON.stringify({ concurrent: false })
    expect(concHits(`const optW = ${W}\noptW.concurrent = true\nit('O3', optW, () => {})`),
      '属性写入后初始值不可信').toEqual(['unknown'])
    expect(concHits(`const optW2 = ${W}\noptW2['concurrent'] = true\nit('O3b', optW2, () => {})`),
      '下标写入与点号同义').toEqual(['unknown'])
    expect(concHits(`const optW3 = ${W}\nObject.assign(optW3, { concurrent: true })\nit('O3c', optW3, () => {})`),
      'Object.assign 的目标是第一个实参').toEqual(['unknown'])
    expect(concHits(`const optW4 = ${W}\nReflect.set(optW4, 'concurrent', true)\nit('O3d', optW4, () => {})`),
      'Reflect.set 的目标是第一个实参').toEqual(['unknown'])
    expect(concHits(`const optW5 = ${W}\nconst alias5 = optW5\nObject.assign(alias5, { concurrent: true })\nit('O3e', optW5, () => {})`),
      '别名写入打的是同一个对象').toEqual(['unknown'])
    expect(concHits(`const optW6 = ${W}\noptW6.concurrent ||= true\nit('O3f', optW6, () => {})`),
      '复合赋值也是写入').toEqual(['unknown'])
    // 反例：写入的是**别的**对象 / 只是读，初始值仍可信
    expect(concHits(`const optW7 = ${W}\nconst other7 = { concurrent: false }\nObject.assign(other7, { concurrent: true })\nit('O3g', optW7, () => {})`),
      '别的对象被写不影响本对象').toEqual([])
    expect(concHits(`const optW8 = ${W}\nconsole.log(optW8.concurrent)\nit('O3h', optW8, () => {})`),
      '只读不写').toEqual([])
    // 选项值同样要静态求值（Codex PR#81 第二十五轮 P2）：标识符常量按值判，别的表达式不许放行
    expect(concHits(`const enabled = true\nit('V1', { concurrent: enabled }, () => {})`),
      '布尔常量为真 → 并发').toEqual(['opt'])
    expect(concHits(`const disabled = false\nit('V2', { concurrent: disabled }, () => {})`),
      '布尔常量为假 → 串行').toEqual([])
    expect(concHits(`let mutable = true\nmutable = false\nit('V3', { concurrent: mutable }, () => {})`),
      '被写过的常量不可信').toEqual(['unknown'])
    expect(concHits(`it('V4', { concurrent: 1 > 0 }, () => {})`), '非字面量表达式无法静态求值').toEqual(['unknown'])
    // describe/suite 的 sequential 与 concurrent 同理
    expect(concHits(`const seqOff = false\ndescribe('V5', { sequential: seqOff }, () => {})`),
      'sequential 取常量假 → 等价并发').toEqual(['opt'])
    expect(concHits(`describe('V6', { get sequential() { return false } }, () => {})`),
      'sequential 来自访问器 → 值运行时才知道').toEqual(['unknown'])
    // 选项位不是对象字面量 / 常量：调用返回值、条件表达式都不许放行（Codex PR#81 第二十五轮 P2）
    expect(concHits(`const getOptions = () => ({ concurrent: true })\nit('V7', getOptions(), () => {})`),
      '调用返回值无法静态求值').toEqual(['unknown'])
    expect(concHits(`it('V8', condition ? { concurrent: true } : { concurrent: false }, () => {})`),
      '条件表达式两个分支都要看').toEqual(['unknown'])
    // 登记调用经 .call / .apply（Codex PR#81 第二十五轮 P2）：实参要按登记形态还原
    expect(concHits(`it.call(null, 'C1', { concurrent: true }, () => {})`), '.call 的登记实参').toEqual(['opt'])
    expect(concHits(`it.apply(null, ['C2', { concurrent: true }, () => {}])`), '.apply 的实参数组').toEqual(['opt'])
    expect(concHits(`it.call(null, 'C3', () => {})`), '.call 的合法串行登记').toEqual([])
    // 具名执行体：`function body() {}` / `const body = () => {}` 是执行体，不是选项（误报回归）
    expect(concHits(`function bodyFn() {}\nit('N1', bodyFn)`), '函数声明作执行体').toEqual([])
    expect(concHits(`const bodyAr = () => {}\nit('N2', bodyAr)`), '箭头常量作执行体').toEqual([])
    // 执行体在前时第 3 个才是选项：`bodyAr2` 在那里是**选项位**、求不出的标识符 → 不许放行
    expect(concHits(`const bodyAr2 = () => {}\nit('N3', () => {}, bodyAr2)`), '求不出的选项位').toEqual(['unknown'])
    expect(concHits(`const bodyAr3 = () => {}\nconst opt3 = { concurrent: false }\nit('N4', bodyAr3, opt3)`),
      '具名执行体 + 常量选项').toEqual([])
    // —— 第二十五轮 CR/Codex 的新形态 ——
    // 数字实参是**超时**不是选项（`@vitest/runner` 的 `parseArguments`：number → `{ timeout }`）
    expect(concHits(`it('T1', async () => {}, 40_000)\nconst oth = { con${'current: false }'}`),
      '数字超时不算选项（文件里别处有 concurrent 才走细判）').toEqual([])
    expect(concHits(`it('T2', { con${'current: true }, () => {}, 40000)'}`), '超时与选项共存').toEqual(['opt'])
    // 写入 API 的名字链 / 调用方式都要还原（Codex 第二十五轮 P2）
    // ⚠️ **样本里被赋值的必须是对象字面量本身、不是 JSON 文本**：`JSON.stringify({concurrent:false})`
    // 的产物键带引号（`{"concurrent":false}`），后面的 `{ concurrent: true }` 是**不带引号**的键；
    // Vitest 里两者既然都能合并，判据也按「两种键写法同义」处理。首版样本用 JSON 文本 + 无引号键，
    // 判据在「无引号值没被认出来」时仍报 unknown，用例**假绿**（实测：把 concurrent 求值直接改成
    // 返回 false 也照样通过）。样本因此改用同一种键写法，并先钉住「两种键写法都认」。
    const Zq = '{ con' + 'current: false }'
    expect(concHits(`const oB = ${Zq}\nit('B0', { con${'current: true }'}, () => {})`), '无引号键同样按选项求值').toEqual(['opt'])
    expect(concHits(`const oQ1 = ${Zq}\nObject[${JSON.stringify('assign')}](oQ1, { con${'current: true }'})\nit('Q1', oQ1, () => {})`),
      '下标形式的 Object.assign').toEqual(['unknown'])
    // 反例（Q2b）：守卫只认写入 API 的**方法名**（`set`），`Reflect.set.call(…, otherQ2b, …)` 的目标是
    // `otherQ2b`，不能算写到 `oQ2b`。
    // ⚠️ 不要换成三段链 `Object.assign.call`：三段属性链在测试环境里可能读不出中间段（见
    // `writesThroughCallee` 的注释），那样对象会被判「无法静态解析」，反例就测不到「目标位置」了。
    expect(concHits(`const oQ2 = ${Zq}\nReflect.set.call(null, oQ2, ${JSON.stringify('concurrent')}, true)\nit('Q2', oQ2, () => {})`),
      '.call 的目标是第二个实参（thisArg 之后）').toEqual(['unknown'])
    // 反例：`.call` 写到**别的对象**上（`Reflect.set.call(null, otherQ2b, …)` 的 thisArg 是 null、
    // 目标是 `otherQ2b`）—— 目标位置取错（把 thisArg 当目标）时会误报违规，这条因此咬住位置。
    expect(concHits(`const oQ2b = ${Zq}\nconst otherQ2b = {}\nReflect.set.call(null, otherQ2b, ${JSON.stringify('concurrent')}, true)\nit('Q2b', oQ2b, () => {})`),
      '.call 写给别的对象不算写入（咬住位置）').toEqual([])
    // `.bind` 预绑定实参 + `.call`：`Object.assign.bind(null, o).call(null, x)` 真写到 **o**
    // （bind 的实参 1 起是预绑定实参）。两条一起钉住「预绑定实参要接上」与「目标位置不能被实参顶掉」。
    expect(concHits(`const oQ25 = ${Zq}\nObject.assign.bind(null, oQ25).call(null, { con${'current: true }'})\nit('Q25', oQ25, () => {})`),
      'bind 预绑定实参 + .call 的目标是预绑定的那个').toEqual(['unknown'])
    expect(concHits(`const oQ26 = ${Zq}\nconst otherQ26 = {}\nObject.assign.bind(null, otherQ26).call(null, { con${'current: true }'})\nit('Q26', oQ26, () => {})`),
      'bind 预绑定别的对象 → .call 的实参不是目标').toEqual([])
    // `.call` 的基座是**别的调用**（不是 `bind`）：看不出预绑定了什么 → 整条序列不可知、按写过。
    // 变异实测：把这一档改回「按本次实参判」后没有用例变红，才补了这条样本（Codex PR#81 第三十二轮）。
    expect(concHits(`const oQ26b = ${Zq};\nObject.assign({}, oQ26b).call(null, { con${'current: true }'})\nit('Q26b', oQ26b, () => {})`),
      '.call 的基座是普通调用 → 看不清').toEqual(['unknown'])

    // 展开的实参：`Object.assign(...[o, {…}])` 的展开元素里含目标 —— 目标位置看不出来，按写过（unknown）。
    // 展开的实参里有没有目标都看不出来（展开数组是变量 / 字面量同理）—— 一律按写过。
    expect(concHits(`const oQ28 = ${Zq}\nconst argsQ28 = [oQ28, { con${'current: true }'}] as const\nObject.assign(...argsQ28)\nit('Q28', oQ28, () => {})`),
      '展开数组里的目标（经变量）').toEqual(['unknown'])
    // `.call` 分支同样要看展开（CodeRabbit PR#81 第三十二轮 minor）：`Object.assign.call(null, ...[o, {…}])`
    expect(concHits(`const oQ32 = ${Zq}\nObject.assign.call(null, ...[oQ32, { con${'current: true }'}])\nit('Q32', oQ32, () => {})`),
      '.call 的实参经展开').toEqual(['unknown'])
    // 被调用的 `.bind`（预绑定实参）里的展开同样不可知（只创建不调用的 bind 见下方样本，不算写入）
    expect(concHits(bt('const oQ33 = ', Zq, ';', '\nconst fQ33 = Object.assign.bind(null, oQ33, { con', 'current: true })', '\nfQ33()', "\nit('Q33', oQ33, () => {})").replace('Zq', Zq)),
      '绑定函数变量被调用：预绑定实参静态看不见，按边界放过').toEqual([])

    // 只创建、**不调用**的 `bind` 不是写入（Codex PR#81 第三十二轮 P2）；展开形态同样不算
    expect(concHits(`const oQ34 = ${Zq}\nconst fQ34 = Object.assign.bind(null, oQ34, { con${'current: true }'})
it('Q34', oQ34, () => {})`),
      '只创建绑定函数不算写入').toEqual([])
    expect(concHits(`const oQ35 = ${Zq}\nconst fQ35 = Object.assign.bind(null, ...[oQ35, { con${'current: true }'}])\nit('Q35', oQ35, () => {})`),
      '只创建绑定函数（展开实参）同样不算写入').toEqual([])
    // 执行体放在 `.apply` 的实参数组里：`it.apply(null, [名, {…}, 体])` 的执行体不得被当成选项
    expect(concHits(`it.apply(null, ['Q36', { con${'current: true }'}, () => {}])`),
      '.apply 实参数组里的执行体').toEqual(['opt'])
    // 循环赋值目标：`for (oQ30.concurrent of [true])` 改写选项；反例是写到别的对象
    expect(concHits(`const oQ30 = ${Zq}\nfor (oQ30.concurrent of [true]) {}\nit('Q30', oQ30, () => {})`),
      'for-of 右侧给选项赋值').toEqual(['unknown'])
    expect(concHits(`const oQ31 = ${Zq}\nconst otherQ31 = {}\nfor (otherQ31.concurrent of [true]) {}\nit('Q31', oQ31, () => {})`),
      'for-of 写给别的对象不算写入').toEqual([])
    expect(concHits(`const oQ29 = ${Zq}\nconst otherQ29 = {}\nObject.assign(...[otherQ29, { con${'current: true }'}])\nit('Q29', oQ29, () => {})`),
      '展开数组里的目标不是它 —— 保守同样按写过').toEqual(['unknown'])
    // 两种取法在首轮变异里都通过（`null` 永远不是别名 —— 等价变异，不是真覆盖）。
    expect(concHits(`const oQ3 = ${Zq}\nObject.assign.apply({}, [oQ3, { con${'current: true }'}])\nit('Q3', oQ3, () => {})`),
      'Object.assign.apply 的数组是第二个实参').toEqual(['unknown'])
    // 反例：`.apply` 写给**别的**对象 —— 目标位置取错（指向 thisArg）时会保守报违规，这行因此
    // 咬得住实参位置的变异（Codex 第二十五轮 P2）
    expect(concHits(`const oQ6 = ${Zq}\nconst otherQ6 = { x: 1 }\nObject.assign.apply(null, [otherQ6, { con${'current: true }'}])\nit('Q6', oQ6, () => {})`),
      'apply 写给别的对象不算写入').toEqual([])
    // 建立别名本身**不是**写入（Codex 第二十五轮 P2 的误报）
    expect(concHits(`const oQ4 = ${Zq}\nconst aliasQ4 = oQ4\nit('Q4', oQ4, () => {})`),
      '只建别名不改值').toEqual([])
    // 别名经**赋值**建立（CodeRabbit PR#81 第二十六轮 minor，序列可复现）
    expect(concHits(`const oQ7 = ${Zq}\nlet aliasQ7\naliasQ7 = oQ7\naliasQ7.concurrent = true\nit('Q7', oQ7, () => {})`),
      '赋值建立的别名同样写穿原对象').toEqual(['unknown'])
    expect(concHits(`const oQ8 = ${Zq}\nlet aliasQ8\naliasQ8 = oQ8\nit('Q8', oQ8, () => {})`),
      '只赋值建立别名、不改值 → 仍可信').toEqual([])
    // 重赋值**原名自己**同样是写入（CodeRabbit PR#81 第二十七轮 minor）：`opts = opts.next!` 之后
    // 登记拿到的是另一个对象，静态保留的 `concurrent: false` 已经过时
    expect(concHits(bt('const oQ10 = { con', 'current: false, next: { con', "current: true } }\noQ10 = oQ10.next!\nit('Q10', oQ10, () => {})")),
      '原绑定被重赋值 → 初始值作废').toEqual(['unknown'])
    // 解构赋值写穿别名（CodeRabbit PR#81 第二十八轮 minor）
    expect(concHits(bt('let optQD = ', 'Zq', '\n;[optQD] = [{ con', 'current: true }]\nit(\'QD\', optQD, () => {})').replace('Zq', Zq)),
      '数组解构赋值是写入').toEqual(['unknown'])
    expect(concHits(bt('let optQE = ', 'Zq', '\n;({ a: optQE } = { a: { con', 'current: true } })\nit(\'QE\', optQE, () => {})').replace('Zq', Zq)),
      '对象解构赋值是写入').toEqual(['unknown'])
    // 名字链求不出 ≠ 没写入（Codex PR#81 第二十七轮 P2，Node 实测 `(w ?? Reflect).set(…)` 真的写）
    expect(concHits(`${bt('const oQ11 = ', 'Zq', ';')}\n(flagQ11 ?? Reflect).set(oQ11, ${JSON.stringify('concurrent')}, true)\nit('Q11', oQ11, () => {})`.replace('Zq', Zq)),
      '名字链求不出时按静态尾段 + 目标实参判').toEqual(['unknown'])
    // `import { opts as undefined }` 让 `undefined` 不再是全局值（Codex PR#81 第二十八轮 P2）
    expect(concHits(bt('import { opts as undefined } from \'./opts\'\nit(\'QU3\', undefined, () => {})')),
      '被导入遮蔽的 undefined 不是空选项').toEqual(['unknown'])
    // 对象**方法**的键（Codex PR#81 第二十八轮 P2）：`{ [key]() {} }` 的值是函数（真值），Vitest 照常并发
    expect(concHits(bt('const keyQM: string = ', JSON.stringify('concurrent'), '\nit(\'QM\', { [keyQM]() {} }, () => {})')),
      '未知计算键方法 → 看不清').toEqual(['unknown'])
    expect(concHits(bt('const keyQN: string = ', JSON.stringify('concurrent'), '\nit(\'QN\', { se', 'quential: true, [keyQN]() {} }, () => {})')),
      '未知计算键方法同样作废旧值').toEqual(['unknown'])
    // ⚠️ 样本必须用 `;` **终止**常量声明（Codex PR#81 第三十轮 P2）：下一行以 `(` 开头时，
    // TypeScript 把它解析成「对对象字面量的调用」（ASI 不插分号），initializer 成了 CallExpression
    // —— 这些样本原先判绿的**真实原因**是初始值解析不出，而不是写入判据命中，变异杀不死。
    // 下标形式的 bind / 未知基座的 bind / 全局宿主前缀（Codex PR#81 第二十九轮 P2，Node 实测均写入）

    expect(concHits(bt('const oQ18 = ', Zq, ';', '\nObject[', JSON.stringify('assign'), "][", JSON.stringify('bind'), '](null)(oQ18, { con', 'current: true })', "\nit('Q18', oQ18, () => {})")),
      '下标形式的 Object.assign.bind').toEqual(['unknown'])
    expect(concHits(bt('const oQ19 = ', 'Zq', ';', '\n(writerQ19 ?? Reflect).set.bind(null)(oQ19, ', JSON.stringify('concurrent'), ', true)', "\nit('Q19', oQ19, () => {})").replace('Zq', Zq)),
      '未知基座 + bind').toEqual(['unknown'])
    expect(concHits(bt('const oQ20 = ', 'Zq', ';', '\nglobalThis.Object.assign(oQ20, { con', 'current: true })', "\nit('Q20', oQ20, () => {})").replace('Zq', Zq)),
      'globalThis 前缀归一化').toEqual(['unknown'])
    expect(concHits(bt('const oQ21 = ', 'Zq', ';', '\nglobalThis.Object.assign(otherQ21, { con', 'current: true })', "\nit('Q21', oQ21, () => {})").replace('Zq', Zq)),
      'globalThis 前缀下写别的对象不影响本对象').toEqual([])
    // `.bind` 的预绑定实参（CodeRabbit PR#81 第二十九轮 minor，Node 实测写入）
    expect(concHits(bt('const oQ17 = ', 'Zq', ';', '\nObject.assign.bind(null, oQ17)({ con', 'current: true })', "\nit('Q17', oQ17, () => {})").replace('Zq', Zq)),
      'bind 预绑定的实参排在调用实参之前').toEqual(['unknown'])
    // 已知基座 + `.bind(null)(…)` 立即调用（Codex PR#81 第二十八轮 P2，Node 实测写入）
    expect(concHits(bt('const oQ16 = ', 'Zq', ';', '\nObject.assign.bind(null)(oQ16, { con', 'current: true })', "\nit('Q16', oQ16, () => {})").replace('Zq', Zq)),
      'Object.assign.bind(null)(…) 是写入').toEqual(['unknown'])
    // `.bind` 预绑定 + `.call` / `.apply`：目标仍是预绑定的那个（Codex PR#81 第三十轮 P2）
    expect(concHits(bt('const oQ22 = ', 'Zq', ';', "\nObject.assign.bind(null, oQ22).call(null, { con", 'current: true })', "\nit('Q22', oQ22, () => {})").replace('Zq', Zq)),
      'bind 预绑定 + call').toEqual(['unknown'])
    expect(concHits(bt('const oQ23 = ', 'Zq', ';', "\nObject.assign.bind(null, oQ23).apply(null, [{ con", 'current: true }])', "\nit('Q23', oQ23, () => {})").replace('Zq', Zq)),
      'bind 预绑定 + apply').toEqual(['unknown'])
    // 名字链求不出 + 经 `.call`（CodeRabbit PR#81 第二十八轮 minor，Node 实测真的写）
    expect(concHits(`${bt('const oQ14 = ', 'Zq', ';')}\n(flagQ14 ?? Reflect).set.call(null, oQ14, ${JSON.stringify('concurrent')}, true)\nit('Q14', oQ14, () => {})`.replace('Zq', Zq)),
      '未知基座 + .call 的目标是实参 1').toEqual(['unknown'])
    expect(concHits(`${bt('const oQ15 = ', 'Zq', ';')}\n(flagQ15 ?? Reflect).set.apply(oQ15, [oQ15, ${JSON.stringify('concurrent')}, true])\nit('Q15', oQ15, () => {})`.replace('Zq', Zq)),
      '未知基座 + .apply 的数组是第二个实参').toEqual(['unknown'])
    // ⚠️ 位置对照组（CodeRabbit PR#81 第二十九轮 major）：目标只在**实参数组**里、thisArg 是别的对象
    // → 仍是写入；反过来 thisArg 是 oQ15b、数组里是别的对象 → 不是写入。两组一起钉住位置。
    expect(concHits(`${bt('const oQ15b = ', 'Zq', ';')}\nconst otherQ15b = {}\n(flagQ15b ?? Reflect).set.apply(otherQ15b, [oQ15b, ${JSON.stringify('concurrent')}, true])\nit('Q15b', oQ15b, () => {})`.replace('Zq', Zq)),
      '目标在实参数组里（thisArg 是别的对象）').toEqual(['unknown'])
    expect(concHits(`${bt('const oQ15c = ', 'Zq', ';')}\nconst otherQ15c = {}\n(flagQ15c ?? Reflect).set.apply(oQ15c, [otherQ15c, ${JSON.stringify('concurrent')}, true])\nit('Q15c', oQ15c, () => {})`.replace('Zq', Zq)),
      '目标只在 thisArg 里 → 不是对它的写入').toEqual([])
    // 反例：尾段不是写入 API，或目标是别的对象 → 不得作废
    expect(concHits(`${bt('const oQ12 = ', 'Zq', ';')}\nconst loggerQ12 = { info: (x: unknown) => x }\n(writerQ12 ?? loggerQ12).info(oQ12)\nit('Q12', oQ12, () => {})`.replace('Zq', Zq)),
      '求不出名字的无关调用').toEqual([])
    expect(concHits(`${bt('const oQ13 = ', 'Zq', ';')}\nconst otherQ13 = {}\n(writerQ13 ?? Reflect).set(otherQ13, ${JSON.stringify('concurrent')}, true)\nit('Q13', oQ13, () => {})`.replace('Zq', Zq)),
      '求不出名字但目标不是本对象').toEqual([])
    // 无关调用不得让初始值作废（CodeRabbit PR#81 第二十六轮 minor：`.apply` 的保守分支
    // 原先在 `isWriteApi` 判断之前就 `return true`）
    expect(concHits(`const oQ9 = ${Zq}\nconst noopQ9 = (a: unknown) => a\nnoopQ9.apply(null, argsQ9)\nit('Q9', oQ9, () => {})`),
      '无关的 .apply 不影响选项初始值').toEqual([])
    // 第三实参是能静态解析成对象的常量（CodeRabbit PR#81 第二十八轮 minor）
    expect(concHits(bt('import { handlerZF } from \'./x\'\nconst optsZF = { con', "current: false }\nit('ZF', handlerZF, optsZF)")),
      '执行体来自导入、第三位是常量对象').toEqual([])
    expect(concHits(bt('import { handlerZG } from \'./x\'\nconst optsZG = { con', "current: true }\nit('ZG', handlerZG, optsZG)")),
      '第三位常量对象里的显式并发仍要判').toEqual(['opt'])
    // 执行体来自导入、第三实参是显式对象（Codex PR#81 第二十七轮 P2，Vitest 按 parseArguments
    // 「第三实参是对象优先」登记）：不得把 handler 当选项报红
    expect(concHits(bt('import { handlerZD } from \'./x\'\nit(\'ZD\', handlerZD, { con', 'current: false })')),
      '执行体来自导入、选项在第三位').toEqual([])
    expect(concHits(bt('import { handlerZE } from \'./x\'\nit(\'ZE\', handlerZE, { con', 'current: true })')),
      '执行体来自导入、第三位显式并发仍要判').toEqual(['opt'])
    // 执行体来自导入 + 第三实参是数字超时（Codex PR#81 第二十九轮 P2）
    expect(concHits(bt('import { handlerZH } from \'./x\'\nit(\'ZH\', handlerZH, 40_000)\nconst othZH = { con', 'current: false }')),
      '导入执行体 + 数字超时').toEqual([])
    // describe 回调里声明的具名执行体（同轮 P2）
    // ⚠️ 必须是 `it(名, {…}, 执行体)` 形态：判断「首个剩余实参是不是执行体」正是这条行为的
    // 唯一入口。曾写成 `it('ZK', bodyZK)`（选项缺省），那样 `rest[0]` 不论能不能解析成函数，
    // 都会被当成选项去判、又从没 concurrent 键 → 恒不违规，变异杀不死（2026-11-17 实测）。
    // 两实参形态 `it(名, 执行体)` 是 `functionBinding` 的**唯一**入口（三实参形态由
    // `thirdResolvesToObject` 先接走）。选项对象形态 `it(名, {…}, 体)` 另验。
    expect(concHits(bt('const regZK = () => { const bodyZK = () => {}; it(\'ZK\', bodyZK) }\nvoid regZK\nconst othZK = { con', 'current: false }')),
      'IIFE/函数体里声明的执行体').toEqual([])
    expect(concHits(bt('const regZL = () => { const bodyZL = () => {}; it(\'ZL\', { con', 'current: true }, bodyZL) }\nvoid regZL\nconst othZL = { con', 'current: false }')),
      '函数体里声明的执行体 + 第三位并发选项').toEqual(['opt'])
    // 「options-first」两实参形态：`it(名, 选项)` 是合法登记（只请求选项、无执行体）。内层声明的
    // 选项对象**解不开**（`staticBindingInitializer` 只认唯一同名声明、且按设计更保守）→ 必须
    // 落 unknown、不许放行 —— 否则就是把「可能开了并发」当成「没开」
    // ⚠️ 本条**不举证**「具名执行体不限顶层作用域」那条实现：实测 `functionBinding` 返回 false
    // 时 `optZM` 照样落进选项判据并给出 unknown（不放行），把 `visit(sf)` 改成只走顶层语句、
    // 或把命中改成立即 return，本文件输出都**完全相同**（2026-11-18 逐个变异核对）。
    // 它保留的是「内层声明的选项对象不许被放行」这条行为；实现里那两处注释的变异可杀性
    // 如实记为**未覆盖**，不在这里凑数。
    expect(concHits(bt('const regZM = () => { const optZM = { timed', 'out: 1 }; it(\'ZM\', optZM) }\nvoid regZM')),
      '函数体里声明、解不开的选项对象').toEqual(['unknown'])
    // 数字**常量**也是超时（Codex PR#81 第二十七轮 P2，Vitest 实测照常登记串行）
    expect(concHits(bt('const TEST_TIMEOUT = 40000\nit(\'ZT\', () => {}, TEST_TIMEOUT)\nconst othZT = { con', 'current: false }')),
      '数字常量超时不算选项').toEqual([])
    // 展开实参**不能**抹掉它之前的显式选项（CodeRabbit PR#81 第二十七轮 minor）：
    // `it('x', { concurrent: true }, ...([fn] as const))` 展开后按 `it(名, 选项, 体)` 登记，仍并发
    expect(concHits(bt("it('QV', { con", 'current: true }, ...([() => {}] as const))')),
      '展开之前的显式选项照常判').toEqual(['opt'])
    // `it('x', undefined, fn)` 是合法的空选项重载（同轮 minor，探针核对 parseArguments）
    expect(concHits(`it('QU', undefined, () => {})`), 'undefined 选项位是空选项').toEqual([])
    expect(concHits(`it('QU2', void 0, () => {})`), 'void 0 同样空选项').toEqual([])
    // 局部别名写穿同一个对象（Codex 第二十五轮 P2）
    // ⚠️ 中间必须隔一层：别名与写入若相邻成 `const a = o; Object.assign(a, …)`，`a` 会自己出现在
    // `o` 的别名集里（它是 `const a = o` 的**被声明名**）——「只收顶层别名」的变异照样通过（等价变异）。
    // 隔一层 `describe` 回调之后，`a` 只在作用域内部被声明，顶层扫描看不见它。
    expect(concHits(`const oQ5 = ${Zq}\ndescribe('g', () => { const aliasQ5 = oQ5\n  describe('h', () => { Object.assign(aliasQ5, { con${'current: true }'}) }) })\nit('Q5', oQ5, () => {})`),
      '作用域内的别名').toEqual(['unknown'])
    // 套件上显式 `sequential: true` 是串行收口（Codex 第二十五轮 P2）
    expect(concHits(`describe('Q9', { ...optsQ, se${'quential: true }, () => {})'}`),
      'sequential:true 收口未知展开').toEqual([])
    // 访问器被后写的数据属性覆盖 → 值确定（Codex 第二十五轮 P2）
    const g = bt('get con', 'current() { return true }')
    expect(concHits(bt("it('QA', { ...{ ", g, ' }, con', 'current: false }, () => {})')),
      '后写属性覆盖访问器').toEqual([])
    // 局部遮蔽顶层常量（Codex 第二十五轮 P2「按初始化位置求值」，探针复现）：同名局部声明让静态值作废
    expect(concHits(bt('const enabledZa = true\nit(\'Za1\', { con', 'current: enabledZa }, () => {})')), '布尔常量为真 → 并发').toEqual(['opt'])
    expect(concHits(bt('const enabledZb = false\ndescribe(\'zb\', () => { const enabledZb = true })\nit(\'Zb1\', { con', 'current: enabledZb }, () => {})')),
      '局部遮蔽 → 顶层值不可见').toEqual(['unknown'])
    expect(concHits(bt('const enabledZf = false\ndescribe(\'zf\', () => { const { enabledZf } = { enabledZf: true } })\nit(\'Zf1\', { con', 'current: enabledZf }, () => {})')),
      '解构里的同名绑定同样遮蔽').toEqual(['unknown'])
    expect(concHits(bt('const enabledZc = false\nfunction setup(enabledZc) { return enabledZc }\nit(\'Zc1\', { con', 'current: enabledZc }, () => {})')),
      '参数同名同样遮蔽').toEqual(['unknown'])
    expect(concHits(bt('const enabledZd = true\nit(\'Zd1\', { con', 'current: enabledZd }, () => {})')), '无遮蔽时按常量求值').toEqual(['opt'])
    // 后写的**展开**覆盖同名访问器（CodeRabbit PR#81 第二十六轮 minor）：
    // `{ ...{ get concurrent() {…} }, ...{ concurrent: false } }` 实际按串行登记
    const g2 = bt('get con', 'current() { return true }')
    expect(concHits(bt("it('QB', { ...{ ", g2, ' }, ...{ con', 'current: false } }, () => {})')),
      '后写展开覆盖访问器 → 值确定').toEqual([])
    // getter 的 concurrent：值在运行时才知道
    expect(concHits(`it('O4', { get con${'current() { return true }'}, })`), 'getter 并发值未知').toEqual(['unknown'])
    // 未知**计算键访问器**同样可能覆盖任何键
    expect(concHits(`${bt("it('S13', { con", 'current: true, get [key]() { return false } }, () => {})')}`),
      '未知计算键访问器使旧值不可信').toEqual(['unknown'])
    // 未知**计算键**同样可能覆盖任何键（CodeRabbit PR#81 第二十二轮 minor）
    expect(concHits(`${bt("it('S11', { con", 'current: true, [key]: false }, () => {})')}`),
      '未知计算键使旧值不可信').toEqual(['unknown'])
    // 但未知计算键**之后**的显式赋值重新确定值
    expect(concHits(`${bt("it('S12', { [key]: false, con", 'current: true }, () => {})')}`),
      '未知计算键之后的显式并发仍可判').toEqual(['opt'])
    // 访问器覆盖同名值：`{ concurrent: true, get concurrent() { return false } }` 实际串行
    expect(concHits(`${bt("it('S7', { con", 'current: true, get con', 'current() { return false } }, () => {})')}`),
      '同名访问器覆盖显式并发 → 值未知').toEqual(['unknown'])
    expect(concHits(`${bt("it('E', () => { const p = { con", 'current: true } })')}`), '执行体里的是数据').toEqual([])
    expect(concHits(`${bt("it('F', async (): Promise<void> => { const p = { con", 'current: true } })')}`),
      '带返回类型的 async 执行体（Codex 第九轮）').toEqual([])
    expect(concHits(`${bt("it('G', function () { const p = { con", 'current: true } })')}`),
      'function 执行体（Codex 第九轮）').toEqual([])
    expect(concHits(`${bt("it.each([{ con", "current: true }])('x', () => {})")}`), '表格里的是数据').toEqual([])
    expect(concHits(`${bt("const payload = { con", "current: true }\nit('x', () => {})")}`), '无关对象').toEqual([])
    expect(concHits(`const s = ${JSON.stringify(bt('it.', 'concurrent'))}\nit('y', () => {})`), '字符串里的别名是数据').toEqual([])
    // 迁移形态判据（AST）：`captureSinks(` 调用才算，字符串 / 注释里提到它不算
    const isMigrated = (src: string): boolean => isMigratedFile(parseTs(src))
    expect(isMigrated(bt('capture', 'Sinks((a) => {}, (b) => {})'))).toBe(true)
    expect(isMigrated('const cap = startCapture()')).toBe(false)
    expect(isMigrated(`// ${bt('capture', 'Sinks(')} 只是注释\nconst a = 1`)).toBe(false)
    expect(isMigrated(`const s = ${JSON.stringify(bt('capture', 'Sinks('))}`)).toBe(false)
    expect(parseTs).toBeTypeOf('function')
  })
})
