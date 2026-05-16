/** @param {import('knex').Knex} knex */
export const up = async (knex) => {
  await knex.schema.alterTable('websites', (t) => {
    t.text('persona').nullable().after('welcome_message');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.alterTable('websites', (t) => {
    t.dropColumn('persona');
  });
};
