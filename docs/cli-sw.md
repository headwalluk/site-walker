# `sw` — site-walker admin CLI

`./bin/sw` is the operator's CLI for everything that doesn't go through the HTTP API: registering accounts and chatbots, managing the provider registry, setting per-chatbot LLM keys, inspecting system blocks and sessions.

It talks to the same MariaDB the API server uses, so its scope is the host it runs on.

## Prerequisites

- A reachable MariaDB with the schema migrated (`npm run migrate`).
- A `.env` with `DB_*` populated (see [`env.md`](env.md)).
- `SW_ENCRYPTION_KEY` set in `.env` if any chatbot will use a metered provider (`./bin/sw secrets gen-key` generates a fresh value; required by the API server at boot regardless).
- At least one provider registered via `sw provider add` before any chatbot can resolve its `model_slug`.

The API server doesn't need to be running for `sw` to work — it operates directly against the database.

## Synopsis

```
./bin/sw [-V|--version] [-h|--help] <command> [<args>...]
```

Top-level commands:

| Command    | Purpose                                                                |
| ---------- | ---------------------------------------------------------------------- |
| `secrets`  | manage env-resident master secrets (today: `gen-key` for SW_ENCRYPTION_KEY) |
| `account`  | manage accounts (each owns one or more chatbots)                       |
| `chatbot`  | manage chatbots and their per-tenant configuration                     |
| `provider` | manage the DB-backed provider registry + live model discovery          |
| `blocks`   | inspect a chatbot's assembled system blocks                            |
| `sessions` | read-only browse over sessions and their messages                      |

---

## `sw secrets`

Helpers for env-resident master secrets. Today this is just `SW_ENCRYPTION_KEY` (M17); `SW_PROVISIONING_KEY` for the admin HTTP surface lands in M19.

### `sw secrets gen-key`

Print a fresh base64-encoded 32-byte value to stdout. Paste into `.env` as `SW_ENCRYPTION_KEY=…`. The hint message goes to stderr so the value alone can be captured cleanly with `>` or piping.

```
$ ./bin/sw secrets gen-key
M0cwQ3Z3RnRqV2dFL0RvajdIbVE5ZllYV1IxNkFkc0VxMnE5UjBseVZHST0=
# Paste the value above into your .env as SW_ENCRYPTION_KEY=...
# Treat the value like any other production secret — do not commit it.
```

The key encrypts `chatbots.provider_api_key_ciphertext` via AES-256-GCM. Once set, do not change it without re-running `sw chatbot set-api-key` for every chatbot that has a key — rotation is destructive (existing ciphertexts become unreadable). See [`env.md`](env.md) and the M17 design notes in `dev-notes/10-saas-shape.md` for the rotation rationale.

---

## `sw account`

Accounts sit one level above chatbots: every chatbot belongs to exactly one account, and billing happens per-account (in WooCommerce, not here). Self-hosters create an account once and put every chatbot they run under it.

### `sw account create <slug> [--name <name>]`

Create a new account. Slug rules match the chatbot slug grammar (1–64 lowercase alphanumeric + hyphens, not starting/ending with a hyphen). The account's UUID is generated server-side and printed in the output.

```
$ ./bin/sw account create headwall --name "Headwall Hosting"
Created account: id=4c9b6f0a-8e2f-4a7e-b3c5-09e91f4f8d23 slug=headwall name="Headwall Hosting"
```

### `sw account list`

List every account with slug, name, owned chatbot count, and UUID.

```
$ ./bin/sw account list
slug      name                chatbots  id
headwall  Headwall Hosting           2  4c9b6f0a-8e2f-4a7e-b3c5-09e91f4f8d23
```

### `sw account show <slug>`

Dump the full DB row for an account as JSON.

### `sw account delete <slug> -f|--force`

Hard-delete an account and **cascade through every chatbot it owns** — including their origins, sessions, and messages. **Irreversible**; `--force` is required.

```
$ ./bin/sw account delete headwall --force
Deleted account slug="headwall". Cascaded: 2 chatbot(s), 5 origin(s), 17 session(s), 84 message(s).
```

---

## `sw chatbot`

### `sw chatbot create <slug> --account <account-slug> [--name <name>]`

