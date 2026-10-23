## MODIFIED Requirements

### Requirement: 内置链与显式配置

系统 SHALL 在根级 `chain` 未配置时采用内置默认链 `["models.dev/@creator/api_key", "modelparams.dev/@creator/api_key"]`，默认链 SHALL NOT 包含 subscription 来源。根级明确配置列表时 SHALL 整体替换内置链；显式 `[]` SHALL 表示无全局外部来源，而非恢复默认。用户配置 SHALL 从 agent 目录的 `openai-api-extension.yaml` 读取；配置文件缺失等同未配置。非法 YAML、重复键、已知字段的非法值及旧版字段 SHALL 作为配置错误报告，并禁止本次新目录发布、保留此前已验证目录。不属于本插件且不属于旧版字段的未知字段 SHALL 被忽略，并在一条警告中列出完整路径。

#### Scenario: 无用户配置即有默认链
- **WHEN** 没有配置文件且上游目录刷新成功
- **THEN** 每个模型依次考虑 models.dev 原厂 API 来源与 modelparams.dev 原厂 API 来源
- **AND** 不考虑任何 subscription 来源

#### Scenario: 全局显式空链退出默认富化
- **WHEN** 根级 `chain: []` 且没有模型规则声明链
- **THEN** 不读取外部元数据，仍根据上游数据及现有最终默认值发布模型

#### Scenario: 无效配置不静默变为默认配置
- **WHEN** 配置包含非法链条目或非布尔 `fill_missing_only`
- **THEN** 报告配置路径及原因，不切换到内置默认链，不覆盖已有目录

#### Scenario: gateway 专属字段忽略并警告
- **WHEN** 配置同时包含合法 `chain` 与 `static_models`、`cpa_base_url` 等不支持字段
- **THEN** 警告列出被忽略字段的完整路径，合法 `chain` 照常生效，目录正常更新

## ADDED Requirements

### Requirement: 有序模型规则层叠

系统 SHALL 支持根级 `models` 为有序规则列表，每条规则以 `match` 声明匹配模式。`match` SHALL 匹配完整公开模型 ID，包含任意前缀及裸名；匹配 SHALL 区分大小写并覆盖整个目标字符串，`*` SHALL 匹配零个或多个任意字符（包含 `/`），其余字符 SHALL 按字面处理，连续 `*` SHALL 不产生路径专用语义。

一个模型 SHALL 按列表声明顺序应用所有命中规则，逐字段叠加：同一字段由后命中的规则覆盖先命中的规则，未设置的字段 SHALL 保留先前规则或根级的值；`overrides` SHALL 按规则顺序逐层合并。系统 SHALL NOT 按模式长度或精确程度重新排序。规则 SHALL 只选择配置，不更改公开 ID，不将 `match` 模式作为外部查询身份。

#### Scenario: 后缀 glob 同时覆盖裸名和多级前缀
- **WHEN** 规则 `match: "*gpt-6-astra"`
- **THEN** `gpt-6-astra`、`openai/gpt-6-astra` 和 `proxy/openai/gpt-6-astra` 均命中
- **AND** `gpt-6-astra-preview` 不命中

#### Scenario: 后命中的规则覆盖先命中的同字段
- **WHEN** 列表依次为 `match: "*"` 设置 `fill_missing_only: false`，`match: "proxy/*"` 设置 `fill_missing_only: true`
- **THEN** `proxy/claude` 的 `fill_missing_only` 为 true，`other/claude` 为 false

#### Scenario: 多条命中规则逐字段叠加
- **WHEN** `match: "proxy/*"` 设置 `overrides: {contextWindow: 200000}`，其后 `match: "proxy/claude"` 设置 `chain`
- **THEN** `proxy/claude` 同时使用后者的 `chain` 与前者的 `contextWindow` 覆盖

