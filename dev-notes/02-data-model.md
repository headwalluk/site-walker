# Data model

Schema reference for v1.0 — the post-M16 shape. Drafted 20 May 2026 as the M16 design pass, ahead of execution.

This doc is the **authoritative** schema reference. Pre-M16 (v0.11.0) is preserved in two places only: git history of this file, and [`db-schema-pre-m16.sql`](db-schema-pre-m16.sql), a `mysqldump --no-data` snapshot taken before the squash.

MariaDB syntax. InnoDB, `utf8mb4` charset, `utf8mb4_uca1400_ai_ci` collation (carry forward — MariaDB's modern Unicode CI/AI collation; matches existing tables exactly). Timestamps are `TIMESTAMP` with `DEFAULT CURRENT_TIMESTAMP`; updated-at columns add `ON UPDATE CURRENT_TIMESTAMP`.

Companion docs:
- [`00-project-tracker.md`](00-project-tracker.md) — M16 milestone scope
- [`10-saas-shape.md`](10-saas-shape.md) — architectural why for accounts/BYO-keys/admin-keys; documents M17–M20 columns/tables that get folded back into this doc as each ships
- [`01-auth-and-session-flow.md`](01-auth-and-session-flow.md) — auth/session protocol (gets a parallel rename pass during M16 execution)

---

## What M16 changes (versus v0.11.0)

| Change          | Before                | After                  |
|-----------------|-----------------------|------------------------|
| **Add**         | —                     | `accounts`             |
| **Rename**      | `websites`            | `chatbots`             |
| **Rename**      | `website_origins`     | `chatbot_origins`      |
| **Rename**      | `website_geo_countries` | `chatbot_geo_countries` |
| **Column rename** | `sessions.website_id` | `sessions.chatbot_id` |
| **Add column**  | —                     | `chatbots.account_id` (NOT NULL, FK) |
| **Carry forward** | `messages`          | `messages`             |
| **Carry forward** | `geo_modes`         | `geo_modes` (with same 3 seed rows) |

`messages` is unchanged at M16. M18 (cost accounting) adds `chatbot_id` (denormalised), `tokens_in`, `tokens_out`, `cost_usd_estimate` as an additive migration.

No `provider_*` tables and no encrypted-key columns on `chatbots` at M16 — those land in M17 as additive migrations.

---

## Entity overview

```
accounts ──< chatbots ──< chatbot_origins
                       ──< chatbot_geo_countries
                       ──< sessions ──< messages
                          (geo_modes is referenced by chatbots.geo_mode_id, RESTRICT)
```

All `──<` edges are `ON DELETE CASCADE`. Cascading from `accounts` therefore unwinds the entire owned subtree. `geo_modes` is a small lookup table; the FK from `chatbots.geo_mode_id` is RESTRICT — you can't delete a geo mode that any chatbot is using.

---

## `accounts`

New top-level entity. One account owns many chatbots; billing is per-account (in WooCommerce, not here).

| Column        | Type             | Constraints                          | Notes                                              |
|---------------|------------------|--------------------------------------|----------------------------------------------------|
| `id`          | `CHAR(36)`       | PK                                   | UUID v4, generated server-side via Node's `crypto.randomUUID()`. Lowercase canonical form (`xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`). Stored as `CHAR(36)` for SQL-prompt readability over the `BINARY(16)` packed form — at the SaaS scale we're targeting (dozens-to-low-hundreds of accounts) the 20-byte storage delta and join cost are negligible compared to the operator-debugging win. |
| `slug`        | `VARCHAR(64)`    | NOT NULL, UNIQUE                     | URL-safe identifier. Same grammar as `chatbots.slug` — lowercase, `[a-z0-9-]`, no leading/trailing hyphen, max 64. **Used by the CLI only**, not in HTTP routes. SaaS path: `site-walker-for-woo` generates one from the WC subscription. Self-host path: operator picks one. |
| `name`        | `VARCHAR(255)`   | NOT NULL                             | Human-readable.                                    |
| `created_at`  | `TIMESTAMP`      | NOT NULL, DEFAULT CURRENT_TIMESTAMP  |                                                    |
| `updated_at`  | `TIMESTAMP`      | NOT NULL, DEFAULT CURRENT_TIMESTAMP, ON UPDATE CURRENT_TIMESTAMP | |

Indexes: `id` PK, `slug` UNIQUE.

**Why UUID for the PK** (resolved 2026-05-20): `accounts.id` is the identifier exchanged with WordPress/WooCommerce on `site-walker.net` — the WC plugin stores it against the WC user record to link a paying subscriber to their site-walker account. An opaque, non-enumerable identifier is the right shape for that. It's also what shows up in admin HTTP API routes (e.g. `POST /admin/accounts/{id}/keys`). For chatbots (next section), the PK stays `INT UNSIGNED` because chatbots already carry a `slug` that serves the same human-stable, URL-safe job — they don't need a second identifier on top.

**Why no `external_id` / `wc_subscription_id` here:** the `site-walker-for-woo` plugin maintains its own mapping from WC subscription → site-walker account UUID. Keeping that mapping out of this DB preserves the "self-hoster has no WC dependency" invariant. If the bookkeeping ever needs to live here, M19's admin HTTP endpoints will surface the right place to add it.

**No `description` / `notes` / `email`:** YAGNI for v1. Easy to add as an additive migration once a concrete need surfaces.

**No soft-delete at M16.** `deleteAccount` hard-deletes and CASCADEs through the owned subtree. Soft-delete (a `deleted_at` column, a "preserve chatbot data for old accounts" mode) is a real future need but explicitly deferred — adding it post-hoc is a clean additive migration. Flagged as a known follow-up.

---

## `chatbots` (was `websites`)

One row per chatbot (a deployed bot, possibly serving multiple sibling sites via multiple origins).

| Column                   | Type             | Constraints                          | Notes                                                                                              |
|--------------------------|------------------|--------------------------------------|----------------------------------------------------------------------------------------------------|
| `id`                     | `INT UNSIGNED`   | PK, AUTO_INCREMENT                   | Stays an internal INT — chatbots are addressed externally by `slug`, never by numeric id.          |
| `account_id`             | `CHAR(36)`       | NOT NULL, FK → `accounts.id` ON DELETE CASCADE | Every chatbot belongs to exactly one account. Self-hosters create one account first. UUID matches `accounts.id` shape. |
| `slug`                   | `VARCHAR(64)`    | NOT NULL, UNIQUE                     | URL-safe identifier, e.g. `acme-corp`. Used in CLI and on-disk paths (`data/chatbots/<slug>/`).    |
| `name`                   | `VARCHAR(255)`   | NOT NULL                             | Human-readable.                                                                                    |
| `welcome_message`        | `TEXT`           | NULL                                 | Returned by `POST /sessions`. NULL → app-default fallback.                                         |
| `persona`                | `TEXT`           | NULL                                 | Emitted by the M4 system-blocks loader as the first `<block name="PERSONA">`. Seeded from `templates/PERSONA.md` at chatbot-create time. |
| `model_slug`             | `VARCHAR(128)`   | NULL                                 | E.g. `cortex/qwen2:1.5b`. See [`03-llm-providers.md`](03-llm-providers.md) (M17 moves the registry to DB, slug grammar unchanged). NULL until set by admin. |
| `model_parameters`       | `JSON` (LONGTEXT + JSON_VALID check, knex-style) | NULL | Normalised parameter object (`temperature`, `top_p`, `max_tokens`, `stop`). NULL = adapter defaults. |
| `model_context_window`   | `INT UNSIGNED`   | NULL                                 | Operator-declared total context tokens for the chosen model. Drives context-fit validation in the chat path. |
| `geo_mode_id`            | `INT UNSIGNED`   | NOT NULL, DEFAULT 1 (= `allowall`), FK → `geo_modes.id` (RESTRICT) | Determines how `chatbot_geo_countries` is interpreted. |
| `created_at`             | `TIMESTAMP`      | NOT NULL, DEFAULT CURRENT_TIMESTAMP  |                                                                                                    |
| `updated_at`             | `TIMESTAMP`      | NOT NULL, DEFAULT CURRENT_TIMESTAMP, ON UPDATE CURRENT_TIMESTAMP | |

Indexes:
- `slug` UNIQUE (declared above)
- `account_id` (FK auto-indexed; named `chatbots_account_id_index` for clarity)
- `geo_mode_id` (FK auto-indexed)

**Account-id placement (first columnar position after `id`):** convention — every tenant-scoped table has its scoping FK immediately after the PK so `\d chatbots` reads naturally.

**Why three model columns and not one JSON blob:** unchanged rationale from v0.11.0. `model_slug` and `model_context_window` are looked up on every request and need to be queryable. `model_parameters` is opaque to MariaDB and stays JSON.

**M17 will add** (additive migration, not in the M16 greenfield): `provider_api_key_ciphertext VARBINARY(...)`, `provider_api_key_nonce VARBINARY(12)`. **M20 will add**: `daily_budget_usd DECIMAL(10,4) NULL`, `session_budget_usd DECIMAL(10,4) NULL`. Both flagged here so the column order discussion happens once.

---

## `chatbot_origins` (was `website_origins`)

Allowlist of `Origin` headers that may create sessions for a given chatbot. One chatbot can have many origins (cross-brand sharing).

| Column         | Type             | Constraints                          | Notes                                                |
|----------------|------------------|--------------------------------------|------------------------------------------------------|
| `id`           | `INT UNSIGNED`   | PK, AUTO_INCREMENT                   |                                                      |
| `chatbot_id`   | `INT UNSIGNED`   | NOT NULL, FK → `chatbots.id` ON DELETE CASCADE | |
| `origin`       | `VARCHAR(255)`   | NOT NULL, UNIQUE (globally)          | Normalised: lowercase host, no trailing slash, no path/query. See `src/services/websites.ts::normaliseOrigin` (renamed in M16). |
| `created_at`   | `TIMESTAMP`      | NOT NULL, DEFAULT CURRENT_TIMESTAMP  |                                                      |

Indexes:
- `origin` UNIQUE (declared above) — global uniqueness; an origin cannot serve two different chatbots simultaneously
- `chatbot_id` (FK auto-indexed)

**Global uniqueness of `origin`:** carries forward from v0.11.0. Two chatbots cannot both claim `https://example.com`. This is intentional: the `Origin` header is the *only* signal we have for "which chatbot does this browser belong to" — ambiguity would be a routing bug we can't recover from.

**Normalisation rules** (enforced by `normaliseOrigin` in `src/services/chatbots.ts` — renamed from `websites.ts` in M16). Matches the W3C Origin definition: scheme + host + port. Stored form is `<scheme>://<lowercased-host[:port-if-non-default]>` with no trailing slash. Specifically:

| Input                         | Stored form                  | Rationale                                                                 |
|-------------------------------|------------------------------|---------------------------------------------------------------------------|
| `https://Example.com`         | `https://example.com`        | Host case-insensitive.                                                    |
| `https://example.com/`        | `https://example.com`        | Trailing slash stripped.                                                  |
| `https://example.com:8443`    | `https://example.com:8443`   | Non-default port preserved.                                               |
| `https://example.com:443`     | `https://example.com`        | URL parser drops the default port for the scheme.                         |
| `http://example.com`          | `http://example.com`         | **Distinct from** `https://example.com` — different origins per spec. Customers serving both must allowlist both. |
| `https://example.com/path`    | *rejected*                   | Paths are not part of an Origin.                                          |
| `https://example.com?x=1`     | *rejected*                   | Query strings are not part of an Origin.                                  |
| `ftp://example.com`           | *rejected*                   | Scheme must be `http` or `https`.                                         |
| `not-a-url`                   | *rejected*                   | URL parse failure surfaces a typed error to the CLI.                      |

The `http`-vs-`https` distinction is the most-likely operator-confusing case. Documented in `docs/cli-sw.md` alongside `sw chatbot origins add` so it doesn't keep biting people.

---

## `sessions`

One row per active chat session. Token is the bearer the browser carries for `POST /chat` and `GET /messages`.

| Column           | Type             | Constraints                          | Notes                                                                          |
|------------------|------------------|--------------------------------------|--------------------------------------------------------------------------------|
| `id`             | `BIGINT UNSIGNED`| PK, AUTO_INCREMENT                   | High-traffic table; BIGINT prevents counter exhaustion.                        |
| `chatbot_id`     | `INT UNSIGNED`   | NOT NULL, FK → `chatbots.id` ON DELETE CASCADE | Renamed from `website_id`.                                            |
| `token`          | `CHAR(64)`       | NOT NULL, UNIQUE                     | 32-byte hex. Generated server-side via `crypto.randomBytes(32).toString('hex')`. |
| `summary`        | `TEXT`           | NULL                                 | Reserved for M9 history-trimming (summarise-older-turns strategy). Always NULL at M16. |
| `created_at`     | `TIMESTAMP`      | NOT NULL, DEFAULT CURRENT_TIMESTAMP  |                                                                                |
| `last_active_at` | `TIMESTAMP`      | NOT NULL, DEFAULT CURRENT_TIMESTAMP  | Bumped on every `appendMessage` in the same transaction.                       |

Indexes:
- `token` UNIQUE
- `(chatbot_id, last_active_at)` composite — supports `sw sessions list --chatbot <slug>` ordered by recency without a sort

---

## `messages`

Conversation log. Append-only (no edits, no deletes except via session/chatbot/account cascade). Token + cost columns added in M18 (v0.14.0); cache-token columns reserve substrate for the post-M20 Anthropic prompt-caching milestone.

| Column                          | Type                          | Constraints                                                  | Notes                                                                                              |
|---------------------------------|-------------------------------|--------------------------------------------------------------|----------------------------------------------------------------------------------------------------|
| `id`                            | `BIGINT UNSIGNED`             | PK, AUTO_INCREMENT                                           | Highest-volume table — BIGINT.                                                                     |
| `session_id`                    | `BIGINT UNSIGNED`             | NOT NULL, FK → `sessions.id` ON DELETE CASCADE               |                                                                                                    |
| `chatbot_id`                    | `INT UNSIGNED`                | NOT NULL, FK → `chatbots.id` ON DELETE CASCADE               | M18 denormalisation from `sessions.chatbot_id` — keeps daily-spend SUM queries off the sessions join. |
| `role`                          | `ENUM('user', 'assistant')`   | NOT NULL                                                     | No system messages persisted — system blocks are reassembled per-request from disk + `chatbots.persona`. |
| `content`                       | `TEXT`                        | NOT NULL                                                     | The message body, trimmed and length-capped (`MAX_MESSAGE_CHARS = 8000`) at the chat-service layer for user role. |
| `tokens_in`                     | `INT UNSIGNED`                | NULL                                                         | Prompt-side tokens the adapter reported. NULL = adapter didn't report (today's user rows always; assistant rows always have a value because both adapters populate it). |
| `tokens_out`                    | `INT UNSIGNED`                | NULL                                                         | Completion-side tokens. Same NULL semantics.                                                       |
| `cost_usd_estimate`             | `DECIMAL(10,6)`               | NOT NULL, DEFAULT 0                                          | USD estimate computed at insert time via `src/services/cost.ts`. 0 for user rows and unmetered providers. NOT NULL so daily-spend SUM queries are COALESCE-free. |
| `cache_creation_input_tokens`   | `INT UNSIGNED`                | NULL                                                         | Anthropic prompt-cache writes (post-M20 milestone surface). NULL until that work ships.            |
| `cache_read_input_tokens`       | `INT UNSIGNED`                | NULL                                                         | Anthropic prompt-cache reads (post-M20 milestone surface). NULL until that work ships.             |
| `created_at`                    | `TIMESTAMP`                   | NOT NULL, DEFAULT CURRENT_TIMESTAMP                          |                                                                                                    |

