## Why

插件当前直接映射上游 Codex `models[]`，缺少能力字段时只能使用固定默认值，且拒绝标准 OpenAI `data[]`。需要在上游可调用模型清单之上增加可排序的元数据来源链，沿用 ai-gateway 的分层配置语义，同时允许按模型选择全覆盖或仅补漏。

## What Changes

- 接受公开 `/models` 返回的 `models[]` 与 `data[]`，以上游目录作为模型成员与请求 ID 的唯一依据，不调用 CPA 管理接口。
- 沿用 ai-gateway 的来源链配置结构：根级 `source_priority`、`channels`、模型级 `source_priority`、`global_fallback`、`lookup_ids`、`provider_prefix_map` 和人工 `overrides`；兼容原有精确来源 token。
- 内置默认链 `['*/subscription', '*/api_key']`。未配置根级链时使用默认链；显式空链关闭外部来源；用户列表顺序优先于内置顺序。
- 增加按来源站点、provider 和访问类型选择来源的通配符；同一选择器内默认 models.dev 优先于 modelparams.dev，跨 provider 的同名记录不依赖接口返回顺序选胜者。
- models.dev 通过内置订阅 provider 分类表识别订阅，其余归入 API 组；这是本地分类政策，不是该站提供的认证事实。modelparams.dev 使用其 `authType`。
- 增加根级 `models.<pattern>` 与渠道 `models.<pattern>` 的模型规则：根级匹配完整公开 ID，渠道规则匹配剥离一次渠道前缀后的 ID；`*` 是可跨 `/`、可匹配空串的字符串通配符。每个规则块内精确键优先，否则采用配置顺序中的首个匹配 glob，不叠加其他命中规则。
- 增加 `fill_missing_only`，默认 `true`（仅补漏）；显式 `false` 为全覆盖。模型层内部按渠道模型规则 > 全局模型规则覆盖，再继承渠道默认 > 全局默认；显式 `false` 可覆盖父级 `true`，人工覆盖及 Pi `modelOverrides` 不受补漏开关限制。
- **BREAKING**：未配置来源链的在线目录刷新默认读取外部公开目录，用命中字段补齐上游缺失或无效的元数据（上游已有有效值保持不变）。设置根级 `source_priority: []` 可退出此行为；现有认证、推理和传输路径不变。
- 复用 Pi 的目录发布、持久化与离线恢复；外部来源失败不冒充认证失败，取消不得发布半成品。

## Capabilities

### New Capabilities

- `model-metadata-resolution`: 公开目录适配、来源选择与通配符优先级、模型 ID glob 规则、分层配置、双模式元数据合并及目录生命周期。

### Modified Capabilities

无。项目当前没有已有能力规格。

## Impact

- `index.ts`：`fetchCatalog`、`fetchModels`、`mapCatalog`、`mapModel`，以及登录验证、启动预取、`refreshModels`、`/provider-info` 的共同目录路径。
- 建议增加小型 `model-metadata.ts`（配置/选择/合并）和 `metadata-sources.ts`（公开来源适配），不修改 WebSocket、压缩或 checkpoint 所有者。
- 用户配置建议放在 `getAgentDir()/openai-api-extension.yaml`；仅增加此配置文件的读取，不自动创建或改写用户配置。YAML 使用成熟解析库；来源 provider 通配符复用已安装的 `minimatch`，模型 ID 通配符使用跨 `/` 的字符串语义，不直接套用默认路径 glob。
- `tests/map-models.test.ts`、`tests/provider-lifecycle.test.ts`、`tests/loader-regression.test.ts` 及聚焦元数据测试；`README.md` 的目录行为与配置说明；`package.json` 的发布文件清单和 YAML 依赖。
- 外部依赖为 models.dev 与 modelparams.dev 的公开批量目录；不携带网关凭证、对话或用户模型清单。
- 本变更兼容来源链相关配置，不复制 CPA 服务端完整配置。`static_models`、`custom_channels`、`metadata_from`、CPA 渠道发现、Ollama 私有采集、推理失败换模型及路由配置不在本次范围；这些字段被忽略并输出警告（列出字段路径），其余配置继续生效，不能静默声称兼容。
