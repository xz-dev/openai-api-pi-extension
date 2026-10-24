## Purpose

让用户通过插件自身检查并显式更新 models.dev 与 modelparams.dev 的本地 npm 数据包，不需要了解 Pi 的包安装位置或选择 npm/Bun。保持更新与推理、目录编译分离，并保证失败、取消或离线不会破坏原有可用数据和模型目录。

## ADDED Requirements

### Requirement: 插件专用版本检查

系统 SHALL 提供 `/provider-metadata check`，检查 `@opencode-ai/models` 与 `modelparams` 的实际生效版本及所选包管理器 registry 的 `latest` 稳定版本。有效的更高语义版本 SHALL 判定为可更新；相等或低于本地版本 SHALL NOT 判定为更新或触发降级。输出 SHALL 标明包名、本地版本、可用版本及状态；本地包缺失、版本未知、registry 不可达或响应无效 SHALL 与“已是最新”区分。命令 SHALL 不需要网关凭证，且 SHALL NOT 安装包、切换数据或发布模型目录。未知子命令或多余参数 SHALL 给出用法提示而非执行默认导出。

#### Scenario: 检查实际加载的数据版本
- **WHEN** 开发目录、插件随附依赖与插件已激活数据的版本不同，用户执行 `check`
- **THEN** 本地版本取插件实际生效的数据，忽略当前工作目录中的同名包，命令不产生安装或切换

#### Scenario: 更高版本提示插件更新入口
- **WHEN** 本地版本为 `0.0.113`，registry `latest` 为 `0.0.114`
- **THEN** 输出包名及两个版本，并提示 `/provider-metadata update`，不将 `pi install` 或 `pi update --extensions` 当作数据追新的保证

#### Scenario: 较新本地版本不降级
- **WHEN** 本地版本高于 registry `latest`
- **THEN** 显示无需更新，不降级，不报告有新版本

#### Scenario: registry 失败不冒充最新
- **WHEN** 一个包查询成功，另一个包超时、认证失败或响应无合法稳定版本
- **THEN** 命令展示两者各自状态，明确标记查询失败，不把失败项写为“已是最新”，不自动换源或绕过认证

#### Scenario: 无网关凭证仍可检查
- **WHEN** 未登录网关且用户执行 `check`
- **THEN** 只执行数据包版本检查，不请求网关 `/models`，不生成导出文件

### Requirement: 后台检查与离线约束

系统 SHALL 在交互界面就绪、允许联网且本插件模型目录成功发布后，以不阻塞当前操作的独立阶段每进程至多自动检查一次两个包的版本。只发现可用更新时 SHALL 发送一条简短通知，包含更新包及插件更新命令；检查失败 SHALL 静默结束，不影响目录发布或推理。离线模式 SHALL 跳过自动检查，并拒绝显式联网检查与更新，给出离线原因。插件加载、离线目录恢复、普通元数据编译与推理请求 SHALL NOT 触发 registry 查询。自动检查 SHALL 有有限超时，且 SHALL NOT 下载或安装包、持久化诊断或新增检查时间缓存。

#### Scenario: 后台检查不拖慢刷新
- **WHEN** 首次符合条件的交互式目录刷新已发布，但 registry 查询缓慢
- **THEN** 目录正常可用，推理不等待查询；本进程后续刷新不重复安排自动检查

#### Scenario: 最新或查询失败不打扰
- **WHEN** 自动检查没有发现更新，或 registry 查询失败
- **THEN** 不增加通知或会话条目，保留正常目录与推理行为

#### Scenario: 离线不被显式命令绕过
- **WHEN** Pi 处于离线模式，用户执行 `check` 或 `update`
- **THEN** 输出带插件前缀的离线提示，不启动联网子进程或请求

### Requirement: 自主选择包管理器且限制更新对象

系统 SHALL 由插件内部选择和调用包管理器，尊重有效的 Pi `npmCommand` 配置；未配置时，已确认的 xz-dev Bun 编译发行版 SHALL 可使用自身内置 Bun，其余受支持的普通 Node.js/源码安装 SHALL 默认使用 npm。系统 SHALL NOT 仅因 PATH 中存在 Bun、存在某种锁文件或当前运行于 Bun 就改变选择。无法确认命令兼容性或命令不可用时 SHALL 明确报告，不安装系统工具或擅自换用其他管理器。显式兼容的 npm、Bun 或 pnpm 配置 SHALL 使用对应参数，歧义配置 SHALL 被拒绝。

更新对象 SHALL 固定为 `@opencode-ai/models` 与 `modelparams`，不接受用户输入任意包名、版本、安装路径或 shell 片段。系统 SHALL 在插件私有目录操作并遵循所选管理器的 registry 配置，SHALL NOT 修改 Pi 共享依赖树、插件源码、用户包管理器设置或执行包生命周期脚本。系统 SHALL NOT 将网关凭证作为 registry 请求凭证、参数或通知内容。

