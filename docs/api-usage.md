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

| Endpoint                     | Method | Purpose                                                             |
| ---------------------------- | ------ | ------------------------------------------------------------------- |
| `/sessions/can-start`        | GET    | Probe whether a session *could* be minted — no token issued.        |
| `/sessions`                  | POST   | Mint a session token. Returns the welcome message too.              |
| `/chat`                      | POST   | Send one user turn. Returns the assistant's reply.                  |
| `/messages`                  | GET    | Rehydrate full conversation history for an existing session.        |
| `/sessions/visitor-email`    | POST   | Capture a visitor email against the session (write-only — no GET).  |

The base URL in development is `http://127.0.0.1:47830`. In production the instance lives at `https://api.site-walker.net` (or wherever the operator has deployed it).

## Prerequisites — operator setup

Before any widget loads, the operator running the site-walker instance has done five things via `./bin/sw`:

1. Created an account (`sw account create <slug>`). Every chatbot belongs to exactly one account.
2. Registered a chatbot under it (`sw chatbot create <slug> --account <account-slug>`).
3. Added the widget's host as an allowed origin (`sw chatbot origins add <slug> https://www.example.com`).
4. Pointed the chatbot at an LLM (`sw chatbot set-model <slug> openrouter/anthropic/claude-haiku-4.5`, or similar).
5. Optionally set a welcome message (`sw chatbot set-welcome <slug> "Hi! How can I help?"`).

The first one of these the widget cares about is the **origin allowlist**. The browser sends an `Origin` header on requests automatically; site-walker accepts the session-creation request only if that `Origin` matches one of the chatbot's registered origins. If you see `403 origin_not_allowed`, the operator hasn't added your host yet.

## Endpoint reference

### `GET /sessions/can-start` — "can I start a session?"

A lightweight probe with the same auth + geo policy as `POST /sessions`, but it mints nothing and persists nothing. Use it on widget mount to decide whether to show a chat affordance at all.

```http
GET /sessions/can-start
Origin: https://www.acme-corp.example
```

**Success (200):**

```json
{ "ok": true }
```

