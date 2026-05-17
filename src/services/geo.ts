import type { Knex } from 'knex';
import { open as openMaxmind, type Reader, type CountryResponse } from 'maxmind';

/**
 * Lightweight interface over a country lookup. The production binding is
 * `MaxMindGeoChecker` reading `/var/lib/GeoIP/GeoLite2-Country.mmdb` (or
 * whichever .mmdb GEOIP_DB_PATH points at). Tests inject a fake.
 */
export interface GeoChecker {
  /** ISO 3166-1 alpha-2 (e.g. 'GB') or `null` when the IP doesn't resolve. */
  lookup(ip: string): string | null;
}

export class MaxMindGeoChecker implements GeoChecker {
  private constructor(private readonly reader: Reader<CountryResponse>) {}

  static async fromFile(filePath: string): Promise<MaxMindGeoChecker> {
    const reader = await openMaxmind<CountryResponse>(filePath);
    return new MaxMindGeoChecker(reader);
  }

  lookup(ip: string): string | null {
    if (!ip) return null;
    try {
      const result = this.reader.get(ip);
      const code = result?.country?.iso_code;
      return typeof code === 'string' ? code.toUpperCase() : null;
    } catch {
      // Malformed IP or unindexed range — caller treats as "unknown country".
      return null;
    }
  }
}

export type GeoModeCode = 'allowall' | 'blocklist' | 'allowlist';

export interface WebsiteGeoPolicy {
  websiteId: number;
  modeCode: GeoModeCode;
  /** ISO 3166-1 alpha-2 codes, upper-cased. */
  countries: ReadonlySet<string>;
}

export interface CheckGeoResult {
  allowed: boolean;
  /** ISO code of the visitor's country, or null when unresolved. */
  country: string | null;
  mode: GeoModeCode;
  /**
   * When `allowed` is false, this carries the reason — useful for the
   * server-side log line. Not sent to the client (we keep the 403 body
   * minimal so policy details don't leak).
   */
  reason?: 'in_blocklist' | 'not_in_allowlist' | 'unknown_country_strict';
}

/**
 * Resolve a website's mode + country list. Two queries (one for the mode
 * code, one for the countries). Caller decides how often to call — Phase 1
 * does it per-request; if profiling later shows it's hot, M11's Redis cache
 * is the natural place to memoise.
 */
export async function loadWebsiteGeoPolicy(db: Knex, websiteId: number): Promise<WebsiteGeoPolicy> {
  const modeRow = await db('websites as w')
    .join('geo_modes as g', 'g.id', 'w.geo_mode_id')
    .where('w.id', websiteId)
    .first<{ code: string } | undefined>('g.code');

  if (!modeRow) {
    throw new Error(`No geo policy resolved for website_id=${websiteId}`);
  }

  const codes = await db<{ country_code: string }>('website_geo_countries')
    .where({ website_id: websiteId })
    .pluck('country_code');

  return {
    websiteId,
    modeCode: modeRow.code as GeoModeCode,
    countries: new Set(codes.map((c) => c.toUpperCase())),
  };
}

/**
 * Pure policy decision. Caller supplies the policy (from `loadWebsiteGeoPolicy`)
 * + the visitor's IP + a country lookup. Returns `{ allowed, country, mode }`.
 *
 * Unresolved IPs (private ranges, loopback, IPv6 link-local, malformed) are
 * allowed only when `isProduction` is false. Production refuses them so
 * unknown-country can't be a loophole.
 */
export function checkGeoPolicy(
  policy: WebsiteGeoPolicy,
  ip: string,
  checker: GeoChecker | null,
  opts: { isProduction: boolean },
): CheckGeoResult {
  if (policy.modeCode === 'allowall') {
    return { allowed: true, country: null, mode: 'allowall' };
  }

  const country = checker ? checker.lookup(ip) : null;

  if (country === null) {
    return {
      allowed: !opts.isProduction,
      country: null,
      mode: policy.modeCode,
      reason: opts.isProduction ? 'unknown_country_strict' : undefined,
    };
  }

  const inList = policy.countries.has(country);

  if (policy.modeCode === 'blocklist') {
    return {
      allowed: !inList,
      country,
      mode: 'blocklist',
      reason: inList ? 'in_blocklist' : undefined,
    };
  }

  // allowlist
  return {
    allowed: inList,
    country,
    mode: 'allowlist',
    reason: inList ? undefined : 'not_in_allowlist',
  };
}

