// tests/skill/install.test.ts —— 安装逻辑（Task 9）。
//
// 全部在临时 home 下跑，绝不读写真实 `~`。`mkdtempSync` 后立刻 `realpathSync`：
// macOS 上 `/var` 是指向 `/private/var` 的符号链接，不归一化的话断言里的路径字符串
// 会与实现内部 realpath 后的结果对不上，失败信息也更难读。
//
// 四条关键不变量（brief 要求自测）：
//   ① 用户改过的正文在无 --force 时不被覆盖；
//   ② foreign 链接不被覆盖；
//   ③ manifest 不参与内容哈希；
//   ④ 重复安装幂等（第二次 status='skipped'、无 EEXIST 警告、正文 mtime 不变）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  chmodSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync,
  readlinkSync, symlinkSync, statSync, existsSync, realpathSync, utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  contentHash, installSkill, MANIFEST, planInstall, STAGING_MARKER_CONTENT, type Manifest,
} from '../../src/skill/install.js'
import { defaultEntityDir, linkState, linkTarget } from '../../src/skill/paths.js'
import { SKILL_CONTRACT_VERSION } from '../../src/core/edition.js'

let home: string

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-install-')))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 写文件（自动建父目录）。 */
function write(dir: string, rel: string, content: string | Buffer): void {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

/** 构造一份包内 skill 源目录：顶层 + 一个嵌套文件，覆盖递归复制。 */
function makeSource(): string {
  const src = join(home, 'pkg-skill')
  write(src, 'SKILL.md', '# qiyu\n')
  write(src, 'protocols.md', '协议正文\n')
  write(src, 'references/deep.md', '深层引用\n')
  return src
}

/** 读安装清单。 */
function readManifest(entityDir: string): Manifest {
  return JSON.parse(readFileSync(join(entityDir, MANIFEST), 'utf8')) as Manifest
}

/**
 * `node:fs.renameSync` 的故障注入开关（默认 null = 走真实实现）。
 *
 * 为什么在文件顶层 `vi.mock` 而不是用例内 `vi.spyOn`：
 *   · `vi.spyOn(fs, 'renameSync')` 对内置模块直接抛 `Cannot redefine property`
 *     （`node:fs` 的导出不可重定义）；
 *   · 用例内 `vi.doMock` + `vi.resetModules` 能生效，但它会换掉本文件其余用例正在
 *     用的 `install.js` 模块实例（实测：同文件后面的用例全走 mock 形态、互相污染）。
 * 顶层 mock 只替换 `renameSync` 一个函数，其余函数原样转出，所有用例共用一份模块；
 * 需要故障的用例设开关、`finally` 里清空。
 */
const fsRenameFault = vi.hoisted(() => {
  const state: { kind: string | null } = { kind: null }
  return {
    set(kind: string | null): void { state.kind = kind },
    current(): string | null { return state.kind },
  }
})

/**
 * `symlink` 的故障注入开关（默认 false = 真实建链）：为 true 时「建出的链接」内容被
 * 换成一条解析不到的目标——用来验证**事后复核**（审查 B1 的第二道保险）真的在岗：
 * 建链调用成功、但 agent 解析不到实体，这时不得报 state='ok'。
 */
const fsSymlinkFault = vi.hoisted(() => {
  const state = { active: false }
  return {
    set(active: boolean): void { state.active = active },
    get(): boolean { return state.active },
  }
})

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    symlink: (target: string, linkPath: string, type?: string) =>
      actual.symlink(fsSymlinkFault.get() ? join('nowhere-at-all') : target, linkPath, type as never),
  }
})

/**
 * `readdirSync({ withFileTypes: true })` 的故障注入开关（默认 false）：为 true 时把
 * 每个条目换成「空壳 Dirent」——`isFile`/`isDirectory`/`isSymbolicLink` 全部返回
 * false，模拟 d_type=`DT_UNKNOWN` 的文件系统（审查 #40）。只影响带 `withFileTypes`
 * 的调用，其余调用原样转出。
 */
const fsReaddirFault = vi.hoisted(() => {
  const state = { active: false }
  return {
    set(active: boolean): void { state.active = active },
    get(): boolean { return state.active },
  }
})

/**
 * 所有「并发赢家形态」的注入种类。**兜底分支用它做反判**（复审 N2）：写
 * `!kind.startsWith('ENOTEMPTY')` 会让一个忘了登记的新变体既不进并发分支、也不进
 * 兜底，直接落到真实 renameSync —— mock 静默失效而用例照常绿。
 */
const ENOTEMPTY_KINDS = new Set([
  'ENOTEMPTY', 'ENOTEMPTY_STALE_MANIFEST', 'ENOTEMPTY_MANIFEST_DIR', 'ENOTEMPTY_EXACT',
  'ENOTEMPTY_UNREADABLE',
])

/**
 * `readFileSync` 的读取记录（默认 null = 不记录）：为 true 时把每次调用的路径记进数组。
 * 用来断言「大文件没有被整读」（复审 N5：时间断言没判别力 —— 8MB 读得够快）。
 */
const fsReadLog = vi.hoisted(() => {
  const paths: string[] = []
  return {
    paths,
    active: false,
    set(active: boolean): void { this.active = active; if (active) paths.length = 0 },
    record(p: unknown): void { if (this.active) paths.push(String(p)) },
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((p: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      fsReadLog.record(p)
      return (actual.readFileSync as (...args: unknown[]) => unknown)(p, ...rest)
    }) as typeof actual.readFileSync,
    readdirSync: ((p: Parameters<typeof actual.readdirSync>[0], opts?: unknown) => {
      const real = (actual.readdirSync as (a: unknown, b?: unknown) => unknown)(p, opts)
      const withTypes = typeof opts === 'object' && opts !== null
        && (opts as { withFileTypes?: boolean }).withFileTypes === true
      if (!fsReaddirFault.get() || !withTypes || !Array.isArray(real)) return real
      // 空壳：三个类型判定全 false（Node 在 DT_UNKNOWN 上给的就是这种形态）。
      return real.map((ent: unknown) => {
        const e = ent as { name: string }
        return {
          name: e.name,
          isFile: () => false,
          isDirectory: () => false,
          isSymbolicLink: () => false,
          isBlockDevice: () => false,
          isCharacterDevice: () => false,
          isFIFO: () => false,
          isSocket: () => false,
        }
      })
    }) as typeof actual.readdirSync,
    renameSync: (from: string, to: string) => {
      const kind = fsRenameFault.current()
      // ENOTEMPTY 故障（gap 8）：只拦**整目录换入**（源是暂存目录本身、目标是实体），
      // 模拟「另一进程在这两步之间把实体建出来了」。逐文件换入不拦。
      // ⚠️ 这个分支必须排在下面的通用分支**之前**：通用分支对任何非 null 的 kind 都抛
      // （且会把 ENOTEMPTY 渲染成 EACCES），先命中就永远到不了这里。
      if (kind !== null && ENOTEMPTY_KINDS.has(kind)
        && from.includes('.tmp-') && !to.includes('.tmp-') && !to.endsWith('.md') && !to.endsWith(MANIFEST)) {
        // ⚠️ 真实竞态里，错误发生时**实体已经在**（另一个进程刚写完）。只抛错不建实体
        // 会把场景变成「实体不存在」，重判定会给出 installed —— 与真实竞态不同。
        // 所以这里先把「另一进程的成果」落到磁盘，再抛错。
        actual.mkdirSync(to, { recursive: true })
        const realTo = actual.realpathSync(to)
        if (kind === 'ENOTEMPTY_STALE_MANIFEST') {
          // 并发赢家形态 A：正文与包内**一致**，只有清单落后（版本/契约版本旧）。
          // 用暂存目录里的真实产物铺过去（此刻标记已被 unlink，内容与源逐字节相同）。
          actual.cpSync(from, to, { recursive: true, force: true })
          actual.writeFileSync(realTo + '/' + MANIFEST, JSON.stringify({
            version: '0.0.1', skill_contract_version: 0, content_hash: 'stale',
            files: ['SKILL.md'], installed_at: new Date(0).toISOString(),
          }))
        } else if (kind === 'ENOTEMPTY_MANIFEST_DIR') {
          // 并发赢家形态 B：正文与包内**逐字节一致**，但清单位置被一个目录占用。
          // planInstall 对这种状态返回 action='none' + 「清单已被非普通文件占用」警告，
          // 且 **--force 也无效**（复审 W3 的第六形态）。
          actual.cpSync(from, to, { recursive: true, force: true })
          actual.rmSync(realTo + '/' + MANIFEST, { force: true })
          actual.mkdirSync(realTo + '/' + MANIFEST)
        } else if (kind === 'ENOTEMPTY_UNREADABLE') {
          // 并发赢家形态 D：实体被建成**不可读目录**（chmod 000）。planInstall 返回
          // action='none' + 「读取实体目录失败…即使 --force 也会以同样的错误失败」，
          // 并发文案必须指引用户按那条警告处理，**不得**再劝 --force（复审 W3 第七形态）。
          actual.cpSync(from, to, { recursive: true, force: true })
          if (process.getuid?.() !== 0) actual.chmodSync(realTo, 0o000)
        } else if (kind === 'ENOTEMPTY_EXACT') {
          // 并发赢家形态 C：与包内**完全一致**（正文 + 全新清单）—— planInstall 走幂等
          // 分支（action='none'、零警告），并发文案必须说「内容与包内一致」（复审 W4）。
          actual.cpSync(from, to, { recursive: true, force: true })
        } else {
          actual.writeFileSync(realTo + '/SKILL.md', '---\nname: qiyu\n---\n# qiyu\n')
        }
        const e = new Error('ENOTEMPTY: directory not empty, rename') as NodeJS.ErrnoException
        e.code = 'ENOTEMPTY'
        throw e
      }
      // 只拦「换入」的那一步（源在暂存目录里），不拦首次安装的整目录 rename。
      // 复审 N2：兜底必须用**集合反判**——写 `!kind.startsWith('ENOTEMPTY')` 会让未登记
      // 的 `ENOTEMPTY_*` 变体既不进上面的分支、也不进兜底，mock 静默失效（用例照常绿）。
      if (kind !== null && !ENOTEMPTY_KINDS.has(kind) && from.includes('.tmp-')) {
        const e = new Error(`${kind === 'EXDEV' ? 'EXDEV: cross-device link not permitted' : 'EACCES: permission denied'}`) as NodeJS.ErrnoException
        e.code = kind
        throw e
      }
      return actual.renameSync(from, to)
    },
  }
})

/**
 * 「零链接」提示（审查 B3 / #58）的条数。临时 home 默认没有 agent 目录，所以几乎
 * 每条用例都会带上这一条；断言「没有别的警告」时把它滤掉，而不是逐条复读文案。
 */
