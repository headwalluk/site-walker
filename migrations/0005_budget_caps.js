/**
 * M20: per-chatbot budget caps + session-handoff state.
 *
 * Per dev-notes/11-budget-handoff.md and the M20 design pass on 2026-05-21.
 *
 * Chatbots gain:
 * - `daily_budget_usd` / `session_budget_usd` — NULL means no cap.
 * - `handoff_threshold_pct` — % of session_budget_usd that triggers the
 *   soft-handoff system block (HANDOFF_SOFT.md). NOT NULL with a default
 *   so the soft-handoff logic doesn't need to NULL-check.
 * - `handoff_webhook_url` — operator's webhook target for handoff
 *   notifications. NULL = no webhook (operator polls the DB instead, or
 *   doesn't care).
 *
 * Sessions gain:
 * - `terminated_at` — set when hard-cap triggered. Subsequent POST /chat
 *   on this session returns the canned HANDOFF_HARD.md message without
 *   an LLM call.
 * - `visitor_email` — captured at handoff via POST /sessions/visitor-email.
 *   Write-only at the session-bearer scope; admin-readable. Never echoed
 *   back to the visitor's browser.
 * - `handoff_notified_at` — set when the webhook delivered successfully.
 *
 * @param {import('knex').Knex} knex
 */
export const up = async (knex) => {
  await knex.schema.alterTable('chatbots', (t) => {
    t.decimal('daily_budget_usd', 10, 4).nullable().after('model_context_window');
    t.decimal('session_budget_usd', 10, 4).nullable().after('daily_budget_usd');
    t.tinyint('handoff_threshold_pct')
      .unsigned()
      .notNullable()
      .defaultTo(80)
      .after('session_budget_usd');
    t.string('handoff_webhook_url', 255).nullable().after('handoff_threshold_pct');
  });

  await knex.schema.alterTable('sessions', (t) => {
    t.timestamp('terminated_at').nullable().after('last_active_at');
    t.string('visitor_email', 255).nullable().after('terminated_at');
    t.timestamp('handoff_notified_at').nullable().after('visitor_email');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.alterTable('sessions', (t) => {
    t.dropColumn('handoff_notified_at');
    t.dropColumn('visitor_email');
    t.dropColumn('terminated_at');
  });
  await knex.schema.alterTable('chatbots', (t) => {
    t.dropColumn('handoff_webhook_url');
    t.dropColumn('handoff_threshold_pct');
    t.dropColumn('session_budget_usd');
    t.dropColumn('daily_budget_usd');
  });
};