const VALID_GEO_MODES: readonly GeoModeCode[] = ['allowall', 'blocklist', 'allowlist'];

const COUNTRY_CODE_PATTERN = /^[A-Z]{2}$/;

export function isValidGeoModeCode(code: string): code is GeoModeCode {
  return (VALID_GEO_MODES as readonly string[]).includes(code);
}

/**
 * Update a website's geo mode by human-readable code.
 * Throws on unknown slug or unknown mode code.
 */
export async function setWebsiteGeoMode(
  db: Knex,
  slug: string,
  modeCode: string,
): Promise<{ websiteId: number; modeCode: GeoModeCode }> {
  if (!isValidGeoModeCode(modeCode)) {
    throw new Error(
      `Invalid geo mode "${modeCode}". Expected one of: ${VALID_GEO_MODES.join(', ')}.`,
    );
  }
  const website = await db<{ id: number }>('websites').where({ slug }).first('id');
  if (!website) throw new Error(`Website not found: slug="${slug}"`);
  const mode = await db<{ id: number }>('geo_modes').where({ code: modeCode }).first('id');
  if (!mode) throw new Error(`geo_modes row missing for code="${modeCode}" — migration drift?`);
  await db('websites').where({ id: website.id }).update({ geo_mode_id: mode.id });
  return { websiteId: website.id, modeCode };
}

/**
 * Atomically replace a website's geo country list. Pass an empty array to
 * clear. Codes are upper-cased and validated as ISO 3166-1 alpha-2 shape
 * (two letters, no validation against the full ISO list — MaxMind silently
 * never matches non-existent codes anyway).
 */
export async function setWebsiteGeoCountries(
  db: Knex,
  slug: string,
  codes: readonly string[],
): Promise<{ websiteId: number; countries: string[] }> {
  const normalised: string[] = [];
  const seen = new Set<string>();
  for (const raw of codes) {
    const c = raw.trim().toUpperCase();
    if (c.length === 0) continue;
    if (!COUNTRY_CODE_PATTERN.test(c)) {
      throw new Error(`Invalid country code "${raw}" — expected ISO 3166-1 alpha-2 (two letters).`);
    }
    if (!seen.has(c)) {
      seen.add(c);
      normalised.push(c);
    }
  }

  const website = await db<{ id: number }>('websites').where({ slug }).first('id');
  if (!website) throw new Error(`Website not found: slug="${slug}"`);

  await db.transaction(async (trx) => {
    await trx('website_geo_countries').where({ website_id: website.id }).del();
    if (normalised.length > 0) {
      await trx('website_geo_countries').insert(
        normalised.map((country_code) => ({ website_id: website.id, country_code })),
      );
    }
  });

  return { websiteId: website.id, countries: normalised };
}

export interface GeoSummary {
  websiteId: number;
  slug: string;
  modeCode: GeoModeCode;
  countries: string[];
}

/** Human-friendly summary used by the CLI. */
export async function getWebsiteGeoSummary(db: Knex, slug: string): Promise<GeoSummary> {
  const row = await db('websites as w')
    .join('geo_modes as g', 'g.id', 'w.geo_mode_id')
    .where('w.slug', slug)
    .first<{ id: number; slug: string; code: string } | undefined>('w.id', 'w.slug', 'g.code');
  if (!row) throw new Error(`Website not found: slug="${slug}"`);
  const codes = await db<{ country_code: string }>('website_geo_countries')
    .where({ website_id: row.id })
    .orderBy('country_code', 'asc')
    .pluck('country_code');
  return {
    websiteId: row.id,
    slug: row.slug,
    modeCode: row.code as GeoModeCode,
    countries: codes.map((c) => c.toUpperCase()),
  };
}

/**
 * Boot-time check: returns true iff any website is configured with a mode
 * other than `allowall`. If GEOIP_DB_PATH is unset (no checker loaded) but
 * this is true, startup should refuse to continue.
 */
export async function anyWebsiteHasGeoMode(db: Knex): Promise<boolean> {
  const row = await db('websites as w')
    .join('geo_modes as g', 'g.id', 'w.geo_mode_id')
    .whereNot('g.code', 'allowall')
    .first('w.id');
  return row !== undefined;
}
