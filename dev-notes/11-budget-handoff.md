# Budget-driven conversation handoff

Design notes for the M20 budget-cap behaviour, capturing the design conversation on 2026-05-20. **Not yet authoritative** — the concrete design lands during the M20 design pass, informed by real cost data from M18. Captured here so the reasoning isn't lost between now and then.

**Status:** design-in-flight. Settled during M20.

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

- **Not the M20 implementation plan.** That gets written during the M20 design pass, once M18 has run long enough to see real cost shapes against real workloads.
- **Not a commitment to M9's deletion.** M9-style trimming stays available as a fallback if M18 cost data shows real conversations regularly bust context windows before they bust budgets. Most likely outcome: M9 dies; the schema delta here (`sessions.terminated_at`, `chatbots.handoff_*`) is the whole story. But the decision waits for data.