**Failure shapes:** identical to `POST /sessions` minus the success body and minus the 429 — `400 origin_required`, `402 budget_exhausted_daily`, `403 origin_not_allowed`, `403 geo_blocked`, `503 chatbot_closed`. `can-start` is deliberately **not** rate-limited (it's an idempotent probe; the expensive cousin `POST /sessions` carries the per-IP + per-chatbot caps).

If the probe returns 200, a subsequent `POST /sessions` from the same browser will almost certainly succeed too. (Almost — the operator could change the policy between the two calls. Don't treat the probe as a guarantee, just an early signal.)

> **Note on the name.** This route was originally `GET /sessions/preflight`. It was renamed to `/sessions/can-start` so the word "preflight" can refer unambiguously to the browser's CORS preflight (`OPTIONS`). The two are independent: every browser-facing route below also responds to CORS preflight automatically when the request's `Origin` is registered against any chatbot.

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

| Status | `error` value             | Meaning                                                                          |
| ------ | ------------------------- | -------------------------------------------------------------------------------- |
| 400    | `origin_required`         | The browser didn't send an `Origin` header. Unusual — most browsers always do.   |
| 402    | `budget_exhausted_daily`  | The chatbot's daily USD spend cap has been reached. Hide the chat affordance for the rest of the day; minting will become available again at the next UTC midnight (or once the operator raises the cap). `detail` carries `cap_usd` and `spend_usd`. |
| 403    | `origin_not_allowed`      | Your host isn't on the chatbot's allowlist. Operator action required.            |
| 403    | `geo_blocked`             | The visitor's IP is in (blocklist mode) or out of (allowlist mode) the chatbot's country list. Hide the chat affordance for this visitor. |
| 429    | `rate_limit_exceeded`     | The caller's IP **or** the chatbot itself has hit the per-minute mint cap. `detail.retry_after_seconds` and a `Retry-After` header carry the wait time. Treat as transient: back off and try again after the window. |
| 503    | `chatbot_closed`          | The chatbot is configured with operational hours, and the request landed outside an open window. Carries `detail.next_open_at` (ISO timestamp, or `null` if the schedule has no future opening) and a `Retry-After` header (in seconds, capped at 3600). |

`GET /sessions/can-start` returns the same 402 and 503 codes in the same circumstances, so a widget that probes on mount will see the daily-cap and out-of-hours states before it tries to mint. It does **not** return 429 — only the mint path itself counts against the rate limit.

### Admin-mode sessions (M21)

A session token can also arrive via a different mint path: when a logged-in site administrator loads a page on the WordPress backend, the plugin's PHP layer mints an "admin-mode" session against the [admin API](api-admin.md) and relays the token to the browser via an Ajax response. From the widget's perspective the resulting token works on every route below the same way — same `Authorization: Bearer` header, same `/chat`, `/messages`, `/sessions/visitor-email` semantics — but there are three things a widget should know:

1. **The session response carries `is_admin_mode: true`.** Regular `POST /sessions` returns `{ session_token, welcome_message }`; the admin path additionally returns `is_admin_mode: true`. The widget will normally receive the whole envelope from the WP backend (not from this API directly), but treat any session whose envelope carries `is_admin_mode: true` as a power-user session.
2. **The welcome message is prefixed with `**Admin mode**\n\n`.** That's a deliberate visual cue so the admin can tell at a glance they're in a different mode from the public chat. Render it as the first assistant turn the same way you'd render a regular welcome — the prefix is markdown that should appear on screen.
3. **Operator-imposed gates are bypassed on the chat path.** Admin-mode sessions don't get refused for closed hours, geo policy, or a busted daily-cap — they're a tool for site staff, not a customer. Session caps still apply (against `admin_session_budget_usd` rather than `session_budget_usd`); soft-handoff and the operator's handoff webhook are suppressed. Practically, this means a widget that detects `is_admin_mode: true` doesn't need to handle 402/403/503 differently — those refusals just won't fire on admin sessions.

The widget's behaviour from token receipt onward is identical whether the session came from `POST /sessions` or from the admin path. There is no separate browser-side route to interact with for admin mode; the difference is entirely how the token was minted.

Signalling from WP to the widget: the recommended pattern is for the WP plugin to add a `data-is-logged-in="1"` attribute (or similar) to the widget's container element when rendering the admin page. The widget's JS sees the attribute, calls back to the WP backend via Ajax, and the WP backend (which holds the account admin key) mints the admin-mode session. The account admin key never reaches the browser. The attribute itself isn't a credential — a non-admin who manually sets it can call the WP backend but won't pass its capability check.

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

| Status | `error` value             | Meaning                                                                            |
| ------ | ------------------------- | ---------------------------------------------------------------------------------- |
| 400    | `message_required`        | Body missing, or `message` empty / whitespace-only.                                |
| 400    | `message_too_long`        | `message` exceeds 8000 chars. `detail` carries `length` and `limit`.               |
| 401    | `token_required`          | `Authorization` header missing.                                                    |
| 401    | `invalid_token`           | Token isn't recognised (revoked, never existed, or older than 24h since last activity). Drop the cached token and mint a fresh session. |
| 403    | `geo_blocked`             | The visitor's IP is no longer accepted by the chatbot's geo policy (operator may have changed it mid-session). Drop the cached token; this visitor can't continue. |
| 413    | `context_overflow`        | System prompt + history + new message exceeds the chatbot's declared context window. `detail` carries `total_prompt_tokens`, `context_window`, `headroom_tokens`. Recoverable — see "Error handling" below. |
| 429    | `rate_limit_exceeded`     | The caller's IP **or** the chatbot itself has hit the per-minute chat cap. `detail.retry_after_seconds` and a `Retry-After` header carry the wait time. Don't auto-retry; surface as a transient "too busy, try again in a moment" to the visitor. |
| 502    | `model_error`             | Upstream LLM call failed (rate limit, network, etc.). Retry after a delay.         |
| 503    | `model_not_configured`    | Operator hasn't set a model for this chatbot. Operator action required.            |

When `model_error` fires, the user's message **is still persisted** in the session log. If you retry the same turn, you'll get duplicates server-side; consider showing an error UI instead of auto-retrying.

**Per-session cap (soft + hard handoff).** Some chatbots also carry a per-session USD cap. The chat path handles it automatically — no new error codes appear:

- **Soft handoff (configurable threshold).** Once session spend crosses the threshold (default 80% of the cap), a `HANDOFF_SOFT.md` system block is injected so the model can gently nudge the visitor to leave their email. The widget sees a normal `200` reply.
- **Final-turn wind-down (M23.6, automatic).** When session spend is past 95% of the cap **or** the M23.5 sim hard-trigger is about to fire, a built-in `HANDOFF_FINAL` system block is injected for that turn. It tells the LLM not to end with a follow-up question or an "anything else?" invitation — because the next thing the widget does is disable the visitor's input, and a trailing question would dead-end them. Hardcoded for v1; no operator configuration required.
- **Hard cap.** When session spend reaches the cap, the assistant's reply is still returned to the visitor (the final natural reply, hopefully wound down gracefully thanks to the previous bullet) and the response carries `"session_terminated": true`. The widget should hide the input on this signal. Any subsequent `POST /chat` to the same session returns the chatbot's `HANDOFF_HARD.md` content (or a built-in default) with `"message_id": 0` and `"session_terminated": true` — no LLM call happens server-side. **Note:** `HANDOFF_SOFT.md` is operator-customisable (injected into the LLM's system prompt during a live turn); `HANDOFF_HARD.md` is only the canned post-termination response (returned verbatim after the session is already closed). They are not interchangeable.

### `POST /sessions/visitor-email` — capture a visitor email (write-only)

```http
POST /sessions/visitor-email
Authorization: Bearer e071b5ca42a16a8cdad993cee2d94a070960206f46b94506fc885d33250c661c
Content-Type: application/json

{
  "email": "visitor@example.com"
}
```

**Success (204):** empty body. There is **no GET counterpart at the session-bearer scope** — the email is stored for the operator's webhook + admin tooling only, and the widget can't read it back. This is deliberate: a captured email is privileged information that shouldn't be retrievable from the visitor's browser.

If the chatbot is configured with a `handoff_webhook_url` **and** the session is already terminated, posting the email also fires the handoff webhook to the operator (best-effort, no retry). If the session is still live, the email is stored quietly; the webhook fires later when the hard cap terminates the session.

**Failure shapes:**

| Status | `error` value         | Meaning                                                                |
| ------ | --------------------- | ---------------------------------------------------------------------- |
| 400    | `validation_failed`   | Body missing `email`, or the value isn't a string that loosely looks like an email (must contain `@` and a `.` after it, ≤255 chars). |
| 401    | `token_required`      | `Authorization` header missing.                                        |
| 401    | `invalid_token`       | Token isn't recognised or the session has been idle for >24h.          |

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

Messages are ordered ascending by `created_at`. The welcome message is **not** part of this list — it's a property of the chatbot, returned once by `POST /sessions`. If a visitor reloads the page, you'll see history without the welcome, and that's the intended behaviour.

**Failure shapes:**

| Status | `error` value     | Meaning                                                                  |
| ------ | ----------------- | ------------------------------------------------------------------------ |
| 401    | `token_required`  | Missing `Authorization`.                                                 |
| 401    | `invalid_token`   | Token isn't recognised (revoked, never existed, or older than 24h since last activity). Drop the cached token and start over. |
| 403    | `geo_blocked`     | The visitor's IP no longer fits the chatbot's geo policy. Same handling as for `POST /chat` above. |

## Denials at a glance

Every way a chat can be refused — by status, error code, where it fires, and what the widget should do. Use this as the single reference; the per-endpoint error tables above are the same information sliced by route.

All error responses share the same envelope:

```json
{ "error": "<code>", "detail"?: { ... } }
```

`detail` is route-specific and is the only thing that varies between codes (some carry useful numbers; most don't).

| Trigger                                          | Where it fires                                                  | Response                                              | Widget action                                                  |
| ------------------------------------------------ | --------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| Browser sent no `Origin` header                  | `POST /sessions`, `GET /sessions/can-start`                     | `400 origin_required`                                 | Diagnostic only — most browsers always send `Origin`.          |
| `Origin` not on the chatbot's allowlist          | `POST /sessions`, `GET /sessions/can-start`                     | `403 origin_not_allowed`                              | Don't render the widget. Tell the operator to add your host.   |
| Visitor IP fails the chatbot's geo policy        | `POST /sessions`, `GET /sessions/can-start`, `POST /chat`, `GET /messages` | `403 geo_blocked`                            | Don't render the widget for this visitor; drop any cached token.|
| **Chatbot's daily USD spend cap reached**        | `POST /sessions`, `GET /sessions/can-start`                     | `402 budget_exhausted_daily` (with `detail.cap_usd`, `detail.spend_usd`) | Don't render the widget; mints resume at the next UTC midnight. Already-minted sessions are **not** affected — they run to the end of their own session-cap budget. |
| **Outside the chatbot's operational hours**      | `POST /sessions`, `GET /sessions/can-start`                     | `503 chatbot_closed` (with `detail.next_open_at`, plus a `Retry-After` header in seconds, capped at 3600) | Hide the widget until the next opening time. Sessions minted while open keep running past closing time — only new mints are refused. |
| **Per-session USD cap reached (hard cap)**       | `POST /chat`                                                    | `200 { reply, session_terminated: true, message_id }` | Render the assistant's reply, then disable the input. Any further `/chat` returns a canned `HANDOFF_HARD.md` with `message_id: 0` and the same `session_terminated: true` flag — no LLM call. |
| `Authorization` header missing                   | `POST /chat`, `GET /messages`, `POST /sessions/visitor-email`   | `401 token_required`                                  | Bug in the widget — make sure `Authorization: Bearer <token>` is set. |
| Token unknown, revoked, or session idle >24h     | `POST /chat`, `GET /messages`, `POST /sessions/visitor-email`   | `401 invalid_token`                                   | Clear the cached token, mint a fresh session, restart UI.       |
| Body missing / empty / whitespace `message`      | `POST /chat`                                                    | `400 message_required`                                | Don't send. Enforce a non-empty check in the widget.            |
| `message` exceeds 8000 chars                     | `POST /chat`                                                    | `400 message_too_long` (with `detail.length`, `detail.limit`) | Enforce the same cap in the widget for a friendlier UX.     |
| Body missing / malformed `email`                 | `POST /sessions/visitor-email`                                  | `400 validation_failed` (with `detail.message`)       | Validate the shape client-side before posting.                 |
| Prompt + history would overflow the context window | `POST /chat`                                                  | `413 context_overflow` (with `detail.total_prompt_tokens`, `detail.context_window`, `detail.headroom_tokens`) | Tell the visitor the conversation has grown too long; optionally mint a fresh session. |
| Upstream LLM call failed                         | `POST /chat`                                                    | `502 model_error`                                     | Show a retry hint, but **don't** auto-retry — the user's turn is already persisted. |
| Operator hasn't configured a model               | `POST /chat`                                                    | `503 model_not_configured`                            | Tell the operator. Visitor sees a generic "not available" message. |
| Per-IP or per-chatbot rate limit hit             | `POST /sessions`, `POST /chat`                                  | `429 rate_limit_exceeded` (with `detail.retry_after_seconds`, plus a `Retry-After` header) | Back off for the indicated number of seconds and try again. Operator-tunable via `SW_RATELIMIT_*` env vars; defaults are conservative. `GET /sessions/can-start` and `GET /messages` are not rate-limited. |

A few things worth pulling out of the table:

- **`402 budget_exhausted_daily` is the one to wire up early.** A self-hosted operator with a tight Anthropic budget will trip this before they trip anything else. It fires only at session-mint (`POST /sessions`, `GET /sessions/can-start`), never on `POST /chat` — once a visitor has a token, they ride out their session to the session-cap. The widget should treat 402 from the mint path as "the chat is unavailable right now" and not retry on a loop.
- **The hard-cap path is the only "denial" that comes back as a `200`.** Look for `session_terminated: true` on every `POST /chat` success body and disable the input when it's set — the first time the visitor sees one final natural reply; subsequent calls return a canned `HANDOFF_HARD.md`.
- **`403 geo_blocked` is sticky to the visitor's IP, not their session.** An operator who changes the geo policy mid-session can lock out an active visitor; treat it the same way as `invalid_token` (drop the token, but don't retry mint — mint will also `403`).
- **There is no "session expired" error.** Tokens are valid until the session is idle for 24h, at which point the server returns `401 invalid_token` rather than a distinct code. The widget treats expiry and revocation identically.

## CORS

The chat API is designed to be called from a browser, so it speaks CORS. The rules are simple and they piggyback on the same per-chatbot origin allowlist you've already set up:

- **An `Origin` registered with any chatbot is an allowed CORS origin.** That's the single source of truth — there's no second "CORS origins" list. `sw chatbot origins add <slug> https://www.example.com` is the only step.
- **The server echoes the request's `Origin` back** as `Access-Control-Allow-Origin`, with `Vary: Origin` so caches don't cross-pollinate.
- **Unregistered origins get no CORS header.** The HTTP response itself looks normal (200, 403, etc. depending on the route's own logic), but the browser blocks JS from reading it. From the operator's perspective the API doesn't *leak* which origins are valid.
- **Allowed methods:** `GET`, `POST`, `OPTIONS`. **Allowed headers:** `Content-Type`, `Authorization`. **Credentials:** not used (we authenticate with a Bearer token in `Authorization`, not cookies — don't set `credentials: 'include'` on your `fetch`).
- **Preflight `OPTIONS` requests** are handled automatically. The browser sends them before any `POST /chat`, `POST /sessions`, or `GET /messages` because of the `Authorization` / `Content-Type: application/json` headers. The server returns a `204` with the allow headers above and a `Max-Age` of 600 seconds so the browser doesn't re-preflight on every turn.
- **Non-browser callers** (curl, the `./bin/chat` CLI, server-to-server) don't send an `Origin` header and the CORS layer leaves them alone. Same code path, same response.

If your browser console shows `Access-Control-Allow-Origin missing`, the fix is almost always the operator running `sw chatbot origins add` for your widget's host. The server didn't 403 — it just didn't recognise the origin, so it didn't grant CORS.

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

- **localStorage** (recommended): persists across page reloads, tabs, and browser restarts. The conversation rehydrates via `GET /messages` next time the visitor lands on the page. Token is JavaScript-readable, but it's a session token tied to one chatbot's allowlisted origin — not a credential that grants broader access.
- **sessionStorage**: lost on tab close. Conversations don't survive a reload-and-comeback. Probably too aggressive for a pre-sales bot the visitor might revisit.
- **Cookies**: site-walker doesn't currently set any. The session-token flow is intentionally cookie-free so there's no third-party-cookie story to manage.

If the visitor explicitly opts out of "remember this conversation" (privacy UI, GDPR consent, etc.), use `sessionStorage` or hold the token in memory only.

## Limits, gaps, and known TODOs

- **Message length cap:** 8000 characters after trimming. Enforce this in the widget too so you can give a friendly UI message instead of trusting the server's 400.
- **Single conversation per session:** one session, one growing message log. There's no "new conversation" affordance built into the API; minting a fresh session token (e.g. by clearing `localStorage` and reloading) is how you start over.
- **No streaming yet.** Each `POST /chat` is request-then-response. Show a "Thinking…" indicator during the in-flight period. Token streaming is on the roadmap.
- **No client-controllable model.** The model is set per-chatbot by the operator; widgets can't override it per session. Comparison testing today means swapping the chatbot's model via `sw chatbot set-model` between conversations.
- **No retention sweep yet.** Sessions and messages persist indefinitely on disk. The 24h idle-expiry on `findSessionByToken` stops a stale token resurrecting an old conversation, but the rows are still there until an operator deletes them. A scheduled retention sweep is on the post-pivot deferred list.

## See also

- [`cli-sw.md`](cli-sw.md) — the operator commands that set up a chatbot before any widget loads.
- [`cli-chat.md`](cli-chat.md) — the terminal test client. Useful for exercising the same flow without a browser.
- [`system-blocks.md`](system-blocks.md) — what the model is actually being shown alongside the conversation. Affects answer quality, not the API surface.
- `/openapi.json` and `/docs` on a running instance — machine-readable reference + interactive Swagger UI for trying calls out.