#### Scenario: 精确模式不因声明位置获得额外优先级
- **WHEN** 列表先声明 `match: "proxy/claude"` 设置 `fill_missing_only: true`，后声明 `match: "*"` 设置 `fill_missing_only: false`
- **THEN** `proxy/claude` 的 `fill_missing_only` 为 false

#### Scenario: 配置匹配不放宽外部身份
- **WHEN** `match: "*gpt*"` 同时匹配两个不同实际模型
- **THEN** 每个模型仍用自己的查询身份获取元数据，不共享查询结果或彼此的元数据

### Requirement: 合并模式与 Pi 模型覆盖

系统 SHALL 支持布尔 `fill_missing_only`，按根级默认 < 命中模型规则（按声明顺序，后者优先）继承，未配置时默认 false。false SHALL 允许外部来源覆盖上游同字段；true SHALL 只填上游缺失或校验不通过的字段。字段别名 SHALL 在合并前统一，最终默认值 SHALL 在富化后补入。明确的空 effort 数组 SHALL NOT 被视为缺失。

人工 `overrides` SHALL 作用于富化与默认值补入后的最终 Pi 模型对象，使用 Pi 模型字段名（如 `contextWindow`、`maxTokens`、`thinkingLevelMap`、`compat`），并按 RFC 7396 JSON Merge Patch 语义合并：对象递归合并，数组与标量整体替换，`null` 删除该字段。多条命中规则的 `overrides` SHALL 按规则顺序依次应用。`overrides` SHALL NOT 修改 `id`、`provider`、`api`、`baseUrl`；包含这些字段 SHALL 作为配置错误。Pi `modelOverrides` SHALL 在插件 overrides 之后最终生效。

#### Scenario: 默认外部覆盖上游
- **WHEN** 上游 context_window 为 500000，外部解析值为 1000000，模式未配置
- **THEN** 发布模型 contextWindow 为 1000000

#### Scenario: 显式 true 只补缺失
- **WHEN** 命中规则设置 `fill_missing_only: true`，上游 context_window 为 128000，外部解析值为 1000000，上游未提供输出上限而外部提供 128000
- **THEN** 发布模型 contextWindow 为 128000，maxTokens 为 128000

#### Scenario: 别名不得绕过补漏
- **WHEN** 补漏模式中上游 context_length 为 128000，外部 context_window 为 1000000
- **THEN** 最终 contextWindow 保留 128000

#### Scenario: 默认值不得掩盖真实缺失
- **WHEN** 上游没有 context 字段，外部提供 64000
- **THEN** 最终 contextWindow 为 64000，而不是插件默认 128000

#### Scenario: 明确禁用推理不能被补出档位
- **WHEN** 补漏模式中上游 supported_reasoning_levels 为 `[]`，外部提供 low/high
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

登录成功后的目录、provider 刷新、连接信息展示与编译结果查看 SHALL 使用一致的元数据规则。插件加载阶段 SHALL NOT 发起网络请求或元数据编译：目录恢复由 Pi 持久化存储离线完成，交互会话的目录刷新由 Pi 在界面就绪后后台发起；命令行首次发现 SHALL 通过显式刷新（`pi --refresh --list-models`）完成。外部元数据 SHALL 只在上游目录读取成功后参与编译，推理请求 SHALL 不触发元数据加载。某一外部数据包不可加载或结构无法识别时，依赖该站点的条目 SHALL 降级跳过并报告提示，其余条目继续生效。上游目录失败 SHALL 保留先前持久化目录，不能用外部数据替代成员集合。取消 SHALL 中止发布。元数据或配置失败 SHALL NOT 被报告为凭证失效。

#### Scenario: 外部数据包不可用仍可使用上游目录
- **WHEN** 上游目录有效而 modelparams 包缺失或结构无法识别
- **THEN** 发布结果只缺 modelparams 条目提供的字段，并报告该站点降级而非认证失败

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

