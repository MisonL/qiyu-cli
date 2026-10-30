import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

/**
 * README 的「尚未实现」清单段；**段不存在时返回 null，而不是空串**。
 *
 * ⚠️ 2026-10-30 修假护栏：六个子项目全部交付后 README 已删掉该段，而旧断言写作
 * `const notYet = /…/.exec(md)?.[0] ?? ''` 再 `expect(notYet).not.toMatch(…)` ——
 * 段缺失时 `notYet` 是空串，`.not.toMatch` 恒真。它声称守「已交付命令不得出现在
 * 未实现清单里」，实际什么都没守。返回 null 让「段不存在」与「段存在但为空」可区分，
 * 调用方据此二选一断言（不存在 = 全部交付；存在 = 其中不得含已交付命令）。
 */
function readmeNotYetSection(md: string): string | null {
  return /\*\*尚未实现\*\*[\s\S]*?(?=\n## |$)/.exec(md)?.[0] ?? null
}

/**
 * CHANGELOG 的**版本区**（所有 `## [x]` 段，到文件末尾的链接引用块为止）。
 *
 * ⚠️ 为什么从「当前版本段」放宽到「全部版本段」（2026-10-26）：下面这些断言守的是
 * 「C1/D/E/修复批 的交付条目**在 CHANGELOG 里写着**」——防止发版整理时把条目悄悄删掉。
 * 此前它们钉的是「`[未发布]` ∪ 当前版本号段」，在 `[未发布]` 一直累积时成立；一旦
 * 正常发版（0.2.1 切段），0.2.0 的条目就落到"当前段"之外，6 条测试集体变红 ——
 * 而它们真正要防的「条目被删掉」并没有发生。钉死"当前段"等于每次发版都要改 6 条测试，
 * 这种维护成本会让人下次直接放宽断言（那才是真正的失守）。
 * 现在按**版本区**找：条目被删 → 仍然红；条目被移进历史版本段 → 绿（那是发版的正常形态）。
 */
/**
 * 当前版本的 CHANGELOG 段：`[未发布]` 段与 `package.json` 版本号段的**并集**。
 *
 * ⚠️ 此前这些断言逐字写 `/## \[未发布\].../`，7 条都钉着那个标题字面量 ——
 * 发版时把 `[未发布]` 改名为 `[0.2.0] - <日期>` 就会让它们全红，而它们真正要守的
 * 是「**当前版本**的更新日志里写了 X」，标题叫什么不是契约的一部分。
 *
 * ⚠️ 为什么是**并集**而不是二选一（Sourcery 2026-10-25 发现）：
 *   · 开发期：`package.json` 还是上一个已发布版本，新条目写在 `[未发布]` 里 ——
 *     只看版本号段会漏掉它们；
 *   · 发版后：`[未发布]` 要么没了（本次），要么是下一轮的空草稿 —— 只看 `[未发布]`
 *     会去查一个空段，哪怕已发布段里条目齐全，断言照样红。
 *   两段并起来，两种相位都对；而「条目被挪进**历史**版本段（0.1.0 之类）」这个
 *   真正要防的形态仍然会红 —— 那正是这些断言的用意。
 */
function currentChangelogSection(md: string): string {
  const version = JSON.parse(read('package.json')).version as string
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const section = (heading: string): string =>
    new RegExp(`## \\[${heading}\\][\\s\\S]*?(?=\\n## |$)`).exec(md)?.[0] ?? ''
  return [section('未发布'), section(escaped)].filter((x) => x !== '').join('\n')
}

/**
 * 全部版本段（`## [` 开头到文件末尾的 `[x]: https://…` 链接引用块之前）。
 * 用途见上方 `currentChangelogSection` 文档里的 2026-10-26 说明。
 */
function allVersionSections(md: string): string {
  const start = md.search(/^## \[/m)
  if (start === -1) return ''
  // 链接引用块的第一行形如 `[未发布]: https://…` / `[0.2.0]: https://…`
  const linkBlock = md.search(/^\[[^\]]+\]:\s+https?:/m)
  return md.slice(start, linkBlock === -1 ? undefined : linkBlock)
}

/**
 * 发版一致性：CHANGELOG 底部的版本比较链接必须与标题**成对**出现。
 *
 * ⚠️ 为什么单独一条（CodeRabbit 2026-10-25）：`[0.2.0]: …compare/v0.1.0...v0.2.0`
 * 这类链接引用是发版时**手写**的，漏掉 `## [0.2.0]` 标题不会有任何东西报错 ——
 * 渲染出来只是「版本号没有链接」，而上面那些「段里写了 X」的断言都靠
 * `currentChangelogSection` 按标题找段，标题缺了它们只会集体变红、指不出原因。
 * 本条的判据是「链接存在 ⇒ 标题必须存在」：只要求**当前版本**这一对，
 * 历史版本缺链接不归它管（那是历史，不该因为今天的规则被动改写）。
 */
describe('发版一致性 —— 版本链接与标题成对', () => {
  it('`[<package.json 版本>]:` 链接存在时，必须有对应的 `## [<版本>]` 标题', () => {
    const md = read('CHANGELOG.md')
    const version = (JSON.parse(read('package.json')) as { version: string }).version
    const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const hasLink = new RegExp(`^\\[${escaped}\\]:`, 'm').test(md)
    // 没有链接就跳过（例如版本号刚 bump、还没补链接的中间态）—— 本条的承诺是
    // 「有链接就必有标题」，不是「必须有链接」（后者会把「还没发版」判红）。
    if (!hasLink) return
    expect(md, `CHANGELOG 底部有 [${version}] 链接，但正文没有 \`## [${version}]\` 标题`)
      .toMatch(new RegExp(`^## \\[${escaped}\\]`, 'm'))
  })
})

describe('联动文案 —— C1 交付后不得说假话', () => {
  it('三个帮助入口的 code 清单都含两个新 code（锚定清单行本身，L 组 H2：auth.ts:155-156 既有注释已含这两个词，裸词断言会假绿）', () => {
    for (const f of ['src/cli.ts', 'src/commands/auth.ts', 'src/commands/api.ts']) {
      const s = read(f)
      // 清单行的形态是 `… / confirm_required / local_rate_limit / unknown`；
      // 新 code 插在 confirm_required 后 —— 锚定「confirm_required / store_locked」
      // 相邻，注释里的孤立词命中不了这个形态。
      expect(s, f).toMatch(/confirm_required \/ store_locked \/ store_not_initialized/)
    }
  })
  it('README 含两个新 code 与 store 命令', () => {
    const md = read('README.md')
    expect(md).toMatch(/store_locked/)
    expect(md).toMatch(/store init/)
    expect(md).toMatch(/store status/)
  })
  it('README 零运行时依赖表述已分述', () => {
    expect(read('README.md')).toMatch(/核心命令.*零运行时依赖|零运行时依赖.*核心命令/s)
  })
  it('CHANGELOG 版本区含 store 条目（收紧锚，O 组 O-13）', () => {
    const md = read('CHANGELOG.md')
    const unreleased = allVersionSections(md)
    expect(unreleased.length).toBeGreaterThan(0)   // 版本区必须存在
    expect(unreleased).toMatch(/`store (init|status)`/)   // 反引号命令形态，防「存储」等误命中
  })
  it('路线图 §四.C 标注 C1 已交付、C2 未关闭', () => {
    const s = read('docs/superpowers/specs/2026-10-09-后续交付路线图-design.md')
    expect(s).toMatch(/C1.*已交付|已交付.*C1/)
    expect(s).toMatch(/C2/)
  })
  it('设计稿 §9.5 含 C1 阶段标注', () => {
    const s = read('docs/qiyu-cli-design.md')
    expect(s).toMatch(/C1 阶段|C1 交付/)
  })
  it('路线图 §五.2 的 describe 归属已更新（I 组 M7：§8.3 第 13 处锚）', () => {
    const s = read('docs/superpowers/specs/2026-10-09-后续交付路线图-design.md')
    expect(s).toMatch(/store init\/status/)
  })
})

describe('readme.test.ts —— C1 追加断言（防文档说假话）', () => {
  it('README 目录树含 src/store/ 层', () => {
    expect(read('README.md')).toMatch(/src\/store\//)
  })
  it('README 已实现清单含 store init/status', () => {
    const md = read('README.md')
    expect(md).toMatch(/store init/)
    expect(md).toMatch(/store status/)
  })
  it('README 配置说明：登录写入 + 手工编辑仍支持 + 权限分级（G1 翻转旧断言）', () => {
    const md = read('README.md')
    expect(md).toMatch(/手工编辑/)
    // ⚠️ G1 起 `auth login` **已实现**，旧断言 `不支持.*写入` 已翻转：
    // 现在承诺的是"可以写"，而且必须讲清它只从环境变量读（argv 会泄漏）。
    expect(md).toMatch(/auth login/)
    expect(md).toMatch(/环境变量.*--app-key|不接受.*--app-key/)
    // 权限规则分两级（G1）：含凭证 → 拒绝；无凭证 → 警告不阻断。
    // ⚠️ 旧的单句 `/权限过宽.*警告/` 已不足以描述现状 —— 只断言警告会让
    // 「含凭证也照旧只警告」这个安全回退**照样通过**。
    expect(md, '含凭证过宽必须承诺拒绝').toMatch(/拒绝读取|config_insecure/)
    expect(md, '无凭证仍只警告').toMatch(/警告.*不阻断|不阻断.*警告/)
    // ⚠️ 「所有命令」是错的口径（2026-10-26 实测）：不读配置的命令（--version / api list /
    // skill where / sync tasks）根本不碰凭证，谈不上拒绝；而 `auth login` 是唯一例外
    // （重写为 0600 而非拒绝）。只写"所有命令"会让 Agent 以为 `qiyu api list` 也会失败。
    expect(md, '拒绝范围必须限定为「读取配置的命令」').toMatch(/读取配置的命令/)
    expect(md, 'auth login 的例外必须写明').toMatch(/auth login`? 是\*\*唯一的例外\*\*|auth login.*例外/)
    // WAL 说明（Q 组 Q-低-2）：.wal 临时文件正常退出后消失，勿手工删除
    expect(md).toMatch(/\.wal/)
  })
  it('README 告知 @duckdb/node-api 安装体积（Q 组 Q-中-3：实测 129 MB，含平台二进制）', () => {
    expect(read('README.md')).toMatch(/130 MB|129 MB|~130|原生.*二进制|二进制.*MB/)
  })
  it('README 含输出契约描述（O 组 O-12：六字段 + tables 形态 + status 轮询代价）', () => {
    const md = read('README.md')
    expect(md).toMatch(/schema_version/)
    expect(md).toMatch(/\[{.*name.*rows.*}\]|\[\{ ?name, ?rows ?\}\]|tables\[.*\].*行数|name.*rows/)
    expect(md).toMatch(/全表.*COUNT|COUNT.*全表|行数.*全表扫描|status.*轮询|轮询.*代价/)
  })
  it('README 横幅不谎称「仍在早期」，且不得把已交付命令列为未实现（I 组 M7：§8.3 第 5 处；2026-10-30 修假护栏）', () => {
    const md = read('README.md')
    expect(md).toMatch(/store init\/status 已可用|存储.*已交付/)
    // ① 真实事故（2026-10-30）：横幅曾写「本仓库仍在早期：仅实现认证+参数校验+存储基础」，
    //    与「当前状态」段的「前六个子项目已交付」自相矛盾，且谎称 sync/查询/库未交付。
    expect(md, '横幅不得声称仓库「仍在早期」').not.toMatch(/仍在早期/)
    // ② 双向自检：抽取器在事故形态上必须命中（→ ③ 会红），在无该段的合法形态上返回 null。
    //    确保守卫不是靠恒真的 `not.toMatch` 通过的（那正是本次要修的假护栏）。
    expect(readmeNotYetSection('**尚未实现**（调用时提示）：`store init`、`sync run`\n\n## 下一步')).toBeTruthy()
    expect(readmeNotYetSection('## 当前状态\n前六个子项目已交付。')).toBeNull()
    // ③ 当前真实状态：六个子项目全部交付 → README 不应再有任何「尚未实现」清单。
    //    将来若重新引入该段（新功能待做），必须同步改这条断言 —— 刻意如此。
    expect(readmeNotYetSection(md), '六个子项目已全部交付，README 不应再有「尚未实现」清单').toBeNull()
  })
  it('「子项目计数」随交付推进：F 交付后为「前六个」，且不再残留旧计数', () => {
    // 该锚最初（C1 组）钉的是「前两个子项目」不动裁决；E 交付后改成「前五个」，
    // F 交付后再改成「前六个」——同一审查结论：交付推进时这句话必须同步，
    // 否则它就成了被测试钉死的不实声明。
    const md = read('README.md')
    expect(md).toMatch(/前六个子项目/)
    expect(md).not.toMatch(/前五个子项目/)
  })
})

describe('锚定断言（钉住 spec §8.3 的具体落点，防只改一半）', () => {
  // L3 修：不再按行号切片（文档上方插行即假红），改为「按行内容找锚行、在锚行上断言」。
  const lineWith = (s: string, re: RegExp): string => s.split('\n').find((l) => re.test(l)) ?? ''
  it('路线图锚定：四个分点各自出现 C1 改文关键词（I 组 M7：§2.3 两处 / §六.2 / §八.2）', () => {
    const s = read('docs/superpowers/specs/2026-10-09-后续交付路线图-design.md')
    // §2.3：「store/ 只有命令级示例…已解决（C1）」行 —— init/status 同行出现
    const l23 = lineWith(s, /store\/` 只有命令级示例/)
    expect(l23).toMatch(/store init/)
    expect(l23).toMatch(/store status/)
    // §六.2：「C 原计划与 A 并行」行 —— C1 已交付标注 + DuckDB + store 命令
    const l62 = lineWith(s, /原计划与.*并行.*关键路径|C` 原计划与 A 并行/)
    expect(l62).toMatch(/C1 已交付/)
    expect(l62).toMatch(/DuckDB/)
    // §八.2：「Store 的完整接口签名与 DDL」行 —— store status 可查表清单
    expect(lineWith(s, /的完整接口签名与 DDL/)).toMatch(/store status/)
  })
  it('设计稿锚定：§11.2 错误处理表的缓存口径与全文两处 C1 阶段标注都在（L 组 H3；L3 修：按行内容锚定；2026-10-30 回写：D 交付后缓存生效）', () => {
    const s = read('docs/qiyu-cli-design.md')
    // §11.2 错误处理表的 store_locked 行 —— 2026-10-30 回写：
    // 原文承诺「D 交付后缓存查询生效」，而查询缓存**从未实现**（`meta.cached` 也无生产者）。
    // 现在断言该行**不得**再出现「缓存生效」类承诺，且必须如实写明缓存能力不存在。
    const lockedRow = lineWith(s, /\| `store_locked` \|/)
    expect(lockedRow, 'store_locked 行必须如实写明无查询缓存').toMatch(/无「查询缓存」能力|无查询缓存/)
    expect(lockedRow, '「D 交付后缓存查询生效」的旧承诺不得回归').not.toMatch(/缓存查询生效/)
    // §9.5 状态码一节：全文内两处 C1 阶段标注（纯结构断言，防止只改一半）。
    const marks = s.match(/C1 阶段|C1 交付|C1：已交付/g) ?? []
    expect(marks.length).toBeGreaterThanOrEqual(2)
  })
})

describe('D 同步引擎交付联动 —— 不得说假话（D-T15）', () => {
  it('cli.ts 顶层 USAGE 列全 sync 六个子命令（T14 遗留补全）', () => {
    const s = read('src/cli.ts')
    for (const sub of ['sync tasks', 'sync run', 'sync status', 'sync verify', 'sync install', 'sync uninstall']) {
      expect(s, `USAGE 缺 ${sub}`).toMatch(new RegExp(sub.replace(' ', '\\s+')))
    }
  })
  it('README 含 sync 子命令与同步引擎目录', () => {
    const md = read('README.md')
    expect(md).toMatch(/sync run/)
    expect(md).toMatch(/sync status/)
    expect(md).toMatch(/sync verify/)
    expect(md).toMatch(/src\/sync\//)
  })
  it('README 已交付的同步与查询命令未被列为未实现（2026-10-30 修假护栏）', () => {
    const md = read('README.md')
    expect(md).toMatch(/同步.*已交付|已交付.*同步/)
    expect(md).toMatch(/查询.*已交付|已交付.*查询/)
    // 旧断言把「尚未实现」段切出来再断言其中不含 sync run / qiyu query —— 但该段已被删除，
    // 切片恒为空串、断言恒真（假护栏）。现在按段存在与否二选一：
    //   · 段存在（将来回归）：其中不得出现这些已交付命令；
    //   · 段不存在（当前真实状态）：改由「当前状态」段逐条列出它们，证明它们确实被声明为已交付。
    const notYet = readmeNotYetSection(md)
    if (notYet !== null) {
      expect(notYet, '「尚未实现」段不得包含已交付命令').not.toMatch(/sync run|qiyu query|`db tables`|`stats fields`/)
    } else {
      const current = /## 当前状态[\s\S]*?(?=\n## )/.exec(md)?.[0] ?? ''
      expect(current, '「当前状态」段必须存在').not.toBe('')
      for (const cmd of ['sync run', 'db tables', 'query --table', 'stats fields']) {
        expect(current, `「当前状态」段必须列已交付命令：${cmd}`).toContain(cmd)
      }
    }
  })
  it('README 依赖分述：sync 零常规运行时依赖（fflate 只在 devDependencies，仅测试夹具用）', () => {
    const md = read('README.md')
    expect(md).toMatch(/零常规运行时依赖/)
    expect(md).toMatch(/DecompressionStream/)
    expect(md).toMatch(/devDependencies/)
    // 旧口径（「唯一引入常规依赖」）不得残留 —— 声明与实际依赖位置必须一致
    expect(md).not.toMatch(/唯一引入常规依赖/)
  })
  it('CHANGELOG 版本区含 sync 命令与 fflate 条目（反引号命令形态，防误命中）', () => {
    const md = read('CHANGELOG.md')
    const unreleased = allVersionSections(md)
    expect(unreleased).toMatch(/`sync (run|verify|install)`/)
    expect(unreleased).toMatch(/fflate/)
    expect(unreleased).toMatch(/开发依赖/)
    expect(unreleased).toMatch(/rate_limit_local/)
  })
  it('设计稿 §7.1 命令面：sync tasks 不再承诺「启用/停用」（E 中-3 裁定的设计稿落点）', () => {
    const s = read('docs/qiyu-cli-design.md')
    // 本阶段无启用/停用机制（spec §三 修订）——设计稿行的措辞与 spec 同义
    expect(s).not.toMatch(/ync tasks\s+# 列出可用任务、启用\/停用/)
    const dLine = s.split('\n').find((l) => /sync tasks/.test(l) && /#/.test(l)) ?? ''
    expect(dLine).toMatch(/列出可用任务（含每任务敏感列出口）/)
  })
  it('路线图 §四.D 标注已交付（D 节不得假勾）', () => {
    const s = read('docs/superpowers/specs/2026-10-09-后续交付路线图-design.md')
    expect(s).toMatch(/### D\. 同步引擎（`sync\/`）—— ✅ 已交付/)
  })
  it('路线图 §六.3：D 已交付 + §六.4：E 已交付', () => {
    const s = read('docs/superpowers/specs/2026-10-09-后续交付路线图-design.md')
    const l3 = s.split('\n').find((l) => /D 已交付（2026-10-15/.test(l)) ?? ''
    expect(l3).toMatch(/D 已交付/)
    // E 交付后该行由「已解锁」改写为「已交付」——断言跟着事实走，不锁旧措辞
    const l4 = s.split('\n').find((l) => /^\d+\.\s.*E 已交付（2026-10-17/.test(l)) ?? ''
    expect(l4).toMatch(/均已解锁/)
  })
  it('设计稿状态行含 D 交付标注', () => {
    expect(read('docs/qiyu-cli-design.md')).toMatch(/状态：实施中.*D 同步引擎.*已交付/)
  })
  it('分层规则已扩展：layering.test.ts 含 sync 不 import commands 规则', () => {
    const s = read('tests/store/layering.test.ts')
    expect(s).toMatch(/sync\/ 不得 import commands\//)
  })
})

describe('修复批 2 文档联动 —— 契约诚实性收口（锚内容不锚行号）', () => {
  it('D spec §七：enabled 已从输出契约移除并注明无启用机制', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    // 输出契约里不得再承诺 enabled 字段
    expect(s).not.toMatch(/`\{enabled, kind, table/)
    // 且必须写明「本阶段无启用机制」
    expect(s).toMatch(/本阶段无启用\/停用机制/)
  })

  it('D spec §七：ok 双轨语义与 notes/gaps/resolved_range/sensitive_columns 已写明', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    expect(s).toMatch(/`ok:true` 与退出码 1 的双轨语义/)
    expect(s).toMatch(/sensitive_columns/)
    expect(s).toMatch(/`notes`（修复批 2 新增）/)
  })

  it('D spec §九：store_not_initialized 的 hint 按成因分流（E 期 F1 收窄「一律」）', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    // 修复批 2 的主体仍在（空库指 store init），但「一律」已被架构审查 F1 推翻：
    // 他人库 / 非 DuckDB 文件 / 依赖未安装跑 store init 必然再次失败。
    expect(s).toMatch(/hint \*\*按成因分流\*\*/)
    expect(s).toMatch(/F1 推翻「一律」/)
  })

  it('D spec §八：迁移编号实况（v9 的 G2 两列）已记录', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    expect(s).toMatch(/v9（sync_state 补 resolved_range_start\/end 两列/)
  })

  it('设计稿 §9.5：hint 口径按成因分流（空库指 store init，他人库换 --db）', () => {
    const s = read('docs/qiyu-cli-design.md')
    const l = s.split('\n').find((x) => /`kind: "store_not_initialized"`/.test(x)) ?? ''
    expect(l).toMatch(/qiyu store init/)
    expect(l).toMatch(/同口径/)
    expect(l).toMatch(/F1 收窄/)
  })

  it('README 输出契约段：ok 双轨 + sync 输出（resolved_range/gaps/sensitive_columns）', () => {
    const md = read('README.md')
    expect(md).toMatch(/`ok` 与退出码的双轨语义/)
    expect(md).toMatch(/resolved_range/)
    expect(md).toMatch(/sensitive_columns/)
    // verify 的 expected_from_api 说明（E 中-6）：windowed 恒为 null + 核对方式
    expect(md).toMatch(/该字段恒为 `null`/)
    // 无启用/停用机制必须写明（防止 README 出现「启用任务」的过度承诺）
    expect(md).toMatch(/没有\*\*任务的\s*启用\/停用机制/)
    expect(md).not.toMatch(/启用\/停用任务/)
  })

  it('CHANGELOG 版本区含批 2 条目（v9 迁移 + sensitive_columns + resolved_range）', () => {
    const md = read('CHANGELOG.md')
    const unreleased = allVersionSections(md)
    expect(unreleased).toMatch(/迁移 v9/)
    expect(unreleased).toMatch(/sensitive_columns/)
    expect(unreleased).toMatch(/resolved_range/)
  })

  it('sync 命令帮助文案：install 前置与 verify 的 expected_from_api 说明已写进 usage', () => {
    const s = read('src/commands/sync.ts')
    expect(s).toMatch(/至少成功同步过一次/)
    expect(s).toMatch(/该字段恒为 null/)
  })
})

