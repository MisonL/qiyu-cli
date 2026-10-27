// tests/skill-check-field-notes.test.ts —— `skill check` 三种形态的 meta 图例（2026-10-28）。
//
// 为什么单独一条：`violations[].rule` 是 10 值闭集（Agent 按值分支：改命令行 vs 改正文），
// 而 compare 形态有 `installed.present=false`（此时 violations/unverifiable 不出现）与
// `differences`（非空即退出码 1）两个易误读点。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { skillCommand, checkFieldNotes, CHECK_RULE_NOTES } from '../src/commands/skill.js'

vi.setConfig({ testTimeout: 30_000 })

let home = ''
let entity = ''
let out = ''
let err = ''
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'qiyu-checknotes-'))
  entity = join(home, 'entity')
  out = ''
  err = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((x) => { err += x; return true })
  vi.stubEnv('HOME', home) // 隔离真实 ~
  vi.stubEnv('USERPROFILE', home) // Windows 的 os.homedir() 读它
  vi.stubEnv('QIYU_SKILL_DIR', '') // 命令层把空串当「未设」
  vi.stubEnv('QIYU_HOME_FOR_TEST', home)
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(home, { recursive: true, force: true })
})

const envelope = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const data = (): Record<string, unknown> => envelope().data as Record<string, unknown>
const notes = (): Record<string, string> => (envelope().meta as Record<string, unknown>).field_notes as Record<string, string>

/** 断言图例键与真实输出互相覆盖；`conditional` 是本形态下可能不出现的图例键。 */
function assertLegendMatches(mode: Parameters<typeof checkFieldNotes>[0], conditional: string[] = []): void {
  // 条件键：warnings 只在有无法判定条目时出现；installed.error 只在 present=false 时出现。
  conditional = [...conditional, 'warnings', 'installed.error']
  const keys = Object.keys(checkFieldNotes(mode))
  const d = data()

  /** 解析点路径：data 优先、meta 兜底（skill_contract_version / warnings 在 meta 里）。 */
  const pick = (root: Record<string, unknown>, path: string): unknown =>
    path === '' ? root : path.split('.').reduce<unknown>(
      (o, seg) => (o as Record<string, unknown> | undefined)?.[seg], root)
  const resolve = (path: string): unknown =>
    pick(d, path) !== undefined ? pick(d, path) : pick(envelope().meta as Record<string, unknown>, path)

  // 正向：每个图例键必须能在输出里找到（`a[].x` / `a.b[].x` 按数组元素核对）
  for (const k of keys) {
    if (conditional.includes(k)) continue
    const m = /^(.+?)\[\]\.(.+)$/.exec(k)
    if (m !== null) {
      const arr = resolve(m[1]!)
      expect(Array.isArray(arr), `${mode} 的图例键 ${k} 对应的数组 ${m[1]} 不在输出里`).toBe(true)
      const first = (arr as unknown[])[0]
      if (first !== undefined && typeof first === 'object' && first !== null) {
        expect(Object.keys(first as Record<string, unknown>), `${mode} 的图例键 ${k} 不在元素里`)
          .toContain(m[2])
      }
    } else {
      expect(resolve(k), `${mode} 的图例键 ${k} 不在输出里（输出键：${Object.keys(d).join('、')}）`)
        .toBeDefined()
    }
  }

  // 反向：输出里的每个字段（递归，含数组元素键）都必须被图例覆盖
  const covered = (path: string): void => {
    const v = resolve(path)
    if (Array.isArray(v)) {
      const first = v[0]
      if (first !== undefined && typeof first === 'object' && first !== null) {
        for (const ek of Object.keys(first as Record<string, unknown>)) {
          expect(keys, `${mode} 的元素字段 ${path}[].${ek} 没有释义`).toContain(`${path}[].${ek}`)
        }
      } else {
        expect(keys.some((n) => n === path || n.startsWith(`${path}[].`)), `${mode} 的 ${path} 没有释义`).toBe(true)
      }
      return
    }
    if (v !== null && typeof v === 'object') {
      expect(keys.some((n) => n === path || n.startsWith(`${path}.`)), `${mode} 的 ${path} 没有释义`).toBe(true)
      for (const sub of Object.keys(v as Record<string, unknown>)) covered(`${path}.${sub}`)
      return
    }
    expect(keys, `${mode} 的字段 ${path} 没有释义`).toContain(path)
  }
  for (const k of Object.keys(d)) covered(k)
}

