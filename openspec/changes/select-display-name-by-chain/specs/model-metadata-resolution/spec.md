## MODIFIED Requirements

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