const NO_LINK_HINT = '未发现任何 Agent skills 目录'
function noLinkWarnCount(warnings: string[]): number {
  return warnings.filter((w) => w.includes(NO_LINK_HINT)).length
}

describe('contentHash', () => {
  it('CRLF 与 LF 的同一内容给同一哈希', () => {
    const a = join(home, 'a')
    const b = join(home, 'b')
    write(a, 'x.md', 'one\r\ntwo\r\n')
    write(b, 'x.md', 'one\ntwo\n')
    expect(contentHash(a)).toBe(contentHash(b))
  })
  it('排除 .qiyu-skill.json 自身（写 manifest 前后哈希不变）', () => {
    const dir = join(home, 'd')
    write(dir, 'SKILL.md', '# qiyu\n')
    const before = contentHash(dir)
    write(dir, MANIFEST, JSON.stringify({ version: '9.9.9', installed_at: new Date().toISOString() }))
    expect(contentHash(dir)).toBe(before)
  })
  it('与文件创建顺序无关，嵌套目录按相对路径参与', () => {
    const a = join(home, 'a')
    const b = join(home, 'b')
    write(a, 'z.md', 'z\n')
    write(a, 'sub/a.md', 'a\n')
    write(b, 'sub/a.md', 'a\n')
    write(b, 'z.md', 'z\n')
    expect(contentHash(a)).toBe(contentHash(b))
  })
  it('内容不同则哈希不同', () => {
    const a = join(home, 'a')
    const b = join(home, 'b')
    write(a, 'x.md', 'one\n')
    write(b, 'x.md', 'two\n')
    expect(contentHash(a)).not.toBe(contentHash(b))
  })
  it('路径与内容有定界：文件 a+内容 bc 与文件 ab+内容 c 哈希不同', () => {
    // 不加定界时两者拼出的字节流同为 "abc"。skill 文档不会用换行符命名文件，
    // 「路径 + '\n' + 内容」足以消除现实边界内的歧义。
    const a = join(home, 'a')
    const b = join(home, 'b')
    write(a, 'a', 'bc')
    write(b, 'ab', 'c')
    expect(contentHash(a)).not.toBe(contentHash(b))
  })
})

