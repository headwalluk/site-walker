# site-walker — Project Tracker

**Last Updated:** 16 May 2026
**Current Version:** 0.5.0
**Current Phase:** Milestone 6 (Chat endpoint + ./bin/chat) — not started
**Overall Progress:** ~36% — M1, M2, M3, M4, M5 complete (5 of 14). 0.5.0 was a between-milestone cleanup: TOML moves out of `data/` to the project root, `config/` retires into `templates/`, `.env` gets the same `0600` gate as `site-walker.toml`.

Vision and phasing live in [`../README.md`](../README.md). Stack and architecture decisions live in [`../CLAUDE.md`](../CLAUDE.md). Auth/session and data-model design live in companion docs in this directory. This file tracks the work.

Companion planning docs:
- [`01-auth-and-session-flow.md`](01-auth-and-session-flow.md) — origin allowlist, session-token lifecycle, endpoint shapes
- [`02-data-model.md`](02-data-model.md) — schema sketch for `websites`, `website_origins`, `sessions`, `messages`
- [`03-llm-providers.md`](03-llm-providers.md) — TOML provider registry, per-website model selection, protocol adapters, normalised parameters, context-window handling

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

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** Critical — this *is* the Phase 1 deliverable

`POST /chat` that ties everything together: bearer session token resolves website + session, append the new user message to `messages`, load full history, load that website's system blocks, call the model backend, persist the assistant reply, return `{ reply, message_id }`. Returns only the new reply, **not** the full history — clients use `GET /messages` for rehydrate.

`./bin/chat` — small interactive script that reads `.env` for host/port, calls `POST /sessions` to get a token, then loops on user input. Bash + curl + jq if that's enough; tiny Node + readline if we want better line editing.

### Milestone 7: Admin CLI (`./bin/sw`)

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — operator surface for everything Phase 1 produced

Expand the M2/M3 stub CLI into a full admin surface. Subcommands (working names):
- `sw website list/show/delete` (`create` already exists from M2)
- `sw website origins list/add/remove <slug>` (`add` already exists from M2)
- `sw website set-welcome <slug> <message>` — updates the welcome message returned by `POST /sessions`
- `sw db backup/restore/list/prune` — wrapper around `mysqldump`/`mysql`
- `sw blocks rebuild <slug>` — ad-hoc trigger for what the M10 cron will run automatically
- `sw sessions list/show <token-or-id>` — read-only browse for development; the formal review surface comes in M13

---

## Phase 2 — Production

Goal: a publicly-exposed pre-sales bot that's safe to point real visitor traffic at. Pluggable backends, abuse protection, automated regeneration of system blocks, retention policy, deployable.

### Milestone 8: Additional protocol adapters (`openrouter`, `anthropic`)

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — unlocks production-grade models per README hardware strategy

Add two protocol adapters to the M5 abstraction:

- **`openrouter`** (priority) — OpenAI-compatible wire format, OpenRouter's base URL and model-name convention. Highest priority because it gives access to many models behind one provider entry.
- **`anthropic`** — direct Anthropic Messages API. Production fallback for the larger-context use case.

Per-adapter parameter translation per [`03-llm-providers.md`](03-llm-providers.md). Error mapping (auth failures, rate limits, context overflows from the provider side) normalised to common shapes. Retry/backoff on transient failures.

May also introduce `openai-compatible` if a third use case appears that's not OpenRouter-specific.

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

Process management (PM2 or systemd — decide), reverse-proxy config, health check endpoint (`/health` — DB + model backend ping), structured logging, deployment runbook. Cluster mode validated end-to-end (a session created via one node is readable from any node). WordPress-plugin project should be far enough along by this point that we can do a real integration test on a real site.

---

## Open questions

Tracked here alongside the milestone that resolves them, so they're visible in context.

- **M1 lib choices** — test framework (Jest vs node:test), CLI lib (commander.js vs alternative), `bin/chat` language (bash vs tiny Node). Resolved in M1.
- **Per-website system-block format** — resolved in M4. Flat directory of `.md` files; persona in DB; constant handling rule; XML-tagged block wrappers. Full design in [`04-system-blocks.md`](04-system-blocks.md).
- **History trimming strategy** — M9. Sliding window vs summarisation. Shapes session schema.
- **"I don't know, contact us" boundaries** — M12. What topics force the bail-out path?

---

## Notes for Development

- Stack and tenant-model decisions are in [`../CLAUDE.md`](../CLAUDE.md). If something here contradicts CLAUDE.md, CLAUDE.md wins — fix this file.
- Phase 1 is the validation phase. If Pi + Ollama can't carry the context window, Phase 2 may pull M8 (additional adapters) forward.
- Resist adding Redis before M11. MariaDB carries everything until then.
- This repo is API-only. The WordPress plugin lives elsewhere — anything resembling browser/widget code is out of scope.
- API-key auth is **not** Phase 1. Browser traffic auths via `Origin` allowlist + session token; admin work goes through the local CLI against the local DB. API keys arrive in Phase 2 only if/when a server-to-server HTTP caller appears.
- LLM provider config lives in a host-side TOML file (`site-walker.toml`, mode `0600`) — not in the DB. Per-website model selection lives in the DB. Full design in [`03-llm-providers.md`](03-llm-providers.md).
- `ollama-native` is the lowest-common-denominator target. Design system blocks against the Pi's tight context first; larger models unlock larger per-website blocks but we never assume a fat context globally.
