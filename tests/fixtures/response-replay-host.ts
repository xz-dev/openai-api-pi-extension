import { openAIResponsesApi as actualApi } from "@earendil-works/pi-ai/compat";

type NativeApi = ReturnType<typeof actualApi>;
export const host = {
  capability: undefined as unknown,
  calls: [] as { method: "stream" | "streamSimple"; options: Parameters<NativeApi["stream"]>[2] & { responseReplay?: unknown } }[],
};

// Unit capability advertisement only; responses still use the installed host SDK. The host's own
// advertisement is dropped so `capability === undefined` models a stock host on native-replay hosts too.
export function openAIResponsesApi() {
  const { supportsBackgroundResponseReplay: _native, ...api } = actualApi() as NativeApi & { supportsBackgroundResponseReplay?: unknown };
  return {
    ...api,
    ...(host.capability === undefined ? {} : { supportsBackgroundResponseReplay: host.capability }),
    stream(...args: Parameters<NativeApi["stream"]>) {
      host.calls.push({ method: "stream", options: args[2] });
      return api.stream(...args);
    },
    streamSimple(...args: Parameters<NativeApi["streamSimple"]>) {
      host.calls.push({ method: "streamSimple", options: args[2] });
      return api.streamSimple(...args);
    },
  };
}
