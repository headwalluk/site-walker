# CLAUDE.md

Orientation for Claude Code working in this repo. Project vision and phasing live in [README.md](./README.md) — this file captures decisions made on top of it.

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
  - `./bin/sw` — admin: websites, API keys, db backup/restore, system-block rebuild triggers, conversation browse
  - `./bin/chat` — interactive test client (bash or tiny Node); reads `.env` for host/port + test API key

## Architecture decisions

- **Multi-tenant from day one.** Every persistent entity carries a `website_id`. Websites are configured via the admin CLI; each gets one or more API keys. Tenant resolution happens via API key on every `/chat` request — no path-based or subdomain-based routing.
- **API tier is stateless and cluster-capable.** Any node can serve any request; nothing in process memory survives between requests.
- **Conversation state lives in MariaDB.** Doubles as the conversation log required in Phase 2 (audit / human review).
- **Request shape:** client sends `{ sessionId, message }` plus an `Authorization: Bearer <api-key>` header (final shape TBD in M2). API resolves website from key, loads history scoped to `(website_id, session_id)`, loads system blocks for that website from disk, sends to the model, persists the new turn, returns the reply.
- **System blocks** are static markdown files on disk, per-website (likely `data/websites/<slug>/`). Regenerated daily/weekly by a cron using a high-end LLM. Read at request time, not baked into the binary.
- **Model interface is pluggable.** Swapping Ollama ↔ Haiku is a config change, not a code change.
- **No browser code in this repo.** The visitor-facing widget is a separate WordPress-plugin project. Development testing happens via `curl` and `./bin/chat`.

## Non-goals

Listed in README. The important ones to internalise: no widget/browser code (separate WordPress project), no cross-session memory, no tool use, no agentic behaviour.

## Conventions

- Prefer the boring, mature, proven library over the newer/cleverer one unless there's a project-specific reason to reach for the new thing.
- Migrations go through knex — no ad-hoc schema changes.
- Don't introduce Redis until there's a concrete real-time need (rate limiting is the expected first use, Phase 2).
- Every new table/feature must have `website_id` scoping unless there's a documented reason it's tenant-global (e.g. system-wide config).
- Open design questions are tracked in [`dev-notes/00-project-tracker.md`](./dev-notes/00-project-tracker.md) next to the milestone that resolves them.
