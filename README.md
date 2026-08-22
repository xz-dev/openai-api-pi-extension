# openai-api-pi-extension

Minimal modern [Pi](https://pi.dev) provider extension for any
OpenAI-compatible gateway — [Sub2API](https://github.com/Wei-Shaw/sub2api),
CLIProxyAPI, LiteLLM, or the official OpenAI API — using the
**Responses API** (`POST /v1/responses`) as the transport.

## What it does

- Registers an `openai-api` provider in Pi.
- Fetches the model list from `GET {baseUrl}/models` before startup finishes
  (the documented async-factory pattern for remote catalogs). A failed fetch
  fails extension loading with a clear error instead of a silently empty catalog.
- Every model is registered with `api: "openai-responses"` and reasoning
  enabled — the gateway is trusted to accept and normalize reasoning
  parameters (e.g. Sub2API group-level effort mappings / body passthrough).
- No catalog enrichment, no effort-tier inference, no retry logic: request
  bodies are sent through Pi's standard OpenAI Responses adapter unchanged.

## Setup

Set the gateway base URL (extension stays inert without it):

```bash
export OPENAI_API_BASE_URL="http://10.1.1.22:8086/v1"
```

Provide the API key either via environment:

```bash
export OPENAI_API_KEY="sk-..."
```

or through Pi's login flow, which stores the credential in
`~/.pi/agent/auth.json`:

```
/login openai-api
```

## Install

```
pi install git:github.com/xz-dev/openai-api-pi-extension
```

Or try it once without installing:

```
pi -e git:github.com/xz-dev/openai-api-pi-extension --provider openai-api --model <model-id>
```

## Per-model overrides

Pi composes `~/.pi/agent/models.json` above registered providers. Use it to
tune any model without touching this extension:

```json
{
  "providers": {
    "openai-api": {
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
npm test        # node:test unit tests for URL + model mapping
```

## License

MIT