describe('skill check 的图例与真实输出', () => {
  it('package 形态：默认检查包内正文', async () => {
    expect(await skillCommand(['check'])).toBe(0)
    assertLegendMatches('package')
    expect(data().mode).toBe('package')
    expect(data().baseline).toBeTruthy()
  })

  it('installed 形态：违规规则的图例覆盖 10 个闭集值', async () => {
    mkdirSync(entity, { recursive: true })
    writeFileSync(join(entity, 'SKILL.md'), '# 坏正文\n\n`qiyu nope`\n')
    expect(await skillCommand(['check', '--installed', '--dir', entity])).toBe(1)
    assertLegendMatches('installed')
    const violations = data().violations as Array<Record<string, unknown>>
    expect(violations[0]).toMatchObject({ rule: 'unknown_command' })
    const cell = notes()['violations[].rule']!
    for (const rule of Object.keys(CHECK_RULE_NOTES)) {
      expect(cell, `规则 ${rule} 没有释义`).toContain(`${rule} = `)
    }
  })

  it('unverifiable 不是违规、不改变退出码（图例的行为学依据）', async () => {
    mkdirSync(entity, { recursive: true })
    writeFileSync(join(entity, 'SKILL.md'), '# 探针\n\n`qiyu sync run --since …`\n')
    expect(await skillCommand(['check', '--installed', '--dir', entity]), out.slice(0, 400)).toBe(0)
    const unverifiable = data().unverifiable as unknown[]
    expect(unverifiable.length).toBeGreaterThan(0)
    expect(data().violations).toEqual([])
    expect(notes()['unverifiable[].detail']).toContain('不改变退出码')
  })

  it('compare 形态（一致）：differences 空数组，package/installed 都在', async () => {
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    out = ''; err = ''
    expect(await skillCommand(['check', '--compare', '--dir', entity]), out.slice(0, 400)).toBe(0)
    assertLegendMatches('compare')
    expect(data().differences).toEqual([])
    expect((data().installed as Record<string, unknown>).present).toBe(true)
  })

  it('compare 形态（正文漂移）：differences 非空即退出码 1', async () => {
    expect(await skillCommand(['install', '--dir', entity])).toBe(0)
    writeFileSync(join(entity, 'SKILL.md'), '# 被改过的正文\n')
    out = ''; err = ''
    expect(await skillCommand(['check', '--compare', '--dir', entity]), out.slice(0, 400)).toBe(1)
    expect((data().differences as unknown[]).length).toBeGreaterThan(0)
    expect(notes().differences, '图例必须点明 differences 非空 = 退出码 1').toContain('非空时退出码必为 1')
  })

  it('compare 形态（已安装不可用）：present=false、error 在，violations/unverifiable 不出现', async () => {
    expect(await skillCommand(['check', '--compare', '--dir', join(home, 'missing')]), out.slice(0, 400)).toBe(1)
    assertLegendMatches('compare', ['installed.violations[].line', 'installed.violations[].rule',
      'installed.violations[].detail', 'installed.unverifiable[].line', 'installed.unverifiable[].detail'])
    const installed = data().installed as Record<string, unknown>
    expect(installed.present).toBe(false)
    expect(installed.error).toBeTruthy()
    expect(installed.violations).toBeUndefined()
    expect(installed.unverifiable).toBeUndefined()
    expect(notes()['installed.present']).toContain('不出现')
  })

  it('图例不带 `**`、非枚举正文不含分隔符 `；`', () => {
    for (const mode of ['package', 'installed', 'compare'] as const) {
      for (const [k, v] of Object.entries(checkFieldNotes(mode))) {
        expect(v, `${mode}.${k} 含 **`).not.toContain('**')
        // 枚举单元格（mode / violations[].rule）按约定用 `；` 连接，其余正文不得含
        if (k === 'mode' || k.endsWith('violations[].rule')) continue
        expect(v, `${mode}.${k} 含分隔符 ；`).not.toContain('；')
      }
    }
  })
})
