# Budget-driven conversation handoff

Design notes for the M20 budget-cap behaviour. Original design captured 2026-05-20; **shipped** in v0.16.0 on 2026-05-21. The "open design questions" section below records what got resolved and how.

**Status:** shipped. The first half of this doc remains the durable motivation; the new "What shipped" section at the end is the authoritative implementation reference.

Companion to:
- [`10-saas-shape.md`](10-saas-shape.md) — M20 budget caps section, which this expands on
- [`00-project-tracker.md`](00-project-tracker.md) — M20 milestone; old M9 marked likely-superseded

---

## What changed from the original M9 / M20 split

The original M9 was "history trimming strategy" — sliding-window drop-oldest vs summarise-older-turns. Its job was to make `413 context_overflow` go away gracefully when prompt + history busted the model context window.

The reframe (2026-05-20): for a **pre-sales** bot, the right thing when a conversation has gone on too long isn't to *keep* it going via clever trimming — it's to gracefully *end* it by handing the visitor to a human. That changes the problem entirely.

Concretely:
- The bot isn't supposed to have indefinitely long conversations. Pre-sales bot ≠ general assistant.
- A cost cap per session is the natural backstop ("I don't want to spend more than $2 on one conversation").
- When the cap is approached, the bot should *guide* the visitor toward asking for a human rep.
- When the cap is hit, the bot should *commit* to that handoff and capture contact details.

Sliding-window trimming is on-product for ChatGPT-style assistants; it isn't for what we're building.

---

## Relationship to context overflow

Budget cap and context-window overflow are **independent variables**:

- On cortex/qwen2 (4096-token window), a conversation can blow context in ~5 turns without spending anything.
- On Haiku (200k window), $2 of spend lands long before context overflow.

So budget-driven handoff is the **primary** end-of-conversation mechanism for metered chatbots, but the existing `413 context_overflow` stays as the **hard backstop** for everyone. M9's clever-trimming work stops being necessary on the metered path (budget caps bound length naturally), and on the unmetered path (self-hosted Ollama) the existing 413 is acceptable — there's no commercial pressure on self-hosters to extend conversations indefinitely.

**M9 is therefore likely superseded** as a standalone milestone. The capability remains available as a fallback if M18 cost data reveals that real conversations regularly exceed the chosen model's context window before they exceed the chosen budget. Most likely outcome: M9 dies. But we don't kill it prospectively — let M18 surface the data.

---

## Shape

Three phases per session, in spend order:

### 1. Below soft-handoff threshold (default 80% of session budget)

Normal chat. Nothing special in prompt assembly.

### 2. At soft-handoff threshold

Inject an extra system block at prompt-assembly time guiding the model toward suggesting a human representative. Example tone:

> "The conversation is reaching the configured cost limit. Begin gently suggesting that for detailed follow-up the visitor speaks to a human representative. Don't be abrupt — keep helping with the current question but plant the seed."

Operator-templated per chatbot. Storage options under discussion:
- `chatbots.handoff_soft_message TEXT NULL` (DB column, edited via CLI like persona)
- `data/chatbots/<slug>/HANDOFF_SOFT.md` (disk file, consistent with system-blocks convention)

Injection is **persistent for the rest of the session** — once past the threshold, every subsequent turn keeps the block in context. We don't re-assert; the model carries the posture.

### 3. At hard cap (100% of session budget)

The bot **does not invoke the LLM** for this turn. The server returns a templated message:

> "I think it would be better to talk to a human representative. Please leave your email address and someone will be in touch soon."

The session is marked terminated (probable column: `sessions.terminated_at TIMESTAMP NULL`). Subsequent `POST /chat` calls in the same session return the same handoff template without invoking the LLM until the visitor provides an email and the email is captured.

---

## Three known design concerns

### Stateful prompt assembly is implementation-novel

This is the first time prompt assembly would be conditional on per-request session state. Everything in `assemblePrompt` today is strictly functional — same disk + DB blocks every request. Adding "*also* this block when session-spend > threshold" makes assembly stateful. Workable, but the new pattern affects every chat-path test fixture; needs a clear seam in `src/services/system-blocks.ts` rather than a sprinkle of `if` statements in the chat path.

### Unmetered chatbots have no cap

Self-hosted Ollama runs at $0 spend; the cap never triggers. Conversations end at `413 context_overflow` instead. Acceptable for v1 — pre-sales SaaS customers are all on metered providers. If unmetered chatbots ever need a handoff, the right primitive is a separate `chatbots.session_max_turns INT NULL` cap, not retrofitting budget into something Ollama doesn't have.