Register a new chatbot under an existing account. The `slug` must be 1–64 lowercase alphanumeric + hyphens, not starting or ending with a hyphen. `--account` is required and must reference a slug from `sw account list`. `--name` defaults to the slug. The chatbot's `persona` is seeded from `templates/PERSONA.md`.

```
$ ./bin/sw chatbot create acme-corp --account headwall --name "Acme Corp"
Created chatbot: id=2 slug=acme-corp name="Acme Corp" account="headwall"
Persona seeded from templates/PERSONA.md (1024 chars).
```

### `sw chatbot list`

List every registered chatbot with slug, name, owning account, configured model (or `(unset)`), and origin count.

```
$ ./bin/sw chatbot list
slug           name          account   model                         origins
acme-corp      Acme Corp     headwall  cortex/qwen2:1.5b             2
devx-headwall  Headwall Dev  headwall  (unset)                       1
```

### `sw chatbot show <slug>`

Dump the full DB row for a chatbot as JSON. Useful for confirming exact persona text, parameters, timestamps.

```
$ ./bin/sw chatbot show acme-corp
{
  "id": 2,
  "slug": "acme-corp",
  "name": "Acme Corp",
  "welcome_message": null,
  "persona": "You are a friendly pre-sales assistant ...",
  "model_slug": "cortex/qwen2:1.5b",
  "model_parameters": null,
  "model_context_window": 4096,
  "created_at": "2026-05-17T10:00:00.000Z",
  "updated_at": "2026-05-17T10:05:00.000Z"
}
```

### `sw chatbot delete <slug> -f|--force`

Hard-delete a chatbot and everything that references it via FK CASCADE: origins, sessions, messages. **Irreversible** — `--force` is required.

```
$ ./bin/sw chatbot delete acme-corp --force
Deleted chatbot slug="acme-corp". Cascaded: 2 origin(s), 17 session(s), 84 message(s).
```

Without `--force` the command refuses and prints a one-line explainer.

### `sw chatbot set-welcome <slug> <message>`

Set the welcome message returned by `POST /sessions`. Pass the empty string to clear it; the route then falls back to its built-in default (`Hi! How can I help?`).

```
$ ./bin/sw chatbot set-welcome acme-corp 'Welcome to Acme — what can we help with?'
Set welcome_message for slug="acme-corp" (40 chars).

$ ./bin/sw chatbot set-welcome acme-corp ''
Cleared welcome_message for slug="acme-corp" (falls back to default).
```

### `sw chatbot origins {list,add,remove} <slug> [...]`

Manage a chatbot's origin allowlist. `add` and `remove` modify the list; `list` prints what's there.

```
$ ./bin/sw chatbot origins list acme-corp
id  origin
 3  https://www.acme-corp.example
 4  https://acme-corp.example

$ ./bin/sw chatbot origins add acme-corp https://shop.acme-corp.example
Added origin id=5 origin="https://shop.acme-corp.example" to chatbot slug="acme-corp"

$ ./bin/sw chatbot origins remove acme-corp 5
Removed origin id=5 origin="https://shop.acme-corp.example" from slug="acme-corp"

$ ./bin/sw chatbot origins remove acme-corp https://acme-corp.example
Removed origin id=4 origin="https://acme-corp.example" from slug="acme-corp"
```

`remove` accepts either the numeric `chatbot_origins.id` (as printed by `list`) or the origin URL. URL matching uses the same normalisation as `add` (lower-case host, no trailing slash) so casing/slash differences don't trip you up.

Notes:

- An origin can belong to one chatbot at a time (unique constraint).
- HTTPS and HTTP are both accepted; in production you almost certainly want HTTPS only.
- The visitor's browser sends the `Origin` header on `POST /sessions`; the server rejects with `403 origin_not_allowed` if it isn't on the chatbot's list.

### `sw chatbot set-persona <slug> <persona-text>`

Replace the chatbot's persona text. The persona is the first `<block name="PERSONA">` the model sees; see [`system-blocks.md`](system-blocks.md).

```
$ ./bin/sw chatbot set-persona acme-corp 'You are Acme Corp'\''s pre-sales assistant...'
Updated persona for slug="acme-corp" (137 chars).
```

For anything longer than a line or two, edit `templates/PERSONA.md` (or a per-site copy) and pipe it in:

```
$ ./bin/sw chatbot set-persona acme-corp "$(cat data/chatbots/acme-corp/persona.md)"
```

