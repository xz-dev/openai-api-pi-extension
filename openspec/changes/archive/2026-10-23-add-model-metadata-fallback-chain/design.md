## Context

动机见 `proposal.md`。已核对的当前行为：

- 插件 `index.ts:196–273` 在映射时立即补入 context/output 默认值；`fetchCatalog` 只接受 Codex `models[]`。
- `index.ts:305–478` 的登录、目录刷新和持久化已有明确所有者；启动预取与 `/provider-info` 也调用目录获取路径。不能只修改其中一个入口。
- `AI-gateway/models-enricher/config.go:129–152` 定义模型链整体替换、渠道链追加全局链及显式空链关闭；`merge.go:148–200` 定义来源覆盖上游、人工覆盖来源。`metadata.go:28` 的对象递归合并、数组整体替换、null 不擦除下层可作为参照。
- 公开数据检查：`https://models.dev/api.json` 按 provider 组织且没有统一 authType；`https://modelparams.dev/api/v1/models.json` 的模型记录包含 provider、authType、apiSurface、model、params。不能把来源排序误作模型身份验证。
- 当前 `README.md` 的“缺少 limits 拒绝整个目录”段落已与现有默认值行为冲突，更新本功能文档时一并纠正相关描述，不扩大到传输功能。

## Goals / Non-Goals

**Goals:**
- 上游目录控制成员及公开 ID，来源链只解析元数据；同一组输入产生稳定结果。
- 保留缺失状态到最后一步，默认补漏（`fill_missing_only: true`），三级可显式切换为全覆盖。
- 分离纯配置/解析逻辑与公开目录 I/O，让现有 node:test 能通过 provider 的输出验证规则。

**Non-Goals:**
- 不复制 gateway 服务、路由、CPA 管理发现或独立凭证系统。
- 不引入来源评分、模糊型号推荐、模型能力探测或完整 CPA YAML 兼容层。
- 不改 pricing、checkpoint、传输 retry、请求参数策略；只补充当前模型映射消费的名称、context/output 限额、模态和显式 reasoning levels。未知字段不得直接注入 Pi model 或请求。

## Decisions

### 1. 确认项与提案建议分开

用户已确认：默认补漏（`fill_missing_only` 默认 true；2026-10-23 用户更正此前“默认全覆盖”的记录，只读验收亦显示全覆盖会把网关有意设定的 500k contextWindow 改为公开值 1M+）；`fill_missing_only` 按全局、渠道、模型三级覆盖；内置默认链订阅优先；用户可用 `*/subscription`、`*/api_key` 排序；models.dev 未识别 provider 归 API。后续确认增加完整公开模型 ID 的字符串 glob：`*gpt-6-astra` 覆盖任意前缀及裸名，`*gpt*` 匹配完整 ID 中任意位置的 gpt；每个 models 块内精确键优先，否则采用首条匹配 glob，作用域按渠道模型规则 > 全局模型规则 > 渠道默认 > 全局默认继承。

实施前进一步确认：配置文件为 `~/.pi/agent/openai-api-extension.yaml`；gateway 专属或暂不支持的字段忽略并警告；同站点组多 provider 同名时以模型开发商自己托管的条目为准（见第 5 节），无法唯一确定开发商条目时才跳过该组。字段缺失定义、来源失败处理沿用本设计。

### 2. 配置文件和分层规则

读取 `getAgentDir()/openai-api-extension.yaml`，不新增项目级配置文件或环境变量，不自动写出默认配置。每次在线目录刷新读取一次快照；缺少文件等同空配置。文件存在但 YAML/类型/选择器无效时停止本次目录更新，保留旧目录并报告配置错误，不静默启用默认链。

```yaml
# 不写 source_priority 时使用下列内置值。
source_priority:
  - "*/subscription"
  - "*/api_key"
fill_missing_only: true  # 内置默认；false 才允许外部值覆盖上游已有字段

models:
  "*gpt-6-astra":
    source_priority: ["models.dev/openai", "modelparams.dev/openai/subscription"]
    fill_missing_only: false
  "*gpt*":
    fill_missing_only: true

channels:
  proxy:
    source_priority: ["models.dev/*/subscription"]
    global_fallback: true
    fill_missing_only: true
    models:
      model-a:
        source_priority: ["modelparams.dev/z-ai/subscription", "*/api_key"]
        fill_missing_only: false
        lookup_ids:
          modelparams.dev/z-ai/subscription: model-a-v2
        overrides:
          context_window: 128000
```

