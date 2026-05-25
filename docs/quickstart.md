# Quickstart — from running API to first chat

A walkthrough that takes a fresh site-walker installation from "the API is running, the landing card shows **System operational**, but there's nothing in the database" to "I can chat with a configured bot." Roughly 10 minutes.

This guide is a sequence, not a reference. For the full surface of any command, see [`cli-sw.md`](cli-sw.md). For the data model behind the steps, see [`../dev-notes/02-data-model.md`](../dev-notes/02-data-model.md). For everything the bot ends up reading, see [`system-blocks.md`](system-blocks.md).

## Assumptions

- The API is running and reachable. Hitting `/` in a browser shows the status card with **System operational** in green; hitting `/health` returns `{"ok": true, "db": true, ...}`.
- `.env` is configured for production: `DB_*` resolves to a reachable MariaDB, `SW_ENCRYPTION_KEY` is set (`./bin/sw secrets gen-key` if not), `chmod 0600 .env`.
- `npm run migrate` has been run (`/health` returning `db: true` confirms it).
- For the OpenRouter walkthrough below, you have an account at https://openrouter.ai and have generated an API key (`sk-or-…`). For an Ollama-only setup, no external account is needed.

All commands are run from the project root unless noted.

---

## 1. Create an account

Every chatbot belongs to an account. For a self-hosted single-tenant deploy, you'll typically have one account; for a SaaS-style multi-customer deploy, one per customer.

```
$ ./bin/sw account create acme
Account created: id=… slug=acme name=acme
```

The slug is the operator-facing handle (lowercase, alphanumeric, hyphens). `--name "Acme Corporation"` gives it a display name; defaults to the slug.

## 2. Create a chatbot in the account

```
$ ./bin/sw chatbot create acme-corp --account acme --name "Acme Pre-Sales"
Created chatbot: id=… slug=acme-corp account_id=… name="Acme Pre-Sales"
```

The `--account` flag is required — there is no fallback. One chatbot can belong to exactly one account.

## 3. Add an origin to the chatbot

The Origin allowlist is what authorises a browser to mint a session against this chatbot. Add every public URL the widget might be loaded from — typically the production site, plus any staging or dev URLs.

```
$ ./bin/sw chatbot origins add acme-corp https://www.acme-corp.example
Origin added: https://www.acme-corp.example
$ ./bin/sw chatbot origins add acme-corp https://staging.acme-corp.example
Origin added: https://staging.acme-corp.example
```

Origins are normalised (lowercased host, no trailing slash, http and https distinct). The first registered origin is also what `./bin/chat` will use by default when you test in step 9.

## 4. Add a provider

Providers are LLM backends. A fresh install has none registered. Two protocols are supported today: `openrouter` (cloud, metered, BYO key per chatbot) and `ollama-native` (LAN-only, unmetered).

**OpenRouter (recommended starting point — covers Anthropic, OpenAI, Google, Meta, …):**

```
$ ./bin/sw provider add openrouter --protocol openrouter
Created provider: id=… name=openrouter protocol=openrouter base_url=https://openrouter.ai/api/v1 is_local=false is_metered=true
```

The `base_url` defaults to OpenRouter's published endpoint; `is_metered` defaults to true because OpenRouter charges per token.

**Local Ollama (optional — useful for dev or Pi-hosted):**

```
$ ./bin/sw provider add cortex --protocol ollama-native --base-url http://cortex.local:8000 --local
Created provider: id=… name=cortex protocol=ollama-native base_url=http://cortex.local:8000 is_local=true is_metered=false
```

The provider `name` becomes the prefix in every model slug (`<provider>/<model-id>`). Pick something short and URL-safe.

## 5. Add models to the provider

Ask the provider what it can serve, then register the model(s) you want.

```
$ ./bin/sw provider models discover openrouter --filter haiku
Models on provider "openrouter" (protocol=openrouter):
  openrouter/anthropic/claude-haiku-4.5     ctx=200000      Claude Haiku 4.5
  …
```

