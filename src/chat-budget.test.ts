import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Knex } from 'knex';
import { buildServer } from './server.js';
import { addOrigin } from './services/chatbots.js';
import { createProvider, createProviderModel } from './services/providers.js';
import { appendMessage, createSession } from './services/sessions.js';
import { makeTestDb, seedAccountAndChatbot, setTestChatbotApiKey } from './testing/db.js';
import type { Account } from './services/accounts.js';
import type { Chatbot } from './services/chatbots.js';
import type { ChatRequest, ChatResponse, ProtocolAdapter } from './providers/index.js';

/**
 * Integration tests for the M20 budget-cap + handoff behaviour on the
 * chat path. Each test sets up a metered provider/model + a chatbot
 * with the specific caps it needs.
 */

function uniqueSlug(prefix = 'budget'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

interface BudgetFixture {
  db: Knex;
  account: Account;
  chatbot: Chatbot;
  providerName: string;
  origin: string;
  slug: string;
  cleanup: () => Promise<void>;
}

async function seedMeteredChatbot(opts: {
  inputPrice?: number;
  outputPrice?: number;
}): Promise<BudgetFixture> {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const origin = `https://${slug}.test`;
  const providerName = `or-${slug}`;

  const provider = await createProvider(db, {
    name: providerName,
    protocol: 'openrouter',
    base_url: 'http://test.invalid',
    is_local: false,
    is_metered: true,
  });
  await createProviderModel(db, {
    provider_id: provider.id,
    model_slug: 'test-model',
    context_window: 200000,
    input_per_million_usd: opts.inputPrice ?? 1.0,
    output_per_million_usd: opts.outputPrice ?? 5.0,
  });
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  await addOrigin(db, slug, origin);
  await db('chatbots')
    .where({ slug })
    .update({ model_slug: `${providerName}/test-model` });
  await setTestChatbotApiKey(db, chatbot.id, 'sk-fake-budget');

  return {
    db,
    account,
    chatbot,
    providerName,
    origin,
    slug,
    cleanup: async () => {
      await db('accounts').where({ id: account.id }).del();
      await db('providers').where({ name: providerName }).del();
      await db.destroy();
    },
  };
}

function tokensAdapter(
  tokens: { prompt: number; completion: number },
  reply = 'reply',
): ProtocolAdapter {
  return {
    protocol: 'openrouter',
    chat: async (_req: ChatRequest): Promise<ChatResponse> => ({
      reply,
      tokensUsed: tokens,
    }),
  };
}

async function mintSession(
  fastify: Awaited<ReturnType<typeof buildServer>>,
  origin: string,
): Promise<string> {
  const res = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
  });
  assert.equal(res.statusCode, 201);
  return res.json().session_token;
}

// ---------------------------------------------------------------------------
// Daily cap
// ---------------------------------------------------------------------------

