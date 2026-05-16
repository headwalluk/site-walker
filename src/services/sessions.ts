import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';

export interface Session {
  id: number;
  website_id: number;
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

export async function createSession(db: Knex, websiteId: number): Promise<Session> {
  const token = generateToken();
  const [id] = await db('sessions').insert({ website_id: websiteId, token });
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
