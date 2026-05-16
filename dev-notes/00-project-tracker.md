# site-walker — Project Tracker

**Last Updated:** 15 May 2026
**Current Version:** pre-0.1.0
**Current Phase:** Milestone 1 (Project Scaffolding) — not started
**Overall Progress:** 0% — greenfield

Vision and phasing live in [`../README.md`](../README.md). Stack and architecture decisions live in [`../CLAUDE.md`](../CLAUDE.md). Auth/session and data-model design live in companion docs in this directory. This file tracks the work.

Companion planning docs:
- [`01-auth-and-session-flow.md`](01-auth-and-session-flow.md) — origin allowlist, session-token lifecycle, endpoint shapes
- [`02-data-model.md`](02-data-model.md) — schema sketch for `websites`, `website_origins`, `sessions`, `messages`

---

## Phase 1 — Smallest end-to-end loop

Goal: prove a visitor on a registered website can chat to the bot, with the browser auth'd by `Origin` allowlist + session token, that website's system blocks prepended, and per-session history maintained server-side. Ollama-only. Tested via `curl` and `./bin/chat`. Validates the Pi context-window assumptions before any Phase 2 investment.

### Milestone 1: Project scaffolding

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** Foundation — blocks everything else

npm init, TypeScript config, Fastify server with a hello-world route, knex installed and configured against MariaDB, `.env` handling, linter, formatter, test harness. Skeleton `bin/sw` and `bin/chat` in place so later milestones plug into a working frame.

**Decisions to make on entering M1** (no answer needed yet, just before scaffolding starts):
- Test framework — Jest vs node:test.
- CLI library for `bin/sw` — commander.js vs yargs vs minimal hand-rolled.
- `bin/chat` language — bash + curl + jq vs tiny Node + readline.

### Milestone 2: Tenant model (websites + origin allowlist)

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — every other Phase 1 milestone depends on this

knex migrations for `websites` and `website_origins` tables per [`02-data-model.md`](02-data-model.md). Service layer for CRUD. Minimal CLI commands to make this testable: `sw website create <slug>` and `sw website add-origin <slug> <origin>`. No HTTP auth wired yet — that lands in M3 with session lifecycle. Broader CLI surface (list/show/remove) is M7.

### Milestone 3: Session lifecycle (POST /sessions, GET /messages)

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — defines the auth model for browser traffic

knex migrations for `sessions` and `messages` tables (also in [`02-data-model.md`](02-data-model.md)). Implement the session-creation and history-rehydrate endpoints per [`01-auth-and-session-flow.md`](01-auth-and-session-flow.md):
- `POST /sessions` — verifies request `Origin` against `website_origins`, mints opaque session token, persists `(website_id, token)`, returns `{ session_token, welcome_message }`.
- `GET /messages` — bearer-token auth, returns full conversation for the bound session (used by client for initial-load rehydrate).

Welcome message stored as a column on `websites`. Capacity check (503) is a stub in Phase 1 — wiring exists, returns 201 unconditionally until M11.

### Milestone 4: System-blocks loader (per-website)

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — settles an open question from README

Define the on-disk layout for per-website system blocks (likely `data/websites/<slug>/<something>`). Decide block format: single file, directory of files, frontmatter-tagged sections. Loader reads the current request's website blocks, concatenates them into a system prompt. Ship hand-written stub blocks for one test website so the chat loop has something to read.

**Open question to resolve here:** per-website system-block format.

### Milestone 5: Model backend interface

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — interface shape locks in Phase 2 backend swap

Pluggable `ModelBackend` interface (chat-completion shape; streaming TBD). One implementation only in Phase 1: Ollama running on the Pi. Config-driven selection from the start, even though there's only one choice — keeps the Phase 2 Haiku swap a config change, not a refactor.

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

### Milestone 8: Anthropic Haiku backend

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — production fallback per README

Second implementation of the `ModelBackend` interface. Driven by config — same `.env` switch flips between Ollama and Haiku. API key handling, error mapping, retry/backoff. Per-website override possible if some sites need a different backend than the global default (decide if worth building).

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

- **M1 lib choices** — test framework (Jest vs node:test), CLI lib (commander.js vs alternative), `bin/chat` language (bash vs tiny Node). Resolve when starting M1.
- **Per-website system-block format** — M4. Single file vs directory of files vs frontmatter-tagged sections.
- **History trimming strategy** — M9. Sliding window vs summarisation. Shapes session schema.
- **"I don't know, contact us" boundaries** — M12. What topics force the bail-out path?

---

## Notes for Development

- Stack and tenant-model decisions are in [`../CLAUDE.md`](../CLAUDE.md). If something here contradicts CLAUDE.md, CLAUDE.md wins — fix this file.
- Phase 1 is the validation phase. If Pi + Ollama can't carry the context window, Phase 2 may pull M8 (Haiku) forward.
- Resist adding Redis before M11. MariaDB carries everything until then.
- This repo is API-only. The WordPress plugin lives elsewhere — anything resembling browser/widget code is out of scope.
- API-key auth is **not** Phase 1. Browser traffic auths via `Origin` allowlist + session token; admin work goes through the local CLI against the local DB. API keys arrive in Phase 2 only if/when a server-to-server HTTP caller appears.
