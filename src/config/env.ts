/**
 * Normalised, frozen view of the runtime environment. All `process.env`
 * reads in production code go through this module. Construction validates
 * everything that has a sensible failure mode (ports must be positive
 * integers, etc.) so consumers can rely on shape without re-checking.
 *
 * Tests that need to vary env between runs can call `loadEnv()` after
 * mutating `process.env`, instead of relying on the module-load singleton.
 */
export interface RuntimeEnv {
  readonly db: {
    readonly host: string;
    readonly port: number;
    readonly user: string;
    readonly password: string;
    readonly name: string;
  };
  readonly http: {
    readonly host: string;
    readonly port: number;
  };
  /**
   * Raw `NODE_ENV`, defaulting to `'production'` so the tighter mode
   * applies whenever the var is unset. Set explicitly to `'development'`
   * (or any other value) to opt out of production-tight defaults.
   */
  readonly nodeEnv: string;
  /** `true` iff `nodeEnv === 'production'`. Used for security defaults. */
  readonly isProduction: boolean;
  /**
   * Path to the MaxMind GeoIP2 / GeoLite2 country database file. When set,
   * the server loads it at boot and the geo-blocking feature is available.
   * When unset, geo-blocking can only operate in `allowall` mode — startup
   * refuses to continue if any chatbot has a stricter mode configured.
   */
  readonly geoipDbPath: string | undefined;
  /**
   * Defensive upper bound on `chatbots.daily_budget_usd`. The CLI and admin
   * PATCH refuse to set a higher value with `validation_failed`. Operators
   * who genuinely need a higher cap raise this in `.env`; the default
   * catches typos and miscreant operators trying to set absurd amounts.
   */
  readonly maxDailyBudgetUsd: number;
  /** Defensive upper bound on `chatbots.session_budget_usd`. Same shape. */
  readonly maxSessionBudgetUsd: number;
}

function parsePort(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(`Env var ${name} must be a positive integer in [1, 65535], got "${raw}".`);
  }
  return n;
}

function nonEmptyOrDefault(raw: string | undefined, fallback: string): string {
  if (raw === undefined || raw === '') return fallback;
  return raw;
}

function parsePositiveDecimal(raw: string | undefined, name: string, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Env var ${name} must be a positive number, got "${raw}".`);
  }
  return n;
}

/**
 * Build a `RuntimeEnv` from the current state of `process.env`. The
 * singleton `env` export is the result of calling this at module load.
 * Call this directly only when you need a fresh snapshot — usually that's
 * a test that has just mutated `process.env`.
 */
export function loadEnv(): RuntimeEnv {
  const nodeEnv = nonEmptyOrDefault(process.env.NODE_ENV, 'production');
  const env: RuntimeEnv = Object.freeze({
    db: Object.freeze({
      host: nonEmptyOrDefault(process.env.DB_HOST, '127.0.0.1'),
      port: parsePort(process.env.DB_PORT, 'DB_PORT', 3306),
      user: nonEmptyOrDefault(process.env.DB_USER, 'site_walker'),
      password: process.env.DB_PASSWORD ?? '',
      name: nonEmptyOrDefault(process.env.DB_NAME, 'site_walker'),
    }),
    http: Object.freeze({
      host: nonEmptyOrDefault(process.env.HOST, '127.0.0.1'),
      port: parsePort(process.env.PORT, 'PORT', 47830),
    }),
    nodeEnv,
    isProduction: nodeEnv === 'production',
    geoipDbPath:
      process.env.GEOIP_DB_PATH && process.env.GEOIP_DB_PATH !== ''
        ? process.env.GEOIP_DB_PATH
        : undefined,
    maxDailyBudgetUsd: parsePositiveDecimal(
      process.env.SW_MAX_DAILY_BUDGET_USD,
      'SW_MAX_DAILY_BUDGET_USD',
      10000,
    ),
    maxSessionBudgetUsd: parsePositiveDecimal(
      process.env.SW_MAX_SESSION_BUDGET_USD,
      'SW_MAX_SESSION_BUDGET_USD',
      100,
    ),
  });
  return env;
}

export const env: RuntimeEnv = loadEnv();
