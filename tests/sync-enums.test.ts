// tests/sync-enums.test.ts
//
// 「sync 输出里的枚举值必须有图例」的可执行判据（2026-10-27）。
//
// `gaps[].reason` 与 `drift[].kind` 都是 Agent 要按值分支的机器值。**这里不写死个数**：
// 2026-11-02 加了一个任务层 reason 后，「8 值」「四个业务提示」这类计数断言全部失真——
// 值域以 `ENGINE_GAP_REASONS` / `TASK_GAP_REASONS` / `DRIFT_KINDS` 为准。
// 此前全仓没有一处给出值表：README 只列字段名，skill 只让 Agent「看缺口」，
// 任务层的业务 reason 连类型都没进（`gapHint.reason: string` + `as` 强转）。
// 本文件把**源码枚举**与 **README 图例**双向锁住：
//   · 源码加了值但 README 没写 → 红（图例必须同步）；
//   · README 写了源码里不存在的值 → 红（图例不能虚报）。
// 与 `tests/plaintext-channels.test.ts` 同一思路：能静态判定的规则不靠人肉枚举。
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ENGINE_GAP_REASONS } from '../src/sync/engine.js'
import { TASK_GAP_LOSSY_REASONS, TASK_GAP_REASONS } from '../src/sync/types.js'
import { DRIFT_KINDS } from '../src/commands/sync.js'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

const GAP_REASONS: string[] = [...ENGINE_GAP_REASONS, ...TASK_GAP_REASONS]

/** README 的 gaps 图例段：从图例标题到 drift 图例标题之间。 */
function gapLegendSection(): string {
  const s = read('README.md')
  const start = s.indexOf('**`gaps[].reason` 的全部取值**')
  const end = s.indexOf('**`drift[].kind` 的全部取值**')
  expect(start, 'README 缺 gaps 图例段').toBeGreaterThan(-1)
  expect(end, 'README 缺 drift 图例段（gaps 段的右边界）').toBeGreaterThan(start)
  return s.slice(start, end)
}

/** README 的 drift 图例段：标题起的一个自然段。 */
function driftLegendSection(): string {
  const s = read('README.md')
  const start = s.indexOf('**`drift[].kind` 的全部取值**')
  expect(start, 'README 缺 drift 图例段').toBeGreaterThan(-1)
  const end = s.indexOf('\n\n', start)
  return s.slice(start, end === -1 ? undefined : end)
}

