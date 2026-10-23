## Why

当前元数据补全链在运行时对外部目录做 glob/通配符模糊匹配，一个聚合 provider 的命名空间变体（如 models.dev `llmgateway-providers` 下的 `anthropic/`、`azure-anthropic/`、`aws-bedrock/` 三条 `claude-fable-5-1`）就会让整个站点组被判为“冲突重复”，导致 22 个完全一致的候选全部作废，模型拿不到任何外部元数据；同时配置面有 7 套互相修补的概念（selector 三种写法、`provider_prefix_map`、`lookup_ids`、`models_dev_subscription`、`channels`、`global_fallback`、四级继承），难以预测、难以排查。外部数据还依赖每次刷新联网拉取 models.dev / modelparams.dev。

## What Changes

- **BREAKING** 补全链改为“先编译后执行”：配置与内置规则在编译期展开成每个模型一份固定、确定、可打印的具体来源链，条目格式统一为 `<site>/<provider>/<access>/<model_id>`；执行期只做精确查表，不再有运行时 glob 或通配符。
- **BREAKING** 链条目语法收敛为 `<site>/<provider>/<access>[/<model_id>]`，任何位置都不允许 `*`；只支持字面值与固定关键词 `@creator`、`@id`（省略第 4 段）、`@default`。
- 新增 `@creator`：从 models.dev 的 `canonical_model_id` 确定模型原厂，经内置有序厂商别名组（如 `zhipuai, zai, z-ai`）展开，每个站点只保留自身命名空间中存在的成员。找不到原厂时该条目标为 unresolved 并跳过；原厂不明确时作为配置错误阻止目录更新。
- 新增 `@id`：公开模型 ID 最右一段加内置归一化候选（大小写、`.`/`-`、日期后缀），必须精确命中。
- **BREAKING** 默认链改为 `models.dev/@creator/api_key`、`modelparams.dev/@creator/api_key`，默认不使用 subscription 来源。
- **BREAKING** `fill_missing_only` 默认改为 `false`（外部值覆盖网关值）。
- **BREAKING** `models` 改为有序规则列表 `- match: <glob>`，所有命中规则按顺序逐字段叠加，后者覆盖前者；规则 key 仍是公开 ID 的字符串 glob。
- **BREAKING** `overrides` 改为作用于最终 Pi Model（camelCase 字段），按 RFC 7396 JSON Merge Patch 逐层合并，`null` 删除字段。
- **BREAKING** 删除 `source_priority`、`provider_prefix_map`、`lookup_ids`、`models_dev_subscription`、`channels`、`global_fallback` 及旧 mapping 形式的 `models`；遇到这些旧字段报配置错误并给出迁移提示。删除 models.dev 订阅命名规则分类。
- **BREAKING** 外部元数据改为读取本地 npm 包 `@opencode-ai/models`（snapshot）与 `modelparams`，不再联网请求两站 API；依赖版本不加限制，仓库不再提交 lockfile，以便用户自行更新数据包。
- **BREAKING** 移除扩展工厂的阻塞式目录预取，完全复用 Pi 原生缓存恢复与界面就绪后的后台刷新；首次无缓存 CLI 使用 `pi --refresh --list-models` 获取目录，普通 `--list-models` 不联网。
- 编译时加载的完整外部数据在得到编译结果后释放，插件只保留给 Pi 的模型表。
- 新增一个独立命令（暂定 `/provider-metadata`）：生成临时文件并输出其绝对路径，不展示内容；用户自行用编辑器/pager 打开，文件由系统临时目录清理。
- 元数据提示（notes）不再以错误条目渲染。

## Capabilities

### New Capabilities
- `metadata-compile-view`：查看编译结果的独立命令与临时文件输出行为。

### Modified Capabilities
- `model-metadata-resolution`：链语法、来源解析、原厂判定、默认链与合并模式、模型规则层叠、人工覆盖语义、旧配置处理、外部数据来源与生命周期均发生变化。

## Impact

- 代码：`model-metadata.ts`（配置解析、规则选择、链解析、合并）、`metadata-sources.ts`（由 HTTP 读取改为本地包加载与编译）、`index.ts`（`enrichCatalog` 接线、notes 渲染、新命令）、相关测试。
- 依赖：新增 `@opencode-ai/models`、`modelparams`（`"*"`）；`minimatch` 保留（`checkpoint-adapter.ts` 仍在用）；移除仓库内 `package-lock.json`。
- 用户配置：现有 `~/.pi/agent/openai-api-extension.yaml` 若使用旧字段将报错，需要按迁移提示改写。
- 文档：README 的 Model metadata 章节与配置示例需重写，并说明数据包更新方式。
