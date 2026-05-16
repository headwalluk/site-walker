import { existsSync, statSync } from 'node:fs';

// Mirror src/utils/env.ts: knex CLI loads this file before running any
// migration; same 0600 gate keeps DB_PASSWORD from leaking through a
// world-readable .env. Duplicated rather than imported because this file
// is consumed by knex CLI without a build step.
if (existsSync('.env')) {
  const mode = statSync('.env').mode & 0o777;
  if (mode !== 0o600) {
    const octal = mode.toString(8).padStart(4, '0');
    throw new Error(`Env file .env must be mode 0600 (currently ${octal}).\nRun: chmod 0600 .env`);
  }
}

/** @type {import('knex').Knex.Config} */
export default {
  client: 'mysql2',
  connection: {
    host: process.env.DB_HOST ?? '127.0.0.1',
    port: Number(process.env.DB_PORT ?? 3306),
    user: process.env.DB_USER ?? 'site_walker',
    password: process.env.DB_PASSWORD ?? '',
    database: process.env.DB_NAME ?? 'site_walker',
    charset: 'utf8mb4',
  },
  pool: { min: 0, max: 10 },
  migrations: {
    directory: './migrations',
    extension: 'js',
  },
};