Indexes:
- `(session_id, created_at)` composite — supports `GET /messages` (history rehydrate, ordered ascending) and `runChat` history load.
- `(chatbot_id, created_at)` composite (M18) — supports `sw chatbot usage` daily-spend SUM queries scoped to a chatbot + time window.

**Cost attribution convention.** Token + cost values are recorded on the **assistant row only** — the assistant turn is what "caused" the LLM call. User rows always have `tokens_in = NULL`, `tokens_out = NULL`, `cost_usd_estimate = 0`. Aggregate cost across a chatbot is a one-liner: `SELECT SUM(cost_usd_estimate) FROM messages WHERE chatbot_id = ?`.

**Cache columns are NULL today.** The post-M20 milestone wires the OpenRouter adapter to send Anthropic `cache_control` markers and parse cache stats from the response; until then every row's cache cells are NULL and `computeCostUsd` degenerates to the two-bucket case (`tokensIn × input_price + tokensOut × output_price`).

---

## `chatbot_geo_countries` (was `website_geo_countries`)

Two-letter ISO country codes blocked or allowed per-chatbot, interpreted according to `chatbots.geo_mode_id`.

| Column         | Type             | Constraints                          | Notes                                                |
|----------------|------------------|--------------------------------------|------------------------------------------------------|
| `id`           | `INT UNSIGNED`   | PK, AUTO_INCREMENT                   |                                                      |
| `chatbot_id`   | `INT UNSIGNED`   | NOT NULL, FK → `chatbots.id` ON DELETE CASCADE | Renamed from `website_id`.                  |
| `country_code` | `VARCHAR(2)`     | NOT NULL                             | Uppercase, ISO 3166-1 alpha-2 (e.g. `GB`, `US`).     |
| `created_at`   | `TIMESTAMP`      | NOT NULL, DEFAULT CURRENT_TIMESTAMP  |                                                      |

