# model-metadata-resolution Specification

## Purpose
为插件的上游模型清单提供可配置的元数据解析能力：通过订阅/API 分类、站点与 provider 通配符排序选择外部来源，并按全局、渠道、模型三级策略执行覆盖或补漏。保持模型成员、公开 ID、认证和推理路由由上游及 Pi 原有机制控制。

## Requirements

### Requirement: 上游目录控制模型成员

系统 SHALL 接受上游 `/models` 的 Codex `models[]` 或标准 OpenAI `data[]`，保留既有非聊天模型过滤。外部元数据 SHALL NOT 新增上游未列出的模型，也 SHALL NOT 改写公开模型 ID、认证、baseUrl、provider 或 API 路由。显示名 SHALL 与其他字段一样按来源链选择：归一化字段 `name`（别名 `name`/`display_name`）SHALL 取生效链顺序中第一个有效值；`@self` 等记录来源 SHALL 在其位置提供网关/上游显示名，外部条目 SHALL 提供其记录名称。链中没有任何条目提供有效名称时，显示名 SHALL 回退为公开模型 ID。用户显式 overrides 与 Pi modelOverrides SHALL 在链选择之后生效。内部查询 ID 与 canonical ID SHALL NOT 替换公开 ID。缺少合法身份或不合法目录结构 SHALL 使本次目录更新失败，而不是发布部分成员。

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

#### Scenario: regex 查询不重命名公开模型
- **WHEN** 上游 ID 为 `proxy/Claude Fable 5.1`、显示名为 `My Fable`，内部匹配到 `claude-fable-5-1`，外部记录名称为 `Claude Fable 5.1`，且使用默认链
- **THEN** 发布 ID 和发送请求的型号仍为 `proxy/Claude Fable 5.1`，显示名为链选出的 `Claude Fable 5.1`
- **AND** 不新增公开模型 `claude-fable-5-1`

#### Scenario: 显式显示名覆盖仍生效
- **WHEN** 链为任一模型选出显示名，用户 overrides 设置 name 为 `Work Model`
- **THEN** 发布显示名为 `Work Model`；Pi modelOverrides 仍可最终覆盖该值

#### Scenario: 外部来源在前时采用来源名称
- **WHEN** 生效链为 `["models.dev/@creator/api_key", "@self"]`，外部记录名称为 `GPT-6.1 Sol`，网关显示名为 `gpt-6.1-sol`
- **THEN** 发布显示名为 `GPT-6.1 Sol`，公开 ID 不变

#### Scenario: @self 在前时保留网关显示名
- **WHEN** 生效链为 `["@self", "models.dev/@creator/api_key"]` 或 `["@self"]`，网关显示名为 `My Fable`
- **THEN** 发布显示名为 `My Fable`

#### Scenario: 严格链无名称时回退为 ID
- **WHEN** 生效链不含 `@self`，且链中没有任何条目为模型 `caselab-m` 提供名称，网关行的显示名为 `Gateway Name`
- **THEN** 发布显示名为公开 ID `caselab-m`，不读取网关行的显示名

### Requirement: 内置链与显式配置

系统 SHALL 在根级 `chain` 未配置时采用内置默认链 `["models.dev/@creator/api_key", "modelparams.dev/@creator/api_key", "@self"]`，默认链 SHALL NOT 包含 subscription 来源。根级明确配置非空列表时 SHALL 整体替换内置链。根级或任何模型规则显式配置 `chain: []` SHALL 作为配置错误报告，指出完整路径并提示仅采用上游时使用 `["@self"]`；空链 SHALL NOT 表示禁用外部来源、恢复默认或无来源发布。省略根级链 SHALL 使用默认链，模型规则省略链 SHALL 保留此前生效链。

用户配置 SHALL 从 agent 目录的 `openai-api-extension.yaml` 读取；配置文件缺失等同未配置。非法 YAML、重复键、已知字段的非法值及旧版字段 SHALL 作为配置错误报告，并禁止本次新目录发布、保留此前已验证目录。不属于本插件且不属于旧版字段的未知字段 SHALL 被忽略，并在一条警告中列出完整路径。

#### Scenario: 无用户配置即有默认链
- **WHEN** 没有配置文件且上游目录刷新成功
- **THEN** 每个模型依次考虑 models.dev 原厂 API、modelparams.dev 原厂 API、当前模型上游能力数据
- **AND** 不考虑 subscription 来源，外部未提供的字段仍可使用上游有效值

#### Scenario: 全局显式空链退出默认富化
- **WHEN** 用户沿用旧版 `chain: []` 写法尝试退出默认外部富化
- **THEN** 报告 `chain` 配置错误并提示使用 `["@self"]`，不发布新目录，保留此前已验证目录

#### Scenario: 模型规则显式空链报错
- **WHEN** 任一模型规则配置 `chain: []`
- **THEN** 报告对应 `models[index].chain` 路径及迁移提示，不因规则是否命中而忽略错误

#### Scenario: 仅采用上游显式写入来源
- **WHEN** 根级链为 `["@self"]` 且无规则替换链
- **THEN** 每个模型只采用自身上游能力数据及既有最终默认值，不加载外部元数据

#### Scenario: 无效配置不静默变为默认配置
- **WHEN** 配置包含非法链条目、空链或旧版 `fill_missing_only`
- **THEN** 报告配置路径及原因，不切换到内置默认链，不覆盖已有目录

#### Scenario: gateway 专属字段忽略并警告
- **WHEN** 配置同时包含合法 `chain` 与 `static_models`、`cpa_base_url` 等不支持字段
- **THEN** 警告列出被忽略字段的完整路径，合法 `chain` 照常生效，目录正常更新

### Requirement: 有序模型规则层叠

系统 SHALL 支持根级 `models` 为有序规则列表，每条规则以 `match` 声明匹配模式。`match` SHALL 匹配完整公开模型 ID，包含任意前缀及裸名。`match` SHALL 使用标准 glob 语义并覆盖整个目标字符串：
- 模式区分大小写。
- `*` 匹配单个 `/` 分隔段内零个或多个字符，SHALL NOT 跨越 `/`；`?` 匹配段内单个字符。
- `**` 作为完整段时匹配零个或多个路径段。
- 支持字符类 `[...]` 与花括号展开 `{a,b}`。
- 以 `.` 开头的段可被通配符匹配。
- 模式开头的 `!` 与 `#` SHALL 按字面字符处理，SHALL NOT 表示取反或注释。

`match` 与 `include_models` SHALL 使用同一匹配语义。

