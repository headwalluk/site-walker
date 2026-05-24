import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Knex } from 'knex';
import { buildServer } from '../server.js';
import { resetProvisioningKeyCache } from '../config/secrets.js';
import { createAccount, type Account } from '../services/accounts.js';
import { createChatbot } from '../services/chatbots.js';
import { createAdminKey } from '../services/admin-keys.js';
import { makeTestDb, seedAccountAndChatbot } from '../testing/db.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const VALID_PROVISIONING = 'sw_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEf';

function uniqueSlug(prefix = 'admin'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function setProvisioningKey(value: string | null): void {
  resetProvisioningKeyCache();
  if (value === null) {
    delete process.env.SW_PROVISIONING_KEY;
  } else {
    process.env.SW_PROVISIONING_KEY = value;
  }
}

interface AdminContext {
  account: Account;
  rawKey: string;
  keyId: string;
}

async function seedAdminContext(db: Knex): Promise<AdminContext> {
  const slug = uniqueSlug('acct');
  const account = await createAccount(db, { slug, name: slug });
  const minted = await createAdminKey(db, { accountId: account.id });
  return { account, rawKey: minted.rawKey, keyId: minted.id };
}

// ---------------------------------------------------------------------------
// Auth middleware behaviour
// ---------------------------------------------------------------------------

test('admin: /admin/accounts returns 401 when SW_PROVISIONING_KEY is unset', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(null);
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db.destroy();
  });

  const res = await fastify.inject({ method: 'GET', url: '/admin/accounts' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'bearer_invalid');
});

test('admin: /admin/accounts returns 401 bearer_required when no Authorization header', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db.destroy();
  });

  const res = await fastify.inject({ method: 'GET', url: '/admin/accounts' });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'bearer_required');
});

test('admin: /admin/accounts returns 401 bearer_invalid with wrong bearer', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: '/admin/accounts',
    headers: { authorization: 'Bearer sw_someOtherKey1234567890123456789012345678' },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'bearer_invalid');
});

test('admin: /admin/chatbots returns 403 wrong_scope when called with provisioning bearer', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: '/admin/chatbots',
    headers: { authorization: `Bearer ${VALID_PROVISIONING}` },
  });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().error, 'wrong_scope');
});

test('admin: /admin/chatbots returns 401 bearer_invalid for a revoked admin key', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  // Revoke the key directly via DB so we don't need to wire the revoke route here.
  await db('admin_keys').where({ id: ctx.keyId }).update({ revoked_at: db.fn.now() });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: '/admin/chatbots',
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 401);
  assert.equal(res.json().error, 'bearer_invalid');
});

// ---------------------------------------------------------------------------
// /admin/accounts/*
// ---------------------------------------------------------------------------

test('admin: GET /admin/accounts returns the seeded account list', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const slug = uniqueSlug();
  const account = await createAccount(db, { slug, name: slug });
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: '/admin/accounts',
    headers: { authorization: `Bearer ${VALID_PROVISIONING}` },
  });
  assert.equal(res.statusCode, 200);
  const list = res.json().accounts as Array<{ slug: string }>;
  assert.ok(list.some((a) => a.slug === slug));
});

test('admin: POST /admin/accounts creates and returns 201', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const slug = uniqueSlug();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ slug }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/admin/accounts',
    headers: { authorization: `Bearer ${VALID_PROVISIONING}` },
    payload: { slug, name: 'Test Account' },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().slug, slug);
  assert.equal(res.json().name, 'Test Account');
});

test('admin: POST /admin/accounts returns 409 on duplicate slug', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const slug = uniqueSlug();
  await createAccount(db, { slug, name: slug });
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ slug }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/admin/accounts',
    headers: { authorization: `Bearer ${VALID_PROVISIONING}` },
    payload: { slug, name: 'dup' },
  });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().error, 'conflict');
});

test('admin: POST /admin/accounts returns 400 on malformed body', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/admin/accounts',
    headers: { authorization: `Bearer ${VALID_PROVISIONING}` },
    payload: { name: 'missing slug' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'validation_failed');
});

