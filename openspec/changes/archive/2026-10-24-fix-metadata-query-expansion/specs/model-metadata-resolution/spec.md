## MODIFIED Requirements

### Requirement: 上游目录控制模型成员

系统 SHALL 接受上游 `/models` 的 Codex `models[]` 或标准 OpenAI `data[]`，保留既有非聊天模型过滤。外部元数据 SHALL NOT 新增上游未列出的模型，也 SHALL NOT 改写公开模型 ID、认证、baseUrl、provider 或 API 路由。自动查询展开与富化 SHALL 保留网关原有显示名（按既有 name/display_name 回退到公开 ID 的规则）；只有用户显式 overrides 或 Pi modelOverrides SHALL 能修改显示名。内部查询 ID、canonical ID 与来源名称 SHALL NOT 替换公开 ID 或自动覆盖网关显示名。缺少合法身份或不合法目录结构 SHALL 使本次目录更新失败，而不是发布部分成员。

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
- **WHEN** 上游 ID 为 `proxy/Claude Fable 5.1`、显示名为 `My Fable`，内部匹配到 `claude-fable-5-1`
- **THEN** 发布 ID 和发送请求的型号仍为 `proxy/Claude Fable 5.1`，显示名仍为 `My Fable`
- **AND** 不新增公开模型 `claude-fable-5-1`

#### Scenario: 显式显示名覆盖仍生效
- **WHEN** 上游显示名为 `My Fable`，用户 overrides 设置 name 为 `Work Model`
- **THEN** 发布显示名为 `Work Model`；Pi modelOverrides 仍可最终覆盖该值

### Requirement: 查询 ID 归一化

`@id` SHALL 只取公开模型 ID 最后一个 `/` 后的部分作为查询输入。归一化 SHALL 是编译期内部查询展开，不是公开模型重命名：系统 SHALL 先保留字面精确命中，再生成整串匹配、大小写不敏感的内部 regex，使空格、下划线、点号与横线组成的分隔符片段可互换；输入其余字符 SHALL 转义为字面值，SHALL NOT 被解释为用户提供的 regex。既有去除末尾日期后缀的查询回退 SHALL 作为更低优先级的独立查询保留，SHALL NOT 把版本号或日期泛化成任意数字。

查询 SHALL 收集所有匹配的来源原始 ID，包含来源 key/id 别名及带命名空间记录的末段匹配；每个命中 SHALL 保留完整原始来源 ID 与来源身份。系统 SHALL NOT 在发现首个匹配后停止。候选集合 SHALL 在来源枚举顺序变化时保持确定；字面命中优先于 regex 命中，regex 命中优先于去日期后缀回退。归一化规则 SHALL NOT 由用户配置。用户显式给出的链条目第 4 段 SHALL 保持字面精确查询，不参与 regex 或日期回退。

#### Scenario: 点号写法命中横线记录
- **WHEN** 公开 ID 为 `proxy/claude-sonnet-4.5`，anthropic 表只有 `claude-sonnet-4-5`
- **THEN** 编译条目为 `models.dev/anthropic/api_key/claude-sonnet-4-5`

#### Scenario: 原样命中优先于归一化
- **WHEN** 来源表同时有 `Model-X` 与 `model-x`，公开 ID 末段为 `Model-X`
- **THEN** 两条记录均保留为内部候选，字面记录 `Model-X` 获得更高优先级
- **AND** 不因来源枚举顺序改变而采用低优先级的冲突字段

#### Scenario: 无法命中的别名回退上游
- **WHEN** 公开 ID 为网关自定义别名 `claude`，任何来源表都没有可命中的候选，且无规则指定字面查询 ID
- **THEN** 该模型不获得外部字段，使用上游值及默认值发布

#### Scenario: 组合分隔符与大小写一次覆盖
- **WHEN** 查询末段为 `Claude Fable 5.1`，来源同时有 `claude-fable-5-1` 与 `claude_fable_5.1`
- **THEN** 两个原始字符串都进入内部候选，且不改变用户显示的原始模型

#### Scenario: 前缀不影响候选
- **WHEN** 查询 `claude-fable-5-1`、`devin/claude-fable-5-1` 与 `proxy/vendor/claude-fable-5-1`
- **THEN** 三者得到相同的来源候选集合，保留各自公开 ID