describe('修复批 4 文档联动 —— 按天切片与代价写在明处（锚内容不锚行号）', () => {
  it('D spec §5.2：聚合报表按天切片（窗口 1 天）与量级提醒已写明', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    // 按天切片的结论 + 依据（响应 date 无语义）
    expect(s).toMatch(/聚合报表按天切片（窗口 1 天）/)
    expect(s).toMatch(/it only indicates the start time of the current query/)
    // 表格里的窗口上限已改对：按天切片的行写 1、考勤保持 31 并注明 stat_date 推导
    expect(s).toMatch(/\*\*1\*\*（按天切片）/)
    expect(s).toMatch(/\| `staff_attendance` \| `statistic\.staffAttendance` \| 31 \|/)
    expect(s).toMatch(/`stat_date` 由本行 `hour_ts` 推导/)
    // --full 量级提醒 + 建议（只写代价，不改行为）
    expect(s).toMatch(/量级提醒/)
    expect(s).toMatch(/上万窗/)
    expect(s).toMatch(/`--since\/--until` 限定区间/)
    // 删除边界口径（半开窗口）与 resolved_range 末端语义
    expect(s).toMatch(/`dayOf\(end − 1ms\)`/)
    expect(s).toMatch(/`resolved_range` 的末端仍是\*\*水位\*\*/)
    // 旧口径不得残留（窗口上限 31 的旧表行、transfer_human 的 365 精确比较）
    expect(s).not.toMatch(/365d 是精确比较/)
    expect(s).not.toMatch(/\| `daily_overview` \| `statistic\.overview` \| 31 \|/)
  })

  it('README：同步输出契约段写明按天切片与 --full 量级建议', () => {
    const md = read('README.md')
    expect(md).toMatch(/聚合报表按天切片（窗口 1 天）/)
    expect(md).toMatch(/窗口数 = 天数/)
    expect(md).toMatch(/上万窗/)
    expect(md).toMatch(/`--since\/--until` 限定区间|--since 30d/)
  })

  it('CHANGELOG 版本区含批 4 的修复条目（按天切片 / 删除上界 / 超时 / 中央目录）', () => {
    const md = read('CHANGELOG.md')
    const unreleased = allVersionSections(md)
    expect(unreleased).toMatch(/### 修复/)
    expect(unreleased).toMatch(/聚合报表按天切片/)
    expect(unreleased).toMatch(/删除上界越界一天/)
    expect(unreleased).toMatch(/下载加 120 秒超时/)
    expect(unreleased).toMatch(/中央目录/)
    expect(unreleased).toMatch(/knowledgeRobotIds/)
  })
})

