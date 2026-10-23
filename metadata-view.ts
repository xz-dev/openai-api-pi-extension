/**
 * Renders the compiled catalog as text for the /provider-metadata command:
 * expanded effective config, data versions, and for every public model the
 * matched rules, concrete chain entries with the fields each supplies,
 * unresolved entries, and the final overrides patch. Never prints the API
 * key — callers pass only compiled data and config, not credentials.
 */
import type { CompiledCatalog, CompiledModel } from "./model-metadata.ts";

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

// External strings (model IDs, chain entries, reasons) can contain terminal
// control sequences; a Text renderer passes them through. Turn C0 (except
// "\n" — our own line breaks), DEL and C1 into visible escapes at the render
// boundary so a hostile gateway catalog cannot write OSC/CSI to the terminal.
export function sanitizeTerminalText(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (c) => {
    const code = c.charCodeAt(0);
    return `\\x${code.toString(16).padStart(2, "0")}`;
  });
}

function formatEntryFields(model: CompiledModel): string[] {
  return model.entries.map(
    (entry) => `    ${entry.entry} -> ${Object.keys(entry.fields).join(", ") || "(no fields)"}`,
  );
}

export function renderCompiledCatalog(compiled: CompiledCatalog): string {
  const lines: string[] = [];
  lines.push("== effective config ==");
  lines.push(`chain: ${JSON.stringify(compiled.config.rootChain)}`);
  lines.push(`fill_missing_only: ${compiled.config.fillMissingOnly}`);
  if (compiled.config.rules.length > 0) {
    lines.push("rules:");
    compiled.config.rules.forEach((rule, index) => {
      lines.push(`  [${index + 1}] match: ${rule.match}`);
      if (rule.chain !== undefined) lines.push(`      chain: ${JSON.stringify(rule.chain)}`);
      if (rule.fillMissingOnly !== undefined) lines.push(`      fill_missing_only: ${rule.fillMissingOnly}`);
      if (rule.overrides !== undefined) lines.push(`      overrides: ${redactJson(rule.overrides)}`);
    });
  }
  lines.push("");
  lines.push("== data versions ==");
  const v = compiled.dataVersions;
  lines.push(`models.dev: ${v.modelsDevVersion ?? "unavailable"}${v.modelsDevGeneratedAt ? ` (snapshot ${v.modelsDevGeneratedAt})` : ""}`);
  lines.push(`modelparams.dev: ${v.modelparamsVersion ?? "unavailable"}`);
  for (const item of compiled.degraded) lines.push(`degraded: ${item.site}: ${item.reason}`);
  if (compiled.warnings.length > 0) lines.push(`ignored fields: ${compiled.warnings.join(", ")}`);
  lines.push("");
  lines.push("== models ==");
  for (const model of compiled.models) {
    lines.push(`${model.publicId}`);
    lines.push(`  rules: ${model.matchedRules.length > 0 ? model.matchedRules.map((n) => `[${n}]`).join(" ") : "(none)"}  fill_missing_only: ${model.fillMissingOnly}`);
    if (model.entries.length === 0 && model.unresolved.length === 0) lines.push("    (no external chain)");
    lines.push(...formatEntryFields(model));
    for (const miss of model.unresolved) lines.push(`    ${miss}  [unresolved]`);
    if (model.overridePatches.length > 0) lines.push(`  overrides: ${model.overridePatches.map(redactJson).join(" then ")}`);
  }
  return sanitizeTerminalText(lines.join("\n") + "\n");
}
