import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';

export interface Session {
  id: number;
  chatbot_id: number;
  token: string;
  summary: string | null;
  created_at: Date;
  last_active_at: Date;
}

export type MessageRole = 'user' | 'assistant';

export interface Message {
  id: number;
  session_id: number;
  role: MessageRole;
  content: string;
  created_at: Date;
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

export async function createSession(db: Knex, chatbotId: number): Promise<Session> {
  const token = generateToken();
  const [id] = await db('sessions').insert({ chatbot_id: chatbotId, token });
  const row = await db<Session>('sessions').where({ id }).first();
  if (!row) {
    throw new Error(`createSession: insert succeeded but read-back failed for id=${id}`);
  }
  return row;
}

export async function findSessionByToken(db: Knex, token: string): Promise<Session | null> {
  const row = await db<Session>('sessions').where({ token }).first();
  return row ?? null;
}

export interface SessionWithMeta extends Session {
  chatbot_slug: string;
  message_count: number;
}

export interface ListSessionsOpts {
  /** Filter to a single chatbot slug. */
  chatbotSlug?: string;
  /** Maximum rows returned. Defaults to 20; capped at 200. */
  limit?: number;
}

/**
 * Read-only browse over sessions. Joins through to `chatbots` for the slug
 * and aggregates `messages` for a count, so the operator-facing listing is
 * useful at a glance without N+1 round-trips. Most-recently-active first.
 */
export async function listSessions(
  db: Knex,
  opts: ListSessionsOpts = {},
): Promise<SessionWithMeta[]> {
  const limit = Math.min(200, Math.max(1, opts.limit ?? 20));
  const query = db('sessions as s')
    .join('chatbots as c', 'c.id', 's.chatbot_id')
    .leftJoin('messages as m', 'm.session_id', 's.id')
    .select<
      SessionWithMeta[]
    >('s.id', 's.chatbot_id', 's.token', 's.summary', 's.created_at', 's.last_active_at', { chatbot_slug: 'c.slug' })
    .count<{ message_count: string | number }[]>({ message_count: 'm.id' })
    .groupBy(
      's.id',
      's.chatbot_id',
      's.token',
      's.summary',
      's.created_at',
      's.last_active_at',
      'c.slug',
    )
    .orderBy('s.last_active_at', 'desc')
    .limit(limit);

  if (opts.chatbotSlug) {
    query.andWhere('c.slug', opts.chatbotSlug);
  }

  const rows = (await query) as Array<SessionWithMeta & { message_count: string | number }>;
  return rows.map((r) => ({ ...r, message_count: Number(r.message_count) }));
}

/**
 * Look up a session by either numeric id (digits only) or full token.
 * Returns null when neither match — callers decide the failure mode.
 */
export async function findSessionByTokenOrId(db: Knex, ref: string): Promise<Session | null> {
  if (/^\d+$/.test(ref)) {
    const row = await db<Session>('sessions')
      .where({ id: Number(ref) })
      .first();
    return row ?? null;
  }
  return findSessionByToken(db, ref);
}

export async function listMessages(db: Knex, sessionId: number): Promise<Message[]> {
  return db<Message>('messages')
    .where({ session_id: sessionId })
    .orderBy('created_at', 'asc')
    .orderBy('id', 'asc');
}

/**
 * Append a turn to a session and bump `last_active_at` in the same transaction
 * so retention sweeps and the message list never disagree.
 */
export async function appendMessage(
  db: Knex,
  sessionId: number,
  role: MessageRole,
  content: string,
): Promise<Message> {
  return db.transaction(async (trx) => {
    const [id] = await trx('messages').insert({ session_id: sessionId, role, content });
    await trx('sessions').where({ id: sessionId }).update({ last_active_at: trx.fn.now() });
    const row = await trx<Message>('messages').where({ id }).first();
    if (!row) {
      throw new Error(`appendMessage: insert succeeded but read-back failed for id=${id}`);
    }
    return row;
  });
}
