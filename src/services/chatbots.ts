import type { Knex } from 'knex';

export interface ModelParameters {
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string[];
}

export interface Chatbot {
  id: number;
  account_id: string;
  slug: string;
  name: string;
  welcome_message: string | null;
  persona: string | null;
  model_slug: string | null;
  model_parameters: ModelParameters | null;
  model_context_window: number | null;
  /**
   * AES-256-GCM-encrypted BYO LLM provider API key. All three columns are
   * either all NULL (no key set) or all non-NULL (decryptable). Decryption
   * happens in `chat.ts` at request time via `src/utils/crypto.ts` + the
   * master key from `SW_ENCRYPTION_KEY`. Never logged. The DB row carries
   * the raw Buffer values; the CLI never reads them back out.
   */
  provider_api_key_ciphertext: Buffer | null;
  provider_api_key_nonce: Buffer | null;
  provider_api_key_auth_tag: Buffer | null;
  created_at: Date;
  updated_at: Date;
}

export interface ChatbotOrigin {
  id: number;
  chatbot_id: number;
  origin: string;
  created_at: Date;
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

/**
 * Validate and normalise a browser `Origin` string.
 * Per dev-notes/01-auth-and-session-flow.md: exact-match origins (scheme + host
 * only, no path, no query, no trailing slash). Host is lower-cased; default
 * ports (80/443) are omitted per HTTP convention. `http://` and `https://`
 * variants of the same host are distinct origins.
 */
export function normaliseOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new Error(`Invalid origin "${input}": not a parseable URL.`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Invalid origin "${input}": scheme must be http or https.`);
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error(`Invalid origin "${input}": must not include a path.`);
  }
  if (url.search || url.hash) {
    throw new Error(`Invalid origin "${input}": must not include a query or fragment.`);
  }
  const host = url.host.toLowerCase();
  return `${url.protocol}//${host}`;
}

export async function createChatbot(
  db: Knex,
  input: { account_id: string; slug: string; name: string; persona?: string | null },
): Promise<Chatbot> {
  assertSlug(input.slug);
  const [id] = await db('chatbots').insert({
    account_id: input.account_id,
    slug: input.slug,
    name: input.name,
    persona: input.persona ?? null,
  });
  const row = await getChatbotById(db, id);
  if (!row) {
    throw new Error(`createChatbot: insert succeeded but read-back failed for id=${id}`);
  }
  return row;
}

export async function setPersona(db: Knex, slug: string, persona: string): Promise<Chatbot> {
  const chatbot = await getChatbotBySlug(db, slug);
  if (!chatbot) {
    throw new Error(`Chatbot not found: slug="${slug}"`);
  }
  await db('chatbots').where({ id: chatbot.id }).update({ persona });
  const updated = await getChatbotById(db, chatbot.id);
  if (!updated) {
    throw new Error(`setPersona: update succeeded but read-back failed for id=${chatbot.id}`);
  }
  return updated;
}

function normaliseChatbotRow(row: Chatbot | undefined): Chatbot | null {
  if (!row) return null;
  // MariaDB's JSON column comes back as a string through mysql2; parse it
  // here so callers can rely on the declared `ModelParameters | null` shape.
  if (typeof row.model_parameters === 'string') {
    row.model_parameters = JSON.parse(row.model_parameters) as ModelParameters;
  }
  return row;
}

export async function getChatbotById(db: Knex, id: number): Promise<Chatbot | null> {
  const row = await db<Chatbot>('chatbots').where({ id }).first();
  return normaliseChatbotRow(row);
}

export async function getChatbotBySlug(db: Knex, slug: string): Promise<Chatbot | null> {
  const row = await db<Chatbot>('chatbots').where({ slug }).first();
  return normaliseChatbotRow(row);
}

export async function listChatbots(db: Knex): Promise<Chatbot[]> {
  const rows = await db<Chatbot>('chatbots').select('*').orderBy('slug', 'asc');
  return rows.map((r) => normaliseChatbotRow(r) as Chatbot);
}

export interface CascadeCounts {
  origins: number;
  sessions: number;
  messages: number;
}

/**
 * Delete a chatbot + everything that references it via FK CASCADE
 * (`chatbot_origins`, `sessions`, `messages`). Returns the cascade counts the
 * caller can show to the operator so the impact of the operation is visible.
 *
 * Counts are read in the same transaction as the delete so they match what
 * was actually removed.
 */
export async function deleteChatbot(db: Knex, slug: string): Promise<CascadeCounts> {
  return db.transaction(async (trx) => {
    const chatbot = await trx<Chatbot>('chatbots').where({ slug }).first();
    if (!chatbot) {
      throw new Error(`Chatbot not found: slug="${slug}"`);
    }
    const [originRow, sessionRow] = await Promise.all([
      trx('chatbot_origins').where({ chatbot_id: chatbot.id }).count<{ n: number }[]>({ n: '*' }),
      trx('sessions').where({ chatbot_id: chatbot.id }).count<{ n: number }[]>({ n: '*' }),
    ]);
    const messageRow = await trx('messages')
      .join('sessions', 'sessions.id', 'messages.session_id')
      .where('sessions.chatbot_id', chatbot.id)
      .count<{ n: number }[]>({ n: '*' });

    await trx('chatbots').where({ id: chatbot.id }).del();

    return {
      origins: Number(originRow[0]?.n ?? 0),
      sessions: Number(sessionRow[0]?.n ?? 0),
      messages: Number(messageRow[0]?.n ?? 0),
    };
  });
}

/**
 * Set or clear the welcome message returned by `POST /sessions`. Passing the
 * empty string sets the column to NULL, which causes the route to fall back
 * to its built-in default.
 */
export async function setWelcomeMessage(db: Knex, slug: string, message: string): Promise<Chatbot> {
  const chatbot = await getChatbotBySlug(db, slug);
  if (!chatbot) {
    throw new Error(`Chatbot not found: slug="${slug}"`);
  }
  const value = message.length === 0 ? null : message;
  await db('chatbots').where({ id: chatbot.id }).update({ welcome_message: value });
  const updated = await getChatbotById(db, chatbot.id);
  if (!updated) {
    throw new Error(`setWelcomeMessage: read-back failed for id=${chatbot.id}`);
  }
  return updated;
}

export async function listOrigins(db: Knex, slug: string): Promise<ChatbotOrigin[]> {
  const chatbot = await getChatbotBySlug(db, slug);
  if (!chatbot) {
    throw new Error(`Chatbot not found: slug="${slug}"`);
  }
  return db<ChatbotOrigin>('chatbot_origins')
    .where({ chatbot_id: chatbot.id })
    .orderBy('id', 'asc');
}

/**
 * Remove a single origin from a chatbot's allowlist. `ref` is either the
 * numeric `chatbot_origins.id` (string of digits) or the origin URL (matched
 * after the same normalisation that `addOrigin` applies). Throws when the
 * chatbot doesn't exist or the origin isn't on its allowlist.
 */
export async function removeOrigin(db: Knex, slug: string, ref: string): Promise<ChatbotOrigin> {
  const chatbot = await getChatbotBySlug(db, slug);
  if (!chatbot) {
    throw new Error(`Chatbot not found: slug="${slug}"`);
  }

  const query = db<ChatbotOrigin>('chatbot_origins').where({ chatbot_id: chatbot.id });
  if (/^\d+$/.test(ref)) {
    query.andWhere({ id: Number(ref) });
  } else {
    const origin = normaliseOrigin(ref);
    query.andWhere({ origin });
  }
  const row = await query.first();
  if (!row) {
    throw new Error(`Origin not found for slug="${slug}": ref="${ref}"`);
  }
  await db('chatbot_origins').where({ id: row.id }).del();
  return row;
}

export async function addOrigin(
  db: Knex,
  chatbotSlug: string,
  rawOrigin: string,
): Promise<ChatbotOrigin> {
  const chatbot = await getChatbotBySlug(db, chatbotSlug);
  if (!chatbot) {
    throw new Error(`Chatbot not found: slug="${chatbotSlug}"`);
  }
  const origin = normaliseOrigin(rawOrigin);
  const [id] = await db('chatbot_origins').insert({
    chatbot_id: chatbot.id,
    origin,
  });
  const row = await db<ChatbotOrigin>('chatbot_origins').where({ id }).first();
  if (!row) {
    throw new Error(`addOrigin: insert succeeded but read-back failed for id=${id}`);
  }
  return row;
}

export async function findChatbotByOrigin(db: Knex, rawOrigin: string): Promise<Chatbot | null> {
  const origin = normaliseOrigin(rawOrigin);
  const row = await db<Chatbot>({ c: 'chatbots' })
    .join({ o: 'chatbot_origins' }, 'c.id', 'o.chatbot_id')
    .where('o.origin', origin)
    .select('c.*')
    .first();
  return row ?? null;
}
