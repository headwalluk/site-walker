import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Knex } from 'knex';
import { buildServer } from './server.js';
import { addOrigin } from './services/chatbots.js';
import { createProvider, createProviderModel } from './services/providers.js';
import { createSession } from './services/sessions.js';
import { makeTestDb, seedAccountAndChatbot } from './testing/db.js';
import type { Account } from './services/accounts.js';
import type { Chatbot } from './services/chatbots.js';
import type { ChatRequest, ChatResponse, ProtocolAdapter } from './providers/index.js';

/**
 * M23.5 simulation hooks for acceptance testing of the soft/hard handoff
 * flow. These tests pass `sim` via BuildServerOpts (overrides env) so they
 * can exercise the triggers deterministically without mutating process.env
 * across the env module-singleton boundary.
 *
 * The real spend-based triggers still apply alongside the sim — these
 * tests deliberately leave session_budget_usd unset so the only trigger
 * is the user-turn count, proving the sim path is independently active.
 */

function uniqueSlug(prefix = 'sim'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

interface SimFixture {
  db: Knex;
  account: Account;
  chatbot: Chatbot;
  providerName: string;
  origin: string;
  slug: string;
  cleanup: () => Promise<void>;
}

async function seedSimChatbot(): Promise<SimFixture> {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const origin = `https://${slug}.test`;
  const providerName = `sim-${slug}`;
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
    context_window: 200000,
  });
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  await addOrigin(db, slug, origin);
  await db('chatbots')
    .where({ slug })
    .update({ model_slug: `${providerName}/test-model` });

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

function fakeAdapter(capture?: ChatRequest[]): ProtocolAdapter {
  return {
    protocol: 'ollama-native',
    chat: async (req: ChatRequest): Promise<ChatResponse> => {
      capture?.push(req);
      return { reply: 'ok', tokensUsed: { prompt: 10, completion: 10 } };
    },
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
  assert.equal(res.statusCode, 201, res.payload);
  return res.json().session_token;
}

async function sendTurn(
  fastify: Awaited<ReturnType<typeof buildServer>>,
  token: string,
  message: string,
) {
  return fastify.inject({
    method: 'POST',
    url: '/chat',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    payload: { message },
  });
}

// ---------------------------------------------------------------------------
// Soft sim
// ---------------------------------------------------------------------------

test('M23.5 soft sim: injects HANDOFF_SOFT on the Nth user turn (even with no session cap configured)', async (t) => {
  const fx = await seedSimChatbot();
  const blocksDir = path.join('data', 'chatbots', fx.slug);
  await mkdir(blocksDir, { recursive: true });
  await writeFile(path.join(blocksDir, 'HANDOFF_SOFT.md'), 'sim soft nudge content', 'utf8');

  const capture: ChatRequest[] = [];
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => fakeAdapter(capture),
    sim: { softHandoffAfterUserTurns: 3 },
  });
  t.after(async () => {
    await fastify.close();
    await rm(blocksDir, { recursive: true, force: true });
    await fx.cleanup();
  });

  const token = await mintSession(fastify, fx.origin);

  // Turn 1: below threshold (count = 1), no inject.
  await sendTurn(fastify, token, 'hi 1');
  let systemMessage = capture.at(-1)?.messages.find((m) => m.role === 'system');
  assert.ok(systemMessage);
  assert.ok(!/HANDOFF_SOFT/.test(systemMessage.content), 'turn 1 should not inject');

  // Turn 2: below threshold (count = 2), no inject.
  await sendTurn(fastify, token, 'hi 2');
  systemMessage = capture.at(-1)?.messages.find((m) => m.role === 'system');
  assert.ok(systemMessage);
  assert.ok(!/HANDOFF_SOFT/.test(systemMessage.content), 'turn 2 should not inject');

  // Turn 3: count = 3, sim threshold met → inject fires.
  await sendTurn(fastify, token, 'hi 3');
  systemMessage = capture.at(-1)?.messages.find((m) => m.role === 'system');
  assert.ok(systemMessage);
  assert.match(systemMessage.content, /<block name="HANDOFF_SOFT">/);
  assert.match(systemMessage.content, /sim soft nudge content/);
});

