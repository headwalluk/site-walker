# `sw` — site-walker admin CLI

`./bin/sw` is the operator's CLI for everything that doesn't go through the HTTP API: registering websites, managing their origin allowlist, choosing models, inspecting system blocks and the provider registry.

It connects to the same MariaDB and reads the same `site-walker.toml` as the running API server, so its scope is the host it runs on.

## Prerequisites

- A reachable MariaDB with the schema migrated (`npm run migrate`).
- A `.env` with `DB_*` populated (see [`env.md`](env.md)).
- A `site-walker.toml` with at least one provider for any `sw website set-model` / `sw provider list` use (see [`site-walker-toml.md`](site-walker-toml.md)).

The API server doesn't need to be running for `sw` to work — it operates directly against the database and the on-disk config.

## Synopsis

```
./bin/sw [-V|--version] [-h|--help] <command> [<args>...]
```

Top-level commands:

| Command    | Purpose                                               |
| ---------- | ----------------------------------------------------- |
| `website`  | manage websites and their per-tenant configuration    |
| `provider` | inspect the TOML-defined provider registry            |
| `blocks`   | inspect a website's assembled system blocks           |
| `sessions` | read-only browse over sessions and their messages     |

---

## `sw website`

### `sw website create <slug> [--name <name>]`

Register a new website. The `slug` must be 1–64 lowercase alphanumeric + hyphens, not starting or ending with a hyphen. `--name` defaults to the slug. The website's `persona` is seeded from `templates/PERSONA.md`.

```
$ ./bin/sw website create acme-corp --name "Acme Corp"
Created website: id=2 slug=acme-corp name="Acme Corp"
Persona seeded from templates/PERSONA.md (1024 chars).
```

### `sw website list`

List every registered website with slug, name, configured model (or `(unset)`), and origin count.

```
$ ./bin/sw website list
slug           name          model                         origins
acme-corp      Acme Corp     cortex/qwen2:1.5b             2
devx-headwall  Headwall Dev  (unset)                       1
```

### `sw website show <slug>`

Dump the full DB row for a website as JSON. Useful for confirming exact persona text, parameters, timestamps.

```
$ ./bin/sw website show acme-corp
{
  "id": 2,
  "slug": "acme-corp",
  "name": "Acme Corp",
  "welcome_message": null,
  "persona": "You are a friendly pre-sales assistant ...",
  "model_slug": "cortex/qwen2:1.5b",
  "model_parameters": null,
  "model_context_window": 4096,
  "created_at": "2026-05-17T10:00:00.000Z",
  "updated_at": "2026-05-17T10:05:00.000Z"
}
```

### `sw website delete <slug> -f|--force`

Hard-delete a website and everything that references it via FK CASCADE: origins, sessions, messages. **Irreversible** — `--force` is required.

```
$ ./bin/sw website delete acme-corp --force
Deleted website slug="acme-corp". Cascaded: 2 origin(s), 17 session(s), 84 message(s).
```

Without `--force` the command refuses and prints a one-line explainer.

### `sw website set-welcome <slug> <message>`

Set the welcome message returned by `POST /sessions`. Pass the empty string to clear it; the route then falls back to its built-in default (`Hi! How can I help?`).

```
$ ./bin/sw website set-welcome acme-corp 'Welcome to Acme — what can we help with?'
Set welcome_message for slug="acme-corp" (40 chars).

$ ./bin/sw website set-welcome acme-corp ''
Cleared welcome_message for slug="acme-corp" (falls back to default).
```

### `sw website origins {list,add,remove} <slug> [...]`

Manage a website's origin allowlist. `add` and `remove` modify the list; `list` prints what's there.

```
$ ./bin/sw website origins list acme-corp
id  origin
 3  https://www.acme-corp.example
 4  https://acme-corp.example

$ ./bin/sw website origins add acme-corp https://shop.acme-corp.example
Added origin id=5 origin="https://shop.acme-corp.example" to website slug="acme-corp"

$ ./bin/sw website origins remove acme-corp 5
Removed origin id=5 origin="https://shop.acme-corp.example" from slug="acme-corp"

$ ./bin/sw website origins remove acme-corp https://acme-corp.example
Removed origin id=4 origin="https://acme-corp.example" from slug="acme-corp"
```

