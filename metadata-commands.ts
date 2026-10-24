import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  BorderedLoader, getAgentDir, getPackageDir, SettingsManager,
  type ExtensionCommandContext, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  checkMetadataPackages, updateMetadataPackages, MANAGED_PACKAGES,
  type CheckResult, type HostRuntime, type MetadataPackagesDeps, type UpdateResult, UpdateBusyError,
} from "./metadata-packages.ts";
import { formatPluginOutput, notifyPlugin } from "./notification.ts";

const PROVIDER = "openai-api-extension";
const automaticKey = Symbol.for("openai-api-pi-extension.metadata-check");
const processState = globalThis as typeof globalThis & { [automaticKey]?: { started: boolean } };
const automaticState = processState[automaticKey] ??= { started: false };

type SettingsContext = Pick<ExtensionContext, "cwd" | "isProjectTrusted">;
export type MetadataCommandOptions = {
  getDeps?: (ctx: SettingsContext) => MetadataPackagesDeps;
  check?: typeof checkMetadataPackages;
  update?: typeof updateMetadataPackages;
  /** Independent state for isolated command tests; production is process-wide. */
  automaticState?: { started: boolean };
};

export function metadataOffline(): boolean {
  return ["1", "true", "yes"].includes((process.env.PI_OFFLINE ?? "").toLowerCase());
}

/** Host package identity is public; the extension's own URL is never Bun evidence. */
export function metadataHostRuntime(packageDir = getPackageDir()): HostRuntime {
  let distribution: unknown;
  try {
    distribution = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8")).piConfig?.distribution;
  } catch { /* no verified standalone identity */ }
  return {
    bunRuntime: Boolean(process.versions.bun),
    bunBinary: distribution === "xz-dev" && /\$bunfs|~BUN|%7EBUN/.test(packageDir),
    execPath: process.execPath,
  };
}

export function metadataPackageDeps(ctx: SettingsContext): MetadataPackagesDeps {
  const agentDir = getAgentDir();
  const settings = SettingsManager.create(ctx.cwd, agentDir, { projectTrusted: ctx.isProjectTrusted() });
  return { agentDir, npmCommand: settings.getNpmCommand(), hostRuntime: metadataHostRuntime(), offline: metadataOffline() };
}

function checkSummary(result: CheckResult): string {
  const lines = MANAGED_PACKAGES.map((name) => {
    const state = result.packages[name];
    const local = "localVersion" in state ? state.localVersion : undefined;
    const latest = "latest" in state ? state.latest : "unknown";
    return `${name}: ${local ?? (state.status === "missing" ? "missing" : "unknown")} -> ${latest} (${state.status})` +
      (state.status === "query-failed" ? `: ${state.reason}` : "");
  });
  if (result.updateAvailable || MANAGED_PACKAGES.some((name) => result.packages[name].status === "missing")) {
    lines.push("Run /provider-metadata update");
  }
  return lines.join("\n");
}

/** The native loader owns Escape; wait for operation cleanup before closing it. */
async function withProgress<T>(
  ctx: ExtensionCommandContext,
  title: string,
  lifecycle: AbortSignal,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const signals = [lifecycle, ...(ctx.signal ? [ctx.signal] : [])];
  if (ctx.hasUI && ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
    const outcome = await ctx.ui.custom<{ value: T } | { error: unknown }>((tui, theme, _keys, done) => {
      const loader = new BorderedLoader(tui, theme, formatPluginOutput(title));
      const signal = AbortSignal.any([...signals, loader.signal]);
      loader.onAbort = () => {}; // loader.signal aborts; do not close before children exit.
      Promise.resolve().then(() => operation(signal)).then(
        (value) => done({ value }), (error) => done({ error }),
      );
      return loader;
    });
    if ("error" in outcome) throw outcome.error;
    return outcome.value;
  }
  return operation(AbortSignal.any(signals));
}

