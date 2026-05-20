import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';

export interface Account {
  id: string;
  slug: string;
  name: string;
  created_at: Date;
  updated_at: Date;
}

export interface AccountCascadeCounts {
  chatbots: number;
  origins: number;
  sessions: number;
  messages: number;
}

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

function assertSlug(slug: string): void {
  if (!SLUG_PATTERN.test(slug)) {
    throw new Error(
      `Invalid slug "${slug}": must be 1–64 chars, lowercase alphanumeric + hyphens, ` +
        `cannot start or end with a hyphen.`,
    );
  }
}

export async function createAccount(
  db: Knex,
  input: { slug: string; name: string },
): Promise<Account> {
  assertSlug(input.slug);
  const id = randomUUID();
  await db('accounts').insert({ id, slug: input.slug, name: input.name });
  const row = await getAccountById(db, id);
  if (!row) {
    throw new Error(`createAccount: insert succeeded but read-back failed for id=${id}`);
  }
  return row;
}

export async function getAccountById(db: Knex, id: string): Promise<Account | null> {
  const row = await db<Account>('accounts').where({ id }).first();
  return row ?? null;
}

export async function getAccountBySlug(db: Knex, slug: string): Promise<Account | null> {
  const row = await db<Account>('accounts').where({ slug }).first();
  return row ?? null;
}

export async function listAccounts(db: Knex): Promise<Account[]> {
  return db<Account>('accounts').select('*').orderBy('slug', 'asc');
}

/**
 * Delete an account and CASCADE through chatbots → origins, sessions, messages,
 * geo_countries. Returns the cascade counts so the operator sees the blast
 * radius before the action becomes a regret.
 *
 * Counts are read in the same transaction as the delete so they match what
 * was actually removed.
 */
export async function deleteAccount(db: Knex, slug: string): Promise<AccountCascadeCounts> {
  return db.transaction(async (trx) => {
    const account = await trx<Account>('accounts').where({ slug }).first();
    if (!account) {
      throw new Error(`Account not found: slug="${slug}"`);
    }
    const [chatbotRow, originRow] = await Promise.all([
      trx('chatbots').where({ account_id: account.id }).count<{ n: number }[]>({ n: '*' }),
      trx('chatbot_origins')
        .join('chatbots', 'chatbots.id', 'chatbot_origins.chatbot_id')
        .where('chatbots.account_id', account.id)
        .count<{ n: number }[]>({ n: '*' }),
    ]);
    const sessionRow = await trx('sessions')
      .join('chatbots', 'chatbots.id', 'sessions.chatbot_id')
      .where('chatbots.account_id', account.id)
      .count<{ n: number }[]>({ n: '*' });
    const messageRow = await trx('messages')
      .join('sessions', 'sessions.id', 'messages.session_id')
      .join('chatbots', 'chatbots.id', 'sessions.chatbot_id')
      .where('chatbots.account_id', account.id)
      .count<{ n: number }[]>({ n: '*' });

    await trx('accounts').where({ id: account.id }).del();

    return {
      chatbots: Number(chatbotRow[0]?.n ?? 0),
      origins: Number(originRow[0]?.n ?? 0),
      sessions: Number(sessionRow[0]?.n ?? 0),
      messages: Number(messageRow[0]?.n ?? 0),
    };
  });
}
