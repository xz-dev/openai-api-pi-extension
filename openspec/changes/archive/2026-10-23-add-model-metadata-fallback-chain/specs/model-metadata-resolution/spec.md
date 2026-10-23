## Purpose

为插件的上游模型清单提供可配置的元数据解析能力：通过订阅/API 分类、站点与 provider 通配符排序选择外部来源，并按全局、渠道、模型三级策略执行覆盖或补漏。保持模型成员、公开 ID、认证和推理路由由上游及 Pi 原有机制控制。

## ADDED Requirements

### Requirement: 上游目录控制模型成员

系统 SHALL 接受上游 `/models` 的 Codex `models[]` 或标准 OpenAI `data[]`，保留既有非聊天模型过滤。外部元数据 SHALL NOT 新增上游未列出的模型，也 SHALL NOT 改写公开模型 ID、认证、baseUrl、provider 或 API 路由。缺少合法身份或不合法目录结构 SHALL 使本次目录更新失败，而不是发布部分成员。

#### Scenario: 标准目录也可富化
- **WHEN** 上游返回 `data: [{id: "model-a"}]` 且外部来源为该模型提供有效限额
- **THEN** 插件发布仍使用 ID `model-a` 的模型并采用按配置解析的限额
- **AND** 不要求 CPA 管理接口或管理凭证

#### Scenario: 外部多余模型不成为可调用模型
- **WHEN** 上游只有 `model-a`，外部目录还包含 `model-b`
- **THEN** 发布目录不包含 `model-b`

#### Scenario: 无效成员使刷新保持原子性
- **WHEN** 上游清单包含合法条目和没有合法 ID/slug 的条目
- **THEN** 本次刷新不发布部分清单，并保留此前已验证目录

### Requirement: 内置链与显式配置

系统 SHALL 在根级 `source_priority` 未配置时采用 `["*/subscription", "*/api_key"]`，在根级明确配置列表时整体替换内置链。显式 `[]` SHALL 表示无全局外部来源，而非恢复默认。用户配置 SHALL 从 agent 目录的 `openai-api-extension.yaml` 读取；配置文件缺失等同未配置，配置错误 SHALL 被报告且禁止本次新目录发布。

#### Scenario: 无用户配置即有默认链
- **WHEN** 没有配置文件且允许网络目录刷新
- **THEN** 依次考虑 models.dev 订阅、modelparams.dev 订阅、models.dev API、modelparams.dev API 来源

#### Scenario: 全局显式空链退出默认富化
- **WHEN** 根级 `source_priority: []` 且没有显式局部链
- **THEN** 不访问外部元数据站点，仍根据上游数据及现有最终默认值发布模型

#### Scenario: 无效配置不静默变为默认配置
- **WHEN** 配置包含非法 selector 或非布尔 fill_missing_only
- **THEN** 报告配置路径及原因，不切换到内置默认链，不覆盖已有目录

#### Scenario: gateway 专属字段忽略并警告
- **WHEN** 配置同时包含合法 source_priority 与 `static_models`、`cpa_base_url` 等不支持字段
- **THEN** 警告列出被忽略字段的完整路径，合法 source_priority 照常生效，目录正常更新

### Requirement: 模型规则支持完整 ID 字符串 glob

系统 SHALL 支持根级 `models.<pattern>` 与渠道 `channels.<channel>.models.<pattern>`。根级规则 SHALL 匹配完整公开模型 ID，包含任意 provider/渠道前缀及裸名；渠道规则 SHALL 仅在所属渠道内匹配剥离一次渠道前缀后的剩余 ID。匹配 SHALL 区分大小写并覆盖整个目标字符串，`*` SHALL 匹配零个或多个任意字符（包含 `/`），其余字符 SHALL 按字面处理；连续 `*` SHALL 不产生路径专用语义。

