// src/core/edition.ts —— 版本常量唯一定义点。
//
// 为什么放 `core/` 而不是 `skill/`：`qiyu --version`（Task 12，cli.ts）与 skill 安装
// （Task 9/11/13）都要消费，而 `commands/` 不得反向 import `skill/`（分层红线），
// `cli.ts` 同理。skill 正文发生**结构性**改变（增删协议段落形态）时递增
// `SKILL_CONTRACT_VERSION`；命令/flag 变化但 skill 正文未受影响则不动（spec D6）。
//
// `PACKAGE_VERSION` 是构建期占位：发布包**顶层**有 package.json（npm 永远带上它），
// 但 `files: ["dist"]` 下 `dist/` 内部没有——运行时代码在 `dist/core/`，相对路径
// `../package.json` 解析不到包元数据；跨层猜路径（`../../package.json`）又依赖
// 构建层级，发布前后两种形态会分叉。所以版本在构建期注入：
// `scripts/copy-assets.mjs`（Task 13）在 tsc 之后把 dist/core/edition.js 里的
// '0.0.0-dev' 字面量正则替换为 package.json 的 version。源码里永远保持占位值，
// 靠测试钉住「构建产物非占位」这一契约。

/** skill 正文契约版本：结构性改变才递增（spec D6）。 */
export const SKILL_CONTRACT_VERSION = 1

/** 包版本占位值；构建期被 copy-assets.mjs 替换为 package.json 的 version。 */
export const PACKAGE_VERSION = '0.0.0-dev'
