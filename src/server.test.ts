import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildServer } from './server.js';
import { addOrigin } from './services/chatbots.js';
import { makeTestDb, seedAccountAndChatbot } from './testing/db.js';
import { VERSION } from './utils/version.js';

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

  // bearerAuth security scheme is declared in components and applied to the
  // protected routes; sessions documents its Origin header parameter.
  const schemes = spec.components?.securitySchemes as Record<string, unknown> | undefined;
  assert.ok(schemes?.bearerAuth, 'expected components.securitySchemes.bearerAuth');
  const messagesGet = (spec.paths['/messages'] as { get: { security?: unknown[] } }).get;
  const chatPost = (spec.paths['/chat'] as { post: { security?: unknown[] } }).post;
  assert.deepEqual(messagesGet.security, [{ bearerAuth: [] }]);
  assert.deepEqual(chatPost.security, [{ bearerAuth: [] }]);
  const sessionsPost = (
    spec.paths['/sessions'] as { post: { parameters?: Array<{ in: string; name: string }> } }
  ).post;
  const originParam = sessionsPost.parameters?.find(
    (p) => p.in === 'header' && p.name === 'origin',
  );
  assert.ok(originParam, 'expected an Origin header parameter on POST /sessions');
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

  const { account } = await seedAccountAndChatbot(db, slug);
  await addOrigin(db, slug, origin);
  // Set a custom welcome so we can verify it's returned.
  await db('chatbots').where({ slug }).update({ welcome_message: 'Greetings, traveller.' });

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db('accounts').where({ id: account.id }).del();
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

test('POST /sessions: falls back to default welcome when chatbots.welcome_message is NULL', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const origin = `https://${slug}.example.com`;

  const { account } = await seedAccountAndChatbot(db, slug);
  await addOrigin(db, slug, origin);

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db('accounts').where({ id: account.id }).del();
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

test('CORS: OPTIONS preflight from a registered origin echoes Access-Control-Allow-Origin', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const origin = `https://${slug}.example.com`;

  const { account } = await seedAccountAndChatbot(db, slug);
  await addOrigin(db, slug, origin);

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const response = await fastify.inject({
    method: 'OPTIONS',
    url: '/sessions',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], origin);
  // Vary: Origin keeps caches from cross-pollinating responses across origins.
  assert.match(response.headers['vary'] as string, /Origin/);
  const allowMethods = response.headers['access-control-allow-methods'] as string;
  assert.match(allowMethods, /POST/);
  assert.match(allowMethods, /OPTIONS/);
  const allowHeaders = (response.headers['access-control-allow-headers'] as string).toLowerCase();
  assert.match(allowHeaders, /authorization/);
  assert.match(allowHeaders, /content-type/);
});

test('CORS: OPTIONS preflight from an unregistered origin gets no Access-Control-Allow-Origin', async (t) => {
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({
    method: 'OPTIONS',
    url: '/sessions',
    headers: {
      origin: 'https://stranger.example.com',
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'authorization,content-type',
    },
  });

  // The server doesn't 403 — it just doesn't grant CORS. Browser blocks
  // the subsequent actual request. This deliberately doesn't leak which
  // origins are registered.
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('CORS: POST /sessions actual response carries Access-Control-Allow-Origin for a registered origin', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const origin = `https://${slug}.example.com`;

  const { account } = await seedAccountAndChatbot(db, slug);
  await addOrigin(db, slug, origin);

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const response = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin },
  });

  assert.equal(response.statusCode, 201);
  assert.equal(response.headers['access-control-allow-origin'], origin);
  assert.match(response.headers['vary'] as string, /Origin/);
});

test('CORS: request without an Origin header still succeeds (non-browser callers)', async (t) => {
  // curl, ./bin/chat, server-to-server — these don't send Origin and must
  // not be affected by the CORS layer. POST /sessions has its own 400 for
  // missing origin; that's a separate gate from CORS.
  const db = makeTestDb();
  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db.destroy();
  });

  const response = await fastify.inject({ method: 'GET', url: '/openapi.json' });
  assert.equal(response.statusCode, 200);
  assert.equal(response.headers['access-control-allow-origin'], undefined);
});

test('POST /sessions then GET /messages returns an empty message list', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const origin = `https://${slug}.example.com`;

  const { account } = await seedAccountAndChatbot(db, slug);
  await addOrigin(db, slug, origin);

  const fastify = await buildServer({ db, logger: false });
  t.after(async () => {
    await fastify.close();
    await db('accounts').where({ id: account.id }).del();
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
