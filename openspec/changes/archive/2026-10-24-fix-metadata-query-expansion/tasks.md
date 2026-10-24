## 1. 查询展开与回归夹具

- [x] 1.1 在现有 metadata 测试中建立固定双站点夹具，包含分隔符／大小写别名、命名空间 ID、canonical 改名、统一资料独有型号、同原厂多型号与同级字段冲突；验证夹具无网关 URL/凭证，预期公开 ID／显示名和候选列表明确，不依赖在线目录总数
- [x] 1.2 替换 `idCandidates()`／`firstHit()` 的自动查询路径：字面优先、整串转义 regex 全量收集、低优先级日期回退、来源原始 ID 去重；验证 `Claude Fable 5.1` 同时收集多个来源字符串、渠道前缀不影响候选、输入 regex 字符不执行、字面第 4 段不展开、来源顺序交换不改变结果

## 2. 完整 canonical 与统一模型资料

- [x] 2.1 扩展 canonical 身份索引与解析，保留厂家和型号、原厂别名组、候选层级与冲突原因；验证 `deepseek-v4-flash-fast` 沿 canonical 命中真实原厂型号，不同原厂仍报配置错误，同原厂 preview/customtools 不混字段，显式来源能消歧
- [x] 2.2 接入统一 canonical 模型资料索引，只为自动 `@creator/api_key` 按“具体原厂字段优先、同 canonical 补缺”读取；验证原厂表缺失的 `gpt-5-codex` 仍得 400000/128000、具体限额不被通用值抬高、显式／subscription 来源不被自动兜底绕过、转售商限额不进入合并
- [x] 2.3 扩展现有 Worker 数据加载与回传以支持独立校验 providers/models 两种形状；验证真实 Worker 在任一种 shape 缺失时仍利用另一种、数据仍只在 Worker 加载、取消不发布、成功后 Worker 结束，原有导入图防回归与零元数据网络请求测试通过

## 3. 原始身份与可解释的固定结果

- [x] 3.1 在自动富化映射处保留上游显示名，继续最后应用用户 overrides／Pi modelOverrides；验证编译到 provider 注册与 loopback Responses 请求的公开 ID／请求 model 仍为原值，外部 name 不替换网关显示名，显式 name override 仍生效且无新增公开模型
- [x] 3.2 扩展编译结果与 `metadata-view.ts`，保留全部字面候选、canonical、选取／跳过原因和逐字段来源；验证候选不止首条、最终链无待执行 regex／关键词、统一资料来源可辨认、同级冲突继续后续来源、输出保持脱敏与控制字符转义；注册命令仍只通知 0600 临时文件绝对路径且不发布目录

## 4. 分类统计与非持久化通知

- [x] 4.1 替换单一 unresolved 汇总为完整命中／部分来源缺失／完全未命中，另列禁用外部链；验证有一站能力字段即不算完全失败、name-only 不算能力命中、分类互斥且总数守恒
- [x] 4.2 删除目录报告的 `appendEntry()` 和专用 note/error renderer，接入可用上下文的原生 `ui.notify`／无 UI 时 stderr，保留内存连续去重并清理关闭后的上下文引用；验证成功／降级／配置错误三类都不调用会话写入接口，不把提示注入对话，无替代日志存储
- [x] 4.3 补通知生命周期与模式测试：有 UI 使用原生 severity，无上下文或非 UI 时只写 stderr，空报告允许旧问题再次提示，取消／被替代刷新不提示陈旧结果；验证 stdout 不混诊断、secret 与控制字符经过处理、通知失败不遮蔽目录错误，原始模型缓存仍照常持久化

## 5. 实际入口验收与文档

- [x] 5.1 用安装的 Bun Pi、隔离 agent 目录和同进程管理的 loopback 网关做有超时的 tmux／CLI 验收：触发 regex 成功、部分缺失和配置错误；核对实际导出候选及公开身份，比较隔离会话 JSONL 确认无新增插件 note/error 条目，命令临时文件仍保留；同时验证暖缓存普通 CLI 零 GET、显式刷新联网，服务器与测试会话退出后均被关闭（2026-10-24 最终树证据 `/var/tmp/oapi-query-accept-BMhzlG/results.json`：真实会话 8 条记录、插件诊断 0 条；公开 ID／显示名／请求型号原样；Fable 1M/128K、统一资料 Codex 400K/128K、原厂精确 DeepSeek 1048576/393216；冷 CLI 417ms/0 GET、显式刷新 382ms/1 GET、暖 CLI 255ms/0 GET；导出退出后保留）
- [x] 5.2 用固定回放夹具做实现前后命中分类对照，记录完整／部分／无能力资料及歧义原因；可另以当前安装快照和本地目录做只读观察，记录包版本而不硬编码 273 等浮动阈值，确认所有可恢复样例得到有效能力字段而非仅名称
- [x] 5.3 更新 README 的内部查询、原始显示、canonical 兜底、分类统计、临时通知与主动导出说明；运行 `PI_REQUEST_COMPRESSION_HELPER=<更新宿主的 request-compression.ts> npm test`、`openspec validate fix-metadata-query-expansion --strict`、`git diff --check`，确认全量通过且不产生 lockfile或新增运行时依赖