test('admin: POST /admin/accounts/{id}/keys mints + returns raw key once', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const account = await createAccount(db, { slug: uniqueSlug(), name: 'x' });
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: `/admin/accounts/${account.id}/keys`,
    headers: { authorization: `Bearer ${VALID_PROVISIONING}` },
    payload: { description: 'test mint' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.match(body.raw_key, /^sw_[A-Za-z0-9_-]{43}$/);
  assert.equal(body.description, 'test mint');
});

test('admin: GET /admin/accounts/{id}/keys lists keys without leaking token_hash', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/accounts/${ctx.account.id}/keys`,
    headers: { authorization: `Bearer ${VALID_PROVISIONING}` },
  });
  assert.equal(res.statusCode, 200);
  const keys = res.json().admin_keys as Array<{ id: string; token_hash?: string }>;
  assert.equal(keys.length, 1);
  assert.equal(keys[0].id, ctx.keyId);
  assert.equal(keys[0].token_hash, undefined);
});

test('admin: DELETE /admin/accounts/{id}/keys/{keyId} revokes the row', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'DELETE',
    url: `/admin/accounts/${ctx.account.id}/keys/${ctx.keyId}`,
    headers: { authorization: `Bearer ${VALID_PROVISIONING}` },
  });
  assert.equal(res.statusCode, 200);
  assert.ok(res.json().revoked_at);
});

// ---------------------------------------------------------------------------
// /admin/chatbots/* core CRUD
// ---------------------------------------------------------------------------

test("admin: GET /admin/chatbots lists only the auth account's chatbots", async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);

  // Make a chatbot under this account, plus an unrelated account+chatbot.
  const mySlug = uniqueSlug('chatbot');
  const otherSlug = uniqueSlug('chatbot');
  const { account: otherAccount } = await seedAccountAndChatbot(db, otherSlug);
  await createChatbot(db, { account_id: ctx.account.id, slug: mySlug, name: mySlug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').whereIn('id', [ctx.account.id, otherAccount.id]).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: '/admin/chatbots',
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 200);
  const list = res.json().chatbots as Array<{ slug: string }>;
  assert.ok(list.some((c) => c.slug === mySlug));
  assert.ok(!list.some((c) => c.slug === otherSlug));
});

test('admin: POST /admin/chatbots creates in the auth account, returns 201', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/admin/chatbots',
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: { slug, name: 'New Chatbot' },
  });
  assert.equal(res.statusCode, 201);
  const body = res.json();
  assert.equal(body.slug, slug);
  assert.equal(body.account_id, ctx.account.id);
});

test('admin: GET /admin/chatbots/{slug} returns 404 for a chatbot in another account (cross-account guard)', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const otherSlug = uniqueSlug('chatbot');
  const { account: otherAccount } = await seedAccountAndChatbot(db, otherSlug);

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').whereIn('id', [ctx.account.id, otherAccount.id]).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${otherSlug}`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

test('admin: PATCH /admin/chatbots/{slug} updates whitelisted fields', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({
    account_id: ctx.account.id,
    slug,
    name: 'Original Name',
  });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'PATCH',
    url: `/admin/chatbots/${slug}`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: { name: 'Renamed', welcome_message: 'Hi there!', persona: 'helpful' },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.name, 'Renamed');
  assert.equal(body.welcome_message, 'Hi there!');
  assert.equal(body.persona, 'helpful');
});

test('admin: PATCH /admin/chatbots/{slug} sets M20 budget caps + handoff webhook', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  // Happy path: set all four fields together.
  const res = await fastify.inject({
    method: 'PATCH',
    url: `/admin/chatbots/${slug}`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: {
      daily_budget_usd: 2.5,
      session_budget_usd: 0.25,
      handoff_threshold_pct: 75,
      handoff_webhook_url: 'https://example.test/hook',
    },
  });
  assert.equal(res.statusCode, 200, res.payload);
  const body = res.json();
  assert.equal(Number(body.daily_budget_usd), 2.5);
  assert.equal(Number(body.session_budget_usd), 0.25);
  assert.equal(body.handoff_threshold_pct, 75);
  assert.equal(body.handoff_webhook_url, 'https://example.test/hook');

  // Clearing with null.
  const clear = await fastify.inject({
    method: 'PATCH',
    url: `/admin/chatbots/${slug}`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: {
      daily_budget_usd: null,
      session_budget_usd: null,
      handoff_webhook_url: null,
    },
  });
  assert.equal(clear.statusCode, 200);
  const cleared = clear.json();
  assert.equal(cleared.daily_budget_usd, null);
  assert.equal(cleared.session_budget_usd, null);
  assert.equal(cleared.handoff_webhook_url, null);
});