describe('修复批 5 文档联动 —— spec §5.4 补 gap reason（锚内容不锚行号）', () => {
  it('D spec §5.4：快照丢行与导出窗口核对的三条 reason 已点名（可分派体系写全）', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    // 知识库快照丢行的 reason（detail 含行数与任务 id；全删重插下必须可查）
    expect(s).toMatch(/knowledge_row_malformed/)
    // 会话导出两会话端窗口核对的既有 reason（此前只散在代码/CHANGELOG）
    expect(s).toMatch(/export_fixture_unreported/)
    expect(s).toMatch(/export_window_mismatch/)
  })

  it('D spec §5.2 + README：窗口按上海日界对齐（windowAlign）写在明处', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    expect(s).toMatch(/windowAlign: 'shanghaiDay'/)
    expect(s).toMatch(/上海日界对齐/)
    const md = read('README.md')
    expect(md).toMatch(/windowAlign: 'shanghaiDay'/)
    expect(md).toMatch(/上海日界对齐/)
  })

  it('批 5 复审 N1-b/N1-c：三处「对齐后每窗恰是整日 / --full 不放大」的不实措辞不得回归', () => {
    // 复审实证：epoch 0 在上海是 1969-12-31 16:00（不是 1970-01-01 0 点），
    // 故 --full 首窗是 16 小时残段、窗数至多 +1；非日界 --since 的首窗也是残段
    //（批 6 #2 起残段窗直接跳过不落库，末残段由下轮日对齐 run 补全 —— 见下一条用例）。
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    expect(s).toMatch(/起点 0（= 上海 1969-12-31 16:00）/)
    expect(s).not.toMatch(/起点 0 恰为上海 1970-01-01 0 点/)
    expect(s).not.toMatch(/日对齐不放大窗数/)
    const md = read('README.md')
    expect(md).not.toMatch(/每窗恰是一整个业务日，「每日概览」/)
    // 批 6 #2 起措辞升级：残段窗不再「以水位续跑闭环」了事，而是显式跳过不落库
    expect(md).toMatch(/非日界首末段是残段窗/)
    expect(md).toMatch(/windows\.skipped/)
  })

  it('批 6 #2 文档联动：残段窗跳过与 windows.skipped 契约写在 spec §5.2/§七 与 README', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    // §5.2：残段窗跳过 + 水位语义（半日聚合不落库、末残段由下轮补全）
    expect(s).toMatch(/残段窗跳过/)
    expect(s).toMatch(/跳过不落库/)
    // §七：windows.skipped 字段契约（total = succeeded + failed + skipped）
    expect(s).toMatch(/`windows\.skipped`（修复批 6 新增，恒在）/)
    expect(s).toMatch(/total = succeeded \+ failed \+ skipped/)
    const md = read('README.md')
    expect(md).toMatch(/windows.*skipped.*total = succeeded \+ failed \+ skipped/s)
  })

  it('批 7 N-2/N-4：补全承诺限定末残段（首残段不补）+ resolved_range.start 水位起点语义', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    const md = read('README.md')
    // N-2 正锚：「由下轮日对齐 run 补全」必须带「末残段」限定，且写明首残段处置三要素
    for (const [name, doc] of [['spec', s], ['README', md]] as const) {
      // 反锚：任何「由下轮日对齐」出现处的前文必须含「末残段」（无条件补全承诺不得回归）
      for (const m of doc.matchAll(/由下轮日对齐/g)) {
        const before = doc.slice(Math.max(0, m.index! - 24), m.index!)
        expect(before, `${name}: 补全承诺须限定末残段`).toMatch(/末残段/)
      }
      expect(doc, `${name}: 末残段正锚`).toMatch(/末残段/)
      expect(doc, `${name}: 首残段不补`).toMatch(/首残段.*不落日行也\*?\*?不补\*?\*?|首残段.*不补/)
      expect(doc, `${name}: 恢复路径 = 更宽 --since`).toMatch(/更宽的 `--since`/)
    }
    // N-4：resolved_range.start 是水位起点语义（含被跳过的首残段前缀），读方按 end + skipped 判断
    expect(s).toMatch(/resolved_range\.start` 是\*\*水位起点语义\*\*/)
    expect(s).toMatch(/按 `resolved_range` 的 end（水位）与 `windows\.skipped` 判断真实覆盖/)
    expect(md).toMatch(/resolved_range\.start` 是\*\*水位起点语义\*\*/)
    expect(md).toMatch(/end（水位）与 `skipped` 判断真实覆盖/)
  })

  it('批 8（CodeRabbit 三轮 4 条）：补全承诺是「可能」不是保证 / 自愈矛盾消除 / 整日限定执行窗 / 样本自洽', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    const md = read('README.md')
    // 三轮 #2（spec:141）与 #1（README:191）：「可能由…补全」+「不保证下一次 run 补上」，
    // 无条件/含混的「由下轮日对齐 run 补全」与「下一轮自愈」不得回归
    for (const [name, doc] of [['spec', s], ['README', md]] as const) {
      expect(doc, `${name}: 补全是可能而非保证`).toMatch(/可能\*?\*?由/)
      expect(doc, `${name}: 下轮不保证补上须写明`).toMatch(/不保证|仍未覆盖该整天/)
      expect(doc, `${name}: 前缀不会自动前移`).toMatch(/不会\s*\n?\s*自动前移|不会自动前移/)
      expect(doc, `${name}: 旧的自愈承诺不得残留`).not.toMatch(/下一轮\s*\n?\s*对齐起点的 run 自愈|下一轮对齐起点的 run 自愈/)
    }
    // 三轮 #3（README:187）：「每窗恰是完整上海自然日」必须限定为实际拉取的窗
    expect(md).toMatch(/实际拉取的每窗恰是一个完整上海/)
    expect(md).not.toMatch(/对齐后：每窗恰是一个完整上海/)
    // 三轮 #4（spec:234）：§七 样本与实现自洽 —— total 31 = 29 整日 + 2 残段，
    // resolved_range.start 含首残段前缀（11:15 非 0 点）、end=watermark=末整日窗 end、rows=succeeded
    expect(s).toMatch(/"windows": \{ "total": 31, "succeeded": 29, "failed": 0, "skipped": 2 \}/)
    expect(s).toMatch(/"resolved_range": \["2026-09-14T11:15:00\+08:00", "2026-10-14T00:00:00\+08:00"\]/)
    expect(s).toMatch(/"watermark": "2026-10-13T16:00:00\.000Z"/)
    expect(s).toMatch(/"rows": \{ "fetched": 29, "written": 29 \}/)
    // CHANGELOG 残段窗条目同口径：补全承诺限定为「可能 + 不保证下一次 run」（本轮收口处）
    const cl = read('CHANGELOG.md')
    expect(cl).toMatch(/末残段的整日值可能由其请求区间覆盖该整天的日对齐 run 补全/)
    expect(cl).toMatch(/不保证「下一次 run」/)
    expect(cl).toMatch(/首残段不补，要覆盖该日请给更宽的 `--since`/)
  })

  it('批 6 #1 文档联动：sync install 的 env 派生固化与「不继承 shell 环境/不写凭证」写明', () => {
    const md = read('README.md')
    expect(md).toMatch(/调度条目不继承你的 shell 环境/)
    expect(md).toMatch(/不写入任何\s*\n?\s*凭证|不写入任何凭证/)
    expect(md).toMatch(/QIYU_DB_PATH/)
    const s = read('src/commands/sync.ts')
    expect(s).toMatch(/不继承你的 shell 环境/)
  })

  it('2026-10-29 空串口径：README 写明 env 空串=未设置、显式 flag 空串=用法错误', () => {
    // ⚠️ 钉住 README 的实质主张（不只是出现变量名）：这三句各自对应一条实测缺陷 ——
    // ① env 空串遮蔽配置文件里真实存在的值；② 显式 `--db ''` 不得静默改道；
    // ③ 旧文案「均为空」把没坏的那层一起指控。
    const md = read('README.md')
    expect(md, 'env 空串=未设置必须写明').toMatch(/QIYU_DB_PATH=` \/ `QIYU_STORE_BACKEND=`[\s\S]{0,120}视为\*\*未设置\*\*/)
    expect(md, '显式 flag 空串仍是用法错误必须写明').toMatch(/显式\*\* `--db ''`[\s\S]{0,80}用法错误/)
    expect(md, '必须点明空白串不等于空串，两者都拒绝').toMatch(/空白串[\s\S]{0,40}不是空串，两者都拒绝/)
    // sync install 段：空串 env 时「解析结果不固化」的理由必须写明 —— 这不是同一个
    // 缺陷的复述，而是它的**第二后果**（固化了回落后的路径 = 悄悄钉死配置）。
    expect(md, 'sync install 段必须写明空串 env 不固化解析结果')
      .toMatch(/QIYU_STORE_BACKEND=`[\s\S]{0,60}解析结果不固化/)
    // 旧文案本身（「…均为空」把三层一起指控）不得作为**主张**留在 README 里 ——
    // 允许作为历史引注出现（本段就在解释它错在哪），所以判据是「引用之外不出现」。
    expect(md.match(/均为空/g)?.length ?? 0, '「均为空」只允许作为历史引注出现一次').toBeLessThanOrEqual(1)
  })

  it('2026-10-29 显式 flag 空白取值：README 写明 sync 侧对齐 query、且 cron 解析先于探测', () => {
    // ⚠️ 这一段的每句都对应一条真库实测缺陷：
    // ① `sync run --since ''` 被真值判据当成「没给」（query 一直是 usage）；
    // ② `--full --since ''` 因此**绕过互斥守卫**跑了一次全量重刷、退出码 0；
    // ③ cron 解析排在 probeSynced 之后 —— 未同步的库上报 sync_not_run，
    //    Agent 会照 hint 先跑一轮全量同步再回来看到真正的参数错误。
    const md = read('README.md')
    expect(md, '必须点明显式 flag 空白取值在 sync 侧是用法错误')
      .toMatch(/显式 flag\*\* 的空白取值是用法错误、不是「没给」/)
    expect(md, '必须点明 --full --since \'\' 曾绕过互斥守卫').toMatch(/绕过互斥守卫/)
    expect(md, '必须点明 cron 解析先于存储前置探测').toMatch(/cron[\s\S]{0,30}解析也排在存储前置探测\*\*之前\*\*/)
  })
})

