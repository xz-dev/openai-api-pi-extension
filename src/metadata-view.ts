/**
 * Renders the compiled catalog as text for the /provider-metadata command:
 * expanded effective config, data versions, and for every public model the
 * matched rules, concrete chain entries with the fields each supplies,
 * unresolved entries, and the final overrides patch. Never prints the API
 * key — callers pass only compiled data and config, not credentials.
 */
import { classifyModelMatch } from "./model-metadata.ts";
import type { CompiledCatalog, CompiledModel, MetadataFields, ModelSelection } from "./model-metadata.ts";
import { formatPluginOutput } from "./notification.ts";
export { sanitizeTerminalText } from "./notification.ts";

/**
 * Credential keys redacted wherever they appear; every value under a
 * `headers` object is also redacted — auth headers carry custom names.
 * `maxTokens` and other model params must stay visible, so no bare
 * `token`/`key` substring matching.
 */
const SECRET_KEYS = new Set([
  "authorization", "cookie", "set-cookie", "api_key", "apikey", "api-key",
  "x-api-key", "password", "secret", "access_token", "refresh_token", "bearer",
]);
const REDACTED = "[REDACTED]";

function redact(value: unknown, insideHeaders = false): unknown {
  if (Array.isArray(value)) return value.map((item) => redact(item, insideHeaders));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const lower = key.toLowerCase();
      if (insideHeaders || SECRET_KEYS.has(lower)) {
        out[key] = REDACTED;
      } else if (lower === "headers" && item !== null && typeof item === "object") {
        out[key] = redact(item, true);
      } else {
        out[key] = redact(item, false);
      }
    }
    return out;
  }
  return insideHeaders ? REDACTED : value;
}
const redactJson = (value: unknown) => JSON.stringify(redact(value));

function formatEntryFields(model: CompiledModel, upstream?: Readonly<Record<string, MetadataFields>>): string[] {
  return model.plan.map((node) => {
    if (node.kind === "record") {
      // `@self` is the model's own upstream row: show the fields it CAN
      // provide at this position — never claimed to be the final values.
      if (node.keyword === "@self") {
        const keys = Object.keys(upstream?.[node.modelId] ?? {});
        return `    upstream ${node.modelId} -> ${keys.join(", ") || "(no capability fields)"}`;
      }
      // Other host-registered sources are labeled by name; their rows are host data.
      return `    record:${node.keyword.slice(1)} ${node.modelId} -> (record source fields)`;
    }
    const entry = node.entry;
    const fields = Object.entries(entry.fields).map(([key]) => {
      const source = entry.fieldSources?.[key];
      // undefined = a provider record; unified fills are marked "canonical".
      return source === "canonical" ? `${key}[canonical]` : key;
    });
    return `    ${entry.entry} -> ${fields.join(", ") || "(no fields)"}`;
  });
}

function formatCandidates(model: CompiledModel): string[] {
  if (model.candidates.length === 0) return [];
  const lines = ["  candidates:"];
  for (const candidate of model.candidates) {
    const status = candidate.selected ? "selected" : "skipped";
    const canonical = candidate.canonical ? ` canonical:${candidate.canonical}` : "";
    const kind = candidate.kind === "provider" ? "" : ` kind:${candidate.kind}`;
    const sourceKey = candidate.sourceKey === candidate.sourceId ? "" : ` key:${candidate.sourceKey}`;
    const reason = candidate.reason ? ` (${candidate.reason})` : "";
    lines.push(
      `    ${candidate.site}/${candidate.provider}/${candidate.access}/${candidate.sourceId} ` +
        `[level ${candidate.level}]${kind}${sourceKey} ${status}${canonical}${reason}`,
    );
  }
  return lines;
}

function formatSelection(selection: ModelSelection): string[] {
  const lines = ["== include_models =="];
  lines.push(`kept ${selection.kept.length}  hidden ${selection.hidden.length}`);
  if (selection.hidden.length > 0) {
    lines.push("hidden (not compiled):");
    for (const item of selection.hidden) {
      const reason = item.ruleIndex === null
        ? "无规则命中 (no include rule matched)"
        : `include_models[${item.ruleIndex}] ${item.pattern}`;
      lines.push(`  ${item.id}  ${reason}`);
    }
  }
  lines.push("");
  return lines;
}

/**
 * `selection` is passed only when `include_models` is configured; hidden
 * models are listed with the deciding entry and never shown as compiled.
 */
export function renderCompiledCatalog(
  compiled: CompiledCatalog,
  upstream?: Readonly<Record<string, MetadataFields>>,
  selection?: ModelSelection,
): string {
  const lines: string[] = [];
  lines.push("== effective config ==");
  lines.push(`chain: ${JSON.stringify(compiled.config.rootChain)}`);
  if (compiled.config.rules.length > 0) {
    lines.push("rules:");
    compiled.config.rules.forEach((rule, index) => {
      lines.push(`  [${index + 1}] match: ${rule.match}`);
      if (rule.chain !== undefined) lines.push(`      chain: ${JSON.stringify(rule.chain)}`);
      if (rule.overrides !== undefined) lines.push(`      overrides: ${redactJson(rule.overrides)}`);
    });
  }
  lines.push("");
  lines.push("== data versions ==");
  if (compiled.sourceWarning) lines.push(`data fallback: ${compiled.sourceWarning}`);
  const v = compiled.dataVersions;
  lines.push(`models.dev: ${v.modelsDevVersion ?? "unavailable"}${v.modelsDevGeneratedAt ? ` (snapshot ${v.modelsDevGeneratedAt})` : ""}`);
  lines.push(`modelparams.dev: ${v.modelparamsVersion ?? "unavailable"}`);
  for (const item of compiled.degraded) lines.push(`degraded: ${item.site}: ${item.reason}`);
  if (compiled.warnings.length > 0) lines.push(`ignored fields: ${compiled.warnings.join(", ")}`);
  lines.push("");
  if (selection) lines.push(...formatSelection(selection));
  // Hit-classification summary: complete / partial-source-missing /
  // unmatched over enabled chains, with disabled models listed separately.
  const counts = { complete: 0, partial: 0, unmatched: 0, disabled: 0 };
  for (const model of compiled.models) counts[classifyModelMatch(model)] += 1;
  lines.push("== match summary ==");
  const enabled = counts.complete + counts.partial + counts.unmatched;
  lines.push(
    `complete ${counts.complete}  partial ${counts.partial}  unmatched ${counts.unmatched}` +
      `  (enabled ${enabled}, disabled ${counts.disabled})`,
  );
  lines.push("");
  lines.push("== models ==");
  for (const model of compiled.models) {
    lines.push(`${model.publicId}`);
    lines.push(`  rules: ${model.matchedRules.length > 0 ? model.matchedRules.map((n) => `[${n}]`).join(" ") : "(none)"}`);
    if (model.canonical) lines.push(`  canonical: ${model.canonical}`);
    if (model.plan.length === 0 && model.unresolved.length === 0) lines.push("    (no sources)");
    lines.push(...formatEntryFields(model, upstream));
    for (const miss of model.unresolved) lines.push(`    ${miss}  [unresolved]`);
    for (const skipped of model.skippedEntries ?? []) {
      lines.push(`    skipped: ${skipped.entry} (${skipped.reason})`);
    }
    lines.push(...formatCandidates(model));
    if (model.overridePatches.length > 0) lines.push(`  overrides: ${model.overridePatches.map(redactJson).join(" then ")}`);
  }
  return formatPluginOutput(lines.join("\n") + "\n");
}
