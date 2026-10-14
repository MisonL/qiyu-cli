import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const read = (p: string): string => readFileSync(join(root, p), 'utf8')

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
  it('CHANGELOG [未发布] 段内含 store 条目（断言限定在该段 + 收紧锚，O 组 O-13）', () => {
    const md = read('CHANGELOG.md')
    const unreleased = /## \[未发布\][\s\S]*?(?=\n## |$)/.exec(md)?.[0] ?? ''
    expect(unreleased.length).toBeGreaterThan(0)   // [未发布] 段必须存在
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
  it('README 配置说明：手工编辑 + 凭证不支持写入（spec §3.2 边界）', () => {
    const md = read('README.md')
    expect(md).toMatch(/手工编辑/)
    expect(md).toMatch(/不支持.*写入|写入.*不支持/)
    // 权限警告说明（O 组 O-14）：stderr 警告不阻断，需向 Agent 说明
    expect(md).toMatch(/权限过宽.*警告|警告.*不阻断/)
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
  it('README 横幅与「尚未实现」清单已更新（I 组 M7：§8.3 第 5 处）', () => {
    const md = read('README.md')
    expect(md).toMatch(/store init\/status 已可用|存储.*已交付/)
    // 尚未实现清单：查询/同步类仍在「尚未实现」段，store 不在其中
    const notYet = /尚未实现[\s\S]*?(?=\n## |$)/.exec(md)?.[0] ?? ''
    expect(notYet).not.toMatch(/store init/)
  })
  it('readme.test.ts 原有「前两个子项目」断言仍绿（第 11 处不动裁决的正向锚，I 组 L8）', () => {
    expect(read('README.md')).toMatch(/前两个子项目/)
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
  it('设计稿锚定：§11.2 错误处理表与全文两处 C1 阶段标注都在（L 组 H3；L3 修：按行内容锚定）', () => {
    const s = read('docs/qiyu-cli-design.md')
    // §11.2 错误处理表的 store_locked 行：表行锚定 + 行内含 C1 阶段标注
    const lockedRow = lineWith(s, /\| `store_locked` \|/)
    expect(lockedRow).toMatch(/C1 阶段/)
    // §9.5 同步引擎一节：全文件内两处 C1 阶段标注（§11.2 一处 + §9.5 一处），
    // 结构性断言兜底防止只改一半。
    const marks = s.match(/C1 阶段|C1 交付|C1：已交付/g) ?? []
    expect(marks.length).toBeGreaterThanOrEqual(2)
  })
})
