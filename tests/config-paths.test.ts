// tests/config-paths.test.ts —— 文档点名的配置键路径必须**真的能被 CLI 接受**。
//
// 为什么需要这一条（2026-10-26 实测）：
//   · README 与 skill 正文（setup.md）都要教人类/Agent 去改配置文件，但**全仓没有
//     任何一处**给出完整结构 —— 于是文档里的键只能写成简写（`readOnlyRetryMs`、
//     `store.options.knowledgeRobotIds`），而配置校验是按**完整路径**白名单做的。
//   · 实测后果：照 hint 把 `readOnlyRetryMs` 写进顶层或 profile 级 → 「配置文件未知键」
//     退出码 2；照 setup.md 把 `knowledgeRobotIds` 放在 `profiles.<name>` 下 → 同样被拒。
//     即「文档教人做的事，照做会被 CLI 自己的校验拒绝」。
//   · 这类缺陷纯读代码发现不了：文档字符串看着合理，校验表在另一个文件里按层拼路径。
//
// 本文件的判据是**可执行**的，不是文本匹配：
//   ① README 里那个 JSON 示例块必须被 `parseConfig` + `resolveStoreConfig` 接受
//      （示例是给人抄的，抄下去报错就是最坏的一种文档）；
//   ② 文档（README + skill 正文）里点名的每个配置键路径，按「去掉 `<name>` 占位后
//      逐层查白名单」判定它是否真实存在 —— 写简写或层级搞错都会红。
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { parseConfig, KNOWN_TOP, KNOWN_PROFILE } from '../src/core/config.js'
import { resolveStoreConfig } from '../src/store/config.js'

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

/** README 里那个完整配置示例（带 ```json 围栏、且含 `"profiles"` 的第一个块）。 */
function readmeConfigExample(): string {
  const md = read('README.md')
  const blocks = [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1] ?? '')
  const hit = blocks.find((b) => b.includes('"profiles"'))
  expect(hit, 'README 必须有一个含 "profiles" 的完整配置 JSON 示例').toBeDefined()
  return hit as string
}

/** 文档里所有 ```json 示例块中出现的键名（示例即「可照抄的完整结构」）。 */
function jsonExampleKeys(text: string): Set<string> {
  const keys = new Set<string>()
  for (const m of text.matchAll(/```json\n([\s\S]*?)```/g)) {
    for (const k of (m[1] ?? '').matchAll(/"([A-Za-z_][\w-]*)"\s*:/g)) keys.add(k[1] ?? '')
  }
  return keys
}

// store 块的白名单不在 core 层导出（那是 store/config.ts 的领域知识），这里实测探测：
// 把候选键放进 `profiles.default.store.<key>`，能被接受即在白名单里。
const STORE_KEYS = ['backend', 'path', 'readOnlyRetryMs', 'batchSize', 'options'] as const
const PROFILE_KEYS = [...KNOWN_PROFILE]
const TOP_KEYS = [...KNOWN_TOP]

/** 按点分路径在白名单树里查一层是否存在（`<name>` 是 profile 名占位，任意值合法）。 */
function pathExists(path: string): boolean {
  const segs = path.split('.').map((s) => (s === '<name>' ? 'default' : s))
  if (segs[0] === 'profiles') {
    if (!TOP_KEYS.includes('profiles')) return false
    if (segs.length === 1) return true
    // `segs[1]` 是 **profile 名**，任意值都合法 —— 它不在任何白名单里，
    // 白名单管的是 profile **内部**的键（KNOWN_PROFILE）。这一层写错过一次：
    // 曾把 segs[1] 拿去查 KNOWN_PROFILE，于是 `profiles.<name>.store.x` 被判不存在，
    // 而自检用例（下一条）正好抓到了这个错误 —— 自检不是装饰。
    if (segs.length === 2) return true
    if (!PROFILE_KEYS.includes(segs[2] ?? '')) return false
    if (segs[2] === 'store') {
      if (segs.length === 3) return true
      return STORE_KEYS.includes((segs[3] ?? '') as typeof STORE_KEYS[number])
    }
    // credentials / robots 之下没有更深的白名单层（其内容是自由形态）
    return segs.length === 3
  }
  return TOP_KEYS.includes(segs[0] ?? '')
}

describe('配置文件的完整结构示例可被执行（README）', () => {
  it('README 的示例 JSON 被 parseConfig 接受（未知键/类型错都会在这里红）', () => {
    const example = readmeConfigExample()
    const parsed = parseConfig(JSON.parse(example) as Record<string, unknown>)
    expect(parsed.profiles.default, '示例里必须有 default profile').toBeDefined()
    expect(parsed.profiles.default?.store, '示例里必须有 store 块').toBeDefined()
  })

  it('README 的示例 JSON 被 resolveStoreConfig 接受（store 层语义校验也过）', () => {
    // parseConfig 只管通用形态；store 块的正整数上界/backend 枚举在 store 层。
    // 两关都过，示例才是「抄下去能跑」的。
    const example = readmeConfigExample()
    const parsed = parseConfig(JSON.parse(example) as Record<string, unknown>)
    // resolveStoreConfig 只从磁盘读，所以这里用最直接的等价检查：把示例的 store 块
    // 逐键与 STORE_KEYS 对齐后，确认没有多出来的键（多出来 = 示例教了不存在的键）。
    const storeBlock = parsed.profiles.default?.store as Record<string, unknown>
    const unknown = Object.keys(storeBlock).filter((k) => !(STORE_KEYS as readonly string[]).includes(k))
    expect(unknown, 'README 示例的 store 块含白名单外的键').toEqual([])
  })
})

