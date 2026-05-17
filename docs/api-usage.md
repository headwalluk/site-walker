# Browser API usage — chat flow

This doc walks a browser-side widget developer (the WordPress plugin in our case, but it applies to anything talking from a browser) through the full lifecycle of a chat conversation: minting a session, sending turns, rehydrating on page reload, and handling errors gracefully.

For the reference shape of every endpoint, the live OpenAPI spec is at `/openapi.json` and a Swagger UI is at `/docs`. This doc is the narrative companion — what the spec doesn't tell you on its own is how the three endpoints fit together.

## Audience

Anyone embedding a chat widget that calls a site-walker instance. Examples are JavaScript using the browser `fetch()` API. The widget runs **in the visitor's browser** — there's no PHP / Node middle layer, and you don't proxy through your own backend. The chat API is designed to be called directly from the visitor's tab.

## The chat flow at a glance

A widget has three things to do:

1. **On page load** — get (or restore) a session and display the welcome message or restored history.
2. **On each user turn** — POST the message, render the assistant's reply.
3. **On page reload** — restore the session from `localStorage`, rehydrate the conversation from the server.

Three endpoints cover this:

| Endpoint               | Method | Purpose                                                             |
| ---------------------- | ------ | ------------------------------------------------------------------- |
| `/sessions/preflight`  | GET    | Probe whether a session *could* be minted — no token issued.        |
| `/sessions`            | POST   | Mint a session token. Returns the welcome message too.              |
| `/chat`                | POST   | Send one user turn. Returns the assistant's reply.                  |
| `/messages`            | GET    | Rehydrate full conversation history for an existing session.        |

The base URL in development is `http://127.0.0.1:47830`. In production the instance lives at `https://api.site-walker.net` (or wherever the operator has deployed it).

## Prerequisites — operator setup

Before any widget loads, the operator running the site-walker instance has done four things via `./bin/sw`:

1. Registered a website (`sw website create <slug>`).
2. Added the widget's host as an allowed origin (`sw website origins add <slug> https://www.example.com`).
3. Pointed the website at an LLM (`sw website set-model <slug> openrouter/anthropic/claude-haiku-4.5`, or similar).
4. Optionally set a welcome message (`sw website set-welcome <slug> "Hi! How can I help?"`).

The first one of these the widget cares about is the **origin allowlist**. The browser sends an `Origin` header on requests automatically; site-walker accepts the session-creation request only if that `Origin` matches one of the website's registered origins. If you see `403 origin_not_allowed`, the operator hasn't added your host yet.

## Endpoint reference

### `GET /sessions/preflight` — "can I start a session?"

A lightweight probe with the same auth + geo policy as `POST /sessions`, but it mints nothing and persists nothing. Use it on widget mount to decide whether to show a chat affordance at all.

```http
GET /sessions/preflight
Origin: https://www.acme-corp.example
```

**Success (200):**

```json
{ "ok": true }
```

**Failure shapes:** identical to `POST /sessions` minus the success body — `400 origin_required`, `403 origin_not_allowed`, `403 geo_blocked`, `503 capacity_exceeded`.

