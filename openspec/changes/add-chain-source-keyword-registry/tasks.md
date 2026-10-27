## 1. 基线

- [x] 1.1 归档已完成的 `allow-optional-model-id-separators` 与 `manage-metadata-updates-and-prefix-output`；验证：`openspec list` 不再列出二者，`openspec validate add-chain-source-keyword-registry --strict` 通过
- [x] 1.2 记录当前 `npm run check` 结果作为回归基线；验证：全部测试通过并记录测试数（基线：需设 `PI_REQUEST_COMPRESSION_HELPER` 指向宿主源码；662 tests，655 pass，0 fail）

## 2. 标准 glob

- [x] 2.1 在 `model-metadata.ts` 中用基于 minimatch（`nonegate`、`nocomment`、`dot`）的 `compileModelPattern` 替换 `matchModelPattern`，并同步 `metadata-compile.ts` 的 `effectiveChainFor`；验证：`grep matchModelPattern` 无残留
- [x] 2.2 改写 `tests/model-metadata.test.ts` 中旧的 `*` 跨 `/` 断言，补齐 spec "有序模型规则层叠" 的全部场景（单星号、双星号、单段前缀、大小写、`!`/`#` 字面）；验证：`npm test` 通过

## 3. include_models

- [x] 3.1 在 `metadata-config.ts` 中校验 `include_models`（缺省、空列表、非字符串、空串、只有 `!`），错误路径为 `include_models[i]`；验证：新增配置单测覆盖每种错误
- [x] 3.2 实现 `selectModels`（最后命中生效、无命中隐藏，返回 kept 与 hidden 规则序号）；验证：单测覆盖 spec "include_models 模型选择" 的各场景
- [x] 3.3 在 `index.ts` 的目录刷新中先选择再编译；命中统计只统计 kept；全部隐藏时发布空目录并发警告；验证：生命周期测试断言隐藏模型不进入 Worker 的 publicIds，且不读取其上游行
- [x] 3.4 在 `metadata-view.ts` 的导出中加入隐藏列表与保留/隐藏计数；验证：tmpfile 测试覆盖 spec `metadata-compile-view` 的三个场景

## 4. 记录来源注册

- [x] 4.1 把 `UpstreamChainEntry` 改为 `{kind: "record", keyword}`；`parseChainEntry` 按注册集合解析，未注册的 `@` 条目报配置错误并列出可用关键词；注册保留字或非法名称时抛宿主错误；验证：单测覆盖 `@cpa-upstream`、`@selfie`、保留字注册
- [x] 4.2 `resolveChainFields`/`makeResolver` 改为按关键词调用提供者表（每模型每关键词懒计算一次）；Pi 插件注册 `@self`；验证：现有 `@self` 测试不改断言即通过，新增 `@probe` 测试宿主场景通过
- [x] 4.3 命中统计与编译导出把所有记录来源按 `@self` 规则处理（节点标注关键词）；验证：统计与导出测试覆盖含 `@probe` 的链

## 5. 宿主中立入口

- [x] 5.1 把 Worker 中的逐形状校验拆为 `buildSourceTables`，Worker 主体改为静态导入的导出函数，删除 `compileModulePath` 动态导入；验证：Worker 测试（含 `modelsDevSnapshotOverride` 形状降级）通过
- [x] 5.2 新增 `metadata-core.ts`（配置解析，其中包含接受已解析值、路径前缀与 `recordSources` 的入口；`selectModels`、注册、`runCompileWorker`、解析、`buildSourceTables`），`metadata-compile.ts` 只保留 Pi 适配并委托给它；把新模块加入 `package.json` 的 `files`；验证：`npm run check` 通过
- [x] 5.3 新增测试：从 `metadata-core.ts` 出发的静态导入图不含 `@earendil-works/*`；用 `tablesPath` 与 `@probe` 在不加载 Pi 的情况下完成编译；验证：测试通过
- [x] 5.4 新增等价测试：同一数据经 `buildSourceTables` 写成 JSON 后用 `tablesPath` 编译，与运行时加载编译结果一致；验证：测试通过

## 6. 文档与依赖自动化

- [x] 6.1 在 `docs/` 模型元数据专题写入 glob 语义与 `*`→`**` 迁移表、`include_models`（含 `*/**` 隐藏裸别名示例）、记录来源关键词说明；验证：README 链接与锚点有效，示例与 spec 一致
- [x] 6.2 新增 `.github/dependabot.yml`（`npm`，`directory: "/"`，每周）；验证：`uvx check-jsonschema --builtin-schema vendor.dependabot .github/dependabot.yml` 通过

## 7. 收尾验证

- [x] 7.1 运行 `npm run check` 与 `openspec validate add-chain-source-keyword-registry --strict`；验证：两者均通过
- [ ] 7.2 在 AI-gateway 侧用 submodule 指向该提交，用 esbuild 打包宿主中立入口与 worker；验证：打包成功且产物不含 Pi 包引用（与网关任务 2.x 联动）