test('admin: PATCH /admin/chatbots/{slug} rejects out-of-bounds + malformed M20 fields', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const cases: Array<{ payload: Record<string, unknown>; reason: string }> = [
    { payload: { daily_budget_usd: 999999999 }, reason: 'daily over env cap' },
    { payload: { daily_budget_usd: 0 }, reason: 'daily zero' },
    { payload: { daily_budget_usd: -1 }, reason: 'daily negative' },
    { payload: { session_budget_usd: 999999 }, reason: 'session over env cap' },
    { payload: { handoff_threshold_pct: 0 }, reason: 'pct zero' },
    { payload: { handoff_threshold_pct: 101 }, reason: 'pct over 100' },
    { payload: { handoff_threshold_pct: 50.5 }, reason: 'pct non-integer' },
    { payload: { handoff_webhook_url: 'not-a-url' }, reason: 'webhook unparseable' },
    { payload: { handoff_webhook_url: 'ftp://example.test/hook' }, reason: 'webhook wrong scheme' },
  ];

  for (const c of cases) {
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/admin/chatbots/${slug}`,
      headers: { authorization: `Bearer ${ctx.rawKey}` },
      payload: c.payload,
    });
    assert.equal(res.statusCode, 400, `expected 400 for ${c.reason}, got ${res.statusCode}`);
    assert.equal(res.json().error, 'validation_failed');
  }
});

test('admin: PATCH /admin/chatbots/{slug} sets M21 timezone + availability + admin_session_budget_usd', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'PATCH',
    url: `/admin/chatbots/${slug}`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: {
      timezone: 'Europe/London',
      availability: { schedule: { mon: ['09:00-17:00'], tue: ['09:00-12:00', '13:00-17:00'] } },
      admin_session_budget_usd: 5.0,
    },
  });
  assert.equal(res.statusCode, 200, res.payload);
  const body = res.json();
  assert.equal(body.timezone, 'Europe/London');
  assert.deepEqual(body.availability, {
    schedule: { mon: ['09:00-17:00'], tue: ['09:00-12:00', '13:00-17:00'] },
  });
  assert.equal(Number(body.admin_session_budget_usd), 5.0);

  // Clearing.
  const clear = await fastify.inject({
    method: 'PATCH',
    url: `/admin/chatbots/${slug}`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: { timezone: null, availability: null, admin_session_budget_usd: null },
  });
  assert.equal(clear.statusCode, 200);
  const cleared = clear.json();
  assert.equal(cleared.timezone, null);
  assert.equal(cleared.availability, null);
  assert.equal(cleared.admin_session_budget_usd, null);
});

test('admin: PATCH /admin/chatbots/{slug} rejects malformed M21 fields', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const cases: Array<{ payload: Record<string, unknown>; reason: string }> = [
    { payload: { timezone: 'Mars/Olympus_Mons' }, reason: 'unknown IANA tz' },
    { payload: { timezone: 'not-a-tz' }, reason: 'garbage tz' },
    { payload: { availability: { wrong: {} } }, reason: 'missing schedule key' },
    {
      payload: { availability: { schedule: { funday: ['09:00-17:00'] } } },
      reason: 'unknown day key',
    },
    {
      payload: { availability: { schedule: { mon: ['17:00-09:00'] } } },
      reason: 'close before open',
    },
    { payload: { availability: { schedule: { mon: ['nope'] } } }, reason: 'malformed window' },
    { payload: { admin_session_budget_usd: 999999 }, reason: 'admin cap over env limit' },
    { payload: { admin_session_budget_usd: 0 }, reason: 'admin cap zero' },
  ];

  for (const c of cases) {
    const res = await fastify.inject({
      method: 'PATCH',
      url: `/admin/chatbots/${slug}`,
      headers: { authorization: `Bearer ${ctx.rawKey}` },
      payload: c.payload,
    });
    assert.equal(res.statusCode, 400, `expected 400 for ${c.reason}, got ${res.statusCode}`);
    assert.equal(res.json().error, 'validation_failed');
  }
});

test('admin: POST /admin/chatbots/{slug}/sessions mints an admin-mode session with prefixed welcome', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({
    account_id: ctx.account.id,
    slug,
    name: slug,
    welcome_message: 'Hi! How can I help?',
  });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: `/admin/chatbots/${slug}/sessions`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 201, res.payload);
  const body = res.json();
  assert.equal(body.is_admin_mode, true);
  assert.match(body.welcome_message, /^\*\*Admin mode\*\*\n\nHi! How can I help\?$/);
  assert.equal(typeof body.session_token, 'string');
  assert.equal(body.session_token.length, 64);

  // The DB row has is_admin_mode = TRUE.
  const sessionRow = await db('sessions').where({ token: body.session_token }).first();
  // mysql2 returns BOOLEAN as 0/1; coerce.
  assert.equal(Boolean(sessionRow.is_admin_mode), true);
});

test('admin: POST /admin/chatbots/{slug}/sessions enforces cross-account guard', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctxA = await seedAdminContext(db);
  const ctxB = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  // Chatbot belongs to account B.
  await db('chatbots').insert({ account_id: ctxB.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').whereIn('id', [ctxA.account.id, ctxB.account.id]).del();
    await db.destroy();
  });

  // Account A's admin key tries to mint against account B's chatbot.
  const res = await fastify.inject({
    method: 'POST',
    url: `/admin/chatbots/${slug}/sessions`,
    headers: { authorization: `Bearer ${ctxA.rawKey}` },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

test('admin: DELETE /admin/chatbots/{slug} returns cascade counts', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'DELETE',
    url: `/admin/chatbots/${slug}`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(typeof body.origins, 'number');
  assert.equal(typeof body.sessions, 'number');
  assert.equal(typeof body.messages, 'number');
});

// ---------------------------------------------------------------------------
// M22: session/conversation review
// ---------------------------------------------------------------------------

test('admin: GET /admin/chatbots/{slug}/sessions returns paginated sessions with aggregates + total', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  const [chatbotId] = await db('chatbots').insert({
    account_id: ctx.account.id,
    slug,
    name: slug,
  });

  // Three sessions; one with two messages, one empty, one terminated.
  const [sA] = await db('sessions').insert({
    chatbot_id: chatbotId,
    token: 'a'.repeat(64),
  });
  await db('messages').insert({
    session_id: sA,
    chatbot_id: chatbotId,
    role: 'user',
    content: 'hi',
  });
  await db('messages').insert({
    session_id: sA,
    chatbot_id: chatbotId,
    role: 'assistant',
    content: 'hello',
    tokens_in: 80,
    tokens_out: 40,
    cost_usd_estimate: 0.001234,
  });
  await db('sessions').insert({ chatbot_id: chatbotId, token: 'b'.repeat(64) });
  await db('sessions').insert({
    chatbot_id: chatbotId,
    token: 'c'.repeat(64),
    terminated_at: db.fn.now(),
    visitor_email: 'visitor@example.com',
  });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slug}/sessions`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.payload);
  const body = res.json() as {
    sessions: Array<{
      id: number;
      message_count: number;
      tokens_in: number;
      tokens_out: number;
      cost_usd_estimate: number;
      visitor_email: string | null;
      terminated_at: string | null;
      is_admin_mode: boolean;
    }>;
    page: number;
    page_size: number;
    total: number;
  };
  assert.equal(body.total, 3);
  assert.equal(body.page, 1);
  assert.equal(body.page_size, 20);
  assert.equal(body.sessions.length, 3);

  // Token field deliberately stripped.
  for (const s of body.sessions) {
    assert.equal((s as unknown as { token?: string }).token, undefined);
  }
  // The session with messages carries the aggregates.
  const withMessages = body.sessions.find((s) => s.message_count === 2);
  assert.ok(withMessages);
  assert.equal(withMessages.tokens_in, 80);
  assert.equal(withMessages.tokens_out, 40);
  assert.ok(Math.abs(withMessages.cost_usd_estimate - 0.001234) < 1e-9);
  // The terminated session surfaces its terminated_at + visitor_email.
  const terminated = body.sessions.find((s) => s.visitor_email === 'visitor@example.com');
  assert.ok(terminated);
  assert.ok(terminated.terminated_at);
});