每个 models 块 SHALL 优先选择精确键，无精确键时 SHALL 按配置声明顺序只选择第一条匹配 glob。系统 SHALL NOT 按模式长度重新排序或叠加同块其他匹配规则。重复配置键 SHALL 报错。规则 SHALL 只选择配置，不更改公开 ID，不将 glob 作为外部模型查询身份。

#### Scenario: 后缀 glob 同时覆盖裸名和多级前缀
- **WHEN** 根级规则为 `"*gpt-6-astra"`
- **THEN** `gpt-6-astra`、`openai/gpt-6-astra` 和 `proxy/openai/gpt-6-astra` 均命中
- **AND** `gpt-6-astra-preview` 不命中

#### Scenario: 包含 glob 按完整字符串匹配
- **WHEN** 根级规则为 `"*gpt*"`
- **THEN** `gpt-6-astra`、`vendor/gpt-6-luna` 和 `gpt-proxy/claude` 均命中
- **AND** `vendor/claude` 与 `vendor/GPT-6-astra` 不命中

#### Scenario: 精确键不受配置位置影响
- **WHEN** 根级块先声明 `"*gpt*"`，后声明精确键 `"openai/gpt-6-astra"`
- **THEN** 该完整 ID 选择精确规则，不选择较早的 glob
- **AND** 裸名 `gpt-6-astra` 不因精确键包含同名末段而匹配它

#### Scenario: 多个 glob 首条胜出且不叠加
- **WHEN** 同块依次声明 `"*gpt*"` 和 `"*gpt-6-astra"`，两条都命中且没有精确键
- **THEN** 只采用第一条规则，后者即使更具体也不参与配置合成

#### Scenario: 未设置字段不从同块落选规则继承
- **WHEN** 精确规则仅设置 fill_missing_only，而同块另一个命中的 glob 设置 source_priority
- **THEN** source_priority 从下一作用域继承，不使用落选 glob 的链

#### Scenario: 渠道模型 glob 只在所属渠道生效
- **WHEN** 渠道 proxy 中有模型规则 `"*gpt-6-astra"`
- **THEN** 它匹配 `proxy/vendor/gpt-6-astra` 的渠道内 ID `vendor/gpt-6-astra`
- **AND** 不作用于 `another/gpt-6-astra` 或裸名 `gpt-6-astra`

#### Scenario: 配置匹配不放宽外部身份
- **WHEN** 根级 `"*gpt*"` 同时匹配两个不同实际模型
- **THEN** 每个模型仍用自己的明确查询身份获取元数据，不共享 glob 查询结果或彼此的元数据

### Requirement: 三级来源链继承兼容

系统 SHALL 支持根级、渠道默认及模型规则的来源链，其中模型规则 SHALL 按渠道所选模型规则 > 全局所选模型规则查找显式 source_priority。首个显式模型链 SHALL 整体替换渠道及全局链，包括显式 `[]`；高层未声明时 SHALL 向下一作用域继承。两层模型规则均未声明链时，渠道非空链 SHALL 默认优先于去重追加的全局链；`global_fallback: false` SHALL 禁止追加全局链，渠道显式空链 SHALL 禁止继承全局链。

#### Scenario: 渠道追加且去重全局链
- **WHEN** 全局链为 `[A, B]`，渠道链为 `[B, C]`，global_fallback 未配置
- **THEN** 该渠道未声明模型链的模型按 `[B, C, A]` 解析

#### Scenario: 渠道关闭全局兜底
- **WHEN** 渠道设置 `global_fallback: false` 且未配置渠道链
- **THEN** 该渠道没有显式模型链的模型不使用任何外部来源

#### Scenario: 模型链替换而不是追加
- **WHEN** 全局链为 `[A]`、渠道链为 `[B]`、某模型链为 `[C]`
- **THEN** 该模型只使用 `[C]`

#### Scenario: 全局模型规则覆盖渠道默认且可被渠道模型规则覆盖
- **WHEN** 全局默认链为 `[A]`、渠道默认链为 `[B]`、全局所选模型规则链为 `[C]`
- **THEN** 没有显式渠道模型链时采用 `[C]`，不追加 `[A]` 或 `[B]`
- **AND** 渠道所选模型规则显式链为 `[]` 时，最终链为空

