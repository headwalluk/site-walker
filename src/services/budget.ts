import type { Knex } from 'knex';

/**
 * Per-chatbot daily + per-session spend aggregation, plus the typed-error
 * vocabulary the chat path uses to refuse turns that would bust a cap.
 *
 * Per dev-notes/11-budget-handoff.md and the M20 design pass on 2026-05-21.
 *
 * **Time zone for "daily".** The cap resets at 00:00 UTC, hardcoded. The
 * cost of an operator-configurable timezone (DST handling, per-chatbot
 * preference) is higher than the cost of "your bot's daily window is UTC."
 * Document loudly; revisit only if a real customer asks.
 */

/**
 * The start of "today" in UTC — the lower bound for SUM(daily spend).
 * Construction is intentionally cheap so it's safe to call once per
 * request without caching.
 */
export function utcMidnightToday(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
}

/**
 * Sum a chatbot's spend across `messages.cost_usd_estimate` for the
 * UTC-anchored daily window. Uses the M18 composite index
 * `(chatbot_id, created_at)`.
 *
 * M21: excludes admin-mode sessions from the aggregate. Admin spend is
 * tracked (every `messages` row still gets `cost_usd_estimate`) and surfaces
 * in `sw chatbot usage` separately, but it doesn't displace customer-facing
 * daily-cap budget — otherwise an admin's morning of testing would lock
 * out real visitors for the rest of the day.
 */
export async function getChatbotDailySpend(
  db: Knex,
  chatbotId: number,
  since: Date = utcMidnightToday(),
): Promise<number> {
  const row = await db('messages')
    .join('sessions', 'sessions.id', 'messages.session_id')
    .where('messages.chatbot_id', chatbotId)
    .andWhere('messages.created_at', '>=', since)
    .andWhere('sessions.is_admin_mode', false)
    .sum<{ total: string | number | null }[]>({ total: 'messages.cost_usd_estimate' })
    .first();
  return Number(row?.total ?? 0);
}

/** Sum the spend for a single session. Used by the after-write session cap check. */
export async function getSessionSpend(db: Knex, sessionId: number): Promise<number> {
  const row = await db('messages')
    .where({ session_id: sessionId })
    .sum<{ total: string | number | null }[]>({ total: 'cost_usd_estimate' })
    .first();
  return Number(row?.total ?? 0);
}

/**
 * Pure helper — returns true when the daily cap has been exhausted.
 * Caller is responsible for fetching the cap value off the chatbot row
 * (the cap may be NULL, in which case "no cap" applies; this helper
 * receives the already-resolved number-or-null).
 */
export function isDailyBudgetExhausted(spendUsd: number, capUsd: number | null): boolean {
  if (capUsd === null) return false;
  return spendUsd >= capUsd;
}

/**
 * Same shape for the session cap. The hard-cap behaviour is asymmetric vs
 * daily: the session cap is checked AFTER the assistant reply is written,
 * so a visitor who's exactly one message over the cap gets that one final
 * reply rather than being cut off mid-thought. The chat path applies this
 * convention; this helper is the pure check.
 */
export function isSessionBudgetExhausted(spendUsd: number, capUsd: number | null): boolean {
  if (capUsd === null) return false;
  return spendUsd >= capUsd;
}

/**
 * Cap-resolution: parse the DECIMAL string mysql2 returns into a number.
 * Reuses the same shape `chat.ts::parseNullableDecimal` uses for pricing.
 */
export function parseCapDecimal(value: string | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}
