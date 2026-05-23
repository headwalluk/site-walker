# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.17.1] - 2026-05-23

Docs-only follow-up to v0.17.0 to close gaps that surfaced during a WP-plugin handoff audit. No code changes; no test changes.

### Changed
- **`docs/api-usage.md`** — `GET /sessions/can-start` failure-shape summary line was stale (missed `402 budget_exhausted_daily` and `503 chatbot_closed`); fixed.
- **`docs/api-usage.md`** — new "Admin-mode sessions (M21)" section documenting the **browser-side** angle of admin mode (the admin API documents the PHP-backend angle): the `is_admin_mode: true` envelope field, the `**Admin mode**\n\n` welcome-message prefix, which gates are bypassed on the chat path, and the recommended `data-is-logged-in="1"` signalling pattern from the WP page to the widget. The widget JS developer can now build admin-mode handling from `docs/api-usage.md` alone.
- **`docs/cli-chat.md`** — added a note that `./bin/chat` exits at startup with `503 chatbot_closed` when the chatbot is outside its operational hours (parallels the `402` startup-time paragraph from 0.16.1), plus the `sw chatbot set-hours <slug> none` workaround for testing a closed chatbot.
- **`docs/env.md`** — clarified that `SW_MAX_SESSION_BUDGET_USD` bounds both `session_budget_usd` and `admin_session_budget_usd` (the two share the env cap).

## [0.17.0] - 2026-05-23

M21 lands the last two pre-v1.0.0 API features: per-chatbot **operational availability** (timezone + weekly schedule, enforced at session-mint) and **admin-mode sessions** (a power-user surface for logged-in WP administrators that bypasses operator-imposed gates). Both share the same mint-gating seam, hence one milestone. Full design + resolved-question summary in `dev-notes/14-availability-and-admin-mode.md`.

With this release the API is feature-complete for first-customer onboarding. The next-step focus is real-client work on `api.site-walker.net`, not new API surface.

### Added
- **Migration `0006_availability_and_admin_mode.js`** (additive). Adds `chatbots.timezone VARCHAR(64) NULL`, `chatbots.availability JSON NULL`, `chatbots.admin_session_budget_usd DECIMAL(10,4) NULL`, `sessions.is_admin_mode BOOLEAN NOT NULL DEFAULT FALSE`.
- **`src/services/availability.ts`** — pure functions for IANA timezone validation (`assertValidTimezone`, via `Intl.DateTimeFormat`), schedule parsing (`parseWindow`, `assertValidSchedule`), and the open/closed check (`isOpenNow(chatbot, now)` returning `{ open, nextOpenAt }`). Strings-of-`"HH:MM-HH:MM"` shape per day; `24:00` supported as end-of-day; `close <= open` rejected (no implicit wrap-around).
- **`POST /sessions` + `GET /sessions/can-start`** — new `503 chatbot_closed` error code with `Retry-After` header (seconds, capped at 3600) and `detail.next_open_at` (ISO timestamp, or `null` if the schedule has no future opening). Mint-only — already-minted sessions keep running past closing time.
- **`POST /admin/chatbots/{slug}/sessions`** — account-admin-authenticated route that mints an admin-mode session. Returns `{ session_token, welcome_message, is_admin_mode: true }` with the welcome prefixed by `**Admin mode**\n\n`. The session is stamped `sessions.is_admin_mode = TRUE` and bypasses Origin/geo/availability/daily-cap/capacity gates throughout the chat path. The account admin key never reaches the browser — the WP plugin's PHP layer calls this and relays the token back via Ajax.
- **`PATCH /admin/chatbots/{slug}`** extended with three new fields: `timezone`, `availability` (validated against the schedule grammar), `admin_session_budget_usd`. Same bounds + `null`-clears semantics as the existing M20 fields. `admin_session_budget_usd` shares the `SW_MAX_SESSION_BUDGET_USD` env cap.
- **CLI:** `sw chatbot set-timezone <slug> <tz-or-none>`, `sw chatbot set-hours <slug> [none]` (JSON via stdin when not clearing), and `sw chatbot set-budget --admin-session <usd-or-none>`.
- **Usage reporting split:** `sw chatbot usage <slug>` now shows separate Customer + Admin-mode totals. `GET /admin/chatbots/{slug}/usage` keeps the top-level combined view (backwards compatible) and adds `customer` + `admin` nested objects with the split. `sw sessions list` rows carry an `[admin]` marker for admin-mode sessions — the audit story is: "ah — it was the boss racking up the Anthropic bill today."
- **Tests:** 35 new (316 total). `availability.test.ts` covers the pure-function surface; `chat-availability.test.ts` covers mint-time enforcement + `Retry-After` cap; `chat-budget.test.ts` gains M21 cases for soft-handoff suppression, hard-cap termination without webhook firing, unbounded admin-cap behaviour, and admin-spend exclusion from `getChatbotDailySpend`; `admin.test.ts` covers PATCH M21 fields (happy + 8 malformed-rejection cases), admin-mode mint happy path, and cross-account guard.

