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
//   ③ **值永不上屏**：`describeShape` 把每个叶子折成类型名。采样时人会把终端输出贴进
//      对话/工单，值一旦上屏就可能永久留存 —— 而这里的样本是真实客户数据。
//      ⚠️ **键名会上屏**（见下方 SAFE_KEY 的说明）：字段名本身就是采样要记录的东西
//      （`staffInfo` / `questionList` 这些正是要写进 note 的），而"一个 ASCII 客户名
//      恰好被当作键"与"一个字段名"在字面上无从区分。所以本工具的保证是**不含值**，
//      不是"不含任何标识信息" —— 输出里会出现字段名，别整段当作可公开样本贴出去。
//      标识符形态的键（数字 id、中文、含空格等）照旧折成计数，实测里员工 id 就是这种。

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
 * 键名白名单形态：短 ASCII 标识符。**不满足的一律折成计数**，因为业务值可能出现在
 * **键**上而不是值上 —— 七鱼工单的 `follower` / `customField` 就是
 * `{5000004:"张三"}`（设计稿 §10.2 记载），键是员工 id；把电话号码当键的接口同样存在。
 * 只折值不折键的写法会把这些标识符原样打到终端。
 *
 * ⚠️ 这只挡**非标识符形态**的键（数字/中文/空格）。一个长得像字段名的 ASCII 值
 * （人名 `AliceSmith`）当键时，正则无法与真字段名区分 —— 那是"不含值"这个目标
 * 的固有边界，见文件头③。本工具保证「不含值」，不冒充「不含任何标识信息」。
 */
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,39}$/
/** 不满足 SAFE_KEY 的键统一折成这个名字 + 计数（同名多键会撞，所以只报数量）。 */
const REDACTED_KEYS = '<redacted-keys>'

/**
 * 把一个响应值折成「只有结构」的描述。**业务值与被当成键的标识符都不出现在返回值里。**
 *
 * ⚠️ 为什么单独拆成纯函数：不拆的话「输出不含值」这件事就只能靠读代码相信；
 * 拆开后可以被测试证伪（喂进带哨兵值的载荷，断言输出里没有它）。
 */
export function describeShape(value, depth = 0) {
  if (value === null) return 'null'
  if (Array.isArray(value)) {
    if (depth >= MAX_DEPTH) return 'array'
    // 空数组没有"元素形状"可言 —— 只报 empty，不要多带一个 `element: 'undefined'`
    // （那是 `describeShape(undefined)` 的返回值，看着像个真类型，其实什么都没说）。
    if (value.length === 0) return { array: 'empty' }
    return { array: value.length, element: describeShape(value[0], depth + 1) }
  }
  if (typeof value === 'object') {
    if (depth >= MAX_DEPTH) return 'object'
    const out = {}
    let redacted = 0
    for (const k of Object.keys(value).sort()) {
      if (SAFE_KEY.test(k)) out[k] = describeShape(value[k], depth + 1)
      else redacted++
    }
    // 数量本身是结构信息（「这里有一批动态键」），名字不是。用固定键名承载计数，
    // 避免两三个不同 id 作为键时互相覆盖、把数量也丢掉。
    if (redacted > 0) out[REDACTED_KEYS] = redacted
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
  // 顶层键同样走白名单：实测到的都是 code/message/data/result/staffInfo/total，
  // 但采样器的输出安全不能依赖"服务端不会那样返回"——规则统一，才没有漏网的分支。
  const top = Array.isArray(raw) ? '<array>'
    : raw && typeof raw === 'object'
      ? Object.keys(raw).sort().map((k) => (SAFE_KEY.test(k) ? k : REDACTED_KEYS))
      : typeof raw
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
 * 只放行「人工确认过是只读」的接口 —— **白名单，不是黑名单**。
 *
 * ⚠️ **`dangerous: false` 不等于只读**（CodeRabbit 2026-10-30 指出）。注册表里
 * `robot.session.chat` 就是 `dangerous:false`，但其 note 写着「会话不存在时**自动创建
 * 真实会话**」—— 一次成功采样会向生产机器人写入会话数据。
 *
 * ⚠️ 为什么是白名单而不是「排除已知会写的」：排除法**默认放行**，下一个
 * `dangerous:false` 但会写数据的接口（注册表还会继续长）不需要任何人做决定就能被采样；
 * 白名单**默认拒绝**，加一个接口就必须有人写下"它是只读的"这个判断。采样器的失败方向
 * 必须是「少采一个，补一行」，不能是「多写一次，无法回滚」。
 *
 * ⚠️ 另外三条判据取自注册表，不取自调用方：用例文件里写了 `dangerous: true` 的 id
 * 也必须被拒 —— 一次误发的写请求不是"采样失败"，是在生产租户里造数据。
 */
export const READ_ONLY_IDS = new Set([
  // 2026-10-30 采样时逐个人工核对过「只读」的接口（README/note 依据见各条 note）
  'ticket.log', 'ticket.new.detail', 'ticket.list',
  'chat.queue.group.query',
  'ipcc.calltaskdetail.get', 'ipcc.calltask.get', 'ipcc.customfield.template.get',
  'robot.session.commonQuestions', 'robot.session.msgPredict',
  'event.queryQueueStatus',
  'merchant.list', 'merchant.query',
  'icoutcall.callIntercept.list', 'icoutcall.dialogFlow.fuzzySearch',
  'icoutcall.dialogFlow.getDialogFlowList', 'icoutcall.get.customer',
  'icoutcall.get.jobdetail', 'icoutcall.get.jobproperties', 'icoutcall.phone.getLineList',
])
/**
 * 明确**不采**的接口：`dangerous:false` 但有写行为。列在这里是为了让下一个人看到
 * 「为什么这个明显可调用的接口没在白名单里」—— 否则它看起来像漏登记。
 * ⚠️ 名单成员必须能在注册表 note 里找到依据（测试钉住），防止「凭印象塞进黑名单、
 * 而注册表早已把它标成别的」的漂移。
 */
export const WRITE_EFFECT_IDS = new Set([
  'robot.session.chat',   // note：会话不存在时自动创建真实会话
])

export function assertSampleable(spec, id) {
  if (!spec) throw new Error(`用例里的 id 不在注册表里：${id}`)
  if (spec.dangerous) throw new Error(`拒绝采样危险写接口：${id}（dangerous:true）—— 采样不得改动生产数据`)
  if (!spec.callable) throw new Error(`拒绝采样不可主动调用的接口：${id}（callable:false，path 是占位符）`)
  if (spec.path === null) throw new Error(`拒绝采样没有可用 path 的接口：${id}`)
  if (WRITE_EFFECT_IDS.has(id)) {
    throw new Error(`拒绝采样有写行为的接口：${id}（注册表 note 注明会改动生产数据）—— 采样只允许只读`)
  }
  if (!READ_ONLY_IDS.has(id)) {
    throw new Error(
      `拒绝采样未经确认只读的接口：${id} —— dangerous:false 不代表只读。` +
      '确认它没有写副作用后，把 id 加进本文件的 READ_ONLY_IDS 白名单（这是一次需要人做出的判断）',
    )
  }
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
