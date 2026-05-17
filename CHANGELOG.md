# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