一个模型 SHALL 按列表声明顺序应用所有命中规则，逐字段叠加：后命中规则声明的非空 `chain` SHALL 整体替换此前链，未声明链的规则 SHALL 保留此前链；`overrides` SHALL 按规则顺序逐层合并。系统 SHALL NOT 按模式长度或精确程度重新排序，也 SHALL NOT 另行继承合并模式开关。规则 SHALL 只选择配置，不更改公开 ID，不将 `match` 模式作为外部查询身份。

#### Scenario: 单星号不跨越前缀
- **WHEN** 规则 `match: "*gpt-6-astra"`
- **THEN** `gpt-6-astra` 命中
- **AND** `openai/gpt-6-astra`、`proxy/openai/gpt-6-astra` 与 `gpt-6-astra-preview` 均不命中

#### Scenario: 后缀 glob 同时覆盖裸名和多级前缀
- **WHEN** 规则 `match: "**/gpt-6-astra"`
- **THEN** `gpt-6-astra`、`openai/gpt-6-astra` 和 `proxy/openai/gpt-6-astra` 均命中
- **AND** `gpt-6-astra-preview` 不命中

#### Scenario: 单段前缀模式只命中一级
- **WHEN** 规则分别为 `match: "proxy/*"` 与 `match: "proxy/**"`，模型 ID 为 `proxy/a/b`
- **THEN** 前者不命中，后者命中

#### Scenario: 匹配区分大小写且感叹号为字面字符
- **WHEN** 规则 `match: "p*"`，模型为 `Proxy`；另一规则 `match: "!x"`，模型为 `!x` 与 `y`
- **THEN** `Proxy` 不命中 `p*`；`!x` 命中 `!x`，`y` 不命中

#### Scenario: 后命中的规则覆盖先命中的同字段
- **WHEN** 列表依次为 `match: "**"` 设置外部来源加 `@self`，`match: "proxy/**"` 设置 `["@self"]`
- **THEN** `proxy/claude` 仅采用上游，其余模型仍按此前的外部来源加上游顺序取值

#### Scenario: 多条命中规则逐字段叠加
- **WHEN** `match: "proxy/*"` 设置 `overrides: {contextWindow: 200000}`，其后 `match: "proxy/claude"` 设置 `chain`
- **THEN** `proxy/claude` 同时使用后者的链与前者的 `contextWindow` 覆盖

#### Scenario: 精确模式不因声明位置获得额外优先级
- **WHEN** 列表先声明 `match: "proxy/claude"` 设置 `["@self"]`，后声明 `match: "**"` 设置外部来源链
- **THEN** `proxy/claude` 使用后声明的外部来源链，不因较早规则精确匹配而保留上游来源

#### Scenario: 配置匹配不放宽外部身份
- **WHEN** `match: "**/*gpt*"` 同时匹配两个不同实际模型
- **THEN** 每个模型仍用自己的查询身份获取元数据，不共享查询结果或彼此的上游数据

### Requirement: 合并模式与 Pi 模型覆盖

系统 SHALL 仅按生效来源链选择能力字段，不再接受独立 `fill_missing_only` 开关。完成 `@default` 展开后，每个字段 SHALL 采用链中首个有效值；`@self` SHALL 在其所在位置提供当前模型的上游能力字段，字段别名 SHALL 在选择前统一。无效值与缺失值 SHALL 继续后续来源；明确的空 effort 数组 SHALL NOT 被视为缺失。

没有 `@self` 的链 SHALL 仅采用所声明外部来源的能力数据，SHALL NOT 因字段缺失、来源未命中或站点降级而隐式读取上游能力字段，包括嵌套的 `capabilities.effort_tiers`。最终默认值 SHALL 在所有声明来源完成选择后补入。此规则 SHALL NOT 改变上游控制的模型成员、公开 ID、网关显示名、认证、baseUrl、provider 或 API 路由。

人工 `overrides` SHALL 作用于来源选择与默认值补入后的最终 Pi 模型对象，使用 Pi 模型字段名（如 `contextWindow`、`maxTokens`、`thinkingLevelMap`、`compat`），并按 RFC 7396 JSON Merge Patch 语义合并：对象递归合并，数组与标量整体替换，`null` 删除该字段。多条命中规则的 `overrides` SHALL 按规则顺序依次应用。`overrides` SHALL NOT 修改 `id`、`provider`、`api`、`baseUrl`；包含这些字段 SHALL 作为配置错误。Pi `modelOverrides` SHALL 在插件 overrides 之后最终生效。

#### Scenario: 默认外部覆盖上游
- **WHEN** 上游 context 为 500000、输出上限为 64000，外部仅提供 context 1000000，链为外部来源加 `@self`
- **THEN** 发布模型 contextWindow 为 1000000，maxTokens 为上游的 64000

#### Scenario: 显式 true 只补缺失
- **WHEN** 用户将旧版 `fill_missing_only: true` 的补缺意图迁移为 `@self` 加外部来源，上游 context 为 128000，外部提供 context 1000000 与输出上限 64000
- **THEN** 发布模型 contextWindow 为 128000，maxTokens 为 64000

#### Scenario: 无上游来源时严格替换
- **WHEN** 上游 context 为 500000、输出上限为 64000，链只声明外部来源且该来源仅提供 context 1000000
- **THEN** 发布模型 contextWindow 为 1000000，输出上限采用既有最终回退规则，而不是上游的 64000

#### Scenario: 嵌套能力不得绕过严格替换
- **WHEN** 无 `@self`，外部没有推理档位，上游 `capabilities.effort_tiers` 为 low/high
- **THEN** 最终模型不因该嵌套上游字段而启用推理或新增档位

#### Scenario: 别名不得绕过补漏
- **WHEN** `@self` 在前，上游 context_length 为 128000，外部 context_window 为 1000000
- **THEN** 最终 contextWindow 为 128000

#### Scenario: 默认值不得掩盖真实缺失
- **WHEN** `@self` 在前但上游没有 context 字段，后续外部来源提供 64000
- **THEN** 最终 contextWindow 为 64000，而不是提前补入的插件默认值

#### Scenario: 明确禁用推理不能被补出档位
- **WHEN** `@self` 在前，上游 supported_reasoning_levels 为 `[]`，外部提供 low/high
- **THEN** 空数组保留，不新增推理档位

#### Scenario: 嵌套覆盖只改指定档位
- **WHEN** 发布前模型 thinkingLevelMap 含 high 与 xhigh，规则 `overrides: {thinkingLevelMap: {xhigh: null, max: "xhigh"}}`
- **THEN** 发布模型 thinkingLevelMap 不含 xhigh，max 映射为 "xhigh"，high 保持不变