根级未配置链使用内置链，根级显式链整体替换内置链，不自动附加默认尾部。先在渠道 models 块与根级 models 块分别选出至多一条规则（见第 2a 节），然后按渠道模型规则 > 全局模型规则查找显式 source_priority；找到时整体替换渠道及全局链，包括显式 `[]`。两条所选模型规则均未提供链时，仍用 gateway 的渠道规则：渠道链在前，开启 global_fallback 时追加全局链；渠道显式 `[]` 禁止继承；渠道未配置链且 global_fallback=false 时来源为空。根级 `[]` 不取消显式配置的渠道或模型链。

模式独立继承：渠道模型规则 > 全局模型规则 > 渠道默认 > 全局默认 > false。高层未设置时才向下查找，必须按字段是否存在判断，不能用布尔 OR；null 不是合法布尔值。同一 models 块中的未选中规则不参与继承。

未知顶层/渠道/模型字段（如 `static_models`、`custom_channels`、`metadata_from`、`cpa_base_url`、`fetch_models`、`ollama_native_base_url`）被忽略并输出一次警告，列出完整字段路径；其余配置照常生效。已识别字段的值类型或 selector 非法仍属配置错误。

兼容子集包括根级/渠道 `provider_prefix_map`、渠道旧式 `overrides.<model>` 和 `models.<pattern>.overrides`。人工覆盖从低到高为全局所选模型 overrides、渠道旧式精确 overrides、渠道所选模型 overrides；最后仍由 Pi modelOverrides 覆盖。模型规则的 lookup_ids 按精确来源键合并，渠道规则同键优先于全局模型规则；lookup_ids 的键和值都不做模型 glob 或捕获替换。其余 CPA 专属或暂未实现字段明确报不支持。选择 YAML 而非另造 JSON 方言，目的是让来源链段可直接迁移；采用 `yaml` 库，不手写解析器。

### 2a. 模型规则是字符串 glob，不是路径 glob

根级 `models` 在本插件上游目录范围内匹配完整公开 ID，覆盖带任意 provider/渠道前缀的 ID 和裸名；不会修改其他 Pi provider 的模型配置。渠道 `models` 保持既有相对身份范围：仅对已匹配该渠道的模型，在剥离一次渠道前缀后的剩余 ID 上匹配。

模型规则匹配区分大小写、锚定整个字符串。`*` 表示零个或多个任意字符，包含 `/`；其余字符按字面匹配。本次不新增正则、捕获替换或路径专用的 `**` 语义，连续 `*` 等同一个 `*`。带星号的 YAML 键必须加引号。

- `*gpt-6-astra` 匹配 `gpt-6-astra`、`openai/gpt-6-astra`、`proxy/openai/gpt-6-astra`，但不匹配 `gpt-6-astra-preview`。
- `*gpt*` 匹配任意位置含 gpt 的完整 ID，也包括 `gpt-proxy/claude`；不暗中限制到最后一段或猜测模型家族。
- 不含 `*` 的键只做精确匹配；根级 `gpt-6-astra` 不等同 `openai/gpt-6-astra`。

每个 models 块先找精确键，无精确键时按 YAML 声明顺序选第一条匹配 glob。保留配置顺序，不按模式长短或“具体程度”重新排序；重复键是配置错误。不合并同块其余匹配规则的字段。例如精确规则只有 fill_missing_only 时，其 source_priority 向下一作用域继承，不从同块的宽泛 glob 补入。全局规则与渠道规则分别选择，再按第 2 节的作用域优先级合成配置。

该匹配只选择元数据策略，不把 `*gpt*` 当成外部目录查询 ID。后续来源查询仍使用每个实际模型的明确身份、provider_prefix_map 与 lookup_ids，并遵守第 5 节的无歧义规则。来源 provider 模式可继续复用 minimatch；模型规则必须使用非路径字符串匹配，不直接使用 minimatch 默认的 `/` 分段行为。

### 3. Selector 语法与内置排序

以下形式用于 `source_priority` 的来源选择器；它们与第 2a 节的 models 键字符串 glob 分别解析：

| 形式 | 含义 |
|---|---|
| `models.dev/<provider>` | 兼容既有精确 token，不限制访问类型 |
| `modelparams.dev/<provider>/subscription` 或 `/api_key` | 兼容既有精确 token |
| `*/subscription`、`*/api_key` | 所有支持站点及 provider 的指定访问类型 |
| `<site>/<provider-pattern>/<access>` | 限定站点、provider 模式及访问类型；site 为 models.dev、modelparams.dev 或 `*`；access 为 subscription、api_key 或 `*` |
| `models.dev/<provider-pattern>` | models.dev 的未限定访问类型选择器，例如 `models.dev/*` |

