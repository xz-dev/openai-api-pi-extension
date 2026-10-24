## Why

当前实现把内部查询展开简化成少量字符串候选与 `firstHit()`，只保留 canonical 厂家而丢弃目标型号，同时未读取 SDK 的统一模型资料，导致已有可靠资料的模型漏匹配；运行时提示又通过会话条目持久化，污染 JSONL 历史。

## What Changes

- 查询仍只取公开 ID 最后一个 `/` 后的部分，但在编译期生成有边界的内部 regex，收集全部匹配的来源原始 ID；不修改公开 ID、请求型号或网关原始显示名，不向 Pi 新增模型。
- 使用完整 canonical 身份（厂家与型号）定位资料；原厂 API 记录缺少字段时，以同一 canonical 的 `snapshot.models` 资料兜底，不借用转售商的限额。
- 保留精确匹配优先、显式来源与字面第 4 段、来源顺序、有序模型规则、人工 overrides、原厂别名组及原生启动生命周期；不同 canonical 型号不能唯一裁定时保留诊断，不任意选取。
- 编译结果保留具体候选、canonical 与字段来源；最终链仍是固定字面 ID，不残留 regex。
- 提示区分“完全未匹配”和“已匹配但部分来源缺失”，不再把两者合并成一个 unresolved 数字。
- 目录提示、警告及错误改走 Pi 原生临时通知；无界面时只输出到 stderr，不再写会话 JSONL，也不另建持久化日志。
- `/provider-metadata` 仍只输出用户主动生成的私有临时文件路径，历史 JSONL 不自动清理。

## Capabilities

### New Capabilities

无。

### Modified Capabilities

- `model-metadata-resolution`：内部 regex 候选展开、完整 canonical 定位、统一模型资料兜底、原始显示保护、命中统计与临时通知。
- `metadata-compile-view`：导出全部候选、选取依据、canonical 与字段来源，保留路径输出及凭证保护。

## Impact

- `model-metadata.ts`：替换查询候选／首命中路径，扩展来源表与编译结果，保留来源合并规则。
- `metadata-compile-worker.mjs`：在现有 Worker 内同时读取 SDK 的 `providers` 与 `models`；完整数据仍随 Worker 结束释放。
- `index.ts`：保护上游显示名，替换持久化报告入口，接入分类统计；不改推理协议与宿主启动机制。
- `metadata-view.ts`、README 与相关单元、Worker、注册命令及真实宿主测试。
- 无新增依赖、无新 YAML 配置项、无 Pi 宿主修改。
