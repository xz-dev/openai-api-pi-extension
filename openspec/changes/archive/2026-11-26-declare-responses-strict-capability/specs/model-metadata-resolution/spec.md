## ADDED Requirements

### Requirement: Responses 函数工具严格模式的端点能力默认值

插件映射 Responses 模型时 SHALL 默认声明 `compat.supportsStrictMode: true`，无需逐模型配置。该字段 SHALL 表示端点接受显式的工具严格模式选项，而不是所有工具必须开启或关闭严格模式。插件 SHALL 保留 Pi 的逐工具选择，以及现有规则 `overrides` 和最终 Pi `modelOverrides` 对模型能力的覆盖顺序。

#### Scenario: 不配置型号也得到能力声明

- **WHEN** 网关目录返回一个先前未知的可用模型，用户没有配置覆盖
- **THEN** 插件从目录映射并发布的该模型包含 `compat.supportsStrictMode: true`，不依赖型号匹配或另一次能力探测请求

#### Scenario: 同一请求混用普通工具和严格工具

- **WHEN** 默认配置下，同一 Responses 请求声明两个函数工具：搜索工具只要求 `queries`、未请求严格采样；分类工具具有合法的严格 schema 且明确要求严格采样
- **THEN** 搜索工具的声明带 `strict:false`，其 `parameters.required` 仍只有 `queries`
- **AND** 分类工具的声明带 `strict:true`，搜索工具的设置不影响它

#### Scenario: 端点不接受 strict 字段

- **WHEN** 匹配的插件规则将 `compat.supportsStrictMode` 覆盖为 `false`，Pi 没有再覆盖，并发送普通函数工具
- **THEN** 该工具的请求声明不含 `strict` 字段（不是 `strict:false`），恢复以前的请求格式

#### Scenario: Pi 模型覆盖仍最后生效

- **WHEN** 插件规则将能力设为 `false`，Pi 对同一模型的最终 `modelOverrides` 将能力设为 `true`
- **THEN** 普通函数工具的请求声明带 `strict:false`；无关的兼容性字段不被这项默认值覆盖
