import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import knex from 'knex';
import type { Knex } from 'knex';
import { createWebsite } from './websites.js';
import { appendMessage, createSession, findSessionByToken, listMessages } from './sessions.js';

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