系统 SHALL 接受链条目形如 `<site>/<provider>/<access>[/<model_id>]` 或整条关键词 `@default`。`site` SHALL 为 `models.dev` 或 `modelparams.dev`；`provider` SHALL 为字面 provider ID 或 `@creator`；`access` SHALL 为 `subscription` 或 `api_key`；省略第 4 段 SHALL 等同 `@id`，写出时 SHALL 作为字面查询 ID，可包含 `/`，解析时只按前三个 `/` 切分。任何段 SHALL NOT 接受 `*` 或其他通配符；非法条目 SHALL 作为配置错误。`@default` SHALL 在其位置插入根级生效链。模型规则声明的 `chain` SHALL 替换该模型此前生效的链。

系统 SHALL 在每次富化时，基于配置与本次加载的外部数据，为每个模型编译一份只含具体条目的有序链：每个条目 SHALL 为 `<site>/<provider>/<access>/<model_id>` 形式，不含关键词或通配符。相同配置与相同外部数据版本 SHALL 产生相同编译结果。执行时 SHALL 只对编译条目做精确查表；每个字段 SHALL 采用链中第一个提供有效值的条目。models.dev 条目的 `access` SHALL 视为用户声明标签，不按 provider 名称推断；modelparams.dev 条目 SHALL 只命中 `authType` 等于该 `access` 的记录。

#### Scenario: 聚合 provider 变体不影响原厂条目
- **WHEN** 公开 ID 为 `gw/claude-fable-5-1`，models.dev 原厂 anthropic 有该模型，另有聚合 provider 含多个带命名空间的同名变体
- **THEN** 编译链含 `models.dev/anthropic/api_key/claude-fable-5-1`，模型获得 anthropic 记录的限额
- **AND** 聚合 provider 的记录不参与该模型解析

#### Scenario: 通配符条目被拒绝
- **WHEN** 链包含 `"*/api_key"` 或 `"models.dev/*/api_key"`
- **THEN** 报告配置错误并指出条目路径

#### Scenario: 字面第 4 段指定查询 ID
- **WHEN** 规则 `match: "claude"` 设置 `chain: ["models.dev/anthropic/api_key/claude-sonnet-4-5"]`
- **THEN** 模型 `claude` 的编译链为该具体条目，公开 ID 仍为 `claude`

#### Scenario: @default 原地插入根链
- **WHEN** 根链为 `[A, B]`，命中规则 `chain: ["models.dev/zai-coding-plan/subscription", "@default"]`
- **THEN** 该模型按订阅条目、A、B 的顺序编译

#### Scenario: 字段按条目顺序首个有效值
- **WHEN** 第一条目提供 context_window，第二条目提供不同 context_window 与 supported_reasoning_levels
- **THEN** context_window 采用第一条目，supported_reasoning_levels 采用第二条目

### Requirement: 原厂判定与厂商别名组

`@creator` SHALL 按以下规则解析：以 `@id` 的查询候选在 models.dev 全部 provider 记录中查找声明了 `canonical_model_id` 的匹配记录，取其 `<creator>/` 前缀作为原厂；属于同一内置厂商别名组的原厂 SHALL 视为同一原厂。系统 SHALL 内置有序厂商别名组，初始包含 `[zhipuai, zai, z-ai]`、`[moonshotai, moonshot]`、`[thinkingmachines, thinking-machines]`；转售或托管平台 SHALL NOT 与原厂列入同组。原厂解析成功时，`@creator` SHALL 在每个站点按组内顺序展开为该站点命名空间中实际存在的成员；不属于任何组的原厂 SHALL 只展开为自身。

找不到任何原厂时，含 `@creator` 的条目 SHALL 标记为 unresolved 并跳过，模型继续使用其余条目及上游值。匹配到多个不同原厂且模型生效链实际包含 `@creator` 条目时，系统 SHALL 报告配置错误，指出模型 ID 与冲突原厂，并禁止本次目录发布；生效链不含 `@creator` 的模型 SHALL NOT 因此报错。

