## 1. 实现

- [x] 1.1 `index.ts` 的 `mapModel` 以链选出的 `name` 作为显示名，缺失时回退为公开 ID；验证：`tests/model-metadata.test.ts` 中“display name”场景通过
- [x] 1.2 规则 overrides 的 `name` 仍在链选择后生效；验证：测试“display name: explicit overrides still win over the chain”通过

## 2. 测试与文档

- [x] 2.1 新增外部来源在前改名、`@self` 在前保留网关名、严格链无名称回退为 ID 的测试，并改写 `tests/provider-lifecycle.test.ts` 中原“网关显示名不变”断言；验证：`PI_REQUEST_COMPRESSION_HELPER=… npm run check` 0 失败
- [x] 2.2 更新 `docs/model-metadata.md` 的显示名规则；验证：文档不再声称只有 overrides 可改名
- [x] 2.3 `openspec validate select-display-name-by-chain --strict` 通过