#### Scenario: 来源带命名空间仍保留完整 ID
- **WHEN** 来源记录 ID 为 `anthropic/claude-fable-5-1`，查询末段为 `Claude Fable 5.1`
- **THEN** 该记录可进入候选，最终条目保留来源 ID `anthropic/claude-fable-5-1`，而不是生成不存在的裸 ID

#### Scenario: 输入不是可执行的 regex
- **WHEN** 查询末段含 `+`、括号或 `.*` 等字符
- **THEN** 这些字符按字面匹配，不能扩大成任意型号匹配

#### Scenario: 不删除型号语义
- **WHEN** 输入为 `claude-5-fable`、`model_private_11`、`kimi-k3-500k` 或 `model-1m`
- **THEN** 不自动重排词序、不借显示名推断、不丢弃容量或其他语义后缀
- **AND** 只有来源已有明确 canonical 关系或用户显式规则时才能沿该关系查询

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

### Requirement: 链条目语法与编译结果

系统 SHALL 继续接受 `<site>/<provider>/<access>[/<model_id>]` 或整条 `@default`。site 为 models.dev/modelparams.dev，provider 为字面 ID 或 `@creator`，access 为 subscription/api_key。省略第 4 段等同内部 `@id` 查询，写出时为可包含 `/` 的字面 ID。配置链任何段 SHALL NOT 接受 `*` 或 regex。`@default` SHALL 原地插入根级生效链，模型规则的 chain SHALL 替换此前链。

编译结果 SHALL 保留所有查询候选的字面身份、canonical、匹配优先级及选用／跳过原因。完成身份和来源筛选后，所有可用命中 SHALL 具体化为固定条目；相同来源记录别名 SHALL 去重，SHALL NOT 因为首个命中而丢失其余候选。最终执行链 SHALL 只包含 `<site>/<provider>/<access>/<model_id>` 字面身份和已选字段，SHALL NOT 留有待执行 regex、关键词或通配符。相同配置与相同数据版本 SHALL 产生相同结果，来源枚举顺序 SHALL NOT 改变结果。

字段选择 SHALL 保持用户链顺序、厂商别名组顺序与匹配层级优先级，每个字段采用最高优先级的有效值。同来源同层级、同 canonical 的别名记录若能力字段冲突，系统 SHALL 保留候选与冲突原因，跳过该冲突记录组并继续后续来源，而不是按字母顺序选值。models.dev 的 access 仍为声明标签；modelparams.dev SHALL 按 `authType === access` 过滤。每个采用的字段 SHALL 能追溯到 provider 记录或统一 canonical 资料。

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
- **WHEN** 根链为 `[A, B]`，命中规则 chain 为订阅条目加 `@default`
- **THEN** 按订阅条目、A、B 的顺序编译，不由 canonical 通用资料越过订阅来源的限制

#### Scenario: 字段按条目顺序首个有效值
- **WHEN** 第一条目提供 context_window，第二条目提供不同 context_window 与 supported_reasoning_levels
- **THEN** context_window 使用第一条目，supported_reasoning_levels 使用第二条目

#### Scenario: 多个 regex 命中不按来源返回顺序选一个
- **WHEN** 同一来源有两个 regex 命中的等价别名，交换两条记录的枚举顺序
- **THEN** 两次编译保留相同候选、相同固定链和相同字段来源

#### Scenario: 同级别名能力冲突继续后续来源
- **WHEN** 同一 provider 下两个同级别名指向同一 canonical，但输出上限不同，后续站点有可用记录
- **THEN** 冲突别名组不提供字段，候选及原因保留；后续站点仍可提供字段

### Requirement: 本地元数据包与内存释放

系统 SHALL 在现有 Worker 隔离边界内，从已安装的数据包同时读取 models.dev 的 provider 记录与按 canonical ID 索引的统一模型资料，并读取 modelparams.dev 目录，SHALL NOT 为此发起元数据网络请求。原厂自动 API 链 SHALL 优先采用该 canonical 的具体原厂 API 记录字段；缺失或无效字段 SHALL 由同一 canonical 的统一资料兜底，再继续后续用户来源。即使原厂 provider 表不存在对应条目，只要 canonical 唯一且统一资料有效，也 SHALL 能富化。系统 SHALL NOT 为解决缺失而借用转售商的限额。

用户显式来源／字面型号查询以及 subscription 条目 SHALL 保持显式查询约束，不自动加入通用 canonical API 兜底。某一数据形状缺失 SHALL 只降级依赖该形状的步骤，不能把仍可用的另一形状整体判为不可用。数据包版本无新增上限，编译完成后完整外部数据 SHALL 被释放，只保留固定编译结果与发布模型表。结果 SHALL 记录数据版本及快照生成时间。

