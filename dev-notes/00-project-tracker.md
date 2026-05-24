# site-walker — Project Tracker

**Last Updated:** 24 May 2026
**Current Version:** 0.19.0
**Current Phase:** **Road to v1.0.0 — first paying client.** SaaS-pivot block closed at v0.16.0 (M20: budget caps); M21 (operational hours + admin-mode sessions, v0.17.0) landed the last pre-v1.0.0 API feature. Phase 4 (M22–M26) is the punch list for first release. **M22 (admin HTTP for session/conversation review, v0.18.0)** + **M23 (in-memory rate limiting, v0.19.0)** both shipped 2026-05-24. Remaining: production deployment polish (M24), Anthropic prompt-caching adapter wiring (M25), README rewrite (M26). Everything below the v1.0.0 line is post-launch.
**Overall Progress (post-M23, v0.19.0):** M1–M6 complete, M7 + M8 partial, M16–M23 complete (v0.12.0 through v0.19.0). Admin HTTP surface live with M20 budget caps + M21 availability + admin-mode sessions + M22 session/conversation review. Public chat path carries per-IP and per-chatbot rate limits via `@fastify/rate-limit` + in-memory `ChatbotRateLimiter`; `429 rate_limit_exceeded` with `Retry-After` on both layers; M3 `hasCapacity()` stub deleted. Daily + per-session + admin-session caps enforced end-to-end; soft-handoff prompt injection; hard-cap session termination + webhook; per-chatbot operational hours with `503 chatbot_closed`; admin-mode sessions skip Origin/geo/availability/daily-cap gates and aggregate spend separately. 349 tests, format + lint clean.

Vision and phasing live in [`../README.md`](../README.md). **Note:** README still markets the prototype-era "self-hosted multi-tenant API" framing; rewrite ships after M16 lands, not before, to avoid documenting vapourware. Stack and architecture decisions live in [`../CLAUDE.md`](../CLAUDE.md). Auth/session and data-model design live in companion docs in this directory. This file tracks the work.

Companion planning docs:
- [`01-auth-and-session-flow.md`](01-auth-and-session-flow.md) — origin allowlist, session-token lifecycle, endpoint shapes
- [`02-data-model.md`](02-data-model.md) — **v1.0 schema reference** (rewritten in M16 — `accounts`, `chatbots`, `chatbot_origins`, `chatbot_geo_countries`, `sessions`, `messages`, `geo_modes`). [`db-schema-pre-m16.sql`](db-schema-pre-m16.sql) is the frozen v0.11.0 snapshot kept for reference.
- [`03-llm-providers.md`](03-llm-providers.md) — TOML provider registry, per-chatbot model selection, protocol adapters, normalised parameters, context-window handling. **Superseded in M17 by DB-backed provider registry** ([`10-saas-shape.md`](10-saas-shape.md)).
- [`10-saas-shape.md`](10-saas-shape.md) — SaaS architecture (four-repo topology, account model, BYO keys, admin HTTP API, M16–M20 phasing)
- [`11-budget-handoff.md`](11-budget-handoff.md) — budget-driven conversation handoff (soft-handoff at 80% spend, hard-cap → email capture). Recasts old M9 history-trimming as part of M20's budget-cap UX. Settled during M20 design pass.
- [`13-hierarchical-system-blocks.md`](13-hierarchical-system-blocks.md) — promote `data/chatbots/<slug>/` from a flat directory to a topic-aware tree; LLM activates topics on demand via `<load-topic>` tagged tokens. Design-in-flight, targeted at v1.1.0 (post-first-customer).
- [`14-availability-and-admin-mode.md`](14-availability-and-admin-mode.md) — per-chatbot operational hours (timezone + weekly schedule) + admin-mode session type for logged-in WP administrators. Design-in-flight, M21 target (pre-v1.0.0).

## Next up — road to v1.0.0

Post-M22, 2026-05-24. The API surface is feature-complete for first customer; v1.0.0 is the punch list to make the launch responsible. Phase 4 milestones are M22–M26 below; everything past the divider is post-launch.

1. ✅ **M22 — Admin HTTP for session/conversation review.** Shipped 2026-05-24 at v0.18.0.
2. ✅ **M23 — Rate limiting (in-memory).** Shipped 2026-05-24 at v0.19.0.
3. **M24 — Production deployment polish.** Single systemd unit (no PM2), `Restart=always`, journal logging. Folds in the two M14 follow-ups (gate `/docs` + `/openapi.json` on non-production; request-body schema on `POST /chat` with `attachValidation: true`). Deployment runbook. Production reverse proxy for `api.site-walker.net` (DNS/cert, no IP lock).
4. **M25 — Anthropic prompt caching adapter wiring.** Substrate already in DB (M18). Adapter sends `cache_control` markers on the system-blocks prefix, parses cache stats from responses, gates by model, skips below the minimum-cacheable threshold. ~70-80% input-billing reduction expected on stable-system-block chatbots.
5. **M26 — README rewrite + docs polish.** Current README still markets the prototype-era "self-hosted multi-tenant API" framing; rewrite around the SaaS pivot, BYO keys, budget caps, operational hours, admin mode. First thing a prospective customer reads.
6. **First paying client on `api.site-walker.net`.** End-to-end test of the whole stack with BYO Anthropic key, daily cap configured (informed by real M18 usage data once we have a couple of real chatbots running for a week), the `site-walker-wp` widget installed on the customer's WordPress, operational hours set to the client's business hours, admin mode usable by Woo store staff, and the operator's CRM wired to `handoff_webhook_url` for email capture. The whole point of the SaaS pivot.

Below the v1.0.0 line: cluster mode + Redis (paired, M11), DB backup/restore CLI (M7 finish), prompt-injection guardrails (M12), conversation retention + PII (M13), friendlier CLI errors (M15), hierarchical system blocks, auto-mode content ingestion + condensation, OAuth-style plugin linking. See "Post-v1.0.0 — future development" section.

---

## Phase 1 — Smallest end-to-end loop

Goal: prove a visitor on a registered website can chat to the bot, with the browser auth'd by `Origin` allowlist + session token, that website's system blocks prepended, and per-session history maintained server-side. Ollama-only. Tested via `curl` and `./bin/chat`. Validates the Pi context-window assumptions before any Phase 2 investment.

### Milestone 1: Project scaffolding

**Target Completion:** 16 May 2026
**Status:** ✅ Complete (16 May 2026)
**Priority:** Foundation — blocks everything else

npm init, TypeScript config, Fastify server with a hello-world route, knex installed and configured against MariaDB, `.env` handling, linter, formatter, test harness. Skeleton `bin/sw` and `bin/chat` in place so later milestones plug into a working frame.

**Resolved decisions:**
- Module system: ESM (`"type": "module"`).
- Test framework: `node:test` (built-in, zero deps).
- CLI lib: `commander.js`.
- `./bin/chat` language: Node + `readline/promises`.
- Lint/format: Prettier 3 + ESLint 10 flat config + typescript-eslint 8 + eslint-config-prettier.
- Env handling: Node's `--env-file-if-exists=.env` in npm scripts + `process.loadEnvFile('.env')` (silent fallback) in `bin/*` shims.
- Server structure: `src/server.ts` exports `buildServer()`; `src/index.ts` is a thin entry point that calls `listen()`. Enables `fastify.inject()` based tests without binding a port.

### Milestone 2: Tenant model (websites + origin allowlist)

**Target Completion:** 16 May 2026
**Status:** ✅ Complete (16 May 2026)
**Priority:** High — every other Phase 1 milestone depends on this

knex migrations for `websites` and `website_origins` tables per [`02-data-model.md`](02-data-model.md). Service layer for CRUD. Minimal CLI commands to make this testable: `sw website create <slug>` and `sw website add-origin <slug> <origin>`. No HTTP auth wired yet — that lands in M3 with session lifecycle. Broader CLI surface (list/show/remove) is M7.

**Shipped:**
- `knexfile.js` at repo root (ESM, env-driven connection), plus `migrate` / `migrate:rollback` / `migrate:status` / `migrate:make` npm scripts wrapped through `node --env-file-if-exists=.env`.
- `migrations/0001_create_websites.js` — `websites` table with `id`, `slug`, `name`, `welcome_message`, `model_slug`, `model_parameters` (JSON), `model_context_window`, `created_at`, `updated_at` (with `ON UPDATE CURRENT_TIMESTAMP`).
- `migrations/0002_create_website_origins.js` — FK → `websites.id` (CASCADE), unique `origin`, index on `website_id`.
- `src/services/websites.ts` — `createWebsite`, `getWebsiteById`, `getWebsiteBySlug`, `addOrigin`, `findWebsiteByOrigin`, plus exported `normaliseOrigin` (lowercases host, strips trailing slash, rejects non-http(s) / paths / queries) and a slug pattern check.
- CLI commands wired in `src/cli/sw.ts`: `sw website create <slug> [--name]`, `sw website show <slug>`, `sw website add-origin <slug> <origin>`. Pool is destroyed in each action's `finally` so the process exits cleanly.
- `src/services/websites.test.ts` — 6 integration tests against the real MariaDB (roundtrip, slug validation, origin add/find, normalisation of host case + trailing slash, missing-website rejection, pure-function `normaliseOrigin` cases). All passing.
- `npm run dev` script added (concurrently runs `tsc --watch` + `node --watch dist/index.js`).

### Milestone 3: Session lifecycle (POST /sessions, GET /messages)

**Target Completion:** 16 May 2026
**Status:** ✅ Complete (16 May 2026)
**Priority:** High — defines the auth model for browser traffic

knex migrations for `sessions` and `messages` tables (also in [`02-data-model.md`](02-data-model.md)). Implement the session-creation and history-rehydrate endpoints per [`01-auth-and-session-flow.md`](01-auth-and-session-flow.md):
- `POST /sessions` — verifies request `Origin` against `website_origins`, mints opaque session token, persists `(website_id, token)`, returns `{ session_token, welcome_message }`.
- `GET /messages` — bearer-token auth, returns full conversation for the bound session (used by client for initial-load rehydrate).

Welcome message stored as a column on `websites`. Capacity check (503) is a stub in Phase 1 — wiring exists, returns 201 unconditionally until M11.