### `sw chatbot set-model <slug> <provider/model>`

Point the chatbot at a `provider/model` slug. Both halves are looked up in the DB-backed provider registry (`providers` × `provider_models`); if the slug doesn't resolve, the command refuses with a clear error that points at `sw provider add` and `sw provider models add`.

```
$ ./bin/sw chatbot set-model acme-corp cortex/qwen2:1.5b
Set model_slug="cortex/qwen2:1.5b" for chatbot slug="acme-corp".
```

Use `sw provider models discover <name>` to print copy-pasteable full slugs from a live provider.

### `sw chatbot set-api-key <slug>`

Encrypt and persist a bring-your-own LLM provider API key against the chatbot row. **Reads from stdin only** — never argv, never echoed back. Stored as AES-256-GCM ciphertext + nonce + auth tag in three `chatbots.provider_api_key_*` columns; the master key is `SW_ENCRYPTION_KEY` from `.env`.

```
$ echo "sk-ant-api03-…" | ./bin/sw chatbot set-api-key acme-corp
Set api_key for chatbot slug="acme-corp" (104 bytes stored encrypted).
```

Or from a file:

```
$ ./bin/sw chatbot set-api-key acme-corp < ~/secrets/anthropic-acme.txt
```

The command refuses if invoked from an interactive TTY (to avoid the key being echoed as the operator types). The plaintext is trimmed of leading/trailing whitespace before encryption; up to 255 bytes of plaintext fit in the column. There is no `show-api-key` — if you need to verify, set it again.

Chatbots pointed at a metered provider (any cloud-LLM provider; `providers.is_metered = true`) **must** have a key set, or `POST /chat` returns `503 chatbot_api_key_missing` until they do. Chatbots on unmetered providers (Ollama, `is_local = true`) don't need one.

### `sw chatbot set-parameters <slug> <json>`

Set normalised model parameters as a JSON object. Validated against a strict Zod schema; unknown keys and out-of-range values are rejected.

Supported keys:

| Key           | Type            | Range / shape       |
| ------------- | --------------- | ------------------- |
| `temperature` | number          | `[0, 2]`            |
| `top_p`       | number          | `[0, 1]`            |
| `max_tokens`  | positive int    | `>= 1`              |
| `stop`        | array of string | any                 |

```
$ ./bin/sw chatbot set-parameters acme-corp '{"temperature":0.4,"max_tokens":512}'
Set model_parameters for chatbot slug="acme-corp": {"temperature":0.4,"max_tokens":512}
```

Pass `'{}'` to clear them.

### `sw chatbot set-context-window <slug> <tokens>`

Set the chatbot's declared model context window, in tokens. Must be a positive integer.

```
$ ./bin/sw chatbot set-context-window acme-corp 4096
Set model_context_window=4096 for slug="acme-corp".
```

This is the figure the `POST /chat` budget check refers to. The check refuses the request with `413 context_overflow` when `system + history + new user` tokens plus a headroom (12.5% of the window, 512-token floor) exceeds the window. Leave it unset (NULL) to skip the check entirely.

### `sw chatbot set-budget <slug> [--daily <usd|none>] [--session <usd|none>] [--admin-session <usd|none>] [--threshold <pct>]`

Set per-chatbot spend caps. All four options are independent and any combination is accepted (at least one must be present).

```
$ ./bin/sw chatbot set-budget acme-corp --daily 2.50 --session 0.25 --admin-session 5.00 --threshold 80
Updated budgets for chatbot "acme-corp":
  daily_budget_usd:         2.5000
  session_budget_usd:       0.2500
  admin_session_budget_usd: 5.0000
  handoff_threshold_pct:    80

$ ./bin/sw chatbot set-budget acme-corp --daily none
Updated budgets for chatbot "acme-corp":
  daily_budget_usd:         (none)
  session_budget_usd:       0.2500
  admin_session_budget_usd: 5.0000
  handoff_threshold_pct:    80
```

