# site-walker — Project Tracker

**Last Updated:** 15 May 2026
**Current Version:** pre-0.1.0
**Current Phase:** Milestone 1 (Project Scaffolding) — not started
**Overall Progress:** 0% — greenfield

Vision and phasing live in [`../README.md`](../README.md). Stack and architecture decisions live in [`../CLAUDE.md`](../CLAUDE.md). This file tracks the work.

---

## Phase 1 — Smallest end-to-end loop

Goal: prove a visitor on a registered website can chat to the bot, authenticated by API key, with that website's system blocks prepended and per-session history maintained server-side. Ollama-only. Tested via `curl` and `./bin/chat`. Validates the Pi context-window assumptions before any Phase 2 investment.

### Milestone 1: Project scaffolding

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** Foundation — blocks everything else

npm init, TypeScript config, Fastify server with a hello-world route, knex installed and configured against MariaDB, `.env` handling, linter, formatter, test harness (Jest or node:test — decide before scaffolding). Skeleton `bin/sw` (commander.js or similar) and `bin/chat` (bash + curl + jq, or a tiny Node script — decide) in place so later milestones plug into a working frame.

### Milestone 2: Tenant model + API-key auth

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — every other Phase 1 milestone depends on this

knex migrations for `websites` and `api_keys` tables. Service layer for both. Fastify auth hook that resolves an incoming `Authorization: Bearer <key>` to a website, attaches it to the request, and rejects unknown/revoked keys. Bare-minimum CLI commands to make this testable: `./bin/sw website create <slug>` and `./bin/sw api-key create <website-slug>`. Broader CLI surface (list/show/revoke) lands in M7.

### Milestone 3: System-blocks loader (per-website)

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — settles an open question from README

Define the on-disk layout for per-website system blocks (likely `data/websites/<slug>/<something>`). Decide block format: single file, directory of files, frontmatter-tagged sections. Loader reads the current request's website blocks, concatenates them into a system prompt. Ship hand-written stub blocks for one test website so the chat loop has something to read.

**Open question to resolve here:** per-website system-block format.

### Milestone 4: Model backend interface

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — interface shape locks in Phase 2 backend swap

Pluggable `ModelBackend` interface (chat-completion shape; streaming TBD). One implementation only in Phase 1: Ollama running on the Pi. Config-driven selection from the start, even though there's only one choice — keeps the Phase 2 Haiku swap a config change, not a refactor.

### Milestone 5: Session storage (MariaDB)

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — required by stateless-API decision

knex migrations for `sessions` and `messages` tables, both scoped by `website_id`. Service layer for create/append/load. Schema kept minimal until history-trimming strategy is decided in M9 — but the basic shape (one row per turn, ordered by `created_at`, scoped to `(website_id, session_id)`) should be good enough for both sliding-window and summarisation later.

### Milestone 6: Chat endpoint + `./bin/chat` test harness

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** Critical — this *is* the Phase 1 deliverable

`POST /chat` that ties the previous milestones together: API-key auth resolves the website, accept `{ sessionId, message }`, load session history scoped to `(website_id, session_id)`, load that website's system blocks, call the model backend, persist the new turn pair, return the reply. Auto-create a session row if `sessionId` is unknown.

`./bin/chat` — small interactive script that reads `.env` for `PORT` + `SW_TEST_API_KEY`, generates or accepts a session ID, and loops on user input. Bash + curl + jq if that's enough; tiny Node + readline if we want better line editing.

### Milestone 7: Admin CLI (`./bin/sw`)

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — operator surface for everything Phase 1 produced

Expand the M2 stub CLI into a full admin surface. Subcommands (working names):
- `sw website list/show/delete` (`create` already exists from M2)
- `sw api-key list/show/revoke` (`create` already exists from M2)
- `sw db backup/restore/list/prune` — wrapper around `mysqldump`/`mysql`
- `sw blocks rebuild <website>` — ad-hoc trigger for what the M10 cron will run automatically
- `sw conversations list/show <session-id>` — read-only browse for development; the formal review surface comes in M13

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

Decide between sliding-window (drop oldest turns once a token budget is hit) and summarise-older-turns (compact older history into a single summary message). Implement the chosen strategy. May add a `summary` column on `sessions` or a separate `session_summaries` table — settle the decision *before* this lands so the schema doesn't churn.

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

First Redis use. Per-IP and per-API-key rate limits on `/chat`, with sane defaults and `.env`-tunable thresholds. Abuse heuristics — repeated identical messages, prompt-injection-shaped payloads (basic regex, not full classifier), suspiciously high token consumption from one session. Graceful degradation: if Redis is unavailable, decide whether to fail-open or fail-closed.

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

Basic browse already exists via the M7 CLI. This milestone is the **policy + tooling beyond browse**: retention period (how long do we keep sessions before purging?), export for offline review, redaction of obvious PII before display, optional protected admin HTTP endpoint if a CLI is too clunky for real review work.

### Milestone 14: Production deployment

**Target Completion:** TBD
**Status:** 🔴 Not started
**Priority:** High — gate on going live

Process management (PM2 or systemd — decide), reverse-proxy config, health check endpoint (`/health` — DB + model backend ping), structured logging, deployment runbook. Cluster mode validated end-to-end (a session created via one node is readable from any node). WordPress-plugin project should be far enough along by this point that we can do a real integration test on a real site.

---

## Open questions

Tracked here alongside the milestone that resolves them, so they're visible in context.

- **Per-website system-block format** — M3. Single file vs directory of files vs frontmatter-tagged sections.
- **History trimming strategy** — M9. Sliding window vs summarisation. Shapes session schema.
- **"I don't know, contact us" boundaries** — M12. What topics force the bail-out path?

---

## Notes for Development

- Stack and tenant-model decisions are in [`../CLAUDE.md`](../CLAUDE.md). If something here contradicts CLAUDE.md, CLAUDE.md wins — fix this file.
- Phase 1 is the validation phase. If Pi + Ollama can't carry the context window, Phase 2 may pull M8 (Haiku) forward.
- Resist adding Redis before M11. MariaDB carries everything until then.
- This repo is API-only. The WordPress plugin lives elsewhere — anything resembling browser/widget code is out of scope.