#### Scenario: 无外部 Bun 也能在 standalone 更新
- **WHEN** 使用已确认的 xz-dev Bun 编译发行版且没有配置 `npmCommand`，PATH 中没有 npm/Bun
- **THEN** 插件能够使用内置 Bun，用户只需执行插件更新命令

#### Scenario: 源码运行于 Bun 不误判 standalone
- **WHEN** Pi 由 Bun 运行源码且没有显式包管理器配置
- **THEN** 不将其误判为编译发行版，仍按普通安装默认选择 npm

#### Scenario: 自定义命令与错误不可被绕过
- **WHEN** 用户配置了兼容命令前缀、配置含歧义，或管理器报告认证失败
- **THEN** 有效配置按参数数组执行；歧义或认证失败被明确报告，不通过 shell 拼接、换源或替代管理器绕过

#### Scenario: 仅更新插件私有数据
- **WHEN** 插件通过 Pi 的 npm 或 Git 安装且用户执行 `update`
- **THEN** 更新只写插件私有数据目录，不改宿主 npm manifest、原有依赖目录、插件 Git 工作树或其他扩展包

### Requirement: 显式更新与原子激活

系统 SHALL 提供 `/provider-metadata update`，仅由用户显式调用时执行安装。系统 SHALL 对两包完成版本查询，确定不低于当前有效版本的精确目标；任一目标无法安全确定时 SHALL 不开始激活。两包均无需更新且完整可用时 SHALL 直接报告无需更新；缺失包 SHALL 能由同一命令修复。

系统 SHALL 隔离安装并校验完整的新数据代次：包身份和实际版本符合目标、数据模块可加载、models.dev 至少有可用 provider 或 canonical 数据形状、modelparams 有合法目录。只有全部验证成功且操作未取消时 SHALL 一次激活整组数据；安装失败、超时、校验失败或取消 SHALL 保持此前激活数据与已发布目录。进行中的编译 SHALL 继续使用它开始时选定的完整数据代次，SHALL NOT 混用更新前后路径或版本。

并发更新 SHALL 被串行化或以忙碌提示拒绝，SHALL NOT 相互覆盖导致倒退。系统 SHALL 保留原有可用代次，不自动删除历史代次；进程中断后的未完成代次 SHALL NOT 在下次启动时自动激活。

#### Scenario: 一包更新成功另一包失败
- **WHEN** 新的 models.dev 包安装成功，但 modelparams 安装或数据校验失败
- **THEN** 两包均不激活，原有整组数据和已发布模型目录保持可用，明确报告失败

#### Scenario: 新代次无需两个包都升级
- **WHEN** 只有一个包有更新，另一个包的本地有效版本仍适用
- **THEN** 新代次包含该更新包与另一包的精确适用版本，验证成功后共同激活，不降级另一包

#### Scenario: 更新途中取消或进程退出
- **WHEN** 用户取消更新，或进程在新代次验证及激活完成前退出
- **THEN** 未完成代次不成为活动数据；下一次使用仍选择原有数据，不能报告更新成功

#### Scenario: 并发编译不混用版本
- **WHEN** 编译使用旧代次期间新代次被激活
- **THEN** 该编译仍使用完整旧代次；后续编译使用完整新代次，版本记录与读取内容一致

#### Scenario: 缺失包可以修复
- **WHEN** 本地一个数据包缺失，且 registry 与包管理器正常
- **THEN** `update` 安装并校验完整两包数据，激活后不再因该包缺失而降级

### Requirement: 生效验证与模型目录刷新

更新激活成功后，系统 SHALL 显示实际生效的包版本，并通过 Pi 的公开刷新入口仅刷新本插件模型目录；SHALL NOT 要求重启 Pi 或重新登录。成功刷新后，后续目录使用、`/provider-info` 与无参数 `/provider-metadata` SHALL 使用相同活动数据版本。未配置网关时 SHALL 保留已更新数据并说明目录将在登录或下次正常刷新时使用；网关、配置或取消导致刷新未完成时 SHALL 保留此前已发布目录，并区分“数据已更新”与“模型目录未刷新”，不误报安装失败或整体生效成功。

#### Scenario: 更新后无需重启
- **WHEN** 数据激活成功且网关刷新成功
- **THEN** 当前进程发布使用新元数据的目录，后续导出显示相同包版本，其他 provider 不被强制刷新

#### Scenario: 安装成功但网关失败
- **WHEN** 新数据已激活，而网关不可达或 YAML 配置无效
- **THEN** 保留新数据与原有已发布目录，通知分别说明数据更新成功和目录刷新失败，后续刷新可重试

#### Scenario: 未登录也能更新数据
- **WHEN** 用户未配置网关凭证但数据包更新成功
- **THEN** 明确报告数据包已更新与目录尚未刷新，不尝试无凭证访问网关，不要求重新执行数据安装
