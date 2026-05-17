import knex, { type Knex } from 'knex';
import { env } from '../config/env.js';

/**
 * Shared knex factory for integration tests. Each test that needs DB access
 * calls this and `.destroy()`s the result in its `t.after` so the pool
 * doesn't leak. Connection details come from the runtime env — see
 * `src/config/env.ts`.
 */
export function makeTestDb(): Knex {
  return knex({
    client: 'mysql2',
    connection: {
      host: env.db.host,
      port: env.db.port,
      user: env.db.user,
      password: env.db.password,
      database: env.db.name,
    },
    pool: { min: 0, max: 5 },
  });
}