describe('installSkill', () => {
  it('首次安装：文件就位、manifest 正确、链接建成 state=ok', async () => {
    const src = makeSource()
    const agent = join(home, '.claude', 'skills')
    mkdirSync(agent, { recursive: true })

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    const entity = defaultEntityDir(home)
    expect(r.entityDir).toBe(entity)
    expect(r.status).toBe('installed')
    expect(r.warnings).toEqual([])

    // 正文与嵌套文件都复制到位，内容逐字节一致（复制不转换换行）。
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# qiyu\n')
    expect(readFileSync(join(entity, 'references', 'deep.md'), 'utf8')).toBe('深层引用\n')

    const m = readManifest(entity)
    expect(m.version).toBe('1.2.3')
    expect(m.skill_contract_version).toBe(SKILL_CONTRACT_VERSION)
    expect(m.content_hash).toBe(contentHash(src))
    expect(m.files).toEqual(['SKILL.md', 'protocols.md', 'references/deep.md'])
    expect(Number.isNaN(Date.parse(m.installed_at))).toBe(false)

    expect(r.links).toEqual([{ agent: 'claude-code', path: join(agent, 'qiyu'), state: 'ok' }])
    expect(readlinkSync(join(agent, 'qiyu'))).toBe(join('..', '..', '.agents', 'skills', 'qiyu'))
  })

  it('源目录不存在时抛错，文案指明源目录', async () => {
    await expect(
      installSkill({ home, sourceDir: join(home, 'nope'), version: '1.2.3', force: false }),
    ).rejects.toThrow(/skill 源目录不存在/)
  })

  it('源目录里的 .qiyu-skill.json 不被复制，目标清单由安装逻辑写入', async () => {
    const src = makeSource()
    write(src, MANIFEST, JSON.stringify({ version: 'fake' }))

    await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(readManifest(defaultEntityDir(home)).version).toBe('1.2.3')
  })

  it('重复安装内容相同：skipped、正文 mtime 不变、链接仍 ok 且无警告', async () => {
    const src = makeSource()
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })

    const first = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })
    expect(first.status).toBe('installed')
    const entity = defaultEntityDir(home)
    const before = statSync(join(entity, 'SKILL.md')).mtimeMs
    const manifestBefore = readManifest(entity)

    const second = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(second.status).toBe('skipped')
    expect(second.warnings).toEqual([])
    expect(second.links).toEqual([{ agent: 'claude-code', path: join(home, '.claude', 'skills', 'qiyu'), state: 'ok' }])
    expect(statSync(join(entity, 'SKILL.md')).mtimeMs).toBe(before)
    // 清单也不再重写：installed_at 保持首次安装的时间。
    expect(readManifest(entity).installed_at).toBe(manifestBefore.installed_at)
  })

  it('用户改过正文且不带 --force：不覆盖、skipped、警告提到 --force、清单不重写', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })
    const entity = defaultEntityDir(home)
    write(entity, 'SKILL.md', '# 用户自己改过的内容\n')
    const manifestBefore = readManifest(entity)

    // 包内内容也变了：模拟升级后正文不同。
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.3.0', force: false })

    expect(r.status).toBe('skipped')
    expect(r.warnings.some((w) => w.includes('--force'))).toBe(true)
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# 用户自己改过的内容\n')
    // 清单记录的是「上次真正安装」的状态，不能改写成包内哈希（否则漂移检测会误报 current）。
    expect(readManifest(entity)).toEqual(manifestBefore)
  })

  it('用户改过正文且带 --force：updated、内容被覆盖、清单哈希更新', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })
    const entity = defaultEntityDir(home)
    write(entity, 'SKILL.md', '# 用户自己改过的内容\n')
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.3.0', force: true })

    expect(r.status).toBe('updated')
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# 新版包内容\n')
    const m = readManifest(entity)
    expect(m.version).toBe('1.3.0')
    expect(m.content_hash).toBe(contentHash(src))
  })

  it('--force 清理上一版受管文件（按清单 files 界定），并如实警告', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })
    const entity = defaultEntityDir(home)
    // 模拟新版包删掉了 references/deep.md。
    rmSync(join(src, 'references'), { recursive: true })

    const r = await installSkill({ home, sourceDir: src, version: '1.3.0', force: true })

    expect(r.status).toBe('updated')
    expect(existsSync(join(entity, 'references', 'deep.md'))).toBe(false)
    expect(r.warnings.some((w) => w.includes('references/deep.md'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('上一版安装、本版不再包含'))).toBe(true)
    // 清理后目标哈希与源一致：下一次安装必须能回到 skipped。
    expect(readManifest(entity).content_hash).toBe(contentHash(src))
    const again = await installSkill({ home, sourceDir: src, version: '1.3.0', force: false })
    expect(again.status).toBe('skipped')
    // 这个 home 里没有 agent 目录：幂等跳过之外只剩审查 B3 的那条「零链接」提示。
    expect(noLinkWarnCount(again.warnings)).toBe(1)
    expect(again.warnings.filter((w) => !w.includes('未发现任何 Agent skills 目录'))).toEqual([])
  })

  it('--force 不删用户新增的文件（审查 I2：以清单 files 界定，不删一切包外文件）', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })
    const entity = defaultEntityDir(home)
    // 用户在实体里放了自己的笔记，包内没有。
    write(entity, 'my-notes.md', '用户自己的笔记\n')
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.3.0', force: true })

    expect(r.status).toBe('updated')
    expect(readFileSync(join(entity, 'my-notes.md'), 'utf8')).toBe('用户自己的笔记\n')
    expect(r.warnings.some((w) => w.includes('my-notes.md') && w.includes('保留'))).toBe(true)
  })

  it('清单没有 files 字段（旧格式）：--force 不删任何包外文件，只警告', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })
    const entity = defaultEntityDir(home)
    // 模拟本任务之前写的清单：没有 files 字段。
    const m = readManifest(entity)
    writeFileSync(join(entity, MANIFEST), JSON.stringify({
      version: m.version, skill_contract_version: m.skill_contract_version,
      content_hash: m.content_hash, installed_at: m.installed_at,
    }))
    write(entity, 'old-leftover.md', '上一版遗留\n')
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.3.0', force: true })

    expect(r.status).toBe('updated')
    // 无法识别上一版 → 宁可不删。
    expect(existsSync(join(entity, 'old-leftover.md'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('old-leftover.md') && w.includes('未删除'))).toBe(true)
  })

  it('内容没变但版本变了：只重写清单，正文不动，status=updated', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })
    const entity = defaultEntityDir(home)
    const before = statSync(join(entity, 'SKILL.md')).mtimeMs

    const r = await installSkill({ home, sourceDir: src, version: '1.3.0', force: false })

    expect(r.status).toBe('updated')
    expect(readManifest(entity).version).toBe('1.3.0')
    expect(statSync(join(entity, 'SKILL.md')).mtimeMs).toBe(before)
    // 再跑一次同版本：回到幂等 skipped。
    expect((await installSkill({ home, sourceDir: src, version: '1.3.0', force: false })).status)
      .toBe('skipped')
  })

  it('实体路径被文件占用：明确抛错，不静默继续', async () => {
    const src = makeSource()
    const entity = join(home, 'occupied')
    writeFileSync(entity, '')
    await expect(
      installSkill({ home, sourceDir: src, version: '1.2.3', force: false, entityDir: entity }),
    ).rejects.toThrow(/实体/)
  })

  // —— 审查 C1：用户内容全为符号链接的实体不是空目录 ——
  it('实体只含符号链接（无 force）：不得被删、不得被判为空目录', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(entity, { recursive: true })
    const victim = join(home, 'user-notes.md')
    writeFileSync(victim, '用户笔记\n')
    symlinkSync(victim, join(entity, 'notes'))

    const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })

    expect(r.status).toBe('skipped')
    expect(r.warnings.some((w) => w.includes('--force'))).toBe(true)
    // 链接本身原样保留，指向的用户文件也没被动过。
    expect(readlinkSync(join(entity, 'notes'))).toBe(victim)
    expect(readFileSync(victim, 'utf8')).toBe('用户笔记\n')
  })

  it('真空实体（只剩 manifest）：按首次安装换入', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(entity, { recursive: true })
    write(entity, MANIFEST, JSON.stringify({ version: '0.0.0' }))

    const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })

    expect(r.status).toBe('installed')
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# qiyu\n')
  })

  it('实体含用户子目录（无 force）：不覆盖、子目录原样保留', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    write(entity, 'user-dir/private.md', '私有内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })

    expect(r.status).toBe('skipped')
    expect(readFileSync(join(entity, 'user-dir', 'private.md'), 'utf8')).toBe('私有内容\n')
  })

  // —— 审查 C2：实体里的符号链接不得被写穿（copy 写穿 / rename 替换，两种都拦） ——
  it('实体 SKILL.md 是指向用户文件的符号链接（无 force）：不得写穿', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(entity, { recursive: true })
    const victim = join(home, 'my-notes.md')
    writeFileSync(victim, '珍贵笔记\n')
    symlinkSync(victim, join(entity, 'SKILL.md'))

    const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })

    // 链接未被替换为普通文件，用户文件内容原封不动；按「内容不同」跳过并提示 --force。
    expect(lstatSync(join(entity, 'SKILL.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(victim, 'utf8')).toBe('珍贵笔记\n')
    expect(r.status).toBe('skipped')
    expect(r.warnings.some((w) => w.includes('--force'))).toBe(true)
  })

  it('实体 SKILL.md 是指向用户文件的符号链接（带 force）：同样不得写穿', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(entity, { recursive: true })
    const victim = join(home, 'my-notes.md')
    writeFileSync(victim, '珍贵笔记\n')
    symlinkSync(victim, join(entity, 'SKILL.md'))

    await installSkill({ home, sourceDir: src, version: '1.0.0', force: true })

    expect(lstatSync(join(entity, 'SKILL.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(victim, 'utf8')).toBe('珍贵笔记\n')
  })

  it('实体子目录是目录符号链接（force）：不得经它写进实体之外', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(entity, { recursive: true })
    const outside = join(home, 'outside-dir')
    mkdirSync(outside)
    symlinkSync(outside, join(entity, 'references'))
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    // 链接还在（未被 rename 替换），实体之外没有新文件落进来。
    expect(lstatSync(join(entity, 'references')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(outside, 'deep.md'))).toBe(false)
    expect(r.warnings.some((w) => w.includes('references'))).toBe(true)
  })

  it('清理路径同样不得穿透：上一版受管文件在目录符号链接之下，--force 不得删实体外的文件（审查 N1-G1）', async () => {
    const src = makeSource()
    // 首次安装：清单 files 记录 references/deep.md。
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    // 用户把 references 换成指向个人笔记目录的链接，个人目录里有同名文件。
    const personal = join(home, 'personal-notes')
    mkdirSync(personal)
    writeFileSync(join(personal, 'deep.md'), '我的个人笔记\n')
    rmSync(join(entity, 'references'), { recursive: true })
    symlinkSync(personal, join(entity, 'references'))
    // 新版包删掉 references/deep.md，并改动 SKILL.md 逼出 updated（否则走 skipped，清理根本不跑）。
    rmSync(join(src, 'references'), { recursive: true })
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    // 清理确实跑了（清单被换新），但实体之外的个人文件原样、链接原样；拒绝删除要如实警告。
    expect(r.status).toBe('updated')
    expect(readFileSync(join(personal, 'deep.md'), 'utf8')).toBe('我的个人笔记\n')
    expect(lstatSync(join(entity, 'references')).isSymbolicLink()).toBe(true)
    expect(r.warnings.some((w) => w.includes('references'))).toBe(true)
  })

  it('清单 files 含 .. 逃逸条目（被篡改）：拒绝按它删除实体外文件（审查 N1-G2）', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    // 手工篡改清单，塞进一条路径逃逸条目（模拟用户编辑或被篡改的清单）。
    const m = readManifest(entity)
    writeFileSync(join(entity, MANIFEST), JSON.stringify({ ...m, files: ['../../../escape.md'] }))
    const victim = join(home, 'escape.md')
    writeFileSync(victim, '实体外的文件\n')
    // 改内容逼出 updated，确保清理逻辑真的执行。
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    expect(r.status).toBe('updated')
    expect(readFileSync(victim, 'utf8')).toBe('实体外的文件\n')
    // 篡改清单在解析层就被拒（readManifestSafe 返回 null → 不作为清理依据），
    // 重写后的清单不再含逃逸条目；实体外文件没有任何删除动作。
    const after = readManifest(entity)
    expect(after.version).toBe('1.1.0')
    expect(after.files).not.toContain('../../../escape.md')
    expect(existsSync(victim)).toBe(true)
  })

  // —— 审查 I1/I3：暂存失败时实体保持原样 ——
  it('覆盖中断（目标子路径被目录占用）：其余文件已换入、清单保持上一版，修复占用后重跑收敛', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    // 把 SKILL.md 换成目录：rename 换入必然失败（EISDIR），模拟覆盖中断。
    rmSync(join(entity, 'SKILL.md'))
    mkdirSync(join(entity, 'SKILL.md'))
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    // 被占用的文件跳过并警告；其余文件原子换入；清单保持上一版（写入不完整不换清单），
    // 这样下一次安装的漂移探测才能如实报 stale。
    expect(r.warnings.some((w) => w.includes('SKILL.md'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('未能完整写入'))).toBe(true)
    expect(readManifest(entity).version).toBe('1.0.0')
    expect(readFileSync(join(entity, 'protocols.md'), 'utf8')).toBe('协议正文\n')

    // 无 force 重跑：内容与包内不同 → 如实 skipped + 提示 --force。
    const skipped = await installSkill({ home, sourceDir: src, version: '1.1.0', force: false })
    expect(skipped.status).toBe('skipped')
    expect(skipped.warnings.some((w) => w.includes('--force'))).toBe(true)

    // 用户清掉占用后 force：完整写入、清单换新；再装回到幂等 skipped。
    rmSync(join(entity, 'SKILL.md'), { recursive: true })
    const fixed = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })
    expect(fixed.warnings.filter((w) => !w.includes(NO_LINK_HINT))).toEqual([])
    expect(readManifest(entity).version).toBe('1.1.0')
    expect(readManifest(entity).content_hash).toBe(contentHash(src))
    expect((await installSkill({ home, sourceDir: src, version: '1.1.0', force: false })).status)
      .toBe('skipped')
  })

  it('源目录内容不可读：明确抛错且实体保持原样（审查 I1）', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return // root 下 chmod 不拦读取
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    const manifestBefore = readManifest(entity)
    // 源里加一个不可读文件：读源阶段就失败，实体还一个字节没动。
    write(src, 'extra/secret.md', 'x\n')
    chmodSync(join(src, 'extra', 'secret.md'), 0o000)
    try {
      await expect(
        installSkill({ home, sourceDir: src, version: '1.1.0', force: true }),
      ).rejects.toThrow(/skill 源目录不可读/)
    } finally {
      chmodSync(join(src, 'extra', 'secret.md'), 0o644)
    }

    // 实体一个字节不变：正文、清单都还是 1.0.0，新目录没落进来。
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# qiyu\n')
    expect(readManifest(entity)).toEqual(manifestBefore)
    expect(existsSync(join(entity, 'extra'))).toBe(false)
  })

  it('暂存阶段失败（实体父目录只读）：抛错且用户内容保持原样（审查 I1，去 rename 换入变异即红）', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return // root 下 chmod 不拦写入
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    // 用户改过正文；再把实体父目录设为只读：暂存目录建不出来 → 暂存阶段失败。
    write(entity, 'SKILL.md', '# 用户自己改过的内容\n')
    const skillsRoot = join(home, '.agents', 'skills')
    chmodSync(skillsRoot, 0o555)
    try {
      await expect(
        installSkill({ home, sourceDir: src, version: '1.1.0', force: true }),
      ).rejects.toThrow(/暂存目录写入失败/)
    } finally {
      chmodSync(skillsRoot, 0o755) // 让 afterEach 能清理
    }

    // 实体保持原样：用户的正文没有被覆盖，清单还是 1.0.0。
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# 用户自己改过的内容\n')
    expect(readManifest(entity).version).toBe('1.0.0')
    // 暂存目录没有残留。
    expect(readdirSync(skillsRoot).filter((n) => n.includes('.tmp-'))).toEqual([])
  })

  // —— 审查 I4：实体不可读时 --force 仍能修复 ——
  it('实体内容不可读（chmod 000）：无 force 跳过并警告，有 force 正常覆盖', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    chmodSync(join(entity, 'SKILL.md'), 0o000)
    write(src, 'SKILL.md', '# 新版包内容\n')

    try {
      const skipped = await installSkill({ home, sourceDir: src, version: '1.1.0', force: false })
      expect(skipped.status).toBe('skipped')
      expect(skipped.warnings.some((w) => w.includes('--force'))).toBe(true)

      const forced = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })
      expect(forced.status).toBe('updated')
      expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# 新版包内容\n')
    } finally {
      chmodSync(join(entity, 'SKILL.md'), 0o644) // 让 afterEach 能清理
    }
  })

  it('清单损坏（JSON 残缺）：正文一致时只重写清单，不视为用户改动（审查 M2）', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })
    const entity = defaultEntityDir(home)
    writeFileSync(join(entity, MANIFEST), '{ 残缺的 JSON')

    const r = await installSkill({ home, sourceDir: src, version: '1.3.0', force: false })

    expect(r.status).toBe('updated')
    expect(readManifest(entity).version).toBe('1.3.0')
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# qiyu\n')
  })

  it('noLink：只放实体，不建任何链接', async () => {
    const src = makeSource()
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false, noLink: true })

    expect(r.links).toEqual([])
    expect(existsSync(join(home, '.claude', 'skills', 'qiyu'))).toBe(false)
    expect(existsSync(join(defaultEntityDir(home), 'SKILL.md'))).toBe(true)
  })

  it('linkDirs 指向不存在的目录：不建链接、不替用户建目录，links 记 missing（审查 M3）', async () => {
    const src = makeSource()
    const missing = join(home, '.claude', 'skills')
    const r = await installSkill({
      home, sourceDir: src, version: '1.2.3', force: false, linkDirs: [missing],
    })
    // 显式点名的目录不存在：Task 11 要逐 agent 展示状态，links 不能缺行。
    expect(r.links).toEqual([{ agent: missing, path: join(missing, 'qiyu'), state: 'missing' }])
    expect(existsSync(missing)).toBe(false)
    // 显式点名却不存在，要告诉用户；自动探测为空则不告警（没有 agent 是正常状态）。
    expect(r.warnings.some((w) => w.includes(missing))).toBe(true)
  })

  it('linkDirs 指向文件而非目录：警告并跳过，links 记 missing，不让安装失败', async () => {
    const src = makeSource()
    const notDir = join(home, 'not-a-dir')
    writeFileSync(notDir, '')

    const r = await installSkill({
      home, sourceDir: src, version: '1.2.3', force: false, linkDirs: [notDir],
    })

    expect(r.status).toBe('installed')
    expect(r.links).toEqual([{ agent: notDir, path: join(notDir, 'qiyu'), state: 'missing' }])
    expect(r.warnings.some((w) => w.includes(notDir))).toBe(true)
  })

  it('linkDirs 的父路径是文件（ENOTDIR）时收敛进 warnings，不让安装失败（审查 M1）', async () => {
    const src = makeSource()
    const blocker = join(home, 'blocker')
    writeFileSync(blocker, '')
    const unreachable = join(blocker, 'skills')

    const r = await installSkill({
      home, sourceDir: src, version: '1.2.3', force: false, linkDirs: [unreachable],
    })

    expect(r.status).toBe('installed')
    expect(r.links).toEqual([{ agent: unreachable, path: join(unreachable, 'qiyu'), state: 'missing' }])
    expect(r.warnings.some((w) => w.includes('检查') && w.includes(unreachable))).toBe(true)
  })

  it('已存在的 foreign 目录：不覆盖、state=foreign、用户内容原样保留', async () => {
    const src = makeSource()
    const agent = join(home, '.claude', 'skills')
    write(agent, 'qiyu/user-note.md', '用户自己的 skill\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(r.links).toEqual([{ agent: 'claude-code', path: join(agent, 'qiyu'), state: 'foreign' }])
    expect(r.warnings.some((w) => w.includes('占用'))).toBe(true)
    expect(readFileSync(join(agent, 'qiyu', 'user-note.md'), 'utf8')).toBe('用户自己的 skill\n')
    expect(existsSync(join(agent, 'qiyu', 'SKILL.md'))).toBe(false)
  })

  it('指向别处的符号链接也算 foreign：不覆盖', async () => {
    const src = makeSource()
    const agent = join(home, '.claude', 'skills')
    mkdirSync(agent, { recursive: true })
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(agent, 'qiyu'))

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(r.links[0]?.state).toBe('foreign')
    expect(readlinkSync(join(agent, 'qiyu'))).toBe(elsewhere)
  })

  it('dangling 链接（用户自建、目标暂时不存在）：重建为指向实体、state=ok，并如实警告原链接内容（审查 #3）', async () => {
    const src = makeSource()
    const agent = join(home, '.claude', 'skills')
    mkdirSync(agent, { recursive: true })
    // 指向一个不存在的目标 → dangling。这是用户自己建的链接（可能只是目标暂时没挂上）。
    symlinkSync(join(home, 'gone'), join(agent, 'qiyu'))

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(r.links).toEqual([{ agent: 'claude-code', path: join(agent, 'qiyu'), state: 'ok' }])
    // 删掉的是一条用户数据（链接本身）：必须把原链接内容说出来，不能悄悄替换。
    expect(r.warnings).toHaveLength(1)
    expect(r.warnings[0]).toContain('重建')
    expect(r.warnings[0]).toContain(join(home, 'gone'))
    expect(readlinkSync(join(agent, 'qiyu'))).toBe(join('..', '..', '.agents', 'skills', 'qiyu'))
  })

  it('自指循环链接（ELOOP）不落四态：不覆盖、收敛进 warnings，安装照常完成', async () => {
    const src = makeSource()
    const agent = join(home, '.claude', 'skills')
    mkdirSync(agent, { recursive: true })
    // 链接目标就是自己 → realpath 解析 ELOOP（paths.ts 的 linkState 会照常抛出）。
    symlinkSync('qiyu', join(agent, 'qiyu'))

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(r.status).toBe('installed')
    expect(r.links).toHaveLength(1)
    expect(r.links[0]?.state).toBe('foreign')
    expect(r.warnings.some((w) => w.includes(join(agent, 'qiyu')))).toBe(true)
    expect(readlinkSync(join(agent, 'qiyu'))).toBe('qiyu')
  })

  it('~/.claude 是文件时 agentSkillDirs 抛 ENOTDIR：收敛进 warnings，安装照常完成', async () => {
    const src = makeSource()
    writeFileSync(join(home, '.claude'), '')

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(r.status).toBe('installed')
    expect(r.links).toEqual([])
    expect(r.warnings.some((w) => w.includes('agent'))).toBe(true)
    expect(existsSync(join(defaultEntityDir(home), 'SKILL.md'))).toBe(true)
  })

  it('默认探测到两个 agent 目录时各建一条 ok 链接', async () => {
    const src = makeSource()
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(home, '.codex', 'skills'), { recursive: true })

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(r.links).toEqual([
      { agent: 'claude-code', path: join(home, '.claude', 'skills', 'qiyu'), state: 'ok' },
      { agent: 'codex', path: join(home, '.codex', 'skills', 'qiyu'), state: 'ok' },
    ])
  })

  it('显式 entityDir：实体装到指定位置（Task 11 的 --dir / QIYU_SKILL_DIR 通道）', async () => {
    const src = makeSource()
    const entity = join(home, 'custom', 'qiyu')
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })

    const r = await installSkill({
      home, sourceDir: src, version: '1.2.3', force: false, entityDir: entity,
    })

    expect(r.entityDir).toBe(entity)
    expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# qiyu\n')
    // 链接名取实体目录名，链接仍指向这个自定义实体。
    expect(readlinkSync(join(home, '.claude', 'skills', 'qiyu'))).toBe(join('..', '..', 'custom', 'qiyu'))
  })
})

