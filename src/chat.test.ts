import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import type { Knex } from 'knex';
import { buildServer } from './server.js';
import { createWebsite, addOrigin } from './services/websites.js';
import type { ProviderEntry, ProviderRegistry } from './config/site-walker-config.js';
import type { ChatRequest, ChatResponse, ProtocolAdapter } from './providers/index.js';

function makeTestDb(): Knex {
  return knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? 'site_walker',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_NAME ?? 'site_walker',
    },
    pool: { min: 0, max: 5 },
  });
}

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

function makeFakeRegistry(): ProviderRegistry {
  const entry: ProviderEntry = {
    name: 'pi',
    protocol: 'ollama-native',
    base_url: 'http://test.invalid',
    is_local: true,
  };
  return { configPath: '<test>', providers: new Map([[entry.name, entry]]) };
}

interface FakeAdapterOpts {
  reply?: string;
  throwError?: Error;
  capture?: { requests: ChatRequest[] };
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

async function makeChatWebsite(
  db: Knex,
  patch: Partial<{
    model_slug: string | null;
    model_context_window: number | null;
    persona: string | null;
    welcome_message: string | null;
  }> = {},
): Promise<{ slug: string; origin: string; token: string }> {
  const slug = uniqueSlug();
  const origin = `https://${slug}.example.com`;
  await createWebsite(db, { slug, name: 'Test', persona: patch.persona ?? null });
  await addOrigin(db, slug, origin);
  const modelSlug = 'model_slug' in patch ? patch.model_slug : 'pi/test-model';
  await db('websites')
    .where({ slug })
    .update({
      model_slug: modelSlug,
      model_context_window: patch.model_context_window ?? null,
      welcome_message: patch.welcome_message ?? null,
    });
  return { slug, origin, token: '' };
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
    registry: makeFakeRegistry(),
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
    registry: makeFakeRegistry(),
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
    registry: makeFakeRegistry(),
    adapterFactory: () => makeFakeAdapter(),
  });
  const { slug, origin } = await makeChatWebsite(db);
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

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
    registry: makeFakeRegistry(),
    adapterFactory: () => makeFakeAdapter(),
  });
  const { slug, origin } = await makeChatWebsite(db);
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

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

test('POST /chat: 503 when website has no model configured', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    registry: makeFakeRegistry(),
    adapterFactory: () => makeFakeAdapter(),
  });
  const { slug, origin } = await makeChatWebsite(db, { model_slug: null });
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

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

test('POST /chat: 413 when total prompt exceeds context window with headroom', async (t) => {
  const db = makeTestDb();
  // Tiny context window forces overflow even with a short message.
  const fastify = await buildServer({
    db,
    logger: false,
    registry: makeFakeRegistry(),
    adapterFactory: () => makeFakeAdapter(),
  });
  const { slug, origin } = await makeChatWebsite(db, {
    model_context_window: 200,
    persona: 'A '.repeat(500), // ~330 tokens by the estimator
  });
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

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
    registry: makeFakeRegistry(),
    adapterFactory: () => makeFakeAdapter({ reply: 'I help with widgets.', capture }),
  });
  const { slug, origin } = await makeChatWebsite(db);
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

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

test('POST /chat: adapter failure returns 502 and leaves user msg persisted with no assistant row', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    registry: makeFakeRegistry(),
    adapterFactory: () => makeFakeAdapter({ throwError: new Error('upstream blew up') }),
  });
  const { slug, origin } = await makeChatWebsite(db);
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

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
    registry: makeFakeRegistry(),
    adapterFactory: () => ({
      protocol: 'ollama-native',
      chat: async (req) => {
        capture.requests.push(req);
        return { reply };
      },
    }),
  });
  const { slug, origin } = await makeChatWebsite(db);
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

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

test('POST /chat: 500 when buildServer was constructed without a registry', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  const { slug, origin } = await makeChatWebsite(db);
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const token = await mintSession(fastify, origin);
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'hi' },
  });
  assert.equal(res.statusCode, 500);
  assert.equal(res.json().error, 'server_misconfigured');
});