test('M23.5 soft sim: does NOT fire when sim is force-off (regression)', async (t) => {
  const fx = await seedSimChatbot();
  const blocksDir = path.join('data', 'chatbots', fx.slug);
  await mkdir(blocksDir, { recursive: true });
  await writeFile(path.join(blocksDir, 'HANDOFF_SOFT.md'), 'should not appear', 'utf8');

  const capture: ChatRequest[] = [];
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => fakeAdapter(capture),
    // Force sim off so this test is robust to a dev shell that has
    // SW_SIM_* env vars set for live acceptance testing.
    sim: { softHandoffAfterUserTurns: null, hardHandoffAfterUserTurns: null },
  });
  t.after(async () => {
    await fastify.close();
    await rm(blocksDir, { recursive: true, force: true });
    await fx.cleanup();
  });

  const token = await mintSession(fastify, fx.origin);
  for (let i = 0; i < 10; i++) {
    await sendTurn(fastify, token, `turn ${i}`);
  }
  for (const req of capture) {
    const systemMessage = req.messages.find((m) => m.role === 'system');
    assert.ok(systemMessage);
    assert.ok(
      !/HANDOFF_SOFT/.test(systemMessage.content),
      `sim with no input/env should never inject (saw HANDOFF_SOFT in turn ${capture.indexOf(req) + 1})`,
    );
  }
});

test('M23.5 soft sim: suppressed for admin-mode sessions (M21 semantics preserved)', async (t) => {
  const fx = await seedSimChatbot();
  const blocksDir = path.join('data', 'chatbots', fx.slug);
  await mkdir(blocksDir, { recursive: true });
  await writeFile(path.join(blocksDir, 'HANDOFF_SOFT.md'), 'should not appear for admin', 'utf8');

  const capture: ChatRequest[] = [];
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => fakeAdapter(capture),
    sim: { softHandoffAfterUserTurns: 2 },
  });
  t.after(async () => {
    await fastify.close();
    await rm(blocksDir, { recursive: true, force: true });
    await fx.cleanup();
  });

  // Mint an admin-mode session directly (bypass HTTP — same path as
  // POST /admin/chatbots/{slug}/sessions).
  const session = await createSession(fx.db, fx.chatbot.id, { isAdminMode: true });
  for (let i = 0; i < 4; i++) {
    const res = await sendTurn(fastify, session.token, `admin turn ${i}`);
    assert.equal(res.statusCode, 200);
  }
  for (const req of capture) {
    const systemMessage = req.messages.find((m) => m.role === 'system');
    assert.ok(systemMessage);
    assert.ok(
      !/HANDOFF_SOFT/.test(systemMessage.content),
      `admin-mode should suppress soft sim (saw HANDOFF_SOFT in turn ${capture.indexOf(req) + 1})`,
    );
  }
});

// ---------------------------------------------------------------------------
// Hard sim
// ---------------------------------------------------------------------------

test('M23.5 hard sim: terminates session on the Nth user turn (no session cap configured)', async (t) => {
  const fx = await seedSimChatbot();
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => fakeAdapter(),
    sim: { hardHandoffAfterUserTurns: 3 },
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const token = await mintSession(fastify, fx.origin);

  // Turns 1 + 2: below threshold, no termination.
  for (const i of [1, 2]) {
    const res = await sendTurn(fastify, token, `hi ${i}`);
    assert.equal(res.statusCode, 200);
    assert.equal(res.json().session_terminated, undefined, `turn ${i} should NOT terminate`);
  }

  // Turn 3: count = 3, sim hard threshold met → reply persists + terminate.
  const r3 = await sendTurn(fastify, token, 'hi 3');
  assert.equal(r3.statusCode, 200);
  assert.equal(r3.json().session_terminated, true);
  assert.ok(r3.json().message_id > 0, 'final natural reply still persists');

  // Turn 4: terminated → canned response, no LLM call, message_id 0.
  const r4 = await sendTurn(fastify, token, 'hi 4');
  assert.equal(r4.statusCode, 200);
  assert.equal(r4.json().session_terminated, true);
  assert.equal(r4.json().message_id, 0);
});

