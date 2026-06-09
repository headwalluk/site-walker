/**
 * Privacy-friendly country capture: store the visitor's 2-char country code
 * against a session, never the IP.
 *
 * Pulls forward the "optional country-code persistence" idea from
 * dev-notes/15-privacy-friendly-analytics.md (design pull 2026-06-09). The IP
 * is resolved transiently for the geo check and discarded (see the deliberate
 * no-IP-capture decision); only the low-resolution ISO 3166-1 alpha-2 code is
 * persisted.
 *
 * Sessions gain:
 * - `country_code` — CHAR(2), ISO 3166-1 alpha-2 (e.g. "GB", "US", "FR"),
 *   upper-cased. NULL when unresolved (private/loopback IP, unindexed range,
 *   no GeoIP DB loaded). Captured at session-mint only.
 *
 * @param {import('knex').Knex} knex
 */
export const up = async (knex) => {
  await knex.schema.alterTable('sessions', (t) => {
    t.specificType('country_code', 'CHAR(2)').nullable().after('is_admin_mode');
  });
};

/** @param {import('knex').Knex} knex */
export const down = async (knex) => {
  await knex.schema.alterTable('sessions', (t) => {
    t.dropColumn('country_code');
  });
};
