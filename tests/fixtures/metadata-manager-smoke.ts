// Test-only --help probe: no registry, installation, model request or session entry.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { metadataPackageDeps } from "../../src/metadata-commands.ts";
import { execFileRunner, selectPackageManager } from "../../src/metadata-packages.ts";
import { formatPluginOutput } from "../../src/notification.ts";

export default async function (_pi: ExtensionAPI) {
  const deps = metadataPackageDeps({ cwd: process.cwd(), isProjectTrusted: () => false });
  const manager = selectPackageManager(deps);
  const result = await execFileRunner({ command: manager.command,
    args: [...manager.prefixArgs, "--version"], cwd: process.cwd(),
    env: { ...process.env, ...manager.env }, timeoutMs: 10_000 });
  if (result.code !== 0) throw new Error("metadata manager version probe failed");
  console.error(formatPluginOutput(`manager-smoke ${JSON.stringify({
    kind: manager.kind, reason: manager.reason,
    bunRuntime: deps.hostRuntime.bunRuntime, bunBinary: deps.hostRuntime.bunBinary,
    version: result.stdout.trim().split("\n")[0],
  })}`));
}
