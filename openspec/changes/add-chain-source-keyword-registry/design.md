## Context

现状（动机见 proposal.md）：
- `model-metadata.ts`：没有外部导入。`parseChainEntry` 把 `"@self"` 硬编码为 `{kind: "upstream"}`；`resolveChainFields(model, upstream)` 只认识这一种非外部节点。`matchModelPattern` 是自写的字面 `*` 匹配，`*` 跨越 `/`。
- `metadata-config.ts`：只依赖 `yaml`，本身已经宿主中立。
- `metadata-compile.ts`：导入 `getAgentDir` 与 `metadata-packages.ts`（后者依赖 Pi）来定位数据包；用 `metadata-compile-worker.mjs` 在 Worker 内加载数据包、构建 SourceTables 并调用 `compileCatalog`，只回传编译结果。`tablesPath` 目前只是测试通道。
- Worker 只收到配置与公开 ID 列表，不收上游行；`@self` 字段在主线程按上游行解析。这个分工正好适合函数型记录来源。
- 依赖中已有 `minimatch` 10.2.6。

## Goals / Non-Goals

**Goals:**
- 一个可被 esbuild 打包、没有 Pi 导入的编译核心，供 AI-gateway 通过 submodule 使用。
- 记录来源关键词的注册与解析不跨线程传递函数或上游行。
- `match` 与 `include_models` 共用一个标准 glob 匹配器。

**Non-Goals:**
- 网关专属后处理：static inherit、`metadata_from`、custom pools、Codex 输出格式。它们不进入本仓库。
- 变更数据包更新机制（`metadata-package-updates`）或数据包版本范围。
- 自动改写用户配置中的旧 glob。

## Decisions

### D1 记录来源：主线程函数，Worker 只见名称

宿主中立入口接收两样东西：
- 编译选项 `recordSources: readonly string[]`：交给 Worker 做配置校验与计划生成。
- 解析期提供者表 `Record<keyword, (publicId) => Readonly<Record<string, unknown>> | undefined>`：传给 `makeResolver`。

计划节点由 `{kind: "upstream"}` 改为 `{kind: "record", keyword}`。`resolveChainFields` 按 keyword 调用提供者，并对同一模型同一关键词懒计算一次 `normalizeFields`。Pi 插件的 `@self` 提供者从当前刷新得到的上游行映射中读取，不复制行对象。

- 备选方案：把上游行传入 Worker。放弃原因：要结构化克隆整份上游目录；函数不可跨线程；网关的 `@cpa-upstream` 响应还要按需拉取。
- 关键词格式 `^@[a-z0-9-]+$`；保留字 `@default`、`@creator`、`@id`。注册非法关键词时直接抛宿主错误，不归为配置错误。
- 错误信息列出已注册关键词，满足"未注册关键词报错"的场景。

### D2 标准 glob：minimatch 选项固定

`compileModelPattern(pattern)` 返回 `Minimatch` 实例，选项为 `{nonegate: true, nocomment: true, dot: true}`，其余用默认值：区分大小写，支持花括号与 extglob。`match` 与 `include_models` 都经过它。

- 配置解析阶段编译一次，用于校验。由于 `Minimatch` 实例经结构化克隆会丢失原型，Worker 内按字符串重新编译一次，并在本次编译内缓存。
- 删除 `matchModelPattern`，不保留兼容开关。
- 备选方案：自写 `*`/`**` 匹配器。放弃原因：标准语义细节多（字符类、花括号、转义），已有依赖可直接用。

### D3 `selectModels` 先于编译

`selectModels(config, publicIds)` 返回 `{kept, hidden: {id, ruleIndex | null, pattern?}[]}`。它属于宿主中立入口，规则是"最后命中生效、无命中即隐藏"。
- Pi 插件在调用编译前用 `kept` 作为 `publicIds`，因此被隐藏模型不进入 Worker，也不会读取其上游记录。
- `hidden` 交给导出视图与通知汇总。
- 网关会在 `kept` 之上再加入引用闭包（网关侧逻辑）；所以 `selectModels` 只做选择，不承担发布。
- 配置校验（空列表、空串、只有 `!`）放在 `metadata-config.ts`，与其他字段一致。

### D4 宿主中立入口与 Worker 主体

新增 `metadata-core.ts`，只重新导出与组合以下宿主中立能力：
- 来自 `metadata-config.ts`：配置解析。除现有的 YAML 文本入口外，新增接受"已解析的 YAML 值 + 错误路径前缀 + `recordSources`"的入口。网关把共享字段放在自己 YAML 的 `metadata:` 块里，错误路径显示为 `metadata.models[0].chain`。这样可以避免网关自有的 `channels` 字段撞上插件的旧版字段报错。
- 来自 `model-metadata.ts`：编译、解析与 `selectModels`。
- `buildSourceTables(modelsDevModule, modelparamsModule, versions)`：从 Worker 中拆出的逐形状校验逻辑。
- `runCompileWorker({workerFile, tablesPath | packagePaths, ...})`：从 `compileCatalogInWorker` 中去掉 `getAgentDir`、`selectDataSource` 后的部分。

Worker 主体改为一个导出函数模块，静态导入 `model-metadata.ts` 与 `buildSourceTables`：
- 插件的 `metadata-compile-worker.mjs` 只调用该函数。
- 网关为它单独打包一个 worker 入口。
- `compileModulePath` 动态导入随之删除；数据包仍按显式文件路径动态导入，以保留 Bun 宿主下的解析修复。

`metadata-compile.ts` 保留 Pi 适配：解析 agent 目录与数据源选择，然后委托给 `runCompileWorker`。

`tablesPath` 成为正式选项：JSON 中携带 `modelsDevVersion`、`modelparamsVersion`、`modelsDevGeneratedAt` 与 `degraded`，编译结果原样记录。

### D5 Dependabot

插件没有 CI 工作流，只配置 `npm`，每周检查。数据包使用 `*` 范围、由插件自身的更新命令管理，因此 Dependabot 实际只覆盖其余固定或区间依赖；不额外分组。

## Risks / Trade-offs

- [依赖旧 glob 的用户规则静默改变命中] → 在文档迁移节给出 `*` → `**` 改写表。当前作者配置没有 `match` 规则。这是标准语义修正，不做兼容开关。
- [include_models 写错导致全部隐藏] → 发布空目录并发出警告（spec 规定），导出文件列出每个隐藏原因。
- [记录来源泛化改动 `@self` 的输出] → 现有 `@self` 测试全部保留，作为回归基线；计划节点序列化格式变化只影响导出视图，需同步更新视图测试。
- [esbuild 打包 `.ts` 带扩展名导入] → 网关 CI 构建会实际打包 submodule；本仓库增加一个无 Pi 导入测试，防止 Pi 依赖回流。
- [两个已完成但未归档的变更修改同一能力] → 实施第一步先归档，让 MODIFIED 基线一致。

## Migration Plan

1. 归档已完成的两个变更，确认主规格为基线。
2. 依次落地 glob、`include_models`、记录来源、宿主中立入口，每步 `npm run check` 通过。
3. 文档写入迁移说明。发布后网关通过 submodule 固定到包含该提交的版本。
4. 回滚：回退插件版本即可。用户配置中的新 `include_models` 字段会在旧版本中被作为未知字段警告忽略。
