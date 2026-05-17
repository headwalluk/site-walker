import Fastify, { type FastifyInstance } from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import type { Knex } from 'knex';
import { findWebsiteByOrigin } from './services/websites.js';
import { createSession, findSessionByToken, listMessages } from './services/sessions.js';
import { ChatError, runChat, type AdapterFactory } from './services/chat.js';
import type { ProviderRegistry } from './config/site-walker-config.js';
import { VERSION } from './utils/version.js';

const DEFAULT_WELCOME = 'Hi! How can I help?';
const STRAPLINE = 'A self-hosted, multi-tenant pre-sales chatbot API.';
const GITHUB_URL = 'https://github.com/headwalluk/site-walker';

export interface BuildServerOpts {
  db: Knex;
  logger?: boolean;
  /**
   * Provider registry for /chat. Optional so tests that don't exercise /chat
   * can build the server with just a db. /chat returns 500 if absent.
   */
  registry?: ProviderRegistry;
  /** Replace the adapter factory used by /chat (tests inject a fake). */
  adapterFactory?: AdapterFactory;
}

/**
 * Phase 1 capacity check is a stub. M11 wires real per-IP and per-website
 * rate limits via Redis here.
 */
function hasCapacity(_websiteId: number): boolean {
  return true;
}

function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const match = /^Bearer (.+)$/.exec(authHeader);
  return match ? match[1] : null;
}

const CHAT_ERROR_STATUS = {
  invalid_token: 401,
  message_required: 400,
  message_too_long: 400,
  context_overflow: 413,
  model_not_configured: 503,
  model_error: 502,
} as const satisfies Record<ChatError['code'], number>;

function clientPrefersHtml(acceptHeader: string | undefined): boolean {
  if (!acceptHeader) return false;
  return acceptHeader.toLowerCase().includes('text/html');
}

