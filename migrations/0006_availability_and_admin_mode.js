/**
 * M21: per-chatbot operational hours + admin-mode session type.
 *
 * Per dev-notes/14-availability-and-admin-mode.md and the M21 design pass
 * on 2026-05-23.
 *
 * Chatbots gain:
 * - `timezone` — IANA timezone identifier (e.g. "Europe/London"). NULL = UTC.
 *   Always set per-chatbot because the API has no way to infer the WP
 *   site's timezone; the WP plugin syncs it.
 * - `availability` — JSON. Weekly schedule, per-day arrays of "HH:MM-HH:MM"
 *   strings. NULL = always open. See planning doc for shape.
 * - `admin_session_budget_usd` — per-session USD cap for admin-mode
 *   sessions only. NULL = unbounded (admin is trusted). Separate from
 *   `session_budget_usd` so operators can give admins headroom while
 *   keeping customer caps tight.
 *
 * Sessions gain:
 * - `is_admin_mode` — TRUE for sessions minted via
 *   POST /admin/chatbots/{slug}/sessions. Honoured throughout the chat
 *   path: bypass Origin + geo gates, use admin_session_budget_usd for
 *   hard-cap, suppress soft-handoff inject + webhook firing, excluded
 *   from getChatbotDailySpend aggregation.
 *
 * @param {import('knex').Knex} knex
 */
export const up = async (knex) => {
  await knex.schema.alterTable('chatbots', (t) => {
    t.string('timezone', 64).nullable().after('handoff_webhook_url');
    t.json('availability').nullable().after('timezone');
    t.decimal('admin_session_budget_usd', 10, 4).nullable().after('availability');
  });

  await knex.schema.alterTable('sessions', (t) => {
    t.boolean('is_admin_mode').notNullable().defaultTo(false).after('handoff_notified_at');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.alterTable('sessions', (t) => {
    t.dropColumn('is_admin_mode');
  });
  await knex.schema.alterTable('chatbots', (t) => {
    t.dropColumn('admin_session_budget_usd');
    t.dropColumn('availability');
    t.dropColumn('timezone');
  });
};
