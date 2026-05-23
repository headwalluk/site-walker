# Admin HTTP API

Operator + provisioning HTTP surface, shipped in M19 (v0.15.0). Audience: developers integrating `site-walker-wp` (account-admin path) and `site-walker-for-woo` (provisioning path), plus self-hosters who prefer HTTP over `./bin/sw`.

For the **browser-side** API (Origin + session-token, the chat path itself, including all the ways a chat request can be refused), see [`api-usage.md`](api-usage.md). That doc is for widget developers; this one is for back-office integrations. The admin surface configures the chatbot; it doesn't carry the chat-denial vocabulary (`budget_exhausted_daily`, `geo_blocked`, `session_terminated`, etc.) — those are exclusively on the browser API.

## Audience + scope

Two distinct bearer-token scopes, with two distinct mount points:

| Mount point         | Bearer source                                | Power                                                                |
|---------------------|----------------------------------------------|----------------------------------------------------------------------|
| `/admin/accounts/*` | `SW_PROVISIONING_KEY` in the host `.env`     | Create accounts, mint + revoke account admin keys. Cannot read or write the contents of any account. |
| `/admin/chatbots/*` | Account admin key (from `admin_keys` table)  | Full control of chatbots owned by the auth'd account. Cross-account access refused with `404`.       |

The provisioning key is **deliberately not** in the `admin_keys` table. See `dev-notes/10-saas-shape.md` for the air-gap rationale.

## Authentication

Every request to `/admin/*` carries an `Authorization: Bearer <key>` header.

- **Both key types look like** `sw_<43 chars of base64url>`. Grep-able prefix; deliberately recognisable.
- **Account admin keys** are minted via `POST /admin/accounts/{accountId}/keys` (or `./bin/sw account add-admin-key`). The raw key is shown **exactly once** at mint time. We store only its sha-256 hash. If lost, revoke the key and mint a new one — there is no recovery path.
- **Provisioning key** lives in `SW_PROVISIONING_KEY` in `.env`. Generated with `./bin/sw secrets gen-provisioning-key`. Rotation requires a restart of the API + a coordinated update of any caller (e.g. `site-walker-for-woo`); brief cutover blip is the expected behaviour. See `dev-notes/10-saas-shape.md` for the rotation runbook.

## Error responses

Uniform shape: `{ "error": "<code>", "detail"?: { ... } }`. Codes:

| Status | Code                  | When                                                                            |
|--------|-----------------------|---------------------------------------------------------------------------------|
| 400    | `validation_failed`   | Bad JSON, missing required field, schema violation, malformed value.            |
| 401    | `bearer_required`     | No `Authorization: Bearer …` header.                                            |
| 401    | `bearer_invalid`      | Bearer doesn't match an active credential. Also returned for revoked keys (collapsed deliberately — leaking "this key was once valid" is a minor info leak). |
| 403    | `wrong_scope`         | Provisioning bearer used on `/admin/chatbots/*` (or future symmetric inversion). |
| 403    | `cross_account`       | Currently returned only by `DELETE /admin/accounts/{id}/keys/{keyId}` when the key belongs to a different account. The `/admin/chatbots/*` surface deliberately returns `404 not_found` for cross-account access to avoid leaking other accounts' chatbot slugs. |
| 404    | `not_found`           | Resource doesn't exist, or exists in another account.                           |
| 409    | `conflict`            | Unique-constraint violation (duplicate slug, duplicate origin).                 |
| 413    | `validation_failed`   | Block body exceeds the 64KB cap.                                                |
| 415    | `validation_failed`   | Block PUT body content-type isn't `text/markdown` or `text/plain`.              |

## Routes

### Provisioning surface: `/admin/accounts/*`

| Method | Path                                          | Purpose                                            |
|--------|-----------------------------------------------|----------------------------------------------------|
| GET    | `/admin/accounts`                             | List all accounts.                                 |
| POST   | `/admin/accounts`                             | Create account (`{ slug, name }`).                 |
| GET    | `/admin/accounts/{accountId}/keys`            | List account admin keys (active + revoked).        |
| POST   | `/admin/accounts/{accountId}/keys`            | Mint a new admin key. Raw key returned ONCE.       |
| DELETE | `/admin/accounts/{accountId}/keys/{keyId}`    | Revoke an admin key. Idempotent.                   |

**Account deletion is not exposed via HTTP.** Operators do it via `./bin/sw account delete --force` — the destructive cascade is severe enough to deserve the CLI's explicit `--force` step.

### Account-admin surface: `/admin/chatbots/*`

All routes are scoped to the auth'd account. Chatbots owned by other accounts return `404`.

#### Core CRUD