- **`--daily <usd|none>`** — daily USD spend cap. Once today's customer-only spend (UTC midnight–to-now) reaches it, `POST /sessions` and `GET /sessions/can-start` return `402 budget_exhausted_daily` until the next UTC midnight. `none` clears the cap (= unlimited). Bounded above by `SW_MAX_DAILY_BUDGET_USD` ([`env.md`](env.md)) — the CLI refuses to set a higher value. **Admin-mode spend is excluded from this aggregate** so an admin's morning of testing doesn't displace customer budget.
- **`--session <usd|none>`** — per-conversation USD cap for customer-facing sessions. Triggers the soft-handoff inject at `--threshold` % and terminates the session once spend crosses the cap (the last natural reply is still delivered). `none` clears the cap. Bounded by `SW_MAX_SESSION_BUDGET_USD`.
- **`--admin-session <usd|none>`** — M21: per-conversation cap for **admin-mode** sessions only. NULL/`none` = unbounded (admin is trusted; the operator who minted the session is presumed to be watching what they're spending). When set, acts as a safety belt against runaway admin chats. Bounded by `SW_MAX_SESSION_BUDGET_USD`. Soft-handoff inject + webhook firing are suppressed for admin sessions regardless of this value.
- **`--threshold <pct>`** — integer in `[1, 100]`. Soft-handoff trigger as a % of the session cap. Defaults to `80`. Has no effect when `session_budget_usd` is unset (or for admin-mode sessions, which never see the soft-handoff inject).

### `sw chatbot set-timezone <slug> <tz-or-none>`

M21: set the chatbot's IANA timezone identifier. The WP plugin syncs this from the WordPress site's configured TZ; the API has no way to infer it. Pass `none` to clear (effective: UTC).

```
$ ./bin/sw chatbot set-timezone acme-corp Europe/London
Set timezone="Europe/London" for slug="acme-corp".

$ ./bin/sw chatbot set-timezone acme-corp none
Cleared timezone for slug="acme-corp" (effective: UTC).
```

Validated against the runtime's ICU data via `Intl.DateTimeFormat({ timeZone: <candidate> })` — anything Node accepts as a tz is accepted here; anything it doesn't is rejected.

### `sw chatbot set-hours <slug> [none]`

M21: set the chatbot's weekly availability schedule. Pass JSON via **stdin**, or `none` as the argument to clear (always-open). The JSON shape:

```json
{
  "schedule": {
    "mon": ["09:00-17:00"],
    "tue": ["09:00-12:00", "13:00-17:00"],
    "fri": ["00:00-09:00", "17:00-24:00"]
  }
}
```

Per-day arrays of `"HH:MM-HH:MM"` strings. Missing day key = closed all day. Empty array = closed all day. `24:00` accepted as end-of-day; `close <= open` rejected (use two windows for overnight ranges). Whitespace around the dash is tolerated.

```
$ echo '{"schedule":{"mon":["09:00-17:00"],"tue":["09:00-17:00"]}}' | \
    ./bin/sw chatbot set-hours acme-corp
Set availability schedule for slug="acme-corp".

$ ./bin/sw chatbot set-hours acme-corp none
Cleared availability schedule for slug="acme-corp" (always open).
```

Once set, `POST /sessions` and `GET /sessions/can-start` return `503 chatbot_closed` (with `Retry-After` and `detail.next_open_at`) outside the schedule's windows. Already-minted sessions keep running past closing time. Full design: [`../dev-notes/14-availability-and-admin-mode.md`](../dev-notes/14-availability-and-admin-mode.md).

### `sw chatbot set-handoff-webhook <slug> <url|none>`

Set or clear the handoff-notification webhook URL (M20). Fired best-effort (no retry, 10s timeout) when a session ends with a captured visitor email. Pass the literal `none` to clear.

```
$ ./bin/sw chatbot set-handoff-webhook acme-corp https://crm.example.com/site-walker/handoff
Set handoff_webhook_url="https://crm.example.com/site-walker/handoff" for slug="acme-corp".

$ ./bin/sw chatbot set-handoff-webhook acme-corp none
Cleared handoff_webhook_url for slug="acme-corp".
```

URL must be `http://` or `https://` and ≤255 chars. The payload shape, retry policy, and webhook security stance are documented in [`../dev-notes/11-budget-handoff.md`](../dev-notes/11-budget-handoff.md).

### `sw chatbot set-geo-mode <slug> <allowall|blocklist|allowlist>`

Set the chatbot's geo-blocking mode. Three modes:

| Mode        | Behaviour                                                                        |
| ----------- | -------------------------------------------------------------------------------- |
| `allowall`  | Country list is ignored. Every visitor is accepted. **Default for new chatbots.**|
| `blocklist` | Visitors whose IP resolves to a listed country are rejected; everyone else passes.|
| `allowlist` | Only visitors whose IP resolves to a listed country are accepted.                |

```
$ ./bin/sw chatbot set-geo-mode acme-corp allowlist
Set geo mode for slug="acme-corp" to "allowlist".
(Remember to populate the country list with `sw chatbot set-geo-countries`.)
```

If the mode is set to `blocklist` or `allowlist`, the server requires `GEOIP_DB_PATH` to be configured ([`env.md`](env.md)). Otherwise startup will refuse with a clear error.

### `sw chatbot set-geo-countries <slug> <codes>`

Atomically replace the chatbot's country list. Codes are comma-separated ISO 3166-1 alpha-2 (two letters per country, case-insensitive on input — stored uppercase). Passing an empty string clears the list.

```
$ ./bin/sw chatbot set-geo-countries acme-corp 'GB,US,FR'
Set geo country list for slug="acme-corp": GB, US, FR (3 countries).

$ ./bin/sw chatbot set-geo-countries acme-corp ''
Cleared geo country list for slug="acme-corp".
```

Duplicates and whitespace are tolerated and normalised. Codes that don't match `[A-Z]{2}` are rejected outright; full validation against the ISO list is left to MaxMind (it'll just never match an invented code).

