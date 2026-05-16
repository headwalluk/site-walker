import Fastify from 'fastify';

const fastify = Fastify({
  logger: true,
});

fastify.get('/', async () => {
  return { ok: true, service: 'site-walker', version: '0.2.0' };
});

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

try {
  await fastify.listen({ port, host });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