Indexes:
- `(chatbot_id, country_code)` UNIQUE — no duplicates per chatbot
- `chatbot_id` (FK auto-indexed)

---

## `geo_modes` (unchanged)

Lookup table for the three geo-handling modes. Seeded by the migration; not user-editable post-seed.

| Column     | Type             | Constraints              | Notes                                |
|------------|------------------|--------------------------|--------------------------------------|
| `id`       | `INT UNSIGNED`   | PK, AUTO_INCREMENT       |                                      |
| `code`     | `VARCHAR(32)`    | NOT NULL, UNIQUE         | `allowall`, `blocklist`, `allowlist`.|
| `label`    | `VARCHAR(128)`   | NOT NULL                 | Human-readable description.          |

Indexes: `code` UNIQUE.

Seed rows (in order, so `allowall` gets `id=1` and is the safe default for `chatbots.geo_mode_id`):

1. `('allowall', 'Country list ignored — all visitors accepted')`
2. `('blocklist', 'Block visitors from listed countries')`
3. `('allowlist', 'Only allow visitors from listed countries')`

---

## Migration shape

One greenfield migration replaces the six existing files:

**Delete** (from `migrations/`):
- `0001_create_websites.js`
- `0002_create_website_origins.js`
- `0003_create_sessions.js`
- `0004_create_messages.js`
- `0005_add_websites_persona.js`
- `0006_add_geo_blocking.js`