| Method | Path                                | Purpose                                                                     |
|--------|-------------------------------------|-----------------------------------------------------------------------------|
| GET    | `/admin/chatbots`                   | List the auth'd account's chatbots.                                         |
| POST   | `/admin/chatbots`                   | Create a chatbot in the auth'd account (`{ slug, name, persona? }`).        |
| GET    | `/admin/chatbots/{slug}`            | Fetch one chatbot.                                                          |
| PATCH  | `/admin/chatbots/{slug}`            | Update whitelisted fields (see below).                                      |
| DELETE | `/admin/chatbots/{slug}`            | Hard-delete + cascade. Returns `{ origins, sessions, messages }` counts.    |

`PATCH /admin/chatbots/{slug}` accepts a JSON body with any subset of:

- `name` (string)
- `welcome_message` (string or `null` to clear)
- `persona` (string or `null` to clear)
- `model_slug` (string `"<provider>/<model>"` validated against the registry, or `null` to clear)
- `model_parameters` (object validated by the normalised-parameters Zod schema)
- `model_context_window` (positive integer or `null`)
- `daily_budget_usd` (positive number or `null` — M20 daily spend cap; capped by `SW_MAX_DAILY_BUDGET_USD`)
- `session_budget_usd` (positive number or `null` — M20 per-session spend cap; capped by `SW_MAX_SESSION_BUDGET_USD`)
- `handoff_threshold_pct` (integer 1–100 — soft-handoff trigger as % of the session cap; default 80)
- `handoff_webhook_url` (http(s) URL ≤255 chars, or `null` — fired when a session terminates with a captured visitor email)
- `timezone` (IANA tz string like `"Europe/London"`, or `null` to mean UTC — M21 operational-hours support)
- `availability` (M21 weekly schedule object or `null` to mean always-open; shape: `{ "schedule": { "mon": ["09:00-17:00"], ... } }`; per-day arrays of `"HH:MM-HH:MM"` windows, `24:00` accepted as end-of-day, missing day = closed; full design in [`../dev-notes/14-availability-and-admin-mode.md`](../dev-notes/14-availability-and-admin-mode.md))
- `admin_session_budget_usd` (positive number or `null` — M21 per-session cap for admin-mode sessions; capped by `SW_MAX_SESSION_BUDGET_USD`; NULL = unbounded)

The `slug`, `account_id`, `provider_api_key_*`, and geo settings are **not** patchable via this route — each has its own endpoint (or is immutable here).

Budget caps are sanity-bound by host env vars to limit the blast radius of a stolen admin key. A request that exceeds `SW_MAX_DAILY_BUDGET_USD` or `SW_MAX_SESSION_BUDGET_USD` is refused with `400 validation_failed` and a `detail.message` naming the env var to raise. Same applies to `admin_session_budget_usd` against `SW_MAX_SESSION_BUDGET_USD`. See [`env.md`](env.md) and [`../dev-notes/11-budget-handoff.md`](../dev-notes/11-budget-handoff.md).

#### Origins

| Method | Path                                                    | Purpose                                |
|--------|--------------------------------------------------------|----------------------------------------|
| GET    | `/admin/chatbots/{slug}/origins`                       | List the chatbot's allowlisted origins. |
| POST   | `/admin/chatbots/{slug}/origins`                       | Add one (`{ origin }`). Globally unique. 409 on duplicate. |
| DELETE | `/admin/chatbots/{slug}/origins/{originId}`            | Remove one. 204 on success.            |

Origins are normalised: lowercase host, no trailing slash, `http://` and `https://` are distinct.

#### System blocks (filesystem-backed)

| Method | Path                                              | Purpose                                                  |
|--------|---------------------------------------------------|----------------------------------------------------------|
| GET    | `/admin/chatbots/{slug}/blocks`                  | List block names + byte sizes.                           |
| GET    | `/admin/chatbots/{slug}/blocks/{name}`           | Fetch block content. Response is `text/markdown`.        |
| PUT    | `/admin/chatbots/{slug}/blocks/{name}`           | Write/overwrite block. Body content-type must be `text/markdown` or `text/plain`. Max 64KB. |
| DELETE | `/admin/chatbots/{slug}/blocks/{name}`           | Remove block file. 204 on success.                       |

Block name pattern: `^[A-Za-z0-9_-]+$`. `PERSONA` is **reserved** — it lives in `chatbots.persona` (DB column), not as a disk block; set it via `PATCH /admin/chatbots/{slug}`.

Block files land at `data/chatbots/{slug}/{name}.md` on disk, which is exactly where `loadDiskBlocks` (the chat-path system-block loader) reads from. No restart needed for the new content to take effect — the loader re-reads per request.

#### Provider API key (BYO)

| Method | Path                                  | Purpose                                                              |
|--------|---------------------------------------|----------------------------------------------------------------------|
| PATCH  | `/admin/chatbots/{slug}/api-key`      | Set the chatbot's BYO LLM provider key. Body: `{ api_key }`. ≤255 bytes. |
| DELETE | `/admin/chatbots/{slug}/api-key`      | Clear the key (sets the three encrypted columns to NULL).            |

