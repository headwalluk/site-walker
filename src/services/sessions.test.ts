import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  appendMessage,
  createSession,
  findSessionByToken,
  findSessionByTokenOrId,
  getSessionForChatbot,
  listMessages,
  listMessagesForChatbot,
  listSessions,
  listSessionsForChatbot,
} from './sessions.js';
import { makeTestDb, seedAccountAndChatbot } from '../testing/db.js';

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

test('M20 idle expiry: findSessionByToken returns null when last_active_at is >24h old', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const session = await createSession(db, chatbot.id);
  // Fresh session resolves.
  assert.ok(await findSessionByToken(db, session.token));

  // Push last_active_at past the 24h cutoff via direct UPDATE.
  const stale = new Date(Date.now() - 25 * 3600_000);
  await db('sessions').where({ id: session.id }).update({ last_active_at: stale });

  assert.equal(await findSessionByToken(db, session.token), null);
});

test('M20 idle expiry: a session active <24h ago still resolves', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const session = await createSession(db, chatbot.id);
  const recent = new Date(Date.now() - 23 * 3600_000);
  await db('sessions').where({ id: session.id }).update({ last_active_at: recent });

  const found = await findSessionByToken(db, session.token);
  assert.ok(found);
  assert.equal(found.id, session.id);
});

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

// ---------------------------------------------------------------------------
// M22: listSessionsForChatbot / getSessionForChatbot / listMessagesForChatbot
// ---------------------------------------------------------------------------

test('M22 listSessionsForChatbot: returns paginated sessions with aggregated totals + total count', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  // Three sessions; only the middle one gets messages with token counts.
  const sA = await createSession(db, chatbot.id);
  const sB = await createSession(db, chatbot.id);
  const sC = await createSession(db, chatbot.id);
  // MariaDB DATETIME is 1-second resolution by default; wait so the
  // appendMessage bump on sB is observable in the ORDER BY.
  await new Promise((r) => setTimeout(r, 1100));
  await appendMessage(db, sB.id, 'user', 'hi', { chatbotId: chatbot.id });
  await appendMessage(db, sB.id, 'assistant', 'hello back', {
    chatbotId: chatbot.id,
    tokensIn: 100,
    tokensOut: 50,
    costUsd: 0.001234,
  });

  const result = await listSessionsForChatbot(db, chatbot.id);
  assert.equal(result.total, 3);
  assert.equal(result.page, 1);
  assert.equal(result.page_size, 20);
  assert.equal(result.sessions.length, 3);
  // Ordered last_active_at DESC. sB was the last-touched (its appendMessage
  // calls bump last_active_at), so it appears first.
  assert.equal(result.sessions[0].id, sB.id);
  assert.equal(result.sessions[0].message_count, 2);
  assert.equal(result.sessions[0].tokens_in, 100);
  assert.equal(result.sessions[0].tokens_out, 50);
  assert.ok(
    Math.abs(result.sessions[0].cost_usd_estimate - 0.001234) < 1e-9,
    `cost should round-trip: got ${result.sessions[0].cost_usd_estimate}`,
  );

  // Empty sessions surface as 0 / 0 / 0, not null.
  const emptyA = result.sessions.find((s) => s.id === sA.id);
  const emptyC = result.sessions.find((s) => s.id === sC.id);
  assert.ok(emptyA);
  assert.ok(emptyC);
  assert.equal(emptyA.message_count, 0);
  assert.equal(emptyA.tokens_in, 0);
  assert.equal(emptyA.cost_usd_estimate, 0);
  assert.equal(emptyC.message_count, 0);

  // Token field is deliberately absent.
  for (const s of result.sessions) {
    assert.equal((s as unknown as { token?: string }).token, undefined);
  }
});

