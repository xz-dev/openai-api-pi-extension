# openai-api-pi-extension

Minimal modern [Pi](https://pi.dev) provider extension for any
OpenAI-compatible gateway — [Sub2API](https://github.com/Wei-Shaw/sub2api),
CLIProxyAPI, LiteLLM, or the official OpenAI API — using the
**Responses API** over Pi's configured transport (`auto`, `sse`, `websocket`,
or `websocket-cached`).

## What it does

- Registers a complete Pi-native `openai-api-extension` provider. Pi owns
  credentials, model refresh, persistence, offline restore, cancellation, and
  request-time endpoint selection.
- Discovers models from `GET {baseUrl}/models` on Pi's provider refresh
  (`/login`, interactive background refresh, or `pi --refresh --list-models`).
  The gateway may expose its complete inventory; this extension registers only
  conversational text models, retaining image-input vision models.
- Optionally enriches capability metadata from public data packages
  ([models.dev](https://models.dev), [modelparams.dev](https://modelparams.dev))
  through an ordered, configurable source chain; the upstream catalog controls
  model membership and public IDs.
- Bridges Responses traffic to cached WebSocket transports with compression
  and checkpoint recovery.

## Host requirement

Requires xz-dev/pi **1.3.0-xz.328.1.g2e2d9ad8** or newer with the shared
transport-compression APIs. Update the host first; see
[compatible hosts and upgrade order](docs/request-compression.md#host-requirement).

## Install

```text
pi install git:github.com/xz-dev/openai-api-pi-extension
```

Or try it once without installing:

```text
pi -e git:github.com/xz-dev/openai-api-pi-extension --provider openai-api-extension --model <model-id>
```

## Use

```text
/login openai-api-extension
```

Prompts for the gateway base URL and API key, validates the pair, and stores
the credential. `/logout openai-api-extension` removes it. Environment
variables can supply or override both fields; see
[configuration](docs/configuration.md).

No discovery runs at startup: interactive sessions refresh in the background
and the persisted catalog restores offline. On a fresh install, run
`pi --refresh --list-models` once for the initial discovery.

## Documentation

- [Configuration](docs/configuration.md) — credentials, environment variables,
  first refresh, per-model overrides, `/provider-info`.
- [Model metadata](docs/model-metadata.md) — source chains and `@self`, rules,
  real default values, migration, `/provider-metadata` export, data packages.
- [Transports](docs/transports.md) — `sse`/`websocket`/`websocket-cached`/`auto`,
  recovery limits, wire credentials.
- [Request compression](docs/request-compression.md) — host requirement and
  compression policy.
- [Response checkpoints](docs/response-checkpoints.md) — storage, privacy and
  recovery limits.
- [Development](docs/development.md) — setup, verification commands, code map.

## License

MIT