### Changed
- **`runChat()`** in `src/services/chat.ts` branches on `session.is_admin_mode`: session-cap reads `admin_session_budget_usd` instead of `session_budget_usd`; soft-handoff inject is suppressed; hard-cap termination still fires (safety belt) but the handoff webhook is suppressed (operator shouldn't get a notification about themselves).
- **`POST /chat` + `GET /messages`** skip the per-turn geo check when `session.is_admin_mode` (admins may be travelling).
- **`getChatbotDailySpend`** joins `sessions` and excludes `is_admin_mode = TRUE` rows from the aggregate. Admin spend is tracked at message level and surfaces in usage reporting, but doesn't displace customer daily-cap budget.
- **`getChatbotUsage`** accepts an optional `segment: 'customer' | 'admin'` filter; omitted means combined.
- **`findChatbotByOrigin`** now runs results through `normaliseChatbotRow` (latent bug: JSON columns were coming back as strings on the browser-mint path — only surfaced because M21 added a per-request read of the `availability` JSON column).
- **`findSessionByToken` + `listSessions`** coerce `is_admin_mode` to a real boolean (mysql2 returns BOOLEAN as 0/1).

### Notes
- The schedule grammar deliberately does not support overnight wrap-around or per-day overrides (public holidays, one-off closures). Operators split overnight ranges into two windows and handle one-offs by editing the schedule on the day. If a real customer asks, both are follow-ups.
- Admin-mode session concurrency is unlimited; sessions are cheap and the admin-cap is the safety belt against runaway.
- No new env vars in this release. `SW_MAX_SESSION_BUDGET_USD` is the bound on both `session_budget_usd` and `admin_session_budget_usd`.

## [0.16.1] - 2026-05-23

Behaviour change to M20's daily-budget enforcement: the daily cap is now checked **only at session-mint** (`POST /sessions`, `GET /sessions/can-start`), not on every `POST /chat`. Once a visitor holds a session token they keep going to the end of their own session-cap budget, even if other concurrent sessions push the chatbot over its daily cap mid-day. The session cap is what bounds any individual conversation; the daily cap is a "front door" gate for new visitors only.

The trade-off the operator now sizes for is `daily_budget_usd + (live_sessions × session_budget_usd)` as effective max daily spend. For pre-sales bots that's almost always worth a few extra dollars to avoid cutting off a hot lead.

### Changed
- `runChat()` in `src/services/chat.ts` no longer performs a daily-cap pre-check. The check at `POST /sessions` and `GET /sessions/can-start` is unchanged.
- `ChatErrorCode` no longer includes `budget_exhausted_daily`; `CHAT_ERROR_STATUS` and the `POST /chat` OpenAPI response schema no longer list `402`.
- `dev-notes/11-budget-handoff.md` chat-path state machine: now four steps, with a "Behaviour change in 0.16.1" section recording the rationale + trade-off math.
- `docs/api-usage.md` denial table + `POST /chat` error table updated; `docs/cli-chat.md` `./bin/chat` error table updated (402 surfaces at startup, not in the loop).

### Tests
- The chat-budget test that asserted `402 budget_exhausted_daily` mid-session was inverted into a positive assertion: a session minted under cap keeps going (200) when other sessions bust the daily cap mid-flight. Mint-time + probe-time daily-cap tests are unchanged. 281 tests pass.

## [0.16.0] - 2026-05-21

The fifth and final SaaS-pivot milestone (M20). Adds per-chatbot daily + per-session spend caps with soft- and hard-handoff behaviour, visitor-email capture, and an operator webhook for terminated-session notification. With this, the SaaS-pivot block (M16–M20) is closed; next phase is real-customer onboarding on `api.site-walker.net`.

### Added
- **Migration `0005_budget_caps.js`** (additive). Adds `chatbots.daily_budget_usd DECIMAL(10,4) NULL`, `chatbots.session_budget_usd DECIMAL(10,4) NULL`, `chatbots.handoff_threshold_pct TINYINT UNSIGNED NOT NULL DEFAULT 80`, `chatbots.handoff_webhook_url VARCHAR(255) NULL`; adds `sessions.terminated_at TIMESTAMP NULL`, `sessions.visitor_email VARCHAR(255) NULL`, `sessions.handoff_notified_at TIMESTAMP NULL`.
- **`src/services/budget.ts`** — pure helpers (`utcMidnightToday`, `parseCapDecimal`, `isDailyBudgetExhausted`, `isSessionBudgetExhausted`) plus DB aggregators (`getChatbotDailySpend`, `getSessionSpend`). Closed-boundary semantics: `spend === cap` exhausts.
- **`src/services/handoff-webhook.ts::notifyHandoff`** — fire-and-forget POST to `chatbots.handoff_webhook_url` with `{ event: 'session_handoff', chatbot_slug, session_id, visitor_email, terminated_at, spend_usd }`. 10s timeout, no retry, no HMAC v1. Stamps `sessions.handoff_notified_at` on 2xx; logs and swallows failures.
- **`src/services/system-blocks.ts`** — `RESERVED_BLOCK_NAMES` extended to `{ PERSONA, HANDOFF_SOFT, HANDOFF_HARD }`. New `loadHandoffBlock('soft' | 'hard')` helper. `assemblePrompt()` accepts optional `extraBlocks?: Block[]` for conditional injection without making prompt assembly globally stateful.
- **Chat-path budget enforcement** in `src/services/chat.ts` — five-step flow: (1) early-return canned `HANDOFF_HARD` when `terminated_at` is set (`message_id: 0`, `session_terminated: true`, no adapter call, no new rows); (2) daily-cap pre-check → `402 budget_exhausted_daily`; (3) soft-handoff inject when session-spend-before crosses `cap * threshold/100`; (4) adapter + persist; (5) hard-cap after-write check → set `terminated_at`, mark `session_terminated: true`, fire `notifyHandoff` if webhook + email present.
- **`DEFAULT_HARD_HANDOFF`** constant in `src/services/chat.ts` — generic operator-bland fallback when a chatbot has no `HANDOFF_HARD.md`.
- **`POST /sessions/visitor-email`** — session-bearer-authenticated, write-only route. 204 with no body on success. Loosely validates the email shape (≤255 chars, must contain `@` and a `.`). No GET counterpart at this scope — admin-only readback. Fires `notifyHandoff` when the session is already terminated and the chatbot has a webhook set.
- **Daily-cap gating on session mint** — `POST /sessions` and `GET /sessions/can-start` both return `402 budget_exhausted_daily` with `detail: { cap_usd, spend_usd }` when a chatbot's daily spend cap is reached. Widgets can hide the chat affordance proactively via the probe.
- **24h idle session expiry** — `findSessionByToken` now returns `null` for sessions whose `last_active_at` is older than `SESSION_IDLE_EXPIRY_HOURS = 24`. Prevents shared-device data leak; serves as a free housekeeping floor.
- **`PATCH /admin/chatbots/{slug}`** extended with four new optional fields: `daily_budget_usd`, `session_budget_usd`, `handoff_threshold_pct`, `handoff_webhook_url`. `null` clears. Webhook URL must be `http://` or `https://`, ≤255 chars.
- **Sanity-bound budget caps** — new env vars `SW_MAX_DAILY_BUDGET_USD` (default `10000`) and `SW_MAX_SESSION_BUDGET_USD` (default `100`). Admin PATCH + CLI refuse to set values above the env cap with `400 validation_failed` naming the env var to raise. Bounds the blast radius of a stolen account-admin key.
- **CLI: `sw chatbot set-budget <slug> [--daily <usd|none>] [--session <usd|none>] [--threshold <pct>]`** and **`sw chatbot set-handoff-webhook <slug> <url|none>`**. Literal `none` clears the column. Validates against the env-side bounds.
- **Tests:** 6 new (281 total). `chat-budget.test.ts` covers daily-cap refusal on `/chat`, session-mint gating, soft-handoff inject presence/absence, hard-cap after-write terminate, canned-response on terminated session, `DEFAULT_HARD_HANDOFF` fallback, visitor-email persist/validate/auth. `admin.test.ts` covers the new PATCH allowlist + sanity-bound rejection cases.
- **Docs:** `docs/api-usage.md` (visitor-email route, 402 vocabulary, soft/hard handoff in the chat path), `docs/api-admin.md` (PATCH allowlist + 402 cross-reference), `docs/cli-sw.md` (`set-budget` + `set-handoff-webhook`), `docs/env.md` (`SW_MAX_*` vars). `dev-notes/11-budget-handoff.md` gets a "What shipped" section with the resolved-design summary, schema delta, and the chat-path state machine.

### Changed
- `POST /chat` success response carries optional `session_terminated: boolean` (added to OpenAPI schema so Fastify's serializer doesn't strip it). Widgets should hide the input on `true`.
- `CHAT_ERROR_STATUS` gains `budget_exhausted_daily: 402`. The new code is returned by `POST /chat`, `POST /sessions`, and `GET /sessions/can-start`.

### Notes
- The hard-cap check fires *after* the assistant reply is written — the visitor gets one final natural reply, then the session terminates. Trades a single over-cap reply per session for a non-jarring UX.
- Webhook v1 is intentionally minimal: no HMAC, no retry, no replay protection. Operator's receiver is responsible for idempotency on `session_id` and (if exposed publicly) IP allowlisting. Signed payloads + retry-with-backoff are a follow-up only if a real customer asks.
- The original M9 (history trimming) sits unchanged — likely superseded by this budget-driven handoff in practice, but kept available as a fallback if real cost data ever shows conversations regularly bust context windows before they bust budgets.

## [0.15.0] - 2026-05-21

The fourth SaaS-pivot milestone (M19). Adds the admin HTTP API: 22 routes across two scopes (provisioning + account-admin), each with bearer-token authentication, OpenAPI documentation, and integration tests. Unblocks `site-walker-wp` (plugin) and `site-walker-for-woo` (provisioning) from doing anything beyond chat.

### Added
- **`admin_keys` table** (additive migration `0004_admin_keys.js`). Account-scoped (`account_id NOT NULL FK CASCADE`); provisioning keys deliberately *not* here — they live in `.env` as `SW_PROVISIONING_KEY` per the air-gap design. Hash at rest, raw key returned ONCE at mint time (GitHub-PAT style).
- **`src/config/secrets.ts::loadProvisioningKey`** — mirror of the M17 encryption-key loader. Unset is valid (returns null; locks down `/admin/accounts/*` routes for self-hosters who don't run WC-side provisioning). Empty string or malformed value throws. Format: `sw_<base64url-32>`.
- **`src/utils/crypto.ts::generateProvisioningKey`** — matches the format `loadProvisioningKey` validates.
- **`src/services/admin-keys.ts`** — `createAdminKey` (mints UUID + raw key with sha-256 stored), `getAdminKeyByHash` (auth lookup with `last_used_at` bump), `listAdminKeys` (newest-first, never includes `token_hash`), `revokeAdminKey` (idempotent, refuses cross-account).
- **`src/routes/admin-auth.ts`** — `makeVerifyProvisioningBearer` (constant-time compare; refuses everything when env var unset) + `makeVerifyAccountAdminBearer` (hashes incoming bearer, looks up `admin_keys`, populates `req.adminContext.accountId`; refuses the provisioning bearer on chatbot routes with `wrong_scope`).
- **`/admin/accounts/*` HTTP routes** (5, provisioning-gated): list, create, list/mint/revoke admin keys.
- **`/admin/chatbots/*` HTTP routes** (17, account-admin-gated): core CRUD (list/create/get/patch/delete), origins (list/add/remove), blocks (list/get/put/delete with `^[A-Za-z0-9_-]+$` name pattern, 64KB cap, `text/markdown` or `text/plain` body), api-key (PATCH set + DELETE clear), usage (with `?since=` window + under-counting warnings), geo (GET + PATCH).
- **OpenAPI augmentation** — new `admin` tag + new `adminBearerAuth` security scheme. All 22 routes documented at `/openapi.json`.
- **CLI helpers** (mirroring the HTTP surface so operators can choose either):
  - `sw secrets gen-provisioning-key`
  - `sw account add-admin-key <slug> [-d "..."]`
  - `sw account list-admin-keys <slug>`
  - `sw account revoke-admin-key <slug> <key-id>`
- **`docs/api-admin.md`** — operator-facing reference for the admin HTTP surface. Audience: `site-walker-wp` + `site-walker-for-woo` developers + self-hosters who prefer HTTP over `./bin/sw`.
- **`dev-notes/12-admin-http-api.md`** — design-conversation record (status: shipped).
- **`src/utils/bearer.ts`** — shared `extractBearerToken` helper (promoted from `src/server.ts` so the admin middlewares can use the same parser).
- **`src/testing/db.ts::setTestChatbotApiKey`** — encrypts + persists a plaintext key for tests that need the metered chat path.

### Changed
- **Cross-account access on `/admin/chatbots/*` returns `404 not_found`**, not `403`. Returning a distinct error code would leak the existence of other accounts' chatbot slugs. Documented in `docs/api-admin.md` and the dev-notes design doc.
- **Revoked-key auth failures collapse to `401 bearer_invalid`** rather than a distinct `bearer_revoked` code. Same info-leak rationale.
- **`src/server.ts`**: OpenAPI components gain `adminBearerAuth` security scheme + `admin` tag. The two admin plugins register at `/admin/accounts` and `/admin/chatbots` with their respective bearer middlewares.

### Tests
246/246 pass (up from 216 — +30 new admin-route integration tests covering auth paths, accounts surface, chatbots CRUD, cross-account guards, blocks PUT/GET/DELETE with content-type rejection + reserved name, api-key PATCH/DELETE, usage zero-totals + since-window, geo GET/PATCH).

### Resolved during execution
- **Block-name validator pattern**: `^[A-Za-z0-9_-]+$` (both cases). Uppercase-only would have rejected existing operator habits like `10-overview.md`.
- **api-key clear semantics**: `DELETE /admin/chatbots/{slug}/api-key`. Separate verb, separate auditable action.
- **Geo settings exposure**: dedicated sub-resource (`/admin/chatbots/{slug}/geo`, GET + PATCH) rather than fields on the main chatbot PATCH. Symmetric with origins + blocks.

### What this enables, what it doesn't
**Enables:** `site-walker-wp` and `site-walker-for-woo` can now drive chatbot configuration over HTTPS without operator shell access. Self-hosters with an `SW_PROVISIONING_KEY` set get a programmable provisioning surface.

**Doesn't ship:** account deletion is HTTP-unexposed (severe cascade; CLI-only). The chat path itself (`POST /sessions`, `POST /chat`, `GET /messages`) is unchanged — admin and chat surfaces are separate concerns by design.

## [0.14.0] - 2026-05-20

The third SaaS-pivot milestone (M18). Records token counts + USD cost estimate on every assistant message row, ships a `sw chatbot usage` CLI, and pre-adds the schema substrate for Anthropic prompt caching ahead of the post-M20 wiring milestone. Foundation-only — no enforcement of caps (that lands in M20).

### Added
- **`messages.chatbot_id INT UNSIGNED NOT NULL`** (denormalised from `sessions.chatbot_id`) plus composite index `(chatbot_id, created_at)`. Daily-spend SUM queries now scan the index directly without joining through `sessions`. Backfilled in the migration from existing rows.
- **`messages.tokens_in / tokens_out INT UNSIGNED NULL`** — populated on the assistant row from the adapter's `tokensUsed.prompt / .completion`. NULL when the adapter didn't report (today's user rows always).
- **`messages.cost_usd_estimate DECIMAL(10,6) NOT NULL DEFAULT 0`** — USD estimate computed at insert time via `src/services/cost.ts`. NOT NULL so `SUM(cost_usd_estimate)` is COALESCE-free. 0 for user rows and unmetered-provider turns.
- **`messages.cache_creation_input_tokens / cache_read_input_tokens INT UNSIGNED NULL`** — Anthropic prompt-caching substrate. Always NULL today; populated when the post-M20 milestone wires the OpenRouter adapter to send `cache_control` markers and parse cache stats from the response.
- **`src/services/cost.ts::computeCostUsd`** — pure four-bucket cost calculator: uncached input × 1.0, cache write × 1.25, cache read × 0.10, output × output-price. Anthropic cache multipliers as named constants with a block comment naming the future-configurable shape (per-provider columns once OpenAI/Google ship caching with different multipliers).
- **`src/services/cost.ts::getChatbotUsage`** — DB aggregation helper returning `{ messageCount, tokensIn, tokensOut, costUsd, cacheCreationTokens, cacheReadTokens }` over an optional time window.
- **`src/services/cost.ts::parseSinceDuration`** — relative-only duration parser (`Ns`/`Nm`/`Nh`/`Nd`). Single-unit; malformed input rejected with a clear error.
- **`ResolvedModel.providerModel`** — the joined `provider_models` row is now exposed alongside the provider on every `resolveModel` call, so the chat path reads pricing for cost computation without a second query.
- **CLI `sw chatbot usage <slug> [-s|--since <duration>]`** — aggregate token + USD totals. Defaults to all-time when `--since` is omitted. Cache lines surface only when non-zero. Warns when the chatbot's current model row has NULL pricing on a metered provider (silent under-counting).
- **`src/testing/db.ts::setTestChatbotApiKey`** — encrypts a plaintext key via the loaded `SW_ENCRYPTION_KEY` and writes the three `chatbots.provider_api_key_*` columns. Used by the M18 metered-cost-recording test; M19+ tests will reuse it.

### Changed
- **`appendMessage` signature**: now takes `(db, sessionId, role, content, opts)` where `opts.chatbotId` is required (column is NOT NULL) and `opts.tokensIn / tokensOut / costUsd / cacheCreationTokens / cacheReadTokens` are optional. All call sites updated (chat path + tests).
- **`Message` interface** gains the six new columns. DECIMAL pricing comes back from mysql2 as a string (`cost_usd_estimate: string`).
- **Chat path** (`src/services/chat.ts`): after the adapter returns, computes USD cost from the resolved provider model's pricing and persists tokens + cost on the assistant row. User rows carry `chatbot_id` only.
- **`dev-notes/02-data-model.md`**: `messages` table re-documented with the six new columns, the new composite index, and the cost-attribution convention (assistant rows carry tokens/cost, user rows don't).
- **`dev-notes/10-saas-shape.md`**: post-M20 deferred list adds **Anthropic prompt caching** — substrate already shipped in M18; remaining work is adapter-side (`cache_control` marker injection, response-side cache-stat parsing, model gating, minimum-prefix-length threshold).
- **`docs/cli-sw.md`** gets a `sw chatbot usage` section with the output format, duration parser, cache lines, and under-counting warning.

### Tests
189/189 pass (up from 181). 11 cost-helper unit tests, 6 duration-parser tests, 2 chat-path cost-recording integration tests added. Existing 11 sessions/chatbot tests updated for the new `appendMessage` opts shape.

### What this enables, what it doesn't
**Enables:** observability into per-chatbot spend over arbitrary windows (`sw chatbot usage acme-corp --since 7d`). Operators can see cost shapes before deciding budget caps.

**Doesn't enforce:** budget caps remain M20. Today's cost numbers are observability-only; chat turns never get rejected because of cost.

**Doesn't yet measure cache hits:** the cache columns stay NULL until the post-M20 cache-wiring milestone teaches the OpenRouter adapter to send markers and parse cache stats. The cost formula already handles non-NULL cache values correctly, so when caching ships it will Just Work.

**Honesty about the estimate:** the recorded cost runs slightly under the provider's invoiced amount (we don't count system-side overhead). For cap enforcement in M20 it's accurate enough; for customer-facing reconciliation, point at the provider's invoice.

## [0.13.1] - 2026-05-20

Bugfix follow-up to 0.13.0. End-to-end validation against both backends — `cortex/qwen2:1.5b` (local Ollama, unmetered) and `openrouter/anthropic/claude-haiku-4.5` (BYO key, metered) — confirmed the M17 plumbing works.

### Fixed
- **`sw provider add --local` no longer mis-stores `is_metered=true`.** The previous `--metered` / `--no-metered` flag pair triggered a commander.js quirk: `.option('--no-metered', ...)` makes the implicit `opts.metered` default to `true` when neither flag is passed, which bypassed `createProvider`'s `!is_local` fallback entirely. Replaced with two distinct affirmative flags so the action handler can detect "neither set" cleanly.

### Changed
- **`sw provider add` flag rename: `--no-metered` → `--unmetered`.** Mutually exclusive with `--metered`; passing both is rejected with a clear error. Defaults remain `!is_local` when neither is set.
- `docs/cli-sw.md` flag table updated for the new naming.

### Repair recipe (for an existing row that landed with the wrong value)
```
source .env ; mysql -u "${DB_USER}" -p"${DB_PASSWORD}" "${DB_NAME}" \
  -e "UPDATE providers SET is_metered=0 WHERE name='<provider>';"
```

## [0.13.0] - 2026-05-20

The second SaaS-pivot milestone (M17). Replaces the `site-walker.toml` provider registry with `providers` + `provider_models` tables in MariaDB, and adds AES-256-GCM-encrypted per-chatbot LLM provider API keys (bring-your-own-key, on the chatbot row, never on the provider). Master encryption key lives in `.env` as `SW_ENCRYPTION_KEY`. The TOML config path is deleted entirely — file, search-path resolver, 0600 gate, `SW_CONFIG` override, `smol-toml` dependency all gone. **Breaking** in two ways: any chatbot pointing at a previously-TOML provider needs the provider re-registered in the DB; any chatbot on a metered provider additionally needs `sw chatbot set-api-key` to be run before chat works.

### Added
- **`providers` + `provider_models` DB tables** (additive migration `0002_provider_registry.js`). `providers` carries name (UNIQUE), protocol, base_url, is_local, is_metered (default `!is_local`). `provider_models` carries provider_id (FK CASCADE), model_slug, context_window, `input_per_million_usd DECIMAL(10,6) NULL`, `output_per_million_usd DECIMAL(10,6) NULL`, is_available; UNIQUE on `(provider_id, model_slug)`.
- **`chatbots.provider_api_key_ciphertext VARBINARY(255)` + `_nonce BINARY(12)` + `_auth_tag BINARY(16)`** — three columns rather than a single packed blob for schema readability; the AES-GCM auth tag is required for AEAD verification so it gets its own column. All three are either all NULL (no key set) or all non-NULL (decryptable).
- **`SW_ENCRYPTION_KEY` env var** — base64-encoded 32-byte master key for the chatbot BYO encryption. Required for the API server to boot; fail-loud at startup if missing or wrong-length. The .env 0600 gate already protects it alongside `DB_PASSWORD`.
- **`src/utils/crypto.ts`** — AES-256-GCM `encrypt()` / `decrypt()` / `generateMasterKey()` helpers. 13 round-trip + tamper-detection tests covering wrong-key, tampered-ciphertext, tampered-nonce, tampered-tag, wrong-length-key, wrong-length-nonce, wrong-length-tag, empty/long round-trips, and `generateMasterKey` randomness.
- **`src/config/secrets.ts`** — `loadEncryptionKey()` boot-validator with `EncryptionKeyError`; module-scope cache + `resetEncryptionKeyCache()` for tests.
- **`src/services/providers.ts`** — `createProvider`, `getProviderById/Name`, `listProviders`, `deleteProvider` (cascade counts), `createProviderModel`, `listProviderModelsForProvider`, `deleteProviderModel`, `findProviderModel` (the join `resolveModel` calls on every chat request).
- **New `ChatError` code `chatbot_api_key_missing` (503)** — raised when the chatbot's resolved model points at a metered provider but the chatbot has no `provider_api_key_*` columns set. Surfaces the recovery command in the error message.
- **CLI `sw secrets gen-key`** — prints a fresh base64 32-byte value to stdout (hint to stderr so the value alone is captureable). New `sw secrets` subgroup also primes the namespace for M19's `gen-provisioning-key`.
- **CLI `sw chatbot set-api-key <slug>`** — reads the raw key from stdin only (refuses interactive TTY to avoid terminal echo), trims whitespace, encrypts, persists. Never echoes the key or ciphertext. 255-byte plaintext cap to match the column width.
- **CLI `sw provider add/list/show/remove`** — full DB-backed surface. `add` defaults `base_url` to `https://openrouter.ai/api/v1` for `--protocol openrouter` and requires it for `ollama-native`. `remove` is `-f|--force` and cascades through `provider_models`.
- **CLI `sw provider models discover|add|list|remove`** — `discover` is the renamed M8 live-discovery command (was `sw provider models <name>`); `add`/`list`/`remove` operate against the local DB registry. Discovery no longer sends an api_key (the BYO key only travels with the live chat path).

### Changed
- **`resolveModel` is now async and DB-backed.** `ResolvedModel.provider` carries the DB `Provider` row (id, name, protocol, base_url, is_local, is_metered). Effective `contextWindow` = chatbot override (`chatbots.model_context_window`) ?? `provider_models.context_window`.
- **`setModel` validates against the DB.** Both the provider name and the specific model row must exist; typos surface at admin-set time, not on first chat request.
- **Adapter signature: per-request instances.** `buildAdapter(provider, apiKey?)` is called once per chat request; the adapter holds the key for its lifetime and is thrown away. Openrouter adapter throws if metered + no `apiKey` is passed.
- **`SUPPORTED_PROTOCOLS` narrowed to `['ollama-native', 'openrouter']`** — the two actually wired protocols. The dead `'anthropic' | 'openai-compatible'` branches are gone from `buildAdapter` and the listing function.
- **`runChat` no longer takes a `registry` parameter.** Same for `buildServer({ db, ... })` — there's no more in-memory provider registry to thread through. The `500 server_misconfigured` case (registry missing) is gone with it.
- **`docs/cli-sw.md`** — full rewrite of the `sw provider` section, new `sw secrets` and `sw chatbot set-api-key` sections, every TOML reference scrubbed.
- **`docs/env.md`** — documents `SW_ENCRYPTION_KEY` (required, generation, format).
- **`dev-notes/03-llm-providers.md`** — banner moved to past-tense ("superseded by M17, v0.13.0"); body kept as the historical M5/M6 TOML design reference.

### Removed
- **`site-walker.toml`** as a config concept. Deleted: `src/config/site-walker-config.ts` + its test, `templates/site-walker.toml.example`, `docs/site-walker-toml.md`, the `smol-toml` dependency, the `SW_CONFIG` env variable, the `xdgConfigHome` field on `RuntimeEnv`, and the 0600 gate code that was specific to the TOML path. The .env 0600 gate is unchanged.
- **Provider-level `api_key` field.** Provider entries no longer carry credentials; every chatbot supplies its own.

### Self-hoster recipe (post-upgrade)
```
# 0. Master encryption key — required for boot.
./bin/sw secrets gen-key                         # paste the value into .env as SW_ENCRYPTION_KEY=...

# 1. Re-register providers in the DB:
./bin/sw provider add cortex --protocol ollama-native --base-url http://cortex.local:8000 --local
./bin/sw provider models add cortex qwen2:1.5b --context-window 4096

./bin/sw provider add openrouter --protocol openrouter
./bin/sw provider models add openrouter anthropic/claude-haiku-4.5 \
  --context-window 200000 --input-price 1.0 --output-price 5.0

# 2. For each chatbot pointing at a metered provider, set its BYO key:
echo "sk-or-..." | ./bin/sw chatbot set-api-key <chatbot-slug>

# 3. Sanity-check the resolution:
./bin/sw chatbot show-model <chatbot-slug>
```

## [0.12.0] - 2026-05-20

The first SaaS-pivot milestone (M16). Squashes the prototype-era migrations into a single greenfield schema, introduces `accounts` as the top-level entity that owns chatbots, and mechanically renames every "website" identifier to "chatbot" across the codebase. **Breaking** for anyone running the prototype — the schema is incompatible and there is no migration path; self-hoster recipe is at the end of this entry.

### Added
- **`accounts` table** as the top-level tenant entity. One account owns many chatbots; billing happens per-account (in WooCommerce, not here). `accounts.id` is `CHAR(36)` UUID (opaque, route-safe for M19, exposable to WP/WC for customer linking); `accounts.slug VARCHAR(64) UNIQUE` is the CLI handle. See `dev-notes/02-data-model.md` for the authoritative spec.
- **`sw account` CLI subgroup**: `create`, `list`, `show`, `delete -f|--force`. Deleting an account cascades through every chatbot it owns (and origins/sessions/messages/geo_countries by transitive CASCADE).
- **`src/services/accounts.ts`** — `createAccount`, `getAccountById`, `getAccountBySlug`, `listAccounts`, `deleteAccount` (returns full cascade counts).
- **`src/testing/db.ts::seedAccountAndChatbot`** — single-call test fixture; tests clean up by deleting the account row, the chatbot cascades.
- **`dev-notes/db-schema-pre-m16.sql`** — `mysqldump --no-data` of the v0.11.0 schema, checked in as a frozen reference for anyone forensically comparing the squash.

### Changed
- **`websites` → `chatbots`** rename (table + column + service file + TypeScript type + every test). `websites.id` stays `INT UNSIGNED` (chatbots are addressed by slug everywhere they appear externally — no need for a second opaque id). `chatbots.account_id CHAR(36) NOT NULL` FK + CASCADE.
- **`website_origins` → `chatbot_origins`**, **`website_geo_countries` → `chatbot_geo_countries`**, **`sessions.website_id` → `sessions.chatbot_id`** (and matching index renames).
- **Migrations squashed**: deleted `migrations/0001_create_websites.js`, `0002_create_website_origins.js`, `0003_create_sessions.js`, `0004_create_messages.js`, `0005_add_websites_persona.js`, `0006_add_geo_blocking.js`; replaced with a single `migrations/0001_create_schema.js` capturing the M16 shape (including the three `geo_modes` seed rows). Strict additive-only discipline resumes from `0002_*` onward.
- **`sw chatbot create <slug>` now requires `--account <account-slug>`.** No fallback, no default-account auto-seed, no friendly auto-create. Self-hosters run `sw account create` once and put every chatbot under it.
- **`sw sessions list` flag rename**: `-w|--website` → `-c|--chatbot`.
- **`DEFAULT_DATA_DIR`** for per-chatbot system blocks moved from `data/websites/` to `data/chatbots/`. The on-disk directory is renamed in step.
- **Service-layer + type renames** flow through everywhere: `Website` → `Chatbot`, `WebsiteOrigin` → `ChatbotOrigin`, `WebsiteGeoPolicy` → `ChatbotGeoPolicy`, `loadWebsiteGeoPolicy` → `loadChatbotGeoPolicy`, `setWebsiteGeoMode` → `setChatbotGeoMode`, `setWebsiteGeoCountries` → `setChatbotGeoCountries`, `getWebsiteGeoSummary` → `getChatbotGeoSummary`, `anyWebsiteHasGeoMode` → `anyChatbotHasGeoMode`, `findWebsiteByOrigin` → `findChatbotByOrigin`, `validateRegistryAgainstWebsites` → `validateRegistryAgainstChatbots`, etc.
- **Docs**: `dev-notes/02-data-model.md` rewritten as the v1.0 schema reference. `dev-notes/01-auth-and-session-flow.md` + `dev-notes/04-system-blocks.md` updated for the rename. `docs/cli-sw.md` gains an `sw account` section and scopes `sw chatbot create` to require `--account`; the legacy `sw website add-origin` alias section is gone. `docs/api-usage.md` operator-setup list grows from 4 → 5 steps (account creation is step 1). `README.md` got a light touch — full README rewrite ships post-M16.
- **No deprecation aliases anywhere.** `sw website ...` commands don't print a "use `sw chatbot ...`" hint — `commander.js` surfaces an "unknown command" error. Clean break.

### Removed
- Migrations `0001`–`0006` (squashed into `0001_create_schema.js`).
- `sw website add-origin <slug> <origin>` alias (the canonical form `sw chatbot origins add <slug> <origin>` is the only form).
- Pre-M16 prototype DB state — squashing the migrations effectively wipes any v0.11.0 database. The cortex/qwen2 smoke-test conversations accumulated through M6/M8 are gone with it; the user confirmed this is acceptable.

### Tests
139/139 pass. Test fixtures rewritten to use `seedAccountAndChatbot(db, slug)` from `src/testing/db.ts` so every chatbot-needing test creates its owning account in one line.

### Self-hoster recipe (post-upgrade)
```
DROP DATABASE site_walker;
CREATE DATABASE site_walker CHARACTER SET utf8mb4 COLLATE utf8mb4_uca1400_ai_ci;
npm run migrate
./bin/sw account create <account-slug> --name "<readable name>"
./bin/sw chatbot create <chatbot-slug> --account <account-slug>
./bin/sw chatbot origins add <chatbot-slug> <origin>
./bin/sw chatbot set-model <chatbot-slug> <provider>/<model>
```

## [0.11.0] - 2026-05-18

### Added
- **CORS** via `@fastify/cors`, wired against the per-website origin allowlist as its single source of truth. Any `Origin` registered against any website (via `sw website origins add`) is an allowed CORS origin — no second list, no parallel config.
  - Dynamic async origin resolver delegates to the existing `findWebsiteByOrigin(db, origin)` from M2. Allowed origins get echoed back as `Access-Control-Allow-Origin: <origin>` with `Vary: Origin`. Unregistered origins get **no** CORS header — the HTTP response is otherwise normal, the browser blocks JS from reading it, and the API deliberately doesn't leak which origins are valid.
  - Settings: `methods: ['GET', 'POST', 'OPTIONS']`, `allowedHeaders: ['Content-Type', 'Authorization']`, `credentials: false`, `maxAge: 600` (browsers cache the preflight for 10 minutes — cuts repeat preflights to one per visitor per 10 min on a chat session).
  - Non-browser callers (curl, `./bin/chat`, server-to-server) send no `Origin` and bypass the CORS layer entirely. Same code path as before, no behaviour change for those flows.
- 4 new tests in `src/server.test.ts` (139 total): registered-origin preflight echoes ACAO + Vary + methods + headers; unregistered preflight gets no ACAO; actual `POST /sessions` response carries ACAO for a registered origin; request without `Origin` still succeeds and gets no ACAO.
- Dep: `@fastify/cors` ^11.2.0.

### Changed
- **Route rename: `GET /sessions/preflight` → `GET /sessions/can-start`.** The original name was chosen before CORS landed; with the CORS layer in place "preflight" needed to refer unambiguously to the browser's `OPTIONS` preflight. The new name pairs naturally with `POST /sessions` — "can I start one?" → "start one". Behaviour is unchanged. Breaking for any existing caller; the WordPress-plugin widget (the only known caller) is being built against this repo in parallel, so the coordination cost is zero.
- `docs/api-usage.md` — new top-level `## CORS` section explaining that browser clients need their `Origin` registered via `sw website origins add`, with notes on preflight handling, allowed methods/headers, credentials-off, and the non-browser bypass. The "CORS is not yet wired" placeholder in the gaps list is removed. Endpoint table + section header renamed to `/sessions/can-start`, with a callout flagging the rename for anyone migrating from 0.10.0.
- `dev-notes/00-project-tracker.md` — new **M15: Friendlier CLI + boot error messages** added to Phase 2. Triggered by a raw `ER_DUP_ENTRY` mysql2 stack trace on `sw website origins add` against a duplicate origin; M15 gathers the error-translation pass for operator-touched surfaces (CLI actions + boot errors) when it becomes a priority. The "CORS in this repo" item is dropped from "Next up" now that it's shipped.

## [0.10.0] - 2026-05-17

### Added
- **Per-website IP geo-blocking** via the local MaxMind GeoIP2 / GeoLite2 country database. New feature, not a milestone wrap — geo-blocking doesn't belong to any of the existing milestones in the tracker, so it lands as a between-milestone feature.
  - Schema (`migrations/0006_add_geo_blocking.js`):
    - `geo_modes` lookup table (`id, code UNIQUE, label`) seeded with `allowall`, `blocklist`, `allowlist`. **No enum columns** — the user's principle is "lookup tables over enums" so the migration ships one and the FK does the rest.
    - `websites.geo_mode_id` FK to `geo_modes.id`, defaulted to `allowall` so existing websites pick up the safe default automatically.
    - `website_geo_countries` join table (`website_id, country_code CHAR(2)`, unique pair) for the per-website ISO 3166-1 alpha-2 list.
  - `src/services/geo.ts` — `MaxMindGeoChecker` (production binding), `GeoChecker` interface (test injection seam), `loadWebsiteGeoPolicy`, `checkGeoPolicy` (pure policy decision), `setWebsiteGeoMode`, `setWebsiteGeoCountries` (atomic replace, uppercases + dedupes), `getWebsiteGeoSummary`, `anyWebsiteHasGeoMode` (boot-time check). Validates ISO code shape (`/^[A-Z]{2}$/`) but doesn't fully validate against the ISO list — MaxMind just never matches invented codes.
  - `src/services/geo.ts` policy: **`allowall` ignores the country list entirely**. `blocklist` denies listed countries, allows everything else. `allowlist` allows listed countries, denies everything else. Unresolvable IPs (private ranges, loopback, malformed) are **allowed in development, denied in production** — the asymmetric default keeps localhost dev workable without opening an unknown-country loophole on a public instance.
  - `src/index.ts` — boot-time validation: if `GEOIP_DB_PATH` is unset but any website has a non-`allowall` mode, refuse to start with a clear message naming the var and the offending policies. If the path is set but the file can't be opened, fail loud too.
  - **New route: `GET /sessions/preflight`.** Same auth + geo policy as `POST /sessions` but mints nothing. Returns `{ ok: true }` on success. Widgets can probe up-front to decide whether to render the chat affordance, instead of waiting for a 403 mid-conversation.
  - Geo check wired into `POST /sessions`, `POST /chat`, `GET /messages`, and the new `GET /sessions/preflight`. Operator/meta routes (`/`, `/health`, `/docs`, `/openapi.json`) are untouched — they don't have a website context. Failure shape is `403 { error: 'geo_blocked' }` with no detail leaked to the client; the operator-side log line carries IP, country, slug, mode, and reason.
  - `Fastify({ trustProxy: true })` — `req.ip` now honours `X-Forwarded-For` from a reverse proxy. No-op in dev (no proxy → falls through to socket address), required for the eventual `api.site-walker.net` deployment behind nginx.
  - CLI: `sw website set-geo-mode <slug> <mode>`, `sw website set-geo-countries <slug> <codes>`, `sw website show-geo <slug>`. The first two are the operator's only path to enabling/disabling geo on a website; the third is a quick summary view.
  - Env (`src/config/env.ts`): two new fields. `NODE_ENV` (default `'production'` — the tighter mode applies unless explicitly overridden) and `GEOIP_DB_PATH` (optional, path to a `.mmdb` file).
  - 22 new tests (135 total). Service-level: each mode × in/out-of-list, null-country-dev-vs-prod, no-checker fallback, set-mode validation, set-countries replace/uppercase/dedupe/reject-invalid, mode-code typeguard, `anyWebsiteHasGeoMode`. Route-level via `fastify.inject({ remoteAddress: ... })` with an injected fake `GeoChecker`: blocklist matches → 403 on POST /sessions, allowlist permits one + denies another, preflight allow/deny (and verifies no session is minted on deny), POST /chat + GET /messages 403 paths.
  - Docs: `docs/cli-sw.md` (three new commands), `docs/env.md` (NODE_ENV + GEOIP_DB_PATH rows + an example block), `docs/api-usage.md` (new `GET /sessions/preflight` reference + `geo_blocked` row in every relevant error table). `.env.example` updated with documented stubs for the new vars.
  - Dep: `maxmind` ^5.0.6 — pure JS, no native bindings, fast synchronous lookups after async file open.

### Changed
- All website-scoped routes now run the geo check **after** website resolution but **before** any work that would have a side effect. POST /sessions doesn't mint a token to a blocked visitor; POST /chat doesn't persist a user message to a blocked visitor; GET /messages doesn't leak history to a blocked visitor. /openapi.json carries the new `403 geo_blocked` response on the affected routes.

## [0.9.1] - 2026-05-17

### Changed
- **Internal refactor: consolidate `process.env` reads behind a single config module.** No observable API change. Patch bump rather than minor because no feature lands; the goal was to stop sprinkling `process.env.X` across the codebase.
  - New `src/config/env.ts`: exports a frozen `RuntimeEnv` singleton (`env`) plus a `loadEnv()` factory for tests that need a fresh snapshot after mutating `process.env`. Normalises `DB_HOST` / `DB_PORT` / `DB_USER` / `DB_PASSWORD` / `DB_NAME`, `HOST` / `PORT`, and `SW_CONFIG` / `XDG_CONFIG_HOME` into typed, defaulted fields. **Ports are validated at startup** — `DB_PORT=not-a-number` (or out-of-range) now fails immediately with a clear "must be a positive integer in [1, 65535]" message instead of becoming `NaN` and surfacing as a confusing MariaDB error later.
  - Consumers refactored to import from `env`: `src/db/index.ts`, `src/index.ts`, `src/cli/chat.ts`, and `src/config/site-walker-config.ts`. The TOML loader's `loadConfig` now accepts an optional `env` param defaulting to the singleton; the two SW_CONFIG-override tests pass `loadEnv()` after mutating `process.env` so they observe their own changes.
  - `searchPaths(xdgConfigHome?)` exposes `XDG_CONFIG_HOME` resolution as a parameter rather than reading `process.env` inline.
  - `src/testing/db.ts`: shared `makeTestDb()` helper consuming `env.db.*`. Five test files (`server`, `chat`, `services/{websites,sessions,models}`) had a duplicated 5-line knex factory; that's now one copy.
  - `knexfile.js` keeps its own DB_* reads — it's plain JS consumed by the knex CLI before any TypeScript build step, so it can't import compiled `src/`. Documented as the one exception in the env module's docstring intent.

### Notes
- Tests are unchanged in count (113) and behaviour — the refactor was strictly internal.
- The next visible feature will get the version bump back into minor territory.

## [0.9.0] - 2026-05-17
  - `components.securitySchemes.bearerAuth` declared (HTTP bearer, `session-token (64 hex chars from POST /sessions)`). Swagger UI gains the **Authorize** button.
  - `GET /messages` and `POST /chat` carry `security: [{ bearerAuth: [] }]` — they show with the 🔒 lock indicator and the UI's "Authorize" flow will attach the token to "Try it out" calls.
  - `POST /sessions` declares its `Origin` header as a documented parameter. Wired with `attachValidation: true` so the route's existing typed-error response (`400 origin_required`) keeps firing on a missing header — no change to the M6 error contract.
  - Existing OpenAPI smoke test in `src/server.test.ts` extended to assert the new components are present.
- Request body schemas for `POST /chat` are still deliberately absent — the deeper fix that would translate AJV validation errors back into our typed `{ error: ... }` codes is a follow-up.

### Notes
- Operator-facing **API docs UI (`/docs`) and the spec endpoint (`/openapi.json`) will likely be gated behind `NODE_ENV !== 'production'`** in a later cut. They're useful for development and self-hosters but don't need to be live on a public production instance. Decision lives with M14 (production deployment).

## [0.9.0] - 2026-05-17

### Added
- **M8 (partial)** — first cloud-LLM protocol adapter. OpenRouter is now a first-class provider, which incidentally unlocks Anthropic / OpenAI / Google models behind a single integration. A direct Anthropic adapter (and Gemini / OpenAI siblings) is planned but deferred — there's no urgent reason to add three adapters when OpenRouter already reaches all of them.
  - `src/providers/openrouter.ts` — `OpenRouterAdapter` implementing the OpenAI Chat Completions wire format: `POST {base_url}/chat/completions`, `Authorization: Bearer <api_key>`, body shape `{ model, messages, temperature?, top_p?, max_tokens?, stop?, stream: false }`. Response parsing pulls `choices[0].message.content` for the reply and `usage.prompt_tokens` / `usage.completion_tokens` for token accounting. Trailing slash on `base_url` is normalised. `api_key` missing → constructor throws.
  - Default `base_url` of `https://openrouter.ai/api/v1` when the TOML entry doesn't set one. Override is supported (self-hosted OpenAI-compatible proxies that speak the OpenRouter shape).
  - Sends `HTTP-Referer: https://site-walker.net` + `X-Title: Site Walker` headers by default so requests show up attributed in OpenRouter's dashboards. Both are overridable via constructor opts.
  - Wired into `buildAdapter` in `src/providers/index.ts`. The previous "lands in M8" throw for `openrouter` is gone; `anthropic` and `openai-compatible` still throw, with the error message now suggesting `openrouter` as the path to Anthropic models in the meantime.
- **Model discovery.**
  - `src/providers/list-models.ts` — `listProviderModels(entry)` queries a configured provider for its available models. `ollama-native` → `GET {base_url}/api/tags`; `openrouter` → `GET {base_url}/models` (with `Authorization: Bearer <api_key>` if a key is present, for dashboard attribution; not strictly required). Returns `{ id, label?, contextWindow? }[]`. Unimplemented protocols throw with a clear message.
  - `sw provider models <provider> [-f|--filter <substring>]` CLI — prints **copy-pasteable full slugs** (`<provider>/<model-id>`) so the output drops straight into `sw website set-model`. `--filter` is a case-insensitive substring match against both id and label; OpenRouter reports hundreds of models, so the filter is the difference between a useful list and noise.
- 14 new tests (113 total). Adapter coverage: payload shape, headers (Authorization + HTTP-Referer + X-Title + Content-Type), parameter mapping, response + usage parsing, 401 path, missing-content path, trailing-slash normalisation, missing-api_key, custom referer/title override. Model-listing coverage: ollama-native mapping, openrouter mapping with context_length, api_key forwarding, missing-base_url for ollama, "not supported" for anthropic, upstream non-2xx surfacing.

### Changed
- `docs/site-walker-toml.md` — protocol table now shows `openrouter` as **implemented**, notes the default base_url + auth header behaviour, and points `anthropic` users at `openrouter` for the time being.
- `templates/site-walker.toml.example` — protocol list and example entries refreshed to reflect openrouter's implemented status and the deferral of direct anthropic.
- `docs/cli-sw.md` — new `sw provider models` section with a worked filter example.

### Notes
- Smoke-tested live against OpenRouter with `anthropic/claude-haiku-4.5`. Side-by-side against `cortex/qwen2:1.5b` on the Raspberry Pi the difference in answer quality is dramatic, as expected — the Pi remains the cheap development target; Haiku is the production-ready option.

## [0.8.0] - 2026-05-17

### Added
- **M7 (partial)** — `./bin/sw` admin surface expansion. Website + sessions are now feature-complete for Phase 1; the `db backup/restore/...` and `blocks rebuild` pieces are deferred to a later cut so we can settle their design questions in sync.
  - `sw website delete <slug> -f|--force` — hard-delete with FK CASCADE. Without `--force` the command refuses; with it, the deletion runs in a transaction and the output reports how many origins / sessions / messages were cascaded.
  - `sw website set-welcome <slug> <message>` — sets `welcome_message`; passing the empty string clears the column to NULL so the route falls back to the built-in default.
  - `sw website origins {list,add,remove} <slug> [...]` — origins are now a proper subgroup. `list` prints id + origin in insertion order. `add` is the new canonical form for what `add-origin` did. `remove` accepts either a numeric `website_origins.id` (as shown by `list`) or an origin URL (matched after the same normalisation `add` applies, so casing/trailing-slash differences don't trip you up).
  - `sw website add-origin <slug> <origin>` is preserved as a working alias of `origins add` so existing scripts and muscle memory keep working.
  - `sw sessions list [--website <slug>] [--limit <n>]` / `sw sessions show <token-or-id>` — read-only browse over the session log. `list` joins through to the website slug and aggregates a message count per row; `show` accepts a numeric id or full token and prints the session metadata plus the ordered message log (with multi-line message bodies indented under the header for readability).
- New service functions:
  - `deleteWebsite(db, slug)` — transactional delete + cascade counts.
  - `setWelcomeMessage(db, slug, message)` — empty string → NULL.
  - `listOrigins(db, slug)` / `removeOrigin(db, slug, ref)` — `ref` is matched as id-or-origin.
  - `listSessions(db, opts)` — joins websites + aggregates message_count, orderBy `last_active_at desc`, limit clamped to `[1, 200]` with a default of 20.
  - `findSessionByTokenOrId(db, ref)` — digit-only ref → id lookup, otherwise → token.
- 10 new service tests (99 total). Coverage: deleteWebsite cascade, setWelcomeMessage set + clear + missing-slug, listOrigins ordering, removeOrigin by id + by origin + missing-ref, findSessionByTokenOrId both branches, listSessions filter + limit + message_count aggregation.

### Changed
- `./bin/chat`'s "no origins configured" hint now points at `sw website origins add` rather than the older `sw website add-origin` form.
- `docs/cli-sw.md` refreshed with the new subcommands (`website delete`, `website set-welcome`, `website origins {list,add,remove}`, `sessions {list,show}`).

## [0.7.0] - 2026-05-17

### Added
- **Landing page** at `GET /`. Browsers (`Accept: text/html`) get a self-contained dark card showing the title, current version, strapline, a live status pill (calls `/health` after page load), four button-links (Health Check / GitHub Repo / API Documentation / OpenAPI JSON), and a small footer. JSON clients still get the previous `{ ok, service, version }` shape — content-negotiated. All HTML/CSS/JS is inline; no external assets, no CDN, no JS framework.
- **`GET /health` endpoint.** Runs `SELECT 1` against MariaDB; returns 200 with `{ ok: true, db: true, version, timestamp }` on success, 503 with `ok: false` otherwise. The landing-page status pill drives off this endpoint.
- **OpenAPI 3.x support** via `@fastify/swagger` + `@fastify/swagger-ui`:
  - `/openapi.json` — the generated spec.
  - `/docs` — Swagger UI for browsing the API interactively.
  - Per-route `schema:` blocks with `summary`, `description`, `tags`, and full `response:` shapes for every status code. Request-body schemas are intentionally left out for now to preserve the M6 typed-error response shapes (`{ error: '...' }`); a follow-up can add them alongside a custom error handler.
- `src/utils/version.ts` — reads `package.json` once at module load and exports the version, so the hardcoded version-in-three-files dance ends. `src/server.ts` and `src/server.test.ts` now reference `VERSION` from this module.
- `package.json` gets `homepage` and `bugs` fields pointing at the GitHub repo; `repository.url` switched from the self-hosted SSH URL to the GitHub HTTPS form.

### Changed
- **Project repository moved to GitHub.** Public repo at https://github.com/headwalluk/site-walker; the previous self-hosted remote at `headgit.net` is retained as a secondary push target (`headgit`) for fallback.
- **`validateRegistryAgainstWebsites` gains an optional `whereSlugs` filter** so tests can scope the consistency check to rows they own, instead of being broken by unrelated `model_slug` values in a shared dev DB. Production callers omit the argument and still scan everything. Fixes a pre-existing test isolation bug that surfaced during the M6 wrap-up.

### Removed
- One historical commit had a real (now-rotated) DB password accidentally committed in `.env.example` and reverted a few commits later. History was rewritten with `git filter-repo --replace-text` before the first GitHub push so the credential never lands on a public remote. Hashes from `532acf8` onward were rebuilt; the `headgit` remote was force-pushed to match.

### Notes
- `dev-notes/verify-trusted-api-default-route.png` (a reference screenshot from a sibling Headwall project) is now gitignored. It stayed on disk as the design guide for the landing page; once it's no longer useful it can be deleted by hand.
- Deps: `@fastify/swagger` ^9, `@fastify/swagger-ui` ^5.

## [0.6.0] - 2026-05-17

### Added
- M6 — Chat endpoint + `./bin/chat` test harness. This is the Phase 1 deliverable: a registered website's session can carry a full multi-turn conversation through the API to its configured model and back, with every turn persisted.
  - `src/services/chat.ts` — `runChat({ db, registry, sessionToken, message })` orchestrates: trim + length-cap the body (`MAX_MESSAGE_CHARS = 8000`), resolve session → website → model via the M5 abstractions, load disk blocks + persona via the M4 loader, estimate `system + history + new-user` tokens and refuse with `context_overflow` when the M5 headroom is busted, persist the user message, call the adapter, persist the assistant reply, return `{ reply, message_id }`. Adapter failures translate to a typed `model_error` and leave the user message in the audit log with no assistant row written. Optional `adapterFactory` injection lets tests stub the upstream without touching real HTTP.
  - `ChatError` class with a stable `code` discriminator (`invalid_token`, `message_required`, `message_too_long`, `context_overflow`, `model_not_configured`, `model_error`); HTTP-status mapping lives entirely in the route layer.
  - `src/server.ts` — new `POST /chat` route. Bearer-token auth, JSON body `{ message: string }`, error codes mapped to status (`401`/`400`/`413`/`502`/`503`). `buildServer({ db, registry, adapterFactory? })` now accepts the provider registry; existing tests that don't touch `/chat` keep working because registry is optional (and `/chat` returns `500 server_misconfigured` if it's missing).
  - `src/index.ts` — loads the TOML registry at boot and runs `validateRegistryAgainstWebsites` before binding, so a stale `model_slug` referencing a missing provider fails fast on startup rather than at first request.
  - `src/cli/chat.ts` — interactive test client. Node + `readline/promises`, `commander` arg parsing. Usage: `./bin/chat <slug> [--origin URL] [--host H] [--port P]`. If `--origin` is omitted, looks up the first allowlisted origin for the slug directly from the DB so the harness "just works" once a website is configured. Reads `HOST`/`PORT` from `.env` (defaults `127.0.0.1:47830`). `/quit` or EOF to exit; bad-status responses print the error code + detail and stay in the loop.
  - 10 new tests in `src/chat.test.ts` (85 total across the suite). Coverage: missing bearer → 401, unknown token → 401, missing/empty body → 400 `message_required`, oversize body → 400 `message_too_long`, no model configured → 503 `model_not_configured`, prompt blows the context window → 413 `context_overflow` with `detail.total_prompt_tokens`/`context_window`, happy path (adapter sees `[system, user]`, response persists, `GET /messages` rehydrates both turns), adapter throws → 502 `model_error` with user message persisted and no assistant row, second turn includes prior history (`[system, user1, assistant1, user2]`), and `buildServer` without a registry → 500 `server_misconfigured`. All driven via `fastify.inject` with an injected fake adapter; no real Ollama call in CI.
- `is_local` boolean on provider entries in `site-walker.toml`. Parsed into `ProviderEntry`, surfaced in `sw provider list`, mentioned in the TOML template. No behaviour wired yet — M11 (rate limiting) will read it to relax limits on self-hosted backends. Cheap-now-vs-cheap-later decision over building a full model-metadata registry; trade-off captured in the M6 design pass.

### Changed
- `src/server.ts` and the corresponding test now report `version: '0.6.0'`. The hardcoded string had been stuck at `0.2.0` since M1 scaffolding — fixed in passing.
- Project version bumped to `0.6.0`. CLI version string in `src/cli/sw.ts` follows.

## [0.5.0] - 2026-05-16

### Changed
- **Config layout cleanup.**
  - Provider-registry search path simplified. First path is now `./site-walker.toml` (project root) instead of `./data/site-walker.toml`. The other three paths (`$HOME/.site-walker/`, XDG, `/etc/`) are unchanged. `SW_CONFIG` override still wins. The motivation: `data/` is for runtime artefacts (per-website regenerated blocks under `data/websites/<slug>/`); the operator-edited registry never belonged in there.
  - `config/` retired. The example file moves from `config/site-walker.toml.example` → `templates/site-walker.toml.example`, joining the existing `templates/PERSONA.md`. The `templates/` directory holds checked-in seed/example content used by `sw website create` and operator setup; `data/` holds gitignored runtime artefacts. Clean separation, no more `config/` vs `data/` vs `templates/` triangle.
- `.gitignore` updated: `/site-walker.toml` (root-level, gitignored) added explicitly; old `config/` mention dropped.
- `dev-notes/03-llm-providers.md`, `templates/site-walker.toml.example`, and `CLAUDE.md` updated to reflect the new layout.
- Project version bumped to `0.5.0`. CLI version string in `src/cli/sw.ts` follows.

### Added
- **`.env` `0600` permission gate.** `DB_PASSWORD` is a secret too; if `.env` exists it must be mode `0600`, same threat model as `site-walker.toml`. New `src/utils/env.ts` with `assertEnvFilePermissions()` called from `src/index.ts`, `src/cli/sw.ts`, and `src/cli/chat.ts`. Inlined at the top of `knexfile.js` (knex CLI consumes this file without a build step, so duplication beats a build dependency). Error message names the file and the exact `chmod 0600` fix. Tests cover the no-op (missing file), 0600 pass, 0644 fail, and 0660 fail cases.

## [0.4.0] - 2026-05-16

### Added
- M5 — LLM provider abstraction:
  - `config/site-walker.toml.example` — checked-in operator template documenting the four search paths (`./data/`, `$HOME/.site-walker/`, `$HOME/.config/site-walker/`, `/etc/`), the `SW_CONFIG` env override, the `0600` permission gate, and one `ollama-native` example. Other protocols (`anthropic`, `openrouter`, `openai-compatible`) commented out for M8.
  - `src/config/site-walker-config.ts` — TOML loader via `smol-toml`. Search-path precedence with `SW_CONFIG` env override (the override is also subject to the `0600` gate — secrets file is secrets file regardless of where it lives). Permission gate refuses to start on group/world-readable modes and prints the exact `chmod` fix. Unknown protocols and malformed `[providers.*]` tables fail loud with the file path in the message.
  - `src/providers/types.ts` — `ProtocolAdapter` interface (`chat(req): Promise<ChatResponse>`), `ChatMessage`, `ChatRequest`, `ChatResponse`, slug parser `parseModelSlug` (splits on first `/`), strict Zod `NormalisedParametersSchema` (`temperature ∈ [0,2]`, `top_p ∈ [0,1]`, `max_tokens` positive int, `stop` string[]). Unknown keys rejected at admin-set time.
  - `src/providers/ollama-native.ts` — `POST {base_url}/api/chat` adapter. Parameter translation per design table (`max_tokens` → `options.num_predict`, etc.). `tokensUsed` populated from `prompt_eval_count` + `eval_count` when the upstream returns them.
  - `src/providers/index.ts` — `buildAdapter(entry)` factory. `anthropic` / `openrouter` / `openai-compatible` throw "lands in M8".
  - `src/services/models.ts` — `setModel` (validates provider exists in registry), `setParameters` (Zod, rejects unknown / out-of-range), `setContextWindow` (positive int), `resolveModel` (returns provider entry + model string + parsed parameters + context window), `validateContextBudget` (12.5%-of-context-window headroom, 512-token floor, error shape from the design doc), `validateRegistryAgainstWebsites` (startup hook — every website with a non-NULL `model_slug` must reference a registered provider).
  - `src/services/websites.ts` — read-side fix in `getWebsiteById` / `getWebsiteBySlug`: parse `model_parameters` from MariaDB's JSON-as-text into the declared `ModelParameters | null` shape so callers stop tripping on string-vs-object surprises.
  - CLI: `sw website set-model <slug> <model-slug>`, `sw website set-parameters <slug> <json>` (JSON-string arg), `sw website set-context-window <slug> <tokens>`, `sw website show-model <slug>`, `sw provider list` (names + protocol + `base_url`; **api_keys are never printed**).
  - 34 new tests (71 total): loader (search paths, override + gate, unknown protocol, malformed TOML, empty registry), slug parser, Zod schema, `ollama-native` adapter against a real `http.createServer` bound to port 0 (request shape, response parsing, error paths, trailing-slash normalisation), model service (provider validation, parameter validation, persistence), context-budget validation against the design-doc error shape, startup-validation hook.
- `dev-notes/03-llm-providers.md` — fixed the false claim that `config/site-walker.toml.example` was checked in at M1 scaffolding (it wasn't); now correctly attributed to M5.
- Deps: `smol-toml` ^1.6, `zod` ^4.

### Changed
- Project version bumped to `0.4.0`. CLI version string in `src/cli/sw.ts` follows.

## [0.3.0] - 2026-05-16

### Added
- M4 — System-blocks loader (per-website):
  - knex migration `0005_add_websites_persona` — `persona TEXT NULL` on `websites`.
  - `templates/` directory (new top-level) with `templates/PERSONA.md` — website-agnostic default persona seed copied into `websites.persona` at `sw website create` time. Directory is intentionally open-ended for future template kinds (TOML defaults, etc.).
  - `src/utils/tokens.ts` — `estimateTokens(text)` returning `Math.ceil(text.length / 3)`. Shared with M5/M6/M10.
  - `src/utils/templates.ts` — `readPersonaTemplate(templatesDir?)`. Loud failure if the template file is missing.
  - `src/services/system-blocks.ts` — `loadDiskBlocks(slug, baseDir?)` discovers `.md` files under `data/websites/<slug>/`, returns them in filename order, skips empties, ignores non-`.md`, treats a missing directory as empty, and **skips a stray `PERSONA.md` on disk with `console.error("PERSONA block already added, skipping PERSONA.md")`**. `assemblePrompt({ persona, diskBlocks })` returns `{ prompt, estimatedTokens, perBlockTokens }`; constant `HANDLING_RULE` exported (no per-website substitution).
  - `src/services/websites.ts` — `Website.persona` field, optional `persona` on `createWebsite` input, new `setPersona(db, slug, text)`.
  - CLI: `sw website create` now seeds `persona` from `templates/PERSONA.md`; `sw website set-persona <slug> <text>` (new); `sw blocks list <slug>` (new) showing per-block (incl. PERSONA) and total token estimates.
  - 19 new tests across `src/services/system-blocks.test.ts`, `src/utils/tokens.test.ts`, `src/utils/templates.test.ts`, plus `setPersona` and `createWebsite` persona coverage in `src/services/websites.test.ts`. 37 tests total across the suite.
- `dev-notes/04-system-blocks.md` — design doc for the per-website system-blocks loader. Flat `data/websites/<slug>/*.md` layout (no prefix-ordering tricks), persona stored in `websites.persona` and emitted by the loader as the first `<block name="PERSONA">`, constant app-managed handling rule with no per-website substitution, operator blocks wrapped as `<block name="…">…</block>` so the model treats them as reference data. `PERSONA.md` filename on disk is reserved (skipped with a warning). No frontmatter, no template/moustache substitution, no caching, no closing reinforcement in v1 — all documented as deliberately deferred (safety/guardrail hardening picked up in M12).
- M3 — Session lifecycle (sessions, messages, POST /sessions, GET /messages):
  - knex migrations `0003_create_sessions` (`token CHAR(64)` UNIQUE, FK to `websites` CASCADE, `summary` column reserved for M9, composite index `(website_id, last_active_at)`) and `0004_create_messages` (FK to `sessions` CASCADE, role ENUM, composite index `(session_id, created_at)`).
  - `src/services/sessions.ts` — `createSession` (32-byte hex token), `findSessionByToken`, `listMessages`, `appendMessage` (atomic insert + `last_active_at` bump).
  - `src/server.ts` rewritten as async `buildServer({ db, logger })`. New routes: `POST /sessions` (verifies request `Origin` against `website_origins`, returns `{ session_token, welcome_message }`; 400 / 403 / 503 stubbed where the design calls for them) and `GET /messages` (bearer-token auth, returns ordered message list).
  - 12 new tests across `src/server.test.ts` (route behaviour via `fastify.inject`) and `src/services/sessions.test.ts` (service-layer roundtrips, token format, transactional `last_active_at` bump). 18 tests pass in total.
  - Default welcome message `"Hi! How can I help?"` when `websites.welcome_message` is NULL.
- M2 — Tenant model (websites + origin allowlist):
  - knex migrations `0001_create_websites` and `0002_create_website_origins` per `dev-notes/02-data-model.md`. `websites` includes the M5-reserved columns (`model_slug`, `model_parameters`, `model_context_window`) so the schema doesn't churn later.
  - `src/services/websites.ts` — service layer (`createWebsite`, `getWebsiteById`, `getWebsiteBySlug`, `addOrigin`, `findWebsiteByOrigin`) with origin normalisation (lowercase host, strip trailing slash, reject non-http(s)/paths/queries) and slug pattern validation.
  - CLI: `sw website create <slug> [--name]`, `sw website show <slug>`, `sw website add-origin <slug> <origin>`. Broader CLI surface lands in M7.
  - 6 integration tests in `src/services/websites.test.ts` against the real MariaDB. All passing.
  - npm scripts: `migrate`, `migrate:rollback`, `migrate:status`, `migrate:make` (each wrapped through `node --env-file-if-exists=.env`).
- `npm run dev` script — concurrently runs `tsc --watch` + `node --watch dist/index.js`. `concurrently` added as a dev dep.
- ESLint config now declares Node globals via the `globals` package (added as a dev dep) so `process`/etc. don't trip `no-undef` in plain JS files like `knexfile.js`.
- `src/server.test.ts` — example node:test exercising the Fastify hello-world via `fastify.inject()`. Verifies the M1 test-harness wiring end-to-end.
- `dev-notes/publishing-to-public-repo.md` — pre-publish checklist (credential sweep, dead-credential handling, README/LICENSE/CI checks) plus the record of known historical leaks. Commit `532acf8` is on the list as a dead-credential row (DB_PASSWORD value rotated immediately on detection).
- CLAUDE.md convention: never default to common ports (3000/8080/etc.); use obscure defaults because the dev host runs many services.

### Changed
- Refactor: `buildServer()` extracted to `src/server.ts`; `src/index.ts` is now a thin entry point that just calls `listen()`. Enables testing without binding a real port.
- Default `PORT` changed from `3000` to `47830` in both `.env.example` and `src/index.ts` fallback. `PORT+1` reserved for any port-bound test server.
- M1 (Project Scaffolding) marked complete in the project tracker; resolved decisions captured in-place.
- README open question "format and source-of-truth for system blocks" removed — settled in M4.
- Project version bumped to `0.3.0`. CLI version string in `src/cli/sw.ts` follows.

### Fixed
- `.env.example` `DB_PASSWORD` reset to the empty placeholder. A real value was accidentally committed in `532acf8`; the credential was rotated and is now dead.

## [0.2.0] - 2026-05-16

### Added
- Initial project documentation: `README.md` (goals, phased approach, non-goals).
- `CLAUDE.md` orientation file capturing tech stack, architecture decisions, and the workflow rule to run `npm run format && npm run lint` before any commit/push.
- Repository scaffolding: `.gitignore`, `CHANGELOG.md`, AGPLv3 `LICENSE`.
- `dev-notes/00-project-tracker.md` with 14 milestones across Phase 1 (smallest end-to-end loop) and Phase 2 (production).
- `dev-notes/01-auth-and-session-flow.md` — design doc for browser auth via `Origin` allowlist + opaque session token, endpoint shapes for `POST /sessions`, `POST /chat`, `GET /messages`, and capacity-check stub for M11.
- `dev-notes/02-data-model.md` — schema sketch for `websites`, `website_origins`, `sessions`, `messages`, with indexing rationale and migration order.
- `dev-notes/03-llm-providers.md` — design for the LLM provider abstraction (TOML registry, slug parser, protocol adapters, normalised parameters, context-window validation).
- `docs/` placeholder distinguishing operator-facing docs from internal `dev-notes/`.
- `data/` directory reserved for runtime artefacts (operator TOML if placed locally, per-website regenerated blocks); fully gitignored.
- M1 scaffolding: TypeScript 6 + Fastify 5 + knex 3 + mysql2 3 deps installed. `tsconfig.json`, `src/index.ts` (Fastify hello-world), `src/cli/sw.ts` (commander CLI skeleton), `src/cli/chat.ts` (readline placeholder), `src/db/index.ts` (knex instance configured from env, lazy pool).
- `bin/sw` and `bin/chat` executable shebang shims; both call `process.loadEnvFile('.env')` with silent fallback.
- npm scripts: `build`, `start`, `test`, `format`, `lint`. `start` and `test` use Node's `--env-file-if-exists=.env`.
- `.env.example` documenting expected variables (HTTP server + MariaDB connection).
- Prettier 3 + ESLint 10 (flat config) + typescript-eslint 8 + eslint-config-prettier as dev deps. `.prettierrc.json`, `.prettierignore`, `eslint.config.js`.

### Changed
- Project pivoted from single-tenant to multi-tenant — one API instance serves many websites, each with its own system blocks and `Origin` allowlist.
- Auth model for browser traffic: was per-website API key, now `Origin` allowlist on session creation + opaque session token (bearer) on subsequent requests. API keys deferred to Phase 2.
- Project tracker restructured: old M2 ("Tenant model + API-key auth") split into M2 (tenant model + origin allowlist) and M3 (session lifecycle + endpoints).
- LLM backend design expanded from "one implementation per backend" to **protocol-adapter abstraction**: host-side TOML registry of providers (with `0600` permission gate and four-location search path), per-website `provider/model` slug + normalised parameters + declared context window in the DB. `ollama-native` is the Phase 1 adapter; `openrouter` and `anthropic` follow in M8.
- M5 milestone rescoped from "Model backend interface" to "LLM provider abstraction" — covers TOML loader, permission gate, protocol adapter interface, slug parser, normalised parameters, context-window validation.
- M8 milestone rescoped from "Anthropic Haiku backend" to "Additional protocol adapters (`openrouter`, `anthropic`)".
- `websites` schema gains `model_slug`, `model_parameters`, `model_context_window` columns (replacing the placeholder `model_backend` column).
- Project version bumped to `0.2.0`. Node engine requirement set to `>=22.0.0`.
