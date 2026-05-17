import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import type { Knex } from 'knex';
import { buildServer } from './server.js';
import { createWebsite, addOrigin } from './services/websites.js';
import { VERSION } from './utils/version.js';

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

test('GET / returns JSON when Accept does not prefer HTML', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({ method: 'GET', url: '/' });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), {
    ok: true,
    service: 'site-walker',
    version: VERSION,
  });
});

test('GET / returns the HTML landing page when Accept prefers text/html', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({
    method: 'GET',
    url: '/',
    headers: { accept: 'text/html,application/xhtml+xml,*/*;q=0.8' },
  });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] as string, /text\/html/);
  const body = response.body;
  assert.match(body, /<title>site-walker<\/title>/);
  assert.match(body, new RegExp(`Version ${VERSION}`));
  assert.match(body, /github\.com\/headwalluk\/site-walker/);
  assert.match(body, /\/openapi\.json/);
});

test('GET /openapi.json returns the generated OpenAPI 3 spec', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({ method: 'GET', url: '/openapi.json' });
  assert.equal(response.statusCode, 200);
  const spec = response.json();
  assert.match(spec.openapi as string, /^3\./);
  assert.equal(spec.info.title, 'site-walker');
  assert.equal(spec.info.version, VERSION);
  const paths = Object.keys(spec.paths as Record<string, unknown>);
  assert.ok(paths.includes('/health'), `expected /health in paths, got: ${paths.join(', ')}`);
  assert.ok(paths.includes('/sessions'), `expected /sessions in paths`);
  assert.ok(paths.includes('/messages'), `expected /messages in paths`);
  assert.ok(paths.includes('/chat'), `expected /chat in paths`);
});

test('GET /docs serves the Swagger UI HTML', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({ method: 'GET', url: '/docs/' });
  assert.equal(response.statusCode, 200);
  assert.match(response.headers['content-type'] as string, /text\/html/);
  assert.match(response.body, /swagger-ui/i);
});

test('GET /health returns ok payload with DB reachable', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({ method: 'GET', url: '/health' });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.ok, true);
  assert.equal(body.db, true);
  assert.equal(body.version, VERSION);
  assert.match(body.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test('POST /sessions: rejects when Origin header is missing', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({ method: 'POST', url: '/sessions' });
  assert.equal(response.statusCode, 400);
  assert.equal(response.json().error, 'origin_required');
});

test('POST /sessions: rejects when Origin is not on any allowlist', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin: 'https://not-registered-anywhere.example' },
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error, 'origin_not_allowed');
});

test('POST /sessions: mints a token and returns welcome for an allowed origin', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const origin = `https://${slug}.example.com`;

  await createWebsite(db, { slug, name: 'Test' });
  await addOrigin(db, slug, origin);
  // Set a custom welcome so we can verify it's returned.
  await db('websites').where({ slug }).update({ welcome_message: 'Greetings, traveller.' });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const response = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
  });
  assert.equal(response.statusCode, 201);
  const body = response.json();
  assert.equal(body.welcome_message, 'Greetings, traveller.');
  assert.match(body.session_token, /^[0-9a-f]{64}$/);
});

test('POST /sessions: falls back to default welcome when websites.welcome_message is NULL', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const origin = `https://${slug}.example.com`;

  await createWebsite(db, { slug, name: 'Test' });
  await addOrigin(db, slug, origin);

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const response = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
  });
  assert.equal(response.statusCode, 201);
  assert.equal(response.json().welcome_message, 'Hi! How can I help?');
});

test('GET /messages: 401 without bearer token', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({ method: 'GET', url: '/messages' });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, 'token_required');
});

test('GET /messages: 401 when bearer token is unknown', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({
    method: 'GET',
    url: '/messages',
    headers: { authorization: 'Bearer not-a-real-token' },
  });
  assert.equal(response.statusCode, 401);
  assert.equal(response.json().error, 'invalid_token');
});

test('POST /sessions then GET /messages returns an empty message list', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const origin = `https://${slug}.example.com`;

  await createWebsite(db, { slug, name: 'Test' });
  await addOrigin(db, slug, origin);

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const createRes = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
  });
  assert.equal(createRes.statusCode, 201);
  const token = createRes.json().session_token;

  const listRes = await fastify.inject({
    method: 'GET',
    url: '/messages',
    headers: { authorization: `Bearer ${token}` },
  });
  assert.equal(listRes.statusCode, 200);
  assert.deepEqual(listRes.json(), { messages: [] });
});
