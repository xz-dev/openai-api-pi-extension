## Why

AI-gateway 将以 TypeScript 重写 models-enricher，并以 git submodule 复用本插件的元数据编译核心。现有实现有四处不支持这种复用：
- 编译入口依赖 Pi（`getAgentDir`）。
- `@self` 硬编码在链解析中，网关无法注册 `@cpa-upstream` 等自有记录来源。
- `match:` 使用 `*` 跨越 `/` 的非标准 glob。
- 没有按模型 ID 选择可见模型的配置。

两端需要共享同一套语义，所以先在插件侧修正并开放这些边界。

## What Changes

- **记录来源关键词注册**：整条链条目 `@<name>` 改为由宿主注册的记录来源（宿主提供按公开模型 ID 返回原始能力记录的函数）。插件注册 `@self`（当前模型的上游目录行）。未注册的 `@` 关键词作为配置错误报告，并列出当前宿主可用的关键词。`@creator`、`@id`、`@default` 仍是内置编译规则，不可注册。
- **BREAKING**：`models[].match` 改为标准 glob，语义与 minimatch 一致：`*`、`?` 不跨越 `/`，`**` 可跨段，支持字符类与花括号，开头 `!`、`#` 按字面处理，`.` 开头的段可匹配，区分大小写。原先依赖 `*` 跨越 `/` 的规则需改写为 `**`，例如 `*gpt-6-astra` → `**/*gpt-6-astra`；文档给出迁移说明。
- 新增根级 `include_models`：有序 glob 列表，`!` 前缀表示排除，最后命中的条目决定结果，未命中任何条目的模型被隐藏。缺省该字段时包含全部模型；空列表作为配置错误。被隐藏的模型不参与编译、不发布、不计入命中统计。它与 `match` 使用同一匹配器。
- `/provider-metadata` 导出文件列出被隐藏的模型，以及决定隐藏的规则序号（或"无规则命中"）。
- 新增宿主中立的编译入口：不导入 Pi 宿主包，`tablesPath` 成为正式选项；导出 SourceTables 构建函数，供宿主在构建期把数据包预转换为 SourceTables JSON。Pi 侧行为不变。
- 新增 `.github/dependabot.yml`（npm，每周检查）。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `model-metadata-resolution`：
  - 链条目语法：`@self` 改为宿主注册的记录来源。
  - 规则匹配：改为标准 glob。
  - 新增 `include_models` 模型选择。
  - 新增宿主中立编译入口与 `tablesPath` 选项。
- `metadata-compile-view`：导出文件标注被 `include_models` 隐藏的模型及隐藏原因。

## Impact

- 代码：
  - `model-metadata.ts`：链解析、计划节点、`matchModelPattern` 和字段解析。
  - `metadata-config.ts`：`include_models` 校验。
  - `metadata-compile.ts`、`metadata-compile-worker.mjs`：拆出宿主中立部分。
  - `index.ts`：在编译前选择模型，并注册 `@self`。
  - `metadata-view.ts`：导出隐藏模型。
  - 新增一个宿主中立入口模块；更新 `package.json` 的 `files`。
- 依赖：继续使用已声明的 `minimatch` 10.2.6，不新增运行时依赖。
- 测试：需要改写 `tests/model-metadata.test.ts` 中旧 glob 语义的断言（`*` 跨 `/`），并新增注册来源、`include_models`、宿主中立入口无 Pi 依赖的测试。
- 文档：在 `docs/` 的模型元数据专题补充 glob 迁移、`include_models` 与记录来源关键词。
- 前置：未归档的 `allow-optional-model-id-separators`、`manage-metadata-updates-and-prefix-output` 任务均已完成。本变更修改的 requirement 与它们不重叠，但实施前应先归档这两个变更，使主规格成为基线。
- 下游：AI-gateway 变更 `rewrite-models-enricher-in-typescript` 依赖本变更。
