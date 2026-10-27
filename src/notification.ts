/** Shared text boundary for plugin-owned diagnostics, never protocol payloads. */
export const OUTPUT_PREFIX = "[openai-api-pi-extension]";
export type NoticeLevel = "info" | "warning" | "error";
export type NoticeContext = {
  hasUI?: boolean;
  ui: { notify(message: string, type?: NoticeLevel): void };
};

export function sanitizeTerminalText(text: string): string {
  return text.replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, (character) =>
    `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
  );
}

export function formatPluginOutput(message: string, secrets: readonly string[] = []): string {
  let text = message;
  for (const secret of secrets.filter(Boolean)) text = text.split(secret).join("[REDACTED]");
  text = text
    .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [REDACTED]")
    .replace(/((?:^|[\s:"'{?&])_(?:authToken|auth|password)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[REDACTED]")
    .replace(/((?:^|[\s{"'?&])["']?(?:_authToken|authorization|api[_-]?key|access_token|refresh_token|password)["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^/\s@]+@/gi, "$1[REDACTED]@");
  text = sanitizeTerminalText(text);
  while (text.startsWith(OUTPUT_PREFIX)) {
    text = text.slice(OUTPUT_PREFIX.length).replace(/^ +/, "");
  }
  return `${OUTPUT_PREFIX} ${text}`;
}

export function notifyPlugin(
  context: NoticeContext | undefined,
  message: string,
  level: NoticeLevel = "info",
  secrets: readonly string[] = [],
): void {
  const text = formatPluginOutput(message, secrets);
  try {
    if (context && context.hasUI !== false) {
      context.ui.notify(text, level);
      return;
    }
  } catch {
    // A broken UI must not suppress the original diagnostic.
  }
  try { console.error(text); } catch { /* stderr itself is unavailable */ }
}
