## Context

动机见 proposal.md - Why。现状要点：

- `model-metadata.ts` 负责 YAML 解析、规则选择、selector 解析、`resolveSelectorSite` 站点组仲裁与合并；`metadata-sources.ts` 通过 HTTP 读取 models.dev `api.json`/`models.json` 与 modelparams.dev `models.json`；`index.ts` 的 `enrichCatalog` 是登录、刷新与 `/provider-info` 的唯一富化入口，notes 经 `onCatalogError` 以错误条目渲染。
- 线上数据（2026-10-23 快照）：models.dev 230 provider / 8912 模型，其中 7571 条带 `canonical_model_id`；有 canonical 的 1988 个裸 ID 中原厂不明确的为 0；modelparams 490 条，`authType` 为真实字段，但多数记录不含上下文/输出上限，主要提供 effort 档位。
- models.dev 与 modelparams 的厂商命名不一致的原厂只有 zhipuai/zai↔z-ai、moonshotai↔moonshot、thinkingmachines↔thinking-machines；`amazon`↔`bedrock` 是转售关系，不是别名。
- `@opencode-ai/models` 每天自动发布（0.0.x），`/snapshot` 子路径导出 `providers`、`models`、`generatedAt`，`snapshot.js` 约 6.9 MB；`modelparams` 导出 `CATALOG`，发布频率低于其 API。
- xz-dev Pi 的 git 扩展安装/更新（`packages/coding-agent/src/core/package-manager.ts`）：仅当远端 HEAD 变化时执行 `git reset --hard` + `git clean -fdx` + 依赖安装；HEAD 未变时只修复缺失依赖，不重新解析版本。内嵌 Bun 执行 `install --omit=dev --omit=peer`。

## Goals / Non-Goals

**Goals:**
- 编译结果对相同输入完全确定，且能完整打印。
- 默认配置下不访问网络获取元数据，不让单个异常 provider 影响其他候选。
- 富化结束后不常驻完整外部数据。

**Non-Goals:**
- 不提供用户可配置的归一化规则或厂商别名组扩展。
- 不做内置查看器/弹窗：命令只产出临时文件路径，用户自行打开；不做“本地包 + 在线 API”混合来源。
- 不修复与本变更无关的既有问题（如官方 `pi-ai` 缺少 `createRequestCompressionFetch` 导致的 `npm run check` 失败）。

## Decisions

### D1 编译与执行分离
编译输入为（配置、上游目录、外部数据）；输出为每个公开 ID 一条记录：命中规则序号、生效 `fill_missing_only`、具体条目列表（含 unresolved 标记）、生效 overrides、数据版本。执行阶段只对具体条目做 `Map` 精确查找并按条目顺序取字段首个有效值，然后沿用现有 `mapModel` 补默认值，最后应用 overrides。
- 备选：保留运行时 selector 仲裁并修补聚合 provider 规则。否决：每类数据异常都需要新规则，且结果无法预先打印。

### D2 链条目语法
`<site>/<provider>/<access>[/<model_id>]`，按前三个 `/` 切分，第 4 段可含 `/`。关键词只有 `@creator`、`@id`（省略第 4 段的隐含值）、`@default`（整条）。任何段出现 `*` 即配置错误。models.dev 的 `access` 只作为标签保留在编译结果中，不做过滤；modelparams 按 `authType === access` 过滤。
- 备选：保留 `*` 并定义固定展开顺序。否决：provider 位 `*` 会展开为全部转售商，本质仍是猜测。

### D3 `@creator` 与别名组
- 对 `@id` 候选按顺序，在 models.dev 全部 provider 记录中找模型 ID（或其最后一段）精确等于候选且带 canonical 的记录，收集 canonical 前缀，先用别名组归并为组代表；第一个产生非空集合的候选决定结果。集合为空 → unresolved；集合大于 1 → 配置错误（仅当该模型生效链含 `@creator`）。
- 内置别名组为有序常量数组，组内顺序即展开优先级；展开时每个站点只保留命名空间中实际存在且含该模型的成员。
- 备选：用户可配置 canonical 映射表。否决：用户确认现有规则（字面 provider / 字面第 4 段）已覆盖。

### D4 `@id` 归一化候选
基准为公开 ID 最后一个 `/` 之后的部分，候选按固定顺序：原样 → 小写 → 数字间 `.` 改 `-` → 数字间 `-` 改 `.` → 去掉末尾 `-YYYYMMDD` 或 `-YYYY-MM-DD`。候选去重，每个只做精确比较，同一来源表取最先命中者。

