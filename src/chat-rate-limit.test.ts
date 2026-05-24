import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { Knex } from 'knex';
import { buildServer } from './server.js';
import { addOrigin } from './services/chatbots.js';
import { createProvider, createProviderModel } from './services/providers.js';
import { makeTestDb, seedAccountAndChatbot } from './testing/db.js';
import type { Account } from './services/accounts.js';
import type { ChatRequest, ChatResponse, ProtocolAdapter } from './providers/index.js';

/**
 * M23: per-IP and per-chatbot rate limiting against /sessions + /chat.
 *
 * Tests pass small caps via `rateLimit` opts so the 429 path is reachable
 * without 11+ requests. The injected `now` clock is unused here — fixed
 * windows are 60s wide and tests fire all requests well inside one window.
 */

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

function makeFakeAdapter(): ProtocolAdapter {
  return {
    protocol: 'ollama-native',
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({ reply: 'ok' }),
  };
}

interface ChatbotFixture {
  slug: string;
  origin: string;
  account: Account;
  providerName: string;
}

async function seedChatbot(db: Knex): Promise<ChatbotFixture> {
  const slug = uniqueSlug();
  const origin = `https://${slug}.example.com`;
  const providerName = `rl-${slug}`;
  const provider = await createProvider(db, {
    name: providerName,
    protocol: 'ollama-native',
    base_url: 'http://test.invalid:11434',
    is_local: true,
    is_metered: false,
  });
  await createProviderModel(db, {
    provider_id: provider.id,
    model_slug: 'test-model',
    context_window: 4096,
  });
  const { account } = await seedAccountAndChatbot(db, slug);
  await addOrigin(db, slug, origin);
  await db('chatbots')
    .where({ slug })
    .update({ model_slug: `${providerName}/test-model` });
  return { slug, origin, account, providerName };
}

async function cleanupChatbot(
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

// ---------------------------------------------------------------------------
// POST /sessions
// ---------------------------------------------------------------------------

test('M23: POST /sessions returns 429 rate_limit_exceeded after per-IP cap', async (t) => {
  const db = makeTestDb();
  const { origin, account, providerName } = await seedChatbot(db);
  const fastify = await buildServer({
    db,
    logger: false,
    rateLimit: {
      sessionsPerIp: 2,
      sessionsPerChatbot: 1000,
      chatPerIp: 1000,
      chatPerChatbot: 1000,
    },
  });
  t.after(() => cleanupChatbot(db, account, providerName, fastify));

  for (let i = 0; i < 2; i++) {
    const ok = await fastify.inject({
      method: 'POST',
      url: '/sessions',
      headers: { origin, 'x-forwarded-for': '10.0.0.1' },
    });
    assert.equal(ok.statusCode, 201, `request ${i + 1} should mint, got ${ok.payload}`);
  }
  const refused = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin, 'x-forwarded-for': '10.0.0.1' },
  });
  assert.equal(refused.statusCode, 429, refused.payload);
  const body = refused.json();
  assert.equal(body.error, 'rate_limit_exceeded');
  assert.equal(typeof body.detail.retry_after_seconds, 'number');
  assert.ok(body.detail.retry_after_seconds >= 1);
  assert.ok(refused.headers['retry-after'], 'Retry-After header should be set');
});

test('M23: POST /sessions per-IP buckets are independent across IPs', async (t) => {
  const db = makeTestDb();
  const { origin, account, providerName } = await seedChatbot(db);
  const fastify = await buildServer({
    db,
    logger: false,
    rateLimit: {
      sessionsPerIp: 1,
      sessionsPerChatbot: 1000,
      chatPerIp: 1000,
      chatPerChatbot: 1000,
    },
  });
  t.after(() => cleanupChatbot(db, account, providerName, fastify));

  // IP A burns its quota.
  const a1 = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin, 'x-forwarded-for': '10.0.0.1' },
  });
  assert.equal(a1.statusCode, 201);
  const a2 = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin, 'x-forwarded-for': '10.0.0.1' },
  });
  assert.equal(a2.statusCode, 429);

  // IP B still has a full quota.
  const b1 = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin, 'x-forwarded-for': '10.0.0.2' },
  });
  assert.equal(b1.statusCode, 201, b1.payload);
});

test('M23: POST /sessions hits per-chatbot cap even when each IP is under per-IP cap', async (t) => {
  const db = makeTestDb();
  const { origin, account, providerName } = await seedChatbot(db);
  const fastify = await buildServer({
    db,
    logger: false,
    // Per-IP generous; per-chatbot tight. Three distinct IPs should exhaust
    // the chatbot's quota of 2.
    rateLimit: { sessionsPerIp: 100, sessionsPerChatbot: 2, chatPerIp: 1000, chatPerChatbot: 1000 },
  });
  t.after(() => cleanupChatbot(db, account, providerName, fastify));

  for (let i = 1; i <= 2; i++) {
    const ok = await fastify.inject({
      method: 'POST',
      url: '/sessions',
      headers: { origin, 'x-forwarded-for': `10.0.0.${i}` },
    });
    assert.equal(ok.statusCode, 201, `IP ${i} should mint`);
  }
  const refused = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin, 'x-forwarded-for': '10.0.0.99' },
  });
  assert.equal(refused.statusCode, 429, refused.payload);
  assert.equal(refused.json().error, 'rate_limit_exceeded');
});

// ---------------------------------------------------------------------------
// POST /chat
// ---------------------------------------------------------------------------

