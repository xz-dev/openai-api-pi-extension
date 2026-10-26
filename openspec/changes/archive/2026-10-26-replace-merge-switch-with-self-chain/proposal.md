## Why

当前 `fill_missing_only` 把上游与外部元数据的优先级拆成独立开关，无法直接从来源链看出完整的取值顺序。将上游表示为有序来源 `@self`，可用同一套逐字段优先级表达外部覆盖、上游补缺与严格替换。

## What Changes

- 支持完整链条目 `"@self"`，表示当前公开模型的上游能力元数据；按 `@default` 展开后的链顺序，每个字段采用首个有效值。
- 外部来源在 `@self` 前时优先覆盖，`@self` 在外部来源前时优先保留上游；没有 `@self` 时不采用上游能力字段，链均未提供的字段由既有最终默认值补入。
- 内置默认链改为 `["models.dev/@creator/api_key", "modelparams.dev/@creator/api_key", "@self"]`，保留未配置用户的外部优先、上游兜底行为。
- **BREAKING**：删除根级与模型规则的 `fill_missing_only`。出现旧字段时报配置错误并提示按链顺序迁移，保留此前已验证目录，不自动转换或静默忽略。
- **BREAKING**：根级与模型规则均禁止显式 `chain: []`，错误提示仅上游应改为 `chain: ["@self"]`；省略 `chain` 仍表示继承。
- **BREAKING**：显式外部链不再隐式保留上游能力字段；需要保留时必须在合适位置声明 `@self`。
- 编译结果用具体上游来源节点表达 `@self` 的位置，不再输出旧布尔模式；仅上游链不加载外部数据包，也不计入外部匹配失败。
- 在详细配置文档标明上游、外部来源及用户覆盖均未提供能力字段时的最终默认值，区分固定默认、派生回退和非真实计费占位；本次不改变这些默认值。
- 将 README 收敛为功能特色、最简安装和登录使用入口。环境变量、元数据配置、最终默认值、传输/故障恢复及开发细节按主题迁入 `docs/`，复用已有压缩与检查点文档并修复相对链接。
- 保持公开模型成员、ID、网关显示名、认证和推理路由，以及最终人工 `overrides` / Pi `modelOverrides` 的顺序不变。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `model-metadata-resolution`：以有序 `@self` 来源替代合并开关，明确默认链、严格替换、空链错误、旧字段迁移、降级回退及外部命中统计。
- `metadata-compile-view`：导出展开后的上游来源位置与能力来源，移除布尔合并模式，并继续保持固定执行计划、脱敏与只读导出。

## Impact

- `metadata-config.ts`：关键词校验、空链拒绝、根级与规则级旧字段迁移提示。
- `model-metadata.ts`：配置/编译类型、默认链、来源展开、有序字段选择、运行时上游来源绑定及命中分类。
- `metadata-compile.ts`：按生效链判定所需站点，确保 `@self` 不触发数据包加载。
- `index.ts`：防止原始上游能力字段绕过严格替换；保留身份、最终默认值与覆盖顺序。
- `metadata-view.ts`：上游来源节点与顺序展示，不再展示 `fill_missing_only`。
- 现有元数据、Worker、目录生命周期与临时文件导出测试及相关夹具。
- `README.md` 入口精简；`docs/configuration.md`、`docs/model-metadata.md`、`docs/transports.md`、`docs/development.md` 分主题承接现有详情，`docs/request-compression.md` 与 `docs/response-checkpoints.md` 复用既有内容并更新交叉链接。不新增独立文档索引层级，不重复维护同一规则。
- 复用现有测试框架，不新增依赖，不修改认证、网络传输、数据包更新机制或既有最终默认值。
