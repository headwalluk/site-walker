# Privacy-friendly internal analytics

Planning sketch, not a milestone yet. Captures the design space for "what would be useful to know about chatbot sessions" without opening a GDPR / PII can of worms. Will firm into a real milestone (or get rejected entirely) once a concrete trigger lands.

## What prompted this

2026-05-25: while testing the chatbot on `headwall-hosting.com` in a private browsing window, the operator couldn't easily distinguish their own test sessions from real visitor sessions in `sw sessions list`. The natural instinct ("record the visitor's IP") would store personal data under most GDPR interpretations. We deliberately don't, and the operator agreed we shouldn't start.

So the question is: what's the **smallest** non-PII data we could capture (or what behaviour change could we make) that would meaningfully help an operator triage / analyse sessions, without crossing into "we hold personal data about visitors" territory.

## Today's state

What the `sessions` table holds:

- `id`, `chatbot_id`, `token`, `summary` (M9 placeholder, unused), `created_at`, `last_active_at`, `terminated_at`, `visitor_email`, `handoff_notified_at`, `is_admin_mode`.

What's available at request time but **deliberately not persisted**:

- Client IP (used live for rate limiting + geo lookup, never written to a DB row).
- Country code (looked up via MaxMind for geo policy decisions, decision is ephemeral).
- User-Agent string.
- `Accept-Language`.

What IS captured incidentally (in Apache + pino logs, retention-policy-dependent):

- Client IP per request, timestamped. Operator-side retention only; site-walker doesn't read these back.

Existing filters on `sw sessions list`:

- `--chatbot <slug>` (M7).
- `[admin]` marker on admin-mode rows (M21).

The gap: an operator's "I was just testing in private browsing" session looks identical to a real visitor's session.

## Use cases worth designing for

In rough order of likely usefulness:

1. **Operator test-session marking.** Filter the operator's own dogfooding sessions out of the real-traffic view. *This is the immediate trigger.*
2. **Aggregate session metrics.** Sessions/day, avg turns/session, fraction that captured a visitor email, fraction that hit the hard cap. Non-PII at aggregate.
3. **Country distribution.** Which countries chat the most? At the chatbot level. Country is generally not PII on its own (no individual identifiability).
4. **Funnel analysis.** What fraction of sessions: minted → first chat → ≥3 turns → email capture → hard cap. All aggregate.
5. **Performance metrics.** Mean/p95 response time, tokens-per-reply distribution, soft-handoff fire rate. Entirely operational, no visitor signal at all.

## Design space — sketches, not commitments

### Option A: operator-only "test session" minting

Smallest possible answer to the immediate need. Operator runs:

```
sw chatbot mint-test-session <slug>
```

The CLI mints a session row with a new `is_test BOOLEAN` flag, prints the token. Operator pastes the token into curl or the widget via dev-tools. `sw sessions list` gains an `[test]` marker and a `--exclude-test` flag (or makes exclusion the default).

- **Privacy footprint**: zero. Pure operator action, no visitor signal.
- **What it doesn't do**: doesn't help if the operator wants to test the full widget flow from a real browser without dev-tools surgery. (For that, you fall back to admin-mode sessions — but those require WP login.)
- **Cost**: one schema column + one CLI command + one filter. Small.

### Option B: client-claimed test marker with server-side trust check

Visitor sends a `X-Test-Session: <secret>` header on `POST /sessions`; server only honours it if the secret matches a per-deployment value (could be a chatbot-level field or env-level). Tagged session rows get `is_test=true`.

- **Privacy footprint**: zero (still no visitor data captured).
- **Footgun**: forgotten secret in a customer's hands could let them mark all their sessions as tests, hiding them from the operator. Mitigated by making the secret operator-only / WP-admin-gated.
- **Cost**: similar to A; slightly more surface.

### Option C: persist country code at session-mint — ✅ IMPLEMENTED 2026-06-09

