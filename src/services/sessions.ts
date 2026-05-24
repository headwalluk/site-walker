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
  /**
   * M21: TRUE for sessions minted via `POST /admin/chatbots/{slug}/sessions`.
   * Honoured throughout the chat path — bypass Origin + geo gates, use
   * `chatbots.admin_session_budget_usd` for hard-cap, suppress soft-handoff
   * inject + webhook firing. Excluded from `getChatbotDailySpend`.
   */
  is_admin_mode: boolean;
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

export async function createSession(
  db: Knex,
  chatbotId: number,
  opts: { isAdminMode?: boolean } = {},
): Promise<Session> {
  const token = generateToken();
  const [id] = await db('sessions').insert({
    chatbot_id: chatbotId,
    token,
    is_admin_mode: opts.isAdminMode === true,
  });
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
  // mysql2 returns BOOLEAN as 0/1; surface a real boolean so downstream
  // truthiness checks (e.g. `if (session.is_admin_mode)`) behave correctly.
  row.is_admin_mode = Boolean(row.is_admin_mode);
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
    >('s.id', 's.chatbot_id', 's.token', 's.summary', 's.created_at', 's.last_active_at', 's.is_admin_mode', { chatbot_slug: 'c.slug' })
    .count<{ message_count: string | number }[]>({ message_count: 'm.id' })
    .groupBy(
      's.id',
      's.chatbot_id',
      's.token',
      's.summary',
      's.created_at',
      's.last_active_at',
      's.is_admin_mode',
      'c.slug',
    )
    .orderBy('s.last_active_at', 'desc')
    .limit(limit);

  if (opts.chatbotSlug) {
    query.andWhere('c.slug', opts.chatbotSlug);
  }

  const rows = (await query) as Array<SessionWithMeta & { message_count: string | number }>;
  return rows.map((r) => ({
    ...r,
    message_count: Number(r.message_count),
    // mysql2 returns BOOLEAN as 0/1; surface a real boolean.
    is_admin_mode: Boolean(r.is_admin_mode),
  }));
}

/**
 * M22 admin browse: one row of `listSessionsForChatbot` / `getSessionForChatbot`.
 *
 * Deliberately does NOT carry `token` — that's the visitor's `POST /chat`
 * bearer; leaking it through the admin surface would create a hijack-capable
 * credential. The admin surface addresses sessions by integer `id` instead.
 *
 * Aggregates (`message_count`, `tokens_in`, `tokens_out`, `cost_usd_estimate`)
 * are computed at the session level. Per-message cost is not exposed; an
 * aggregated estimate is sufficient given we don't do multi-request agentic
 * tooling or mid-conversation model switching.
 */
export interface ChatbotSessionRow {
  id: number;
  chatbot_id: number;
  created_at: Date;
  last_active_at: Date;
  terminated_at: Date | null;
  visitor_email: string | null;
  is_admin_mode: boolean;
  message_count: number;
  tokens_in: number;
  tokens_out: number;
  cost_usd_estimate: number;
}

export interface ListSessionsForChatbotOpts {
  /** 1-indexed page number. Default 1. */
  page?: number;
  /** Rows per page. Default 20, capped at 100. */
  pageSize?: number;
}

export interface ListSessionsForChatbotResult {
  sessions: ChatbotSessionRow[];
  total: number;
  page: number;
  page_size: number;
}

const SESSIONS_PAGE_SIZE_DEFAULT = 20;
const SESSIONS_PAGE_SIZE_MAX = 100;

type RawChatbotSessionRow = {
  id: number;
  chatbot_id: number;
  created_at: Date;
  last_active_at: Date;
  terminated_at: Date | null;
  visitor_email: string | null;
  is_admin_mode: number | boolean;
  message_count: string | number;
  tokens_in_sum: string | number | null;
  tokens_out_sum: string | number | null;
  cost_sum: string | number | null;
};

function normaliseChatbotSessionRow(r: RawChatbotSessionRow): ChatbotSessionRow {
  return {
    id: r.id,
    chatbot_id: r.chatbot_id,
    created_at: r.created_at,
    last_active_at: r.last_active_at,
    terminated_at: r.terminated_at,
    visitor_email: r.visitor_email,
    is_admin_mode: Boolean(r.is_admin_mode),
    message_count: Number(r.message_count ?? 0),
    tokens_in: Number(r.tokens_in_sum ?? 0),
    tokens_out: Number(r.tokens_out_sum ?? 0),
    cost_usd_estimate: Number(r.cost_sum ?? 0),
  };
}

