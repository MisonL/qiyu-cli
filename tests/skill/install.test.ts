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

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  chmodSync, lstatSync, mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync, readFileSync,
  readlinkSync, symlinkSync, statSync, existsSync, realpathSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { contentHash, installSkill, MANIFEST, type Manifest } from '../../src/skill/install.js'
import { defaultEntityDir } from '../../src/skill/paths.js'
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
    expect(again.warnings).toEqual([])
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
    expect(fixed.warnings).toEqual([])
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

  it('dangling 链接：先删后建，重建为指向实体、state=ok', async () => {
    const src = makeSource()
    const agent = join(home, '.claude', 'skills')
    mkdirSync(agent, { recursive: true })
    // 指向一个不存在的目标 → dangling。
    symlinkSync(join(home, 'gone'), join(agent, 'qiyu'))

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })

    expect(r.links).toEqual([{ agent: 'claude-code', path: join(agent, 'qiyu'), state: 'ok' }])
    expect(r.warnings).toEqual([])
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
