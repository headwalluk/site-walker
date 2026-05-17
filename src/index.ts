import { buildServer } from './server.js';
import { db } from './db/index.js';
import { env } from './config/env.js';
import { assertEnvFilePermissions } from './utils/env.js';
import { loadConfig } from './config/site-walker-config.js';
import { validateRegistryAgainstWebsites } from './services/models.js';
import { anyWebsiteHasGeoMode, MaxMindGeoChecker } from './services/geo.js';
import type { GeoChecker } from './services/geo.js';

assertEnvFilePermissions();

const registry = await loadConfig();
await validateRegistryAgainstWebsites(db, registry);

// Geo-blocking init:
//   - If GEOIP_DB_PATH is set, load the .mmdb and pass the checker in.
//   - If it's unset but any website has a non-allowall mode, refuse to start.
//   - If both are absent we run without a checker (allowall everywhere).
let geoChecker: GeoChecker | null = null;
if (env.geoipDbPath) {
  try {
    geoChecker = await MaxMindGeoChecker.fromFile(env.geoipDbPath);
  } catch (err) {
    console.error(`Failed to open GEOIP_DB_PATH="${env.geoipDbPath}": ${(err as Error).message}`);
    process.exit(1);
  }
} else if (await anyWebsiteHasGeoMode(db)) {
  console.error(
    'GEOIP_DB_PATH is unset, but at least one website is configured with a non-allowall ' +
      'geo mode. Either set GEOIP_DB_PATH in .env (point it at e.g. ' +
      '/var/lib/GeoIP/GeoLite2-Country.mmdb), or reset the affected websites to ' +
      '`sw website set-geo-mode <slug> allowall`.',
  );
  process.exit(1);
}

const fastify = await buildServer({ db, registry, geoChecker });

try {
  await fastify.listen({ port: env.http.port, host: env.http.host });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