**Write** (new):
- `0001_create_schema.js` — single file, creates every table above + seeds `geo_modes`. Table creation order: `accounts`, `geo_modes`, `chatbots`, `chatbot_origins`, `sessions`, `messages`, `chatbot_geo_countries`. (FK dependencies enforce that ordering.)

Knex's auto-generated FK constraint names (e.g. `chatbots_account_id_foreign`, `sessions_chatbot_id_foreign`) carry the new table names through automatically — no need to name them explicitly.

After M16: strict additive-only discipline. The next migration is `0002_<something>` and adds, never renames.

---

## Code-side rename map

Service-layer renames the execution pass touches. Captured here so the design is complete; not a substitute for a per-file pass.

| Before                             | After                                |
|------------------------------------|--------------------------------------|
| `src/services/websites.ts`         | `src/services/chatbots.ts`           |
| `src/services/websites.test.ts`    | `src/services/chatbots.test.ts`      |
| `Website` (TS type)                | `Chatbot`                            |
| `createWebsite`, `getWebsiteById`, `getWebsiteBySlug`, `findWebsiteByOrigin`, `deleteWebsite`, `setWelcomeMessage`, `listOrigins`, `removeOrigin`, `setPersona`, etc. | mechanical s/Website/Chatbot/ — including `findChatbotByOrigin` |
| `data/websites/<slug>/`            | `data/chatbots/<slug>/`              |
| `sw website ...` CLI subgroup      | `sw chatbot ...` (no `website` alias)|
| `sw website add-origin` (M2 alias) | dropped — long form `sw chatbot origins add` is the only form |

