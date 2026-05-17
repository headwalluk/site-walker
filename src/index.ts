import { buildServer } from './server.js';
import { db } from './db/index.js';
import { assertEnvFilePermissions } from './utils/env.js';
import { loadConfig } from './config/site-walker-config.js';
import { validateRegistryAgainstWebsites } from './services/models.js';

assertEnvFilePermissions();

const registry = await loadConfig();
await validateRegistryAgainstWebsites(db, registry);

const fastify = await buildServer({ db, registry });

const port = Number(process.env.PORT ?? 47830);
const host = process.env.HOST ?? '127.0.0.1';

try {
  await fastify.listen({ port, host });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
