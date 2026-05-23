import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { buildServer } from './server.js';
import { addOrigin } from './services/chatbots.js';
import { makeTestDb, seedAccountAndChatbot } from './testing/db.js';
import type { AvailabilityConfig } from './services/chatbots.js';

/**
 * M21: operational-hours enforcement at session-mint. The availability
 * gate fires only on POST /sessions + GET /sessions/can-start (mirroring
 * the 0.16.1 daily-cap precedent). An already-minted session keeps going
 * past closing hours.
 */

function uniqueSlug(prefix = 'avail'): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

async function seedChatbotWithAvailability(opts: {
  timezone: string | null;
  availability: AvailabilityConfig | null;
}) {
  const db = makeTestDb();
  const slug = uniqueSlug();
  const origin = `https://${slug}.test`;
  const { account } = await seedAccountAndChatbot(db, slug);
  await addOrigin(db, slug, origin);
  await db('chatbots')
    .where({ slug })
    .update({
      timezone: opts.timezone,
      availability: opts.availability === null ? null : JSON.stringify(opts.availability),
    });
  return {
    db,
    account,
    slug,
    origin,
    cleanup: async () => {
      await db('accounts').where({ id: account.id }).del();
      await db.destroy();
    },
  };
}

test('M21 availability: POST /sessions returns 503 chatbot_closed when outside hours', async (t) => {
  // A schedule that's clearly closed "now" — Sunday window only.
  // Today's actual day may vary, so we use a schedule that's empty for
  // every day. Empty schedule → always closed.
  const fx = await seedChatbotWithAvailability({
    timezone: 'UTC',
    availability: { schedule: {} },
  });
  const fastify = await buildServer({ db: fx.db, logger: false });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin: fx.origin },
  });
  assert.equal(res.statusCode, 503, `body: ${res.payload}`);
  assert.equal(res.json().error, 'chatbot_closed');
  assert.equal(res.json().detail.next_open_at, null);
});

test('M21 availability: GET /sessions/can-start mirrors the same 503', async (t) => {
  const fx = await seedChatbotWithAvailability({
    timezone: 'UTC',
    availability: { schedule: {} },
  });
  const fastify = await buildServer({ db: fx.db, logger: false });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const res = await fastify.inject({
    method: 'GET',
    url: '/sessions/can-start',
    headers: { origin: fx.origin },
  });
  assert.equal(res.statusCode, 503);
  assert.equal(res.json().error, 'chatbot_closed');
});

test('M21 availability: NULL schedule means always open (no regression)', async (t) => {
  const fx = await seedChatbotWithAvailability({
    timezone: 'UTC',
    availability: null,
  });
  const fastify = await buildServer({ db: fx.db, logger: false });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin: fx.origin },
  });
  assert.equal(res.statusCode, 201);
});

test('M21 availability: Retry-After header carries next-open delay capped at 3600s', async (t) => {
  // Schedule with a single weekly window — closed most of the time, with a
  // known next-open instant. We don't assert the exact header value (depends
  // on current time vs the next opening) but we assert the cap behaviour.
  const fx = await seedChatbotWithAvailability({
    timezone: 'UTC',
    availability: { schedule: { mon: ['09:00-10:00'] } },
  });
  const fastify = await buildServer({ db: fx.db, logger: false });
  t.after(async () => {
    await fastify.close();
    await fx.cleanup();
  });

  const res = await fastify.inject({
    method: 'POST',
    url: '/sessions',
    headers: { origin: fx.origin },
  });
  // 503 only if the test runs outside Mon 09:00-10:00 UTC. If we happen to
  // be inside that window (rare in CI), the test minted successfully —
  // assert that or skip.
  if (res.statusCode === 201) {
    return; // we happen to be inside the window
  }
  assert.equal(res.statusCode, 503);
  const retry = res.headers['retry-after'];
  assert.ok(retry, 'expected retry-after header to be set');
  const n = Number(retry);
  assert.ok(Number.isFinite(n) && n >= 1 && n <= 3600, `retry-after must be 1..3600, got ${retry}`);
});