/**
 * M22 admin browse: paginated session list for one chatbot, ordered by
 * `last_active_at DESC`. Joins `messages` so each row carries aggregated
 * count + token + cost totals — saves an N+1 trip from the WP plugin.
 *
 * No filters in v1 beyond pagination. Date-range / geo / segment filters
 * are a future addition (settled in the M22 design pass).
 */
export async function listSessionsForChatbot(
  db: Knex,
  chatbotId: number,
  opts: ListSessionsForChatbotOpts = {},
): Promise<ListSessionsForChatbotResult> {
  const pageSize = Math.min(
    SESSIONS_PAGE_SIZE_MAX,
    Math.max(1, Math.floor(opts.pageSize ?? SESSIONS_PAGE_SIZE_DEFAULT)),
  );
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const offset = (page - 1) * pageSize;

  const [countRow, rows] = await Promise.all([
    db('sessions')
      .where({ chatbot_id: chatbotId })
      .count<{ total: string | number }[]>({ total: 'id' })
      .first(),
    db('sessions as s')
      .leftJoin('messages as m', 'm.session_id', 's.id')
      .where('s.chatbot_id', chatbotId)
      .select(
        's.id',
        's.chatbot_id',
        's.created_at',
        's.last_active_at',
        's.terminated_at',
        's.visitor_email',
        's.is_admin_mode',
      )
      .count({ message_count: 'm.id' })
      .sum({ tokens_in_sum: 'm.tokens_in' })
      .sum({ tokens_out_sum: 'm.tokens_out' })
      .sum({ cost_sum: 'm.cost_usd_estimate' })
      .groupBy(
        's.id',
        's.chatbot_id',
        's.created_at',
        's.last_active_at',
        's.terminated_at',
        's.visitor_email',
        's.is_admin_mode',
      )
      // Tie-break by id DESC so two sessions that share a `last_active_at`
      // value (DATETIME is 1-second resolution on MariaDB's default config)
      // sort deterministically — most-recently-inserted first.
      .orderBy('s.last_active_at', 'desc')
      .orderBy('s.id', 'desc')
      .limit(pageSize)
      .offset(offset),
  ]);

  const total = Number(countRow?.total ?? 0);
  const sessions = (rows as RawChatbotSessionRow[]).map(normaliseChatbotSessionRow);
  return { sessions, total, page, page_size: pageSize };
}

/**
 * M22 admin browse: one session by id, only if it belongs to the given
 * chatbot. Returns null when the session doesn't exist OR exists under a
 * different chatbot — collapsed deliberately so route handlers can surface
 * a single `404 not_found` without leaking cross-chatbot existence.
 */
export async function getSessionForChatbot(
  db: Knex,
  chatbotId: number,
  sessionId: number,
): Promise<ChatbotSessionRow | null> {
  const row = (await db('sessions as s')
    .leftJoin('messages as m', 'm.session_id', 's.id')
    .where({ 's.id': sessionId, 's.chatbot_id': chatbotId })
    .select(
      's.id',
      's.chatbot_id',
      's.created_at',
      's.last_active_at',
      's.terminated_at',
      's.visitor_email',
      's.is_admin_mode',
    )
    .count({ message_count: 'm.id' })
    .sum({ tokens_in_sum: 'm.tokens_in' })
    .sum({ tokens_out_sum: 'm.tokens_out' })
    .sum({ cost_sum: 'm.cost_usd_estimate' })
    .groupBy(
      's.id',
      's.chatbot_id',
      's.created_at',
      's.last_active_at',
      's.terminated_at',
      's.visitor_email',
      's.is_admin_mode',
    )
    .first()) as RawChatbotSessionRow | undefined;
  if (!row) return null;
  return normaliseChatbotSessionRow(row);
}

/**
 * M22 admin browse: messages for one session, scoped to a chatbot. Returns
 * null when the session doesn't exist or belongs to a different chatbot
 * (collapsed for the same `404 not_found` reason as `getSessionForChatbot`).
 */
export async function listMessagesForChatbot(
  db: Knex,
  chatbotId: number,
  sessionId: number,
): Promise<Message[] | null> {
  const session = await db<{ id: number; chatbot_id: number }>('sessions')
    .select('id', 'chatbot_id')
    .where({ id: sessionId, chatbot_id: chatbotId })
    .first();
  if (!session) return null;
  return listMessages(db, sessionId);
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
