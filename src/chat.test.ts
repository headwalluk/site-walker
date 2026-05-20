import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { buildServer } from './server.js';
import { addOrigin } from './services/chatbots.js';
import { createProvider, createProviderModel } from './services/providers.js';
import { setChatbotGeoCountries, setChatbotGeoMode, type GeoChecker } from './services/geo.js';
import { makeTestDb, seedAccountAndChatbot } from './testing/db.js';
import type { Account } from './services/accounts.js';
import type { ChatRequest, ChatResponse, ProtocolAdapter } from './providers/index.js';

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

interface FakeAdapterOpts {
  reply?: string;
  throwError?: Error;
  capture?: { requests: ChatRequest[]; apiKey?: string | undefined };
}

function makeFakeAdapter(opts: FakeAdapterOpts = {}): ProtocolAdapter {
  return {
    protocol: 'ollama-native',
    chat: async (req: ChatRequest): Promise<ChatResponse> => {
      opts.capture?.requests.push(req);
      if (opts.throwError) throw opts.throwError;
      return { reply: opts.reply ?? 'hello back' };
    },
  };
}

async function setupChat(
  db: Knex,
  patch: Partial<{
    model_slug: string | null;
    /** If set, register the provider as metered (so the missing-key check fires). */
    metered: boolean;
    model_context_window: number | null;
    persona: string | null;
    welcome_message: string | null;
  }> = {},
): Promise<{
  slug: string;
  origin: string;
  account: Account;
  providerName: string;
  fullModelSlug: string;
}> {
  const slug = uniqueSlug();
  const origin = `https://${slug}.example.com`;
  const providerName = `pi-${slug}`;
  const provider = await createProvider(db, {
    name: providerName,
    protocol: 'ollama-native',
    base_url: 'http://test.invalid:11434',
    is_local: !patch.metered,
    is_metered: patch.metered ?? false,
  });
  await createProviderModel(db, {
    provider_id: provider.id,
    model_slug: 'test-model',
    context_window: 4096,
  });
  const fullModelSlug = `${providerName}/test-model`;

  const { account } = await seedAccountAndChatbot(db, slug, { persona: patch.persona ?? null });
  await addOrigin(db, slug, origin);
  const modelSlug = 'model_slug' in patch ? patch.model_slug : fullModelSlug;
  await db('chatbots')
    .where({ slug })
    .update({
      model_slug: modelSlug,
      model_context_window: patch.model_context_window ?? null,
      welcome_message: patch.welcome_message ?? null,
    });
  return { slug, origin, account, providerName, fullModelSlug };
}

async function cleanup(
  db: Knex,
  account: Account,
  providerName: string,
  fastify: Awaited<ReturnType<typeof buildServer>>,
): Promise<void> {
  await fastify.close();
  await db('accounts').where({ id: account.id }).del();
  await db('providers').where({ name: providerName }).del();
  await db.destroy();
}

type FastifyServer = Awaited<ReturnType<typeof buildServer>>;

async function mintSession(fastify: FastifyServer, origin: string): Promise<string> {
  const res = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
  });
  assert.equal(res.statusCode, 201);
  return res.json().session_token;
}

test('POST /chat: 401 when bearer token is missing', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter(),
  });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    payload: { message: 'hi' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'token_required');
});

test('POST /chat: 401 when bearer token is unknown', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter(),
  });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: 'Bearer not-a-real-token' },
    payload: { message: 'hi' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'invalid_token');
});

test('POST /chat: 400 when message is missing or empty', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter(),
  });
  const { origin, account, providerName } = await setupChat(db);
  t.after(() => cleanup(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin);

  const noBody = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(noBody.statusCode, 400);
  assert.equal(noBody.json().error, 'message_required');

  const empty = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: '   ' },
  });
  assert.equal(empty.statusCode, 400);
  assert.equal(empty.json().error, 'message_required');
});

test('POST /chat: 400 when message exceeds the size cap', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter(),
  });
  const { origin, account, providerName } = await setupChat(db);
  t.after(() => cleanup(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin);
  const oversize = 'x'.repeat(8001);

  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: oversize },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'message_too_long');
});

test('POST /chat: 503 when chatbot has no model configured', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter(),
  });
  const { origin, account, providerName } = await setupChat(db, { model_slug: null });
  t.after(() => cleanup(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin);
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'hello' },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'model_not_configured');
});

test('POST /chat: 503 chatbot_api_key_missing when metered provider has no chatbot key', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter(),
  });
  const { origin, account, providerName } = await setupChat(db, { metered: true });
  t.after(() => cleanup(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin);
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'hello' },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'chatbot_api_key_missing');
});