**Shipped:**
- `migrations/0003_create_sessions.js` — `sessions` table (BIGINT PK, `website_id` FK CASCADE, unique `token CHAR(64)`, nullable `summary` reserved for M9, `created_at`/`last_active_at`, composite index on `(website_id, last_active_at)`).
- `migrations/0004_create_messages.js` — `messages` table (BIGINT PK, `session_id` FK CASCADE, `role` ENUM('user','assistant'), `content` TEXT, composite index on `(session_id, created_at)`).
- `src/services/sessions.ts` — `createSession` (generates 32-byte hex token), `findSessionByToken`, `listMessages` (ordered ascending), `appendMessage` (transactional: insert + bump `last_active_at`).
- `src/server.ts` rewritten as async `buildServer({ db, logger })`. Routes: existing `GET /`, plus `POST /sessions` (Origin → website resolve → capacity stub → token mint → `{ session_token, welcome_message }`) and `GET /messages` (bearer auth → message list). Default welcome message `"Hi! How can I help?"` when `websites.welcome_message` is NULL.
- `src/index.ts` updated to await the async builder with the singleton db.
- 8 new tests in `src/server.test.ts` (routes via `fastify.inject`) plus 4 in `src/services/sessions.test.ts`. 18 tests total across the suite, all passing.

**Deferred to M6 (chat endpoint):** CORS wire-up. Phase 1 still verifies Origin in the route handler; `fastify.inject` tests and `./bin/chat` server-side calls don't need preflight. Browser-side widget integration brings the CORS layer in.

### Milestone 4: System-blocks loader (per-website)

**Target Completion:** 16 May 2026
**Status:** ✅ Complete (16 May 2026)
**Priority:** High — settles an open question from README

Design settled in [`04-system-blocks.md`](04-system-blocks.md): flat `data/websites/<slug>/*.md` layout (no prefix-ordering tricks), a constant app-managed handling rule (no per-website substitution), persona stored in `websites.persona` and emitted by the loader as the first `<block name="PERSONA">`, operator blocks wrapped as `<block name="…">…</block>`. `templates/PERSONA.md` shipped in-repo as the seed used at website-creation time. No frontmatter, no caching, no closing reinforcement in v1 — all documented as deliberately deferred (safety/guardrail hardening picked up in M12).

**Shipped:**
- `migrations/0005_add_websites_persona.js` — `persona TEXT NULL` on `websites`. Applied as batch 3.
- `templates/PERSONA.md` — website-agnostic default persona seed, checked in. `templates/` directory is intentionally open-ended (TOML configs and other defaults can land here later).
- `src/utils/tokens.ts` — `estimateTokens(text)` returning `Math.ceil(text.length / 3)`. Shared with M5/M6/M10.
- `src/utils/templates.ts` — `readPersonaTemplate(templatesDir?)`. Loud failure if missing.
- `src/services/system-blocks.ts` — `loadDiskBlocks(slug, baseDir?)` (alphabetical order, skips empties, ignores non-`.md`, missing dir → empty array, **`PERSONA.md` on disk logs `console.error("PERSONA block already added, skipping PERSONA.md")` and is skipped**); `assemblePrompt({ persona, diskBlocks })` returning `{ prompt, estimatedTokens, perBlockTokens }`. Constant `HANDLING_RULE` exported.
- `src/services/websites.ts` — added `Website.persona`, optional `persona` on `createWebsite` input, new `setPersona(db, slug, text)`.
- `src/cli/sw.ts` — `sw website create` seeds `persona` from `templates/PERSONA.md`; new `sw website set-persona <slug> <text>`; new `sw blocks list <slug>` showing per-block (incl. PERSONA) and total token estimates.
- 19 new tests (37 total across the suite). All passing. Lint clean, format clean.

**Resolved decisions** (recorded in [`04-system-blocks.md`](04-system-blocks.md)):
- Flat directory of `.md` files per website. No subdirectories, no frontmatter, no template/moustache substitution in v1.
- Persona lives in the DB (`websites.persona`), not on disk. Loader emits it as the first `<block name="PERSONA">`. `PERSONA.md` filename on disk is reserved — skipped with a warning.
- Filename order (lexicographic ASCII ascending) determines disk-block order; PERSONA always first.
- Per-request reread of disk + DB. No caching layer in v1. M11 (Redis) is the natural place to add one if profiling shows it's hot.
- Loader returns token estimate but does **not** enforce a budget — enforcement lives in M5 (admin-set), M6 (request), M10 (rebuild).

### Milestone 5: LLM provider abstraction

**Target Completion:** 16 May 2026
**Status:** ✅ Complete (16 May 2026)
**Priority:** High — shape locks in every future provider/model addition

Full design in [`03-llm-providers.md`](03-llm-providers.md). The host-side TOML registry, `0600` permission gate, slug parser, adapter interface, normalised parameter schema, and the `ollama-native` adapter all land in this milestone, plus the admin CLI surfaces for per-website model selection.

**Shipped:**
- `config/site-walker.toml.example` — checked-in operator template with documented search paths, override semantics, permission gate reminder, and one ollama-native example.
- `src/config/site-walker-config.ts` — search path resolution (`./data/`, `$HOME/.site-walker/`, `$HOME/.config/site-walker/`, `/etc/`) with `SW_CONFIG` env override (override also subject to the gate), `0600` permission gate that names the file and the fix command, smol-toml parsing, protocol enum validation. Returns a typed `ProviderRegistry` (`Map<string, ProviderEntry>`).
- `src/providers/types.ts` — `ProtocolAdapter` interface (`chat(req): Promise<ChatResponse>`), `ChatMessage`/`ChatRequest`/`ChatResponse`, slug parser (`parseModelSlug` — splits on first `/`), Zod `NormalisedParametersSchema` (strict, `temperature [0,2]`, `top_p [0,1]`, `max_tokens` positive int, `stop` string[]).
- `src/providers/ollama-native.ts` — `POST {base_url}/api/chat` adapter with parameter translation (`max_tokens` → `options.num_predict`, etc.). Captures `tokensUsed` from Ollama's `prompt_eval_count` + `eval_count`.
- `src/providers/index.ts` — `buildAdapter(entry)` factory. Other protocols throw with "lands in M8".
- `src/services/models.ts` — `setModel`, `setParameters`, `setContextWindow`, `resolveModel`, `validateContextBudget` (12.5%-of-context-window headroom with 512 floor), `validateRegistryAgainstWebsites` (startup hook).
- `src/services/websites.ts` — read-side fix: parse `model_parameters` from JSON-string to object in `getWebsiteById` / `getWebsiteBySlug`, so callers see the declared `ModelParameters | null` shape.
- CLI: `sw website set-model`, `sw website set-parameters` (JSON arg), `sw website set-context-window`, `sw website show-model`, `sw provider list` (names + protocol + base_url; never api_keys).
- 34 new tests (71 total across the suite). Lint clean, format clean.
- Deps: `smol-toml`, `zod`.

The per-website columns (`model_slug`, `model_parameters`, `model_context_window`) were added in M2; M5 gives them meaning.

Ollama remains the lowest common denominator — design system blocks against the Pi's tight context. Larger-context providers unlock larger blocks per-website, but we never assume a fat context globally.

### Milestone 6: Chat endpoint + `./bin/chat` test harness

**Target Completion:** 17 May 2026
**Status:** ✅ Complete (17 May 2026)
**Priority:** Critical — this *is* the Phase 1 deliverable

`POST /chat` that ties everything together: bearer session token resolves website + session, append the new user message to `messages`, load full history, load that website's system blocks, call the model backend, persist the assistant reply, return `{ reply, message_id }`. Returns only the new reply, **not** the full history — clients use `GET /messages` for rehydrate.

`./bin/chat` — small interactive script that reads `.env` for host/port, calls `POST /sessions` to get a token, then loops on user input.

**Shipped:**
- `src/services/chat.ts` — `runChat({ db, registry, sessionToken, message })` orchestrates: trim + length-cap (`MAX_MESSAGE_CHARS = 8000`), resolve session → website → model via M5 abstractions, load persona + disk blocks via the M4 loader, refuse `context_overflow` (system + history + new-user vs. window with the M5 12.5%/512-floor headroom), persist user message, call adapter, persist assistant reply, return `{ reply, message_id, tokens_used? }`. Adapter throw → typed `model_error`, user message stays in the audit log, no assistant row written. Optional `adapterFactory` injection for tests.
- `ChatError` with a stable `code` discriminator (`invalid_token` / `message_required` / `message_too_long` / `context_overflow` / `model_not_configured` / `model_error`). HTTP-status mapping lives entirely in the route layer.
- `src/server.ts` — `POST /chat` route. Bearer-token auth, JSON body `{ message: string }`, error→status mapping (`401`/`400`/`413`/`502`/`503`). `buildServer({ db, registry, adapterFactory? })` now takes the provider registry; `registry` is optional so the older `/sessions` + `/messages` tests don't churn, and `/chat` returns `500 server_misconfigured` if it was omitted.
- `src/index.ts` — loads the TOML registry at boot and runs `validateRegistryAgainstWebsites` before `fastify.listen` so a stale `model_slug` referencing a missing provider fails fast at startup, not on first request.
- `src/cli/chat.ts` — Node + `readline/promises`, `commander` parsing. Usage: `./bin/chat <slug> [--origin URL] [--host H] [--port P]`. When `--origin` is omitted, looks up the first allowlisted origin for the slug directly via knex (no extra CLI ceremony). Reads `HOST`/`PORT` from `.env`, defaults `127.0.0.1:47830`. `/quit` or EOF exits; non-2xx responses print code + detail and stay in the loop.
- 10 new tests in `src/chat.test.ts` (85 total across the suite). Covers every typed error and the happy path; the multi-turn history check confirms turn 2 sends `[system, user1, assistant1, user2]` to the adapter. All driven via `fastify.inject` with an injected fake adapter — no real Ollama call in CI.
- Smoke-tested end-to-end against the live Pi (`cortex/qwen2:1.5b`, context window 4096): two-turn curl conversation recalled a name from turn 1 in turn 2; `./bin/chat` mints a session, sends the message, prints the reply, and `GET /messages` rehydrates both turns.
- `is_local` flag on provider TOML entries (parsed into `ProviderEntry`, surfaced by `sw provider list`, documented in `templates/site-walker.toml.example`). No behaviour wired yet; M11 will read it for rate-limit tuning. Deliberately preferred over a full `provider/model` metadata registry — see open-question resolution below.
- Fixed long-stale `version: '0.2.0'` in `src/server.ts` (and the matching `server.test.ts` assertion) → `0.6.0`.

