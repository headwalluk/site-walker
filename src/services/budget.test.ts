import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  getChatbotDailySpend,
  getSessionSpend,
  isDailyBudgetExhausted,
  isSessionBudgetExhausted,
  parseCapDecimal,
  utcMidnightToday,
} from './budget.js';
import { appendMessage, createSession } from './sessions.js';
import { makeTestDb, seedAccountAndChatbot } from '../testing/db.js';
import { randomUUID } from 'node:crypto';

function uniqueSlug(): string {
  return `test-${randomUUID().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

test('utcMidnightToday: returns the day boundary in UTC', () => {
  const at = new Date('2026-05-21T15:34:56.789Z');
  const mid = utcMidnightToday(at);
  assert.equal(mid.toISOString(), '2026-05-21T00:00:00.000Z');
});

test('utcMidnightToday: rolls across the date line correctly', () => {
  const at = new Date('2026-05-21T23:59:59.000Z');
  const mid = utcMidnightToday(at);
  assert.equal(mid.toISOString(), '2026-05-21T00:00:00.000Z');
});

test('isDailyBudgetExhausted: NULL cap → never exhausted', () => {
  assert.equal(isDailyBudgetExhausted(100, null), false);
  assert.equal(isDailyBudgetExhausted(0, null), false);
});

test('isDailyBudgetExhausted: spend < cap → false', () => {
  assert.equal(isDailyBudgetExhausted(0.5, 1), false);
});

test('isDailyBudgetExhausted: spend === cap → true (the boundary is closed)', () => {
  assert.equal(isDailyBudgetExhausted(1, 1), true);
});

test('isDailyBudgetExhausted: spend > cap → true', () => {
  assert.equal(isDailyBudgetExhausted(2, 1), true);
});

test('isSessionBudgetExhausted: matches isDailyBudgetExhausted semantics', () => {
  assert.equal(isSessionBudgetExhausted(0.4, 0.5), false);
  assert.equal(isSessionBudgetExhausted(0.5, 0.5), true);
  assert.equal(isSessionBudgetExhausted(1.0, null), false);
});

test('parseCapDecimal: round-trips DECIMAL-as-string values', () => {
  assert.equal(parseCapDecimal('1.5000'), 1.5);
  assert.equal(parseCapDecimal('0.0001'), 0.0001);
  assert.equal(parseCapDecimal(null), null);
  assert.equal(parseCapDecimal(undefined), null);
});

// ---------------------------------------------------------------------------
// DB aggregation
// ---------------------------------------------------------------------------

test("getChatbotDailySpend: sums today's assistant cost_usd_estimate values", async (t) => {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const { account, chatbot } = await seedAccountAndChatbot(db, slug);
  const session = await createSession(db, chatbot.id);
  await appendMessage(db, session.id, 'assistant', 'a', {
    chatbotId: chatbot.id,
    costUsd: 0.001,
  });
  await appendMessage(db, session.id, 'assistant', 'b', {
    chatbotId: chatbot.id,
    costUsd: 0.002,
  });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const spend = await getChatbotDailySpend(db, chatbot.id);
  // Allow tiny rounding tolerance from DECIMAL → string → number round trip.
  assert.ok(Math.abs(spend - 0.003) < 1e-9, `expected ~0.003, got ${spend}`);
});

test('getChatbotDailySpend: returns 0 when nothing recorded', async (t) => {
  const db = makeTestDb();
  const { account, chatbot } = await seedAccountAndChatbot(db, uniqueSlug());
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });
  const spend = await getChatbotDailySpend(db, chatbot.id);
  assert.equal(spend, 0);
});

test('getSessionSpend: sums cost_usd_estimate scoped to one session', async (t) => {
  const db = makeTestDb();
  const { account, chatbot } = await seedAccountAndChatbot(db, uniqueSlug());
  const sessionA = await createSession(db, chatbot.id);
  const sessionB = await createSession(db, chatbot.id);
  await appendMessage(db, sessionA.id, 'assistant', 'a1', {
    chatbotId: chatbot.id,
    costUsd: 0.001,
  });
  await appendMessage(db, sessionA.id, 'assistant', 'a2', {
    chatbotId: chatbot.id,
    costUsd: 0.002,
  });
  await appendMessage(db, sessionB.id, 'assistant', 'b1', {
    chatbotId: chatbot.id,
    costUsd: 0.005,
  });
  t.after(async () => {
    await db('accounts').where({ id: account.id }).del();
    await db.destroy();
  });

  const spendA = await getSessionSpend(db, sessionA.id);
  const spendB = await getSessionSpend(db, sessionB.id);
  assert.ok(Math.abs(spendA - 0.003) < 1e-9);
  assert.ok(Math.abs(spendB - 0.005) < 1e-9);
});