describe('CI 工作流 —— 承诺的检查必须真的接在 npm 脚本上', () => {
  it('ci.yml：push/PR 到 main 触发、矩阵覆盖 engines 下限与当前 LTS、三步齐全', () => {
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toMatch(/pull_request:/)
    expect(ci).toMatch(/branches: \[main\]/)
    // 版本矩阵锚 engines 下限（package.json engines: >=20.12）、维护期 LTS 与当前 LTS
    expect(ci).toMatch(/'20\.12'/)
    expect(ci).toMatch(/'22'/)
    expect(ci).toMatch(/'24'/)
    // 三步都必须真跑：缺 npm ci 则依赖/构建断裂不可见，缺 typecheck/test 则承诺落空
    expect(ci).toMatch(/run: npm ci/)
    expect(ci).toMatch(/run: npm run typecheck/)
    expect(ci).toMatch(/run: npm test/)
    // 并发限制复用 package.json 的 test 脚本，CI 不得另传并发参数覆盖它
    // （注释里说明该约束是允许的；断言只看非注释行）
    const ciCode = ci.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n')
    expect(ciCode).not.toMatch(/maxWorkers|fileParallelism|--no-file-parallelism/)
    // 分片数 CI 必须显式钉成 1：GitHub runner 只有 2 核，分片反而更慢
    // （每片都要重起 Node + 转换缓存）。这条是**收敛**不是放宽 —— 但它得被钉住，
    // 否则删掉它就悄悄变慢，而没人会发现 CI 慢了。
    expect(ciCode).toMatch(/QIYU_TEST_SHARDS:\s*1/)
  })

  it('npm test 链上的每一环都自带单进程限制（CI 复用它的前提）', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    // npm test 走固定分片 runner（scripts/test-shards.mjs）。单进程限制因此不在
    // package.json 那一行字面里，而在 runner 里 —— 断言跟着搬家，但**判据不放宽**：
    // runner 必须逐字带上 --maxWorkers=1 与 --no-file-parallelism。
    //
    // ⚠️ 这条断言护的是 2026-10-05 那次内存耗尽事故：CI 只跑 `npm test`，
    // 所以并发限制必须烤进这条命令链的任何一环，且不能被环境变量悄悄改掉。
    expect(pkg.scripts.test).toMatch(/scripts\/test-shards\.mjs/)
    const runner = read('scripts/test-shards.mjs')
    expect(runner).toMatch(/--maxWorkers=1/)
    expect(runner).toMatch(/--no-file-parallelism/)
    // 分片数必须**固定上限**，不得随 CPU 数放大 —— 「16 核起满 worker」正是事故形态。
    expect(runner).toMatch(/MAX_SHARDS/)
    expect(runner).not.toMatch(/cpus\(\)|availableParallelism/)
    expect(pkg.scripts.typecheck).toMatch(/tsc/)
  })

  it('engines 下限与 CI 矩阵下限同源（声明的下限必须被真的测到）', () => {
    const pkg = JSON.parse(read('package.json')) as { engines: { node: string } }
    const floor = pkg.engines.node.replace(/^>=/, '')
    const ci = read('.github/workflows/ci.yml')
    expect(ci).toContain(`'${floor}'`)
  })

  it('README 开发节与 CHANGELOG 版本区写明 CI（文档不说假话）', () => {
    expect(read('README.md')).toMatch(/\.github\/workflows\/ci\.yml/)
    const md = read('CHANGELOG.md')
    const unreleased = allVersionSections(md)
    expect(unreleased).toMatch(/CI（`\.github\/workflows\/ci\.yml`）/)
  })
})

