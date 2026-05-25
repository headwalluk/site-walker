# `.env` — environment file

`.env` holds the database password, the master encryption key for chatbot BYO API keys, and a handful of operator-tunable runtime settings.

A template ships at [`.env.example`](../.env.example) — copy to `.env` and edit.

## Location

`.env` lives in the project root. Both the API server (`npm start` / `npm run dev`) and the CLI tools (`./bin/sw`, `./bin/chat`) read it on startup via Node's `--env-file-if-exists=.env` flag or `process.loadEnvFile('.env')` in the bin shims.

`.env` is **gitignored**. Do not commit it.

If `.env` is absent the process still starts, but every variable it would set has to come from the surrounding shell instead.

## Permission gate

The file must be mode `0600` (owner read/write, nobody else). `DB_PASSWORD` and `SW_ENCRYPTION_KEY` are secrets. A looser mode is rejected at startup:

```
Env file .env must be mode 0600 (currently 0644).
Run: chmod 0600 .env
```

The gate is enforced in three places:

- `src/index.ts` — at API server startup, before any network bind.
- `src/cli/sw.ts` and `src/cli/chat.ts` — at CLI startup.
- `knexfile.js` — inlined at the top, so `npm run migrate` (and other knex CLI commands) check it too.

If the file does not exist, the gate is a no-op.

## Variables

