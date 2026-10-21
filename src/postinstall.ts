// src/postinstall.ts —— npm 全局安装后的便利路径：尽力而为地装一次 skill。
//
// 定位（spec D7 / C4 / C5）：postinstall **不是** skill 安装的主路径，只是「用户
// `npm i -g qiyu-cli` 之后大概率顺手装了 skill」的锦上添花：
//   · npm 12 / pnpm 12 / bun 默认**阻断**安装脚本（实测，spec C4），它大多数时候
//     根本不会跑；
//   · 即使跑，默认安装下 stderr 被 npm 吞掉（除非 `--foreground-scripts`）；
//   · npx 场景下 postinstall 失败会让整个调用静默退出码 1（spec C4 实测）。
// 所以本文件遵守唯一一条硬约束：**任何输入、任何失败都返回 0，绝不阻断 npm 安装**。
// 真正的兜底是首次运行检测（detect.ts 的 meta.warnings：未安装/已过期提示），
// 主路径是显式命令 `qiyu skill install`。
//
// 判据（只有 npm 提供这两个变量，spec C6）：
//   · `npm_config_global === 'true'` —— 全局安装才自动装；局部依赖（某个项目的
//     devDependency）不该往用户 home 里写东西；
//   · `npm_command !== 'exec'` —— npx 执行时不装（临时借用的场景，写 home 是越权）。
// pnpm/yarn/bun 不提供这两个变量（bun 连 npm_lifecycle_event 都是 null），于是
// 判据自然落空 → 只提示、不写任何文件，与 spec「降级为不区分、只提示」一致。
//
// 自定义实体位置：读 `npm_config_qiyu_skill_dir`。命令行 flag 形式
// `--qiyu-skill-dir=` 在 npm 12 会 EUNKNOWNCONFIG 直接失败（spec C5），环境变量是
// 唯一跨版本可用的通路。环境变量名按 spec D8 的约定「统一转小写比对」——Windows
// 环境变量名大小写不敏感；npm 自己会把配置名里的 `-` 归一化成 `_`，所以读取时
// 键名统一 `toLowerCase().replace(/-/g, '_')` 后再查，`npm_config_qiyu-skill-dir`
// 这类变体同样命中。
//
// 分层：本文件是**顶层入口**（与 cli.ts 同级），import `skill/install.ts`——与
// `qiyu skill install` 是同一份安装逻辑，不是复制代码。纯函数 `runPostinstall`
// 由入口守卫调用：不收 `process.env`、不调 `process.exit`、不调 `homedir()`，
// 测试可以完全注入（临时 home + 字面量 env），不会碰真实 `~`，也不会杀进程。

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { PACKAGE_VERSION } from './core/edition.js'
import { resolveSkillSourceDir } from './skill/detect.js'
import { installSkill } from './skill/install.js'

export interface PostinstallOptions {
  /** 注入的环境变量（生产入口传 `process.env`，测试传字面量）。 */
  env: NodeJS.ProcessEnv
  /** 注入的 home（生产入口传 `homedir()`，测试传临时目录）。 */
  home: string
  /**
   * brief 签名之外的**扩展**（可选）：覆盖包内 skill 源目录解析。缺省时走
   * `resolveSkillSourceDir()`（dist 优先、src 回退），测试需要构造「源目录不存在」
   * 这类场景时才注入。
   */
  sourceDir?: string
}

/** 中文提示统一写 stderr（stdout 不归 postinstall 用，npm 也只看 stderr）。 */
function note(message: string): void {
  process.stderr.write(`qiyu-cli: ${message}\n`)
}

/**
 * 把 env 的键统一成「小写 + `-` 转 `_`」后建索引（spec D8：Windows 大小写不敏感；
 * npm 把配置名里的连字符归一化为下划线）。只收字符串值——NodeJS.ProcessEnv 的
 * 值类型允许 undefined，未定义的键视同不存在。
 */
function envIndex(env: NodeJS.ProcessEnv): Map<string, string> {
  const index = new Map<string, string>()
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    index.set(key.toLowerCase().replace(/-/g, '_'), value)
  }
  return index
}