test('admin: GET /admin/chatbots/{slug}/sessions honours page + page_size', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  const [chatbotId] = await db('chatbots').insert({
    account_id: ctx.account.id,
    slug,
    name: slug,
  });
  for (let i = 0; i < 5; i++) {
    await db('sessions').insert({
      chatbot_id: chatbotId,
      token: String(i).repeat(64).slice(0, 64),
    });
  }

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const page1 = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slug}/sessions?page=1&page_size=2`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(page1.statusCode, 200, page1.payload);
  const body1 = page1.json();
  assert.equal(body1.total, 5);
  assert.equal(body1.page, 1);
  assert.equal(body1.page_size, 2);
  assert.equal(body1.sessions.length, 2);

  const page3 = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slug}/sessions?page=3&page_size=2`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(page3.statusCode, 200);
  assert.equal(page3.json().sessions.length, 1);
});

test('admin: GET /admin/chatbots/{slug}/sessions cross-account returns 404', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const otherSlug = uniqueSlug('chatbot');
  const { account: otherAccount } = await seedAccountAndChatbot(db, otherSlug);

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').whereIn('id', [ctx.account.id, otherAccount.id]).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${otherSlug}/sessions`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

test('admin: GET /admin/chatbots/{slug}/sessions/{sessionId} returns the session row', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  const [chatbotId] = await db('chatbots').insert({
    account_id: ctx.account.id,
    slug,
    name: slug,
  });
  const [sessionId] = await db('sessions').insert({
    chatbot_id: chatbotId,
    token: 'a'.repeat(64),
  });
  await db('messages').insert({
    session_id: sessionId,
    chatbot_id: chatbotId,
    role: 'user',
    content: 'hi',
  });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slug}/sessions/${sessionId}`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.payload);
  const body = res.json();
  assert.equal(body.id, sessionId);
  assert.equal(body.message_count, 1);
  // Token never leaks.
  assert.equal(body.token, undefined);
});

test('admin: GET /admin/chatbots/{slug}/sessions/{sessionId} returns 404 when session is on another chatbot', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slugA = uniqueSlug('chatbot');
  const slugB = uniqueSlug('chatbot');
  const [chatbotA] = await db('chatbots').insert({
    account_id: ctx.account.id,
    slug: slugA,
    name: slugA,
  });
  const [chatbotB] = await db('chatbots').insert({
    account_id: ctx.account.id,
    slug: slugB,
    name: slugB,
  });
  void chatbotA;
  const [sessionInB] = await db('sessions').insert({
    chatbot_id: chatbotB,
    token: 'b'.repeat(64),
  });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  // Asking about chatbot A for a session that belongs to chatbot B → 404.
  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slugA}/sessions/${sessionInB}`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

test('admin: GET /admin/chatbots/{slug}/sessions/{sessionId} 400s on non-numeric sessionId', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slug}/sessions/not-a-number`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 400);
});

test('admin: GET /admin/chatbots/{slug}/sessions/{sessionId}/messages returns the message list', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  const [chatbotId] = await db('chatbots').insert({
    account_id: ctx.account.id,
    slug,
    name: slug,
  });
  const [sessionId] = await db('sessions').insert({
    chatbot_id: chatbotId,
    token: 'a'.repeat(64),
  });
  await db('messages').insert({
    session_id: sessionId,
    chatbot_id: chatbotId,
    role: 'user',
    content: 'one',
  });
  await db('messages').insert({
    session_id: sessionId,
    chatbot_id: chatbotId,
    role: 'assistant',
    content: 'two',
  });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slug}/sessions/${sessionId}/messages`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 200, res.payload);
  const body = res.json() as {
    messages: Array<{
      role: string;
      content: string;
      tokens_in?: number;
      cost_usd_estimate?: number;
    }>;
  };
  assert.equal(body.messages.length, 2);
  assert.deepEqual(
    body.messages.map((m) => ({ role: m.role, content: m.content })),
    [
      { role: 'user', content: 'one' },
      { role: 'assistant', content: 'two' },
    ],
  );
  // Response schema strips the per-message token / cost columns — admin
  // review takes aggregates from the session-list endpoint.
  for (const m of body.messages) {
    assert.equal(m.tokens_in, undefined);
    assert.equal(m.cost_usd_estimate, undefined);
  }
});

