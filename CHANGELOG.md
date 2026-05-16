# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `dev-notes/04-system-blocks.md` — design for the per-website system-blocks loader. Flat `data/websites/<slug>/*.md` layout (no prefix-ordering tricks), app-injected opening persona line (sourced from a new `websites.bot_persona` column) + a constant handling rule, operator blocks wrapped as `<block name="…">…</block>` so the model treats them as reference data. No frontmatter, no caching, no closing reinforcement in v1 — all documented as deliberately deferred (safety/guardrail hardening picked up in M12).
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
- CLAUDE.md convention: never default to common ports (3000/8080/etc.); use obscure defaults because the dev host runs many services.

### Added
- `dev-notes/publishing-to-public-repo.md` — pre-publish checklist (credential sweep, dead-credential handling, README/LICENSE/CI checks) plus the record of known historical leaks. Commit `532acf8` is on the list as a dead-credential row (DB_PASSWORD value rotated immediately on detection).

### Changed
- Refactor: `buildServer()` extracted to `src/server.ts`; `src/index.ts` is now a thin entry point that just calls `listen()`. Enables testing without binding a real port.
- Default `PORT` changed from `3000` to `47830` in both `.env.example` and `src/index.ts` fallback. `PORT+1` reserved for any port-bound test server.
- M1 (Project Scaffolding) marked complete in the project tracker; resolved decisions captured in-place.

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