### `sw chatbot show-geo <slug>`

Display the current mode + country list.

```
$ ./bin/sw chatbot show-geo acme-corp
Geo policy for slug="acme-corp":
  mode:      blocklist
  countries: CN, KP, RU
```

### `sw chatbot show-model <slug>`

Resolve the chatbot's configured model against the DB-backed registry and print the result.

```
$ ./bin/sw chatbot show-model acme-corp
Chatbot: acme-corp
  model_slug:           cortex/qwen2:1.5b
  provider:             cortex (ollama-native) [unmetered]
  model:                qwen2:1.5b
  parameters:           {"temperature":0.4,"max_tokens":512}
  model_context_window: 4096
```

Fails with a clear error if `model_slug` no longer resolves (provider or model row missing from the registry).

### `sw chatbot usage <slug> [-s|--since <duration>]`

Aggregate token + USD cost totals for a chatbot. Costs and tokens are recorded per assistant message at chat time (since v0.14.0 / M18). Defaults to all-time when `--since` is omitted; otherwise narrows to the relative window.

As of v0.17.0 (M21), output is split into customer-facing and admin-mode rows so operators can immediately see "ah — it was the boss racking up the Anthropic bill today":

```
$ ./bin/sw chatbot usage headwall-devx
Usage for chatbot "headwall-devx" (period: all-time):
  Customer sessions:
    Messages:        42
    Tokens in:       11200
    Tokens out:      5200
    Cost (USD est):  $0.038200
  Admin-mode sessions:
    Messages:        5
    Tokens in:       1280
    Tokens out:      621
    Cost (USD est):  $0.003405
```

Customer-session spend is what counts toward `daily_budget_usd`. Admin-mode spend is tracked but excluded from the daily-cap aggregate — see `set-budget` above for the rationale.

`--since` accepts relative durations only: `Ns` (seconds), `Nm` (minutes), `Nh` (hours), `Nd` (days). Single-unit form — `1h30m` is not supported (aggregate to the slightly bigger `2h` window instead). Malformed values are rejected with a clear error.

**Cache lines** (post-M20 milestone surface — currently always 0 until Anthropic prompt-cache wiring lands) appear under either or both segments when non-zero:

```
    Cache writes:    1024 tokens
    Cache reads:     8192 tokens
```

These appear only when at least one message in the window recorded non-zero cache activity.

**Cost-under-counting warning.** If the chatbot's current `model_slug` resolves to a model row that has NULL pricing on a `metered` provider, the cost numbers above silently round to 0 for every metered turn. The CLI surfaces this:

```
  ⚠ Cost may be under-counted: chatbot's current model row "openrouter/anthropic/claude-haiku-4.5" has NULL pricing on metered provider "openrouter". Re-register the model with --input-price and --output-price to get accurate cost numbers going forward.
```

