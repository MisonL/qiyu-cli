// 将 tsc 不会自动拷贝的注册表参数 JSON 复制到 dist。
import { cpSync, existsSync, mkdirSync } from 'node:fs'

const source = 'src/core/registry/params'
const validateSource = 'src/core/registry/validate.json'
const target = 'dist/core/registry/params'

if (!existsSync(source)) {
  console.error(`缺少注册表参数目录：${source}`)
  process.exit(1)
}
if (!existsSync(validateSource)) {
  console.error(`缺少注册表校验文件：${validateSource}`)
  process.exit(1)
}

mkdirSync(target, { recursive: true })
cpSync(source, target, { recursive: true })
console.log(`已复制注册表参数表 → ${target}`)
