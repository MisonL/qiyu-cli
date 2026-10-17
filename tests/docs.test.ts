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
  it('README 横幅与「尚未实现」清单：同步已交付、查询仍未实现', () => {
    const md = read('README.md')
    expect(md).toMatch(/同步.*已交付|已交付.*同步/)
    const notYet = /\*\*尚未实现\*\*（调用时[\s\S]*?(?=\n## |$)/.exec(md)?.[0] ?? ''
    expect(notYet).not.toMatch(/sync run/)
    expect(notYet).toMatch(/query/)
  })
  it('README 依赖分述：sync 零常规运行时依赖（fflate 只在 devDependencies，仅测试夹具用）', () => {
    const md = read('README.md')
    expect(md).toMatch(/零常规运行时依赖/)
    expect(md).toMatch(/DecompressionStream/)
    expect(md).toMatch(/devDependencies/)
    // 旧口径（「唯一引入常规依赖」）不得残留 —— 声明与实际依赖位置必须一致
    expect(md).not.toMatch(/唯一引入常规依赖/)
  })
  it('CHANGELOG [未发布] 段内含 sync 命令与 fflate 条目（反引号命令形态，防误命中）', () => {
    const md = read('CHANGELOG.md')
    const unreleased = /## \[未发布\][\s\S]*?(?=\n## |$)/.exec(md)?.[0] ?? ''
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
  it('路线图 §四.D 标注已交付且 E 未关闭（整节不得假勾）', () => {
    const s = read('docs/superpowers/specs/2026-10-09-后续交付路线图-design.md')
    expect(s).toMatch(/### D\. 同步引擎（`sync\/`）—— ✅ 已交付/)
    expect(s).not.toMatch(/### E\..*已交付/)
  })
  it('路线图 §六.3：D 已交付 + §六.4：E 已解锁', () => {
    const s = read('docs/superpowers/specs/2026-10-09-后续交付路线图-design.md')
    const l3 = s.split('\n').find((l) => /D 已交付（2026-10-15/.test(l)) ?? ''
    expect(l3).toMatch(/D 已交付/)
    const l4 = s.split('\n').find((l) => /已解锁（C1、D 均已交付）/.test(l)) ?? ''
    expect(l4).toMatch(/已解锁/)
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

  it('D spec §九：store_not_initialized 的 hint 口径 = qiyu store init（与 C1 同）', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    expect(s).toMatch(/hint \*\*一律指 `qiyu store init`\*\*/)
  })

  it('D spec §八：迁移编号实况（v9 的 G2 两列）已记录', () => {
    const s = read('docs/superpowers/specs/2026-10-14-同步引擎-design.md')
    expect(s).toMatch(/v9（sync_state 补 resolved_range_start\/end 两列/)
  })

  it('设计稿 §9.5：hint 口径与 D 交付后同指 store init（不再承诺改指 sync run）', () => {
    const s = read('docs/qiyu-cli-design.md')
    const l = s.split('\n').find((x) => /`kind: "store_not_initialized"`/.test(x)) ?? ''
    expect(l).toMatch(/qiyu store init/)
    expect(l).toMatch(/同口径/)
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

  it('CHANGELOG [未发布]：批 2 条目（v9 迁移 + sensitive_columns + resolved_range）在段内', () => {
    const md = read('CHANGELOG.md')
    const unreleased = /## \[未发布\][\s\S]*?(?=\n## |$)/.exec(md)?.[0] ?? ''
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

  it('CHANGELOG [未发布]：批 4 的修复条目在段内（按天切片 / 删除上界 / 超时 / 中央目录）', () => {
    const md = read('CHANGELOG.md')
    const unreleased = /## \[未发布\][\s\S]*?(?=\n## |$)/.exec(md)?.[0] ?? ''
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
})
