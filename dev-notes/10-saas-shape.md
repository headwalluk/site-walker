# SaaS shape

Settled 19 May 2026. This doc captures the architectural reset that takes site-walker from "useful prototype" to "real-world SaaS product." Everything shipped through v0.11.0 was prototype-grade — proving the chat backbone, system-block model, and provider abstraction can carry real traffic. This doc describes what changes from here onward.

Companion to [`00-project-tracker.md`](00-project-tracker.md), which now uses the milestone numbering settled here (M16–M20).

---

## What's changing, in one sentence

site-walker becomes a multi-tenant SaaS billed via a WooCommerce site at `https://site-walker.net`, with the chat API itself remaining open source and self-hostable. Customers bring their own LLM provider credentials; the platform meters their usage, enforces budgets, and never holds shared LLM-provider keys.

---

## Four-repo topology

The product lives in four repositories. Three open, one closed.

| Repo                              | Visibility   | Audience                | Job                                                                                         |
|-----------------------------------|--------------|-------------------------|---------------------------------------------------------------------------------------------|
| `headwalluk/site-walker`          | Open source  | self-hosters + us       | **This repo.** The chat API. `api.site-walker.net` runs an instance.                        |
| `headwalluk/site-walker-wp`       | Open source  | client websites         | WP plugin that embeds the chat widget on a customer's site. Pushes content + settings via admin HTTP API. |
| `headwalluk/site-walker-for-woo`  | Closed       | `site-walker.net` only  | WC plugin on the SaaS site. Provisions API accounts + mints admin keys when WC subscriptions activate. |
| (the WC site itself)              | n/a          | end customers           | Marketing, signup, subscription billing. Customer-facing dashboard lives in WC MyAccount.   |

**Self-hoster path:** clone this repo, configure via CLI, install `site-walker-wp` on the customer's own WP site, paste in the self-hosted API URL. No `site-walker-for-woo`, no subscription, no MyAccount.

**SaaS path:** customer signs up at `site-walker.net`, WC subscription activates, `site-walker-for-woo` calls our admin HTTP API with a provisioning key to create an account + mint an admin key. Customer copies the admin key into `site-walker-wp` on their own site.

The split is deliberate: nothing customer-facing lives in this repo. Subscription/billing/account-UI complexity is WooCommerce's problem, not ours.

---

## Account model

A new top-level entity sits above today's `chatbots` (née `websites`).

```
accounts ──< chatbots ──< chatbot_origins
                       ──< sessions ──< messages
```

- **One account → many chatbots.** Agencies serve multiple clients; one account holds them all.
- **One chatbot → many origins.** Already true today. Multi-brand customers benefit from a single chatbot serving four sibling websites with shared system blocks — confirmed real use case (a four-brand printer-supplies group).
- **Billing is per-account, not per-chatbot.** Plan tiers may eventually constrain chatbot count per account, but the unit of subscription is the account.

The rename `websites` → `chatbots` (table + columns + services + CLI) ships in M16. It's the last cheap moment to do it; once admin HTTP endpoints publish, the name is part of our customer-facing contract.

---

## Authentication — three actor classes, two key types

site-walker now has three actors talking to it:

1. **Browser/widget visitor** — unchanged. `Origin` allowlist + opaque session token. See [`01-auth-and-session-flow.md`](01-auth-and-session-flow.md).
2. **`site-walker-wp` plugin** — server-to-server. Uses an **account admin key** to push system blocks, manage origins, set budget, fetch usage.
3. **`site-walker-for-woo` (on `site-walker.net`)** — server-to-server. Uses the **deployment provisioning key** to create accounts and mint admin keys.

### Two key types

**Provisioning key.** One per deployment. Configured server-side — concrete bootstrap mechanism is the M19 open question tracked in [`00-project-tracker.md`](00-project-tracker.md) (env var vs CLI-minted DB row vs first-boot auto-seed). Lets the holder call `POST /admin/accounts` and `POST /admin/accounts/{id}/keys`. Does **not** grant access to the contents of any account.

**Account admin key.** One or more per account. Minted by either the provisioning key (SaaS path, via `POST /admin/accounts/{id}/keys`) or the CLI (self-hoster path, via `sw account add-admin-key <account-slug>` which inserts a hashed row and prints the raw key once — GitHub-PAT style). Bearer-auth on `POST /admin/...`. Grants full control of **that account only** — chatbots, origins, persona, model selection, blocks, budgets, usage. Cannot see or touch other accounts.

