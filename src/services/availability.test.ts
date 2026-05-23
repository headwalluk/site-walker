import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assertValidSchedule,
  assertValidTimezone,
  effectiveTimezone,
  isOpenNow,
  parseWindow,
} from './availability.js';
import type { AvailabilityConfig, Chatbot } from './chatbots.js';

/**
 * M21: availability service. Pure-function tests against fixed `Date`
 * instants — no DB, no clock dependency.
 */

// ---------------------------------------------------------------------------
// Timezone validation
// ---------------------------------------------------------------------------

test('availability: assertValidTimezone accepts well-formed IANA identifiers', () => {
  assert.doesNotThrow(() => assertValidTimezone('UTC'));
  assert.doesNotThrow(() => assertValidTimezone('Europe/London'));
  assert.doesNotThrow(() => assertValidTimezone('America/New_York'));
  assert.doesNotThrow(() => assertValidTimezone('Asia/Tokyo'));
});

test('availability: assertValidTimezone rejects garbage', () => {
  assert.throws(() => assertValidTimezone('Mars/Olympus_Mons'), /Invalid IANA timezone/);
  assert.throws(() => assertValidTimezone('not-a-tz'), /Invalid IANA timezone/);
  assert.throws(() => assertValidTimezone(''), /Invalid IANA timezone/);
});

test('availability: effectiveTimezone defaults to UTC when timezone is NULL', () => {
  assert.equal(effectiveTimezone({ timezone: null }), 'UTC');
  assert.equal(effectiveTimezone({ timezone: 'Europe/London' }), 'Europe/London');
});

// ---------------------------------------------------------------------------
// Window parsing
// ---------------------------------------------------------------------------

test('availability: parseWindow accepts standard "HH:MM-HH:MM"', () => {
  assert.deepEqual(parseWindow('09:00-17:00'), { openMinutes: 540, closeMinutes: 1020 });
});

test('availability: parseWindow tolerates whitespace around the dash', () => {
  assert.deepEqual(parseWindow('09:00 - 17:00'), { openMinutes: 540, closeMinutes: 1020 });
  assert.deepEqual(parseWindow(' 09:00-17:00 '), { openMinutes: 540, closeMinutes: 1020 });
});

test('availability: parseWindow accepts "24:00" as close-of-day', () => {
  assert.deepEqual(parseWindow('22:00-24:00'), { openMinutes: 1320, closeMinutes: 1440 });
});

test('availability: parseWindow rejects malformed input', () => {
  assert.throws(() => parseWindow('09:00'), /Malformed/);
  assert.throws(() => parseWindow('9-17'), /Malformed/);
  assert.throws(() => parseWindow('garbage'), /Malformed/);
});

test('availability: parseWindow rejects close <= open', () => {
  assert.throws(() => parseWindow('17:00-09:00'), /strictly after open/);
  assert.throws(() => parseWindow('09:00-09:00'), /strictly after open/);
});

test('availability: parseWindow rejects out-of-range times', () => {
  assert.throws(() => parseWindow('25:00-26:00'), /Out-of-range/);
  assert.throws(() => parseWindow('09:60-17:00'), /Out-of-range/);
  // 24:01 is NOT allowed — only 24:00 as the close marker.
  assert.throws(() => parseWindow('00:00-24:01'), /Out-of-range/);
});

// ---------------------------------------------------------------------------
// Schedule validation
// ---------------------------------------------------------------------------

test('availability: assertValidSchedule accepts a minimal weekday schedule', () => {
  assert.doesNotThrow(() =>
    assertValidSchedule({
      schedule: {
        mon: ['09:00-17:00'],
        tue: ['09:00-17:00'],
      },
    }),
  );
});

test('availability: assertValidSchedule accepts multi-window days', () => {
  assert.doesNotThrow(() =>
    assertValidSchedule({
      schedule: {
        mon: ['09:00-12:00', '13:00-17:00'],
      },
    }),
  );
});

test('availability: assertValidSchedule rejects unknown day keys', () => {
  assert.throws(
    () =>
      assertValidSchedule({
        schedule: { funday: ['09:00-17:00'] } as unknown as AvailabilityConfig['schedule'],
      }),
    /Unknown day key/,
  );
});

test('availability: assertValidSchedule rejects non-array day values', () => {
  assert.throws(
    () =>
      assertValidSchedule({
        schedule: { mon: '09:00-17:00' as unknown as string[] },
      }),
    /must be an array/,
  );
});

