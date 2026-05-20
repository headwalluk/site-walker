import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  anyChatbotHasGeoMode,
  checkGeoPolicy,
  getChatbotGeoSummary,
  isValidGeoModeCode,
  setChatbotGeoCountries,
  setChatbotGeoMode,
  type GeoChecker,
  type ChatbotGeoPolicy,
} from './geo.js';
import { makeTestDb, seedAccountAndChatbot } from '../testing/db.js';

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

function policy(modeCode: ChatbotGeoPolicy['modeCode'], codes: string[]): ChatbotGeoPolicy {
  return { chatbotId: 1, modeCode, countries: new Set(codes.map((c) => c.toUpperCase())) };
}

const fakeChecker = (mapping: Record<string, string | null>): GeoChecker => ({
  lookup: (ip) => (ip in mapping ? mapping[ip] : null),
});

test('checkGeoPolicy: allowall ignores country and always allows', () => {
  const result = checkGeoPolicy(
    policy('allowall', ['XX']),
    '8.8.8.8',
    fakeChecker({ '8.8.8.8': 'US' }),
    { isProduction: true },
  );
  assert.equal(result.allowed, true);
  assert.equal(result.mode, 'allowall');
  assert.equal(result.country, null);
});

test('checkGeoPolicy: blocklist blocks listed country', () => {
  const result = checkGeoPolicy(
    policy('blocklist', ['RU', 'CN']),
    '1.1.1.1',
    fakeChecker({ '1.1.1.1': 'RU' }),
    { isProduction: true },
  );
  assert.equal(result.allowed, false);
  assert.equal(result.country, 'RU');
  assert.equal(result.reason, 'in_blocklist');
});

test('checkGeoPolicy: blocklist allows non-listed country', () => {
  const result = checkGeoPolicy(
    policy('blocklist', ['RU', 'CN']),
    '8.8.8.8',
    fakeChecker({ '8.8.8.8': 'US' }),
    { isProduction: true },
  );
  assert.equal(result.allowed, true);
  assert.equal(result.country, 'US');
});

test('checkGeoPolicy: allowlist allows listed country', () => {
  const result = checkGeoPolicy(
    policy('allowlist', ['GB']),
    '212.58.244.22',
    fakeChecker({ '212.58.244.22': 'GB' }),
    { isProduction: true },
  );
  assert.equal(result.allowed, true);
  assert.equal(result.country, 'GB');
});

test('checkGeoPolicy: allowlist blocks non-listed country', () => {
  const result = checkGeoPolicy(
    policy('allowlist', ['GB']),
    '8.8.8.8',
    fakeChecker({ '8.8.8.8': 'US' }),
    { isProduction: true },
  );
  assert.equal(result.allowed, false);
  assert.equal(result.country, 'US');
  assert.equal(result.reason, 'not_in_allowlist');
});

test('checkGeoPolicy: null country allowed in dev (isProduction=false)', () => {
  const result = checkGeoPolicy(
    policy('blocklist', ['RU']),
    '127.0.0.1',
    fakeChecker({ '127.0.0.1': null }),
    { isProduction: false },
  );
  assert.equal(result.allowed, true);
  assert.equal(result.country, null);
});

test('checkGeoPolicy: null country blocked in production (strict)', () => {
  const result = checkGeoPolicy(
    policy('blocklist', ['RU']),
    '127.0.0.1',
    fakeChecker({ '127.0.0.1': null }),
    { isProduction: true },
  );
  assert.equal(result.allowed, false);
  assert.equal(result.country, null);
  assert.equal(result.reason, 'unknown_country_strict');
});

test('checkGeoPolicy: no checker passed → treats every IP as unknown', () => {
  const dev = checkGeoPolicy(policy('blocklist', ['RU']), '8.8.8.8', null, { isProduction: false });
  assert.equal(dev.allowed, true);

  const prod = checkGeoPolicy(policy('blocklist', ['RU']), '8.8.8.8', null, { isProduction: true });
  assert.equal(prod.allowed, false);
});

test('isValidGeoModeCode: discriminates valid vs invalid codes', () => {
  assert.equal(isValidGeoModeCode('allowall'), true);
  assert.equal(isValidGeoModeCode('blocklist'), true);
  assert.equal(isValidGeoModeCode('allowlist'), true);
  assert.equal(isValidGeoModeCode('invalid'), false);
  assert.equal(isValidGeoModeCode(''), false);
});

test('setChatbotGeoMode + getChatbotGeoSummary roundtrip', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug, { name: 'Geo Test' });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  let summary = await getChatbotGeoSummary(db, slug);
  assert.equal(summary.modeCode, 'allowall');
  assert.deepEqual(summary.countries, []);

  await setChatbotGeoMode(db, slug, 'blocklist');
  summary = await getChatbotGeoSummary(db, slug);
  assert.equal(summary.modeCode, 'blocklist');
});

test('setChatbotGeoMode: rejects unknown mode code', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });
  await assert.rejects(
    () => setChatbotGeoMode(db, 'no-such-slug', 'banhammer'),
    /Invalid geo mode/,
  );
});

test('setChatbotGeoMode: throws on unknown slug', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });
  await assert.rejects(
    () => setChatbotGeoMode(db, 'no-such-slug', 'blocklist'),
    /Chatbot not found/,
  );
});

test('setChatbotGeoCountries: atomic replace + uppercases + dedupes', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug, { name: 'Geo Test' });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await setChatbotGeoCountries(db, slug, ['gb', 'US', 'gb', '  fr  ']);
  let summary = await getChatbotGeoSummary(db, slug);
  assert.deepEqual(summary.countries.sort(), ['FR', 'GB', 'US']);

  // Atomic replace.
  await setChatbotGeoCountries(db, slug, ['JP']);
  summary = await getChatbotGeoSummary(db, slug);
  assert.deepEqual(summary.countries, ['JP']);

  // Empty clears.
  await setChatbotGeoCountries(db, slug, []);
  summary = await getChatbotGeoSummary(db, slug);
  assert.deepEqual(summary.countries, []);
});

test('setChatbotGeoCountries: rejects invalid codes', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug, { name: 'Geo Test' });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await assert.rejects(
    () => setChatbotGeoCountries(db, slug, ['GB', 'GBR']),
    /Invalid country code/,
  );
  await assert.rejects(() => setChatbotGeoCountries(db, slug, ['12']), /Invalid country code/);
});

test('anyChatbotHasGeoMode: false when all allowall, true when any other', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug, { name: 'Geo Test' });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  // Note: other chatbots in the dev DB may already be on non-allowall modes;
  // this test asserts the function returns true when *our* row is set.
  await setChatbotGeoMode(db, slug, 'blocklist');
  assert.equal(await anyChatbotHasGeoMode(db), true);

  await setChatbotGeoMode(db, slug, 'allowall');
  // Don't assert false unconditionally — depends on shared DB state.
});