#### Scenario: 多层覆盖按顺序合并
- **WHEN** 先命中规则设置 `overrides: {contextWindow: 200000, compat: {a: 1}}`，后命中规则设置 `overrides: {compat: {b: 2}}`
- **THEN** 发布模型 contextWindow 为 200000，compat 同时含 a 与 b

#### Scenario: 身份字段不可覆盖
- **WHEN** 规则 `overrides` 包含 `baseUrl`
- **THEN** 报告配置错误，不覆盖已有目录

#### Scenario: Pi modelOverrides 最终生效
- **WHEN** 插件 overrides 设置 contextWindow 为 64000，Pi modelOverrides 设置 contextWindow 为 32000
- **THEN** 最终用户模型为 32000

### Requirement: 本地富化生命周期与降级

登录成功后的目录、provider 刷新、连接信息展示与编译结果查看 SHALL 使用一致的元数据规则。插件加载阶段 SHALL NOT 发起网络请求或元数据编译：目录恢复由 Pi 持久化存储离线完成，交互会话的目录刷新由 Pi 在界面就绪后后台发起；命令行首次发现 SHALL 通过显式刷新（`pi --refresh --list-models`）完成。外部元数据 SHALL 只在上游目录读取成功后参与编译，推理请求 SHALL 不触发元数据加载。

某一外部数据包不可加载或结构无法识别时，依赖该站点的条目 SHALL 降级跳过并报告提示，其余声明来源继续生效；仅当生效链包含 `@self` 时才能采用上游能力值，否则 SHALL 使用后续外部来源及最终默认值。提示 SHALL NOT 在无 `@self` 时声称已回退上游。生效链只有 `@self` 时 SHALL NOT 读取外部元数据包，不应因外部包缺失产生降级提示。上游目录失败 SHALL 保留先前持久化目录，不能用外部数据替代成员集合。取消 SHALL 中止发布。元数据或配置失败 SHALL NOT 被报告为凭证失效。

#### Scenario: 外部数据包不可用仍可使用上游目录
- **WHEN** 上游目录有效而 modelparams 包缺失或结构无法识别
- **THEN** 该站点条目被跳过，其他声明来源继续生效，并报告该站点降级而非认证失败
- **AND** 只有链中包含 `@self` 时才采用上游能力数据

#### Scenario: 仅上游不读取外部数据
- **WHEN** 所有模型的生效链为 `["@self"]`，两个外部数据包均未安装
- **THEN** 按上游能力与最终默认值发布，不读取外部数据包，不报告外部来源降级

#### Scenario: 离线恢复不重新编译
- **WHEN** 启动为离线模式且已有持久化目录
- **THEN** 恢复持久化目录，不读取配置或外部数据

#### Scenario: 取消不发布半成品
- **WHEN** 上游读取完成、元数据编译尚未完成时用户取消
- **THEN** 不发布本次部分结果，不覆盖原有持久化目录

#### Scenario: 连接信息区分认证与配置错误
- **WHEN** 上游认证成功但 YAML 配置无效
- **THEN** 登录仍可保存已验证凭证，目录不更新，连接信息明确显示元数据配置错误而非 API key 无效

### Requirement: 链条目语法与编译结果

系统 SHALL 接受以下三种链条目：
- `<site>/<provider>/<access>[/<model_id>]`。
- 整条 `@default`。
- 整条记录来源关键词，即当前宿主已注册的 `@<name>`（Pi 插件注册 `@self`）。

外部条目各段：
- site 为 models.dev/modelparams.dev。
- provider 为字面 ID 或 `@creator`。
- access 为 subscription/api_key。
- 省略第 4 段等同内部 `@id` 查询；写出时为可包含 `/` 的字面 ID。

配置链任何段 SHALL NOT 接受 `*` 或 regex。记录来源关键词 SHALL 仅在完整链条目精确等于已注册关键词时生效，SHALL NOT 被当作站点查询。以 `@` 开头、既不是 `@default` 也未在当前宿主注册的完整条目 SHALL 作为配置错误，错误指出条目路径并列出当前宿主可用的记录来源关键词。`@default` SHALL 原地插入根级生效链（包含其中的记录来源关键词），且 SHALL NOT 用于根级链；模型规则的 chain SHALL 替换此前链。

编译结果 SHALL 保留所有外部查询候选的字面身份、canonical、匹配优先级及选用／跳过原因。完成身份和来源筛选后，所有可用外部命中 SHALL 具体化为固定条目；相同来源记录别名 SHALL 去重，SHALL NOT 因为首个命中而丢失其余候选。最终执行链 SHALL 只包含以下节点，并保持相对顺序：
- 固定外部字面身份及已选字段。
- 已绑定关键词与具体原始公开模型 ID 的记录来源节点。

最终执行链 SHALL NOT 留有待执行 regex、通配符或待解释的记录来源关键词、`@default` 等查询关键词。记录来源 SHALL NOT 冒充任一外部站点、provider 或 canonical 记录。相同配置、记录来源输入与相同数据版本 SHALL 产生相同结果，来源枚举顺序 SHALL NOT 改变结果。

字段选择 SHALL 保持用户链顺序、厂商别名组顺序与匹配层级优先级，每个字段采用最高优先级的有效值。同来源同层级、同 canonical 的别名记录若能力字段冲突，系统 SHALL 保留候选与冲突原因，跳过该冲突记录组并继续后续来源，而不是按字母顺序选值。models.dev 的 access 仍为声明标签；modelparams.dev SHALL 按 `authType === access` 过滤。每个采用的字段 SHALL 能追溯到以下之一：具体上游模型或记录来源、provider 记录、统一 canonical 资料。

#### Scenario: 聚合 provider 变体不影响原厂条目
- **WHEN** 公开 ID 为 `gw/claude-fable-5-1`，原厂 anthropic 有该模型，聚合 provider 有多个同名命名空间变体
- **THEN** 编译链采用 `models.dev/anthropic/api_key/claude-fable-5-1` 的限额
- **AND** 聚合记录可提供 canonical 身份线索，但其限额不进入该模型的字段合并

#### Scenario: 通配符条目被拒绝
- **WHEN** 链包含 `"*/api_key"` 或 `"models.dev/*/api_key"`
- **THEN** 报告配置错误并指出条目路径

#### Scenario: 未注册的记录来源关键词被拒绝
- **WHEN** Pi 插件配置的链包含 `"@cpa-upstream"` 或 `"@selfie"`
- **THEN** 报告配置错误，指出条目路径并列出可用关键词 `@self`，不发布新目录

