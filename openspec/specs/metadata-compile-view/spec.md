# metadata-compile-view Specification

## Purpose

让用户通过一个独立命令把插件编译出的完整结果导出为临时文件，便于排查元数据问题。文件包含具体来源链、字段来源与数据版本，命令只输出绝对路径，供用户自行打开和检查。

## Requirements

### Requirement: 编译结果查看命令

系统 SHALL 注册一个独立斜杠命令（暂定 `/provider-metadata`），执行时使用与目录刷新相同的配置、上游目录与外部数据版本生成编译结果，但 SHALL NOT 发布或持久化模型目录。输出 SHALL 包含：完整展开后的生效配置；数据包版本与快照生成时间；每个模型的公开 ID、命中规则序号与模式、生效 `fill_missing_only`、编译后的具体链条目及每个条目提供的字段、unresolved 条目、最终生效的 overrides。输出 SHALL NOT 包含 API key 或认证头。

#### Scenario: 展示每个模型的编译链
- **WHEN** 用户执行该命令，网关有模型 `gw/claude-fable-5-1`
- **THEN** 输出列出该模型的具体条目（如 `models.dev/anthropic/api_key/claude-fable-5-1`）及其提供的字段

#### Scenario: 标出 unresolved 条目
- **WHEN** 某模型的 `@creator` 找不到原厂
- **THEN** 输出在该模型下将对应条目标为 unresolved

#### Scenario: 配置错误时展示错误
- **WHEN** 配置存在旧版字段
- **THEN** 输出展示配置错误路径与迁移提示，不发布目录

#### Scenario: 不泄露凭证
- **WHEN** 用户执行该命令
- **THEN** 输出与临时文件不含 API key

### Requirement: 临时文件输出

命令 SHALL 将编译结果写入仅当前用户可访问的临时文件（目录 0700、文件 0600，位于 `os.tmpdir()` 下），并以通知形式输出该文件的绝对路径。文件 SHALL 在命令返回后保留，由系统临时目录维护回收；系统 SHALL NOT 在关闭、退出或启动时删除这些文件，也不提供剪贴板复制或内置查看界面。配置错误同样产出可读诊断文件并以警告通知其路径。

#### Scenario: 输出绝对路径
- **WHEN** 用户执行该命令且编译成功
- **THEN** 通知内容为该临时文件的绝对路径，文件保留

#### Scenario: 配置错误仍产出诊断文件
- **WHEN** 配置存在旧版字段
- **THEN** 通知以警告级别输出诊断文件路径，文件保留

#### Scenario: 无凭证时提示
- **WHEN** 网关未配置凭证
- **THEN** 命令提示未配置，不产生文件