export function createMetadataCommands(options: MetadataCommandOptions = {}) {
  const getDeps = options.getDeps ?? metadataPackageDeps;
  const check = options.check ?? checkMetadataPackages;
  const update = options.update ?? updateMetadataPackages;
  const automatic = options.automaticState ?? automaticState;
  let lifecycle = new AbortController();
  let session: ExtensionContext | undefined;
  const pending = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): Promise<T> => {
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
    return operation;
  };

  return {
    setSession(ctx: ExtensionContext) {
      lifecycle.abort();
      lifecycle = new AbortController();
      session = ctx;
    },
    async shutdown() {
      lifecycle.abort();
      session = undefined;
      await Promise.allSettled([...pending]);
    },
    backgroundCheck() {
      const ctx = session;
      if (automatic.started || !ctx?.hasUI || ctx.mode !== "tui" || metadataOffline()) return;
      automatic.started = true;
      const owner = lifecycle;
      void track(Promise.resolve().then(async () => {
        const deps = getDeps(ctx);
        if (deps.offline || owner.signal.aborted) return;
        const result = await check(deps, owner.signal);
        if (!owner.signal.aborted && owner === lifecycle && result.updateAvailable) {
          notifyPlugin(ctx, `Metadata update available:\n${checkSummary(result)}`);
        }
      })).catch(() => { /* automatic checks never obstruct a published catalog */ });
    },
    /** False means the existing no-argument export should handle this command. */
    async handle(args: string, ctx: ExtensionCommandContext): Promise<boolean> {
      const subcommand = args.trim();
      if (!subcommand) return false;
      if (subcommand !== "check" && subcommand !== "update") {
        notifyPlugin(ctx, "Usage: /provider-metadata [check|update]", "warning");
        return true;
      }
      const owner = lifecycle;
      let activated: UpdateResult | undefined;
      const secrets: string[] = [];
      try {
        const deps = getDeps(ctx);
        if (metadataOffline() || deps.offline) {
          notifyPlugin(ctx, "Offline: metadata package checks and updates require network access.", "warning");
          return true;
        }
        if (subcommand === "check") {
          const result = await track(withProgress(ctx, "Checking metadata packages...", owner.signal,
            (signal) => check(deps, signal)));
          if (owner !== lifecycle || owner.signal.aborted) return true;
          const failed = MANAGED_PACKAGES.some((name) => result.packages[name].status === "query-failed");
          notifyPlugin(ctx, checkSummary(result), failed ? "warning" : "info");
          return true;
        }
        await track(withProgress(ctx, "Updating metadata packages (Escape cancels)...", owner.signal, async (signal) => {
          const result = await update(deps, signal);
          if (!result.activated) {
            if (!owner.signal.aborted) notifyPlugin(ctx, "Metadata data packages are already current.");
            return;
          }
          activated = result;
          const versions = `models.dev ${result.versions.modelsDev}, modelparams.dev ${result.versions.modelparams}`;
          const auth = await ctx.modelRegistry.getProviderAuth(PROVIDER);
          const apiKey = auth?.auth.apiKey;
          if (apiKey) secrets.push(apiKey);
          if (!apiKey || !auth?.auth.baseUrl) {
            if (!owner.signal.aborted) notifyPlugin(ctx,
              `Data packages updated (${versions}); model catalog will refresh after configuring the connection.`);
            return;
          }
          const refreshed = await ctx.modelRegistry.refresh({ providers: [PROVIDER], allowNetwork: true, force: true, signal });
          if (owner.signal.aborted) return;
          if (refreshed?.aborted || signal.aborted) {
            notifyPlugin(ctx, `Data packages updated (${versions}); model catalog refresh cancelled.`, "warning");
          } else if (!refreshed || refreshed.errors?.has(PROVIDER)) {
            const error = refreshed?.errors?.get(PROVIDER);
            notifyPlugin(ctx, `Data packages updated (${versions}); model catalog not refreshed: ${error?.message ?? "host did not confirm refresh"}`, "warning", secrets);
          } else {
            notifyPlugin(ctx, `Data packages updated (${versions}); model catalog refreshed.`);
          }
        }));
      } catch (error) {
        if (owner !== lifecycle || owner.signal.aborted) return true;
        const reason = error instanceof Error ? error.message : String(error);
        const cancelled = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
        const text = activated
          ? `Data packages updated; model catalog not refreshed: ${reason}`
          : cancelled ? `Metadata ${subcommand} cancelled: ${reason}` : `Metadata ${subcommand} failed: ${reason}`;
        notifyPlugin(ctx, text, activated || cancelled || error instanceof UpdateBusyError ? "warning" : "error", secrets);
      }
      return true;
    },
  };
}