Adds `sessions.country_code CHAR(2) NULL` (`0007_sessions_country_code.js`), populated at session-mint in `POST /sessions`. Captured for **every** session, not just geo-restricted chatbots: enforcement already resolves the country for `blocklist`/`allowlist` modes, and `allowall` (which short-circuits enforcement's lookup) gets one explicit `geoChecker.lookup(req.ip)`. NULL when unresolved (private/loopback IP, unindexed range, no GeoIP DB loaded). The IP itself is still never stored — only the 2-char code. Threaded through `createSession(db, chatbotId, { countryCode })`.

- **Privacy footprint**: country alone is generally not PII per ICO guidance, but combined with timestamp + chatbot it gets closer to identifiable. Lower-risk than IP, higher than nothing.
- **Operator value**: useful for "where's traffic actually coming from" and "who's the dev testing from the UK vs the customer's visitors in DE."
- **Cost**: one column + the persist-on-mint line. Tiny — `allowall` adds one in-memory mmdb lookup per mint (~microseconds).

**Surfaced via the admin API (2026-06-09):** `country_code` is now returned per-row by `GET /admin/chatbots/{slug}/sessions` and `GET /admin/chatbots/{slug}/sessions/{sessionId}` (M22 review surface) — `ChatbotSessionRow` + `sessionItemSchema`.

**Still on the shelf (not yet built):** the `sw sessions list` country column + `--country GB` / `--country '!GB'` filters, and any server-side filtering by country in the admin API. The GDPR sanity-check in the open question below still applies as the surface widens.

### Option D: User-Agent fingerprint hash

Hash `User-Agent + Accept-Language` to a short (8-char?) opaque id. Operator sessions cluster (same browser, same locale). Real visitors mostly look distinct enough.

- **Privacy footprint**: borderline. UA + AL is a known fingerprinting vector; hashing it makes it pseudonymous, not anonymous. Probably not what we want.
- **Recommendation**: skip.

### Option E: roll forward to a proper analytics surface

`sw chatbot stats <slug> [--since 24h]` returning aggregate counts. Number of sessions, avg turn count, soft-handoff fire rate, hard-cap rate, etc. Reads from the existing `sessions` + `messages` tables — needs no new schema.

- **Privacy footprint**: zero. Aggregates over data we already store.
- **Operator value**: matches use case 2 + 4 above. Independent of the test-marker question.
- **Cost**: a SQL aggregation query + a CLI surface. Pure additive.

## Non-goals (things we explicitly DO NOT want)

- **IP address storage on session rows.** Triggered the GDPR concern that started this doc; not crossing that line for an operator-convenience feature.
- **Persistent visitor IDs across sessions.** Site-walker is a stateless pre-sales bot per [README](../README.md); cross-session tracking would change the product, not the analytics.
- **Browser-side cookies / localStorage for identification.** No first-party fingerprinting.
- **Third-party analytics.** No Google Analytics, no Plausible, no anything — keep the chatbot itself stateless and unaffiliated with tracking surfaces.

## Open questions

1. **Which use case is the real pull?** Today only #1 (test marking) is concrete. The others are speculation. Don't design for them until a real ask shows up.
2. **Is Option A + Option E together the v1.x.y answer?** They're independent, cheap, and cover the immediate need + the most likely follow-up ("how's the bot doing?").
3. **Country code question**: would an operator's GDPR posture be materially different if we persisted country codes? Worth a quick legal sanity check before adopting Option C. UK ICO position is "an IP address is personal data in most contexts"; country alone is usually not. But "country + timestamp + chatbot" might re-cross the line for niche cases.
4. **Where does this sit relative to M13 (conversation retention + PII)?** M13 is the natural home for retention policy and PII redaction across the existing data. Analytics adds new data; M13 handles existing data. They're adjacent but separate. Sequence matters: if M13 lands first and sets the retention defaults, analytics inherits them.

## When this becomes a milestone

A trigger that would pull it forward:

- The operator (or a future operator) keeps asking the same question about a missing analytics view, and dev-tools / SQL queries against `sessions` no longer cut it.
- A customer asks "how many people chat with my bot per day, and from where?"
- M13 lands and we have a retention policy to inherit.

Until then this stays as ideas-on-the-shelf. Pulled forward = real design pass + numbered milestone.

## See also

- [`00-project-tracker.md`](00-project-tracker.md) — M13 (conversation retention + PII) is the adjacent below-the-line work.
- [`02-data-model.md`](02-data-model.md) — current `sessions` schema.
- [`../docs/api-usage.md`](../docs/api-usage.md) — what the visitor sees; "we don't store the visitor's IP" should probably get an explicit mention once we have a privacy posture committed to.