describe('E 查询与沙箱交付联动 —— 不得说假话（E-T12）', () => {
  it('cli.ts 顶层 USAGE 列全五个查询命令', () => {
    const s = read('src/cli.ts')
    for (const cmd of ['db tables', 'db describe', 'query --sql', 'query --table', 'stats fields']) {
      expect(s, `USAGE 缺 ${cmd}`).toMatch(new RegExp(cmd.replace(/ /g, '\\s+')))
    }
  })
  it('README 含五个查询命令、查询层目录与默认脱敏边界', () => {
    const md = read('README.md')
    for (const cmd of ['db tables', 'db describe', 'query --sql', 'query --table', 'stats fields']) {
      expect(md, `README 缺 ${cmd}`).toMatch(new RegExp(cmd.replace(/ /g, '\\s+')))
    }
    expect(md).toMatch(/src\/query\//)
    expect(md).toMatch(/默认脱敏/)
    // 脱敏边界必须写明：--sql 的别名绕过会漏，不是「安全无死角」的承诺
    expect(md).toMatch(/别名|值级兜底/)
  })
  it('README 查询段含 meta 键与「0 行 ≠ 没有数据」', () => {
    const md = read('README.md')
    for (const k of ['resolved_range', 'data_coverage', 'masked_columns', 'mask_warnings', 'truncated']) {
      expect(md, `README 缺 ${k}`).toMatch(new RegExp(k))
    }
    expect(md).toMatch(/0 行不等于没有数据|0 行.{0,10}不等于.{0,10}没有数据/)
  })
  it('CHANGELOG 版本区含查询命令、三层沙箱与 query_timeout（反引号命令形态）', () => {
    const md = read('CHANGELOG.md')
    const unreleased = allVersionSections(md)
    expect(unreleased).toMatch(/`db tables`/)
    expect(unreleased).toMatch(/`query --sql`/)
    expect(unreleased).toMatch(/`query --table`/)
    // 命令后带形态说明（如 `stats fields <报表>`）——锚开引号后的命令名即可
    expect(unreleased).toMatch(/`stats fields/)
    expect(unreleased).toMatch(/query_timeout/)
    expect(unreleased).toMatch(/三层只读沙箱/)
  })
  it('路线图 §四.E 标注已交付、§六.4 记 E 交付且下一步是 F', () => {
    const s = read('docs/superpowers/specs/2026-10-09-后续交付路线图-design.md')
    expect(s).toMatch(/### E\. 查询接口与沙箱（`query\/`）—— ✅ 已交付/)
    const l4 = s.split('\n').find((l) => /E 已交付（2026-10-17/.test(l)) ?? ''
    expect(l4).toMatch(/E 已交付/)
    const next = s.split('\n').find((l) => /下一步（2026-10-17 更新）/.test(l)) ?? ''
    expect(next).toMatch(/F Skill/)
  })
  it('设计稿状态行与 §8 含 E 阶段标注，并点名实现期两处修正', () => {
    const s = read('docs/qiyu-cli-design.md')
    expect(s).toMatch(/状态：实施中.*E 查询与沙箱已交付/)
    expect(s).toMatch(/E 阶段：✅ 已交付/)
    // 阶段标注必须点名两处实现期修正（否则读者会以为设计稿 = 最终实现）
    expect(s).toMatch(/EXPLAIN ANALYZE/)
    expect(s).toMatch(/块注释可嵌套/)
  })
  it('分层规则已扩展：query 不 import sync/commands，store 不 import query', () => {
    const s = read('tests/store/layering.test.ts')
    expect(s).toMatch(/query\/ 不得 import sync\/ 与 commands\//)
    expect(s).toMatch(/store\/ 不得 import query\//)
  })
})

describe('PR5 文档一致性回写 —— 陈旧声明与承诺收窄（2026-10-30）', () => {
  // ⚠️ 这一组守的是「已交付的能力不得再被文档说成没实现 / 已声明的承诺不得被当成事实」。
  // 每条都以**双向自检**写：真实事故文本必须被判红，回写后的合法文本必须放过。
  // 只用 `not.toMatch` 的守卫会随文档改版悄悄变恒真（README 的 notYet 段就是这样失守的），
  // 故每条都配一个正锚（回写后的措辞必须在场）。
  const design = (): string => read('docs/qiyu-cli-design.md')

  it('设计稿 §2：语义化命令的「未交付挂账」状态注在场，且点名两条未交付项', () => {
    const s = design()
    expect(s, '§2 必须带交付状态注').toMatch(/交付状态（2026-10-30 回写）/)
    expect(s).toMatch(/工单领域的语义化命令[\s\S]{0,400}未交付/)
    expect(s).toMatch(/知识库领域的语义化命令（只读）[\s\S]{0,600}未交付/)
    // 反向：不得再出现「本节范围内」被读成已交付的旧错觉 —— 状态注明写「不是交付清单」
    expect(s).toMatch(/本节是\*\*范围声明\*\*，不是交付清单/)
  })

  it('设计稿 §11.2 E：`--pretty` 不再是「未实现」，且醒目写明它已实现', () => {
    const s = design()
    // 双向自检：事故形态（旧原文）必须被正则抓住 —— 证明这条守卫不是恒真的摆设
    const ACCIDENT = '不要使用 `--pretty`（未实现），不要把 `query --table` 当作任意 SQL 的替代品'
    expect(/不要使用 `--pretty`（未实现）/.test(ACCIDENT)).toBe(true)
    // ⚠️ 只能锚**E 禁止事项那一行**做反向断言，不能对全文 `not.toMatch` —— 回写的状态注
    // 本身就逐字引用了旧措辞（「原文写「不要使用 `--pretty`（未实现）」」），对全文判会
    // 把「解释旧错」误判成「仍在犯旧错」。这正是本仓库反复打的形态：守卫的判据要与它要
    // 防的东西对齐，而不是与文本里出现的任意子串对齐。
    const eLine = s.split('\n').find((l) => /^\*\*E\. 禁止事项\*\*/.test(l)) ?? ''
    expect(eLine, 'E 禁止事项行必须存在').not.toBe('')
    expect(/不要使用 `--pretty`（未实现）/.test(eLine), 'E 行的旧措辞不得回归').toBe(false)
    expect(eLine, 'E 行必须写明 --pretty 已实现').toMatch(/它\*\*已实现\*\*/)
    expect(s, '必须给出回写状态注').toMatch(/`--pretty` \*\*自 2026-10-24（G1）起已实现\*\*/)
  })

  it('设计稿 §4.2：whoami 不再谎称「校验凭证」（只检查存在性）', () => {
    const s = design()
    const ACCIDENT = 'qiyu auth whoami               # 校验凭证并显示当前 profile（+ source / robots）'
    expect(/校验凭证并显示当前 profile/.test(ACCIDENT)).toBe(true)
    expect(s, '「校验凭证并显示当前 profile」的旧措辞不得回归').not.toMatch(/校验凭证并显示当前 profile/)
    expect(s).toMatch(/措辞收窄（2026-10-30 回写）/)
    expect(s).toMatch(/只判断凭证\*\*是否存在\*\*/)
    expect(s).toMatch(/\*\*从不向服务端发请求\*\*/)
  })

  it('设计稿 §4.3：14500 熔断与 14501 分片的收窄状态注在场（计数/持久化未做，切片在 sync）', () => {
    const s = design()
    expect(s).toMatch(/承诺收窄（2026-10-30 回写）\*\*：落地的是\*\*等效防死循环\*\*/)
    expect(s, '熔断状态的旧承诺不得回归').toMatch(/持久化的熔断状态\*\*（没有写进本地库/)
    // 14501：core 不切片，切片在 sync —— 旧表行「core 层自动分片」必须改掉
    expect(s, '14501 不再声称 core 自动分片').not.toMatch(/\| 14501 \| 数据量超限 \| — \| \*\*core 层自动分片\*\* \|/)
    expect(s).toMatch(/14501 只被翻译、不被吸收/)
    expect(s).toMatch(/真正切片的只有同步引擎/)
  })

  it('设计稿 §6.4/§6.5：退避是固定间隔、陈旧锁超时未实现、CHECKPOINT 不自动执行', () => {
    const s = design()
    expect(s, '「以指数退避重试」的旧措辞不得回归').not.toMatch(/冲突时\*\*以指数退避重试\*\*/)
    expect(s).toMatch(/曲线是固定间隔，不是指数退避/)
    expect(s).toMatch(/陈旧锁超时未实现/)
    expect(s).toMatch(/CLI \*\*不自动执行 `CHECKPOINT`\*\*/)
  })

  it('设计稿 §7.4/§7.4.1：限频持久化与 maxWindowDays 预校验各自收窄到 sync', () => {
    const s = design()
    expect(s).toMatch(/这句话\*\*只对 `sync` 成立\*\*/)
    expect(s).toMatch(/`api call` 是\*\*一次性进程\*\*/)
    expect(s).toMatch(/预校验只有 `sync` 做，`api call` 不做/)
    expect(s).toMatch(/它不知道这个接口的窗口起止放在 body 的哪两个字段里/)
  })

  it('设计稿 §9.1/§11.2：`meta.cached` 从输出样本删除，缓存能力的旧承诺不得回归', () => {
    const s = design()
    expect(s, '`meta.cached` 不得再出现在输出样本里').not.toMatch(/"cached": false/)
    expect(s).toMatch(/`meta\.cached` 已从样本里删掉（2026-10-30 回写）/)
    expect(s, '「D 交付后缓存查询生效」的旧承诺不得回归').not.toMatch(/D 交付后缓存查询生效/)
  })

  it('存储层 spec：auth login / --pretty 的「尚未实现」就地状态注在场，且旧断言的废除写明', () => {
    const s = read('docs/superpowers/specs/2026-10-13-存储层-design.md')
    expect(s).toMatch(/本 spec 是 2026-10-13 的历史记录（2026-10-30 状态注）/)
    expect(s).toMatch(/`auth login` 已于 \*\*2026-10-25\*\* 实现/)
    expect(s).toMatch(/本节已整体过时（2026-10-30 状态注）/)
    expect(s).toMatch(/`--pretty` 已于 \*\*2026-10-24（G1 第二批）实现\*\*/)
    // 验收口径的作废必须点名（防实施者照旧文验收）
    expect(s).toMatch(/那两处「--pretty 尚未实现」的验收口径\*\*已作废\*\*|验收口径\*\*已作废\*\*/)
  })

  it('skill spec / query spec：`--pretty` 的 rejected 建模与「不做 --pretty」各自标了作废', () => {
    const skill = read('docs/superpowers/specs/2026-10-20-skill-design.md')
    expect(skill, '待评审的旧状态行必须改掉').not.toMatch(/^> 状态：待评审/)
    expect(skill).toMatch(/\*\*已批准并交付（2026-10-26 合并，PR #32）\*\*/)
    expect(skill).toMatch(/本条已作废\*\* —— `--pretty` 于 \*\*2026-10-24（G1）实现\*\*/)
    const query = read('docs/superpowers/specs/2026-10-17-查询接口与沙箱-design.md')
    expect(query).toMatch(/本条已被 G1 推翻 —— `--pretty` 2026-10-24 已实现/)
    expect(query).toMatch(/`--pretty` 已于 2026-10-24 实现 —— 现在 `query --table … --pretty` 退出码 0/)
  })

  it('skill 正文 forbidden.md：对 Agent 的 `--pretty` 口径是「没有增益」而非「未实现」', () => {
    const md = read('src/skill/qiyu/forbidden.md')
    expect(md, '不得再声称 --pretty 未实现').not.toMatch(/--pretty.{0,12}未实现/)
    expect(md).toMatch(/不需要 `--pretty`/)
    expect(md).toMatch(/对\s*\n?\s*Agent 没有增益|对 Agent 没有增益/)
  })
})
