// src/commands/api-notes.ts
//
// `api call` 的 `meta.field_notes` 图例（2026-10-28）。
//
// ⚠️ 为什么 `api call` 需要图例：它的 `data` 是**上游载荷**，与其余命令的
// `data`（CLI 自己的契约）不是一回事 —— 不点破，Agent 会按 `qiyu db tables` 的
// 形状去读 `ticket.search` 的返回。`meta` 里的 `endpoint` / `not_found` /
// `warnings` / `note` 也各有坑（尤其 `not_found` 只覆盖**结构性为空**）。
//
// ⚠️ 为什么键是 `data`（信封顶层）：图例解释的是「读者会读的那个键」，而 `data`
// 恰恰是最容易被误读的一个 —— 它是本输出里唯一来自上游的键。
export function callFieldNotes(): Record<string, string> {
  return {
    data: '上游响应解包后的载荷：本 CLI 按信封形状取出 data / result / staffInfo 等键'
      // ⚠️ 不能说「原样透传、不改写」（2026-11-07 审查实测）：形状 M 的载荷在透传前被
      // trim()，形状 C 的畸形 JSON 先经 repairUnquotedIntKeys 修复再解析。
      // ⚠️ 也不能让读者去 `api schema` 查响应字段：它只有请求侧 params 与
      // `response_shape:{kind}`，没有任何响应字段表（2026-11-07 审查）。
      + '（信封形状 M 会 trim 首尾空白，形状 C 的畸形 JSON 键会先被修复再解析）。'
      + '⚠️ 本 CLI 没有响应字段表：`qiyu api schema` 只给请求参数与信封种类，'
      + '各字段的确切含义以七鱼官方文档为准，不要按其他命令 data 的形状推断',
    endpoint: '本次调用的接口 id（把结果与请求对上用）',
    warnings: '⚠️ 这是多来源数组，元素形状不统一：'
      + '① body 校验的软告警（对象，含 `kind` / `message`），'
      // ⚠️ `field` **不保证**存在（Sourcery 指出）：`non_json_body`（body_kind 非 json 时
      // 整条请求级的提示 —— 传输层仍按 JSON.stringify 发 JSON 字节，不是该编码的原文）是**整条请求**级的提示，没有单一字段可归因 —— 它只带 `kind` 与
      // `message`。消费者按 `w.field` 取值会拿到 `undefined`。
      + '`field` 仅在告警属于某个具体字段时出现（如 `unknown_field` / '
      + '`type_mismatch` / `alias_normalized`），`non_json_body` 这类整条请求级的提示没有它，'
      + '② CLI 级的安装态提示（如 skill 未安装）——'
      + '同一次输出里已有 ① 时它被包成 `{kind:"skill_drift", message}`，否则是裸字符串。'
      + '故按 `w.kind` 取值前先判元素类型，别假定它一定是对象。'
      + '⚠️ 键不出现 ≠ body 正确：它只在「没有软告警且没有 CLI 提示」时不出现，'
      + '--no-validate 只保证不产生 ①（body 未校验），② 照旧出现。'
      + '⚠️ `missing_required` 永远不会出现在这里 —— 缺必填是硬拒绝（退出码 2、错误信封），'
      + '不要写「在 warnings 里找 missing_required」的分支。'
      + '它是本 CLI 的提示，不是上游的业务告警',
    not_found: 'true = 解包后的载荷为空。判据作用在解包后的 payload 上：'
      + 'data / result 形状下是 {} / []。形状 C 且 message 能解析成 JSON 时，'
      + '解析出的 {} / [] 同样置位（message 缺失或解析失败是失败，不是 not_found）。'
      + 'envelope 未登记的宽松模式下，message 能解析成 JSON 且结果为空同样置位。'
      + '整条 200 响应没有载荷键时，只有信封已实测且不是 D 族（A/B/D-nf）的接口判为查无此物'
      // ⚠️ 形状 C **不在**这个列表里：C 分支对任何响应都会先尝试解析 message，
      // `{code:200}`（无 message）在 C 上直接判失败，根本走不到末尾兜底。
      + '（形状 C 不在此列：它的无 message 是失败，不是查无此物）'
      + '（envelope 为 null 不在此断言。形状 M 的空 message 判失败，不判 not_found）。'
      + 'staffInfo 形状恒不置位。'
      + '⚠️ 只覆盖结构性为空：业务为空（如 ticket.search 查到 0 条返回 {total:0,tickets:[]}）'
      + '不会置位 —— 没有 not_found 不等于有数据',
    warning: '与 not_found 同时出现的一句话说明（固定文案）',
    unverified_endpoint: 'true = 该接口的响应信封形状从未实测（注册表 `verified:false`），'
      + '本次的 `not_found` 判定、`data` 解包与错误分类都只有文档依据。'
      + '具体后果：不知道载荷形状的接口，只有「message 能解析成 JSON 且结果为空」这类'
      + '宽松分支仍会判 not_found（它同时带 warning），其余情形一律不判 —— '
      + '「空 data 是什么」没人观测过，实测过 `deleteKnowledges` 的空数组是全部删成功，'
      + '按读接口判据会被报成什么都没删。'
      + '所以收到 not_found 仍然要怀疑，没收到 not_found 不等于有数据。'
      + '信封形状（A/B/C/D）也是推的，若与文档不符，`data` 可能取错键或落进宽松模式。'
      + '它不是这次调用失败的信号（调用本身可能完全成功），而是不要依据本次输出的'
      + '空/非空与字段形状下结论，必要时人工确认结果。'
      + '成功信封（ok:true）在 meta 里、错误信封（ok:false）在 error 里都有这个键，'
      + '含义相同，错误时的 kind 与 retryable 同样只有文档依据。'
      + '键不出现 = 该接口实测过（`verified:true`），不代表其余字段没有坑（见 note）',
    note: '该接口的已知坑（来自注册表，只在登记了 note 的接口上出现）。'
      + '⚠️ 它是静态说明、不是本次调用的结果',
  }
}
