// tests/skill/postinstall.test.ts —— postinstall 尽力而为入口（Task 13）。
//
// 契约只有一条：**任何输入都返回 0**。postinstall 是 `npm i -g` 的便利路径，不是
// 主路径（spec C4：npm 12 / pnpm 12 / bun 默认阻断它；真正的兜底是首次运行检测）。
// 它一旦以非 0 退出就会阻断整个 npm 安装，所以「不抛、恒 0」比「装成功」重要。
//
// 全部注入：`home` 由测试给临时目录，`env` 是显式字面量（**不读 process.env**）——
// 真实 `~` 与运行本测试时的 npm 环境（`npm test` 自己就会设 `npm_config_*`）都
// 不参与判定。源目录同样注入：`runPostinstall` 收 `sourceDir` 覆盖，否则走
// `resolveSkillSourceDir()`（在测试进程里会解析到仓库 src/skill/qiyu）。
//
// 用例构成：brief 五条 + 控制者补三条（环境变量通路、幂等、npx 判据优先）+ 审查
// fix round 1 补四条（I1 force:false 数据保护、M2 相对路径基准 cwd、M3 键名大小写）。

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { runPostinstall } from '../../src/postinstall.js'
import { defaultEntityDir } from '../../src/skill/paths.js'

let home: string

beforeEach(() => {
  // realpath 归一化：macOS 的 /var → /private/var，否则断言里的路径字符串对不上。
  home = realpathSync(mkdtempSync(join(tmpdir(), 'qiyu-postinstall-')))
})
afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

/** 写文件（自动建父目录）。 */
function write(dir: string, rel: string, content: string): void {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, content)
}

/** 构造一份最小 skill 源目录（内容与真实包内结构无关，只要求可复制）。 */
function makeSource(): string {
  const src = join(home, 'pkg-skill')
  write(src, 'SKILL.md', '# qiyu\n')
  write(src, 'protocols.md', '协议正文\n')
  return src
}

/** 实体目录下是否出现 skill 正文（判定「装了没」）。 */
function installed(entityDir: string): boolean {
  return existsSync(join(entityDir, 'SKILL.md'))
}

