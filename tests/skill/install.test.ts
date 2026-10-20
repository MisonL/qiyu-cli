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
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readlinkSync,
  symlinkSync, statSync, existsSync, realpathSync,
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

  it('--force 覆盖时清掉上一版遗留的文件，并如实警告（不静默删除）', async () => {
    const src = makeSource()
    await installSkill({ home, sourceDir: src, version: '1.2.3', force: false })
    const entity = defaultEntityDir(home)
    // 模拟新版包删掉了 references/deep.md。
    rmSync(join(src, 'references'), { recursive: true })

    const r = await installSkill({ home, sourceDir: src, version: '1.3.0', force: true })

    expect(r.status).toBe('updated')
    expect(existsSync(join(entity, 'references', 'deep.md'))).toBe(false)
    expect(r.warnings.some((w) => w.includes('deep.md'))).toBe(true)
    // 清理后目标哈希与源一致：下一次安装必须能回到 skipped。
    expect(readManifest(entity).content_hash).toBe(contentHash(src))
    const again = await installSkill({ home, sourceDir: src, version: '1.3.0', force: false })
    expect(again.status).toBe('skipped')
    expect(again.warnings).toEqual([])
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

  it('noLink：只放实体，不建任何链接', async () => {
    const src = makeSource()
    mkdirSync(join(home, '.claude', 'skills'), { recursive: true })

    const r = await installSkill({ home, sourceDir: src, version: '1.2.3', force: false, noLink: true })

    expect(r.links).toEqual([])
    expect(existsSync(join(home, '.claude', 'skills', 'qiyu'))).toBe(false)
    expect(existsSync(join(defaultEntityDir(home), 'SKILL.md'))).toBe(true)
  })

  it('linkDirs 指向不存在的目录：不建链接、links=[]、不替用户建目录', async () => {
    const src = makeSource()
    const missing = join(home, '.claude', 'skills')
    const r = await installSkill({
      home, sourceDir: src, version: '1.2.3', force: false, linkDirs: [missing],
    })
    expect(r.links).toEqual([])
    expect(existsSync(missing)).toBe(false)
    // 显式点名却不存在，要告诉用户；自动探测为空则不告警（没有 agent 是正常状态）。
    expect(r.warnings.some((w) => w.includes(missing))).toBe(true)
  })

  it('linkDirs 指向文件而非目录：警告并跳过，不让安装失败', async () => {
    const src = makeSource()
    const notDir = join(home, 'not-a-dir')
    writeFileSync(notDir, '')

    const r = await installSkill({
      home, sourceDir: src, version: '1.2.3', force: false, linkDirs: [notDir],
    })

    expect(r.status).toBe('installed')
    expect(r.links).toEqual([])
    expect(r.warnings.some((w) => w.includes(notDir))).toBe(true)
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