#### Scenario: 字面第 4 段指定查询 ID
- **WHEN** 规则 `match: "claude"` 设置 `chain: ["models.dev/anthropic/api_key/claude-sonnet-4-5"]`
- **THEN** 该条目只精确查询指定来源 ID，公开 ID 仍为 `claude`

#### Scenario: @default 原地插入根链
- **WHEN** 根链为外部来源 A、B、`@self`，命中规则的链为订阅条目加 `@default`
- **THEN** 编译后顺序为订阅来源、A、B、该模型的具体上游来源
- **AND** canonical 通用资料不越过订阅来源的限制

#### Scenario: 上游来源具体化且不串模型
- **WHEN** 同一规则的 `@self` 应用于两个不同公开模型
- **THEN** 每个模型的固定链包含各自的具体上游来源，不共享上游字段或留下待解释的 `@self` 关键词

#### Scenario: 字段按条目顺序首个有效值
- **WHEN** 第一条目提供 context_window，第二条目提供不同 context_window 与 supported_reasoning_levels
- **THEN** context_window 使用第一条目，supported_reasoning_levels 使用第二条目

#### Scenario: 多个 regex 命中不按来源返回顺序选一个
- **WHEN** 同一来源有两个 regex 命中的等价别名，交换两条记录的枚举顺序
- **THEN** 两次编译保留相同候选、相同固定链和相同字段来源

#### Scenario: 同级别名能力冲突继续后续来源
- **WHEN** 同一 provider 下两个同级别名指向同一 canonical，但输出上限不同，后续声明来源有可用记录
- **THEN** 冲突别名组不提供字段，候选及原因保留；后续声明来源仍可提供字段

### Requirement: 原厂判定与厂商别名组

`@creator` SHALL 解析并保留完整 canonical 身份 `<creator>/<canonical-model>`，而不只保留厂家前缀。在最高有效匹配层级，直接匹配的统一 canonical 模型资料 SHALL 优先于 provider 提供的别名声明；没有直接 canonical 资料时，系统 SHALL 收集匹配来源记录声明的 `canonical_model_id`。属于同一内置厂商别名组的厂家 SHALL 视为同一原厂，初始组继续为 `[zhipuai, zai, z-ai]`、`[moonshotai, moonshot]`、`[thinkingmachines, thinking-machines]`。转售或托管平台 SHALL NOT 与原厂列入同组。

身份确定后，系统 SHALL 使用 canonical 型号及站点原始 ID 定位对应资料，不能只替换 provider 后继续用无法命中的旧别名。原厂展开 SHALL 按组内顺序执行，数据查询 SHALL 使用各站点实际存在的身份。不属于别名组的厂家 SHALL 只展开为自身。

找不到原厂时，对应条目 SHALL 标记 unresolved 并继续其他来源。同一有效层级存在不同原厂且生效链使用 `@creator` 时，系统 SHALL 报配置错误，指出冲突并禁止本次目录发布。原厂相同但存在多个不能裁定的不同 canonical 型号时，系统 SHALL 保留全部候选及歧义原因，只跳过无法裁定的条目并继续其他来源，不按枚举顺序或字母顺序猜一个型号。显式 provider/型号规则 SHALL 继续提供消歧途径。

#### Scenario: 别名组展开到各站点存在的成员
- **WHEN** `glm-5.1` 的 canonical 原厂为 zhipuai，models.dev 存在 provider zhipuai 与 zai，modelparams.dev 存在 provider z-ai
- **THEN** 默认链可编译为 `models.dev/zhipuai/api_key/glm-5.1`、`models.dev/zai/api_key/glm-5.1`、`modelparams.dev/z-ai/api_key/glm-5.1`，只保留实际可用记录

#### Scenario: 同组原厂不算冲突
- **WHEN** 同一查询 ID 的 canonical 原厂分别为 zhipuai 与 zai，且指向同一型号
- **THEN** 原厂解析成功，不报告冲突

#### Scenario: 找不到原厂时跳过
- **WHEN** 查询 ID 没有统一 canonical 资料，也没有任何带 canonical 的来源记录
- **THEN** `@creator` 条目标记 unresolved 并跳过，目录正常发布

#### Scenario: 原厂冲突阻止发布
- **WHEN** 同一有效层级的候选分别指向不同组的 vendor-a 与 vendor-b，且该模型生效链含 `@creator`
- **THEN** 报告配置错误，列出模型 ID 与两个原厂，保留此前已验证目录

#### Scenario: 显式 provider 可消除冲突
- **WHEN** 上一场景中用户为该模型添加 `chain: ["models.dev/vendor-a/api_key"]` 且该表有唯一可用型号
- **THEN** 不再报原厂冲突，模型按该具体来源解析

#### Scenario: 使用 canonical 型号而非旧别名
- **WHEN** 来源 ID `deepseek-v4-flash-fast` 明确指向 `deepseek/deepseek-v4-flash`，原厂只有后者的记录
- **THEN** 自动链使用 `deepseek-v4-flash` 的原厂资料，公开 ID 仍保持原样

#### Scenario: 同原厂不同型号不能随意合并
- **WHEN** `gemini-3-1-pro` 的同级候选分别指向 preview 与 preview-customtools，且没有更强的直接 canonical 命中
- **THEN** 保留两个候选并报告该条目身份歧义，不混合两个型号的字段

### Requirement: 查询 ID 归一化

`@id` SHALL 只取公开模型 ID 最后一个 `/` 后的部分作为查询输入。归一化 SHALL 是编译期内部查询展开，不是公开模型重命名：系统 SHALL 先保留字面精确命中，再生成整串匹配、大小写不敏感的内部 regex。查询中的每个空白、下划线、点号、横线 SHALL 独立匹配零个或一个这四类分隔符，即一换零或一换一；连续 n 个分隔符 SHALL 最多匹配 n 个来源分隔符，SHALL NOT 将一个分隔符扩展为两个或更多，SHALL NOT 在查询原本没有分隔符的位置插入分隔符。此规则 SHALL 同样适用于内部、开头和结尾位置，空白范围 SHALL 保持既有 `\s` 语义。空查询及仅由分隔符组成的查询 SHALL NOT 产生泛化 regex 候选。

输入其余字符 SHALL 转义为字面值，SHALL NOT 被解释为用户提供的 regex。既有去除末尾日期后缀的查询回退 SHALL 作为更低优先级的独立查询保留，SHALL NOT 把版本号或日期泛化成任意数字。大小写不敏感 SHALL 仅用于内部搜索匹配；公开模型 ID、完整来源 ID、来源 key、最终编译链条目的 ID SHALL 保留各自原始拼写，SHALL NOT 被转成小写或替换为用于搜索的变体。

