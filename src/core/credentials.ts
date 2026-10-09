export interface Credentials { appKey: string; appSecret: string }

type PartialCreds = Partial<Credentials>

/**
 * 优先级：命令行参数 > 环境变量 > 配置文件。
 * 两者缺一即报错 —— 只给 appKey 就发请求必然拿 14001，不如在本地就说清楚。
 */
export function resolveCredentials(
  fromArgs: PartialCreds,
  env: PartialCreds = {},
  fromFile?: PartialCreds,
): Credentials {
  const appKey = fromArgs.appKey ?? env.appKey ?? fromFile?.appKey
  const appSecret = fromArgs.appSecret ?? env.appSecret ?? fromFile?.appSecret

  if (!appKey) {
    throw new Error(
      '缺少 appKey。请设置环境变量 QIYU_APP_KEY。',
    )
  }
  if (!appSecret) {
    throw new Error(
      '缺少 appSecret。请设置环境变量 QIYU_APP_SECRET。',
    )
  }
  return { appKey, appSecret }
}

/** 转义正则元字符 —— 凭证理论上可能含 `.` `*` 等，直接插进 RegExp 会改变语义。 */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 把凭证从任意文本中抹掉。所有对外输出（含 stderr 与错误消息）都必须先过这一层。 */
export function redact(text: string, creds: Credentials): string {
  let out = text
  // ⚠️ `split/join` 是无差别子串替换，对**极短**的凭证会把正常文本打烂 ——
  // 实测旧实现 `redact('AppKey not exists', {appKey:'e', appSecret:'s'})` 得到
  // `AppK<已隐藏>y not <已隐藏>xi<已隐藏>t<已隐藏>`，Agent 完全读不懂
  // （2026-10-06 复跑确认：`s` 抹掉 4 个字母、`e` 再抹 1 个，原文只剩骨架）。
  // ⚠️ **注意 `creds` 里有两个凭证才复现得出这行输出** —— 只传 `appKey:'e'`
  // 会得到 `AppK<已隐藏>y not <已隐藏>xists`（少了两处）。注释里的示例必须
  // 把它写成完整形态，否则照抄的人会以为"我跑得不对"。
  //
  // 但**绝不能**因为"太短"就跳过脱敏 —— 泄漏凭证比文本难读严重得多。
  // 折中：短凭证仍然替换，但**只在它作为独立 token 出现时**（用词边界）。
  // 七鱼真实凭证是 32 字符的十六进制串，走的是上面的无差别替换分支，
  // 所以这条边界规则只影响测试夹具与将来可能的短凭证。
  const MIN = 8
  const scrub = (s: string, secret: string): string =>
    secret.length >= MIN
      ? s.split(secret).join('<已隐藏>')
      : s.replace(new RegExp(`(?<![\\w])${escapeRe(secret)}(?![\\w])`, 'g'), '<已隐藏>')
  if (creds.appSecret) out = scrub(out, creds.appSecret)
  if (creds.appKey) out = scrub(out, creds.appKey)
  // ⚠️ **appKey 还要抹掉它的 URL 编码形式。** 这条是必需的，不是冗余：
  // `signedQuery` 对 appKey 做了 `encodeURIComponent`（见 sign.ts），所以 message 里
  // 若出现 URL，串上是编码形式 `?appKey=a%2Bb&…` —— 而上面的 `scrub(out, creds.appKey)`
  // 用**原始** appKey（`a+b`）做 `split/join`，在这串里**匹配不到任何东西**。
  // 于是含 URL 保留字符（`+ / = &` 等）的 appKey 会原样留在错误 message 里。
  // ⚠️ 计划自己的 sign.test.ts 就断言了「含保留字符的 appKey 是可能的」
  // （`signedQuery('a+b/c=d&e', …)` 产出 `appKey=a%2Bb%2Fc%3Dd%26e`）——
  // 所以这不是假想输入，只是两层（签名 vs 脱敏）对同一个值用了不同表示。
  // 真实凭证是 32 位十六进制（不含保留字符），线上不触发；但形态一变就是无声泄漏。
  if (creds.appKey) {
    const encoded = encodeURIComponent(creds.appKey)
    if (encoded !== creds.appKey) out = scrub(out, encoded)
  }
  // ⚠️ `checksum` 也必须抹掉 —— 复核重点 8 自己点明了「URL 查询串就是
  // appKey/checksum」，但只抹 appKey 是不够的。checksum = SHA1(appSecret + md5(body) + time)，
  // 它虽然不可逆，却是**一个 5 分钟内有效的可重放凭证**：拿到 `checksum` + 同一个 `time`
  // + 同一个 body，任何人都能原样重发这个请求。异常 message 一旦带 URL，
  // checksum 就在里面 —— 除非在这里拦掉。
  // 匹配 40 位小写十六进制（SHA1 的十六进制表示）。
  // ⚠️ 只匹配**小写**不是疏忽：本仓库的 `checksum` 与 `md5Hex` 都由
  // `digest('hex')` 产生，恒为小写（设计稿 **§4.1 签名** 明写"小写十六进制" ——
  // ⚠️ 此前这里误标为 §2；§2 是「范围」，不含此句）。把正则放宽到
  // `[0-9a-fA-F]` 只会增加**误伤**风险 —— 任何 40 位的业务文本（如某接口返回的
  // 哈希型字段）会被无差别抹掉。若将来真有大小写混用的凭证进入 message，
  // 应在此显式处理，而不是靠一条更宽的正则顺带覆盖。
  out = out.replace(/\b[0-9a-f]{40}\b/g, '<已隐藏>')
  return out
}