/**
 * postinstall 的全部行为。返回**永远**是 0（唯一的非 0 出口不存在）：调用方
 * （入口守卫）把它赋给 `process.exitCode`，失败只写 stderr。
 *
 * 分支：
 *   1. npx（`npm_command === 'exec'`）→ 提示，不写任何文件——**判据优先于全局标记**
 *      （npx 下 npm 也可能带 global 标记，但「临时借用」语义更重要）；
 *   2. 非全局安装（`npm_config_global !== 'true'`）→ 提示，不写任何文件；
 *   3. 包内 skill 源目录不存在 → 提示，不抛（被裁剪的运行环境里这是正常现象）；
 *   4. 否则调用与 `qiyu skill install` 相同的 `installSkill`；`force` 恒 false
 *      ——自动路径绝不覆盖用户可能改过的正文（覆盖需要用户显式 `--force`）。
 * 任何异常（权限、路径异常、安装失败）都收敛成一行中文提示 + 返回 0。
 */
export async function runPostinstall(opts: PostinstallOptions): Promise<number> {
  try {
    const env = envIndex(opts.env)

    // npx 判据**先于**全局标记：npx 下 npm 也可能带 global 标记，但「临时借用」语义
    // 更重要——不往 home 写东西。先判 exec 还能让提示文案说出真实原因。
    if (env.get('npm_command') === 'exec') {
      note('通过 npx 执行，跳过 skill 自动安装；需要时运行 `qiyu skill install`')
      return 0
    }
    if (env.get('npm_config_global') !== 'true') {
      note('非全局安装（或包管理器不提供 npm 环境变量），跳过 skill 自动安装；需要时运行 `qiyu skill install`')
      return 0
    }

    const sourceDir = opts.sourceDir ?? resolveSkillSourceDir()
    if (sourceDir === undefined) {
      note('包内 skill 目录缺失，跳过 skill 自动安装；需要时运行 `qiyu skill install`')
      return 0
    }

    // 自定义实体位置：空串/纯空白视同未设（与 detect.ts 的 resolveEntityDir 同口径），
    // 相对路径按 cwd 解析成绝对路径——installSkill 内部所有路径运算都按绝对路径处理。
    const requestedDir = env.get('npm_config_qiyu_skill_dir')?.trim()
    const entityDir = requestedDir !== undefined && requestedDir !== ''
      ? path.resolve(requestedDir)
      : undefined

    const result = await installSkill({
      home: opts.home,
      sourceDir,
      // 源码态是占位值 '0.0.0-dev'，发布态由 copy-assets.mjs 注入真实版本。
      version: PACKAGE_VERSION,
      force: false,
      ...(entityDir !== undefined ? { entityDir } : {}),
    })

    note(`skill ${result.status === 'skipped' ? '已是最新，跳过' : `已安装（${result.status}）`}：${result.entityDir}`)
    if (result.warnings.length > 0) {
      note(`安装提示：${result.warnings.join('；')}`)
    }
    return 0
  } catch (err) {
    // 失败绝不阻断安装：一行中文提示（含原因）就够了，细节交给用户主动跑
    // `qiyu skill install` 时再暴露。
    const reason = err instanceof Error ? err.message : String(err)
    note(`skill 自动安装失败（${reason}），不影响本次安装；稍后可运行 \`qiyu skill install\``)
    return 0
  }
}

/**
 * 本进程是否把 postinstall.js 当入口运行（`node dist/postinstall.js`）。与
 * `src/cli.ts` 末尾同一手法：`pathToFileURL(realpathSync(argv[1]))` 与
 * `import.meta.url` 比较（realpath 消掉符号链接与相对写法的差异）。
 *
 * 外层包 try/catch：argv[1] 不存在时 realpathSync 抛 ENOENT——入口判定失败只能是
 * 「没被当入口」，不能反过来把进程搞挂（与「任何路径 exit 0」同一条底线）。
 */
function isEntry(): boolean {
  const argv1 = process.argv[1]
  if (argv1 === undefined || argv1 === '') return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return false
  }
}

if (isEntry()) {
  // 连 catch 兜底都返回 0：postinstall 在任何情况下都不得阻断 npm 安装。
  // 用 `process.exitCode` 而不是 `process.exit`（与 cli.ts 同理：设 exitCode 后
  // 让事件循环自然结束，stdout/stderr 先排空再退出）。
  process.exitCode = await runPostinstall({ env: process.env, home: homedir() }).catch(() => 0)
}