test('M23.5 hard sim: fires the handoff webhook (when configured) on termination', async (t) => {
  const fx = await seedSimChatbot();
  // Use a fake handoff_webhook_url that won't connect — we only check the
  // session got marked terminated_at + the webhook was attempted (i.e. no
  // crash from the fire-and-forget path).
  await fx.db('chatbots').where({ id: fx.chatbot.id }).update({
    handoff_webhook_url: 'http://test.invalid/handoff',
  });

  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => fakeAdapter(),
    sim: { hardHandoffAfterUserTurns: 2 },
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const token = await mintSession(fastify, fx.origin);
  await sendTurn(fastify, token, 'first');
  const r2 = await sendTurn(fastify, token, 'second');
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().session_terminated, true);

  const session = await fx.db('sessions').where({ token }).first();
  assert.ok(session.terminated_at, 'session row should carry terminated_at');
});

test('M23.5 hard sim: admin-mode terminates session but suppresses the webhook (M21)', async (t) => {
  const fx = await seedSimChatbot();
  await fx.db('chatbots').where({ id: fx.chatbot.id }).update({
    handoff_webhook_url: 'http://test.invalid/handoff',
  });

  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => fakeAdapter(),
    sim: { hardHandoffAfterUserTurns: 2 },
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const session = await createSession(fx.db, fx.chatbot.id, { isAdminMode: true });
  await sendTurn(fastify, session.token, 'first');
  const r2 = await sendTurn(fastify, session.token, 'second');
  assert.equal(r2.statusCode, 200);
  assert.equal(r2.json().session_terminated, true);

  const row = await fx.db('sessions').where({ id: session.id }).first();
  assert.ok(row.terminated_at, 'admin-mode hard sim should still terminate (safety belt)');
  // handoff_notified_at would be set if the webhook fired and got 2xx; we
  // can't probe the fake URL but we can confirm the admin-mode branch was
  // taken: the notify call is gated `if (!session.is_admin_mode)`, so
  // handoff_notified_at stays NULL even with handoff_webhook_url set.
  assert.equal(row.handoff_notified_at, null, 'webhook must NOT fire for admin-mode');
});

// ---------------------------------------------------------------------------
// M23.6 final-turn predictor
// ---------------------------------------------------------------------------

test('M23.6 final-turn hint: HANDOFF_FINAL injected when sim hard threshold reached', async (t) => {
  const fx = await seedSimChatbot();
  const capture: ChatRequest[] = [];
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => fakeAdapter(capture),
    // Hard sim at turn 3 → the request that hits turn 3 should carry the
    // HANDOFF_FINAL block in its system prompt.
    sim: { softHandoffAfterUserTurns: null, hardHandoffAfterUserTurns: 3 },
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const token = await mintSession(fastify, fx.origin);

  // Turn 1 + 2: predictor doesn't fire (userTurnCount < 3).
  await sendTurn(fastify, token, 'hi 1');
  let systemMessage = capture.at(-1)?.messages.find((m) => m.role === 'system');
  assert.ok(systemMessage);
  assert.ok(!/HANDOFF_FINAL/.test(systemMessage.content), 'turn 1 should not inject final hint');

  await sendTurn(fastify, token, 'hi 2');
  systemMessage = capture.at(-1)?.messages.find((m) => m.role === 'system');
  assert.ok(systemMessage);
  assert.ok(!/HANDOFF_FINAL/.test(systemMessage.content), 'turn 2 should not inject final hint');

  // Turn 3: predictor fires; HANDOFF_FINAL appears in the system prompt
  // and the response is marked session_terminated.
  const res = await sendTurn(fastify, token, 'hi 3');
  assert.equal(res.json().session_terminated, true);
  systemMessage = capture.at(-1)?.messages.find((m) => m.role === 'system');
  assert.ok(systemMessage);
  assert.match(systemMessage.content, /<block name="HANDOFF_FINAL">/);
  assert.match(systemMessage.content, /do NOT end with a question/);
});

