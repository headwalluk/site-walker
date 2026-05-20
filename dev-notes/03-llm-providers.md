# LLM provider abstraction

> **Superseded by M17 (v0.13.0) — kept as the historical M5/M6 TOML design.** The DB-backed provider registry that replaced this lives in [`10-saas-shape.md`](10-saas-shape.md), with the schema in [`02-data-model.md`](02-data-model.md) and operator usage in [`../docs/cli-sw.md`](../docs/cli-sw.md). `site-walker.toml` was deleted in v0.13.0; `providers` + `provider_models` tables in MariaDB took its place, and provider-level `api_key` fields were replaced by per-chatbot AES-256-GCM-encrypted BYO keys. The slug grammar (`provider/model`), adapter interface, and normalised parameter schema described below carried forward unchanged.

Design doc for how site-walker talks to multiple LLM providers and models. Settled 16 May 2026. Implementation lands in M5 and is consumed by M6 (chat endpoint) and M10 (system-blocks regeneration, which also calls an LLM).

Companion to:
- [`02-data-model.md`](02-data-model.md) — per-website model/parameter columns on `websites`
- [`00-project-tracker.md`](00-project-tracker.md) — M5 milestone scope

---

## Shape

Two layers of config:

1. **Provider registry (TOML, on host)** — operator-managed, contains secrets. Static — read once at startup. Defines *which providers exist* and how to reach them (protocol, base URL, API key).
2. **Per-website model selection (DB)** — admin-set per website. References a provider from (1) and chooses a specific model + parameters. Dynamic — looked up per request.

This separation means:
- Adding a new provider is an operator action (edit TOML, restart).
- Switching a website to a different model is an admin action (update DB row, no restart).
- Secrets live on the host, never in the DB.

---

## Provider registry (TOML)

### Location precedence

At startup, the loader looks for `site-walker.toml` in this order. **First match wins:**

1. `./site-walker.toml` (project root, for development)
2. `$HOME/.site-walker/site-walker.toml`
3. `$HOME/.config/site-walker/site-walker.toml` (honour `$XDG_CONFIG_HOME` if set)
4. `/etc/site-walker.toml`

Override: setting `SW_CONFIG=/path/to/file.toml` short-circuits the search. Useful for tests and non-standard layouts.

If no file is found, the app refuses to start. The error must name all four searched paths so the operator knows where to put it.

### Permission gate

**On startup, fail loud if the resolved config file is not mode `0600`.** The file holds real API keys; world- or group-readable secrets are a misconfiguration we refuse to run with. Error message must tell the operator the exact command to fix:

```
ERROR: config file /etc/site-walker.toml must be mode 0600 (currently 0644).
       Run: chmod 0600 /etc/site-walker.toml
```

This is a non-negotiable gate, not a warning.

### Structure

```toml
[providers.anthropic]
protocol = "anthropic"
api_key = "sk-ant-api03-..."

[providers.local1]
protocol = "ollama-native"
base_url = "http://rpi.local:8000"

[providers.local2]
protocol = "ollama-native"
base_url = "http://laptop.local:8000"

[providers.openrouter]
protocol = "openrouter"
api_key = "sk-or-v1-..."
```

- The TOML key after `providers.` (e.g. `anthropic`, `local1`) is the **provider name** — used in the DB slug.
- `protocol` is one of the supported protocol adapters (see below). Unknown protocol = startup error.
- Other fields depend on protocol: `api_key` for cloud providers, `base_url` for self-hosted.

### Example file

A documented example is checked in at `templates/site-walker.toml.example` (shipped in M5; moved out of `config/` in 0.5.0 alongside the search-path simplification). Operators copy this, edit it, and place it at one of the four search paths above with mode `0600`.

### Startup validation

- All four search paths checked; first existing file wins.
- Permissions checked → must be `0600`.
- TOML parsed; unknown `protocol` values → startup error.
- Every website referenced in the DB must have its provider portion present in the TOML; missing provider → startup error naming the website slug and the missing provider.

---

## Per-website model selection (DB)

Three columns on `websites` (see [`02-data-model.md`](02-data-model.md)):

| Column                  | Type            | Notes                                                          |
|-------------------------|-----------------|----------------------------------------------------------------|
| `model_slug`            | `VARCHAR(128)`  | E.g. `local1/qwen2:1.5b` or `openrouter/anthropic/claude-haiku-4.5` |
| `model_parameters`      | `JSON`          | Normalised parameter object. NULL = adapter defaults.          |
| `model_context_window`  | `INT UNSIGNED`  | Operator-declared total context tokens for this model.         |

### Slug parsing

**Split on the first `/` only.** Everything before is the provider name (looked up in TOML); everything after is the model string (passed verbatim to the adapter).

Examples:
- `local1/qwen2:1.5b` → provider=`local1`, model=`qwen2:1.5b`
- `openrouter/anthropic/claude-haiku-4.5` → provider=`openrouter`, model=`anthropic/claude-haiku-4.5`
- `anthropic/claude-haiku-4.5` → provider=`anthropic`, model=`claude-haiku-4.5`

Adapter is responsible for whatever its model strings look like.

### Validation at admin-set time

When admin sets a website's model (`sw website set-model <slug> <model-slug>`):
- Provider portion must exist in the loaded TOML — else error.
- We **don't** try to validate the model string exists at the provider — too brittle, not all providers expose a model-listing API. First request will fail with a useful error if the model name is wrong.

---

## Protocol adapters

One adapter implementation per **wire protocol**, instantiated once per provider entry in the TOML.

