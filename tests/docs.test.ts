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
  it('路线图锚定：四个分点各自出现 C1 改文关键词（I 组 M7：§2.3 两处 / §六.2 / §八.2 / §五.2）', () => {
    const s = read('docs/superpowers/specs/2026-10-09-后续交付路线图-design.md')
    // 按行号切片断言（行号以 spec §8.3 列的为准；若文档行漂移，实施者先对行号）
    const lines = s.split('\n')
    const sliceAround = (n: number, span = 6): string => lines.slice(Math.max(0, n - span), n + span).join('\n')
    expect(sliceAround(38)).toMatch(/store init/)     // §2.3 第一处
    expect(sliceAround(40)).toMatch(/store status/)   // §2.3 第二处
    expect(sliceAround(143)).toMatch(/DuckDB|store/)  // §六.2
    expect(sliceAround(160)).toMatch(/store status|describe/)  // §八.2
  })
  it('设计稿锚定：§9.5 与 §11.2 两处都含 C1 交付标注（L 组 H3：spec §8.3 第 12 处要求两处都改，只锚 §11.2 会漏改 §9.5）', () => {
    const s = read('docs/qiyu-cli-design.md')
    const lines = s.split('\n')
    // §11.2 错误处理表（锚点 :1759）
    expect(lines.slice(1759 - 8, 1759 + 8).join('\n')).toMatch(/C1|存储层/)
    // §9.5 同步引擎一节：全文件内两处 C1 阶段标注（§9.5 锚点行实施者按 §9.5 标题定位，
    // 此处用「至少两处 C1 标注」的结构性断言兜底，防止只改一半）
    const marks = s.match(/C1 阶段|C1 交付|C1：已交付/g) ?? []
    expect(marks.length).toBeGreaterThanOrEqual(2)
  })
})
