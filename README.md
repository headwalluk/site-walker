# site-walker

A self-hosted, multi-tenant chatbot API for answering pre-sales questions on
low-traffic websites. Bought-in services exist; this is being built for the fun
of it.

## Goals

- A chatbot HTTP endpoint that web visitors can talk to about the business/site.
- **Multi-tenant:** one API instance serves many websites. Each website has its
  own system blocks and API key(s). Tenant resolution happens via API key on
  every request.
- Each visitor session maintains its own conversation history server-side, scoped
  to the website it belongs to.
- Conversations are seeded with **preformatted system blocks** (per website)
  containing core FAQs, glossary, and a website/company/business summary.
- Those system blocks are mostly static — regenerated daily or weekly by a cron
  using a high-end LLM, then served from disk at request time.
- An operator CLI (`./bin/sw`) for admin tasks: managing websites, API keys,
  database backup/restore, ad-hoc system-block rebuilds.

## Hardware & model strategy

- **Development:** locally-hosted Ollama on a Raspberry Pi with hardware-accelerated
  NPU. Reasonable speed, but small context window.
- **Production fallback:** if the Pi's context window proves too tight, swap the
  model backend for Anthropic Haiku (larger context, similar latency profile from
  the visitor's point of view). The application code should treat the model as a
  pluggable backend so this swap is a config change, not a rewrite.

## Phased approach

### Phase 1 — Simple test project
Smallest thing that proves the loop end-to-end:
- HTTP endpoint that accepts an API key + message + session ID.
- API key resolves to a website; loads that website's system blocks.
- Per-session conversation history in MariaDB, scoped by `website_id`.
- Single model backend (Ollama on the Pi) behind a thin interface.
- `./bin/sw` admin CLI — enough to create a website, mint an API key, and
  back up/restore the database.
- `./bin/chat` test helper — small interactive script (bash or tiny Node)
  that reads the project `.env` for host/port + API key and runs a chat
  session from the terminal. Replaces a browser UI in development.

Goal: validate that the Pi + system-blocks approach gives useful answers at
acceptable latency, and surface whatever context-window pain points exist.

### Phase 2 — Production
Add the things a real public endpoint needs:
- Pluggable model backend (Ollama ↔ Haiku) chosen by config.
- A strategy for trimming conversation history when context fills
  (sliding window vs. summarise-older-turns — decide before schema is set).
- Prompt-injection / jailbreak handling appropriate for a pre-sales bot.
- Rate limiting / abuse protection (first Redis use).
- Conversation logging review — retention policy + operator review tooling.
- Cron job that rebuilds each website's system blocks from source material.
- Production deployment runbook, health checks, cluster validation.

## Non-goals (for now)

- HTML widget / browser code. The visitor-facing widget is a separate project,
  expected to ship as a **WordPress plugin** that calls this API.
- Account-based memory across sessions.
- Anything resembling agentic tool use — pre-sales Q&A only.

## Open questions to settle in Phase 1

- Format and source-of-truth for the system blocks (per-website layout).
- History-trimming strategy (shapes session storage schema; settled in Phase 2 but
  schema should accommodate the chosen approach).
- Where the bot should say "I don't know, contact us" rather than guess.