This only flags the chatbot's *current* configuration — historical messages stay at whatever cost was recorded when they were inserted. Going forward, fix the pricing and new messages will record accurately.

The cost number is an **estimate**, not ground truth. The provider's invoice is authoritative; our number runs slightly under because system-side overhead at the provider isn't counted here. See `dev-notes/10-saas-shape.md` for the rationale.

---

## `sw provider`

The provider registry lives in MariaDB (since M17). It defines which LLM backends the deployment can reach. Every chatbot's `model_slug` resolves against the `providers` and `provider_models` tables.

### `sw provider add <name> --protocol <protocol> [...]`

Register a new provider.

```
$ ./bin/sw provider add cortex --protocol ollama-native --base-url http://cortex.local:8000 --local
Created provider: id=1 name=cortex protocol=ollama-native base_url=http://cortex.local:8000 is_local=true is_metered=false

$ ./bin/sw provider add openrouter --protocol openrouter
Created provider: id=2 name=openrouter protocol=openrouter base_url=https://openrouter.ai/api/v1 is_local=false is_metered=true
```

Options:

| Flag                         | Meaning                                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------------- |
| `-p, --protocol <protocol>`  | **Required.** One of `ollama-native`, `openrouter`.                                           |
| `-u, --base-url <url>`       | Endpoint root. Required for `ollama-native`. Defaults to `https://openrouter.ai/api/v1` for `openrouter`. |
| `--local`                    | Marks the provider as LAN-only. Also defaults `is_metered` to false.                          |
| `--metered`                  | Force `is_metered=true` (overrides the `!is_local` default).                                  |
| `--unmetered`                | Force `is_metered=false` (e.g. a free-tier cloud provider). Mutually exclusive with `--metered`. |

`name` becomes the prefix in `model_slug` (`<name>/<model-id>`) — pick something short and URL-safe.

### `sw provider list`

List every provider with its protocol, base URL, local/metered flags, and the count of registered models.

```
$ ./bin/sw provider list
name        protocol       base_url                            local  metered  models
cortex      ollama-native  http://cortex.local:8000            yes    no       1
openrouter  openrouter     https://openrouter.ai/api/v1        no     yes      3
```

### `sw provider show <name>`

Dump the full DB row as JSON.

### `sw provider remove <name> -f|--force`

Hard-delete a provider and CASCADE through every model registered under it. **Irreversible**; `--force` is required.

```
$ ./bin/sw provider remove cortex --force
Removed provider name="cortex". Cascaded: 1 provider_model row(s).
```

Chatbots that still reference the removed provider via `model_slug` will start failing with `model_not_configured` on the next chat request — re-register the provider or point the chatbot at a different model.

### `sw provider models discover <name> [-f|--filter <substring>]`

Query a **live** provider endpoint for the list of models it can serve. The output prints copy-pasteable full slugs (provider name + `/` + model id) so you can paste them straight into `sw provider models add` and `sw chatbot set-model`.

Supported protocols:

- `ollama-native` — `GET {base_url}/api/tags`.
- `openrouter` — `GET {base_url}/models`. The discovery endpoint is public; no key is sent (BYO key only travels with the live chat path).

```
$ ./bin/sw provider models discover cortex
Models on provider "cortex" (protocol=ollama-native):
  cortex/qwen2:1.5b
  cortex/llama3.2:3b

Total: 2

$ ./bin/sw provider models discover openrouter --filter haiku
Models on provider "openrouter" (protocol=openrouter):
  openrouter/anthropic/claude-haiku-4.5     ctx=200000      Claude Haiku 4.5
  ...

Total: 3 (of 247 reported by the provider)
```

### `sw provider models add <provider> <model-slug> -c <n> [--input-price X] [--output-price Y]`

Register a model row under a provider. The combination of provider name + model slug is what chatbots resolve against.

```
$ ./bin/sw provider models add cortex qwen2:1.5b --context-window 4096
Added model: cortex/qwen2:1.5b context_window=4096 input=(unmetered) output=(unmetered)

$ ./bin/sw provider models add openrouter anthropic/claude-haiku-4.5 --context-window 200000 --input-price 1.0 --output-price 5.0
Added model: openrouter/anthropic/claude-haiku-4.5 context_window=200000 input=1.000000 output=5.000000
```