### D5 配置结构
根级：`chain`、`fill_missing_only`、`models`（列表）。规则：`match`（必填）、`chain`、`fill_missing_only`、`overrides`。旧版字段列表及其迁移提示集中定义为常量，解析时在任何警告之前检测并报错。规则按声明顺序逐字段层叠：`chain` 与 `fill_missing_only` 后者覆盖；`overrides` 依次做 RFC 7396 合并后整体作用于最终 Pi Model。`@default` 展开为根级生效链（未配置时为内置默认链）。

### D6 overrides 作用层与 RFC 7396
overrides 在 `mapModel` 产出 Pi Model 之后应用，实现标准 JSON Merge Patch（`null` 删除、对象递归、数组/标量替换）。`id`、`provider`、`api`、`baseUrl` 在解析阶段校验为禁止字段。不再需要 `FIELD_ALIASES` 参与 overrides。

### D7 本地数据包与内存释放
- 在 `node:worker_threads` Worker 内动态导入 `@opencode-ai/models/snapshot` 与 `modelparams`，执行编译，只把编译结果（结构化克隆的纯数据）回传主线程，然后 `terminate()` Worker，使 6.9 MB 模块及其对象随 Worker 一起释放。主线程从不导入这两个包。
- Worker 中两个包分别加载，任一失败或结构不符（缺少 `providers` 对象或 `CATALOG` 数组）只将该站点标记为降级。
- Worker 内以包目录下的显式文件路径导入数据模块（`@opencode-ai/models/dist/snapshot.js`、`modelparams/dist/index.js`），而非裸包名子路径：Bun 编译版 Pi 的 Worker 中裸子路径导入不会解析扩展目录的 `node_modules`（实测报 `Cannot find module`），显式路径在两种宿主中都可用；包目录经 `require.resolve("<pkg>/package.json")` 定位，路径本身不做假设。
- Worker 只对生效链实际需要的站点加载数据包（`chain: []` 不读任何包）；索引按 provider→modelId 结构整表构建（`@creator` 与逐 provider 查找本身需要全量命名空间），但索引与快照同样随 Worker 释放。
- 备选 A：主线程动态 `import()` 后丢弃引用。否决：ESM 模块缓存不可卸载，数据常驻。备选 B：子进程。否决：需区分 Bun 编译宿主（`BUN_BE_BUN=1`）与 Node 宿主的启动方式，复杂度更高。
- Worker 可用性在 Bun 编译版 xz-dev Pi 与 Node 宿主中先做验证（任务 1.x）；若 Worker 在某宿主不可用，再评估备选 B，不改变 spec。

实测（2026-10-23）：

| 宿主 | Worker 建/回传/terminate | RSS 表现 |
|---|---|---|
| Node v26.12.0 | 正常；230 providers / 490 CATALOG 回传 | before 31MB → msg 98MB → terminate 69MB（gc 后 69MB） |
| Bun 编译版 xz-dev Pi `1.3.0-xz.357.1` | 正常；同左 | before 90MB → msg 186MB → terminate 176MB → gc 后 107MB |

结论：两种宿主都能跑 Worker；完整快照不常驻（Bun 下 gc 后回到 ~107MB）。裸包名子路径导入在 Bun 宿主中不可用时改用显式文件路径。

### D8 依赖与更新方式
`dependencies` 加入 `"@opencode-ai/models": "*"`、`"modelparams": "*"`；`minimatch` 保留（checkpoint-adapter.ts 仍使用）；从仓库删除 `package-lock.json` 并加入 `.gitignore`（同时忽略 `bun.lock`）。依据 Context 中的 Pi 更新行为：插件每次有新提交时，`pi update` 会清理工作区并重新解析 `"*"` 得到最新数据包；插件无新提交时，用户在扩展目录运行 `bun update @opencode-ai/models modelparams`（README 说明路径与命令）。

实测（2026-10-23，xz-dev Pi `1.3.0-xz.357.1`，隔离 `PI_CODING_AGENT_DIR`，本地 `git daemon` 提供测试仓库，依赖 `"modelparams": "*"`）：

| 场景 | 结果 |
|---|---|
| 首次 `pi install`，仓库无 lockfile | 装到最新 0.0.72，并在工作区生成未跟踪的 `bun.lock` |
| 手动降到 0.0.70，插件 HEAD 未变，`pi update --extensions` | 仍为 0.0.70 |
| 推送新提交后 `pi update --extensions` | 清理工作区并重装，升到 0.0.72 |
| 提交锁定 0.0.70 的 `package-lock.json` 后推送新提交，`pi update --extensions` | 仍为 0.0.70（Bun 迁移并遵守该 lockfile） |

