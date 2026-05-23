# Operational availability + admin mode

Design notes for two features grouped together because they share the same session-mint gating seam: **per-chatbot operational hours** (the chatbot is only available at certain times on certain days) and **admin mode** (a power-user session type for logged-in site administrators that bypasses operator-imposed gates). Captured 2026-05-23.

**Status:** design-in-flight. Target: **v1.0.0**. Both features gate the first paying customer launch — clients will want hours-of-operation up-front (cost control + don't-answer-at-3am brand), and they'll want admin mode for staff productivity (Woo store admins using the bot to navigate their own catalogue, alongside the secondary use of "test config before launch").

Companion to:

- [`11-budget-handoff.md`](11-budget-handoff.md) — M20 + 0.16.1 budget-cap design; this milestone extends the same mint-gate composition.
- [`01-auth-and-session-flow.md`](01-auth-and-session-flow.md) — session-token lifecycle. Admin-mode tokens are minted through a different route but otherwise identical.
- [`00-project-tracker.md`](00-project-tracker.md) — Milestone 21.

---

## Why both features in one milestone

The two features look unrelated on the surface, but they hit the same code surface:

1. Both add gates at `POST /sessions` + `GET /sessions/can-start`. Operational hours adds the "is the chatbot currently open?" check; admin mode adds the "is this caller pre-authenticated to bypass gates?" check.
2. Both involve new `chatbots.*` columns + `sessions.*` columns.
3. The admin-mode mint route is most naturally tested *against* a closed-hours chatbot (the canonical use case: "the bot is shut for the night, but the boss wants to look something up"). Shipping them together avoids a v0.x.y point release between them.

The 0.16.1 precedent applies: **operator-imposed gates fire at session-mint, not on every chat turn.** A session minted at 16:55 keeps going past 17:00.

---

## Feature 1: operational availability

### Schema

Two new columns on `chatbots`:

- `chatbots.timezone VARCHAR(64) NULL` — IANA timezone identifier (e.g. `Europe/London`, `America/New_York`). Validated on write via `new Intl.DateTimeFormat('en', { timeZone: candidate })` — invalid identifiers throw and the PATCH/CLI rejects with `validation_failed`. **Always set per-chatbot**, never inferred globally; the API has no access to the WP site's TZ. The WP plugin can detect a mismatch between its own site TZ and the chatbot's `timezone` and prompt the admin to sync.
- `chatbots.availability JSON NULL` — schedule object; NULL = always open (current behaviour, no enforcement).

### JSON shape

Per-day arrays of `"HH:MM-HH:MM"` strings. Missing day key = closed all day. Empty array = closed all day. Whitespace tolerated; `24:00` accepted as the end-of-day marker. `close <= open` rejected on write (no implicit wrap-around to next day; if you need an overnight window, write two entries).

Examples:

```json
// Business hours, Mon-Fri 9am-5pm Europe/London, closed weekends
{
  "schedule": {
    "mon": ["09:00-17:00"],
    "tue": ["09:00-17:00"],
    "wed": ["09:00-17:00"],
    "thu": ["09:00-17:00"],
    "fri": ["09:00-17:00"]
  }
}

// Out-of-hours only: midnight-9am AND 5pm-midnight, every weekday
{
  "schedule": {
    "mon": ["00:00-09:00", "17:00-24:00"],
    "tue": ["00:00-09:00", "17:00-24:00"],
    "wed": ["00:00-09:00", "17:00-24:00"],
    "thu": ["00:00-09:00", "17:00-24:00"],
    "fri": ["00:00-09:00", "17:00-24:00"]
  }
}

// Lunch closure
{
  "schedule": {
    "mon": ["09:00-12:00", "13:00-17:00"]
  }
}
```

### Enforcement

A single new helper, `src/services/availability.ts::isOpenNow(chatbot, now): { open: boolean, nextOpenAt: Date | null }`. Pure function — takes the chatbot row + a `Date` for current time, returns the answer plus (when closed) the next opening time. Called from:

- `POST /sessions` — refuse to mint with `503 chatbot_closed`, body `{ error: 'chatbot_closed', detail: { next_open_at: '<ISO>' } }`, response header `Retry-After: <seconds-until-next-open>`. Capped at 3600s for the header value even if next opening is days away (so widgets don't park a polling loop on a too-large value).
- `GET /sessions/can-start` — same shape; widgets can hide the chat affordance proactively.
- **Not** on `POST /chat`, `GET /messages`, or `POST /sessions/visitor-email` — mint-only, per the 0.16.1 precedent.

### Admin/CLI surface

- `PATCH /admin/chatbots/{slug}` accepts new fields: `timezone`, `availability`. Validated on write (IANA TZ + schedule grammar). `null` clears.
- `sw chatbot set-timezone <slug> <tz>` and `sw chatbot set-hours <slug> <json-or-grammar>`. The grammar (CLI shorthand like `mon-fri:09:00-17:00`) is a UX nice-to-have; JSON-via-stdin is the universal fallback.

---

## Feature 2: admin mode

### Flow

The browser widget renders inside a page that the WordPress plugin serves. When the page is rendered to a logged-in WP user with admin capabilities, the plugin adds a data attribute:

```html
<div id="site-walker-widget"
     data-chatbot-slug="acme-corp"
     data-is-logged-in="1"></div>
```

The attribute itself leaks nothing — it just tells the widget JS "you may try minting an admin-mode session via the WP backend". A non-admin who manually sets the attribute via dev-tools and triggers the flow will get a 403 from WP (the actual privilege check lives in the WP plugin's PHP, using WP's own user-capability check — `current_user_can('manage_options')` or similar). Defence-in-depth: even if a non-admin somehow bypassed WP's check, our `POST /admin/chatbots/{slug}/sessions` route still requires the account admin bearer key, which only the WP plugin (server-side) holds.

```
Browser (admin user)         WP backend (PHP)                       site-walker API
─────────────────────        ────────────────                       ───────────────
                                                                        
sees data-is-logged-in="1"                                              
fetch('/wp-admin/admin-                                                 
  ajax.php?action=...')  ─►  current_user_can() ✓                       
                             POST /admin/chatbots/{slug}/sessions   ─► verify account bearer ✓
                             (Authorization: Bearer sw_<admin>)         resolve chatbot for account
                                                                        skip mint-time gates
                                                                        INSERT sessions row with
                                                                          is_admin_mode = TRUE
                             { session_token, welcome_message,      ◄── 201
                               is_admin_mode: true }
{ session_token, ... }   ◄── relay
                                                                        
POST /chat                                                          ─► validate token; honour is_admin_mode
(Bearer <session-token>)                                                throughout the chat path
```

The WP plugin only ever uses its account admin key from PHP — the key never reaches the browser.

### Schema

- `sessions.is_admin_mode BOOLEAN NOT NULL DEFAULT FALSE` — flag stamped at mint time.
- `chatbots.admin_session_budget_usd DECIMAL(10,4) NULL` — separate per-session ceiling for admin-mode sessions. NULL = unbounded (admin is trusted). Operators who want a safety belt set a value; bounded by `SW_MAX_SESSION_BUDGET_USD` like the customer-facing column.

### Per-gate behaviour

The key product-design table for this feature. For every gate the codebase enforces today, what changes for an admin-mode session:

| Gate                                       | Regular session                       | Admin-mode session                                       | Why                                                                            |
| ------------------------------------------ | ------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Origin allowlist (mint + per turn)         | required                              | **skipped**                                              | admin may be on a staging URL not yet allowlisted                              |
| Geo blocklist/allowlist                    | required                              | **skipped**                                              | admin may be travelling; geo is about visitor IP, not staff                    |
| Operational availability (this milestone)  | required                              | **skipped**                                              | the whole point of one of the use cases                                        |
| Daily spend cap                            | required (mint-time)                  | **skipped**, and admin spend **excluded from daily aggregation** | admin use doesn't displace customer budget                                     |
| Per-session spend cap                      | `session_budget_usd`                  | `admin_session_budget_usd` (separate, higher, NULL=unbounded) | safety belt yes, but operator-controlled ceiling                                |
| Soft-handoff inject (`HANDOFF_SOFT.md`)    | fires at threshold                    | **never fires**                                          | "wind down to a human" is meaningless for staff use                            |
| Hard-cap termination + canned `HANDOFF_HARD` | fires + webhook                     | fires (if admin cap set), **no webhook**                 | safety belt yes, but webhook would spam the operator about themselves          |
| 24h idle expiry                            | applies                               | applies                                                  | shared-device risk is identical; admins are people too                         |
| Capacity stub                              | applies                               | **skipped**                                              | once we have real rate-limiting, admins shouldn't be in the same bucket        |

### Spend reporting

Admin-mode spend is **recorded** the same as regular spend (every `messages` row has its `cost_usd_estimate` set), but **aggregated separately**:

- `getChatbotDailySpend` adds `WHERE sessions.is_admin_mode = FALSE`. Customer daily spend is bounded by `daily_budget_usd`; admin spend doesn't displace it.
- `sw chatbot usage` and `GET /admin/chatbots/{slug}/usage` return two totals: `customer_cost_usd` + `admin_cost_usd`, and corresponding token counts. Operators see both numbers separately.
- `sw sessions list` marks admin-mode rows with an `[admin]` suffix so operators eyeballing usage anomalies can immediately identify which sessions are staff. Concrete use case the user surfaced: "ah — it was the boss racking up the Anthropic bill today."

---

## Open design questions (settle during the M21 implementation pass)

1. **Schedule JSON shape: strings vs objects.** Two viable shapes:
   - Strings: `"mon": ["09:00-17:00"]`. Compact, matches the user's mental model. Needs a parser.
   - Objects: `"mon": [{ "open": "09:00", "close": "17:00" }]`. Self-documenting, no parser. More verbose for the operator.
   **Lean:** strings. The parser is a 5-line regex; UX friction matters more. The WP plugin can render either to admins as a friendly UI; the JSON is the canonical wire format.
2. **`24:00` literal vs `00:00` next-day vs wrap-around.** Three handling options for "open until end-of-day". **Lean:** support `24:00` literally; reject `close <= open` otherwise. Wrap-around (`"22:00-02:00"` meaning open through 2am next day) is rare enough that the operator can write two windows; supporting it natively complicates the parser and the "what day is this window on?" logic.
3. **Per-day overrides (public holidays, one-off closures).** **Lean:** out of scope for M21. Operators handle one-off closures by setting `availability` to a "closed all day" schedule on the day in question via direct PATCH, or by toggling a future `chatbots.is_paused` flag (also out of scope here).
4. **`chatbots.is_paused` kill-switch.** Independent from `availability` — "the chatbot is broken / under maintenance, refuse all new sessions regardless of schedule". Useful but separate concern; punt to a follow-up unless a first customer specifically asks.
5. **`Retry-After` header value cap.** Set the header to `min(seconds-until-next-open, 3600)` so widgets don't park a polling loop on a 6-day value. **Lean:** yes, cap at 1 hour; `detail.next_open_at` carries the actual time for widgets that want to render it.
6. **Admin-mode mint route shape.** `POST /admin/chatbots/{slug}/sessions` with empty body is simplest. Should it accept anything? Probably an optional `origin` to record on the session row for audit-trail purposes. **Lean:** start with empty body; the WP plugin can pass the admin's browser Origin in a future iteration if useful.
7. **Admin-mode session welcome message.** Same as customer-facing? Or different per-chatbot `admin_welcome_message`? **Lean:** same. The chatbot's "Hi, how can I help?" works equally well for admin use.
8. **Admin-mode session visibility in `GET /messages`.** Admin's conversation history rehydrates on page reload the same as any other session — same code path, no change. The `is_admin_mode` flag isn't surfaced in `GET /messages`; the widget already knows whether the current session is admin (it issued the request that started it).
9. **Existing M20 tests for HANDOFF_SOFT / hard-cap termination.** Need parallel tests for admin-mode sessions confirming the suppression: soft-handoff doesn't inject; hard-cap terminates but doesn't fire the webhook.
10. **Concurrency / dedup of admin-mode sessions.** Can one admin have many concurrent admin-mode sessions, or do we enforce one-per-admin? **Lean:** unlimited. Sessions are cheap, the admin-cap is the safety belt. If a customer asks for a per-admin cap later, that's a follow-up.
11. **Origin recording on admin-mode sessions.** For the audit story (`sw sessions list` showing where admin sessions came from), what Origin do we record? **Lean:** record `NULL` on admin-mode sessions; the `[admin]` marker is the audit signal. If the operator wants more granularity, the WP plugin can pass a label in.

---

## What this doc is not

- **Not a commitment to per-day overrides.** Public holidays, one-off closures, "the office is closed for inventory next Tuesday" — all out of scope. The schedule is a weekly pattern; one-offs are a follow-up if a customer asks.
- **Not a "preview mode" feature.** Admin mode is a real product surface for staff productivity, not a developer's preview switch. The reframe matters because it informs how the WP plugin presents it (a normal usable chatbot, not a "test this config" affordance).
- **Not a maintenance-mode kill switch.** `chatbots.is_paused` (deny-all-sessions regardless of schedule) is a related but separate feature; punt unless a customer asks.
- **Not a per-admin budget.** Admins are trusted; `admin_session_budget_usd` is per-session, not per-admin-per-day. If a customer needs "no one admin can spend more than $X/day", that's a follow-up.
- **Not multi-tenancy at the WP-user level.** The WP plugin's PHP layer authenticates WP users; our API only sees "the WP plugin minted an admin session" and trusts that. We don't track which WP user.