// —— 审查 B1：agent skills 目录本身是符号链接（stow/dotfiles 布局）——
describe('B1：agent skills 目录是符号链接时的建链', () => {
  it('链接建在真实落点里、指向实体、state=ok（链接内容按真实落点的前缀算）', async () => {
    const src = makeSource()
    // dotfiles 布局：~/.claude/skills 本身是一个符号链接，真实落点在别处。
    // ⚠️ 真实落点的层级数必须与字面路径（`.claude/skills`，home 下 2 级）**不同**
    // （这里 home/dotfiles/claude-skills 也是 2 级）：同一深度下两种算法算出的相对
    // 路径恰好相同，用例就分不出实现了（实测过这条用例第一版正是如此，变异存活）。
    // 3 级深 → 字面算法差一级 `..`，链接必然解析不到。
    const dotfiles = join(home, 'dotfiles', 'nested', 'claude-skills')
    mkdirSync(dotfiles, { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    symlinkSync(dotfiles, join(home, '.claude', 'skills'))

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    // 链接建在真实落点下（不是字面路径下）。
    const linkPath = join(dotfiles, 'qiyu')
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true)
    // 链接内容必须按**真实落点**的前缀算：相对 linkTarget(真实落点, 实体)。
    expect(readlinkSync(linkPath)).toBe(linkTarget(dotfiles, defaultEntityDir(home)))
    // 关键：它必须真的解析到实体目录（修复前指向不存在的路径、linkState 却报 ok）。
    expect(realpathSync(linkPath)).toBe(realpathSync(defaultEntityDir(home)))
    // links[].path 沿用 agent 目录的**字面**路径（与 `agentSkillDirs` / where 的
    // 报告口径一致）：字面路径顺着符号链接正好落到真实落点里的链接，state 如实为 ok。
    expect(r.links).toEqual([{
      agent: 'claude-code', path: join(home, '.claude', 'skills', 'qiyu'), state: 'ok',
    }])
    expect(linkState(r.links[0]!.path, defaultEntityDir(home))).toBe('ok')
    expect(r.warnings.filter((w) => !w.includes(NO_LINK_HINT))).toEqual([])
  })

  it('实体目录在 home 之外（另一棵树上）时同样能建出可解析的链接', async () => {
    const src = makeSource()
    const dotfiles = join(home, 'dotfiles', 'nested', 'claude-skills')
    mkdirSync(dotfiles, { recursive: true })
    mkdirSync(join(home, '.claude'), { recursive: true })
    symlinkSync(dotfiles, join(home, '.claude', 'skills'))
    // 实体放在 home 之外（前缀深度与 agent 目录不同——修复前会算错相对路径）。
    const entity = join(tmpdir(), `qiyu-entity-outside-${process.pid}`)
    rmSync(entity, { recursive: true, force: true })

    try {
      const r = await installSkill({
        home, sourceDir: src, version: '1.2.3', force: false, entityDir: entity,
      })
      const linkPath = join(dotfiles, 'qiyu')
      expect(realpathSync(linkPath)).toBe(realpathSync(entity))
      expect(r.links[0]?.state).toBe('ok')
    } finally {
      rmSync(entity, { recursive: true, force: true })
    }
  })

  it('建链成功但复核不通过时不得报 ok（如实记 dangling + 警告）', async () => {
    const src = makeSource()
    const agent = join(home, '.claude', 'skills')
    mkdirSync(agent, { recursive: true })

    // 故障注入：symlink 实际建出的是一条解析不到目标的链接（模拟「建链调用成功、
    // 但 agent 加载不到」的形态——B1 的第二道保险要拦的就是这个）。
    fsSymlinkFault.set(true)
    try {
      const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })
      // 不得谎报 ok。
      expect(r.links[0]?.state).not.toBe('ok')
      expect(r.links[0]?.state).toBe('dangling')
      expect(r.warnings.some((w) => w.includes('复核'))).toBe(true)
    } finally {
      fsSymlinkFault.set(false)
    }
  })
})

