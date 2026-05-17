/** @param {import('knex').Knex} knex */
export const up = async (knex) => {
  await knex.schema.createTable('geo_modes', (t) => {
    t.increments('id').unsigned().primary();
    t.string('code', 32).notNullable().unique();
    t.string('label', 128).notNullable();
  });

  await knex('geo_modes').insert([
    { code: 'allowall', label: 'Country list ignored — all visitors accepted' },
    { code: 'blocklist', label: 'Block visitors from listed countries' },
    { code: 'allowlist', label: 'Only allow visitors from listed countries' },
  ]);

  const allowAll = await knex('geo_modes').where({ code: 'allowall' }).first('id');

  await knex.schema.alterTable('websites', (t) => {
    t.integer('geo_mode_id')
      .unsigned()
      .notNullable()
      .defaultTo(allowAll.id)
      .after('model_context_window');
    t.foreign('geo_mode_id').references('id').inTable('geo_modes');
  });

  await knex.schema.createTable('website_geo_countries', (t) => {
    t.increments('id').unsigned().primary();
    t.integer('website_id').unsigned().notNullable();
    t.string('country_code', 2).notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.foreign('website_id').references('id').inTable('websites').onDelete('CASCADE');
    t.unique(['website_id', 'country_code']);
    t.index('website_id');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.dropTable('website_geo_countries');
  await knex.schema.alterTable('websites', (t) => {
    t.dropForeign('geo_mode_id');
    t.dropColumn('geo_mode_id');
  });
  await knex.schema.dropTable('geo_modes');
};
