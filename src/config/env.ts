import path from 'node:path';
import os from 'node:os';

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
  /** Override path for site-walker.toml. Undefined when SW_CONFIG is unset. */
  readonly swConfig: string | undefined;
  /** Resolved $XDG_CONFIG_HOME, defaulting to $HOME/.config. */
  readonly xdgConfigHome: string;
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

/**
 * Build a `RuntimeEnv` from the current state of `process.env`. The
 * singleton `env` export is the result of calling this at module load.
 * Call this directly only when you need a fresh snapshot — usually that's
 * a test that has just mutated `process.env`.
 */
export function loadEnv(): RuntimeEnv {
  const home = os.homedir();
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
    swConfig:
      process.env.SW_CONFIG && process.env.SW_CONFIG !== '' ? process.env.SW_CONFIG : undefined,
    xdgConfigHome: nonEmptyOrDefault(process.env.XDG_CONFIG_HOME, path.join(home, '.config')),
  });
  return env;
}

export const env: RuntimeEnv = loadEnv();
