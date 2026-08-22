# openai-api-extension

Minimal modern [Pi](https://pi.dev) provider extension for any
OpenAI-compatible gateway — [Sub2API](https://github.com/Wei-Shaw/sub2api),
CLIProxyAPI, LiteLLM, or the official OpenAI API — using the
**Responses API** (`POST /v1/responses`) as the transport.

## What it does

- Registers an `openai-api-extension` provider in Pi.
- Discovers the model list from `GET {baseUrl}/models` before startup finishes
  (the documented async-factory pattern for remote catalogs).
- Every model is registered with `api: "openai-responses"` and reasoning
  enabled — the gateway is trusted to accept and normalize reasoning
  parameters; per-model tuning belongs in `~/.pi/agent/models.json`.
- No catalog enrichment, no effort-tier inference, no retry logic: request
  bodies go through Pi's standard OpenAI Responses adapter unchanged.

## Setup

### Option 1: `/login` (recommended)

```
/login openai-api-extension
```

Prompts for the gateway base URL and API key, validates the pair against
`GET {baseUrl}/models`, and stores both in `~/.pi/agent/auth.json`. On the
next start the stored connection is used automatically — no environment
variables needed.

### Option 2: Environment variables

The extension stays inert until one of these is configured. Env values take
precedence over a stored `/login` credential.

```bash
export OPENAI_API_EXTENSION_BASE_URL="https://your-gateway.example.com/v1"
export OPENAI_API_EXTENSION_API_KEY="sk-..."
```

> The dedicated `OPENAI_API_EXTENSION_*` prefix avoids colliding with the
> official OpenAI provider's environment variables.

If the gateway is unreachable at startup, the extension logs a warning and
registers without models instead of failing the session; `/login` or a
restart re-validates.

## Install

```
pi install git:github.com/xz-dev/openai-api-extension
```

Or try it once without installing:

```
pi -e git:github.com/xz-dev/openai-api-extension --provider openai-api-extension --model <model-id>
```

## Per-model overrides

Pi composes `~/.pi/agent/models.json` above registered providers. Use it to
tune any model without touching this extension:

```json
{
  "providers": {
    "openai-api-extension": {
      "models": [
        {
          "id": "gpt-5.6",
          "thinkingLevelMap": { "off": null, "low": "low", "medium": "medium", "high": "high", "max": "max" }
        }
      ]
    }
  }
}
```

## Model metadata

The standard `/v1/models` response carries little metadata on most gateways.
When fields are present they are honored: `context_window` /
`context_length`, `max_output_tokens` / `max_completion_tokens` /
`max_tokens`, and `name` / `display_name`. Otherwise sensible defaults
(128k context / 16k output) are used.

## Development

```
npm install
npm test        # node:test unit tests for URL, model mapping, and credential meta
```

## License

MIT
