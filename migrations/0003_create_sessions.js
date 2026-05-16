/** @param {import('knex').Knex} knex */
export const up = async (knex) => {
  await knex.schema.createTable('sessions', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.integer('website_id').unsigned().notNullable();
    t.specificType('token', 'CHAR(64)').notNullable();
    t.text('summary').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_active_at').notNullable().defaultTo(knex.fn.now());

    t.foreign('website_id').references('id').inTable('websites').onDelete('CASCADE');
    t.unique('token');
    t.index(['website_id', 'last_active_at'], 'idx_sessions_website_last_active');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.dropTable('sessions');
};