#### Scenario: 富化不联网
- **WHEN** 上游目录刷新成功并执行默认链编译
- **THEN** 除上游 `/models` 外，不产生 models.dev/modelparams.dev 网络请求

#### Scenario: 编译后不常驻完整数据
- **WHEN** 一次富化完成
- **THEN** 主进程不持有完整 provider/canonical 快照或 modelparams 目录，Worker 结束

#### Scenario: 编译结果标明数据版本
- **WHEN** 查看编译结果
- **THEN** 包含两个数据包版本号与 models.dev 快照生成时间

#### Scenario: 原厂 API 条目缺失但 canonical 资料存在
- **WHEN** 原厂表没有 `gpt-5-codex`，统一资料有 `openai/gpt-5-codex` 的 400000/128000
- **THEN** 默认自动 API 链可采用这两个限额，字段来源标为统一 canonical 资料

#### Scenario: 原厂实际限额优先于通用资料
- **WHEN** 原厂具体记录给出 context 200000、统一 canonical 资料给出 1000000
- **THEN** 该自动来源采用 200000，不被同来源的通用兜底覆盖

#### Scenario: 缺少 providers 时仍可使用 canonical 资料
- **WHEN** 快照仅有合法统一 canonical 资料，且默认查询能唯一定位该模型
- **THEN** 仍能富化并报告 provider 数据形状降级，不拒绝整个站点

### Requirement: 元数据提示不作为错误显示

目录提示、警告与错误 SHALL 只作为运行时通知：交互模式复用 Pi 原生通知，按实际严重度使用 info/warning/error；无可用交互界面时只写 stderr，SHALL NOT 污染 CLI stdout。系统 SHALL NOT 为这些诊断追加会话条目、注入对话或创建替代持久化日志。既有内存去重 SHALL 可保留，但诊断与去重状态 SHALL NOT 写入会话 JSONL。

非错误提示 SHALL NOT 使用错误样式；配置错误与上游失败仍 SHALL 明确可见，但不持久化。自动通知 SHALL 只提供简短分类汇总；完整候选与原因通过用户主动执行的编译结果导出查看。已存在的历史 JSONL SHALL NOT 被本变更自动修改或删除。此限制不改变正常对话持久化、Pi 模型目录缓存或用户主动生成的临时导出文件。

#### Scenario: 降级提示非错误样式
- **WHEN** 某站点数据不可用导致降级
- **THEN** 用户看到临时普通或警告通知，而不是错误会话条目

#### Scenario: 通知不写会话 JSONL
- **WHEN** 后台刷新报告未匹配汇总或来源降级
- **THEN** 当次界面可见通知，但会话不新增插件 note/error 自定义条目

#### Scenario: 配置错误也不持久化
- **WHEN** 后台刷新遇到非法配置
- **THEN** 产生临时 error 通知并保留旧目录，不追加会话条目

#### Scenario: CLI 只在 stderr 提示
- **WHEN** 无交互界面的显式目录刷新产生诊断
- **THEN** 诊断仅出现在 stderr，stdout 仍只有该 CLI 命令的正常结果

#### Scenario: 旧会话不自动清理
- **WHEN** 会话已经包含旧版插件写入的提示条目
- **THEN** 不重写或删除该 JSONL；新诊断不再追加同类条目

## ADDED Requirements

### Requirement: 命中统计区分全部与部分未匹配

每次编译 SHALL 对启用外部链的模型分别统计完整命中、部分来源缺失、完全未命中。至少有一项有效外部能力字段且无条目缺失的模型计为完整命中；有有效外部能力字段但部分条目未解析的模型计为部分来源缺失；没有有效外部能力字段的模型计为完全未命中。只有名称命中 SHALL NOT 计作能力资料命中。三项 SHALL 覆盖启用外部链的模型总数；显式禁用外部链的模型另列，不计为匹配失败。

#### Scenario: 部分站点缺失不算完全失败
- **WHEN** models.dev 提供 context/output，modelparams.dev 无匹配
- **THEN** 统计为部分来源缺失，而不是完全未命中

#### Scenario: 分类计数互斥且守恒
- **WHEN** 某目录有两模型完整命中、一模型部分缺失、一模型完全未命中及一模型禁用外部链
- **THEN** 汇总为完整 2、部分 1、未匹配 1、禁用 1，启用总数为 4
