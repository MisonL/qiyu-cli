#!/usr/bin/env node
// Windows CI 的最小测试入口：只跑 win-acl 两个文件，单进程单 worker。
//
// ⚠️ 为什么不直接在 ci.yml 里写 vitest 开关：tests/docs.test.ts 有一条契约——CI 工作流
// 不得在任何位置（含注释）出现并发开关字面量，开关必须烤在命令链里。Windows job 只跑
// 两个文件，不能复用 `npm test`（那是全量），所以把开关收进本脚本，ci.yml 只写脚本名。
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const vitestBin = join(process.cwd(), 'node_modules', 'vitest', 'vitest.mjs')
const files = ['tests/core/win-acl.test.ts', 'tests/core/win-acl-write.test.ts']
const r = spawnSync(process.execPath, [vitestBin, 'run', '--maxWorkers=1', '--no-file-parallelism', ...files], {
  stdio: 'inherit',
})
process.exit(r.status ?? 1)
