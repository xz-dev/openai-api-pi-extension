## MODIFIED Requirements

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

系统 SHALL 支持根级 `models` 为有序规则列表，每条规则以 `match` 声明匹配模式。`match` SHALL 匹配完整公开模型 ID，包含任意前缀及裸名；匹配 SHALL 区分大小写并覆盖整个目标字符串，`*` SHALL 匹配零个或多个任意字符（包含 `/`），其余字符 SHALL 按字面处理，连续 `*` SHALL 不产生路径专用语义。

一个模型 SHALL 按列表声明顺序应用所有命中规则，逐字段叠加：后命中规则声明的非空 `chain` SHALL 整体替换此前链，未声明链的规则 SHALL 保留此前链；`overrides` SHALL 按规则顺序逐层合并。系统 SHALL NOT 按模式长度或精确程度重新排序，也 SHALL NOT 另行继承合并模式开关。规则 SHALL 只选择配置，不更改公开 ID，不将 `match` 模式作为外部查询身份。

#### Scenario: 后缀 glob 同时覆盖裸名和多级前缀
- **WHEN** 规则 `match: "*gpt-6-astra"`
- **THEN** `gpt-6-astra`、`openai/gpt-6-astra` 和 `proxy/openai/gpt-6-astra` 均命中
- **AND** `gpt-6-astra-preview` 不命中

#### Scenario: 后命中的规则覆盖先命中的同字段
- **WHEN** 列表依次为 `match: "*"` 设置外部来源加 `@self`，`match: "proxy/*"` 设置 `["@self"]`
- **THEN** `proxy/claude` 仅采用上游，其余模型仍按此前的外部来源加上游顺序取值

#### Scenario: 多条命中规则逐字段叠加
- **WHEN** `match: "proxy/*"` 设置 `overrides: {contextWindow: 200000}`，其后 `match: "proxy/claude"` 设置 `chain`
- **THEN** `proxy/claude` 同时使用后者的链与前者的 `contextWindow` 覆盖

#### Scenario: 精确模式不因声明位置获得额外优先级
- **WHEN** 列表先声明 `match: "proxy/claude"` 设置 `["@self"]`，后声明 `match: "*"` 设置外部来源链
- **THEN** `proxy/claude` 使用后声明的外部来源链，不因较早规则精确匹配而保留上游来源

#### Scenario: 配置匹配不放宽外部身份
- **WHEN** `match: "*gpt*"` 同时匹配两个不同实际模型
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

系统 SHALL 接受 `<site>/<provider>/<access>[/<model_id>]`、整条 `@default` 或整条 `@self`。site 为 models.dev/modelparams.dev，provider 为字面 ID 或 `@creator`，access 为 subscription/api_key。省略第 4 段等同内部 `@id` 查询，写出时为可包含 `/` 的字面 ID。配置链任何段 SHALL NOT 接受 `*` 或 regex。`@self` SHALL 仅在完整链条目精确等于该关键词时表示上游来源，SHALL NOT 被当作站点查询。`@default` SHALL 原地插入根级生效链，包含其中的 `@self`，且 SHALL NOT 用于根级链；模型规则的 chain SHALL 替换此前链。

编译结果 SHALL 保留所有外部查询候选的字面身份、canonical、匹配优先级及选用／跳过原因。完成身份和来源筛选后，所有可用外部命中 SHALL 具体化为固定条目；相同来源记录别名 SHALL 去重，SHALL NOT 因为首个命中而丢失其余候选。最终执行链 SHALL 只包含固定外部字面身份及已选字段，或已绑定具体原始公开模型 ID 的上游来源节点，保持相对顺序；SHALL NOT 留有待执行 regex、通配符或待解释的 `@self` / `@default` 等查询关键词。上游来源 SHALL NOT 冒充任一外部站点、provider 或 canonical 记录。相同配置、上游输入与相同数据版本 SHALL 产生相同结果，来源枚举顺序 SHALL NOT 改变结果。

字段选择 SHALL 保持用户链顺序、厂商别名组顺序与匹配层级优先级，每个字段采用最高优先级的有效值。同来源同层级、同 canonical 的别名记录若能力字段冲突，系统 SHALL 保留候选与冲突原因，跳过该冲突记录组并继续后续来源，而不是按字母顺序选值。models.dev 的 access 仍为声明标签；modelparams.dev SHALL 按 `authType === access` 过滤。每个采用的字段 SHALL 能追溯到具体上游模型、provider 记录或统一 canonical 资料。

#### Scenario: 聚合 provider 变体不影响原厂条目
- **WHEN** 公开 ID 为 `gw/claude-fable-5-1`，原厂 anthropic 有该模型，聚合 provider 有多个同名命名空间变体
- **THEN** 编译链采用 `models.dev/anthropic/api_key/claude-fable-5-1` 的限额
- **AND** 聚合记录可提供 canonical 身份线索，但其限额不进入该模型的字段合并

#### Scenario: 通配符条目被拒绝
- **WHEN** 链包含 `"*/api_key"` 或 `"models.dev/*/api_key"`
- **THEN** 报告配置错误并指出条目路径

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

## ADDED Requirements

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
