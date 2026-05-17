import { buildServer } from './server.js';
import { db } from './db/index.js';
import { env } from './config/env.js';
import { assertEnvFilePermissions } from './utils/env.js';
import { loadConfig } from './config/site-walker-config.js';
import { validateRegistryAgainstWebsites } from './services/models.js';

assertEnvFilePermissions();

const registry = await loadConfig();
await validateRegistryAgainstWebsites(db, registry);

const fastify = await buildServer({ db, registry });

try {
  await fastify.listen({ port: env.http.port, host: env.http.host });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