查询 SHALL 收集所有匹配的来源原始 ID，包含来源 key/id 别名及带命名空间记录的末段匹配；每个命中 SHALL 保留完整原始来源 ID 与来源身份。系统 SHALL NOT 在发现首个匹配后停止。候选集合 SHALL 在来源枚举顺序变化时保持确定；字面命中优先于 regex 命中，regex 命中优先于去日期后缀回退。新增的可选分隔符匹配 SHALL 沿用既有 canonical 身份歧义处理，SHALL NOT 为获得结果而随意合并不同型号。归一化规则 SHALL NOT 由用户配置。用户显式给出的链条目第 4 段 SHALL 保持区分大小写的字面精确查询，不参与 regex 或日期回退；用户规则的 glob 匹配 SHALL 不受本规则变更影响。

未命中的查询 SHALL 按生效来源链继续取值；仅当链含 `@self` 时才回退当前模型的上游能力数据，否则只使用其他声明来源及最终默认值。

#### Scenario: 点号写法命中横线记录
- **WHEN** 公开 ID 为 `proxy/claude-sonnet-4.5`，anthropic 表只有 `claude-sonnet-4-5`
- **THEN** 编译条目为 `models.dev/anthropic/api_key/claude-sonnet-4-5`

#### Scenario: 原样命中优先于归一化
- **WHEN** 来源表同时有 `Model-X`、`model_x` 与 `modelx`，公开 ID 末段为 `Model-X`
- **THEN** 三条记录均保留为内部候选，字面记录 `Model-X` 获得更高优先级，其余为 regex 命中
- **AND** 不因来源枚举顺序改变而采用低优先级的冲突字段

#### Scenario: 无法命中的别名回退上游
- **WHEN** 公开 ID 为网关自定义别名 `claude`，任何来源表都没有可命中的候选，无规则指定字面查询 ID，且生效链含 `@self`
- **THEN** 该模型不获得外部字段，使用上游能力值及最终默认值发布

#### Scenario: 无上游来源的未命中使用最终默认值
- **WHEN** 同一未命中别名的生效链只声明外部来源、不含 `@self`
- **THEN** 不采用上游能力值，只采用最终默认值发布

#### Scenario: 组合分隔符与大小写一次覆盖
- **WHEN** 查询末段为 `Claude Fable 5.1`，来源同时有 `claude-fable-5-1`、`claude_fable_5.1` 与 `ClaudeFable51`
- **THEN** 三个原始字符串都进入内部候选，且不改变用户显示的原始模型

#### Scenario: 四类单分隔符可替换或删除
- **WHEN** 查询分别为 `a b`、`a_b`、`a.b` 与 `a-b`，来源有 `a b`、`a_b`、`a.b`、`a-b` 与 `ab`
- **THEN** 每个查询均收集这五种来源 ID，各自原样命中保持更高优先级

#### Scenario: 单分隔符不能匹配多个
- **WHEN** 查询为 `a-b`，来源有 `a--b`、`a_.b` 与两个空格分隔的 `a  b`
- **THEN** 这些记录均不进入该查询的候选

#### Scenario: 连续分隔符按原始数量限制
- **WHEN** 查询为 `a--b`，来源有 `ab`、`a_b`、`a_.b` 与 `a---b`
- **THEN** 前三条记录进入候选，`a---b` 不进入候选

#### Scenario: 首尾分隔符也只能替换或删除
- **WHEN** 查询分别为 `-x` 与 `x_`，来源有 `x`、`.x`、`x-`、`--x` 与 `x__`
- **THEN** `-x` 仅匹配 `x` 与 `.x`，`x_` 仅匹配 `x` 与 `x-`

#### Scenario: 无分隔符查询不插入分隔符
- **WHEN** 查询为 `ab`，来源仅有 `a-b`
- **THEN** 不因分隔符可删除规则而命中该来源记录

#### Scenario: 空查询和纯分隔符查询不泛化
- **WHEN** 查询末段为空或仅含空白、下划线、点号、横线
- **THEN** 不生成内部 regex 候选，已有完全相同来源 ID 的字面精确查询仍保持原有语义

#### Scenario: 大小写只影响搜索不影响结果
- **WHEN** 公开 ID 为 `Proxy/MODEL-X`，来源只有命名空间 ID `Vendor/ModelX`
- **THEN** 搜索命中该记录，公开 ID 仍为 `Proxy/MODEL-X`，候选及最终条目保留 `Vendor/ModelX` 的完整大小写

#### Scenario: 前缀不影响候选
- **WHEN** 查询 `claude-fable-5-1`、`devin/claude-fable-5-1` 与 `proxy/vendor/claude-fable-5-1`
- **THEN** 三者得到相同的来源候选集合，保留各自公开 ID

#### Scenario: 来源带命名空间仍保留完整 ID
- **WHEN** 来源记录 ID 为 `anthropic/claude-fable-5-1`，查询末段为 `Claude Fable 5.1`
- **THEN** 该记录可进入候选，最终条目保留来源 ID `anthropic/claude-fable-5-1`，而不是生成不存在的裸 ID

#### Scenario: 输入不是可执行的 regex
- **WHEN** 查询末段为 `Model+(X)-1`，来源有 `model+(x)1` 与 `modelX1`
- **THEN** 仅前者可匹配；`+`、括号及其他非分隔符 regex 元字符按字面匹配，不扩大为任意型号

#### Scenario: 不删除型号语义
- **WHEN** 输入为 `claude-5-fable`、`model_private_11`、`kimi-k3-500k` 或 `model-1m`
- **THEN** 只允许分隔符替换或删除，不自动重排词序、不借显示名推断、不丢弃容量或其他非分隔符语义字符
- **AND** 只有来源已有明确 canonical 关系或用户显式规则时才能沿该关系查询

#### Scenario: 去日期后缀回退保持较低优先级
- **WHEN** 查询为 `Model-X-20260101`，来源同时有 `modelx20260101` 与 `ModelX`
- **THEN** 前者作为 regex 命中，后者作为去日期后缀回退命中，前者优先级更高且两者均保留原始 ID

#### Scenario: 显式第 4 段不参与宽松搜索
- **WHEN** 显式链条目的第 4 段为 `Model-X`，指定来源只有 `model-x` 或 `ModelX`
- **THEN** 该字面链条目仍未命中；来源存在精确 `Model-X` 时才命中

### Requirement: 旧版配置字段报错

