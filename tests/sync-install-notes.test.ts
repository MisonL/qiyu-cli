// tests/sync-install-notes.test.ts —— `sync install` / `uninstall` 的 meta 图例（2026-10-28）。
//
// 背景：这两个命令的 `commands[].ok` 是**三值**（null = 未执行 / true = 成功 / false = 失败），
// 而 `dry_run` 决定「到底装没装」。四个分支（install/uninstall × dry-run/--yes）的键集
// 各不相同，所以图例按模式分开 —— 一份图例解释四个不存在的键就是「声明了但没人读」。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { syncCommand } from '../src/commands/sync.js'
import { __setPlatform, __setRun, __resetScheduleDeps } from '../src/schedule/install.js'
import { advanceWatermark } from '../src/sync/state.js'
import { createDuckDbStore } from '../src/store/duckdb.js'
import { syncInstallFieldNotes, SYNC_INSTALL_MODES } from '../src/commands/sync-notes.js'
import type { Store } from '../src/store/types.js'

vi.setConfig({ testTimeout: 30_000 })

let dir = ''
let out = ''
const runMock = vi.fn()
const dbPath = (): string => join(dir, 'q.db')

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'qiyu-instnotes-'))
  out = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => { out += s; return true })
  vi.spyOn(process.stderr, 'write').mockImplementation((x) => { out += 'ERR:' + x; return true })
  vi.stubEnv('HOME', dir) // 隔离真实 ~
  __setPlatform(() => 'darwin')
  __setRun(runMock)
  runMock.mockReset()
  runMock.mockResolvedValue({ code: 0, stdout: '', stderr: '' })
})
afterEach(() => {
  __resetScheduleDeps(); vi.restoreAllMocks(); vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

const parsed = (): Record<string, unknown> => JSON.parse(out) as Record<string, unknown>
const data = (): Record<string, unknown> => parsed().data as Record<string, unknown>
const notes = (): Record<string, string> => (parsed().meta as Record<string, unknown>).field_notes as Record<string, string>

async function fresh(): Promise<Store> {
  const s = await createDuckDbStore(
    { backend: 'duckdb', path: dbPath(), readOnlyRetryMs: 30000, batchSize: 1000 }, 'rw')
  await s.init()
  return s
}

/** install 的前置探测要求「成功同步过」：预置一条 sync_state 记录。 */
async function seedSynced(): Promise<void> {
  const s = await fresh()
  await s.transaction(async (tx) => {
    await advanceWatermark(tx, 'dim.staff', '2026-10-14T00:00:00.000Z', { start: 0, end: 1 }, '2026-10-14T10:00:00.000Z')
  })
  await s.close()
}

/**
 * 断言图例与真实输出**双向**互相覆盖（`absent` 是条件键，允许只在图例里出现）。
 * 嵌套键（`commands[].x` / `entries[].x` / `remove[].x`）按数组首项的键集核对 ——
 * 与 db/store 的图例测试同款；只比顶层键会把嵌套路径全判成「不在输出里」。
 */
function assertLegendMatches(mode: Parameters<typeof syncInstallFieldNotes>[0], conditional: string[] = []): void {
  const legend = Object.keys(syncInstallFieldNotes(mode))
  const d = data()
  const real = Object.keys(d)
  const elementKeys = (k: string): string[] => {
    const arr = d[k]
    return Array.isArray(arr) && arr.length > 0 ? Object.keys(arr[0] as Record<string, unknown>) : []
  }
  for (const k of legend) {
    if (conditional.includes(k)) continue
    const m = /^([a-z_]+)\[\]\.(.+)$/.exec(k)
    if (m !== null) {
      // 数组必须存在；元素键只在数组非空时可核对（空数组没有元素形状可查 ——
      // uninstall --yes 未安装时 commands 就是 []，这是真实形态而不是缺陷）。
      expect(real, `${mode} 的图例键 ${k} 对应的数组 ${m[1]} 不在输出里`).toContain(m[1])
      const keys = elementKeys(m[1]!)
      if (keys.length > 0) {
        expect(keys, `${mode} 的图例键 ${k} 不在 ${m[1]}[] 的元素里`).toContain(m[2])
      }
    } else {
      expect(real, `${mode} 的图例键 ${k} 不在输出里`).toContain(k)
    }
  }
  // 反向：输出字段必须被图例覆盖（`commands` 由 `commands[].x` 覆盖）。
  // 元素层也要查：只看顶层键的话，同一数组里删掉一个元素键（还有别的键顶着）两个方向都查不到。
  for (const k of real) {
    const covered = legend.includes(k) || legend.some((n) => n.startsWith(`${k}[].`) || n.startsWith(`${k}.`))
    expect(covered, `${mode} 的输出字段 ${k} 没有释义（图例键：${legend.join('、')}）`).toBe(true)
    const arr = d[k]
    if (Array.isArray(arr) && arr.length > 0 && typeof arr[0] === 'object' && arr[0] !== null) {
      for (const ek of Object.keys(arr[0] as Record<string, unknown>)) {
        expect(legend, `${mode} 的元素字段 ${k}[].${ek} 没有释义`).toContain(`${k}[].${ek}`)
      }
    }
  }
}

describe('四种模式的图例与真实输出一一对应', () => {
  it('模式清单非空且无重复', () => {
    expect([...SYNC_INSTALL_MODES].length).toBe(4)
    expect(new Set(SYNC_INSTALL_MODES).size).toBe(4)
  })

  it('install dry-run', async () => {
    await seedSynced()
    expect(await syncCommand(['install', '--schedule', '0 3 * * *', '--db', dbPath()])).toBe(0)
    assertLegendMatches('install-dry')
    expect(data().dry_run).toBe(true)
    expect(runMock, 'dry-run 不得执行任何命令').not.toHaveBeenCalled()
  })

  it('install --yes', async () => {
    await seedSynced()
    const code = await syncCommand(['install', '--schedule', '0 3 * * *', '--yes', '--db', dbPath()])
    expect(code, out.slice(0, 300)).toBe(0)
    assertLegendMatches('install-real')
    expect(data().dry_run).toBe(false)
    expect(runMock, '--yes 真的执行了 load').toHaveBeenCalled()
  })

  it('uninstall dry-run', async () => {
    await seedSynced()
    expect(await syncCommand(['install', '--schedule', '0 3 * * *', '--yes', '--db', dbPath()])).toBe(0)
    out = ''
    // ⚠️ `sync uninstall` 只接受 `--yes` —— 它的业务 flag 里没有存储定位参数
    // （见 sync.ts 里 UNINSTALL_BOOL_FLAGS 的说明：uninstall 不读库，只按平台路径删条目）。
    expect(await syncCommand(['uninstall']), out.slice(0, 300)).toBe(0)
    assertLegendMatches('uninstall-dry')
    expect(data().dry_run).toBe(true)
    expect(notes()['remove[].exists'], 'exists 必须点明是计划生成时的探测快照').toContain('探测快照')
  })

  it('uninstall --yes（absent 是条件键，图例仍要解释它）', async () => {
    await seedSynced()
    expect(await syncCommand(['install', '--schedule', '0 3 * * *', '--yes', '--db', dbPath()])).toBe(0)
    out = ''
    expect(await syncCommand(['uninstall', '--yes']), out.slice(0, 300)).toBe(0)
    assertLegendMatches('uninstall-real', ['absent'])
    expect(data().dry_run).toBe(false)
    expect(notes().absent, 'absent 必须点明是条件键').toContain('条件键')
  })

  it('uninstall 不接受存储定位参数（--db 是未知参数，退出码 2）', async () => {
    expect(await syncCommand(['uninstall', '--db', dbPath()])).toBe(2)
    expect(out).toContain('未知参数')
  })

  it('uninstall --yes 从未安装时：commands 为空数组，notes 说明原因', async () => {
    // 不 seed、不 install —— 直接卸载一个不存在的条目。图例里「commands 为空 = 没有
    // 可停的调度器，不是执行失败」这句必须能对上实况。
    expect(await syncCommand(['uninstall', '--yes']), out.slice(0, 300)).toBe(0)
    assertLegendMatches('uninstall-real')
    expect(data().commands).toEqual([])
    expect(data().dry_run).toBe(false)
    expect((data().notes as string[]).join('')).toContain('未安装')
  })
})

describe('三值 ok 与 dry_run 的措辞', () => {
  it('commands[].ok 必须写明三值，且 null 不是成功也不是失败', () => {
    for (const mode of SYNC_INSTALL_MODES) {
      const n = syncInstallFieldNotes(mode)['commands[].ok']!
      expect(n, `${mode} 的 ok 释义必须写三值`).toContain('三值')
      expect(n, `${mode} 的 ok 释义必须点明 null 的语义`).toContain('null = 未执行')
      expect(n, `${mode} 的 ok 释义必须警告别当布尔用`).toContain('别按布尔值用')
    }
  })

  it('dry_run 必须点明「判断装没装看它，不要只看退出码」', () => {
    for (const mode of SYNC_INSTALL_MODES) {
      const n = syncInstallFieldNotes(mode).dry_run!
      expect(n).toContain('不要只看退出码')
    }
  })

  it('platform 释义必须列全三个受支持平台（win32 也支持，schtasks）', () => {
    for (const mode of SYNC_INSTALL_MODES) {
      const n = syncInstallFieldNotes(mode).platform!
      expect(n, `${mode} 的 platform 释义漏了 win32`).toContain('win32')
      expect(n, `${mode} 的 platform 释义漏了 schtasks`).toContain('schtasks')
    }
  })

  it('field_notes 不带 `**`、正文不含分隔符 `；`', () => {
    for (const mode of SYNC_INSTALL_MODES) {
      for (const [k, v] of Object.entries(syncInstallFieldNotes(mode))) {
        expect(v, `${mode}.${k} 含 **`).not.toContain('**')
        expect(v, `${mode}.${k} 含分隔符 ；`).not.toContain('；')
      }
    }
  })
})
