/**
 * M18: cost accounting (foundation, no enforcement).
 *
 * Records token counts + USD cost estimate on every assistant message row.
 * Denormalises `chatbot_id` onto `messages` so daily-spend SUM queries don't
 * have to join through `sessions`. Reserves columns for Anthropic prompt
 * caching (substrate-only; the cache_creation_input_tokens and
 * cache_read_input_tokens columns stay NULL until the cache-wiring
 * follow-up milestone post-M20).
 *
 * Per dev-notes/10-saas-shape.md and the M18 design pass on 2026-05-20.
 *
 * @param {import('knex').Knex} knex
 */
export const up = async (knex) => {
  // Step 1: add new columns. chatbot_id starts nullable so the backfill
  // can populate it before we tighten to NOT NULL.
  await knex.schema.alterTable('messages', (t) => {
    t.integer('chatbot_id').unsigned().nullable().after('session_id');
    t.integer('tokens_in').unsigned().nullable().after('content');
    t.integer('tokens_out').unsigned().nullable().after('tokens_in');
    t.decimal('cost_usd_estimate', 10, 6).notNullable().defaultTo(0).after('tokens_out');
    t.integer('cache_creation_input_tokens').unsigned().nullable().after('cost_usd_estimate');
    t.integer('cache_read_input_tokens').unsigned().nullable().after('cache_creation_input_tokens');
  });

  // Step 2: backfill chatbot_id from the owning session.
  await knex.raw(`
    UPDATE messages m
    INNER JOIN sessions s ON s.id = m.session_id
    SET m.chatbot_id = s.chatbot_id
  `);

  // Step 3: tighten chatbot_id to NOT NULL, add FK CASCADE + composite index
  // for daily-spend SUM queries scoped to a chatbot + time window.
  await knex.schema.alterTable('messages', (t) => {
    t.integer('chatbot_id').unsigned().notNullable().alter();
    t.foreign('chatbot_id').references('id').inTable('chatbots').onDelete('CASCADE');
    t.index(['chatbot_id', 'created_at'], 'idx_messages_chatbot_created');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.alterTable('messages', (t) => {
    t.dropIndex(['chatbot_id', 'created_at'], 'idx_messages_chatbot_created');
    t.dropForeign('chatbot_id');
    t.dropColumn('cache_read_input_tokens');
    t.dropColumn('cache_creation_input_tokens');
    t.dropColumn('cost_usd_estimate');
    t.dropColumn('tokens_out');
    t.dropColumn('tokens_in');
    t.dropColumn('chatbot_id');
  });
};
