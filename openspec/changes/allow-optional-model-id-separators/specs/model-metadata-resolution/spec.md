## MODIFIED Requirements

### Requirement: 查询 ID 归一化

`@id` SHALL 只取公开模型 ID 最后一个 `/` 后的部分作为查询输入。归一化 SHALL 是编译期内部查询展开，不是公开模型重命名：系统 SHALL 先保留字面精确命中，再生成整串匹配、大小写不敏感的内部 regex。查询中的每个空白、下划线、点号、横线 SHALL 独立匹配零个或一个这四类分隔符，即一换零或一换一；连续 n 个分隔符 SHALL 最多匹配 n 个来源分隔符，SHALL NOT 将一个分隔符扩展为两个或更多，SHALL NOT 在查询原本没有分隔符的位置插入分隔符。此规则 SHALL 同样适用于内部、开头和结尾位置，空白范围 SHALL 保持既有 `\s` 语义。空查询及仅由分隔符组成的查询 SHALL NOT 产生泛化 regex 候选。

输入其余字符 SHALL 转义为字面值，SHALL NOT 被解释为用户提供的 regex。既有去除末尾日期后缀的查询回退 SHALL 作为更低优先级的独立查询保留，SHALL NOT 把版本号或日期泛化成任意数字。大小写不敏感 SHALL 仅用于内部搜索匹配；公开模型 ID、完整来源 ID、来源 key、最终编译链条目的 ID SHALL 保留各自原始拼写，SHALL NOT 被转成小写或替换为用于搜索的变体。

查询 SHALL 收集所有匹配的来源原始 ID，包含来源 key/id 别名及带命名空间记录的末段匹配；每个命中 SHALL 保留完整原始来源 ID 与来源身份。系统 SHALL NOT 在发现首个匹配后停止。候选集合 SHALL 在来源枚举顺序变化时保持确定；字面命中优先于 regex 命中，regex 命中优先于去日期后缀回退。新增的可选分隔符匹配 SHALL 沿用既有 canonical 身份歧义处理，SHALL NOT 为获得结果而随意合并不同型号。归一化规则 SHALL NOT 由用户配置。用户显式给出的链条目第 4 段 SHALL 保持区分大小写的字面精确查询，不参与 regex 或日期回退；用户规则的 glob 匹配 SHALL 不受本规则变更影响。

#### Scenario: 点号写法命中横线记录
- **WHEN** 公开 ID 为 `proxy/claude-sonnet-4.5`，anthropic 表只有 `claude-sonnet-4-5`
- **THEN** 编译条目为 `models.dev/anthropic/api_key/claude-sonnet-4-5`

#### Scenario: 原样命中优先于归一化
- **WHEN** 来源表同时有 `Model-X`、`model_x` 与 `modelx`，公开 ID 末段为 `Model-X`
- **THEN** 三条记录均保留为内部候选，字面记录 `Model-X` 获得更高优先级，其余为 regex 命中
- **AND** 不因来源枚举顺序改变而采用低优先级的冲突字段

#### Scenario: 无法命中的别名回退上游
- **WHEN** 公开 ID 为网关自定义别名 `claude`，任何来源表都没有可命中的候选，且无规则指定字面查询 ID
- **THEN** 该模型不获得外部字段，使用上游值及默认值发布

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
