import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  appendMessage,
  createSession,
  findSessionByToken,
  findSessionByTokenOrId,
  listMessages,
  listSessions,
} from './sessions.js';
import { makeTestDb, seedAccountAndChatbot } from '../testing/db.js';

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

test('createSession + findSessionByToken roundtrip; token is 64 hex chars', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const session = await createSession(db, chatbot.id);
  assert.match(session.token, /^[0-9a-f]{64}$/);
  assert.equal(session.chatbot_id, chatbot.id);

  const fetched = await findSessionByToken(db, session.token);
  assert.ok(fetched);
  assert.equal(fetched.id, session.id);
});

test('createSession twice for same chatbot produces distinct tokens', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const a = await createSession(db, chatbot.id);
  const b = await createSession(db, chatbot.id);
  assert.notEqual(a.token, b.token);
});

test('listMessages: empty session returns []', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const session = await createSession(db, chatbot.id);
  const messages = await listMessages(db, session.id);
  assert.deepEqual(messages, []);
});

test('appendMessage + listMessages preserves insertion order and bumps last_active_at', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const session = await createSession(db, chatbot.id);
  const originalLastActive = session.last_active_at;

  // MariaDB DATETIME has 1-second resolution by default; wait so the bump is visible.
  await new Promise((r) => setTimeout(r, 1100));

  await appendMessage(db, session.id, 'user', 'hello', { chatbotId: chatbot.id });
  await appendMessage(db, session.id, 'assistant', 'hi there', { chatbotId: chatbot.id });
  await appendMessage(db, session.id, 'user', 'how are you?', { chatbotId: chatbot.id });

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
  const { account, chatbot } = await seedAccountAndChatbot(db, slug, { name: 'Lookup Site' });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const session = await createSession(db, chatbot.id);

  const byId = await findSessionByTokenOrId(db, String(session.id));
  assert.ok(byId);
  assert.equal(byId.id, session.id);

  const byToken = await findSessionByTokenOrId(db, session.token);
  assert.ok(byToken);
  assert.equal(byToken.token, session.token);

  assert.equal(await findSessionByTokenOrId(db, '999999999'), null);
  assert.equal(await findSessionByTokenOrId(db, 'not-a-real-token'), null);
});

test('listSessions: filters by chatbot + applies limit + orders by last_active_at desc', async (t) => {
  const db = makeTestDb();
  const slugA = uniqueSlug();
  const slugB = uniqueSlug();
  const { account: accountA, chatbot: a } = await seedAccountAndChatbot(db, slugA, { name: 'A' });
  const { account: accountB, chatbot: b } = await seedAccountAndChatbot(db, slugB, { name: 'B' });
  t.after(async () => {
    await db('accounts').whereIn('id', [accountA.id, accountB.id]).del();
    await db.destroy();
  });

  const aSession = await createSession(db, a.id);
  // Make A's session newer than B's by appending a message after B's session.
  const bSession = await createSession(db, b.id);
  await appendMessage(db, aSession.id, 'user', 'A is newer now', { chatbotId: a.id });

  const both = await listSessions(db, { limit: 50 });
  assert.ok(both.length >= 2);
  // Just over our two: A is more recent than B since we touched it last.
  const aRow = both.find((r) => r.id === aSession.id);
  const bRow = both.find((r) => r.id === bSession.id);
  assert.ok(aRow);
  assert.ok(bRow);
  assert.equal(aRow.chatbot_slug, slugA);
  assert.equal(bRow.chatbot_slug, slugB);
  assert.equal(aRow.message_count, 1);
  assert.equal(bRow.message_count, 0);

  const onlyA = await listSessions(db, { chatbotSlug: slugA, limit: 50 });
  assert.ok(onlyA.every((r) => r.chatbot_slug === slugA));
  assert.ok(onlyA.some((r) => r.id === aSession.id));
  assert.ok(!onlyA.some((r) => r.id === bSession.id));

  const justOne = await listSessions(db, { chatbotSlug: slugA, limit: 1 });
  assert.equal(justOne.length, 1);
});