provider-pattern 仅支持字面字符与 `*`；不支持 `**`、正则、否定、花括号、路径穿越或任意 URL。`*/subscription` 是显式定义的二段缩写，不依赖 glob 的跨斜杠行为。先解析各段，再复用已有 minimatch 匹配 provider 段。

优先级为：用户列表位置 > 同一选择器内站点次序 models.dev、modelparams.dev。不在列表外再做一次订阅排序。因此用户设置 `["*/api_key", "*/subscription"]` 确实会让 API 优先；显式先列 modelparams.dev 也能让它优先于 models.dev。

选择器从当前批量来源表展开，已成功解析并采用的最终来源查询只保留第一次。`models.dev/zai` 与覆盖它的 `models.dev/*/api_key` 不得让同一已采用记录获得第二次覆盖机会。空匹配跳过，继续下一项；因歧义而跳过的组不占用去重位置，后续更具体的 selector 仍可消歧。按字段解析高优先级已声明值，缺失字段继续从低优先级来源补齐，而不是首个命中模型记录后整条链停止。

### 4. 访问类型分类是本地政策

modelparams.dev 使用记录的 authType；缺失/未知类型不冒充 subscription 或 api_key，`<site>/<provider>/*` 可显式包含此类记录。

models.dev 使用随插件发布的明确订阅 provider ID 集合，其余统一归 api_key，遵循用户选择。初始集合采用当前目录的订阅产品条目：alibaba-coding-plan、alibaba-coding-plan-cn、github-copilot、kuae-cloud-coding-plan、minimax-cn-coding-plan、minimax-coding-plan、tencent-coding-plan、umans-ai-coding-plan、volcengine-coding-plan、zai-coding-plan、zhipuai-coding-plan。实现时为该集合保留来源说明与样本；名称相似的新 provider 不自动升级为订阅。

不新增分类规则 DSL。用户可将精确 `models.dev/<provider>` 放到链首来提升尚未被分类的产品。此分类不表示当前网关使用订阅凭证，也不将厂商宣称能力当成网关实测能力。

### 5. 模型身份与同层歧义

上游公开 ID 始终保留。根级模型规则先匹配完整公开 ID；仅当公开 ID 的首段精确命中已配置的 channels 键时，将其作为渠道段剥离一次用于渠道模型规则及元数据查询；其余部分（包括厂商子路径）保留。无匹配渠道的条目仍可应用根级模型规则及全局默认；不得将任意首段当成渠道。

查询身份规则优先复用 gateway 的明确映射行为：显式 lookup_ids 为来源提供精确 ID；provider_prefix_map 仅改变元数据查询身份，不改变公开 ID。带厂商命名空间的模型只在明确的厂商/映射范围内查询；裸模型名允许选择器命中的 provider 参与候选查询。匹配精确 ID 优先，唯一的大小写折叠匹配可作为后备；禁止凭型号前缀、版本相近或数组顺序猜测。

每个选择器按站点形成优先级组。在同一站点组内，如果经过身份限制后仍有多个不同 provider 候选，按开发商仲裁：

1. 仅 models.dev 参与仲裁。收集候选记录的 `canonical_model_id`（形如 `<creator>/<model>`）；全部候选必须指向同一个 canonical，缺失该字段的候选视为不一致。
2. 若 `<creator>` provider 本身也在当前候选中，且其记录的 ID 等于 `<model>`（即开发商自托管条目），采用该条目。
3. 否则（canonical 不一致、开发商条目不在当前选择器范围、或站点为 modelparams.dev），整个站点组对该模型视为歧义，不混合字段、不按字母或返回顺序取一个；报告简短诊断后继续下一组。

仲裁只在当前选择器已命中的候选之间进行，不越过用户选择的访问类型范围（例如 `*/subscription` 组不会因开发商条目属于 api_key 而采用它）。用户仍可通过更具体的 token、provider_prefix_map 或 lookup_ids 消歧。实测当前 models.dev 约 906 个跨 provider 同名裸模型中约 393 个可唯一定位开发商条目。

同一来源记录的 API/flat 别名可按明确的完整身份去重，不算不同产品。modelparams.dev 若同 provider/auth/model 出现多个 apiSurface 且不能唯一定位，也按歧义处理，不采用最后写入胜出。

### 6. 双模式合并与缺失状态

```text
upstream catalog --> canonical upstream metadata U
source selectors --> unambiguous external metadata E
                                  |
              overwrite: merge(U, E)
              fill-only: merge(E, U)
                                  |
                    explicit global/channel model overrides
                                  |
                  map to Pi fields + final defaults
                                  |
                         Pi modelOverrides
```

先将上游和各外部记录的别名映射为相同字段，再合并，避免 `context_length` 与 `context_window` 跨来源绕过模式规则。保留来源缺失状态；只有最终 mapModel 才填既有默认值。

