# site-walker

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node: ≥22](https://img.shields.io/badge/node-%E2%89%A522-339933.svg?logo=node.js&logoColor=white)](package.json)
[![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange.svg)](dev-notes/00-project-tracker.md)

A self-hosted, multi-tenant pre-sales chatbot API.

## What it is

One site-walker instance serves many websites. Visitors talk to the bot through their website's own integration (a WordPress plugin, in the design case — that lives in a separate project). The bot answers from per-website system blocks plus the running conversation, persisted server-side. No tools, no agents, no cross-session memory: a tight pre-sales Q&A bot you can point at your own infrastructure.

Browser auth is by `Origin` allowlist + opaque session token. LLM backends are pluggable: Phase 1 ships an `ollama-native` adapter for self-hosting on a Raspberry Pi or laptop; cloud adapters (Anthropic, OpenRouter) land in Phase 2.

## Who it's for

Small-site operators who want a pre-sales bot they can stand up and reason about end-to-end without renting somebody else's SaaS — and developers who want a small, opinionated codebase to read or extend.

## Docs

Operator and developer reference docs live in [`docs/`](docs/):

- [**Browser API usage**](docs/api-usage.md) — chat flow for widget developers: `POST /sessions`, `POST /chat`, `GET /messages`, token persistence, error handling.
- [**`./bin/sw` CLI reference**](docs/cli-sw.md) — register websites, manage origins, choose models, inspect system blocks.
- [**`./bin/chat` reference**](docs/cli-chat.md) — interactive test client that exercises the loop end-to-end.
- [**`site-walker.toml`**](docs/site-walker-toml.md) — the provider registry: search paths, permission gate, per-provider keys.
- [**`.env`**](docs/env.md) — environment file: database connection, host/port, permission gate.
- [**System blocks**](docs/system-blocks.md) — persona, disk blocks, ordering rules, token-budget interplay.

Internal planning, design docs, and the project tracker live in [`dev-notes/`](dev-notes/).