That's the entire authorization model for v1. Read/write scopes, viewer roles, team memberships, etc. — all deferred. The provisioning/admin distinction is the load-bearing one; finer-grained scopes are YAGNI until a concrete need surfaces.

### Why pre-shared keys, not OAuth

OAuth would give a better "click to connect" UX in WP admin but requires us to be an OAuth provider and the plugin to be an OAuth client. Real work. Customers copy-paste a pre-shared key the same way they do for Stripe, Mailchimp, Akismet — friction is low, expectation is set.

OAuth-style linking is a polish milestone post-launch if anyone asks.

---

## Bring-your-own-key (BYO)

Each chatbot stores its own LLM provider API key. No provider-level fallback, no shared keys, no "if absent, use this other one." Two reasons:

1. **Cost attribution is unambiguous.** Customer X's chats hit customer X's Anthropic account, full stop. If their key is missing or invalid, the chat fails loudly with `chatbot_api_key_missing` and we can point at exactly which chatbot needs attention.
2. **No shared-secret blast radius.** A leaked customer key compromises one customer's provider account, never ours and never another customer's.

The platform never holds a shared LLM-provider credential. Self-hosters with only one chatbot just set the key on that one chatbot — same code path as SaaS customers.

### Storage

Encrypted at rest in `chatbots.provider_api_key_ciphertext` + `chatbots.provider_api_key_nonce`. AES-256-GCM via Node's built-in `crypto`, per-row nonce.

The master encryption key lives in `.env` as `SW_ENCRYPTION_KEY`, base64-encoded, 32 bytes. Boot fails loud if missing or wrong length. `.env` is already `0600`-gated (existing rule), so the security posture matches what we had with TOML — the file holding the key still has the same permission story; only the file's role has narrowed.

A `sw secrets gen-key` CLI command generates a fresh key and prints it for the operator to paste into `.env`.

**Key rotation is out of scope for v1.** If a `SW_ENCRYPTION_KEY` is ever compromised, the recovery path is: generate a new key, update `.env`, and re-run `sw chatbot set-api-key` on every chatbot. Existing ciphertexts encrypted under the old key become unreadable and chats against them fail loud with `chatbot_api_key_missing` (same code path as a never-set key). No silent re-encryption migration, no dual-key fallback chain — fail loud, operator handles it. Acceptable for a v1 with a small customer count; revisit if the customer base grows enough to make a one-time bulk re-set painful.

### CLI

- `sw chatbot set-api-key <slug>` — reads key from stdin (never argv, never logged), encrypts, stores.
- `sw chatbot show` redacts the key entirely; no display path. If the operator needs to verify, they re-set it.

---

## Provider registry moves to the database

Today's `site-walker.toml` is killed entirely in M17. Provider entries, model entries, and pricing all move to MariaDB so we can add/remove/reprice without restarting the API.

### New tables

**`providers`**

| Column         | Type             | Notes                                                                |
|----------------|------------------|----------------------------------------------------------------------|
| `id`           | `INT UNSIGNED`   | PK                                                                   |
| `name`         | `VARCHAR(64)`    | UNIQUE. The slug prefix used in `chatbots.model_slug` (e.g. `cortex`, `openrouter`). |
| `protocol`     | `VARCHAR(32)`    | `ollama-native`, `openrouter`, etc.                                  |
| `base_url`     | `VARCHAR(255)`   | Endpoint root.                                                       |
| `is_local`     | `BOOLEAN`        | True for LAN-only Ollama. Drives M11 (rate-limit tuning) decisions.  |
| `is_metered`   | `BOOLEAN`        | True iff using this provider costs money. Drives BYO-key enforcement (NULL chatbot key against a metered provider = fail). Default `!is_local`. |
| `created_at`, `updated_at` | `DATETIME` |                                                                  |

No `api_key` column. Provider-level keys do not exist.

**`provider_models`**

| Column                       | Type             | Notes                                                                              |
|------------------------------|------------------|------------------------------------------------------------------------------------|
| `id`                         | `INT UNSIGNED`   | PK                                                                                 |
| `provider_id`                | `INT UNSIGNED`   | FK → `providers.id`, CASCADE.                                                      |
| `model_slug`                 | `VARCHAR(128)`   | The part after the slash in `chatbots.model_slug` (e.g. `qwen2:1.5b`, `anthropic/claude-haiku-4.5`). |
| `context_window`             | `INT UNSIGNED`   | Total context tokens. Drives the M6 12.5%/512-floor budget check.                  |
| `input_per_million_usd`      | `DECIMAL(10,6)`  | Pricing for input tokens. NULL for unmetered providers (Ollama).                   |
| `output_per_million_usd`     | `DECIMAL(10,6)`  | Pricing for output tokens. NULL for unmetered.                                     |
| `is_available`               | `BOOLEAN`        | Soft-disable. True by default.                                                     |
| `created_at`, `updated_at`   | `DATETIME`       |                                                                                    |
| UNIQUE `(provider_id, model_slug)` |            | Same model can exist under multiple providers (e.g. Claude via Anthropic *and* OpenRouter). |

