# `chat` — interactive test client

`./bin/chat` is a small terminal client that talks to a running site-walker API the same way a browser would: it asks for a session token by `Origin` allowlist, then loops on `POST /chat`. It exists so the loop can be exercised end-to-end without a browser or the WordPress widget.

## Prerequisites

- A chatbot registered and configured per [`cli-sw.md`](cli-sw.md): origin allowlisted, model set, and (if you've set one) `model_context_window` declared.
- The API server running on the host/port `./bin/chat` will reach. The conventional development binding is `127.0.0.1:47830`; override with `$HOST` / `$PORT` in `.env`, or the `--host` / `--port` flags.
- The backing LLM reachable from the API (Ollama on the LAN for self-hosters; OpenRouter / Anthropic for the metered path).

## Synopsis

```
./bin/chat [options] <slug>
```

| Argument / option | Description                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------- |
| `<slug>`          | Website slug to chat against. Must be registered.                                           |
| `--origin <url>`  | `Origin` header to send. Defaults to the chatbot's first allowlisted origin (DB lookup).    |
| `--host <host>`   | API host. Defaults to `$HOST`, then `127.0.0.1`.                                            |
| `--port <port>`   | API port. Defaults to `$PORT`, then `47830`.                                                |

If `--origin` is omitted and the slug has no allowlisted origins, the command refuses with a hint to run `sw chatbot origins add`.

## What it does

1. Connects directly to MariaDB to resolve the chatbot (and, if needed, its first allowlisted origin).
2. `POST /sessions` to the API with the chosen `Origin` header. Prints the server's `welcome_message`.
3. Loops: read a line of input → `POST /chat` with the bearer session token → print the assistant's `reply`.

The client itself doesn't reproduce any auth logic — the API is doing the work. `./bin/chat` is just a thin terminal wrapper around two HTTP calls.

## Example session

```
$ ./bin/chat acme-corp
connecting to http://127.0.0.1:47830 as origin https://www.acme-corp.example (slug=acme-corp)
Hi! How can I help?
> What does Acme sell?
Acme sells modular widget assemblies for industrial automation lines.
> What's a typical lead time?
Lead times are 4–6 weeks for stock configurations; bespoke runs are quoted on request.
> /quit
$
```

`connecting to ...` is printed to stderr so it's easy to spot when redirecting stdout to a file.

## Exiting

| Input        | Effect                                                                 |
| ------------ | ---------------------------------------------------------------------- |
| `/quit`      | Exit cleanly.                                                          |
| `/exit`      | Same as `/quit`.                                                       |
| EOF (Ctrl-D) | Exit cleanly.                                                          |
| Ctrl-C       | Interrupt — terminates immediately. The in-flight turn is not aborted on the server; the user message is already persisted and the assistant reply will still be written when the model returns. |

## Error responses

The client stays in the loop on non-2xx HTTP responses and prints the API's error code and any `detail` payload. Typical responses you'll see:

| Status | Error code            | Cause                                                                                                          |
| ------ | --------------------- | -------------------------------------------------------------------------------------------------------------- |
| 400    | `message_required`    | Empty / whitespace-only input. (The client filters these client-side too — you shouldn't normally see it.)     |
| 400    | `message_too_long`    | Input exceeds 8000 characters.                                                                                 |
| 401    | `invalid_token`       | Session token was rejected. The session may have been deleted; restart `./bin/chat` to mint a fresh one.        |
| 402    | `budget_exhausted_daily` | The chatbot's daily USD spend cap has been reached. Wait until the next UTC midnight, raise the cap, or accept that no more chats can run today. `detail` carries `cap_usd` and `spend_usd`. |
| 413    | `context_overflow`    | System blocks + history + new message exceeds the chatbot's `model_context_window` with headroom. Trim blocks, raise the window, or end the conversation and start a fresh session. |
| 502    | `model_error`         | The upstream LLM call failed (network error, model not loaded, etc.). The user message stays in the audit log; no assistant row was written. |
| 503    | `model_not_configured`| The chatbot has no `model_slug`. Run `sw chatbot set-model`.                                                   |

When a chatbot has a per-session USD cap configured and the cap is reached, the API doesn't return an error — it returns a normal `200` reply alongside `session_terminated: true`. `./bin/chat` doesn't surface that flag today; it just prints the reply. Subsequent turns return the chatbot's `HANDOFF_HARD.md` content (or a built-in fallback) verbatim, with no upstream LLM call.

A successful response prints just the assistant's reply; the client doesn't echo your own input or print the message ID. The full conversation is queryable via `GET /messages`.

## Caveats

- `./bin/chat` reads MariaDB at startup to resolve the chatbot and (optionally) its first allowlisted origin. It is **not** suitable for use outside the host the database lives on; this is a local development tool, not a remote client.
- The client does not stream tokens. Each turn waits for the full reply before returning the prompt. For small models this is usually fast enough; larger models or cold loads can take many seconds.
- There is no readline history persistence — up-arrow works within a session, but exiting drops the buffer.

## See also

- [`cli-sw.md`](cli-sw.md) — register and configure the chatbot before chatting to it.
- [`system-blocks.md`](system-blocks.md) — what the model is being shown alongside the user's input.
