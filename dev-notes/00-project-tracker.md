# site-walker — Project Tracker

**Last Updated:** 21 May 2026
**Current Version:** 0.16.0
**Current Phase:** **SaaS-pivot block complete — first-customer onboarding next.** Prototype era ended at v0.11.0. v0.12.0 landed M16 (multi-tenant rename + accounts). v0.13.0 lands M17 (DB-backed provider registry + chatbot BYO keys; TOML config path deleted). v0.13.1 patched the `sw provider add --local` flag-defaulting bug. v0.14.0 lands M18 (cost-accounting foundation + `sw chatbot usage` + Anthropic prompt-caching substrate). v0.15.0 lands M19 (admin HTTP API: 22 routes, two bearer-auth scopes, full OpenAPI, integration tests). **v0.16.0 lands M20 (budget caps + soft/hard handoff + visitor-email capture)** — the SaaS-pivot block is closed. Next phase: real-customer onboarding on `api.site-walker.net`, then the pre-pivot deferred items (M7 finish, old M9/M11/M12/M13/M14/M15) come back into focus informed by first-customer feedback.
**Overall Progress (post-M20, v0.16.0):** M1–M6 complete, M7 + M8 partial, M16/M17/M18/M19/M20 complete in v0.12.0/v0.13.0/v0.14.0/v0.15.0/v0.16.0. Admin HTTP surface live with full M20 budget-cap controls. Daily + per-session spend caps enforced end-to-end; soft-handoff prompt injection at configurable threshold; hard-cap session termination with `HANDOFF_HARD.md` template + webhook delivery; visitor-email capture write-only at the session-bearer scope. 281 tests, format + lint clean.

Vision and phasing live in [`../README.md`](../README.md). **Note:** README still markets the prototype-era "self-hosted multi-tenant API" framing; rewrite ships after M16 lands, not before, to avoid documenting vapourware. Stack and architecture decisions live in [`../CLAUDE.md`](../CLAUDE.md). Auth/session and data-model design live in companion docs in this directory. This file tracks the work.

Companion planning docs:
- [`01-auth-and-session-flow.md`](01-auth-and-session-flow.md) — origin allowlist, session-token lifecycle, endpoint shapes
- [`02-data-model.md`](02-data-model.md) — **v1.0 schema reference** (rewritten in M16 — `accounts`, `chatbots`, `chatbot_origins`, `chatbot_geo_countries`, `sessions`, `messages`, `geo_modes`). [`db-schema-pre-m16.sql`](db-schema-pre-m16.sql) is the frozen v0.11.0 snapshot kept for reference.
- [`03-llm-providers.md`](03-llm-providers.md) — TOML provider registry, per-chatbot model selection, protocol adapters, normalised parameters, context-window handling. **Superseded in M17 by DB-backed provider registry** ([`10-saas-shape.md`](10-saas-shape.md)).
- [`10-saas-shape.md`](10-saas-shape.md) — SaaS architecture (four-repo topology, account model, BYO keys, admin HTTP API, M16–M20 phasing)
- [`11-budget-handoff.md`](11-budget-handoff.md) — budget-driven conversation handoff (soft-handoff at 80% spend, hard-cap → email capture). Recasts old M9 history-trimming as part of M20's budget-cap UX. Settled during M20 design pass.
- [`13-hierarchical-system-blocks.md`](13-hierarchical-system-blocks.md) — promote `data/chatbots/<slug>/` from a flat directory to a topic-aware tree; LLM activates topics on demand via `<load-topic>` tagged tokens. Design-in-flight, targeted at v1.1.0 (post-first-customer).
- [`14-availability-and-admin-mode.md`](14-availability-and-admin-mode.md) — per-chatbot operational hours (timezone + weekly schedule) + admin-mode session type for logged-in WP administrators. Design-in-flight, M21 target (pre-v1.0.0).

## Next up

Post-M20, 2026-05-23. The SaaS-pivot block is closed. The work ahead is real-customer onboarding + the two pre-v1.0.0 features clients are already asking for:

