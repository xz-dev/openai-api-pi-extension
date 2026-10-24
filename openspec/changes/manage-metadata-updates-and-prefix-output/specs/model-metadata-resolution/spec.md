## MODIFIED Requirements

### Requirement: 本地元数据包与内存释放

系统 SHALL 在现有 Worker 隔离边界内，从本次选定的本地数据包同时读取 models.dev 的 provider 记录与按 canonical ID 索引的统一模型资料，并读取 modelparams.dev 目录，SHALL NOT 为编译或推理发起元数据网络请求。数据包的独立版本检查与用户显式更新 SHALL 遵循 `metadata-package-updates` 的联网边界，不与编译隐式绑定。没有已激活的插件管理数据时 SHALL 继续使用插件已安装依赖；有有效活动代次时 SHALL 整组使用该代次。活动记录无效、越界或所指数据不完整时 SHALL 给出简短警告并整组回退原有依赖，SHALL NOT 加载越界路径或自动联网修复。

原厂自动 API 链 SHALL 优先采用该 canonical 的具体原厂 API 记录字段；缺失或无效字段 SHALL 由同一 canonical 的统一资料兜底，再继续后续用户来源。即使原厂 provider 表不存在对应条目，只要 canonical 唯一且统一资料有效，也 SHALL 能富化。系统 SHALL NOT 为解决缺失而借用转售商的限额。

用户显式来源／字面型号查询以及 subscription 条目 SHALL 保持显式查询约束，不自动加入通用 canonical API 兜底。某一数据形状缺失 SHALL 只降级依赖该形状的步骤，不能把仍可用的另一形状整体判为不可用。数据包版本无新增上限，编译完成后完整外部数据 SHALL 被释放，只保留固定编译结果与发布模型表。结果 SHALL 记录本次实际读取的数据版本及快照生成时间；同次编译 SHALL 使用一致的数据代次，SHALL NOT 因模块缓存而把旧版本号附在新数据上。

#### Scenario: 富化不联网
- **WHEN** 上游目录刷新成功并执行默认链编译
- **THEN** 编译本身除先前上游 `/models` 外不增加网络请求，也不在 Worker 内检查或下载数据包

#### Scenario: 编译后不常驻完整数据
- **WHEN** 一次富化完成
- **THEN** 主进程不持有完整 provider/canonical 快照或 modelparams 目录，Worker 结束

#### Scenario: 编译结果标明数据版本
- **WHEN** 查看编译结果
- **THEN** 包含两个实际读取的数据包版本号与 models.dev 快照生成时间

#### Scenario: 原厂 API 条目缺失但 canonical 资料存在
- **WHEN** 原厂表没有 `gpt-5-codex`，统一资料有 `openai/gpt-5-codex` 的 400000/128000
- **THEN** 默认自动 API 链可采用这两个限额，字段来源标为统一 canonical 资料

#### Scenario: 原厂实际限额优先于通用资料
- **WHEN** 原厂具体记录给出 context 200000、统一 canonical 资料给出 1000000
- **THEN** 该自动来源采用 200000，不被同来源的通用兜底覆盖

#### Scenario: 缺少 providers 时仍可使用 canonical 资料
- **WHEN** 快照仅有合法统一 canonical 资料，且默认查询能唯一定位该模型
- **THEN** 仍能富化并报告 provider 数据形状降级，不拒绝整个站点

#### Scenario: 更新在下一次编译生效
- **WHEN** 插件激活已验证的新数据代次并在同进程再次编译
- **THEN** Worker 读取新代次路径，记录该代次版本；此前已启动的 Worker 仍读取自己的完整旧代次

#### Scenario: 无缓存保持兼容
- **WHEN** 用户尚未执行更新且没有活动代次
- **THEN** 原有已安装依赖继续提供数据，既有逐站点与逐形状降级语义保持不变

#### Scenario: 损坏活动记录不破坏目录
- **WHEN** 活动记录指向缺失目录、不完整两包数据或插件私有根以外的路径
- **THEN** 不读取越界内容，不自行联网；警告后整组回退原有依赖，并按既有语义处理仍不可用的站点

### Requirement: 元数据提示不作为错误显示

插件自有的面向用户输出 SHALL 统一以精确标识 `[openai-api-pi-extension]` 开头，每条消息只添加一次。此规则 SHALL 覆盖目录提示、警告、错误、登录输入提示与进度、连接信息、版本检查和更新结果、导出路径通知，以及独立诊断导出的首行；SHALL NOT 改写用户/模型内容、公开模型 ID、API payload、凭证值或 Pi 自身消息。多行消息 SHALL 在首行标明来源，不要求给每一条结构化数据行重复加前缀。

目录及更新诊断 SHALL 只作为运行时通知：交互模式复用 Pi 原生通知，按实际严重度使用 info/warning/error；无可用交互界面时只写 stderr，SHALL NOT 污染 CLI stdout。外部错误与子进程输出 SHALL 在统一输出边界脱敏、转义控制字符，不把包管理器原始输出直接透传到终端。系统 SHALL NOT 为这些诊断追加会话条目、注入对话或创建替代持久化日志。既有内存去重 SHALL 可保留，但诊断与去重状态 SHALL NOT 写入会话 JSONL。

非错误提示 SHALL NOT 使用错误样式；配置错误与上游失败仍 SHALL 明确可见，但不持久化。自动通知 SHALL 只提供简短分类汇总或数据包更新摘要；完整元数据候选与原因通过用户主动执行的编译结果导出查看。已存在的历史 JSONL SHALL NOT 被本变更自动修改或删除。此限制不改变正常对话持久化、Pi 模型目录缓存、插件数据包活动记录或用户主动生成的临时导出文件。

#### Scenario: 降级提示非错误样式
- **WHEN** 某站点数据不可用导致降级
- **THEN** 用户看到带插件前缀的临时普通或警告通知，而不是错误会话条目

#### Scenario: 通知不写会话 JSONL
- **WHEN** 后台刷新报告未匹配汇总或来源降级
- **THEN** 当次界面可见带前缀通知，但会话不新增插件 note/error 自定义条目

#### Scenario: 配置错误也不持久化
- **WHEN** 后台刷新遇到非法配置
- **THEN** 产生带前缀的临时 error 通知并保留旧目录，不追加会话条目

#### Scenario: CLI 只在 stderr 提示
- **WHEN** 无交互界面的显式目录刷新产生诊断
- **THEN** 诊断仅出现在 stderr 且使用 `[openai-api-pi-extension]`，stdout 仍只有该 CLI 命令的正常结果

#### Scenario: 旧会话不自动清理
- **WHEN** 会话已经包含旧版插件写入的提示条目
- **THEN** 不重写或删除该 JSONL；新诊断不再追加同类条目

#### Scenario: 登录和命令也标明来源
- **WHEN** 用户登录、查看连接信息、检查更新或执行数据更新
- **THEN** 插件创建的输入提示、进度、结果及错误均以精确插件前缀开头；URL 或密钥输入值本身不添加前缀

#### Scenario: 去重与异常兜底不重复前缀
- **WHEN** 同一条已带前缀的消息进入统一输出或 UI 通知失败后转向 stderr
- **THEN** 最终消息仍只有一个精确前缀，重复 note 的既有去重行为保持有效

#### Scenario: 外部包管理器错误仍安全展示
- **WHEN** 子进程返回带认证信息或终端控制字符的错误文本
- **THEN** 仅展示脱敏和转义后的带前缀摘要，不泄露凭证，不透传原始 stdout/stderr
