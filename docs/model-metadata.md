# Model metadata

How the extension maps the upstream `/v1/models` catalog, enriches it from
external data packages, applies rules and overrides, and exports the compiled
result.

## Upstream catalog and registration

The extension requests the `/v1/models` catalog (Codex `models[]` or plain
OpenAI `data[]`). The upstream catalog alone decides which models exist and
their public IDs; it is never rebuilt from external sources. An invalid
catalog is rejected atomically and Pi keeps the last verified list.

The gateway may expose its complete inventory; this extension registers only
conversational text models for Pi agent use, filtering explicit
embedding/image/video/audio kinds and non-text outputs while retaining
image-input vision models.

Every model is registered with the fixed `openai-api-extension` provider and
`api: "openai-responses"`. Public IDs and gateway display names
(`name`/`display_name`) come from the upstream row; the base URL comes from
the effective connection configuration, not the model row. The source chain
only selects capability fields and never changes authentication or routing.
Only explicit `overrides` and Pi `models.json` `modelOverrides` can rename a model.

## Final default values

Defaults are computed after the source chain selects capability fields and
before rule `overrides` and Pi `modelOverrides` apply. They are placeholder
fall-backs that keep a model registerable — not a capability or pricing
promise. There is no external price enrichment today.

| Field | Current fallback / fixed behavior |
| --- | --- |
| `contextWindow` | `128000` tokens when no source supplies a valid context window — not `131072` |
| `maxTokens` | The resolved `contextWindow` when no source supplies a valid output limit; `128000` only when context is also missing |
| `reasoning` / `thinkingLevelMap` | `false` / no tier map when no source declares a valid reasoning-effort list |
| `input` | `["text"]` unless a source declares `image` in `input_modalities` |
| `cost` | All four fields fixed at `0` absent a user override — a placeholder, not "free" |

Derived example: after source selection, a model with `contextWindow: 200000`
and no valid output limit from any declared source gets `maxTokens: 200000`.
An upstream value only participates when the chain includes `@self`.
Manually overriding `contextWindow` later does not recompute a previously
generated `maxTokens` — set both in `overrides` when that is what you mean.

## Source chain

