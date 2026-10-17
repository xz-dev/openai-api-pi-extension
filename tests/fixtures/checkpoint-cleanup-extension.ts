import { cleanupSessionResources } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Loaded by the host alongside the provider: both resolve the same public SDK registry.
export default function (pi: ExtensionAPI) {
  pi.registerCommand("checkpoint-test-cleanup", {
    description: "Release this fixture's pooled session through the owning host SDK",
    handler: async (sessionId) => { cleanupSessionResources(sessionId); },
  });
}