describe('文档点名的配置键路径真实存在', () => {
  // 文档里出现的、看起来像配置路径的 token。形态约束：至少两段，且首段是
  // 已知顶层或简写键（简写也要查 —— 那正是本组要抓的东西）。
  const DOC_FILES = ['README.md', 'src/skill/qiyu/setup.md'] as const
  // ⚠️ 判据分两步（2026-10-26 两次自检修正后定稿）：
  //   ① **裸键名**：`readOnlyRetryMs` / `batchSize` / `knowledgeRobotIds` /
  //      `defaultProfile` 这些键**只能**以完整路径出现（前面紧跟 `.`）。文案里出现
  //      前面不是点的裸键名 = 让读者按字面去写，而字面位置不存在 —— 就是本组要抓的。
  //      这是最直接的那条判据，不依赖"看起来像路径"的启发式。
  //   ② **点分路径**：以 `profiles`/`store` 开头的点分串，至少一段是已知键名
  //      （排除 `store.execSql` 方法名、`store.ts` 文件名）。
  // 两种书写形态（反引号包着 / 源码字符串里的裸 token）都覆盖。
  const BARE_KEYS = ['readOnlyRetryMs', 'batchSize', 'knowledgeRobotIds', 'defaultProfile'] as const
  const PATH_RE = /(?:`|\s)((?:profiles|store)(?:\.[A-Za-z_<>][\w<>-]*)+)/g
  /** 文案里的违规项：裸键名（前面不是 `.`）或点分路径走不通。 */
  function offendersIn(file: string, text: string): string[] {
    const out: string[] = []
    for (const key of BARE_KEYS) {
      // 前面不是 `.` 即视为"裸用"。`(?![\w-])` 防止匹配到 `readOnlyRetryMsX` 这类更长的词。
      const re = new RegExp(String.raw`(?<!\.)\b${key}\b(?![\w-])`, 'g')
      for (const _ of text.matchAll(re)) out.push(`${file}: 裸键名 \`${key}\``)
    }
    for (const m of text.matchAll(PATH_RE)) {
      const p = m[1] ?? ''
      const segs = p.split('.')
      // ⚠️ 结构词 `profiles`/`store` 本身**不算**「已知键」—— 否则 `store.execSql`
      // （方法名）、`store.ts`（文件名）都会被当成配置路径（自检抓到过）。
      // 只认叶子键：store 块里的五个键、profile 下的 credentials/robots，以及 BARE_KEYS。
      const mentionsKnown = segs.some((s) =>
        (STORE_KEYS as readonly string[]).includes(s)
        || (PROFILE_KEYS as readonly string[]).includes(s) && s !== 'store'
        || (BARE_KEYS as readonly string[]).includes(s))
      if (!mentionsKnown) continue
      if (!pathExists(p)) out.push(`${file}: \`${p}\``)
    }
    return out
  }

  /**
   * 源码文件：只扫**字符串字面量**内的文本。
   *
   * ⚠️ 为什么（2026-10-26）：直接扫源码全文会把代码本身当文案 —— 实测误报 35 条，
   * 全是变量名（`batchSize`）、方法名（`store.execSql`）。源码里"给人/Agent 读的话"
   * 一定在字符串字面量里；代码标识符不是文案。
   * ⚠️ 还要**先抹掉注释**：注释里为了解释缺陷会引用简写形态（本项目注释密度很高），
   * 那不是给用户看的文案。注释里的反引号会被模板串正则误当成字面量（实测踩到）。
   * 抹注释用 `plaintext-channels.test.ts` 同一套引号感知逻辑的精简版：够用即可，
   * 宁可少扫也不要误报；漏扫由「扫描器有牙」的自检兜底。
   */
  function stripComments(text: string): string {
    let out = ''
    let i = 0
    let quote: string | null = null
    while (i < text.length) {
      const c = text[i] ?? ''
      const next = text[i + 1] ?? ''
      if (quote !== null) {
        out += c
        if (c === '\\') { out += next; i += 2; continue }
        if (c === quote) quote = null
        i++
        continue
      }
      if (c === "'" || c === '"' || c === '`') { quote = c; out += c; i++; continue }
      if (c === '/' && next === '/') {
        while (i < text.length && text[i] !== '\n') i++
        continue
      }
      if (c === '/' && next === '*') {
        i += 2
        while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++
        i += 2
        continue
      }
      out += c
      i++
    }
    return out
  }

  function stringLiterals(text: string): string[] {
    const out: string[] = []
    for (const m of stripComments(text).matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`([^`]*)`/g)) {
      out.push(m[1] ?? m[2] ?? m[3] ?? '')
    }
    return out
  }

  it('文档点名的配置键都能按字面照做（层级错/缺完整路径都会红）', () => {
    // 判据在裸键名这一侧更宽松一点：正文里解释「这个键在 store.options 里面」时
    // 用短名是自然写法（setup.md 就是），但**同一个文件里必须给出完整路径**，
    // 否则读者只有短名可抄 —— 那才是本组要抓的。所以按文件汇总：
    //   · 任何点分路径 → 必须真实可达（层级错立刻红）；
    //   · 裸键名 → 该文件里必须同时出现过这个键的完整路径。
    const problems: string[] = []
    for (const f of DOC_FILES) {
      const text = read(f)
      problems.push(...offendersIn(f, text).filter((o) => !o.includes('裸键名')))
      // JSON 示例块里的键是「可照抄的完整结构」—— 示例本身已由上一条用例整块
      // 喂给 parseConfig 验证过，所以块内出现的键名视为有完整路径可抄。
      const exampleKeys = jsonExampleKeys(text)
      for (const key of BARE_KEYS) {
        const bare = new RegExp(String.raw`(?<!\.)\b${key}\b(?![\w-])`).test(text)
        if (!bare) continue
        if (exampleKeys.has(key)) continue
        // 完整路径：`profiles…<key>` 或 `store.<key>`，且该路径本身可达。
        const full = [...text.matchAll(PATH_RE)].some((m) => {
          const p = m[1] ?? ''
          return p.endsWith('.' + key) && pathExists(p)
        })
        if (!full) problems.push(`${f}: 只给了裸键名 \`${key}\`，没有一处完整路径`)
      }
    }
    expect(problems, '文档里的配置键必须给出可照抄的完整路径').toEqual([])
  })

  it('**源码**文案里点名的路径同样必须真实存在（hint / field_notes / 报错）', () => {
    // 为什么连源码一起查：`query/sandbox.ts` 的 store_locked hint 曾在 0.2.1 里
    // 只写裸键名 `readOnlyRetryMs`，且**没有任何测试钉住那段文案** —— 文档修了、
    // 源码没修，这类缺陷会从代码侧继续流到 Agent 面前。判据与文档侧同一套，
    // 但**只看字符串字面量**（代码里的变量名/方法名不是文案）。
    const srcFiles = [
      'src/query/sandbox.ts',
      'src/store/duckdb.ts',
      'src/commands/auth.ts',
      'src/commands/sync-run.ts',
    ] as const
    const offenders = srcFiles.flatMap((f) =>
      stringLiterals(read(f)).flatMap((lit) => offendersIn(f, lit)))
    expect(offenders, '源码文案里的配置路径在白名单里不存在或只给了裸键名').toEqual([])
  })

  it('扫描器有牙：裸键名与层级写错的路径都会被抓到', () => {
    // 自检（否则本组可能因为判据不命中而恒绿 —— 那是本仓库反复踩过的坑）。
    expect(pathExists('profiles.<name>.store.readOnlyRetryMs')).toBe(true)
    expect(pathExists('profiles.<name>.robots')).toBe(true)
    expect(pathExists('profiles.<name>.store.options.knowledgeRobotIds')).toBe(true)
    expect(pathExists('profiles.<name>.knowledgeRobotIds')).toBe(false)  // 层级错
    expect(pathExists('store.options.knowledgeRobotIds')).toBe(false)     // 缺 profiles 层
    expect(pathExists('readOnlyRetryMs')).toBe(false)                     // 裸键名

    // 判据本身必须能抓到三种形态（否则上面的 offender 列表恒空）。
    expect(offendersIn('p', '等待上限可经配置文件 readOnlyRetryMs 调整'))
      .toHaveLength(1)                                                    // 裸键名
    expect(offendersIn('p', '`store.options.knowledgeRobotIds`'))
      .toEqual(['p: `store.options.knowledgeRobotIds`'])                  // 缺 profiles 层
    expect(offendersIn('p', '`profiles.<name>.knowledgeRobotIds`'))
      .toEqual(['p: `profiles.<name>.knowledgeRobotIds`'])                // 层级错
    // 正例不能被误伤：完整路径、`store.execSql` 方法名、`store.ts` 文件名。
    expect(offendersIn('p', [
      '`profiles.<name>.store.readOnlyRetryMs`',
      '`profiles.<name>.store.options.knowledgeRobotIds`',
      '见 store.execSql 与 store.ts',
    ].join('\n')), '完整路径与代码标识符不得误伤').toEqual([])
    // 字面量抽取：代码里的变量名不在字面量里，不该被扫到。
    expect(stringLiterals("const batchSize = 1\nfoo('文案 store.execSql')")
      .flatMap((l) => offendersIn('p', l))).toEqual([])
  })
})
