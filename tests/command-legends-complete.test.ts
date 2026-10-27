// tests/command-legends-complete.test.ts —— 「输出里的字段必须有释义」的**反向**兜底
// （2026-10-28）。
//
// 为什么单独一个文件：既有的图例测试（stats / sync / query / db / store / skill）大多是
// **单向**的 —— 图例里的键必须真实存在（防止解释一个读不到的字段）。但反方向
// 「输出里有这个字段、图例却没解释它」没人查，于是 `skill where` 的
// `cli_contract_version` 一直裸奔（2026-10-28 实测发现）。
//
// 本文件对**每条有图例的命令**跑真实输出，断言：data 里的每个字段要么被图例覆盖
// （`k` / `k.` / `k[]` 三种前缀），要么在自明清单里（如 `entity`、`links` 这类容器）。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { run, versionFieldNotes } from '../src/cli.js'
import { skillCommand, whereFieldNotes } from '../src/commands/skill.js'
import { authCommand } from '../src/commands/auth.js'

vi.setConfig({ testTimeout: 30_000 })

let dir = ''
let out = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-legends-'))
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  vi.stubEnv('HOME', dir) // 隔离真实 ~
  vi.stubEnv('USERPROFILE', dir)
})
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const parsed = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const data = (): Record<string, unknown> => parsed().data as Record<string, unknown>
const notes = (): Record<string, string> =>
  (parsed().meta as Record<string, unknown>).field_notes as Record<string, string>

/** 字段 `k` 是否被图例覆盖（`k` 本身，或 `k.xxx` / `k[]` 这类子路径）。 */
function covered(k: string, keys: string[]): boolean {
  return keys.includes(k)
    || keys.some((n) => n.startsWith(`${k}.`) || n.startsWith(`${k}[]`))
}

/** 断言 data 的每个字段都有释义（或明确列在自明清单里）。 */
function assertAllCovered(where: string, selfEvident: string[] = []): void {
  const keys = Object.keys(notes())
  for (const k of Object.keys(data())) {
    if (selfEvident.includes(k)) continue
    expect(covered(k, keys), `${where} 的字段 ${k} 没有释义（图例键：${keys.join('、')}）`).toBe(true)
  }
}

describe('每条有图例的命令：输出字段必须被图例覆盖（反向）', () => {
  it('skill where：含 cli_contract_version（此前裸奔）', async () => {
    out = ''
    expect(await skillCommand(['where'])).toBe(0)
    expect(Object.keys(notes()).sort()).toEqual(Object.keys(whereFieldNotes()).sort())
    assertAllCovered('skill where')
    // 显式钉住本轮修的那个键 —— 它曾经在输出里、却不在图例里
    expect(notes().cli_contract_version, '必须点明是 CLI 自己的契约号').toContain('本 CLI 自己的正文契约号')
    expect(notes().cli_contract_version, '必须说明与已安装那份是两个数').toContain('是两个数')
  })

  it('--version：两个键都有释义', async () => {
    out = ''
    expect(await run(['--version'])).toBe(0)
    expect(Object.keys(notes()).sort()).toEqual(Object.keys(versionFieldNotes()).sort())
    assertAllCovered('--version')
    expect(notes().skill_contract_version, '必须点明不是已安装那份的').toContain('不是已安装那份的')
    // CodeRabbit：null 的是整个 entity.installed，不是它下面的字段 —— 得先说清怎么判。
    expect(notes().skill_contract_version, '必须点明是 entity.installed 整体为 null')
      .toContain('整个 entity.installed 是 null')
  })

  it('auth login：四个键都有释义，且 source 的误导被点破', async () => {
    vi.stubEnv('QIYU_APP_KEY', 'k-test')
    vi.stubEnv('QIYU_APP_SECRET', 's-test')
    out = ''
    // ⚠️ `auth login` 只接受 `--profile`（不吃 `--db`）—— 配置文件路径由 HOME 决定，
    // 本用例已把 HOME 指向临时目录。
    expect(await authCommand(['login'])).toBe(0)
    assertAllCovered('auth login')
    // 实测：login 报 source=file，但环境变量仍在时下一次 whoami 会报 env ——
    // 「写进文件」不等于「下次从文件读」。
    expect(notes().source, 'source 必须点破「不等于下次从文件读」').toContain('不表示「下次会从文件读」')
    expect(notes().configured, 'configured 必须说明不代表有效').toContain('不代表它们有效')
    // CodeRabbit：不能把 auth whoami 当成「验证有效性」的手段 —— 它也只查存在性。
    expect(notes().configured, '必须点明 whoami 也不能验证有效性').toContain('不能验证有效性')
    expect(notes().profile, 'profile 必须给出完整选择顺序').toContain('QIYU_PROFILE')
    expect(notes().profile, 'profile 不能只说「缺省 default」').toContain('不要假定是 default')
  })
})