describe('runPostinstall', () => {
  it('brief ①：npm_config_global=true 时执行安装（默认实体目录出现正文）', async () => {
    const sourceDir = makeSource()
    const code = await runPostinstall({
      env: { npm_config_global: 'true', npm_command: 'install' },
      home,
      sourceDir,
    })
    expect(code).toBe(0)
    expect(installed(defaultEntityDir(home))).toBe(true)
  })

  it('brief ②：npm_command=exec 时不安装，只返回提示', async () => {
    const sourceDir = makeSource()
    const code = await runPostinstall({
      env: { npm_command: 'exec' },
      home,
      sourceDir,
    })
    expect(code).toBe(0)
    expect(existsSync(join(home, '.agents'))).toBe(false)
  })
  it('brief ③：env 为空（pnpm/yarn/bun 无法区分）时不安装、不写任何文件', async () => {
    const sourceDir = makeSource()
    const code = await runPostinstall({ env: {}, home, sourceDir })
    expect(code).toBe(0)
    // 一个字节都不写：连父目录 ~/.agents 都不该出现。
    expect(existsSync(join(home, '.agents'))).toBe(false)
  })

  it('brief ④：源目录不存在时返回提示、不抛', async () => {
    const code = await runPostinstall({
      env: { npm_config_global: 'true', npm_command: 'install' },
      home,
      sourceDir: join(home, 'does-not-exist'),
    })
    expect(code).toBe(0)
    expect(existsSync(join(home, '.agents'))).toBe(false)
  })

  it('brief ⑤：任何输入返回 0（含实体路径被文件占用这类安装失败）', async () => {
    const sourceDir = makeSource()
    // 让默认实体路径的父链被普通文件占住：installSkill 会抛，postinstall 必须吞掉并返回 0。
    write(home, '.agents', '我是文件不是目录\n')
    await expect(runPostinstall({
      env: { npm_config_global: 'true', npm_command: 'install' },
      home,
      sourceDir,
    })).resolves.toBe(0)
  })

  it('补 ①：npm_config_qiyu_skill_dir 把实体装到指定路径（环境变量通路）', async () => {
    const sourceDir = makeSource()
    const target = join(home, 'custom-entity')
    const code = await runPostinstall({
      env: {
        npm_config_global: 'true',
        npm_command: 'install',
        npm_config_qiyu_skill_dir: target,
      },
      home,
      sourceDir,
    })
    expect(code).toBe(0)
    expect(installed(target)).toBe(true)
    // 默认实体位置不该同时被写（自定义路径优先，不是「两边都装」）。
    expect(installed(defaultEntityDir(home))).toBe(false)
  })

  it('补 ①b：环境变量名的大小写/连字符变体同样生效（spec D8）', async () => {
    const sourceDir = makeSource()
    const target = join(home, 'custom-entity')
    // Windows 环境变量名大小写不敏感；npm 对含连字符的键做 `_` 归一化。
    // 实现先把键转小写再查，`npm_config_qiyu-skill-dir` 因此也能命中。
    const code = await runPostinstall({
      env: {
        npm_config_global: 'true',
        npm_command: 'install',
        'npm_config_qiyu-skill-dir': target,
      },
      home,
      sourceDir,
    })
    expect(code).toBe(0)
    expect(installed(target)).toBe(true)
  })

  it('补 ②：重复调用两次不抛，第二次 status 为 skipped（幂等）', async () => {
    const sourceDir = makeSource()
    const env = { npm_config_global: 'true', npm_command: 'install' }
    await expect(runPostinstall({ env, home, sourceDir })).resolves.toBe(0)
    const entityDir = defaultEntityDir(home)
    const before = readdirSync(entityDir).sort()
    await expect(runPostinstall({ env, home, sourceDir })).resolves.toBe(0)
    // 第二次什么都不写（installSkill 的幂等命中），文件集合不变。
    expect(readdirSync(entityDir).sort()).toEqual(before)
    expect(installed(entityDir)).toBe(true)
  })

  it('补 ③：npm_command=exec 即便 global=true 也不安装（npx 判据优先）', async () => {
    const sourceDir = makeSource()
    // 捕捉 stderr，证明命中的是 **npx 分支**而不是「非全局安装」分支——两条分支都
    // 不写文件，只断言文件系统分不出判据次序（这条用例的名字承诺的正是次序）。
    const messages: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      messages.push(String(chunk))
      return true
    })
    let code: number
    try {
      code = await runPostinstall({
        env: { npm_config_global: 'true', npm_command: 'exec' },
        home,
        sourceDir,
      })
    } finally {
      spy.mockRestore()
    }
    expect(code).toBe(0)
    expect(existsSync(join(home, '.agents'))).toBe(false)
    expect(messages.join('')).toContain('通过 npx 执行')
  })

  it('审查 M3：env 键名全大写（NPM_CONFIG_GLOBAL）同样命中（spec D8 大小写不敏感）', async () => {
    const sourceDir = makeSource()
    const code = await runPostinstall({
      env: { NPM_CONFIG_GLOBAL: 'true', NPM_COMMAND: 'install' },
      home,
      sourceDir,
    })
    expect(code).toBe(0)
    expect(installed(defaultEntityDir(home))).toBe(true)
  })

  it('审查 I1：重跑不覆盖用户手改的正文（force:false 的数据保护承诺）', async () => {
    const sourceDir = makeSource()
    const env = { npm_config_global: 'true', npm_command: 'install' }
    await runPostinstall({ env, home, sourceDir })

    // 手改实体里的正文（用户加了自己的内容）。
    const entityDir = defaultEntityDir(home)
    const edited = '# qiyu\n\n用户手改的正文，绝不能被自动路径覆盖\n'
    writeFileSync(join(entityDir, 'SKILL.md'), edited)

    // 捕捉 stderr：既要证明「未覆盖」被如实说出来，也要确认没有谎报「已覆盖」。
    const messages: string[] = []
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      messages.push(String(chunk))
      return true
    })
    let code: number
    try {
      code = await runPostinstall({ env, home, sourceDir })
    } finally {
      spy.mockRestore()
    }

    expect(code).toBe(0)
    // ① 用户改动原样保留（逐字节）。
    expect(readFileSync(join(entityDir, 'SKILL.md'), 'utf8')).toBe(edited)
    // ② 警告如实说明未覆盖。
    expect(messages.join('')).toContain('未覆盖')
  })

  describe('审查 M2：npm_config_qiyu_skill_dir 的路径解析基准', () => {
    it('相对路径按注入的 cwd 解析（不是进程 cwd）', async () => {
      const sourceDir = makeSource()
      const cwd = join(home, 'user-proj')
      mkdirSync(cwd, { recursive: true })
      const code = await runPostinstall({
        env: {
          npm_config_global: 'true',
          npm_command: 'install',
          npm_config_qiyu_skill_dir: 'rel-dir',
        },
        home,
        sourceDir,
        cwd,
      })
      expect(code).toBe(0)
      expect(installed(join(cwd, 'rel-dir'))).toBe(true)
      // 实体只落在注入的 cwd 下：若实现退回 `path.resolve(rel)`（进程 cwd 基准），
      // 上面那条断言就会落空——不必再断言进程 cwd 里的路径，那会在回归时污染仓库根。
      expect(installed(defaultEntityDir(home))).toBe(false)
    })

    it('绝对路径不受 cwd 影响', async () => {
      const sourceDir = makeSource()
      const abs = join(home, 'absolute-entity')
      const elsewhere = join(home, 'elsewhere')
      mkdirSync(elsewhere, { recursive: true })
      const code = await runPostinstall({
        env: {
          npm_config_global: 'true',
          npm_command: 'install',
          npm_config_qiyu_skill_dir: abs,
        },
        home,
        sourceDir,
        // 故意给一个完全无关的 cwd：绝对路径不应该被它拼接。
        cwd: elsewhere,
      })
      expect(code).toBe(0)
      expect(installed(abs)).toBe(true)
      // 没有被拼进 cwd 之下。
      expect(existsSync(join(elsewhere, 'absolute-entity'))).toBe(false)
    })
  })
})