async function mintSession(
  fastify: Awaited<ReturnType<typeof buildServer>>,
  origin: string,
  ip = '10.0.0.50',
): Promise<string> {
  const res = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin, 'x-forwarded-for': ip },
  });
  assert.equal(res.statusCode, 201, res.payload);
  return res.json().session_token;
}

test('M23: POST /chat returns 429 after per-IP cap', async (t) => {
  const db = makeTestDb();
  const { origin, account, providerName } = await seedChatbot(db);
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter(),
    // Per-IP cap 2 on /chat; everything else generous.
    rateLimit: { sessionsPerIp: 100, sessionsPerChatbot: 1000, chatPerIp: 2, chatPerChatbot: 1000 },
  });
  t.after(() => cleanupChatbot(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin, '10.0.0.50');
  for (let i = 0; i < 2; i++) {
    const ok = await fastify.inject({
      method: 'POST',
      url: '/chat',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'x-forwarded-for': '10.0.0.50',
      },
      payload: { message: `hi ${i}` },
    });
    assert.equal(ok.statusCode, 200, `request ${i + 1} should pass, got ${ok.payload}`);
  }
  const refused = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.50',
    },
    payload: { message: 'hi again' },
  });
  assert.equal(refused.statusCode, 429, refused.payload);
  assert.equal(refused.json().error, 'rate_limit_exceeded');
});

test('M23: POST /chat hits per-chatbot cap across multiple sessions/IPs', async (t) => {
  const db = makeTestDb();
  const { origin, account, providerName } = await seedChatbot(db);
  const fastify = await buildServer({
    db,
    logger: false,
    adapterFactory: () => makeFakeAdapter(),
    // Per-IP generous; per-chatbot 2. Two sessions from different IPs each
    // send one turn → fills the chatbot bucket; a third sender refused.
    rateLimit: { sessionsPerIp: 100, sessionsPerChatbot: 1000, chatPerIp: 100, chatPerChatbot: 2 },
  });
  t.after(() => cleanupChatbot(db, account, providerName, fastify));

  const tokenA = await mintSession(fastify, origin, '10.0.0.1');
  const tokenB = await mintSession(fastify, origin, '10.0.0.2');
  const tokenC = await mintSession(fastify, origin, '10.0.0.3');

  const aRes = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: {
      authorization: `Bearer ${tokenA}`,
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.1',
    },
    payload: { message: 'a' },
  });
  assert.equal(aRes.statusCode, 200);
  const bRes = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: {
      authorization: `Bearer ${tokenB}`,
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.2',
    },
    payload: { message: 'b' },
  });
  assert.equal(bRes.statusCode, 200);
  const cRes = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: {
      authorization: `Bearer ${tokenC}`,
      'content-type': 'application/json',
      'x-forwarded-for': '10.0.0.3',
    },
    payload: { message: 'c' },
  });
  assert.equal(cRes.statusCode, 429, cRes.payload);
  assert.equal(cRes.json().error, 'rate_limit_exceeded');
});

// ---------------------------------------------------------------------------
// Disabled mode + exempt routes
// ---------------------------------------------------------------------------

test('M23: rateLimit.disabled lets all requests through past the cap', async (t) => {
  const db = makeTestDb();
  const { origin, account, providerName } = await seedChatbot(db);
  const fastify = await buildServer({
    db,
    logger: false,
    rateLimit: { disabled: true, sessionsPerIp: 1, sessionsPerChatbot: 1 },
  });
  t.after(() => cleanupChatbot(db, account, providerName, fastify));

  for (let i = 0; i < 5; i++) {
    const res = await fastify.inject({
      method: 'POST',
      url: '/sessions',
      headers: { origin, 'x-forwarded-for': '10.0.0.1' },
    });
    assert.equal(res.statusCode, 201, `request ${i + 1} should mint (rate limit disabled)`);
  }
});

test('M23: GET /sessions/can-start is NOT rate limited (idempotent probe)', async (t) => {
  const db = makeTestDb();
  const { origin, account, providerName } = await seedChatbot(db);
  const fastify = await buildServer({
    db,
    logger: false,
    // sessionsPerIp = 1 would make POST /sessions trip on the 2nd call, but
    // can-start shouldn't even consult the bucket.
    rateLimit: { sessionsPerIp: 1, sessionsPerChatbot: 1, chatPerIp: 1, chatPerChatbot: 1 },
  });
  t.after(() => cleanupChatbot(db, account, providerName, fastify));

  for (let i = 0; i < 5; i++) {
    const res = await fastify.inject({
      method: 'GET',
      url: '/sessions/can-start',
      headers: { origin, 'x-forwarded-for': '10.0.0.1' },
    });
    assert.equal(res.statusCode, 200, `can-start ${i + 1} should pass`);
    assert.equal(res.json().ok, true);
  }
});

test('M23: GET /messages is NOT rate limited even past per-IP cap', async (t) => {
  const db = makeTestDb();
  const { origin, account, providerName } = await seedChatbot(db);
  const fastify = await buildServer({
    db,
    logger: false,
    rateLimit: { sessionsPerIp: 100, sessionsPerChatbot: 100, chatPerIp: 1, chatPerChatbot: 1 },
  });
  t.after(() => cleanupChatbot(db, account, providerName, fastify));

  const token = await mintSession(fastify, origin, '10.0.0.7');
  for (let i = 0; i < 5; i++) {
    const res = await fastify.inject({
      method: 'GET',
      url: '/messages',
      headers: { authorization: `Bearer ${token}`, 'x-forwarded-for': '10.0.0.7' },
    });
    assert.equal(res.statusCode, 200, `GET /messages ${i + 1} should pass`);
  }
});