### Interface (working sketch)

```typescript
interface ProtocolAdapter {
  readonly protocol: string;          // 'ollama-native' | 'openrouter' | 'anthropic' | ...
  chat(req: ChatRequest): Promise<ChatResponse>;
}

interface ChatRequest {
  model: string;                       // adapter-specific identifier
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
  parameters: NormalisedParameters;    // see below
}

interface ChatResponse {
  reply: string;
  tokensUsed?: { prompt: number; completion: number };
}
```

Streaming is out of scope for Phase 1; the interface should leave room for it (likely an `async *chatStream(req)` method added later).

### Phase 1 adapter

- **`ollama-native`** — only adapter built in Phase 1. Calls `POST {base_url}/api/chat`. Used for the Pi + hailo-ollama setup.

### Phase 2 adapters (in rough priority order)

- **`openrouter`** — OpenAI-compatible wire format with OpenRouter's base URL and model-name convention. Next priority after `ollama-native`; may land in M8 or earlier.
- **`anthropic`** — direct Anthropic Messages API. Useful as a production fallback per README's hardware strategy.
- **`openai-compatible`** — general adapter for other OpenAI-API-clone providers. May absorb `openrouter` if the differences turn out trivial in practice.

### Why `ollama-native` is the priority

Ollama on the Pi is the **lowest common denominator** target. If site-walker works there (tight context, modest hardware), it works anywhere. Designing system blocks against the Pi's constraints, then unlocking larger blocks for websites whose model has a larger context window, is the intended progression. Don't accidentally write code that assumes a fat context.

---

## Normalised parameters

Per-website parameters are stored in the `model_parameters` JSON column using a canonical schema. Each adapter translates to its wire format.

### Canonical schema (v1)

| Key            | Type                | Notes                                                    |
|----------------|---------------------|----------------------------------------------------------|
| `temperature`  | number, [0, 2]      | Sampling temperature. Mostly used in [0, 1].             |
| `top_p`        | number, [0, 1]      | Nucleus sampling.                                        |
| `max_tokens`   | integer, ≥ 1        | Cap on response tokens.                                  |
| `stop`         | string[]            | Stop sequences.                                          |

Start small. Add new canonical keys (penalties, seed, etc.) only when a concrete need arises.

### Translation rules

| Canonical key | `ollama-native`        | `anthropic`        | `openai-compatible` / `openrouter` |
|---------------|------------------------|--------------------|-------------------------------------|
| `temperature` | `options.temperature`  | `temperature`      | `temperature`                       |
| `top_p`       | `options.top_p`        | `top_p`            | `top_p`                             |
| `max_tokens`  | `options.num_predict`  | `max_tokens`       | `max_tokens`                        |
| `stop`        | `options.stop`         | `stop_sequences`   | `stop`                              |

### Validation

- **Unknown keys in `model_parameters`** → error at admin-set time and at request time (defence in depth).
- **Canonical keys not supported by chosen adapter** → error at admin-set time. Don't silently drop.
- **Out-of-range values** (e.g. `temperature: 3`) → error at admin-set time.

Errors at admin-set time mean the CLI rejects the change immediately; bad config never reaches production traffic.

---

## Context-window handling

Each website declares its own `model_context_window` (operator-set, in tokens). This is the **upper bound** the operator promises the chosen model can accept. Drives validation at three points.

### Token estimation

Phase 1 uses a conservative rough estimate: `ceil(char_count / 3)`. Crude but always a slight over-estimate, so it errs on the safe side. Real per-provider tokenisers (tiktoken for OpenAI-family, Anthropic's count_tokens, etc.) can be swapped in later without changing call sites if we wrap the estimator behind a single function.

### Validation points

1. **At admin-set time** — when admin sets a model or updates system blocks for a website, validate that *current* blocks + reasonable history headroom fit within `model_context_window`. Reject if not.
2. **At system-blocks rebuild time (M10 cron)** — after regenerating blocks, run the same check. If the new blocks won't fit, **fail the rebuild, keep the previous blocks in place**, log clearly, and exit non-zero so operators see it.
3. **At request time** — final guard. If blocks + accumulated history exceed budget, return 503 with a useful error and log a warning. In practice M9 trimming should keep history bounded, so this should only fire when blocks alone are too large — which the previous two gates should already have caught.

### Useful error shape

When validation fails, the message must let the operator act without digging:

```
ERROR: system blocks for website 'foobar.org' total ~28,500 tokens, but
       model_context_window for 'local1/qwen2:1.5b' is 32,000. That leaves
       only ~3,500 for conversation history + response.
       Either reduce system blocks or move this website to a larger-context
       model.
```

Three signals in the message: estimated block size, declared budget, residual headroom.

---

## Open questions / deferred

- **Real tokenisers per protocol.** Phase 1 uses `char_count / 3`. Swapping in tiktoken etc. is a later optimisation if the crude estimate turns out too conservative in practice.
- **Streaming.** Out of scope for Phase 1; adapter interface leaves room (async iterator method).
- **Provider health checks at startup.** Currently we validate config; we don't ping providers. Default: don't ping — first request surfaces issues.
- **Fallback chains** (try provider A, fall back to B on error). Explicitly **not a goal**. Adds complexity, hides failures.
- **Per-message parameter overrides** (e.g. lower temperature on the first turn). Out of scope.
- **Cost / token accounting per website.** Not in scope yet. The `tokensUsed` field on `ChatResponse` is captured but only logged in Phase 1; aggregation is a later milestone if needed.
