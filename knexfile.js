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
