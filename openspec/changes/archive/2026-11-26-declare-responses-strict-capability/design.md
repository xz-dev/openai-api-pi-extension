## Context

`index.ts` 的 `mapModel()` 决定插件交给 Pi 的模型默认值；富化目录再通过已有的 merge patch 应用规则。`stream` / `streamSimple` 将函数工具编码委派给 Pi。当前未声明 `supportsStrictMode` 时，通用 Responses 编码器会省略普通函数工具的 `strict` 字段。

相同网关、模型、提示和工具定义的对照实验得到了三对成功响应：省略该字段时，服务端回显 `strict:true`，将原本只有 `queries` 必填的 schema 改成六个字段全必填；显式 `false` 时，回显 `strict:false`，仅 `queries` 必填。该证据不等于已验证客户端显式请求 `strict:true`，也不代表所有网关都支持它。

## Goals / Non-Goals

**Goals:** 将端点能力声明放在模型发布边界，把工具是否采用严格采样留给 Pi 与工具作者。用请求体而非模型偶然生成的参数验证这一边界。

**Non-Goals:** 不重写工具 schema，不修改 `ctx_search` 的互斥校验，不修改 Pi 的 `prefer` / `require` 处理，不对未知 schema 自行降级或对网络错误自动重试协商。

## Decisions

1. **只在共享模型映射处增加默认能力。** 直接映射和经过元数据富化的目录都应得到相同默认值，再由既有规则覆盖。能力不由模型品牌、别名或元数据来源推断。逐模型白名单会遗漏新型号；登录时实测则引入额外请求和失败条件。
2. **不在 payload hook 强行设置 `strict`。** Pi 已能分别编码普通函数工具和显式 `constrainedSampling: {type: "json_schema", strict: "require"}` 的兼容工具。把所有工具硬编码成 `false` 会破坏后者；全部改成 `true` 则会重现普通工具的问题。
3. **分开验证客户端与服务端。** 离线契约测试在同一请求的 `tools` 中检查每个工具的标志与 schema；发布前，另用一个所有属性均必填且 `additionalProperties:false` 的分类工具，要求真实端点调用它。核对出站声明、服务端回显与返回值是否满足枚举等约束。不运行工具、不使用用户会话内容，不让联网测试成为常规 CI 的依赖。

## Risks / Trade-offs

- **非标准网关拒绝显式字段** → 使用已有规则 `overrides.compat.supportsStrictMode: false`，让普通工具恢复省略字段；Pi 的模型覆盖仍有最终决定权。不要用失败后静默重试掩盖真正要求严格模式的工具错误。
- **接受 `false` 但不能正确处理 `true`** → 将显式 `true` 的真实端点验证作为发布门槛；如果不通过，不将该端点报告为已验证支持严格工具，也不把失败改写成普通采样成功。

## Migration Plan

更新插件后使用现有目录刷新流程重新映射模型；本变更不改写用户的 `models.json`、YAML 或已持久化的目录。对不兼容端点，先通过现有覆盖关闭能力，再刷新并检查普通工具请求不含 `strict`。需要整体回滚时，撤销模型默认值并重新映射即可。