test('POST /chat: 413 when total prompt exceeds context window with headroom', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter(),
  });
  const { origin, account, providerName } = await setupChat(db, {
    model_context_window: 200,
    persona: 'A '.repeat(500), // ~330 tokens by the estimator
  });
  t.after(() => cleanup(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin);
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'hi' },
  });
  assert.equal(res.statusCode, 413);
  assert.equal(res.json().error, 'context_overflow');
  const detail = res.json().detail;
  assert.equal(typeof detail.total_prompt_tokens, 'number');
  assert.equal(detail.context_window, 200);
});

test('POST /chat: happy path persists both turns and returns the reply', async (t) => {
  const db = makeTestDb();
  const capture = { requests: [] as ChatRequest[] };
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter({ reply: 'I help with widgets.', capture }),
  });
  const { origin, account, providerName } = await setupChat(db);
  t.after(() => cleanup(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin);
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'Tell me about widgets.' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.reply, 'I help with widgets.');
  assert.equal(typeof body.message_id, 'number');

  // The adapter saw [system, user] for the first turn.
  assert.equal(capture.requests.length, 1);
  const sent = capture.requests[0];
  assert.equal(sent.messages[0].role, 'system');
  assert.equal(sent.messages.at(-1)?.role, 'user');
  assert.equal(sent.messages.at(-1)?.content, 'Tell me about widgets.');

  // GET /messages now returns both turns.
  const list = await fastify.inject({
    method: 'GET',
    url: '/messages',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(list.statusCode, 200);
  const messages = list.json().messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'Tell me about widgets.');
  assert.equal(messages[1].role, 'assistant');
  assert.equal(messages[1].content, 'I help with widgets.');
});

test('POST /chat: adapter factory receives the resolved provider', async (t) => {
  const db = makeTestDb();
  const seen: { providerName?: string; apiKey?: string | undefined } = {};
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: (provider, apiKey) => {
      seen.providerName = provider.name;
      seen.apiKey = apiKey;
      return makeFakeAdapter();
    },
  });
  const { origin, account, providerName } = await setupChat(db);
  t.after(() => cleanup(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin);
  await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'hi' },
  });
  assert.equal(seen.providerName, providerName);
  // Unmetered provider + no chatbot key → apiKey is undefined.
  assert.equal(seen.apiKey, undefined);
});

test('POST /chat: adapter failure returns 502 and leaves user msg persisted with no assistant row', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter({ throwError: new Error('upstream blew up') }),
  });
  const { origin, account, providerName } = await setupChat(db);
  t.after(() => cleanup(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin);
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'this will fail' },
  });
  assert.equal(res.statusCode, 502);
  assert.equal(res.json().error, 'model_error');

  // The user message is in the log; no assistant row was written.
  const list = await fastify.inject({
    method: 'GET',
    url: '/messages',
    headers: { authorization: `Bearer ${token}` },
  });
  const messages = list.json().messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 1);
  assert.equal(messages[0].role, 'user');
  assert.equal(messages[0].content, 'this will fail');
});

test('POST /chat: second turn includes prior history in the adapter request', async (t) => {
  const db = makeTestDb();
  const capture = { requests: [] as ChatRequest[] };
  let reply = 'first reply';
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => ({
      protocol: 'ollama-native',
      chat: async (req) => {
        capture.requests.push(req);
        return { reply };
      },
    }),
  });
  const { origin, account, providerName } = await setupChat(db);
  t.after(() => cleanup(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin);

  const turn1 = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'first user' },
  });
  assert.equal(turn1.statusCode, 200);

  reply = 'second reply';
  const turn2 = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'second user' },
  });
  assert.equal(turn2.statusCode, 200);

  assert.equal(capture.requests.length, 2);
  const second = capture.requests[1];
  // [system, user1, assistant1, user2]
  assert.equal(second.messages.length, 4);
  assert.equal(second.messages[0].role, 'system');
  assert.equal(second.messages[1].role, 'user');
  assert.equal(second.messages[1].content, 'first user');
  assert.equal(second.messages[2].role, 'assistant');
  assert.equal(second.messages[2].content, 'first reply');
  assert.equal(second.messages[3].role, 'user');
  assert.equal(second.messages[3].content, 'second user');
});

// ----- geo-blocking -----

function fakeGeoChecker(mapping: Record<string, string | null>): GeoChecker {
  return { lookup: (ip) => (ip in mapping ? mapping[ip] : null) };
}

test('POST /sessions: 403 geo_blocked when blocklist matches the visitor country', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    geoChecker: fakeGeoChecker({ '203.0.113.10': 'RU' }),
  });
  const { slug, origin, account, providerName } = await setupChat(db);
  await setChatbotGeoMode(db, slug, 'blocklist');
  await setChatbotGeoCountries(db, slug, ['RU', 'CN']);
  t.after(() => cleanup(db, account, providerName, fastify));

  const res = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
    remoteAddress: '203.0.113.10',
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'geo_blocked');
});

