import knex, { type Knex } from 'knex';
import { env } from '../config/env.js';

const config: Knex.Config = {
  client: 'mysql2',
  connection: {
    host: env.db.host,
    port: env.db.port,
    user: env.db.user,
    password: env.db.password,
    database: env.db.name,
    charset: 'utf8mb4',
  },
  pool: { min: 0, max: 10 },
};

export const db: Knex = knex(config);
