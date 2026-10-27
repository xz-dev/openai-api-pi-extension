# openai-api-pi-extension

[Pi](https://pi.dev) provider extension for any OpenAI-compatible gateway
(Sub2API, CLIProxyAPI, LiteLLM, the official OpenAI API) over the
**Responses API**.

## What it does

- Adds the `openai-api-extension` provider; models come from the gateway's
  `GET {baseUrl}/models`.
- Optionally fills model metadata (context window, reasoning levels, display
  name, ...) from [models.dev](https://models.dev) and
  [modelparams.dev](https://modelparams.dev) through a configurable source chain.
- Streams over SSE or WebSocket (`auto`, `sse`, `websocket`, `websocket-cached`)
  with compression and checkpoint recovery.

## Install

Requires xz-dev/pi **1.3.0-xz.328.1.g2e2d9ad8** or newer
([details](docs/request-compression.md#host-requirement)).

```text
pi install git:github.com/xz-dev/openai-api-pi-extension
```

Try it once without installing:

```text
pi -e git:github.com/xz-dev/openai-api-pi-extension --provider openai-api-extension --model <model-id>
```

## Use

```text
/login openai-api-extension      # enter gateway base URL and API key
pi --refresh --list-models       # first model discovery on a fresh install
/provider-info                   # connection, transport and model count
/provider-metadata               # export the compiled metadata view
/provider-metadata check|update  # check or update the metadata data packages
```

Or configure with environment variables:

```bash
export OPENAI_API_EXTENSION_BASE_URL="https://your-gateway.example.com/v1"
export OPENAI_API_EXTENSION_API_KEY="sk-..."
```

Optional metadata config, `~/.pi/agent/openai-api-extension.yaml`:

```yaml
chain: ["models.dev/@creator/api_key", "modelparams.dev/@creator/api_key", "@self"]
include_models: ["**", "!**/gpt-image-*"]   # hide models by glob
models:
  - match: "gateway/**"
    chain: ["@self", "@default"]            # keep gateway values and name first
```

## Documentation

- [Configuration](docs/configuration.md): credentials, environment variables,
  first refresh, offline behavior, `/provider-info`.
- [Model metadata](docs/model-metadata.md): source chains, `@self`, display
  names, globs and `include_models`, defaults, migration, `/provider-metadata`.
- [Transports](docs/transports.md): transport modes, recovery limits, wire
  credentials.
- [Request compression](docs/request-compression.md): host requirement and
  compression policy.
- [Response checkpoints](docs/response-checkpoints.md): storage, privacy and
  recovery limits.
- [Development](docs/development.md): setup, checks, code map, test scope.

## License

MIT
