import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

describe('联动文案（B 上线后不得与事实相反）', () => {
  it('README 成功信封不得声称「三个键恒在」—— meta 是条件键（2026-10-26 实测证伪）', () => {
    const md = read('README.md')
    // 旧声明「三个键恒在」与实现相反：`ok()` 在没有任何元数据时**故意不输出 meta**
    // （`tests/output.test.ts`「未提供 meta 时不输出该键」把它钉成契约）。
    // ⚠️ 2026-10-28 再修正：README 曾拿 `api call` 当「只有 {ok,data}」的例子 —— 而它
    // **恒带 `meta.endpoint`**，全仓也没有任何命令真的输出无 meta 的成功信封。现在的
    // 说法是「实现上每条成功命令都至少带 meta，但读之前仍要判存在」—— 前半句是实况、
    // 后半句是契约（`ok()` 的条件键行为没变，将来可能有命令不带）。
    // 若要恢复「恒在」，必须先让 `ok()` 恒输出 meta 并同步那条 output.test.ts 的钉子 ——
    // 否则这句承诺会让 Agent 对每条成功输出都去读一个可能不存在的键。
    expect(md, '「三个键恒在」与实现相反；meta 只在有内容时出现').not.toMatch(/三个键恒在/)
    // README 按行宽折行 —— 短语断言先压空白（本仓库踩过两次的坑）。
    const flat = md.replace(/\s+/g, '')
    expect(flat, '必须点明 meta 是条件键').toContain('`meta`是**条件键**')
    expect(flat, '必须给出可操作的读法，而不是只删掉旧句').toContain('读`meta`前仍要先判存在')
    expect(md, '不得再把 api call 说成无 meta 的例子').not.toMatch(/无提示时的 `api call`/)
  })
  it('验收 23：README 含新事实、不含旧表述、保留「响应体不做校验」', () => {
    const md = read('README.md')
    expect(md).not.toMatch(/不做字段校验|无法校验/)
    expect(md).toMatch(/响应体不做校验/)
    expect(md).toMatch(/不要删字段/)               // ⑰ strict 误拒指引
    expect(md).not.toMatch(/第一个子项目/)          // ⑯ 改为「前 N 个子项目」随交付推进
    // E 交付后由「前两个」改「前五个」，F 交付后再改「前六个」（同一审查结论：该句
    // 曾是不实声明且被本文件当正锚钉死——所以每交付一个子项目就要同步推进）。
    expect(md).toMatch(/前六个子项目/)
    expect(md).not.toMatch(/前五个子项目/)
    expect(md).toMatch(/--no-validate/)            // 命令一览补 flag
  })
  it('验收 23：README 安全段不再无条件说「绝不发出任何请求，直接返回退出码 4」', () => {
    const md = read('README.md')
    expect(md, 'body 合法 → 4').toMatch(/body 合法则返回退出码 4/)
    expect(md, 'body 缺必填/非对象 → 先报 2').toMatch(/body 缺必填\/非对象则.*2/)
  })
  it('验收 23：退出码表 2 行不再无条件是「改参数重来」', () => {
    const md = read('README.md')
    // ⚠️ 放宽以容忍改法里 --strict 被反引号包裹（`` `--strict` 误拒除外 ``）——钉语义而非字面
    expect(md).toMatch(/--strict`?\s*误拒除外/)
  })
  it('验收 23：README:120 退出码 4 行点明「写接口仍需显式确认」', () => {
    const md = read('README.md')
    expect(md).toMatch(/需要 `--yes`（写接口仍需显式确认）/)
  })
  it('验收 23/32：横幅句、命令一览、已实现清单钉到各自行（非全仓泛匹配）', () => {
    const md = read('README.md')
    // 横幅是引用块（行首 `> `）——锚到行首，避免命中正文（否则横幅不改也绿）。
    // ⚠️ 2026-10-30：横幅重写时把「已实现」改成了「已交付」（原句"本仓库仍在早期：已实现…"
    // 与「当前状态」段矛盾已被删）。断言钉的是"横幅点名了 通用 API 通道 + API 参数校验"这个
    // 事实，不是具体动词 —— 故两者都接受。
    expect(md).toMatch(/^> .*(?:已实现|已交付).*通用 API 通道.*API 参数校验/m)
    expect(md).toMatch(/^qiyu api call <id> \[--body <JSON>\] \[--yes\] \[--no-validate\] \[--strict\]/m)
    expect(md).toMatch(/^qiyu api schema <id>/m)
    // 「已实现」段：新事实（参数校验 / api schema）必须落在其中。
    // ⚠️ 2026-10-30 修假护栏：旧写法 `md.slice(indexOf('**已实现**'), indexOf('**尚未实现**'))`
    // 在「尚未实现」段被删后 end=-1，切片退化成"到倒数第一个字符"；下一步
    // `md.slice(indexOf('**尚未实现**'))` = `md.slice(-1)` 只查最后一个字符 —— 断言恒真。
    // 改为按「当前状态」小节标题（下一个 `## `）切片，并把"旧 bullet 不得残留"改为全文否定。
    const implStart = md.indexOf('**已实现**')
    expect(implStart, '「已实现」段必须存在').toBeGreaterThanOrEqual(0)
    const nextHeading = md.indexOf('\n## ', implStart)
    const impl = md.slice(implStart, nextHeading === -1 ? undefined : nextHeading)
    expect(impl).toMatch(/参数校验|api schema/)
    // 旧 bullet「请求参数校验：」是"未实现"清单里的条目；六个子项目交付后它不得在任何处残留
    expect(md, '旧的未实现 bullet 不得残留').not.toMatch(/请求参数校验：/)
    // spec ⑰：strict 误拒口径必须写明「严格」或「参数表闭集」
    expect(md).toMatch(/严格|参数表闭集/)
  })
  it('验收 23：registry.test.ts 不再含旧措辞（四处全文件扫描）', () => {
    const t = read('tests/core/registry.test.ts')
    expect(t).not.toMatch(/逃生舱透传 body/)
    expect(t).not.toMatch(/逃生舱不校验 body/)
    expect(t).not.toMatch(/本计划没有请求构建器/)
  })
  it('验收 32：api.ts / cli.ts 的子命令与 flag 清单已补（旧文本不在、新文本在）', () => {
    // spec §九 验收 32：断言**不再**出现只列 `list|call` 的旧文本（源码文本，README 侧断言覆盖不到）
    const apiSrc = read('src/commands/api.ts')
    expect(apiSrc).not.toMatch(/用法：qiyu api <list\|call> \[/)  // 旧用法行（`:78`）
    expect(apiSrc).toMatch(/<list\|call\|schema>/)
    expect(apiSrc).toMatch(/可用子命令：list、call、schema/)
    expect(apiSrc).toMatch(/可用：--body <JSON>、--yes、--no-validate、--strict/)
    const cliSrc = read('src/cli.ts')
    expect(cliSrc).toMatch(/api call <id> \[--body <JSON>\] \[--yes\] \[--no-validate\] \[--strict\]/)
    expect(cliSrc).toMatch(/api schema <id>/)
  })
  it('验收 33：路线图条目 7/条目 4 标记关闭（保留原文 + ~~ + ✅）', () => {
    const rm = read('docs/superpowers/specs/2026-10-09-后续交付路线图-design.md')
    // ⚠️ 必须锚定条目号：裸 `~~…params…~~…✅` 会被**既有的** :36（A 的 `~~EndpointSpec 缺 params…~~`）
    //    与 :89 的 `~~A~~ ✅` 跨行串成假命中——条目 7 一字不改该断言也绿。
    expect(rm).toMatch(/^7\..*~~[^~]*params[^~]*~~[^\n]*✅/m)
    expect(rm).toMatch(/^4\..*~~[^~]*B vs A\/E[^~]*~~[^\n]*✅/m)
  })
  it('验收 35：CHANGELOG 版本区含 api schema', async () => {
    const cl = read('CHANGELOG.md')
    // ⚠️ 口径与 `tests/docs.test.ts` 的 `allVersionSections` 一致：取**全部版本段**
    //    （到文件末尾的 `[x]: https://…` 链接引用块为止）。
    //    为什么不钉「当前版本段」：正常发版会把条目留在已发布的那一段，钉当前段等于
    //    每次发版都要改这条断言（0.2.1 切段时实测过，6 条同类断言集体误红）。
    //    为什么不干脆全文匹配：链接引用块与文件头也可能出现同样的词，那会让断言
    //    在条目被删掉后仍然绿。
    const versionAreaStart = cl.search(/^## \[/m)
    const linkBlock = cl.search(/^\[[^\]]+\]:\s+https?:/m)
    expect(versionAreaStart, 'CHANGELOG 必须有版本段').toBeGreaterThanOrEqual(0)
    const section = cl.slice(versionAreaStart, linkBlock === -1 ? undefined : linkBlock)
    expect(section).toContain('api schema')
  })
})