test('M22 listSessionsForChatbot: page_size + page navigates correctly; page_size capped at 100', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  // 5 sessions; page_size = 2.
  for (let i = 0; i < 5; i++) {
    await createSession(db, chatbot.id);
    // 1-second waits would make the test slow; rely on insertion order for
    // tie-breaks at the same last_active_at and just verify totals + counts.
  }

  const page1 = await listSessionsForChatbot(db, chatbot.id, { page: 1, pageSize: 2 });
  assert.equal(page1.total, 5);
  assert.equal(page1.page, 1);
  assert.equal(page1.page_size, 2);
  assert.equal(page1.sessions.length, 2);

  const page3 = await listSessionsForChatbot(db, chatbot.id, { page: 3, pageSize: 2 });
  assert.equal(page3.total, 5);
  assert.equal(page3.sessions.length, 1);

  const page4 = await listSessionsForChatbot(db, chatbot.id, { page: 4, pageSize: 2 });
  assert.equal(page4.sessions.length, 0);

  // Oversize page_size is clamped silently.
  const huge = await listSessionsForChatbot(db, chatbot.id, { page: 1, pageSize: 10_000 });
  assert.equal(huge.page_size, 100);
});

test('M22 listSessionsForChatbot: never returns rows from a different chatbot', async (t) => {
  const db = makeTestDb();
  const slugA = uniqueSlug();
  const slugB = uniqueSlug();
  const { account: accountA, chatbot: a } = await seedAccountAndChatbot(db, slugA);
  const { account: accountB, chatbot: b } = await seedAccountAndChatbot(db, slugB);
  t.after(async () => {
    await db('accounts').whereIn('id', [accountA.id, accountB.id]).del();
    await db.destroy();
  });

  await createSession(db, a.id);
  await createSession(db, a.id);
  await createSession(db, b.id);

  const aSessions = await listSessionsForChatbot(db, a.id);
  assert.equal(aSessions.total, 2);
  assert.ok(aSessions.sessions.every((s) => s.chatbot_id === a.id));

  const bSessions = await listSessionsForChatbot(db, b.id);
  assert.equal(bSessions.total, 1);
  assert.ok(bSessions.sessions.every((s) => s.chatbot_id === b.id));
});

test('M22 getSessionForChatbot: returns the session with aggregates; null on cross-chatbot lookup', async (t) => {
  const db = makeTestDb();
  const slugA = uniqueSlug();
  const slugB = uniqueSlug();
  const { account: accountA, chatbot: a } = await seedAccountAndChatbot(db, slugA);
  const { account: accountB, chatbot: b } = await seedAccountAndChatbot(db, slugB);
  t.after(async () => {
    await db('accounts').whereIn('id', [accountA.id, accountB.id]).del();
    await db.destroy();
  });

  const session = await createSession(db, a.id);
  await appendMessage(db, session.id, 'user', 'hello', { chatbotId: a.id });

  const got = await getSessionForChatbot(db, a.id, session.id);
  assert.ok(got);
  assert.equal(got.id, session.id);
  assert.equal(got.message_count, 1);
  assert.equal(got.visitor_email, null);
  assert.equal(got.terminated_at, null);
  // Token field deliberately absent.
  assert.equal((got as unknown as { token?: string }).token, undefined);

  // Wrong chatbot → null.
  const wrong = await getSessionForChatbot(db, b.id, session.id);
  assert.equal(wrong, null);

  // Missing id → null.
  const missing = await getSessionForChatbot(db, a.id, 999_999_999);
  assert.equal(missing, null);
});

test('M22 listMessagesForChatbot: returns the messages; null on cross-chatbot lookup', async (t) => {
  const db = makeTestDb();
  const slugA = uniqueSlug();
  const slugB = uniqueSlug();
  const { account: accountA, chatbot: a } = await seedAccountAndChatbot(db, slugA);
  const { account: accountB, chatbot: b } = await seedAccountAndChatbot(db, slugB);
  t.after(async () => {
    await db('accounts').whereIn('id', [accountA.id, accountB.id]).del();
    await db.destroy();
  });

  const session = await createSession(db, a.id);
  await appendMessage(db, session.id, 'user', 'one', { chatbotId: a.id });
  await appendMessage(db, session.id, 'assistant', 'two', { chatbotId: a.id });

  const messages = await listMessagesForChatbot(db, a.id, session.id);
  assert.ok(messages);
  assert.equal(messages.length, 2);
  assert.equal(messages[0].content, 'one');
  assert.equal(messages[1].content, 'two');

  // Wrong chatbot → null (not an empty array; that would be ambiguous with
  // "session exists but has no messages yet").
  const wrong = await listMessagesForChatbot(db, b.id, session.id);
  assert.equal(wrong, null);

  // Missing session → null.
  const missing = await listMessagesForChatbot(db, a.id, 999_999_999);
  assert.equal(missing, null);
});