merge 采用对象按字段递归、数组整体替换、null 不擦除已有值。补漏中的缺失指未提供、null 或字段校验不通过；不能用一般真假值判断。明确的 `supported_reasoning_levels: []` 表示没有可用档位，不能补出推理能力。0 在正数 token 限额上是无效值，而不是所有字段统一把 0 视为缺失。保持当前未知 effort、none-only 等 fail-closed 映射，不凭 reasoning=true 编造档位。

不允许外部字段覆盖公开 id、provider、baseUrl、api、认证或请求 headers。外部名称/限额/模态/明确 effort 在规范化后进入现有字段映射；本次不扩展 pricing 等其他 Pi 能力。

### 7. 最小模块与生命周期接入

建议使用两个小模块而非可插拔来源框架：
- `model-metadata.ts`：YAML 验证、模型字符串 glob 规则选择、链/模式继承、来源 selector 解析、身份限定及纯合并函数。
- `metadata-sources.ts`：固定公开批量端点读取、来源结构规范化和本次刷新内复用。

models.dev 使用 api.json，并可复用 gateway 已有的 models.json flat 补充规则：同完整身份 API 高于 flat，仅补缺失字段；任一端点可用就继续。modelparams.dev 使用 api/v1/models.json。只拉取实际有效链需要的站点；按整次目录刷新共享读取，不为每个模型单独发请求，不新增持久化缓存体系。

所有外部请求不带上游 Authorization、Cookie 或自定义 headers，不上传模型清单，不从返回数据派生任意请求 URL。使用固定 HTTPS 地址，拒绝跨源重定向。每个响应限制 16 MiB；每个外部请求最多 5 秒，受调用方剩余 deadline/AbortSignal 共同约束。达到外部超时是来源失败；用户取消则中止整个刷新，二者不能混淆。

可用来源失败时继续下一来源；所有外部来源失败时保留本次已验证上游数据，再使用现有最终默认值。若上游目录本身获取失败或结构无效，不用外部记录重建成员清单，交给 Pi 保留已持久化目录。无网络权限或离线启动不读取任何远端目录，继续沿用已有持久化结果，不尝试重新富化。

登录先验证上游连接；富化/配置错误不应把正确 API key 判成无效，也不得用未生效配置发布半成品。启动、登录成功目录、refreshModels、/provider-info 共用解析策略。/provider-info 应区分连接状态与元数据解析失败，不能把后者显示成 key 无效。推理请求路径不再访问元数据网站。

### 8. 验收方法

使用现有 node:test、伪 fetch/loopback 来源和真实 Pi provider lifecycle 测试。主要观察公开模型输出、目录发布次数、网络目的地和离线行为，不断言内部数据结构。规格中的排序、继承、空链、歧义、覆盖模式和失败场景构成验收候选；实施前确认，实施时先证明预期缺失行为，再交付小切片。

## Risks / Trade-offs

- [显式全覆盖可能扩大网关限额] → 默认补漏只填上游缺失或无效字段；需全覆盖时在全局/渠道/模型级显式设 false，并可用人工 overrides 或根级空链退出。
- [新订阅 provider 会暂时归 API] → 这是用户确认的默认政策；用精确 token 调整优先级，后续更新内置集合。
- [宽泛模型 glob 覆盖范围超出预期] → 按完整字符串解释，文档明确 `*gpt*` 也匹配 provider 段；精确优先、同块首条 glob 胜出，不隐式合并多个模式。
- [广泛通配符产生多个同名候选] → models.dev 用 canonical_model_id 唯一定位开发商自托管条目；无法定位时跳过并报告，精确 token 可消歧。稳定性优先于表面命中率。
- [用户直接粘贴 gateway 配置] → 不支持字段忽略并警告，避免整份配置失效，但警告必须列出字段路径，防止误以为生效。
- [公共目录变慢/不可用] → 有界批量请求、调用取消、上游保底、Pi 离线存储；不引入后台刷新服务。
- [现有工作区含其他未提交功能] → 实施只修改目录相关 seam，不重写传输代码或清理现有改动。

## Migration Plan

1. 先以本地夹具验证源选择、身份、模式与 lifecycle，不访问用户生产网关。
2. 更新 README 默认行为、配置样例和不支持的 CPA 字段；打包新增模块及 YAML 依赖，确认安装包可加载。
3. 用户升级后未配置链默认启用富化。若需旧式“只相信上游”，设置根级 `source_priority: []` 且不配置局部链，然后刷新目录。
4. 如需整体回退版本，回退插件并刷新目录以替换已持久化富化结果；只改配置不会追溯改变离线持久化快照。
