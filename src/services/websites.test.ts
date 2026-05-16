import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import type { Knex } from 'knex';
import {
  addOrigin,
  createWebsite,
  findWebsiteByOrigin,
  getWebsiteBySlug,
  normaliseOrigin,
} from './websites.js';

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

test('createWebsite + getWebsiteBySlug roundtrip', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const created = await createWebsite(db, { slug, name: 'Test Site' });
  assert.equal(created.slug, slug);
  assert.equal(created.name, 'Test Site');
  assert.equal(created.welcome_message, null);
  assert.equal(created.model_slug, null);

  const fetched = await getWebsiteBySlug(db, slug);
  assert.ok(fetched, 'expected fetched website');
  assert.equal(fetched.id, created.id);
});

test('createWebsite rejects invalid slugs', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });

  await assert.rejects(
    () => createWebsite(db, { slug: 'NotLowerCase', name: 'x' }),
    /Invalid slug/,
  );
  await assert.rejects(
    () => createWebsite(db, { slug: '-leading-hyphen', name: 'x' }),
    /Invalid slug/,
  );
  await assert.rejects(
    () => createWebsite(db, { slug: 'trailing-hyphen-', name: 'x' }),
    /Invalid slug/,
  );
});

test('addOrigin + findWebsiteByOrigin', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  const origin = `https://${slug}.example.com`;
  const added = await addOrigin(db, slug, origin);
  assert.equal(added.origin, origin);

  const found = await findWebsiteByOrigin(db, origin);
  assert.ok(found, 'expected to find website by origin');
  assert.equal(found.slug, slug);
});

test('addOrigin normalises host case and trailing slash', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Test' });
  const raw = `https://${slug.toUpperCase()}.EXAMPLE.com/`;
  const added = await addOrigin(db, slug, raw);
  assert.equal(added.origin, `https://${slug.toLowerCase()}.example.com`);
});

test('addOrigin rejects when website slug does not exist', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });

  await assert.rejects(
    () => addOrigin(db, 'no-such-website-xyz', 'https://example.com'),
    /Website not found/,
  );
});

test('normaliseOrigin: pure-function cases', () => {
  assert.equal(normaliseOrigin('https://example.com'), 'https://example.com');
  assert.equal(normaliseOrigin('https://EXAMPLE.com'), 'https://example.com');
  assert.equal(normaliseOrigin('https://example.com/'), 'https://example.com');
  assert.equal(normaliseOrigin('http://localhost:8080'), 'http://localhost:8080');
  assert.throws(() => normaliseOrigin('not-a-url'), /not a parseable URL/);
  assert.throws(() => normaliseOrigin('ftp://example.com'), /scheme must be http or https/);
  assert.throws(() => normaliseOrigin('https://example.com/foo'), /must not include a path/);
  assert.throws(() => normaliseOrigin('https://example.com?q=1'), /must not include a query/);
});