// —— 审查 B2：实体目录跨文件系统 ——
describe('B2：实体目录跨设备时的写盘', () => {
  it('暂存目录落在实体的真实落点旁（与实体同设备），写盘不再 EXDEV', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return // root 下 chmod 不拦写入
    const src = makeSource()
    const entity = defaultEntityDir(home)
    // 让实体目录是一个指向别处的符号链接（网盘/大盘的形态）。
    const real = join(home, 'bigdisk', 'qiyu')
    mkdirSync(join(home, '.agents', 'skills'), { recursive: true })
    mkdirSync(real, { recursive: true })
    symlinkSync(real, entity)

    // 把「实体目录的字面父目录」锁成只读：暂存位若按字面路径建（修复前），这里
    // 直接 EACCES；修复后暂存落在实体的**真实落点**旁（bigdisk/），不受影响。
    // 这条断言不依赖「真的有两个设备」——它钉的是「暂存位建在哪」这个事实。
    const literalParent = join(home, '.agents', 'skills')
    chmodSync(literalParent, 0o555)
    try {
      const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

      // 正文真的写进了实体的真实落点。
      expect(readFileSync(join(real, 'SKILL.md'), 'utf8')).toBe('# qiyu\n')
      expect(r.status).toBe('installed')
      // 没有 EXDEV 降级（说明暂存与实体同设备，rename 直接成功）。
      expect(r.warnings.some((w) => w.includes('EXDEV'))).toBe(false)
      // 字面父目录里没有留下任何暂存目录（暂存位不在这里）。
      expect(readdirSync(literalParent).filter((n) => n.includes('.tmp-'))).toEqual([])
    } finally {
      chmodSync(literalParent, 0o755)
    }
  })

  it('rename 抛 EXDEV 时降级为「复制 → 删源」，内容仍写进去并如实警告', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    // 直接构造「实体已存在」的形态（不调用安装）：--force 的换入路径才走逐文件 rename。
    write(entity, 'SKILL.md', '# 旧版\n')
    write(entity, 'protocols.md', '旧协议\n')
    write(entity, 'references/deep.md', '旧引用\n')
    write(entity, MANIFEST, JSON.stringify({
      version: '0.9.0', skill_contract_version: SKILL_CONTRACT_VERSION,
      content_hash: 'stale', installed_at: new Date().toISOString(),
      files: ['SKILL.md', 'protocols.md', 'references/deep.md'],
    }))

    // 模拟跨设备：让 rename 对「换入暂存文件」的那次调用抛 EXDEV。
    // ⚠️ `vi.spyOn` 对 `node:fs` 这种不可重定义的内置命名空间无效（`Cannot redefine
    // property`），只能整体 mock。`vi.doMock` + `vi.resetModules` 会换掉本文件其余
    // 用例用的模块实例（实测污染），所以本用例改用本文件顶层已经 `vi.mock` 好的
    // 那份模块（见文件末尾的 mock 声明），用开关控制桩是否生效。
    fsRenameFault.set('EXDEV')
    try {
      const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })
      // 内容真的换进去了（降级路径有效）。
      expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# qiyu\n')
      expect(r.status).toBe('updated')
      // 降级不是原子的，必须说出来。
      expect(r.warnings.some((w) => w.includes('EXDEV'))).toBe(true)
    } finally {
      fsRenameFault.set(null)
    }
  })

  it('一个文件都没写成功时 status 不得报 updated（审查 #54/B2）', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return // root 下 chmod 不拦写入
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    const before = contentHash(entity)
    write(src, 'SKILL.md', '# 新版包内容\n')

    // 实体目录与它的子目录都只读 → 换入的 rename 全部 EACCES（审查 #54 的复现形态）。
    // 两个层级都锁：子目录仍是 755 时 `references/deep.md` 能换入，就不是「零写入」。
    chmodSync(join(entity, 'references'), 0o555)
    chmodSync(entity, 0o555)
    try {
      const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

      // 实体零变化：status 必须如实反映（skipped，不是 updated）。
      expect(r.status).toBe('skipped')
      expect(r.plannedStatus).toBe('updated')
      expect(r.warnings.some((w) => w.includes('一个文件都没有写进去'))).toBe(true)
      // 清单保持上一版、正文一个字节没变（注：只读锁要在 finally 里解除）。
      expect(readManifest(entity).version).toBe('1.0.0')
      expect(contentHash(entity)).toBe(before)
      expect(readFileSync(join(entity, 'SKILL.md'), 'utf8')).toBe('# qiyu\n')
    } finally {
      chmodSync(entity, 0o755)
      chmodSync(join(entity, 'references'), 0o755)
    }
  })
})

// —— 审查 B3：装了 Agent 但没有 skills 子目录 ——
describe('B3：零链接时的如实提示', () => {
  it('装了 Agent 根目录但缺 skills 子目录：提示建链方法，不替用户创建目录', async () => {
    const src = makeSource()
    mkdirSync(join(home, '.claude'), { recursive: true }) // 装了 Agent，但没建过 skills

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(r.links).toEqual([])
    expect(r.warnings.some((w) => w.includes('skills 子目录'))).toBe(true)
    expect(r.warnings.some((w) => w.includes(join(home, '.claude', 'skills')))).toBe(true)
    // 不替用户创建目录（spec D1）。
    expect(existsSync(join(home, '.claude', 'skills'))).toBe(false)
    // 实体照常装好。
    expect(readFileSync(join(defaultEntityDir(home), 'SKILL.md'), 'utf8')).toBe('# qiyu\n')
  })

  it('完全没有 Agent：也提示「skill 不会被任何 Agent 加载」', async () => {
    const src = makeSource()

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(r.links).toEqual([])
    expect(noLinkWarnCount(r.warnings)).toBe(1)
    expect(r.warnings[0]).toContain('skill 不会被任何 Agent 加载')
  })

  it('--no-link 时不提零链接（用户明确不要链接）', async () => {
    const src = makeSource()
    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false, noLink: true })
    expect(noLinkWarnCount(r.warnings)).toBe(0)
  })
})

// —— 审查 #2：实体缺失时「指向别处」的链接是 foreign，不是 dangling ——
describe('#2：linkState 在实体缺失时的四态', () => {
  it('链接指向别处且目标存在、实体不存在 → foreign（不是 dangling）', async () => {
    const agent = join(home, '.claude', 'skills')
    mkdirSync(agent, { recursive: true })
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(agent, 'qiyu'))
    const entity = join(home, '.agents', 'skills', 'qiyu') // 不存在

    expect(linkState(join(agent, 'qiyu'), entity)).toBe('foreign')
  })

  it('安装时遇到这种链接：不覆盖、不重建（与 where 结论一致）', async () => {
    const src = makeSource()
    const agent = join(home, '.claude', 'skills')
    mkdirSync(agent, { recursive: true })
    const elsewhere = join(home, 'elsewhere')
    mkdirSync(elsewhere)
    symlinkSync(elsewhere, join(agent, 'qiyu'))

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(r.links[0]?.state).toBe('foreign')
    // 用户那条链接原样保留（没被删、没被重建）。
    expect(readlinkSync(join(agent, 'qiyu'))).toBe(elsewhere)
  })
})

// —— 审查 #3：重建 dangling 链接时必须说出原链接内容 ——
describe('#3：重建悬空链接时的如实报告', () => {
  it('重建前先读出原链接内容并写进警告', async () => {
    const src = makeSource()
    const agent = join(home, '.claude', 'skills')
    mkdirSync(agent, { recursive: true })
    const mine = join(home, 'my-own-skill')
    symlinkSync(mine, join(agent, 'qiyu')) // 目标不存在 → dangling

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    const w = r.warnings.find((x) => x.includes('重建'))
    expect(w).toBeDefined()
    expect(w).toContain(mine)
  })
})

// —— 审查 #4：SIGKILL 残留的暂存目录 ——
describe('#4：崩溃残留的暂存目录清理', () => {
  it('安装开始时清掉同前缀的**过期**旧暂存目录（年轻的不动，见 gap 8）', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    // 模拟 SIGKILL 留下的残留：<实体名>.tmp-XXXXXX，且已经放了很久。
    const stale = `${entity}.tmp-AbCdEf`
    mkdirSync(stale, { recursive: true })
    writeFileSync(join(stale, 'SKILL.md'), '半截正文\n')
    // 终审 F3 + 复审 N2：真正的暂存位带**旁挂**独占标记（`<staging>.marker`），
    // 清理只认带标记的目录（名字形状挡不住用户的 `qiyu.tmp-backup/`，而标记放目录里
    // 又有被源正文撞名的污染路径）。这里照实模拟本模块自己的残留。
    writeFileSync(`${stale}.marker`, STAGING_MARKER_CONTENT)
    // ⚠️ 必须把 mtime 拨老：清理按年龄判（gap 8 —— 年轻的可能是另一个并发安装正在写的，
    // 无差别删会把它打成 ENOENT / 「暂存内容与源不一致」）。
    const longAgo = new Date(Date.now() - 60 * 60_000)
    utimesSync(stale, longAgo, longAgo)

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(existsSync(stale)).toBe(false)
    expect(r.warnings.some((w) => w.includes('残留的暂存目录'))).toBe(true)
  })

  it('年轻的同前缀暂存目录不清理（可能是另一个并发安装正在写）', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    const young = `${entity}.tmp-Young1`
    mkdirSync(young, { recursive: true })
    writeFileSync(join(young, 'SKILL.md'), '正在写\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(existsSync(young), '年轻暂存目录被误删 —— 并发安装会撞 ENOENT').toBe(true)
    expect(r.warnings.some((w) => w.includes('残留的暂存目录'))).toBe(false)
  })

  it('源目录里恰好有 `.qiyu-staging` 时不得污染实体（复审 N2：标记在目录里会被撞名）', async () => {
    const src = makeSource()
    // 极端但可达：源正文里有一篇叫 `.qiyu-staging` 的文件。
    write(src, '.qiyu-staging', '用户自己的内容\n')
    const entity = defaultEntityDir(home)

    const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })
    expect(r.status).toBe('installed')
    // 该文件必须**被正常安装**（不能因为撞名被静默丢弃），且内容原样。
    expect(readFileSync(join(entity, '.qiyu-staging'), 'utf8')).toBe('用户自己的内容\n')
    // 实体哈希与源一致 → 后续安装不会被永远判「内容不同」。
    expect(contentHash(entity)).toBe(contentHash(src))
    // 幂等：第二次安装没有「内容不同」的假警告。
    const again = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })
    expect(again.status).toBe('skipped')
    expect(again.warnings).toEqual([])
  })

  it('同前缀但**没有独占标记**的用户目录不得删除（终审 F3：名字形状挡不住 qiyu.tmp-backup）', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    // 用户的备份目录，恰好长得像暂存目录（`backup` 也是 6 位字母数字，收紧后缀也挡不住），
    // 且很久没动过（年龄守卫会放行）。唯一能区分它的是：它没有本模块写的标记文件。
    const mine = `${entity}.tmp-backup`
    mkdirSync(mine, { recursive: true })
    writeFileSync(join(mine, 'important.md'), '用户自己的数据\n')
    const longAgo = new Date(Date.now() - 24 * 60 * 60_000)
    utimesSync(mine, longAgo, longAgo)

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(existsSync(join(mine, 'important.md')), '用户目录被当成崩溃残留删掉了').toBe(true)
    // 也不能谎称「清理了残留」——它根本没被清理。
    expect(r.warnings.some((w) => w.includes('残留的暂存目录'))).toBe(false)
  })

  it('不碰名字不像暂存目录的兄弟目录', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    const sibling = `${entity}-backup`
    mkdirSync(sibling, { recursive: true })
    writeFileSync(join(sibling, 'SKILL.md'), '用户自己的东西\n')

    await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(existsSync(join(sibling, 'SKILL.md'))).toBe(true)
  })
})

