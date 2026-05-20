import knex, { type Knex } from 'knex';
import { env } from '../config/env.js';
import { loadEncryptionKey } from '../config/secrets.js';
import { encrypt } from '../utils/crypto.js';
import { createAccount, type Account } from '../services/accounts.js';
import { createChatbot, type Chatbot } from '../services/chatbots.js';

/**
 * Shared knex factory for integration tests. Each test that needs DB access
 * calls this and `.destroy()`s the result in its `t.after` so the pool
 * doesn't leak. Connection details come from the runtime env — see
 * `src/config/env.ts`.
 */
export function makeTestDb(): Knex {
  return knex({
    client: 'mysql2',
    connection: {
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.name,
    },
    pool: { min: 0, max: 5 },
  });
}

/**
 * Create a throwaway account + chatbot for a single test. `chatbotSlug` is
 * the test-supplied unique slug; the account gets `<slug>-acct` so it's
 * obviously paired without colliding with anything else.
 *
 * Cleanup is the caller's job — delete the account row in `t.after` and the
 * chatbot (plus origins, sessions, messages, geo_countries) cascades away.
 */
export async function seedAccountAndChatbot(
  db: Knex,
  chatbotSlug: string,
  opts: { name?: string; persona?: string | null } = {},
): Promise<{ account: Account; chatbot: Chatbot }> {
  const account = await createAccount(db, {
    slug: `${chatbotSlug}-acct`,
    name: `${chatbotSlug} account`,
  });
  const chatbot = await createChatbot(db, {
    account_id: account.id,
    slug: chatbotSlug,
    name: opts.name ?? chatbotSlug,
    persona: opts.persona ?? null,
  });
  return { account, chatbot };
}

/**
 * Encrypt `plainKey` with the loaded `SW_ENCRYPTION_KEY` and write the three
 * `chatbots.provider_api_key_*` columns. Used by tests that need to exercise
 * the metered-provider chat path (which fails loud without a key).
 */
export async function setTestChatbotApiKey(
  db: Knex,
  chatbotId: number,
  plainKey: string,
): Promise<void> {
  const masterKey = loadEncryptionKey();
  const secret = encrypt(plainKey, masterKey);
  await db('chatbots').where({ id: chatbotId }).update({
    provider_api_key_ciphertext: secret.ciphertext,
    provider_api_key_nonce: secret.nonce,
    provider_api_key_auth_tag: secret.authTag,
  });
}
