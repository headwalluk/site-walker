# `.env` — environment file

`.env` holds the database password and a handful of operator-tunable runtime settings. It's the second piece of operator-edited config alongside [`site-walker.toml`](site-walker-toml.md).

A template ships at [`.env.example`](../.env.example) — copy to `.env` and edit.

## Location

`.env` lives in the project root. Both the API server (`npm start` / `npm run dev`) and the CLI tools (`./bin/sw`, `./bin/chat`) read it on startup via Node's `--env-file-if-exists=.env` flag or `process.loadEnvFile('.env')` in the bin shims.

`.env` is **gitignored**. Do not commit it.

If `.env` is absent the process still starts, but every variable it would set has to come from the surrounding shell instead.

## Permission gate

The file must be mode `0600` (owner read/write, nobody else). `DB_PASSWORD` is a secret; same threat model as `site-walker.toml`. A looser mode is rejected at startup:

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
| `SW_CONFIG`   | (unset)        | API, CLIs             | Override path for `site-walker.toml`. When set, the loader skips the four-path search. Still subject to the 0600 gate. See [`site-walker-toml.md`](site-walker-toml.md). |

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
```

## Notes

- `PORT` defaults to `47830` rather than 3000/8080/etc. on purpose — the dev host typically has many services bound and the conventional ports are usually taken. Pick another obscure port if `47830` is also in use on your box.
- The DB schema is owned by `knex`. Use `npm run migrate` to apply migrations, `npm run migrate:rollback` to walk back. Never edit schema by hand.
- Switching `DB_NAME` is the right way to spin up a parallel dev / test database; the schema is small enough that migrations replay instantly.

## See also

- [`site-walker-toml.md`](site-walker-toml.md) — the other operator-edited config file (LLM providers).
- [`cli-sw.md`](cli-sw.md) — the CLI tools that read `.env` to find MariaDB.
- [`.env.example`](../.env.example) — copyable starting point.