**Resolved decisions:**
- **No model-metadata registry in Phase 1.** Static `provider/model → context_window` tables are clean for the 4 Ollama models we care about but fall apart for OpenRouter's hundreds. The per-website `model_context_window` column already gives the budget check what it needs. Revisit if/when M8 brings cloud providers and we can see what the call sites actually want.
- **`is_local` lives on the provider, not the model.** A single provider entry is either Ollama-on-LAN or it isn't — one boolean, accurate by construction, no maintenance churn. Powers future M11 rate-limit decisions for free.
- **Health/`is_online` is M11/M14 territory.** Needs background probes, staleness rules, circuit-breaker semantics — out of scope here.
- **Budget enforcement on the request path = hard refuse with `413 context_overflow`.** Graceful trimming is explicitly M9's job; faking it now would be half-finished work the M9 milestone has to undo.
- **Failure semantics on adapter throw = user msg stays, no assistant row, `502 model_error`.** The conversation log requirement (M13) wants that user turn captured regardless of upstream availability.

### Milestone 7: Admin CLI (`./bin/sw`)

**Target Completion:** in progress
**Status:** 🟡 Partial (0.8.0, 17 May 2026)
**Priority:** High — operator surface for everything Phase 1 produced

Expand the M2/M3 stub CLI into a full admin surface. Subcommands (working names):
- ✅ `sw website list/show/delete` — `create`/`show` from M2, `list` pulled forward 17 May 2026, `delete` shipped at 0.8.0.
- ✅ `sw website origins list/add/remove <slug>` — full subgroup shipped at 0.8.0. `sw website add-origin` (M2) kept as a working alias.
- ✅ `sw website set-welcome <slug> <message>` — shipped at 0.8.0; empty-string clears to NULL.
- ✅ `sw sessions list/show <token-or-id>` — shipped at 0.8.0; read-only dev browse with website-scoped filter and per-row message counts. The formal review surface (retention, redaction) still comes in M13.
- 🔴 `sw db backup/restore/list/prune` — deferred. Wrapper around `mysqldump`/`mysql` needs design calls (storage path, filename convention, retention policy for `prune`, restore's overwrite semantics, mysqldump credential handling). Worth a focused sync before implementing.
- 🔴 `sw blocks rebuild <slug>` — deferred to M10. The command's job is to trigger the M10 cron logic ad-hoc; nothing to trigger until that lands.

**Shipped at 0.8.0:**
- `src/services/websites.ts` — `deleteWebsite` (transactional, returns cascade counts for origins/sessions/messages), `setWelcomeMessage` (empty string → NULL → server falls back to default), `listOrigins`, `removeOrigin` (id-or-origin-string).
- `src/services/sessions.ts` — `listSessions({ websiteSlug?, limit? })` returning rows with `website_slug` and aggregated `message_count`, ordered by `last_active_at desc`, limit clamped `[1, 200]` default 20. `findSessionByTokenOrId` resolves digit-only refs → id, else → token.
- CLI surface: `sw website delete -f|--force`, `sw website set-welcome`, `sw website origins {list,add,remove}`, `sw sessions {list,show}`.
- `./bin/chat`'s "no origins configured" error now points at the canonical `origins add` form.
- `docs/cli-sw.md` refreshed with every new subcommand.
- 10 new service tests (99 total).

---

## Phase 2 — Production

Goal: a publicly-exposed pre-sales bot that's safe to point real visitor traffic at. Pluggable backends, abuse protection, automated regeneration of system blocks, retention policy, deployable.

### Milestone 8: Additional protocol adapters (`openrouter`, `anthropic`, …)

**Target Completion:** in progress
**Status:** 🟡 Partial (0.9.0, 17 May 2026)
**Priority:** High — unlocks production-grade models per README hardware strategy

Add cloud-LLM protocol adapters to the M5 abstraction.

- ✅ **`openrouter`** (priority) — shipped at 0.9.0. OpenAI Chat Completions wire format. `POST {base_url}/chat/completions`, `api_key` required, `base_url` defaults to `https://openrouter.ai/api/v1`. Sends `HTTP-Referer: https://site-walker.net` + `X-Title: Site Walker` for dashboard attribution. Smoke-tested live against `anthropic/claude-haiku-4.5`.
- 🔴 **`anthropic`** — direct Messages API. Deferred — OpenRouter already reaches all Anthropic models, and the user wants this batched with the broader cloud-provider cluster (Gemini, OpenAI direct) when those land together.
- 🔴 **`openai-compatible`** — generic OpenAI-clone. Reserved for a concrete third use case that isn't OpenRouter-specific. No demand yet.

Detailed per-adapter parameter translation per [`03-llm-providers.md`](03-llm-providers.md). Error mapping (auth failures, rate limits, context overflows) is currently surfaced via the existing `model_error` 502 path; richer typed mapping is a future polish, not a v1 blocker.

**Shipped at 0.9.0:**
- `src/providers/openrouter.ts` — adapter + DEFAULT_OPENROUTER_BASE_URL constant + DEFAULT_REFERER / DEFAULT_TITLE.
- `buildAdapter` in `src/providers/index.ts` — `openrouter` wired; the "lands in M8" throw retained for `anthropic` / `openai-compatible` with a hint pointing at openrouter.
- `src/providers/list-models.ts` + `sw provider models <provider> [-f|--filter <substring>]` — generic discovery surface. ollama-native uses `/api/tags`, openrouter uses `/models`. Output prints copy-pasteable full slugs so they drop straight into `sw website set-model`.
- 14 new tests (113 total).

### Milestones 9–15: deferred to post-v1.0.0

M9 (history trimming), M10 (system-blocks regeneration cron), M11 (rate limiting + abuse + cluster mode), M12 (prompt-injection / jailbreak), M13 (conversation retention + PII), M15 (friendlier CLI errors): **deferred below the v1.0.0 line.** See "Post-v1.0.0 — future development" for current status, paragraph-level notes, and the trigger conditions that would pull each forward.

M14 (production deployment) is absorbed into **M24 — Production deployment polish** above the line. The original M14 cluster-mode-validated-end-to-end goal moved to M11 below the line (clustering and Redis-backed rate limiting are paired, both post-v1.0.0).

---

## Phase 3 — SaaS

Goal: turn the prototype into a multi-tenant SaaS billable via WooCommerce at `site-walker.net`, with a real client live on it. Full architecture in [`10-saas-shape.md`](10-saas-shape.md). Open-source self-hosting still supported; SaaS path adds an account layer + admin HTTP API on top.

Done in this five-milestone block:
- Customer accounts on top of chatbots.
- Bring-your-own LLM provider keys, encrypted at rest.
- Provider/model/pricing data hot-editable (in DB, not TOML).
- Cost accounting per message.
- Admin HTTP API for the `site-walker-wp` plugin and the `site-walker-for-woo` provisioning side.
- Budget caps (daily + per-session).

After M20, the deferred prototype-era milestones (old M9, M11, M12, M13, M14, M15) come back into focus — informed by what the first real customer actually trips over. Auto-mode content ingestion + condensation pipeline + operational hours are post-M20 too.

### Milestone 16: Multi-tenant + rename (`websites` → `chatbots`)

**Target Completion:** 20 May 2026
**Status:** ✅ Complete (20 May 2026, v0.12.0)
**Priority:** Critical — schema-affecting; everything downstream depends on the rename being done first

Clean-break rebuild. The prototype database is wiped; historical migrations `0001`–`0005` are deleted from the repo and replaced with a single greenfield `0001_create_schema.js` capturing the v1.0 shape:

- `accounts` (new top-level entity)
- `chatbots` (renamed from `websites`, with `account_id` FK)
- `chatbot_origins` (renamed from `website_origins`)
- `sessions` (with `chatbot_id` FK, renamed from `website_id`)
- `messages`
- `chatbots.persona` (folded in — previously its own migration)
- Geo-blocking columns from 0.10.0 (folded in)

After M16, strict forward-only migration discipline resumes — additive migrations only from M17 onward. The squash is a one-time pre-release move; we can do it because nobody but us has ever run this schema and the user has confirmed the prototype chatbot is off.

Code-side: mechanical rename pass across services, CLI, tests, docs. `sw chatbot ...` is the only form (no `sw website ...` deprecation aliases — no legacy to bridge). New `sw account create/list/delete` CLI surface. Rename `data/websites/<slug>/` → `data/chatbots/<slug>/` to keep on-disk paths consistent.

**Why now and not later:** once admin HTTP endpoints (M19) publish, the name is part of the customer-facing contract. Renaming after that is breaking. Renaming now is purely internal churn.

**Resolved decisions:**
- Squash + clean-break migration (no rename-on-top, no backfill account needed) — agreed 2026-05-19.
- **Dev DB content is being discarded as part of the squash** — the cortex/qwen2 test conversation logs accumulated through M6/M8 smoke testing go with it. Confirmed acceptable: nothing in there is a real customer interaction or otherwise worth preserving. `data/websites/cortex-test/` (or whatever local seed paths exist) get the same treatment.
- `data/chatbots/<slug>/` directory rename for consistency — agreed 2026-05-19.
- No deprecation aliases for `sw website ...` — no legacy to bridge.
- One account → many chatbots ([`10-saas-shape.md`](10-saas-shape.md)).
- One chatbot → many origins (cross-brand sharing is a real use case).
- Billing per-account, not per-chatbot.

**Shipped at 0.12.0:**
- `migrations/0001_create_schema.js` — single greenfield migration. Tables: `accounts` (CHAR(36) UUID PK), `geo_modes` (+3 seed rows), `chatbots` (renamed from `websites`, with `account_id` FK CASCADE + `geo_mode_id` FK RESTRICT), `chatbot_origins`, `sessions` (with `chatbot_id`), `messages` (unchanged), `chatbot_geo_countries`. utf8mb4_uca1400_ai_ci collation carried forward.
- `src/services/accounts.ts` — `createAccount` (UUID via `crypto.randomUUID()`), `getAccountById`, `getAccountBySlug`, `listAccounts`, `deleteAccount` (returns full cascade counts: chatbots/origins/sessions/messages).
- `src/services/chatbots.ts` (renamed from `websites.ts`) — mechanical rename pass; `createChatbot` now requires `account_id`.
- `sw account` CLI subgroup: `create`, `list`, `show`, `delete -f|--force`.
- `sw chatbot create <slug> --account <account-slug>` — required flag, no fallback.
- `sw chatbot ...` is the only form — no `sw website ...` deprecation alias; the legacy `sw chatbot add-origin` alias (was kept through M7) is also gone.
- `sw sessions list -c|--chatbot <slug>` (was `-w|--website`).
- `src/testing/db.ts::seedAccountAndChatbot` — one-line fixture for the ~113 test refs.
- `DEFAULT_DATA_DIR` → `data/chatbots/`; on-disk dir renamed in step.
- `dev-notes/02-data-model.md` is now the v1.0 schema reference; `dev-notes/db-schema-pre-m16.sql` frozen as a forensic reference.
- Doc rename pass across `dev-notes/01-auth-and-session-flow.md`, `dev-notes/04-system-blocks.md`, `docs/cli-sw.md` (new `sw account` section, `sw chatbot create` updated to show `--account`, legacy alias section removed), `docs/api-usage.md` (operator-setup list 4 → 5 steps), `README.md` (minimal touch).
- 139 tests pass. Format + lint clean.

**Resolved during execution:**
- `accounts.id` is `CHAR(36)` UUID, generated via `crypto.randomUUID()`. `accounts.slug` stays as the CLI handle; UUID is what appears in admin HTTP routes (M19) and what WP/WC plugins store against customer records. `chatbots.id` stays `INT UNSIGNED` because chatbots are addressed by `slug` everywhere they appear externally — no second opaque identifier needed.
- Test cleanup pattern: delete the `accounts` row in `t.after`, the chatbot + origins + sessions + messages + geo_countries cascade away. One line, one query.

### Milestone 17: DB provider registry + chatbot BYO keys + kill TOML

**Target Completion:** 20 May 2026
**Status:** ✅ Complete (20 May 2026, v0.13.0)
**Priority:** Critical — unblocks SaaS-style provider management and customer cost attribution

Replaces `site-walker.toml` with `providers` + `provider_models` tables in MariaDB. Adds encrypted `provider_api_key_ciphertext` + `provider_api_key_nonce` columns on `chatbots` for bring-your-own-key. Master encryption key moves to `.env` as `SW_ENCRYPTION_KEY` (32 bytes base64). Boot fails loud if missing or wrong length. No provider-level API keys — every chatbot supplies its own. Chatbots without a key against a metered provider fail loud with `chatbot_api_key_missing`.

**Why DB-backed:** no API restart when adding/removing a provider+model+pricing combo. Multi-instance (PM2 cluster) deployments don't need TOML copied to every node. The 0600-gated security story moves from TOML to `.env`, which is already 0600-gated.

**Why chatbot-level keys only, no fallback chain:** cost attribution is unambiguous. A leaked key compromises one customer, never us or another customer. Fail-loud over ambiguous fallback when a key is missing.

CLI surface:
- `sw provider add/list/show/remove`
- `sw provider model add/list/remove`
- `sw chatbot set-api-key <slug>` (reads from stdin)
- `sw secrets gen-key` (generates an `SW_ENCRYPTION_KEY` value)

Deleted: `src/config/site-walker-config.ts`, `smol-toml` dep, `templates/site-walker.toml.example`, the 0600 gate code in `src/utils/env.ts` for the TOML, the `SW_CONFIG` env override.

No caching of the provider lookup in this milestone — direct DB reads. If profiling later proves it hot, M11's Redis work absorbs it.

**Acceptance:** existing dev `cortex` Ollama provider + OpenRouter provider recreated via CLI; chat against both works end-to-end with a chatbot-level key set; deleting the TOML doesn't break anything.

**Migration impact:** existing chatbot rows have NULL keys after migration → fail loud until `sw chatbot set-api-key` is run for each. Acceptable pre-release; we have one dev chatbot.

**Shipped at 0.13.0:**
- `migrations/0002_provider_registry.js` — additive: `providers` (id, name UNIQUE, protocol, base_url, is_local, is_metered) + `provider_models` (id, provider_id FK CASCADE, model_slug, context_window, input/output `DECIMAL(10,6)` pricing NULL, is_available; UNIQUE on (provider_id, model_slug)) + `chatbots.provider_api_key_ciphertext VARBINARY(255)` + `_nonce BINARY(12)` + `_auth_tag BINARY(16)`. Three encryption columns rather than a packed blob — the AES-GCM auth tag is required for AEAD verification.
- `src/utils/crypto.ts` — AES-256-GCM `encrypt()` / `decrypt()` / `generateMasterKey()` helpers. 13 round-trip + tamper-detection tests.
- `src/config/secrets.ts` — `loadEncryptionKey()` boot-validator; fail-loud with `sw secrets gen-key` hint. Module-scope cache.
- `src/services/providers.ts` — full service layer (create/get/list/delete for providers and provider_models; `findProviderModel` does the join `resolveModel` uses on every chat request). `SUPPORTED_PROTOCOLS` narrowed to `['ollama-native', 'openrouter']`.
- `resolveModel` async + DB-backed. Effective context window = chatbot override (`chatbots.model_context_window`) ?? `provider_models.context_window`.
- Adapter signature: per-request instances via `buildAdapter(provider, apiKey?)`. Openrouter adapter throws when metered + no key.
- `ChatError('chatbot_api_key_missing')` (503) for metered provider + no chatbot key.
- CLI:
  - `sw secrets gen-key` (prints base64 32-byte value; hint to stderr).
  - `sw chatbot set-api-key <slug>` (stdin-only; refuses TTY; never echoes raw key or ciphertext; 255-byte plaintext cap).
  - `sw provider add <name> --protocol <p> [--base-url <url>] [--local] [--metered/--no-metered]` (defaults `base_url` to OpenRouter's well-known URL).
  - `sw provider list/show/remove` (DB-backed; `remove` cascades through `provider_models` with `-f|--force`).
  - `sw provider models discover|add|list|remove` (`discover` is the renamed M8 live-query; `add/list/remove` operate against the DB registry).
- Deleted: `src/config/site-walker-config.ts` + test, `templates/site-walker.toml.example`, `docs/site-walker-toml.md`, `smol-toml` dep, `SW_CONFIG` env handling, `xdgConfigHome` field on `RuntimeEnv`, the TOML-specific 0600 gate path.
- Docs: `docs/cli-sw.md` gains `sw secrets`, `sw chatbot set-api-key`, full `sw provider` rewrite. `docs/env.md` documents `SW_ENCRYPTION_KEY`. `README.md` + `docs/system-blocks.md` drop the dead TOML link. `dev-notes/03-llm-providers.md` banner is past-tense.
- 170 tests pass. Format + lint clean.

**Resolved during execution:**
- AES-GCM auth tag gets its own `BINARY(16)` column rather than being appended to the ciphertext — schema-readable, and the cost is one DB column.
- `is_metered` defaults to `!is_local` at insert time but is always explicitly overridable. CLI exposes both `--metered` and `--no-metered` flags.
- Discovery (`sw provider models discover`) no longer sends an api_key on the HTTP request. The BYO key only travels with the live chat path, and the `/models` endpoints on both supported protocols are public anyway.

### Milestone 18: Cost accounting (foundation, no enforcement)

**Target Completion:** 20 May 2026
**Status:** ✅ Complete (20 May 2026, v0.14.0)
**Priority:** High — foundation for M20 budget caps

Records `tokens_in`, `tokens_out`, `cost_usd_estimate` on every assistant `messages` row. Cost computed from `provider_models` pricing × token counts. Denormalises `chatbot_id` onto `messages` so daily-spend queries don't require a join through `sessions`.

CLI: `sw chatbot usage <slug> [--since 24h]` shows running totals.

**No enforcement.** Just observability. Run for a week or two before turning caps on (M20) so we measure real cost shapes against real workloads before guessing at sensible defaults.

**Honesty about accuracy:** the recorded cost is an *estimate* — ground truth is the customer's Anthropic/OpenRouter invoice. Our number runs slightly under (no system overhead). Close enough for caps; documented for customer-facing reconciliation.

**Shipped at 0.14.0:**
- `migrations/0003_messages_cost.js` — additive: adds `messages.chatbot_id INT UNSIGNED NOT NULL` (backfilled from `sessions.chatbot_id` mid-migration, then tightened + FK CASCADE + composite index on `(chatbot_id, created_at)`), `tokens_in INT UNSIGNED NULL`, `tokens_out INT UNSIGNED NULL`, `cost_usd_estimate DECIMAL(10,6) NOT NULL DEFAULT 0`, `cache_creation_input_tokens INT UNSIGNED NULL`, `cache_read_input_tokens INT UNSIGNED NULL`.
- `src/services/cost.ts` — `computeCostUsd` (four-bucket: uncached input × 1.0, cache write × 1.25, cache read × 0.10, output × output_price; Anthropic multipliers as named constants with future-configurable comment), `getChatbotUsage`, `parseSinceDuration`. 11 unit tests for the formula + 6 for the duration parser.
- `ResolvedModel.providerModel` — joined `provider_models` row exposed alongside the provider on every `resolveModel` call. Chat path reads pricing from here without a second query.
- `appendMessage` signature change — now `(db, sessionId, role, content, opts)` with `opts.chatbotId` required and tokens/cost/cache fields optional. All call sites updated.
- Chat path persists tokens + computed cost on the assistant row at insert time. User rows carry `chatbot_id` only (tokens/cost stay at NULL/0). 2 new integration tests cover the metered (full formula) and unmetered (cost = 0) paths.
- CLI `sw chatbot usage <slug> [-s|--since <duration>]` — aggregates token + USD totals over the chosen window. Cache lines appear when non-zero (always zero today; populates post-M20). Warns if the chatbot's current model row has NULL pricing on a metered provider (silent under-counting case).
- `src/testing/db.ts::setTestChatbotApiKey` — encrypts + sets a chatbot key for tests that need the metered path. Reused by M19+ tests.
- Anthropic prompt-caching **substrate** in place: schema columns + four-bucket cost formula handle non-NULL cache values correctly. The adapter-side wiring (sending `cache_control` markers, parsing cache stats) is a named follow-up post-M20.

**Resolved during execution:**
- Token attribution: **assistant row only.** User rows always have `tokens_in / tokens_out = NULL` and `cost_usd_estimate = 0`. Aggregate cost is a one-liner against `chatbot_id`.
- Cache multipliers: hardcoded Anthropic constants in `cost.ts` with a block comment naming the future-configurable shape (per-provider columns when OpenAI/Google/etc. ship caching with different multipliers). The user's preference (configurable shape over magic numbers, even when v1 ships hardcoded values) is captured in memory.
- `--since` parser: relative-only (`Ns`/`Nm`/`Nh`/`Nd`), single-unit. No ISO timestamps; no `1h30m` compound. Operators can settle for a slightly bigger window when they want finer slicing.

### Milestone 19: Admin HTTP API + bearer-token auth

**Target Completion:** 21 May 2026
**Status:** ✅ Complete (21 May 2026, v0.15.0)
**Priority:** Critical — unblocks `site-walker-wp` (plugin) and `site-walker-for-woo` (provisioning) from doing anything beyond chat

Two credential surfaces, deliberately separated (full rationale in [`10-saas-shape.md`](10-saas-shape.md)):

- **Provisioning key** — one per deployment, lives in `.env` as `SW_PROVISIONING_KEY`. Hashed at boot; constant-time compared against incoming bearer on `POST /admin/accounts*`. Used by `site-walker-for-woo` when a WC subscription activates. Not in the DB. Rotation = restart + WC-side update; cutover blip accepted. `sw secrets gen-provisioning-key` CLI helper for generation. Boot validation rejects empty/short values.
- **Account admin key** — one or more per account, lives in the new `admin_keys` table with `account_id NOT NULL`. Hashed at rest; raw key returned exactly once at mint time (GitHub-PAT style). Used by `site-walker-wp` and by self-hoster CLIs that prefer HTTP to direct DB access. Scoped by `admin_keys.account_id`.

The air-gap between the two storage surfaces is the load-bearing security decision here: a bug in `admin_keys`-management code cannot accidentally create a provisioning credential because provisioning keys aren't in that table. Do not consolidate.

Endpoint surface (full list in [`10-saas-shape.md`](10-saas-shape.md)):

```
POST   /admin/accounts                          (provisioning only)
POST   /admin/accounts/{id}/keys                (provisioning only)
GET    /admin/chatbots
POST   /admin/chatbots
PATCH  /admin/chatbots/{id}
POST   /admin/chatbots/{id}/origins
PUT    /admin/chatbots/{id}/blocks/{name}
PATCH  /admin/chatbots/{id}/api-key
GET    /admin/chatbots/{id}/usage
```

Reuses the same service layer the CLI uses. OpenAPI schema augmented to cover the admin surface.

CLI surface for the self-hoster path (parallel to the SaaS-path provisioning-key endpoints): `sw account create <slug>`, `sw account list`, `sw account add-admin-key <slug>` (inserts a hashed row, prints the raw key once), `sw account revoke-admin-key <key-id>`. Same service layer the HTTP routes call.

**Shipped at 0.15.0:**
- `migrations/0004_admin_keys.js` — `admin_keys` (id CHAR(36) UUID PK, account_id CHAR(36) NOT NULL FK CASCADE, token_hash CHAR(64) UNIQUE, description, last_used_at, revoked_at, created_at). Account-scoped only.
- `src/config/secrets.ts` gains `loadProvisioningKey` + `ProvisioningKeyError` + `resetProvisioningKeyCache`. Unset is valid; format is `sw_<base64url-32>`. 9 unit tests.
- `src/utils/crypto.ts::generateProvisioningKey` — gen tool output matches the loader's validator.
- `src/services/admin-keys.ts` — `createAdminKey` / `getAdminKeyByHash` (with last_used_at bump) / `listAdminKeys` (never leaks token_hash) / `revokeAdminKey` (idempotent, cross-account refused). `hashAdminKey` helper. 15 integration tests.
- `src/routes/admin-auth.ts` — two middleware factories. Provisioning path constant-time-compares against the env value; revoked keys collapse to `bearer_invalid`. Cross-scope use (provisioning bearer on chatbot routes) returns `403 wrong_scope`.
- `src/routes/admin-accounts.ts` (5 routes, provisioning-gated): GET/POST `/admin/accounts`, GET/POST `/admin/accounts/{id}/keys`, DELETE `/admin/accounts/{id}/keys/{keyId}`. Account deletion deliberately CLI-only.
- `src/routes/admin-chatbots.ts` (17 routes, account-admin-gated): core CRUD + origins + blocks (incl. GET-list + GET-single + PUT + DELETE, name pattern `^[A-Za-z0-9_-]+$`, PERSONA reserved, 64KB cap, text/markdown or text/plain bodies) + api-key (PATCH set, DELETE clear) + usage (with `?since=` window + warnings array) + geo (GET + PATCH). Cross-account access returns `404 not_found` rather than `403` to avoid leaking other accounts' slugs.
- `src/server.ts` — OpenAPI gains `adminBearerAuth` security scheme + `admin` tag; both plugins registered with their respective preHandler middlewares.
- `src/utils/bearer.ts` — `extractBearerToken` promoted from server.ts so the admin middlewares share the same parser.
- `src/testing/db.ts::setTestChatbotApiKey` — encrypts + persists a plaintext key for tests.
- CLI mirror: `sw secrets gen-provisioning-key`, `sw account add-admin-key`, `sw account list-admin-keys`, `sw account revoke-admin-key`.
- `docs/api-admin.md` — operator reference for the new HTTP surface (auth, error vocabulary, route reference). README links to it.
- `dev-notes/12-admin-http-api.md` — design-conversation record, status flipped to shipped.
- 246 tests pass (30 new). Format + lint clean.

**Resolved during execution:**
- Block-name validator: `^[A-Za-z0-9_-]+$` (both cases). Uppercase-only would have rejected existing operator habits like `10-overview.md`.
- api-key clear semantics: dedicated `DELETE /admin/chatbots/{slug}/api-key`. Separate verb, separate auditable action.
- Geo settings: dedicated sub-resource (`/admin/chatbots/{slug}/geo`, GET + PATCH) rather than fields on the main chatbot PATCH. Symmetric with origins + blocks.
- Cross-account access on `/admin/chatbots/*` returns `404` (not `403`). Avoids leaking other accounts' chatbot slugs.
- Revoked-key auth failures collapse to `401 bearer_invalid` (not a distinct `bearer_revoked`). Same info-leak rationale.

### Milestone 20: Budget caps

**Target Completion:** 21 May 2026
**Status:** ✅ Complete (21 May 2026, v0.16.0)
**Priority:** High — the "this can't ruin a customer's week" guarantee

Per-chatbot caps + soft/hard handoff behaviour + visitor-email capture. Full design notes in [`11-budget-handoff.md`](11-budget-handoff.md) (recasts the original M9 / M20 split — see "What shipped" section).

**Shipped:**
- Migration `0005_budget_caps.js` — adds `chatbots.daily_budget_usd`, `chatbots.session_budget_usd`, `chatbots.handoff_threshold_pct` (default 80), `chatbots.handoff_webhook_url`; adds `sessions.terminated_at`, `sessions.visitor_email`, `sessions.handoff_notified_at`.
- `src/services/budget.ts` — pure helpers (`utcMidnightToday`, `parseCapDecimal`, `isDailyBudgetExhausted`, `isSessionBudgetExhausted`) + DB aggregators (`getChatbotDailySpend`, `getSessionSpend`). Closed-boundary semantics: `spend === cap` counts as exhausted.
- `src/services/system-blocks.ts` — `RESERVED_BLOCK_NAMES` extended to include `HANDOFF_SOFT` + `HANDOFF_HARD`; new `loadHandoffBlock()` helper; `assemblePrompt()` gains optional `extraBlocks?: Block[]` so the chat path can append the soft-handoff block conditionally without making prompt assembly otherwise stateful.
- `src/services/sessions.ts` — `findSessionByToken` now returns `null` for sessions idle >24h (`SESSION_IDLE_EXPIRY_HOURS`). Prevents shared-device data leak; also serves as a free housekeeping floor.
- `src/services/handoff-webhook.ts` — fire-and-forget `notifyHandoff()` (10s timeout, no retry, no HMAC v1). Stamps `sessions.handoff_notified_at` on 2xx.
- `src/services/chat.ts` — four-step flow: (1) early-return canned `HANDOFF_HARD.md` (or `DEFAULT_HARD_HANDOFF` constant fallback) with `message_id: 0` + `session_terminated: true` when `terminated_at` is set; (2) soft-handoff inject when spend-before crosses `cap * threshold/100`; (3) adapter call + persist; (4) hard-cap after-write check + terminate + fire-and-forget webhook. (M20 originally shipped with a daily-cap pre-check as step 2; that was removed in 0.16.1 — the daily cap is now enforced only at session-mint. See [`11-budget-handoff.md`](11-budget-handoff.md) "Behaviour change in 0.16.1".)
- `POST /sessions/visitor-email` — session-bearer auth, write-only (no GET counterpart at this scope), 204 with no body. Loosely validates email shape. Fires the webhook iff the session is already terminated.
- Daily-cap gating on `POST /sessions` AND `GET /sessions/can-start` — widgets can hide the chat affordance proactively.
- `PATCH /admin/chatbots/{slug}` extended with `daily_budget_usd`, `session_budget_usd`, `handoff_threshold_pct`, `handoff_webhook_url`. Sanity-bound by `SW_MAX_DAILY_BUDGET_USD` / `SW_MAX_SESSION_BUDGET_USD` env vars (defaults `10000` / `100`); admin requests above the env cap return `400 validation_failed` naming the env var to raise.
- CLI: `sw chatbot set-budget <slug> [--daily <usd|none>] [--session <usd|none>] [--threshold <pct>]` and `sw chatbot set-handoff-webhook <slug> <url|none>`. Literal `none` clears.
- Docs: `docs/api-usage.md` (visitor-email + 402 + soft/hard handoff), `docs/api-admin.md` (PATCH allowlist + 402 note), `docs/cli-sw.md` (set-budget + set-handoff-webhook), `docs/env.md` (`SW_MAX_*` vars), `dev-notes/11-budget-handoff.md` "What shipped" section.
- 281 tests pass (M20 added 6 new tests on top of M19's 275; the rest of M20's behaviour reuses existing harness paths via `chat-budget.test.ts` extensions). Format + lint clean.

**Resolved during execution:**
- Session-mint gating: yes on both `POST /sessions` and `GET /sessions/can-start`. The probe carries the same 402 so widgets can hide the affordance before any token is issued.
- Hard-cap message storage: disk file (`HANDOFF_HARD.md`) + built-in `DEFAULT_HARD_HANDOFF` fallback constant. Operator-customisation is preferred; the default is intentionally bland so missing files don't break the flow.
- After-write hard-cap check: keeps. One final natural reply, then terminate. Trades one over-cap reply per session for a non-jarring UX.
- Visitor-email scope: write-only at session-bearer. Admin path only for read-back. Rationale: a stolen session token shouldn't expose a previously-captured email.
- Sanity bounds via env vars (not DB): host-level, easy to audit, no admin-write surface that could disable them.
- Webhook security: no HMAC, no retry, 10s timeout. Operator's receiver is responsible for idempotency on `session_id` and (if exposed publicly) IP whitelisting. If a customer asks for signed payloads or retry, that's a follow-up.

### Milestone 21: Operational availability + admin mode

**Target Completion:** 23 May 2026
**Status:** ✅ Complete (23 May 2026, v0.17.0)
**Priority:** High — gates the first paying customer launch

Two features grouped because they share the same session-mint gating seam. Per-chatbot operational hours (timezone + weekly schedule); enforced at session-mint, not per turn (0.16.1 precedent). Plus admin-mode sessions: a power-user surface for logged-in WP administrators (Woo store admins using the bot to navigate their own catalogue, alongside the secondary "test the config" use). Admin-mode sessions skip Origin/geo/availability/daily-cap/capacity gates, use a separate per-session cap, suppress soft-handoff + webhook firing, and aggregate spend separately in reporting.

Full design + 11 open questions in [`14-availability-and-admin-mode.md`](14-availability-and-admin-mode.md) (now with a "What shipped" section recording the resolved design).

**Shipped:**

- [x] Migration `0006_availability_and_admin_mode.js` — `chatbots.timezone`, `chatbots.availability` JSON, `chatbots.admin_session_budget_usd`, `sessions.is_admin_mode`.
- [x] `src/services/availability.ts` — `assertValidTimezone`, `assertValidSchedule`, `parseWindow`, `isOpenNow(chatbot, now)`. 14 unit tests against fixed `Date` instants (Europe/London BST + UTC fixtures).
- [x] `POST /sessions` + `GET /sessions/can-start` return `503 chatbot_closed` with `Retry-After` (capped at 3600s) + `detail.next_open_at` (ISO or null).
- [x] `Chatbot` interface + `Session` interface extended; `normaliseChatbotRow` parses the new JSON column; `findSessionByToken` + `listSessions` surface a real boolean (mysql2 returns 0/1).
- [x] `PATCH /admin/chatbots/{slug}` accepts `timezone`, `availability`, `admin_session_budget_usd` with full validation; tests cover happy-path + 8 malformed-rejection cases.
- [x] CLI: `sw chatbot set-timezone`, `sw chatbot set-hours` (JSON via stdin; "none" clears), `sw chatbot set-budget --admin-session`. Help text updated.
- [x] `POST /admin/chatbots/{slug}/sessions` — account-admin-authenticated, empty body, returns `{ session_token, welcome_message, is_admin_mode: true }` with welcome prefixed by `**Admin mode**\n\n`. Tests cover happy path + cross-account 404.
- [x] `runChat()` honours `session.is_admin_mode`: skip Origin/geo on `/chat` + `/messages`; use `admin_session_budget_usd` for hard-cap; suppress soft-handoff inject; suppress webhook firing on hard-cap termination.
- [x] `getChatbotDailySpend` joins `sessions` and excludes `is_admin_mode = TRUE`. `getChatbotUsage` accepts a `segment` filter ('customer' | 'admin' | undefined).
- [x] `sw chatbot usage` shows customer + admin sub-totals. `GET /admin/chatbots/{slug}/usage` carries top-level combined totals plus `customer` + `admin` nested objects (additive — backwards compatible).
- [x] `sw sessions list` rows carry an `[admin]` marker for admin-mode sessions.
- [x] 316 tests pass (35 new). Format + lint clean.
- [x] Docs: `docs/api-admin.md`, `docs/api-usage.md`, `docs/cli-sw.md` all updated. `dev-notes/14-availability-and-admin-mode.md` gets a "What shipped" section.
- [x] CHANGELOG 0.17.0 entry; version bump.

**Resolved during execution:**

- IANA TZ validation via the runtime's own `Intl.DateTimeFormat({ timeZone })` constructor — no third-party tz library needed.
- Window parser supports `24:00` literal as end-of-day; `close <= open` is rejected (no implicit wrap-around; operators split into two windows for overnight ranges).
- `findChatbotByOrigin` was missing `normaliseChatbotRow` (latent bug — JSON columns came back as strings). Fixed in this milestone.
- Admin-mode session welcome message prefixed with `**Admin mode**\n\n` — small, decided in conversation, gives the admin clear visual confirmation.
- The admin `/usage` HTTP response keeps its existing top-level fields and adds `customer` + `admin` nested objects; integrators relying on the legacy shape continue working.

---

## Phase 4 — First release (v1.0.0)

Goal: take the feature-complete API and make it responsible to point at a real paying customer. Five milestones, all targeted for v1.0.0. Everything above this section is what we've built; everything past the divider below is post-launch.

### Milestone 22: Admin HTTP for session/conversation review

**Target Completion:** 24 May 2026
**Status:** ✅ Complete (24 May 2026, v0.18.0)
**Priority:** Critical — `site-walker-wp` plugin admin UI is blocked on this

Read-only HTTP surface for browsing past + in-progress conversations from the WordPress admin. Reuses M19 account-admin bearer auth and the existing service layer (`listSessions`, `listMessages` already exist; this milestone adds account-scoped admin counterparts).

Routes:

```
GET    /admin/chatbots/{slug}/sessions                       (paginated, filterable)
GET    /admin/chatbots/{slug}/sessions/{sessionId}           (session metadata + totals)
GET    /admin/chatbots/{slug}/sessions/{sessionId}/messages  (full history)
```

`GET /admin/chatbots/{slug}/sessions` query params:
- `limit` (default 20, max 100), `offset`
- `since` / `until` (ISO date range against `last_active_at`)
- `is_admin_mode` (true/false — filter customer vs admin sessions)
- `has_email` (true/false — filter on `visitor_email` presence)
- `terminated` (true/false — filter on `terminated_at` presence)

Each row carries `id`, `token` (display-only — the WP UI uses it to address the session), `created_at`, `last_active_at`, `terminated_at`, `visitor_email`, `is_admin_mode`, `message_count`, `tokens_in`, `tokens_out`, `cost_usd_estimate` (aggregated from messages, same shape as `sw chatbot usage`).

`GET /admin/chatbots/{slug}/sessions/{sessionId}` — same per-row shape for one session (no `messages` payload — keep the list endpoint lightweight).

`GET /admin/chatbots/{slug}/sessions/{sessionId}/messages` — same message shape as the public `GET /messages`, but addressable by session id and account-scoped (not visitor-bearer-scoped). Cross-account access returns `404 not_found` (consistent with M19 leak-avoidance).

**Open questions:**
- Aggregate-only at session level vs per-message token/cost columns. Lean: aggregate-only — message-level cost is rarely interesting for review, save the column space.
- Default list ordering: `last_active_at DESC`. Confirm with first WP-admin design pass.

**Shipped at 0.18.0:**
- `src/services/sessions.ts` — `listSessionsForChatbot(db, chatbotId, { page, pageSize })` returning `{ sessions, total, page, page_size }`; `getSessionForChatbot(db, chatbotId, sessionId)` returning the same per-row shape or `null` when the session belongs to a different chatbot; `listMessagesForChatbot(db, chatbotId, sessionId)` returning `Message[]` or `null` (null for cross-chatbot, deliberately distinct from `[]` for an empty session). Row aggregates (`message_count`, `tokens_in`, `tokens_out`, `cost_usd_estimate`) computed in a single LEFT JOIN + GROUP BY against `messages` so the WP plugin's list view doesn't fan out into N+1 round-trips.
- `src/routes/admin-chatbots.ts` — three new routes under the M19 account-admin guard: `GET /:slug/sessions` (paginated, default 20, max 100), `GET /:slug/sessions/:sessionId`, `GET /:slug/sessions/:sessionId/messages`. Full OpenAPI schemas (sessionItemSchema, messageItemSchema). Cross-chatbot sessionId returns `404 not_found` (M19 leak-avoidance pattern). Path-param `sessionId` validated as numeric via `pattern: '^[0-9]+$'`; non-numeric → `400 validation_failed`.
- **Visitor session token deliberately not exposed** through any M22 response — it's the visitor's `POST /chat` bearer; surfacing it would create a hijack-capable credential. Admin addresses sessions by integer `id`.
- **Per-message token/cost columns deliberately not exposed** through the messages endpoint — Fastify response-schema serialiser drops them. Site-wide aggregates from the session-list endpoint are sufficient given we don't do multi-request agentic tooling or mid-conversation model switching.
- `docs/api-admin.md` — new "Sessions + conversation review (M22)" section: route table, response shapes (list + single + messages), example payloads with `terminated_at` + `visitor_email`, note that future filters (date range, segment, geo, has_email) are post-v1.0.0.
- 329 tests pass (12 new). Format + lint clean.

**Resolved during execution:**
- **Tie-break by `id DESC`** when two sessions share a `last_active_at` value. MariaDB DATETIME is 1-second resolution by default; without the tiebreaker the order would be non-deterministic. `id DESC` = "most-recently-inserted first" — matches user expectation.
- **Pagination shape: `page` + `page_size` + `total`**, not cursor-based. Simpler for the WP UI, real `total` is cheap against the indexed `chatbot_id` column.
- **`additionalProperties: false`** on the querystring schema so unrecognised query params 400 rather than being silently ignored. Cheap forward-compatibility guard — if a caller types `pagesize` instead of `page_size`, they hear about it.
- **Two parallel queries** (the page payload + a separate `COUNT(*)` for total) rather than a single window-function query. Knex's portable querybuilder doesn't carry window-function helpers cleanly across dialects; two queries are simpler and the count is fast against the indexed `chatbot_id` column. If session counts grow to where the count is expensive, the natural follow-up is a cached count or `has_more` instead of `total` — settle when it becomes a problem.

### Milestone 23: Rate limiting (in-memory)

**Target Completion:** 24 May 2026
**Status:** ✅ Complete (24 May 2026, v0.19.0)
**Priority:** High — public-internet exposure requires this before launch

`@fastify/rate-limit` plugin, default in-memory store. **Explicitly no Redis** — Redis is paired with cluster mode, both below the line as M11.

Scope:
- Per-IP cap on `POST /sessions` and `POST /chat` (different limits — sessions are cheaper to mint than chat turns to serve).
- Per-chatbot cap as a second layer (one runaway origin shouldn't burn another customer's budget bucket).
- `.env`-tunable thresholds (`SW_RATELIMIT_*` family).
- The M3 `hasCapacity()` stub was originally pencilled in for expansion here. During execution we chose to **delete** it instead — rate limiting subsumes the operational concern at v1.0.0 scale; reintroducing a concurrency check with clear semantics is easy if a real need arises later.

The boring-mature-proven choice per CLAUDE.md guidance. Single-process deployment makes in-memory accurate; multi-instance would split the bucket across workers and quietly multiply the effective cap. When we cluster (post-v1.0.0, M11), we swap the store, not the route handler.

**Open questions:**
- Default cap values — settle after a week of real M18 usage data so we know what real traffic looks like before guessing at sensible numbers.

**Shipped at 0.19.0:**
- `@fastify/rate-limit` plugin registered with `global: false`; routes opt in via `config.rateLimit`. Per-IP cap on `POST /sessions` (env `SW_RATELIMIT_SESSIONS_PER_IP_PER_MINUTE`, default 10) and `POST /chat` (`SW_RATELIMIT_CHAT_PER_IP_PER_MINUTE`, default 20). `trustProxy: true` (wired since 0.10.0) means `req.ip` honours `X-Forwarded-For` behind the production reverse proxy.
- `src/services/rate-limit.ts` — `ChatbotRateLimiter` class for the per-chatbot dimension. Fixed 60-second window, in-memory `Map<chatbotId:scope, {count, windowStart}>`, clock injectable for tests. Called from `POST /sessions` and `POST /chat` route handlers after chatbot resolution (per-chatbot dimension can't ride on the plugin's sync `keyGenerator` because chatbot resolution is async). Refused calls do **not** extend the ban window — important for fairness.
- `429 rate_limit_exceeded` error code with `{ error, detail: { retry_after_seconds } }` body shape, plus standard `Retry-After` header. Shared `rateLimitResponseBody()` helper means the plugin-path 429 and the manual-path 429 are bit-identical. Plugin's `errorResponseBuilder` includes `statusCode: 429` in its return value — the plugin treats the builder's result as a thrown error and Fastify reads `statusCode` off it; without that field the response defaults to 500. (Caught during test loop.)
- Five new env vars in `src/config/env.ts`: `SW_RATELIMIT_ENABLED` (boolean, default true), `SW_RATELIMIT_SESSIONS_PER_IP_PER_MINUTE` (10), `SW_RATELIMIT_SESSIONS_PER_CHATBOT_PER_MINUTE` (60), `SW_RATELIMIT_CHAT_PER_IP_PER_MINUTE` (20), `SW_RATELIMIT_CHAT_PER_CHATBOT_PER_MINUTE` (120). New `parsePositiveInteger` + `parseBoolean` helpers.
- `BuildServerOpts.rateLimit` — opts override env so tests can dial caps to single digits without touching `process.env` (the env module is a module-load singleton; mutating process.env post-import doesn't propagate). Tests pass tiny caps and use `X-Forwarded-For` to vary `req.ip` per-request.
- **Routes NOT rate-limited** (by construction — they don't carry `config.rateLimit`): `GET /sessions/can-start` (idempotent probe; per-IP cap on `POST /sessions` is the real defense), `GET /messages` (cheap rehydrate, only callable with a valid session token), `POST /sessions/visitor-email` (visitor-bearer write-once), all `/admin/*` (bearer-key auth is the throttle).
- **Admin-mode chat traffic is rate-limited normally** — still comes from a browser with a real IP; per-IP cap of 20/min is generous enough that no human typing trips it; skipping would mean a synchronous session lookup just to handle the rare "admin tests the bot" case.
- `hasCapacity()` stub + `503 capacity_exceeded` error code deleted from `src/server.ts` (M3 always-true stub). Doc references in `docs/api-usage.md` rewritten to point at `429 rate_limit_exceeded` instead.
- Docs: `docs/env.md` adds the five `SW_RATELIMIT_*` variables with operator-friendly descriptions + an updated example `.env`. `docs/api-usage.md` adds `429 rate_limit_exceeded` rows to the `POST /sessions` and `POST /chat` failure tables and the summary denial table; updates `GET /sessions/can-start` to call out the exemption.
- 20 new tests (349 total). 7 pure-unit on `ChatbotRateLimiter` (window roll-over, refused calls don't extend ban, per-chatbot independence, per-scope independence, `retryAfterSeconds` math). 5 env-config tests (defaults, boolean parsing, validation). 8 HTTP integration tests in `chat-rate-limit.test.ts` via `fastify.inject` with `X-Forwarded-For` to vary IP (per-IP cap, per-chatbot cap with multiple IPs, disabled mode, can-start exempt, /messages exempt).

**Resolved during execution:**
- **`errorResponseBuilder` must include `statusCode: 429`** in the return value. The plugin treats it as a thrown error; Fastify reads `statusCode` off it; without that field the response defaults to 500. Caught during the first test-loop run.
- **Per-chatbot check runs after geo + before budget/availability gates.** Order: Origin → geo → rate-limit → budget → availability. Rate-limiting after geo means we only count "actually-let-through" requests against quota.
- **Refused calls do not bump the bucket** — a single refused caller can't keep extending its own ban window.
- **Capacity stub deleted, not expanded.** The original M11 plan was for `hasCapacity()` to become a real concurrency check sharing the same store. Rate limiting subsumes the operational concern at v1.0.0 scale; if a real concurrency check is wanted later (e.g. an in-memory in-flight chat counter), it lands as a focused addition with clear semantics.

### Milestone 24: Production deployment polish

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** Critical — gate on going live

Folds in the original M14 deployment scope + its two outstanding follow-ups + the systemd-vs-PM2 decision (resolved 2026-05-24: single-process systemd, no PM2 in v1.0.0).

Scope:
- **Single systemd unit** (`site-walker.service`). `Type=simple` (or `notify` if startup-ordering signals are useful), `Restart=always`, `StandardOutput=journal`, `EnvironmentFile=/etc/site-walker/.env`. No PM2 in v1.0.0.
- **Gate `/docs` + `/openapi.json` on non-production.** Skip `fastifySwaggerUi.register` and the `/openapi.json` route when `runtimeEnv.isProduction === true`. The status pill on `/` keeps working (it just hits `/health`); the two doc links on the landing card render only in non-prod.
- **Body schema on `POST /chat`**: `attachValidation: true` + AJV-error → `{ error: 'validation_failed', detail: {...} }` mapping. Honours the existing typed-error vocabulary.
- **Provider ping on `/health`** (optional). Currently `/health` only verifies the DB. Trade-off: adding an upstream call to a hot endpoint costs latency + spend. Probably only run it when `?deep=1` is set.
- **Structured logging review.** Pino defaults are mostly fine. Confirm we don't log request bodies on `/admin/*` — `/admin/chatbots/{slug}/api-key` PATCH carries plaintext provider keys.
- **Production reverse proxy** for `api.site-walker.net`. DNS + cert, no IP lock (the dev proxy at `apix.site-walker.net` stays IP-locked). Exercises the `trustProxy: true` plumbing 0.10.0 wired in.
- **Deployment runbook** (`docs/deployment.md`): DNS, cert, systemd install, env-file generation, knex migrate, smoke test, rollback procedure.

**Resolved decisions:**
- **Single-process systemd over PM2** (2026-05-24). The workload is IO-bound (chat turns wait on upstream LLMs, not CPU). A single Node event loop carries far more concurrent in-flight requests than first-customer traffic will produce. PM2 adds a supervisor layer that systemd already provides. Cluster + Redis pair lands as M11 below the line when traffic or zero-downtime-deploy needs justify it.

### Milestone 25: Anthropic prompt caching adapter wiring

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — material cost reduction for the customer

Substrate (DB columns `cache_creation_input_tokens`, `cache_read_input_tokens`; four-bucket cost formula in `src/services/cost.ts`) shipped in M18. This milestone wires the actual adapter side.

Scope:
- Send `cache_control: { type: "ephemeral" }` markers on the system-blocks prefix in the request payload. OpenRouter passes these through to Anthropic.
- Parse cache stats from the response (`usage.cache_creation_input_tokens`, `usage.cache_read_input_tokens` in the OpenRouter/Anthropic shape). Persist on the assistant `messages` row — the cost formula already handles non-NULL values.
- Gate by model — only Anthropic models support `cache_control`. Other providers should not see the markers (would either error or silently ignore depending on protocol).
- Skip cache markers when the system prompt is below the minimum-cacheable threshold (~1024 tokens for Sonnet, ~2048 for Haiku at the time of writing — confirm against current Anthropic docs at implementation time).

Expected impact: ~70-80% reduction in input billing for chatbots with stable system blocks and many conversations per cache window (cache window is 5 minutes / 1 hour depending on tier).

**Open questions:**
- Model-allowlist storage. Lean: hardcoded list in the openrouter adapter for v1, with a `cache_supported` boolean on `provider_models` as a future override path if a new Anthropic model lands and we don't want to redeploy.

### Milestone 26: README rewrite + docs polish

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** Medium — first thing a prospective customer reads

The README still markets the prototype-era "self-hosted multi-tenant API" framing. It needs to be rewritten around what we actually shipped in the SaaS-pivot block:

- Account → chatbot model (M16).
- BYO LLM provider keys (encrypted, AES-256-GCM; M17).
- DB-backed provider registry — *not* the deleted TOML (M17).
- Budget caps + soft/hard handoff + webhook + visitor-email capture (M20).
- Operational hours + admin mode (M21).
- Two-key admin HTTP API: provisioning + account-admin (M19).
- WordPress integration via the `site-walker-wp` plugin.

Audit `docs/api-usage.md`, `docs/api-admin.md`, `docs/cli-sw.md`, `docs/env.md` for consistency with the post-M21 surface (mostly current per the M21 wrap-up but worth a final pass). Update any stale screenshots or API examples.

---

## ━━━━━━━━━━━━━━━━━━━━━━━━━━━ ▼ V1.0.0 RELEASE LINE ▼ ━━━━━━━━━━━━━━━━━━━━━━━━━━━

---

## Post-v1.0.0 — future development

Below the line. Each item is paused until real customer signal or a concrete operational need justifies pulling it forward. Milestone numbers preserved from earlier phases so cross-references in older docs still resolve.

### Operator + ops

- **`sw db backup/restore/list/prune`** (M7 finish). Manual `mysqldump`/`mysql` is acceptable for first customer (confirmed 2026-05-24). Tooling lands when a second customer makes ad-hoc backups painful, or when the first customer asks about automated retention.
- **Cluster mode + Redis-backed rate limiting** (M11, paired). Single-process is plenty for first-customer traffic — the workload is IO-bound (chat turns wait on upstream LLMs, not CPU). **Trigger:** a single instance can't keep up under real load, or zero-downtime deploys become necessary. Cluster mode and Redis land *together* — clustering breaks in-memory rate limits (each worker has its own bucket; effective cap = N × configured cap), so Redis is the prerequisite. Topology options when triggered: systemd socket activation + `app@.service` template (kernel `SO_REUSEPORT` does the load balancing), or PM2 cluster, or templated systemd services behind an nginx upstream block. Also absorbs: abuse heuristics (repeated-identical-message detection, prompt-injection-shaped payloads, suspiciously high token consumption per session), and any provider-registry caching that M17 proves necessary.
- **Friendlier CLI + boot error messages** (M15). Operator-experience polish. Wrap mysql2 error codes in human-readable messages with suggested next steps (duplicate origin, missing slug, `ECONNREFUSED` on `./bin/chat`). Boot-time consistency pass for invalid env, unreachable DB, missing GeoIP DB. **Trigger:** first self-hoster who isn't us writes to ask what an `ER_DUP_ENTRY` means.

### Safety + retention

- **Prompt-injection / jailbreak handling** (M12). Pre-sales bot can't go off-script. Open question: where the bot bails to "I don't know, contact us" rather than guess. Needs a scoping pass before implementation — likely a combination of per-chatbot topic boundaries (operator-configured) and a generic refusal layer for instructions embedded in user messages that try to override system blocks. **Trigger:** first observed off-script reply in M22's conversation review, or first customer asks "how do you stop people jailbreaking it?"
- **Conversation retention + PII** (M13). Retention period (how long do we keep sessions before purging?), export for offline review, redaction of obvious PII before display in the admin UI. M22 ships the browse surface but no policy. **Trigger:** first EU customer (GDPR), or first customer asks about data retention.
- **History trimming** (M9, likely superseded). Sliding-window vs summarisation. Current `0.6.0` chat path refuses with `413 context_overflow` when prompt + history busts the window; M20's budget-driven handoff bounds conversation length implicitly. **Trigger:** real M18 cost data shows conversations regularly bust context before budgets, or a customer reports the 413 in the wild.

### Content pipeline + features

- **Hierarchical system blocks** (v1.1.0 candidate). Promote `data/chatbots/<slug>/` from a flat directory to a topic-aware tree; LLM activates topics on demand via `<load-topic>` tagged tokens. Design in [`13-hierarchical-system-blocks.md`](13-hierarchical-system-blocks.md). Reduces base-prompt size on chatbots with broad topic coverage. **Trigger:** first customer needs system blocks larger than the cheapest Anthropic context can hold without burning prompt-cache savings.
- **Auto-mode content ingestion + condensation pipeline** (M10 + post-launch successor). Cron-driven regeneration of per-chatbot system blocks from source URLs/files using a high-end LLM. Cluster-safe (single-instance lock). Manual trigger via `sw blocks rebuild`. Sketch in [`10-saas-shape.md`](10-saas-shape.md). Open questions: push-triggered vs scheduled cron, status surface (polling vs callbacks), per-run cost ceiling. **Trigger:** first customer asks to point the bot at their existing site content rather than hand-writing blocks.
- **OAuth-style plugin linking.** Replace the current "operator pastes provisioning key into WP" flow with a proper OAuth handshake. **Trigger:** first non-technical operator finds the manual link step confusing.
- **Additional protocol adapters** (M8 follow-on): direct `anthropic`, generic `openai-compatible`. OpenRouter covers Anthropic transitively, so direct adapters are a "save the OpenRouter cut" optimisation, not a feature unlock. **Trigger:** a customer's billing model requires a direct Anthropic relationship, or a third concrete `openai-compatible` use case lands.

---

## Open questions

Tracked here alongside the milestone that resolves them, so they're visible in context.

Resolved (kept for the record):
- **M1 lib choices** — test framework (Jest vs node:test), CLI lib (commander.js vs alternative), `bin/chat` language (bash vs tiny Node). Resolved in M1.
- **Per-website system-block format** — resolved in M4. Flat directory of `.md` files; persona in DB; constant handling rule; XML-tagged block wrappers. Full design in [`04-system-blocks.md`](04-system-blocks.md).
- **Phase 3 architecture** — resolved 2026-05-19 in [`10-saas-shape.md`](10-saas-shape.md). Four-repo topology, WC-driven billing, BYO chatbot-level keys, DB-backed provider registry, M16–M20 phasing.
- **Provisioning-key bootstrap mechanism** — resolved 2026-05-20. `SW_PROVISIONING_KEY` in `.env`, **not** in the `admin_keys` table. Air-gap chosen over single-code-path symmetry: a bug in `admin_keys`-touching code cannot accidentally create a provisioning credential. Full rationale + rotation procedure in [`10-saas-shape.md`](10-saas-shape.md). M19 implements: boot hash, constant-time-compare middleware, `sw secrets gen-provisioning-key` CLI, boot validation that rejects empty/short values.
- **v1.0.0 deployment shape: PM2 vs systemd vs cluster** — resolved 2026-05-24. Single-process systemd, no PM2, no Redis. IO-bound workload (chat turns wait on upstream LLMs, not CPU) makes cluster mode unnecessary at first-customer scale; PM2 would add a supervisor layer that systemd already provides. Cluster + Redis pair lands together as M11 below the line, triggered by real load or zero-downtime-deploy needs. See M24 + Post-v1.0.0 "Cluster mode + Redis-backed rate limiting" for full reasoning.

Still open (above the line — for v1.0.0):
- **M22 — per-message vs aggregate-only cost columns in the session list.** Lean: aggregate-only — message-level cost is rarely interesting for review.
- **M22 — default list ordering.** Lean: `last_active_at DESC`. Confirm with first WP-admin design pass.
- **M23 — default rate-limit cap values.** Settle after a week of real M18 usage data so we know what real traffic looks like before guessing.
- **M25 — model-allowlist storage for `cache_control` support.** Lean: hardcoded list in the openrouter adapter for v1, with a `cache_supported` boolean on `provider_models` as a future override path.

Still open (below the line — for post-v1.0.0):
- **History trimming strategy** (M9, likely superseded). Sliding-window-vs-summarisation choice remains a fallback only if M18 cost data shows budgets don't bound conversation length in practice.
- **"I don't know, contact us" boundaries** (M12). What topics force the bail-out path?
- **Auto-mode content ingestion shape** (post-M10 successor). Push-triggered vs scheduled cron; status surface (polling vs callbacks); per-run cost ceiling. Sketch in [`10-saas-shape.md`](10-saas-shape.md); full doc when this milestone is next-up.

---

## Notes for Development

- Stack and tenant-model decisions are in [`../CLAUDE.md`](../CLAUDE.md). If something here contradicts CLAUDE.md, CLAUDE.md wins — fix this file.
- **v1.0.0 deployment shape:** single-process systemd unit, no PM2, no Redis. The workload is IO-bound; cluster mode and Redis-backed rate limiting are paired and land below the line as M11 when traffic or zero-downtime-deploys justify it. M23 ships in-memory rate limiting for v1.0.0; M11 swaps the store when we cluster.
- This repo is API-only. The WordPress plugin (`site-walker-wp`) lives elsewhere — anything resembling browser/widget code is out of scope.
- **HTTP auth surfaces:** browser traffic uses `Origin` allowlist + opaque session token; admin HTTP uses two bearer-key surfaces — `SW_PROVISIONING_KEY` in `.env` for `/admin/accounts/*`, account-admin keys in the DB for `/admin/chatbots/*` (M19). Local CLI (`./bin/sw`) still talks directly to the DB and bypasses HTTP auth entirely.
- LLM provider config lives in MariaDB (since M17 / v0.13.0): `providers` + `provider_models` tables, per-chatbot BYO API keys in `chatbots.provider_api_key_*` (AES-256-GCM, master key in `.env` as `SW_ENCRYPTION_KEY`). Managed via `sw provider ...` and `sw chatbot set-api-key`. The pre-M17 TOML approach is preserved historically in [`03-llm-providers.md`](03-llm-providers.md).
- `ollama-native` is the lowest-common-denominator target. Design system blocks against the Pi's tight context first; larger models unlock larger per-chatbot blocks but we never assume a fat context globally.
