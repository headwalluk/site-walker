# Auth & session flow

Design doc for how a browser-side visitor reaches the chat API, how sessions are created and authenticated, and what each endpoint returns. Settled 15 May 2026.

Scope: Phase 1 (Milestones 2, 3, 6). Capacity / rate-limit details are stubbed here and finalised in [M11](00-project-tracker.md#milestone-11-rate-limiting--abuse-protection).

---

## Why not API keys for browser traffic

The original plan in earlier draft tracker had `POST /chat` authed by per-website API key. We pivoted away because:

- An API key embedded in browser JavaScript is publicly visible. Anyone reading the page source can copy it. So it provides no real authentication — at best it's an identifier for rate-limiting.
- The `Origin` header, by contrast, is browser-controlled and cannot be set by JS in a different origin. It's the genuine signal of "which website is this request coming from."
- A short-lived opaque session token, minted by our API after we verify `Origin`, gives us a proper credential for the rest of the conversation without exposing anything reusable.

API keys aren't dead — they'll be needed for any future server-to-server channel (WordPress plugin admin, remote CLI usage). But that's Phase 2, not Phase 1.

---

## High-level flow

1. Visitor lands on a customer's website (which has the WordPress plugin installed).
2. Plugin's JavaScript calls `POST /sessions` to our API. The browser sends the `Origin` header automatically.
3. Our API checks the `Origin` against `website_origins` for any registered website. If match: mint a session token, persist a row in `sessions`, return `201 { session_token, welcome_message }`. If no match: `403`.
4. Browser stashes the session token in `localStorage` keyed by widget instance.
5. On user input, browser calls `POST /chat` with `Authorization: Bearer <token>` and `{ message }`. API resolves the token to a session + website, appends the user message, runs the LLM, persists the assistant reply, returns `200 { reply, message_id }`.
6. On page reload (with a token still in `localStorage`), browser calls `GET /messages` with the same bearer token to rehydrate the visible transcript.

---

## Endpoints

### POST /sessions

Creates a new chat session for the calling website.

**Required headers**
- `Origin` — must exactly match a row in `website_origins`. Browsers set this automatically on cross-origin requests.

**Request body** — empty.

**Responses**
- `201 Created`
  ```json
  { "session_token": "<64-hex-chars>", "welcome_message": "Hi! Ask me about ..." }
  ```
- `400 Bad Request` — `Origin` header missing entirely.
- `403 Forbidden` — `Origin` not on any allowlist (`{ "error": "origin_not_allowed" }`).
- `503 Service Unavailable` — capacity exceeded. **Phase 1: never returned** (the check is a no-op stub). M11 wires real capacity logic.

**Side effects**
- Inserts a row into `sessions` with `website_id`, `token`, `created_at`, `last_active_at`.

### POST /chat

Adds a turn to a session and returns the assistant reply.

**Required headers**
- `Authorization: Bearer <session_token>`

**Request body**
```json
{ "message": "What does your basic plan cost?" }
```

**Responses**
- `200 OK`
  ```json
  { "reply": "Our basic plan is ...", "message_id": 12345 }
  ```
- `401 Unauthorized` — token missing, unknown, or expired.
- `503 Service Unavailable` — capacity exceeded (M11).

**Side effects**
- Inserts the user message and (after LLM call) the assistant reply into `messages`, both tied to the resolved `session_id`.
- Updates `sessions.last_active_at` (used by M13 retention).

**Note on return shape:** we return **only the new assistant reply**, not the whole history. Browser keeps its locally-rendered transcript and appends. Rehydration on page reload happens via `GET /messages`.

### GET /messages

Returns the full conversation for the session bound to the bearer token.

**Required headers**
- `Authorization: Bearer <session_token>`

**Responses**
- `200 OK`
  ```json
  {
    "messages": [
      { "id": 1, "role": "user", "content": "Hi", "created_at": "2026-05-15T..." },
      { "id": 2, "role": "assistant", "content": "Hello!", "created_at": "..." }
    ]
  }
  ```
- `401 Unauthorized` — token missing, unknown, or expired.

**Notes**
- No pagination in v1. If sessions get long we revisit (likely tied to M9 trimming).
- Welcome message is **not** in this list — it's a UI greeting, not a stored turn.

---

## Origin matching rules

- **Exact string match** between request `Origin` header and `website_origins.origin` column. No suffix or wildcard matching in v1.
- `https://example.com` and `https://www.example.com` are different origins. Operators register both if both should work.
- Standard ports are omitted from `Origin` per HTTP spec (so `https://example.com` not `https://example.com:443`). Store the form the browser sends.
- Trailing slash never appears in `Origin`; reject (or normalise away) trailing slashes when admins add origins via the CLI.

**CORS response headers** (set on `POST /sessions` and `POST /chat`):
- `Access-Control-Allow-Origin: <the verified Origin>` (not `*` — credentials carry).
- `Access-Control-Allow-Credentials: true` if we ever move tokens to cookies; for bearer-in-header this is optional.
- `Access-Control-Allow-Headers: Authorization, Content-Type`.
- `Vary: Origin` so any caching layer doesn't bleed CORS responses across origins.

---

## Session token

- **Format:** 32 random bytes from `crypto.randomBytes`, hex-encoded → 64 char string. No JWT — we don't need claims-in-token; everything's looked up in MariaDB.
- **Comparison:** equality check via parameterised `WHERE token = ?`. Constant-time isn't worth the ergonomic cost for a token that's already random + opaque; the lookup is the limiting factor, not the comparator.
- **Expiry:** not enforced in Phase 1 (tokens live as long as the session row). M13 will add a retention policy; M11 may add idle expiry.
- **Storage on client:** `localStorage` per widget instance. XSS on the host site would compromise the token, but XSS on the host site is game over for that site regardless — accepted risk.
- **Revocation:** delete the `sessions` row. M7's `sw sessions delete <token>` does this.

---

## Welcome message

- Per-website field on `websites.welcome_message`. Settable via `sw website set-welcome <slug> <message>` (lands in M7).
- Returned in the `POST /sessions` response so the widget can render it immediately.
- **Not** injected into the LLM context — it's a UI greeting, not a tone-setter. System blocks do tone-setting (M4).
- Defaults to something reasonable if NULL — `"Hi! How can I help?"` or similar. Pick when M2 schema lands.

---

## Capacity / 503 (Phase 1 stub)

The session-creation flow conceptually has a "are we too busy?" check between origin verification and token mint:

```
verify origin → check capacity → mint token + insert session row
                      ↑
                      stub returns "yes, fine" in Phase 1
```

In Phase 1 the check is a function that returns true unconditionally. M11 replaces it with the real check (Redis counters, per-website and global limits). Wiring it now means M11 is a body-swap, not a structural change.

Same idea for `POST /chat` — Phase 1 has no rate limit, Phase 2 wires Redis into the same hook point.

---

## Open questions

- Token lifetime / idle expiry — currently "forever until M13 retention deletes". Acceptable for Phase 1 testing; revisit when M11 rate-limit + M13 retention land.
- Whether to defence-in-depth `Origin` check on `POST /chat` too, not just `POST /sessions`. Cheap to add. Default to "yes" unless it causes proxy/CDN trouble.
- WebSocket / SSE for streaming replies — out of scope for Phase 1, but the `ModelBackend` interface in M5 should leave room for it.