系统 SHALL 将 `fill_missing_only`、`source_priority`、`provider_prefix_map`、`lookup_ids`、`models_dev_subscription`、`channels`、`global_fallback` 以及 mapping 形式的 `models` 视为旧版字段。根级或模型规则出现旧字段时，系统 SHALL 报告配置错误，指出字段完整路径并给出对应的新写法提示，且 SHALL 禁止本次目录发布。

对于 `fill_missing_only`，系统 SHALL 提示删除字段：旧 false 对应外部优先、`@self` 兜底，旧 true 对应 `@self` 在前、外部补缺；原先继承开关的规则 SHALL 按每个模型的最终生效链显式表达顺序，SHALL NOT 自动改写用户文件。即使同时声明 `@self`，旧开关仍 SHALL 报错，SHALL NOT 静默忽略或兼容执行。

#### Scenario: 旧链字段给出迁移提示
- **WHEN** 配置根级包含 `source_priority: ["*/api_key"]`
- **THEN** 报告配置错误，提示改用 `chain` 与具体条目，保留此前已验证目录

#### Scenario: 旧 mapping 形式模型规则报错
- **WHEN** 配置 `models` 为 `{"*gpt*": {...}}` 形式
- **THEN** 报告配置错误，提示改为 `- match: "*gpt*"` 列表形式

#### Scenario: 根级旧开关报错
- **WHEN** 根级设置 `fill_missing_only: false`，无论是否同时声明 `@self`
- **THEN** 指出 `fill_missing_only` 路径，提示使用外部优先、上游兜底的链，不发布新目录

#### Scenario: 规则级旧开关报错
- **WHEN** 模型规则设置 `fill_missing_only: true`
- **THEN** 指出 `models[index].fill_missing_only` 路径，提示使用上游在前的链，不自动转换配置

### Requirement: 本地元数据包与内存释放

系统 SHALL 在现有 Worker 隔离边界内，从本次选定的本地数据包同时读取 models.dev 的 provider 记录与按 canonical ID 索引的统一模型资料，并读取 modelparams.dev 目录，SHALL NOT 为编译或推理发起元数据网络请求。数据包的独立版本检查与用户显式更新 SHALL 遵循 `metadata-package-updates` 的联网边界，不与编译隐式绑定。没有已激活的插件管理数据时 SHALL 继续使用插件已安装依赖；有有效活动代次时 SHALL 整组使用该代次。活动记录无效、越界或所指数据不完整时 SHALL 给出简短警告并整组回退原有依赖，SHALL NOT 加载越界路径或自动联网修复。

原厂自动 API 链 SHALL 优先采用该 canonical 的具体原厂 API 记录字段；缺失或无效字段 SHALL 由同一 canonical 的统一资料兜底，再继续后续用户来源。即使原厂 provider 表不存在对应条目，只要 canonical 唯一且统一资料有效，也 SHALL 能富化。系统 SHALL NOT 为解决缺失而借用转售商的限额。

用户显式来源／字面型号查询以及 subscription 条目 SHALL 保持显式查询约束，不自动加入通用 canonical API 兜底。某一数据形状缺失 SHALL 只降级依赖该形状的步骤，不能把仍可用的另一形状整体判为不可用。数据包版本无新增上限，编译完成后完整外部数据 SHALL 被释放，只保留固定编译结果与发布模型表。结果 SHALL 记录本次实际读取的数据版本及快照生成时间；同次编译 SHALL 使用一致的数据代次，SHALL NOT 因模块缓存而把旧版本号附在新数据上。

#### Scenario: 富化不联网
- **WHEN** 上游目录刷新成功并执行默认链编译
- **THEN** 编译本身除先前上游 `/models` 外不增加网络请求，也不在 Worker 内检查或下载数据包

#### Scenario: 编译后不常驻完整数据
- **WHEN** 一次富化完成
- **THEN** 主进程不持有完整 provider/canonical 快照或 modelparams 目录，Worker 结束

#### Scenario: 编译结果标明数据版本
- **WHEN** 查看编译结果
- **THEN** 包含两个实际读取的数据包版本号与 models.dev 快照生成时间

#### Scenario: 原厂 API 条目缺失但 canonical 资料存在
- **WHEN** 原厂表没有 `gpt-5-codex`，统一资料有 `openai/gpt-5-codex` 的 400000/128000
- **THEN** 默认自动 API 链可采用这两个限额，字段来源标为统一 canonical 资料

#### Scenario: 原厂实际限额优先于通用资料
- **WHEN** 原厂具体记录给出 context 200000、统一 canonical 资料给出 1000000
- **THEN** 该自动来源采用 200000，不被同来源的通用兜底覆盖

#### Scenario: 缺少 providers 时仍可使用 canonical 资料
- **WHEN** 快照仅有合法统一 canonical 资料，且默认查询能唯一定位该模型
- **THEN** 仍能富化并报告 provider 数据形状降级，不拒绝整个站点

#### Scenario: 更新在下一次编译生效
- **WHEN** 插件激活已验证的新数据代次并在同进程再次编译
- **THEN** Worker 读取新代次路径，记录该代次版本；此前已启动的 Worker 仍读取自己的完整旧代次

#### Scenario: 无缓存保持兼容
- **WHEN** 用户尚未执行更新且没有活动代次
- **THEN** 原有已安装依赖继续提供数据，既有逐站点与逐形状降级语义保持不变

#### Scenario: 损坏活动记录不破坏目录
- **WHEN** 活动记录指向缺失目录、不完整两包数据或插件私有根以外的路径
- **THEN** 不读取越界内容，不自行联网；警告后整组回退原有依赖，并按既有语义处理仍不可用的站点

### Requirement: 元数据提示不作为错误显示

插件自有的面向用户输出 SHALL 统一以精确标识 `[openai-api-pi-extension]` 开头，每条消息只添加一次。此规则 SHALL 覆盖目录提示、警告、错误、登录输入提示与进度、连接信息、版本检查和更新结果、导出路径通知，以及独立诊断导出的首行；SHALL NOT 改写用户/模型内容、公开模型 ID、API payload、凭证值或 Pi 自身消息。多行消息 SHALL 在首行标明来源，不要求给每一条结构化数据行重复加前缀。

目录及更新诊断 SHALL 只作为运行时通知：交互模式复用 Pi 原生通知，按实际严重度使用 info/warning/error；无可用交互界面时只写 stderr，SHALL NOT 污染 CLI stdout。外部错误与子进程输出 SHALL 在统一输出边界脱敏、转义控制字符，不把包管理器原始输出直接透传到终端。系统 SHALL NOT 为这些诊断追加会话条目、注入对话或创建替代持久化日志。既有内存去重 SHALL 可保留，但诊断与去重状态 SHALL NOT 写入会话 JSONL。