**New service layer:**
- `src/services/accounts.ts` — `createAccount({ slug, name })`, `getAccountById`, `getAccountBySlug`, `listAccounts`, `deleteAccount` (CASCADE drops chatbots; surface a count in the CLI for confirmation).
- New CLI subgroup `sw account create|list|show|delete` (the `add-admin-key` / `revoke-admin-key` subcommands ship in M19, not M16).

**Routes that touch the rename** (handlers internal — public URLs unchanged):
- `POST /sessions` — `findChatbotByOrigin`, persists `(chatbot_id, token)`
- `GET /messages` — bearer → session → returns history (no chatbot reference in the response)
- `POST /chat` — bearer → session → chatbot → loads system blocks from `data/chatbots/<slug>/`
- `GET /sessions/preflight`, `GET /sessions/can-start` — chatbot lookup
- CORS allowlist — looks up by Origin in `chatbot_origins`

**Tests:** ~113 references to `websites` / `website_id` / `Website` across `src/**/*.test.ts`. Mechanical regex pass gets most; per-file review unavoidable (test fixture seeding, especially).

**Docs:**
- `dev-notes/01-auth-and-session-flow.md` — extensive references; parallel rename pass during execution.
- `dev-notes/03-llm-providers.md` — superseded banner already added; references to "per-website" → "per-chatbot" can come with the M17 doc rewrite or piggyback here.
- `dev-notes/04-system-blocks.md` — references `websites.persona` and `data/websites/`. Rename pass.
- `docs/cli-sw.md` — every `sw website ...` becomes `sw chatbot ...`, new `sw account ...` section.
- `docs/api-usage.md` — minimal touch (no `website` in the public API surface, but check anyway).
- `README.md` — explicitly **not** rewritten in M16 (per tracker: "rewrite ships after M16 lands"); just s/website/chatbot/ where it'd be technically wrong otherwise.