// —— 审查 #59：清单 files 被篡改不得删掉用户文件 ——
describe('#59：清单 files 被篡改时的清理保护', () => {
  it('清单里多出一条用户文件：不被删，并有警告', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    // 用户自己的笔记。
    write(entity, 'mine.md', 'my notes\n')
    // 篡改清单：把用户文件登记成「上一版受管文件」，并把版本改旧。
    const m = readManifest(entity)
    writeFileSync(join(entity, MANIFEST), JSON.stringify({
      ...m, version: '0.0.1', files: [...(m.files ?? []), 'mine.md'],
    }))
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    // 用户文件不被删（清单的 files 只是「声明」，不是「证据」）。
    expect(readFileSync(join(entity, 'mine.md'), 'utf8')).toBe('my notes\n')
    // 如实说明为什么没删。
    expect(r.warnings.some((w) => w.includes('mine.md') && w.includes('保留'))).toBe(true)
    // 警告里不能说谎（「移除了上一版安装的文件」）。
    expect(r.warnings.some((w) => w.includes('移除了上一版安装、本版不再包含的文件：mine.md'))).toBe(false)
  })

  it('用户改过上一版受管文件的内容：也不删（哈希对不上）', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    // 用户改了自己那份 protocols.md。
    write(entity, 'protocols.md', '用户改过的协议\n')
    // 新版包删掉 protocols.md → 本该被清理，但用户改过 → 保留。
    rmSync(join(src, 'protocols.md'))
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    expect(readFileSync(join(entity, 'protocols.md'), 'utf8')).toBe('用户改过的协议\n')
    expect(r.warnings.some((w) => w.includes('protocols.md') && w.includes('保留'))).toBe(true)
  })

  it('未被改动的上一版受管文件仍然会被清理（哈希对得上）', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    rmSync(join(src, 'references'), { recursive: true })
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    expect(existsSync(join(entity, 'references', 'deep.md'))).toBe(false)
    expect(r.warnings.some((w) => w.includes('移除了上一版安装、本版不再包含的文件'))).toBe(true)
  })
})

// —— 审查 #53：实体不可读时，dry-run 不得预告 updated ——
describe('#53：实体不可读时的计划如实性', () => {
  it('实体目录不可读（列不出内容）：即便 --force 也不预告 updated', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return // root 下 chmod 不拦读取
    const src = makeSource()
    const entity = defaultEntityDir(home)
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    chmodSync(entity, 0o000)
    try {
      const plan = planInstall({ entityDir: entity, sourceDir: src, version: '1.1.0', force: true })
      // 计划不能承诺一个必然失败的 updated。
      expect(plan.status).not.toBe('updated')
      expect(plan.action).toBe('none')
      expect(plan.warnings.some((w) => w.includes('读取实体目录失败'))).toBe(true)
    } finally {
      chmodSync(entity, 0o755)
    }
  })

  it('实体里单个文件不可读（目录仍可读）：--force 仍能覆盖（审查 I4 的既有语义）', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return
    const src = makeSource()
    const entity = defaultEntityDir(home)
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    chmodSync(join(entity, 'SKILL.md'), 0o000)
    write(src, 'SKILL.md', '# 新版包内容\n')
    try {
      const plan = planInstall({ entityDir: entity, sourceDir: src, version: '1.1.0', force: true })
      expect(plan.status).toBe('updated')
      expect(plan.action).toBe('write')
    } finally {
      chmodSync(join(entity, 'SKILL.md'), 0o644)
    }
  })
})

