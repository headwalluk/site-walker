import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  addOrigin,
  createChatbot,
  deleteChatbot,
  findChatbotByOrigin,
  getChatbotBySlug,
  listOrigins,
  normaliseOrigin,
  removeOrigin,
  setPersona,
  setWelcomeMessage,
} from './chatbots.js';
import { createAccount } from './accounts.js';
import { appendMessage, createSession } from './sessions.js';
import { makeTestDb, seedAccountAndChatbot } from '../testing/db.js';

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

test('createChatbot + getChatbotBySlug roundtrip', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug, { name: 'Test Site' });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const fetched = await getChatbotBySlug(db, slug);
  assert.ok(fetched, 'expected fetched chatbot');
  assert.equal(fetched.slug, slug);
  assert.equal(fetched.name, 'Test Site');
  assert.equal(fetched.welcome_message, null);
  assert.equal(fetched.persona, null);
  assert.equal(fetched.model_slug, null);
  assert.equal(fetched.account_id, account.id);
});

test('createChatbot rejects invalid slugs', async (t) => {
  const db = makeTestDb();
  const account = await createAccount(db, { slug: `bad-${randomUUID().slice(0, 8)}`, name: 'x' });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await assert.rejects(
    () => createChatbot(db, { account_id: account.id, slug: 'NotLowerCase', name: 'x' }),
    /Invalid slug/,
  );
  await assert.rejects(
    () => createChatbot(db, { account_id: account.id, slug: '-leading-hyphen', name: 'x' }),
    /Invalid slug/,
  );
  await assert.rejects(
    () => createChatbot(db, { account_id: account.id, slug: 'trailing-hyphen-', name: 'x' }),
    /Invalid slug/,
  );
});

test('addOrigin + findChatbotByOrigin', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const origin = `https://${slug}.example.com`;
  const added = await addOrigin(db, slug, origin);
  assert.equal(added.origin, origin);

  const found = await findChatbotByOrigin(db, origin);
  assert.ok(found, 'expected to find chatbot by origin');
  assert.equal(found.slug, slug);
});

test('addOrigin normalises host case and trailing slash', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const raw = `https://${slug.toUpperCase()}.EXAMPLE.com/`;
  const added = await addOrigin(db, slug, raw);
  assert.equal(added.origin, `https://${slug.toLowerCase()}.example.com`);
});

test('addOrigin rejects when chatbot slug does not exist', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });

  await assert.rejects(
    () => addOrigin(db, 'no-such-chatbot-xyz', 'https://example.com'),
    /Chatbot not found/,
  );
});

test('createChatbot persists supplied persona', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug, {
    name: 'Persona Site',
    persona: 'be friendly and concise',
  });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const fetched = await getChatbotBySlug(db, slug);
  assert.equal(fetched?.persona, 'be friendly and concise');
});

test('setPersona updates the persona column', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug, { persona: 'first' });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const updated = await setPersona(db, slug, 'second');
  assert.equal(updated.persona, 'second');

  const fetched = await getChatbotBySlug(db, slug);
  assert.equal(fetched?.persona, 'second');
});

test('setPersona throws when chatbot slug does not exist', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });

  await assert.rejects(
    () => setPersona(db, 'no-such-chatbot-xyz', 'whatever'),
    /Chatbot not found/,
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
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const set = await setWelcomeMessage(db, slug, 'Welcome, friend.');
  assert.equal(set.welcome_message, 'Welcome, friend.');

  const cleared = await setWelcomeMessage(db, slug, '');
  assert.equal(cleared.welcome_message, null);
});

test('setWelcomeMessage throws when chatbot slug does not exist', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });

  await assert.rejects(
    () => setWelcomeMessage(db, 'no-such-chatbot-xyz', 'hi'),
    /Chatbot not found/,
  );
});

test('listOrigins returns rows in insertion order', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

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
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

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
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

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
  const { account } = await seedAccountAndChatbot(db, slug);
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await assert.rejects(
    () => removeOrigin(db, slug, 'https://nope.example.com'),
    /Origin not found/,
  );
});

test('deleteChatbot cascades to origins, sessions, and messages', async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account, chatbot } = await seedAccountAndChatbot(db, slug, { name: 'Delete Site' });
  t.after(async () => {
    // belt-and-braces in case the test fails before deleteChatbot runs
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  await addOrigin(db, slug, `https://${slug}.example.com`);
  const session = await createSession(db, chatbot.id);
  await appendMessage(db, session.id, 'user', 'hi');
  await appendMessage(db, session.id, 'assistant', 'hello');

  const counts = await deleteChatbot(db, slug);
  assert.equal(counts.origins, 1);
  assert.equal(counts.sessions, 1);
  assert.equal(counts.messages, 2);

  assert.equal(await getChatbotBySlug(db, slug), null);
  const origins = await db('chatbot_origins').where({ chatbot_id: chatbot.id });
  assert.equal(origins.length, 0);
  const sessions = await db('sessions').where({ chatbot_id: chatbot.id });
  assert.equal(sessions.length, 0);
});

test('deleteChatbot throws when chatbot slug does not exist', async (t) => {
  const db = makeTestDb();
  t.after(async () => {
    await db.destroy();
  });

  await assert.rejects(() => deleteChatbot(db, 'no-such-chatbot-xyz'), /Chatbot not found/);
});
