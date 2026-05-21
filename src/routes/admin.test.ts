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
