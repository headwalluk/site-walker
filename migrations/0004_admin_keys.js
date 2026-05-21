/**
 * M19: account admin keys.
 *
 * One row per account-scoped admin key. Provisioning keys are deliberately
 * NOT in this table — they live in `.env` as `SW_PROVISIONING_KEY`, per the
 * air-gap design in dev-notes/10-saas-shape.md ("Why SW_PROVISIONING_KEY is
 * not in admin_keys"). Every row here has `account_id NOT NULL`.
 *
 * Hash at rest: only the sha-256 hex of the raw key is stored. The raw key
 * is shown exactly once at mint time and never again — GitHub-PAT style.
 *
 * @param {import('knex').Knex} knex
 */
export const up = async (knex) => {
  await knex.schema.createTable('admin_keys', (t) => {
    t.specificType('id', 'CHAR(36)').notNullable().primary();
    t.specificType('account_id', 'CHAR(36)').notNullable();
    // sha-256 hex of the entire raw key (prefix included). 64 chars.
    t.specificType('token_hash', 'CHAR(64)').notNullable();
    t.string('description', 255).nullable();
    t.timestamp('last_used_at').nullable();
    t.timestamp('revoked_at').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.unique('token_hash');
    t.index('account_id');
    t.foreign('account_id').references('id').inTable('accounts').onDelete('CASCADE');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.dropTable('admin_keys');
};
