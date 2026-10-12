# Task 1 实施报告

## 做了什么

- 新建 `src/core/registry/params.ts`。
- 实现 `BodyKind`、`ParamSpec`、`ResponseShape`、`ParamFile` 类型。
- 实现 `validateParamsFile`：校验顶层结构、`bodyKind`/`in` 枚举、`required` 布尔值、`responseShape.kind` 字符串，以及 body/query 同名字段护栏。
- 实现 `setParamsRoot` 测试 root 注入和按 `(root,id)` 缓存的 `loadParams` 惰性加载；缺失、损坏或结构非法时抛出 `kind: 'internal'` 错误。
- 新建 `tests/core/registry/params.test.ts`，覆盖 brief 要求的 9 个用例。

## Step 1：先写失败测试

实际命令：

```text
mkdir -p tests/core/registry
```

随后按 brief 写入 `tests/core/registry/params.test.ts`。

## Step 2：确认失败

实际命令：

```text
npx vitest run --maxWorkers=1 --no-file-parallelism tests/core/registry/params.test.ts
```

输出摘要：测试套件无法加载 `../../../src/core/registry/params.js`，报 `Does the file exist?`；0 个测试执行，符合预期的模块缺失失败。

## Step 3：写最小实现

按 brief 写入 `src/core/registry/params.ts`。实现过程中修正了 `readFileSync` 调用中多余的逗号，使 URL 构造和读取调用语法准确。

## Step 4：确认通过

实际命令：

```text
npx vitest run --maxWorkers=1 --no-file-parallelism tests/core/registry/params.test.ts
```

输出摘要：`tests/core/registry/params.test.ts (9 tests)` 全部通过，`1 passed`，`9 passed (9)`。

另执行：

```text
git diff --check
```

无格式错误。

## Step 5：提交

提交命令按 brief 执行，并使用要求的中文提交信息及署名。

提交短 SHA：`d8307ca`

## 自审发现与修正

- 发现 Step 3 写入时 `readFileSync(fileURLToPath(new URL(...)), 'utf8')` 位置出现多余逗号；已用精确编辑修正。
- 修正后重新运行目标测试，9/9 通过。
- 提交后工作区干净。

## 遗留疑虑

无。仅运行了 brief 指定的目标测试，未运行全量测试。

## 审查修复追加

- 改动：在 `src/core/registry/params.ts` 的 `params.map` 回调首行增加元素必须为非空对象的运行时校验；`null`、数组、字符串和数字现在均抛出带 `[i] 必须是对象` 的结构错误，避免原生 `TypeError`。
- 测试：在 `tests/core/registry/params.test.ts` 增加 `null` 元素和数组元素两条断言，验证错误包含 `[0] 必须是对象`。
- 实际命令：

```text
npx vitest run --maxWorkers=1 --no-file-parallelism tests/core/registry/params.test.ts
```

- 实际输出摘要：`tests/core/registry/params.test.ts (11 tests)`，`1 passed`，`11 passed (11)`。
- 涉及测试文件：`tests/core/registry/params.test.ts`。