test('M20 daily cap: chat refused with 402 budget_exhausted_daily when cap already hit', async (t) => {
  const fx = await seedMeteredChatbot({ inputPrice: 1.0, outputPrice: 5.0 });
  // Cap the chatbot at $0.001 daily AND seed enough spend to bust it.
  await fx.db('chatbots').where({ id: fx.chatbot.id }).update({ daily_budget_usd: 0.001 });
  // Pre-existing assistant message worth $0.002 → already over the $0.001 cap.
  // Mint the session BEFORE the cap-busting spend appears so we can still
  // acquire a token. (POST /sessions itself now refuses minting on a busted
  // daily cap — covered separately below.)
  const session = await createSession(fx.db, fx.chatbot.id);
  await appendMessage(fx.db, session.id, 'assistant', 'older spend', {
    chatbotId: fx.chatbot.id,
    costUsd: 0.002,
  });

  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => tokensAdapter({ prompt: 100, completion: 50 }),
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const sessionRow = await fx.db('sessions').where({ id: session.id }).first();
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${sessionRow.token}` },
    payload: { message: 'should be refused' },
  });
  assert.equal(res.statusCode, 402);
  assert.equal(res.json().error, 'budget_exhausted_daily');
});

test('M20 daily cap: POST /sessions refuses to mint when daily cap is already spent', async (t) => {
  const fx = await seedMeteredChatbot({ inputPrice: 1.0, outputPrice: 5.0 });
  await fx.db('chatbots').where({ id: fx.chatbot.id }).update({ daily_budget_usd: 0.001 });
  const seedSession = await createSession(fx.db, fx.chatbot.id);
  await appendMessage(fx.db, seedSession.id, 'assistant', 'spent', {
    chatbotId: fx.chatbot.id,
    costUsd: 0.002,
  });

  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => tokensAdapter({ prompt: 1, completion: 1 }),
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const post = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin: fx.origin },
  });
  assert.equal(post.statusCode, 402);
  assert.equal(post.json().error, 'budget_exhausted_daily');

  const probe = await fastify.inject({
    method: 'GET',
    url: '/sessions/can-start',
    headers: { origin: fx.origin },
  });
  assert.equal(probe.statusCode, 402);
  assert.equal(probe.json().error, 'budget_exhausted_daily');
});

test('M20 daily cap: chat allowed when spend still under the cap', async (t) => {
  const fx = await seedMeteredChatbot({ inputPrice: 1.0, outputPrice: 5.0 });
  // $0.01 daily cap; existing spend $0.001 is well under.
  await fx.db('chatbots').where({ id: fx.chatbot.id }).update({ daily_budget_usd: 0.01 });
  const seedSession = await createSession(fx.db, fx.chatbot.id);
  await appendMessage(fx.db, seedSession.id, 'assistant', 'old', {
    chatbotId: fx.chatbot.id,
    costUsd: 0.001,
  });

  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => tokensAdapter({ prompt: 50, completion: 25 }),
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const token = await mintSession(fastify, fx.origin);
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'hi' },
  });
  assert.equal(res.statusCode, 200);
});

// ---------------------------------------------------------------------------
// Soft-handoff injection
// ---------------------------------------------------------------------------

test('M20 soft handoff: HANDOFF_SOFT.md content is injected when session spend ≥ threshold%', async (t) => {
  const fx = await seedMeteredChatbot({ inputPrice: 1.0, outputPrice: 5.0 });
  // Session cap $0.005, threshold 80% → trigger at $0.004.
  await fx.db('chatbots').where({ id: fx.chatbot.id }).update({
    session_budget_usd: 0.005,
    handoff_threshold_pct: 80,
  });

  // Disk-block fixtures in a tmpdir; load via blocksBaseDir override
  // through the chat-route ... wait, blocksBaseDir isn't exposed via the
  // HTTP route. We can write a real HANDOFF_SOFT.md under data/chatbots/<slug>/
  // and clean it up.
  const blocksDir = path.join('data', 'chatbots', fx.slug);
  await mkdir(blocksDir, { recursive: true });
  await writeFile(
    path.join(blocksDir, 'HANDOFF_SOFT.md'),
    'gently nudge toward a human rep',
    'utf8',
  );

  // Seed prior spend at $0.004 = threshold trigger.
  const session = await createSession(fx.db, fx.chatbot.id);
  await appendMessage(fx.db, session.id, 'assistant', 'previous turn', {
    chatbotId: fx.chatbot.id,
    costUsd: 0.004,
  });

  const capture: ChatRequest[] = [];
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => ({
      protocol: 'openrouter',
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        capture.push(req);
        return { reply: 'reply', tokensUsed: { prompt: 10, completion: 10 } };
      },
    }),
  });
  t.after(async () => {
    await fastify.close();
    await rm(blocksDir, { recursive: true, force: true });
    await fx.cleanup();
  });

  // Need to use the existing session, not a fresh one (so spend is
  // present). Get its token directly.
  const sessionRow = await fx.db('sessions').where({ id: session.id }).first();
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${sessionRow.token}` },
    payload: { message: 'what does the basic plan cost?' },
  });
  assert.equal(res.statusCode, 200);

  // The system message sent to the adapter should now contain the
  // HANDOFF_SOFT block.
  assert.equal(capture.length, 1);
  const systemMessage = capture[0].messages.find((m) => m.role === 'system');
  assert.ok(systemMessage);
  assert.match(systemMessage.content, /<block name="HANDOFF_SOFT">/);
  assert.match(systemMessage.content, /gently nudge toward a human rep/);
});