// —— 审查 #23：用户把受管文件换成非普通文件时不得删除 ——
describe('#23：受管文件被换成非普通文件时的保护', () => {
  it('上一版受管文件被换成符号链接：保留不动并警告', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    // 用户把 references/deep.md 换成指向个人笔记的符号链接。
    const personal = join(home, 'personal-notes')
    mkdirSync(personal, { recursive: true })
    writeFileSync(join(personal, 'deep.md'), '我的个人笔记\n')
    rmSync(join(entity, 'references', 'deep.md'))
    symlinkSync(join(personal, 'deep.md'), join(entity, 'references', 'deep.md'))
    // 新版包删掉 references/deep.md → 上一版清单登记过它，本该被清理。
    rmSync(join(src, 'references'), { recursive: true })
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    // 链接本身与它指向的个人文件都原样保留。
    expect(lstatSync(join(entity, 'references', 'deep.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(personal, 'deep.md'), 'utf8')).toBe('我的个人笔记\n')
    expect(r.warnings.some((w) => w.includes('非普通文件'))).toBe(true)
  })
})

// —— 审查 #37：清单里的 Windows 反斜杠逃逸条目 ——
describe('#37：清单 files 里的反斜杠路径按分隔符处理', () => {
  it('`..\\..\\..\\evil.txt` 这类条目让整份清单不可信：不删任何文件', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    // 实体目录是 home/.agents/skills/qiyu，三级 `..` 正好回到 home。
    const outside = join(home, 'evil.txt')
    writeFileSync(outside, '用户自己的文件\n')
    // 篡改清单：追加一条 Windows 写法的逃逸条目（POSIX 上它只是一串含反斜杠的
    // 文件名——若只把 '/' 当分隔符，这一条会被当成合法的单段名字放行）。
    const m = readManifest(entity)
    writeFileSync(join(entity, MANIFEST), JSON.stringify({
      ...m, version: '0.0.1', files: [...(m.files ?? []), '..\\..\\..\\evil.txt'],
    }))
    // 新版包不再包含 references → 一份可信清单下本该被清理。
    rmSync(join(src, 'references'), { recursive: true })
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    // 实体之外的用户文件原样保留。
    expect(readFileSync(outside, 'utf8')).toBe('用户自己的文件\n')
    // 非法条目 ⇒ 整份清单按「不可信」处理：连真实受管文件也不删（宁留不删）。
    expect(existsSync(join(entity, 'references', 'deep.md'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('移除了上一版安装'))).toBe(false)
    // 如实说明这些文件为什么还在（清单不可信时按「无法确认上一版」口径报告）。
    expect(r.warnings.some((w) => w.includes('不在包内的文件'))).toBe(true)
  })
})

// —— 审查 #40：d_type=DT_UNKNOWN 的文件系统上补 lstat 归类 ——
describe('#40：withFileTypes 给出空壳 Dirent 时的类型归类', () => {
  it('空壳 Dirent 下 contentHash 仍能看见文件与子目录（补 lstat）', () => {
    const dir = join(home, 'd')
    write(dir, 'a.md', 'A\n')
    write(dir, 'sub/b.md', 'B\n')
    // 符号链接不算受管正文（正常路径下也被忽略），开着开关时同样要忽略。
    symlinkSync(join(dir, 'a.md'), join(dir, 'link.md'))
    const empty = join(home, 'empty')
    mkdirSync(empty)
    const emptyHash = contentHash(empty)
    const expected = contentHash(dir)
    expect(expected).not.toBe(emptyHash) // 基线非空，否则下面的比较没有意义

    fsReaddirFault.set(true)
    try {
      expect(contentHash(dir)).toBe(expected)
    } finally {
      fsReaddirFault.set(false)
    }
  })
})

// —— G8（gap 8）：并发 install 的两类故障 ——
//
// 实测（6 进程 × 3 轮，修前 13/18 次失败）有两**类**互不相干的失败，修法也不同：
//   ① ENOTEMPTY：两个进程都判「实体不存在」，一个先建出来，另一个 rename 撞非空目录。
//   ② 自伤：B 的崩溃残留清理把 **A 正在写的**暂存目录当成「上次中断的残留」删掉，
//      于是 A 的 copyTree 撞 ENOENT、或哈希校验报「暂存内容与源不一致」。
// 两条用例分别钉住，且都做变异验证（去掉对应修复 → 红）。
describe('并发安装（gap 8）', () => {
  it('① 首次换入撞 ENOTEMPTY（另一进程先建出实体）→ 不报失败，按实体实际状态收敛', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)

    // 模拟真实竞态：本进程判「实体不存在」→ 另一进程在这瞬间把实体建好并写完 →
    // 本进程的整目录 rename 撞 ENOTEMPTY。用 mock 在**抛错的同时**把实体建出来，
    // 精确复现「错误发生时实体已在」这一状态（否则重判定只会看到空目录，与真实竞态不同）。
    fsRenameFault.set('ENOTEMPTY')
    try {
      const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })
      // 关键断言：不把并发当成失败。
      expect(r.status).toBe('skipped')
      expect(r.warnings.some((w) => w.includes('并发'))).toBe(true)
      // 判别力（终审 F1/F6）：mock 的「另一进程」只写了一份**内容不同**的 SKILL.md，
      // 所以文案必须如实说「仍不同」。旧断言只查 includes('并发')，两个分支都含这二字、
      // 永远绿，抓不到「内容不同却报一致」的谎报。
      expect(r.warnings.some((w) => w.includes('仍不同')), '内容不同时必须报「仍不同」').toBe(true)
      expect(r.warnings.some((w) => w.includes('内容与包内一致')), '内容不同时不得报「一致」').toBe(false)
      // 绝不能出现「安装失败」这类让 Agent 去重装的措辞。
      expect(r.warnings.some((w) => w.includes('安装失败'))).toBe(false)
      // 判别力（复审 F6 残留）：上一版只钉住「内容不同 → 必须说仍不同」，对 **status** 那一半
      // 零约束（把 `status = 'skipped'` 改回 `status = replan.status` 时用例仍全绿）。
      expect(r.status, '本进程零写入，status 不得是 updated/installed').toBe('skipped')
    } finally {
      fsRenameFault.set(null)
    }
    // 同一竞态、`force: true`：旧实现会把零写入报成 updated（终审 F1 的另一半）。
    // 必须先删掉实体，才走「判实体不存在 → rename 撞 ENOTEMPTY」这条并发分支。
    rmSync(entity, { recursive: true, force: true })
    fsRenameFault.set('ENOTEMPTY')
    try {
      const rf = await installSkill({ home, sourceDir: src, version: '1.0.0', force: true, noLink: true })
      // 变异「status 改回 replan.status」→ 本行红（那时 replan 是 force 分支的 updated）。
      expect(rf.status, 'force 下本进程仍零写入，不得谎报 updated').toBe('skipped')
      expect(rf.warnings.some((w) => w.includes('仍不同'))).toBe(true)
    } finally {
      fsRenameFault.set(null)
    }

    // 无论 mock 期间实体建没建出来，实体都必须是**可诊断、可收敛**的：
    // 不加 --force 时如实报告内容不同（不谎报成功），加 --force 后内容与包内一致。
    // （上面 mock 的「另一进程」只写了 SKILL.md 且没有清单，是模拟它的不完整成果。）
    const blocked = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })
    expect(blocked.status).toBe('skipped')
    expect(blocked.warnings.some((w) => w.includes('--force'))).toBe(true)

    const forced = await installSkill({ home, sourceDir: src, version: '1.0.0', force: true, noLink: true })
    expect(forced.status).toBe('updated')
    expect(contentHash(entity)).toBe(contentHash(src))
  })

  it('⑨ 并发赢家是不可读目录 → 文案必须指引「按警告处理」，不得劝 --force（复审 N3：这条文案零覆盖）', async () => {
    if (process.platform === 'win32' || process.getuid?.() === 0) return  // root / Windows 下 chmod 不拦读取
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(dirname(entity), { recursive: true })

    fsRenameFault.set('ENOTEMPTY_UNREADABLE')
    let r
    try {
      r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })
    } finally {
      fsRenameFault.set(null)
      try { chmodSync(entity, 0o755) } catch { /* 实体可能没建出来 */ }
    }
    const joined = r.warnings.join('\n')
    // 变异「并发文案整体退回旧文本」→ 本行红。
    expect(joined, '目录不可读时不得劝用户加 --force').not.toContain('加 --force')
    expect(joined, '必须指引用户按上面那条警告处理').toContain('按上面那条警告')
  })

  it('⑦ 标记内容必须**逐字**相等：前缀/包含关系不算（复审 N1：谓词强度要有人钉）', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(dirname(entity), { recursive: true })
    // 内容以我们的标记开头、但后面多了东西 —— 不是我们写的那个文件。
    const nearMiss = join(dirname(entity), `${entity.split('/').pop()}.tmp-NearMiss`)
    mkdirSync(nearMiss)
    writeFileSync(join(nearMiss, 'SKILL.md'), 'x\n')
    writeFileSync(`${nearMiss}.marker`, STAGING_MARKER_CONTENT.trimEnd() + ' 额外内容\n')
    const longAgo = new Date(Date.now() - 24 * 60 * 60_000)
    utimesSync(nearMiss, longAgo, longAgo)
    utimesSync(`${nearMiss}.marker`, longAgo, longAgo)

    const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })

    // 变异「`===` 改成 `includes` / `startsWith`」→ 这个目录会被当残留删掉 → 红。
    expect(existsSync(join(nearMiss, 'SKILL.md')), '仅内容前缀相同的目录被误删').toBe(true)
    expect(r.warnings.some((w) => w.includes('残留'))).toBe(false)
  })

  it('⑧ 标记文件超大时不得整读（复审 N5：postinstall 的自动安装也走这条路）', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(dirname(entity), { recursive: true })
    const big = join(dirname(entity), `${entity.split('/').pop()}.tmp-BigFile`)
    mkdirSync(big)
    writeFileSync(join(big, 'SKILL.md'), 'x\n')
    // 8MB：远超标记大小，函数应直接按「不是我们的」处理而不整读。
    writeFileSync(`${big}.marker`, Buffer.alloc(8 * 1024 * 1024, 0x61))
    const longAgo = new Date(Date.now() - 24 * 60 * 60_000)
    utimesSync(big, longAgo, longAgo)
    utimesSync(`${big}.marker`, longAgo, longAgo)

    fsReadLog.set(true)
    try {
      const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })
      expect(r.status).toBe('installed')
    } finally {
      fsReadLog.set(false)
    }

    // 目录与文件都保留（不是我们的）。
    expect(existsSync(join(big, 'SKILL.md')), '用户的大目录被当成残留删了').toBe(true)
    expect(existsSync(`${big}.marker`), '用户的大文件被当成孤儿标记删了').toBe(true)
    // 关键断言（复审 N5，判别力靠「读没读」而不是耗时 —— 时间断言对 8MB 没有判别力）：
    // 大于 4096 字节的标记必须在 isOurMarker 里被 size 守卫挡下、**一次都不读**。
    expect(fsReadLog.paths, '8MB 同名文件被整读了（size 守卫失效）')
      .not.toContain(`${big}.marker`)
  })

  it('⑥ 注入一个**未登记**的 ENOTEMPTY 变体时 mock 不得静默失效（复审 N2：兜底用集合反判）', async () => {
    const src = makeSource()
    // 只有把兜底写成 `!ENOTEMPTY_KINDS.has(kind)`，这个变体才会被拦（渲染成 EACCES 语义的
    // 通用分支）。旧写法 `!kind.startsWith('ENOTEMPTY')` 下它既不进并发分支也不进兜底，
    // 直接走真实 renameSync —— mock 静默失效、用例照常绿。
    fsRenameFault.set('ENOTEMPTY_UNREGISTERED')
    try {
      // mock 生效 ⇒ 换入被拦、安装以错误终止（EACCES 语义的通用分支）。
      // 若兜底写成 `!kind.startsWith('ENOTEMPTY')`，这个变体会直接走真实 renameSync，
      // 于是安装**成功**、本断言失败 —— 正是要抓的「mock 静默失效」。
      await expect(
        installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true }),
      ).rejects.toThrow(/EACCES|permission denied/)
    } finally {
      fsRenameFault.set(null)
    }
  })

  it('④ 并发赢家正文一致、但清单被目录占用 → 不得劝 --force（复审 W3：--force 对此无效）', async () => {
    const src = makeSource()
    // 实体初始必须**不存在**（否则 plan 直接是 action='none'，根本走不到写入/并发分支）。
    // mock 在撞 ENOTEMPTY 的瞬间把「正文与源逐字节一致 + 清单位置被目录占用」的结果落到磁盘。
    const entity = defaultEntityDir(home)
    mkdirSync(dirname(entity), { recursive: true })

    fsRenameFault.set('ENOTEMPTY_MANIFEST_DIR')
    try {
      const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })
      expect(r.status).toBe('skipped')
      const joined = r.warnings.join('\n')
      // 变异「不区分 manifestBlocked」→ 会落到「内容仍不同（…）；…加 --force」分支 → 红。
      expect(joined, '正文一致时不得说「仍不同」').not.toContain('仍不同')
      expect(joined, '清单被占用时 --force 无效，不得劝用户用它').not.toContain('加 --force')
      expect(joined).toContain('非普通文件占用')
    } finally {
      fsRenameFault.set(null)
    }
  })

  it('⑤ 并发赢家完全一致（正文与清单都一致）→ 必须说「内容与包内一致」（复审 W4：正向文案零覆盖）', async () => {
    const src = makeSource()
    // mock 在撞 ENOTEMPTY 的瞬间把「与包内完全一致的实体（正文 + 新清单）」落到磁盘。
    const entity = defaultEntityDir(home)
    mkdirSync(dirname(entity), { recursive: true })

    fsRenameFault.set('ENOTEMPTY_EXACT')
    try {
      const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })
      expect(r.status).toBe('skipped')
      const joined = r.warnings.join('\n')
      // 变异「sameContent 恒 false（永远说仍不同）」→ 本行红：正向「一致」文案有人钉。
      expect(joined, '完全一致时必须说「内容与包内一致」').toContain('内容与包内一致')
      expect(joined).not.toContain('仍不同')
      // ⚠️ 不能只查「内容与包内一致」——它也是「仅清单落后」文案的公共子串（复审 W4）。
      // 完全一致时不得落到那条分支。
      expect(joined, '完全一致时不得说「清单落后」').not.toContain('清单落后')
    } finally {
      fsRenameFault.set(null)
    }
  })

  it('② 崩溃残留清理不得删掉「正被并发安装使用」的暂存目录（按年龄判）', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(dirname(entity), { recursive: true })

    // 造一个「刚刚创建、还年轻」的暂存目录：代表另一个正在跑的 install。
    const young = join(dirname(entity), `${entity.split('/').pop()}.tmp-ABC123`)
    mkdirSync(young)
    write(young, 'SKILL.md', '# 另一个进程正在写\n')
    // ⚠️ 必须带标记：不带的话第一循环在标记判据处就跳过，**年龄**判据没人钉
    // （复审实测：去掉年龄守卫用例仍绿 —— 正是因为年轻夹具缺标记）。
    writeFileSync(`${young}.marker`, STAGING_MARKER_CONTENT)

    // 造一个「很久以前」的残留目录：mtime 拨回 1 小时前，且带本模块的独占标记。
    const old = join(dirname(entity), `${entity.split('/').pop()}.tmp-OLD999`)
    mkdirSync(old)
    write(old, 'SKILL.md', '# 上次崩溃的残留\n')
    writeFileSync(`${old}.marker`, STAGING_MARKER_CONTENT)
    const longAgo = new Date(Date.now() - 60 * 60_000)
    utimesSync(old, longAgo, longAgo)

    const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })

    // 年轻的没被删（它可能正被另一个进程写）。
    expect(existsSync(young), '年轻暂存目录被误删 —— 会把并发安装的 copyTree 打成 ENOENT').toBe(true)
    // 老的被清掉了，且如实告知。
    expect(existsSync(old), '过期残留目录没被清理').toBe(false)
    expect(r.warnings.some((w) => w.includes('残留的暂存目录'))).toBe(true)
    // 复审 W1：旁挂标记本身满足 isStagingName 的前缀，枚举时不排除它就会在清理后
    // 对它再 lstat，多出一条假的「清理残留暂存目录失败（ENOENT）」。
    expect(r.warnings.some((w) => w.includes('失败')), JSON.stringify(r.warnings)).toBe(false)
  })

  it('②d 用户目录里恰好有个同名 `.marker`（内容不是我们的）不得被当成残留删除（复审 N1 的另一面）', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(dirname(entity), { recursive: true })
    // 用户的备份目录 + 它旁边一个同名文件（内容完全不同）。
    const mine = join(dirname(entity), `${entity.split('/').pop()}.tmp-backup`)
    mkdirSync(mine)
    writeFileSync(join(mine, 'important.md'), '用户自己的数据\n')
    writeFileSync(`${mine}.marker`, '用户自己的备注\n')
    const longAgo = new Date(Date.now() - 24 * 60 * 60_000)
    utimesSync(mine, longAgo, longAgo)
    utimesSync(`${mine}.marker`, longAgo, longAgo)

    const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })

    // 变异「isOurMarker 退回 existsSync」→ 这个目录会被当残留删掉 → 红。
    expect(existsSync(join(mine, 'important.md')), '用户目录被当成残留删除了').toBe(true)
    expect(existsSync(`${mine}.marker`), '用户的同名文件被当成孤儿标记删除了').toBe(true)
    expect(r.warnings.some((w) => w.includes('残留'))).toBe(false)
  })

  it('②c 用户自己的普通文件 `<实体>.tmp-*.marker` 不得被当成孤儿标记删除（复审 N1：判据必须认内容）', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(dirname(entity), { recursive: true })
    // 用户自己写的一个普通文件：名字满足「前缀 + .marker」，但内容不是我们的标记。
    const userFile = `${join(dirname(entity), `${entity.split('/').pop()}.tmp-MyNotes`)}.marker`
    writeFileSync(userFile, '我自己记的一段内容\n')
    const longAgo = new Date(Date.now() - 24 * 60 * 60_000)
    utimesSync(userFile, longAgo, longAgo)

    const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })

    expect(existsSync(userFile), '用户同名普通文件被静默删除了').toBe(true)
    expect(readFileSync(userFile, 'utf8')).toBe('我自己记的一段内容\n')
    expect(r.warnings).toEqual([])
  })

  it('②b 孤儿标记（目录已不在）按年龄清理（复审 W2：SIGKILL 落在 finally 两条 rmSync 之间）', async () => {
    const src = makeSource()
    const entity = defaultEntityDir(home)
    mkdirSync(dirname(entity), { recursive: true })
    // 孤儿标记：对应的暂存目录已经不存在。
    const orphan = `${join(dirname(entity), `${entity.split('/').pop()}.tmp-Orphan7`)}.marker`
    writeFileSync(orphan, STAGING_MARKER_CONTENT)
    const longAgo = new Date(Date.now() - 60 * 60_000)
    utimesSync(orphan, longAgo, longAgo)
    // 年轻的孤儿标记不动（可能与某次正在进行/即将开始的安装相关）。
    const youngOrphan = `${join(dirname(entity), `${entity.split('/').pop()}.tmp-Young77`)}.marker`
    writeFileSync(youngOrphan, STAGING_MARKER_CONTENT)

    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })

    expect(existsSync(orphan), '过期孤儿标记没被清理，会永久留在 skills 目录里').toBe(false)
    expect(existsSync(youngOrphan)).toBe(true)
  })

  it('③ 并发赢家只差清单（正文一致、清单版本落后）→ 不得说「内容仍不同（计划要求 --force）」', async () => {
    // 复审 F1 残留的第五形态：`consistent` 只看 `action === 'none'` 时，这一形态
    // （action='rewrite-manifest'、warnings 为空）会被误说成「内容仍不同」并劝用户加
    // --force，而实际重跑一次（不带 force）就能把清单补上。
    const src = makeSource()
    const entity = defaultEntityDir(home)

    fsRenameFault.set('ENOTEMPTY_STALE_MANIFEST')
    try {
      const r = await installSkill({ home, sourceDir: src, version: '1.0.0', force: false, noLink: true })
      expect(r.status).toBe('skipped')
      const joined = r.warnings.join('\n')
      // 变异「sameContent 退回只看 action === 'none'」→ 本行红（会报「仍不同（计划要求 --force）」）。
      expect(joined, '正文一致、仅清单落后时不得说「仍不同」').not.toContain('仍不同')
      // 只说「无需 --force」，不能说「加 --force」（文案里那句「无需 --force」是有意为之）。
      expect(joined, '也不得劝用户加 --force').not.toContain('加 --force')
      expect(joined).toContain('清单落后')
    } finally {
      fsRenameFault.set(null)
    }
  })
})