#### Scenario: 局部空链与根级空链作用域不同
- **WHEN** 渠道显式链为 `[]` 且两层所选模型规则均未声明链
- **THEN** 该模型不继承非空全局链
- **AND** 若根级链为空但另一个模型规则显式配置 `[C]`，该模型仍可使用 `[C]`

### Requirement: 用户可排序的来源选择器

系统 SHALL 兼容 `models.dev/<provider>` 和 `modelparams.dev/<provider>/<access>` 精确 token，并支持 `*/subscription`、`*/api_key`、`<site>/<provider-pattern>/<access>` 及 `models.dev/<provider-pattern>`。site SHALL 为支持的站点或 `*`；access SHALL 为 subscription、api_key 或 `*`；provider-pattern SHALL 只允许字面值及 `*`，不提供任意 URL、正则或复杂 glob。用户列表顺序 SHALL 优先于内置站点顺序；同一选择器内 models.dev SHALL 优先于 modelparams.dev。重复且已成功采用的最终来源查询 SHALL 只保留最早位置，空匹配 SHALL 继续后续项；因歧义跳过的候选 SHALL NOT 阻止后续精确选择器再次解析。

#### Scenario: 用户可反转订阅与 API 顺序
- **WHEN** 链为 `["*/api_key", "*/subscription"]` 且同一字段有无歧义 API 值 64000 和订阅值 128000
- **THEN** 外部解析值为 64000，不被内置订阅优先顺序再次改写

#### Scenario: 用户可反转站点顺序
- **WHEN** 链为 `["modelparams.dev/*/subscription", "models.dev/*/subscription"]` 且两站有无歧义冲突值
- **THEN** modelparams.dev 的值优先

#### Scenario: 默认订阅优先跨越站点
- **WHEN** 默认链下 models.dev 仅有 API 值 64000，modelparams.dev 有订阅值 128000
- **THEN** 外部解析值为 128000

#### Scenario: 同选择器内站点排序且继续补字段
- **WHEN** 两站都有无歧义订阅记录，models.dev 提供 context_window，modelparams.dev 提供不同 context_window 和额外 max_output_tokens
- **THEN** context_window 使用 models.dev 值，max_output_tokens 使用 modelparams.dev 值

#### Scenario: 精确来源与通配符重复
- **WHEN** 先列精确 models.dev 来源，后列包含同一查询的通配符
- **THEN** 同一来源不获得第二次排序或覆盖机会，结果不依赖目录枚举顺序

### Requirement: 访问类型分类政策

系统 SHALL 使用 modelparams.dev 的 authType 分类；未知 authType SHALL NOT 匹配 subscription/api_key 选择器。models.dev 的已登记订阅 provider SHALL 匹配 subscription，其余 provider SHALL 匹配 api_key。此分类 SHALL 仅用于元数据排序，不宣称网关实际认证方式或实测能力。未限定访问类型的精确 models.dev token SHALL 不受分类阻挡。

#### Scenario: 新 models.dev provider 进入 API 组
- **WHEN** models.dev 出现尚未登记的 provider `new-provider`
- **THEN** 它匹配 `*/api_key`，不匹配 `*/subscription`

#### Scenario: 已知订阅来源与普通来源区分
- **WHEN** models.dev 同时有 zai-coding-plan 和 zai
- **THEN** 前者进入 subscription 组，后者进入 api_key 组

#### Scenario: 精确 token 可提升尚未分类的产品
- **WHEN** 链先列 `models.dev/new-provider`，再列 `*/subscription`
- **THEN** new-provider 的无歧义字段仍优先，即使其默认分类是 API

### Requirement: 来源选择不能伪造模型身份