`remove` accepts either the numeric `website_origins.id` (as printed by `list`) or the origin URL. URL matching uses the same normalisation as `add` (lower-case host, no trailing slash) so casing/slash differences don't trip you up.

Notes:

- An origin can belong to one website at a time (unique constraint).
- HTTPS and HTTP are both accepted; in production you almost certainly want HTTPS only.
- The visitor's browser sends the `Origin` header on `POST /sessions`; the server rejects with `403 origin_not_allowed` if it isn't on the website's list.

### `sw website add-origin <slug> <origin>` *(alias)*

Equivalent to `sw website origins add <slug> <origin>`. Kept for back-compat with earlier milestones; prefer the `origins add` form in new docs and scripts.

### `sw website set-persona <slug> <persona-text>`

Replace the website's persona text. The persona is the first `<block name="PERSONA">` the model sees; see [`system-blocks.md`](system-blocks.md).

```
$ ./bin/sw website set-persona acme-corp 'You are Acme Corp'\''s pre-sales assistant...'
Updated persona for slug="acme-corp" (137 chars).
```

For anything longer than a line or two, edit `templates/PERSONA.md` (or a per-site copy) and pipe it in:

```
$ ./bin/sw website set-persona acme-corp "$(cat data/websites/acme-corp/persona.md)"
```

### `sw website set-model <slug> <provider/model>`

Point the website at a `provider/model` slug. The provider part is looked up in `site-walker.toml`; if it's missing, the command refuses and lists known providers.

```
$ ./bin/sw website set-model acme-corp cortex/qwen2:1.5b
Set model_slug="cortex/qwen2:1.5b" for website slug="acme-corp".
```

The model string is opaque to the CLI — typos surface on the first chat request, not here.

### `sw website set-parameters <slug> <json>`

Set normalised model parameters as a JSON object. Validated against a strict Zod schema; unknown keys and out-of-range values are rejected.

Supported keys:

| Key           | Type            | Range / shape       |
| ------------- | --------------- | ------------------- |
| `temperature` | number          | `[0, 2]`            |
| `top_p`       | number          | `[0, 1]`            |
| `max_tokens`  | positive int    | `>= 1`              |
| `stop`        | array of string | any                 |

```
$ ./bin/sw website set-parameters acme-corp '{"temperature":0.4,"max_tokens":512}'
Set model_parameters for website slug="acme-corp": {"temperature":0.4,"max_tokens":512}
```

Pass `'{}'` to clear them.

### `sw website set-context-window <slug> <tokens>`

Set the website's declared model context window, in tokens. Must be a positive integer.

```
$ ./bin/sw website set-context-window acme-corp 4096
Set model_context_window=4096 for slug="acme-corp".
```

This is the figure the `POST /chat` budget check refers to. The check refuses the request with `413 context_overflow` when `system + history + new user` tokens plus a headroom (12.5% of the window, 512-token floor) exceeds the window. Leave it unset (NULL) to skip the check entirely.

### `sw website show-model <slug>`

Resolve the website's configured model against the registry and print the result.

```
$ ./bin/sw website show-model acme-corp
Website: acme-corp
  model_slug:           cortex/qwen2:1.5b
  provider:             cortex (ollama-native)
  model:                qwen2:1.5b
  parameters:           {"temperature":0.4,"max_tokens":512}
  model_context_window: 4096
```

Fails with a clear error if `model_slug` references a provider that isn't in `site-walker.toml`.

---

## `sw provider`

### `sw provider list`

List the providers parsed from `site-walker.toml`. `api_key` values are **never** printed.