Pricing is per million tokens, in USD. Omit `--input-price` / `--output-price` for unmetered providers (Ollama).

### `sw provider models list <provider>`

List models registered locally against a provider (DB view, not a live query).

```
$ ./bin/sw provider models list openrouter
full slug                                  context   in $/M   out $/M
openrouter/anthropic/claude-haiku-4.5      200000    1.000000 5.000000
```

### `sw provider models remove <provider> <model-slug>`

Remove a single model row.

```
$ ./bin/sw provider models remove openrouter anthropic/claude-haiku-4.5
Removed model: openrouter/anthropic/claude-haiku-4.5
```

---

## `sw blocks`

### `sw blocks list <slug>`

Print the chatbot's assembled system blocks with per-block token estimates and a total. The persona (if set) appears first; remaining blocks are loaded from `data/chatbots/<slug>/*.md` in lexicographic filename order. See [`system-blocks.md`](system-blocks.md).

```
$ ./bin/sw blocks list acme-corp
Blocks for slug="acme-corp":
  PERSONA               ~342 tokens
  10-overview           ~480 tokens
  20-pricing            ~612 tokens
  30-faq                ~890 tokens
Total estimated tokens (including handling rule): ~2441
```

Tokens are estimated as `ceil(chars / 3)` — quick and cheap, not exact. Use the total to size-check against a chatbot's `model_context_window` before going live.

---

## `sw sessions`

Read-only browse over the session log. Useful for spot-checking what visitors have been saying during development. A richer review surface (filtering, redaction, retention sweeps) is on the post-pivot deferred list; these commands are the dev-time slice of that.

### `sw sessions list [-c|--chatbot <slug>] [-n|--limit <n>]`

List sessions, most-recently-active first. Defaults to 20 rows; `--limit` is capped at 200.

```
$ ./bin/sw sessions list --limit 3
 id  chatbot          token (prefix)     msgs  last_active               mode
331  acme-corp        241ae15bf2220e75…     5  2026-05-20T15:10:42.000Z  [admin]
282  acme-corp        1de6f38b6bdfda59…     8  2026-05-20T14:59:59.000Z
281  acme-corp        14d36acd82babc42…     6  2026-05-20T14:43:41.000Z

$ ./bin/sw sessions list --chatbot devx-headwall --limit 2
 id  chatbot        token (prefix)     msgs  last_active               mode
280  devx-headwall  25b3f834f7eea800…    10  2026-05-20T14:19:19.000Z
279  devx-headwall  98c2930d3a4b9d9a…     4  2026-05-20T13:35:56.000Z
```

The token prefix is the first 16 characters with an ellipsis — enough to spot the session you're after, never enough to be worth copying as auth. The `mode` column carries `[admin]` for sessions minted via `POST /admin/chatbots/{slug}/sessions` (M21); regular customer-facing sessions show an empty cell.

### `sw sessions show <token-or-id>`

Print a single session's metadata followed by its full message log. The argument is either the numeric `sessions.id` (digits only) or the full session token (64 hex chars).

```
$ ./bin/sw sessions show 280
Session 280 (chatbot "devx-headwall"):
  token:          25b3f834f7eea8003f02e354e974e46bf6a51a19b484385dfdd5064ad3b24f12
  created_at:     2026-05-17T13:41:04.000Z
  last_active_at: 2026-05-17T14:19:19.000Z
  summary:        (none)
  messages:       10

Messages:
  [161] 2026-05-17T13:41:07.000Z user: Hi again
  [162] 2026-05-17T13:41:18.000Z assistant: Hello! How can I assist you today?
  ...
```

Multi-line message bodies are indented under the header line so they read cleanly in a terminal.

---

## Exit codes

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| `0`  | success                                                      |
| `1`  | not-found (`show`, `show-model`, `blocks list` on a missing slug) |
| `1`  | validation failure (bad JSON, unknown provider, etc.) — the underlying error is printed to stderr |

`commander.js` itself returns non-zero for unknown commands and bad arguments.

## See also

- [`cli-chat.md`](cli-chat.md) — interactive test client that drives a configured chatbot end-to-end.
- [`env.md`](env.md) — the `.env` file the CLI reads (DB connection + `SW_ENCRYPTION_KEY`).
- [`system-blocks.md`](system-blocks.md) — how persona + disk blocks are assembled into the system prompt.
