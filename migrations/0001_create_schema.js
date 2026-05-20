/**
 * M16 greenfield schema. Replaces pre-pivot migrations 0001..0006 in one shot.
 * Schema reference: dev-notes/02-data-model.md.
 *
 * @param {import('knex').Knex} knex
 */
export const up = async (knex) => {
  // --- accounts (new top-level entity) ---
  await knex.schema.createTable('accounts', (t) => {
    t.specificType('id', 'CHAR(36)').notNullable().primary();
    t.string('slug', 64).notNullable().unique();
    t.string('name', 255).notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));
  });

  // --- geo_modes (lookup, seeded; allowall is the safe default) ---
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

  // --- chatbots (renamed from websites; adds account_id FK) ---
  await knex.schema.createTable('chatbots', (t) => {
    t.increments('id').unsigned().primary();
    t.specificType('account_id', 'CHAR(36)').notNullable();
    t.string('slug', 64).notNullable().unique();
    t.string('name', 255).notNullable();
    t.text('welcome_message').nullable();
    t.text('persona').nullable();
    t.string('model_slug', 128).nullable();
    t.json('model_parameters').nullable();
    t.integer('model_context_window').unsigned().nullable();
    t.integer('geo_mode_id').unsigned().notNullable().defaultTo(allowAll.id);
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at')
      .notNullable()
      .defaultTo(knex.raw('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'));

    t.foreign('account_id').references('id').inTable('accounts').onDelete('CASCADE');
    t.foreign('geo_mode_id').references('id').inTable('geo_modes');
    t.index('account_id');
  });

  // --- chatbot_origins (renamed from website_origins) ---
  await knex.schema.createTable('chatbot_origins', (t) => {
    t.increments('id').unsigned().primary();
    t.integer('chatbot_id').unsigned().notNullable();
    t.string('origin', 255).notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.foreign('chatbot_id').references('id').inTable('chatbots').onDelete('CASCADE');
    t.unique('origin');
    t.index('chatbot_id');
  });

  // --- sessions (website_id → chatbot_id rename) ---
  await knex.schema.createTable('sessions', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.integer('chatbot_id').unsigned().notNullable();
    t.specificType('token', 'CHAR(64)').notNullable();
    t.text('summary').nullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    t.timestamp('last_active_at').notNullable().defaultTo(knex.fn.now());

    t.foreign('chatbot_id').references('id').inTable('chatbots').onDelete('CASCADE');
    t.unique('token');
    t.index(['chatbot_id', 'last_active_at'], 'idx_sessions_chatbot_last_active');
  });

  // --- messages (unchanged at M16; M18 will add tokens/cost columns) ---
  await knex.schema.createTable('messages', (t) => {
    t.bigIncrements('id').unsigned().primary();
    t.bigInteger('session_id').unsigned().notNullable();
    t.enu('role', ['user', 'assistant']).notNullable();
    t.text('content').notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.foreign('session_id').references('id').inTable('sessions').onDelete('CASCADE');
    t.index(['session_id', 'created_at'], 'idx_messages_session_created');
  });

  // --- chatbot_geo_countries (renamed from website_geo_countries) ---
  await knex.schema.createTable('chatbot_geo_countries', (t) => {
    t.increments('id').unsigned().primary();
    t.integer('chatbot_id').unsigned().notNullable();
    t.string('country_code', 2).notNullable();
    t.timestamp('created_at').notNullable().defaultTo(knex.fn.now());

    t.foreign('chatbot_id').references('id').inTable('chatbots').onDelete('CASCADE');
    t.unique(['chatbot_id', 'country_code']);
    t.index('chatbot_id');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  // Reverse FK-dependency order.
  await knex.schema.dropTable('chatbot_geo_countries');
  await knex.schema.dropTable('messages');
  await knex.schema.dropTable('sessions');
  await knex.schema.dropTable('chatbot_origins');
  await knex.schema.dropTable('chatbots');
  await knex.schema.dropTable('geo_modes');
  await knex.schema.dropTable('accounts');
};