test('admin: GET /admin/chatbots/{slug}/sessions/{sessionId}/messages cross-chatbot returns 404', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slugA = uniqueSlug('chatbot');
  const slugB = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug: slugA, name: slugA });
  const [chatbotB] = await db('chatbots').insert({
    account_id: ctx.account.id,
    slug: slugB,
    name: slugB,
  });
  const [sessionInB] = await db('sessions').insert({
    chatbot_id: chatbotB,
    token: 'b'.repeat(64),
  });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slugA}/sessions/${sessionInB}/messages`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error, 'not_found');
});

// ---------------------------------------------------------------------------
// /admin/chatbots/{slug}/origins/*
// ---------------------------------------------------------------------------

test('admin: POST /admin/chatbots/{slug}/origins adds an origin, returns 201', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const origin = `https://${slug}.test`;
  const res = await fastify.inject({
    method: 'POST',
    url: `/admin/chatbots/${slug}/origins`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: { origin },
  });
  assert.equal(res.statusCode, 201);
  assert.equal(res.json().origin, origin);

  // 409 on duplicate.
  const dup = await fastify.inject({
    method: 'POST',
    url: `/admin/chatbots/${slug}/origins`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: { origin },
  });
  assert.equal(dup.statusCode, 409);
});

test('admin: DELETE /admin/chatbots/{slug}/origins/{originId} returns 204', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const origin = `https://${slug}-2.test`;
  const created = await fastify.inject({
    method: 'POST',
    url: `/admin/chatbots/${slug}/origins`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: { origin },
  });
  assert.equal(created.statusCode, 201);
  const originId = created.json().id;

  const del = await fastify.inject({
    method: 'DELETE',
    url: `/admin/chatbots/${slug}/origins/${originId}`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(del.statusCode, 204);
});

// ---------------------------------------------------------------------------
// /admin/chatbots/{slug}/blocks/*
// ---------------------------------------------------------------------------

test('admin: PUT /admin/chatbots/{slug}/blocks/{name} writes to disk, GET reads it back', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });
  // The block endpoints write to DEFAULT_DATA_DIR/<slug>. Clean up the directory.

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await rm(path.join('data', 'chatbots', slug), { recursive: true, force: true });
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const put = await fastify.inject({
    method: 'PUT',
    url: `/admin/chatbots/${slug}/blocks/COMPANY`,
    headers: {
      authorization: `Bearer ${ctx.rawKey}`,
      'content-type': 'text/markdown',
    },
    payload: '# We make widgets\n\nFounded 1999.',
  });
  assert.equal(put.statusCode, 204);

  const get = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slug}/blocks/COMPANY`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(get.statusCode, 200);
  assert.equal(get.body, '# We make widgets\n\nFounded 1999.');

  // Verify the file actually landed where loadDiskBlocks would find it.
  const onDisk = await readFile(path.join('data', 'chatbots', slug, 'COMPANY.md'), 'utf8');
  assert.equal(onDisk, '# We make widgets\n\nFounded 1999.');
});

test('admin: PUT /admin/chatbots/{slug}/blocks/PERSONA rejected (reserved name)', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'PUT',
    url: `/admin/chatbots/${slug}/blocks/PERSONA`,
    headers: { authorization: `Bearer ${ctx.rawKey}`, 'content-type': 'text/markdown' },
    payload: 'should be rejected',
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error, 'validation_failed');
});

test('admin: PUT /admin/chatbots/{slug}/blocks/{name} rejects non-text/markdown content-type', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await rm(path.join('data', 'chatbots', slug), { recursive: true, force: true });
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'PUT',
    url: `/admin/chatbots/${slug}/blocks/COMPANY`,
    headers: { authorization: `Bearer ${ctx.rawKey}`, 'content-type': 'application/json' },
    payload: '{"content": "x"}',
  });
  // Fastify default 415 — Unsupported Media Type — fires when no parser
  // matches. Our middleware doesn't reach the handler in that case.
  assert.ok(
    res.statusCode === 415,
    `expected 415 from content-type rejection, got ${res.statusCode}`,
  );
});

test('admin: DELETE /admin/chatbots/{slug}/blocks/{name} removes the file', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await rm(path.join('data', 'chatbots', slug), { recursive: true, force: true });
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  await fastify.inject({
    method: 'PUT',
    url: `/admin/chatbots/${slug}/blocks/FAQ`,
    headers: { authorization: `Bearer ${ctx.rawKey}`, 'content-type': 'text/markdown' },
    payload: 'q & a',
  });

  const del = await fastify.inject({
    method: 'DELETE',
    url: `/admin/chatbots/${slug}/blocks/FAQ`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(del.statusCode, 204);

  const del2 = await fastify.inject({
    method: 'DELETE',
    url: `/admin/chatbots/${slug}/blocks/FAQ`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(del2.statusCode, 404);
});

// ---------------------------------------------------------------------------
// /admin/chatbots/{slug}/api-key
// ---------------------------------------------------------------------------

test('admin: PATCH /admin/chatbots/{slug}/api-key encrypts + persists', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'PATCH',
    url: `/admin/chatbots/${slug}/api-key`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: { api_key: 'sk-fake-test-key' },
  });
  assert.equal(res.statusCode, 204);

  const row = await db('chatbots').where({ slug }).first();
  assert.ok(row.provider_api_key_ciphertext);
  assert.ok(row.provider_api_key_nonce);
  assert.ok(row.provider_api_key_auth_tag);
});

test('admin: DELETE /admin/chatbots/{slug}/api-key clears all three encrypted columns', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  await fastify.inject({
    method: 'PATCH',
    url: `/admin/chatbots/${slug}/api-key`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: { api_key: 'sk-fake-test-key' },
  });

  const res = await fastify.inject({
    method: 'DELETE',
    url: `/admin/chatbots/${slug}/api-key`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 204);

  const row = await db('chatbots').where({ slug }).first();
  assert.equal(row.provider_api_key_ciphertext, null);
  assert.equal(row.provider_api_key_nonce, null);
  assert.equal(row.provider_api_key_auth_tag, null);
});

// ---------------------------------------------------------------------------
// /admin/chatbots/{slug}/usage
// ---------------------------------------------------------------------------

test('admin: GET /admin/chatbots/{slug}/usage returns zero-totals for a fresh chatbot', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slug}/usage`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.message_count, 0);
  assert.equal(body.tokens_in, 0);
  assert.equal(body.cost_usd, 0);
  assert.equal(body.period.since, null);
  assert.ok(body.period.until);
});