非错误提示 SHALL NOT 使用错误样式；配置错误与上游失败仍 SHALL 明确可见，但不持久化。自动通知 SHALL 只提供简短分类汇总或数据包更新摘要；完整元数据候选与原因通过用户主动执行的编译结果导出查看。已存在的历史 JSONL SHALL NOT 被本变更自动修改或删除。此限制不改变正常对话持久化、Pi 模型目录缓存、插件数据包活动记录或用户主动生成的临时导出文件。

#### Scenario: 降级提示非错误样式
- **WHEN** 某站点数据不可用导致降级
- **THEN** 用户看到带插件前缀的临时普通或警告通知，而不是错误会话条目

#### Scenario: 通知不写会话 JSONL
- **WHEN** 后台刷新报告未匹配汇总或来源降级
- **THEN** 当次界面可见带前缀通知，但会话不新增插件 note/error 自定义条目

#### Scenario: 配置错误也不持久化
- **WHEN** 后台刷新遇到非法配置
- **THEN** 产生带前缀的临时 error 通知并保留旧目录，不追加会话条目

#### Scenario: CLI 只在 stderr 提示
- **WHEN** 无交互界面的显式目录刷新产生诊断
- **THEN** 诊断仅出现在 stderr 且使用 `[openai-api-pi-extension]`，stdout 仍只有该 CLI 命令的正常结果

#### Scenario: 旧会话不自动清理
- **WHEN** 会话已经包含旧版插件写入的提示条目
- **THEN** 不重写或删除该 JSONL；新诊断不再追加同类条目

#### Scenario: 登录和命令也标明来源
- **WHEN** 用户登录、查看连接信息、检查更新或执行数据更新
- **THEN** 插件创建的输入提示、进度、结果及错误均以精确插件前缀开头；URL 或密钥输入值本身不添加前缀

#### Scenario: 去重与异常兜底不重复前缀
- **WHEN** 同一条已带前缀的消息进入统一输出或 UI 通知失败后转向 stderr
- **THEN** 最终消息仍只有一个精确前缀，重复 note 的既有去重行为保持有效

#### Scenario: 外部包管理器错误仍安全展示
- **WHEN** 子进程返回带认证信息或终端控制字符的错误文本
- **THEN** 仅展示脱敏和转义后的带前缀摘要，不泄露凭证，不透传原始 stdout/stderr

### Requirement: 命中统计区分全部与部分未匹配

每次编译 SHALL 对启用外部链的模型分别统计完整命中、部分来源缺失、完全未命中。至少有一项有效外部能力字段且无外部条目缺失的模型计为完整命中；有有效外部能力字段但部分外部条目未解析的模型计为部分来源缺失；没有有效外部能力字段的模型计为完全未命中。只有名称命中 SHALL NOT 计作能力资料命中。

`@self` SHALL NOT 计作外部命中、外部条目缺失或外部候选。仅含上游来源的模型 SHALL 另列为外部链禁用，不计为匹配失败；包含外部来源与上游来源的模型 SHALL 仍按外部条目实际命中情况分类，不能因上游已有能力而掩盖外部未命中。三项 SHALL 覆盖启用外部链的模型总数。

#### Scenario: 部分站点缺失不算完全失败
- **WHEN** models.dev 提供 context/output，modelparams.dev 无匹配，链还含 `@self`
- **THEN** 统计为部分来源缺失，而不是完全未命中或完整命中

#### Scenario: 上游不冒充外部命中
- **WHEN** 外部链均无有效能力数据，但 `@self` 提供完整上游能力
- **THEN** 发布可采用上游值，外部匹配仍统计为完全未命中

#### Scenario: 分类计数互斥且守恒
- **WHEN** 某目录有两模型外部完整命中、一模型部分缺失、一模型完全未命中及一模型链为 `["@self"]`
- **THEN** 汇总为完整 2、部分 1、未匹配 1、禁用 1，启用外部链总数为 4

### Requirement: 元数据配置与最终默认值文档

项目 SHALL 在 `docs/` 的模型元数据专题维护来源链语法、`@self` 顺序示例、继承与 `@default` 规则、空链错误及旧开关迁移说明，并明确列出所有声明来源和用户覆盖均未提供能力字段时的最终默认值：`contextWindow` 固定回退为 128000 tokens；`maxTokens` 缺失时取来源解析后的 `contextWindow`，只有上下文也缺失时才为 128000；未声明推理档位时 `reasoning: false` 且不生成 `thinkingLevelMap`；未声明图片输入时 `input: ["text"]`。文档 SHALL 说明无用户覆盖时当前 `cost` 四项固定为 0，这是价格占位而非真实计费数据，并非等待外部价格查询失败才回退。

文档 SHALL 区分固定默认值、依据已解析字段计算的回退值及统计占位值，SHALL NOT 将插件回退值宣传为模型真实上下文、输出能力或真实价格。来源选择完成后才补默认值，人工覆盖仍在其后执行；文档 SHALL NOT 声称只覆盖 contextWindow 会自动重算已经生成的 maxTokens。

README SHALL 作为功能特色、最简安装和登录使用入口，通过有效相对链接指向详细文档，SHALL NOT 重复维护完整配置、默认值表或实现说明。既有环境变量、传输恢复、压缩、检查点与开发说明 SHALL 在对应专题中可达，不因精简入口而丢失必要使用条件或安全限制。

#### Scenario: 用户查阅最终默认值
- **WHEN** 用户从 README 的文档入口进入模型元数据配置说明
- **THEN** 可以查到 contextWindow、maxTokens、推理档位、输入模态及成本占位的实际回退规则，并区分真实来源值与插件默认值

#### Scenario: 输出上限按已解析上下文派生
- **WHEN** 声明来源提供 contextWindow 对应值 200000，未提供输出上限且用户未覆盖
- **THEN** 文档准确说明 maxTokens 为 200000，而不是固定 128000

#### Scenario: 配置示例使用新规则
- **WHEN** 用户查阅有效配置或迁移示例
- **THEN** 正常示例使用非空链与 `@self`，旧 `fill_missing_only` 和空链只出现在明确标为旧写法或错误的迁移说明中

#### Scenario: 文档拆分后仍可找到原有细节
- **WHEN** 用户需要环境变量配置、传输故障排查、压缩或检查点限制、开发测试说明
- **THEN** 可以通过 README 文档链接进入对应 `docs/` 专题，所有本地文件链接及迁移后的章节锚点均有效

### Requirement: 宿主注册的记录来源