test('POST /sessions: allowlist permits the listed country and rejects others', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    geoChecker: fakeGeoChecker({
      '203.0.113.20': 'GB',
      '203.0.113.21': 'US',
    }),
  });
  const { slug, origin, account, providerName } = await setupChat(db);
  await setChatbotGeoMode(db, slug, 'allowlist');
  await setChatbotGeoCountries(db, slug, ['GB']);
  t.after(() => cleanup(db, account, providerName, fastify));

  const ok = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
    remoteAddress: '203.0.113.20',
  });
  assert.equal(ok.statusCode, 201);

  const denied = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
    remoteAddress: '203.0.113.21',
  });
  assert.equal(denied.statusCode, 403);
  assert.equal(denied.json().error, 'geo_blocked');
});

test('GET /sessions/can-start: returns { ok: true } when geo allows', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    geoChecker: fakeGeoChecker({ '203.0.113.30': 'GB' }),
  });
  const { slug, origin, account, providerName } = await setupChat(db);
  await setChatbotGeoMode(db, slug, 'allowlist');
  await setChatbotGeoCountries(db, slug, ['GB']);
  t.after(() => cleanup(db, account, providerName, fastify));

  const res = await fastify.inject({
    method: 'GET',
    url: '/sessions/can-start',
    headers: { origin },
    remoteAddress: '203.0.113.30',
  });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.json(), { ok: true });
});

test('GET /sessions/can-start: 403 geo_blocked when policy denies (mints nothing)', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    geoChecker: fakeGeoChecker({ '203.0.113.40': 'RU' }),
  });
  const { slug, origin, account, providerName } = await setupChat(db);
  await setChatbotGeoMode(db, slug, 'blocklist');
  await setChatbotGeoCountries(db, slug, ['RU']);
  t.after(() => cleanup(db, account, providerName, fastify));

  const res = await fastify.inject({
    method: 'GET',
    url: '/sessions/can-start',
    headers: { origin },
    remoteAddress: '203.0.113.40',
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'geo_blocked');

  // Verify no session was minted as a side effect.
  const sessionCount = await db('sessions')
    .join('chatbots', 'chatbots.id', 'sessions.chatbot_id')
    .where('chatbots.slug', slug)
    .count<{ n: number }[]>({ n: '*' });
  assert.equal(Number(sessionCount[0].n), 0);
});

test('GET /sessions/can-start: 400 when Origin missing, 403 when not allowlisted', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    geoChecker: fakeGeoChecker({}),
  });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const missing = await fastify.inject({ method: 'GET', url: '/sessions/can-start' });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.json().error, 'origin_required');

  const stranger = await fastify.inject({
    method: 'GET',
    url: '/sessions/can-start',
    headers: { origin: 'https://stranger.example.com' },
  });
  assert.equal(stranger.statusCode, 403);
  assert.equal(stranger.json().error, 'origin_not_allowed');
});

test('POST /chat: 403 geo_blocked rejects after session is minted', async (t) => {
  const db = makeTestDb();
  // First request (POST /sessions) sees GB → allowed.
  // Second request (POST /chat) sees RU → blocked.
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter(),
    geoChecker: fakeGeoChecker({
      '203.0.113.50': 'GB',
      '203.0.113.51': 'RU',
    }),
  });
  const { slug, origin, account, providerName } = await setupChat(db);
  t.after(() => cleanup(db, account, providerName, fastify));

  const sessionRes = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
    remoteAddress: '203.0.113.50',
  });
  assert.equal(sessionRes.statusCode, 201);
  const token = sessionRes.json().session_token;

  // Now flip the policy to a blocklist that includes RU, and call /chat from RU.
  await setChatbotGeoMode(db, slug, 'blocklist');
  await setChatbotGeoCountries(db, slug, ['RU']);

  const chatRes = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'hi' },
    remoteAddress: '203.0.113.51',
  });
  assert.equal(chatRes.statusCode, 403);
  assert.equal(chatRes.json().error, 'geo_blocked');
});

test('GET /messages: 403 geo_blocked when policy denies', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    geoChecker: fakeGeoChecker({
      '203.0.113.60': 'GB',
      '203.0.113.61': 'RU',
    }),
  });
  const { slug, origin, account, providerName } = await setupChat(db);
  t.after(() => cleanup(db, account, providerName, fastify));

  const sessionRes = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
    remoteAddress: '203.0.113.60',
  });
  const token = sessionRes.json().session_token;

  await setChatbotGeoMode(db, slug, 'blocklist');
  await setChatbotGeoCountries(db, slug, ['RU']);

  const res = await fastify.inject({
    method: 'GET',
    url: '/messages',
    headers: { authorization: `Bearer ${token}` },
    remoteAddress: '203.0.113.61',
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'geo_blocked');
});
