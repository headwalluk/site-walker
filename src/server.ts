import Fastify, { type FastifyInstance } from 'fastify';
import type { Knex } from 'knex';
import { findWebsiteByOrigin } from './services/websites.js';
import { createSession, findSessionByToken, listMessages } from './services/sessions.js';

const DEFAULT_WELCOME = 'Hi! How can I help?';

export interface BuildServerOpts {
  db: Knex;
  logger?: boolean;
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

export async function buildServer({
  db,
  logger = true,
}: BuildServerOpts): Promise<FastifyInstance> {
  const fastify = Fastify({ logger });

  fastify.get('/', async () => ({
    ok: true,
    service: 'site-walker',
    version: '0.2.0',
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

  return fastify;
}