系统 SHALL 保持公开 ID 不变，仅剥离一次精确匹配已配置 channels 键的渠道前缀用于配置查找。系统 SHALL 支持 provider_prefix_map 与精确 lookup_ids 进行元数据查询映射，且不得通过模糊型号匹配扩展身份。匹配 SHALL 精确优先，大小写折叠仅在唯一匹配时可用。同一 selector 的同一站点组若存在多个不同 provider 候选，系统 SHALL 优先采用模型开发商自托管条目：仅当全部候选在 models.dev 中声明同一 `canonical_model_id`（`<creator>/<model>`）且 provider `<creator>` 的 ID 为 `<model>` 的记录也在当前候选中时，采用该记录。无法唯一确定时，系统 SHALL 跳过该组、报告歧义并继续下一组，不按接口返回顺序、字母排序或混合字段裁决。开发商仲裁 SHALL NOT 越过当前选择器的访问类型范围。

#### Scenario: 厂商子路径不是第二个渠道前缀
- **WHEN** 已配置渠道 proxy，上游 ID 为 `proxy/vendor/model-a`
- **THEN** 渠道模型键为 `vendor/model-a`，公开 ID 仍为 `proxy/vendor/model-a`

#### Scenario: 同名多 provider 时采用开发商自托管条目
- **WHEN** `*/api_key` 组对裸名 `gpt-5` 命中 openai、openrouter、helicone，且三者 canonical_model_id 均为 `openai/gpt-5`
- **THEN** 采用 openai provider 的 `gpt-5` 记录，交换返回顺序不改变结果

#### Scenario: 无法定位开发商时不随机选取
- **WHEN** models.dev 的通配符组对某裸模型名命中两个 provider，且 canonical 不一致或开发商条目不在候选中，下一站点组有一个无歧义候选
- **THEN** 跳过 models.dev 组并采用下一组，交换 models.dev 返回顺序不改变结果

#### Scenario: 开发商仲裁不越过访问类型
- **WHEN** `*/subscription` 组只命中两个订阅 provider，开发商条目属于 api_key 组
- **THEN** 订阅组视为歧义跳过，不在订阅组中采用开发商 api_key 条目

#### Scenario: 精确 token 消除宽泛通配符歧义
- **WHEN** 一个宽泛选择器因同名多 provider 歧义被跳过，后续链显式指定其中一个 provider 且该来源 ID 唯一
- **THEN** 后续精确选择器仍可采用该来源，不把其他 provider 的同名记录混入

### Requirement: 三级合并模式与显式人工覆盖

系统 SHALL 支持布尔 `fill_missing_only`，按渠道所选模型规则 > 全局所选模型规则 > 渠道默认 > 全局默认继承，未配置默认 true。false SHALL 允许外部来源覆盖上游同字段，true SHALL 只填缺失或字段校验不通过的值。别名 SHALL 在合并前统一，最终默认值 SHALL 在富化后补入。对象 SHALL 按字段递归合并，数组 SHALL 作为完整值；null SHALL 不清除下层。明确的空 effort 数组 SHALL NOT 被视为缺失。人工覆盖 SHALL 按全局所选模型 overrides < 渠道旧式精确 overrides < 渠道所选模型 overrides 叠加；Pi modelOverrides SHALL 最终生效。模型规则 lookup_ids SHALL 按精确来源键继承并以渠道模型同键优先，其键和值 SHALL NOT 进行 glob 捕获替换。

#### Scenario: 默认补漏保留上游值
- **WHEN** 上游 context_window 为 500000，外部无歧义解析值为 1000000，模式未配置
- **THEN** 插件元数据 contextWindow 为 500000
- **AND** 上游未提供 max_output_tokens 时，外部的 128000 被补入 maxTokens

#### Scenario: 显式 false 允许外部覆盖
- **WHEN** 根级 fill_missing_only 为 false，上游 context_window 为 128000，外部无歧义解析值为 1000000
- **THEN** 插件元数据 contextWindow 为 1000000

#### Scenario: 渠道补漏且模型可恢复覆盖
- **WHEN** 全局为 false、渠道为 true、一个模型显式 false，上游与外部限额冲突
- **THEN** 该模型采用外部值，渠道内未覆盖模式的其他模型保留上游值

