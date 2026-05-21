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
| `GEOIP_DB_PATH` | (unset)      | API server            | Filesystem path to a MaxMind GeoIP2 / GeoLite2 country database (`.mmdb`). When set, geo-blocking is available; when unset, only `allowall` mode is supported. **If any website is configured with `blocklist` or `allowlist` and this var is unset (or the file can't be opened), the server refuses to start.** Typical value: `/var/lib/GeoIP/GeoLite2-Country.mmdb`. |
| `SW_MAX_DAILY_BUDGET_USD` | `10000` | API server, CLI       | Hard upper bound on `chatbots.daily_budget_usd`. The admin PATCH endpoint and `./bin/sw chatbot set-budget` refuse to set a value above this with `validation_failed`. Catches typos (`250` vs `25.0`) and limits the blast radius of a stolen admin key. Raise it only if you actually need higher caps. |
| `SW_MAX_SESSION_BUDGET_USD` | `100` | API server, CLI       | Same as `SW_MAX_DAILY_BUDGET_USD` but for `chatbots.session_budget_usd` (per-conversation cap). Default of $100 is well above any sensible single-conversation spend; raise it only if a legitimate use case warrants. |

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

# Set this if you have at least one website using geo-blocking.
# Typical value on a Debian-family host with MaxMind packages installed:
# GEOIP_DB_PATH=/var/lib/GeoIP/GeoLite2-Country.mmdb

# Set NODE_ENV=development to allow private/loopback IPs through the
# geo-blocking check. The default is production, which denies them.
# NODE_ENV=development
```

## Notes

- `PORT` defaults to `47830` rather than 3000/8080/etc. on purpose — the dev host typically has many services bound and the conventional ports are usually taken. Pick another obscure port if `47830` is also in use on your box.
- The DB schema is owned by `knex`. Use `npm run migrate` to apply migrations, `npm run migrate:rollback` to walk back. Never edit schema by hand.
- Switching `DB_NAME` is the right way to spin up a parallel dev / test database; the schema is small enough that migrations replay instantly.

## See also

- [`cli-sw.md`](cli-sw.md) — the CLI tools that read `.env` to find MariaDB. Covers `sw secrets gen-key` (generates the value to paste for `SW_ENCRYPTION_KEY`) and `sw chatbot set-api-key` (the encryption-using flow).
- [`.env.example`](../.env.example) — copyable starting point.