#### Scenario: 别名组展开到各站点存在的成员
- **WHEN** `glm-5.1` 的 canonical 原厂为 zhipuai，models.dev 存在 provider zhipuai 与 zai，modelparams.dev 存在 provider z-ai
- **THEN** 默认链编译为 `models.dev/zhipuai/api_key/glm-5.1`、`models.dev/zai/api_key/glm-5.1`、`modelparams.dev/z-ai/api_key/glm-5.1`（各条目仅在该表含此模型时保留）

#### Scenario: 同组原厂不算冲突
- **WHEN** 同一查询 ID 的 canonical 原厂分别为 zhipuai 与 zai
- **THEN** 原厂解析成功，不报告冲突

#### Scenario: 找不到原厂时跳过
- **WHEN** 查询 ID 在 models.dev 没有任何带 canonical 的记录
- **THEN** `@creator` 条目标记 unresolved 并跳过，目录正常发布

#### Scenario: 原厂冲突阻止发布
- **WHEN** 查询 ID 的 canonical 原厂为不同组的 vendor-a 与 vendor-b，且该模型生效链含 `@creator`
- **THEN** 报告配置错误，列出模型 ID 与两个原厂，保留此前已验证目录

#### Scenario: 显式 provider 可消除冲突
- **WHEN** 上一场景中用户为该模型添加 `chain: ["models.dev/vendor-a/api_key"]`
- **THEN** 不再报错，模型按该具体条目解析

### Requirement: 查询 ID 归一化

`@id` SHALL 取公开模型 ID 最后一个 `/` 之后的部分作为基准查询 ID，并按内置固定顺序生成归一化候选（至少包含：原样、大小写折叠、`.` 与 `-` 互换、去除日期后缀）。每个候选 SHALL 只与来源记录的模型 ID 精确比较；在同一具体来源表中 SHALL 采用最先命中的候选。归一化规则 SHALL NOT 由用户配置。

#### Scenario: 点号写法命中横线记录
- **WHEN** 公开 ID 为 `proxy/claude-sonnet-4.5`，anthropic 表只有 `claude-sonnet-4-5`
- **THEN** 编译条目为 `models.dev/anthropic/api_key/claude-sonnet-4-5`

#### Scenario: 原样命中优先于归一化
- **WHEN** 来源表同时有 `Model-X` 与 `model-x`，公开 ID 末段为 `Model-X`
- **THEN** 编译条目使用 `Model-X`

#### Scenario: 无法命中的别名回退上游
- **WHEN** 公开 ID 为网关自定义别名 `claude`，任何来源表都没有可命中的候选，且无规则指定字面查询 ID
- **THEN** 该模型不获得外部字段，使用上游值及默认值发布

### Requirement: 旧版配置字段报错

系统 SHALL 将 `source_priority`、`provider_prefix_map`、`lookup_ids`、`models_dev_subscription`、`channels`、`global_fallback` 以及 mapping 形式的 `models` 视为旧版字段。出现任一旧版字段时，系统 SHALL 报告配置错误，指出字段完整路径并给出对应的新写法提示，且 SHALL 禁止本次目录发布。

#### Scenario: 旧链字段给出迁移提示
- **WHEN** 配置根级包含 `source_priority: ["*/api_key"]`
- **THEN** 报告配置错误，提示改用 `chain` 与具体条目，保留此前已验证目录

#### Scenario: 旧 mapping 形式模型规则报错
- **WHEN** 配置 `models` 为 `{"*gpt*": {...}}` 形式
- **THEN** 报告配置错误，提示改为 `- match: "*gpt*"` 列表形式

### Requirement: 本地元数据包与内存释放

系统 SHALL 从已安装的 `@opencode-ai/models` 快照与 `modelparams` 包读取 models.dev 与 modelparams.dev 数据，SHALL NOT 为元数据发起网络请求。插件 SHALL NOT 对这两个包设置版本上限。编译完成后，系统 SHALL 释放完整外部数据，只保留编译结果与发布给 Pi 的模型表。编译结果 SHALL 记录两个数据包的版本与 models.dev 快照生成时间。

