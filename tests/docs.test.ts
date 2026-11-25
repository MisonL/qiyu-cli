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
      // ⚠️ `config_invalid` 是真实会出现的 kind（`auth login` 读到畸形/半坏配置时给），
      // 但 cli.ts 有、auth.ts / api.ts 的 USAGE 清单此前都漏了（2026-11-14，历史审查 PR#71
      // 复核）。锚定「config_insecure / config_invalid / confirm_required」这个相邻形态 ——
      // 注释里孤立的词不算数（与上面同一条判据的口径）。
      expect(s, f).toMatch(/config_insecure \/ config_invalid \/ confirm_required/)
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
    // ⚠️ 按锚行判定，不用全文档备选正则（2026-11-01 审查 7c）：原先的 /name.*rows/ 分支会撞上
    // 506 行**无关**的字段语义段落（`name-suffix` … `rows_present`），把 tables 形态原句删掉
    // 断言照样绿 —— 备选分支必须要能证明自己守的是同一句话。
    const shapeLine = md.split('\n').find((l) => l.includes('形状随命令不同')) ?? ''
    expect(shapeLine, '找不到「tables 形状随命令不同」段落').not.toBe('')
    expect(shapeLine).toMatch(/\{name, rows\}/)
    expect(shapeLine).toMatch(/store status/)
    const initShapeLine = md.split('\n').find((l) => l.includes('给表名数组')) ?? ''
    expect(initShapeLine, '找不到 store init 的 tables 形态句').toMatch(/`store init`/)
    // 轮询代价：`全表 COUNT` 与 `轮询代价` 同处该段落（防把守卫换成别处的 `轮询` 二字蒙混）
    const pollLine = md.split('\n').find((l) => /全表.*COUNT/.test(l)) ?? ''
    expect(pollLine, '找不到全表 COUNT 句').not.toBe('')
    expect(pollLine).toMatch(/轮询代价/)
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

  it('README 的 complete 行不得把「覆盖窗失败转 skipped」当成 skipped 的成因（CR 第十五轮 minor）', () => {
    // 语义事实（引擎口径）：覆盖窗失败 ⇔ 有一个窗口 failed > 0 ⇔ status 只可能是 partial；
    // 而 complete 的定义就是 windows.failed = 0 —— 两者互斥。README 一度在 complete 行
    // 并列「三种成因」，把只在 partial 出现的成因写进了 complete 的覆盖面，Agent 会以为
    // 「complete 也可能藏着没拉到的合并窗」。
    // 判据：该行必须带「只会出现在 partial」的限定，且不得声称三种成因。
    const md = read('README.md')
    const row = md.split('\n').find((l) => /^\| `complete` \|/.test(l))
    expect(row, 'README 必须有 complete 的 status 行').toBeDefined()
    expect(row!, 'complete 行必须列残段窗成因').toContain('残段窗')
    expect(row!, 'complete 行必须列整窗晚于末端上限成因').toContain('晚于末端上限')
    expect(row!, '覆盖窗失败那种必须限定为只在 partial 出现').toContain('只会出现在 `partial`')
    expect(row!, 'complete 行不得声称三种 skipped 成因').not.toContain('三种')
  })

  it('README 对 tasks[].notes 的说明覆盖全部生产来源（Codex 第十五轮 P2）', () => {
    // notes 有两个生产来源（下界 + 非日界 --until 两档）。README 若只举下界一例，
    // 读 README 改脚本的 Agent 会把末段提示误读成故障或漏掉「该日未同步」的事实。
    const md = read('README.md')
    const i = md.indexOf('`notes` 是中文说明数组')
    expect(i, 'README 必须有 notes 的字段说明').toBeGreaterThan(-1)
    const para = md.slice(i, i + 600)
    expect(para, '来源一：早于接口下界').toContain('早于接口可得数据的最早边界')
    expect(para, '来源二：非日界 --until').toContain('非上海日界')
    expect(para, '末残段档').toContain('残段窗')
    expect(para, '末端上限档').toContain('上限自然前移')
    expect(para, '指向 windows.skipped 判断末段').toContain('windows.skipped')
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
      // 反锚：任何「日对齐 run 补全」出现处的前文必须含「末残段」（无条件补全承诺不得回归）。
      // ⚠️ 锚必须是正文**现行**措辞：旧锚「由下轮日对齐」在批 8 改写后已不在文中，
      // 循环零次迭代、断言从不求值（2026-11-01 审查 7a）—— 故下面先断言命中数 > 0。
      const hits = [...doc.matchAll(/日对齐 run 补全/g)]
      expect(hits.length, `${name}: 找不到补全承诺锚句，反锚会零次迭代`).toBeGreaterThan(0)
      for (const m of hits) {
        const before = doc.slice(Math.max(0, m.index! - 60), m.index!)
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
    // ⚠️ 判据必须锚在**状态注那一块**（连续的 `>` 引用块），不能写成
    // `/工单领域的语义化命令[\s\S]{0,400}未交付/` —— 实测那个写法虽然能过（间距 391 < 400），
    // 但它匹配的起点是**范围清单那一行**（§2 的 `<li>`），不是状态注：真正被断言的只是
    // 「清单行的 400 字之内出现过『未交付』」。清单多一行就变红、状态注写成别的意思也能过，
    // 两种失效方向都错。这里把块先切出来，再在块内断言。
    const start = s.indexOf('> **⚠️ 交付状态（2026-10-30 回写）**')
    expect(start, '§2 交付状态注必须存在').toBeGreaterThanOrEqual(0)
    const rest = s.slice(start)
    // 块在第一个非 `>` 开头的非空行处结束（Markdown 引用块的自然边界）
    const blockEnd = rest.split('\n').findIndex((l, i) => i > 0 && l.trim() !== '' && !l.startsWith('>'))
    const block = blockEnd === -1 ? rest : rest.split('\n').slice(0, blockEnd).join('\n')
    // 状态注的语义是「上面两条……未交付」，两条是它下面的两个分点 —— 所以判据分两步：
    // ① 块内必须有一句「两条……未交付」的论断；② 块内必须逐个点名两条命令。
    expect(block, '状态注必须写明「上面两条……未交付」').toMatch(/两条\*\*语义化命令\*\*未交付/)
    expect(block, '状态注必须点名工单领域').toMatch(/工单领域的语义化命令/)
    expect(block, '状态注必须点名知识库领域').toMatch(/知识库领域的语义化命令（只读）/)
    // 反向：不得再出现「本节范围内」被读成已交付的旧错觉 —— 状态注明写「不是交付清单」
    expect(block, '状态注必须写明「不是交付清单」').toMatch(/本节是\*\*范围声明\*\*，不是交付清单/)
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
    // ⚠️ CodeRabbit round 3 指出并核实成立：**表行本身**也要区分两种 14501，
    // 不能只在下方状态注里说 —— 状态注在别处，读者若只读表格会照旧按「切片」处理越界。
    const row14501 = s.split('\n').find((l) => /^\| 14501 \|/.test(l)) ?? ''
    expect(row14501, '14501 表行必须存在').not.toBe('')
    expect(row14501, '表行必须点名 window_too_large').toContain("window_too_large")
    expect(row14501, '表行必须点名 window_misaligned').toContain("window_misaligned")
    // ⚠️ CodeRabbit round 8 指出并核实成立：表行的 `window_misaligned` 指引也必须带上界 ——
    // 只写「对齐自然日边界」的读者会把明天 00:00（已对齐但越界）原样重发。
    expect(row14501, '表行必须写明越界的上界条件 —— 早于而非不晚于（§6.2 实测今天 0:00 不稳定）').toMatch(/必须早于今天 00:00/)
    // ⚠️ CodeRabbit #50 round 2 指出并核实成立：两种 14501 的下一步**不同**。
    // 越界（endTime is invalid）→ 对齐自然日边界；跨度过大 → 按上限切片。
    // 回写第一版把两者都写成「按 maxWindowDays 切片后重试」，会让 Agent 对越界窗口
    // 反复按切片重试同一个失败请求（1–2 天的窗口切片也救不了越界）。
    expect(s).toMatch(/endTime is invalid`（越界）→ `kind: 'window_misaligned'`/)
    expect(s).toMatch(/切片救不了越界/)
    // ⚠️ CodeRabbit #50 round 10 指出并核实成立（§6.2 实测）：本注的前一版把越界处置写成
    // 「对齐自然日边界 **且** 不晚于今天 00:00」的**双条件**，两半都错 ——
    // ① 「对齐」从来不是要求：纯历史日期的 endTime 取**任意时刻**都接受（`5 天前 0:00 →
    //    5 天前 12:00` 返回 200），round 9 已把这一条写进注里，但表行与双条件句没跟着改；
    // ② 「不晚于」把等号划进安全区：`endTime = 今天 0:00` 恰是那条**本身不稳定**的边界
    //    （同一取值有时 200 有时被拒）。教 Agent 用「不晚于今天 0:00」＝教它去踩这条边界。
    // 正确表述是单条件的「**早于**今天 00:00 / 用纯历史日期」。守卫因此分两层：
    // 事故文本（双条件句 + 等号措辞）必须被判红，回写后的单条件表述必须放过。
    const errs = read('src/core/errors.ts')
    const noteStart = s.indexOf('> **⚠️ 「core 层自动分片」的收窄（2026-10-30 回写）**')
    expect(noteStart, '§4.3 的 14501 收窄注必须存在').toBeGreaterThanOrEqual(0)
    const noteRest = s.slice(noteStart)
    const noteEnd = noteRest.split('\n').findIndex((l, i) => i > 0 && l.trim() !== '' && !l.startsWith('>'))
    const noteBlock = noteEnd === -1 ? noteRest : noteRest.split('\n').slice(0, noteEnd).join('\n')
    // 双向自检的「红」侧：事故文本必须被正则抓住 —— 证明下面的改正断言不是恒真的摆设
    const ACCIDENT_DUAL = '（**两个条件**：对齐自然日边界**且**不晚于今天 00:00）'
    expect(/两个条件|不晚于今天 00:00/.test(ACCIDENT_DUAL)).toBe(true)
    // ⚠️ 只能锚**转述 hint 的那一行**做反向断言，不能对整块 `not.toMatch(/不晚于今天 00:00/)` ——
    // 更正说明本身逐字引用了旧措辞（「本注的前一版把它写成……『不晚于今天 00:00』」），
    // 对整块判会把「解释旧错」误判成「仍在犯旧错」。这与 §11.2 E 行是同一形态。
    const transcribeLine = noteBlock.split('\n').find((l) => /逐字一致）/.test(l)) ?? ''
    expect(transcribeLine, '§4.3 回写注必须转述实现 hint 那一行').not.toBe('')
    expect(transcribeLine, '转述行必须写明单条件「早于今天 00:00」').toMatch(/必须早于今天 00:00/)
    expect(transcribeLine, '转述行不得再把「不晚于今天 00:00」当作 hint 内容')
      .not.toMatch(/不晚于今天 00:00/)
    expect(noteBlock, '回写注必须写明「对齐」不是要求（纯历史日期取任意时刻都接受）')
      .toMatch(/任意时刻/)
    expect(noteBlock, '回写注必须点明「不晚于」把等号划进了安全区').toMatch(/把等号放进/)
    // 反向自检：文档转述的上界必须与**实现 hint** 逐字一致（否则文档教的和真报的对不上）
    const hintLine = errs.split('\n').find((l) => /hint: 'endTime 必须早于今天 00:00/.test(l)) ?? ''
    expect(hintLine, '实现里的 window_misaligned hint 必须存在且已改为「早于」').not.toBe('')
    expect(hintLine).toContain('必须早于今天 00:00')
    expect(noteBlock, '文档转述的实现 hint 必须与 src/core/errors.ts 逐字一致')
      .toContain(hintLine.trim().replace(/^hint: '/, '').replace(/' }$/, ''))
    // ⚠️ CodeRabbit round 7 指出并核实成立：§6.2 的不稳定边界段不应给出不安全示例
    // 「昨天 0:00 → 今天 0:00」—— 其右端正是那条不稳定边界（且不含今天 0:00 之后的
    // 数据，让人以为「拿到了今天」）。改为面向概念的「endTime 用纯历史日期」。
    // ⚠️ 只能锚**主张所在的那一行**不能对全文 `not.toMatch`：更正说明里逐字引用了旧建议
    // （「本节原写「用 `昨天 0:00 → 今天 0:00`，不要贴着边界」」），对全文判会把引用误判成主张。
    const idx = s.indexOf('- **⚠️ 今天 0:00 这条边界不稳定**')
    expect(idx, '§6.2 的不稳定边界说明必须存在').toBeGreaterThanOrEqual(0)
    const claimLine = s.slice(idx, s.indexOf('\n', idx))
    // 主张行本身不得再给不安全示例（更正说明里会引用旧建议，故只判主张行）
    expect(claimLine, '主张行不得再给「留安全余量/昨天→今天」的不安全示例')
      .not.toMatch(/留出安全余量|不要贴着边界|昨天 0:00 → 今天 0:00/)
    expect(claimLine, '主张行必须写明「不要当作可靠上界」').toMatch(/不要.*当可靠上界|不可靠/)
    const unstableBlock = s.slice(idx, idx + 700)
    expect(unstableBlock, '该段必须写明可靠做法是避开而不是贴边').toMatch(/避开它|不是贴着它留余量/)
    expect(s, '必须写明纯历史日期方案').toMatch(/纯历史日期/)
    // 反向自检：kind 名与实现一致（假的名字会让这条守卫守错东西）
    expect(errs, 'window_misaligned 必须真实存在').toContain("kind: 'window_misaligned'")
    expect(errs, 'window_too_large 必须真实存在').toContain("kind: 'window_too_large'")
  })

  it('设计稿 §6.4：读者重试不得把 `api` 算进来（api call 零加载 store，不持 RO 锁）', () => {
    const s = design()
    const ACCIDENT = '- **读者重试**：`query` / `api` 等只读操作以 RO 模式打开'
    expect(ACCIDENT.includes('`query` / `api`')).toBe(true)
    // ⚠️ CodeRabbit #50 round 2 指出并核实成立：`api call` 不 import store/（api.ts 的
    // import 清单里没有任何 store 模块），不打开本地库 → 它不会撞 store_locked。
    expect(s, '读者重试不得再列 `api`').not.toMatch(/`query` \/ `api` 等只读操作/)
    expect(s).toMatch(/\*\*2026-10-30 收窄：`api call` 不在其中\*\*/)
    // 反向自检：api.ts 确实不 import store（若将来它开始读库，这条守卫必须同步改）
    const apiSrc = read('src/commands/api.ts')
    expect(apiSrc, 'api.ts 一旦 import store/ ，本条守卫的判据就失效、必须复核')
      .not.toMatch(/from '\.\.\/(?:store|query)\//)
  })

  it('设计稿 §2：未交付的两条语义化命令不得被说成「只能经 api call 访问」（本地通道也要提）', () => {
    const s = design()
    // ⚠️ CodeRabbit #50 指出并核实成立：只写「只能经逃生通道 api call 访问」会让读的人
    // 以为工单/知识库数据全都拿不到 —— 实际数据两条路都有（api call 拉远程 / query 查本地库，
    // 四张表都在 TABLES 里且有同步任务）。缺的只是"语义层"这层包装。
    const ACCIDENT = '两条都只能经逃生通道（`api call`）访问'
    expect(ACCIDENT.includes('只能经逃生通道')).toBe(true)
    expect(s, '「只能经逃生通道访问」的旧措辞不得回归').not.toMatch(/只能经逃生通道/)
    expect(s).toMatch(/\*\*缺的是"语义层"，不是"数据"\*\*/)
    // ⚠️ CodeRabbit #50 round 10 指出并核实成立：这条对**全文** `s` 断言四个表名 ——
    // 四张表在 §6（报表/TABLES）等别处也逐字出现，把它们从**状态注**里整段删掉后
    // 全文判照样绿。假护栏。必须与上面第一条 §2 用例一样，先把状态注那一块切出来。
    const start = s.indexOf('> **⚠️ 交付状态（2026-10-30 回写）**')
    expect(start, '§2 交付状态注必须存在').toBeGreaterThanOrEqual(0)
    const rest = s.slice(start)
    const blockEnd = rest.split('\n').findIndex((l, i) => i > 0 && l.trim() !== '' && !l.startsWith('>'))
    const block = blockEnd === -1 ? rest : rest.split('\n').slice(0, blockEnd).join('\n')
    expect(block).toMatch(/\*\*缺的是"语义层"，不是"数据"\*\*/)
    expect(block, '本地通道的两条路（--table / --sql）必须在状态注块内').toMatch(/落库后走 `query --table`/)
    for (const t of ['`tickets`', '`ticket_logs`', '`knowledge_items`', '`knowledge_categories`']) {
      expect(block, `§2 状态注块内必须点名本地表 ${t}`).toContain(t)
    }
  })

  it('skill spec：`--pretty` 的「违规判据」一档已删（实现里从来没有这条检查）', () => {
    const sk = read('docs/superpowers/specs/2026-10-20-skill-design.md')
    // ⚠️ CodeRabbit #50 指出并核实成立：原文把「推荐了 --pretty」写成 skill check 的违规判据，
    // 但 ViolationRule 只有 table_name / sql_sequence / unknown_kind，flag 侧只有 rejected_flag，
    // 而 REJECTED_FLAGS 为空 → 推荐 --pretty 不会触发任何规则。
    // 上一版回写还写了「由内容红线兜底」—— 那句话是错的（三条内容红线都不看 flag），本条一并纠正。
    const violationRow = sk.split('\n').find((l) => /^\| 违规 \|/.test(l)) ?? ''
    expect(violationRow, '违规判据行必须存在').not.toBe('')
    expect(violationRow, '不得再声称推荐 --pretty 是违规判据').not.toMatch(/推荐了 `--pretty`/)
    expect(sk, '必须写明它只是写作口径、不是可校验判据').toMatch(/不是可校验的判据/)
    // 反向自检：三条内容红线的真实规则名必须在场（证明纠正后的表述与实现对齐）
    const check = read('src/skill/check.ts')
    for (const r of ["'table_name'", "'sql_sequence'", "'unknown_kind'"]) {
      expect(check, `ViolationRule 必须含 ${r}`).toContain(r)
    }
  })

  it('设计稿 §6.4/§6.5：退避是固定间隔、陈旧锁超时未实现、CHECKPOINT 是运维责任而非承诺', () => {
    const s = design()
    expect(s, '「以指数退避重试」的旧措辞不得回归').not.toMatch(/冲突时\*\*以指数退避重试\*\*/)
    expect(s).toMatch(/曲线是固定间隔，不是指数退避/)
    expect(s).toMatch(/陈旧锁超时未实现/)
    // ⚠️ CodeRabbit round 3 指出并核实成立：只写「CLI 不执行 CHECKPOINT → 文件无界膨胀，
    // 只能手动」把两件事都说过了 —— ① CLI 确实不执行（全仓无 CHECKPOINT 调用，这句话保留）；
    // ② 但 DuckDB 会按 WAL 大小自动 checkpoint（内置 `wal_autocheckpoint` 设置，仓库不改默认），
    //    所以「文件只增不减」是错的；③ 手动 CHECKPOINT 只部分回收已删除行空间。三者都要如实写。
    // 判据：不该再承诺「必须手动、否则无界膨胀」，而应写「CLI 不执行 + 可手动」。
    expect(s, '不得再声称文件只会手动回收才不膨胀')
      .not.toMatch(/库文件只增不减[\s\S]{0,20}唯有.*手动|不断累积已删除行的空间/)
    expect(s, '必须写明 CLI 不执行 CHECKPOINT（运维责任）').toMatch(/CLI \*\*不执行 `CHECKPOINT`\*\*/)
    expect(s, '必须写明 DuckDB 会按 WAL 自动 checkpoint').toMatch(/自动 checkpoint|wal_autocheckpoint/)
    // ⚠️ CodeRabbit round 6 指出并核实成立：判据不能只写 `/部分|一部分/` 对全文判 ——
    // 上面「自动 checkpoint 不等于文件有界」那段里也有「只回收一部分」，即使**手动指引那一句**
    // 改成承诺「完全回收」，全文判照样绿。必须锚到手动指引那一句本身。
    const manualLine = s.split('\n').find((l) => /什么时候需要手动做/.test(l)) ?? ''
    expect(manualLine, '手动 CHECKPOINT 的指引必须存在').not.toBe('')
    // 手工指引跨行 —— 取它后面紧跟的两行一起判（「别期待它一定把文件缩小」+「空间只回收一部分」）
    const idx = s.indexOf(manualLine)
    const manualBlock = s.slice(idx, idx + 400)
    expect(manualBlock, '手动指引必须写明「别期待它一定把文件缩小」')
      .toMatch(/别期待它一定把文件缩小/)
    expect(manualBlock, '手动指引必须限定空间只部分回收')
      .toMatch(/只回收一部分|部分回收|只\*\*部分\*\*回收/)
    // ⚠️ CodeRabbit round 8 指出并核实成立：`CHECKPOINT` 不是「把数据重写到新文件」——
    // DuckDB 定义它是把 WAL 同步回主数据文件；要紧凑的新文件得用 `COPY FROM DATABASE`。
    // DuckDB 定义它是把 WAL 同步回主数据文件；要紧凑的新文件得用 `COPY FROM DATABASE`。
    expect(manualBlock, '不得说 CHECKPOINT「重写到新文件」')
      .not.toMatch(/把数据重写到新文件/)
    expect(manualBlock, '必须写明 CHECKPOINT = WAL 同步回主数据文件')
      .toMatch(/把 WAL 同步回主数据文件/)
    expect(manualBlock, '必须给出紧凑新文件的正解 COPY FROM DATABASE')
      .toMatch(/COPY FROM DATABASE/)
    // ⚠️ CodeRabbit round 4 指出并核实成立：原稿写「长时间反复同步不会无界膨胀」把话说满 ——
    // 自动 checkpoint 限制的是 WAL 累积，不是 DB 文件大小；已删除行空间只部分回收，
    // 主库文件仍可能增长。判定：不得承诺「文件大小有界」。
    // ⚠️ 只锚**事故原句**，不能对全文 `not.toMatch(/文件大小有界/)` —— 回写正确的句子
    // 本身就在说「自动 checkpoint 不等于「文件大小有界」」，对全文判会把「澄清」判成「仍在承诺」。
    expect(s, '「长时间反复同步不会无界膨胀」的事故原句不得回归')
      .not.toMatch(/长时间反复同步\*\*不会\*\*无界膨胀|长时间反复同步不会无界膨胀/)
    expect(s, '必须写明自动 checkpoint 不等于文件有界').toMatch(/自动 checkpoint 不等于「文件大小有界」/)
    expect(s, '必须写明主库文件仍可能增长').toMatch(/仍可能[\s\S]{0,16}增长/)
  })

  it('设计稿 §7.4/§7.4.1：限频持久化与 maxWindowDays 预校验各自收窄到 sync', () => {
    const s = design()
    expect(s).toMatch(/这句话\*\*只对 `sync` 成立\*\*/)
    expect(s).toMatch(/`api call` 是\*\*一次性进程\*\*/)
    expect(s).toMatch(/预校验只有 `sync` 做，`api call` 不做/)
    expect(s).toMatch(/它不知道这个接口的窗口起止放在 body 的哪两个字段里/)
    // ⚠️ CodeRabbit round 4 指出并核实成立：不能承诺「不切就拿到 window_too_large」——
    // 超限报错码按接口族不同（statistic/* → 14501、summary → 14004、transferHuman → 14500），
    // 只有**已识别的那几种报文**才会被归成 window_too_large。
    const ACCIDENT = '不切就会拿到\n  `window_too_large`（hint 会再告诉你上限'
    expect(ACCIDENT.includes('不切就会拿到')).toBe(true)
    expect(s, '「不切就会拿到 window_too_large」的事故句不得回归')
      .not.toMatch(/不切就会拿到/)
    expect(s, '必须写明报错码按接口族不同').toMatch(/报错码与报文按接口族不同/)
    expect(s, '必须写明 window_too_large 只覆盖已识别报文').toMatch(/已识别.*那几种报文|识别到的那几种报文/)
  })


  it('设计稿 §9.1/§11.2：`meta.cached` 从输出样本删除，缓存能力的旧承诺不得回归', () => {
    const s = design()
    expect(s, '`meta.cached` 不得再出现在输出样本里').not.toMatch(/"cached": false/)
    expect(s).toMatch(/`meta\.cached` 已从样本里删掉（2026-10-30 回写）/)
    expect(s, '「D 交付后缓存查询生效」的旧承诺不得回归').not.toMatch(/D 交付后缓存查询生效/)
  })


  it('设计稿 §4.1 与 §12 的抓包口径一致（2026-11-22 校准，两处不得再分叉）', () => {
    // 事故：§4.1 原文逐字声称「已对线上 API 验证（原始 TCP 抓包、逐字节比对…）」，
    // §12 却挂账「原始 TCP 抓包验证实际发出的字节——未做」——同一文档两套口径，读者
    // 无从判断到底做没做过（报文级产物从未留存仓库）。修法：§4.1 收窄为「真实凭证往返、
    // 抓包产物未留存」，§12 把「未做仍挂账」升格为「显式非目标」并附判据。
    const s = design()
    // ① §4.1 不得再出现「已…抓包」的完成时声称（锚整句形态，校准注里引用的原文带「」引号，命中不了本锚）
    expect(s, '§4.1 不得再声称已完成原始 TCP 抓包验证')
      .not.toMatch(/^已对线上 API 验证（原始 TCP 抓包、逐字节比对/m)
    expect(s, '§4.1 必须改成「往返验证」并保留真实覆盖范围')
      .toMatch(/^已对线上 API 往返验证（\*\*真实凭证、覆盖中文\/emoji\/转义\/换行，均 `code:200`\*\*）/m)
    // ⚠️ **Codex round 23（P2）**：往返成功 ≠ 观测到 undici 的出站头。此前把
    // 「Content-Length 为字节数」写成往返实测结论——它只是库行为说明，未在本仓库测量。
    expect(s, '必须写明往返验证的是「服务端认了签名」，不是出站报文')
      .toMatch(/验证的是「服务端接受并认了签名」这一结果，不是出站报文本身/)
    expect(s, 'undici 的两条行为必须标注「未在本仓库独立测量」')
      .toMatch(/undici 库行为说明（未在本仓库独立测量）/)
    expect(s, '不得再把 Content-Length 写成逐字节/往返实测结论')
      .not.toMatch(/Content-Length` 为字节数，所有往返校验均通过/)
    // ② 校准注在场
    expect(s, '§4.1 与 §12 的矛盾必须写明（口径校准注）').toMatch(/口径校准（2026-11-22）/)
    expect(s).toMatch(/报文级抓取产物从未留存于本仓库/)
    // ③ §12 不得回到「未做，仍挂账」，必须是显式非目标
    expect(s, '§12 不得再把抓包写成待办挂账').not.toMatch(/原始 TCP 抓包验证实际发出的字节 —— \*\*未做\*\*，仍挂账/)
    expect(s, '§12 必须升级为显式非目标并给判据').toMatch(/原始 TCP 抓包验证实际发出的字节 —— \*\*显式非目标（2026-11-22 裁定，与 §4.1 口径一致）\*\*/)
    expect(s).toMatch(/校验和只覆盖 `body 原文` 与 `time` 文本、与传输层无关/)
    // ④ 双向自检：事故原文必须被①③的锚抓到
    const ACC1 = '已对线上 API 验证（原始 TCP 抓包、逐字节比对，覆盖中文/emoji/转义/换行）：undici 将…'
    const ACC2 = '原始 TCP 抓包验证实际发出的字节 —— **未做**，仍挂账（需要抓包环境…）'
    expect(/^已对线上 API 验证（原始 TCP 抓包、逐字节比对/m.test(ACC1), '事故§4.1必被①锚抓到').toBe(true)
    expect(/原始 TCP 抓包验证实际发出的字节 —— \*\*未做\*\*，仍挂账/.test(ACC2), '事故§12必被③锚抓到').toBe(true)
  })


  it('设计稿 §9.1 失败样本与真实出口逐字段一致（2026-11-22 校准，不得回归）', () => {
    // 事故：样本曾写 `retryable: false`（实现恒 true，errors.ts 的裁决注释就在源码里）、
    // hint 写「该接口每分钟限 1 次」（全 src 无该文案）、retry_after 缺类型必填的 source
    // （skill 正文的秒数可信度分流整个建立在 source 上）、fallback 首表 order_performance
    // 与其端点已登记 observed/30s 的限频档自相矛盾。样本自称契约，错一处就是教 Agent
    // 分支一个不可能的形状。判据对「文档里的真实样本」与「按行锚提取」生效。
    const s = design()
    const failSample = /"ok": false, "error": \{([\s\S]*?)\n\}\}/.exec(s)?.[1]
    expect(failSample, '失败样本必须能按现形提取到（改格式时同步改本守卫）').toBeDefined()
    const line = (src: string, k: string): string =>
      src.split('\n').map((l) => l.trim()).find((l) => l.startsWith(`"${k}"`)) ?? ''
    const L = (k: string): string => line(failSample!, k)
    // ① 逐字段判据（每条都能被对应事故形态触发）
    expect(L('code'), '样本 14009 行必须是 retryable: true —— 实现恒 true（errors.ts裁决注释）')
      .toMatch(/^"code": "14009", "kind": "rate_limit", "retryable": true,?$/)
    expect(L('hint'), '样本 hint 不得是 src 里不存在的编造文案').not.toMatch(/每分钟限 1 次/)
    expect(L('hint'), '样本 hint 必须是未登记档 + fallback 追加段的拼接完整形态（api.ts 是拼接）')
      .toMatch(/该接口未登记在本地限频表[\s\S]*该接口在同步任务里有本地表映射[\s\S]*没有打开库、没有确认这些表存在/)
    expect(L('retry_after'), 'retry_after.source 是类型必填五值，样本缺它就教 Agent 读不可能的载荷')
      .toMatch(/^"retry_after": \{"seconds": \d+, "source": "(observed|doc|local|header|fallback)"\},?$/)
    expect(L('fallback'), 'fallback 首表与「未登记档」自洽（order_performance 端点已登记 observed/30s，矛盾）')
      .toBe('"fallback": "qiyu query --table tickets"')
    // ② 校准注在场（删注必须红）
    expect(s, '样本校准说明必须在场').toMatch(/样本校准说明（2026-11-22）/)
    //③ 双向自检：把 2026-11-22 之前的**事故样本**喂给①的同一组判据，四条都必须不通过
    const ACCIDENT = [
      '  "code": "14009", "kind": "rate_limit", "retryable": false,',
      '  "message": "api call too frequent",',
      '  "hint": "该接口每分钟限 1 次",',
      '  "retry_after": {"seconds": 43},',
      '  "retry_strategy": "switch_to_local",',
      '  "fallback": "qiyu query --table order_performance"',
    ].join('\n')
    expect(/^"code": "14009", "kind": "rate_limit", "retryable": true,?$/.test(line(ACCIDENT, 'code')), '事故 retryable 必被①判红').toBe(false)
    expect(!/每分钟限 1 次/.test(line(ACCIDENT, 'hint')), '事故 hint 必被①判红').toBe(false)
    expect(/^"retry_after": \{"seconds": \d+, "source": "(observed|doc|local|header|fallback)"\},?$/.test(line(ACCIDENT, 'retry_after')), '事故缺 source 必被①判红').toBe(false)
    expect(line(ACCIDENT, 'fallback') === '"fallback": "qiyu query --table tickets"', '事故矛盾首表必被①判红').toBe(false)
  })


  it('设计稿 §3.2 目录树的交付状态注在场，四处实际落点逐个点名（2026-11-22 回写，不得回归）', () => {
    // 事故：§3.2 是设计期目标布局，从未对齐交付实况——sandbox 实际在 src/query/、
    // kysely.ts 未交付（C2 挂账）、sync/export.ts 从未单独成文件（实现在 tasks/pipeline+
    // sessions）、domains/ 整层未建。Agent 照树找文件会四处落空，而全文没有一处说明。
    const s = design()
    const tree = /### 3\.2 目录结构[\s\S]*?\n```[\s\S]*?\n```/.exec(s)
    expect(tree, '§3.2 树必须还在（本守卫锚它后面的状态注）').not.toBeNull()
    const after = s.slice(tree!.index + tree![0].length, tree!.index + tree![0].length + 1600)
    expect(after, '树后必须紧跟交付状态注').toMatch(/交付状态注（2026-11-22 回写）/)
    //四处偏差逐条点名（漏一条注就退化成泛泛"以仓库为准"，等于没写）
    expect(after).toMatch(/`store\/sandbox\.ts`[\s\S]*?src\/query\/sandbox\.ts/)
    expect(after).toMatch(/`store\/kysely\.ts`[\s\S]*?未交付/)
    expect(after).toMatch(/`sync\/export\.ts`[\s\S]*?不是单独文件/)
    expect(after).toMatch(/`domains\/`[\s\S]*?未建/)
    // 结构结论不变的边界也要写（防止把注读成"整节作废"）
    expect(after).toMatch(/结构性结论不变/)
    //双向自检：事故形态（无注的旧文）必红——after 里如果只有树没有注，上面的锚即红；
    //这里对「泛泛一句」的退化形态显式验证判据抓得住
    const DEGENERATE = '以运行时仓库为准。'
    expect(/`store\/sandbox\.ts`[\s\S]*?src\/query\/sandbox\.ts/.test(DEGENERATE)).toBe(false)
  })


  it('设计稿 §4.3：14003「永不可见」已补前提（bad_time 出口可达，2026-11-22 校准）', () => {
    // 事故：§4.3 表格写「core 层自动重新签名并重试，对 Agent 永不可见」是无条件句，
    // 但 errors.ts 有真实的 bad_time 出口（偏差>5min 或重签仍被拒时 Agent 看得到它），
    // skill 正文 errors.md 早已按实况写「已自动重签重试过；仍失败说明本机时钟真的偏了」
    // —— 同一契约的两条入口（设计稿 vs skill）说两套话，只修一条就是回归。
    // 行号会漂移，所以文档里只写 文件名+键名，不写 :303/:17。
    const s = design()
    const row = s.split('\n').find((l) => l.includes('| 14003 |')) ?? '(找不到 14003 行)'
    expect(row).toMatch(/前提：时钟偏差在 5 分钟内/)
    expect(row).toMatch(/bad_time/)
    expect(row, '「永不可见」只能以被纠正原文（带「」）的形态出现').toMatch(/「对 Agent 永不可见」是无条件句/)
    expect(row, '校准注里的引用不得再嵌会漂移的行号').not.toMatch(/errors\.ts:\d+|errors\.md:\d+/)
    // 与 skill 正文同口径（两条入口对齐）
    const sk = read('src/skill/qiyu/errors.md')
    expect(sk).toMatch(/已自动重签重试过；仍失败说明本机时钟真的偏了/)
    // 双向自检：无条件句的旧行必须被上面判据拒掉
    const ACCIDENT = '| 14003 | time 错误 | — | **core 层自动重新签名并重试，对 Agent 永不可见** |'
    expect(/前提：时钟偏差在 5 分钟内/.test(ACCIDENT), '事故行必被①判红').toBe(false)
  })


  it('设计稿 §5.2：`not_found` 的「一律」已按实现收窄为结构性判据（2026-11-22，Codex P1-7）', () => {
    // 事故：原文「`code:200` 且无数据字段的一律当作 `not_found`」比实现强。实现只判**结构性**
    // 为空（data 键缺失 / {} / []）；形状 M 的空 message 不判、业务性为空（ticket.search 的
    // {total:0,tickets:[]}）判不出来。Agent 若信「一律」，会把 not_found:false 读成「有数据」。
    const s = design()
    const rule = s.split('\n').find((l) => l.includes('信封归一化层不得假定')) ?? '(找不到规则行)'
    expect(rule, '「一律」不得作为无保留的通用规则').not.toMatch(/无数据字段的，一律当作/)
    expect(rule, '必须点明是结构性判据').toMatch(/结构性为空/)
    expect(rule, '必须承认业务性为空判不出').toMatch(/业务性为空|判不出|不等于有数据/)
    expect(rule, 'responseShape 的实况必须写准（已在 schema 透出，但判据不消费）')
      .toMatch(/response_shape.*不消费它|不消费/)
    // Codex 对 PR#82 的 P2：只说「结构性为空就判」仍然过宽——实现要求**该接口的 envelope
    // 形状已登记（实测过）才判**，未登记（null）与形状 D/M 都不判。真驱动探针：
    // normalize({code:200,data:[]}, null) → notFound:false。
    // ⚠️判据必须是**段内复合锚**（B2 变异实证）：单 token 的 /未登记|已登记/ 会被别处的
    //  incidental 命中满足——整段「未登记形状不判」被删时守卫照样绿。复合锚要求该档自己
    // 携带「不判的后果」（notFound:false / 纯确认…不判），删档即红。
    expect(rule, '未登记档必须自带「即便载荷空也不判」的后果').toMatch(/未登记[^。；]{0,180}notFound:false/)
    // ⚠️ **Codex 对 PR#82 的 round-18 P2**：`envelope` 未登记时规则**不是一刀切**
    // （真驱动探针 9 格）：`data`/`result`/无载荷 → notFound:false；但载荷在 JSON `message`
    // 里且解析出来是 `[]`/`{}` → **notFound:true**（`smstask.status` 的 `{code:200,message:"[]"}`
    // 就是「成功但查无此物」，smstask.status 现在登记为 C，但宽松分支对未登记接口同样适用）。
    // 规则行若写成「未登记一律 notFound:false」，Agent 会把真实的查无此物读成未判定。
    expect(rule, '未登记档必须按载荷载体分开：message 里的空 JSON 判、data/result 不判')
      .toMatch(/`message`[^。；]{0,80}(判|查无此物)[^。；]{0,120}(data|result)[^。；]{0,80}不判|按载荷载体/)
    // ⚠️ **CodeRabbit round 73（minor）**：开头句「判据是「形状已登记」+「载荷结构性为空」
    // 两条同时成立」把登记条件说成**无条件**，与同段「message 载体未登记也照判」直接矛盾——
    // 读者按开头句理解就排除掉 `{code:200,message:"[]"}` → notFound:true 这条实测行为。
    // 判据：开头句必须把登记条件**限定到 data/result 载体**，且写出 message 的例外。
    const head = rule.split('：·')[0]
    // 事故形态是**无条件**：「`not_found` 的判据是「形状已登记」+…」紧跟开头。
    // 判据钉这个形态（所以「限定到 data/result 载体后再写双条件」是允许的写法）。
    expect(head, '开头句不得把「形状已登记」写成无条件前提')
      .not.toMatch(/`not_found` 的判据是\*\*「形状已登记」/)
    expect(head, '开头句必须把登记条件限定到 data/result 载体，并点明 message 的空 JSON 例外')
      .toMatch(/data`\/`result`[\s\S]{0,120}(时，判据是|已登记)[\s\S]{0,200}message[\s\S]{0,120}(不要求登记|例外|照判)/)
    // 同一括号里我此前写「null 以前全是写接口」——源码注释明写 null 有两种含义，
    // 其中一类是**实测过但形状不在 A/B/C/D**（chat.queue.group.query / ipcc.customfield.template.get）。
    expect(rule, '不得再说 envelope:null 全是写接口').not.toMatch(/全是写接口/)
    // CHANGELOG 的当前段同样写过那两条错（它也是被 Agent 读的文本）。这里**只做正向**断言：
    // 反向的整段 not.toMatch 与「叙述里引用旧的错句」天然冲突（引用即红），而漂移风险
    // 集中在**契约面**（design.md 的规则行，Agent 照它分支），那段才是负向锚的对象。
    // ⚠️ 扫**全部版本段**而不是「当前版本段」（CodeRabbit round 77 minor）：这条是
    // 历史修正的「它在 CHANGELOG 里被记录过」检查——一旦发版切段，它还会被原样保留在
    // 旧版本段里，但 `currentChangelogSection` 不再包含它，守卫会因发版而假红。
    // 设计稿规则行本身的断言（上面那些）与版本段无关，保持不变。
    const cl = allVersionSections(read('CHANGELOG.md'))
    // 判据钉「按载体分档」这句本身 + 同段里的 message 照判语义（复合锚）：
    // 单 token `/载体/` 在 CHANGELOG 里被别的条目（多载体转义契约等）满足，等于白守。
    expect(cl, 'CHANGELOG 必须写明载体分档（message 判、data/result 不判）')
      .toMatch(/按载体分档[\s\S]{0,400}message/)
    expect(rule, '必须写明 null 的两种含义').toMatch(/从未实测[^。；]{0,120}(不在 A\/B\/C\/D|非标)/)
    expect(rule, 'D/M 例外档必须自带「不判」语义').toMatch(/(纯确认|形态漂移)[^。；]{0,120}不判/)
    // ⚠️段内复合锚（B4 变异实证）：全句只数 `/D-nf/` 的话，删掉「分别登记 D/D-nf」那处
    // 仍会被别处写到的 D-nf 满足——判据要钉在「分辨这两个接口」的那一档自己身上。
    expect(rule, '同报文两接口的分辨档必须点名 D-nf').toMatch(/无从分辨[^。；]{0,120}D-nf/)
    // 真驱动探针实测：M 的空 message、走到 C 却缺 message 的响应都是 **ok:false 失败响应**，
    // 压根不参与 not_found 判定。文档若只把它们与 D 的「成功但纯确认」并列成「不判」，
    // Agent 会把 not_found:false 读成「成功但没查到」——判据钉住「失败响应…不参与」。
    expect(rule, '必须写明 M 空 message / C 缺 message 是失败响应，不是「成功但不判」')
      .toMatch(/失败响应[^。；]{0,140}不参与/)
    // 双向自检：旧「一律」句必被判据①拒掉
    const ACCIDENT = '…`code:200` 且无数据字段的，一律当作 `not_found`，不当作成功。'
    expect(/无数据字段的，一律当作/.test(ACCIDENT), '事故行必被①抓红').toBe(true)
  })


  it('spec §2.4：win32 ACL 探测必须是封闭式受信状态清单（round 74/75/76 逐个堵漏后收敛）', () => {
    // 事故：探测判据写成「枚举现有 ACE 确认没有残留的显式广域主体」（Everyone /
    // BUILTIN\Users / Authenticated Users 枚举）。具名用户被 `icacls /grant:r *<SID>:(R)`
    // 显式授权、且无对应 deny ACE 时，黑名单漏判 → 报 `checked:true, ok:true`，而那个账户
    // 照样能读 appSecret —— 与 spec §2.1 自己定义的「凭证可被他人读却报成功」同类。
    // ⚠️ 负向锚钉「判据形态」而不是某一版排版：事故原句的粗体包住整段
    // （`**枚举现有 ACE 确认没有残留的显式广域主体**`），所以锚里不能带 `**`。
    const BLACKLIST = /确认没有残留的显式广域主体/
    const sp = read('docs/superpowers/specs/2026-11-22-剩余功能域对接封装-design.md')
    // ⚠️ 探测判据已从「一段话」长成「一个清单」（round 75/76 后是 7 条），按单行提取会
    // 只拿到第一行——判据必须取「真探测 ACL」到 §2.5 之间的整段（清单条目在其后各行）。
    const probeAt = sp.indexOf('真探测 ACL')
    const probeEnd = sp.indexOf('### 2.5', probeAt)
    expect(probeAt, '「真探测 ACL」锚必须在场').toBeGreaterThanOrEqual(0)
    expect(probeEnd, '探测段结束锚（### 2.5）必须在场且晚于起点').toBeGreaterThan(probeAt)
    const probe = sp.slice(probeAt, probeEnd)
    expect(probe, '探测判据不得写成广域主体黑名单').not.toMatch(BLACKLIST)
    expect(probe, '探测判据必须是最小允许名单（名单外一律拒绝，不是枚举广域主体）')
      .toMatch(/最小允许名单/)
    expect(probe, '「默认拒绝」必须落在句子里：出现任何其他主体的允许 ACE 即判不通过')
      .toMatch(/任何其他主体的允许 ACE 即判/)
    expect(probe, '必须点破漏判的具体形态：具名用户的显式授权（黑名单天然漏一族）')
      .toMatch(/具名用户[^。；]{0,60}(SID|显式授权)/)
    // 夹具清单里必须有这条判据的最小反例：写成黑名单的实现只有它必红。
    expect(sp, 'ACL 夹具必须含「另一个具名用户 SID 显式 Read」最小反例')
      .toMatch(/另一个具名用户 SID[\s\S]{0,120}(最小反例|只有这条会红)/)
    expect(sp, 'ACL 夹具必须含 null DACL 与空 DACL 两条空态（round 75）')
      .toMatch(/null DACL\*\*[\s\S]{0,160}空 DACL\*\*/)
    expect(sp, 'ACL 夹具必须含「外来属主」反例（round 76）')
      .toMatch(/另一个普通账户作属主[\s\S]{0,120}必须 `ok:false`/)
    expect(sp, '外来属主夹具必须点名夹具 8 为对照组（否则无法证明没有把好形态一起拒掉）')
      .toMatch(/夹具 8 是对照组/)
    expect(sp, 'ACL 夹具必须含「继承开启」反例（round 76）')
      .toMatch(/继承开启、当前 ACE 恰好只含受信主体/)
    expect(sp, 'ACL 夹具必须含「父目录对他人可写」反例（文件 ACL 再紧也能被换掉）')
      .toMatch(/父目录对另一个普通账户可写[\s\S]{0,80}必须 `ok:false`/)
    // ⚠️ **CodeRabbit round 93（major 1）**：夹具 13(b) 的合规判据不能是「文件被删 + 退出码非 0」
    // ——先写 secret 再清理也满足它。必须观测「写那步从未执行」（打桩计数 = 0 + 字节不落盘）。
    expect(sp, '夹具 13(b) 判据必须是「写 secret 那一步从未被执行」，不是删了就算合规')
      .toMatch(/判据不能是「文件被删且退出码非 0」[\s\S]{0,200}写入次数必须为 0/)
    // ⚠️ **CodeRabbit round 93（major 2）**：夹具 14 必须按 ② 的实现分档——.NET 独占挡得住替换，
    // 纯 Node 挡不住只能声明弱保证；不得再写成「替换总会成功、靠事后比对兜底」的单档旧形态。
    expect(sp, '夹具 14 必须分 .NET / 纯 Node 两档').toMatch(/FileShare\.None` 持有期间[\s\S]{0,300}纯 Node fd/)
    expect(sp, '夹具 14 的 .NET 档必须写「替换当场失败」').toMatch(/替换\*\*当场失败\*\*/)
    // ⚠️ **CodeRabbit round 75（major）**：「空名单」不等于「已保护」——null DACL 表示
    // 所有人完全访问，而它的 ACE 枚举同样是**空列表**，只按允许名单判会把最危险的形态
    // 判成 `checked:true, ok:true`。判据顺序必须是「先 DACL 存在/非空，再名单」。
    expect(probe, '必须先把 null DACL 判掉（空名单 ≠ 已保护）').toMatch(/null DACL/)
    expect(probe, '必须写明 null DACL 的语义是「所有人完全访问」，而不是「枚举结果为空」')
      .toMatch(/所有人[^。；]{0,20}完全访问|无访问控制/)
    expect(probe, '判据必须是封闭清单：任一条不满足即拒（不是逐个补黑名单）')
      .toMatch(/封闭清单|任一条不满足即/)
    expect(probe, '清单第 1/2 条必须是 DACL 存在 + 非空（按序号相邻）')
      .toMatch(/1\.\s*\*\*DACL 存在\*\*[\s\S]{0,200}2\.\s*\*\*DACL 非空\*\*/)
    expect(probe, '空 DACL（拒绝所有人）也必须判不通过，不得当成「收紧得好」')
      .toMatch(/空 DACL[^。；]{0,80}(ok:false|判不通过|拒)/)
    // ⚠️ **CodeRabbit round 76（major）**：属主隐含 WRITE_DAC —— 非受信账户作属主时
    // 可以随时给自己补读 ACE，ACE 名单永远看不出来。判据必须把属主也列入受信状态。
    expect(probe, '必须校验属主 SID（属主隐含 WRITE_DAC）').toMatch(/属主（owner SID）|属主\s*SID/)
    expect(probe, '必须点明属主可以自行补 ACE 的机制（WRITE_DAC）').toMatch(/WRITE_DAC/)
    expect(probe, '必须要求继承关闭（否则父目录一变就带进名单外 ACE）').toMatch(/继承关闭/)
    // 父目录：文件 ACL 再紧，父目录可写就能被整个换掉（与 POSIX 目录判据同构）。
    expect(probe, '父目录的**写面**必须受信（可被替换 = 文件 ACL 无意义），只读 ACE 不算')
      .toMatch(/父目录的写面受信/)
    // ⚠️ **CodeRabbit round 77（major）**：父目录判据必须**早于建 tmp** —— tmp 继承父目录 ACL，
    // 别人可在收紧前以共享读打开它，而**改 DACL 不撤销已打开句柄**，事后收紧救不回来。
    // 判据钉在写序里（⓪ 在最前），不是只钉「父目录要受信」这句话在场。
    // 写序在「真探测 ACL」之前，用 §2.4 整段（sp）而不是 probe 切片断言。
    const oa = sp.indexOf('2. **方案 A（以真机为闸')
    expect(oa, '§2.4 方案 A 的起点锚必须在场（否则 slice(-1,…) 静默扩大范围）')
      .toBeGreaterThanOrEqual(0)
    expect(oa, '方案 A 起点必须早于探测段').toBeLessThan(probeAt)
    const writeOrder = sp.slice(oa, probeAt)
    // ⚠️ 前缀陷阱（Codex round 21）：`indexOf('正确顺序：⓪')` 也会命中 `⓪′` —— 先断言
    // 写序里不存在带撇号的变体标记，否则序号判断会被前缀命中骗成假绿。
    expect(writeOrder, '写序不得残留 ⓪′ 一类带撇号变体标记').not.toMatch(/⓪[′'’]/)
    const i0 = writeOrder.indexOf('正确顺序：⓪')
    const i1 = writeOrder.indexOf('① **以受限安全描述符原子地创建空 tmp 并同时独占持有它**')
    expect(i0, '写序必须点名父目录校验（⓪）').toBeGreaterThanOrEqual(0)
    expect(i1, '写序必须保留「创建空 tmp」这一步（round 79 后必须带受限 SD 创建）').toBeGreaterThanOrEqual(0)
    expect(i0, '父目录校验必须排在「创建空 tmp」之前（顺序判据，不靠相邻字符数）').toBeLessThan(i1)
    expect(writeOrder, '必须点明「改 DACL 不撤销已打开句柄」这条机制')
      .toMatch(/不(会)?撤销已(打开|授予)的(句柄|访问)/)
    expect(writeOrder, '不可信目录必须「不建 tmp、不写 secret」，不是「先建再补救」')
      .toMatch(/不建 tmp、不写 secret/)
    // ⚠️ **CodeRabbit round 79**：「先建空 tmp 再 icacls」仍有句柄窗口——必须创建时刻就受限。
    expect(writeOrder, 'tmp 必须在创建时刻就带受限 SD（不能 writeFileSync 之后补 icacls）')
      .toMatch(/以受限安全描述符原子地创建空 tmp/)
    expect(writeOrder, '必须点明「只在打开时检查访问、改 DACL 不撤销已授予的访问」')
      .toMatch(/只在\*\*打开时\*\*检查访问|不撤销已授予的访问/)
    // 第十一轮后机制已实测：`FileStream` 七参重载在 PowerShell 5.1 可用（探针 25/27/29）。
    // 旧的「三种候选机制均未真机实测」是上一轮的真话、现在是假话，判据随之翻转：
    // 必须写明哪个已实测可用、哪个仍是未实测的备选。
    expect(writeOrder, '必须写明受限创建机制已实测可用')
      .toMatch(/已实测可用的是 .NET `FileStream` 七参重载|FileStream` 七参重载 \+ `FileSecurity`/)
    expect(writeOrder, 'P/Invoke 备选必须如实标为未实测')
      .toMatch(/等价备选但\*\*未实测\*\*/)
    // ⚠️ **CodeRabbit round 81（major）**：③ 必须写进 ① 拿到的同一个句柄 + 目录身份钉住——
    // 按路径重开 tmp 会被祖先目录替换劫持（TOCTOU），secret 进了攻击者可读的文件。
    // 复合锚（变异实证：「不得按路径重新打开」这句解释本身也带关键词，单用 /同一个句柄|不得按路径/
    // 会被它满足——删掉正向要求仍绿）。正向要求与解释必须分开钉。
    expect(writeOrder, '必须写明「写进创建时拿到的同一个句柄」这条正向要求')
      .toMatch(/必须写进 ① 创建时拿到的同一个句柄/)
    expect(writeOrder, '必须点破按路径重开的风险')
      .toMatch(/不得按路径重新打开/)
    expect(writeOrder, '必须钉住目录身份（句柄保持或 file ID 比对）')
      .toMatch(/目录身份|file ID/)
    // ⚠️ **Codex round 24**：句柄不带 `FILE_SHARE_DELETE` 才挡得住删除/改名——只写「持有句柄」不够。
    expect(writeOrder, '必须写明句柄不得带 FILE_SHARE_DELETE（否则挡不住删除/改名）')
      .toMatch(/不得带 `FILE_SHARE_DELETE`/)
    // 候选机制尚未实测必须如实标注（不能用未验证机制冒认已验）
    expect(probe, '取 SDDL 的机制未真机实测，必须写明').toMatch(/尚未真机实测|实测定稿前不/)
    // 双向自检：事故原句必被第一条判据拒掉（连粗体包裹的实际事故形态一起）
    expect(BLACKLIST.test('必须**枚举现有 ACE 确认没有残留的显式广域主体**（`*S-1-1-0` Everyone…）'),
      '事故原句必被抓红').toBe(true)
    expect(BLACKLIST.test('必须枚举现有 ACE，出现任何其他主体的允许 ACE 即判 ok:false'),
      '最小允许名单形态必须放过').toBe(false)
  })

  it('spec §2.4a：机制真机探针结果在场，且两条被推翻的机制不得再写成「待实测即可用」', () => {
    // 2026-11-24 真机探针（PowerShell 5.1）：FileSystem.AccessControl 加载不了、
    // File.Open 打不开目录——原设计的「创建时刻带受限 SD」「持有目录句柄钉身份」两条
    // 在最小依赖面下不成立。设计据此改成「父目录完全受信否则拒写」+「file ID 三次比对」。
    // 守卫：这两条验证结论必须在场；替换方案必须写清；「未实测」不得再被当作可用机制兜售。
    const sp = read('docs/superpowers/specs/2026-11-22-剩余功能域对接封装-design.md')
    // ⚠️ Codex round 28 P2：两个分界标题先断言存在、且结束晚于开始，再切片。
    // `indexOf` 找不到返回 -1，`slice(start, -1)` 会静默吞进几乎整份后续文档——
    // 删掉 §2.4b 标题连带其内容时本守卫不红，切片范围悄悄扩大（负向锚的对象也随之变多）。
    const a0 = sp.indexOf('### 2.4a')
    const b0 = sp.indexOf('### 2.4b')
    expect(a0, '§2.4a 标题必须在场').toBeGreaterThanOrEqual(0)
    expect(b0, '§2.4b 标题必须在场（否则切片边界失效）').toBeGreaterThan(a0)
    const sec = sp.slice(a0, b0)
    // 探针轮次是**活的**：每轮审查都可能加一轮。判据不能钉死某个数字（那正是「量化词不随
    // 实况同步」的形态本身），而要**从标题读出数字、再要求正文的枚举与它一致**。
    // 轮次用中文序数写，探针轮数会随审查增长：第十一轮之后「十一」是两个字符，
    // 单字正则读不出来（本轮把它读成 undefined 直接假红）。序数表与解析器同一处维护。
    const ORDINALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二', '十三', '十四', '十五']
    const title = sec.split('\n')[0]
    const claimed = /（2026-11-24，([一二三四五六七八九十]+)轮(?: \/ \d+ 个探针)?；/.exec(title)?.[1]
    expect(claimed, '标题必须写明探针轮次（中文数字）').toBeDefined()
    const n = ORDINALS.indexOf(claimed as string) + 1
    expect(n, '轮次数必须能在序数表里解析（≥3：本设计的探针至少跑了三轮）').toBeGreaterThanOrEqual(3)
    // 正文逐轮枚举必须覆盖到第 n 轮（第一…第 n），且不得少一轮
    for (let k = 1; k <= n; k++) {
      expect(sec, `正文必须逐轮枚举到第${k}轮`).toContain(`第${ORDINALS[k - 1]}轮`)
    }
    // 探针编号也不得与轮次混用（第四轮里的第 12 个探针写成「第十二探针」会被读成第五轮之后）
    expect(sec, '探针序号必须带轮次限定，不得裸写「第 N 探针」')
      .not.toMatch(/(?<![\d一二三四五六七八九十])第[一二三四五六七八九十]+探针/)
    // 探针编号同样不能钉死字面值：从标题读出总数，再要求正文引用到的**最大探针号等于它、且不越界**。
    const pc = /（2026-11-24，[一二三四五六七八九十]+轮 \/ (\d+) 个探针；/.exec(title)?.[1]
    expect(pc, '标题必须写明探针总数').toBeDefined()
    const total = Number(pc)
    const nums = [...sec.matchAll(/探针 (\d+)(?:[–-](\d+))?/g)]
      .flatMap((m) => [Number(m[1]), m[2] ? Number(m[2]) : Number(m[1])])
    expect(nums.length, '正文必须引用到具体探针号').toBeGreaterThan(0)
    expect(Math.max(...nums), '正文最大探针号必须等于标题总数').toBe(total)
    expect(Math.min(...nums), '探针号不得越界').toBeGreaterThanOrEqual(1)
    // 逐轮枚举的句子必须存在，且**正文出现的最大轮次必须等于标题轮次**：
    // 标题少报（正文已有第四轮却写「三轮」）与标题多报（写五轮而正文只到第四轮）都要红。
    expect(sec, '必须有逐轮起因的枚举句').toMatch(/轮由审查与自查推动|轮都由审查推动/)
    const mentioned = [...sec.matchAll(/第([一二三四五六七八九十]+)轮/g)]
      .map((m) => ORDINALS.indexOf(m[1] as string) + 1)
    expect(Math.max(...mentioned), '正文最大轮次必须与标题轮次一致')
      .toBe(n)
    // 第二轮探针推翻了第一轮结论：FileStream+FileSecurity 重载可用 —— 必须写明并声明撤回
    expect(sec, '必须写明 FileStream 构造重载可用（第一轮结论已撤回）')
      .toMatch(/FileStream\(path, FileMode, FileSystemRights,[\s\S]{0,80}FileSecurity\)/)
    expect(sec, '必须明确声明「只能引原生依赖」的旧结论被撤回')
      .toMatch(/错误并已撤回|已撤回/)
    expect(sec).toMatch(/File\]::Open[^。；]{0,60}打不开目录|FILE_FLAG_BACKUP_SEMANTICS/)
    // 空 DACL 造不出来 + null DACL 未经原生读回，两条都不得写成已验证
    expect(sec).toMatch(/空 DACL[^。；]{0,40}(不生效|造不出)/)
    expect(sec, 'null DACL 必须写明未经原生描述符读回').toMatch(/没有做原生描述符读回/)
    // 主路线（第十一轮，CR round 103 major 后）：**受限创建与独占持有是同一次调用** → 判 DACL
    // → 收紧 → 通过同一句柄写 secret。旧形态「先建空 tmp 再独占打开」已被真机证伪
    // （元数据句柄不与 FileShare.None 互斥），不能只写成「独占打开」这一步。
    expect(sec, '必须写明受限创建+独占持有是同一次调用（FileStream 七参重载）')
      .toMatch(/FileStream\(path, FileMode\.CreateNew,[\s\S]{0,160}FileShare\.None[\s\S]{0,120}fileSecurity/)
    expect(sec, '必须写明「不许拆成先建再打开两步」及其实证依据')
      .toMatch(/不许拆成「先建空文件、再打开它」两步[\s\S]{0,200}(WRITE_DAC|元数据)/
      )
    expect(sec, '必须写明这次修复针对的正是 CR round 103 的追问')
      .toMatch(/CR round 103/)
    // CR round 106：`.NET Framework` 的 `FileSystemRights` **没有** `ReadWrite` 成员——
    // 我上一版把它写进配方，照着实现编不过。守卫钉三件事：不许再出现该形式；
    // `Read | Write` 与实测掩码 `0x12019f` 必须在场；成员缺失这一事实要写明。
    expect(sec, '不得再写 `FileSystemRights::ReadWrite`（.NET Framework 无此成员，CR106）')
      .not.toMatch(/FileSystemRights::ReadWrite|FileSystemRights\.ReadWrite/)
    expect(sec, '必须写明 Read | Write 与实测掩码 0x12019f')
      .toMatch(/Read \| Write[\s\S]{0,160}0x12019f/)
    expect(sec, '必须写明 ReadWrite 成员不存在这一事实')
      .toMatch(/没有 `ReadWrite` 成员/)
    expect(sec, '必须写明独占句柄的第二个作用：钉住祖先目录，让 ③④ 的按路径判据可信')
      .toMatch(/钉住祖先目录[\s\S]{0,200}按路径[\s\S]{0,60}劫持/)
    // ⚠️ 这条守卫**原本钉的是第五轮那句收窄**（「失败 ⇒ 已有其他持有者」），而 CR round 96 minor 1
    // 证明**那句本身也是过度归因**——探针 17 分出三档，只有 `0x80070020` 支持「有持有者」。
    // 守卫落后于修正会把文档拖回旧错（本仓记过的「同一能力两条入口只修被点名那条」的测试版），
    // 所以判据换成三档分类：共享冲突 / 收紧把自己挡在门外 / tmp 已不在路径上，且禁止笼统归因。
    // 三档 HRESULT 必须都在场且按「共享冲突→收紧自挡→路径消失」的顺序出现（用 index 比序，
    // 不用固定字符窗——CJK 间距会变，钉死窗口下次同义改写就假红）。
    // ⚠️ 上一版这里钉的是「`FileStream + FileSecurity` 让 ①→② 窗口从源头不存在」的【已验证】/【推断】
    // 分级。**第十一轮把它升级了**：合并形态下 ①→② 之间根本没有窗口（创建与独占是同一次调用），
    // 探针 27 B 档、29 E 档在新形态上复核了「钉住祖先目录」与「数据读被拒」两项性质。
    // 但**有一半仍是推断**、必须在场且不得被写成已证实：「非受信账户从首次可见那一刻就打不开」
    // 是 SDDL 形态的直接推论，本轮没有用第二个 Windows 账户做过跨账户实测（本机只有一个可登账户）。
    expect(sec, '合并形态的实测事实必须写明：受限创建产物 SDDL 与两项性质')
      .toMatch(/受限创建与独占持有可以是一次调用[\s\S]{0,400}钉住祖先目录[\s\S]{0,200}数据读被拒/)
    expect(sec, '跨账户抢占仍是推断，必须如实标注（本机只有一个可登账户）')
      .toMatch(/跨账户(实测)?[\s\S]{0,120}(推断|未实测|没有)/)
    // 旧路线的窗口论证必须标为作废，不得继续当现行契约（否则实施者会按旧形态写两次调用）。
    expect(sec, '旧 ①→② 窗口的论证必须标为随旧路线作废')
      .toMatch(/随旧路线一起作废|随旧路线[\s\S]{0,20}作废/)
    const hrShare = sec.indexOf('0x80070020')
    const hrDeny = sec.indexOf('0x80070005')
    const hrMiss = sec.indexOf('0x80070002')
    expect(hrShare, '共享冲突档（0x80070020）必须在场').toBeGreaterThanOrEqual(0)
    expect(hrDeny, '收紧自挡档（0x80070005）必须在场').toBeGreaterThanOrEqual(0)
    expect(hrMiss, '路径消失档（0x80070002）必须在场').toBeGreaterThanOrEqual(0)
    expect(hrShare, '共享冲突档必须排在收紧自挡之前').toBeLessThan(hrDeny)
    expect(hrDeny, '收紧自挡档必须排在路径消失之前').toBeLessThan(hrMiss)
    // ⚠️ **CodeRabbit round 99（minor 1）**：`0x80070005` 的成因**不止收紧自挡**——路径是目录
    // （探针 17 的 D 档）也是同一个 HRESULT。一律报「收紧把我们挡在门外」会把
    // 「路径上落着别的东西」误诊成 ACL 问题。判据：必须写「先再检查一次才归因 ACL」。
    // 两条判据**各自独立**、各自窗口收紧：上一版把它们并成一条跨 240+160 字符的正则，
    // 变异只删「不止一种」时后半句仍在窗口内 → 守卫照样绿（半恒真）。
    const denyRegion = sec.slice(hrDeny, sec.indexOf('0x80070002', hrDeny) > hrDeny
      ? sec.indexOf('0x80070002', hrDeny) : hrDeny + 600)
    expect(denyRegion, '0x80070005 档必须明写成因不止一种')
      .toMatch(/成因[^。；]{0,10}不止一种/)
    expect(denyRegion, '归因「收紧失败」必须以再检查一次为前提，不得一律归因')
      .toMatch(/只有再用一次检查确认[\s\S]{0,60}才报「收紧失败」/)
    // ⚠️ **CodeRabbit round 97（两条）**：③ 必须把「属主校验」也跑上（否则攻击者预置「只授当前用户、
    // 但自己作属主」的 tmp 能过②③，靠隐含 WRITE_DAC 读走⑤ 的 secret）。
    // CR97 当时还派生了「失败档分档删除 / ③ 删前先关句柄」两条要求——**CR round 98 major 2 把整套
    // 删除语义合并掉**：失败路径**一律不删**（路径那一刻无法正名对象归属），所以那两条已作废，
    // 判据跟着翻转：③/⑥ 必须写「不删除任何东西」，且**不得**再出现派生的删除指令。
    expect(sec, '③ 必须执行属主校验（CR97 major）')
      .toMatch(/③[^。；]{0,80}(或属主不在受信集合|属主校验|owner SID[\s\S]{0,40}受信)/)
    const ownerIn3 = sec.search(/③[\s\S]{0,400}属主[\s\S]{0,120}(受信|WRITE_DAC)/)
    expect(ownerIn3, '③ 段落里必须点名属主与受信集合/WRITE_DAC').toBeGreaterThan(-1)
    const iWriteSecret = sec.indexOf('- ⑤ **通过 ② 拿到的句柄写 secret**')
    expect(iWriteSecret, '⑤ 必须在场').toBeGreaterThan(-1)
    expect(ownerIn3, '属主校验必须排在写 secret 之前').toBeLessThan(iWriteSecret)
    // 统一规则（CR98）：失败路径一律不删；探针 19/20 的删除档降为机制解释。
    expect(sec, '必须写明统一规则：失败路径一律不按路径删除/移动任何对象')
      .toMatch(/统一规则：失败路径一律不按路径删除\/移动任何对象/)
    expect(sec, '探针 19/20 的删除讨论必须标为「只作机制解释、不再派生实现要求」')
      .toMatch(/只作机制解释、不再派生实现要求/)
    expect(sec, '必须禁止把三档笼统归因成「已有其他持有者」')
      .toMatch(/不得共用一句「已有其他持有者」|三档[^。；]{0,40}各自点名真实成因/)
    expect(sec, '即使是共享冲突档也只能证明「有人持有」，不能推出「读过」')
      .toMatch(/不能\*\*推出「内容已被读过」\*\*|不能[^。；]{0,10}推出「内容已被读过」/)
    expect(sec, '必须写明纯 Node 的 fd 挡不住 rmdir、不满足本契约')
      .toMatch(/纯 Node 实现不满足本契约/)
    // ⚠️ **载体红线（第六轮探针 15–16，自查发现）**：②–⑤ 落到子进程后，secret 的交付载体
    // 是新的泄露面——Windows 上任何进程完整命令行对同机其他进程可读（WMI/wmic 双证）。
    // 判据：必须点名 argv 泄露、必须指定 stdin 为唯一合法载体、必须禁止环境变量/明文文件。
    expect(sec, '必须写明 argv 会被其他进程读到（探针 15 双机制实测）')
      .toMatch(/完整命令行对同机其他进程可读[\s\S]{0,120}(wmic|Win32_Process)/)
    // ⚠️ Codex round 28 P2：恢复基线里被替换掉的「DACL 自检在收紧与写 secret 之前」顺序判据
    // ——round 89/93 重写守卫时我只加了新锚，把这条旧锚删了（「同一能力两条入口只修被点名那条」
    // 的测试版）。删 ③ 行或把 ⑤ 挪到 ③ 之前，必须在这里变红。
    const i3 = sec.indexOf('- ③ 读 DACL')
    // 只在 ③ 自己地里找，避免命中 ②文「于是 ③④⑤」这类交叉引用。
    const i4b = sec.indexOf('- ④ `icacls', i3)
    const step3Region = sec.slice(i3, i4b > i3 ? i4b : i3 + 1200)
    const i4 = sec.indexOf('- ④ `icacls')
    const i5 = sec.indexOf('- ⑤ **通过 ② 拿到的句柄写 secret**')
    expect(i3, '③ DACL 自检步骤必须在场').toBeGreaterThanOrEqual(0)
    // ⚠️ **CR round 98 major 2推翻了 round 97 的「先关句柄再删除 tmp」**：失败路径统一
    // 「不删除任何东西」（路径那一刻无法正名对象归属）。守卫随之翻转：③ 必须写「不删除任何东西」，
    // 且**不得**再出现「再删除 tmp / 删除 tmp 并失败」这类删除动作——留着旧锚会把我正确的改动判红。
    expect(step3Region, '③ 必须自带「发现非受信 ACE/属主 → 不删除任何东西、非 0 退出」')
      .toMatch(/不删除任何东西[\s\S]{0,40}非 0 退出/)
    expect(step3Region, '③ 不得再要求删除 tmp（round 98 已取消该破坏性动作）')
      .not.toMatch(/再删除 tmp|删除 tmp 并失败|关闭 ② 的独占句柄、再删除/)
    expect(i4, '④ 收紧步骤必须在场').toBeGreaterThanOrEqual(0)
    expect(i5, '⑤ 写 secret 步骤必须在场').toBeGreaterThanOrEqual(0)
    expect(i3, 'DACL 自检必须排在收紧之前').toBeLessThan(i4)
    expect(i3, 'DACL 自检必须排在写 secret 之前').toBeLessThan(i5)
    // ⚠️ **CodeRabbit round 94（minor）**：只判 i3<i4 与 i3<i5 时，把 ⑤ 挪到 ③④ 之间两判据照样过
    // ——等于允许「收紧之前就写 secret」（泄露面本身）。收紧必须早于写入，这条要单独钉。
    expect(i4, 'icacls 收紧必须排在写 secret 之前').toBeLessThan(i5)
    // ⚠️ **CR round 95 major 曾要求「给 ⑥ 的删除动作配跨进程串行化」；CR round 98 major 2 连处置一起
    // 推翻**：路径式锁挡不住目录替换（A 在旧目录持锁、目录被换、B 在同一路径拿到新目录里的另一把锁），
    // 要锁有效得钉**目录对象**，纯 Node 拿不到。正解是**取消 ⑥ 对目标的破坏性动作**——竞态因
    // 「没有该动作」而消失，串行化前置随之作废。守卫随之翻转：⑥ 必须写「不删除/不改名移走目标」，
    // 且**不得**再把「串行化覆盖删除」当作现行契约（历史叙述里可提，但要有「作废/推翻」字样）。
    expect(sec, '⑥ 必须规定「不一致也不碰目标」：响亮失败 + 不删除/不改名移走目标')
      .toMatch(/绝不删除、也绝不改名移走|不碰目标|不动目标/)
    expect(sec, '串行化前置必须标明已被 round 98 推翻/作废，不能仍当现行要求')
      .toMatch(/(串行化(前置要求)?(随之)?作废|round 98[^。；]{0,30}推翻[^。；]{0,40}锁方案|锁方案[^。；]{0,20}推翻)/)
    // CR95 minor 的归因纠正（「删除竞态是新动作引入、不是老 bug」）仍然成立，保留。
    expect(sec, 'CR95 归因必须写准：删除竞态是 ⑥ 清理动作引入，不是现存老 bug')
      .toMatch(/不是今天就有|⑥ 这条[^。；]{0,20}新清理动作引入|删除竞态不是今天就有/)
    // ⚠️ **CodeRabbit round 95（minor）**：比对只能发现**持续到比对点**的替换；
    // 「换了又换回」的介入式替换检测不到、可与成功共存。旧措辞「绝不报成功」是过度承诺，
    // 必须收回。负向锚钉**断言句完整形态**（「发现并清除它、且绝不报成功」），不锚裸短语——
    // 因为禁止句自身也含「绝不报成功」，裸锚会把自己判红（注释里反例的既有形态）。
    expect(sec, '不得再断言「复核发现一切替换/发现并清除它、且绝不报成功」').not.toMatch(/发现并清除它、且绝不报成功|发现一切替换/)
    expect(sec, '必须写明介入式换了又换回的替换不可检测、可与成功共存')
      .toMatch(/换了又换回[\s\S]{0,60}(检测不到|不可检测)/)
    // ⚠️ **CodeRabbit round 94（minor 2）**：我曾把探针 14 的 error 87 归因成「该结构要卷内相对名」，
    // 官方文档却明确 FileName 接受绝对路径 —— 那是**编出来的 API 约束**，会把实施者引向不存在的要求。
    // 撤回必须在场：既保留实验结果（失败、未跑通），也必须标「成因未定位」并点破旧归因是错的。
    expect(sec, '必须写明按句柄换名「调用成功但目标按路径不可见」，即窗口未闭合')
      .toMatch(/返回成功、[\s\S]{0,40}目标文件按路径始终不可见|目标按路径(始终)?不可见/)
    // ⚠️ **探针 14c 把我上一版的「成因未定位」也推翻了**：真因是信息类号写错
    // （`FileRenameInfo` = 3，不是 10/11）。所以判据要从「标为未定位」改成「成因已查明且写明是类号」——
    // 留着旧锚等于逼文档写一句过时的「未定位」，正是本 PR 一路在防的失同步。
    expect(sec, 'error 87 的成因必须写明「信息类号传错（FileRenameInfo=3）」')
      .toMatch(/FileRenameInfo = 3|(FileRenameInfo[^。；]{0,20})?不是 10\/11/)
    expect(sec, '不得再把旧归因「卷内相对名」当成事实保留，必须标为编造/已核实为错')
      .toMatch(/「该结构要卷内相对名」[\s\S]{0,80}(编造|那是错的|核实[^。；]{0,30}接受绝对路径)/)
    expect(sec, '必须点破「要卷内相对名」这个旧归因是错的')
      .toMatch(/「该结构要卷内相对名」[\s\S]{0,120}(那是编造的|那是错的|编造的)/)
    // ⚠️ **第七轮自查**：独占句柄只活在打开它的进程里——「一步一个子进程」会在步间关闭句柄，
    // 祖先目录钉住随之消失，父进程也没有 fd 可 fstat，只能退回按路径查（正是会被替换劫持的那侧）。
    // 这条硬约束若不钉住，实现大概率每步 spawn 一次，看似每步都执行、实际防线在进程边界断开。
    // 第十一轮把 ① 与旧 ② 合成一次调用，硬约束的编号随之变成 ①–⑥（叙事面与规范面都要认）。
    expect(sec, '必须写明「①–⑥ 在同一个长驻子进程内连续完成」这条硬约束')
      .toMatch(/硬约束：[①②]–⑥[\s\S]{0,60}同一个长驻子进程/)
    expect(sec, '必须点明两个后果：句柄随进程关闭 + 父进程没有 fd')
      .toMatch(/独占句柄只存在于[\s\S]{0,200}父进程里根本没有那个 fd|步一个子进程[\s\S]{0,200}关闭句柄/)
    expect(sec, '必须规定 secret 只能经 stdin 交付子进程')
      .toMatch(/secret 只能经 stdin 交给那个 PowerShell 子进程|stdin 进、结构结果出，argv 只带路径/)
    expect(sec, '必须把环境变量 / 临时明文文件一起禁止').toMatch(/环境变量[^。；]{0,40}(明文文件|同样不许)/)
    // ⚠️ 这条守卫原钉「创建/打开失败 ⇒ 有人已持有句柄」。**第十一轮把它翻转了**：
    // 合并形态用 CreateNew，路径已存在是 `0x80070050`（不是共享冲突），「有人持有」这一档
    // 在该形态下不可达；旧断言必须标为作废，不得继续当现行契约。新判据：
    // ① 共享冲突档要写明「合并形态下不可达」；② 「已存在」必须单独成档、不得归进「有人持有」。
    expect(sec, '共享冲突档必须写明在主路线下不可达')
      .toMatch(/0x80070020[\s\S]{0,200}(合并形态下这一档不可达|在该形态下不可达)/)
    expect(sec, '「文件已存在」必须是单独一档，且不得归进「有人持有」')
      .toMatch(/0x80070050`?（文件已存在）[\s\S]{0,160}不等于「有人持有」/)
    expect(sec, 'secret 必须写进同一个独占句柄，不得按路径重开')
      .toMatch(/通过 ② 拿到的句柄写 secret[\s\S]{0,40}不许按路径重开/)
    // Node 的 fs 在 Windows 给不出独占打开 —— 这条边界必须写明（否则实施者会写出假保护）
    expect(sec, '必须写明 Node fs 无法独占打开、需要 PowerShell/P-Invoke')
      .toMatch(/libuv[\s\S]{0,80}FILE_SHARE|Node 的 `fs` 在 Windows 上给不出独占打开/)
    expect(sec, '纯 Node 路线不得声称已保护，必须标为弱保证').toMatch(/不得声称已保护|弱保证/)
    // 两个残余窗口各自「里面是什么内容」必须写明，否则「有窗口」会被读成「必然泄露」。
    // ⚠️ 第十一轮后 ①→② 窗口在合并形态下**不存在**——守卫不能继续要求它「是空的」，
    // 而要要求文档**说清楚它已消失**（否则读者会以为还剩一个窗口）。
    expect(sec, '必须点名 ①→② 窗口在合并形态下不存在')
      .toMatch(/①→② 之间：合并形态下这个窗口不存在|①→② 之间[\s\S]{0,40}窗口不存在/)
    expect(sec, '⑥ 关句柄→换名窗口必须写明依赖 ④ 收紧已生效')
      .toMatch(/⑥ 关句柄→换名之间[\s\S]{0,160}已收紧/)
    expect(sec).toMatch(/父目录受信/)
    // round 87：null DACL 与显式 Everyone ACE 是两条判据；文件身份校验是必需项
    expect(sec, '必须区分 null DACL 与显式 Everyone ACE 两条判据').toMatch(/不是同一条判据/)
    // round 89/93：⑥ 的守卫序列 —— 换名前比身份、换名后复核、不一致删目标并响亮失败、残余如实声明。
    // 判据按**语义要素各自在场且顺序正确**，不钉具体措辞（钉字句=下次同义改写必假红）。
    const i6 = sec.indexOf('- ⑥')
    expect(i6, '⑥ 步骤必须在场').toBeGreaterThanOrEqual(0)
    const iResidual = sec.indexOf('残余（如实声明', i6)
    expect(iResidual, '⑥ 之后必须有「残余（如实声明…）」段作为切片边界').toBeGreaterThan(i6)
    const step6 = sec.slice(i6, iResidual)
    const iPre = step6.indexOf('比对 `ino`/`dev`')
    const iRen = step6.indexOf('renameSync')
    const iPost = step6.indexOf('复核')
    expect(iPre, '⑥ 必须有换名前的身份比对').toBeGreaterThanOrEqual(0)
    expect(iRen, '⑥必须有换名步骤').toBeGreaterThanOrEqual(0)
    expect(iPost, '⑥ 必须有换名后的目标复核').toBeGreaterThanOrEqual(0)
    expect(iPre, '身份比对必须在 renameSync 之前').toBeLessThan(iRen)
    expect(iPost, '复核必须在 renameSync 之后').toBeGreaterThan(iRen)
    // ⚠️ CR93 时代这里要求「不一致 → 删除该目标文件」；**CR round 98 major 2 取消了这个破坏性动作**
    // （不一致时无法区分攻击者冒充文件与并发写者 B 刚验收的合法配置，删/移都会毁掉 B 的成果；
    // 而路径式锁又挡不住目录替换）。判据跟着翻转：⑥ 必须写「绝不删除、也绝不改名移走目标」，
    // 且**不得**再出现「删除该目标文件」——留着旧锚会把 CR98 的正确修法判红。
    expect(step6, '⑥ 复核不一致必须响亮失败且**不碰目标**')
      .toMatch(/响亮失败[\s\S]{0,60}绝不删除、也绝不改名移走/)
    expect(step6, '⑥ 不得再要求删除目标文件（CR98 已取消）').not.toMatch(/删除该目标文件/)
    expect(sec, '残余窗口必须如实声明、不得写成已彻底防御')
      .toMatch(/残余（如实声明[\s\S]{0,400}(完全消除|已彻底防御)/)
    // ⚠️ **CR round 99/100 + Codex round 33：这道「删除语义」防线的四轮加固史**
    // 九轮：只扫 ③/⑥ 切片 → CR99 指出切片外有现行指令。十轮：改正则扫整段 → CR100 指出
    // 「动词无宾语」「失败路径整行豁免」两个假阴性。再改「有限禁止串清单」→ Codex33 用变异
    // 证明两处仍然漏：**① 清单里是我凭记忆写的近似串**（`发现并清除冒充文件`），而历史真实句是
    // `发现并清除**持续到复核点**的冒充文件`，`includes` 匹配不到 → 假护栏；**② 扫描窗在 §2.4b 就断**，
    // 把 §2.5 夹具与 §2.4 方案A 正文（「任一步失败就删除 tmp」这条真实活句就在正文里）排除在外。
    // 所以这道防线现在是：窗覆盖到 `## 6.`（含方案A正文/§2.4a/§2.4b/§2.5，仍排除 §6.x 历史引用区）、
    // 串全部**取自 git 历史逐字**、并加**结构性范围自检**（证明窗真的含夹具与正文，不是又退回切片）。
    const histStart = sp.indexOf('## 6.')
    const secStart = sp.indexOf('### 2.4 修法')
    expect(secStart, '§2.4 修法起点必须在场').toBeGreaterThanOrEqual(0)
    expect(histStart, '§6 历史区起点必须在场（扫描窗右界）').toBeGreaterThan(secStart)
    const normativeAll = sp.slice(secStart, histStart)
    expect(normativeAll, '统一规则本句必须在规范区内')
      .toMatch(/失败路径一律不按路径删除\/移动任何对象/)
    // 结构性范围自检（P2#2 的根治：证明窗真的够宽，**用标题级结构锚，不用内容句**——
    // 第一版这里钉的是夹具 13(b) 的现行措辞 `拒绝退出（不删任何东西）`，变异能红但红在
    // 自检本身；那意味着将来 0.2.4 合法改写那句会把整道防线误报成回归。结构锚不随改写漂移。)
    expect(normativeAll, '扫描窗必须含 §2.5 夹具清单的标题（P2#2 漏的正是这块）')
      .toMatch(/ACL 夹具清单/)
    expect(normativeAll, '扫描窗必须含 §2.4 方案A 正文的标记（活句曾住在正文里）')
      .toMatch(/方案 A（以真机为闸/)
    // ⚠️ **这道防线的形态：封闭允许清单（不再是禁止清单，也不再做否定判定）。**
    // 前四轮都是枚举「已知回归句」当禁止串，每轮都被指出漏了某句历史原句（CR 99/100、Codex 33、Codex 35）：
    // 黑名单天然漏一族——这正是本 spec 给 ACL 判据定过的原则（逐轮补黑名单说明方向本身会漏，
    // 判据要收敛成封闭清单）。第五轮改成「允许清单 + 否定豁免」，CR 107 又证明豁免判据也漏：
    // `复核不一致就删除目标` 的动词前 6 字是「不一致就」，被当成否定而放过。
    // 所以现在**不做任何否定判定**：规范区里每一句提到「删除/清除/清理/移走/清扫/删掉」的话，
    // 无论肯否，都必须登记在这份清单里；不在 = 红。否定句也在清单里——它们本来就该被看到。
    // 句子切分见下：**换行先按块合并（空行或列表标记起新块），再按 。；切句**——
    // CR 107 指出按 \n 直接切会把换行折断的句子劈成碎片（「都能搬走/删掉」单独一片），
    // 文档没改却被判红。合并规则与「排版不影响判定」这条声明一致。
    // 代价（如实声明，实测过边界）：改这 40 句里任何一句的**文字**都会红，须回来确认它仍不是
    // 现行删除指令并更新清单；纯排版（`**`/反引号/空白/续行换行）不会红（比对前归一化，M16 实证）。
    // 这是有意的取舍：假阳性可见、成本一次性；假阴性会让「失败路径一律不删」被悄悄推翻。
    const ALLOWED_DELETE_MENTIONS = [
      '**目录身份必须先钉住**：打开 `qiyu` 目录的句柄并保持到 ④ 完成（Windows 上持有目录句柄可阻止其被删除/改名——**前提是打开时不得带 `FILE_SHARE_DELETE`**：共享标志里给了删除共享，别人照样能删/改名，句柄形同虚设',
      '**任一步失败的处理一律走 §2.4a 的统一规则，且按 secret 是否已写分两臂**（本例编号 ③（= §2.4a 的 ⑤）写 secret 之前的失败 → 非 0 退出、**不写 secret**、不删除也不移动任何对象',
      '③ 之后（本例 ④ = §2.4a 的 ⑥）的失败发生在 secret 已写之后 → 非 0 退出、**如实报告含 secret 的残留路径**、同样不删除也不移动任何对象',
      '此处原写「就删除 tmp 且不换入」是收敛前的旧语义，与统一规则矛盾，Codex round 33 P2 指出后改掉',
      '**⑤ 写 secret 之前**（⓪–④ 任一步失败）：secret 从未写出，**写入次数为 0**、非 0 退出、不删除也不移动',
      '同样**不删除也不移动任何对象**（「能正名」这个删除先决条件在这一臂同样不成立）',
      '那个具名用户即使在别处有 deny ACE 也按「先判 allow 名单」处理——宁可误报要求人工 `icacls` 清理，也不放过',
      '**父目录的写面受信**（不是「所有 ACE 都受信」）：非受信账户对目录没有任何**写类**权限（创建/删除子项、`WRITE_DAC`、改属主）——否则别人可以**整个换掉**这个文件',
      '探针 14 独立复现 `rmdir` 被挡），而 **Node 的 fd 不能**（libuv 带删除共享）',
      '第八轮（CR 94/95/96，探针 14b–14d、17）把 error 87 查到**信息类号**级（真因是类号写错， 修正后仍闭合不了⑥ 窗口），并收回两处过度声明（并发删除竞态、检测范围全称承诺）， 再把独占打开失败按异常类型分成三档',
      '删除时机——他人不含删除共享时 删不掉、自己持有时也要先关句柄才删得掉）',
      '第十轮（CR 98/99/100，无新实验）把九轮累积下来的**互相打架的删除语义收敛成一条统一规则**：失败路径一律 不按路径删除/移动任何对象——路径那一刻无法正名「这是我的对象」（② 失败没有句柄、③ 要删就得先丢句柄、 ⑥ 不一致时可能是并发写者刚验收的配置），于是 CR 95「给删除配串行化」与 CR 97「删除分档/先关句柄再删」 **都作为派生要求作废**，只留机制解释',
      '`DELETE` 缺席不影响   ⑥ 的 `renameSync`（换名要的是父目录上的删除子项权，不是文件自身的 `DELETE`，探针 31 A 档实测换名成功）',
      '**统一规则：失败路径一律不按路径删除/移动任何对象**（CR round 98 major 2 把 round 97的   「清理能力分档」进一步合并掉——分档讨论的前提是「有该删的」，而正名问题让「该删」无法安全判定）：   ② 失败时我们**没有句柄**、③ 失败时若先关句柄再删，删除发生在**已放弃唯一正名手段之后**——   路径那一刻是谁的对象**无从证明**（并发写者/攻击者的同名对象都可能在场）',
      '是否清扫、何时清扫**留给 0.2.4 设计并写明判据**——两个坑先列全：① 崩在 ⑤ 之后的 tmp   **含 secret**，「只扫空文件」恰好漏掉最该清的',
      '②并发 login 的 tmp 名含 `pid`+时间戳，   撞名极罕见，但无脑清扫仍会踩到别人正在写的对象',
      '原「三档删除能力」的分档（探针 19）在取消删除动作后**只作机制解释、不再派生实现要求**：   持有方不给删除共享时，按路径的删除与改名都会被 `0x80070020` 拒绝（`DeleteFile`/改名同报错，   微软 DeleteFile 文档明写「被以不含删除共享的方式打开时删除失败」）',
      '另两档   （收紧自挡 `0x80070005`、路径消失 `0x80070002`）没有并发持有者，删除技术上可行——   **但本契约不要求谁去删它**',
      '③ 读 DACL（同一个路径，此时无人能打开它）：出现任何非受信主体的允许 ACE，**或属主不在受信集合**   → 关闭句柄、**不删除任何东西**、非 0 退出（留下空 tmp，见上统一规则）',
      '`FileDispositionInfo`（随句柄标记删除、不必先关）   本次调用方式不对（PS 强转失败）**未验证**，不得当替代方案',
      '不满足即**关句柄、不删除任何东西**、非 0 退出、写入次数为 0   （动作与上文「统一规则」一致——我在 CR97 那一版此处误写成「删除 tmp」，CR 98 取消删除动作时漏改）',
      '不一致 → **响亮失败（不报 `configured:true`），但绝不删除、也绝不改名移走   目标文件**',
      '**⑥ 失败时「不动目标」是硬规定，取代我前两版「删除 / 隔离目标 + 跨进程串行化」**（CodeRabbit   round 98 major 2 推翻 round 95我加的锁方案）：复核见到身份不一致时，当前 `config.json` 可能是   ①攻击者留下的冒充文件，也可能是**并发写者 B 刚 `renameSync` 进去的合法新配置**——A **无从区分**，   任何「删掉/改名移走」都会毁掉 B 的成果',
      '**所以取消这个破坏性   动作本身**，比给它配一整套原生依赖锁更简单、可验证、且 round 95 的并发删除竞态**以「没有该动作」关闭**',
      '**前置失败（②/③）同样不删**（见上统一规则）：② 失败没有句柄、③ 要删就得先丢句柄——都不具备   「正名后删除」的条件（空 tmp 的清扫策略见上文统一规则末尾——**留给 0.2.4 设计**，本轮不定）',
      '**CR 95 指出的删除竞态不是今天就有、而是⑥ 这条「不一致就删目标」的新清理动作引入的**：   一旦加了删目标的失败清理，没串行化时 A 就会删掉 B 刚验收的配置',
      '我上一轮的处置是「给删除动作配跨进程串行化」——**本轮（CR 98 major 2）连处置一起推翻**：   路径式锁挡不住目录替换，正确做法是**取消⑥ 对目标的破坏性动作**（见上「不动目标」硬规定），   竞态因「没有该动作」而消失，串行化前置要求也随之作废',
      '同一版还说可发现者「可清除」——**「清除」也收回**，   因为 ⑥ 已规定不动目标（CR 98 major 2），发现后的动作是**报错 + 保留现场**，不是清理',
      '残余（如实声明，别写成「已彻底防御」）：目录钉住靠 ① 创建时拿到的独占句柄，**换名必须先关句柄**（实测   `FileShare.None` 持有期间 rename 被拒），所以「关句柄 →换名」之间窗口重新打开：第三方读该路径   可能读到**冒充文件**（完整性面，不含 secret——我们的 secret 始终在已删除/待换入的原对象里）',
      '⑥ 的事后复核能发现**持续到复核点**的冒充文件、     对它**响亮失败且不碰目标**（第十轮起不再「清除」——那一刻分不清攻击者文件与并发写者合法配置）     （**换了又换回的介入式替换仍检测不到**——见 ⑥ 的 CR 95/96 注，别把这句读回全称承诺）',
      '这条窗口依赖 ④ 的读回确认必须成功——**读回不通过就不换名、直接失败退出**（tmp 按统一规则   **不删除**，留空文件待 0.2.4 的清扫策略处理',
      '我上一版这里写「删除 tmp」，是第十轮 grep 窗口   只覆盖写序段、漏了这段所致——CR round 99 minor 2）',
      '**Node 的句柄挡不住祖先目录被删**：libuv 打开文件带 `FILE_SHARE_READ|WRITE|DELETE`，实测「兄弟钉住」   （在 `qiyu` 里开一个 `pin.lock` 不放）**并不能**阻止 `qiyu` 被删除',
      '.NET 侧 `FileShare.Delete` 的   组合也挡不住删除那一侧',
      '**更强的一点（同轮探针 11）**：Node 持 fd 期间，**对方连我们这个文件本身都能搬走/删掉**   （`move` 与 `rmdir /s` 都返回成功）——共享位是 per-handle 且 libuv 给了 delete 共享，   所以「持有句柄」在纯 Node 下**不带来任何排他性**，只有 `.NET FileShare`不含读写时才能挡住   **读取**（同轮探针 6：READER BLOCKED），仍挡不住删除',
      '**文件本身干净、但父目录对另一个普通账户可写** → 必须 `ok:false`——对方可以删掉再重建，文件 ACL 再紧也没用（与 POSIX 目录判据同构）',
      '判据不能是「文件被删且退出码非 0」         （删除可能发生在写入之后，CodeRabbit round 93',
      '且**删除本身在持有者不含删除共享时会失败**，         CodeRabbit round 97——见探针 19），必须是**观测「写 secret 那一步从未被执行」**         ——测试对写入函数打桩计数：任一前置检查失败时写入次数必须为 0，且 secret 字节不出现在任何文件',
      '**不删除是规定动作，不是失败降级**',
      '**不可逆性**：注册表无任何 ticket 删除接口——create 出的工单无法通过 API 清除，是一次写就永久污染租户的对象级不可逆',
    ]
    const normSent = (x: string) => x.replace(/\*\*/g, '').replace(/`/g, '').replace(/\s+/g, '')
    const allowed = new Set(ALLOWED_DELETE_MENTIONS.map(normSent))
    const DELETE_VERB = /(删除|清除|清理|移走|清扫|删掉)/
    // 块边界 = 空行 或 列表/编号/⚠️ 起始行；块内换行是续行，合并成一个空格。
    const splitBlocks = (text: string) => {
      const blocks: string[] = []
      let cur: string[] = []
      for (const line of text.split('\n')) {
        const startsList = /^\s*(?:[-·]|⚠️|⚠|\d+\.)\s/.test(line)
        if (!line.trim() || startsList) {
          if (cur.length) { blocks.push(cur.join(' ')); cur = [] }
          if (!line.trim()) continue
          cur = [line]
        } else { cur.push(line) }
      }
      if (cur.length) blocks.push(cur.join(' '))
      return blocks
    }
    // Codex round 36 P2：动词判定必须跑在**归一化之后**的文本上。`删\n除` 经续行合并成「删 除」，
    // 旧判据在归一化前测动词，把这种句子整句过滤掉 = 绕过允许清单（历史指令这样折行就漏检）。
    // 旧的长度下限 `>= 4` 是同类漏洞：短句（`删掉。` 归一化后 2 字）也会被静默丢弃，
    // 与「每句提到动词的话都必须登记」这条契约矛盾，一并去掉——判据只做一件事：
    // 归一化后含动词的句子全部进入 offenders/允许清单比对。
    const sentencesOf = (text: string) =>
      splitBlocks(text)
        .map((b) => b.replace(/^\s*(?:[-·]|⚠️|⚠|\d+\.)\s*/, ''))
        .flatMap((b) => b.split(/[。；]/))
        .map((s) => s.trim())
    const deleteSentences = (text: string) => sentencesOf(text).filter((s) => DELETE_VERB.test(normSent(s)))
    const offenders = deleteSentences(normativeAll).filter((x) => !allowed.has(normSent(x)))
    expect(offenders, `规范区出现允许清单外的删除/清除句（先确认它不是现行指令，再登记）：\n${offenders.join('\n')}`)
      .toEqual([])
    expect(ALLOWED_DELETE_MENTIONS.length, '允许清单不得被清空（清空后上一条会恒真）')
      .toBeGreaterThanOrEqual(30)
    // 判据自带五条最小反例（CR round 107 的三个假绿/假红形态 + Codex 36 的两条逃逸形态），都直接跑同一条流水线：
    // ① `复核不一致就删除目标。` —— 动词前是「不一致就」，旧版把它当否定豁免（CR107 minor 3）；
    // ② `不删除目标文件。` —— 否定式但**仍是**一句删除指令的存在性提示，旧版豁免、新版必须拦（不豁免肯否）；
    // ③ 把一句登记过的长句在字中间折断 —— 旧版按 \n 切句会劈出碎片判红（CR107 minor 1），新版必须放过。
    const pipeline = (text: string) => deleteSentences(text).filter((x) => !allowed.has(normSent(x)))
    expect(pipeline('复核不一致就删除目标。'), 'CR107-3：否定词在别的短语里不得豁免删除指令').not.toEqual([])
    expect(pipeline('不删除目标文件。'), '否定式删除句也须登记，不得被豁免').not.toEqual([])
    const wrapped = ALLOWED_DELETE_MENTIONS.find((x) => x.includes('搬走/删掉')) as string
    const broken = wrapped.replace('都能搬走', '都能\n搬走')
    expect(pipeline(broken), 'CR107-1：续行换行不得让已登记的句子被判红').toEqual([])
    // ④/⑤ 是 Codex round 36 的漏洞形态：判据在归一化**前**做判断（先测动词、先卡长度），
    // 折行或短句就整句逃出清单。两条都必须被拦，否则「每句提到动词的话都要登记」不成立。
    expect(pipeline('不满足即删\n除 tmp、非 0 退出、写入次数为 0。'),
      'Codex36：动词被换行折断不得绕过允许清单').not.toEqual([])
    expect(pipeline('删掉。'), '短句没有长度豁免，同样必须登记').not.toEqual([])
    // ⚠️ **CR round 108 minor：失败语义必须分两臂，不许写成全称。**
    // 旧版在 §2.4 方案 A 与统一规则里都写「任一步失败…不写 secret」，而 ⑤ 写完 secret 之后 ⑥ 才失败时
    // secret 已经落盘——同一份文档另一处（残余窗口）自己也承认这一点，属「同一契约两套话」。
    // 判据三条，都钉在 **§2.4a 权威区**（不收 §6.x 历史区满足）：
    // ① 全称句若同时含「任一步失败」与「不写 secret」，必须带分臂限定词（之前/之后/两臂）；
    // ② ⑤ 之后那一臂必须写明 secret 可能已落盘；③ 必须要求报告「含 secret 的残留路径」。
    const sec24a = sp.slice(sp.indexOf('### 2.4a'), sp.indexOf('### 2.4b'))
    expect(sec24a.length, '§2.4a 切片必须非空（锚缺失时下面三条会假绿）').toBeGreaterThan(1000)
    const normA = normSent(sec24a)
    expect(normA, 'CR108：⑤ 之后的失败必须写明 secret 可能已落盘').toContain('secret可能已落盘')
    expect(normA, 'CR108：⑤ 之后的失败必须要求报告含 secret 的残留路径').toContain('含secret的残留路径')
    // ① 全称句的判据扫**整个规范窗**（不只 §2.4a）：CR 108 指出的原句住在 §2.4 方案 A 里，
    //    只扫 §2.4a 会让「回到全称」这条回归一路绿灯（我第一版就是这么写的，变异 N1 实测没红）。
    const blanketOf = (text: string) => sentencesOf(text)
      .map(normSent)
      .filter((t) => t.includes('任一步失败') && t.includes('不写secret') && !/(之前|之后|两臂)/.test(t))
    // 两条内置反例：证明判据活着，且不误伤带分臂限定的正确写法（不依赖改 spec 才能自证）。
    expect(blanketOf('**任一步失败的处理一律走 §2.4a 的统一规则**（不写 secret、非 0 退出、不删除也不移动任何对象。'),
      'CR108 反例：全称句必须被这条判据抓住').not.toEqual([])
    expect(blanketOf('**任一步失败的处理一律走 §2.4a 的统一规则，且按 secret 是否已写分两臂**（⑤ 写 secret 之前的失败不写 secret。'),
      'CR108 反例：带分臂限定词的句子不得误伤').toEqual([])
    expect(blanketOf(normativeAll), '规范区不得出现「任一步失败…不写 secret」的全称句（⑤ 之后 secret 已落盘）')
      .toEqual([])
    // 非空转证明分两层，都**不依赖任何现行句、0.2.4 怎么改写都不会假红**：
    // ① 窗的边界：secStart/histStart 都是**结构标题**（§6.x 历史引用区在 histStart 之后，天然被切掉）；
    // ② 窗的覆盖：上面两条 `扫描窗必须含…标题` 断言已证明窗真伸到夹具区与方案A正文——
    //    若哪天切片又被写窄到漏掉某区，是这两条先红，而不是靠再注入一个样本自己测自己
    //    （前三版这里都是用注入样本证明「流水线活着」，结果每一版都新造了一种假红：替换目标句
    //    被合法改写 → replace 空操作 → 注入不落地 → 自检假红；Codex 变异测出。改为「边界+覆盖」两条
    //    结构锚即可，注入自检是多余的。）。
    // 边界如实：这道防线挡得住**已知真实句复发**与**切片再次写窄**，挡不住全新改写；
    // 文本扫描的天花板在此，可执行的正/负断言留给 0.2.4 实现测试。
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

/**
 * CHANGELOG 的「声明 N 处 ↔ 实际 N 条」一致性守卫（CodeRabbit PR #68 第七轮 minor）。
 *
 * 修复批的标题写「的九处契约修正」，正文用 `  · ` 逐条列出 —— 两个数一旦分叉，
 * 读者无法判断「是漏写了某条，还是标题没跟着加」。这不是假想：2026-11-04/05 的三批
 * 里有**三批**在收敛轮次补充条目后忘了改标题（查询/存储/元数据批、同步与调度批、
 * 注册表批），都是 CodeRabbit / Codex 逐轮点名才发现的。
 *
 * 判据只覆盖标题形如「…的<数字>处契约修正…」的条目：这类条目的约定就是「一条一 bullet」。
 * 其它条目（如「另外两个载体 + 一处文案分档」）的 N 指代子集，不能套用 —— 如实记录边界。
 */
/**
 * 中文数词 → 整数（支持「十/百」的组合，如 十三 / 二十 / 二十一 / 一百零五）。
 *
 * ⚠️ 不能用枚举表（Codex PR #68 第八轮 P3）：表写到「二十」就停，将来出现
 * 「二十一处契约修正」时查表得到 `undefined`，即使 bullet 数刚好对上也红。
 */
const CN_DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
}
const CN_UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }
const CN_SECTIONS: Record<string, number> = { 万: 1e4, 亿: 1e8 }
function cnNumber(raw: string): number {
  if (/^\d+$/.test(raw)) return Number(raw)
  let total = 0
  let section = 0
  let cur = 0
  for (const ch of raw) {
    const d = CN_DIGITS[ch]
    if (d !== undefined) { cur = d; continue }
    const u = CN_UNITS[ch]
    if (u !== undefined) { section += (cur === 0 ? 1 : cur) * u; cur = 0; continue }
    const sec = CN_SECTIONS[ch]
    if (sec !== undefined) { total += (section + cur) * sec; section = 0; cur = 0; continue }
    return Number.NaN
  }
  return total + section + cur
}

/**
 * 扫描 CHANGELOG 里「…的<N>处契约修正…」条目，返回「声明数 ≠ bullet 数」的描述。
 *
 * ⚠️ **不枚举数词字符**（Codex PR #68 第八/九/十/十一轮连续四轮都打在这里）：只要判据是
 * 「在标题里找一个数词字符类」，就得穷举所有字形 —— 漏了「百/零」会把「一百零五」截成
 * 「五」，补上之后又漏繁体「兩」把「兩百零五」截成「百零五」。枚举没有终点。
 *
 * 改成**结构**判据：取标题里「的」与「处契约修正」之间的**整段 token**（不含空白），
 * 原样交给 `cnNumber`。认不出的字形一律 `NaN` → 进 `badTitle` 报红 —— 拒绝猜一个更小的数。
 * 覆盖范围由「所有含 `处契约修正` 的条目标题都必须被解析成功」这条断言兜住
 *（`checked === entries`），所以「标题换个形态导致守卫静默跳过」也会红。
 */
function changelogCountMismatches(md: string): {
  bad: string[]; checked: number; entries: number; badTitle: string[]
} {
  const lines = md.split('\n')
  const bad: string[] = []
  const badTitle: string[] = []
  let checked = 0
  let entries = 0
  for (let i = 0; i < lines.length; i++) {
    // ⚠️ 条目按**顶层列表项**识别，不是按「粗体标题」（Codex PR #68 第十二轮 P2）：
    // 以 `^\*\*` 为门槛时，标题一旦少个 `**`，这条就被静默跳过 —— `entries` 与
    // `checked` 同步漏掉它，`entries === checked` 反而成立。
    const item = /^- (.*)$/.exec(lines[i]!)
    if (item === null) continue
    const itemText = item[1]!
    if (!itemText.includes('处契约修正')) continue
    entries++
    // 标题文本优先取粗体内部；没有粗体就用整行 —— 只影响取词位置，不影响「被统计到」。
    const title = /^\*\*(.+?)\*\*/.exec(itemText)?.[1] ?? itemText
    // 数词取「的」与「处契约修正」之间不含空白的整段：`的十三处契约修正` → `十三`
    const declared = /的([^\s]*?)处契约修正/.exec(title)
    const raw = declared?.[1]
    const n = raw === undefined || raw === '' ? Number.NaN : cnNumber(raw)
    if (Number.isNaN(n)) badTitle.push(itemText)
    let bullets = 0
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j]!
      if (l.startsWith('- ') || l.startsWith('## ') || l.startsWith('### ')) break
      if (l.startsWith('  · ')) bullets++
    }
    checked++
    if (!Number.isNaN(n) && n !== bullets) {
      bad.push(`${itemText.slice(0, 40)}… 声明 ${n} / 实际 ${bullets}`)
    }
  }
  return { bad, checked, entries, badTitle }
}

describe('README 的 --profile 建议必须按命令能力限定（Codex PR #69 第五轮）', () => {
  it('不得再写「在每条命令上写 --profile」；必须点名不接受它的命令族', () => {
    const s = read('README.md')
    // 事故形态：api call / auth whoami / sync tasks 都不接受 --profile（实测退 2），
    // 「每条命令上写 --profile」对它们是做不到的动作。
    expect(s, '旧的无条件建议不得回归').not.toContain('所以要么在每条命令上')
    expect(s).toContain('不接受 `--profile` 的命令')
    for (const fam of ['`api *`', '`auth whoami`', '`sync tasks`']) {
      expect(s, `必须点名 ${fam}`).toContain(fam)
    }
    // 正向：接受它的命令族也要点名（否则用户不知道哪些能写 flag）
    expect(s).toContain('接受 `--profile` 的命令')
    // ⚠️ `sync uninstall` 不接受 `--profile`（实测退 2）——它曾被错列进接受清单，
    // 照文档执行必然失败。断言它只出现在「不接受」那一条里。
    const accepting = s.split('\n').find((l) => l.includes('接受 `--profile` 的命令')) ?? ''
    expect(accepting).toContain('sync run|status|verify|install')
    expect(accepting, 'uninstall 不接受 --profile，不得列进接受清单').not.toContain('uninstall')
  })
})

describe('CHANGELOG 声明计数与条目数一致（PR #68 第七轮）', () => {
  it('「N 处契约修正」批的 bullet 数 == 标题里的 N', () => {
    const { bad, checked, entries, badTitle } = changelogCountMismatches(read('CHANGELOG.md'))
    expect(badTitle, '标题里的数词解析不了').toEqual([])
    expect(checked, '一个「N 处契约修正」条目都没找到 = 守卫空转').toBeGreaterThan(0)
    expect(checked, '有「处契约修正」条目没走到计数校验 = 守卫静默跳过').toBe(entries)
    expect(bad).toEqual([])
  })

  it('反例集：扫描路径按标题里的**完整**数词校验（一百零五不能被截成五）', () => {
    // 解析器自检
    expect([cnNumber('九'), cnNumber('十三'), cnNumber('二十'), cnNumber('二十一'),
      cnNumber('一百零五'), cnNumber('一千零五'), cnNumber('一万零五'), cnNumber('21')])
      .toEqual([9, 13, 20, 21, 105, 1005, 10005, 21])
    // 扫描路径自检：必须从**整串**数词取值，而不是从中间的「五」
    const block = (n: number): string => '- **某某的一百零五处契约修正**：\n'
      + Array.from({ length: n }, () => '  · x\n').join('')
    expect(changelogCountMismatches(block(105)).bad, '105 条应对上').toEqual([])
    // 最小反例：只有 5 条时，若标题被截成「五」就恰好相等而**漏报** —— 这里必须报
    expect(changelogCountMismatches(block(5)).bad).toEqual([
      expect.stringContaining('声明 105 / 实际 5'),
    ])
    // 同理覆盖「二十一」「二十」这类两位数
    const block21 = (n: number): string => '- **某某的二十一处契约修正**：\n'
      + Array.from({ length: n }, () => '  · y\n').join('')
    expect(changelogCountMismatches(block21(21)).bad).toEqual([])
    expect(changelogCountMismatches(block21(2)).bad).toEqual([
      expect.stringContaining('声明 21 / 实际 2'),
    ])
    // 千位形态：`一千零五` 绝不能被截成后缀 `零五` 按 5 校验（Codex 第十轮 P2 的最小反例）
    const block1005 = (n: number): string => '- **某某的一千零五处契约修正**：\n'
      + Array.from({ length: n }, () => '  · z\n').join('')
    expect(changelogCountMismatches(block1005(1005)).bad).toEqual([])
    expect(changelogCountMismatches(block1005(5)).bad).toEqual([
      expect.stringContaining('声明 1005 / 实际 5'),
    ])
    // ⚠️ 判据不再枚举字形（Codex 第十一轮 P2）：繁体 `兩百零五` 也必须整段取到、判 NaN 报红，
    // 而不是从 `百零五` 起匹配、按 105 校验后静默放行。用「105 条 bullet」构造最小反例 ——
    // 一旦退化成后缀匹配，声明值与 bullet 数恰好相等，`bad` 会空、这条断言就红。
    const block205 = (title: string, n: number): string => `- **某某的${title}处契约修正**：\n`
      + Array.from({ length: n }, () => '  · w\n').join('')
    const trad = changelogCountMismatches(block205('兩百零五', 105))
    expect(trad.bad, '繁体数词不得被截成后缀后静默放行').toEqual([])
    expect(trad.badTitle.length, '繁体数词必须进 badTitle（拒绝猜）').toBe(1)
    // 同样覆盖解析器不认的简体字形（「两」）
    expect(changelogCountMismatches(block205('两', 2)).badTitle.length).toBe(1)
    // 反向：搞错数量的标题必须被抓住（真值 3 写成 4）
    expect(changelogCountMismatches(block205('四', 3)).bad).toEqual([
      expect.stringContaining('声明 4 / 实际 3'),
    ])
    // 没有「的<数词>」形态的标题也不许静默跳过：进 badTitle，且 entries 与 checked 都算到它
    const noNumeral = changelogCountMismatches('- **某某处契约修正**：\n  · a\n')
    expect([noNumeral.entries, noNumeral.checked, noNumeral.badTitle.length]).toEqual([1, 1, 1])
    // 标题**没有粗体**也照样被统计与校验（Codex 第十二轮 P2：以 `**` 为门槛会静默跳过）
    const noBold = changelogCountMismatches('- 某某的四处契约修正：\n  · a\n  · b\n  · c\n')
    expect([noBold.entries, noBold.checked, noBold.badTitle.length]).toEqual([1, 1, 0])
    expect(noBold.bad).toEqual([expect.stringContaining('声明 4 / 实际 3')])
  })
})

describe('历史 spec 的陈旧「未实现」声明必须有状态注（2026-11-19 审计）', () => {
  // 背景：`docs/superpowers/specs/2026-10-10-请求构建与body校验-design.md` 是**最后一份**
  // 既无状态注、也未被任何测试读取的 spec —— 它的 §三 次序表里还写着
  // 「`--pretty` → 2（尚未实现）」，而 `--pretty` 自 2026-10-24 就实现了
  // （实测 `api schema <id> --pretty` 退出 0、输出缩进 JSON）。
  // 危害是具体的：实施者或 Agent 照这份 spec 办事，会把一个能用的 flag 当成必然报错。
  //
  // 判据不锚行号、锚**语义块**：状态注那条引用块必须点名「`--pretty` 已实现」与
  // 「`auth login` 已实现」两件事 —— 单纯出现「状态注」三个字不算（别的 spec 也有）。
  const SPEC = 'docs/superpowers/specs/2026-10-10-请求构建与body校验-design.md'
  /** 取文件开头连续的 `>` 引用块（状态注就贴在那里）。 */
  function headerQuotes(md: string): string {
    const out: string[] = []
    for (const line of md.split('\n')) {
      if (line.startsWith('>')) out.push(line)
      else if (out.length > 0) break
    }
    return out.join('\n')
  }
  /** 陈旧声明本身：允许它保留（原文 + 就地作废标注），但**不得**以未标注的形态出现。 */
  function stalePrettyClaims(md: string): string[] {
    return md.split('\n').filter((l) => /--pretty`?\s*→\s*2/.test(l) && !/作废|已实现/.test(l))
  }

  it('状态注在场，且点名 `--pretty` 与 `auth login` 两处已被推翻的判断', () => {
    const block = headerQuotes(read(SPEC))
    expect(block, '文首必须有状态注引用块').toMatch(/状态注/)
    expect(block, '状态注必须点名 --pretty 已实现（否则陈旧次序表仍会被当真）')
      .toMatch(/`--pretty` 已于 \*\*2026-10-24\*\* 实现/)
    expect(block, '状态注必须点名 auth login 已实现（它是「不可修类 2」举例的失效前提）')
      .toMatch(/`auth login` 已于 \*\*2026-10-25\*\* 实现/)
    expect(block, '状态注必须给出当前口径（缩写 0 的缩进 JSON），不能只说「已作废」')
      .toMatch(/`api schema <id> --pretty`[\s\S]{0,40}→ 0/)
  })

  it('双向自检：事故原文必红、合法形态放过', () => {
    const good = read(SPEC)
    expect(stalePrettyClaims(good), '真实文件里的陈旧行必须已带作废标注').toEqual([])
    // ① 事故原文（2026-11-19 审计时真实存在的那一行）→ 必须被抓住
    expect(stalePrettyClaims('5. --pretty → 2（尚未实现，同 list/callOne）'))
      .toHaveLength(1)
    // ② 只写「已作废」不算数 —— 标注必须与「已实现」同在一行或就近可辨；这里钉住
    //    带作废标注的合法形态被放过（否则守卫会逼人删掉原文，而原文是历史记录）
    expect(stalePrettyClaims('5. ~~--pretty → 2（尚未实现）~~ **已作废（2026-10-24）**'))
      .toEqual([])
    // ③ 出现 `--pretty → 2` 但是别的命令自己的口径（不是本条）同样按陈旧声明的判据抓 ——
    //    这条如实记录判据边界：它是**文本**判据，不认识命令上下文；真出现时要么补标注、
    //    要么改措辞（本仓对「判据按文本表述」的边界一贯如实记录）
    expect(stalePrettyClaims('`query --table … --pretty` → 2')).toHaveLength(1)
  })

  it('反向：状态注被删掉时必须变红（不是恒真守卫）', () => {
    const md = read(SPEC)
    // 状态注是一整段以 `> **⚠️ 本 spec 是 2026-10-10 的历史记录` 开头的引用块；
    // 把它连同同一块里的所有 `>` 行一起删掉，才算「状态注被删掉」。
    const lines = md.split('\n')
    const blockLine = lines.findIndex((l) => /^>\s*\*\*⚠️ 本 spec 是 2026-10-10 的历史记录/.test(l))
    expect(blockLine, '前提：状态注首行必须存在').toBeGreaterThan(-1)
    const end = lines.findIndex((l, i) => i > blockLine && !l.startsWith('>'))
    const blockEnd = end === -1 ? lines.length : end
    const strippedLines = lines.filter((_, i) => i < blockLine || i >= blockEnd).join('\n')
    expect(strippedLines, '前提：删掉后确实找不到状态注内容').not.toMatch(/10-10 的历史记录（2026-11-19 状态注）/)
    // 用同一判据复查：整块删掉后，剩余引用块不再满足「点名两件事」
    const block = headerQuotes(strippedLines)
    expect(/`--pretty` 已于 \*\*2026-10-24\*\* 实现/.test(block)
      && /`auth login` 已于 \*\*2026-10-25\*\* 实现/.test(block), '删掉状态注后判据必须失败').toBe(false)
  })
})