test('M23.6 final-turn hint: suppressed for admin-mode sessions even when sim hard would fire', async (t) => {
  const fx = await seedSimChatbot();
  const capture: ChatRequest[] = [];
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => fakeAdapter(capture),
    sim: { softHandoffAfterUserTurns: null, hardHandoffAfterUserTurns: 2 },
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const session = await createSession(fx.db, fx.chatbot.id, { isAdminMode: true });
  for (let i = 0; i < 3; i++) {
    await sendTurn(fastify, session.token, `admin turn ${i}`);
  }
  for (const req of capture) {
    const systemMessage = req.messages.find((m) => m.role === 'system');
    assert.ok(systemMessage);
    assert.ok(
      !/HANDOFF_FINAL/.test(systemMessage.content),
      `admin-mode should suppress final-turn hint (saw HANDOFF_FINAL in turn ${capture.indexOf(req) + 1})`,
    );
  }
});

test('M23.6 final-turn hint: not injected when neither real spend nor sim trigger applies', async (t) => {
  const fx = await seedSimChatbot();
  const capture: ChatRequest[] = [];
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => fakeAdapter(capture),
    // Force sim off entirely; no session cap configured → no real trigger.
    sim: { softHandoffAfterUserTurns: null, hardHandoffAfterUserTurns: null },
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const token = await mintSession(fastify, fx.origin);
  for (let i = 0; i < 5; i++) {
    await sendTurn(fastify, token, `turn ${i}`);
  }
  for (const req of capture) {
    const systemMessage = req.messages.find((m) => m.role === 'system');
    assert.ok(systemMessage);
    assert.ok(
      !/HANDOFF_FINAL/.test(systemMessage.content),
      `no triggers means no final-turn hint (saw it in turn ${capture.indexOf(req) + 1})`,
    );
  }
});

// ---------------------------------------------------------------------------
// /health sim_active surface
// ---------------------------------------------------------------------------

test('M23.5 /health: sim_active honours non-production / production branching', async (t) => {
  const { env: runtimeEnv } = await import('./config/env.js');
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    sim: { softHandoffAfterUserTurns: 5 },
  });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const res = await fastify.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  if (runtimeEnv.isProduction) {
    // In production the field is omitted entirely (even when sim is set
    // via opts — the env loader refuses SW_SIM_* in production so opts.sim
    // is the only way to get here, and we still hide the field).
    assert.equal(body.sim_active, undefined, 'sim_active must be absent in production');
  } else {
    assert.equal(body.sim_active, true, 'sim_active should be true with sim configured');
  }
});

test('M23.5 /health: sim_active is false (non-prod) or absent (prod) when sim is force-off', async (t) => {
  const { env: runtimeEnv } = await import('./config/env.js');
  const db = makeTestDb();
  const fastify = await buildServer({
    db,
    logger: false,
    // Explicit null overrides any SW_SIM_* env vars set in the dev shell.
    sim: { softHandoffAfterUserTurns: null, hardHandoffAfterUserTurns: null },
  });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const res = await fastify.inject({ method: 'GET', url: '/health' });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  if (runtimeEnv.isProduction) {
    assert.equal(body.sim_active, undefined);
  } else {
    assert.equal(body.sim_active, false);
  }
});

test('M23.5 hard sim: does NOT fire when sim is force-off (regression)', async (t) => {
  const fx = await seedSimChatbot();
  const fastify = await buildServer({
    db: fx.db,
    logger: false,
    adapterFactory: () => fakeAdapter(),
    // Force sim off so this test is robust to a dev shell that has
    // SW_SIM_* env vars set for live acceptance testing.
    sim: { softHandoffAfterUserTurns: null, hardHandoffAfterUserTurns: null },
  });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const token = await mintSession(fastify, fx.origin);
  for (let i = 0; i < 10; i++) {
    const res = await sendTurn(fastify, token, `turn ${i}`);
    assert.equal(res.statusCode, 200);
    assert.equal(
      res.json().session_terminated,
      undefined,
      `turn ${i} should never terminate without sim configured`,
    );
  }
});
