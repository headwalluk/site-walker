# `site-walker.toml` — provider registry

`site-walker.toml` declares the LLM providers a site-walker instance can talk to. Per-website model selection lives in the database; this file is purely the operator's view of "which backends exist on this host."

A template ships at [`templates/site-walker.toml.example`](../templates/site-walker.toml.example) — copy and edit.

## Location

The loader searches these paths in order; the **first match wins**:

1. `./site-walker.toml` (project root — development convenience)
2. `~/.site-walker/site-walker.toml` (per-user)
3. `~/.config/site-walker/site-walker.toml` (XDG)
4. `/etc/site-walker.toml` (system-wide)

To use a path outside that list, set `SW_CONFIG`:

```
SW_CONFIG=/srv/site-walker/site-walker.toml npm start
```

The override is subject to the same permission gate as the regular search paths.

`sw provider list` prints the resolved path, which is the unambiguous way to confirm which file is in effect.

## Permission gate

The file must be mode `0600` (owner read/write, nobody else). API keys live in it; a looser mode is rejected at startup with a precise fix command:

```
Config file /home/op/site-walker.toml must be mode 0600 (currently 0644).
Run: chmod 0600 /home/op/site-walker.toml
```

This applies whether the file was discovered via the search paths or `SW_CONFIG`.

## File format

TOML, parsed via `smol-toml`. The only recognised top-level table is `[providers]`. Each `[providers.<name>]` sub-table declares one backend:

```toml
[providers.<name>]
protocol = "ollama-native"        # required
base_url = "http://host:port"     # required for HTTP-backed protocols
api_key  = "sk-..."               # required for cloud protocols
is_local = true                   # optional, defaults to false
```

`<name>` is the string an operator types in a website's `model_slug` before the first `/`. Pick anything you'll recognise — `pi`, `cortex`, `laptop`, `openrouter-prod`, etc. The model string that follows the slash is opaque to site-walker and is passed verbatim to the adapter.

### Keys

| Key        | Type    | Required                              | Meaning                                                                                                                            |
| ---------- | ------- | ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `protocol` | string  | yes                                   | One of `ollama-native`, `anthropic`, `openrouter`, `openai-compatible`. See below for which are implemented.                       |
| `base_url` | string  | yes for `ollama-native`               | Where the backend lives. For Ollama, this is the host running `ollama serve` (e.g. `http://cortex.local:8000`).                    |
| `api_key`  | string  | yes for cloud providers (M8)          | Provider API key. Never printed by `sw provider list`. Never store API keys in the database.                                       |
| `is_local` | boolean | no (default `false`)                  | Marks the backend as on-network / self-hosted. M11 (rate limiting) will use this to relax limits on local traffic. Unused for now. |

Any other key is currently ignored. Unknown protocol values are rejected at startup with the list of supported values.

### Supported protocols

| Protocol            | Status                | Notes                                                                                                                          |
| ------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ollama-native`     | implemented (M5)      | `POST {base_url}/api/chat`. Tested against Ollama on Raspberry Pi (NPU) and on x86 Linux. `base_url` is required.              |
| `openrouter`        | implemented (0.9.0)   | OpenAI Chat Completions wire format. `POST {base_url}/chat/completions`. `base_url` defaults to `https://openrouter.ai/api/v1` when absent. `api_key` required. Sends `HTTP-Referer: https://site-walker.net` + `X-Title: Site Walker` for dashboard attribution. |
| `anthropic`         | planned               | Direct Anthropic Messages API. For Anthropic models today, use `openrouter` and a model slug like `openrouter/anthropic/claude-haiku-4.5`. |
| `openai-compatible` | planned               | Generic OpenAI-clone provider; reserved if a third use case arises that isn't OpenRouter.                                       |

A website pointed at an unimplemented protocol will accept `sw website set-model` (the registry has the provider) but fail at first chat request.

## Example

```toml
# self-hosted Ollama on a Raspberry Pi
[providers.cortex]
protocol = "ollama-native"
base_url = "http://cortex.local:8000"
is_local = true

# a second Ollama on a laptop, available as fallback
[providers.laptop]
protocol = "ollama-native"
base_url = "http://laptop.local:11434"
is_local = true

# Anthropic cloud (Phase 2 — uncomment when M8 lands)
# [providers.anthropic]
# protocol = "anthropic"
# api_key  = "sk-ant-api03-REPLACE-ME"
```

A website using this registry might be configured with:

```
./bin/sw website set-model acme-corp cortex/qwen2:1.5b
./bin/sw website set-context-window acme-corp 4096
```

The `cortex` part is matched against `[providers.cortex]`; the `qwen2:1.5b` part is sent to Ollama unchanged.

## Validation at startup

When the API server starts, it loads the registry and runs a sweep over the `websites` table. Any website whose `model_slug` references a provider not in the registry causes startup to fail with a clear error. This catches stale config (a provider removed from the TOML while a website still points at it) before the first request, not at chat time.

## See also

- [`cli-sw.md`](cli-sw.md) — `sw provider list`, `sw website set-model`, `sw website show-model`.
- [`env.md`](env.md) — `.env` is the other operator-edited config file; same `0600` gate.
- [`templates/site-walker.toml.example`](../templates/site-walker.toml.example) — copyable starting point with inline comments.
