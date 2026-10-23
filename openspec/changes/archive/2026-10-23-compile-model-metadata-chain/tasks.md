## 1. 验证与依赖

- [x] 1.1 在 Bun 编译版 xz-dev Pi 与 Node 宿主中各做一次最小验证：扩展内 `node:worker_threads` Worker 动态导入 `@opencode-ai/models/snapshot` 与 `modelparams`、回传纯数据并 `terminate()`；记录两宿主结果与 terminate 前后 RSS，结论写入 design.md D7（不可用时按备选 B 更新设计后再继续）
- [x] 1.2 `package.json` 加入 `"@opencode-ai/models": "*"`、`"modelparams": "*"`，删除 `package-lock.json`，`.gitignore` 加入 `package-lock.json` 与 `bun.lock`；验证 `npm install` 后两个包可被导入。注：`minimatch` 仍被 `checkpoint-adapter.ts` 的 `responseCheckpointExclude` 模式使用（与本变更无关），故保留

## 2. 配置解析

- [x] 2.1 重写 `parseMetadataConfig`：根级 `chain`/`fill_missing_only`/`models`（列表，`match` 必填）、规则 `chain`/`fill_missing_only`/`overrides`；验证单元测试覆盖合法配置、非法类型、重复键、未知字段警告
- [x] 2.2 实现旧版字段检测（`source_priority`、`provider_prefix_map`、`lookup_ids`、`models_dev_subscription`、`channels`、`global_fallback`、mapping 形式 `models`），报错含完整路径与迁移提示；验证每个旧字段各有一个测试
- [x] 2.3 实现链条目解析 `<site>/<provider>/<access>[/<model_id>]` 与 `@creator`/`@id`/`@default`，拒绝任何 `*`；验证测试覆盖第 4 段含 `/`、非法 site/access、通配符拒绝
- [x] 2.4 实现 overrides 禁止字段校验（`id`、`provider`、`api`、`baseUrl`）；验证配置错误测试

## 3. 编译器

- [x] 3.1 实现规则层叠：按声明顺序收集全部命中规则，逐字段覆盖 `chain`/`fill_missing_only`，`overrides` 依次 RFC 7396 合并，`@default` 展开根链；验证 spec 中“后命中覆盖”“逐字段叠加”“精确模式无额外优先级”场景测试
- [x] 3.2 实现 `@id` 归一化候选（原样、小写、数字间 `.`→`-`、`-`→`.`、去日期后缀，去重保序）；验证候选顺序与“点号命中横线”“原样优先”测试
- [x] 3.3 实现内置有序厂商别名组与 `@creator` 解析（canonical 前缀、组归并、unresolved、冲突配置错误仅在生效链含 `@creator` 时触发）；验证 spec“别名组展开”“同组不冲突”“找不到跳过”“冲突阻止发布”“显式 provider 消除冲突”场景测试
- [x] 3.4 实现每站点展开：只保留命名空间中存在且含该模型的成员，modelparams 按 `authType === access` 过滤，models.dev access 仅作标签；输出具体条目列表与 unresolved 标记；验证 `claude-fable-5-1` 聚合 provider 变体回归测试（不再出现 ambiguity，取 anthropic 记录）
- [x] 3.5 编译结果附带数据包版本与 models.dev `generatedAt`；验证相同输入两次编译结果深相等

## 4. 数据加载与执行

- [x] 4.1 用 Worker 封装数据加载与编译，主线程只接收编译结果；包缺失或结构不符时该站点降级并产生提示；验证降级测试与“主线程未导入数据包”断言
- [x] 4.2 执行阶段按具体条目精确查表、字段取首个有效值，接入 `mergeMetadata`（默认 `fill_missing_only=false`）与 `mapModel`，随后应用 RFC 7396 overrides；验证 spec 合并模式与嵌套覆盖场景测试
- [x] 4.3 改造 `enrichCatalog`：删除 HTTP 来源读取，接入 Worker 编译；保留取消、离线恢复、配置错误不判为凭证失效的行为；验证生命周期测试与“富化不联网”测试
- [x] 4.4 删除 `metadata-sources.ts` 中的 HTTP 读取、16 MiB 上限、重定向保护及 `api.json`/`models.json` 合并逻辑，以及 `model-metadata.ts` 中 selector 仲裁、订阅命名规则、渠道、prefix map、lookup_ids 相关代码与测试；验证 `npm test` 通过且无残留引用

## 5. 提示与查看命令

- [x] 5.1 新增普通样式会话条目用于 notes，`onCatalogError` 只用于配置错误与上游失败；验证降级提示不再使用错误渲染器
- [x] 5.2 新增查看命令（暂定 `/provider-metadata`）：获取上游目录、调用同一编译入口、不发布；生成包含配置展开、数据版本、每模型规则/链/字段来源/unresolved/overrides 的文本；验证输出不含 API key 的测试
- [x] 5.3 临时文件：`mkdtemp(os.tmpdir()/openai-api-extension-metadata-<pid>-)`，目录 0700、文件 0600；命令返回后文件保留，由系统临时目录维护回收；验证文件模式与内容测试
- [x] 5.4 路径输出命令：`/provider-metadata` 编译目录、写临时文件、`ctx.ui.notify` 仅输出绝对路径并立即返回；无弹窗/剪贴板/关闭删除/启动清理；验证注册命令级测试（真实 handler + 隔离网关，断言 ui.custom 未调用、路径为通知唯一内容、文件存在且内容已编译并脱敏；配置错误产出诊断文件 + 警告通知）

## 6. 文档与集成验证

- [x] 6.1 重写 README Model metadata 章节：新配置结构、链语法、`@creator`/`@id`/`@default`、默认 `fill_missing_only: false` 的风险与示例、新旧字段对照、数据包更新命令；验证文中示例 YAML 可被解析器接受
- [x] 6.2 在隔离的 `PI_CODING_AGENT_DIR` 中以本地路径加载未提交的工作区（`pi -e <工作区>`，不为测试而提交），使用真实网关刷新目录，确认 `claude-fable-5-1` 获得 1M/128K、glm 系列经别名组命中、无 ambiguity 提示，并用查看命令核对编译结果

## 7. 启动生命周期（复用 Pi 原生路径）

- [x] 7.1 移除扩展工厂中的 env 预取（`/models` 请求与元数据 Worker 均不在加载阶段启动），provider 以空初始目录注册；回归测试断言 env 凭证下加载零请求、零 Worker
- [x] 7.2 真实宿主验收（隔离 `PI_CODING_AGENT_DIR`、本地回路网关）：冷启动普通 `--list-models` 零 GET；`--refresh --list-models` 发起 GET 并发布编译目录、写入持久化缓存；再次普通 `--list-models` 零 GET 且列出模型；有缓存 + 慢速 `/models` 时交互界面先于响应就绪，后台刷新随后成功（2026-10-23：冷 CLI 302ms/0 GET；显式刷新 384ms/1 GET；暖 CLI 259ms/0 GET；tmux TUI 313ms 就绪、慢响应 3244ms 完成；证据 `/var/tmp/oapi-startup-final-pemnxo/results.json`）
