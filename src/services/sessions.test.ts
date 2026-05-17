import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import type { Knex } from 'knex';
import { createWebsite } from './websites.js';
import {
  appendMessage,
  createSession,
  findSessionByToken,
  findSessionByTokenOrId,
  listMessages,
  listSessions,
} from './sessions.js';

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

test('createSession + findSessionByToken roundtrip; token is 64 hex chars', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const website = await createWebsite(db, { slug, name: 'Test' });
  const session = await createSession(db, website.id);
  assert.match(session.token, /^[0-9a-f]{64}$/);
  assert.equal(session.website_id, website.id);

  const fetched = await findSessionByToken(db, session.token);
  assert.ok(fetched);
  assert.equal(fetched.id, session.id);
});

test('createSession twice for same website produces distinct tokens', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const website = await createWebsite(db, { slug, name: 'Test' });
  const a = await createSession(db, website.id);
  const b = await createSession(db, website.id);
  assert.notEqual(a.token, b.token);
});

test('listMessages: empty session returns []', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const website = await createWebsite(db, { slug, name: 'Test' });
  const session = await createSession(db, website.id);
  const messages = await listMessages(db, session.id);
  assert.deepEqual(messages, []);
});

test('appendMessage + listMessages preserves insertion order and bumps last_active_at', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const website = await createWebsite(db, { slug, name: 'Test' });
  const session = await createSession(db, website.id);
  const originalLastActive = session.last_active_at;

  // MariaDB DATETIME has 1-second resolution by default; wait so the bump is visible.
  await new Promise((r) => setTimeout(r, 1100));

  await appendMessage(db, session.id, 'user', 'hello');
  await appendMessage(db, session.id, 'assistant', 'hi there');
  await appendMessage(db, session.id, 'user', 'how are you?');

  const messages = await listMessages(db, session.id);
  assert.equal(messages.length, 3);
  assert.deepEqual(
    messages.map((m) => ({ role: m.role, content: m.content })),
    [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'how are you?' },
    ],
  );

  const refreshed = await findSessionByToken(db, session.token);
  assert.ok(refreshed);
  assert.ok(
    refreshed.last_active_at.getTime() > originalLastActive.getTime(),
    `last_active_at should have been bumped (was ${originalLastActive.toISOString()}, now ${refreshed.last_active_at.toISOString()})`,
  );
});

test('findSessionByTokenOrId: numeric ref → id lookup, otherwise → token', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  t.after(async () => {
    await db('websites').where({ slug }).del();
    await db.destroy();
  });

  const website = await createWebsite(db, { slug, name: 'Lookup Site' });
  const session = await createSession(db, website.id);

  const byId = await findSessionByTokenOrId(db, String(session.id));
  assert.ok(byId);
  assert.equal(byId.id, session.id);

  const byToken = await findSessionByTokenOrId(db, session.token);
  assert.ok(byToken);
  assert.equal(byToken.token, session.token);

  assert.equal(await findSessionByTokenOrId(db, '999999999'), null);
  assert.equal(await findSessionByTokenOrId(db, 'not-a-real-token'), null);
});

test('listSessions: filters by website + applies limit + orders by last_active_at desc', async (t) => {
  const db = makeTestDb();
  const slugA = uniqueSlug();
  const slugB = uniqueSlug();
  t.after(async () => {
    await db('websites').whereIn('slug', [slugA, slugB]).del();
    await db.destroy();
  });

  const a = await createWebsite(db, { slug: slugA, name: 'A' });
  const b = await createWebsite(db, { slug: slugB, name: 'B' });
  const aSession = await createSession(db, a.id);
  // Make A's session newer than B's by appending a message after B's session.
  const bSession = await createSession(db, b.id);
  await appendMessage(db, aSession.id, 'user', 'A is newer now');

  const both = await listSessions(db, { limit: 50 });
  assert.ok(both.length >= 2);
  // Just over our two: A is more recent than B since we touched it last.
  const aRow = both.find((r) => r.id === aSession.id);
  const bRow = both.find((r) => r.id === bSession.id);
  assert.ok(aRow);
  assert.ok(bRow);
  assert.equal(aRow.website_slug, slugA);
  assert.equal(bRow.website_slug, slugB);
  assert.equal(aRow.message_count, 1);
  assert.equal(bRow.message_count, 0);

  const onlyA = await listSessions(db, { websiteSlug: slugA, limit: 50 });
  assert.ok(onlyA.every((r) => r.website_slug === slugA));
  assert.ok(onlyA.some((r) => r.id === aSession.id));
  assert.ok(!onlyA.some((r) => r.id === bSession.id));

  const justOne = await listSessions(db, { websiteSlug: slugA, limit: 1 });
  assert.equal(justOne.length, 1);
});