#### Scenario: 富化不联网
- **WHEN** 上游目录刷新成功并执行默认链编译
- **THEN** 除上游 `/models` 请求外，不产生 models.dev 或 modelparams.dev 网络请求

#### Scenario: 编译后不常驻完整数据
- **WHEN** 一次富化完成
- **THEN** 插件进程不再持有完整 models.dev 快照或 modelparams 目录数据

#### Scenario: 编译结果标明数据版本
- **WHEN** 查看编译结果
- **THEN** 结果包含两个数据包的版本号与 models.dev 快照生成时间

### Requirement: 元数据提示不作为错误显示

富化过程产生的非错误提示（被忽略字段、站点降级、unresolved 条目汇总）SHALL 以普通提示形式呈现，SHALL NOT 使用错误样式的会话条目。配置错误与上游目录失败 SHALL 仍按错误呈现。

#### Scenario: 降级提示非错误样式
- **WHEN** 某站点数据包不可用导致降级
- **THEN** 用户看到普通提示，而不是红色错误条目

## REMOVED Requirements

### Requirement: 模型规则支持完整 ID 字符串 glob
**Reason**: 精确键优先、首条 glob 胜出且不叠加以及渠道内匹配被有序层叠规则取代。
**Migration**: 将 `models` 改为 `- match: <glob>` 列表；所有命中规则按顺序逐字段叠加，后者覆盖前者。

### Requirement: 三级合并模式与显式人工覆盖
**Reason**: 默认模式改为外部覆盖，作用域简化为根级与有序规则，overrides 改为作用于 Pi 模型并采用 RFC 7396。
**Migration**: 需要保留网关值的模型用规则设置 `fill_missing_only: true`；overrides 字段改为 Pi 模型字段名（如 `contextWindow`）。

### Requirement: 生命周期与失败隔离
**Reason**: 外部数据改为本地包，原“外部来源失败/离线不查询来源”的网络语义不再适用，由“本地富化生命周期与降级”取代。
**Migration**: 无需配置。

### Requirement: 三级来源链继承兼容
**Reason**: 渠道作用域与 `global_fallback` 被有序模型规则列表与 `@default` 取代。
**Migration**: 用 `- match: "<渠道前缀>/*"` 规则表达渠道配置；需要在局部链后追加全局链时在 `chain` 中写 `@default`。

### Requirement: 用户可排序的来源选择器
**Reason**: 通配符 selector 是运行时歧义的来源，链条目改为不含通配符的具体语法。
**Migration**: 将 `*/api_key` 等写法改为 `models.dev/@creator/api_key`、`modelparams.dev/@creator/api_key` 等具体条目，顺序即优先级。

### Requirement: 访问类型分类政策
**Reason**: models.dev 没有访问类型字段，按 provider 命名推断订阅不可靠；models.dev 条目的 access 改为用户声明标签，modelparams.dev 仍按 `authType` 过滤。
**Migration**: 删除 `models_dev_subscription`；需要订阅数据时在规则 `chain` 中写出具体套餐 provider，如 `models.dev/zai-coding-plan/subscription`。

### Requirement: 来源选择不能伪造模型身份
**Reason**: `provider_prefix_map`、`lookup_ids`、渠道前缀剥离与站点组仲裁被 `@creator`、`@id` 与字面第 4 段取代；公开 ID 不变的约束由“上游目录控制模型成员”保留。
**Migration**: 用规则 `chain` 的字面第 4 段指定查询 ID；用 `@creator` 或字面 provider 指定来源 provider。

### Requirement: 外部来源请求保护
**Reason**: 外部元数据改为读取本地 npm 包，不再发起网络请求。
**Migration**: 无需配置；通过更新 `@opencode-ai/models` 与 `modelparams` 包获取新数据。
