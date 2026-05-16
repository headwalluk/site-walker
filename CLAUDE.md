# CLAUDE.md

Orientation for Claude Code working in this repo. Project vision and phasing live in [README.md](./README.md). Tracker and design docs live in [`dev-notes/`](./dev-notes/) (internal) — start with [`dev-notes/00-project-tracker.md`](./dev-notes/00-project-tracker.md) and the three design docs it links to (auth/session, data model, LLM providers).

## What this is

A self-hosted, **multi-tenant** pre-sales chatbot API. One instance serves many websites. Visitors chat through their website's own integration (WordPress plugin, not in this repo), the bot answers from that website's preformatted system blocks plus the running conversation. No tools, no agents.

## Tech stack

- **Runtime:** Node.js + npm
- **Language:** TypeScript
- **HTTP:** Fastify
- **DB:** MariaDB
- **DB layer:** knex (query builder + migrations)
- **Model backends:** Ollama (dev, Raspberry Pi + NPU) and Anthropic Haiku (prod fallback) — behind a pluggable interface, switched by config
- **Cache / edge (Phase 2):** Redis — reserved for rate limiting and similar real-time concerns, **not** session storage
- **Operator CLIs:**
  - `./bin/sw` — admin: websites, origin allowlist, welcome messages, db backup/restore, system-block rebuild triggers, conversation browse
  - `./bin/chat` — interactive test client (bash or tiny Node); reads `.env` for host/port

## Architecture decisions

- **Multi-tenant from day one.** Every persistent entity carries a `website_id`. Websites are configured via the admin CLI; each has an allowlist of acceptable browser `Origin` strings.
- **Browser auth = `Origin` allowlist + session token.** Browsers don't carry API keys. `POST /sessions` verifies `Origin`, returns an opaque session token; subsequent `POST /chat` and `GET /messages` carry the token as `Authorization: Bearer …`. Full design in [`dev-notes/01-auth-and-session-flow.md`](./dev-notes/01-auth-and-session-flow.md).
- **API keys are not Phase 1.** No server-to-server HTTP caller exists yet — admin work goes through the local CLI against the local DB via knex. API keys land in Phase 2 if/when needed (WP plugin admin channel, remote CLI usage).
- **API tier is stateless and cluster-capable.** Any node can serve any request; nothing in process memory survives between requests.
- **Conversation state lives in MariaDB.** Doubles as the conversation log required in Phase 2 (audit / human review). Schema in [`dev-notes/02-data-model.md`](./dev-notes/02-data-model.md).
- **System blocks** are static markdown files on disk, per-website (likely `data/websites/<slug>/`). Regenerated daily/weekly by a cron. Read at request time, not baked into the binary.
- **Model interface is pluggable.** LLM providers are declared in a host-side TOML config (mode `0600`, searched at startup across `./data/`, `$HOME/.site-walker/`, `$HOME/.config/site-walker/`, `/etc/`). Per-website model selection lives in the DB as a `provider/model` slug + normalised parameters + declared context window. Adding a new provider is an operator action; switching a website's model is a DB update. Full design in [`dev-notes/03-llm-providers.md`](./dev-notes/03-llm-providers.md).
- **Ollama is the lowest common denominator.** Design system blocks against the Pi's tight context first. Larger-context providers unlock larger per-website blocks; never assume a fat context globally.
- **Return shape on `POST /chat`:** only the new assistant reply. Clients use `GET /messages` for initial-load history rehydrate. Avoids payloads that grow with conversation length.
- **No browser code in this repo.** The visitor-facing widget is a separate WordPress-plugin project. Development testing happens via `curl` and `./bin/chat`.

## Non-goals

Listed in README. The important ones to internalise: no widget/browser code (separate WordPress project), no cross-session memory, no tool use, no agentic behaviour.

## Conventions

- **Before any `git commit` or `git push`, run `npm run format && npm run lint` and clear all errors.** Don't stage code on a tree that fails either. Format is `prettier --write .`; lint is `eslint .` (flat config). Both are non-negotiable.
- Prefer the boring, mature, proven library over the newer/cleverer one unless there's a project-specific reason to reach for the new thing.
- Migrations go through knex — no ad-hoc schema changes.
- Don't introduce Redis until there's a concrete real-time need (rate limiting is the expected first use, Phase 2).
- Every new table/feature must have `website_id` scoping unless there's a documented reason it's tenant-global (e.g. system-wide config).
- Secrets (LLM API keys etc.) live in `site-walker.toml` on the host with mode `0600`. The app refuses to start if permissions are looser. Never store provider secrets in the DB.
- `data/` is for runtime artefacts (operator's TOML if placed locally, per-website regenerated blocks) and is fully gitignored. Configuration *examples* live under `config/` and are checked in.
- `dev-notes/` is internal planning for the people building this. `docs/` is for operators and self-hosters. Don't cross the streams.
- Open design questions are tracked in [`dev-notes/00-project-tracker.md`](./dev-notes/00-project-tracker.md) next to the milestone that resolves them.
