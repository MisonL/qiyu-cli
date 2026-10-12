# Task 6 实施报告

## 做了什么

- `src/commands/api.ts`
  - 增加 `loadValidationOverrides`、`loadParams`、`normalizeAliases`、`validateBody` 接入。
  - `callOne` 的 `KNOWN` 增加 `--no-validate` 与 `--strict`。
  - 按要求接入门内次序：`byId → assertCallable → assertNoValidateStrictConflict → loadValidationOverrides → loadParams → 校验/别名归一化 → assertConfirmed`。
  - `--no-validate` 只跳过别名归一化与 body 校验，仍加载 params 并保留危险接口确认门禁。
  - 将别名归一化后的 body 重新赋给 `body`，并把 warnings 合入成功 meta。
  - 未实现、未改动 schema 分派。
- `tests/commands/api.test.ts`
  - 增加 B 块端到端验收：硬/软校验、别名归一化、warning 顺序、strict、`--no-validate`、params 缺失、危险门禁次序、非对象 body、危险成功 warning。
  - 修正两处既有 `message.send` 用例，补全 `uid/msgType/content` 以保持门禁语义。
  - 每个 stub fetch 的新增用例均显式调用 `vi.unstubAllGlobals()`。

## Step 实际命令与输出摘要

- Step 1：编辑测试，加入 B 块失败基线。
- Step 2：`npx vitest run --maxWorkers=1 --no-file-parallelism tests/commands/api.test.ts`
  - 结果：FAIL，57 个测试中 6 个失败。
  - 失败与预期一致：缺必填危险请求先返回 4、warnings 不存在、`--no-validate` 未进 `KNOWN` 返回 2。
- Step 3：编辑 `src/commands/api.ts` 与测试，接入实现并补齐验收矩阵。
- Step 4：`npm run typecheck`
  - 结果：通过。
- Step 4：`npx vitest run --maxWorkers=1 --no-file-parallelism tests/commands/api.test.ts`
  - 最终结果：PASS，`67 tests passed`。
- 额外：`git diff --check`
  - 结果：通过，无空白错误。

## 自审发现与修正

- 首轮只加入部分 B 块测试，发现未覆盖验收 31 及其余矩阵后补齐。
- 一次测试块插入造成 describe 括号边界错误，按类型检查与 Vitest 语法错误定位并修正。
- 新增 fetch spy 的调用元组推断过窄，改为显式 `fetch` 参数类型。
- “无必填接口”测试最初错误使用 `ai.knowledge.search`，读取 params 后确认其 `robotId` 必填，改用 `ticket.search` 的真实成功信封与 `icoutcall.phone.getLineList`。

## 遗留疑虑

- 无。未执行真实七鱼请求；测试均使用 stub fetch。

## 第 2 轮修复（Task 10 验收核对）

- `tests/commands/api.test.ts`
  - 补充验收 11 前半句的端到端断言：危险接口 `message.send` 缺少 `msgType` 与 `content`、未传 `--yes` 时返回退出码 2，而不是先触发危险门禁返回 4。
  - 断言请求未发出、错误类型为 `usage` 且不含 `confirm_required`，覆盖 D5「校验先于门禁」。
- 源自 Task 10 对 spec §九 验收 11 的逐条核对：既有完整 body 用例已覆盖「补必填 + 无 `--yes` → 4」，本轮补齐「缺必填 + 无 `--yes` → 2」。
- 验证：`npx vitest run --maxWorkers=1 --no-file-parallelism tests/commands/api.test.ts`，`79 tests passed`。
