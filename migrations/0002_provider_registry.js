/**
 * M17: DB-backed provider registry + chatbot BYO LLM keys.
 *
 * Replaces `site-walker.toml` with `providers` + `provider_models` tables, and
 * adds AES-256-GCM-encrypted columns on `chatbots` for bring-your-own-key
 * LLM credentials. Per dev-notes/10-saas-shape.md and 02-data-model.md.
 *
 * @param {import('knex').Knex} knex
 */
export const up = async (knex) => {
  // --- providers (replaces the [providers] table in site-walker.toml) ---
  await knex.schema.createTable('providers', (t) => {
    t.increments('id').unsigned().primary();
    t.string('name', 64).notNullable().unique();
    t.string('protocol', 32).notNullable();
    t.string('base_url', 255).notNullable();
    t.boolean('is_local').notNullable().defaultTo(false);
    t.boolean('is_metered').notNullable().defaultTo(true);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
  });

  // --- provider_models ---
  await knex.schema.createTable('provider_models', (t) => {
    t.increments('id').unsigned().primary();
    t.integer('provider_id').unsigned().notNullable();
    t.string('model_slug', 128).notNullable();
    t.integer('context_window').unsigned().notNullable();
    t.decimal('input_per_million_usd', 10, 6).nullable();
    t.decimal('output_per_million_usd', 10, 6).nullable();
    t.boolean('is_available').notNullable().defaultTo(true);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    t.foreign('provider_id').references('id').inTable('providers').onDelete('CASCADE');
    t.unique(['provider_id', 'model_slug']);
  });

  // --- chatbots: AES-256-GCM-encrypted BYO LLM key columns ---
  //
  // Three columns rather than one packed blob: schema-readable, dirt-cheap to
  // query (almost never), and the auth tag is required for AEAD decryption —
  // omitting it would mean we couldn't tell if the ciphertext was tampered.
  await knex.schema.alterTable('chatbots', (t) => {
    t.specificType('provider_api_key_ciphertext', 'VARBINARY(255)')
      .nullable()
      .after('model_context_window');
    t.specificType('provider_api_key_nonce', 'BINARY(12)')
      .nullable()
      .after('provider_api_key_ciphertext');
    t.specificType('provider_api_key_auth_tag', 'BINARY(16)')
      .nullable()
      .after('provider_api_key_nonce');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.alterTable('chatbots', (t) => {
    t.dropColumn('provider_api_key_auth_tag');
    t.dropColumn('provider_api_key_nonce');
    t.dropColumn('provider_api_key_ciphertext');
  });
  await knex.schema.dropTable('provider_models');
  await knex.schema.dropTable('providers');
};
