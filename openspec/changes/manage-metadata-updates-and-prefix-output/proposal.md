## Why

插件的元数据提示缺少统一来源标识，用户难以判断消息来自哪个扩展。models.dev 与 modelparams.dev 使用已安装的 npm 数据包；重复 `pi install` 或更新插件本身不能保证已有数据依赖追新，用户需要由插件完成检查与显式更新，而不是辨别 npm/Bun 和安装目录。

## What Changes

- 将插件自有通知、警告、错误、登录提示与进度、命令结果及诊断导出的来源标识统一为精确前缀 `[openai-api-pi-extension]`；保留严重度、脱敏、控制字符转义以及 stdout/会话 JSONL 不受诊断污染的边界。
- 为现有 `/provider-metadata` 增加 `check`、`update` 子命令；无参数仍导出编译结果。检查展示两个数据包的实际生效版本与 registry `latest`；更新由用户显式触发，不自动安装。
- 在允许联网的交互式目录刷新成功后，后台每进程至多检查一次，仅发现可用更新时提示插件专用更新命令；离线跳过，失败不阻塞刷新或推理。
- 插件内部选择兼容的包管理器并操作插件专属数据目录。两包安装、形状和版本验证全部通过后原子切换；失败继续使用原有数据，不修改插件源码、Pi 共享依赖树或用户设置。
- 更新成功后定向刷新本插件模型目录；区分数据安装成功与网关/配置导致的目录刷新失败。后续编译、信息查询及导出共同使用已激活的数据版本。

## Capabilities

### New Capabilities

- `metadata-package-updates`: 两个元数据包的版本检查、插件专用显式更新、包管理器选择、隔离安装与原子激活、失败保护及更新后目录刷新。

### Modified Capabilities

- `model-metadata-resolution`: 统一插件运行时输出标识；编译支持读取插件管理的已激活本地数据，同时保持编译与推理不联网、Worker 隔离及现有降级语义。
- `metadata-compile-view`: 无参数命令保持私有临时文件导出；路径通知改为前缀加绝对路径，导出增加来源标识并准确记录生效数据版本，区分新增子命令。

## Impact

- 主要触及 `index.ts` 的诊断、登录、命令与目录刷新生命周期，`metadata-compile.ts` 的包解析和版本读取，`metadata-compile-worker.mjs` 的数据校验，以及 `metadata-view.ts` 的导出标识。
- 新增小型数据包管理模块及配套测试；扩展发布清单需包含新模块。版本合法性与优先级比较使用直接声明的 `semver` 依赖，不从未声明的传递依赖导入比较器。
- 在 `getAgentDir()` 下新增插件专属缓存；未激活插件管理的数据时仍使用现有已安装依赖，无迁移前置要求。
- 更新 `tests/provider-lifecycle.test.ts`、`tests/metadata-view-tmpfile.test.ts`、Worker 测试与 `README.md`；新增可注入 registry/子进程的更新测试，不要求真实网络或真实安装。
- 不修改 Pi 宿主、不发布插件自身更新、不全局安装包、不自动升级、不改 API 数据/模型身份、不清理历史会话或旧数据代次。首次更新需要可用 registry 与受支持的包管理器；离线或只读环境继续使用原有数据。