test('M20 soft handoff: NOT injected when spend is below threshold', async (t) => {
  const fx = await seedMeteredChatbot({ inputPrice: 1.0, outputPrice: 5.0 });
  await fx.db('chatbots').where({ id: fx.chatbot.id }).update({
    session_budget_usd: 0.01,
    handoff_threshold_pct: 80,
  });
  const blocksDir = path.join('data', 'chatbots', fx.slug);
  await mkdir(blocksDir, { recursive: true });
  await writeFile(path.join(blocksDir, 'HANDOFF_SOFT.md'), 'should not appear', 'utf8');

  const capture: ChatRequest[] = [];
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => ({
      protocol: 'openrouter',
      chat: async (req: ChatRequest): Promise<ChatResponse> => {
        capture.push(req);
        return { reply: 'reply', tokensUsed: { prompt: 10, completion: 10 } };
      },
    }),
  });
  t.after(async () => {
    await fastify.close();
    await rm(blocksDir, { recursive: true, force: true });
    await fx.cleanup();
  });

  const token = await mintSession(fastify, fx.origin);
  await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}` },
    payload: { message: 'hi' },
  });
  // First turn — no prior spend. Threshold not crossed.
  const systemMessage = capture[0].messages.find((m) => m.role === 'system');
  assert.ok(systemMessage);
  assert.ok(
    !/HANDOFF_SOFT/.test(systemMessage.content),
    `HANDOFF_SOFT should not be in the prompt; got: ${systemMessage.content}`,
  );
});

// ---------------------------------------------------------------------------
// Hard-cap termination (after-write check)
// ---------------------------------------------------------------------------

test('M20 hard cap: assistant reply persists AND session is terminated when spend crosses', async (t) => {
  const fx = await seedMeteredChatbot({ inputPrice: 1.0, outputPrice: 5.0 });
  // Cap session at $0.0005, low enough that a single 50/25-token reply
  // (0.05c + 0.0125c = ~$0.000175) needs context to cross. Seed prior spend.
  await fx.db('chatbots').where({ id: fx.chatbot.id }).update({ session_budget_usd: 0.0005 });
  const session = await createSession(fx.db, fx.chatbot.id);
  await appendMessage(fx.db, session.id, 'assistant', 'prior', {
    chatbotId: fx.chatbot.id,
    costUsd: 0.0004,
  });

  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => tokensAdapter({ prompt: 100, completion: 50 }, 'final reply'),
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const sessionRow = await fx.db('sessions').where({ id: session.id }).first();
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${sessionRow.token}` },
    payload: { message: 'something' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.reply, 'final reply');
  assert.equal(body.session_terminated, true);

  // The session row now has terminated_at set.
  const after = await fx.db('sessions').where({ id: session.id }).first();
  assert.ok(after.terminated_at instanceof Date);
});

