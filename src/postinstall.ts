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
// 这类变体同样命中。归一化实现在 `skill/paths.ts` 的 `envIndex`（与漂移探测共用）。
//
// 分层：本文件是**顶层入口**（与 cli.ts 同级），import `skill/install.ts`——与
// `qiyu skill install` 是同一份安装逻辑，不是复制代码。纯函数 `runPostinstall`
// 由入口守卫调用：不收 `process.env`、不调 `process.exit`、不调 `homedir()`，
// 测试可以完全注入（临时 home + 字面量 env），不会碰真实 `~`，也不会杀进程。

import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { PACKAGE_VERSION } from './core/edition.js'
import { resolveEntityDirSources, resolveSkillSourceDir } from './skill/detect.js'
import { installSkill } from './skill/install.js'
import { envIndex } from './skill/paths.js'

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
  /**
   * 解析 `npm_config_qiyu_skill_dir` **相对路径**时的基准目录（审查 M2）。
   * 生产入口传 `process.env.INIT_CWD ?? process.cwd()`——npm 生命周期脚本的 cwd 是
   * **包根**（`node_modules/qiyu-cli`），用户设 `=./my-skill` 会装进包目录；`INIT_CWD`
   * 才是用户执行 install 时的目录（spec C6：它是 npm/pnpm/yarn/bun 唯一都提供的变量）。
   * 不注入时在纯函数内部兜底读一次 `process.cwd()`（见下方唯一一处进程状态读取）。
   */
  cwd?: string
}

/** 中文提示统一写 stderr（stdout 不归 postinstall 用，npm 也只看 stderr）。 */
function note(message: string): void {
  process.stderr.write(`qiyu-cli: ${message}\n`)
}

/**
 * postinstall 的全部行为。返回**永远**是 0（唯一的非 0 出口不存在）：调用方
 * （入口守卫）把它赋给 `process.exitCode`，失败只写 stderr。
 *
 * 键名归一化（小写 + `-`→`_`）已抽到 `skill/paths.ts` 的 `envIndex`——与
 * `skill/detect.ts` 的漂移探测共用同一套规则（终审 I2：两处各写一份必然漂移）。
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

    // 自定义实体位置：走全仓唯一的实体解析（`skill/detect.ts` 的 `resolveEntityDirSources`，
    // G3 审查 C3）。相对路径按 `opts.cwd`（= `INIT_CWD ?? cwd`）解析成绝对路径——installSkill
    // 内部所有路径运算都按绝对路径处理，绝对输入不受基准影响。
    // `testGate: false`：postinstall 的 env 是 npm 给的（判据已由上面的 npx / 全局标记挡过）。
    // 让它吃测试门会和 `npm test` 自己设的 `INIT_CWD` / `VITEST` 冲突，测试永远覆盖不到安装分支。
    // 默认位置不在这里拼：落回 `default` 时交给 installSkill 按 `opts.home` 取
    // `defaultEntityDir`（同一份事实，不在本文件重写一遍路径）。
    const resolution = resolveEntityDirSources({
      env: opts.env,
      home: opts.home,
      baseDir: opts.cwd ?? process.cwd(),
      testGate: false,
    })
    const entityDir = !resolution.decided || resolution.source === 'default' ? undefined : resolution.dir

    const result = await installSkill({
      home: opts.home,
      sourceDir,
      // 源码态是占位值 '0.0.0-dev'，发布态由 copy-assets.mjs 注入真实版本。
      version: PACKAGE_VERSION,
      force: false,
      ...(entityDir !== undefined ? { entityDir } : {}),
    })

    // 措辞按**实际**结果（审查 B2）：计划要写、实际零写入时 status 是 skipped，
    // 说「已是最新，跳过」是谎报——此时正文其实没跟上包内版本。
    const label = result.status === 'skipped'
      ? (result.plannedStatus === 'skipped' ? '已是最新，跳过' : '未完成更新（详见下方提示）')
      : `已安装（${result.status}）`
    note(`skill ${label}：${result.entityDir}`)
    if (result.warnings.length > 0) {
      // 零链接（审查 B3 / #58）等提示同样要出现在 npm 自动安装路径上。
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
 *
 * `argv` / `moduleUrl` 可注入（D3.11）：默认就是 `process.argv` 与 `import.meta.url`
 * （行为不变），注入缝让「真分支 / 假分支」可以在**不 spawn 子进程**的前提下各钉一条。
 * 子进程方式也能测，但它要跑真实的 npm 安装判据与真实 home——注入更稳、也更符合
 * 本仓库「测试绝不碰真实 ~」的硬约束。
 */
export function isEntry(argv: readonly string[] = process.argv, moduleUrl: string = import.meta.url): boolean {
  const argv1 = argv[1]
  if (argv1 === undefined || argv1 === '') return false
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href
  } catch {
    return false
  }
}

/**
 * 入口接线：把「进程状态 → runPostinstall 的输入」这一步单独导出，供测试直接钉住
 * （复审 N3：此前接线段零覆盖，变异「去掉 `INIT_CWD ??`」可存活）。
 *
 * 三个职责：
 *   1. `cwd` 取 `INIT_CWD ?? process.cwd()`——npm 生命周期脚本的 cwd 是包根
 *      （`node_modules/qiyu-cli`），`INIT_CWD` 才是用户执行 install 的目录（审查 M2）；
 *   2. **任何异常都收敛成 0**，包括取 `process.cwd()` 本身抛错（cwd 被删的场景，
 *      复审 N1 实测过：写在实参位置会在 `.catch()` 之外，退 1、阻断安装）；
 *   3. 恒返回数字，调用方直接赋给 `process.exitCode`。
 *
 * `cwd` 参数仅供测试注入进程 cwd；生产入口不传，走 `process.cwd()`。
 */
export async function mainEntry(opts: {
  env: NodeJS.ProcessEnv
  home: string
  /** 仅供测试注入进程 cwd；生产入口不传，走 `process.cwd()`。 */
  cwd?: string
  /** 仅供测试覆盖包内源目录；生产入口不传，走 `resolveSkillSourceDir()`。 */
  sourceDir?: string
}): Promise<number> {
  try {
    // 优先级：`INIT_CWD`（npm 提供的用户目录）> 注入的进程 cwd（测试用）> `process.cwd()`。
    // `opts.cwd` 代表「进程 cwd 的替身」，语义上低于 env 里的 INIT_CWD —— 顺序写反
    // 会让用户在 npm 生命周期里设相对路径时落到包根（M2 的原始病症）。
    const base = opts.env.INIT_CWD ?? opts.cwd ?? process.cwd()
    return await runPostinstall({
      env: opts.env,
      home: opts.home,
      cwd: base,
      ...(opts.sourceDir !== undefined ? { sourceDir: opts.sourceDir } : {}),
    })
  } catch {
    // 连「取 cwd 失败」都在这里被兜住 —— postinstall 绝不阻断 npm 安装。
    return 0
  }
}

if (isEntry()) {
  // 连 catch 兜底都返回 0：postinstall 在任何情况下都不得阻断 npm 安装。
  // 用 `process.exitCode` 而不是 `process.exit`（与 cli.ts 同理：设 exitCode 后
  // 让事件循环自然结束，stdout/stderr 先排空再退出）。
  process.exitCode = await mainEntry({ env: process.env, home: homedir() })
}