// —— G4/D3：cleanupPreviousManaged 的四层防御与「非普通文件」保护 ——
//
// `cleanupPreviousManaged` 有四层独立防御（审查 N1 系列）：① 清单解析校验
// （`readManifestSafe` 的 `isContainedRel`）② 清理处的 `isContainedRel`
// ③ `verifyPlainParents`（父链必须全是真实目录）④ `isRealpathContained`（真实落点仍在内）。
// 「非普通文件」检查（`st.isFile()`）是四层之外的第五条。
//
// ⚠️ **本组实测结论（写进报告）**：② 与 ④ 目前**不可单独触发**，删掉它们不会有红 ——
//   · ② 与 ① 是同一个函数、同一份输入：能过 ① 的必然能过 ②（反之亦然），清理处那次
//     调用是纯冗余；能触达 ② 的输入必须让 ① 放行（就不可能含非法条目）。
//   · ④ 只在「父链是真目录、终点路径却解析到实体外」时才拦得下，而那种形态必然让
//     终点不是普通文件（符号链接）→ 先被 `st.isFile()` 拦掉；硬链接的 realpath 仍在
//     实体内，④ 也拦不住。即 ④ 的可达触发面被③与非普通文件检查覆盖。
// 下面的用例因此钉住「每层的**可观测效果**」而非「每层都可单独变异」，并在报告里
// 逐条写明哪一层不可达、由谁兜底。
describe('D3.7：cleanupPreviousManaged 的四层防御', () => {
  /** 装一份清单 files 含 references/deep.md 的实体。 */
  async function seed(): Promise<string> {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    return src
  }
  /** 新版包：删掉 references/ 并改 SKILL.md → 逼出 updated（否则清理不跑）。 */
  function bump(src: string): void {
    rmSync(join(src, 'references'), { recursive: true, force: true })
    write(src, 'SKILL.md', '# 新版包内容\n')
  }

  it('第 ① 层（清单解析校验）：逃逸条目让整份清单不可信，同清单里的真实受管文件也不删', async () => {
    // 变异「readManifestSafe 去掉 `raw.files.every(... isContainedRel)` 检查」→ 本用例红
    // （逃逸条目被当合法条目，同一份清单里的 references/deep.md 会被删掉）。
    // ⚠️ 与 #37 的差别：#37 钉的是「实体外的 evil.txt 不被删」，本用例钉的是
    // 「整份清单按不可信处理 ⇒ 连真实受管文件也不删」（宁留不删的语义）。
    const src = await seed()
    const entity = defaultEntityDir(home)
    const m = readManifest(entity)
    writeFileSync(join(entity, MANIFEST), JSON.stringify({
      ...m, version: '0.0.1', files: [...(m.files ?? []), '..\\..\\..\\evil.txt'],
    }))
    bump(src)

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    expect(r.status).toBe('updated')
    expect(existsSync(join(entity, 'references', 'deep.md'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('移除了上一版安装'))).toBe(false)
  })

  it('第 ② 层（isContainedRel 的二次调用）：绝对路径条目同样让清单不可信，不删任何文件', async () => {
    // ⚠️ 如本组注释所述：② 与 ① 同源，删掉 ② 不会有红（不可达冗余）。本用例钉住的是
    // 这条判据的**可观测效果**（绝对路径 ⇒ 整份清单不可信 ⇒ 宁留不删），供将来若把
    // ① / ② 拆成两套判据时继续有效。
    const src = await seed()
    const entity = defaultEntityDir(home)
    const m = readManifest(entity)
    writeFileSync(join(entity, MANIFEST), JSON.stringify({
      ...m, version: '0.0.1', files: [...(m.files ?? []), join(home, 'abs-escape.md')],
    }))
    bump(src)

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    expect(r.status).toBe('updated')
    expect(existsSync(join(entity, 'references', 'deep.md'))).toBe(true)
    expect(r.warnings.some((w) => w.includes('移除了上一版安装'))).toBe(false)
  })

  it('第 ③ 层（verifyPlainParents）：父链是符号链接时拒绝删除，实体外文件原样', async () => {
    // 变异「cleanupPreviousManaged 去掉 verifyPlainParents 的两条分支」→ 哪些用例红？
    // 实测：单独删 ③ 时 N1-G1 与本条**都仍绿** —— `unlink` 会顺着 `references` 链接删到
    // 实体外，但那一步之前还有第 ④ 层（realpath 复核）拦下。所以 ③ 单独删除**不可判红**，
    // 它拦下的形态与 ④ 重叠（见报告「不可达/多余」一节，由控制器裁决）。
    // 本用例钉住该形态的**可观测结果**：实体外的个人文件、链接本身都原样，且有警告。
    const src = await seed()
    const entity = defaultEntityDir(home)
    const personal = join(home, 'personal-notes')
    mkdirSync(personal)
    writeFileSync(join(personal, 'deep.md'), '我的个人笔记\n')
    rmSync(join(entity, 'references'), { recursive: true })
    symlinkSync(personal, join(entity, 'references'))
    bump(src)

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    expect(r.status).toBe('updated')
    expect(readFileSync(join(personal, 'deep.md'), 'utf8')).toBe('我的个人笔记\n')
    expect(lstatSync(join(entity, 'references')).isSymbolicLink()).toBe(true)
    expect(r.warnings.some((w) => w.includes('references'))).toBe(true)
  })

  it('第 ④ 层（isRealpathContained）在正常形态下不误拦：真实受管文件照常被清理', async () => {
    // ⚠️ ④ 的**可达触发面实测为空**：能走到这里的路径，父链已过 ③（全真目录）、终点已过
    // `st.isFile()`（普通文件），此时 realpath 必然落在实体内。所以「删掉 ④ → 红」这条
    // 做不到（报告里有实测记录）。本用例钉住它的另一面：它**不会**把正常删除全拦死。
    const src = await seed()
    const entity = defaultEntityDir(home)
    bump(src)

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    expect(r.status).toBe('updated')
    expect(existsSync(join(entity, 'references', 'deep.md'))).toBe(false)
    expect(r.warnings.some((w) => w.includes('移除了上一版安装'))).toBe(true)
  })
})

// —— D3.1：cleanupPreviousManaged 的非普通文件保护（目录 / 符号链接都不得跟随删除） ——
describe('D3.1：受管文件被换成目录 / 实体外符号链接时的保护', () => {
  it('上一版受管文件被用户换成**目录**：--force 不删目录、不跟随，警告如实', async () => {
    // 变异「视图里去掉 `!st.isFile()` 分支（非普通文件照删）」→ 本用例红：
    // unlinkSync 对目录抛 EISDIR；若改成 rmSync 递归删，用户目录里的文件会消失。
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    rmSync(join(entity, 'references', 'deep.md'))
    mkdirSync(join(entity, 'references', 'deep.md'))
    writeFileSync(join(entity, 'references', 'deep.md', 'mine.txt'), '我的文件\n')
    rmSync(join(src, 'references'), { recursive: true })
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    expect(r.status).toBe('updated')
    expect(lstatSync(join(entity, 'references', 'deep.md')).isDirectory()).toBe(true)
    expect(readFileSync(join(entity, 'references', 'deep.md', 'mine.txt'), 'utf8')).toBe('我的文件\n')
    expect(r.warnings.some((w) => w.includes('非普通文件'))).toBe(true)
  })

  it('上一版受管文件被换成**指向实体外的符号链接**：不跟随、不删目标、链接原样', async () => {
    // 变异「lstatSync 换成 statSync（顺着链接走）」→ 本用例红（目标被当成受管文件删掉）。
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.0.0', force: false })
    const entity = defaultEntityDir(home)
    const outside = join(home, 'outside-precious.md')
    writeFileSync(outside, '实体外的珍贵文件\n')
    rmSync(join(entity, 'references', 'deep.md'))
    symlinkSync(outside, join(entity, 'references', 'deep.md'))
    rmSync(join(src, 'references'), { recursive: true })
    write(src, 'SKILL.md', '# 新版包内容\n')

    const r = await installSkill({ home, sourceDir: src, version: '1.1.0', force: true })

    expect(lstatSync(join(entity, 'references', 'deep.md')).isSymbolicLink()).toBe(true)
    expect(readFileSync(outside, 'utf8')).toBe('实体外的珍贵文件\n')
    expect(r.warnings.some((w) => w.includes('非普通文件'))).toBe(true)
  })
})
