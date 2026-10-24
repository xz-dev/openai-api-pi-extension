## MODIFIED Requirements

### Requirement: 编译结果查看命令

系统 SHALL 继续提供 `/provider-metadata`，使用与目录刷新相同的配置与来源解析，生成私有临时文件并仅通知其绝对路径，SHALL NOT 发布模型目录、自动展示文件或写会话提示条目。文件 SHALL 包含生效配置、数据版本、快照时间、命中分类汇总，以及每个原始公开模型 ID 的命中规则、合并模式、字面候选集合、完整 canonical 身份、固定执行链、采用字段与来源、跳过／歧义原因和生效 overrides。

每个候选 SHALL 保留真实来源 ID、站点、provider、access、匹配层级和选用状态；来自统一 canonical 资料的字段 SHALL 与 provider 记录字段明确区分。即使多条候选未被选用，也 SHALL 能在文件中检查其身份和原因。执行链 SHALL 不包含待执行 regex、通配符或关键词；候选字符串 SHALL NOT 替换模型公开显示身份。输出 SHALL 继续脱敏凭证字段、认证头并转义外部控制字符。

#### Scenario: 展示每个模型的编译链
- **WHEN** 用户执行该命令，网关有模型 `gw/claude-fable-5-1`
- **THEN** 文件以原始公开 ID 标识该模型，列出具体来源条目及提供字段

#### Scenario: 标出 unresolved 条目
- **WHEN** 某模型的原厂或 canonical 型号无法确定
- **THEN** 文件标为 unresolved，列出具体原因；有候选时保留候选列表

#### Scenario: 配置错误时展示错误
- **WHEN** 配置存在旧版字段
- **THEN** 生成含错误路径与迁移提示的诊断文件，仅临时通知其路径，不发布目录或追加会话条目

#### Scenario: 不泄露凭证
- **WHEN** 用户执行该命令
- **THEN** 输出与临时文件不含 API key 或认证头秘密，外部控制字符不会成为终端控制序列

#### Scenario: 全部 regex 候选可核对
- **WHEN** 原始模型 `proxy/Claude Fable 5.1` 匹配多个来源原始 ID
- **THEN** 文件保留原始公开 ID 并列出所有字面候选及选择原因，不只显示首个命中

#### Scenario: canonical 兜底来源明确
- **WHEN** `openai/gpt-5-codex` 的限额来自统一模型资料而非具体原厂 provider 条目
- **THEN** 文件显示完整 canonical ID，且这些字段的来源标为统一 canonical 资料

#### Scenario: 路径通知不持久化
- **WHEN** 导出成功或生成配置错误诊断文件
- **THEN** 文件保持目录 0700／文件 0600 并在返回后保留，绝对路径仅走临时通知，无新会话 JSONL 条目