function renderLandingPage(version: string, year: number): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>site-walker</title>
<style>
:root {
  --bg-from: #1a2540;
  --bg-to: #0f1830;
  --card: #243a6b;
  --text: #e6ecf8;
  --muted: #9eb0d4;
  --border: rgba(255,255,255,0.08);
  --button-bg: rgba(255,255,255,0.04);
  --button-bg-hover: rgba(255,255,255,0.10);
  --pill-good-bg: #2f8d4a;
  --pill-good-fg: #d8f7e0;
  --pill-bad-bg: #b94545;
  --pill-bad-fg: #ffd5d5;
  --pill-unknown-bg: #4a5568;
  --pill-unknown-fg: #cbd5e0;
}
html, body { height: 100%; margin: 0; }
body {
  background: linear-gradient(160deg, var(--bg-from), var(--bg-to));
  color: var(--text);
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, sans-serif;
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 40px 40px 32px;
  width: 100%; max-width: 480px;
  box-shadow: 0 20px 60px rgba(0,0,0,0.35);
  text-align: center;
}
h1 { margin: 0 0 6px; font-size: 28px; font-weight: 600; letter-spacing: -0.01em; }
.version { color: var(--muted); font-size: 13px; margin-bottom: 20px; }
.strapline { color: var(--muted); font-size: 14px; line-height: 1.5; margin-bottom: 24px; }
.pill {
  display: inline-flex; align-items: center; gap: 8px;
  padding: 10px 18px;
  border-radius: 999px;
  font-size: 13px; font-weight: 500;
  margin-bottom: 24px;
}
.pill .dot { width: 8px; height: 8px; border-radius: 50%; }
.pill.unknown { background: var(--pill-unknown-bg); color: var(--pill-unknown-fg); }
.pill.unknown .dot { background: var(--pill-unknown-fg); animation: pulse 1.2s ease-in-out infinite; }
.pill.good { background: var(--pill-good-bg); color: var(--pill-good-fg); }
.pill.good .dot { background: var(--pill-good-fg); }
.pill.bad { background: var(--pill-bad-bg); color: var(--pill-bad-fg); }
.pill.bad .dot { background: var(--pill-bad-fg); }
@keyframes pulse { 0%,100% { opacity: 0.4; } 50% { opacity: 1; } }
.links {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
a.button {
  display: block;
  padding: 12px 14px;
  background: var(--button-bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  color: var(--text);
  text-decoration: none;
  font-size: 13px;
  transition: background 120ms;
}
a.button:hover, a.button:focus { background: var(--button-bg-hover); outline: none; }
footer { color: var(--muted); font-size: 11px; margin-top: 28px; }
footer a { color: var(--muted); }
</style>
</head>
<body>
  <main class="card">
    <h1>site-walker</h1>
    <div class="version">Version ${version}</div>
    <div class="strapline">${STRAPLINE}</div>
    <div id="status" class="pill unknown" role="status" aria-live="polite">
      <span class="dot"></span>
      <span class="label">Checking…</span>
    </div>
    <nav class="links">
      <a class="button" href="/health">Health Check</a>
      <a class="button" href="${GITHUB_URL}">GitHub Repo</a>
      <a class="button" href="/docs">API Documentation</a>
      <a class="button" href="/openapi.json">OpenAPI JSON</a>
    </nav>
    <footer>
      &copy; ${year} Headwall Hosting &middot;
      <a href="${GITHUB_URL}/blob/main/LICENSE">AGPL-3.0</a>
    </footer>
  </main>
  <script>
  (async () => {
    const pill = document.getElementById('status');
    const label = pill.querySelector('.label');
    try {
      const res = await fetch('/health', { headers: { 'Accept': 'application/json' } });
      const data = await res.json();
      pill.classList.remove('unknown');
      if (data && data.ok) {
        pill.classList.add('good');
        label.textContent = 'System Operational';
      } else {
        pill.classList.add('bad');
        label.textContent = 'Degraded';
      }
    } catch (e) {
      pill.classList.remove('unknown');
      pill.classList.add('bad');
      label.textContent = 'Unreachable';
    }
  })();
  </script>
</body>
</html>
`;
}

const errorResponseSchema = {
  type: 'object',
  properties: {
    error: { type: 'string' },
    detail: { type: 'object', additionalProperties: true },
  },
  required: ['error'],
};

export async function buildServer(opts: BuildServerOpts): Promise<FastifyInstance> {
  const { db, logger = true, registry, adapterFactory } = opts;
  const fastify = Fastify({ logger });

  await fastify.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'site-walker',
        description:
          'Self-hosted multi-tenant pre-sales chatbot API. ' +
          'Browser traffic authenticates by `Origin` allowlist + opaque session token; ' +
          'admin work goes through `./bin/sw` against the local database. ' +
          'See https://github.com/headwalluk/site-walker for full documentation.',
        version: VERSION,
        license: { name: 'AGPL-3.0-only', url: `${GITHUB_URL}/blob/main/LICENSE` },
      },
      servers: [{ url: '/', description: 'this instance' }],
      tags: [
        { name: 'meta', description: 'service metadata and health' },
        { name: 'sessions', description: 'session lifecycle (browser auth)' },
        { name: 'messages', description: 'conversation rehydrate' },
        { name: 'chat', description: 'send a turn, get a reply' },
      ],
    },
  });

  await fastify.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: false },
    staticCSP: true,
  });

  fastify.get('/openapi.json', { schema: { hide: true } }, async () => fastify.swagger());

  fastify.get(
    '/',
    {
      schema: {
        tags: ['meta'],
        summary: 'Landing page / service metadata',
        description:
          'Responds with an HTML status card when `Accept: text/html` is requested ' +
          '(browsers), otherwise returns the service metadata JSON.',
        response: {
          200: {
            description: 'service metadata (when client does not request HTML)',
            type: 'object',
            properties: {
              ok: { type: 'boolean' },
              service: { type: 'string' },
              version: { type: 'string' },
            },
            required: ['ok', 'service', 'version'],
          },
        },
      },
    },
    async (req, reply) => {
      if (clientPrefersHtml(req.headers.accept)) {
        return reply
          .header('content-type', 'text/html; charset=utf-8')
          .send(renderLandingPage(VERSION, new Date().getFullYear()));
      }
      return {
        ok: true,
        service: 'site-walker',
        version: VERSION,
      };
    },
  );

  const healthResponseSchema = {
    type: 'object',
    properties: {
      ok: { type: 'boolean' },
      db: { type: 'boolean' },
      version: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
    },
    required: ['ok', 'db', 'version', 'timestamp'],
  };

  fastify.get(
    '/health',
    {
      schema: {
        tags: ['meta'],
        summary: 'Health check',
        description:
          'Returns 200 with `ok: true` when the database is reachable; ' +
          '503 with `ok: false` otherwise. Used by the landing-page status pill.',
        response: { 200: healthResponseSchema, 503: healthResponseSchema },
      },
    },
    async (req, reply) => {
      let dbOk = false;
      try {
        await db.raw('SELECT 1');
        dbOk = true;
      } catch (err) {
        req.log.error({ err }, 'health: DB ping failed');
      }
      return reply.status(dbOk ? 200 : 503).send({
        ok: dbOk,
        db: dbOk,
        version: VERSION,
        timestamp: new Date().toISOString(),
      });
    },
  );

  fastify.post(
    '/sessions',
    {
      schema: {
        tags: ['sessions'],
        summary: 'Mint a session token',
        description:
          "Verifies the request `Origin` header against the calling website's " +
          "allowlist and returns an opaque session token plus the website's " +
          'welcome message. The token is carried as `Authorization: Bearer ...` ' +
          'on subsequent calls.',
        response: {
          201: {
            description: 'session created',
            type: 'object',
            properties: {
              session_token: { type: 'string' },
              welcome_message: { type: 'string' },
            },
            required: ['session_token', 'welcome_message'],
          },
          400: errorResponseSchema,
          403: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const origin = req.headers.origin;
      if (!origin) {
        return reply.status(400).send({ error: 'origin_required' });
      }

      let website = null;
      try {
        website = await findWebsiteByOrigin(db, origin);
      } catch {
        // Malformed origin — treat as not allowed.
      }
      if (!website) {
        return reply.status(403).send({ error: 'origin_not_allowed' });
      }

      if (!hasCapacity(website.id)) {
        return reply.status(503).send({ error: 'capacity_exceeded' });
      }

      const session = await createSession(db, website.id);
      return reply.status(201).send({
        session_token: session.token,
        welcome_message: website.welcome_message ?? DEFAULT_WELCOME,
      });
    },
  );

  fastify.get(
    '/messages',
    {
      schema: {
        tags: ['messages'],
        summary: 'Rehydrate session history',
        description:
          'Returns the full ordered list of messages for the session identified ' +
          'by the `Authorization: Bearer ...` token. Used by clients on page load ' +
          'to restore a conversation in progress.',
        response: {
          200: {
            description: 'message history',
            type: 'object',
            properties: {
              messages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'integer' },
                    session_id: { type: 'integer' },
                    role: { type: 'string', enum: ['user', 'assistant'] },
                    content: { type: 'string' },
                    created_at: { type: 'string', format: 'date-time' },
                  },
                },
              },
            },
            required: ['messages'],
          },
          401: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        return reply.status(401).send({ error: 'token_required' });
      }
      const session = await findSessionByToken(db, token);
      if (!session) {
        return reply.status(401).send({ error: 'invalid_token' });
      }
      const messages = await listMessages(db, session.id);
      return reply.send({ messages });
    },
  );

  fastify.post(
    '/chat',
    {
      schema: {
        tags: ['chat'],
        summary: 'Send a user turn, get the assistant reply',
        description:
          'Requires `Authorization: Bearer <session_token>`. Body is a JSON object ' +
          'with a single `message` string (1–8000 chars, trimmed). The server ' +
          "persists the user message, calls the configured LLM with the website's " +
          'system blocks + history, persists the assistant reply, and returns just ' +
          'the new reply. Use `GET /messages` to rehydrate the full conversation.',
        response: {
          200: {
            description: 'assistant reply',
            type: 'object',
            properties: {
              reply: { type: 'string' },
              message_id: { type: 'integer' },
              tokens_used: {
                type: 'object',
                properties: {
                  prompt: { type: 'integer' },
                  completion: { type: 'integer' },
                },
              },
            },
            required: ['reply', 'message_id'],
          },
          400: errorResponseSchema,
          401: errorResponseSchema,
          413: errorResponseSchema,
          500: errorResponseSchema,
          502: errorResponseSchema,
          503: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const token = extractBearerToken(req.headers.authorization);
      if (!token) {
        return reply.status(401).send({ error: 'token_required' });
      }
      if (!registry) {
        req.log.error('POST /chat called but no provider registry is wired into buildServer');
        return reply.status(500).send({ error: 'server_misconfigured' });
      }
      const body = req.body as { message?: unknown } | undefined;
      if (!body || typeof body.message !== 'string') {
        return reply.status(400).send({ error: 'message_required' });
      }

      try {
        const result = await runChat({
          db,
          registry,
          sessionToken: token,
          message: body.message,
          adapterFactory,
        });
        return reply.send(result);
      } catch (err) {
        if (err instanceof ChatError) {
          const status = CHAT_ERROR_STATUS[err.code];
          const payload: Record<string, unknown> = { error: err.code };
          if (err.detail) payload.detail = err.detail;
          if (err.code === 'model_error') {
            req.log.error({ err: err.message }, 'chat model_error');
          }
          return reply.status(status).send(payload);
        }
        req.log.error(err);
        return reply.status(500).send({ error: 'internal_error' });
      }
    },
  );

  return fastify;
}
