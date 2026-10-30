// scripts/registry/sample.mjs —— 只读接口的实测采样器。**不进 CI**（需要真实凭证与网络）。
//
// 为什么要它：`specs.json` 里每条 `verified: true` 与 note 里的信封描述都必须有出处。
// 此前那批实测散落在一次性脚本里，下一轮重新采样只能从头再写一遍 —— 而「实测」这件事
// 的可重复性正是 `verified` 这个字段的全部依据。
//
// 用法（先 `npm run build`，签名逻辑复用 dist，见下方约束①的理由）：
//   ( set -a; . private/.env; set +a; node scripts/registry/sample.mjs private/sample-cases.json )
// 用例文件是 `[{ "id": "ticket.log", "body": { "ticketId": 123 } }]`，
// **放在 gitignored 的 private/ 下** —— 用例里带着真实租户的 staffId/ticketId，
// 进仓库就踩了开源红线（仓库禁企业专属信息，含 git 历史）。
//
// ⚠️ 三条硬约束，逐条都有对应用例（tests/registry/sample.test.ts）：
//   ① **签名只有一个实现点**：本脚本必须 import `dist/core/sign.js`，
//      不得在这里重写一遍 checksum —— 两份实现会漂移，而漂移的表现是
//      线上 14500「Internal Error」查不出原因（设计稿 §4.3 点名的正是这种码）。
//      代价：脚本要求先 build。这是刻意的取舍，不是遗漏。
//   ② **凭证只从环境变量读**（`QIYU_APP_KEY` / `QIYU_APP_SECRET`），绝不从 argv ——
//      与 `auth login` 同一条规则：argv 会进 shell 历史、`ps`、CI 日志。
//   ③ **输出只有形状，没有业务值**：`describeShape` 把每个叶子折成类型名，
//      数组只给长度。采样时人会把终端输出贴进对话/工单，业务值一旦上屏就可能
//      永久留存 —— 而这里的样本是真实客户数据。

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
/** 注册表（生成产物，无需 build 即可读）：path/method/dangerous 的唯一依据。 */
const SPECS_PATH = resolve(HERE, '../../src/core/registry/specs.json')
const BASE = 'https://qiyukf.com'
/** 形状递归到此深度为止，更深处只写 'object' / 'array' —— 防止大载荷刷屏。 */
const MAX_DEPTH = 3

/**
 * 把一个响应值折成「只有结构」的描述。**任何业务值都不出现在返回值里。**
 *
 * ⚠️ 为什么单独拆成纯函数：不拆的话「输出不含值」这件事就只能靠读代码相信；
 * 拆开后可以被测试证伪（喂进带哨兵值的载荷，断言输出里没有它）。
 */
export function describeShape(value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return 'array'
    return { array: value.length === 0 ? 'empty' : describeShape(value[0], depth + 1) }
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return 'object'
    const out = {}
    for (const k of Object.keys(value).sort()) out[k] = describeShape(value[k], depth + 1)
    return out
  }
  return typeof value
}

/**
 * 顶层摘要：键集合 + `code` + `message` 的**种类** + data/result/staffInfo 的形状。
 *
 * ⚠️ `message` 是形状 C 的载荷载体，它的「能否解析为 JSON、解析出来是什么类型」
 * 正是注册表要登记的东西，所以这里给出 `json-object` / `plain-text` 这类**种类**标签；
 * 但**绝不给出 message 的内容**（它整段就是业务数据）。
 */
export function summarize(raw) {
  const top = Array.isArray(raw) ? '<array>'
    : raw && typeof raw === 'object' ? Object.keys(raw).sort() : typeof raw
  const out = { top, code: raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.code ?? null : null }
  const m = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw.message : undefined
  if (m === undefined) out.message = 'absent'
  else if (typeof m !== 'string') out.message = 'non-string:' + (Array.isArray(m) ? 'array' : typeof m)
  else {
    try {
      const p = JSON.parse(m)
      out.message = 'json-string:' + (Array.isArray(p) ? 'array' : typeof p)
      out.messageShape = describeShape(p)
    } catch {
      out.message = 'plain-text'
    }
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const k of ['data', 'result', 'staffInfo']) {
      if (k in raw) out[k] = describeShape(raw[k])
    }
  }
  if (Array.isArray(raw)) out.shape = describeShape(raw)
  return out
}

/**
 * 只放行「可主动调用的只读接口」。
 *
 * ⚠️ 判据取自注册表，不取自调用方：用例文件里写了 `dangerous: true` 的 id 也必须被拒 ——
 * 一次误发的写请求（例如 `icoutcall.job.create`）不是"采样失败"，是在生产租户里造数据。
 * 而 `inbound` / `callable: false` 的 path 是占位符，拼出来必然 404，属于无意义的调用。
 */