If preflight returns 200, a subsequent `POST /sessions` from the same browser will almost certainly succeed too. (Almost — the operator could change the policy between the two calls. Don't treat preflight as a guarantee, just an early signal.)

### `POST /sessions` — mint a session

```http
POST /sessions
Origin: https://www.acme-corp.example
```

The body is empty. The `Origin` header is set by the browser automatically; you don't add it.

**Success (201):**

```json
{
  "session_token": "e071b5ca42a16a8cdad993cee2d94a070960206f46b94506fc885d33250c661c",
  "welcome_message": "Hi! How can I help?"
}
```

The token is opaque, 64 hex characters, and has no client-side expiry concept today. Treat it as long-lived; the server may revoke it (see `401 invalid_token` below).

**Failure shapes (all `{ "error": "<code>" }`):**

| Status | `error` value         | Meaning                                                                          |
| ------ | --------------------- | -------------------------------------------------------------------------------- |
| 400    | `origin_required`     | The browser didn't send an `Origin` header. Unusual — most browsers always do.   |
| 403    | `origin_not_allowed`  | Your host isn't on the website's allowlist. Operator action required.            |
| 403    | `geo_blocked`         | The visitor's IP is in (blocklist mode) or out of (allowlist mode) the website's country list. Hide the chat affordance for this visitor. |
| 503    | `capacity_exceeded`   | Per-IP / per-website rate limit reached. Phase 1 stub; lights up in M11.         |

### `POST /chat` — send a user turn

```http
POST /chat
Authorization: Bearer e071b5ca42a16a8cdad993cee2d94a070960206f46b94506fc885d33250c661c
Content-Type: application/json

{
  "message": "What does Acme sell?"
}
```

The message is trimmed server-side and must be between 1 and 8000 characters after trimming.

**Success (200):**

```json
{
  "reply": "Acme sells modular widget assemblies for industrial automation lines.",
  "message_id": 42,
  "tokens_used": {
    "prompt": 312,
    "completion": 18
  }
}
```

`tokens_used` is present when the model backend reports usage (OpenRouter does; some Ollama responses do too). Treat it as optional.

**Failure shapes:**

| Status | `error` value           | Meaning                                                                            |
| ------ | ----------------------- | ---------------------------------------------------------------------------------- |
| 400    | `message_required`      | Body missing, or `message` empty / whitespace-only.                                |
| 400    | `message_too_long`      | `message` exceeds 8000 chars. `detail` carries `length` and `limit`.               |
| 401    | `token_required`        | `Authorization` header missing.                                                    |
| 401    | `invalid_token`         | Token isn't recognised. Drop the cached token and mint a fresh session.            |
| 403    | `geo_blocked`           | The visitor's IP is no longer accepted by the website's geo policy (operator may have changed it mid-session). Drop the cached token; this visitor can't continue. |
| 413    | `context_overflow`      | System prompt + history + new message exceeds the website's declared context window. `detail` carries `total_prompt_tokens`, `context_window`, `headroom_tokens`. Recoverable — see "Error handling" below. |
| 502    | `model_error`           | Upstream LLM call failed (rate limit, network, etc.). Retry after a delay.         |
| 503    | `model_not_configured`  | Operator hasn't set a model for this website. Operator action required.            |

When `model_error` fires, the user's message **is still persisted** in the session log. If you retry the same turn, you'll get duplicates server-side; consider showing an error UI instead of auto-retrying.

### `GET /messages` — rehydrate

```http
GET /messages
Authorization: Bearer e071b5ca42a16a8cdad993cee2d94a070960206f46b94506fc885d33250c661c
```

**Success (200):**

```json
{
  "messages": [
    {
      "id": 41,
      "session_id": 195,
      "role": "user",
      "content": "What does Acme sell?",
      "created_at": "2026-05-17T13:41:07.000Z"
    },
    {
      "id": 42,
      "session_id": 195,
      "role": "assistant",
      "content": "Acme sells modular widget assemblies for industrial automation lines.",
      "created_at": "2026-05-17T13:41:18.000Z"
    }
  ]
}
```

Messages are ordered ascending by `created_at`. The welcome message is **not** part of this list — it's a property of the website, returned once by `POST /sessions`. If a visitor reloads the page, you'll see history without the welcome, and that's the intended behaviour.

**Failure shapes:**

| Status | `error` value     | Meaning                                                                  |
| ------ | ----------------- | ------------------------------------------------------------------------ |
| 401    | `token_required`  | Missing `Authorization`.                                                 |
| 401    | `invalid_token`   | Token isn't recognised. Drop the cached token and start over.            |
| 403    | `geo_blocked`     | The visitor's IP no longer fits the website's geo policy. Same handling as for `POST /chat` above. |

## Putting it together

### Page-load bootstrap

```js
const API_BASE = 'https://api.site-walker.net'; // or http://127.0.0.1:47830 in dev
const STORAGE_KEY = 'site-walker:session-token';

async function bootstrap() {
  const cachedToken = localStorage.getItem(STORAGE_KEY);

  if (cachedToken) {
    const res = await fetch(`${API_BASE}/messages`, {
      headers: { Authorization: `Bearer ${cachedToken}` },
    });

    if (res.ok) {
      const { messages } = await res.json();
      return { token: cachedToken, history: messages };
    }

    if (res.status === 401) {
      // Token's been revoked or the session was wiped server-side.
      localStorage.removeItem(STORAGE_KEY);
      // Fall through to mint a fresh session.
    } else {
      throw new Error(`unexpected /messages response: ${res.status}`);
    }
  }

  const res = await fetch(`${API_BASE}/sessions`, { method: 'POST' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(`POST /sessions failed: ${res.status} ${body.error ?? ''}`);
  }
  const { session_token, welcome_message } = await res.json();
  localStorage.setItem(STORAGE_KEY, session_token);

  return {
    token: session_token,
    // Welcome is rendered as the first assistant turn. It's not in the
    // server-side log; if the user reloads, they won't see it again.
    history: [{ role: 'assistant', content: welcome_message }],
  };
}
```

### Sending a turn

```js
async function sendTurn(token, userMessage) {
  const res = await fetch(`${API_BASE}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ message: userMessage }),
  });

  const body = await res.json().catch(() => ({}));

  if (!res.ok) {
    const err = new Error(body.error ?? `HTTP ${res.status}`);
    err.code = body.error;
    err.status = res.status;
    err.detail = body.detail;
    throw err;
  }

  return body; // { reply, message_id, tokens_used? }
}
```

### Wiring it up

```js
async function handleSubmit(userInput) {
  appendToUI('user', userInput);
  const spinner = showThinkingIndicator();

  try {
    const { reply } = await sendTurn(currentToken, userInput);
    appendToUI('assistant', reply);
  } catch (err) {
    if (err.code === 'invalid_token') {
      // Server forgot us. Restart cleanly.
      localStorage.removeItem(STORAGE_KEY);
      showError('Your session expired. Refreshing...');
      window.location.reload();
      return;
    }
    if (err.code === 'context_overflow') {
      showError('This conversation has gotten too long. Please start a new one.');
      // Optionally: drop the token, mint a new session.
      return;
    }
    if (err.code === 'model_error') {
      showError('We had a hiccup reaching the assistant. Try again in a moment.');
      return;
    }
    showError(`Something went wrong: ${err.message}`);
  } finally {
    spinner.hide();
  }
}
```

## Token persistence

Store the session token in **`localStorage`**, keyed per API base host so multiple widgets on the same browser don't collide:

```js
const STORAGE_KEY = `site-walker:${new URL(API_BASE).host}:session-token`;
```

Trade-offs:

- **localStorage** (recommended): persists across page reloads, tabs, and browser restarts. The conversation rehydrates via `GET /messages` next time the visitor lands on the page. Token is JavaScript-readable, but it's a session token tied to one website's allowlisted origin — not a credential that grants broader access.
- **sessionStorage**: lost on tab close. Conversations don't survive a reload-and-comeback. Probably too aggressive for a pre-sales bot the visitor might revisit.
- **Cookies**: site-walker doesn't currently set any. The session-token flow is intentionally cookie-free so there's no third-party-cookie story to manage.

If the visitor explicitly opts out of "remember this conversation" (privacy UI, GDPR consent, etc.), use `sessionStorage` or hold the token in memory only.

## Limits, gaps, and known TODOs

- **Message length cap:** 8000 characters after trimming. Enforce this in the widget too so you can give a friendly UI message instead of trusting the server's 400.
- **Single conversation per session:** one session, one growing message log. There's no "new conversation" affordance built into the API; minting a fresh session token (e.g. by clearing `localStorage` and reloading) is how you start over.
- **No streaming yet.** Each `POST /chat` is request-then-response. Show a "Thinking…" indicator during the in-flight period. Token streaming is on the roadmap.
- **CORS is not yet wired.** Today site-walker doesn't ship CORS middleware, which means cross-origin browser calls will fail at the preflight step. The chat API was designed for browser use and CORS is on the immediate punch-list; you'll need it before integration goes live. Local development from the same origin works without CORS, so you can iterate on the widget structure in the meantime.
- **No client-controllable model.** The model is set per-website by the operator; widgets can't override it per session. Comparison testing today means swapping the website's model via `sw website set-model` between conversations.
- **No retention sweep yet.** Sessions and messages persist indefinitely. M13 will add retention + privacy controls.

## See also

- [`cli-sw.md`](cli-sw.md) — the operator commands that set up a website before any widget loads.
- [`cli-chat.md`](cli-chat.md) — the terminal test client. Useful for exercising the same flow without a browser.
- [`system-blocks.md`](system-blocks.md) — what the model is actually being shown alongside the conversation. Affects answer quality, not the API surface.
- `/openapi.json` and `/docs` on a running instance — machine-readable reference + interactive Swagger UI for trying calls out.
