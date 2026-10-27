## Context

`index.ts` 中的 `mapModel` 用网关行设置显示名，忽略链解析出的 `name` 字段。AI-gateway 的 models-enricher 已经把链选中的 `name` 映射为 `display_name`。动机见 proposal.md。

## Goals / Non-Goals

**Goals:**
- 两个宿主使用同一规则：显示名取有效链顺序中第一个有效的 `name`。

**Non-Goals:**
- 不改变公开 ID。
- 不改变成员过滤。
- 不改变哪些来源提供 `name`；别名 `name` 和 `display_name` 保持不变。

## Decisions

- 复用现有的规范化 `name` 字段，不新增配置。
  - 未采用：为每条规则加“保留网关名”开关。把 `@self` 放在链首或使用规则 `overrides` 已能表达这一点。
- 严格链（不含 `@self`）中没有任何来源提供名称时，回退为公开 ID，与严格链中其他字段的行为一致。

## Risks / Trade-offs

- [默认链（外部来源在 `@self` 之前）下可见名称会变化。] → proposal 中标为 BREAKING，并在 `docs/model-metadata.md` 中说明。用户把 `@self` 放在链首即可保留网关名。
