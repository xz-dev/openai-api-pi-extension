## ADDED Requirements

### Requirement: 导出标注被隐藏的模型

配置声明 `include_models` 时，`/provider-metadata` 生成的编译结果文件 SHALL 单独列出被隐藏的上游模型。每项列出原始公开模型 ID，以及决定隐藏的 `include_models` 条目路径（从 0 开始的序号，如 `include_models[1]`）与模式；未命中任何条目时标为"无规则命中"。被隐藏模型 SHALL NOT 展示来源链、候选或字段，因为它们未参与编译。汇总 SHALL 给出保留与隐藏的模型数。输出 SHALL 沿用既有脱敏与控制字符转义。

#### Scenario: 排除规则隐藏的模型
- **WHEN** `include_models: ["**", "!**/gpt-image-*"]`，上游有 `codex/gpt-image-1`
- **THEN** 导出文件的隐藏列表含 `codex/gpt-image-1`，标注 `include_models[1]` 与模式 `!**/gpt-image-*`
- **AND** 该模型不出现在编译模型列表中

#### Scenario: 无规则命中的模型
- **WHEN** `include_models: ["proxy/**"]`，上游有 `other/m`
- **THEN** 隐藏列表含 `other/m`，标为无规则命中

#### Scenario: 未配置时不输出隐藏列表
- **WHEN** 配置未声明 `include_models`
- **THEN** 导出文件不含隐藏模型列表，汇总不报告隐藏数