### Email capture is real ops work, not a one-line product change

"Please leave your email" is just text in the handoff message. What happens to the captured email is a real decision with three shapes:

| Option                            | Pipe                                                                                    | Trade-off                                                          |
|-----------------------------------|-----------------------------------------------------------------------------------------|--------------------------------------------------------------------|
| **Per-chatbot operator email**    | Server emits SMTP notification to the chatbot owner.                                    | Simplest. Needs SMTP config on the host.                           |
| **`session_handoffs` DB table**   | Visitor email + transcript reference stored. Operator polls via CLI or admin HTTP.      | Most flexible. No SMTP needed. Operator has to actively check.     |
| **Webhook per chatbot**           | Server POSTs `{ chatbot, session_id, visitor_email, transcript_url }` to operator's URL. | Most integration-friendly. Operator wires it into their CRM, etc. |

Pick one for v1; the others can land later if customers ask.

---

## Open design questions (settled during M20)

1. **Email-capture mechanism.** Webhook, DB table, or operator email. **Lean:** webhook — the dumbest pipe that's still integration-friendly, with no SMTP infrastructure on our side.
2. **Soft-handoff threshold storage.** Per-chatbot configurable (`chatbots.handoff_threshold_pct DEFAULT 80`) vs system-wide constant. **Lean:** configurable — too high-stakes a UX choice to bake in.
3. **Soft-handoff block content storage.** DB column vs `data/chatbots/<slug>/HANDOFF_SOFT.md`. **Lean:** disk file — consistent with system-blocks convention, keeps prose-editing in the operator's preferred editor.
4. **Hard-cap message storage.** Constant copy with operator-supplied contact details slotted in, vs fully operator-templated. **Lean:** operator-templated — voice consistency matters for handoff.
5. **Session-terminated state.** Probable `sessions.terminated_at TIMESTAMP NULL`. After set, `POST /chat` returns the hard-cap message verbatim without an LLM call. `GET /messages` returns the full transcript including the persisted handoff turn.
6. **Email-capture timing.** Two-step (bot asks in turn N, visitor replies in turn N+1) vs widget-side (hard-cap response contains an email field the widget POSTs separately). **Lean:** widget-side — clean separation of concerns, plus the email never gets passed through the LLM.
7. **Re-engagement.** Can the same visitor start a fresh conversation on the same chatbot? **Yes by default** — budget cap is per-session, not per-visitor. Daily cap on the chatbot is the per-day backstop. We don't track visitor identity beyond the session token.

---

## What this doc is not

- **Not a commitment to M9's deletion.** M9-style trimming stays available as a fallback if real conversations turn out to bust context windows before they bust budgets. Most likely outcome: M9 dies; the schema delta here (`sessions.terminated_at`, `chatbots.handoff_*`) is the whole story. Decision still waits for production cost data.

---

## What shipped (v0.16.0, 2026-05-21)

The resolved design, against the question list above:

1. **Email capture: webhook.** A single optional `chatbots.handoff_webhook_url`. Fired best-effort (no retry, 10s timeout, no HMAC v1) when a session is terminated **and** the visitor has supplied an email. JSON payload: `{ event: 'session_handoff', chatbot_slug, session_id, visitor_email, terminated_at, spend_usd }`. `sessions.handoff_notified_at` stamps successful delivery so a future job could replay non-delivered ones; the operator's receiver is responsible for idempotency.
2. **Soft threshold: per-chatbot.** `chatbots.handoff_threshold_pct TINYINT UNSIGNED NOT NULL DEFAULT 80`. Validated to `[1, 100]` on PATCH and the CLI.
3. **Soft block content: disk file.** `data/chatbots/<slug>/HANDOFF_SOFT.md`. Loaded conditionally via `loadHandoffBlock('soft')`. Skipped silently when absent — the model just doesn't get the nudge.
4. **Hard-cap message: operator-templated, with fallback.** `data/chatbots/<slug>/HANDOFF_HARD.md` is preferred. When absent, a built-in `DEFAULT_HARD_HANDOFF` constant in `src/services/chat.ts` carries a generic "please leave your email" message. The constant has no operator details — the fallback is intentionally bland so an operator who hasn't authored a custom one isn't stuck.
5. **Session-terminated state.** `sessions.terminated_at TIMESTAMP NULL`. After it's set: `POST /chat` returns the canned hard-cap response with `message_id: 0`, `session_terminated: true`, and never calls the adapter. No new message rows are written.
6. **Email-capture timing: widget-side.** Dedicated `POST /sessions/visitor-email` route, session-bearer-authenticated, write-only. The email never traverses the LLM. The route has no GET counterpart at the session-bearer scope — admin-only readback prevents an obvious privilege escalation if the visitor's session token leaks.
7. **Re-engagement: per-session, not per-visitor.** Confirmed as designed. Plus a `sessions.last_active_at`-anchored 24h idle expiry baked into `findSessionByToken` — older-than-24h tokens read back as `null`, so a shared device can't expose conversation history from yesterday.

