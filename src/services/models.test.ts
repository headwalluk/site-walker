import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import type { Knex } from 'knex';
import type { ProviderEntry, ProviderRegistry } from '../config/site-walker-config.js';
import {
  defaultHeadroom,
  resolveModel,
  setContextWindow,
  setModel,
  setParameters,
  validateContextBudget,
  validateRegistryAgainstWebsites,
} from './models.js';
import { createWebsite, getWebsiteBySlug } from './websites.js';

function makeTestDb(): Knex {
  return knex({
    client: 'mysql2',
    connection: {
      host: process.env.DB_HOST ?? '127.0.0.1',
      port: Number(process.env.DB_PORT ?? 3306),
      user: process.env.DB_USER ?? 'site_walker',
      password: process.env.DB_PASSWORD ?? '',
      database: process.env.DB_NAME ?? 'site_walker',
    },
    pool: { min: 0, max: 5 },
  });
}

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

function fakeRegistry(entries: ProviderEntry[] = []): ProviderRegistry {
  return {
    configPath: '/tmp/fake.toml',
    providers: new Map(entries.map((e) => [e.name, e])),
  };
}

const piEntry: ProviderEntry = {
  name: 'pi',
  protocol: 'ollama-native',
  base_url: 'http://rpi.local:11434',
};

test('setModel rejects when provider is not in the registry', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  await assert.rejects(
    () => setModel(db, slug, 'nope/qwen2:1.5b', fakeRegistry([piEntry])),
    /Provider "nope".*not defined/,
  );
});

test('setModel persists model_slug when provider is known', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  const updated = await setModel(db, slug, 'pi/qwen2:1.5b', fakeRegistry([piEntry]));
  assert.equal(updated.model_slug, 'pi/qwen2:1.5b');
});

test('setParameters rejects unknown keys', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  await assert.rejects(() => setParameters(db, slug, { frequency_penalty: 0.5 }));
});

test('setParameters rejects out-of-range values', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  await assert.rejects(() => setParameters(db, slug, { temperature: 3 }));
});

test('setParameters persists a valid object', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  const updated = await setParameters(db, slug, { temperature: 0.7, max_tokens: 256 });
  assert.deepEqual(updated.model_parameters, { temperature: 0.7, max_tokens: 256 });
});

test('setContextWindow rejects non-positive integers', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  await assert.rejects(() => setContextWindow(db, slug, 0), /positive integer/);
  await assert.rejects(() => setContextWindow(db, slug, -100), /positive integer/);
  await assert.rejects(() => setContextWindow(db, slug, 1.5), /positive integer/);
});

test('setContextWindow persists a positive integer', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  const updated = await setContextWindow(db, slug, 32000);
  assert.equal(updated.model_context_window, 32000);
});

test('resolveModel happy path', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  const registry = fakeRegistry([piEntry]);
  await setModel(db, slug, 'pi/qwen2:1.5b', registry);
  await setParameters(db, slug, { temperature: 0.5 });

  const row = await getWebsiteBySlug(db, slug);
  assert.ok(row);
  const resolved = resolveModel(row, registry);
  assert.equal(resolved.modelSlug, 'pi/qwen2:1.5b');
  assert.equal(resolved.provider.name, 'pi');
  assert.equal(resolved.model, 'qwen2:1.5b');
  assert.deepEqual(resolved.parameters, { temperature: 0.5 });
});

test('resolveModel throws when website has no model_slug', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  const row = await getWebsiteBySlug(db, slug);
  assert.ok(row);
  assert.throws(() => resolveModel(row, fakeRegistry([piEntry])), /no model_slug set/);
});

test('resolveModel throws when registry is missing the provider', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  await setModel(db, slug, 'pi/qwen2:1.5b', fakeRegistry([piEntry]));
  const row = await getWebsiteBySlug(db, slug);
  assert.ok(row);
  assert.throws(() => resolveModel(row, fakeRegistry([])), /not defined/);
});

test('validateContextBudget: under budget passes', () => {
  validateContextBudget({
    websiteSlug: 'x',
    modelSlug: 'pi/qwen2',
    contextWindow: 32000,
    promptTokens: 1000,
  });
});

test('validateContextBudget: insufficient headroom throws documented error shape', () => {
  assert.throws(
    () =>
      validateContextBudget({
        websiteSlug: 'foobar.org',
        modelSlug: 'pi/qwen2:1.5b',
        contextWindow: 32000,
        promptTokens: 31900,
      }),
    /system blocks for website "foobar.org" total ~31900 tokens.*model_context_window for "pi\/qwen2:1\.5b" is 32000.*~100 for conversation history \+ response/s,
  );
});

test('defaultHeadroom: 12.5% of context window with 512 floor', () => {
  assert.equal(defaultHeadroom(1024), 512);
  assert.equal(defaultHeadroom(32000), 4000);
  assert.equal(defaultHeadroom(8000), 1000);
});

test('validateRegistryAgainstWebsites: passes when every model_slug resolves', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const registry = fakeRegistry([piEntry]);
  await createWebsite(db, { slug, name: 'Test' });
  await setModel(db, slug, 'pi/qwen2:1.5b', registry);
  await validateRegistryAgainstWebsites(db, registry, [slug]);
});

test('validateRegistryAgainstWebsites: fails when a website references a missing provider', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const registry = fakeRegistry([piEntry]);
  await createWebsite(db, { slug, name: 'Test' });
  await setModel(db, slug, 'pi/qwen2:1.5b', registry);

  await assert.rejects(
    () => validateRegistryAgainstWebsites(db, fakeRegistry([]), [slug]),
    /references provider "pi".*not defined/s,
  );
});
