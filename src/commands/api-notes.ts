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
    data: '上游响应解包后的载荷：本 CLI 按信封形状取出 data / result / staffInfo 等键，'
      + '取出后原样透传、不改写不脱敏。字段含义用 `qiyu api schema <id>` 查，'
      + '不要按其他命令 data 的形状推断',
    endpoint: '本次调用的接口 id（把结果与请求对上用）',
    warnings: '⚠️ 这是多来源数组，元素形状不统一：'
      + '① body 校验的软告警（对象，含 `kind` / `message`），'
      // ⚠️ `field` **不保证**存在（Sourcery 指出）：`non_json_body`（body_kind 非 json 时
      // 照原样发字面量）是**整条请求**级的提示，没有单一字段可归因 —— 它只带 `kind` 与
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
      + 'data / result 形状下是 {} / []; 形状 C 或宽松模式（envelope 未登记/形状非 A-D）'
      + '且 message 能解析成 JSON 时，解析出的 {} / [] 同样置位。'
      + '整条 200 响应没有载荷键时，只有信封已实测且不是 D 族（A/B/C/D-nf）的接口判为查无此物'
      + '（envelope 为 null 的接口在此不断言）。staffInfo 形状恒不置位。'
      + '⚠️ 只覆盖结构性为空：业务为空（如 ticket.search 查到 0 条返回 {total:0,tickets:[]}）'
      + '不会置位 —— 没有 not_found 不等于有数据',
    warning: '与 not_found 同时出现的一句话说明（固定文案）',
    note: '该接口的已知坑（来自注册表，只在登记了 note 的接口上出现）。'
      + '⚠️ 它是静态说明、不是本次调用的结果',
  }
}
