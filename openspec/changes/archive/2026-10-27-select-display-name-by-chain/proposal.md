## Why

显示名目前固定取网关行的 `name`/`display_name`，外部来源的名称永不生效，而其他字段都按来源链取第一个有效值。AI-gateway 的 models-enricher 已按链把 `name` 映射为显示名（与原 Go 实现一致）。用户于 2026-10-27 决定插件与网关统一：显示名也按来源链选择。

## What Changes

- **BREAKING**：显示名改为普通链字段。归一化字段 `name`（别名 `name`/`display_name`）按生效链顺序取第一个有效值：`@self` 等记录来源在其位置提供网关/上游显示名，外部条目提供其记录名称。使用默认链（外部来源在 `@self` 之前）时，可见名称会变为外部来源的名称，例如 `My Fable` → `Claude Fable 5.1`。
- 想保留网关显示名的用户把 `@self` 放在链首，或使用 `["@self"]`。
- 链中没有任何条目提供名称时，显示名回退为公开模型 ID（与原有 ID 回退一致）。
- 规则 `overrides` 的 `name` 与 Pi `modelOverrides` 仍最后生效。
- 公开模型 ID、请求型号、认证、baseUrl 与路由不变。
- 文档 `docs/model-metadata.md` 更新显示名规则。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `model-metadata-resolution`：需求“上游目录控制模型成员”中的显示名规则由“保留网关显示名”改为“按来源链选择”。

`metadata-compile-view` 不变：导出文件已按链条目列出各条目可提供的字段（含 `name`），不声明最终取值来源，因此无需增量。

## Impact

- 代码：`index.ts` 的 `mapModel` 显示名取值。
- 测试：`tests/model-metadata.test.ts` 新增显示名场景；`tests/provider-lifecycle.test.ts` 调整原“网关显示名不变”断言。
- 文档：`docs/model-metadata.md`。
- 用户可见：默认链下大部分模型的显示名改变；模型 ID 与会话不受影响。
