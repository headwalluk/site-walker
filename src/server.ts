import Fastify, { type FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { findWebsiteByOrigin } from './services/websites.js';
import { createSession, findSessionByToken, listMessages } from './services/sessions.js';
import { ChatError, runChat, type AdapterFactory } from './services/chat.js';
import type { ProviderRegistry } from './config/site-walker-config.js';

const DEFAULT_WELCOME = 'Hi! How can I help?';

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

const CHAT_ERROR_STATUS: Record<ChatError['code'], number> = {
  invalid_token: 401,
  message_required: 400,
  message_too_long: 400,
  context_overflow: 413,
  model_not_configured: 503,
  model_error: 502,
};

export async function buildServer(opts: BuildServerOpts): Promise<FastifyInstance> {
  const { db, logger = true, registry, adapterFactory } = opts;
  const fastify = Fastify({ logger });

  fastify.get('/', async () => ({
    ok: true,
    service: 'site-walker',
    version: '0.6.0',
  }));

  fastify.post('/sessions', async (req, reply) => {
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
  });

  fastify.get('/messages', async (req, reply) => {
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
  });

  fastify.post('/chat', async (req, reply) => {
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
  });

  return fastify;
}