使用编译核心的宿主 SHALL 声明自己支持的记录来源关键词集合，并为每个关键词提供"按原始公开模型 ID 返回该模型原始能力记录或无记录"的来源。关键词 SHALL 为 `@` 加小写字母、数字与 `-` 组成的名称，且 SHALL NOT 为 `@default`、`@creator` 或 `@id`；违反时宿主注册失败，而不是作为用户配置错误。Pi 插件 SHALL 只注册 `@self`，其记录为当前模型的上游目录行。

每个记录来源节点 SHALL 只在其所在链位置提供该模型自身记录的规范化能力字段；字段别名 SHALL 在选择前统一；返回无记录时该节点不提供字段，后续来源继续。没有某记录来源关键词的生效链 SHALL NOT 读取该来源。记录来源 SHALL 与 `@self` 同等适用严格替换、命中统计和编译结果展示规则：
- 不计作外部命中、外部条目缺失或外部候选。
- 只含记录来源的模型计为外部链禁用。
- 编译结果中按关键词标注节点类型与具体模型 ID。

记录来源的读取 SHALL 在生效链确有需要时才发生。

#### Scenario: 宿主注册额外来源
- **WHEN** 测试宿主注册 `@self` 与 `@probe`，模型链为 `["@probe", "@self"]`，`@probe` 提供 context 200000，上游提供 context 128000 与输出 64000
- **THEN** 最终 contextWindow 为 200000，maxTokens 为 64000
- **AND** 编译结果的固定链按顺序含绑定该模型 ID 的 `@probe` 与 `@self` 节点

#### Scenario: 来源无记录时继续后续来源
- **WHEN** `@probe` 对某模型返回无记录，链为 `["@probe", "models.dev/@creator/api_key"]`
- **THEN** 该模型字段由后续外部来源提供，`@probe` 不被计作外部未命中

#### Scenario: 不在链中的来源不被读取
- **WHEN** 所有模型生效链均不含 `@probe`
- **THEN** 编译与字段选择过程不调用 `@probe` 的来源

#### Scenario: 保留关键词不能注册
- **WHEN** 宿主尝试注册 `@creator` 或 `@default`
- **THEN** 注册失败并给出宿主错误，用户配置不被当作出错

### Requirement: include_models 模型选择

系统 SHALL 支持根级 `include_models` 为有序字符串列表，每项为一个 glob 模式，可带一个前缀 `!` 表示排除。模式与 `match` 使用同一匹配语义，并匹配完整公开模型 ID。

对每个上游模型，系统 SHALL 按列表顺序找出所有命中的条目，以最后一个命中条目决定结果：
- 不带 `!` 的条目命中为保留。
- 带 `!` 的条目命中为隐藏。
- 没有任何条目命中的模型隐藏。

缺省 `include_models` 时 SHALL 保留全部模型。以下情况 SHALL 作为配置错误，指出完整路径，禁止本次目录发布并保留此前已验证目录：
- 显式空列表。
- 非字符串项。
- 空字符串。
- 只有 `!` 的项。

被隐藏的模型 SHALL NOT 参与元数据编译、外部数据读取或记录来源读取，SHALL NOT 出现在发布目录中，也 SHALL NOT 计入命中统计。被保留的模型 SHALL 保持原有公开 ID、显示名与上游成员语义。全部模型被隐藏时，系统 SHALL 发布空目录并给出警告通知，说明被隐藏的模型数。

#### Scenario: 缺省时包含全部
- **WHEN** 配置未声明 `include_models`
- **THEN** 所有合法上游模型照常编译与发布

#### Scenario: 隐藏裸别名
- **WHEN** `include_models: ["*/**"]`，上游有 `claude`、`proxy/claude` 与 `proxy/a/b`
- **THEN** 发布 `proxy/claude` 与 `proxy/a/b`，`claude` 被隐藏

#### Scenario: 最后命中的条目生效
- **WHEN** `include_models: ["**", "!**/gpt-image-*", "codex/gpt-image-2"]`
- **THEN** `codex/gpt-image-2` 保留，`codex/gpt-image-1` 与 `gpt-image-1` 隐藏，其他模型保留

#### Scenario: 未命中任何条目即隐藏
- **WHEN** `include_models: ["proxy/**"]`，上游有 `other/m`
- **THEN** `other/m` 被隐藏

#### Scenario: 空列表是配置错误
- **WHEN** 配置 `include_models: []`
- **THEN** 报告 `include_models` 配置错误，不发布新目录，保留此前已验证目录

#### Scenario: 隐藏模型不产生数据处理
- **WHEN** 被隐藏模型的规则链含外部来源与 `@self`
- **THEN** 不为该模型执行外部查询或读取其上游能力记录，其不出现在命中统计中

### Requirement: 宿主中立的编译入口

系统 SHALL 提供不依赖 Pi 宿主包的编译入口，能力覆盖：
- 配置解析与校验。
- `include_models` 模型选择。
- 记录来源注册。
- 在隔离 Worker 内的目录编译。
- 字段解析。
- 把两个元数据数据包内容转换为 SourceTables 数据。

该入口 SHALL NOT 导入 Pi 宿主包，也 SHALL NOT 读取 Pi agent 目录。宿主 SHALL 能以 `tablesPath` 指定一个 SourceTables JSON 文件，Worker 从该文件读取数据，而不加载已安装的数据包；结果 SHALL 记录该文件携带的数据版本与快照生成时间。数据包内容转换为 SourceTables 时 SHALL 对 provider 记录、统一 canonical 资料与 modelparams 目录各自独立校验并记录降级，与运行时加载数据包的校验结果一致。

Pi 插件 SHALL 通过该入口实现原有行为，用户可见的目录、通知与导出语义不因入口拆分而改变。

#### Scenario: 非 Pi 宿主可直接编译
- **WHEN** 一个未安装 Pi 宿主包的 Node 进程通过该入口、`tablesPath` 与已注册记录来源编译一组公开模型 ID
- **THEN** 编译成功并返回固定链与字段来源，不尝试解析 Pi agent 目录

#### Scenario: 预转换数据与运行时加载等价
- **WHEN** 同一版本数据包分别经转换函数写成 SourceTables JSON 后通过 `tablesPath` 编译、以及由 Worker 运行时加载后编译
- **THEN** 两次编译对相同配置与模型得到相同固定链、字段与数据版本

#### Scenario: 转换时单一数据形状损坏
- **WHEN** 数据包缺少合法的 providers 对象但统一 canonical 资料合法
- **THEN** 转换结果保留 canonical 资料并记录 providers 形状降级，不拒绝整个站点