结论与上述决定一致：仓库内的 `package-lock.json` 必须删除，否则 `"*"` 不会生效。

### D9 提示渲染
新增一个普通样式的会话条目类型用于 notes；`onCatalogError` 只用于配置错误与上游目录失败。

### D10 编译结果查看命令
命令读取当前凭证，获取上游目录（与 `/provider-info` 相同的网络行为），调用同一编译入口但不发布。输出写入 `mkdtemp(join(os.tmpdir(), "openai-api-extension-metadata-<pid>-"))` 下的文件（目录 0700、文件 0600），命令以 `ctx.ui.notify` 通知该文件的绝对路径并立即返回；文件保留，由系统临时目录维护回收。
- 曾有弹窗方案（`ctx.ui.custom` + `ScrollView`，vim 键位、`c` 复制路径、关闭删文件、启动时按 pid 清理遗留文件），用户在真实 tmux 中发现正文空白后否决，改为当前路径输出方案；宿主侧 overlay 与布局组件的接线兼容性问题不在本仓库修复范围内。

### D11 启动生命周期复用 Pi 原生路径
扩展工厂函数不做目录预取：env 凭证下同样不发起 `/models` 请求、不启动元数据 Worker，provider 以空初始目录注册。Pi 在 provider 注册完成后以 `allowNetwork: false` 恢复持久化目录（`agent-session-services.ts` 收敛刷新），交互模式在 TUI 就绪后由宿主自行后台刷新（`interactive-mode.ts`），CLI 经 `pi --refresh --list-models` 显式刷新。冷启动无缓存时普通 `--list-models` 对本 provider 返回空——用户已确认接受该行为。
- 实测动机：网关 `/models` 首字节 4.45–6.58s（偶发 13.7s），本地编译仅 0.14–0.29s；预取把全部启动路径（含 `--list-models`）阻塞在网关响应上。
- 备选 A：插件直读 `models-store.json` 做缓存优先。否决：复制宿主职责、引入凭证作用域错配风险；`initialModels` 参数保留给测试与调用方注入。备选 B：预取加 TTL。否决：过期时仍随机卡顿。
- 验收（2026-10-23，安装的 Bun 宿主 `1.3.0-xz.357.1`，隔离 agent 目录、loopback 两模型、假凭证、同一进程内管理测试服务器）：冷 CLI 302ms/0 GET，显式刷新 384ms/1 GET，暖 CLI 259ms/0 GET；缓存下 tmux 界面 313ms 就绪，原生后台请求 244ms 开始、慢网关响应 3244ms 完成。界面不等待目录响应，未设置 `PI_OFFLINE` 或修改宿主。计数与时序见 `/var/tmp/oapi-startup-final-pemnxo/results.json`。

## Risks / Trade-offs

- [数据包 0.0.x 不设版本上限，结构变更可能导致解析失败] → Worker 内做结构校验，失败只降级该站点并提示，不阻止目录发布。
- [删除 lockfile 后其他依赖（openai、ws、yaml）版本也不再锁定] → 这些依赖保留明确的版本范围；测试环境用 `npm install` 解析。
- [modelparams 包落后于其 API] → 接受；modelparams 主要补 effort 档位，models.dev 每日更新覆盖限额字段。
- [`fill_missing_only` 默认 false 可能用原厂上限覆盖网关的更严限制，导致请求超限] → README 明确说明，并示例用 `- match: "<网关前缀>/*"` 设置 `fill_missing_only: true` 或 overrides。
- [默认链不含 subscription，订阅套餐的特殊限额不会自动采用] → 用户可在规则中写出具体套餐条目。
- [Bun 编译宿主的 Worker 中裸包名导入无法解析扩展目录的 `node_modules`（已实测）] → Worker 导入图只允许相对路径、`node:` 内置模块与显式文件路径；YAML 解析移至主线程模块 `metadata-config.ts`；`tests/worker-import-graph.test.ts` 防回归。
- [`@creator` 冲突即阻止整个目录更新，影响面大] → 当前数据中冲突为 0；错误信息给出模型 ID、冲突原厂与修复写法。

## Migration Plan

1. 发布前在 README 写清新旧字段对照与迁移示例。
2. 用户升级后，若 YAML 含旧字段，刷新报配置错误并保留旧目录，按提示改写后重新刷新即可。
3. 回滚：回退到上一插件提交；旧版本仍读取原 YAML 结构。

## Open Questions

- 查看命令的最终名称（暂定 `/provider-metadata`），不影响行为与任务拆分。
- ~~启动预取移除后的冷启动行为~~：已决定——无缓存 CLI 用 `pi --refresh --list-models` 做首次发现（D11）。
