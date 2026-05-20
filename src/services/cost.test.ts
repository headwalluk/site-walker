import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ANTHROPIC_CACHE_READ_MULTIPLIER,
  ANTHROPIC_CACHE_WRITE_MULTIPLIER,
  computeCostUsd,
  parseSinceDuration,
} from './cost.js';

test('computeCostUsd: basic two-bucket case (no cache fields)', () => {
  // 1000 input × $1/M = $0.001
  // 500 output × $5/M = $0.0025
  // Total: $0.0035
  const cost = computeCostUsd({
    tokensIn: 1000,
    tokensOut: 500,
    inputPerMillionUsd: 1.0,
    outputPerMillionUsd: 5.0,
  });
  assert.equal(cost, 0.0035);
});

test('computeCostUsd: NULL input pricing → 0 (unmetered)', () => {
  const cost = computeCostUsd({
    tokensIn: 1000,
    tokensOut: 500,
    inputPerMillionUsd: null,
    outputPerMillionUsd: null,
  });
  assert.equal(cost, 0);
});

test('computeCostUsd: one-side NULL pricing also yields 0', () => {
  // Defensive — if an operator left half the pricing set, we don't want
  // half-billed numbers leaking out. Both must be present.
  const cost = computeCostUsd({
    tokensIn: 1000,
    tokensOut: 500,
    inputPerMillionUsd: 1.0,
    outputPerMillionUsd: null,
  });
  assert.equal(cost, 0);
});

test('computeCostUsd: NULL token counts treated as 0', () => {
  const cost = computeCostUsd({
    tokensIn: null,
    tokensOut: null,
    inputPerMillionUsd: 1.0,
    outputPerMillionUsd: 5.0,
  });
  assert.equal(cost, 0);
});

test('computeCostUsd: cache-creation tokens charged at 1.25× input price', () => {
  // 1000 cache-creation × $1/M × 1.25 = $0.00125
  const cost = computeCostUsd({
    tokensIn: 0,
    tokensOut: 0,
    cacheCreationTokens: 1000,
    inputPerMillionUsd: 1.0,
    outputPerMillionUsd: 5.0,
  });
  assert.equal(cost, (1000 * ANTHROPIC_CACHE_WRITE_MULTIPLIER * 1.0) / 1_000_000);
  assert.equal(cost, 0.00125);
});

test('computeCostUsd: cache-read tokens charged at 0.10× input price', () => {
  // 1000 cache-read × $1/M × 0.10 = $0.0001
  const cost = computeCostUsd({
    tokensIn: 0,
    tokensOut: 0,
    cacheReadTokens: 1000,
    inputPerMillionUsd: 1.0,
    outputPerMillionUsd: 5.0,
  });
  assert.equal(cost, (1000 * ANTHROPIC_CACHE_READ_MULTIPLIER * 1.0) / 1_000_000);
  assert.equal(cost, 0.0001);
});

test('computeCostUsd: full four-bucket calculation', () => {
  // Realistic-ish shape: cache write happens once at the head of a
  // conversation; subsequent turns are cache reads.
  // 500 uncached input × $1/M = $0.0005
  // 2000 cache write × $1/M × 1.25 = $0.0025
  // 1500 cache read × $1/M × 0.10 = $0.00015
  // 300 output × $5/M = $0.0015
  // Total: $0.00465
  const cost = computeCostUsd({
    tokensIn: 500,
    tokensOut: 300,
    cacheCreationTokens: 2000,
    cacheReadTokens: 1500,
    inputPerMillionUsd: 1.0,
    outputPerMillionUsd: 5.0,
  });
  assert.equal(cost, 0.00465);
});

test('computeCostUsd: rounds to 6 decimal places to align with DECIMAL(10,6)', () => {
  // Construct a value that would otherwise produce more than 6dp of noise.
  // 1 token × $0.000003/M = 3e-15 USD — should round to 0.
  const cost = computeCostUsd({
    tokensIn: 1,
    tokensOut: 0,
    inputPerMillionUsd: 0.000003,
    outputPerMillionUsd: 0,
  });
  assert.equal(cost, 0);
});

test('computeCostUsd: cache fields default to 0 when omitted', () => {
  const cost = computeCostUsd({
    tokensIn: 1000,
    tokensOut: 500,
    inputPerMillionUsd: 1.0,
    outputPerMillionUsd: 5.0,
  });
  // Same as the basic-two-bucket result above.
  assert.equal(cost, 0.0035);
});

test('computeCostUsd: zero tokens with valid pricing → 0', () => {
  const cost = computeCostUsd({
    tokensIn: 0,
    tokensOut: 0,
    inputPerMillionUsd: 1.0,
    outputPerMillionUsd: 5.0,
  });
  assert.equal(cost, 0);
});

test('multipliers match Anthropic published pricing', () => {
  // Belt-and-braces guard against accidental tweaks.
  assert.equal(ANTHROPIC_CACHE_WRITE_MULTIPLIER, 1.25);
  assert.equal(ANTHROPIC_CACHE_READ_MULTIPLIER, 0.1);
});

test('parseSinceDuration: 24h → 24 hours before `now`', () => {
  const now = new Date('2026-05-20T12:00:00Z');
  const since = parseSinceDuration('24h', now);
  assert.equal(since.toISOString(), '2026-05-19T12:00:00.000Z');
});

test('parseSinceDuration: 7d → 7 days before `now`', () => {
  const now = new Date('2026-05-20T12:00:00Z');
  const since = parseSinceDuration('7d', now);
  assert.equal(since.toISOString(), '2026-05-13T12:00:00.000Z');
});

test('parseSinceDuration: 30m → 30 minutes before `now`', () => {
  const now = new Date('2026-05-20T12:00:00Z');
  const since = parseSinceDuration('30m', now);
  assert.equal(since.toISOString(), '2026-05-20T11:30:00.000Z');
});

test('parseSinceDuration: 90s → 90 seconds before `now`', () => {
  const now = new Date('2026-05-20T12:00:00Z');
  const since = parseSinceDuration('90s', now);
  assert.equal(since.toISOString(), '2026-05-20T11:58:30.000Z');
});

test('parseSinceDuration: malformed input throws with a clear message', () => {
  assert.throws(() => parseSinceDuration('forever'), /relative duration/);
  assert.throws(() => parseSinceDuration('24'), /relative duration/);
  assert.throws(() => parseSinceDuration('1y'), /relative duration/);
  assert.throws(() => parseSinceDuration('1.5h'), /relative duration/);
  assert.throws(() => parseSinceDuration('h'), /relative duration/);
  assert.throws(() => parseSinceDuration(''), /relative duration/);
});

test('parseSinceDuration: zero or negative durations rejected', () => {
  assert.throws(() => parseSinceDuration('0h'), /positive/);
});
