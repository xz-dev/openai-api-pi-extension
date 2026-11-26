# Configuration

Credentials, base URL, catalog refresh, and per-model overrides for the
`openai-api-extension` provider.

The extension registers a complete Pi-native provider. Pi owns credentials,
model refresh, persistence, offline restore, cancellation, and request-time
endpoint selection. Models are discovered from `GET {baseUrl}/models` on Pi's
provider refresh: `/login`, interactive background refresh, or
`pi --refresh --list-models`. Which models are registered is described in
[model metadata](model-metadata.md#upstream-catalog-and-registration).

## Credentials

### `/login` (recommended)

```text
/login openai-api-extension
```

Prompts for the gateway base URL and API key, validates the pair against
`GET {baseUrl}/models`, and stores one API-key credential in
`~/.pi/agent/auth.json`. The API key uses Pi's secret prompt; the base URL is
stored as provider-scoped credential metadata. `/logout openai-api-extension`
removes both.

### Environment variables

The provider remains visible for `/login` when unconfigured, but exposes no
models. Environment values override stored `/login` fields independently.

```bash
export OPENAI_API_EXTENSION_BASE_URL="https://your-gateway.example.com/v1"
export OPENAI_API_EXTENSION_API_KEY="sk-..."
```

> The dedicated `OPENAI_API_EXTENSION_*` prefix avoids colliding with the
> official OpenAI provider's environment variables.

## First refresh and offline behavior

With env-based or stored `/login` credentials, no discovery runs at startup:
the extension loads instantly, Pi restores the last persisted catalog
(without network), and interactive sessions refresh it in the background.
On a fresh install with no persisted catalog, plain `--list-models` shows
nothing for this provider — run `pi --refresh --list-models` once for the
initial discovery and whenever you want to force an update. If discovery
fails, Pi retains the last persisted catalog; offline startup restores it
without network access.

`/login` is not blocked by catalog quality: only connection failures
(unreachable gateway, invalid API key, non-models payload) fail login. If the
gateway connects but the catalog is unusable, the key is saved and the problem
is reported where it belongs — model-list refresh. Pi's `/model` overlay only
names the provider; catalog and metadata diagnostics surface as transient
native notifications (or stderr without a UI) — never as session entries.

## Per-model overrides

Pi composes `~/.pi/agent/models.json` above registered providers. Use it only
to override a catalog-derived map, not to invent the default tiers. Pi's
`models.json` `modelOverrides` always applies last — after source selection
and this extension's own rule `overrides`.

Model metadata config (source chains, rules, `overrides`) lives in
`~/.pi/agent/openai-api-extension.yaml`; see
[model metadata](model-metadata.md).

## Function tool strictness

Newly mapped Responses models declare `compat.supportsStrictMode: true`.
This tells Pi the endpoint accepts the `strict` field; it does not force all
functions into strict mode. In the same request, a regular function gets
`strict: false` (its optional parameters stay optional), while a function that
requires strict sampling and has a compatible schema gets `strict: true`.

If a gateway rejects the `strict` field, add a matching rule to the `models`
list in `~/.pi/agent/openai-api-extension.yaml`:

```yaml
models:
  - match: "legacy-*"
    overrides:
      compat:
        supportsStrictMode: false
```

Use the gateway's public model IDs for `match`. With this override Pi omits
`strict` for regular functions instead of sending `strict: false`; a tool that
requires strict sampling cannot use it on that model. After updating the
extension or its rules, run `pi --refresh --list-models` to rebuild the
catalog. Do not edit the generated catalog.

## Connection status

Run:

```text
/provider-info
```

The command probes the configured gateway with the effective API key and shows
the last transport this plugin actually used, Pi's configured transport, server
URL, connection/key validity, and live usable model count. Before the first
model request, actual transport is reported as `not connected yet`. It never
prints the API key.
