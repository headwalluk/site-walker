import Fastify, { type FastifyInstance } from 'fastify';

export function buildServer(opts: { logger?: boolean } = {}): FastifyInstance {
  const fastify = Fastify({ logger: opts.logger ?? true });

  fastify.get('/', async () => {
    return { ok: true, service: 'site-walker', version: '0.2.0' };
  });

  return fastify;
}
