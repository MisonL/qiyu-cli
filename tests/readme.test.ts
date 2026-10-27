import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (rel: string) => readFileSync(fileURLToPath(new URL(`../${rel}`, import.meta.url)), 'utf8')

describe('联动文案（B 上线后不得与事实相反）', () => {
  it('README 成功信封不得声称「三个键恒在」—— meta 是条件键（2026-10-26 实测证伪）', () => {
    const md = read('README.md')
    // 旧声明「三个键恒在」与实现相反：`ok()` 在没有任何元数据时**故意不输出 meta**
    // （`tests/output.test.ts`「未提供 meta 时不输出该键」把它钉成契约）。
    // 实测（skill 已装、无提示）：`--version`、`store init/status`、`skill where` 的成功
    // 输出只有 `{ok,data}`；`query`/`db`/`api`/`stats`/`skill check` 才带 meta。
    // 2026-10-27 起 `sync tasks/status/run/verify` 也带 `meta.field_notes`（状态位图例），
    // 因此不再是无 meta 的例子。`SKILL.md` 早就写对了（「部分命令附带 `"meta"`」），
    // README 是唯一说反的地方。
    // 若要恢复「恒在」，必须先让 `ok()` 恒输出 meta 并同步那条 output.test.ts 的钉子 ——
    // 否则这句承诺会让 Agent 对每条成功输出都去读一个可能不存在的键。
    expect(md, '「三个键恒在」与实现相反；meta 只在有内容时出现').not.toMatch(/三个键恒在/)
    expect(md).toMatch(/`meta` \*\*不是恒在的\*\*/)
    expect(md, '必须给出可操作的读法，而不是只删掉旧句').toMatch(/读 `meta` 前先判存在/)
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
    // 横幅是引用块（行首 `> `）——锚到行首，避免命中 README:139 正文（否则横幅不改也绿）
    expect(md).toMatch(/^> .*已实现.*通用 API 通道.*API 参数校验/m)
    expect(md).toMatch(/^qiyu api call <id> \[--body <JSON>\] \[--yes\] \[--no-validate\] \[--strict\]/m)
    expect(md).toMatch(/^qiyu api schema <id>/m)
    // 段级两向：新事实必须进「已实现」段、旧 bullet 必须从「尚未实现」段移除（spec §八之二 ⑯）
    const impl = md.slice(md.indexOf('**已实现**'), md.indexOf('**尚未实现**'))
    expect(impl).toMatch(/参数校验|api schema/)
    expect(md.slice(md.indexOf('**尚未实现**'))).not.toMatch(/请求参数校验：/)
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
