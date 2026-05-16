/** @param {import('knex').Knex} knex */
export const up = async (knex) => {
  await knex.schema.createTable('website_origins', (t) => {
    t.increments('id').unsigned().primary();
    t.integer('website_id').unsigned().notNullable();
    t.string('origin', 255).notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.foreign('website_id').references('id').inTable('websites').onDelete('CASCADE');
    t.unique('origin');
    t.index('website_id');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.dropTable('website_origins');
};