test('availability: assertValidSchedule requires a "schedule" object', () => {
  assert.throws(
    () => assertValidSchedule({ wrong: {} } as unknown as AvailabilityConfig),
    /must be \{ "schedule"/,
  );
});

// ---------------------------------------------------------------------------
// isOpenNow — behaviour
// ---------------------------------------------------------------------------

function chatbot(
  timezone: string | null,
  availability: AvailabilityConfig | null,
): Pick<Chatbot, 'timezone' | 'availability'> {
  return { timezone, availability };
}

test('availability: NULL schedule means always open', () => {
  const result = isOpenNow(chatbot('Europe/London', null), new Date('2026-05-23T03:00:00Z'));
  assert.equal(result.open, true);
  assert.equal(result.nextOpenAt, null);
});

test('availability: weekday 9-5 open at midday', () => {
  // 2026-05-22 is a Friday. 12:00 UTC = 13:00 BST (Europe/London is BST in May).
  const config: AvailabilityConfig = {
    schedule: {
      mon: ['09:00-17:00'],
      tue: ['09:00-17:00'],
      wed: ['09:00-17:00'],
      thu: ['09:00-17:00'],
      fri: ['09:00-17:00'],
    },
  };
  const result = isOpenNow(chatbot('Europe/London', config), new Date('2026-05-22T12:00:00Z'));
  assert.equal(result.open, true);
});

test('availability: weekday 9-5 closed at 3am', () => {
  const config: AvailabilityConfig = {
    schedule: { fri: ['09:00-17:00'] },
  };
  // 2026-05-22 03:00 UTC = 04:00 BST Friday morning, before opening.
  const result = isOpenNow(chatbot('Europe/London', config), new Date('2026-05-22T03:00:00Z'));
  assert.equal(result.open, false);
  assert.ok(result.nextOpenAt instanceof Date);
  // Next opening is Friday 09:00 BST = 08:00 UTC.
  assert.equal(result.nextOpenAt?.toISOString(), '2026-05-22T08:00:00.000Z');
});

test('availability: weekend closed; next opening is Monday 09:00', () => {
  const config: AvailabilityConfig = {
    schedule: {
      mon: ['09:00-17:00'],
      tue: ['09:00-17:00'],
    },
  };
  // 2026-05-23 is a Saturday. 12:00 UTC.
  const result = isOpenNow(chatbot('Europe/London', config), new Date('2026-05-23T12:00:00Z'));
  assert.equal(result.open, false);
  assert.equal(result.nextOpenAt?.toISOString(), '2026-05-25T08:00:00.000Z');
});

test('availability: multi-window day — closed during the lunch gap', () => {
  const config: AvailabilityConfig = {
    schedule: { fri: ['09:00-12:00', '13:00-17:00'] },
  };
  // 2026-05-22 12:30 BST = 11:30 UTC — inside the lunch gap.
  const lunch = isOpenNow(chatbot('Europe/London', config), new Date('2026-05-22T11:30:00Z'));
  assert.equal(lunch.open, false);
  // Next opening is 13:00 BST = 12:00 UTC.
  assert.equal(lunch.nextOpenAt?.toISOString(), '2026-05-22T12:00:00.000Z');
});

test('availability: multi-window day — open in the afternoon window', () => {
  const config: AvailabilityConfig = {
    schedule: { fri: ['09:00-12:00', '13:00-17:00'] },
  };
  // 2026-05-22 14:00 BST = 13:00 UTC — inside the afternoon window.
  const afternoon = isOpenNow(chatbot('Europe/London', config), new Date('2026-05-22T13:00:00Z'));
  assert.equal(afternoon.open, true);
});

test('availability: 24:00 boundary closes the window correctly', () => {
  const config: AvailabilityConfig = {
    schedule: {
      mon: ['00:00-09:00', '17:00-24:00'],
      tue: ['00:00-09:00'],
    },
  };
  // Mon 23:59 BST = 22:59 UTC → open (inside 17:00-24:00).
  const late = isOpenNow(chatbot('Europe/London', config), new Date('2026-05-25T22:59:00Z'));
  assert.equal(late.open, true);
  // Tue 00:30 BST = Mon 23:30 UTC → still inside 17:00-24:00 (Monday window).
  const earlyTue = isOpenNow(chatbot('Europe/London', config), new Date('2026-05-25T23:30:00Z'));
  assert.equal(earlyTue.open, true);
});

test('availability: entirely-closed schedule yields nextOpenAt=null', () => {
  const config: AvailabilityConfig = { schedule: {} };
  const result = isOpenNow(chatbot('UTC', config), new Date('2026-05-23T12:00:00Z'));
  assert.equal(result.open, false);
  assert.equal(result.nextOpenAt, null);
});

test('availability: UTC chatbot honours UTC wall-clock literally', () => {
  const config: AvailabilityConfig = { schedule: { sat: ['09:00-17:00'] } };
  // 2026-05-23 is a Saturday. 12:00 UTC is inside 09:00-17:00 UTC.
  const result = isOpenNow(chatbot(null, config), new Date('2026-05-23T12:00:00Z'));
  assert.equal(result.open, true);
});
