# Data model

Schema sketch for the Phase 1 tables. Settled 15 May 2026 alongside [`01-auth-and-session-flow.md`](01-auth-and-session-flow.md). Final migrations land in M2 (tenant tables) and M3 (session tables) — this doc is the design they should match.

MariaDB syntax. Defaults to InnoDB, utf8mb4. Timestamps are `DATETIME` with `DEFAULT CURRENT_TIMESTAMP` where appropriate.

---

## `websites`

One row per registered website (tenant).

| Column            | Type                | Constraints                          | Notes                                                                 |
|-------------------|---------------------|--------------------------------------|-----------------------------------------------------------------------|
| `id`              | `INT UNSIGNED`      | PK, AUTO_INCREMENT                   |                                                                       |
| `slug`            | `VARCHAR(64)`       | NOT NULL, UNIQUE                     | URL-safe identifier, e.g. `acme-corp`. Used in CLI and on-disk paths. |
| `name`            | `VARCHAR(255)`      | NOT NULL                             | Human-readable.                                                       |
| `welcome_message`        | `TEXT`         | NULL                                 | Returned by `POST /sessions`. NULL → app-default fallback.       |
| `model_slug`             | `VARCHAR(128)` | NULL                                 | E.g. `local1/qwen2:1.5b`. See [`03-llm-providers.md`](03-llm-providers.md). NULL until set by admin. |
| `model_parameters`       | `JSON`         | NULL                                 | Normalised parameter object (`temperature`, `top_p`, `max_tokens`, `stop`). NULL = adapter defaults. |
| `model_context_window`   | `INT UNSIGNED` | NULL                                 | Operator-declared total context tokens for the chosen model. Drives context-fit validation. |
| `created_at`             | `DATETIME`     | NOT NULL, DEFAULT CURRENT_TIMESTAMP  |                                                                  |
| `updated_at`             | `DATETIME`     | NOT NULL, ON UPDATE CURRENT_TIMESTAMP|                                                                  |

Indexes: `slug` UNIQUE (declared above).

**Why three columns and not one JSON blob:** `model_slug` and `model_context_window` are looked up on every request and need to be queryable (CLI listings, validation). `model_parameters` is opaque to MariaDB — its shape lives in the adapter layer — so JSON is the right type. Keeping the slug and context window as scalar columns also lets us index/filter by them later if needed.

---

## `website_origins`

Per-website allowlist of `Origin` strings that `POST /sessions` accepts.

| Column        | Type            | Constraints                                  | Notes                                                |
|---------------|-----------------|----------------------------------------------|------------------------------------------------------|
| `id`          | `INT UNSIGNED`  | PK, AUTO_INCREMENT                           |                                                      |
| `website_id`  | `INT UNSIGNED`  | NOT NULL, FK → `websites.id` ON DELETE CASCADE |                                                    |
| `origin`      | `VARCHAR(255)`  | NOT NULL, UNIQUE                             | Exact origin: scheme + host + (non-default port).    |
| `created_at`  | `DATETIME`      | NOT NULL, DEFAULT CURRENT_TIMESTAMP          |                                                      |

Indexes:
- `origin` UNIQUE — primary lookup path, also enforces "no origin shared across tenants."
- `website_id` (regular index) — for listing all origins of a given website in the CLI.

**Why `origin` is globally unique:** lookup pattern is "given an incoming `Origin`, find the website." Allowing the same string to map to multiple websites makes the lookup ambiguous and creates a takeover risk if a website is later deleted. One origin → at most one website is the simpler invariant.

---

## `sessions`

One row per visitor chat session.

| Column            | Type             | Constraints                                  | Notes                                                 |
|-------------------|------------------|----------------------------------------------|-------------------------------------------------------|
| `id`              | `BIGINT UNSIGNED`| PK, AUTO_INCREMENT                           | BIGINT because sessions accumulate.                   |
| `website_id`      | `INT UNSIGNED`   | NOT NULL, FK → `websites.id` ON DELETE CASCADE |                                                     |
| `token`           | `CHAR(64)`       | NOT NULL, UNIQUE                             | 32 random bytes hex-encoded. See auth doc.            |
| `summary`         | `TEXT`           | NULL                                         | Populated by M9 if summarisation chosen. Reserved.    |
| `created_at`      | `DATETIME`       | NOT NULL, DEFAULT CURRENT_TIMESTAMP          |                                                       |
| `last_active_at`  | `DATETIME`       | NOT NULL, DEFAULT CURRENT_TIMESTAMP          | Touched on every `POST /chat`. Drives M13 retention.  |

Indexes:
- `token` UNIQUE — primary lookup path (bearer-token resolution).
- `(website_id, last_active_at)` — for retention sweeps and per-tenant browse.

**`summary` is reserved, not used in Phase 1.** Adding the column now means M9 doesn't need a schema migration when it lands — if M9 picks summarisation, the column's already there; if M9 picks sliding-window, the column stays NULL and we leave it. The cost of an always-NULL column is negligible; the cost of a migration on a populated `sessions` table later is the part we're avoiding.

---

## `messages`

One row per turn (user or assistant).

| Column        | Type                          | Constraints                                  | Notes                                                  |
|---------------|-------------------------------|----------------------------------------------|--------------------------------------------------------|
| `id`          | `BIGINT UNSIGNED`             | PK, AUTO_INCREMENT                           |                                                        |
| `session_id`  | `BIGINT UNSIGNED`             | NOT NULL, FK → `sessions.id` ON DELETE CASCADE |                                                      |
| `role`        | `ENUM('user','assistant')`    | NOT NULL                                     | No `system` — system blocks reconstructed per request. |
| `content`     | `TEXT`                        | NOT NULL                                     |                                                        |
| `created_at`  | `DATETIME`                    | NOT NULL, DEFAULT CURRENT_TIMESTAMP          |                                                        |

Indexes:
- `(session_id, created_at)` — ordered load by session. Composite covers the `GET /messages` query.

**No `website_id` on `messages`.** It's derivable via `session_id → sessions.website_id`. Denormalising would buy us nothing because every messages query is already scoped to one session.

---

## Indexing summary

| Lookup                                    | Table              | Index used                  |
|-------------------------------------------|--------------------|-----------------------------|
| Resolve origin → website                  | `website_origins`  | UNIQUE `origin`             |
| Resolve session token → session + website | `sessions`         | UNIQUE `token`              |
| Load full conversation for a session      | `messages`         | `(session_id, created_at)`  |
| List sessions for a website (M7 CLI)      | `sessions`         | `(website_id, last_active_at)` |
| Retention sweep (M13)                     | `sessions`         | `(website_id, last_active_at)` (same) |

Every Phase 1 hot path is index-covered. No table scans expected.

---

## Deferred / future

- **M9 trimming.** Either uses the existing `sessions.summary` column (if summarisation wins) or no schema change (if sliding-window wins).
- **M11 rate limiting.** Counters live in Redis, not MariaDB.
- **M13 retention.** Adds a config value (probably in `.env`) for "delete sessions inactive for N days." Driven by the `last_active_at` index already in place.
- **API keys (Phase 2).** New `api_keys` table when a server-to-server caller appears. Out of scope here.
- **Provider registry is NOT a table.** The list of LLM providers lives in a host-side TOML file with mode `0600`, not in MariaDB — secrets stay on the host. See [`03-llm-providers.md`](03-llm-providers.md).

---

## Migration order

1. `websites`
2. `website_origins` (FK depends on 1)
3. `sessions` (FK depends on 1)
4. `messages` (FK depends on 3)

M2 lands migrations 1–2. M3 lands 3–4.