```
$ ./bin/sw provider list
Provider registry (/home/op/site-walker/site-walker.toml):
  cortex               protocol=ollama-native base_url=http://cortex.local:8000 is_local=true
  laptop               protocol=ollama-native base_url=http://laptop.local:11434 is_local=true
```

The path printed is the resolved config path — useful for confirming which copy of the TOML was loaded when multiple search paths could match. Search-path precedence is documented in [`site-walker-toml.md`](site-walker-toml.md).

---

## `sw blocks`

### `sw blocks list <slug>`

Print the website's assembled system blocks with per-block token estimates and a total. The persona (if set) appears first; remaining blocks are loaded from `data/websites/<slug>/*.md` in lexicographic filename order. See [`system-blocks.md`](system-blocks.md).

```
$ ./bin/sw blocks list acme-corp
Blocks for slug="acme-corp":
  PERSONA               ~342 tokens
  10-overview           ~480 tokens
  20-pricing            ~612 tokens
  30-faq                ~890 tokens
Total estimated tokens (including handling rule): ~2441
```

Tokens are estimated as `ceil(chars / 3)` — quick and cheap, not exact. Use the total to size-check against a website's `model_context_window` before going live.

---

## `sw sessions`

Read-only browse over the session log. Useful for spot-checking what visitors have been saying during development. M13 will bring a richer review surface (filtering, redaction, retention); these commands are the dev-time slice of that.

### `sw sessions list [--website <slug>] [--limit <n>]`

List sessions, most-recently-active first. Defaults to 20 rows; `--limit` is capped at 200.

```
$ ./bin/sw sessions list --limit 3
 id  website          token (prefix)     msgs  last_active
331  bullfix-fixings  241ae15bf2220e75…     5  2026-05-17T15:10:42.000Z
282  bullfix-fixings  1de6f38b6bdfda59…     8  2026-05-17T14:59:59.000Z
281  bullfix-fixings  14d36acd82babc42…     6  2026-05-17T14:43:41.000Z

$ ./bin/sw sessions list --website devx-headwall --limit 2
 id  website        token (prefix)     msgs  last_active
280  devx-headwall  25b3f834f7eea800…    10  2026-05-17T14:19:19.000Z
279  devx-headwall  98c2930d3a4b9d9a…     4  2026-05-17T13:35:56.000Z
```

The token prefix is the first 16 characters with an ellipsis — enough to spot the session you're after, never enough to be worth copying as auth.

### `sw sessions show <token-or-id>`

Print a single session's metadata followed by its full message log. The argument is either the numeric `sessions.id` (digits only) or the full session token (64 hex chars).

```
$ ./bin/sw sessions show 280
Session 280 (website "devx-headwall"):
  token:          25b3f834f7eea8003f02e354e974e46bf6a51a19b484385dfdd5064ad3b24f12
  created_at:     2026-05-17T13:41:04.000Z
  last_active_at: 2026-05-17T14:19:19.000Z
  summary:        (none)
  messages:       10

Messages:
  [161] 2026-05-17T13:41:07.000Z user: Hi again
  [162] 2026-05-17T13:41:18.000Z assistant: Hello! How can I assist you today?
  ...
```

Multi-line message bodies are indented under the header line so they read cleanly in a terminal.

---

## Exit codes

| Code | Meaning                                                      |
| ---- | ------------------------------------------------------------ |
| `0`  | success                                                      |
| `1`  | not-found (`show`, `show-model`, `blocks list` on a missing slug) |
| `1`  | validation failure (bad JSON, unknown provider, etc.) — the underlying error is printed to stderr |

`commander.js` itself returns non-zero for unknown commands and bad arguments.

## See also

- [`cli-chat.md`](cli-chat.md) — interactive test client that drives a configured website end-to-end.
- [`site-walker-toml.md`](site-walker-toml.md) — provider registry file the model commands depend on.
- [`env.md`](env.md) — the `.env` file the CLI reads to find MariaDB.
- [`system-blocks.md`](system-blocks.md) — how persona + disk blocks are assembled into the system prompt.
