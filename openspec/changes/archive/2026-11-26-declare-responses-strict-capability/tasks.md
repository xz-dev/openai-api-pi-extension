## 1. 模型映射与能力覆盖

- [x] 1.1 在 `tests/map-models.test.ts` 和目录富化测试中加入一个未列入任何规则的型号，分别检查直接映射和富化映射；先确认缺少 `compat.supportsStrictMode: true` 会使断言失败。
- [x] 1.2 在共享模型映射处声明默认能力，不改写传输层或工具 schema；运行映射测试，确认两条路径均通过，且规则将能力设为 `false` 后仍保留该值及其他 `compat` 字段。

## 2. 逐工具请求契约

- [x] 2.1 扩展 `tests/responses-contract.test.ts` 的本地请求捕获。在同一请求中声明普通搜索工具和具有严格兼容 schema、明确要求严格采样的分类工具；断言前者为 `strict:false` 且仅 `queries` 必填，后者为 `strict:true`。
- [x] 2.2 通过已有的模型覆盖链验证两个对照：规则设为 `false` 时普通工具请求中不存在 `strict` 键；Pi 的最终模型覆盖再设为 `true` 时普通工具恢复 `strict:false`。运行 `npm test` 和 `npm run check`，确认既有请求与模型行为不回归。

## 3. 兼容说明与发布验收

- [x] 3.1 更新 `docs/configuration.md`，说明能力声明与逐工具策略的区别、目录刷新方式及不兼容端点的规则覆盖示例。核对示例使用现有配置层级且无需修改生成的模型目录。
- [x] 3.2 在此前测试的同一真实端点、同一模型上，以合成输入指定调用严格分类工具；检查出站 `strict:true`、端点回显与枚举参数是否符合 schema。并列记录普通工具 `strict:false` 的对照结果，不保存凭据，不执行工具；未能确认显式 `true` 时保持发布验收未完成。

验收记录（2026-11-25 16:00 UTC，通过）：工作区插件向同一端点的 `gpt-6.2-sol` 发送普通 `search` 和严格 `classify`，具名选择后者。`zstd` 请求返回 HTTP 400（`invalid request JSON`）；Pi 使用同一凭据和 URL 重发未压缩 JSON，解压后的请求体逐字节哈希一致，返回 HTTP 200。服务端回显 `search.strict:false`，仅 `queries` 必填；`classify.strict:true`，`label` 必填且枚举为 `animal`、`plant`。实际返回 `classify({"label":"plant"})`，未执行工具。

首次验收探针曾在本地拦住未压缩回退；单独诊断请求的 HTTP 403 未归因，不作为严格模式能力的证据。