During each online catalog refresh the extension can enrich models from two
public bulk data packages —
[@opencode-ai/models](https://www.npmjs.com/package/@opencode-ai/models)
(the [models.dev](https://models.dev) snapshot) and
[modelparams](https://www.npmjs.com/package/modelparams)
([modelparams.dev](https://modelparams.dev)) — initially installed alongside
the extension with an unpinned `*` range. Use the plugin's
[metadata update commands](#check-and-update-metadata-packages) to update
data independently of plugin releases. The whole lookup and merge runs
inside a worker thread that only returns a compiled result; the ~7 MB snapshot
never enters the main thread's heap. External sources never decide which
models exist; they enrich only models the upstream `/v1/models` catalog
already lists.

Config lives at `~/.pi/agent/openai-api-extension.yaml` (Pi's agent dir,
i.e. `getAgentDir()`). The file is read-only and never created
automatically; a missing file means defaults. A file with invalid YAML,
invalid *known* fields, or removed legacy fields blocks the catalog update
(old catalog kept) and is reported as a metadata config error — never as an
invalid API key. Unknown fields are ignored with one aggregated warning
listing their full paths; everything else still applies.

The chain is an ordered list of sources. For each capability field the first
source with a valid value wins; invalid values fall through to the next
source. The special entry `@self` binds the model's own upstream `/v1/models`
row at that position — it needs no external data package.

```yaml
# Defaults — the model developer's own external records first, then the
# gateway's own row as the final backstop.
chain:
  - "models.dev/@creator/api_key"
  - "modelparams.dev/@creator/api_key"
  - "@self"

models:
  # Rules match on the full public model ID with `*` wildcards; every
  # matching rule applies in declared order — later rules override fields
  # and merge overrides.
  - match: "*gpt-6-astra"   # matches gpt-6-astra, openai/gpt-6-astra, ...
    chain: ["models.dev/openai/api_key", "modelparams.dev/openai/api_key", "@self"]
  - match: "*glm*"          # upstream values first, external fills the gaps
    chain: ["@self", "@default"]
  - match: "model-a"        # matches only the exact ID model-a
    overrides: { contextWindow: 128000 }
  - match: "proxy/glm-5.1"
    # A rule-level chain replaces the root chain for matching models;
    # @default splices the root chain back in wherever it sits.
    chain: ["modelparams.dev/z-ai/api_key", "@default"]
```

**Gateway limits:** external records may describe larger limits than your
endpoint or account actually enforces. The default external-first chain can
overwrite smaller gateway limits; successful model registration does not
verify inference limits. To prefer gateway values for a model family:

```yaml
models:
  - match: "gateway/*"
    chain: ["@self", "@default"]
```

Alternatively, set explicit final `contextWindow` and `maxTokens` overrides.

**`@self`** may appear anywhere in a chain — including more than once
(idempotent: the first valid value already occupies the field). A chain of
only `["@self"]` keeps upstream metadata and skips all external reads: no
data packages are loaded and no compile worker is spawned.

Without `@self`, upstream capability fields do not participate — even when
all external lookups miss or a data package degrades. Fields missing from the
declared sources use the final defaults, never an implicit upstream fallback.
This does not change the upstream catalog's control of membership or public IDs.

**Chain entries**: `<site>/<provider>/<access>[/<query-id>]` — site is
`models.dev` or `modelparams.dev`, access is `api_key` or `subscription`
(modelparams records carry their own `authType`; models.dev's access is a
declared label), and an optional 4th segment pins the literal query ID
(may contain `/`) when the public ID differs, e.g.
`models.dev/llmgateway-providers/api_key/anthropic/claude-fable-5-1`.
Wildcards (`*`) are not allowed anywhere in a chain entry.

**`@creator`** resolves the model's full canonical identity at compile
time, in four steps:

1. Collect the `@id` query hits for the public ID's last `/` segment
   across all models.dev provider records and the unified canonical
   table.
2. Read the `canonical_model_id` of the identity-bearing hits — unified
   table entries carry their full `creator/model` key.
3. Collapse creators through the built-in ordered alias groups
   (`zhipuai|zai|z-ai`, `moonshotai|moonshot`, `thinkingmachines|thinking-machines`),
   keep the full canonical model (renames like `deepseek-v4-flash-fast`
   still resolve to the creator's real model id), and expand the
   creator to the group members that exist on each site.
4. Read fields only from those concrete provider tables. Other providers'
   records (for example aggregators such as `llmgateway-providers`) help
   identify the creator but never supply fields.

On modelparams.dev, entries also filter by `authType === access`. If no
creator is found, the entry is marked `[unresolved]`: it is skipped and the
next chain entry decides the field. Only creators from *different* alias
groups for the same model are a config error; name the provider literally
in a rule to resolve it.

**`@id`** queries source records by the public ID's last `/` segment.
At compile time the segment becomes an anchored, escaped,
case-insensitive pattern: the literal string is tried first, then every
record whose id differs only by runs of space/underscore/dot/hyphen or
case is collected, then a date-suffix-stripped fallback
(`-YYYYMMDD` / `-YYYY-MM-DD`). All literal matches are kept as
inspectable candidates — regex input is never executed, channel
prefixes do not change the query, and a literal 4th chain segment
always stays an exact lookup. The default chain uses `@creator` with an
implicit `@id` model query.

**Canonical identity** is resolved from the collected hits: full
`creator/model` canonical IDs (not bare creator prefixes) are compared
through the alias groups; records carrying distinct canonical creators
are a config error on `@creator` chains, and same-creator hits naming
distinct canonical models are marked ambiguous and skipped — never
merged or order-picked. Same-level aliases whose capability fields
conflict are skipped the same way, and compilation continues with the
next source. A unified canonical models table (the snapshot's
`models` shape) supplies identity evidence and, only for the automatic
`@creator/api_key` path, fills fields a concrete creator record left
missing — the provider's own record always wins where it has a valid
value, and unified data can form a logical entry when no provider
record exists at all. Explicit providers, literal model segments and
`subscription` entries never get that fallback; aggregator records only
contribute canonical hints, never fields.

**`@default`** inside a rule's `chain` splices the *root* chain at that
position; in the root chain it is a config error.

**Empty chains are rejected.** `chain: []` at root or rule level is a config
error naming the full path. Write `chain: ["@self"]` for upstream-only
metadata, or omit `chain` to inherit the default (root) / parent (rule)
chain.

**Rule layering**: every rule whose `match` glob hits the public ID
contributes in declared order — later rules override `chain` entirely, and
`overrides` merge RFC 7396-style (nested objects recurse, `null` deletes).
`match: "*"` rules apply to all models; there is no extra priority for exact
names.

**Field selection**: for each capability field the chain order decides —
`null` never erases a value, an explicit empty
`supported_reasoning_levels: []` counts as "no tiers", and an alias like
`context_length` cannot slip past a declared `context_window`. Manual
`overrides` apply after source selection as one more RFC 7396 patch; `id`,
`provider`, `api`, and `baseUrl` are forbidden override keys. Pi's
`models.json` `modelOverrides` always applies last.

**Match summary**: after each refresh the extension reports one short line
classifying every model with an enabled external chain as complete
(external capability fields, nothing unresolved), partial-source-missing
(external capability fields but some entry unresolved), or unmatched (no
external capability field — a name-only record does not count). Upstream
`@self` values never count as external hits: models with an upstream-only
chain are listed separately as disabled and never counted as failures.
Degraded data sources add their own note; the full candidate lists and
reasons live in `/provider-metadata`, not in the notification.

**Notifications are transient**: all plugin-owned prompts, progress,
notifications and errors start with `[openai-api-pi-extension]`. Metadata
notes, degraded-source warnings and config errors use Pi's native notify
channel when a UI is attached, or stderr otherwise — stdout and the session
JSONL stay untouched, and nothing is appended as chat entries. Notes
identical to the previous report are deduplicated; a superseded or
cancelled refresh reports nothing.

**Degraded sources**: if a data package is missing or malformed, that site
degrades — its declared entries are skipped and the remaining declared
sources still apply. Upstream capabilities are used only when `@self` is in
the chain; otherwise missing fields use remaining external sources and final
defaults. A valid upstream model inventory still publishes with a transient
note. If the upstream catalog itself fails, Pi keeps the persisted catalog.
The inference path never reads metadata. Offline restore and
`allowNetwork: false` refreshes read no config and touch no data.

## Migrating legacy fields

`fill_missing_only` is removed: every occurrence at root or rule level is a
config error naming the exact path, even when the same config also contains
`@self`. Migrate by deleting the switch and placing `@self` in the chain.

**Breaking change for existing explicit chains:** a non-empty external-only
chain remains valid even without a legacy switch, but now strictly replaces
upstream capability data. Add `@self` explicitly to retain gateway fields;
without it, a lookup miss or degraded source cannot restore those fields.

| Intent | New chain |
| --- | --- |
| Old `fill_missing_only: false` (external values overwrite upstream) | `@self` after the external entries |
| Old `fill_missing_only: true` (upstream wins, external fills gaps) | `@self` before the external entries |
| Old `chain: []` (opt out of external enrichment) | `chain: ["@self"]` |
| Existing explicit external chain; retain upstream capability data | Add `@self` at the intended priority position; put it last for external-first with upstream fallback |
| Existing explicit external chain; intentionally replace upstream capabilities | Omit `@self`; unavailable external fields use final defaults |
| No chain configured | Keep omitting — the built-in default ends with `@self` |

Migration error example — this config fails both checks:

```yaml
# ERROR: chain [] is rejected; fill_missing_only is a removed legacy field.
chain: []
fill_missing_only: true
```

Non-empty replacement:

```yaml
chain:
  - "@self"
  - "models.dev/@creator/api_key"
  - "modelparams.dev/@creator/api_key"
```

Other removed fields from the old selector design also raise a config error
naming the exact path and the new equivalent: `source_priority`,
`provider_prefix_map`, `lookup_ids`, `models_dev_subscription`, `channels`,
`global_fallback`, and the mapping form of `models:` — rewrite them as
`chain` entries, literal providers, `@creator`, and `models:` rule lists.

Rules inherit the root chain when they omit `chain`; a multi-rule setup that
relied on the old per-rule switch must pick each model's effective order
explicitly, not just delete the boolean.

## Viewing the compiled result

`/provider-metadata` refreshes the upstream catalog, runs the same worker
compile, writes the rendered text to a private temp file (0700 dir / 0600
file under `os.tmpdir()`), and notifies you with
`[openai-api-pi-extension] <absolute-path>` — the prefix is not part of the
filename. Open that path with any editor or pager. The file's first line
also identifies this plugin. It lists the effective config (chains as
written, including `@self`/`@default`), data versions, per-model matched
rules, the fixed compiled plan — concrete external entries and
`upstream <publicId>` nodes at their declared positions — supplied fields
and their per-field source (`[canonical]` = unified canonical table,
unmarked = provider record), the full candidate list with match level and
selection/skip reasons, `[unresolved]` markers, and final overrides — never
the API key. An upstream node shows only the capability-whitelisted fields
it could supply; that a field appears there does not mean it became the
final value. Files are retained for your session and reclaimed by the
system temp cleaner.

## Check and update metadata packages

```text
/provider-metadata check    # Compare the active local versions with registry latest
/provider-metadata update   # Install, validate and activate both data packages
/provider-metadata          # Keep the existing private diagnostic export
```

No gateway login is needed to check or update packages. Checks never install;
only `update` changes data. The first successful online interactive catalog
publication also schedules one non-blocking check per process. It only notifies
when a newer stable version exists; automatic failures stay quiet. Offline mode
(`--offline` / `PI_OFFLINE`) skips automatic checks and refuses explicit checks
and updates. Compilation and inference never query the registry.

The plugin honors Pi's `npmCommand` configuration, including compatible npm,
Bun and pnpm argument prefixes. Only compatible option prefixes (for example,
`npm --registry <url>`) are accepted; `npm exec`, `npm install` and ambiguous
`bun run` prefixes are rejected before any subprocess starts. Without a
setting, a verified xz-dev compiled Pi uses its embedded Bun; ordinary
Node.js/source installs use npm (including Pi source run under Bun). Missing
or ambiguous managers fail explicitly; the plugin does not install tools,
switch managers or bypass registry auth. You do not need to choose npm/Bun or
find the extension installation directory. `pi update`,
`pi update --extensions` and repeated `pi install` are not guarantees that
these transitive data dependencies will refresh.

Updates use private, immutable generations under
`getAgentDir()/cache/openai-api-pi-extension/metadata/`, not the extension's
`node_modules` or Pi's shared npm tree. Both exact package versions are
validated before one atomic activation; a newer local version is never
downgraded to an older registry `latest`. Even matching versions must load and
pass data-shape validation before reporting "already current"; broken
same-version installations are repaired through a new isolated generation.
Package install scripts are disabled. The data modules are still trusted
executable package code, not a security sandbox.

Before the first successful update, the plugin uses its installed
dependencies. After activation, the private generation takes priority across
login, refresh, connection status and export. Updating the bundled
dependencies directly does not replace that active generation.
Invalid/incomplete active records warn and fall back as a pair. Old and
unfinished generations are retained; there is no automatic cleanup or
rollback command.

A successful activation refreshes only this provider, in the same Pi process.
If the gateway is unconfigured, unreachable or has invalid metadata config,
the new data stays installed while the old published catalog stays usable;
the notification distinguishes those outcomes. In TUI mode, Escape cancels
the operation and waits for cleanup. Shutdown also aborts and awaits owned
work. Checks have a 10-second budget; installation/validation share a
five-minute budget. Timeout/abort leaves the old activation in place if
commit has not occurred.

Concurrent updates return busy. A dead update-lock owner can be recovered;
recovery guards themselves are never stolen because that would recreate the
stale-lock race. If an interrupted recovery leaves `recovery.lock`, a busy
notification names its private path for manual inspection. Confirm no updater
is running before removing a leftover guard. Windows process-tree termination
has not been verified; the tested process-group cancellation path is POSIX.