1. **M21 — Operational availability + admin mode.** Per-chatbot hours-of-operation gating at session-mint, plus an "admin mode" session type for logged-in WP administrators (Woo store admins using the bot to navigate their own catalogue, alongside the secondary "test the config before launch" use). Both features share the same mint-gating seam, hence one milestone. Full design + 11 open questions in [`14-availability-and-admin-mode.md`](14-availability-and-admin-mode.md). **Gates v1.0.0** — first paying client will want both.
2. **First paying client on `api.site-walker.net`.** End-to-end test of the whole stack with BYO Anthropic key, daily cap configured (informed by real M18 usage data once we have a couple of real chatbots running for a week), the `site-walker-wp` widget installed on the customer's WordPress, and the operator's CRM wired to `handoff_webhook_url` for email capture. The whole point of the SaaS pivot.
3. **Reverse proxy for `api.site-walker.net`.** Dev proxy at `apix.site-walker.net` → `sentinel:47830` is already up via Apache on `nexus.headwall.co.uk` (IP-locked to the developer's home IP). Production `api.site-walker.net` needs DNS/cert work + no IP lock.
4. **Anthropic prompt caching (via OpenRouter).** Substrate already in DB (M18). Adapter-side work: send `cache_control` markers on system-blocks prefix, parse cache stats from response, gate by model, skip below the minimum-cacheable threshold. ~70-80% input-billing savings expected for chatbots with stable system blocks and many conversations per cache window. See [`10-saas-shape.md`](10-saas-shape.md).

After v1.0.0 / the first paying client lands: hierarchical system blocks ([`13-hierarchical-system-blocks.md`](13-hierarchical-system-blocks.md), v1.1.0 candidate), auto-mode content ingestion, condensation pipeline, and OAuth-style plugin linking.

In parallel with the above (operator-side, outside this repo):
- **Reverse proxy for `api.site-walker.net`.** Dev proxy at `apix.site-walker.net` → `sentinel:47830` is already up via Apache on `nexus.headwall.co.uk` (IP-locked to the developer's home IP). Production `api.site-walker.net` needs DNS/cert work + no IP lock. Exercises the `trustProxy: true` + `X-Forwarded-For` plumbing that 0.10.0 wired in.

Pre-pivot deferred work still real, now renumber-deferred until after M20:
- **M7 finish**: `sw db backup/restore/list/prune`, `sw blocks rebuild` (the latter is really an M10 trigger).
- **M11 (renumber-deferred)**: rate limiting + abuse heuristics (first Redis use). `is_local` on the provider entry is consumed here. Also the natural home for any provider-registry caching M17 might prove necessary.
- **M9 (renumber-deferred, likely superseded)**: history trimming. The 0.6.0 chat path refuses with `413 context_overflow` when prompt + history busts the window. Preferred shape is to fold this into M20 via budget-driven handoff ([`11-budget-handoff.md`](11-budget-handoff.md)). M9 stays alive as a fallback only if real M18 cost data shows conversations regularly bust context windows before budgets.
- **M15 (renumber-deferred)**: friendlier CLI + boot error messages for non-developer operators. Self-hosters will see raw knex/mysql2 stack traces today.
- **M14 follow-ups**: gate `/docs` + `/openapi.json` on `NODE_ENV !== 'production'`; add request-body schemas to `POST /chat` with `attachValidation: true` so OpenAPI carries the body shape without breaking typed-error responses.

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

### Milestone 9: History-trimming strategy

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — settles an open question from README, may touch schema

Decide between sliding-window (drop oldest turns once a token budget is hit) and summarise-older-turns (compact older history into a single summary message). Implement the chosen strategy. May add a `summary` column on `sessions` or a separate `session_summaries` table — settle the decision *before* this lands so the schema doesn't churn. (A nullable `summary TEXT` column is already noted as a probable addition in [`02-data-model.md`](02-data-model.md).)

**Open question to resolve here:** trimming strategy.

### Milestone 10: System-blocks regeneration cron

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** Medium — the "static but refreshed" part of the README

Cron-driven (daily or weekly) job that regenerates each website's on-disk system blocks from source material using a high-end LLM. Cluster-safe (single-instance lock or env-gated like `NODE_APP_INSTANCE === "0"`). Per-website source-material config — at minimum a list of URLs or local files the regenerator should consult. Manual trigger via the M7 CLI (`sw blocks rebuild`).

### Milestone 11: Rate limiting & abuse protection

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — public endpoint requirement

First Redis use. Per-IP and per-website rate limits on `POST /sessions` and `POST /chat`, with sane defaults and `.env`-tunable thresholds. This is where the M3 capacity-check stub flips to return 503 when over budget. Abuse heuristics — repeated identical messages, prompt-injection-shaped payloads (basic regex, not full classifier), suspiciously high token consumption from one session. Graceful degradation: if Redis is unavailable, decide whether to fail-open or fail-closed.

### Milestone 12: Prompt-injection / jailbreak handling

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — pre-sales bot can't go off-script

Guardrails appropriate for a pre-sales bot — refuse off-topic requests, refuse to follow instructions embedded in user messages that try to override system blocks, settle on a "contact us instead" fallback for things the bot shouldn't answer. Per-website "contact us" target (email or URL) configured via the M7 CLI.

**Open question to resolve here:** where the bot should bail to "I don't know, contact us" rather than guess.

### Milestone 13: Conversation review & retention

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** Medium — Phase 2 requirement

Basic browse already exists via the M7 CLI. This milestone is the **policy + tooling beyond browse**: retention period (how long do we keep sessions before purging?), export for offline review, redaction of obvious PII before display, optional protected admin HTTP endpoint if a CLI is too clunky for real review work. May also be where API-key auth lands, if the admin endpoint route is taken.

### Milestone 14: Production deployment

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — gate on going live

Process management (PM2 or systemd — decide), reverse-proxy config, health check endpoint (`/health` — DB + model backend ping; lands in 0.7.0 with DB-only ping, provider ping comes here), structured logging, deployment runbook. Cluster mode validated end-to-end (a session created via one node is readable from any node). WordPress-plugin project should be far enough along by this point that we can do a real integration test on a real site.

The reverse-proxy topology will front Fastify at `https://api.site-walker.net`. The project website at `https://site-walker.net` is a separate deploy concern (likely a static site).

**Follow-ups noted here so they don't get lost:**
- Gate `/docs` (Swagger UI) and `/openapi.json` on `NODE_ENV !== 'production'`. Useful for development and self-hosters; no reason to ship them on a public production endpoint.
- Request-body schemas on `POST /chat` (with `attachValidation: true` + an error-handler that maps AJV errors to our typed `{ error: ... }` shapes) — currently documented in prose only. Either fold into M14 or its own polish cut.

### Milestone 15: Friendlier CLI + boot error messages

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** Medium — operator-experience polish, not on the critical path to going live

The CLI today surfaces raw knex/mysql2 errors when the database refuses an operation — e.g. `sw website origins add <slug> <existing-origin>` dumps a full mysql2 stack trace including the offending SQL plus the `ER_DUP_ENTRY` / `website_origins_origin_unique` constraint name. Fine for the developer running this repo, hostile to a self-hosting operator who doesn't know mysql2's error vocabulary. This milestone is the **error-translation pass** across operator-touched surfaces.

Scope:
- **`./bin/sw` actions** wrap service calls and map well-known failure shapes to single-line human-readable errors with a suggested next step. Examples to cover:
  - Unique-constraint violations (duplicate slug, duplicate origin) → "An origin `https://…` is already registered. Use `sw website origins list <slug>` to see existing entries."
  - Foreign-key failures (slug not found) → "No website with slug `<slug>`. Available: <list>. Create one with `sw website create <slug>`."
  - Malformed args caught upstream by service-layer validators (bad origin format, invalid model slug) → echo the validator's message plain.
  - Raw error stays available behind `--verbose` / `--debug` for the developer audience.
- **`./bin/chat`** connection failures (`ECONNREFUSED` against the configured `HOST:PORT` → "site-walker isn't running on `$HOST:$PORT` — start it with `npm run dev`?").
- **Boot-time errors** (`src/index.ts` / `buildServer`) — invalid `site-walker.toml`, missing `0600` perms, unreachable DB, missing GeoIP DB when required — already have decent messages, but get a consistency pass against the same vocabulary so the operator sees one voice across CLI + boot.

**Scope guard:** HTTP API error shapes (`{ error: 'origin_not_allowed', ... }`) are aimed at widget developers and documented in `docs/api-usage.md` — out of scope here. This milestone is purely about humans typing at a shell.

**Open question to resolve here:** centralised translation registry (`errorMap.ts` keyed by mysql2 `code` / `errno`, called from a thin CLI-action wrapper) versus hand-written per-action `try/catch`. Centralised scales but adds indirection; hand-written is concrete but verbose. Probably worth deferring the decision until we have three concrete examples in the wild.

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

**Target Completion:** Pre-v1.0.0
**Status:** 🔴 Not started
**Priority:** High — gates the first paying customer launch

Two features grouped because they share the same session-mint gating seam. Per-chatbot operational hours (timezone + weekly schedule); enforced at session-mint, not per turn (0.16.1 precedent). Plus admin-mode sessions: a power-user surface for logged-in WP administrators (Woo store admins using the bot to navigate their own catalogue, alongside the secondary "test the config" use). Admin-mode sessions skip Origin/geo/availability/daily-cap/capacity gates, use a separate per-session cap, suppress soft-handoff + webhook firing, and aggregate spend separately in reporting.

Full design + 11 open questions in [`14-availability-and-admin-mode.md`](14-availability-and-admin-mode.md).

**Todo:**

- [ ] Migration `0006_availability_and_admin_mode.js` — add `chatbots.timezone VARCHAR(64) NULL`, `chatbots.availability JSON NULL`, `chatbots.admin_session_budget_usd DECIMAL(10,4) NULL`, `sessions.is_admin_mode BOOLEAN NOT NULL DEFAULT FALSE`.
- [ ] `src/services/availability.ts` — IANA TZ validator, schedule JSON parser, `isOpenNow(chatbot, now)` returning `{ open, nextOpenAt }`. Pure functions + unit tests.
- [ ] Enforce availability at `POST /sessions` + `GET /sessions/can-start` only. New error code `chatbot_closed` (503 with `Retry-After` capped at 3600s + `detail.next_open_at` ISO).
- [ ] Extend `Chatbot` interface with `timezone`, `availability`, `admin_session_budget_usd`; extend `Session` with `is_admin_mode`.
- [ ] Extend `PATCH /admin/chatbots/{slug}` to accept `timezone`, `availability`, `admin_session_budget_usd`. IANA TZ + schedule grammar validation; null clears; `admin_session_budget_usd` bounded by `SW_MAX_SESSION_BUDGET_USD`.
- [ ] CLI: `sw chatbot set-timezone <slug> <tz>`, `sw chatbot set-hours <slug> <json-or-grammar>` (grammar shorthand like `mon-fri:09:00-17:00`; JSON-via-stdin fallback). Extend `sw chatbot set-budget` with `--admin-session <usd-or-none>`.
- [ ] New route `POST /admin/chatbots/{slug}/sessions` — account-admin-authenticated, empty body, returns `{ session_token, welcome_message, is_admin_mode: true }`. Stamps `sessions.is_admin_mode = TRUE`. Skips Origin/geo/availability/daily-cap/capacity at mint.
- [ ] `runChat()`: when `session.is_admin_mode`, skip Origin/geo checks; use `admin_session_budget_usd` for hard-cap; suppress soft-handoff inject; suppress webhook firing on hard-cap termination.
- [ ] `getChatbotDailySpend` adds `WHERE sessions.is_admin_mode = FALSE`. Admin spend doesn't displace customer daily-cap budget.
- [ ] `sw chatbot usage` + `GET /admin/chatbots/{slug}/usage` return split totals: `customer_cost_usd` + `admin_cost_usd`, with token counts to match.
- [ ] `sw sessions list` marks admin-mode rows with an `[admin]` suffix.
- [ ] Tests: availability open/closed boundaries; midnight + 24:00 handling; admin-mode mint route auth; admin-mode session skips every gate listed in the design doc's per-gate table; admin-mode hard-cap terminates *without* firing the webhook; admin-mode spend excluded from daily aggregation but included in usage reporting.
- [ ] Docs: `docs/api-admin.md` (new `POST /admin/chatbots/{slug}/sessions` + extended PATCH allowlist); `docs/api-usage.md` (new `503 chatbot_closed` in denial table); `docs/cli-sw.md` (set-timezone, set-hours, set-budget --admin-session); `docs/env.md` (no new vars expected); `dev-notes/14-availability-and-admin-mode.md` gets a "What shipped" section.
- [ ] CHANGELOG + milestone wrap-up (likely 0.17.0).

---

## Open questions

Tracked here alongside the milestone that resolves them, so they're visible in context.

Resolved (kept for the record):
- **M1 lib choices** — test framework (Jest vs node:test), CLI lib (commander.js vs alternative), `bin/chat` language (bash vs tiny Node). Resolved in M1.
- **Per-website system-block format** — resolved in M4. Flat directory of `.md` files; persona in DB; constant handling rule; XML-tagged block wrappers. Full design in [`04-system-blocks.md`](04-system-blocks.md).
- **Phase 3 architecture** — resolved 2026-05-19 in [`10-saas-shape.md`](10-saas-shape.md). Four-repo topology, WC-driven billing, BYO chatbot-level keys, DB-backed provider registry, M16–M20 phasing.
- **Provisioning-key bootstrap mechanism** — resolved 2026-05-20. `SW_PROVISIONING_KEY` in `.env`, **not** in the `admin_keys` table. Air-gap chosen over single-code-path symmetry: a bug in `admin_keys`-touching code cannot accidentally create a provisioning credential. Full rationale + rotation procedure in [`10-saas-shape.md`](10-saas-shape.md). M19 implements: boot hash, constant-time-compare middleware, `sw secrets gen-provisioning-key` CLI, boot validation that rejects empty/short values.

Still open:
- **History trimming strategy** — old M9 (likely superseded by budget-driven handoff, see [`11-budget-handoff.md`](11-budget-handoff.md)). Original sliding-window-vs-summarisation choice remains a fallback only if M18 cost data shows budgets don't bound conversation length in practice.
- **"I don't know, contact us" boundaries** — old M12 (renumber-deferred). What topics force the bail-out path?
- **Auto-mode content ingestion shape** — post-M20. Push-triggered vs scheduled cron; status surface (polling vs callbacks); per-run cost ceiling. Sketch in [`10-saas-shape.md`](10-saas-shape.md); full doc when this milestone is next-up.

---

## Notes for Development

- Stack and tenant-model decisions are in [`../CLAUDE.md`](../CLAUDE.md). If something here contradicts CLAUDE.md, CLAUDE.md wins — fix this file.
- Phase 1 is the validation phase. If Pi + Ollama can't carry the context window, Phase 2 may pull M8 (additional adapters) forward.
- Resist adding Redis before M11. MariaDB carries everything until then.
- This repo is API-only. The WordPress plugin lives elsewhere — anything resembling browser/widget code is out of scope.
- API-key auth is **not** Phase 1. Browser traffic auths via `Origin` allowlist + session token; admin work goes through the local CLI against the local DB. API keys arrive in Phase 2 only if/when a server-to-server HTTP caller appears.
- LLM provider config lives in MariaDB (since M17 / v0.13.0): `providers` + `provider_models` tables, per-chatbot BYO API keys in `chatbots.provider_api_key_*` (AES-256-GCM, master key in `.env` as `SW_ENCRYPTION_KEY`). Managed via `sw provider ...` and `sw chatbot set-api-key`. The pre-M17 TOML approach is preserved historically in [`03-llm-providers.md`](03-llm-providers.md).
- `ollama-native` is the lowest-common-denominator target. Design system blocks against the Pi's tight context first; larger models unlock larger per-website blocks but we never assume a fat context globally.
