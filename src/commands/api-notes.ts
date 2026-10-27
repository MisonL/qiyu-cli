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
    warnings: 'body 校验的软告警（缺省字段、别名归一、取值可疑）。没有软告警时这个键不出现，'
      + '--no-validate 时恒不出现。⚠️ 不出现 ≠ body 正确（--no-validate 根本没校验）。'
      + '它是本 CLI 的校验提示，不是上游的业务告警',
    not_found: 'true = 上游返回结构上为空（data 键缺失 / {} / []）。'
      + '⚠️ 只覆盖结构性为空：业务为空（如 ticket.search 查到 0 条返回 {total:0,tickets:[]}）'
      + '不会置位 —— 没有 not_found 不等于有数据',
    warning: '与 not_found 同时出现的一句话说明（固定文案）',
    note: '该接口的已知坑（来自注册表，只在登记了 note 的接口上出现）。'
      + '⚠️ 它是静态说明、不是本次调用的结果',
  }
}