#### Scenario: 全局模型模式高于渠道默认
- **WHEN** 渠道默认 fill_missing_only 为 false，根级所选 `"*gpt*"` 模型规则设置 true，渠道所选模型规则未设置该字段
- **THEN** 该模型采用补漏模式
- **AND** 渠道所选模型规则显式设为 false 后，该模型恢复全覆盖

#### Scenario: 别名不得绕过补漏
- **WHEN** 补漏模式中上游 context_length 为 128000，外部 context_window 为 1000000
- **THEN** 最终 contextWindow 保留 128000

#### Scenario: 默认值不得掩盖真实缺失
- **WHEN** 上游没有 context 字段，补漏模式中外部提供 64000
- **THEN** 最终 contextWindow 为 64000，不因插件默认值提前填入而保留 128000

#### Scenario: 明确禁用推理不能被补出档位
- **WHEN** 补漏模式中上游 supported_reasoning_levels 为 `[]`，外部提供 low/high
- **THEN** 空数组保留，不新增推理档位

#### Scenario: 人工覆盖高于模式与来源
- **WHEN** 补漏模式保留上游 128000，模型 overrides 设置 context_window 为 64000
- **THEN** 插件发布 64000
- **AND** Pi modelOverrides 若再设置 contextWindow 为 32000，最终用户模型为 32000

### Requirement: 生命周期与失败隔离

启动预取、登录成功后的目录、provider 刷新与连接信息展示 SHALL 使用一致的元数据规则。外部来源失败 SHALL 继续后续可用来源；全部外部来源失败 SHALL 保留已验证上游数据及最终默认值。上游目录失败 SHALL 保留先前持久化目录，不能用外部目录替代成员集合。取消 SHALL 中止发布；离线或不允许网络时 SHALL 不访问上游及外部站点。推理请求 SHALL 不触发元数据网络请求。元数据/配置失败 SHALL NOT 被报告为有效凭证失效。

#### Scenario: 全部外部来源失败仍可使用上游目录
- **WHEN** 上游目录有效而所有外部来源超时或返回无效结构
- **THEN** 可发布上游映射结果，并报告富化降级而非认证失败

#### Scenario: 离线恢复不重新查询来源
- **WHEN** 启动为离线模式且已有持久化目录
- **THEN** 恢复目录，不发任何元数据网络请求

#### Scenario: 取消不发布半成品
- **WHEN** 上游读取完成、外部富化尚未完成时用户取消
- **THEN** 不发布本次部分结果，不覆盖原有持久化目录

#### Scenario: 连接信息区分认证与配置错误
- **WHEN** 上游认证成功但 YAML 配置无效
- **THEN** 登录仍可保存已验证凭证，目录不更新，连接信息明确显示元数据配置错误而非 API key 无效

### Requirement: 外部来源请求保护

外部富化 SHALL 只读取固定公开批量目录，不向来源发送上游凭证、对话或用户模型清单。每次刷新 SHALL 在模型间共享来源读取，不按模型逐次请求；关闭全部有效链时 SHALL 不请求外部站点。外部响应 SHALL 有大小上限、超时和取消保护，且 SHALL 拒绝跨源重定向。

#### Scenario: 外部站点收不到网关凭证
- **WHEN** 上游请求使用 Authorization 和自定义认证 headers
- **THEN** models.dev/modelparams.dev 请求不含这些 headers、Cookie 或凭证参数

#### Scenario: 多模型刷新仍使用批量读取
- **WHEN** 多个模型的有效链依赖同一个来源端点
- **THEN** 本次刷新只读取该端点一次，不为每个模型重复读取

#### Scenario: 超大或越界来源响应按来源失败处理
- **WHEN** 外部响应超过 16 MiB、请求超过 5 秒或要求跨源重定向
- **THEN** 停止该来源读取并继续允许的回退，不无限占用刷新资源