### CLI

- `sw provider add <name> --protocol <p> --base-url <url> [--local] [--metered]`
- `sw provider list/show/remove`
- `sw provider model add <provider> <model_slug> --context-window N --input-price X --output-price Y`
- `sw provider model list/remove`

No `sw provider import-toml` — we're pre-release, only the dev box has a TOML to migrate, and we recreate it manually.

### No caching in M17

Provider lookup is two small joined queries per `POST /chat`. The LLM call dominates by 3–4 orders of magnitude. Adding a cache before profiling shows it matters is premature.

If profiling later shows the lookup is hot, M11's Redis work absorbs it (cluster-safe) with an in-memory fallback for single-process dev. Same code path either way. Not M17's problem.

---

## Cost accounting

Lands in M18 as a foundation milestone with no enforcement. Just observability.

**On every assistant message** we record:

- `messages.tokens_in` — prompt tokens consumed
- `messages.tokens_out` — completion tokens generated
- `messages.cost_usd_estimate` — `(tokens_in × input_price + tokens_out × output_price) / 1_000_000`, computed locally from `provider_models` pricing

The cost is an **estimate**. Ground truth is the customer's Anthropic / OpenRouter invoice. Our number will run slightly under (we don't count system-side overhead the provider does). Close enough for cap enforcement; we surface this in the docs so customers aren't surprised when our number doesn't reconcile to the penny.

**Unmetered providers (Ollama).** Tokens are still recorded (visibility into usage shape), but `cost_usd_estimate` is written as `0.00`, **not `NULL`**, when the provider's `provider_models` pricing columns are NULL. Reason: downstream `SUM(cost_usd_estimate)` for usage views and M20 budget checks stays a one-liner — no `COALESCE`, no per-row branching. The pricing columns staying NULL is the data-model signal that "this provider doesn't charge"; the message row staying 0 is the query-layer convenience.

**Adapter contract update:** every adapter returns `{ tokens_in, tokens_out }` on chat response. Already partially there for `ollama-native` and `openrouter` via `tokens_used`; M18 locks the shape and surfaces both halves.

**Query patterns:**

- Daily spend for chatbot X = `SUM(messages.cost_usd_estimate) WHERE messages.session_id IN (sessions of chatbot X) AND created_at >= today_start_in_tz`
- Session spend = `SUM(messages.cost_usd_estimate) WHERE session_id = ?`

To keep the daily query fast, we **denormalise `chatbot_id` onto `messages`** in the M18 migration. Tiny schema cost, big query win.

CLI: `sw chatbot usage <slug> [--since 24h]` shows running totals.

---

## Budget caps

Lands in M20 once cost accounting has been measuring for a while.

**Per-chatbot:**

- `chatbots.daily_budget_usd` — nullable, NULL = no cap
- `chatbots.session_budget_usd` — nullable, NULL = no cap

**Enforcement points:**

| Endpoint                       | Daily cap | Session cap | On exhaustion                                  |
|--------------------------------|-----------|-------------|------------------------------------------------|
| `GET /sessions/can-start`      | Check     | n/a         | `{ available: false, reason: 'budget_exhausted_daily' }` |
| `POST /sessions`               | Check     | n/a         | `402 budget_exhausted_daily`                   |
| `POST /chat`                   | Check     | Check after writing assistant reply | `402 budget_exhausted_daily` or `_session` |

Session cap is checked **after** the assistant reply is written, deliberately: a visitor who's one message over cap gets one final reply rather than being cut off mid-thought. The next message in that session gets the 402.

Optional add-on if cheap: `getBalance()` on adapters that support it (OpenRouter's `/key` endpoint exposes limit/usage cleanly; Anthropic doesn't, so it returns `null`). CLI command `sw chatbot balance <slug>` surfaces it. Read-only, never on the hot path.

---

## Admin HTTP API surface (preview)

Full design ships with M19. Sketch of the routes for orientation:

```
POST   /admin/accounts                          (provisioning key only)
POST   /admin/accounts/{id}/keys                (provisioning key only)
GET    /admin/chatbots                          (lists chatbots in the auth'd account)
POST   /admin/chatbots
GET    /admin/chatbots/{id}
PATCH  /admin/chatbots/{id}                     (welcome, model, persona, schedule, budgets)
DELETE /admin/chatbots/{id}
POST   /admin/chatbots/{id}/origins
DELETE /admin/chatbots/{id}/origins/{originId}
PUT    /admin/chatbots/{id}/blocks/{name}       (advanced-mode manual block push)
DELETE /admin/chatbots/{id}/blocks/{name}
PATCH  /admin/chatbots/{id}/api-key             (BYO key set; body via TLS, never logged)
GET    /admin/chatbots/{id}/usage               (token + $ totals, by day)
```

All bearer-auth. Scoped by the admin key's `account_id`. Re-uses the same service layer the CLI uses — no duplication.

OpenAPI schema served at `/openapi.json` as today, augmented with the admin surface.

---

## Renumbered milestone phasing

Old M11–M15 numbering is replaced by the post-pivot phasing. Everything pre-prototype (M1–M11, v0.11.0) stays as-is in the tracker — that's history.

| Milestone | Job                                                                            |
|-----------|--------------------------------------------------------------------------------|
| **M16**   | Multi-tenant + rename: `websites` → `chatbots`, `accounts` table, account ownership of chatbots. |
| **M17**   | DB provider registry + chatbot BYO keys + kill `site-walker.toml`. Encryption-at-rest infrastructure (`SW_ENCRYPTION_KEY`). |
| **M18**   | Cost accounting (foundation, no enforcement). Token + $ per message. CLI usage views. |
| **M19**   | Admin HTTP API + bearer-token auth (provisioning + account admin keys, `admin_keys` table). |
| **M20**   | Budget caps (daily + per-session). 402 error semantics. Optional balance fetch. |

After M20 the real client is live. Things explicitly deferred until after that:

- **Auto-mode content ingestion** + verbose-MD push from the plugin.
- **Condensation pipeline** (premium-model summarisation of customer content into system blocks). Big enough to be its own milestone cluster.
- **Operational hours / schedule.** Plugin-side enforcement may carry it for v1.
- **OAuth-style plugin linking** to replace pre-shared keys.
- **Customer-facing dashboard.** Lives in WC MyAccount via `site-walker-for-woo`; not in this repo.

The old M9 (history trimming), M11 (rate limiting + Redis), M12 (prompt-injection handling), M13 (conversation review/retention), M14 (production deployment), M15 (friendlier CLI errors) are still real but renumber-deferred. They surface as concrete work when the M16–M20 cut has been measured against a real customer.

---

## Auto-mode content ingestion (sketch, post-launch)

Captured here so the design intent isn't lost. Detailed design is a future doc.

**Flow:**

1. In WP admin, the customer selects content (pages, posts, products) the chatbot should know about.
2. `site-walker-wp` generates **verbose markdown** per content item (a WooCommerce variable product becomes a markdown table of variations, etc.).
3. The plugin pushes these per-source files to `PUT /admin/chatbots/{id}/source-content/{source-id}` along with a content hash.
4. API dedupes by hash; only changed/new items are queued for condensation.
5. Condensation runs against the **customer's own provider key** (not ours), using a premium model (Opus/GPT-5-class), one source at a time. Aligns incentives; we never hold the cost of a customer's catalogue.
6. Condensed output becomes a system block: `data/websites/<slug>/<source-id>.md`. Same on-disk layout as today's manual blocks.

**Commercial framing for the customer:** "Your context is large — optimising once now will reduce the cost of every future chat. There's a small one-off cost against your provider account. Recommended." Eventually folds into a guided onboarding flow on `site-walker.net`.

**Open architectural choices** (decide when this milestone lands):

- Push-triggered (responsive, needs a job queue) vs scheduled cron (simpler, eventual consistency lag).
- Status surfaces (the plugin's "47 sources, 12 condensed, 35 pending"): polling vs callbacks.
- Cost ceiling per-condensation-run, to protect the customer from runaway summarisation costs on a giant catalogue.
- Source-content schema: probably another table (`chatbot_source_content`) with `chatbot_id`, `source_id`, `hash`, `raw_markdown`, `condensed_block_name`, `last_condensed_at`.

---

## What this doc is not

- **Not a sales pitch.** README still does that; it gets rewritten after M16 lands, not before.
- **Not the data model spec.** [`02-data-model.md`](02-data-model.md) is the schema reference; it will be expanded as M16/M17/M18/M20 each add tables.
- **Not a deployment guide.** That's the M14 work, which carries forward post-pivot.

This is the architecture-level "where are we going and why," for orientation when picking up a milestone.