---

## Resolved decisions (2026-05-20)

All seven of the original design-pass questions have been answered. Captured here for future reference.

1. **`accounts.id` is `CHAR(36)` UUID** — opaque, non-enumerable, used directly in HTTP routes (`POST /admin/accounts/{id}/keys`) and stored against WC user records on the `site-walker.net` side to link a paying subscriber to their site-walker account. **`chatbots.id` stays `INT UNSIGNED`** — chatbots are addressed externally by `slug`, which already does the opaque-identifier job.

2. **`chatbots.account_id` is NOT NULL** — self-hosters create an account first; no default-account auto-seed; no nullable shortcut. Soft-delete deferred (see `accounts` section).

3. **No `sw website ...` deprecation aliases.** Clean slate. The old subgroup vanishes entirely; commander surfaces an "unknown command" error.

4. **M17/M18/M19/M20 columns stay out of the M16 greenfield migration.** `0001_create_schema.js` reflects M16 only. Each future milestone adds its columns/tables as its own additive forward-only migration. Squash is a one-time hygiene move, not a free pass to land unimplemented columns.

5. **`accounts` is minimal** — id, slug, name, timestamps. No `email`, `notes`, `description`, `external_id`. The WC-side WP plugin handles the customer-facing detail; we just expose our UUID for it to bind against.

