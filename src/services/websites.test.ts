import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import type { Knex } from 'knex';
import {
  addOrigin,
  createWebsite,
  deleteWebsite,
  findWebsiteByOrigin,
  getWebsiteBySlug,
  listOrigins,
  normaliseOrigin,
  removeOrigin,
  setPersona,
  setWelcomeMessage,
} from './websites.js';
import { appendMessage, createSession } from './sessions.js';

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
  assert.equal(created.persona, null);
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

test('createWebsite persists supplied persona', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const created = await createWebsite(db, {
    slug,
    name: 'Persona Site',
    persona: 'be friendly and concise',
  });
  assert.equal(created.persona, 'be friendly and concise');

  const fetched = await getWebsiteBySlug(db, slug);
  assert.equal(fetched?.persona, 'be friendly and concise');
});

test('setPersona updates the persona column', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Persona Site', persona: 'first' });
  const updated = await setPersona(db, slug, 'second');
  assert.equal(updated.persona, 'second');

  const fetched = await getWebsiteBySlug(db, slug);
  assert.equal(fetched?.persona, 'second');
});

test('setPersona throws when website slug does not exist', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });

  await assert.rejects(
    () => setPersona(db, 'no-such-website-xyz', 'whatever'),
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

test('setWelcomeMessage sets and clears the column', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Welcome Site' });

  const set = await setWelcomeMessage(db, slug, 'Welcome, friend.');
  assert.equal(set.welcome_message, 'Welcome, friend.');

  const cleared = await setWelcomeMessage(db, slug, '');
  assert.equal(cleared.welcome_message, null);
});

test('setWelcomeMessage throws when website slug does not exist', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });

  await assert.rejects(
    () => setWelcomeMessage(db, 'no-such-website-xyz', 'hi'),
    /Website not found/,
  );
});

test('listOrigins returns rows in insertion order', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Origins Site' });
  await addOrigin(db, slug, `https://a.${slug}.example`);
  await addOrigin(db, slug, `https://b.${slug}.example`);

  const rows = await listOrigins(db, slug);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].origin, `https://a.${slug}.example`);
  assert.equal(rows[1].origin, `https://b.${slug}.example`);
});

test('removeOrigin matches by numeric id', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Origins Site' });
  const added = await addOrigin(db, slug, `https://${slug}.example.com`);
  await addOrigin(db, slug, `https://other-${slug}.example.com`);

  const removed = await removeOrigin(db, slug, String(added.id));
  assert.equal(removed.id, added.id);
  const remaining = await listOrigins(db, slug);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].origin, `https://other-${slug}.example.com`);
});

test('removeOrigin matches by origin string (normalised)', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Origins Site' });
  await addOrigin(db, slug, `https://${slug}.example.com`);

  // Match via a slightly different casing — normaliseOrigin should align them.
  const removed = await removeOrigin(db, slug, `https://${slug.toUpperCase()}.example.com/`);
  assert.equal(removed.origin, `https://${slug}.example.com`);
  const remaining = await listOrigins(db, slug);
  assert.equal(remaining.length, 0);
});

test('removeOrigin throws when the ref does not match any origin', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  await createWebsite(db, { slug, name: 'Origins Site' });
  await assert.rejects(
    () => removeOrigin(db, slug, 'https://nope.example.com'),
    /Origin not found/,
  );
});

test('deleteWebsite cascades to origins, sessions, and messages', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    // belt-and-braces in case the test fails before deleteWebsite runs
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const website = await createWebsite(db, { slug, name: 'Delete Site' });
  await addOrigin(db, slug, `https://${slug}.example.com`);
  const session = await createSession(db, website.id);
  await appendMessage(db, session.id, 'user', 'hi');
  await appendMessage(db, session.id, 'assistant', 'hello');

  const counts = await deleteWebsite(db, slug);
  assert.equal(counts.origins, 1);
  assert.equal(counts.sessions, 1);
  assert.equal(counts.messages, 2);

  assert.equal(await getWebsiteBySlug(db, slug), null);
  const origins = await db('website_origins').where({ website_id: website.id });
  assert.equal(origins.length, 0);
  const sessions = await db('sessions').where({ website_id: website.id });
  assert.equal(sessions.length, 0);
});

test('deleteWebsite throws when website slug does not exist', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });

  await assert.rejects(() => deleteWebsite(db, 'no-such-website-xyz'), /Website not found/);
});