test('M20 hard cap: subsequent chat on a terminated session returns canned response, no LLM call', async (t) => {
  const fx = await seedMeteredChatbot({});
  await fx.db('chatbots').where({ id: fx.chatbot.id }).update({ session_budget_usd: 0.0001 });
  const session = await createSession(fx.db, fx.chatbot.id);
  await fx.db('sessions').where({ id: session.id }).update({ terminated_at: fx.db.fn.now() });

  const blocksDir = path.join('data', 'chatbots', fx.slug);
  await mkdir(blocksDir, { recursive: true });
  await writeFile(
    path.join(blocksDir, 'HANDOFF_HARD.md'),
    'thanks for chatting — please leave your email.',
    'utf8',
  );

  // The adapter MUST not be called. If it is, this fails loud.
  const adapterCalls: number[] = [];
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => ({
      protocol: 'openrouter',
      chat: async () => {
        adapterCalls.push(1);
        return { reply: 'should not run' };
      },
    }),
  });
  t.after(async () => {
    await fastify.close();
    await rm(blocksDir, { recursive: true, force: true });
    await fx.cleanup();
  });

  const sessionRow = await fx.db('sessions').where({ id: session.id }).first();
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${sessionRow.token}` },
    payload: { message: 'tried again' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.reply, 'thanks for chatting — please leave your email.');
  assert.equal(body.session_terminated, true);
  assert.equal(body.message_id, 0);
  assert.equal(adapterCalls.length, 0);

  // No new message row was written.
  const count = await fx
    .db('messages')
    .where({ session_id: session.id })
    .count<{ n: number }[]>({ n: '*' });
  assert.equal(Number(count[0].n), 0);
});

// ---------------------------------------------------------------------------
// Visitor email capture
// ---------------------------------------------------------------------------

test('M20 visitor email: POST /sessions/visitor-email persists email + returns 204 (no echo)', async (t) => {
  const fx = await seedMeteredChatbot({});
  const session = await createSession(fx.db, fx.chatbot.id);

  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => tokensAdapter({ prompt: 1, completion: 1 }),
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const sessionRow = await fx.db('sessions').where({ id: session.id }).first();
  const res = await fastify.inject({
    method: 'POST',
    url: '/sessions/visitor-email',
    headers: { authorization: `Bearer ${sessionRow.token}` },
    payload: { email: '  visitor@example.com  ' },
  });
  assert.equal(res.statusCode, 204);
  assert.equal(res.payload, '');

  const after = await fx.db('sessions').where({ id: session.id }).first();
  assert.equal(after.visitor_email, 'visitor@example.com');
});

test('M20 visitor email: rejects malformed email shape with 400', async (t) => {
  const fx = await seedMeteredChatbot({});
  const session = await createSession(fx.db, fx.chatbot.id);

  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => tokensAdapter({ prompt: 1, completion: 1 }),
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const sessionRow = await fx.db('sessions').where({ id: session.id }).first();

  for (const bad of ['not-an-email', 'foo@bar', '', '   ', '@.x', 'x@x.']) {
    const res = await fastify.inject({
      method: 'POST',
      url: '/sessions/visitor-email',
      headers: { authorization: `Bearer ${sessionRow.token}` },
      payload: { email: bad },
    });
    assert.equal(res.statusCode, 400, `expected 400 for "${bad}", got ${res.statusCode}`);
    assert.equal(res.json().error, 'validation_failed');
  }
});

test('M20 visitor email: rejects missing token with 401', async (t) => {
  const fx = await seedMeteredChatbot({});

  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => tokensAdapter({ prompt: 1, completion: 1 }),
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/sessions/visitor-email',
    payload: { email: 'x@y.com' },
  });
  assert.equal(res.statusCode, 401);
});

test('M20 hard cap: terminated session falls back to DEFAULT_HARD_HANDOFF when HANDOFF_HARD.md is missing', async (t) => {
  const fx = await seedMeteredChatbot({});
  const session = await createSession(fx.db, fx.chatbot.id);
  await fx.db('sessions').where({ id: session.id }).update({ terminated_at: fx.db.fn.now() });

  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => tokensAdapter({ prompt: 1, completion: 1 }),
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const sessionRow = await fx.db('sessions').where({ id: session.id }).first();
  const res = await fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${sessionRow.token}` },
    payload: { message: 'anything' },
  });
  assert.equal(res.statusCode, 200);
  assert.match(res.json().reply, /talk to a human/);
});
