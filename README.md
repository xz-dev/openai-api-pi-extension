# openai-api-extension

Minimal modern [Pi](https://pi.dev) provider extension for any
OpenAI-compatible gateway — [Sub2API](https://github.com/Wei-Shaw/sub2api),
CLIProxyAPI, LiteLLM, or the official OpenAI API — using the
**Responses API** (`POST /v1/responses`) as the transport.

## What it does

- Registers a complete Pi-native `openai-api-extension` provider. Pi owns
  credentials, model refresh, persistence, offline restore, cancellation, and
  request-time endpoint selection.
- Discovers models from `GET {baseUrl}/models` during async startup or Pi's
  provider refresh.
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
`GET {baseUrl}/models`, and stores one API-key credential in
`~/.pi/agent/auth.json`. The API key uses Pi's secret prompt; the base URL is
stored as provider-scoped credential metadata. `/logout openai-api-extension`
removes both.

### Option 2: Environment variables

The provider remains visible for `/login` when unconfigured, but exposes no
models. Environment values override stored `/login` fields independently.

```bash
export OPENAI_API_EXTENSION_BASE_URL="https://your-gateway.example.com/v1"
export OPENAI_API_EXTENSION_API_KEY="sk-..."
```

> The dedicated `OPENAI_API_EXTENSION_*` prefix avoids colliding with the
> official OpenAI provider's environment variables.

Environment-based setup discovers models during the async extension factory,
so they are available at startup and to `--list-models`. Stored `/login`
credentials refresh through Pi's provider lifecycle. If discovery fails, Pi
retains the last persisted catalog; offline startup restores it without network
access.

## Upgrade from 0.1.0

Version 0.1.0 stored API keys as OAuth credentials. After upgrading, replace
that legacy entry once:

```
/logout openai-api-extension
/login openai-api-extension
```

The new credential stores the key once as an API key and removes the entire
connection on future logout.

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

The extension requests the Codex-compatible `/v1/models?client_version=...`
catalog. Catalog refresh is atomic: every model must provide identity,
context-window, and output-token limits, or the whole list is rejected — Pi
keeps the last verified catalog instead of publishing invented limits or a
partial list. `/login` is not blocked by catalog quality: only connection
failures (unreachable gateway, invalid API key, non-Codex payload) fail login.
If the gateway connects but the catalog is unusable, the key is saved and the
problem is reported where it belongs — model-list refresh.

## Development

```
npm install
npm test        # node:test provider lifecycle, loader, and transport tests
```

## License

MIT
