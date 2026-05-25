/**
 * PM2 ecosystem config sample for site-walker.
 *
 * Copy to `ecosystem.config.cjs` and adjust the operator-specific values
 * (cwd, log paths if you want them elsewhere). The `.cjs` extension is
 * required because this project's package.json has `"type": "module"` —
 * PM2 needs to `require()` the ecosystem file, which means CommonJS.
 *
 * ----------------------------------------------------------------------------
 * Usage:
 *
 *   pm2 start ecosystem.config.cjs
 *   pm2 save                  # snapshot the running process list
 *   pm2 startup               # generate the systemd unit that boots PM2
 *                             # on host reboot. Run the command it prints.
 *
 *   pm2 logs site-walker      # tail logs
 *   pm2 restart site-walker   # graceful restart (e.g. after deploy)
 *   pm2 reload site-walker    # zero-downtime restart (cluster only; n/a here)
 *
 * ----------------------------------------------------------------------------
 * Before deploying — change these:
 *
 *   1. cwd ................... absolute path to the deployed repo root.
 *                              The .env file MUST be at `<cwd>/.env`.
 *   2. out_file / error_file . optional; defaults to ~/.pm2/logs/ if omitted.
 *
 * ----------------------------------------------------------------------------
 * Design notes:
 *
 * - Single instance, fork mode. Cluster mode would split the M23 in-memory
 *   rate-limit buckets across workers; until cluster mode is paired with
 *   Redis-backed rate limiting (M11, post-v1.0.0), fork mode is what keeps
 *   the per-IP / per-chatbot counters accurate.
 *
 * - `--env-file-if-exists=.env` is essential. The npm `start` script passes
 *   it; PM2 launches Node directly, so we replicate it here. Without it,
 *   `process.env` is empty when `src/config/env.ts` loads at module-import
 *   time, and the boot-time gate rejects everything for missing
 *   SW_ENCRYPTION_KEY.
 *
 * - max_restarts + min_uptime guards against a misconfigured boot (bad
 *   encryption key, .env not 0600, unreachable DB) burning CPU in an
 *   infinite restart loop. PM2 gives up after 5 quick failures and stays
 *   down — which is what you want; the operator gets a clean signal.
 *
 * - max_memory_restart at 512M is roomy. site-walker is comfortably under
 *   200MB on first-customer scale.
 */

module.exports = {
  apps: [
    {
      name: 'site-walker',
      script: 'dist/index.js',
      // Replicate the `npm start` flag so the .env file is loaded before
      // any module imports (env.ts is a module-load singleton).
      node_args: ['--env-file-if-exists=.env'],

      // Absolute path to the deployed repo. .env must be at <cwd>/.env.
      cwd: '/path/to/site-walker',

      // Single-process fork mode — required while rate limiting is in-memory.
      instances: 1,
      exec_mode: 'fork',

      // Restart policy.
      autorestart: true,
      max_restarts: 5,
      min_uptime: '10s',
      restart_delay: 2000,

      // Memory ceiling — site-walker stays well under this in normal use;
      // a creep past 512MB is a sign of a leak worth investigating.
      max_memory_restart: '512M',

      // Logging — uncomment + adjust if you want logs outside ~/.pm2/logs/.
      // out_file:   '/var/log/site-walker/out.log',
      // error_file: '/var/log/site-walker/error.log',
      merge_logs: true,
      log_date_format: 'YYYY-MM-DD HH:mm:ss Z',

      // Inherits the shell's env by default. Anything sensitive (DB
      // credentials, SW_ENCRYPTION_KEY, SW_PROVISIONING_KEY, BYO LLM keys
      // via the admin API or sw chatbot set-api-key) lives in .env and is
      // loaded via the --env-file-if-exists=.env node arg above — NOT
      // pasted here. The block below is for non-secret overrides only.
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
