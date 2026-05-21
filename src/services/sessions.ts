import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';

export interface Session {
  id: number;
  chatbot_id: number;
  token: string;
  summary: string | null;
  created_at: Date;
  last_active_at: Date;
  /**
   * Set when the M20 hard-cap triggered. Subsequent `POST /chat` on this
   * session returns the canned HANDOFF_HARD.md message without an LLM call.
   * Cleared by re-creating the session (a fresh token).
   */
  terminated_at: Date | null;
  /**
   * Captured at handoff via `POST /sessions/visitor-email` (M20). Admin-
   * readable only — the session-bearer scope can write a new value but
   * cannot read the current one. Webhook delivery includes it.
   */
  visitor_email: string | null;
  /** Set when the M20 handoff webhook delivered successfully. */
  handoff_notified_at: Date | null;
}

/**
 * Idle-expiry window for `findSessionByToken`. Sessions whose
 * `last_active_at` is older than this are treated as expired and not
 * resolvable, even if the row still exists in the DB.
 *
 * Hardcoded for v1 (the M20 design pass leaned "configurable later if
 * someone asks"). A primary risk this guards against is a shared
 * browser/device picking up an old session that has someone else's
 * `visitor_email` attached — the design conversation on 2026-05-21
 * settled on 24h as the bound.
 */
export const SESSION_IDLE_EXPIRY_HOURS = 24;

export type MessageRole = 'user' | 'assistant';

export interface Message {
  id: number;
  session_id: number;
  /** Denormalised from sessions for fast daily-spend SUM queries (M18). */
  chatbot_id: number;
  role: MessageRole;
  content: string;
  /** Prompt-side tokens reported by the adapter. NULL when adapter didn't report. */
  tokens_in: number | null;
  /** Completion-side tokens reported by the adapter. NULL when adapter didn't report. */
  tokens_out: number | null;
  /** USD cost estimate. DECIMAL → mysql2 returns string. 0.000000 for user rows and unmetered providers. */
  cost_usd_estimate: string;
  /** Anthropic prompt-cache writes. NULL until the post-M20 caching milestone wires it. */
  cache_creation_input_tokens: number | null;
  /** Anthropic prompt-cache reads. NULL until the post-M20 caching milestone wires it. */
  cache_read_input_tokens: number | null;
  created_at: Date;
}

export interface AppendMessageOpts {
  /**
   * Chatbot id for the denormalised `messages.chatbot_id` column. Required
   * because the column is NOT NULL; caller computes it from the same
   * resolution that picked the session.
   */
  chatbotId: number;
  /** Prompt-side tokens (the adapter's `tokensUsed.prompt`). */
  tokensIn?: number | null;
  /** Completion-side tokens (the adapter's `tokensUsed.completion`). */
  tokensOut?: number | null;
  /** USD cost estimate; column defaults to 0 if omitted. */
  costUsd?: number;
  /** Anthropic prompt-cache writes (post-M20 milestone surface). */
  cacheCreationTokens?: number | null;
  /** Anthropic prompt-cache reads (post-M20 milestone surface). */
  cacheReadTokens?: number | null;
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

/**
 * Resolve a session by token, honouring the M20 idle-expiry window.
 * Returns null for unknown tokens AND for sessions whose `last_active_at`
 * is older than `SESSION_IDLE_EXPIRY_HOURS` — collapsed to "invalid"
 * deliberately (same info-leak rationale as revoked admin keys).
 */
export async function findSessionByToken(db: Knex, token: string): Promise<Session | null> {
  const row = await db<Session>('sessions').where({ token }).first();
  if (!row) return null;
  const idleCutoff = new Date(Date.now() - SESSION_IDLE_EXPIRY_HOURS * 3600_000);
  if (row.last_active_at.getTime() < idleCutoff.getTime()) {
    return null;
  }
  return row;
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
 *
 * `opts.chatbotId` is required (the column is NOT NULL). Token + cost +
 * cache fields are optional — user-message rows typically pass none of them
 * (NULL tokens, default 0 cost); assistant-message rows pass everything the
 * adapter + cost helper produced.
 */
export async function appendMessage(
  db: Knex,
  sessionId: number,
  role: MessageRole,
  content: string,
  opts: AppendMessageOpts,
): Promise<Message> {
  return db.transaction(async (trx) => {
    const [id] = await trx('messages').insert({
      session_id: sessionId,
      chatbot_id: opts.chatbotId,
      role,
      content,
      tokens_in: opts.tokensIn ?? null,
      tokens_out: opts.tokensOut ?? null,
      cost_usd_estimate: opts.costUsd ?? 0,
      cache_creation_input_tokens: opts.cacheCreationTokens ?? null,
      cache_read_input_tokens: opts.cacheReadTokens ?? null,
    });
    await trx('sessions').where({ id: sessionId }).update({ last_active_at: trx.fn.now() });
    const row = await trx<Message>('messages').where({ id }).first();
    if (!row) {
      throw new Error(`appendMessage: insert succeeded but read-back failed for id=${id}`);
    }
    return row;
  });
}
