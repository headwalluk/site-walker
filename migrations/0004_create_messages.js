/** @param {import('knex').Knex} knex */
export const up = async (knex) => {
  await knex.schema.createTable('messages', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('session_id').unsigned().notNullable();
    t.enu('role', ['user', 'assistant']).notNullable();
    t.text('content').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.foreign('session_id').references('id').inTable('sessions').onDelete('CASCADE');
    t.index(['session_id', 'created_at'], 'idx_messages_session_created');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.dropTable('messages');
};
