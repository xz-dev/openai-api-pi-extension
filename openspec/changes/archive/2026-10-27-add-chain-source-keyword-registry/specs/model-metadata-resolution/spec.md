## MODIFIED Requirements

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

## ADDED Requirements

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
