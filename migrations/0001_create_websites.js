/** @param {import('knex').Knex} knex */
export const up = async (knex) => {
  await knex.schema.createTable('websites', (t) => {
    t.increments('id').unsigned().primary();
    t.string('slug', 64).notNullable().unique();
    t.string('name', 255).notNullable();
    t.text('welcome_message').nullable();
    t.string('model_slug', 128).nullable();
    t.json('model_parameters').nullable();
    t.integer('model_context_window').unsigned().nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.dropTable('websites');
};