describe('sync 枚举 ↔ README 图例（双向）', () => {
  it('源码枚举非空且无重复（防止判据在空集合上恒真）', () => {
    expect(GAP_REASONS.length).toBeGreaterThan(0)
    expect(new Set(GAP_REASONS).size).toBe(GAP_REASONS.length)
    expect(DRIFT_KINDS.length).toBeGreaterThan(0)
    expect(new Set(DRIFT_KINDS).size).toBe(DRIFT_KINDS.length)
  })

  it.each(GAP_REASONS)('gap reason「%s」在 README 图例里有释义', (reason) => {
    // 图例表每行形如 `| \`reason\` | 含义 | 动作 |` —— 必须在**图例段内**出现，
    // 全文匹配会让「reason 恰好出现在别处」蒙混过关。
    expect(gapLegendSection()).toContain(`\`${reason}\``)
  })

  it('图例里没有源码不存在的 gap reason（删值必须同步删图例）', () => {
    const rows = [...gapLegendSection().matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1])
    expect(rows.sort()).toEqual([...GAP_REASONS].sort())
  })

  it.each(DRIFT_KINDS)('drift kind「%s」在 README 图例里有释义', (kind) => {
    expect(driftLegendSection()).toContain(`\`${kind}\``)
  })

  it('drift 图例段里没有源码不存在的 kind', () => {
    const mentioned = [...driftLegendSection().matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1])
    // 段内的反引号值只应是 kind 名（该段是纯枚举释义，没有其它代码标识符）
    for (const k of mentioned) expect(DRIFT_KINDS as readonly string[], k).toContain(k)
  })

  it('skill 协议给出缺口的分支动作（Agent 的主入口，不能只有字段名）', () => {
    const p = read('src/skill/qiyu/protocols.md')
    expect(p, '协议必须点名字段').toContain('`gaps[].reason`')
    expect(p, '最需要等待动作的 reason 必须点名').toContain('rate_limit_local')
    expect(p, '「提示 ≠ 失败」的语义必须写明').toMatch(/成功窗上的提示/)
  })

  // 2026-11-01 审查：「提示类四值」此前在 run 图例里写「后四个 reason」——位置指代
  // 依赖 README 图例表的**排列顺序**，而顺序没有任何守卫（上面的双向核对用 sort()，
  // 重排表格照样绿）；Agent 读 run 输出时手里也未必有那张表，「后四个」无法解析。
  // 现在逐名渲染，这条钉住「四个名字都在」且「位置指代不复活」。
  it('run 图例的 gaps 单元格逐名点名每个业务提示 reason（不用位置指代「后四个」）', async () => {
    const { runFieldNotes } = await import('../src/commands/sync-notes.js')
    const cell = runFieldNotes()['tasks[].gaps']!
    for (const r of TASK_GAP_REASONS) {
      expect(cell, `run 图例必须逐名点名 ${r}（Agent 手里没有 README 表）`).toContain(r)
    }
    expect(cell, '位置指代「后四个」依赖没有守卫的表格顺序，不得复活').not.toMatch(/后四个|前四个/)
    // 变异自检：合成一个位置指代形态，上面的正则必须命中（防正则退化恒绿）
    expect('gaps 非空不等于同步失败：后四个 reason 是成功窗上的业务提示').toMatch(/后四个|前四个/)
  })

  // 2026-11-02 审查：`dim.ts` 写入了 `staff_id_list_malformed`，而 `TASK_GAP_REASONS` 当时只声明
  // 四个 —— 运行时产出了枚举外的值，Agent 拿去查 README 图例查不到任何释义。
  // 为什么类型没抓住：`...(gapHint ? { gapHint } : {})` 里 `gapHint` 是局部推断的对象
  // （`reason: string`），扩展表达式让整个返回值的 contextual type 消失，tsc 不再校验该字面量
  // 与 `TaskGapReason` 的关系（实测：把该 reason 改成 `12345`，`npm run typecheck` 仍 0 error；
  // 同一文件里改成 `rows: 123` 立刻报错）。所以枚举完整性只能靠静态扫描源码字面量来钉。
  it('任务层源码里的每个 gapHint.reason 字面量都是**任务层**枚举值（不是引擎侧的）', () => {
    const dir = fileURLToPath(new URL('../src/sync/tasks/', import.meta.url))
    const hits: Array<{ file: string; reason: string }> = []
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue
      const src = readFileSync(`${dir}${f}`, 'utf8')
      // 单引号与双引号都要收（CodeRabbit 2026-11-02）：只认单引号时，任务层写
      // `reason: "unknown"` 会被整条漏掉，而既有命中仍能满足下面的下限断言 → 判据静默失效。
      // 字符集必须含数字（CodeRabbit 2026-11-02 第二轮）：写成 `[a-z_]+` 时
      // `reason: 'v2_bad_reason'` 整条不匹配，而其余文件**照样满足** `>= 4` 的下限 ——
      // 判据静默放行。枚举值里出现数字完全正常（`export_window_mismatch` 的同族命名），
      // 判据不该靠「值里没有数字」这条未声明的隐含假设成立。
      for (const m of src.matchAll(/reason:\s*(['"])([a-z0-9_]+)\1/g)) hits.push({ file: f, reason: m[2] })
    }
    // ⚠️ 下限不能靠「别处命中凑数」（Sourcery PR#57 复核）：此前只断言 `hits >= 4`，
    // 某个文件整段漏扫时，其余文件的二十多处命中照样满足它 —— 扫描判据静默放行。
    // 改成**逐文件**断言：扫到 reason 字面量的文件必须出现在预期集合里，且每个文件至少一处。
    const filesWithHits = new Set(hits.map((h) => h.file))
    // 预期集合写死：任务层**目前**产出 gapHint 的文件（新增文件产生 tip 时必须在这里登记）
    expect([...filesWithHits].sort(), '有任务文件整段漏扫（该文件一处 reason 都没被收进来）')
      .toEqual(['dim.ts', 'knowledge.ts', 'reports.ts', 'sessions.ts', 'tickets.ts'])
    expect(hits.length, '没扫到任何 reason 字面量 —— 扫描判据退化了').toBeGreaterThanOrEqual(4)
    // ⚠️ 形态白名单：`gapHint` 里出现的 `reason:` 只允许单/双引号字面量。模板串
    // （`` reason: \`x\` ``）与计算值（`reason: SOME_CONST`）不匹配上面的扫描正则，
    // 等于绕过枚举核对 —— 这里显式拒绝它们（宁可要求写成字面量）。
    const NON_LITERAL = /reason:\s*([^'"\s,})]+)/g
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts')) continue
      const src = readFileSync(`${dir}${f}`, 'utf8')
      for (const m of src.matchAll(NON_LITERAL)) {
        expect(false, `${f} 的 gapHint.reason 用了非字面量形态「${m[1]}」：`
          + '扫描判据只会核对引号字面量，模板串/常量会绕过枚举').toBe(true)
      }
    }
    // 双向自检：模板串与计算值两种形态必须被上面那条正则识别（防它退化成恒不命中）
    expect([...'reason: `zzz_tpl`'.matchAll(NON_LITERAL)].map((m) => m[1])).toEqual(['`zzz_tpl`'])
    expect([...'reason: SOME_CONST'.matchAll(NON_LITERAL)].map((m) => m[1])).toEqual(['SOME_CONST'])
    // 合法形态（单/双引号）不得被误伤
    expect([...'reason: \'ok_name\''.matchAll(NON_LITERAL)]).toEqual([])
    expect([...'reason: "ok_name"'.matchAll(NON_LITERAL)]).toEqual([])
    // 判据收的是 `TASK_GAP_REASONS` 而不是 `GAP_REASONS`（CodeRabbit 2026-11-02）：
    // 任务层写 `reason: 'fetch_failed'` 能让**成功窗**的提示长出引擎失败语义 ——
    // 它属于 `ENGINE_GAP_REASONS`，用并集核对会放行（实测：改成 fetch_failed 后本测试仍全绿）。
    const taskKnown = new Set<string>(TASK_GAP_REASONS)
    const engineKnown = new Set<string>(ENGINE_GAP_REASONS)
    for (const h of hits) {
      expect(engineKnown.has(h.reason), `${h.file} 的 gapHint 用了引擎侧 reason「${h.reason}」：`
        + '成功窗提示与失败缺口必须可分派，任务层只能用 TASK_GAP_REASONS').toBe(false)
      expect(taskKnown.has(h.reason), `${h.file} 产出了 TASK_GAP_REASONS 之外的值「${h.reason}」：`
        + '先加进 TASK_GAP_REASONS 并补 README 图例与 skill 文案').toBe(true)
    }
    // 变异自检：两种「该判据必须拒掉」的形态都要真的被拒（防退化恒绿）
    expect(taskKnown.has('zzz_not_a_reason')).toBe(false)
    expect(engineKnown.has('fetch_failed')).toBe(true)
    // 双引号扫描自检：合成的双引号形态必须被上面那条正则捕获
    const probe = [...`reason: "zzz_dq"`.matchAll(/reason:\s*(['"])([a-z0-9_]+)\1/g)]
    expect(probe.map((m) => m[2])).toEqual(['zzz_dq'])
    // 数字后缀扫描自检（CodeRabbit 2026-11-02 第二轮）：`[a-z_]+` 会整条漏掉带数字的值，
    // 而别处的命中照样满足下限 —— 扫描判据必须自己证明这一形态被收进来。
    const probeDigit = [...`reason: 'v2_bad_reason'`.matchAll(/reason:\s*(['"])([a-z0-9_]+)\1/g)]
    expect(probeDigit.map((m) => m[2]), '带数字的枚举值必须被扫到，否则判据靠隐含假设成立')
      .toEqual(['v2_bad_reason'])
  })

  // 2026-11-02 审查（Sourcery + 独立 agent）：「成功窗上的提示」这一句把两种相反的实况
  // 合并成了一档 —— `knowledge_row_malformed` 的行**真的没落库**，而
  // `filter_matched_no_staff` 只是筛选没命中（可能一行都不该有）。前者必须核对上游形态、
  // 后者不必，Agent 按同一句话处理会低估前者。修法是把「确实没落库」的那一档单独声明，
  // 三处文案（README 图例段 / skill 协议 / sync-notes）都从这一个常量说话。
  it('「确实没落库」的那一档是真划分，且三处文案与常量一致（不得各写一套）', () => {
    const all = new Set<string>(TASK_GAP_REASONS)
    const lossy = new Set<string>(TASK_GAP_LOSSY_REASONS)
    // 判据不能在空集/全集上恒真：非空、是真子集（否则「两档」退化成一句空话）
    expect(lossy.size, 'lossy 档不能为空').toBeGreaterThan(0)
    expect(lossy.size, 'lossy 档必须是真子集（否则「两档」= 一句话）').toBeLessThan(all.size)
    for (const r of lossy) expect(all.has(r), `${r} 不在 TASK_GAP_REASONS 里`).toBe(true)
    // 反向：`filter_matched_no_staff` 恰恰是**不该**进 lossy 档的那个（上游本就没命中）
    expect(lossy.has('filter_matched_no_staff'), '筛选未命中不是「数据丢了」，不该进 lossy 档').toBe(false)

    // README：lossy 档逐名点出「确实没落库」，另一档点出「未必缺数据」
    const legend = gapLegendSection()
    expect(legend, 'README 必须点明这一档「确实没落库」').toMatch(/确实没落库|真的没进库/)
    expect(legend, 'README 必须点明另一档「未必缺数据」').toMatch(/未必缺数据/)
    // skill 协议（Agent 主入口）：两档都必须落地，否则 Agent 只拿到「提示」这个粗档
    const p = read('src/skill/qiyu/protocols.md')
    expect(p, '协议必须保留「成功窗上的提示」这一层').toMatch(/成功窗上的提示/)
    expect(p, '协议必须分开写「确实没落库」那一档').toMatch(/确实没落库/)
    expect(p, '协议必须分开写「未必缺数据」那一档').toMatch(/未必缺数据/)
    // sync-notes 的 run 图例：同一口径（Agent 手里最常有的就是这行）
    expect(read('src/commands/sync-notes.ts'), 'run 图例不能只说「提示」而不说数据是否缺')
      .toMatch(/确实没落库/)
    // 变异自检：上面这些正则要真的能命中「写错的那一版」——把两档合并成一句的旧文案
    expect('这些是成功窗上的业务提示（数据未必缺，按 detail 判断）').not.toMatch(/确实没落库/)
  })

  it('skill 协议不得把 sync verify 说成两类任务都与远端核对（CodeRabbit 2026-10-27）', () => {
    // windowed 任务不做上游全量重拉，verify 只看本地行数与 sync_state —— 协议若笼统写
    // 「核对本地与远端的一致性」，Agent 会用「drift 为空」错误排除「本地数据未反映远端
    // 变化」这一 0 行成因。与 README「expected_from_api 只对快照任务有意义」同一事实。
    const p = read('src/skill/qiyu/protocols.md')
    expect(p).toContain('只有快照任务')
    expect(p).toMatch(/drift 为空不代表与远端一致/)
  })
})