test('admin: GET /admin/chatbots/{slug}/usage?since=24h narrows the window', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slug}/usage?since=24h`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.ok(body.period.since);
});

// ---------------------------------------------------------------------------
// /admin/chatbots/{slug}/geo
// ---------------------------------------------------------------------------

test('admin: GET /admin/chatbots/{slug}/geo returns the current policy', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: `/admin/chatbots/${slug}/geo`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.mode, 'allowall');
  assert.deepEqual(body.countries, []);
});

test('admin: PATCH /admin/chatbots/{slug}/geo updates mode + countries', async (t) => {
  const db = makeTestDb();
  setProvisioningKey(VALID_PROVISIONING);
  const ctx = await seedAdminContext(db);
  const slug = uniqueSlug('chatbot');
  await db('chatbots').insert({ account_id: ctx.account.id, slug, name: slug });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    setProvisioningKey(null);
    await fastify.close();
    await db('accounts').where({ id: ctx.account.id }).del();
    await db.destroy();
  });

  const res = await fastify.inject({
    method: 'PATCH',
    url: `/admin/chatbots/${slug}/geo`,
    headers: { authorization: `Bearer ${ctx.rawKey}` },
    payload: { mode: 'blocklist', countries: ['RU', 'CN'] },
  });
  assert.equal(res.statusCode, 200);
  const body = res.json();
  assert.equal(body.mode, 'blocklist');
  assert.deepEqual(body.countries.sort(), ['CN', 'RU']);
});

// ---------------------------------------------------------------------------
// Cross-cutting: tmpdir cleanup canary
// ---------------------------------------------------------------------------

test('admin: data/chatbots/<slug>/ stays gitignored — tmpdir reachable for tests', async () => {
  // Sanity check that the OS gives us a writable tmpdir; not strictly needed
  // but a quick canary in case CI environments diverge.
  const dir = await mkdtemp(path.join(tmpdir(), 'sw-admin-'));
  await rm(dir, { recursive: true, force: true });
});