| Variable      | Default        | Used by               | Meaning                                                                                       |
| ------------- | -------------- | --------------------- | --------------------------------------------------------------------------------------------- |
| `DB_HOST`     | `127.0.0.1`    | API, CLIs, migrations | MariaDB host.                                                                                 |
| `DB_PORT`     | `3306`         | API, CLIs, migrations | MariaDB port.                                                                                 |
| `DB_USER`     | `site_walker`  | API, CLIs, migrations | MariaDB user.                                                                                 |
| `DB_PASSWORD` | (empty)        | API, CLIs, migrations | MariaDB password. **Required in any non-trivial setup.**                                      |
| `DB_NAME`     | `site_walker`  | API, CLIs, migrations | MariaDB database name.                                                                        |
| `HOST`        | `127.0.0.1`    | API server, `./bin/chat` | Bind address for the API. `./bin/chat` uses it as the default for its outbound HTTP target. |
| `PORT`        | `47830`        | API server, `./bin/chat` | Bind port for the API. **Avoid common defaults (3000, 8000, 8080, etc.).** `PORT+1` is reserved for any future port-bound test server. |
| `SW_ENCRYPTION_KEY` | (unset) | API server, CLIs (when setting chatbot BYO keys) | Base64-encoded 32-byte master key for AES-256-GCM encryption of `chatbots.provider_api_key_*`. Generate with `./bin/sw secrets gen-key`. **Required for the API server to boot** — startup fails loud if missing or wrong length. CLI commands that don't touch BYO keys (most of them) don't read this. |
| `NODE_ENV`    | `production`   | API server            | Set to `development` (or any value other than `production`) to relax production-only safety defaults. Today the only behaviour gated on this is geo-blocking's null-country handling: in production an unresolvable IP is denied, in development it's allowed (so localhost / private ranges keep working). **Default is `production`** — the tighter mode kicks in unless you explicitly opt out. |
| `GEOIP_DB_PATH` | (unset)      | API server            | Filesystem path to a MaxMind GeoIP2 / GeoLite2 country database (`.mmdb`). When set, geo-blocking is available; when unset, only `allowall` mode is supported. **If any chatbot is configured with `blocklist` or `allowlist` and this var is unset (or the file can't be opened), the server refuses to start.** Typical value: `/var/lib/GeoIP/GeoLite2-Country.mmdb`. |
| `SW_MAX_DAILY_BUDGET_USD` | `10000` | API server, CLI       | Hard upper bound on `chatbots.daily_budget_usd`. The admin PATCH endpoint and `./bin/sw chatbot set-budget` refuse to set a value above this with `validation_failed`. Catches typos (`250` vs `25.0`) and limits the blast radius of a stolen admin key. Raise it only if you actually need higher caps. |
| `SW_MAX_SESSION_BUDGET_USD` | `100` | API server, CLI       | Same as `SW_MAX_DAILY_BUDGET_USD` but for `chatbots.session_budget_usd` (per-conversation cap). **Also bounds `chatbots.admin_session_budget_usd` (M21 admin-mode session cap)** — the two share this env cap, since they're the same kind of constraint applied to different columns. Default of $100 is well above any sensible single-conversation spend; raise it only if a legitimate use case warrants. |
| `SW_RATELIMIT_ENABLED` | `true` | API server | Master switch for the M23 rate-limit subsystem. Set to `false` (or `0` / `no`) in dev/test to take both per-IP and per-chatbot limits offline. Accepted truthy values: `true` / `1` / `yes`; falsy: `false` / `0` / `no`. Anything else is a startup error. |
| `SW_RATELIMIT_SESSIONS_PER_IP_PER_MINUTE` | `10` | API server | Per-IP cap on `POST /sessions` (60-second fixed window). A real visitor mints once per page-load and the default leaves plenty of headroom; tune up only if you're seeing legitimate 429s from real traffic. `GET /sessions/can-start` is **not** rate-limited (idempotent probe). |
| `SW_RATELIMIT_SESSIONS_PER_CHATBOT_PER_MINUTE` | `60` | API server | Per-chatbot cap on `POST /sessions`. Catches the case where many different IPs are minting against one chatbot — a single per-IP limit can't bound that. A successful pre-sales bot may burst above the default during peak hours; raise it if real traffic warrants. |
| `SW_RATELIMIT_CHAT_PER_IP_PER_MINUTE` | `20` | API server | Per-IP cap on `POST /chat`. A real visitor types ~5 turns/min; 20 leaves a 4× margin. |
| `SW_RATELIMIT_CHAT_PER_CHATBOT_PER_MINUTE` | `120` | API server | Per-chatbot cap on `POST /chat`. Two chat turns per second sustained — generous for first-customer scale. Budget caps remain the real backstop on cost; this catches request-rate abuse before it pays out. |

Unrecognised variables are ignored; environment is shared with anything else running on the host, and we don't filter it.

## Example

```
# HTTP server
PORT=47830
HOST=127.0.0.1

# MariaDB
DB_HOST=127.0.0.1
DB_PORT=3306
DB_NAME=site_walker
DB_USER=site_walker
DB_PASSWORD=change-me-please

# Master encryption key for chatbot BYO LLM provider API keys.
# Generate with: ./bin/sw secrets gen-key
SW_ENCRYPTION_KEY=paste-base64-32-bytes-here

# Set this if you have at least one chatbot using geo-blocking.
# Typical value on a Debian-family host with MaxMind packages installed:
# GEOIP_DB_PATH=/var/lib/GeoIP/GeoLite2-Country.mmdb

# Set NODE_ENV=development to allow private/loopback IPs through the
# geo-blocking check. The default is production, which denies them.
# NODE_ENV=development

# M23 rate limiting — defaults shown. Per-minute fixed-window caps.
# Set SW_RATELIMIT_ENABLED=false to take the whole subsystem offline
# (handy in dev/test). Tune the caps based on real traffic data; the
# defaults are conservative.
# SW_RATELIMIT_ENABLED=true
# SW_RATELIMIT_SESSIONS_PER_IP_PER_MINUTE=10
# SW_RATELIMIT_SESSIONS_PER_CHATBOT_PER_MINUTE=60
# SW_RATELIMIT_CHAT_PER_IP_PER_MINUTE=20
# SW_RATELIMIT_CHAT_PER_CHATBOT_PER_MINUTE=120

# M23.5 acceptance-testing sim hooks — see the SW_SIM_* section below
# and the docs/env.md "Acceptance testing only" entry. Forbidden in
# production. Examples:
# SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS=5
# SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS=7
```

## Acceptance testing only — the `SW_SIM_*` namespace

The `SW_SIM_*` prefix is reserved for **acceptance-testing simulation hooks**. These let a developer force scenarios that would otherwise need expensive setup (real budget thresholds, real GeoIP databases, real rate-limit pressure). Today only the handoff hooks exist; future additions land under the same prefix.

**Production refusal.** If `NODE_ENV=production` and **any** `SW_SIM_*` var is set, the server refuses to boot and names the offending key(s). The whole namespace is caught by one boot-time check, so future additions inherit the same safety rail. To run under sim semantics, set `NODE_ENV=development` (or `staging` / `test` — anything other than `production`).

**Visibility.** When at least one `SW_SIM_*` var is set (or `opts.sim` is passed via `buildServer` in a test), `GET /health` includes `sim_active: true` in its response — only in non-production. In production the field is omitted entirely.

### Handoff sim (M23.5)

| Variable                                  | Used by | Meaning |
|-------------------------------------------|---------|---------|
| `SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS`    | API server | Positive integer. When set, the soft-handoff `HANDOFF_SOFT.md` system block is injected into the next `POST /chat` whenever the session has reached this many user-role messages (counting the incoming one), regardless of session spend. The real spend-based trigger still applies in parallel — whichever fires first wins. Admin-mode sessions still suppress (M21 semantics preserved). Unset → no sim (the real spend trigger is the only one). |
| `SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS`    | API server | Positive integer. When set, the session is hard-terminated (`session_terminated: true`, canned response on subsequent turns, handoff webhook fired) after this many user-role messages. Real spend-based hard cap still applies in parallel. Admin-mode terminates but suppresses the webhook, same as the real path. The M23.6 final-turn wind-down hint (`HANDOFF_FINAL` block) fires automatically on the turn that hits this threshold, telling the LLM to conclude without a follow-up question. |

**Sanity guard:** if both are set and `SOFT >= HARD`, the server refuses to boot. Soft is supposed to nudge before hard cuts off; nonsense ordering would mask the soft path entirely.

Typical use: `SW_SIM_SOFT_HANDOFF_AFTER_USER_TURNS=5 SW_SIM_HARD_HANDOFF_AFTER_USER_TURNS=7 NODE_ENV=development npm run dev`, then chat through the widget for 5+ turns to see the soft inject; 7+ turns to see the hard termination.

## Notes

- `PORT` defaults to `47830` rather than 3000/8080/etc. on purpose — the dev host typically has many services bound and the conventional ports are usually taken. Pick another obscure port if `47830` is also in use on your box.
- The DB schema is owned by `knex`. Use `npm run migrate` to apply migrations, `npm run migrate:rollback` to walk back. Never edit schema by hand.
- Switching `DB_NAME` is the right way to spin up a parallel dev / test database; the schema is small enough that migrations replay instantly.

## See also

- [`cli-sw.md`](cli-sw.md) — the CLI tools that read `.env` to find MariaDB. Covers `sw secrets gen-key` (generates the value to paste for `SW_ENCRYPTION_KEY`) and `sw chatbot set-api-key` (the encryption-using flow).
- [`.env.example`](../.env.example) — copyable starting point.