The plaintext key is encrypted on receive (AES-256-GCM via `SW_ENCRYPTION_KEY`). It never sits in the DB and is never logged.

#### Usage

| Method | Path                                           | Purpose                                |
|--------|------------------------------------------------|----------------------------------------|
| GET    | `/admin/chatbots/{slug}/usage[?since=24h]`    | Aggregate token + USD cost totals.    |

`since` is a relative duration: `Ns` / `Nm` / `Nh` / `Nd`. Omitted means all-time.

Response shape:
```json
{
  "message_count": 47,
  "tokens_in": 12480,
  "tokens_out": 5821,
  "cost_usd": 0.041605,
  "cache_creation_tokens": 0,
  "cache_read_tokens": 0,
  "customer": {
    "message_count": 42,
    "tokens_in": 11200,
    "tokens_out": 5200,
    "cost_usd": 0.038200,
    "cache_creation_tokens": 0,
    "cache_read_tokens": 0
  },
  "admin": {
    "message_count": 5,
    "tokens_in": 1280,
    "tokens_out": 621,
    "cost_usd": 0.003405,
    "cache_creation_tokens": 0,
    "cache_read_tokens": 0
  },
  "period": {
    "since": "2026-05-20T18:00:00.000Z",
    "until": "2026-05-21T18:00:00.000Z"
  },
  "warnings": []
}
```

The top-level totals (`message_count` etc.) carry the combined customer + admin view. The nested `customer` and `admin` objects (M21) carry the split — `customer.cost_usd` is what counts toward the daily-budget cap; `admin.cost_usd` is the operator's own admin-mode usage and doesn't displace customer budget. Use either view depending on what you're surfacing.

`warnings` carries operator-actionable signals — currently only the under-counting warning when a chatbot's current model row has NULL pricing on a metered provider.

#### Admin-mode sessions (M21)

| Method | Path                                       | Purpose                                                                       |
|--------|--------------------------------------------|-------------------------------------------------------------------------------|
| POST   | `/admin/chatbots/{slug}/sessions`          | Mint an admin-mode session for a logged-in site administrator.                |

Account-admin authenticated. Returns a normal session token plus the chatbot's welcome message prefixed with `**Admin mode**\n\n`. The session is marked `is_admin_mode = true` in the database and behaves like any other session from the browser's perspective — same `/chat`, `/messages`, `/sessions/visitor-email` routes, same Bearer-token auth — but with these differences applied throughout the chat path:

- **Skipped:** Origin allowlist, geo blocklist/allowlist, operational availability, daily-cap, capacity stub.
- **Different cap:** session spend is checked against `chatbots.admin_session_budget_usd` instead of `session_budget_usd`. NULL = unbounded.
- **Suppressed:** soft-handoff (`HANDOFF_SOFT.md`) block injection is never applied; handoff webhook does not fire on hard-cap termination.
- **Aggregated separately:** admin-mode spend is excluded from `getChatbotDailySpend` (so it doesn't displace customer budget) and surfaces as the `admin` sub-object in `/usage` responses.

The typical integration is a WordPress plugin: an admin-authenticated page does a server-to-server call against this endpoint using the account admin key, receives a session token, and relays the token back to the browser via an Ajax response. The account admin key never reaches the browser. See [`../dev-notes/14-availability-and-admin-mode.md`](../dev-notes/14-availability-and-admin-mode.md) for the full flow + rationale.

Response shape:
```json
{
  "session_token": "9b3f...",
  "welcome_message": "**Admin mode**\n\nHi! How can I help?",
  "is_admin_mode": true
}
```

Errors: `401 bearer_invalid` / `bearer_required` for missing or wrong-account keys; `404 not_found` for cross-account access (same shape as everywhere else on `/admin/chatbots/*`).

#### Geo policy

| Method | Path                              | Purpose                                                |
|--------|-----------------------------------|--------------------------------------------------------|
| GET    | `/admin/chatbots/{slug}/geo`      | Returns `{ mode, countries }`.                         |
| PATCH  | `/admin/chatbots/{slug}/geo`      | Update mode and/or countries. Either field is optional.|

`mode` is `allowall` / `blocklist` / `allowlist`. `countries` is an array of ISO 3166-1 alpha-2 codes; pass `[]` to clear.

## OpenAPI

All admin routes are documented in the OpenAPI spec served at `/openapi.json` (and rendered at `/docs`). Look under the `admin` tag.

## What this is not

- **Not the chat path.** Chat traffic (`POST /sessions`, `POST /chat`, `GET /messages`) is browser-origin-authenticated and lives under separate routes. See [`api-usage.md`](api-usage.md).
- **Not a sales-channel API.** Subscription/billing happens in WooCommerce at `site-walker.net`. This API is for back-office integration **only**.
- **Not paginated.** v1 surfaces return full lists. If a real customer with 100+ chatbots shows up, pagination becomes a follow-up — none today.
