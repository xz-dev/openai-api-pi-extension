## 1. 固定匹配验收

- [x] 1.1 在 `tests/model-metadata.test.ts` 替换 `separator runs are interchangeable, never removable` 与 `single boundary separators match, never delete` 的旧删除断言，增加空白、`_`、`.`、`-` 四类字符一换一/一换零矩阵、首尾删除及 `\s` 兼容样例；通过编译候选与字段断言验证，确认新行为测试在修改实现前失败。
- [x] 1.2 增加数量及位置约束：`a-b` 不命中 `a--b`/`a_.b`/`a  b`，`a--b` 命中 `ab`/`a_b`/`a_.b` 但不命中 `a---b`，`ab` 不命中 `a-b`，首尾同样禁止扩张；通过候选包含/排除断言验证，同时保留空/纯分隔符与非分隔符 regex 元字符的安全回归。

## 2. 修改共享查询构造

- [x] 2.1 修改 `model-metadata.ts` 的 `buildQueryRegex`，逐字符为每个分隔符生成一个可选字符类，保留字面转义、整串锚点、`i` 标志和空/纯分隔符保护；同步修正相邻注释，删除仅用于旧拆分逻辑且不再使用的代码；运行 `node --test tests/model-metadata.test.ts`，确认第 1 组验收通过，不新增依赖或导出 helper。
- [x] 2.2 补充通过 `compileCatalog` 覆盖 models.dev provider/canonical 与 modelparams 的组合回归：混合大小写及删除分隔符命中后，公开 ID、带命名空间的 `sourceId`、`sourceKey` 和最终链条目保持原始拼写；断言命中等级仍为字面 0、regex 1、日期回退 2，显式第 4 段大小写/分隔符差异仍不命中，来源枚举反转与既有 canonical 歧义处理不变；运行元数据测试验证共享路径一致。

## 3. 集成验证

- [x] 3.1 运行 `npm run check`，确认完整测试及入口语法检查通过；检查最终 diff 仅包含共享查询逻辑、对应注释与回归测试，不改模型公开 ID、配置、glob、依赖及无关模块。