export function assertSampleable(spec, id) {
  if (!spec) throw new Error(`用例里的 id 不在注册表里：${id}`)
  if (spec.dangerous) throw new Error(`拒绝采样危险写接口：${id}（dangerous:true）—— 采样不得改动生产数据`)
  if (!spec.callable) throw new Error(`拒绝采样不可主动调用的接口：${id}（callable:false，path 是占位符）`)
  if (spec.path === null) throw new Error(`拒绝采样没有可用 path 的接口：${id}`)
}

/** 把「缺凭据」这件事说清楚，且**不打印任何凭据**（连长度都不打印，见用例）。 */
export function readCreds(env) {
  const appKey = env.QIYU_APP_KEY
  const appSecret = env.QIYU_APP_SECRET
  if (!appKey || !appSecret) {
    throw new Error('缺少 QIYU_APP_KEY / QIYU_APP_SECRET —— 本脚本只从环境变量读，不接受命令行传凭据')
  }
  return { appKey, appSecret }
}

/**
 * 非 JSON 响应的摘要：**一个正文字符都不带**。
 *
 * ⚠️ 为什么单独拆出来：这一支最初写成 `text.slice(0, 20)`，理由写的是「只报类别、
 * 不贴正文」，而前 20 个字符**就是正文** —— nginx 错误页/网关纯文本的开头完全可能
 * 带着真实租户信息（会话 id、手机号、URL query）。约束③ 的破口出现在**唯一没被测试
 * 覆盖的那一支**，这正是「不做某事」型契约不写用例就会烂掉的方式（CodeRabbit 2026-10-30 指出）。
 * 现在只报元数据：状态码、Content-Type、长度、首字符是否 '<'（够区分 HTML 错误页与
 * 纯文本网关页，足以判断「注册表 path 写错」还是「网关故障」，一个正文字符都不要）。
 */
export function describeNonJson(httpStatus, contentType, text) {
  return {
    httpStatus,
    nonJson: true,
    contentType: contentType ?? null,
    length: text.length,
    looksLikeHtml: text.trimStart().startsWith('<'),
  }
}

async function main() {
  const casesPath = process.argv[2]
  if (!casesPath) {
    console.error('用法：node scripts/registry/sample.mjs <用例文件.json>（用例文件放 private/，不要提交）')
    process.exit(2)
  }
  const creds = readCreds(process.env)
  // 动态 import：dist 不存在时给出可执行的提示，而不是一个 MODULE_NOT_FOUND 栈。
  let signedQuery
  try {
    ({ signedQuery } = await import('../../dist/core/sign.js'))
  } catch {
    console.error('找不到 dist/core/sign.js —— 先跑 `npm run build`（签名只有一个实现点，见本文件头注释①）')
    process.exit(2)
  }

  const specs = Object.fromEntries(
    JSON.parse(readFileSync(SPECS_PATH, 'utf8')).map((s) => [s.id, s]),
  )
  const cases = JSON.parse(readFileSync(resolve(casesPath), 'utf8'))

  for (const { id, body } of cases) {
    const spec = specs[id]
    try {
      assertSampleable(spec, id)
    } catch (e) {
      console.log(id, '=> 拒绝：', e.message)
      continue
    }
    const bodyStr = body === undefined ? undefined : JSON.stringify(body)
    const q = signedQuery(creds.appKey, creds.appSecret, bodyStr ?? '', Math.floor(Date.now() / 1000))
    try {
      const res = await fetch(`${BASE}${spec.path}?${q}`, {
        method: spec.method,
        headers: { 'Content-Type': 'application/json', 'Accept-Encoding': 'identity' },
        body: bodyStr,
        signal: AbortSignal.timeout(30_000),
      })
      const text = await res.text()
      let parsed
      try {
        parsed = JSON.parse(text)
      } catch {
        // 非 JSON 响应：只报元数据，一个正文字符都不给（见 describeNonJson 的说明）
        console.log(id, '=>', JSON.stringify(describeNonJson(res.status, res.headers.get('content-type'), text)))
        continue
      }
      console.log(id, '=>', JSON.stringify({ httpStatus: res.status, ...summarize(parsed) }))
    } catch (e) {
      console.log(id, '=> 请求失败：', String(e).slice(0, 120))
    }
  }
}

// 只有直接执行时才跑 main（被 import 时不跑，测试才拿得到纯函数）
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main()
}
