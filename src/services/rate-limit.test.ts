import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ChatbotRateLimiter } from './rate-limit.js';

/**
 * Pure in-memory unit tests — no DB, no Fastify. Each test uses an
 * injected clock so window behaviour is deterministic and fast.
 */

function makeClock(start = 1_700_000_000_000) {
  let t = start;
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms;
    },
  };
}

test('ChatbotRateLimiter: allows up to cap, refuses after', () => {
  const clock = makeClock();
  const rl = new ChatbotRateLimiter({ sessions: 3, chat: 10 }, clock.now);

  for (let i = 0; i < 3; i++) {
    const d = rl.check(1, 'sessions');
    assert.equal(d.allowed, true, `request ${i + 1} should be allowed`);
    assert.equal(d.retryAfterSeconds, 0);
  }
  const refused = rl.check(1, 'sessions');
  assert.equal(refused.allowed, false);
  assert.ok(refused.retryAfterSeconds >= 1, 'retryAfterSeconds should be ≥ 1');
  assert.ok(refused.retryAfterSeconds <= 60, 'retryAfterSeconds should fit the 60s window');
});

test('ChatbotRateLimiter: window rolls over after 60s', () => {
  const clock = makeClock();
  const rl = new ChatbotRateLimiter({ sessions: 2, chat: 10 }, clock.now);

  assert.equal(rl.check(1, 'sessions').allowed, true);
  assert.equal(rl.check(1, 'sessions').allowed, true);
  assert.equal(rl.check(1, 'sessions').allowed, false);

  // Just before the window closes — still refused.
  clock.advance(59_999);
  assert.equal(rl.check(1, 'sessions').allowed, false);

  // Window rolls over exactly at 60s.
  clock.advance(1);
  const fresh = rl.check(1, 'sessions');
  assert.equal(fresh.allowed, true, 'first request in new window should be allowed');
});

test('ChatbotRateLimiter: refused calls do NOT extend the ban window', () => {
  const clock = makeClock();
  const rl = new ChatbotRateLimiter({ sessions: 1, chat: 10 }, clock.now);

  // Hit the cap.
  assert.equal(rl.check(1, 'sessions').allowed, true);
  assert.equal(rl.check(1, 'sessions').allowed, false);

  // Spam refused calls across most of the window — should not reset windowStart.
  for (let i = 0; i < 10; i++) {
    clock.advance(5_000);
    assert.equal(rl.check(1, 'sessions').allowed, false);
  }

  // Original windowStart was t=0; we've advanced 50s. Move past 60s total.
  clock.advance(11_000);
  assert.equal(rl.check(1, 'sessions').allowed, true, 'window should reset 60s after first call');
});

test('ChatbotRateLimiter: different chatbots have independent buckets', () => {
  const clock = makeClock();
  const rl = new ChatbotRateLimiter({ sessions: 1, chat: 1 }, clock.now);

  assert.equal(rl.check(1, 'sessions').allowed, true);
  assert.equal(rl.check(1, 'sessions').allowed, false);

  // Chatbot 2 has its own bucket — first call still allowed.
  assert.equal(rl.check(2, 'sessions').allowed, true);
  assert.equal(rl.check(2, 'sessions').allowed, false);
});

test('ChatbotRateLimiter: sessions and chat scopes are independent for the same chatbot', () => {
  const clock = makeClock();
  const rl = new ChatbotRateLimiter({ sessions: 1, chat: 1 }, clock.now);

  assert.equal(rl.check(1, 'sessions').allowed, true);
  assert.equal(rl.check(1, 'sessions').allowed, false);

  // 'chat' scope still has its full quota for chatbot 1.
  assert.equal(rl.check(1, 'chat').allowed, true);
  assert.equal(rl.check(1, 'chat').allowed, false);
});

test('ChatbotRateLimiter: retryAfterSeconds shrinks as we approach the window edge', () => {
  const clock = makeClock();
  const rl = new ChatbotRateLimiter({ sessions: 1, chat: 10 }, clock.now);

  assert.equal(rl.check(1, 'sessions').allowed, true);
  const at0 = rl.check(1, 'sessions');
  assert.equal(at0.retryAfterSeconds, 60);

  clock.advance(30_000);
  const at30 = rl.check(1, 'sessions');
  assert.equal(at30.retryAfterSeconds, 30);

  clock.advance(29_999);
  const at60 = rl.check(1, 'sessions');
  assert.equal(at60.retryAfterSeconds, 1, 'never below 1s while inside the window');
});

test('ChatbotRateLimiter: reset() clears all buckets', () => {
  const clock = makeClock();
  const rl = new ChatbotRateLimiter({ sessions: 1, chat: 1 }, clock.now);

  assert.equal(rl.check(1, 'sessions').allowed, true);
  assert.equal(rl.check(1, 'sessions').allowed, false);

  rl.reset();
  assert.equal(rl.check(1, 'sessions').allowed, true, 'reset() should restore quota');
});