### Schema delta (migration 0005)

```
chatbots:
  + daily_budget_usd       DECIMAL(10,4) NULL        -- per-day USD cap
  + session_budget_usd     DECIMAL(10,4) NULL        -- per-conversation USD cap
  + handoff_threshold_pct  TINYINT UNSIGNED NOT NULL DEFAULT 80
  + handoff_webhook_url    VARCHAR(255) NULL

sessions:
  + terminated_at          TIMESTAMP NULL
  + visitor_email          VARCHAR(255) NULL
  + handoff_notified_at    TIMESTAMP NULL
```

### Chat-path state machine

The chat handler is now a five-step path (`src/services/chat.ts`):

```
1.  if session.terminated_at !== null:
        return canned HANDOFF_HARD (or DEFAULT_HARD_HANDOFF), message_id=0, terminated=true
2.  if chatbot.daily_budget_usd set AND today's spend >= cap:
        throw ChatError('budget_exhausted_daily')  → 402
3.  if chatbot.session_budget_usd set AND session-spend-before >= cap * threshold/100:
        load HANDOFF_SOFT.md → assemblePrompt(extraBlocks=[soft])
4.  run adapter, persist user + assistant messages
5.  if chatbot.session_budget_usd set AND session-spend-after >= cap:
        sessions.terminated_at = NOW()
        result.session_terminated = true
        if chatbot.handoff_webhook_url AND session.visitor_email:
            void notifyHandoff(...)  // fire-and-forget
```

The hard-cap check is **after-write** — the visitor gets one final natural reply, then the session terminates. That's a deliberate choice for UX (a mid-sentence cutoff would be jarring) at the cost of one over-cap reply per session.

### Sanity-bound caps

A stolen account-admin key could otherwise set `daily_budget_usd = 1_000_000` and drain the operator's BYO LLM credit. Two host-side env vars cap what any admin path (HTTP PATCH or CLI) will accept:

- `SW_MAX_DAILY_BUDGET_USD` (default `10000`)
- `SW_MAX_SESSION_BUDGET_USD` (default `100`)

Operators raise these only if they genuinely need higher caps. Documented in [`../docs/env.md`](../docs/env.md).

### Surface

- **Chat path:** `POST /chat` adds `session_terminated: boolean` to the success body. New error `402 budget_exhausted_daily` on `POST /chat`, `POST /sessions`, and `GET /sessions/can-start` — the cap is enforced both at session-mint time *and* per chat turn, so a token minted just before midnight that crosses the cap mid-day still fails fast.
- **Visitor email:** `POST /sessions/visitor-email` (session-bearer, write-only). Returns 204 with no body. Validates the email shape loosely (≤255 chars, contains `@` and a `.`). Fires the handoff webhook iff the session is already terminated *and* the chatbot has `handoff_webhook_url` set.
- **Admin PATCH:** `PATCH /admin/chatbots/{slug}` extended to accept `daily_budget_usd`, `session_budget_usd`, `handoff_threshold_pct`, `handoff_webhook_url`. Bounded values; `null` clears.
- **CLI:** `sw chatbot set-budget` (with `--daily`, `--session`, `--threshold`; `none` literal to clear) and `sw chatbot set-handoff-webhook <slug> <url|none>`.

### Webhook security stance (v1)

No HMAC, no retry, 10s timeout. Operator's receiver SHOULD:
- Be idempotent on `session_id`.
- Whitelist the originating IP if the receiver is on the public internet.
- Not assume freshness (we may stamp `handoff_notified_at` *after* the receiver acked).

If a real customer needs signed payloads or retry-with-backoff, that's a follow-up. The v1 shape is consistent with the rest of the project's "fail loud, no ambiguous fallback" stance: a webhook delivery failure is logged and the visitor is never blocked.