Copy the full slug into `sw provider models add` along with the pricing (per million tokens, in USD — check OpenRouter's model card):

```
$ ./bin/sw provider models add openrouter anthropic/claude-haiku-4.5 \
    --context-window 200000 --input-price 1.0 --output-price 5.0
Added model: openrouter/anthropic/claude-haiku-4.5 context_window=200000 input=1.000000 output=5.000000
```

Pricing is what powers per-chat cost tracking (`sw chatbot usage` and the M20 budget caps). Omit `--input-price` / `--output-price` only for unmetered providers (Ollama).

## 6. Configure the chatbot to use a model

Point the chatbot at a `provider/model` slug from your registry:

```
$ ./bin/sw chatbot set-model acme-corp openrouter/anthropic/claude-haiku-4.5
Set model_slug="openrouter/anthropic/claude-haiku-4.5" for chatbot slug="acme-corp".
```

The slug is validated against the DB: if either half doesn't resolve, the command refuses with a pointer back to `sw provider add` / `sw provider models add`.

## 7. Set the chatbot's API key (metered providers only)

**This step is non-optional for metered providers.** Without an API key, `POST /chat` will refuse with `503 chatbot_api_key_missing`. site-walker uses per-chatbot BYO keys — your OpenRouter key never sits in a global config, only in encrypted columns on this chatbot's row.

The command reads from stdin so the key never appears in argv or shell history:

```
$ echo "sk-or-v1-…" | ./bin/sw chatbot set-api-key acme-corp
Set api_key for chatbot slug="acme-corp" (… bytes stored encrypted).
```

Or from a file:

```
$ ./bin/sw chatbot set-api-key acme-corp < ~/secrets/openrouter-acme.txt
```

Skip this step entirely for Ollama / unmetered providers.

## 8. Set model parameters (optional)

Temperature, max_tokens, top_p, stop sequences. Validated against a strict schema.

```
$ ./bin/sw chatbot set-parameters acme-corp '{"temperature":0.4,"max_tokens":1000}'
Set model_parameters for chatbot slug="acme-corp": {"temperature":0.4,"max_tokens":1000}
```

Sensible starting point for a pre-sales bot: `temperature` 0.3–0.5 (focused, not stuffy), `max_tokens` 800–1500 (long enough to be useful, short enough to keep cost predictable). Tune from there. Pass `'{}'` to clear.

## 9. Set budget caps (highly recommended)

The single most important "this can't ruin a customer's week" guarantee. Caps are per-chatbot, in USD.

```
$ ./bin/sw chatbot set-budget acme-corp --daily 5.00 --session 1.00 --threshold 80
Updated budgets for chatbot "acme-corp":
  daily_budget_usd:         5.0000
  session_budget_usd:       1.0000
  handoff_threshold_pct:    80
```

- **`--daily 5.00`** — once today's customer-only spend (UTC midnight to now) hits $5, no new sessions mint. Already-in-flight sessions ride out their own session cap.
- **`--session 1.00`** — each individual conversation caps at $1. Past 80% (`--threshold`), the soft-handoff hint is injected. At $1, the session terminates with a final natural reply.
- **Don't set caps if you don't want to.** Both default to NULL (unbounded). For a development or trusted-team chatbot that's fine; for anything customer-facing, set them.

For a feel of the numbers: a 9-turn chat with a small system block runs ~$0.01–0.08 depending on model and prompt size. $1/session is roomy; $5/day caps the blast radius at no more than ~$10 effective worst-case (daily cap + a few sessions burning out their session cap concurrently).

## 10. Add a welcome message, persona, and system blocks (recommended)

These are what give the bot its voice and knowledge. All optional in the strict sense — the bot will run without them, but it won't know anything useful.

**Welcome message** (the first thing the visitor sees):

```
$ ./bin/sw chatbot set-welcome acme-corp "Hi! I help with questions about Acme's widget assemblies. What can I help with?"
```

**Persona** (how the bot speaks — tone, role, what it should refuse). A default persona was seeded from [`templates/PERSONA.md`](../templates/PERSONA.md) when the chatbot was created in step 2; replace it with one tailored to the customer:

```
$ ./bin/sw chatbot set-persona acme-corp "$(cat persona-acme.md)"
```

**System blocks** — markdown files under `data/chatbots/acme-corp/`. One topic per file: `10-overview.md`, `20-products.md`, `30-pricing.md`, `40-faq.md`, etc. Full design + token-budget interplay in [`system-blocks.md`](system-blocks.md).

```
$ mkdir -p data/chatbots/acme-corp
$ $EDITOR data/chatbots/acme-corp/10-overview.md
$ ./bin/sw blocks list acme-corp        # sanity-check token totals
Blocks for slug="acme-corp":
  PERSONA               ~340 tokens
  10-overview           ~480 tokens
Total estimated tokens (including handling rule): ~870
```

No reload step — the loader re-reads disk on every chat turn.

**Optional:** `HANDOFF_SOFT.md` (operator-customisable soft-handoff nudge, fires at 80% of session cap) and `HANDOFF_HARD.md` (canned post-termination response). Both default to built-in fallbacks if you don't write them. See [`system-blocks.md`](system-blocks.md).

## 11. Test

Two ways to verify end-to-end:

**Interactive (CLI):**

```
$ ./bin/chat acme-corp
Session: 9b3f… on https://www.acme-corp.example
> What does Acme sell?
Acme sells modular widget assemblies for industrial automation lines. …
> /quit
```

`./bin/chat` resolves the chatbot's first allowlisted origin automatically. See [`cli-chat.md`](cli-chat.md) for the full error vocabulary it surfaces (rate limits, context overflow, etc.).

**`curl` (HTTP, the way a real widget will hit it):**

```
$ curl -sX POST https://api.example.com/sessions \
    -H 'Origin: https://www.acme-corp.example' \
    | tee /tmp/session.json
{"session_token":"9b3f…","welcome_message":"Hi! I help with…"}

$ TOKEN=$(jq -r .session_token /tmp/session.json)
$ curl -sX POST https://api.example.com/chat \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"message":"What does Acme sell?"}'
{"reply":"Acme sells modular widget assemblies…", "message_id": 42, …}
```

If both work, the chatbot is live and you can hand off to the integrator who'll install the WordPress plugin (or whatever frontend).

---

## What next

- **Look around with the CLI**: `sw chatbot show acme-corp`, `sw chatbot show-model acme-corp`, `sw chatbot usage acme-corp --since 24h`, `sw sessions list -c acme-corp`. Full reference in [`cli-sw.md`](cli-sw.md).
- **Optional: operational hours** — `sw chatbot set-timezone` + `sw chatbot set-hours` if the bot should refuse mints outside business hours. See [`cli-sw.md`](cli-sw.md#sw-chatbot-set-hours-slug-none).
- **Optional: geo policy** — `sw chatbot set-geo-mode` + `sw chatbot set-geo-countries` for allow/block by country. Requires a MaxMind GeoIP DB at `GEOIP_DB_PATH` ([`env.md`](env.md)).
- **Optional: handoff webhook** — `sw chatbot set-handoff-webhook <url>` so your CRM is pinged when a session terminates and the visitor leaves an email.
- **For WP plugin / HTTP-driven admin**: mint an account admin key with `sw account add-admin-key <account-slug>`. The raw key is shown exactly once. Full HTTP surface in [`api-admin.md`](api-admin.md).
- **Operator config samples**: [`../etc/apache-reverse-proxy.conf.example`](../etc/apache-reverse-proxy.conf.example) for fronting the API at a public HTTPS endpoint; [`../ecosystem.config.sample.cjs`](../ecosystem.config.sample.cjs) for PM2.

## Troubleshooting

- **`POST /chat` returns `503 chatbot_api_key_missing`** — step 7 wasn't run, or was run for the wrong slug. Confirm with `sw chatbot show acme-corp` (the field shows whether a key is set; never shows the value).
- **`POST /chat` returns `503 model_not_configured`** — `model_slug` is unset or points at a provider/model row that doesn't exist. `sw chatbot show-model acme-corp` and `sw provider models list <provider>` will diverge.
- **`POST /sessions` returns `403 origin_not_allowed`** — the `Origin` header doesn't match anything in `chatbot_origins`. `sw chatbot origins list acme-corp` shows what's actually registered; remember origins are normalised (lowercased, no trailing slash, http and https distinct).
- **`POST /sessions` returns `402 budget_exhausted_daily`** — daily cap hit. `sw chatbot usage acme-corp --since 24h` shows what was spent. Raise the cap with `sw chatbot set-budget --daily <higher>` or wait for the next UTC midnight.
- **`POST /sessions` returns `503 chatbot_closed`** — operational hours configured and the request is outside an open window. `sw chatbot show acme-corp` shows the `availability` JSON. Clear with `sw chatbot set-hours acme-corp none` for testing.
- **`/health` returns `db: false`** — MariaDB is unreachable. Check `.env` `DB_*` values, that the service is running, and that the user has access (`source .env ; mysql -u "${DB_USER}" -p"${DB_PASSWORD}" -h "${DB_HOST}" "${DB_NAME}"`).
- **Boot fails with `Env file .env must be mode 0600`** — `chmod 0600 .env`.
- **Boot fails on `SW_ENCRYPTION_KEY`** — generate with `./bin/sw secrets gen-key`, paste into `.env`. Don't lose it; the chatbot BYO keys decrypt against it.
