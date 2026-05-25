# site-walker

[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](LICENSE)
[![Node: ≥22](https://img.shields.io/badge/node-%E2%89%A522-339933.svg?logo=node.js&logoColor=white)](package.json)
[![Status: pre-1.0](https://img.shields.io/badge/status-pre--1.0-orange.svg)](dev-notes/00-project-tracker.md)

A self-hosted, multi-tenant pre-sales chatbot API.

## What it is

One site-walker instance serves many websites. Visitors talk to the bot through their website's own integration (a WordPress plugin, in the design case — that lives in a separate project). The bot answers from per-chatbot system blocks plus the running conversation, persisted server-side. No tools, no agents, no cross-session memory: a tight pre-sales Q&A bot you can point at your own infrastructure.

Browser auth is by `Origin` allowlist + opaque session token. LLM backends are pluggable adapters configured per-chatbot via a DB-backed provider registry: `ollama-native` for self-hosted Ollama on the LAN, `openrouter` for everything cloud-side (Anthropic, OpenAI, Google, …). Each chatbot supplies its own provider API key, encrypted at rest with AES-256-GCM.

## Who it's for

Small-site operators who want a pre-sales bot they can stand up and reason about end-to-end without renting somebody else's SaaS — and developers who want a small, opinionated codebase to read or extend.

## Docs

Operator and developer reference docs live in [`docs/`](docs/):

- [**Quickstart**](docs/quickstart.md) — fresh install to first chat in ~10 minutes. Account → chatbot → origin → provider → model → API key → budget caps → system blocks → test.
- [**Browser API usage**](docs/api-usage.md) — chat flow for widget developers: `POST /sessions`, `POST /chat`, `GET /messages`, token persistence, error handling.
- [**Admin HTTP API**](docs/api-admin.md) — operator + provisioning surface: bearer-token auth, account creation, chatbot CRUD, system-block push, BYO-key set, usage aggregation. Audience: `site-walker-wp` + `site-walker-for-woo` integrations + self-hosters who prefer HTTP over `./bin/sw`.
- [**`./bin/sw` CLI reference**](docs/cli-sw.md) — register chatbots, manage origins, choose models, inspect system blocks.
- [**`./bin/chat` reference**](docs/cli-chat.md) — interactive test client that exercises the loop end-to-end.
- [**Provider registry**](docs/cli-sw.md#sw-provider) — DB-backed (since 0.13.0); managed via `sw provider add/list/show/remove` and `sw provider models add/list/remove/discover`.
- [**`.env`**](docs/env.md) — environment file: database connection, host/port, permission gate.
- [**System blocks**](docs/system-blocks.md) — persona, disk blocks, ordering rules, token-budget interplay.

Operator config samples live in [`etc/`](etc/) — currently a single Apache 2.4 reverse-proxy vhost ([`etc/apache-reverse-proxy.conf.example`](etc/apache-reverse-proxy.conf.example)) for fronting the API at a public HTTPS endpoint.

Internal planning, design docs, and the project tracker live in [`dev-notes/`](dev-notes/).
