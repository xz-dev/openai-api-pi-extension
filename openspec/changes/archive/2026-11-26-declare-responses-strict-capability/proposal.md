## Why

当前插件未声明网关是否支持 Responses 工具的 `strict` 字段。已测试的端点在该字段缺省时把普通工具的可选参数全部改成必填，使 `ctx_search` 的两种分页方式都无法合法调用；逐模型手写配置不应是正常使用的前提。

## What Changes

- 插件为其映射的 Responses 模型默认声明 `compat.supportsStrictMode: true`。这是对端点能力的声明，不是替所有工具选择严格模式。
- 保留 Pi 的逐工具策略：普通函数工具发送 `strict:false`；显式要求严格采样且 schema 兼容的函数工具发送 `strict:true`，两者可以出现在同一请求中。
- 不支持该字段的兼容网关可通过已有规则关闭这项声明；Pi 的 `modelOverrides` 仍最后生效。记录该兼容性变化及退出方式，不引入探测请求或型号名单。

## Capabilities

### New Capabilities

### Modified Capabilities

- `model-metadata-resolution`：为发布的 Responses 模型增加可覆盖的协议能力默认值，保持用户对严格工具与普通工具的选择。

## Impact

涉及模型映射、provider 请求契约测试和配置文档。原先收到的请求没有 `strict` 字段；拒绝该字段的端点需显式退出。不更改 Pi 编码器、传输桥、工具 schema 或个人配置，不新增依赖。
