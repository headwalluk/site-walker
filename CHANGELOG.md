# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Initial project documentation: `README.md` (goals, phased approach, non-goals).
- `CLAUDE.md` orientation file capturing tech stack and architecture decisions.
- Repository scaffolding: `.gitignore`, `CHANGELOG.md`, AGPLv3 `LICENSE`.
- `dev-notes/00-project-tracker.md` with 14 milestones across Phase 1 (smallest end-to-end loop) and Phase 2 (production).
- `dev-notes/01-auth-and-session-flow.md` — design doc for browser auth via `Origin` allowlist + opaque session token, endpoint shapes for `POST /sessions`, `POST /chat`, `GET /messages`, and capacity-check stub for M11.
- `dev-notes/02-data-model.md` — schema sketch for `websites`, `website_origins`, `sessions`, `messages`, with indexing rationale and migration order.
- `docs/` placeholder distinguishing operator-facing docs from internal `dev-notes/`.

### Changed
- Project pivoted from single-tenant to multi-tenant — one API instance serves many websites, each with its own system blocks and `Origin` allowlist.
- Auth model for browser traffic: was per-website API key, now `Origin` allowlist on session creation + opaque session token (bearer) on subsequent requests. API keys deferred to Phase 2.
- Project tracker restructured: old M2 ("Tenant model + API-key auth") split into M2 (tenant model + origin allowlist) and M3 (session lifecycle + endpoints).
- Project version set to `0.1.0` (in development); minimal `package.json` added.
- LLM backend design expanded from "one implementation per backend" to **protocol-adapter abstraction**: host-side TOML registry of providers (with `0600` permission gate and four-location search path), per-website `provider/model` slug + normalised parameters + declared context window in the DB. `ollama-native` is the Phase 1 adapter; `openrouter` and `anthropic` follow in M8. Full design in `dev-notes/03-llm-providers.md`.
- M5 milestone rescoped from "Model backend interface" to "LLM provider abstraction" — covers TOML loader, permission gate, protocol adapter interface, slug parser, normalised parameters, context-window validation.
- M8 milestone rescoped from "Anthropic Haiku backend" to "Additional protocol adapters (`openrouter`, `anthropic`)".
- `websites` schema gains `model_slug`, `model_parameters`, `model_context_window` columns (replacing the placeholder `model_backend` column).

### Added
- `dev-notes/03-llm-providers.md` — full design for the LLM provider abstraction.
- `data/` directory reserved for runtime artefacts (operator TOML if placed locally, per-website regenerated blocks); fully gitignored.