6. **`chatbot_origins.origin` stays globally unique**, with the normalisation table above making the `http`/`https` and trailing-slash edge cases explicit. Operators who serve both schemes must allowlist both.

7. **`utf8mb4_uca1400_ai_ci` collation carries forward.** MariaDB-specific (the operator's preferred `utf8mb4_general_ci` is the older WordPress default; `uca1400_ai_ci` is the newer, more correct Unicode collation and the existing tables already use it). Already DB-vendor-locked via mysql2 + knex.

---

## Phased task plan for execution

Once the design questions above are settled, the execution pass runs in this order. Roughly half a day if uninterrupted; the test-fixture work dominates.

| Step | Job                                                                                                      | Verifies                                          |
|------|----------------------------------------------------------------------------------------------------------|---------------------------------------------------|
| 1    | User drops + recreates `site_walker` DB.                                                                 | Fresh state.                                      |
| 2    | Delete `migrations/0001`–`0006`. Write `migrations/0001_create_schema.js`. `npm run migrate:status`, then `npm run migrate`. | Schema matches this doc; knex_migrations has one row. |
| 3    | Rename `src/services/websites.ts` → `chatbots.ts`. Mechanical rename pass across services + types. Update internal callers. | `tsc` compiles. (Tests broken; expected.)         |
| 4    | Write `src/services/accounts.ts`. Add account-scoping to `createChatbot` (require `account_id` arg).    | Service unit tests for `accounts.ts`.             |
| 5    | Rename `src/cli/sw.ts` subgroup `website` → `chatbot`. Add `sw account` subgroup. Update CLI help.       | `sw chatbot create --help`, `sw account create --help` work. |
| 6    | Update routes in `src/server.ts` — `findChatbotByOrigin`, parameter names, error codes that mention "website". | `tsc` compiles; routes still bearer-auth correctly. |
| 7    | Test-suite pass: regex rename across `src/**/*.test.ts`, then per-file review for fixture seeding (every test that creates a website needs an account first). | `npm test` green.                                 |
| 8    | Rename `data/websites/` → `data/chatbots/` on disk (operator action; the loader change in step 3 already expects the new path). | `./bin/chat <slug>` smoke-test against the dev server. |
| 9    | Doc rename pass: `01-auth-and-session-flow.md`, `04-system-blocks.md`, `docs/cli-sw.md`, `docs/api-usage.md`. README minimal touch. | Manual diff review.                               |
| 10   | `npm run format && npm run lint`. Commit.                                                                | CI hygiene.                                       |
| 11   | Update tracker M16 entry to ✅ Shipped, version bump 0.12.0, CHANGELOG cut. Commit + ask before push.    | Milestone wrap-up per [[project-milestone-wrap-up]]. |

Risk markers:
- **Step 7 is the slow one.** ~113 test-file references and the test fixtures often inline-create websites without going through service-layer helpers. Be ready for a knock-on of "this test needs an account too."
- **Step 6 risks regressions in the bearer-auth path.** The session → chatbot lookup is on the hot path for every chat request; worth a targeted integration test pass before declaring done.
- **Step 8 needs the dev server stopped + restarted by the user** (per memory: agent doesn't start `npm run dev`). Flag clearly when we reach it.
